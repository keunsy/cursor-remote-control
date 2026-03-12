# ⚠️ 定时任务创建规则（强制执行）

## 🚨 关键要求（违反将导致任务错乱）

### 1. 文件路径（从环境变量读取，禁止硬编码）

```javascript
const CRON_FILE = process.env.CURSOR_CRON_FILE;  // 任务文件绝对路径
const platform = process.env.CURSOR_PLATFORM;    // "dingtalk" 或 "feishu"
const webhook = process.env.CURSOR_WEBHOOK;      // 回调地址

if (!CRON_FILE || !platform || !webhook) {
  throw new Error("缺少环境变量：CURSOR_CRON_FILE / CURSOR_PLATFORM / CURSOR_WEBHOOK");
}
```

**系统会自动设置这些环境变量：**
- `CURSOR_CRON_FILE`: 任务文件的绝对路径（如 `/path/to/cron-jobs-feishu.json`）
- `CURSOR_PLATFORM`: 平台标识（`dingtalk` 或 `feishu`）
- `CURSOR_WEBHOOK`: 回调地址（chatId 或 webhook URL）

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
const CRON_FILE = process.env.CURSOR_CRON_FILE;
const platform = process.env.CURSOR_PLATFORM;
const webhook = process.env.CURSOR_WEBHOOK;

if (!CRON_FILE || !platform || !webhook) {
  throw new Error("缺少环境变量：CURSOR_CRON_FILE / CURSOR_PLATFORM / CURSOR_WEBHOOK");
}

// 2. 读取现有任务（直接使用环境变量中的绝对路径）
let cronData;
try {
  cronData = JSON.parse(readFileSync(CRON_FILE, 'utf-8'));
} catch {
  cronData = { version: 1, jobs: [] };
}

// 3. 创建任务（必须包含 platform 和 webhook）
const task = {
  id: randomUUID(),
  name: "任务名称",
  enabled: true,
  deleteAfterRun: true,
  schedule: { kind: "at", at: "2026-03-12T16:45:00+08:00" },
  message: "提醒内容",
  platform: platform,     // ← 从环境变量读取
  webhook: webhook,       // ← 从环境变量读取
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  state: {}
};

// 4. 保存（使用环境变量中的绝对路径）
cronData.jobs.push(task);
writeFileSync(CRON_FILE, JSON.stringify(cronData, null, 2));

// 6. 回复用户（根据平台调整文案）
const platformName = platform === "dingtalk" ? "钉钉" : "飞书";
console.log(`✅ 已创建到 ${CRON_FILE}，到时会通过${platformName}提醒你`);
```

## 常见错误（禁止）

❌ 硬编码文件路径：必须使用 `process.env.CURSOR_CRON_FILE`
❌ 使用相对路径：`"cron-jobs.json"` / `"./cron-jobs.json"`
❌ 使用工作区路径：`path.join(workspace, "cron-jobs.json")`
❌ 根据 platform 手动拼接路径：直接用 `CURSOR_CRON_FILE` 环境变量
❌ 缺少 platform 字段
❌ 缺少 webhook 字段
❌ 文案提到错误的平台名称
