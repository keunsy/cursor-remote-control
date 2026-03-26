# 微信 context_token 限制说明

## 问题本质

`context_token` 是微信个人号 ilinkai bot API 的**强制要求**，无法绕过。

### API 层面的硬性限制

```typescript
// 微信 sendMessage API 结构
{
  msg: {
    to_user_id: "wxid_xxx",
    context_token: "必填字段",  // ← 缺少会被微信服务器拒绝
    item_list: [...]
  }
}
```

### OpenClaw 也有同样的限制

OpenClaw 使用相同的 `ilinkai.weixin.qq.com` API，同样依赖 `context_token`。

**为什么看起来没问题**：
- OpenClaw 主要用于**对话场景**（用户发消息 → bot 回复）
- 用户刚发送的消息自带最新的 `context_token`
- 定时推送和心跳同样会遇到 token 过期问题

## token 的特性

| 特性 | 说明 | 影响 |
|------|------|------|
| **获取方式** | 只能从用户发送的消息中获取 | 无法主动生成 |
| **有效期** | 短期有效（时长不明，估计几小时到几天） | 长期未互动会失效 |
| **作用** | 标识会话上下文，消息路由 | 缺少无法发送消息 |
| **更新机制** | 用户每次发消息都会刷新 | 需要用户主动互动 |

## 受影响的场景

### ✅ 不受影响
- **正常对话**：用户发消息 → bot 回复（token 新鲜）
- **短期定时**：几小时内的定时任务（token 仍有效）
- **频繁互动**：每天都有互动的用户（token 持续更新）

### ⚠️ 受影响
- **长期定时任务**：每周/每月的定时提醒（token 可能过期）
- **心跳系统**：定期后台维护推送（token 可能过期）
- **主动推送**：bot 主动发送消息（token 可能过期）

## 解决方案

### 方案 1：用户教育（推荐）

在文档中明确说明限制，并提供清晰的使用指南：

```markdown
## 定时推送使用须知

⚠️ 微信定时推送依赖 **context_token**，需要满足以下条件：

1. 你最近在微信中发过消息（建议：每天至少一次互动）
2. 如果长时间未互动，token 会失效，导致推送失败
3. **解决方法**：收到失败提示后，发送任意消息即可恢复

💡 建议：
- 每天至少打开一次微信，发送 `/状态` 查看服务状态
- 设置每日早晨定时任务，顺便刷新 token
- 长期不用时，手动发消息激活会话
```

### 方案 2：优雅降级

```typescript
// 推送失败时不要静默，而是记录
const failedPushes = new Map<string, string[]>();

async function deliverWithFallback(uid: string, content: string) {
    const tok = wechatContextTokens.get(uid);
    
    if (!tok) {
        console.warn(`[推送失败] 用户 ${uid} 无 context_token`);
        
        // 记录失败的推送内容
        if (!failedPushes.has(uid)) {
            failedPushes.set(uid, []);
        }
        failedPushes.get(uid)?.push(content);
        
        return false;
    }
    
    await sendWechatText(uid, content, tok);
    return true;
}

// 用户下次发消息时，补发失败的推送
async function onUserMessage(uid: string) {
    const pending = failedPushes.get(uid);
    if (pending && pending.length > 0) {
        await sendWechatText(
            uid,
            `📬 你有 ${pending.length} 条未送达的推送：\n\n${pending.join('\n\n---\n\n')}`,
            contextToken
        );
        failedPushes.delete(uid);
    }
}
```

### 方案 3：Token 续期提醒

```typescript
// 检测 token 可能快过期，主动提醒用户
class TokenManager {
    private lastActivity = new Map<string, number>();
    
    recordActivity(uid: string) {
        this.lastActivity.set(uid, Date.now());
    }
    
    shouldRemind(uid: string): boolean {
        const last = this.lastActivity.get(uid);
        if (!last) return false;
        
        // 如果 3 天没互动，提醒用户
        const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
        return Date.now() - last > THREE_DAYS;
    }
    
    async sendReminder(uid: string) {
        const tok = wechatContextTokens.get(uid);
        if (!tok) return;
        
        await sendWechatText(
            uid,
            `👋 已经 3 天没收到你的消息了\n\n为了继续接收定时推送，请回复任意内容以保持会话活跃`,
            tok
        );
    }
}
```

### 方案 4：心跳任务优化

```typescript
// 心跳系统改为"有条件触发"
const heartbeat = new HeartbeatRunner({
    config: {
        enabled: true,
        everyMs: 30 * 60_000,
        onlyWhenIdle: false,  // ← 不要求空闲
    },
    onExecute: async (prompt: string) => {
        // ... 执行心跳检查
    },
    onDelivery: async (content: string) => {
        const uid = lastWechatUserId;
        if (!uid) {
            console.warn('[心跳] 无最近用户，跳过推送');
            return;
        }
        
        const tok = wechatContextTokens.get(uid);
        if (!tok) {
            console.warn('[心跳] token 过期，等待用户下次互动');
            // 不要每次都报错，而是静默等待
            return;
        }
        
        // 只有有价值的内容才推送，避免打扰
        if (content !== 'HEARTBEAT_OK') {
            await sendWechatText(uid, content, tok);
        }
    },
});
```

## 技术原理

### 为什么腾讯要这样设计？

1. **防止滥用**
   - 如果允许 bot 无限主动推送，会导致 spam 泛滥
   - token 机制确保只在活跃会话中发送消息

2. **用户体验**
   - 防止用户被长期不用的 bot 骚扰
   - 确保消息在用户预期的会话上下文中出现

3. **安全性**
   - 防止 bot 账号被盗后无限发送消息
   - token 短期有效，降低泄露风险

### 与其他平台对比

| 平台 | 主动推送 | token 要求 | 限制程度 |
|------|---------|-----------|---------|
| 飞书 | ✅ 支持 | ❌ 不需要 | 低 |
| 钉钉 | ✅ 支持 | ❌ 不需要 | 低 |
| 企业微信 | ✅ 支持 | ❌ 不需要 | 低 |
| **微信个人号** | ⚠️ 受限 | ✅ **必需** | **高** |
| Telegram | ✅ 支持 | ❌ 不需要 | 低 |

**结论**：微信个人号的限制是最严格的，这是腾讯的有意设计。

## 最佳实践

### 1. 文档中明确说明

在 README 和使用指南中突出显示：

```markdown
## ⚠️ 重要：定时推送限制

微信定时推送**依赖最近的互动记录**：

- ✅ 如果你每天都会发消息，定时推送正常工作
- ⚠️ 如果长期未互动（3 天以上），推送可能失败
- 💡 解决方法：发送任意消息即可恢复推送

**推荐使用方式**：
1. 每天至少发一条消息（如：早上问候、查询天气）
2. 设置每日定时任务，顺便保持会话活跃
3. 长期不用后，重新激活只需发一条消息
```

### 2. 友好的错误提示

```typescript
// 定时任务失败时的提示
const tok = wechatContextTokens.get(uid);
if (!tok) {
    // 不要只记录日志，而是等用户下次互动时告知
    pendingNotifications.set(uid, {
        type: 'push_failed',
        count: (pendingNotifications.get(uid)?.count || 0) + 1,
        lastAttempt: Date.now(),
    });
    return;
}

// 用户下次发消息时
if (pendingNotifications.has(uid)) {
    const info = pendingNotifications.get(uid);
    await sendWechatText(
        uid,
        `⚠️ 检测到 ${info.count} 次定时推送失败\n\n原因：长时间未互动导致会话过期\n\n✅ 现在已恢复，后续推送将正常进行`,
        contextToken
    );
    pendingNotifications.delete(uid);
}
```

### 3. 定时任务设计建议

```markdown
## 定时任务设计建议

### ✅ 适合的任务
- 每日早间提醒（用户大概率会互动）
- 工作日提醒（高频互动场景）
- 短期定时任务（几小时内）

### ⚠️ 需注意的任务
- 每周任务（可能中间没互动）
- 每月任务（很可能 token 过期）
- 低频提醒（需要用户主动维护）

### 💡 最佳实践
- 每日任务 + 用户互动 = 稳定推送
- 低频任务 = 需要用户定期"签到"
- 长期任务 = 建议飞书/钉钉/企业微信
```

## 结论

1. **context_token 是微信 API 的硬性要求**，无法绕过
2. **OpenClaw 也有同样的限制**，只是对话场景不明显
3. **最佳解决方案是用户教育 + 优雅降级**
4. **对于需要稳定主动推送的场景，建议使用飞书/钉钉/企业微信**

## 参考资料

- 微信 ilinkai bot API 文档（非公开）
- OpenClaw 实现：https://github.com/547895019/openclaw-weixin
- 腾讯云开发者文档：[OpenClaw 接入微信](https://cloud.tencent.com.cn/developer/article/2628328)
