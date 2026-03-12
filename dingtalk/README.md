# dingtalk-cursor-claw

> 钉钉 → Cursor Agent 远程控制
> 基于 feishu-cursor-claw 的钉钉版本

## 快速开始

### 1. 配置钉钉应用

1. 进入[钉钉开发者后台](https://open-dev.dingtalk.com/)
2. 创建企业内部应用
3. 添加机器人能力，选择 **Stream 模式**
4. 配置权限：
   - 企业内机器人消息接收
   - 消息内容读取权限
   - 文件下载权限
5. 事件订阅：Stream 模式，订阅 `/v1.0/im/bot/messages/get`
6. 获取 AppKey 和 AppSecret

### 2. 配置环境变量

```bash
cd ~/work/cursor/dingtalk-cursor-claw
cp .env.example .env
# 编辑 .env 填入你的钉钉 AppKey 和 AppSecret
```

### 3. 启动服务

```bash
# 开发模式（前台运行）
bun run server-minimal.ts

# 生产模式（launchd 自启动）
bash service.sh install
```

## 使用方式

### 基本对话

```
在钉钉中 @机器人 发送消息：

@机器人 你好
@机器人 帮我分析一下当前项目的代码结构
```

### 项目路由

```
/moa 帮我分析代码        → 在 moa 项目工作
/api 审查最近的提交      → 在 ultron-api 项目工作
直接发消息              → 默认项目
```

项目配置文件：`~/work/cursor/projects.json`

## 功能特性

### MVP 版本（当前）

- ✅ 文本消息处理
- ✅ 语音消息识别（本地 whisper）
- ✅ 图片下载
- ✅ 文件下载
- ✅ 项目路由
- ✅ 会话恢复（--resume）
- ✅ Markdown 响应

### 计划中

- ⏳ 完整命令系统（/帮助、/状态、/新对话等）
- ⏳ 定时任务（复用 scheduler.ts）
- ⏳ 心跳系统（复用 heartbeat.ts）
- ⏳ 记忆系统（复用 memory.ts）
- ⏳ 钉钉待办集成
- ⏳ 钉钉日历集成

## 服务管理

```bash
bash service.sh install    # 安装开机自启动
bash service.sh status     # 查看状态
bash service.sh logs       # 查看日志
bash service.sh restart    # 重启
bash service.sh uninstall  # 卸载
```

## 与飞书版共存

钉钉版和飞书版可以同时运行：

| 服务 | 标签 | 日志 |
|------|------|------|
| 飞书 | com.feishu-cursor-claw | /tmp/feishu-cursor.log |
| 钉钉 | com.dingtalk-cursor-claw | /tmp/dingtalk-cursor.log |

共享：
- 项目配置（`projects.json`）
- 核心模块（bridge.ts、memory.ts等通过符号链接）
- 工作区记忆（`.cursor/MEMORY.md`）

独立：
- IM 连接和消息协议
- 会话上下文
- 日志文件

## 故障排查

### 钉钉无响应

```bash
# 检查服务状态
bash service.sh status

# 查看日志
bash service.sh logs

# 重启服务
bash service.sh restart
```

### AppKey 配置错误

编辑 `.env` 文件，修改 `DINGTALK_APP_KEY` 和 `DINGTALK_APP_SECRET`，无需重启（热更新）。

### 语音识别失败

安装本地 whisper：

```bash
brew install whisper-cpp
```

或配置火山引擎 STT（在 `.env` 中设置 `VOLC_STT_APP_ID` 和 `VOLC_STT_ACCESS_TOKEN`）。

## 技术架构

```
手机钉钉 ─Stream→ dingtalk-cursor-claw ─CLI→ Cursor IDE
                         ↓
                  符号链接共享核心模块
                         ↓
              ┌──────────┴──────────┐
           bridge.ts             memory.ts
         (飞书版复用)          (飞书版复用)
```

## License

MIT
