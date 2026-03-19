# 架构设计文档

## 概述

Cursor Remote Control 是一个双渠道 AI 中继服务，通过飞书和钉钉远程控制 Cursor AI Agent。

## 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                         客户端层                                  │
├─────────────────────────────────────────────────────────────────┤
│  手机飞书 App          │          手机钉钉 App                    │
│  (WebSocket)          │          (Stream API)                   │
└─────────────────────────────────────────────────────────────────┘
                        │                   │
                        ▼                   ▼
┌─────────────────────────────────────────────────────────────────┐
│                       服务网关层                                  │
├─────────────────────────────────────────────────────────────────┤
│  feishu/server.ts     │    dingtalk/server-minimal.ts          │
│  - WebSocket 连接     │    - Stream 长连接                      │
│  - 消息接收处理       │    - 消息接收处理                        │
│  - 多模态解析         │    - 多模态解析                          │
│  - 文件发送           │    - 卡片消息                            │
└─────────────────────────────────────────────────────────────────┘
                        │                   │
                        ▼                   ▼
┌─────────────────────────────────────────────────────────────────┐
│                       共享核心层                                  │
├─────────────────────────────────────────────────────────────────┤
│  项目路由 (projects.json)                                        │
│  - 多工作区管理                                                   │
│  - 自动/手动切换                                                  │
│  - 默认项目配置                                                   │
│                                                                 │
│  记忆系统 (shared/memory.ts)                                     │
│  - SQLite 存储                                                   │
│  - 向量索引 (FTS5 + BM25)                                        │
│  - 语义搜索                                                       │
│  - 日记系统                                                       │
│                                                                 │
│  定时任务 (shared/scheduler.ts)                                  │
│  - Cron 表达式                                                   │
│  - 间隔任务                                                       │
│  - 一次性任务                                                     │
│                                                                 │
│  心跳系统 (shared/heartbeat.ts)                                  │
│  - 定期维护                                                       │
│  - 状态检查                                                       │
│  - 自主管理                                                       │
└─────────────────────────────────────────────────────────────────┘
                        │                   │
                        ▼                   ▼
┌─────────────────────────────────────────────────────────────────┐
│                      AI 执行层                                    │
├─────────────────────────────────────────────────────────────────┤
│  Cursor Agent CLI (~/.local/bin/agent)                          │
│  - 会话管理 (--resume)                                            │
│  - 工具调用                                                       │
│  - 流式输出                                                       │
│  - 模型切换                                                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      本地 Cursor IDE                              │
├─────────────────────────────────────────────────────────────────┤
│  - 代码编辑                                                       │
│  - 文件操作                                                       │
│  - 终端执行                                                       │
│  - Git 操作                                                       │
└─────────────────────────────────────────────────────────────────┘
```

## 核心模块设计

### 1. 服务网关层

#### 飞书服务 (feishu/)

**核心组件**：
- `server.ts` - 主服务进程
- `bridge.ts` - OpenAI API 桥接（备用）
- `memory-tool.ts` - 记忆 CLI 工具
- `service.sh` - 服务管理脚本

**特性**：
- WebSocket 长连接（@larksuiteoapi/node-sdk）
- 文件上传/下载支持
- 富文本卡片消息
- 语音识别（火山 STT → whisper-cpp）

#### 钉钉服务 (dingtalk/)

**核心组件**：
- `server-minimal.ts` - 主服务进程
- `dingtalk-client.ts` - Stream 客户端封装
- `memory-tool.ts` - 记忆 CLI 工具
- `service.sh` - 服务管理脚本

**特性**：
- Stream API 长连接（dingtalk-stream）
- Markdown 消息
- 交互式卡片
- 语音识别（同飞书）

### 2. 共享核心层 (shared/)

#### 项目路由系统

**配置文件**：`projects.json`

```json
{
  "projects": {
    "项目别名": {
      "path": "本地路径",
      "description": "描述"
    }
  },
  "default_project": "默认项目",
  "memory_workspace": "记忆存储位置"
}
```

**路由规则**：
1. 消息前缀匹配：`别名: 消息内容`
2. 显式切换：`切换到 别名`
3. 降级到默认项目

#### 记忆系统 (memory.ts)

**数据结构**：

```typescript
interface MemoryEntry {
  id: string;           // UUID
  timestamp: number;    // 时间戳
  content: string;      // 记忆内容
  embedding?: number[]; // 向量（可选）
  metadata?: {
    source: string;     // 来源（user/ai/system）
    tags: string[];     // 标签
  };
}
```

**存储架构**：
```
工作区/
├── .cursor/
│   ├── MEMORY.md              # 长期记忆（手动编辑）
│   ├── .memory.sqlite         # 向量数据库
│   ├── memory/
│   │   ├── 2026-03-15.md      # 日记（按日期）
│   │   └── heartbeat-state.json
│   └── sessions/
│       └── <uuid>.jsonl       # 会话转录
```

**搜索策略**：
1. FTS5 全文搜索（BM25 算法）
2. 向量语义搜索（余弦相似度）
3. 混合排序（0.6 × BM25 + 0.4 × 向量）

#### 定时任务系统 (scheduler.ts)

**任务类型**：

```typescript
interface CronJob {
  id: string;
  type: 'cron' | 'interval' | 'once';
  schedule: string;           // Cron 表达式 或 间隔（秒）
  project: string;            // 项目别名
  command: string;            // 执行命令
  enabled: boolean;
  lastRun?: number;
  nextRun?: number;
}
```

**执行流程**：
```
Scheduler 启动
  ↓
加载 cron-jobs-*.json
  ↓
计算 nextRun 时间
  ↓
定时检查（每 30s）
  ↓
到期任务 → 启动 Cursor CLI
  ↓
结果推送到飞书/钉钉
  ↓
更新 lastRun，计算下次 nextRun
```

#### 心跳系统 (heartbeat.ts)

**检查清单**：`.cursor/HEARTBEAT.md`

```markdown
# 心跳检查清单

## 记忆维护
- [ ] 整理今日记忆
- [ ] 压缩旧会话转录
- [ ] 更新长期记忆

## 状态检查
- [ ] 检查服务状态
- [ ] 查看错误日志
- [ ] 清理临时文件
```

**状态追踪**：`.cursor/memory/heartbeat-state.json`

```json
{
  "lastRun": 1710475200000,
  "checks": {
    "记忆维护": { "status": "completed", "timestamp": 1710475200000 },
    "状态检查": { "status": "pending" }
  }
}
```

### 3. AI 执行层

#### Cursor Agent CLI

**会话管理**：
- 每个工作区独立会话 ID
- 自动 `--resume` 恢复上下文
- 同一会话串行执行（队列）
- 不同会话并发执行

**工具调用**：
- 文件读写（Read, Write, StrReplace）
- 代码搜索（Grep, Glob）
- Shell 命令（Shell）
- 任务委托（Task）

**流式输出**：
```
AI 思考中...
  ↓
工具调用（实时显示）
  ↓
AI 回复（流式推送）
  ↓
完成（耗时统计）
```

## 数据流设计

### 消息处理流程

```
用户消息 (飞书/钉钉)
  ↓
[1] 解析消息类型
    - 文本消息
    - 语音消息 → STT 转文本
    - 图片消息 → 下载 + OCR
    - 文件消息 → 下载
  ↓
[2] 项目路由
    - 前缀匹配 (project: ...)
    - 切换指令
    - 默认项目
  ↓
[3] 指令检查
    - 系统指令 (/help, /status, /new...)
    - 记忆指令 (/memory, /log)
    - 任务指令 (/任务, /心跳)
    - 透传给 AI
  ↓
[4] 启动 Cursor CLI
    - 查找/创建会话 ID
    - 构建命令：agent --workspace=... --resume=...
    - 传入用户消息 + 上下文
  ↓
[5] 流式处理
    - 解析 JSON 输出
    - 更新进度卡片（工具调用）
    - 推送最终结果
  ↓
[6] 后处理
    - 记录会话转录
    - 更新记忆数据库
    - 清理临时文件
```

### 多模态处理

```
语音消息
  ↓
下载 OGG 文件 → 转 WAV
  ↓
火山 STT (优先)
  ├─ 成功 → 返回文本
  └─ 失败 → whisper-cpp (降级)
  ↓
追加到消息内容

图片消息
  ↓
下载图片文件
  ↓
传递给 Cursor CLI（支持 vision）
  ↓
AI 自主 OCR / 分析
```

## 安全设计

### 凭据隔离

```
├── feishu/.env          # 飞书凭据
│   ├── FEISHU_APP_ID
│   ├── FEISHU_APP_SECRET
│   └── VOLC_STT_*
│
├── dingtalk/.env        # 钉钉凭据
│   ├── DINGTALK_CLIENT_ID
│   ├── DINGTALK_CLIENT_SECRET
│   └── VOLC_STT_*
│
└── projects.json        # 共享配置（已 .gitignore）
```

### 权限控制

- **文件访问**：仅限 `projects.json` 配置的工作区
- **Shell 执行**：通过 Cursor CLI 沙箱
- **API Key**：支持 agent login（不暴露 Key）

### 日志脱敏

- ❌ 不记录 API Key
- ❌ 不记录用户敏感信息
- ✅ 记录操作类型、时间、结果

## 性能优化

### 并发控制

```typescript
// 会话队列（同一工作区串行）
const sessionQueues = new Map<string, Promise<void>>();

async function executeInSession(workspaceId: string, task: () => Promise<void>) {
  const currentQueue = sessionQueues.get(workspaceId) || Promise.resolve();
  const newQueue = currentQueue.then(task).catch(console.error);
  sessionQueues.set(workspaceId, newQueue);
  return newQueue;
}
```

### 缓存策略

- **会话 ID 缓存**：内存缓存 30 分钟
- **项目配置缓存**：文件 mtime 检查
- **记忆搜索缓存**：LRU 缓存 100 条

### 资源清理

- 临时文件：语音/图片下载后自动删除
- 旧转录：超过 30 天压缩归档
- 日志文件：rotate 保留 7 天

## 扩展性设计

### 新增渠道

1. 创建 `<platform>/` 目录
2. 实现 `server.ts`（消息收发）
3. 复用 `shared/` 模块
4. 添加独立 `service.sh`

### 新增工具

在 `shared/` 中添加模块：

```typescript
// shared/new-tool.ts
export async function newTool(params: ToolParams) {
  // 工具实现
}

// 在对应服务中集成
import { newTool } from '../shared/new-tool.ts';
```

### 新增指令

在服务的消息处理函数中添加：

```typescript
if (userMessage.startsWith('/new-command')) {
  // 处理新指令
  return;
}
```

## 监控与维护

### 健康检查

- **服务状态**：launchd 自动重启
- **会话泄漏**：定期清理超时会话
- **数据库大小**：自动 vacuum

### 日志分级

```
feishu/logs/
├── server.log          # INFO 级别（正常运行）
├── error.log           # ERROR 级别（错误）
└── debug.log           # DEBUG 级别（开发）

dingtalk/logs/
└── （同上）
```

### 备份策略

- **记忆数据**：SQLite 每日备份
- **配置文件**：Git 忽略，手动备份
- **会话转录**：归档到 `.cursor/sessions/archive/`

## 部署架构

### macOS launchd

```xml
<!-- ~/Library/LaunchAgents/com.cursor.feishu.plist -->
<plist>
  <dict>
    <key>Label</key>
    <string>com.cursor.feishu</string>
    <key>ProgramArguments</key>
    <array>
      <string>/Users/you/.bun/bin/bun</string>
      <string>run</string>
      <string>server.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/feishu</string>
    <key>KeepAlive</key>
    <true/>
  </dict>
</plist>
```

### 进程管理

```
launchctl load plist    → 启动服务
launchctl unload plist  → 停止服务
launchctl list          → 查看状态
```

## 技术选型说明

| 技术 | 选型理由 |
|------|---------|
| Bun | 快速启动、原生 TypeScript、内置 SQLite |
| SQLite | 轻量级、无服务器、支持 FTS5 全文搜索 |
| Cursor Agent CLI | 官方 CLI，自动登录，流式输出 |
| 火山引擎 STT | 高质量中文识别，降级到 whisper-cpp |
| launchd | macOS 原生服务管理，开机自启 |

## 未来规划

- [ ] Web 管理界面
- [ ] 企业微信渠道支持
- [ ] 多用户权限管理
- [ ] 云端记忆同步
- [ ] 插件系统
