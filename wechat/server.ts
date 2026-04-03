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
	getDefaultModel,
	getAvailableModelChain,
	shouldFallback,
	isQuotaExhausted,
	addToBlacklist,
	isBlacklisted,
} from '../shared/models-config.js';
import * as qrcodeTerminal from 'qrcode-terminal';

import { AgentExecutor, writeFeedbackGateResponse, type AgentProgress, type FeedbackGateRequest } from '../shared/agent-executor.js';
import { Scheduler, type CronJob } from '../shared/scheduler.js';
import { MemoryManager } from '../shared/memory.js';
import { HeartbeatRunner, getHeartbeatGlobalConfig, createSessionActivityGate, isHeartbeatEnabled } from '../shared/heartbeat.js';
import { FeilianController, type OperationResult } from '../shared/feilian-control.js';
import { fetchNews } from '../shared/news-fetcher.js';
import { getHealthStatus } from '../shared/news-sources/monitoring.js';
import { CommandHandler, type PlatformAdapter, type CommandContext } from '../shared/command-handler.js';
import { ProcessLock } from '../shared/process-lock.js';
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
import {
	downloadAndDecryptMedia,
	uploadImageToCdn,
	uploadVideoToCdn,
	uploadFileToCdn,
	downloadRemoteImage,
} from './lib/media-handler.js';

// ── 进程锁（防止多实例运行）──────────────────────
const processLock = new ProcessLock("wechat");
if (!processLock.acquire()) {
	console.error("\n❌ 微信服务已在运行，无法启动第二个实例");
	console.error("💡 如需重启，请先停止现有进程: pkill -f 'wechat/server.ts'");
	process.exit(1);
}

const HOME = process.env.HOME!;
const ROOT = pathResolve(import.meta.dirname, '..');
const ENV_PATH = pathResolve(import.meta.dirname, '.env');
const PROJECTS_PATH = pathResolve(ROOT, 'projects.json');
const INBOX_DIR = pathResolve(ROOT, 'inbox');
const TOKEN_FILE = pathResolve(import.meta.dirname, '.wechat_token.json');
const SYNC_BUF_FILE = pathResolve(import.meta.dirname, '.wechat_sync_buf');
const CONTEXT_TOKEN_FILE = pathResolve(import.meta.dirname, '.wechat_context_tokens.json');
const BOOT_DELAY_MS = 8000;

// 微信 API 配置
const WECHAT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const WECHAT_BOT_TYPE = '3';
const WECHAT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const LONG_POLL_TIMEOUT_SEC = 35;
const MAX_MESSAGE_CHUNK = 3800;
const SESSION_EXPIRED_ERRCODE = -14;
const CHANNEL_VERSION = 'cursor-remote-control/1.0';

// Typing 状态配置（参考 OpenClaw）
const TYPING_STATUS_TYPING = 1;
const TYPING_STATUS_CANCEL = 2;
const TYPING_KEEPALIVE_INTERVAL_MS = 5000; // 每 5 秒刷新一次
const TYPING_MAX_DURATION_MS = 5 * 60 * 1000; // 最多维持 5 分钟

mkdirSync(INBOX_DIR, { recursive: true });

// 清理 inbox
const DAY_MS = 24 * 60 * 60 * 1000;
for (const f of readdirSync(INBOX_DIR)) {
	const p = pathResolve(INBOX_DIR, f);
	try {
		if (Date.now() - statSync(p).mtimeMs > DAY_MS) unlinkSync(p);
	} catch {}
}

/**
 * 将 Markdown 文本转换为纯文本（完全按照 OpenClaw 实现）
 * 微信个人号不支持 Markdown，需要转换为纯文本
 * 
 * 策略：简洁处理，只移除 Markdown 语法，不添加装饰符号
 * 参考：OpenClaw 的 markdownToPlainText 实现
 */
/**
 * 将 Markdown 转为纯文本（完全按照 OpenClaw 微信实现）
 * 
 * 特点：
 * - 保留列表标记（-、*、数字等）
 * - 零依赖，纯正则实现
 * - 移除代码块围栏、图片、链接格式、表格格式
 * - 移除粗体、斜体、标题、行内代码、水平线
 */
function markdownToPlainText(text: string): string {
	let result = text;
	
	// === OpenClaw 微信专用处理 ===
	// 1. 代码块：移除围栏，保留内容
	result = result.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code: string) => code.trim());
	
	// 2. 图片：完全移除
	result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
	
	// 3. 链接：只保留显示文本
	result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
	
	// 4. 表格：移除分隔符行，管道符转空格
	result = result.replace(/^\|[\s:|-]+\|$/gm, '');
	result = result.replace(/^\|(.+)\|$/gm, (_, inner: string) => {
		return inner.split('|').map(cell => cell.trim()).join('  ');
	});
	
	// === OpenClaw 通用 stripMarkdown（8 步） ===
	// 5. 移除粗体
	result = result.replace(/\*\*(.+?)\*\*/g, '$1');
	result = result.replace(/__(.+?)__/g, '$1');
	
	// 6. 移除斜体
	result = result.replace(/\*(.+?)\*/g, '$1');
	result = result.replace(/_(.+?)_/g, '$1');
	
	// 7. 移除标题前缀
	result = result.replace(/^#+\s?(.*)$/gm, '$1');
	
	// 8. 移除水平线
	result = result.replace(/^[-*_]{3,}$/gm, '');
	
	// 9. 移除行内代码
	result = result.replace(/`([^`]+)`/g, '$1');
	
	// 10. 压缩多个换行为最多两个
	result = result.replace(/\n{3,}/g, '\n\n');
	
	return result.trim();
}

// ── Typing Keepalive（参考 OpenClaw） ───────────────
/**
 * 启动 typing 状态保活（每 5 秒刷新一次，最多维持 5 分钟）
 * @param client 微信客户端实例
 * @param userId 用户 ID
 * @returns 清理函数
 */
function startTypingKeepalive(client: WechatClient, userId: string): () => void {
	const startTime = Date.now();
	
	// 立即发送一次
	client.sendTypingIndicator(userId, TYPING_STATUS_TYPING).catch(() => {});
	
	// 定时刷新
	const intervalId = setInterval(() => {
		const elapsed = Date.now() - startTime;
		
		// 超过最大时长，停止刷新
		if (elapsed > TYPING_MAX_DURATION_MS) {
			clearInterval(intervalId);
			return;
		}
		
		// 刷新 typing 状态
		client.sendTypingIndicator(userId, TYPING_STATUS_TYPING).catch(() => {});
	}, TYPING_KEEPALIVE_INTERVAL_MS);
	
	// 返回清理函数
	return () => {
		clearInterval(intervalId);
		// 发送取消状态
		client.sendTypingIndicator(userId, TYPING_STATUS_CANCEL).catch(() => {});
	};
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
		CURSOR_MODEL: env.CURSOR_MODEL || '',
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
const MESSAGE_STATE_FINISH = 2;  // 消息完成状态

interface TextItem {
	text: string;
}

interface CDNMedia {
	encrypt_query_param?: string;
	aes_key?: string;
	encrypt_type?: number;
	full_url?: string;
}

interface ImageItem {
	media?: CDNMedia;
	thumb_media?: CDNMedia;
	aeskey?: string; // Raw AES-128 key as hex string (16 bytes)
	url?: string;
	mid_size?: number;
	thumb_size?: number;
	thumb_height?: number;
	thumb_width?: number;
	hd_size?: number;
}

interface VoiceItem {
	media?: CDNMedia;
	duration?: number;
	text?: string;
}

interface FileItem {
	media?: CDNMedia;
	file_name?: string;
	len?: string;
	md5?: string;
}

interface VideoItem {
	media?: CDNMedia;
	thumb_media?: CDNMedia;
	aeskey?: string;
	url?: string;
	video_size?: number; // 视频密文大小
	duration?: number;
	thumb_size?: number;
	thumb_height?: number;
	thumb_width?: number;
	hd_size?: number;
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
		public baseUrl: string = WECHAT_BASE_URL
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
	 * 获取用户会话配置（包含 typing_ticket）
	 */
	private async getConfig(userId: string): Promise<any> {
		return this.request('/ilink/bot/getconfig', {
			base_info: { 
				channel_version: CHANNEL_VERSION
			},
			ilink_user_id: userId
		});
	}

	// typing_ticket 缓存（避免重复获取）
	private typingTicketCache = new Map<string, string>();

	/**
	 * 发送"正在输入中"状态（参考 OpenClaw 实现）
	 * @param userId 目标用户ID
	 * @param status 状态：1=正在输入，2=取消输入
	 * @returns Promise
	 */
	public async sendTypingIndicator(userId: string, status: number = TYPING_STATUS_TYPING): Promise<any> {
		try {
			// 1. 从缓存获取或首次获取 typing_ticket
			let typingTicket = this.typingTicketCache.get(userId);
			
			if (!typingTicket) {
				const config = await this.getConfig(userId);
				typingTicket = config?.typing_ticket;
				
				if (!typingTicket) {
					console.warn('[Typing] 未获取到 typing_ticket');
					return { ok: false, error: 'no_typing_ticket' };
				}
				
				// 缓存 ticket
				this.typingTicketCache.set(userId, typingTicket);
			}

			// 2. 发送 typing 状态
			return this.request('/ilink/bot/sendtyping', {
				base_info: { 
					channel_version: CHANNEL_VERSION
				},
				ilink_user_id: userId,
				typing_ticket: typingTicket,
				status
			});
		} catch (error) {
			console.warn('[Typing] 发送失败:', error);
			return { ok: false, error };
		}
	}

	public async sendTextMessage(toUserId: string, text: string, contextToken?: string): Promise<any> {
		if (!contextToken) {
			console.warn(`[微信] contextToken missing for to=${toUserId}, sending without context (may fail at API level)`);
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
						context_token: contextToken ?? undefined
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
				context_token: contextToken ?? undefined
			}
		});
	}

	/**
	 * 通用消息发送方法（支持图片、视频、文件等）
	 */
	public async sendMessage(params: {
		to_user_id: string;
		context_token?: string;
		item_list: Array<{
			type: number;
			text_item?: { text: string };
			image_item?: any;
			video_item?: any;
			file_item?: any;
		}>;
	}): Promise<any> {
		return await this.request('/ilink/bot/sendmessage', {
			base_info: {
				channel_version: CHANNEL_VERSION,
			},
			msg: {
				from_user_id: '',
				to_user_id: params.to_user_id,
				client_id: `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
				message_type: MESSAGE_TYPE_BOT,
				message_state: MESSAGE_STATE_FINISH,
				item_list: params.item_list,
				context_token: params.context_token ?? undefined,
			},
		});
	}
}

// ── Feedback Gate: 状态管理 ──
interface PendingFeedbackGate {
	triggerId: string;
	message: string;
	title: string;
	uid: string;
	createdAt: number;
}
const pendingFeedbackGates = new Map<string, PendingFeedbackGate>();
const FEEDBACK_GATE_TIMEOUT = 24 * 60 * 60 * 1000; // 24h

// ── 消息监听器 ─────────────────────────────────────
class WechatMonitor {
	private isRunning = false;
	private getUpdatesBuf?: string;
	private errorCount = 0;
	private readonly MAX_ERROR_COUNT = 10;
	private dedupCache = new Map<string, number>();
	private readonly DEDUP_TTL_MS = 5 * 60 * 1000;
	private contextTokens = new Map<string, string>();
	private longPollTimeoutSec = LONG_POLL_TIMEOUT_SEC;  // 动态调整的长轮询超时（秒）

	constructor(
		private client: WechatClient,
		private onMessage: (msg: WeixinMessage) => Promise<void>
	) {
		this.loadSyncBuf();
		this.loadContextTokens();
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

	/** 从磁盘加载 context_token（服务重启后恢复会话） */
	private loadContextTokens() {
		if (existsSync(CONTEXT_TOKEN_FILE)) {
			try {
				const data: Record<string, string> = JSON.parse(readFileSync(CONTEXT_TOKEN_FILE, 'utf-8'));
				let count = 0;
				for (const [userId, token] of Object.entries(data)) {
					if (typeof token === 'string' && token) {
						this.contextTokens.set(userId, token);
						count++;
					}
				}
				if (count > 0) {
					console.log(`[监听] 加载 ${count} 个用户的 context_token`);
				}
			} catch (e) {
				console.warn('[监听] context_token 加载失败:', e);
			}
		}
	}

	/** 保存 context_token 到磁盘（立即持久化） */
	private saveContextTokens() {
		try {
			const data: Record<string, string> = {};
			for (const [userId, token] of this.contextTokens) {
				data[userId] = token;
			}
			writeFileSync(CONTEXT_TOKEN_FILE, JSON.stringify(data, null, 2), 'utf-8');
		} catch (e) {
			console.error('[监听] context_token 保存失败:', e);
		}
	}

	public getContextToken(userId: string): string | undefined {
		return this.contextTokens.get(userId);
	}

	/** 获取所有 context_token（用于同步到全局 Map） */
	public getAllContextTokens(): Map<string, string> {
		return new Map(this.contextTokens);
	}

	/** 设置 context_token 并立即持久化 */
	public setContextToken(userId: string, token: string): void {
		this.contextTokens.set(userId, token);
		this.saveContextTokens();
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
				const res = await this.client.getUpdates(this.getUpdatesBuf, this.longPollTimeoutSec);
				
				// 优化 1：动态调整长轮询超时（参考 OpenClaw）
				if (res.longpolling_timeout_ms != null && res.longpolling_timeout_ms > 0) {
					this.longPollTimeoutSec = Math.floor(res.longpolling_timeout_ms / 1000);
					console.log(`[轮询] 服务端建议超时时间已更新: ${this.longPollTimeoutSec}秒`);
				}
				
				// 优化 2：统一错误检查（参考 OpenClaw）
				const isApiError = 
					(res.ret !== undefined && res.ret !== 0) || 
					(res.errcode !== undefined && res.errcode !== 0);
				
				if (isApiError) {
					// 检查 Session 过期（错误码 -14，同时检查 ret 和 errcode）
					const isSessionExpired = 
						res.errcode === SESSION_EXPIRED_ERRCODE || 
						res.ret === SESSION_EXPIRED_ERRCODE;
					
					if (isSessionExpired) {
						console.error('❌ Session 已过期，暂停 1 小时后重试');
						await new Promise(resolve => setTimeout(resolve, 60 * 60 * 1000));
						this.errorCount = 0;  // Session 过期重置计数
						continue;
					}
					
					// 其他 API 错误计入失败次数
					this.errorCount++;
					console.warn(
						`[API 错误] getUpdates 失败 (${this.errorCount}/${this.MAX_ERROR_COUNT}): ret=${res.ret}, errcode=${res.errcode}, errmsg=${res.errmsg ?? ''}`
					);
					
					if (this.errorCount >= this.MAX_ERROR_COUNT) {
						console.error(`⚠️ 连续失败 ${this.MAX_ERROR_COUNT} 次，等待 30 秒后重置计数器继续监听...`);
						await new Promise(resolve => setTimeout(resolve, 30000));
						this.errorCount = 0;
						continue;
					}
					
					// 失败次数未达上限，短暂等待后重试
					const backoffMs = Math.min(1000 * Math.pow(2, this.errorCount), 30000);
					console.log(`⏳ ${backoffMs}ms 后重试...`);
					await new Promise(resolve => setTimeout(resolve, backoffMs));
					continue;
				}
				
				// 成功接收响应，保存同步游标
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
						// 豁免：当有 pending feedback gate 时，不跳过该用户的消息
						const msgTime = msg.create_time_ms || 0;
						const hasPendingFG = pendingFeedbackGates.has(msg.from_user_id!);
						if (msgTime > 0 && Date.now() - msgTime > 5 * 60 * 1000 && !hasPendingFG) {
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

						// 保存 context_token（回复消息时必需，立即持久化）
						if (msg.context_token && msg.from_user_id) {
							this.setContextToken(msg.from_user_id, msg.context_token);
						}
						
						await this.onMessage(msg);
						} catch (e) {
							console.error('处理消息失败:', e);
						}
					}
				}
				
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

				// 参考 OpenClaw 设计：连续失败达到上限后，等待 backoff 后重置计数器继续监听（而非彻底停止）
				if (this.errorCount >= this.MAX_ERROR_COUNT) {
					console.error(`⚠️ 连续失败 ${this.MAX_ERROR_COUNT} 次，等待 30 秒后重置计数器继续监听...`);
					await new Promise(resolve => setTimeout(resolve, 30000));
					this.errorCount = 0;  // ← 重置计数器，继续监听
					continue;
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
		
		// 递归提取 item_list 中的文本（支持引用消息）
		const extractFromItemList = (itemList: MessageItem[]): string => {
			for (const item of itemList) {
				if (item.type === MESSAGE_ITEM_TEXT && item.text_item?.text) {
					const text = item.text_item.text;
					const ref = item.ref_msg;
					
					// 没有引用，直接返回
					if (!ref) return text;
					
					// 引用的是媒体（图片/视频/文件），只返回当前文本
					// 媒体会在后续流程中单独处理和显示
					if (ref.message_item && WechatMonitor.isMediaItem(ref.message_item)) {
						return text;
					}
					
					// 引用的是文本消息，构建引用上下文
					const refParts: string[] = [];
					
					// 添加引用标题（如果有）
					if (ref.title) {
						refParts.push(ref.title);
					}
					
					// 递归提取被引用消息的文本内容
					if (ref.message_item) {
						const refBody = extractFromItemList([ref.message_item]);
						if (refBody) {
							refParts.push(refBody);
						}
					}
					
					// 如果有引用内容，格式化为 [引用: xxx]\n当前文本
					if (refParts.length > 0) {
						return `[引用: ${refParts.join(' | ')}]\n${text}`;
					}
					
					return text;
				}
			}
			return '';
		};
		
		return extractFromItemList(msg.item_list);
	}
	
	/** 判断消息项是否为媒体类型（图片/视频/文件） */
	private static isMediaItem(item: MessageItem): boolean {
		return item.type === MESSAGE_ITEM_IMAGE || 
		       item.type === MESSAGE_ITEM_VIDEO || 
		       item.type === MESSAGE_ITEM_FILE;
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
		feedbackGate?: { chatId?: string; platform?: string; enabledModel?: string };
		onFeedbackRequested?: (req: FeedbackGateRequest) => void;
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
				feedbackGate: opts?.feedbackGate,
				onFeedbackRequested: opts?.onFeedbackRequested,
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

	const sendWechatText = async (toUserId: string, body: string, ctxTok?: string) => {
		// 微信个人号不支持 Markdown，转换为纯文本（OpenClaw 简洁风格）
		const plainText = markdownToPlainText(body);
		
		for (let off = 0; off < plainText.length; off += MAX_MESSAGE_CHUNK) {
			const chunk = plainText.slice(off, off + MAX_MESSAGE_CHUNK);
			await client.sendTextMessage(toUserId, chunk, ctxTok);
			if (off + MAX_MESSAGE_CHUNK < plainText.length) {
				await new Promise((r) => setTimeout(r, 300));
			}
		}
	};

	/**
	 * 发送图片消息到微信
	 * 
	 * @param toUserId 接收用户 ID
	 * @param imagePath 本地图片文件路径（绝对路径）
	 * @param ctxTok context_token
	 */
	const sendWechatImage = async (
		toUserId: string,
		imagePath: string,
		ctxTok: string | undefined,
	) => {
		console.log(`[发送图片] ${imagePath}`);

		try {
			// 1. 上传图片到 CDN
			const uploaded = await uploadImageToCdn({
				filePath: imagePath,
				toUserId,
				token,
				baseUrl: client.baseUrl,
				cdnBaseUrl: WECHAT_CDN_BASE_URL,
			});

			if (!uploaded) {
				await sendWechatText(toUserId, '❌ 图片上传失败（可能文件过大或格式不支持）', ctxTok);
				return;
			}

			console.log(`[发送图片] CDN 上传成功，准备发送消息`);

			// 2. 构造图片消息并发送
			await client.sendMessage({
				to_user_id: toUserId,
				context_token: ctxTok,
				item_list: [
					{
						type: MESSAGE_ITEM_IMAGE,
						image_item: {
							media: {
								encrypt_query_param: uploaded.downloadParam,
								aes_key: uploaded.aeskeyBase64,
							},
							hd_size: uploaded.fileSize,
							mid_size: uploaded.fileSizeCiphertext,
						},
					},
				],
			});

			console.log('✅ 图片消息已发送');
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			console.error('[发送图片] 失败:', errMsg);
			await sendWechatText(toUserId, `❌ 图片发送失败: ${errMsg.slice(0, 100)}`, ctxTok);
		}
	};

	const sendWechatVideo = async (
		toUserId: string,
		videoPath: string,
		ctxTok: string | undefined,
	) => {
		console.log(`[发送视频] ${videoPath}`);

		try {
			// 1. 上传视频到 CDN
			const uploaded = await uploadVideoToCdn({
				filePath: videoPath,
				toUserId,
				token,
				baseUrl: client.baseUrl,
				cdnBaseUrl: WECHAT_CDN_BASE_URL,
			});

			if (!uploaded) {
				await sendWechatText(toUserId, '❌ 视频上传失败（可能文件过大或格式不支持）', ctxTok);
				return;
			}

			console.log(`[发送视频] CDN 上传成功，准备发送消息`);

			// 2. 构造视频消息并发送
			await client.sendMessage({
				to_user_id: toUserId,
				context_token: ctxTok,
				item_list: [
					{
						type: MESSAGE_ITEM_VIDEO,
						video_item: {
							media: {
								encrypt_query_param: uploaded.downloadParam,
								aes_key: uploaded.aeskeyBase64,
							},
							video_size: uploaded.fileSizeCiphertext,
						},
					},
				],
			});

			console.log('✅ 视频消息已发送');
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			console.error('[发送视频] 失败:', errMsg);
			await sendWechatText(toUserId, `❌ 视频发送失败: ${errMsg.slice(0, 100)}`, ctxTok);
		}
	};

	const sendWechatFile = async (
		toUserId: string,
		filePath: string,
		ctxTok: string | undefined,
	) => {
		const fileName = filePath.split('/').pop() || 'unknown';
		console.log(`[发送文件] ${fileName} (${filePath})`);

		try {
			// 1. 上传文件到 CDN
			const uploaded = await uploadFileToCdn({
				filePath,
				toUserId,
				token,
				baseUrl: client.baseUrl,
				cdnBaseUrl: WECHAT_CDN_BASE_URL,
			});

			if (!uploaded) {
				await sendWechatText(toUserId, `❌ 文件 "${fileName}" 上传失败（可能文件过大或格式不支持）`, ctxTok);
				return;
			}

			console.log(`[发送文件] CDN 上传成功，准备发送消息`);

			// 2. 构造文件消息并发送
			await client.sendMessage({
				to_user_id: toUserId,
				context_token: ctxTok,
				item_list: [
					{
						type: MESSAGE_ITEM_FILE,
						file_item: {
							media: {
								encrypt_query_param: uploaded.downloadParam,
								aes_key: uploaded.aeskeyBase64,
							},
							file_name: fileName,
							len: String(uploaded.fileSize),
						},
					},
				],
			});

			console.log('✅ 文件消息已发送');
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			console.error('[发送文件] 失败:', errMsg);
			await sendWechatText(toUserId, `❌ 文件 "${fileName}" 发送失败: ${errMsg.slice(0, 100)}`, ctxTok);
		}
	};

	const hbGlobal = getHeartbeatGlobalConfig();
	const heartbeat = new HeartbeatRunner({
		config: {
			enabled: isHeartbeatEnabled('wechat'),
			everyMs: hbGlobal.everyMs,
			workspaceDir: memoryWorkspace,
			...(hbGlobal.activeHours ? { activeHours: hbGlobal.activeHours } : {}),
		},
		shouldRun: createSessionActivityGate(memoryWorkspace),
		onExecute: async (prompt: string) => {
			memory?.appendSessionLog(memoryWorkspace, 'user', '[心跳检查] ' + prompt.slice(0, 200), config.CURSOR_MODEL);
			const ex = await execAgentWithFallback(agentExecutor, memoryWorkspace, config.CURSOR_MODEL || getDefaultModel(), prompt, {
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
				console.warn('[心跳] contextToken missing, attempting to send without context (may fail at API level)');
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
			// 新格式：优先使用 task 字段
			if (job.task) {
				switch (job.task.type) {
					case 'fetch-news': {
						const topN = job.task.options?.topN ?? 15;
						const { messages } = await fetchNews({ topN, platform: 'wechat' });
						if (messages.length > 1) {
							return { status: 'ok' as const, result: JSON.stringify({ chunks: messages }) };
						}
						return { status: 'ok' as const, result: messages[0] ?? '' };
					}
					
					case 'agent-prompt': {
						try {
							console.log(`[定时任务] 执行 Agent (新格式): ${job.task.prompt.slice(0, 100)}`);
							const workspace = job.workspace || defaultWorkspace;
							const model = job.model || config.CURSOR_MODEL || getDefaultModel();
							
							const result = await execAgentWithFallback(
								agentExecutor,
								workspace,
								model,
								job.task.prompt,
								{
									platform: 'wechat',
									webhook: job.webhook,
								}
							);
							
							return { status: 'ok' as const, result: result.result };
						} catch (err) {
							console.error('[定时任务] Agent 执行失败:', err);
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
			
			// 1. 新闻推送任务（旧格式）
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
			
			// 2. Agent 执行任务（旧格式）
			const isAgentPrompt = typeof msg === 'string' && msg.startsWith('{"type":"agent-prompt"');
			if (isAgentPrompt) {
				try {
					const parsed = JSON.parse(msg) as {
						type: 'agent-prompt';
						prompt: string;
						options?: { timeoutMs?: number };
					};
					console.log(`[定时任务] 执行 Agent (旧格式): ${parsed.prompt.slice(0, 100)}`);
					
					const workspace = job.workspace || defaultWorkspace;
					const model = job.model || config.CURSOR_MODEL || getDefaultModel();
					
					const result = await execAgentWithFallback(
						agentExecutor,
						workspace,
						model,
						parsed.prompt,
						{
							platform: 'wechat',
							webhook: job.webhook,
						}
					);
					
					return { status: 'ok' as const, result: result.result };
				} catch (err) {
					console.error('[定时任务] Agent 执行失败:', err);
					const errMsg = err instanceof Error ? err.message : String(err);
					return { 
						status: 'error' as const, 
						error: errMsg,
						result: `❌ Agent 执行失败\n\n${errMsg}`
					};
				}
			}
			
			// 3. 普通消息（直接发送）
			return { status: 'ok' as const, result: msg };
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
				console.warn('[定时] contextToken missing, attempting to send without context (may fail at API level)');
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
│  模型: ${config.CURSOR_MODEL || getDefaultModel()}
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
		
		let text = WechatMonitor.extractText(msg);
		
		// ── 处理图片消息 ────────────────────────────
		const imageItems = msg.item_list?.filter(item => item.type === MESSAGE_ITEM_IMAGE) || [];
		let imageContext = '';
		
		if (imageItems.length > 0) {
			console.log(`📷 收到 ${imageItems.length} 张图片`);
			
			for (const item of imageItems) {
				const img = item.image_item as ImageItem | undefined;
				if (!img?.media) {
					console.warn('[图片] 缺少 media 信息，跳过');
					continue;
				}

				// 获取 AES key（优先使用 aeskey 字段，fallback 到 media.aes_key）
				const aesKeyBase64 = img.aeskey
					? Buffer.from(img.aeskey, 'hex').toString('base64')
					: img.media.aes_key;

				if (!aesKeyBase64) {
					console.warn('[图片] 缺少 AES key，跳过');
					continue;
				}

				// 下载并解密图片
				try {
					const imagePath = await downloadAndDecryptMedia({
						encryptQueryParam: img.media.encrypt_query_param,
						fullUrl: img.media.full_url,
						aesKeyBase64,
						cdnBaseUrl: WECHAT_CDN_BASE_URL,
						saveDir: INBOX_DIR,
						label: 'image',
						extension: 'jpg',
					});

					if (imagePath) {
						imageContext += `\n[用户发送了图片: file://${imagePath}]`;
						console.log(`✅ 图片已保存并传递给 Agent: ${imagePath}`);
					} else {
						console.error('[图片] 下载失败');
						imageContext += '\n[用户尝试发送图片，但下载失败]';
					}
				} catch (err) {
					console.error('[图片] 处理异常:', err);
					imageContext += '\n[用户尝试发送图片，但处理失败]';
				}
			}
		}
		
		// ── 处理视频消息 ────────────────────────────
		const videoItems = msg.item_list?.filter(item => item.type === MESSAGE_ITEM_VIDEO) || [];
		let videoContext = '';
		
		if (videoItems.length > 0) {
			console.log(`🎬 收到 ${videoItems.length} 个视频`);
			
			for (const item of videoItems) {
				const video = item.video_item as VideoItem | undefined;
				if (!video?.media) {
					console.warn('[视频] 缺少 media 信息，跳过');
					continue;
				}

				const aesKeyBase64 = video.media.aes_key;
				if (!aesKeyBase64) {
					console.warn('[视频] 缺少 AES key，跳过');
					continue;
				}

				// 下载并解密视频
				try {
					const videoPath = await downloadAndDecryptMedia({
						encryptQueryParam: video.media.encrypt_query_param,
						fullUrl: video.media.full_url,
						aesKeyBase64,
						cdnBaseUrl: WECHAT_CDN_BASE_URL,
						saveDir: INBOX_DIR,
						label: 'video',
						extension: 'mp4',
					});

					if (videoPath) {
						videoContext += `\n[用户发送了视频: file://${videoPath}]`;
						console.log(`✅ 视频已保存并传递给 Agent: ${videoPath}`);
					} else {
						console.error('[视频] 下载失败');
						videoContext += '\n[用户尝试发送视频，但下载失败]';
					}
				} catch (err) {
					console.error('[视频] 处理异常:', err);
					videoContext += '\n[用户尝试发送视频，但处理失败]';
				}
			}
		}

		// ── 处理文件消息 ────────────────────────────
		const fileItems = msg.item_list?.filter(item => item.type === MESSAGE_ITEM_FILE) || [];
		let fileContext = '';
		
		if (fileItems.length > 0) {
			console.log(`📎 收到 ${fileItems.length} 个文件`);
			
			for (const item of fileItems) {
				const file = item.file_item as FileItem | undefined;
				if (!file?.media) {
					console.warn('[文件] 缺少 media 信息，跳过');
					continue;
				}

				const aesKeyBase64 = file.media.aes_key;
				if (!aesKeyBase64) {
					console.warn('[文件] 缺少 AES key，跳过');
					continue;
				}

				// 从文件名推断扩展名
				const fileName = file.file_name || 'unknown';
				const fileNameMatch = fileName.match(/\.([a-z0-9]+)$/i);
				const ext = fileNameMatch?.[1] || 'bin';

				// 下载并解密文件
				try {
					const filePath = await downloadAndDecryptMedia({
						encryptQueryParam: file.media.encrypt_query_param,
						fullUrl: file.media.full_url,
						aesKeyBase64,
						cdnBaseUrl: WECHAT_CDN_BASE_URL,
						saveDir: INBOX_DIR,
						label: 'file',
						extension: ext,
					});

					if (filePath) {
						fileContext += `\n[用户发送了文件 "${fileName}": file://${filePath}]`;
						console.log(`✅ 文件已保存并传递给 Agent: ${filePath}`);
					} else {
						console.error('[文件] 下载失败');
						fileContext += `\n[用户尝试发送文件 "${fileName}"，但下载失败]`;
					}
				} catch (err) {
					console.error('[文件] 处理异常:', err);
					fileContext += `\n[用户尝试发送文件 "${fileName}"，但处理失败]`;
				}
			}
		}
		
		// ── 处理引用消息中的媒体 ────────────────────────────
		// 如果主消息没有媒体，检查是否引用了包含媒体的消息
		if (imageItems.length === 0 && videoItems.length === 0 && fileItems.length === 0) {
			const textItemsWithRef = msg.item_list?.filter(
				item => item.type === MESSAGE_ITEM_TEXT && item.ref_msg?.message_item
			) || [];
			
			for (const item of textItemsWithRef) {
				const refItem = item.ref_msg?.message_item;
				if (!refItem) continue;
				
				// 引用的是图片
				if (refItem.type === MESSAGE_ITEM_IMAGE && refItem.image_item?.media) {
					console.log('📷 检测到引用的图片消息');
					const img = refItem.image_item;
					const media = img.media;
					if (!media) continue;
					
					const aesKeyBase64 = img.aeskey
						? Buffer.from(img.aeskey, 'hex').toString('base64')
						: media.aes_key;
					
					if (aesKeyBase64) {
						try {
							const imagePath = await downloadAndDecryptMedia({
								encryptQueryParam: media.encrypt_query_param,
								fullUrl: media.full_url,
								aesKeyBase64,
								cdnBaseUrl: WECHAT_CDN_BASE_URL,
								saveDir: INBOX_DIR,
								label: 'ref-image',
								extension: 'jpg',
							});
							
							if (imagePath) {
								imageContext += `\n[用户引用了图片: file://${imagePath}]`;
								console.log(`✅ 引用的图片已保存: ${imagePath}`);
							}
						} catch (err) {
							console.error('[引用图片] 处理异常:', err);
							imageContext += '\n[用户引用了图片，但下载失败]';
						}
					}
				}
				
				// 引用的是视频
				else if (refItem.type === MESSAGE_ITEM_VIDEO && refItem.video_item?.media) {
					console.log('🎬 检测到引用的视频消息');
					const video = refItem.video_item;
					const media = video.media;
					if (!media) continue;
					
					if (media.aes_key) {
						try {
							const videoPath = await downloadAndDecryptMedia({
								encryptQueryParam: media.encrypt_query_param,
								fullUrl: media.full_url,
								aesKeyBase64: media.aes_key,
								cdnBaseUrl: WECHAT_CDN_BASE_URL,
								saveDir: INBOX_DIR,
								label: 'ref-video',
								extension: 'mp4',
							});
							
							if (videoPath) {
								videoContext += `\n[用户引用了视频: file://${videoPath}]`;
								console.log(`✅ 引用的视频已保存: ${videoPath}`);
							}
						} catch (err) {
							console.error('[引用视频] 处理异常:', err);
							videoContext += '\n[用户引用了视频，但下载失败]';
						}
					}
				}
				
				// 引用的是文件
				else if (refItem.type === MESSAGE_ITEM_FILE && refItem.file_item?.media) {
					console.log('📎 检测到引用的文件消息');
					const file = refItem.file_item;
					const media = file.media;
					if (!media) continue;
					
					const fileName = file.file_name || 'unknown';
					
					if (media.aes_key) {
						const fileNameMatch = fileName.match(/\.([a-z0-9]+)$/i);
						const ext = fileNameMatch?.[1] || 'bin';
						
						try {
							const filePath = await downloadAndDecryptMedia({
								encryptQueryParam: media.encrypt_query_param,
								fullUrl: media.full_url,
								aesKeyBase64: media.aes_key,
								cdnBaseUrl: WECHAT_CDN_BASE_URL,
								saveDir: INBOX_DIR,
								label: 'ref-file',
								extension: ext,
							});
							
							if (filePath) {
								fileContext += `\n[用户引用了文件 "${fileName}": file://${filePath}]`;
								console.log(`✅ 引用的文件已保存: ${filePath}`);
							}
						} catch (err) {
							console.error('[引用文件] 处理异常:', err);
							fileContext += `\n[用户引用了文件 "${fileName}"，但下载失败]`;
						}
					}
				}
			}
		}
		
		// 合并文本和媒体上下文
		if (imageContext || videoContext || fileContext) {
			const mediaContext = imageContext + videoContext + fileContext;
			text = text ? `${text}${mediaContext}` : mediaContext.trim();
		}
		
		if (!text.trim()) {
			console.log(`[微信] 忽略空消息 from ${uid}`);
			return;
		}
		
		console.log(`[微信] 收到消息: ${text.substring(0, 50)}...`);

		const contextToken = monitor.getContextToken(uid) || msg.context_token;
		if (!contextToken) {
			console.warn('[微信] contextToken missing, attempting to send without context (may fail at API level)');
		}

		if (contextToken) {
			wechatContextTokens.set(uid, contextToken);
		}
		lastWechatUserId = uid;

			const session = getSession(uid, defaultWorkspace);

			const wechatAdapter: PlatformAdapter = {
				reply: async (content: string) => {
					await sendWechatText(uid, content, contextToken);
				},
				sendFile: async (filePath: string, _fileName?: string) => {
					await sendWechatFile(uid, filePath, contextToken);
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

			// ── Feedback Gate: 拦截用户回复 ──
			const pendingFG = pendingFeedbackGates.get(uid);
			if (pendingFG) {
				const age = Date.now() - pendingFG.createdAt;
				if (age < FEEDBACK_GATE_TIMEOUT) {
					const isDone = /^(done|完成|ok|好的|结束|没了|没有了|task_complete)$/i.test(message.trim());
					const responseText = isDone ? 'TASK_COMPLETE' : message;
					console.log(`[FeedbackGate] Replying to triggerId=${pendingFG.triggerId} isDone=${isDone}: ${message.slice(0, 100)}`);
					writeFeedbackGateResponse(pendingFG.triggerId, responseText);
					pendingFeedbackGates.delete(uid);

					const lockKeyForFG = getLockKey(workspace);
					if (!busySessions.has(lockKeyForFG)) {
						// Agent 已完成，将反馈作为新消息处理（不 return，继续往下走）
						console.log(`[FeedbackGate] Agent already finished, treating reply as new message`);
					} else {
						await sendWechatText(
							uid,
							isDone ? '✅ 对话已结束' : `✅ 反馈已提交，AI 正在继续处理...\n\n> ${message.slice(0, 200)}`,
							contextToken,
						);
						return;
					}
				} else {
					pendingFeedbackGates.delete(uid);
					console.log(`[FeedbackGate] Expired pending for uid=${uid.slice(0, 10)}...`);
				}
			}

			let lockKey = getLockKey(workspace);
			if (busySessions.has(lockKey)) {
				// 启动排队时的 typing keepalive
				const stopQueueTyping = startTypingKeepalive(client, uid);
				
				try {
					// 发送排队提示消息
					await sendWechatText(uid, '⏳ 当前会话有任务进行中，请稍候…', contextToken);
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
				} finally {
					// 排队结束，停止 typing
					stopQueueTyping();
				}
			}

			try {
				busySessions.add(lockKey);
				if (memory) {
					memory.appendSessionLog(workspace, 'user', message, config.CURSOR_MODEL);
				}

				// 启动 typing keepalive（每 5 秒刷新，最多维持 5 分钟）
				const stopTyping = startTypingKeepalive(client, uid);
				
				try {
					const taskStart = Date.now();
				const currentModel = config.CURSOR_MODEL || getDefaultModel();
				const isOpus = currentModel.toLowerCase().includes('opus');
				const ex = await execAgentWithFallback(
				agentExecutor,
				workspace,
				currentModel,
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
					if (oldLockKey !== newLockKey && busySessions.has(oldLockKey)) {
						busySessions.delete(oldLockKey);
						busySessions.add(newLockKey);
						lockKey = newLockKey;
					}
				},
					onProgress: (p) => {
						if (p.elapsed > 0 && Math.floor(p.elapsed) % 15 === 0) {
							console.log(`[Agent] ${formatElapsed(Math.floor(p.elapsed))} ${p.phase}`);
						}
					},
					feedbackGate: isOpus ? {
						chatId: uid,
						platform: 'wechat',
						enabledModel: currentModel,
					} : undefined,
					onFeedbackRequested: isOpus ? async (req: FeedbackGateRequest) => {
						console.log(`[FeedbackGate] Received request: triggerId=${req.triggerId} title=${req.title}`);
						pendingFeedbackGates.set(uid, {
							triggerId: req.triggerId,
							message: req.message,
							title: req.title,
							uid,
							createdAt: Date.now(),
						});
						const fgMsg = `💬 **${req.title || 'AI 请求反馈'}**\n\n${req.message}\n\n---\n回复此消息即可提交反馈\n发送「完成」或「done」结束对话`;
						await sendWechatText(uid, fgMsg, contextToken);
					} : undefined,
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

			// ── 处理回复内容（文本 + 可能的图片）────────────────
			if (cleanOutput) {
				// 检测 MEDIA: / MEDIA_VIDEO: / MEDIA_FILE: 指令
				const mediaRegex = /^(MEDIA(?:_VIDEO|_FILE)?):(.+)$/gm;
				const mediaMatches = Array.from(cleanOutput.matchAll(mediaRegex));
				
				if (mediaMatches.length > 0) {
					// 有媒体文件要发送
					const textPart = cleanOutput.replace(/^MEDIA(?:_VIDEO|_FILE)?:.+$/gm, '').trim();
					
					// 先发送文本（如果有）
					if (textPart) {
						await sendWechatText(uid, textPart, contextToken);
						await new Promise(r => setTimeout(r, 300));
					}
					
				// 再发送媒体文件
				for (let i = 0; i < mediaMatches.length; i++) {
					const match = mediaMatches[i];
					if (!match || !match[1] || !match[2]) continue;
					
					const mediaType = match[1]; // "MEDIA", "MEDIA_VIDEO", "MEDIA_FILE"
					const mediaPath = match[2].trim();
					
					// 跳过空路径
					if (!mediaPath) {
						console.warn(`[${mediaType}] 跳过空路径`);
						continue;
					}
					
					// 支持本地文件和远程 URL
					let localPath = mediaPath;
					
					// 如果是远程 URL，先下载
					if (mediaPath.startsWith('http://') || mediaPath.startsWith('https://')) {
						console.log(`[${mediaType}] 检测到远程 URL: ${mediaPath}`);
						const downloaded = await downloadRemoteImage({
							url: mediaPath,
							saveDir: INBOX_DIR,
						});
						
						if (!downloaded) {
							await sendWechatText(uid, `❌ ${mediaType} 下载失败: ${mediaPath}`, contextToken);
							continue;
						}
						localPath = downloaded;
					} else {
						// 本地路径：支持相对路径（相对于 workspace）
						if (!mediaPath.startsWith('/')) {
							localPath = pathResolve(workspace, mediaPath);
							console.log(`[${mediaType}] 相对路径转换: ${mediaPath} → ${localPath}`);
						}
					}
					
					// 检查本地文件是否存在
					if (!existsSync(localPath)) {
						await sendWechatText(uid, `❌ 文件不存在: ${localPath}`, contextToken);
						continue;
					}
					
					// 根据类型上传并发送
					const finalToken = monitor.getContextToken(uid) || contextToken || undefined;
					const isRemoteDownload = mediaPath.startsWith('http://') || mediaPath.startsWith('https://');
					
					try {
						if (mediaType === 'MEDIA_VIDEO') {
							await sendWechatVideo(uid, localPath, finalToken);
						} else if (mediaType === 'MEDIA_FILE') {
							await sendWechatFile(uid, localPath, finalToken);
						} else {
							await sendWechatImage(uid, localPath, finalToken);
						}
						
					// 发送成功后清理临时下载的远程文件
					if (isRemoteDownload && localPath.includes('/inbox/weixin-remote-')) {
						try {
							unlinkSync(localPath);
							console.log(`[清理] 已删除临时文件: ${localPath}`);
						} catch {}
					}
				} catch (err) {
					// 即使发送失败，也清理临时文件
					if (isRemoteDownload && localPath.includes('/inbox/weixin-remote-')) {
						try {
							unlinkSync(localPath);
						} catch {}
					}
					console.error(`[${mediaType}] 发送失败，继续处理下一个:`, err);
				}
				
				// 多个媒体文件时添加间隔
				if (i < mediaMatches.length - 1) {
					await new Promise(r => setTimeout(r, 500));
				}
				}
				} else {
					// 纯文本回复
					await sendWechatText(uid, cleanOutput, contextToken);
				}
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
			// 停止 typing keepalive
			stopTyping();
		}
			} finally {
				busySessions.delete(lockKey);
			}
		} catch (err) {
			console.error('[微信] 消息处理外层异常:', err);
		}
	});

	// 从持久化存储中恢复的 context_token 同步到全局 Map（用于心跳和定时任务）
	for (const [userId, token] of monitor.getAllContextTokens()) {
		wechatContextTokens.set(userId, token);
	}
	if (wechatContextTokens.size > 0) {
		console.log(`[启动] 已恢复 ${wechatContextTokens.size} 个用户的 context_token`);
	}

	console.log('\n✅ 微信服务已启动！');
	console.log(`📱 当前模型: ${config.CURSOR_MODEL || getDefaultModel()}`);
	console.log(`📂 默认项目: ${projectsConfig.default_project}`);

	const shutdown = () => {
		console.log('\n👋 正在关闭微信服务...');
		const active = agentExecutor.getActiveAgents();
		if (active.length > 0) {
			agentExecutor.killAll();
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
