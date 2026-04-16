/**
 * Telegram → Cursor Agent CLI 中继服务 v1.1
 *
 * 核心功能：
 * - Telegram Bot API 接收消息
 * - 调用 Cursor Agent CLI 执行任务
 * - 流式输出支持（实时进度 + 代码片段预览）
 * - 会话管理（--resume）
 * - 项目路由
 * - 命令系统、定时任务、记忆搜索
 *
 * 启动: bun run server.ts
 */

import TelegramBot from 'node-telegram-bot-api';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, watchFile, unwatchFile, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Scheduler, type CronJob } from '../shared/scheduler.js';
import { MemoryManager } from '../shared/memory.js';
import { HeartbeatRunner, getHeartbeatGlobalConfig, isHeartbeatEnabled, createSessionActivityGate } from '../shared/heartbeat.js';
import { CommandHandler, type PlatformAdapter, type CommandContext } from '../shared/command-handler.js';
import { AgentExecutor } from '../shared/agent-executor.js';
import { getDefaultModel, getAvailableModelChain, shouldFallback, isQuotaExhausted, addToBlacklist, isBlacklisted } from '../shared/models-config.js';
import { ProcessLock } from '../shared/process-lock.js';
import { fetchNews } from '../shared/news-fetcher.js';
import { fetchWeather } from '../shared/weather-fetcher.js';
import { fetchGithubTrending } from '../shared/github-trending-fetcher.js';

const HOME = process.env.HOME!;

// ── 进程锁（防止多实例运行）──────────────────────
const processLock = new ProcessLock("telegram");
if (!processLock.acquire()) {
	console.error("\n❌ Telegram 服务已在运行，无法启动第二个实例");
	console.error("💡 如需重启，请先停止现有进程");
	process.exit(1);
}

const ROOT = resolve(import.meta.dirname, '..');
const ENV_PATH = resolve(import.meta.dirname, '.env');
const PROJECTS_PATH = resolve(ROOT, 'projects.json');
const INBOX_DIR = resolve(ROOT, 'inbox');

mkdirSync(INBOX_DIR, { recursive: true });

// 启动时清理超过 24h 的临时文件
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

// ── 配置 ─────────────────────────────────────────
interface EnvConfig {
	CURSOR_API_KEY: string;
	TELEGRAM_BOT_TOKEN: string;
	CURSOR_MODEL: string;
	VOLC_STT_APP_ID: string;
	VOLC_STT_ACCESS_TOKEN: string;
	VOLC_EMBEDDING_API_KEY: string;
	VOLC_EMBEDDING_MODEL: string;
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
		TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN || '',
		CURSOR_MODEL: env.CURSOR_MODEL || '',
		VOLC_STT_APP_ID: env.VOLC_STT_APP_ID || '',
		VOLC_STT_ACCESS_TOKEN: env.VOLC_STT_ACCESS_TOKEN || '',
		VOLC_EMBEDDING_API_KEY: env.VOLC_EMBEDDING_API_KEY || '',
		VOLC_EMBEDDING_MODEL: env.VOLC_EMBEDDING_MODEL || 'doubao-embedding-vision-250615',
	};
}

const config = loadEnv();

// ── 项目配置 ───────────────────────────────────────
interface ProjectConfig {
	projects: Record<string, { path: string; description: string }>;
	default_project: string;
}

function loadProjects(): ProjectConfig {
	if (!existsSync(PROJECTS_PATH)) {
		console.error(`[致命] projects.json 不存在: ${PROJECTS_PATH}`);
		process.exit(1);
	}
	return JSON.parse(readFileSync(PROJECTS_PATH, 'utf-8'));
}

let projectsConfig = loadProjects();

// ── 热更新监听 ───────────────────────────────────
watchFile(ENV_PATH, { interval: 2000 }, () => {
	try {
		console.log('[配置] 检测到 .env 变更，重新加载...');
		const prev = config.CURSOR_MODEL;
		const newConfig = loadEnv();
		Object.assign(config, newConfig);
		if (config.CURSOR_MODEL !== prev) {
			console.log(`[配置] 模型已切换: ${prev} → ${config.CURSOR_MODEL}`);
		}
	} catch (err) {
		console.error('[配置] .env 加载失败:', (err as Error).message);
	}
});

watchFile(PROJECTS_PATH, { interval: 2000 }, () => {
	try {
		console.log('[配置] 检测到 projects.json 变更，重新加载...');
		const prev = projectsConfig.default_project;
		const newProjects = loadProjects();
		Object.assign(projectsConfig, newProjects);
		if (projectsConfig.default_project !== prev) {
			console.log(`[配置] 默认项目已切换: ${prev} → ${projectsConfig.default_project}`);
		}
	} catch (err) {
		console.error('[配置] projects.json 加载失败:', (err as Error).message);
	}
});

// ── 初始化 Bot ──────────────────────────────────
if (!config.TELEGRAM_BOT_TOKEN) {
	console.error('[致命] TELEGRAM_BOT_TOKEN 未配置');
	process.exit(1);
}

const bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });
console.log('[启动] Telegram Bot 开始轮询...');

// Bot 错误处理
bot.on('polling_error', (error) => {
	console.error('[Telegram] 轮询错误:', error.message);
});

bot.on('webhook_error', (error) => {
	console.error('[Telegram] Webhook 错误:', error.message);
});

// ── 最近活跃会话（用于定时任务推送）─────
let lastActiveTgChatId: number | undefined;

// ── 共享模块初始化 ──────────────────────────────
const defaultWorkspaceGlobal = projectsConfig.projects[projectsConfig.default_project]?.path || ROOT;
const cronStorePath = resolve(ROOT, 'cron-jobs-telegram.json');

const scheduler = new Scheduler({
	storePath: cronStorePath,
	defaultWorkspace: defaultWorkspaceGlobal,
	onExecute: async (job: CronJob) => {
		if (job.task) {
			switch (job.task.type) {
				case 'fetch-news': {
					const topN = job.task.options?.topN ?? 15;
					const { messages } = await fetchNews({ topN, platform: 'telegram' });
					if (messages.length > 1) {
						return { status: 'ok' as const, result: JSON.stringify({ chunks: messages }) };
					}
					return { status: 'ok' as const, result: messages[0] ?? '' };
				}

				case 'fetch-weather': {
					const city = job.task.options?.city ?? '北京';
					const card = await fetchWeather({ city });
					return { status: 'ok' as const, result: card };
				}

				case 'fetch-github-trending': {
					const opts = job.task.options ?? {};
					const card = await fetchGithubTrending(opts);
					return { status: 'ok' as const, result: card };
				}

				case 'agent-prompt': {
					try {
						const workspace = job.workspace || defaultWorkspaceGlobal;
						const primaryModel = job.model || config.CURSOR_MODEL || getDefaultModel();
						const chain = getAvailableModelChain(primaryModel);
						if (chain.length === 0) throw new Error('所有模型都已配额用尽');
						let agentResult: string = '';
						for (let i = 0; i < chain.length; i++) {
							const m = chain[i];
							if (!m) continue;
							try {
								const r = await agentExecutor.execute({
									workspace,
									model: m.id,
									prompt: job.task.prompt,
									platform: 'telegram',
									apiKey: config.CURSOR_API_KEY || undefined,
								});
								agentResult = r.result;
								break;
							} catch (e) {
								if (isQuotaExhausted(e as Error)) addToBlacklist(m.id);
								if (!shouldFallback(e as Error) || i === chain.length - 1) throw e;
								console.warn(`[定时 Fallback] ${m.id} 失败，尝试下一个`);
							}
						}
						return { status: 'ok' as const, result: agentResult };
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						return { status: 'error' as const, error: errMsg, result: `❌ Agent 执行失败\n\n${errMsg}` };
					}
				}

				case 'text':
					return { status: 'ok' as const, result: job.task.content };
			}
		}
		return { status: 'ok' as const, result: job.message };
	},
	onDelivery: async (job: CronJob, result: string) => {
		const chatId = job.webhook ? Number(job.webhook) : lastActiveTgChatId;
		if (!chatId) {
			console.warn('[定时] 无 chat ID，跳过推送');
			return;
		}
		let chunks: string[];
		try {
			const parsed = JSON.parse(result) as { chunks?: string[] };
			chunks = parsed.chunks || [result];
		} catch {
			chunks = [result];
		}
		for (let i = 0; i < chunks.length; i++) {
			const ch = chunks[i];
			if (!ch) continue;
			const title = chunks.length > 1
				? `⏰ **${job.name}** (${i + 1}/${chunks.length})`
				: `⏰ **定时：${job.name}**`;
			try {
				await bot.sendMessage(chatId, `${title}\n\n${ch.slice(0, 4000)}`);
			} catch (err) {
				console.error(`[定时] Telegram 推送失败:`, err);
			}
			if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 500));
		}
	},
	log: (m: string) => console.log(`[调度] ${m}`),
});
const memoryWorkspaceKeyGlobal = (projectsConfig as any).memory_workspace || projectsConfig.default_project;
const memoryWorkspaceGlobal = projectsConfig.projects[memoryWorkspaceKeyGlobal]?.path || defaultWorkspaceGlobal;

let memory: MemoryManager | undefined;
try {
	memory = new MemoryManager({
		workspaceDir: memoryWorkspaceGlobal,
		embeddingApiKey: config.VOLC_EMBEDDING_API_KEY,
		embeddingModel: config.VOLC_EMBEDDING_MODEL,
		embeddingEndpoint: 'https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal',
		temporalDecayHalfLife: Number.isFinite(Number((config as any).MEMORY_TEMPORAL_DECAY_HALF_LIFE)) ? Number((config as any).MEMORY_TEMPORAL_DECAY_HALF_LIFE) : 30,
		mmrLambda: Number.isFinite(Number((config as any).MEMORY_MMR_LAMBDA)) ? Number((config as any).MEMORY_MMR_LAMBDA) : 0.5,
	});
} catch (err) {
	console.warn('[记忆] MemoryManager 初始化失败:', err);
}

const hbGlobal = getHeartbeatGlobalConfig();
const heartbeat = new HeartbeatRunner({
	config: {
		enabled: isHeartbeatEnabled('telegram'),
		everyMs: hbGlobal.everyMs,
		workspaceDir: memoryWorkspaceGlobal,
		...(hbGlobal.activeHours ? { activeHours: hbGlobal.activeHours } : {}),
	},
	shouldRun: createSessionActivityGate(memoryWorkspaceGlobal),
	onExecute: async (prompt: string) => {
		memory?.appendSessionLog(memoryWorkspaceGlobal, 'user', '[心跳检查] ' + prompt.slice(0, 200), config.CURSOR_MODEL);
		const primaryModel = config.CURSOR_MODEL || getDefaultModel();
		const chain = getAvailableModelChain(primaryModel);
		let resultText = '';
		for (let i = 0; i < chain.length; i++) {
			const m = chain[i];
			if (!m) continue;
			try {
				const r = await agentExecutor.execute({
					workspace: defaultWorkspaceGlobal,
					model: m.id,
					prompt,
					platform: 'telegram',
					apiKey: config.CURSOR_API_KEY || undefined,
				});
				resultText = r.result;
				break;
			} catch (e) {
				if (isQuotaExhausted(e as Error)) addToBlacklist(m.id);
				if (!shouldFallback(e as Error) || i === chain.length - 1) throw e;
				console.warn(`[心跳 Fallback] ${m.id} 失败，尝试下一个`);
			}
		}
		memory?.appendSessionLog(memoryWorkspaceGlobal, 'assistant', resultText.slice(0, 3000), config.CURSOR_MODEL);
		return resultText;
	},
	onDelivery: async (content: string) => {
		if (!lastActiveTgChatId) {
			console.warn('[心跳] 无活跃 Telegram 会话，跳过推送');
			return;
		}
		try {
			await bot.sendMessage(lastActiveTgChatId, content);
		} catch (err) {
			console.error('[心跳] Telegram 推送失败:', err);
		}
	},
	log: (m: string) => console.log(`[心跳] ${m}`),
});

const agentExecutor = new AgentExecutor({
	timeout: 30 * 60 * 1000,
	maxConcurrent: 10,
});

// ── 会话管理 ──────────────────────────────────────
const SESSIONS_PATH = resolve(import.meta.dirname, '.sessions.json');

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
const busySessions: Set<string> = new Set();

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
		console.log(`[会话] 从磁盘恢复 ${sessionsStore.size} 个工作区会话`);
	} catch (err) {
		console.error('[会话] 加载失败:', (err as Error).message);
	}
}

function saveSessions(): void {
	try {
		writeFileSync(SESSIONS_PATH, JSON.stringify(Object.fromEntries(sessionsStore), null, 2));
	} catch (err) {
		console.error('[会话] 保存失败:', (err as Error).message);
	}
}

loadSessionsFromDisk();

function getSessionKey(chatId: number, workspace: string): string {
	return `${chatId}:${workspace}`;
}

function getActiveSessionId(chatId: number, workspace: string): string | null {
	const ws = sessionsStore.get(getSessionKey(chatId, workspace));
	return ws?.active || null;
}

function setActiveSessionId(chatId: number, workspace: string, sessionId: string) {
	const key = getSessionKey(chatId, workspace);
	let ws = sessionsStore.get(key);
	if (!ws) {
		ws = { active: null, history: [] };
		sessionsStore.set(key, ws);
	}
	
	// 更新 active
	ws.active = sessionId;
	
	// 添加或更新历史记录
	const existing = ws.history.find(h => h.id === sessionId);
	if (existing) {
		existing.lastActiveAt = Date.now();
	} else {
		ws.history.push({
			id: sessionId,
			createdAt: Date.now(),
			lastActiveAt: Date.now(),
			summary: '(新会话)',
		});
	}
	
	saveSessions();
}

function getCurrentProject(chatId: number, workspace: string): string | null {
	const ws = sessionsStore.get(getSessionKey(chatId, workspace));
	return ws?.currentProject || null;
}

function archiveAndResetSession(chatId: number, workspace: string): void {
	const key = getSessionKey(chatId, workspace);
	const ws = sessionsStore.get(key);
	if (ws?.active) {
		ws.active = null;
		saveSessions();
		console.log(`[会话] 已归档: ${key}`);
	}
}

function switchToSession(chatId: number, workspace: string, sessionId: string): boolean {
	const key = getSessionKey(chatId, workspace);
	const ws = sessionsStore.get(key);
	if (!ws) return false;
	const entry = ws.history.find(h => h.id === sessionId);
	if (!entry) return false;
	ws.active = sessionId;
	entry.lastActiveAt = Date.now();
	saveSessions();
	return true;
}

function getSessionHistory(chatId: number, workspace: string, limit = 10): SessionEntry[] {
	const ws = sessionsStore.get(getSessionKey(chatId, workspace));
	if (!ws) return [];
	return [...ws.history]
		.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
		.slice(0, limit);
}

function formatElapsed(ms: number): string {
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return `${sec}秒`;
	const min = Math.floor(sec / 60);
	const s = sec % 60;
	return `${min}分${s}秒`;
}

// ── 平台适配器 ────────────────────────────────────
class TelegramAdapter implements PlatformAdapter {
	private streamMessageId?: number;
	private lastUpdateTime = 0;
	private readonly MIN_UPDATE_INTERVAL = 2000; // 最小更新间隔 2 秒（避免 Telegram API 限流）

	constructor(
		private bot: TelegramBot,
		private chatId: number,
		private messageId?: number
	) {}

	async reply(content: string, options?: { title?: string; color?: string }): Promise<void> {
		const MAX_LENGTH = 4096;
		
		// 添加标题
		const titlePrefix = options?.title ? this.formatTitle(options.title, options.color) : '';
		const fullContent = titlePrefix + content;
		
		// 发送（单条或分片）
		if (fullContent.length <= MAX_LENGTH) {
			await this.sendWithFallback(fullContent);
		} else {
			const chunks = this.splitMessage(content, MAX_LENGTH - titlePrefix.length);
			for (let i = 0; i < chunks.length; i++) {
				await this.sendWithFallback(i === 0 ? titlePrefix + chunks[i] : chunks[i]);
				await new Promise(resolve => setTimeout(resolve, 100));
			}
		}
	}

	private formatTitle(title: string, color?: string): string {
		const emoji = color === 'green' ? '✅' :
		              color === 'red' ? '❌' :
		              color === 'orange' ? '⚠️' :
		              color === 'blue' ? '📘' :
		              color === 'purple' ? '💜' : '📝';
		return `${emoji} **${title}**\n\n`;
	}

	private async sendWithFallback(content: string): Promise<TelegramBot.Message> {
		try {
			return await this.bot.sendMessage(this.chatId, content, {
				parse_mode: 'Markdown',
				disable_web_page_preview: true,
			});
		} catch (err) {
			console.warn('[Telegram] Markdown 解析失败，使用纯文本模式');
			return await this.bot.sendMessage(this.chatId, content, {
				disable_web_page_preview: true,
			});
		}
	}

	async replyStream(content: string, finish: boolean): Promise<void> {
		const now = Date.now();
		const text = content || '⏳ 处理中...';
		
		if (!this.streamMessageId) {
			// 首次发送
			const msg = await this.sendWithFallback(text);
			this.streamMessageId = msg.message_id;
			this.lastUpdateTime = now;
		} else if (finish || now - this.lastUpdateTime >= this.MIN_UPDATE_INTERVAL) {
			// 更新（防抖 + 完成时强制）
			if (content) {
				await this.editWithFallback(content.length > 4000 ? content.slice(0, 4000) + '\n\n...' : content);
				this.lastUpdateTime = now;
			}
			
			// 完成时清理
			if (finish) {
				this.streamMessageId = undefined;
				this.lastUpdateTime = 0;
			}
		}
	}

	private async editWithFallback(content: string): Promise<void> {
		try {
			await this.bot.editMessageText(content, {
				chat_id: this.chatId,
				message_id: this.streamMessageId!,
				parse_mode: 'Markdown',
				disable_web_page_preview: true,
			});
		} catch (err) {
			if (!(err as any).response?.body?.description?.includes('message is not modified')) {
				console.warn('[Telegram] 流式更新失败:', (err as Error).message);
			}
		}
	}

	async sendFile(filePath: string, fileName?: string): Promise<void> {
		try {
			await this.bot.sendDocument(this.chatId, filePath, {
				caption: fileName ? `📎 ${fileName}` : undefined,
			});
			console.log(`[Telegram] 文件已发送: ${fileName || filePath}`);
		} catch (err) {
			console.error('[Telegram] 文件发送失败:', (err as Error).message);
			throw err;
		}
	}

	private splitMessage(text: string, maxLength: number): string[] {
		const chunks: string[] = [];
		let current = '';
		
		for (const line of text.split('\n')) {
			// 如果单行超过限制，需要强制分割
			if (line.length > maxLength) {
				if (current) {
					chunks.push(current);
					current = '';
				}
				// 将长行按字符分割
				for (let i = 0; i < line.length; i += maxLength) {
					chunks.push(line.slice(i, i + maxLength));
				}
			} else if (current.length + line.length + 1 > maxLength) {
				if (current) chunks.push(current);
				current = line;
			} else {
				current += (current ? '\n' : '') + line;
			}
		}
		
		if (current) chunks.push(current);
		return chunks;
	}
}

// ── Telegram 文件下载 ──────────────────────────────
async function downloadTgFile(fileId: string, ext: string): Promise<string> {
	const file = await bot.getFile(fileId);
	if (!file.file_path) throw new Error('无法获取文件路径');
	const url = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
	const resp = await fetch(url);
	if (!resp.ok) throw new Error(`下载失败: ${resp.status}`);
	const buffer = Buffer.from(await resp.arrayBuffer());
	const filename = `tg_${Date.now()}${ext}`;
	const savePath = resolve(INBOX_DIR, filename);
	writeFileSync(savePath, buffer);
	console.log(`[下载] Telegram 文件已保存: ${savePath} (${buffer.length} bytes)`);
	return savePath;
}

// ── 消息处理 ──────────────────────────────────────
bot.on('message', async (msg) => {
	const chatId = msg.chat.id;
	let text = msg.text || msg.caption || '';
	
	const hasMedia = !!(msg.photo || msg.video || msg.document || msg.voice || msg.audio);
	if (!text.trim() && !hasMedia) {
		console.log('[消息] 忽略空消息');
		return;
	}
	
	console.log(`[消息] 收到来自 ${chatId}: ${text.slice(0, 50)}${hasMedia ? ' [含媒体]' : ''}...`);
	lastActiveTgChatId = chatId;
	
	const adapter = new TelegramAdapter(bot, chatId, msg.message_id);
	
	// 处理媒体附件
	try {
		if (msg.photo && msg.photo.length > 0) {
			const largest = msg.photo[msg.photo.length - 1];
			const path = await downloadTgFile(largest.file_id, '.jpg');
			const instruction = '\n\n**注意**：这张图片来自 Telegram 临时存储，请直接用 Read 工具读取分析。';
			text = text
				? `${text}\n\n图片：${path}${instruction}`
				: `用户发了一张图片：${path}${instruction}\n\n请查看并回复。`;
		}

		if (msg.video) {
			const path = await downloadTgFile(msg.video.file_id, '.mp4');
			text = text
				? `${text}\n\n视频：${path}`
				: `用户发了一段视频：${path}\n\n请查看并回复。`;
		}

		if (msg.document) {
			const origName = msg.document.file_name || 'file';
			const dotIdx = origName.lastIndexOf('.');
			const ext = dotIdx > 0 ? origName.slice(dotIdx) : '';
			const path = await downloadTgFile(msg.document.file_id, ext);
			text = text
				? `${text}\n\n[附件: ${path}]`
				: `用户发了文件 ${origName}，已保存到 ${path}`;
		}

		if (msg.voice) {
			const path = await downloadTgFile(msg.voice.file_id, '.ogg');
			text = text
				? `${text}\n\n语音文件：${path}`
				: `用户发了一条语音消息，音频文件在 ${path}，请处理并回复。`;
		}

		if (msg.audio) {
			const origName = (msg.audio as any).file_name || msg.audio.title || 'audio.mp3';
			const dotIdx = origName.lastIndexOf('.');
			const ext = dotIdx > 0 ? origName.slice(dotIdx) : '.mp3';
			const path = await downloadTgFile(msg.audio.file_id, ext);
			text = text
				? `${text}\n\n音频：${path}`
				: `用户发了音频文件 ${origName}，已保存到 ${path}`;
		}
	} catch (err) {
		console.error('[下载失败]', err);
		await adapter.reply(`⚠️ 媒体文件下载失败: ${(err as Error).message}`);
		if (!text.trim()) return;
	}

	if (!text.trim()) {
		console.log('[消息] 无可处理内容');
		return;
	}

	const defaultWorkspace = projectsConfig.projects[projectsConfig.default_project]?.path || ROOT;
	const memoryWorkspaceKey = (projectsConfig as any).memory_workspace || projectsConfig.default_project;
	const memoryWorkspace = projectsConfig.projects[memoryWorkspaceKey]?.path || defaultWorkspace;
	
	const ctx: CommandContext = {
		platform: 'telegram',
		projectsConfig,
		defaultWorkspace,
		memoryWorkspace,
		config,
		scheduler,
		memory: memory || null,
		heartbeat,
		agentExecutor,
		busySessions,
		sessionsStore,
		getCurrentProject: (ws: string) => getCurrentProject(chatId, ws),
		getLockKey: (ws: string) => getSessionKey(chatId, ws),
		archiveAndResetSession: (ws: string) => archiveAndResetSession(chatId, ws),
		getSessionHistory: (ws: string, limit?: number) => getSessionHistory(chatId, ws, limit),
		getActiveSessionId: (ws: string) => getActiveSessionId(chatId, ws),
		switchToSession: (ws: string, sid: string) => switchToSession(chatId, ws, sid),
		rootDir: ROOT,
	};
	
	const commandHandler = new CommandHandler(adapter, ctx);
	const handled = await commandHandler.route(text, (newSessionId: string) => {
		setActiveSessionId(chatId, defaultWorkspace, newSessionId);
	}, { chatId: String(chatId) });
	if (handled) {
		return;
	}
	
	// 解析项目路由
	let workspace = ctx.defaultWorkspace;
	let actualText = text;
	
	const colonIdx = text.indexOf(':');
	if (colonIdx > 0) {
		const projectKey = text.slice(0, colonIdx).trim();
		if (projectsConfig.projects[projectKey]) {
			workspace = projectsConfig.projects[projectKey].path;
			actualText = text.slice(colonIdx + 1).trim();
			console.log(`[路由] 切换项目: ${projectKey} -> ${workspace}`);
		}
	}
	
	if (!actualText.trim()) {
		await adapter.reply('⚠️ 消息内容为空');
		return;
	}
	
	// 检查是否正在执行任务
	const lockKey = getSessionKey(chatId, workspace);
	if (busySessions.has(lockKey)) {
		await adapter.reply('⏳ 正在处理上一条消息，请稍候...');
		return;
	}
	
	// 标记为忙碌
	busySessions.add(lockKey);
	
	try {
		const sessionId = getActiveSessionId(chatId, workspace);
		const processingMsg = await bot.sendMessage(chatId, '🤔 思考中...');
		const startTime = Date.now();
		const primaryModel = config.CURSOR_MODEL || getDefaultModel();

		const onProgress = async (progress: { elapsed: number; phase: string; snippet: string }) => {
			const elapsed = Math.floor(progress.elapsed / 1000);
			const phaseEmoji = progress.phase === 'thinking' ? '🤔' :
			                   progress.phase === 'tool_call' ? '🛠️' : '✍️';
			const phaseText = progress.phase === 'thinking' ? '思考中' :
			                  progress.phase === 'tool_call' ? '执行工具' : '生成回复';
			const snippet = progress.snippet
				.split('\n')
				.filter((l: string) => l.trim())
				.slice(-3)
				.join('\n')
				.slice(0, 100);
			const status = snippet
				? `${phaseEmoji} **${phaseText}** (${elapsed}秒)\n\n\`\`\`\n${snippet}\n...\n\`\`\``
				: `${phaseEmoji} **${phaseText}** (${elapsed}秒)`;
			try {
				await bot.editMessageText(status, {
					chat_id: chatId,
					message_id: processingMsg.message_id,
					parse_mode: 'Markdown',
				});
			} catch {}
		};

		// 模型链 fallback 执行
		const modelChain = getAvailableModelChain(primaryModel);
		if (modelChain.length === 0) {
			throw new Error('所有模型都已配额用尽，请稍后再试。');
		}

		const wasBlacklisted = isBlacklisted(primaryModel);
		if (wasBlacklisted) {
			console.log(`[智能跳过] ${primaryModel} 在黑名单中，静默切换到 ${modelChain[0]?.id}`);
		}

		let lastError: Error | null = null;
		let finalResult: { result: string; sessionId?: string; toolSummary?: string[] } | null = null;
		let usedFallback = false;
		let fallbackModel: string | undefined;

		for (let i = 0; i < modelChain.length; i++) {
			const model = modelChain[i];
			if (!model) continue;
			const isFallback = i > 0 || wasBlacklisted;

			if (isFallback && !wasBlacklisted) {
				console.log(`[Fallback ${i}/${modelChain.length - 1}] 尝试 ${model.id}（原模型：${primaryModel}）`);
			}

			try {
				const result = await agentExecutor.execute({
					workspace,
					model: model.id,
					prompt: actualText,
					sessionId: sessionId || undefined,
					platform: 'telegram',
					webhook: `tg:${chatId}`,
					apiKey: config.CURSOR_API_KEY || undefined,
					onProgress,
				});
				finalResult = result;
				if (isFallback && !(wasBlacklisted && i === 0)) {
					usedFallback = true;
					fallbackModel = model.id;
				}
				break;
			} catch (error) {
				lastError = error as Error;
				if (isQuotaExhausted(lastError)) {
					addToBlacklist(model.id);
				}
				if (!shouldFallback(lastError) || i === modelChain.length - 1) {
					console.error(`[失败] 模型 ${model.id} 执行失败，无更多 fallback`, lastError.message);
					throw error;
				}
				console.warn(`[失败] 模型 ${model.id} 失败: ${lastError.message.slice(0, 200)}`);
			}
		}

		if (!finalResult) {
			throw new Error(`所有模型都失败了（${modelChain.map(m => m.id).join(' → ')}）`);
		}

		try {
			await bot.deleteMessage(chatId, processingMsg.message_id);
		} catch {}

		const elapsed = Math.floor((Date.now() - startTime) / 1000);
		let response = finalResult.result;
		
		if (finalResult.toolSummary && finalResult.toolSummary.length > 0) {
			const summary = buildToolSummary(finalResult.toolSummary);
			if (summary) {
				response = summary + '\n\n---\n\n' + response;
			}
		}
		
		if (usedFallback && fallbackModel) {
			response = `⚠️ **模型降级**\n\n\`${primaryModel}\` 不可用，已改用 \`${fallbackModel}\` 完成。\n\n---\n\n` + response;
		}
		
		response += `\n\n⏱️ 用时: ${elapsed}秒`;
		await adapter.reply(response);

		if (finalResult.sessionId) {
			setActiveSessionId(chatId, workspace, finalResult.sessionId);
		}
	} catch (err) {
		console.error('[错误]', err);
		await adapter.reply(`❌ 执行失败: ${(err as Error).message}`);
	} finally {
		busySessions.delete(lockKey);
	}
});

// ── 工具调用摘要 ──────────────────────────────────
const TOOL_LABELS: Record<string, string> = {
	read: "📖 读取", write: "✏️ 写入", strReplace: "✏️ 编辑",
	shell: "⚡ 执行", grep: "🔍 搜索", glob: "📂 查找",
	semanticSearch: "🔎 语义搜索", webSearch: "🌐 搜索网页", webFetch: "🌐 抓取网页",
	delete: "🗑️ 删除", editNotebook: "📓 编辑笔记本",
	callMcpTool: "🔌 MCP工具", task: "🤖 子任务",
};

function buildToolSummary(tools: string[]): string {
	if (tools.length === 0) return "";
	
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

// ── 优雅关闭 ──────────────────────────────────────
async function gracefulShutdown(signal: string) {
	console.log(`\n[关闭] 收到 ${signal} 信号，停止服务...`);
	await bot.stopPolling();
	scheduler.stop();
	heartbeat.stop();
	unwatchFile(ENV_PATH);
	unwatchFile(PROJECTS_PATH);
	processLock.release();
	console.log('[关闭] 服务已停止');
	process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// ── 启动定时任务和心跳 ──────────────────────────
scheduler.start();
heartbeat.start();

console.log('[就绪] Telegram 服务已启动，等待消息...');
console.log(`[配置] 模型: ${config.CURSOR_MODEL || getDefaultModel()}`);
console.log(`[配置] 默认项目: ${projectsConfig.default_project}`);
