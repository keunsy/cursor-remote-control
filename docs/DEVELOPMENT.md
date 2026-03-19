# 开发指南

## 开发环境搭建

### 前置要求

| 工具 | 版本 | 说明 |
|------|------|------|
| macOS | 12.0+ | 仅支持 macOS |
| Bun | 1.0+ | JavaScript 运行时 |
| Cursor | 最新版 | 需登录 |
| Cursor Agent CLI | 最新版 | `~/.local/bin/agent` |
| Node.js | 18+ | 可选（部分工具依赖） |

### 安装步骤

```bash
# 1. 克隆项目
git clone <your-fork>
cd cursor-remote-control

# 2. 安装 Bun（如果未安装）
curl -fsSL https://bun.sh/install | bash

# 3. 安装 Cursor Agent CLI（如果未安装）
curl https://cursor.com/install -fsS | bash

# 4. 登录 Cursor（一次性操作）
~/.local/bin/agent login

# 5. 安装飞书依赖
cd feishu
bun install

# 6. 安装钉钉依赖
cd ../dingtalk
bun install

# 7. 安装可选工具
brew install whisper-cpp  # 语音识别降级方案
```

### 配置开发环境

#### 1. 配置项目路由

```bash
cd /path/to/cursor-remote-control
cp projects.json.example projects.json
```

编辑 `projects.json`，配置你的开发项目：

```json
{
  "projects": {
    "test": {
      "path": "/Users/你/Projects/test-project",
      "description": "测试项目"
    }
  },
  "default_project": "test",
  "memory_workspace": "test"
}
```

#### 2. 配置飞书服务

```bash
cd feishu
cp .env.example .env
```

编辑 `.env`：

```bash
# 飞书凭据
FEISHU_APP_ID=cli_你的APP_ID
FEISHU_APP_SECRET=你的SECRET

# Cursor 配置
CURSOR_MODEL=auto
# CURSOR_API_KEY=  # 注释掉，使用 agent login

# 语音识别（可选）
# VOLC_STT_APP_ID=你的APP_ID
# VOLC_STT_ACCESS_TOKEN=你的TOKEN

# 向量搜索（可选）
# VOLC_EMBEDDING_API_KEY=你的KEY
# VOLC_EMBEDDING_MODEL=doubao-embedding-vision-250615
```

#### 3. 配置钉钉服务

```bash
cd ../dingtalk
cp .env.example .env
```

编辑 `.env`（同理）。

### 开发模式运行

#### 直接运行（推荐调试）

```bash
# 飞书服务
cd feishu
bun run server.ts

# 钉钉服务
cd dingtalk
bun run server-minimal.ts
```

**优点**：
- 实时看到 console.log 输出
- 代码修改立即生效（Bun 支持热重载）
- Ctrl+C 立即停止

#### 服务模式运行

```bash
# 飞书服务
cd feishu
bash service.sh start
bash service.sh logs  # 查看日志

# 钉钉服务
cd dingtalk
bash service.sh start
bash service.sh logs
```

**优点**：
- 后台运行，不占用终端
- 自动重启（崩溃恢复）
- 适合长期测试

## 项目结构详解

```
cursor-remote-control/
├── shared/                  # 共享模块（核心逻辑）
│   ├── memory.ts            # 记忆系统
│   ├── scheduler.ts         # 定时任务
│   ├── heartbeat.ts         # 心跳系统
│   └── sync-apple-notes.ts  # Apple Notes 同步
│
├── feishu/                  # 飞书服务
│   ├── server.ts            # 主服务（消息收发）
│   ├── bridge.ts            # OpenAI API 桥接
│   ├── memory-tool.ts       # 记忆 CLI 工具
│   ├── service.sh           # 服务管理脚本
│   ├── .env                 # 环境变量（已忽略）
│   └── README.md            # 飞书详细文档
│
├── dingtalk/                # 钉钉服务
│   ├── server-minimal.ts    # 主服务
│   ├── dingtalk-client.ts   # Stream 客户端
│   ├── memory-tool.ts       # 记忆 CLI 工具
│   ├── service.sh           # 服务管理脚本
│   ├── .env                 # 环境变量（已忽略）
│   └── README.md            # 钉钉详细文档
│
├── projects.json            # 项目路由（已忽略）
├── cron-jobs-feishu.json    # 飞书定时任务（已忽略）
├── cron-jobs-dingtalk.json  # 钉钉定时任务（已忽略）
├── manage-services.sh       # 统一服务管理
└── docs/                    # 文档
    ├── ARCHITECTURE.md      # 架构设计
    ├── DEVELOPMENT.md       # 本文档
    └── TROUBLESHOOTING.md   # 故障排查
```

## 核心模块开发

### 1. 消息处理流程

**文件**：`feishu/server.ts` 或 `dingtalk/server-minimal.ts`

```typescript
async function handleMessage(message: MessageEvent) {
  // 1. 解析用户消息
  const userMessage = extractTextFromMessage(message);
  
  // 2. 多模态处理
  if (message.hasAudio) {
    const audioText = await transcribeAudio(message.audioUrl);
    userMessage += `\n[语音]: ${audioText}`;
  }
  
  // 3. 项目路由
  const { project, actualMessage } = parseProjectRoute(userMessage);
  const workspacePath = getProjectPath(project);
  
  // 4. 系统指令检查
  if (actualMessage.startsWith('/')) {
    return await handleSystemCommand(actualMessage);
  }
  
  // 5. 启动 Cursor CLI
  const sessionId = getOrCreateSessionId(workspacePath);
  await executeCursorCLI(workspacePath, sessionId, actualMessage);
}
```

### 2. 记忆系统扩展

**文件**：`shared/memory.ts`

```typescript
// 添加新的记忆类型
export interface MemoryEntry {
  id: string;
  timestamp: number;
  content: string;
  embedding?: number[];
  metadata?: {
    source: 'user' | 'ai' | 'system';
    tags: string[];
    // 新增字段
    priority?: 'high' | 'medium' | 'low';
    category?: string;
  };
}

// 添加新的搜索方法
export class MemoryManager {
  async searchByCategory(category: string): Promise<MemoryEntry[]> {
    const db = new Database(this.dbPath);
    const results = db.query(
      'SELECT * FROM memories WHERE json_extract(metadata, "$.category") = ?',
      [category]
    ).all();
    return results as MemoryEntry[];
  }
}
```

### 3. 定时任务扩展

**文件**：`shared/scheduler.ts`

```typescript
// 添加新的任务类型
export interface CronJob {
  id: string;
  type: 'cron' | 'interval' | 'once' | 'recurring';  // 新增 recurring
  schedule: string;
  project: string;
  command: string;
  enabled: boolean;
  // 新增字段
  retryOnFailure?: boolean;
  maxRetries?: number;
}

// 添加任务重试逻辑
export class Scheduler {
  private async executeWithRetry(job: CronJob, maxRetries: number = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.executeJob(job);
        return;
      } catch (error) {
        if (attempt === maxRetries) throw error;
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  }
}
```

### 4. 新增系统指令

在 `server.ts` 的指令处理函数中添加：

```typescript
async function handleSystemCommand(command: string): Promise<string> {
  if (command.startsWith('/mystats')) {
    // 实现新指令
    const stats = await collectStats();
    return `统计数据：\n${JSON.stringify(stats, null, 2)}`;
  }
  
  // 其他指令...
}
```

## 测试

### 单元测试

```bash
# 安装测试框架
bun add -d bun:test

# 创建测试文件
# shared/memory.test.ts
import { test, expect } from 'bun:test';
import { MemoryManager } from './memory';

test('记忆搜索', async () => {
  const manager = new MemoryManager('/tmp/test-workspace');
  await manager.addMemory('测试内容');
  const results = await manager.search('测试');
  expect(results.length).toBeGreaterThan(0);
});

# 运行测试
bun test
```

### 集成测试

```bash
# 创建测试脚本
# test/integration.ts
import { spawn } from 'bun';

// 1. 启动服务
const server = spawn(['bun', 'run', 'server.ts'], {
  cwd: './feishu',
});

// 2. 发送测试消息
await sendTestMessage('你好');

// 3. 验证响应
const response = await waitForResponse();
expect(response).toContain('你好');

// 4. 清理
server.kill();
```

### 手动测试

1. **测试消息收发**：
   ```
   在飞书/钉钉中发送：你好
   期望：收到 AI 回复
   ```

2. **测试项目路由**：
   ```
   发送：test: 列出文件
   期望：列出 test 项目的文件
   ```

3. **测试多模态**：
   ```
   发送语音消息
   期望：识别文字 + AI 回复
   ```

4. **测试指令**：
   ```
   发送：/status
   期望：显示服务状态
   ```

## 调试技巧

### 1. 查看详细日志

```bash
# 方式一：直接运行（推荐）
cd feishu
bun run server.ts

# 方式二：查看服务日志
cd feishu
bash service.sh logs -f  # 实时滚动
```

### 2. 调试 Cursor CLI

```bash
# 手动运行 CLI 测试
~/.local/bin/agent \
  --workspace=/path/to/project \
  --resume=test-session-id \
  "列出所有 TypeScript 文件"
```

### 3. 调试记忆系统

```bash
# 使用 memory-tool.ts
cd feishu
bun run memory-tool.ts search "关键词"
bun run memory-tool.ts add "新记忆内容"
bun run memory-tool.ts stats
```

### 4. 调试定时任务

```bash
# 查看任务配置
cat cron-jobs-feishu.json

# 手动触发任务
cd feishu
bun -e "
import { Scheduler } from '../shared/scheduler.ts';
const scheduler = new Scheduler('./cron-jobs-feishu.json', 'feishu');
await scheduler.executeJobById('任务ID');
"
```

### 5. VSCode/Cursor 调试配置

创建 `.vscode/launch.json`：

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "bun",
      "request": "launch",
      "name": "Debug Feishu Server",
      "program": "${workspaceFolder}/feishu/server.ts",
      "cwd": "${workspaceFolder}/feishu",
      "env": {},
      "stopOnEntry": false,
      "outFiles": ["${workspaceFolder}/**/*.js"]
    }
  ]
}
```

## 代码规范

### TypeScript 风格

```typescript
// ✅ 好的实践
export async function processMessage(message: string): Promise<string> {
  const result = await doSomething(message);
  return result;
}

// ❌ 避免
async function processMessage(message) {  // 缺少类型
  return await doSomething(message);      // 不必要的 await
}
```

### 错误处理

```typescript
// ✅ 好的实践
try {
  await riskyOperation();
} catch (error) {
  console.error('操作失败:', error);
  // 记录日志、发送告警、返回友好提示
  throw new Error(`操作失败: ${error.message}`);
}

// ❌ 避免
try {
  await riskyOperation();
} catch (error) {
  // 吞掉错误
}
```

### 日志规范

```typescript
// ✅ 好的实践
console.log('[Feishu] 收到消息:', messageId);
console.error('[Feishu] 处理失败:', error);

// ❌ 避免
console.log('msg', messageId);  // 不清晰
console.log(error);             // 没有上下文
```

## 性能优化

### 1. 避免重复启动 Cursor CLI

```typescript
// ✅ 使用会话队列
const sessionQueues = new Map<string, Promise<void>>();

async function executeCLI(workspaceId: string, message: string) {
  const queue = sessionQueues.get(workspaceId) || Promise.resolve();
  const newQueue = queue.then(() => actualExecute(workspaceId, message));
  sessionQueues.set(workspaceId, newQueue);
  return newQueue;
}
```

### 2. 缓存项目配置

```typescript
let cachedProjects: ProjectsConfig | null = null;
let lastModified = 0;

function loadProjects(): ProjectsConfig {
  const stat = Bun.file('projects.json').stat();
  if (cachedProjects && stat.mtime === lastModified) {
    return cachedProjects;
  }
  cachedProjects = JSON.parse(Bun.file('projects.json').text());
  lastModified = stat.mtime;
  return cachedProjects;
}
```

### 3. 限制并发

```typescript
const MAX_CONCURRENT = 3;
const semaphore = new Semaphore(MAX_CONCURRENT);

async function handleMessage(msg: string) {
  await semaphore.acquire();
  try {
    await processMessage(msg);
  } finally {
    semaphore.release();
  }
}
```

## Git 工作流

### 分支管理

```bash
# 创建功能分支
git checkout -b feature/new-feature

# 开发完成后
git add .
git commit -m "feat: 添加新功能"
git push origin feature/new-feature

# 创建 Pull Request
```

### Commit 规范

使用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat: 新功能
fix: 修复 Bug
docs: 文档更新
refactor: 代码重构
test: 测试
chore: 构建/工具
```

示例：
```bash
git commit -m "feat: 添加文件发送功能"
git commit -m "fix: 修复语音识别失败问题"
git commit -m "docs: 更新 README"
```

## 发布流程

### 1. 版本更新

```bash
# 更新 package.json 版本号
bun version patch  # 1.0.0 → 1.0.1
bun version minor  # 1.0.0 → 1.1.0
bun version major  # 1.0.0 → 2.0.0
```

### 2. 更新 CHANGELOG

编辑 `CHANGELOG.md`：

```markdown
## [1.1.0] - 2026-03-15

### Added
- 新增文件发送功能
- 新增心跳系统

### Fixed
- 修复语音识别失败问题

### Changed
- 优化记忆搜索性能
```

### 3. 创建 Tag

```bash
git tag -a v1.1.0 -m "Release v1.1.0"
git push origin v1.1.0
```

## 常见问题

### Q: 如何调试 Cursor CLI 启动失败？

```bash
# 1. 检查 CLI 是否安装
which agent
~/.local/bin/agent --version

# 2. 检查登录状态
~/.local/bin/agent login

# 3. 手动运行测试
~/.local/bin/agent --workspace=/tmp "你好"
```

### Q: 如何清理开发环境？

```bash
# 停止所有服务
cd feishu && bash service.sh stop
cd ../dingtalk && bash service.sh stop

# 清理日志
rm -rf feishu/logs dingtalk/logs

# 清理测试数据库
find . -name ".memory.sqlite" -delete
```

### Q: 如何贡献代码？

参见 [CONTRIBUTING.md](../CONTRIBUTING.md)

## 参考资源

- [Bun 文档](https://bun.sh/docs)
- [Cursor Agent CLI](https://cursor.com)
- [飞书开放平台](https://open.feishu.cn/document)
- [钉钉开放平台](https://open.dingtalk.com)
- [火山引擎语音识别](https://www.volcengine.com/docs/6561/80820)
