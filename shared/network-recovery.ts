/**
 * 检测「网络从不可用恢复」或「定时器长时间停顿（常见于合盖再开盖、刚从睡眠恢复）」，
 * 用于主动重建飞书等长连接，缓解半开 TCP 导致开盖后迟迟收不到事件的问题。
 * （不阻止合盖睡眠，只在唤醒后尽快把长连接拉起来。）
 */

export interface NetworkRecoveryOptions {
	/** 探测间隔（毫秒） */
	intervalMs?: number;
	/** 若两次探测间隔超过该值（毫秒），视为可能刚从睡眠唤醒 */
	wakeGapMs?: number;
	/** 两次强制重连之间的最小间隔（毫秒） */
	minReconnectGapMs?: number;
	/** 探测 URL（需稳定可访问） */
	probeUrl?: string;
	onRecover: (reason: "network-back" | "probable-wake") => void | Promise<void>;
}

export function startNetworkRecoveryMonitor(opts: NetworkRecoveryOptions): () => void {
	const intervalMs = opts.intervalMs ?? 15_000;
	const wakeGapMs = opts.wakeGapMs ?? 120_000;
	const minReconnectGapMs = opts.minReconnectGapMs ?? 90_000;
	const probeUrl = opts.probeUrl ?? "https://open.feishu.cn";

	console.log(`[network-recovery] 已启动监控 (探测间隔: ${intervalMs/1000}s, 唤醒阈值: ${wakeGapMs/1000}s)`);

	let everOk = false;
	let hadFailureSinceLastOk = false;
	let lastPollAt = Date.now();
	let lastRecoverAt = 0;
	let stopped = false;

	const probe = async (): Promise<boolean> => {
		try {
			const ac = new AbortController();
			const t = setTimeout(() => ac.abort(), 8_000);
			const r = await fetch(probeUrl, {
				method: "HEAD",
				signal: ac.signal,
				cache: "no-store",
			});
			clearTimeout(t);
			return r.status < 600;
		} catch {
			return false;
		}
	};

	const tick = async () => {
		if (stopped) return;
		const now = Date.now();
		const gap = now - lastPollAt;
		lastPollAt = now;

		const ok = await probe();
		const probableWake = gap >= wakeGapMs;

		if (ok) {
			if (!everOk) {
				everOk = true;
				hadFailureSinceLastOk = false;
				return;
			}
			if (hadFailureSinceLastOk) {
				hadFailureSinceLastOk = false;
				if (now - lastRecoverAt >= minReconnectGapMs) {
					lastRecoverAt = now;
					console.warn(`[network-recovery] 网络已恢复，触发长连接重建 (gap=${Math.round(gap / 1000)}s)`);
					await Promise.resolve(opts.onRecover("network-back"));
				}
				return;
			}
			if (probableWake && everOk && now - lastRecoverAt >= minReconnectGapMs) {
				lastRecoverAt = now;
				console.warn(
					`[network-recovery] 探测间隔 ${Math.round(gap / 1000)}s（疑似睡眠唤醒），主动重建长连接`,
				);
				await Promise.resolve(opts.onRecover("probable-wake"));
			}
		} else {
			if (everOk) hadFailureSinceLastOk = true;
		}
	};

	const id = setInterval(() => {
		tick().catch((e) => console.error("[network-recovery] tick 失败:", e));
	}, intervalMs);

	// 首次略延迟，避免与进程启动抢网络
	setTimeout(() => {
		tick().catch((e) => console.error("[network-recovery] 首次探测失败:", e));
	}, 3_000);

	return () => {
		stopped = true;
		clearInterval(id);
	};
}
