/**
 * 统一 Agent 执行器
 * 
 * 四平台（飞书/钉钉/企微/微信）共用的 Cursor Agent CLI 执行器
 * 提供：超时保护、并发限制、僵尸清理、进度回调
 */

import { spawn, type ChildProcess } from 'child_process';
import { resolve as pathResolve, basename } from 'path';
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';

/** 从各平台子目录启动时 cwd 在 feishu|dingtalk|wecom|wechat，定时任务 JSON 应在仓库根目录 */
const CRON_JSON_AT_REPO_ROOT = new Set(['feishu', 'dingtalk', 'wecom', 'wechat']);

function resolveCronJobsJsonPath(platform: string): string {
	const name = `cron-jobs-${platform}.json`;
	const cwd = process.cwd();
	if (CRON_JSON_AT_REPO_ROOT.has(basename(cwd))) {
		return pathResolve(cwd, '..', name);
	}
	return pathResolve(cwd, name);
}

const AGENT_BIN = process.env.AGENT_BIN || pathResolve(process.env.HOME || '', '.local/bin/agent');
const DEFAULT_TIMEOUT = 30 * 60 * 1000; // 30 分钟（平衡执行时间和防卡死）
const DEFAULT_MAX_CONCURRENT = 10; // 最多 10 个并发任务
const PROGRESS_INTERVAL = 2000; // 2 秒

// 全局状态
const activeAgents = new Map<string, AgentProcessInfo>();

interface AgentProcessInfo {
	pid: number;
	kill: () => void;
	workspace: string;
	startTime: number;
	abort: () => void; // 立即中止并 reject Promise
}

export interface FeedbackGateRequest {
	triggerId: string;
	message: string;
	title: string;
	context: string;
	urgent: boolean;
	triggerFilePath: string;
	routing: { chat_id?: string; platform?: string };
	agentOutput?: string;
}

export interface AgentExecutorOptions {
	workspace: string;
	model: string;
	prompt: string;
	sessionId?: string;
	platform?: 'feishu' | 'dingtalk' | 'wecom' | 'wechat';
	webhook?: string;
	
	// 回调函数
	onProgress?: (progress: AgentProgress) => void;
	onStart?: () => void;
	onFeedbackRequested?: (req: FeedbackGateRequest) => void;
	
	// Feedback Gate 配置
	feedbackGate?: {
		chatId?: string;
		platform?: string;
		enabledModel?: string;
	};
	
	// 可选配置
	timeout?: number;
	apiKey?: string;
}

export interface AgentProgress {
	elapsed: number;
	phase: 'thinking' | 'tool_call' | 'responding';
	snippet: string;
}

export interface AgentResult {
	result: string;
	sessionId?: string;
	toolSummary?: string[];
}

interface AgentEnv extends NodeJS.ProcessEnv {
	CURSOR_API_KEY?: string;
	CURSOR_PLATFORM?: string;
	CURSOR_WEBHOOK?: string;
	CURSOR_CRON_FILE?: string;
	FEEDBACK_GATE_CHAT_ID?: string;
	FEEDBACK_GATE_PLATFORM?: string;
	FEEDBACK_GATE_MODEL?: string;
	FEEDBACK_GATE_ROUTING_FILE?: string;
}

// Watchdog 单例控制
let watchdogStarted = false;

export class AgentExecutor {
	private timeout: number;
	private maxConcurrent: number;
	
	constructor(opts?: { timeout?: number; maxConcurrent?: number }) {
		this.timeout = opts?.timeout || DEFAULT_TIMEOUT;
		this.maxConcurrent = opts?.maxConcurrent || DEFAULT_MAX_CONCURRENT;
		
		// 启动 Watchdog（全局单例）
		if (!watchdogStarted) {
			this.startWatchdog();
			watchdogStarted = true;
		}
	}
	
	async execute(options: AgentExecutorOptions): Promise<AgentResult> {
		// 1. 并发限制
		if (activeAgents.size >= this.maxConcurrent) {
			throw new Error(`并发任务数已达上限 (${this.maxConcurrent})，请稍后再试或使用 /终止 命令停止其他任务`);
		}
		
		// 1.5 workspace：禁止 undefined/null/字面量 "undefined" 传入 spawn（会被转成路径 .../wechat/undefined）
		const rawWs = options.workspace;
		if (rawWs == null || typeof rawWs !== 'string' || rawWs.trim() === '' || rawWs.trim() === 'undefined') {
			throw new Error(
				`Workspace 无效（${String(rawWs)}）。请检查 projects.json 中 default_project 是否对应有效 path。`
			);
		}
		const workspaceAbs = pathResolve(rawWs.trim());
		
		// 2. 构建 CLI 参数
		const args = [
			'-p', '--force', '--trust', '--approve-mcps',
			'--workspace', workspaceAbs,
			'--model', options.model,
			'--output-format', 'stream-json',
			'--stream-partial-output',
		];
		
		if (options.sessionId) {
			args.push('--resume', options.sessionId);
		}
		args.push('--', options.prompt);
		
		// 3. 构建环境变量
		const env: AgentEnv = { 
			...process.env,
		};
		
		if (options.apiKey) {
			env.CURSOR_API_KEY = options.apiKey;
		}
		
		if (options.platform) {
			env.CURSOR_PLATFORM = options.platform;
		}
		if (options.webhook) {
			env.CURSOR_WEBHOOK = options.webhook;
		}
		
		// 设置定时任务文件路径（与各平台 server 中 resolve(ROOT, ...) 一致，避免 cwd 在子目录时指错文件）
		if (options.platform) {
			env.CURSOR_CRON_FILE = resolveCronJobsJsonPath(options.platform);
		}
		
		// Feedback Gate: inject env vars so the Python MCP can build routing info
		if (options.feedbackGate) {
			const fg = options.feedbackGate;
			if (fg.chatId) env.FEEDBACK_GATE_CHAT_ID = fg.chatId;
			if (fg.platform) env.FEEDBACK_GATE_PLATFORM = fg.platform;
			if (fg.enabledModel) env.FEEDBACK_GATE_MODEL = fg.enabledModel;
		}
		
		// 4. Write routing file for Feedback Gate (Python MCP reads this since it doesn't inherit our env)
		//    File name includes a session token so other MCP instances (e.g. from Cursor IDE)
		//    won't accidentally read it — they only check the generic 'feedback_gate_routing.json'.
		let routingFilePath: string | null = null;
		const fgSessionToken = options.feedbackGate?.chatId ? randomUUID().slice(0, 8) : '';
		if (options.feedbackGate?.chatId) {
			const tmpDir = process.platform === 'win32' ? (process.env.TEMP || 'C:\\Temp') : '/tmp';
			
			// Clean up stale feedback gate files from previous sessions
			try {
				for (const f of readdirSync(tmpDir)) {
					if (
						f.startsWith('feedback_gate_response_') ||
						f.startsWith('feedback_gate_ack_') ||
						f.startsWith('feedback_gate_routing_') ||
						f === 'feedback_gate_response.json' ||
						f === 'feedback_gate_routing.json' ||
						f === 'mcp_response.json'
					) {
						try { unlinkSync(pathResolve(tmpDir, f)); } catch {}
					}
				}
				console.log('[FeedbackGate] Cleaned up stale response/ack/routing files');
			} catch {}
			
			const routingData = {
				chat_id: options.feedbackGate.chatId,
				platform: options.feedbackGate.platform || '',
				model: options.feedbackGate.enabledModel || '',
				session: fgSessionToken,
				timestamp: new Date().toISOString(),
			};
			// Write both session-specific and generic routing files:
			// - Session-specific: passed via env, only our MCP reads it
			// - Generic: fallback if env inheritance fails (all MCP instances can read it,
			//   but PPID check in trigger consumer prevents cross-instance consumption)
			const sessionSpecificPath = pathResolve(tmpDir, `feedback_gate_routing_${fgSessionToken}.json`);
			const genericPath = pathResolve(tmpDir, 'feedback_gate_routing.json');
			writeFileSync(sessionSpecificPath, JSON.stringify(routingData, null, 2));
			writeFileSync(genericPath, JSON.stringify(routingData, null, 2));
			routingFilePath = sessionSpecificPath;
			env.FEEDBACK_GATE_ROUTING_FILE = sessionSpecificPath;
			console.log(`[FeedbackGate] Routing files written: session=${fgSessionToken}`);
		}
		
		// 5. 启动进程
		console.log(`[AgentExecutor] Spawning: ${AGENT_BIN} args=[${args.slice(0, 6).join(', ')}...] workspace=${workspaceAbs}`);
		return new Promise((resolve, reject) => {
			const child = spawn(AGENT_BIN, args, {
				env,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			
			if (!child.pid) {
				console.error(`[AgentExecutor] spawn 失败: child.pid is falsy`);
				reject(new Error('Agent 进程启动失败'));
				return;
			}
			console.log(`[AgentExecutor] Process started pid=${child.pid}`);
			
			const lockKey = `${workspaceAbs}:${child.pid}`;
			const startTime = Date.now();
			let done = false;
			let manuallyKilled = false;
			let progressTimer: NodeJS.Timeout | null = null;
			let timeoutTimer: NodeJS.Timeout | null = null;
			let feedbackGateTimer: NodeJS.Timeout | null = null;
			let feedbackGateActive = false;
			
			const cleanup = () => {
				done = true;
				activeAgents.delete(lockKey);
				if (progressTimer) clearInterval(progressTimer);
				if (timeoutTimer) clearTimeout(timeoutTimer);
				if (feedbackGateTimer) clearInterval(feedbackGateTimer);
			};
			
			// 注册进程
			activeAgents.set(lockKey, {
				pid: child.pid,
				kill: () => { 
					try { 
						// 先尝试 SIGTERM，如果进程还在，再用 SIGKILL 强制终止
						child.kill('SIGTERM');
						setTimeout(() => {
							try {
								// 检查进程是否还在
								process.kill(child.pid!, 0);
								// 如果还在，用 SIGKILL 强制终止
								console.log(`[AgentExecutor] 进程未响应 SIGTERM，使用 SIGKILL 强制终止 pid=${child.pid}`);
								child.kill('SIGKILL');
							} catch {
								// 进程已经不存在了，忽略
							}
						}, 500); // 500ms 后检查
					} catch {} 
				},
				abort: () => {
					// 立即中止并 reject Promise
					if (done) return;
					manuallyKilled = true;
					console.log(`[AgentExecutor] 手动终止任务 ${lockKey}`);
					cleanup();
					try {
						child.kill('SIGKILL'); // 直接用 SIGKILL 强制终止
					} catch {}
					reject(new Error('MANUALLY_STOPPED')); // 特殊标记，告诉调用方这是手动终止
				},
				workspace: workspaceAbs,
				startTime,
			});
			
			// 超时保护
			timeoutTimer = setTimeout(() => {
				if (done) return;
				const elapsed = Math.round((Date.now() - startTime) / 1000 / 60);
				console.error(`[AgentExecutor] 超时终止 (${elapsed}分钟)`, lockKey);
				cleanup();
				try {
					child.kill('SIGKILL');
				} catch (e) {
					console.error('[AgentExecutor] 终止进程失败:', e);
				}
				reject(new Error(`Agent运行超时 (${elapsed}分钟)，已强制终止。如需更长时间，请分批处理或使用 /终止 手动停止。`));
			}, this.timeout);
			
		// 状态收集
		let stderr = '';
		let resultText = '';
		let sessionId: string | undefined = options.sessionId;
		let assistantBuf = '';
		let lastSegment = '';
		let toolSummary: string[] = [];
		let lineBuf = '';
		let phase: AgentProgress['phase'] = 'thinking';
		let lastProgressTime = 0;
		let sessionLockAcquired = false;
		let lastOutputTime = Date.now(); // 追踪最后一次输出时间
			
		// 进度更新 + 无输出超时检测定时器
		const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 分钟无输出超时
		progressTimer = setInterval(() => {
			if (done) return;
			const now = Date.now();
			
			// 检查是否长时间无输出（可能卡住）— feedback gate 等待中豁免
			const idleTime = now - lastOutputTime;
			if (idleTime > IDLE_TIMEOUT && !feedbackGateActive) {
				console.warn(`[AgentExecutor] 进程 ${Math.floor(idleTime / 1000 / 60)} 分钟无输出，可能卡住，强制终止 ${lockKey}`);
				cleanup();
				try {
					child.kill('SIGKILL');
				} catch {}
				reject(new Error(`任务 ${Math.floor(idleTime / 1000 / 60)} 分钟无响应，已强制终止。可能原因：\n- 等待外部服务响应\n- 陷入死循环\n- 卡在用户输入`));
				return;
			}
			
			// 进度更新（feedback gate 激活时暂停）
			if (options.onProgress && now - lastProgressTime >= PROGRESS_INTERVAL && !feedbackGateActive) {
				lastProgressTime = now;
				options.onProgress({
					elapsed: Math.round((now - startTime) / 1000),
					phase,
					snippet: getSnippet(),
				});
			}
		}, 1000);
			
			function getSnippet(): string {
				const lines = assistantBuf.split('\n').filter(l => l.trim());
				return lines.slice(-4).join('\n') || '...';
			}
			
			// 解析输出
			function processLine(line: string) {
				try {
					const ev = JSON.parse(line);
					
					if (ev.session_id && !sessionId) {
						sessionId = ev.session_id;
						// 触发 onStart 回调（获取到 session lock 后）
						if (!sessionLockAcquired && options.onStart) {
							sessionLockAcquired = true;
							options.onStart();
						}
					}
					
					const prevPhase = phase;
					switch (ev.type) {
						case 'thinking':
							phase = 'thinking';
							break;
						
						case 'assistant':
							phase = 'responding';
							if (ev.message?.content) {
								for (const c of ev.message.content) {
									if (c.type === 'text' && c.text) {
										assistantBuf += c.text;
										lastSegment += c.text;
									}
								}
							}
							break;
						
					case 'tool_call':
						phase = 'tool_call';
						lastSegment = '';
						if (ev.tool_call && ev.subtype === 'started') {
							const desc = describeToolCall(ev.tool_call);
							toolSummary.push(desc);
						}
						if (ev.tool_call) {
							const toolName = Object.keys(ev.tool_call)[0] || '';
							if (toolName.includes('feedback_gate') || toolName.includes('callMcpTool')) {
								console.log(`[AgentExecutor] FG tool_call event: subtype=${ev.subtype} tool=${toolName} feedbackGateActive=${feedbackGateActive}`);
								if (ev.subtype === 'completed' && feedbackGateActive) {
									feedbackGateActive = false;
									console.log(`[FeedbackGate] Tool call completed, resuming progress updates`);
								}
							}
						}
						break;
						
					case 'result':
						if (ev.result != null) resultText = ev.result;
						if (ev.subtype === 'error' && ev.error) resultText = ev.error;
						console.log(`[AgentExecutor] Received result event: subtype=${ev.subtype} resultLen=${resultText.length} feedbackGateActive=${feedbackGateActive}`);
						break;
					}
					
					// 阶段切换时立即触发进度更新（feedback gate 激活时暂停）
					if (phase !== prevPhase && options.onProgress && !feedbackGateActive) {
						const now = Date.now();
						lastProgressTime = now;
						options.onProgress({
							elapsed: Math.round((now - startTime) / 1000),
							phase,
							snippet: getSnippet(),
						});
					}
				} catch (err) {
					// 忽略非 JSON 行
				}
			}
			
		// Feedback Gate: poll /tmp for trigger files that match our routing.
		// Two-layer filtering to avoid consuming triggers from IDE MCP instances:
		//   1. routing.session must match our fgSessionToken  (if present)
		//   2. trigger.ppid must equal our child.pid  (MCP's parent = our Agent CLI)
		if (options.feedbackGate?.chatId && options.onFeedbackRequested) {
			const fgChatId = options.feedbackGate.chatId;
			const fgPlatform = options.feedbackGate.platform || '';
			const tmpDir = process.platform === 'win32'
				? (process.env.TEMP || process.env.TMP || 'C:\\Temp')
				: '/tmp';
			const agentCliPid = child.pid!;
			
		feedbackGateTimer = setInterval(() => {
			if (done) return;
			try {
				const files = readdirSync(tmpDir).filter(f => f.startsWith('feedback_gate_trigger_pid') && f.endsWith('.json'));
				for (const file of files) {
					const fullPath = pathResolve(tmpDir, file);
					try {
						const content = readFileSync(fullPath, 'utf-8');
						const trigger = JSON.parse(content);
						const triggerPpid = trigger.ppid;
						if (triggerPpid && triggerPpid !== agentCliPid) {
							continue;
						}
						
						const routing = trigger.routing;
						if (routing) {
							if (routing.chat_id && routing.chat_id !== fgChatId) continue;
							if (fgPlatform && routing.platform && routing.platform !== fgPlatform) continue;
							if (fgSessionToken && routing.session && routing.session !== fgSessionToken) continue;
						} else if (!triggerPpid) {
							continue;
						}
							
						const data = trigger.data || {};
						const triggerId = data.trigger_id || '';
						feedbackGateActive = true;
						console.log(`[FeedbackGate] Trigger detected: ${triggerId} ppid=${triggerPpid} chatId=${fgChatId}`);
						
						// Delete trigger file to signal Python MCP that we consumed it
						try { unlinkSync(fullPath); } catch {}
						try { unlinkSync(pathResolve(tmpDir, 'feedback_gate_trigger.json')); } catch {}
						writeFeedbackGateAck(triggerId);
							
							options.onFeedbackRequested!({
								triggerId,
								message: data.message || '',
								title: data.title || 'Feedback Gate',
								context: data.context || '',
								urgent: data.urgent || false,
								triggerFilePath: fullPath,
								routing: { chat_id: fgChatId, platform: fgPlatform },
								agentOutput: assistantBuf.trim() || undefined,
							});
						} catch {
							// invalid file, skip
						}
					}
				} catch {
					// readdir failed, skip this cycle
				}
			}, 500);
		}
		
		// 监听输出
		child.stdout!.on('data', (chunk: Buffer) => {
			lastOutputTime = Date.now();
			if (feedbackGateActive) {
				// MCP 超时返回后 Agent 会继续输出，但 IM 用户可能还没回复
				// 不重置 feedbackGateActive，保持 idle timeout 豁免直到进程结束
				const rawChunk = chunk.toString().slice(0, 200);
				console.log(`[FeedbackGate] Agent resumed output while FG active (keeping active). First 200 chars: ${rawChunk}`);
			}
			lineBuf += chunk.toString();
			const lines = lineBuf.split('\n');
			lineBuf = lines.pop()!;
			for (const line of lines) processLine(line);
		});
			
			child.stderr!.on('data', (chunk: Buffer) => {
				const text = chunk.toString();
				stderr += text;
				if (text.trim()) {
					console.log(`[AgentExecutor] stderr: ${text.trim().slice(0, 300)}`);
				}
			});
			
			// 进程结束
			child.on('close', (code) => {
				const elapsed = Math.round((Date.now() - startTime) / 1000);
				console.log(`[AgentExecutor] Process closed: pid=${child.pid} code=${code} elapsed=${elapsed}s done=${done} manuallyKilled=${manuallyKilled}`);
				
				// 如果是手动终止，不需要处理输出（Promise 已经被 reject）
				if (manuallyKilled) {
					console.log(`[AgentExecutor] 进程 ${lockKey} 已被手动终止，跳过输出处理`);
					return;
				}
				
				if (done) return;
				
				cleanup();
				
				// 延迟 resolve，确保所有已调度的 timer 回调执行完毕
				setTimeout(() => {
					// 处理剩余输出
					if (lineBuf.trim()) processLine(lineBuf);
					
					// 构建最终结果
					const finalSegment = lastSegment.trim();
					const rawResultText = typeof resultText === 'string' ? resultText.trim() : '';
					const output = rawResultText || finalSegment || assistantBuf.trim() || stderr.trim() || '(无输出)';
					
					console.log(`[AgentExecutor] Final output: code=${code} resultText=${rawResultText.length}ch finalSegment=${finalSegment.length}ch assistantBuf=${assistantBuf.trim().length}ch stderr=${stderr.trim().length}ch sessionId=${sessionId}`);
					
					if (code === 0) {
						resolve({
							result: output,
							sessionId,
							toolSummary,
						});
					} else {
						console.error(`[AgentExecutor] Agent exited with code ${code}, stderr: ${stderr.slice(0, 500)}`);
						reject(new Error(`Agent exited with code ${code}\n${stderr}`));
					}
				}, 150);
			});
			
			// 启动失败
			child.on('error', (err) => {
				if (done) return;
				cleanup();
				console.error('[AgentExecutor] 子进程启动失败:', err);
				reject(new Error(`Agent CLI 启动失败: ${err.message}`));
			});
		});
	}
	
	// Watchdog：定期清理僵尸进程（只检查 Map 中记录的进程）
	private startWatchdog() {
		setInterval(() => {
			const now = Date.now();
			for (const [lockKey, agent] of activeAgents.entries()) {
				try {
					// 检查进程是否存活（signal 0 只检查，不真的杀）
					process.kill(agent.pid, 0);
					
					// 检查是否运行太久（双重保险，理论上不会到这里）
					if (now - agent.startTime > this.timeout * 1.2) {
						console.warn(`[Watchdog] 进程运行超时（${Math.round((now - agent.startTime) / 1000 / 60)}分钟），强制终止`, lockKey);
						agent.kill();
						activeAgents.delete(lockKey);
					}
				} catch (err) {
					// 进程已死，清理记录
					console.log(`[Watchdog] 清理僵尸进程记录 pid=${agent.pid} workspace=${agent.workspace}`);
					activeAgents.delete(lockKey);
				}
			}
		}, 30000); // 每 30 秒检查一次（更快发现僵尸进程）
	}
	
	// 获取当前活跃任务
	getActiveAgents() {
		return Array.from(activeAgents.entries()).map(([key, agent]) => ({
			key,
			pid: agent.pid,
			workspace: agent.workspace,
			runningTime: Math.round((Date.now() - agent.startTime) / 1000),
		}));
	}
	
	// 手动终止任务（按 workspace）
	killAgent(workspace: string): boolean {
		for (const [key, agent] of activeAgents.entries()) {
			if (agent.workspace === workspace) {
				console.log(`[AgentExecutor] 手动终止任务: ${key}`);
				agent.abort(); // 使用 abort 立即中止并 reject Promise
				return true;
			}
		}
		return false;
	}
	
	// 终止所有任务
	killAll() {
		console.log(`[AgentExecutor] 终止所有任务 (${activeAgents.size}个)`);
		for (const [key, agent] of activeAgents.entries()) {
			agent.abort(); // 使用 abort 立即中止并 reject Promise
		}
	}
}

// 工具调用描述
function describeToolCall(toolCall: any): string {
	const name = toolCall.name || toolCall.function?.name || '未知工具';
	const args = toolCall.arguments || toolCall.function?.arguments;
	
	if (name === 'Shell') {
		const cmd = args?.command || '';
		return `执行命令: ${cmd.slice(0, 80)}`;
	}
	if (name === 'Read') {
		const path = args?.path || '';
		const filename = path.split('/').pop() || path;
		return `读取文件: ${filename}`;
	}
	if (name === 'Write') {
		const path = args?.path || '';
		const filename = path.split('/').pop() || path;
		return `写入文件: ${filename}`;
	}
	if (name === 'StrReplace') {
		const path = args?.path || '';
		const filename = path.split('/').pop() || path;
		return `编辑文件: ${filename}`;
	}
	if (name === 'Grep') {
		const pattern = args?.pattern || '';
		return `搜索代码: ${pattern}`;
	}
	if (name === 'Glob') {
		const pattern = args?.glob_pattern || '';
		return `查找文件: ${pattern}`;
	}
	if (name === 'SemanticSearch') {
		const query = args?.query || '';
		return `语义搜索: ${query.slice(0, 50)}`;
	}
	
	return `调用工具: ${name}`;
}

/**
 * Write a response file that the Python MCP is polling for,
 * completing the feedback gate round-trip.
 */
export function writeFeedbackGateResponse(triggerId: string, userInput: string): void {
	const tmpDir = process.platform === 'win32'
		? (process.env.TEMP || process.env.TMP || 'C:\\Temp')
		: '/tmp';
	const responseFile = pathResolve(tmpDir, `feedback_gate_response_${triggerId}.json`);
	const data = {
		timestamp: new Date().toISOString(),
		trigger_id: triggerId,
		user_input: userInput,
		source: 'cursor-remote-control',
	};
	writeFileSync(responseFile, JSON.stringify(data, null, 2));
	console.log(`[FeedbackGate] Response written: ${responseFile}`);
}

/**
 * Write an acknowledgement file that the Python MCP checks
 * to confirm the extension/remote-control received the trigger.
 */
export function writeFeedbackGateAck(triggerId: string): void {
	const tmpDir = process.platform === 'win32'
		? (process.env.TEMP || process.env.TMP || 'C:\\Temp')
		: '/tmp';
	const ackFile = pathResolve(tmpDir, `feedback_gate_ack_${triggerId}.json`);
	const data = {
		timestamp: new Date().toISOString(),
		trigger_id: triggerId,
		acknowledged: true,
		source: 'cursor-remote-control',
	};
	writeFileSync(ackFile, JSON.stringify(data, null, 2));
	console.log(`[FeedbackGate] Ack written: ${ackFile}`);
}
