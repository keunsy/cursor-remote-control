import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { loadConfig, getEnabledSources } from '../config-loader';
import type { NewsSourcesConfig } from '../types';

const DEFAULT_CONFIG_PATH = 'config/news-sources.json';

const mockConfigContent: NewsSourcesConfig = {
  version: 1,
  defaultTopN: 10,
  sources: [
    {
      id: 'newsnow',
      name: 'NewsNow API',
      enabled: true,
      type: 'newsnow',
      config: {
        baseUrl: 'https://api.newsnow.cn',
        platforms: ['weibo', 'zhihu'],
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
        feeds: ['weibo/search/hot'],
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
  },
};

describe('config-loader', () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('loadConfig', () => {
    test('读取 config/news-sources.json', async () => {
      const config = await loadConfig({
        configPath: DEFAULT_CONFIG_PATH,
        readFile: async () => JSON.stringify(mockConfigContent),
      });

      expect(config.version).toBe(1);
      expect(config.defaultTopN).toBe(10);
      expect(config.sources).toHaveLength(2);
      expect(config.sources[0].id).toBe('newsnow');
      expect(config.sources[0].enabled).toBe(true);
      expect(config.sources[1].id).toBe('rsshub');
      expect(config.sources[1].enabled).toBe(false);
    });

    test('环境变量覆盖 NEWS_SOURCES_NEWSNOW_ENABLED=false', async () => {
      process.env.NEWS_SOURCES_NEWSNOW_ENABLED = 'false';

      const config = await loadConfig({
        configPath: DEFAULT_CONFIG_PATH,
        readFile: async () => JSON.stringify(mockConfigContent),
      });

      const newsnow = config.sources.find((s) => s.id === 'newsnow');
      expect(newsnow?.enabled).toBe(false);
    });

    test('环境变量覆盖 NEWS_SOURCES_NEWSNOW_ENABLED=true', async () => {
      const configWithRsshubDisabled = {
        ...mockConfigContent,
        sources: mockConfigContent.sources.map((s) =>
          s.id === 'rsshub' ? { ...s, enabled: false } : s
        ),
      };

      process.env.NEWS_SOURCES_RSSHUB_ENABLED = 'true';

      const config = await loadConfig({
        configPath: DEFAULT_CONFIG_PATH,
        readFile: async () => JSON.stringify(configWithRsshubDisabled),
      });

      const rsshub = config.sources.find((s) => s.id === 'rsshub');
      expect(rsshub?.enabled).toBe(true);
    });

    test('环境变量覆盖 NEWS_SOURCES_NEWSNOW_APIURL=https://custom.api', async () => {
      process.env.NEWS_SOURCES_NEWSNOW_APIURL = 'https://custom.api';

      const config = await loadConfig({
        configPath: DEFAULT_CONFIG_PATH,
        readFile: async () => JSON.stringify(mockConfigContent),
      });

      const newsnow = config.sources.find((s) => s.id === 'newsnow');
      expect(newsnow?.config.baseUrl).toBe('https://custom.api');
    });

    test('环境变量覆盖 config.baseUrl', async () => {
      process.env.NEWS_SOURCES_NEWSNOW_BASEURL = 'https://my.newsnow.cn';

      const config = await loadConfig({
        configPath: DEFAULT_CONFIG_PATH,
        readFile: async () => JSON.stringify(mockConfigContent),
      });

      const newsnow = config.sources.find((s) => s.id === 'newsnow');
      expect(newsnow?.config.baseUrl).toBe('https://my.newsnow.cn');
    });

    test('文件不存在时使用默认配置', async () => {
      const config = await loadConfig({
        configPath: 'non-existent-path.json',
        readFile: async () => {
          throw new Error('ENOENT');
        },
        fileExists: async () => false,
      });

      expect(config.version).toBe(1);
      expect(config.sources).toHaveLength(2);
      expect(config.sources[0].id).toBe('newsnow');
      expect(config.sources[1].id).toBe('rsshub');
    });
  });

  describe('getEnabledSources', () => {
    test('只返回 enabled=true 的源', () => {
      const enabled = getEnabledSources(mockConfigContent);
      expect(enabled).toHaveLength(1);
      expect(enabled[0].id).toBe('newsnow');
      expect(enabled[0].enabled).toBe(true);
    });

    test('全部启用时返回所有源', () => {
      const allEnabled: NewsSourcesConfig = {
        ...mockConfigContent,
        sources: mockConfigContent.sources.map((s) => ({ ...s, enabled: true })),
      };
      const enabled = getEnabledSources(allEnabled);
      expect(enabled).toHaveLength(2);
    });

    test('全部禁用时返回空数组', () => {
      const allDisabled: NewsSourcesConfig = {
        ...mockConfigContent,
        sources: mockConfigContent.sources.map((s) => ({ ...s, enabled: false })),
      };
      const enabled = getEnabledSources(allDisabled);
      expect(enabled).toHaveLength(0);
    });
  });
});
