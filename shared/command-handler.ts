/**
 * 统一命令处理器 — 三平台共享
 *
 * 抽取飞书、钉钉、企业微信、个人微信的共同命令处理逻辑，
 * 通过适配器模式处理平台差异。
 */

import { resolve } from "node:path";
import { readFileSync, existsSync, statSync, appendFileSync, readdirSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import type { Scheduler } from "./scheduler.js";
import type { MemoryManager } from "./memory.js";
import type { HeartbeatRunner } from "./heartbeat.js";
import type { AgentExecutor } from "./agent-executor.js";
import { FeilianController, type OperationResult } from "./feilian-control.js";
import { fetchNews } from "./news-fetcher.js";
import { fetchWeather, getSupportedCities } from "./weather-fetcher.js";
import { fetchGithubTrending } from "./github-trending-fetcher.js";
import { getHealthStatus } from "./news-sources/monitoring.js";
import { humanizeCronInChinese } from "cron-chinese";
import { findModel, formatModelList, getModelChain, getBlacklistStatus, resetBlacklist, getDefaultModel } from "./models-config.js";

const HOME = process.env.HOME!;

// ──────────────────────────────────────────────────
// 平台适配器接口
// ──────────────────────────────────────────────────

export interface PlatformAdapter {
	/** 发送普通回复 */
	reply(content: string, options?: { title?: string; color?: string }): Promise<void>;

	/** 发送流式回复（如果平台支持） */
	replyStream?(content: string, finish: boolean): Promise<void>;

	/** 发送文件 */
	sendFile?(filePath: string, fileName?: string): Promise<void>;
}

// ──────────────────────────────────────────────────
// 命令上下文
// ──────────────────────────────────────────────────

export interface CommandContext {
	platform: "feishu" | "dingtalk" | "wecom" | "wechat" | "telegram";
	projectsConfig: any;
	defaultWorkspace: string;
	memoryWorkspace: string;
	config: any;
	scheduler: Scheduler;
	memory: MemoryManager | null;
	heartbeat: HeartbeatRunner;
	busySessions: Set<string>;
	sessionsStore: Map<string, any>;
	getCurrentProject: (defaultWs: string) => string | null;
	getLockKey: (workspace: string) => string;
	archiveAndResetSession: (workspace: string) => void;
	getSessionHistory: (workspace: string, limit?: number) => any[];
	getActiveSessionId: (workspace: string) => string | null;
	switchToSession: (workspace: string, sessionId: string) => boolean;
	rootDir: string;
	agentExecutor?: AgentExecutor; // 统一 Agent 执行器
}

// ──────────────────────────────────────────────────
// 工具函数
// ──────────────────────────────────────────────────

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

/**
 * 解析中文时间调度文本，返回 cron 表达式和剩余文本。
 * 支持格式：每天10点、每天9:30、每天上午10点、工作日8点、每小时等
 * 返回 null 表示未检测到调度语法。
 */
function parseChineseSchedule(text: string): { cronExpr: string; label: string; remaining: string } | null {
	const patterns: { regex: RegExp; toCron: (m: RegExpMatchArray) => { expr: string; label: string } }[] = [
		{
			regex: /(?:每天|每日)\s*(?:上午|早上|am)?\s*(\d{1,2})[点时:：](\d{1,2})?/i,
			toCron: (m) => {
				const h = parseInt(m[1]!, 10);
				const min = m[2] ? parseInt(m[2], 10) : 0;
				return { expr: `${min} ${h} * * *`, label: `每天${h}:${String(min).padStart(2, '0')}` };
			}
		},
		{
			regex: /(?:每天|每日)\s*(?:下午|pm)\s*(\d{1,2})[点时:：](\d{1,2})?/i,
			toCron: (m) => {
				const h = parseInt(m[1]!, 10) + (parseInt(m[1]!, 10) < 12 ? 12 : 0);
				const min = m[2] ? parseInt(m[2], 10) : 0;
				return { expr: `${min} ${h} * * *`, label: `每天${h}:${String(min).padStart(2, '0')}` };
			}
		},
		{
			regex: /(?:工作日|周一到周五)\s*(\d{1,2})[点时:：](\d{1,2})?/i,
			toCron: (m) => {
				const h = parseInt(m[1]!, 10);
				const min = m[2] ? parseInt(m[2], 10) : 0;
				return { expr: `${min} ${h} * * 1-5`, label: `工作日${h}:${String(min).padStart(2, '0')}` };
			}
		},
	];

	for (const { regex, toCron } of patterns) {
		const match = text.match(regex);
		if (match) {
			const { expr, label } = toCron(match);
			const remaining = text.replace(regex, '').trim();
			return { cronExpr: expr, label, remaining };
		}
	}
	return null;
}

function parseGithubTrendingArgs(argsStr?: string): { since: 'daily' | 'weekly' | 'monthly'; language: string; topN: number } {
	let since: 'daily' | 'weekly' | 'monthly' = 'daily';
	let language = '';
	let topN = 20;
	if (argsStr) {
		for (const part of argsStr.trim().split(/\s+/)) {
			if (['daily', 'weekly', 'monthly'].includes(part.toLowerCase())) {
				since = part.toLowerCase() as 'daily' | 'weekly' | 'monthly';
			} else if (['今日', '今天', '日'].includes(part)) {
				since = 'daily';
			} else if (['本周', '周'].includes(part)) {
				since = 'weekly';
			} else if (['本月', '月'].includes(part)) {
				since = 'monthly';
			} else if (/^\d+$/.test(part)) {
				topN = Math.min(50, Math.max(1, parseInt(part, 10)));
			} else if (part) {
				language = part;
			}
		}
	}
	return { since, language, topN };
}

function formatRelativeTime(timestamp: number): string {
	const diff = Date.now() - timestamp;
	if (diff < 60000) return "刚刚";
	if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
	if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
	return `${Math.floor(diff / 86400000)} 天前`;
}

// ──────────────────────────────────────────────────
// 统一命令处理器
// ──────────────────────────────────────────────────

export class CommandHandler {
	private adapter: PlatformAdapter;
	private ctx: CommandContext;
	private static ideForwardEnabled = new Map<string, boolean>();

	static isIdeForwardEnabled(chatId: string): boolean {
		return CommandHandler.ideForwardEnabled.get(chatId) === true;
	}

	constructor(adapter: PlatformAdapter, context: CommandContext) {
		this.adapter = adapter;
		this.ctx = context;
	}

	// ──────────────────────────────────────────────────
	// /帮助 - 显示所有命令
	// ──────────────────────────────────────────────────

	async handleHelp(): Promise<void> {
		const platformName =
			this.ctx.platform === "feishu"
				? "飞书"
				: this.ctx.platform === "dingtalk"
					? "钉钉"
					: this.ctx.platform === "wechat"
						? "微信个人号"
						: this.ctx.platform === "telegram"
							? "Telegram"
							: "企业微信";
		const projects = Object.keys(this.ctx.projectsConfig.projects).map(k => `\`${k}\``).join("、");

		const helpText = [
			"**基础指令**",
			"- `/帮助` `/help` — 显示本帮助",
			"- `/状态` `/status` — 查看服务状态",
			"- `/项目` `/project` — 列出所有项目",
			"- `/新对话` `/new` — 重置当前会话",
			"- `/新对话 --all` — 批量重置所有项目的会话",
			"- `/终止 [项目名]` `/stop` — 终止正在执行的任务",
			"- `/终止 --all` — 批量终止所有运行中的任务",
			"",
			"**热点 / 新闻 / 天气**",
			"- `/新闻` `/news` — **立即推送**今日热点（直接发 `/新闻`）；定时例：`/新闻 每天9点 推送10条`",
			"- `/新闻状态` `/news status` — 各数据源是否可用",
			"- 也可说：「每天9点推送热点」「30分钟后推送10条新闻」等自动建定时任务",
			"- `/天气` `/weather` — 查询北京天气；`/天气 上海` 查指定城市；定时例：`/天气 每天10点 北京`",
			"- `/github` — GitHub Trending 今日热榜 Top20；`/github weekly` 本周榜；`/github 10 python` 指定数量和语言；定时例：`/github 每天10点`",
			"",
			"**会话管理**",
			"- `/会话` `/sessions` — 查看最近会话列表",
			"- `/会话 编号` — 切换到指定会话",
			"",
		"**模型与密钥**",
		"- `/模型` `/model` — 查看/切换 AI 模型（支持缩略名：`/模型 opus`）",
		"- `/黑名单` `/配额` — 查看配额用尽的模型（每月1号自动重置）",
		"- `/黑名单 重置` — 手动重置黑名单",
		"- `/密钥` `/apikey` — 查看/更换 API Key（仅私聊）",
		"  用法：`/密钥 key_xxx...`",
		"",
			"**记忆系统**",
			"- `/记忆` `/memory` — 查看记忆状态",
			"- `/记忆 关键词` — 语义搜索记忆",
			"- `/记录 内容` — 写入今日日记",
		"- `/整理记忆` `/reindex` — 重建记忆索引",
		"",
	];

	// 文件操作（所有平台支持）
	helpText.push(
		"**文件操作**",
		"- `/apk` `/sendapk` — 快速发送 Android APK（需配置 Android 项目）",
		"- `/发送文件 路径` — 发送任意本地文件",
		"- 示例: `/发送文件 ~/document.pdf`",
		""
	);

	// 钉钉特殊提示
	if (this.ctx.platform === "dingtalk") {
		helpText.push("  ⚠️  钉钉文件发送为实验性功能，如遇问题请反馈", "");
	}

	helpText.push(
		"**定时任务**",
		"- `/任务` `/cron` — 查看/暂停/恢复/删除定时任务",
		"- 热点定时见上文 **热点 / 新闻**；其它定时也可说「每天早上9点提醒我XX」",
		"",
		"**心跳系统**",
		"- `/心跳` `/heartbeat` — 查看心跳状态",
		"- `/心跳 开启/关闭/执行`",
		"- `/心跳 间隔 分钟数`",
		"",
		"**系统管理**",
		"- `/重启` `/restart` — 重启当前渠道服务",
		"- `/重启全部` `/restart all` — 一键重启所有渠道服务",
		"",
		"**项目路由**",
		"· 对话切换：说「切到 remote」等可持久切换",
		"· 前缀指定：`项目名:消息` 或 `#项目名 消息`",
		`· 可用项目：${projects}`,
	);

		helpText.push("", "> 💡 发送 `/私人` 查看个人专属命令");
		await this.adapter.reply(`📖 **使用帮助**\n\n${helpText.join("\n")}`);
	}

	// ──────────────────────────────────────────────────
	// /状态 - 查看服务状态
	// ──────────────────────────────────────────────────

	async handleStatus(): Promise<void> {
		const { config, projectsConfig, memoryWorkspace, memory, scheduler, heartbeat, sessionsStore, agentExecutor } = this.ctx;

		// 平台特定的配置预览
		let credentialPreview = "";
		if (this.ctx.platform === "telegram") {
			credentialPreview = config.TELEGRAM_BOT_TOKEN ? `\`Bot ...${config.TELEGRAM_BOT_TOKEN.slice(-6)}\`` : "**未设置**";
		} else if (this.ctx.platform === "wecom") {
			credentialPreview = config.WECOM_BOT_ID ? `\`...${config.WECOM_BOT_ID.slice(-8)}\`` : "**未设置**";
		} else if (this.ctx.platform === "feishu") {
			credentialPreview = config.FEISHU_APP_ID ? `\`...${config.FEISHU_APP_ID.slice(-8)}\`` : "**未设置**";
		} else if (this.ctx.platform === "wechat") {
			credentialPreview = "**微信 ilink Bot（扫码登录）**";
		} else {
			credentialPreview = config.DINGTALK_APP_KEY ? `\`...${config.DINGTALK_APP_KEY.slice(-8)}\`` : "**未设置**";
		}

		const projects = Object.entries(projectsConfig.projects)
			.map(([k, v]: [string, any]) => `  \`${k}\` → ${v.path}`)
			.join("\n");

		const memStatus = memory
			? (() => {
					const stats = memory.getStats();
					return `${stats.chunks} 块（${stats.files} 文件, ${stats.cachedEmbeddings} 嵌入缓存）`;
			  })()
			: "未初始化";

		const keyPreview = config.CURSOR_API_KEY ? `\`...${config.CURSOR_API_KEY.slice(-8)}\`` : "**未设置**";

		const sessions = [...sessionsStore.entries()]
			.filter(([, s]) => s.active)
			.map(([ws, s]) => {
				const name = Object.entries(projectsConfig.projects).find(([, v]: [string, any]) => v.path === ws)?.[0] || ws;
				const entry = s.history.find((h: any) => h.id === s.active);
				const info = entry ? ` · ${entry.summary.slice(0, 30)}` : "";
				return `  \`${name}\` → ${s.active!.slice(0, 12)}...${info}`;
			})
			.join("\n") || "  (无活跃会话)";

		const schedStats = scheduler.getStats();
		const schedText = schedStats.total > 0 
			? `${schedStats.enabled}/${schedStats.total} 任务${schedStats.nextRunIn ? `（下次: ${schedStats.nextRunIn}）` : ""}`
			: "无任务";

		const hbStatus = heartbeat.getStatus();
		const hbText = hbStatus.enabled ? `每 ${Math.round(hbStatus.everyMs / 60000)} 分钟` : "未启用";

		const platformLabel =
			this.ctx.platform === "wecom"
				? "BotID"
				: this.ctx.platform === "feishu"
					? "AppID"
					: this.ctx.platform === "wechat"
						? "微信"
						: "AppKey";

		const statusText = [
			`**${platformLabel}：** ${credentialPreview}`,
			`**Key：** ${keyPreview}`,
			`**模型：** \`${config.CURSOR_MODEL || getDefaultModel()}\``,
			`**记忆：** ${memStatus}`,
			`**调度：** ${schedText}`,
			`**心跳：** ${hbText}`,
			`**活跃任务：** ${agentExecutor ? agentExecutor.getActiveAgents().length : 0} 个运行中`,
			`**工作区：** ${memoryWorkspace}`,
			"",
			"**项目路由：**",
			projects,
			"",
			"**活跃会话：**",
			sessions,
		].join("\n");

		await this.adapter.reply(`📊 **服务状态**\n\n${statusText}`);
	}

	// ──────────────────────────────────────────────────
	// /重启 - 重启当前渠道服务
	// ──────────────────────────────────────────────────

	async handleRestart(): Promise<void> {
		const scriptPath = resolve(this.ctx.rootDir, this.ctx.platform, "service.sh");

		if (!existsSync(scriptPath)) {
			await this.adapter.reply("❌ 未找到 service.sh，当前渠道不支持 `/重启`");
			return;
		}

		await this.adapter.reply("🔄 正在重启服务，请稍候...");

		setTimeout(() => {
			const child = spawn("bash", [scriptPath, "restart"], {
				cwd: resolve(this.ctx.rootDir, this.ctx.platform),
				detached: true,
				stdio: "ignore",
			});
			child.unref();
		}, 500);
	}

	// ──────────────────────────────────────────────────
	// /重启全部 - 一键重启所有渠道服务（调用 manage-services.sh）
	// ──────────────────────────────────────────────────

	async handleRestartAll(): Promise<void> {
		const scriptPath = resolve(this.ctx.rootDir, "manage-services.sh");

		if (!existsSync(scriptPath)) {
			await this.adapter.reply("❌ 未找到 manage-services.sh，无法执行 `/重启全部`");
			return;
		}

		await this.adapter.reply("🔄 正在重启所有渠道服务（飞书/钉钉/企微/微信/Telegram），本频道短暂不可用，请稍候...");

		setTimeout(() => {
			const child = spawn("bash", [scriptPath, "restart"], {
				cwd: this.ctx.rootDir,
				detached: true,
				stdio: "ignore",
			});
			child.unref();
		}, 500);
	}

	// ──────────────────────────────────────────────────
	// /新对话 - 重置会话
	// ──────────────────────────────────────────────────

	async handleNew(args?: string): Promise<void> {
		const { projectsConfig, archiveAndResetSession, getSessionHistory, agentExecutor } = this.ctx;

		const trimmed = args?.trim();
		if (trimmed && trimmed !== "--all") {
			await this.adapter.reply(
				"❌ **未知参数**\n\n用法：\n- `/新对话` — 重置当前项目会话\n- `/新对话 --all` — 批量重置所有项目会话"
			);
			return;
		}
		
		// 批量重置所有项目
		if (trimmed === '--all') {
			const projects = Object.entries(projectsConfig.projects);
			
			// 检查是否有任何运行中的任务
			const activeList = agentExecutor ? agentExecutor.getActiveAgents() : [];
			const runningProjects: string[] = [];
			
			for (const agent of activeList) {
				const projectName = Object.entries(projectsConfig.projects)
					.find(([, v]: [string, any]) => v.path === agent.workspace)?.[0];
				if (projectName) {
					runningProjects.push(projectName);
				}
			}
			
			if (runningProjects.length > 0) {
				await this.adapter.reply(
					`⚠️ **以下项目有任务正在运行**\n\n${runningProjects.map(p => `- ${p}`).join('\n')}\n\n` +
					`请先使用 \`/终止 --all\` 命令停止所有任务，再批量重置会话。`
				);
				return;
			}
			
			const results: string[] = [];
			for (const [projectName, projectInfo] of projects as [string, any][]) {
				const workspace = projectInfo.path;
				archiveAndResetSession(workspace);
				const historyCount = getSessionHistory(workspace).length;
				results.push(`✅ **${projectName}**: 会话已重置${historyCount > 0 ? ` (历史 ${historyCount} 个)` : ''}`);
			}
			
			await this.adapter.reply(
				`🆕 **批量重置完成**\n\n${results.join('\n')}\n\n` +
				`共重置 ${projects.length} 个项目的会话。`
			);
			return;
		}
		
		// 单个项目重置（原有逻辑）
		const currentProject = this.ctx.getCurrentProject(this.ctx.defaultWorkspace) || this.ctx.projectsConfig.default_project;
		const workspace = this.ctx.projectsConfig.projects[currentProject]?.path || this.ctx.defaultWorkspace;

		// Bug 修复: 检查是否有正在运行的任务
		const activeList = agentExecutor ? agentExecutor.getActiveAgents() : [];
		
		const hasRunning = activeList.some(agent => agent.workspace === workspace);
		if (hasRunning) {
			await this.adapter.reply(
				`⚠️ **当前项目有任务正在运行**\n\n请先使用 \`/终止\` 命令停止任务，再开始新对话。\n\n或者等待当前任务完成后再发送 \`/新对话\`。`
			);
			return;
		}

		this.ctx.archiveAndResetSession(workspace);

		const historyCount = this.ctx.getSessionHistory(workspace).length;
		const hint = historyCount > 0 ? `\n\n历史会话已保留（共 ${historyCount} 个），发送 \`/会话\` 可查看和切换。` : "";

		await this.adapter.reply(`🆕 **新会话已开始**\n\n下一条消息将创建全新对话。${hint}`);
	}

	// ──────────────────────────────────────────────────
	// /项目 - 列出所有项目
	// ──────────────────────────────────────────────────

	async handleProject(): Promise<void> {
		const currentProject = this.ctx.getCurrentProject(this.ctx.defaultWorkspace);
		const projects = Object.entries(this.ctx.projectsConfig.projects)
			.map(([k, v]: [string, any]) => `- **${k}**${k === currentProject ? " ✅" : ""}\n  \`${v.path}\`\n  ${v.description || ""}`)
			.join("\n\n");

		await this.adapter.reply(
			`**可用项目（共 ${Object.keys(this.ctx.projectsConfig.projects).length} 个）**\n\n${projects}\n\n> 发送「切换到 项目名」可持久切换`
		);
	}

	// ──────────────────────────────────────────────────
	// /终止 - 终止任务
	// ──────────────────────────────────────────────────

	async handleStop(projectHint?: string): Promise<void> {
		const { projectsConfig, busySessions, sessionsStore, agentExecutor } = this.ctx;

		const projectNameForWorkspace = (wsPath: string): string | null => {
			for (const [name, info] of Object.entries(projectsConfig.projects) as [string, any][]) {
				if (info.path === wsPath) return name;
			}
			return null;
		};

		/** lockKey 为 ws:path 或 session:sessionId，需反查项目名用于 /stop 列表与提示 */
		const getProjectNameByLockKey = (lockKey: string): string | null => {
			if (lockKey.startsWith("ws:")) {
				return projectNameForWorkspace(lockKey.replace(/^ws:/, ""));
			}
			if (lockKey.startsWith("session:")) {
				const sessionId = lockKey.slice("session:".length);
				for (const [workspace, wsData] of Array.from(sessionsStore.entries()) as [string, any][]) {
					if (wsData?.active === sessionId) {
						return projectNameForWorkspace(workspace);
					}
					if (Array.isArray(wsData?.history) && wsData.history.some((h: { id?: string }) => h?.id === sessionId)) {
						return projectNameForWorkspace(workspace);
					}
				}
			}
			return null;
		};

		// 批量终止所有任务
		if (projectHint?.trim() === '--all') {
			const activeList = agentExecutor ? agentExecutor.getActiveAgents() : [];
			if (activeList.length === 0) {
				await this.adapter.reply("当前没有正在运行的任务。");
				return;
			}
			
			const killedTasks: string[] = [];
			if (agentExecutor) {
				for (const agent of activeList) {
					const projectName = projectNameForWorkspace(agent.workspace) || "未知项目";
					killedTasks.push(`✅ **${projectName}**: 已终止 (PID: ${agent.pid}, 运行 ${agent.runningTime}s)`);
					console.log(`[指令] 批量终止 agent pid=${agent.pid} project=${projectName}`);
				}
				agentExecutor.killAll();
				busySessions.clear();
			}
			
			await this.adapter.reply(
				`🛑 **批量终止完成**\n\n${killedTasks.join('\n')}\n\n` +
				`共终止 ${killedTasks.length} 个任务。`
			);
			return;
		}

		if (projectHint) {
			if (!projectsConfig.projects[projectHint]) {
				const available = Object.keys(projectsConfig.projects).map(k => `\`${k}\``).join("、");
				await this.adapter.reply(`❌ **项目不存在**\n\n未找到项目 \`${projectHint}\`\n\n可用项目：${available}`);
				return;
			}
			const wsPath = projectsConfig.projects[projectHint].path;
			
			if (agentExecutor) {
				const killed = agentExecutor.killAgent(wsPath);
				if (killed) {
					busySessions.clear();
					await this.adapter.reply(`✅ 已终止项目 **${projectHint}** 的任务。\n\n发送新消息将继续在当前会话中对话。`);
				} else {
					await this.adapter.reply(`项目 **${projectHint}** 没有正在运行的任务。`);
				}
			}
			return;
		}

		// 获取活跃任务列表
		const activeList = agentExecutor ? agentExecutor.getActiveAgents() : [];
		
		if (activeList.length === 0) {
			await this.adapter.reply("当前没有正在运行的任务。");
			return;
		}

		if (activeList.length === 1) {
			const agent = activeList[0]!;
			const projectName = agentExecutor 
				? projectNameForWorkspace(agent.workspace) || "当前项目"
				: "当前项目";
			
			if (agentExecutor) {
				agentExecutor.killAgent(agent.workspace);
				busySessions.clear();
			}
			console.log(`[指令] 终止 agent pid=${agent.pid}`);
			await this.adapter.reply(`✅ 已终止 **${projectName}** 的任务。`);
			return;
		}

		const tasks = activeList.map((agent, i) => {
			const projectName = projectNameForWorkspace(agent.workspace) || "未知项目";
			const timeHint = `运行 ${agent.runningTime}s`;
			return `${i + 1}. **${projectName}**\n   PID: ${agent.pid} ${timeHint}`;
		});

		await this.adapter.reply(
			`**当前运行中（${activeList.length} 个）**\n\n${tasks.join("\n\n")}\n\n> 发送 \`/终止 项目名\` 可终止指定项目的任务\n> 发送 \`/终止 --all\` 可终止所有任务`
		);
	}

	// ──────────────────────────────────────────────────
	// /模型 - 切换 AI 模型（集成模型配置库）
	// ──────────────────────────────────────────────────

	async handleModel(args: string): Promise<void> {
		// 无参数：显示模型列表
		if (!args) {
			const list = formatModelList(this.ctx.config.CURSOR_MODEL || getDefaultModel());
			await this.adapter.reply(list);
			return;
		}

		// 查找目标模型（支持编号、ID、别名）
		const targetModel = findModel(args);
		if (!targetModel) {
			await this.adapter.reply(`❌ 找不到模型：\`${args}\`\n\n发送 \`/模型\` 查看可用模型列表。`);
			return;
		}

		// 更新内存中的配置
		const prevModel = this.ctx.config.CURSOR_MODEL;
		this.ctx.config.CURSOR_MODEL = targetModel.id;

		// 持久化到全局配置文件 config/model-config.json
		const configPath = resolve(this.ctx.rootDir, "config", "model-config.json");
		try {
			const fs = await import("node:fs/promises");
			
			// 读取配置文件
			const raw = await fs.readFile(configPath, "utf-8");
			const config = JSON.parse(raw);
			
			// 更新 defaultModel
			config.defaultModel = targetModel.id;
			
			// 写回配置文件（保持格式）
			await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', "utf-8");
			
			console.log(`[模型切换] 全局配置已更新: ${prevModel} → ${targetModel.id}`);

			// 构建回复消息
			const chain = getModelChain(targetModel.id);
			const fallbackInfo = chain.length > 1 
				? `\n**Fallback 链：** ${chain.slice(1).map(m => `\`${m.id}\``).join(' → ')}`
				: '';

			// 检查是否有正在运行的 Agent（需要热重启）
			const { agentExecutor } = this.ctx;
			const activeList = agentExecutor ? agentExecutor.getActiveAgents() : [];
			
			let restartMsg = '';
			if (activeList.length > 0 && agentExecutor) {
				console.log(`[热重启] 终止所有 Agent (${activeList.length}个), model=${prevModel}`);
				agentExecutor.killAll();
				this.ctx.busySessions.clear();
				restartMsg = '\n\n⚠️ **已重启正在运行的任务**（将使用新模型继续）';
			}
			
			await this.adapter.reply(
				`✅ **已切换模型（全局）**\n\n` +
				`**之前：** \`${prevModel}\`\n` +
				`**现在：** \`${targetModel.id}\`${fallbackInfo}${restartMsg}\n\n` +
				`✨ 已更新全局配置，所有平台同步生效。`
			);
		} catch (error) {
			console.error("[模型切换] 写入全局配置失败", error);
			await this.adapter.reply(`❌ 切换失败\n\n${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// ──────────────────────────────────────────────────
	// /黑名单 - 查看/重置模型黑名单
	// ──────────────────────────────────────────────────

	async handleBlacklist(args: string): Promise<void> {
		const { models, nextResetDate } = getBlacklistStatus();

		// 无参数：显示黑名单状态
		if (!args) {
			if (models.length === 0) {
				await this.adapter.reply(
					`**📊 模型配额状态**\n\n` +
					`✅ 当前所有模型均可用\n\n` +
					`**下次重置时间：** ${nextResetDate}\n\n` +
					`> 配额用尽的模型会被自动加入黑名单，并在每月1号重置。`
				);
			} else {
				const modelList = models.map(m => `· \`${m}\``).join('\n');
				await this.adapter.reply(
					`**📊 模型配额状态**\n\n` +
					`⚠️ **以下模型已配额用尽：**\n\n${modelList}\n\n` +
					`**下次重置时间：** ${nextResetDate}\n\n` +
					`发送消息时会自动跳过这些模型，使用 fallback 链。\n\n` +
					`**手动重置：** 发送 \`/黑名单 重置\``
				);
			}
			return;
		}

		// 重置命令
		if (/^(重置|reset|清空|clear)$/i.test(args)) {
			resetBlacklist();
			await this.adapter.reply(
				`✅ **已重置模型黑名单**\n\n` +
				`所有模型已恢复可用状态。\n\n` +
				`**下次自动重置：** ${nextResetDate}`
			);
			return;
		}

		await this.adapter.reply(`❌ 无效的命令。\n\n**用法：**\n· \`/黑名单\` — 查看状态\n· \`/黑名单 重置\` — 手动重置`);
	}

	// ──────────────────────────────────────────────────
	// /密钥 - 管理 API Key
	// ──────────────────────────────────────────────────

	async handleApiKey(args: string): Promise<void> {
		const keyPreview = this.ctx.config.CURSOR_API_KEY ? `\`...${this.ctx.config.CURSOR_API_KEY.slice(-8)}\`` : "**未设置**";

		if (!args) {
			await this.adapter.reply(
				`**当前 API Key：** ${keyPreview}\n\n**用法：**\n- \`/密钥 key_xxx...\` — 更换 Key\n\n⚠️ Key 明文存储在 .env 中，请勿分享！\n\n💡 推荐使用 \`agent login\` 登录后注释掉 .env 中的 CURSOR_API_KEY`
			);
			return;
		}

		if (!args.startsWith("key_") && !args.startsWith("sk-")) {
			await this.adapter.reply("❌ 无效的 API Key 格式。\n\nKey 应以 `key_` 或 `sk-` 开头。");
			return;
		}

		this.ctx.config.CURSOR_API_KEY = args;
		const envPath = resolve(this.ctx.rootDir, this.ctx.platform, ".env");
		try {
			const raw = readFileSync(envPath, "utf-8");
			const lines = raw.split("\n");
			let found = false;
			const updated = lines.map((line) => {
				if (line.trim().startsWith("CURSOR_API_KEY=") || line.trim().startsWith("#CURSOR_API_KEY=")) {
					found = true;
					return `CURSOR_API_KEY=${args}`;
				}
				return line;
			});
			if (!found) updated.push(`CURSOR_API_KEY=${args}`);
			const fs = await import("node:fs/promises");
			await fs.writeFile(envPath, updated.join("\n"), "utf-8");
			await this.adapter.reply(`✅ **API Key 已更换**\n\n新 Key: \`...${args.slice(-8)}\`\n\n下次会话将使用新 Key。`);
		} catch (error) {
			console.error("[密钥更换] 写入 .env 失败", error);
			await this.adapter.reply(`❌ 更换失败\n\n${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// ──────────────────────────────────────────────────
	// /会话 - 会话管理
	// ──────────────────────────────────────────────────

	async handleSession(args: string, updateSessionCallback?: (sessionId: string) => void): Promise<void> {
		const currentProject = this.ctx.getCurrentProject(this.ctx.defaultWorkspace) || this.ctx.projectsConfig.default_project;
		const workspace = this.ctx.projectsConfig.projects[currentProject]?.path || this.ctx.defaultWorkspace;

		if (!args) {
			const history = this.ctx.getSessionHistory(workspace, 10);
			const active = this.ctx.getActiveSessionId(workspace);
			if (history.length === 0) {
				await this.adapter.reply("暂无会话历史。\n\n发送消息即可创建新会话。");
				return;
			}
			const lines = history.map((h, i) => {
				const isCurrent = h.id === active;
				const time = formatRelativeTime(h.lastActiveAt);
				return isCurrent
					? `**${i + 1}. ${h.summary}** ✅\n   \`${h.id.slice(0, 12)}...\` · ${time}`
					: `${i + 1}. ${h.summary}\n   \`${h.id.slice(0, 12)}...\` · ${time}`;
			});
			await this.adapter.reply(`**最近会话（共 ${history.length} 个）**\n\n${lines.join("\n\n")}\n\n> 发送 \`/会话 编号\` 切换`);
			return;
		}

		const num = Number.parseInt(args, 10);
		if (Number.isNaN(num) || num < 1) {
			await this.adapter.reply("❌ 编号格式错误\n\n请发送 `/会话` 查看列表，然后 `/会话 编号` 切换。");
			return;
		}

		const history = this.ctx.getSessionHistory(workspace, 20);
		if (num > history.length) {
			await this.adapter.reply(`❌ 编号超出范围（共 ${history.length} 个会话）\n\n发送 \`/会话\` 查看列表。`);
			return;
		}

		const targetSession = history[num - 1];
		if (!targetSession) {
			await this.adapter.reply("❌ 会话不存在。");
			return;
		}

		const ok = this.ctx.switchToSession(workspace, targetSession.id);
		if (ok) {
			if (updateSessionCallback) {
				updateSessionCallback(targetSession.id);
			}
			await this.adapter.reply(
				`✅ **已切换到会话 ${num}**\n\n${targetSession.summary}\n\n\`${targetSession.id.slice(0, 12)}...\`\n\n下一条消息将在此会话中继续对话。`
			);
			console.log(`[会话] 切换到: ${targetSession.id}`);
		} else {
			await this.adapter.reply("❌ 切换失败，会话不存在。");
		}
	}

	// ──────────────────────────────────────────────────
	// /任务 - 定时任务管理
	// ──────────────────────────────────────────────────

	async handleTask(args: string): Promise<void> {
		const subCmd = args.trim().toLowerCase();

		// 查看任务列表
		if (!subCmd || subCmd === "list" || subCmd === "列表") {
			const cronFileName = `cron-jobs-${this.ctx.platform}.json`;
			const cronFilePath = resolve(this.ctx.rootDir, cronFileName);
			let jobs: any[] = [];
			try {
				if (existsSync(cronFilePath)) {
					const data = JSON.parse(readFileSync(cronFilePath, "utf-8"));
					jobs = (data.jobs || []).filter((j: any) => !j.platform || j.platform === this.ctx.platform);
				}
			} catch (e) {
				console.warn(`[任务] 读取文件失败: ${e}`);
			}

			if (jobs.length === 0) {
				await this.adapter.reply("暂无定时任务。\n\n在对话中告诉 AI「每天早上9点提醒我XX」即可自动创建。");
				return;
			}

			const lines = jobs.map((j: any, i: number) => {
				const status = j.enabled ? "✅" : "⏸";
				let schedDesc = "";
				if (j.schedule.kind === "at") {
					const atTime = new Date(j.schedule.at);
					schedDesc = `一次性 ${atTime.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`;
				} else if (j.schedule.kind === "every") {
					schedDesc = `每 ${Math.round(j.schedule.everyMs / 60000)} 分钟`;
				} else {
					const humanReadable = humanizeCronInChinese(j.schedule.expr);
					schedDesc = `${humanReadable}`;
				}
				const lastRun = j.state?.lastRunAtMs ? new Date(j.state.lastRunAtMs).toLocaleString("zh-CN") : "从未执行";
				return `${status} **${i + 1}. ${j.name}**\n   调度: ${schedDesc}\n   上次: ${lastRun}\n   ID: \`${j.id.slice(0, 16)}...\``;
			});
			lines.push("", `📊 共 ${jobs.length} 个任务`);
			await this.adapter.reply(`📋 **定时任务**\n\n${lines.join("\n")}`);
			return;
		}

		// /任务 暂停 ID
		const pauseMatch = subCmd.match(/^(暂停|pause|disable)\s+(\S+)/i);
		if (pauseMatch) {
			const idPrefix = pauseMatch[2];
			if (!idPrefix) {
				await this.adapter.reply("❌ 请提供任务 ID 前缀，例如：`/任务 暂停 abc123`");
				return;
			}
			const job = (await this.ctx.scheduler.list(true)).find((j) => j.id.startsWith(idPrefix));
			if (!job) {
				await this.adapter.reply(`未找到 ID 为 \`${idPrefix}\` 的任务`);
				return;
			}
			await this.ctx.scheduler.update(job.id, { enabled: false });
			await this.adapter.reply(`⏸ **已暂停**\n\n已暂停: **${job.name}**`);
			return;
		}

		// /任务 恢复 ID
		const resumeMatch = subCmd.match(/^(恢复|resume|enable)\s+(\S+)/i);
		if (resumeMatch) {
			const idPrefix = resumeMatch[2];
			if (!idPrefix) {
				await this.adapter.reply("❌ 请提供任务 ID 前缀，例如：`/任务 恢复 abc123`");
				return;
			}
			const job = (await this.ctx.scheduler.list(true)).find((j) => j.id.startsWith(idPrefix));
			if (!job) {
				await this.adapter.reply(`未找到 ID 为 \`${idPrefix}\` 的任务`);
				return;
			}
			await this.ctx.scheduler.update(job.id, { enabled: true });
			await this.adapter.reply(`✅ **已恢复**\n\n已恢复: **${job.name}**`);
			return;
		}

		// /任务 删除 ID
		const deleteMatch = subCmd.match(/^(删除|delete|remove)\s+(\S+)/i);
		if (deleteMatch) {
			const idPrefix = deleteMatch[2];
			if (!idPrefix) {
				await this.adapter.reply("❌ 请提供任务 ID 前缀，例如：`/任务 删除 abc123`");
				return;
			}
			const job = (await this.ctx.scheduler.list(true)).find((j) => j.id.startsWith(idPrefix));
			if (!job) {
				await this.adapter.reply(`未找到 ID 为 \`${idPrefix}\` 的任务`);
				return;
			}
			await this.ctx.scheduler.remove(job.id);
			await this.adapter.reply(`🗑️ **已删除**\n\n已删除: **${job.name}**`);
			return;
		}

		// /任务 执行 ID
		const runMatch = subCmd.match(/^(执行|run|trigger)\s+(\S+)/i);
		if (runMatch) {
			const idPrefix = runMatch[2];
			if (!idPrefix) {
				await this.adapter.reply("❌ 请提供任务 ID 前缀，例如：`/任务 执行 abc123`");
				return;
			}
			const job = (await this.ctx.scheduler.list(true)).find((j) => j.id.startsWith(idPrefix));
			if (!job) {
				await this.adapter.reply(`未找到 ID 为 \`${idPrefix}\` 的任务`);
				return;
			}
			await this.adapter.reply(`▶ **执行中**\n\n正在手动执行: **${job.name}**...`);
			const result = await this.ctx.scheduler.run(job.id);
			await this.adapter.reply(
				result.status === "ok" ? `✅ **执行成功**\n\n${job.name}` : `❌ **执行失败**\n\n${result.error}`
			);
			return;
		}

		await this.adapter.reply("❌ 未知操作\n\n可用操作：\n- `/任务` — 查看列表\n- `/任务 暂停 ID`\n- `/任务 恢复 ID`\n- `/任务 删除 ID`\n- `/任务 执行 ID`");
	}

	// ──────────────────────────────────────────────────
	// /心跳 - 心跳系统管理
	// ──────────────────────────────────────────────────

	async handleHeartbeat(args: string): Promise<void> {
		const subCmd = args.trim().toLowerCase();
		const status = this.ctx.heartbeat.getStatus();

		if (!subCmd || subCmd === "status" || subCmd === "状态") {
			const statusText = [
				`**当前状态：** ${status.enabled ? "✅ 已启用" : "⏸ 已暂停"}`,
				`**检查间隔：** ${Math.round(status.everyMs / 60000)} 分钟`,
				`**上次检查：** ${status.lastRunAt ? new Date(status.lastRunAt).toLocaleString("zh-CN") : "从未执行"}`,
				`**下次检查：** ${status.nextRunAt ? new Date(status.nextRunAt).toLocaleString("zh-CN") : "未调度"}`,
				"",
				"**用法：**",
				"- `/心跳 开启` — 启用心跳",
				"- `/心跳 关闭` — 停止心跳",
				"- `/心跳 执行` — 立即执行一次检查",
				"- `/心跳 间隔 30` — 设置间隔为 30 分钟",
			].join("\n");
			await this.adapter.reply(`💓 **心跳系统**\n\n${statusText}`);
			return;
		}

		if (subCmd === "开启" || subCmd === "启用" || subCmd === "enable" || subCmd === "start") {
			await this.ctx.heartbeat.start();
			await this.adapter.reply("✅ **心跳已启用**\n\n将定期检查系统状态。");
			return;
		}

		if (subCmd === "关闭" || subCmd === "停止" || subCmd === "disable" || subCmd === "stop") {
			await this.ctx.heartbeat.stop();
			await this.adapter.reply("⏸ **心跳已停止**");
			return;
		}

		if (subCmd === "执行" || subCmd === "运行" || subCmd === "run" || subCmd === "trigger") {
			await this.adapter.reply("▶ **正在执行心跳检查...**");
			const result = await this.ctx.heartbeat.runOnce();
			if (result.status === "skipped") {
				await this.adapter.reply(
					`⏭ **检查已跳过**\n\n原因：\`${result.reason}\`\n\n> 若在非活跃时段，可调整心跳活跃时间或稍后再试。`
				);
			} else if (result.hasContent) {
				await this.adapter.reply(`✅ **检查完成**\n\n已尝试推送需要关注的内容（耗时 ${result.durationMs}ms）。`);
			} else {
				await this.adapter.reply(`✅ **检查完成**\n\n无需额外报告（约 ${result.durationMs}ms）。`);
			}
			return;
		}

		const intervalMatch = subCmd.match(/^(间隔|interval)\s+(\d+)/i);
		if (intervalMatch) {
			const minutesStr = intervalMatch[2];
			if (!minutesStr) {
				await this.adapter.reply("❌ 请提供分钟数，例如：`/心跳 间隔 30`");
				return;
			}
			const minutes = Number.parseInt(minutesStr, 10);
			if (minutes < 1 || minutes > 1440) {
				await this.adapter.reply("❌ 间隔必须在 1-1440 分钟之间。");
				return;
			}
			this.ctx.heartbeat.updateConfig({ everyMs: minutes * 60 * 1000 });
			await this.adapter.reply(`✅ **间隔已设置**\n\n新间隔: ${minutes} 分钟`);
			return;
		}

		await this.adapter.reply("❌ 未知操作\n\n可用操作：\n- `/心跳` — 查看状态\n- `/心跳 开启/关闭`\n- `/心跳 执行`\n- `/心跳 间隔 数字`");
	}

	// ──────────────────────────────────────────────────
	// /记忆 - 记忆系统操作
	// ──────────────────────────────────────────────────

	async handleMemory(args: string): Promise<void> {
		const { memory } = this.ctx;

		if (!memory) {
			await this.adapter.reply("❌ 记忆系统未初始化");
			return;
		}

		if (!args) {
			const stats = memory.getStats();
			const statsText = [
				`**记忆块：** ${stats.chunks} 块`,
				`**文件数：** ${stats.files} 个`,
				`**嵌入缓存：** ${stats.cachedEmbeddings} 个`,
				`**数据库：** \`.memory.sqlite\``,
				"",
				"**用法：**",
				"- `/记忆 关键词` — 语义搜索",
				"- `/记录 内容` — 写入今日日记",
				"- `/整理记忆` — 重建索引",
			].join("\n");
			await this.adapter.reply(`🧠 **记忆系统**\n\n${statsText}`);
			return;
		}

		// 语义搜索
		try {
			const results = await memory.search(args, 5);
			if (results.length === 0) {
				await this.adapter.reply(`未找到与「${args}」相关的记忆。`);
				return;
			}

			const lines = results.map((r, i) => {
				const fileLabel = r.path.split("/").pop() ?? r.path;
				const preview = r.text.slice(0, 100);
				return `**${i + 1}. ${fileLabel}**\n   相关度: ${(r.score * 100).toFixed(1)}%\n   ${preview}${r.text.length > 100 ? "..." : ""}`;
			});

			await this.adapter.reply(`🔍 **搜索结果（共 ${results.length} 条）**\n\n${lines.join("\n\n")}`);
		} catch (error) {
			console.error("[记忆搜索] 失败", error);
			await this.adapter.reply(`❌ 搜索失败\n\n${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// ──────────────────────────────────────────────────
	// /记录 - 写入今日日记
	// ──────────────────────────────────────────────────

	async handleLog(content: string): Promise<void> {
		const { memory, memoryWorkspace } = this.ctx;

		if (!memory) {
			await this.adapter.reply("❌ 记忆系统未初始化");
			return;
		}

		if (!content.trim()) {
			await this.adapter.reply("❌ 请提供要记录的内容\n\n用法：`/记录 今天学会了TypeScript泛型`");
			return;
		}

		try {
			const memoryDir = resolve(memoryWorkspace, ".cursor/memory");
			const today = new Date().toISOString().split("T")[0];
			const diaryFile = resolve(memoryDir, `${today}-diary.md`);

			const fs = await import("node:fs/promises");
			await fs.mkdir(memoryDir, { recursive: true });

			const timestamp = new Date().toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit" });
			const entry = `\n\n## ${timestamp}\n\n${content}\n`;

			await fs.appendFile(diaryFile, entry, "utf-8");

			await memory.index();

			await this.adapter.reply(`✅ **已记录到今日日记**\n\n${content}`);
		} catch (err) {
			console.error("[记录] 写入失败", err);
			await this.adapter.reply(`❌ 写入失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// ──────────────────────────────────────────────────
	// /整理记忆 - 重建记忆索引
	// ──────────────────────────────────────────────────

	async handleReindex(): Promise<void> {
		const { memory } = this.ctx;

		if (!memory) {
			await this.adapter.reply("❌ 记忆系统未初始化");
			return;
		}

		try {
			await this.adapter.reply("🔄 **正在重建记忆索引...**\n\n这可能需要几分钟，请稍候。");

			const before = memory.getStats();
			await memory.index();
			const after = memory.getStats();

			const report = [
				`✅ **索引重建完成**`,
				"",
				`**更新前：** ${before.chunks} 块（${before.files} 文件）`,
				`**更新后：** ${after.chunks} 块（${after.files} 文件）`,
				`**新增：** ${after.chunks - before.chunks} 块`,
			].join("\n");

			await this.adapter.reply(report);
		} catch (error) {
			console.error("[整理记忆] 失败", error);
			await this.adapter.reply(`❌ 索引失败\n\n${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// ──────────────────────────────────────────────────
	// /新闻状态 - 新闻源健康检查
	// ──────────────────────────────────────────────────

	async handleNewsStatus(): Promise<void> {
		try {
			const status = getHealthStatus();
			await this.adapter.reply(`📊 **新闻源健康状态**\n\n${status}`);
		} catch (error) {
			console.error("[命令] /新闻状态 失败", error);
			await this.adapter.reply(`❌ 查询失败\n\n${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// ──────────────────────────────────────────────────
	// /github - GitHub Trending 热榜
	// ──────────────────────────────────────────────────

	async handleGithubTrending(args?: string): Promise<void> {
		try {
			const schedule = args ? parseChineseSchedule(args) : null;
			const { since, language, topN } = parseGithubTrendingArgs(schedule?.remaining ?? (schedule ? '' : args));
			const sinceLabel = since === 'daily' ? '今日' : since === 'weekly' ? '本周' : '本月';

			if (schedule) {
				const job = await this.ctx.scheduler.add({
					name: `${schedule.label} GitHub Trending ${sinceLabel}Top${topN}`,
					enabled: true,
					schedule: { kind: 'cron', expr: schedule.cronExpr, tz: 'Asia/Shanghai' },
					task: { type: 'fetch-github-trending', options: { since, language: language || undefined, topN, translateDesc: true } },
					message: 'fetch-github-trending',
					platform: this.ctx.platform,
				});
				await this.adapter.reply(
					`✅ **GitHub Trending 定时任务已创建**\n\n` +
					`📋 ${job.name}\n` +
					`⏰ ${schedule.label}\n` +
					`🔥 ${sinceLabel}热榜 Top${topN}${language ? `（${language}）` : ''}\n\n` +
					`管理任务：\`/任务\``
				);
				console.log(`[命令] /github 创建定时任务: ${schedule.label} ${sinceLabel} top${topN}`);
				return;
			}
			await this.adapter.reply(`🔥 正在获取 GitHub Trending ${sinceLabel}热榜 Top${topN}${language ? `（${language}）` : ''}...`);

			const card = await fetchGithubTrending({ since, language, topN, translateDesc: true });
			await this.adapter.reply(card);
			console.log(`[命令] /github ${since} top${topN} ${language} 推送完成`);
		} catch (error) {
			console.error("[命令] /github 查询失败", error);
			await this.adapter.reply(`❌ GitHub Trending 查询失败\n\n${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// ──────────────────────────────────────────────────
	// /天气 - 查询天气
	// ──────────────────────────────────────────────────

	async handleWeatherNow(args?: string): Promise<void> {
		try {
			const schedule = args ? parseChineseSchedule(args) : null;
			
			if (schedule) {
				const city = schedule.remaining || '北京';
				const job = await this.ctx.scheduler.add({
					name: `${schedule.label} ${city}天气`,
					enabled: true,
					schedule: { kind: 'cron', expr: schedule.cronExpr, tz: 'Asia/Shanghai' },
					task: { type: 'fetch-weather', options: { city } },
					message: 'fetch-weather',
					platform: this.ctx.platform,
				});
				await this.adapter.reply(
					`✅ **天气定时任务已创建**\n\n` +
					`📋 ${job.name}\n` +
					`⏰ ${schedule.label}\n` +
					`🏙️ ${city}\n\n` +
					`管理任务：\`/任务\``
				);
				console.log(`[命令] /天气 创建定时任务: ${schedule.label} ${city}`);
				return;
			}

			const targetCity = args?.trim() || '北京';
			await this.adapter.reply(`🌤️ 正在查询${targetCity}天气...`);

			const card = await fetchWeather({ city: targetCity, platform: this.ctx.platform });
			await this.adapter.reply(card);
			console.log(`[命令] /天气 ${targetCity} 推送完成`);
		} catch (error) {
			console.error("[命令] /天气 查询失败", error);
			const errMsg = error instanceof Error ? error.message : String(error);
			await this.adapter.reply(`❌ 天气查询失败\n\n${errMsg}`);
		}
	}

	// ──────────────────────────────────────────────────
	// /新闻 - 立即推送新闻
	// ──────────────────────────────────────────────────

	async handleNewsNow(topN: number = 15): Promise<void> {
		try {
			if (this.adapter.replyStream) {
				await this.adapter.replyStream("📰 正在抓取热点新闻...", false);
			} else {
				await this.adapter.reply("📰 正在抓取热点新闻...");
			}

			const { messages } = await fetchNews({ topN, platform: this.ctx.platform });

			if (messages.length === 0) {
				await this.adapter.reply("❌ 未获取到新闻数据");
				return;
			}

			// 多条消息分批发送
			const chunks = typeof messages === "string" ? [messages] : messages;
			for (let i = 0; i < chunks.length; i++) {
				const title = chunks.length > 1 ? `📰 今日热点 (${i + 1}/${chunks.length})` : "📰 今日热点";
				await this.adapter.reply(`**${title}**\n\n${chunks[i]}`);
				if (i < chunks.length - 1) {
					await new Promise((r) => setTimeout(r, 500));
				}
			}
			console.log(`[命令] /新闻 立即推送完成，共 ${chunks.length} 条消息`);
		} catch (error) {
			console.error("[命令] /新闻 推送失败", error);
			await this.adapter.reply(`❌ 推送失败\n\n${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// ──────────────────────────────────────────────────
	// /飞连 - VPN 控制
	// ──────────────────────────────────────────────────

	async handleFeilian(args: string): Promise<void> {
		const controller = new FeilianController();
		const subCmd = args.trim().toLowerCase();

		if (!subCmd || subCmd === "toggle" || subCmd === "切换") {
			const result = await controller.toggle();
			await this.replyFeilianOperation(result);
			return;
		}
		if (subCmd === "on" || subCmd === "开" || subCmd === "连接" || subCmd === "开启") {
			const result = await controller.ensureConnected();
			await this.replyFeilianOperation(result);
			return;
		}
		if (subCmd === "off" || subCmd === "关" || subCmd === "断开" || subCmd === "关闭") {
			const result = await controller.ensureDisconnected();
			await this.replyFeilianOperation(result);
			return;
		}
		if (subCmd === "status" || subCmd === "状态") {
			const vpn = await controller.checkStatus();
			await this.adapter.reply(`**飞连 VPN 状态**\n\n${controller.formatStatus(vpn)}`);
			return;
		}

		await this.adapter.reply(
			"❌ 未知操作\n\n可用操作：\n- `/飞连` — 切换状态\n- `/飞连 开` — 确保连接\n- `/飞连 关` — 断开\n- `/飞连 状态` — 查询状态"
		);
	}

	/** 飞连操作类指令的统一回复（与 OperationResult 对齐） */
	private async replyFeilianOperation(result: OperationResult): Promise<void> {
		const vpn = result.status;
		const statusLine =
			vpn !== undefined
				? `**VPN 状态：** ${vpn.connected ? "🟢 已连接" : "⚪ 未连接"}`
				: "";
		const lines = [
			result.success ? "✅ **操作结果**" : "⚠️ **操作结果**",
			"",
			result.message.trim(),
			statusLine ? `\n${statusLine}` : "",
			result.error ? `\n\n> ${result.error}` : "",
		];
		await this.adapter.reply(lines.join(""));
	}

	// ──────────────────────────────────────────────────
	// /私人 - 私人命令列表（不在 /帮助 中显示）
	// ──────────────────────────────────────────────────

	async handlePrivate(): Promise<void> {
		const helpText = [
			"🔒 **私人命令**",
			"",
			"**预案**",
			"- `/预案` — 查看最新预案的核心决策树",
			"- `/预案 0909` — 查看指定日期预案",
			"- `/预案 生成` — AI 生成次日预案（盘后用，已有则增量校验）",
			"- `/预案 玫瑰` — AI 抓取玫瑰最新观点 + 与预案比对差异",
			"",
			"**股票速报**",
			"- `/竞价` — 竞价速报（脚本秒出，扫描预案全部标的）",
			"- `/竞价 AI` — AI 深度分析预案标的竞价",
			"- `/竞价 金健米业` — AI 分析某股竞价",
			"- `/盘中` — 盘中速报（脚本秒出，实时数据+情绪面板）",
			"- `/盘中 AI` — AI 深度分析预案标的盘中状态",
			"- `/盘中 金健米业` — AI 分析某股盘中状态",
			"",
			"**急跌回踩选股**",
			"- `/急跌选股` — 今日急跌回踩25维评分选股",
			"- `/急跌选股 2026-09-16` — 指定日期",
			"",
			"**定时任务**",
			"- 竞价速报 09:25 自动推送（工作日）",
			"- ProPlus 选股 09:25 自动推送（工作日）",
			"- AI 深度分析 09:25 可选开启（默认关闭）",
			"",
			"> 数据源：腾讯行情（主力）→ 新浪行情（兜底）",
			"> 预案：玫瑰龙头战法/07-watchlist/watchlist-YYYYMMDD.json（按日自动匹配）",
		];

		await this.adapter.reply(helpText.join("\n"));
	}

	// ──────────────────────────────────────────────────
	// /竞价 /盘中 - 股票速报
	// ──────────────────────────────────────────────────

	async handleStockScan(mode: "auction" | "intraday", stockFilter?: string): Promise<void> {
		const watchlistDir = resolve(HOME, "work/cursor/taoguba/玫瑰龙头战法/07-watchlist");
		const scriptPath = resolve(HOME, ".codex/skills/meigui-longtou/scripts/auction_scanner.py");

		if (!existsSync(scriptPath)) {
			await this.adapter.reply(`❌ **auction_scanner.py 不存在**\n\n路径: \`${scriptPath}\``);
			return;
		}

		// 单只股票查询（不需要 watchlist）
		if (stockFilter) {
			const label = mode === "auction" ? "竞价查询" : "盘中查询";
			await this.adapter.reply(`📊 正在查询 ${stockFilter}...`);
			try {
				const args = [
					scriptPath,
					"--stock", stockFilter,
					"--mode", mode,
					"--output", "text",
					"--watchlist-dir", watchlistDir,
				];
				const output = execFileSync("/usr/bin/python3", args, { timeout: 15000, encoding: "utf-8" });
				await this.adapter.reply(output.trim() || `⚠️ ${label}无结果`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				await this.adapter.reply(`❌ **${label}失败**\n\n${msg.slice(0, 500)}`);
			}
			return;
		}

		// 全量扫描（自动按日期查找 watchlist-YYYYMMDD.json）
		const label = mode === "auction" ? "竞价速报" : "盘中速报";
		await this.adapter.reply(`📊 正在执行${label}...`);

		try {
			const output = execFileSync("/usr/bin/python3", [
				scriptPath,
				"--watchlist-dir", watchlistDir,
				"--mode", mode,
				"--output", "text",
			], { timeout: 15000, encoding: "utf-8" });

			if (output.trim()) {
				await this.adapter.reply(output.trim());
			} else {
				await this.adapter.reply(`⚠️ ${label}无输出，请检查脚本和数据。`);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[${label}] 执行失败:`, msg);
			await this.adapter.reply(`❌ **${label}执行失败**\n\n${msg.slice(0, 500)}`);
		}
	}

	// ──────────────────────────────────────────────────
	// /proplus - 急跌回踩 ProPlus 选股
	// ──────────────────────────────────────────────────

	async handleProPlus(dateArg?: string): Promise<void> {
		const scriptPath = resolve(HOME, "work/cursor/a-stock-hub/a-stock-pullback-strategy-python/openapi/proplus_push.py");
		const pythonPath = resolve(HOME, ".venvs/uv-env/bin/python3");

		if (!existsSync(scriptPath)) {
			await this.adapter.reply(`❌ **proplus_push.py 不存在**\n\n路径: \`${scriptPath}\``);
			return;
		}

		await this.adapter.reply(`📊 正在运行 ProPlus 急跌回踩选股${dateArg ? ` (${dateArg})` : ""}...`);

		try {
			const args = [scriptPath];
			if (dateArg) args.push(dateArg);
			const output = execFileSync(pythonPath, args, { timeout: 60000, encoding: "utf-8" });
			if (output.trim()) {
				await this.adapter.reply(output.trim());
			} else {
				await this.adapter.reply("⚠️ ProPlus 无输出，请检查脚本和数据。");
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error("[ProPlus] 执行失败:", msg);
			await this.adapter.reply(`❌ **ProPlus 执行失败**\n\n${msg.slice(0, 500)}`);
		}
	}

	// ──────────────────────────────────────────────────
	// /预案 - 查看预案核心决策树
	// ──────────────────────────────────────────────────

	/**
	 * 将 Markdown 表格和格式转换为手机友好的纯文本
	 * 处理新版4列表格(开盘|条件|信号|操作)和旧版3列(信号|条件|操作)
	 */
	private convertTableToMobileText(text: string, keepBold = false): string {
		const lines = text.split("\n");
		const result: string[] = [];
		let inTable = false;
		let tableHeaders: string[] = [];

		for (const line of lines) {
			const trimmed = line.trim();

			// 跳过表格分隔行 |---|---|
			if (/^\|[\s-|]+\|$/.test(trimmed)) {
				inTable = true;
				continue;
			}

			// 表格头行
			if (!inTable && /^\|.*\|$/.test(trimmed) && !trimmed.includes("---")) {
				tableHeaders = trimmed.split("|").filter(c => c.trim()).map(c => c.trim());
				inTable = true;
				continue;
			}

			// 表格数据行 → 转为纯文本
			if (inTable && /^\|.*\|$/.test(trimmed)) {
				const cells = trimmed.split("|").filter(c => c.trim()).map(c => c.trim());
				
				if (cells.length >= 4) {
					// 新版4列: 开盘|条件|信号|操作
					const [opening, condition, signal, action] = cells;
					const cleanAction = keepBold ? action : action.replace(/\*{2}/g, "");
					result.push(`${signal} ${opening}(${condition})`);
					result.push(`  → ${cleanAction}`);
					result.push("");  // 操作间空行分隔
				} else if (cells.length >= 3) {
					// 旧版3列 或 绝对不做表格
					const [c1, c2, c3] = cells;
					if (c1 === "❌") {
						result.push(`❌ ${c2}（${c3}）`);
					} else if (/^\d+$/.test(c1) || c1.startsWith("①") || c1.startsWith("②")) {
						// 关键验证点: #|验证项|依据
						result.push(`${c1} ${c2}：${c3}`);
					} else {
						const cleanC3 = keepBold ? c3 : c3.replace(/\*{2}/g, "");
						result.push(`${c1} ${c2} → ${cleanC3}`);
					}
				} else if (cells.length >= 2) {
					result.push(cells.join(" → "));
				}
				continue;
			}

			// 非表格行结束表格状态
			if (inTable && !/^\|/.test(trimmed)) {
				inTable = false;
				tableHeaders = [];
			}

			let cleaned = trimmed;
			if (!keepBold) {
				cleaned = cleaned.replace(/\*{2}([^*]+)\*{2}/g, "$1");
			}
			cleaned = cleaned
				.replace(/^#+\s*/, "")  // 移除 # 标题前缀
				.replace(/^---$/, "━━━━━━━━━━━━━━━━");  // 分隔线

			// 旧版树状格式兼容
			cleaned = cleaned
				.replace(/├\s*/g, "▸ ")
				.replace(/└\s*/g, "▸ ");

			result.push(cleaned);
		}

		return result.join("\n");
	}

	/**
	 * 按表格数量拆分内容，确保每段不超过 maxTables 个表格。
	 * 以 "---" 分隔线或 "**股票名" 行作为自然分段点。
	 */
	private splitByTableLimit(text: string, maxTables: number): string[] {
		// 按 "---" 分隔符拆分为自然段落
		const sections = text.split(/\n---\n/);
		const chunks: string[] = [];
		let currentChunk = "";
		let currentTableCount = 0;

		for (const section of sections) {
			const tableCount = (section.match(/^\|[-:\s|]+\|$/gm) || []).length;

			if (currentTableCount + tableCount > maxTables && currentChunk) {
				chunks.push(currentChunk.trim());
				currentChunk = section;
				currentTableCount = tableCount;
			} else {
				currentChunk += (currentChunk ? "\n---\n" : "") + section;
				currentTableCount += tableCount;
			}
		}

		if (currentChunk.trim()) {
			chunks.push(currentChunk.trim());
		}

		return chunks.length > 0 ? chunks : [text];
	}

	async handlePlan(args?: string): Promise<void> {
		const dailyDir = resolve(HOME, "work/cursor/taoguba/玫瑰龙头战法/06-daily");

		if (!existsSync(dailyDir)) {
			await this.adapter.reply("❌ 预案目录不存在");
			return;
		}

		const files = readdirSync(dailyDir)
			.filter(f => f.startsWith("预案-") && f.endsWith(".md"))
			.sort()
			.reverse();

		if (files.length === 0) {
			await this.adapter.reply("❌ 未找到任何预案文件");
			return;
		}

		let targetFile: string | undefined;

		if (args) {
			const dateStr = args.length === 4 ? `2026${args}` : args.replace(/-/g, "");
			const matched = files.filter(f => f.includes(dateStr));
			if (matched.length === 0) {
				await this.adapter.reply(`❌ 未找到日期 \`${args}\` 的预案\n\n最近预案：${files.slice(0, 5).map(f => `\`${f}\``).join("、")}`);
				return;
			}
			// 同日期多版本时取版本号最大的（v2 > v1 > 无版本号）
			matched.sort((a, b) => {
				const vA = a.match(/-v(\d+)/)?.[1] ?? "0";
				const vB = b.match(/-v(\d+)/)?.[1] ?? "0";
				return parseInt(vB) - parseInt(vA);
			});
			targetFile = matched[0];
		} else {
			targetFile = files[0];
		}

		if (!targetFile) {
			await this.adapter.reply("❌ 未找到匹配的预案");
			return;
		}

		const fullPath = resolve(dailyDir, targetFile);
		const content = readFileSync(fullPath, "utf-8");

		// 提取两个核心区块：精确操作手册 + 竞价验证
		const sections: string[] = [];

		// 1. 精确操作手册（买入/卖出分条列表）
		const manualMarkers = ["📋 精确操作手册", "精确操作手册"];
		let manualStart = -1;
		for (const m of manualMarkers) {
			manualStart = content.indexOf(m);
			if (manualStart !== -1) break;
		}
		if (manualStart !== -1) {
			// 提取范围：从精确操作手册到对抗验证之前（包含止损速查+关键验证点+绝对不做）
			const nextH2 = content.indexOf("\n## ", manualStart + 20);
			const sliceEnd = nextH2 !== -1 ? nextH2 : content.length;
			sections.push(content.slice(manualStart, sliceEnd).trim());
		}

		// 2. 竞价验证（在精确操作手册之前展示）
		const auctionMarkers = ["**竞价验证**", "竞价验证（"];
		let auctionStart = -1;
		for (const m of auctionMarkers) {
			auctionStart = content.indexOf(m);
			if (auctionStart !== -1) break;
		}
		if (auctionStart !== -1) {
			// 找"综合"行之后的下一个空行或分隔线作为结束
			const auctionEndMarkers = ["\n---\n", "\n### 核心决策链", "\n### 📋 精确操作手册"];
			let auctionEnd = -1;
			for (const m of auctionEndMarkers) {
				const idx = content.indexOf(m, auctionStart + 10);
				if (idx !== -1 && (auctionEnd === -1 || idx < auctionEnd)) {
					auctionEnd = idx;
				}
			}
			if (auctionEnd === -1) {
				auctionEnd = Math.min(auctionStart + 1500, content.length);
			}
			// 竞价验证放在操作手册前面
			sections.unshift(content.slice(auctionStart, auctionEnd).trim());
		}

		let output: string;

		if (sections.length > 0) {
			output = `📋 ${targetFile.replace(".md", "")}\n\n${sections.join("\n\n---\n\n")}`;
		} else {
			// 兜底：旧格式预案，提取决策链
			const dtMarkers = ["个股决策链", "个股决策", "决策树", "操作决策"];
			let dtStart = -1;
			for (const m of dtMarkers) {
				dtStart = content.indexOf(m);
				if (dtStart !== -1) break;
			}
			if (dtStart !== -1) {
				const slice = content.slice(dtStart, dtStart + 3000).trim();
				output = `📋 **${targetFile.replace(".md", "")}**\n\n${slice}\n\n> （旧版格式）`;
			} else {
				const lines = content.split("\n");
				const preview = lines.slice(0, 60).join("\n");
				output = `📋 **${targetFile.replace(".md", "")}**\n\n${preview}`;
			}
		}

		if (output.length > 4000) {
			output = output.slice(0, 3900) + "\n...\n（过长已截断）";
		}

		await this.adapter.reply(output);
	}

	// ──────────────────────────────────────────────────
	// /apk - 发送 Android APK
	// ──────────────────────────────────────────────────

	async handleSendApk(): Promise<void> {
		if (!this.adapter.sendFile) {
			await this.adapter.reply("❌ 当前平台不支持文件发送");
			return;
		}

		// 查找 Android 项目
		const androidProject = Object.entries(this.ctx.projectsConfig.projects).find(
			([, v]: [string, any]) => v.path.includes("android") || v.path.includes("Android")
		)?.[1] as any;

		if (!androidProject) {
			await this.adapter.reply(
				"❌ **未找到 Android 项目**\n\n请在 `projects.json` 中配置 Android 项目路径。\n\n示例：\n```json\n{\n  \"stock-android\": {\n    \"path\": \"/path/to/android\",\n    \"description\": \"Android App\"\n  }\n}\n```"
			);
			return;
		}

		const apkPath = resolve(androidProject.path, "app/build/outputs/apk/debug/app-debug.apk");

		if (!existsSync(apkPath)) {
			await this.adapter.reply(`❌ **APK 文件未找到**\n\n路径: \`${apkPath}\`\n\n请先编译 Android 项目。`);
			return;
		}

		const stats = statSync(apkPath);
		const fileSize = stats.size;
		const maxSize =
			this.ctx.platform === "wecom" ? 20 * 1024 * 1024 : 30 * 1024 * 1024;
		const modTime = new Date(stats.mtime).toLocaleString("zh-CN");

		if (fileSize > maxSize) {
			const limit = this.ctx.platform === "wecom" ? "20MB" : "30MB";
			await this.adapter.reply(`❌ **文件太大**\n\n文件大小: ${(fileSize / 1024 / 1024).toFixed(2)}MB\n限制: ${limit}`);
			return;
		}

		try {
			await this.adapter.reply(
				`📤 **正在发送 APK...**\n\n文件: app-debug.apk\n大小: ${(fileSize / 1024 / 1024).toFixed(2)}MB\n编译时间: ${modTime}`
			);

			const projectName = androidProject.description || "Android App";
			const fileName = `${projectName.replace(/\s+/g, "-").toLowerCase()}.apk`;

			await this.adapter.sendFile(apkPath, fileName);

			console.log(`[指令] APK 发送成功: ${fileName} (${(fileSize / 1024 / 1024).toFixed(2)}MB)`);
		} catch (err) {
			console.error(`[指令] APK 发送失败:`, err);
			await this.adapter.reply(`❌ **发送失败**\n\n错误: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// ──────────────────────────────────────────────────
	// /发送文件 - 发送本地文件
	// ──────────────────────────────────────────────────

	async handleSendFile(filePath: string): Promise<void> {
		if (!this.adapter.sendFile) {
			await this.adapter.reply("❌ 当前平台不支持文件发送");
			return;
		}

		// Bug #25 修复：防止路径遍历漏洞
		let expandedPath: string;
		if (filePath.startsWith("~/")) {
			// 安全展开 ~ 路径：移除 ~/ 前缀后，确保不包含路径遍历符号
			const relativePath = filePath.slice(2); // 去掉 ~/
			if (relativePath.includes("..")) {
				await this.adapter.reply("❌ **非法路径**\n\n路径不能包含 `..` 符号。\n\n请使用绝对路径或 ~/path 格式。");
				return;
			}
			expandedPath = resolve(HOME, relativePath);
		} else if (filePath === "~") {
			expandedPath = HOME;
		} else {
			expandedPath = resolve(filePath);
		}

		console.log(`[指令] 发送文件: ${expandedPath}`);

		if (!existsSync(expandedPath)) {
			await this.adapter.reply(`❌ **文件不存在**\n\n路径: \`${expandedPath}\`\n\n请检查文件路径是否正确。`);
			return;
		}

		const stats = statSync(expandedPath);
		const fileSize = stats.size;
		const maxSize =
			this.ctx.platform === "wecom" ? 20 * 1024 * 1024 : 30 * 1024 * 1024;

		if (fileSize > maxSize) {
			const limit = this.ctx.platform === "wecom" ? "20MB" : "30MB";
			await this.adapter.reply(`❌ **文件太大**\n\n文件大小: ${(fileSize / 1024 / 1024).toFixed(2)}MB\n限制: ${limit}\n\n请选择较小的文件。`);
			return;
		}

		try {
			const fileName = expandedPath.split("/").pop() || "file";

			await this.adapter.reply(`📤 **正在发送文件...**\n\n文件: \`${fileName}\`\n大小: ${(fileSize / 1024 / 1024).toFixed(2)}MB`);

			await this.adapter.sendFile(expandedPath, fileName);

			console.log(`[指令] 文件发送成功: ${fileName} (${(fileSize / 1024 / 1024).toFixed(2)}MB)`);
		} catch (err) {
			console.error(`[指令] 文件发送失败:`, err);
			await this.adapter.reply(`❌ **发送失败**\n\n错误: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// ──────────────────────────────────────────────────
	// /ide — 投递消息到 IDE Feedback Gate 队列
	// ──────────────────────────────────────────────────

	private getIdeSessions(): { pid: number; project: string; cwd: string }[] {
		const tmpDir = process.platform === 'win32'
			? (process.env.TEMP || process.env.TMP || 'C:\\Temp')
			: '/tmp';
		const sessions: { pid: number; project: string; cwd: string }[] = [];
		for (const f of readdirSync(tmpDir).filter(
			f => f.startsWith('feedback_gate_session_') && f.endsWith('.json')
		)) {
			try {
				const raw = readFileSync(resolve(tmpDir, f), 'utf8');
				const data = JSON.parse(raw);
				process.kill(data.pid, 0);
				sessions.push({ pid: data.pid, project: data.project || 'unknown', cwd: data.cwd || '' });
			} catch {}
		}
		return sessions;
	}

	private async handleIde(text: string, chatId?: string): Promise<boolean> {
		const content = text.replace(/^\/ide\s*/i, '').trim();

		if (/^on$/i.test(content)) {
			if (!chatId) {
				await this.adapter.reply('❌ 无法开启转发模式（缺少 chatId）');
				return true;
			}
			const sessions = this.getIdeSessions();
			if (sessions.length === 0) {
				await this.adapter.reply('❌ 当前没有活跃的 Feedback Gate 实例，无法开启转发模式');
				return true;
			}
			CommandHandler.ideForwardEnabled.set(chatId, true);
			const list = sessions.map((s, i) => `  ${i + 1}. ${s.project} (PID ${s.pid})`).join('\n');
			await this.adapter.reply(`✅ IDE 转发模式已开启\n\n所有非命令消息将自动投递到 IDE Feedback Gate\n\n🖥️ 活跃实例:\n${list}\n\n发送 \`/ide off\` 关闭`);
			return true;
		}
		if (/^off$/i.test(content)) {
			if (chatId) CommandHandler.ideForwardEnabled.delete(chatId);
			await this.adapter.reply('✅ IDE 转发模式已关闭');
			return true;
		}

		const sessions = this.getIdeSessions();

		if (sessions.length === 0 && chatId && CommandHandler.ideForwardEnabled.get(chatId)) {
			CommandHandler.ideForwardEnabled.delete(chatId);
		}

		const forwardStatus = chatId && CommandHandler.ideForwardEnabled.get(chatId)
			? '\n🟢 转发模式：已开启（发 `/ide off` 关闭）'
			: '\n⚪ 转发模式：未开启（发 `/ide on` 开启）';
		if (!content) {
			if (sessions.length === 0) {
				await this.adapter.reply(
					`📋 **/ide 指令用法**\n\n\`/ide <消息>\` — 投递消息到 IDE Feedback Gate 队列\n\`/ide #序号 <消息>\` — 指定窗口\n\`/ide on\` — 开启转发模式（所有消息自动投递）\n\`/ide off\` — 关闭转发模式\n\n⚠️ 当前没有活跃的 Feedback Gate 实例${forwardStatus}`
				);
			} else {
				const list = sessions.map((s, i) =>
					`  ${i + 1}. **${s.project}** (PID ${s.pid})`
				).join('\n');
				await this.adapter.reply(
					`📋 **/ide 指令用法**\n\n\`/ide <消息>\` — 投递到唯一实例或广播\n\`/ide #序号 <消息>\` — 指定窗口\n\`/ide #PID <消息>\` — 按 PID 指定\n\`/ide on\` — 开启转发模式\n\`/ide off\` — 关闭转发模式\n\n🖥️ 活跃实例:\n${list}${forwardStatus}`
				);
			}
			return true;
		}

		if (sessions.length === 0) {
			await this.adapter.reply(
				'❌ 当前没有活跃的 Feedback Gate，消息未投递\n\n请先在 Cursor 中启动 Feedback Gate 后再试'
			);
			return true;
		}

		let target: { pid: number; project: string } | null = null;
		let messageText = content;

		const hashMatch = content.match(/^#(\S+)\s+([\s\S]+)/);
		if (hashMatch) {
			const selector = hashMatch[1]!;
			messageText = hashMatch[2]!.trim();
			const idx = parseInt(selector, 10);
			if (!isNaN(idx) && idx >= 1 && idx <= sessions.length) {
				target = sessions[idx - 1]!;
			} else {
				const pid = parseInt(selector, 10);
				target = sessions.find(s => s.pid === pid) || null;
			}
			if (!target) {
				const list = sessions.map((s, i) =>
					`  ${i + 1}. **${s.project}** (PID ${s.pid})`
				).join('\n');
				await this.adapter.reply(
					`❌ 未找到匹配的实例: #${selector}\n\n🖥️ 可用实例:\n${list}`
				);
				return true;
			}
		} else if (sessions.length === 1) {
			target = sessions[0]!;
		}

		if (!messageText) {
			await this.adapter.reply('❌ 消息内容不能为空');
			return true;
		}

		const tmpDir = process.platform === 'win32'
			? (process.env.TEMP || process.env.TMP || 'C:\\Temp')
			: '/tmp';

		const targets = target ? [target] : sessions;

		const entry = JSON.stringify({
			id: `ide_queue_${Date.now()}`,
			text: messageText,
			source: this.ctx.platform,
			chatId: chatId || '',
			ts: new Date().toISOString()
		});

		try {
			for (const t of targets) {
				appendFileSync(resolve(tmpDir, `feedback_gate_ide_queue_${t.pid}.jsonl`), entry + '\n');
			}
			const time = new Date().toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
			if (targets.length === 1) {
				await this.adapter.reply(
					`✅ 已投递到 IDE 队列\n\n📝 ${messageText}\n🕐 ${time}\n🖥️ ${targets[0]!.project} (PID ${targets[0]!.pid})\n\n当 Agent 下次调用时将自动出队处理`
				);
			} else {
				const list = targets.map(t => `  • ${t.project} (PID ${t.pid})`).join('\n');
				await this.adapter.reply(
					`✅ 已广播到 ${targets.length} 个 IDE 实例\n\n📝 ${messageText}\n🕐 ${time}\n${list}\n\n💡 可用 \`/ide #序号 消息\` 指定单个窗口`
				);
			}
		} catch (e) {
			await this.adapter.reply(`❌ IDE 队列投递失败: ${(e as Error).message}`);
		}
		return true;
	}

	// ──────────────────────────────────────────────────
	// 命令路由 - 统一入口
	// ──────────────────────────────────────────────────

	async route(text: string, updateSessionCallback?: (sessionId: string) => void, options?: { chatId?: string }): Promise<boolean> {
		// IDE 转发模式：非命令消息自动当 /ide 处理
		if (options?.chatId && CommandHandler.ideForwardEnabled.get(options.chatId)
			&& text.trim() && !text.trim().startsWith('/')) {
			const sessions = this.getIdeSessions();
			if (sessions.length === 0) {
				CommandHandler.ideForwardEnabled.delete(options.chatId);
				await this.adapter.reply('⚠️ IDE 转发模式已自动关闭（没有活跃的 Feedback Gate 实例）');
				return true;
			}
			return this.handleIde(`/ide ${text}`, options.chatId);
		}

		// /ide — 投递到 IDE Feedback Gate 队列
		if (/^\/ide\b/i.test(text.trim())) {
			return this.handleIde(text, options?.chatId);
		}

		// /help、/帮助
		if (/^\/(help|帮助|指令)\s*$/i.test(text.trim())) {
			await this.handleHelp();
			return true;
		}

		// /status、/状态
		if (/^\/(status|状态)\s*$/i.test(text.trim())) {
			await this.handleStatus();
			return true;
		}

		// /restart all、/重启全部（先匹配，避免被 /重启 规则吃掉）
		if (/^\/(restart\s+all|重启全部)\s*$/i.test(text.trim())) {
			await this.handleRestartAll();
			return true;
		}

		// /restart、/重启
		if (/^\/(restart|重启)\s*$/i.test(text.trim())) {
			await this.handleRestart();
			return true;
		}

		// /new、/新对话
		const newMatch = text.trim().match(/^\/(new|新对话|新会话)(?:\s+(.+))?$/i);
		if (newMatch) {
			const args = newMatch[2]?.trim();
			await this.handleNew(args);
			return true;
		}

		// /项目、/project
		if (/^\/(项目|project)\s*$/i.test(text.trim())) {
			await this.handleProject();
			return true;
		}

		// /stop、/终止
		const stopMatch = text.trim().match(/^\/(stop|终止|停止)(?:\s+(.+))?$/i);
		if (stopMatch) {
			const projectHint = stopMatch[2]?.trim();
			await this.handleStop(projectHint);
			return true;
		}

		// /model、/模型
		const modelMatch = text.match(/^\/(model|模型|切换模型)[\s:：]*(.*)/i);
		if (modelMatch) {
			await this.handleModel((modelMatch[2] ?? "").trim());
			return true;
		}

		// /apikey、/密钥
		const apiKeyMatch = text.match(/^\/?(?:apikey|api\s*key|密钥|换key|更换密钥)[\s:：]*(.*)/i);
		if (apiKeyMatch) {
			await this.handleApiKey((apiKeyMatch[1] ?? "").trim());
			return true;
		}

		// /黑名单、/配额
		const blacklistMatch = text.match(/^\/(黑名单|配额|quota|blacklist)[\s:：]*(.*)/i);
		if (blacklistMatch) {
			await this.handleBlacklist((blacklistMatch[2] ?? "").trim());
			return true;
		}

		// /会话、/sessions
		const sessionMatch = text.match(/^\/(会话|sessions?)[\s:：=]*(.*)/i);
		if (sessionMatch) {
			await this.handleSession((sessionMatch[2] ?? "").trim(), updateSessionCallback);
			return true;
		}

		// /任务、/cron
		const taskMatch = text.match(/^\/(任务|cron|定时|task|schedule|定时任务)[\s:：]*(.*)/i);
		if (taskMatch) {
			await this.handleTask((taskMatch[2] ?? "").trim());
			return true;
		}

		// /心跳、/heartbeat
		const heartbeatMatch = text.match(/^\/(心跳|heartbeat|hb)[\s:：]*(.*)/i);
		if (heartbeatMatch) {
			await this.handleHeartbeat((heartbeatMatch[2] ?? "").trim());
			return true;
		}

		// /记忆、/memory
		const memoryMatch = text.match(/^\/(记忆|memory)[\s:：]*(.*)/i);
		if (memoryMatch) {
			await this.handleMemory((memoryMatch[2] ?? "").trim());
			return true;
		}

		// /记录
		const logMatch = text.match(/^\/(记录|log)[\s:：]+(.+)/i);
		if (logMatch && logMatch[2] != null) {
			await this.handleLog(logMatch[2]);
			return true;
		}

		// /整理记忆、/reindex
		if (/^\/(整理记忆|reindex|索引)\s*$/i.test(text.trim())) {
			await this.handleReindex();
			return true;
		}

		// /新闻状态
		if (text.match(/^\/(新闻状态|news\s+status)[\s:：]*$/i)) {
			await this.handleNewsStatus();
			return true;
		}

		// /github - GitHub Trending
		const githubMatch = text.match(/^\/(github|trending|GitHub)\s*(.*)/i);
		if (githubMatch) {
			await this.handleGithubTrending((githubMatch[2] ?? "").trim() || undefined);
			return true;
		}

		// /天气 - 查询天气
		const weatherMatch = text.match(/^\/(天气|weather)\s*(.*)/i);
		if (weatherMatch) {
			await this.handleWeatherNow((weatherMatch[2] ?? "").trim() || undefined);
			return true;
		}

		// /新闻 - 立即推送
		const newsNowMatch = text.match(/^\/(新闻|news)\s*$/i);
		if (newsNowMatch) {
			await this.handleNewsNow(15);
			return true;
		}

		// /飞连、/vpn
		const feilianMatch = text.match(/^\/(飞连|vpn|feilian)[\s:：]*(.*)/i);
		if (feilianMatch) {
			await this.handleFeilian((feilianMatch[2] ?? "").trim());
			return true;
		}

		// /私人 - 私人命令列表
		if (/^\/(私人|private|我的)\s*$/i.test(text.trim())) {
			await this.handlePrivate();
			return true;
		}

		// /预案 - 查看预案决策树 / 生成次日预案 / 玫瑰观点比对
		const planMatch = text.trim().match(/^\/(预案|plan)(?:\s+(.+))?$/i);
		if (planMatch) {
			const planArg = (planMatch[2] ?? "").trim();
			if (/^(生成|generate|新建|create|玫瑰|meigui|对比|比对)$/i.test(planArg)) {
				// 需要 AI 处理：生成预案 / 玫瑰观点比对
				return false;
			}
			await this.handlePlan(planArg || undefined);
			return true;
		}

		// /竞价 - 无参数走脚本；有参数（AI/股票名）走 AI 对话
		const auctionMatch = text.trim().match(/^\/(竞价|auction)(?:\s+(.+))?$/i);
		if (auctionMatch) {
			const subArg = (auctionMatch[2] ?? "").trim();
			if (!subArg) {
				// 无参数 → 脚本快速速报
				await this.handleStockScan("auction");
				return true;
			}
			// 有参数（"AI"、"全部"、股票名等）→ 交给 AI 对话
			return false;
		}

		// /盘中 - 无参数走脚本；有参数（AI/股票名）走 AI 对话
		const panzhongMatch = text.trim().match(/^\/(盘中|intraday)(?:\s+(.+))?$/i);
		if (panzhongMatch) {
			const subArg = (panzhongMatch[2] ?? "").trim();
			if (!subArg) {
				// 无参数 → 脚本快速速报
				await this.handleStockScan("intraday");
				return true;
			}
			// 有参数（"AI"、"全部"、股票名等）→ 交给 AI 对话
			return false;
		}

		// /急跌选股 - ProPlus 急跌回踩选股
		const proPlusMatch = text.trim().match(/^\/(急跌选股|急跌|proplus)(?:\s+(.+))?$/i);
		if (proPlusMatch) {
			const dateArg = (proPlusMatch[2] ?? "").trim() || undefined;
			await this.handleProPlus(dateArg);
			return true;
		}

		// /apk、/sendapk（所有平台支持）
		if (/^\/(apk|sendapk)\s*$/i.test(text.trim())) {
			await this.handleSendApk();
			return true;
		}

		// /发送文件（所有平台支持）
		const sendFileMatch = text.match(/^\/(发送文件|sendfile|send|发送)[\s:：]+(.+)/i);
		if (sendFileMatch && sendFileMatch[2] != null) {
			await this.handleSendFile(sendFileMatch[2].trim());
			return true;
		}

		// 自然语言定时任务检测（不以 / 开头的调度请求）
		const nlSchedule = parseChineseSchedule(text);
		if (nlSchedule) {
			const remaining = nlSchedule.remaining.toLowerCase();
			
			if (/天气|weather|气温|穿衣/.test(remaining)) {
				await this.handleWeatherNow(`${text}`);
				return true;
			}
			
			if (/github|trending|热榜|趋势/.test(remaining)) {
				const cleanArgs = remaining.replace(/(?:推送|发送|给我|通知|提醒)\s*/g, '').replace(/github\s*trending?/i, '').trim();
				const schedText = text.match(/(每天|每日|工作日).*?[点时]/)?.[0] || '';
				await this.handleGithubTrending(`${schedText} ${cleanArgs}`.trim());
				return true;
			}
			
			if (/新闻|热点|news|资讯/.test(remaining)) {
				const topNMatch = remaining.match(/(\d+)\s*条/);
				const topN = topNMatch ? parseInt(topNMatch[1]!, 10) : 15;
				const job = await this.ctx.scheduler.add({
					name: `${nlSchedule.label} 推送${topN}条热点`,
					enabled: true,
					schedule: { kind: 'cron', expr: nlSchedule.cronExpr, tz: 'Asia/Shanghai' },
					task: { type: 'fetch-news', options: { topN } },
					message: 'fetch-news',
					platform: this.ctx.platform,
				});
				await this.adapter.reply(
					`✅ **新闻定时任务已创建**\n\n` +
					`📋 ${job.name}\n` +
					`⏰ ${nlSchedule.label}\n` +
					`📰 每次推送 ${topN} 条\n\n` +
					`管理任务：\`/任务\``
				);
				return true;
			}
		}

		// 未匹配任何命令
		return false;
	}
}
