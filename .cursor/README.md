# Cursor Remote Control 项目配置

这是飞书和钉钉远程控制服务的项目根目录。

## 重要文件位置

### 定时任务文件（全局）
- **飞书任务**：`/Users/user/work/cursor/cursor-remote-control/cron-jobs-feishu.json`
- **钉钉任务**：`/Users/user/work/cursor/cursor-remote-control/cron-jobs-dingtalk.json`

⚠️ **禁止创建到其他位置！** 定时任务必须创建在项目根目录的上述文件中。

### 环境变量
- `CURSOR_PLATFORM`：当前平台（"feishu" 或 "dingtalk"）
- `CURSOR_WEBHOOK`：回调地址（飞书为 chatId，钉钉为 webhook URL）

## 创建定时任务的正确方式

```javascript
// ✅ 正确：使用环境变量和绝对路径
const platform = process.env.CURSOR_PLATFORM || "feishu";
const webhook = process.env.CURSOR_WEBHOOK;

const CRON_FILE = platform === "dingtalk"
  ? "/Users/user/work/cursor/cursor-remote-control/cron-jobs-dingtalk.json"
  : "/Users/user/work/cursor/cursor-remote-control/cron-jobs-feishu.json";

// 任务必须包含这两个字段
const task = {
  ...otherFields,
  platform: platform,
  webhook: webhook
};
```

```javascript
// ❌ 错误：使用相对路径
fs.writeFileSync("cron-jobs.json", ...)  // 会写到工作区目录
fs.writeFileSync("./cron-jobs.json", ...)  // 会写到工作区目录
```
