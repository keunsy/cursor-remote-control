# 故障排查手册

## 快速诊断

### 终止任务

如果任务运行时间过长或出现问题，可以使用 `/stop` 指令终止：

**基本用法**：
```
/stop              # 自动终止（单任务）或列出所有任务（多任务）
/stop project-a    # 终止指定项目的任务
```

**行为说明**：
- **无任务**：提示"当前没有正在运行的任务"
- **单任务**：自动终止该任务，显示项目名
- **多任务**：列出所有运行中的任务，提示使用 `/stop 项目名` 指定
- **指定项目**：直接终止该项目的任务



### 服务状态检查

```bash
# 方式一：统一管理脚本
bash manage-services.sh status

# 方式二：各自检查
cd feishu && bash service.sh status
cd dingtalk && bash service.sh status
```

**正常输出**：
```
✅ feishu-cursor 正在运行 (PID: 12345)
✅ dingtalk-cursor 正在运行 (PID: 67890)
```

**异常输出**：
```
❌ feishu-cursor 未运行
```

### 查看日志

```bash
# 实时滚动查看
cd feishu && bash service.sh logs -f
cd dingtalk && bash service.sh logs -f

# 查看最近 100 行
cd feishu && bash service.sh logs | tail -100

# 查看错误日志
cd feishu && grep ERROR logs/server.log
```

## 常见问题

### 1. 服务无法启动

#### 问题：服务启动后立即退出

**症状**：
```bash
$ bash service.sh status
❌ feishu-cursor 未运行
```

**排查步骤**：

1. **查看启动日志**：
   ```bash
   cd feishu
   bash service.sh logs | head -50
   ```

2. **检查环境变量**：
   ```bash
   cat .env
   # 确认必填字段不为空
   ```

3. **手动运行测试**：
   ```bash
   bun run server.ts
   # 查看错误输出
   ```

**常见原因**：

| 错误信息 | 原因 | 解决方案 |
|---------|------|----------|
| `Cannot find module` | 依赖未安装 | `bun install` |
| `ENOENT: no such file` | 配置文件缺失 | 从 `.example` 复制 |
| `Invalid APP_ID` | 凭据错误 | 检查 `.env` 中的 `FEISHU_APP_ID` |
| `Permission denied` | 权限不足 | `chmod +x service.sh` |

#### 问题：端口被占用

**症状**：
```
Error: listen EADDRINUSE: address already in use :::3000
```

**解决方案**：

```bash
# 查找占用进程
lsof -i :3000

# 杀死进程
kill -9 <PID>

# 或修改端口（如果服务支持）
```

---

### 2. 飞书/钉钉无响应

#### 问题：机器人不回复消息

**排查清单**：

- [ ] 服务是否正在运行？
  ```bash
  bash service.sh status
  ```

- [ ] 是否正确 @ 机器人？
  - 飞书：必须 `@机器人名称 消息内容`
  - 钉钉：必须 `@机器人名称 消息内容`

- [ ] 查看实时日志：
  ```bash
  bash service.sh logs -f
  # 发送测试消息，观察是否有日志输出
  ```

- [ ] 检查网络连接：
  ```bash
  # 飞书
  curl https://open.feishu.cn
  
  # 钉钉
  curl https://api.dingtalk.com
  ```

#### 问题：飞书显示"长连接未建立"

**原因**：WebSocket 连接失败

**解决方案**：

1. **检查网络**：
   ```bash
   ping open.feishu.cn
   ```

2. **重启服务**：
   ```bash
   cd feishu
   bash service.sh restart
   ```

3. **检查防火墙**：
   ```bash
   # macOS 防火墙设置
   系统偏好设置 → 安全性与隐私 → 防火墙
   # 允许 Bun 接受传入连接
   ```

#### 问题：钉钉显示"Stream 连接失败"

**原因**：Stream API 连接失败

**解决方案**：

1. **检查凭据**：
   ```bash
   cat dingtalk/.env
   # 确认 DINGTALK_CLIENT_ID 和 DINGTALK_CLIENT_SECRET
   ```

2. **测试凭据**：
   ```bash
   curl -X POST "https://api.dingtalk.com/v1.0/oauth2/accessToken" \
     -H "Content-Type: application/json" \
     -d '{
       "appKey": "你的CLIENT_ID",
       "appSecret": "你的CLIENT_SECRET"
     }'
   ```

3. **重启服务**：
   ```bash
   cd dingtalk
   bash service.sh restart
   ```

---

### 3. Cursor CLI 相关

#### 问题：`agent: command not found`

**原因**：Cursor Agent CLI 未安装

**解决方案**：

```bash
# 安装 CLI
curl https://cursor.com/install -fsS | bash

# 验证安装
~/.local/bin/agent --version

# 登录
~/.local/bin/agent login
```

#### 问题：`API Key 无效` 或 `Invalid API Key`

**原因**：`.env` 中有无效的 `CURSOR_API_KEY`

**解决方案**：

```bash
# 1. 使用 agent login（推荐）
~/.local/bin/agent login

# 2. 注释掉 .env 中的 CURSOR_API_KEY
cd feishu  # 或 dingtalk
nano .env
# 将 CURSOR_API_KEY 行注释掉或删除：
# # CURSOR_API_KEY=your_api_key_here

# 3. 重启服务
bash service.sh restart
```

#### 问题：`团队配额已用完` 或 `Quota exceeded`

**原因**：使用高消耗模型（如 `opus-4.6-thinking`）

**解决方案**：

```bash
# 编辑 .env
cd feishu  # 或 dingtalk
nano .env

# 修改模型
CURSOR_MODEL=auto  # 或 sonnet-4

# 重启服务
bash service.sh restart
```

**模型消耗对比**：

| 模型 | 消耗 | 适用场景 |
|------|------|---------|
| `auto` | 低 | 日常对话、简单任务 |
| `sonnet-4` | 中 | 代码编写、分析 |
| `opus-4.6-thinking` | 高 | 复杂推理、架构设计 |

#### 问题：Cursor CLI 无响应或卡住

**症状**：发送消息后长时间无回复，日志显示 `Waiting for Cursor CLI...`

**排查步骤**：

1. **检查进程**：
   ```bash
   ps aux | grep agent
   # 如果有多个进程卡住，杀死它们
   pkill -f "agent.*--workspace"
   ```

2. **检查工作区路径**：
   ```bash
   cat projects.json
   # 确认路径存在且可访问
   ```

3. **手动测试 CLI**：
   ```bash
   ~/.local/bin/agent --workspace=/tmp "你好"
   # 如果失败，说明 CLI 本身有问题
   ```

4. **清理会话**：
   ```bash
   # 删除卡住的会话转录
   rm -rf /path/to/workspace/.cursor/sessions/*
   ```

---

### 4. 项目路由相关

#### 问题：`permission denied /Users/user`

**原因**：`projects.json` 中的路径错误（占位符未替换）

**解决方案**：

```bash
# 编辑 projects.json
nano projects.json

# 将 /Users/user 改为实际用户名
{
  "projects": {
    "mycode": {
      "path": "/Users/你的实际用户名/Projects/myapp",
      "description": "代码项目"
    }
  }
}

# 或使用绝对路径
{
  "projects": {
    "mycode": {
      "path": "/Users/keunsy/Projects/myapp",
      "description": "代码项目"
    }
  }
}
```

#### 问题：路由不生效，总是使用默认项目

**原因**：消息格式不正确

**正确格式**：

```
别名: 消息内容
项目名: 消息内容
test: 列出文件
```

**错误格式**：

```
别名：消息内容  # 中文冒号
别名 消息内容    # 缺少冒号
```

---

### 5. 语音识别相关

#### 问题：语音识别返回乱码或空内容

**原因**：whisper-cpp 质量较低

**解决方案**：

1. **配置火山引擎 STT**（推荐）：

   ```bash
   # 编辑 .env
   nano feishu/.env  # 或 dingtalk/.env
   
   # 添加火山 STT 配置
   VOLC_STT_APP_ID=你的APP_ID
   VOLC_STT_ACCESS_TOKEN=你的ACCESS_TOKEN
   
   # 重启服务
   bash service.sh restart
   ```

2. **检查 whisper-cpp 安装**：

   ```bash
   which whisper
   
   # 如果未安装
   brew install whisper-cpp
   ```

#### 问题：语音消息无响应

**排查步骤**：

1. **查看日志**：
   ```bash
   bash service.sh logs -f
   # 发送语音消息，观察错误
   ```

2. **检查临时目录**：
   ```bash
   ls /tmp/*.ogg /tmp/*.wav
   # 确认音频文件是否下载成功
   ```

3. **手动测试转录**：
   ```bash
   whisper /tmp/test.wav
   ```

---

### 6. 记忆系统相关

#### 问题：记忆搜索无结果

**原因**：记忆数据库未初始化或损坏

**解决方案**：

1. **检查数据库**：
   ```bash
   ls -lh /path/to/workspace/.cursor/.memory.sqlite
   # 如果文件很小（< 10KB），可能是空的
   ```

2. **重新初始化**：
   ```bash
   cd feishu  # 或 dingtalk
   bun run memory-tool.ts add "测试记忆"
   bun run memory-tool.ts search "测试"
   ```

3. **修复损坏的数据库**：
   ```bash
   sqlite3 /path/to/workspace/.cursor/.memory.sqlite
   > PRAGMA integrity_check;
   > .quit
   
   # 如果损坏，重建
   rm /path/to/workspace/.cursor/.memory.sqlite
   bun run memory-tool.ts stats  # 自动重新创建
   ```

#### 问题：`/log` 指令写入失败

**排查步骤**：

1. **检查目录权限**：
   ```bash
   ls -ld /path/to/workspace/.cursor/memory/
   # 确认可写
   ```

2. **手动创建目录**：
   ```bash
   mkdir -p /path/to/workspace/.cursor/memory
   chmod 755 /path/to/workspace/.cursor/memory
   ```

---

### 7. 定时任务相关

#### 问题：定时任务未执行

**排查步骤**：

1. **检查任务配置**：
   ```bash
   cat cron-jobs-feishu.json
   # 确认 enabled: true
   ```

2. **检查日志**：
   ```bash
   cd feishu
   grep "Scheduler" logs/server.log
   ```

3. **手动触发测试**：
   ```bash
   # 修改 nextRun 为当前时间
   nano cron-jobs-feishu.json
   # "nextRun": 当前时间戳（秒）
   
   # 等待 30 秒（Scheduler 检查间隔）
   ```

#### 问题：任务执行失败

**排查步骤**：

1. **查看错误日志**：
   ```bash
   grep "Job.*failed" logs/server.log
   ```

2. **手动测试命令**：
   ```bash
   ~/.local/bin/agent --workspace=<项目路径> "<任务命令>"
   ```

---

### 8. 文件发送相关（飞书专用）

#### 问题：`/发送文件` 报错 "文件不存在"

**原因**：路径错误或权限不足

**解决方案**：

1. **检查路径**：
   ```bash
   # 使用绝对路径
   /发送文件 /Users/keunsy/Desktop/report.pdf
   
   # 或 ~ 家目录
   /发送文件 ~/Desktop/report.pdf
   ```

2. **检查权限**：
   ```bash
   ls -l /path/to/file.pdf
   # 确认可读（r--）
   ```

#### 问题：文件上传失败

**原因**：文件过大（> 30MB）

**解决方案**：

- 压缩文件后发送
- 或使用网盘分享链接

---

## 性能问题

### 问题：响应速度慢

**排查步骤**：

1. **检查 CPU 使用率**：
   ```bash
   top -o cpu
   # 查看 agent 进程
   ```

2. **检查内存使用**：
   ```bash
   ps aux | grep agent
   ```

3. **优化模型选择**：
   ```bash
   # 改用更快的模型
   CURSOR_MODEL=auto  # 最快
   ```

### 问题：内存泄漏

**症状**：服务运行一段时间后内存占用越来越高

**排查步骤**：

1. **重启服务**：
   ```bash
   bash service.sh restart
   ```

2. **清理缓存**：
   ```bash
   # 清理临时文件
   rm /tmp/*.ogg /tmp/*.wav
   
   # 清理旧转录
   find /path/to/workspace/.cursor/sessions -mtime +30 -delete
   ```

---

## 网络问题

### 问题：无法连接到飞书/钉钉服务器

**排查步骤**：

1. **检查网络连通性**：
   ```bash
   ping open.feishu.cn
   ping api.dingtalk.com
   ```

2. **检查 DNS**：
   ```bash
   nslookup open.feishu.cn
   ```

3. **检查代理设置**：
   ```bash
   echo $HTTP_PROXY
   echo $HTTPS_PROXY
   
   # 如果有代理，在 .env 中配置
   HTTP_PROXY=http://proxy:port
   HTTPS_PROXY=http://proxy:port
   ```

---

## 日志分析

### 关键日志标记

| 标记 | 含义 |
|------|------|
| `[Feishu]` / `[Dingtalk]` | 服务来源 |
| `收到消息` | 消息接收 |
| `路由到项目` | 项目路由 |
| `启动 Cursor CLI` | CLI 启动 |
| `CLI 输出` | CLI 结果 |
| `发送回复` | 回复发送 |
| `ERROR` | 错误 |

### 常见错误日志

```bash
# 1. API Key 无效
ERROR: Invalid API Key
解决：注释掉 .env 中的 CURSOR_API_KEY，使用 agent login

# 2. 项目路径不存在
ERROR: ENOENT: no such file or directory, access '/Users/user/...'
解决：修正 projects.json 中的路径

# 3. 网络超时
ERROR: Request timeout
解决：检查网络连接，重启服务

# 4. 权限不足
ERROR: EACCES: permission denied
解决：检查文件/目录权限
```

---

## 急救措施

### 完全重置

```bash
# 1. 停止所有服务
cd feishu && bash service.sh stop
cd ../dingtalk && bash service.sh stop

# 2. 清理进程
pkill -f "bun.*server"
pkill -f "agent.*--workspace"

# 3. 清理日志
rm -rf feishu/logs dingtalk/logs

# 4. 重新安装依赖
cd feishu && bun install
cd ../dingtalk && bun install

# 5. 重启服务
cd feishu && bash service.sh start
cd ../dingtalk && bash service.sh start
```

---

## 获取帮助

### 自助排查清单

- [ ] 查看 [README.md](../README.md) - 基础配置
- [ ] 查看 [飞书文档](../feishu/README.md) - 飞书详细说明
- [ ] 查看 [钉钉文档](../dingtalk/README.md) - 钉钉详细说明
- [ ] 搜索日志中的错误信息
- [ ] 尝试手动运行 Cursor CLI

### 报告 Bug

如果问题仍未解决，请提供以下信息：

1. **系统信息**：
   ```bash
   sw_vers  # macOS 版本
   bun --version
   ~/.local/bin/agent --version
   ```

2. **服务状态**：
   ```bash
   bash manage-services.sh status
   ```

3. **错误日志**（最近 50 行）：
   ```bash
   cd feishu && bash service.sh logs | tail -50
   ```

4. **配置文件**（脱敏后）：
   ```bash
   cat projects.json
   cat feishu/.env | grep -v SECRET | grep -v KEY
   ```

5. **重现步骤**：
   - 发送了什么消息
   - 期望什么结果
   - 实际发生了什么

---

## 附录：完整诊断脚本

创建 `diagnose.sh`：

```bash
#!/bin/bash

echo "=== Cursor Remote Control 诊断 ==="
echo ""

echo "1. 系统信息"
sw_vers
echo ""

echo "2. 工具版本"
bun --version
~/.local/bin/agent --version 2>&1 | head -1
echo ""

echo "3. 服务状态"
bash manage-services.sh status
echo ""

echo "4. 配置文件"
if [ -f projects.json ]; then
  echo "✅ projects.json 存在"
else
  echo "❌ projects.json 缺失"
fi

if [ -f feishu/.env ]; then
  echo "✅ feishu/.env 存在"
else
  echo "❌ feishu/.env 缺失"
fi

if [ -f dingtalk/.env ]; then
  echo "✅ dingtalk/.env 存在"
else
  echo "❌ dingtalk/.env 缺失"
fi
echo ""

echo "5. 最近错误（飞书）"
grep ERROR feishu/logs/server.log 2>/dev/null | tail -5
echo ""

echo "6. 最近错误（钉钉）"
grep ERROR dingtalk/logs/server.log 2>/dev/null | tail -5
echo ""

echo "诊断完成！"
```

运行：
```bash
bash diagnose.sh > diagnosis.txt
# 发送 diagnosis.txt 给支持人员
```
