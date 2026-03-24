# 微信个人号 → Cursor Agent 中继服务

> 通过微信个人号远程控制 Cursor AI，实现移动端智能编程助手

## 🚀 快速开始

### 1. 安装依赖

```bash
bun install
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 填入必要配置（Cursor API Key 推荐使用 agent login）
```

### 3. 启动服务

```bash
bun run start.ts
```

首次启动会显示二维码，使用微信扫码登录即可。Token 会自动保存到 `.wechat_token.json`，下次启动无需重新扫码。

## 📋 功能特性

### ✅ 已实现（v1.2 - 与其他平台功能对齐）

**核心功能**：
- ✅ QR 码扫码登录
- ✅ 消息接收（长轮询，35秒超时）
- ✅ 文本消息发送（自动分片，3800字符/片）
- ✅ 消息去重（防止重复处理）
- ✅ Session 恢复（断线重连）
- ✅ Token 持久化（无需重复登录）
- ✅ Context Token 管理（支持定时推送）

**Cursor 集成**：
- ✅ Cursor Agent CLI 完整集成
- ✅ 模型链备用机制（自动降级）
- ✅ 会话管理（历史/切换/归档）
- ✅ 项目路由（前缀指定 + 对话式切换）

**命令系统**（15+ 命令）：
- ✅ `/帮助` `/状态` `/项目` `/新对话` `/终止`
- ✅ `/会话` - 查看/切换历史会话
- ✅ `/模型` - 查看/切换 AI 模型
- ✅ `/密钥` - 查看/更换 API Key（仅私聊）
- ✅ `/记忆` - 语义搜索历史记忆
- ✅ `/任务` - 管理定时任务（查看/暂停/恢复/删除）
- ✅ `/心跳` - 查看/控制心跳系统
- ✅ `/新闻` - 立即推送热点或创建定时任务
- ✅ `/飞连` - 远程控制 VPN 开关

**高级功能**：
- ✅ 定时任务系统（cron-jobs-wechat.json）
- ✅ 记忆系统（共享 SQLite + 向量检索）
- ✅ 心跳系统（定期维护）
- ✅ 新闻推送（支持自然语言创建定时任务）
- ✅ 飞连 VPN 控制

### ⏸️ 暂不支持（技术限制）

- ❌ 文件发送（个人号 API 限制）
- ❌ 图片/语音上传（待实现）
- ❌ 流式进度卡片（纯文本消息）

## 🔧 技术架构

### 核心组件

| 组件 | 说明 |
|------|------|
| **server.ts** | 主服务（1520 行，完整实现） |
| **wechat-helper.ts** | 会话管理、路由解析 |
| **CommandHandler** | 统一命令处理（shared） |
| **AgentExecutor** | Cursor Agent 执行器 |
| **Scheduler** | 定时任务调度器 |
| **MemoryManager** | 记忆系统 |
| **HeartbeatRunner** | 心跳系统 |

### 共享模块

与飞书/钉钉/企业微信共享：
- `../shared/agent-executor.ts` - Cursor Agent 执行
- `../shared/command-handler.ts` - 命令处理
- `../shared/scheduler.ts` - 定时任务
- `../shared/memory.ts` - 记忆管理
- `../shared/heartbeat.ts` - 心跳系统
- `../shared/feilian-control.ts` - VPN 控制
- `../shared/news-fetcher.ts` - 新闻推送

### 微信 API 端点

| 功能 | 端点 | 方法 |
|------|------|------|
| 获取二维码 | `/ilink/bot/get_bot_qrcode?bot_type=3` | GET |
| 轮询扫码状态 | `/ilink/bot/get_qrcode_status?qrcode=xxx` | GET |
| 获取消息 | `/ilink/bot/getupdates` | POST |
| 发送消息 | `/ilink/bot/sendmessage` | POST |

### 关键参数

- **长轮询超时**: 35 秒（推荐值）
- **单条消息限制**: 3800 字符（超长自动分片）
- **去重时间**: 5 分钟
- **Session 过期**: 错误码 -14

## 📖 使用指南

### 支持的命令

详细命令列表与飞书/钉钉/企业微信一致，主要包括：

**基础命令**：
- `/帮助` - 显示所有命令
- `/状态` - 查看服务状态
- `/项目` - 列出可用项目
- `/新对话` - 归档当前会话
- `/终止` - 停止运行中的任务

**高级功能**：
- `/会话 [编号]` - 查看/切换会话
- `/模型 [编号]` - 查看/切换模型
- `/记忆 [关键词]` - 搜索记忆
- `/任务` - 管理定时任务
- `/心跳` - 心跳系统控制
- `/新闻` - 热点新闻推送
- `/飞连` - VPN 远程控制

### 自然语言定时任务

支持自然语言创建定时任务，例如：
- "3分钟后提醒我开会"
- "每天早上9点推送热点新闻"
- "每周五下午5点提醒我周报"

**注意**：定时推送依赖有效的 `context_token`，如果长时间无消息，请先发一条消息刷新 token。

## 📚 参考文档

- [集成方案文档](../docs/WECHAT-INTEGRATION-PLAN.md)
- [腾讯微信官方插件](https://github.com/tencent-weixin/openclaw-weixin)
- [cc-connect 开源实现](https://github.com/chenhg5/cc-connect)

## ⚠️ 注意事项

### 多端登录限制

微信采用"桌面/iPad 协议"，**同一账号只能同时登录一个桌面端**：
- ✅ 可以：手机 + 本服务
- ❌ 不可以：PC 微信 + 本服务（会相互踢下线）

**建议**：
1. 使用微信小号进行测试
2. 或者临时退出 PC 微信

### Token 安全

`.wechat_token.json` 包含登录凭证，请妥善保管：
- 已加入 `.gitignore`
- 权限应为 `600`（仅所有者可读写）
- 定期更换（重新扫码登录）

## 🐛 故障排查

### 1. 连通性测试失败

```bash
# 检查网络
curl -I https://ilinkai.weixin.qq.com

# 检查 DNS
nslookup ilinkai.weixin.qq.com
```

### 2. Token 过期

删除 `.wechat_token.json` 重新登录：

```bash
rm .wechat_token.json
bun run start.ts
```

### 3. Session 过期（错误码 -14）

服务会自动暂停 1 小时后重试。如需立即恢复，重启服务。

## 📝 未来规划

### 技术改进
- [ ] 图片上传支持（研究 ilink API）
- [ ] 语音上传支持
- [ ] 流式进度更新（如有 API 支持）

### 优化方向
- [ ] Context Token 自动续期
- [ ] 更好的 Session 恢复策略
- [ ] 离线消息缓存

## 📄 许可证

MIT License

---

**问题反馈**: https://github.com/keunsy/cursor-remote-control/issues
