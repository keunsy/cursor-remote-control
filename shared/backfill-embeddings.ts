#!/usr/bin/env bun
/**
 * 补充缺失的向量嵌入（统一版本）
 * 为所有 embedding 为空的 chunks 生成向量
 * 
 * 支持从飞书/钉钉/企业微信任意目录调用
 * 
 * 用法：
 *   bun shared/backfill-embeddings.ts
 *   bun run feishu/backfill-embeddings.ts    # 通过包装脚本
 */

import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";

// 智能检测调用平台（通过环境变量或路径推断）
function detectPlatform(): string {
	// 1. 优先使用环境变量（包装脚本调用时会设置）
	if (process.env.CURSOR_PLATFORM) {
		return process.env.CURSOR_PLATFORM;
	}
	
	// 2. 从调用者的工作目录推断
	const cwd = process.cwd();
	if (cwd.includes('/feishu')) return 'feishu';
	if (cwd.includes('/dingtalk')) return 'dingtalk';
	if (cwd.includes('/wecom')) return 'wecom';
	
	// 3. 默认 feishu（向后兼容）
	return 'feishu';
}

const ROOT = resolve(import.meta.dirname, "..");
const platform = detectPlatform();
const ENV_PATH = resolve(ROOT, `${platform}/.env`);
const DB_PATH = resolve(ROOT, ".memory.sqlite");

function loadEnv(): Record<string, string> {
	if (!existsSync(ENV_PATH)) {
		console.error(`配置文件不存在: ${ENV_PATH}`);
		return {};
	}
	const env: Record<string, string> = {};
	for (const line of readFileSync(ENV_PATH, "utf-8").split("\n")) {
		const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
		if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
	}
	return env;
}

function textHash(text: string): string {
	return Bun.hash(text).toString(16);
}

const env = loadEnv();
const apiKey = env.VOLC_EMBEDDING_API_KEY;
const model = env.VOLC_EMBEDDING_MODEL || "doubao-embedding-vision-250615";
const endpoint = "https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal";

if (!apiKey) {
	console.error(`错误: VOLC_EMBEDDING_API_KEY 未设置（平台: ${platform}，配置文件: ${ENV_PATH}）`);
	process.exit(1);
}

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 30000");

interface ChunkRow {
	id: string;
	text: string;
}

async function embedOne(text: string): Promise<number[]> {
	const maxRetries = 2;
	let lastErr: Error | undefined;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		if (attempt > 0) {
			await new Promise((r) => setTimeout(r, 1000 * attempt));
		}
		try {
			const res = await fetch(endpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({
					model,
					input: [{ type: "text", text: text.slice(0, 1024) }],
				}),
			});

			if (!res.ok) {
				const body = await res.text().catch(() => "");
				throw new Error(`API ${res.status}: ${body.slice(0, 200)}`);
			}

			const json = (await res.json()) as {
				data: { embedding: number[] } | { embedding: number[] }[];
			};
			const data = json.data;
			return Array.isArray(data) ? data[0].embedding : data.embedding;
		} catch (err) {
			lastErr = err instanceof Error ? err : new Error(String(err));
			if (attempt < maxRetries) {
				console.warn(`  重试 (${attempt + 1}): ${lastErr.message}`);
			}
		}
	}
	throw lastErr!;
}

async function main() {
	const missingChunks = db
		.prepare("SELECT id, text FROM chunks WHERE embedding IS NULL")
		.all() as ChunkRow[];

	console.log(`待补充向量: ${missingChunks.length} 个记忆块`);

	if (missingChunks.length === 0) {
		console.log("所有记忆块都已有向量嵌入。");
		return;
	}

	const cacheStmt = db.prepare(
		"SELECT embedding FROM embedding_cache WHERE hash = ? AND model = ?"
	);
	const insertCache = db.prepare(
		"INSERT OR REPLACE INTO embedding_cache (hash, model, embedding) VALUES (?, ?, ?)"
	);
	const updateChunk = db.prepare("UPDATE chunks SET embedding = ? WHERE id = ?");

	let cacheHits = 0;
	let apiCalls = 0;
	let errors = 0;
	let dbErrors = 0;
	const progressInterval = 50;

	const commitBatch = (updates: Array<{ embedding: number[]; id: string }>) => {
		if (updates.length === 0) return;
		try {
			db.transaction(() => {
				for (const { embedding, id } of updates) {
					const buf = Buffer.from(new Float32Array(embedding).buffer);
					updateChunk.run(buf, id);
				}
			})();
		} catch (err) {
			dbErrors++;
			console.warn(`  数据库写入失败: ${err instanceof Error ? err.message : err}`);
		}
	};

	let pendingUpdates: Array<{ embedding: number[]; id: string }> = [];
	const batchCommitSize = 20;

	for (let i = 0; i < missingChunks.length; i++) {
		const chunk = missingChunks[i];
		const hash = textHash(chunk.text);

		const cached = cacheStmt.get(hash, model) as { embedding: Buffer } | null;
		let embedding: number[] | null = null;

		if (cached) {
			embedding = Array.from(
				new Float32Array(
					cached.embedding.buffer,
					cached.embedding.byteOffset,
					cached.embedding.byteLength / 4
				)
			);
			cacheHits++;
		} else {
			try {
				embedding = await embedOne(chunk.text);
				const buf = Buffer.from(new Float32Array(embedding).buffer);
				try {
					insertCache.run(hash, model, buf);
				} catch (cacheErr) {
					// 缓存写入失败不影响主流程
				}
				apiCalls++;
			} catch (err) {
				errors++;
				console.error(`  失败 [${chunk.id}]: ${err instanceof Error ? err.message : err}`);
				continue;
			}
		}

		if (embedding) {
			pendingUpdates.push({ embedding, id: chunk.id });
			if (pendingUpdates.length >= batchCommitSize) {
				commitBatch(pendingUpdates);
				pendingUpdates = [];
			}
		}

		if ((i + 1) % progressInterval === 0 || i === missingChunks.length - 1) {
			const progress = ((i + 1) / missingChunks.length * 100).toFixed(1);
			console.log(
				`进度: ${i + 1}/${missingChunks.length} (${progress}%) | 缓存命中: ${cacheHits} | API调用: ${apiCalls} | 错误: ${errors}${dbErrors > 0 ? ` | DB错误: ${dbErrors}` : ""}`
			);
		}
	}

	// 提交剩余的更新
	commitBatch(pendingUpdates);

	console.log(`\n完成! 缓存命中: ${cacheHits}, API调用: ${apiCalls}, 错误: ${errors}${dbErrors > 0 ? `, DB错误: ${dbErrors}` : ""}`);
}

main()
	.catch((e) => {
		console.error(`错误: ${e instanceof Error ? e.message : e}`);
		process.exit(1);
	})
	.finally(() => {
		db.close();
	});
