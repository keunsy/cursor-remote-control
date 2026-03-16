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
  }

  async fetch(options: FetchOptions): Promise<NewsItem[]> {
    const start = Date.now();
    const results: NewsItem[] = [];

    try {
      for (const feed of this.feeds) {
        try {
          const items = await this.fetchFeed(feed, options.topN);
          results.push(...items);
        } catch (err) {
          console.error(`[rsshub] ${feed} fetch failed:`, err);
          if (err instanceof Error && err.message === '请求超时') {
            throw err;
          }
        }
      }

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
    const url = `${this.baseUrl.replace(/\/$/, '')}/${feed.replace(/^\//, '')}`;

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
    if (feed.includes('weibo')) return '微博';
    if (feed.includes('zhihu')) return '知乎';
    if (feed.includes('baidu')) return '百度';
    if (feed.includes('douyin')) return '抖音';
    if (feed.includes('toutiao')) return '今日头条';
    return 'RSS';
  }
}
