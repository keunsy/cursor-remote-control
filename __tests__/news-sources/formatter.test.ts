import { describe, test, expect } from 'bun:test';
import { formatNewsCard, groupByPlatform } from '../../shared/news-sources/formatter';
import type { NewsItem } from '../../shared/news-sources/types';

const defaultConfig = {
  maxItemsPerPlatform: 10,
  includeRank: true,
  includeHotValue: true,
  includeDescription: true,
  descriptionMaxLength: 100,
  includeUrl: true,
};

describe('formatter', () => {
  describe('groupByPlatform', () => {
    test('按平台分组新闻', () => {
      const items: NewsItem[] = [
        { platform: '微博', title: 'A', url: 'http://a.com' },
        { platform: '知乎', title: 'B', url: 'http://b.com' },
        { platform: '微博', title: 'C', url: 'http://c.com' },
      ];

      const grouped = groupByPlatform(items);
      expect(grouped['微博']).toHaveLength(2);
      expect(grouped['知乎']).toHaveLength(1);
      expect(grouped['微博'][0].title).toBe('A');
      expect(grouped['微博'][1].title).toBe('C');
      expect(grouped['知乎'][0].title).toBe('B');
    });

    test('空数组返回空对象', () => {
      const grouped = groupByPlatform([]);
      expect(grouped).toEqual({});
    });
  });

  describe('formatNewsCard', () => {
    test('格式化为飞书卡片（含 rank、hotValue、description）', () => {
      const items: NewsItem[] = [
        {
          platform: '微博',
          title: 'ChatGPT-5 正式发布',
          url: 'http://a.com',
          rank: 1,
          hotValue: '123万',
          description: '这是摘要',
        },
      ];

      const chunks = formatNewsCard(items, 'feishu', {
        ...defaultConfig,
        descriptionMaxLength: 80,
      });

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toContain('微博');
      expect(chunks[0]).toContain('ChatGPT-5 正式发布');
      expect(chunks[0]).toContain('123万');
      expect(chunks[0]).toContain('这是摘要');
    });

    test('格式化为钉钉 Markdown（标题、列表、链接）', () => {
      const items: NewsItem[] = [
        {
          platform: '微博',
          title: '热点新闻标题',
          url: 'http://example.com',
          rank: 1,
          hotValue: '50万',
        },
      ];

      const chunks = formatNewsCard(items, 'dingtalk', defaultConfig);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toContain('微博');
      expect(chunks[0]).toContain('热点新闻标题');
      expect(chunks[0]).toContain('http://example.com');
      expect(chunks[0]).toContain('50万');
    });

    test('description 超过 100 字时截断并添加省略号', () => {
      const longDesc = 'a'.repeat(150);
      const items: NewsItem[] = [
        {
          platform: '微博',
          title: '测试',
          url: 'http://a.com',
          description: longDesc,
        },
      ];

      const chunks = formatNewsCard(items, 'feishu', defaultConfig);

      expect(chunks[0]).toContain('...');
      expect(chunks[0].length).toBeLessThan(longDesc.length + 200);
      // 截断后应为 97 字 + "..."
      const truncatedPart = chunks[0].match(/a{97}\.\.\./);
      expect(truncatedPart).not.toBeNull();
    });

    test('空数组返回空消息或占位提示', () => {
      const feishuChunks = formatNewsCard([], 'feishu', defaultConfig);
      const dingtalkChunks = formatNewsCard([], 'dingtalk', defaultConfig);

      expect(feishuChunks).toHaveLength(1);
      expect(feishuChunks[0]).toContain('暂无');
      expect(dingtalkChunks).toHaveLength(1);
      expect(dingtalkChunks[0]).toContain('暂无');
    });

    test('超过飞书 30KB 时分多条消息，每条包含 [Part X/Y]', () => {
      // 构造超长内容：多平台 × 每平台多条目，使总内容超过 30KB
      const platforms = ['微博', '知乎', '百度', '抖音', '头条'];
      const items: NewsItem[] = Array.from({ length: 150 }, (_, i) => ({
        platform: platforms[i % platforms.length],
        title: `新闻标题${i} `.repeat(25),
        url: `http://example.com/${i}`,
        rank: i + 1,
        hotValue: '100万',
        description: '描述内容 '.repeat(40),
      }));

      const chunks = formatNewsCard(items, 'feishu', {
        ...defaultConfig,
        maxItemsPerPlatform: 50,
      });

      expect(chunks.length).toBeGreaterThan(1);
      for (let i = 0; i < chunks.length; i++) {
        expect(chunks[i]).toMatch(/\[Part \d+\/\d+\]/);
      }
    });

    test('超过钉钉 20KB 时分多条消息，每条包含 [Part X/Y]', () => {
      const platforms = ['微博', '知乎', '百度'];
      const items: NewsItem[] = Array.from({ length: 100 }, (_, i) => ({
        platform: platforms[i % platforms.length],
        title: `新闻${i} `.repeat(30),
        url: `http://example.com/${i}`,
        rank: i + 1,
        hotValue: '50万',
        description: '描述 '.repeat(35),
      }));

      const chunks = formatNewsCard(items, 'dingtalk', {
        ...defaultConfig,
        maxItemsPerPlatform: 40,
      });

      expect(chunks.length).toBeGreaterThan(1);
      for (let i = 0; i < chunks.length; i++) {
        expect(chunks[i]).toMatch(/\[Part \d+\/\d+\]/);
      }
    });

    test('单条消息不添加 [Part X/Y] 前缀', () => {
      const items: NewsItem[] = [
        { platform: '微博', title: '短标题', url: 'http://a.com' },
      ];

      const chunks = formatNewsCard(items, 'feishu', defaultConfig);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).not.toMatch(/\[Part \d+\/\d+\]/);
    });
  });
});
