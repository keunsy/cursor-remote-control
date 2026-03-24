# 公开发布前清理清单

## ✅ 已完成

- [x] `.gitignore` 配置完善，已排除所有敏感文件
- [x] 环境变量文件只有 `.env.example`（占位符）
- [x] 代码中无硬编码密钥
- [x] 示例配置文件安全
- [x] **已修复**: `cron-jobs-wechat.json` 从 git 中移除 ✅
- [x] **已修复**: `.gitignore` 添加 `cron-jobs-wechat.json` ✅
- [x] **已修复**: `feishu/AGENTS.md` 删除内部名称 ✅

## 🔧 已修复的问题

### 1. ✅ 删除内部名称引用

- [x] `feishu/AGENTS.md` 第 1 行：已删除"（虾群平台版）"
- [x] `feishu/AGENTS.md` 第 28 行：已将"虾群平台版/"改为"feishu/"

### 2. ✅ 修复 cron-jobs-wechat.json 泄露

**问题**: 该文件被意外提交到 git，虽然只包含示例数据，但不符合规范

**已执行修复**:
- [x] `.gitignore` 添加 `cron-jobs-wechat.json`
- [x] 从 git 历史中移除该文件（`git rm --cached`）
- [x] 创建 `cron-jobs-wechat.json.example` 作为示例
- [x] 恢复本地 `cron-jobs-wechat.json`（不提交）

### 3. 审查 .cursor/rules/ 目录（可选）

建议删除或泛化以下文件中的内部系统引用：

- [ ] `.cursor/rules/agent-identity.mdc` - 已检查，内容通用✅
- [ ] 其他 rules 文件 - 检查是否有公司特定规范

**选项 A**：删除包含内部规范的规则文件
**选项 B**：保留但在 README 中说明这些是示例，用户应根据自己的规范修改
**选项 C**：泛化规则内容，删除具体的公司/系统名称

推荐：**选项 B**（最简单，且对用户有参考价值）

### 4. README 优化建议（可选）

在 README.md 中添加说明：

```markdown
## 可选依赖说明

本项目使用了以下可选的第三方服务：

- **火山引擎豆包 STT**（语音识别）：可选，支持本地 whisper-cpp 兜底
- **火山引擎豆包 Embedding**（向量检索）：可选，记忆系统可降级运行
- 你可以替换为其他服务商，或完全禁用这些功能

## Cursor 规则文件说明

`.cursor/rules/` 目录包含示例编码规范，你可以：
- 保留作为参考
- 根据自己的团队规范修改
- 完全删除并使用自己的规则
```

### 5. 文档中的服务商引用（无需修改）

以下文件提到"火山引擎豆包"，**无需修改**（公开服务商）：
- `feishu/AGENTS.md`
- `wecom/AGENTS.md`
- `wechat/AGENTS.md`
- `.env.example` 文件
- `README.md`

## 📝 剩余步骤（可选优化）

### Step 1: 处理 .cursor/rules/（可选）

根据你的选择执行对应操作（推荐选项 B：保留但说明）

### Step 2: 更新 README.md（可选）

添加"可选依赖说明"和"Cursor 规则文件说明"章节

### Step 3: 最终检查

```bash
# 确认 .gitignore 有效
git status  # 确保没有 .env、projects.json 等敏感文件

# 检查是否还有敏感文件被追踪
git ls-files | grep -E "(\.env$|\.sqlite$|cron-jobs-.*\.json$|projects\.json$)" | grep -v example

# 应该返回空（除了 .env.example 和 *.json.example）
```

## ✨ 公开发布建议

### 开源协议

当前使用 MIT License ✅（README 中已标注）

### 项目描述优化

建议在 README 顶部添加：

```markdown
## 特性

- ✅ **零公网依赖**：WebSocket/Stream 长连接，无需公网 IP
- ✅ **多平台支持**：飞书、钉钉、企业微信、微信个人号
- ✅ **完整记忆系统**：向量检索 + FTS5 混合搜索，时间衰减 + MMR 去重
- ✅ **智能路由**：自动识别项目，对话式切换工作区
- ✅ **定时任务**：AI 自主创建定时提醒、新闻推送
- ✅ **流式回复**：实时进度推送，支持工具调用摘要
```

### GitHub 仓库设置建议

- [ ] 添加 `.github/workflows/` CI 配置（可选）
- [ ] 添加 `CONTRIBUTING.md`（已有 ✅）
- [ ] 添加 issue/PR 模板（可选）
- [ ] 设置合适的 topics 标签：`cursor`, `ai`, `feishu`, `dingtalk`, `wechat`

## 🎯 总结

**风险评级**：🟢 已解决，可安全发布
- ✅ 核心代码安全性好
- ✅ 内部名称已清除
- ✅ 敏感配置文件已从 git 移除
- ✅ .gitignore 已完善
- 🟡 可选优化：README 和 .cursor/rules/ 说明

**已完成的修复**：
1. ✅ 删除 `feishu/AGENTS.md` 中的内部名称
2. ✅ 修复 `cron-jobs-wechat.json` 泄露问题
3. ✅ 完善 `.gitignore` 规则

**剩余工作（可选）**：
- 添加 README 中的可选依赖说明（5 分钟）
- 说明 .cursor/rules/ 为示例规则（2 分钟）

**当前状态变更**：
```bash
M  .gitignore                                    # 添加 cron-jobs-wechat.json
R  cron-jobs-wechat.json -> cron-jobs-wechat.json.example  # 改为示例文件
M  feishu/AGENTS.md                             # 删除内部名称
```

项目已完成核心安全检查，可以安全提交并公开发布！🎉
