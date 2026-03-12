# Cursor Remote Control 项目

这是飞书和钉钉远程控制服务的项目。

## ⚠️ 创建定时任务时的强制要求

当用户要求创建定时任务时（如"3分钟后提醒我喝水"），**必须**遵循以下规则：

### 1. 环境变量（必须检查）

```javascript
const CRON_FILE = process.env.CURSOR_CRON_FILE;  // 任务文件绝对路径
const platform = process.env.CURSOR_PLATFORM;    // "dingtalk" 或 "feishu"
const webhook = process.env.CURSOR_WEBHOOK;      // 回调地址

if (!CRON_FILE || !platform || !webhook) {
  throw new Error("缺少环境变量：CURSOR_CRON_FILE / CURSOR_PLATFORM / CURSOR_WEBHOOK");
}
```

**系统会自动设置：**
- `CURSOR_CRON_FILE`: 任务文件的绝对路径（直接写入，不需要拼接）
- `CURSOR_PLATFORM`: 平台标识
- `CURSOR_WEBHOOK`: 回调地址

### 2. 任务字段（必填）

```json
{
  "id": "uuid",
  "platform": "dingtalk",  // ← 从 CURSOR_PLATFORM 读取
  "webhook": "https://...", // ← 从 CURSOR_WEBHOOK 读取
  ...
}
```

### 3. 回复文案（根据平台）

- 钉钉：说"通过**钉钉**提醒你"
- 飞书：说"通过**飞书**提醒你"
- **禁止**说错平台名称！

## 详细说明

查看 `.cursor/CRON-TASK-RULES.md` 获取完整示例代码。
