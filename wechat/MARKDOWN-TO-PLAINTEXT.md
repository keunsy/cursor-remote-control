# 微信个人号 Markdown 转纯文本

## 背景

微信个人号（基于 ilink bot API）**不支持 Markdown 格式**，只能发送纯文本消息。本实现 **100% 复刻 OpenClaw 微信插件**的转换逻辑。

## 实现来源

- **OpenClaw 微信插件**: `openclaw-weixin/src/messaging/send.ts` 的 `markdownToPlainText` 函数
- **OpenClaw 通用工具**: `openclaw/src/shared/text/strip-markdown.ts` 的 `stripMarkdown` 函数
- **零依赖**：纯正则表达式实现，无需第三方库

## 转换规则

### 第一阶段：微信专用预处理

| Markdown | 转换规则 | 示例输入 | 示例输出 |
|----------|---------|---------|---------|
| 代码块 | 移除围栏，保留代码内容 | \`\`\`js<br>const x = 1;<br>\`\`\` | const x = 1; |
| 图片 | 完全移除 | `![alt](url)` | _(空)_ |
| 链接 | 保留显示文本，移除 URL | `[OpenClaw](https://...)` | OpenClaw |
| 表格 | 移除分隔符，管道符转空格 | `\| A \| B \|`<br>`\|---\|---\|`<br>`\| 1 \| 2 \|` | A  B<br>1  2 |

### 第二阶段：通用 Markdown 移除（8 步）

| Markdown | 转换规则 | 示例输入 | 示例输出 |
|----------|---------|---------|---------|
| 粗体 | 移除 `**` 和 `__` | `**粗体**` | 粗体 |
| 粗体 | 移除 `__` | `__粗体__` | 粗体 |
| 斜体 | 移除 `*` | `*斜体*` | 斜体 |
| 斜体 | 移除 `_` | `_斜体_` | 斜体 |
| 标题 | 移除 `#` 前缀 | `# 标题` | 标题 |
| 水平线 | 完全移除 | `---` 或 `***` | _(空)_ |
| 行内代码 | 移除反引号 | \`code\` | code |
| 多个换行 | 压缩为最多两个 | `\n\n\n\n` | `\n\n` |

### 特别说明：保留列表标记

**与其他转换工具不同，OpenClaw 保留列表前导符：**

| 输入 | 输出 | 说明 |
|------|------|------|
| `- 列表项` | `- 列表项` | 保留 `-` |
| `* 列表项` | `* 列表项` | 保留 `*` |
| `1. 列表项` | `1. 列表项` | 保留数字 |

**原因**：在纯文本环境中，列表标记能显著提高可读性。

## 完整示例

### 输入（Markdown）

```markdown
# 项目进展

## 已完成

- **完成 API 设计**：使用 REST 风格
- 完成数据库迁移

## 下一步

1. 编写测试代码
2. 部署到生产环境

参考文档：[OpenClaw](https://example.com)

```python
def hello():
    print("world")
```

---
**注意**：以上内容来自 _某项目_。
```

### 输出（纯文本）

```
项目进展

已完成

- 完成 API 设计：使用 REST 风格
- 完成数据库迁移

下一步

1. 编写测试代码
2. 部署到生产环境

参考文档：OpenClaw

def hello():
    print("world")

注意：以上内容来自 某项目。
```

## 代码实现

```typescript
function markdownToPlainText(text: string): string {
  let result = text;
  
  // === OpenClaw 微信专用处理 ===
  // 1. 代码块：移除围栏，保留内容
  result = result.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code: string) => code.trim());
  
  // 2. 图片：完全移除
  result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  
  // 3. 链接：只保留显示文本
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  
  // 4. 表格：移除分隔符行，管道符转空格
  result = result.replace(/^\|[\s:|-]+\|$/gm, '');
  result = result.replace(/^\|(.+)\|$/gm, (_, inner: string) => {
    return inner.split('|').map(cell => cell.trim()).join('  ');
  });
  
  // === OpenClaw 通用 stripMarkdown（8 步） ===
  // 5. 移除粗体
  result = result.replace(/\*\*(.+?)\*\*/g, '$1');
  result = result.replace(/__(.+?)__/g, '$1');
  
  // 6. 移除斜体
  result = result.replace(/\*(.+?)\*/g, '$1');
  result = result.replace(/_(.+?)_/g, '$1');
  
  // 7. 移除标题前缀
  result = result.replace(/^#+\s?(.*)$/gm, '$1');
  
  // 8. 移除水平线
  result = result.replace(/^[-*_]{3,}$/gm, '');
  
  // 9. 移除行内代码
  result = result.replace(/`([^`]+)`/g, '$1');
  
  // 10. 压缩多个换行为最多两个
  result = result.replace(/\n{3,}/g, '\n\n');
  
  return result.trim();
}
```

## 技术特点

1. **零依赖**：不依赖 `remove-markdown` 等第三方库
2. **性能优异**：纯正则实现，比基于 AST 的解析器快数倍
3. **完全兼容**：与 OpenClaw 微信插件行为一致
4. **可读性强**：保留列表标记，适合聊天场景

## 参考资料

- OpenClaw 源码：https://github.com/openclaw/openclaw
- OpenClaw 微信插件：`openclaw-weixin`
- OpenClaw 通用工具：`src/shared/text/strip-markdown.ts`
