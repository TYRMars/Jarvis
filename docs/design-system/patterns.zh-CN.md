# Patterns

跨组件的版式与交互模式。每个模式都出现在多个组件中——把它们成文化，
就是新页面在不需要重新推导的情况下也能保持一致的关键。

## 三栏网格（Three-column grid）

应用外壳是带命名区域的 CSS Grid：

```css
#app {
  display: grid;
  grid-template-columns: var(--sidebar-width) minmax(0, 1fr) var(--rail-width);
  grid-template-areas: "sidebar chat rail";
  height: 100vh;
}
```

源码：[styles.css:217–253](../../apps/jarvis-web/src/styles.css)。

**为什么用命名区域.** 不命名时，`display: none` 隐藏 sidebar 会让剩
余子项通过 auto-placement 算法向左挤——chat 会落到（零宽的）sidebar
槽位里。命名区域把每个 pane **固定**到某一列，即使兄弟节点被隐藏也
不会跑位。

**修饰类.**

| `body` 上的 class | 效果 |
|---|---|
| `.workspace-rail-closed` | rail 列收缩为 `0`（chat 扩展）|
| `.sidebar-closed` | sidebar 列收缩为 `0`（chat 向左扩展）|

| `#app` 上的 class | 效果 |
|---|---|
| `.page-app` | 完全去掉 rail（Settings、Docs 用）|

**组合规则.**

- sidebar **始终**挂载，除非路由属于 page-app 集合；折叠 sidebar 是
  动画 width 到 0、不卸载。
- rail **按路由切换**——Chat 默认开、Projects 隐藏、Settings 直接去
  掉（`.page-app`）。
- 宽度变化在 `#app` 上使用 `transition: grid-template-columns 200ms
  ease-out`；resize handle 拖拽**绕过 transition**以获得即时响应。

## Resize handle

sidebar（右边缘）与 approvals rail（左边缘）都可以拖拽调宽。

**几何.**

| 属性 | 取值 |
|---|---|
| width | 4px |
| 命中区域 width | 12px（通过负 `margin-left` / `padding` 实现）|
| cursor | `col-resize` |
| 背景 | transparent |
| hover 背景 | `--accent-primary` 0.4 alpha |
| active（拖拽中）背景 | `--accent-primary` 0.6 alpha |
| transition | `background 120ms ease` |

**拖拽边界.**

| Pane | min | max | 持久化键 |
|---|---|---|---|
| Sidebar | 240px | 500px | `--sidebar-width`（同时存 localStorage）|
| Rail | 320px | 800px | `--rail-width`（同时存 localStorage）|

**重置.** 双击 handle 重置为默认值（328 / 540）。

## 空态（Empty states）

列表 / 看板 / 搜索结果为空时，渲染**空态卡片**，不要直接打一行
「No items」。

**形态.**

| 属性 | 取值 |
|---|---|
| 居中 | 在父容器中绝对居中（flex column、justify-center、align-center）|
| max-width | 360px |
| gap | 元素间 12px |

**顺序（从上到下）.**

1. 可选 32×32 单色 SVG 图标，`--text-soft`。
2. 标题 —— `--fs-15`、字重 560、`--text-default`。一行。
3. 提示 —— `--fs-13`、`--text-muted`、line-height 1.5。一句话。
4. 可选 CTA —— 主按钮，`--accent-primary`。仅当存在唯一明显的下一
   步操作时使用（如「新建对话」）。

**Don't.** 不要画插图；不要写「Oops!」/「看起来…」；不要为 200ms 的
loading 闪现展示空态——至少等 500ms 再从骨架切换到空态。

## Loading 状态（Loading states）

三种模式，按推荐顺序：

1. **原地 spinner** —— 用于 < 2 秒就完成的操作（发送消息、保存设
   置）。把按钮文字替换为 14px spinner，**保持按钮宽度不变**避免布
   局抖动。
2. **骨架行** —— 用于可能更慢的列表。背景用 `--surface-panel-raised`
   + shimmer 动画（`prefers-reduced-motion` 下禁用）。
3. **行内进度文本** —— 用于流式 agent 输出。**现有的 token-by-token
   渲染本身就是模式**——不要在它之上再叠 spinner。

每一种 loading 状态都**必须为最终内容预留空间**——见
[accessibility.zh-CN.md#内容跳动content-jumping](accessibility.zh-CN.md#内容跳动content-jumping)。

## Markdown 渲染（Markdown rendering）

chat 与 requirement detail 视图通过 `@ant-design/x-markdown`
（chat）与自定义 `MarkdownLite`（项目描述）渲染 markdown。

**块级规则.**

| 元素 | 处理 |
|---|---|
| `h1` | `--fs-22`（= 20px）、字重 700、上 24px、下 12px |
| `h2` | `--fs-18`（= 16px）、字重 660、上 20px、下 8px |
| `h3` | `--fs-16`（= 15px）、字重 660、上 16px、下 4px |
| `p` | `--fs-14`、line-height 1.6、margin 0 0 12px |
| `ul` / `ol` | 缩进 24px，行间 4px |
| `blockquote` | 左 3px `--border-default` 边框、padding-left 12px、颜色 `--text-muted` |
| `code`（行内）| `--font-mono`、`--fs-13`、padding 1px 6px、背景 `--surface-panel-raised`、radius 4px |
| `pre` | `--font-mono`、`--fs-13`、padding 12px、背景 `--pre-bg`、radius 8px、line-height 1.5、溢出可滚 |
| `a` | `--text-default`、hover 时下划线；visited 不变样 |
| `hr` | 1px `--border-soft`、margin 24px 0 |
| `table` | 细边 `--border-default`、表头背景 `--surface-panel-raised` |

**Don't.** 不要把图片标签全宽渲染——max 360px、点击放大。**不要**给
正文中的裸 URL 自动加链接——只对 `<URL>` 与 `[label](URL)` 形式应用
链接样式。

## Diff viewer

被 `FsEditDiff`、`UnifiedDiffViewer`、workspace commit 对话框使用。

**容器.** 与 `ToolBlock` 主体形态一致——`--font-mono`、`--fs-13`、
line-height 1.5。

**行级 class.**

| Class | 背景 | 标记 |
|---|---|---|
| addition | `rgba(47, 156, 74, 0.10)` | `+` `--accent-success`、mono |
| deletion | `rgba(201, 77, 69, 0.10)` | `-` `--accent-danger`、mono |
| context | 无 | 无 |
| hunk header | `--surface-panel-raised` | `@@ … @@` `--text-muted` |

**字级高亮**（已计算时）：嵌套 span，背景为
`rgba(47, 156, 74, 0.20)` / `rgba(201, 77, 69, 0.20)`。**不要再深**
——行级 + 字级叠加约 30% alpha 仍可阅读。

**Don't.** 不要做字符级 diff（`a` → `b` 字符闪动）。不要在行内渲染
> 5000 行——做虚拟化或分页。

## 键盘契约（Keyboard contracts）

项目级快捷键。新增请在此登记：

| 按键 | 动作 | 作用域 |
|---|---|---|
| `⌘K` | 打开 quick switcher | 全局 |
| `⌘P` | 模型选择器 | chat 面板聚焦时 |
| `⌘\` | 切换 sidebar | 全局 |
| `⌘.` | 切换 rail | 全局 |
| `Esc` | 关闭 modal / quick switcher / 上下文菜单 | 浮层 |
| `Tab` / `Shift+Tab` | 焦点在交互元素间移动 | 全局 |
| `↑` / `↓` | 在 quick switcher / 模型选择器列表中导航 | 浮层 |
| `Enter` | 激活当前焦点项 / 发送 composer | 上下文敏感 |
| `Shift+Enter` | composer 中换行 | composer |
| `⌘↵` | 发送 composer（Enter 替代）| composer |
| `⌘E` | 编辑最近一条用户消息 | chat |
| `⌘R` | 重跑最近一回合 assistant | chat |

**规则.** 每个浮层（modal、popover、quick switcher）**必须**支持
`Esc` 关闭。每个列表在键盘聚焦时**必须**支持方向键导航。

## 持久化模式（Persistence patterns）

UI 控件的状态如果应该跨刷新保留（sidebar 宽度、主题、上次路由、
sidebar / rail 可见性），通过 `localStorage` 持久化，**前缀 `jarvis.`**：

| 键 | 值 | 使用方 |
|---|---|---|
| `jarvis.theme` | `"light"` \| `"dark"` \| `"system"` | 主题切换 |
| `jarvis.sidebar.width` | px 整数 | sidebar resize |
| `jarvis.rail.width` | px 整数 | rail resize |
| `jarvis.sidebar.closed` | `"1"` \| 不存在 | sidebar 切换 |
| `jarvis.rail.closed` | `"1"` \| 不存在 | rail 切换 |

应用级 state 通过 `zustand` + persist 中间件管理（见
`apps/jarvis-web/src/store/`）；只有不需要 React 响应的 layout / 偏好
state 才直接走 `localStorage`。

## 主题切换（Theme switching）

主题通过 `<html>` 上的 `data-theme` 属性切换。运行时阶梯：

1. 组件读 `localStorage.getItem('jarvis.theme')`，缺省时解析为
   "system"。
2. "system" → 查询 `prefers-color-scheme` 并监听变化。
3. 应用 `<html data-theme="dark">` 或移除属性。
4. `:root[data-theme="dark"]` 中的 CSS 变量级联生效。

**规则.** **绝不**在 JS 层判断主题值（「if dark, show X」）——主题
是表现层关切、逻辑两套主题相同。如果某功能确实需要按主题切不同内容
（罕见，仅整图素材级场景），用一个 `<picture>` 或 CSS
`prefers-color-scheme` media query。

## 密度（Density）

Jarvis 故意做密。维持它：

- 14px 正文（不是 16）。
- 32–34px 行高（不是 40+）。
- 卡片间隔 12px（不是 16+）。
- 列表行内**不要**写 padding 24px。

如果某屏幕「太挤」，先修排版层级（字号 / 字重对比），不要加间距——
拉大间距会稀释「工作台」感。

## 响应式断点（Responsive breakpoints）

当前情况：项目**几乎不做响应式**，Web 客户端目标桌面（≥1024px）。
此宽度以下布局会塌陷得不太好——已知限制、单独追踪。

如果某个新页面确实需要在平板上工作：

| 断点 | 行为 |
|---|---|
| ≥1280px | 三栏完整，含两个 rail |
| 1024–1279px | 默认隐藏 rail，sidebar 缩到 280px |
| 768–1023px | sidebar 浮层（push-out drawer），rail 关 |
| <768px | 移动哨兵——「请在桌面打开」 |

**未经 UX 评审，不要发布移动端专项变更。**
