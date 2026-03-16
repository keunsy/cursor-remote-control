import { describe, test, expect, beforeEach } from 'bun:test';
import {
  recordMetrics,
  getHealthStatus,
  getSourceHealthStatuses,
  getMetrics,
  resetMetrics,
} from '../monitoring';

describe('monitoring', () => {
  beforeEach(() => {
    resetMetrics();
  });

  test('recordMetrics 应记录指标', () => {
    recordMetrics('newsnow', true, 150, 10);
    const metrics = getMetrics();
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      sourceId: 'newsnow',
      success: true,
      duration: 150,
      itemCount: 10,
    });
  });

  test('recordMetrics 应支持可选参数', () => {
    recordMetrics('rsshub', false, 500, undefined, '请求超时');
    const metrics = getMetrics();
    expect(metrics[0]).toMatchObject({
      sourceId: 'rsshub',
      success: false,
      duration: 500,
      error: '请求超时',
    });
  });

  test('getHealthStatus 无数据时返回提示', () => {
    expect(getHealthStatus()).toBe('暂无数据');
  });

  test('getHealthStatus 有数据时返回健康状态', () => {
    recordMetrics('newsnow', true, 100, 5);
    recordMetrics('newsnow', true, 200, 8);
    recordMetrics('newsnow', false, 50, 0, 'HTTP 500');

    const status = getHealthStatus();
    expect(status).toContain('NewsNow API');
    expect(status).toContain('成功率');
    expect(status).toContain('平均延迟');
    expect(status).toContain('错误数');
  });

  test('getSourceHealthStatuses 返回结构化数据', () => {
    recordMetrics('newsnow', true, 100, 5);
    recordMetrics('newsnow', true, 200, 8);
    recordMetrics('rsshub', false, 500, 0, '超时');

    const statuses = getSourceHealthStatuses();
    expect(statuses).toHaveLength(2);

    const newsnow = statuses.find((s) => s.sourceId === 'newsnow');
    expect(newsnow).toBeDefined();
    expect(newsnow!.successCount).toBe(2);
    expect(newsnow!.totalCount).toBe(2);
    expect(newsnow!.successRate).toBe(100);
    expect(newsnow!.errorCount).toBe(0);

    const rsshub = statuses.find((s) => s.sourceId === 'rsshub');
    expect(rsshub).toBeDefined();
    expect(rsshub!.successCount).toBe(0);
    expect(rsshub!.successRate).toBe(0);
    expect(rsshub!.lastError).toBe('超时');
  });

  test('getMetrics 返回副本', () => {
    recordMetrics('newsnow', true, 100, 5);
    const m1 = getMetrics();
    const m2 = getMetrics();
    expect(m1).not.toBe(m2);
    expect(m1).toEqual(m2);
  });
});
