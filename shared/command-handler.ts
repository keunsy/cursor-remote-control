/**
 * 统一命令处理器 — 三平台共享
 *
 * 抽取飞书、钉钉、企业微信的共同命令处理逻辑，
 * 通过适配器模式处理平台差异。
 */

import { resolve } from "node:path";
import { readFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { Scheduler } from "./scheduler.js";
import type { MemoryManager } from "./memory.js";
import type { HeartbeatRunner } from "./heartbeat.js";
import { FeilianController, type OperationResult } from "./feilian-control.js";
import { fetchNews } from "./news-fetcher.js";
import { getHealthStatus } from "./news-sources/monitoring.js";
import { humanizeCronInChinese } from "cron-chinese";

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
	platform: "feishu" | "dingtalk" | "wecom";
	projectsConfig: any;
	defaultWorkspace: string;
	memoryWorkspace: string;
	config: any;
	scheduler: Scheduler;
	memory: MemoryManager | null;
	heartbeat: HeartbeatRunner;
	activeAgents: Map<string, any>;
	busySessions: Set<string>;
	sessionsStore: Map<string, any>;
	getCurrentProject: (defaultWs: string) => string | null;
	getLockKey: (workspace: string) => string;
	archiveAndResetSession: (workspace: string) => void;
	getSessionHistory: (workspace: string, limit?: number) => any[];
	getActiveSessionId: (workspace: string) => string | null;
	switchToSession: (workspace: string, sessionId: string) => boolean;
	rootDir: string;
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

	constructor(adapter: PlatformAdapter, context: CommandContext) {
		this.adapter = adapter;
		this.ctx = context;
	}

	// ──────────────────────────────────────────────────
	// /帮助 - 显示所有命令
	// ──────────────────────────────────────────────────

	async handleHelp(): Promise<void> {
		const platformName = this.ctx.platform === "feishu" ? "飞书" : this.ctx.platform === "dingtalk" ? "钉钉" : "企业微信";
		const projects = Object.keys(this.ctx.projectsConfig.projects).map(k => `\`${k}\``).join("、");

		const helpText = [
			"**基础指令**",
			"- `/帮助` `/help` — 显示本帮助",
			"- `/状态` `/status` — 查看服务状态",
			"- `/项目` `/project` — 列出所有项目",
			"- `/新对话` `/new` — 重置当前会话",
			"- `/终止 [项目名]` `/stop` — 终止正在执行的任务",
			"",
			"**热点 / 新闻**",
			"- `/新闻` `/news` — **立即推送**今日热点（直接发 `/新闻`）；定时例：`/新闻 每天9点 推送10条`",
			"- `/新闻状态` `/news status` — 各数据源是否可用",
			"- 也可说：「每天9点推送热点」「30分钟后推送10条新闻」等自动建定时任务",
			"",
			"**会话管理**",
			"- `/会话` `/sessions` — 查看最近会话列表",
			"- `/会话 编号` — 切换到指定会话",
			"",
			"**模型与密钥**",
			"- `/模型` `/model` — 查看/切换 AI 模型",
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

		// 企业微信和飞书支持文件发送
		if (this.ctx.platform !== "dingtalk") {
			helpText.push(
				"**文件操作**",
				"- `/apk` `/sendapk` — 快速发送 Android APK（需配置 Android 项目）",
				"- `/发送文件 路径` — 发送任意本地文件",
				"- 示例: `/发送文件 ~/document.pdf`",
				""
			);
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
			"**飞连 VPN 控制**",
			"- `/飞连` `/vpn` — 切换 VPN 状态",
			"- `/飞连 开` — 确保 VPN 连接",
			"- `/飞连 关` — 断开 VPN",
			"- `/飞连 状态` — 查询连接状态",
			"",
			"**项目路由**",
			"· 对话切换：说「切到 remote」等可持久切换",
			"· 前缀指定：`项目名:消息` 或 `#项目名 消息`",
			`· 可用项目：${projects}`,
		);

		await this.adapter.reply(`📖 **使用帮助**\n\n${helpText.join("\n")}`);
	}

	// ──────────────────────────────────────────────────
	// /状态 - 查看服务状态
	// ──────────────────────────────────────────────────

	async handleStatus(): Promise<void> {
		const { config, projectsConfig, memoryWorkspace, memory, scheduler, heartbeat, activeAgents, sessionsStore } = this.ctx;

		// 平台特定的配置预览
		let credentialPreview = "";
		if (this.ctx.platform === "wecom") {
			credentialPreview = config.WECOM_BOT_ID ? `\`...${config.WECOM_BOT_ID.slice(-8)}\`` : "**未设置**";
		} else if (this.ctx.platform === "feishu") {
			credentialPreview = config.FEISHU_APP_ID ? `\`...${config.FEISHU_APP_ID.slice(-8)}\`` : "**未设置**";
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

		const platformLabel = this.ctx.platform === "wecom" ? "BotID" : this.ctx.platform === "feishu" ? "AppID" : "AppKey";

		const statusText = [
			`**${platformLabel}：** ${credentialPreview}`,
			`**Key：** ${keyPreview}`,
			`**模型：** \`${config.CURSOR_MODEL}\``,
			`**记忆：** ${memStatus}`,
			`**调度：** ${schedText}`,
			`**心跳：** ${hbText}`,
			`**活跃任务：** ${activeAgents.size} 个运行中`,
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
	// /新对话 - 重置会话
	// ──────────────────────────────────────────────────

	async handleNew(): Promise<void> {
		const currentProject = this.ctx.getCurrentProject(this.ctx.defaultWorkspace) || this.ctx.projectsConfig.default_project;
		const workspace = this.ctx.projectsConfig.projects[currentProject]?.path || this.ctx.defaultWorkspace;

		// Bug 修复: 检查是否有正在运行的任务
		for (const [lk, agent] of this.ctx.activeAgents.entries()) {
			if (agent.workspace === workspace) {
				await this.adapter.reply(
					`⚠️ **当前项目有任务正在运行**\n\n请先使用 \`/终止\` 命令停止任务，再开始新对话。\n\n或者等待当前任务完成后再发送 \`/新对话\`。`
				);
				return;
			}
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
		const { projectsConfig, activeAgents, busySessions, sessionsStore } = this.ctx;

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
				for (const [workspace, wsData] of sessionsStore.entries() as [string, any][]) {
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

		if (projectHint) {
			if (!projectsConfig.projects[projectHint]) {
				const available = Object.keys(projectsConfig.projects).map(k => `\`${k}\``).join("、");
				await this.adapter.reply(`❌ **项目不存在**\n\n未找到项目 \`${projectHint}\`\n\n可用项目：${available}`);
				return;
			}
			const wsPath = projectsConfig.projects[projectHint].path;
			
			// Bug 修复: 不依赖 getLockKey，直接通过 workspace 匹配（因为 lockKey 可能在运行时变化）
			// 终止所有匹配的任务（理论上应该只有一个，但为了健壮性处理多个）
			const matchedTasks: Array<{ lockKey: string; agent: any }> = [];
			for (const [lk, agent] of activeAgents.entries()) {
				if (agent.workspace === wsPath) {
					matchedTasks.push({ lockKey: lk, agent });
				}
			}
			
			if (matchedTasks.length > 0) {
				for (const { lockKey: lk, agent } of matchedTasks) {
					agent.kill();
					activeAgents.delete(lk);
					busySessions.delete(lk);
					console.log(`[指令] 终止 agent pid=${agent.pid} project=${projectHint} session=${lk}`);
				}
				const countText = matchedTasks.length > 1 ? `${matchedTasks.length} 个任务` : "任务";
				await this.adapter.reply(`已终止项目 **${projectHint}** 的${countText}。\n\n发送新消息将继续在当前会话中对话。`);
			} else {
				await this.adapter.reply(`项目 **${projectHint}** 没有正在运行的任务。`);
			}
			return;
		}

		if (activeAgents.size === 0) {
			await this.adapter.reply("当前没有正在运行的任务。");
			return;
		}

		if (activeAgents.size === 1) {
			const [lk, agent] = [...activeAgents][0];
			const projectName = getProjectNameByLockKey(lk) || "当前项目";
			agent.kill();
			activeAgents.delete(lk);
			busySessions.delete(lk);
			console.log(`[指令] 终止 agent pid=${agent.pid} session=${lk}`);
			await this.adapter.reply(`✅ 已终止 **${projectName}** 的任务。`);
			return;
		}

		const tasks = [...activeAgents.entries()].map(([lk, agent], i) => {
			const projectName = getProjectNameByLockKey(lk) || "未知项目";
			return `${i + 1}. **${projectName}**\n   会话: \`${lk.slice(0, 20)}...\`\n   PID: ${agent.pid}`;
		});

		await this.adapter.reply(
			`**当前运行中（${activeAgents.size} 个）**\n\n${tasks.join("\n\n")}\n\n> 发送 \`/终止 项目名\` 可终止指定项目的任务`
		);
	}

	// ──────────────────────────────────────────────────
	// /模型 - 切换 AI 模型
	// ──────────────────────────────────────────────────

	async handleModel(args: string): Promise<void> {
		const models = [
			{ name: "opus-4.6-thinking", desc: "Claude Opus 4.6 (thinking)" },
			{ name: "opus-4", desc: "Claude Opus 4" },
			{ name: "sonnet-4", desc: "Claude Sonnet 4" },
			{ name: "o1-mini", desc: "GPT-4 O1 Mini" },
			{ name: "o1", desc: "GPT-4 O1" },
			{ name: "gpt-4o", desc: "GPT-4 Turbo" },
			{ name: "auto", desc: "Auto（推荐，省配额）" },
		];

		if (!args) {
			const lines = models.map((m, i) => {
				const isCurrent = this.ctx.config.CURSOR_MODEL === m.name;
				return isCurrent ? `**${i + 1}. ${m.desc}** ✅\n   \`${m.name}\`` : `${i + 1}. ${m.desc}\n   \`${m.name}\``;
			});
			lines.push("", "**用法：**", "· `/模型 编号` — 切换到指定模型", "· `/模型 名称` — 切换到指定模型（如 `/模型 auto`）");
			await this.adapter.reply(`**可用模型（共 ${models.length} 个）**\n\n${lines.join("\n")}`);
			return;
		}

		const num = Number.parseInt(args, 10);
		let targetModel: string | null = null;

		if (!Number.isNaN(num) && num >= 1 && num <= models.length) {
			targetModel = models[num - 1].name;
		} else {
			const found = models.find((m) => m.name.toLowerCase() === args.toLowerCase());
			if (found) targetModel = found.name;
		}

		if (!targetModel) {
			await this.adapter.reply("❌ 无效的模型编号或名称。\n\n发送 `/模型` 查看可用模型列表。");
			return;
		}

	this.ctx.config.CURSOR_MODEL = targetModel;
	const envPath = resolve(this.ctx.rootDir, this.ctx.platform, ".env");
	try {
		const raw = readFileSync(envPath, "utf-8");
		const lines = raw.split("\n");
		let found = false;
		const updated = lines.map((line) => {
			if (line.trim().startsWith("CURSOR_MODEL=") || line.trim().startsWith("#CURSOR_MODEL=")) {
				found = true;
				return `CURSOR_MODEL=${targetModel}`;
			}
			return line;
		});
		if (!found) updated.push(`CURSOR_MODEL=${targetModel}`);
		const fs = await import("node:fs/promises");
		await fs.writeFile(envPath, updated.join("\n"), "utf-8");
		await this.adapter.reply(`✅ **已切换模型**\n\n当前模型：\`${targetModel}\`\n\n新会话将使用此模型。`);
	} catch (error) {
		console.error("[模型切换] 写入 .env 失败", error);
		await this.adapter.reply(`❌ 切换失败\n\n${error instanceof Error ? error.message : String(error)}`);
	}
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
			await this.adapter.reply(
				result.status === "ok" ? `✅ **检查完成**\n\n${result.report || ""}` : `❌ **检查失败**\n\n${result.error || ""}`
			);
			return;
		}

		const intervalMatch = subCmd.match(/^(间隔|interval)\s+(\d+)/i);
		if (intervalMatch) {
			const minutes = Number.parseInt(intervalMatch[2], 10);
			if (minutes < 1 || minutes > 1440) {
				await this.adapter.reply("❌ 间隔必须在 1-1440 分钟之间。");
				return;
			}
			await this.ctx.heartbeat.setInterval(minutes * 60 * 1000);
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
			const results = await memory.search(args, { limit: 5 });
			if (results.length === 0) {
				await this.adapter.reply(`未找到与「${args}」相关的记忆。`);
				return;
			}

			const lines = results.map((r, i) => {
				const time = new Date(r.timestamp).toLocaleDateString("zh-CN");
				const preview = r.content.slice(0, 100);
				return `**${i + 1}. ${r.file}**\n   ${time}\n   ${preview}${r.content.length > 100 ? "..." : ""}`;
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

			await memory.indexFile(diaryFile);

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
			await memory.reindex();
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

		let result: OperationResult;

		if (!subCmd || subCmd === "toggle" || subCmd === "切换") {
			result = await controller.toggle();
		} else if (subCmd === "on" || subCmd === "开" || subCmd === "连接" || subCmd === "开启") {
			result = await controller.ensureConnected();
		} else if (subCmd === "off" || subCmd === "关" || subCmd === "断开" || subCmd === "关闭") {
			result = await controller.ensureDisconnected();
		} else if (subCmd === "status" || subCmd === "状态") {
			result = await controller.getStatus();
		} else {
			await this.adapter.reply(
				"❌ 未知操作\n\n可用操作：\n- `/飞连` — 切换状态\n- `/飞连 开` — 确保连接\n- `/飞连 关` — 断开\n- `/飞连 状态` — 查询状态"
			);
			return;
		}

		const statusEmoji = result.connected ? "✅" : "⏸️";
		const actionDesc = result.action === "toggled-on" ? "已开启"
			: result.action === "toggled-off" ? "已断开"
			: result.action === "already-on" ? "已是开启状态"
			: result.action === "already-off" ? "已是关闭状态"
			: result.action === "status" ? "当前状态"
			: "操作完成";

		const content = [
			`${statusEmoji} **${actionDesc}**`,
			"",
			`**VPN 状态：** ${result.connected ? "🟢 已连接" : "⚪ 未连接"}`,
			result.message ? `\n> ${result.message}` : "",
		].join("\n");

		await this.adapter.reply(content);
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
		const maxSize = this.ctx.platform === "feishu" ? 30 * 1024 * 1024 : 20 * 1024 * 1024;
		const modTime = new Date(stats.mtime).toLocaleString("zh-CN");

		if (fileSize > maxSize) {
			const limit = this.ctx.platform === "feishu" ? "30MB" : "20MB";
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
		const maxSize = this.ctx.platform === "feishu" ? 30 * 1024 * 1024 : 20 * 1024 * 1024;

		if (fileSize > maxSize) {
			const limit = this.ctx.platform === "feishu" ? "30MB" : "20MB";
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
	// 命令路由 - 统一入口
	// ──────────────────────────────────────────────────

	async route(text: string, updateSessionCallback?: (sessionId: string) => void): Promise<boolean> {
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

		// /new、/新对话
		if (/^\/(new|新对话|新会话)\s*$/i.test(text.trim())) {
			await this.handleNew();
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
			await this.handleModel(modelMatch[2].trim());
			return true;
		}

		// /apikey、/密钥
		const apiKeyMatch = text.match(/^\/?(?:apikey|api\s*key|密钥|换key|更换密钥)[\s:：]*(.*)/i);
		if (apiKeyMatch) {
			await this.handleApiKey(apiKeyMatch[1].trim());
			return true;
		}

		// /会话、/sessions
		const sessionMatch = text.match(/^\/(会话|sessions?)[\s:：=]*(.*)/i);
		if (sessionMatch) {
			await this.handleSession(sessionMatch[2].trim(), updateSessionCallback);
			return true;
		}

		// /任务、/cron
		const taskMatch = text.match(/^\/(任务|cron|定时|task|schedule|定时任务)[\s:：]*(.*)/i);
		if (taskMatch) {
			await this.handleTask(taskMatch[2].trim());
			return true;
		}

		// /心跳、/heartbeat
		const heartbeatMatch = text.match(/^\/(心跳|heartbeat|hb)[\s:：]*(.*)/i);
		if (heartbeatMatch) {
			await this.handleHeartbeat(heartbeatMatch[2].trim());
			return true;
		}

		// /记忆、/memory
		const memoryMatch = text.match(/^\/(记忆|memory)[\s:：]*(.*)/i);
		if (memoryMatch) {
			await this.handleMemory(memoryMatch[2].trim());
			return true;
		}

		// /记录
		const logMatch = text.match(/^\/(记录|log)[\s:：]+(.+)/i);
		if (logMatch) {
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

		// /新闻 - 立即推送
		const newsNowMatch = text.match(/^\/(新闻|news)\s*$/i);
		if (newsNowMatch) {
			await this.handleNewsNow(15);
			return true;
		}

		// /飞连、/vpn
		const feilianMatch = text.match(/^\/(飞连|vpn|feilian)[\s:：]*(.*)/i);
		if (feilianMatch) {
			await this.handleFeilian(feilianMatch[2].trim());
			return true;
		}

		// /apk、/sendapk（仅企业微信和飞书）
		if (this.ctx.platform !== "dingtalk" && /^\/(apk|sendapk)\s*$/i.test(text.trim())) {
			await this.handleSendApk();
			return true;
		}

		// /发送文件（仅企业微信和飞书）
		const sendFileMatch = text.match(/^\/(发送文件|sendfile|send|发送)[\s:：]+(.+)/i);
		if (this.ctx.platform !== "dingtalk" && sendFileMatch) {
			await this.handleSendFile(sendFileMatch[2].trim());
			return true;
		}

		// 未匹配任何命令
		return false;
	}
}
