# 🚨 严重隐私泄露警告

**发现时间**：2026-03-24  
**严重等级**：🔴 CRITICAL  
**状态**：需要立即处理

---

## 问题描述

Git 历史中的提交 `b761f3f`（2026-03-11）包含真实个人信息：

### 泄露内容

**文件**：`feishu/.sessions.json`

**包含信息**：
1. ❌ 用户名：`keunsy`
2. ❌ 项目路径：`/Users/keunsy/IdeaProjects/user-moa`
3. ❌ 项目路径：`/Users/keunsy/work/cursor/a-stock-pullback-strategy-android`
4. ❌ 项目名称：`stock-android`、`user-moa`
5. ❌ 会话内容：对话摘要

### 提交信息

```bash
commit b761f3ffc4f9f00588d9b97817213bb8848174cc
Author: keunsy <7909479+keunsy@users.noreply.github.com>
Date:   Tue Mar 11 23:57:09 2026 +0800

    chore: 添加 bun.lock 和会话文件
```

---

## 当前状态

✅ **文件已从当前版本删除**（提交 `bbedbd9`）  
✅ **已添加到 `.gitignore`**  
❌ **但 Git 历史中仍然存在**  
❌ **可通过 `git show b761f3f:feishu/.sessions.json` 查看**

---

## 风险评估

### 如果仓库已公开

🔴 **高风险**：任何人都可以查看历史提交

```bash
# 任何人都可以执行
git clone https://github.com/keunsy/cursor-remote-control.git
git show b761f3f:feishu/.sessions.json
```

### 如果仓库未公开/未推送

🟡 **中风险**：只有你本地有，清理后再公开

---

## 解决方案

### 方案 1：重写 Git 历史（推荐，如果尚未公开）

⚠️ **危险操作，会改变所有提交 hash！**

#### 步骤 1：安装 git-filter-repo

```bash
# macOS
brew install git-filter-repo

# 或使用 pip
pip3 install git-filter-repo
```

#### 步骤 2：移除敏感文件

```bash
cd /Users/user/work/cursor/cursor-remote-control

# 备份（重要！）
git clone . ../cursor-remote-control-backup

# 从整个历史中删除 feishu/.sessions.json
git filter-repo --path feishu/.sessions.json --invert-paths --force
```

#### 步骤 3：强制推送（如果已推送到远程）

```bash
# 警告：这会覆盖远程仓库历史！
git push origin --force --all
git push origin --force --tags
```

### 方案 2：创建全新仓库（最安全）

```bash
# 1. 创建干净的分支
cd /Users/user/work/cursor/cursor-remote-control
git checkout --orphan clean-main

# 2. 添加当前所有文件
git add -A
git commit -m "Initial commit (clean history)"

# 3. 删除旧分支
git branch -D main

# 4. 重命名新分支
git branch -m main

# 5. 创建新的 GitHub 仓库，推送干净历史
git remote remove origin
git remote add origin https://github.com/YOUR_USERNAME/cursor-remote-control.git
git push -u origin main --force
```

### 方案 3：接受风险（不推荐）

如果你认为：
- 用户名 `keunsy` 不敏感
- 项目路径不重要
- 会话内容无关紧要

可以选择保留，但**不建议**。

---

## 立即行动清单

### 第一步：确认状态

```bash
# 检查是否已推送到远程
cd /Users/user/work/cursor/cursor-remote-control
git log origin/main --oneline 2>/dev/null | grep b761f3f

# 如果输出包含 b761f3f，说明已推送到远程（需要方案 1 或 2）
# 如果提示 "unknown revision"，说明未推送（直接用方案 1 即可）
```

### 第二步：选择方案

- [ ] **未推送** → 使用方案 1（重写历史）
- [ ] **已推送** → 使用方案 2（创建新仓库）或方案 1（强制推送）
- [ ] **已公开** → 必须使用方案 1 或 2，并考虑通知用户

### 第三步：执行清理

按照所选方案执行操作。

### 第四步：验证

```bash
# 确认敏感文件已从历史中删除
git log --all --full-history -- "*/.sessions.json"

# 应该返回空或只有删除记录
```

---

## 预防措施（未来）

1. ✅ **已完成**：`.gitignore` 已包含 `*/.sessions.json`
2. ✅ **已完成**：提交前检查敏感信息
3. 🔄 **建议**：使用 pre-commit hook 自动检查
4. 🔄 **建议**：定期审查 git 历史

---

## 参考资料

- [GitHub: Removing sensitive data](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)
- [git-filter-repo 文档](https://github.com/newren/git-filter-repo)

---

**创建时间**：2026-03-24  
**优先级**：P0 - 阻塞发布  
**建议处理时间**：公开发布前必须解决
