# Mac 锁屏状态下远程连接飞连 VPN - 设计文档

**创建日期**: 2026-03-15  
**状态**: 已批准  
**预计工作量**: 2-3 小时

---

## 背景

用户需要在 Mac 锁屏状态下通过飞书/钉钉远程控制飞连 VPN 连接，用于远程排查问题时访问内网资源。

**核心需求**：
- 远程触发飞连 VPN 开关（通过飞书/钉钉消息）
- 支持 Mac 锁屏状态下操作
- 快速响应（秒级）
- 不解锁屏幕（安全性考虑）

**当前问题**：
- Mac 锁屏时间久了飞连会自动断开
- 远程排查时无法访问内网工具
- 需要手动解锁屏幕并重连 VPN

---

## 技术方案

### 方案选择

从三个候选方案中选择了**方案 A：消息触发 + AppleScript 快捷键模拟**。

**选择理由**：
1. 实现简单，代码量小（约 150 行）
2. 按需连接，不消耗资源
3. 利用飞连原生快捷键（⌘+O），稳定可靠
4. 与现有项目集成简单，代码侵入性最小

**舍弃方案**：
- 方案 B（定时保活）：资源占用，可能与安全策略冲突
- 方案 C（LaunchAgent 守护）：实现复杂，过度设计

---

## 架构设计

### 整体架构

```
飞书/钉钉消息 → server.ts → 命令解析器
                                                ↓
                                           识别飞连指令
                                                ↓
                                         feilian-control.ts
                                                ↓
                                         AppleScript 执行
                                                ↓
                                         模拟 ⌘+O 快捷键
                                                ↓
                                    飞连 VPN 开启/关闭/切换
                                                ↓
                                    返回执行结果到飞书/钉钉
```

### 文件结构

**新增文件**：
```
shared/
├── feilian-control.ts          # 核心控制逻辑（约 150 行）
└── feilian-control.applescript # AppleScript 脚本（3 行）
```

**修改文件**：
```
feishu/server.ts                # 添加 /飞连 命令处理（约 30 行）
dingtalk/server.ts              # 添加 /飞连 命令处理（约 30 行）
README.md                       # 添加使用文档
```

---

## 技术实现

### 1. AppleScript 快捷键模拟

```applescript
-- shared/feilian-control.applescript
tell application "System Events"
    keystroke "o" using {command down}
end tell
```

**特点**：
- 全局快捷键，不依赖窗口焦点
- 锁屏状态下可执行（需辅助功能权限）

### 2. VPN 状态检测

```typescript
// 检测方法：检查 utun 网络接口
async function checkVPNStatus(): Promise<boolean> {
  const result = await Bun.$`ifconfig`.text();
  // 检查是否有活动的 utun 接口且有 IP
  return /utun\d+:[\s\S]*?inet \d+\.\d+\.\d+\.\d+/.test(result);
}
```

### 3. 核心 API

```typescript
export class FeilianController {
  // 检查 VPN 状态
  async checkStatus(): Promise<VPNStatus>
  
  // 切换 VPN（开↔关）
  async toggle(): Promise<OperationResult>
  
  // 确保 VPN 开启
  async ensureConnected(): Promise<OperationResult>
  
  // 确保 VPN 关闭
  async ensureDisconnected(): Promise<OperationResult>
  
  // 执行快捷键
  private async executeShortcut(): Promise<void>
}
```

### 4. 命令设计

| 指令 | 别名 | 功能 |
|------|------|------|
| `/飞连` | `/vpn` `/feilian` | 切换飞连状态（开↔关） |
| `/飞连 开` | `/vpn on` | 确保飞连开启 |
| `/飞连 关` | `/vpn off` | 确保飞连关闭 |
| `/飞连 状态` | `/vpn status` | 查询当前连接状态 |

---

## 系统配置

### 辅助功能权限

**配置步骤**：

1. 打开「系统设置」→「隐私与安全性」→「辅助功能」
2. 点击 [+] 添加：`/Users/你/.bun/bin/bun`
3. 重启服务：
   ```bash
   cd feishu && bash service.sh restart
   cd dingtalk && bash service.sh restart
   ```

**自动检测**：

代码会自动检测权限，如果不足会返回配置提示。

---

## 错误处理

### 常见错误场景

| 场景 | 检测方式 | 处理策略 |
|------|----------|----------|
| 飞连未安装 | 检查应用是否存在 | 提示「请先安装飞连客户端」 |
| 权限不足 | AppleScript 执行失败 | 提示配置辅助功能权限 |
| 锁屏状态失效 | 执行后状态未变化 | 提示「请解锁后重试」 |
| 网络接口检测失败 | ifconfig 无输出 | 降级到进程检测 |
| 快捷键被占用 | 执行无响应 | 提示检查飞连设置 |

### 降级方案

如果锁屏状态下快捷键失效，提示用户：

```
⚠️ 锁屏状态下操作可能失效
建议：解锁屏幕后再发送 /飞连 指令
```

---

## 用户体验

### 响应速度优化

```typescript
async toggle(): Promise<OperationResult> {
  // 1. 立即返回执行中状态（1ms）
  await sendImmediateReply('⏳ 正在切换飞连状态...');
  
  // 2. 执行快捷键（100ms）
  await this.executeShortcut();
  
  // 3. 等待 3 秒后检测状态
  await sleep(3000);
  const status = await this.checkStatus();
  
  // 4. 返回最终结果
  return status;
}
```

### 反馈消息

**成功**：
```
✅ 飞连 VPN 已连接
📡 接口: utun3
🌐 IP: 10.xxx.xxx.xxx
⏱️ 耗时: 3.2s
```

**失败（友好提示）**：
```
⚠️ 未检测到 VPN 连接

可能原因：
• 锁屏状态下快捷键失效 → 解锁后重试
• 飞连正在启动中 → 等待 10 秒后查询状态（/飞连 状态）
• 快捷键配置错误 → 检查飞连设置中的快捷键
```

---

## 安全性

### 风险评估

| 风险 | 等级 | 缓解措施 |
|------|------|----------|
| 辅助功能权限被滥用 | 🟡 中 | 仅授予 bun 进程，代码开源可审计 |
| 锁屏状态被远程控制 | 🟡 中 | 仅限 VPN 开关，不解锁屏幕 |
| 飞书/钉钉账号被盗 | 🔴 高 | 建议启用双因素认证 |
| 快捷键冲突 | 🟢 低 | 飞连快捷键可自定义 |

### 安全建议

1. ✅ 保持代码仓库私有或仅限信任的人访问
2. ✅ 定期检查 launchd 日志，监控异常调用
3. ✅ 仅在需要时启用服务，不用时可以停止
4. ✅ 不要在公共环境下使用此功能

---

## 实施计划

### 开发步骤（预计 2-3 小时）

1. ✅ 创建 `shared/feilian-control.ts`（核心逻辑）
2. ✅ 创建 `shared/feilian-control.applescript`（快捷键脚本）
3. ✅ 集成到 `feishu/server.ts`（命令处理）
4. ✅ 集成到 `dingtalk/server.ts`（命令处理）
5. ✅ 配置系统权限（辅助功能）
6. ✅ 测试验证（锁屏/解锁状态）
7. ✅ 更新 README 文档

### 测试场景

- [ ] 解锁状态下切换 VPN（应该成功）
- [ ] 锁屏状态下切换 VPN（验证权限配置）
- [ ] VPN 已连接时发送「开」指令（应该跳过）
- [ ] VPN 未连接时发送「关」指令（应该跳过）
- [ ] 查询 VPN 状态（验证 utun 接口检测）
- [ ] 权限不足时的错误提示（验证友好性）

---

## 预期效果

**成功场景**：
- 发送「/飞连」消息后 3-5 秒内连接成功
- 无需手动操作，完全远程控制
- 锁屏状态下正常工作（权限配置正确时）

**降级场景**：
- 如果锁屏状态失效，系统友好提示解锁后重试
- 错误消息清晰，引导用户自助解决

---

## 后续优化（可选）

以下功能暂不实现，根据实际使用情况决定是否需要：

1. **定时保活**：每 10 分钟自动重连（如果断连频繁）
2. **线路切换**：支持指定连接不同的 VPN 线路
3. **连接时长统计**：记录每次 VPN 连接的时长
4. **流量监控**：显示 VPN 流量使用情况

---

## 总结

本方案通过 AppleScript 模拟飞连快捷键，实现了远程 VPN 控制功能。设计上遵循最小侵入原则，代码量少，集成简单，且对现有系统影响最小。配置辅助功能权限后，可在锁屏状态下正常工作，满足用户远程排查问题的需求。
