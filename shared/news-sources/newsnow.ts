import type { NewsSource, NewsItem, FetchOptions, SourceConfig } from './types';
import { recordMetrics } from './monitoring';

/** newsnow API 响应格式（支持 data.items 或 data 数组） */
interface NewsnowApiItem {
  title?: string;
  url?: string;
  extra?: { value?: string };
  desc?: string;
}

interface NewsnowApiResponse {
  data?: NewsnowApiItem[] | { items?: NewsnowApiItem[] };
}

export class NewsnowSource implements NewsSource {
  id: string;
  name: string;
  enabled: boolean;
  private baseUrl: string;
  private platforms: string[];
  private timeout: number;

  constructor(config: SourceConfig) {
    this.id = config.id;
    this.name = config.name;
    this.enabled = config.enabled;
    this.baseUrl = (config.config.baseUrl as string) || 'https://api.newsnow.cn';
    this.platforms = (config.config.platforms as string[]) || [];
    this.timeout = (config.config.timeout as number) ?? 5000;
  }

  async fetch(options: FetchOptions): Promise<NewsItem[]> {
    const start = Date.now();
    const targetPlatforms = options.platforms || this.platforms;
    const results: NewsItem[] = [];

    try {
      for (const platform of targetPlatforms) {
        try {
          const items = await this.fetchPlatform(platform, options.topN);
          results.push(...items);
        } catch (err) {
          console.error(`[newsnow] ${platform} 失败:`, err);
          // 超时错误向上抛出，让调用方感知
          if (err instanceof Error && err.message === '请求超时') {
            throw err;
          }
        }
      }

      recordMetrics(this.id, true, Date.now() - start, results.length);
      return results;
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

  private async fetchPlatform(platform: string, topN: number): Promise<NewsItem[]> {
    const url = `${this.baseUrl}/api/s?id=${platform}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = (await res.json()) as NewsnowApiResponse;
      const rawItems = this.extractItems(data);
      const items = rawItems.slice(0, topN).map((item: NewsnowApiItem, idx: number) => ({
        platform: this.getPlatformName(platform),
        title: item.title || '',
        url: item.url || '',
        rank: idx + 1,
        hotValue: item.extra?.value || '',
        description: item.desc || '',
        timestamp: Date.now(),
      }));

      return items;
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('请求超时');
      }
      throw err;
    }
  }

  /** 从 API 响应中提取 items（支持 data.items 或 data 数组） */
  private extractItems(data: NewsnowApiResponse): NewsnowApiItem[] {
    const d = data.data;
    if (!d) return [];
    if (Array.isArray(d)) return d;
    if (d && typeof d === 'object' && Array.isArray((d as { items?: NewsnowApiItem[] }).items)) {
      return (d as { items: NewsnowApiItem[] }).items;
    }
    return [];
  }

  private getPlatformName(id: string): string {
    const map: Record<string, string> = {
      weibo: '微博',
      zhihu: '知乎',
      baidu: '百度',
      douyin: '抖音',
      toutiao: '今日头条',
    };
    return map[id] || id;
  }
}
