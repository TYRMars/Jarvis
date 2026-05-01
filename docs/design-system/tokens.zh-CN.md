# Tokens

本文是 [styles.css](../../apps/jarvis-web/src/styles.css) 中所有设计
token 的人类可读索引。每个 token 都列出运行时变量名、明亮/深色双主题
下的取值、以及是否通过 `@theme` 块暴露给 Tailwind。

> **阅读指南。** `styles.css` 中并行声明两套取值：`:root` 用于明亮
> 模式，`:root[data-theme="dark"]` 用于深色模式。本文中每个 token 在
> 两套里都存在（除非明确标注例外）。语义别名 token（2026-05 新增）只
> 在 `:root` 中声明、通过 `var()` 指向旧 token；它们不需要深色模式
> 重写，因为 `var()` 解析发生在使用点。

## 约定（Conventions）

- **Legacy tokens（旧 token）**：原有的位置型变量（`--user-bubble-bg`、
  `--tool-header-bg`……）。仍然有效，所有现有组件都在消费它们。
- **Semantic aliases（语义别名）**：新增的一层（`--surface-panel`、
  `--text-default`、`--accent-primary`……）。**新组件优先使用别名**。
  每个别名都以 `var(--legacy-name)` 形式定义。
- **Tailwind-exposed（Tailwind 已暴露）**：该 token 在 `@theme` 块
  （`styles.css` 第 13–55 行）有匹配条目，可作为 utility class 使用，
  例如 `bg-panel`、`text-soft`、`border-input-border`。

## 颜色 — 语义层（Colours — semantic layer）

新代码推荐使用此层。每行通过 `var()` 指向运行时 legacy token。

### 表面（Surfaces）

| 语义别名 | Legacy token | 明亮 hex | 深色 hex | Tailwind |
|---|---|---|---|---|
| `--surface-bg` | `--bg` | `#ffffff` | `#090909` | `bg-bg` |
| `--surface-sidebar` | `--sidebar-bg` | `#fafafa` | `#121212` | `bg-sidebar` |
| `--surface-panel` | `--panel` | `#ffffff` | `#101010` | `bg-panel` |
| `--surface-panel-raised` | `--panel-raised` | `#f6f6f5` | `#171717` | `bg-panel-raised` |
| `--surface-panel-hover` | `--panel-hover` | `#eeeeec` | `#202020` | `bg-panel-hover` |
| `--surface-panel-active` | `--panel-active` | `#e9e8e5` | `#2d2d2d` | `bg-panel-active` |
| `--surface-input` | `--input-bg` | `#ffffff` | `#1c1c1c` | `bg-input` |
| `--surface-tool` | `--tool-bg` | `#fbfaf8` | `#151515` | `bg-tool` |

> 在明亮主题下 `--bg` 与 `--panel` 都是纯白，但深色主题下二者不同。
> `--surface-bg` 仅用于根画布；任何带框的区域（chat 面板、projects 面
> 板、settings 卡片）应坐落在 `--surface-panel` 上。

### 文本（Text）

| 语义别名 | Legacy token | 明亮 hex | 深色 hex | Tailwind |
|---|---|---|---|---|
| `--text-default` | `--text` | `#262624` | `#d6d2cb` | `text-text` |
| `--text-muted` | `--text-muted` | `#5f5d58` | `#9c978f` | `text-muted` |
| `--text-soft` | `--text-soft` | `#8d8a83` | `#69655f` | `text-soft` |
| `--text-on-accent` | `--accent-contrast` | `#23140c` | `#1b130e` | `text-on-accent` |
| `--text-placeholder` | `--placeholder` | `#aaa6a0` | `#5f5f5f` | `text-placeholder` |
| `--text-disabled` | `--disabled-text` | `#9e9a93` | `#767676` | — |

层级规则：**default → muted → soft**，逐级安静。`default` 用于主要
内容；`muted` 用于标签和次要元数据；`soft` 仅用于第三层注解（时间戳、
输入框下方的辅助文字）。对比度风险见
[accessibility.zh-CN.md](accessibility.zh-CN.md)——明亮模式下
`--text-soft` 落在 `--surface-sidebar` 上未达 WCAG AA。

### 边框（Borders）

| 语义别名 | Legacy token | 明亮 hex | 深色 hex | Tailwind |
|---|---|---|---|---|
| `--border-default` | `--border` | `#e4e2dd` | `#262626` | `border-border` |
| (—) | `--border-soft` | `#efede8` | `#1b1b1b` | `border-border-soft` |
| `--border-input` | `--input-border` | `#dedcd5` | `#303030` | `border-input-border` |
| `--border-input-focus` | `--input-focus` | `#c9c5ba` | `#4a4a4a` | — |

### 强调色（语义）（Accents (semantic)）

五种「这意味着 X」的颜色。区分品牌色与功能色：

| 语义别名 | Legacy token | 明亮 hex | 深色 hex | Tailwind | 用于 |
|---|---|---|---|---|---|
| `--accent-primary` | `--accent` | `#d87948` | `#d88a52` | `bg-accent` | 品牌、主 CTA、focus ring、assistant 头像、active 选中 |
| `--accent-success` | `--accent-green` | `#2f9c4a` | `#5ebf67` | `bg-success` | approve 操作、completed 状态、diff 增行 |
| `--accent-danger` | `--accent-red` | `#c94d45` | `#d25a55` | `bg-danger` | deny / 破坏性操作、错误、diff 删行 |
| `--accent-info` | `--accent-blue` | `#397fd6` | `#4da2ff` | `bg-info` | 信息性 chip、链接、中性状态 |
| `--accent-purple` | `--purple` | `#7b61d7` | `#a783ff` | — | 仅用于标签/分类，**不要**作为 CTA |

反模式：**不要**用 `--accent-primary` 与 `--accent-blue` 区分「链接 vs
按钮」。正文中的链接保持无样式（继承 `--text-default`，hover 时下划
线）；蓝色仅留给信息性 chip 和外部资源标识。

### 状态 — 危险面板（Status — danger panel）

用于 toast / banner / 行内错误块：

| 语义别名 | Legacy token | 明亮取值 | 深色取值 |
|---|---|---|---|
| `--state-danger-bg` | `--danger-bg` | `rgba(201, 77, 69, 0.10)` | `rgba(210, 90, 85, 0.12)` |
| `--state-danger-border` | `--danger-border` | `rgba(201, 77, 69, 0.24)` | `rgba(210, 90, 85, 0.24)` |
| `--state-danger-text` | `--danger-text` | `#9f3833` | `#f0c4c1` |

success / info 等价物**目前不存在**——需要时按相同形态新增三元组
（alpha 背景 + alpha 边框 + 实色文字）：`--state-success-*` /
`--state-info-*`。

## 颜色 — 派生（位置型命名）token（Colours — derived (position-named) tokens）

这些 token 早于语义层。仍然在用、不会废弃；视为**派生**：每一个在逻
辑上都继承自某个语义 token（见「Inherits from」列）。后续清理应该把
它们折叠成 `var()` 引用——**不在本次范围**。

| Token | 继承自 | 明亮 hex | 深色 hex |
|---|---|---|---|
| `--user-bubble-bg` | `surface-panel-raised` | `#f6f5f2` | `#1d1d1d` |
| `--user-bubble-text` | `text-default` | `#2a2926` | `#f5f1ea` |
| `--avatar-bg` | （独立色）| `#d8d1c7` | `#c9c0b4` |
| `--avatar-text` | `text-default` | `#29231c` | `#151515` |
| `--assistant-avatar-bg` | `accent-primary` | `#d87948` | `#d88a52` |
| `--assistant-avatar-text` | `text-on-accent` | `#2b160b` | `#241308` |
| `--system-avatar-bg` | `surface-panel-hover` | `#ecebe7` | `#202020` |
| `--tool-header-bg` | （独立色）| `#f2f1ed` | `#1c1c1c` |
| `--tool-header-hover` | （独立色）| `#ebe9e4` | `#232323` |
| `--pre-bg` | `surface-panel-raised` | `#f7f6f2` | `#101010` |
| `--branch-bg` | `surface-panel` | `#ffffff` | `#171717` |
| `--branch-icon-bg` | `surface-panel-hover` | `#f2f1ed` | `#222222` |
| `--mode-bg` | （独立色）| `#ededeb` | `#4a4a4a` |
| `--mode-text` | `text-default` | `#242424` | `#f0ede8` |
| `--control-bg` | （独立色）| `#f7f7f5` | `#151515` |
| `--control-active-bg` | `surface-panel-active` | `#e8e8e4` | `#4b4b4b` |
| `--control-active-text` | `text-default` | `#1f1f1e` | `#f8f3ee` |
| `--model-trigger-bg` | （独立色）| `#e2e0da` | `#303030` |
| `--model-trigger-hover` | `surface-panel-hover` | `#efede8` | `#3a3a3a` |
| `--model-menu-bg` | `surface-panel-raised` | `#fbfbfa` | `#171717` |
| `--model-menu-border` | `border-default` | `#deddda` | `#303030` |
| `--model-menu-text` | `text-default` | `#262626` | `#e7e2da` |
| `--model-menu-muted` | `text-muted` | `#858585` | `#9c978f` |
| `--model-menu-hover` | `surface-panel-hover` | `#eeeeec` | `#242424` |
| `--kbd-bg` | （独立色）| `#f1f1f1` | `#242424` |
| `--kbd-border` | `border-default` | `#dddddd` | `#3a3a3a` |
| `--scroll-thumb` | （独立色）| `#d0cdc7` | `#2d2d2d` |
| `--scroll-thumb-hover` | （独立色）| `#b8b3aa` | `#444444` |
| `--disabled-bg` | `surface-panel-hover` | `#ecebe7` | `#303030` |

## 排版（Typography）

### 字体族（Font families）

| Token | 字体栈 |
|---|---|
| `--font-sans` | Inter, "SF Pro Text", "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", ui-sans-serif, system-ui, sans-serif |
| `--font-mono` | "SF Mono", "JetBrains Mono", ui-monospace, Menlo, Consolas, "PingFang SC", monospace |

Inter 是品牌无衬线字体——拉丁与中文回退场景共用一套；CJK 由
PingFang SC（macOS）/ Microsoft YaHei（Windows）渲染。我们**不**自托管
Inter 字体——依赖系统已安装是有意为之（macOS 13+ 自带；Linux/Windows
广泛可得；回退到 SF Pro / system-ui 也可接受）。

### 字号阶梯（Type scale）

| Token | 取值 | 用途 |
|---|---|---|
| `--fs-11` | 11px | 脚注 chip、kbd 字符 |
| `--fs-12` | 12px | sidebar 元数据、消息时间戳 |
| `--fs-13` | 13px | 紧凑控件、tool block 状态、列表行 |
| `--fs-14` | 14px | chat / settings 中的正文；默认 |
| `--fs-15` | 14px | **⚠ 已知偏离** —— 名字 15、值 14。少数 sidebar 标签使用 |
| `--fs-16` | 15px | **⚠ 已知偏离** —— 名字 16、值 15。chat composer 使用 |
| `--fs-18` | 16px | **⚠ 已知偏离** —— 名字 18、值 16。section header 使用 |
| `--fs-22` | 20px | **⚠ 已知偏离** —— 名字 22、值 20。H1 / 页面标题 |
| `--fs-menu` | 14px | 下拉/上下文菜单条目 |

> `⚠ 已知偏离`一行追踪在
> [README.zh-CN.md#待整改](README.zh-CN.md#待整改open-follow-ups)。
> **不要就地修复**——需要协调一次重命名 PR。

### 字重（Weights）

| 字重 | 用途 |
|---|---|
| 450 | 正文（在 `body` 上设置）|
| 500 | section 标签（默认 `.section-label`）|
| 560 | `.section-label` 的醒目变体 |
| 660 | mode tab、sidebar 模式选择器 |
| 700 | `<strong>`、`<b>`、主按钮 |

### 行高（Line height）

| 场景 | 值 |
|---|---|
| 正文 | 1.5 |
| 紧凑控件（mode tab、徽章）| 1 |
| 代码块 | 1.5 |

## 间距（Spacing）

目前**没有 `--space-*` token**——间距硬编码在组件 CSS 里。审计实际
使用得到以下阶梯：

| 档位 | px | 用于 |
|---|---|---|
| 1 | 4 | 图标-文字间隔、紧凑 chip 内边距 |
| 2 | 6 | nav-list 内部 gap、tab 横向 padding |
| 3 | 8 | 默认控件竖向 padding、sidebar topbar 竖向 padding |
| 4 | 10 | sidebar margin（距离屏幕 10px）|
| 5 | 12 | 气泡内部 gap、列表行 padding |
| 6 | 14 | sidebar-topbar 横向 padding |
| 7 | 16 | sidebar-section 横向 padding、mode-row 横向 padding |
| 8 | 24 | section 纵向韵律 |
| 9 | 32 | rail-card padding、对话框 gutter |

**规则。** 新组件优先使用 4 的倍数。6 / 10 / 14 仅在保持已有视觉节律
时使用。

## 圆角（Radii）

`@theme` 块现已暴露完整阶梯；五个值都可以作为 Tailwind 的
`rounded-{sm,md,lg,xl,pill}` utility 使用。

| Token | 取值 | 用于 |
|---|---|---|
| `--radius-sm` | 6px | icon 按钮（`.ghost-icon`）、小 chip |
| `--radius-md`（= `--radius`）| 8px | 默认控件圆角——大多数按钮、输入、tool block |
| `--radius-lg` | 10px | 容器外壳——sidebar、rail、大卡片 |
| `--radius-xl` | 12px | 模态、quick switcher、settings 卡片 |
| `--radius-pill` | 999px | 状态徽章、tag chip |

头像独立使用 `border-radius: 50%`。少量 legacy CSS 中残留的「13px /
7px / 5px」值视为漂移——下次触碰相关代码时归并到上面阶梯。

## 阴影（Shadows）

| Token | 明亮取值 | 深色取值 | 用于 |
|---|---|---|---|
| `--shadow-soft` | `0 10px 24px rgba(27, 26, 24, 0.08)` | `0 10px 24px rgba(0, 0, 0, 0.24)` | hover 抬起卡片、抬起的 composer |
| `--shadow-popover` | `0 18px 42px rgba(27, 26, 24, 0.16)` | `0 18px 42px rgba(0, 0, 0, 0.28)` | 下拉、模态、quick switcher |

阴影目前**没有暴露给 Tailwind**——通过行内 `style={{ boxShadow:
'var(--shadow-soft)' }}` 或组件 CSS 使用。

## 动效（Motion）

目前**没有动效 token**——duration 硬编码在组件 transition 中。标准如下：

| 场景 | 时长 | easing | 用于 |
|---|---|---|---|
| Hover 微反馈 | 120ms | `ease`（默认）| hover 时的颜色 / 背景切换 |
| 选择 / 面板切换 | 200ms | `ease-out` | tab 切换、面板展开 |
| 模态进入 | 300ms | `ease-out` | dialog / quick switcher 挂载 |
| 模态退出 | 200ms | `ease-in` | dialog 关闭 |

每条 transition 声明**必须**在 `prefers-reduced-motion: reduce` 下被
取消——见 [accessibility.zh-CN.md#prefers-reduced-motion](accessibility.zh-CN.md#prefers-reduced-motion)。

`linear` easing 禁用（在 UI 中显得机械）。多步编排（composer 展开 →
建议浮现）使用 60ms 错峰。

## 布局常量（Layout constants）

| Token | 值 | 含义 |
|---|---|---|
| `--sidebar-width` | 328px | 左侧导航栏宽度 |
| `--rail-width` | 540px | 右侧 approvals / workspace 栏宽度 |
| `--content-width` | 860px | 聊天对话最大宽度 |
| `--composer-width` | 860px | composer 最大宽度（与内容对齐）|

窄视口下两栏会塌陷为 `0px`（`@media (max-width: …)`，具体断点见
`styles.css`）。`grid-template-areas: "sidebar chat rail"` 是排布三栏
的**唯一正确方式**——见 [patterns.zh-CN.md#三栏网格three-column-grid](patterns.zh-CN.md#三栏网格three-column-grid)。

## 对账（Reconciliation）

不做对账的 token 表会漂移。下面两条命令可验证本文与源码一致：

```bash
# styles.css 中声明的每个 token 都应在本文出现
grep -oE '\-\-[a-z][a-z0-9-]+:' apps/jarvis-web/src/styles.css \
  | tr -d ':' | sort -u

# @theme 暴露的每个 token 也应在本文出现
awk '/^@theme \{/,/^\}/' apps/jarvis-web/src/styles.css \
  | grep -oE '\-\-(color|radius)-[a-z-]+'
```

输出与本文表格不一致 → 文档漂移、修文档。
