---
name: 移动端适配
description: Vue 3 + Element Plus 管理后台页面的移动端响应式适配。将 PC 端后台页面改造为手机可用，涵盖布局、表格、表单、弹窗、图表等所有常见组件类型。当用户提到"手机适配""移动端优化""响应式""手机端体验"或要求某页面支持手机使用时触发。
---

# 管理后台移动端响应式适配

将 PC 端 Vue 3 + Element Plus 管理后台页面改造为手机端可用，采用**同一套代码 + CSS 媒体查询 + 条件渲染**的响应式策略。

## 基础设施

项目已有的响应式基础设施，直接使用即可：

| 设施 | 路径 | 作用 |
|------|------|------|
| useResponsive composable | `@/utils/responsive.js` | 提供 `isMobile`（<768px）和 `isSmallMobile`（<480px）响应式状态 |
| SCSS 断点变量 | `src/styles/variables.scss` | `$breakpoint-sm: 768px`、`$breakpoint-xs: 480px` |
| 全局移动端基础样式 | `src/styles/index.scss` | page-container / page-header / filter-section / card 等全局组件的移动端样式 |

每个需要 JS 层响应式判断的组件，引入 `useResponsive` 获取 `isMobile`。纯 CSS 能解决的用媒体查询，不引入 JS。

## 适配策略：按组件类型

### 布局与导航

- 侧边栏：PC 端可折叠（`el-aside` 宽度切换），移动端改为 `el-drawer` 从左侧滑出
- 顶部栏：移动端添加汉堡菜单按钮触发抽屉，隐藏面包屑，精简用户信息
- page-container：移动端 `overflow-x: hidden` 防止任何子元素撑破视口

### 列表页（最常见）

**el-table → 卡片列表**：移动端条件渲染切换

- PC 端 `<el-table v-if="!isMobile">` 保持原样
- 移动端 `<div v-else class="mobile-card-list">` 用卡片展示每条记录
- 卡片结构：header（标题 + 状态标签）→ body（关键字段键值对）→ footer（操作按钮）
- 操作按钮超过 2 个时，保留主操作按钮 + `el-dropdown` 收纳其余操作

**筛选表单**：`:inline="!isMobile"` 动态切换行内/垂直布局，输入框和选择器 `width: 100%`

**分页**：`:layout="isMobile ? 'total, prev, next' : 'total, sizes, prev, pager, next, jumper'"` 精简移动端分页控件

**批量操作**：移动端无法框选，将批量操作按钮折叠到 `el-dropdown` 中

### 创建/编辑页（表单 + 预览）

- 表单 label：`:label-position` 移动端改 `top`，`:label-width` 缩窄
- 固定宽度输入框：改为 CSS class 控制 `width: 100%`
- 预览区域：移动端默认隐藏，提供浮动按钮（FAB）切换显示/隐藏
- 手机预览框（phone-preview）：移动端缩小尺寸
- 底部操作按钮（提交/取消）：移动端 `flex-direction: column`，按钮 `width: 100%`

### 详情页

- el-descriptions：`:column="isMobile ? 1 : N"` 单列展示
- **关键**：带 `border` 的 el-descriptions 在移动端必须强制 `table-layout: fixed; width: 100%`，标签列宽固定 80px，内容列 `word-break: break-all`，否则表格会溢出导致标签被视口截断
- 统计数字区：`display: grid; grid-template-columns: 1fr 1fr` 两列网格，环形图跨全行
- 操作按钮组：保留主操作 + `el-dropdown` 收纳次要操作

### 弹窗（el-dialog）

- 宽度动态绑定：`:width="isMobile ? '95%' : '600px'"`
- 全屏弹窗（如选择器）：`:fullscreen="isMobile"` 配合 `:class="{ 'mobile-dialog': isMobile }"`
- 弹窗内表单：同创建页的表单适配规则
- 弹窗 footer 按钮：移动端增大触摸区域（高度 ≥ 40px）

### 选择器组件（员工/标签/素材）

- 小屏全屏化：el-dialog 设为 fullscreen
- 搜索栏：垂直堆叠，搜索输入框 `width: 100%`
- 树形列表：节点高度增大到 44px 以上以适配手指触摸
- 已选信息：独立成行展示计数

### 数据报表 / 统计页

- 统计卡片行（flex 横排）：`flex-wrap: wrap`，每个卡片 `flex: 0 0 calc(50% - gap)`
- el-row + el-col：`:span` 动态绑定，如 `:span="isMobile ? 12 : 6"`
- ECharts 图表：高度适当缩小（320→260px），图表实例已有 resize 监听则无需额外处理
- 时间选择器 / radio-group：垂直堆叠，按钮组 `flex-wrap: wrap`

### 日历 / 网格组件

- 保持 7 列网格结构，通过缩小单元格尺寸（min-height / padding / font-size）适配
- 筛选标签栏：`overflow-x: auto; flex-wrap: nowrap` 横向滚动
- el-popover：移动端 `trigger` 改为 `click`（PC 保持 `hover`），宽度缩窄

## CSS 编写规范

### 媒体查询组织

在每个组件的 `<style scoped>` 末尾统一添加 `@media` 块，不要散落在各处：

```
// 常规样式 ...

@media (max-width: 768px) {
  // 移动端样式
}

@media (max-width: 480px) {
  // 小屏手机进一步调整
}
```

### 深度选择器

Element Plus 组件内部样式需要 `:deep()` 穿透，常见目标：

- `:deep(.el-descriptions__label)` — 描述列表标签宽度
- `:deep(.el-table)` — 表格字号、单元格间距
- `:deep(.el-form-item)` — 表单项全宽
- `:deep(.el-radio-button__inner)` — 按钮组紧凑化
- `:deep(.el-dialog__body)` — 弹窗内边距
- `:deep(.el-tree-node__content)` — 树节点触摸高度

### 移动端触摸友好

- 可点击元素最小 44×44px 触摸区域
- 按钮间距 ≥ 8px 防止误触
- 使用 `-webkit-overflow-scrolling: touch` 提升滚动流畅度

## 常见陷阱

| 陷阱 | 表现 | 修复 |
|------|------|------|
| el-descriptions 溢出 | 带 border 模式标签被左侧视口截断 | `table-layout: fixed; width: 100%` + 固定标签列宽 |
| 长文本撑破容器 | 企微 ID、URL 等长字符串溢出 | `word-break: break-all` 或 `overflow-wrap: break-word` |
| 固定宽度输入框 | `style="width: 300px"` 超出移动端宽度 | 改为 CSS class，移动端 `width: 100%` |
| el-popover hover 不可用 | 手机无 hover 事件 | `:trigger="isMobile ? 'click' : 'hover'"` |
| 弹窗太窄看不清 | 宽度写死 px | `:width="isMobile ? '95%' : '600px'"` |
| page-container 横向滚动 | 子元素撑出视口 | 容器 `overflow-x: hidden` |

## 工作流程

1. **读取目标页面** — 理解模板结构、使用了哪些 Element Plus 组件
2. **引入 useResponsive** — 在 script setup 中获取 `isMobile`
3. **改造模板** — 按上述组件类型策略添加条件渲染和动态属性绑定
4. **添加移动端 CSS** — 在 style 末尾添加媒体查询块
5. **ReadLints 检查** — 确认无语法错误
6. **构建部署** — `docker compose build <service> && docker compose up -d <service>`

## 不做的事

- 不创建独立的移动端页面/路由 — 同一套代码响应式适配
- 不引入额外 CSS 框架（Tailwind 等）— 使用 SCSS + Element Plus 即可
- 不过度设计 — 管理后台手机端是辅助使用场景，核心体验保证可用即可
- 不改变业务逻辑 — 纯视觉层改造，不动 API 调用和数据处理
