# Telegram 快速开始指南

5 分钟配置并启动 Telegram Bot。

## 步骤 1：创建 Bot（2 分钟）

1. 打开 Telegram，搜索 **@BotFather**
2. 发送 `/newbot`
3. 输入 Bot 名称（如 `My Cursor Assistant`）
4. 输入 Bot 用户名（必须以 `bot` 结尾，如 `my_cursor_bot`）
5. 复制获得的 **Bot Token**（格式：`123456:ABC-DEF...`）

## 步骤 2：配置服务（1 分钟）

```bash
cd telegram
cp .env.example .env
```

编辑 `.env` 文件，填入 Token：

```bash
TELEGRAM_BOT_TOKEN=你的_Bot_Token
```

## 步骤 3：测试连接（30 秒）

```bash
bun run test-bot.ts
```

看到 ✅ 表示连接成功！

## 步骤 4：启动服务（30 秒）

```bash
bun run server.ts
```

看到 `[就绪] Telegram 服务已启动` 表示成功！

## 步骤 5：开始使用（1 分钟）

1. 在 Telegram 中搜索你的 Bot（@你刚才设置的用户名）
2. 点击 **Start** 或发送 `/start`
3. 直接发送消息测试：

```
你: hello
Bot: 🤔 思考中...
     [AI 回复]
```

## 🎉 完成！

现在你可以：

- 直接发送问题让 AI 回答
- 使用 `项目名:消息` 切换项目
- 发送 `/help` 查看所有命令

## 常见问题

**Q: Bot 不回复？**  
A: 检查服务是否运行，查看终端日志

**Q: Token 无效？**  
A: 重新从 @BotFather 获取，确保复制完整

**Q: 如何后台运行？**  
A: 使用 `./service.sh start`

---

需要帮助？查看 [README.md](README.md) 了解更多。
