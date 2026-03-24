#!/usr/bin/env bun

/**
 * 微信服务启动脚本
 * 
 * 用途：
 * - 直接运行服务：bun run start.ts
 * - 测试环境启动：bun run dev（带防休眠）
 */

import { spawn } from 'bun';
import { resolve } from 'path';

const serverPath = resolve(import.meta.dirname, 'server.ts');

console.log('[启动] 微信 → Cursor Agent 中继服务');
console.log('[路径]', serverPath);

const proc = spawn(['bun', 'run', serverPath], {
  stdio: ['inherit', 'inherit', 'inherit'],
  env: {
    ...process.env,
    FORCE_COLOR: '1',
  },
});

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n[退出] 收到 SIGINT，正在停止服务...');
  proc.kill();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[退出] 收到 SIGTERM，正在停止服务...');
  proc.kill();
  process.exit(0);
});

await proc.exited;
