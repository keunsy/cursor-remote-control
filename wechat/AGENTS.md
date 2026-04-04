# AGENTS.md — 微信个人号远程控制

> 微信个人号 → Cursor Agent 中继服务

---

## 项目定位

微信个人号 → Cursor AI 远程遥控桥接服务。用户在微信发消息，server 自动转发给本地 Cursor Agent CLI 执行，执行结果通过微信消息回传。

---

## 技术栈

| 层 | 技术 |
|---|------|
| 运行时 | Bun 1.x + TypeScript |
| 微信 API | ilinkai.weixin.qq.com（HTTP 长轮询） |
| 数据库 | SQLite（与飞书/钉钉/企微共享，记忆向量索引） |
| 部署 | 本地进程 / launchd（见 README） |

---

## 目录结构

```
wechat/
├── server.ts              # 主服务：长轮询 → CommandHandler / Agent
├── wechat-helper.ts       # 会话 key、.sessions.json
├── start.ts               # 启动脚本
├── package.json
├── .env.example
├── .wechat_token.json     # Token（自动生成）
├── .wechat_sync_buf       # 同步游标（自动生成）
└── README.md
```

---

## 共享模块（相对路径）

与飞书/钉钉/企业微信对齐：

- `../shared/scheduler.ts` — 定时任务（`cron-jobs-wechat.json`）
- `../shared/memory.ts` — 记忆
- `../shared/heartbeat.ts` — 心跳
- `../shared/feilian-control.ts` — 飞连 VPN
- `../shared/news-fetcher.ts` — 新闻
- `../shared/command-handler.ts` — `/帮助`、`/状态` 等
- `../shared/agent-executor.ts` — Agent 执行
- `../shared/models-config.ts` — 模型配置

---

## 已实现（与三端对齐）

- QR 扫码登录、Token / 同步游标持久化、长轮询收消息、文本发送（分片）、去重、断线重连、`context_token` 缓存
- **"正在输入中" 状态** ✅：通过 `sendtyping` API 在微信顶部显示"对方正在输入..."提示（类似 OpenClaw）
- **CommandHandler**：`/帮助`、`/状态`、`/模型`、`/任务`、记忆相关指令等与共享逻辑一致（平台展示为微信个人号）
- **会话**：`wechat-helper` + `wechat/.sessions.json`，key `wechat_${userId}`
- **项目路由**：`#项目`、对话式切换、`projects.json` 持久当前项目
- **Agent**：`execAgentWithFallback`、并发锁、`busySessions`
- **定时任务**：根目录 `cron-jobs-wechat.json`；任务须 `platform: "wechat"`，`webhook` 为**微信用户 id**（与钉钉 URL / 飞书 webhook 不同）
- **自然语言定时新闻**：「X 分钟后热点」「每天九点新闻」等，文案为通过微信推送
- **心跳 / 新闻调度**：投递时依赖该用户**最近一条消息**写入的 `context_token`；若长期无消息，token 可能失效，需用户再发一条刷新
- **媒体消息** ✅：
  - **图片**：接收/发送（`MEDIA:/path`）
  - **视频**：接收/发送（`MEDIA_VIDEO:/path`）
  - **文件**：接收/发送（`MEDIA_FILE:/path`）
  - **技术**：AES-128-ECB 加密，微信 CDN 传输
  - **核心模块**：`wechat/lib/media-handler.ts`（从 OpenClaw 官方插件移植）
- **引用消息** ✅：
  - **引用文本**：自动提取引用上下文，格式化为 `[引用: xxx]\n当前文本`
  - **引用媒体**：自动下载引用的图片/视频/文件，传递给 Agent
  - **用途**：提升多轮对话理解能力，让 AI 理解用户引用回复的完整上下文

---

## 仍不支持 / 低优先级

- 语音消息（需 SILK 音频编解码，较复杂）
- 模板卡片

---

## Agent 媒体功能使用指南

### 识别用户发送的媒体

当用户发送媒体时，Agent 会收到：

**图片**:
```
[用户发送了图片: file:///path/to/inbox/image.jpg]
```

**视频**:
```
[用户发送了视频: file:///path/to/inbox/video.mp4]
```

**文件**:
```
[用户发送了文件 "报告.pdf": file:///path/to/inbox/file.pdf]
```

Agent 可以使用 Cursor 内置能力读取和处理这些媒体。

### 发送媒体给用户

在回复中使用不同的指令（**必须独占一行**）：

#### 发送图片
**本地文件**:
```
MEDIA:/Users/user/work/cursor/cursor-remote-control/inbox/output.jpg
```

**远程 URL**（自动下载）:
```
MEDIA:https://api.example.com/generated-image.png
```

#### 发送视频
**本地文件**:
```
MEDIA_VIDEO:/Users/user/work/cursor/cursor-remote-control/inbox/demo.mp4
```

**远程 URL**:
```
MEDIA_VIDEO:https://example.com/video/tutorial.mp4
```

#### 发送文件
**本地文件**:
```
MEDIA_FILE:/Users/user/work/cursor/cursor-remote-control/inbox/report.pdf
```

**远程 URL**:
```
MEDIA_FILE:https://example.com/docs/manual.pdf
```

#### 混合发送
**带文字说明**:
```
这是你要的资料：

MEDIA_FILE:/path/to/report.pdf

以及演示视频：

MEDIA_VIDEO:/path/to/demo.mp4

希望能帮到你！
```

**多个图片**:
```
这是对比效果：

MEDIA:/path/to/before.jpg
MEDIA:/path/to/after.jpg
```

### 注意事项
- ✅ 指令必须独占一行，前后不能有其他内容
- ✅ 支持绝对路径、相对路径（相对于 workspace）、远程 HTTP/HTTPS URL
- ✅ 文件不存在会自动提示用户错误
- ✅ 文件大小限制：最大 100MB
- ✅ 支持格式：
  - 图片：JPEG, PNG, GIF, WEBP
  - 视频：MP4 等常见格式
  - 文件：任意文件类型（PDF, DOC, ZIP, TXT 等）

---

## 微信 API 要点

HTTP 长轮询；请求头需 `AuthorizationType: ilink_bot_token`、`X-WECHAT-UIN` 等。消息体为 `item_list` + `context_token`。同一账号桌面端互踢，建议小号测试。

---

## 与飞书/钉钉/企微对比（摘要）

| 特性 | 飞书/钉钉/企微 | 微信个人号 |
|------|----------------|------------|
| 连接 | WS/Stream 等 | HTTP 长轮询 |
| 定时 webhook | URL / 开放能力 id | **用户 id** |
| 流式回复 | 部分支持（卡片更新） | 否 |
| 输入提示 | 支持 | ✅ **已实现**（`sendtyping` API） |

---

**注意**：定时与心跳推送依赖有效 `context_token`；久未对话时让用户先发一条消息再依赖定时推送。
