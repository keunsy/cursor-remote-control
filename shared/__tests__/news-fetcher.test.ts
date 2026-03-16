import { describe, test, expect } from 'bun:test';
import { fetchNews } from '../news-fetcher';
import type { NewsSourcesConfig, NewsSource, NewsItem } from '../news-sources/types';

/** 双源启用的测试配置（newsnow + rsshub） */
const dualSourceConfig: NewsSourcesConfig = {
  version: 1,
  defaultTopN: 5,
  sources: [
    {
      id: 'newsnow',
      name: 'NewsNow API',
      enabled: true,
      type: 'newsnow',
      config: {
        baseUrl: 'https://api.newsnow.cn',
        platforms: ['weibo', 'zhihu'],
        timeout: 10000,
      },
    },
    {
      id: 'rsshub',
      name: 'RSSHub',
      enabled: true,
      type: 'rsshub',
      config: {
        baseUrl: 'https://rsshub.app',
        feeds: ['weibo/search/hot'],
        timeout: 15000,
      },
    },
  ],
  aggregation: {
    deduplicateByUrl: true,
    deduplicateByTitle: true,
    titleSimilarityThreshold: 0.85,
    sortBy: 'rank',
  },
  formatting: {
    maxItemsPerPlatform: 10,
    includeRank: true,
    includeHotValue: true,
    includeDescription: true,
    descriptionMaxLength: 80,
    includeUrl: true,
  },
};

/** Mock 成功源：返回静态新闻数据 */
function createMockSource(id: string, name: string, items: NewsItem[]): NewsSource {
  return {
    id,
    name,
    enabled: true,
    fetch: async () => items,
  };
}

/** Mock 失败源：总是 reject */
function createFailingSource(id: string, name: string, error = 'mock error'): NewsSource {
  return {
    id,
    name,
    enabled: true,
    fetch: async () => {
      throw new Error(error);
    },
  };
}

const mockNewsItems: NewsItem[] = [
  {
    platform: '微博',
    title: 'ChatGPT-5 正式发布',
    url: 'https://example.com/1',
    rank: 1,
    hotValue: '123万',
    description: '这是摘要',
    timestamp: Date.now(),
  },
  {
    platform: '知乎',
    title: '比亚迪销量破纪录',
    url: 'https://example.com/2',
    rank: 2,
    hotValue: '50万',
    timestamp: Date.now(),
  },
];

describe('news-fetcher', () => {
  test('fetchNews 返回 { messages, metadata } 结构', async () => {
    const result = await fetchNews({
      topN: 3,
      platform: 'feishu',
      configOverride: dualSourceConfig,
      sources: [createMockSource('mock1', 'Mock1', mockNewsItems)],
    });

    expect(result).toHaveProperty('messages');
    expect(result).toHaveProperty('metadata');
    expect(Array.isArray(result.messages)).toBe(true);
    expect(result.metadata).toHaveProperty('itemCount');
    expect(result.metadata).toHaveProperty('sourceCount');
  });

  test('集成测试：同时 fetch newsnow 和 rsshub（双源聚合）', async () => {
    const newsnowItems: NewsItem[] = [
      { platform: '微博', title: 'A', url: 'https://a.com', rank: 1 },
    ];
    const rsshubItems: NewsItem[] = [
      { platform: '知乎', title: 'B', url: 'https://b.com', rank: 1 },
    ];

    const result = await fetchNews({
      topN: 5,
      platform: 'feishu',
      configOverride: dualSourceConfig,
      sources: [
        createMockSource('newsnow', 'NewsNow', newsnowItems),
        createMockSource('rsshub', 'RSSHub', rsshubItems),
      ],
    });

    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.metadata.itemCount).toBe(2);
    expect(result.metadata.sourceCount).toBe(2);
    expect(result.messages[0]).toContain('今日热点新闻');
  });

  test('Promise.allSettled：部分源失败时其他源仍正常工作', async () => {
    const result = await fetchNews({
      topN: 5,
      platform: 'dingtalk',
      configOverride: dualSourceConfig,
      sources: [
        createFailingSource('fail', 'FailingSource', 'mock network error'),
        createMockSource('ok', 'OKSource', mockNewsItems),
      ],
    });

    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.metadata.itemCount).toBe(mockNewsItems.length);
    expect(result.metadata.sourceCount).toBe(1);
    expect(result.metadata.errors).toBeDefined();
    expect(result.metadata.errors!.length).toBe(1);
    expect(result.metadata.errors![0]).toContain('FailingSource');
  });

  test('调用 aggregator 和 formatter，输出格式正确（Feishu）', async () => {
    const result = await fetchNews({
      topN: 3,
      platform: 'feishu',
      configOverride: dualSourceConfig,
      sources: [createMockSource('mock', 'Mock', mockNewsItems)],
    });

    expect(result.messages.length).toBeGreaterThan(0);
    const firstChunk = result.messages[0];
    expect(firstChunk).toContain('今日热点新闻');
    expect(firstChunk).toContain('共 ');
    expect(firstChunk).toContain(' 条');
    expect(firstChunk).toMatch(/\d{1,2}:\d{2}/); // 更新时间
    expect(firstChunk).toContain('数据来源');
  });

  test('输出格式正确（DingTalk Markdown）', async () => {
    const result = await fetchNews({
      topN: 3,
      platform: 'dingtalk',
      configOverride: dualSourceConfig,
      sources: [createMockSource('mock', 'Mock', mockNewsItems)],
    });

    expect(result.messages.length).toBeGreaterThan(0);
    const firstChunk = result.messages[0];
    expect(firstChunk).toContain('今日热点新闻');
    expect(firstChunk).toContain('**'); // Markdown 粗体
  });

  test('无启用源时抛出错误', async () => {
    const noSourceConfig: NewsSourcesConfig = {
      ...dualSourceConfig,
      sources: dualSourceConfig.sources.map((s) => ({ ...s, enabled: false })),
    };

    await expect(
      fetchNews({
        topN: 5,
        platform: 'feishu',
        configOverride: noSourceConfig,
      })
    ).rejects.toThrow(/没有启用的数据源/);
  });
});
