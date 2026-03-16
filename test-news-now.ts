#!/usr/bin/env bun
/**
 * 快速测试新闻抓取功能
 */

import { fetchNews } from './shared/news-fetcher';

async function test() {
  console.log('🧪 测试新闻抓取（使用 Mock 数据源）\n');

  try {
    // 测试飞书格式
    console.log('📱 测试飞书平台:');
    const feishuResult = await fetchNews({
      platform: 'feishu',
      topN: 10,
    });

    console.log(`✅ 成功抓取 ${feishuResult.metadata.itemCount} 条新闻`);
    console.log(`📦 来自 ${feishuResult.metadata.sourceCount} 个数据源`);
    console.log(`📨 生成 ${feishuResult.messages.length} 条消息\n`);

    console.log('📄 消息预览:');
    feishuResult.messages.forEach((msg, i) => {
      console.log(`\n--- 消息 ${i + 1}/${feishuResult.messages.length} ---`);
      console.log(msg.substring(0, 500));
      if (msg.length > 500) {
        console.log('...(省略)');
      }
    });

    console.log('\n\n---\n');

    // 测试钉钉格式
    console.log('📱 测试钉钉平台:');
    const dingtalkResult = await fetchNews({
      platform: 'dingtalk',
      topN: 5,
    });

    console.log(`✅ 成功抓取 ${dingtalkResult.metadata.itemCount} 条新闻`);
    console.log(`📦 来自 ${dingtalkResult.metadata.sourceCount} 个数据源`);
    console.log(`📨 生成 ${dingtalkResult.messages.length} 条消息\n`);

    console.log('\n✅ 所有测试通过！');
    console.log('\n💡 功能已就绪，现在可以：');
    console.log('  1️⃣  在飞书/钉钉中发送: /新闻 明天上午10点推送10条热点');
    console.log('  2️⃣  验证回复和任务创建');
    console.log('  3️⃣  发送: /新闻状态 查看健康状况');
    console.log('\n⚠️  当前使用 Mock 数据源（演示用），真实部署时需配置可访问的 API');
  } catch (error) {
    console.error('❌ 测试失败:', error);
    process.exit(1);
  }
}

test();
