# 共享模块重构设计文档

**日期**: 2026-03-14  
**状态**: 已批准  
**目标**: 消除 dingtalk/ 和 feishu/ 目录间的代码重复，提升代码可维护性

---

## 背景与动机

### 当前问题

项目中 `dingtalk/` 和 `feishu/` 目录存在大量重复代码：
- `memory.ts` - 记忆管理（向量索引、增量更新）
- `scheduler.ts` - 定时任务调度器
- `heartbeat.ts` - 心跳监控
- `bridge.ts` - OpenAI API 桥接服务
- `sync-apple-notes.ts` - Apple Notes 同步

每次修改需要在两个目录同步更新，容易遗漏，维护成本高。

### 目标

1. **减少代码重复**：将通用模块提取到共享目录
2. **保持独立部署能力**：支持仅运行钉钉或飞书服务
3. **零功能影响**：重构后行为与原有实现完全一致
4. **降低风险**：采用保守策略，保留回滚能力

---

## 设计方案

### 架构选择

采用**简单目录共享**方案（方案 1）：

```
cursor-remote-control/
├── shared/              # 新增：共享模块目录
│   ├── memory.ts       
│   ├── scheduler.ts    
│   ├── heartbeat.ts    
│   └── sync-apple-notes.ts
│
├── dingtalk/
│   ├── bridge.ts       # 保留（依赖本地 .env）
│   ├── server-minimal.ts
│   └── ...
│
└── feishu/
    ├── bridge.ts       # 保留（依赖本地 .env）
    ├── server.ts
    └── ...
```

**为何选择此方案：**
- 满足同机部署 + 独立启动需求
- 改动最小，只需移动文件 + 修改 import
- 风险最低，易于测试和回滚

**方案比较：**
| 方案 | 优点 | 缺点 | 结论 |
|------|------|------|------|
| 简单目录共享 | 改动小、风险低 | 未来独立部署需调整 | ✅ 采用 |
| 核心库分离 | 职责清晰 | 复杂度略高 | ❌ 过度设计 |
| Monorepo | 支持独立发布 | 维护成本高 | ❌ 不适用 |

---

## 模块分析

### 可共享模块（4个）

| 模块 | 路径依赖 | 可移动性 | 说明 |
|------|---------|---------|------|
| memory.ts | 无 | ✅ 可安全移动 | 纯逻辑模块 |
| scheduler.ts | 无 | ✅ 可安全移动 | 纯逻辑模块 |
| heartbeat.ts | 无 | ✅ 可安全移动 | 纯逻辑模块 |
| sync-apple-notes.ts | `import.meta.dirname` | ✅ 可移动 | 使用相对路径找项目根目录，移动后逻辑不变 |

### 保留在各自目录的模块（1个）

| 模块 | 原因 | 影响 |
|------|------|------|
| bridge.ts | 依赖本地 `.env` 文件（`resolve(import.meta.dirname, ".env")`） | 保持独立反而更合理，配置与平台绑定 |

**bridge.ts 为何不共享：**
- 读取 `dingtalk/.env` 或 `feishu/.env` 获取 API Key 和模型配置
- 移动到 shared/ 会导致读取 `shared/.env`（不存在）
- 改造成本高，且配置本就应该分离

---

## Import 路径变化

### 修改规则

```typescript
// dingtalk/server-minimal.ts 和 feishu/server.ts

// 修改前
import { MemoryManager } from './memory.ts';
import { Scheduler } from './scheduler.ts';
import { HeartbeatRunner } from './heartbeat.ts';

// 修改后
import { MemoryManager } from '../shared/memory.ts';
import { Scheduler } from '../shared/scheduler.ts';
import { HeartbeatRunner } from '../shared/heartbeat.ts';
```

### 受影响文件

**dingtalk/ 目录：**
- `server-minimal.ts` - 主服务文件
- `server.ts` - 备用服务文件（如果存在）

**feishu/ 目录：**
- `server.ts` - 主服务文件

---

## 兼容性保证

### 不变的部分

| 项目 | 说明 |
|------|------|
| 运行时 | 仍用 Bun，启动命令不变 |
| 工作目录 | `cd dingtalk && bun run server-minimal.ts` |
| 配置文件 | `.env` 位置和格式保持不变 |
| 数据文件 | `cron-jobs.json`、`embeddings-cache/` 等位置不变 |
| 功能行为 | 记忆、定时、心跳、同步逻辑完全一致 |

### 路径逻辑验证

**sync-apple-notes.ts：**
```typescript
// 移动前：dingtalk/sync-apple-notes.ts
const WORKSPACE = resolve(import.meta.dirname, ".."); 
// → /Users/keunsy/work/cursor/cursor-remote-control

// 移动后：shared/sync-apple-notes.ts
const WORKSPACE = resolve(import.meta.dirname, ".."); 
// → /Users/keunsy/work/cursor/cursor-remote-control （不变！）
```

---

## 测试策略

### 1. 编译检查
```bash
bunx tsc --noEmit
```
验证所有 import 路径正确，类型定义无误。

### 2. 服务启动测试
```bash
# 测试钉钉服务
cd dingtalk && bun run server-minimal.ts

# 测试飞书服务  
cd feishu && bun run server.ts
```
验证两个服务能正常启动，无模块找不到错误。

### 3. 功能验证

| 功能 | 验证方法 |
|------|---------|
| 记忆管理 | 发送消息，检查 embeddings-cache/ 更新 |
| 定时任务 | 运行 `/状态` 命令，确认调度器正常 |
| 心跳监控 | 查看日志，确认心跳记录正常 |
| Apple Notes 同步 | 运行 `bun sync-apple-notes.ts`，验证输出目录 |

### 4. 对比测试
备份原文件后，用新旧版本各启动一次，对比行为是否一致。

---

## 风险评估与缓解

| 风险点 | 影响等级 | 缓解措施 | 回滚时间 |
|--------|---------|---------|---------|
| Import 路径错误 | 🔴 高 | TypeScript 编译检查 + 启动测试 | < 1 分钟 |
| 运行时文件找不到 | 🟡 中 | 保留原文件备份，测试通过再删除 | < 2 分钟 |
| 数据文件路径变化 | 🟢 低 | 已验证无影响（路径逻辑不变） | 无需回滚 |

### 回滚方案

**Git 回滚（推荐）：**
```bash
git checkout HEAD -- dingtalk/ feishu/ shared/
```

**手动回滚：**
```bash
rm -rf shared/
git restore dingtalk/memory.ts dingtalk/scheduler.ts \
           dingtalk/heartbeat.ts dingtalk/sync-apple-notes.ts \
           feishu/memory.ts feishu/scheduler.ts \
           feishu/heartbeat.ts feishu/sync-apple-notes.ts
```

---

## 实施步骤

1. **创建 shared/ 目录**
2. **复制文件到 shared/**（4个模块）
3. **批量更新 import 路径**（dingtalk/ 和 feishu/ 相关文件）
4. **运行 TypeScript 检查**
5. **启动服务测试**（dingtalk 和 feishu 分别测试）
6. **功能验证**（记忆、定时、心跳、同步）
7. **清理原文件**（删除 dingtalk/ 和 feishu/ 的 4 个重复文件）
8. **更新文档**（README 说明新结构）
9. **提交代码**

---

## 预期收益

### 代码质量

- ✅ **减少重复代码 80%**：5 个模块中 4 个共享
- ✅ **降低维护成本**：修改一次，两处生效
- ✅ **减少 Bug 风险**：消除同步遗漏的可能

### 开发体验

- ✅ **代码结构更清晰**：`shared/` 目录明确表达共享意图
- ✅ **易于扩展**：未来新增平台可直接复用 shared/
- ✅ **测试更简单**：共享模块只需测试一次

### 性能影响

- ❌ **无负面影响**：仅路径变化，运行时逻辑完全相同

---

## 后续优化

### 短期（可选）

- [ ] 为 shared/ 模块添加单元测试
- [ ] 更新 CI/CD 流程（如有）
- [ ] 添加 shared/ 模块的 JSDoc 文档

### 长期（未来考虑）

- [ ] 如需独立部署，可将 shared/ 封装为 npm package
- [ ] 考虑提取更多通用逻辑（如日志、错误处理）
- [ ] 探索 bridge.ts 的可共享性（需改造配置机制）

---

## 附录

### 文件清单

**将移动到 shared/ 的文件：**
- `dingtalk/memory.ts` → `shared/memory.ts`
- `dingtalk/scheduler.ts` → `shared/scheduler.ts`
- `dingtalk/heartbeat.ts` → `shared/heartbeat.ts`
- `dingtalk/sync-apple-notes.ts` → `shared/sync-apple-notes.ts`

**将修改 import 的文件：**
- `dingtalk/server-minimal.ts`
- `dingtalk/server.ts`（如存在）
- `feishu/server.ts`

**保持不变的文件：**
- `dingtalk/bridge.ts`
- `feishu/bridge.ts`
- 所有 `.env` 文件
- 所有数据文件（`cron-jobs.json`、`embeddings-cache/` 等）

---

**设计批准人**: 用户  
**设计日期**: 2026-03-14  
**预计实施时间**: 1-2 小时
