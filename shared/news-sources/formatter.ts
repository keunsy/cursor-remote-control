import type { NewsItem } from './types';

export interface FormattingConfig {
  maxItemsPerPlatform: number;
  includeRank: boolean;
  includeHotValue: boolean;
  includeDescription: boolean;
  descriptionMaxLength: number;
  includeUrl: boolean;
  platformOrder?: string[];
  platformMaxItems?: Record<string, number>;
  useEnhancedStyle?: boolean;
  /** 平台分组：key 为分组标题，value 为属于该分组的平台列表 */
  platformGroups?: Record<string, string[]>;
}

/** 飞书卡片 JSON 估算限制（字节） */
const FEISHU_MAX = 30 * 1024;

/** 钉钉 Markdown 限制（字节） */
const DINGTALK_MAX = 20 * 1024;

/** 按平台分组 */
export function groupByPlatform(items: NewsItem[]): Record<string, NewsItem[]> {
  const grouped: Record<string, NewsItem[]> = {};
  for (const item of items) {
    const plat = item.platform;
    let bucket = grouped[plat];
    if (!bucket) {
      bucket = [];
      grouped[plat] = bucket;
    }
    bucket.push(item);
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

/** 获取排名标记（支持 emoji 和数字格式） */
function getRankPrefix(rank?: number, useEnhancedStyle?: boolean): string {
  if (!rank) return useEnhancedStyle ? '**▪️**' : '▪️';
  
  if (useEnhancedStyle) {
    return `**${rank}.**`;
  }
  
  const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
  return emojis[rank - 1] || '▪️';
}

/** 格式化单个新闻项（Markdown） */
function formatItem(item: NewsItem, config: FormattingConfig): string {
  const useEnhanced = config.useEnhancedStyle ?? true;
  const rankPrefix = getRankPrefix(item.rank, useEnhanced);
  
  // 标题行
  if (useEnhanced) {
    // 新样式：**1.** 标题 · 🔥 123.4万热
    let result = `${rankPrefix} ${item.title}`;
    if (config.includeHotValue && item.hotValue) {
      result += ` · 🔥 ${item.hotValue}热`;
    }

    // 描述（引用样式，移除斜体）
    if (config.includeDescription && item.description) {
      const desc = truncate(item.description, config.descriptionMaxLength);
      result += `\n> ${desc}`;
    }

    // 链接（简化格式）
    if (config.includeUrl) {
      result += `\n[→ 查看原文](${item.url})`;
    }

    return result;
  } else {
    // 旧样式：1️⃣ **标题** 🔥 `123.4万`
    let result = `${rankPrefix} **${item.title}**`;
    if (config.includeHotValue && item.hotValue) {
      result += ` 🔥 \`${item.hotValue}\``;
    }

    // 描述（引用样式 + 斜体）
    if (config.includeDescription && item.description) {
      const desc = truncate(item.description, config.descriptionMaxLength);
      result += `\n  > *${desc}*`;
    }

    // 链接
    if (config.includeUrl) {
      result += `\n  🔗 [查看原文](${item.url})`;
    }

    return result;
  }
}

/** 格式化平台区块 */
function formatSection(
  platform: string,
  items: NewsItem[],
  config: FormattingConfig
): string {
  const useEnhanced = config.useEnhancedStyle ?? true;
  
  let section = '';
  
  if (useEnhanced) {
    // 新样式：添加分隔线
    section = `\n━━━━━━━━━━━━━━━━━━━━━━\n## 🌟 ${platform}\n\n`;
  } else {
    // 旧样式
    section = `\n## 📌 ${platform}\n\n`;
  }

  for (const item of items) {
    section += formatItem(item, config) + '\n\n';
  }

  return section;
}

/** 格式化为飞书/钉钉/企业微信消息（返回 Markdown 分片） */
export function formatNewsCard(
  items: NewsItem[],
  platform: 'feishu' | 'dingtalk' | 'wecom' | 'wechat',
  config: FormattingConfig
): string[] {
  const maxSize =
    platform === 'feishu' ? FEISHU_MAX : platform === 'wecom' || platform === 'wechat' ? DINGTALK_MAX : DINGTALK_MAX;
  const estimateSize = platform === 'feishu' ? estimateFeishuCardSize : (s: string) => byteLength(s);

  if (items.length === 0) {
    const emptyMsg = '📰 **今日热点新闻**\n\n暂无数据。';
    return [emptyMsg];
  }

  const header = `# 📰 今日热点新闻\n\n📊 共 ${items.length} 条热点  |  ⏱ ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n`;
  const footer = `\n---\n💡 数据来源：NewsNow + AI 新闻聚合`;

  const grouped = groupByPlatform(items);
  const chunks: string[] = [];
  let currentChunk = header;

  const platformOrder = config.platformOrder || Object.keys(grouped);
  const platformsToShow = platformOrder.filter(p => grouped[p]);

  const groups = config.platformGroups;
  const renderedGroupHeaders = new Set<string>();

  for (const platformName of platformsToShow) {
    const news = grouped[platformName];
    if (!news || news.length === 0) continue;
    const maxItems = config.platformMaxItems?.[platformName] ?? config.maxItemsPerPlatform;

    let groupHeader = '';
    if (groups) {
      for (const [groupTitle, members] of Object.entries(groups)) {
        if (members.includes(platformName) && !renderedGroupHeaders.has(groupTitle)) {
          renderedGroupHeaders.add(groupTitle);
          groupHeader = `\n${'═'.repeat(22)}\n# ${groupTitle}\n`;
          break;
        }
      }
    }

    const section = formatSection(
      platformName,
      news.slice(0, maxItems),
      config
    );

    const candidate = currentChunk + groupHeader + section + footer;
    const size = estimateSize(candidate);

    if (size > maxSize && currentChunk.length > header.length) {
      chunks.push(currentChunk + footer);
      currentChunk = header + groupHeader + section;
    } else {
      currentChunk += groupHeader + section;
    }
  }

  chunks.push(currentChunk + footer);

  // 分片时添加 [Part X/Y] 前缀
  if (chunks.length > 1) {
    return chunks.map((c, i) => `[Part ${i + 1}/${chunks.length}]\n\n${c}`);
  }

  return chunks;
}
