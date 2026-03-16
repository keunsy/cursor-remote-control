# 新闻平台配置说明

## 配置文件位置

`config/news-sources.json`（该文件不会被 Git 提交）

## 三种预设版本

| 版本 | 示例文件 | 默认平台数 | 特点 | 推荐度 |
|------|----------|----------|------|--------|
| **简要版** | `news-sources.json.example` | 4个 | 精简高效，可自行增删平台 | ⭐⭐⭐ 推荐 |
| **完整版** | `news-sources.full.json.example` | 15个 | 全部平台，可自行删减 | ⭐⭐ |
| **高级版** | `news-sources.advanced.json.example` | 15个 | 可自定义排序和条数 | ⭐ 进阶 |

### 简要版（默认推荐）

```bash
cp config/news-sources.json.example config/news-sources.json
```

**配置字段**: `"preset": "brief"`  
**包含平台**: 微博、知乎、GitHub、百度（4个）  
**特点**: 关闭了热度值和描述，只显示标题+链接，消息更简洁

### 完整版

```bash
cp config/news-sources.full.json.example config/news-sources.json
```

**配置字段**: `"preset": "full"`  
**包含平台**: 所有 15 个平台  
**特点**: 开启热度值和描述，资讯最全

### 高级版

```bash
cp config/news-sources.advanced.json.example config/news-sources.json
```

**配置字段**: 直接指定 `"platforms": [...]` 数组  
**包含平台**: 完全自定义  
**特点**: 可自定义每个平台的排序和显示条数

## 🔄 快速切换版本

**不需要复制文件！** 只需修改 `config/news-sources.json` 中的 `preset` 字段：

```json
{
  "sources": [{
    "config": {
      "preset": "brief"  // 改成 "full" 即可切换到完整版（15个平台）
    }
  }]
}
```

**切换后需要重启服务**（或等待自动重载）。

## ✏️ 自定义预设平台列表

如果你想修改 `brief` 或 `full` 包含哪些平台，可以修改顶层的 `presets` 配置：

```json
{
  "version": 1,
  "defaultTopN": 10,
  "presets": {
    "brief": ["weibo", "zhihu", "github"],        // 自定义简要版：只要3个
    "full": ["weibo", "zhihu", "v2ex", "juejin"]  // 自定义完整版：只要4个
  },
  "sources": [{
    "config": {
      "preset": "brief"  // 使用自定义的 brief 预设
    }
  }]
}
```

**优势**：
- ✅ 不需要改代码
- ✅ 可以随时修改预设内容
- ✅ 切换版本只需改一个字段

## ⚠️ 重要说明

**配置优先级**：
1. 显式配置 `platforms` 数组 → 使用自定义列表
2. 配置 `preset` 字段 → 使用预设列表（brief/full）
3. 都不配置 → 默认使用 brief

**其他可选配置**：
- 不配置 `platformOrder` → 按数据返回的自然顺序展示
- 不配置 `platformMaxItems` → 所有平台使用统一的 `maxItemsPerPlatform`

## 功能说明

### 1. 平台展示顺序（可选）

通过 `formatting.platformOrder` 配置展示顺序：

```json
{
  "formatting": {
    "platformOrder": [
      "微博",      // 第1个显示
      "知乎",      // 第2个显示
      "GitHub",    // 第3个显示
      ...
    ]
  }
}
```

**规则**：
- 只展示 `platformOrder` 中的平台
- 按数组顺序从上到下展示
- 删除某个平台 = 不展示该平台

### 2. 每个平台显示条数

#### 全局默认

```json
{
  "formatting": {
    "maxItemsPerPlatform": 10  // 所有平台默认显示10条
  }
}
```

#### 单独配置

```json
{
  "formatting": {
    "platformMaxItems": {
      "微博": 5,      // 微博显示5条
      "知乎": 5,      // 知乎显示5条
      "GitHub": 3,    // GitHub显示3条
      "V2EX": 3,      // V2EX显示3条
      "掘金": 3       // 掘金显示3条
      // 其他平台使用 maxItemsPerPlatform 默认值
    }
  }
}
```

## 可用平台列表

| 平台名称 | 类型 | 平均数据量 |
|---------|------|-----------|
| 微博 | 社交 | 30条 |
| 知乎 | 问答 | 20条 |
| GitHub | 开发 | 12条 |
| V2EX | 社区 | 30条 |
| 掘金 | 技术 | 30条 |
| 百度 | 搜索 | 30条 |
| 抖音 | 视频 | 30条 |
| 今日头条 | 资讯 | 30条 |
| B站 | 视频 | 30条 |
| IT之家 | 科技 | 30条 |
| 酷安 | 数码 | 19条 |
| 华尔街见闻 | 财经 | 30条 |
| 36氪 | 创投 | 20条 |
| 少数派 | 效率 | 30条 |
| 前端早报 | 技术 | 30条 |

## 默认配置（推荐）

**最简配置，适合大部分人**：

```json
{
  "formatting": {
    "maxItemsPerPlatform": 5,  // 所有平台统一显示5条
    "includeRank": true,
    "includeHotValue": true,
    "includeDescription": true,
    "descriptionMaxLength": 80,
    "includeUrl": true
  }
}
```

**效果**：
- ✅ 自动展示所有有数据的平台
- ✅ 按平台返回顺序展示
- ✅ 每个平台统一5条

## 高级配置示例

### 场景1：只看技术资讯

```json
{
  "formatting": {
    "platformOrder": ["GitHub", "V2EX", "掘金", "IT之家", "前端早报"],
    "platformMaxItems": {
      "GitHub": 10,
      "V2EX": 10,
      "掘金": 10
    }
  }
}
```

### 场景2：只看主流社交

```json
{
  "formatting": {
    "platformOrder": ["微博", "知乎", "百度", "抖音"],
    "maxItemsPerPlatform": 15
  }
}
```

### 场景3：均衡配置（当前默认）

```json
{
  "formatting": {
    "platformOrder": [
      "微博", "知乎", "GitHub", "V2EX", "掘金",
      "百度", "抖音", "今日头条", "B站", "IT之家",
      "酷安", "华尔街见闻", "36氪", "少数派", "前端早报"
    ],
    "platformMaxItems": {
      "微博": 5,
      "知乎": 5,
      "GitHub": 3,
      "V2EX": 3,
      "掘金": 3
    },
    "maxItemsPerPlatform": 10
  }
}
```

## 修改后生效

修改配置后需要重启服务：

```bash
pkill -9 -f "bun.*feishu"
nohup bun feishu/server.ts > feishu.log 2>&1 &
```

或者发送 `/重启` 命令（如果配置了）。
