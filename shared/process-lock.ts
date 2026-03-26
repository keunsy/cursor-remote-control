/**
 * 进程锁管理器
 * 防止同一服务的多个实例同时运行
 * 
 * 用法：
 *   const lock = new ProcessLock("feishu");
 *   if (!lock.acquire()) {
 *     console.error("服务已在运行");
 *     process.exit(1);
 *   }
 *   // 进程退出时自动释放锁
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

export class ProcessLock {
	private readonly pidFile: string;
	private readonly serviceName: string;
	private acquired = false;

	constructor(serviceName: string) {
		this.serviceName = serviceName;
		// PID 文件统一放在 /tmp 目录
		this.pidFile = `/tmp/cursor-${serviceName}.pid`;
	}

	/**
	 * 尝试获取进程锁
	 * @returns 成功返回 true，已有实例运行返回 false
	 */
	acquire(): boolean {
		// 检查 PID 文件是否存在
		if (existsSync(this.pidFile)) {
			try {
				const oldPid = parseInt(readFileSync(this.pidFile, "utf-8").trim(), 10);
				
				// 验证进程是否真的在运行
				if (this.isProcessRunning(oldPid)) {
					console.log(`[进程锁] ${this.serviceName} 服务已在运行 (PID: ${oldPid})`);
					console.log(`[进程锁] PID 文件: ${this.pidFile}`);
					console.log(`[进程锁] 如需强制启动，请先执行: kill ${oldPid}`);
					return false;
				}
				
				// 进程已不存在，清理过期的 PID 文件
				console.log(`[进程锁] 清理过期的 PID 文件 (旧 PID: ${oldPid})`);
				unlinkSync(this.pidFile);
			} catch (err) {
				console.warn(`[进程锁] 清理过期 PID 文件失败:`, err);
			}
		}

		// 写入当前进程 PID
		try {
			writeFileSync(this.pidFile, process.pid.toString(), "utf-8");
			this.acquired = true;
			console.log(`[进程锁] 已获取进程锁 (PID: ${process.pid}, 文件: ${this.pidFile})`);
			
			// 注册退出时清理
			this.registerCleanup();
			return true;
		} catch (err) {
			console.error(`[进程锁] 写入 PID 文件失败:`, err);
			return false;
		}
	}

	/**
	 * 释放进程锁（通常不需要手动调用，进程退出时自动清理）
	 */
	release(): void {
		if (!this.acquired) return;
		
		try {
			if (existsSync(this.pidFile)) {
				unlinkSync(this.pidFile);
				console.log(`[进程锁] 已释放进程锁`);
			}
			this.acquired = false;
		} catch (err) {
			console.error(`[进程锁] 释放锁失败:`, err);
		}
	}

	/**
	 * 检查指定 PID 的进程是否在运行
	 */
	private isProcessRunning(pid: number): boolean {
		try {
			// 使用 kill 信号 0 检查进程是否存在（不会真的杀死进程）
			process.kill(pid, 0);
			return true;
		} catch (err) {
			// ESRCH: 进程不存在
			return false;
		}
	}

	/**
	 * 注册进程退出时的清理函数
	 */
	private registerCleanup(): void {
		const cleanup = () => this.release();
		
		// 正常退出
		process.on("exit", cleanup);
		
		// Ctrl+C
		process.on("SIGINT", () => {
			console.log(`\n[进程锁] 收到 SIGINT，清理并退出...`);
			this.release();
			process.exit(0);
		});
		
		// kill 命令
		process.on("SIGTERM", () => {
			console.log(`\n[进程锁] 收到 SIGTERM，清理并退出...`);
			this.release();
			process.exit(0);
		});
		
		// 未捕获异常
		process.on("uncaughtException", (err) => {
			console.error(`[进程锁] 未捕获异常，清理锁后退出:`, err);
			this.release();
			process.exit(1);
		});
	}
}
