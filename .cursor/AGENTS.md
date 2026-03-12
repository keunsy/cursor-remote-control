# Cursor Remote Control 项目

这是飞书和钉钉远程控制服务的项目。

## ⚠️ 创建定时任务时的强制要求

当用户要求创建定时任务时（如"3分钟后提醒我喝水"），**必须**遵循以下规则：

### 1. 检查环境变量

```javascript
const platform = process.env.CURSOR_PLATFORM;  // "dingtalk" 或 "feishu"
const webhook = process.env.CURSOR_WEBHOOK;    // 回调地址
```

### 2. 使用正确的文件路径（绝对路径）

```javascript
const CRON_FILE = platform === "dingtalk"
  ? "/Users/user/work/cursor/cursor-remote-control/cron-jobs-dingtalk.json"
  : "/Users/user/work/cursor/cursor-remote-control/cron-jobs-feishu.json";
```

### 3. 任务必须包含 platform 和 webhook 字段

```json
{
  "id": "uuid",
  "name": "任务名称",
  "platform": "dingtalk",  // ← 必填
  "webhook": "https://...", // ← 必填
  ...
}
```

### 4. 回复文案必须正确

- 钉钉平台：说"通过**钉钉**提醒你" 或 "**推送给你**"
- 飞书平台：说"通过**飞书**提醒你" 或 "**推送给你**"
- **禁止**说错平台名称！

## 详细说明

查看 `.cursor/CRON-TASK-RULES.md` 获取完整示例代码。
