/**
 * 记忆管理器 v2 — 嵌入缓存 + 增量索引 + FTS5 + 向量混合搜索
 *
 * 改进自 v1：
 * - embedding_cache 表：相同文本不重复调 API
 * - files 表：追踪文件 hash，仅对变化文件重新索引
 * - FTS5 虚拟表：BM25 关键词排序（替代 string.includes）
 * - minScore 提升到 0.3（减少噪音注入）
 */

import { Database } from "bun:sqlite";
import {
	readFileSync,
	writeFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	appendFileSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { resolve, relative, extname } from "node:path";

// ── 类型 ──────────────────────────────────────────

export interface MemoryConfig {
	workspaceDir: string;
	embeddingApiKey: string;
	embeddingModel: string;
	embeddingEndpoint: string;
	temporalDecayHalfLife?: number; // 时间衰减半衰期（天），默认30
	mmrLambda?: number; // MMR 平衡参数，默认0.5（0=纯多样性，1=纯相关性）
}

interface ChunkRow {
	id: string;
	path: string;
	text: string;
	start_line: number;
	end_line: number;
	embedding: Buffer | null;
}

interface FtsRow {
	chunk_id: string;
	rank: number;
}

export interface SearchResult {
	path: string;
	text: string;
	score: number;
	startLine: number;
	endLine: number;
}

// ── 工具函数 ──────────────────────────────────────

function todayStr(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function timeStr(): string {
	const d = new Date();
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function cosineSim(a: number[], b: number[]): number {
	let dot = 0;
	let magA = 0;
	let magB = 0;
	for (let i = 0; i < a.length; i++) {
		const av = a[i]!;
		const bv = b[i]!;
		dot += av * bv;
		magA += av * av;
		magB += bv * bv;
	}
	return dot / (Math.sqrt(magA) * Math.sqrt(magB) + 1e-8);
}

// 时间衰减：旧记忆权重降低（OpenClaw 风格）
function applyTemporalDecay(score: number, filePath: string, halfLife = 30): number {
	// 从路径提取日期（memory/YYYY-MM-DD.md）
	const dateMatch = filePath.match(/(\d{4}-\d{2}-\d{2})/);
	if (!dateMatch?.[1]) return score; // 非日期文件不衰减

	const fileDate = new Date(dateMatch[1]);
	const daysSince = (Date.now() - fileDate.getTime()) / (24 * 3600 * 1000);
	
	if (daysSince < 0) return score; // 未来日期不衰减
	
	// 指数衰减公式：score * e^(-ln(2) * days / halfLife)
	return score * Math.exp(-Math.LN2 * daysSince / halfLife);
}

// Jaccard 文本相似度（用于 MMR）
function textSimilarity(a: string, b: string): number {
	const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 1));
	const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 1));
	
	if (wordsA.size === 0 || wordsB.size === 0) return 0;
	
	const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
	const union = new Set([...wordsA, ...wordsB]);
	
	return intersection.size / union.size;
}

// MMR 重排序：平衡相关性和多样性（OpenClaw 风格）
function mmrRerank(candidates: SearchResult[], topK: number, lambda = 0.5): SearchResult[] {
	if (candidates.length <= topK) return candidates;
	
	const selected: SearchResult[] = [];
	const remaining = [...candidates];
	
	while (selected.length < topK && remaining.length > 0) {
		let bestIdx = 0;
		let bestScore = -Infinity;
		
		for (let i = 0; i < remaining.length; i++) {
			const candidate = remaining[i]!;
			
			// 相关性得分（已计算好的混合得分）
			const relevance = candidate.score;
			
			// 多样性惩罚：与已选结果的最大相似度
			let maxSim = 0;
			for (const sel of selected) {
				const sim = textSimilarity(candidate.text, sel.text);
				if (sim > maxSim) maxSim = sim;
			}
			
			// MMR 得分 = lambda * 相关性 - (1-lambda) * 最大相似度
			const mmrScore = lambda * relevance - (1 - lambda) * maxSim;
			
			if (mmrScore > bestScore) {
				bestScore = mmrScore;
				bestIdx = i;
			}
		}
		
		const picked = remaining[bestIdx];
		if (!picked) break;
		selected.push(picked);
		remaining.splice(bestIdx, 1);
	}
	
	return selected;
}

function textHash(text: string): string {
	return Bun.hash(text).toString(16);
}

// FTS5 查询需要转义特殊字符
function ftsEscape(query: string): string {
	return query
		.replace(/[*"(){}[\]:^~!@#$%&|\\/<>+=;]/g, " ")
		.split(/\s+/)
		.filter((t) => t.length > 0)
		.map((t) => `"${t}"`)
		.join(" OR ");
}

// ── MemoryManager ─────────────────────────────────

export class MemoryManager {
	private db: Database;
	private config: MemoryConfig;
	private memoryDir: string;
	private sessionsDir: string;
	private indexedAt = 0;
	private indexing = false;
	private hasFts5 = false;

	constructor(config: MemoryConfig) {
		// 验证配置参数
		if (config.temporalDecayHalfLife !== undefined) {
			if (config.temporalDecayHalfLife <= 0 || (!isFinite(config.temporalDecayHalfLife) && config.temporalDecayHalfLife !== Infinity)) {
				throw new Error(`Invalid temporalDecayHalfLife: ${config.temporalDecayHalfLife}. Must be > 0 or Infinity.`);
			}
		}
		if (config.mmrLambda !== undefined) {
			if (config.mmrLambda < 0 || config.mmrLambda > 1) {
				throw new Error(`Invalid mmrLambda: ${config.mmrLambda}. Must be between 0 and 1.`);
			}
		}
		
		this.config = config;
		this.memoryDir = resolve(config.workspaceDir, ".cursor/memory");
		this.sessionsDir = resolve(config.workspaceDir, ".cursor/sessions");
		mkdirSync(this.memoryDir, { recursive: true });
		mkdirSync(this.sessionsDir, { recursive: true });

		const dbPath = resolve(config.workspaceDir, ".memory.sqlite");
		this.db = this.initDatabase(dbPath);
		this.initSchema();
	}

	/**
	 * 初始化数据库，带完整性检查和自动修复
	 */
	private initDatabase(dbPath: string): Database {
		const maxRetries = 3;
		let lastError: Error | undefined;

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				// 如果数据库文件已存在，先检查完整性
				if (existsSync(dbPath)) {
					try {
						const testDb = new Database(dbPath);
						const result = testDb.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
						testDb.close();

						if (result.integrity_check !== "ok") {
							console.warn(`[记忆] 数据库完整性检查失败: ${result.integrity_check}，尝试修复...`);
							this.backupAndRemoveCorruptedDb(dbPath);
						}
					} catch (e) {
						console.warn(`[记忆] 数据库完整性检查异常: ${e}，尝试修复...`);
						this.backupAndRemoveCorruptedDb(dbPath);
					}
				}

				// 创建或打开数据库
				const db = new Database(dbPath);
				db.exec("PRAGMA journal_mode = WAL");

				// 验证基本操作
				db.prepare("SELECT 1").get();

				if (attempt > 1) {
					console.log(`[记忆] 数据库初始化成功（第 ${attempt} 次尝试）`);
				}

				return db;
			} catch (e) {
				lastError = e as Error;
				console.warn(`[记忆] 数据库初始化失败（第 ${attempt}/${maxRetries} 次尝试）: ${e}`);

				if (attempt < maxRetries) {
					// 删除损坏的文件并重试
					this.backupAndRemoveCorruptedDb(dbPath);
					// 短暂延迟后重试
					Bun.sleepSync(500 * attempt);
				}
			}
		}

		throw new Error(`[记忆] 数据库初始化失败（已重试 ${maxRetries} 次）: ${lastError?.message}`);
	}

	/**
	 * 备份并删除损坏的数据库文件
	 */
	private backupAndRemoveCorruptedDb(dbPath: string): void {
		try {
			const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
			const backupDir = resolve(this.config.workspaceDir, "backups", `corrupted-${timestamp}`);
			mkdirSync(backupDir, { recursive: true });

			// 备份所有相关文件
			for (const suffix of ["", "-shm", "-wal"]) {
				const file = `${dbPath}${suffix}`;
				if (existsSync(file)) {
					const backupFile = resolve(backupDir, `.memory.sqlite${suffix}`);
					try {
						const content = readFileSync(file);
						writeFileSync(backupFile, content);
						unlinkSync(file);
					} catch (e) {
						console.warn(`[记忆] 备份文件失败 ${file}: ${e}`);
						// 即使备份失败也尝试删除
						try {
							unlinkSync(file);
						} catch {}
					}
				}
			}

			console.log(`[记忆] 已备份损坏数据库到: ${backupDir}`);
		} catch (e) {
			console.error(`[记忆] 备份失败: ${e}，直接删除损坏文件`);
			// 备份失败时，直接删除损坏文件
			try {
				for (const suffix of ["", "-shm", "-wal"]) {
					const file = `${dbPath}${suffix}`;
					if (existsSync(file)) {
						unlinkSync(file);
					}
				}
			} catch {}
		}
	}

	private initSchema(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS chunks (
				id         TEXT PRIMARY KEY,
				path       TEXT NOT NULL,
				text       TEXT NOT NULL,
				start_line INTEGER,
				end_line   INTEGER,
				embedding  BLOB,
				hash       TEXT,
				updated_at TEXT DEFAULT (datetime('now'))
			);
			CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);

			CREATE TABLE IF NOT EXISTS files (
				path       TEXT PRIMARY KEY,
				hash       TEXT NOT NULL,
				size       INTEGER,
				updated_at TEXT DEFAULT (datetime('now'))
			);

			CREATE TABLE IF NOT EXISTS embedding_cache (
				hash       TEXT NOT NULL,
				model      TEXT NOT NULL,
				embedding  BLOB NOT NULL,
				updated_at TEXT DEFAULT (datetime('now')),
				PRIMARY KEY (hash, model)
			);
		`);

		try {
			this.db.exec(`
				CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
					chunk_id, text, tokenize='unicode61'
				);
			`);
			this.hasFts5 = true;
		} catch {
			console.warn("[记忆] FTS5 不可用，使用基础关键词搜索");
		}
	}

	// ── 嵌入 API（带缓存）──────────────────────────

	private getCachedEmbedding(hash: string): number[] | null {
		const row = this.db
			.prepare("SELECT embedding FROM embedding_cache WHERE hash = ? AND model = ?")
			.get(hash, this.config.embeddingModel) as { embedding: Buffer } | null;
		if (!row) return null;
		return Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4));
	}

	private cacheEmbedding(hash: string, embedding: number[]): void {
		const buf = Buffer.from(new Float32Array(embedding).buffer);
		this.db
			.prepare("INSERT OR REPLACE INTO embedding_cache (hash, model, embedding) VALUES (?, ?, ?)")
			.run(hash, this.config.embeddingModel, buf);
	}

	private async embedOne(text: string): Promise<number[]> {
		if (!this.config.embeddingApiKey) throw new Error("Embedding API key not set");

		const hash = textHash(text);
		const cached = this.getCachedEmbedding(hash);
		if (cached) return cached;

		const maxRetries = 2;
		let lastErr: Error | undefined;
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			if (attempt > 0) {
				await new Promise((r) => setTimeout(r, 1000 * attempt));
			}
			try {
				const res = await fetch(this.config.embeddingEndpoint, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${this.config.embeddingApiKey}`,
					},
					body: JSON.stringify({
						model: this.config.embeddingModel,
						input: [{ type: "text", text: text.slice(0, 1024) }],
					}),
				});

				if (!res.ok) {
					const body = await res.text().catch(() => "");
					throw new Error(`Embedding API ${res.status}: ${body.slice(0, 200)}`);
				}

				const json = (await res.json()) as {
					data: { embedding: number[] } | { embedding: number[] }[];
				};
				// 火山引擎 multimodal API 返回 data.embedding（对象），标准 OpenAI 格式返回 data[0].embedding（数组）
				const data = json.data;
				let embedding: number[];
				if (Array.isArray(data)) {
					const first = data[0] as { embedding?: number[] } | undefined;
					if (!first?.embedding) throw new Error("Embedding API: missing data[0].embedding");
					embedding = first.embedding;
				} else {
					const single = data as { embedding?: number[] };
					if (!single.embedding) throw new Error("Embedding API: missing data.embedding");
					embedding = single.embedding;
				}
				this.cacheEmbedding(hash, embedding);
				return embedding;
			} catch (err) {
				lastErr = err instanceof Error ? err : new Error(String(err));
				if (attempt < maxRetries) {
					console.warn(`[记忆] 嵌入请求失败（第 ${attempt + 1} 次），${1 * (attempt + 1)}s 后重试: ${lastErr.message}`);
				}
			}
		}
		throw lastErr!;
	}

	// ── 文本分块 ──────────────────────────────────

	private chunkFile(
		content: string,
		path: string,
	): Array<{ id: string; path: string; text: string; startLine: number; endLine: number; hash: string }> {
		const lines = content.split("\n");
		const chunks: Array<{ id: string; path: string; text: string; startLine: number; endLine: number; hash: string }> = [];
		const MAX_CHARS = 600;
		const OVERLAP = 3;

		let buf: string[] = [];
		let startLine = 1;

		const pushChunk = () => {
			const text = buf.join("\n");
			if (text.trim().length < 20) return;
			const endLine = startLine + buf.length - 1;
			chunks.push({
				id: `${path}:${startLine}-${endLine}`,
				path,
				text,
				startLine,
				endLine,
				hash: textHash(text),
			});
			const keep = buf.slice(-OVERLAP);
			startLine = startLine + buf.length - keep.length;
			buf = [...keep];
		};

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (line === undefined) continue;

			if (/^#{1,3}\s/.test(line) && buf.length > 0) {
				pushChunk();
			}

			buf.push(line);

			if (buf.join("\n").length > MAX_CHARS && buf.length > OVERLAP + 1) {
				pushChunk();
			}
		}

		if (buf.length > 0 && buf.join("\n").trim().length > 10) {
			const text = buf.join("\n");
			chunks.push({
				id: `${path}:${startLine}-${startLine + buf.length - 1}`,
				path,
				text,
				startLine,
				endLine: startLine + buf.length - 1,
				hash: textHash(text),
			});
		}

		return chunks;
	}

	// ── 全工作区扫描 ─────────────────────────────

	private static readonly INDEXABLE_EXTS = new Set([".md", ".txt", ".html", ".mdc", ".json", ".csv", ".tsv", ".xml", ".yaml", ".yml", ".toml"]);
	private static readonly SKIP_DIRS = new Set([".git", ".cursor", "node_modules", "sessions", "inbox", "relay-bot", "vector-index", "dist", "build", "__pycache__"]);
	private static readonly SKIP_FILES = new Set(["package-lock.json", "pnpm-lock.yaml", ".DS_Store", ".sessions.json", ".memory.sqlite", ".memory.sqlite-shm", ".memory.sqlite-wal"]);
	private static readonly MAX_FILE_BYTES = 100 * 1024; // 100KB — 跳过超大文件，避免浪费嵌入额度

	private scanFiles(): Map<string, { content: string; hash: string; size: number }> {
		const result = new Map<string, { content: string; hash: string; size: number }>();
		const root = this.config.workspaceDir;

		const walk = (dir: string): void => {
			let entries: string[];
			try {
				entries = readdirSync(dir);
			} catch {
				return;
			}

		for (const name of entries) {
			// 特殊处理：.cursor 目录只索引 memory 子目录和 MEMORY.md
			if (name === ".cursor") {
				const cursorPath = resolve(dir, name);
				try {
					const cursorStat = statSync(cursorPath);
					if (cursorStat.isDirectory()) {
						// 索引 .cursor/memory/ 目录下的所有文件
						const memoryPath = resolve(cursorPath, "memory");
						if (existsSync(memoryPath)) {
							walk(memoryPath);
						}
						// 索引根目录的 .cursor/MEMORY.md
						const memoryMdPath = resolve(cursorPath, "MEMORY.md");
						if (existsSync(memoryMdPath)) {
							try {
								const memStat = statSync(memoryMdPath);
								if (memStat.isFile() && memStat.size > 0 && memStat.size <= MemoryManager.MAX_FILE_BYTES) {
									const content = readFileSync(memoryMdPath, "utf-8");
									if (content.trim().length >= 20) {
										const relPath = relative(root, memoryMdPath);
										result.set(relPath, { content, hash: textHash(content), size: memStat.size });
									}
								}
							} catch {}
						}
					}
				} catch {}
				continue;  // 跳过 .cursor 的其他内容
			}
			
			if (name.startsWith(".")) continue;

			const fullPath = resolve(dir, name);
			let stat;
			try {
				stat = statSync(fullPath);
			} catch {
				continue;
			}

			if (stat.isDirectory()) {
				if (MemoryManager.SKIP_DIRS.has(name)) continue;
				walk(fullPath);
				continue;
			}

				if (!stat.isFile()) continue;
				if (MemoryManager.SKIP_FILES.has(name)) continue;
				if (stat.size > MemoryManager.MAX_FILE_BYTES) continue;
				if (stat.size === 0) continue;

				const ext = extname(name).toLowerCase();
				if (!MemoryManager.INDEXABLE_EXTS.has(ext)) continue;

				const relPath = relative(root, fullPath);
				try {
					const content = readFileSync(fullPath, "utf-8");
					if (content.trim().length < 20) continue;
					result.set(relPath, { content, hash: textHash(content), size: stat.size });
				} catch {
					// 非 UTF-8 或读取失败，跳过
				}
			}
		};

		walk(root);
		return result;
	}

	private diffFiles(disk: Map<string, { hash: string }>): { changed: string[]; deleted: string[] } {
		const dbFiles = new Map<string, string>();
		for (const row of this.db.prepare("SELECT path, hash FROM files").all() as { path: string; hash: string }[]) {
			dbFiles.set(row.path, row.hash);
		}

		const changed: string[] = [];
		for (const [path, info] of disk) {
			if (dbFiles.get(path) !== info.hash) changed.push(path);
		}

		const deleted: string[] = [];
		for (const path of dbFiles.keys()) {
			if (!disk.has(path)) deleted.push(path);
		}

		return { changed, deleted };
	}

	async index(): Promise<number> {
		if (this.indexing) {
			console.log("[记忆] 索引已在进行中，跳过重复调用");
			return (this.db.prepare("SELECT COUNT(*) as c FROM chunks").get() as { c: number }).c;
		}
		this.indexing = true;
		try {
			return await this._indexInner();
		} finally {
			this.indexing = false;
		}
	}

	private async _indexInner(): Promise<number> {
		const diskFiles = this.scanFiles();
		if (diskFiles.size === 0) return 0;

		const { changed, deleted } = this.diffFiles(diskFiles);

		if (changed.length === 0 && deleted.length === 0) {
			this.indexedAt = Date.now();
			return (this.db.prepare("SELECT COUNT(*) as c FROM chunks").get() as { c: number }).c;
		}

		console.log(`[记忆] 增量索引: ${changed.length} 变更, ${deleted.length} 删除`);

		// 清理旧数据
		this.db.transaction(() => {
			for (const path of [...changed, ...deleted]) {
				if (this.hasFts5) {
					const ids = this.db.prepare("SELECT id FROM chunks WHERE path = ?").all(path) as { id: string }[];
					for (const { id } of ids) {
						this.db.prepare("DELETE FROM chunks_fts WHERE chunk_id = ?").run(id);
					}
				}
				this.db.prepare("DELETE FROM chunks WHERE path = ?").run(path);
			}
			for (const path of deleted) {
				this.db.prepare("DELETE FROM files WHERE path = ?").run(path);
			}
		})();

		// 索引变更文件
		let newChunks = 0;
		let cacheHits = 0;
		let apiCalls = 0;

		for (const path of changed) {
			const file = diskFiles.get(path)!;
			const chunks = this.chunkFile(file.content, path);

			// 嵌入（优先读缓存）
			const embeddings: Array<number[] | null> = [];
			for (const chunk of chunks) {
				const cached = this.getCachedEmbedding(chunk.hash);
				if (cached) {
					embeddings.push(cached);
					cacheHits++;
				} else {
					try {
						const emb = await this.embedOne(chunk.text);
						embeddings.push(emb);
						apiCalls++;
					} catch (err) {
						console.warn(`[记忆] 嵌入失败 ${chunk.id}: ${err instanceof Error ? err.message : err}`);
						embeddings.push(null);
					}
				}
			}

			// 写入 SQLite
			this.db.transaction(() => {
				const insChunk = this.db.prepare(
					"INSERT OR REPLACE INTO chunks (id, path, text, start_line, end_line, embedding, hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
				);
				const insFile = this.db.prepare("INSERT OR REPLACE INTO files (path, hash, size) VALUES (?, ?, ?)");

				for (let i = 0; i < chunks.length; i++) {
					const c = chunks[i];
					if (!c) continue;
					const emb = embeddings[i];
					const embBuf = emb ? Buffer.from(new Float32Array(emb).buffer) : null;
					insChunk.run(c.id, c.path, c.text, c.startLine, c.endLine, embBuf, c.hash);

					if (this.hasFts5) {
						try {
							this.db.prepare("INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)").run(c.id, c.text);
						} catch (ftsErr) {
							console.warn(`[FTS5] insert failed for ${c.id}: ${ftsErr}`);
						}
					}
				}
				insFile.run(path, file.hash, file.size);
			})();

			newChunks += chunks.length;
		}

		this.indexedAt = Date.now();
		const total = (this.db.prepare("SELECT COUNT(*) as c FROM chunks").get() as { c: number }).c;
		console.log(`[记忆] 索引完成: ${changed.length} 文件, ${newChunks} 块 (缓存命中 ${cacheHits}, API ${apiCalls}), 总计 ${total}`);
		return total;
	}

	// ── 搜索（向量 + FTS5 BM25 混合）──────────────

	async search(query: string, topK = 5, minScore = 0.3): Promise<SearchResult[]> {
		if (Date.now() - this.indexedAt > 10 * 60_000) {
			await this.index().catch((e) => console.warn(`[记忆] 自动索引失败: ${e}`));
		}

		let queryEmb: number[] | undefined;
		try {
			queryEmb = await this.embedOne(query);
		} catch (err) {
			console.warn(`[记忆搜索] 嵌入失败，降级关键词: ${err}`);
		}

		// FTS5 BM25 关键词得分
		const ftsScores = new Map<string, number>();
		if (this.hasFts5) {
			const escaped = ftsEscape(query);
			if (escaped) {
				try {
					const ftsRows = this.db
						.prepare("SELECT chunk_id, rank FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?")
						.all(escaped, topK * 4) as FtsRow[];
					for (const row of ftsRows) {
						// rank 是负数（越负越相关），转换为 0~1 分数
						ftsScores.set(row.chunk_id, 1 / (1 + Math.abs(row.rank)));
					}
				} catch (err) {
					console.warn(`[FTS5] 查询失败: ${err}`);
				}
			}
		}

		// 朴素关键词兜底（FTS5 不可用或查询为空时）
		const useNaiveKw = ftsScores.size === 0;
		const queryTokens = useNaiveKw
			? query
					.toLowerCase()
					.split(/[\s,，。、！？；：""''（）\[\]{}]+/)
					.filter((t) => t.length > 1)
			: [];

		const rows = this.db.prepare("SELECT id, path, text, start_line, end_line, embedding FROM chunks").all() as ChunkRow[];
		if (rows.length === 0) return [];

		const scored: SearchResult[] = rows.map((row) => {
			let vectorScore = 0;
			if (queryEmb && row.embedding) {
				const buf = row.embedding;
				const emb = Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
				vectorScore = Math.max(0, cosineSim(queryEmb, emb));
			}

			let keywordScore = 0;
			if (ftsScores.has(row.id)) {
				keywordScore = ftsScores.get(row.id)!;
			} else if (useNaiveKw && queryTokens.length > 0) {
				const textLower = row.text.toLowerCase();
				let hits = 0;
				for (const t of queryTokens) {
					if (textLower.includes(t)) hits++;
				}
				keywordScore = hits / queryTokens.length;
			}

			// 混合得分（向量70% + 关键词30%）
			let score = queryEmb ? 0.7 * vectorScore + 0.3 * keywordScore : keywordScore;
			
			// 应用时间衰减（旧记忆权重降低）
			const halfLife = this.config.temporalDecayHalfLife ?? 30;
			score = applyTemporalDecay(score, row.path, halfLife);

			return {
				path: row.path,
				text: row.text,
				score,
				startLine: row.start_line,
				endLine: row.end_line,
			};
		});

		// 过滤低分 + 排序
		const candidates = scored
			.filter((r) => r.score >= minScore)
			.sort((a, b) => b.score - a.score);
		
		// MMR 重排序（平衡相关性和多样性）
		const lambda = this.config.mmrLambda ?? 0.5;
		return mmrRerank(candidates, topK, lambda);
	}

	// ── 记忆上下文注入 ─────────────────────────────

	async getContextForPrompt(query: string, maxSnippets = 3): Promise<string> {
		const results = await this.search(query, maxSnippets, 0.25);
		if (results.length === 0) return "";

		const snippets = results
			.map((r) => `[来源: ${r.path}#L${r.startLine}]\n${r.text.slice(0, 400)}`)
			.join("\n---\n");

		return [
			"",
			"<memory_recall>",
			"以下是与你问题相关的记忆片段（由记忆系统自动检索）：",
			snippets,
			"</memory_recall>",
		].join("\n");
	}

	// ── 最近记忆摘要 ──────────────────────────────

	getRecentSummary(days = 2): string {
		const parts: string[] = [];
		const now = new Date();

		for (let i = 0; i < days; i++) {
			const d = new Date(now);
			d.setDate(d.getDate() - i);
			const name = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.md`;
			const fp = resolve(this.memoryDir, name);
			if (existsSync(fp)) {
				const content = readFileSync(fp, "utf-8");
				parts.push(`## ${name}\n${content.slice(0, 1200)}`);
			}
		}

		const memPath = resolve(this.config.workspaceDir, ".cursor/MEMORY.md");
		if (existsSync(memPath)) {
			const content = readFileSync(memPath, "utf-8");
			if (content.trim().length > 50) {
				parts.push(`## MEMORY.md（长期记忆）\n${content.slice(0, 2000)}`);
			}
		}

		return parts.join("\n\n");
	}

	// ── 每日日记 ──────────────────────────────────

	appendDailyLog(content: string): string {
		const logPath = resolve(this.memoryDir, `${todayStr()}.md`);
		const time = timeStr();
		const entry = `\n### ${time}\n${content}\n`;

		if (!existsSync(logPath)) {
			writeFileSync(logPath, `# ${todayStr()} 日记\n${entry}`);
		} else {
			appendFileSync(logPath, entry);
		}

		return logPath;
	}

	// ── 会话日志 ──────────────────────────────────

	appendSessionLog(workspace: string, role: "user" | "assistant", content: string, model?: string): void {
		const logPath = resolve(this.sessionsDir, `${todayStr()}.jsonl`);
		const entry = JSON.stringify({
			ts: new Date().toISOString(),
			workspace,
			role,
			content: content.slice(0, 8000),
			...(model && { model }),
		});
		appendFileSync(logPath, entry + "\n");
	}

	// ── 统计 ──────────────────────────────────────

	getStats(): { chunks: number; files: number; cachedEmbeddings: number; filePaths: string[] } {
		const chunks = (this.db.prepare("SELECT COUNT(*) as c FROM chunks").get() as { c: number }).c;
		const files = (this.db.prepare("SELECT COUNT(*) as c FROM files").get() as { c: number }).c;
		const cachedEmbeddings = (this.db.prepare("SELECT COUNT(*) as c FROM embedding_cache").get() as { c: number }).c;
		const filePaths = (this.db.prepare("SELECT path FROM files ORDER BY path").all() as { path: string }[]).map((r) => r.path);
		return { chunks, files, cachedEmbeddings, filePaths };
	}

	// ── 生命周期 ──────────────────────────────────

	close(): void {
		this.db.close();
	}
}
