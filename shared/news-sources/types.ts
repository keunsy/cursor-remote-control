/** 新闻源统一接口 */
export interface NewsSource {
  id: string;
  name: string;
  enabled: boolean;
  fetch(options: FetchOptions): Promise<NewsItem[]>;
}

/** 抓取选项 */
export interface FetchOptions {
  topN: number;
  platforms?: string[];
}

/** 标准新闻条目 */
export interface NewsItem {
  platform: string;
  title: string;
  url: string;
  rank?: number;
  hotValue?: string;
  description?: string;
  timestamp?: number;
}

/** 数据源配置 */
export interface SourceConfig {
  id: string;
  name: string;
  enabled: boolean;
  type: string;
  config: Record<string, unknown>;
}

/** 完整配置文件结构 */
export interface NewsSourcesConfig {
  version: number;
  defaultTopN: number;
  presets?: {
    brief?: string[];
    full?: string[];
  };
  sources: SourceConfig[];
  aggregation: {
    deduplicateByUrl: boolean;
    deduplicateByTitle: boolean;
    titleSimilarityThreshold: number;
    sortBy: 'rank' | 'hotValue' | 'time';
  };
  formatting: {
    maxItemsPerPlatform: number;
    includeRank: boolean;
    includeHotValue: boolean;
    includeDescription: boolean;
    descriptionMaxLength: number;
    includeUrl: boolean;
    platformOrder?: string[]; // 平台显示顺序
    platformMaxItems?: Record<string, number>; // 每个平台的最大条数
  };
}
