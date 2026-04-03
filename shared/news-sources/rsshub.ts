import { XMLParser } from 'fast-xml-parser';
import type { NewsSource, NewsItem, FetchOptions, SourceConfig } from './types';
import { recordMetrics } from './monitoring';

/** RSS 2.0 解析后的 item 结构 */
interface RssItem {
  title?: string | { '#text'?: string };
  link?: string;
  pubDate?: string;
  description?: string | { '#text'?: string };
}

interface RssChannel {
  item?: RssItem | RssItem[];
}

interface RssParsed {
  rss?: {
    channel?: RssChannel;
  };
}

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
    this.baseUrl = (config.config.baseUrl as string) || 'https://rsshub.app';
    this.feeds = (config.config.feeds as string[]) || [];
    this.timeout = (config.config.timeout as number) ?? 15000;

    const names = config.config.feedNames as Record<string, string> | undefined;
    if (names) {
      for (const [feed, name] of Object.entries(names)) {
        this.feedNameMap.set(feed, name);
      }
    }
  }

  async fetch(options: FetchOptions): Promise<NewsItem[]> {
    const start = Date.now();
    const results: NewsItem[] = [];

    try {
      const perFeedLimit = Math.max(options.topN, 10);
      const feedResults = await Promise.allSettled(
        this.feeds.map((feed) => this.fetchFeed(feed, perFeedLimit))
      );

      for (const [idx, result] of feedResults.entries()) {
        if (result.status === 'fulfilled') {
          results.push(...result.value);
        } else {
          console.error(`[rsshub] ${this.feeds[idx]} fetch failed:`, result.reason);
        }
      }

      if (results.length === 0) {
        throw new Error(`所有 RSS feed 请求失败（${this.feeds.join(', ')}）`);
      }

      results.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
      let rank = 1;
      for (const item of results) item.rank = rank++;

      const sliced = results.slice(0, options.topN);
      recordMetrics(this.id, true, Date.now() - start, sliced.length);
      return sliced;
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

  private async fetchFeed(feed: string, topN: number): Promise<NewsItem[]> {
    const url = feed.startsWith('http')
      ? feed
      : `${this.baseUrl.replace(/\/$/, '')}/${feed.replace(/^\//, '')}`;

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
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('请求超时');
      }
      throw err;
    }
  }

  private parseRSS(xml: string, feed: string): NewsItem[] {
    const parser = new XMLParser({
      ignoreAttributes: false,
      trimValues: true,
    });

    let parsed: RssParsed;
    try {
      parsed = parser.parse(xml) as RssParsed;
    } catch {
      throw new Error('无效的 XML');
    }

    const channel = parsed?.rss?.channel;
    if (!channel) return [];

    const rawItems = channel.item;
    if (!rawItems) return [];

    const items = Array.isArray(rawItems) ? rawItems : [rawItems];
    const platform = this.getPlatformName(feed);
    const result: NewsItem[] = [];
    let rank = 1;

    for (const item of items) {
      const title = this.extractText(item.title);
      const link = typeof item.link === 'string' ? item.link : '';
      if (!title || !link) continue;

      const description = this.extractText(item.description);
      const cleanDesc = description
        ? description.replace(/<[^>]*>/g, '').trim().slice(0, 200)
        : '';

      let timestamp: number | undefined;
      if (item.pubDate) {
        const d = new Date(item.pubDate);
        if (!isNaN(d.getTime())) timestamp = d.getTime();
      }
      if (!timestamp) timestamp = Date.now();

      result.push({
        platform,
        title,
        url: link,
        rank: rank++,
        description: cleanDesc || undefined,
        timestamp,
      });
    }

    return result;
  }

  private extractText(value: string | { '#text'?: string } | undefined): string {
    if (!value) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'object' && value['#text']) return String(value['#text']).trim();
    return '';
  }

  private getPlatformName(feed: string): string {
    const mapped = this.feedNameMap.get(feed);
    if (mapped) return mapped;

    const lower = feed.toLowerCase();
    if (lower.includes('weibo')) return '微博';
    if (lower.includes('zhihu')) return '知乎';
    if (lower.includes('baidu')) return '百度';
    if (lower.includes('douyin')) return '抖音';
    if (lower.includes('toutiao')) return '今日头条';
    if (lower.includes('36kr')) return '36氪';
    if (lower.includes('qbitai')) return '量子位';
    if (lower.includes('techcrunch')) return 'TechCrunch AI';
    if (lower.includes('hnrss') || lower.includes('hackernews') || lower.includes('hn.algolia') || lower.includes('hacker-news')) return 'Hacker News';
    if (lower.includes('producthunt') || lower.includes('product-hunt')) return 'Product Hunt';
    if (lower.includes('sspai')) return '少数派';
    if (lower.includes('readhub')) return 'Readhub';
    if (lower.includes('ithome')) return 'IT之家';
    if (lower.includes('jiqizhixin') || lower.includes('机器之心')) return '机器之心';
    if (lower.includes('leiphone') || lower.includes('雷锋网')) return '雷锋网';
    if (lower.includes('infoq')) return 'InfoQ';
    if (lower.includes('theverge')) return 'The Verge AI';
    if (lower.includes('venturebeat')) return 'VentureBeat AI';
    if (lower.includes('openai.com')) return 'OpenAI';
    if (lower.includes('deepmind')) return 'DeepMind';
    if (lower.includes('huggingface')) return 'Hugging Face';
    if (lower.includes('arstechnica')) return 'Ars Technica';
    return 'RSS';
  }

  private feedNameMap = new Map<string, string>();

  setFeedName(feed: string, name: string): void {
    this.feedNameMap.set(feed, name);
  }
}
