import type { NewsSource, NewsItem, FetchOptions, SourceConfig } from './types';
import { recordMetrics } from './monitoring';
import { translate } from '@vitalets/google-translate-api';

/** newsnow API 响应格式 */
interface NewsnowApiItem {
  id?: string;
  title?: string;
  url?: string;
  extra?: {
    value?: string;
    icon?: { url?: string; scale?: number };
  };
  desc?: string;
}

interface NewsnowApiResponse {
  status?: string;
  id?: string;
  updatedTime?: number;
  items?: NewsnowApiItem[];
}

export class NewsnowSource implements NewsSource {
  id: string;
  name: string;
  enabled: boolean;
  private baseUrl: string;
  private platforms: string[];
  private timeout: number;

  // 默认预设平台列表（兜底）
  private static readonly DEFAULT_PRESETS = {
    brief: ['weibo', 'zhihu', 'github', 'baidu'],
    full: ['weibo', 'zhihu', 'baidu', 'douyin', 'toutiao', 'coolapk', 'wallstreetcn', '36kr', 'sspai', 'github', 'v2ex', 'juejin', 'ithome', 'zaobao', 'bilibili'],
  };

  constructor(config: SourceConfig, presets?: { brief?: string[]; full?: string[] }) {
    this.id = config.id;
    this.name = config.name;
    this.enabled = config.enabled;
    this.baseUrl = (config.config.baseUrl as string) || 'https://api.newsnow.cn';
    
    // 平台列表优先级：显式配置 platforms > preset（从配置/默认） > 默认brief
    if (config.config.platforms && Array.isArray(config.config.platforms)) {
      this.platforms = config.config.platforms;
    } else {
      const preset = (config.config.preset as 'brief' | 'full') || 'brief';
      // 优先使用配置文件的 presets，没有则使用代码默认值
      const availablePresets = presets || NewsnowSource.DEFAULT_PRESETS;
      this.platforms = (preset === 'brief' ? availablePresets.brief : availablePresets.full) || NewsnowSource.DEFAULT_PRESETS.brief;
    }
    
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
          console.error(`[newsnow] ${platform} fetch failed:`, err);
          // 超时错误向上抛出，让调用方感知
          if (err instanceof Error && err.message === '请求超时') {
            throw err;
          }
        }
      }

      // 翻译英文描述
      await this.translateDescriptions(results);

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
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': this.baseUrl,
        },
      });
      clearTimeout(timeoutId);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = (await res.json()) as NewsnowApiResponse;
      const rawItems = data.items || [];
      const items = rawItems.slice(0, topN).map((item: NewsnowApiItem, idx: number) => ({
        platform: this.getPlatformName(platform),
        title: item.title || item.id || '',
        url: item.url || '',
        rank: idx + 1,
        hotValue: item.extra?.value || item.extra?.info || '',
        description: item.desc || item.extra?.hover || '',
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

  private getPlatformName(id: string): string {
    const map: Record<string, string> = {
      weibo: '微博',
      zhihu: '知乎',
      baidu: '百度',
      douyin: '抖音',
      toutiao: '今日头条',
      coolapk: '酷安',
      wallstreetcn: '华尔街见闻',
      '36kr': '36氪',
      sspai: '少数派',
      github: 'GitHub',
      v2ex: 'V2EX',
      juejin: '掘金',
      ithome: 'IT之家',
      zaobao: '前端早报',
      bilibili: 'B站',
    };
    return map[id] || id;
  }

  /** 翻译英文描述为中文 */
  private async translateDescriptions(items: NewsItem[]): Promise<void> {
    const needTranslate = items.filter(
      (item) => item.description && this.isEnglish(item.description)
    );

    if (needTranslate.length === 0) return;

    // 批量翻译（避免单条翻译太慢）
    const results = await Promise.allSettled(
      needTranslate.map((item) => this.translateText(item.description!))
    );

    for (let i = 0; i < needTranslate.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled' && result.value) {
        needTranslate[i].description = result.value;
      }
      // 翻译失败则保持原文
    }
  }

  /** 判断是否为英文文本 */
  private isEnglish(text: string): boolean {
    // 简单判断：英文字符占比 > 50%
    const englishChars = text.match(/[a-zA-Z]/g)?.length || 0;
    const totalChars = text.replace(/\s/g, '').length;
    return totalChars > 0 && englishChars / totalChars > 0.5;
  }

  /** 翻译单条文本 */
  private async translateText(text: string): Promise<string> {
    try {
      const result = await translate(text, { to: 'zh-CN' });
      return result.text;
    } catch (err) {
      console.warn(`[newsnow] translate failed:`, err);
      return text; // 翻译失败返回原文
    }
  }
}
