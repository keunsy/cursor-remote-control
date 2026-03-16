import { fetchNews } from './shared/news-fetcher';

async function test() {
  console.log('[测试] 开始抓取新闻...');
  
  try {
    const result = await fetchNews({
      platform: 'feishu',
      topN: 5
    });
    
    console.log('\n[结果] 抓取成功:');
    console.log(`  条数: ${result.metadata.itemCount}`);
    console.log(`  来源: ${result.metadata.sourceCount} 个数据源`);
    console.log(`  消息: ${result.messages.length} 条`);
    
    if (result.metadata.errors && result.metadata.errors.length > 0) {
      console.log(`  错误: ${result.metadata.errors.join('; ')}`);
    }
    
    console.log('\n[预览] 消息内容:');
    result.messages.forEach((msg, i) => {
      console.log(`\n--- 消息 ${i + 1} ---`);
      console.log(msg.substring(0, 300) + (msg.length > 300 ? '...' : ''));
    });
    
  } catch (error) {
    console.error('[错误] 抓取失败:', error);
    process.exit(1);
  }
}

test();
