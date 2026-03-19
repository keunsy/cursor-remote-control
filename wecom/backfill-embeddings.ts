#!/usr/bin/env bun
/**
 * 企业微信向量嵌入回填工具（包装脚本）
 * 
 * 此文件是 shared/backfill-embeddings.ts 的包装，保持向后兼容
 * 实际功能已统一到 shared/backfill-embeddings.ts
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const SHARED_TOOL = resolve(import.meta.dirname, "../shared/backfill-embeddings.ts");

// 转发所有参数到统一版本，设置平台环境变量
const result = spawnSync("bun", ["run", SHARED_TOOL, ...process.argv.slice(2)], {
	stdio: "inherit",
	env: { ...process.env, CURSOR_PLATFORM: "wecom" },
	cwd: import.meta.dirname,
});

process.exit(result.status || 0);
