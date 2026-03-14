# 共享模块重构实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 dingtalk/ 和 feishu/ 的重复模块提取到 shared/ 目录，减少 80% 代码重复

**Architecture:** 创建 shared/ 目录，移动 4 个通用模块（memory, scheduler, heartbeat, sync-apple-notes），更新 import 路径，保留 bridge.ts 在各自目录

**Tech Stack:** TypeScript, Bun runtime, Git

---

## Task 1: 创建共享目录并复制文件

**Files:**
- Create: `shared/` (directory)
- Create: `shared/memory.ts`
- Create: `shared/scheduler.ts`
- Create: `shared/heartbeat.ts`
- Create: `shared/sync-apple-notes.ts`

**Step 1: 创建 shared 目录**

```bash
mkdir -p /Users/keunsy/work/cursor/cursor-remote-control/shared
```

Expected: 目录创建成功

**Step 2: 复制 memory.ts 到 shared/**

```bash
cp /Users/keunsy/work/cursor/cursor-remote-control/dingtalk/memory.ts \
   /Users/keunsy/work/cursor/cursor-remote-control/shared/memory.ts
```

Expected: 文件复制成功

**Step 3: 复制 scheduler.ts 到 shared/**

```bash
cp /Users/keunsy/work/cursor/cursor-remote-control/dingtalk/scheduler.ts \
   /Users/keunsy/work/cursor/cursor-remote-control/shared/scheduler.ts
```

Expected: 文件复制成功

**Step 4: 复制 heartbeat.ts 到 shared/**

```bash
cp /Users/keunsy/work/cursor/cursor-remote-control/dingtalk/heartbeat.ts \
   /Users/keunsy/work/cursor/cursor-remote-control/shared/heartbeat.ts
```

Expected: 文件复制成功

**Step 5: 复制 sync-apple-notes.ts 到 shared/**

```bash
cp /Users/keunsy/work/cursor/cursor-remote-control/dingtalk/sync-apple-notes.ts \
   /Users/keunsy/work/cursor/cursor-remote-control/shared/sync-apple-notes.ts
```

Expected: 文件复制成功

**Step 6: 验证文件已复制**

```bash
ls -la /Users/keunsy/work/cursor/cursor-remote-control/shared/
```

Expected: 显示 4 个 .ts 文件（memory, scheduler, heartbeat, sync-apple-notes）

---

## Task 2: 更新 dingtalk/server-minimal.ts 的 import 路径

**Files:**
- Modify: `dingtalk/server-minimal.ts:19-21`

**Step 1: 找到现有 import 语句**

Current imports (around line 19-21):
```typescript
import { Scheduler, type CronJob } from './scheduler.js';
import { MemoryManager } from './memory.js';
import { HeartbeatRunner } from './heartbeat.js';
```

**Step 2: 更新 import 路径**

Replace with:
```typescript
import { Scheduler, type CronJob } from '../shared/scheduler.js';
import { MemoryManager } from '../shared/memory.js';
import { HeartbeatRunner } from '../shared/heartbeat.js';
```

**Step 3: 验证修改**

```bash
grep -n "from '../shared/" /Users/keunsy/work/cursor/cursor-remote-control/dingtalk/server-minimal.ts
```

Expected: 显示 3 行修改后的 import 语句

---

## Task 3: 更新 feishu/server.ts 的 import 路径

**Files:**
- Modify: `feishu/server.ts:20-22`

**Step 1: 找到现有 import 语句**

Current imports (around line 20-22):
```typescript
import { MemoryManager } from "./memory.js";
import { Scheduler, type CronJob } from "./scheduler.js";
import { HeartbeatRunner } from "./heartbeat.js";
```

**Step 2: 更新 import 路径**

Replace with:
```typescript
import { MemoryManager } from "../shared/memory.js";
import { Scheduler, type CronJob } from "../shared/scheduler.js";
import { HeartbeatRunner } from "../shared/heartbeat.js";
```

**Step 3: 验证修改**

```bash
grep -n "from \"../shared/" /Users/keunsy/work/cursor/cursor-remote-control/feishu/server.ts
```

Expected: 显示 3 行修改后的 import 语句

---

## Task 4: 检查是否有其他文件引用这些模块

**Files:**
- Check: `dingtalk/*.ts`
- Check: `feishu/*.ts`

**Step 1: 搜索 dingtalk/ 目录中的引用**

```bash
cd /Users/keunsy/work/cursor/cursor-remote-control
grep -r "from './memory'" dingtalk/*.ts 2>/dev/null || echo "No matches"
grep -r "from './scheduler'" dingtalk/*.ts 2>/dev/null || echo "No matches"
grep -r "from './heartbeat'" dingtalk/*.ts 2>/dev/null || echo "No matches"
grep -r "from './sync-apple-notes'" dingtalk/*.ts 2>/dev/null || echo "No matches"
```

Expected: 如果有输出，需要在下一步更新这些文件

**Step 2: 搜索 feishu/ 目录中的引用**

```bash
cd /Users/keunsy/work/cursor/cursor-remote-control
grep -r "from \"./memory\"" feishu/*.ts 2>/dev/null || echo "No matches"
grep -r "from \"./scheduler\"" feishu/*.ts 2>/dev/null || echo "No matches"
grep -r "from \"./heartbeat\"" feishu/*.ts 2>/dev/null || echo "No matches"
grep -r "from \"./sync-apple-notes\"" feishu/*.ts 2>/dev/null || echo "No matches"
```

Expected: 如果有输出，需要更新这些文件的 import 路径

**Step 3: 如果发现其他引用，手动更新**

对于每个找到的文件，将 `./xxx` 替换为 `../shared/xxx`

---

## Task 5: 运行 TypeScript 编译检查

**Files:**
- Check: All TypeScript files

**Step 1: 运行 TypeScript 编译器**

```bash
cd /Users/keunsy/work/cursor/cursor-remote-control
bunx tsc --noEmit
```

Expected: 无错误输出（或只有预先存在的错误）

**Step 2: 如果有新的类型错误，修复 import 路径**

常见问题：
- 缺少 `.js` 扩展名
- 路径层级错误（`../shared/` vs `./shared/`）
- 模块名拼写错误

**Step 3: 重新运行直到无错误**

```bash
bunx tsc --noEmit
```

Expected: 编译通过

---

## Task 6: 测试 dingtalk 服务启动

**Files:**
- Test: `dingtalk/server-minimal.ts`

**Step 1: 启动 dingtalk 服务**

```bash
cd /Users/keunsy/work/cursor/cursor-remote-control/dingtalk
timeout 10 bun run server-minimal.ts 2>&1 | head -n 20
```

Expected: 服务正常启动，无 "Cannot find module" 错误

**Step 2: 检查日志输出**

Look for:
- ✅ "钉钉机器人服务启动"
- ✅ "记忆系统初始化"
- ✅ "调度器启动"
- ✅ "心跳监控启动"
- ❌ 无 "Cannot find module '../shared/xxx'" 错误

**Step 3: 停止服务**

```bash
# Ctrl+C or kill process
```

---

## Task 7: 测试 feishu 服务启动

**Files:**
- Test: `feishu/server.ts`

**Step 1: 启动 feishu 服务**

```bash
cd /Users/keunsy/work/cursor/cursor-remote-control/feishu
timeout 10 bun run server.ts 2>&1 | head -n 20
```

Expected: 服务正常启动，无 "Cannot find module" 错误

**Step 2: 检查日志输出**

Look for:
- ✅ "飞书机器人服务启动"
- ✅ "记忆系统初始化"
- ✅ "调度器启动"
- ✅ "心跳监控启动"
- ❌ 无 "Cannot find module '../shared/xxx'" 错误

**Step 3: 停止服务**

```bash
# Ctrl+C or kill process
```

---

## Task 8: 功能验证测试

**Files:**
- Test: `shared/sync-apple-notes.ts`

**Step 1: 测试 Apple Notes 同步路径逻辑**

```bash
cd /Users/keunsy/work/cursor/cursor-remote-control/shared
bun run sync-apple-notes.ts --help 2>&1 | head -n 10
```

Expected: 显示使用说明，无路径错误

**Step 2: 验证输出目录路径**

Check that `sync-apple-notes.ts` still resolves to project root:
```bash
grep -n "resolve(import.meta.dirname" /Users/keunsy/work/cursor/cursor-remote-control/shared/sync-apple-notes.ts
```

Expected: Line 17-18 显示 `resolve(import.meta.dirname, "..")`

**Step 3: 确认路径逻辑正确**

Path resolution:
- Before: `dingtalk/sync-apple-notes.ts` → `import.meta.dirname` = `dingtalk/` → `..` = project root
- After: `shared/sync-apple-notes.ts` → `import.meta.dirname` = `shared/` → `..` = project root
- ✅ Result: Same

---

## Task 9: 删除重复文件

**Files:**
- Delete: `dingtalk/memory.ts`
- Delete: `dingtalk/scheduler.ts`
- Delete: `dingtalk/heartbeat.ts`
- Delete: `dingtalk/sync-apple-notes.ts`
- Delete: `feishu/memory.ts`
- Delete: `feishu/scheduler.ts`
- Delete: `feishu/heartbeat.ts`
- Delete: `feishu/sync-apple-notes.ts`

**Step 1: 删除 dingtalk/ 中的重复文件**

```bash
cd /Users/keunsy/work/cursor/cursor-remote-control
rm dingtalk/memory.ts
rm dingtalk/scheduler.ts
rm dingtalk/heartbeat.ts
rm dingtalk/sync-apple-notes.ts
```

Expected: 文件删除成功

**Step 2: 删除 feishu/ 中的重复文件**

```bash
rm feishu/memory.ts
rm feishu/scheduler.ts
rm feishu/heartbeat.ts
rm feishu/sync-apple-notes.ts
```

Expected: 文件删除成功

**Step 3: 验证文件已删除**

```bash
ls dingtalk/memory.ts 2>&1
ls feishu/memory.ts 2>&1
```

Expected: "No such file or directory" 错误（说明已删除）

---

## Task 10: 再次运行完整测试

**Files:**
- Test: All services

**Step 1: 重新运行 TypeScript 检查**

```bash
cd /Users/keunsy/work/cursor/cursor-remote-control
bunx tsc --noEmit
```

Expected: 无新增错误

**Step 2: 重新测试 dingtalk 服务**

```bash
cd dingtalk
timeout 10 bun run server-minimal.ts 2>&1 | head -n 20
```

Expected: 正常启动

**Step 3: 重新测试 feishu 服务**

```bash
cd ../feishu
timeout 10 bun run server.ts 2>&1 | head -n 20
```

Expected: 正常启动

---

## Task 11: 更新项目文档

**Files:**
- Modify: `README.md`

**Step 1: 在 README.md 中添加目录结构说明**

找到项目结构部分，添加 `shared/` 目录说明：

```markdown
## 项目结构

```
cursor-remote-control/
├── shared/              # 共享模块
│   ├── memory.ts       # 记忆管理
│   ├── scheduler.ts    # 定时任务调度
│   ├── heartbeat.ts    # 心跳监控
│   └── sync-apple-notes.ts  # Apple Notes 同步
├── dingtalk/           # 钉钉服务
├── feishu/             # 飞书服务
└── templates/          # 工作区模板
```
```

**Step 2: 验证文档更新**

```bash
grep -A 10 "shared/" /Users/keunsy/work/cursor/cursor-remote-control/README.md
```

Expected: 显示新增的 shared/ 目录说明

---

## Task 12: 提交代码

**Files:**
- Commit: All changes

**Step 1: 查看修改状态**

```bash
cd /Users/keunsy/work/cursor/cursor-remote-control
git status
```

Expected: 
- New: `shared/` directory with 4 files
- Modified: `dingtalk/server-minimal.ts`, `feishu/server.ts`
- Deleted: 8 files (4 from dingtalk, 4 from feishu)
- Modified: `README.md`

**Step 2: 暂存所有变更**

```bash
git add shared/
git add dingtalk/server-minimal.ts feishu/server.ts
git add README.md
git add -u dingtalk/ feishu/  # 暂存删除的文件
```

**Step 3: 提交代码**

```bash
git commit -m "$(cat <<'EOF'
refactor: 提取共享模块到 shared/ 目录

- 创建 shared/ 目录，包含 4 个共享模块
  - memory.ts: 记忆管理
  - scheduler.ts: 定时任务调度
  - heartbeat.ts: 心跳监控
  - sync-apple-notes.ts: Apple Notes 同步

- 更新 import 路径
  - dingtalk/server-minimal.ts
  - feishu/server.ts

- 删除重复文件
  - 从 dingtalk/ 和 feishu/ 删除 4 个模块

- 保留 bridge.ts 在各自目录（依赖本地 .env）

- 更新 README.md 说明新结构

收益：减少 80% 代码重复，降低维护成本
EOF
)"
```

Expected: 提交成功

**Step 4: 验证提交**

```bash
git log -1 --stat
```

Expected: 显示最新提交，包含所有变更文件

---

## 验证清单

完成所有任务后，确认：

- ✅ `shared/` 目录包含 4 个模块
- ✅ `dingtalk/server-minimal.ts` 和 `feishu/server.ts` 使用 `../shared/` import
- ✅ `bridge.ts` 仍在 `dingtalk/` 和 `feishu/` 目录
- ✅ `bunx tsc --noEmit` 无新增错误
- ✅ 两个服务都能正常启动
- ✅ 重复文件已删除
- ✅ README.md 已更新
- ✅ 代码已提交到 git

---

## 回滚步骤（如需要）

如果出现问题，可以快速回滚：

```bash
git reset --hard HEAD~1
```

或手动恢复：

```bash
git restore dingtalk/memory.ts dingtalk/scheduler.ts \
           dingtalk/heartbeat.ts dingtalk/sync-apple-notes.ts \
           feishu/memory.ts feishu/scheduler.ts \
           feishu/heartbeat.ts feishu/sync-apple-notes.ts
rm -rf shared/
git restore dingtalk/server-minimal.ts feishu/server.ts README.md
```
