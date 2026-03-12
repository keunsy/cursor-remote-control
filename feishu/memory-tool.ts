#!/usr/bin/env bun
/**
 * 记忆工具 CLI — 供 Cursor Agent 通过 shell 调用
 *
 * 用法：
 *   bun memory-tool.ts search <query> [--top-k 5]    # 语义搜索记忆
 *   bun memory-tool.ts recent [--days 3]              # 最近记忆摘要
 *   bun memory-tool.ts write <content>                # 写入今日日记
 *   bun memory-tool.ts stats                          # 索引统计
 *   bun memory-tool.ts index                          # 重建索引
 */

import { resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { MemoryManager } from "./memory.js";

const RELAY_DIR = import.meta.dirname;
const ENV_PATH = resolve(RELAY_DIR, ".env");
const ROOT = resolve(RELAY_DIR, "..");
const PROJECTS_PATH = resolve(ROOT, "projects.json");

function loadEnv(): Record<string, string> {
	if (!existsSync(ENV_PATH)) return {};
	const env: Record<string, string> = {};
	for (const line of readFileSync(ENV_PATH, "utf-8").split("\n")) {
		const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
		if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
	}
	return env;
}

function getWorkspacePath(): string {
	if (!existsSync(PROJECTS_PATH)) return ROOT;
	try {
		const cfg = JSON.parse(readFileSync(PROJECTS_PATH, "utf-8"));
		return cfg.projects?.[cfg.default_project]?.path || ROOT;
	} catch {
		return ROOT;
	}
}

const env = loadEnv();
const workspaceDir = getWorkspacePath();
const apiKey = env.VOLC_EMBEDDING_API_KEY || "";
const model = env.VOLC_EMBEDDING_MODEL || "doubao-embedding-vision-250615";

const mm = new MemoryManager({
	workspaceDir,
	embeddingApiKey: apiKey,
	embeddingModel: model,
	embeddingEndpoint: "https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal",
});

const [cmd, ...rest] = process.argv.slice(2);

async function main() {
	switch (cmd) {
		case "search": {
			const topKIdx = rest.indexOf("--top-k");
			const topK = topKIdx >= 0 ? parseInt(rest[topKIdx + 1], 10) || 5 : 5;
			const query = rest.filter((_, i) => i !== topKIdx && i !== topKIdx + 1).join(" ");
			if (!query) {
				console.error("用法: bun memory-tool.ts search <关键词>");
				process.exit(1);
			}
			if (!apiKey) {
				console.error("错误: VOLC_EMBEDDING_API_KEY 未设置（在 relay-bot/.env 中配置）");
				process.exit(1);
			}
			const results = await mm.search(query, topK, 0.2);
			if (results.length === 0) {
				console.log(`未找到与「${query}」相关的记忆。`);
			} else {
				for (const r of results) {
					console.log(`--- [${r.path}#L${r.startLine}-L${r.endLine}] (相关度: ${(r.score * 100).toFixed(0)}%) ---`);
					console.log(r.text);
					console.log();
				}
			}
			break;
		}

		case "recent": {
			const daysIdx = rest.indexOf("--days");
			const days = daysIdx >= 0 ? parseInt(rest[daysIdx + 1], 10) || 3 : 3;
			const summary = mm.getRecentSummary(days);
			console.log(summary || "（暂无最近记忆）");
			break;
		}

		case "write": {
			const content = rest.join(" ");
			if (!content) {
				console.error("用法: bun memory-tool.ts write <要记录的内容>");
				process.exit(1);
			}
			const path = mm.appendDailyLog(content);
			console.log(`已写入: ${path}`);
			break;
		}

		case "stats": {
			const stats = mm.getStats();
			console.log(`记忆索引统计:`);
			console.log(`  记忆块: ${stats.chunks}`);
			console.log(`  已索引文件: ${stats.files}`);
			console.log(`  嵌入缓存: ${stats.cachedEmbeddings}`);
			console.log(`  工作区: ${workspaceDir}`);
			if (stats.filePaths.length > 0) {
				console.log(`\n已索引文件列表:`);
				for (const p of stats.filePaths) {
					console.log(`  ${p}`);
				}
			}
			break;
		}

		case "index": {
			if (!apiKey) {
				console.error("错误: VOLC_EMBEDDING_API_KEY 未设置");
				process.exit(1);
			}
			console.log("正在索引工作区全部文本文件...");
			const count = await mm.index();
			const stats = mm.getStats();
			console.log(`索引完成: ${count} 个记忆块（来自 ${stats.files} 个文件）`);
			break;
		}

		default:
			console.log(`记忆工具 — 供 Cursor Agent 调用

用法:
  bun memory-tool.ts search <关键词>     语义搜索记忆（向量+关键词混合）
  bun memory-tool.ts recent [--days N]   查看最近 N 天的记忆摘要
  bun memory-tool.ts write <内容>        写入今日日记
  bun memory-tool.ts stats               查看索引统计
  bun memory-tool.ts index               重建全工作区索引`);
	}

	mm.close();
}

main().catch((e) => {
	console.error(`错误: ${e instanceof Error ? e.message : e}`);
	process.exit(1);
});
