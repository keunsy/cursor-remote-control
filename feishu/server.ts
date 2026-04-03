/**
 * 飞书长连接 → Cursor Agent CLI 中继服务 v3
 *
 * 直连方案：飞书 SDK ↔ Cursor Agent CLI
 * - 飞书消息直达 Cursor，零提示词污染
 * - 普通互动卡片回复 + 消息更新（无需 CardKit 权限）
 * - 支持文字、图片、语音、文件、富文本
 * - 长消息自动分片
 *
 * 启动: bun run server.ts
 */
import * as Lark from "@larksuiteoapi/node-sdk";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, watchFile, unwatchFile, mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { gzipSync, gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { MemoryManager } from "../shared/memory.js";
import { Scheduler, type CronJob } from "../shared/scheduler.js";
import { HeartbeatRunner, getHeartbeatGlobalConfig, createSessionActivityGate, isHeartbeatEnabled } from "../shared/heartbeat.js";
import { FeilianController, type OperationResult } from "../shared/feilian-control.js";
import { fetchNews } from "../shared/news-fetcher.js";
import { getHealthStatus } from "../shared/news-sources/monitoring.js";
import { CommandHandler, type PlatformAdapter, type CommandContext } from "../shared/command-handler.js";
import { AgentExecutor, writeFeedbackGateResponse, type FeedbackGateRequest } from "../shared/agent-executor.js";
import { ProcessLock } from "../shared/process-lock.js";
// import { ReconnectManager } from "../shared/reconnect-manager.js";  // 已移除，SDK 自带重连
import { tryRecordMessagePersistent } from "./feishu/dedup.js";
import { sendMediaFeishu } from "./feishu/media.js";

// ── 进程锁（防止多实例运行）──────────────────────
const processLock = new ProcessLock("feishu");
if (!processLock.acquire()) {
	console.error("\n❌ 飞书服务已在运行，无法启动第二个实例");
	console.error("💡 如需重启，请先停止现有进程: bash service.sh restart");
	process.exit(1);
}
import { humanizeCronInChinese } from 'cron-chinese';
import { getAvailableModelChain, shouldFallback, isQuotaExhausted, addToBlacklist, isBlacklisted, getDefaultModel } from "../shared/models-config.js";

const HOME = process.env.HOME;
if (!HOME) throw new Error("$HOME is not set");

const ROOT = resolve(import.meta.dirname, "..");
const ENV_PATH = resolve(import.meta.dirname, ".env");
const PROJECTS_PATH = resolve(ROOT, "projects.json");
const AGENT_BIN = process.env.AGENT_BIN || resolve(HOME, ".local/bin/agent");
const INBOX_DIR = resolve(ROOT, "inbox");

mkdirSync(INBOX_DIR, { recursive: true });

// 启动时清理超过 24h 的临时文件
const DAY_MS = 24 * 60 * 60 * 1000;
for (const f of readdirSync(INBOX_DIR)) {
	const p = resolve(INBOX_DIR, f);
	try { if (Date.now() - statSync(p).mtimeMs > DAY_MS) unlinkSync(p); } catch {}
}

process.on("uncaughtException", (err) => console.error(`[致命异常] ${err.message}\n${err.stack}`));
process.on("unhandledRejection", (reason) => console.error("[Promise 异常]", reason));

// ── .env 热更换 ──────────────────────────────────
interface EnvConfig {
	CURSOR_API_KEY: string;
	FEISHU_APP_ID: string;
	FEISHU_APP_SECRET: string;
	CURSOR_MODEL: string;
	VOLC_STT_APP_ID: string;
	VOLC_STT_ACCESS_TOKEN: string;
	VOLC_EMBEDDING_API_KEY: string;
	VOLC_EMBEDDING_MODEL: string;
	MEMORY_TEMPORAL_DECAY_HALF_LIFE?: string;
	MEMORY_MMR_LAMBDA?: string;
}

interface AgentEnv extends NodeJS.ProcessEnv {
	CURSOR_API_KEY: string;
	CURSOR_PLATFORM?: string;
	CURSOR_WEBHOOK?: string;
	CURSOR_CRON_FILE?: string;
}

function loadEnv(): EnvConfig {
	if (!existsSync(ENV_PATH)) {
		console.error(`[致命] .env 文件不存在: ${ENV_PATH}`);
		process.exit(1);
	}
	const raw = readFileSync(ENV_PATH, "utf-8");
	const env: Record<string, string> = {};
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIdx = trimmed.indexOf("=");
		if (eqIdx < 0) continue;
		let val = trimmed.slice(eqIdx + 1).trim();
		// 去除引号包裹
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1);
		}
		env[trimmed.slice(0, eqIdx).trim()] = val;
	}
	return {
		CURSOR_API_KEY: env.CURSOR_API_KEY || "",
		FEISHU_APP_ID: env.FEISHU_APP_ID || "",
		FEISHU_APP_SECRET: env.FEISHU_APP_SECRET || "",
		CURSOR_MODEL: env.CURSOR_MODEL || '',
		VOLC_STT_APP_ID: env.VOLC_STT_APP_ID || "",
		VOLC_STT_ACCESS_TOKEN: env.VOLC_STT_ACCESS_TOKEN || "",
		VOLC_EMBEDDING_API_KEY: env.VOLC_EMBEDDING_API_KEY || "",
		VOLC_EMBEDDING_MODEL: env.VOLC_EMBEDDING_MODEL || "doubao-embedding-vision-250615",
	};
}

const config = loadEnv();
watchFile(ENV_PATH, { interval: 2000 }, () => {
	try {
		const prev = config.CURSOR_API_KEY;
		const prevModel = config.CURSOR_MODEL;
		const newConfig = loadEnv();
		Object.assign(config, newConfig);
		if (config.CURSOR_API_KEY !== prev) {
			console.log(`[热更换] API Key 已更新 (...${config.CURSOR_API_KEY.slice(-8)})`);
		}
		if (config.CURSOR_MODEL !== prevModel) {
			console.log(`[热更新] 模型已切换: ${prevModel} → ${config.CURSOR_MODEL}`);
		}
	} catch {}
});

// ── 项目配置 ─────────────────────────────────────
interface ProjectsConfig {
	projects: Record<string, { path: string; description: string }>;
	default_project: string;
}
// Bug 修复：projects.json 不存在时使用默认配置，而非退出
let projectsConfig: ProjectsConfig;
try {
	projectsConfig = existsSync(PROJECTS_PATH)
		? JSON.parse(readFileSync(PROJECTS_PATH, "utf-8"))
		: { projects: { default: { path: ROOT, description: "Default" } }, default_project: "default" };
} catch (err) {
	console.error(`❌ 加载 projects.json 失败: ${err instanceof Error ? err.message : err}`);
	console.error(`   文件路径: ${PROJECTS_PATH}`);
	console.error(`   使用默认配置...\n`);
	projectsConfig = {
		projects: { default: { path: ROOT, description: "Default" } },
		default_project: "default",
	};
}

// Bug 修复：添加 projects.json 热更新监听（与其他平台对齐）
watchFile(PROJECTS_PATH, { interval: 5000 }, () => {
	try {
		const newConfig = JSON.parse(readFileSync(PROJECTS_PATH, "utf-8"));
		Object.assign(projectsConfig, newConfig);
		console.log(`[热更新] projects.json 已重新加载`);
	} catch (err) {
		console.error("[热更新] projects.json 加载失败:", err);
	}
});

// ── 工作区模板自动初始化 ─────────────────────────
const TEMPLATE_DIR = resolve(import.meta.dirname, "templates");
const WORKSPACE_FILES = [
	".cursor/SOUL.md", ".cursor/USER.md",
	".cursor/MEMORY.md", ".cursor/HEARTBEAT.md",
	".cursor/BOOT.md", ".cursor/TOOLS.md",
	".cursor/CRON-TASK-RULES.md",
];
const WORKSPACE_RULES = [
	".cursor/rules/soul.mdc",
	".cursor/rules/agent-identity.mdc",
	".cursor/rules/user-context.mdc",
	".cursor/rules/workspace-rules.mdc",
	".cursor/rules/tools.mdc",
	".cursor/rules/memory-protocol.mdc",
	".cursor/rules/scheduler-protocol.mdc",
	".cursor/rules/heartbeat-protocol.mdc",
	".cursor/rules/cursor-capabilities.mdc",
];

function ensureWorkspace(wsPath: string): boolean {
	const normalizedWs = resolve(wsPath);
	const normalizedRoot = resolve(ROOT);
	// 仅在本项目（cursor-remote-control）目录下复制 AGENTS.md / .cursor 模板，不污染其他项目
	const isOwnProject = normalizedWs === normalizedRoot;

	if (!isOwnProject) {
		// 非本项目：不创建任何目录，完全不污染
		return false;
	}

	// 本项目：创建必要的目录结构
	mkdirSync(resolve(wsPath, ".cursor/memory"), { recursive: true });
	mkdirSync(resolve(wsPath, ".cursor/sessions"), { recursive: true });
	mkdirSync(resolve(wsPath, ".cursor/rules"), { recursive: true });
	mkdirSync(resolve(wsPath, ".cursor/skills"), { recursive: true });

	const isNewWorkspace = !existsSync(resolve(wsPath, ".cursor/SOUL.md"));
	let copied = 0;

	if (true) {  // 已经确认是 isOwnProject
		// AGENTS.md 放在根目录（Cursor 自动加载约定）- 仅在本项目生成
		const rootFiles = ["AGENTS.md"];
		// 首次初始化时额外复制 BOOTSTRAP.md（仅新工作区）
		const allFiles = isNewWorkspace
			? [...rootFiles, ...WORKSPACE_FILES, ".cursor/BOOTSTRAP.md", ...WORKSPACE_RULES]
			: [...rootFiles, ...WORKSPACE_FILES, ...WORKSPACE_RULES];

		for (const f of allFiles) {
			const target = resolve(wsPath, f);
			if (!existsSync(target)) {
				const src = resolve(TEMPLATE_DIR, f);
				if (existsSync(src)) {
					writeFileSync(target, readFileSync(src, "utf-8"));
					console.log(`[工作区] 从模板复制: ${f}`);
					copied++;
				}
			}
		}

		// Skills（Cursor 官方 skill 规范：.cursor/skills/skill-name/SKILL.md）
		const skillsSrc = resolve(TEMPLATE_DIR, ".cursor/skills");
		if (existsSync(skillsSrc)) {
			for (const name of readdirSync(skillsSrc)) {
				const srcDir = resolve(skillsSrc, name);
				if (!statSync(srcDir).isDirectory()) continue;
				const targetSkill = resolve(wsPath, `.cursor/skills/${name}/SKILL.md`);
				if (!existsSync(targetSkill)) {
					const targetDir = resolve(wsPath, `.cursor/skills/${name}`);
					mkdirSync(targetDir, { recursive: true });
					for (const file of readdirSync(srcDir)) {
						writeFileSync(resolve(targetDir, file), readFileSync(resolve(srcDir, file), "utf-8"));
					}
					console.log(`[工作区] 从模板复制 skill: ${name}`);
					copied++;
				}
			}
		}
	}

	if (copied > 0) {
		console.log(`[工作区] ${wsPath} 初始化完成 (${copied} 个文件)`);
		if (isNewWorkspace) {
			console.log("[工作区] 首次启动：.cursor/BOOTSTRAP.md 已就绪，首次对话将触发出生仪式");
		}
	}
	return isNewWorkspace;
}

// ── 记忆管理器 ───────────────────────────────────
const defaultWorkspace = projectsConfig.projects[projectsConfig.default_project]?.path || ROOT;

// 记忆工作区：支持独立配置，避免污染工作项目
const memoryWorkspaceKey = (projectsConfig as any).memory_workspace || projectsConfig.default_project;
const memoryWorkspace = projectsConfig.projects[memoryWorkspaceKey]?.path || defaultWorkspace;
ensureWorkspace(memoryWorkspace);  // 仅初始化记忆工作区，不污染其他项目

let memory: MemoryManager | undefined;
try {
	memory = new MemoryManager({
		workspaceDir: memoryWorkspace,
		embeddingApiKey: config.VOLC_EMBEDDING_API_KEY,
		embeddingModel: config.VOLC_EMBEDDING_MODEL,
		embeddingEndpoint: "https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal",
		// OpenClaw 风格记忆优化配置（可选）
		temporalDecayHalfLife: config.MEMORY_TEMPORAL_DECAY_HALF_LIFE ? Number(config.MEMORY_TEMPORAL_DECAY_HALF_LIFE) : 30,
		mmrLambda: config.MEMORY_MMR_LAMBDA ? Number(config.MEMORY_MMR_LAMBDA) : 0.5,
	});
	setTimeout(() => {
		memory!.index().then((n) => {
			if (n > 0) console.log(`[记忆] 启动索引完成: ${n} 块`);
		}).catch((e) => console.warn(`[记忆] 启动索引失败: ${e}`));
	}, 3000);
} catch (e) {
	console.warn(`[记忆] 初始化失败（功能降级）: ${e}`);
}

// ── 最近活跃会话（用于定时任务/心跳主动推送）─────
let lastActiveChatId: string | undefined;

// ── 定时任务调度器 ────────────────────────────────
// 保存在固定的全局目录（不随项目切换而变化）
const cronStorePath = resolve(ROOT, "cron-jobs-feishu.json");

const scheduler = new Scheduler({
	storePath: cronStorePath,
	defaultWorkspace,
	onExecute: async (job: CronJob) => {
		// 新格式：优先使用 task 字段
		if (job.task) {
			switch (job.task.type) {
				case 'fetch-news': {
					const topN = job.task.options?.topN ?? 15;
					console.log(`[scheduler] fetching news (新格式), topN=${topN}`);
					const { messages } = await fetchNews({ topN, platform: "feishu" });
					console.log(`[scheduler] news fetched, ${messages.length} batch(es)`);
					if (messages.length > 1) {
						return { status: "ok" as const, result: JSON.stringify({ chunks: messages }) };
					}
					return { status: "ok" as const, result: messages[0] ?? "" };
				}
				
				case 'agent-prompt': {
					try {
						console.log(`[scheduler] 执行 Agent (新格式): ${job.task.prompt.slice(0, 100)}`);
						const workspace = job.workspace || defaultWorkspace;
						const model = job.model || config.CURSOR_MODEL || getDefaultModel();
						const chatId = job.webhook || lastActiveChatId;
						
						const { result } = await runAgent(workspace, job.task.prompt, {
							context: { chatId: chatId || '' }
						});
						
						return { status: 'ok' as const, result };
					} catch (err) {
						console.error('[scheduler] Agent 执行失败:', err);
						const errMsg = err instanceof Error ? err.message : String(err);
						return { 
							status: 'error' as const, 
							error: errMsg,
							result: `❌ Agent 执行失败\n\n${errMsg}`
						};
					}
				}
				
				case 'text':
					return { status: 'ok' as const, result: job.task.content };
			}
		}
		
		// 旧格式：向后兼容 message 字段
		const msg = job.message;
		const isNews =
			msg === "fetch-news" ||
			msg === '{"type":"fetch-news"}' ||
			(typeof msg === "string" && msg.startsWith('{"type":"fetch-news"'));
		if (isNews) {
			try {
				let topN = 15;
				if (typeof msg === "string" && msg.startsWith("{")) {
					try {
						const parsed = JSON.parse(msg) as { type?: string; options?: { topN?: number } };
						topN = parsed.options?.topN ?? 15;
					} catch {}
				}
				console.log(`[scheduler] fetching news (旧格式), topN=${topN}`);
				const { messages } = await fetchNews({ topN, platform: "feishu" });
				console.log(`[scheduler] news fetched, ${messages.length} batch(es)`);
				if (messages.length > 1) {
					return { status: "ok" as const, result: JSON.stringify({ chunks: messages }) };
				}
				return { status: "ok" as const, result: messages[0] ?? "" };
			} catch (err) {
				console.error(`[scheduler] news fetch failed:`, err);
				const fallback = `⚠️ 热点抓取失败\n\n${err instanceof Error ? err.message : String(err)}\n\n稍后会自动重试`;
				return { status: "error" as const, error: String(err), result: fallback };
			}
		}
		
		// Agent 执行任务（旧格式）
		const isAgentPrompt = typeof msg === 'string' && msg.startsWith('{"type":"agent-prompt"');
		if (isAgentPrompt) {
			try {
				const parsed = JSON.parse(msg) as {
					type: 'agent-prompt';
					prompt: string;
					options?: { timeoutMs?: number };
				};
				console.log(`[scheduler] 执行 Agent (旧格式): ${parsed.prompt.slice(0, 100)}`);
				const workspace = job.workspace || defaultWorkspace;
				const model = job.model || config.CURSOR_MODEL || getDefaultModel();
				const chatId = job.webhook || lastActiveChatId;
				
				const { result } = await runAgent(workspace, parsed.prompt, {
					context: { chatId: chatId || '' }
				});
				
				return { status: 'ok' as const, result };
			} catch (err) {
				console.error('[scheduler] Agent 执行失败:', err);
				const errMsg = err instanceof Error ? err.message : String(err);
				return { 
					status: 'error' as const, 
					error: errMsg,
					result: `❌ Agent 执行失败\n\n${errMsg}`
				};
			}
		}
		
		// 普通提醒任务
		console.log(`[scheduler] task triggered: ${job.name}`);
		return { status: "ok" as const, result: msg };
	},
	onDelivery: async (job: CronJob, result: string) => {
		// 优先使用任务中保存的 chatId（确保发送到创建任务的平台）
		const chatId = job.webhook || lastActiveChatId;
		if (!chatId) {
			console.warn("[scheduler] no active session, skip delivery");
			return;
		}
		
		// 只有飞书创建的任务才发送到飞书
		if (job.platform && job.platform !== 'feishu') {
			console.log(`[scheduler] task ${job.name} belongs to ${job.platform}, skip feishu delivery`);
			return;
		}
		
		// TypeScript 类型守卫：此处 chatId 已确认非空
		const validChatId: string = chatId;
		
		// 多消息分片：result 为 JSON { chunks: string[] }（新闻任务）
		let chunks: string[] | null = null;
		try {
			const parsed = JSON.parse(result) as { chunks?: string[] };
			if (parsed && Array.isArray(parsed.chunks) && parsed.chunks.length > 0) {
				chunks = parsed.chunks;
			}
		} catch {}
		
		if (chunks) {
			for (let i = 0; i < chunks.length; i++) {
				const piece = chunks[i];
				if (piece === undefined) continue;
				const title = chunks.length > 1 ? `📰 今日热点 (${i + 1}/${chunks.length})` : "📰 今日热点";
				await sendCard(validChatId, piece, { title, color: "blue" });
			}
			console.log(`[scheduler] feishu news sent: ${chunks.length} chunk(s)`);
		} else {
			const now = new Date();
			const timeStr = now.toLocaleString('zh-CN', {
				month: '2-digit',
				day: '2-digit',
				hour: '2-digit',
				minute: '2-digit',
				hour12: false,
			});
			const content = `**${result}**\n\n⏱ 提醒时间：${timeStr}\n📌 任务名称：${job.name}`;
			await sendCard(chatId, content, { title: "⏰ 定时提醒", color: "blue" });
			console.log(`[scheduler] feishu reminder sent: ${result}`);
		}
	},
	log: (msg: string) => console.log(`[调度] ${msg}`),
});

// ── 心跳系统 ──────────────────────────────────────
const hbGlobal = getHeartbeatGlobalConfig();

const heartbeat = new HeartbeatRunner({
	config: {
		enabled: isHeartbeatEnabled('feishu'),
		everyMs: hbGlobal.everyMs,
		workspaceDir: memoryWorkspace,
		...(hbGlobal.activeHours ? { activeHours: hbGlobal.activeHours } : {}),
	},
	shouldRun: createSessionActivityGate(memoryWorkspace),
	onExecute: async (prompt: string) => {
		memory?.appendSessionLog(memoryWorkspace, "user", "[心跳检查] " + prompt.slice(0, 200), config.CURSOR_MODEL);
		const { result } = await runAgent(memoryWorkspace, prompt);
		memory?.appendSessionLog(memoryWorkspace, "assistant", result.slice(0, 3000), config.CURSOR_MODEL);
		return result;
	},
	onDelivery: async (content: string) => {
		if (!lastActiveChatId) {
			console.warn("[心跳] 无活跃会话，跳过发送");
			return;
		}
		await sendCard(lastActiveChatId, content, { title: "💓 心跳检查", color: "purple" });
	},
	log: (msg: string) => console.log(`[心跳] ${msg}`),
});

// ── 飞书 Client ──────────────────────────────────
const larkClient = new Lark.Client({
	appId: config.FEISHU_APP_ID,
	appSecret: config.FEISHU_APP_SECRET,
	domain: Lark.Domain.Feishu,
});

// ── 卡片构建 ─────────────────────────────────────
function buildCard(markdown: string, header?: { title?: string; color?: string }): string {
	const card: Record<string, unknown> = {
		schema: "2.0",
		config: { wide_screen_mode: true },
		body: { elements: [{ tag: "markdown", content: markdown }] },
	};
	if (header) {
		const h: Record<string, unknown> = { template: header.color || "blue" };
		if (header.title) h.title = { tag: "plain_text", content: header.title };
		card.header = h;
	}
	return JSON.stringify(card);
}

// 从飞书 API 错误中提取可读原因
function extractCardError(err: unknown): string | null {
	try {
		const e = err as Record<string, unknown>;
		// axios 错误结构: err.response.data 或 err[1]（Lark SDK 包装）
		const data = (e.response as Record<string, unknown>)?.data as Record<string, unknown>
			?? (Array.isArray(e) ? e[1] : null)
			?? e;
		if (!data) return null;
		const code = data.code as number;
		const msg = data.msg as string;
		if (code === 230099) return `卡片渲染失败: ${msg}`;
		if (code === 230025) return "卡片内容超过30KB大小限制";
		if (msg) return msg;
	} catch {}
	return null;
}

// ── 飞书消息操作 ─────────────────────────────────
async function replyCard(
	messageId: string,
	markdown: string,
	header?: { title?: string; color?: string },
): Promise<string | undefined> {
	try {
		console.log(`[replyCard] 调用 messageId=${messageId.slice(0, 20)}... title=${header?.title}`);
		const cardContent = buildCard(markdown, header);
		console.log(`[replyCard] 卡片内容长度: ${cardContent.length} 字节`);
		
		const res = await larkClient.im.message.reply({
			path: { message_id: messageId },
			data: { content: cardContent, msg_type: "interactive" },
		});
		
		console.log(`[replyCard] API 返回: code=${res.code} msg=${res.msg}`);
		console.log(`[replyCard] 返回 messageId: ${res.data?.message_id}`);
		return res.data?.message_id;
	} catch (err) {
		console.error("[回复卡片失败]", err);
		console.log("[replyCard] 降级为纯文本消息");
		try {
			const res = await larkClient.im.message.reply({
				path: { message_id: messageId },
				data: { content: JSON.stringify({ text: markdown }), msg_type: "text" },
			});
			console.log(`[replyCard] 纯文本发送成功: ${res.data?.message_id}`);
			return res.data?.message_id;
		} catch (err2) {
			console.error("[纯文本回复也失败]", err2);
		}
	}
}

async function updateCard(
	messageId: string,
	markdown: string,
	header?: { title?: string; color?: string },
): Promise<{ ok: boolean; error?: string }> {
	try {
		await larkClient.im.message.patch({
			path: { message_id: messageId },
			data: { content: buildCard(markdown, header) },
		});
		return { ok: true };
	} catch (err) {
		const reason = extractCardError(err) || (err instanceof Error ? err.message : String(err));
		console.error(`[更新卡片失败] ${reason}`);
		return { ok: false, error: reason };
	}
}

async function sendCard(
	chatId: string,
	markdown: string,
	header?: { title?: string; color?: string },
): Promise<string | undefined> {
	try {
		const res = await larkClient.im.message.create({
			params: { receive_id_type: "chat_id" },
			data: { receive_id: chatId, msg_type: "interactive", content: buildCard(markdown, header) },
		});
		return res.data?.message_id;
	} catch (err) {
		console.error("[发送卡片失败]", err);
	}
}

// 长消息分片发送
const CARD_MAX = 3800;
async function replyLongMessage(messageId: string, chatId: string, text: string, header?: { title?: string; color?: string }): Promise<void> {
	if (text.length <= CARD_MAX) {
		await replyCard(messageId, text, header);
		return;
	}
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > 0) {
		if (remaining.length <= CARD_MAX) {
			chunks.push(remaining);
			break;
		}
		let cut = remaining.lastIndexOf("\n", CARD_MAX);
		if (cut < CARD_MAX * 0.5) cut = CARD_MAX;
		chunks.push(remaining.slice(0, cut));
		remaining = remaining.slice(cut);
	}
	for (let i = 0; i < chunks.length; i++) {
		const piece = chunks[i];
		if (piece === undefined) continue;
		const h = chunks.length > 1 ? { title: `${header?.title || "回复"} (${i + 1}/${chunks.length})`, color: header?.color } : header;
		if (i === 0) await replyCard(messageId, piece, h);
		else await sendCard(chatId, piece, h);
	}
}

// ── 媒体下载 ─────────────────────────────────────
async function readResponseBuffer(response: unknown, depth = 0): Promise<Buffer> {
	if (depth > 3) throw new Error("readResponseBuffer: 响应嵌套过深");
	if (response instanceof Readable) {
		const chunks: Buffer[] = [];
		for await (const chunk of response) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
		}
		return Buffer.concat(chunks);
	}
	const resp = response as Record<string, unknown>;
	if (typeof (resp as { pipe?: unknown }).pipe === "function") {
		const chunks: Buffer[] = [];
		for await (const chunk of response as Readable) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
		}
		return Buffer.concat(chunks);
	}
	if (typeof resp.writeFile === "function") {
		const tmp = resolve(INBOX_DIR, `.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
		await (resp as { writeFile: (p: string) => Promise<void> }).writeFile(tmp);
		const buf = readFileSync(tmp);
		try { unlinkSync(tmp); } catch {}
		return buf;
	}
	if (Buffer.isBuffer(resp)) return resp;
	if (resp.data && resp.data !== resp) return readResponseBuffer(resp.data, depth + 1);
	throw new Error("无法解析飞书资源响应");
}

async function downloadMedia(
	messageId: string,
	fileKey: string,
	type: "image" | "file",
	ext: string,
): Promise<string> {
	const response = await larkClient.im.messageResource.get({
		path: { message_id: messageId, file_key: fileKey },
		params: { type },
	});
	const buffer = await readResponseBuffer(response);
	const filename = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
	const filepath = resolve(INBOX_DIR, filename);
	writeFileSync(filepath, buffer);
	console.log(`[下载] ${filepath} (${buffer.length} bytes)`);
	return filepath;
}

// ── 语音转文字（火山引擎 → 云端 API → 本地 whisper）──
const WHISPER_MODEL = resolve(HOME, ".cache/whisper-cpp/ggml-tiny.bin");
const WHISPER_BIN = process.env.WHISPER_CLI || "whisper-cli";
const STT_DEBUG = /^(whisper_|ggml_|main:|system_info:|metal_|coreml_|log_)/;

function convertToWav(audioPath: string): string {
	const wavPath = audioPath.replace(/\.[^.]+$/, ".wav");
	execFileSync("ffmpeg", ["-y", "-i", audioPath, "-ar", "16000", "-ac", "1", wavPath], {
		timeout: 30_000,
		stdio: "pipe",
	});
	return wavPath;
}

// 火山引擎豆包大模型 STT（WebSocket 二进制协议）
// 协议文档: https://www.volcengine.com/docs/6561/1354869
const VOLC_STT_URL = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream";
const VOLC_RESOURCE_ID = "volc.bigasr.sauc.duration";

function volcBuildHeader(msgType: number, flags: number, serial: number, compress: number): Buffer {
	const h = Buffer.alloc(4);
	h[0] = 0x11; // protocol v1, header_size = 4 bytes (1×4)
	h[1] = ((msgType & 0xF) << 4) | (flags & 0xF);
	h[2] = ((serial & 0xF) << 4) | (compress & 0xF);
	h[3] = 0x00;
	return h;
}

function volcBuildPacket(header: Buffer, payload: Buffer): Buffer {
	const size = Buffer.alloc(4);
	size.writeUInt32BE(payload.length);
	return Buffer.concat([header, size, payload]);
}

function transcribeVolcengine(wavPath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const connectId = randomUUID();

		const ws = new WebSocket(VOLC_STT_URL, {
			headers: {
				"X-Api-App-Key": config.VOLC_STT_APP_ID,
				"X-Api-Access-Key": config.VOLC_STT_ACCESS_TOKEN,
				"X-Api-Resource-Id": VOLC_RESOURCE_ID,
				"X-Api-Connect-Id": connectId,
			},
		});

		const timer = setTimeout(() => done(new Error("超时 (30s)")), 30_000);

		function done(err: Error | null, text?: string) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try { ws.close(); } catch {}
			if (err) reject(err);
			else resolve(text!);
		}

		ws.on("open", () => {
			// 1) full_client_request: JSON + gzip
			const configPayload = Buffer.from(JSON.stringify({
				user: { uid: "relay-bot" },
				audio: { format: "pcm", rate: 16000, bits: 16, channel: 1 },
				request: { model_name: "bigmodel", enable_itn: true, enable_punc: true, enable_ddc: true },
			}));
			const hdr = volcBuildHeader(0x1, 0x0, 0x1, 0x1);
			ws.send(volcBuildPacket(hdr, gzipSync(configPayload)));

			// 2) audio_only_request: 读 WAV 文件并分包发送 PCM 数据
			const wav = readFileSync(wavPath);
			let pcmOffset = 44;
			for (let i = 12; i + 8 < wav.length;) {
				if (wav.subarray(i, i + 4).toString("ascii") === "data") {
					pcmOffset = i + 8;
					break;
				}
				i += 8 + wav.readUInt32LE(i + 4);
			}
			const pcm = wav.subarray(pcmOffset);
			const CHUNK = 6400; // 200ms @ 16kHz 16-bit mono

			for (let off = 0; off < pcm.length; off += CHUNK) {
				const isLast = off + CHUNK >= pcm.length;
				const chunk = pcm.subarray(off, Math.min(off + CHUNK, pcm.length));
				// flags: 0x2 = last packet, 0x0 = normal; serial: raw(0), compress: gzip(1)
				const aHdr = volcBuildHeader(0x2, isLast ? 0x2 : 0x0, 0x0, 0x1);
				ws.send(volcBuildPacket(aHdr, gzipSync(chunk)));
			}
		});

		ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
			const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
			if (buf.length < 4) return;

			const msgType = (buf.readUInt8(1) >> 4) & 0xF;
			const flags = buf.readUInt8(1) & 0xF;
			const compress = buf.readUInt8(2) & 0xF;

			// 错误响应
			if (msgType === 0xF) {
				let msg = "服务端错误";
				if (buf.length >= 12) {
					const code = buf.readUInt32BE(4);
					const msgLen = buf.readUInt32BE(8);
					msg = `[${code}] ${buf.subarray(12, 12 + Math.min(msgLen, buf.length - 12)).toString("utf-8")}`;
				}
				done(new Error(msg));
				return;
			}

			// 等待最终识别结果（flags bit 1 = 最后一包响应）
			if (msgType === 0x9 && (flags & 0x2)) {
				let off = 4;
				if (flags & 0x1) off += 4; // 跳过 sequence number
				if (off + 4 > buf.length) return;
				const pSize = buf.readUInt32BE(off);
				off += 4;
				if (off + pSize > buf.length) return;

				let payload = buf.subarray(off, off + pSize);
				if (compress === 1) {
					try { payload = gunzipSync(payload); } catch { done(new Error("解压响应失败")); return; }
				}
				try {
					const json = JSON.parse(payload.toString("utf-8"));
					const text = json?.result?.text?.trim();
					if (text) done(null, text);
					else done(new Error("识别结果为空"));
				} catch {
					done(new Error("解析响应 JSON 失败"));
				}
			}
		});

		ws.on("unexpected-response", (_req: unknown, res: { statusCode?: number }) => {
			done(new Error(`HTTP ${res.statusCode ?? "unknown"} (WebSocket 升级被拒)`));
		});
		ws.on("error", (err: Error) => done(new Error(`WebSocket: ${err.message}`)));
		ws.on("close", () => { if (!settled) done(new Error("连接意外断开")); });
	});
}

function transcribeLocal(wavPath: string): string | null {
	if (!existsSync(WHISPER_MODEL)) return null;
	try {
		const result = execFileSync(
			WHISPER_BIN,
			["--model", WHISPER_MODEL, "--language", "zh", "--no-timestamps", wavPath],
			{ timeout: 120_000, encoding: "utf-8", stdio: "pipe" },
		);
		const transcript = result
			.split("\n")
			.filter((l: string) => !STT_DEBUG.test(l) && l.trim())
			.join(" ")
			.trim();
		return transcript || null;
	} catch (err) {
		console.error("[STT 本地失败]", err instanceof Error ? err.message : err);
		return null;
	}
}

async function transcribeAudio(audioPath: string): Promise<string | null> {
	let wavPath: string | undefined;
	try {
		wavPath = convertToWav(audioPath);

		// 火山引擎豆包大模型（含重试）→ 本地 whisper 兜底
		if (config.VOLC_STT_APP_ID && config.VOLC_STT_ACCESS_TOKEN) {
			const maxRetries = 3;
			for (let attempt = 1; attempt <= maxRetries; attempt++) {
				try {
					const text = await transcribeVolcengine(wavPath);
					console.log(`[STT 火山引擎] 成功 (${text.length} chars, 第${attempt}次)`);
					return text;
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					console.warn(`[STT 火山引擎] 第${attempt}/${maxRetries}次失败: ${msg}`);
					if (attempt < maxRetries) {
						console.log(`[STT 火山引擎] 500ms 后重试...`);
						await new Promise((r) => setTimeout(r, 500));
					}
				}
			}
			console.warn("[STT 火山引擎] 重试耗尽，降级本地 whisper");
		}

		const local = transcribeLocal(wavPath);
		if (local) console.log(`[STT 本地] 成功 (${local.length} chars)`);
		else console.warn("[STT] 所有引擎均不可用");
		return local;
	} catch (err) {
		console.error("[STT 转码失败]", err instanceof Error ? err.message : err);
		return null;
	} finally {
		if (wavPath) try { unlinkSync(wavPath); } catch {}
	}
}

// ── 消息解析 ─────────────────────────────────────
function parseContent(
	messageType: string,
	content: string,
): { text: string; imageKey?: string; imageKeys?: string[]; fileKey?: string; fileName?: string } {
	try {
		const p = JSON.parse(content);
		switch (messageType) {
			case "text":
				return { text: p.text || "" };
			case "image":
				return { text: "", imageKey: p.image_key };
			case "audio":
				return { text: "", fileKey: p.file_key };
			case "file":
				return { text: "", fileKey: p.file_key, fileName: p.file_name };
		case "post": {
			const texts: string[] = [];
			const images: string[] = [];
			
			// 直接处理 post 对象（不是多语言结构）
			if (p.title) texts.push(p.title);
			if (Array.isArray(p.content)) {
				for (const para of p.content) {
					for (const e of para) {
						if (e.tag === "text" && e.text) texts.push(e.text);
						if (e.tag === "img" && e.image_key) images.push(e.image_key);
					}
				}
			}
			
			return { 
				text: texts.join(" "), 
				imageKeys: images.length > 0 ? images : undefined
			};
		}
			default:
				return { text: `[不支持: ${messageType}]` };
		}
	} catch {
		return { text: content };
	}
}

// ── ANSI 清理 ────────────────────────────────────
function strip(s: string): string {
	return s
		.replace(/\x1b\][^\x07]*\x07/g, "")
		.replace(/\x1b\][^\x1b]*\x1b\\/g, "")
		.replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, "")
		.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
		.replace(/\x1b[=>MNOZ78]/g, "")
		.replace(/\r/g, "")
		.trim();
}

// ── 对话式路由识别 ───────────────────────────────
interface RouteIntent {
	type: 'switch' | 'temp' | 'suggest' | 'none';  // switch=持久切换, temp=临时路由, suggest=建议切换, none=无路由
	project?: string;  // 项目名
	path?: string;  // 任意路径（用于临时切换）
	confidence?: 'high' | 'medium' | 'low';  // 识别信心度
	cleanedText: string;  // 移除路由信息后的文本
}

/**
 * 识别对话式路由意图
 * 支持：
 * - "切换到 activity 项目" / "现在用 api" → 持久切换
 * - "帮我看看 activity 项目的代码" / "在 api 里查个 bug" → 临时路由
 * - "#activity 消息" / "@api 消息" → 临时路由（简化符号）
 * - "切换到 /path/to/project" → 临时切换到任意路径
 * - "#/path/to/project 消息" → 快捷路径语法
 */
function detectRouteIntent(text: string): RouteIntent {
	const raw = (text || '').trim().replace(/\s+/g, ' ');  // 归一化空格（含全角）
	const { projects } = projectsConfig;
	const projectNames = Object.keys(projects);
	// 按长度降序排列，避免前缀冲突（如 remote-control 被 remote 误匹配）
	const sortedNames = projectNames.sort((a, b) => b.length - a.length);
	const projectPattern = sortedNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
	
	// 0. 路径快捷语法：#/path 或 @/path
	const pathSymbolMatch = raw.match(/^[#@]((?:~?\/|~).+?)\s+(.+)$/);
	if (pathSymbolMatch) {
		const rawPath = pathSymbolMatch[1];
		const rest = pathSymbolMatch[2];
		if (rawPath === undefined || rest === undefined) {
			return { type: 'none' as const, cleanedText: text };
		}
		const absolutePath = rawPath.startsWith('~') 
			? rawPath.replace(/^~/, process.env.HOME || '~')
			: rawPath;
		return {
			type: 'temp',
			path: absolutePath,
			cleanedText: rest.trim(),
		};
	}
	
	// 1. 简化符号：#项目名 或 @项目名
	const symbolMatch = raw.match(new RegExp(`^[#@](${projectPattern})\\s+(.+)`, 'i'));
	if (symbolMatch) {
		const symProj = symbolMatch[1];
		const symRest = symbolMatch[2];
		if (symProj === undefined || symRest === undefined) {
			return { type: 'none' as const, cleanedText: text };
		}
		const project = symProj.toLowerCase();
		if (projects[project]) {
			return {
				type: 'temp',
				project,
				cleanedText: symRest.trim(),
			};
		}
	}
	
	// 2a. 切换到任意路径："切换到 /path" / "切换到路径 /path"（必须以 / 或 ~ 开头，避免误匹配 "切换到 remote"）
	const pathSwitchMatch = raw.match(/^(?:切换到|切到|切换|进入|打开)(?:路径)?\s+([~\/].+?)\s*$/i);
	if (pathSwitchMatch) {
		const p1 = pathSwitchMatch[1];
		if (p1 === undefined) {
			return { type: 'none' as const, cleanedText: text };
		}
		const absolutePath = p1.startsWith('~')
			? p1.replace(/^~/, process.env.HOME || '~')
			: p1;
		return {
			type: 'switch',
			path: absolutePath,
			cleanedText: '',
		};
	}
	
	// 2b. 持久切换到项目："切换到 XXX" / "切到 XXX" / "现在用 XXX" / "改成 XXX 项目"
	const switchPatterns = [
		new RegExp(`^(?:切换到|切到|切换|现在用|改成|使用)\\s*(${projectPattern})(?:\\s*项目)?\\s*$`, 'i'),
		new RegExp(`^(?:进入|打开)\\s*(${projectPattern})(?:\\s*项目)?\\s*$`, 'i'),
	];
	for (const pattern of switchPatterns) {
		const match = raw.match(pattern);
		if (match) {
			const m1 = match[1];
			if (m1 === undefined) continue;
			const project = m1.toLowerCase();
			if (projects[project]) {
				return { type: 'switch', project, cleanedText: '' };
			}
		}
	}
	
	// 3. 临时路由："帮我看看 XXX 项目" / "在 XXX 里查" / "XXX 项目有个 bug"
	const tempPatterns = [
		new RegExp(`(?:看看|查查|分析|检查)\\s*(${projectPattern})(?:项目)?(?:的|里|中)?`, 'i'),
		new RegExp(`在\\s*(${projectPattern})(?:项目)?(?:里|中)`, 'i'),
		new RegExp(`(${projectPattern})(?:项目)?(?:有|出现|发现)`, 'i'),
	];
	for (const pattern of tempPatterns) {
		const match = raw.match(pattern);
		if (match) {
			const m1 = match[1];
			if (m1 === undefined) continue;
			const project = m1.toLowerCase();
			if (projects[project]) {
				// 不移除项目名，保留完整语境
				return { type: 'temp', project, cleanedText: text };
			}
		}
	}
	
	// 4. 宽松识别（建议切换）："activity 报错了" / "查看 api" / "user 服务的代码"
	// 只在开关开启时启用（默认开启，设置为 'false' 关闭）
	const smartDetection = process.env.SMART_PROJECT_DETECTION !== 'false';
	if (smartDetection) {
		const suggestPatterns = [
			// "activity 报错了" / "api 挂了" / "api服务是否正常"
			new RegExp(`^(${projectPattern})(?:\\s+服务|服务)?\\s*(?:报错|出错|挂了|崩了|有问题|异常|故障|是否正常|正常吗|正常么|怎么样|如何)`, 'i'),
			
			// "查看 activity" / "看看 api"
			new RegExp(`^(?:查看|看看|检查|分析|打开)\\s+(${projectPattern})(?:\\s+服务|服务)?(?:$|\\s)`, 'i'),
			
			// "activity 接口定义" / "api 的配置" / "user 服务的日志"
			new RegExp(`^(${projectPattern})(?:\\s+服务|服务)?\\s*(?:接口|API|代码|配置|日志|监控|数据库|缓存|的)`, 'i'),
			
			// "去 activity 看看"
			new RegExp(`^(?:去|到)\\s+(${projectPattern})(?:\\s+服务|服务)?\\s+(?:看看|查查|找找|改改)`, 'i'),
			
			// "activity 项目的" / "api 那边"
			new RegExp(`^(${projectPattern})(?:\\s+服务|服务)?\\s*(?:项目)?(?:的|那边|这边|里面)`, 'i'),
		];
		
		for (const pattern of suggestPatterns) {
			const match = raw.match(pattern);
			if (match) {
				const m1 = match[1];
				if (m1 === undefined) continue;
				const project = m1.toLowerCase();
				if (projects[project]) {
					return { 
						type: 'suggest',
						project, 
						confidence: 'medium',
						cleanedText: text 
					};
				}
			}
		}
	}
	
	return { type: 'none', cleanedText: text };
}

// ── 项目路由 ─────────────────────────────────────
function route(
	text: string,
	currentProject?: string,
	intent?: RouteIntent
): { workspace: string; prompt: string; label: string; routeChanged?: boolean; intent: RouteIntent } {
	const { projects, default_project } = projectsConfig;
	
	// 1. 传统路由：项目名:消息
	const colonMatch = text.match(/^(\S+?)[:\uff1a]\s*(.+)/s);
	const colonKey = colonMatch?.[1];
	const colonRest = colonMatch?.[2];
	if (colonKey && colonRest && projects[colonKey.toLowerCase()]) {
		const key = colonKey.toLowerCase();
		const projEntry = projects[key];
		if (!projEntry) {
			// 理论上与上一行条件一致；满足 strict 收窄
			return {
				workspace: projects[default_project]?.path || ROOT,
				prompt: text.trim(),
				label: default_project,
				intent: intent || { type: "none", cleanedText: text.trim() },
			};
		}
		return {
			workspace: projEntry.path,
			prompt: colonRest.trim(),
			label: key,
			routeChanged: true,
			intent: intent || { type: 'none', cleanedText: colonRest.trim() },
		};
	}
	
	// 2. 对话式路由（使用传入的 intent，避免重复检测）
	const routeIntent = intent || detectRouteIntent(text);
	
	// 2a. 路径型路由（临时切换到任意目录）
	if (routeIntent.type !== 'none' && routeIntent.path) {
		const pathLabel = routeIntent.path.split('/').pop() || routeIntent.path;
		return {
			workspace: routeIntent.path,
			prompt: routeIntent.cleanedText || text,
			label: `📁${pathLabel}`,
			routeChanged: routeIntent.type === 'switch',
			intent: routeIntent,
		};
	}
	
	// 2b. 项目名路由（排除 suggest 类型，suggest 需要用户确认）
	if (routeIntent.type !== 'none' && routeIntent.type !== 'suggest' && routeIntent.project) {
		const rp = projects[routeIntent.project];
		if (!rp) {
			return {
				workspace: projects[default_project]?.path || ROOT,
				prompt: text.trim(),
				label: default_project,
				intent: routeIntent,
			};
		}
		return {
			workspace: rp.path,
			prompt: routeIntent.cleanedText || text,
			label: routeIntent.project,
			routeChanged: routeIntent.type === 'switch',
			intent: routeIntent,
		};
	}
	
	// 3. 使用当前项目（如果有）
	if (currentProject && projects[currentProject]) {
		return {
			workspace: projects[currentProject].path,
			prompt: text.trim(),
			label: currentProject,
			intent: routeIntent,
		};
	}
	
	// 4. 默认项目
	return {
		workspace: projects[default_project]?.path || ROOT,
		prompt: text.trim(),
		label: default_project,
		intent: routeIntent,
	};
}

// ── 可选模型列表 ─────────────────────────────────
// ── 模型自动降级 ─────────────────────────────────
// 每次请求都先试首选模型，失败再用 auto 重试
const BILLING_PATTERNS = [
	/unpaid invoice/i,
	/pay your invoice/i,
	/resume requests/i,
	/billing/i,
	/insufficient.*(balance|credit|fund|quota)/i,
	/exceeded.*limit/i,
	/payment.*required/i,
	/out of credits/i,
	/usage.*limit.*exceeded/i,
	/subscription.*expired/i,
	/plan.*expired/i,
	/402/,
	/费用不足/,
	/余额不足/,
	/额度/,
];

function isBillingError(text: string): boolean {
	return BILLING_PATTERNS.some((p) => p.test(text));
}

// Agent 全局超时时间（30分钟），防止长时间任务卡死
// 大多数任务在 30 分钟内完成，极少数复杂任务可能需要更长时间
// 如需更长时间，可通过 /终止 后重新提问或分批处理
const MAX_AGENT_TIMEOUT = 30 * 60 * 1000; // 30分钟

// 统一 Agent 执行器（超时保护、并发限制、僵尸清理）
const agentExecutor = new AgentExecutor({
	timeout: MAX_AGENT_TIMEOUT,
	maxConcurrent: 10,
});

// 优雅退出
process.on("SIGINT", async () => {
	console.log("\n[退出] 正在清理资源...");

	// 终止所有运行中的 Agent 进程
	const active = agentExecutor.getActiveAgents();
	if (active.length > 0) {
		console.log(`[退出] 正在终止 ${active.length} 个运行中的任务...`);
		agentExecutor.killAll();
		busySessions.clear();
	}

	// 停止文件监听器
	unwatchFile(ENV_PATH);
	unwatchFile(PROJECTS_PATH);
	unwatchFile(SESSIONS_PATH);
	console.log("[退出] 文件监听器已停止");

	// 停止心跳和定时任务
	heartbeat.stop();
	scheduler.stop();

	// 关闭记忆系统
	if (memory) {
		try {
			memory.close();
			console.log("[退出] 记忆系统已关闭");
		} catch (err) {
			console.error("[退出] 记忆系统关闭失败:", err);
		}
	}

	// 断开飞书连接
	try {
		if (typeof (ws as any).close === 'function') {
			(ws as any).close();
		}
		console.log("[退出] 飞书连接已断开");
	} catch (err) {
		console.error("[退出] 断开连接失败:", err);
	}

	console.log("[退出] 清理完成，再见！");
	process.exit(0);
});

process.on("SIGTERM", () => {
	console.log("[退出] 收到 SIGTERM");
	process.exit(0);
});

// ── Agent 执行引擎（直接 spawn CLI + stream-json）──
const PROGRESS_INTERVAL = 2_000;

interface AgentProgress {
	elapsed: number;
	phase: "thinking" | "tool_call" | "responding";
	snippet: string;
}

function formatElapsed(seconds: number): string {
	if (seconds < 60) return `${seconds}秒`;
	const mins = Math.floor(seconds / 60);
	const secs = seconds % 60;
	if (mins < 60) return secs > 0 ? `${mins}分${secs}秒` : `${mins}分`;
	const hrs = Math.floor(mins / 60);
	return `${hrs}时${mins % 60}分`;
}

// ── 时间格式化 ───────────────────────────────────
function formatRelativeTime(ms: number): string {
	const diff = Date.now() - ms;
	if (diff < 60_000) return "刚刚";
	if (diff < 3600_000) return `${Math.floor(diff / 60_000)}分钟前`;
	if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}小时前`;
	if (diff < 604800_000) return `${Math.floor(diff / 86400_000)}天前`;
	return new Date(ms).toLocaleDateString("zh-CN");
}

// ── 会话管理（支持历史列表 + 切换）─────────────────
const SESSIONS_PATH = resolve(import.meta.dirname, ".sessions.json");
const MAX_SESSION_HISTORY = 20;

interface SessionEntry {
	id: string;
	createdAt: number;
	lastActiveAt: number;
	summary: string;
}

interface WorkspaceSessions {
	active: string | null;
	history: SessionEntry[];
	currentProject?: string;  // 当前项目（对话式路由持久切换）
	pendingProjectSwitches?: Record<string, {  // 待确认的项目切换（按 chatId 隔离）
		suggestedProject: string;
		currentProject: string;
		originalMessage: string;
		originalMessageType: string;
		originalContent: string;
		messageId: string;
		chatId: string;
		createdAt: number;  // 创建时间，用于超时清理
	}>;
}

const sessionsStore: Map<string, WorkspaceSessions> = new Map();

function loadSessionsFromDisk(): void {
	try {
		if (!existsSync(SESSIONS_PATH)) return;
		const raw = JSON.parse(readFileSync(SESSIONS_PATH, "utf-8"));
		sessionsStore.clear();
		for (const [k, v] of Object.entries(raw)) {
			if (typeof v === "string") {
				sessionsStore.set(k, {
					active: v,
					history: [{ id: v, createdAt: Date.now(), lastActiveAt: Date.now(), summary: "(旧会话)" }],
				});
			} else {
				sessionsStore.set(k, v as WorkspaceSessions);
			}
		}
		console.log(`[Session] 从磁盘恢复 ${sessionsStore.size} 个工作区会话`);
	} catch {}
}

let sessionsSaving = false;

function saveSessions(): void {
	try {
		sessionsSaving = true;
		writeFileSync(SESSIONS_PATH, JSON.stringify(Object.fromEntries(sessionsStore), null, 2));
	} catch {} finally {
		setTimeout(() => { sessionsSaving = false; }, 500);
	}
}

loadSessionsFromDisk();

watchFile(SESSIONS_PATH, { interval: 3000 }, () => {
	if (sessionsSaving) return;
	try {
		loadSessionsFromDisk();
	} catch {}
});

function getActiveSessionId(workspace: string): string | undefined {
	return sessionsStore.get(workspace)?.active || undefined;
}

function getCurrentProject(workspace: string): string | undefined {
	return sessionsStore.get(workspace)?.currentProject;
}

function setCurrentProject(workspace: string, project: string): void {
	let ws = sessionsStore.get(workspace);
	if (!ws) {
		ws = { active: null, history: [] };
		sessionsStore.set(workspace, ws);
	}
	ws.currentProject = project;
	saveSessions();
}

function setActiveSession(workspace: string, sessionId: string, summary?: string): void {
	let ws = sessionsStore.get(workspace);
	if (!ws) {
		ws = { active: null, history: [] };
		sessionsStore.set(workspace, ws);
		saveSessions();  // Bug #51 修复: 持久化新创建的session
	}

	const existing = ws.history.find((h) => h.id === sessionId);
	if (existing) {
		existing.lastActiveAt = Date.now();
		if (summary && existing.summary === "(新会话)") {
			existing.summary = summary;
		}
	} else {
		ws.history.unshift({
			id: sessionId,
			createdAt: Date.now(),
			lastActiveAt: Date.now(),
			summary: summary || "(新会话)",
		});
	}

	if (ws.history.length > MAX_SESSION_HISTORY) {
		ws.history = ws.history.slice(0, MAX_SESSION_HISTORY);
	}

	ws.active = sessionId;
	saveSessions();
}

function updateSessionSummary(workspace: string, sessionId: string, summary: string): void {
	const ws = sessionsStore.get(workspace);
	if (!ws) return;
	const entry = ws.history.find((h) => h.id === sessionId);
	if (entry) {
		entry.summary = summary;
		saveSessions();
	}
}

function generateSessionTitleFallback(prompt: string, result: string): string {
	const noise = /^(帮我|请你?|麻烦|你好|嗨|hi|hello|hey|ok|好的|嗯|哦)[，,。.！!？?\s]*/gi;
	const cleaned = prompt.replace(noise, "").trim();

	if (cleaned.length >= 4 && cleaned.length <= 40) return cleaned;
	if (cleaned.length > 40) {
		const cutoff = cleaned.slice(0, 40);
		const lastPunct = Math.max(
			cutoff.lastIndexOf("，"), cutoff.lastIndexOf("。"),
			cutoff.lastIndexOf("；"), cutoff.lastIndexOf(","),
			cutoff.lastIndexOf(" "),
		);
		return (lastPunct > 15 ? cutoff.slice(0, lastPunct) : cutoff) + "…";
	}
	const firstLine = result.split("\n").find((l) => {
		const t = l.replace(/^[#*>\-\s]+/, "").trim();
		return t.length >= 4 && !t.startsWith("```") && !t.startsWith("HEARTBEAT");
	});
	if (firstLine) {
		const t = firstLine.replace(/^[#*>\-\s]+/, "").replace(/\*\*/g, "").trim();
		return t.length <= 40 ? t : t.slice(0, 38) + "…";
	}
	return cleaned || prompt.slice(0, 30) || "(对话)";
}

async function generateSessionTitle(workspace: string, sessionId: string, prompt: string, result: string): Promise<void> {
	const fallback = generateSessionTitleFallback(prompt, result);
	try {
		const context = `用户: ${prompt.slice(0, 200)}\n\nAI回复摘要: ${result.slice(0, 500)}`;
		const titlePrompt = `根据以下对话，生成一个简短的中文标题。要求：必须使用中文，4-20个字，不加标点，不加引号，不加书名号，直接输出标题，不要输出任何其它内容。\n\n${context}`;
		const child = spawn(AGENT_BIN, [
			"-p", "--force", "--trust",
			"--model", "auto",
			"--output-format", "text",
			"--", titlePrompt,
		], {
			env: { ...process.env, CURSOR_API_KEY: config.CURSOR_API_KEY },
			stdio: ["ignore", "pipe", "pipe"],
		});

		const title = await new Promise<string>((resolve) => {
			let out = "";
			const timeout = setTimeout(() => { child.kill(); resolve(fallback); }, 15_000);
			child.stdout!.on("data", (c: Buffer) => { out += c.toString(); });
			child.on("close", () => {
				clearTimeout(timeout);
				const raw = out.trim().split("\n").pop()?.trim() || "";
				const clean = raw.replace(/^["'「《]|["'」》]$/g, "").replace(/[。.！!？?]$/, "").trim();
				resolve(clean.length >= 2 && clean.length <= 30 ? clean : fallback);
			});
			child.on("error", () => { clearTimeout(timeout); resolve(fallback); });
		});

		updateSessionSummary(workspace, sessionId, title);
		console.log(`[Session] LLM 命名: ${title}`);
	} catch {
		updateSessionSummary(workspace, sessionId, fallback);
		console.log(`[Session] 降级命名: ${fallback}`);
	}
}

function archiveAndResetSession(workspace: string): void {
	const ws = sessionsStore.get(workspace);
	if (ws?.active) {
		ws.active = null;
		saveSessions();
		console.log(`[Session ${workspace}] 已归档并重置`);
	}
}

function switchToSession(workspace: string, sessionId: string): boolean {
	const ws = sessionsStore.get(workspace);
	if (!ws) return false;
	const entry = ws.history.find((h) => h.id === sessionId);
	if (!entry) return false;
	ws.active = sessionId;
	entry.lastActiveAt = Date.now();
	saveSessions();
	return true;
}

function getSessionHistory(workspace: string, limit = 10): SessionEntry[] {
	const ws = sessionsStore.get(workspace);
	if (!ws) return [];
	return [...ws.history]
		.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
		.slice(0, limit);
}

// 同一 session 的消息串行执行；不同 session（即使同工作区）可并行
const sessionLocks = new Map<string, Promise<void>>();
const sessionQueueDepth = new Map<string, number>(); // 追踪每个 session 的排队深度
const MAX_QUEUE_DEPTH = 10; // 最多允许 10 个任务排队（避免多发消息触发限制）

async function withSessionLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
	// 先设置好 release，避免提前抛异常导致 finally 中 release 未定义
	let release!: () => void;
	const next = new Promise<void>((r) => { release = r; });
	let depthIncremented = false;
	
	try {
		// 检查排队深度
		const currentDepth = sessionQueueDepth.get(lockKey) || 0;
		if (currentDepth >= MAX_QUEUE_DEPTH) {
			throw new Error(`⚠️ 同会话有 ${currentDepth} 个任务排队，请等待前面的任务完成后再试。\n\n💡 建议：\n- 使用 /终止 停止当前任务\n- 或者使用 /新对话 开始新会话`);
		}
		
		// 增加排队计数
		sessionQueueDepth.set(lockKey, currentDepth + 1);
		depthIncremented = true;
		
		const prev = sessionLocks.get(lockKey) || Promise.resolve();
		sessionLocks.set(lockKey, next);
		
		await prev;
		return await fn();
	} finally {
		release();
		// 只有成功增加了计数才需要减少
		if (depthIncremented) {
			const depth = sessionQueueDepth.get(lockKey) || 0;
			if (depth <= 1) {
				sessionQueueDepth.delete(lockKey);
				sessionLocks.delete(lockKey);
			} else {
				sessionQueueDepth.set(lockKey, depth - 1);
			}
		}
	}
}

function getLockKey(workspace: string): string {
	const sid = getActiveSessionId(workspace);
	return sid ? `session:${sid}` : `ws:${workspace}`;
}

/** 规范化空白便于比较重复 */
function normalizeForDedupe(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

/** 去除单条消息内的重复内容（流式/result 双写导致同一段话出现两次） */
function dedupeRepeatedContent(text: string): string {
	const s = text.trim();
	if (s.length < 20) return text;

	// 1. 整段恰好两半相同：只保留一半
	const half = Math.floor(s.length / 2);
	const firstHalf = s.slice(0, half);
	const secondHalf = s.slice(half);
	if (firstHalf === secondHalf) return firstHalf;
	if (firstHalf === secondHalf.trim() || firstHalf.trim() === secondHalf) return firstHalf;
	if (normalizeForDedupe(firstHalf) === normalizeForDedupe(secondHalf) && firstHalf.length >= 30) return firstHalf;

	// 2. 末尾一整段与前面某段完全相同（按双换行分块）：去掉末尾重复块
	const blocks = s.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
	if (blocks.length >= 2) {
		const lastBlock = blocks[blocks.length - 1];
		if (lastBlock !== undefined && lastBlock.length >= 30) {
			const rest = blocks.slice(0, -1);
			if (rest.some((b) => b === lastBlock || (b.length > 50 && lastBlock.includes(b.slice(0, 80))))) {
				return rest.join("\n\n");
			}
			if (rest.some((b) => normalizeForDedupe(b) === normalizeForDedupe(lastBlock))) {
				return rest.join("\n\n");
			}
		}
	}

	// 3. 后半段与前半段几乎相同（仅首尾空白或换行差异）：只保留前半段
	const secondHalfNorm = secondHalf.replace(/\s+$/, "").replace(/^\s+/, "");
	const firstHalfNorm = firstHalf.replace(/\s+$/, "").replace(/^\s+/, "");
	if (secondHalfNorm.length >= 30 && firstHalfNorm === secondHalfNorm) return firstHalf;
	if (secondHalfNorm.length >= 30 && normalizeForDedupe(firstHalf) === normalizeForDedupe(secondHalf)) return firstHalf;

	// 4. 整段是同一内容重复 N 次（如 3 段相同）：只保留一段
	const third = Math.floor(s.length / 3);
	if (third >= 20) {
		const t1 = s.slice(0, third);
		const t2 = s.slice(third, 2 * third);
		const t3 = s.slice(2 * third);
		if (t1 === t2 && (t2 === t3.trim() || t2.trim() === t3)) return t1;
		if (normalizeForDedupe(t1) === normalizeForDedupe(t2) && normalizeForDedupe(t2) === normalizeForDedupe(t3)) return t1;
	}

	// 5. 单条内「前半段 + 换行 + 前半段」形式（流式结尾再发一整段）：只保留一段
	const singleNewlineSplit = s.split(/\n/);
	if (singleNewlineSplit.length >= 2) {
		const mid = Math.floor(singleNewlineSplit.length / 2);
		const firstPart = singleNewlineSplit.slice(0, mid).join("\n").trim();
		const secondPart = singleNewlineSplit.slice(mid).join("\n").trim();
		if (firstPart.length >= 40 && secondPart.length >= 40 && normalizeForDedupe(firstPart) === normalizeForDedupe(secondPart)) {
			return firstPart;
		}
	}

	return text;
}

// 解析一行 stream-json 输出
interface StreamEvent {
	type: string;
	subtype?: string;
	session_id?: string;
	text?: string;
	result?: string;
	error?: string;
	message?: { role: string; content: Array<{ type: string; text?: string }> };
	tool_name?: string;
	tool_call_id?: string;
	call_id?: string;
	tool_call?: Record<string, { args?: Record<string, unknown>; result?: Record<string, { content?: string }> }>;
}

function tryParseJson(line: string): StreamEvent | null {
	const trimmed = line.trim();
	if (!trimmed || !trimmed.startsWith("{")) return null;
	try { return JSON.parse(trimmed); } catch { return null; }
}

const TOOL_LABELS: Record<string, string> = {
	read: "📖 读取", write: "✏️ 写入", strReplace: "✏️ 编辑",
	shell: "⚡ 执行", grep: "🔍 搜索", glob: "📂 查找",
	semanticSearch: "🔎 语义搜索", webSearch: "🌐 搜索网页", webFetch: "🌐 抓取网页",
	delete: "🗑️ 删除", editNotebook: "📓 编辑笔记本",
	callMcpTool: "🔌 MCP工具", task: "🤖 子任务",
};

function describeToolCall(tc: Record<string, { args?: Record<string, unknown> }>): string {
	for (const [key, val] of Object.entries(tc)) {
		const name = key.replace(/ToolCall$/, "");
		const label = TOOL_LABELS[name] || `🔧 ${name}`;
		const a = val?.args;
		if (!a) return label;
		if (a.path) return `${label} ${basename(String(a.path))}`;
		if (a.command) return `${label} ${String(a.command).slice(0, 80)}`;
		if (a.pattern) return `${label} "${a.pattern}"${a.path ? ` in ${basename(String(a.path))}` : ""}`;
		if (a.glob_pattern) return `${label} ${a.glob_pattern}`;
		if (a.query) return `${label} ${String(a.query).slice(0, 60)}`;
		if (a.search_term) return `${label} ${String(a.search_term).slice(0, 60)}`;
		if (a.url) return `${label} ${String(a.url).slice(0, 60)}`;
		if (a.description) return `${label} ${String(a.description).slice(0, 60)}`;
		return label;
	}
	return "🔧 工具调用";
}

function describeToolResult(tc: Record<string, { args?: Record<string, unknown>; result?: Record<string, { content?: string }> }>): string {
	for (const val of Object.values(tc)) {
		const r = val?.result;
		if (!r) return "";
		const success = r.success as Record<string, unknown> | undefined;
		if (success?.content) return String(success.content).slice(0, 200);
		const err = r.error as Record<string, unknown> | undefined;
		if (err?.message) return `❌ ${String(err.message).slice(0, 150)}`;
	}
	return "";
}

function basename(p: string): string {
	const parts = p.split("/");
	return parts[parts.length - 1] || p;
}

// 构建工具调用摘要（可折叠）
function buildToolSummary(tools: string[]): string {
	if (tools.length === 0) return "";
	
	// 按工具类型分组，保留所有详细信息
	const groups = new Map<string, { emoji: string; items: string[] }>();
	
	for (const tool of tools) {
		const match = tool.match(/^([🔧📖✏️⚡🔍📂🔎🌐🗑️📓🔌🤖]+)\s+(.+)/);
		if (!match) continue;
		const emoji = match[1];
		const detail = match[2];
		if (emoji === undefined || detail === undefined) continue;
		
		if (!groups.has(emoji)) {
			groups.set(emoji, { emoji, items: [] });
		}
		groups.get(emoji)!.items.push(detail);
	}
	
	// 生成详细列表
	const lines: string[] = ['> 📋 **本次操作：**'];
	for (const { emoji, items } of groups.values()) {
		const label = Object.values(TOOL_LABELS).find(l => l.startsWith(emoji))?.replace(/^.+?\s/, '') || '操作';
		lines.push(`> ${emoji} **${label}** (${items.length}个)：`);
		for (const item of items) {
			lines.push(`>   · ${item}`);
		}
	}
	
	return lines.join('\n');
}

// ── 带 Fallback 的 Agent 执行包装器 ──────────────
async function execAgentWithFallback(
	lockKey: string,
	workspace: string,
	primaryModel: string,
	prompt: string,
	opts?: {
		sessionId?: string;
		onProgress?: (p: AgentProgress) => void;
		context?: { platform?: string; chatId?: string };
		feedbackGate?: { chatId?: string; platform?: string; enabledModel?: string };
		onFeedbackRequested?: (req: FeedbackGateRequest) => void;
	},
): Promise<{ result: string; sessionId?: string; usedFallback?: boolean; fallbackModel?: string; errorMsg?: string }> {
	// 获取可用模型链（自动过滤黑名单）
	const modelChain = getAvailableModelChain(primaryModel);
	if (modelChain.length === 0) {
		// 所有模型都在黑名单中
		throw new Error(`所有模型都已配额用尽（包括 auto 模型）。\n\n请稍后再试，或在每月1号后重新使用。`);
	}

	// 按顺序尝试模型链
	let lastError: Error | null = null;
	const skippedModels: string[] = [];
	
	// 检查主模型是否被跳过（黑名单）
	const wasBlacklisted = isBlacklisted(primaryModel);
	if (wasBlacklisted) {
		skippedModels.push(primaryModel);
		console.log(`[智能跳过] ${primaryModel} 在黑名单中，静默切换到 ${modelChain[0]?.id}`);
	}
	
	for (let i = 0; i < modelChain.length; i++) {
		const model = modelChain[i];
		if (!model) continue;
		
		const isFallback = i > 0 || skippedModels.length > 0;
		
		try {
			if (isFallback && !wasBlacklisted) {
				console.log(`[Fallback ${i}/${modelChain.length - 1}] 尝试 ${model.id}（原模型：${primaryModel}）`);
			}
			
			const out = await execAgent(lockKey, workspace, model.id, prompt, opts);
			
			// 成功执行
			if (isFallback) {
				// 如果是因为黑名单跳过的，静默切换，不提示
				if (wasBlacklisted && i === 0) {
					return out;
				}
				
				// 如果是运行中失败导致的 fallback，返回错误信息（用于显示提示）
				return { 
					...out, 
					usedFallback: true, 
					fallbackModel: model.id,
					errorMsg: lastError?.message || '',
				};
			}
			
			return out;
		} catch (error) {
			lastError = error as Error;
			
			// 检查是否为配额用尽错误，是则加入黑名单
			if (isQuotaExhausted(lastError)) {
				addToBlacklist(model.id);
			}
			
			const shouldRetry = shouldFallback(lastError);
			
			if (!shouldRetry || i === modelChain.length - 1) {
				// 不应重试，或已是最后一个模型
				console.error(`[失败] 模型 ${model.id} 执行失败，无更多 fallback`, lastError.message);
				throw error;
			}
			
			// 记录失败，继续尝试下一个
			console.warn(`[失败] 模型 ${model.id} 失败: ${lastError.message.slice(0, 200)}`);
		}
	}

	// 所有模型都失败
	throw new Error(`所有模型都失败了（尝试了 ${modelChain.map(m => m.id).join(' → ')}）\n最后错误: ${lastError?.message || '未知错误'}`);
}

// 核心：spawn agent CLI，解析 stream-json，返回结果（使用统一执行器）
async function execAgent(
	lockKey: string,
	workspace: string,
	model: string,
	prompt: string,
	opts?: {
		sessionId?: string;
		onProgress?: (p: AgentProgress) => void;
		context?: { platform?: string; chatId?: string };
		feedbackGate?: { chatId?: string; platform?: string; enabledModel?: string };
		onFeedbackRequested?: (req: FeedbackGateRequest) => void;
	},
): Promise<{ result: string; sessionId?: string }> {
	try {
		const chatId = opts?.context?.chatId;
		
		const result = await agentExecutor.execute({
			workspace,
			model,
			prompt,
			sessionId: opts?.sessionId,
			platform: opts?.context?.platform as 'feishu' | undefined,
			webhook: chatId,
			onProgress: opts?.onProgress,
			apiKey: config.CURSOR_API_KEY,
			feedbackGate: opts?.feedbackGate,
			onFeedbackRequested: opts?.onFeedbackRequested,
		});
		
		// 构建工具调用摘要（添加到回复开头）
		let finalOutput = result.result;
		console.log(`[execAgent] result.result type=${typeof result.result} len=${result.result?.length ?? 'N/A'} sessionId=${result.sessionId}`);
		if (result.toolSummary && result.toolSummary.length > 0) {
			const summary = buildToolSummary(result.toolSummary);
			if (summary) {
				finalOutput = summary + "\n\n" + result.result;
			}
		}
		
		// 去重处理
		finalOutput = dedupeRepeatedContent(finalOutput || '');
		
		// 检查计费错误
		if (isBillingError(finalOutput)) {
			throw new Error(finalOutput);
		}
		
		return {
			result: finalOutput,
			sessionId: result.sessionId,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (isBillingError(message)) {
			throw err;
		}
		throw err;
	}
}

// ── Feedback Gate：等待 IM 用户回复的请求（内存，不持久化）──────
interface PendingFeedbackGate {
	triggerId: string;
	message: string;
	title: string;
	chatId: string;
	cardId?: string;
	createdAt: number;
}
const pendingFeedbackGates = new Map<string, PendingFeedbackGate>();
const feedbackGateLatestCards = new Map<string, string>();
const FEEDBACK_GATE_TIMEOUT = 24 * 60 * 60 * 1000; // 24h

// ── 会话级活跃追踪（lockKey = session:id 或 ws:path）──────
const busySessions = new Set<string>();

// ── 发送消息（会话优先，欠费降级 auto）──────────
async function runAgent(
	workspace: string,
	prompt: string,
	opts?: {
		onProgress?: (p: AgentProgress) => void;
		onStart?: () => void;
		context?: { chatId?: string };
	},
): Promise<{ result: string; quotaWarning?: string }> {
	const primaryModel = config.CURSOR_MODEL || getDefaultModel();
	let lockKey = getLockKey(workspace);

	return withSessionLock(lockKey, async () => {
		busySessions.add(lockKey);
		opts?.onStart?.();
		try {
			const existingSessionId = getActiveSessionId(workspace);
			const isNewSession = !existingSessionId;
			
			const chatId = opts?.context?.chatId;
			const isOpus = primaryModel.toLowerCase().includes('opus');
			
			const onFeedbackRequested = chatId && isOpus
				? async (req: FeedbackGateRequest) => {
					console.log(`[FeedbackGate] Received request: triggerId=${req.triggerId} title=${req.title}`);
					const fgCardId = await sendCard(chatId, `💬 **${req.title || 'AI 请求反馈'}**\n\n${req.message}\n\n---\n回复此消息即可提交反馈\n发送「完成」或「done」结束对话`, {
						title: req.title || '等待反馈',
						color: 'purple',
					});
					pendingFeedbackGates.set(chatId, {
						triggerId: req.triggerId,
						message: req.message,
						title: req.title,
						chatId,
						cardId: fgCardId || undefined,
						createdAt: Date.now(),
					});
				}
				: undefined;
			
			const fgConfig = chatId && isOpus ? {
				chatId,
				platform: 'feishu',
				enabledModel: primaryModel,
			} : undefined;

			try {
				const { result, sessionId, usedFallback, fallbackModel, errorMsg } = await execAgentWithFallback(
					lockKey, 
					workspace, 
					primaryModel, 
					prompt, 
					{
						sessionId: existingSessionId,
						onProgress: opts?.onProgress,
						context: { platform: 'feishu', chatId },
						feedbackGate: fgConfig,
						onFeedbackRequested,
					}
				);
				
				if (sessionId) {
					setActiveSession(workspace, sessionId);
					if (isNewSession) {
						generateSessionTitle(workspace, sessionId, prompt, result);
					}
				}
				
				// 检查是否使用了 fallback
				if (usedFallback && fallbackModel) {
					// 简化提示：只说明原因和结果，避免重复
					const reason = errorMsg?.toLowerCase().includes('usage limit') || errorMsg?.toLowerCase().includes('quota')
						? `\`${primaryModel}\` 配额用尽`
						: `\`${primaryModel}\` 失败`;
					return {
						result,
						quotaWarning: `⚠️ **模型降级**\n\n${reason}，已改用 \`${fallbackModel}\` 完成。`,
					};
				}
				
				return { result };
			} catch (err) {
				const e = err instanceof Error ? err : new Error(String(err));

				// 会话过期重试逻辑（保持原有）
				if (existingSessionId && !isBillingError(e.message)) {
					console.warn(`[重试] 会话可能过期，重新创建: ${e.message.slice(0, 100)}`);
					archiveAndResetSession(workspace);
					try {
					const { result, sessionId, usedFallback, fallbackModel, errorMsg } = await execAgentWithFallback(
						lockKey, 
						workspace, 
						primaryModel, 
						prompt, 
						{
							onProgress: opts?.onProgress,
							context: { platform: 'feishu', chatId },
							feedbackGate: fgConfig,
							onFeedbackRequested,
						}
					);
						
						if (sessionId) {
							setActiveSession(workspace, sessionId);
							generateSessionTitle(workspace, sessionId, prompt, result);
						}
						
						// 检查是否使用了 fallback
						if (usedFallback && fallbackModel) {
							// 简化提示：只说明原因和结果，避免重复
							const reason = errorMsg?.toLowerCase().includes('usage limit') || errorMsg?.toLowerCase().includes('quota')
								? `\`${primaryModel}\` 配额用尽`
								: `\`${primaryModel}\` 失败`;
							return {
								result,
								quotaWarning: `⚠️ **模型降级**\n\n${reason}，已改用 \`${fallbackModel}\` 完成。`,
							};
						}
						
						return { result };
					} catch (retryErr) {
						const re = retryErr instanceof Error ? retryErr : new Error(String(retryErr));
						throw re;
					}
				}

				archiveAndResetSession(workspace);
				throw e;
			}
		} finally {
			busySessions.delete(lockKey);
		}
	});
}

// ── 去重（持久化 + 内存）────────────────────────
// 仅内存：60s 内重复直接拦（同一进程内快速路径）
const seen = new Map<string, number>();
function isDup(id: string): boolean {
	const now = Date.now();
	for (const [k, t] of seen) if (now - t > 60_000) seen.delete(k);
	if (seen.has(id)) return true;
	seen.set(id, now);
	return false;
}
// 持久化去重：24h TTL，防飞书重复推送/重启后重复处理，避免回复重复
async function shouldProcessMessage(messageId: string): Promise<boolean> {
	if (isDup(messageId)) return false;
	const isNew = await tryRecordMessagePersistent(messageId, "im.receive", console.log);
	return isNew;
}

// ── 定时任务文件位置修正 ─────────────────────────
async function fixCronJobsLocation(workspace: string, chatId: string) {
	// 检查工作区是否有 cron-jobs.json（错误位置）
	const wrongPath = resolve(workspace, 'cron-jobs.json');
	const correctPath = resolve(ROOT, 'cron-jobs-feishu.json');
	
	if (!existsSync(wrongPath)) return;
	
	try {
		console.log(`[修正] 发现错误位置的任务文件: ${wrongPath}`);
		
		// 读取错误位置的任务
		const wrongData = JSON.parse(readFileSync(wrongPath, 'utf-8'));
		
		// 读取正确位置的现有任务（如果存在）
		let correctData: any;
		try {
			correctData = JSON.parse(readFileSync(correctPath, 'utf-8'));
		} catch {
			correctData = { version: 1, jobs: [] };
		}
		
	// 修正每个任务的字段
	let fixedCount = 0;
	for (const job of wrongData.jobs || []) {
		// 跳过明确属于其他平台的任务
		if (job.platform && job.platform !== 'feishu') {
			console.log(`[修正] 跳过 ${job.platform} 平台的任务: ${job.name}`);
			continue;
		}
		
		// 添加缺失的 platform 和 webhook 字段
		if (!job.platform) {
			job.platform = 'feishu';
			fixedCount++;
		}
		if (!job.webhook) {
			job.webhook = chatId;
				fixedCount++;
			}
			
			// 检查是否已存在（避免重复）
			const exists = correctData.jobs.some((j: any) => j.id === job.id);
			if (!exists) {
				correctData.jobs.push(job);
			}
		}
		
		// 保存到正确位置
		writeFileSync(correctPath, JSON.stringify(correctData, null, 2));
		console.log(`[修正] ✅ 已移动 ${wrongData.jobs?.length || 0} 个任务到 ${correctPath}`);
		console.log(`[修正] ✅ 修复了 ${fixedCount} 个缺失字段`);
		
		// 删除错误位置的文件
		unlinkSync(wrongPath);
		console.log(`[修正] ✅ 已删除 ${wrongPath}`);
		
	} catch (err) {
		console.error('[修正] 失败:', err);
	}
}

// ── 消息处理 ─────────────────────────────────────
async function handle(params: {
	text: string;
	messageId: string;
	chatId: string;
	chatType: string;
	messageType: string;
	content: string;
	forceProject?: string;  // 强制使用指定项目（用于卡片按钮回调）
}) {
	const { messageId, chatId, chatType, messageType, content, forceProject } = params;
	let { text } = params;
	// 记录最近活跃会话用于定时任务/心跳主动推送
	lastActiveChatId = chatId;
	console.log(`[${new Date().toISOString()}] [${messageType}] ${text.slice(0, 80)}`);

	return handleInner(text, messageId, chatId, chatType, messageType, content, forceProject);
}

async function handleInner(
	text: string,
	messageId: string,
	chatId: string,
	chatType: string,
	messageType: string,
	content: string,
	forceProject?: string,
): Promise<void> {
	let cardId: string | undefined;
	const isGroup = chatType === "group";
	const defaultWorkspace = projectsConfig.projects[projectsConfig.default_project]?.path || ROOT;
	
	// 最外层错误兜底：确保任何异常都会回复用户
	try {
	
	// 检查是否有待确认的项目切换（按 chatId 隔离）
	let ws = sessionsStore.get(defaultWorkspace);
	if (!ws) {
		ws = { active: null, history: [] };
		sessionsStore.set(defaultWorkspace, ws);
		saveSessions();  // Bug #51 修复: 持久化新创建的session
	}
	
	// 数据迁移：旧版本使用单数 pendingProjectSwitch，新版本使用复数 pendingProjectSwitches
	if (!ws.pendingProjectSwitches) {
		ws.pendingProjectSwitches = {};
		// 如果存在旧的单数字段，迁移到新结构
		const oldPending = (ws as any).pendingProjectSwitch;
		if (oldPending && oldPending.chatId) {
			console.log(`[智能路由] 检测到旧版本 pending 数据，自动迁移到新结构`);
			ws.pendingProjectSwitches[oldPending.chatId] = oldPending;
			delete (ws as any).pendingProjectSwitch;
			sessionsStore.set(defaultWorkspace, ws);
			saveSessions();
		}
	}
	
	// 清理所有过期的 pending（5分钟超时）
	const PENDING_TIMEOUT = 5 * 60 * 1000;
	const now = Date.now();
	for (const [cid, p] of Object.entries(ws.pendingProjectSwitches)) {
		if (now - p.createdAt > PENDING_TIMEOUT) {
			console.log(`[智能路由] chatId=${cid.slice(0, 10)}... 的 pending 已过期，自动清除`);
			delete ws.pendingProjectSwitches[cid];
		}
	}
	
	const pending = ws.pendingProjectSwitches[chatId];
	
	if (pending && !forceProject && now - pending.createdAt <= PENDING_TIMEOUT) {
		const trimmedText = text.trim().toLowerCase();
		const isYes = /^(是|y|yes|确认|切换|好|ok)$/i.test(trimmedText);
		const isNo = /^(否|不|n|no|取消|不用)$/i.test(trimmedText);
		const isCommand = text.trim().startsWith('/');
		
		if (isYes) {
			// 用户确认切换
			const suggestedInfo = projectsConfig.projects[pending.suggestedProject];
			
			// Bug #46 修复: 检查项目配置和路径是否存在
			if (!suggestedInfo || !existsSync(suggestedInfo.path)) {
				const errMsg = !suggestedInfo 
					? `项目「${pending.suggestedProject}」已从配置中移除，无法切换。`
					: `项目路径不存在：\`${suggestedInfo.path}\`\n\n请检查 \`projects.json\` 配置。`;
				await replyCard(messageId, `❌ **切换失败**\n\n${errMsg}`, { title: "配置错误", color: "red" });
				
				// 清除无效的pending
				delete ws.pendingProjectSwitches![chatId];
				sessionsStore.set(defaultWorkspace, ws);
				saveSessions();
				return;
			}
			
			const msg = `✅ **已临时切换到 ${pending.suggestedProject} 项目**\n\n📁 ${suggestedInfo.description || ''}\n\n正在执行原始任务：「${pending.originalMessage}」`;
			await replyCard(messageId, msg, { title: "项目已切换", color: "green" });

			// 清除待确认状态
			delete ws.pendingProjectSwitches![chatId];
			sessionsStore.set(defaultWorkspace, ws);
			saveSessions();

			// 执行原始任务，强制使用建议的项目
			// 使用当前消息ID，这样Agent回复会跟在"是"这条消息后面
			console.log(`[智能路由] 用户确认切换到: ${pending.suggestedProject}`);
			await handleInner(pending.originalMessage, messageId, chatId, chatType, pending.originalMessageType, pending.originalContent, pending.suggestedProject);
			return;
			
		} else if (isNo) {
			// 用户拒绝切换
			const currentInfo = projectsConfig.projects[pending.currentProject];
			const msg = `✅ **继续使用当前项目 ${pending.currentProject}**\n\n📁 ${currentInfo?.description || ''}\n\n正在执行原始任务：「${pending.originalMessage}」`;
			await replyCard(messageId, msg, { title: "使用当前项目", color: "green" });
			
			// 清除待确认状态
			delete ws.pendingProjectSwitches![chatId];
			sessionsStore.set(defaultWorkspace, ws);
			saveSessions();
			
			// 执行原始任务，强制使用当前项目（防止再次触发智能检测）
			// 使用当前消息ID，这样Agent回复会跟在"否"这条消息后面
			console.log(`[智能路由] 用户拒绝切换，强制使用当前项目: ${pending.currentProject}`);
			await handleInner(pending.originalMessage, messageId, chatId, chatType, pending.originalMessageType, pending.originalContent, pending.currentProject);
			return;
			
		} else if (isCommand) {
			// 用户发送了命令（如 /项目、/status），保留待确认状态，继续处理命令
			console.log(`[智能路由] 用户发送命令，保留待确认状态`);
			// 不清除 pending，继续往下执行
			
		} else {
			// 用户回复了普通内容（非命令），清除待确认状态，继续处理当前消息
			console.log(`[智能路由] 用户回复其他内容，清除待确认状态`);
			delete ws.pendingProjectSwitches![chatId];
			sessionsStore.set(defaultWorkspace, ws);
			saveSessions();
			// 继续处理当前消息（不 return，继续往下执行）
		}
	}
	
	// 处理媒体附件
	const parsed = parseContent(messageType, content);
	try {
		// 处理单张图片（旧格式 image 消息）
		if (parsed.imageKey) {
			const path = await downloadMedia(messageId, parsed.imageKey, "image", ".png");
			const instruction = "\n\n**注意**：这张图片来自飞书消息系统的临时存储，请直接用 Read 工具读取分析，不要复制到当前工作区。";
			text = text
				? `${text}\n\n图片：${path}${instruction}`
				: `用户发了一张图片：${path}${instruction}\n\n请查看并回复。`;
		}
		// 处理多张图片（post 消息中的图片）
		if (parsed.imageKeys && parsed.imageKeys.length > 0) {
			const imagePaths: string[] = [];
			for (let i = 0; i < parsed.imageKeys.length; i++) {
				const imgKey = parsed.imageKeys[i];
				if (imgKey === undefined) continue;
				const path = await downloadMedia(messageId, imgKey, "image", ".png");
				imagePaths.push(path);
			}
			const imageTexts = imagePaths.map((p, i) => `图片${i + 1}：${p}`).join("\n");
			const instruction = "\n\n**注意**：这些图片来自飞书消息系统的临时存储，请直接用 Read 工具读取分析，不要复制到当前工作区。";
			text = text
				? `${text}\n\n${imageTexts}${instruction}`
				: `用户发了 ${imagePaths.length} 张图片：\n${imageTexts}${instruction}\n\n请查看并回复。`;
		}
		if (parsed.fileKey && messageType === "audio") {
			cardId = await replyCard(messageId, "🎙️ 正在识别语音...", { title: "语音识别中", color: "wathet" });
			const audioPath = await downloadMedia(messageId, parsed.fileKey, "file", ".ogg");
			const transcript = await transcribeAudio(audioPath);
			try { unlinkSync(audioPath); } catch {}
			if (transcript) {
				text = transcript;
				console.log(`[语音] 转文字成功: ${transcript.slice(0, 80)}`);
			} else {
				text = `用户发了一条语音消息，音频文件在 ${audioPath}，请处理并回复。`;
				console.warn("[语音] 转文字失败，传原始文件路径");
			}
		}
		if (parsed.fileKey && messageType === "file") {
			const dotIdx = parsed.fileName?.lastIndexOf(".");
			const ext = dotIdx != null && dotIdx > 0 ? parsed.fileName!.slice(dotIdx) : "";
			const path = await downloadMedia(messageId, parsed.fileKey, "file", ext);
			text = text
				? `${text}\n\n[附件: ${path}]`
				: `用户发了文件 ${parsed.fileName || ""}，已保存到 ${path}`;
		}
	} catch (e) {
		console.error("[下载失败]", e);
		if (!text) {
			if (cardId) await updateCard(cardId, "❌ 媒体下载失败，请重新发送", { color: "red" });
			else await replyCard(messageId, "❌ 媒体下载失败，请重新发送");
			return;
		}
	}

	if (!text) return;

	// 获取当前项目和路由意图（用于后续路由）
	const currentProject = getCurrentProject(defaultWorkspace);
	const routeIntent = detectRouteIntent(text);

	// === 命令系统（使用统一的 CommandHandler）===
	
	// 创建飞书平台适配器
	const feishuAdapter: PlatformAdapter = {
		reply: async (content: string, options?: { title?: string; color?: string }) => {
			await replyCard(messageId, content, options);
		},
		sendFile: async (filePath: string, fileName?: string) => {
			const buffer = readFileSync(filePath);
			await sendMediaFeishu({
				cfg: {
					channels: {
						feishu: {
							appId: config.FEISHU_APP_ID,
							appSecret: config.FEISHU_APP_SECRET,
						},
					},
				},
				to: chatId,
				mediaBuffer: buffer,
				fileName: fileName || filePath.split("/").pop() || "file",
				replyToMessageId: messageId,
			});
		},
	};
	
	// 创建命令上下文
	const commandContext: CommandContext = {
		platform: 'feishu',
		projectsConfig,
		defaultWorkspace,
		memoryWorkspace,
		config,
		scheduler,
		memory: memory || null,
		heartbeat,
		busySessions,
		sessionsStore,
		getCurrentProject: (ws: string) => getCurrentProject(ws) || null,
		getLockKey,
		archiveAndResetSession,
		getSessionHistory,
		getActiveSessionId: (ws: string) => getActiveSessionId(ws) || null,
		switchToSession,
		rootDir: ROOT,
		agentExecutor, // 统一 Agent 执行器
	};
	
	// 创建命令处理器
	const commandHandler = new CommandHandler(feishuAdapter, commandContext);
	
	// 尝试路由到命令处理器
	const handled = await commandHandler.route(text, (newSessionId: string) => {
		setActiveSession(defaultWorkspace, newSessionId);
	});
	
	if (handled) {
		console.log('[命令] 已通过统一处理器处理');
		return;
	}
	
	// === 以下是平台特定命令（需要群聊保护或特殊逻辑）===
	
	// /apikey、/密钥 → 群聊保护（飞书特定：需要在群聊中阻止）
	const apikeyMatch = text.match(/^\/?(?:api\s*key|密钥|换key|更换密钥)[\s:：=]*(.+)/i);
	if (apikeyMatch) {
		if (isGroup) {
			await replyCard(messageId, "⚠️ **安全提醒：请勿在群聊中发送 API Key！**\n\n请在与机器人的 **私聊** 中发送 `/apikey` 指令。", { title: "安全提醒", color: "red" });
			return;
		}
		// 私聊模式：委托给统一处理器（不需要更新 session，传递空回调保持一致性）
		const handled = await commandHandler.route(text, () => {});
		if (handled) return;
	}
	
	// 检测相对时间新闻推送（X分钟后推送热点、X小时后推送新闻）
	const relativeNewsMatch = text.match(/(\d+)\s*(分钟|小时)(?:[后以]后|后)\s*(?:推送|发送)?\s*(?:前|top)?\s*(\d+)?\s*条?\s*(?:今日)?\s*(热点|新闻|热榜)/i);
	if (relativeNewsMatch) {
		const numStr = relativeNewsMatch[1];
		const unit = relativeNewsMatch[2];
		const topNStr = relativeNewsMatch[3];
		if (!numStr || !unit) {
			// 正则已匹配但捕获组异常，交给后续逻辑
		} else {
		const num = parseInt(numStr, 10);
		const topN = topNStr ? Math.min(50, Math.max(1, parseInt(topNStr, 10))) : 15;
		const minutes = unit === '小时' ? num * 60 : num;
		const runAtMs = Date.now() + minutes * 60 * 1000;
		const runAt = new Date(runAtMs);
		const timeDesc = `${num}${unit}后（${runAt.toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' })}）`;
		
		const message = JSON.stringify({ type: "fetch-news", options: { topN } });
		await scheduler.add({
			name: "热点新闻推送",
			enabled: true,
			deleteAfterRun: true, // 相对时间任务执行一次后删除
			schedule: { kind: "at", at: runAt.toISOString() },
			message,
			platform: "feishu",
			webhook: chatId,
		});
		await replyCard(
			messageId,
			`✅ 已创建定时任务\n\n⏰ 执行时间：${timeDesc}\n📰 推送内容：今日热点新闻（前 ${topN} 条）\n📱 到时会通过**飞书**提醒你\n\n发送 \`/任务\` 可查看所有任务`,
			{ title: "⏰ 定时任务已创建", color: "green" },
		);
		return;
		}
	}

	// 检测新闻推送定时请求（每天/每日 早上/上午 9点 推送热点、明天上午10点推送新闻）
	const newsScheduleMatch = text.match(/(每天|每日|明天)\s*(早上|上午|下午)?\s*([0-9一二三四五六七八九十]+)\s*[点时]?\s*(?:给我)?\s*(?:推送|发送)?\s*(?:下|今日)?\s*(热点|新闻|热榜)/i);
	if (newsScheduleMatch) {
		const when = newsScheduleMatch[1];
		const ap = newsScheduleMatch[2];
		const hourStr = newsScheduleMatch[3];
		if (when && hourStr) {
		const numMap: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
		const toNum = (s: string) => (numMap[s] ?? parseInt(s, 10)) || 9;
		let topN = 15;
		const topMatch = text.match(/(?:推送|前)\s*(\d+)\s*条/i);
		if (topMatch?.[1]) topN = Math.min(50, Math.max(1, parseInt(topMatch[1], 10)));
		let schedule: { kind: "cron"; expr: string; tz?: string } | { kind: "at"; at: string };
		let timeDesc: string;
		if (when === "每天" || when === "每日") {
			const hour = toNum(hourStr);
			const hour24 = ap === "下午" ? (hour % 12) + 12 : hour;
			schedule = { kind: "cron", expr: `0 ${hour24} * * *`, tz: "Asia/Shanghai" };
			timeDesc = `每天 ${hour24}:00`;
		} else {
			let hour = toNum(hourStr);
			if (ap === "下午") hour = (hour % 12) + 12;
			const d = new Date();
			d.setDate(d.getDate() + 1);
			d.setHours(hour, 0, 0, 0);
			schedule = { kind: "at", at: d.toISOString() };
			timeDesc = `明天 ${hour}:00`;
		}
		const message = JSON.stringify({ type: "fetch-news", options: { topN } });
		await scheduler.add({
			name: "热点新闻推送",
			enabled: true,
			deleteAfterRun: false,
			schedule,
			message,
			platform: "feishu",
			webhook: chatId,
		});
		await replyCard(
			messageId,
			`✅ 已创建定时任务\n\n⏰ 执行时间：${timeDesc}\n📰 推送内容：今日热点新闻（前 ${topN} 条）\n📱 到时会通过**飞书**提醒你\n\n发送 \`/任务\` 可查看所有任务`,
			{ title: "⏰ 定时任务已创建", color: "green" },
		);
		return;
		}
	}

	// 检测「每个工作日 HH点/HH:MM/HH点MM/HH点 MM分 提醒」请求，服务器端直接创建
	const weekdayScheduleMatch = text.match(/每个工作日\s*(\d{1,2})(?:[.:：](\d{1,2})|点\s*(\d{1,2})\s*分?|点)?\s*(?:提醒|通知)?(?:我)?\s*(.+)$/i);
	if (weekdayScheduleMatch) {
		const hourStr = weekdayScheduleMatch[1];
		const minStr1 = weekdayScheduleMatch[2];
		const minStr2 = weekdayScheduleMatch[3];
		const taskMessage = weekdayScheduleMatch[4];
		if (hourStr && taskMessage !== undefined) {
		const hour = Math.min(23, Math.max(0, parseInt(hourStr, 10) || 14));
		// 分钟可能来自 `:45` (minStr1) 或 `点45` (minStr2)
		const minStr = minStr1 || minStr2;
		const minute = minStr != null && minStr !== '' ? Math.min(59, Math.max(0, parseInt(minStr, 10) || 0)) : 0;
		const task = await scheduler.add({
			name: "工作日提醒",
			enabled: true,
			deleteAfterRun: false,
			schedule: { kind: "cron", expr: `${minute} ${hour} * * 1-5`, tz: "Asia/Shanghai" },
			message: taskMessage.trim(),
			platform: "feishu",
			webhook: chatId,
		});
		const timeDesc = `${hour}:${String(minute).padStart(2, "0")}`;
		await replyCard(messageId, `✅ 已设置好，**每个工作日 ${timeDesc}** 通过飞书提醒你：\n\n${taskMessage.trim()}\n\n发送 \`/cron\` 可查看所有任务。`, { title: "⏰ 定时任务已创建", color: "green" });
		console.log(`[任务] 服务器端创建: 每个工作日 ${timeDesc} 提醒`);
		return;
		}
	}

	// 检测简单定时任务请求，服务器端直接创建（不依赖 Agent）
	const simpleScheduleMatch = text.match(/^(\d+)(分钟|小时)后\s*(?:提醒|通知)?(?:我)?\s*(.+)$/i);
	if (simpleScheduleMatch) {
		const num = simpleScheduleMatch[1];
		const unit = simpleScheduleMatch[2];
		const taskMessage = simpleScheduleMatch[3];
		if (num && unit && taskMessage !== undefined) {
		const minutes = unit === "小时" ? parseInt(num, 10) * 60 : parseInt(num, 10);
		const runAtMs = Date.now() + minutes * 60 * 1000;
		const runAt = new Date(runAtMs);
		
		// 检测是否为新闻推送请求
		const isNewsRequest = /推送|发送/.test(taskMessage) && /热点|新闻|热榜/.test(taskMessage);
		let finalMessage: string;
		let taskName: string;
		
		console.log(`[定时] 解析任务: "${text}" → taskMessage="${taskMessage}" isNewsRequest=${isNewsRequest}`);
		
		if (isNewsRequest) {
			// 提取条数（默认 15 条）
			const topNMatch = taskMessage.match(/(\d+)\s*条/);
			const topN =
				topNMatch?.[1] != null
					? Math.min(50, Math.max(1, parseInt(topNMatch[1], 10)))
					: 15;
			finalMessage = JSON.stringify({ type: "fetch-news", options: { topN } });
			taskName = "热点新闻推送";
			console.log(`[定时] → 创建新闻推送任务，topN=${topN}`);
		} else {
			finalMessage = taskMessage.trim();
			taskName = `${num}${unit}后提醒`;
			console.log(`[定时] → 创建普通提醒任务`);
		}
		
		const task = await scheduler.add({
			name: taskName,
			enabled: true,
			deleteAfterRun: true,
			schedule: { kind: "at", at: runAt.toISOString() },
			message: finalMessage,
			platform: "feishu",
			webhook: chatId,
		});
		
		const timeStr = runAt.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
		const content = isNewsRequest ? `今日热点新闻（前 ${JSON.parse(finalMessage).options.topN} 条）` : taskMessage;
		await replyCard(messageId, `✅ 已设置好，大约在 **${timeStr}** 通过飞书提醒你：\n\n${content}\n\n发送 \`/cron\` 可查看所有任务。`, { title: "⏰ 定时任务已创建", color: "green" });
		console.log(`[任务] 服务器端创建: ${task.name} @ ${timeStr}`);
		return;
		}
	}
	
	// 路由解析（传入 intent 避免重复检测）
	// 如果有强制项目（卡片按钮点击），则直接使用
	let workspace: string, prompt: string, label: string, intent: RouteIntent, routeChanged: boolean | undefined;
	
	if (forceProject && projectsConfig.projects[forceProject]) {
		workspace = projectsConfig.projects[forceProject].path;
		prompt = text;
		label = forceProject;
		intent = { type: 'temp', project: forceProject, cleanedText: text };
		routeChanged = false;
		console.log(`[路由] 强制路由到项目: ${forceProject}`);
	} else {
		const routeResult = route(text, currentProject, routeIntent);
		workspace = routeResult.workspace;
		prompt = routeResult.prompt;
		label = routeResult.label;
		intent = routeResult.intent;
		routeChanged = routeResult.routeChanged;
		
		// 临时路由提示
		if (intent.type === 'temp') {
			console.log(`[路由] 临时路由到项目: ${label}`);
		}
	}
	
	// 处理项目持久切换（"切换到 XXX 项目"）
	if (routeChanged && intent.type === 'switch' && intent.project) {
		const projectInfo = projectsConfig.projects[intent.project];
		if (!projectInfo) {
			const names = Object.keys(projectsConfig.projects);
			await replyCard(messageId, `❌ **未找到项目「${intent.project}」**\n\n可用项目：\n${names.map(n => `- \`${n}\``).join('\n')}\n\n请检查 \`projects.json\` 或使用上述项目名。`, { title: '未找到项目', color: 'orange' });
			return;
		}
		
		// 检查项目路径是否存在
		if (!existsSync(projectInfo.path)) {
			await replyCard(messageId, `❌ **切换失败**\n\n项目路径不存在：\`${projectInfo.path}\`\n\n请检查 \`projects.json\` 配置。`, { title: '切换失败', color: 'red' });
			return;
		}
		
		// 更新当前项目（持久化到 sessionsStore）
		const wsData = sessionsStore.get(defaultWorkspace) || { active: null, history: [] };
		if (!wsData.currentProject || wsData.currentProject !== intent.project) {
			wsData.currentProject = intent.project;
			sessionsStore.set(defaultWorkspace, wsData);
			saveSessions();
		}
		
		await replyCard(messageId, `✅ **已切换到项目：${intent.project}**\n\n📁 ${projectInfo.description}\n\n路径：\n\`\`\`\n${projectInfo.path}\n\`\`\`\n\n后续消息将在此项目中执行，直到你切换到其他项目。`, { title: '项目已切换', color: 'green' });
		console.log(`[路由] 持久切换到项目: ${intent.project}`);
		return;
	}
	
	// Bug #15 修复：路径切换不支持持久化，改为提示用户使用项目名
	if (routeChanged && intent.type === 'switch' && intent.path) {
		const pathLabel = intent.path.split('/').pop() || intent.path;
		const projectNames = Object.keys(projectsConfig.projects).map(n => `\`${n}\``).join('、');
		await replyCard(messageId, `⚠️ **路径切换不支持持久化**\n\n您尝试切换到：\`${intent.path}\`\n\n**建议方案**：\n\n1️⃣ **使用项目名切换**（推荐）\n   发送：\`切换到 项目名\`\n   可用项目：${projectNames}\n\n2️⃣ **使用路径前缀**（临时路由）\n   发送：\`#${intent.path} 你的消息\`\n   示例：\`#${intent.path} 帮我分析代码\`\n\n3️⃣ **添加到 projects.json**（永久配置）\n   编辑项目配置文件添加新项目\n\n> 路径切换无法保存到会话中，建议使用项目名进行持久切换。`, { title: '不支持路径持久化', color: 'orange' });
		console.log(`[路由] 路径切换被拒绝（不支持持久化）: ${intent.path}`);
		return;
	}
	
	// 检查路由后的 prompt 是否还是命令（处理 "项目名:/命令" 格式）
	if (prompt !== text) {
		const routedHandled = await commandHandler.route(prompt, (newSessionId: string) => {
			setActiveSession(workspace, newSessionId);
		});
		if (routedHandled) {
			console.log('[命令] 路由后的命令已通过统一处理器处理');
			return;
		}
	}

	// 未知 / 指令 → 友好提示
	if (prompt.startsWith("/")) {
		const cmd = prompt.split(/[\s:：]/)[0];
		await replyCard(messageId, `未知指令 \`${cmd}\`\n\n发送 \`/帮助\` 查看所有可用指令。`, { title: "未知指令", color: "orange" });
		return;
	}

	// ── Feedback Gate: 拦截用户回复 ──
	const pendingFG = pendingFeedbackGates.get(chatId);
	if (pendingFG) {
		const age = Date.now() - pendingFG.createdAt;
		if (age < FEEDBACK_GATE_TIMEOUT) {
			const isDone = /^(done|完成|ok|好的|结束|没了|没有了|task_complete)$/i.test(prompt.trim());
			const responseText = isDone ? 'TASK_COMPLETE' : prompt;
			console.log(`[FeedbackGate] Replying to triggerId=${pendingFG.triggerId} isDone=${isDone}: ${prompt.slice(0, 100)}`);
			writeFeedbackGateResponse(pendingFG.triggerId, responseText);
			pendingFeedbackGates.delete(chatId);
			
			if (pendingFG.cardId && isDone) {
				await updateCard(pendingFG.cardId, `✅ **对话已结束**`, {
					title: '对话结束',
					color: 'green',
				});
			}

			const currentLockKeyFG = getLockKey(workspace);
			if (!busySessions.has(currentLockKeyFG)) {
				console.log(`[FeedbackGate] Agent already finished, treating reply as new message`);
			} else {
				const fgReplyCardId = await replyCard(messageId, isDone ? '✅ 对话已结束' : `✅ 反馈已提交，AI 正在继续处理...\n\n> ${prompt.slice(0, 200)}`, {
					title: isDone ? '对话结束' : '处理中',
					color: isDone ? 'green' : 'blue',
				});
				if (fgReplyCardId && chatId) {
					feedbackGateLatestCards.set(chatId, fgReplyCardId);
				}
				return;
			}
		} else {
			pendingFeedbackGates.delete(chatId);
			console.log(`[FeedbackGate] Expired pending for chatId=${chatId.slice(0, 10)}...`);
		}
	}

	const model = config.CURSOR_MODEL || getDefaultModel();

	// 创建或复用卡片：全局排队卡片 → 同会话排队 → 处理中
	const currentLockKey = getLockKey(workspace);
	
	// 检查是否有锁正在等待（检查 sessionLocks 是否有 Promise）
	const hasSessionLock = sessionLocks.has(currentLockKey);
	const isBusy = busySessions.has(currentLockKey) || hasSessionLock;
	
	const needsSessionQueue = !cardId && isBusy;
	if (!cardId) {
		const status = needsSessionQueue
			? `⏳ 排队中（同会话有任务进行中）\n\n> ${prompt.slice(0, 120)}`
			: `⏳ 正在执行...\n\n> ${prompt.slice(0, 120)}`;
		cardId = await replyCard(messageId, status, {
			title: needsSessionQueue ? "排队中" : "处理中",
			color: needsSessionQueue ? "grey" : "wathet",
		});
	} else {
		// 从全局排队卡片复用，看是否还需要等同会话锁
		const status = isBusy
			? `⏳ 排队中（同会话有任务进行中）\n\n> ${prompt.slice(0, 120)}`
			: `⏳ 正在执行...\n\n> ${prompt.slice(0, 120)}`;
		await updateCard(cardId, status, {
			title: isBusy ? "排队中" : "处理中",
			color: isBusy ? "grey" : "wathet",
		});
	}
	console.log(`[Agent] 调用 Cursor CLI workspace=${workspace} model=${model} card=${cardId}`);
	const taskStart = Date.now();

	// 记忆由 Cursor 自主通过 memory-tool.ts 调用，server 不注入
	if (memory) {
		memory.appendSessionLog(workspace, "user", prompt, model);
	}

	// runAgent 获取 session lock 后回调 onStart，更新卡片为"处理中 · 0秒"（立马显示秒数）
	const onStart = cardId
		? () => {
				updateCard(cardId!, `⏳ 正在执行...\n\n> ${prompt.slice(0, 120)}`, {
					title: "思考中 · 0秒",
					color: "wathet",
				}).catch(() => {});
			}
		: undefined;

	const onProgress = cardId
		? (p: AgentProgress) => {
				const latestCard = feedbackGateLatestCards.get(chatId);
				if (latestCard) cardId = latestCard;
				const time = formatElapsed(p.elapsed);
				const phaseLabel = p.phase === "thinking" ? "🤔 思考中" : p.phase === "tool_call" ? "🔧 执行工具" : "💬 回复中";
				const snippet = p.snippet.split("\n").filter((l) => l.trim()).slice(-4).join("\n");
				updateCard(
					cardId!,
					`\`\`\`\n${snippet.slice(0, 300) || "..."}\n\`\`\``,
					{ title: `${phaseLabel} · ${time}`, color: "wathet" },
				).catch(() => {});
			}
		: undefined;

	try {
		const { result, quotaWarning } = await runAgent(workspace, prompt, { 
			onProgress, 
			onStart,
			context: { chatId }
		});
		const usedModel = quotaWarning ? "auto" : model;
		const elapsed = formatElapsed(Math.round((Date.now() - taskStart) / 1000));
		console.log(`[${new Date().toISOString()}] 完成 [${label}] model=${usedModel} elapsed=${elapsed} (${result.length} chars)`);

		// 记录 assistant 回复到会话日志
		if (memory) {
			memory.appendSessionLog(workspace, "assistant", result.slice(0, 3000), usedModel);
		}

		// Agent 可能修改了 cron-jobs.json，检查并修正位置
		await fixCronJobsLocation(workspace, chatId);
		
		// 重新加载调度器
		scheduler.reload().catch(() => {});

		const fullResult = quotaWarning ? `${quotaWarning}\n\n---\n\n${result}` : result;
		const doneTitle = `完成 · ${elapsed}`;
		const doneColor = quotaWarning ? "orange" : "green";

		// 尝试发送 AI 结果到飞书卡片
		// 如果经历了 feedback gate 多轮，优先更新最新的卡片（避免用户翻页）
		const latestFGCard = feedbackGateLatestCards.get(chatId);
		if (latestFGCard) {
			cardId = latestFGCard;
			feedbackGateLatestCards.delete(chatId);
			console.log(`[回复] 使用 feedback gate 最新卡片: ${latestFGCard}`);
		}
		let sendOk = false;
		console.log(`[回复] 准备更新卡片 cardId=${cardId} length=${fullResult.length} maxLength=${CARD_MAX}`);
		if (cardId && fullResult.length <= CARD_MAX) {
			console.log(`[回复] 开始调用 updateCard...`);
			const { ok, error } = await updateCard(cardId, fullResult, { title: doneTitle, color: doneColor });
			console.log(`[回复] updateCard 完成: ok=${ok} error=${error || 'none'}`);
			if (ok) {
				sendOk = true;
			} else {
				// 卡片更新失败 → 让大模型知道，自己重新组织回复
				console.log(`[重发] 卡片更新失败: ${error}，通知 AI 重新回复`);
				await updateCard(cardId, `⏳ 回复格式超出飞书限制，正在重新组织...`, { title: "重新组织中", color: "wathet" });

				const retryPrompt = [
					"你的上一条回复发送到飞书时失败了。",
					`失败原因：${error}`,
					"",
					"飞书卡片的限制：",
					"- 单张卡片最多 5 个 Markdown 表格（这是最常见的失败原因）",
					"- 卡片 JSON 总大小不超过 30KB（约 3500 中文字符）",
					"",
					"请重新回复刚才的内容，但要：",
					"1. 表格最多用 3 个，其余改用列表（- 项目符号）",
					"2. 精简文字，控制在 3000 字以内",
					"3. 如果内容确实很多，先给核心结论，末尾说「需要我继续展开吗？」",
					"4. 不要解释为什么格式变了，直接给内容",
				].join("\n");

				try {
					const { result: retryResult } = await runAgent(workspace, retryPrompt, { 
						onProgress,
						context: { chatId }
					});
					const retryElapsed = formatElapsed(Math.round((Date.now() - taskStart) / 1000));
					const { ok: retryOk } = await updateCard(cardId, retryResult, { title: `完成 · ${retryElapsed}`, color: doneColor });
					if (retryOk) {
						sendOk = true;
						console.log(`[重发] AI 重新回复成功 (${retryResult.length} chars)`);
					} else {
						console.warn("[重发] AI 重新回复后仍然超限，回退纯文本分片");
					}
				} catch (retryErr) {
					console.error("[重发] AI 重试失败:", retryErr);
				}
			}
		}

		// 卡片发送失败或内容过长 → 回退分片发送
		if (!sendOk) {
			if (cardId) {
				await updateCard(cardId, quotaWarning || "执行完成，结果见下方", { title: doneTitle, color: doneColor });
			}
			await replyLongMessage(messageId, chatId, result, { title: doneTitle, color: "green" });
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		
		// 手动终止的任务不需要发送错误消息（用户已经收到"已终止"的回复）
		if (msg === 'MANUALLY_STOPPED') {
			console.log(`[手动终止] workspace=${workspace} messageId=${messageId}`);
			return;
		}
		
		console.error(`[${new Date().toISOString()}] 失败 [${label}]: ${msg}`);
		if (err instanceof Error && err.stack) console.error(`[Stack] ${err.stack}`);

		const isAuthError = /authentication required|not authenticated|unauthorized|api.key/i.test(msg);
		const body = isAuthError
			? `**API Key 失效，请更换：**\n\n1. 打开 [Cursor Dashboard](https://cursor.com/dashboard) → Integrations → User API Keys\n2. 点 **Create API Key** 生成新 Key\n3. 在飞书发送：\`/apikey 你的新Key\`\n\n\`\`\`\n${msg.slice(0, 500)}\n\`\`\``
			: `**执行失败**\n\n\`\`\`\n${msg.slice(0, 2000)}\n\`\`\``;
		const title = isAuthError ? "API Key 失效" : "执行失败";

		if (cardId) {
			await updateCard(cardId, body, { title, color: "red" });
		} else {
			await replyCard(messageId, body, { title, color: "red" });
		}
	}
	
	} catch (outerErr) {
		// 最外层兜底：捕获智能检测、命令处理等阶段的异常
		const errMsg = outerErr instanceof Error ? outerErr.message : String(outerErr);
		console.error(`[handleInner异常] ${errMsg}`);
		if (outerErr instanceof Error && outerErr.stack) {
			console.error(`[Stack] ${outerErr.stack}`);
		}
		
		// 确保用户能收到错误通知
		try {
			const body = `❌ **处理失败**\n\n系统遇到意外错误，请稍后重试。\n\n错误信息：\n\`\`\`\n${errMsg.slice(0, 500)}\n\`\`\``;
			if (cardId) {
				await updateCard(cardId, body, { title: "系统错误", color: "red" });
			} else {
				await replyCard(messageId, body, { title: "系统错误", color: "red" });
			}
		} catch (replyErr) {
			console.error(`[兜底回复失败]`, replyErr);
		}
	}
}

// ── 飞书长连接 ───────────────────────────────────
const dispatcher = new Lark.EventDispatcher({});
const TYPES = new Set(["text", "image", "audio", "file", "post"]);

dispatcher.register({
	"im.message.receive_v1": async (data) => {
		console.log("[事件] 收到 im.message.receive_v1");
		try {
			const ev = data as Record<string, unknown>;
			const msg = ev.message as Record<string, unknown>;
			if (!msg) {
				console.error("[事件] msg 为空");
				return;
			}
		const messageType = msg.message_type as string;
		const messageId = msg.message_id as string;
		const chatId = msg.chat_id as string;
		const chatType = (msg.chat_type as string) || "p2p";
		const content = msg.content as string;
		
		// 参数有效性检查
		if (!messageId || !chatId) {
			console.error(`[事件] 缺少必要参数 messageId=${messageId} chatId=${chatId}`);
			return;
		}

		console.log(`[消息] 收到消息 messageId=${messageId.slice(0, 20)}... type=${messageType}`);
		const allowed = await shouldProcessMessage(messageId);
		if (!allowed) {
			console.log(`[去重] ❌ 跳过重复消息 messageId=${messageId.slice(0, 20)}...`);
			return;
		}
		console.log(`[去重] ✅ 新消息，允许处理 messageId=${messageId.slice(0, 20)}...`);
		if (!TYPES.has(messageType)) {
			await replyCard(messageId, `暂不支持: ${messageType}`);
			return;
		}

		const { text: parsedText, imageKey, fileKey } = parseContent(messageType, content);
		console.log(`[解析] type=${messageType} chat=${chatType} text="${parsedText.slice(0, 60)}" img=${imageKey ?? ""} file=${fileKey ?? ""}`);
		handle({ text: parsedText.trim(), messageId, chatId, chatType, messageType, content }).catch((err) => {
			// 兜底错误处理：即使handleInner的try-catch失败，也要回复用户
			console.error('[handle失败]', err);
			replyCard(messageId, `❌ 系统错误\n\n${err instanceof Error ? err.message : String(err)}`, 
				{ title: "处理失败", color: "red" }).catch(e => console.error('[最终兜底失败]', e));
		});
		} catch (e) {
			// dispatcher.register 级别的异常（parseContent、shouldProcessMessage等）
			console.error("[事件异常]", e);
			// 尝试通知用户（消息解析失败时可能没有 messageId）
			if (typeof data === 'object' && data && 'message' in data) {
				const msgData = (data as any).message;
				const msgId = msgData?.message_id;
				if (msgId) {
					replyCard(msgId, `❌ 系统异常\n\n消息处理过程中发生错误，请稍后重试。`, 
						{ title: "系统异常", color: "red" }).catch(err => console.error('[事件异常回复失败]', err));
				}
			}
		}
	},
});

// ── 启动前校验：未配置飞书凭据则直接退出 ─────────────
function isValidConfig(value: string | undefined): boolean {
	if (!value?.trim()) return false;
	const placeholders = ['your_feishu_app_id', 'your_feishu_app_secret', 'your_app_id', 'your_app_secret', 'cli_your_feishu_app_id'];
	return !placeholders.includes(value.toLowerCase().trim());
}

if (!isValidConfig(config.FEISHU_APP_ID) || !isValidConfig(config.FEISHU_APP_SECRET)) {
	console.error('\n┌──────────────────────────────────────────────────┐');
	console.error('│  ⚠️  飞书机器人未正确配置，服务不会启动          │');
	console.error('└──────────────────────────────────────────────────┘\n');
	console.error('如需使用飞书集成，请在 feishu/.env 中配置:');
	console.error('  1. 复制模板: cp feishu/.env.example feishu/.env');
	console.error('  2. 编辑 .env 文件，填入真实的机器人凭据:');
	console.error('     FEISHU_APP_ID=cli_your_actual_app_id');
	console.error('     FEISHU_APP_SECRET=your_actual_app_secret');
	console.error('\n如不需要飞书集成，可以忽略此提示。\n');
	process.exit(0); // 使用 exit(0) 表示正常退出，不是错误
}

// ── 启动 ─────────────────────────────────────────
const list = Object.entries(projectsConfig.projects)
	.map(([k, v]) => `  ${k} → ${v.path}`)
	.join("\n");
const sttEngine = config.VOLC_STT_APP_ID ? "火山引擎豆包大模型" : "本地 whisper";
const memEngine = memory ? `豆包 Embedding (${config.VOLC_EMBEDDING_MODEL})` : "未启用";
console.log(`
┌──────────────────────────────────────────────────┐
│  飞书 → Cursor Agent 中继服务 v5                 │
│  架构: OpenClaw 风格 (rules 自动加载)            │
├──────────────────────────────────────────────────┤
│  模型: ${config.CURSOR_MODEL || getDefaultModel()}
│  Key:  ...${config.CURSOR_API_KEY.slice(-8)}
│  连接: 飞书 WebSocket 长连接 + Supervisor 重连
│  收件: ${INBOX_DIR}
│  语音: ${sttEngine}
│  记忆: ${memEngine}
│  调度: cron-jobs-feishu.json (全局目录)
│  心跳: 默认关闭（飞书 /心跳 开启）
│  自检: .cursor/BOOT.md（每次启动执行）
│
│  规则（每次会话自动加载）:
│    soul.mdc, agent-identity.mdc, user-context.mdc
│    workspace-rules.mdc, tools.mdc, memory-protocol.mdc
│    scheduler-protocol.mdc, heartbeat-protocol.mdc
│    cursor-capabilities.mdc
│  记忆索引: 全工作区文本文件（memory-tool.ts）
│
│  回复: 互动卡片 + 消息更新
│  直连: 飞书消息 → Cursor CLI（stream-json + --resume）
│
│  项目路由:
${list}
│
│  热更换: 编辑 .env 即可
└──────────────────────────────────────────────────┘
`);

// 启动定时任务调度器
scheduler.start().catch((e) => console.warn(`[scheduler] start failed: ${e}`));

heartbeat.start();

// ── 飞书 WebSocket 启动（简化版，避免复杂性）─────
// 参考：OpenClaw 的教训，但采用更简单的方案
// 修复：
// 1. 异步启动 + 超时检测（捕获连接错误）
// 2. 启动重试机制（参考钉钉/企微）
// 3. 启动成功后，完全依赖 SDK 自己的重连机制

const ws = new Lark.WSClient({
	appId: config.FEISHU_APP_ID,
	appSecret: config.FEISHU_APP_SECRET,
	domain: Lark.Domain.Feishu,
	loggerLevel: Lark.LoggerLevel.info,
});

// 启动重试循环（类似钉钉/企微）
let startRetries = 10; // 增加到 10 次（共 ~5 分钟）
while (startRetries > 0) {
	try {
		// 异步启动 + 30 秒超时检测（避免僵尸连接）
		await Promise.race([
			ws.start({ eventDispatcher: dispatcher }),
			new Promise<void>((_, reject) => 
				setTimeout(() => reject(new Error('WebSocket 启动超时 (30s)')), 30000)
			),
		]);
		
		console.log("✅ 飞书 WebSocket 已连接（SDK 自动管理重连）");
		break; // 启动成功，退出循环
		
	} catch (err) {
		startRetries--;
		const errMsg = err instanceof Error ? err.message : String(err);
		
		if (startRetries === 0) {
			console.error('❌ 飞书 WebSocket 连接启动失败（已重试 10 次）:', errMsg);
			console.error('请检查网络连接和飞书凭据（FEISHU_APP_ID / FEISHU_APP_SECRET）');
			process.exit(1);
		}
		
		// 指数退避：10s, 20s, 40s, 60s, 60s, ...
		const delayMs = Math.min(10000 * Math.pow(2, 10 - startRetries - 1), 60000);
		console.warn(
			`[飞书] 连接失败，${Math.round(delayMs / 1000)}秒后重试 ` +
			`(剩余 ${startRetries} 次): ${errMsg}`
		);
		
		await new Promise(r => setTimeout(r, delayMs));
	}
}

// 注意：启动成功后，SDK 内部有自己的重连机制
// 如果 SDK 重连也失败，服务会断开，但进程不会退出
// 这是预期行为，因为：
// 1. launchd 会监控进程并重启（如果配置了 KeepAlive）
// 2. 避免因短暂网络问题导致服务频繁重启

// ── 启动自检（.cursor/BOOT.md）───────────────────────
// 已禁用：agent 进程初始化太慢，会阻塞启动
console.log("[启动] BOOT.md 自检已禁用（避免启动阻塞）");
