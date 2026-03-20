/**
 * 统一重连管理器
 * 
 * 三平台（飞书/钉钉/企微）共用的断线重连逻辑
 * 提供：指数退避、重试次数限制、连接状态监控、告警通知
 */

interface ReconnectOptions {
	maxRetries?: number;          // 最大重试次数，默认 10
	backoffDelays?: number[];     // 退避延迟（秒），默认 [1, 2, 5, 10, 30, 60]
	onSuccess?: () => void;       // 连接成功回调
	onFailure?: (error: Error) => void; // 连接失败回调（超过最大重试次数）
	onRetry?: (attempt: number, delay: number, error: Error) => void; // 每次重试前回调
}

export class ReconnectManager {
	private retryCount = 0;
	private maxRetries: number;
	private backoff: number[];
	private isConnected = false;
	private reconnecting = false;
	private lastError: Error | null = null;
	private connectTime: number | null = null;
	private disconnectTime: number | null = null;
	
	constructor(opts?: { maxRetries?: number; backoffDelays?: number[] }) {
		this.maxRetries = opts?.maxRetries || 10;
		this.backoff = opts?.backoffDelays || [1, 2, 5, 10, 30, 60];
	}
	
	/**
	 * 带重试的连接函数
	 * @param connectFn 连接函数（返回 Promise）
	 * @param opts 可选配置
	 */
	async connectWithRetry(
		connectFn: () => Promise<void>,
		opts?: ReconnectOptions
	): Promise<void> {
		this.reconnecting = true;
		
		while (this.retryCount < this.maxRetries) {
			try {
				console.log(`[重连] 尝试连接... (${this.retryCount + 1}/${this.maxRetries})`);
				
				await connectFn();
				
				// 连接成功
				this.isConnected = true;
				this.reconnecting = false;
				this.retryCount = 0; // 重置计数
				this.connectTime = Date.now();
				this.lastError = null;
				
				if (opts?.onSuccess) {
					opts.onSuccess();
				}
				
				const uptime = this.disconnectTime 
					? Math.round((Date.now() - this.disconnectTime) / 1000)
					: 0;
				console.log(`[重连] ✅ 连接成功${uptime > 0 ? ` (断线 ${uptime}秒后恢复)` : ''}`);
				return;
			} catch (err) {
				this.isConnected = false;
				this.lastError = err instanceof Error ? err : new Error(String(err));
				
				const idx = Math.min(this.retryCount, Math.max(0, this.backoff.length - 1));
				const delay = this.backoff[idx] ?? 30;
				
				console.warn(`[重连] 第 ${this.retryCount + 1}/${this.maxRetries} 次失败, ${delay}秒后重试`);
				console.error('[重连] 错误详情:', this.lastError.message);
				
				if (opts?.onRetry) {
					opts.onRetry(this.retryCount + 1, delay, this.lastError);
				}
				
				// 等待后重试
				await sleep(delay * 1000);
				this.retryCount++;
			}
		}
		
		// 超过最大重试次数
		this.reconnecting = false;
		this.disconnectTime = Date.now();
		const error = new Error(`连接失败，已重试 ${this.maxRetries} 次。最后错误: ${this.lastError?.message || '未知'}`);
		
		if (opts?.onFailure) {
			opts.onFailure(error);
		}
		
		await this.sendAlert(`服务连接失败（已重试 ${this.maxRetries} 次），请检查网络和凭据`);
		
		throw error;
	}
	
	/**
	 * 监控连接状态，断线时自动重连
	 * @param checkFn 检查连接是否存活的函数（返回 true = 连接正常）
	 * @param connectFn 连接函数
	 * @param opts 可选配置
	 */
	startMonitoring(
		checkFn: () => boolean | Promise<boolean>,
		connectFn: () => Promise<void>,
		opts?: ReconnectOptions & { checkInterval?: number }
	) {
		const interval = opts?.checkInterval || 30000; // 默认 30 秒检查一次
		
		const monitor = setInterval(async () => {
			try {
				const isAlive = await checkFn();
				
				if (!isAlive && !this.reconnecting) {
					console.warn('[监控] 检测到连接断开，开始重连...');
					this.disconnectTime = Date.now();
					this.isConnected = false;
					
					// 异步重连，不阻塞监控循环
					this.connectWithRetry(connectFn, opts).catch((err) => {
						console.error('[监控] 重连失败:', err.message);
					});
				}
			} catch (err) {
				console.error('[监控] 检查失败:', err);
			}
		}, interval);
		
		console.log(`[监控] 已启动连接监控 (间隔: ${interval/1000}秒)`);
		
		// 返回停止函数
		return () => {
			clearInterval(monitor);
			console.log('[监控] 已停止连接监控');
		};
	}
	
	/**
	 * 手动标记断线（触发重连）
	 */
	markDisconnected() {
		if (this.isConnected) {
			this.isConnected = false;
			this.disconnectTime = Date.now();
			console.warn('[重连] 连接已断开');
		}
	}
	
	/**
	 * 手动标记连接成功
	 */
	markConnected() {
		this.isConnected = true;
		this.connectTime = Date.now();
		this.retryCount = 0;
		this.lastError = null;
		console.log('[重连] 连接已建立');
	}
	
	/**
	 * 发送告警通知
	 */
	private async sendAlert(message: string) {
		console.error(`[告警] ${message}`);
		
		// TODO: 可以集成系统通知
		// - macOS: osascript -e 'display notification "..." with title "服务告警"'
		// - Linux: notify-send
		// - 邮件/短信/钉钉群通知
		
		try {
			// macOS 系统通知
			if (process.platform === 'darwin') {
				const { execSync } = await import('node:child_process');
				execSync(`osascript -e 'display notification "${message}" with title "Cursor Remote Control 告警"'`, {
					stdio: 'ignore',
				});
			}
		} catch (err) {
			// 忽略通知失败
		}
	}
	
	/**
	 * 获取连接状态
	 */
	getStatus() {
		return {
			isConnected: this.isConnected,
			reconnecting: this.reconnecting,
			retryCount: this.retryCount,
			maxRetries: this.maxRetries,
			lastError: this.lastError?.message || null,
			uptime: this.connectTime ? Math.round((Date.now() - this.connectTime) / 1000) : null,
			downtime: this.disconnectTime && !this.isConnected
				? Math.round((Date.now() - this.disconnectTime) / 1000)
				: null,
		};
	}
	
	/**
	 * 重置重试计数（手动恢复）
	 */
	reset() {
		this.retryCount = 0;
		this.lastError = null;
		console.log('[重连] 重试计数已重置');
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
