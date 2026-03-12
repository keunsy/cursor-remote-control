# Skill 编写最佳实践

本文档整合了 Claude Skills 的核心编写原则和最佳实践。

## 目录

- [核心原则](#核心原则)
- [命名规范](#命名规范)
- [Description 编写指南](#description-编写指南)
- [渐进式披露](#渐进式披露)
- [工作流设计](#工作流设计)
- [脚本最佳实践](#脚本最佳实践)
- [反模式清单](#反模式清单)
- [质量检查清单](#质量检查清单)

---

## 核心原则

### 1. 简洁至上

上下文窗口是公共资源。每个 token 都要问自己：
- "Claude 真的需要这个解释吗？"
- "我能假设 Claude 已经知道这个吗？"
- "这段内容值得占用 token 吗？"

**好的示例 (约 50 tokens):**
````markdown
## 提取 PDF 文本

使用 pdfplumber 提取文本：

```python
import pdfplumber

with pdfplumber.open("file.pdf") as pdf:
    text = pdf.pages[0].extract_text()
```
````

**差的示例 (约 150 tokens):**
```markdown
## 提取 PDF 文本

PDF（便携式文档格式）是一种常见的文件格式，包含文本、图像和其他内容。
要从 PDF 中提取文本，你需要使用一个库。有很多可用的 PDF 处理库，
但我们推荐 pdfplumber，因为它易于使用且能处理大多数情况。
首先，你需要使用 pip 安装它。然后你可以使用下面的代码...
```

简洁版假设 Claude 知道什么是 PDF 以及库如何工作。

### 2. 自由度匹配

根据任务的脆弱性和可变性匹配指令的具体程度。

| 自由度 | 适用场景 | 示例 |
|--------|----------|------|
| **高** | 多种方法都可行、决策依赖上下文 | 代码审查流程 |
| **中** | 有首选模式但允许变化 | 带参数的脚本 |
| **低** | 操作脆弱、一致性关键 | 数据库迁移 |

**类比**：把 Claude 想象成探索路径的机器人：
- **两侧悬崖的窄桥**：只有一条安全路径 → 提供具体护栏和精确指令（低自由度）
- **无障碍的开阔田野**：多条路径都能成功 → 给出大方向，信任 Claude 找到最佳路线（高自由度）

---

## 命名规范

使用一致的命名模式，推荐使用 **动名词形式** (verb + -ing)。

**好的命名示例:**
- `processing-pdfs`
- `analyzing-spreadsheets`
- `managing-databases`
- `testing-code`
- `writing-documentation`

**可接受的替代:**
- 名词短语: `pdf-processing`, `spreadsheet-analysis`
- 动作导向: `process-pdfs`, `analyze-spreadsheets`

**避免:**
- 模糊名称: `helper`, `utils`, `tools`
- 过于通用: `documents`, `data`, `files`
- 保留词: `anthropic-helper`, `claude-tools`
- 集合内命名不一致

---

## Description 编写指南

`description` 字段用于 Skill 发现，必须包含：
1. **做什么** - Skill 的功能
2. **什么时候用** - 触发场景和关键词

### 关键规则

**始终使用第三人称**（description 会注入系统提示）：
- ✅ "处理 Excel 文件并生成报告"
- ❌ "我可以帮你处理 Excel 文件"
- ❌ "你可以用这个来处理 Excel 文件"

### 好的示例

```yaml
# PDF 处理
description: 从 PDF 文件中提取文本和表格，填写表单，合并文档。当处理 PDF 文件或用户提到 PDF、表单、文档提取时使用。

# Excel 分析
description: 分析 Excel 电子表格，创建数据透视表，生成图表。当分析 Excel 文件、电子表格、表格数据或 .xlsx 文件时使用。

# Git 提交助手
description: 通过分析 git diff 生成描述性提交信息。当用户请求帮助编写提交信息或审查暂存更改时使用。
```

### 避免的示例

```yaml
description: 帮助处理文档  # 太模糊
description: 处理数据      # 不具体
description: 处理文件      # 无触发场景
```

---

## 渐进式披露

SKILL.md 作为概览，指向详细材料。三级加载系统：

1. **元数据** (name + description) - 始终在上下文 (~100词)
2. **SKILL.md body** - 触发时加载 (<500行)
3. **Bundled resources** - 按需加载 (无限制)

### 模式 1: 高层指南 + 引用

```markdown
# PDF 处理

## 快速开始
[基本代码示例]

## 高级功能
**表单填写**: 见 [FORMS.md](FORMS.md)
**API 参考**: 见 [REFERENCE.md](REFERENCE.md)
**示例**: 见 [EXAMPLES.md](EXAMPLES.md)
```

### 模式 2: 按领域组织

```
bigquery-skill/
├── SKILL.md (概览和导航)
└── reference/
    ├── finance.md (收入、账单指标)
    ├── sales.md (机会、管道)
    └── product.md (API 使用、功能)
```

### 模式 3: 条件详情

```markdown
## 创建文档
使用 docx-js 创建新文档。见 [DOCX-JS.md](DOCX-JS.md)。

## 编辑文档
简单编辑直接修改 XML。
**追踪修改**: 见 [REDLINING.md](REDLINING.md)
**OOXML 详情**: 见 [OOXML.md](OOXML.md)
```

### 重要：避免深层嵌套引用

保持引用**一层深度**。Claude 可能只部分读取嵌套引用的文件。

**差的示例 (太深):**
```
SKILL.md → advanced.md → details.md → 实际信息
```

**好的示例 (一层深度):**
```
SKILL.md → advanced.md (完整信息)
         → reference.md (完整信息)
         → examples.md (完整信息)
```

### 长文件需要目录

超过 100 行的参考文件，在顶部包含目录：

```markdown
# API 参考

## 目录
- 认证和设置
- 核心方法 (创建、读取、更新、删除)
- 高级功能 (批量操作、Webhooks)
- 错误处理模式
- 代码示例

## 认证和设置
...
```

---

## 工作流设计

### 复杂任务使用工作流

将复杂操作分解为清晰的顺序步骤，提供检查清单：

````markdown
## PDF 表单填写工作流

复制此检查清单并跟踪进度：

```
任务进度：
- [ ] 步骤 1: 分析表单 (运行 analyze_form.py)
- [ ] 步骤 2: 创建字段映射 (编辑 fields.json)
- [ ] 步骤 3: 验证映射 (运行 validate_fields.py)
- [ ] 步骤 4: 填写表单 (运行 fill_form.py)
- [ ] 步骤 5: 验证输出 (运行 verify_output.py)
```

**步骤 1: 分析表单**
运行: `python scripts/analyze_form.py input.pdf`
...
````

### 实现反馈循环

**常见模式**: 运行验证器 → 修复错误 → 重复

```markdown
## 文档编辑流程

1. 编辑 `word/document.xml`
2. **立即验证**: `python scripts/validate.py unpacked_dir/`
3. 如果验证失败：
   - 仔细查看错误信息
   - 修复 XML 中的问题
   - 再次运行验证
4. **只有验证通过后才继续**
5. 重建: `python scripts/pack.py unpacked_dir/ output.docx`
```

### 条件工作流

引导 Claude 通过决策点：

```markdown
## 文档修改工作流

1. 确定修改类型：
   **创建新内容?** → 遵循下方"创建工作流"
   **编辑现有内容?** → 遵循下方"编辑工作流"

2. 创建工作流：
   - 使用 docx-js 库
   - 从头构建文档
   - 导出为 .docx 格式

3. 编辑工作流：
   - 解包现有文档
   - 直接修改 XML
   - 每次更改后验证
   - 完成后重新打包
```

---

## 脚本最佳实践

### 解决问题，不要推卸

脚本应处理错误条件，而不是推给 Claude。

**好的示例:**
```python
def process_file(path):
    """处理文件，如果不存在则创建。"""
    try:
        with open(path) as f:
            return f.read()
    except FileNotFoundError:
        print(f"文件 {path} 未找到，创建默认文件")
        with open(path, 'w') as f:
            f.write('')
        return ''
    except PermissionError:
        print(f"无法访问 {path}，使用默认值")
        return ''
```

**差的示例:**
```python
def process_file(path):
    # 直接失败，让 Claude 处理
    return open(path).read()
```

### 避免魔法数字

配置参数应有文档说明：

**好的示例:**
```python
# HTTP 请求通常在 30 秒内完成
# 较长超时考虑慢速连接
REQUEST_TIMEOUT = 30

# 三次重试平衡可靠性和速度
# 大多数间歇性故障在第二次重试时解决
MAX_RETRIES = 3
```

**差的示例:**
```python
TIMEOUT = 47  # 为什么是 47?
RETRIES = 5   # 为什么是 5?
```

### 提供实用脚本

预制脚本的优势：
- 比生成的代码更可靠
- 节省 token（无需在上下文中包含代码）
- 节省时间（无需代码生成）
- 确保跨使用的一致性

### MCP 工具引用格式

使用完全限定的工具名称：`ServerName:tool_name`

```markdown
使用 BigQuery:bigquery_schema 工具获取表结构。
使用 GitHub:create_issue 工具创建问题。
```

---

## 反模式清单

### 避免的做法

| 反模式 | 问题 | 正确做法 |
|--------|------|----------|
| Windows 路径 | `scripts\helper.py` 在 Unix 上出错 | 使用 `scripts/helper.py` |
| 选项过多 | "可以用 pypdf、pdfplumber、PyMuPDF..." | 提供默认选项 + 备选方案 |
| 时间敏感信息 | "2025年8月前用旧 API" | 使用"旧模式"章节 |
| 术语不一致 | 混用"端点"、"URL"、"路由" | 选择一个术语并坚持使用 |
| 深层嵌套引用 | A.md → B.md → C.md | 保持一层深度 |
| 假设工具已安装 | "使用 pdf 库处理文件" | 明确依赖：`pip install pypdf` |

### 内容指南

**避免时间敏感信息:**
```markdown
# 差的示例
如果在 2025 年 8 月之前，使用旧 API。

# 好的示例
## 当前方法
使用 v2 API 端点: `api.example.com/v2/messages`

## 旧模式
<details>
<summary>Legacy v1 API (已弃用 2025-08)</summary>
v1 API 使用: `api.example.com/v1/messages`
此端点不再支持。
</details>
```

**使用一致的术语:**
- ✅ 始终用 "API 端点"
- ✅ 始终用 "字段"
- ✅ 始终用 "提取"
- ❌ 混用 "端点"、"URL"、"路由"、"路径"

---

## 质量检查清单

分享 Skill 前，验证以下项目：

### 核心质量
- [ ] Description 具体且包含关键词
- [ ] Description 包含功能描述和使用场景
- [ ] SKILL.md body 少于 500 行
- [ ] 额外详情放在单独文件中（如需要）
- [ ] 无时间敏感信息（或放在"旧模式"章节）
- [ ] 全文术语一致
- [ ] 示例具体，非抽象
- [ ] 文件引用保持一层深度
- [ ] 适当使用渐进式披露
- [ ] 工作流步骤清晰

### 代码和脚本
- [ ] 脚本解决问题而非推给 Claude
- [ ] 错误处理明确且有帮助
- [ ] 无"魔法数字"（所有值有说明）
- [ ] 所需包在说明中列出并验证可用
- [ ] 脚本有清晰文档
- [ ] 无 Windows 风格路径（全用正斜杠）
- [ ] 关键操作有验证/确认步骤
- [ ] 质量关键任务包含反馈循环

### 测试
- [ ] 设计至少三个测试提问
- [ ] 包含正常请求、边缘情况、不应触发的请求
- [ ] 用真实使用场景测试
- [ ] 整合用户反馈（如适用）

---

## 评估驱动开发

**在编写大量文档前先设计测试**，确保 Skill 解决真实问题。

### 开发流程

1. **识别差距**: 在没有 Skill 的情况下让 Claude 执行代表性任务，记录具体失败
2. **设计测试提问**: 构建三个测试这些差距的提问
3. **建立基线**: 观察没有 Skill 时 Claude 的表现
4. **编写最小指令**: 只创建足够解决差距的内容
5. **迭代**: 执行测试提问，观察结果，改进

### 测试提问示例

```
Skill: pdf-processing

测试提问 1 (正常请求):
"帮我从这个 PDF 文件提取所有文本"

测试提问 2 (边缘情况):
"这个扫描版 PDF 能提取文字吗？"

测试提问 3 (不应触发):
"帮我写一份 PDF 格式的报告" ← 这是创建，不是处理
```

### 迭代开发

与用户协作开发 Skill：
1. 你设计 Skill
2. 用户用测试提问验证
3. 收集反馈，改进 Skill

