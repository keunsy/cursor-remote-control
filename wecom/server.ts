/**
 * 企业微信 WebSocket → Cursor Agent CLI 中继服务
 * 
 * 基于 @wecom/aibot-node-sdk
 * 技术栈：WebSocket 长连接 + 流式回复 + 模板卡片
 * 
 * 启动: bun run server.ts
 */

import AiBot from '@wecom/aibot-node-sdk';
import type { WsFrame } from '@wecom/aibot-node-sdk';
import { generateReqId } from '@wecom/aibot-node-sdk';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, watchFile, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Scheduler, type CronJob } from '../shared/scheduler.js';
import { MemoryManager } from '../shared/memory.js';
import { HeartbeatRunner } from '../shared/heartbeat.js';
import {
	getSession, setActiveSession, archiveAndResetSession,
	getSessionHistory, getActiveSessionId, switchToSession, getLockKey, busySessions,
	describeToolCall, buildToolSummary, resolveWorkspace, detectRouteIntent,
	loadSessionsFromDisk, saveSessions, sessionsStore,
} from './wecom-helper.js';

const HOME = process.env.HOME!;
const ROOT = resolve(import.meta.dirname, '..');
const ENV_PATH = resolve(import.meta.dirname, '.env');
const PROJECTS_PATH = resolve(ROOT, 'projects.json');
const INBOX_DIR = resolve(ROOT, 'inbox');
const WHISPER_MODEL = resolve(HOME, 'models/ggml-tiny.bin');
const BOOT_DELAY_MS = 8000;

mkdirSync(INBOX_DIR, { recursive: true });

// 清理 inbox
const DAY_MS = 24 * 60 * 60 * 1000;
for (const f of readdirSync(INBOX_DIR)) {
	const p = resolve(INBOX_DIR, f);
	try {
		if (Date.now() - statSync(p).mtimeMs > DAY_MS) unlinkSync(p);
	} catch {}
}

// 全局异常处理
process.on('uncaughtException', (err) => console.error(`[致命异常] ${err.message}\n${err.stack}`));
process.on('unhandledRejection', (reason) => console.error('[Promise 异常]', reason));

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

// ── 可选模型列表与匹配 ───────────────────────────
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
	
	const exact = CURSOR_MODELS.find(m => m.id === input.toLowerCase());
	if (exact) return { exact, candidates: [] };
	
	const num = Number.parseInt(input, 10);
	if (!Number.isNaN(num) && num >= 1 && num <= CURSOR_MODELS.length) {
		return { exact: CURSOR_MODELS[num - 1], candidates: [] };
	}
	
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
		if (!m) continue;
		const isCurrent = m.id === currentModel;
		lines.push(isCurrent
			? `**${i + 1}. ${m.id}** · ${m.desc} ✅`
			: `${i + 1}. \`${m.id}\` · ${m.desc}`);
	}
	lines.push('');
	lines.push('> 发送 `/模型 编号` 或 `/模型 名称` 切换');
	return lines.join('\n');
}

function formatRelativeTime(ms: number): string {
	const diff = Date.now() - ms;
	if (diff < 60_000) return "刚刚";
	if (diff < 3600_000) return `${Math.floor(diff / 60_000)}分钟前`;
	if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}小时前`;
	if (diff < 604800_000) return `${Math.floor(diff / 86400_000)}天前`;
	return new Date(ms).toLocaleDateString("zh-CN");
}

// ── 配置 ─────────────────────────────────────────
interface EnvConfig {
	CURSOR_API_KEY: string;
	WECOM_BOT_ID: string;
	WECOM_BOT_SECRET: string;
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
		WECOM_BOT_ID: env.WECOM_BOT_ID || '',
		WECOM_BOT_SECRET: env.WECOM_BOT_SECRET || '',
		CURSOR_MODEL: env.CURSOR_MODEL || 'auto',
		VOLC_STT_APP_ID: env.VOLC_STT_APP_ID || '',
		VOLC_STT_ACCESS_TOKEN: env.VOLC_STT_ACCESS_TOKEN || '',
		VOLC_EMBEDDING_API_KEY: env.VOLC_EMBEDDING_API_KEY || '',
		VOLC_EMBEDDING_MODEL: env.VOLC_EMBEDDING_MODEL || 'doubao-embedding-vision-250615',
	};
}

let config = loadEnv();

// .env 热更新
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

// ── 最近活跃会话（用于定时任务/心跳主动推送）─────
interface ActiveSession {
	chatid: string;
	chattype: 'single' | 'group';
	userid?: string;
}
let lastActiveSession: ActiveSession | undefined;

// ── 心跳系统 ──────────────────────────────────────
const heartbeat = new HeartbeatRunner({
	config: {
		enabled: false,
		everyMs: 30 * 60_000,
		workspaceDir: memoryWorkspace,
	},
	onExecute: async (prompt: string) => {
		memory?.appendSessionLog(memoryWorkspace, "user", "[心跳检查] " + prompt.slice(0, 200), config.CURSOR_MODEL);
		const { result, quotaWarning } = await runAgent(memoryWorkspace, prompt);
		const finalResult = quotaWarning ? `${quotaWarning}\n\n---\n\n${result}` : result;
		memory?.appendSessionLog(memoryWorkspace, "assistant", finalResult.slice(0, 3000), config.CURSOR_MODEL);
		return finalResult;
	},
	onDelivery: async (content: string) => {
		if (!lastActiveSession) {
			console.warn("[心跳] 无活跃会话，跳过发送");
			return;
		}
		try {
			await wsClient.sendMessage(lastActiveSession.chatid, {
				msgtype: 'markdown',
				markdown: {
					content: `💓 **心跳检查**\n\n${content.slice(0, 3000)}`,
				},
			});
			console.log(`[心跳] 结果已推送到 ${lastActiveSession.chattype} (${lastActiveSession.chatid.slice(0, 8)}...)`);
		} catch (err) {
			console.error('[心跳] 推送失败:', err);
		}
	},
	log: (msg: string) => console.log(`[心跳] ${msg}`),
});

// ── Agent 进程跟踪（用于 /终止 命令）─────────────
const activeAgents = new Map<string, any>();

// ── Cursor Agent 调用 ─────────────────────────────
const PROGRESS_INTERVAL = 2_000;

interface AgentProgress {
	elapsed: number;
	phase: "thinking" | "tool_call" | "responding";
	snippet: string;
}

interface RunAgentResult {
	result: string;
	quotaWarning?: string;
}

async function runAgent(
	workspace: string,
	message: string,
	agentId?: string,
	context?: {
		onSessionId?: (sessionId: string) => void;
		onProgress?: (progress: AgentProgress) => void;
		onStart?: () => void;
	}
): Promise<RunAgentResult> {
	const primaryModel = config.CURSOR_MODEL || 'auto';

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
		return new Promise((res, reject) => {
			const args = [
				'-p', '--force', '--trust', '--approve-mcps',
				'--workspace', workspace,
				'--model', model,
				'--output-format', 'stream-json',
				'--stream-partial-output',
			];
			if (agentId) args.push('--resume', agentId);
			args.push('--', message);

			const env = config.CURSOR_API_KEY
				? { ...process.env, CURSOR_API_KEY: config.CURSOR_API_KEY }
				: process.env;
			env.CURSOR_CRON_FILE = resolve(ROOT, 'cron-jobs-wecom.json');

			const proc = spawn('agent', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });

			const lockKey = getLockKey(workspace);
			const startTime = Date.now();
			
			// 注册到 activeAgents（用于 /终止 命令）
			activeAgents.set(lockKey, proc);

			let stderr = '';
			let resultText = '';
			let sessionId: string | undefined = agentId;
			let assistantBuf = '';
			let toolSummary: string[] = [];
			let lineBuf = '';
			let done = false;
			let currentPhase: "thinking" | "tool_call" | "responding" = "thinking";
			let lastProgressTime = 0;
			let sessionLockAcquired = false;

			function cleanup() {
				done = true;
				busySessions.delete(lockKey);
				activeAgents.delete(lockKey);
				if (progressTimer) clearInterval(progressTimer);
			}

			// 定时器：每2秒发送进度更新
			const progressTimer = setInterval(() => {
				if (done) return;
				const elapsed = Math.floor((Date.now() - startTime) / 1000);
				const snippet = assistantBuf.split('\n').filter(l => l.trim()).slice(-4).join('\n');
				
				if (context?.onProgress) {
					context.onProgress({
						elapsed,
						phase: currentPhase,
						snippet: snippet || '...',
					});
				}
			}, PROGRESS_INTERVAL);

			proc.stdout.on('data', (chunk) => {
				lineBuf += chunk.toString();
				const lines = lineBuf.split('\n');
				lineBuf = lines.pop() || '';
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const ev = JSON.parse(line);
						if (ev.session_id && !sessionId) sessionId = ev.session_id;

						if (ev.type === 'result' && ev.result != null) {
							resultText = ev.result;
							currentPhase = "responding";
						}
						if (ev.type === 'assistant' && ev.message?.content) {
							for (const c of ev.message.content) {
								if (c.type === 'text' && c.text) {
									assistantBuf += c.text;
									currentPhase = "responding";
								}
							}
						}
						if (ev.type === 'tool_call' && ev.tool_call) {
							if (ev.subtype === 'started') {
								const desc = describeToolCall(ev.tool_call);
								toolSummary.push(desc);
								currentPhase = "tool_call";
							}
						}
						
						// 检测到获取 session lock 后触发 onStart
						if (!sessionLockAcquired && sessionId && context?.onStart) {
							sessionLockAcquired = true;
							context.onStart();
						}
					} catch (_) {}
				}
			});

			proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

			proc.on('close', (code) => {
				if (done) return;
				cleanup();
				if (lineBuf.trim()) {
					try {
						const ev = JSON.parse(lineBuf);
						if (ev.session_id && !sessionId) sessionId = ev.session_id;
						if (ev.type === 'result' && ev.result != null) resultText = ev.result;
					} catch (_) {}
				}

				const rawResultText = typeof resultText === 'string' ? resultText.trim() : '';
				const rawOutput = rawResultText || assistantBuf.trim() || stderr.trim() || '(无输出)';

				let finalOutput = rawOutput;
				if (toolSummary.length > 0) {
					const summary = buildToolSummary(toolSummary);
					if (summary) {
						finalOutput = summary + '\n\n---\n\n' + rawOutput;
					}
				}

				if (code === 0) res({ result: finalOutput, sessionId });
				else reject(new Error(`Agent exited with code ${code}\n${stderr}`));
			});

			proc.on('error', (err) => {
				if (!done) { cleanup(); reject(err); }
			});
		});
	}

	try {
		const out = await runWithModel(primaryModel);
		notifySession(out);
		return { result: out.result };
	} catch (error) {
		if (isQuotaError(error as Error)) {
			console.log(`[降级] ${primaryModel} 余额不足，切换到 auto`);
			try {
				const out = await runWithModel('auto');
				notifySession(out);
				return {
					result: out.result,
					quotaWarning: `⚠️ **模型降级**\n\n${primaryModel} 余额不足，已用 auto 完成。`,
				};
			} catch (retryError) {
				throw new Error(
					`原模型余额不足且降级失败: ${retryError instanceof Error ? retryError.message : String(retryError)}`
				);
			}
		}
		throw error;
	}
}

// ── 企业微信客户端 ────────────────────────────────
console.log(`
┌──────────────────────────────────────────────────┐
│  企业微信 → Cursor Agent 中继服务 v1.0           │
├──────────────────────────────────────────────────┤
│  模型: ${config.CURSOR_MODEL}
│  Key:  ${config.CURSOR_API_KEY ? `...${config.CURSOR_API_KEY.slice(-8)}` : '(未设置)'}
│  连接: WebSocket 长连接
│  SDK: @wecom/aibot-node-sdk
│  收件: ${INBOX_DIR}
│  记忆: ${memory ? `与飞书/钉钉共享（${config.VOLC_EMBEDDING_MODEL}）` : '未初始化'}
│  调度: cron-jobs-wecom.json (全局目录)
│  心跳: 默认关闭（/心跳 开启）
│
│  项目路由:
${Object.entries(projectsConfig.projects).map(([k, v]) => `│    /${k} → ${v.path}`).join('\n')}
└──────────────────────────────────────────────────┘
`);

// 启动前校验
if (!config.WECOM_BOT_ID?.trim() || !config.WECOM_BOT_SECRET?.trim()) {
	console.error('[致命] 企业微信机器人未配置，无法建立连接。');
	console.error('  请在 wecom/.env 中设置:');
	console.error('    WECOM_BOT_ID=你的BotID');
	console.error('    WECOM_BOT_SECRET=你的Secret');
	console.error('  参考: cp .env.example .env 后编辑，或查看 README');
	process.exit(1);
}

const wsClient = new AiBot.WSClient({
	botId: config.WECOM_BOT_ID,
	secret: config.WECOM_BOT_SECRET,
});

// ── 事件监听 ─────────────────────────────────────
wsClient.on('authenticated', () => {
	console.log('🔐 [企业微信] WebSocket 认证成功');
});

wsClient.on('disconnected', (reason) => {
	console.warn(`⚠️  [企业微信] 连接断开: ${reason || '未知原因'}`);
});

// 进入会话事件（发送欢迎语）
wsClient.on('event.enter_chat', async (frame: WsFrame) => {
	try {
		await wsClient.replyWelcome(frame, {
			msgtype: 'text',
			text: { content: '您好！我是 Cursor AI 助手，有什么可以帮您的吗？\n\n发送 /帮助 查看所有指令。' },
		});
		console.log('[欢迎语] 已发送');
	} catch (error) {
		console.error('[欢迎语失败]', error);
	}
});

// 消息去重
const seenMessages = new Map<string, number>();
const MAX_SEEN_SIZE = 1000;
const BATCH_CLEANUP_SIZE = 100;  // Bug #14 修复：批量清理数量

function isDuplicate(messageId: string): boolean {
	const now = Date.now();
	
	// 定期清理过期消息（每次检查时）
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
	
	// 添加新消息
	seenMessages.set(messageId, now);
	
	// Bug #14 修复：达到上限时批量删除最老的消息
	if (seenMessages.size > MAX_SEEN_SIZE) {
		const sorted = Array.from(seenMessages.entries())
			.sort((a, b) => a[1] - b[1])
			.slice(0, BATCH_CLEANUP_SIZE);
		for (const [id] of sorted) {
			seenMessages.delete(id);
		}
		console.log(`[去重] 缓存超限，已清理 ${BATCH_CLEANUP_SIZE} 条最老消息`);
	}
	
	return false;
}

// 文本消息
wsClient.on('message.text', async (frame: WsFrame) => {
	try {
		const msgid = frame.body.msgid || '';
		if (isDuplicate(msgid)) return;
		
		const chattype = frame.body.chattype as 'single' | 'group';
		const userid = frame.body.from?.userid || '';
		// 企业微信：单聊用 userid，群聊用 chatid
		const chatid = chattype === 'single' ? userid : (frame.body.chatid || '');
		const text = frame.body.text?.content || '';

		if (!text.trim()) return;

		console.log(`[收到消息] chattype=${chattype} chatid=${chatid.slice(0, 20)} userid=${userid} text="${text.slice(0, 60)}"`);

		// 记录最近活跃会话（用于定时任务/心跳主动推送）
		lastActiveSession = { chatid, chattype, userid: userid || undefined };

		// 获取会话
		const session = getSession(chatid, userid, defaultWorkspace);
		
		// === 命令系统 ===
		
		// === 命令系统（参考飞书完整实现）===
		
		// /apikey、/密钥 → 更换 Cursor API Key
		if (/^\/?(?:apikey|api\s*key|密钥|换key|更换密钥)\s*$/i.test(text.trim())) {
			const keyPreview = config.CURSOR_API_KEY ? `\`...${config.CURSOR_API_KEY.slice(-8)}\`` : "**未设置**";
			await wsClient.reply(frame, {
				msgtype: 'markdown',
				markdown: {
					content: `当前 Key：${keyPreview}\n\n更换方式：\`/密钥 key_xxx...\` 或 \`/apikey key_xxx...\`\n\n[生成新 Key →](https://cursor.com/dashboard)`,
				},
			});
			return;
		}
		const apikeyMatch = text.match(/^\/?(?:api\s*key|密钥|换key|更换密钥)[\s:：=]*(.+)/i);
		if (apikeyMatch) {
			if (chattype === 'group') {
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: "⚠️ **安全提醒：请勿在群聊中发送 API Key！**\n\n请在与机器人的 **私聊** 中发送 `/apikey` 指令。",
					},
				});
				return;
			}
			const rawKey = apikeyMatch[1].trim().replace(/^["'`]+|["'`]+$/g, "");
			if (!rawKey || rawKey.length < 20) {
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: "❌ Key 格式不对，太短了。请发送完整的 Cursor API Key。\n\n支持格式：\n- `/apikey key_xxxx...`\n- `/密钥 key_xxxx...`",
					},
				});
				return;
			}
			try {
				const envContent = readFileSync(ENV_PATH, "utf-8");
				const updated = envContent.match(/^CURSOR_API_KEY=/m)
					? envContent.replace(/^CURSOR_API_KEY=.*$/m, `CURSOR_API_KEY=${rawKey}`)
					: `${envContent.trimEnd()}\nCURSOR_API_KEY=${rawKey}\n`;
				writeFileSync(ENV_PATH, updated);
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: `**API Key 已更换**\n\n新 Key: \`...${rawKey.slice(-8)}\`\n\n已写入 .env 并自动生效。`,
					},
				});
				console.log(`[指令] API Key 已更换 (...${rawKey.slice(-8)})`);
			} catch (err) {
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: `❌ 写入失败: ${err instanceof Error ? err.message : err}`,
					},
				});
			}
			return;
		}
		
		// /help、/帮助
		if (/^\/(help|帮助|指令)\s*$/i.test(text.trim())) {
			const helpText = [
				'**基础指令**',
				'- `/帮助` `/help` — 显示本帮助',
				'- `/状态` `/status` — 查看服务状态',
				'- `/项目` `/project` — 列出所有项目',
				'- `/新对话` `/new` — 重置当前会话',
				'- `/终止 [项目名]` `/stop` — 终止正在执行的任务',
				'',
				'**会话管理**',
				'- `/会话` `/sessions` — 查看最近会话列表',
				'- `/会话 编号` — 切换到指定会话',
				'',
				'**模型与密钥**',
				'- `/模型` `/model` — 查看/切换 AI 模型',
				'- `/密钥` `/apikey` — 查看/更换 API Key（仅私聊）',
				'  用法：`/密钥 key_xxx...`',
				'',
				'**记忆系统**',
				'- `/记忆` `/memory` — 查看记忆状态',
				'- `/记忆 关键词` — 语义搜索记忆',
				'- `/记录 内容` — 写入今日日记',
				'- `/整理记忆` `/reindex` — 重建记忆索引',
				'',
				'**定时任务**',
				'- `/任务` `/cron` — 查看/暂停/恢复/删除定时任务',
				'',
				'**心跳系统**',
				'- `/心跳` `/heartbeat` — 查看心跳状态',
				'- `/心跳 开启/关闭/执行`',
				'- `/心跳 间隔 分钟数`',
				'',
				'**项目路由**',
				'· 对话切换：说「切到 remote」等可持久切换',
				'· 前缀指定：`项目名:消息` 或 `#项目名 消息`',
				`· 可用项目：${Object.keys(projectsConfig.projects).map(k => `\`${k}\``).join('、')}`,
			].join('\n');
			
			// 使用 reply 方法回复（通过 WebSocket 通道）
			try {
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: `📖 **使用帮助**\n\n${helpText}`,
					},
				});
				console.log('[命令] /help 回复已发送');
			} catch (error) {
				console.error('[命令] /help 回复失败', error);
			}
			return;
		}
		
		// /status、/状态
		if (/^\/(status|状态)\s*$/i.test(text.trim())) {
			const botIdPreview = config.WECOM_BOT_ID ? `\`...${config.WECOM_BOT_ID.slice(-8)}\`` : '**未设置**';
			const projects = Object.entries(projectsConfig.projects).map(([k, v]) => `  \`${k}\` → ${v.path}`).join('\n');
			const memStatus = memory
				? (() => {
					const stats = memory.getStats();
					return `${stats.chunks} 块（${stats.files} 文件, ${stats.cachedEmbeddings} 嵌入缓存）`;
				})()
				: '未初始化';
			
			const keyPreview = config.CURSOR_API_KEY ? `\`...${config.CURSOR_API_KEY.slice(-8)}\`` : "**未设置**";
			
			const sessions = [...sessionsStore.entries()]
				.filter(([, s]) => s.active)
				.map(([ws, s]) => {
					const name = Object.entries(projectsConfig.projects).find(([, v]) => v.path === ws)?.[0] || ws;
					const entry = s.history.find((h) => h.id === s.active);
					const info = entry ? ` · ${entry.summary.slice(0, 30)}` : "";
					return `  \`${name}\` → ${s.active!.slice(0, 12)}...${info}`;
				}).join("\n") || "  (无活跃会话)";
			
			const statusText = [
				`**BotID：** ${botIdPreview}`,
				`**Key：** ${keyPreview}`,
				`**模型：** \`${config.CURSOR_MODEL}\``,
				`**记忆：** ${memStatus}`,
				`**调度：** ${(() => { const s = scheduler.getStats(); return s.total > 0 ? `${s.enabled}/${s.total} 任务${s.nextRunIn ? `（下次: ${s.nextRunIn}）` : ""}` : '无任务'; })()}`,
				`**心跳：** ${heartbeat.getStatus().enabled ? `每 ${Math.round(heartbeat.getStatus().everyMs / 60000)} 分钟` : '未启用'}`,
				`**活跃任务：** ${activeAgents.size} 个运行中`,
				`**工作区：** ${memoryWorkspace}`,
				'',
				'**项目路由：**',
				projects,
				'',
				'**活跃会话：**',
				sessions,
			].join('\n');
			
			try {
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: `📊 **服务状态**\n\n${statusText}`,
					},
				});
				console.log('[命令] /status 回复已发送');
			} catch (error) {
				console.error('[命令] /status 回复失败', error);
			}
			return;
		}
		
		// /new、/新对话
		if (/^\/(new|新对话|新会话)\s*$/i.test(text.trim())) {
			const workspace = projectsConfig.projects[session.currentProject || projectsConfig.default_project]?.path || defaultWorkspace;
			archiveAndResetSession(workspace);
			
			const historyCount = getSessionHistory(workspace).length;
			const hint = historyCount > 0 ? `\n\n历史会话已保留（共 ${historyCount} 个），发送 \`/会话\` 可查看和切换。` : "";
			
			try {
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: `🆕 **新会话已开始**\n\n下一条消息将创建全新对话。${hint}`,
					},
				});
				console.log('[命令] /new 回复已发送');
			} catch (error) {
				console.error('[命令] /new 回复失败', error);
			}
			return;
		}
		
		// /model、/模型 → 切换模型
		const modelMatch = text.match(/^\/(model|模型|切换模型)[\s:：=]*(.*)/i);
		if (modelMatch) {
			const input = modelMatch[2].trim();
			
			if (!input) {
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: buildModelListCard(config.CURSOR_MODEL),
					},
				});
				return;
			}
			
			const { exact, candidates } = fuzzyMatchModel(input);
			
			if (exact) {
				if (exact.id === config.CURSOR_MODEL) {
					await wsClient.reply(frame, {
						msgtype: 'markdown',
						markdown: {
							content: `当前已是 **${exact.id}**（${exact.desc}），无需切换。`,
						},
					});
					return;
				}
				const envContent = readFileSync(ENV_PATH, "utf-8");
				const updated = envContent.match(/^CURSOR_MODEL=/m)
					? envContent.replace(/^CURSOR_MODEL=.*$/m, `CURSOR_MODEL=${exact.id}`)
					: `${envContent.trimEnd()}\nCURSOR_MODEL=${exact.id}\n`;
				writeFileSync(ENV_PATH, updated);
				const prev = config.CURSOR_MODEL;
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: `${prev} → **${exact.id}**（${exact.desc}）\n\n已写入 .env，2 秒内自动生效。`,
					},
				});
				console.log(`[指令] 模型切换: ${prev} → ${exact.id}`);
				return;
			}
			
			if (candidates.length > 1) {
				const list = candidates.map((m) => `- \`${m.id}\`（${m.desc}）`).join("\n");
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: `「${input}」匹配到多个模型：\n\n${list}\n\n请输入更精确的名称或编号。`,
					},
				});
				return;
			}
			
			if (input.length < 2 || /^\d+$/.test(input)) {
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: buildModelListCard(config.CURSOR_MODEL, `「${input}」无匹配，请从列表中选择`),
					},
				});
				return;
			}
			
			const envContent = readFileSync(ENV_PATH, "utf-8");
			const updated = envContent.match(/^CURSOR_MODEL=/m)
				? envContent.replace(/^CURSOR_MODEL=.*$/m, `CURSOR_MODEL=${input}`)
				: `${envContent.trimEnd()}\nCURSOR_MODEL=${input}\n`;
			writeFileSync(ENV_PATH, updated);
			const prev = config.CURSOR_MODEL;
			await wsClient.reply(frame, {
				msgtype: 'markdown',
				markdown: {
					content: `${prev} → **${input}**\n\n⚠️ 此模型不在常用列表中，若名称有误可能导致执行失败。`,
				},
			});
			console.log(`[指令] 模型切换(自定义): ${prev} → ${input}`);
			return;
		}
		
		// /会话、/sessions → 会话管理
		const sessionsMatch = text.match(/^\/(会话|sessions?)[\s:：=]*(.*)/i);
		if (sessionsMatch) {
			const input = sessionsMatch[2].trim();
			const workspace = projectsConfig.projects[session.currentProject || projectsConfig.default_project]?.path || defaultWorkspace;
			
			if (!input) {
				const history = getSessionHistory(workspace, 10);
				const active = getActiveSessionId(workspace);
				if (history.length === 0) {
					await wsClient.reply(frame, {
						msgtype: 'markdown',
						markdown: {
							content: '暂无会话历史。\n\n发送消息即可创建新会话。',
						},
					});
					return;
				}
				const lines = history.map((h, i) => {
					const isCurrent = h.id === active;
					const time = formatRelativeTime(h.lastActiveAt);
					return isCurrent
						? `**${i + 1}. ${h.summary}** ✅\n   \`${h.id.slice(0, 12)}...\` · ${time}`
						: `${i + 1}. ${h.summary}\n   \`${h.id.slice(0, 12)}...\` · ${time}`;
				});
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: `**最近会话（共 ${history.length} 个）**\n\n${lines.join('\n\n')}\n\n> 发送 \`/会话 编号\` 切换`,
					},
				});
				return;
			}
			
			const num = Number.parseInt(input, 10);
			if (Number.isNaN(num) || num < 1) {
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: `❌ 编号格式错误\n\n请发送 \`/会话\` 查看列表，然后 \`/会话 编号\` 切换。`,
					},
				});
				return;
			}
			
			const history = getSessionHistory(workspace, 20);
			if (num > history.length) {
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: `❌ 编号超出范围（共 ${history.length} 个会话）\n\n发送 \`/会话\` 查看列表。`,
					},
				});
				return;
			}
			
			const targetSession = history[num - 1];
			if (!targetSession) {
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: `❌ 会话不存在。`,
					},
				});
				return;
			}
			
			const ok = switchToSession(workspace, targetSession.id);
			if (ok) {
				session.agentId = targetSession.id;
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: `✅ **已切换到会话 ${num}**\n\n${targetSession.summary}\n\n\`${targetSession.id.slice(0, 12)}...\`\n\n下一条消息将在此会话中继续对话。`,
					},
				});
				console.log(`[会话] 切换到: ${targetSession.id}`);
			} else {
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: `❌ 切换失败，会话不存在。`,
					},
				});
			}
			return;
		}
		
		// /项目、/project → 列出所有项目
		if (/^\/(项目|project)\s*$/i.test(text.trim())) {
			const projects = Object.entries(projectsConfig.projects).map(([k, v]) => 
				`- **${k}**${k === session.currentProject ? ' ✅' : ''}\n  \`${v.path}\`\n  ${v.description || ''}`
			).join('\n\n');
			await wsClient.reply(frame, {
				msgtype: 'markdown',
				markdown: {
					content: `**可用项目（共 ${Object.keys(projectsConfig.projects).length} 个）**\n\n${projects}\n\n> 发送「切换到 项目名」可持久切换`,
				},
			});
			return;
		}
		
		// /stop、/终止 → 终止当前任务
		if (/^\/(stop|终止|停止)(?:\s+(.+))?$/i.test(text.trim())) {
			const match = text.trim().match(/^\/(stop|终止|停止)(?:\s+(.+))?$/i);
			const projectHint = match?.[2]?.trim();
			
			const getProjectNameByLockKey = (lockKey: string): string | null => {
				const wsPath = lockKey.startsWith('session:') 
					? null
					: lockKey.replace(/^ws:/, '');
				
				if (wsPath) {
					for (const [name, info] of Object.entries(projectsConfig.projects)) {
						if (info.path === wsPath) return name;
					}
				}
				return null;
			};
			
			if (projectHint && projectsConfig.projects[projectHint]) {
				const wsPath = projectsConfig.projects[projectHint].path;
				const lk = getLockKey(wsPath);
				const agent = activeAgents.get(lk);
				if (agent) {
					agent.kill();
					activeAgents.delete(lk);
					busySessions.delete(lk);  // Bug #11 修复：清理会话锁定
					console.log(`[指令] 终止 agent pid=${agent.pid} project=${projectHint} session=${lk}`);
					await wsClient.reply(frame, {
						msgtype: 'markdown',
						markdown: {
							content: `已终止项目 **${projectHint}** 的任务。\n\n发送新消息将继续在当前会话中对话。`,
						},
					});
				} else {
					await wsClient.reply(frame, {
						msgtype: 'markdown',
						markdown: {
							content: `项目 **${projectHint}** 没有正在运行的任务。`,
						},
					});
				}
				return;
			}
			
			const runningAgents = Array.from(activeAgents.entries());
			
			if (runningAgents.length === 0) {
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: '当前没有正在运行的任务。',
					},
				});
		} else if (runningAgents.length === 1) {
			const first = runningAgents[0];
			if (!first) return;
			const [lockKey, agent] = first;
			const projectName = getProjectNameByLockKey(lockKey);
			agent.kill();
			activeAgents.delete(lockKey);
			busySessions.delete(lockKey);  // Bug #11 修复：清理会话锁定
			console.log(`[指令] 终止 agent pid=${agent.pid} session=${lockKey}`);
			
			const msg = projectName 
				? `已终止项目 **${projectName}** 的任务。\n\n发送新消息将继续在当前会话中对话。`
				: `已终止任务（PID: ${agent.pid}）。\n\n发送新消息将继续在当前会话中对话。`;
			await wsClient.reply(frame, {
				msgtype: 'markdown',
				markdown: {
					content: msg,
				},
			});
			} else {
				const list = runningAgents
					.map(([lk, agent]) => {
						const projectName = getProjectNameByLockKey(lk);
						return projectName 
							? `- 项目: **${projectName}** (PID: ${agent.pid})`
							: `- 任务 PID: ${agent.pid} (${lk})`;
					})
					.join('\n');
				
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: `当前有 **${runningAgents.length}** 个任务正在运行：\n\n${list}\n\n请使用 \`/stop 项目名\` 指定要停止的任务。`,
					},
				});
			}
			return;
		}
		
		// /记忆、/memory → 记忆系统操作
		const memoryMatch = text.match(/^\/(记忆|memory|搜索记忆|recall)[\s:：=]*(.*)/i);
		if (memoryMatch) {
			if (!memory) {
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: "记忆系统未初始化（缺少向量嵌入 API Key）。\n\n请在 `.env` 中设置 `VOLC_EMBEDDING_API_KEY`。",
					},
				});
				return;
			}
			const query = memoryMatch[2].trim();
			if (!query) {
				const stats = memory.getStats();
				const fileList = stats.filePaths.length > 0
					? stats.filePaths.slice(0, 25).map((p) => `- \`${p}\``).join("\n") + (stats.filePaths.length > 25 ? `\n- …及其他 ${stats.filePaths.length - 25} 个文件` : "")
					: "（尚未索引，请发送 `/整理记忆`）";
				const statusText = [
					`**记忆索引：** ${stats.chunks} 块（${stats.files} 文件, ${stats.cachedEmbeddings} 嵌入缓存）`,
					`**索引范围：** 工作区全部文本文件`,
					`**嵌入模型：** ${config.VOLC_EMBEDDING_MODEL || '未配置'}`,
					"",
					"**用法：**",
					"- `/记忆 关键词` — 语义搜索记忆",
					"- `/记录 内容` — 写入今日日记",
					"- `/整理记忆` — 重建全工作区索引",
					"",
					`**已索引文件：**\n${fileList}`,
				].join("\n");
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: `🧠 **记忆系统**\n\n${statusText}`,
					},
				});
				return;
			}
			try {
				const results = await memory.search(query, 5);
				if (results.length === 0) {
					await wsClient.reply(frame, {
						msgtype: 'markdown',
						markdown: {
							content: `未找到与「${query}」相关的记忆。\n\n索引范围：工作区全部文本文件（发 \`/整理记忆\` 可刷新）`,
						},
					});
					return;
				}
				const lines = results.map((r, i) =>
					`**${i + 1}.** \`${r.path}#L${r.startLine}\`（相关度 ${(r.score * 100).toFixed(0)}%）\n${r.text.slice(0, 300)}`,
				);
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: `🔍 **搜索「${query}」**\n\n${lines.join("\n\n---\n\n")}`,
					},
				});
			} catch (e) {
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: `搜索失败: ${e instanceof Error ? e.message : e}`,
					},
				});
			}
			return;
		}

		// /记录 → 快速写入今日日记
		const logMatch = text.match(/^\/(记录|log|note)[\s:：=]+(.+)/is);
		if (logMatch) {
			if (!memory) {
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: "记忆系统未初始化。",
					},
				});
				return;
			}
			const content = logMatch[2].trim();
			const path = memory.appendDailyLog(content);
			await wsClient.reply(frame, {
				msgtype: 'markdown',
				markdown: {
					content: `📝 **已记录**\n\n已记录到今日日记。\n\n\`${path}\``,
				},
			});
			return;
		}

		// /整理记忆 → 重建全工作区记忆索引
		if (/^\/(整理记忆|reindex|索引)\s*$/i.test(text.trim())) {
			if (!memory) {
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: "记忆系统未初始化。",
					},
				});
				return;
			}
			
			const streamId = `reindex-${Date.now()}`;
			await wsClient.replyStream(frame, streamId, "⏳ 正在扫描并索引工作区全部文本文件...", false);
			
			try {
				const count = await memory.index();
				const stats = memory.getStats();
				const msg = [
					`索引完成: **${count}** 个记忆块（来自 **${stats.files}** 个文件）`,
					`嵌入缓存: ${stats.cachedEmbeddings} 条`,
					`嵌入模型: \`${config.VOLC_EMBEDDING_MODEL || '未配置'}\``,
					"",
					"**已索引文件：**",
					...stats.filePaths.slice(0, 25).map((p) => `- \`${p}\``),
					...(stats.filePaths.length > 25 ? [`- …及其他 ${stats.filePaths.length - 25} 个文件`] : []),
				].join("\n");
				await wsClient.replyStream(frame, streamId, `✅ **全工作区索引完成**\n\n${msg}`, true);
			} catch (e) {
				await wsClient.replyStream(frame, streamId, `❌ 索引失败: ${e instanceof Error ? e.message : e}`, true);
			}
			return;
		}
		
		// /任务、/cron → 定时任务管理
		const taskMatch = text.match(/^\/(任务|cron|定时|task|schedule|定时任务)[\s:：]*(.*)/i);
		if (taskMatch) {
			const subCmd = taskMatch[2].trim().toLowerCase();
			
			if (!subCmd || subCmd === "list" || subCmd === "列表") {
				const cronFilePath = resolve(ROOT, 'cron-jobs-wecom.json');
				let jobs: any[] = [];
				try {
					if (existsSync(cronFilePath)) {
						const data = JSON.parse(readFileSync(cronFilePath, 'utf-8'));
						// 显示所有企业微信平台的任务（包括已暂停的）
						// 未设置 platform 的旧任务也显示（向后兼容）
						jobs = (data.jobs || []).filter((j: any) => !j.platform || j.platform === 'wecom');
					}
				} catch (e) {
					console.warn(`[任务] 读取文件失败: ${e}`);
				}
				
				if (jobs.length === 0) {
					await wsClient.reply(frame, {
						msgtype: 'markdown',
						markdown: {
							content: "暂无定时任务。\n\n在对话中告诉 AI「每天早上9点提醒我XX」即可自动创建。",
						},
					});
					return;
				}
				
				const lines = jobs.map((j: any, i: number) => {
					const status = j.enabled ? "✅" : "⏸";
					let schedDesc = "";
					if (j.schedule.kind === "at") {
						const atTime = new Date(j.schedule.at);
						schedDesc = `一次性 ${atTime.toLocaleString("zh-CN", { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`;
					} else if (j.schedule.kind === "every") {
						schedDesc = `每 ${Math.round(j.schedule.everyMs / 60000)} 分钟`;
					} else {
						schedDesc = `cron: ${j.schedule.expr}`;
					}
					const lastRun = j.state?.lastRunAtMs ? new Date(j.state.lastRunAtMs).toLocaleString("zh-CN") : "从未执行";
					return `${status} **${i + 1}. ${j.name}**\n   调度: ${schedDesc}\n   上次: ${lastRun}\n   ID: \`${j.id.slice(0, 16)}...\``;
				});
				lines.push("", `📊 共 ${jobs.length} 个任务`);
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: `📋 **定时任务**\n\n${lines.join("\n")}`,
					},
				});
				return;
			}

			// /任务 暂停 ID
			const pauseMatch = subCmd.match(/^(暂停|pause|disable)\s+(\S+)/i);
			if (pauseMatch) {
				const idPrefix = pauseMatch[2];
				const job = (await scheduler.list(true)).find((j) => j.id.startsWith(idPrefix));
				if (!job) {
					await wsClient.reply(frame, {
						msgtype: 'markdown',
						markdown: {
							content: `未找到 ID 为 \`${idPrefix}\` 的任务`,
						},
					});
					return;
				}
				await scheduler.update(job.id, { enabled: false });
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: `⏸ **已暂停**\n\n已暂停: **${job.name}**`,
					},
				});
				return;
			}

			// /任务 恢复 ID
			const resumeMatch = subCmd.match(/^(恢复|resume|enable)\s+(\S+)/i);
			if (resumeMatch) {
				const idPrefix = resumeMatch[2];
				const job = (await scheduler.list(true)).find((j) => j.id.startsWith(idPrefix));
				if (!job) {
					await wsClient.reply(frame, {
						msgtype: 'markdown',
						markdown: {
							content: `未找到 ID 为 \`${idPrefix}\` 的任务`,
						},
					});
					return;
				}
				await scheduler.update(job.id, { enabled: true });
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: `✅ **已恢复**\n\n已恢复: **${job.name}**`,
					},
				});
				return;
			}

			// /任务 删除 ID
			const deleteMatch = subCmd.match(/^(删除|delete|remove)\s+(\S+)/i);
			if (deleteMatch) {
				const idPrefix = deleteMatch[2];
				const job = (await scheduler.list(true)).find((j) => j.id.startsWith(idPrefix));
				if (!job) {
					await wsClient.reply(frame, {
						msgtype: 'markdown',
						markdown: {
							content: `未找到 ID 为 \`${idPrefix}\` 的任务`,
						},
					});
					return;
				}
				await scheduler.remove(job.id);
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: `🗑️ **已删除**\n\n已删除: **${job.name}**`,
					},
				});
				return;
			}

			// 未知子命令
			await wsClient.reply(frame, {
				msgtype: 'markdown',
				markdown: {
					content: `❌ 未知操作\n\n可用操作：\n- \`/任务\` — 查看列表\n- \`/任务 暂停 ID\`\n- \`/任务 恢复 ID\`\n- \`/任务 删除 ID\``,
				},
			});
			return;
		}
		
		// /心跳、/heartbeat → 心跳系统管理
		const heartbeatMatch = text.match(/^\/(心跳|heartbeat|hb)[\s:：]*(.*)/i);
		if (heartbeatMatch) {
			const subCmd = heartbeatMatch[2].trim().toLowerCase();
			const status = heartbeat.getStatus();
			
			if (!subCmd || subCmd === "status" || subCmd === "状态") {
				const statusText = [
					`**当前状态：** ${status.enabled ? "✅ 已启用" : "⏸ 已暂停"}`,
					`**检查间隔：** ${Math.round(status.everyMs / 60000)} 分钟`,
					`**上次检查：** ${status.lastRunAt ? new Date(status.lastRunAt).toLocaleString("zh-CN") : "从未执行"}`,
					`**下次检查：** ${status.nextRunAt ? new Date(status.nextRunAt).toLocaleString("zh-CN") : "未调度"}`,
					"",
					"**用法：**",
					"- `/心跳 开启` — 启用心跳",
					"- `/心跳 关闭` — 暂停心跳",
					"- `/心跳 执行` — 立即执行一次",
					"- `/心跳 间隔 30` — 设置间隔（分钟）",
				].join("\n");
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: `💓 **心跳系统**\n\n${statusText}`,
					},
				});
				return;
			}

			if (subCmd.match(/^(开启|enable|start|on)/)) {
				heartbeat.updateConfig({ enabled: true });
				const newStatus = heartbeat.getStatus();
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: `✅ **心跳已启用**\n\n间隔: ${Math.round(newStatus.everyMs / 60000)} 分钟\n\n${newStatus.nextRunAt ? `下次检查: ${new Date(newStatus.nextRunAt).toLocaleString("zh-CN")}` : ''}`,
					},
				});
				return;
			}

			if (subCmd.match(/^(关闭|disable|stop|off)/)) {
				heartbeat.updateConfig({ enabled: false });
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: `⏸ **心跳已暂停**`,
					},
				});
				return;
			}

			if (subCmd.match(/^(执行|exec|run|now)/)) {
				const streamId = `heartbeat-exec-${Date.now()}`;
				await wsClient.replyStream(frame, streamId, "⏳ **正在执行心跳检查**\n\n执行中...", false);
				
				try {
					const result = await heartbeat.runOnce();
					const msg = result.status === 'ran' 
						? `✅ **心跳检查完成**\n\n${result.hasContent ? '有内容需要关注' : '一切正常'}` 
						: `⏸ **心跳跳过**\n\n原因: ${result.reason}`;
					await wsClient.replyStream(frame, streamId, msg, true);
				} catch (err) {
					await wsClient.replyStream(frame, streamId, `❌ **执行失败**\n\n${err instanceof Error ? err.message : err}`, true);
				}
				return;
			}

			const intervalMatch = subCmd.match(/^(间隔|interval)[\s:：=]+(\d+)/i);
			if (intervalMatch) {
				const minutes = parseInt(intervalMatch[2], 10);
				if (minutes < 1 || minutes > 1440) {
					await wsClient.reply(frame, {
						msgtype: 'markdown',
						markdown: {
							content: `❌ 间隔必须在 1-1440 分钟之间（当前 ${minutes}）`,
						},
					});
					return;
				}
				heartbeat.updateConfig({ everyMs: minutes * 60_000 });
				const newStatus = heartbeat.getStatus();
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: `✅ **间隔已更新**\n\n新间隔: ${minutes} 分钟\n\n${newStatus.enabled ? (newStatus.nextRunAt ? `下次检查: ${new Date(newStatus.nextRunAt).toLocaleString("zh-CN")}` : '') : '（当前处于暂停状态）'}`,
					},
				});
				return;
			}

			// 未知子命令
			await wsClient.reply(frame, {
				msgtype: 'markdown',
				markdown: {
					content: `❌ 未知操作\n\n可用操作：\n- \`/心跳\` — 查看状态\n- \`/心跳 开启/关闭\`\n- \`/心跳 执行\`\n- \`/心跳 间隔 分钟数\``,
				},
			});
			return;
		}
		
		// 项目路由
		const { workspace, message, label, routeChanged, intent } = resolveWorkspace(
			text,
			projectsConfig.projects,
			projectsConfig.default_project,
			session.currentProject
		);
		
		// 处理项目持久切换（"切换到 XXX 项目"）
		if (routeChanged && intent.type === 'switch' && intent.project) {
			const projectInfo = projectsConfig.projects[intent.project];
			if (!projectInfo) {
				const names = Object.keys(projectsConfig.projects);
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: `❌ **未找到项目「${intent.project}」**\n\n可用项目：\n${names.map(n => `- \`${n}\``).join('\n')}\n\n请检查 \`projects.json\` 或使用上述项目名。`,
					},
				});
				return;
			}
			
			// 检查项目路径是否存在
			if (!existsSync(projectInfo.path)) {
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: `❌ **切换失败**\n\n项目路径不存在：\`${projectInfo.path}\`\n\n请检查 \`projects.json\` 配置。`,
					},
				});
				return;
			}
			
			// 持久化项目切换
			session.currentProject = intent.project;
			saveSessions();
			
			await wsClient.reply(frame, {
				msgtype: 'markdown',
				markdown: {
					content: `✅ **已切换到项目：${intent.project}**\n\n📁 ${projectInfo.description}\n\n路径：\n\`\`\`\n${projectInfo.path}\n\`\`\`\n\n后续消息将在此项目中执行，直到你切换到其他项目。`,
				},
			});
			console.log(`[路由] 持久切换到项目: ${intent.project}`);
			return;
		}
		
		// Bug #15 修复：路径切换不支持持久化，改为提示用户使用项目名
		if (routeChanged && intent.type === 'switch' && intent.path) {
			const pathLabel = intent.path.split('/').pop() || intent.path;
			const projectNames = Object.keys(projectsConfig.projects).map(n => `\`${n}\``).join('、');
			await wsClient.reply(frame, {
				msgtype: 'markdown',
				markdown: {
					content: `⚠️ **路径切换不支持持久化**\n\n您尝试切换到：\`${intent.path}\`\n\n**建议方案**：\n\n1️⃣ **使用项目名切换**（推荐）\n   发送：\`切换到 项目名\`\n   可用项目：${projectNames}\n\n2️⃣ **使用路径前缀**（临时路由）\n   发送：\`#${intent.path} 你的消息\`\n   示例：\`#${intent.path} 帮我分析代码\`\n\n3️⃣ **添加到 projects.json**（永久配置）\n   编辑项目配置文件添加新项目\n\n> 路径切换无法保存到会话中，建议使用项目名进行持久切换。`,
				},
			});
			console.log(`[路由] 路径切换被拒绝（不支持持久化）: ${intent.path}`);
			return;
		}
		
		// 并发控制（最多等待 5 分钟）
		const lockKey = getLockKey(workspace);
		if (busySessions.has(lockKey)) {
			await wsClient.reply(frame, {
				msgtype: 'text',
				text: { content: '⏳ 排队中（同会话有任务进行中）\n\n请稍候...' },
			});
			console.log(`[并发] 会话 ${lockKey} 已在运行，等待中...`);
			const maxWaitTime = 5 * 60 * 1000; // 5 分钟
			const startWait = Date.now();
			while (busySessions.has(lockKey)) {
				if (Date.now() - startWait > maxWaitTime) {
					console.error(`[并发] 等待超时（5分钟），拒绝执行: ${lockKey}`);
					await wsClient.reply(frame, {
						msgtype: 'markdown',
						markdown: {
							content: `❌ **排队超时**\n\n当前会话有任务运行超过 5 分钟未完成。\n\n请使用 \`/终止\` 命令强制停止，或稍后再试。`,
						},
					});
					return;
				}
				await new Promise(resolve => setTimeout(resolve, 1000));
			}
		}
		
		busySessions.add(lockKey);
		
		// 流式回复
		const streamId = generateReqId('stream');
		await wsClient.replyStream(frame, streamId, '⏳ Cursor AI 正在思考...', false);
		
		// 记录用户消息
		if (memory) {
			memory.appendSessionLog(workspace, "user", message, config.CURSOR_MODEL);
		}
		
		try {
			const taskStart = Date.now();
			
			// 进度回调：实时更新流式消息
			const onProgress = (p: AgentProgress) => {
				const time = formatElapsed(p.elapsed);
				const phaseLabel = p.phase === "thinking" ? "🤔 思考中" 
					: p.phase === "tool_call" ? "🔧 执行工具" 
					: "💬 回复中";
				const snippet = p.snippet.split("\n").filter((l) => l.trim()).slice(-4).join("\n");
				const content = snippet ? `\`\`\`\n${snippet.slice(0, 300)}\n\`\`\`` : '...';
				
				console.log(`[进度] ${phaseLabel} · ${time} snippet=${snippet.slice(0, 50)}`);
				
				wsClient.replyStream(
					frame,
					streamId,
					`**${phaseLabel} · ${time}**\n\n${content}`,
					false
				).catch((err) => {
					console.error('[进度更新失败]', err);
				});
			};
			
			// 启动回调：获取 session lock 后触发
			const onStart = () => {
				console.log('[启动] 获取 session lock，开始执行');
				wsClient.replyStream(frame, streamId, '⏳ 正在执行... · 0秒', false).catch((err) => {
					console.error('[启动通知失败]', err);
				});
			};
			
			const { result, quotaWarning } = await runAgent(workspace, message, session.agentId, {
				onSessionId: (sid) => {
					session.agentId = sid;
					setActiveSession(workspace, sid, message.slice(0, 40));
				},
				onProgress,
				onStart,
			});
			
			const elapsed = formatElapsed(Math.round((Date.now() - taskStart) / 1000));
			
			let cleanOutput = result.trim();
			if (quotaWarning) {
				cleanOutput = `${quotaWarning}\n\n---\n\n${cleanOutput}`;
			}
			
			// 记录 AI 回复
			if (memory) {
				memory.appendSessionLog(workspace, "assistant", cleanOutput.slice(0, 3000), config.CURSOR_MODEL);
			}
			
			// 发送最终结果
			const finalMessage = cleanOutput ? cleanOutput : '✅ 任务已完成（无输出）';
			const title = quotaWarning ? `⚠️ 完成 · ${elapsed}（已降级）` : `✅ 完成 · ${elapsed}`;
			
			await wsClient.replyStream(frame, streamId, `**${title}**\n\n---\n\n${finalMessage}`, true);
			
			console.log(`[完成] model=${quotaWarning ? 'auto' : config.CURSOR_MODEL} elapsed=${elapsed} (${result.length} chars)`);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			console.error(`[失败] ${msg.slice(0, 200)}`);
			
			await wsClient.replyStream(
				frame,
				streamId,
				`❌ **执行失败**\n\n\`\`\`\n${msg.slice(0, 500)}\n\`\`\`\n\n发送 \`/帮助\` 查看可用命令。`,
				true
			);
		} finally {
			busySessions.delete(lockKey);
		}
		
	} catch (error) {
		console.error('[消息处理失败]', error);
	}
});

// ── 定时任务调度器 ────────────────────────────────
// Bug #12 修复：将 scheduler 定义移到 SIGINT 之前
const cronStorePath = resolve(ROOT, 'cron-jobs-wecom.json');
const scheduler = new Scheduler({
	storePath: cronStorePath,
	defaultWorkspace,
	onExecute: async (job: CronJob) => {
		console.log(`[定时] 触发任务: ${job.name}`);
		return { status: 'ok' as const, result: job.message };
	},
	onDelivery: async (job: CronJob, result: string) => {
		// 只推送企业微信平台的任务
		if (job.platform && job.platform !== 'wecom') {
			console.log(`[定时] 任务 ${job.name} 属于 ${job.platform}，跳过企业微信推送`);
			return;
		}
		
		// 优先使用任务中保存的 webhook（chatid），否则使用最近活跃会话
		let chatid: string | undefined;
		
		if (job.webhook) {
			chatid = job.webhook;
		} else if (lastActiveSession) {
			chatid = lastActiveSession.chatid;
		}
		
		if (!chatid) {
			console.warn("[定时] 无活跃会话，跳过推送");
			return;
		}
		
		try {
			await wsClient.sendMessage(chatid, {
				msgtype: 'markdown',
				markdown: {
					content: `⏰ **定时任务：${job.name}**\n\n${result.slice(0, 3000)}`,
				},
			});
			console.log(`[定时] 任务结果已推送到 chatid=${chatid.slice(0, 8)}...`);
		} catch (err) {
			console.error('[定时] 推送失败:', err);
		}
	},
	log: (msg: string) => console.log(`[调度] ${msg}`),
});

console.log('[调度] 正在启动 Scheduler...');
scheduler.start().catch((err) => {
	console.error('[调度] 启动失败:', err);
});

// ── 启动心跳系统 ──────────────────────────────────
heartbeat.start();
console.log(`[心跳] 已启动，默认关闭（发送 /心跳 开启）`);

// 连接
wsClient.connect();
console.log('[企业微信] 正在连接 WebSocket...');

// 优雅退出
process.on('SIGINT', async () => {
	console.log('\n[退出] 正在清理资源...');
	
	// Bug #13 修复：终止所有运行中的 Agent 进程
	if (activeAgents.size > 0) {
		console.log(`[退出] 正在终止 ${activeAgents.size} 个运行中的任务...`);
		for (const [lockKey, agent] of activeAgents.entries()) {
			try {
				agent.kill('SIGTERM');
				console.log(`[退出] 已终止任务: ${lockKey}`);
			} catch (err) {
				console.error(`[退出] 终止任务失败 ${lockKey}:`, err);
			}
		}
		activeAgents.clear();
		busySessions.clear();
	}
	
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
	
	// 断开 WebSocket
	wsClient.disconnect();
	
	console.log('[退出] 清理完成，再见！');
	process.exit(0);
});
