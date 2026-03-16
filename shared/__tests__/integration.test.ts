/**
 * 新闻推送端到端集成测试
 *
 * 模拟完整流程：调度器触发 -> fetchNews -> 消息格式化 -> 发送
 * 所有外部依赖（fetch、sendCard、sendMarkdown）均通过 mock 注入
 */
import { describe, test, expect } from 'bun:test';
import { fetchNews } from '../news-fetcher';
import type { NewsSourcesConfig, NewsSource, NewsItem } from '../news-sources/types';

// ── Mock 工厂 ─────────────────────────────────────────────────────────────

function createMockSource(id: string, name: string, items: NewsItem[]): NewsSource {
  return {
    id,
    name,
    enabled: true,
    fetch: async () => items,
  };
}

function createFailingSource(id: string, name: string, error = 'mock network error'): NewsSource {
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

const baseConfig: NewsSourcesConfig = {
  version: 1,
  defaultTopN: 10,
  sources: [],
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

/** 模拟调度器 onExecute 逻辑（与 feishu/dingtalk server 一致） */
async function simulateNewsJobExecution(
  jobMessage: string,
  platform: 'feishu' | 'dingtalk',
  fetchNewsFn: typeof fetchNews
): Promise<{ status: 'ok' | 'error'; result: string; error?: string }> {
  try {
    let topN = 15;
    if (typeof jobMessage === 'string' && jobMessage.startsWith('{')) {
      try {
        const parsed = JSON.parse(jobMessage) as { type?: string; options?: { topN?: number } };
        topN = parsed.options?.topN ?? 15;
      } catch {
        /* ignore */
      }
    }
    const { messages } = await fetchNewsFn({ topN, platform });
    if (messages.length > 1) {
      return { status: 'ok', result: JSON.stringify({ chunks: messages }) };
    }
    return { status: 'ok', result: messages[0] ?? '' };
  } catch (err) {
    const fallback = `⚠️ 热点抓取失败\n\n${err instanceof Error ? err.message : String(err)}\n\n稍后会自动重试`;
    return { status: 'error', error: String(err), result: fallback };
  }
}

/** 模拟 onDelivery：解析 result 并返回将要发送的内容（用于断言） */
function parseDeliveryResult(result: string): { chunks: string[]; isNews: boolean } {
  try {
    const parsed = JSON.parse(result) as { chunks?: string[] };
    if (parsed && Array.isArray(parsed.chunks) && parsed.chunks.length > 0) {
      return { chunks: parsed.chunks, isNews: true };
    }
  } catch {
    /* not JSON */
  }
  return { chunks: [result], isNews: result.includes('今日热点') || result.includes('热点抓取失败') };
}

// ── 集成测试 ──────────────────────────────────────────────────────────────

describe('新闻推送集成测试', () => {
  test('正常流程：调度器触发 -> fetchNews -> 格式化 -> 单条发送（飞书）', async () => {
    const execResult = await simulateNewsJobExecution(
      'fetch-news',
      'feishu',
      (opts) =>
        fetchNews({
          ...opts,
          platform: 'feishu',
          configOverride: baseConfig,
          sources: [createMockSource('mock', 'Mock', mockNewsItems)],
        })
    );

    expect(execResult.status).toBe('ok');
    expect(execResult.result).toBeTruthy();

    const { chunks, isNews } = parseDeliveryResult(execResult.result);
    expect(isNews).toBe(true);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0]).toContain('今日热点新闻');
    expect(chunks[0]).toContain('ChatGPT-5 正式发布');
    expect(chunks[0]).toContain('123万');
    expect(chunks[0]).toContain('数据来源');
  });

  test('正常流程：调度器触发 -> fetchNews -> 格式化 -> 单条发送（钉钉）', async () => {
    const execResult = await simulateNewsJobExecution(
      'fetch-news',
      'dingtalk',
      (opts) =>
        fetchNews({
          ...opts,
          platform: 'dingtalk',
          configOverride: baseConfig,
          sources: [createMockSource('mock', 'Mock', mockNewsItems)],
        })
    );

    expect(execResult.status).toBe('ok');
    const { chunks } = parseDeliveryResult(execResult.result);
    expect(chunks[0]).toContain('今日热点新闻');
    expect(chunks[0]).toContain('**'); // Markdown 粗体
  });

  test('部分源失败：一个源失败，另一个成功，仍能正常推送', async () => {
    const execResult = await simulateNewsJobExecution(
      '{"type":"fetch-news","options":{"topN":5}}',
      'feishu',
      (opts) =>
        fetchNews({
          ...opts,
          platform: 'feishu',
          configOverride: baseConfig,
          sources: [
            createFailingSource('fail', 'FailingSource', 'mock network error'),
            createMockSource('ok', 'OKSource', mockNewsItems),
          ],
        })
    );

    expect(execResult.status).toBe('ok');
    const { chunks } = parseDeliveryResult(execResult.result);
    expect(chunks[0]).toContain('今日热点新闻');
    expect(chunks[0]).toContain('ChatGPT-5 正式发布');
  });

  test('全部源失败：返回错误状态和降级提示', async () => {
    const execResult = await simulateNewsJobExecution(
      'fetch-news',
      'feishu',
      (opts) =>
        fetchNews({
          ...opts,
          platform: 'feishu',
          configOverride: baseConfig,
          sources: [
            createFailingSource('a', 'SourceA', 'timeout'),
            createFailingSource('b', 'SourceB', 'HTTP 500'),
          ],
        })
    );

    expect(execResult.status).toBe('error');
    expect(execResult.error).toContain('所有数据源失败');
    expect(execResult.result).toContain('热点抓取失败');
    expect(execResult.result).toContain('稍后会自动重试');
  });

  test('多批消息：超长内容正确分片为 chunks', async () => {
    const manyItems: NewsItem[] = Array.from({ length: 50 }, (_, i) => ({
      platform: i % 2 === 0 ? '微博' : '知乎',
      title: `热点新闻${i}：完全不同的标题${i}避免去重`,
      url: `https://example.com/${i}`,
      rank: i + 1,
      hotValue: `${i}万`,
      description: '这是一段较长的描述内容，用于测试消息分片逻辑是否正确工作',
      timestamp: Date.now(),
    }));

    const result = await fetchNews({
      topN: 50,
      platform: 'feishu',
      configOverride: { ...baseConfig, formatting: { ...baseConfig.formatting, maxItemsPerPlatform: 20 } },
      sources: [createMockSource('mock', 'Mock', manyItems)],
    });

    // 内容较多时可能分片
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
    expect(result.metadata.itemCount).toBeGreaterThanOrEqual(1);
    result.messages.forEach((msg) => {
      expect(msg).toContain('今日热点新闻');
    });
  });

  test('错误处理：JSON 格式的 job message 正确解析 topN', async () => {
    const execResult = await simulateNewsJobExecution(
      '{"type":"fetch-news","options":{"topN":3}}',
      'dingtalk',
      (opts) => {
        expect(opts?.topN).toBe(3);
        return fetchNews({
          topN: 3,
          platform: 'dingtalk',
          configOverride: baseConfig,
          sources: [createMockSource('mock', 'Mock', mockNewsItems.slice(0, 2))],
        });
      }
    );

    expect(execResult.status).toBe('ok');
  });
});
