import { distance } from 'fastest-levenshtein';
import type { NewsItem } from './types';

/** 按 URL 去重（保留第一个） */
export function deduplicateByUrl(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

/** 计算字符串相似度（基于 Levenshtein 距离，0-1） */
function calculateSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const dist = distance(a, b);
  const maxLen = Math.max(a.length, b.length);
  return 1 - dist / maxLen;
}

/** 按标题相似度去重（相似度 >= threshold 视为重复，保留第一个） */
export function deduplicateByTitle(
  items: NewsItem[],
  threshold = 0.8
): NewsItem[] {
  const result: NewsItem[] = [];

  for (const item of items) {
    const isDuplicate = result.some(
      (existing) => calculateSimilarity(item.title, existing.title) >= threshold
    );
    if (!isDuplicate) {
      result.push(item);
    }
  }

  return result;
}

function parseHotValue(value?: string): number {
  if (!value) return 0;
  const num = parseFloat(value.replace(/[^\d.]/g, ''));
  if (value.includes('万')) return num * 10000;
  if (value.includes('k') || value.includes('K')) return num * 1000;
  return num;
}

/** 排序 */
export function sortItems(
  items: NewsItem[],
  by: 'rank' | 'hotValue' | 'time'
): NewsItem[] {
  return [...items].sort((a, b) => {
    switch (by) {
      case 'rank':
        return (a.rank ?? Infinity) - (b.rank ?? Infinity);
      case 'time':
        return (b.timestamp ?? 0) - (a.timestamp ?? 0);
      case 'hotValue':
        return parseHotValue(b.hotValue) - parseHotValue(a.hotValue);
      default:
        return 0;
    }
  });
}

/** 聚合配置 */
export interface AggregateConfig {
  deduplicateByUrl: boolean;
  deduplicateByTitle: boolean;
  titleSimilarityThreshold: number;
  sortBy: 'rank' | 'hotValue' | 'time';
  topN?: number;
}

/** 完整聚合流程：去重 + 排序 + topN */
export function aggregateNews(
  itemsList: NewsItem[][],
  config: AggregateConfig
): NewsItem[] {
  let items = itemsList.flat();

  if (config.deduplicateByUrl) {
    items = deduplicateByUrl(items);
  }

  if (config.deduplicateByTitle) {
    items = deduplicateByTitle(items, config.titleSimilarityThreshold);
  }

  const sorted = sortItems(items, config.sortBy);

  if (config.topN != null && config.topN > 0) {
    return sorted.slice(0, config.topN);
  }

  return sorted;
}
