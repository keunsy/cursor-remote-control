# Cursor Remote Control 项目

这是飞书和钉钉远程控制服务的项目。

## ⚠️ 创建定时任务时的强制要求

当用户要求创建定时任务时（如"3分钟后提醒我喝水"），**必须**遵循以下规则：

### 1. 读取全局规则文档

```javascript
const fs = require('fs');
const rulesPath = process.env.CURSOR_CRON_RULES_PATH;
if (rulesPath && fs.existsSync(rulesPath)) {
  const rules = fs.readFileSync(rulesPath, 'utf-8');
  // 按规则文档执行
}
```

### 2. 环境变量（必须检查）

```javascript
const platform = process.env.CURSOR_PLATFORM;  // "dingtalk" 或 "feishu"
const webhook = process.env.CURSOR_WEBHOOK;    // 回调地址
```

**如果环境变量为空，必须报错：** "系统配置错误，无法创建定时任务"

### 3. 文件路径（绝对路径，禁止相对路径）

```javascript
const CRON_FILE = platform === "dingtalk"
  ? "/Users/user/work/cursor/cursor-remote-control/cron-jobs-dingtalk.json"
  : "/Users/user/work/cursor/cursor-remote-control/cron-jobs-feishu.json";
```

❌ **禁止使用：** `"cron-jobs.json"` / `path.join(workspace, "cron-jobs.json")`

### 4. 任务字段（必填）

```json
{
  "id": "uuid",
  "platform": "dingtalk",  // ← 从 CURSOR_PLATFORM 读取
  "webhook": "https://...", // ← 从 CURSOR_WEBHOOK 读取
  ...
}
```

### 5. 回复文案（根据平台）

- 钉钉：说"通过**钉钉**提醒你"
- 飞书：说"通过**飞书**提醒你"
- **禁止**说错平台名称！

## 详细说明

环境变量 `CURSOR_CRON_RULES_PATH` 指向完整的规则文档，包含代码示例。
