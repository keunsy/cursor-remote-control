import type { NewsItem, FetchOptions, NewsSource, SourceConfig } from './news-sources/types';
import { loadConfig, getEnabledSources } from './news-sources/config-loader';
import { NewsnowSource } from './news-sources/newsnow';
import { RSSHubSource } from './news-sources/rsshub';
import { AIAggregatorSource } from './news-sources/ai-aggregator';
import { MockNewsSource } from './news-sources/mock';
import { aggregateNews } from './news-sources/aggregator';
import { formatNewsCard } from './news-sources/formatter';
import type { NewsSourcesConfig } from './news-sources/types';

export interface FetchNewsOptions extends Partial<FetchOptions> {
  /** 输出平台：feishu、dingtalk 或 wecom */
  platform?: 'feishu' | 'dingtalk' | 'wecom' | 'wechat';
  /** 测试用：覆盖配置，不读取文件 */
  configOverride?: NewsSourcesConfig;
  /** 测试用：直接注入数据源，跳过 config 加载与源创建 */
  sources?: NewsSource[];
}

export interface FetchNewsResult {
  messages: string[];
  metadata: {
    itemCount: number;
    sourceCount: number;
    errors?: string[];
  };
}

/** 工厂函数：根据配置创建数据源实例 */
function createSource(config: SourceConfig, globalConfig?: NewsSourcesConfig): NewsSource {
  switch (config.type) {
    case 'newsnow':
      return new NewsnowSource(config, globalConfig?.presets);
    case 'rsshub':
      return new RSSHubSource(config);
    case 'ai-aggregator':
      return new AIAggregatorSource(config);
    case 'mock':
      return new MockNewsSource(config);
    default:
      throw new Error(`未知数据源类型: ${config.type}`);
  }
}

/** 统一抓取入口：加载配置 → 并行 fetch → 聚合去重 → 格式化输出 */
export async function fetchNews(
  options?: FetchNewsOptions
): Promise<FetchNewsResult> {
  const config = options?.configOverride ?? (await loadConfig());
  const topN = options?.topN ?? config.defaultTopN;
  const platform = options?.platform ?? 'feishu';

  const sources =
    options?.sources ??
    (() => {
      const enabledSources = getEnabledSources(config);
      if (enabledSources.length === 0) {
        throw new Error('没有启用的数据源');
      }
      return enabledSources.map((s) => createSource(s, config));
    })();

  // 使用 Promise.allSettled 保证部分源失败时其他源仍正常工作
  const results = await Promise.allSettled(
    sources.map((s) => s.fetch({ topN, platforms: options?.platforms }))
  );

  const itemsList: NewsItem[][] = [];
  const errors: string[] = [];

  for (const [idx, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      itemsList.push(result.value);
    } else {
      const src = sources[idx];
      const errMsg = `${src?.name ?? `source[${idx}]`}: ${result.reason}`;
      errors.push(errMsg);
      console.error(`[news-fetcher] source failed: ${errMsg}`);
    }
  }

  if (itemsList.length === 0) {
    throw new Error(`所有数据源失败：\n${errors.join('\n')}`);
  }

  // 聚合去重
  const aggregated = aggregateNews(itemsList, config.aggregation);

  // 格式化输出
  const messages = formatNewsCard(aggregated, platform, config.formatting);

  return {
    messages,
    metadata: {
      itemCount: aggregated.length,
      sourceCount: itemsList.length,
      errors: errors.length > 0 ? errors : undefined,
    },
  };
}
