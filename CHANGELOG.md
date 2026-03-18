# 变更日志

本文件记录本项目的所有重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)。

---

## [Unreleased]

### 改进

- **热点推送消息样式优化**：全新的视觉设计，提升可读性和美观度
  - 标题使用数字格式（**1.**, **2.**）替代 emoji，更简洁
  - 热度值优化为 ` · 🔥 123.4万热` 格式，移除反引号
  - 平台区块添加分隔线 `━━━━━━━━━━━━━━━━━━━━━━` 和新的 emoji 🌟
  - 链接简化为 `[→ 查看原文]` 格式
  - 优化整体排版间距，提升内容呼吸感
  - 支持新旧样式切换（配置项 `useEnhancedStyle`，默认启用新样式）

---

## [2.0.0] - 2026-03-14

基于 [feishu-cursor-claw](https://github.com/nongjun/feishu-cursor-claw) 进行大量改进和扩展。

### 新增

- **钉钉渠道支持**：完整支持钉钉 Stream 长连接，与飞书并列运行
- **双服务架构**：飞书与钉钉独立部署，可同时运行、互不干扰
- **统一服务管理**：根目录 `manage-services.sh` 统一查看/重启/查看日志
- **配置文件分离**：每个服务独立 `.env`、独立 `cron-jobs-*.json`
- **共享项目路由**：根目录 `projects.json` 被飞书和钉钉共同使用

### 变更

- **目录结构**：飞书代码迁入 `feishu/`，钉钉代码迁入 `dingtalk/`
- **定时任务**：飞书使用 `cron-jobs-feishu.json`，钉钉使用 `cron-jobs-dingtalk.json`
- **环境变量**：各服务独立 `.env`，平台隔离更清晰

### 致谢

- 原项目 [feishu-cursor-claw](https://github.com/nongjun/feishu-cursor-claw) 作者 [@nongjun](https://github.com/nongjun)

---

## [1.x] - 原项目

功能与版本以原仓库 [feishu-cursor-claw](https://github.com/nongjun/feishu-cursor-claw) 为准，本项目自 2.0.0 起在其基础上演进。

[Unreleased]: https://github.com/keunsy/cursor-remote-control/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/keunsy/cursor-remote-control/releases/tag/v2.0.0
