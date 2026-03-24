# 微信"正在输入中"功能测试

## 功能概述

微信个人号现已支持"正在输入中"状态提示，类似 OpenClaw 的体验。

## 实现原理

通过 `message_state: 1` 触发微信界面显示"对方正在输入..."提示。

```typescript
const MESSAGE_STATE_GENERATING = 1;  // 生成中（显示"正在输入中"）
const MESSAGE_STATE_FINISH = 2;      // 消息完成状态
```

## 测试步骤

### 1. 启动微信服务

```bash
cd wechat
bun run server.ts
```

### 2. 扫码登录

首次启动会显示二维码，用微信扫码登录。

### 3. 发送测试消息

在微信中给 Bot 发送任意消息，例如：

```
你好，请介绍一下你自己
```

### 4. 观察现象

**预期体验**：

1. **收到消息后立即显示**："正在输入中..."（微信界面顶部）
2. **排队时显示**："⏳ 排队中，请稍候..." + "正在输入中..."
3. **Agent 执行中**："⏳ 思考中..." + "正在输入中..."
4. **完成后**：收到完整的 Agent 回复

### 5. 对比效果

| 场景 | 之前 | 现在 |
|------|------|------|
| 收到消息 | 无反馈 | ✅ 显示"正在输入中" |
| 排队中 | 收到文本"⏳ 排队中" | ✅ 显示输入提示 + 文本 |
| 执行中 | 无反馈 | ✅ 显示"正在输入中" |
| 完成 | 收到结果 | 收到结果 |

## 技术细节

### 代码位置

- **常量定义**：`wechat/server.ts` 第 270-272 行
- **方法实现**：`WechatClient.sendTypingIndicator()` 第 591-609 行
- **调用位置**：
  - 排队时：第 1373 行
  - 执行前：第 1395 行

### 核心代码

```typescript
// 发送"正在输入中"状态
await client.sendTypingIndicator(uid, contextToken, '⏳ 思考中...');

// 执行 Agent
const result = await execAgentWithFallback(...);

// 发送完整结果（自动设置 message_state: 2）
await client.sendTextMessage(uid, result, contextToken);
```

## 注意事项

1. **必须有 context_token**：每次对话都需要最新的 `context_token`
2. **不影响主流程**：如果发送失败，会静默失败，不影响 Agent 执行
3. **无法实现真流式**：微信 API 不支持更新已发送的消息，只能显示输入提示

## 与其他平台对比

| 平台 | 流式输出 | 输入提示 | 实时进度更新 |
|------|---------|---------|-------------|
| 飞书 | ✅ | ✅ | ✅ |
| 钉钉 | ✅ | ✅ | ✅ |
| 企业微信 | ✅ | ✅ | ✅ |
| **微信个人号** | ❌ | ✅ | ❌ |

## 常见问题

### Q: 为什么看不到"正在输入中"？

**A**: 检查以下几点：
1. 确保使用最新版微信
2. 确保 `context_token` 有效
3. 查看服务端日志是否有报错
4. 尝试让用户先发一条消息刷新 token

### Q: 输入提示会显示多久？

**A**: 直到下一条 `message_state: 2` 的消息发送完成。

### Q: 能否显示实时进度（如"思考 10 秒"）？

**A**: 不行。微信 API 不支持更新已发送的消息，只能在最后发送完整结果。

## 日志示例

```
[微信] 收到消息: 你好，请介绍一下你自己
[Agent] 调用 Cursor CLI workspace=/path/to/workspace model=claude-sonnet-4-20250514
[Agent] 开始执行... (模型: claude-sonnet-4-20250514)
[Agent] 15秒 🤔 思考中
[Agent] 30秒 🔧 执行工具
[完成] workspace=/path/to/workspace elapsed=45秒
[微信] 回复成功
```

## 相关代码

- `wechat/server.ts` - 主服务
- `docs/WECHAT-INTEGRATION-PLAN.md` - 第 8 章
- `wechat/AGENTS.md` - 已实现功能说明
