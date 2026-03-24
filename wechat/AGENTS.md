# AGENTS.md — wechat-cursor-claw

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

---

## 仍不支持 / 低优先级

- `/发送文件`、`/apk` 等需发文件的指令：个人号侧无 sendFile 适配，CommandHandler 会走「不支持」分支
- 语音、图片、文件上行、模板卡片

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
