#!/usr/bin/env bun
/**
 * 使用 Mock 数据测试新闻推送完整流程
 */

import type { NewsSource, NewsItem, FetchOptions } from './shared/news-sources/types';
import { fetchNews } from './shared/news-fetcher';
import { getHealthStatus } from './shared/news-sources/monitoring';

// Mock 数据源
class MockNewsSource implements NewsSource {
  id: string;
  name: string;
  enabled: boolean;

  constructor(id: string, name: string, items: NewsItem[]) {
    this.id = id;
    this.name = name;
    this.enabled = true;
    this.mockItems = items;
  }

  private mockItems: NewsItem[];

  async fetch(_options: FetchOptions): Promise<NewsItem[]> {
    // 模拟网络延迟
    await new Promise(resolve => setTimeout(resolve, 100));
    return this.mockItems;
  }
}

// 准备测试数据
const mockWeiboNews: NewsItem[] = [
  {
    platform: '微博',
    title: '某明星官宣结婚',
    url: 'https://weibo.com/1',
    rank: 1,
    hotValue: '1234万',
    description: '今日上午，某知名明星通过社交媒体官宣结婚喜讯，引发网友热议...',
    timestamp: Date.now(),
  },
  {
    platform: '微博',
    title: '国产大飞机交付',
    url: 'https://weibo.com/2',
    rank: 2,
    hotValue: '987万',
    description: '国产大飞机正式交付，标志着中国航空工业取得重大突破...',
    timestamp: Date.now(),
  },
  {
    platform: '微博',
    title: '某地发布暴雨预警',
    url: 'https://weibo.com/3',
    rank: 3,
    hotValue: '654万',
    description: '气象台发布暴雨橙色预警，提醒市民注意防范...',
    timestamp: Date.now(),
  },
];

const mockZhihuNews: NewsItem[] = [
  {
    platform: '知乎',
    title: 'AI 技术最新突破',
    url: 'https://zhihu.com/1',
    rank: 1,
    hotValue: '543万热度',
    description: '研究人员发布新一代 AI 模型，性能提升显著...',
    timestamp: Date.now(),
  },
  {
    platform: '知乎',
    title: '如何看待某公司裁员',
    url: 'https://zhihu.com/2',
    rank: 2,
    hotValue: '432万热度',
    description: '某科技公司宣布裁员计划，引发行业讨论...',
    timestamp: Date.now(),
  },
];

async function testFullPipeline() {
  console.log('🧪 测试新闻推送完整流程（使用 Mock 数据）\n');

  // 创建 mock 数据源
  const mockSources: NewsSource[] = [
    new MockNewsSource('mock-weibo', '微博热搜（Mock）', mockWeiboNews),
    new MockNewsSource('mock-zhihu', '知乎热榜（Mock）', mockZhihuNews),
  ];

  // 测试飞书格式
  console.log('📱 测试 1: 飞书平台消息格式');
  console.log('-------------------------------------------');
  try {
    const result = await fetchNews({
      platform: 'feishu',
      topN: 10,
      sources: mockSources,
    });

    console.log('✅ 抓取成功:');
    console.log(`  📊 总条数: ${result.metadata.itemCount}`);
    console.log(`  📦 数据源: ${result.metadata.sourceCount} 个`);
    console.log(`  📨 消息数: ${result.messages.length} 条`);

    if (result.metadata.errors && result.metadata.errors.length > 0) {
      console.log(`  ⚠️  错误: ${result.metadata.errors.join('; ')}`);
    }

    console.log('\n[预览] 飞书消息:');
    result.messages.forEach((msg, i) => {
      console.log(`\n--- 消息 ${i + 1} ---`);
      const preview = msg.substring(0, 400);
      console.log(preview + (msg.length > 400 ? '\n...' : ''));
    });
  } catch (error) {
    console.error('❌ 飞书测试失败:', error);
    process.exit(1);
  }

  console.log('\n');

  // 测试钉钉格式
  console.log('📱 测试 2: 钉钉平台消息格式');
  console.log('-------------------------------------------');
  try {
    const result = await fetchNews({
      platform: 'dingtalk',
      topN: 10,
      sources: mockSources,
    });

    console.log('✅ 抓取成功:');
    console.log(`  📊 总条数: ${result.metadata.itemCount}`);
    console.log(`  📦 数据源: ${result.metadata.sourceCount} 个`);
    console.log(`  📨 消息数: ${result.messages.length} 条`);

    console.log('\n[预览] 钉钉消息:');
    result.messages.forEach((msg, i) => {
      console.log(`\n--- 消息 ${i + 1} ---`);
      const preview = msg.substring(0, 400);
      console.log(preview + (msg.length > 400 ? '\n...' : ''));
    });
  } catch (error) {
    console.error('❌ 钉钉测试失败:', error);
    process.exit(1);
  }

  console.log('\n');

  // 测试健康状态
  console.log('📊 测试 3: 健康状态监控');
  console.log('-------------------------------------------');
  console.log(getHealthStatus());

  console.log('\n');
  console.log('✅ 所有测试通过！');
  console.log('');
  console.log('💡 下一步：');
  console.log('  1. 在飞书/钉钉中发送: /新闻 明天上午10点推送10条热点');
  console.log('  2. 验证任务创建: cat cron-jobs-feishu.json');
  console.log('  3. 查看健康状态: /新闻状态');
  console.log('');
  console.log('⚠️  注意: 真实 API (newsnow/rsshub) 当前网络不可达，');
  console.log('  建议在可访问这些服务的网络环境中测试，或配置代理。');
}

testFullPipeline();
