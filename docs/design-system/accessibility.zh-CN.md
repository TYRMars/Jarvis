# Accessibility

让 Jarvis 对键盘用户、屏幕阅读器用户、低视力用户——以及对动效敏感、
连接缓慢的用户——保持可用。底线是 **WCAG 2.1 AA**，能做到 AAA 就做。

## 对比度审计（Contrast audit）

所有前景 / 背景对都按 WCAG 相对亮度公式计算。**AA 阈值：普通文字
4.5:1、大字（≥18px 或 ≥14px 加粗）和图形对象 3:1。**

### 明亮主题（Light theme）

| 前景 | 背景 | 比 | 通过 |
|---|---|---|---|
| `--text` `#262624` | `--bg` `#ffffff` | 14.39:1 | AAA |
| `--text` `#262624` | `--sidebar-bg` `#fafafa` | 13.36:1 | AAA |
| `--text` `#262624` | `--panel-raised` `#f6f6f5` | 12.78:1 | AAA |
| `--text-muted` `#5f5d58` | `--bg` `#ffffff` | 6.45:1 | AA / AAA-large |
| `--text-muted` `#5f5d58` | `--sidebar-bg` `#fafafa` | 5.99:1 | AA |
| `--text-muted` `#5f5d58` | `--panel-hover` `#eeeeec` | 5.20:1 | AA |
| `--text-soft` `#8d8a83` | `--bg` `#ffffff` | 3.43:1 | **❌ 未达 AA** |
| `--text-soft` `#8d8a83` | `--sidebar-bg` `#fafafa` | 3.18:1 | **❌ 未达 AA** |
| `--placeholder` `#aaa6a0` | `--input-bg` `#ffffff` | 2.55:1 | **❌ 未达 AA** |
| `--text` 落于 `--accent`（`#262624` on `#d87948`）| — | 6.15:1 | AA |
| `--accent-contrast` 落于 `--accent`（`#23140c` on `#d87948`）| — | 5.31:1 | AA |
| `--accent-success` `#2f9c4a` 落于 `--bg` `#ffffff` | — | 3.50:1 | 仅 AA-large |
| `--accent-danger` `#c94d45` 落于 `--bg` `#ffffff` | — | 4.29:1 | **❌ 未达 AA**（接近）|
| `--accent-info` `#397fd6` 落于 `--bg` `#ffffff` | — | 4.39:1 | **❌ 未达 AA**（接近）|

### 深色主题（Dark theme）

| 前景 | 背景 | 比 | 通过 |
|---|---|---|---|
| `--text` `#d6d2cb` | `--bg` `#090909` | 13.85:1 | AAA |
| `--text` `#d6d2cb` | `--sidebar-bg` `#121212` | 12.70:1 | AAA |
| `--text-muted` `#9c978f` | `--bg` `#090909` | 7.88:1 | AAA |
| `--text-muted` `#9c978f` | `--sidebar-bg` `#121212` | 7.22:1 | AAA |
| `--text-soft` `#69655f` | `--bg` `#090909` | 3.45:1 | **❌ 未达 AA**（仅 3:1 大字）|
| `--text-soft` `#69655f` | `--sidebar-bg` `#121212` | 3.16:1 | **❌ 未达 AA** |
| `--placeholder` `#5f5f5f` | `--input-bg` `#1c1c1c` | 3.62:1 | **❌ 未达 AA** |
| `--accent-success` `#5ebf67` 落于 `--bg` `#090909` | — | 7.58:1 | AAA |
| `--accent-danger` `#d25a55` 落于 `--bg` `#090909` | — | 4.93:1 | AA |
| `--accent-info` `#4da2ff` 落于 `--bg` `#090909` | — | 7.21:1 | AAA |

### 建议替换值（Recommended replacements）

下表为建议值。**本次 PR 不应用**——仅在此处先备案，后续专项 PR 一次
性切换。

| Token | 主题 | 当前 | 建议 | 新比 |
|---|---|---|---|---|
| `--text-soft` | 明亮 | `#8d8a83` | `#76736c` | 4.74:1 vs `#fafafa` |
| `--text-soft` | 深色 | `#69655f` | `#878177` | 5.10:1 vs `#121212` |
| `--placeholder` | 明亮 | `#aaa6a0` | `#8d8a83` | 3.43:1 vs `#fff`（AA-large）—— placeholder 在 AA 中可豁免，但仍应过 3:1 |
| `--placeholder` | 深色 | `#5f5f5f` | `#7a7a7a` | 4.62:1 vs `#1c1c1c` |
| `--accent-danger` | 明亮 | `#c94d45` | `#b53d36` | 5.07:1 |
| `--accent-info` | 明亮 | `#397fd6` | `#2563c4` | 5.13:1 |

切换时所有使用这些 token 的组件都需视觉走查——soft / placeholder 改
变不大，但 danger / info 改变明显。在
[README.zh-CN.md#待整改open-follow-ups](README.zh-CN.md#待整改open-follow-ups) 追踪。

### 现状下的缓解措施（Mitigations available now）

在值正式更换前，组件可以这样规避最糟情况：

- **不要把 `--text-soft` 用于正文。** 它只用于第三层注解。保留给：
  时间戳、「N 多」计数、kbd 提示页脚——**不要**用于行内标签或列表
  项。
- **不要把 `--text-soft` 用在 `--sidebar-bg` 上。** 上表两对都未达
  AA。sidebar 元数据用 `--text-muted`。
- **走「加粗 / 大字」豁免。** 状态 chip 在字重 560 + 字号 11px 时
  接近边缘——14/700 或 18/normal 的大字阈值更稳；chip 文字处于灰
  色地带，请额外校验。

## Focus ring

**标准.**

```css
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
```

**规则.**

1. **绝不** `outline: none` 而不补替代可见指示。如果设计需要自定义
   指示（例如改用边框颜色而非 outline），它**仍必须**对周围背景达
   到 3:1 对比。
2. 用 `:focus-visible`、不要用 `:focus`——鼠标点击的按钮不应显示
   focus ring。
3. 2px outline-offset **不可让步**——保证小尺寸目标上的 ring 仍可
   阅读。
4. 明亮主题下 `--accent` `#d87948` 落于 `--bg` `#ffffff` 是 2.05:1
   ——**未达 3:1 图形对象对比度**。`outline-offset: 2px` 让 ring 不
   直接坐在元素上，而是与「元素与 ring 之间的间隙背景」对比——这个
   背景是 `--bg` 或元素所在表面，相对仍可读。这是已知软点——对高利
   害关系的元素（composer、modal 主操作），可叠加 `--shadow-soft`
   增强权重。

## 键盘导航（Keyboard navigation）

完整快捷键见
[patterns.zh-CN.md#键盘契约keyboard-contracts](patterns.zh-CN.md#键盘契约keyboard-contracts)。
可访问性专项规则：

- **Tab 顺序对齐视觉顺序.** 不用 `tabindex >= 1`。`0` 是「加入自然
  顺序」、`-1` 是「移出自然顺序」。
- **Skip-link.** 每页第一个可聚焦元素应该是「Skip to main content」
  链接（**当前缺失**——已记入 open follow-ups）。
- **Modal 焦点圈陷.** modal 打开时焦点移到首个交互元素；`Tab` 在
  modal 内循环；`Esc` 关闭并把焦点还给触发器。
- **恢复焦点.** 关闭 popover / dropdown 后焦点回到触发器。

## `prefers-reduced-motion`

每条 CSS transition 与 animation **必须**在
`prefers-reduced-motion: reduce` 下被取消。

**机制.** 全局样式表外层包裹：

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0ms !important;
    scroll-behavior: auto !important;
  }
}
```

**单组件规则.**

- 骨架 shimmer 动画：完全关掉（用静态 `--surface-panel-raised`）。
- 新消息到达时的自动滚动：**仍滚**，但即时（`behavior: 'auto'` 而非
  `'smooth'`）。
- spinner：保留，但减半旋转速度——spin 是信息性而非装饰性，慢一些
  不会显得卡顿。

## 内容跳动（Content jumping）

异步加载内容时，**预留最终内容空间**——避免页面在数据回来时跳动。

- 列表加载用骨架行（高度匹配最终行高）。
- 头像加载用相同尺寸占位方块（`--surface-panel-raised`）。
- 折叠 / 展开内容时，使用 `aria-expanded` 通知屏幕阅读器，不要直接
  替换 DOM。

## icon-only 按钮（Icon-only buttons）

**没有可见文字的按钮一律带 `aria-label` 描述其动作。** 当前
`.ghost-icon` 的核对清单：

| 组件 | 动作 | 必备 `aria-label` |
|---|---|---|
| Sidebar 折叠 | 切换 sidebar | "Collapse sidebar" / "Expand sidebar" |
| Sidebar 新建 chat | 新建对话 | "New conversation" |
| Sidebar 搜索 | 打开 quick switcher | "Search" |
| Workspace badge | 打开最近文件夹 | "Switch workspace" |
| Composer 发送 | 发送消息 | "Send message" |
| Composer 附件 | （计划中）| "Attach file" |
| Tool block 展开 | 切换 tool 详情 | "Show tool detail" / "Hide tool detail" |
| Approval 卡片 approve | approve tool 调用 | "Approve {tool name}" |
| Approval 卡片 deny | deny tool 调用 | "Deny {tool name}" |
| User 气泡 编辑 | 编辑消息 | "Edit message" |
| Assistant 气泡 复制 | 复制文本 | "Copy message" |
| Modal 关闭 | 关闭对话框 | "Close" |
| 主题切换 | 切换主题 | "Switch to dark" / "Switch to light" |

当动作依赖状态（toggle on/off）时，label **必须随状态更新**，**不能
固定**。

**Tooltip 支持.** 每个 icon-only 按钮配 tooltip：hover 时（300ms 延
迟）和键盘聚焦时显示。tooltip 文案与 `aria-label` 一致或为略长版本。

## 表单标签（Form labels）

每个表单输入**必须**带 label 或 `aria-label`。约定：

- 文本 / textarea / select：`<label for="…">` 在输入上方（推荐）；或
  当周围文字已起到视觉标签作用时用 `aria-label`。
- checkbox / radio：`<label>` 包住 input + 文字。点击区域是整个
  label、不是只有 box。
- 必填字段：可见 `*` + `aria-required="true"`。
- 错误：`aria-describedby` 指向错误元素；`aria-invalid="true"` 设
  在 input 上。

## 图像替代（Image alternatives）

Web 客户端目前几乎没有 `<img>`（多为内联 SVG）。规则：

- **装饰 SVG**（与相邻文字重复的图标）：`aria-hidden="true"`。
- **意义 SVG**（icon-only 按钮、状态字符）：在按钮上 `aria-label`
  或 SVG 内 `<title>`。
- **头像图片**：`alt` 是用户/agent 的显示名。

## 颜色作为唯一指示（Colour as the only indicator）

**禁止.** 当前正确实现的例子：

- 状态 chip：颜色 + 文字（"done"、"in-progress"）。
- diff viewer：颜色 + `+` / `-` 字符。
- workspace dirty 标记：颜色 + `•`。

如果代码里发现「仅靠颜色」的信号（例如一个红边框但没有文字），**加
字符或文字**。

## 屏幕阅读器播报（Screen-reader announcements）

动态内容更新时，希望屏幕阅读器播报但**不**移焦的场景：

- 用户正在输入时收到 assistant 新消息：通过 `aria-live="polite"`
  区域播报。
- tool error：`aria-live="assertive"`（中断当前播报）。
- 流式完成：**不**播报（视觉更新已经够了）。

aria-live 区域应当**视觉隐藏但不 `display: none`**——使用 `.sr-only`
工具类：`position: absolute; clip: rect(0 0 0 0); width: 1px;
height: 1px; overflow: hidden;`。

## 测试（Testing）

发布任何 UI 变更前的本地速测：

1. **键盘走查**：Tab 走完整新屏。每个交互元素都应收到可见 focus
   ring；Tab 顺序对齐视觉顺序；任何浮层都能 `Esc` 关闭。
2. **对比度抽检**：开 DevTools，用拾色器的对比度指示器抽最小字号
   文字 + 任何「仅靠颜色」的状态信号。
3. **reduced-motion**：在系统设置里启用「减少动效」，重载。所有动
   画应即时；不应有缺失。
4. **缩放**：Cmd/Ctrl + 滚轮放大到 200%。布局**不应**横向滚动；
   文字**不应**截断。
5. **主题对位**：切换明暗，上面所有状态在两套主题下都应通过对比度
   / 可见。

自动化（axe-core / Pa11y）能抓住一部分；手动走查抓剩下的。
