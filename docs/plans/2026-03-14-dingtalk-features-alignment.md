# 钉钉版功能对齐实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**目标：** 为钉钉版实现启动自检、出生仪式、文件发送和工作区模板初始化功能，与飞书版对齐

**架构：** 复用飞书版的核心逻辑，适配钉钉的消息发送机制（webhook替代messageId）

**技术栈：** Bun, TypeScript, 钉钉 Stream API, 钉钉文件上传 API

---

## Task 1: 创建工作区模板目录结构

**目的：** 建立模板文件系统，为工作区初始化提供源文件

**Files:**
- Create: `/Users/keunsy/work/cursor/cursor-remote-control/templates/AGENTS.md`
- Create: `/Users/keunsy/work/cursor/cursor-remote-control/templates/.cursor/BOOT.md`
- Create: `/Users/keunsy/work/cursor/cursor-remote-control/templates/.cursor/BOOTSTRAP.md`
- Create: `/Users/keunsy/work/cursor/cursor-remote-control/templates/.cursor/SOUL.md`
- Create: `/Users/keunsy/work/cursor/cursor-remote-control/templates/.cursor/IDENTITY.md`
- Create: `/Users/keunsy/work/cursor/cursor-remote-control/templates/.cursor/USER.md`
- Create: `/Users/keunsy/work/cursor/cursor-remote-control/templates/.cursor/MEMORY.md`
- Create: `/Users/keunsy/work/cursor/cursor-remote-control/templates/.cursor/HEARTBEAT.md`
- Create: `/Users/keunsy/work/cursor/cursor-remote-control/templates/.cursor/TASKS.md`
- Create: `/Users/keunsy/work/cursor/cursor-remote-control/templates/.cursor/TOOLS.md`
- Create: `/Users/keunsy/work/cursor/cursor-remote-control/templates/.cursor/rules/soul.mdc`
- Create: `/Users/keunsy/work/cursor/cursor-remote-control/templates/.cursor/rules/agent-identity.mdc`
- Create: `/Users/keunsy/work/cursor/cursor-remote-control/templates/.cursor/rules/user-context.mdc`
- Create: `/Users/keunsy/work/cursor/cursor-remote-control/templates/.cursor/rules/workspace-rules.mdc`
- Create: `/Users/keunsy/work/cursor/cursor-remote-control/templates/.cursor/rules/tools.mdc`
- Create: `/Users/keunsy/work/cursor/cursor-remote-control/templates/.cursor/rules/memory-protocol.mdc`
- Create: `/Users/keunsy/work/cursor/cursor-remote-control/templates/.cursor/rules/scheduler-protocol.mdc`
- Create: `/Users/keunsy/work/cursor/cursor-remote-control/templates/.cursor/rules/heartbeat-protocol.mdc`
- Create: `/Users/keunsy/work/cursor/cursor-remote-control/templates/.cursor/rules/cursor-capabilities.mdc`

**Step 1: 创建模板目录结构**

```bash
mkdir -p /Users/keunsy/work/cursor/cursor-remote-control/templates/.cursor/rules
mkdir -p /Users/keunsy/work/cursor/cursor-remote-control/templates/.cursor/memory
mkdir -p /Users/keunsy/work/cursor/cursor-remote-control/templates/.cursor/sessions
```

**Step 2: 创建基础模板文件**

从飞书版（如果有templates目录）或创建最小化版本。关键文件内容：

**BOOT.md** - 启动自检清单：
```markdown
# 启动自检清单

每次服务启动时自动执行。

## 检查项

1. 检查 `.env` 配置完整性
2. 检查项目路由配置
3. 检查记忆系统状态
4. 检查定时任务状态

## 输出规则

- 如果一切正常，回复 "HEARTBEAT_OK"
- 如果有需要告知的信息，简要说明
```

**BOOTSTRAP.md** - 出生仪式：
```markdown
# 出生仪式

这是你的第一次对话。请：

1. 介绍自己（可以起个名字）
2. 了解主人的基本信息
3. 确认工作环境配置
4. 表达服务意愿

完成后，本文件会被自动删除。
```

**AGENTS.md** - 项目说明（简化版）：
```markdown
# 钉钉 Cursor Remote Control

钉钉 → Cursor AI 远程遥控服务。

## 技术栈
- Bun + TypeScript
- 钉钉 Stream API
- Cursor Agent CLI

## 核心模块
- server-minimal.ts - 主服务
- memory.ts - 记忆管理
- scheduler.ts - 定时任务
- heartbeat.ts - 心跳系统
```

**Step 3: 创建最小规则文件**

**agent-identity.mdc**:
```yaml
---
description: AI 身份与人格
globs: ["**/*"]
alwaysApply: true
---

# AI 身份

你是一个远程 Cursor AI 助手，通过钉钉为用户提供编程帮助。

## 输出限制

钉钉 Markdown 消息限制：
- 单条消息建议 ≤ 4000 字
- 表格数量建议 ≤ 3 个
- 超长内容需分片或写文件
```

**Step 4: 验证目录结构**

```bash
ls -R /Users/keunsy/work/cursor/cursor-remote-control/templates/
```

Expected: 显示完整的目录树

---

## Task 2: 实现工作区初始化函数

**目的：** 在钉钉版添加 ensureWorkspace() 函数，自动复制模板到工作区

**Files:**
- Modify: `/Users/keunsy/work/cursor/cursor-remote-control/dingtalk/server-minimal.ts:110-120` (在项目配置加载后添加)

**Step 1: 添加模板目录常量**

在 `server-minimal.ts` 的配置部分（约第109行后）添加：

```typescript
// ── 工作区模板自动初始化 ─────────────────────────
const TEMPLATE_DIR = resolve(ROOT, 'templates');
const WORKSPACE_FILES = [
	".cursor/SOUL.md", ".cursor/IDENTITY.md", ".cursor/USER.md",
	".cursor/MEMORY.md", ".cursor/HEARTBEAT.md", ".cursor/TASKS.md",
	".cursor/BOOT.md", ".cursor/TOOLS.md",
];
const WORKSPACE_RULES = [
	".cursor/rules/soul.mdc",
	".cursor/rules/agent-identity.mdc",
	".cursor/rules/user-context.mdc",
	".cursor/rules/workspace-rules.mdc",
	".cursor/rules/tools.mdc",
	".cursor/rules/memory-protocol.mdc",
	".cursor/rules/scheduler-protocol.mdc",
	".cursor/rules/heartbeat-protocol.mdc",
	".cursor/rules/cursor-capabilities.mdc",
];

function ensureWorkspace(wsPath: string): boolean {
	const normalizedWs = resolve(wsPath);
	const normalizedRoot = resolve(ROOT);
	// 仅在本项目目录下初始化
	const isOwnProject = normalizedWs === normalizedRoot;

	if (!isOwnProject) {
		return false;
	}

	// 创建目录结构
	mkdirSync(resolve(wsPath, ".cursor/memory"), { recursive: true });
	mkdirSync(resolve(wsPath, ".cursor/sessions"), { recursive: true });
	mkdirSync(resolve(wsPath, ".cursor/rules"), { recursive: true });

	const isNewWorkspace = !existsSync(resolve(wsPath, ".cursor/SOUL.md"));
	let copied = 0;

	// AGENTS.md 放根目录
	const rootFiles = ["AGENTS.md"];
	// 首次初始化额外复制 BOOTSTRAP.md
	const allFiles = isNewWorkspace
		? [...rootFiles, ...WORKSPACE_FILES, ".cursor/BOOTSTRAP.md", ...WORKSPACE_RULES]
		: [...rootFiles, ...WORKSPACE_FILES, ...WORKSPACE_RULES];

	for (const f of allFiles) {
		const target = resolve(wsPath, f);
		if (!existsSync(target)) {
			const src = resolve(TEMPLATE_DIR, f);
			if (existsSync(src)) {
				writeFileSync(target, readFileSync(src, "utf-8"));
				console.log(`[工作区] 从模板复制: ${f}`);
				copied++;
			}
		}
	}

	if (copied > 0) {
		console.log(`[工作区] ${wsPath} 初始化完成 (${copied} 个文件)`);
		if (isNewWorkspace) {
			console.log("[工作区] 首次启动：.cursor/BOOTSTRAP.md 已就绪，首次对话将触发出生仪式");
		}
	}
	return isNewWorkspace;
}
```

**Step 2: 在记忆管理器初始化前调用**

在 `server-minimal.ts` 约第120行（记忆管理器初始化前）添加：

```typescript
// 初始化记忆工作区
const memoryWorkspaceKey = (projectsConfig as any).memory_workspace || projectsConfig.default_project;
const memoryWorkspace = projectsConfig.projects[memoryWorkspaceKey]?.path || defaultWorkspace;
ensureWorkspace(memoryWorkspace);
```

**Step 3: 测试工作区初始化**

```bash
# 删除已有的 .cursor 目录（测试用）
rm -rf /Users/keunsy/work/cursor/cursor-remote-control/.cursor

# 重启服务
cd /Users/keunsy/work/cursor/cursor-remote-control/dingtalk
bash service.sh restart

# 检查日志
bash service.sh logs | grep "工作区"
```

Expected: 看到 "[工作区] 从模板复制: xxx" 的日志

---

## Task 3: 实现启动自检功能

**目的：** 服务启动时自动执行 .cursor/BOOT.md 检查清单，可选推送结果到钉钉

**Files:**
- Modify: `/Users/keunsy/work/cursor/cursor-remote-control/dingtalk/server-minimal.ts:1900-1920` (在服务启动后添加)

**Step 1: 添加启动自检逻辑**

在 `server-minimal.ts` 末尾（约第1900行，服务启动日志后）添加：

```typescript
// ── 启动自检（.cursor/BOOT.md）───────────────────────
setTimeout(async () => {
	const bootPath = resolve(memoryWorkspace, ".cursor/BOOT.md");
	try {
		if (!existsSync(bootPath)) return;
		const content = readFileSync(bootPath, "utf-8").trim();
		if (!content) return;
		
		console.log("[启动] 检测到 .cursor/BOOT.md，执行启动自检...");
		
		const bootPrompt = [
			"你正在执行启动自检。严格按 .cursor/BOOT.md 指示操作。",
			"如果无事可做，回复 'HEARTBEAT_OK'。",
		].join("\n");
		
		const { result } = await runAgent(memoryWorkspace, bootPrompt);
		const trimmed = result.trim();
		
		// 如果有需要推送的内容且有活跃 webhook
		if (trimmed && !/^(无输出|HEARTBEAT_OK)$/i.test(trimmed)) {
			const webhook = getWebhook();
			if (webhook) {
				await sendMarkdown(webhook, trimmed, '🚀 启动自检', 'wathet');
				console.log("[启动] 自检结果已推送到钉钉");
			}
		}
		
		console.log("[启动] .cursor/BOOT.md 自检完成");
	} catch (e) {
		console.warn(`[启动] .cursor/BOOT.md 执行失败: ${e}`);
	}
}, 8000);  // 8秒后执行，确保服务完全启动
```

**Step 2: 测试启动自检**

```bash
# 编辑 BOOT.md 测试输出
echo "测试启动自检功能" > /Users/keunsy/work/cursor/cursor-remote-control/.cursor/BOOT.md

# 重启服务
cd /Users/keunsy/work/cursor/cursor-remote-control/dingtalk
bash service.sh restart

# 查看日志
bash service.sh logs | grep "启动"
```

Expected: 
- 看到 "[启动] 检测到 .cursor/BOOT.md，执行启动自检..."
- 看到 "[启动] .cursor/BOOT.md 自检完成"

**Step 3: 测试钉钉推送**

```bash
# 先给钉钉机器人发一条消息（建立 webhook 缓存）
# 然后重启服务
bash service.sh restart
```

Expected: 如果 BOOT.md 返回了内容（非 HEARTBEAT_OK），会收到钉钉消息

---

## Task 4: 实现出生仪式功能

**目的：** 首次对话时触发 BOOTSTRAP.md，AI 自我介绍并与用户建立关系

**Files:**
- Modify: `/Users/keunsy/work/cursor/cursor-remote-control/dingtalk/server-minimal.ts:800-850` (消息处理逻辑中)

**Step 1: 在消息处理前添加 BOOTSTRAP 检查**

在 `handleTextMessage` 函数开始处（约第800行，实际消息处理前）添加：

```typescript
// ── 出生仪式检查 ─────────────────────────────────
const bootstrapPath = resolve(workspace, ".cursor/BOOTSTRAP.md");
if (existsSync(bootstrapPath)) {
	const bootstrapContent = readFileSync(bootstrapPath, "utf-8").trim();
	if (bootstrapContent) {
		console.log("[出生仪式] 检测到 BOOTSTRAP.md，首次对话");
		
		// 将用户消息和出生仪式结合
		const combinedPrompt = [
			"🎂 这是你的第一次对话（出生仪式）。",
			"",
			"请阅读 .cursor/BOOTSTRAP.md 的指引，然后回应用户的消息。",
			"",
			`用户说：${text}`,
		].join("\n");
		
		// 使用组合提示词
		text = combinedPrompt;
		
		// 标记为出生仪式（后续删除文件）
		(message as any)._isBootstrap = true;
	}
}
```

**Step 2: 在 Agent 执行后删除 BOOTSTRAP.md**

在 `runAgent` 返回后（约第900行，发送回复前）添加：

```typescript
// 如果是出生仪式，删除 BOOTSTRAP.md
if ((message as any)._isBootstrap) {
	try {
		unlinkSync(resolve(workspace, ".cursor/BOOTSTRAP.md"));
		console.log("[出生仪式] BOOTSTRAP.md 已删除，出生仪式完成");
	} catch (e) {
		console.warn(`[出生仪式] 删除 BOOTSTRAP.md 失败: ${e}`);
	}
}
```

**Step 3: 测试出生仪式**

```bash
# 创建 BOOTSTRAP.md
cat > /Users/keunsy/work/cursor/cursor-remote-control/.cursor/BOOTSTRAP.md << 'EOF'
# 出生仪式

这是你的第一次对话。请：

1. 介绍自己（可以起个名字）
2. 询问主人的姓名和偏好
3. 表达服务意愿

完成后本文件会被删除。
EOF

# 重启服务
cd /Users/keunsy/work/cursor/cursor-remote-control/dingtalk
bash service.sh restart

# 在钉钉发送第一条消息
# Expected: AI 会执行出生仪式
```

**Step 4: 验证 BOOTSTRAP.md 被删除**

```bash
ls -la /Users/keunsy/work/cursor/cursor-remote-control/.cursor/BOOTSTRAP.md
```

Expected: 文件不存在

---

## Task 5: 实现文件发送功能（钉钉 API）

**目的：** 实现 `/发送文件 <路径>` 命令，上传本地文件到钉钉

**Files:**
- Create: `/Users/keunsy/work/cursor/cursor-remote-control/dingtalk/send-file-dingtalk.ts`
- Modify: `/Users/keunsy/work/cursor/cursor-remote-control/dingtalk/server-minimal.ts:1400-1420` (添加命令处理)

**Step 1: 研究钉钉文件上传 API**

钉钉文件上传需要：
1. 上传文件到钉钉服务器获取 mediaId
2. 通过 webhook 发送文件消息

API 文档: https://open.dingtalk.com/document/orgapp/upload-media-files

**Step 2: 创建文件上传模块**

创建 `send-file-dingtalk.ts`:

```typescript
/**
 * 钉钉文件上传模块
 */
import axios from 'axios';
import FormData from 'form-data';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface DingtalkFileUploadOptions {
	filePath: string;
	accessToken: string;
	type?: 'image' | 'voice' | 'video' | 'file';
}

export interface DingtalkFileUploadResult {
	mediaId: string;
}

/**
 * 上传文件到钉钉服务器
 */
export async function uploadFileDingtalk(options: DingtalkFileUploadOptions): Promise<DingtalkFileUploadResult> {
	const { filePath, accessToken, type = 'file' } = options;
	
	// 检查文件
	const fullPath = resolve(filePath);
	if (!existsSync(fullPath)) {
		throw new Error(`文件不存在: ${fullPath}`);
	}
	
	const stats = statSync(fullPath);
	const maxSize = 30 * 1024 * 1024; // 30MB
	if (stats.size > maxSize) {
		throw new Error(`文件过大: ${(stats.size / 1024 / 1024).toFixed(2)}MB > 30MB`);
	}
	
	// 构建表单
	const form = new FormData();
	form.append('media', createReadStream(fullPath));
	form.append('type', type);
	
	// 上传
	const url = `https://oapi.dingtalk.com/media/upload?access_token=${accessToken}&type=${type}`;
	const response = await axios.post(url, form, {
		headers: form.getHeaders(),
		maxBodyLength: maxSize,
		maxContentLength: maxSize,
	});
	
	if (response.data.errcode !== 0) {
		throw new Error(`钉钉上传失败: ${response.data.errmsg || response.data.errcode}`);
	}
	
	return {
		mediaId: response.data.media_id,
	};
}

/**
 * 通过 webhook 发送文件消息
 */
export async function sendFileDingtalk(webhook: string, mediaId: string, fileName: string): Promise<void> {
	await axios.post(webhook, {
		msgtype: 'file',
		file: {
			media_id: mediaId,
		},
	});
}
```

**Step 3: 添加命令处理逻辑**

在 `server-minimal.ts` 的命令处理部分（约第1400行）添加：

```typescript
// /发送文件、/sendfile、/send
if (/^\/(发送文件|sendfile|send)\s+/i.test(text)) {
	const filePathMatch = text.match(/^\/(发送文件|sendfile|send)\s+(.+)$/i);
	if (!filePathMatch) {
		await sendMarkdown(sessionWebhook, '用法：`/发送文件 <文件路径>`\n\n示例：\n- `/发送文件 ~/Desktop/app.apk`\n- `/send ~/Documents/report.pdf`', 'ℹ️ 用法');
		return;
	}
	
	let filePath = filePathMatch[2].trim();
	
	// 展开 ~
	if (filePath.startsWith('~')) {
		filePath = filePath.replace('~', HOME);
	}
	
	// 检查文件
	if (!existsSync(filePath)) {
		await sendMarkdown(sessionWebhook, `❌ 文件不存在：\`${filePath}\``, '文件不存在');
		return;
	}
	
	const stats = statSync(filePath);
	const fileSize = stats.size;
	const maxSize = 30 * 1024 * 1024;
	
	if (fileSize > maxSize) {
		await sendMarkdown(sessionWebhook, `❌ 文件过大：${(fileSize / 1024 / 1024).toFixed(2)}MB > 30MB`, '文件过大');
		return;
	}
	
	// 上传中提示
	const fileName = filePath.split('/').pop() || 'file';
	await sendMarkdown(sessionWebhook, `📤 正在上传文件：\`${fileName}\`\n\n大小：${(fileSize / 1024 / 1024).toFixed(2)}MB`, '上传中');
	
	try {
		// 确保 token 有效
		await ensureToken();
		
		// 上传文件
		const { uploadFileDingtalk, sendFileDingtalk } = await import('./send-file-dingtalk.js');
		const { mediaId } = await uploadFileDingtalk({
			filePath,
			accessToken,
			type: 'file',
		});
		
		// 发送文件
		await sendFileDingtalk(sessionWebhook, mediaId, fileName);
		
		await sendMarkdown(sessionWebhook, `✅ 文件发送成功：\`${fileName}\``, '发送成功');
		console.log(`[文件] 已发送: ${fileName}`);
	} catch (error) {
		await sendMarkdown(sessionWebhook, `❌ 发送失败：${error}`, '发送失败');
		console.error('[文件] 发送失败:', error);
	}
	return;
}
```

**Step 4: 安装 form-data 依赖**

```bash
cd /Users/keunsy/work/cursor/cursor-remote-control/dingtalk
bun add form-data
```

**Step 5: 测试文件发送**

在钉钉发送：
```
/发送文件 ~/Desktop/test.txt
```

Expected:
1. 收到"📤 正在上传文件"消息
2. 收到文件
3. 收到"✅ 文件发送成功"消息

---

## Task 6: 更新帮助文档

**目的：** 更新 `/帮助` 命令输出，说明新功能

**Files:**
- Modify: `/Users/keunsy/work/cursor/cursor-remote-control/dingtalk/server-minimal.ts:1196-1210`

**Step 1: 添加新命令到帮助信息**

在 `/帮助` 命令的输出中添加：

```typescript
'**工具：**',
`- ${c('/发送文件', '/sendfile', '/send')} <路径> — 发送本地文件`,
'',
'**系统：**',
'- 启动自检：服务启动时自动执行 `.cursor/BOOT.md`',
'- 出生仪式：首次对话触发 `.cursor/BOOTSTRAP.md`（自动删除）',
'- 工作区初始化：自动复制模板文件到 `.cursor/`',
```

**Step 2: 更新状态输出**

在 `/状态` 命令中添加：

```typescript
`**工作区：** ${memoryWorkspace}`,
`**模板：** ${existsSync(resolve(TEMPLATE_DIR, 'AGENTS.md')) ? '✅ 已就绪' : '❌ 缺失'}`,
`**BOOT：** ${existsSync(resolve(memoryWorkspace, '.cursor/BOOT.md')) ? '✅' : '❌'}`,
`**BOOTSTRAP：** ${existsSync(resolve(memoryWorkspace, '.cursor/BOOTSTRAP.md')) ? '🎂 待触发' : '已完成'}`,
```

**Step 3: 测试帮助信息**

在钉钉发送 `/帮助`，检查新功能是否列出。

---

## Task 7: 更新 README 文档

**目的：** 更新钉钉版 README，说明新增功能

**Files:**
- Modify: `/Users/keunsy/work/cursor/cursor-remote-control/dingtalk/README.md:200-220`

**Step 1: 更新功能列表**

在 "功能特性" 部分添加：

```markdown
### MVP 版本（当前 v3.0）

- ✅ 文本消息处理
- ✅ 语音消息识别（本地 whisper）
- ✅ 图片下载
- ✅ 文件下载
- ✅ 项目路由
- ✅ 会话恢复（--resume）
- ✅ Markdown 响应
- ✅ **启动自检**（.cursor/BOOT.md 自动执行）
- ✅ **出生仪式**（.cursor/BOOTSTRAP.md 首次对话）
- ✅ **文件发送**（/发送文件 命令）
- ✅ **工作区模板**（自动初始化 .cursor/ 目录）
```

**Step 2: 添加使用说明**

在 "使用方式" 部分添加：

```markdown
### 文件发送

发送本地文件到钉钉：

```
/发送文件 ~/Desktop/app-debug.apk
/send ~/Documents/report.pdf
```

**支持：**
- APK/IPA
- PDF, DOC, XLS, PPT
- 图片、音视频
- 压缩包
- 最大 30MB

### 启动自检与出生仪式

**启动自检：**
- 服务启动时自动执行 `.cursor/BOOT.md`
- 检查配置、记忆、任务状态
- 可选推送结果到钉钉

**出生仪式：**
- 首次对话触发 `.cursor/BOOTSTRAP.md`
- AI 自我介绍、了解主人
- 完成后自动删除文件
```

**Step 3: 提交文档变更**

```bash
cd /Users/keunsy/work/cursor/cursor-remote-control/dingtalk
git add README.md
git commit -m "docs: 更新 README - 新增启动自检、出生仪式、文件发送功能说明"
```

---

## Task 8: 完整测试

**目的：** 端到端验证所有新功能

**Step 1: 测试工作区初始化**

```bash
# 清空测试
rm -rf /Users/keunsy/work/cursor/cursor-remote-control/.cursor
cd /Users/keunsy/work/cursor/cursor-remote-control/dingtalk
bash service.sh restart
bash service.sh logs | grep "工作区"
```

Expected: 
- 创建 `.cursor/` 目录
- 复制所有模板文件
- 创建 `BOOTSTRAP.md`

**Step 2: 测试出生仪式**

在钉钉发送：`你好`

Expected:
- AI 执行出生仪式
- 介绍自己
- 询问主人信息
- `BOOTSTRAP.md` 被删除

**Step 3: 测试启动自检**

```bash
# 编辑 BOOT.md
cat > /Users/keunsy/work/cursor/cursor-remote-control/.cursor/BOOT.md << 'EOF'
# 启动自检

检查以下项目：
1. 环境变量配置
2. 项目路由
3. 记忆系统

如果都正常，回复 "HEARTBEAT_OK"。
EOF

# 重启服务
bash service.sh restart
```

Expected: 日志显示自检完成

**Step 4: 测试文件发送**

```bash
# 创建测试文件
echo "测试文件内容" > /tmp/test-dingtalk.txt
```

在钉钉发送：`/发送文件 /tmp/test-dingtalk.txt`

Expected:
- 收到"上传中"提示
- 收到文件
- 收到"发送成功"提示

**Step 5: 验证帮助文档**

在钉钉发送：`/帮助`

Expected: 显示新功能说明

**Step 6: 验证状态信息**

在钉钉发送：`/状态`

Expected: 显示工作区、模板、BOOT、BOOTSTRAP 状态

---

## 验收标准

### 功能验收

- [ ] 工作区初始化：templates 目录存在，文件完整
- [ ] 启动时自动复制缺失的模板文件
- [ ] 首次启动创建 BOOTSTRAP.md
- [ ] 服务启动8秒后执行 BOOT.md
- [ ] 首次对话触发 BOOTSTRAP 并自动删除
- [ ] `/发送文件` 命令上传文件到钉钉
- [ ] 支持 ~/路径 和绝对路径
- [ ] 文件大小限制 30MB
- [ ] 帮助文档完整
- [ ] README 更新

### 质量验收

- [ ] 无 TypeScript 编译错误
- [ ] 日志输出清晰
- [ ] 错误处理完善
- [ ] 与飞书版逻辑一致
- [ ] 不破坏现有功能

---

## 回滚计划

如果出现问题，按以下步骤回滚：

```bash
cd /Users/keunsy/work/cursor/cursor-remote-control/dingtalk
git checkout server-minimal.ts
bash service.sh restart
```

---

## 注意事项

1. **钉钉 API 限制**
   - 文件上传需要 access_token
   - webhook 发送文件使用 media_id
   - 与飞书 API 不同

2. **模板文件位置**
   - templates/ 放在根目录（与 feishu/ 和 dingtalk/ 平级）
   - 两个服务共享模板

3. **BOOTSTRAP 删除时机**
   - 必须在 Agent 返回后删除
   - 避免在异常时删除（用户需要重试）

4. **钉钉消息格式**
   - 使用 webhook 发送
   - 不支持消息更新
   - 需要缓存 webhook

---

## 预计工时

- Task 1: 创建模板 - 30分钟
- Task 2: 工作区初始化 - 20分钟
- Task 3: 启动自检 - 15分钟
- Task 4: 出生仪式 - 20分钟
- Task 5: 文件发送 - 45分钟
- Task 6: 帮助文档 - 10分钟
- Task 7: README - 10分钟
- Task 8: 完整测试 - 20分钟

**总计：约 2.5-3 小时**
