/**
 * 新闻数据源监控：记录抓取指标，提供健康状态
 * 使用内存存储，不持久化
 */

export interface FetchMetric {
  sourceId: string;
  timestamp: number;
  success: boolean;
  duration: number;
  itemCount?: number;
  error?: string;
}

const metrics: FetchMetric[] = [];
const MAX_METRICS = 100;
const HEALTH_WINDOW = 20; // 最近 N 次请求用于健康状态计算

/**
 * 记录每次抓取的指标
 */
export function recordMetrics(
  sourceId: string,
  success: boolean,
  duration: number,
  itemCount?: number,
  error?: string
): void {
  const m: FetchMetric = {
    sourceId,
    timestamp: Date.now(),
    success,
    duration,
    itemCount,
    error,
  };
  metrics.push(m);
  if (metrics.length > MAX_METRICS) {
    metrics.shift();
  }

  // 错误率告警
  const recent = metrics.slice(-10);
  const errorRate = recent.filter((x) => !x.success).length / recent.length;
  if (errorRate > 0.5) {
    console.warn(`[monitoring] alert: ${sourceId} error rate ${(errorRate * 100).toFixed(1)}%`);
  }
}

export interface SourceHealthStatus {
  sourceId: string;
  displayName: string;
  successCount: number;
  totalCount: number;
  successRate: number;
  avgDurationMs: number;
  errorCount: number;
  lastError?: string;
}

/**
 * 返回各数据源的健康状态（最近 N 次请求的成功率、平均延迟、错误次数）
 */
export function getHealthStatus(): string {
  if (metrics.length === 0) {
    return '暂无数据';
  }

  const bySource: Record<string, FetchMetric[]> = {};
  for (const m of metrics.slice(-HEALTH_WINDOW)) {
    const sid = m.sourceId;
    let arr = bySource[sid];
    if (!arr) {
      arr = [];
      bySource[sid] = arr;
    }
    arr.push(m);
  }

  const lines = Object.entries(bySource).map(([sourceId, items]) => {
    const successCount = items.filter((x) => x.success).length;
    const total = items.length;
    const successRate = total > 0 ? (successCount / total) * 100 : 0;
    const avgDuration =
      items.reduce((s, x) => s + x.duration, 0) / total;
    const errorCount = items.filter((x) => !x.success).length;
    const lastError = items.filter((x) => !x.success).pop();

    const displayName = getDisplayName(sourceId);
    let status = `✅ **${displayName}**\n`;
    status += `   成功率: ${successRate.toFixed(1)}% (${successCount}/${total})`;
    status += ` | 平均延迟: ${avgDuration.toFixed(0)}ms`;
    status += ` | 错误数: ${errorCount}`;
    if (lastError?.error) {
      status += `\n   ⚠️ 最近错误: ${lastError.error}`;
    }
    return status;
  });

  return lines.join('\n\n');
}

export function getSourceHealthStatuses(): SourceHealthStatus[] {
  if (metrics.length === 0) return [];

  const bySource: Record<string, FetchMetric[]> = {};
  for (const m of metrics.slice(-HEALTH_WINDOW)) {
    const sid = m.sourceId;
    let arr = bySource[sid];
    if (!arr) {
      arr = [];
      bySource[sid] = arr;
    }
    arr.push(m);
  }

  return Object.entries(bySource).map(([sourceId, items]) => {
    const successCount = items.filter((x) => x.success).length;
    const total = items.length;
    const successRate = total > 0 ? (successCount / total) * 100 : 0;
    const avgDuration =
      items.reduce((s, x) => s + x.duration, 0) / total;
    const errorCount = items.filter((x) => !x.success).length;
    const lastError = items.filter((x) => !x.success).pop();

    return {
      sourceId,
      displayName: getDisplayName(sourceId),
      successCount,
      totalCount: total,
      successRate,
      avgDurationMs: avgDuration,
      errorCount,
      lastError: lastError?.error,
    };
  });
}

function getDisplayName(sourceId: string): string {
  const map: Record<string, string> = {
    newsnow: 'NewsNow API',
    rsshub: 'RSSHub',
    'ai-aggregator': 'AI 新闻聚合',
  };
  return map[sourceId] || sourceId;
}

/** 获取原始指标（用于测试） */
export function getMetrics(): FetchMetric[] {
  return [...metrics];
}

/** 清空指标（用于测试） */
export function resetMetrics(): void {
  metrics.length = 0;
}
