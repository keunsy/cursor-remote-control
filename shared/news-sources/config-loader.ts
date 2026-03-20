import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NewsSourcesConfig, SourceConfig } from './types';

// 项目根目录（从当前文件位置向上两级：shared/news-sources -> shared -> root）
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');
const DEFAULT_CONFIG_PATH = resolve(PROJECT_ROOT, 'config/news-sources.json');

/** 默认配置（文件不存在时使用） */
export const DEFAULT_CONFIG: NewsSourcesConfig = {
  version: 1,
  defaultTopN: 10,
  sources: [
    {
      id: 'newsnow',
      name: 'NewsNow API',
      enabled: true,
      type: 'newsnow',
      config: {
        baseUrl: 'https://newsnow.busiyi.world', // 默认使用 busiyi.world
        preset: 'brief', // 使用 preset 而不是显式 platforms
        timeout: 10000,
      },
    },
    {
      id: 'rsshub',
      name: 'RSSHub',
      enabled: false,
      type: 'rsshub',
      config: {
        baseUrl: 'https://rsshub.app',
        feeds: ['weibo/search/hot', 'zhihu/hotlist', 'baidu/trending'],
        timeout: 15000,
      },
    },
  ],
  aggregation: {
    deduplicateByUrl: true,
    deduplicateByTitle: true,
    titleSimilarityThreshold: 0.85,
    sortBy: 'rank',
  },
  formatting: {
    maxItemsPerPlatform: 10,
    includeRank: true,
    includeHotValue: true,
    includeDescription: true,
    descriptionMaxLength: 80,
    includeUrl: true,
    useEnhancedStyle: true, // 使用增强样式（新样式）。设为 false 使用旧样式（emoji 标题）
  },
};

export interface LoadConfigOptions {
  /** 配置文件路径，默认 config/news-sources.json */
  configPath?: string;
  /** 读取文件内容（用于测试 mock） */
  readFile?: (path: string) => Promise<string>;
  /** 检查文件是否存在（用于测试 mock） */
  fileExists?: (path: string) => Promise<boolean>;
}

/** 解析布尔环境变量 */
function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const lower = value.toLowerCase();
  if (lower === 'true' || lower === '1') return true;
  if (lower === 'false' || lower === '0') return false;
  return undefined;
}

/** 应用环境变量覆盖：NEWS_SOURCES_{SOURCE_ID}_{FIELD} */
function applyEnvOverrides(config: NewsSourcesConfig): NewsSourcesConfig {
  const result = JSON.parse(JSON.stringify(config)) as NewsSourcesConfig;
  const prefix = 'NEWS_SOURCES_';

  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(prefix) || value === undefined) continue;

    const suffix = key.slice(prefix.length);
    const parts = suffix.split('_');
    if (parts.length < 2) continue;

    const head = parts[0];
    if (head === undefined) continue;
    const sourceId = head.toLowerCase();
    const field = parts.slice(1).join('_').toUpperCase();

    const source = result.sources.find((s) => s.id.toLowerCase() === sourceId);
    if (!source) continue;

    if (field === 'ENABLED') {
      const parsed = parseBool(value);
      if (parsed !== undefined) source.enabled = parsed;
    } else if (field === 'APIURL' || field === 'BASEURL') {
      source.config = { ...source.config, baseUrl: value };
    } else if (field === 'TIMEOUT') {
      const num = parseInt(value, 10);
      if (!Number.isNaN(num)) source.config = { ...source.config, timeout: num };
    }
  }

  return result;
}

/** 加载配置（支持环境变量覆盖） */
export async function loadConfig(options?: LoadConfigOptions): Promise<NewsSourcesConfig> {
  const configPath =
    options?.configPath ?? process.env.NEWS_SOURCES_CONFIG ?? DEFAULT_CONFIG_PATH;

  const fileExists = options?.fileExists ?? (async (p: string) => (await Bun.file(p).exists()));
  const readFile =
    options?.readFile ??
    (async (p: string) => {
      const file = Bun.file(p);
      return await file.text();
    });

  const exists = await fileExists(configPath);
  if (!exists) {
    console.log(`[config-loader] 配置文件不存在 (${configPath}), 使用 DEFAULT_CONFIG`);
    return applyEnvOverrides(DEFAULT_CONFIG);
  }

  console.log(`[config-loader] 加载配置文件: ${configPath}`);
  const raw = await readFile(configPath);
  const config = JSON.parse(raw) as NewsSourcesConfig;
  console.log(`[config-loader] 配置文件中的 presets: ${JSON.stringify(config.presets)}`);
  return applyEnvOverrides(config);
}

/** 获取已启用的源 */
export function getEnabledSources(config: NewsSourcesConfig): SourceConfig[] {
  return config.sources.filter((s) => s.enabled);
}
