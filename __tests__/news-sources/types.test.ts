import { describe, test, expect } from 'bun:test';
import type {
  NewsItem,
  FetchOptions,
  NewsSource,
  SourceConfig,
  NewsSourcesConfig,
} from '../../shared/news-sources/../shared/news-sources/types';

describe('NewsItem', () => {
  test('应包含必填字段 platform, title, url', () => {
    const item: NewsItem = {
      platform: '微博',
      title: '测试标题',
      url: 'https://example.com/1',
    };
    expect(item.platform).toBe('微博');
    expect(item.title).toBe('测试标题');
    expect(item.url).toBe('https://example.com/1');
  });

  test('可选字段 rank, hotValue, description, timestamp 可正确赋值', () => {
    const item: NewsItem = {
      platform: '知乎',
      title: '热点新闻',
      url: 'https://example.com/2',
      rank: 1,
      hotValue: '123万',
      description: '新闻摘要',
      timestamp: Date.now(),
    };
    expect(item.rank).toBe(1);
    expect(item.hotValue).toBe('123万');
    expect(item.description).toBe('新闻摘要');
    expect(typeof item.timestamp).toBe('number');
  });

  test('最小有效 NewsItem 仅需 platform, title, url', () => {
    const item: NewsItem = {
      platform: '百度',
      title: '标题',
      url: 'http://a.com',
    };
    expect(Object.keys(item)).toContain('platform');
    expect(Object.keys(item)).toContain('title');
    expect(Object.keys(item)).toContain('url');
  });
});

describe('FetchOptions', () => {
  test('必填 topN 必须存在', () => {
    const opts: FetchOptions = { topN: 10 };
    expect(opts.topN).toBe(10);
  });

  test('可选 platforms 可正确赋值', () => {
    const opts: FetchOptions = {
      topN: 5,
      platforms: ['weibo', 'zhihu'],
    };
    expect(opts.platforms).toEqual(['weibo', 'zhihu']);
  });

  test('仅 topN 时 platforms 可为 undefined', () => {
    const opts: FetchOptions = { topN: 3 };
    expect(opts.platforms).toBeUndefined();
  });
});

describe('NewsSource', () => {
  test('实现类必须包含 id, name, enabled 和 fetch 方法', async () => {
    const mockSource: NewsSource = {
      id: 'mock',
      name: 'Mock Source',
      enabled: true,
      fetch: async (options: FetchOptions) => {
        expect(options.topN).toBe(5);
        return [
          {
            platform: 'test',
            title: 'mock item',
            url: 'https://mock.com',
          },
        ];
      },
    };

    expect(mockSource.id).toBe('mock');
    expect(mockSource.name).toBe('Mock Source');
    expect(mockSource.enabled).toBe(true);

    const items = await mockSource.fetch({ topN: 5 });
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('mock item');
    expect(items[0].platform).toBe('test');
    expect(items[0].url).toBe('https://mock.com');
  });

  test('fetch 返回的数组元素必须符合 NewsItem 结构', async () => {
    const source: NewsSource = {
      id: 't',
      name: 'T',
      enabled: true,
      fetch: async () => [
        { platform: 'A', title: 'T1', url: 'u1', rank: 1 },
        { platform: 'B', title: 'T2', url: 'u2', hotValue: '1万' },
      ],
    };

    const items = await source.fetch({ topN: 10 });
    expect(items.length).toBe(2);
    items.forEach((item) => {
      expect(item).toHaveProperty('platform');
      expect(item).toHaveProperty('title');
      expect(item).toHaveProperty('url');
      expect(typeof item.platform).toBe('string');
      expect(typeof item.title).toBe('string');
      expect(typeof item.url).toBe('string');
    });
  });
});

describe('SourceConfig', () => {
  test('应包含 id, name, enabled, type, config', () => {
    const config: SourceConfig = {
      id: 'newsnow',
      name: 'NewsNow API',
      enabled: true,
      type: 'newsnow',
      config: {
        baseUrl: 'https://api.newsnow.cn',
        platforms: ['weibo', 'zhihu'],
        timeout: 10000,
      },
    };
    expect(config.id).toBe('newsnow');
    expect(config.type).toBe('newsnow');
    expect(config.config.baseUrl).toBe('https://api.newsnow.cn');
    expect(config.config.platforms).toHaveLength(2);
  });
});

describe('NewsSourcesConfig', () => {
  test('应包含 version, defaultTopN, sources, aggregation, formatting', () => {
    const config: NewsSourcesConfig = {
      version: 1,
      defaultTopN: 10,
      sources: [
        {
          id: 'newsnow',
          name: 'NewsNow',
          enabled: true,
          type: 'newsnow',
          config: {},
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

    expect(config.version).toBe(1);
    expect(config.defaultTopN).toBe(10);
    expect(config.sources).toHaveLength(1);
    expect(config.aggregation.sortBy).toBe('rank');
    expect(config.formatting.includeUrl).toBe(true);
  });
});
