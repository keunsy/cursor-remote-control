import { describe, test, expect } from 'bun:test';
import {
  deduplicateByUrl,
  deduplicateByTitle,
  sortItems,
  aggregateNews,
} from '../aggregator';
import type { NewsItem } from '../types';

describe('aggregator', () => {
  describe('deduplicateByUrl', () => {
    test('相同 URL 保留第一个', () => {
      const items: NewsItem[] = [
        { platform: 'weibo', title: 'A', url: 'http://a.com' },
        { platform: 'zhihu', title: 'B', url: 'http://a.com' },
        { platform: 'baidu', title: 'C', url: 'http://b.com' },
      ];

      const result = deduplicateByUrl(items);
      expect(result).toHaveLength(2);
      expect(result[0].url).toBe('http://a.com');
      expect(result[0].title).toBe('A');
      expect(result[1].url).toBe('http://b.com');
    });

    test('空数组返回空数组', () => {
      expect(deduplicateByUrl([])).toEqual([]);
    });
  });

  describe('deduplicateByTitle', () => {
    test('相似度 > 0.8 视为重复', () => {
      const items: NewsItem[] = [
        { platform: 'weibo', title: 'ChatGPT-5 正式发布', url: 'http://a.com' },
        { platform: 'zhihu', title: 'ChatGPT5 正式发布了', url: 'http://b.com' },
        { platform: 'baidu', title: '比亚迪销量破纪录', url: 'http://c.com' },
      ];

      const result = deduplicateByTitle(items, 0.8);
      expect(result).toHaveLength(2);
    });

    test('完全不同标题不去重', () => {
      const items: NewsItem[] = [
        { platform: 'weibo', title: '苹果发布新机', url: 'http://a.com' },
        { platform: 'zhihu', title: '特斯拉股价大涨', url: 'http://b.com' },
      ];
      const result = deduplicateByTitle(items, 0.8);
      expect(result).toHaveLength(2);
    });
  });

  describe('sortItems', () => {
    test('按 hotness 降序排序', () => {
      const items: NewsItem[] = [
        { platform: 'weibo', title: 'A', url: 'http://a.com', hotValue: '100万' },
        { platform: 'zhihu', title: 'B', url: 'http://b.com', hotValue: '500万' },
        { platform: 'baidu', title: 'C', url: 'http://c.com', hotValue: '200万' },
      ];

      const result = sortItems(items, 'hotValue');
      expect(result[0].hotValue).toBe('500万');
      expect(result[1].hotValue).toBe('200万');
      expect(result[2].hotValue).toBe('100万');
    });

    test('按 publishedAt (timestamp) 降序排序', () => {
      const items: NewsItem[] = [
        { platform: 'weibo', title: 'A', url: 'http://a.com', timestamp: 1000 },
        { platform: 'zhihu', title: 'B', url: 'http://b.com', timestamp: 3000 },
        { platform: 'baidu', title: 'C', url: 'http://c.com', timestamp: 2000 },
      ];

      const result = sortItems(items, 'time');
      expect(result[0].timestamp).toBe(3000);
      expect(result[1].timestamp).toBe(2000);
      expect(result[2].timestamp).toBe(1000);
    });

    test('按 rank 升序排序', () => {
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

  describe('aggregateNews', () => {
    test('完整流程：去重 + 排序 + topN', () => {
      const itemsList: NewsItem[][] = [
        [
          { platform: 'weibo', title: 'A', url: 'http://a.com', hotValue: '100万', timestamp: 1000 },
          { platform: 'zhihu', title: 'A', url: 'http://a.com', hotValue: '200万', timestamp: 2000 },
          { platform: 'baidu', title: 'B', url: 'http://b.com', hotValue: '500万', timestamp: 3000 },
        ],
      ];

      const result = aggregateNews(itemsList, {
        deduplicateByUrl: true,
        deduplicateByTitle: false,
        titleSimilarityThreshold: 0.8,
        sortBy: 'hotValue',
        topN: 5,
      });

      expect(result).toHaveLength(2); // URL 去重后 2 条
      expect(result[0].url).toBe('http://b.com'); // hotValue 最高
      expect(result[1].url).toBe('http://a.com');
    });

    test('标题去重 + 排序', () => {
      const itemsList: NewsItem[][] = [
        [
          { platform: 'weibo', title: 'ChatGPT-5 正式发布', url: 'http://a.com', hotValue: '100万' },
          { platform: 'zhihu', title: 'ChatGPT5 正式发布', url: 'http://b.com', hotValue: '200万' },
          { platform: 'baidu', title: '比亚迪销量破纪录', url: 'http://c.com', hotValue: '50万' },
        ],
      ];

      const result = aggregateNews(itemsList, {
        deduplicateByUrl: false,
        deduplicateByTitle: true,
        titleSimilarityThreshold: 0.8,
        sortBy: 'hotValue',
        topN: 10,
      });

      expect(result).toHaveLength(2); // 标题相似去重后 2 条（ChatGPT-5 与 ChatGPT5 相似）
      expect(result[0].title).toContain('ChatGPT'); // 保留热度更高的
      expect(result[1].title).toContain('比亚迪');
    });
  });
});
