# 微信 Agent Prompt 任务使用指南

## 快速测试

### 方式一：一键测试脚本

```bash
cd /Users/user/work/cursor/cursor-remote-control/wechat
bash test-agent-prompt.sh
```

脚本会自动：
1. 检测你的微信用户 ID
2. 创建一个 2 分钟后执行的测试任务
3. 添加到 `cron-jobs-wechat.json`

### 方式二：手动添加任务

编辑 `/Users/user/work/cursor/cron-jobs-wechat.json`，在 `jobs` 数组中添加：

```json
{
  "id": "test-agent-prompt-wechat-001",
  "name": "测试：AI 天气查询",
  "enabled": true,
  "deleteAfterRun": true,
  "schedule": {
    "kind": "at",
    "at": "2026-03-26T10:00:00+08:00"
  },
  "message": "{\"type\":\"agent-prompt\",\"prompt\":\"请用联网搜索查询北京市当日实时天气预报。回复必须严格按：☁️ 标题行；五条 - 天气/温度/体感/降水/风力；体感一行含穿衣建议；最后单独一段一两句总结。缺数据写「—」。勿改成纯散文。\",\"options\":{\"timeoutMs\":240000}}",
  "workspace": "/Users/user/work/cursor/cursor-remote-control",
  "platform": "wechat",
  "webhook": "YOUR_WECHAT_USER_ID",
  "createdAt": "2026-03-25T00:00:00.000Z",
  "updatedAt": "2026-03-25T00:00:00.000Z",
  "state": {}
}
```

**重要**：
- 将 `at` 字段修改为几分钟后的时间
- 将 `webhook` 字段替换为你的微信用户 ID（在 `cron-jobs-wechat.json` 中查找已有任务的 `webhook`）

---

## 自然语言创建任务

在微信对话中直接说：

### ✅ 推荐表述（清晰明确）

```
✅ "5分钟后查询北京天气"
✅ "5分钟后告诉我北京天气"
✅ "每天早上8点告诉我天气和穿衣建议"
✅ "每周一帮我汇总上周的 git 提交记录"
✅ "每小时检查服务日志是否有错误"
```

### ❌ 容易误判的表述

```
❌ "3分钟后提醒我看娱乐新闻"  → 可能被理解为固定文本提醒
✅ "3分钟后查询最新的娱乐新闻" → 明确是查询动作
```

**技巧**：
- 使用"查询"、"搜索"、"汇总"、"告诉我"、"帮我查"等动词
- 关键是表达清楚需要 AI **实时查询/分析**，而不是固定文本
- 避免模糊表述如"提醒我看新闻"

---

## 任务配置说明

### message 格式（JSON 字符串）

```json
{
  "type": "agent-prompt",
  "prompt": "要执行的 Prompt（支持多行、中文、工具调用）",
  "options": {
    "timeoutMs": 300000
  }
}
```

**字段说明**：
- `type`: 必须为 `"agent-prompt"`
- `prompt`: 必填，要执行的 Prompt 内容
- `options.timeoutMs`: 可选，超时时间（毫秒），默认 5 分钟

### 完整任务示例

#### 1. 每日天气提醒

```json
{
  "name": "每日早间天气",
  "enabled": true,
  "deleteAfterRun": false,
  "schedule": {
    "kind": "cron",
    "expr": "0 8 * * *",
    "tz": "Asia/Shanghai"
  },
  "message": "{\"type\":\"agent-prompt\",\"prompt\":\"请用联网搜索查询北京市当日实时天气预报（气温、阴晴、风力、降水概率等）。输出版式：☁️ 北京（可带区县）今日天气（M月d日）；然后 - 天气 / - 温度 / - 体感（含穿衣） / - 降水 / - 风力 五条列表；最后单独一段总结。缺数据写「—」，勿整段散文。\"}",
  "workspace": "/Users/user/work/cursor/cursor-remote-control",
  "platform": "wechat",
  "webhook": "wxid_xxx",
  "id": "daily-weather-001",
  "createdAt": "2026-03-25T00:00:00.000Z",
  "updatedAt": "2026-03-25T00:00:00.000Z",
  "state": {}
}
```

#### 2. 每周代码提交汇总

```json
{
  "name": "周报：提交汇总",
  "enabled": true,
  "deleteAfterRun": false,
  "schedule": {
    "kind": "cron",
    "expr": "0 17 * * 5",
    "tz": "Asia/Shanghai"
  },
  "message": "{\"type\":\"agent-prompt\",\"prompt\":\"请使用 git log 查询当前工作区本周（周一到今天）的所有提交记录，按作者分组汇总提交数量，并列出每个人的主要工作内容（不超过 500 字）。\"}",
  "workspace": "/Users/user/Projects/myapp",
  "platform": "wechat",
  "webhook": "wxid_xxx",
  "id": "weekly-git-summary",
  "createdAt": "2026-03-25T00:00:00.000Z",
  "updatedAt": "2026-03-25T00:00:00.000Z",
  "state": {}
}
```

#### 3. 定期服务健康检查

```json
{
  "name": "服务健康检查",
  "enabled": true,
  "deleteAfterRun": false,
  "schedule": {
    "kind": "every",
    "everyMs": 3600000
  },
  "message": "{\"type\":\"agent-prompt\",\"prompt\":\"请检查 /var/log/app.log 最近 100 行日志，统计 ERROR 和 WARN 的数量，如果有异常模式（如同一错误重复 5 次以上）请列出。\"}",
  "workspace": "/Users/user/Projects/myapp",
  "platform": "wechat",
  "webhook": "wxid_xxx",
  "id": "health-check-001",
  "createdAt": "2026-03-25T00:00:00.000Z",
  "updatedAt": "2026-03-25T00:00:00.000Z",
  "state": {}
}
```

---

## 重要提示

### ⚠️ context_token 依赖（重要）

微信个人号的定时推送**强制依赖** `context_token`，这是微信 API 的硬性要求，无法绕过。

#### 什么是 context_token？

- **本质**：会话标识符，微信用它确定消息应该发送到哪个会话
- **获取方式**：**只能从你发送的消息中获取**，无法主动生成
- **有效期**：短期有效（估计几小时到几天），长时间不互动会失效
- **更新机制**：你每次发消息都会刷新 token

#### OpenClaw 也有这个限制吗？

**是的**，OpenClaw 使用相同的微信 API，同样依赖 `context_token`。

看起来没问题是因为 OpenClaw 主要用于**对话场景**（你发消息 → bot 回复），此时 token 是新鲜的。定时推送和心跳同样会遇到 token 过期问题。

#### 如何解决？

**无法绕过，只能优雅处理**：

1. **建议使用方式**：
   - ✅ 每天至少发一条消息（保持 token 活跃）
   - ✅ 设置每日定时任务，顺便刷新 token
   - ✅ 长期不用后，发任意消息即可恢复

2. **适合的场景**：
   - ✅ 每日提醒（用户大概率会互动）
   - ✅ 工作日任务（高频互动）
   - ✅ 短期定时（几小时内）

3. **不太适合的场景**：
   - ⚠️ 每周任务（可能中间没互动）
   - ⚠️ 每月任务（token 很可能过期）
   - ⚠️ 低频提醒（需要定期"签到"）

4. **失败后的恢复**：
   - 发送任意消息（如"你好"）即可重新激活
   - 下次推送将正常进行

#### 日志提示

```bash
[定时] 无 context_token（请让用户先发一条消息激活会话）
```

#### 为什么腾讯要这样设计？

1. **防止滥用**：如果允许无限主动推送，会导致 spam 泛滥
2. **用户体验**：防止被长期不用的 bot 骚扰
3. **安全性**：token 短期有效，降低泄露风险

#### 其他平台对比

| 平台 | 主动推送 | token 要求 | 限制程度 |
|------|---------|-----------|---------|
| 飞书 | ✅ 支持 | ❌ 不需要 | 低 |
| 钉钉 | ✅ 支持 | ❌ 不需要 | 低 |
| 企业微信 | ✅ 支持 | ❌ 不需要 | 低 |
| **微信个人号** | ⚠️ 受限 | ✅ **必需** | **高** |

**结论**：对于需要稳定主动推送的场景，建议使用飞书/钉钉/企业微信。

**详细说明**：参考 [context_token 限制说明](./CONTEXT-TOKEN-LIMITATION.md)

### 超时控制

- **默认超时**：5 分钟（可通过环境变量 `SCHEDULED_AGENT_TIMEOUT_MS` 修改）
- **任务级超时**：在 `options.timeoutMs` 中指定
- **超时后**：推送错误消息，说明超时原因

### 错误处理

- **Prompt 非法**：日志记录，推送错误消息
- **Agent 失败**：推送错误消息，**不会立即禁用任务**（避免网络抖动误判）
- **连续失败 5 次**：任务自动禁用

---

## 调试技巧

### 1. 查看调度日志

```bash
tail -f /tmp/wechat-cursor.log | grep -E 'agent-prompt|scheduler'
```

**关键日志**：
```
[scheduler] agent-prompt task triggered: 测试：AI 天气查询
[scheduler] agent-prompt completed: 测试：AI 天气查询, result length: 150
[scheduler] wechat agent-prompt sent: 测试：AI 天气查询 (success)
```

### 2. 手动测试 Prompt

在微信会话中直接发送 Prompt，验证逻辑是否正确：

```
请查询北京今天的天气情况，并给出简短的穿衣建议。
```

### 3. 检查任务状态

读取 `cron-jobs-wechat.json` 中的 `state` 字段：
- `lastStatus`: `"ok"` 或 `"error"`
- `consecutiveErrors`: 连续失败次数
- `nextRunAtMs`: 下次执行时间戳

### 4. 验证 context_token

```bash
# 查看最近的 context_token 日志
tail -f /tmp/wechat-cursor.log | grep 'context_token'
```

---

## 推送消息格式

### 成功推送

```
🤖 定时 AI 回复

[AI 的查询结果内容]

⏱ 执行时间：03-25 10:00
📌 任务名称：测试：AI 天气查询
```

### 失败推送

```
⚠️ 定时任务失败

任务名称：测试：AI 天气查询

错误信息：任务执行超时（300秒）

💡 请检查 Prompt 是否合法，或稍后在会话中手动重试

⏱ 执行时间：03-25 10:00
📌 任务名称：测试：AI 天气查询
```

---

## 常见问题

### Q: 为什么没有收到推送？

A: 检查以下几点：
1. 微信服务是否正在运行
2. 是否有有效的 `context_token`（最近是否发过消息）
3. 任务的 `webhook` 字段是否填写正确
4. 任务是否已启用（`enabled: true`）
5. 查看日志是否有错误信息

### Q: 如何获取我的微信用户 ID？

A: 两种方式：
1. 在微信中发一条消息，然后查看 `cron-jobs-wechat.json` 中已有任务的 `webhook` 字段
2. 查看日志：`grep 'from_user_id' /tmp/wechat-cursor.log`

### Q: 如何强制刷新 context_token？

A: 在微信中发送任意消息即可，系统会自动更新 `context_token`

### Q: 任务执行失败会怎样？

A: 
- 推送错误消息通知你
- 任务不会立即禁用（避免偶发故障）
- 连续失败 5 次后自动禁用

---

## 参考文档

- [定时 Agent Prompt 任务设计文档](../docs/SCHEDULED-AGENT-PROMPT-DESIGN.md)
- [定时任务使用示例](../docs/AGENT-PROMPT-TASK-EXAMPLE.md)
- [微信服务 README](./README.md)
