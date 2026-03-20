/**
 * 企业微信服务启动脚本（带防休眠）
 * 使用 caffeinate 防止系统因锁屏进入低功耗状态
 * 
 * caffeinate 参数说明：
 * -d: 防止显示器休眠（允许显示器关闭，但系统保持唤醒）
 * -i: 防止系统空闲休眠
 * -s: 防止系统休眠（即使盖上笔记本盖子）
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const startTs = resolve(import.meta.dirname, 'start.ts');
const bunBin = process.env.BUN_BIN || 'bun';

console.log('[KeepAwake] 启动防休眠保护...');
console.log('  使用 caffeinate -i 防止系统空闲休眠（允许显示器关闭）');

// 使用 caffeinate 包裹主进程
// -i: 防止系统空闲休眠（保持进程活跃）
// 不使用 -d: 允许显示器关闭省电
const child = spawn('caffeinate', ['-i', bunBin, 'run', startTs], {
	cwd: import.meta.dirname,
	stdio: 'inherit',
	env: process.env,
});

child.on('error', (err) => {
	console.error('[KeepAwake] caffeinate 启动失败:', err);
	console.log('[KeepAwake] 降级使用普通模式启动');
	spawn(bunBin, ['run', startTs], {
		cwd: import.meta.dirname,
		stdio: 'inherit',
		env: process.env,
	});
});

child.on('exit', (code) => {
	console.log(`[KeepAwake] 进程退出，代码: ${code}`);
	process.exit(code || 0);
});

// 优雅退出
process.on('SIGTERM', () => {
	console.log('[KeepAwake] 收到 SIGTERM，停止服务...');
	child.kill('SIGTERM');
});

process.on('SIGINT', () => {
	console.log('[KeepAwake] 收到 SIGINT，停止服务...');
	child.kill('SIGINT');
});
