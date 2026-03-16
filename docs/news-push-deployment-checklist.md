# 热点新闻推送 - 部署检查清单

> 部署前请逐项确认，确保功能正常。

---

## 1. 环境变量配置

| 变量 | 说明 | 必填 | 示例 |
|------|------|------|------|
| `CURSOR_CRON_FILE` | 定时任务文件绝对路径 | 由服务自动设置 | `/path/to/cron-jobs-feishu.json` |
| `CURSOR_PLATFORM` | 平台标识 | 由服务自动设置 | `feishu` 或 `dingtalk` |
| `CURSOR_WEBHOOK` | 回调地址 | 由服务自动设置 | chatId 或 webhook URL |
| `NEWS_SOURCES_CONFIG` | 新闻源配置文件路径 | 可选 | 默认 `config/news-sources.json` |
| `NEWS_SOURCES_NEWSNOW_ENABLED` | 启用/禁用 NewsNow 源 | 可选 | `true` / `false` |
| `NEWS_SOURCES_NEWSNOW_APIURL` | NewsNow API 地址 | 可选 | 覆盖 config 中的 baseUrl |

---

## 2. 配置文件 Review

### config/news-sources.json

- [ ] 文件存在且 JSON 格式正确
- [ ] `sources` 中至少一个 `enabled: true`
- [ ] `newsnow` 的 `config.platforms` 包含所需平台（weibo, zhihu, baidu 等）
- [ ] `rsshub` 若启用，`config.baseUrl` 可访问
- [ ] `aggregation.deduplicateByUrl` / `deduplicateByTitle` 按需配置
- [ ] `formatting.maxItemsPerPlatform` 合理（建议 ≤ 10）

### cron-jobs-*.json

- [ ] 飞书：`cron-jobs-feishu.json` 存在（或 .example 已复制）
- [ ] 钉钉：`cron-jobs-dingtalk.json` 存在（或 .example 已复制）
- [ ] 任务包含 `platform` 和 `webhook` 字段
- [ ] 新闻任务 `message` 为 `{"type":"fetch-news","options":{"topN":10}}` 格式

---

## 3. 日志输出检查

所有日志使用英文（符合编码规范）：

- [ ] `[newsnow]` / `[rsshub]` 错误日志为英文
- [ ] `[news-fetcher]` 源失败日志为英文
- [ ] `[monitoring]` 告警日志为英文
- [ ] `[scheduler]` 任务触发/抓取/发送日志为英文

---

## 4. 核心功能验证

### 4.1 命令创建任务

**飞书：** 发送 `/新闻 明天上午10点推送10条热点`

- [ ] 收到「已创建定时任务」卡片
- [ ] 文案包含「到时会通过**飞书**提醒你」
- [ ] `cron-jobs-feishu.json` 中新增任务，`schedule.kind` 为 `at`，时间为明天 10:00
- [ ] `message` 含 `"topN":10`

**钉钉：** 发送 `/新闻 明天上午10点推送10条热点`

- [ ] 收到「已创建定时任务」卡片
- [ ] 文案包含「到时会通过**钉钉**提醒你」
- [ ] `cron-jobs-dingtalk.json` 中新增任务

### 4.2 自然语言创建任务

**飞书：** 发送 `明天上午10点推送10条热点`

- [ ] 同上，任务创建成功，文案正确

**钉钉：** 发送 `明天上午10点推送10条热点`

- [ ] 同上，任务创建成功，文案正确

### 4.3 时间解析

- [ ] `明天上午10点` → 明天 10:00
- [ ] `明天下午3点` → 明天 15:00
- [ ] `每天9点` → cron `0 9 * * *`（Asia/Shanghai）
- [ ] `10条` / `推送10条` → topN=10

### 4.4 /新闻状态 命令

- [ ] 飞书：`/新闻状态` 或 `/health` 返回健康状态卡片
- [ ] 钉钉：`/新闻状态` 或 `/health` 返回健康状态
- [ ] 无数据时显示「暂无数据」
- [ ] 有数据时显示各源成功率、平均延迟、错误数

### 4.5 任务执行（可选，不等待实际执行）

- [ ] `/任务 执行 <id>` 可立即触发新闻抓取
- [ ] 抓取成功后收到热点新闻消息（或错误提示）

---

## 5. 导入路径检查

- [ ] `feishu/server.ts` 正确导入 `news-fetcher.js`、`monitoring.js`
- [ ] `dingtalk/server-minimal.ts` 正确导入 `news-fetcher.js`、`monitoring.js`
- [ ] `shared/news-fetcher.ts` 正确导入 types、config-loader、newsnow、rsshub、aggregator、formatter

---

## 6. 测试命令

```bash
# 运行完整测试套件
bun test

# 预期：67 pass, 0 fail
```

---

## 7. 部署后验证

1. 启动服务：`bun run feishu/server.ts` 或 `bun run dingtalk/server-minimal.ts`
2. 在对应平台发送：`/新闻 明天上午10点推送10条热点`
3. 检查 `cron-jobs-*.json` 是否写入新任务
4. 发送 `/新闻状态` 确认健康检查正常
5. （可选）发送 `/任务 执行 <task-id>` 验证抓取和推送

---

**完成标志：** 所有检查项通过，测试全部通过，代码已提交。
