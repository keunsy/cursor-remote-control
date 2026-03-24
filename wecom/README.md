# wecom-cursor-claw

> 企业微信 → Cursor Agent 远程控制  
> 基于 @wecom/aibot-node-sdk 的 WebSocket 长连接实现

## 功能清单

### 核心能力
- ✅ WebSocket 长连接（基于 `@wecom/aibot-node-sdk`）
- ✅ 实时流式回复（进度 + 结果）
- ✅ 多项目路由（前缀指定 + 对话切换）
- ✅ 会话管理（历史查看/切换）
- ✅ 完整命令系统（模型/密钥/记忆/任务/心跳）
- ✅ 记忆系统（全工作区语义索引）
- ✅ 定时任务（Scheduler + cron）
- ✅ 心跳机制（定时健康检查）
- ⚠️ 语音识别（需配置火山引擎 STT）

### 可用命令

#### 基础指令
- `/帮助` `/help` — 显示帮助信息
- `/状态` `/status` — 查看服务状态（模型/Key/记忆/调度/心跳/会话）
- `/项目` `/project` — 列出所有可用项目
- `/新对话` `/new` — 归档当前会话，开启新对话
- `/终止 [项目名]` `/stop` — 终止正在执行的任务

#### 热点 / 新闻
- `/新闻` `/news` — **立即推送**今日热点（直接发 `/新闻`）；定时例：`/新闻 每天9点 推送10条`
- `/新闻状态` `/news status` — 各数据源是否可用
- 也可说：「每天9点推送热点」「30分钟后推送10条新闻」等自动建定时任务

#### 会话管理
- `/会话` `/sessions` — 查看最近会话列表
- `/会话 编号` — 切换到指定会话

#### 模型与密钥
- `/模型` `/model` — 查看/切换 AI 模型
- `/模型 编号/名称` — 切换模型（如 `/模型 1` 或 `/模型 opus`）
- `/密钥` `/apikey` — 查看/更换 API Key（仅私聊）
- `/密钥 key_xxx...` — 更换 API Key

#### 记忆系统
- `/记忆` `/memory` — 查看记忆状态
- `/记忆 关键词` — 语义搜索记忆
- `/记录 内容` — 写入今日日记
- `/整理记忆` `/reindex` — 重建记忆索引

#### 文件操作
- `/apk` `/sendapk` — 快速发送 Android APK（需配置 Android 项目）
- `/发送文件 路径` — 发送任意本地文件
- 示例: `/发送文件 ~/document.pdf`

#### 定时任务
- `/任务` `/cron` — 查看定时任务列表
- `/任务 暂停 ID` — 暂停指定任务
- `/任务 恢复 ID` — 恢复指定任务
- `/任务 删除 ID` — 删除指定任务
- 热点定时见上文 **热点 / 新闻**；其它定时也可说「每天早上9点提醒我XX」

#### 心跳系统
- `/心跳` `/heartbeat` — 查看心跳状态
- `/心跳 开启/关闭` — 启用/暂停心跳
- `/心跳 执行` — 立即执行一次心跳检查
- `/心跳 间隔 分钟数` — 设置心跳间隔

#### 飞连 VPN 控制
- `/飞连` `/vpn` — 切换 VPN 状态
- `/飞连 开` — 确保 VPN 连接
- `/飞连 关` — 断开 VPN
- `/飞连 状态` — 查询连接状态

#### 项目路由
- 前缀指定：`项目名:消息` 或 `#项目名 消息`
- 对话切换：说「切换到 remote」「切到 user 项目」等

## 快速开始

### 步骤 1: 安装依赖工具（如未安装）

```bash
# 安装 Bun 运行时
curl -fsSL https://bun.sh/install | bash

# 安装 Cursor Agent CLI
curl https://cursor.com/install -fsS | bash

# 登录 Cursor（一次性操作，之后不需要 API Key）
~/.local/bin/agent login
# 按提示在浏览器中完成登录
```

### 步骤 2: 配置企业微信智能机器人

1. 进入[企业微信管理后台](https://work.weixin.qq.com/)
2. 创建智能机器人
3. 在机器人配置页面，开启 **API 模式** 并选择 **长连接**
4. 获取 **BotID** 和 **Secret**
5. **重要**: 开启长连接后，原有的 Webhook 模式将失效

### 步骤 3: 创建配置文件并启动服务

```bash
# 创建配置文件（从模板）
cd /path/to/cursor-remote-control
cp projects.json.example projects.json
# 编辑 projects.json，配置你的工作区路径

# ⚠️ 重要：必须创建 .env 文件
cd wecom
cp .env.example .env
# 编辑 .env，填入：
# - WECOM_BOT_ID=你的BotID
# - WECOM_BOT_SECRET=你的Secret
# - CURSOR_MODEL=auto  # 建议用 auto 节省配额
# - 注释掉 CURSOR_API_KEY（已通过 agent login 登录）

# 安装依赖并启动
bun install
bash service.sh install

# 检查服务状态
bash service.sh status
# 应该显示：🟢 运行中 (PID: xxxxx)
```

### 步骤 4: 测试

在企业微信中找到你的机器人，发送：

```
@机器人 你好
```

如果收到回复，说明安装成功！发送 `/帮助` 查看所有命令。

---

## 功能特性

### 当前版本（v1.2 - 与飞书功能对齐）

**核心功能**:
- ✅ 文本消息处理
- ✅ WebSocket 长连接（自动重连）
- ✅ 流式回复（主动推送，延迟更低）⭐
- ✅ 完整命令系统（17+ 核心命令）
- ✅ 项目路由（3 种方式）
- ✅ 会话管理（历史/切换/归档）
- ✅ Markdown 响应
- ✅ 工具调用摘要
- ✅ 记忆系统集成（与飞书/钉钉共享）
- ✅ 定时任务系统
- ✅ 心跳系统
- ✅ 启动自检（.cursor/BOOT.md 自动执行）
- ✅ **热点新闻推送**（立即推送 + 定时任务）
- ✅ **飞连 VPN 控制**（远程开关 VPN）
- ✅ **文件发送**（/发送文件、/apk）

**暂不支持**（低优先级）:
- ❌ 语音消息识别
- ❌ 图片处理（下载 + OCR）
- ❌ 模板卡片（交互式卡片）

**注**: 企业微信版本已与飞书功能对齐，流式回复体验更优（主动推送 vs 轮询刷新）

---

## 服务管理

### 企业微信独立管理

```bash
cd wecom
bash service.sh install    # 安装开机自启动
bash service.sh start      # 启动服务
bash service.sh stop       # 停止服务
bash service.sh restart    # 重启服务
bash service.sh status     # 查看运行状态
bash service.sh logs       # 查看实时日志
bash service.sh uninstall  # 卸载自启动
```

### 服务特性

- ✅ **开机自启动**: 基于 macOS launchd 自动启动
- ✅ **崩溃自动恢复**: 进程异常退出会自动重启
- ✅ **防止睡眠**: 使用 `caffeinate` 防止系统空闲睡眠
- ✅ **日志输出**: 标准输出和错误输出统一记录到 `/tmp/wecom-cursor.log`

---

## 与飞书/钉钉/微信共存

企业微信、飞书、钉钉、微信个人号四个服务可以同时运行，互不干扰：

| 服务 | 标签 | 日志路径 | SDK |
|------|------|---------|-----|
| 飞书 | com.cursor-feishu | /tmp/feishu-cursor.log | @larksuiteoapi/node-sdk |
| 钉钉 | com.dingtalk-cursor-claw | /tmp/dingtalk-cursor.log | dingtalk-stream |
| 企业微信 | com.wecom-cursor-claw | /tmp/wecom-cursor.log | @wecom/aibot-node-sdk |
| 微信个人号 | - | 直接运行 | ilink bot API |

**共享配置**（位于根目录）：
- `projects.json` - 项目路由配置（四平台通用）
- `.memory.sqlite` - 记忆向量数据库（四平台共享）

**独立配置**：
- `wecom/.env` - 企业微信凭据
- `../cron-jobs-wecom.json` - 企业微信定时任务（项目根目录）
- `../cron-jobs-wechat.json` - 微信定时任务（项目根目录）

---

## 环境变量配置

在 `wecom/.env` 中配置：

| 变量 | 必填 | 说明 | 默认值 |
|------|------|------|--------|
| `WECOM_BOT_ID` | ✅ | 企业微信机器人 BotID | - |
| `WECOM_BOT_SECRET` | ✅ | 企业微信机器人 Secret | - |
| `CURSOR_API_KEY` | ❌ | Cursor API Key（如已 `agent login` 则不需要） | - |
| `CURSOR_MODEL` | ❌ | AI 模型 | `auto` |
| `VOLC_STT_APP_ID` | ❌ | 火山引擎语音识别 APP ID | - |
| `VOLC_STT_ACCESS_TOKEN` | ❌ | 火山引擎语音识别 Token | - |
| `VOLC_EMBEDDING_API_KEY` | ❌ | 向量嵌入 API Key | - |
| `VOLC_EMBEDDING_MODEL` | ❌ | 向量嵌入模型 | `doubao-embedding-vision-250615` |

---

## 故障排查

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| 企业微信无响应 | 服务未启动或异常 | `cd wecom && bash service.sh restart` |
| `API Key 无效` | .env 中有无效占位符 | 运行 `agent login` 登录，注释掉 .env 中的 `CURSOR_API_KEY` |
| `团队配额已用完` | 使用高消耗模型 | 改用 `auto` 模型（编辑 .env 中的 `CURSOR_MODEL=auto`） |
| `permission denied to access path` | projects.json 路径错误 | 检查 projects.json 中的路径是否正确 |
| `agent: command not found` | Agent CLI 未安装 | `curl https://cursor.com/install -fsS \| bash` |
| `bun: command not found` | Bun 未安装 | `curl -fsSL https://bun.sh/install \| bash` |
| WebSocket 连接失败 | BotID/Secret 错误 | 检查 .env 中的配置是否正确 |

### 查看日志

```bash
cd wecom
bash service.sh status     # 查看状态
bash service.sh logs       # 查看实时日志
```

---

## 技术架构

```
手机企业微信 ─WebSocket→ wecom-cursor-claw ─CLI→ Cursor IDE
                         ↓
                  共享核心模块
                         ↓
              ┌──────────┴──────────┐
           bridge.ts             memory.ts
         (与飞书/钉钉共享)      (与飞书/钉钉共享)
```

### 企业微信优势

相比飞书/钉钉，企业微信具有以下优势：

1. **流式回复体验更好**: 主动推送刷新（vs 飞书的被动轮询），延迟更低
2. **更丰富的卡片**: 支持模板卡片更新
3. **视频消息**: 支持视频消息（单聊场景）
4. **更好的事件系统**: 支持更多交互事件（按钮点击、用户反馈等）

---

## License

MIT
