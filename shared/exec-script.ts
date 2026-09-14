/**
 * 本地脚本执行器 — 用于 exec-script 类型的定时任务
 *
 * 在子进程中执行命令，收集 stdout/stderr，
 * 返回标准化结果供 Scheduler 推送到 IM。
 */

import { spawn } from "node:child_process";

export interface ExecScriptPayload {
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	timeoutMs?: number;
}

const MAX_OUTPUT = 64 * 1024;

export async function executeScript(
	task: ExecScriptPayload,
): Promise<{ status: "ok" | "error"; result?: string; error?: string }> {
	if (!task.command) {
		return { status: "error", error: "command is required" };
	}
	const timeout = task.timeoutMs ?? 30_000;

	return new Promise((resolve) => {
		const proc = spawn(task.command, task.args ?? [], {
			cwd: task.cwd,
			env: { ...process.env, ...task.env },
			timeout,
		});

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (d) => {
			if (stdout.length < MAX_OUTPUT) stdout += d.toString();
		});
		proc.stderr.on("data", (d) => {
			if (stderr.length < MAX_OUTPUT) stderr += d.toString();
		});

		proc.on("close", (code, signal) => {
			if (signal === "SIGTERM") {
				resolve({ status: "error", error: `脚本超时 (${timeout}ms)` });
				return;
			}
			const output = stdout.trim();
			if (code === 0) {
				resolve({ status: "ok", result: output || undefined });
			} else {
				const errMsg = stderr.trim() || output || `exit code ${code}`;
				resolve({ status: "error", result: output || undefined, error: errMsg });
			}
		});

		proc.on("error", (err) => {
			resolve({ status: "error", error: `spawn failed: ${err.message}` });
		});
	});
}
