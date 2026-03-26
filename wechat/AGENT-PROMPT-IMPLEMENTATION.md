# 微信 Agent Prompt 任务实现总结

## ✅ 已实现功能

### 1. 核心功能

- ✅ 解析 `{"type":"agent-prompt","prompt":"..."}` 格式的任务消息
- ✅ 使用超时控制执行 Agent（默认 5 分钟，可配置）
- ✅ 支持自定义工作区路径
- ✅ 模型自动降级（与正常对话一致）
- ✅ 配额警告（如有）会合并到结果中推送

### 2. 错误处理

- ✅ Agent 执行失败时推送友好的错误消息
- ✅ 超时后推送超时说明
- ✅ 空结果检查，避免推送空消息
- ✅ 失败不会立即禁用任务（避免网络抖动误判）
- ✅ 连续失败 5 次后自动禁用

### 3. 推送格式

- ✅ 成功：`🤖 定时 AI 回复` + 结果内容 + 执行时间 + 任务名称
- ✅ 失败：`⚠️ 定时任务失败` + 错误信息 + 重试建议
- ✅ 自动截断过长消息（3500 字符限制）

### 4. 文档与工具

- ✅ 完整的使用指南（`AGENT-PROMPT-USAGE.md`）
- ✅ 一键测试脚本（`test-agent-prompt.sh`）
- ✅ 示例任务配置（`test-agent-prompt.json`）

---

## 代码修改

### 1. 导入依赖

```typescript
import { parseAgentPromptMessage, withTimeout, DEFAULT_TIMEOUT_MS } from '../shared/scheduled-agent-prompt.js';
```

### 2. onExecute 添加 agent-prompt 处理

在新闻任务后、普通提醒前插入：

```typescript
// Agent Prompt 任务：执行保存的 Prompt 并返回 AI 回复
const agentPayload = parseAgentPromptMessage(msg);
if (agentPayload) {
    const workspace = job.workspace || defaultWorkspace;
    const timeoutMs = agentPayload.options?.timeoutMs || DEFAULT_TIMEOUT_MS;
    
    try {
        const ex = await withTimeout(
            execAgentWithFallback(agentExecutor, workspace, config.CURSOR_MODEL || DEFAULT_MODEL, agentPayload.prompt, {
                apiKey: config.CURSOR_API_KEY || undefined,
                platform: 'wechat',
                webhook: job.webhook,
            }),
            timeoutMs,
            `任务执行超时（${timeoutMs / 1000}秒）`
        );
        
        // 返回特殊标记的 JSON
        const deliveryPayload = {
            deliverKind: 'agent-prompt',
            text: ex.result,
            taskName: job.name,
        };
        
        return { status: 'ok' as const, result: JSON.stringify(deliveryPayload) };
        
    } catch (err) {
        // 错误处理...
    }
}
```

### 3. onDelivery 添加 agent-prompt 投递

在 JSON 解析后，优先处理 `deliverKind: "agent-prompt"`：

```typescript
// 1. Agent Prompt 任务：deliverKind: "agent-prompt"
if (parsed && parsed.deliverKind === 'agent-prompt') {
    const text = (parsed.text as string) || '';
    const taskName = (parsed.taskName as string) || job.name;
    const isError = parsed.isError as boolean;
    
    const title = isError ? '⚠️ 定时任务失败' : '🤖 定时 AI 回复';
    const content = `**${title}**\n\n${text}\n\n⏱ 执行时间：${timeStr}\n📌 任务名称：${taskName}`;
    
    await sendWechatText(uid, content.slice(0, 3500), tok);
    return;
}
```

---

## 快速测试

### 方式一：一键测试

```bash
cd /Users/user/work/cursor/cursor-remote-control/wechat
bash test-agent-prompt.sh
```

### 方式二：自然语言

在微信对话中说：

```
5分钟后查询北京天气
```

---

## 与飞书/钉钉/企微的对比

| 特性 | 飞书 | 钉钉 | 企业微信 | 微信个人号 |
|------|------|------|---------|-----------|
| Agent Prompt 任务 | ✅ | ⏳ 待实现 | ⏳ 待实现 | ✅ 已实现 |
| 超时控制 | ✅ | - | - | ✅ |
| 错误卡片 | ✅ | - | - | ✅ |
| 成功卡片 | ✅ | - | - | ✅ |
| 依赖 context_token | ❌ | ❌ | ❌ | ⚠️ 是 |

**微信特殊性**：
- ✅ 功能完整，与飞书对齐
- ⚠️ 依赖 `context_token`，需用户最近有消息互动
- ⚠️ 长期未互动会导致推送失败（需手动激活）

---

## 下一步

1. ⏳ 为钉钉实现 agent-prompt 任务
2. ⏳ 为企业微信实现 agent-prompt 任务
3. ⏳ 为飞书补充 agent-prompt 任务（代码似乎丢失了）
4. ⏳ 优化 context_token 自动续期机制

---

## 测试清单

- [x] 代码语法检查（bun run --dry-run）
- [x] 服务启动测试
- [ ] 实际任务执行测试（需等待定时触发）
- [ ] 超时控制测试
- [ ] 错误处理测试
- [ ] 长消息截断测试

---

## 相关文档

- [微信 Agent Prompt 使用指南](./AGENT-PROMPT-USAGE.md)
- [定时任务设计文档](../docs/SCHEDULED-AGENT-PROMPT-DESIGN.md)
- [通用任务示例](../docs/AGENT-PROMPT-TASK-EXAMPLE.md)
- [微信服务 README](./README.md)
