/**
 * OpenAI 兼容 API 桥接服务
 *
 * OpenClaw → 本服务 (OpenAI Chat Completions 格式) → Cursor Agent CLI
 *
 * OpenClaw 将本服务视为一个"模型 provider"，
 * 收到请求后提取消息内容，通过 expect/PTY 调用 Cursor Agent CLI，
 * 将结果以 OpenAI 格式返回。
 *
 * 启动: bun run bridge.ts
 */

import { spawn } from "node:child_process";
import { readFileSync, watchFile } from "node:fs";
import { resolve } from "node:path";

const HOME = process.env.HOME;
if (!HOME) throw new Error("$HOME is not set");

const ENV_PATH = resolve(import.meta.dirname, ".env");
const AGENT_BIN = process.env.AGENT_BIN || resolve(HOME, ".local/bin/agent");

// ── .env 热更换 ──────────────────────────────────
interface EnvConfig {
	CURSOR_API_KEY: string;
	CURSOR_MODEL: string;
}

function parseEnv(): EnvConfig {
	const raw = readFileSync(ENV_PATH, "utf-8");
	const env: Record<string, string> = {};
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIdx = trimmed.indexOf("=");
		if (eqIdx < 0) continue;
		let val = trimmed.slice(eqIdx + 1).trim();
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1);
		}
		env[trimmed.slice(0, eqIdx).trim()] = val;
	}
	return {
		CURSOR_API_KEY: env.CURSOR_API_KEY || "",
		CURSOR_MODEL: env.CURSOR_MODEL || "opus-4.6-thinking",
	};
}

let config = parseEnv();

watchFile(ENV_PATH, { interval: 2000 }, () => {
	try {
		config = parseEnv();
		console.log(`[热更换] 已重新加载 (model=${config.CURSOR_MODEL})`);
	} catch (e) {
		console.error("[热更换] 读取失败:", e);
	}
});

// ── 进程保护 ──────────────────────────────────────
process.on("uncaughtException", (err) => {
	console.error(`[致命] ${err.message}\n${err.stack}`);
});
process.on("unhandledRejection", (reason) => {
	console.error("[致命] unhandledRejection:", reason);
});

// ── ANSI 清理 ────────────────────────────────────
function stripAnsi(str: string): string {
	return str
		.replace(/\x1b\][^\x07]*\x07/g, "")
		.replace(/\x1b\][^\x1b]*\x1b\\/g, "")
		.replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, "")
		.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
		.replace(/\x1b[=>MNOZ78]/g, "")
		.replace(/\r/g, "")
		.trim();
}

// ── 消息提取 ─────────────────────────────────────
interface ChatMessage {
	role: string;
	content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
}

function extractPrompt(messages: ChatMessage[]): string {
	const parts: string[] = [];

	for (const msg of messages) {
		if (typeof msg.content === "string") {
			if (msg.role === "system" || msg.role === "developer") {
				parts.push(`[系统指令] ${msg.content}`);
			} else {
				parts.push(msg.content);
			}
		} else if (Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (part.type === "text" && part.text) {
					parts.push(part.text);
				}
			}
		}
	}

	return parts.join("\n\n");
}

// ── Cursor Agent CLI 调用（直接 spawn，不依赖 expect）──
const MAX_CONCURRENT = 2;
const MAX_EXEC_TIMEOUT = 30 * 60 * 1000;
const IDLE_TIMEOUT = 60 * 1000;

function runAgent(prompt: string): Promise<string> {
	const workspace = resolve(import.meta.dirname, "..");

	return new Promise((res, reject) => {
		const child = spawn(AGENT_BIN, [
			"-p", "--force", "--trust", "--approve-mcps",
			"--workspace", workspace,
			"--model", config.CURSOR_MODEL,
			"--output-format", "text",
			"--", prompt,
		], {
			env: { ...process.env, CURSOR_API_KEY: config.CURSOR_API_KEY },
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let done = false;
		const startTime = Date.now();
		let lastOutputTime = Date.now();

		function cleanup() { done = true; clearInterval(timer); }

		const timer = setInterval(() => {
			if (done) return;
			const now = Date.now();
			if (now - startTime > MAX_EXEC_TIMEOUT) {
				cleanup(); child.kill("SIGTERM");
				reject(new Error("[TIMEOUT] 执行超过 30 分钟"));
				return;
			}
			if (now - lastOutputTime > IDLE_TIMEOUT) {
				cleanup(); child.kill("SIGTERM");
				reject(new Error("[IDLE] 超过 1 分钟无输出"));
				return;
			}
		}, 5000);

		child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); lastOutputTime = Date.now(); });
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); lastOutputTime = Date.now(); });

		child.on("close", (code) => {
			if (done) return;
			cleanup();
			const output = stripAnsi(stdout) || "(无输出)";
			if (code !== 0 && code !== null) {
				reject(new Error(stripAnsi(stderr) || output || `Exit code: ${code}`));
				return;
			}
			res(output);
		});

		child.on("error", (err) => { if (!done) { cleanup(); reject(err); } });
	});
}

// ── HTTP 服务 ────────────────────────────────────
const PORT = 9801;
let activeRequests = 0;

async function handleRequest(req: Request): Promise<Response> {
	const url = new URL(req.url);

	// 健康检查
	if (url.pathname === "/health" || (req.method === "GET" && url.pathname === "/")) {
		return Response.json({
			ok: true,
			active: activeRequests,
			model: config.CURSOR_MODEL,
		});
	}

	// OpenAI: 列出模型
	if (url.pathname === "/v1/models" || url.pathname === "/models") {
		return Response.json({
			object: "list",
			data: [
				{
					id: "cursor-agent",
					object: "model",
					owned_by: "cursor",
				},
			],
		});
	}

	// OpenAI: Chat Completions
	if (
		req.method === "POST" &&
		(url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")
	) {
		const body = (await req.json()) as {
			messages?: ChatMessage[];
			stream?: boolean;
		};

		if (activeRequests >= MAX_CONCURRENT) {
			return Response.json(
				{ error: { message: "Too many concurrent requests", type: "rate_limit_error" } },
				{ status: 429 },
			);
		}

		const messages = body.messages || [];
		const prompt = extractPrompt(messages);

		if (!prompt.trim()) {
			return Response.json(
				{ error: { message: "Empty prompt", type: "invalid_request_error" } },
				{ status: 400 },
			);
		}

		const ts = new Date().toISOString();
		console.log(`[${ts}] 请求: ${prompt.slice(0, 120)}...`);
		activeRequests++;

		try {
			const result = await runAgent(prompt);
			console.log(`[${new Date().toISOString()}] 完成 (${result.length} chars)`);

			// 非流式：返回标准 OpenAI 响应
			return Response.json({
				id: `chatcmpl-${Date.now()}`,
				object: "chat.completion",
				created: Math.floor(Date.now() / 1000),
				model: "cursor-agent",
				choices: [
					{
						index: 0,
						message: {
							role: "assistant",
							content: result,
						},
						finish_reason: "stop",
					},
				],
				usage: {
					prompt_tokens: prompt.length,
					completion_tokens: result.length,
					total_tokens: prompt.length + result.length,
				},
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[${new Date().toISOString()}] 失败: ${msg.slice(0, 200)}`);
			return Response.json(
				{ error: { message: msg, type: "server_error" } },
				{ status: 500 },
			);
		} finally {
			activeRequests--;
		}
	}

	return Response.json(
		{ error: { message: "Not found", type: "invalid_request_error" } },
		{ status: 404 },
	);
}

// ── 启动 ─────────────────────────────────────────
console.log(`
┌─────────────────────────────────────────────────┐
│  Cursor Agent CLI → OpenAI API 桥接服务         │
├─────────────────────────────────────────────────┤
│  端口: ${PORT}
│  模型: ${config.CURSOR_MODEL}
│  Key:  ...${config.CURSOR_API_KEY.slice(-8)}
│
│  OpenClaw provider 配置:
│    baseUrl: http://localhost:${PORT}/v1
│    apiKey:  local
│    model:   cursor-agent
│
│  热更换: 编辑 .env 即可更换 Cursor API Key
└─────────────────────────────────────────────────┘
`);

Bun.serve({
	port: PORT,
	fetch: handleRequest,
});

console.log(`API 桥接服务已启动: http://localhost:${PORT}`);
