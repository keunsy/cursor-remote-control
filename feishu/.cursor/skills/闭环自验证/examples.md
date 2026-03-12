# 闭环自验证 — 场景示例

## 示例 1：修复前端按钮点击无响应的 Bug

### 背景
用户报告：联系人管理页面的"保存"按钮点击无反应。

### 验证循环

**第 1 轮：修改代码并验证**

```
1. 定位 Bug → 发现 onClick handler 绑定错误
2. 修改代码 → 修正事件绑定
3. 构建验证：
   docker logs contact-frontend --tail 10
   → ✅ 编译成功，无错误

4. UI 验证：
   browser_navigate → https://contact.example.com/contacts
   browser_snapshot → 确认"保存"按钮存在
   browser_click → 点击"保存"按钮
   browser_snapshot(includeDiff: true) → 检查页面变化
   browser_console_messages → 检查控制台
   → ❌ 发现控制台报 TypeError: Cannot read property 'id' of undefined

5. 定位问题 → 发现表单数据未正确传递
```

**第 2 轮：再次修复并验证**

```
1. 修复表单数据传递逻辑
2. 构建验证 → ✅
3. UI 验证：
   browser_navigate → 目标页面
   browser_fill → 填写表单
   browser_click → 点击"保存"
   browser_console_messages → ✅ 无错误
   browser_network_requests → ✅ POST /api/contacts 返回 200
   browser_snapshot(includeDiff: true) → 页面显示"保存成功"提示
4. 系统验证：
   docker logs contact-backend --since 2m
   → ✅ 日志显示正常的数据库写入

验证结果：✅ 通过（第 2 轮）
```

---

## 示例 2：后端 API 新增接口

### 背景
为朋友圈模块新增批量删除接口 `DELETE /api/moments/batch`。

### 验证循环

```
1. 编写接口代码
2. 构建验证：
   docker compose up --build -d moment-backend
   docker ps --filter "name=moment-backend"
   → ✅ 容器 Up，无 Restarting

3. 静态检查：
   ReadLints → ✅ 无新增错误

4. 系统验证（完整）：
   # 健康检查
   curl -s -o /dev/null -w "%{http_code}" https://moment.example.com/api/health
   → 200

   # 接口调用测试
   curl -X DELETE https://moment.example.com/api/moments/batch \
     -H "Content-Type: application/json" \
     -d '{"ids": [1, 2, 3]}'
   → 200, {"deleted": 3}

   # 日志检查
   docker logs moment-backend --since 2m 2>&1 | grep -iE "error|exception"
   → 无匹配

   # 响应时间
   curl -s -o /dev/null -w "%{time_total}" https://moment.example.com/api/moments/batch
   → 0.15s

5. UI 验证（轻量）：
   browser_navigate → 朋友圈管理页
   browser_console_messages → ✅ 无错误

验证结果：✅ 通过（第 1 轮）
```

---

## 示例 3：Docker/Nginx 配置变更

### 背景
为新服务添加 Nginx 反向代理配置。

### 验证循环

```
1. 编写 Nginx conf 文件
2. 构建验证：
   docker exec nginx_proxy nginx -t
   → ✅ syntax is ok

   docker exec nginx_proxy nginx -s reload
   docker logs nginx_proxy --since 1m
   → ✅ 无错误

3. 系统验证（完整）：
   # HTTPS 可达
   curl -s -o /dev/null -w "%{http_code}" https://new-service.example.com
   → 200

   # SSL 证书
   curl -vI https://new-service.example.com 2>&1 | grep "subject:"
   → ✅ 证书正确

   # 反向代理到正确后端
   curl -s https://new-service.example.com/api/health
   → {"status": "ok"}

4. UI 验证（轻量）：
   browser_navigate → https://new-service.example.com
   browser_snapshot → 确认页面正常加载
   browser_console_messages → ✅ 无混合内容警告

验证结果：✅ 通过
```

---

## 示例 4：全栈变更 — 新增数据列表页

### 背景
联系人模块新增"标签管理"页面，含前端列表+后端 CRUD API。

### 验证循环

```
1. 后端：编写 CRUD 接口
2. 前端：编写列表页组件
3. 构建验证：
   docker compose up --build -d contact-backend contact-frontend
   docker ps --filter "name=contact"
   → ✅ 两个容器均 Up

4. 静态检查：
   ReadLints → ✅

5. 系统验证（完整 — 后端为主）：
   curl https://contact.example.com/api/tags
   → 200, [{"id":1,"name":"VIP"}, ...]

   docker logs contact-backend --since 3m | grep -iE "error"
   → 无匹配

6. UI 验证（完整 — 前端为主）：
   browser_navigate → https://contact.example.com/tags
   browser_snapshot → 确认表格组件存在，数据行已渲染
   browser_click → 点击"新增标签"按钮
   browser_fill → 填写标签名
   browser_click → 点击"确定"
   browser_snapshot(includeDiff: true) → 新标签出现在列表中
   browser_console_messages → ✅ 无错误
   browser_network_requests → GET /api/tags 200, POST /api/tags 201

验证结果：✅ 通过
```
