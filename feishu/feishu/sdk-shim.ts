/**
 * OpenClaw Plugin SDK 本地替代 (shim)
 *
 * 提供 openclaw/plugin-sdk 中被飞书模块使用的类型和函数的本地实现。
 * 这样我们可以复用 OpenClaw 飞书插件的代码，而不依赖完整的 openclaw 包。
 */

import { mkdirSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir, homedir } from "node:os";

// ── 类型 ─────────────────────────────────────────

export type ClawdbotConfig = Record<string, unknown> & {
	channels?: Record<string, unknown>;
};

export interface RuntimeEnv {
	log: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
}

export interface HistoryEntry {
	role: string;
	content: string;
	timestamp?: number;
}

export interface ReplyPayload {
	text: string;
	mediaItems?: Array<{ path: string; contentType?: string }>;
}

export interface BaseProbeResult {
	ok: boolean;
	error?: string;
}

export interface AllowlistMatch<T extends string = string> {
	allowed: boolean;
	matchKey?: string;
	matchSource?: T;
}

export interface ChannelGroupContext {
	groupId: string;
	senderId?: string;
	cfg: ClawdbotConfig;
}

export type GroupToolPolicyConfig = Record<string, unknown>;

// ── 去重 ─────────────────────────────────────────

export function createDedupeCache(opts: { ttlMs: number; maxSize: number }) {
	const cache = new Map<string, number>();
	return {
		check(key: string): boolean {
			const now = Date.now();
			// 清理过期
			if (cache.size > opts.maxSize) {
				for (const [k, t] of cache) if (now - t > opts.ttlMs) cache.delete(k);
			}
			if (cache.has(key)) {
				const ts = cache.get(key)!;
				if (now - ts < opts.ttlMs) return true;
			}
			cache.set(key, now);
			return false;
		},
	};
}

interface PersistentDedupeFileData {
	entries: Record<string, number>;
}

export function createPersistentDedupe(opts: {
	ttlMs: number;
	memoryMaxSize: number;
	fileMaxEntries: number;
	resolveFilePath: (namespace: string) => string;
}) {
	const memory = createDedupeCache({ ttlMs: opts.ttlMs, maxSize: opts.memoryMaxSize });

	function loadFile(ns: string): PersistentDedupeFileData {
		try {
			return JSON.parse(readFileSync(opts.resolveFilePath(ns), "utf-8"));
		} catch {
			return { entries: {} };
		}
	}

	function saveFile(ns: string, data: PersistentDedupeFileData): void {
		const fp = opts.resolveFilePath(ns);
		try {
			mkdirSync(dirname(fp), { recursive: true });
			// 清理过期和超限
			const now = Date.now();
			const entries = Object.fromEntries(
				Object.entries(data.entries)
					.filter(([, t]) => now - t < opts.ttlMs)
					.slice(-opts.fileMaxEntries),
			);
			writeFileSync(fp, JSON.stringify({ entries }));
		} catch {}
	}

	return {
		async checkAndRecord(
			key: string,
			ctx: { namespace?: string; onDiskError?: (err: unknown) => void },
		): Promise<boolean> {
			if (memory.check(key)) return false;
			const ns = ctx.namespace || "global";
			try {
				const data = loadFile(ns);
				const ts = data.entries[key];
				if (ts && Date.now() - ts < opts.ttlMs) return false;
				data.entries[key] = Date.now();
				saveFile(ns, data);
			} catch (err) {
				ctx.onDiskError?.(err);
			}
			return true;
		},
	};
}

// ── 临时文件下载辅助 ─────────────────────────────

export async function withTempDownloadPath<T>(
	opts: { tmpDirPrefix?: string; prefix?: string },
	fn: (tmpPath: string) => Promise<T>,
): Promise<T> {
	const pfx = opts.tmpDirPrefix || opts.prefix || "tmp-";
	const dir = join(tmpdir(), pfx + Date.now());
	mkdirSync(dir, { recursive: true });
	const tmpFile = join(dir, "download");
	try {
		return await fn(tmpFile);
	} finally {
		try { unlinkSync(tmpFile); } catch {}
		try { rmdirSync(dir); } catch {}
	}
}
