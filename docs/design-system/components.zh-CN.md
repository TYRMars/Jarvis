# Components

下面每一节都是某个已发布组件 / 组件家族的**视觉契约**。结构固定：

- **Purpose（用途）** —— 一句话，做什么用。
- **Container（容器）** —— 外形几何（padding / radius / border / 背景）。
- **Typography（排版）** —— 字号、字重、字体族。
- **States（状态）** —— `default`、`hover`、`focus`、`active`、
  `selected`、`disabled`、`error`，仅列出适用项。
- **Don't（反模式）** —— 该组件特定的禁用做法。

当契约与实际代码冲突时，**契约是目标**——开 issue、改代码对齐契约，
不是改文档。

---

## Sidebar — `.nav-item`

**Purpose.** sidebar 中的顶层导航行（`Chat`、`Projects`、`Docs`、
`Settings`）。

| 属性 | 取值 |
|---|---|
| height | 32px |
| padding | 0 |
| gap（图标 → 标签）| 12px |
| border-radius | 6px（`--radius-sm`）|
| font-size | `--fs-14` |
| font-weight | 450 |
| icon | 18px 描边 SVG，`currentColor` |

**States.**

| 状态 | 背景 | 文字 |
|---|---|---|
| default | transparent | `--text-muted` |
| hover | transparent | `--text-default` |
| active（当前路由）| `--surface-panel-active` | `--text-default` |

**Don't.** 不要给 active 项加左侧色条——本项目的选中信号是**背景填
充**，不是 chrome。

---

## Sidebar — `.mode-tab`

**Purpose.** sidebar topbar 下方的三联 tab（Chat / Work / Doc）。

| 属性 | 取值 |
|---|---|
| height | 34px |
| padding-x | 8px |
| gap（图标 → 标签）| 6px |
| border-radius | `--radius`（8px）|
| font-size | `--fs-14` |
| font-weight | **660** |

**States.**

| 状态 | 背景 | 文字 |
|---|---|---|
| default | transparent | `--text-soft` |
| hover | `--surface-panel-hover` | `--text-default` |
| active | `--mode-bg` | `--mode-text` |

660 字重不寻常但有意为之——mode tab 是主要导航控件，应该读起来比普通
nav-item 更具权威感。

---

## Sidebar — `.ghost-icon`

**Purpose.** 用于 topbar 的方形 icon-only 按钮（折叠、新建对话、搜索
触发器）。

| 属性 | 取值 |
|---|---|
| size | 28×28 |
| border-radius | 6px |
| icon | 16–18px、描边 1.5–2 |
| color | `--text-soft` |

**States.**

| 状态 | 背景 | 颜色 |
|---|---|---|
| default | transparent | `--text-soft` |
| hover | `--surface-panel-hover` | `--text-default` |
| active（toggle on）| `--surface-panel-active` | `--text-default` |
| disabled | transparent | `--text-disabled` |

**Don't.** 每个 `.ghost-icon` **必须**带 `aria-label`——它没有可见文
字。见 [accessibility.zh-CN.md#icon-only-按钮icon-only-buttons](accessibility.zh-CN.md#icon-only-按钮icon-only-buttons)。

---

## Chat — `UserBubble`

**Purpose.** chat 面板中用户输入的消息。

| 属性 | 取值 |
|---|---|
| max-width | （匹配 `--content-width`，860px）|
| padding | 12px 16px |
| border-radius | 12px（`--radius-xl`）|
| 背景 | `--user-bubble-bg`（别名 `--surface-panel-raised`）|
| 颜色 | `--user-bubble-text`（别名 `--text-default`）|
| font-size | `--fs-14` |
| line-height | 1.5 |
| 头像 | 28×28，`--avatar-bg` / `--avatar-text`，"U" 字符 |

**States.**

| 状态 | 处理 |
|---|---|
| default | 如上 |
| hover | 编辑笔与重跑按钮淡入（opacity 0 → 1，120ms）|
| editing | 气泡变形为 textarea，背景 `--surface-input`、聚焦边框 `--border-input-focus`，发送按钮使用 `--accent-primary` |

**Don't.** 不要把用户气泡右对齐。Jarvis 是工作台、不是即时通讯——双
方都左对齐。

---

## Chat — `AssistantBubble`

**Purpose.** chat 面板中的 agent 响应。包含可选的 thinking
disclosure、markdown 正文、折叠的 tool-call 摘要。

| 属性 | 取值 |
|---|---|
| max-width | 860px |
| padding | 0（透明——内容直接坐在 chat 表面上）|
| 背景 | 无 |
| 颜色 | `--text-default` |
| font-size | `--fs-14` |
| line-height | 1.5 |
| 头像 | 28×28，`--assistant-avatar-bg` / `--assistant-avatar-text`，"J" 字符 |

assistant 气泡**没有容器 chrome**——与 user 气泡的视觉区分来自头像
颜色（橙色）和**没有卡片**这件事本身。这是刻意采用的「Claude /
Cursor」模式。

**子组件.**

- `ThinkingDisclosure` —— 折叠：13px 斜体「Thought for Ns」、
  `--text-muted`、带 chevron。展开：相同色调、缩进 16px、等宽字体。
- `ToolStepRow` —— 本回合所有 tool call 的单行摘要。点击展开为完整
  ToolBlock。
- 复制按钮 —— hover-only、14px ghost-icon、置于气泡右上角。

**Don't.** 不要引入流式骨架占位（先灰块再变文字）——现有的 token-by-
token 渲染本身就是流式 UX。再叠骨架只会增加视觉噪音、不增加信息。

---

## Chat — `ToolBlock`

**Purpose.** 在 chat 中行内渲染单次 tool 调用（`fs.read`、
`shell.exec`、`code.grep` 等）。可折叠。

| 属性 | 取值 |
|---|---|
| width | 气泡满宽（max 860px）|
| border | 1px solid `--border-default` |
| border-radius | 8px（`--radius-md`）|
| 背景 | `--surface-tool` |
| 头部 padding | 8px 12px |
| 头部背景 | `--tool-header-bg` |
| 头部 hover | `--tool-header-hover` |
| 主体 padding | 12px |
| 主体字体 | `--font-mono`、`--fs-13`、line-height 1.5 |

**Status badge**（头部右侧）：

| 状态 | 背景 | 文字 |
|---|---|---|
| running | `rgba(57, 127, 214, 0.10)`（info bg）| `--accent-info` |
| ok | `rgba(47, 156, 74, 0.10)`（success bg）| `--accent-success` |
| error | `--state-danger-bg` | `--state-danger-text` |
| denied | `--surface-panel-active` | `--text-muted` |

**States.**

- **Default** —— 折叠、可见单行摘要（tool 名 + 参数预览）。
- **Open** —— `error` / `denied` 时自动展开；用户可手动展开任意块。
- **Approval-pending**（gated tool）—— 黄色色调左边框（4px、
  `--accent-primary`）直至决策到达。

**Don't.** 一旦用户手动展开了某块，**不要**因为状态变化再自动折叠。

---

## Chat — `ToolStepRow`

**Purpose.** 本回合所有 tool call 的单行摘要。位于 assistant 气泡顶
部；点击展开为完整 ToolBlock。

| 属性 | 取值 |
|---|---|
| height | 28px |
| padding | 0 12px |
| border-radius | 6px |
| 背景 | `--surface-panel-raised` |
| font-size | `--fs-13` |
| 颜色 | `--text-muted` |
| 图标 | spinner（运行中）或 check（已完成），14px |

**States.** `running` 显示 spinner；`done` 显示数量（`5 tool calls`）；
`error` 显示其中任一失败步骤的 badge。

---

## Composer

**Purpose.** chat 面板底部的多行输入；自带模型选择器、发送按钮、斜杠
命令建议。

**容器（Container）.**

| 属性 | 取值 |
|---|---|
| max-width | `--composer-width`（860px）|
| padding | 12px |
| border | 1px solid `--border-input` |
| border-radius | 12px |
| 背景 | `--surface-input` |
| 聚焦边框 | `--border-input-focus` |
| 阴影（聚焦）| `--shadow-soft` |

**Textarea.**

| 属性 | 取值 |
|---|---|
| font-size | `--fs-15`（= 14px，见 [tokens.zh-CN.md#字号阶梯type-scale](tokens.zh-CN.md#字号阶梯type-scale)）|
| line-height | 1.5 |
| min-height | 44px |
| max-height | 50vh |
| 占位符 | `--text-placeholder` |

**发送按钮.** 36×36、`--radius`（8px）、`--accent-primary` 背景、
`--text-on-accent` 颜色。输入为空时禁用——`--surface-panel-active`
背景、`--text-disabled` 颜色，无 hover。

**模型选择器**（composer 左上角或 chat header 中）。触发器：
`--model-trigger-bg`，hover 为 `--model-trigger-hover`，8px 圆角，
`--fs-13`。菜单使用 `--shadow-popover` 与 `--surface-panel-raised`。

---

## Approvals rail card

**Purpose.** 右栏中等待人工 approve/deny 的 tool call 卡片。

| 属性 | 取值 |
|---|---|
| padding | 16px |
| gap | 12px |
| border | 1px solid `--border-default` |
| border-radius | 10px（`--radius-lg`）|
| 背景 | `--surface-panel` |

**头部.** Tool 名（mono、`--fs-13`、`--text-default`）+ 状态 chip
（`pending` 用 `--accent-info`）。

**主体.** JSON 参数显示在 `<pre>` 里——`--font-mono`、`--fs-13`、
`--surface-panel-raised`、padding 8px、max-height 200px 可滚。

**操作按钮.** 两按钮等宽：

| 按钮 | 背景 | 颜色 | 边框 |
|---|---|---|---|
| Approve | `--accent-success` | white | 无 |
| Deny | transparent | `--accent-danger` | 1px `--accent-danger` |

Approve 实心填充（提交动作），Deny 描边（谨慎）。**不要反转**——视
觉权重表达「哪个是不可逆选择」。

---

## Project — `RequirementCard`

**Purpose.** 看板 / 列表视图中的单个需求卡。

| 属性 | 取值 |
|---|---|
| padding | 12px |
| gap（行间）| 8px |
| border | 1px solid `--border-default` |
| border-radius | 8px |
| 背景 | `--surface-panel` |
| hover | `--surface-panel-hover` |
| font-size | `--fs-14` |
| 标题字重 | 560 |

**Status chip**（右上角）：

| 状态 | 背景 | 文字 |
|---|---|---|
| backlog | `--surface-panel-hover` | `--text-muted` |
| in-progress | `rgba(57, 127, 214, 0.10)` | `--accent-info` |
| review | `rgba(123, 97, 215, 0.10)` | `--accent-purple` |
| done | `rgba(47, 156, 74, 0.10)` | `--accent-success` |
| cancelled | `--state-danger-bg` | `--state-danger-text` |

Chip 几何：18px 高、padding 0 8px、`--radius-pill`、`--fs-11`、字重
560、全大写。

**拖拽手柄.** 仅 hover 时可见（opacity 0 → 1、120ms）。光标变为
`grab`、拖拽时 `grabbing`。

---

## Workspace badge（chat header）

**Purpose.** 显示当前 workspace 文件夹 + git 状态。点击打开 recent-
folders 下拉。

| 属性 | 取值 |
|---|---|
| height | 28px |
| padding | 0 10px |
| gap | 8px |
| border | 1px solid `--border-default` |
| border-radius | 6px |
| 背景 | `--branch-bg` |
| font-size | `--fs-13` |

**内嵌字符**（从左到右）：文件夹图标（14px、`--text-muted`）、文件
夹名（`--text-default`、字重 560）、分支图标（12px）+ 分支名（git
存在时）、dirty 标记（`•`，`--accent-info`，有未提交变更时）。

**Hover.** 背景 `--surface-panel-hover`。**展开下拉.**
`--shadow-popover`、`--surface-panel-raised`。

---

## Quick switcher

**Purpose.** Cmd+P 统一搜索模态。

| 属性 | 取值 |
|---|---|
| width | 600px |
| max-height | 480px |
| padding | 0 |
| border | 1px solid `--border-default` |
| border-radius | 12px（`--radius-xl`）|
| 背景 | `--surface-panel` |
| 阴影 | `--shadow-popover` |

**搜索输入.** 48px 高、`--fs-15`、padding 0 16px、无内部边框（模态外
框是唯一边框）。

**结果行.** 36px 高、padding 0 16px、图标-标签 gap 12px。**选中行
背景** `--surface-panel-active`——**绝不**用 `--accent-primary`。强
调色仅用于 commit 动作，不用于「选中」。

**底部.** 36px 高、`--surface-panel-raised`、kbd 提示
（`↑ ↓ to navigate`、`↵ to select`、`esc to close`）使用
`--text-soft`、`--fs-12`。

---

## Settings tab nav

**Purpose.** Settings 页面左侧的纵向 tab 条（Appearance、Providers、
Permissions、Skills、MCP……）。

| 属性 | 取值 |
|---|---|
| width | 220px |
| 项目 height | 32px |
| 项目 padding | 0 12px |
| 项目 radius | 6px |
| font-size | `--fs-14` |

**States.**

| 状态 | 背景 | 文字 |
|---|---|---|
| default | transparent | `--text-muted` |
| hover | `--surface-panel-hover` | `--text-default` |
| active | `--surface-panel-active` | `--text-default` |

active tab 带 2px 左侧色条 `--accent-primary`——这是**整个项目里唯一
正确使用左侧色条**的位置（settings tab 读起来像「导航索引」、不是
「列表选择」）。

---

## Modal / Dialog

**Purpose.** 居中浮层——确认框、settings 对话框、commit message 框。

| 属性 | 取值 |
|---|---|
| width | min(560px, 90vw) |
| max-height | 80vh |
| padding | 24px |
| border-radius | 12px（`--radius-xl`）|
| 背景 | `--surface-panel` |
| border | 1px solid `--border-default` |
| 阴影 | `--shadow-popover` |
| backdrop | `rgba(0, 0, 0, 0.4)` |

**标题.** `--fs-18`（= 16px）、字重 700、`--text-default`。

**主体.** `--fs-14`、line-height 1.5、`--text-default`。组间距：
16px。

**操作 footer.** 右对齐、按钮间 gap 8px。**主操作放在最右侧**（最近
惯例）。

---

## Toast / Status banner

> **状态：尚未实现。** 引入时遵循此规格。

**容器.**

| 属性 | 取值 |
|---|---|
| width | 360px |
| padding | 12px 16px |
| border | 1px solid（语义色）|
| border-radius | 8px |
| 阴影 | `--shadow-soft` |
| 定位 | fixed 右下角，距各边 24px |

**变体.**

| 变体 | 背景 | 边框 | 文字 |
|---|---|---|---|
| info | `--surface-panel-raised` | `--border-default` | `--text-default` |
| success | `rgba(47, 156, 74, 0.10)` | `rgba(47, 156, 74, 0.24)` | `--accent-success` |
| danger | `--state-danger-bg` | `--state-danger-border` | `--state-danger-text` |

**自动消失.** info / success：4 秒。danger：**永不**自动消失（用户必
须主动关闭）。

---

## 项目级反模式（Component anti-patterns (project-wide)）

下列禁用做法不针对单一组件、**全局适用**：

- **不用 emoji 当图标。** 用 SVG（项目自带行内 SVG 组件，不要在中途
  引入图标库）。
- **不要给每张卡都加 box-shadow。** 阴影留给「抬起 / 脱离」表面
  （composer、modal、dropdown）。chat / projects 面板内部的卡片**默认
  扁平**。
- **不用渐变文字、不用 2 段以上的渐变背景。**
- **不用 hover scale 变换。** 在密集列表里会触发布局抖动。改用背景
  / 颜色 transition。
- **不用左侧色条标记选中**（settings tab 例外，已在上文说明）。
- **icon-only 按钮一律带 `aria-label`。**
- **transition 一律带 `ease-out` / `ease-in`。** linear 在 UI 上感觉
  机械。
