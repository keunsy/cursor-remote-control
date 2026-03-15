# 飞连 VPN 远程控制 - 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 通过飞书/钉钉消息远程控制 Mac 上的飞连 VPN 连接，支持锁屏状态。

**Architecture:** 在 shared/ 目录创建飞连控制器，使用 AppleScript 模拟 ⌘+O 快捷键。在飞书/钉钉服务中添加命令处理器，解析 `/飞连` 指令并调用控制器。通过 ifconfig 检测 VPN 状态。

**Tech Stack:** TypeScript, Bun, AppleScript, macOS System Events

---

## Task 1: 创建 AppleScript 快捷键脚本

**Files:**
- Create: `shared/feilian-control.applescript`

**Step 1: 创建 AppleScript 脚本**

创建文件 `shared/feilian-control.applescript`：

```applescript
-- 模拟 Command+O 快捷键切换飞连 VPN
tell application "System Events"
    keystroke "o" using {command down}
end tell
```

**Step 2: 测试脚本执行**

Run: `osascript shared/feilian-control.applescript`

Expected: 
- 飞连 VPN 状态切换（如果飞连正在运行）
- 如果权限不足，会提示需要辅助功能权限

**Step 3: 提交**

```bash
git add shared/feilian-control.applescript
git commit -m "feat: 添加飞连快捷键 AppleScript"
```

---

## Task 2: 创建飞连控制器核心模块

**Files:**
- Create: `shared/feilian-control.ts`

**Step 1: 定义类型和接口**

在 `shared/feilian-control.ts` 中定义：

```typescript
/**
 * VPN 连接状态
 */
export interface VPNStatus {
  connected: boolean;
  interface?: string;  // 如 "utun3"
  ipAddress?: string;  // 如 "10.xxx.xxx.xxx"
}

/**
 * 操作结果
 */
export interface OperationResult {
  success: boolean;
  message: string;
  status?: VPNStatus;
  error?: string;
}
```

**Step 2: 实现 VPN 状态检测**

添加状态检测方法：

```typescript
import { $ } from "bun";

export class FeilianController {
  /**
   * 检查 VPN 连接状态
   * 通过检测 utun 接口判断
   */
  async checkStatus(): Promise<VPNStatus> {
    try {
      const result = await $`ifconfig`.text();
      
      // 匹配 utun 接口和 IP 地址
      const utunMatch = result.match(/utun(\d+):([\s\S]*?)(?=\n\w|\n$)/);
      if (!utunMatch) {
        return { connected: false };
      }
      
      const interfaceName = `utun${utunMatch[1]}`;
      const interfaceContent = utunMatch[2];
      
      // 提取 IP 地址
      const ipMatch = interfaceContent.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
      
      if (ipMatch) {
        return {
          connected: true,
          interface: interfaceName,
          ipAddress: ipMatch[1]
        };
      }
      
      return { connected: false };
    } catch (error) {
      console.error("检测 VPN 状态失败:", error);
      return { connected: false };
    }
  }
}
```

**Step 3: 实现快捷键执行**

添加快捷键执行方法：

```typescript
  /**
   * 执行快捷键（⌘+O）
   */
  private async executeShortcut(): Promise<void> {
    try {
      await $`osascript shared/feilian-control.applescript`.quiet();
    } catch (error) {
      throw new Error(`执行快捷键失败: ${error}`);
    }
  }

  /**
   * 检查辅助功能权限
   */
  private async checkAccessibilityPermission(): Promise<boolean> {
    try {
      // 尝试执行一个无害的测试
      await $`osascript -e 'tell application "System Events" to keystroke ""'`.quiet();
      return true;
    } catch {
      return false;
    }
  }
```

**Step 4: 实现切换功能**

添加核心切换方法：

```typescript
  /**
   * 切换 VPN 状态（开↔关）
   */
  async toggle(): Promise<OperationResult> {
    try {
      // 检查权限
      const hasPermission = await this.checkAccessibilityPermission();
      if (!hasPermission) {
        return {
          success: false,
          message: "❌ 权限不足",
          error: `请在「系统设置 → 隐私与安全性 → 辅助功能」中添加：\n${process.execPath}`
        };
      }

      // 获取当前状态
      const beforeStatus = await this.checkStatus();
      
      // 执行快捷键
      await this.executeShortcut();
      
      // 等待 3 秒后检测状态
      await new Promise(resolve => setTimeout(resolve, 3000));
      const afterStatus = await this.checkStatus();
      
      // 检查状态是否变化
      if (beforeStatus.connected === afterStatus.connected) {
        return {
          success: false,
          message: "⚠️ 锁屏状态下操作可能失效",
          error: "建议：解锁屏幕后再发送 /飞连 指令",
          status: afterStatus
        };
      }
      
      // 格式化消息
      if (afterStatus.connected) {
        return {
          success: true,
          message: `✅ 飞连 VPN 已连接\n📡 接口: ${afterStatus.interface}\n🌐 IP: ${afterStatus.ipAddress}`,
          status: afterStatus
        };
      } else {
        return {
          success: true,
          message: "✅ 飞连 VPN 已断开",
          status: afterStatus
        };
      }
    } catch (error) {
      return {
        success: false,
        message: "❌ 执行失败",
        error: String(error)
      };
    }
  }
```

**Step 5: 实现确保连接/断开功能**

添加辅助方法：

```typescript
  /**
   * 确保 VPN 已连接
   */
  async ensureConnected(): Promise<OperationResult> {
    const status = await this.checkStatus();
    
    if (status.connected) {
      return {
        success: true,
        message: `✅ 飞连 VPN 已连接\n📡 接口: ${status.interface}\n🌐 IP: ${status.ipAddress}`,
        status
      };
    }
    
    // 未连接，执行切换
    return await this.toggle();
  }

  /**
   * 确保 VPN 已断开
   */
  async ensureDisconnected(): Promise<OperationResult> {
    const status = await this.checkStatus();
    
    if (!status.connected) {
      return {
        success: true,
        message: "✅ 飞连 VPN 已断开",
        status
      };
    }
    
    // 已连接，执行切换
    return await this.toggle();
  }

  /**
   * 格式化状态消息
   */
  formatStatus(status: VPNStatus): string {
    if (status.connected) {
      return `✅ 飞连 VPN 已连接\n📡 接口: ${status.interface}\n🌐 IP: ${status.ipAddress}`;
    } else {
      return "❌ 飞连 VPN 未连接";
    }
  }
}
```

**Step 6: 测试控制器**

创建测试脚本 `shared/test-feilian.ts`：

```typescript
import { FeilianController } from "./feilian-control";

const controller = new FeilianController();

async function test() {
  console.log("1. 检查当前状态...");
  const status = await controller.checkStatus();
  console.log(controller.formatStatus(status));
  
  console.log("\n2. 切换 VPN 状态...");
  const result = await controller.toggle();
  console.log(result.message);
  if (result.error) {
    console.error(result.error);
  }
}

test();
```

Run: `bun run shared/test-feilian.ts`

Expected: 
- 显示当前 VPN 状态
- 执行切换后显示新状态

**Step 7: 提交**

```bash
git add shared/feilian-control.ts shared/test-feilian.ts
git commit -m "feat: 实现飞连控制器核心功能"
```

---

## Task 3: 集成到飞书服务

**Files:**
- Modify: `feishu/server.ts`

**Step 1: 导入飞连控制器**

在 `feishu/server.ts` 顶部添加导入：

```typescript
import { FeilianController } from '../shared/feilian-control';
```

**Step 2: 查找消息处理函数**

在 `feishu/server.ts` 中找到处理文本消息的位置（通常是处理 `/help`、`/status` 等指令的地方）。

**Step 3: 添加飞连指令处理**

在指令处理逻辑中添加（通常在 if-else 或 switch 语句中）：

```typescript
// 处理飞连 VPN 控制指令
if (text.match(/^\/(飞连|vpn|feilian)\s*/i)) {
  const controller = new FeilianController();
  let result: OperationResult;
  
  // 解析子命令
  const command = text.replace(/^\/(飞连|vpn|feilian)\s*/i, '').trim();
  
  if (command.match(/^(状态|status)$/i)) {
    // 查询状态
    const status = await controller.checkStatus();
    result = {
      success: true,
      message: controller.formatStatus(status),
      status
    };
  } else if (command.match(/^(开|on|connect)$/i)) {
    // 确保开启
    result = await controller.ensureConnected();
  } else if (command.match(/^(关|off|disconnect)$/i)) {
    // 确保关闭
    result = await controller.ensureDisconnected();
  } else {
    // 默认：切换
    result = await controller.toggle();
  }
  
  // 发送结果消息
  await sendTextMessage(result.message);
  if (result.error) {
    await sendTextMessage(`\n${result.error}`);
  }
  
  return; // 结束处理
}
```

**Step 4: 测试飞书集成**

1. 启动飞书服务：`cd feishu && bun run server.ts`
2. 在飞书中发送：`@机器人 /飞连 状态`
3. 预期返回当前 VPN 状态

**Step 5: 提交**

```bash
git add feishu/server.ts
git commit -m "feat(feishu): 集成飞连 VPN 控制指令"
```

---

## Task 4: 集成到钉钉服务

**Files:**
- Modify: `dingtalk/server-minimal.ts`

**Step 1: 导入飞连控制器**

在 `dingtalk/server-minimal.ts` 顶部添加：

```typescript
import { FeilianController } from '../shared/feilian-control';
```

**Step 2: 添加飞连指令处理**

找到消息处理函数，添加与飞书相同的逻辑：

```typescript
// 处理飞连 VPN 控制指令
if (text.match(/^\/(飞连|vpn|feilian)\s*/i)) {
  const controller = new FeilianController();
  let result: OperationResult;
  
  const command = text.replace(/^\/(飞连|vpn|feilian)\s*/i, '').trim();
  
  if (command.match(/^(状态|status)$/i)) {
    const status = await controller.checkStatus();
    result = {
      success: true,
      message: controller.formatStatus(status),
      status
    };
  } else if (command.match(/^(开|on|connect)$/i)) {
    result = await controller.ensureConnected();
  } else if (command.match(/^(关|off|disconnect)$/i)) {
    result = await controller.ensureDisconnected();
  } else {
    result = await controller.toggle();
  }
  
  // 发送结果消息（根据钉钉的发送方式调整）
  await sendDingTalkMessage(result.message);
  if (result.error) {
    await sendDingTalkMessage(`\n${result.error}`);
  }
  
  return;
}
```

**Step 3: 测试钉钉集成**

1. 启动钉钉服务：`cd dingtalk && bun run server-minimal.ts`
2. 在钉钉中发送：`@机器人 /飞连 状态`
3. 预期返回当前 VPN 状态

**Step 4: 提交**

```bash
git add dingtalk/server-minimal.ts
git commit -m "feat(dingtalk): 集成飞连 VPN 控制指令"
```

---

## Task 5: 更新帮助文档

**Files:**
- Modify: `feishu/server.ts` (帮助信息)
- Modify: `dingtalk/server-minimal.ts` (帮助信息)
- Modify: `README.md`

**Step 1: 更新飞书帮助信息**

在 `feishu/server.ts` 中找到 `/help` 指令的处理，添加：

```typescript
const helpText = `
...现有帮助信息...

**飞连 VPN 控制**：
• /飞连 - 切换 VPN 状态
• /飞连 开 - 确保 VPN 连接
• /飞连 关 - 断开 VPN
• /飞连 状态 - 查询连接状态
`;
```

**Step 2: 更新钉钉帮助信息**

在 `dingtalk/server-minimal.ts` 中同样更新 `/help` 信息。

**Step 3: 更新 README.md**

在 `README.md` 的"常用指令"章节中添加：

```markdown
### 飞连 VPN 远程控制

通过飞书/钉钉消息远程开关飞连 VPN（支持锁屏状态）。

**快速使用**：
- `/飞连` - 切换 VPN 状态
- `/飞连 开` - 确保 VPN 连接
- `/飞连 关` - 断开 VPN
- `/飞连 状态` - 查询连接状态

**前置配置**：
1. 确认飞连快捷键为 ⌘+O（在飞连设置中）
2. 配置辅助功能权限（见下方）
3. 重启服务生效

**配置辅助功能权限**：

macOS 系统设置 → 隐私与安全性 → 辅助功能 → 添加：

```bash
/Users/你/.bun/bin/bun
```

重启服务：
```bash
cd feishu && bash service.sh restart
cd dingtalk && bash service.sh restart
```

**限制**：
- ⚠️ 锁屏状态下可能需要解锁后才能生效
- ⚠️ 仅支持快捷键控制，不支持指定线路
```

**Step 4: 提交**

```bash
git add feishu/server.ts dingtalk/server-minimal.ts README.md
git commit -m "docs: 添加飞连 VPN 控制使用文档"
```

---

## Task 6: 端到端测试

**Step 1: 解锁状态测试**

1. 确保 Mac 处于解锁状态
2. 飞书发送：`/飞连 状态`
3. 预期：返回当前 VPN 状态
4. 飞书发送：`/飞连`
5. 预期：VPN 状态切换，3-5 秒后返回新状态

**Step 2: 锁屏状态测试（需要先配置权限）**

1. 配置辅助功能权限（添加 bun）
2. 重启服务
3. 锁定 Mac 屏幕
4. 从手机飞书发送：`/飞连`
5. 预期：
   - 如果权限配置正确：VPN 状态切换
   - 如果权限不足：返回权限配置提示

**Step 3: 错误场景测试**

1. 未配置权限时发送指令 → 应返回权限提示
2. 飞连未运行时发送指令 → 应返回友好错误
3. 快捷键冲突时 → 应返回超时提示

**Step 4: 清理测试文件**

```bash
rm shared/test-feilian.ts
git add shared/test-feilian.ts
git commit -m "chore: 移除测试文件"
```

---

## Task 7: 最终提交和文档

**Step 1: 检查所有变更**

Run: `git status`

确认所有文件都已提交。

**Step 2: 推送到远程仓库（可选）**

```bash
git push origin main
```

**Step 3: 验证功能清单**

- [x] AppleScript 快捷键执行
- [x] VPN 状态检测（utun 接口）
- [x] 飞书指令集成
- [x] 钉钉指令集成
- [x] 权限检测和友好提示
- [x] 锁屏状态兼容性
- [x] 帮助文档更新
- [x] README 使用说明

---

## 验收标准

1. ✅ 解锁状态下发送 `/飞连` 可成功切换 VPN
2. ✅ 锁屏状态下（配置权限后）可远程控制
3. ✅ 权限不足时返回清晰的配置指引
4. ✅ 飞书和钉钉都能正常使用
5. ✅ README 包含完整的配置步骤

---

## 后续优化（可选）

以下功能根据实际使用情况决定是否实现：

1. **定时保活**：每 10 分钟自动检查并重连
2. **连接统计**：记录 VPN 连接时长和次数
3. **多线路支持**：支持切换不同的 VPN 线路
4. **流量监控**：显示 VPN 流量使用情况
