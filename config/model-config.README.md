# 模型配置说明

## 📄 config/model-config.json

统一配置所有平台（飞书、钉钉、企业微信、微信个人号）的 AI 模型。

**完全可配置化** — 所有模型定义、别名、fallback 链都在这个配置文件中！

---

## 📝 配置项

```json
{
  "defaultModel": "opus-4.6",           // 默认使用的模型
  "blacklistResetCron": "0 0 1 * *",    // 黑名单重置时间（每月1号）
  "models": [                            // 可用模型列表
    {
      "id": "opus-4.6",
      "name": "Claude Opus 4.6",
      "description": "最强模型（推荐）",
      "aliases": ["opus", "opus46"],
      "fallbackChain": ["opus-4.6-thinking", "auto"],
      "recommended": true
    }
    // ... 更多模型
  ]
}
```

### defaultModel

**可选值**：
- `opus-4.6` — 最强模型（推荐）
- `opus-4.6-thinking` — 长思考链版本
- `auto` — 自动选择（兜底模型）

### blacklistResetCron

**Cron 表达式**，用于自动清空模型黑名单。

**示例**：
- `0 0 1 * *` — 每月1号 00:00
- `0 0 * * 0` — 每周日 00:00
- `0 0 15 * *` — 每月15号 00:00

### models

**模型列表**，定义所有可用的 AI 模型及其配置。

**字段说明**：
- `id` — 模型唯一标识（传递给 Cursor CLI）
- `name` — 显示名称
- `description` — 简短描述
- `aliases` — 缩略名称列表（用于快速切换）
- `fallbackChain` — 失败后的 fallback 顺序
- `recommended` — 是否推荐（影响列表排序）
- `note` — 额外说明

**示例：添加新模型**

```json
{
  "models": [
    {
      "id": "sonnet-4",
      "name": "Claude Sonnet 4",
      "description": "均衡性能模型",
      "aliases": ["sonnet", "s4"],
      "fallbackChain": ["auto"],
      "note": "性价比高"
    }
    // ... 其他模型
  ]
}
```

---

## 🚀 使用方式

### 修改默认模型

编辑 `config/model-config.json`：

```json
{
  "defaultModel": "auto",  // 改为 auto
  "blacklistResetCron": "0 0 1 * *"
}
```

重启服务生效：

```bash
./manage-services.sh restart
```

### 单独覆盖某个平台

如果只想某个平台用不同的模型，在对应的 `.env` 中设置：

```bash
# dingtalk/.env
CURSOR_MODEL=auto  # 钉钉单独使用 auto，其他平台仍使用 config/model-config.json
```

**优先级**：`.env` > `config/model-config.json`

---

## 📊 当前配置

三个平台统一使用：

```
✅ 钉钉:     opus-4.6
✅ 飞书:     opus-4.6
✅ 企业微信: opus-4.6
```

---

## 📚 相关文档

- [模型管理完整文档](../docs/MODEL-MANAGEMENT.md)
- [模型快速开始](../docs/MODEL-QUICKSTART.md)
- [统一配置说明](../docs/MODEL-CONFIG-UNIFIED.md)
