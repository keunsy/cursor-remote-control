/**
 * 定时任务调度器 — cron-jobs.json 驱动
 *
 * 灵感来自 OpenClaw 的 cron 系统，简化为单进程方案。
 * Cursor Agent 可以通过写入 cron-jobs.json 来创建定时任务，
 * 调度器监视文件变更并自动执行。
 *
 * 特点：
 * - 单 setTimeout 链（不使用 setInterval）
 * - 支持 at（一次性）、every（循环）、cron（表达式）三种调度
 * - 原子写入 + 备份
 * - 连续错误自动禁用
 */

import { readFileSync, writeFileSync, renameSync, existsSync, watchFile, unwatchFile } from "node:fs";
import { randomUUID } from "node:crypto";

// ── 类型定义 ──────────────────────────────────────
export type CronSchedule =
	| { kind: "at"; at: string }
	| { kind: "every"; everyMs: number }
	| { kind: "cron"; expr: string; tz?: string };

export type CronJob = {
	id: string;
	name: string;
	enabled: boolean;
	deleteAfterRun?: boolean;
	schedule: CronSchedule;
	message: string;
	workspace?: string;
	model?: string;
	createdAt: string;
	updatedAt: string;
	state: {
		nextRunAtMs?: number;
		lastRunAtMs?: number;
		lastStatus?: "ok" | "error" | "skipped";
		lastError?: string;
		consecutiveErrors?: number;
	};
};

export type CronStoreFile = {
	version: 1;
	jobs: CronJob[];
};

// ── 最小 cron 表达式解析器 ────────────────────────
type CronField = { kind: "all" } | { kind: "list"; values: number[] };

function parseField(field: string, min: number, max: number): CronField {
	if (field === "*") return { kind: "all" };
	if (field.startsWith("*/")) {
		const step = Number.parseInt(field.slice(2), 10);
		if (Number.isNaN(step) || step <= 0) return { kind: "all" };
		const values: number[] = [];
		for (let v = min; v <= max; v += step) values.push(v);
		return { kind: "list", values };
	}
	const values: number[] = [];
	for (const part of field.split(",")) {
		const range = part.split("-");
		if (range.length === 2) {
			const lo = Number.parseInt(range[0], 10);
			const hi = Number.parseInt(range[1], 10);
			if (!Number.isNaN(lo) && !Number.isNaN(hi)) {
				for (let v = Math.max(lo, min); v <= Math.min(hi, max); v++) values.push(v);
			}
		} else {
			const v = Number.parseInt(part, 10);
			if (!Number.isNaN(v) && v >= min && v <= max) values.push(v);
		}
	}
	return values.length > 0 ? { kind: "list", values } : { kind: "all" };
}

function fieldMatches(f: CronField, value: number): boolean {
	if (f.kind === "all") return true;
	return f.values.includes(value);
}

function dateComponents(d: Date, tz?: string): [min: number, hr: number, dom: number, mon: number, dow: number] {
	if (!tz) return [d.getMinutes(), d.getHours(), d.getDate(), d.getMonth() + 1, d.getDay()];
	try {
		const s = d.toLocaleString("en-US", { timeZone: tz, hour12: false });
		const [datePart, timePart] = s.split(", ");
		const [monS, domS] = datePart.split("/");
		const [hS, mS] = timePart.split(":");
		const dow = new Date(d.toLocaleString("en-US", { timeZone: tz })).getDay();
		return [+mS, +hS % 24, +domS, +monS, dow];
	} catch {
		return [d.getMinutes(), d.getHours(), d.getDate(), d.getMonth() + 1, d.getDay()];
	}
}

/** Brute-force: scan next 366 days for first match. */
function nextCronOccurrence(expr: string, fromMs: number, tz?: string): number | undefined {
	const parts = expr.trim().split(/\s+/);
	if (parts.length < 5) return undefined;
	const fields = [
		parseField(parts[0], 0, 59), parseField(parts[1], 0, 23),
		parseField(parts[2], 1, 31), parseField(parts[3], 1, 12), parseField(parts[4], 0, 6),
	];
	const start = new Date(fromMs);
	start.setSeconds(0, 0);
	start.setMinutes(start.getMinutes() + 1);

	const SCAN_MINUTES = 366 * 24 * 60;
	for (let i = 0; i < SCAN_MINUTES; i++) {
		const candidate = new Date(start.getTime() + i * 60_000);
		const c = dateComponents(candidate, tz);
		if (c.every((v, idx) => fieldMatches(fields[idx], v))) return candidate.getTime();
	}
	return undefined;
}

// ── 调度计算 ──────────────────────────────────────
function computeNextRun(job: CronJob, now: number): number | undefined {
	const { schedule, state } = job;
	switch (schedule.kind) {
		case "at": {
			const ts = new Date(schedule.at).getTime();
			return Number.isNaN(ts) || ts <= now ? undefined : ts;
		}
		case "every": {
			const interval = Math.max(60_000, schedule.everyMs); // minimum 1 minute
			const base = state.lastRunAtMs || now;
			const next = base + interval;
			return next <= now ? now + interval : next;
		}
		case "cron":
			return nextCronOccurrence(schedule.expr, now, schedule.tz);
	}
}

// ── Scheduler ─────────────────────────────────────
interface SchedulerOpts {
	storePath: string;
	defaultWorkspace: string;
	onExecute: (job: CronJob) => Promise<{ status: "ok" | "error"; result?: string; error?: string }>;
	onDelivery?: (job: CronJob, result: string) => Promise<void>;
	log?: (msg: string) => void;
}

const MAX_CONSECUTIVE_ERRORS = 5;

export class Scheduler {
	private jobs = new Map<string, CronJob>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private opts: SchedulerOpts;
	private running = false;
	private saving = false;
	private lastSaveTime = 0;
	private log: (msg: string) => void;

	constructor(opts: SchedulerOpts) {
		this.opts = opts;
		this.log = opts.log ?? ((msg) => console.log(`[调度] ${msg}`));
	}

	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;
		await this.loadFromDisk();
		this.reschedule();
		let reloadTimer: ReturnType<typeof setTimeout> | null = null;
		watchFile(this.opts.storePath, { interval: 2000 }, () => {
			if (reloadTimer) clearTimeout(reloadTimer);
			reloadTimer = setTimeout(() => {
				this.reload().catch((e) => this.log(`监听重载失败: ${e}`));
			}, 500);
		});
		this.log(`已启动，${this.jobs.size} 个任务`);
	}

	stop(): void {
		this.running = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		unwatchFile(this.opts.storePath);
		this.log("已停止");
	}

	async reload(): Promise<void> {
		if (Date.now() - this.lastSaveTime < 3000) return; // ignore self-triggered watch events
		const prev = new Map(this.jobs);
		await this.loadFromDisk();

		// Preserve runtime state for unchanged jobs
		for (const [id, job] of this.jobs) {
			const old = prev.get(id);
			if (old && old.updatedAt === job.updatedAt) {
				job.state = { ...job.state, ...old.state };
			}
		}

		this.reschedule();
		this.log(`重新加载完成，${this.jobs.size} 个任务`);
	}

	// ── CRUD ──────────────────────────────────────
	async add(input: Omit<CronJob, "id" | "createdAt" | "updatedAt" | "state">): Promise<CronJob> {
		const now = new Date().toISOString();
		const job: CronJob = {
			...input,
			id: randomUUID(),
			createdAt: now,
			updatedAt: now,
			state: {},
		};
		job.state.nextRunAtMs = computeNextRun(job, Date.now());
		this.jobs.set(job.id, job);
		await this.save();
		this.reschedule();
		this.log(`新增任务 "${job.name}" (${job.id.slice(0, 8)}), 下次执行: ${job.state.nextRunAtMs ? new Date(job.state.nextRunAtMs).toLocaleString() : "无"}`);
		return job;
	}

	async update(id: string, patch: Partial<CronJob>): Promise<CronJob | null> {
		const job = this.jobs.get(id);
		if (!job) return null;
		const { id: _id, createdAt: _ca, ...allowed } = patch as Record<string, unknown>;
		Object.assign(job, allowed, { updatedAt: new Date().toISOString() });
		if (patch.schedule) job.state.nextRunAtMs = computeNextRun(job, Date.now());
		await this.save();
		this.reschedule();
		return job;
	}

	async remove(id: string): Promise<boolean> {
		if (!this.jobs.delete(id)) return false;
		await this.save();
		this.reschedule();
		return true;
	}

	async list(includeDisabled = false): Promise<CronJob[]> {
		return includeDisabled ? [...this.jobs.values()] : [...this.jobs.values()].filter((j) => j.enabled);
	}

	getJob(id: string): CronJob | undefined { return this.jobs.get(id); }

	async run(id: string): Promise<{ status: string; error?: string }> {
		const job = this.jobs.get(id);
		if (!job) return { status: "error", error: "任务不存在" };
		return this.executeJob(job);
	}

	getStats(): { total: number; enabled: number; nextRunIn?: string } {
		const all = [...this.jobs.values()];
		const enabled = all.filter((j) => j.enabled);
		let nearestMs: number | undefined;
		for (const j of enabled) {
			if (j.state.nextRunAtMs && (!nearestMs || j.state.nextRunAtMs < nearestMs)) {
				nearestMs = j.state.nextRunAtMs;
			}
		}
		const nextRunIn = nearestMs ? formatDuration(nearestMs - Date.now()) : undefined;
		return { total: all.length, enabled: enabled.length, nextRunIn };
	}

	// ── 内部 ─────────────────────────────────────
	private reschedule(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (!this.running) return;

		let nearestMs = Infinity;
		let nearestJob: CronJob | null = null;

		for (const job of this.jobs.values()) {
			if (!job.enabled || !job.state.nextRunAtMs) continue;
			if (job.state.nextRunAtMs < nearestMs) {
				nearestMs = job.state.nextRunAtMs;
				nearestJob = job;
			}
		}

		if (!nearestJob || nearestMs === Infinity) return;

		const MAX_TIMEOUT = 2_147_483_647; // 2^31 - 1, setTimeout max
		const delayMs = Math.min(Math.max(0, nearestMs - Date.now()), MAX_TIMEOUT);
		this.timer = setTimeout(() => {
			this.tick().catch((e) => this.log(`tick 异常: ${e}`));
		}, delayMs);
		this.timer.unref();
	}

	private async tick(): Promise<void> {
		if (!this.running) return;
		const now = Date.now();

		// Collect all due jobs
		const due: CronJob[] = [];
		for (const job of this.jobs.values()) {
			if (job.enabled && job.state.nextRunAtMs && job.state.nextRunAtMs <= now) {
				due.push(job);
			}
		}

		for (const job of due) {
			await this.executeJob(job);
		}

		this.reschedule();
	}

	private async executeJob(job: CronJob): Promise<{ status: string; error?: string }> {
		const now = Date.now();
		this.log(`执行 "${job.name}" (${job.id.slice(0, 8)})`);

		let status: "ok" | "error" = "error";
		let error: string | undefined;

		try {
			const result = await this.opts.onExecute(job);
			status = result.status;
			error = result.error;
			if (status === "ok") {
				job.state.consecutiveErrors = 0;
				job.state.lastError = undefined;
				if (result.result && this.opts.onDelivery) {
					await this.opts.onDelivery(job, result.result).catch((e) =>
						this.log(`投递失败 "${job.name}": ${e}`),
					);
				}
			}
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}

		job.state.lastRunAtMs = now;
		job.state.lastStatus = status;
		if (status === "error") {
			job.state.lastError = error;
			job.state.consecutiveErrors = (job.state.consecutiveErrors || 0) + 1;
			this.log(`任务 "${job.name}" 失败 (${job.state.consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${error}`);
			if (job.state.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
				job.enabled = false;
				this.log(`任务 "${job.name}" 连续失败 ${MAX_CONSECUTIVE_ERRORS} 次，已自动禁用`);
			}
		}

		// One-shot "at" tasks: remove or disable after execution
		if (job.schedule.kind === "at") {
			if (job.deleteAfterRun) this.jobs.delete(job.id);
			else job.enabled = false;
		} else {
			job.state.nextRunAtMs = computeNextRun(job, now);
		}

		await this.save();
		return { status, error };
	}

	private async loadFromDisk(): Promise<void> {
		if (!existsSync(this.opts.storePath)) {
			const bakPath = this.opts.storePath + ".bak";
			if (existsSync(bakPath)) {
				this.log("主文件丢失，从备份恢复");
				renameSync(bakPath, this.opts.storePath);
			} else {
				this.jobs.clear();
				return;
			}
		}
		try {
			const raw = readFileSync(this.opts.storePath, "utf-8");
			const store = JSON.parse(raw) as CronStoreFile;
			if (store.version !== 1) {
				this.log(`未知版本 ${store.version}，跳过加载`);
				return;
			}
			this.jobs.clear();
			const now = Date.now();
			for (const job of store.jobs) {
				if (!job.state.nextRunAtMs && job.enabled) {
					job.state.nextRunAtMs = computeNextRun(job, now);
				}
				this.jobs.set(job.id, job);
			}
		} catch (err) {
			this.log(`加载失败: ${err instanceof Error ? err.message : err}`);
		}
	}

	private async save(): Promise<void> {
		if (this.saving) return;
		this.saving = true;
		try {
			const store: CronStoreFile = {
				version: 1,
				jobs: [...this.jobs.values()],
			};
			const json = JSON.stringify(store, null, 2);
			const tmpPath = this.opts.storePath + ".tmp";
			const bakPath = this.opts.storePath + ".bak";

			writeFileSync(tmpPath, json);
			if (existsSync(this.opts.storePath)) {
				try { renameSync(this.opts.storePath, bakPath); } catch {}
			}
			renameSync(tmpPath, this.opts.storePath);
			this.lastSaveTime = Date.now();
		} catch (err) {
			this.log(`保存失败: ${err instanceof Error ? err.message : err}`);
		} finally {
			this.saving = false;
		}
	}
}

// ── 工具函数 ──────────────────────────────────────
function formatDuration(ms: number): string {
	if (ms < 0) return "已过期";
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}秒`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}分${seconds % 60}秒`;
	const hours = Math.floor(minutes / 60);
	return `${hours}时${minutes % 60}分`;
}
