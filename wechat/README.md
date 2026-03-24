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

### ✅ 已实现（v1.0 MVP）

- ✅ QR 码扫码登录
- ✅ 消息接收（长轮询，35秒超时）
- ✅ 文本消息发送（自动分片，3800字符/片）
- ✅ 消息去重（防止重复处理）
- ✅ Session 恢复（断线重连）
- ✅ Token 持久化（无需重复登录）
- ✅ 基础回复功能

### 🚧 待实现（后续版本）

- ⏳ Cursor Agent CLI 集成
- ⏳ 会话管理（历史/切换/归档）
- ⏳ 项目路由
- ⏳ 命令系统
- ⏳ 定时任务
- ⏳ 记忆系统
- ⏳ 图片/文件支持

## 🔧 技术架构

### 核心组件

| 组件 | 说明 |
|------|------|
| **WechatAuth** | QR 登录、Token 管理 |
| **WechatClient** | HTTP API 客户端 |
| **WechatMonitor** | 长轮询消息监听 |

### API 端点

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

## 📝 开发计划

### Phase 1: MVP（当前）
- [x] 基础通信（登录/收发消息）
- [ ] Cursor Agent 集成
- [ ] 简单命令支持

### Phase 2: 功能对齐
- [ ] 完整命令系统（参考飞书/钉钉）
- [ ] 会话管理
- [ ] 项目路由

### Phase 3: 高级功能
- [ ] 图片/文件支持
- [ ] 语音识别
- [ ] 定时任务
- [ ] 记忆系统

## 📄 许可证

MIT License

---

**问题反馈**: https://github.com/keunsy/cursor-remote-control/issues
