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
  useEnhancedStyle: true,
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

    test('新样式：使用数字格式标题和简化热度显示', () => {
      const items: NewsItem[] = [
        {
          platform: '微博',
          title: '测试标题',
          url: 'http://a.com',
          rank: 1,
          hotValue: '123.4万',
          description: '测试描述',
        },
      ];

      const chunks = formatNewsCard(items, 'feishu', {
        ...defaultConfig,
        useEnhancedStyle: true,
      });

      expect(chunks).toHaveLength(1);
      // 新样式：**1.** 标题 · 🔥 123.4万热
      expect(chunks[0]).toContain('**1.** 测试标题');
      expect(chunks[0]).toContain('· 🔥 123.4万热');
      expect(chunks[0]).toContain('[→ 查看原文]');
      expect(chunks[0]).toContain('━━━━━━━━━━━━━━━━━━━━━━');
      expect(chunks[0]).toContain('## 🌟 微博');
      // 新样式描述不使用斜体
      expect(chunks[0]).not.toContain('*测试描述*');
      expect(chunks[0]).toContain('> 测试描述');
    });

    test('旧样式：使用 emoji 标题和反引号热度', () => {
      const items: NewsItem[] = [
        {
          platform: '微博',
          title: '测试标题',
          url: 'http://a.com',
          rank: 1,
          hotValue: '123.4万',
          description: '测试描述',
        },
      ];

      const chunks = formatNewsCard(items, 'feishu', {
        ...defaultConfig,
        useEnhancedStyle: false,
      });

      expect(chunks).toHaveLength(1);
      // 旧样式：1️⃣ **标题** 🔥 `123.4万`
      expect(chunks[0]).toContain('1️⃣ **测试标题**');
      expect(chunks[0]).toContain('🔥 `123.4万`');
      expect(chunks[0]).toContain('🔗 [查看原文]');
      expect(chunks[0]).toContain('## 📌 微博');
      // 旧样式描述使用斜体
      expect(chunks[0]).toContain('> *测试描述*');
      // 旧样式不使用分隔线
      expect(chunks[0]).not.toContain('━━━━━━━━━━━━━━━━━━━━━━');
    });

    test('新旧样式：钉钉平台一致性', () => {
      const items: NewsItem[] = [
        {
          platform: '知乎',
          title: '知乎热点',
          url: 'http://b.com',
          rank: 2,
          hotValue: '50万',
        },
      ];

      const enhancedChunks = formatNewsCard(items, 'dingtalk', {
        ...defaultConfig,
        useEnhancedStyle: true,
      });

      const legacyChunks = formatNewsCard(items, 'dingtalk', {
        ...defaultConfig,
        useEnhancedStyle: false,
      });

      // 验证两种样式都能正常生成
      expect(enhancedChunks).toHaveLength(1);
      expect(legacyChunks).toHaveLength(1);

      // 新样式特征
      expect(enhancedChunks[0]).toContain('**2.** 知乎热点');
      expect(enhancedChunks[0]).toContain('## 🌟 知乎');

      // 旧样式特征
      expect(legacyChunks[0]).toContain('2️⃣ **知乎热点**');
      expect(legacyChunks[0]).toContain('## 📌 知乎');
    });

    test('新样式消息分片保持一致性', () => {
      const platforms = ['微博', '知乎', '百度'];
      const items: NewsItem[] = Array.from({ length: 80 }, (_, i) => ({
        platform: platforms[i % platforms.length],
        title: `新闻${i} `.repeat(25),
        url: `http://example.com/${i}`,
        rank: i + 1,
        hotValue: '100万',
        description: '描述 '.repeat(30),
      }));

      const chunks = formatNewsCard(items, 'feishu', {
        ...defaultConfig,
        useEnhancedStyle: true,
        maxItemsPerPlatform: 40,
      });

      expect(chunks.length).toBeGreaterThan(1);

      // 验证所有分片都使用新样式
      for (const chunk of chunks) {
        if (chunk.includes('新闻')) {
          expect(chunk).toMatch(/\*\*\d+\.\*\*/); // 数字格式
          expect(chunk).toContain('🌟'); // 新平台 emoji
        }
      }
    });
  });
});
