# .cursor 目录说明

> **注意**: `.cursor` 目录不应提交到 Git，每个用户应该有自己的个性化配置。

## 目录结构

```
.cursor/
├── *.md                    - AI 个性化配置文件
│   ├── IDENTITY.md         - AI 身份定义
│   ├── USER.md             - 用户个人信息
│   ├── SOUL.md             - AI 人格特征
│   ├── MEMORY.md           - 记忆系统配置
│   ├── HEARTBEAT.md        - 心跳检查配置
│   ├── TASKS.md            - 任务管理配置
│   ├── TOOLS.md            - 工具使用规则
│   ├── BOOT.md             - 启动配置
│   └── BOOTSTRAP.md        - 初始化配置
│
├── rules/                  - Cursor 规则文件（.mdc）
│   ├── agent-identity.mdc
│   ├── cursor-capabilities.mdc
│   ├── heartbeat-protocol.mdc
│   ├── memory-protocol.mdc
│   ├── scheduler-protocol.mdc
│   ├── soul.mdc
│   ├── tools.mdc
│   ├── user-context.mdc
│   └── workspace-rules.mdc
│
├── sessions/               - 本地对话记录（自动生成）
├── memory/                 - 记忆数据（自动生成）
└── skills/                 - 自定义技能（可选）
```

## 为什么不提交到 Git？

1. **个人化配置**
   - `USER.md` 包含用户个人信息
   - 每个人的偏好和配置不同

2. **运行时生成**
   - `sessions/` 是本地对话历史
   - `memory/` 是个人记忆数据
   - 这些在运行时自动创建

3. **本机路径**
   - 配置中可能包含本机特定的文件路径
   - 其他用户的环境不同

4. **AI 个性化**
   - AI 会根据与你的对话自动生成和更新配置
   - 每个用户应该有自己的 AI 个性

## 如何使用？

### 首次使用

1. **克隆代码后**
   ```bash
   git clone <repo-url>
   cd cursor-remote-control
   ```

2. **启动服务**
   ```bash
   # .cursor 目录会自动创建
   cd feishu && bun run start.ts
   # 或
   cd dingtalk && bun run server.ts
   # 或
   cd wecom && bun run start.ts
   ```

3. **首次对话**
   - AI 会询问你的基本信息
   - 配置文件会自动生成和填充
   - 完全个性化

### 配置文件说明

这些文件会被 Cursor AI 读取，用于个性化服务：

- **IDENTITY.md**: 定义 AI 的角色和能力范围
- **USER.md**: 记录你的姓名、偏好、常用项目
- **SOUL.md**: AI 的人格特征（友善、专业、高效等）
- **MEMORY.md**: 记忆系统的配置
- **rules/**: Cursor 的工作规则

## 开发者注意

如果你需要修改默认配置或规则：

1. **不要直接编辑 `.cursor/` 目录**
2. **在代码中通过 API 或配置文件设置默认值**
3. **使用模板系统（如果需要）**

示例：
```typescript
// 在启动脚本中设置默认配置
const defaultConfig = {
  identity: "远程 Cursor AI 助手",
  capabilities: ["代码编写", "问题排查", "项目分析"],
  // ...
};
```

## 相关配置

- **根目录 `.gitignore`**: 已配置忽略 `/.cursor/`
- **子目录 `.gitignore`**: 各平台目录也配置了忽略规则
- **环境变量**: 使用 `.env` 管理敏感配置（同样不提交）

## 常见问题

**Q: 克隆代码后没有 .cursor 目录？**  
A: 正常的！Cursor 会在首次运行时自动创建。

**Q: 我的配置会丢失吗？**  
A: 不会，本地的 `.cursor/` 目录会保留，只是不会提交到 Git。

**Q: 如何备份我的配置？**  
A: 可以手动备份 `.cursor/` 目录到其他位置。

**Q: 团队如何共享规则？**  
A: 通过代码中的配置文件（如 `projects.json`）和文档来共享规范，而非 `.cursor/` 目录。
