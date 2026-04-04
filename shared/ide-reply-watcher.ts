/**
 * IdeReplyWatcher — V2 bidirectional feedback
 *
 * Polls /tmp/feedback_gate_ide_reply.jsonl for new entries written by the
 * Cursor Feedback Gate extension, then forwards them to the originating IM
 * platform via a caller-supplied send function.
 */

import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { resolve } from "node:path";

export interface IdeReplyEntry {
	chatId: string;
	platform: string;
	originalText?: string;
	agentMessage: string;
	ts: string;
}

export type SendFn = (chatId: string, message: string) => Promise<void>;

const TMP_DIR = process.platform === "win32"
	? (process.env.TEMP || process.env.TMP || "C:\\Temp")
	: "/tmp";

const REPLY_PATH = resolve(TMP_DIR, "feedback_gate_ide_reply.jsonl");
const POLL_MS = 5_000;

export class IdeReplyWatcher {
	private lastSize = 0;
	private timer: ReturnType<typeof setInterval> | null = null;
	private sendFn: SendFn;
	private platform: string;

	constructor(platform: string, sendFn: SendFn) {
		this.platform = platform;
		this.sendFn = sendFn;
	}

	start(): void {
		if (this.timer) return;

		try {
			if (existsSync(REPLY_PATH)) {
				this.lastSize = statSync(REPLY_PATH).size;
			}
		} catch {}

		this.timer = setInterval(() => this.poll(), POLL_MS);
		console.log(`[IdeReplyWatcher] started for platform=${this.platform}`);
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	private poll(): void {
		try {
			if (!existsSync(REPLY_PATH)) {
				if (this.lastSize !== 0) this.lastSize = 0;
				return;
			}

			const size = statSync(REPLY_PATH).size;
			if (size <= this.lastSize) {
				if (size < this.lastSize) this.lastSize = 0;
				return;
			}

			const bytesToRead = size - this.lastSize;
			const buf = Buffer.alloc(bytesToRead);
			const fd = openSync(REPLY_PATH, "r");
			try {
				readSync(fd, buf, 0, bytesToRead, this.lastSize);
			} finally {
				closeSync(fd);
			}
			this.lastSize = size;

			const lines = buf.toString("utf8").split("\n").filter((l) => l.trim());
			for (const line of lines) {
				try {
					const entry: IdeReplyEntry = JSON.parse(line);
					if (entry.platform !== this.platform) continue;
					if (!entry.chatId || !entry.agentMessage) continue;

						const quote = entry.originalText
						? `📤 关于「${entry.originalText.length > 30 ? entry.originalText.slice(0, 30) + '...' : entry.originalText}」\n\n`
						: '';
					this.sendFn(entry.chatId, `🤖 Agent 回复:\n\n${quote}${entry.agentMessage}`)
						.catch((err) => console.error("[IdeReplyWatcher] send failed:", err));
				} catch {}
			}
		} catch {}
	}
}
