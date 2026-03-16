# 热点新闻定时推送功能设计

**日期**: 2026-03-16  
**状态**: ✅ 设计已确认  
**负责人**: AI Agent  
**相关项目**: cursor-remote-control（飞书/钉钉远程控制服务）

---

## 📋 设计目标

为 cursor-remote-control 项目新增"定时推送热点新闻"功能，用户可通过飞书/钉钉对话创建定时任务，到点自动抓取多平台热榜并推送到发起会话。

### 核心需求

1. **多数据源聚合** — 支持 newsnow API（优先）和 RSSHub（备选），未来可扩展
2. **对话式创建** — 用户说"每天9点推送热点"自动创建任务，无需手动配置
3. **双平台支持** — 飞书和钉钉均可推送，记录任务创建来源
4. **统一接口设计** — 便于后续扩展单平台直采（微博、知乎等）
5. **轻量实现** — 只做实时抓取，不存历史数据（降低开发成本）

### 非目标（暂不实现）

- ❌ 关键词过滤（未来可扩展）
- ❌ 历史数据查询（需要后台常驻抓取 + SQLite 存储）
- ❌ 自定义平台排序算法
- ❌ 用户个性化订阅

---

## 🏗️ 架构设计

### 模块划分

```
cursor-remote-control/
├── shared/
│   ├── news-sources/               # 新增：新闻源模块
│   │   ├── types.ts                # 统一接口定义
│   │   ├── newsnow.ts              # newsnow 适配器
│   │   ├── rsshub.ts               # RSSHub 适配器
│   │   ├── aggregator.ts           # 聚合器（去重、排序）
│   │   ├── formatter.ts            # 格式化为飞书/钉钉卡片
│   │   └── monitoring.ts           # 监控与健康检查
│   ├── news-fetcher.ts             # 新增：对外统一入口
│   └── scheduler.ts                # 已有：定时任务调度
├── config/
│   └── news-sources.json           # 新增：数据源配置
├── feishu/server.ts                # 修改：集成新闻推送
└── dingtalk/server-minimal.ts      # 修改：集成新闻推送
```

### 核心接口

```typescript
// shared/news-sources/types.ts

/** 新闻源统一接口 */
export interface NewsSource {
  id: string;                        // 唯一标识
  name: string;                      // 显示名称
  enabled: boolean;                  // 是否启用
  fetch(options: FetchOptions): Promise<NewsItem[]>;
}

/** 抓取选项 */
export interface FetchOptions {
  topN: number;                      // 获取前N条
  platforms?: string[];              // 可选：限定平台
}

/** 标准新闻条目 */
export interface NewsItem {
  platform: string;                  // 平台名称（"微博" | "知乎" | "百度"...）
  title: string;                     // 标题
  url: string;                       // 链接
  rank?: number;                     // 排名（可选）
  hotValue?: string;                 // 热度值（可选）
  description?: string;              // 简要内容/摘要（可选）
  timestamp?: number;                // 抓取时间戳
}
```

### 数据流

```
用户在飞书/钉钉 → "每天9点推送热点"
    ↓
server 正则识别 → 解析时间表达式
    ↓
scheduler.add() → 创建任务（记录 platform/webhook）
    ↓
保存到 cron-jobs-{platform}.json
    ↓
【到点触发】
    ↓
scheduler.tick() → onExecute(job)
    ↓
news-fetcher.fetchNews({ topN: 10 })
    ↓
并行调用各数据源
│ - newsnow.fetch()
│ - rsshub.fetch()
    ↓
aggregator 聚合 → 去重、排序
    ↓
formatter.formatNewsCard() → 格式化为卡片
    ↓
onDelivery(job, cardContent)
    ↓
根据 job.platform 推送
    ↓
用户收到热点推送 ✅
```

---

## ⚙️ 配置设计

### config/news-sources.json

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
        "feeds": [
          "weibo/search/hot",
          "zhihu/hotlist",
          "baidu/trending"
        ],
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

### 环境变量覆盖

```bash
# .env (可选)
NEWS_SOURCES_CONFIG=/path/to/custom-config.json
NEWS_DEFAULT_TOP_N=15
NEWS_RSSHUB_BASE_URL=https://my-rsshub.com
```

**优先级**: 环境变量 > config/news-sources.json > 硬编码默认值

---

## 💬 消息格式

### 飞书卡片样式

```markdown
📰 **今日热点新闻** (共 10 条)

━━━━━ 微博热搜 ━━━━━
1️⃣ **ChatGPT-5 正式发布** 🔥 123万
   OpenAI 宣布推出全新 ChatGPT-5，支持更长上下文和多模态输入...
   [查看详情](https://weibo.com/...)

2️⃣ **比亚迪月销量破纪录** 🔥 98万
   比亚迪 2 月销量达 35 万辆，超越特斯拉成为全球第一...
   [查看详情](https://weibo.com/...)

━━━━━ 知乎热榜 ━━━━━
1️⃣ **AI 芯片技术突破** 🔥 1.2k 关注
   英伟达发布新一代 AI 芯片，算力提升 10 倍，功耗降低 40%...
   [查看详情](https://zhihu.com/...)

⏱ 更新时间：2026-03-16 09:00:15
📊 数据来源：NewsNow API
```

### 钉钉消息样式

```markdown
# 📰 今日热点新闻

**微博热搜**
- **ChatGPT-5 正式发布** 🔥 123万
  OpenAI 宣布推出全新 ChatGPT-5...
  [查看详情](https://weibo.com/...)

**知乎热榜**
- **AI 芯片技术突破** 🔥 1.2k 关注
  英伟达发布新一代 AI 芯片...
  [查看详情](https://zhihu.com/...)

---
⏱ 2026-03-16 09:00 | 📊 NewsNow API
```

### 超长消息处理

- **飞书**：单卡片 ≤ 30KB，超过则分批推送（"第 1/3 批"）
- **钉钉**：单消息 ≤ 20KB，同样分批

```typescript
// formatter.ts
export function formatNewsCard(
  items: NewsItem[], 
  platform: 'feishu' | 'dingtalk'
): string[] {
  const grouped = groupByPlatform(items);
  const maxSize = platform === 'feishu' ? 30000 : 20000;
  
  const chunks: string[] = [];
  let currentChunk = header;
  
  for (const [platformName, news] of Object.entries(grouped)) {
    const section = formatSection(platformName, news);
    if (currentChunk.length + section.length > maxSize) {
      chunks.push(currentChunk);
      currentChunk = header;
    }
    currentChunk += section;
  }
  chunks.push(currentChunk);
  
  return chunks.map((c, i) => 
    chunks.length > 1 ? `[第 ${i+1}/${chunks.length} 批]\n\n${c}` : c
  );
}
```

---

## 🛡️ 错误处理与容错

### 分层错误策略

| 层级 | 策略 | 用户影响 |
|------|------|---------|
| **数据源层** | 单源失败不影响其他源，至少1个成功即可 | 部分平台数据缺失 |
| **API 调用层** | 超时重试（最多3次），指数退避 | 延迟 2-6 秒 |
| **定时任务层** | 失败推送错误通知，连续5次失败自动禁用 | 收到错误提示 |

### 错误类型处理

```typescript
// 1. 单个源失败 → 跳过，使用其他源
async function fetchNews(options: FetchOptions): Promise<NewsItem[]> {
  const sources = loadEnabledSources();
  const results = await Promise.allSettled(
    sources.map(s => s.fetch(options))
  );
  
  const items: NewsItem[] = [];
  const errors: string[] = [];
  
  for (const [idx, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      items.push(...result.value);
    } else {
      errors.push(`${sources[idx].name}: ${result.reason}`);
      console.error(`[新闻源失败] ${sources[idx].name}:`, result.reason);
    }
  }
  
  // 至少有一个源成功才算成功
  if (items.length === 0) {
    throw new Error(`所有数据源失败：\n${errors.join('\n')}`);
  }
  
  return items;
}

// 2. 网络故障 → 重试
async function fetchWithRetry(
  url: string, 
  maxRetries = 2, 
  timeout = 10000
): Promise<any> {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i === maxRetries) throw err;
      await sleep(1000 * (i + 1));  // 指数退避
    }
  }
}

// 3. 定时任务失败 → 降级推送错误通知
scheduler.onExecute = async (job) => {
  try {
    const items = await fetchNews({ topN: 10 });
    const content = formatNewsCard(items, job.platform);
    return { status: "ok", result: content };
  } catch (err) {
    const fallback = `⚠️ 热点抓取失败\n\n${err.message}\n\n稍后会自动重试`;
    return { status: "error", error: err.message, result: fallback };
  }
}
```

### 监控与健康检查

```typescript
// shared/news-sources/monitoring.ts
export interface FetchMetrics {
  source: string;
  success: boolean;
  duration: number;
  itemCount: number;
  error?: string;
}

const metrics: FetchMetrics[] = [];

export function recordMetrics(m: FetchMetrics) {
  metrics.push(m);
  if (metrics.length > 100) metrics.shift();
  
  // 错误率告警
  const recent = metrics.slice(-10);
  const errorRate = recent.filter(x => !x.success).length / recent.length;
  if (errorRate > 0.5) {
    console.warn(`[告警] ${m.source} 错误率 ${(errorRate * 100).toFixed(1)}%`);
  }
}

// 添加 /新闻状态 命令
export function getHealthStatus(): string {
  const bySource = groupBy(metrics.slice(-20), m => m.source);
  const lines = Object.entries(bySource).map(([name, items]) => {
    const success = items.filter(x => x.success).length;
    const total = items.length;
    const avgDuration = items.reduce((s, x) => s + x.duration, 0) / total;
    return `${name}: ${success}/${total} 成功，平均 ${avgDuration}ms`;
  });
  return lines.join('\n');
}
```

---

## 🧪 测试策略

### 单元测试

```typescript
// shared/news-sources/__tests__/aggregator.test.ts
import { describe, test, expect } from 'bun:test';
import { deduplicateByUrl, deduplicateByTitle } from '../aggregator';

describe('aggregator', () => {
  test('按 URL 去重', () => {
    const items = [
      { platform: 'weibo', title: 'A', url: 'http://a.com' },
      { platform: 'zhihu', title: 'A', url: 'http://a.com' },
    ];
    const result = deduplicateByUrl(items);
    expect(result).toHaveLength(1);
  });
  
  test('按标题相似度去重', () => {
    const items = [
      { platform: 'weibo', title: 'ChatGPT-5 正式发布', url: 'http://a.com' },
      { platform: 'zhihu', title: 'ChatGPT5 正式发布了', url: 'http://b.com' },
    ];
    const result = deduplicateByTitle(items, 0.85);
    expect(result).toHaveLength(1);
  });
});
```

### 集成测试

```typescript
// shared/news-sources/__tests__/integration.test.ts
test('完整流程测试', async () => {
  const items = await fetchNews({ topN: 5 });
  expect(items.length).toBeGreaterThan(0);
  expect(items[0]).toHaveProperty('title');
  expect(items[0]).toHaveProperty('url');
});

test('数据源失败降级', async () => {
  // Mock newsnow 失败，RSSHub 成功
  const items = await fetchNews({ topN: 5 });
  expect(items.length).toBeGreaterThan(0);
});
```

### 手动验证清单

部署前必须完成：

- [ ] newsnow API 可正常访问（`curl https://api.newsnow.cn/...`）
- [ ] RSSHub 公共实例可用（`curl https://rsshub.app/weibo/search/hot`）
- [ ] 飞书推送正常（创建测试任务：`/任务 测试 5分钟后推送热点`）
- [ ] 钉钉推送正常（同上）
- [ ] 超长消息分批（配置 topN=50 测试）
- [ ] 所有源失败时错误提示清晰
- [ ] `/新闻状态` 命令显示健康度

---

## 🔄 对话交互示例

### 创建任务

**用户**："每天早上 9 点推送今日热点"

**系统识别**：
- 时间：cron 表达式 `0 1 * * *`（UTC，对应北京 9:00）
- 任务类型：`fetch-news`
- 参数：`{ topN: 10 }`

**回复**：
```
✅ 已创建定时任务

⏰ 执行时间：每天 09:00
📰 推送内容：今日热点新闻（Top 10）
📱 推送平台：飞书

发送 `/任务` 可查看所有任务
```

### 管理任务

| 命令 | 说明 |
|------|------|
| `/任务` 或 `/cron` | 查看所有定时任务 |
| `/任务 停用 abc123` | 停用指定任务 |
| `/任务 启用 abc123` | 启用指定任务 |
| `/任务 删除 abc123` | 删除指定任务 |
| `/任务 执行 abc123` | 立即执行一次 |
| `/新闻状态` | 查看数据源健康度 |

---

## 📊 技术决策

### 为什么不存历史数据？

**决策**：轻量版只做实时抓取

**理由**：
1. newsnow/RSSHub API 不提供历史快照
2. 存历史需要后台常驻抓取（增加服务负担）
3. 用户核心需求是"看当前热点"，历史对比是次要需求
4. 未来可扩展：如果需求强烈，再增加 SQLite 存储模块

### 为什么用统一接口而非直接调用？

**决策**：定义 `NewsSource` 接口，各源独立实现

**理由**：
1. **易扩展** — 未来加微博直采、抖音 API 只需实现接口
2. **易测试** — 每个源独立开发测试，互不影响
3. **易维护** — 源失败不影响其他源，降低系统脆弱性
4. **开发成本** — 初次设计接口略重，但后续扩展几乎零成本

### 为什么分批推送而非分多条消息？

**决策**：超长内容拆分为多批，每批标注序号

**理由**：
1. **消息连续性** — 分批比分条更直观（用户看到完整推送）
2. **平台限制** — 飞书/钉钉有单条消息大小限制
3. **实现简单** — formatter 层统一处理，不侵入业务逻辑

---

## 🚀 未来扩展方向

### 阶段 2：关键词过滤（如需要）

- 配置文件支持关键词列表（如 `["AI", "比亚迪", "教育政策"]`）
- aggregator 层增加过滤逻辑
- 保留"全量推送"选项供用户切换

### 阶段 3：历史数据支持（如需要）

- 后台定时抓取（每 30 分钟一次）
- 数据存入 SQLite（复用 memory.ts 的 DB）
- 支持"昨日热点"、"本周热门"查询
- 新增 `/新闻 昨日` 命令手动查询

### 阶段 4：单平台直采

- 新增 `weibo.ts`、`zhihu.ts` 等适配器
- 直接调用平台官方 API（更丰富的数据字段）
- 需处理 cookie/token、反爬策略

---

## ✅ 设计确认

- ✅ 架构设计已确认
- ✅ 数据流已确认
- ✅ 配置设计已确认
- ✅ 消息格式已确认
- ✅ 错误处理已确认
- ✅ 测试策略已确认

**下一步**：生成详细实现计划（writing-plans skill）

---

## 📚 参考资料

- [TrendRadar 项目](https://github.com/sansan0/TrendRadar)
- [newsnow 开源项目](https://github.com/ourongxing/newsnow)
- [RSSHub 文档](https://docs.rsshub.app/)
- [项目 AGENTS.md](/Users/user/work/cursor/cursor-remote-control/AGENTS.md)
- [定时任务规则](/.cursor/CRON-TASK-RULES.md)
