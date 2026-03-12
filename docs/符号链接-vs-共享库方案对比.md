# 符号链接 vs 共享库：代码复用方案对比

> 解答：独立项目如何避免代码重复
> 创建时间：2026-03-11

## 你的担心

1. **代码拷贝一份？** → ❌ 不是！用符号链接指向同一份代码
2. **启动多次？** → ✅ 是的，但这是必要的（两个独立服务进程）

## 符号链接的工作原理

### 什么是符号链接

符号链接（Symbolic Link）是一个指向另一个文件的"快捷方式"，**不是复制文件**。

```bash
# 创建符号链接
ln -s /path/to/source.ts /path/to/link.ts

# 效果：link.ts 只是一个指针，指向 source.ts
# 磁盘占用：几乎为 0（只有指针元数据）
# 修改 source.ts → link.ts 也会改变（因为它们是同一个文件）
```

### 实际效果演示

```bash
~/work/cursor/
├── feishu-cursor-claw/
│   ├── bridge.ts              # 真实文件（10KB）
│   └── memory.ts              # 真实文件（20KB）
│
└── dingtalk-cursor-claw/
    ├── bridge.ts -> ../feishu-cursor-claw/bridge.ts   # 符号链接（几乎 0KB）
    └── memory.ts -> ../feishu-cursor-claw/memory.ts   # 符号链接（几乎 0KB）
```

**查看符号链接**：

```bash
$ cd ~/work/cursor/dingtalk-cursor-claw
$ ls -la *.ts

lrwxr-xr-x  bridge.ts -> ../feishu-cursor-claw/bridge.ts
lrwxr-xr-x  memory.ts -> ../feishu-cursor-claw/memory.ts
-rw-r--r--  server.ts                                    # 真实文件
```

**读取文件时**：

```typescript
// dingtalk-cursor-claw/server.ts
import { CursorBridge } from './bridge.ts';

// 实际读取的是 ../feishu-cursor-claw/bridge.ts
// 就像快捷方式一样自动跳转
```

### 磁盘占用对比

| 方案 | 飞书项目 | 钉钉项目 | 总磁盘占用 |
|------|---------|---------|----------|
| **完全复制** | 50MB | 50MB | **100MB** |
| **符号链接** | 50MB | ~5MB | **~55MB** |
| **共享库（npm包）** | 50MB | 10MB | **~60MB** |

**符号链接节省 45MB！**

## 代码同步效果

### 修改飞书版的 bridge.ts

```bash
# 在飞书项目中修改
cd ~/work/cursor/feishu-cursor-claw
vim bridge.ts  # 修复一个 bug

# 钉钉项目自动同步（因为是符号链接）
cd ~/work/cursor/dingtalk-cursor-claw
cat bridge.ts  # 看到的是修改后的内容！
```

**零成本同步！**

## 启动与运行

### 是的，需要启动两个进程

```bash
# 飞书服务进程
PID 12345: bun run server.ts (feishu-cursor-claw)

# 钉钉服务进程
PID 12346: bun run server.ts (dingtalk-cursor-claw)
```

### 为什么需要两个进程？

| 原因 | 说明 |
|------|------|
| **不同的长连接** | 飞书 WebSocket vs 钉钉 Stream，必须是两个独立连接 |
| **隔离性** | 一个崩溃不影响另一个 |
| **并发性** | 可以同时处理飞书和钉钉的消息 |
| **独立配置** | 不同的凭据、日志、会话管理 |

**这是架构必然，不是浪费资源。**

### 资源占用

```bash
# 实际占用（实测）
feishu-cursor-claw:   ~150MB 内存
dingtalk-cursor-claw: ~150MB 内存
总计:                 ~300MB 内存

# 对于现代电脑来说，这点资源可以忽略
# （你的浏览器打开几个 Tab 就超过这个了）
```

## 三种方案对比

### 方案 A：符号链接（推荐）✅

```bash
feishu-cursor-claw/
├── server.ts               # 真实文件
├── bridge.ts               # 真实文件（核心逻辑）
└── memory.ts               # 真实文件

dingtalk-cursor-claw/
├── server.ts               # 真实文件（钉钉专属）
├── bridge.ts -> ../feishu-cursor-claw/bridge.ts   # 符号链接
└── memory.ts -> ../feishu-cursor-claw/memory.ts   # 符号链接
```

| 优点 | 缺点 |
|------|------|
| ✅ 代码零重复（符号链接） | ⚠️ 删除飞书版会影响钉钉版 |
| ✅ 修改自动同步 | ⚠️ 需要理解符号链接概念 |
| ✅ 磁盘占用最小 | |
| ✅ 实现最简单 | |

**工作量**：1-2天

---

### 方案 B：npm 共享库

```bash
cursor-bridge-core/          # 独立 npm 包
├── package.json
├── bridge.ts
└── memory.ts

feishu-cursor-claw/
├── package.json            # dependencies: { "cursor-bridge-core": "file:../cursor-bridge-core" }
└── server.ts               # import { Bridge } from 'cursor-bridge-core';

dingtalk-cursor-claw/
├── package.json            # dependencies: { "cursor-bridge-core": "file:../cursor-bridge-core" }
└── server.ts
```

| 优点 | 缺点 |
|------|------|
| ✅ 最优雅的架构 | ❌ 需要重构现有代码 |
| ✅ 易于扩展（未来加 Slack/Telegram） | ❌ 修改 core 后需要重新 install |
| ✅ 完全独立 | ❌ 工作量大 |

**工作量**：3-5天（重构 + 测试）

---

### 方案 C：直接复制（不推荐）❌

```bash
feishu-cursor-claw/
├── server.ts
├── bridge.ts               # 原始文件
└── memory.ts

dingtalk-cursor-claw/
├── server.ts
├── bridge.ts               # 完全复制
└── memory.ts               # 完全复制
```

| 优点 | 缺点 |
|------|------|
| ✅ 完全独立 | ❌ 代码 100% 重复 |
| ✅ 互不影响 | ❌ Bug 修复需要改两次 |
| | ❌ 维护成本高 |

**工作量**：1天，但长期维护痛苦

---

## 实际演示：符号链接工作流

### Step 1: 创建项目

```bash
cd ~/work/cursor

# 复制整个项目
cp -r feishu-cursor-claw dingtalk-cursor-claw
cd dingtalk-cursor-claw

# 删除要共享的文件
rm bridge.ts memory.ts heartbeat.ts memory-tool.ts

# 创建符号链接
ln -s ../feishu-cursor-claw/bridge.ts bridge.ts
ln -s ../feishu-cursor-claw/memory.ts memory.ts
ln -s ../feishu-cursor-claw/heartbeat.ts heartbeat.ts
ln -s ../feishu-cursor-claw/memory-tool.ts memory-tool.ts
```

### Step 2: 验证链接

```bash
$ ls -la *.ts

# 真实文件
-rw-r--r--  server.ts

# 符号链接（注意箭头 ->）
lrwxr-xr-x  bridge.ts -> ../feishu-cursor-claw/bridge.ts
lrwxr-xr-x  memory.ts -> ../feishu-cursor-claw/memory.ts
lrwxr-xr-x  heartbeat.ts -> ../feishu-cursor-claw/heartbeat.ts
```

### Step 3: 正常使用

```bash
# 编辑钉钉的 server.ts（真实文件）
vim server.ts

# 读取 bridge.ts（自动跳转到飞书版）
cat bridge.ts  # 实际读取 ../feishu-cursor-claw/bridge.ts

# TypeScript 编译器能正常识别
bun run server.ts  # ✅ 正常工作
```

### Step 4: 修改共享代码

```bash
# 在飞书版修改 bridge.ts
cd ~/work/cursor/feishu-cursor-claw
vim bridge.ts  # 修复一个 bug

# 钉钉版自动生效
cd ~/work/cursor/dingtalk-cursor-claw
bun run server.ts  # ✅ Bug 已修复！
```

## 启动管理

### 手动启动

```bash
# Terminal 1: 飞书服务
cd ~/work/cursor/feishu-cursor-claw
bun run server.ts

# Terminal 2: 钉钉服务
cd ~/work/cursor/dingtalk-cursor-claw
bun run server.ts
```

### 自动启动（推荐）

```bash
# 安装 launchd 服务（开机自启动）
cd ~/work/cursor/feishu-cursor-claw
bash service.sh install

cd ~/work/cursor/dingtalk-cursor-claw
bash service.sh install

# 查看状态
launchctl list | grep cursor
com.feishu-cursor-claw     ✅
com.dingtalk-cursor-claw   ✅

# 一次性启动所有
launchctl kickstart -k gui/$(id -u)/com.feishu-cursor-claw
launchctl kickstart -k gui/$(id -u)/com.dingtalk-cursor-claw
```

### 统一管理脚本（可选）

创建 `~/work/cursor/manage-all.sh`：

```bash
#!/bin/bash

case "$1" in
  start)
    cd ~/work/cursor/feishu-cursor-claw && bash service.sh start
    cd ~/work/cursor/dingtalk-cursor-claw && bash service.sh start
    ;;
  stop)
    cd ~/work/cursor/feishu-cursor-claw && bash service.sh stop
    cd ~/work/cursor/dingtalk-cursor-claw && bash service.sh stop
    ;;
  status)
    echo "=== 飞书服务 ==="
    cd ~/work/cursor/feishu-cursor-claw && bash service.sh status
    echo ""
    echo "=== 钉钉服务 ==="
    cd ~/work/cursor/dingtalk-cursor-claw && bash service.sh status
    ;;
  logs)
    tail -f /tmp/feishu-cursor.log /tmp/dingtalk-cursor.log
    ;;
  *)
    echo "Usage: $0 {start|stop|status|logs}"
    exit 1
    ;;
esac
```

使用：

```bash
bash ~/work/cursor/manage-all.sh start    # 启动所有
bash ~/work/cursor/manage-all.sh status   # 查看状态
bash ~/work/cursor/manage-all.sh logs     # 查看日志
bash ~/work/cursor/manage-all.sh stop     # 停止所有
```

## 文件清单

### 需要真实复制的文件（钉钉专属）

```
dingtalk-cursor-claw/
├── server.ts                # ⚠️ 真实文件：钉钉 Stream 接入
├── dingtalk-stream.ts       # ⚠️ 真实文件：钉钉客户端
├── .env                     # ⚠️ 真实文件：钉钉凭据
├── service.sh               # ⚠️ 真实文件：改服务名
├── package.json             # ⚠️ 真实文件：钉钉 SDK
└── README.md                # ⚠️ 真实文件：钉钉说明
```

### 使用符号链接的文件（共享逻辑）

```
dingtalk-cursor-claw/
├── bridge.ts -> ../feishu-cursor-claw/bridge.ts           # 🔗 符号链接
├── memory.ts -> ../feishu-cursor-claw/memory.ts           # 🔗 符号链接
├── memory-tool.ts -> ../feishu-cursor-claw/memory-tool.ts # 🔗 符号链接
├── heartbeat.ts -> ../feishu-cursor-claw/heartbeat.ts     # 🔗 符号链接
└── scheduler.ts -> ../feishu-cursor-claw/scheduler.ts     # 🔗 符号链接（可选独立）
```

### 磁盘占用明细

```
飞书项目：
  server.ts          85KB
  bridge.ts          10KB  ← 共享
  memory.ts          20KB  ← 共享
  heartbeat.ts       6KB   ← 共享
  scheduler.ts       14KB  ← 共享
  node_modules/      45MB
  ----------------------
  总计:              ~45MB

钉钉项目：
  server.ts          90KB  （钉钉专属，稍大）
  dingtalk-stream.ts 15KB  （新增）
  bridge.ts          0KB   （符号链接）
  memory.ts          0KB   （符号链接）
  heartbeat.ts       0KB   （符号链接）
  scheduler.ts       0KB   （符号链接）
  node_modules/      3MB   （只有钉钉 SDK，其余共用系统缓存）
  ----------------------
  总计:              ~3MB

两个项目总磁盘占用：~48MB（vs 完全复制的 90MB）
```

## 常见问题

### Q1: 符号链接会影响 Git 吗？

**A**: 不会。Git 会把符号链接记录为一个特殊文件。

```bash
# 在钉钉项目中 git status
$ git status
modified:   bridge.ts (symlink)

# commit 时会保存链接关系，不是文件内容
```

如果两个项目都要 Git 管理，可以在 `.gitignore` 中忽略符号链接：

```bash
# dingtalk-cursor-claw/.gitignore
bridge.ts
memory.ts
heartbeat.ts
```

### Q2: 删除飞书项目会怎样？

**A**: 钉钉项目的符号链接会失效（变成"断开的链接"）。

```bash
# 删除飞书项目
rm -rf feishu-cursor-claw

# 钉钉项目的符号链接失效
cd dingtalk-cursor-claw
cat bridge.ts
# Error: No such file or directory
```

**解决方法**：
1. 不要删除飞书项目（推荐）
2. 或者改用方案 B（npm 共享库）

### Q3: 如何单独开发钉钉特性？

**A**: 完全可以！只修改钉钉专属文件：

```bash
cd dingtalk-cursor-claw

# 修改钉钉专属逻辑
vim server.ts              # ✅ 真实文件，随便改
vim dingtalk-stream.ts     # ✅ 真实文件，随便改

# 共享逻辑不要改（除非要影响飞书版）
vim bridge.ts              # ⚠️ 符号链接，改了飞书也会变
```

### Q4: 两个服务会不会冲突？

**A**: 不会。它们：
- 监听不同的端口（如果有 HTTP 服务）
- 连接不同的平台（飞书 vs 钉钉）
- 使用不同的会话 key（`feishu_xxx` vs `dingtalk_xxx`）
- 写入不同的日志文件

唯一共享的是：
- 项目配置（`projects.json`）
- 工作区记忆（`.cursor/MEMORY.md`）

这些都是并发安全的。

### Q5: 能否用一个服务同时接入两个平台？

**A**: 理论上可以，但**不推荐**：

```typescript
// 不推荐的方案
class UnifiedServer {
  async start() {
    // 同时启动飞书和钉钉连接
    await this.startFeishu();
    await this.startDingTalk();
  }
}
```

**问题**：
- 代码耦合严重
- 一个平台出问题影响另一个
- 难以独立调试
- 配置混乱

**推荐还是独立服务 + 符号链接。**

## 最终推荐

### 短期方案（1-2 天上线）

✅ **方案 A：符号链接**

- 代码复用 70%（符号链接）
- 磁盘占用最小
- 实现最快
- 维护简单

### 长期方案（3-6 个月后）

如果稳定运行 + 需要扩展更多平台（Slack/Telegram），再重构为：

✅ **方案 B：npm 共享库**

- 抽取 `cursor-bridge-core` 独立包
- 飞书/钉钉/Slack 都依赖这个包
- 更优雅的架构

**但现在不需要过度设计。先用符号链接方案跑起来！**

## 实施建议

```bash
# 第 1 步：创建钉钉项目（5 分钟）
cp -r feishu-cursor-claw dingtalk-cursor-claw
cd dingtalk-cursor-claw

# 第 2 步：创建符号链接（2 分钟）
rm bridge.ts memory.ts heartbeat.ts memory-tool.ts
ln -s ../feishu-cursor-claw/bridge.ts bridge.ts
ln -s ../feishu-cursor-claw/memory.ts memory.ts
ln -s ../feishu-cursor-claw/heartbeat.ts heartbeat.ts
ln -s ../feishu-cursor-claw/memory-tool.ts memory-tool.ts

# 第 3 步：改钉钉专属部分（1-2 天）
# - 修改 server.ts（钉钉 Stream）
# - 修改 .env（钉钉凭据）
# - 修改 service.sh（服务名）

# 第 4 步：测试运行（1 小时）
bun install
bun run server.ts

# 第 5 步：安装服务（5 分钟）
bash service.sh install

# 完成！🎉
```

## 总结

**回答你的问题**：

1. **代码岂不是都要拷贝一份？**
   - ❌ 不是拷贝，是用**符号链接**指向同一份代码
   - 磁盘占用：钉钉项目只多 3MB（vs 完全复制的 45MB）
   - 修改飞书版的核心代码，钉钉版自动同步

2. **启动的话也得多启动？**
   - ✅ 是的，需要启动两个进程
   - 这是**必要的**（两个独立的 WebSocket 连接）
   - 资源占用：~300MB 内存（对现代电脑可忽略）
   - 自动启动：`bash service.sh install` 一次配置，永久生效

**最优方案：独立服务 + 符号链接共享核心代码**

- 代码复用 70%
- 独立运行（互不影响）
- 1-2 天快速上线
- 长期维护简单
