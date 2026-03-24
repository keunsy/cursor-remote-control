/**
 * 钉钉 Stream → Cursor Agent CLI 中继服务 v2
 *
 * 核心功能：
 * - 钉钉消息 → Cursor CLI → 钉钉回复
 * - 支持文字、语音、图片、文件
 * - 会话管理（--resume）
 * - 项目路由（传统 + 对话式）
 * - 命令系统、定时任务、心跳检测、记忆搜索
 *
 * 启动: bun run server.ts
 */

import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, watchFile, unwatchFile, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import axios from 'axios';
import { execFileSync } from 'node:child_process';
import { Scheduler, type CronJob } from '../shared/scheduler.js';
import { MemoryManager } from '../shared/memory.js';
import { fetchNews } from '../shared/news-fetcher.js';
import { getHealthStatus } from '../shared/news-sources/monitoring.js';
import { HeartbeatRunner } from '../shared/heartbeat.js';
import { FeilianController, type OperationResult } from '../shared/feilian-control.js';
import { humanizeCronInChinese } from 'cron-chinese';
import { CommandHandler, type PlatformAdapter, type CommandContext } from '../shared/command-handler.js';
import { AgentExecutor } from '../shared/agent-executor.js';
// import { ReconnectManager } from '../shared/reconnect-manager.js';  // 已移除，SDK 自带重连
import { getAvailableModelChain, shouldFallback, isQuotaExhausted, addToBlacklist, isBlacklisted, DEFAULT_MODEL, type ModelConfig } from '../shared/models-config.js';
import { uploadFileDingtalk, sendFileDingtalk } from './send-file-dingtalk.js';

const HOME = process.env.HOME!;
const ROOT = resolve(import.meta.dirname, '..');
const ENV_PATH = resolve(import.meta.dirname, '.env');
const PROJECTS_PATH = resolve(ROOT, 'projects.json');
const INBOX_DIR = resolve(ROOT, 'inbox');
const WHISPER_MODEL = resolve(HOME, 'models/ggml-tiny.bin');
const BOOT_DELAY_MS = 8000;  // 启动自检延迟，确保服务完全启动

mkdirSync(INBOX_DIR, { recursive: true });

// 清理超过 24 小时的 inbox 文件
const DAY_MS = 24 * 60 * 60 * 1000;
for (const f of readdirSync(INBOX_DIR)) {
	const p = resolve(INBOX_DIR, f);
	try {
		if (Date.now() - statSync(p).mtimeMs > DAY_MS) {
			unlinkSync(p);
			console.log(`[清理] 删除过期文件: ${f}`);
		}
	} catch {}
}

// 全局异常处理
process.on('uncaughtException', (err) => {
	console.error(`[致命异常] ${err.message}\n${err.stack}`);
});
process.on('unhandledRejection', (reason) => {
	console.error('[Promise 异常]', reason);
});

// ── 工具函数 ──────────────────────────────────────
function formatElapsed(seconds: number): string {
	if (seconds < 60) return `${seconds}秒`;
	const mins = Math.floor(seconds / 60);
	const secs = seconds % 60;
	if (mins >= 60) {
		const hrs = Math.floor(mins / 60);
		const remainMins = mins % 60;
		if (remainMins === 0 && secs === 0) return `${hrs}时`;
		if (secs === 0) return `${hrs}时${remainMins}分`;
		return `${hrs}时${remainMins}分${secs}秒`;
	}
	return secs > 0 ? `${mins}分${secs}秒` : `${mins}分钟`;
}

function isQuotaError(error: Error): boolean {
	const msg = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();
	return /insufficient.*(balance|credit|quota)|余额不足|quota.*exceeded/i.test(msg);
}

/** 解析 cron 表达式为中文描述（使用 cron-chinese 库） */
function parseCronToHuman(expr: string): string | null {
	try {
		return humanizeCronInChinese(expr);
	} catch {
		return null;
	}
}

// ── 配置 ─────────────────────────────────────────
interface EnvConfig {
	CURSOR_API_KEY: string;
	DINGTALK_APP_KEY: string;
	DINGTALK_APP_SECRET: string;
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
	const raw = readFileSync(ENV_PATH, 'utf-8');
	const env: Record<string, string> = {};
	for (const line of raw.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eqIdx = trimmed.indexOf('=');
		if (eqIdx < 0) continue;
		const key = trimmed.slice(0, eqIdx).trim();
		if (!key) continue;
		let val = trimmed.slice(eqIdx + 1).trim();
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1);
		}
		env[key] = val;
	}
	return {
		CURSOR_API_KEY: env.CURSOR_API_KEY || '',
		DINGTALK_APP_KEY: env.DINGTALK_APP_KEY || '',
		DINGTALK_APP_SECRET: env.DINGTALK_APP_SECRET || '',
		CURSOR_MODEL: env.CURSOR_MODEL || DEFAULT_MODEL, // 使用全局默认模型
		VOLC_STT_APP_ID: env.VOLC_STT_APP_ID || '',
		VOLC_STT_ACCESS_TOKEN: env.VOLC_STT_ACCESS_TOKEN || '',
		VOLC_EMBEDDING_API_KEY: env.VOLC_EMBEDDING_API_KEY || '',
		VOLC_EMBEDDING_MODEL: env.VOLC_EMBEDDING_MODEL || 'doubao-embedding-vision-250615',
	};
}

const config = loadEnv();

// .env 热更新（Bug #24 修复：保持 config 对象引用不变，只更新属性）
watchFile(ENV_PATH, { interval: 2000 }, () => {
	try {
		const prev = config.CURSOR_API_KEY;
		const prevModel = config.CURSOR_MODEL;
		const newConfig = loadEnv();
		Object.assign(config, newConfig);
		if (config.CURSOR_API_KEY !== prev) {
			const keyPreview = config.CURSOR_API_KEY ? `...${config.CURSOR_API_KEY.slice(-8)}` : '(未设置)';
			console.log(`[热更新] API Key 已更新 ${keyPreview}`);
		}
		if (config.CURSOR_MODEL !== prevModel) {
			console.log(`[热更新] 模型已切换: ${prevModel} → ${config.CURSOR_MODEL}`);
		}
	} catch (err) {
		console.error('[热更新] 加载失败:', err);
	}
});

// ── 项目配置 ─────────────────────────────────────
interface ProjectsConfig {
	projects: Record<string, { path: string; description: string }>;
	default_project: string;
}

// Bug 修复：添加 projects.json 加载错误处理
let projectsConfig: ProjectsConfig;
try {
	projectsConfig = existsSync(PROJECTS_PATH)
		? JSON.parse(readFileSync(PROJECTS_PATH, 'utf-8'))
		: { projects: { default: { path: ROOT, description: 'Default' } }, default_project: 'default' };
} catch (err) {
	console.error(`❌ 加载 projects.json 失败: ${err instanceof Error ? err.message : err}`);
	console.error(`   文件路径: ${PROJECTS_PATH}`);
	console.error(`   使用默认配置...\n`);
	projectsConfig = { 
		projects: { default: { path: ROOT, description: 'Default' } }, 
		default_project: 'default' 
	};
}

// Bug 修复：添加 projects.json 热更新监听
watchFile(PROJECTS_PATH, { interval: 5000 }, () => {
	try {
		const newConfig = JSON.parse(readFileSync(PROJECTS_PATH, 'utf-8'));
		Object.assign(projectsConfig, newConfig);
		console.log(`[热更新] projects.json 已重新加载`);
	} catch (err) {
		console.error('[热更新] projects.json 加载失败:', err);
	}
});

// ── 工作区模板自动初始化 ─────────────────────────
const TEMPLATE_DIR = resolve(ROOT, 'templates');
const WORKSPACE_FILES = [
	".cursor/SOUL.md", ".cursor/USER.md",
	".cursor/MEMORY.md", ".cursor/HEARTBEAT.md",
	".cursor/BOOT.md", ".cursor/TOOLS.md",
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
	const isOwnProject = normalizedWs === normalizedRoot;

	if (!isOwnProject) {
		return false;
	}

	try {
		mkdirSync(resolve(wsPath, ".cursor/memory"), { recursive: true });
		mkdirSync(resolve(wsPath, ".cursor/sessions"), { recursive: true });
		mkdirSync(resolve(wsPath, ".cursor/rules"), { recursive: true });

		const isNewWorkspace = !existsSync(resolve(wsPath, ".cursor/SOUL.md"));
		let copied = 0;

		const rootFiles = ["AGENTS.md"];
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

		if (copied > 0) {
			console.log(`[工作区] ${wsPath} 初始化完成 (${copied} 个文件)`);
			if (isNewWorkspace) {
				console.log("[工作区] 首次启动：.cursor/BOOTSTRAP.md 已就绪，首次对话将触发出生仪式");
			}
		}
		return isNewWorkspace;
	} catch (err) {
		console.error(`[工作区] 初始化失败: ${err instanceof Error ? err.message : err}`);
		return false;
	}
}

// ── 记忆管理器 ───────────────────────────────────
const defaultWorkspace = projectsConfig.projects[projectsConfig.default_project]?.path || ROOT;

// 记忆工作区：支持独立配置，避免污染工作项目
const memoryWorkspaceKey = (projectsConfig as any).memory_workspace || projectsConfig.default_project;
const memoryWorkspace = projectsConfig.projects[memoryWorkspaceKey]?.path || defaultWorkspace;

// 初始化记忆工作区（在记忆管理器前调用）
ensureWorkspace(memoryWorkspace);

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

// ── 最近活跃 webhook（用于定时任务/心跳主动推送）─────
// （钉钉使用 webhook 而非 chatId）

// ── 心跳系统 ──────────────────────────────────────
const heartbeat = new HeartbeatRunner({
	config: {
		enabled: false,  // 默认关闭，用户通过 /心跳 开启
		everyMs: 30 * 60_000,  // 30 分钟
		workspaceDir: memoryWorkspace, // 修复：使用 memoryWorkspace 避免污染工作项目
	},
	onExecute: async (prompt: string) => {
		memory?.appendSessionLog(memoryWorkspace, "user", "[心跳检查] " + prompt.slice(0, 200), config.CURSOR_MODEL);
		const { result, quotaWarning } = await runAgent(memoryWorkspace, prompt);
		const finalResult = quotaWarning ? `${quotaWarning}\n\n---\n\n${result}` : result;
		memory?.appendSessionLog(memoryWorkspace, "assistant", finalResult.slice(0, 3000), config.CURSOR_MODEL);
		return finalResult;
	},
	onDelivery: async (content: string) => {
		const webhook = getWebhook();
		if (!webhook) {
			console.warn("[心跳] 无活跃 webhook，跳过发送");
			return;
		}
		await sendMarkdown(webhook, content, '💓 心跳检查');
	},
	log: (msg: string) => console.log(`[心跳] ${msg}`),
});

// ── 钉钉 access_token ────────────────────────────
let accessToken = '';
let tokenExpireTime = 0;

async function refreshAccessToken() {
	try {
		const response = await axios.post('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
			appKey: config.DINGTALK_APP_KEY,
			appSecret: config.DINGTALK_APP_SECRET,
		});
		accessToken = response.data.accessToken;
		tokenExpireTime = Date.now() + response.data.expireIn * 1000;
		console.log(`[钉钉] access_token 已刷新`);
	} catch (error) {
		console.error('[钉钉] 获取 token 失败:', error);
		throw new Error(`无法获取钉钉 access_token，请检查 DINGTALK_APP_KEY 和 DINGTALK_APP_SECRET 配置`);
	}
}

async function ensureToken() {
	if (Date.now() >= tokenExpireTime - 60000) {
		await refreshAccessToken();
	}
	
	// 验证 token 是否有效
	if (!accessToken) {
		throw new Error('钉钉 access_token 未初始化，请检查配置');
	}
}

// ── 时间格式化 ───────────────────────────────────
function formatRelativeTime(ms: number): string {
	const diff = Date.now() - ms;
	if (diff < 60_000) return '刚刚';
	if (diff < 3600_000) return `${Math.floor(diff / 60_000)}分钟前`;
	if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}小时前`;
	if (diff < 604800_000) return `${Math.floor(diff / 86400_000)}天前`;
	return new Date(ms).toLocaleDateString('zh-CN');
}

// ── 模型列表与匹配 ───────────────────────────────
// ── Webhook 缓存（用于定时任务推送）───────────────
// 缓存 conversationId -> webhook 映射，定时任务可以主动推送
const webhookCache = new Map<string, { webhook: string; timestamp: number }>();
let lastActiveWebhook: string | undefined;  // 最近活跃的 webhook

function cacheWebhook(conversationId: string, webhook: string) {
	webhookCache.set(conversationId, { webhook, timestamp: Date.now() });
	lastActiveWebhook = webhook;
	
	// 清理超过 24 小时的缓存
	const now = Date.now();
	for (const [id, entry] of webhookCache.entries()) {
		if (now - entry.timestamp > 24 * 60 * 60 * 1000) {
			webhookCache.delete(id);
		}
	}
}

function getWebhook(conversationId?: string): string | undefined {
	if (conversationId) {
		const entry = webhookCache.get(conversationId);
		return entry?.webhook;
	}
	return lastActiveWebhook;  // 返回最近活跃的
}

// ── 消息发送 ─────────────────────────────────────
async function sendMarkdown(webhook: string, markdown: string, title?: string, color?: string) {
	try {
		console.log(`[发送] webhook=${webhook.slice(0, 50)} length=${markdown.length}`);
		
		// 为标题添加 emoji 前缀（模拟飞书卡片的颜色）
		const colorEmoji: Record<string, string> = {
			'blue': '🔵',
			'green': '✅',
			'red': '❌',
			'orange': '⚠️',
			'purple': '💜',
			'wathet': '🔷',
			'grey': '⚪',
		};
		const emoji = color ? colorEmoji[color] || '📌' : '📌';
		const formattedTitle = title ? `${emoji} ${title}` : 'Cursor AI';
		
		// 为内容添加轻微的分隔线样式
		const formattedText = markdown.trim();
		
		await axios.post(webhook, {
			msgtype: 'markdown',
			markdown: {
				title: formattedTitle,
				text: formattedText,
			},
		});
		console.log('[发送] 成功');
	} catch (error) {
		console.error('[发送失败]', error instanceof Error ? error.message : error);
		throw error;
	}
}

// ── 语音识别 ─────────────────────────────────────
async function transcribeAudio(audioPath: string): Promise<string | null> {
	// TODO: 集成火山引擎 STT
	// 目前只用本地 whisper
	try {
		if (!existsSync(WHISPER_MODEL)) {
			console.warn('[STT] whisper 模型不存在，跳过识别');
			return null;
		}
		const result = execFileSync('whisper-cpp', [
			'-m', WHISPER_MODEL,
			'-f', audioPath,
			'-l', 'zh',
			'--output-txt'
		], { encoding: 'utf-8', timeout: 30000 });
		return (result || '').trim();
	} catch (error) {
		console.error('[STT] whisper 识别失败:', error);
		return null;
	}
}

// ── 下载文件 ─────────────────────────────────────
async function downloadFile(downloadCode: string, ext: string): Promise<string> {
	try {
		await ensureToken();
		const response = await axios.get(
			`https://api.dingtalk.com/v1.0/robot/messageFiles/download`,
			{
				params: { downloadCode },
				headers: { 'x-acs-dingtalk-access-token': accessToken },
				responseType: 'arraybuffer',
				timeout: 30000,
			}
		);
		const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
		const filepath = resolve(INBOX_DIR, filename);
		writeFileSync(filepath, Buffer.from(response.data));
		console.log(`[下载] 文件已保存: ${filepath}`);
		return filepath;
	} catch (error) {
		console.error('[下载失败]', error);
		throw new Error(`文件下载失败: ${error instanceof Error ? error.message : '未知错误'}`);
	}
}

// ── 会话管理 ─────────────────────────────────────
interface Session {
	agentId?: string;
	workspace: string;
	currentProject?: string;  // 当前项目（对话式路由持久切换）
}

const sessions = new Map<string, Session>();

function getSession(conversationId: string, senderId: string, workspace: string): Session {
	const key = `dingtalk_${conversationId}_${senderId}`;
	if (!sessions.has(key)) {
		sessions.set(key, { workspace });
	}
	return sessions.get(key)!;
}

// ── 会话历史管理（用于 /会话 命令）───────────────
const SESSIONS_PATH = resolve(import.meta.dirname, '.sessions.json');
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
	currentProject?: string;
}

const sessionsStore: Map<string, WorkspaceSessions> = new Map();

function loadSessionsFromDisk(): void {
	try {
		if (!existsSync(SESSIONS_PATH)) return;
		const raw = JSON.parse(readFileSync(SESSIONS_PATH, 'utf-8'));
		sessionsStore.clear();
		for (const [k, v] of Object.entries(raw)) {
			if (typeof v === 'string') {
				sessionsStore.set(k, {
					active: v,
					history: [{ id: v, createdAt: Date.now(), lastActiveAt: Date.now(), summary: '(旧会话)' }],
				});
			} else {
				sessionsStore.set(k, v as WorkspaceSessions);
			}
		}
		console.log(`[Session] 从磁盘恢复 ${sessionsStore.size} 个工作区会话`);
	} catch {}
}

function saveSessions(): void {
	try {
		writeFileSync(SESSIONS_PATH, JSON.stringify(Object.fromEntries(sessionsStore), null, 2));
	} catch (err) {
		console.error('[Session] 保存到磁盘失败:', err instanceof Error ? err.message : err);
	}
}

loadSessionsFromDisk();

function getActiveSessionId(workspace: string): string | undefined {
	return sessionsStore.get(workspace)?.active || undefined;
}

function setActiveSession(workspace: string, sessionId: string, summary?: string): void {
	let ws = sessionsStore.get(workspace);
	if (!ws) {
		ws = { active: null, history: [] };
		sessionsStore.set(workspace, ws);
	}
	
	const existing = ws.history.find(h => h.id === sessionId);
	if (existing) {
		existing.lastActiveAt = Date.now();
		if (summary && existing.summary === '(新会话)') {
			existing.summary = summary;
		}
	} else {
		ws.history.unshift({
			id: sessionId,
			createdAt: Date.now(),
			lastActiveAt: Date.now(),
			summary: summary || '(新会话)',
		});
	}
	
	if (ws.history.length > MAX_SESSION_HISTORY) {
		ws.history = ws.history.slice(0, MAX_SESSION_HISTORY);
	}
	
	ws.active = sessionId;
	saveSessions();
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
	const entry = ws.history.find(h => h.id === sessionId);
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

// ── 并发控制 ─────────────────────────────────────
function getLockKey(workspace: string): string {
	const sid = getActiveSessionId(workspace);
	return sid ? `session:${sid}` : `ws:${workspace}`;
}

// 同一 session 的消息串行执行；不同 session（即使同工作区）可并行
const sessionLocks = new Map<string, Promise<void>>();
async function withSessionLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
	const prev = sessionLocks.get(lockKey) || Promise.resolve();
	let release!: () => void;
	const next = new Promise<void>((r) => { release = r; });
	sessionLocks.set(lockKey, next);
	await prev;
	try {
		return await fn();
	} finally {
		release();
	}
}

// 同会话串行执行，不同会话可并行
const busySessions = new Set<string>();

// 追踪运行中的 agent 进程（用于 /终止）
const activeAgents = new Map<string, { pid: number | undefined; kill: () => void; workspace: string }>();
const childPids = new Set<number>();

// 统一 Agent 执行器（超时保护、并发限制、僵尸清理）
const agentExecutor = new AgentExecutor({
	timeout: 60 * 60 * 1000, // 60 分钟（统一超时）
	maxConcurrent: 10, // 提高并发限制
});

// 优雅退出
process.on('SIGINT', async () => {
	console.log('\n[退出] 正在清理资源...');

	// 终止所有运行中的 Agent 进程（使用统一执行器）
	const active = agentExecutor.getActiveAgents();
	if (active.length > 0) {
		console.log(`[退出] 正在终止 ${active.length} 个运行中的任务...`);
		agentExecutor.killAll();
		activeAgents.clear();
		busySessions.clear();
	}

	// 停止文件监听器
	unwatchFile(ENV_PATH);
	unwatchFile(PROJECTS_PATH);
	console.log('[退出] 文件监听器已停止');

	// 停止心跳和定时任务
	heartbeat.stop();
	scheduler.stop();

	// 关闭记忆系统
	if (memory) {
		try {
			memory.close();
			console.log('[退出] 记忆系统已关闭');
		} catch (err) {
			console.error('[退出] 记忆系统关闭失败:', err);
		}
	}

	// 断开钉钉连接
	try {
		if (typeof (client as any).disconnect === 'function') {
			(client as any).disconnect();
		}
		console.log('[退出] 钉钉连接已断开');
	} catch (err) {
		console.error('[退出] 断开连接失败:', err);
	}

	console.log('[退出] 清理完成，再见！');
	process.exit(0);
});

process.on('SIGTERM', () => {
	console.log('[退出] 收到 SIGTERM');
	process.exit(0);
});

// ── 工具调用描述辅助函数 ──────────────────────────
const TOOL_LABELS: Record<string, string> = {
	read: "📖 读取", write: "✏️ 写入", strReplace: "✏️ 编辑",
	shell: "⚡ 执行", grep: "🔍 搜索", glob: "📂 查找",
	semanticSearch: "🔎 语义搜索", webSearch: "🌐 搜索网页", webFetch: "🌐 抓取网页",
	delete: "🗑️ 删除", editNotebook: "📓 编辑笔记本",
	callMcpTool: "🔌 MCP工具", task: "🤖 子任务",
};

function basename(p: string): string {
	const parts = p.split("/");
	return parts[parts.length - 1] || p;
}

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
	const lines: string[] = ['📋 **本次操作：**'];
	for (const { emoji, items } of groups.values()) {
		const label = Object.values(TOOL_LABELS).find(l => l.startsWith(emoji))?.replace(/^.+?\s/, '') || '操作';
		lines.push(`${emoji} **${label}** (${items.length}个)：`);
		for (const item of items) {
			lines.push(`  · ${item}`);
		}
	}
	
	return lines.join('\n');
}

// ── Cursor Agent 调用（基于飞书的稳定实现）────────
interface RunAgentResult {
	result: string;
	quotaWarning?: string;
}

async function runAgent(
	workspace: string,
	message: string,
	agentId?: string,
	context?: {
		platform?: string;
		webhook?: string;
		/** 成功完成时回调，用于更新 session.agentId 以便后续 --resume */
		onSessionId?: (sessionId: string) => void;
	}
): Promise<RunAgentResult> {
	const primaryModel = config.CURSOR_MODEL || DEFAULT_MODEL;

	// 安全调用 session ID 回调，失败时不中断主流程
	const notifySession = (out: { sessionId?: string }) => {
		if (out.sessionId && context?.onSessionId) {
			try {
				context.onSessionId(out.sessionId);
			} catch (err) {
				console.error('[onSessionId 回调失败]', err);
			}
		}
	};

	async function runWithModel(model: string): Promise<{ result: string; sessionId?: string }> {
		console.log(`[CLI] 启动 agent 进程，model=${model}, resume=${!!agentId}`);
		
		try {
			const result = await agentExecutor.execute({
				workspace,
				model,
				prompt: message,
				sessionId: agentId,
				platform: context?.platform as 'dingtalk' | undefined,
				webhook: context?.webhook,
				apiKey: config.CURSOR_API_KEY,
			});
			
			// 构建工具调用摘要（添加到回复开头）
			let finalOutput = result.result;
			if (result.toolSummary && result.toolSummary.length > 0) {
				const summary = buildToolSummary(result.toolSummary);
				if (summary) {
					finalOutput = summary + '\n\n---\n\n' + result.result;
				}
			}
			
			return {
				result: finalOutput,
				sessionId: result.sessionId,
			};
		} catch (err) {
			throw err;
		}
	}

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
			
			const out = await runWithModel(model.id);
			notifySession(out);
			
			// 成功执行，检查是否使用了 fallback
			if (isFallback) {
				// 如果是因为黑名单跳过的，静默切换，不提示
				if (wasBlacklisted && i === 0) {
					return { result: out.result };
				}
				
				// 如果是运行中失败导致的 fallback，显示提示
				let reason = '';
				if (skippedModels.length > 0 && !wasBlacklisted) {
					reason = `\`${skippedModels.join('`, `')}\` 配额用尽`;
				} else {
					reason = `\`${primaryModel}\` 失败`;
				}
				const fallbackMsg = `⚠️ **模型降级**\n\n${reason}，已改用 \`${model.id}\` 完成。`;
				return { result: out.result, quotaWarning: fallbackMsg };
			}
			
			return { result: out.result };
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

// ── 对话式路由识别 ───────────────────────────────
interface RouteIntent {
	type: 'switch' | 'temp' | 'none';  // switch=持久切换, temp=临时路由, none=无路由
	project?: string;  // 项目名
	path?: string;  // 任意路径（用于临时切换）
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
	const raw = (text || '').trim().replace(/\s+/g, ' ');
	const { projects } = projectsConfig;
	const projectNames = Object.keys(projects);
	const sortedNames = projectNames.sort((a, b) => b.length - a.length);
	const projectPattern = sortedNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
	
	// 0. 路径快捷语法：#/path 或 @/path
	const pathSymbolMatch = raw.match(/^[#@]((?:~?\/|~).+?)\s+(.+)$/);
	if (pathSymbolMatch) {
		const rawPath = pathSymbolMatch[1];
		const rest = pathSymbolMatch[2];
		if (rawPath === undefined || rest === undefined) {
			return { type: 'none', cleanedText: text };
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
			return { type: 'none', cleanedText: text };
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
	
	// 2a. 切换到任意路径（必须以 / 或 ~ 开头，避免误匹配 "切换到 remote"）
	const pathSwitchMatch = raw.match(/^(?:切换到|切到|切换|进入|打开)(?:路径)?\s+([~\/].+?)\s*$/i);
	if (pathSwitchMatch) {
		const p1 = pathSwitchMatch[1];
		if (p1 === undefined) {
			return { type: 'none', cleanedText: text };
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
	
	return { type: 'none', cleanedText: text };
}

// ── 项目路由 ─────────────────────────────────────
function resolveWorkspace(
	text: string,
	currentProject?: string,
	intent?: RouteIntent
): { workspace: string; message: string; label: string; routeChanged?: boolean; intent: RouteIntent } {
	const { projects, default_project } = projectsConfig;
	
	// 1. 传统路由：/项目名 消息
	const slashMatch = text.match(/^\/(\w+)\s+(.+)$/s);
	const slashProj = slashMatch?.[1];
	const slashMsg = slashMatch?.[2];
	if (slashProj && slashMsg && projects[slashProj.toLowerCase()]) {
		const key = slashProj.toLowerCase();
		const projEntry = projects[key];
		if (!projEntry) {
			return {
				workspace: projects[default_project]?.path || ROOT,
				message: text.trim(),
				label: default_project,
				intent: intent || { type: 'none', cleanedText: text.trim() },
			};
		}
		return {
			workspace: projEntry.path,
			message: slashMsg.trim(),
			label: key,
			routeChanged: true,
			intent: intent || { type: 'none', cleanedText: slashMsg.trim() },
		};
	}
	
	// 2. 对话式路由（使用传入的 intent，避免重复检测）
	const routeIntent = intent || detectRouteIntent(text);
	
	// 2a. 路径型路由（临时切换到任意目录）
	if (routeIntent.type !== 'none' && routeIntent.path) {
		const pathLabel = routeIntent.path.split('/').pop() || routeIntent.path;
		return {
			workspace: routeIntent.path,
			message: routeIntent.cleanedText || text,
			label: `📁${pathLabel}`,
			routeChanged: routeIntent.type === 'switch',
			intent: routeIntent,
		};
	}
	
	// 2b. 项目名路由
	if (routeIntent.type !== 'none' && routeIntent.project) {
		const rp = projects[routeIntent.project];
		if (!rp) {
			return {
				workspace: projects[default_project]?.path || ROOT,
				message: text.trim(),
				label: default_project,
				intent: routeIntent,
			};
		}
		return {
			workspace: rp.path,
			message: routeIntent.cleanedText || text,
			label: routeIntent.project,
			routeChanged: routeIntent.type === 'switch',
			intent: routeIntent,
		};
	}
	
	// 3. 使用当前项目（如果有）
	if (currentProject && projects[currentProject]) {
		return {
			workspace: projects[currentProject].path,
			message: text.trim(),
			label: currentProject,
			intent: routeIntent,
		};
	}
	
	// 4. 默认项目
	const defaultProj = projects[default_project];
	return {
		workspace: defaultProj?.path || ROOT,
		message: text.trim(),
		label: default_project,
		intent: routeIntent,
	};
}

// ── 定时任务文件位置修正 ─────────────────────────
async function fixCronJobsLocation(workspace: string, webhook: string) {
	// 检查工作区是否有 cron-jobs.json（错误位置）
	const wrongPath = resolve(workspace, 'cron-jobs.json');
	const correctPath = resolve(ROOT, 'cron-jobs-dingtalk.json');
	
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
		if (job.platform && job.platform !== 'dingtalk') {
			console.log(`[修正] 跳过 ${job.platform} 平台的任务: ${job.name}`);
			continue;
		}
		
		// 添加缺失的 platform 和 webhook 字段
		if (!job.platform) {
			job.platform = 'dingtalk';
			fixedCount++;
		}
		if (!job.webhook) {
			job.webhook = webhook;
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

// ── 消息去重（使用 Map 存储时间戳）─────────────
const seenMessages = new Map<string, number>();
const MAX_SEEN_SIZE = 1000;

function isDuplicate(messageId: string): boolean {
	const now = Date.now();

	// 清理超过 5 分钟的旧消息
	for (const [id, timestamp] of seenMessages.entries()) {
		if (now - timestamp > 5 * 60 * 1000) {
			seenMessages.delete(id);
		}
	}

	// 检查是否重复
	if (seenMessages.has(messageId)) {
		const age = now - seenMessages.get(messageId)!;
		console.log(`[去重] ❌ 重复消息 msgId="${messageId}" (${Math.round(age/1000)}秒前已处理)`);
		return true;
	}

	// 记录新消息
	seenMessages.set(messageId, now);
	console.log(`[去重] ✅ 新消息 msgId="${messageId}" (缓存: ${seenMessages.size})`);

	// 防止内存泄漏：超过上限时删除最旧的
	if (seenMessages.size > MAX_SEEN_SIZE) {
		const oldest = Array.from(seenMessages.entries()).sort((a, b) => a[1] - b[1])[0];
		if (oldest) seenMessages.delete(oldest[0]);
	}

	return false;
}

// ── 消息处理 ─────────────────────────────────────
async function handleMessage(msg: any) {
	const data = JSON.parse(msg.data);
	
	// 钉钉的 messageId 在 data 中，不是 headers 中
	const messageId = data.msgId || data.messageId || 'unknown';
	
	if (isDuplicate(messageId)) {
		console.log(`[去重] ⏭️  跳过重复消息`);
		return;
	}
	
	// 数据完整性检查
	if (!data || typeof data !== 'object') {
		console.error('[消息] 数据格式错误:', data);
		return;
	}
	
	const conversationId = data.conversationId;
	const senderId = data.senderStaffId || data.senderId;
	const sessionWebhook = data.sessionWebhook;
	const msgtype = data.msgtype;
	
	if (!conversationId || !senderId || !sessionWebhook || !msgtype) {
		console.error('[消息] 缺少必要字段:', { conversationId, senderId, sessionWebhook, msgtype });
		return;
	}
	
	const chatType = data.conversationType === '1' ? 'private' : 'group';  // 1=单聊, 2=群聊
	const isGroup = chatType === 'group';
	
	// 缓存 webhook（用于定时任务推送）
	cacheWebhook(conversationId, sessionWebhook);
	
	console.log(`[收到消息] msgId=${messageId.slice(0, 20)} type=${msgtype} chatType=${chatType} conversation=${conversationId.slice(0, 20)} sender=${senderId} webhook=${sessionWebhook.slice(0, 50)}`);
	
	try {
		// 解析消息内容
		let text = '';
		let needsProcessing = false;
		
		switch (msgtype) {
			case 'text':
				text = data.text?.content || '';
				break;
				
		case 'picture':
			await sendMarkdown(sessionWebhook, '📷 正在处理图片...', '处理中', 'wathet');
			try {
				if (!data.content?.downloadCode) {
					throw new Error('图片下载码缺失');
				}
				const imagePath = await downloadFile(data.content.downloadCode, '.jpg');
				const instruction = "\n\n**注意**：这张图片来自钉钉消息系统的临时存储，请直接用 Read 工具读取分析，不要复制到当前工作区。";
				text = `用户发了一张图片：${imagePath}${instruction}\n\n请查看并回复。`;
			} catch (error) {
				await sendMarkdown(sessionWebhook, `❌ 图片下载失败: ${error instanceof Error ? error.message : '未知错误'}`, '失败', 'red');
				return;
			}
			break;
				
		case 'audio':
			await sendMarkdown(sessionWebhook, '🎙️ 正在识别语音...', '识别中', 'wathet');
			try {
				if (!data.content?.downloadCode) {
					throw new Error('语音下载码缺失');
				}
				const audioPath = await downloadFile(data.content.downloadCode, '.amr');
				const transcript = await transcribeAudio(audioPath);
				try { unlinkSync(audioPath); } catch {}  // 清理临时文件
				if (transcript) {
					text = transcript;
					console.log(`[语音] 识别成功: ${transcript.slice(0, 60)}`);
				} else {
					await sendMarkdown(sessionWebhook, '❌ 语音识别失败，请用文字重新发送', '识别失败', 'red');
					return;
				}
			} catch (error) {
				await sendMarkdown(sessionWebhook, `❌ 语音处理失败: ${error instanceof Error ? error.message : '未知错误'}`, '失败', 'red');
				return;
			}
			break;
				
		case 'file':
			const fileName = data.content?.fileName || '未命名文件';
			try {
				if (!data.content?.downloadCode) {
					throw new Error('文件下载码缺失');
				}
				const filePath = await downloadFile(data.content.downloadCode, '');
				text = `用户发了文件 ${fileName}，已保存到 ${filePath}`;
			} catch (error) {
				await sendMarkdown(sessionWebhook, `❌ 文件下载失败: ${error instanceof Error ? error.message : '未知错误'}`, '失败', 'red');
				return;
			}
			break;
				
			default:
				await sendMarkdown(sessionWebhook, `暂不支持消息类型: ${msgtype}`, '不支持', 'grey');
				return;
		}
		
		if (!text.trim()) {
			console.warn('[处理] 消息内容为空');
			return;
		}
		
	// 先获取会话，读取当前项目
	const defaultWorkspace = projectsConfig.projects[projectsConfig.default_project]?.path || ROOT;
	const session = getSession(conversationId, senderId, defaultWorkspace);
	const currentProject = session.currentProject;
	
	// === 命令系统（使用统一的 CommandHandler）===
	
	// 创建钉钉平台适配器（支持文件发送）
	const dingtalkAdapter: PlatformAdapter = {
		reply: async (content: string, options?: { title?: string; color?: string }) => {
			await sendMarkdown(sessionWebhook, content, options?.title, options?.color);
		},
		sendFile: async (filePath: string, fileName?: string) => {
			await ensureToken();
			const { mediaId } = await uploadFileDingtalk({
				filePath,
				accessToken,
				type: 'file',
			});
			await sendFileDingtalk(sessionWebhook, mediaId, fileName || filePath.split('/').pop() || 'file');
			console.log(`[钉钉] 文件已发送: ${fileName || filePath}`);
		},
	};
	
	// 创建命令上下文
	const commandContext: CommandContext = {
		platform: 'dingtalk',
		projectsConfig,
		defaultWorkspace,
		memoryWorkspace,
		config,
		scheduler,
		memory: memory || null,
		heartbeat,
		activeAgents,
		busySessions,
		sessionsStore,
		getCurrentProject: (ws: string) => {
			const s = getSession(conversationId, senderId, ws);
			return s.currentProject || null;
		},
		getLockKey,
		archiveAndResetSession,
		getSessionHistory,
		getActiveSessionId: (ws: string) => getActiveSessionId(ws) || null,
		switchToSession,
		rootDir: ROOT,
		agentExecutor, // 统一 Agent 执行器
	};
	
	// 创建命令处理器
	const commandHandler = new CommandHandler(dingtalkAdapter, commandContext);
	
	// Bug #26 修复：/apikey 群聊保护（钉钉特定）
	const apikeyMatch = text.match(/^\/?(?:apikey|api\s*key|密钥|换key|更换密钥)[\s:：]*(.*)/i);
	if (apikeyMatch) {
		if (isGroup) {
			await sendMarkdown(sessionWebhook, '⚠️ **安全提醒：请勿在群聊中发送 API Key！**\n\n请在与机器人的 **私聊** 中发送 `/密钥` 指令。', '⚠️ 安全提醒', 'red');
			return;
		}
		// 私聊模式：委托给统一处理器（不需要更新 session）
		await commandHandler.route(text, () => {});
		return;
	}
	
	// 尝试路由到命令处理器
	const handled = await commandHandler.route(text, (newSessionId: string) => {
		session.agentId = newSessionId;
	});
	
	if (handled) {
		console.log('[命令] 已通过统一处理器处理');
		return;
	}
	
	// === 以下是平台特定逻辑（项目切换、定时新闻等）===
	
	// 对话式路由识别（只调用一次）
	const routeIntent = detectRouteIntent(text);
		
		// 持久切换到任意路径：提示用户这是临时切换
		if (routeIntent.type === 'switch' && routeIntent.path) {
			const pathLabel = routeIntent.path.split('/').pop() || routeIntent.path;
			const msg = `**📂 临时切换到路径：${pathLabel}**\n\n📁 \`${routeIntent.path}\`\n\n⚠️ 此为临时路径，不会保存到持久配置。\n若要固定使用，请添加到 \`projects.json\`。\n\n下一条消息将在此路径执行。`;
			await sendMarkdown(sessionWebhook, msg, '📂 临时切换', 'blue');
			console.log(`[路由] 临时切换到路径: ${routeIntent.path}`);
			return;
		}
		
		// 持久切换到项目：直接切换项目并确认
		if (routeIntent.type === 'switch' && routeIntent.project) {
			const projectInfo = projectsConfig.projects[routeIntent.project];
			if (!projectInfo) {
				// 项目不存在
				const names = Object.keys(projectsConfig.projects);
				await sendMarkdown(sessionWebhook, `未找到项目「${routeIntent.project}」。\n\n可用项目（长按复制）：\n\`\`\`\n${names.join('\n')}\n\`\`\`\n\n请检查 \`projects.json\` 或使用上述项目名。`, '未找到项目', 'orange');
				return;
			}
			
			// 检查项目路径是否存在
			if (!existsSync(projectInfo.path)) {
				await sendMarkdown(sessionWebhook, `**❌ 切换失败**\n\n项目路径不存在：\`${projectInfo.path}\`\n\n请检查 \`projects.json\` 配置。`, '❌ 切换失败', 'red');
				return;
			}
			
			// 更新当前项目
			session.currentProject = routeIntent.project;

			const msg = `**✅ 已切换到项目：${routeIntent.project}**\n\n📁 ${projectInfo.description}\n\n路径（长按复制）：\n\`\`\`\n${projectInfo.path}\n\`\`\`\n\n后续消息将在此项目中执行，直到你切换到其他项目。`;
			await sendMarkdown(sessionWebhook, msg, '✅ 项目已切换', 'green');
			console.log(`[路由] 持久切换到项目: ${routeIntent.project}`);
			return;
		}

		// 检测相对时间新闻推送（X分钟后推送热点、X小时后推送新闻）
		const relativeNewsMatch = text.match(/(\d+)\s*(分钟|小时)(?:[后以]后|后)\s*(?:推送|发送)?\s*(?:前|top)?\s*(\d+)?\s*条?\s*(?:今日)?\s*(热点|新闻|热榜)/i);
		if (relativeNewsMatch) {
			const numStr = relativeNewsMatch[1];
			const unit = relativeNewsMatch[2];
			const topNStr = relativeNewsMatch[3];
			if (numStr && unit) {
			const num = parseInt(numStr, 10);
			const topN = topNStr ? Math.min(50, Math.max(1, parseInt(topNStr, 10))) : 15;
			const minutes = unit === '小时' ? num * 60 : num;
			const runAtMs = Date.now() + minutes * 60 * 1000;
			const runAt = new Date(runAtMs);
			const timeDesc = `${num}${unit}后（${runAt.toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' })}）`;
			
			const msg = JSON.stringify({ type: 'fetch-news', options: { topN } });
			await scheduler.add({
				name: '热点新闻推送',
				enabled: true,
				deleteAfterRun: true, // 相对时间任务执行一次后删除
				schedule: { kind: 'at', at: runAt.toISOString() },
				message: msg,
				platform: 'dingtalk',
				webhook: sessionWebhook,
			});
			await sendMarkdown(
				sessionWebhook,
				`✅ 已创建定时任务\n\n⏰ 执行时间：${timeDesc}\n📰 推送内容：今日热点新闻（前 ${topN} 条）\n📱 到时会通过**钉钉**提醒你\n\n发送 \`/任务\` 可查看所有任务`,
				'⏰ 定时任务已创建',
				'green'
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
			let schedule: { kind: 'cron'; expr: string; tz?: string } | { kind: 'at'; at: string };
			let timeDesc: string;
			if (when === '每天' || when === '每日') {
				const hour = toNum(hourStr);
				const hour24 = ap === '下午' ? (hour % 12) + 12 : hour;
				schedule = { kind: 'cron', expr: `0 ${hour24} * * *`, tz: 'Asia/Shanghai' };
				timeDesc = `每天 ${hour24}:00`;
			} else {
				let hour = toNum(hourStr);
				if (ap === '下午') hour = (hour % 12) + 12;
				const d = new Date();
				d.setDate(d.getDate() + 1);
				d.setHours(hour, 0, 0, 0);
				schedule = { kind: 'at', at: d.toISOString() };
				timeDesc = `明天 ${hour}:00`;
			}
			const message = JSON.stringify({ type: 'fetch-news', options: { topN } });
			await scheduler.add({
				name: '热点新闻推送',
				enabled: true,
				deleteAfterRun: false,
				schedule,
				message,
				platform: 'dingtalk',
				webhook: sessionWebhook,
			});
			await sendMarkdown(
				sessionWebhook,
				`✅ 已创建定时任务\n\n⏰ 执行时间：${timeDesc}\n📰 推送内容：今日热点新闻（前 ${topN} 条）\n📱 到时会通过**钉钉**提醒你\n\n发送 \`/任务\` 可查看所有任务`,
				'⏰ 定时任务已创建',
				'green'
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
			await scheduler.add({
				name: '工作日提醒',
				enabled: true,
				deleteAfterRun: false,
				schedule: { kind: 'cron', expr: `${minute} ${hour} * * 1-5`, tz: 'Asia/Shanghai' },
				message: taskMessage.trim(),
				platform: 'dingtalk',
				webhook: sessionWebhook,
			});
			const timeDesc = `${hour}:${String(minute).padStart(2, '0')}`;
			await sendMarkdown(sessionWebhook, `✅ 已设置好，**每个工作日 ${timeDesc}** 通过钉钉提醒你：\n\n${taskMessage.trim()}\n\n发送 \`/cron\` 可查看所有任务。`, '⏰ 定时任务已创建');
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
			const minutes = unit === '小时' ? parseInt(num, 10) * 60 : parseInt(num, 10);
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
				finalMessage = JSON.stringify({ type: 'fetch-news', options: { topN } });
				taskName = '热点新闻推送';
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
				schedule: { kind: 'at', at: runAt.toISOString() },
				message: finalMessage,
				platform: 'dingtalk',
				webhook: sessionWebhook,
			});
			
			const timeStr = runAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
			const content = isNewsRequest ? `今日热点新闻（前 ${JSON.parse(finalMessage).options.topN} 条）` : taskMessage;
			await sendMarkdown(sessionWebhook, `✅ 已设置好，大约在 **${timeStr}** 通过钉钉提醒你：\n\n${content}\n\n发送 \`/cron\` 可查看所有任务。`, '⏰ 定时任务已创建');
			console.log(`[任务] 服务器端创建: ${task.name} @ ${timeStr}`);
			return;
			}
		}
		
		// 解析项目路由（传入 intent 避免重复检测）
		let { workspace, message, label, intent } = resolveWorkspace(text, currentProject, routeIntent);

		// 检测定时任务请求，强制使用 cursor-remote-control 工作区（规则文件所在）
		const isScheduleRequest = /([0-9]+|一|二|三|四|五|六|七|八|九|十)(分钟|小时|天|周|月).*(后|提醒|通知|告诉)|每(天|周|月|小时).*[提醒通知]|定时/i.test(text);
		if (isScheduleRequest) {
			workspace = ROOT;
			console.log(`[路由] 定时任务请求 → 强制使用全局工作区: ${workspace}`);
		}

	// 临时路由提示
	if (intent.type === 'temp') {
		console.log(`[路由] 临时路由到项目: ${label}`);
	}
	
	// 检查路由后的 message 是否还是命令（处理 "项目名:/命令" 格式）
	if (message !== text) {
		const handled = await commandHandler.route(message, (newSessionId: string) => {
			session.agentId = newSessionId;
		});
		if (handled) {
			console.log('[命令] 路由后的命令已通过统一处理器处理');
			return;
		}
	}
	
	// 未知指令 → 友好提示
	if (message.startsWith('/')) {
		const cmd = message.split(/[\s:：]/)[0];
		await sendMarkdown(sessionWebhook, `未知指令 \`${cmd}\`\n\n发送 \`/帮助\` 查看所有可用指令。`, '❓ 未知指令');
		return;
	}
	
	// Bug #29 修复：添加 lockKey 定义
	let lockKey = getLockKey(workspace);
	
	// 使用会话锁确保串行执行
		await withSessionLock(lockKey, async () => {
			busySessions.add(lockKey);
	
	console.log(`[执行] workspace=${workspace} message="${message.slice(0, 60)}"`);
	
	await sendMarkdown(sessionWebhook, '⏳ Cursor AI 正在思考...', '💭 思考中', 'wathet');
	
	// 记忆由 Cursor 自主通过 memory-tool.ts 调用，server 记录会话日志
	if (memory) {
		memory.appendSessionLog(workspace, "user", message, config.CURSOR_MODEL);
	}
	
	// ── 出生仪式检查 ─────────────────────────────────
	let isBootstrap = false;
	const bootstrapPath = resolve(workspace, ".cursor/BOOTSTRAP.md");
	if (existsSync(bootstrapPath)) {
		// 读取 BOOTSTRAP.md 内容，当前仅用于非空判断
		// 未来可考虑将内容注入 prompt（类似 BOOT.md 实现）
		const bootstrapContent = readFileSync(bootstrapPath, "utf-8").trim();
		if (bootstrapContent) {
			console.log("[出生仪式] 检测到 BOOTSTRAP.md，首次对话");
			
			// 将用户消息和出生仪式结合
			const combinedPrompt = [
				"🎂 这是你的第一次对话（出生仪式）。",
				"",
				"请阅读 .cursor/BOOTSTRAP.md 的指引，然后回应用户的消息。",
				"",
				`用户说：${message}`,
			].join("\n");
			
			// 使用组合提示词
			message = combinedPrompt;
			isBootstrap = true;
		}
	}
	
	try {
		const agentStart = Date.now();
		
		const { result, quotaWarning } = await runAgent(workspace, message, session.agentId, {
			platform: 'dingtalk',
			webhook: sessionWebhook,
			onSessionId: (sid) => {
				session.agentId = sid;
				setActiveSession(workspace, sid, message.slice(0, 40));
				// Bug 修复: sessionId 创建后，需更新 activeAgents 和 busySessions 的 key
				const oldLockKey = lockKey;
				const newLockKey = `session:${sid}`;
				if (oldLockKey !== newLockKey) {
					const agent = activeAgents.get(oldLockKey);
					if (agent) {
						activeAgents.delete(oldLockKey);
						activeAgents.set(newLockKey, agent);
					}
					if (busySessions.has(oldLockKey)) {
						busySessions.delete(oldLockKey);
						busySessions.add(newLockKey);
					}
					lockKey = newLockKey; // 更新闭包变量，让 finally 使用新 key
					console.log(`[lockKey] 更新: ${oldLockKey} → ${newLockKey}`);
				}
			},
		});
		
		const agentElapsedMs = Date.now() - agentStart;
		const elapsed = formatElapsed(Math.round(agentElapsedMs / 1000));
		const title = quotaWarning ? `⚠️ 完成 · ${elapsed}（已降级）` : `✅ 完成 · ${elapsed}`;
		console.log(`[完成] model=${quotaWarning ? 'auto' : config.CURSOR_MODEL} elapsed=${elapsed} (${result.length} chars)`);

			// 如果是出生仪式，删除 BOOTSTRAP.md
			if (isBootstrap) {
				try {
					unlinkSync(resolve(workspace, ".cursor/BOOTSTRAP.md"));
					console.log("[出生仪式] BOOTSTRAP.md 已删除，出生仪式完成");
				} catch (e) {
					console.warn(`[出生仪式] 删除 BOOTSTRAP.md 失败: ${e}`);
				}
			}

		let cleanOutput = result.trim();
		if (quotaWarning) {
			cleanOutput = `${quotaWarning}\n\n---\n\n${cleanOutput}`;
		}
			
			// 记录 assistant 回复到会话日志
			if (memory) {
				memory.appendSessionLog(workspace, "assistant", cleanOutput.slice(0, 3000), config.CURSOR_MODEL);
			}
			
			// Agent 可能修改了 cron-jobs，检查并修正位置
			await fixCronJobsLocation(workspace, sessionWebhook);
			
			// 重新加载调度器
			scheduler.reload().catch(() => {});
			
			// 发送结果
			if (cleanOutput) {
				// 分片发送（钉钉 Markdown 有长度限制）
				const chunks = splitMarkdown(cleanOutput, 4000);
				const completionColor = quotaWarning ? 'orange' : 'green';
				for (let i = 0; i < chunks.length; i++) {
					const piece = chunks[i];
					if (piece === undefined) continue;
					const chunkTitle = chunks.length > 1
						? (i === chunks.length - 1 ? title : `Cursor AI (${i + 1}/${chunks.length})`)
						: title;
					await sendMarkdown(sessionWebhook, piece, chunkTitle, completionColor);
					if (i < chunks.length - 1) {
						await new Promise(resolve => setTimeout(resolve, 500));
					}
				}
			} else {
				await sendMarkdown(sessionWebhook, '✅ 任务已完成（无输出）', title, quotaWarning ? 'orange' : 'green');
			}
		} finally {
			busySessions.delete(lockKey);
		}
		}); // 闭合 withSessionLock
		
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		
		// 手动终止的任务不需要发送错误消息（用户已经收到"已终止"的回复）
		if (msg === 'MANUALLY_STOPPED') {
			console.log(`[手动终止] workspace=${workspace} lockKey=${lockKey}`);
			return;
		}
		
		console.error(`[失败] ${msg.slice(0, 200)}`);

		if (!sessionWebhook) {
			console.error('[失败] 无 webhook，无法发送错误引导');
			return;
		}

		// API Key 失效引导
		if (/api.?key|authentication|unauthorized|invalid.*key/i.test(msg)) {
			const guide =
				`❌ **API Key 失效**\n\n` +
				`请更换 Key：\n\n` +
				`1. 打开 [Cursor Dashboard](https://cursor.com/dashboard)\n` +
				`2. 生成新 Key\n` +
				`3. 发送 \`/密钥 新Key\`\n\n` +
				`错误详情：\n\`\`\`\n${msg.slice(0, 200)}\n\`\`\``;

			try {
				await sendMarkdown(sessionWebhook, guide, '❌ Key 失效', 'red');
			} catch (sendErr) {
				console.error('[sendMarkdown 失败]', sendErr);
			}
			return;
		}

		// 超时错误引导
		if (/timeout|超时|timed out/i.test(msg)) {
			const guide =
				`❌ **执行超时**\n\n` +
				`任务执行超时，请检查任务复杂度或网络状况。\n\n` +
				`建议：\n` +
				`- 将任务拆分为更小的步骤\n` +
				`- 使用 \`/stop\` 手动终止长任务`;

			try {
				await sendMarkdown(sessionWebhook, guide, '❌ 超时', 'red');
			} catch (sendErr) {
				console.error('[sendMarkdown 失败]', sendErr);
			}
			return;
		}

		// 通用错误
		try {
			await sendMarkdown(sessionWebhook, `❌ 执行失败\n\n\`\`\`\n${msg.slice(0, 500)}\n\`\`\`\n\n发送 \`/帮助\` 查看可用命令。`, '❌ 失败', 'red');
		} catch (sendErr) {
			console.error('[sendMarkdown 失败]', sendErr);
		}
	}
}

// ── 调度回调 ───────────────────────────────────
async function onScheduledTaskExecute(result: string, webhook: string, title?: string) {
	if (result && result.length > 0) {
		if (result.length <= 3800) {
			await sendMarkdown(webhook, result, title, 'green');
		} else {
			await sendMarkdown(webhook, result.slice(0, 3800) + '\n\n...(已截断)', title, 'orange');
		}
	}
}

// ── 分片工具 ─────────────────────────────────────
function splitMarkdown(text: string, maxLen: number): string[] {
	if (text.length <= maxLen) return [text];
	
	const chunks: string[] = [];
	let current = '';
	
	for (const line of text.split('\n')) {
		if (current.length + line.length + 1 > maxLen) {
			chunks.push(current);
			current = line;
		} else {
			current += (current ? '\n' : '') + line;
		}
	}
	
	if (current) chunks.push(current);
	return chunks;
}

// ── 定时任务调度器 ────────────────────────────────
// 钉钉独立的 cron-jobs.json（保存在固定的全局目录）
const cronStorePath = resolve(ROOT, 'cron-jobs-dingtalk.json');

const scheduler = new Scheduler({
	storePath: cronStorePath,
	defaultWorkspace,
	onExecute: async (job: CronJob) => {
		// 新闻推送任务：动态抓取并格式化
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
				console.log(`[scheduler] fetching news, topN=${topN}`);
				const { messages } = await fetchNews({ topN, platform: "dingtalk" });
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
		// 普通提醒任务
		console.log(`[scheduler] task triggered: ${job.name}`);
		return { status: 'ok' as const, result: job.message };
	},
	onDelivery: async (job: CronJob, result: string) => {
		// 优先使用任务中保存的 webhook（确保发送到创建任务的平台）
		const webhook = job.webhook || getWebhook();
		if (!webhook) {
			console.warn('[scheduler] no active webhook, skip delivery (user must send at least one message first)');
			return;
		}

		// 只有钉钉创建的任务才发送到钉钉
		if (job.platform && job.platform !== 'dingtalk') {
			console.log(`[scheduler] task ${job.name} belongs to ${job.platform}, skip dingtalk delivery`);
			return;
		}

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
				await sendMarkdown(webhook, piece, title, 'blue');
				if (i < chunks.length - 1) {
					await new Promise(r => setTimeout(r, 500));
				}
			}
			console.log(`[scheduler] dingtalk news sent: ${chunks.length} chunk(s)`);
		} else {
			// 发送提醒内容（优化格式）
			const now = new Date();
			const timeStr = now.toLocaleString('zh-CN', {
				month: '2-digit',
				day: '2-digit',
				hour: '2-digit',
				minute: '2-digit',
				hour12: false
			});
			const content = `**${result}**\n\n⏱ 提醒时间：${timeStr}\n📌 任务名称：${job.name}`;
			await sendMarkdown(webhook, content, '⏰ 定时提醒');
			console.log(`[scheduler] dingtalk reminder sent: ${result}`);
		}
	},
	log: (msg: string) => console.log(`[调度] ${msg}`),
});

// ── 启动 ─────────────────────────────────────────
console.log(`
┌──────────────────────────────────────────────────┐
│  钉钉 → Cursor Agent 中继服务 v3.0               │
├──────────────────────────────────────────────────┤
│  模型: ${config.CURSOR_MODEL}
│  Key:  ${config.CURSOR_API_KEY ? `...${config.CURSOR_API_KEY.slice(-8)}` : '(未设置)'}
│  连接: 钉钉 Stream 长连接
│  收件: ${INBOX_DIR}
│  记忆: ${memory ? `与飞书共享（${config.VOLC_EMBEDDING_MODEL}）` : '未初始化'}
│  调度: cron-jobs-dingtalk.json (全局目录)
│  心跳: 默认关闭（/心跳 开启）
│
│  项目路由:
${Object.entries(projectsConfig.projects).map(([k, v]) => `│    /${k} → ${v.path}`).join('\n')}
│
│  ✅ 已支持:
│    - 消息: 文本、语音、图片、文件
│    - 路由: 传统(/project) + 对话式(切换到/# /@)
│    - 命令: /帮助 /状态 /新闻 /任务 /新对话 /会话 /模型 /密钥 /终止
│    - 会话: 持久化、历史、切换
│    - 记忆: 语义搜索、日志记录、全工作区索引（与飞书共享）
│    - 心跳: 定期检查、主动推送
│    - 定时: cron-jobs-dingtalk.json
│
│  ⏸️ 暂不支持:
│    - 实时进度（平台限制：钉钉不支持消息更新）
└──────────────────────────────────────────────────┘
`);

// ── 启动前校验：未配置钉钉凭据则直接退出 ─────────────
function isValidConfig(value: string | undefined): boolean {
	if (!value?.trim()) return false;
	const placeholders = ['your_dingtalk_app_key', 'your_dingtalk_app_secret', 'your_app_key', 'your_app_secret'];
	return !placeholders.includes(value.toLowerCase().trim());
}

if (!isValidConfig(config.DINGTALK_APP_KEY) || !isValidConfig(config.DINGTALK_APP_SECRET)) {
	console.error('\n┌──────────────────────────────────────────────────┐');
	console.error('│  ⚠️  钉钉机器人未正确配置，服务不会启动          │');
	console.error('└──────────────────────────────────────────────────┘\n');
	console.error('如需使用钉钉集成，请在 dingtalk/.env 中配置:');
	console.error('  1. 复制模板: cp dingtalk/.env.example dingtalk/.env');
	console.error('  2. 编辑 .env 文件，填入真实的机器人凭据:');
	console.error('     DINGTALK_APP_KEY=your_actual_app_key');
	console.error('     DINGTALK_APP_SECRET=your_actual_app_secret');
	console.error('\n如不需要钉钉集成，可以忽略此提示。\n');
	process.exit(0); // 使用 exit(0) 表示正常退出，不是错误
}

// ── 钉钉 Stream 客户端 ───────────────────────────
const client = new DWClient({
	clientId: config.DINGTALK_APP_KEY,
	clientSecret: config.DINGTALK_APP_SECRET,
});

client.registerCallbackListener(TOPIC_ROBOT, async (res) => {
	console.log('[回调] 收到钉钉推送');
	try {
		await handleMessage(res);
		console.log('[回调] 处理完成，返回 200');
		return { code: 200, message: 'OK' };
	} catch (error) {
		console.error('[回调异常]', error);
		return {
			code: 500,
			message: error instanceof Error ? error.message : String(error)
		};
	}
});

// 启动钉钉 Stream 连接，简单重试 3 次，之后由 SDK 自己管理重连
let startRetries = 3;
while (startRetries > 0) {
	try {
		await refreshAccessToken();
		await client.connect();
		console.log('✅ 钉钉 Stream 已连接（SDK 自动管理重连）');
		break;
	} catch (err) {
		startRetries--;
		const errMsg = err instanceof Error ? err.message : String(err);
		if (startRetries === 0) {
			console.error('❌ 钉钉连接启动失败（已重试 3 次）:', errMsg);
			console.error('请检查网络连接和钉钉凭据（DINGTALK_APP_KEY / DINGTALK_APP_SECRET）');
			process.exit(1);
		}
		console.warn(`[钉钉] 连接失败，5秒后重试 (剩余 ${startRetries} 次): ${errMsg}`);
		await new Promise(r => setTimeout(r, 5000));
	}
}

// ── 启动定时任务调度器 ────────────────────────────
console.log('[scheduler] starting...');
scheduler.start().catch((err) => {
	console.error('[scheduler] start failed:', err);
});
console.log(`[scheduler] started, file: ${cronStorePath}`);

// ── 启动心跳系统 ──────────────────────────────────
heartbeat.start();
console.log(`[心跳] 已启动，默认关闭（发送 /心跳 开启）`);

// 网络恢复监控已禁用：
// 实践证明频繁的主动重连反而导致消息丢失和连接不稳定
// 钉钉 Stream SDK 自带断线重连机制（ReconnectManager），已足够可靠
// if (process.platform === 'darwin') {
// 	const { startNetworkRecoveryMonitor } = await import('../shared/network-recovery.js');
// 	startNetworkRecoveryMonitor({ ... });
// }

// ── 启动自检（.cursor/BOOT.md）───────────────────────
// 已禁用：agent 进程初始化太慢，会阻塞启动
console.log("[启动] BOOT.md 自检已禁用（避免启动阻塞）");
