import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export interface HeartbeatConfig {
  enabled: boolean;
  everyMs: number;
  workspaceDir: string;
  prompt?: string;
  activeHours?: {
    start: number; // 0-23
    end: number; // 0-23
  };
}

interface HeartbeatGlobalConfig {
  everyMs: number;
  minSessionLines: number;
  minSessionBytes: number;
  activeHours?: { start: number; end: number } | null;
  platforms?: Record<string, { enabled?: boolean }>;
}

export type Platform = 'feishu' | 'dingtalk' | 'wechat' | 'wecom' | 'telegram';

const HEARTBEAT_CONFIG_PATH = resolve(import.meta.dirname, '..', 'config', 'heartbeat-config.json');
let _hbCachedConfig: HeartbeatGlobalConfig | null = null;
let _hbCachedMtimeMs = 0;

const HEARTBEAT_DEFAULTS: HeartbeatGlobalConfig = {
  everyMs: 86400000,
  minSessionLines: 10,
  minSessionBytes: 500,
  activeHours: null,
};

export function getHeartbeatGlobalConfig(): HeartbeatGlobalConfig {
  try {
    if (!existsSync(HEARTBEAT_CONFIG_PATH)) return _hbCachedConfig ?? HEARTBEAT_DEFAULTS;
    const mtime = statSync(HEARTBEAT_CONFIG_PATH).mtimeMs;
    if (_hbCachedConfig && mtime === _hbCachedMtimeMs) return _hbCachedConfig;
    const raw = JSON.parse(readFileSync(HEARTBEAT_CONFIG_PATH, 'utf-8'));
    _hbCachedConfig = { ...HEARTBEAT_DEFAULTS, ...raw };
    _hbCachedMtimeMs = mtime;
    return _hbCachedConfig!;
  } catch {
    return _hbCachedConfig ?? HEARTBEAT_DEFAULTS;
  }
}

/**
 * 获取指定平台的心跳 enabled 状态
 */
export function isHeartbeatEnabled(platform: Platform): boolean {
  const cfg = getHeartbeatGlobalConfig();
  return cfg.platforms?.[platform]?.enabled ?? false;
}

/**
 * 创建通用的 shouldRun 函数，基于统一配置的会话活动判断
 */
export function createSessionActivityGate(workspaceDir: string): () => boolean {
  return () => {
    const cfg = getHeartbeatGlobalConfig();
    try {
      const today = new Date().toISOString().slice(0, 10);
      const logPath = resolve(workspaceDir, `.cursor/sessions/${today}.jsonl`);
      const stat = statSync(logPath);
      if (stat.size < cfg.minSessionBytes) return false;
      const content = readFileSync(logPath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      if (lines.length < cfg.minSessionLines) {
        console.log(`[心跳] 今日会话仅 ${lines.length} 条（阈值 ${cfg.minSessionLines}），跳过`);
        return false;
      }
      return true;
    } catch {
      return false;
    }
  };
}

export type HeartbeatResult =
  | { status: "ran"; hasContent: boolean; durationMs: number }
  | { status: "skipped"; reason: string };

interface HeartbeatState {
  lastRunAtMs?: number;
  lastStatus?: "ok" | "skipped" | "error";
  consecutiveSkips: number;
}

const DEFAULT_PROMPT = `[心跳检查] 读取 .cursor/HEARTBEAT.md（如果存在），严格按清单执行检查。
不要凭空推断或重复旧任务。检查 .cursor/memory/ 获取近期上下文，需要时做后台维护。

**重要**: 检查最近会话，将重要信息写入记忆系统（防止上下文溢出丢失）：
- 用户偏好和决策 → .cursor/MEMORY.md
- 今日上下文和进展 → .cursor/memory/YYYY-MM-DD.md

如果清单已过时，主动更新 .cursor/HEARTBEAT.md。如果无需关注，只回复 HEARTBEAT_OK。`;

const HEARTBEAT_OK_RE = /heartbeat_ok/im;

export class HeartbeatRunner {
  private config: HeartbeatConfig;
  private onExecute: (prompt: string) => Promise<string>;
  private onDelivery: (content: string) => Promise<void>;
  private shouldRun?: () => boolean;
  private log: (msg: string) => void;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private state: HeartbeatState = { consecutiveSkips: 0 };
  private stopped = false;

  constructor(opts: {
    config: HeartbeatConfig;
    onExecute: (prompt: string) => Promise<string>;
    onDelivery: (content: string) => Promise<void>;
    /** Optional gate: return false to skip this heartbeat without calling Agent */
    shouldRun?: () => boolean;
    log?: (msg: string) => void;
  }) {
    this.config = { ...opts.config };
    this.onExecute = opts.onExecute;
    this.onDelivery = opts.onDelivery;
    this.shouldRun = opts.shouldRun;
    this.log = opts.log ?? ((msg: string) => console.log(`[heartbeat] ${msg}`));
  }

  start(): void {
    if (!this.config.enabled) {
      this.log("disabled, not starting");
      return;
    }
    if (this.timer) return; // already running
    this.stopped = false;
    this.log(`starting — every ${Math.round(this.config.everyMs / 60_000)}min`);
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.log("stopped");
  }

  async runOnce(): Promise<HeartbeatResult> {
    if (!this.isWithinActiveHours()) {
      const reason = "outside-active-hours";
      this.state.lastStatus = "skipped";
      this.state.consecutiveSkips++;
      this.log(`skipped: ${reason}`);
      return { status: "skipped", reason };
    }

    if (this.shouldRun && !this.shouldRun()) {
      const reason = "insufficient-session-activity";
      this.state.lastStatus = "skipped";
      this.state.consecutiveSkips++;
      this.log(`skipped: ${reason}`);
      return { status: "skipped", reason };
    }

    // Cursor Agent 自己读 HEARTBEAT.md，我们只发固定提示词
    const prompt = this.config.prompt ?? DEFAULT_PROMPT;
    const t0 = Date.now();

    try {
      this.log("executing heartbeat check…");
      const response = await this.onExecute(prompt);
      const durationMs = Date.now() - t0;
      this.state.lastRunAtMs = Date.now();

      if (HEARTBEAT_OK_RE.test(response)) {
        this.state.lastStatus = "ok";
        this.state.consecutiveSkips = 0;
        this.log(`ok (${durationMs}ms) — nothing to report`);
        return { status: "ran", hasContent: false, durationMs };
      }

      this.log(`content to deliver (${durationMs}ms)`);
      try {
        await this.onDelivery(response);
      } catch (deliveryErr) {
        this.log(`delivery failed: ${deliveryErr instanceof Error ? deliveryErr.message : String(deliveryErr)}`);
      }
      this.state.lastStatus = "ok";
      this.state.consecutiveSkips = 0;
      return { status: "ran", hasContent: true, durationMs };
    } catch (err) {
      this.state.lastStatus = "error";
      this.log(`error: ${err instanceof Error ? err.message : String(err)}`);
      return { status: "skipped", reason: "execution-error" };
    }
  }

  updateConfig(patch: Partial<HeartbeatConfig>): void {
    const wasEnabled = this.config.enabled;
    Object.assign(this.config, patch);

    if (!wasEnabled && this.config.enabled) {
      this.start();
    } else if (wasEnabled && !this.config.enabled) {
      this.stop();
    } else if (this.config.enabled && patch.everyMs !== undefined) {
      // Interval changed — reschedule
      this.stop();
      this.scheduleNext();
    }
  }

  getStatus(): {
    enabled: boolean;
    everyMs: number;
    lastRunAt?: string;
    nextRunAt?: string;
    lastStatus?: string;
    consecutiveSkips: number;
  } {
    const nextRunAtMs = this.state.lastRunAtMs
      ? this.state.lastRunAtMs + this.config.everyMs
      : undefined;

    return {
      enabled: this.config.enabled,
      everyMs: this.config.everyMs,
      lastRunAt: this.state.lastRunAtMs
        ? new Date(this.state.lastRunAtMs).toISOString()
        : undefined,
      nextRunAt:
        this.timer && nextRunAtMs
          ? new Date(nextRunAtMs).toISOString()
          : undefined,
      lastStatus: this.state.lastStatus,
      consecutiveSkips: this.state.consecutiveSkips,
    };
  }

  // --- internals ---

  private scheduleNext(): void {
    const delay = this.computeDelay();
    this.timer = setTimeout(async () => {
      this.timer = null;
      if (this.stopped) return;
      await this.runOnce();
      if (this.config.enabled && !this.stopped) this.scheduleNext();
    }, delay);
    this.timer.unref();
  }

  private computeDelay(): number {
    if (!this.state.lastRunAtMs) return this.config.everyMs;
    const elapsed = Date.now() - this.state.lastRunAtMs;
    return Math.max(0, this.config.everyMs - elapsed);
  }

  /** Supports wrap-around ranges (e.g. 22:00–06:00). */
  private isWithinActiveHours(): boolean {
    const hours = this.config.activeHours;
    if (!hours) return true;
    if (hours.start === hours.end) return true; // entire day

    const now = new Date().getHours();
    if (hours.start <= hours.end) {
      return now >= hours.start && now < hours.end;
    }
    // Wraps midnight
    return now >= hours.start || now < hours.end;
  }
}
