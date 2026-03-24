# 配置目录说明

存放所有服务的共享配置文件。

---

## 📋 文件清单

### 模型配置

| 文件 | 用途 | Git追踪 |
|------|------|---------|
| `model-config.json` | **模型默认配置**（统一四平台） | ✅ 提交 |
| `model-config.example.json` | 示例配置 | ✅ 提交 |
| `model-config.README.md` | 模型配置说明 | ✅ 提交 |

### 新闻源配置

| 文件 | 用途 | Git追踪 | 默认平台数 | 推荐 |
|------|------|---------|-----------|------|
| `news-sources.json` | **生效配置**（私人） | ❌ 不提交 | - | - |
| `news-sources.json.example` | **简要版**（推荐） | ✅ 提交 | 4个 | ⭐⭐⭐ |
| `news-sources.full.json.example` | 完整版 | ✅ 提交 | 15个 | ⭐⭐ |
| `news-sources.advanced.json.example` | 高级版（自定义排序） | ✅ 提交 | 15个 | ⭐ |

---

## 🎯 模型配置（快速开始）

### 查看当前配置

```bash
cat config/model-config.json
```

### 修改默认模型

```json
{
  "defaultModel": "auto",  // 改为 auto（省配额）
  "blacklistResetCron": "0 0 1 * *"
}
```

重启服务生效：

```bash
./manage-services.sh restart
```

**详细说明**: 见 `model-config.README.md` 或 `docs/MODEL-CONFIG-UNIFIED.md`

---

## 📰 新闻源配置（快速开始）

### 首次使用（推荐简要版）

```bash
# 复制简要版（推荐）- 默认4个核心平台
cp config/news-sources.json.example config/news-sources.json

# 或者使用完整版 - 15个平台全开
cp config/news-sources.full.json.example config/news-sources.json

# 或者使用高级版 - 自定义排序和条数
cp config/news-sources.advanced.json.example config/news-sources.json
```

### 版本区别

#### 简要版（推荐）
- **平台**: 微博、知乎、GitHub、百度（4个）
- **配置**: `"preset": "brief"`
- **特点**: 精简高效，只保留核心渠道
- **适合**: 大部分用户日常使用

#### 完整版
- **平台**: 15个全部平台
- **配置**: `"preset": "full"`
- **特点**: 全面覆盖，资讯最丰富
- **适合**: 需要全面了解各领域热点

#### 高级版
- **平台**: 自定义
- **配置**: 使用 `"platforms": [...]` 或 `"platformOrder": [...]`
- **特点**: 完全自定义平台列表、排序和条数
- **适合**: 个性化需求

---

## 📚 详细文档

- **模型配置**: `model-config.README.md` 或 `docs/MODEL-CONFIG-UNIFIED.md`
- **新闻源配置**: `docs/news-platform-config.md`
