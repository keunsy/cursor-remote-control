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

import { $ } from "bun";
import { resolve } from "node:path";

const SCRIPT_PATH = resolve(import.meta.dirname, "feilian-control.applescript");

export class FeilianController {
  /**
   * 检查 VPN 连接状态
   * 通过检测 utun 接口判断
   */
  async checkStatus(): Promise<VPNStatus> {
    try {
      const result = await $`ifconfig`.text();

      // 遍历所有 utun 接口，找第一个有 IPv4 地址的
      const allMatches = result.matchAll(/utun(\d+):([\s\S]*?)(?=\nutun|\n\w+:|\n$)/g);
      
      for (const match of allMatches) {
        const interfaceName = `utun${match[1]}`;
        const interfaceContent = match[2];

        // 提取 IPv4 地址
        const ipMatch = interfaceContent.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);

        if (ipMatch) {
          return {
            connected: true,
            interface: interfaceName,
            ipAddress: ipMatch[1]
          };
        }
      }

      return { connected: false };
    } catch (error) {
      console.error("检测 VPN 状态失败:", error);
      return { connected: false };
    }
  }

  /**
   * 执行快捷键（⌘+O）
   */
  private async executeShortcut(): Promise<void> {
    try {
      await $`osascript ${SCRIPT_PATH}`.quiet();
    } catch (error) {
      throw new Error(`执行快捷键失败: ${error}`);
    }
  }

  /**
   * 检查辅助功能权限
   */
  private async checkAccessibilityPermission(): Promise<boolean> {
    try {
      await $`osascript -e 'tell application "System Events" to keystroke ""'`.quiet();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 切换 VPN 状态（开↔关）
   */
  async toggle(): Promise<OperationResult> {
    try {
      const hasPermission = await this.checkAccessibilityPermission();
      if (!hasPermission) {
        return {
          success: false,
          message: "❌ 权限不足",
          error: `请在「系统设置 → 隐私与安全性 → 辅助功能」中添加：\n${process.execPath}`
        };
      }

      const beforeStatus = await this.checkStatus();

      await this.executeShortcut();

      await new Promise(r => setTimeout(r, 3000));
      const afterStatus = await this.checkStatus();

      if (beforeStatus.connected === afterStatus.connected) {
        return {
          success: false,
          message: "⚠️ 锁屏状态下操作可能失效",
          error: "建议：解锁屏幕后再发送 /飞连 指令",
          status: afterStatus
        };
      }

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
