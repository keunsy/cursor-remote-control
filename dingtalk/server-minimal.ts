/**
 * 钉钉 Stream → Cursor Agent CLI 中继服务 v1 (MVP)
 *
 * 核心功能：
 * - 钉钉消息 → Cursor CLI → 钉钉回复
 * - 支持文字、语音、图片
 * - 会话管理（--resume）
 * - 项目路由
 *
 * 启动: bun run server-minimal.ts
 */

import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, watchFile, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import axios from 'axios';
import { execFileSync } from 'node:child_process';
import { Scheduler, type CronJob } from './scheduler.js';
import { MemoryManager } from './memory.js';
import { HeartbeatRunner } from './heartbeat.js';

const HOME = process.env.HOME!;
const ROOT = resolve(import.meta.dirname, '..');
const ENV_PATH = resolve(import.meta.dirname, '.env');
const PROJECTS_PATH = resolve(ROOT, 'projects.json');
const INBOX_DIR = resolve(ROOT, 'inbox');
const WHISPER_MODEL = resolve(HOME, 'models/ggml-tiny.bin');

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

// ── 配置 ─────────────────────────────────────────
interface EnvConfig {
	CURSOR_API_KEY: string;
	DINGTALK_APP_KEY: string;
	DINGTALK_APP_SECRET: string;
	CURSOR_MODEL: string;
	VOLC_STT_APP_ID: string;
	VOLC_STT_ACCESS_TOKEN: string;
}

function loadEnv(): EnvConfig {
	const raw = readFileSync(ENV_PATH, 'utf-8');
	const env: Record<string, string> = {};
	for (const line of raw.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const [key, ...vals] = trimmed.split('=');
		let val = vals.join('=').trim();
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1);
		}
		env[key.trim()] = val;
	}
	return {
		CURSOR_API_KEY: env.CURSOR_API_KEY || '',
		DINGTALK_APP_KEY: env.DINGTALK_APP_KEY || '',
		DINGTALK_APP_SECRET: env.DINGTALK_APP_SECRET || '',
		CURSOR_MODEL: env.CURSOR_MODEL || 'auto',
		VOLC_STT_APP_ID: env.VOLC_STT_APP_ID || '',
		VOLC_STT_ACCESS_TOKEN: env.VOLC_STT_ACCESS_TOKEN || '',
	};
}

let config = loadEnv();

// .env 热更新（2秒轮询）
watchFile(ENV_PATH, { interval: 2000 }, () => {
	try {
		const prev = config.CURSOR_API_KEY;
		const prevModel = config.CURSOR_MODEL;
		config = loadEnv();
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

const projectsConfig: ProjectsConfig = existsSync(PROJECTS_PATH)
	? JSON.parse(readFileSync(PROJECTS_PATH, 'utf-8'))
	: { projects: { default: { path: ROOT, description: 'Default' } }, default_project: 'default' };

// ── 记忆管理器 ───────────────────────────────────
const defaultWorkspace = projectsConfig.projects[projectsConfig.default_project]?.path || ROOT;

// 记忆工作区：支持独立配置，避免污染工作项目
const memoryWorkspaceKey = (projectsConfig as any).memory_workspace || projectsConfig.default_project;
const memoryWorkspace = projectsConfig.projects[memoryWorkspaceKey]?.path || defaultWorkspace;

let memory: MemoryManager | undefined;
try {
	memory = new MemoryManager({
		workspaceDir: memoryWorkspace,
		embeddingApiKey: config.VOLC_EMBEDDING_API_KEY,
		embeddingModel: config.VOLC_EMBEDDING_MODEL,
		embeddingEndpoint: "https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal",
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
	},
	onExecute: async (prompt: string) => {
		memory?.appendSessionLog(defaultWorkspace, "user", "[心跳检查] " + prompt.slice(0, 200), config.CURSOR_MODEL);
		const { result } = await runAgent(defaultWorkspace, prompt);
		memory?.appendSessionLog(defaultWorkspace, "assistant", result.slice(0, 3000), config.CURSOR_MODEL);
		return result;
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
	}
}

async function ensureToken() {
	if (Date.now() >= tokenExpireTime - 60000) {
		await refreshAccessToken();
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
const CURSOR_MODELS = [
	{ id: 'opus-4.6-thinking', label: 'Opus 4.6', desc: '最强深度推理' },
	{ id: 'opus-4.5-thinking', label: 'Opus 4.5', desc: '强力推理' },
	{ id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', desc: 'OpenAI 编码旗舰' },
	{ id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', desc: 'Google 最新旗舰' },
	{ id: 'gemini-3-pro', label: 'Gemini 3 Pro', desc: 'Google 旗舰' },
	{ id: 'gemini-3-flash', label: 'Gemini 3 Flash', desc: 'Google 极速' },
	{ id: 'auto', label: 'Auto', desc: '自动选择最优' },
];

function fuzzyMatchModel(input: string): { exact?: typeof CURSOR_MODELS[number]; candidates: typeof CURSOR_MODELS } {
	const q = input.toLowerCase().replace(/[\s_-]+/g, '');
	
	// 精确匹配 id
	const exact = CURSOR_MODELS.find(m => m.id === input.toLowerCase());
	if (exact) return { exact, candidates: [] };
	
	// 编号匹配
	const num = Number.parseInt(input, 10);
	if (!Number.isNaN(num) && num >= 1 && num <= CURSOR_MODELS.length) {
		return { exact: CURSOR_MODELS[num - 1], candidates: [] };
	}
	
	// 模糊：id 或 label 包含输入
	const candidates = CURSOR_MODELS.filter(m => {
		const mid = m.id.replace(/[\s_-]+/g, '');
		const mlab = m.label.toLowerCase().replace(/[\s_-]+/g, '');
		return mid.includes(q) || mlab.includes(q) || q.includes(mid);
	});
	
	if (candidates.length === 1) return { exact: candidates[0], candidates: [] };
	return { candidates };
}

function buildModelListCard(currentModel: string, errorHint?: string): string {
	const lines: string[] = [];
	if (errorHint) lines.push(`${errorHint}\n`);
	for (let i = 0; i < CURSOR_MODELS.length; i++) {
		const m = CURSOR_MODELS[i];
		const isCurrent = m.id === currentModel;
		lines.push(isCurrent
			? `**${i + 1}. ${m.id}** · ${m.desc} ✅`
			: `${i + 1}. \`${m.id}\` · ${m.desc}`);
	}
	lines.push('');
	lines.push('> 发送 `/模型 编号` 或 `/模型 名称` 切换');
	return lines.join('\n');
}

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

// 同会话串行执行，不同会话可并行
const busySessions = new Set<string>();

// 追踪运行中的 agent 进程（用于 /终止）
const activeAgents = new Map<string, { pid: number; kill: () => void }>();
const childPids: number[] = [];

process.on('SIGTERM', () => {
	for (const pid of childPids) {
		try { process.kill(pid, 'SIGTERM'); } catch {}
	}
	process.exit(0);
});

// ── Cursor Agent 调用 ────────────────────────────
async function runAgent(
	workspace: string, 
	message: string, 
	agentId?: string,
	context?: { platform?: string; webhook?: string }
): Promise<{ result: string; sessionId?: string }> {
	console.log(`[时序A] runAgent 函数被调用`);
	console.log(`[时序A1] 准备 return Promise`);
	const promise = new Promise((resolve, reject) => {
		console.log(`[时序B] Promise callback 开始执行`);
		const args = [
			'-p', '--force', '--trust', '--approve-mcps',
			'--workspace', workspace,
			'--model', config.CURSOR_MODEL,
			'--output-format', 'stream-json',
			'--stream-partial-output',
		];
		
		if (agentId) {
			args.push('--resume', agentId);
		}
		
		args.push('--', message);
		
		console.log(`[Cursor CLI] workspace=${workspace} model=${config.CURSOR_MODEL} agentId=${agentId || '(新会话)'}`);
		console.log(`[Cursor CLI] 传递消息: "${message.slice(0, 100)}${message.length > 100 ? '...' : ''}"`);
		
		const env = config.CURSOR_API_KEY
			? { ...process.env, CURSOR_API_KEY: config.CURSOR_API_KEY }
			: process.env;
		
		// 传递平台和回调地址给 agent（用于创建定时任务）
		if (context?.platform) {
			env.CURSOR_PLATFORM = context.platform;
			console.log(`[ENV] 设置 CURSOR_PLATFORM=${context.platform}`);
		}
		if (context?.webhook) {
			env.CURSOR_WEBHOOK = context.webhook;
			console.log(`[ENV] 设置 CURSOR_WEBHOOK=${context.webhook.slice(0, 50)}...`);
		}
		
		// 传递定时任务文件的绝对路径（Agent 直接写入，不依赖工作区）
		env.CURSOR_CRON_FILE = resolve(ROOT, 'cron-jobs-dingtalk.json');
		
		const proc = spawn('agent', args, { 
			env,
			stdio: ['ignore', 'pipe', 'pipe']
		});
		
		console.log(`[时序C] spawn 完成，pid: ${proc.pid}`);
		
		// 追踪进程（用于 /终止）
		const lockKey = getLockKey(workspace);
		console.log(`[时序D] lockKey: ${lockKey}`);
		if (proc.pid) {
			childPids.push(proc.pid);
			activeAgents.set(lockKey, { 
				pid: proc.pid, 
				kill: () => proc.kill('SIGTERM') 
			});
		}
		
		let resultText = '';
		let sessionId: string | undefined = agentId;
		let lineBuf = '';
		let stderrBuf = '';
		let hasOutput = false;
		
		// 添加超时机制（5分钟）
		const timeout = setTimeout(() => {
			console.error('[CLI] 进程超时（5分钟），强制结束');
			proc.kill('SIGKILL');
			reject(new Error('Agent 执行超时（5分钟）'));
		}, 5 * 60 * 1000);
		
		console.log(`[时序E] 准备注册事件监听器`);
		
		proc.stdout.on('data', (chunk) => {
			console.log(`[时序F] stdout收到数据`);

			hasOutput = true;
			lineBuf += chunk.toString();
			const lines = lineBuf.split('\n');
			lineBuf = lines.pop() || '';
			
			for (const line of lines) {
				if (!line.trim()) continue;
				
				try {
					const ev = JSON.parse(line);
					
					// 提取 session_id
					if (ev.session_id && !sessionId) {
						sessionId = ev.session_id;
						console.log(`[CLI] 捕获 session_id: ${sessionId}`);
					}
					
					// 提取最终结果（兼容 result 为字符串或对象 { text/content }）
					if (ev.type === 'result' && ev.result !== undefined) {
						const r = ev.result;
						resultText = typeof r === 'string' ? r : (r?.text ?? r?.content ?? String(r));
						console.log(`[CLI] 收到 result，长度: ${resultText.length}`);
					}
					
					// 实时拼接 assistant 消息（兼容多种 content 结构）
					if (ev.type === 'assistant' && ev.message?.content) {
						const parts = Array.isArray(ev.message.content) ? ev.message.content : [ev.message.content];
						for (const c of parts) {
							if (!c || typeof c !== 'object') continue;
							const text = c.type === 'text' ? (c as { text?: string }).text : (c as { text?: string }).text;
							if (typeof text === 'string' && text) resultText += text;
						}
					}
				} catch (e) {
					// 非 JSON 行，记录调试信息
					console.log('[CLI stdout 非JSON]', line.slice(0, 100));
				}
			}
		});
		
		proc.stderr.on('data', (chunk) => {
			const text = chunk.toString();
			stderrBuf += text;
			console.error('[CLI stderr]', text);
		});
		
		console.log(`[时序G] 事件监听器注册完成，Promise callback 执行完毕`);
		
		proc.on('close', (code) => {
			console.log(`[时序H] close 事件触发`);
			clearTimeout(timeout);
			
			console.log(`[CLI] 进程结束 code=${code} hasOutput=${hasOutput} resultLen=${resultText.length} stderrLen=${stderrBuf.length}`);
			
			// 清理追踪
			const lockKey = getLockKey(workspace);
			activeAgents.delete(lockKey);
			if (proc.pid) {
				const idx = childPids.indexOf(proc.pid);
				if (idx >= 0) childPids.splice(idx, 1);
			}
			
			if (code === 0) {
				console.log(`[CLI] 成功完成，返回结果长度: ${resultText.length}`);
				console.log(`[时序C] 准备调用 resolve`);
				resolve({ result: resultText, sessionId });
				console.log(`[时序D] resolve 已调用`);
			} else {
				console.error(`[CLI] 失败退出 code=${code} stderr=${stderrBuf.slice(0, 500)}`);
				reject(new Error(`Agent exited with code ${code}: ${stderrBuf.slice(0, 200)}`));
			}
		});
	});
	
	console.log(`[时序A2] Promise 创建完成，准备 return`);
	return promise;
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
	const projectPattern = projectNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
	
	// 0. 路径快捷语法：#/path 或 @/path
	const pathSymbolMatch = raw.match(/^[#@]((?:~?\/|~).+?)\s+(.+)$/);
	if (pathSymbolMatch) {
		const rawPath = pathSymbolMatch[1];
		const absolutePath = rawPath.startsWith('~') 
			? rawPath.replace(/^~/, process.env.HOME || '~')
			: rawPath;
		return {
			type: 'temp',
			path: absolutePath,
			cleanedText: pathSymbolMatch[2].trim(),
		};
	}
	
	// 1. 简化符号：#项目名 或 @项目名
	const symbolMatch = raw.match(new RegExp(`^[#@](${projectPattern})\\s+(.+)`, 'i'));
	if (symbolMatch) {
		const project = symbolMatch[1].toLowerCase();
		if (projects[project]) {
			return {
				type: 'temp',
				project,
				cleanedText: symbolMatch[2].trim(),
			};
		}
	}
	
	// 2a. 切换到任意路径（必须以 / 或 ~ 开头，避免误匹配 "切换到 remote"）
	const pathSwitchMatch = raw.match(/^(?:切换到|切到|切换|进入|打开)(?:路径)?\s+([~\/].+?)\s*$/i);
	if (pathSwitchMatch) {
		const absolutePath = pathSwitchMatch[1].startsWith('~')
			? pathSwitchMatch[1].replace(/^~/, process.env.HOME || '~')
			: pathSwitchMatch[1];
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
			const project = match[1].toLowerCase();
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
			const project = match[1].toLowerCase();
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
	if (slashMatch && projects[slashMatch[1].toLowerCase()]) {
		return {
			workspace: projects[slashMatch[1].toLowerCase()].path,
			message: slashMatch[2].trim(),
			label: slashMatch[1].toLowerCase(),
			routeChanged: true,
			intent: intent || { type: 'none', cleanedText: slashMatch[2].trim() },
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
		return {
			workspace: projects[routeIntent.project].path,
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
		seenMessages.delete(oldest[0]);
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
				text = `用户发了一张图片，已保存到 ${imagePath}，请查看并回复。`;
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
			if (projectInfo) {
				// 更新当前项目
				session.currentProject = routeIntent.project;

				const msg = `**✅ 已切换到项目：${routeIntent.project}**\n\n📁 ${projectInfo.description}\n\`${projectInfo.path}\`\n\n后续消息将在此项目中执行，直到你切换到其他项目。`;
				await sendMarkdown(sessionWebhook, msg, '✅ 项目已切换', 'green');
				console.log(`[路由] 持久切换到项目: ${routeIntent.project}`);
				return;
			}
			// 识别到切换意图但项目不存在，明确提示
			const available = Object.keys(projectsConfig.projects).map((k) => `\`${k}\``).join('、');
			await sendMarkdown(sessionWebhook, `未找到项目「${routeIntent.project}」。\n\n可用项目：${available}\n\n请检查 \`projects.json\` 或使用上述项目名。`, '未找到项目', 'orange');
			return;
		}
		
		// 检测简单定时任务请求，服务器端直接创建（不依赖 Agent）
		const simpleScheduleMatch = text.match(/^(\d+)(分钟|小时)后\s*(?:提醒|通知)?(?:我)?\s*(.+)$/i);
		if (simpleScheduleMatch) {
			const [, num, unit, taskMessage] = simpleScheduleMatch;
			const minutes = unit === '小时' ? parseInt(num) * 60 : parseInt(num);
			const runAtMs = Date.now() + minutes * 60 * 1000;
			const runAt = new Date(runAtMs);
			
			const task = await scheduler.add({
				name: `${num}${unit}后提醒`,
				enabled: true,
				deleteAfterRun: true,
				schedule: { kind: 'at', at: runAt.toISOString() },
				message: taskMessage.trim(),
				platform: 'dingtalk',
				webhook: sessionWebhook,
			});
			
			const timeStr = runAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
			await sendMarkdown(sessionWebhook, `✅ 已设置好，大约在 **${timeStr}** 通过钉钉提醒你：\n\n${taskMessage}\n\n发送 \`/cron\` 可查看所有任务。`, '⏰ 定时任务已创建');
			console.log(`[任务] 服务器端创建: ${task.name} @ ${timeStr}`);
			return;
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
		
		// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
		// 命令系统
		// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
		
		// /help、/帮助 → 显示所有可用命令
		const helpMatch = message.trim().match(/^\/(help|帮助|指令)\s*$/i);
		if (helpMatch) {
			const en = helpMatch[1].toLowerCase() === 'help';
			const c = (zh: string, enAlias?: string) => en && enAlias ? `\`${zh}\` \`${enAlias}\`` : `\`${zh}\``;
			const helpText = [
				'**基础指令**',
				`- ${c('/帮助', '/help')} — 显示本帮助`,
				`- ${c('/状态', '/status')} — 查看服务状态`,
				`- ${c('/新对话', '/new')} — 重置当前会话`,
				`- ${c('/终止', '/stop')} — 终止正在执行的任务`,
				'',
				'**会话管理**',
				`- ${c('/会话', '/sessions')} — 查看最近会话列表`,
				'- `/会话 编号` — 切换到指定会话',
				`- ${c('/新对话', '/new')} — 归档当前会话，开启新对话`,
				'',
				'**模型与密钥**',
				`- ${c('/模型', '/model')} — 查看/切换 AI 模型`,
				`- ${c('/密钥', '/apikey')} — 查看/更换 API Key（仅私聊）`,
				'  用法：`/密钥 key_xxx...`',
				'',
				'**记忆系统**',
				`- ${c('/记忆', '/memory')} — 查看记忆状态`,
				`- \`/记忆 关键词\` — 语义搜索记忆`,
				`- \`/记录 内容\` — 写入今日日记`,
				`- ${c('/整理记忆', '/reindex')} — 重建记忆索引`,
				'',
				'**定时任务**',
				`- ${c('/任务', '/cron')} — 查看所有定时任务`,
				'- `/任务 暂停/恢复/删除/执行 ID`',
				'- 或在对话中说「每天早上9点做XX」由 AI 自动创建',
				'',
				'**心跳系统**',
				`- ${c('/心跳', '/heartbeat')} — 查看心跳状态`,
				'- `/心跳 开启/关闭/执行`',
				'- `/心跳 间隔 分钟数`',
				'',
				'**项目路由**',
				`发送 \`/项目名 消息\` 或 \`#项目名 消息\` 指定工作区`,
				`可用项目：${Object.keys(projectsConfig.projects).map(k => `\`${k}\``).join('、')}（默认：\`${projectsConfig.default_project}\`）`,
			].join('\n');
			await sendMarkdown(sessionWebhook, helpText, '📖 使用帮助', 'blue');
			return;
		}
		
		// /status、/状态 → 服务状态一览
		if (/^\/(status|状态)\s*$/i.test(message.trim())) {
			const keyPreview = config.DINGTALK_APP_KEY ? `\`...${config.DINGTALK_APP_KEY.slice(-8)}\`` : '**未设置**';
			const projects = Object.entries(projectsConfig.projects).map(([k, v]) => `  \`${k}\` → ${v.path}`).join('\n');
			const sessions = [...sessionsStore.entries()]
				.filter(([, s]) => s.active)
				.map(([ws, s]) => {
					const name = Object.entries(projectsConfig.projects).find(([, v]) => v.path === ws)?.[0] || ws;
					return `  \`${name}\` → ${s.active!.slice(0, 12)}...`;
				}).join('\n') || '  (无活跃会话)';
			
			const memStatus = memory
				? (() => {
					const stats = memory.getStats();
					return `${stats.chunks} 块（${stats.files} 文件, ${stats.cachedEmbeddings} 嵌入缓存）`;
				})()
				: '未初始化';
			
			const statusText = [
				`**AppKey：** ${keyPreview}`,
				`**记忆：** ${memStatus}`,
				`**调度：** ${(() => { const s = scheduler.getStats(); return s.total > 0 ? `${s.enabled}/${s.total} 任务${s.nextRunIn ? `（下次: ${s.nextRunIn}）` : ''}` : '无任务'; })()}`,
				`**心跳：** ${heartbeat.getStatus().enabled ? `每 ${Math.round(heartbeat.getStatus().everyMs / 60000)} 分钟` : '未启用'}`,
				`**活跃任务：** ${busySessions.size} 个运行中`,
				'',
				'**项目路由：**',
				projects,
				'',
				'**活跃会话：**',
				sessions,
			].join('\n');
			await sendMarkdown(sessionWebhook, statusText, '📊 服务状态', 'blue');
			return;
		}
		
		// /new、/新对话、/新会话 → 归档当前会话，开启新对话
		if (/^\/(new|新对话|新会话)\s*$/i.test(message.trim())) {
			archiveAndResetSession(workspace);
			const historyCount = getSessionHistory(workspace).length;
			const hint = historyCount > 0 ? `\n\n历史会话已保留（共 ${historyCount} 个），发送 \`/会话\` 可查看和切换。` : '';
			await sendMarkdown(sessionWebhook, `**[${label}]** 新会话已开始，下一条消息将创建全新对话。${hint}`, '🆕 新会话', 'green');
			return;
		}
		
		// /会话、/sessions → 列出历史会话 / 切换会话
		const sessionCmdMatch = message.match(/^\/(会话|sessions?)[\s:：]*(.*)/i);
		if (sessionCmdMatch) {
			const subArg = sessionCmdMatch[2].trim();
			const history = getSessionHistory(workspace, 10);
			const activeId = getActiveSessionId(workspace);
			
			if (!subArg) {
				if (history.length === 0) {
					await sendMarkdown(sessionWebhook, '暂无历史会话。\n\n开始对话后会自动记录，发送 `/新对话` 可归档当前会话。', '💬 会话列表');
					return;
				}
				const lines: string[] = [];
				lines.push(`**工作区：** \`${label}\`\n`);
				for (let i = 0; i < history.length; i++) {
					const h = history[i];
					const isCurrent = h.id === activeId;
					const icon = isCurrent ? '🔵' : '⚪';
					const tag = isCurrent ? ' ← **当前**' : '';
					const time = formatRelativeTime(h.lastActiveAt);
					lines.push(`${icon} **${i + 1}.** ${h.summary}${tag}\n   ${time} · \`${h.id.slice(0, 8)}\``);
				}
				lines.push('', '---', '切换：`/会话 编号`　　新建：`/新对话`');
				await sendMarkdown(sessionWebhook, lines.join('\n'), '💬 会话列表', 'blue');
				return;
			}
			
			// /会话 N → 切换到第 N 个
			const num = Number.parseInt(subArg, 10);
			if (!Number.isNaN(num) && num >= 1 && num <= history.length) {
				const target = history[num - 1];
				if (target.id === activeId) {
					await sendMarkdown(sessionWebhook, `当前已是会话 #${num}：${target.summary}`, '无需切换');
					return;
				}
				switchToSession(workspace, target.id);
				await sendMarkdown(sessionWebhook, `已切换到会话 #${num}：**${target.summary}**\n\n下一条消息将在此会话中继续对话。\n\`${target.id.slice(0, 12)}\` · ${formatRelativeTime(target.lastActiveAt)}`, '💬 已切换', 'green');
				console.log(`[Session] 切换到 ${target.id.slice(0, 12)} (${target.summary})`);
				return;
			}
			
			// /会话 ID前缀 → 按 ID 前缀匹配
			if (subArg.length >= 4) {
				const target = history.find(h => h.id.startsWith(subArg));
				if (target) {
					switchToSession(workspace, target.id);
					await sendMarkdown(sessionWebhook, `已切换到：**${target.summary}**\n\n\`${target.id.slice(0, 12)}\` · ${formatRelativeTime(target.lastActiveAt)}`, '💬 已切换');
					return;
				}
			}
			
			await sendMarkdown(sessionWebhook, `未找到编号 ${subArg} 的会话。\n\n发送 \`/会话\` 查看可用列表。`, '❓ 未找到');
			return;
		}
		
		// /model、/模型 → 切换模型
		const modelMatch = message.match(/^\/(model|模型|切换模型)[\s:：=]*(.*)/i);
		if (modelMatch) {
			const input = modelMatch[2].trim();
			
			// 无参数 → 显示模型列表
			if (!input) {
				await sendMarkdown(sessionWebhook, buildModelListCard(config.CURSOR_MODEL), '🤖 选择模型', 'blue');
				return;
			}
			
			const { exact, candidates } = fuzzyMatchModel(input);
			
			if (exact) {
				// 精确匹配或唯一模糊匹配 → 直接切换
				if (exact.id === config.CURSOR_MODEL) {
					await sendMarkdown(sessionWebhook, `当前已是 **${exact.id}**（${exact.desc}），无需切换。`, '🤖 当前模型');
					return;
				}
				const envContent = readFileSync(ENV_PATH, 'utf-8');
				const updated = envContent.match(/^CURSOR_MODEL=/m)
					? envContent.replace(/^CURSOR_MODEL=.*$/m, `CURSOR_MODEL=${exact.id}`)
					: `${envContent.trimEnd()}\nCURSOR_MODEL=${exact.id}\n`;
				writeFileSync(ENV_PATH, updated);
				const prev = config.CURSOR_MODEL;
				await sendMarkdown(sessionWebhook, `${prev} → **${exact.id}**（${exact.desc}）\n\n已写入 .env，2 秒内自动生效。`, '✅ 模型已切换', 'green');
				console.log(`[指令] 模型切换: ${prev} → ${exact.id}`);
				return;
			}
			
			if (candidates.length > 1) {
				const list = candidates.map(m => `- \`${m.id}\`（${m.desc}）`).join('\n');
				await sendMarkdown(sessionWebhook, `「${input}」匹配到多个模型：\n\n${list}\n\n请输入更精确的名称或编号。`, '⚠️ 请精确选择', 'orange');
				return;
			}
			
			// 列表外的自定义模型名
			if (input.length < 2 || /^\d+$/.test(input)) {
				await sendMarkdown(sessionWebhook, buildModelListCard(config.CURSOR_MODEL, `「${input}」无匹配，请从列表中选择`), '❌ 未找到模型');
				return;
			}
			
			const envContent = readFileSync(ENV_PATH, 'utf-8');
			const updated = envContent.match(/^CURSOR_MODEL=/m)
				? envContent.replace(/^CURSOR_MODEL=.*$/m, `CURSOR_MODEL=${input}`)
				: `${envContent.trimEnd()}\nCURSOR_MODEL=${input}\n`;
			writeFileSync(ENV_PATH, updated);
			const prev = config.CURSOR_MODEL;
			await sendMarkdown(sessionWebhook, `${prev} → **${input}**\n\n⚠️ 此模型不在常用列表中，若名称有误可能导致执行失败。\n发送 \`/模型\` 查看常用列表。`, '⚠️ 模型已切换', 'orange');
			console.log(`[指令] 模型切换(自定义): ${prev} → ${input}`);
			return;
		}
		
		// /apikey、/密钥 → 更换 API Key（仅私聊）
		const apikeyMatch = message.match(/^\/(apikey|密钥|api-key)[\s:：=]*(key_[a-zA-Z0-9_-]+)?/i);
		if (apikeyMatch) {
			const rawKey = apikeyMatch[2]?.trim();
			if (!rawKey) {
				const preview = config.CURSOR_API_KEY ? `\`...${config.CURSOR_API_KEY.slice(-8)}\`` : '**未设置**';
				await sendMarkdown(sessionWebhook, `**当前 API Key：** ${preview}\n\n用法：\`/密钥 key_xxx...\``, '🔑 API Key', 'blue');
				return;
			}
			// 群聊安全检查
			if (isGroup) {
				await sendMarkdown(sessionWebhook, '⚠️ **安全提醒：请勿在群聊中发送 API Key！**\n\n请在与机器人的 **私聊** 中发送 `/密钥` 指令。', '⚠️ 安全提醒', 'red');
				return;
			}
			try {
				const envContent = readFileSync(ENV_PATH, 'utf-8');
				const updated = envContent.match(/^CURSOR_API_KEY=/m)
					? envContent.replace(/^CURSOR_API_KEY=.*$/m, `CURSOR_API_KEY=${rawKey}`)
					: `${envContent.trimEnd()}\nCURSOR_API_KEY=${rawKey}\n`;
				writeFileSync(ENV_PATH, updated);
				await sendMarkdown(sessionWebhook, `**API Key 已更换**\n\n新 Key: \`...${rawKey.slice(-8)}\`\n\n已写入 .env 并自动生效。`, '✅ Key 已更新', 'green');
				console.log(`[指令] API Key 已通过钉钉更换 (...${rawKey.slice(-8)})`);
			} catch (err) {
				await sendMarkdown(sessionWebhook, `❌ 写入失败: ${err instanceof Error ? err.message : err}`, '❌ 失败');
			}
			return;
		}
		
		// /stop、/终止、/停止 → 终止当前会话运行的 agent
		if (/^\/(stop|终止|停止)\s*$/i.test(message.trim())) {
			const lk = getLockKey(workspace);
			const agent = activeAgents.get(lk);
			if (agent) {
				agent.kill();
				console.log(`[指令] 终止 agent pid=${agent.pid} session=${lk}`);
				await sendMarkdown(sessionWebhook, '已终止当前任务。\n\n发送新消息将继续在当前会话中对话。', '⚠️ 已终止');
			} else {
				await sendMarkdown(sessionWebhook, '当前没有正在运行的任务。', 'ℹ️ 无任务', 'grey');
			}
			return;
		}
		
		// /任务、/cron → 定时任务管理
		const taskMatch = message.match(/^\/(任务|cron|定时|task|schedule|定时任务)[\s:：]*(.*)/i);
		if (taskMatch) {
			const subCmd = taskMatch[2].trim().toLowerCase();

			// 无参数 → 列出所有任务
			if (!subCmd) {
				// 直接从文件读取最新任务（避免 reload 的 3 秒保护机制）
				const cronFilePath = resolve(ROOT, 'cron-jobs-dingtalk.json');
				let jobs: any[] = [];
				try {
					const data = JSON.parse(readFileSync(cronFilePath, 'utf-8'));
					jobs = (data.jobs || []).filter((j: any) => j.platform === 'dingtalk');
				} catch (e) {
					console.warn(`[任务] 读取文件失败: ${e}`);
				}
				
				if (jobs.length === 0) {
					await sendMarkdown(sessionWebhook, '暂无定时任务。\n\n在对话中说「每天早上9点做XX」，AI 会自动创建任务。', '📋 定时任务');
					return;
				}
				const lines = jobs.map((j: any, i: number) => {
					const status = j.enabled ? '✅' : '⏸️';
					let schedDesc = "";
					if (j.schedule.kind === 'at') {
						const atTime = new Date(j.schedule.at);
						schedDesc = `一次性 ${atTime.toLocaleString("zh-CN", { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`;
					} else if (j.schedule.kind === 'every') {
						schedDesc = `每 ${Math.round(j.schedule.everyMs / 60000)} 分钟`;
					} else {
						schedDesc = `cron: ${j.schedule.expr}`;
					}
					const lastRun = j.state?.lastRunAtMs ? new Date(j.state.lastRunAtMs).toLocaleString('zh-CN') : '从未执行';
					return `${status} **${i + 1}. ${j.name}**\n   调度: ${schedDesc}\n   上次: ${lastRun}\n   ID: \`${j.id.slice(0, 8)}\``;
				});
				lines.push('', `📊 共 ${jobs.length} 个待执行任务`);
				await sendMarkdown(sessionWebhook, lines.join('\n'), '📋 定时任务');
				return;
			}
			
			// /任务 暂停 ID
			const pauseMatch = subCmd.match(/^(暂停|pause|disable)\s+(\S+)/i);
			if (pauseMatch) {
				const idPrefix = pauseMatch[2];
				const job = (await scheduler.list(true)).find(j => j.id.startsWith(idPrefix));
				if (!job) {
					await sendMarkdown(sessionWebhook, `未找到 ID 前缀为 \`${idPrefix}\` 的任务`, '❓ 未找到');
					return;
				}
				await scheduler.update(job.id, { enabled: false });
				await sendMarkdown(sessionWebhook, `已暂停: **${job.name}**`, '⏸️ 已暂停', 'orange');
				return;
			}
			
			// /任务 恢复 ID
			const resumeMatch = subCmd.match(/^(恢复|resume|enable)\s+(\S+)/i);
			if (resumeMatch) {
				const idPrefix = resumeMatch[2];
				const job = (await scheduler.list(true)).find(j => j.id.startsWith(idPrefix));
				if (!job) {
					await sendMarkdown(sessionWebhook, `未找到 ID 前缀为 \`${idPrefix}\` 的任务`, '❓ 未找到');
					return;
				}
				await scheduler.update(job.id, { enabled: true });
				await sendMarkdown(sessionWebhook, `已恢复: **${job.name}**`, '✅ 已恢复', 'green');
				return;
			}
			
			// /任务 删除 ID
			const delMatch = subCmd.match(/^(删除|delete|remove|del)\s+(\S+)/i);
			if (delMatch) {
				const idPrefix = delMatch[2];
				const job = (await scheduler.list(true)).find(j => j.id.startsWith(idPrefix));
				if (!job) {
					await sendMarkdown(sessionWebhook, `未找到 ID 前缀为 \`${idPrefix}\` 的任务`, '❓ 未找到');
					return;
				}
				scheduler.remove(job.id);
				await sendMarkdown(sessionWebhook, `已删除: **${job.name}**`, '🗑️ 已删除', 'green');
				return;
			}
			
			// /任务 执行 ID
			const runMatch = subCmd.match(/^(执行|run|trigger)\s+(\S+)/i);
			if (runMatch) {
				const idPrefix = runMatch[2];
				const job = (await scheduler.list(true)).find(j => j.id.startsWith(idPrefix));
				if (!job) {
					await sendMarkdown(sessionWebhook, `未找到 ID 前缀为 \`${idPrefix}\` 的任务`, '❓ 未找到');
					return;
				}
				await sendMarkdown(sessionWebhook, `⏳ 正在手动执行：**${job.name}**\n\n执行结果稍后推送...`, '⏳ 执行中', 'wathet');
				scheduler.run(job.id).catch(err => {
					console.error('[任务执行失败]', err);
				});
				return;
			}
			
			await sendMarkdown(sessionWebhook, '未知子命令。\n\n用法：\n- `/任务` — 查看所有任务\n- `/任务 暂停 ID` — 暂停任务\n- `/任务 恢复 ID` — 恢复任务\n- `/任务 删除 ID` — 删除任务\n- `/任务 执行 ID` — 手动执行', 'ℹ️ 用法');
			return;
		}
		
		// /记忆、/memory → 记忆系统操作
		const memoryMatch = message.match(/^\/(记忆|memory|搜索记忆|recall)[\s:：=]*(.*)/i);
		if (memoryMatch) {
			if (!memory) {
				await sendMarkdown(sessionWebhook, '记忆系统未初始化（缺少向量嵌入 API Key）。\n\n请在 `.env` 中设置 `VOLC_EMBEDDING_API_KEY`。', '⚠️ 记忆不可用');
				return;
			}
			const query = memoryMatch[2].trim();
			if (!query) {
				const summary = memory.getRecentSummary(3);
				const stats = memory.getStats();
				const fileList = stats.filePaths.length > 0
					? stats.filePaths.slice(0, 25).map((p) => `- \`${p}\``).join('\n') + (stats.filePaths.length > 25 ? `\n- …及其他 ${stats.filePaths.length - 25} 个文件` : '')
					: '（尚未索引，请发送 `/整理记忆`）';
				const statusText = [
					`**记忆索引：** ${stats.chunks} 块（${stats.files} 文件, ${stats.cachedEmbeddings} 嵌入缓存）`,
					`**索引范围：** 工作区全部文本文件（.md .txt .html .json .mdc 等）`,
					`**嵌入模型：** ${config.VOLC_EMBEDDING_MODEL}`,
					'',
					'**用法：**',
					'- `/记忆 关键词` — 语义搜索记忆',
					'- `/记录 内容` — 写入今日日记',
					'- `/整理记忆` — 重建全工作区索引',
					'',
					`**已索引文件：**\n${fileList}`,
					'',
					summary ? `**最近记忆摘要：**\n\n${summary.slice(0, 1500)}` : '（暂无记忆文件）',
				].join('\n');
				await sendMarkdown(sessionWebhook, statusText, '🧠 记忆系统', 'purple');
				return;
			}
			try {
				const results = await memory.search(query, 5);
				if (results.length === 0) {
					await sendMarkdown(sessionWebhook, `未找到与「${query}」相关的记忆。\n\n索引范围：工作区全部文本文件（发 \`/整理记忆\` 可刷新）`, '❌ 无匹配');
					return;
				}
				const lines = results.map((r, i) =>
					`**${i + 1}.** \`${r.path}#L${r.startLine}\`（相关度 ${(r.score * 100).toFixed(0)}%）\n${r.text.slice(0, 300)}`,
				);
				await sendMarkdown(sessionWebhook, lines.join('\n\n---\n\n'), `🔍 搜索「${query}」`, 'purple');
			} catch (e) {
				await sendMarkdown(sessionWebhook, `搜索失败: ${e instanceof Error ? e.message : e}`, '❌ 失败');
			}
			return;
		}
		
		// /记录 → 快速写入今日日记
		const logMatch = message.match(/^\/(记录|log|note)[\s:：=]+(.+)/is);
		if (logMatch) {
			if (!memory) {
				await sendMarkdown(sessionWebhook, '记忆系统未初始化。', '⚠️ 不可用');
				return;
			}
			const content = logMatch[2].trim();
			const path = memory.appendDailyLog(content);
			await sendMarkdown(sessionWebhook, `已记录到今日日记。\n\n\`${path}\``, '📝 已记录', 'green');
			return;
		}
		
		// /整理记忆 → 重建全工作区记忆索引
		if (/^\/(整理记忆|reindex|索引)\s*$/i.test(message.trim())) {
			if (!memory) {
				await sendMarkdown(sessionWebhook, '记忆系统未初始化。', '⚠️ 不可用');
				return;
			}
			await sendMarkdown(sessionWebhook, '⏳ 正在扫描并索引工作区全部文本文件...', '⏳ 索引中', 'wathet');
			try {
				const count = await memory.index();
				const stats = memory.getStats();
				const msg = [
					`索引完成: **${count}** 个记忆块（来自 **${stats.files}** 个文件）`,
					`嵌入缓存: ${stats.cachedEmbeddings} 条`,
					`嵌入模型: \`${config.VOLC_EMBEDDING_MODEL}\``,
					'',
					'**已索引文件：**',
					...stats.filePaths.slice(0, 25).map((p) => `- \`${p}\``),
					...(stats.filePaths.length > 25 ? [`- …及其他 ${stats.filePaths.length - 25} 个文件`] : []),
				].join('\n');
				await sendMarkdown(sessionWebhook, msg, '✅ 索引完成', 'green');
			} catch (e) {
				await sendMarkdown(sessionWebhook, `索引失败: ${e instanceof Error ? e.message : e}`, '❌ 失败');
			}
			return;
		}
		
		// /心跳 → 心跳系统管理
		const hbMatch = message.match(/^\/(心跳|heartbeat|hb)[\s:：]*(.*)/i);
		if (hbMatch) {
			const subCmd = hbMatch[2].trim().toLowerCase();
			
			if (!subCmd || subCmd === 'status' || subCmd === '状态') {
				const s = heartbeat.getStatus();
				const statusText = [
					`**状态：** ${s.enabled ? '✅ 已启用' : '⏸ 已关闭'}`,
					`**间隔：** ${Math.round(s.everyMs / 60000)} 分钟`,
					s.nextRunAt ? `**下次执行：** ${new Date(s.nextRunAt).toLocaleString('zh-CN')}` : '',
					s.lastRunAt ? `**上次执行：** ${new Date(s.lastRunAt).toLocaleString('zh-CN')}` : '',
					'',
					'**用法：**',
					'- `/心跳 开启` — 启动心跳检查',
					'- `/心跳 关闭` — 停止心跳检查',
					'- `/心跳 执行` — 立即执行一次',
					'- `/心跳 间隔 分钟数` — 设置间隔',
					'',
					'编辑工作区的 `.cursor/HEARTBEAT.md` 可自定义检查清单。',
				].filter(Boolean).join('\n');
				await sendMarkdown(sessionWebhook, statusText, '💓 心跳系统', 'purple');
				return;
			}
			
			if (/^(开启|enable|on|start|启动)$/i.test(subCmd)) {
				heartbeat.updateConfig({ enabled: true });
				await sendMarkdown(sessionWebhook, `心跳已开启，每 ${Math.round(heartbeat.getStatus().everyMs / 60000)} 分钟检查一次。\n\n编辑 \`.cursor/HEARTBEAT.md\` 自定义检查清单。`, '💓 已开启', 'green');
				return;
			}
			
			if (/^(关闭|disable|off|stop|停止)$/i.test(subCmd)) {
				heartbeat.updateConfig({ enabled: false });
				await sendMarkdown(sessionWebhook, '心跳已关闭。', '💓 已关闭', 'grey');
				return;
			}
			
			if (/^(执行|run|check|检查)$/i.test(subCmd)) {
				await sendMarkdown(sessionWebhook, '💓 正在执行心跳检查...', '⏳ 执行中', 'wathet');
				const result = await heartbeat.runOnce();
				if (result.status === 'ran') {
					await sendMarkdown(sessionWebhook, result.hasContent ? '心跳检查完成，发现需要关注的事项（已发送）' : '心跳检查完成，一切正常 ✅', '💓 检查完成', 'green');
				} else {
					await sendMarkdown(sessionWebhook, result.message || '检查跳过', '💓 已跳过');
				}
				return;
			}
			
			const intervalMatch = subCmd.match(/^(?:间隔|interval)\s+(\d+)$/i);
			if (intervalMatch) {
				const mins = Number.parseInt(intervalMatch[1], 10);
				if (mins < 1 || mins > 1440) {
					await sendMarkdown(sessionWebhook, '间隔范围: 1-1440 分钟', '⚠️ 无效');
					return;
				}
				heartbeat.updateConfig({ everyMs: mins * 60_000 });
				await sendMarkdown(sessionWebhook, `心跳间隔已设为 **${mins} 分钟**`, '💓 已更新');
				return;
			}
			
			await sendMarkdown(sessionWebhook, '未知子命令。发送 `/心跳` 查看用法。', 'ℹ️ 用法');
			return;
		}
		
		// 未知指令 → 友好提示
		if (message.startsWith('/')) {
			const cmd = message.split(/[\s:：]/)[0];
			await sendMarkdown(sessionWebhook, `未知指令 \`${cmd}\`\n\n发送 \`/帮助\` 查看所有可用指令。`, '❓ 未知指令');
			return;
		}
		
		// 调用 Cursor（并发控制）
		const lockKey = getLockKey(workspace);
		
		// 检查是否有同会话任务运行中
		if (busySessions.has(lockKey)) {
			await sendMarkdown(sessionWebhook, '⏳ 排队中（同会话有任务进行中）\n\n请稍候...', '⏸️ 排队中', 'orange');
			console.log(`[并发] 会话 ${lockKey} 已在运行，等待中...`);
		}
		
		busySessions.add(lockKey);
		console.log(`[执行] workspace=${workspace} message="${message.slice(0, 60)}"`);
		await sendMarkdown(sessionWebhook, '⏳ Cursor AI 正在思考...', '💭 思考中', 'wathet');
		
		// 记忆由 Cursor 自主通过 memory-tool.ts 调用，server 记录会话日志
		if (memory) {
			memory.appendSessionLog(workspace, "user", message, config.CURSOR_MODEL);
		}
		
			const t1 = Date.now();
		console.log(`[时序1] 准备调用 runAgent, 时间: ${t1}`);
		
		try {
			const { result, sessionId } = await runAgent(workspace, message, session.agentId, {
				platform: 'dingtalk',
				webhook: sessionWebhook
			});
			
			const t2 = Date.now();
			console.log(`[时序2] runAgent 返回, 耗时: ${t2 - t1}ms`);
			
			// 保存 session ID（用于会话恢复和历史记录）
			if (sessionId) {
				session.agentId = sessionId;
				// 同步到会话历史存储
				setActiveSession(workspace, sessionId, message.slice(0, 40));
				console.log(`[会话] 已保存 sessionId: ${sessionId}`);
			}
			
			// 确保 result 为字符串（agent 有时返回对象）
			console.log(`[调试] result 类型: ${typeof result}, 值: ${JSON.stringify(result)?.slice(0, 200)}`);
			
			let resultStr = '';
			if (typeof result === 'string') {
				resultStr = result;
			} else if (result && typeof result === 'object') {
				const obj = result as any;
				resultStr = obj.text || obj.content || '';
			}
			const cleanOutput = resultStr.trim();
			
			console.log(`[调试] resultStr 长度: ${resultStr.length}, cleanOutput 长度: ${cleanOutput.length}`);
			console.log(`[调试] cleanOutput 前100字符: ${cleanOutput.slice(0, 100)}`);
			
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
				for (let i = 0; i < chunks.length; i++) {
					const title = chunks.length > 1 ? `Cursor AI (${i + 1}/${chunks.length})` : 'Cursor AI';
					await sendMarkdown(sessionWebhook, chunks[i], title, 'green');
					if (i < chunks.length - 1) {
						await new Promise(resolve => setTimeout(resolve, 500));
					}
				}
			} else {
				await sendMarkdown(sessionWebhook, '✅ 任务已完成（无输出）', '完成', 'green');
			}
		} finally {
			busySessions.delete(lockKey);
		}
		
	} catch (error) {
		console.error('[处理失败]', error);
		try {
			await sendMarkdown(
				sessionWebhook,
				`❌ **执行失败**\n\n${error instanceof Error ? error.message : String(error)}`,
				'执行失败',
				'red'
			);
		} catch {}
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
		// 直接返回提醒内容，不经过 Agent
		console.log(`[定时] 触发任务: ${job.name}`);
		return { status: 'ok' as const, result: job.message };
	},
	onDelivery: async (job: CronJob, result: string) => {
		// 优先使用任务中保存的 webhook（确保发送到创建任务的平台）
		const webhook = job.webhook || getWebhook();
		if (!webhook) {
			console.warn('[调度] 无活跃 webhook，跳过推送（用户需要先发送至少一条消息）');
			return;
		}

		// 只有钉钉创建的任务才发送到钉钉
		if (job.platform && job.platform !== 'dingtalk') {
			console.log(`[调度] 任务 ${job.name} 属于 ${job.platform}，跳过钉钉推送`);
			return;
		}
		
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
		console.log(`[定时] 钉钉提醒已发送: ${result}`);
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
│    - 命令: /帮助 /状态 /新对话 /会话 /模型 /密钥 /终止 /任务
│    - 会话: 持久化、历史、切换
│    - 记忆: 语义搜索、日志记录、全工作区索引（与飞书共享）
│    - 心跳: 定期检查、主动推送
│    - 定时: cron-jobs-dingtalk.json
│
│  ⏸️ 暂不支持:
│    - 实时进度（平台限制：钉钉不支持消息更新）
└──────────────────────────────────────────────────┘
`);

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

await refreshAccessToken();
await client.connect();
console.log('钉钉 Stream 连接已建立，等待消息...');

// ── 启动定时任务调度器 ────────────────────────────
console.log('[调度] 正在启动 Scheduler...');
scheduler.start().catch((err) => {
	console.error('[调度] 启动失败:', err);
});
console.log(`[调度] Scheduler 已启动，文件: ${cronStorePath}`);

// ── 启动心跳系统 ──────────────────────────────────
heartbeat.start();
console.log(`[心跳] 已启动，默认关闭（发送 /心跳 开启）`);
