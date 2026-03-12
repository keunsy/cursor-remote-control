# feishu-cursor-claw 故障排查案例

> 真实案例：飞书收不到消息事件的完整排查过程

## 案例背景

**环境信息**：
- 项目：feishu-cursor-claw
- 用户账号：个人创建的飞书企业（未认证）
- Cursor配额：slow pool（需使用 `CURSOR_MODEL=auto`）

**问题现象**：
- ✅ 本地服务正常启动
- ✅ WebSocket 长连接成功建立（日志显示 `ws client ready`）
- ✅ 飞书后台配置看似完成（权限、事件订阅、应用发布）
- ✅ 飞书发消息显示"已送达"，无失败标识
- ❌ 服务日志中完全没有 `[事件] 收到 im.message.receive_v1`
- ❌ 机器人没有任何回复

---

## 排查过程

### 第一步：验证本地代码和配置

#### 检查项：
1. ✅ `.env` 配置正确
   - `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET` 已填写
   - `CURSOR_MODEL=auto`（因配额限制）

2. ✅ `projects.json` 存在且配置正确
   ```json
   {
     "projects": {
       "remote-control": {
         "path": "/Users/user/work/cursor/remote-control",
         "description": "远程控制分析项目"
       }
     },
     "default_project": "remote-control"
   }
   ```

3. ✅ 服务启动日志正常
   ```
   [info]: ws client ready
   飞书长连接已启动，等待消息...
   ```

4. ✅ 代码中事件注册正确
   ```typescript
   dispatcher.register({
     "im.message.receive_v1": async (data) => {
       console.log("[事件] 收到 im.message.receive_v1");
       // ... 处理逻辑
     }
   });
   ```

**结论**：本地代码和配置无问题，问题在飞书后台。

---

### 第二步：检查飞书后台配置

#### 检查项：

1. ✅ 应用类型：企业自建应用
2. ✅ 机器人能力：已添加
3. ✅ 权限管理：已开通（但后来发现权限不全 ⚠️）
4. ✅ 事件订阅：
   - 订阅方式：长连接模式 ✅
   - 订阅事件：`im.message.receive_v1` ✅
   - **筛选条件**：`Or 只发送由新用户发送` ❌ **问题所在！**
5. ✅ 应用发布：已上线

**初步判断**：配置看似完整，但实际有隐藏问题。

---

### 第三步：查看飞书服务端日志 🔍 关键

访问：飞书开放平台 → 开发工具 → 日志检索

**发现**：
- ✅ 有 `tenant_access_token` 认证请求（SUCCESS）
- ❌ **零条 `im.message.receive_v1` 事件推送记录**
- ❌ 失败次数：0，成功次数：0（完全没有推送）

**关键结论**：
```
飞书服务器从未尝试推送消息事件！
不是推送失败，而是压根就没推送。
```

---

### 第四步：深入分析飞书后台配置

重新仔细检查"事件与回调"页面，发现两个问题：

#### 问题1：事件订阅有筛选条件 ⚠️

**发现**：
```
事件名称：im.message.receive_v1
筛选范围：Or 只发送由新用户发送（含自动回复）
```

**分析**：
- 用户不符合"新用户"条件
- 飞书服务器根据筛选条件决定不推送事件
- 这就是为什么日志中完全没有推送记录！

#### 问题2：权限配置不完整 ⚠️

**发现**：
在"权限管理"页面，用户标记了需要添加的权限：
- `im:message.group_at_msg:readonly` - 获取群组中@机器人的消息
- `im:message.p2p_msg:readonly` - 接收单聊消息
- `im:message.group_msg` - 获取群组中的所有消息

**分析**：
之前可能只勾选了部分权限，导致某些消息类型收不到。

---

## 解决方案

### 方案一：修改事件订阅筛选条件

1. 飞书开放平台 → "事件与回调"
2. 找到 `im.message.receive_v1`，点击"删除事件"
3. 点击"添加事件"
4. 重新添加 `im.message.receive_v1`
5. **关键**：不设置任何筛选条件（或选择"接收所有消息"）
6. 点击"保存"

### 方案二：补充完整权限

1. 飞书开放平台 → "权限管理"
2. 确保勾选以下权限：
   - ✅ `im:message` - 获取与发送单聊、群组消息
   - ✅ `im:message.p2p_msg:readonly` - 接收单聊消息
   - ✅ `im:message.group_at_msg:readonly` - 获取群组@消息
   - ✅ `im:message.group_msg` - 获取群组所有消息
   - ✅ `im:resource` - 获取与上传图片或文件
3. 点击"保存"

### 方案三：重新发布应用

1. 飞书开放平台 → "应用发布" → "版本管理与发布"
2. 创建新版本（例如：1.0.3）
3. 提交审核
4. 审核通过后点击"上线"
5. 等待 5 分钟（飞书后台同步）

### 方案四：重启服务测试

```bash
# 停止服务
pkill -f "bun.*server"

# 启动服务
cd /Users/user/work/cursor/feishu-cursor-claw
bun run server.ts
```

---

## 验证结果

修改配置并重启服务后，再次发送消息：

### 成功日志：
```
[事件] 收到 im.message.receive_v1
[解析] type=text chat=p2p text="测试" img= file=
[Agent] 调用 Cursor CLI workspace=/Users/user/work/cursor/remote-control model=auto
[2026-03-11T05:59:34.585Z] 完成 [remote-control] model=auto elapsed=17秒 (33 chars)
```

### 飞书服务端日志：
现在可以看到 `im.message.receive_v1` 事件推送记录，状态为 SUCCESS。

---

## 问题根源总结

### 直接原因：
1. **事件订阅筛选条件设置错误**：设置了"只发送由新用户发送"，导致不符合条件的消息被过滤
2. **权限配置不完整**：缺少某些必要的权限，导致部分消息类型无法接收

### 表现特征：
- WebSocket 连接正常（误导性强）
- 飞书后台配置看似完整（误导性强）
- 飞书服务器从不推送事件（关键证据）
- 用户消息正常发送（无失败标识）

### 为什么难以排查：
1. ✅ 本地服务运行正常，日志无报错
2. ✅ WebSocket 连接成功，`ws client ready`
3. ✅ 飞书后台各项配置都"已完成"
4. ❌ 唯一线索：飞书服务端日志中完全没有推送记录
5. ❌ 筛选条件是个不起眼的配置项，容易被忽略

---

## 经验教训

### 1. 飞书服务端日志是关键
**必须检查飞书开放平台的日志检索功能**，确认飞书服务器是否真的推送了事件。

### 2. 注意隐藏的筛选条件
事件订阅时，**不要设置任何筛选条件**，除非你明确知道筛选规则。

### 3. 权限要配置完整
不要只勾选最基本的权限，根据实际需求勾选所有相关权限。

### 4. 配置修改后要重新发布
飞书后台的配置修改（权限、事件订阅）后，**必须重新发布应用**才能生效。

### 5. 企业认证不是必须的（针对本案例）
虽然怀疑过是"未认证企业"的限制，但最终证明不是认证问题，而是配置问题。

---

## 快速排查清单

遇到"飞书收不到消息"问题时，按此清单逐一检查：

### 本地服务
- [ ] 服务正常启动
- [ ] 日志显示 `ws client ready`
- [ ] `.env` 配置正确
- [ ] `projects.json` 存在

### 飞书服务端日志（最重要！）
- [ ] 访问"日志检索"功能
- [ ] 筛选 `im.message.receive_v1` 事件
- [ ] 检查是否有推送记录

### 如果没有推送记录：

#### 权限管理
- [ ] `im:message` 已开通
- [ ] `im:message.p2p_msg:readonly` 已开通
- [ ] `im:message.group_at_msg:readonly` 已开通
- [ ] `im:message.group_msg` 已开通（如需群聊）
- [ ] `im:resource` 已开通

#### 事件订阅
- [ ] 订阅方式：长连接模式
- [ ] 订阅事件：`im.message.receive_v1` 已添加
- [ ] **筛选条件：无筛选或"接收所有消息"** ⚠️
- [ ] 配置已保存

#### 应用发布
- [ ] 最新版本状态："已上线"
- [ ] 版本创建时间 > 配置修改时间
- [ ] 如不满足，重新创建版本并发布

### 如果有推送记录但本地收不到：
- [ ] 检查本地代码事件注册
- [ ] 检查 WebSocket 连接是否真的活着
- [ ] 重启服务

---

## 参考资料

- 飞书开放平台文档：https://open.feishu.cn/document/
- feishu-cursor-claw 项目：https://github.com/nongjun/feishu-cursor-claw
- Lark SDK 文档：https://github.com/larksuite/oapi-sdk-nodejs

---

**案例记录时间**：2026-03-11  
**解决耗时**：约 2 小时（完整排查过程）  
**问题严重程度**：高（影响核心功能）  
**难度等级**：★★★★☆（误导性强，需要深入分析）
