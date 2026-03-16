import type { NewsItem } from './types';

export interface FormattingConfig {
  maxItemsPerPlatform: number;
  includeRank: boolean;
  includeHotValue: boolean;
  includeDescription: boolean;
  descriptionMaxLength: number;
  includeUrl: boolean;
}

/** 飞书卡片 JSON 估算限制（字节） */
const FEISHU_MAX = 30 * 1024;

/** 钉钉 Markdown 限制（字节） */
const DINGTALK_MAX = 20 * 1024;

/** 按平台分组 */
export function groupByPlatform(items: NewsItem[]): Record<string, NewsItem[]> {
  const grouped: Record<string, NewsItem[]> = {};
  for (const item of items) {
    if (!grouped[item.platform]) {
      grouped[item.platform] = [];
    }
    grouped[item.platform].push(item);
  }
  return grouped;
}

/** 估算飞书卡片 JSON 长度（含 header + markdown body） */
function estimateFeishuCardSize(markdown: string): number {
  const card = {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: '📰 今日热点' } },
    body: { elements: [{ tag: 'markdown', content: markdown }] },
  };
  return new TextEncoder().encode(JSON.stringify(card)).length;
}

/** 估算钉钉消息长度（UTF-8 字节） */
function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** 截断文本 */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

/** 获取排名 emoji */
function getRankEmoji(rank?: number): string {
  if (!rank) return '•';
  if (rank <= 9) return `${rank}️⃣`;
  return '🔟';
}

/** 格式化单个新闻项（Markdown） */
function formatItem(item: NewsItem, config: FormattingConfig): string {
  const emoji = getRankEmoji(item.rank);
  let result = `${emoji} **${item.title}**`;

  if (config.includeHotValue && item.hotValue) {
    result += ` 🔥 ${item.hotValue}`;
  }

  if (config.includeDescription && item.description) {
    const desc = truncate(item.description, config.descriptionMaxLength);
    result += `\n   ${desc}`;
  }

  if (config.includeUrl) {
    result += `\n   [查看详情](${item.url})`;
  }

  return result;
}

/** 格式化平台区块 */
function formatSection(
  platform: string,
  items: NewsItem[],
  config: FormattingConfig
): string {
  const divider = '━'.repeat(15);
  let section = `${divider} ${platform} ${divider}\n`;

  for (const item of items) {
    section += formatItem(item, config) + '\n\n';
  }

  return section;
}

/** 格式化为飞书/钉钉消息（返回 Markdown 分片） */
export function formatNewsCard(
  items: NewsItem[],
  platform: 'feishu' | 'dingtalk',
  config: FormattingConfig
): string[] {
  const maxSize = platform === 'feishu' ? FEISHU_MAX : DINGTALK_MAX;
  const estimateSize = platform === 'feishu' ? estimateFeishuCardSize : (s: string) => byteLength(s);

  if (items.length === 0) {
    const emptyMsg = '📰 **今日热点新闻**\n\n暂无数据。';
    return [emptyMsg];
  }

  const header = `📰 **今日热点新闻** (共 ${items.length} 条)\n\n`;
  const footer = `\n⏱ 更新时间：${new Date().toLocaleString('zh-CN')}\n📊 数据来源：NewsNow API + RSSHub`;

  const grouped = groupByPlatform(items);
  const chunks: string[] = [];
  let currentChunk = header;

  for (const [platformName, news] of Object.entries(grouped)) {
    const section = formatSection(
      platformName,
      news.slice(0, config.maxItemsPerPlatform),
      config
    );

    const candidate = currentChunk + section + footer;
    const size = estimateSize(candidate);

    if (size > maxSize && currentChunk.length > header.length) {
      chunks.push(currentChunk + footer);
      currentChunk = header + section;
    } else {
      currentChunk += section;
    }
  }

  chunks.push(currentChunk + footer);

  // 分片时添加 [Part X/Y] 前缀
  if (chunks.length > 1) {
    return chunks.map((c, i) => `[Part ${i + 1}/${chunks.length}]\n\n${c}`);
  }

  return chunks;
}
