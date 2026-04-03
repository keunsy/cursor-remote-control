import type { NewsSource, NewsItem, FetchOptions, SourceConfig } from './types';
import { recordMetrics } from './monitoring';

/**
 * AI News Aggregator 数据源
 * 直接读取 SuYxh/ai-news-aggregator 的 GitHub Pages JSON API
 * 数据每 2 小时自动更新，覆盖 160+ AI/科技信息源
 * @see https://github.com/SuYxh/ai-news-aggregator
 */

interface AggregatorItem {
  id: string;
  site_id: string;
  site_name: string;
  source: string;
  title: string;
  url: string;
  published_at: string;
  title_zh?: string;
  title_en?: string;
}

interface AggregatorResponse {
  generated_at: string;
  total_items: number;
  source_count: number;
  items: AggregatorItem[];
}

export class AIAggregatorSource implements NewsSource {
  id: string;
  name: string;
  enabled: boolean;
  private apiUrl: string;
  private timeout: number;
  private platforms?: string[];

  constructor(config: SourceConfig) {
    this.id = config.id;
    this.name = config.name;
    this.enabled = config.enabled;
    this.apiUrl =
      (config.config.apiUrl as string) ||
      'https://suyxh.github.io/ai-news-aggregator/data/latest-24h.json';
    this.timeout = (config.config.timeout as number) ?? 15000;
    this.platforms = config.config.platforms as string[] | undefined;
  }

  async fetch(options: FetchOptions): Promise<NewsItem[]> {
    const start = Date.now();
    try {
      const data = await this.fetchAPI();

      let items = data.items;
      if (this.platforms || options.platforms) {
        const allowed = options.platforms ?? this.platforms!;
        const lowerSet = new Set(allowed.map((p) => p.toLowerCase()));
        items = items.filter(
          (i) =>
            lowerSet.has(i.site_name.toLowerCase()) ||
            lowerSet.has(i.source.toLowerCase()) ||
            allowed.some(
              (p) =>
                i.source.toLowerCase().includes(p.toLowerCase()) ||
                i.site_name.toLowerCase().includes(p.toLowerCase())
            )
        );
      }

      const urlHeat = this.calcUrlHeat(data.items);
      const perPlatformLimit = options.topN;

      const seen = new Set<string>();
      const byPlatform = new Map<string, NewsItem[]>();

      const scored = items.map((item) => {
        const cleanUrl = this.cleanUrl(item.url);
        return { item, heat: urlHeat.get(cleanUrl) ?? 1 };
      });
      scored.sort((a, b) => {
        if (b.heat !== a.heat) return b.heat - a.heat;
        const tA = a.item.published_at ? new Date(a.item.published_at).getTime() : 0;
        const tB = b.item.published_at ? new Date(b.item.published_at).getTime() : 0;
        return tB - tA;
      });

      for (const { item, heat } of scored) {
        const cleanUrl = this.cleanUrl(item.url);
        if (seen.has(cleanUrl)) continue;
        seen.add(cleanUrl);

        const platform = item.site_name || this.normalizePlatform(item.source);
        const bucket = byPlatform.get(platform) ?? [];
        if (bucket.length >= perPlatformLimit) continue;

        const title = item.title_zh || item.title;
        let timestamp: number | undefined;
        if (item.published_at) {
          const d = new Date(item.published_at);
          if (!isNaN(d.getTime())) timestamp = d.getTime();
        }

        bucket.push({
          platform,
          title,
          url: item.url,
          rank: bucket.length + 1,
          hotValue: heat > 1 ? `${heat}源` : undefined,
          timestamp,
        });
        byPlatform.set(platform, bucket);
      }

      const result: NewsItem[] = [];
      for (const items of byPlatform.values()) {
        result.push(...items);
      }

      recordMetrics(this.id, true, Date.now() - start, result.length);
      return result;
    } catch (err) {
      recordMetrics(
        this.id,
        false,
        Date.now() - start,
        0,
        err instanceof Error ? err.message : String(err)
      );
      throw err;
    }
  }

  private async fetchAPI(): Promise<AggregatorResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(this.apiUrl, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as AggregatorResponse;
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('请求超时');
      }
      throw err;
    }
  }

  private cleanUrl(url: string): string {
    const keepQueryDomains = ['mp.weixin.qq.com', 'news.ycombinator.com', 'youtube.com', 'youtu.be'];
    const lower = url.toLowerCase();
    if (keepQueryDomains.some((d) => lower.includes(d))) {
      return url.replace(/#.*$/, '');
    }
    return url.replace(/[?#].*$/, '');
  }

  private calcUrlHeat(allItems: AggregatorItem[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const item of allItems) {
      const key = this.cleanUrl(item.url);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }

  private normalizePlatform(source: string): string {
    const lower = source.toLowerCase();
    if (lower.includes('hacker news') || lower.includes('hackernews') || lower.includes('news.ycombinator')) return 'Hacker News';
    if (lower.includes('techcrunch') || lower.includes('techmeme')) return 'TechCrunch';
    if (lower.includes('36kr') || lower.includes('36氪')) return '36氪';
    if (lower.includes('readhub')) return 'Readhub';
    if (lower.includes('aibase')) return 'AIbase';
    if (lower.includes('reddit')) return 'Reddit';
    if (lower.includes('twitter') || lower.includes('x.com')) return 'X/Twitter';
    if (lower.includes('juejin') || lower.includes('掘金')) return '掘金';
    if (lower.includes('arxiv')) return 'arXiv';
    if (lower.includes('youtube')) return 'YouTube';
    if (lower.includes('github')) return 'GitHub';
    if (lower.includes('producthunt') || lower.includes('product hunt')) return 'Product Hunt';
    if (lower.includes('openai')) return 'OpenAI';
    if (lower.includes('anthropic')) return 'Anthropic';
    if (lower.includes('google')) return 'Google AI';
    if (lower.includes('bloomberg')) return 'Bloomberg';
    if (lower.includes('lobsters')) return 'Lobsters';
    if (lower.includes('v2ex')) return 'V2EX';
    if (lower.includes('ithome') || lower.includes('it之家')) return 'IT之家';
    if (lower.includes('虎嗅')) return '虎嗅';
    if (lower.includes('开源中国')) return '开源中国';
    if (lower.includes('量子位')) return '量子位';
    if (lower.includes('机器之心')) return '机器之心';
    if (lower.includes('新智元')) return '新智元';
    if (lower.includes('少数派')) return '少数派';
    if (lower.includes('infoq')) return 'InfoQ';
    if (lower.includes('techradar')) return 'TechRadar';
    const cleaned = source.split('(')[0].split('·')[0].split('@')[0].trim();
    return cleaned || source;
  }
}
