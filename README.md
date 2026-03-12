# Cursor Remote Control

通过飞书和钉钉远程控制 Cursor AI Agent 的中继服务。

## 项目结构

```
cursor-remote-control/
├── feishu/              # 飞书服务
│   ├── server.ts        # 飞书主服务
│   ├── bridge.ts        # Cursor CLI 调用
│   ├── memory.ts        # 记忆系统
│   ├── heartbeat.ts     # 心跳系统
│   └── scheduler.ts     # 定时任务
│
├── dingtalk/            # 钉钉服务
│   ├── server-minimal.ts        # 钉钉主服务
│   ├── dingtalk-client.ts       # 钉钉 Stream 客户端
│   ├── bridge.ts -> ../feishu/bridge.ts      # 符号链接(共享)
│   ├── memory.ts -> ../feishu/memory.ts      # 符号链接(共享)
│   ├── heartbeat.ts -> ../feishu/heartbeat.ts # 符号链接(共享)
│   └── scheduler.ts -> ../feishu/scheduler.ts # 符号链接(共享)
│
├── shared/              # 共享配置
│   └── projects.json    # 项目路由配置
│
└── docs/                # 文档
    └── ...
```

## 功能特性

- 🚀 **双渠道支持**: 同时支持飞书和钉钉
- 🔄 **代码复用**: 核心模块通过符号链接共享(70%代码复用率)
- 💾 **记忆系统**: 向量数据库 + 语义搜索
- ⏰ **定时任务**: Cron 表达式调度
- ❤️ **心跳检查**: 定期自动检查和维护
- 🎙️ **语音识别**: 火山引擎语音转文字
- 🖼️ **图片处理**: 自动下载和识别
- 📁 **项目路由**: 支持多工作区切换

## 快速开始

### 飞书服务

```bash
cd feishu
cp .env.example .env
# 编辑 .env 填入飞书凭据
bun install
bash service.sh install
```

### 钉钉服务

```bash
cd dingtalk
cp .env.example .env
# 编辑 .env 填入钉钉凭据
bun install
bash service.sh install
```

## 文档

- [飞书使用指南](docs/feishu-使用指南.md)
- [钉钉配置指南](docs/钉钉应用配置指南.md)
- [架构设计](docs/钉钉-飞书-双渠道架构方案.md)
- [快速参考](docs/飞书-Cursor-快速参考.md)

## 许可证

MIT
