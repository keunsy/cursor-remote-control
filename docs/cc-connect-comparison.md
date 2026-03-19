# cc-connect 项目对比分析

> 文档创建时间：2026-03-19  
> 对比项目：[cc-connect](https://github.com/chenhg5/cc-connect) v1.2.1

---

## 📋 文档目的

本文档分析 cc-connect 项目与 cursor-remote-control 项目的差异，提炼值得借鉴的设计理念和技术实现，为项目优化提供参考。

---

## 🎯 项目定位对比

| 维度 | **cc-connect** | **cursor-remote-control** |
|------|----------------|---------------------------|
| **核心目标** | 通用 AI Agent 桥接框架 | 专注 Cursor Agent 深度集成 |
| **设计理念** | 横向扩展（多 Agent + 多平台） | 纵向深耕（Cursor 专属特性） |
| **用户群体** | 需要切换多种 AI Agent 的开发者 | 深度使用 Cursor 的个人/团队 |
| **部署方式** | npm 全局安装/二进制文件 | 本地源码 + launchd |
| **开发语言** | Go 1.22+ | TypeScript + Bun |

---

## 💻 技术栈对比

### 语言与运行时

| 层 | **cc-connect** | **cursor-remote-control** |
|-----|----------------|---------------------------|
| **编程语言** | Go 1.22+ | TypeScript + Bun 1.x |
| **打包方式** | 单一二进制文件（10-20MB） | 源码直接运行（无需编译） |
| **配置管理** | 单一 config.toml | 多 .env + projects.json |
| **进程架构** | 单进程多项目 | 多进程（每平台独立） |
| **依赖管理** | Go modules | Bun package.json |
| **部署方式** | npm 全局安装/二进制下载 | 本地源码 + launchd |
| **跨平台** | Linux/macOS/Windows | macOS only |

### 核心依赖

**cc-connect**：
- 无运行时依赖（静态链接）
- 可选依赖：ffmpeg（语音转换）

**cursor-remote-control**：
- Bun 运行时（必需）
- @larksuiteoapi/node-sdk（飞书）
- dingtalk-stream（钉钉）
- @wecom/aibot-node-sdk（企业微信）
- whisper-cpp（可选，语音识别降级）

---

## 🤖 AI Agent 支持对比

### 支持的 Agent 列表

| Agent | **cc-connect** | **cursor-remote-control** |
|-------|----------------|---------------------------|
| Claude Code | ✅ | ❌ |
| Cursor Agent | ✅ | ✅（唯一支持） |
| Codex (OpenAI) | ✅ | ❌ |
| Gemini CLI | ✅ | ❌ |
| Qoder CLI | ✅ | ❌ |
| OpenCode | ✅ | ❌ |
| iFlow CLI | ✅ | ❌ |
| Goose | 🔜 计划中 | ❌ |
| Aider | 🔜 计划中 | ❌ |

**优势对比**：
- **cc-connect**：广度优势，7 个 Agent 支持，可在多个 Agent 间切换
- **cursor-remote-control**：深度优势，与 Cursor CLI 深度绑定，集成度高

---

## 📱 平台支持对比

| 平台 | **cc-connect** | **cursor-remote-control** | 连接方式 | 公网 IP 要求 |
|------|----------------|---------------------------|---------|-------------|
| 飞书 (Feishu) | ✅ | ✅ | WebSocket | ❌ 不需要 |
| 钉钉 (DingTalk) | ✅ | ✅ | Stream | ❌ 不需要 |
| 企业微信 (WeCom) | ✅ | ✅ | WebSocket | ❌ 不需要 |
| Telegram | ✅ | ❌ | Long Polling | ❌ 不需要 |
| Slack | ✅ | ❌ | Socket Mode | ❌ 不需要 |
| Discord | ✅ | ❌ | Gateway | ❌ 不需要 |
| LINE | ✅ | ❌ | Webhook | ✅ 需要 |
| QQ (NapCat) | ✅ Beta | ❌ | WebSocket | ❌ 不需要 |
| QQ Bot (官方) | ✅ | ❌ | WebSocket | ❌ 不需要 |

**平台覆盖**：cc-connect 9 个平台 vs cursor-remote-control 3 个平台

---

## 🚀 核心功能对比

### cursor-remote-control 独有优势 🌟

| 功能 | 说明 | 实现文件 | 优势 |
|------|------|---------|------|
| **💾 向量记忆系统** | SQLite + FTS5 + 向量混合搜索 | `shared/memory.ts` | 语义搜索 + 关键词搜索 |
| **📖 三层记忆架构** | 短期/长期/向量记忆 | `shared/memory-tool.ts` | AI 自主检索 |
| **❤️ 心跳系统** | 定期后台维护（整理记忆/检查状态） | `shared/heartbeat.ts` | 自主管理能力 |
| **🍎 Apple Notes 同步** | 集成本地笔记系统 | `shared/sync-apple-notes.ts` | 本地化特性 |
| **🔄 OpenAI API 桥接** | 供 OpenClaw 调用 | `feishu/bridge.ts` | 生态兼容性 |
| **📰 热点新闻推送** | 多平台热榜聚合（微博/知乎/百度） | `shared/news-fetcher.ts` | 本地化特性 |
| **🛜 飞连 VPN 控制** | 远程开关企业 VPN | `shared/feilian-control.ts` | 远程办公场景 |
| **🎙️ 双层语音识别** | 火山引擎 STT → whisper-cpp 降级 | `feishu/server.ts` | 高可用性 |
| **🧠 零提示词污染** | 通过 `.cursor/rules/*.mdc` 自动注入 | 架构设计 | 纯净会话 |

### cc-connect 独有优势 🌟

| 功能 | 说明 | 使用场景 |
|------|------|---------|
| **🔄 多 Agent 编排** | 同一对话中调用多个 Agent 协作 | 复杂任务分工 |
| **⚙️ 运行时切换** | `/model`、`/provider`、`/mode` 即时切换 | 灵活调整 |
| **🔐 权限模式系统** | Default/Force/Plan/Ask 四种模式 | 不同场景适配 |
| **📦 单一二进制** | 零依赖部署，开箱即用 | 快速部署 |
| **🌍 5 语言界面** | 中/英/日/西/繁原生支持 | 国际化 |
| **🔄 自升级功能** | `cc-connect update` 自动更新 | 便捷维护 |
| **🎮 Provider 管理** | 多 API Key 运行时切换 | 配额管理 |
| **📊 流式预览** | 实时更新消息（Telegram/Discord/Feishu） | 即时反馈 |

---

## 📐 架构设计对比

### cursor-remote-control 架构

```
独立多进程模式（平台隔离）
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│ 飞书服务    │  │ 钉钉服务    │  │ 企业微信    │
│ (独立进程)  │  │ (独立进程)  │  │ (独立进程)  │
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │                │                │
       └────────────────┴────────────────┘
                        │
              ┌─────────▼─────────┐
              │   共享模块层       │
              │ - memory.ts       │
              │ - scheduler.ts    │
              │ - heartbeat.ts    │
              │ - news-fetcher.ts │
              └─────────┬─────────┘
                        │
              ┌─────────▼─────────┐
              │  Cursor Agent CLI │
              └───────────────────┘
```

**特点**：
- ✅ 平台隔离，故障不相互影响
- ✅ 独立配置，安全性高
- ✅ 共享模块复用（记忆/定时/心跳）
- ❌ 资源占用较多（3 个进程）

### cc-connect 架构

```
单一进程多项目模式（资源高效）
┌─────────────────────────────────────────────────┐
│                cc-connect 主进程                 │
│  ┌───────────────────────────────────────────┐  │
│  │  项目 1: 飞书 → Claude Code                │  │
│  │  项目 2: 钉钉 → Cursor Agent               │  │
│  │  项目 3: Telegram → Gemini CLI            │  │
│  └───────────────────────────────────────────┘  │
│                                                 │
│  Core Engine (接口定义 + 消息路由)               │
│  ├── Platform Interface                        │
│  ├── Agent Interface                           │
│  └── Session Management                        │
└─────────────────────────────────────────────────┘
         ↓                ↓                ↓
    ┌────────┐      ┌────────┐      ┌────────┐
    │ 飞书    │      │ 钉钉    │      │Telegram│
    │ Plugin │      │ Plugin │      │ Plugin │
    └────────┘      └────────┘      └────────┘
```

**插件化架构原则**：
```
core/          ← 定义接口（Platform, Agent, Session）
├── agent/     ← 各 Agent 实现（自注册）
│   ├── claudecode/
│   ├── cursor/
│   └── gemini/
├── platform/  ← 各平台实现（自注册）
│   ├── feishu/
│   ├── telegram/
│   └── discord/
```

**核心设计规则**：
- `core/` **永远不导入** `agent/` 或 `platform/`
- 依赖方向：`cmd/ → config/, core/, agent/*, platform/*`
- 注册机制：`core.RegisterAgent()` / `core.RegisterPlatform()`
- 能力接口：可选实现（CardSender、ProviderSwitcher 等）

**特点**：
- ✅ 资源高效（单进程）
- ✅ 配置统一（config.toml）
- ✅ 可选编译（按需包含 Agent/Platform）
- ❌ 单点故障风险

---

## 🔧 配置管理对比

### cc-connect 配置（统一管理）

```toml
# 单一 config.toml
[[projects]]
name = "my-backend"

[projects.agent]
type = "cursor"
[projects.agent.options]
work_dir = "/path/to/project"
mode = "default"
provider = "anthropic"

[[projects.agent.providers]]
name = "anthropic"
api_key = "sk-ant-xxx"

[[projects.agent.providers]]
name = "relay"
api_key = "sk-xxx"
base_url = "https://api.relay-service.com"
model = "claude-sonnet-4-20250514"

[[projects.platforms]]
type = "feishu"
[projects.platforms.options]
app_id = "cli_xxx"
app_secret = "xxx"
```

**优势**：
- ✅ 集中管理，全局视野
- ✅ 多项目统一配置
- ✅ Provider 管理清晰

### cursor-remote-control 配置（分散管理）

```
feishu/.env           → 飞书凭据
dingtalk/.env         → 钉钉凭据
wecom/.env            → 企业微信凭据
projects.json         → 项目路由（共享）
cron-jobs-feishu.json → 飞书定时任务
cron-jobs-dingtalk.json → 钉钉定时任务
cron-jobs-wecom.json  → 企业微信定时任务
```

**优势**：
- ✅ 凭据隔离，安全性高
- ✅ 服务独立部署
- ❌ 配置分散，维护成本高

---

## 💡 值得借鉴的 8 大特性

### 1. 权限模式系统 🔐

**cc-connect 实现**：

```toml
[projects.agent.options]
mode = "default"  # default/force/plan/ask
```

**运行时切换**：
```
/mode              # 显示当前和可用模式
/mode yolo         # 切换到 YOLO 模式（全部自动批准）
/mode plan         # 切换到 Plan 模式（只读分析）
/mode ask          # 切换到 Ask 模式（问答式）
/mode default      # 切换回默认模式
```

**4 种模式对比**：

| 模式 | 配置值 | 行为 | 适用场景 |
|------|--------|------|---------|
| Default | `default` | 信任工作区，工具调用前询问 | 日常开发 |
| Force (YOLO) | `force` / `yolo` | 全部自动批准 | 紧急修复、自动化任务 |
| Plan | `plan` | 只读分析，不执行 | 代码审查、架构规划 |
| Ask | `ask` | 问答模式，只读 | 学习探索、代码理解 |

**借鉴建议**：
- 为 cursor-remote-control 实现类似的模式切换
- 在飞书/钉钉对话中支持 `/模式` 命令
- 无需重启服务即可切换

---

### 2. Provider 多提供商管理 🔄

**cc-connect 实现**：

```toml
[[projects.agent.providers]]
name = "anthropic"
api_key = "sk-ant-xxx"

[[projects.agent.providers]]
name = "relay"
api_key = "sk-xxx"
base_url = "https://api.relay-service.com"
model = "claude-sonnet-4-20250514"

[[projects.agent.providers]]
name = "minimax"
api_key = "your-minimax-api-key"
base_url = "https://api.minimax.io/v1"
model = "MiniMax-M2.7"
thinking = "disabled"  # 不支持 thinking 的 Provider 自动改写
```

**运行时切换**：
```
/provider                   # 显示当前 Provider
/provider list              # 列出所有配置的 Provider
/provider switch relay      # 切换到 relay
/provider relay             # 快捷切换
```

**核心特性**：
- ✅ 支持多个 API Key（工作/个人账号分离）
- ✅ 支持自定义 base_url（中转服务）
- ✅ `thinking = "disabled"` 自动改写请求（兼容性）
- ✅ 环境变量动态注入（`env` 字段支持 Bedrock/Vertex）

**借鉴建议**：
- cursor-remote-control 当前只支持单一 API Key
- 实现 Provider 管理，支持配额管理和账号切换
- 无需重启服务即可切换

---

### 3. Model 模型选择 🤖

**cc-connect 实现**：

```toml
[[projects.agent.providers.models]]
model = "claude-sonnet-4-20250514"
alias = "sonnet"

[[projects.agent.providers.models]]
model = "claude-opus-4-20250514"
alias = "opus"

[[projects.agent.providers.models]]
model = "claude-haiku-3-5-20241022"
alias = "haiku"
```

**运行时切换**：
```
/model              # 列出所有可用模型（格式：alias - model）
/model sonnet       # 通过别名切换
/model claude-opus-4-20250514  # 通过完整名称切换
```

**核心特性**：
- ✅ 别名系统（`sonnet` 比输入全名简单）
- ✅ 无需 API 调用即可列出模型（预配置）
- ✅ 支持回退到 API 动态获取（未配置时）

**借鉴建议**：
- cursor-remote-control 当前在 `.env` 中硬编码 `CURSOR_MODEL`
- 实现别名系统和运行时切换
- 配置化模型列表

---

### 4. Claude Code Router 集成 🚀

**cc-connect 实现**：

```toml
[projects.agent.options]
router_url = "http://127.0.0.1:3456"
router_api_key = "your-secret-key"  # 可选
```

**自动行为**：
- 设置 `ANTHROPIC_BASE_URL` 到 router_url
- 设置 `NO_PROXY=127.0.0.1` 防止代理干扰
- 禁用 telemetry 和 cost warnings

**支持的 Router 功能**：
- 模型路由（DeepSeek/国产模型）
- 请求转换（适配不同 Provider）
- 负载均衡

**借鉴建议**：
- cursor-remote-control 可支持 Router 集成
- 扩展模型选择范围（DeepSeek、国产模型）

---

### 5. 附件回传机制 📎

**cc-connect 实现**：

```bash
# Agent 生成图表后，主动发送到聊天
cc-connect send --image /absolute/path/to/chart.png

# 发送 PDF 报告
cc-connect send --file /absolute/path/to/report.pdf

# 同时发送文件和图片
cc-connect send --file report.pdf --image chart.png --message "分析完成"
```

**配置开关**：
```toml
attachment_send = "on"  # 全局开关，独立于 /mode
```

**自动注入指令**：
```
/bind setup   # 将附件发送指令写入 Agent 系统提示词
/cron setup   # 同上
```

**核心特性**：
- ✅ Agent 主动推送能力
- ✅ 全局开关控制（安全性）
- ✅ 多附件类型支持（图片/文件）
- ✅ 可选消息文本（`--message`）

**借鉴建议**：
- cursor-remote-control 有类似的 `/发送文件` 命令，但方向相反（用户主动）
- 实现 Agent 主动推送设计
- 支持生成的图表/报告自动发送

---

### 6. 会话管理系统 📂

**cc-connect 实现**：

```
/new [name]       # 创建新会话（可命名）
/list             # 列出所有会话
/switch <id>      # 切换会话
/current          # 显示当前会话信息
/history [n]      # 显示最近 n 条消息（默认 10）
/usage            # 显示配额使用情况
```

**会话持久化**：
```toml
data_dir = "/path/to/custom/dir"  # 默认 ~/.cc-connect
```

**核心特性**：
- ✅ 多会话并行（每个会话独立上下文）
- ✅ 会话命名（提升可识别性）
- ✅ 历史记录查询（`/history`）
- ✅ 配额统计（`/usage`）

**借鉴建议**：
- cursor-remote-control 当前每个项目只有一个会话
- 实现多会话支持（修复/开发/审查并行）
- 支持会话命名和历史查询

---

### 7. 心跳系统改进 ❤️

**cc-connect 心跳系统**：

```toml
[projects.heartbeat]
enabled = true
interval_mins = 30           # 每 30 分钟触发
session_key = "telegram:123:123"  # 指定目标会话
only_when_idle = true         # 会话空闲时才触发 ⭐
silent = true                 # 不发送通知 ⭐
timeout_mins = 30             # 超时时间
prompt = "check inbox and tasks"  # 显式提示词
```

**两种模式**：
1. **显式提示词**：直接在配置中写 `prompt`
2. **读取文件**：留空 `prompt`，自动读取 `HEARTBEAT.md`

**与 Cron 的区别**：

| 特性 | Heartbeat | Cron |
|------|-----------|------|
| 上下文 | 共享主会话上下文 | 独立任务 |
| 触发时机 | 固定间隔（可跳过） | 精确调度 |
| 适用场景 | 状态监控、继续工作 | 定时报告 |

**借鉴建议**：
- cursor-remote-control 的心跳系统可增加 `only_when_idle` 判断
- 支持 `silent` 模式（不发通知）
- 支持 `session_key` 指定目标会话（多会话支持）

---

### 8. 定时任务改进 ⏰

**cc-connect Cron 系统**：

```
/cron                                          # 列出所有任务
/cron add 0 6 * * * 每天推送 GitHub Trending      # 创建任务
/cron del <id>                                 # 删除任务
/cron enable <id>                              # 启用任务
/cron disable <id>                             # 禁用任务
```

**配置选项**：
```toml
[cron]
silent = false  # 静默模式：不发送"⏰ 任务开始"通知
```

**自然语言支持**（仅 Claude Code）：
> "每天早上 6 点推送 GitHub Trending"

Claude Code 自动创建 Cron 任务。

**借鉴建议**：
- cursor-remote-control 的任务命令可统一为 `/cron` 前缀
- 支持 `silent` 模式（减少打扰）
- 简化命令语法

---

## 📊 记忆系统对比

### cursor-remote-control - 三层记忆系统 🎯

```
├── 短期记忆 (.cursor/sessions/*.jsonl)
│   └── Cursor 原生会话转录
├── 长期记忆 (.cursor/MEMORY.md + memory/日记/)
│   └── 人工整理的关键信息
└── 向量记忆 (.memory.sqlite)
    ├── FTS5 全文搜索（BM25 算法）
    ├── 向量相似度搜索
    └── 混合排序（BM25 + Cosine）
```

**核心能力**：
- ✅ 自主检索（AI 通过 `memory-tool.ts` CLI 自主决定何时搜索）
- ✅ 增量索引（仅对变化文件重新索引）
- ✅ Embedding 缓存（相同文本不重复调 API）
- ✅ 混合搜索（关键词 + 语义）

### cc-connect - 基础记忆

```
基于 Cursor CLI 原生的 --resume 机制
会话数据存储在 ~/.cc-connect/sessions/
无独立记忆系统
```

**结论**：cursor-remote-control 在记忆系统深度上有显著优势，这是核心竞争力。

---

## 🎯 改进建议与优先级

### 🥇 优先级 1 - 运行时切换能力（2-3 天）

**目标**：无需重启服务即可切换模型/模式/Provider

**实现步骤**：
1. 实现 `/model`, `/mode`, `/provider` 命令解析
2. 动态修改环境变量（`CURSOR_MODEL` 等）
3. 重启 Cursor Agent 进程（保持服务进程运行）

**预期收益**：
- ✅ 用户体验大幅提升
- ✅ 灵活应对不同场景（开发/审查/紧急）

---

### 🥈 优先级 2 - Provider 管理（1 周）

**目标**：支持多个 API Key 和 Provider

**实现步骤**：
1. 扩展 `.env` 配置支持多 Provider
2. 实现 Provider 切换逻辑
3. 支持自定义 base_url（中转服务）

**配置示例**：
```bash
# .env
CURSOR_PROVIDERS='[
  {"name":"work","apiKey":"sk-ant-xxx"},
  {"name":"personal","apiKey":"sk-ant-yyy","baseUrl":"https://api.relay.com"}
]'
CURSOR_ACTIVE_PROVIDER="work"
```

**预期收益**：
- ✅ 工作/个人账号分离
- ✅ 配额管理更灵活
- ✅ 支持中转服务

---

### 🥉 优先级 3 - 权限模式（3-5 天）

**目标**：实现 4 种权限模式

**实现步骤**：
1. 封装 Cursor Agent 启动参数
2. 实现模式映射（`default` → Cursor CLI 参数）
3. 支持运行时切换

**模式映射**：
```typescript
const modeMap = {
  default: [],  // 默认参数
  force: ["--force"],  // YOLO 模式
  plan: ["--plan"],  // Plan 模式
  ask: ["--ask"]  // Ask 模式
};
```

**预期收益**：
- ✅ 不同场景适配
- ✅ 提升工作效率
- ✅ 紧急修复快速切换

---

### 4️⃣ 优先级 4 - 附件回传（3-5 天）

**目标**：Agent 生成图表/报告后自动推送

**实现步骤**：
1. 创建 `send-attachment.ts` CLI 工具
2. 在 `.cursor/rules/` 中注入附件发送指令
3. 支持 `--image` 和 `--file` 参数

**使用示例**：
```bash
# Agent 调用
bun run ~/cursor-remote-control/shared/send-attachment.ts \
  --image /path/to/chart.png \
  --message "分析完成"
```

**预期收益**：
- ✅ Agent 主动推送能力
- ✅ 图表/报告自动发送
- ✅ 用户体验提升

---

### 5️⃣ 优先级 5 - 会话管理（1-2 周）

**目标**：支持多会话并行

**实现步骤**：
1. 扩展会话存储结构（支持多会话）
2. 实现会话命名和切换
3. 支持会话历史查询

**数据结构**：
```typescript
interface Session {
  id: string;
  name?: string;  // 可选命名
  projectKey: string;
  agentId: string;
  createdAt: number;
  lastActiveAt: number;
}
```

**预期收益**：
- ✅ 多任务并行
- ✅ 上下文不混淆
- ✅ 会话可追溯

---

## 📐 架构演进建议

### 短期（保持现状）

**保持多进程架构的理由**：
- ✅ 平台隔离，安全性高
- ✅ 独立部署，故障隔离
- ✅ 改动成本低

### 中期（渐进式改进）

**可选改进方向**：
1. **统一配置文件**：`projects.json` + `.env` 合并为 `config.toml`
2. **共享模块增强**：提取更多公共逻辑到 `shared/`
3. **插件化改造**：参考 cc-connect 的注册机制

### 长期（可选重构）

**如果未来要支持更多平台/Agent**：
- 考虑插件化架构（Go 重写或 TypeScript 插件系统）
- 单进程多项目模式（资源效率）
- 但短期内不建议，因为：
  - 当前架构满足需求
  - 重构成本高
  - 独有优势（记忆系统）不受架构影响

---

## 🎯 总结：两个项目的互补关系

| 维度 | **cc-connect** | **cursor-remote-control** | 建议 |
|------|----------------|---------------------------|------|
| **广度** | ⭐⭐⭐⭐⭐ 7 Agent + 9 平台 | ⭐⭐ 1 Agent + 3 平台 | 保持专注 Cursor |
| **深度** | ⭐⭐⭐ 基础功能 | ⭐⭐⭐⭐⭐ 向量记忆/心跳系统 | **继续深耕** |
| **易用性** | ⭐⭐⭐⭐⭐ npm 一键安装 | ⭐⭐⭐ 手动配置 | 借鉴部署方式 |
| **灵活性** | ⭐⭐⭐⭐⭐ 运行时热切换 | ⭐⭐ 重启切换 | **核心改进点** ⭐ |
| **本地化** | ⭐⭐ 国际化 | ⭐⭐⭐⭐⭐ 飞连/热榜/Apple Notes | **保持优势** ⭐ |

---

## 🚀 行动计划

### 第一阶段（1-2 周）：核心功能增强
- [ ] 实现 `/model`, `/mode`, `/provider` 命令
- [ ] 支持运行时切换（无需重启服务）
- [ ] 配置文件扩展（支持多 Provider）

### 第二阶段（2-3 周）：权限与附件
- [ ] 实现 4 种权限模式
- [ ] 实现 Agent 附件回传
- [ ] 支持自定义 base_url

### 第三阶段（4 周+）：会话与架构
- [ ] 多会话支持
- [ ] 会话命名和历史查询
- [ ] 可选：配置文件统一

### 持续改进
- [ ] 参考 cc-connect 的用户体验设计
- [ ] 保持独有优势（记忆系统、本地化特性）
- [ ] 定期同步 cc-connect 新特性

---

## 🔗 参考资源

- **cc-connect 项目**：https://github.com/chenhg5/cc-connect
- **cc-connect 文档**：https://github.com/chenhg5/cc-connect/blob/main/docs/usage.md
- **Claude Code Router**：https://github.com/musistudio/claude-code-router
- **Cursor Agent CLI**：https://cursor.com/docs/cli

---

## 📝 文档维护

- **最后更新**：2026-03-19
- **维护者**：项目团队
- **审查周期**：每季度一次（或 cc-connect 重大更新时）

---

**核心原则**：借鉴优秀设计，保持独特优势，专注 Cursor 深度集成。
