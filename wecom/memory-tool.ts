#!/usr/bin/env bun
/**
 * 企业微信记忆工具 CLI（包装脚本）
 * 
 * 此文件是 shared/memory-tool.ts 的包装，保持向后兼容
 * 实际功能已统一到 shared/memory-tool.ts
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const SHARED_TOOL = resolve(import.meta.dirname, "../shared/memory-tool.ts");

// 设置平台环境变量
process.env.CURSOR_PLATFORM = "wecom";

// 转发所有参数到统一版本
const result = spawnSync("bun", ["run", SHARED_TOOL, ...process.argv.slice(2)], {
	stdio: "inherit",
	env: process.env,
});

process.exit(result.status || 0);
