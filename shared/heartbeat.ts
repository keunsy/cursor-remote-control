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
如果清单已过时，主动更新 .cursor/HEARTBEAT.md。如果无需关注，只回复 HEARTBEAT_OK。`;

const HEARTBEAT_OK_RE = /heartbeat_ok/im;

export class HeartbeatRunner {
  private config: HeartbeatConfig;
  private onExecute: (prompt: string) => Promise<string>;
  private onDelivery: (content: string) => Promise<void>;
  private log: (msg: string) => void;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private state: HeartbeatState = { consecutiveSkips: 0 };
  private stopped = false;

  constructor(opts: {
    config: HeartbeatConfig;
    onExecute: (prompt: string) => Promise<string>;
    onDelivery: (content: string) => Promise<void>;
    log?: (msg: string) => void;
  }) {
    this.config = { ...opts.config };
    this.onExecute = opts.onExecute;
    this.onDelivery = opts.onDelivery;
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
