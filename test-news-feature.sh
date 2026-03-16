#!/bin/bash
# 新闻推送功能测试脚本

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "🧪 测试新闻推送功能"
echo ""

# ========================================
# 1. 测试 fetchNews 核心功能
# ========================================
echo "📰 测试 1: 直接调用 fetchNews 抓取新闻"
echo "-------------------------------------------"

cat > "$PROJECT_ROOT/test-fetch-news-temp.ts" << 'EOF'
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
EOF

cd "$PROJECT_ROOT"
bun run test-fetch-news-temp.ts

echo ""
echo "✅ 测试 1 完成"
echo ""

# ========================================
# 2. 测试监控模块
# ========================================
echo "📊 测试 2: 查看健康状态"
echo "-------------------------------------------"

cat > "$PROJECT_ROOT/test-health-temp.ts" << 'EOF'
import { getHealthStatus, getSourceHealthStatuses } from './shared/news-sources/monitoring';

console.log('[健康状态]');
console.log(getHealthStatus());

console.log('\n[结构化数据]');
const statuses = getSourceHealthStatuses();
for (const [sourceId, status] of Object.entries(statuses)) {
  console.log(`  ${sourceId}: 成功率 ${status.successRate}%, 平均延迟 ${status.avgDuration}ms`);
}
EOF

cd "$PROJECT_ROOT"
bun run test-health-temp.ts

echo ""
echo "✅ 测试 2 完成"
echo ""

# ========================================
# 3. 测试配置加载
# ========================================
echo "⚙️  测试 3: 配置加载"
echo "-------------------------------------------"

cat > "$PROJECT_ROOT/test-config-temp.ts" << 'EOF'
import { loadConfig, getEnabledSources } from './shared/news-sources/config-loader';

console.log('[配置加载]');
const config = loadConfig();
console.log(`  版本: ${config.version}`);
console.log(`  默认 topN: ${config.defaultTopN}`);
console.log(`  数据源: ${config.sources.length} 个`);

console.log('\n[启用的数据源]');
const enabled = getEnabledSources(config);
enabled.forEach(source => {
  console.log(`  ✓ ${source.id} (${source.name})`);
});

const disabled = config.sources.filter(s => !s.enabled);
disabled.forEach(source => {
  console.log(`  ✗ ${source.id} (${source.name})`);
});
EOF

cd "$PROJECT_ROOT"
bun run test-config-temp.ts

echo ""
echo "✅ 测试 3 完成"
echo ""

# ========================================
# 4. 清理临时文件
# ========================================
rm -f "$PROJECT_ROOT/test-fetch-news-temp.ts" "$PROJECT_ROOT/test-health-temp.ts" "$PROJECT_ROOT/test-config-temp.ts"

echo "✅ 所有自动化测试完成！"
echo ""
echo "📱 下一步：在飞书/钉钉中手动测试"
echo "-------------------------------------------"
echo "1. 发送: /新闻 明天上午10点推送10条热点"
echo "2. 验证: 检查回复文案是否正确"
echo "3. 验证: cat cron-jobs-feishu.json (或 cron-jobs-dingtalk.json)"
echo "4. 发送: /新闻状态"
echo "5. 验证: 查看数据源健康状态"
echo ""
