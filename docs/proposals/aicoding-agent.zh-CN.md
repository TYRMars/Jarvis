# Coding 基础能力与工作流

**状态：** Proposed
**涉及：** `harness-tools`、`harness-core` 事件层、
`harness-server` WS/SSE 传输、`apps/jarvis-web`、文档。

## 背景

Jarvis 现在已经具备 **Coding 基础能力** 的核心积木：流式 agent loop、多 provider、
文件工具、正则代码搜索、`shell.exec`、审批、memory、持久化，以及一个 Web
客户端。

下一步更有价值的方向，是把这些积木组合成一个可被 Chat / Work / Doc 复用的
Coding capability pack，并提供接近 Codex / Claude Code 的使用体验：

- 在修改代码前先理解当前工作区；
- 不依赖开放式 shell，也能读取 Git 状态和 diff；
- 工作时维护一个显式计划；
- 用小而可审查的方式修改文件；
- 跑有针对性的检查，并实时展示命令输出；
- 只有在涉及修改或命令执行时才打断用户请求审批；
- 最后清楚说明改了什么、验证了什么、还剩什么风险。

这个 proposal 的目标，是在不破坏现有架构边界的前提下，把 Coding 从“单独产品形态”
调整为横向基础能力。核心设计原则仍然不变：`harness-core` 只拥有 agent loop 和
trait，不理解 Git、HTTP、存储、UI 或具体工具策略。

## 产品对齐

在 Chat / Work / Doc 的产品设计中，Coding 不是顶层产品入口，而是基础能力：

- **Chat：** 代码问答、解释、快速 patch、一次性检查；
- **Work：** 可验证的编码任务、fresh session、`WorkContextManifest`、测试门禁和 review；
- **Doc：** 技术设计、变更说明、API 文档、复盘和代码库说明。

本 proposal 负责 Coding 能力的工具、提示词、默认安全策略和 UI 呈现方式；是否进入
长期执行状态，由 Work 编排层决定。

## 目标

1. **默认具备工作区感知能力。**
   模型可以低成本知道当前 repo 的文件结构、Git 状态、项目说明和相关代码位置。

2. **优先提供安全的代码工具，而不是一上来开放 shell。**
   只读 Git 工具和代码检查工具默认可用；会修改宿主机的能力仍然走审批。

3. **让计划成为一等事件。**
   UI/传输层可以直接展示“agent 正在做什么”，而不是从自然语言里猜。

4. **形成紧凑的 edit-test-review 循环。**
   agent 能修改文件、运行聚焦检查、查看 diff，并在结束时给出简洁变更报告。

5. **审批点符合代码工具的直觉。**
   只有 `fs.edit`、`fs.write`、`fs.patch`、`shell.exec` 这类危险操作需要审批，
   且审批卡片要提供足够上下文，让用户能快速判断。

非目标：

- 不把 `shell.exec` 做成完整终端模拟器；
- 不做完整 IDE；
- 不为 coding 场景复制一套新的 agent loop；
- 不默认支持自动 commit / push。

## 目标体验

在 Web UI 或未来 CLI 中：

```text
User: fix the failing message serialization test

Jarvis
  plan
    ✓ inspect repo status
    ✓ find the failing test path
    • patch serializer handling
    • run targeted cargo test
    • show diff summary

  tool: git.status
    ## codex/intelligent
     M crates/harness-core/src/message.rs

  tool: code.grep
    crates/harness-core/src/message.rs:...

  approval: allow fs.edit on crates/harness-core/src/message.rs?
    [Approve] [Deny]

  tool: shell.exec
    cargo test -p harness-core message::

  summary
    Changed tool-call argument serialization to preserve object args.
    Verified with cargo test -p harness-core message::.
```

用户的感受应该是：Jarvis 真的在这个 repo 里工作，而不是只是在“回答关于 repo 的问题”。

## 能力设计

### 1. 工作区上下文包

新增只读工具 `workspace.context`，返回一个紧凑 JSON：

```json
{
  "root": "/repo",
  "vcs": "git",
  "branch": "codex/intelligent",
  "instructions": ["AGENTS.md", "CLAUDE.md"],
  "manifest": ["Cargo.toml", "apps/jarvis-web/package.json"],
  "dirty": true
}
```

实现位置：

- `harness-tools/src/workspace.rs`
- 复用现有 `resolve_under` 路径 sandbox 逻辑；
- 只读取小范围 allowlist 中的项目说明和 manifest 文件；
- 不递归读取源码内容。

价值：这给模型一个低成本的“第一眼”，也让 UI 可以明确展示“已加载工作区上下文”。

### 2. 只读 Git 工具

新增固定参数的 Git 包装工具，默认注册：

| 工具 | 行为 | 说明 |
|---|---|---|
| `git.status` | `git --no-pager -C <root> status --short --branch [-- path]` | 默认包含 untracked 文件。 |
| `git.diff` | `git --no-pager -C <root> diff [--cached] [--stat] [-- path]` | 输出截断，支持 context 行数。 |
| `git.show` | `git --no-pager -C <root> show --stat --summary <rev>` | 后续可选；不开放任意 git 命令。 |

这些工具不走 shell、不写文件、不需要审批。路径参数必须在 `JARVIS_FS_ROOT` 下，输出有上限。

它们的作用是让 agent 在修改前后都能像 Codex 一样看清楚当前工作树：先看 status，
不要覆盖用户改动，最后展示 diff。

### 3. 结构化计划事件

给 `harness-core` 增加可选的计划事件：

```rust
pub enum AgentEvent {
    ...
    PlanUpdate { items: Vec<PlanItem> },
}

pub struct PlanItem {
    pub id: String,
    pub title: String,
    pub status: PlanStatus, // pending | in_progress | completed
}
```

最小实现可以是一个工具：

```text
plan.update({ items: [...] })
```

`plan.update` 不调用操作系统，只负责把最新计划写入 agent stream，并向模型返回
`"ok"`。

为什么用工具，而不是解析 assistant 的自然语言：

- provider 已经理解 tool call；
- UI 拿到的是稳定类型事件；
- 模型可以在执行过程中修订计划；
- 不需要解析 provider 私有的 reasoning 格式。

### 4. 面向 patch 的编辑能力

现有 `fs.edit` 很适合精确替换，但 coding agent 经常需要多 hunk 修改，且不应该整文件重写。
因此新增一个需要审批的工具：

| 工具 | 作用 |
|---|---|
| `fs.patch` | 在工作区内应用 unified diff。 |

规则：

- `requires_approval() = true`；
- 拒绝绝对路径和 `..`；
- 拒绝 patch 修改 root 外的路径；
- 拒绝二进制 patch；
- hunk 不能 clean apply 时失败；
- 返回每个文件的修改摘要和行数；
- 不自动 stage。

这能保留 Codex 风格工作流里最重要的一点：每次修改都是小块、可审查、可解释的。
`fs.write` 仍然存在，但应该主要用于创建新文件，而不是改已有文件。

### 5. 检查命令 profile

继续保留 `shell.exec` 作为执行 primitive，但让代码检查体验更好：

- 审批前展示完整命令；
- 展示 cwd 和 timeout；
- stdout / stderr 使用已有 `ToolProgress` 实时流式输出；
- 最终结果包含 exit code 和截断后的 stdout / stderr。

后续可以新增只读工具 `project.checks`，根据 manifest 给出建议命令：

| Manifest | 建议检查 |
|---|---|
| `Cargo.toml` | `cargo check --workspace`、`cargo test --workspace`、clippy gate |
| `package.json` | `npm test`、`npm run lint`、`npm run build` |
| `pyproject.toml` | 配置存在时建议 `pytest`、`ruff check`、`mypy` |

这个工具只建议，不执行。真正执行仍然通过 `shell.exec` 和审批。

### 6. 最终变更报告

每次 coding turn 结束时，assistant 应输出一个紧凑报告：

- 改了哪些文件；
- 跑了哪些测试或检查；
- 哪些检查没跑，原因是什么；
- 还有哪些风险。

这不应该写死在 `harness-core` 里，而应该通过组合实现：

- 更新 `apps/jarvis` 的默认 coding system prompt；
- 暴露 `git.status` / `git.diff` 让模型获得事实依据；
- UI 正常渲染最终 assistant 文本。

## Prompt 契约

当文件编辑或 shell 工具启用时，`apps/jarvis` 使用更偏 coding-agent 的默认系统提示词：

```text
You are Jarvis, a coding agent working in the user's repository.
Before editing, inspect workspace context and git status. Do not
overwrite user changes you did not make. Prefer code.grep, fs.read,
git.status, and git.diff before shell.exec. Use fs.patch or fs.edit
for small reviewable edits. Run focused checks when practical. End
with changed files, checks run, and residual risk.
```

具体 prompt 放在 `apps/jarvis`，库 crate 不感知 prompt。

## 架构边界

```text
apps/jarvis
  构建 ToolRegistry
  默认注册 coding tools
  在 edit/shell 工具启用时选择 coding system prompt

harness-tools
  workspace.context
  git.status / git.diff
  fs.patch
  project.checks

harness-core
  继续使用现有 Tool trait
  如果 plan.update 需要一等事件，则增加可选 PlanUpdate AgentEvent

harness-server
  继续序列化 AgentEvent
  WS approval 仍然是 mutation gate

apps/jarvis-web
  根据 PlanUpdate 渲染 plan card
  更紧凑地渲染 Git / diff / check 工具卡片
```

关键点：Git、patch、项目识别都留在 `harness-tools`；传输层只负责渲染事件；
核心 loop 仍然不关心工具语义。

## 实施拆分

1. **只读 context 和 Git 工具。**
   新增 `workspace.context`、`git.status`、`git.diff`，默认注册。测试覆盖非 Git 目录、
   dirty worktree、路径 scoping、输出截断。

2. **Coding prompt。**
   当 `JARVIS_FS_ROOT` 指向 repo，或 edit/shell 工具启用时，把 `apps/jarvis` 的泛用
   system prompt 换成 coding-aware prompt。纯聊天场景保留简洁 fallback。

3. **Plan 工具和 UI 渲染。**
   新增 `plan.update`，映射为 typed stream event，并在现有 workspace rail 中渲染。
   不需要改 provider。

4. **Patch 工具。**
   新增 gated `fs.patch`。第一版支持 unified diff，可用一个小 parser 或专门 crate。
   测试必须覆盖 clean apply、stale hunk、root 外路径、审批拒绝。

5. **Project checks 建议。**
   新增只读 `project.checks`，根据 manifest 做保守启发式建议。

6. **工具卡片体验优化。**
   在 `apps/jarvis-web` 中，让 `git.diff` / `fs.patch` 用 diff 高亮展示；
   让 `shell.exec` progress 保持稳定的终端式表面。

7. **文档和示例。**
   更新 README、user guide、web guide，加入一条完整 coding-agent walkthrough：
   inspect、edit、approve、test、final diff。

## 安全模型

默认安全：

- `workspace.context`、`git.status`、`git.diff`、`project.checks`、
  `code.grep`、`fs.read`、`fs.list` 都是只读；
- `fs.patch`、`fs.edit`、`fs.write`、`shell.exec` 都需要审批；
- `shell.exec` 仍然默认关闭，需要显式启用；
- 不默认 commit、push、安装依赖或访问网络。

推荐策略：

- Web/CLI 交互模式：使用 `ChannelApprover`；
- 非交互模式：使用 `AlwaysDeny`；
- 本地可信 demo：可以使用 `AlwaysApprove`，但必须保留可见审计事件。

## 风险和问题

- **Patch parser 选择。**
  依赖现成 crate 可以减少手写 parser 的 bug，但过于通用的 patch engine 可能带来意外文件操作。
  第一版应只支持 root 内文本 hunk。

- **行为依赖 prompt。**
  “修改前先看 git status” 是行为契约，不是硬性保证。如果以后需要强约束，可以由传输层
  注入隐藏首轮，或加入 planner policy。

- **大 diff。**
  必须截断。agent 在 repo 很脏时应该先使用 `stat = true` 或 path filter。

- **非 Git 项目。**
  工具需要优雅降级：`workspace.context` 仍然工作；`git.*` 返回清晰错误。

- **UI 噪声。**
  coding turn 会产生很多工具卡片。Web UI 应默认折叠只读 inspection 工具，把审批卡片保持醒目。

## 成功标准

- 用户可以让 Jarvis 修一个小 bug，并看到：计划、repo 状态、文件检查、审批编辑、
  测试命令、最终 diff 摘要。
- 同一流程通过 WS 和 Web UI 工作，不需要 provider 特判。
- Rust 侧仍然以 `cargo clippy --workspace --all-targets -- -D warnings` 作为质量门。
- 敏感操作永远不会被静默启用。
