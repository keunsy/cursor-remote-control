# 热点新闻定时推送功能实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为 cursor-remote-control 新增定时推送热点新闻功能，用户通过对话创建任务，到点自动抓取多平台热榜并推送。

**Architecture:** 统一的 NewsSource 接口 + 插件式数据源适配器（newsnow/RSSHub）+ 聚合去重层 + 格式化推送层，集成到现有 scheduler 系统。

**Tech Stack:** Bun + TypeScript + 现有 scheduler.ts + 飞书/钉钉 SDK

---

## Task 1: 创建核心类型定义

**Files:**
- Create: `/Users/user/work/cursor/cursor-remote-control/shared/news-sources/types.ts`

**Step 1: 创建类型文件**

```typescript
// shared/news-sources/types.ts

/** 新闻源统一接口 */
export interface NewsSource {
  id: string;
  name: string;
  enabled: boolean;
  fetch(options: FetchOptions): Promise<NewsItem[]>;
}

/** 抓取选项 */
export interface FetchOptions {
  topN: number;
  platforms?: string[];
}

/** 标准新闻条目 */
export interface NewsItem {
  platform: string;
  title: string;
  url: string;
  rank?: number;
  hotValue?: string;
  description?: string;
  timestamp?: number;
}

/** 数据源配置 */
export interface SourceConfig {
  id: string;
  name: string;
  enabled: boolean;
  type: string;
  config: Record<string, any>;
}

/** 完整配置文件结构 */
export interface NewsSourcesConfig {
  version: number;
  defaultTopN: number;
  sources: SourceConfig[];
  aggregation: {
    deduplicateByUrl: boolean;
    deduplicateByTitle: boolean;
    titleSimilarityThreshold: number;
    sortBy: 'rank' | 'hotValue' | 'time';
  };
  formatting: {
    maxItemsPerPlatform: number;
    includeRank: boolean;
    includeHotValue: boolean;
    includeDescription: boolean;
    descriptionMaxLength: number;
    includeUrl: boolean;
  };
}
```

**Step 2: 提交**

```bash
git add shared/news-sources/types.ts
git commit -m "feat(news): add core type definitions"
```

---

## Task 2: 实现 newsnow 数据源适配器

**Files:**
- Create: `/Users/user/work/cursor/cursor-remote-control/shared/news-sources/newsnow.ts`
- Test: `/Users/user/work/cursor/cursor-remote-control/shared/news-sources/__tests__/newsnow.test.ts`

**Step 1: 编写失败测试**

```typescript
// shared/news-sources/__tests__/newsnow.test.ts
import { describe, test, expect } from 'bun:test';
import { NewsnowSource } from '../newsnow';

describe('NewsnowSource', () => {
  test('fetch 应返回新闻列表', async () => {
    const source = new NewsnowSource({
      id: 'newsnow',
      name: 'NewsNow',
      enabled: true,
      type: 'newsnow',
      config: {
        baseUrl: 'https://api.newsnow.cn',
        platforms: ['weibo', 'zhihu'],
        timeout: 10000
      }
    });
    
    const items = await source.fetch({ topN: 5 });
    
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]).toHaveProperty('platform');
    expect(items[0]).toHaveProperty('title');
    expect(items[0]).toHaveProperty('url');
  });
  
  test('超时应抛出错误', async () => {
    const source = new NewsnowSource({
      id: 'newsnow',
      name: 'NewsNow',
      enabled: true,
      type: 'newsnow',
      config: {
        baseUrl: 'https://httpstat.us/504?sleep=15000',
        platforms: ['weibo'],
        timeout: 1000
      }
    });
    
    await expect(source.fetch({ topN: 5 })).rejects.toThrow();
  });
});
```

**Step 2: 运行测试确认失败**

```bash
bun test shared/news-sources/__tests__/newsnow.test.ts
```

Expected: FAIL with "Cannot find module '../newsnow'"

**Step 3: 实现最小可用版本**

```typescript
// shared/news-sources/newsnow.ts
import type { NewsSource, NewsItem, FetchOptions, SourceConfig } from './types';

export class NewsnowSource implements NewsSource {
  id: string;
  name: string;
  enabled: boolean;
  private baseUrl: string;
  private platforms: string[];
  private timeout: number;

  constructor(config: SourceConfig) {
    this.id = config.id;
    this.name = config.name;
    this.enabled = config.enabled;
    this.baseUrl = config.config.baseUrl || 'https://api.newsnow.cn';
    this.platforms = config.config.platforms || [];
    this.timeout = config.config.timeout || 10000;
  }

  async fetch(options: FetchOptions): Promise<NewsItem[]> {
    const targetPlatforms = options.platforms || this.platforms;
    const results: NewsItem[] = [];

    for (const platform of targetPlatforms) {
      try {
        const items = await this.fetchPlatform(platform, options.topN);
        results.push(...items);
      } catch (err) {
        console.error(`[newsnow] ${platform} 失败:`, err);
      }
    }

    return results;
  }

  private async fetchPlatform(platform: string, topN: number): Promise<NewsItem[]> {
    const url = `${this.baseUrl}/api/s?id=${platform}`;
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json() as any;
      
      // 解析 newsnow 返回格式（需根据实际 API 调整）
      const items = (data.data || []).slice(0, topN).map((item: any, idx: number) => ({
        platform: this.getPlatformName(platform),
        title: item.title || '',
        url: item.url || '',
        rank: idx + 1,
        hotValue: item.extra?.value || '',
        description: item.desc || '',
        timestamp: Date.now()
      }));

      return items;
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') throw new Error('请求超时');
      throw err;
    }
  }

  private getPlatformName(id: string): string {
    const map: Record<string, string> = {
      weibo: '微博',
      zhihu: '知乎',
      baidu: '百度',
      douyin: '抖音',
      toutiao: '今日头条'
    };
    return map[id] || id;
  }
}
```

**Step 4: 运行测试确认通过**

```bash
bun test shared/news-sources/__tests__/newsnow.test.ts
```

Expected: PASS

**Step 5: 提交**

```bash
git add shared/news-sources/newsnow.ts shared/news-sources/__tests__/newsnow.test.ts
git commit -m "feat(news): implement newsnow data source adapter"
```

---

## Task 3: 实现 RSSHub 数据源适配器

**Files:**
- Create: `/Users/user/work/cursor/cursor-remote-control/shared/news-sources/rsshub.ts`
- Test: `/Users/user/work/cursor/cursor-remote-control/shared/news-sources/__tests__/rsshub.test.ts`

**Step 1: 编写失败测试**

```typescript
// shared/news-sources/__tests__/rsshub.test.ts
import { describe, test, expect } from 'bun:test';
import { RSSHubSource } from '../rsshub';

describe('RSSHubSource', () => {
  test('fetch 应返回新闻列表', async () => {
    const source = new RSSHubSource({
      id: 'rsshub',
      name: 'RSSHub',
      enabled: true,
      type: 'rsshub',
      config: {
        baseUrl: 'https://rsshub.app',
        feeds: ['weibo/search/hot'],
        timeout: 15000
      }
    });
    
    const items = await source.fetch({ topN: 5 });
    
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]).toHaveProperty('title');
    expect(items[0]).toHaveProperty('url');
  });
});
```

**Step 2: 运行测试确认失败**

```bash
bun test shared/news-sources/__tests__/rsshub.test.ts
```

Expected: FAIL

**Step 3: 实现最小可用版本**

```typescript
// shared/news-sources/rsshub.ts
import type { NewsSource, NewsItem, FetchOptions, SourceConfig } from './types';

export class RSSHubSource implements NewsSource {
  id: string;
  name: string;
  enabled: boolean;
  private baseUrl: string;
  private feeds: string[];
  private timeout: number;

  constructor(config: SourceConfig) {
    this.id = config.id;
    this.name = config.name;
    this.enabled = config.enabled;
    this.baseUrl = config.config.baseUrl || 'https://rsshub.app';
    this.feeds = config.config.feeds || [];
    this.timeout = config.config.timeout || 15000;
  }

  async fetch(options: FetchOptions): Promise<NewsItem[]> {
    const results: NewsItem[] = [];

    for (const feed of this.feeds) {
      try {
        const items = await this.fetchFeed(feed, options.topN);
        results.push(...items);
      } catch (err) {
        console.error(`[rsshub] ${feed} 失败:`, err);
      }
    }

    return results.slice(0, options.topN);
  }

  private async fetchFeed(feed: string, topN: number): Promise<NewsItem[]> {
    const url = `${this.baseUrl}/${feed}`;
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const xml = await res.text();
      const items = this.parseRSS(xml, feed);

      return items.slice(0, topN);
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') throw new Error('请求超时');
      throw err;
    }
  }

  private parseRSS(xml: string, feed: string): NewsItem[] {
    // 简单 RSS 解析（生产环境建议用库如 fast-xml-parser）
    const items: NewsItem[] = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    const titleRegex = /<title><!\[CDATA\[(.*?)\]\]><\/title>/;
    const linkRegex = /<link>(.*?)<\/link>/;
    const descRegex = /<description><!\[CDATA\[(.*?)\]\]><\/description>/;

    let match;
    let rank = 1;
    while ((match = itemRegex.exec(xml)) !== null) {
      const itemXml = match[1];
      const titleMatch = titleRegex.exec(itemXml);
      const linkMatch = linkRegex.exec(itemXml);
      const descMatch = descRegex.exec(itemXml);

      if (titleMatch && linkMatch) {
        items.push({
          platform: this.getPlatformName(feed),
          title: titleMatch[1],
          url: linkMatch[1],
          rank: rank++,
          description: descMatch ? descMatch[1].replace(/<[^>]*>/g, '').slice(0, 100) : '',
          timestamp: Date.now()
        });
      }
    }

    return items;
  }

  private getPlatformName(feed: string): string {
    if (feed.includes('weibo')) return '微博';
    if (feed.includes('zhihu')) return '知乎';
    if (feed.includes('baidu')) return '百度';
    return 'RSS';
  }
}
```

**Step 4: 运行测试确认通过**

```bash
bun test shared/news-sources/__tests__/rsshub.test.ts
```

Expected: PASS

**Step 5: 提交**

```bash
git add shared/news-sources/rsshub.ts shared/news-sources/__tests__/rsshub.test.ts
git commit -m "feat(news): implement RSSHub data source adapter"
```

---

## Task 4: 实现聚合去重逻辑

**Files:**
- Create: `/Users/user/work/cursor/cursor-remote-control/shared/news-sources/aggregator.ts`
- Test: `/Users/user/work/cursor/cursor-remote-control/shared/news-sources/__tests__/aggregator.test.ts`

**Step 1: 编写失败测试**

```typescript
// shared/news-sources/__tests__/aggregator.test.ts
import { describe, test, expect } from 'bun:test';
import { deduplicateByUrl, deduplicateByTitle, sortItems } from '../aggregator';
import type { NewsItem } from '../types';

describe('aggregator', () => {
  test('按 URL 去重', () => {
    const items: NewsItem[] = [
      { platform: 'weibo', title: 'A', url: 'http://a.com' },
      { platform: 'zhihu', title: 'B', url: 'http://a.com' },
      { platform: 'baidu', title: 'C', url: 'http://b.com' },
    ];
    
    const result = deduplicateByUrl(items);
    expect(result).toHaveLength(2);
    expect(result[0].url).toBe('http://a.com');
    expect(result[1].url).toBe('http://b.com');
  });
  
  test('按标题相似度去重', () => {
    const items: NewsItem[] = [
      { platform: 'weibo', title: 'ChatGPT-5 正式发布', url: 'http://a.com' },
      { platform: 'zhihu', title: 'ChatGPT5 正式发布了', url: 'http://b.com' },
      { platform: 'baidu', title: '比亚迪销量破纪录', url: 'http://c.com' },
    ];
    
    const result = deduplicateByTitle(items, 0.85);
    expect(result).toHaveLength(2);
  });
  
  test('按排名排序', () => {
    const items: NewsItem[] = [
      { platform: 'weibo', title: 'A', url: 'http://a.com', rank: 3 },
      { platform: 'zhihu', title: 'B', url: 'http://b.com', rank: 1 },
      { platform: 'baidu', title: 'C', url: 'http://c.com', rank: 2 },
    ];
    
    const result = sortItems(items, 'rank');
    expect(result[0].rank).toBe(1);
    expect(result[1].rank).toBe(2);
    expect(result[2].rank).toBe(3);
  });
});
```

**Step 2: 运行测试确认失败**

```bash
bun test shared/news-sources/__tests__/aggregator.test.ts
```

Expected: FAIL

**Step 3: 实现去重排序逻辑**

```typescript
// shared/news-sources/aggregator.ts
import type { NewsItem } from './types';

/** 按 URL 去重（保留第一个） */
export function deduplicateByUrl(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  return items.filter(item => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

/** 按标题相似度去重 */
export function deduplicateByTitle(
  items: NewsItem[], 
  threshold = 0.85
): NewsItem[] {
  const result: NewsItem[] = [];
  
  for (const item of items) {
    const isDuplicate = result.some(existing => 
      calculateSimilarity(item.title, existing.title) >= threshold
    );
    if (!isDuplicate) {
      result.push(item);
    }
  }
  
  return result;
}

/** 计算字符串相似度（Levenshtein 距离） */
function calculateSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  
  // 简化版：移除空格和标点后比较
  const normalize = (s: string) => s.replace(/[\s\-]/g, '').toLowerCase();
  const na = normalize(a);
  const nb = normalize(b);
  
  if (na === nb) return 1;
  
  // Levenshtein 距离
  const matrix: number[][] = [];
  for (let i = 0; i <= nb.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= na.length; j++) {
    matrix[0][j] = j;
  }
  
  for (let i = 1; i <= nb.length; i++) {
    for (let j = 1; j <= na.length; j++) {
      const cost = nb[i - 1] === na[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  
  const distance = matrix[nb.length][na.length];
  const maxLen = Math.max(na.length, nb.length);
  return 1 - distance / maxLen;
}

/** 排序 */
export function sortItems(
  items: NewsItem[], 
  by: 'rank' | 'hotValue' | 'time'
): NewsItem[] {
  return [...items].sort((a, b) => {
    switch (by) {
      case 'rank':
        return (a.rank || Infinity) - (b.rank || Infinity);
      case 'time':
        return (b.timestamp || 0) - (a.timestamp || 0);
      case 'hotValue':
        // 简单数字比较（实际需要解析热度值）
        return parseHotValue(b.hotValue) - parseHotValue(a.hotValue);
      default:
        return 0;
    }
  });
}

function parseHotValue(value?: string): number {
  if (!value) return 0;
  const num = parseFloat(value.replace(/[^\d.]/g, ''));
  if (value.includes('万')) return num * 10000;
  if (value.includes('k')) return num * 1000;
  return num;
}

/** 完整聚合流程 */
export function aggregateNews(
  itemsList: NewsItem[][],
  config: {
    deduplicateByUrl: boolean;
    deduplicateByTitle: boolean;
    titleSimilarityThreshold: number;
    sortBy: 'rank' | 'hotValue' | 'time';
  }
): NewsItem[] {
  let items = itemsList.flat();
  
  if (config.deduplicateByUrl) {
    items = deduplicateByUrl(items);
  }
  
  if (config.deduplicateByTitle) {
    items = deduplicateByTitle(items, config.titleSimilarityThreshold);
  }
  
  return sortItems(items, config.sortBy);
}
```

**Step 4: 运行测试确认通过**

```bash
bun test shared/news-sources/__tests__/aggregator.test.ts
```

Expected: PASS

**Step 5: 提交**

```bash
git add shared/news-sources/aggregator.ts shared/news-sources/__tests__/aggregator.test.ts
git commit -m "feat(news): implement aggregation and deduplication logic"
```

---

## Task 5: 实现消息格式化器

**Files:**
- Create: `/Users/user/work/cursor/cursor-remote-control/shared/news-sources/formatter.ts`
- Test: `/Users/user/work/cursor/cursor-remote-control/shared/news-sources/__tests__/formatter.test.ts`

**Step 1: 编写失败测试**

```typescript
// shared/news-sources/__tests__/formatter.test.ts
import { describe, test, expect } from 'bun:test';
import { formatNewsCard, groupByPlatform } from '../formatter';
import type { NewsItem } from '../types';

describe('formatter', () => {
  test('按平台分组', () => {
    const items: NewsItem[] = [
      { platform: '微博', title: 'A', url: 'http://a.com' },
      { platform: '知乎', title: 'B', url: 'http://b.com' },
      { platform: '微博', title: 'C', url: 'http://c.com' },
    ];
    
    const grouped = groupByPlatform(items);
    expect(grouped['微博']).toHaveLength(2);
    expect(grouped['知乎']).toHaveLength(1);
  });
  
  test('格式化为飞书卡片', () => {
    const items: NewsItem[] = [
      { 
        platform: '微博', 
        title: 'ChatGPT-5 正式发布', 
        url: 'http://a.com',
        rank: 1,
        hotValue: '123万',
        description: '这是摘要'
      }
    ];
    
    const chunks = formatNewsCard(items, 'feishu', {
      includeRank: true,
      includeHotValue: true,
      includeDescription: true,
      descriptionMaxLength: 80,
      includeUrl: true,
      maxItemsPerPlatform: 10
    });
    
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('微博');
    expect(chunks[0]).toContain('ChatGPT-5 正式发布');
    expect(chunks[0]).toContain('123万');
  });
});
```

**Step 2: 运行测试确认失败**

```bash
bun test shared/news-sources/__tests__/formatter.test.ts
```

Expected: FAIL

**Step 3: 实现格式化逻辑**

```typescript
// shared/news-sources/formatter.ts
import type { NewsItem } from './types';

export interface FormattingConfig {
  maxItemsPerPlatform: number;
  includeRank: boolean;
  includeHotValue: boolean;
  includeDescription: boolean;
  descriptionMaxLength: number;
  includeUrl: boolean;
}

/** 按平台分组 */
export function groupByPlatform(items: NewsItem[]): Record<string, NewsItem[]> {
  const grouped: Record<string, NewsItem[]> = {};
  for (const item of items) {
    if (!grouped[item.platform]) {
      grouped[item.platform] = [];
    }
    grouped[item.platform].push(item);
  }
  return grouped;
}

/** 格式化为飞书/钉钉卡片 */
export function formatNewsCard(
  items: NewsItem[],
  platform: 'feishu' | 'dingtalk',
  config: FormattingConfig
): string[] {
  const grouped = groupByPlatform(items);
  const maxSize = platform === 'feishu' ? 30000 : 20000;
  
  const header = `📰 **今日热点新闻** (共 ${items.length} 条)\n\n`;
  const footer = `\n⏱ 更新时间：${new Date().toLocaleString('zh-CN')}\n📊 数据来源：NewsNow API + RSSHub`;
  
  const chunks: string[] = [];
  let currentChunk = header;
  
  for (const [platformName, news] of Object.entries(grouped)) {
    const section = formatSection(
      platformName, 
      news.slice(0, config.maxItemsPerPlatform), 
      config
    );
    
    // 检查是否超限
    if (currentChunk.length + section.length + footer.length > maxSize) {
      chunks.push(currentChunk + footer);
      currentChunk = header;
    }
    
    currentChunk += section;
  }
  
  chunks.push(currentChunk + footer);
  
  // 添加分批标记
  return chunks.map((c, i) => 
    chunks.length > 1 ? `[第 ${i+1}/${chunks.length} 批]\n\n${c}` : c
  );
}

function formatSection(
  platform: string, 
  items: NewsItem[], 
  config: FormattingConfig
): string {
  const divider = '━'.repeat(15);
  let section = `${divider} ${platform} ${divider}\n`;
  
  for (const item of items) {
    section += formatItem(item, config) + '\n\n';
  }
  
  return section;
}

function formatItem(item: NewsItem, config: FormattingConfig): string {
  const emoji = getRankEmoji(item.rank);
  let result = `${emoji} **${item.title}**`;
  
  if (config.includeHotValue && item.hotValue) {
    result += ` 🔥 ${item.hotValue}`;
  }
  
  if (config.includeDescription && item.description) {
    const desc = truncate(item.description, config.descriptionMaxLength);
    result += `\n   ${desc}`;
  }
  
  if (config.includeUrl) {
    result += `\n   [查看详情](${item.url})`;
  }
  
  return result;
}

function getRankEmoji(rank?: number): string {
  if (!rank) return '•';
  if (rank <= 9) return `${rank}️⃣`;
  return '🔟';
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}
```

**Step 4: 运行测试确认通过**

```bash
bun test shared/news-sources/__tests__/formatter.test.ts
```

Expected: PASS

**Step 5: 提交**

```bash
git add shared/news-sources/formatter.ts shared/news-sources/__tests__/formatter.test.ts
git commit -m "feat(news): implement message formatter for Feishu/DingTalk"
```

---

## Task 6: 实现配置加载器

**Files:**
- Create: `/Users/user/work/cursor/cursor-remote-control/shared/news-sources/config-loader.ts`
- Create: `/Users/user/work/cursor/cursor-remote-control/config/news-sources.json`

**Step 1: 创建默认配置文件**

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

**Step 2: 实现配置加载器**

```typescript
// shared/news-sources/config-loader.ts
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NewsSourcesConfig } from './types';

const DEFAULT_CONFIG_PATH = resolve(process.cwd(), 'config/news-sources.json');

/** 加载配置（支持环境变量覆盖） */
export function loadConfig(): NewsSourcesConfig {
  const configPath = process.env.NEWS_SOURCES_CONFIG || DEFAULT_CONFIG_PATH;
  
  if (!existsSync(configPath)) {
    throw new Error(`配置文件不存在: ${configPath}`);
  }
  
  const raw = readFileSync(configPath, 'utf-8');
  const config = JSON.parse(raw) as NewsSourcesConfig;
  
  // 环境变量覆盖
  if (process.env.NEWS_DEFAULT_TOP_N) {
    config.defaultTopN = parseInt(process.env.NEWS_DEFAULT_TOP_N, 10);
  }
  
  if (process.env.NEWS_RSSHUB_BASE_URL) {
    const rsshub = config.sources.find(s => s.type === 'rsshub');
    if (rsshub) {
      rsshub.config.baseUrl = process.env.NEWS_RSSHUB_BASE_URL;
    }
  }
  
  return config;
}

/** 获取已启用的源 */
export function getEnabledSources(config: NewsSourcesConfig) {
  return config.sources.filter(s => s.enabled);
}
```

**Step 3: 提交**

```bash
git add config/news-sources.json shared/news-sources/config-loader.ts
git commit -m "feat(news): add configuration loader with env override support"
```

---

## Task 7: 实现统一入口（news-fetcher）

**Files:**
- Create: `/Users/user/work/cursor/cursor-remote-control/shared/news-fetcher.ts`
- Test: `/Users/user/work/cursor/cursor-remote-control/shared/__tests__/news-fetcher.test.ts`

**Step 1: 编写集成测试**

```typescript
// shared/__tests__/news-fetcher.test.ts
import { describe, test, expect } from 'bun:test';
import { fetchNews } from '../news-fetcher';

describe('news-fetcher', () => {
  test('完整流程测试', async () => {
    const items = await fetchNews({ topN: 5 });
    
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]).toHaveProperty('platform');
    expect(items[0]).toHaveProperty('title');
    expect(items[0]).toHaveProperty('url');
  });
  
  test('部分源失败不影响其他源', async () => {
    // 此测试需要 mock，暂时跳过
    // 或者手动禁用某个源测试
  });
});
```

**Step 2: 实现统一入口**

```typescript
// shared/news-fetcher.ts
import type { NewsItem, FetchOptions } from './news-sources/types';
import { loadConfig, getEnabledSources } from './news-sources/config-loader';
import { NewsnowSource } from './news-sources/newsnow';
import { RSSHubSource } from './news-sources/rsshub';
import { aggregateNews } from './news-sources/aggregator';

/** 工厂函数：根据配置创建数据源实例 */
function createSource(config: any) {
  switch (config.type) {
    case 'newsnow':
      return new NewsnowSource(config);
    case 'rsshub':
      return new RSSHubSource(config);
    default:
      throw new Error(`未知数据源类型: ${config.type}`);
  }
}

/** 统一抓取入口 */
export async function fetchNews(options?: Partial<FetchOptions>): Promise<NewsItem[]> {
  const config = loadConfig();
  const topN = options?.topN || config.defaultTopN;
  
  const sources = getEnabledSources(config).map(createSource);
  
  if (sources.length === 0) {
    throw new Error('没有启用的数据源');
  }
  
  // 并行调用所有源
  const results = await Promise.allSettled(
    sources.map(s => s.fetch({ topN, platforms: options?.platforms }))
  );
  
  const itemsList: NewsItem[][] = [];
  const errors: string[] = [];
  
  for (const [idx, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      itemsList.push(result.value);
    } else {
      errors.push(`${sources[idx].name}: ${result.reason}`);
      console.error(`[新闻源失败] ${sources[idx].name}:`, result.reason);
    }
  }
  
  // 至少有一个源成功
  if (itemsList.length === 0) {
    throw new Error(`所有数据源失败：\n${errors.join('\n')}`);
  }
  
  // 聚合去重
  return aggregateNews(itemsList, config.aggregation);
}
```

**Step 3: 运行测试**

```bash
bun test shared/__tests__/news-fetcher.test.ts
```

Expected: PASS（如果网络可达）

**Step 4: 提交**

```bash
git add shared/news-fetcher.ts shared/__tests__/news-fetcher.test.ts
git commit -m "feat(news): implement unified news fetcher entry point"
```

---

## Task 8: 集成到 scheduler（飞书）

**Files:**
- Modify: `/Users/user/work/cursor/cursor-remote-control/feishu/server.ts:248-279`

**Step 1: 导入依赖**

在 `feishu/server.ts` 顶部添加：

```typescript
import { fetchNews } from "../shared/news-fetcher.js";
import { formatNewsCard } from "../shared/news-sources/formatter.js";
import { loadConfig } from "../shared/news-sources/config-loader.js";
```

**Step 2: 修改 onExecute 逻辑**

找到 `scheduler` 的 `onExecute` 函数（约 248 行），修改为：

```typescript
onExecute: async (job: CronJob) => {
  // 检查是否是新闻推送任务
  if (job.message === "fetch-news" || job.message.startsWith('{"type":"fetch-news"')) {
    try {
      console.log(`[定时] 开始抓取热点新闻`);
      
      // 解析任务参数
      let params = { topN: 10 };
      if (job.message.startsWith('{')) {
        const parsed = JSON.parse(job.message);
        params.topN = parsed.topN || 10;
      }
      
      // 抓取新闻
      const items = await fetchNews({ topN: params.topN });
      console.log(`[定时] 成功抓取 ${items.length} 条新闻`);
      
      // 格式化为飞书卡片
      const config = loadConfig();
      const chunks = formatNewsCard(items, 'feishu', config.formatting);
      
      // 如果分批，只返回第一批（onDelivery 会处理多批）
      return { status: "ok" as const, result: chunks.join('\n---\n') };
    } catch (err) {
      console.error(`[定时] 新闻抓取失败:`, err);
      const fallback = `⚠️ 热点抓取失败\n\n${err.message}\n\n稍后会自动重试`;
      return { status: "error" as const, error: err.message, result: fallback };
    }
  }
  
  // 原有逻辑：普通提醒任务
  console.log(`[定时] 触发任务: ${job.name}`);
  return { status: "ok" as const, result: job.message };
}
```

**Step 3: 修改简单定时任务识别**

找到简单定时任务检测逻辑（约 2809 行），添加新闻推送识别：

```typescript
// 检测简单定时任务请求（原有逻辑）
const simpleScheduleMatch = text.match(/([0-9]+|一|二|三|四|五|六|七|八|九|十)(分钟|小时|天)后.*(提醒|通知|告诉)/i);

// 新增：检测新闻推送请求
const newsScheduleMatch = text.match(/(每天|每周|定时).*(推送|发送).*(热点|新闻|热榜)/i);

if (newsScheduleMatch) {
  // 解析时间表达式（简化版，只支持"每天X点"）
  const timeMatch = text.match(/每天.*?([0-9]{1,2})[点时]/);
  const hour = timeMatch ? parseInt(timeMatch[1], 10) : 9;
  
  // 创建 cron 任务
  const task = await scheduler.add({
    name: "热点新闻推送",
    enabled: true,
    deleteAfterRun: false,
    schedule: { kind: 'cron', expr: `0 ${hour - 8} * * *` },  // UTC 时间
    message: "fetch-news",
    platform: 'feishu',
    webhook: chatId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: {}
  });
  
  await replyCard(
    messageId, 
    `✅ 已创建定时任务\n\n⏰ 执行时间：每天 ${hour}:00\n📰 推送内容：今日热点新闻\n📱 推送平台：飞书\n\n发送 \`/任务\` 可查看所有任务`,
    { title: '⏰ 定时任务已创建', color: 'green' }
  );
  return;
}

if (simpleScheduleMatch) {
  // 原有逻辑...
}
```

**Step 4: 测试**

启动服务并在飞书测试：

```bash
bun run feishu/server.ts
```

在飞书发送："每天 9 点推送热点"

Expected: 收到任务创建确认卡片

**Step 5: 提交**

```bash
git add feishu/server.ts
git commit -m "feat(news): integrate news push into Feishu scheduler"
```

---

## Task 9: 集成到 scheduler（钉钉）

**Files:**
- Modify: `/Users/user/work/cursor/cursor-remote-control/dingtalk/server.ts:2127-2157`

**Step 1: 导入依赖**

在 `dingtalk/server.ts` 顶部添加：

```typescript
import { fetchNews } from '../shared/news-fetcher.js';
import { formatNewsCard } from '../shared/news-sources/formatter.js';
import { loadConfig } from '../shared/news-sources/config-loader.js';
```

**Step 2: 修改 onExecute 逻辑**

找到钉钉 scheduler 的 `onExecute`（约 2127 行），添加类似飞书的逻辑：

```typescript
onExecute: async (job: CronJob) => {
  if (job.message === "fetch-news" || job.message.startsWith('{"type":"fetch-news"')) {
    try {
      console.log(`[定时] 开始抓取热点新闻`);
      
      let params = { topN: 10 };
      if (job.message.startsWith('{')) {
        const parsed = JSON.parse(job.message);
        params.topN = parsed.topN || 10;
      }
      
      const items = await fetchNews({ topN: params.topN });
      console.log(`[定时] 成功抓取 ${items.length} 条新闻`);
      
      const config = loadConfig();
      const chunks = formatNewsCard(items, 'dingtalk', config.formatting);
      
      return { status: "ok" as const, result: chunks.join('\n---\n') };
    } catch (err) {
      console.error(`[定时] 新闻抓取失败:`, err);
      const fallback = `⚠️ 热点抓取失败\n\n${err.message}\n\n稍后会自动重试`;
      return { status: "error" as const, error: err.message, result: fallback };
    }
  }
  
  console.log(`[定时] 触发任务: ${job.name}`);
  return { status: "ok" as const, result: job.message };
}
```

**Step 3: 修改简单定时任务识别**

找到钉钉的定时任务检测（约 1269 行），添加新闻推送识别：

```typescript
const newsScheduleMatch = message.match(/(每天|每周|定时).*(推送|发送).*(热点|新闻|热榜)/i);

if (newsScheduleMatch) {
  const timeMatch = message.match(/每天.*?([0-9]{1,2})[点时]/);
  const hour = timeMatch ? parseInt(timeMatch[1], 10) : 9;
  
  const task = await scheduler.add({
    name: "热点新闻推送",
    enabled: true,
    deleteAfterRun: false,
    schedule: { kind: 'cron', expr: `0 ${hour - 8} * * *` },
    message: "fetch-news",
    platform: 'dingtalk',
    webhook: sessionWebhook,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: {}
  });
  
  await sendMarkdown(
    sessionWebhook,
    `✅ 已创建定时任务\n\n⏰ 执行时间：每天 ${hour}:00\n📰 推送内容：今日热点新闻\n📱 推送平台：钉钉\n\n发送 \`/任务\` 可查看所有任务`,
    '⏰ 定时任务已创建'
  );
  return;
}
```

**Step 4: 提交**

```bash
git add dingtalk/server.ts
git commit -m "feat(news): integrate news push into DingTalk scheduler"
```

---

## Task 10: 添加监控和健康检查

**Files:**
- Create: `/Users/user/work/cursor/cursor-remote-control/shared/news-sources/monitoring.ts`
- Modify: `/Users/user/work/cursor/cursor-remote-control/feishu/server.ts` (添加 `/新闻状态` 命令)

**Step 1: 实现监控模块**

```typescript
// shared/news-sources/monitoring.ts
export interface FetchMetrics {
  source: string;
  success: boolean;
  duration: number;
  itemCount: number;
  error?: string;
  timestamp: number;
}

const metrics: FetchMetrics[] = [];
const MAX_METRICS = 100;

export function recordMetrics(m: FetchMetrics) {
  metrics.push({ ...m, timestamp: Date.now() });
  if (metrics.length > MAX_METRICS) {
    metrics.shift();
  }
  
  // 错误率告警
  const recent = metrics.slice(-10);
  const errorRate = recent.filter(x => !x.success).length / recent.length;
  if (errorRate > 0.5) {
    console.warn(`[告警] ${m.source} 错误率 ${(errorRate * 100).toFixed(1)}%`);
  }
}

export function getHealthStatus(): string {
  if (metrics.length === 0) {
    return '暂无数据';
  }
  
  const bySource: Record<string, FetchMetrics[]> = {};
  for (const m of metrics.slice(-20)) {
    if (!bySource[m.source]) bySource[m.source] = [];
    bySource[m.source].push(m);
  }
  
  const lines = Object.entries(bySource).map(([name, items]) => {
    const success = items.filter(x => x.success).length;
    const total = items.length;
    const avgDuration = items.reduce((s, x) => s + x.duration, 0) / total;
    const lastError = items.filter(x => !x.success).pop();
    
    let status = `✅ ${name}: ${success}/${total} 成功，平均 ${avgDuration.toFixed(0)}ms`;
    if (lastError) {
      status += `\n   ⚠️ 最近错误: ${lastError.error}`;
    }
    return status;
  });
  
  return lines.join('\n\n');
}

export function getMetrics() {
  return [...metrics];
}
```

**Step 2: 在 news-fetcher 中记录指标**

修改 `shared/news-fetcher.ts`，在每个源抓取后记录：

```typescript
import { recordMetrics } from './news-sources/monitoring';

// 在 fetchNews 函数的 Promise.allSettled 后添加：
for (const [idx, result] of results.entries()) {
  const start = Date.now();
  if (result.status === 'fulfilled') {
    recordMetrics({
      source: sources[idx].name,
      success: true,
      duration: Date.now() - start,
      itemCount: result.value.length
    });
    itemsList.push(result.value);
  } else {
    recordMetrics({
      source: sources[idx].name,
      success: false,
      duration: Date.now() - start,
      itemCount: 0,
      error: String(result.reason)
    });
    errors.push(`${sources[idx].name}: ${result.reason}`);
  }
}
```

**Step 3: 添加 `/新闻状态` 命令（飞书）**

在 `feishu/server.ts` 的命令处理部分添加：

```typescript
import { getHealthStatus } from "../shared/news-sources/monitoring.js";

// 在 /任务 命令后添加
const newsStatusMatch = text.match(/^\/(新闻状态|news|health)/i);
if (newsStatusMatch) {
  const status = getHealthStatus();
  await replyCard(messageId, status, { title: "📊 新闻源健康状态", color: "blue" });
  return;
}
```

**Step 4: 提交**

```bash
git add shared/news-sources/monitoring.ts shared/news-fetcher.ts feishu/server.ts
git commit -m "feat(news): add monitoring and health check command"
```

---

## Task 11: 编写集成测试和文档

**Files:**
- Create: `/Users/user/work/cursor/cursor-remote-control/shared/__tests__/integration.test.ts`
- Create: `/Users/user/work/cursor/cursor-remote-control/docs/news-push-usage.md`

**Step 1: 编写集成测试**

```typescript
// shared/__tests__/integration.test.ts
import { describe, test, expect } from 'bun:test';
import { fetchNews } from '../news-fetcher';
import { formatNewsCard } from '../news-sources/formatter';
import { loadConfig } from '../news-sources/config-loader';

describe('完整流程集成测试', () => {
  test('从抓取到格式化', async () => {
    const items = await fetchNews({ topN: 5 });
    expect(items.length).toBeGreaterThan(0);
    
    const config = loadConfig();
    const chunks = formatNewsCard(items, 'feishu', config.formatting);
    
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]).toContain('今日热点新闻');
  });
});
```

**Step 2: 编写使用文档**

```markdown
# 热点新闻推送功能使用文档

## 快速开始

### 1. 创建定时任务

在飞书/钉钉对话中发送：

- "每天 9 点推送热点"
- "每天早上推送今日新闻"
- "18:00 推送热榜"

系统会自动创建定时任务，到点自动推送。

### 2. 管理任务

| 命令 | 说明 |
|------|------|
| `/任务` 或 `/cron` | 查看所有定时任务 |
| `/任务 停用 abc123` | 停用指定任务 |
| `/任务 启用 abc123` | 启用指定任务 |
| `/任务 删除 abc123` | 删除指定任务 |
| `/任务 执行 abc123` | 立即执行一次 |
| `/新闻状态` | 查看数据源健康度 |

### 3. 配置数据源

编辑 `config/news-sources.json`：

```json
{
  "sources": [
    {
      "id": "newsnow",
      "enabled": true,
      "config": {
        "platforms": ["weibo", "zhihu", "baidu"]
      }
    },
    {
      "id": "rsshub",
      "enabled": false
    }
  ]
}
```

### 4. 环境变量覆盖

```bash
# .env
NEWS_DEFAULT_TOP_N=15
NEWS_RSSHUB_BASE_URL=https://my-rsshub.com
```

## 常见问题

**Q: 如何修改推送时间？**
A: 发送 `/任务` 查看任务 ID，然后重新创建新任务，删除旧任务。

**Q: 数据源失败怎么办？**
A: 系统会自动重试，如果连续 5 次失败会自动禁用任务。发送 `/新闻状态` 查看健康度。

**Q: 如何添加更多数据源？**
A: 在 `config/news-sources.json` 中启用 RSSHub 或开发新的适配器。

## 技术细节

详见 [设计文档](./2026-03-16-news-push-feature-design.md)
```

**Step 3: 运行所有测试**

```bash
bun test shared/__tests__/
```

Expected: 所有测试通过

**Step 4: 提交**

```bash
git add shared/__tests__/integration.test.ts docs/news-push-usage.md
git commit -m "docs: add integration tests and usage documentation"
```

---

## Task 12: 最终验证和部署准备

**Step 1: 运行完整测试套件**

```bash
# 运行所有单元测试
bun test

# 手动测试飞书推送
# 1. 启动服务：bun run feishu/server.ts
# 2. 在飞书发送：每天 9 点推送热点
# 3. 发送：/任务 执行 <task-id>
# 4. 验证收到热点推送
```

**Step 2: 验证清单**

- [ ] newsnow API 可正常访问
- [ ] RSSHub 可正常访问（如果启用）
- [ ] 飞书推送正常
- [ ] 钉钉推送正常
- [ ] 超长消息正确分批
- [ ] 数据源失败有错误提示
- [ ] `/新闻状态` 命令显示健康度
- [ ] 配置文件语法正确
- [ ] 环境变量覆盖生效

**Step 3: 更新 README**

在 `README.md` 中添加新功能说明：

```markdown
## 新功能：热点新闻定时推送 🆕

### 快速开始

在飞书/钉钉对话中说：

"每天 9 点推送热点"

系统会自动创建定时任务，到点推送多平台热榜。

### 详细文档

- [使用文档](./docs/news-push-usage.md)
- [设计文档](./docs/plans/2026-03-16-news-push-feature-design.md)
```

**Step 4: 最终提交**

```bash
git add README.md
git commit -m "docs: update README with news push feature"
git push origin main
```

---

## 完成标志

✅ 所有测试通过  
✅ 飞书和钉钉都能正常推送  
✅ 配置文件和文档完整  
✅ 代码已提交到主分支

---

## 后续优化方向

1. **关键词过滤**：在 aggregator 层增加过滤逻辑
2. **历史数据**：增加后台定时抓取 + SQLite 存储
3. **单平台直采**：新增 weibo.ts、zhihu.ts 适配器
4. **Web 管理界面**：可视化配置数据源和任务
5. **告警通知**：数据源持续失败时主动推送告警

---

**预计总工时**：6-8 小时（含测试）

**技术栈**：Bun + TypeScript + 现有架构

**风险**：newsnow/RSSHub API 稳定性依赖第三方
