/**
 * 微信个人号 → Cursor Agent CLI 中继服务
 * 
 * 基于腾讯微信 ilink bot API (https://ilinkai.weixin.qq.com)
 * 技术栈：HTTP 长轮询 + QR 登录 + 文本消息
 * 
 * 启动: bun run server.ts
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, statSync, watchFile, unwatchFile } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import {
	DEFAULT_MODEL,
	getAvailableModelChain,
	shouldFallback,
	isQuotaExhausted,
	addToBlacklist,
	isBlacklisted,
} from '../shared/models-config.js';
import * as qrcodeTerminal from 'qrcode-terminal';

import { AgentExecutor, type AgentProgress } from '../shared/agent-executor.js';
import { Scheduler, type CronJob } from '../shared/scheduler.js';
import { MemoryManager } from '../shared/memory.js';
import { HeartbeatRunner } from '../shared/heartbeat.js';
import { FeilianController, type OperationResult } from '../shared/feilian-control.js';
import { fetchNews } from '../shared/news-fetcher.js';
import { getHealthStatus } from '../shared/news-sources/monitoring.js';
import { CommandHandler, type PlatformAdapter, type CommandContext } from '../shared/command-handler.js';
import { humanizeCronInChinese } from 'cron-chinese';
import {
	getSession,
	setActiveSession,
	archiveAndResetSession,
	getSessionHistory,
	getActiveSessionId,
	switchToSession,
	getLockKey,
	busySessions,
	buildToolSummary,
	resolveWorkspace,
	detectRouteIntent,
	sessionsStore,
	getCurrentProject,
	setCurrentProject,
} from './wechat-helper.js';

const HOME = process.env.HOME!;
const ROOT = pathResolve(import.meta.dirname, '..');
const ENV_PATH = pathResolve(import.meta.dirname, '.env');
const PROJECTS_PATH = pathResolve(ROOT, 'projects.json');
const INBOX_DIR = pathResolve(ROOT, 'inbox');
const TOKEN_FILE = pathResolve(import.meta.dirname, '.wechat_token.json');
const SYNC_BUF_FILE = pathResolve(import.meta.dirname, '.wechat_sync_buf');
const BOOT_DELAY_MS = 8000;

// 微信 API 配置
const WECHAT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const WECHAT_BOT_TYPE = '3';
const WECHAT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const LONG_POLL_TIMEOUT_SEC = 35;
const MAX_MESSAGE_CHUNK = 3800;
const SESSION_EXPIRED_ERRCODE = -14;
const CHANNEL_VERSION = 'cursor-remote-control/1.0';

mkdirSync(INBOX_DIR, { recursive: true });

// 清理 inbox
const DAY_MS = 24 * 60 * 60 * 1000;
for (const f of readdirSync(INBOX_DIR)) {
	const p = pathResolve(INBOX_DIR, f);
	try {
		if (Date.now() - statSync(p).mtimeMs > DAY_MS) unlinkSync(p);
	} catch {}
}

// 全局异常处理
process.on('uncaughtException', (err) => console.error(`[致命异常] ${err.message}\n${err.stack}`));
process.on('unhandledRejection', (reason) => console.error('[Promise 异常]', reason));

// ── 配置 ─────────────────────────────────────────
interface EnvConfig {
	CURSOR_API_KEY: string;
	CURSOR_MODEL: string;
	VOLC_EMBEDDING_API_KEY: string;
	VOLC_EMBEDDING_MODEL: string;
	MEMORY_TEMPORAL_DECAY_HALF_LIFE?: string;
	MEMORY_MMR_LAMBDA?: string;
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
		const [key, ...vals] = trimmed.split('=');
		if (!key) continue;
		let val = vals.join('=').trim();
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1);
		}
		env[key.trim()] = val;
	}
	return {
		CURSOR_API_KEY: env.CURSOR_API_KEY || '',
		CURSOR_MODEL: env.CURSOR_MODEL || DEFAULT_MODEL,
		VOLC_EMBEDDING_API_KEY: env.VOLC_EMBEDDING_API_KEY || '',
		VOLC_EMBEDDING_MODEL: env.VOLC_EMBEDDING_MODEL || 'doubao-embedding-vision-250615',
		MEMORY_TEMPORAL_DECAY_HALF_LIFE: env.MEMORY_TEMPORAL_DECAY_HALF_LIFE,
		MEMORY_MMR_LAMBDA: env.MEMORY_MMR_LAMBDA,
	};
}

const config = loadEnv();

// .env 热更新
watchFile(ENV_PATH, { interval: 2000 }, () => {
	try {
		const prev = config.CURSOR_API_KEY;
		const prevModel = config.CURSOR_MODEL;
		const newConfig = loadEnv();
		Object.assign(config, newConfig);
		if (config.CURSOR_API_KEY !== prev) {
			const keyPreview = config.CURSOR_API_KEY ? `...${config.CURSOR_API_KEY.slice(-8)}` : '(未设置)';
			console.log(`[热更新] API Key 已更新: ${keyPreview}`);
		}
		if (config.CURSOR_MODEL !== prevModel) {
			console.log(`[热更新] 模型已切换: ${config.CURSOR_MODEL}`);
		}
	} catch (e) {
		console.error('[热更新失败]', e);
	}
});

// ── 项目配置 ─────────────────────────────────────
interface ProjectsConfig {
	projects: Record<string, { path: string; description: string }>;
	default_project: string;
}

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

watchFile(PROJECTS_PATH, { interval: 5000 }, () => {
	try {
		const newConfig = JSON.parse(readFileSync(PROJECTS_PATH, 'utf-8'));
		Object.assign(projectsConfig, newConfig);
		console.log('[热更新] projects.json 已重新加载');
	} catch (err) {
		console.error('[热更新] projects.json 加载失败:', err);
	}
});

/** 解析默认工作区：避免 path 缺失/占位或 spawn 收到 undefined 变成字面量路径 .../wechat/undefined */
function getDefaultWorkspace(): string {
	const key = projectsConfig.default_project;
	const entry =
		key != null && projectsConfig.projects ? projectsConfig.projects[key] : undefined;
	const raw = entry?.path;
	if (raw == null || typeof raw !== 'string') {
		console.warn(`[项目] default_project「${String(key)}」未映射到有效 path，使用仓库根: ${ROOT}`);
		return ROOT;
	}
	const trimmed = raw.trim();
	if (trimmed === '' || trimmed === 'undefined') {
		console.warn(`[项目] path 为空或无效占位，使用仓库根: ${ROOT}`);
		return ROOT;
	}
	const abs = pathResolve(trimmed);
	if (!existsSync(abs)) {
		console.warn(`[项目] workspace 路径不存在: ${abs}，使用仓库根: ${ROOT}`);
		return ROOT;
	}
	return abs;
}

const defaultWorkspace = getDefaultWorkspace();
const memoryWorkspaceKey = (projectsConfig as { memory_workspace?: string }).memory_workspace || projectsConfig.default_project;
const memoryWorkspace =
	projectsConfig.projects[memoryWorkspaceKey]?.path || defaultWorkspace;

let memory: MemoryManager | undefined;
try {
	memory = new MemoryManager({
		workspaceDir: memoryWorkspace,
		embeddingApiKey: config.VOLC_EMBEDDING_API_KEY,
		embeddingModel: config.VOLC_EMBEDDING_MODEL,
		embeddingEndpoint: 'https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal',
		temporalDecayHalfLife: config.MEMORY_TEMPORAL_DECAY_HALF_LIFE ? Number(config.MEMORY_TEMPORAL_DECAY_HALF_LIFE) : 30,
		mmrLambda: config.MEMORY_MMR_LAMBDA ? Number(config.MEMORY_MMR_LAMBDA) : 0.5,
	});
	setTimeout(() => {
		memory!.index()
			.then((n) => {
				if (n > 0) console.log(`[记忆] 启动索引完成: ${n} 块`);
			})
			.catch((e) => console.warn(`[记忆] 启动索引失败: ${e}`));
	}, 3000);
} catch (e) {
	console.warn(`[记忆] 初始化失败（功能降级）: ${e}`);
	memory = undefined;
}

const activeAgents = new Map<string, { pid: number | undefined; kill: () => void; workspace: string }>();
const agentExecutor = new AgentExecutor({
	timeout: 60 * 60 * 1000,
	maxConcurrent: 10,
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

// 参考官方插件：生成 4 字节随机数 → 转为十进制字符串 → base64
// 官方实现：crypto.randomBytes(4).readUInt32BE(0)
function randomUIN(): string {
	const bytes = new Uint8Array(4);
	crypto.getRandomValues(bytes);
	const b0 = bytes[0] ?? 0;
	const b1 = bytes[1] ?? 0;
	const b2 = bytes[2] ?? 0;
	const b3 = bytes[3] ?? 0;
	const uint32 = (b0 << 24) | (b1 << 16) | (b2 << 8) | b3;
	return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

// ── 微信 API 类型定义 ──────────────────────────────
// 消息类型常量
const MESSAGE_ITEM_TEXT = 1;
const MESSAGE_ITEM_IMAGE = 2;
const MESSAGE_ITEM_VOICE = 3;
const MESSAGE_ITEM_FILE = 4;
const MESSAGE_ITEM_VIDEO = 5;

const MESSAGE_TYPE_USER = 1;  // 单聊
const MESSAGE_TYPE_BOT = 2;   // Bot 回复
const MESSAGE_STATE_NEW = 0;  // 新消息
const MESSAGE_STATE_GENERATING = 1;  // 生成中（显示"正在输入中"）
const MESSAGE_STATE_FINISH = 2;  // 消息完成状态

interface TextItem {
	text: string;
}

interface ImageItem {
	media?: {
		encrypt_query_param?: string;
		aes_key?: string;
	};
	thumb_media?: any;
}

interface VoiceItem {
	media?: any;
	text?: string;
}

interface FileItem {
	media?: any;
	file_name?: string;
	len?: string;
}

interface VideoItem {
	media?: any;
	thumb_media?: any;
}

interface RefMessage {
	message_item?: MessageItem;
	title?: string;
}

interface MessageItem {
	type: number;  // 1: text, 2: image, 3: voice, 4: file, 5: video
	create_time_ms?: number;
	update_time_ms?: number;
	is_completed?: boolean;
	msg_id?: string;
	text_item?: TextItem;
	image_item?: ImageItem;
	voice_item?: VoiceItem;
	file_item?: FileItem;
	video_item?: VideoItem;
	ref_msg?: RefMessage;
}

interface WeixinMessage {
	seq?: number;              // 序列号
	message_id?: number;       // 消息ID
	from_user_id?: string;     // 发送者ID
	to_user_id?: string;       // 接收者ID
	client_id?: string;        // 客户端消息ID
	create_time_ms?: number;   // 创建时间（毫秒）
	update_time_ms?: number;   // 更新时间（毫秒）
	delete_time_ms?: number;   // 删除时间（毫秒）
	session_id?: string;       // 会话ID
	group_id?: string;         // 群组ID
	message_type?: number;     // 0: none, 1: user, 2: bot
	message_state?: number;    // 0: new, 1: generating, 2: finish
	item_list?: MessageItem[]; // 消息内容列表
	context_token?: string;    // 上下文token（回复必需）
}

interface TokenData {
	token: string;
	accountId: string;
	baseUrl?: string;
	savedAt: string;
}


// ── 微信认证模块 ────────────────────────────────────
class WechatAuth {
	private token: string | null = null;
	private accountId: string | null = null;
	private baseUrl: string = WECHAT_BASE_URL;

	constructor() {
		this.loadToken();
	}

	private loadToken() {
		if (existsSync(TOKEN_FILE)) {
			try {
				const data: TokenData = JSON.parse(readFileSync(TOKEN_FILE, 'utf-8'));
				this.token = data.token;
				this.accountId = data.accountId;
				this.baseUrl = data.baseUrl || WECHAT_BASE_URL;
				console.log(`[认证] 从本地加载 Token: ${data.accountId}`);
			} catch (e) {
				console.error('[认证] Token 加载失败:', e);
			}
		}
	}

	private saveToken(token: string, accountId: string, baseUrl?: string) {
		this.token = token;
		this.accountId = accountId;
		if (baseUrl) this.baseUrl = baseUrl;
		
		const data: TokenData = {
			token,
			accountId,
			baseUrl: this.baseUrl,
			savedAt: new Date().toISOString()
		};
		writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
		console.log('✅ 微信 Token 已保存');
	}

	public getToken(): string | null {
		return this.token;
	}

	public getAccountId(): string | null {
		return this.accountId;
	}

	public getBaseUrl(): string {
		return this.baseUrl;
	}

	private async fetchQRCode(botType: string): Promise<{ qrcode: string; qrcode_img_content: string }> {
		const url = `${WECHAT_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`;
		const res = await fetch(url);
		
		if (!res.ok) throw new Error(`获取二维码失败: ${res.status} ${res.statusText}`);
		const raw = (await res.json()) as unknown;
		const data = raw as { qrcode?: string; qrcode_img_content?: string };
		if (!data.qrcode || !data.qrcode_img_content) {
			throw new Error('获取二维码失败: 响应缺少 qrcode 或 qrcode_img_content');
		}
		return { qrcode: data.qrcode, qrcode_img_content: data.qrcode_img_content };
	}

	private async pollQRStatus(qrcode: string): Promise<any> {
		const url = `${WECHAT_BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
		
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 35000);
		
		try {
			const res = await fetch(url, {
				headers: { 'iLink-App-ClientVersion': '1' },
				signal: controller.signal
			});
			clearTimeout(timer);
			
			if (!res.ok) throw new Error(`轮询状态失败: ${res.status}`);
			return await res.json();
		} catch (err) {
			clearTimeout(timer);
			if (err instanceof Error && err.name === 'AbortError') {
				return { status: 'wait' };
			}
			throw err;
		}
	}

	public async login(): Promise<string> {
		if (this.token) {
			console.log('🔄 已存在微信 Token，尝试直接使用...');
			return this.token;
		}

		console.log('⏳ 正在获取微信登录二维码...');
		const qrData = await this.fetchQRCode(WECHAT_BOT_TYPE);
		
		console.log('\n======================================');
		console.log('请使用微信扫描下方二维码登录：');
		qrcodeTerminal.generate(qrData.qrcode_img_content, { small: true });
		console.log('======================================\n');

		let scannedPrinted = false;
		const startTime = Date.now();
		const maxTimeMs = 5 * 60 * 1000; // 5分钟总超时

		while (Date.now() - startTime < maxTimeMs) {
			try {
				const status = await this.pollQRStatus(qrData.qrcode);
				
				switch (status.status) {
					case 'wait':
						process.stdout.write('.');
						break;
						
					case 'scaned':
						if (!scannedPrinted) {
							console.log('\n📱 已扫码，请在手机上确认登录...');
							scannedPrinted = true;
						}
						break;
						
					case 'confirmed':
						if (!status.bot_token || !status.ilink_bot_id) {
							throw new Error('登录成功但服务器未返回 token 或 bot_id');
						}
						console.log(`\n🎉 登录成功！账号ID: ${status.ilink_bot_id}`);
						this.saveToken(status.bot_token, status.ilink_bot_id, status.baseurl);
						return status.bot_token;
						
					case 'expired':
						throw new Error('二维码已过期，请重新运行登录');
				}
				
				await new Promise(resolve => setTimeout(resolve, 1000));
			} catch (e) {
				throw e;
			}
		}
		
		throw new Error('登录超时');
	}
}

// ── 微信 API 客户端 ────────────────────────────────
class WechatClient {
	constructor(
		private token: string,
		private accountId: string,
		private baseUrl: string = WECHAT_BASE_URL
	) {}

	private async request(endpoint: string, body: any, timeoutMs?: number): Promise<any> {
		const url = `${this.baseUrl}${endpoint}`;
		const bodyStr = JSON.stringify(body);
		const headers: Record<string, string> = {
			'Authorization': `Bearer ${this.token}`,
			'AuthorizationType': 'ilink_bot_token',
			'X-WECHAT-UIN': randomUIN(),
			'Content-Type': 'application/json',
			'Content-Length': String(Buffer.byteLength(bodyStr, 'utf-8')),
		};

		// 长轮询需要更长的客户端超时
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		if (timeoutMs && timeoutMs > 0) {
			timer = setTimeout(() => controller.abort(), timeoutMs);
		}

		try {
			const res = await fetch(url, {
				method: 'POST',
				headers,
				body: bodyStr,
				signal: timeoutMs ? controller.signal : undefined
			});

			if (timer) clearTimeout(timer);

			if (!res.ok) {
				const text = await res.text();
				const errorMsg = `API Error ${res.status}: ${text.substring(0, 200)}`;
				
				// 记录详细错误
				console.error(`[API 错误] ${endpoint}`);
				console.error(`[状态码] ${res.status}`);
				console.error(`[响应] ${text.substring(0, 500)}`);
				
				throw new Error(errorMsg);
			}

			const result = (await res.json()) as {
				ret?: number;
				errcode?: unknown;
				errmsg?: unknown;
			};
			if (result.ret != null && result.ret !== 0) {
				console.warn(
					`[API 警告] ${endpoint} 返回 ret=${result.ret}, errcode=${String(result.errcode)}, errmsg=${String(result.errmsg)}`,
				);
			}
			return result;
		} catch (err) {
			if (timer) clearTimeout(timer);
			
			// 长轮询超时是正常的，返回空结果（保持原 buf 继续轮询）
			if (err instanceof Error && err.name === 'AbortError' && timeoutMs) {
				// 长轮询超时不是错误，不输出日志
				return { 
					ret: 0, 
					errcode: 0,
					errmsg: '',
					msgs: [],  // 官方插件用的是 msgs，不是 message_list！
					get_updates_buf: body.get_updates_buf || '' 
				};
			}
			throw err;
		}
	}

	public async getUpdates(getUpdatesBuf?: string, timeout: number = LONG_POLL_TIMEOUT_SEC): Promise<any> {
		const body: any = {
			base_info: { 
				channel_version: CHANNEL_VERSION
			},
			timeout
		};
		
		// 只在有 buf 时才传递（首次请求不传）
		if (getUpdatesBuf) {
			body.get_updates_buf = getUpdatesBuf;
		}
		
		// 客户端超时 = 服务器超时 + 5秒（避免客户端先超时）
		const clientTimeoutMs = (timeout + 5) * 1000;
		return this.request('/ilink/bot/getupdates', body, clientTimeoutMs);
	}

	/**
	 * 发送"正在输入中"状态（显示输入提示）
	 * @param toUserId 目标用户ID
	 * @param contextToken 上下文token
	 * @param text 可选的提示文本（如"思考中..."）
	 */
	public async sendTypingIndicator(toUserId: string, contextToken: string, text: string = '⏳ 思考中...'): Promise<any> {
		return this.request('/ilink/bot/sendmessage', {
			base_info: { 
				channel_version: CHANNEL_VERSION
			},
			msg: {
				from_user_id: '',
				to_user_id: toUserId,
				client_id: `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
				message_type: MESSAGE_TYPE_BOT,
				message_state: MESSAGE_STATE_GENERATING,  // 关键：状态设为 1（生成中）
				item_list: [{ 
					type: MESSAGE_ITEM_TEXT, 
					text_item: { text }
				}],
				context_token: contextToken
			}
		});
	}

	public async sendTextMessage(toUserId: string, text: string, contextToken?: string): Promise<any> {
		if (!contextToken) {
			throw new Error(`缺少 context_token，无法发送消息给 ${toUserId}`);
		}
		
		// 文本分片
		if (text.length > MAX_MESSAGE_CHUNK) {
			const chunks: string[] = [];
			for (let i = 0; i < text.length; i += MAX_MESSAGE_CHUNK) {
				chunks.push(text.slice(i, i + MAX_MESSAGE_CHUNK));
			}
			
			let lastResp: any;
			for (const chunk of chunks) {
				lastResp = await this.request('/ilink/bot/sendmessage', {
					base_info: { 
						channel_version: CHANNEL_VERSION
					},
					msg: {
						from_user_id: '',  // 可以为空
						to_user_id: toUserId,
						client_id: `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
						message_type: MESSAGE_TYPE_BOT,
						message_state: MESSAGE_STATE_FINISH,
						item_list: [{ 
							type: MESSAGE_ITEM_TEXT, 
							text_item: { text: chunk }
						}],
						context_token: contextToken
					}
				});
				await new Promise(resolve => setTimeout(resolve, 200));
			}
			return lastResp;
		}
		
		return this.request('/ilink/bot/sendmessage', {
			base_info: { 
				channel_version: CHANNEL_VERSION
			},
			msg: {
				from_user_id: '',  // 可以为空
				to_user_id: toUserId,
				client_id: `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
				message_type: MESSAGE_TYPE_BOT,
				message_state: MESSAGE_STATE_FINISH,
				item_list: [{ 
					type: MESSAGE_ITEM_TEXT, 
					text_item: { text }
				}],
				context_token: contextToken
			}
		});
	}
}

// ── 消息监听器 ─────────────────────────────────────
class WechatMonitor {
	private isRunning = false;
	private getUpdatesBuf?: string;
	private errorCount = 0;
	private readonly MAX_ERROR_COUNT = 10;
	private dedupCache = new Map<string, number>();
	private readonly DEDUP_TTL_MS = 5 * 60 * 1000;
	private contextTokens = new Map<string, string>();

	constructor(
		private client: WechatClient,
		private onMessage: (msg: WeixinMessage) => Promise<void>
	) {
		this.loadSyncBuf();
	}

	private loadSyncBuf() {
		if (existsSync(SYNC_BUF_FILE)) {
			try {
				this.getUpdatesBuf = readFileSync(SYNC_BUF_FILE, 'utf-8').trim();
				if (this.getUpdatesBuf) {
					console.log(`[监听] 加载同步游标: ${this.getUpdatesBuf.substring(0, 20)}...`);
				}
			} catch (e) {
				console.warn('[监听] 同步游标加载失败，将从头开始:', e);
			}
		}
	}

	private saveSyncBuf(buf: string) {
		if (!buf) return;  // 空的不保存
		this.getUpdatesBuf = buf;
		try {
			writeFileSync(SYNC_BUF_FILE, buf);
		} catch (e) {
			console.error('[监听] 同步游标保存失败:', e);
		}
	}

	public getContextToken(userId: string): string | undefined {
		return this.contextTokens.get(userId);
	}

	public async start() {
		if (this.isRunning) {
			console.log('监听器已在运行');
			return;
		}
		this.isRunning = true;
		this.errorCount = 0;
		console.log('🚀 开始监听微信消息...');
		await this.poll();
	}

	public stop() {
		console.log('🛑 停止监听微信消息');
		this.isRunning = false;
	}

	private async poll() {
		while (this.isRunning) {
			try {
				const res = await this.client.getUpdates(this.getUpdatesBuf, LONG_POLL_TIMEOUT_SEC);
				
				// 检查 Session 过期（错误码 -14）
				if (res.errcode === SESSION_EXPIRED_ERRCODE) {
					console.error('❌ Session 已过期，暂停 1 小时后重试');
					await new Promise(resolve => setTimeout(resolve, 60 * 60 * 1000));
					this.errorCount = 0;
					continue;
				}
				
				// 检查其他业务错误
				if (res.ret && res.ret !== 0 && res.errmsg) {
					console.warn(`[API 警告] getUpdates 返回 ret=${res.ret}, errcode=${res.errcode}, errmsg=${res.errmsg}`);
				}
				
				if (res.get_updates_buf) {
					this.saveSyncBuf(res.get_updates_buf);
				}

				// 官方 API 返回的是 msgs 字段
				const messages = res.msgs || res.message_list || [];
				
				// 成功接收响应，重置错误计数
				this.errorCount = 0;
				
				if (messages.length > 0) {
					console.log(`📬 收到 ${messages.length} 条新消息`);
					
					for (const msg of messages) {
						try {
							// 基本字段检查
							if (!msg.from_user_id || !msg.item_list || msg.item_list.length === 0) {
								console.log(`⏭️ 跳过无效消息（缺少 from_user_id 或 item_list）`);
								continue;
							}
							
							// 过滤 Bot 自己发的消息
							if (msg.message_type === MESSAGE_TYPE_BOT) {
								console.log(`⏭️ 跳过 Bot 自己的消息: ${msg.message_id || msg.client_id}`);
								continue;
							}
							
							// 只处理用户消息（message_type 为 0 或 1）
							if (msg.message_type !== 0 && msg.message_type !== MESSAGE_TYPE_USER) {
								console.log(`⏭️ 跳过未知类型消息: type=${msg.message_type}`);
								continue;
							}
							
							// 过滤旧消息（首次启动时可能拉取到历史消息）
							const msgTime = msg.create_time_ms || 0;
							if (msgTime > 0 && Date.now() - msgTime > 5 * 60 * 1000) {
								console.log(`⏭️ 跳过旧消息: ${new Date(msgTime).toLocaleString()}`);
								continue;
							}
							
							// 消息去重（参考 cc-connect 实现）
							const dedupKey = `${msg.from_user_id}|${msg.message_id || 0}|${msg.seq || 0}|${msg.create_time_ms || 0}|${msg.client_id || ''}`;
							const now = Date.now();
							
							// 清理过期的去重记录
							for (const [key, ts] of this.dedupCache.entries()) {
								if (now - ts > this.DEDUP_TTL_MS) {
									this.dedupCache.delete(key);
								}
							}
							
							if (this.dedupCache.has(dedupKey)) {
								console.log(`⏭️ 跳过重复消息: ${dedupKey}`);
								continue;
							}
							this.dedupCache.set(dedupKey, now);

							// 保存 context_token（回复消息时必需）
							if (msg.context_token && msg.from_user_id) {
								this.contextTokens.set(msg.from_user_id, msg.context_token);
							}
							
							await this.onMessage(msg);
						} catch (e) {
							console.error('处理消息失败:', e);
						}
					}
				}

				this.errorCount = 0;
				
			} catch (e: any) {
				this.errorCount++;
				console.error(`轮询消息失败 (${this.errorCount}/${this.MAX_ERROR_COUNT}):`, e.message);
				
				// Token失效（HTTP 401）
				if (e.message.includes('401') || e.message.includes('UNAUTHORIZED')) {
					console.error('❌ Token 已失效，请重新登录');
					console.error('💡 删除 .wechat_token.json 后重新启动服务');
					this.isRunning = false;
					break;
				}

				if (this.errorCount >= this.MAX_ERROR_COUNT) {
					console.error('❌ 连续失败次数过多，停止监听');
					this.isRunning = false;
					break;
				}

				const backoffMs = Math.min(1000 * Math.pow(2, this.errorCount), 30000);
				console.log(`⏳ ${backoffMs}ms 后重试...`);
				await new Promise(resolve => setTimeout(resolve, backoffMs));
			}
		}
		
		console.log('✅ 消息监听已停止');
	}

	public static extractText(msg: WeixinMessage): string {
		if (!msg.item_list || msg.item_list.length === 0) {
			return '';
		}
		const textItems = msg.item_list.filter(item => item.type === MESSAGE_ITEM_TEXT);
		return textItems.map(item => item.text_item?.text || '').join('');
	}
}

// ── 带 Fallback 的 Agent 执行包装器 ─────────────────
/**
 * 执行 Agent 任务，支持模型链自动 fallback
 * 
 * @param agent AgentExecutor 实例
 * @param workspace 工作目录
 * @param primaryModel 主模型 ID
 * @param prompt 用户提示词
 * @param opts 可选参数
 * @returns Agent 执行结果 + fallback 信息
 */
async function execAgentWithFallback(
	agent: AgentExecutor,
	workspace: string,
	primaryModel: string,
	prompt: string,
	opts?: {
		apiKey?: string;
		platform?: 'wechat';
		webhook?: string;
		sessionId?: string;
		onSessionId?: (sid: string) => void;
		onProgress?: (p: AgentProgress) => void;
		onStart?: () => void;
	},
): Promise<{
	result: string;
	usedFallback?: boolean;
	fallbackModel?: string;
	errorMsg?: string;
	sessionId?: string;
}> {
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
			
			const out = await agent.execute({
				workspace,
				model: model.id,
				prompt,
				apiKey: opts?.apiKey,
				platform: opts?.platform,
				webhook: opts?.webhook,
				sessionId: opts?.sessionId,
				onStart: opts?.onStart ?? (() => {
					console.log(`[Agent] 开始执行... (模型: ${model.id})`);
				}),
				onProgress: opts?.onProgress,
			});

			if (out.sessionId && opts?.onSessionId) {
				try {
					opts.onSessionId(out.sessionId);
				} catch (e) {
					console.error('[onSessionId]', e);
				}
			}

			let finalOutput = out.result;
			if (out.toolSummary && out.toolSummary.length > 0) {
				const summary = buildToolSummary(out.toolSummary);
				if (summary) finalOutput = `${summary}\n\n---\n\n${out.result}`;
			}

			// 成功执行
			if (isFallback) {
				// 如果是因为黑名单跳过的，静默切换，不提示
				if (wasBlacklisted && i === 0) {
					return { result: finalOutput, sessionId: out.sessionId };
				}

				// 如果是运行中失败导致的 fallback，返回错误信息（用于显示提示）
				return {
					result: finalOutput,
					usedFallback: true,
					fallbackModel: model.id,
					errorMsg: lastError?.message || '',
					sessionId: out.sessionId,
				};
			}

			return { result: finalOutput, sessionId: out.sessionId };
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

// ── 定时任务文件修正（Agent 误写工作区时）────────────────
async function fixCronJobsLocationWechat(workspace: string, webhook: string) {
	const wrongPath = pathResolve(workspace, 'cron-jobs.json');
	const correctPath = pathResolve(ROOT, 'cron-jobs-wechat.json');
	if (!existsSync(wrongPath)) return;
	try {
		console.log(`[修正] 发现错误位置的任务文件: ${wrongPath}`);
		const wrongData = JSON.parse(readFileSync(wrongPath, 'utf-8'));
		let correctData: { version: number; jobs: CronJob[] };
		try {
			correctData = JSON.parse(readFileSync(correctPath, 'utf-8'));
		} catch {
			correctData = { version: 1, jobs: [] };
		}
		for (const job of wrongData.jobs || []) {
			if (job.platform && job.platform !== 'wechat') continue;
			if (!job.platform) job.platform = 'wechat';
			if (!job.webhook) job.webhook = webhook;
			const dup = correctData.jobs.some((j: CronJob) => j.id === job.id);
			if (!dup) correctData.jobs.push(job);
		}
		writeFileSync(correctPath, JSON.stringify(correctData, null, 2));
		unlinkSync(wrongPath);
		console.log(`[修正] 已合并到 ${correctPath}`);
	} catch (err) {
		console.error('[修正] 失败:', err);
	}
}

// ── 主服务启动 ─────────────────────────────────────
async function startWechatServer() {
	console.log('='.repeat(60));
	console.log('微信 → Cursor Agent 中继服务（完整命令 / 会话 / 定时 / 记忆）');
	console.log('='.repeat(60));

	const auth = new WechatAuth();
	const token = await auth.login();
	const accountId = auth.getAccountId();
	if (!accountId) throw new Error('登录成功但未获取到 accountId');

	const client = new WechatClient(token, accountId, auth.getBaseUrl());

	const wechatContextTokens = new Map<string, string>();
	let lastWechatUserId: string | undefined;

	const sendWechatText = async (toUserId: string, body: string, ctxTok: string) => {
		for (let off = 0; off < body.length; off += MAX_MESSAGE_CHUNK) {
			const chunk = body.slice(off, off + MAX_MESSAGE_CHUNK);
			await client.sendTextMessage(toUserId, chunk, ctxTok);
			if (off + MAX_MESSAGE_CHUNK < body.length) {
				await new Promise((r) => setTimeout(r, 300));
			}
		}
	};

	const heartbeat = new HeartbeatRunner({
		config: {
			enabled: false,
			everyMs: 30 * 60_000,
			workspaceDir: memoryWorkspace,
		},
		onExecute: async (prompt: string) => {
			memory?.appendSessionLog(memoryWorkspace, 'user', '[心跳检查] ' + prompt.slice(0, 200), config.CURSOR_MODEL);
			const ex = await execAgentWithFallback(agentExecutor, memoryWorkspace, config.CURSOR_MODEL || DEFAULT_MODEL, prompt, {
				apiKey: config.CURSOR_API_KEY || undefined,
				platform: 'wechat',
			});
			memory?.appendSessionLog(memoryWorkspace, 'assistant', ex.result.slice(0, 3000), config.CURSOR_MODEL);
			return ex.result;
		},
		onDelivery: async (content: string) => {
			const uid = lastWechatUserId;
			if (!uid) {
				console.warn('[心跳] 无最近微信用户，跳过推送');
				return;
			}
			const tok = wechatContextTokens.get(uid);
			if (!tok) {
				console.warn('[心跳] 无 context_token，请让用户先发一条消息');
				return;
			}
			await sendWechatText(uid, `💓 **心跳检查**\n\n${content.slice(0, 3000)}`, tok);
		},
		log: (m: string) => console.log(`[心跳] ${m}`),
	});

	const cronStorePath = pathResolve(ROOT, 'cron-jobs-wechat.json');
	const scheduler = new Scheduler({
		storePath: cronStorePath,
		defaultWorkspace,
		onExecute: async (job: CronJob) => {
			const msg = job.message;
			const isNews =
				msg === 'fetch-news' ||
				msg === '{"type":"fetch-news"}' ||
				(typeof msg === 'string' && msg.startsWith('{"type":"fetch-news"'));
			if (isNews) {
				let topN = 15;
				if (typeof msg === 'string' && msg.startsWith('{')) {
					try {
						const parsed = JSON.parse(msg) as { options?: { topN?: number } };
						topN = parsed.options?.topN ?? 15;
					} catch {
						/* ignore */
					}
				}
				const { messages } = await fetchNews({ topN, platform: 'wechat' });
				if (messages.length > 1) {
					return { status: 'ok' as const, result: JSON.stringify({ chunks: messages }) };
				}
				return { status: 'ok' as const, result: messages[0] ?? '' };
			}
			return { status: 'ok' as const, result: job.message };
		},
		onDelivery: async (job: CronJob, result: string) => {
			if (job.platform && job.platform !== 'wechat') {
				console.log(`[定时] 任务 ${job.name} 属于 ${job.platform}，跳过微信推送`);
				return;
			}
			const uid = job.webhook || lastWechatUserId;
			if (!uid) {
				console.warn('[定时] 无用户 ID，跳过推送');
				return;
			}
			const tok = wechatContextTokens.get(uid);
			if (!tok) {
				console.warn('[定时] 无 context_token（请让用户先发一条消息激活会话）');
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
				const title =
					chunks.length > 1 ? `⏰ **${job.name}** (${i + 1}/${chunks.length})` : `⏰ **定时：${job.name}**`;
				await sendWechatText(uid, `${title}\n\n${ch.slice(0, 3500)}`, tok);
				if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 500));
			}
		},
		log: (m: string) => console.log(`[调度] ${m}`),
	});

	console.log(`
┌──────────────────────────────────────────────────┐
│  微信个人号 → Cursor Agent 中继服务               │
├──────────────────────────────────────────────────┤
│  模型: ${config.CURSOR_MODEL}
│  账号: ${accountId}
│  记忆: ${memory ? `已启用（${config.VOLC_EMBEDDING_MODEL}）` : '未初始化'}
│  调度: cron-jobs-wechat.json
│  定时/心跳推送依赖用户最近一条消息的 context_token
└──────────────────────────────────────────────────┘
`);

	scheduler.start().catch((err: unknown) => console.error('[调度] 启动失败:', err));
	heartbeat.start();
	console.log('[心跳] 已启动，默认关闭（/心跳 开启）');

	const monitor = new WechatMonitor(client, async (msg: WeixinMessage) => {
		try {
			const uid = msg.from_user_id;
			if (!uid) {
				console.warn('[微信] 消息缺少 from_user_id，跳过');
				return;
			}
			const text = WechatMonitor.extractText(msg);
			if (!text.trim()) {
				console.log(`[微信] 忽略空消息 from ${uid}`);
				return;
			}
			console.log(`[微信] 收到消息: ${text.substring(0, 50)}...`);

			const contextToken = monitor.getContextToken(uid) || msg.context_token;
			if (!contextToken) {
				console.warn('[微信] 缺少 context_token，无法回复');
				return;
			}

			wechatContextTokens.set(uid, contextToken);
			lastWechatUserId = uid;

			const session = getSession(uid, defaultWorkspace);

			const wechatAdapter: PlatformAdapter = {
				reply: async (content: string) => {
					await sendWechatText(uid, content, contextToken);
				},
			};

			const commandContext: CommandContext = {
				platform: 'wechat',
				projectsConfig,
				defaultWorkspace,
				memoryWorkspace,
				config,
				scheduler,
				memory: memory ?? null,
				heartbeat,
				activeAgents,
				busySessions,
				sessionsStore,
				getCurrentProject: (ws: string) => getCurrentProject(ws) || null,
				getLockKey,
				archiveAndResetSession,
				getSessionHistory,
				getActiveSessionId: (ws: string) => getActiveSessionId(ws) || null,
				switchToSession,
				rootDir: ROOT,
				agentExecutor,
			};

			const commandHandler = new CommandHandler(wechatAdapter, commandContext);

			const cmdHandled = await commandHandler.route(text, (newSessionId: string) => {
				session.agentId = newSessionId;
			});
			if (cmdHandled) {
				console.log('[命令] 已由 CommandHandler 处理');
				return;
			}

			const relativeNewsMatch = text.match(
				/(\d+)\s*(分钟|小时)(?:[后以]后|后)\s*(?:推送|发送)?\s*(?:前|top)?\s*(\d+)?\s*条?\s*(?:今日)?\s*(热点|新闻|热榜)/i,
			);
			if (relativeNewsMatch) {
				const [, numStr, unit, topNStr] = relativeNewsMatch;
				const num = parseInt(numStr!, 10);
				const topN = topNStr ? Math.min(50, Math.max(1, parseInt(topNStr, 10))) : 15;
				const minutes = unit === '小时' ? num * 60 : num;
				const runAt = new Date(Date.now() + minutes * 60 * 1000);
				const timeDesc = `${num}${unit}后（${runAt.toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' })}）`;
				const message = JSON.stringify({ type: 'fetch-news', options: { topN } });
				try {
					await scheduler.add({
						name: '热点新闻推送',
						enabled: true,
						deleteAfterRun: true,
						schedule: { kind: 'at', at: runAt.toISOString() },
						message,
						platform: 'wechat',
						webhook: uid,
					});
					await sendWechatText(
						uid,
						`✅ 已创建定时任务\n\n⏰ 执行时间：${timeDesc}\n📰 推送内容：今日热点新闻（前 ${topN} 条）\n📱 到时会通过**微信**推送给你\n\n发送 \`/任务\` 可查看所有任务`,
						contextToken,
					);
				} catch (error) {
					await sendWechatText(
						uid,
						`❌ 创建定时任务失败\n\n${error instanceof Error ? error.message : String(error)}`,
						contextToken,
					);
				}
				return;
			}

			const newsScheduleMatch = text.match(
				/(每天|每日|明天)\s*(早上|上午|下午)?\s*([0-9一二三四五六七八九十]+)\s*[点时]?\s*(?:给我)?\s*(?:推送|发送)?\s*(?:下|今日)?\s*(热点|新闻|热榜)/i,
			);
			if (newsScheduleMatch) {
				const [, when, ap, hourStr] = newsScheduleMatch;
				const numMap: Record<string, number> = {
					一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
				};
				const toNum = (s: string) => (numMap[s] ?? parseInt(s, 10)) || 9;
				let topN = 15;
				const topMatch = text.match(/(?:推送|前)\s*(\d+)\s*条/i);
				if (topMatch) topN = Math.min(50, Math.max(1, parseInt(topMatch[1]!, 10)));
				let schedule: { kind: 'cron'; expr: string; tz?: string } | { kind: 'at'; at: string };
				let timeDesc: string;
				if (when === '每天' || when === '每日') {
					const hour = toNum(hourStr!);
					const hour24 = ap === '下午' ? (hour % 12) + 12 : hour;
					schedule = { kind: 'cron', expr: `0 ${hour24} * * *`, tz: 'Asia/Shanghai' };
					timeDesc = `每天 ${hour24}:00`;
				} else {
					let hour = toNum(hourStr!);
					if (ap === '下午') hour = (hour % 12) + 12;
					const d = new Date();
					d.setDate(d.getDate() + 1);
					d.setHours(hour, 0, 0, 0);
					schedule = { kind: 'at', at: d.toISOString() };
					timeDesc = `明天 ${hour}:00`;
				}
				const message = JSON.stringify({ type: 'fetch-news', options: { topN } });
				try {
					await scheduler.add({
						name: '热点新闻推送',
						enabled: true,
						deleteAfterRun: false,
						schedule,
						message,
						platform: 'wechat',
						webhook: uid,
					});
					await sendWechatText(
						uid,
						`✅ 已创建定时任务\n\n⏰ 执行时间：${timeDesc}\n📰 推送内容：今日热点新闻（前 ${topN} 条）\n📱 到时会通过**微信**推送给你\n\n发送 \`/任务\` 可查看所有任务`,
						contextToken,
					);
				} catch (error) {
					await sendWechatText(
						uid,
						`❌ 创建定时任务失败\n\n${error instanceof Error ? error.message : String(error)}`,
						contextToken,
					);
				}
				return;
			}

			const routeIntent = detectRouteIntent(text, Object.keys(projectsConfig.projects));
			const { workspace, message, intent, routeChanged } = resolveWorkspace(
				text,
				projectsConfig.projects,
				projectsConfig.default_project,
				getCurrentProject(defaultWorkspace),
				routeIntent,
			);

			if (routeChanged && intent.type === 'switch' && intent.project) {
				const projectInfo = projectsConfig.projects[intent.project];
				if (!projectInfo) {
					const names = Object.keys(projectsConfig.projects);
					await sendWechatText(
						uid,
						`❌ **未找到项目「${intent.project}」**\n\n可用：\n${names.map((n) => `- \`${n}\``).join('\n')}`,
						contextToken,
					);
					return;
				}
				if (!existsSync(projectInfo.path)) {
					await sendWechatText(
						uid,
						`❌ **路径不存在**\n\n\`${projectInfo.path}\``,
						contextToken,
					);
					return;
				}
				setCurrentProject(defaultWorkspace, intent.project);
				await sendWechatText(
					uid,
					`✅ **已切换到项目：${intent.project}**\n\n📁 ${projectInfo.description}\n\n\`\`\`\n${projectInfo.path}\n\`\`\``,
					contextToken,
				);
				return;
			}

			if (routeChanged && intent.type === 'switch' && intent.path) {
				const names = Object.keys(projectsConfig.projects).map((n) => `\`${n}\``).join('、');
				await sendWechatText(
					uid,
					`⚠️ **路径切换不支持持久化**\n\n请使用「切换到 项目名」或 \`#项目名 消息\`。可用项目：${names}`,
					contextToken,
				);
				return;
			}

			if (message !== text) {
				const routedHandled = await commandHandler.route(message, (sid: string) => {
					session.agentId = sid;
				});
				if (routedHandled) return;
			}

			if (message.startsWith('/')) {
				const cmd = message.split(/[\s:：]/)[0];
				await sendWechatText(
					uid,
					`未知指令 \`${cmd}\`\n\n发送 \`/帮助\` 查看可用指令。`,
					contextToken,
				);
				return;
			}

			let lockKey = getLockKey(workspace);
			if (busySessions.has(lockKey)) {
				// 显示"正在输入中"而不是发送普通文本
				try {
					await client.sendTypingIndicator(uid, contextToken, '⏳ 排队中，请稍候...');
				} catch (e) {
					await sendWechatText(uid, '⏳ 当前会话有任务进行中，请稍候…', contextToken);
				}
				const maxWait = 5 * 60 * 1000;
				const startWait = Date.now();
				while (busySessions.has(lockKey)) {
					if (Date.now() - startWait > maxWait) {
						await sendWechatText(
							uid,
							'❌ 排队超时，请使用 `/终止` 或稍后再试。',
							contextToken,
						);
						return;
					}
					await new Promise((r) => setTimeout(r, 1000));
				}
			}

			try {
				busySessions.add(lockKey);
				if (memory) {
					memory.appendSessionLog(workspace, 'user', message, config.CURSOR_MODEL);
				}

				// 发送"正在输入中"状态（类似 OpenClaw）
				try {
					await client.sendTypingIndicator(uid, contextToken, '⏳ 思考中...');
				} catch (typingErr) {
					// 输入提示失败不影响主流程
					console.warn('[输入提示] 发送失败:', typingErr);
				}

				const taskStart = Date.now();
				const ex = await execAgentWithFallback(
					agentExecutor,
					workspace,
					config.CURSOR_MODEL || DEFAULT_MODEL,
					message,
					{
						apiKey: config.CURSOR_API_KEY || undefined,
						platform: 'wechat',
						webhook: uid,
						sessionId: session.agentId,
						onSessionId: (sid: string) => {
							session.agentId = sid;
							setActiveSession(workspace, sid, message.slice(0, 40));
							const oldLockKey = lockKey;
							const newLockKey = `session:${sid}`;
							if (oldLockKey !== newLockKey) {
								const ag = activeAgents.get(oldLockKey);
								if (ag) {
									activeAgents.delete(oldLockKey);
									activeAgents.set(newLockKey, ag);
								}
								if (busySessions.has(oldLockKey)) {
									busySessions.delete(oldLockKey);
									busySessions.add(newLockKey);
								}
								lockKey = newLockKey;
							}
						},
						onProgress: (p) => {
							if (p.elapsed > 0 && Math.floor(p.elapsed) % 15 === 0) {
								console.log(`[Agent] ${formatElapsed(Math.floor(p.elapsed))} ${p.phase}`);
							}
						},
					},
				);

				let cleanOutput = ex.result.trim();
				if (ex.usedFallback && ex.fallbackModel) {
					let reason = '主模型执行失败';
					const errMsg = ex.errorMsg || '';
					if (errMsg.toLowerCase().includes('quota') || errMsg.includes('配额')) reason = '模型配额已用尽';
					else if (errMsg.toLowerCase().includes('rate limit')) reason = '请求频率超限';
					else if (errMsg.toLowerCase().includes('timeout')) reason = '请求超时';
					cleanOutput = `⚠️ **模型降级**\n\n${reason}，已改用 \`${ex.fallbackModel}\`。\n\n---\n\n${cleanOutput}`;
				}

				if (memory) {
					memory.appendSessionLog(workspace, 'assistant', cleanOutput.slice(0, 3000), config.CURSOR_MODEL);
				}

				await fixCronJobsLocationWechat(workspace, uid);
				scheduler.reload().catch(() => {});

				if (cleanOutput) {
					await sendWechatText(uid, cleanOutput, contextToken);
				} else {
					await sendWechatText(uid, '✅ 任务已完成（无输出）', contextToken);
				}
				console.log(`[完成] workspace=${workspace} elapsed=${formatElapsed(Math.round((Date.now() - taskStart) / 1000))}`);
			} catch (error) {
				const errMsg = error instanceof Error ? error.message : String(error);
				if (errMsg === 'MANUALLY_STOPPED') {
					console.log('[手动终止]', lockKey);
				} else {
					console.error('[失败]', errMsg.slice(0, 200));
					await sendWechatText(
						uid,
						`❌ **执行失败**\n\n\`\`\`\n${errMsg.slice(0, 500)}\n\`\`\`\n\n发送 \`/帮助\` 查看命令。`,
						contextToken,
					);
				}
			} finally {
				busySessions.delete(lockKey);
			}
		} catch (err) {
			console.error('[微信] 消息处理外层异常:', err);
		}
	});

	console.log('\n✅ 微信服务已启动！');
	console.log(`📱 当前模型: ${config.CURSOR_MODEL}`);
	console.log(`📂 默认项目: ${projectsConfig.default_project}`);

	const shutdown = () => {
		console.log('\n👋 正在关闭微信服务...');
		const active = agentExecutor.getActiveAgents();
		if (active.length > 0) {
			agentExecutor.killAll();
			activeAgents.clear();
			busySessions.clear();
		}
		unwatchFile(ENV_PATH);
		unwatchFile(PROJECTS_PATH);
		heartbeat.stop();
		scheduler.stop();
		if (memory) {
			try {
				memory.close();
			} catch (e) {
				console.error('[退出] 记忆关闭失败', e);
			}
		}
		monitor.stop();
		process.exit(0);
	};

	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
	
	// 网络恢复监控已禁用：
	// 实践证明频繁的主动重连反而导致消息丢失和连接不稳定
	// 微信长轮询有自己的错误重试机制（指数退避），已足够可靠
	// if (process.platform === 'darwin') {
	// 	const { startNetworkRecoveryMonitor } = await import('../shared/network-recovery.js');
	// 	startNetworkRecoveryMonitor({ ... });
	// }
	
	// 启动长轮询监听（会阻塞直到 monitor.stop() 被调用）
	await monitor.start();
}

// 启动服务
startWechatServer().catch(err => {
	console.error('启动失败:', err);
	process.exit(1);
});
