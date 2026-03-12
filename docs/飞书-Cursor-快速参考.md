# 飞书 → Cursor AI 快速参考

> 最后更新：2026-03-11

---

## 🎯 项目切换

### 默认项目（不需要前缀）
```
直接发送消息 → 在 moa 项目工作
```

### 切换项目（使用前缀）

#### 主项目
```
/moa 消息内容          → user-moa 项目
```

#### Ultron 服务（18个）
```
/api 消息内容          → ultron-api
/basic 消息内容        → ultron-basic
/basic-user 消息内容   → ultron-basic-user
/game 消息内容         → ultron-game
/activity 消息内容     → ultron-activity
/composite 消息内容    → ultron-composite
/discover 消息内容     → ultron-discover
/group-chat 消息内容   → ultron-group-chat
/guild 消息内容        → ultron-guild
/operation 消息内容    → ultron-operation
/relation 消息内容     → ultron-relation
/room 消息内容         → ultron-room
/sayhello 消息内容     → ultron-sayhello
/statistics 消息内容   → ultron-statistics
/wrapper 消息内容      → ultron-wrapper
/template 消息内容     → ultron-template
/dependency 消息内容   → ultron-dependency
/activity-independence → ultron-activity-independence
```

#### 工具项目
```
/remote-control 消息   → 远程控制分析
/feishu-claw 消息      → 飞书项目
```

---

## 📝 常用命令

### 对话管理
```
/新对话              → 重置会话上下文
/项目                → 查看所有项目列表
```

### 记忆系统
```
/记录 内容            → 保存重要信息到记忆
/搜索 关键词          → 搜索记忆内容
/整理记忆            → 重建记忆索引
```

### 任务管理
```
/定时 时间 任务       → 创建定时任务
/任务                → 查看所有定时任务
/取消定时 任务ID      → 取消定时任务
```

### 心跳检测
```
/心跳 开启            → 开启定时检测
/心跳 关闭            → 关闭定时检测
/心跳                → 查看心跳状态
```

---

## 🎨 Skills（已安装）

### 代码相关
- **code-review-expert** - 代码审查（触发词：代码审查、review）
- **code-analysis** - 代码分析（触发词：代码分析、架构梳理）
- **code-implementation** - 代码实现（触发词：代码实现、功能开发）

### 需求与设计
- **requirement-analysis** - 需求分析（触发词：需求分析、需求完善）
- **requirement-extraction** - 需求提取（触发词：需求提取、需求采集）
- **technical-design** - 技术设计（触发词：技术方案、架构设计）

### 测试与优化
- **testing-optimization** - 测试优化（触发词：测试、优化、重构）
- **systematic-debugging** - 系统调试（触发词：调试、排查）
- **auto-troubleshoot** - 自动排查（触发词：排查问题）

### 文档生成
- **api-doc-generator** - API文档生成（触发词：API文档、接口文档）

### 监控与查询
- **kibana-log-statistics** - Kibana日志分析
- **metrics-query** - 监控指标查询（QPS、RT、错误率）
- **trace-query** - 链路追踪查询（TraceId）
- **mse-config-query** - MSE配置查询
- **multilang-query** - 多语言配置查询
- **deploy-timeline** - 部署记录查询

### 飞书集成
- **lark-mcp** - 飞书多维表格、文档、消息
- **dingtalk-doc-reader** - 钉钉文档读取

### 其他工具
- **cross-repo-search** - 跨仓库代码搜索
- **service-ip-query** - 服务IP查询
- **ultron-appkey-lookup** - Ultron服务appKey查询

---

## 💡 使用技巧

### 1. 快速切换项目
```
最常用的可以用短别名：
/api       → ultron-api
/basic     → ultron-basic
/game      → ultron-game
```

### 2. 组合使用
```
/api 帮我分析一下接口的鉴权逻辑，顺便做个代码审查
→ 在 ultron-api 项目中分析代码并触发 code-review-expert skill
```

### 3. 记忆系统
```
遇到重要信息：
/记录 ultron-api 的鉴权流程使用 JWT token，过期时间为 7 天

以后查询：
/搜索 JWT 鉴权
```

### 4. 定时任务
```
/定时 每天09:00 检查线上服务是否有新的异常日志

/任务                      → 查看任务
/取消定时 任务ID            → 取消任务
```

### 5. 语音输入
```
直接发送语音消息 → 自动转文字处理
```

### 6. 图片识别
```
发送代码截图 → 自动识别并分析
发送架构图 → 分析架构设计
```

### 7. 长对话管理
```
对话太长影响上下文：
/新对话                    → 清空上下文重新开始
```

---

## ⚙️ 服务管理

### 查看状态
```bash
cd /Users/user/work/cursor/feishu-cursor-claw
bash service.sh status
```

### 查看日志
```bash
bash service.sh logs
```

### 重启服务
```bash
bash service.sh restart
```

### 停止服务
```bash
bash service.sh stop
```

### 启动服务
```bash
bash service.sh start
```

---

## 📋 配置文件位置

| 文件 | 路径 | 说明 |
|-----|------|------|
| 项目配置 | `/Users/user/work/cursor/projects.json` | 项目路由配置 |
| 环境变量 | `/Users/user/work/cursor/feishu-cursor-claw/.env` | 飞书凭据、模型设置 |
| 服务日志 | `/tmp/feishu-cursor.log` | 服务运行日志 |
| 系统服务 | `~/Library/LaunchAgents/com.feishu-cursor-claw.plist` | macOS 自启动配置 |

---

## 🔧 常见问题

### 1. 锁屏后能用吗？
✅ 可以（需要 Cursor IDE 保持运行 + 不休眠）
❌ 休眠/合盖后无法使用

### 2. 如何防止电脑休眠？
系统设置 → 锁定屏幕 → 关闭"电脑闲置时进入睡眠"

### 3. 配额限制？
必须使用 `CURSOR_MODEL=auto`（已配置）

### 4. 收不到消息？
检查：
- 飞书权限是否完整
- 事件订阅筛选条件是否为空
- 应用是否已发布

### 5. 添加新项目？
编辑 `/Users/user/work/cursor/projects.json`，然后：
```bash
cd /Users/user/work/cursor/feishu-cursor-claw
bash service.sh restart
```

---

## 📱 快速示例

### 代码分析
```
帮我分析一下当前项目的用户服务模块
```

### 代码审查
```
/api 审查一下 UserController.java 的代码
```

### 问题排查
```
/basic 最近线上出现了 NPE 异常，帮我排查一下可能的原因
```

### 监控查询
```
查询 ultron-api 最近1小时的 QPS 和错误率
```

### 链路追踪
```
帮我查询 TraceId: abc123 的完整调用链路
```

### 代码实现
```
帮我实现一个用户积分兑换的功能，需要考虑并发安全
```

---

## 🎯 最佳实践

1. **项目切换**：常用项目用短别名（/api、/game）
2. **记忆管理**：重要信息用 `/记录` 保存
3. **对话重置**：长对话后用 `/新对话` 清空上下文
4. **定时任务**：重复性检查用定时任务
5. **Skills 触发**：直接说"代码审查"、"需求分析"等关键词

---

**提示**：所有命令和 Skills 都可以直接在飞书与机器人对话中使用！🚀
