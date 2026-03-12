# ⚠️ 定时任务创建规则（强制执行）

## 🚨 关键要求（违反将导致任务错乱）

### 1. 文件路径（绝对路径，不可更改）

**钉钉平台：**
```
/Users/user/work/cursor/cursor-remote-control/cron-jobs-dingtalk.json
```

**飞书平台：**
```
/Users/user/work/cursor/cursor-remote-control/cron-jobs-feishu.json
```

### 2. 平台检测（必须使用环境变量）

```javascript
const platform = process.env.CURSOR_PLATFORM;  // "dingtalk" 或 "feishu"
const webhook = process.env.CURSOR_WEBHOOK;    // 回调地址
```

**如果环境变量为空，说明配置有问题，必须报错！**

### 3. 任务字段（必须包含）

```json
{
  "platform": "dingtalk",  // ← 从 process.env.CURSOR_PLATFORM 读取，必填！
  "webhook": "https://...", // ← 从 process.env.CURSOR_WEBHOOK 读取，必填！
  ...其他字段
}
```

### 4. 回复文案（根据平台调整）

**钉钉平台：**
- ✅ "已设置好，到时会通过**钉钉**提醒你"
- ✅ "已设置好，到时会**推送给你**"
- ❌ "已设置好，到时会通过**飞书**提醒你" ← 禁止！

**飞书平台：**
- ✅ "已设置好，到时会通过**飞书**提醒你"
- ✅ "已设置好，到时会**推送给你**"
- ❌ "已设置好，到时会通过**钉钉**提醒你" ← 禁止！

## 完整示例

```javascript
import { readFileSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';

// 1. 读取环境变量（必须）
const platform = process.env.CURSOR_PLATFORM;
const webhook = process.env.CURSOR_WEBHOOK;

if (!platform || !webhook) {
  throw new Error("缺少环境变量 CURSOR_PLATFORM 或 CURSOR_WEBHOOK");
}

// 2. 选择文件（绝对路径）
const CRON_FILE = platform === "dingtalk"
  ? "/Users/user/work/cursor/cursor-remote-control/cron-jobs-dingtalk.json"
  : "/Users/user/work/cursor/cursor-remote-control/cron-jobs-feishu.json";

// 3. 读取现有任务
let cronData;
try {
  cronData = JSON.parse(readFileSync(CRON_FILE, 'utf-8'));
} catch {
  cronData = { version: 1, jobs: [] };
}

// 4. 创建任务（必须包含 platform 和 webhook）
const task = {
  id: randomUUID(),
  name: "任务名称",
  enabled: true,
  deleteAfterRun: true,
  schedule: { kind: "at", at: "2026-03-12T16:45:00+08:00" },
  message: "提醒内容",
  platform: platform,     // ← 必填！
  webhook: webhook,       // ← 必填！
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  state: {}
};

// 5. 保存
cronData.jobs.push(task);
writeFileSync(CRON_FILE, JSON.stringify(cronData, null, 2));

// 6. 回复用户（根据平台调整文案）
const platformName = platform === "dingtalk" ? "钉钉" : "飞书";
console.log(`✅ 已创建到 ${CRON_FILE}，到时会通过${platformName}提醒你`);
```

## 常见错误（禁止）

❌ 使用相对路径：`"cron-jobs.json"` / `"./cron-jobs.json"`
❌ 使用工作区路径：`path.join(workspace, "cron-jobs.json")`
❌ 缺少 platform 字段
❌ 缺少 webhook 字段
❌ 文案提到错误的平台名称
