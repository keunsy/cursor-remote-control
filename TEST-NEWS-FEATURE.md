# 新闻推送功能测试指南

## 测试状态

✅ **代码测试**: 67 个单元测试全部通过  
✅ **功能测试**: Mock 数据源验证通过  
🔧 **待验证**: 在飞书/钉钉中的真实场景测试

---

## 快速测试清单

### 1️⃣ 命令测试

在飞书或钉钉中发送以下命令：

```
/新闻 明天上午10点推送10条热点
```

**预期结果**：
- ✅ 收到回复：`已创建定时任务...到时会通过**飞书**提醒你` (或**钉钉**)
- ✅ 任务文件更新：
  ```bash
  # 飞书
  cat /Users/user/work/cursor/cursor-remote-control/cron-jobs-feishu.json
  
  # 钉钉
  cat /Users/user/work/cursor/cursor-remote-control/cron-jobs-dingtalk.json
  ```
- ✅ 任务包含：
  - `type: "fetch-news"`
  - `options.topN: 10`
  - 正确的 `schedule` (明天上午10:00)

---

### 2️⃣ 健康检查测试

发送命令：

```
/新闻状态
```

**预期结果**：
- ✅ 显示数据源健康状态
- ✅ 包含成功率、平均延迟、错误次数

---

### 3️⃣ 自然语言测试

直接发送自然语言：

```
每天早上9点推送今日热点
```

**预期结果**：
- ✅ 自动识别为新闻推送任务
- ✅ 创建 cron 任务 (0 9 * * *)
- ✅ 回复文案正确

---

### 4️⃣ 立即测试（手动触发）

如果想立即看到新闻推送效果，可以：

**方法 A：创建即刻任务**
```
/新闻 1分钟后推送5条热点
```

**方法 B：直接运行测试脚本**
```bash
cd /Users/user/work/cursor/cursor-remote-control
bun run test-news-now.ts
```

---

## 测试场景覆盖

### ✅ 已验证

| 场景 | 状态 | 方式 |
|------|------|------|
| 类型定义 | ✅ 通过 | 单元测试 |
| newsnow 适配器 | ✅ 通过 | 单元测试 (mock) |
| RSSHub 适配器 | ✅ 通过 | 单元测试 (mock) |
| 聚合去重 | ✅ 通过 | 单元测试 |
| 消息格式化 | ✅ 通过 | 单元测试 |
| 配置加载 | ✅ 通过 | 单元测试 |
| 统一入口 | ✅ 通过 | 集成测试 |
| Mock 数据源 | ✅ 通过 | 手动测试 |

### 🔄 待验证

| 场景 | 状态 | 如何验证 |
|------|------|----------|
| 定时任务创建 | 🔄 待测 | 在飞书/钉钉发送 `/新闻` 命令 |
| 定时任务执行 | 🔄 待测 | 等待定时触发或创建1分钟后任务 |
| 健康检查命令 | 🔄 待测 | 发送 `/新闻状态` |
| 多消息分片 | 🔄 待测 | 推送大量新闻（topN=50） |
| 平台差异 | 🔄 待测 | 分别在飞书/钉钉测试 |

---

## 当前配置

```json
{
  "启用数据源": "Mock 数据源（演示用）",
  "newsnow": "已禁用（网络不可达）",
  "rsshub": "已禁用（网络不可达）",
  "defaultTopN": 10
}
```

**Mock 数据内容**：
- 微博热搜 3 条
- 知乎热榜 2 条
- 百度热搜 2 条
- 抖音热点 2 条
- 今日头条 1 条

---

## 测试命令参考

### 基础命令

```bash
# 每天早上9点推送
/新闻 每天9点推送10条热点

# 明天上午10点推送
/新闻 明天上午10点推送前15条

# 每小时推送
/新闻 每小时推送5条热点

# 查看任务
/cron

# 查看健康状态
/新闻状态

# 删除任务
/cron delete <任务ID>
```

### 自然语言

```
每天早上9点推送今日热点
明天上午10点推送新闻
每2小时推送热点新闻
```

---

## 故障排查

### 问题：命令无响应

**检查步骤**：
1. 查看服务日志：`tail -f /tmp/feishu-cursor.log`
2. 确认服务运行：`ps aux | grep cursor-remote-control`
3. 重启服务：`./restart-services.sh`

### 问题：任务不执行

**检查步骤**：
1. 查看任务文件：`cat cron-jobs-feishu.json`
2. 确认任务 `enabled: true`
3. 检查时区设置：任务应该使用 `tz: "Asia/Shanghai"`

### 问题：数据源失败

**检查步骤**：
1. 发送 `/新闻状态` 查看健康状态
2. 查看配置：`cat config/news-sources.json`
3. 检查网络：`curl -m 5 https://api.newsnow.cn`

---

## 下一步

### 配置真实数据源

当网络环境支持时，修改 `config/news-sources.json`:

```json
{
  "sources": [
    {
      "id": "mock",
      "enabled": false  ← 关闭 mock
    },
    {
      "id": "newsnow",
      "enabled": true,  ← 启用真实 API
      "config": {
        "baseUrl": "https://api.newsnow.cn",
        ...
      }
    }
  ]
}
```

或使用环境变量：

```bash
export NEWS_SOURCES_MOCK_ENABLED=false
export NEWS_SOURCES_NEWSNOW_ENABLED=true
```

### 添加更多数据源

参考 `shared/news-sources/mock.ts` 创建新的数据源适配器。

---

## 性能指标

| 指标 | 当前值 |
|------|--------|
| 单元测试 | 67 pass, 0 fail |
| 测试覆盖 | 9 个模块 |
| Mock 延迟 | ~200ms |
| 消息生成 | <100ms |

---

**最后更新**: 2026-03-16  
**测试环境**: macOS, Bun 1.3.10
