# Jarvis 视觉设计系统

Jarvis 是一个 Rust agent runtime，附带的 Web 客户端位于
`apps/jarvis-web/`。本目录记录该客户端的视觉语言：所有 token、组件、
模式与可访问性规则——**任何新增 UI 工作都应当遵循它**。

## 定位（Positioning）

视觉语言由三条参照系塑造：

- **极简主义 / 瑞士风格** —— 网格驱动、留白充裕、字号层级锐利、几乎不
  使用装饰性阴影。
- **深色模式（OLED）作为一等公民** —— 每个 token 都为明暗双主题对称
  定义，**绝不"先做明亮、再补深色"**。
- **Developer Mono 字体配对** —— 正文用 Inter、代码用 SF Mono /
  JetBrains Mono，分别走 `var(--font-sans)` / `var(--font-mono)`。

在这套基线之上，我们叠加项目自己的产品个性：

- **唯一品牌色：暖橙** —— 明亮 `#d87948`，深色 `#d88a52`。其余强调色
  （绿/红/蓝/紫）一律是**功能性状态信号**，不是品牌色的扩展。
- **密集的 IDE 外壳** —— 三栏网格（侧栏 / 主区 / 右栏）、14px 正文、
  32–34px 行高。我们对标 Cursor / Linear / Claude Code，**不是**消费向
  聊天产品。

我们刻意**不**采用：玻璃拟物（glassmorphism）、新拟物（neumorphism）、
两段以上的渐变、堆叠投影、动态背景、emoji 当图标。

## 五条决策（Five decisions to remember）

1. **暖橙是唯一品牌色。** `--accent` / 语义别名 `--accent-primary` 仅
   用于：主 CTA、focus ring、active 选中、assistant 头像——**仅此**。
   绿=成功、红=危险、蓝=信息、紫=用于标签/分类。**绝对不要再引入第六
   种主色。**
2. **明暗双主题地位平等。** 任何新增的颜色 token **必须**同时在 `:root`
   与 `:root[data-theme="dark"]` 中定义。在组件 CSS 里写裸 hex 字面量
   且未走 token 的 PR——拒绝合并。
3. **字号阶梯封闭。** 七档（`--fs-11` 到 `--fs-22`）已覆盖所有现有界
   面。新需求**从已有阶梯里选**，不要再加 `--fs-17`。
4. **四档圆角。** `--radius-sm`（6，icon button）、`--radius-md`（8，
   即 `--radius`，默认控件）、`--radius-lg`（10，容器：sidebar / rail /
   大卡片）、`--radius-xl`（12，模态）。再加一个 `--radius-pill`（999，
   徽章）。头像用 `50%`。
5. **动效要克制。** hover 微反馈 120ms、选择/面板切换 200ms、模态进入
   300ms；进入用 `ease-out`、退出用 `ease-in`。每一条 transition 都要
   被 `@media (prefers-reduced-motion: reduce)` 取消。

## 目录（Files）

| 文件 | 回答什么问题 |
|---|---|
| [tokens.zh-CN.md](tokens.zh-CN.md) | 有哪些颜色/字号/间距/圆角/阴影/动效 token、它们叫什么名字、在两套主题下的取值 |
| [components.zh-CN.md](components.zh-CN.md) | 现有组件的视觉契约（chat 气泡、tool block、sidebar item、卡片、模态、composer） |
| [patterns.zh-CN.md](patterns.zh-CN.md) | 跨组件的版式与交互模式（三栏网格、resize handle、空态、markdown、diff viewer） |
| [accessibility.zh-CN.md](accessibility.zh-CN.md) | 对比度审计、focus ring 标准、`prefers-reduced-motion`、键盘契约、icon-only 按钮的标签 |

## 真理来源（Source of truth）

运行时 token 全部存放于
[apps/jarvis-web/src/styles.css](../../apps/jarvis-web/src/styles.css)
的 `:root` 与 `:root[data-theme="dark"]` 中。本套文档**描述**该文件——
当二者冲突时，以代码为准、文档需要更新。

## 待整改（Open follow-ups）

以下事项在本次审计中识别出，**故意未在此次 PR 中触碰**，以保持本次
变更的视觉零侵入：

- `--fs-15: 14px` / `--fs-16: 15px` / `--fs-18: 16px` —— 名字与值
  对不上号。需要专项 PR 重命名或合并阶梯。
- 明亮模式下 `--text-soft`（`#8d8a83`）落在 `--sidebar-bg`（`#fafafa`）
  上对比度仅约 3.0:1，未达 WCAG AA 4.5:1。详细审计与建议替换值见
  [accessibility.zh-CN.md](accessibility.zh-CN.md)。
- 位置型命名 token（`--user-bubble-bg`、`--tool-header-bg`、
  `--branch-bg`、`--model-menu-*`、`--kbd-*`）应当继承自语义 token，而
  不是各自携带 hex。当前在 [tokens.zh-CN.md](tokens.zh-CN.md) 中标注
  为「派生 token」。

## 双语对照（Bilingual companion）

每份文件都出 `*.md`（英文）+ `*.zh-CN.md`（中文）双版本，章节锚点
完全一致。英文入口：[README.md](README.md)。
