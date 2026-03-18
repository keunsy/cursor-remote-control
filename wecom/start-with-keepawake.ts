/**
 * 企业微信服务启动脚本（带防休眠）
 */
import { spawn } from 'node:child_process';

// 使用 caffeinate 防止系统休眠
const caffeinate = spawn('caffeinate', ['-d', '-i', 'bun', 'run', 'start.ts'], {
	stdio: 'inherit',
	cwd: import.meta.dirname,
});

caffeinate.on('error', (err) => {
	console.error('[caffeinate 失败]', err);
	console.log('[降级] 使用普通模式启动');
	spawn('bun', ['run', 'start.ts'], {
		stdio: 'inherit',
		cwd: import.meta.dirname,
	});
});

process.on('SIGINT', () => {
	caffeinate.kill('SIGTERM');
	process.exit(0);
});
