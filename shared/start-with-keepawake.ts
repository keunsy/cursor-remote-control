/**
 * 通用启动入口（带防休眠保护）
 * 使用 caffeinate 防止系统因锁屏进入低功耗状态
 * 
 * 使用方式：
 * 1. 在服务目录下创建符号链接：ln -s ../shared/start-with-keepawake.ts .
 * 2. launchd 配置指向该符号链接
 * 
 * caffeinate 参数说明：
 * -d: 防止显示器休眠（允许显示器关闭，但系统保持唤醒）
 * -i: 防止系统空闲休眠
 * -s: 防止系统休眠（即使盖上笔记本盖子）
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";

// 从环境变量或工作目录获取服务名称
const serviceName = process.env.SERVICE_NAME || process.cwd().split("/").pop() || "unknown";

// 从当前工作目录查找 start.ts（支持 launchd WorkingDirectory 设置）
const startTs = resolve(process.cwd(), "start.ts");
const bunBin = process.env.BUN_BIN || "bun";

console.log(`[KeepAwake:${serviceName}] 启动防休眠保护...`);
console.log("  使用 caffeinate -i 防止系统空闲休眠（允许显示器关闭）");
console.log(`  启动脚本: ${startTs}`);

// 使用 caffeinate 包裹主进程
// -i: 防止系统空闲休眠（保持进程活跃）
// 不使用 -d: 允许显示器关闭省电
const child = spawn("caffeinate", ["-i", bunBin, "run", startTs], {
  cwd: process.cwd(),
  stdio: "inherit",
  env: process.env,
});

child.on("error", (err) => {
  console.error(`[KeepAwake:${serviceName}] caffeinate 启动失败:`, err);
  console.log(`[KeepAwake:${serviceName}] 降级使用普通模式启动`);
  spawn(bunBin, ["run", startTs], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  });
});

child.on("exit", (code) => {
  console.log(`[KeepAwake:${serviceName}] 进程退出，代码: ${code}`);
  process.exit(code || 0);
});

// 优雅退出
process.on("SIGTERM", () => {
  console.log(`[KeepAwake:${serviceName}] 收到 SIGTERM，停止服务...`);
  child.kill("SIGTERM");
});

process.on("SIGINT", () => {
  console.log(`[KeepAwake:${serviceName}] 收到 SIGINT，停止服务...`);
  child.kill("SIGINT");
});
