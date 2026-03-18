/**
 * 启动入口 - launchd 通过此脚本启动服务
 * 确保依赖完整后再加载 server.ts
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

const dir = import.meta.dirname;
const marker = resolve(dir, "node_modules/@larksuiteoapi/node-sdk/package.json");

if (!existsSync(marker)) {
  console.log("[start] node_modules 不完整，执行 bun install...");
  try {
    execSync("bun install", { cwd: dir, stdio: "inherit", timeout: 120_000 });
    console.log("[start] 依赖安装完成");
  } catch (e) {
    console.error("[start] bun install 失败:", e);
    process.exit(1);
  }
}

await import("./server.ts");
