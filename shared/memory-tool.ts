#!/usr/bin/env bun
/**
 * 记忆工具 CLI（统一版本） — 供 Cursor Agent 通过 shell 调用
 * 
 * 支持从飞书/钉钉/企业微信任意目录调用
 * 
 * 用法：
 *   bun shared/memory-tool.ts search <query> [--top-k 5]    # 语义搜索记忆
 *   bun shared/memory-tool.ts recent [--days 3]              # 最近记忆摘要
 *   bun shared/memory-tool.ts write <content>                # 写入今日日记
 *   bun shared/memory-tool.ts stats                          # 索引统计
 *   bun shared/memory-tool.ts index                          # 重建索引
 */

import { resolve, dirname } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { MemoryManager } from "./memory.js";

// 智能检测调用平台（通过环境变量或路径推断）
function detectPlatform(): string {
	// 1. 优先使用环境变量（server.ts 调用时会设置）
	if (process.env.CURSOR_PLATFORM) {
		return process.env.CURSOR_PLATFORM;
	}
	
	// 2. 从调用者的工作目录推断
	const cwd = process.cwd();
	if (cwd.includes('/feishu')) return 'feishu';
	if (cwd.includes('/dingtalk')) return 'dingtalk';
	if (cwd.includes('/wecom')) return 'wecom';
	
	// 3. 默认从项目根目录读取（向后兼容）
	return 'root';
}

const ROOT = resolve(import.meta.dirname, "..");
const PROJECTS_PATH = resolve(ROOT, "projects.json");

function loadEnv(): Record<string, string> {
	const platform = detectPlatform();
	let envPath: string;
	
	if (platform === 'root') {
		// 向后兼容：从根目录查找任意平台的 .env
		envPath = resolve(ROOT, 'feishu/.env');
		if (!existsSync(envPath)) envPath = resolve(ROOT, 'dingtalk/.env');
		if (!existsSync(envPath)) envPath = resolve(ROOT, 'wecom/.env');
	} else {
		envPath = resolve(ROOT, `${platform}/.env`);
	}
	
	if (!existsSync(envPath)) {
		console.warn(`⚠️  .env 不存在: ${envPath}，将使用默认配置`);
		return {};
	}
	
	const env: Record<string, string> = {};
	for (const line of readFileSync(envPath, "utf-8").split("\n")) {
		const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
		if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
	}
	return env;
}

function getWorkspacePath(): string {
	if (!existsSync(PROJECTS_PATH)) return ROOT;
	try {
		const cfg = JSON.parse(readFileSync(PROJECTS_PATH, "utf-8"));
		// 优先使用 memory_workspace 配置，避免污染工作项目
		const memoryWorkspaceKey = (cfg as any).memory_workspace || cfg.default_project;
		return cfg.projects?.[memoryWorkspaceKey]?.path || ROOT;
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

// ── CLI 命令处理 ──────────────────────────────────

const [cmd, ...args] = process.argv.slice(2);

(async () => {
	if (cmd === "search") {
		if (args.length === 0) {
			console.error("用法: bun memory-tool.ts search <关键词>");
			process.exit(1);
		}
		const query = args.join(" ");
		const topK = Number.parseInt(
			args.find((a) => a.startsWith("--top-k="))?.split("=")[1] || "5",
			10,
		);

		const results = await mm.search(query, topK);
		if (results.length === 0) {
			console.log(`未找到与「${query}」相关的记忆。`);
			process.exit(0);
		}

		console.log(`🔍 搜索「${query}」\n`);
		for (const r of results) {
			console.log(`${r.path}#L${r.startLine}:${r.endLine} (相关度 ${(r.score * 100).toFixed(0)}%)`);
			console.log(r.text.slice(0, 300));
			console.log("");
		}
	} else if (cmd === "recent") {
		const daysArg = args.find((a) => a.startsWith("--days="))?.split("=")[1];
		const days = daysArg ? Number.parseInt(daysArg, 10) : 3;

		const summary = mm.getRecentSummary(days);
		console.log(summary);
	} else if (cmd === "write") {
		if (args.length === 0) {
			console.error("用法: bun memory-tool.ts write <要记录的内容>");
			process.exit(1);
		}
		const content = args.join(" ");
		const path = mm.appendDailyLog(content);
		console.log(`✅ 已记录到今日日记\n\n${path}`);
	} else if (cmd === "stats") {
		const stats = mm.getStats();
		console.log(`
📊 记忆索引统计

总块数: ${stats.chunks}
文件数: ${stats.files}
嵌入缓存: ${stats.cachedEmbeddings} 条
嵌入模型: ${model || '未配置'}

已索引文件:
${stats.filePaths.slice(0, 25).map((p) => `  ${p}`).join("\n")}${stats.filePaths.length > 25 ? `\n  ...及其他 ${stats.filePaths.length - 25} 个文件` : ""}
		`);
	} else if (cmd === "index") {
		console.log("⏳ 正在扫描并索引全工作区...");
		const count = await mm.index();
		const stats = mm.getStats();
		console.log(`
✅ 索引完成

索引块数: ${count}
文件数: ${stats.files}
嵌入缓存: ${stats.cachedEmbeddings} 条
嵌入模型: ${model || '未配置'}
		`);
	} else {
		console.log(`
🧠 记忆工具 CLI（统一版本）

用法:
  bun shared/memory-tool.ts search <关键词>     语义搜索记忆（向量+关键词混合）
  bun shared/memory-tool.ts recent [--days N]   查看最近 N 天的记忆摘要
  bun shared/memory-tool.ts write <内容>        写入今日日记
  bun shared/memory-tool.ts stats               查看索引统计
  bun shared/memory-tool.ts index               重建全工作区索引

平台检测: ${detectPlatform()}
工作区: ${workspaceDir}
		`);
		process.exit(cmd ? 1 : 0);
	}

	mm.close();
})();
