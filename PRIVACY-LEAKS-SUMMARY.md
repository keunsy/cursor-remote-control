# 🚨 个人信息泄露完整报告

**发现时间**：2026-03-24  
**检查范围**：全部源码、Git历史、配置文件、文档  
**严重等级**：🔴 CRITICAL

---

## 📊 泄露统计

| 类型 | 数量 | 状态 |
|------|------|------|
| **Git历史泄露** | 3个提交 | 🔴 已推送到远程 |
| **本地文件泄露** | 7个文件 | 🟡 未提交，但存在 |
| **GitHub URL** | 4个文件 | 🟢 公开信息（可接受） |
| **真实Token** | 1个文件 | 🟡 本地文件，已ignore |

---

## 🔴 Git历史中的泄露（最严重）

### 1. feishu/.sessions.json（提交 b761f3f）

**提交信息**：
```
commit b761f3ffc4f9f00588d9b97817213bb8848174cc
Date: Tue Mar 11 23:57:09 2026 +0800
Message: chore: 添加 bun.lock 和会话文件
```

**泄露内容**：
- ❌ 用户名：`keunsy`
- ❌ 项目路径：`/Users/keunsy/IdeaProjects/user-moa`
- ❌ 项目路径：`/Users/keunsy/work/cursor/a-stock-pullback-strategy-android`
- ❌ 项目名称：`stock-android`、`user-moa`
- ❌ 会话摘要："你好，我这边正常"、"你给我登录下"

**当前状态**：
- ✅ 已从当前版本删除（提交 bbedbd9）
- ❌ 但Git历史中仍然存在
- ❌ 已推送到 `origin/main`

### 2. feishu/发送文件到飞书.md（提交 416f491）

**泄露内容**：
```bash
cd /Users/keunsy/work/cursor/cursor-remote-control/feishu  # ← 4处
```

**当前状态**：
- ❌ 文件仍在仓库中
- ❌ 已推送到 `origin/main`

### 3. docs/TROUBLESHOOTING.md（提交 4a5107d）

**泄露内容**：
```json
"path": "/Users/keunsy/Projects/myapp"
```
```bash
/发送文件 /Users/keunsy/Desktop/report.pdf
```

**当前状态**：
- ❌ 文件仍在仓库中
- ❌ 已推送到 `origin/main`

---

## 🟡 本地文件泄露（未提交）

### 4. wechat/.wechat_token.json ⚠️

**内容**：
```json
{
  "token": "c23ba10b0d8d@im.bot:06000013bf0aaa385ccef5f7dab0f3b5d0d934",
  "accountId": "c23ba10b0d8d@im.bot"
}
```

**状态**：
- ✅ 已被 `.gitignore` 排除（规则：`*.plist`？实际没明确规则）
- ⚠️ 建议：添加明确的 ignore 规则

### 5. wechat/.sessions.json

**内容**：包含 `/Users/user/IdeaProjects/user-moa` 等路径

**状态**：
- ✅ 已被 `.gitignore` 排除（规则：`*/.sessions.json`）
- ⚠️ 曾在提交 77e4074 中出现，但已删除

### 6. dingtalk/.sessions.json

**内容**：包含 `/Users/user/IdeaProjects/user-moa` 等路径

**状态**：
- ✅ 已被 `.gitignore` 排除

### 7. feishu/.sessions.json（当前版本）

**内容**：包含 `/Users/keunsy/` 和 `/Users/user/` 路径

**状态**：
- ✅ 已被 `.gitignore` 排除
- ⚠️ 但Git历史中有早期版本（见上述问题1）

### 8. .cursor/MEMORY.md

**内容**：包含项目路径和用户习惯描述

**状态**：
- ✅ 已被 `.gitignore` 排除（规则：`/.cursor/`）

### 9. .cursor/memory/2026-03-20.md

**内容**：包含项目路径

**状态**：
- ✅ 已被 `.gitignore` 排除（规则：`/.cursor/`）

### 10. cron-jobs-feishu.json

**内容**：
```json
"webhook": "oc_672ad3c25adbe2e707730799a0b133ec"
```

**状态**：
- ✅ 已被 `.gitignore` 排除
- ✅ Git历史中只有空配置（安全）

---

## 🟢 可接受的信息（公开）

### GitHub Repository URL

以下文件包含 `github.com/keunsy/cursor-remote-control`：
- `dingtalk/package.json`
- `feishu/package.json`
- `wecom/package.json`
- `wechat/package.json`
- `CHANGELOG.md`

**评估**：✅ 这是公开仓库URL，属于正常信息

---

## 🎯 风险评估

### 高风险项（必须处理）

1. **b761f3f 提交**：Git历史中的完整会话记录
   - 用户名暴露
   - 项目路径暴露
   - 会话内容暴露
   - **影响**：任何人可通过 `git show b761f3f:feishu/.sessions.json` 查看

2. **416f491 提交**：文档中的真实路径
   - 4处 `/Users/keunsy/` 路径
   - **影响**：当前仓库中仍然存在

3. **4a5107d 提交**：文档中的真实路径
   - 2处 `/Users/keunsy/` 路径
   - **影响**：当前仓库中仍然存在

### 中风险项（建议处理）

4. **wechat/.wechat_token.json**
   - 包含真实 bot token
   - 虽然已被ignore，但建议添加明确规则

### 低风险项（已防护）

5. 其他 `.sessions.json` 文件 - 已被 gitignore
6. `.cursor/` 目录内容 - 已被 gitignore
7. `cron-jobs-*.json` 文件 - 已被 gitignore

---

## ✅ 修复方案

### 优先级 P0：Git历史清理

**必须在公开前完成！**

#### 方案 A：使用 git-filter-repo（推荐）

```bash
# 1. 安装工具
brew install git-filter-repo

# 2. 备份
cp -r /Users/user/work/cursor/cursor-remote-control \
     /Users/user/work/cursor/cursor-remote-control-backup

# 3. 清理敏感文件
cd /Users/user/work/cursor/cursor-remote-control
git filter-repo \
  --path feishu/.sessions.json \
  --invert-paths \
  --force

# 4. 修改当前文档中的路径
# 见下方"P1: 修改文档路径"

# 5. 强制推送
git push origin --force --all
git push origin --force --tags
```

#### 方案 B：创建全新仓库（最安全）

```bash
# 1. 修改所有文档中的路径（见下方P1）

# 2. 创建干净分支
cd /Users/user/work/cursor/cursor-remote-control
git checkout --orphan clean-main
git add -A
git commit -m "Initial commit with clean history"

# 3. 删除旧GitHub仓库，创建新的
# 去 GitHub 删除 keunsy/cursor-remote-control
# 创建新仓库后：
git remote remove origin
git remote add origin https://github.com/keunsy/cursor-remote-control.git
git push -u origin clean-main --force
```

### 优先级 P1：修改文档路径

**修改 `feishu/发送文件到飞书.md`**：

```bash
# 将所有 /Users/keunsy/ 替换为 /Users/your_username/
sed -i '' 's|/Users/keunsy/|/Users/your_username/|g' \
  feishu/发送文件到飞书.md

# 或者改为相对路径
sed -i '' 's|/Users/keunsy/work/cursor/cursor-remote-control/feishu|$(pwd)|g' \
  feishu/发送文件到飞书.md
```

**修改 `docs/TROUBLESHOOTING.md`**：

```bash
# 将示例路径改为通用
sed -i '' 's|/Users/keunsy/Projects/myapp|/Users/your_username/Projects/myapp|g' \
  docs/TROUBLESHOOTING.md

sed -i '' 's|/Users/keunsy/Desktop/report.pdf|/Users/your_username/Desktop/report.pdf|g' \
  docs/TROUBLESHOOTING.md
```

### 优先级 P2：完善 .gitignore

添加明确的 token 文件规则：

```bash
# 在 .gitignore 中添加
echo "" >> .gitignore
echo "# 微信 token 文件" >> .gitignore
echo "wechat/.wechat_token.json" >> .gitignore
echo "wechat/.wechat_sync_buf" >> .gitignore
```

---

## 📋 执行清单

### 第一步：立即检查远程状态

```bash
cd /Users/user/work/cursor/cursor-remote-control

# 检查仓库是否公开
curl -s -o /dev/null -w "%{http_code}" \
  https://github.com/keunsy/cursor-remote-control

# 200 = 公开，404 = 私有或不存在
```

### 第二步：选择修复方案

- [ ] **如果返回 404**（未公开）：使用方案 A 或 B，然后公开
- [ ] **如果返回 200**（已公开）：必须使用方案 A 或 B，并考虑通知用户

### 第三步：执行修复

- [ ] 备份当前仓库
- [ ] 执行 Git 历史清理（方案 A 或 B）
- [ ] 修改文档中的路径（P1）
- [ ] 完善 .gitignore（P2）
- [ ] 验证清理结果

### 第四步：验证

```bash
# 1. 确认敏感文件已从历史中删除
git log --all --full-history -- "*/.sessions.json"
# 应只显示删除记录或为空

# 2. 确认文档中无个人路径
grep -r "keunsy" --include="*.md" --exclude="PRIVACY-LEAKS-SUMMARY.md"
# 应返回空

# 3. 确认 .gitignore 有效
git status | grep -E "(sessions|token|sqlite)"
# 应返回空
```

---

## 🎯 建议

### 立即行动

1. **不要推送任何新提交**（避免问题扩散）
2. **检查仓库是否已公开**
3. **根据状态选择方案 A 或 B**

### 未来预防

1. ✅ 已配置 `.gitignore`
2. 🔄 建议：添加 pre-commit hook 检查敏感信息
3. 🔄 建议：使用示例路径（如 `/path/to/your/project`）

---

**生成时间**：2026-03-24  
**严重程度**：🔴 CRITICAL - 阻塞公开发布  
**建议处理时间**：立即
