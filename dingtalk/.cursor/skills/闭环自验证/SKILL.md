---
name: 闭环自验证
description: Agent 闭环自验证工作流，在完成代码修改后自动执行"写代码→构建→验证UI→查日志→修复→再验证"的完整循环。当 Agent 完成功能开发、Bug 修复、UI 修改、API 变更或任何代码改动后，应主动触发此验证流程，确保改动真正生效且无副作用。适用于 Web 前后端项目的闭环验证。
---

# Agent 闭环自验证工作流

核心理念：**写完代码不是终点，验证通过才算完成。** Agent 应像人类工程师一样，改完代码后"打开浏览器看看对不对、查看日志有没有报错、确认性能正常"。

## 何时触发

每次完成以下任何改动后，**必须**进入验证循环：

- 前端 UI 变更（组件、样式、布局）
- 后端 API 变更（接口、逻辑、数据结构）
- Bug 修复
- 配置变更（Docker、Nginx、环境变量）
- 数据库 schema 变更

## 验证循环流程

```
┌─────────┐
│ 写代码   │
└────┬────┘
     ▼
┌─────────┐
│ 构建/部署 │ ← docker compose up --build / npm run build
└────┬────┘
     ▼
┌─────────────┐
│ 静态检查     │ ← Linter + TypeCheck
└────┬────────┘
     ▼
┌─────────────┐
│ UI 验证(眼睛) │ ← 浏览器快照 + 截图 + 控制台
└────┬────────┘
     ▼
┌──────────────────┐
│ 系统验证(听诊器)   │ ← 容器日志 + 健康检查 + 网络请求
└────┬─────────────┘
     ▼
┌─────────┐    失败    ┌─────────┐
│ 判定结果  │─────────→│ 定位修复  │──→ 返回"写代码"
└────┬────┘           └─────────┘
     │ 通过
     ▼
┌─────────┐
│ 任务完成  │
└─────────┘
```

## 第一步：构建与部署验证

代码改动后，先确认构建成功：

```bash
# 前端项目
docker compose up --build -d <service-name>
docker logs <container-name> --tail 30

# 检查容器状态
docker ps --filter "name=<container-name>" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

**判定标准**：容器状态为 `Up`，无 `Restarting`，日志无 Error/Exception。

## 第二步：静态检查

```bash
# 使用 ReadLints 工具检查已编辑文件
# 如果有 TypeScript，检查类型错误
docker exec <container-name> npx tsc --noEmit 2>&1 | tail -20
```

**判定标准**：无新增 linter 错误，无类型错误。

## 第三步：UI 验证（装"眼睛"）

对于前端变更，使用浏览器 MCP 工具验证：

### 3.1 导航到目标页面

```
browser_navigate → 目标 URL
browser_snapshot → 获取页面结构（相当于 DOM "X光片"）
```

### 3.2 验证页面元素

```
browser_snapshot(interactive: true) → 检查交互元素是否存在且可操作
browser_is_visible(selector) → 确认关键元素可见
browser_get_input_value → 验证表单默认值
```

### 3.3 验证交互行为

```
browser_click / browser_fill → 模拟用户操作
browser_snapshot(includeDiff: true) → 对比操作前后的页面变化
```

### 3.4 检查前端错误

```
browser_console_messages → 检查是否有 JS 错误或警告
browser_network_requests → 检查 API 请求是否成功（无 4xx/5xx）
```

### 3.5 视觉确认

```
browser_take_screenshot(fullPage: true) → 截取完整页面
```

**判定标准**：
- 目标元素存在且可见
- 控制台无 error 级别消息
- 网络请求全部成功
- 交互行为符合预期

## 第四步：系统验证（装"听诊器"）

### 4.1 容器日志检查

```bash
# 查看最近日志，过滤错误
docker logs <container-name> --since 2m 2>&1 | grep -iE "error|exception|traceback|failed"

# 后端 API 日志
docker logs <backend-container> --since 2m 2>&1 | tail -50
```

### 4.2 健康检查

```bash
# API 可达性
curl -s -o /dev/null -w "%{http_code}" https://<domain>/api/health

# 响应时间
curl -s -o /dev/null -w "%{time_total}" https://<domain>/api/<endpoint>
```

### 4.3 容器资源

```bash
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" <container-name>
```

**判定标准**：
- 无 error/exception 日志
- API 返回 2xx
- 响应时间合理（一般 <2s）
- 内存/CPU 无异常飙升

## 第五步：结果判定与闭环

### 全部通过

向用户报告验证结果：
- 列出已验证的检查点
- 附上关键截图（如有 UI 变更）
- 标记任务完成

### 发现问题

1. **定位**：根据错误信息定位问题代码
2. **修复**：修改代码
3. **重新验证**：从第一步重新开始完整循环
4. **最多重试 3 次**，若仍失败则向用户报告问题详情和已尝试的修复方案

## 验证报告模板

验证完成后，按此格式汇报：

```
验证结果：✅ 通过 / ❌ 失败

构建状态：✅ 容器正常运行
静态检查：✅ 无 linter/类型错误
UI 验证：✅ 页面元素正确，交互正常
  - 控制台：无错误
  - 网络请求：全部 2xx
系统验证：✅ 日志无异常
  - 健康检查：200 OK
  - 响应时间：0.3s

[如有截图附在此处]
```

## 按场景选择验证深度

| 变更类型 | 构建 | 静态检查 | UI验证 | 系统验证 |
|---------|------|---------|-------|---------|
| 前端 UI | ✅ | ✅ | ✅ 完整 | ⚡ 轻量 |
| 后端 API | ✅ | ✅ | ⚡ 轻量 | ✅ 完整 |
| 全栈变更 | ✅ | ✅ | ✅ 完整 | ✅ 完整 |
| 配置变更 | ✅ | - | ⚡ 轻量 | ✅ 完整 |
| 样式微调 | ✅ | ✅ | ✅ 截图 | - |

⚡ 轻量 = 只做基础检查（健康检查 + 控制台无错误）

## 关键原则

1. **不要假设改动有效** — 每次都验证
2. **先看全局再看细节** — 先确认构建成功和容器正常，再验证具体功能
3. **浏览器快照优于截图** — snapshot 可解析、可交互，screenshot 仅供视觉确认
4. **日志要带时间范围** — 用 `--since` 过滤，避免被历史日志干扰
5. **验证循环有上限** — 最多 3 轮，避免无限循环

## 补充资源

- 具体场景示例见 [examples.md](examples.md)
