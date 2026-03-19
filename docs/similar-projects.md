# IM to AI Agent 生态项目图谱

> 文档创建时间：2026-03-19  
> 更新周期：每季度或重大项目发布时

---

## 📋 文档目的

本文档收集和分析 IM（即时通讯）到 AI Agent 桥接领域的相关开源项目，为 cursor-remote-control 项目提供生态参考和技术借鉴。

---

## 🌍 生态全景图

```
┌─────────────────── IM to AI Agent 生态 ────────────────────┐
│                                                            │
│  🌐 通用框架层（多平台 + 多 Agent）                          │
│  ├── cc-connect (Go, 9平台, 7 Agent) ⭐⭐⭐⭐⭐             │
│  ├── OpenAB (配置驱动, Telegram/Discord)                    │
│  └── LettaBot (跨平台记忆, 通用助手)                        │
│                                                            │
│  📱 Telegram 专注层                                         │
│  ├── TeleCode (语音转代码)                                 │
│  ├── Claudegram (Node.js, 功能完整) ⭐⭐⭐⭐                │
│  ├── TurboClaw (TypeScript+Bun, 多Agent编排) ⭐⭐⭐⭐⭐      │
│  ├── cursor-tg (Cursor Cloud API)                         │
│  ├── MCP Telegram (MCP协议) ⭐⭐⭐                          │
│  └── claude-telegram-bot-bridge (Python, 轻量)            │
│                                                            │
│  🏢 飞书/企业 IM 层                                         │
│  ├── OpenClaw (开源框架)                                   │
│  ├── AutoClaw (50+ 技能) ⭐⭐⭐⭐                           │
│  ├── feishu-cursor-claw (cursor-remote-control 基于此)    │
│  ├── cursor-remote-control (向量记忆+心跳) ⭐⭐⭐⭐⭐        │
│  └── ClawdBot (团队协作)                                   │
│                                                            │
│  🤖 企业自动化层                                            │
│  └── Cursor Automations (官方, 事件驱动)                   │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

---

## 📱 Telegram 专注型项目

### TeleCode - 语音转代码控制

**基本信息**：
- 官网：https://telecodebot.com/
- 开源：MIT License
- 特色：零 API 成本

**核心功能**：
- ✅ 语音控制 Cursor AI
- ✅ 语音笔记自动转录
- ✅ 实时截图反馈
- ✅ 与现有 Cursor 计划集成
- ✅ 完全开源

**技术特点**：
- 语音输入 → Cursor 执行 → 截图反馈
- 零额外 API 成本（使用现有 Cursor 配额）
- 专注语音交互场景

**适用场景**：
- 开车时语音编码
- 移动办公场景
- 语音驱动开发

---

### Claudegram - 全功能 Telegram 桥接

**基本信息**：
- 官网：https://claudegram.com/
- 语言：Node.js
- 成熟度：⭐⭐⭐⭐

**核心功能**：
- ✅ Claude Code via Telegram
- ✅ 实时流式输出
- ✅ 语音转文字 (STT)
- ✅ 文字转语音 (TTS)
- ✅ 文件双向传输
- ✅ 会话持久化
- ✅ 模型动态切换
- ✅ 终端 UI 模式
- ✅ 媒体提取

**技术特点**：
- 完整的语音支持（输入 + 输出）
- 运行时模型切换
- 多种交互模式（聊天/终端）
- 媒体文件智能处理

**值得借鉴**：
- ✅ 模型切换机制
- ✅ 语音 TTS 回复
- ✅ 终端 UI 模式设计

---

### TurboClaw - TypeScript + Bun 多 Agent 编排 🌟

**基本信息**：
- GitHub：https://github.com/ikmolbo/TurboClaw
- 语言：TypeScript + Bun
- 特色：**与 cursor-remote-control 同技术栈**

**核心功能**：
- ✅ 多 Claude Code Agent 编排
- ✅ 定时任务系统
- ✅ 记忆持久化
- ✅ 语音转录
- ✅ 技能系统 (Skills)
- ✅ 轻量高效（适合低配硬件）

**技术特点**：
- TypeScript + Bun（与本项目相同）
- Agent 编排和调度
- 技能模块化设计
- 资源占用优化

**重点关注** ⭐：
- ✅ **同技术栈，值得深度学习**
- ✅ 研究其技能系统设计
- ✅ 学习多 Agent 编排实现
- ✅ 对比记忆系统差异

---

### cursor-tg - Cursor Cloud API 集成

**基本信息**：
- GitHub：https://github.com/tb5z035i/cursor-tg
- 特色：Cursor Cloud Agents API

**核心功能**：
- ✅ Telegram → Cursor Cloud Agents API
- ✅ Agent 创建和管理
- ✅ PR 查看和管理
- ✅ Diff 查看
- ✅ 跟进消息发送
- ✅ 状态监控

**技术特点**：
- 直接调用 Cursor Cloud API
- 不依赖本地 Cursor CLI
- 云端 Agent 管理

**适用场景**：
- Cursor Cloud 用户
- 团队协作场景
- 无需本地环境

---

### MCP Telegram - MCP 协议集成

**基本信息**：
- GitHub：https://github.com/antongsm/mcp-telegram
- 特色：Model Context Protocol (MCP)

**核心功能**：
- ✅ MCP 协议服务器
- ✅ Claude Code 和 Cursor 支持
- ✅ MTProto（个人账号）+ Bot API
- ✅ 守护进程架构
- ✅ 双向通信
- ✅ CLI/HTTP API 接口

**技术特点**：
- 基于 MCP 协议标准化
- 支持个人 Telegram 账号
- 守护进程常驻
- 多种调用方式（CLI/HTTP）

**值得借鉴**：
- ⚠️ MCP 协议集成思路
- ⚠️ 守护进程架构设计
- ⚠️ 多接口暴露方式

---

### claude-telegram-bot-bridge - 轻量级桥接

**基本信息**：
- GitHub：https://github.com/terranc/claude-telegram-bot-bridge
- 语言：Python
- 特色：轻量级、自动启动

**核心功能**：
- ✅ Claude Code 到本地文件夹桥接
- ✅ 自动启动支持
- ✅ 远程移动开发

**技术特点**：
- Python 实现，依赖少
- 自动启动机制
- 轻量级部署

**适用场景**：
- 个人开发
- 快速部署
- 移动办公

---

## 🌐 多平台通用型框架

### cc-connect - Go 多平台多 Agent 框架 🌟

**基本信息**：
- GitHub：https://github.com/chenhg5/cc-connect
- 语言：Go 1.22+
- 版本：v1.2.1
- 成熟度：⭐⭐⭐⭐⭐

**支持平台**（9 个）：
- ✅ 飞书 (Feishu/Lark) - WebSocket
- ✅ 钉钉 (DingTalk) - Stream
- ✅ 企业微信 (WeCom) - WebSocket
- ✅ Telegram - Long Polling
- ✅ Slack - Socket Mode
- ✅ Discord - Gateway
- ✅ LINE - Webhook
- ✅ QQ (NapCat) - WebSocket Beta
- ✅ QQ Bot (官方) - WebSocket

**支持 Agent**（7 个）：
- ✅ Claude Code
- ✅ Cursor Agent
- ✅ Codex (OpenAI)
- ✅ Gemini CLI
- ✅ Qoder CLI
- ✅ OpenCode
- ✅ iFlow CLI
- 🔜 Goose、Aider（计划中）

**核心功能**：
- ✅ 单一二进制文件部署
- ✅ 单进程多项目架构
- ✅ 运行时模式切换（/mode）
- ✅ 运行时模型切换（/model）
- ✅ Provider 管理（/provider）
- ✅ 多 Agent 编排（Multi-Bot Relay）
- ✅ 权限模式系统（4 种模式）
- ✅ 会话管理（命名/切换/历史）
- ✅ 定时任务（Cron）
- ✅ 心跳系统（Heartbeat）
- ✅ 语音转文字（STT）
- ✅ 文字转语音（TTS）
- ✅ 附件回传
- ✅ Claude Code Router 集成
- ✅ 自升级功能
- ✅ 5 语言界面（中/英/日/西/繁）

**技术特点**：
- Go 单一二进制（10-20MB）
- 插件化架构（core/agent/platform）
- 配置驱动（config.toml）
- 零运行时依赖
- 可选编译（按需包含 Agent/Platform）

**详细分析**：
- 参见：[docs/cc-connect-comparison.md](./cc-connect-comparison.md)

**值得借鉴** ⭐：
- ✅ 运行时切换机制
- ✅ Provider 管理系统
- ✅ 权限模式设计
- ✅ 会话管理功能
- ✅ 插件化架构思路

---

### OpenAB - Open Agent Bridge

**基本信息**：
- GitHub：https://github.com/xx025/openab
- 语言：配置驱动
- 创建：2026 年 2 月
- 开源：MIT License

**核心功能**：
- ✅ 单一配置管理多平台
- ✅ Telegram 支持
- ✅ Discord 支持
- ✅ HTTP API 接口
- ✅ Cursor Agent 支持
- ✅ Codex Agent 支持

**技术特点**：
- 配置驱动架构
- 统一配置多平台
- 轻量级实现

**适用场景**：
- 简单桥接需求
- 配置化部署
- 快速原型

---

### LettaBot - 跨平台通用助手

**基本信息**：
- GitHub：https://github.com/letta-ai/lettabot
- 特色：跨平台持久记忆

**支持平台**（5 个）：
- ✅ Telegram
- ✅ Slack
- ✅ Discord
- ✅ WhatsApp
- ✅ Signal

**核心功能**：
- ✅ 跨平台持久记忆
- ✅ 本地工具执行
- ✅ 通用 AI 助手

**技术特点**：
- 统一记忆层
- 多平台同步
- 工具执行能力

**注意**：
- ⚠️ 通用型助手（非专注编码）
- ⚠️ 架构可参考，但功能定位不同

---

## 🏢 飞书/企业 IM 专注型项目

### OpenClaw - 开源 AI 助手框架

**基本信息**：
- 官网：https://openclawcn.com/
- GitHub：https://github.com/larksuite/openclaw-lark
- 特色：飞书官方支持

**核心功能**：
- ✅ WebSocket 事件订阅
- ✅ 开源 AI 助手框架
- ✅ 原生飞书集成
- ✅ OAuth 和权限自动化

**技术特点**：
- WebSocket 长连接（比 Webhook 可靠）
- 官方维护
- 标准化接口

**适用场景**：
- 飞书企业用户
- 需要官方支持
- 标准化集成

---

### AutoClaw - 企业级 AI 部署平台

**基本信息**：
- 官网：https://autoclaws.org/im-integration/
- 支持：飞书/钉钉/企业微信/QQ
- 成熟度：⭐⭐⭐⭐

**支持平台**（4 个）：
- ✅ 飞书 (Feishu)
- ✅ 钉钉 (DingTalk)
- ✅ 企业微信 (WeCom)
- ✅ QQ

**核心功能**：
- ✅ 50+ 预置技能
- ✅ 一键部署
- ✅ 交互式卡片 UI
- ✅ 实时状态更新
- ✅ 确认按钮交互
- ✅ 流式响应
- ✅ OAuth 自动化
- ✅ 权限管理

**技术特点**：
- 企业级解决方案
- 丰富技能库
- 标准化部署
- 生产级可用

**值得借鉴**：
- ⚠️ 技能库设计思路
- ⚠️ 企业级部署方案
- ⚠️ 交互式卡片设计

---

### feishu-cursor-claw - 飞书 Cursor 远程控制

**基本信息**：
- GitHub：https://github.com/nongjun/feishu-cursor-claw
- 创建：2025 年 3 月
- 特色：**cursor-remote-control 基于此项目改进**

**核心功能**：
- ✅ 飞书远程控制 Cursor IDE
- ✅ 多模态输入（文字/语音/图片）
- ✅ 流式进度卡片
- ✅ 会话连续性
- ✅ WebSocket 长连接

**技术特点**：
- 飞书 WebSocket SDK
- Volcengine STT + whisper 降级
- 实时卡片更新
- 会话自动恢复

**历史意义**：
- 本项目的起点
- 已在此基础上大幅扩展
- 开源社区贡献

---

### ClawdBot - 团队协作助手

**基本信息**：
- 发布：2026 年 1 月
- 平台：飞书/Lark
- 介绍：Medium 文章

**核心功能**：
- ✅ 团队级 AI 助手
- ✅ 计算机控制能力
- ✅ 24/7 在线服务

**技术特点**：
- 团队协作优化
- 持续在线
- 计算机控制

**适用场景**：
- 团队协作
- 企业部署
- 7x24 服务

---

### cursor-remote-control（本项目）🌟

**基本信息**：
- 位置：本项目
- 语言：TypeScript + Bun
- 基于：feishu-cursor-claw 改进

**支持平台**（3 个）：
- ✅ 飞书 (Feishu) - WebSocket
- ✅ 钉钉 (DingTalk) - Stream
- ✅ 企业微信 (WeCom) - WebSocket

**支持 Agent**（1 个）：
- ✅ Cursor Agent CLI（深度集成）

**独有优势** ⭐：

#### 1. 三层记忆系统
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

#### 2. 心跳系统
- 定期后台维护
- 自主检查状态
- 整理记忆
- 继续未完成工作

#### 3. 本地化特性
- 🛜 飞连 VPN 远程控制
- 📰 热点新闻推送（微博/知乎/百度）
- 🍎 Apple Notes 同步
- 🇨🇳 中国场景优化

#### 4. 其他特性
- ✅ 项目路由（多工作区）
- ✅ 定时任务（AI 创建）
- ✅ 双层语音识别（Volcengine + whisper）
- ✅ 零提示词污染（.cursor/rules/ 自动注入）
- ✅ OpenAI API 桥接（供 OpenClaw 调用）

**架构特点**：
- 多进程独立部署（平台隔离）
- 共享模块复用（memory/scheduler/heartbeat）
- macOS launchd 服务管理
- 本地源码直接运行

---

## 🤖 企业自动化层

### Cursor Automations - 官方自动化工具

**基本信息**：
- 发布：2026 年 3 月
- 提供商：Cursor 官方
- 类型：Agentic Coding Tool

**核心功能**：
- ✅ 事件驱动开发任务
- ✅ Slack 消息触发
- ✅ Git commit 触发
- ✅ 定时任务触发
- ✅ 自动创建 PR
- ✅ Slack 线程报告

**技术特点**：
- 从手动提示到策略驱动
- 自动化工作流
- 官方集成

**适用场景**：
- CI/CD 集成
- 代码审查自动化
- 定期任务执行

**与本项目关系**：
- ⚠️ 官方工具，可作为补充
- ⚠️ 探索集成可能性

---

## 📊 项目对比矩阵

### 按技术栈分类

| 项目 | 语言 | 运行时 | 部署方式 | 配置方式 |
|------|------|--------|---------|---------|
| cc-connect | Go | 单一二进制 | npm/二进制 | config.toml |
| TurboClaw | TypeScript | Bun | 源码 | 配置文件 |
| cursor-remote-control | TypeScript | Bun | 源码 | .env + JSON |
| Claudegram | Node.js | Node | npm/源码 | 配置文件 |
| OpenAB | - | 配置驱动 | 配置 | YAML |
| MCP Telegram | - | 守护进程 | - | 配置文件 |
| claude-telegram-bot-bridge | Python | Python | pip/源码 | 环境变量 |

### 按平台支持分类

| 项目 | 飞书 | 钉钉 | 企业微信 | Telegram | Slack | Discord | 其他 |
|------|------|------|---------|----------|-------|---------|------|
| cc-connect | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | LINE/QQ |
| cursor-remote-control | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| TurboClaw | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Claudegram | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| OpenAB | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ | HTTP |
| AutoClaw | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | QQ |
| LettaBot | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | WhatsApp/Signal |

### 按 Agent 支持分类

| 项目 | Cursor | Claude Code | Codex | Gemini | 其他 | 总数 |
|------|--------|-------------|-------|--------|------|------|
| cc-connect | ✅ | ✅ | ✅ | ✅ | Qoder/OpenCode/iFlow | 7 |
| cursor-remote-control | ✅ | ❌ | ❌ | ❌ | ❌ | 1 |
| TurboClaw | ❌ | ✅ | ❌ | ❌ | ❌ | 1 |
| Claudegram | ❌ | ✅ | ❌ | ❌ | ❌ | 1 |
| OpenAB | ✅ | ❌ | ✅ | ❌ | ❌ | 2 |
| MCP Telegram | ✅ | ✅ | ❌ | ❌ | ❌ | 2 |

### 按功能特性分类

| 功能 | cc-connect | cursor-remote-control | TurboClaw | Claudegram | OpenClaw |
|------|-----------|----------------------|-----------|-----------|----------|
| **会话管理** | ✅ 多会话 | ✅ 单会话 | ✅ 多会话 | ✅ 持久化 | ✅ 基础 |
| **记忆系统** | ❌ | ✅ 三层记忆 | ✅ 持久化 | ❌ | ❌ |
| **向量搜索** | ❌ | ✅ | ❌ | ❌ | ❌ |
| **心跳系统** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **定时任务** | ✅ | ✅ | ✅ | ❌ | ❌ |
| **语音输入** | ✅ STT | ✅ STT | ✅ STT | ✅ STT | ❌ |
| **语音输出** | ✅ TTS | ❌ | ❌ | ✅ TTS | ❌ |
| **模型切换** | ✅ 运行时 | ❌ | ❌ | ✅ 运行时 | ❌ |
| **权限模式** | ✅ 4种 | ❌ | ❌ | ❌ | ❌ |
| **Provider管理** | ✅ 多Provider | ❌ | ❌ | ❌ | ❌ |
| **附件回传** | ✅ | ❌ | ❌ | ✅ | ❌ |
| **多Agent编排** | ✅ | ❌ | ✅ | ❌ | ❌ |
| **技能系统** | ❌ | ❌ | ✅ | ❌ | ✅ 50+ |

---

## 🎯 cursor-remote-control 在生态中的定位

### 优势领域 🌟

| 维度 | 优势 | 对比 |
|------|------|------|
| **记忆深度** | ⭐⭐⭐⭐⭐ 三层记忆 + 向量搜索 | 生态中唯一 |
| **自主性** | ⭐⭐⭐⭐⭐ 心跳系统 + 自主检索 | 接近 cc-connect |
| **本地化** | ⭐⭐⭐⭐⭐ 飞连/热榜/Apple Notes | 中国场景最优 |
| **Cursor 深度** | ⭐⭐⭐⭐⭐ 唯一深度集成 | 专注单一 Agent |
| **企业 IM** | ⭐⭐⭐⭐ 飞书/钉钉/企业微信 | 与 AutoClaw 相当 |

### 改进空间 ⚠️

| 维度 | 当前 | 生态最佳 | 差距 |
|------|------|---------|------|
| **运行时切换** | ❌ 需重启 | cc-connect/Claudegram | 关键差距 |
| **平台广度** | 3 个平台 | cc-connect 9 个 | 可选改进 |
| **Agent 广度** | 1 个 Agent | cc-connect 7 个 | 不改进（专注） |
| **语音输出** | ❌ 无 TTS | Claudegram/cc-connect | 可选改进 |
| **附件回传** | ❌ 无 | cc-connect/Claudegram | 可借鉴 |
| **部署便捷** | ⭐⭐⭐ 手动配置 | cc-connect npm 一键 | 可优化 |

---

## 🚀 学习和改进建议

### 🥇 优先级 1：重点研究项目

#### TurboClaw - 同技术栈深度学习

**为什么优先**：
- ✅ TypeScript + Bun（与本项目相同）
- ✅ 多 Agent 编排（可借鉴）
- ✅ 技能系统设计（模块化）
- ✅ 记忆持久化（对比分析）

**学习重点**：
1. 技能系统架构设计
2. 多 Agent 编排实现
3. 记忆系统实现差异
4. 轻量化优化技巧

**行动计划**：
- [ ] 克隆仓库深入研究源码
- [ ] 分析技能系统设计文档
- [ ] 对比记忆系统实现
- [ ] 提炼可借鉴的设计模式

---

#### cc-connect - 持续跟踪更新

**为什么优先**：
- ✅ 已完成详细对比分析
- ✅ 运行时切换机制成熟
- ✅ Provider 管理值得借鉴
- ✅ 权限模式设计完善

**学习重点**：
1. 运行时切换实现（无需重启）
2. Provider 管理架构
3. 权限模式系统
4. 插件化架构思路

**行动计划**：
- [x] 完成详细对比文档（docs/cc-connect-comparison.md）
- [ ] 定期同步新特性（每季度）
- [ ] 实现运行时切换（优先级最高）
- [ ] 参考 Provider 管理设计

---

### 🥈 优先级 2：功能参考项目

#### Claudegram - 语音和模型切换

**学习重点**：
1. 模型切换实现机制
2. TTS 语音回复功能
3. 终端 UI 模式设计
4. 文件传输优化

**可借鉴功能**：
- ⚠️ TTS 语音回复（可选特性）
- ⚠️ 运行时模型切换（核心特性）
- ⚠️ 多模式交互设计

---

#### MCP Telegram - MCP 协议

**学习重点**：
1. MCP 协议集成方式
2. 守护进程架构
3. CLI/HTTP API 设计
4. 双向通信机制

**可借鉴功能**：
- ⚠️ MCP 协议集成（长期考虑）
- ⚠️ 多接口暴露方式
- ⚠️ 守护进程架构

---

### 🥉 优先级 3：生态参考项目

#### AutoClaw - 企业级部署

**学习重点**：
1. 50+ 技能库设计
2. 企业级部署方案
3. OAuth 自动化
4. 交互式卡片设计

**可借鉴功能**：
- ⚠️ 技能库模块化（长期）
- ⚠️ 企业级部署流程
- ⚠️ 权限管理方案

---

#### OpenClaw - 标准化集成

**学习重点**：
1. WebSocket 标准化
2. 官方 SDK 使用
3. OAuth 流程
4. 权限管理

**参考价值**：
- ⚠️ 标准化实践
- ⚠️ 官方推荐方案

---

### 🎯 优先级 4：生态观察项目

以下项目作为生态观察，了解发展趋势：

- **TeleCode**：语音交互场景
- **cursor-tg**：Cursor Cloud API 集成
- **OpenAB**：配置驱动架构
- **LettaBot**：跨平台记忆
- **Cursor Automations**：官方自动化

---

## 📅 学习和改进路线图

### 第一阶段（1-2 周）：深度研究

**目标**：深入研究 TurboClaw 和 cc-connect

**任务清单**：
- [ ] 克隆 TurboClaw 仓库，研究源码
- [ ] 分析技能系统设计模式
- [ ] 对比记忆系统实现差异
- [ ] 研究 cc-connect 运行时切换机制
- [ ] 设计本项目的运行时切换方案

**产出**：
- TurboClaw 技术分析文档
- 运行时切换设计方案
- 技能系统设计草案

---

### 第二阶段（2-3 周）：核心功能实现

**目标**：实现运行时切换和 Provider 管理

**任务清单**：
- [ ] 实现 `/model` 命令（模型切换）
- [ ] 实现 `/mode` 命令（权限模式切换）
- [ ] 实现 `/provider` 命令（Provider 切换）
- [ ] 扩展 `.env` 配置支持多 Provider
- [ ] 测试运行时切换稳定性

**产出**：
- 运行时切换功能
- Provider 管理功能
- 用户使用文档

---

### 第三阶段（3-4 周）：功能扩展

**目标**：参考 Claudegram 和 MCP Telegram

**任务清单**：
- [ ] 研究 Claudegram 的 TTS 实现
- [ ] 评估 TTS 功能是否适合集成
- [ ] 研究 MCP 协议规范
- [ ] 评估 MCP 集成的可行性
- [ ] 可选：实现附件回传功能

**产出**：
- TTS 功能（可选）
- MCP 协议评估报告
- 附件回传功能（可选）

---

### 第四阶段（持续）：生态跟踪

**目标**：定期跟踪生态项目更新

**任务清单**：
- [ ] 每季度更新本文档
- [ ] 跟踪 cc-connect 新版本发布
- [ ] 关注 TurboClaw 更新
- [ ] 观察 Cursor Automations 发展
- [ ] 收集用户反馈和需求

**产出**：
- 季度生态报告
- 新特性评估文档
- 用户需求分析

---

## 🔗 资源链接汇总

### 📱 Telegram 项目

- TeleCode：https://telecodebot.com/
- Claudegram：https://claudegram.com/
- TurboClaw：https://github.com/ikmolbo/TurboClaw ⭐
- cursor-tg：https://github.com/tb5z035i/cursor-tg
- MCP Telegram：https://github.com/antongsm/mcp-telegram
- claude-telegram-bot-bridge：https://github.com/terranc/claude-telegram-bot-bridge

### 🌐 通用框架

- cc-connect：https://github.com/chenhg5/cc-connect ⭐
- OpenAB：https://github.com/xx025/openab
- LettaBot：https://github.com/letta-ai/lettabot

### 🏢 企业 IM

- OpenClaw：https://openclawcn.com/
- AutoClaw：https://autoclaws.org/im-integration/
- openclaw-lark：https://github.com/larksuite/openclaw-lark
- feishu-cursor-claw：https://github.com/nongjun/feishu-cursor-claw
- ClawdBot：Medium 搜索 "ClawdBot Lark Feishu"

### 📚 相关文档

- cc-connect 对比分析：[docs/cc-connect-comparison.md](./cc-connect-comparison.md)
- Cursor Agent CLI：https://cursor.com/docs/cli
- Claude Code Router：https://github.com/musistudio/claude-code-router

---

## 📝 文档维护

### 更新记录

- **2026-03-19**：初始版本，收录 15+ 项目
- **下次更新**：2026-06（季度更新）

### 维护规则

- **更新周期**：每季度一次
- **触发条件**：
  - 重大项目发布
  - cc-connect 新版本
  - 本项目重大变更
  - 用户反馈新项目
  
### 维护者

- 项目团队
- 欢迎社区贡献

---

## 🎯 总结

### 生态特点

1. **快速发展**：2026 年初大量项目涌现
2. **技术多样**：Go/TypeScript/Node.js/Python 并存
3. **平台分化**：Telegram 专注 vs 多平台通用
4. **功能差异**：广度扩展 vs 深度集成

### cursor-remote-control 定位

- 🎯 **差异化明显**：向量记忆系统是核心竞争力
- 🏢 **企业场景优化**：飞书/钉钉/企业微信深度集成
- 🇨🇳 **本地化特性**：飞连/热榜等中国场景
- 🧠 **AI 自主性**：心跳系统 + 自主检索

### 战略建议

**保持**：
- ✅ Cursor 深度集成（专注）
- ✅ 三层记忆系统（独特）
- ✅ 本地化特性（优势）
- ✅ 企业 IM 平台（聚焦）

**借鉴**：
- ✅ 运行时切换（cc-connect）
- ✅ Provider 管理（cc-connect）
- ✅ 技能系统（TurboClaw）
- ⚠️ TTS 功能（Claudegram）

**观察**：
- ⚠️ MCP 协议（长期）
- ⚠️ 多 Agent 编排（可选）
- ⚠️ 更多平台（按需）

---

**核心原则**：借鉴优秀设计，保持独特优势，专注 Cursor 深度集成。
