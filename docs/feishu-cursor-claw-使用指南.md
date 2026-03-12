# feishu-cursor-claw 完整使用指南

> 将飞书变成 Cursor AI 的远程遥控器

## 一、环境准备

### 1.1 系统要求

| 项目 | 要求 |
|------|------|
| 操作系统 | macOS（已支持 ✅） |
| 运行时 | Bun（需安装） |
| IDE | Cursor（已安装 ✅） |
| Agent CLI | `~/.local/bin/agent`（已安装 ✅） |

### 1.2 安装 Bun

```bash
# 安装 Bun
curl -fsSL https://bun.sh/install | bash

# 验证安装
bun --version
```

### 1.3 安装语音识别（可选）

```bash
# 安装 ffmpeg 和 whisper（本地语音识别）
brew install ffmpeg whisper-cpp
```

## 二、项目安装

### 2.1 克隆项目

```bash
cd ~/work/cursor
git clone https://github.com/nongjun/feishu-cursor-claw.git
cd feishu-cursor-claw
```

### 2.2 安装依赖

```bash
bun install
```

### 2.3 配置环境变量

```bash
# 复制配置模板
cp .env.example .env

# 编辑配置文件
code .env  # 或用其他编辑器
```

## 三、配置说明

### 3.1 必填配置

编辑 `.env` 文件：

```env
# ============ 必填项 ============

# 飞书应用凭据（必须）
FEISHU_APP_ID=cli_xxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx

# Cursor 模型设置（必须）
CURSOR_MODEL=auto  # ⚠️ 重要：因为配额限制，必须用 auto

# ============ 可选项 ============

# Cursor API Key（通常不需要，CLI 会自动使用 IDE 登录状态）
# CURSOR_API_KEY=sk-xxxx

# 火山引擎语音识别（可选，不配置则使用本地 whisper）
# VOLC_STT_APP_ID=your_app_id
# VOLC_STT_ACCESS_TOKEN=your_token

# 火山引擎向量搜索（可选，用于记忆系统）
# VOLC_EMBEDDING_API_KEY=your_key
# VOLC_EMBEDDING_MODEL=doubao-embedding-vision-250615
```

### 3.2 获取飞书应用凭据

#### 步骤 1：创建飞书应用

1. 访问飞书开放平台：https://open.feishu.cn/app
2. 点击"创建企业自建应用"
3. 填写应用名称和描述

#### 步骤 2：添加机器人能力

1. 在应用管理页面，点击"添加应用能力"
2. 选择"机器人"

#### 步骤 3：配置权限

进入"权限管理"，开通以下权限：

- ✅ `im:message` - 获取与发送单聊消息
- ✅ `im:message.group_at_msg` - 获取群组中被@的消息
- ✅ `im:resource` - 获取消息中的资源文件

#### 步骤 4：配置事件订阅

1. 进入"事件订阅"
2. **重要**：选择"**长连接模式**"（WebSocket）
3. 订阅事件：`im.message.receive_v1`（接收消息）

#### 步骤 5：获取凭据

1. 在"凭证与基础信息"页面
2. 复制 **App ID** 和 **App Secret**
3. 填入 `.env` 文件

#### 步骤 6：发布版本

1. 创建应用版本
2. 提交审核（企业自建应用审核很快）
3. 发布上线

### 3.3 配置火山引擎语音识别（可选）

如果不配置，会使用本地 whisper（质量较低但免费）。

#### 火山引擎配置步骤

1. 访问：https://console.volcengine.com/speech/app
2. 创建应用
3. 开通"大模型流式语音识别"服务
4. 获取 App ID 和 Access Token
5. 填入 `.env`

## 四、启动服务

### 4.1 测试运行（推荐先测试）

```bash
cd ~/work/cursor/feishu-cursor-claw
bun run server.ts
```

看到以下输出表示成功：

```
飞书长连接已启动，等待消息...
```

### 4.2 安装为系统服务（推荐）

```bash
# 安装并启动（开机自启 + 崩溃自动重启）
bash service.sh install

# 查看状态
bash service.sh status

# 查看日志
bash service.sh logs
```

### 4.3 服务管理命令

| 命令 | 说明 |
|------|------|
| `bash service.sh install` | 安装开机自启动并立即启动 |
| `bash service.sh uninstall` | 卸载自启动并停止服务 |
| `bash service.sh start` | 启动服务 |
| `bash service.sh stop` | 停止服务 |
| `bash service.sh restart` | 重启服务 |
| `bash service.sh status` | 查看运行状态 |
| `bash service.sh logs` | 查看实时日志 |

## 五、使用飞书机器人

### 5.1 添加机器人

1. 在飞书中搜索你的机器人名称
2. 添加到你的联系人
3. 或将机器人拉入群聊

### 5.2 基本使用

#### 私聊使用

直接给机器人发消息：

```
帮我分析一下项目的代码结构
```

#### 群聊使用

在群里 @ 机器人：

```
@你的机器人 帮我审查这个 PR
```

### 5.3 发送不同类型的消息

| 类型 | 示例 |
|------|------|
| **文本** | 帮我写一个用户登录功能 |
| **语音** | 发送语音消息，自动转文字 |
| **图片** | 发送代码截图，AI 会识别 |
| **文件** | 发送代码文件，AI 会分析 |

### 5.4 飞书命令

| 命令 | 中文 | 说明 |
|------|------|------|
| `/help` | `/帮助` | 查看所有命令 |
| `/status` | `/状态` | 查看服务状态（模型、会话等） |
| `/new` | `/新对话` | 重置当前会话，开始新对话 |
| `/model auto` | `/模型 auto` | 切换模型 |
| `/stop` | `/停止` | 终止当前运行的任务 |
| `/memory` | `/记忆` | 查看记忆系统状态 |
| `/memory 关键词` | `/记忆 关键词` | 搜索历史记忆 |
| `/log 内容` | `/记录 内容` | 写入今日日记 |
| `/reindex` | `/整理记忆` | 重建记忆索引 |

## 六、多项目配置（可选）

如果你有多个项目需要管理，可以配置项目路由。

### 6.1 创建项目配置

在 feishu-cursor-claw 的**上级目录**创建 `projects.json`：

```bash
cd ~/work/cursor
cat > projects.json << 'EOF'
{
  "projects": {
    "mycode": {
      "path": "/Users/user/work/myproject",
      "description": "我的代码项目"
    },
    "docs": {
      "path": "/Users/user/Documents/工作文档",
      "description": "工作文档"
    },
    "strategy": {
      "path": "/Users/user/Documents/战略规划",
      "description": "战略文档"
    }
  },
  "default_project": "mycode"
}
EOF
```

### 6.2 使用项目路由

在飞书中使用 `项目名: 消息` 格式：

```
mycode: 帮我重构用户服务

docs: 总结一下最近的会议记录

strategy: 审阅这份季度规划
```

不带前缀的消息会路由到 `default_project`。

## 七、使用场景示例

### 7.1 代码开发

**场景**：通勤路上想到一个需求

```
语音消息："帮我实现一个用户注册功能，需要验证邮箱和手机号"
```

AI 会：
1. 分析现有代码结构
2. 生成注册接口
3. 添加验证逻辑
4. 生成单元测试

### 7.2 代码审查

**场景**：手机上看到 PR 通知

```
帮我审查最新的 PR，重点关注安全问题
```

或发送 PR 链接：

```
审查这个 PR：https://github.com/xxx/pull/123
```

### 7.3 紧急修复

**场景**：不在电脑旁，线上出现 Bug

```
语音："线上报错 NullPointerException，帮我排查并修复"
```

AI 会：
1. 查看错误日志
2. 定位问题代码
3. 修复 Bug
4. 生成提交

### 7.4 文档共创

**场景**：会议中记录想法

```
拍照会议白板 + 文字："把这些要点整理成季度规划文档"
```

### 7.5 知识管理

**场景**：随时记录灵感

```
/记录 今天讨论了用 Redis 做缓存的方案，需要考虑数据一致性问题
```

后续可以搜索：

```
/记忆 Redis缓存方案
```

## 八、首次使用流程

### 8.1 完整步骤

```bash
# 1. 克隆项目
cd ~/work/cursor
git clone https://github.com/nongjun/feishu-cursor-claw.git
cd feishu-cursor-claw

# 2. 安装依赖
bun install

# 3. 配置环境变量
cp .env.example .env
nano .env  # 或用 vim/code 编辑

# 4. 测试运行
bun run server.ts

# 5. 测试飞书消息
# 在飞书中给机器人发消息："你好"

# 6. 确认工作后，安装为服务
# 按 Ctrl+C 停止测试
bash service.sh install

# 7. 验证服务状态
bash service.sh status
```

### 8.2 首次对话（AI 出生仪式）

第一次使用时，AI 会进行"出生仪式"（`.cursor/BOOTSTRAP.md`）：

1. AI 会自我介绍
2. 询问你的信息
3. 选择自己的名字和性格
4. 建立主人关系

**示例对话**：

```
你：你好

AI：你好！我注意到这是我们的第一次对话。我叫什么名字呢？
    你更喜欢怎样的助理风格？

你：你叫小艾吧，我喜欢简洁高效的风格

AI：好的，我是小艾🤖，你的 AI 助理。以后我会以简洁高效的方式
    为你工作。请问你是做什么工作的？

你：我是后端工程师，主要用 Java

AI：明白了。我会记住这些信息，以后更好地服务你。
```

### 8.3 配置检查清单

启动前确认：

- [ ] Bun 已安装（`bun --version`）
- [ ] Cursor Agent CLI 可用（`agent --version`）
- [ ] 飞书应用已创建并配置
- [ ] `.env` 文件已正确填写
- [ ] `CURSOR_MODEL=auto`（重要！）

## 九、配置文件详解

### 9.1 .env 配置（适合你的账号）

```env
# ============ 飞书配置（必填）============
FEISHU_APP_ID=cli_xxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx

# ============ Cursor 配置 ============
# ⚠️ 重要：因为你的账号配额限制，必须使用 auto
CURSOR_MODEL=auto

# 通常不需要配置（CLI 会自动使用 IDE 登录）
# CURSOR_API_KEY=

# ============ 语音识别（可选）============
# 不配置则使用本地 whisper（质量较低）
# VOLC_STT_APP_ID=
# VOLC_STT_ACCESS_TOKEN=

# ============ 向量搜索（可选）============
# 用于记忆系统的语义搜索
# VOLC_EMBEDDING_API_KEY=
# VOLC_EMBEDDING_MODEL=doubao-embedding-vision-250615
```

### 9.2 项目配置（可选）

在项目上级目录创建 `projects.json`：

```bash
cd ~/work/cursor
cat > projects.json << 'EOF'
{
  "projects": {
    "remote-control": {
      "path": "/Users/user/work/cursor/remote-control",
      "description": "远程控制分析项目"
    },
    "mywork": {
      "path": "/Users/user/work/myproject",
      "description": "我的工作项目"
    }
  },
  "default_project": "mywork"
}
EOF
```

## 十、使用技巧

### 10.1 会话管理

**开始新对话**：
```
/新对话
```

**查看服务状态**：
```
/状态
```

**终止长时间任务**：
```
/停止
```

### 10.2 记忆系统

**记录重要信息**：
```
/记录 今天完成了用户模块的重构，采用了策略模式
```

**搜索历史记忆**：
```
/记忆 用户模块重构
```

**查看记忆状态**：
```
/记忆
```

**重建索引**（记忆混乱时）：
```
/整理记忆
```

### 10.3 定时任务

**创建定时任务**：
```
每天早上9点提醒我检查代码审查
```

或

```
每小时检查一次服务器状态
```

**管理任务**：
```
/任务           # 查看所有任务
/任务 暂停 1     # 暂停任务
/任务 恢复 1     # 恢复任务
/任务 删除 1     # 删除任务
/任务 执行 1     # 立即执行
```

### 10.4 心跳系统

**查看心跳状态**：
```
/心跳
```

**配置心跳**：
```
/心跳 开启
/心跳 间隔 30    # 每30分钟检查一次
```

**立即检查**：
```
/心跳 执行
```

## 十一、常见问题

### 11.1 服务无响应

```bash
# 1. 检查服务状态
bash service.sh status

# 2. 查看日志
bash service.sh logs

# 3. 重启服务
bash service.sh restart
```

### 11.2 飞书收不到消息

**检查清单**：
- [ ] 飞书应用已发布上线
- [ ] 机器人已添加到联系人
- [ ] 事件订阅使用"长连接模式"
- [ ] 权限已正确配置

### 11.3 语音识别质量差

**解决**：配置火山引擎 STT

不配置火山引擎时，默认使用本地 whisper-tiny 模型，中文识别质量较低。

### 11.4 API Key 无效

错误提示会自动显示 Dashboard 链接：

```
飞书发送：/密钥 sk-新的key
```

或编辑 `.env` 后，服务会自动热重载（无需重启）。

### 11.5 模型不可用

你的情况：

```env
# ✅ 可用
CURSOR_MODEL=auto

# ❌ 不可用（团队配额限制）
CURSOR_MODEL=sonnet-4.5
CURSOR_MODEL=sonnet-4.5-thinking
CURSOR_MODEL=opus-4.6-thinking
```

**解决**：使用 `auto` 模型，让系统自动选择。

### 11.6 群聊中敏感命令被拦截

设计如此，敏感命令（如 `/密钥`）只能在私聊中使用，群聊会自动拦截。

## 十二、进阶使用

### 12.1 个性化 AI 身份

编辑工作区的 `.cursor/rules/agent-identity.mdc`：

```markdown
---
description: AI 身份设置
alwaysApply: true
---

# 我的身份

- 名字：小艾
- Emoji：🤖
- 性格：简洁高效，不废话
- 专长：后端开发、系统设计
```

### 12.2 自定义记忆模板

编辑 `.cursor/MEMORY.md`：

```markdown
# 长期记忆

## 主人信息
- 职业：后端工程师
- 技术栈：Java/Spring Boot
- 工作重点：微服务架构

## 项目信息
- 主要项目：用户中心系统
- 技术难点：高并发、分布式事务

## 重要决策
- 2026-03-11：决定使用 Redis 作为缓存方案
```

### 12.3 配置心跳检查

编辑 `.cursor/HEARTBEAT.md`：

```markdown
# 心跳检查清单

## 每次检查项目
- [ ] 检查是否有新的 Git 提交
- [ ] 整理今天的记忆
- [ ] 检查待办事项

## 后台维护
- 整理会话日志
- 更新记忆索引
```

## 十三、实际使用示例

### 示例 1：远程写代码

**场景**：地铁上想到一个功能

```
[语音消息]
"帮我在用户服务里加一个手机号验证的功能，
需要发送短信验证码，验证码5分钟有效"
```

**AI 执行**：
1. 分析现有用户服务代码
2. 生成验证码服务类
3. 添加短信发送接口
4. 实现验证逻辑
5. 生成单元测试
6. 飞书实时显示进度

### 示例 2：代码审查

**场景**：手机上收到 PR 通知

```
审查最新提交的代码，重点看：
1. 是否有安全漏洞
2. 异常处理是否规范
3. 是否遵循编码规范
```

**AI 输出**：
- P0 问题：发现 SQL 注入风险
- P1 问题：异常被吞掉了
- P2 问题：命名不规范
- 附带修复代码

### 示例 3：知识积累

**日常记录**：
```
/记录 今天学习了 Kafka 的 exactly-once 语义，
关键是使用事务性生产者和幂等消费者
```

**几天后查询**：
```
/记忆 Kafka exactly-once

AI 返回：
2026-03-11 的记录：
关于 Kafka exactly-once 语义的笔记...
```

### 示例 4：定时任务

**创建定时提醒**：
```
每天下午6点提醒我提交代码
```

**创建定期检查**：
```
每2小时检查一次服务器 CPU 使用率，
超过 80% 就通知我
```

## 十四、故障排查

### 14.1 日志查看

```bash
# 实时日志
bash service.sh logs

# 或查看日志文件
tail -f ~/Library/Logs/feishu-cursor-claw.log
```

### 14.2 完全重启

```bash
# 1. 停止服务
bash service.sh stop

# 2. 清理进程（如果有残留）
pkill -f "feishu-cursor"
pkill -f "bun.*server.ts"

# 3. 重新启动
bash service.sh start

# 4. 查看状态
bash service.sh status
```

### 14.3 重置会话

如果会话状态混乱：

```
/新对话
```

### 14.4 重建记忆索引

如果记忆搜索不准确：

```
/整理记忆
```

### 14.5 飞书收不到消息 ⚠️ 重要

**症状**：
- ✅ WebSocket 长连接显示 `ws client ready`
- ✅ 服务运行正常，无报错
- ✅ 飞书发消息显示"已送达"
- ❌ 服务日志中没有 `[事件] 收到 im.message.receive_v1`
- ❌ 机器人完全无回复

**排查步骤**：

#### 步骤1：检查飞书开放平台日志

1. 飞书开放平台 → 你的应用 → "开发工具" → "日志检索"
2. 筛选时间：最近1小时
3. 筛选事件：`im.message.receive_v1`
4. **如果日志中完全没有推送记录** → 问题在飞书后台配置

#### 步骤2：检查权限配置 ✅ 关键

飞书开放平台 → 你的应用 → "权限管理"

**必须勾选的权限**：
- ✅ `im:message` - 获取与发送单聊、群组消息
- ✅ `im:message.p2p_msg:readonly` - 接收用户发送给机器人的单聊消息
- ✅ `im:message.group_at_msg:readonly` - 获取群组中@机器人的消息
- ✅ `im:message.group_msg` - 获取群组中的所有消息（如果需要群聊）
- ✅ `im:resource` - 获取与上传图片或文件资源

**如果权限不全**：
1. 勾选缺失的权限
2. 点击"保存"
3. **重新发布应用**（版本管理与发布 → 创建新版本 → 审核 → 发布）
4. 等待5分钟
5. 重启本地服务
6. 测试

#### 步骤3：检查事件订阅筛选条件 ✅ 关键

飞书开放平台 → "事件与回调" → "已添加事件" → `im.message.receive_v1`

**检查筛选范围**：
- ❌ **错误配置**：`Or 只发送由新用户发送（含自动回复）`
- ✅ **正确配置**：不设置任何筛选条件，或选择"接收所有消息"

**如果有筛选条件**：
1. 点击"删除事件"，删除 `im.message.receive_v1`
2. 点击"添加事件"
3. 重新添加 `im.message.receive_v1`
4. **不要设置任何筛选条件**
5. 点击"保存"
6. 重启本地服务
7. 测试

#### 步骤4：检查应用发布状态

飞书开放平台 → "应用发布" → "版本管理与发布"

**确认**：
- ✅ 最新版本状态为"已上线"
- ✅ 最新版本包含了上述权限和事件订阅配置
- ⚠️ 如果配置修改时间 > 版本创建时间 → 需要重新发布

#### 步骤5：验证日志

修改配置并重启服务后，再次发送消息，检查日志：

```bash
tail -f ~/Library/Logs/feishu-cursor-claw.log
```

应该看到：
```
[事件] 收到 im.message.receive_v1
[解析] type=text chat=p2p text="你的消息" img= file=
```

**如果还是收不到**：
- 检查是否给错了机器人发消息（搜索机器人名称确认）
- 检查企业是否限制了自建应用功能（联系企业管理员）

## 十五、最佳实践

### 15.1 配置建议

```env
# 推荐配置（基于你的账号情况）
CURSOR_MODEL=auto                    # 必须用 auto
FEISHU_APP_ID=cli_xxx               # 必填
FEISHU_APP_SECRET=xxx               # 必填
```

### 15.2 使用建议

1. **先测试后安装服务**：用 `bun run server.ts` 测试，确认正常后再 `service.sh install`
2. **定期查看日志**：`bash service.sh logs` 了解运行状态
3. **善用记忆系统**：重要信息用 `/记录` 保存
4. **会话管理**：长对话后用 `/新对话` 重置，避免上下文混乱
5. **项目路由**：多项目时配置 `projects.json`，用前缀切换

### 15.3 安全建议

1. **不要在群聊发送敏感命令**（系统会自动拦截）
2. **定期轮换 API Key**
3. **飞书应用仅限企业内部使用**

## 十六、升级与维护

### 16.1 更新项目

```bash
cd ~/work/cursor/feishu-cursor-claw

# 1. 停止服务
bash service.sh stop

# 2. 拉取最新代码
git pull

# 3. 更新依赖
bun install

# 4. 重启服务
bash service.sh start
```

### 16.2 备份配置

```bash
# 备份重要文件
cp .env .env.backup
cp ~/work/cursor/projects.json ~/work/cursor/projects.json.backup
```

## 快速启动检查清单

- [ ] Bun 已安装
- [ ] Cursor Agent CLI 可用
- [ ] 飞书应用已创建（长连接模式）
- [ ] `.env` 已配置（`CURSOR_MODEL=auto`）
- [ ] 运行 `bun run server.ts` 测试
- [ ] 飞书发消息测试连通性
- [ ] 确认正常后安装服务
- [ ] 完成首次"出生仪式"对话

---

**文档更新**：2026-03-11  
**适用版本**：feishu-cursor-claw main 分支  
**你的账号配置**：必须使用 `CURSOR_MODEL=auto`
