# feishu-cursor-claw 项目实现原理分析

> 项目地址: https://github.com/nongjun/feishu-cursor-claw

## 项目简介

**feishu-cursor-claw** 将飞书变成 Cursor AI 的远程遥控器。在手机上发消息，Mac 就自动写代码、审文档、执行任务。

## 核心实现原理

这个项目的关键是建立了一个**桥接服务**，将飞书和本地 Cursor IDE 连接起来：

```
手机飞书 ─WebSocket→ feishu-cursor (中继服务) ─CLI调用→ 本地 Cursor IDE
                          ↓
                    会话管理 + 记忆系统
```

完整架构：

```
Phone (Feishu) ──WebSocket──→ feishu-cursor ──Cursor CLI──→ Local Cursor IDE
                                    │                          │
                             ┌──────┼──────┐            --resume (session continuity)
                             │      │      │
                          Text   Image   Voice
                                          │
                               Volcengine STT (primary)
                               Local whisper (fallback)
                                    │
                             ┌──────┴──────┐
                          Scheduler    Heartbeat
                          (cron-jobs)  (.cursor/HEARTBEAT.md)
```

## 技术实现细节

### 1. Cursor CLI 调用

核心是利用了 Cursor 的 Agent CLI（`~/.local/bin/agent`），这是 Cursor 提供的命令行接口。中继服务通过 Shell 调用这个 CLI。

**实际调用方式**（实测验证）：

```bash
# 非交互模式 + 自动信任工作区
agent -p --trust --model auto --workspace /path/to/project "用户消息"

# 会话恢复
agent -p --trust --resume <session-id> "后续消息"
```

**关键参数**：
- `-p` / `--print`：非交互模式，直接输出结果（适合脚本调用）
- `--trust`：自动信任工作区，跳过确认（**仅在非交互模式可用**）
- `--model auto`：使用自动模型选择
- `--workspace`：指定工作区路径
- `--resume`：恢复之前的会话上下文

**实现示例**：

```typescript
// 中继服务的实际调用
function callCursorAgent(workspace: string, message: string, sessionId?: string) {
  let cmd = `agent -p --trust --model auto --workspace "${workspace}"`;
  
  if (sessionId) {
    cmd += ` --resume ${sessionId}`;
  }
  
  cmd += ` "${message}"`;
  
  const result = await exec(cmd);
  return result;
}
```

**会话连续性**通过 `--resume` 参数实现：

```typescript
// 首次对话
const output1 = await exec('agent -p --trust "分析代码"');
const sessionId = extractSessionId(output1);

// 后续对话（保持上下文）
const output2 = await exec(`agent -p --trust --resume ${sessionId} "继续重构"`);
```

### 2. 飞书长连接（WebSocket）

- 使用飞书开放平台的 **WebSocket 模式**（长连接）
- **不需要公网 URL**，直接在本地建立与飞书服务器的持久连接
- 实时接收消息事件（`im.message.receive_v1`）
- 订阅权限：`im:message`、`im:message.group_at_msg`、`im:resource`

### 3. 多模态输入处理

```typescript
// 语音消息处理流程
飞书语音消息 → 下载音频文件 → STT识别
                            ↓
                      火山引擎大模型 → 文本
                            ↓ (失败)
                      本地whisper-cpp → 文本
                            ↓
                      传给Cursor CLI
```

**降级链路**：火山引擎豆包大模型 → 本地 whisper-cpp → 告知用户

支持的输入类型：
- 文本消息
- 图片
- 语音消息
- 文件
- 富文本

### 4. 实时流式响应

监听 Cursor CLI 的输出流，实时更新飞书卡片：

```typescript
// 流式处理示例
const stream = exec('agent run ...');
stream.stdout.on('data', (chunk) => {
  // 解析思考/工具调用/响应
  updateFeishuCard(chunk);
});
```

展示内容：
- AI 的思考过程
- 工具调用情况
- 实时响应
- 总耗时统计

### 5. 会话并发策略

**会话级并发**：
- 同一会话：串行执行（保证上下文连续）
- 不同会话：并行执行（无全局限制）
- Cursor CLI 自己管理生命周期

这个设计很聪明，避免了全局锁，最大化利用资源。

## 关键文件结构

```typescript
server.ts          // 主服务：启动飞书长连接 + 消息分发
bridge.ts          // 桥接层：飞书消息 ↔ Cursor CLI
scheduler.ts       // 定时任务调度器
memory.ts          // 记忆系统（向量检索 + 全文搜索）
memory-tool.ts     // 记忆工具：供Cursor调用的MCP工具
heartbeat.ts       // 心跳系统
service.sh         // macOS launchd 服务管理脚本
```

## 核心流程实现（推测）

```typescript
// 1. 接收飞书消息
feishuClient.on('message', async (event) => {
  const { user_id, content, workspace } = event;
  
  // 2. 获取或创建会话
  const session = getOrCreateSession(workspace);
  
  // 3. 处理多模态输入
  let message = content.text;
  if (content.voice) {
    message = await transcribeVoice(content.voice);
  }
  if (content.image) {
    // 图片直接传给Cursor处理
  }
  
  // 4. 调用Cursor CLI
  const agentCmd = session.id 
    ? `agent run --resume ${session.id} --message "${message}"`
    : `agent run --workspace "${workspace}" --message "${message}"`;
  
  // 5. 流式处理输出
  const stream = spawn('sh', ['-c', agentCmd]);
  let buffer = '';
  
  stream.stdout.on('data', (chunk) => {
    buffer += chunk;
    // 解析Cursor输出格式
    const parsed = parseChunk(buffer);
    
    // 实时更新飞书卡片
    sendFeishuCard(user_id, {
      thinking: parsed.thinking,
      toolCalls: parsed.toolCalls,
      response: parsed.response,
      elapsedTime: Date.now() - startTime
    });
  });
  
  // 6. 记录会话历史
  await logSession(session.id, { 
    user: message, 
    assistant: result 
  });
});
```

## 项目路由机制

通过 `projects.json` 配置支持多工作区：

```json
{
  "projects": {
    "code": { 
      "path": "/Users/你/Projects/myapp", 
      "description": "代码项目" 
    },
    "strategy": { 
      "path": "/Users/你/Documents/战略", 
      "description": "战略文档" 
    }
  },
  "default_project": "code"
}
```

在飞书中使用 `strategy: 消息内容` 可路由到指定工作区。

## 记忆与身份体系

灵感来自 OpenClaw，通过 Cursor 的规则系统实现：

### 规则注入机制

```
templates/ (模板)                 → 首次启动复制到 → 工作区/.cursor/rules/*.mdc
    ↓                                                    ↓
所有 .mdc 规则文件                                  Cursor CLI 自动加载
(alwaysApply: true)                                      ↓
                                                   每次会话自动注入上下文
```

### 关键规则文件

| 文件 | 作用 |
|------|------|
| `agent-identity.mdc` | AI 的名字、emoji、性格 |
| `user-context.mdc` | 主人的信息和偏好 |
| `soul.mdc` | AI 的核心原则和行为边界 |
| `memory-protocol.mdc` | 记忆召回协议（强制 AI 先搜索记忆） |
| `workspace-rules.mdc` | 安全规则、操作边界 |

### 记忆存储

```
.cursor/
├── MEMORY.md                   # 长期记忆（AI 自动维护）
├── HEARTBEAT.md                # 心跳检查清单
├── BOOT.md                     # 启动自检清单
├── BOOTSTRAP.md                # 首次运行的"出生仪式"
├── memory/
│   ├── 2026-03-11.md          # 每日日记
│   └── heartbeat-state.json   # 心跳历史
└── sessions/
    └── 2026-03-11.jsonl       # 会话转录

.memory.sqlite                  # 向量嵌入数据库
cron-jobs.json                  # AI创建的定时任务
```

### 记忆检索

**双模式检索**：
1. **向量搜索**：火山引擎 embedding API（`doubao-embedding-vision-250615`）
2. **关键词搜索**：SQLite FTS5 BM25 全文索引
3. **混合策略**：语义 + 关键词

**增量索引**：
- 按内容 hash 追踪文件变化
- 只对修改过的文件重新嵌入
- 首次启动索引全工作区所有文本文件（`.md` `.txt` `.json` 等）

## 定时任务系统

AI 可以创建定时任务，写入 `cron-jobs.json`：

```json
{
  "jobs": [
    {
      "id": "morning-check",
      "schedule": "0 9 * * *",  // cron表达式
      "message": "检查邮件和日程",
      "workspace": "/path/to/workspace",
      "enabled": true
    }
  ]
}
```

支持三种类型：
- **一次性**：特定时间点执行
- **间隔**：固定间隔重复
- **Cron**：cron 表达式

## 心跳系统

定期（默认30分钟）触发 AI 执行后台维护：

1. 读取 `.cursor/HEARTBEAT.md` 检查清单
2. 逐项执行（整理记忆、检查项目状态、更新文档）
3. AI 自主管理清单（过时时自动更新）
4. 无事回复 `HEARTBEAT_OK`，有重要信息通过飞书通知
5. 通过 `.cursor/memory/heartbeat-state.json` 追踪检查历史

**特性**：
- 可配置检查间隔
- 支持活跃时段设置（如仅工作时间）
- 避免重复检查同一状态

## 安全机制

1. **群聊保护**：敏感命令（如 `/密钥`）在群聊自动拦截
2. **智能错误提示**：API Key 失效时自动展示修复步骤 + Dashboard 链接
3. **自动降级**：模型欠费自动切换到 `auto` 模型并通知
4. **安全守则**：
   - 反操纵（AI 不会被诱导绕过安全规则）
   - 反权力寻求（AI 不会自主扩张权限）
   - 人类监督优先（重要决策需要人工确认）

## 运维设计

### 服务管理（launchd）

通过 `service.sh` 脚本管理：

```bash
bash service.sh install    # 安装开机自启动
bash service.sh status     # 查看运行状态
bash service.sh restart    # 重启服务
bash service.sh logs       # 查看实时日志
bash service.sh uninstall  # 卸载
```

**优势**：
- 开机自启
- 崩溃自动重启
- 无需手动维护

### 热更新配置

编辑 `.env` 文件后**无需重启**：
- 更换 API Key
- 切换模型
- 修改 STT 配置

## 与其他方案的对比

| 方案 | 实现方式 | 优势 | 劣势 |
|------|---------|------|------|
| **feishu-cursor-claw** | 飞书长连接 + Cursor CLI | 简单、本地、无需公网、会话连续 | 仅支持 macOS |
| SSH 远程桌面 | VPN + 远程操作 | 通用 | 需要网络环境、操作不便 |
| Cursor Web UI | 浏览器访问 | 跨平台 | Cursor 暂无官方 Web 版 |
| API 直接调用 | 调用 Cursor API | 灵活 | 需自己实现上下文管理、会话等 |

## 核心优势总结

1. **无需 VPN/SSH**：完全本地运行，飞书 WebSocket 直连
2. **会话连续性**：同一工作区自动恢复上下文（`--resume`）
3. **多模态支持**：文本、语音、图片、文件
4. **实时反馈**：流式输出，飞书卡片实时更新
5. **安全性**：敏感命令群聊拦截，权限边界清晰
6. **容错机制**：
   - STT 两级降级（云端 → 本地）
   - 模型欠费自动降级
   - 崩溃自动重启（launchd）
7. **零配置记忆**：AI 自主管理长期记忆和身份
8. **自主调度**：AI 可创建定时任务，自主执行后台维护

## 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | Bun (TypeScript) |
| IM 平台 | 飞书开放平台（WebSocket 长连接） |
| AI 引擎 | Cursor Agent CLI |
| 语音识别 | 火山引擎豆包 STT + whisper-cpp |
| 向量搜索 | SQLite + 火山引擎 embedding API |
| 全文搜索 | SQLite FTS5 (BM25) |
| 服务管理 | macOS launchd |

## 适用场景

### 开发者场景
- 通勤路上：语音描述需求，到公司代码已经写好
- 代码审查：手机看 PR，飞书让 AI 审查并提出建议
- 紧急修复：不在电脑旁，语音让 AI 修 Bug 并提交

### 管理者场景
- 战略文档共创：语音输入想法，AI 整理成结构化文档
- 会议记录处理：拍照会议白板，AI 提取要点并生成行动清单
- 知识管理：随时记录灵感，AI 自动分类和关联历史记忆

## 关键技术亮点

### 1. 会话管理的智能设计

**同会话串行，不同会话并行**：
- 避免同一上下文被并发破坏
- 不同项目可同时工作
- 无全局锁，性能最优

### 2. 记忆系统 v2

借鉴 OpenClaw 的设计：
- **自主调用**：AI 决定何时搜索记忆（通过 `memory-tool.ts` MCP 工具）
- **强制协议**：回答历史问题前必须先搜索（`memory-protocol.mdc` 规则）
- **防丢失**：长对话中 AI 主动将关键信息持久化
- **禁止空记忆**：严格规则强制文件持久化，不允许"我会记住"
- **增量索引**：按内容 hash 追踪，避免重复嵌入
- **全工作区索引**：`.md` `.txt` `.html` `.json` `.mdc` `.csv` `.xml` `.yaml` `.toml` 等全部索引

### 3. 规则系统即身份系统

利用 Cursor 的 `.mdc` 规则系统（`alwaysApply: true`）实现 OpenClaw 式的身份注入：
- 无需服务端拼接提示词
- Cursor CLI 自动加载规则到每次会话
- 身份、人格、安全规则从会话开始就在上下文中

### 4. 首次运行仪式

`.cursor/BOOTSTRAP.md` 实现 AI 的"出生仪式"：
- AI 选择自己的名字和性格
- 与主人建立关系
- 了解工作环境
- 完成后自动删除（只运行一次）

### 5. 启动自检

`.cursor/BOOT.md` 在每次服务启动时执行：
- 检查配置完整性
- 验证必要文件
- 可选发送上线通知到飞书

### 6. 心跳监控

`.cursor/HEARTBEAT.md` + `heartbeat-state.json`：
- 定期触发 AI 执行检查清单
- AI 自主管理清单内容（自动更新）
- 追踪检查历史，避免重复工作
- 支持活跃时段配置

## 配置说明

### 环境变量（.env）

| 变量 | 必填 | 说明 |
|------|------|------|
| `CURSOR_API_KEY` | 是 | Cursor Dashboard → Integrations → User API Keys |
| `FEISHU_APP_ID` | 是 | 飞书应用 ID |
| `FEISHU_APP_SECRET` | 是 | 飞书应用密钥 |
| `CURSOR_MODEL` | 否 | 默认：opus-4.6-thinking |
| `VOLC_STT_APP_ID` | 否 | 火山引擎应用 ID（不配置则禁用云端 STT） |
| `VOLC_STT_ACCESS_TOKEN` | 否 | 火山引擎访问令牌 |
| `VOLC_EMBEDDING_API_KEY` | 否 | 火山引擎 embedding API（用于向量搜索） |
| `VOLC_EMBEDDING_MODEL` | 否 | 默认：doubao-embedding-vision-250615 |

### 飞书命令

| 命令 | 中文别名 | 说明 |
|------|---------|------|
| `/help` | `/帮助` `/指令` | 显示帮助 |
| `/status` | `/状态` | 服务状态（模型、Key、STT、会话） |
| `/new` | `/新对话` `/新会话` | 重置当前工作区会话 |
| `/model 名称` | `/模型 名称` | 切换模型 |
| `/apikey key` | `/密钥 key` | 更换 API Key（仅限私聊） |
| `/stop` | `/终止` `/停止` | 终止当前运行的任务 |
| `/memory` | `/记忆` | 记忆系统状态 |
| `/memory 关键词` | `/记忆 关键词` | 语义搜索记忆 |
| `/log 内容` | `/记录 内容` | 写入今日日记 |
| `/reindex` | `/整理记忆` | 重建记忆索引 |
| `/task` | `/任务` `/cron` `/定时` | 查看/管理定时任务 |
| `/heartbeat` | `/心跳` | 查看/管理心跳系统 |

## 创新点

1. **飞书 WebSocket**：不需要公网服务器，本地直连
2. **Cursor CLI**：直接调用官方 CLI，不需要逆向工程
3. **会话级并发**：精细化并发控制，性能与安全兼顾
4. **双模 STT**：云端高精度 + 本地容错
5. **规则即身份**：利用 Cursor 原生规则系统，无侵入式注入
6. **自主记忆**：AI 自己决定何时搜索和保存记忆
7. **AI 出生仪式**：让 AI 有真正的"身份感"
8. **心跳自管理**：AI 自主管理检查清单，避免人工维护
9. **定时任务**：AI 可编程自己的工作节奏

## 应用场景扩展

### 个人知识管理
- 随时记录想法（语音 → 文本 → 分类）
- AI 自动关联历史记忆
- 定期整理和生成知识图谱

### 企业战略伙伴
- 高管用语音输入战略思考
- AI 整理成结构化战略文档
- 多轮对话迭代和完善

### 移动办公
- 不在电脑旁也能高效工作
- 语音、图片、文字混合输入
- 实时查看执行进度

## 技术难点与解决方案

### 1. Cursor CLI 的流式输出解析
**难点**：Cursor CLI 输出格式复杂，包含思考、工具调用、响应等多种类型  
**解决**：编写解析器识别不同类型的输出块，分别更新飞书卡片对应部分

### 2. 语音识别质量
**难点**：本地 whisper 模型质量不足，尤其中文  
**解决**：优先使用火山引擎豆包 STT（准确度高），失败时降级到本地

### 3. 会话状态管理
**难点**：多用户、多工作区的会话隔离  
**解决**：`(feishu_user_id, workspace_path)` 作为会话唯一标识

### 4. 长对话记忆丢失
**难点**：Cursor 上下文窗口有限，长对话后早期信息会丢失  
**解决**：
- AI 主动在长对话中将关键信息写入文件
- 强制规则：禁止"我会记住"，必须持久化
- 会话转录自动保存

### 5. 实时性与成本平衡
**难点**：频繁更新飞书卡片消耗 API 额度  
**解决**：
- 批量更新，减少 API 调用
- 增量索引，避免重复嵌入
- 嵌入缓存，相同内容不重复调用

## 总结

这个项目巧妙地利用了：
1. **Cursor Agent CLI** 的编程式调用能力和会话恢复机制
2. **飞书 WebSocket** 的长连接模式（无需公网 URL）
3. **Cursor 规则系统** 实现 OpenClaw 式的身份注入
4. **向量 + 全文混合检索** 实现高质量记忆召回

核心价值是 **Cursor CLI 本身就支持编程式调用和会话恢复**，中继服务只需做好：
- 消息路由和协议转换
- 状态管理和并发控制
- 多模态输入处理
- 记忆系统和身份管理

最终实现了一个轻量但功能完整的远程控制方案，让 AI 从桌面工具变成随身智能助理。

---

## 实际使用经验总结

### Agent CLI 常见问题与解决

#### 1. 命令找不到：`zsh: command not found: agent`

**原因**：`~/.local/bin` 不在 PATH 中

**解决**：
```bash
# 临时生效
export PATH="$HOME/.local/bin:$PATH"

# 永久生效
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

#### 2. 交互模式没有响应

**原因**：agent 在等待你确认信任工作区

**解决**：
- 看到 `Do you trust this directory?` 提示时，输入 `y` 然后回车
- 不要使用 `agent --trust`（这个参数只能在非交互模式使用）

#### 3. `--trust can only be used with --print/headless mode`

**原因**：`--trust` 参数只能在非交互模式下使用

**解决**：
```bash
# 错误用法
agent --trust "任务"

# 正确用法（非交互模式）
agent -p --trust "任务"

# 或者交互模式不用 --trust
agent  # 然后输入 y 确认
```

#### 4. 模型不可用：`Sonnet 4.5 is not available`

**原因**：你的账号可能不在某些模型的可用池中

**解决**：
```bash
# 使用 auto 模型（推荐）
agent --model auto "任务"

# 或者不指定模型（使用默认）
agent "任务"
```

#### 5. 需要 API Key 吗？

**不需要！** Agent CLI 会自动使用你在 Cursor IDE 中的登录状态。

仅在以下情况需要配置 `CURSOR_API_KEY`：
- 在没有登录 Cursor IDE 的服务器上使用
- 需要使用不同的账号

### 正确的使用姿势

#### 交互模式（日常使用）

```bash
# 启动
cd /path/to/your/project
agent

# 第一次会询问是否信任目录，输入 y
# 然后就可以正常对话了
```

#### 非交互模式（脚本/自动化）

```bash
# 适合 feishu-cursor-claw 这样的自动化场景
agent -p --trust --model auto --workspace /path/to/project "任务描述"

# 会话恢复
agent -p --trust --resume <session-id> "后续任务"
```

#### 模型选择

```bash
# 推荐：自动选择
agent --model auto "任务"

# 快速模型（如果可用）
agent --model sonnet-4.5 "任务"

# 最强模型（慢）
agent --model opus-4.6-thinking "复杂任务"
```

### feishu-cursor-claw 的实际调用

根据实测，中继服务应该这样调用：

```typescript
import { spawn } from 'child_process';

async function executeAgentTask(
  workspace: string, 
  message: string, 
  sessionId?: string
) {
  const args = [
    '-p',           // 非交互模式
    '--trust',      // 自动信任
    '--model', 'auto',
    '--workspace', workspace
  ];
  
  if (sessionId) {
    args.push('--resume', sessionId);
  }
  
  args.push(message);
  
  const process = spawn('agent', args);
  
  // 流式处理输出
  let output = '';
  process.stdout.on('data', (chunk) => {
    output += chunk.toString();
    // 实时更新飞书卡片
    updateFeishuCard(output);
  });
  
  return new Promise((resolve) => {
    process.on('close', () => resolve(output));
  });
}
```

### 性能对比

| 模式 | 响应时间 | 适用场景 |
|------|---------|---------|
| `opus-4.6-thinking` | 很慢（可能几分钟） | 复杂推理任务 |
| `auto` | 较快（20-30秒） | 日常任务 ✅ |
| `sonnet-4.5` | 快（如果可用） | 简单任务 |

---

**分析时间**：2026-03-11  
**项目版本**：基于 main 分支 README  
**实测验证**：已在 macOS 24.6.0 + Cursor Agent v2026.02.27 验证
