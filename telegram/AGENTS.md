# Telegram Platform Architecture

## 概述

Telegram 平台通过 Bot API 实现与 Cursor Agent CLI 的集成，提供流式输出、实时进度反馈等高级特性。

## 技术栈

- **运行时**: Bun 1.x
- **SDK**: node-telegram-bot-api v0.67.0
- **消息接收**: Polling（轮询模式）
- **并发控制**: 单用户串行 + 全局限流
- **会话管理**: 内存存储 + 持久化支持

## 已实现功能

- ✅ Telegram Bot API 轮询接收消息
- ✅ 调用 Cursor Agent CLI 执行任务
- ✅ 流式输出（实时进度 + 代码片段预览）⭐
- ✅ 会话管理（--resume 持久化会话）
- ✅ 项目路由（多项目支持）
- ✅ Markdown 回复（支持长消息分片）
- ✅ 命令系统（/help、/new、/status 等）
- ✅ 定时任务（独立配置 cron-jobs-telegram.json）
- ✅ 心跳系统
- ✅ 记忆搜索（共享记忆库）
- ✅ 文件发送

## 核心特性

### 1. 流式输出 v1.1

**特点**：
- 实时显示 AI 处理进度
- 代码片段预览（最后 3 行，最多 100 字符）
- 三种阶段：🤔 思考中、🛠️ 执行工具、✍️ 生成回复
- 防抖机制（2 秒更新间隔）
- 自动降级（Markdown → 纯文本）

**实现**：
- `TelegramAdapter.replyStream()` - 完整流式 API
- `onProgress` 回调 - 实时进度更新
- `editMessageText` - Telegram 原生消息编辑

### 2. 轮询模式

**优点**：
- 无需公网 IP
- 无需域名和 SSL 证书
- 配置简单
- 适合个人开发者

**缺点**：
- 实时性略低于 WebHook
- 持续占用网络连接

### 3. 错误处理

- Markdown 解析失败 → 自动降级纯文本
- 消息超长 → 自动分片（4096 字符限制）
- 流式更新失败 → 容错忽略
- API 限流 → 防抖保护

### 4. 并发控制

- 单用户单项目：串行执行（防止混乱）
- 全局并发：最多 10 个任务
- 超时保护：30 分钟

## 架构图

```
Telegram 客户端
    │
    ↓ (HTTP Polling)
Telegram Bot API
    │
    ↓ (node-telegram-bot-api)
telegram/server.ts
    │
    ├─→ TelegramAdapter (平台适配)
    ├─→ CommandHandler (命令处理)
    ├─→ AgentExecutor (Agent 执行)
    ├─→ Scheduler (定时任务)
    ├─→ MemoryManager (记忆系统)
    └─→ HeartbeatRunner (心跳检查)
        │
        ↓ (spawn)
    Cursor Agent CLI
        │
        ↓
    Cursor IDE
```

## 与其他平台对比

| 特性 | Telegram | 飞书 |
|------|----------|------|
| 消息接收 | Polling | WebSocket |
| 流式输出 | ✅ editMessage (2秒) | ✅ 实时卡片更新 |
| 配置难度 | ⭐ 简单 | ⭐⭐⭐ 中等 |
| 企业账号 | ❌ 不需要 | ✅ 需要 |
| 语音识别 | ❌ 未实现 | ✅ 支持 |
| 图片处理 | ❌ 未实现 | ✅ 支持 |

## 未来规划

### v1.2 - 多媒体支持
- 语音识别（whisper-cpp）
- 图片处理（OCR）
- 文件接收

### v1.3 - 智能路由
- 对话式项目切换
- LLM 生成会话标题
- 持久化路由配置

### v1.4 - 交互增强
- Inline Keyboard（快捷按钮）
- 用户白名单
- 权限控制

---

**架构版本**: v1.1.0  
**最后更新**: 2026-03-25
