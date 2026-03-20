/**
 * 发送本地文件到飞书
 * 使用方式：bun run send-file.ts /path/to/file.apk
 */
import { resolve } from "node:path";
import { readFileSync, existsSync, statSync } from "node:fs";
import { sendMediaFeishu } from "./feishu/media.js";

// 读取环境变量
function parseEnv() {
  const envPath = resolve(import.meta.dirname, ".env");
  if (!existsSync(envPath)) {
    throw new Error(`.env 文件不存在: ${envPath}`);
  }
  const raw = readFileSync(envPath, "utf-8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[trimmed.slice(0, eqIdx).trim()] = val;
  }
  return env;
}

async function main() {
  const args = process.argv.slice(2);
  
  const firstArg = args[0];
  if (args.length < 1 || firstArg === undefined) {
    console.error(`
使用方式：
  bun run send-file.ts <文件路径> [接收人ID]
  
示例：
  bun run send-file.ts ~/app.apk
  bun run send-file.ts /path/to/file.pdf
  bun run send-file.ts ~/document.docx ou_xxx123456
  
说明：
  - 如果不指定接收人ID，需要手动在代码中设置
  - 文件大小限制：30MB
  - 支持：APK, PDF, DOC, XLS, PPT, 图片, 音视频等
    `);
    process.exit(1);
  }
  
  const filePath = resolve(firstArg);
  const receiverId = args[1]; // 可选：接收人的 open_id 或 chat_id
  
  // 检查文件是否存在
  if (!existsSync(filePath)) {
    console.error(`❌ 文件不存在: ${filePath}`);
    process.exit(1);
  }
  
  const stats = statSync(filePath);
  const fileSize = stats.size;
  const maxSize = 30 * 1024 * 1024; // 30MB
  
  if (fileSize > maxSize) {
    console.error(`❌ 文件太大: ${(fileSize / 1024 / 1024).toFixed(2)}MB > 30MB`);
    process.exit(1);
  }
  
  console.log(`📁 准备发送文件: ${filePath}`);
  console.log(`📊 文件大小: ${(fileSize / 1024 / 1024).toFixed(2)}MB`);
  
  // 读取环境变量
  const env = parseEnv();
  const cfg = {
    channels: {
      feishu: {
        appId: env.FEISHU_APP_ID,
        appSecret: env.FEISHU_APP_SECRET,
      }
    }
  };
  
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) {
    console.error("❌ 请先配置 .env 中的 FEISHU_APP_ID 和 FEISHU_APP_SECRET");
    process.exit(1);
  }
  
  // 如果没有提供接收人ID，使用默认值（需要替换成实际的）
  const to = receiverId || "YOUR_CHAT_ID_HERE"; // ⚠️ 需要替换成实际的接收人ID
  
  if (to === "YOUR_CHAT_ID_HERE") {
    console.error(`
❌ 请指定接收人ID！

方式一：命令行参数
  bun run send-file.ts ${filePath} <接收人ID>

方式二：编辑此文件第75行，替换 YOUR_CHAT_ID_HERE 为实际的接收人ID

如何获取接收人ID？
  在飞书中发送消息给机器人，查看日志中的 chat_id 或 open_id
    `);
    process.exit(1);
  }
  
  try {
    console.log(`🚀 正在上传文件...`);
    
    const buffer = readFileSync(filePath);
    const fileName = filePath.split("/").pop() || "file";
    
    await sendMediaFeishu({
      cfg,
      to,
      mediaBuffer: buffer,
      fileName,
    });
    
    console.log(`✅ 文件发送成功！`);
    console.log(`📱 请在飞书中查收文件：${fileName}`);
    
  } catch (error) {
    console.error(`❌ 发送失败:`, error);
    process.exit(1);
  }
}

main();
