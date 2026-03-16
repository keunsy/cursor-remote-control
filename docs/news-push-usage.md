# 热点新闻定时推送 - 使用文档

> 在飞书或钉钉中通过对话创建定时任务，到点自动抓取多平台热榜并推送。

---

## 功能介绍

- **定时推送**：每天固定时间自动推送微博、知乎、百度、抖音、今日头条等平台的热点新闻
- **多平台支持**：飞书和钉钉均可使用，任务独立管理
- **智能去重**：自动合并多源数据，去除重复新闻
- **分批发送**：内容过长时自动分片，避免消息超限

---

## 快速开始

### 1. 创建定时任务

在飞书或钉钉对话中，用自然语言发送即可：

| 说法示例 | 说明 |
|----------|------|
| 每天 9 点推送热点 | 每天 9:00 推送 |
| 每天早上推送今日新闻 | 默认 9:00 |
| 18:00 推送热榜 | 每天 18:00 推送 |
| 定时推送热点新闻 | 默认 9:00 |

系统会自动创建定时任务，到点执行。

### 2. 命令方式（可选）

也可以通过指令创建：

```
/任务 添加 每天9点 热点新闻
```

---

## 任务管理

| 命令 | 说明 |
|------|------|
| `/任务` 或 `/cron` | 查看所有定时任务 |
| `/任务 暂停 <ID>` | 暂停指定任务 |
| `/任务 恢复 <ID>` | 恢复指定任务 |
| `/任务 删除 <ID>` | 删除指定任务 |
| `/任务 执行 <ID>` | 立即执行一次（不等到定时时间） |
| `/新闻状态` | 查看数据源健康状态（飞书支持） |

---

## 配置说明

### 配置文件：config/news-sources.json

项目根目录下的 `config/news-sources.json` 控制数据源和展示格式。

**完整示例：**

```json
{
  "version": 1,
  "defaultTopN": 10,
  "sources": [
    {
      "id": "newsnow",
      "name": "NewsNow API",
      "enabled": true,
      "type": "newsnow",
      "config": {
        "baseUrl": "https://api.newsnow.cn",
        "platforms": ["weibo", "zhihu", "baidu", "douyin", "toutiao"],
        "timeout": 10000
      }
    },
    {
      "id": "rsshub",
      "name": "RSSHub",
      "enabled": false,
      "type": "rsshub",
      "config": {
        "baseUrl": "https://rsshub.app",
        "feeds": ["weibo/search/hot", "zhihu/hotlist", "baidu/trending"],
        "timeout": 15000
      }
    }
  ],
  "aggregation": {
    "deduplicateByUrl": true,
    "deduplicateByTitle": true,
    "titleSimilarityThreshold": 0.85,
    "sortBy": "rank"
  },
  "formatting": {
    "maxItemsPerPlatform": 10,
    "includeRank": true,
    "includeHotValue": true,
    "includeDescription": true,
    "descriptionMaxLength": 80,
    "includeUrl": true
  }
}
```

**主要字段说明：**

| 字段 | 说明 |
|------|------|
| `defaultTopN` | 默认每条新闻源抓取数量 |
| `sources[].enabled` | 是否启用该数据源 |
| `sources[].config.platforms` | NewsNow 平台：weibo / zhihu / baidu / douyin / toutiao |
| `sources[].config.feeds` | RSSHub 订阅路径 |
| `formatting.maxItemsPerPlatform` | 每个平台最多展示几条 |
| `formatting.includeHotValue` | 是否显示热度值 |

### 环境变量覆盖

在 `.env` 中可覆盖部分配置：

| 变量 | 说明 |
|------|------|
| `NEWS_SOURCES_CONFIG` | 配置文件路径 |
| `NEWS_SOURCES_NEWSNOW_ENABLED` | 启用/禁用 NewsNow（true/false） |
| `NEWS_SOURCES_NEWSNOW_BASEURL` | NewsNow API 地址 |
| `NEWS_SOURCES_NEWSNOW_TIMEOUT` | 超时时间（毫秒） |
| `NEWS_SOURCES_RSSHUB_ENABLED` | 启用/禁用 RSSHub |
| `NEWS_SOURCES_RSSHUB_BASEURL` | RSSHub 地址 |

**示例：**

```bash
# .env
NEWS_SOURCES_RSSHUB_ENABLED=true
NEWS_SOURCES_RSSHUB_BASEURL=https://my-rsshub.example.com
```

---

## 故障排查

### 推送失败或没有收到

1. **检查任务是否启用**：发送 `/任务` 查看任务列表，确认状态为「启用」
2. **检查数据源**：发送 `/新闻状态`（飞书）查看各源健康度
3. **手动执行**：`/任务 执行 <任务ID>` 立即触发一次，观察是否成功

### 常见错误

| 错误信息 | 可能原因 | 处理方式 |
|----------|----------|----------|
| 所有数据源失败 | 网络不可达或 API 变更 | 检查网络，确认 `config/news-sources.json` 中的 baseUrl 正确 |
| 没有启用的数据源 | 全部源被禁用 | 在配置中至少启用一个源（`enabled: true`） |
| 热点抓取失败 | 请求超时或接口错误 | 查看服务日志，适当增加 `timeout` |

### 查看日志

```bash
# 飞书服务
cd feishu && bash service.sh logs

# 钉钉服务
cd dingtalk && bash service.sh logs
```

日志中搜索 `[定时]` 或 `[新闻源失败]` 可定位问题。

---

## 常见问题 FAQ

**Q: 如何修改推送时间？**  
A: 发送 `/任务` 查看任务 ID，删除旧任务后重新创建即可。

**Q: 飞书和钉钉的任务可以共用吗？**  
A: 不能。飞书和钉钉各自维护任务列表，在哪个平台创建的任务会推送到哪个平台。

**Q: 推送内容太长怎么办？**  
A: 系统会自动分片发送，多条消息会按顺序推送。

**Q: 如何添加更多数据源？**  
A: 在 `config/news-sources.json` 中启用 RSSHub，或修改 `platforms` 增加更多平台。

**Q: 数据源失败会影响推送吗？**  
A: 部分源失败时，其他源仍会正常抓取并推送。只有全部源失败时才会推送失败提示。

---

## 技术参考

- [实现计划](plans/2026-03-16-news-push-implementation.md)
- [设计文档](plans/2026-03-16-news-push-feature-design.md)
