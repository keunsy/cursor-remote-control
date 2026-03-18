/**
 * 企业微信辅助函数
 */

// ── 会话管理 ─────────────────────────────────────
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Session {
	agentId?: string;
	workspace: string;
	currentProject?: string;
}

export const sessions = new Map<string, Session>();

export function getSession(chatid: string, userid: string, workspace: string): Session {
	const key = `wecom_${chatid}_${userid}`;
	if (!sessions.has(key)) {
		sessions.set(key, { workspace });
	}
	return sessions.get(key)!;
}

// ── 会话历史管理 ──────────────────────────────────
const SESSIONS_PATH = resolve(import.meta.dirname, '.sessions.json');
const MAX_SESSION_HISTORY = 20;

export interface SessionEntry {
	id: string;
	createdAt: number;
	lastActiveAt: number;
	summary: string;
}

export interface WorkspaceSessions {
	active: string | null;
	history: SessionEntry[];
	currentProject?: string;
}

export const sessionsStore: Map<string, WorkspaceSessions> = new Map();

export function loadSessionsFromDisk(): void {
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
	} catch (err) {
		// Bug #16 修复：记录加载失败
		console.error('[Session] 从磁盘加载失败:', err instanceof Error ? err.message : err);
	}
}

// Bug #17 修复：移除未使用的 sessionsSaving 标记
export function saveSessions(): void {
	try {
		writeFileSync(SESSIONS_PATH, JSON.stringify(Object.fromEntries(sessionsStore), null, 2));
	} catch (err) {
		// Bug #16 修复：记录保存失败
		console.error('[Session] 保存到磁盘失败:', err instanceof Error ? err.message : err);
	}
}

loadSessionsFromDisk();

export function getActiveSessionId(workspace: string): string | undefined {
	return sessionsStore.get(workspace)?.active || undefined;
}

export function setActiveSession(workspace: string, sessionId: string, summary?: string): void {
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

export function archiveAndResetSession(workspace: string): void {
	const ws = sessionsStore.get(workspace);
	if (ws?.active) {
		ws.active = null;
		saveSessions();
		console.log(`[Session ${workspace}] 已归档并重置`);
	}
}

export function switchToSession(workspace: string, sessionId: string): boolean {
	const ws = sessionsStore.get(workspace);
	if (!ws) return false;
	const entry = ws.history.find(h => h.id === sessionId);
	if (!entry) return false;
	ws.active = sessionId;
	entry.lastActiveAt = Date.now();
	saveSessions();
	return true;
}

export function getSessionHistory(workspace: string, limit = 10): SessionEntry[] {
	const ws = sessionsStore.get(workspace);
	if (!ws) return [];
	return [...ws.history]
		.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
		.slice(0, limit);
}

// ── 并发控制 ─────────────────────────────────────
export function getLockKey(workspace: string): string {
	const sid = getActiveSessionId(workspace);
	return sid ? `session:${sid}` : `ws:${workspace}`;
}

export const busySessions = new Set<string>();

// ── 工具调用描述 ─────────────────────────────────
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

export function describeToolCall(tc: Record<string, { args?: Record<string, unknown> }>): string {
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

export function buildToolSummary(tools: string[]): string {
	if (tools.length === 0) return "";
	
	const groups = new Map<string, { emoji: string; items: string[] }>();
	
	for (const tool of tools) {
		const match = tool.match(/^([🔧📖✏️⚡🔍📂🔎🌐🗑️📓🔌🤖]+)\s+(.+)/);
		if (!match) continue;
		
		const emoji = match[1];
		const detail = match[2];
		
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

// ── 项目路由 ─────────────────────────────────────
interface RouteIntent {
	type: 'switch' | 'temp' | 'none';
	project?: string;
	path?: string;
	cleanedText: string;
}

export function detectRouteIntent(text: string, projectNames: string[]): RouteIntent {
	const raw = (text || '').trim().replace(/\s+/g, ' ');
	const projectPattern = projectNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
	
	// 0. 路径快捷语法
	const pathSymbolMatch = raw.match(/^[#@]((?:~?\/|~).+?)\s+(.+)$/);
	if (pathSymbolMatch) {
		const rawPath = pathSymbolMatch[1];
		const absolutePath = rawPath.startsWith('~') 
			? rawPath.replace(/^~/, process.env.HOME || '~')
			: rawPath;
		return { type: 'temp', path: absolutePath, cleanedText: pathSymbolMatch[2].trim() };
	}
	
	// 1. 简化符号
	const symbolMatch = raw.match(new RegExp(`^[#@](${projectPattern})\\s+(.+)`, 'i'));
	if (symbolMatch) {
		const project = symbolMatch[1].toLowerCase();
		return { type: 'temp', project, cleanedText: symbolMatch[2].trim() };
	}
	
	// 2a. 切换到任意路径
	const pathSwitchMatch = raw.match(/^(?:切换到|切到|切换|进入|打开)(?:路径)?\s+([~\/].+?)\s*$/i);
	if (pathSwitchMatch) {
		const absolutePath = pathSwitchMatch[1].startsWith('~')
			? pathSwitchMatch[1].replace(/^~/, process.env.HOME || '~')
			: pathSwitchMatch[1];
		return { type: 'switch', path: absolutePath, cleanedText: '' };
	}
	
	// 2b. 持久切换到项目
	const switchPatterns = [
		new RegExp(`^(?:切换到|切到|切换|现在用|改成|使用)\\s*(${projectPattern})(?:\\s*项目)?\\s*$`, 'i'),
		new RegExp(`^(?:进入|打开)\\s*(${projectPattern})(?:\\s*项目)?\\s*$`, 'i'),
	];
	for (const pattern of switchPatterns) {
		const match = raw.match(pattern);
		if (match) {
			const project = match[1].toLowerCase();
			return { type: 'switch', project, cleanedText: '' };
		}
	}
	
	// 3. 临时路由
	const tempPatterns = [
		new RegExp(`(?:看看|查查|分析|检查)\\s*(${projectPattern})(?:项目)?(?:的|里|中)?`, 'i'),
		new RegExp(`在\\s*(${projectPattern})(?:项目)?(?:里|中)`, 'i'),
		new RegExp(`(${projectPattern})(?:项目)?(?:有|出现|发现)`, 'i'),
	];
	for (const pattern of tempPatterns) {
		const match = raw.match(pattern);
		if (match) {
			const project = match[1].toLowerCase();
			return { type: 'temp', project, cleanedText: text };
		}
	}
	
	return { type: 'none', cleanedText: text };
}

export function resolveWorkspace(
	text: string,
	projects: Record<string, { path: string; description: string }>,
	defaultProject: string,
	currentProject?: string,
	intent?: RouteIntent
): { workspace: string; message: string; label: string; routeChanged?: boolean; intent: RouteIntent } {
	const ROOT = resolve(import.meta.dirname, '..');
	
	// 1. 传统路由
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
	
	// 2. 对话式路由
	const routeIntent = intent || detectRouteIntent(text, Object.keys(projects));
	
	// 2a. 路径型路由
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
		const project = projects[routeIntent.project];
		if (!project) {
			console.warn(`[路由] 项目不存在: ${routeIntent.project}`);
			// 回退到默认项目
			const defaultProj = projects[defaultProject];
			return {
				workspace: defaultProj?.path || ROOT,
				message: text.trim(),
				label: defaultProject,
				intent: { type: 'none', cleanedText: text },
			};
		}
		return {
			workspace: project.path,
			message: routeIntent.cleanedText || text,
			label: routeIntent.project,
			routeChanged: routeIntent.type === 'switch',
			intent: routeIntent,
		};
	}
	
	// 3. 使用当前项目
	if (currentProject && projects[currentProject]) {
		return {
			workspace: projects[currentProject].path,
			message: text.trim(),
			label: currentProject,
			intent: routeIntent,
		};
	}
	
	// 4. 默认项目
	const defaultProj = projects[defaultProject];
	return {
		workspace: defaultProj?.path || ROOT,
		message: text.trim(),
		label: defaultProject,
		intent: routeIntent,
	};
}
