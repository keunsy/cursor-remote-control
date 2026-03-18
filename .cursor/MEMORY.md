# 记忆系统

本文件说明记忆系统的使用方式。

## 目录

- `.cursor/memory/` - 持久化记忆存储
- `.cursor/sessions/` - 会话上下文

## 使用

- 重要上下文可写入 memory 目录
- 会话恢复依赖 sessions 目录
- 心跳时可做记忆维护
