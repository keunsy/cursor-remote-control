import type { NewsSource, NewsItem, FetchOptions, SourceConfig } from './types';

/**
 * Mock 数据源 - 用于演示和测试
 * 返回固定的测试数据，无需网络请求
 */
export class MockNewsSource implements NewsSource {
  id: string;
  name: string;
  enabled: boolean;

  constructor(config: SourceConfig) {
    this.id = config.id;
    this.name = config.name;
    this.enabled = config.enabled;
  }

  async fetch(options: FetchOptions): Promise<NewsItem[]> {
    // 模拟网络延迟
    await new Promise(resolve => setTimeout(resolve, 200));

    const allItems: NewsItem[] = [
      // 微博热搜
      {
        platform: '微博',
        title: 'OpenAI 发布 GPT-5 模型',
        url: 'https://weibo.com/mock/1',
        rank: 1,
        hotValue: '2345万',
        description: 'OpenAI 今日发布最新一代语言模型 GPT-5，性能提升显著，引发全球关注。',
        timestamp: Date.now(),
      },
      {
        platform: '微博',
        title: '国产芯片突破3纳米工艺',
        url: 'https://weibo.com/mock/2',
        rank: 2,
        hotValue: '1876万',
        description: '某国产芯片厂商宣布成功突破3纳米制程工艺，打破国际技术封锁。',
        timestamp: Date.now(),
      },
      {
        platform: '微博',
        title: '某城市发布人才引进新政',
        url: 'https://weibo.com/mock/3',
        rank: 3,
        hotValue: '1432万',
        description: '该城市推出史上最优惠人才政策，本科生落户即给补贴10万元。',
        timestamp: Date.now(),
      },
      // 知乎热榜
      {
        platform: '知乎',
        title: '如何评价最新的量子计算突破？',
        url: 'https://zhihu.com/mock/1',
        rank: 1,
        hotValue: '987万热度',
        description: '中国科学家实现100量子比特纠缠态，创世界纪录。',
        timestamp: Date.now(),
      },
      {
        platform: '知乎',
        title: '程序员35岁真的是职业瓶颈吗？',
        url: 'https://zhihu.com/mock/2',
        rank: 2,
        hotValue: '765万热度',
        description: '业内人士深度分析程序员职业发展路径，35岁真的是分水岭吗？',
        timestamp: Date.now(),
      },
      // 百度热搜
      {
        platform: '百度',
        title: '今日油价调整',
        url: 'https://baidu.com/mock/1',
        rank: 1,
        hotValue: '543万搜索',
        description: '国内油价迎来新一轮调整，92号汽油下调0.15元/升。',
        timestamp: Date.now(),
      },
      {
        platform: '百度',
        title: '春节假期安排发布',
        url: 'https://baidu.com/mock/2',
        rank: 2,
        hotValue: '432万搜索',
        description: '国务院办公厅发布春节假期安排通知，共放假7天。',
        timestamp: Date.now(),
      },
      // 抖音热点
      {
        platform: '抖音',
        title: '某网红直播间销售额破亿',
        url: 'https://douyin.com/mock/1',
        rank: 1,
        hotValue: '654万观看',
        description: '某知名网红直播间创下单场销售额破亿纪录，带货能力惊人。',
        timestamp: Date.now(),
      },
      {
        platform: '抖音',
        title: '全国最美春景评选',
        url: 'https://douyin.com/mock/2',
        rank: 2,
        hotValue: '543万观看',
        description: '抖音发起全国最美春景评选活动，网友纷纷晒出家乡美景。',
        timestamp: Date.now(),
      },
      // 今日头条
      {
        platform: '今日头条',
        title: '某省推出房地产新政',
        url: 'https://toutiao.com/mock/1',
        rank: 1,
        hotValue: '876万阅读',
        description: '该省发布房地产调控新政策，首套房首付比例降至20%。',
        timestamp: Date.now(),
      },
    ];

    // 尊重 topN 限制
    const topN = options.topN || 10;
    return allItems.slice(0, topN);
  }
}
