# 心跳检查清单

由 AI 按心跳触发时执行，无事则回复 `HEARTBEAT_OK`。

## 检查项

- [ ] 读取本文件，按项执行（不凭空推断、不重复旧任务）
- [ ] 检查 `.cursor/memory/` 近期上下文，需时做后台维护
- [ ] 清单过时时更新本文件；无需关注则仅回复 `HEARTBEAT_OK`

## 说明

- 本清单为初始模板，后续可由 AI 根据项目需要增删改。
- 状态追踪见 `.cursor/memory/heartbeat-state.json`（由心跳逻辑维护）。
