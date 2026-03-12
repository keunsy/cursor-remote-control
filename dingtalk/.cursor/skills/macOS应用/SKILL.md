---
name: macOS应用
description: macOS 桌面应用开发的模式和最佳实践。当用户提到"开发 Mac 应用""SwiftUI""Swift 代码""桌面应用""菜单栏应用"时使用。
---

# macOS 应用开发模式

## 适用场景

使用 Swift/SwiftUI 开发 macOS 桌面应用时。

## 核心原则

- 沙箱优先——App Store 要求沙箱化，提前规划权限需求
- 原生体验——遵循 macOS 人机界面指南，菜单栏、快捷键、拖拽都要支持
- 后台能力——macOS 应用可以后台运行，注意内存和 CPU 占用
- 多窗口——macOS 用户期望多窗口支持，不要做成单窗口

## SwiftUI 模式

- 用 @State、@Binding、@ObservedObject 管理状态
- 复杂状态用 @EnvironmentObject 跨视图共享
- 列表用 LazyVStack/LazyHStack 做懒加载
- 导航用 NavigationSplitView（macOS 三栏布局）

## 数据持久化

- 简单配置用 UserDefaults 或 @AppStorage
- 结构化数据用 SwiftData 或 Core Data
- 文件操作需申请沙箱权限，用 NSOpenPanel/NSSavePanel
- 敏感数据（密码、Token）存 Keychain

## 网络通信

- 用 URLSession 或 Alamofire 做 HTTP 请求
- 异步操作用 async/await（Swift Concurrency）
- 处理网络不可用的情况，给用户明确提示

## 分发方式

- App Store：需要沙箱、签名、审核
- Developer ID：签名 + 公证（Notarization），可直接分发
- 企业内部：可以用 .app 或 .dmg 直接分发（需关闭 Gatekeeper 或签名）

## 常见坑点

- macOS 权限系统比 iOS 复杂（辅助功能、屏幕录制、完全磁盘访问等）
- 菜单栏应用（MenuBarExtra）的生命周期与窗口应用不同
- 进程间通信用 XPC 或 DistributedNotificationCenter
