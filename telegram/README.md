# Telegram 平台集成

通过 Telegram Bot 远程控制 Cursor AI Agent。

## 🌟 特性

### ✅ 已支持

- **消息处理**：文本消息、长消息自动分片
- **流式输出**：实时进度显示、代码片段预览、阶段切换提示 ⭐
- **会话管理**：持久化会话、历史查询、会话切换
- **项目路由**：多项目支持、快速切换
- **命令系统**：15+ 常用命令
- **定时任务**：Cron 定时执行
- **记忆系统**：基于向量的知识检索
- **文件发送**：支持发送本地文件

### ⏸️ 规划中

- 语音识别（STT）
- 图片处理（OCR）
- 对话式项目路由
- 会话标题生成

## 🚀 快速开始

### 1. 创建 Telegram Bot

1. 打开 Telegram，搜索 **@BotFather**
2. 发送 `/newbot`
3. 按提示设置 Bot 名称和用户名
4. 获取 Bot Token（类似 `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`）

### 2. 配置服务

```bash
cd telegram
cp .env.example .env
# 编辑 .env，填入 TELEGRAM_BOT_TOKEN
```

### 3. 测试连接

```bash
bun run test-bot.ts
```

### 4. 启动服务

```bash
# 方式 1：前台运行（开发）
bun run server.ts

# 方式 2：后台运行（生产）
./service.sh start

# 查看日志
./service.sh logs

# 停止服务
./service.sh stop
```

### 5. 开始使用

1. 在 Telegram 中搜索你的 Bot（@你的bot用户名）
2. 发送 `/start` 激活对话
3. 直接发送问题或命令

## 📝 使用示例

### 基础对话

```
你: 帮我写一个 Python 爬虫
Bot: 🤔 思考中... (3秒)
     🛠️ 执行工具... (8秒)
     [显示代码片段预览]
     ✍️ 生成回复... (15秒)
     [完整回复]
     ⏱️ 用时: 18秒
```

### 项目路由

```
你: api:查看最近的提交记录
Bot: [切换到 api 项目，执行 git log]

你: web:启动开发服务器
Bot: [切换到 web 项目，执行 npm run dev]
```

### 常用命令

```
/help         # 查看帮助
/new          # 开始新会话
/status       # 查看当前状态
/model        # 查看/切换模型
/projects     # 查看可用项目
/sessions     # 查看会话历史
```

## ⚙️ 配置说明

`.env` 文件配置项：

```bash
# 必填：Bot Token（从 @BotFather 获取）
TELEGRAM_BOT_TOKEN=your_bot_token_here

# 可选：Cursor API Key
CURSOR_API_KEY=

# 可选：默认模型
CURSOR_MODEL=claude-sonnet-4

# 可选：记忆系统（火山引擎 Embedding）
VOLC_EMBEDDING_API_KEY=
VOLC_EMBEDDING_MODEL=doubao-embedding-vision-250615
```

## 🎯 技术特性

### 流式输出

- 实时显示 AI 处理进度
- 代码片段预览（最后 3 行）
- 三种阶段：🤔 思考中、🛠️ 执行工具、✍️ 生成回复
- 防抖机制（2 秒更新间隔）

### 错误处理

- Markdown 解析失败自动降级纯文本
- 超长消息自动分片（4096 字符限制）
- 流式更新失败容错
- 多层异常捕获

### 并发控制

- 单用户单项目串行执行
- 全局最多 10 个并发任务
- 30 分钟超时保护

## 📊 与其他平台对比

| 特性 | Telegram | 飞书 | 钉钉 | 企业微信 |
|------|----------|------|------|----------|
| 配置难度 | ⭐ 简单 | ⭐⭐⭐ 中等 | ⭐⭐ 简单 | ⭐⭐⭐ 中等 |
| 企业账号 | ❌ 不需要 | ✅ 需要 | ✅ 需要 | ✅ 需要 |
| 消息接收 | Polling | WebSocket | Stream | WebSocket |
| 流式输出 | ✅ 支持 | ✅ 支持 | ✅ 支持 | ✅ 支持 |
| 语音识别 | ❌ | ✅ | ✅ | ✅ |
| 图片处理 | ❌ | ✅ | ❌ | ❌ |

## 🛠️ 故障排查

### Bot 无响应

1. 检查服务是否运行：`./service.sh status`
2. 查看日志：`./service.sh logs`
3. 验证 Token：`bun run test-bot.ts`

### 消息发送失败

- Markdown 语法错误 → 自动降级为纯文本
- 消息过长 → 自动分片发送
- API 限流 → 降低发送频率

### 会话丢失

- 服务重启会清空内存中的会话
- 使用 `/new` 开始新会话
- 或继续发送消息，自动创建新会话

## 📚 更多文档

- [QUICKSTART.md](QUICKSTART.md) - 5 分钟快速上手
- [AGENTS.md](AGENTS.md) - 架构设计说明

## 💡 最佳实践

1. **开发环境**：使用前台运行 `bun run server.ts`，方便查看日志
2. **生产环境**：使用后台运行 `./service.sh start`，定期检查日志
3. **项目路由**：频繁切换项目时，使用 `项目名:消息` 格式
4. **长时间任务**：耐心等待，可以看到实时进度
5. **错误处理**：看到 ❌ 提示时，检查日志了解详情

## 🔒 安全建议

- ⚠️ 不要泄露 Bot Token（视为密码）
- ⚠️ 不要在公共频道中使用（仅私聊）
- ⚠️ 定期检查 Bot 的对话记录
- ✅ 建议：添加用户白名单（未来支持）

---

**版本**: v1.1.0  
**状态**: ✅ 生产可用  
**最后更新**: 2026-03-25
