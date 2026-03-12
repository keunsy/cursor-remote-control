/**
 * 钉钉 Stream → Cursor Agent CLI 中继服务 v1
 *
 * 直连方案：钉钉 Stream ↔ Cursor Agent CLI
 * - 钉钉消息直达 Cursor，零提示词污染
 * - Markdown 消息 + ActionCard 卡片
 * - 支持文字、图片、语音、文件、富文本
 * - 长消息自动分片
 *
 * 启动: bun run server.ts
 */
import { DingTalkStreamClient, type DingTalkMessage } from "./dingtalk-client.js";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, watchFile, mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { gzipSync, gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { MemoryManager } from "./memory.js";
import { Scheduler, type CronJob } from "./scheduler.js";
import { HeartbeatRunner } from "./heartbeat.js";

const HOME = process.env.HOME;
if (!HOME) throw new Error("$HOME is not set");

const ROOT = resolve(import.meta.dirname, "..");
const ENV_PATH = resolve(import.meta.dirname, ".env");
const PROJECTS_PATH = resolve(ROOT, "projects.json");
const AGENT_BIN = process.env.AGENT_BIN || resolve(HOME, ".local/bin/agent");
const INBOX_DIR = resolve(ROOT, "inbox");

mkdirSync(INBOX_DIR, { recursive: true });

// 启动时清理超过 24h 的临时文件
const DAY_MS = 24 * 60 * 60 * 1000;
for (const f of readdirSync(INBOX_DIR)) {
	const p = resolve(INBOX_DIR, f);
	try { if (Date.now() - statSync(p).mtimeMs > DAY_MS) unlinkSync(p); } catch {}
}

process.on("uncaughtException", (err) => {
	console.error(`[致命] ${err.message}\n${err.stack}`);
});
process.on("unhandledRejection", (reason) => {
	console.error("[致命] unhandledRejection:", reason);
});

// ── .env 热更换 ──────────────────────────────────
interface EnvConfig {
	CURSOR_API_KEY: string;
	DINGTALK_APP_KEY: string;
	DINGTALK_APP_SECRET: string;
	CURSOR_MODEL: string;
	VOLC_STT_APP_ID: string;
	VOLC_STT_ACCESS_TOKEN: string;
	VOLC_EMBEDDING_API_KEY: string;
	VOLC_EMBEDDING_MODEL: string;
}

function parseEnv(): EnvConfig {
	if (!existsSync(ENV_PATH)) {
		console.error(`[致命] .env 文件不存在: ${ENV_PATH}`);
		process.exit(1);
	}
	const raw = readFileSync(ENV_PATH, "utf-8");
	const env: Record<string, string> = {};
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIdx = trimmed.indexOf("=");
		if (eqIdx < 0) continue;
		let val = trimmed.slice(eqIdx + 1).trim();
		// 去除引号包裹
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1);
		}
		env[trimmed.slice(0, eqIdx).trim()] = val;
	}
	return {
		CURSOR_API_KEY: env.CURSOR_API_KEY || "",
		DINGTALK_APP_KEY: env.DINGTALK_APP_KEY || "",
		DINGTALK_APP_SECRET: env.DINGTALK_APP_SECRET || "",
		CURSOR_MODEL: env.CURSOR_MODEL || "opus-4.6-thinking",
		VOLC_STT_APP_ID: env.VOLC_STT_APP_ID || "",
		VOLC_STT_ACCESS_TOKEN: env.VOLC_STT_ACCESS_TOKEN || "",
		VOLC_EMBEDDING_API_KEY: env.VOLC_EMBEDDING_API_KEY || "",
		VOLC_EMBEDDING_MODEL: env.VOLC_EMBEDDING_MODEL || "doubao-embedding-vision-250615",
	};
}

let config = parseEnv();
watchFile(ENV_PATH, { interval: 2000 }, () => {
	try {
		const prev = config.CURSOR_API_KEY;
		config = parseEnv();
		if (config.CURSOR_API_KEY !== prev) {
			console.log(`[热更换] API Key 已更新 (...${config.CURSOR_API_KEY.slice(-8)})`);
		} else {
			console.log("[热更换] .env 已重新加载");
		}
	} catch {}
});

// ── 项目配置 ─────────────────────────────────────
interface ProjectsConfig {
	projects: Record<string, { path: string; description: string }>;
	default_project: string;
}
if (!existsSync(PROJECTS_PATH)) {
	console.error(`[致命] projects.json 不存在: ${PROJECTS_PATH}`);
	process.exit(1);
}
let projectsConfig: ProjectsConfig = JSON.parse(readFileSync(PROJECTS_PATH, "utf-8"));
watchFile(PROJECTS_PATH, { interval: 5000 }, () => {
	try {
		projectsConfig = JSON.parse(readFileSync(PROJECTS_PATH, "utf-8"));
	} catch {}
});

// ── 工作区模板自动初始化 ─────────────────────────
const TEMPLATE_DIR = resolve(import.meta.dirname, "templates");
const WORKSPACE_FILES = [
	".cursor/SOUL.md", ".cursor/IDENTITY.md", ".cursor/USER.md",
	".cursor/MEMORY.md", ".cursor/HEARTBEAT.md", ".cursor/TASKS.md",
	".cursor/BOOT.md", ".cursor/TOOLS.md",
];
const WORKSPACE_RULES = [
	".cursor/rules/soul.mdc",
	".cursor/rules/agent-identity.mdc",
	".cursor/rules/user-context.mdc",
	".cursor/rules/workspace-rules.mdc",
	".cursor/rules/tools.mdc",
	".cursor/rules/memory-protocol.mdc",
	".cursor/rules/scheduler-protocol.mdc",
	".cursor/rules/heartbeat-protocol.mdc",
	".cursor/rules/cursor-capabilities.mdc",
];

function ensureWorkspace(wsPath: string): boolean {
	mkdirSync(resolve(wsPath, ".cursor/memory"), { recursive: true });
	mkdirSync(resolve(wsPath, ".cursor/sessions"), { recursive: true });
	mkdirSync(resolve(wsPath, ".cursor/rules"), { recursive: true });
	mkdirSync(resolve(wsPath, ".cursor/skills"), { recursive: true });

	const isNewWorkspace = !existsSync(resolve(wsPath, ".cursor/SOUL.md"));
	let copied = 0;

	// AGENTS.md 放在根目录（Cursor 自动加载约定）
	const rootFiles = ["AGENTS.md"];
	// 首次初始化时额外复制 BOOTSTRAP.md（仅新工作区）
	const allFiles = isNewWorkspace
		? [...rootFiles, ...WORKSPACE_FILES, ".cursor/BOOTSTRAP.md", ...WORKSPACE_RULES]
		: [...rootFiles, ...WORKSPACE_FILES, ...WORKSPACE_RULES];

	for (const f of allFiles) {
		const target = resolve(wsPath, f);
		if (!existsSync(target)) {
			const src = resolve(TEMPLATE_DIR, f);
			if (existsSync(src)) {
				writeFileSync(target, readFileSync(src, "utf-8"));
				console.log(`[工作区] 从模板复制: ${f}`);
				copied++;
			}
		}
	}

	// Skills（Cursor 官方 skill 规范：.cursor/skills/skill-name/SKILL.md）
	const skillsSrc = resolve(TEMPLATE_DIR, ".cursor/skills");
	if (existsSync(skillsSrc)) {
		for (const name of readdirSync(skillsSrc)) {
			const srcDir = resolve(skillsSrc, name);
			if (!statSync(srcDir).isDirectory()) continue;
			const targetSkill = resolve(wsPath, `.cursor/skills/${name}/SKILL.md`);
			if (!existsSync(targetSkill)) {
				const targetDir = resolve(wsPath, `.cursor/skills/${name}`);
				mkdirSync(targetDir, { recursive: true });
				for (const file of readdirSync(srcDir)) {
					writeFileSync(resolve(targetDir, file), readFileSync(resolve(srcDir, file), "utf-8"));
				}
				console.log(`[工作区] 从模板复制 skill: ${name}`);
				copied++;
			}
		}
	}

	if (copied > 0) {
		console.log(`[工作区] ${wsPath} 初始化完成 (${copied} 个文件)`);
		if (isNewWorkspace) {
			console.log("[工作区] 首次启动：.cursor/BOOTSTRAP.md 已就绪，首次对话将触发出生仪式");
		}
	}
	return isNewWorkspace;
}

// ── 记忆管理器 ───────────────────────────────────
const defaultWorkspace = projectsConfig.projects[projectsConfig.default_project]?.path || ROOT;
ensureWorkspace(defaultWorkspace);

// 记忆工作区：支持独立配置，避免污染工作项目
const memoryWorkspaceKey = (projectsConfig as any).memory_workspace || projectsConfig.default_project;
const memoryWorkspace = projectsConfig.projects[memoryWorkspaceKey]?.path || defaultWorkspace;
ensureWorkspace(memoryWorkspace);

let memory: MemoryManager | undefined;
try {
	memory = new MemoryManager({
		workspaceDir: memoryWorkspace,
		embeddingApiKey: config.VOLC_EMBEDDING_API_KEY,
		embeddingModel: config.VOLC_EMBEDDING_MODEL,
		embeddingEndpoint: "https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal",
	});
	setTimeout(() => {
		memory!.index().then((n) => {
			if (n > 0) console.log(`[记忆] 启动索引完成: ${n} 块`);
		}).catch((e) => console.warn(`[记忆] 启动索引失败: ${e}`));
	}, 3000);
} catch (e) {
	console.warn(`[记忆] 初始化失败（功能降级）: ${e}`);
}

// ── 最近活跃会话（用于定时任务/心跳主动推送）─────
let lastActiveChatId: string | undefined;

// ── 定时任务调度器 ────────────────────────────────
const cronStorePath = resolve(defaultWorkspace, "cron-jobs.json");

const scheduler = new Scheduler({
	storePath: cronStorePath,
	defaultWorkspace,
	onExecute: async (job: CronJob) => {
		try {
			const ws = job.workspace || defaultWorkspace;
			memory?.appendSessionLog(ws, "user", `[定时任务:${job.name}] ${job.message}`, config.CURSOR_MODEL);
			const { result } = await runAgent(ws, job.message);
			memory?.appendSessionLog(ws, "assistant", result.slice(0, 3000), config.CURSOR_MODEL);
			return { status: "ok" as const, result };
		} catch (err) {
			return { status: "error" as const, error: err instanceof Error ? err.message : String(err) };
		}
	},
	onDelivery: async (job: CronJob, result: string) => {
		if (!lastActiveChatId) {
			console.warn("[调度] 无活跃会话，跳过发送");
			return;
		}
		const title = `⏰ 定时任务: ${job.name}`;
		if (result.length <= 3800) {
			await sendCard(lastActiveChatId, result, { title, color: "purple" });
		} else {
			await sendCard(lastActiveChatId, result.slice(0, 3800) + "\n\n...(已截断)", { title, color: "purple" });
		}
	},
	log: (msg: string) => console.log(`[调度] ${msg}`),
});

// ── 心跳系统 ──────────────────────────────────────
const heartbeat = new HeartbeatRunner({
	config: {
		enabled: true,
		everyMs: 30 * 60 * 1000,
		workspaceDir: defaultWorkspace,
	},
	onExecute: async (prompt: string) => {
		memory?.appendSessionLog(defaultWorkspace, "user", "[心跳检查] " + prompt.slice(0, 200), config.CURSOR_MODEL);
		const { result } = await runAgent(defaultWorkspace, prompt);
		memory?.appendSessionLog(defaultWorkspace, "assistant", result.slice(0, 3000), config.CURSOR_MODEL);
		return result;
	},
	onDelivery: async (content: string) => {
		if (!lastActiveChatId) {
			console.warn("[心跳] 无活跃会话，跳过发送");
			return;
		}
		await sendCard(lastActiveChatId, content, { title: "💓 心跳检查", color: "purple" });
	},
	log: (msg: string) => console.log(`[心跳] ${msg}`),
});

// ── 飞书 Client ──────────────────────────────────
const larkClient = new Lark.Client({
	appId: config.FEISHU_APP_ID,
	appSecret: config.FEISHU_APP_SECRET,
	domain: Lark.Domain.Feishu,
});

// ── 卡片构建 ─────────────────────────────────────
function buildCard(markdown: string, header?: { title?: string; color?: string }): string {
	const card: Record<string, unknown> = {
		schema: "2.0",
		config: { wide_screen_mode: true },
		body: { elements: [{ tag: "markdown", content: markdown }] },
	};
	if (header) {
		const h: Record<string, unknown> = { template: header.color || "blue" };
		if (header.title) h.title = { tag: "plain_text", content: header.title };
		card.header = h;
	}
	return JSON.stringify(card);
}

// 从飞书 API 错误中提取可读原因
function extractCardError(err: unknown): string | null {
	try {
		const e = err as Record<string, unknown>;
		// axios 错误结构: err.response.data 或 err[1]（Lark SDK 包装）
		const data = (e.response as Record<string, unknown>)?.data as Record<string, unknown>
			?? (Array.isArray(e) ? e[1] : null)
			?? e;
		if (!data) return null;
		const code = data.code as number;
		const msg = data.msg as string;
		if (code === 230099) return `卡片渲染失败: ${msg}`;
		if (code === 230025) return "卡片内容超过30KB大小限制";
		if (msg) return msg;
	} catch {}
	return null;
}

// ── 飞书消息操作 ─────────────────────────────────
async function replyCard(
	messageId: string,
	markdown: string,
	header?: { title?: string; color?: string },
): Promise<string | undefined> {
	try {
		const res = await larkClient.im.message.reply({
			path: { message_id: messageId },
			data: { content: buildCard(markdown, header), msg_type: "interactive" },
		});
		return res.data?.message_id;
	} catch (err) {
		console.error("[回复卡片失败]", err);
		try {
			const res = await larkClient.im.message.reply({
				path: { message_id: messageId },
				data: { content: JSON.stringify({ text: markdown }), msg_type: "text" },
			});
			return res.data?.message_id;
		} catch {}
	}
}

async function updateCard(
	messageId: string,
	markdown: string,
	header?: { title?: string; color?: string },
): Promise<{ ok: boolean; error?: string }> {
	try {
		await larkClient.im.message.patch({
			path: { message_id: messageId },
			data: { content: buildCard(markdown, header) },
		});
		return { ok: true };
	} catch (err) {
		const reason = extractCardError(err) || (err instanceof Error ? err.message : String(err));
		console.error(`[更新卡片失败] ${reason}`);
		return { ok: false, error: reason };
	}
}

async function sendCard(
	chatId: string,
	markdown: string,
	header?: { title?: string; color?: string },
): Promise<string | undefined> {
	try {
		const res = await larkClient.im.message.create({
			params: { receive_id_type: "chat_id" },
			data: { receive_id: chatId, msg_type: "interactive", content: buildCard(markdown, header) },
		});
		return res.data?.message_id;
	} catch (err) {
		console.error("[发送卡片失败]", err);
	}
}

// 长消息分片发送
const CARD_MAX = 3800;
async function replyLongMessage(messageId: string, chatId: string, text: string, header?: { title?: string; color?: string }): Promise<void> {
	if (text.length <= CARD_MAX) {
		await replyCard(messageId, text, header);
		return;
	}
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > 0) {
		if (remaining.length <= CARD_MAX) {
			chunks.push(remaining);
			break;
		}
		let cut = remaining.lastIndexOf("\n", CARD_MAX);
		if (cut < CARD_MAX * 0.5) cut = CARD_MAX;
		chunks.push(remaining.slice(0, cut));
		remaining = remaining.slice(cut);
	}
	for (let i = 0; i < chunks.length; i++) {
		const h = chunks.length > 1 ? { title: `${header?.title || "回复"} (${i + 1}/${chunks.length})`, color: header?.color } : header;
		if (i === 0) await replyCard(messageId, chunks[i], h);
		else await sendCard(chatId, chunks[i], h);
	}
}

// ── 媒体下载 ─────────────────────────────────────
async function readResponseBuffer(response: unknown, depth = 0): Promise<Buffer> {
	if (depth > 3) throw new Error("readResponseBuffer: 响应嵌套过深");
	const resp = response as Record<string, unknown>;
	if (resp instanceof Readable || typeof (resp as Readable).pipe === "function") {
		const chunks: Buffer[] = [];
		for await (const chunk of resp as Readable) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
		}
		return Buffer.concat(chunks);
	}
	if (typeof resp.writeFile === "function") {
		const tmp = resolve(INBOX_DIR, `.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
		await (resp as { writeFile: (p: string) => Promise<void> }).writeFile(tmp);
		const buf = readFileSync(tmp);
		try { unlinkSync(tmp); } catch {}
		return buf;
	}
	if (Buffer.isBuffer(resp)) return resp;
	if (resp.data && resp.data !== resp) return readResponseBuffer(resp.data, depth + 1);
	throw new Error("无法解析飞书资源响应");
}

async function downloadMedia(
	messageId: string,
	fileKey: string,
	type: "image" | "file",
	ext: string,
): Promise<string> {
	const response = await larkClient.im.messageResource.get({
		path: { message_id: messageId, file_key: fileKey },
		params: { type },
	});
	const buffer = await readResponseBuffer(response);
	const filename = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
	const filepath = resolve(INBOX_DIR, filename);
	writeFileSync(filepath, buffer);
	console.log(`[下载] ${filepath} (${buffer.length} bytes)`);
	return filepath;
}

// ── 语音转文字（火山引擎 → 云端 API → 本地 whisper）──
const WHISPER_MODEL = resolve(HOME, ".cache/whisper-cpp/ggml-tiny.bin");
const WHISPER_BIN = process.env.WHISPER_CLI || "whisper-cli";
const STT_DEBUG = /^(whisper_|ggml_|main:|system_info:|metal_|coreml_|log_)/;

function convertToWav(audioPath: string): string {
	const wavPath = audioPath.replace(/\.[^.]+$/, ".wav");
	execFileSync("ffmpeg", ["-y", "-i", audioPath, "-ar", "16000", "-ac", "1", wavPath], {
		timeout: 30_000,
		stdio: "pipe",
	});
	return wavPath;
}

// 火山引擎豆包大模型 STT（WebSocket 二进制协议）
// 协议文档: https://www.volcengine.com/docs/6561/1354869
const VOLC_STT_URL = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream";
const VOLC_RESOURCE_ID = "volc.bigasr.sauc.duration";

function volcBuildHeader(msgType: number, flags: number, serial: number, compress: number): Buffer {
	const h = Buffer.alloc(4);
	h[0] = 0x11; // protocol v1, header_size = 4 bytes (1×4)
	h[1] = ((msgType & 0xF) << 4) | (flags & 0xF);
	h[2] = ((serial & 0xF) << 4) | (compress & 0xF);
	h[3] = 0x00;
	return h;
}

function volcBuildPacket(header: Buffer, payload: Buffer): Buffer {
	const size = Buffer.alloc(4);
	size.writeUInt32BE(payload.length);
	return Buffer.concat([header, size, payload]);
}

function transcribeVolcengine(wavPath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const connectId = randomUUID();

		const ws = new WebSocket(VOLC_STT_URL, {
			headers: {
				"X-Api-App-Key": config.VOLC_STT_APP_ID,
				"X-Api-Access-Key": config.VOLC_STT_ACCESS_TOKEN,
				"X-Api-Resource-Id": VOLC_RESOURCE_ID,
				"X-Api-Connect-Id": connectId,
			},
		});

		const timer = setTimeout(() => done(new Error("超时 (30s)")), 30_000);

		function done(err: Error | null, text?: string) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try { ws.close(); } catch {}
			if (err) reject(err);
			else resolve(text!);
		}

		ws.on("open", () => {
			// 1) full_client_request: JSON + gzip
			const configPayload = Buffer.from(JSON.stringify({
				user: { uid: "relay-bot" },
				audio: { format: "pcm", rate: 16000, bits: 16, channel: 1 },
				request: { model_name: "bigmodel", enable_itn: true, enable_punc: true, enable_ddc: true },
			}));
			const hdr = volcBuildHeader(0x1, 0x0, 0x1, 0x1);
			ws.send(volcBuildPacket(hdr, gzipSync(configPayload)));

			// 2) audio_only_request: 读 WAV 文件并分包发送 PCM 数据
			const wav = readFileSync(wavPath);
			let pcmOffset = 44;
			for (let i = 12; i + 8 < wav.length;) {
				if (wav.subarray(i, i + 4).toString("ascii") === "data") {
					pcmOffset = i + 8;
					break;
				}
				i += 8 + wav.readUInt32LE(i + 4);
			}
			const pcm = wav.subarray(pcmOffset);
			const CHUNK = 6400; // 200ms @ 16kHz 16-bit mono

			for (let off = 0; off < pcm.length; off += CHUNK) {
				const isLast = off + CHUNK >= pcm.length;
				const chunk = pcm.subarray(off, Math.min(off + CHUNK, pcm.length));
				// flags: 0x2 = last packet, 0x0 = normal; serial: raw(0), compress: gzip(1)
				const aHdr = volcBuildHeader(0x2, isLast ? 0x2 : 0x0, 0x0, 0x1);
				ws.send(volcBuildPacket(aHdr, gzipSync(chunk)));
			}
		});

		ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
			const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
			if (buf.length < 4) return;

			const msgType = (buf[1] >> 4) & 0xF;
			const flags = buf[1] & 0xF;
			const compress = buf[2] & 0xF;

			// 错误响应
			if (msgType === 0xF) {
				let msg = "服务端错误";
				if (buf.length >= 12) {
					const code = buf.readUInt32BE(4);
					const msgLen = buf.readUInt32BE(8);
					msg = `[${code}] ${buf.subarray(12, 12 + Math.min(msgLen, buf.length - 12)).toString("utf-8")}`;
				}
				done(new Error(msg));
				return;
			}

			// 等待最终识别结果（flags bit 1 = 最后一包响应）
			if (msgType === 0x9 && (flags & 0x2)) {
				let off = 4;
				if (flags & 0x1) off += 4; // 跳过 sequence number
				if (off + 4 > buf.length) return;
				const pSize = buf.readUInt32BE(off);
				off += 4;
				if (off + pSize > buf.length) return;

				let payload = buf.subarray(off, off + pSize);
				if (compress === 1) {
					try { payload = gunzipSync(payload); } catch { done(new Error("解压响应失败")); return; }
				}
				try {
					const json = JSON.parse(payload.toString("utf-8"));
					const text = json?.result?.text?.trim();
					if (text) done(null, text);
					else done(new Error("识别结果为空"));
				} catch {
					done(new Error("解析响应 JSON 失败"));
				}
			}
		});

		ws.on("unexpected-response", (_req: unknown, res: { statusCode?: number }) => {
			done(new Error(`HTTP ${res.statusCode ?? "unknown"} (WebSocket 升级被拒)`));
		});
		ws.on("error", (err: Error) => done(new Error(`WebSocket: ${err.message}`)));
		ws.on("close", () => { if (!settled) done(new Error("连接意外断开")); });
	});
}

function transcribeLocal(wavPath: string): string | null {
	if (!existsSync(WHISPER_MODEL)) return null;
	try {
		const result = execFileSync(
			WHISPER_BIN,
			["--model", WHISPER_MODEL, "--language", "zh", "--no-timestamps", wavPath],
			{ timeout: 120_000, encoding: "utf-8", stdio: "pipe" },
		);
		const transcript = result
			.split("\n")
			.filter((l: string) => !STT_DEBUG.test(l) && l.trim())
			.join(" ")
			.trim();
		return transcript || null;
	} catch (err) {
		console.error("[STT 本地失败]", err instanceof Error ? err.message : err);
		return null;
	}
}

async function transcribeAudio(audioPath: string): Promise<string | null> {
	let wavPath: string | undefined;
	try {
		wavPath = convertToWav(audioPath);

		// 火山引擎豆包大模型（含重试）→ 本地 whisper 兜底
		if (config.VOLC_STT_APP_ID && config.VOLC_STT_ACCESS_TOKEN) {
			const maxRetries = 3;
			for (let attempt = 1; attempt <= maxRetries; attempt++) {
				try {
					const text = await transcribeVolcengine(wavPath);
					console.log(`[STT 火山引擎] 成功 (${text.length} chars, 第${attempt}次)`);
					return text;
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					console.warn(`[STT 火山引擎] 第${attempt}/${maxRetries}次失败: ${msg}`);
					if (attempt < maxRetries) {
						console.log(`[STT 火山引擎] 500ms 后重试...`);
						await new Promise((r) => setTimeout(r, 500));
					}
				}
			}
			console.warn("[STT 火山引擎] 重试耗尽，降级本地 whisper");
		}

		const local = transcribeLocal(wavPath);
		if (local) console.log(`[STT 本地] 成功 (${local.length} chars)`);
		else console.warn("[STT] 所有引擎均不可用");
		return local;
	} catch (err) {
		console.error("[STT 转码失败]", err instanceof Error ? err.message : err);
		return null;
	} finally {
		if (wavPath) try { unlinkSync(wavPath); } catch {}
	}
}

// ── 消息解析 ─────────────────────────────────────
function parseContent(
	messageType: string,
	content: string,
): { text: string; imageKey?: string; fileKey?: string; fileName?: string } {
	try {
		const p = JSON.parse(content);
		switch (messageType) {
			case "text":
				return { text: p.text || "" };
			case "image":
				return { text: "", imageKey: p.image_key };
			case "audio":
				return { text: "", fileKey: p.file_key };
			case "file":
				return { text: "", fileKey: p.file_key, fileName: p.file_name };
			case "post": {
				const texts: string[] = [];
				for (const lang of Object.values(p) as Array<{
					title?: string;
					content?: Array<Array<{ tag: string; text?: string }>>;
				}>) {
					if (lang?.title) texts.push(lang.title);
					if (Array.isArray(lang?.content))
						for (const para of lang.content)
							for (const e of para) if (e.tag === "text" && e.text) texts.push(e.text);
				}
				return { text: texts.join(" ") };
			}
			default:
				return { text: `[不支持: ${messageType}]` };
		}
	} catch {
		return { text: content };
	}
}

// ── ANSI 清理 ────────────────────────────────────
function strip(s: string): string {
	return s
		.replace(/\x1b\][^\x07]*\x07/g, "")
		.replace(/\x1b\][^\x1b]*\x1b\\/g, "")
		.replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, "")
		.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
		.replace(/\x1b[=>MNOZ78]/g, "")
		.replace(/\r/g, "")
		.trim();
}

// ── 项目路由 ─────────────────────────────────────
function route(text: string): { workspace: string; prompt: string; label: string } {
	const { projects, default_project } = projectsConfig;
	const m = text.match(/^(\S+?)[:\uff1a]\s*(.+)/s);
	if (m && projects[m[1].toLowerCase()]) {
		return {
			workspace: projects[m[1].toLowerCase()].path,
			prompt: m[2].trim(),
			label: m[1].toLowerCase(),
		};
	}
	return {
		workspace: projects[default_project]?.path || ROOT,
		prompt: text.trim(),
		label: default_project,
	};
}

// ── 可选模型列表 ─────────────────────────────────
const CURSOR_MODELS = [
	{ id: "opus-4.6-thinking", label: "Opus 4.6", desc: "最强深度推理" },
	{ id: "opus-4.5-thinking", label: "Opus 4.5", desc: "强力推理" },
	{ id: "gpt-5.3-codex", label: "GPT-5.3 Codex", desc: "OpenAI 编码旗舰" },
	{ id: "gemini-3.1-pro", label: "Gemini 3.1 Pro", desc: "Google 最新旗舰" },
	{ id: "gemini-3-pro", label: "Gemini 3 Pro", desc: "Google 旗舰" },
	{ id: "gemini-3-flash", label: "Gemini 3 Flash", desc: "Google 极速" },
	{ id: "auto", label: "Auto", desc: "自动选择最优" },
];

function fuzzyMatchModel(input: string): { exact?: typeof CURSOR_MODELS[number]; candidates: typeof CURSOR_MODELS } {
	const q = input.toLowerCase().replace(/[\s_-]+/g, "");

	// 精确匹配 id
	const exact = CURSOR_MODELS.find((m) => m.id === input.toLowerCase());
	if (exact) return { exact, candidates: [] };

	// 编号匹配
	const num = Number.parseInt(input, 10);
	if (!Number.isNaN(num) && num >= 1 && num <= CURSOR_MODELS.length) {
		return { exact: CURSOR_MODELS[num - 1], candidates: [] };
	}

	// 模糊：id 或 label 包含输入
	const candidates = CURSOR_MODELS.filter((m) => {
		const mid = m.id.replace(/[\s_-]+/g, "");
		const mlab = m.label.toLowerCase().replace(/[\s_-]+/g, "");
		return mid.includes(q) || mlab.includes(q) || q.includes(mid);
	});

	if (candidates.length === 1) return { exact: candidates[0], candidates: [] };
	return { candidates };
}

function buildModelListCard(currentModel: string, errorHint?: string): string {
	const lines: string[] = [];
	if (errorHint) lines.push(`${errorHint}\n`);
	for (let i = 0; i < CURSOR_MODELS.length; i++) {
		const m = CURSOR_MODELS[i];
		const isCurrent = m.id === currentModel;
		lines.push(isCurrent
			? `**${i + 1}. ${m.id}** · ${m.desc} ✅`
			: `${i + 1}. \`${m.id}\` · ${m.desc}`);
	}
	lines.push("");
	lines.push("> 发送 `/模型 编号` 或 `/模型 名称` 切换");
	return lines.join("\n");
}

// ── 模型自动降级 ─────────────────────────────────
// 每次请求都先试首选模型，失败再用 auto 重试
const BILLING_PATTERNS = [
	/unpaid invoice/i,
	/pay your invoice/i,
	/resume requests/i,
	/billing/i,
	/insufficient.*(balance|credit|fund|quota)/i,
	/exceeded.*limit/i,
	/payment.*required/i,
	/out of credits/i,
	/usage.*limit.*exceeded/i,
	/subscription.*expired/i,
	/plan.*expired/i,
	/402/,
	/费用不足/,
	/余额不足/,
	/额度/,
];

function isBillingError(text: string): boolean {
	return BILLING_PATTERNS.some((p) => p.test(text));
}

// Agent 全局超时时间（30分钟），防止长时间任务卡死
const MAX_AGENT_TIMEOUT = 30 * 60 * 1000; // 30分钟

const childPids = new Set<number>();
// lockKey → 正在运行的 agent 子进程（用于 /stop 终止）
const activeAgents = new Map<string, { pid: number; kill: () => void }>();

process.on("SIGTERM", () => {
	for (const pid of childPids) {
		try { process.kill(pid, "SIGTERM"); } catch {}
	}
	process.exit(0);
});

// ── Agent 执行引擎（直接 spawn CLI + stream-json）──
const PROGRESS_INTERVAL = 2_000;

interface AgentProgress {
	elapsed: number;
	phase: "thinking" | "tool_call" | "responding";
	snippet: string;
}

function formatElapsed(seconds: number): string {
	if (seconds < 60) return `${seconds}秒`;
	const mins = Math.floor(seconds / 60);
	const secs = seconds % 60;
	if (mins < 60) return secs > 0 ? `${mins}分${secs}秒` : `${mins}分`;
	const hrs = Math.floor(mins / 60);
	return `${hrs}时${mins % 60}分`;
}

// ── 时间格式化 ───────────────────────────────────
function formatRelativeTime(ms: number): string {
	const diff = Date.now() - ms;
	if (diff < 60_000) return "刚刚";
	if (diff < 3600_000) return `${Math.floor(diff / 60_000)}分钟前`;
	if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}小时前`;
	if (diff < 604800_000) return `${Math.floor(diff / 86400_000)}天前`;
	return new Date(ms).toLocaleDateString("zh-CN");
}

// ── 会话管理（支持历史列表 + 切换）─────────────────
const SESSIONS_PATH = resolve(import.meta.dirname, ".sessions.json");
const MAX_SESSION_HISTORY = 20;

interface SessionEntry {
	id: string;
	createdAt: number;
	lastActiveAt: number;
	summary: string;
}

interface WorkspaceSessions {
	active: string | null;
	history: SessionEntry[];
}

const sessionsStore: Map<string, WorkspaceSessions> = new Map();

function loadSessionsFromDisk(): void {
	try {
		if (!existsSync(SESSIONS_PATH)) return;
		const raw = JSON.parse(readFileSync(SESSIONS_PATH, "utf-8"));
		sessionsStore.clear();
		for (const [k, v] of Object.entries(raw)) {
			if (typeof v === "string") {
				sessionsStore.set(k, {
					active: v,
					history: [{ id: v, createdAt: Date.now(), lastActiveAt: Date.now(), summary: "(旧会话)" }],
				});
			} else {
				sessionsStore.set(k, v as WorkspaceSessions);
			}
		}
		console.log(`[Session] 从磁盘恢复 ${sessionsStore.size} 个工作区会话`);
	} catch {}
}

let sessionsSaving = false;

function saveSessions(): void {
	try {
		sessionsSaving = true;
		writeFileSync(SESSIONS_PATH, JSON.stringify(Object.fromEntries(sessionsStore), null, 2));
	} catch {} finally {
		setTimeout(() => { sessionsSaving = false; }, 500);
	}
}

loadSessionsFromDisk();

watchFile(SESSIONS_PATH, { interval: 3000 }, () => {
	if (sessionsSaving) return;
	try {
		loadSessionsFromDisk();
	} catch {}
});

function getActiveSessionId(workspace: string): string | undefined {
	return sessionsStore.get(workspace)?.active || undefined;
}

function setActiveSession(workspace: string, sessionId: string, summary?: string): void {
	let ws = sessionsStore.get(workspace);
	if (!ws) {
		ws = { active: null, history: [] };
		sessionsStore.set(workspace, ws);
	}

	const existing = ws.history.find((h) => h.id === sessionId);
	if (existing) {
		existing.lastActiveAt = Date.now();
		if (summary && existing.summary === "(新会话)") {
			existing.summary = summary;
		}
	} else {
		ws.history.unshift({
			id: sessionId,
			createdAt: Date.now(),
			lastActiveAt: Date.now(),
			summary: summary || "(新会话)",
		});
	}

	if (ws.history.length > MAX_SESSION_HISTORY) {
		ws.history = ws.history.slice(0, MAX_SESSION_HISTORY);
	}

	ws.active = sessionId;
	saveSessions();
}

function updateSessionSummary(workspace: string, sessionId: string, summary: string): void {
	const ws = sessionsStore.get(workspace);
	if (!ws) return;
	const entry = ws.history.find((h) => h.id === sessionId);
	if (entry) {
		entry.summary = summary;
		saveSessions();
	}
}

function generateSessionTitleFallback(prompt: string, result: string): string {
	const noise = /^(帮我|请你?|麻烦|你好|嗨|hi|hello|hey|ok|好的|嗯|哦)[，,。.！!？?\s]*/gi;
	const cleaned = prompt.replace(noise, "").trim();

	if (cleaned.length >= 4 && cleaned.length <= 40) return cleaned;
	if (cleaned.length > 40) {
		const cutoff = cleaned.slice(0, 40);
		const lastPunct = Math.max(
			cutoff.lastIndexOf("，"), cutoff.lastIndexOf("。"),
			cutoff.lastIndexOf("；"), cutoff.lastIndexOf(","),
			cutoff.lastIndexOf(" "),
		);
		return (lastPunct > 15 ? cutoff.slice(0, lastPunct) : cutoff) + "…";
	}
	const firstLine = result.split("\n").find((l) => {
		const t = l.replace(/^[#*>\-\s]+/, "").trim();
		return t.length >= 4 && !t.startsWith("```") && !t.startsWith("HEARTBEAT");
	});
	if (firstLine) {
		const t = firstLine.replace(/^[#*>\-\s]+/, "").replace(/\*\*/g, "").trim();
		return t.length <= 40 ? t : t.slice(0, 38) + "…";
	}
	return cleaned || prompt.slice(0, 30) || "(对话)";
}

async function generateSessionTitle(workspace: string, sessionId: string, prompt: string, result: string): Promise<void> {
	const fallback = generateSessionTitleFallback(prompt, result);
	try {
		const context = `用户: ${prompt.slice(0, 200)}\n\nAI回复摘要: ${result.slice(0, 500)}`;
		const titlePrompt = `根据以下对话，生成一个简短的中文标题。要求：必须使用中文，4-20个字，不加标点，不加引号，不加书名号，直接输出标题，不要输出任何其它内容。\n\n${context}`;
		const child = spawn(AGENT_BIN, [
			"-p", "--force", "--trust",
			"--model", "auto",
			"--output-format", "text",
			"--", titlePrompt,
		], {
			env: { ...process.env, CURSOR_API_KEY: config.CURSOR_API_KEY },
			stdio: ["ignore", "pipe", "pipe"],
		});

		const title = await new Promise<string>((resolve) => {
			let out = "";
			const timeout = setTimeout(() => { child.kill(); resolve(fallback); }, 15_000);
			child.stdout!.on("data", (c: Buffer) => { out += c.toString(); });
			child.on("close", () => {
				clearTimeout(timeout);
				const raw = out.trim().split("\n").pop()?.trim() || "";
				const clean = raw.replace(/^["'「《]|["'」》]$/g, "").replace(/[。.！!？?]$/, "").trim();
				resolve(clean.length >= 2 && clean.length <= 30 ? clean : fallback);
			});
			child.on("error", () => { clearTimeout(timeout); resolve(fallback); });
		});

		updateSessionSummary(workspace, sessionId, title);
		console.log(`[Session] LLM 命名: ${title}`);
	} catch {
		updateSessionSummary(workspace, sessionId, fallback);
		console.log(`[Session] 降级命名: ${fallback}`);
	}
}

function archiveAndResetSession(workspace: string): void {
	const ws = sessionsStore.get(workspace);
	if (ws?.active) {
		ws.active = null;
		saveSessions();
		console.log(`[Session ${workspace}] 已归档并重置`);
	}
}

function switchToSession(workspace: string, sessionId: string): boolean {
	const ws = sessionsStore.get(workspace);
	if (!ws) return false;
	const entry = ws.history.find((h) => h.id === sessionId);
	if (!entry) return false;
	ws.active = sessionId;
	entry.lastActiveAt = Date.now();
	saveSessions();
	return true;
}

function getSessionHistory(workspace: string, limit = 10): SessionEntry[] {
	const ws = sessionsStore.get(workspace);
	if (!ws) return [];
	return [...ws.history]
		.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
		.slice(0, limit);
}

// 同一 session 的消息串行执行；不同 session（即使同工作区）可并行
const sessionLocks = new Map<string, Promise<void>>();
async function withSessionLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
	const prev = sessionLocks.get(lockKey) || Promise.resolve();
	let release!: () => void;
	const next = new Promise<void>((r) => { release = r; });
	sessionLocks.set(lockKey, next);
	await prev;
	try {
		return await fn();
	} finally {
		release();
	}
}

function getLockKey(workspace: string): string {
	const sid = getActiveSessionId(workspace);
	return sid ? `session:${sid}` : `ws:${workspace}`;
}

// 解析一行 stream-json 输出
interface StreamEvent {
	type: string;
	subtype?: string;
	session_id?: string;
	text?: string;
	result?: string;
	error?: string;
	message?: { role: string; content: Array<{ type: string; text?: string }> };
	tool_name?: string;
	tool_call_id?: string;
	call_id?: string;
	tool_call?: Record<string, { args?: Record<string, unknown>; result?: Record<string, { content?: string }> }>;
}

function tryParseJson(line: string): StreamEvent | null {
	const trimmed = line.trim();
	if (!trimmed || !trimmed.startsWith("{")) return null;
	try { return JSON.parse(trimmed); } catch { return null; }
}

const TOOL_LABELS: Record<string, string> = {
	read: "📖 读取", write: "✏️ 写入", strReplace: "✏️ 编辑",
	shell: "⚡ 执行", grep: "🔍 搜索", glob: "📂 查找",
	semanticSearch: "🔎 语义搜索", webSearch: "🌐 搜索网页", webFetch: "🌐 抓取网页",
	delete: "🗑️ 删除", editNotebook: "📓 编辑笔记本",
	callMcpTool: "🔌 MCP工具", task: "🤖 子任务",
};

function describeToolCall(tc: Record<string, { args?: Record<string, unknown> }>): string {
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

function describeToolResult(tc: Record<string, { args?: Record<string, unknown>; result?: Record<string, { content?: string }> }>): string {
	for (const val of Object.values(tc)) {
		const r = val?.result;
		if (!r) return "";
		const success = r.success as Record<string, unknown> | undefined;
		if (success?.content) return String(success.content).slice(0, 200);
		const err = r.error as Record<string, unknown> | undefined;
		if (err?.message) return `❌ ${String(err.message).slice(0, 150)}`;
	}
	return "";
}

function basename(p: string): string {
	const parts = p.split("/");
	return parts[parts.length - 1] || p;
}

// 核心：spawn agent CLI，解析 stream-json，返回结果
function execAgent(
	lockKey: string,
	workspace: string,
	model: string,
	prompt: string,
	opts?: {
		sessionId?: string;
		onProgress?: (p: AgentProgress) => void;
	},
): Promise<{ result: string; sessionId?: string }> {
	return new Promise((res, reject) => {
		const args = [
			"-p", "--force", "--trust", "--approve-mcps",
			"--workspace", workspace,
			"--model", model,
			"--output-format", "stream-json",
			"--stream-partial-output",
		];

		if (opts?.sessionId) {
			args.push("--resume", opts.sessionId);
		}
		args.push("--", prompt);

		const child = spawn(AGENT_BIN, args, {
			env: { ...process.env, CURSOR_API_KEY: config.CURSOR_API_KEY },
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (child.pid) {
			childPids.add(child.pid);
			activeAgents.set(lockKey, {
				pid: child.pid,
				kill: () => { try { child.kill("SIGTERM"); } catch {} },
			});
		}

		let stderr = "";
		let resultText = "";
		let sessionId: string | undefined;
		let phase: AgentProgress["phase"] = "thinking";
		let thinkingBuf = "";
		let assistantBuf = "";
		let lastSegment = "";
		let toolBuf = ""; // 工具活动日志（显示在进度卡片中）
	let done = false;
	const startTime = Date.now();
	let lastProgressTime = 0;
	let lineBuf = "";
	let globalTimeout: NodeJS.Timeout | null = null;

		function cleanup() {
			done = true;
			clearInterval(timer);
			if (globalTimeout) clearTimeout(globalTimeout);
			if (child.pid) childPids.delete(child.pid);
			activeAgents.delete(lockKey);
		}

		function getSnippet(): string {
			if (phase === "thinking") return thinkingBuf.slice(-200);
			if (phase === "tool_call") {
				const lines = toolBuf.split("\n").filter(l => l.trim());
				return lines.slice(-6).join("\n") || assistantBuf.slice(-300);
			}
			return assistantBuf.slice(-300);
		}

		// 进度更新定时器（每秒）
		const timer = setInterval(() => {
			if (done) return;
			const now = Date.now();
			if (opts?.onProgress && now - lastProgressTime >= PROGRESS_INTERVAL) {
				lastProgressTime = now;
				const snippet = getSnippet();
				if (snippet) {
					opts.onProgress({
						elapsed: Math.round((now - startTime) / 1000),
						phase,
						snippet,
					});
				}
			}
		}, 1000);

		// 全局超时定时器（30分钟）
		globalTimeout = setTimeout(() => {
			if (done) return;
			const elapsed = Math.round((Date.now() - startTime) / 1000 / 60);
			console.error(`[超时] Agent运行超过${MAX_AGENT_TIMEOUT/60000}分钟 (实际: ${elapsed}分钟)，强制终止 [${lockKey}]`);
			cleanup();
			try {
				child.kill("SIGKILL"); // 强制终止
			} catch (e) {
				console.error(`[超时] 终止进程失败:`, e);
			}
			reject(new Error(`Agent运行超时 (${elapsed}分钟)，已强制终止。如需更长时间，请分批处理或使用 /stop 手动终止。`));
		}, MAX_AGENT_TIMEOUT);

		function processLine(line: string) {
			const ev = tryParseJson(line);
			if (!ev) return;

			if (ev.session_id && !sessionId) sessionId = ev.session_id;

			const prevPhase = phase;
			switch (ev.type) {
				case "thinking":
					phase = "thinking";
					if (ev.text) thinkingBuf += ev.text;
					break;
				case "assistant":
					if (phase !== "responding") toolBuf = "";
					phase = "responding";
					if (ev.message?.content) {
						for (const c of ev.message.content) {
							if (c.type === "text" && c.text) {
								assistantBuf += c.text;
								lastSegment += c.text;
							}
						}
					}
					break;
				case "tool_call":
					phase = "tool_call";
					lastSegment = "";
					if (ev.tool_call) {
						if (ev.subtype === "started") {
							const desc = describeToolCall(ev.tool_call);
							toolBuf += (toolBuf ? "\n" : "") + desc;
						} else if (ev.subtype === "completed") {
							const brief = describeToolResult(ev.tool_call);
							if (brief) {
								const oneLiner = brief.split("\n").filter(l => l.trim()).slice(0, 2).join(" | ");
								toolBuf += `  → ${oneLiner.slice(0, 120)}`;
							}
						}
					}
					break;
				case "result":
					if (ev.result != null) resultText = ev.result;
					if (ev.subtype === "error" && ev.error) {
						resultText = ev.error;
					}
					break;
			}

			// 阶段切换 或 tool_call 新事件时立即触发进度更新
			const isToolEvent = ev.type === "tool_call" && ev.tool_call;
			if ((phase !== prevPhase || isToolEvent) && opts?.onProgress) {
				const now = Date.now();
				lastProgressTime = now;
				opts.onProgress({
					elapsed: Math.round((now - startTime) / 1000),
					phase,
					snippet: getSnippet() || "...",
				});
			}
		}

		child.stdout!.on("data", (chunk: Buffer) => {
			lineBuf += chunk.toString();
			const lines = lineBuf.split("\n");
			lineBuf = lines.pop()!;
			for (const line of lines) processLine(line);
		});

		child.stderr!.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		child.on("close", (code) => {
			if (done) return;
			cleanup();
			// 处理 lineBuf 中残留的最后一行
			if (lineBuf.trim()) processLine(lineBuf);

			// 优先取最后一段 assistant 回复（最终结果），避免输出中间过程
			const finalSegment = strip(lastSegment);
			const output = finalSegment || resultText || strip(assistantBuf) || strip(stderr) || "(无输出)";

			if (code !== 0 && code !== null && !resultText) {
				reject(new Error(strip(stderr) || output));
				return;
			}
			if (isBillingError(output) || isBillingError(stderr)) {
				reject(new Error(output));
				return;
			}
			res({ result: output, sessionId });
		});

		child.on("error", (err) => {
			if (!done) { cleanup(); reject(err); }
		});
	});
}

// ── 会话级活跃追踪（lockKey = session:id 或 ws:path）──────
const busySessions = new Set<string>();

// ── 发送消息（会话优先，欠费降级 auto）──────────
async function runAgent(
	workspace: string,
	prompt: string,
	opts?: {
		onProgress?: (p: AgentProgress) => void;
		onStart?: () => void;
	},
): Promise<{ result: string; quotaWarning?: string }> {
	const primaryModel = config.CURSOR_MODEL;
	const lockKey = getLockKey(workspace);

	return withSessionLock(lockKey, async () => {
		busySessions.add(lockKey);
		opts?.onStart?.();
		try {
			const existingSessionId = getActiveSessionId(workspace);
			const isNewSession = !existingSessionId;

			try {
				const { result, sessionId } = await execAgent(lockKey, workspace, primaryModel, prompt, {
					sessionId: existingSessionId,
					onProgress: opts?.onProgress,
				});
				if (sessionId) {
					setActiveSession(workspace, sessionId);
					if (isNewSession) {
						generateSessionTitle(workspace, sessionId, prompt, result);
					}
				}
				return { result };
			} catch (err) {
				const e = err instanceof Error ? err : new Error(String(err));

				if (existingSessionId && !isBillingError(e.message)) {
					console.warn(`[重试] 会话可能过期，重新创建: ${e.message.slice(0, 100)}`);
					archiveAndResetSession(workspace);
					try {
						const { result, sessionId } = await execAgent(lockKey, workspace, primaryModel, prompt, {
							onProgress: opts?.onProgress,
						});
						if (sessionId) {
							setActiveSession(workspace, sessionId);
							generateSessionTitle(workspace, sessionId, prompt, result);
						}
						return { result };
					} catch (retryErr) {
						const re = retryErr instanceof Error ? retryErr : new Error(String(retryErr));
						if (!isBillingError(re.message)) throw re;
					}
				}

				if (isBillingError(e.message)) {
					console.error(`[降级] ${primaryModel} 欠费: ${e.message.slice(0, 200)}`);
					const fallbackSessionId = getActiveSessionId(workspace);
					try {
						const { result, sessionId: newSid } = await execAgent(lockKey, workspace, "auto", prompt, {
							sessionId: fallbackSessionId,
							onProgress: opts?.onProgress,
						});
						if (newSid) {
							setActiveSession(workspace, newSid);
							if (!fallbackSessionId) {
								generateSessionTitle(workspace, newSid, prompt, result);
							}
						}
						return {
							result,
							quotaWarning: `⚠️ **模型降级通知**\n\n${primaryModel} 欠费，本次已用 auto 完成。\n\n> ${e.message.slice(0, 100)}`,
						};
					} catch {
						throw e;
					}
				}

				archiveAndResetSession(workspace);
				throw e;
			}
		} finally {
			busySessions.delete(lockKey);
		}
	});
}

// ── 去重 + 并发控制 + 排队 ───────────────────────
const seen = new Map<string, number>();
function isDup(id: string): boolean {
	const now = Date.now();
	for (const [k, t] of seen) if (now - t > 60_000) seen.delete(k);
	if (seen.has(id)) return true;
	seen.set(id, now);
	return false;
}
// ── 消息处理 ─────────────────────────────────────
async function handle(params: {
	text: string;
	messageId: string;
	chatId: string;
	chatType: string;
	messageType: string;
	content: string;
}) {
	const { messageId, chatId, chatType, messageType, content } = params;
	let { text } = params;
	// 记录最近活跃会话用于定时任务/心跳主动推送
	lastActiveChatId = chatId;
	console.log(`[${new Date().toISOString()}] [${messageType}] ${text.slice(0, 80)}`);

	return handleInner(text, messageId, chatId, chatType, messageType, content);
}

async function handleInner(
	text: string,
	messageId: string,
	chatId: string,
	chatType: string,
	messageType: string,
	content: string,
): Promise<void> {
	let cardId: string | undefined;
	const isGroup = chatType === "group";
	// 处理媒体附件
	const parsed = parseContent(messageType, content);
	try {
		if (parsed.imageKey) {
			const path = await downloadMedia(messageId, parsed.imageKey, "image", ".png");
			text = text
				? `${text}\n\n[附件图片: ${path}]`
				: `用户发了一张图片，已保存到 ${path}，请查看并回复。`;
		}
		if (parsed.fileKey && messageType === "audio") {
			if (!cardId) {
				cardId = await replyCard(messageId, "🎙️ 正在识别语音...", { title: "语音识别中", color: "wathet" });
			} else {
				await updateCard(cardId, "🎙️ 正在识别语音...", { title: "语音识别中", color: "wathet" });
			}
			const audioPath = await downloadMedia(messageId, parsed.fileKey, "file", ".ogg");
			const transcript = await transcribeAudio(audioPath);
			try { unlinkSync(audioPath); } catch {}
			if (transcript) {
				text = transcript;
				console.log(`[语音] 转文字成功: ${transcript.slice(0, 80)}`);
			} else {
				text = `用户发了一条语音消息，音频文件在 ${audioPath}，请处理并回复。`;
				console.warn("[语音] 转文字失败，传原始文件路径");
			}
		}
		if (parsed.fileKey && messageType === "file") {
			const dotIdx = parsed.fileName?.lastIndexOf(".");
			const ext = dotIdx != null && dotIdx > 0 ? parsed.fileName!.slice(dotIdx) : "";
			const path = await downloadMedia(messageId, parsed.fileKey, "file", ext);
			text = text
				? `${text}\n\n[附件: ${path}]`
				: `用户发了文件 ${parsed.fileName || ""}，已保存到 ${path}`;
		}
	} catch (e) {
		console.error("[下载失败]", e);
		if (!text) {
			if (cardId) await updateCard(cardId, "❌ 媒体下载失败，请重新发送", { color: "red" });
			else await replyCard(messageId, "❌ 媒体下载失败，请重新发送");
			return;
		}
	}

	if (!text) return;

	// /apikey、/密钥、/换key → 更换 Cursor API Key
	if (/^\/?(?:apikey|api\s*key|密钥|换key|更换密钥)\s*$/i.test(text.trim())) {
		const keyPreview = config.CURSOR_API_KEY ? `\`...${config.CURSOR_API_KEY.slice(-8)}\`` : "**未设置**";
		await replyCard(messageId, `当前 Key：${keyPreview}\n\n更换方式：\`/密钥 key_xxx...\` 或 \`/apikey key_xxx...\`\n\n[生成新 Key →](https://cursor.com/dashboard)`, { title: "API Key", color: "blue" });
		return;
	}
	const apikeyMatch = text.match(/^\/?(?:api\s*key|密钥|换key|更换密钥)[\s:：=]*(.+)/i);
	if (apikeyMatch) {
		if (isGroup) {
			await replyCard(messageId, "⚠️ **安全提醒：请勿在群聊中发送 API Key！**\n\n请在与机器人的 **私聊** 中发送 `/apikey` 指令。", { title: "安全提醒", color: "red" });
			return;
		}
		const rawKey = apikeyMatch[1].trim().replace(/^["'`]+|["'`]+$/g, "");
		if (!rawKey || rawKey.length < 20) {
			await replyCard(messageId, "❌ Key 格式不对，太短了。请发送完整的 Cursor API Key。\n\n支持格式：\n- `/apikey key_xxxx...`\n- `/密钥 key_xxxx...`\n- `/换key key_xxxx...`", { title: "格式错误", color: "red" });
			return;
		}
		try {
			const envContent = readFileSync(ENV_PATH, "utf-8");
			const updated = envContent.replace(/^CURSOR_API_KEY=.*$/m, `CURSOR_API_KEY=${rawKey}`);
			writeFileSync(ENV_PATH, updated);
			await replyCard(messageId, `**API Key 已更换**\n\n新 Key: \`...${rawKey.slice(-8)}\`\n\n已写入 .env 并自动生效。`, { title: "Key 已更新", color: "green" });
			console.log(`[指令] API Key 已通过飞书更换 (...${rawKey.slice(-8)})`);
		} catch (err) {
			await replyCard(messageId, `❌ 写入失败: ${err instanceof Error ? err.message : err}`, { color: "red" });
		}
		return;
	}

	// /help → 显示所有可用指令
	const helpMatch = text.trim().match(/^\/(help|帮助|指令)\s*$/i);
	if (helpMatch) {
		const en = helpMatch[1].toLowerCase() === "help";
		const c = (zh: string, enAlias?: string) => en && enAlias ? `\`${zh}\` \`${enAlias}\`` : `\`${zh}\``;
		const helpText = [
			"**基础指令**",
			`- ${c("/帮助", "/help")} — 显示本帮助`,
			`- ${c("/状态", "/status")} — 查看服务状态`,
			`- ${c("/新对话", "/new")} — 重置当前会话`,
			`- ${c("/终止", "/stop")} — 终止正在执行的任务`,
			"",
			"**会话管理**",
			`- ${c("/会话", "/sessions")} — 查看最近会话列表`,
			`- \`/会话 编号\` — 切换到指定会话`,
			`- ${c("/新对话", "/new")} — 归档当前会话，开启新对话`,
			"",
			"**模型与密钥**",
			`- ${c("/模型", "/model")} — 查看/切换 AI 模型`,
			`- ${c("/密钥", "/apikey")} — 查看/更换 API Key（仅私聊）`,
			"  用法：`/密钥 key_xxx...`",
			"",
			"**记忆系统**",
			`- ${c("/记忆", "/memory")} — 查看记忆状态`,
			`- \`/记忆 关键词\` — 语义搜索记忆`,
			`- \`/记录 内容\` — 写入今日日记`,
			`- ${c("/整理记忆", "/reindex")} — 重建记忆索引`,
			"",
			"**定时任务**",
			`- ${c("/任务", "/cron")} — 查看所有定时任务`,
			"- `/任务 暂停/恢复/删除/执行 ID`",
			"- 或在对话中说「每天早上9点做XX」由 AI 自动创建",
			"",
			"**心跳系统**",
			`- ${c("/心跳", "/heartbeat")} — 查看心跳状态`,
			"- `/心跳 开启/关闭/执行`",
			"- `/心跳 间隔 分钟数`",
			"",
			"**项目路由**",
			`发送 \`项目名:消息\` 指定工作区，如 \`openclaw:帮我看看这个bug\``,
			`可用项目：${Object.keys(projectsConfig.projects).map((k) => `\`${k}\``).join("、")}（默认：\`${projectsConfig.default_project}\`）`,
		].join("\n");
		await replyCard(messageId, helpText, { title: "📖 使用帮助", color: "blue" });
		return;
	}

	// /status → 服务状态一览
	if (/^\/(status|状态)\s*$/i.test(text.trim())) {
		const keyPreview = config.CURSOR_API_KEY ? `\`...${config.CURSOR_API_KEY.slice(-8)}\`` : "**未设置**";
		const sttStatus = config.VOLC_STT_APP_ID ? "火山引擎豆包大模型" : (existsSync(WHISPER_MODEL) ? "本地 whisper" : "不可用");
		const projects = Object.entries(projectsConfig.projects).map(([k, v]) => `  \`${k}\` → ${v.path}`).join("\n");
		const sessions = [...sessionsStore.entries()]
			.filter(([, s]) => s.active)
			.map(([ws, s]) => {
				const name = Object.entries(projectsConfig.projects).find(([, v]) => v.path === ws)?.[0] || ws;
				const entry = s.history.find((h) => h.id === s.active);
				const info = entry ? ` · ${entry.summary.slice(0, 30)}` : "";
				return `  \`${name}\` → ${s.active!.slice(0, 12)}...${info}`;
			}).join("\n") || "  (无活跃会话)";
		const memStatus = memory
			? (() => {
				const stats = memory.getStats();
				return `全工作区索引（${stats.chunks} 块, ${stats.files} 文件, ${stats.cachedEmbeddings} 嵌入缓存）`;
			})()
			: "未启用";
		const statusText = [
			`**模型：** ${config.CURSOR_MODEL}`,
			`**Key：** ${keyPreview}`,
			`**STT：** ${sttStatus}`,
			`**记忆：** ${memStatus}`,
			`**调度：** ${(() => { const s = scheduler.getStats(); return s.total > 0 ? `${s.enabled}/${s.total} 任务${s.nextRunIn ? `（下次: ${s.nextRunIn}）` : ""}` : "无任务"; })()}`,
			`**心跳：** ${heartbeat.getStatus().enabled ? `每 ${Math.round(heartbeat.getStatus().everyMs / 60000)} 分钟` : "未启用"}`,
			`**活跃任务：** ${busySessions.size} 个运行中`,
			"",
			"**项目路由：**",
			projects,
			"",
			"**活跃会话：**",
			sessions,
		].join("\n");
		await replyCard(messageId, statusText, { title: "服务状态", color: "blue" });
		return;
	}

	// /model、/模型、/切换模型 → 切换模型
	const modelMatch = text.match(/^\/(model|模型|切换模型)[\s:：=]*(.*)/i);
	if (modelMatch) {
		const input = modelMatch[2].trim();

		// 无参数 → 显示模型列表
		if (!input) {
			await replyCard(messageId, buildModelListCard(config.CURSOR_MODEL), { title: "选择模型", color: "blue" });
			return;
		}

		const { exact, candidates } = fuzzyMatchModel(input);

		if (exact) {
			// 精确匹配或唯一模糊匹配 → 直接切换
			if (exact.id === config.CURSOR_MODEL) {
				await replyCard(messageId, `当前已是 **${exact.id}**（${exact.desc}），无需切换。`, { title: "当前模型", color: "blue" });
				return;
			}
			const envContent = readFileSync(ENV_PATH, "utf-8");
			const updated = envContent.match(/^CURSOR_MODEL=/m)
				? envContent.replace(/^CURSOR_MODEL=.*$/m, `CURSOR_MODEL=${exact.id}`)
				: `${envContent.trimEnd()}\nCURSOR_MODEL=${exact.id}\n`;
			writeFileSync(ENV_PATH, updated);
			const prev = config.CURSOR_MODEL;
			await replyCard(messageId, `${prev} → **${exact.id}**（${exact.desc}）\n\n已写入 .env，2 秒内自动生效。`, { title: "模型已切换", color: "green" });
			console.log(`[指令] 模型切换: ${prev} → ${exact.id}`);
			return;
		}

		if (candidates.length > 1) {
			// 多个候选 → 提示用户精确选择
			const list = candidates.map((m) => `- \`${m.id}\`（${m.desc}）`).join("\n");
			await replyCard(messageId, `「${input}」匹配到多个模型：\n\n${list}\n\n请输入更精确的名称或编号。`, { title: "请精确选择", color: "orange" });
			return;
		}

		// 列表外的自定义模型名 → 确认后切换
		if (input.length < 2 || /^\d+$/.test(input)) {
			await replyCard(messageId, buildModelListCard(config.CURSOR_MODEL, `「${input}」无匹配，请从列表中选择`), { title: "未找到模型", color: "orange" });
			return;
		}

		const envContent = readFileSync(ENV_PATH, "utf-8");
		const updated = envContent.match(/^CURSOR_MODEL=/m)
			? envContent.replace(/^CURSOR_MODEL=.*$/m, `CURSOR_MODEL=${input}`)
			: `${envContent.trimEnd()}\nCURSOR_MODEL=${input}\n`;
		writeFileSync(ENV_PATH, updated);
		const prev = config.CURSOR_MODEL;
		await replyCard(messageId, `${prev} → **${input}**\n\n⚠️ 此模型不在常用列表中，若名称有误可能导致执行失败。\n发送 \`/模型\` 查看常用列表。`, { title: "模型已切换", color: "yellow" });
		console.log(`[指令] 模型切换(自定义): ${prev} → ${input}`);
		return;
	}

	// /stop、/终止、/停止 → 终止当前会话运行的 agent
	if (/^\/(stop|终止|停止)\s*$/i.test(text.trim())) {
		const { workspace: ws } = route(text);
		const lk = getLockKey(ws);
		const agent = activeAgents.get(lk);
		if (agent) {
			agent.kill();
			console.log(`[指令] 终止 agent pid=${agent.pid} session=${lk}`);
			await replyCard(messageId, "已终止当前任务。\n\n发送新消息将继续在当前会话中对话。", { title: "已终止", color: "orange" });
		} else {
			await replyCard(messageId, "当前没有正在运行的任务。", { title: "无任务", color: "grey" });
		}
		return;
	}

	// /记忆、/memory → 记忆系统操作
	const memoryMatch = text.match(/^\/(记忆|memory|搜索记忆|recall)[\s:：=]*(.*)/i);
	if (memoryMatch) {
		if (!memory) {
			await replyCard(messageId, "记忆系统未初始化（缺少向量嵌入 API Key）。\n\n请在 `.env` 中设置 `VOLC_EMBEDDING_API_KEY`。", { title: "记忆不可用", color: "orange" });
			return;
		}
		const query = memoryMatch[2].trim();
		if (!query) {
			const summary = memory.getRecentSummary(3);
			const stats = memory.getStats();
			const fileList = stats.filePaths.length > 0
				? stats.filePaths.slice(0, 25).map((p) => `- \`${p}\``).join("\n") + (stats.filePaths.length > 25 ? `\n- …及其他 ${stats.filePaths.length - 25} 个文件` : "")
				: "（尚未索引，请发送 `/整理记忆`）";
			const statusText = [
				`**记忆索引：** ${stats.chunks} 块（${stats.files} 文件, ${stats.cachedEmbeddings} 嵌入缓存）`,
				`**索引范围：** 工作区全部文本文件（.md .txt .html .json .mdc 等）`,
				`**嵌入模型：** ${config.VOLC_EMBEDDING_MODEL}`,
				"",
				"**用法：**",
				"- `/记忆 关键词` — 语义搜索记忆",
				"- `/记录 内容` — 写入今日日记",
				"- `/整理记忆` — 重建全工作区索引",
				"",
				`**已索引文件：**\n${fileList}`,
				"",
				summary ? `**最近记忆摘要：**\n\n${summary.slice(0, 1500)}` : "（暂无记忆文件）",
			].join("\n");
			await replyCard(messageId, statusText, { title: "🧠 记忆系统", color: "purple" });
			return;
		}
		try {
			const results = await memory.search(query, 5);
			if (results.length === 0) {
				await replyCard(messageId, `未找到与「${query}」相关的记忆。\n\n索引范围：工作区全部文本文件（发 \`/整理记忆\` 可刷新）`, { title: "无匹配", color: "grey" });
				return;
			}
			const lines = results.map((r, i) =>
				`**${i + 1}.** \`${r.path}#L${r.startLine}\`（相关度 ${(r.score * 100).toFixed(0)}%）\n${r.text.slice(0, 300)}`,
			);
			await replyCard(messageId, lines.join("\n\n---\n\n"), { title: `🔍 搜索「${query}」`, color: "purple" });
		} catch (e) {
			await replyCard(messageId, `搜索失败: ${e instanceof Error ? e.message : e}`, { color: "red" });
		}
		return;
	}

	// /记录 → 快速写入今日日记
	const logMatch = text.match(/^\/(记录|log|note)[\s:：=]+(.+)/is);
	if (logMatch) {
		if (!memory) {
			await replyCard(messageId, "记忆系统未初始化。", { title: "不可用", color: "orange" });
			return;
		}
		const content = logMatch[2].trim();
		const path = memory.appendDailyLog(content);
		await replyCard(messageId, `已记录到今日日记。\n\n\`${path}\``, { title: "📝 已记录", color: "green" });
		return;
	}

	// /整理记忆 → 重建全工作区记忆索引
	if (/^\/(整理记忆|reindex|索引)\s*$/i.test(text.trim())) {
		if (!memory) {
			await replyCard(messageId, "记忆系统未初始化。", { title: "不可用", color: "orange" });
			return;
		}
		const reindexCardId = await replyCard(messageId, "⏳ 正在扫描并索引工作区全部文本文件...", { title: "全工作区索引中", color: "wathet" });
		try {
			const count = await memory.index();
			const stats = memory.getStats();
			const msg = [
				`索引完成: **${count}** 个记忆块（来自 **${stats.files}** 个文件）`,
				`嵌入缓存: ${stats.cachedEmbeddings} 条`,
				`嵌入模型: \`${config.VOLC_EMBEDDING_MODEL}\``,
				"",
				"**已索引文件：**",
				...stats.filePaths.slice(0, 25).map((p) => `- \`${p}\``),
				...(stats.filePaths.length > 25 ? [`- …及其他 ${stats.filePaths.length - 25} 个文件`] : []),
			].join("\n");
			if (reindexCardId) await updateCard(reindexCardId, msg, { title: "✅ 全工作区索引完成", color: "green" });
			else await replyCard(messageId, msg, { title: "✅ 全工作区索引完成", color: "green" });
		} catch (e) {
			const msg = `索引失败: ${e instanceof Error ? e.message : e}`;
			if (reindexCardId) await updateCard(reindexCardId, msg, { title: "索引失败", color: "red" });
			else await replyCard(messageId, msg, { color: "red" });
		}
		return;
	}

	// /任务、/cron、/定时 → 定时任务管理
	const taskMatch = text.match(/^\/(任务|cron|定时|task|schedule|定时任务)[\s:：]*(.*)/i);
	if (taskMatch) {
		const subCmd = taskMatch[2].trim().toLowerCase();

		if (!subCmd || subCmd === "list" || subCmd === "列表") {
			const jobs = await scheduler.list();
			if (jobs.length === 0) {
				await replyCard(messageId, "暂无定时任务。\n\n在对话中告诉 AI「每天早上9点检查邮件」即可自动创建，\n或手动编辑工作区的 `cron-jobs.json`。", { title: "📋 定时任务", color: "blue" });
				return;
			}
			const lines = jobs.map((j, i) => {
				const status = j.enabled ? "✅" : "⏸";
				const schedDesc = j.schedule.kind === "at" ? `一次性 ${j.schedule.at}` :
					j.schedule.kind === "every" ? `每 ${Math.round(j.schedule.everyMs / 60000)} 分钟` :
					`cron: ${j.schedule.expr}`;
				const lastRun = j.state.lastRunAtMs ? new Date(j.state.lastRunAtMs).toLocaleString("zh-CN") : "从未执行";
				return `${status} **${i + 1}. ${j.name}**\n   调度: ${schedDesc}\n   上次: ${lastRun}\n   ID: \`${j.id.slice(0, 8)}\``;
			});
			const stats = scheduler.getStats();
			lines.push("", `共 ${stats.total} 个任务（${stats.enabled} 启用）${stats.nextRunIn ? `，下次执行: ${stats.nextRunIn}` : ""}`);
			await replyCard(messageId, lines.join("\n"), { title: "📋 定时任务", color: "blue" });
			return;
		}

		// /任务 暂停 ID
		const pauseMatch = subCmd.match(/^(暂停|pause|disable)\s+(\S+)/i);
		if (pauseMatch) {
			const idPrefix = pauseMatch[2];
			const job = (await scheduler.list(true)).find((j) => j.id.startsWith(idPrefix));
			if (!job) { await replyCard(messageId, `未找到 ID 为 \`${idPrefix}\` 的任务`, { title: "未找到", color: "orange" }); return; }
			await scheduler.update(job.id, { enabled: false });
			await replyCard(messageId, `已暂停: **${job.name}**`, { title: "⏸ 已暂停", color: "orange" });
			return;
		}

		// /任务 恢复 ID
		const resumeMatch = subCmd.match(/^(恢复|resume|enable)\s+(\S+)/i);
		if (resumeMatch) {
			const idPrefix = resumeMatch[2];
			const job = (await scheduler.list(true)).find((j) => j.id.startsWith(idPrefix));
			if (!job) { await replyCard(messageId, `未找到 ID 为 \`${idPrefix}\` 的任务`, { title: "未找到", color: "orange" }); return; }
			await scheduler.update(job.id, { enabled: true });
			await replyCard(messageId, `已恢复: **${job.name}**`, { title: "✅ 已恢复", color: "green" });
			return;
		}

		// /任务 删除 ID
		const delMatch = subCmd.match(/^(删除|delete|remove|del)\s+(\S+)/i);
		if (delMatch) {
			const idPrefix = delMatch[2];
			const job = (await scheduler.list(true)).find((j) => j.id.startsWith(idPrefix));
			if (!job) { await replyCard(messageId, `未找到 ID 为 \`${idPrefix}\` 的任务`, { title: "未找到", color: "orange" }); return; }
			await scheduler.remove(job.id);
			await replyCard(messageId, `已删除: **${job.name}**`, { title: "🗑 已删除", color: "grey" });
			return;
		}

		// /任务 执行 ID
		const runMatch = subCmd.match(/^(执行|run|trigger)\s+(\S+)/i);
		if (runMatch) {
			const idPrefix = runMatch[2];
			const job = (await scheduler.list(true)).find((j) => j.id.startsWith(idPrefix));
			if (!job) { await replyCard(messageId, `未找到 ID 为 \`${idPrefix}\` 的任务`, { title: "未找到", color: "orange" }); return; }
			await replyCard(messageId, `正在手动执行: **${job.name}**...`, { title: "▶ 执行中", color: "wathet" });
			const result = await scheduler.run(job.id);
			await replyCard(messageId, result.status === "ok" ? `执行成功: **${job.name}**` : `执行失败: ${result.error}`, {
				title: result.status === "ok" ? "✅ 完成" : "❌ 失败",
				color: result.status === "ok" ? "green" : "red",
			});
			return;
		}

		await replyCard(messageId, "未知子命令。\n\n用法：\n- `/任务` — 查看所有任务\n- `/任务 暂停 ID` — 暂停任务\n- `/任务 恢复 ID` — 恢复任务\n- `/任务 删除 ID` — 删除任务\n- `/任务 执行 ID` — 手动执行", { title: "用法", color: "orange" });
		return;
	}

	// /心跳 → 心跳系统管理
	const hbMatch = text.match(/^\/(心跳|heartbeat|hb)[\s:：]*(.*)/i);
	if (hbMatch) {
		const subCmd = hbMatch[2].trim().toLowerCase();

		if (!subCmd || subCmd === "status" || subCmd === "状态") {
			const s = heartbeat.getStatus();
			const statusText = [
				`**状态：** ${s.enabled ? "✅ 已启用" : "⏸ 已关闭"}`,
				`**间隔：** 每 ${Math.round(s.everyMs / 60000)} 分钟`,
				s.lastRunAt ? `**上次执行：** ${new Date(s.lastRunAt).toLocaleString("zh-CN")}` : "**上次执行：** 从未",
				s.nextRunAt ? `**下次执行：** ${new Date(s.nextRunAt).toLocaleString("zh-CN")}` : "",
				s.lastStatus ? `**上次状态：** ${s.lastStatus}` : "",
				"",
				"**用法：**",
				"- `/心跳 开启` — 启动心跳检查",
				"- `/心跳 关闭` — 停止心跳检查",
				"- `/心跳 执行` — 立即执行一次",
				"- `/心跳 间隔 分钟数` — 设置间隔",
				"",
				"编辑工作区的 `.cursor/HEARTBEAT.md` 可自定义检查清单。",
			].filter(Boolean).join("\n");
			await replyCard(messageId, statusText, { title: "💓 心跳系统", color: "purple" });
			return;
		}

		if (/^(开启|enable|on|start|启动)$/i.test(subCmd)) {
			heartbeat.updateConfig({ enabled: true });
			await replyCard(messageId, `心跳已开启，每 ${Math.round(heartbeat.getStatus().everyMs / 60000)} 分钟检查一次。\n\n编辑 \`.cursor/HEARTBEAT.md\` 自定义检查清单。`, { title: "💓 已开启", color: "green" });
			return;
		}

		if (/^(关闭|disable|off|stop|停止)$/i.test(subCmd)) {
			heartbeat.updateConfig({ enabled: false });
			await replyCard(messageId, "心跳已关闭。", { title: "💓 已关闭", color: "grey" });
			return;
		}

		if (/^(执行|run|check|检查)$/i.test(subCmd)) {
			await replyCard(messageId, "💓 正在执行心跳检查...", { title: "执行中", color: "wathet" });
			const result = await heartbeat.runOnce();
			if (result.status === "ran") {
				await replyCard(messageId, result.hasContent ? "心跳检查完成，发现需要关注的事项（已发送）" : "心跳检查完成，一切正常 ✅", {
					title: "💓 检查完成",
					color: "green",
				});
			} else {
				await replyCard(messageId, `跳过: ${result.reason}`, { title: "💓 跳过", color: "grey" });
			}
			return;
		}

		const intervalMatch = subCmd.match(/^(间隔|interval)\s+(\d+)/i);
		if (intervalMatch) {
			const mins = Number.parseInt(intervalMatch[2], 10);
			if (mins < 1 || mins > 1440) {
				await replyCard(messageId, "间隔范围: 1-1440 分钟", { title: "无效", color: "orange" });
				return;
			}
			heartbeat.updateConfig({ everyMs: mins * 60_000 });
			await replyCard(messageId, `心跳间隔已设为 **${mins} 分钟**`, { title: "💓 已更新", color: "green" });
			return;
		}

		await replyCard(messageId, "未知子命令。发送 `/心跳` 查看用法。", { title: "用法", color: "orange" });
		return;
	}

	// /new、/新对话、/新会话 → 归档当前会话，开启新对话
	const { workspace, prompt, label } = route(text);
	if (/^\/(new|新对话|新会话)\s*$/i.test(prompt.trim())) {
		archiveAndResetSession(workspace);
		const historyCount = getSessionHistory(workspace).length;
		const hint = historyCount > 0 ? `\n\n历史会话已保留（共 ${historyCount} 个），发送 \`/会话\` 可查看和切换。` : "";
		const msg = `**[${label}]** 新会话已开始，下一条消息将创建全新对话。${hint}`;
		if (cardId) await updateCard(cardId, msg, { title: "新会话", color: "blue" });
		else await replyCard(messageId, msg, { title: "新会话", color: "blue" });
		return;
	}

	// /会话、/sessions → 列出历史会话 / 切换会话
	const sessionCmdMatch = prompt.match(/^\/(会话|sessions?)[\s:：]*(.*)/i);
	if (sessionCmdMatch) {
		const subArg = sessionCmdMatch[2].trim();
		const history = getSessionHistory(workspace, 10);
		const activeId = getActiveSessionId(workspace);

		if (!subArg) {
			if (history.length === 0) {
				await replyCard(messageId, "暂无历史会话。\n\n开始对话后会自动记录，发送 `/新对话` 可归档当前会话。", { title: "💬 会话列表", color: "blue" });
				return;
			}
			const lines: string[] = [];
			lines.push(`**工作区：** \`${label}\`\n`);
			for (let i = 0; i < history.length; i++) {
				const h = history[i];
				const isCurrent = h.id === activeId;
				const icon = isCurrent ? "🔵" : "⚪";
				const tag = isCurrent ? " ← **当前**" : "";
				const time = formatRelativeTime(h.lastActiveAt);
				lines.push(`${icon} **${i + 1}.** ${h.summary}${tag}\n   ${time} · \`${h.id.slice(0, 8)}\``);
			}
			lines.push("", "---", "切换：`/会话 编号`　　新建：`/新对话`");
			await replyCard(messageId, lines.join("\n"), { title: "💬 会话列表", color: "blue" });
			return;
		}

		// /会话 N → 切换到第 N 个
		const num = Number.parseInt(subArg, 10);
		if (!Number.isNaN(num) && num >= 1 && num <= history.length) {
			const target = history[num - 1];
			if (target.id === activeId) {
				await replyCard(messageId, `当前已是会话 #${num}：${target.summary}`, { title: "无需切换", color: "blue" });
				return;
			}
			switchToSession(workspace, target.id);
			await replyCard(messageId, `已切换到会话 #${num}：**${target.summary}**\n\n下一条消息将在此会话中继续对话。\n\`${target.id.slice(0, 12)}\` · ${formatRelativeTime(target.lastActiveAt)}`, { title: "💬 已切换", color: "green" });
			console.log(`[Session] 切换到 ${target.id.slice(0, 12)} (${target.summary})`);
			return;
		}

		// /会话 ID前缀 → 按 ID 前缀匹配
		if (subArg.length >= 4) {
			const target = history.find((h) => h.id.startsWith(subArg));
			if (target) {
				switchToSession(workspace, target.id);
				await replyCard(messageId, `已切换到：**${target.summary}**\n\n\`${target.id.slice(0, 12)}\` · ${formatRelativeTime(target.lastActiveAt)}`, { title: "💬 已切换", color: "green" });
				return;
			}
		}

		await replyCard(messageId, `未找到编号 ${subArg} 的会话。\n\n发送 \`/会话\` 查看可用列表。`, { title: "未找到", color: "orange" });
		return;
	}

	// 未知 / 指令 → 友好提示
	if (text.startsWith("/")) {
		const cmd = text.split(/[\s:：]/)[0];
		await replyCard(messageId, `未知指令 \`${cmd}\`\n\n发送 \`/帮助\` 查看所有可用指令。`, { title: "未知指令", color: "orange" });
		return;
	}

	const model = config.CURSOR_MODEL;

	// 创建或复用卡片：全局排队卡片 → 同会话排队 → 处理中
	const currentLockKey = getLockKey(workspace);
	const needsSessionQueue = !cardId && busySessions.has(currentLockKey);
	if (!cardId) {
		const status = needsSessionQueue
			? `⏳ 排队中（同会话有任务进行中）\n\n> ${prompt.slice(0, 120)}`
			: `⏳ 正在执行...\n\n> ${prompt.slice(0, 120)}`;
		cardId = await replyCard(messageId, status, {
			title: needsSessionQueue ? "排队中" : "处理中",
			color: needsSessionQueue ? "grey" : "wathet",
		});
	} else {
		// 从全局排队卡片复用，看是否还需要等同会话锁
		const status = busySessions.has(currentLockKey)
			? `⏳ 排队中（同会话有任务进行中）\n\n> ${prompt.slice(0, 120)}`
			: `⏳ 正在执行...\n\n> ${prompt.slice(0, 120)}`;
		await updateCard(cardId, status, {
			title: busySessions.has(currentLockKey) ? "排队中" : "处理中",
			color: busySessions.has(currentLockKey) ? "grey" : "wathet",
		});
	}
	console.log(`[Agent] 调用 Cursor CLI workspace=${workspace} model=${model} card=${cardId}`);
	const taskStart = Date.now();

	// 记忆由 Cursor 自主通过 memory-tool.ts 调用，server 不注入
	if (memory) {
		memory.appendSessionLog(workspace, "user", prompt, model);
	}

	// runAgent 获取 session lock 后回调 onStart，更新卡片为"处理中"
	const onStart = cardId
		? () => {
				updateCard(cardId!, `⏳ 正在执行...\n\n> ${prompt.slice(0, 120)}`, {
					title: "处理中",
					color: "wathet",
				}).catch(() => {});
			}
		: undefined;

	const onProgress = cardId
		? (p: AgentProgress) => {
				const time = formatElapsed(p.elapsed);
				const phaseLabel = p.phase === "thinking" ? "🤔 思考中" : p.phase === "tool_call" ? "🔧 执行工具" : "💬 回复中";
				const snippet = p.snippet.split("\n").filter((l) => l.trim()).slice(-4).join("\n");
				updateCard(
					cardId!,
					`\`\`\`\n${snippet.slice(0, 300) || "..."}\n\`\`\``,
					{ title: `${phaseLabel} · ${time}`, color: "wathet" },
				).catch(() => {});
			}
		: undefined;

	try {
		const { result, quotaWarning } = await runAgent(workspace, prompt, { onProgress, onStart });
		const usedModel = quotaWarning ? "auto" : model;
		const elapsed = formatElapsed(Math.round((Date.now() - taskStart) / 1000));
		console.log(`[${new Date().toISOString()}] 完成 [${label}] model=${usedModel} elapsed=${elapsed} (${result.length} chars)`);

		// 记录 assistant 回复到会话日志
		if (memory) {
			memory.appendSessionLog(workspace, "assistant", result.slice(0, 3000), usedModel);
		}

		// Agent 可能修改了 cron-jobs.json，重新加载调度器
		scheduler.reload().catch(() => {});

		const fullResult = quotaWarning ? `${quotaWarning}\n\n---\n\n${result}` : result;
		const doneTitle = quotaWarning ? `完成 · ${elapsed}` : `完成 · ${elapsed}`;
		const doneColor = quotaWarning ? "orange" : "green";

		// 尝试发送 AI 结果到飞书卡片
		let sendOk = false;
		if (cardId && fullResult.length <= CARD_MAX) {
			const { ok, error } = await updateCard(cardId, fullResult, { title: doneTitle, color: doneColor });
			if (ok) {
				sendOk = true;
			} else {
				// 卡片更新失败 → 让大模型知道，自己重新组织回复
				console.log(`[重发] 卡片更新失败: ${error}，通知 AI 重新回复`);
				await updateCard(cardId, `⏳ 回复格式超出飞书限制，正在重新组织...`, { title: "重新组织中", color: "wathet" });

				const retryPrompt = [
					"你的上一条回复发送到飞书时失败了。",
					`失败原因：${error}`,
					"",
					"飞书卡片的限制：",
					"- 单张卡片最多 5 个 Markdown 表格（这是最常见的失败原因）",
					"- 卡片 JSON 总大小不超过 30KB（约 3500 中文字符）",
					"",
					"请重新回复刚才的内容，但要：",
					"1. 表格最多用 3 个，其余改用列表（- 项目符号）",
					"2. 精简文字，控制在 3000 字以内",
					"3. 如果内容确实很多，先给核心结论，末尾说「需要我继续展开吗？」",
					"4. 不要解释为什么格式变了，直接给内容",
				].join("\n");

				try {
					const { result: retryResult } = await runAgent(workspace, retryPrompt, { onProgress });
					const retryElapsed = formatElapsed(Math.round((Date.now() - taskStart) / 1000));
					const { ok: retryOk } = await updateCard(cardId, retryResult, { title: `完成 · ${retryElapsed}`, color: doneColor });
					if (retryOk) {
						sendOk = true;
						console.log(`[重发] AI 重新回复成功 (${retryResult.length} chars)`);
					} else {
						console.warn("[重发] AI 重新回复后仍然超限，回退纯文本分片");
					}
				} catch (retryErr) {
					console.error("[重发] AI 重试失败:", retryErr);
				}
			}
		}

		// 卡片发送失败或内容过长 → 回退分片发送
		if (!sendOk) {
			if (cardId) {
				await updateCard(cardId, quotaWarning || "执行完成，结果见下方", { title: doneTitle, color: doneColor });
			}
			await replyLongMessage(messageId, chatId, result, { title: doneTitle, color: "green" });
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[${new Date().toISOString()}] 失败 [${label}]: ${msg}`);
		if (err instanceof Error && err.stack) console.error(`[Stack] ${err.stack}`);

		const isAuthError = /authentication required|not authenticated|unauthorized|api.key/i.test(msg);
		const body = isAuthError
			? `**API Key 失效，请更换：**\n\n1. 打开 [Cursor Dashboard](https://cursor.com/dashboard) → Integrations → User API Keys\n2. 点 **Create API Key** 生成新 Key\n3. 在飞书发送：\`/apikey 你的新Key\`\n\n\`\`\`\n${msg.slice(0, 500)}\n\`\`\``
			: `**执行失败**\n\n\`\`\`\n${msg.slice(0, 2000)}\n\`\`\``;
		const title = isAuthError ? "API Key 失效" : "执行失败";

		if (cardId) {
			await updateCard(cardId, body, { title, color: "red" });
		} else {
			await replyCard(messageId, body, { title, color: "red" });
		}
	}
}

// ── 飞书长连接 ───────────────────────────────────
const dispatcher = new Lark.EventDispatcher({});
const TYPES = new Set(["text", "image", "audio", "file", "post"]);

dispatcher.register({
	"im.message.receive_v1": async (data) => {
		console.log("[事件] 收到 im.message.receive_v1");
		try {
			const ev = data as Record<string, unknown>;
			const msg = ev.message as Record<string, unknown>;
			if (!msg) {
				console.error("[事件] msg 为空");
				return;
			}
			const messageType = msg.message_type as string;
			const messageId = msg.message_id as string;
			const chatId = msg.chat_id as string;
			const chatType = (msg.chat_type as string) || "p2p";
			const content = msg.content as string;

			if (isDup(messageId)) return;
			if (!TYPES.has(messageType)) {
				await replyCard(messageId, `暂不支持: ${messageType}`);
				return;
			}

			const { text: parsedText, imageKey, fileKey } = parseContent(messageType, content);
			console.log(`[解析] type=${messageType} chat=${chatType} text="${parsedText.slice(0, 60)}" img=${imageKey ?? ""} file=${fileKey ?? ""}`);
			handle({ text: parsedText.trim(), messageId, chatId, chatType, messageType, content }).catch(console.error);
		} catch (e) {
			console.error("[事件异常]", e);
		}
	},
});

const ws = new Lark.WSClient({
	appId: config.FEISHU_APP_ID,
	appSecret: config.FEISHU_APP_SECRET,
	domain: Lark.Domain.Feishu,
	loggerLevel: Lark.LoggerLevel.info,
});

// ── 启动 ─────────────────────────────────────────
const list = Object.entries(projectsConfig.projects)
	.map(([k, v]) => `  ${k} → ${v.path}`)
	.join("\n");
const sttEngine = config.VOLC_STT_APP_ID ? "火山引擎豆包大模型" : "本地 whisper";
const memEngine = memory ? `豆包 Embedding (${config.VOLC_EMBEDDING_MODEL})` : "未启用";
console.log(`
┌──────────────────────────────────────────────────┐
│  飞书 → Cursor Agent 中继服务 v5                 │
│  架构: OpenClaw 风格 (rules 自动加载)            │
├──────────────────────────────────────────────────┤
│  模型: ${config.CURSOR_MODEL}
│  Key:  ...${config.CURSOR_API_KEY.slice(-8)}
│  连接: 飞书 WebSocket 长连接
│  收件: ${INBOX_DIR}
│  语音: ${sttEngine}
│  记忆: ${memEngine}
│  调度: cron-jobs.json (文件监听)
│  心跳: 默认关闭（飞书 /心跳 开启）
│  自检: .cursor/BOOT.md（每次启动执行）
│
│  规则（每次会话自动加载）:
│    soul.mdc, agent-identity.mdc, user-context.mdc
│    workspace-rules.mdc, tools.mdc, memory-protocol.mdc
│    scheduler-protocol.mdc, heartbeat-protocol.mdc
│    cursor-capabilities.mdc
│  记忆索引: 全工作区文本文件（memory-tool.ts）
│
│  回复: 互动卡片 + 消息更新
│  直连: 飞书消息 → Cursor CLI（stream-json + --resume）
│
│  项目路由:
${list}
│
│  热更换: 编辑 .env 即可
└──────────────────────────────────────────────────┘
`);

// 启动定时任务调度器
scheduler.start().catch((e) => console.warn(`[调度] 启动失败: ${e}`));

heartbeat.start();

ws.start({ eventDispatcher: dispatcher });
console.log("飞书长连接已启动，等待消息...");

// ── 启动自检（.cursor/BOOT.md）───────────────────────
setTimeout(async () => {
	const bootPath = resolve(defaultWorkspace, ".cursor/BOOT.md");
	try {
		if (!existsSync(bootPath)) return;
		const content = readFileSync(bootPath, "utf-8").trim();
		if (!content) return;
		console.log("[启动] 检测到 .cursor/BOOT.md，执行启动自检...");
		const bootPrompt = [
			"你正在执行启动自检。严格按 .cursor/BOOT.md 指示操作。",
			"如果无事可做，不需要回复任何内容。",
		].join("\n");
		const { result } = await runAgent(defaultWorkspace, bootPrompt);
		const trimmed = result.trim();
		if (trimmed && !/^(无输出|HEARTBEAT_OK)$/i.test(trimmed) && lastActiveChatId) {
			await sendCard(lastActiveChatId, trimmed, { title: "🚀 启动自检", color: "wathet" });
		}
		console.log("[启动] .cursor/BOOT.md 自检完成");
	} catch (e) {
		console.warn(`[启动] .cursor/BOOT.md 执行失败: ${e}`);
	}
}, 8000);
