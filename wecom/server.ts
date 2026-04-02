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
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, watchFile, unwatchFile, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Scheduler, type CronJob } from '../shared/scheduler.js';
import { MemoryManager } from '../shared/memory.js';
import { HeartbeatRunner } from '../shared/heartbeat.js';
import { FeilianController, type OperationResult } from '../shared/feilian-control.js';
import { fetchNews } from '../shared/news-fetcher.js';
import { getHealthStatus } from '../shared/news-sources/monitoring.js';
import { humanizeCronInChinese } from 'cron-chinese';
import { CommandHandler, type PlatformAdapter, type CommandContext } from '../shared/command-handler.js';
import { AgentExecutor } from '../shared/agent-executor.js';
import { ProcessLock } from '../shared/process-lock.js';
// import { ReconnectManager } from '../shared/reconnect-manager.js';  // 已移除，SDK 自带重连
import {
	getSession, setActiveSession, archiveAndResetSession,
	getSessionHistory, getActiveSessionId, switchToSession, getLockKey, busySessions,
	describeToolCall, buildToolSummary, resolveWorkspace, detectRouteIntent,
	loadSessionsFromDisk, saveSessions, sessionsStore,
	getCurrentProject, setCurrentProject,
} from './wecom-helper.js';
import { getAvailableModelChain, shouldFallback, isQuotaExhausted, addToBlacklist, isBlacklisted, DEFAULT_MODEL } from '../shared/models-config.js';

// ── 进程锁（防止多实例运行）──────────────────────
const processLock = new ProcessLock("wecom");
if (!processLock.acquire()) {
	console.error("\n❌ 企业微信服务已在运行，无法启动第二个实例");
	console.error("💡 如需重启，请先停止现有进程: bash service.sh restart");
	process.exit(1);
}

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

// Bug #22 修复：添加配置加载错误处理
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

// Bug 修复：添加 projects.json 热更新监听（与钉钉/飞书对齐）
watchFile(PROJECTS_PATH, { interval: 5000 }, () => {
	try {
		const newConfig = JSON.parse(readFileSync(PROJECTS_PATH, 'utf-8'));
		Object.assign(projectsConfig, newConfig);
		console.log(`[热更新] projects.json 已重新加载`);
	} catch (err) {
		console.error('[热更新] projects.json 加载失败:', err);
	}
});

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

// 统一 Agent 执行器（超时保护、并发限制、僵尸清理）
const agentExecutor = new AgentExecutor({
	timeout: 60 * 60 * 1000, // 60 分钟（统一超时）
	maxConcurrent: 10, // 提高并发限制
});

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
		platform?: string;
		webhook?: string;
		onSessionId?: (sessionId: string) => void;
		onProgress?: (progress: AgentProgress) => void;
		onStart?: () => void;
	}
): Promise<RunAgentResult> {
	const primaryModel = config.CURSOR_MODEL || DEFAULT_MODEL;

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
		try {
			const result = await agentExecutor.execute({
				workspace,
				model,
				prompt: message,
				sessionId: agentId,
				platform: context?.platform as 'wecom' | undefined,
				webhook: context?.webhook,
				onProgress: context?.onProgress,
				onStart: context?.onStart,
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

// ── 定时任务文件位置修正 ─────────────────────────
async function fixCronJobsLocation(workspace: string, webhook: string) {
	// 检查工作区是否有 cron-jobs.json（错误位置）
	const wrongPath = resolve(workspace, 'cron-jobs.json');
	const correctPath = resolve(ROOT, 'cron-jobs-wecom.json');

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
			if (job.platform && job.platform !== 'wecom') {
				console.log(`[修正] 跳过 ${job.platform} 平台的任务: ${job.name}`);
				continue;
			}

			// 添加缺失的 platform 和 webhook 字段
			if (!job.platform) {
				job.platform = 'wecom';
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

// 启动前校验：检查配置是否有效（不是空值或占位符）
function isValidConfig(value: string | undefined): boolean {
	if (!value?.trim()) return false;
	const placeholders = ['your_wecom_bot_id', 'your_wecom_bot_secret', 'your_bot_id', 'your_secret'];
	return !placeholders.includes(value.toLowerCase().trim());
}

if (!isValidConfig(config.WECOM_BOT_ID) || !isValidConfig(config.WECOM_BOT_SECRET)) {
	console.error('\n┌──────────────────────────────────────────────────┐');
	console.error('│  ⚠️  企业微信机器人未正确配置，服务不会启动      │');
	console.error('└──────────────────────────────────────────────────┘\n');
	console.error('如需使用企业微信集成，请在 wecom/.env 中配置:');
	console.error('  1. 复制模板: cp wecom/.env.example wecom/.env');
	console.error('  2. 编辑 .env 文件，填入真实的机器人凭据:');
	console.error('     WECOM_BOT_ID=your_actual_bot_id');
	console.error('     WECOM_BOT_SECRET=your_actual_bot_secret');
	console.error('\n如不需要企业微信集成，可以忽略此提示。\n');
	process.exit(0); // 使用 exit(0) 表示正常退出，不是错误
}

const wsClient = new AiBot.WSClient({
	botId: config.WECOM_BOT_ID,
	secret: config.WECOM_BOT_SECRET,
});

// 使用重连管理器启动企业微信连接
const reconnectManager = new ReconnectManager({
	maxRetries: 10,
	backoffDelays: [1, 2, 5, 10, 30, 60], // 秒
});

// ── 事件监听 ─────────────────────────────────────
wsClient.on('authenticated', () => {
	console.log('🔐 [企业微信] WebSocket 认证成功');
});

wsClient.on('disconnected', async (reason) => {
	console.warn(`⚠️  [企业微信] 连接断开: ${reason || '未知原因'}`);
	// SDK 会自动重连，无需手动干预
	console.log('[企业微信] SDK 将自动重连...');
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
	
	// === 命令系统（使用统一的 CommandHandler）===
	
	// 创建企业微信平台适配器
	const wecomAdapter: PlatformAdapter = {
		reply: async (content: string, options?: { title?: string; color?: string }) => {
			await wsClient.reply(frame, {
				msgtype: 'markdown',
				markdown: { content },
			});
		},
	replyStream: async (content: string, finish: boolean) => {
		const streamId = generateReqId('stream');
		await wsClient.replyStream(frame, streamId, content, finish);
	},
	sendFile: async (filePath: string, fileName?: string) => {
		const buffer = readFileSync(filePath);
		const result = await wsClient.uploadMedia(buffer, {
			type: 'file',
			filename: fileName || filePath.split('/').pop() || 'file',
		});
		await wsClient.replyMedia(frame, 'file', result.media_id);
	},
	};
	
	// 创建命令上下文
	const commandContext: CommandContext = {
		platform: 'wecom',
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
	const commandHandler = new CommandHandler(wecomAdapter, commandContext);
	
	// 尝试路由到命令处理器
	const handled = await commandHandler.route(text, (newSessionId: string) => {
		session.agentId = newSessionId;
	});
	
	if (handled) {
		console.log('[命令] 已通过统一处理器处理');
		return;
	}
	
	// === 以下是平台特定命令（需要群聊保护或特殊逻辑）===
	
	// /apikey、/密钥 → 群聊保护（企业微信特定：需要在群聊中阻止）
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
		// 私聊模式：委托给统一处理器（不需要更新 session，传递空回调保持一致性）
		const handled = await commandHandler.route(text, () => {});
		if (handled) return;
	}
		
		// 检测相对时间新闻推送（X分钟后推送热点、X小时后推送新闻）
		const relativeNewsMatch = text.match(/(\d+)\s*(分钟|小时)(?:[后以]后|后)\s*(?:推送|发送)?\s*(?:前|top)?\s*(\d+)?\s*条?\s*(?:今日)?\s*(热点|新闻|热榜)/i);
		if (relativeNewsMatch) {
			const [, numStr, unit, topNStr, _] = relativeNewsMatch;
			const num = parseInt(numStr, 10);
			const topN = topNStr ? Math.min(50, Math.max(1, parseInt(topNStr, 10))) : 15;
			const minutes = unit === '小时' ? num * 60 : num;
			const runAtMs = Date.now() + minutes * 60 * 1000;
			const runAt = new Date(runAtMs);
			const timeDesc = `${num}${unit}后（${runAt.toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' })}）`;

			const message = JSON.stringify({ type: "fetch-news", options: { topN } });
			try {
				await scheduler.add({
					name: "热点新闻推送",
					enabled: true,
					deleteAfterRun: true, // 相对时间任务执行一次后删除
					schedule: { kind: "at", at: runAt.toISOString() },
					message,
					platform: "wecom",
					webhook: chatid,
				});
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: `✅ 已创建定时任务\n\n⏰ 执行时间：${timeDesc}\n📰 推送内容：今日热点新闻（前 ${topN} 条）\n📱 到时会通过**企业微信**提醒你\n\n发送 \`/任务\` 可查看所有任务`,
					},
				});
				console.log(`[定时] 创建新闻推送任务: ${timeDesc}`);
			} catch (error) {
				console.error('[定时] 创建任务失败', error);
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: `❌ 创建定时任务失败\n\n${error instanceof Error ? error.message : String(error)}`,
					},
				});
			}
			return;
		}

		// 检测新闻推送定时请求（每天/每日 早上/上午 9点 推送热点、明天上午10点推送新闻）
		const newsScheduleMatch = text.match(/(每天|每日|明天)\s*(早上|上午|下午)?\s*([0-9一二三四五六七八九十]+)\s*[点时]?\s*(?:给我)?\s*(?:推送|发送)?\s*(?:下|今日)?\s*(热点|新闻|热榜)/i);
		if (newsScheduleMatch) {
			const [, when, ap, hourStr, _] = newsScheduleMatch;
			const numMap: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
			const toNum = (s: string) => (numMap[s] ?? parseInt(s, 10)) || 9;
			let topN = 15;
			const topMatch = text.match(/(?:推送|前)\s*(\d+)\s*条/i);
			if (topMatch) topN = Math.min(50, Math.max(1, parseInt(topMatch[1], 10)));
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
			try {
				await scheduler.add({
					name: "热点新闻推送",
					enabled: true,
					deleteAfterRun: false,
					schedule,
					message,
					platform: "wecom",
					webhook: chatid,
				});
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: `✅ 已创建定时任务\n\n⏰ 执行时间：${timeDesc}\n📰 推送内容：今日热点新闻（前 ${topN} 条）\n📱 到时会通过**企业微信**提醒你\n\n发送 \`/任务\` 可查看所有任务`,
					},
				});
				console.log(`[定时] 创建新闻推送任务: ${timeDesc}`);
			} catch (error) {
				console.error('[定时] 创建任务失败', error);
				await wsClient.reply(frame, {
					msgtype: 'markdown',
					markdown: {
						content: `❌ 创建定时任务失败\n\n${error instanceof Error ? error.message : String(error)}`,
					},
				});
			}
			return;
		}
		
		// 项目路由（Bug #23 修复: 传入 defaultWorkspace）
		const { workspace, message, label, routeChanged, intent } = resolveWorkspace(
			text,
			projectsConfig.projects,
			projectsConfig.default_project,
			defaultWorkspace
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
			
			// Bug #23 修复: 更新 sessionsStore 而不是 session（持久化存储）
			setCurrentProject(defaultWorkspace, intent.project);
			
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
	
	// 检查路由后的 message 是否还是命令（处理 "项目名:/命令" 格式）
	if (message !== text) {
		const routedHandled = await commandHandler.route(message, (newSessionId: string) => {
			session.agentId = newSessionId;
		});
		if (routedHandled) {
			console.log('[命令] 路由后的命令已通过统一处理器处理');
			return;
		}
	}
	
	// 未知指令 → 友好提示
	if (message.startsWith('/')) {
		const cmd = message.split(/[\s:：]/)[0];
		await wsClient.reply(frame, {
			msgtype: 'markdown',
			markdown: {
				content: `未知指令 \`${cmd}\`\n\n发送 \`/帮助\` 查看所有可用指令。`,
			},
		});
		return;
	}
	
	// 并发控制（最多等待 5 分钟）
	let lockKey = getLockKey(workspace);
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
		
		// Bug #21 修复：将 busySessions.add 移入 try 块，确保 finally 一定执行
		const streamId = generateReqId('stream');
		try {
			busySessions.add(lockKey);
			
			// 流式回复
			await wsClient.replyStream(frame, streamId, '⏳ Cursor AI 正在思考...', false);
			
			// 记录用户消息
			if (memory) {
				memory.appendSessionLog(workspace, "user", message, config.CURSOR_MODEL);
			}
			
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
				platform: 'wecom',
				webhook: chatid,
				onSessionId: (sid) => {
					session.agentId = sid;
					setActiveSession(workspace, sid, message.slice(0, 40));
					// Bug 修复: sessionId 创建后，需更新 busySessions 的 key
					const oldLockKey = lockKey;
					const newLockKey = `session:${sid}`;
					if (oldLockKey !== newLockKey && busySessions.has(oldLockKey)) {
						busySessions.delete(oldLockKey);
						busySessions.add(newLockKey);
						lockKey = newLockKey;
						console.log(`[lockKey] 更新: ${oldLockKey} → ${newLockKey}`);
					}
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

		// Agent 可能修改了 cron-jobs，检查并修正位置
		await fixCronJobsLocation(workspace, chatid);

		// 重新加载调度器
		scheduler.reload().catch(() => {});
		
		// 发送最终结果
		const finalMessage = cleanOutput ? cleanOutput : '✅ 任务已完成（无输出）';
		const title = quotaWarning ? `⚠️ 完成 · ${elapsed}（已降级）` : `✅ 完成 · ${elapsed}`;
		
		await wsClient.replyStream(frame, streamId, `**${title}**\n\n---\n\n${finalMessage}`, true);
		
		console.log(`[完成] model=${quotaWarning ? 'auto' : config.CURSOR_MODEL} elapsed=${elapsed} (${result.length} chars)`);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			
			// 手动终止的任务不需要发送错误消息（用户已经收到"已终止"的回复）
			if (msg === 'MANUALLY_STOPPED') {
				console.log(`[手动终止] workspace=${workspace} lockKey=${lockKey}`);
			} else {
				console.error(`[失败] ${msg.slice(0, 200)}`);
				
				await wsClient.replyStream(
					frame,
					streamId,
					`❌ **执行失败**\n\n\`\`\`\n${msg.slice(0, 500)}\n\`\`\`\n\n发送 \`/帮助\` 查看可用命令。`,
					true
				);
			}
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
		// 新格式：优先使用 task 字段
		if (job.task) {
			switch (job.task.type) {
				case 'fetch-news': {
					const topN = job.task.options?.topN ?? 15;
					console.log(`[scheduler] fetching news (新格式), topN=${topN}`);
					const { messages } = await fetchNews({ topN, platform: "wecom" });
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
						const model = job.model || config.CURSOR_MODEL || DEFAULT_MODEL;
						
						const { result } = await runAgent(workspace, job.task.prompt, {
							skipStreaming: true
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
				const { messages } = await fetchNews({ topN, platform: "wecom" });
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
				const model = job.model || config.CURSOR_MODEL || DEFAULT_MODEL;
				
				const { result } = await runAgent(workspace, parsed.prompt, {
					skipStreaming: true
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
		console.log(`[定时] 触发任务: ${job.name}`);
		return { status: 'ok' as const, result: msg };
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
			// 检查是否为新闻推送任务（分批消息）
			let chunks: string[];
			try {
				const parsed = JSON.parse(result) as { chunks?: string[] };
				chunks = parsed.chunks || [result];
			} catch {
				chunks = [result];
			}

			// 发送消息（支持分批）
		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			if (!chunk) continue;
			
			const title = chunks.length > 1 
				? `⏰ **${job.name}** (${i + 1}/${chunks.length})`
				: `⏰ **定时任务：${job.name}**`;
			
			await wsClient.sendMessage(chatid, {
				msgtype: 'markdown',
				markdown: {
					content: `${title}\n\n${chunk.slice(0, 3000)}`,
				},
			});
				
				// 分批发送时添加短暂延迟，避免消息发送过快
				if (i < chunks.length - 1) {
					await new Promise(r => setTimeout(r, 500));
				}
			}
			console.log(`[定时] 任务结果已推送到 chatid=${chatid.slice(0, 8)}... (${chunks.length} 条消息)`);
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

// ── 启动自检（.cursor/BOOT.md）───────────────────────
// 已禁用：agent 进程初始化太慢，会阻塞启动
console.log("[启动] BOOT.md 自检已禁用（避免启动阻塞）");

// 启动企业微信 WebSocket，简单重试 3 次，之后由 SDK 自己管理重连
let startRetries = 3;
while (startRetries > 0) {
	try {
		wsClient.connect();
		// 等待认证成功
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error('连接超时')), 10000);
			wsClient.once('authenticated', () => {
				clearTimeout(timeout);
				resolve();
			});
			wsClient.once('error', (err) => {
				clearTimeout(timeout);
				reject(err);
			});
		});
		console.log('✅ 企业微信 WebSocket 已连接（SDK 自动管理重连）');
		break;
	} catch (err) {
		startRetries--;
		const errMsg = err instanceof Error ? err.message : String(err);
		if (startRetries === 0) {
			console.error('❌ 企业微信连接启动失败（已重试 3 次）:', errMsg);
			console.error('请检查网络连接和企业微信凭据（WECOM_BOT_ID / WECOM_BOT_SECRET）');
			process.exit(1);
		}
		console.warn(`[企业微信] 连接失败，5秒后重试 (剩余 ${startRetries} 次): ${errMsg}`);
		await new Promise(r => setTimeout(r, 5000));
	}
}

// 优雅退出
process.on('SIGINT', async () => {
	console.log('\n[退出] 正在清理资源...');

	// Bug #13 修复：终止所有运行中的 Agent 进程（使用统一执行器）
	const active = agentExecutor.getActiveAgents();
	if (active.length > 0) {
		console.log(`[退出] 正在终止 ${active.length} 个运行中的任务...`);
		agentExecutor.killAll();
		busySessions.clear();
	}

	// Bug #20 修复：停止文件监听器
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
	
	// 断开 WebSocket
	wsClient.disconnect();
	
	console.log('[退出] 清理完成，再见！');
	process.exit(0);
});
