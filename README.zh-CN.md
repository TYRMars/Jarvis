# Jarvis

**Jarvis 是一个用 Node/TypeScript 构建的 Agent 运行时和编码工作台，用来构建、运行、扩展可调用工具的 AI Agent。** 它把一个小而清晰、与运行环境无关的 harness，与 Web UI、终端 UI、HTTP API、MCP 桥接、持久化会话、工作区感知工具、审批流和可插拔 LLM Provider 组合在一起。

默认 README 使用英文。中文翻译见 [README.zh-CN.md](README.zh-CN.md)。

## Jarvis 能做什么

Jarvis 面向编码 Agent 工作流设计，但核心 harness 是通用的：

- 通过 HTTP、SSE、WebSocket 或终端运行多轮 Agent。
- 连接 OpenAI、OpenAI Responses 兼容网关、Anthropic、Google Gemini、Codex OAuth、Ollama、Kimi 以及其他 OpenAI 兼容 Provider。
- 使用内置工具读取/列出/编辑/打补丁文件，做正则代码搜索，执行沙盒 shell，发起 HTTP 请求，检查 git 状态，生成计划，向用户提问，并读取工作区上下文。
- 把会话绑定到工作区，让文件系统、shell 和 git 操作都落在正确仓库里。
- 在聊天输入框上方直接看到当前选中的工作区和 git 分支。
- 可选地为新会话附加一个 Project 作为轻量上下文；项目选择刻意设计成弱提醒，而不是阻塞式的开场步骤。
- 默认用 JSON 文件持久化会话、项目、权限和工作区绑定，切换存储 URL 的 scheme 即可改用 SQLite、Postgres 或 MySQL。
- 通过权限模式和基于规则的权限策略管控敏感工具。
- 通过 MCP 桥接工具：既可以接入外部 MCP server，也可以把 Jarvis 工具暴露为 MCP server。
- 使用滑动窗口或摘要记忆把会话控制在 token 预算内。
- 通过 OpenTelemetry 追踪 Agent 运行和工具调用，并通过 git 或 iCloud 同步长期 Markdown 记忆。

## 产品界面

### Web App

Web UI 由服务根路径提供：

```bash
open http://127.0.0.1:7001/
```

当前 Web App 包含：

- Chat 工作区，支持流式回答和可见的工具活动。
- 类 Claude Code 的输入框上下文胶囊：本地运行时、工作区、git 分支、可选 Project 上下文、模型和权限模式。
- 会话侧栏、快速切换器、置顶会话、账户/设置菜单和连接状态。
- 工作区面板：diff、变更文件、任务、计划、预览、终端和变更报告。
- 设置页：Provider、服务状态、工作区、权限、MCP、插件、技能、外观和偏好。
- Work 和 Docs 路由，用于项目/产品上下文和文档界面。

SPA 位于 `apps/jarvis-web`（React 19 + react-router，由 Vite 构建）。Node 服务在 `/` 提供已构建的 `dist/` 产物。

### Terminal UI

`@jarvis/jarvis-cli` 在进程内运行同一套 harness，提供交互式 REPL、审批提示和非交互管道模式：

```bash
pnpm --filter @jarvis/jarvis-cli start
echo "summarize the README" | pnpm --filter @jarvis/jarvis-cli start -- --no-interactive
```

详见 [docs/user-guide-cli.md](docs/user-guide-cli.md)。

### HTTP 与 WebSocket API

Jarvis 暴露 OpenAI 风格和 Jarvis 原生接口：

- `POST /v1/chat/completions`
- `POST /v1/chat/completions/stream`
- `GET /v1/chat/ws`
- `GET /v1/conversations`
- `GET /v1/providers`
- `GET /v1/workspace`
- `GET /v1/workspace/diff`
- `GET /v1/projects`
- `GET /v1/projects/:id/requirements?triage_state=approved|proposed_by_*|proposed`
- `POST /v1/requirements/:id/{approve,reject,runs}` —— Triage 通过 / 拒绝（需附 `reason`）/ 创建一次全新会话的运行
- `GET/POST /v1/requirements/:id/todos`、`PATCH/DELETE /v1/requirements/:id/todos/:todo_id` —— 结构化执行/清单项，包含 CI/CD 命令和证据
- `POST /v1/memory/sync/*` —— git/iCloud Markdown 记忆同步接口（通过 `JARVIS_ENABLE_MEMORY` 启用）
- `GET /v1/diagnostics/{worktrees/orphans, runs/stuck, runs/failed}` —— 体检 / 取证
- `GET /v1/server/info`

WebSocket 是最完整的传输方式：支持多轮状态、恢复持久化会话、审批决策、HITL 响应、路由/模型切换、工作区切换，以及流式 `AgentEvent`。

## Spec → Project 工作流（v1.0）

v1.0 把看板变成一个 "spec 进、project 出" 的闭环。**Spec** 指任何 Agent 能读取的东西：一行用户请求、一份 Jarvis 通过 `fs.read` 拉取的 `docs/feature-x.md`，或者 `triage.scan_candidates` 在工作区里对 `TODO|FIXME|XXX|HACK` 注释扫描出的候选项。

流程如下：

1. **Capture（捕获）** —— 在聊天里跟 Jarvis 对话（"读一下 `docs/avatar-upload.md` 并把工作拆出来"）。Agent 调用 `workspace.context` + `fs.read`，用 `plan.update` 起草拆解，在用户确认后创建一个 Project，并为每一项生成一个 Requirement。
2. **Triage（分诊）** —— Agent 创建和扫描得到的行默认 `triage_state=proposed_by_*`，落在看板上方的 **Triage 抽屉**里。人类点击 **通过 / 拒绝**（后者需要一段自由文本理由，它会落到活动时间线上）。用户手动通过 REST 创建的行为了向后兼容默认 `triage_state=approved`。
3. **Execute（执行）** —— 打开任一已通过的 Backlog 卡片，在详情面板点击 **新建一次运行 / Start fresh run**。该按钮会创建一个绑定到该需求的新会话，把状态翻到 `in_progress`，并把你带进聊天。
4. **Auto（自动）** —— 给卡片设置 `assignee_id`，并用 `JARVIS_WORK_MODE=auto` 启动服务。后台调度器挑选 `depends_on` 全部 `done` 的 `Approved` 行，每个 tick 驱动一次运行，把卡片的结构化 TODO/清单项纳入运行提示，并在每轮 Agent loop 后运行该需求的 `verification_plan.commands`。需要 worktree 隔离的运行通过 `git worktree add` 进行作用域隔离（`JARVIS_WORKTREE_MODE=per_run`）。
5. **Verify（验证）** —— 每个 `RequirementRun` 都带有它的 `verification` 结果（每条命令的 stdout / stderr / exit_code，以及聚合的 `passed/failed/needs_review`）。失败的运行会在写入 `Blocked` 活动前把卡片翻回 Backlog。

完整规格见 [docs/proposals/work-orchestration.zh-CN.md](docs/proposals/work-orchestration.zh-CN.md)。

## 快速开始

Jarvis 运行在 **Node ≥ 22.6** 上，使用 **pnpm**。服务通过 `--experimental-strip-types` 直接运行 TypeScript 源码，所以运行它无需构建步骤。唯一需要预先构建的是 Web 产物。

### 1. 安装依赖

```bash
pnpm install
```

### 2. 构建 Web UI

服务从 `apps/jarvis-web/dist/` 提供已构建的 Web 产物，所以先构建一次前端：

```bash
make web
# 或者手动构建：
cd apps/jarvis-web && npm ci && npm run build
```

### 3. 配置 Provider

OpenAI 是默认 Provider：

```bash
export JARVIS_PROVIDER=openai
export OPENAI_API_KEY=sk-...
export JARVIS_MODEL=gpt-4o-mini
```

其他常见 Provider 配置：

```bash
# Anthropic
export JARVIS_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-ant-...

# Google Gemini
export JARVIS_PROVIDER=google
export GOOGLE_API_KEY=...

# Ollama 兼容本地服务
export JARVIS_PROVIDER=ollama
export OLLAMA_BASE_URL=http://localhost:11434/v1
export JARVIS_MODEL=llama3.2

# Codex OAuth provider
# 先运行一次 `codex login`，确保 ~/.codex/auth.json 存在。
export JARVIS_PROVIDER=codex
```

### 4. 配置工作区和持久化

```bash
export JARVIS_ADDR=0.0.0.0:7001
export JARVIS_FS_ROOT=.
# 持久化默认使用 ~/.local/share/jarvis/conversations/ 下的 JSON 文件。
# 切换后端只需改变 URL 的 scheme：
#   export JARVIS_DB_URL=sqlite://./jarvis.db
#   export JARVIS_DB_URL=postgres://user:pass@localhost/jarvis
```

可选工具开关（写入/执行类工具默认关闭，需显式启用）：

```bash
export JARVIS_ENABLE_FS_WRITE=1
export JARVIS_ENABLE_FS_EDIT=1
export JARVIS_ENABLE_FS_PATCH=1
export JARVIS_ENABLE_SHELL_EXEC=1
export JARVIS_SHELL_TIMEOUT_MS=30000
```

### 5. 运行

```bash
make dev
```

`make dev` 会构建 Web 产物，并在同一个进程里以内嵌 UI 运行服务。要直接运行服务：

```bash
node --experimental-strip-types packages/jarvis-app/src/main.ts serve --workspace /path/to/repo
```

然后打开 [http://127.0.0.1:7001/](http://127.0.0.1:7001/)。

我们也提供了容器镜像 —— `make docker` 构建镜像，`make docker-run` 运行它（见 [Makefile](Makefile) 和 [Dockerfile](Dockerfile)）。

## 配置参考

所有环境变量都由 composition root（`packages/jarvis-app/src/main.ts`）读取；库包永远不读 `process.env`。重要变量：

| 变量 | 用途 |
| --- | --- |
| `JARVIS_PROVIDER` | Provider 名称：`openai`（默认）、`openai-responses`、`anthropic`、`google`、`codex`、`kimi` 或 `ollama`。 |
| `JARVIS_MODEL` | 所选 Provider 的默认模型。 |
| `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GOOGLE_API_KEY`、`KIMI_API_KEY` | Provider 凭据（`GEMINI_API_KEY` → Google，`MOONSHOT_API_KEY` → Kimi）。 |
| `OPENAI_BASE_URL`、`ANTHROPIC_BASE_URL`、`GOOGLE_BASE_URL`、`OLLAMA_BASE_URL`、`KIMI_BASE_URL`、`CODEX_BASE_URL` | 兼容网关或代理地址。 |
| `JARVIS_ADDR` | HTTP 监听地址，默认 `0.0.0.0:7001`。 |
| `JARVIS_FS_ROOT` | 文件、git、shell 工具的默认工作区根目录（`--workspace <path>` 可覆盖）。 |
| `JARVIS_DB_URL` | 会话/项目存储地址。默认 `json:///<data>/jarvis/conversations`；scheme 决定后端（`json:` / `sqlite:` / `postgres://` / `mysql://`）。 |
| `JARVIS_MCP_SERVERS` | 逗号分隔的外部 MCP server 列表，例如 `fs=uvx mcp-server-filesystem /tmp`。 |
| `JARVIS_MEMORY_MODE` | 短期记忆模式：`window`（默认）或 `summary`。 |
| `JARVIS_MEMORY_TOKENS` | 短期记忆的启发式 token 预算。 |
| `JARVIS_MEMORY_MODEL` | `summary` 记忆模式使用的模型（默认取 `JARVIS_MODEL`）。 |
| `JARVIS_ENABLE_MEMORY` | 启用长期 Markdown 记忆存储和 `/v1/memory/sync*` 路由。 |
| `JARVIS_MEMORY_SYNC_BACKEND` | 长期记忆的同步后端（`git` / iCloud）。 |
| `JARVIS_MEMORY_USER_ROOT` | 长期用户记忆存储的根目录。 |
| `JARVIS_PERMISSION_MODE` | `ask` / `accept-edits` / `plan` / `auto` / `bypass`。（取代已废弃的 `JARVIS_APPROVAL_MODE`。） |
| `JARVIS_HTTP_ALLOW_PRIVATE` | 关闭 `http.fetch` 的 SSRF 防护（默认禁止访问私有网络）。 |
| `JARVIS_HTTP_MAX_BYTES` | `http.fetch` 响应体的截断上限。 |
| `JARVIS_OTEL_ENABLED` | 启用 OpenTelemetry 追踪（`jarvis.agent.run` + `gen_ai.tool.call` span）。 |
| `JARVIS_OTEL_CONSOLE` | 把 OpenTelemetry span 导出到控制台（便于本地调试）。 |
| `JARVIS_WORK_MODE` | `off`（默认）或 `auto`。设为 `auto` 时，后台调度器驱动已分配负责人的 Approved 需求。 |
| `JARVIS_WORK_TICK_SECONDS` | 调度器 tick 间隔（默认 `30`）。 |
| `JARVIS_WORK_MAX_CONCURRENT` | 并发自动运行的全局上限。 |
| `JARVIS_WORKTREE_MODE` | `off`（默认）/ `per_run` / `per_unit`。Auto 模式会把 `off` 提升为 `per_run`，让调度器永不改动主检出。 |
| `JARVIS_WORKTREE_ROOT` | 工作区下 `git worktree add` 落子树的目录（默认 `.jarvis/worktrees`）。 |
| `JARVIS_NO_PROJECT_CONTEXT` | 禁用把 `AGENTS.md` / `CLAUDE.md` / `AGENT.md` 作为项目上下文自动加载。 |
| `JARVIS_PROJECT_CONTEXT_BYTES` | 已加载项目上下文的字节上限（默认 8 KiB）。 |
| `JARVIS_ROUTER_ENABLED` | 用智能路由包装主 Provider（关闭 = 行为不变）。 |

项目上下文自动加载会从工作区根目录追加 `AGENTS.md`、`CLAUDE.md` 或 `AGENT.md`（按优先级），每个都包在上下文围栏里，并受 `JARVIS_PROJECT_CONTEXT_BYTES` 限制。用 `JARVIS_NO_PROJECT_CONTEXT=1` 或 `--no-project-context`（CLI）禁用。

安全基线（SSRF 防护、工具门禁、密钥处理）见 [docs/security/p8-security-baseline.md](docs/security/p8-security-baseline.md)，性能基线（`make perf`）见 [docs/observability/perf-baseline.md](docs/observability/perf-baseline.md)。

## 内置工具

Jarvis 自带命名空间化工具集：

- `echo`、`time.now`
- `http.fetch`（默认带 SSRF 防护）
- `fs.read`、`fs.list`、`fs.write`、`fs.edit`、`fs.patch`
- `code.grep`
- `shell.exec`
- `git.status`、`git.diff`、`git.log`、`git.show`（只读）
- `workspace.context`、`project.checks`
- `plan.update`、`ask.text`、`exit_plan`
- `triage.scan_candidates` —— 从 `TODO|FIXME|XXX|HACK` 标记中浮出后续 Requirement 候选项
- `todo.{list,add,update,delete}` —— 工作区范围的轻量待办
- `requirement.{list,start,block,complete,create,update,delete,review_verdict}` —— 看板行 CRUD；Agent 创建的行默认 `triage_state=proposed_by_agent`，等待人类通过
- `roadmap.import` —— 从 `docs/proposals/`、`docs/roadmap/` 或 `ROADMAP.md` 引导出一个 Project + 一批 Requirement
- `doc.{list,search,get,upsert,create,update,delete,draft.{get,save}}` —— 长文档 CRUD
- `memory.{list,read,write,delete,…,sync,sync_status,sync_setup}` —— Agent 长期记忆，支持 git/iCloud 同步
- `subagent.<name>`（`review` / `claude_code` / `codex` / `reader` / `batch` …）—— 可选启用的子 Agent 运行器

修改类工具默认关闭，并且会进入审批体系。composition root 决定注册哪些工具；`@jarvis/core` 只看得到 `ToolRegistry`。

## 架构

Jarvis 是一个 pnpm workspace。库位于 `packages/*`（内部以 `@jarvis/<name>` 发布）；应用位于 `apps/`：

```text
packages/
  core/            Agent loop、message model、Tool/LlmProvider/Store interfaces
  llm/             Provider implementations
  router/          Smart routing (difficulty-classified model selection)
  mcp/             MCP client and server bridge
  memory/          Sliding-window and summarizing memory
  server/          HTTP, SSE, WebSocket, and UI serving
  store/           JSON-file (default) + SQLite/Postgres/MySQL stores
  tools/           Built-in tools
  project/         "Work" feature domain types + stores (kanban + audit timeline)
  workflow/        Declarative multi-step agent workflows
  channel/         Channel value types + dispatcher/store interfaces
  skill/           Skills catalog
  subagents/       Delegated sub-agents
  learning/        Telemetry + long-term memory surfaces
  automation/      Scheduled tasks
  observability/   Eval + observed value types
  plugin/          Plugin packaging
  shared-types/    Wire-shape types crossing the SPA boundary
  jarvis-app/      Server binary + composition root (the only env reader)
  jarvis-cli/      Terminal coding-agent UI
  desktop/         Desktop shell bindings
apps/
  jarvis-web/      React 19 + react-router SPA, built by Vite
  jarvis-desktop/  Tauri shell
  jarvis-ios/      iOS shell
```

核心设计规则：

> `@jarvis/core` 不知道 HTTP、Provider、存储、MCP 或 Web UI 的存在。

详细分层和请求生命周期见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## MCP 模式

把 Jarvis 作为 MCP server 运行，通过 stdio 暴露本地 `ToolRegistry`（无需 LLM/HTTP 配置）：

```bash
node --experimental-strip-types packages/jarvis-app/src/main.ts mcp-serve
```

或者在运行时接入外部 MCP server：

```bash
export JARVIS_MCP_SERVERS='fs=uvx mcp-server-filesystem /tmp,git=uvx mcp-server-git'
```

## 开发

```bash
make check        # typecheck + lint + test —— CI 跑的就是这个
make typecheck    # pnpm -r typecheck (每个包 tsc --noEmit)
make lint         # eslint . (CI 门禁)
make test         # pnpm -r test (每个包 node --test)
make perf         # 运行 harness 性能基线
make web          # 把 Web 产物构建到 apps/jarvis-web/dist
make dev          # 构建 Web + 以内嵌 UI 运行 Node 服务
```

等价的原始命令：

```bash
pnpm -r typecheck && pnpm -r test
pnpm lint
pnpm --filter @jarvis/core test          # 测试单个包
```

修改由 Node 服务提供的 Web UI 时，重新构建前端（`make web`），以便服务提供新的 `dist/` 产物。**eslint 是门禁** —— 保持代码树对它干净。

## 文档

- [README.zh-CN.md](README.zh-CN.md) —— 中文翻译。
- [CHANGELOG.md](CHANGELOG.md) —— 产品变更记录。
- [docs/user-guide.md](docs/user-guide.md) —— 完整用户指南。
- [docs/user-guide-web.md](docs/user-guide-web.md) —— Web UI 指南。
- [docs/user-guide-cli.md](docs/user-guide-cli.md) —— 终端 UI 指南。
- [docs/user-guide-coding-agent.md](docs/user-guide-coding-agent.md) —— Coding Agent 工作流示例。
- [ARCHITECTURE.md](ARCHITECTURE.md) —— 系统架构。
- [DB.md](DB.md) —— 持久化 schema 与 store 说明。
- [docs/security/p8-security-baseline.md](docs/security/p8-security-baseline.md) —— 安全基线。
- [docs/observability/perf-baseline.md](docs/observability/perf-baseline.md) —— 性能基线。

## 状态

Jarvis 已经可以作为本地 Coding Agent runtime 和可扩展 Agent harness 使用。核心 loop、多 Provider、Web/Terminal 前端、持久化会话、工作区感知工具、MCP 桥接、审批、记忆、OpenTelemetry 追踪，以及 git/iCloud 记忆同步都已实现。部分产品表面仍在演进，尤其是长期记忆、更完整的项目/文档工作流，以及不同 Provider 的体验打磨。
