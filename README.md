English | [中文](README.zh-CN.md)

# Cursor Remote Control

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-1.x-333333.svg)](https://bun.sh)

A relay service for remotely controlling Cursor AI Agent through IM platforms. Supports Lark (Feishu), DingTalk, WeCom, WeChat, and Telegram, with an extensible architecture for more channels.

Send a message from your phone, and your Mac automatically writes code, reviews docs, and executes tasks. Turn Cursor into your **personal AI strategic partner**, accessible anytime, anywhere through IM.

**Two Remote Modes**:
- **Agent CLI Mode**: Launch independent Cursor Agent sessions from IM, ideal for new tasks

---

## Architecture

### Overview

```
Lark ──────── WebSocket ──────┐
                              │
DingTalk ──── Stream ─────────┤
                              │
WeCom ─────── WebSocket ──────┤
                              ├──→ Cursor CLI
WeChat ────── HTTP Poll ──────┤          │
                              │          │
Telegram ──── Bot API ────────┤          │
                              │          │
More channels... ─────────────┘          │
                                         │
        ┌────────────────────────────────┘
        │
        ├─→ Project Routing
        ├─→ Session Management (auto-resume context)
        ├─→ Memory System (hybrid search + vector DB)
        ├─→ Scheduled Tasks (AI-created, auto-executed)
        └─→ Heartbeat System (periodic maintenance)
```

### How It Works

**1. Message Reception**
- Each platform receives messages via persistent connections/long polling (see [Tech Stack](#tech-stack) for details)
- No public IP required, no port forwarding needed

**2. Message Processing**
```
User Message → Parse Project Route → Multimodal Processing (text/image/voice/file)
         ↓
    Pass to Cursor CLI
         ↓
    AI Processing (thinking, tool calls, replies)
         ↓
    Real-time Streaming Progress Cards
         ↓
    Final Result + Time Stats
```

**3. Session Management**
- Independent sessions per project workspace
- Auto `--resume` to restore context
- Serial within same session, concurrent across sessions
- Cursor CLI self-manages lifecycle

**4. Memory System** ⭐
- **Short-term**: `.cursor/sessions/` session transcripts (JSONL format)
- **Long-term**: `.cursor/MEMORY.md` + `.cursor/memory/` daily journals
- **Hybrid Search**: `.memory.sqlite` (FTS5 BM25 30% + Vector 70%)
- **Time Decay**: Exponential decay for old memories (30-day half-life) ⭐
- **MMR De-dup**: Balances relevance and diversity, avoids duplicates ⭐
- **Auto Flush**: Heartbeat system periodically reminds AI to write memories ⭐
- **Self-Retrieval**: AI decides when to search memory via `memory-tool.ts`
- 📖 **Detailed Docs**: [docs/MEMORY-SYSTEM.md](docs/MEMORY-SYSTEM.md)

**5. Scheduled Tasks**
- AI creates scheduled tasks through conversation, stored in `cron-jobs-*.json`
- Supports one-time tasks, interval tasks, and Cron expressions
- Three task types: `agent-prompt` (invoke AI Agent with prompt), `fetch-news` (fetch trending news), `text` (plain text push)
- Auto-executes on schedule, results pushed to corresponding IM channel

**6. Heartbeat System**
- Periodically triggers `.cursor/HEARTBEAT.md` checklist
- AI self-manages check items (organize memory, check status, etc.)
- State tracking: `.cursor/memory/heartbeat-state.json`

---

## Project Structure

```
cursor-remote-control/
├── shared/                      # Shared modules (used by all platforms)
│   ├── memory.ts                # Memory manager v2 (SQLite + Vector + FTS5)
│   ├── memory-tool.ts           # Memory CLI (for Agent use)
│   ├── scheduler.ts             # Task scheduler
│   ├── heartbeat.ts             # Heartbeat system
│   └── ...
│
├── feishu/                      # Lark (includes bridge.ts OpenAI API bridge)
├── dingtalk/                    # DingTalk (includes dingtalk-client.ts Stream client)
├── wecom/                       # WeCom
├── wechat/                      # WeChat (personal account)
├── telegram/                    # Telegram
│   └── Each platform directory has similar structure:
│       server.ts / service.sh / README.md
│
├── projects.json                # Project routing config (shared)
├── cron-jobs-<platform>.json    # Per-platform scheduled tasks
├── manage-services.sh           # Unified service management script
└── docs/                        # General documentation
```

## Features

- 🚀 **Multi-Channel**: Lark, DingTalk, WeCom, WeChat, Telegram — independently deployed, can run simultaneously, easy to extend
- 💰 **Quota Savings**: Integrated with [Feedback Gate](https://github.com/keunsy/cursor-feedback-gate); under Opus model, multi-turn feedback within a single request doesn't consume extra quota; 500 requests/month yields many more effective interactions; auto mode has ample quota, CLI Feedback Gate not enabled ⭐
- 🧠 **Memory System**: Hybrid search (FTS5 + Vector), time decay, MMR de-dup, auto flush
- ⏰ **Scheduled Tasks**: AI creates Cron tasks through conversation, auto-executes and pushes notifications
- 📰 **Trending News Push**: Scheduled multi-platform trending news aggregation (Weibo/Zhihu/Baidu etc.)
- ❤️ **Heartbeat Checks**: Periodic background maintenance (organize memory, check status)
- 🖼️ **Multimodal**: Text, images, voice, files and more
- 📁 **Project Routing**: Multi-workspace switching with persistent switch, temporary routing, and shortcut prefixes
- 🔄 **Session Continuity**: Auto-resume context, concurrent sessions
- 📤 **File Sending**: Cross-platform local file sending (API upload / CDN forwarding)
- ⚡ **Streaming Progress**: Real-time progress cards during Agent execution
- 🔌 **OpenAI API Bridge**: Compatible with OpenAI Chat Completions interface, can serve as model provider
- 🎛️ **Model Strategy**: Model aliases, fallback chains, blacklists, monthly resets
- 🎯 **Identity & Persona**: Persistent persona and rule system

---

## Quick Start

### Prerequisites

| Item | Requirement |
|------|-------------|
| OS | macOS |
| Runtime | [Bun](https://bun.sh) |
| CLI | Cursor Agent CLI (`~/.local/bin/agent`) |

### Choose Your Channel

> 💡 **All channels can run simultaneously**, independently, sharing project config and memory system.

#### 🟦 Lark (Feishu) Setup

**Installation** (see [feishu/README.md](feishu/README.md) for details):

```bash
# 1. Install Bun runtime (if not installed)
curl -fsSL https://bun.sh/install | bash

# 2. Install Cursor Agent CLI (if not installed)
curl https://cursor.com/install -fsS | bash

# 3. Login to Cursor (one-time, no API Key needed afterwards)
~/.local/bin/agent login

# 4. Create and configure files
cd /path/to/cursor-remote-control

# Create project routing config
cp projects.json.example projects.json
# Edit projects.json to configure your workspace paths

# Create scheduled tasks config
cp cron-jobs-feishu.json.example cron-jobs-feishu.json

# Configure Lark credentials
cd feishu
cp .env.example .env
# Edit .env with:
# - FEISHU_APP_ID=cli_your_APP_ID
# - FEISHU_APP_SECRET=your_SECRET
# - CURSOR_MODEL=auto  # recommended to save quota

# 5. Install deps and start
cd feishu
bun install
bash service.sh install
```

#### 🟦 DingTalk Setup

```bash
cd dingtalk
cp .env.example .env
# Edit .env with DingTalk credentials
bun install
bash service.sh install
```

Details: [dingtalk/README.md](dingtalk/README.md)

#### 🟩 WeCom Setup

```bash
cd wecom
cp .env.example .env
# Edit .env with WeCom bot credentials (BotID and Secret)
bun install
bash service.sh install
```

Details: [wecom/README.md](wecom/README.md)

#### 🟧 WeChat (Personal) Setup

```bash
cd wechat
cp .env.example .env
bun install
bun run start.ts
# First launch shows QR code — scan with WeChat to login
```

Details: [wechat/README.md](wechat/README.md)

#### 🔵 Telegram Setup

```bash
cd telegram
cp .env.example .env
# Edit .env with Telegram Bot Token (create via @BotFather)
bun install
bash service.sh install
```

Details: [telegram/README.md](telegram/README.md)

#### Using Multiple Channels

All platform services can run simultaneously:

```bash
# Install each platform service
cd feishu && bash service.sh install && cd ..
cd dingtalk && bash service.sh install && cd ..
cd wecom && bash service.sh install && cd ..

# Unified management
bash manage-services.sh status
```

---

## Service Management

### Per-Platform

```bash
cd <platform>              # feishu / dingtalk / wecom / wechat / telegram
bash service.sh status     # Check status
bash service.sh restart    # Restart
bash service.sh logs       # View logs
```

### Unified Script

```bash
bash manage-services.sh status           # All services status
bash manage-services.sh restart          # Restart all
bash manage-services.sh logs feishu      # View Lark logs
```

---

## Usage

### Basic Conversation

Just send a message to the bot:

```
Hello
Analyze the current project's code structure
/help
```

### Commands

All channels support these commands:

| Command | Description |
|---------|-------------|
| `/help` | Show all commands |
| `/status` | Check service status (model, key, sessions) |
| `/new` | Reset current workspace session |
| `/model name` | Switch AI model |
| `/stop [project]` | Terminate running task |
| `/memory` | View memory system status |
| `/memory keyword` | Semantic memory search |
| `/log content` | Write to today's journal |
| `/cron` | View/manage scheduled tasks |
| `/sendfile path` | Send local file |

### Project Routing (Multi-Workspace)

```bash
cp projects.json.example projects.json
# Edit projects.json with your workspaces
```

Config example (shared across all platforms):

```json
{
  "projects": {
    "mycode": { "path": "/Users/you/Projects/myapp", "description": "Code project" },
    "docs": { "path": "/Users/you/Documents/docs", "description": "Documentation workspace" }
  },
  "default_project": "mycode",
  "memory_workspace": "mycode"
}
```

Usage:
- `docs: help me organize docs` → routes to docs workspace
- `switch to mycode` → persistent switch to code project

---

## Tech Stack

**Common**: Bun 1.x + TypeScript / SQLite (Vector index + FTS5) / macOS launchd deployment

**Platform-Specific**:

| Platform | SDK | Connection | Streaming | File Send |
|----------|-----|-----------|-----------|-----------|
| Lark | @larksuiteoapi/node-sdk | WebSocket | Poll refresh | ✅ 30MB |
| DingTalk | dingtalk-stream | Stream | ❌ | ✅ 30MB |
| WeCom | @wecom/aibot-node-sdk | WebSocket | Push ⭐ | ✅ 20MB |
| WeChat | ilink bot API (HTTP) | HTTP Long Poll (35s) | Typing indicator | ✅ CDN |
| Telegram | node-telegram-bot-api | Bot API Long Poll | Message edit | ✅ 50MB |

**Shared Modules** (`shared/` directory):

| Module | Description |
|--------|-------------|
| `agent-executor.ts` | Unified Cursor CLI invocation, timeout/concurrency/progress callbacks |
| `command-handler.ts` | Slash command handler shared across all platforms |
| `models-config.ts` | Model aliases/fallback/blacklist/monthly resets |
| `memory.ts` | SQLite + Vector + FTS5 hybrid search |
| `scheduler.ts` | Cron/interval/one-time task scheduling |
| `heartbeat.ts` | Periodic background maintenance |
| `news-fetcher.ts` | Multi-source parallel fetch, de-dup, formatting |

---

## License

MIT License. See [LICENSE](LICENSE).
