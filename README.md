# Cursor Remote Control

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-1.x-333333.svg)](https://bun.sh)
通过 IM 平台远程控制 Cursor AI Agent 的中继服务。已支持飞书、钉钉、企业微信、微信个人号、Telegram，架构可扩展至更多渠道。

在手机上发消息，你的 Mac 就自动写代码、审文档、执行任务。将 Cursor 变成你的**私人 AI 战略合伙人**，随时随地通过 IM 调用。

**两种远程模式**：
- **Agent CLI 模式**：通过 IM 启动独立的 Cursor Agent 会话，适合新任务
- **IDE 入队模式**（`/ide`）：直接向正在运行的 Cursor IDE 窗口投递消息，与当前活跃的 Agent 对话交互，支持双向反馈——Agent 的回复自动返回 IM（依赖 [cursor-feedback-gate](https://github.com/keunsy/cursor-feedback-gate)）

---

## 架构设计

### 整体架构

```
飞书 ────── WebSocket ─────┐
                           │
钉钉 ────── Stream ────────┤
                           │
企业微信 ── WebSocket ─────┤
                           ├──→ Cursor CLI ──→ 本地 Cursor IDE
微信 ────── HTTP Poll ─────┤          │
                           │          │
Telegram ── Bot API ───────┤          │
                           │          │
更多渠道... ────────────────┘          │
                                      │
        ┌─────────────────────────────┘
        │
        ├─→ 项目路由
        ├─→ 会话管理（自动恢复上下文）
        ├─→ 记忆系统（混合搜索 + 向量数据库）
        ├─→ 定时任务（AI 创建，自动执行）
        └─→ 心跳系统（定期维护）
```

### 工作原理

**1. 消息接收**
- 各平台通过长连接/长轮询主动接收消息（具体连接方式见[技术栈](#技术栈)）
- 无需公网 IP，无需端口映射

**2. 消息处理**
```
用户消息 → 解析项目路由 → 多模态处理（文本/图片/语音/文件）
         ↓
    传递给 Cursor CLI
         ↓
    AI 处理（思考、工具调用、回复）
         ↓
    实时流式推送进度卡片
         ↓
    最终结果 + 耗时统计
```

**3. 会话管理**
- 每个项目工作区独立会话
- 自动 `--resume` 恢复上下文
- 同一会话串行，不同会话并发
- Cursor CLI 自主管理生命周期

**4. 记忆系统** ⭐
- **短期记忆**：`.cursor/sessions/` 会话转录（JSONL 格式）
- **长期记忆**：`.cursor/MEMORY.md` + `.cursor/memory/` 每日日记
- **混合搜索**：`.memory.sqlite` (FTS5 BM25 30% + 向量 70%)
- **时间衰减**：旧记忆权重指数衰减（30天半衰期）⭐
- **MMR 去重**：平衡相关性和多样性，避免重复结果 ⭐
- **自动 Flush**：心跳系统定期提醒 AI 写入记忆 ⭐
- **自主检索**：AI 通过 `memory-tool.ts` 自主决定何时搜索记忆
- 📖 **详细文档**：[docs/MEMORY-SYSTEM.md](docs/MEMORY-SYSTEM.md)

**5. 定时任务**
- AI 通过对话创建定时任务，写入 `cron-jobs-*.json`
- 支持一次性任务、间隔任务、Cron 表达式
- 三种任务类型：`agent-prompt`（调用 AI Agent 执行 prompt）、`fetch-news`（抓取热点新闻）、`text`（纯文本推送）
- 到期自动执行，结果推送到对应 IM 渠道

**6. 心跳系统**
- 定期触发 `.cursor/HEARTBEAT.md` 检查清单
- AI 自主管理检查项（整理记忆、检查状态等）
- 状态追踪：`.cursor/memory/heartbeat-state.json`

---

## 项目结构

```
cursor-remote-control/
├── shared/                      # 共享模块（所有平台共用）
│   ├── memory.ts                # 记忆管理器 v2（SQLite + 向量 + FTS5）
│   ├── memory-tool.ts           # 记忆 CLI（供 Agent 调用）
│   ├── scheduler.ts             # 定时任务调度
│   ├── heartbeat.ts             # 心跳系统
│   └── ...
│
├── feishu/                      # 飞书（含 bridge.ts OpenAI API 桥接）
├── dingtalk/                    # 钉钉（含 dingtalk-client.ts Stream 客户端）
├── wecom/                       # 企业微信
├── wechat/                      # 微信个人号
├── telegram/                    # Telegram
│   └── 每个平台目录结构类似：
│       server.ts / service.sh / README.md
│
├── projects.json                # 项目路由配置（共享）
├── cron-jobs-<platform>.json    # 各平台定时任务
├── manage-services.sh           # 统一服务管理脚本
└── docs/                        # 通用文档
```

## 功能特性

- 🚀 **多渠道支持**: 飞书、钉钉、企业微信、微信个人号、Telegram 等，独立部署，可同时运行，易于扩展新渠道
- 💰 **配额节约**: 集成 [Feedback Gate](https://github.com/keunsy/cursor-feedback-gate)，Opus 模型下单次请求内多轮反馈不消耗额外配额，500 次/月可实现数倍有效交互；auto 模式配额充足，不启用 CLI Feedback Gate ⭐
- 🖥️ **IDE 远程入队**: `/ide` 指令从 IM 直接向 Cursor IDE 队列投递消息，支持多窗口 PID 路由和双向反馈（依赖 [cursor-feedback-gate](https://github.com/keunsy/cursor-feedback-gate)）⭐
- 🧠 **记忆系统**: 混合搜索（FTS5 + 向量）、时间衰减、MMR 去重、自动 Flush
- ⏰ **定时任务**: AI 通过对话创建 Cron 任务，自动执行并推送通知
- 📰 **热点新闻推送**: 定时抓取多平台热榜并推送（微博/知乎/百度等）
- ❤️ **心跳检查**: 定期后台维护（整理记忆、检查状态）
- 🖼️ **多模态处理**: 文本、图片、语音、文件等多种消息类型
- 📁 **项目路由**: 多工作区切换，支持持久切换、临时路由、快捷前缀
- 🔄 **会话连续性**: 自动 resume 恢复上下文，多会话并发
- 📤 **文件发送**: 跨平台发送本地文件（API 上传 / CDN 转发）
- ⚡ **流式进度推送**: Agent 执行过程实时回传进度卡片
- 🔌 **OpenAI API 桥接**: 兼容 OpenAI Chat Completions 接口，可作为模型 provider
- 🎛️ **模型策略**: 模型别名、fallback 链、黑名单、按月重置
- 🎯 **身份人格**: 持久化人格与规则系统

---

## 快速开始

### 前置条件

| 项目 | 要求 |
|------|------|
| 系统 | macOS |
| 运行时 | [Bun](https://bun.sh) |
| IDE | [Cursor](https://cursor.com) 已安装并登录 |
| CLI | Cursor Agent CLI (`~/.local/bin/agent`) |

### 选择你的渠道

> 💡 **所有渠道可以同时运行**，互不干扰，共享项目配置和记忆系统。

#### 🟦 安装飞书服务

**安装步骤**（详细说明见 [feishu/README.md](feishu/README.md)）：

```bash
# 1. 安装 Bun 运行时（如果未安装）
curl -fsSL https://bun.sh/install | bash

# 2. 安装 Cursor Agent CLI（如果未安装）
curl https://cursor.com/install -fsS | bash

# 3. 登录 Cursor（一次性操作，之后不需要配置 API Key）
~/.local/bin/agent login

# 4. 创建并配置文件
cd /path/to/cursor-remote-control

# 创建项目路由配置
cp projects.json.example projects.json
# 编辑 projects.json，配置你的工作区路径

# 创建定时任务配置
cp cron-jobs-feishu.json.example cron-jobs-feishu.json

# 配置飞书凭据
cd feishu
cp .env.example .env
# 编辑 .env，填入：
# - FEISHU_APP_ID=cli_你的APP_ID
# - FEISHU_APP_SECRET=你的SECRET
# - CURSOR_MODEL=auto  # 建议用 auto 节省配额
# - 注释掉 CURSOR_API_KEY（已通过 agent login 登录）

# 5. 安装依赖并启动
cd feishu
bun install
bash service.sh install
```

**飞书后台配置**（服务启动后操作）：

1. 在[飞书开放平台](https://open.feishu.cn)创建企业自建应用
2. 添加**机器人**能力
3. 在「权限管理」中开通以下权限：
   - `im:message` / `im:message:readonly` — 获取与发送单聊、群聊消息
   - `im:message.group_at_msg` / `im:message.group_at_msg:readonly` — 获取群组中所有消息
   - `im:resource` — 获取与上传图片或文件资源
4. 复制 **App ID** 和 **App Secret**（已填入上面的 .env）
5. **等本机服务启动后**，在「事件订阅」中选择**长连接模式**，订阅 `im.message.receive_v1`

#### 🟦 安装钉钉服务

```bash
cd dingtalk
cp .env.example .env
# 编辑 .env 填入钉钉凭据
bun install
bash service.sh install
```

详细配置见 [dingtalk/README.md](dingtalk/README.md)

#### 🟩 安装企业微信服务

```bash
cd wecom

# ⚠️ 重要：必须先创建 .env 文件
cp .env.example .env
# 编辑 .env 填入企业微信机器人凭据（BotID 和 Secret）

bun install
bash service.sh install
```

详细配置见 [wecom/README.md](wecom/README.md)

#### 🟧 安装微信个人号服务

```bash
cd wechat
cp .env.example .env
# 编辑 .env（推荐使用 agent login，无需填 CURSOR_API_KEY）

bun install
bun run start.ts
# 首次启动会显示二维码，使用微信扫码登录即可
```

**特点**：
- HTTP 长轮询模式（35秒超时），无需公网 IP
- 基于腾讯官方 ilink bot API
- Token 自动持久化（首次扫码后无需重复登录）
- 支持"正在输入中"状态提示
- 支持文本、图片、语音、文件消息
- 支持 `/发送文件` 通过 CDN 发送本地文件
- 支持定时任务（天气推送、GitHub Trending 等）
- 可通过 `bash service.sh install` 安装为 launchd 系统服务

详细配置见 [wechat/README.md](wechat/README.md)

#### 🔵 安装 Telegram 服务

```bash
cd telegram
cp .env.example .env
# 编辑 .env 填入 Telegram Bot Token（通过 @BotFather 创建）

bun install
bash service.sh install
```

详细配置见 [telegram/README.md](telegram/README.md)

#### 同时使用多个渠道

所有平台服务可以同时运行，互不干扰：

```bash
# 安装各平台服务
cd feishu && bash service.sh install && cd ..
cd dingtalk && bash service.sh install && cd ..
cd wecom && bash service.sh install && cd ..
# wechat 直接运行: cd wechat && bun run start.ts

# 使用统一管理脚本
bash manage-services.sh status
```

---

## 服务管理

### 方式一：单平台管理

```bash
cd <platform>              # feishu / dingtalk / wecom / wechat / telegram
bash service.sh status     # 查看状态
bash service.sh restart    # 重启
bash service.sh logs       # 查看日志
```

### 方式二：统一管理脚本

```bash
bash manage-services.sh status           # 查看所有服务状态
bash manage-services.sh restart          # 重启所有服务
bash manage-services.sh logs feishu      # 查看飞书日志
bash manage-services.sh logs dingtalk    # 查看钉钉日志
bash manage-services.sh logs wecom       # 查看企业微信日志
```

---

## 使用指南

### 基本对话

直接给机器人发消息即可：

```
你好
帮我分析一下当前项目的代码结构
/帮助
```

### 常用指令

所有渠道都支持以下指令：

| 指令 | 中文别名 | 说明 |
|------|----------|------|
| `/help` | `/帮助` `/指令` | 显示所有命令 |
| `/status` | `/状态` | 查看服务状态（模型、Key、会话） |
| `/new` | `/新对话` `/新会话` | 重置当前工作区会话 |
| `/model 名称` | `/模型 名称` | 切换 AI 模型 |
| `/apikey key` | `/密钥 key` | 更换 API Key（仅限私聊） |
| `/stop [项目名]` | `/终止` `/停止` | 终止运行的任务（可指定项目名） |
| `/memory` | `/记忆` | 查看记忆系统状态 |
| `/memory 关键词` | `/记忆 关键词` | 语义搜索记忆 |
| `/log 内容` | `/记录 内容` | 写入今日日记 |
| `/任务` | `/cron` `/定时` | 查看/管理定时任务 |
| `/新闻` | `/news` | **热点**：立即推送今日热点；或 `/新闻 每天9点 推送10条` 定时 |
| `/新闻状态` | `/health` | 查看热点数据源健康状态 |
| `/心跳` | `/heartbeat` | 查看/管理心跳系统 |
| `/发送文件 <路径>` | `/sendfile` `/send` | 发送本地文件（飞书 30MB，企业微信 20MB，微信通过 CDN） |
| `/ide <消息>` | — | 投递消息到 IDE Feedback Gate 队列（依赖 [cursor-feedback-gate](https://github.com/keunsy/cursor-feedback-gate) Extension） |
| `/ide #序号 <消息>` | — | 指定窗口投递（多实例时，依赖 cursor-feedback-gate） |
| `/ide on` | — | 开启转发模式：所有非命令消息自动投递到 IDE |
| `/ide off` | — | 关闭转发模式 |
| `/ide` | — | 查看活跃 Feedback Gate 实例列表（依赖 cursor-feedback-gate） |

### 项目路由（多工作区）

**首次配置**：从模板创建配置文件

```bash
cd /path/to/cursor-remote-control
cp projects.json.example projects.json
# 编辑 projects.json，配置你的工作区
```

配置示例（所有平台共享）：

```json
{
  "projects": {
    "mycode": { "path": "/Users/你/Projects/myapp", "description": "代码项目" },
    "docs": { "path": "/Users/你/Documents/文档", "description": "文档工作区" }
  },
  "default_project": "mycode",
  "memory_workspace": "mycode"
}
```

使用方式（所有平台通用）：
- `docs: 帮我整理文档` → 路由到文档工作区
- `切换到 mycode` → 持久切换到代码项目

**注意**：`projects.json` 已加入 `.gitignore`，不会提交到仓库（本机配置）。

### 热点新闻定时推送 🆕

在任意渠道对话中说：

> **每天 9 点推送热点**

系统会自动创建定时任务，到点推送微博、知乎、百度等平台的热榜新闻。

| 说法示例 | 说明 |
|----------|------|
| 每天 9 点推送热点 | 每天 9:00 推送 |
| 18:00 推送热榜 | 每天 18:00 推送 |
| `/任务 执行 <ID>` | 立即执行一次 |

**详细文档**：[docs/news-push-usage.md](docs/news-push-usage.md)

### 文件发送功能

所有平台都支持发送本地文件：

```
/发送文件 ~/Desktop/report.pdf
/send /Users/me/Documents/data.xlsx
/sendfile ~/Downloads/app.apk
```

**特性**：
- ✅ 支持绝对路径和 `~` 家目录
- ✅ 自动检查文件存在性和大小
- ✅ 支持多种文件格式：APK、PDF、DOC/DOCX、XLS/XLSX、PPT、图片、音视频等
- ⚠️ 钉钉文件发送为实验性功能

**平台对比**：
| 平台 | 文件大小限制 | 方式 | 稳定性 |
|------|------------|------|--------|
| 飞书 | 30MB | API 上传 | ✅ 稳定 |
| 钉钉 | 30MB | API 上传 | ⚠️ 实验性 |
| 企业微信 | 20MB | API 上传 | ✅ 稳定 |
| 微信个人号 | 取决于 CDN | CDN 转发 | ✅ 稳定 |
| Telegram | 50MB | Bot API 上传 | ✅ 稳定 |

**命令行工具**（飞书）：

也可以通过命令行直接发送文件：

```bash
cd feishu
bun run send-file.ts /path/to/file.apk <接收人ID>
```

详见：[feishu/发送文件到飞书.md](feishu/发送文件到飞书.md)

---

## 配置文件管理

仓库提供 `.example` 模板文件，首次安装时复制并修改为实际配置。本地配置（`projects.json`、`cron-jobs-*.json`、各平台 `.env`）均已加入 `.gitignore`，不会被 `git pull` 覆盖。

| 模板文件 | 用途 |
|----------|------|
| `projects.json.example` | 项目路由配置 |
| `cron-jobs-*.json.example` | 定时任务配置 |
| `config/news-sources.json` | 新闻数据源配置（直接编辑） |

---

## 故障排查

### 各平台通用命令

所有平台（`feishu`、`dingtalk`、`wecom`、`wechat`、`telegram`）使用统一的 `service.sh` 管理脚本：

```bash
cd <platform> && bash service.sh status   # 查看状态
cd <platform> && bash service.sh restart  # 重启服务
cd <platform> && bash service.sh logs     # 查看日志
```

微信个人号特殊操作：Token 过期时删除 `wechat/.wechat_token` 后重新扫码。

### 通用问题

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| `API Key 无效` | .env 中有无效占位符 | 运行 `agent login` 登录，注释掉 .env 中的 `CURSOR_API_KEY` |
| `团队配额已用完` | 使用高消耗模型 | 改用 `auto` 模型（编辑 .env 中的 `CURSOR_MODEL=auto`） |
| `permission denied to access path` | projects.json 路径错误 | 检查 projects.json 中的路径是否正确 |
| `agent: command not found` | Agent CLI 未安装 | `curl https://cursor.com/install -fsS \| bash` |
| `bun: command not found` | Bun 未安装 | `curl -fsSL https://bun.sh/install \| bash` |

### 常见问题 FAQ

**Q: 需要配置 Cursor API Key 吗？**  
A: 不需要。运行 `agent login` 登录后会自动使用登录凭据。

**Q: 为什么提示配额用完？**  
A: 默认 Opus 模型。如果配额用尽，系统自动 fallback 到 `auto`（免费模型），也可手动切换：`/模型 auto`。auto 模式下 CLI Feedback Gate 不启用（配额充足无需节约 request）。

**Q: 所有渠道可以同时运行吗？**  
A: 可以！飞书、钉钉、企业微信、微信、Telegram 等所有平台服务独立运行，互不干扰，共享 `projects.json` 配置和记忆系统。

---

## 详细文档

**各平台**：[feishu/](feishu/README.md) · [dingtalk/](dingtalk/README.md) · [wecom/](wecom/README.md) · [wechat/](wechat/README.md) · [telegram/](telegram/README.md) — 每个目录下的 `README.md` 包含完整的配置、功能和使用指南

**功能文档**：[热点新闻推送](docs/news-push-usage.md) · [项目快捷路由](docs/飞书-Cursor-快速参考.md)

---

## 技术栈

**通用基础**：Bun 1.x + TypeScript / SQLite（向量索引 + FTS5）/ macOS launchd 部署

**各平台差异**：

| 平台 | SDK | 连接方式 | 流式回复 | 文件发送 |
|------|-----|---------|---------|---------|
| 飞书 | @larksuiteoapi/node-sdk | WebSocket 长连接 | 轮询刷新 | ✅ 30MB |
| 钉钉 | dingtalk-stream | Stream 长连接 | ❌ 不支持 | ✅ 30MB |
| 企业微信 | @wecom/aibot-node-sdk | WebSocket 长连接 | 主动推送 ⭐ | ✅ 20MB |
| 微信个人号 | ilink bot API (HTTP) | HTTP 长轮询 (35s) | 正在输入状态 | ✅ CDN |
| Telegram | node-telegram-bot-api | Bot API 长轮询 | 消息编辑更新 | ✅ 50MB |

> 微信个人号直接运行（`bun run start.ts`），其余平台通过 macOS launchd 管理。

**共享模块**（`shared/` 目录）：

| 模块 | 说明 |
|------|------|
| `agent-executor.ts` | 统一调用 Cursor CLI，超时/并发/进度回调 |
| `command-handler.ts` | 所有平台共用的斜杠指令处理 |
| `models-config.ts` | 模型别名/fallback/黑名单/按月重置 |
| `memory.ts` | SQLite + 向量 + FTS5 混合搜索 |
| `scheduler.ts` | Cron/间隔/一次性任务调度 |
| `heartbeat.ts` | 定期后台维护 |
| `news-fetcher.ts` | 多源并行抓取、去重、格式化 |
| `ide-reply-watcher.ts` | 监听 Feedback Gate Agent 回复并转发到 IM |

---

## 开源协议

本项目采用 MIT License 开源。详见 [LICENSE](LICENSE) 文件。
