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
    this.baseUrl = (config.config.baseUrl as string) || 'https://newsnow.busiyi.world';
    console.log(`[newsnow] baseUrl: ${this.baseUrl} (from config: ${config.config.baseUrl || 'undefined'})`);
    
    // 平台列表优先级：显式配置 platforms > preset（从配置/默认） > 默认brief
    if (config.config.platforms && Array.isArray(config.config.platforms)) {
      this.platforms = config.config.platforms;
      console.log(`[newsnow] 使用显式配置的平台列表: ${this.platforms.join(', ')}`);
    } else {
      const preset = (config.config.preset as 'brief' | 'full') || 'brief';
      // 优先使用配置文件的 presets，没有则使用代码默认值
      const availablePresets = presets || NewsnowSource.DEFAULT_PRESETS;
      this.platforms = (preset === 'brief' ? availablePresets.brief : availablePresets.full) || NewsnowSource.DEFAULT_PRESETS.brief;
      console.log(`[newsnow] 使用 preset="${preset}", presets=${presets ? 'from config' : 'default'}, platforms: ${this.platforms.join(', ')}`);
    }
    
    this.timeout = (config.config.timeout as number) ?? 5000;
  }

  async fetch(options: FetchOptions): Promise<NewsItem[]> {
    const start = Date.now();
    const targetPlatforms = options.platforms || this.platforms;
    const results: NewsItem[] = [];

    try {
      // 并行请求所有平台，避免串行累积超时时间
      const platformResults = await Promise.allSettled(
        targetPlatforms.map((platform) => this.fetchPlatform(platform, options.topN))
      );

      for (const [idx, result] of platformResults.entries()) {
        if (result.status === 'fulfilled') {
          results.push(...result.value);
        } else {
          console.error(`[newsnow] ${targetPlatforms[idx]} fetch failed:`, result.reason);
        }
      }

      // 如果所有平台都失败，抛出错误
      if (results.length === 0) {
        throw new Error(`所有平台请求失败（${targetPlatforms.join(', ')}）`);
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
      ifeng: '凤凰网',
      hackernews: 'Hacker News',
      producthunt: 'Product Hunt',
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

  /** 翻译单条文本（Google Translate API + DeepLX 备用） */
  private async translateText(text: string): Promise<string> {
    // 方案 1: Google Translate API（稳定可靠）
    try {
      const result = await translate(text, { from: 'en', to: 'zh-CN' });
      if (result.text) {
        return result.text;
      }
    } catch (err) {
      console.warn(`[newsnow] Google Translate failed, fallback to DeepLX:`, err);
    }

    // 方案 2: DeepLX 备用（降级方案）
    try {
      const response = await fetch('https://deeplx.mingming.dev/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: text,
          source_lang: 'EN',
          target_lang: 'ZH',
        }),
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const data = await response.json() as { code: number; data?: string; message?: string };
      if (data.code === 200 && data.data) {
        return data.data;
      }
      
      throw new Error(data.message || 'Translation failed');
    } catch (err) {
      console.warn(`[newsnow] All translation methods failed:`, err);
      return text; // 最终降级：返回原文
    }
  }
}
