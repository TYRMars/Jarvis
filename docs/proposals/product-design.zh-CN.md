# Jarvis 产品设计：Chat / Work / Doc 与基础能力层

**状态：** Proposed
**翻译：** 本文是 [`product-design.md`](product-design.md) 的中文翻译。英文版是主文档；
英文主文档变更时，必须在同一个 PR 中同步更新本文。
**涉及：** 产品信息架构、`apps/jarvis-web` 顶层导航、能力编排模型、`harness-skill` /
`harness-plugin` / `harness-tools` / `harness-work` / `harness-cloud` 的协作边界；后续
README、用户指南和 Web UI 文案同步。

## 背景

Jarvis 不能只被定义成“coding agent”或“聊天 UI”。更长期的产品目标是：提供三个清晰的
基础产品入口，并在它们之下挂载可快速扩展的基础能力。

## 产品定位

Jarvis 是一个**面向小团队的本地优先、可扩展 AI 工作空间**，把聊天、任务执行和文档
沉淀连接起来。

第一目标用户：

- 约 2-20 人的软件团队；
- 独立产品团队和内部工具团队；
- 希望 AI 能贴近代码、文档和私有上下文的小团队；
- 在采用云端协同前，需要先保持本地优先控制的团队。

第一阶段主打：**Coding Work**。

初期产品不应该试图成为通用办公助手、完整文档编辑器、企业级项目管理套件，或
ChatGPT 替代品。第一条强闭环是：

```text
在 Chat 中讨论编码需求
  -> 捕捉 TODO / 创建 Work task
  -> 带着工作区上下文执行 coding task
  -> 展示 diff、测试、验证和 review 状态
  -> 捕捉 follow-up
  -> 生成长期笔记 / changelog / 技术文档
```

产品一句话：

> Jarvis 是面向小团队的本地优先 AI 工作空间，把编码讨论转化为可验证的任务执行和长期文档沉淀。

产品入口：

- **Chat**：即时对话、问答、工具调用、轻量任务处理；
- **Work**：面向项目、任务、执行单元、验证和长期推进；
- **Doc**：面向文档、资料、报告、知识沉淀和内容产出。

基础能力：

- **Coding**：代码理解、修改、测试、diff、git、PR 辅助；
- **日常办公**：待办、日程、邮件/消息草稿、表格、汇报、会议纪要；
- **资料研究**：搜索、阅读、摘录、综述、引用、研究包；
- 后续可继续扩展：数据分析、云端运维、设计评审、法务/合同、财务分析等。

这些能力不应该绑定在某一个产品入口下。Coding 可以发生在 Chat，也可以作为 Work 的
执行能力；资料研究可以服务 Chat 问答，也可以为 Doc 生成报告，或为 Work 任务提供
上下文。产品层负责用户体验和状态管理，能力层负责可复用的工具、技能、上下文和策略。

## 产品原则

1. **入口少，能力多。**
   顶层只保留 Chat / Work / Doc，避免每新增一种能力就新增一个产品入口。

2. **能力可横向贯穿。**
   Coding、办公、研究等能力以 capability pack 的形式接入，可以被 Chat / Work / Doc
   复用。

3. **状态归属清晰。**
   Chat 管 conversation；Work 管 project/unit/run；Doc 管 document/source/draft。
   基础能力不直接拥有产品状态，只读写各产品暴露的上下文和 artifact。

4. **默认轻量，逐步升级。**
   一条 Chat 回复可以升级为 TODO；TODO 可以升级为 Work task；研究摘录可以升级为 Doc；
   Doc 中的行动项可以回流成 TODO / Work。

5. **安全能力复用。**
   审批、权限、沙盒、云端策略、审计是跨产品的，不为每个入口重复实现。

6. **本地优先，云端增强。**
   Chat / Work / Doc 都应能在本地运行；Cloud / Edge 协同作为部署和执行能力增强。

## 跨产品概念(借鉴 Multica)

下面三个概念不是顶层产品入口,而是横跨 Chat / Work / Doc 的元素,塑造
用户对"AI agent 是同事"的感知。借鉴自
[Multica](https://github.com/multica-ai/multica) 的 "agents as teammates"
形态:

- **AgentProfile**:命名 agent 档案(头像、provider、model、可选 system
  prompt、可选工具白名单)。用户在设置页定义多个 profile;Conversation
  和 Requirement run 从中选取。没有这层,"agent" 只是匿名全局默认;有了
  之后,agent 才能像真实同事一样被 @mention、被指派、被差异化信任。

- **Activity timeline**:每个跨产品对象 — Conversation / Requirement /
  DocProject — 都积累一条 append-only 的活动流:状态变更、assignee 变更、
  run 启动 / 完成、verification 结果、评论。这条 timeline 既是审计依据,
  也是后续诊断面板的底层数据。

- **可派单对象的 assignee**:Requirement(看板卡片)有可选
  `assignee_id` 指向 `AgentProfile`。Doc 和 Chat 在 v0 不需要这个字段,
  但留出空间(比如未来 "用 Alice 的写作风格起草这份周报")。

详细数据模型见
[`work-orchestration.zh-CN.md`](work-orchestration.zh-CN.md) 的
"借鉴 Multica 的产品形态" 一节。

## 产品信息架构

```text
Jarvis
  Chat
    - conversation
    - tool activity
    - approvals
    - quick actions
    - lightweight TODO capture

  Work
    - project
    - TODO backlog
    - milestone / slice / task
    - WorkRun
    - verification / review
    - diagnostics

  Doc
    - source collection
    - outline
    - draft
    - citations / references
    - export
    - knowledge notes

  Settings
    - providers
    - models
    - permissions
    - workspaces
    - skills / plugins / MCP
    - cloud / edge
```

UI 上，Chat / Work / Doc 是一层导航；能力不作为同级页面堆出来，而是在不同入口中以
工具、面板、动作、模板和技能的形式出现。

## 基础能力层

建议抽象成 Capability Pack：

```rust
pub struct CapabilityPack {
    pub id: String,
    pub title: String,
    pub description: String,
    pub surfaces: Vec<ProductSurface>,
    pub tools: Vec<String>,
    pub skills: Vec<String>,
    pub prompts: Vec<PromptTemplate>,
    pub context_builders: Vec<String>,
    pub policies: Vec<PolicyRule>,
}

pub enum ProductSurface {
    Chat,
    Work,
    Doc,
}
```

Capability Pack 不需要一开始就变成复杂运行时系统。v0 可以先是配置/manifest，声明：

- 在哪些产品入口可用；
- 需要哪些工具；
- 需要哪些技能；
- 默认注入哪些上下文；
- 哪些操作需要审批；
- 可以产出哪些 artifact。

## 三个基础产品

### Chat

定位：即时交互入口。适合探索、问答、快速执行、临时工具调用和把想法捕捉成后续事项。

核心对象：

```text
Conversation
Message
AgentEvent
ToolCall
Approval
HITL question
```

关键能力：

- 多轮对话；
- 流式输出；
- 工具调用可见；
- 审批卡片；
- 工作区上下文胶囊；
- 一键保存为 TODO；
- 一键升级为 Work task；
- 一键生成 Doc 草稿或研究记录。

Chat 不应该承担长期项目状态。超过一轮对话能解决的事项，应进入 TODO / Work / Doc。

### Work

定位：面向长期任务和项目推进。适合编码任务、产品计划、自动执行、验证、复盘和端云协同。

核心对象：

```text
WorkProject
TodoItem
WorkUnit
WorkRun
WorkContextManifest
VerificationResult
Artifact
```

关键能力：

- 已实现 TODO board 作为轻量 backlog；
- TODO 升级为 Work task；
- milestone / slice / task 分层；
- fresh session per unit；
- verification gate；
- 可选 worktree 隔离；
- 诊断/forensics；
- 后续支持 Cloud 调度 Edge 执行。

Work 是基础能力最密集的入口：Coding、研究、办公、云端运维都可以作为 Work 的执行能力。

### Doc

定位：面向资料和文档产物。适合研究整理、说明书、方案、报告、会议纪要、PRD、技术设计、
用户手册、知识库条目。

核心对象：

```text
DocProject
DocSource
DocOutline
DocDraft
DocRevision
Citation
ExportArtifact
```

关键能力：

- 上传/收集资料；
- 搜索和摘录；
- 生成 outline；
- 多轮修订；
- 引用和来源追踪；
- 导出 Markdown / DOCX / PDF / PPTX；
- 文档行动项回流到 TODO / Work；
- 从 Work run 生成变更说明、复盘、发布说明。

Doc 不只是“写作页”，它是资料研究和文档产出的状态容器。

## 基础能力矩阵

| 能力 | Chat | Work | Doc |
|---|---|---|---|
| Coding | 解释代码、快速 patch、问答 | task 执行、测试、diff、review、PR | 技术设计、变更说明、API 文档 |
| 日常办公 | 草拟邮件、总结对话、创建 TODO | 跟踪事项、会议行动项、进度推进 | 会议纪要、周报、汇报材料、表格说明 |
| 资料研究 | 快速搜索、问答、摘要 | 为任务补上下文、竞品/技术调研 | 研究包、报告、引用、知识库 |
| 云端运维 | 查询状态、解释告警 | 执行 runbook、部署验证、Edge 调度 | 运维报告、事故复盘 |
| 数据分析 | 快速计算、解释数据 | 分析任务、验证指标 | 分析报告、图表说明 |

新增能力时优先回答：

- 它能在哪些产品入口出现？
- 它需要哪些工具和权限？
- 它会读哪些上下文？
- 它产出什么 artifact？
- 它是否能升级/回流到其他产品对象？

## 能力扩展机制

建议形成四层：

```text
Tool
  单个可调用能力：fs.read、git.diff、todo.add、http.fetch

Skill
  面向模型的工作方法和领域知识：coding、research、office-writing

Capability Pack
  一组 tools + skills + prompts + policies + context builders

Product Surface
  Chat / Work / Doc 中的实际用户体验
```

示例：Coding capability

```text
Tools:
  workspace.context
  git.status
  git.diff
  code.grep
  fs.read
  fs.patch
  shell.exec
  checks.run

Skills:
  coding-agent
  code-review
  test-debugging

Surfaces:
  Chat: 快速问答和小修改
  Work: 可验证任务执行
  Doc: 技术设计/变更说明

Policies:
  fs.patch requires approval
  shell.exec requires approval unless rule allows
  destructive git commands disabled by default
```

示例：资料研究 capability

```text
Tools:
  web.search
  http.fetch
  doc.extract
  source.save
  note.add

Skills:
  research-synthesis
  citation-aware-writing

Surfaces:
  Chat: 即时研究问答
  Work: 为 task 生成 research context
  Doc: 研究包和正式报告
```

示例：日常办公 capability

```text
Tools:
  todo.add
  todo.update
  calendar.*
  mail.draft
  sheet.*
  doc.export

Skills:
  meeting-summary
  business-writing
  spreadsheet-analysis

Surfaces:
  Chat: 快速草拟和总结
  Work: 事项跟踪和执行
  Doc: 会议纪要、周报、汇报材料
```

## 状态流转

```text
Chat
  -> Save as TODO
  -> Create Work task
  -> Create Doc draft
  -> Attach to existing Work/Doc

TODO
  -> Start lightweight action in Chat
  -> Upgrade to Work task
  -> Include in Doc action items

Work
  -> Produce artifact
  -> Create follow-up TODO
  -> Generate Doc: report / design / changelog / postmortem

Doc
  -> Extract action items as TODO
  -> Create Work task from section
  -> Attach sources to Work manifest
```

这个流转让三类产品互相连接，但不混成一个巨大页面。

## 架构映射

```text
Product Surfaces
  apps/jarvis-web
    Chat routes/components
    Work routes/components
    Doc routes/components

Server APIs
  harness-server
    chat routes
    todos/work routes
    doc routes
    capability registry routes

Domain Crates
  harness-core      # agent loop, traits, message, approvals
  harness-work      # project/unit/run/verification
  harness-doc       # future: document/source/draft/export
  harness-cloud     # future: cloud/edge node and dispatch

Capability Crates
  harness-tools     # callable tools
  harness-skill     # skill catalog and selection
  harness-plugin    # external extensions
  harness-mcp       # MCP bridge

Storage
  harness-store     # conversation, todo, work, doc, permissions
```

`harness-doc` 是建议的后续 crate，不必马上创建。Doc v0 可以先以 proposal + UI route +
少量 API 起步。

## 关联 Proposals

本产品设计是产品入口和状态归属的主参考文档。相关 proposal 应该链接回本文，并说明自己
影响的是产品入口、基础能力，还是基础设施。

| Proposal | 关系 |
|---|---|
| [`work-orchestration.zh-CN.md`](work-orchestration.zh-CN.md) | 定义 Work 产品入口：project、unit、run、verification 和 diagnostics。 |
| [`persistent-todos.md`](persistent-todos.md) | 已落地的 Work 轻量 backlog，也服务 Chat 捕捉和 Doc 行动项。 |
| [`aicoding-agent.md`](aicoding-agent.md) / [`aicoding-agent.zh-CN.md`](aicoding-agent.zh-CN.md) | Coding 基础能力，横向服务 Chat / Work / Doc。 |
| [`cloud-capabilities.zh-CN.md`](cloud-capabilities.zh-CN.md) | 面向所有产品入口的 Cloud / Edge 基础设施。 |
| [`client-sdks.md`](client-sdks.md) | SDK 应暴露 `chat`、`work`、`doc` 和 `capabilities` 命名空间。 |
| [`web-ui.md`](web-ui.md) | 历史 Web UI MVP；后续 UI 应遵循 Chat / Work / Doc 导航。 |
| [`onboarding.md`](onboarding.md) | 首次启动应传达产品入口和初始能力选择。 |
| [`permission-modes.md`](permission-modes.md) | 跨产品权限与审批层。 |
| [`sandboxing.md`](sandboxing.md) | 跨产品执行安全层。 |
| [`prompt-caching.md`](prompt-caching.md) | 能力密集型请求的跨产品性能层。 |

## Doc v0 建议

因为 Chat 和 Work 已经有较多基础，Doc 是下一个需要明确边界的产品入口。建议最小版本：

```text
DocProject
  id
  workspace
  title
  kind: note | research | report | design | guide

DocSource
  id
  project_id
  kind: url | file | text | conversation | work_run
  title
  uri
  excerpt

DocDraft
  id
  project_id
  format: markdown
  content
  updated_at
```

v0 功能：

- 从 Chat 保存回答为 Doc draft；
- 从 WorkRun 生成总结文档；
- 添加 URL/file/text source；
- 生成 outline；
- Markdown 草稿编辑；
- 导出 Markdown；
- 后续接 DOCX/PDF/PPTX。

## Web UI 形态

顶层导航：

```text
Chat | Work | Doc
```

Chat：

- 保持当前主体验；
- 右侧/底部面板可切 TODO、Plan、Diff、Sources；
- 消息动作：保存 TODO、创建 Work task、保存到 Doc。

Work：

- 左侧 project / unit tree；
- 中间 run stream / manifest / verification；
- 右侧 TODO / diff / review / diagnostics。

Doc：

- 左侧 doc projects / sources；
- 中间 editor / outline；
- 右侧 source excerpts / citations / export / action items。

设置页继续承载 provider、权限、MCP、skills、plugins、cloud/edge。

## 迭代计划

### Phase 1：产品设计落地与 Coding Work 切入

- 新增本 proposal；
- README 中文/英文同步 Chat / Work / Doc 新定位；
- 统一使用产品定位：“面向小团队的本地优先 AI 工作空间，把编码讨论转化为可验证的任务执行和长期文档沉淀”；
- Web UI 顶层导航文案对齐；
- 明确 TODO board 是 Work 基础层。
- 第一阶段产品推进聚焦 Coding Work，不抢做通用办公自动化或完整 Doc 编辑器。

### Phase 2：Capability Pack manifest

- 定义 capability manifest schema；
- 先内置 `coding`、`office`、`research` 三个 pack；
- 在设置页或 debug endpoint 展示已启用能力；
- pack 只做声明，不急着做复杂动态加载。

### Phase 3：Chat 转化动作

- Chat message -> TODO；
- Chat message -> Work task；
- Chat message -> Doc draft；
- 工具结果 -> Doc source / Work artifact。

### Phase 4：Coding Work MVP

- 接 `work-orchestration.zh-CN.md`；
- 从 TODO 创建 Work task；
- WorkRun 手动执行；
- Verification gate。
- 第一批 Work 模板、提示词和 UI 状态优先服务 coding task：工作区上下文、diff、测试、review 和 follow-up 捕捉。

### Phase 5：Doc 作为 Work 输出

- 新增 DocProject / DocSource / DocDraft；
- Doc route 和 Markdown 编辑；
- 从 Chat / Work 创建 Doc；
- source 摘录和 outline。
- 优先做 Coding Work 产生的技术记录、changelog、实现总结和复盘。

### Phase 6：能力扩展市场

- capability packs 与 skills/plugins 对齐；
- 第三方能力包可以声明 tools、skills、prompts、surfaces；
- 与 MCP server / cloud edge tools 联动。

## 风险与取舍

- **顶层入口太多会稀释产品。**
  只保留 Chat / Work / Doc。新增能力进入能力层，不新增顶层入口。

- **能力层过早抽象。**
  v0 用 manifest + 内置 pack，等三个以上能力稳定后再做动态运行时。

- **Work 和 TODO 重叠。**
  TODO 是轻量 backlog；Work 是可执行状态机。不要把 TODO 复杂化。

- **Doc 变成普通富文本编辑器。**
  Doc 的差异化是 sources、citations、agent drafting、Work/Chat 回流，不是纯编辑。

- **Coding 绑死产品心智。**
  Coding 是核心能力之一，但不是唯一产品定位。Jarvis 是可扩展 agent workspace。

## 验收标准

- README 和 proposals 能清楚表达 Chat / Work / Doc 三产品入口；
- 文档明确小团队是第一目标用户，Coding Work 是第一阶段切入点；
- 基础能力层至少定义 Coding / 日常办公 / 资料研究三个 pack；
- 新增能力时有明确扩展位置，不需要改顶层导航；
- TODO board 被明确归入 Work 基础层；
- Work 和 Doc 的后续 proposal 可以引用本产品设计；
- Web UI 后续改版有清晰导航和状态归属依据。
