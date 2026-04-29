# Jarvis

**Jarvis 是一个用 Rust 构建的 Agent 运行时和编码工作台，用来构建、运行、扩展可调用工具的 AI Agent。** 它把一个小而清晰、与运行环境无关的 harness，与 Web UI、终端 UI、HTTP API、MCP 桥接、持久化会话、工作区工具、审批流和可插拔 LLM Provider 组合在一起。

默认 README 使用英文：见 [README.md](README.md)。

## Jarvis 能做什么

Jarvis 面向编码 Agent 工作流设计，但核心 harness 是通用的：

- 通过 HTTP、SSE、WebSocket 或终端运行多轮 Agent。
- 连接 OpenAI、OpenAI Responses 兼容网关、Anthropic、Google Gemini、Codex OAuth、Ollama、Kimi 以及其他 OpenAI 兼容 Provider。
- 使用内置工具读取/列出/编辑/打补丁文件，做正则代码搜索，执行沙盒 shell，发起 HTTP 请求，检查 git 状态，生成计划，向用户提问，并读取工作区上下文。
- 把会话绑定到工作区，让文件系统、shell 和 git 操作都落在正确仓库里。
- 在聊天输入框上方直接看到当前工作区和 git 分支。
- 可选地为新会话附加 Project 上下文；项目选择只是弱提醒，不会阻塞开始对话。
- 使用 SQLite 默认持久化会话、项目、权限和工作区绑定；Postgres/MySQL 通过 cargo features 启用。
- 通过审批模式和规则策略管控敏感工具。
- 通过 MCP 桥接工具：既可以接入外部 MCP server，也可以把 Jarvis 工具暴露为 MCP server。
- 使用滑动窗口或摘要记忆把会话控制在 token 预算内。

## 产品界面

### Web App

Web UI 由服务根路径提供：

```bash
open http://127.0.0.1:7001/
```

当前 Web App 包含：

- Chat 工作区，支持流式回答、工具活动和审批状态可见。
- 类 Claude Code 的输入框上下文胶囊：本地运行时、工作区、git 分支、可选 Project、模型和权限模式。
- 会话侧栏、快速切换器、置顶会话、账户/设置菜单和连接状态。
- 工作区面板：diff、变更文件、任务、计划、预览、终端和变更报告。
- 设置页：Provider、服务状态、工作区、权限、MCP、插件、技能、外观和偏好。
- Work 和 Docs 路由，用于项目/产品上下文和文档工作流。

### Terminal UI

`jarvis-cli` 在进程内运行同一套 harness，提供交互式 REPL、审批提示和非交互管道模式：

```bash
cargo run -q -p jarvis-cli
echo "summarize the README" | cargo run -q -p jarvis-cli -- --no-interactive
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
- `GET /v1/server/info`

WebSocket 是最完整的传输方式：支持多轮状态、恢复持久化会话、审批决策、HITL 响应、模型/路由切换、工作区切换，以及流式 `AgentEvent`。

## 快速开始

### 1. 构建 Web UI

release binary 会在编译时嵌入 Web bundle，所以需要先构建前端，再构建 `jarvis`：

```bash
cd apps/jarvis-web
npm install
npm run build
cd ../..
```

### 2. 配置 Provider

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

### 3. 配置工作区和持久化

```bash
export JARVIS_ADDR=0.0.0.0:7001
export JARVIS_FS_ROOT=.
export JARVIS_DB_URL=sqlite://./jarvis.db
```

可选工具开关：

```bash
export JARVIS_ENABLE_FS_WRITE=1
export JARVIS_ENABLE_FS_EDIT=1
export JARVIS_ENABLE_FS_PATCH=1
export JARVIS_ENABLE_SHELL_EXEC=1
export JARVIS_SHELL_TIMEOUT_MS=30000
```

### 4. 运行

```bash
cargo run -p jarvis -- serve --workspace /path/to/repo
```

或者构建并运行 release binary：

```bash
cargo build --release -p jarvis
target/release/jarvis serve
```

然后打开 [http://127.0.0.1:7001/](http://127.0.0.1:7001/)。

## 配置参考

重要环境变量：

| 变量 | 用途 |
| --- | --- |
| `JARVIS_PROVIDER` | Provider 名称，例如 `openai`、`anthropic`、`google`、`codex`、`ollama`。 |
| `JARVIS_MODEL` | 所选 Provider 的默认模型。 |
| `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GOOGLE_API_KEY` | Provider 凭据。 |
| `OPENAI_BASE_URL`、`ANTHROPIC_BASE_URL`、`GOOGLE_BASE_URL`、`OLLAMA_BASE_URL` | 兼容网关或代理地址。 |
| `JARVIS_ADDR` | HTTP 监听地址，默认 `0.0.0.0:7001`。 |
| `JARVIS_FS_ROOT` | 文件、git、shell 工具的默认工作区根目录。 |
| `JARVIS_DB_URL` | 会话/项目存储地址，例如 `sqlite://./jarvis.db`。 |
| `JARVIS_MCP_SERVERS` | 外部 MCP server 列表，例如 `fs=uvx mcp-server-filesystem /tmp`。 |
| `JARVIS_MEMORY_MODE` | `window` 或 `summary`。 |
| `JARVIS_MEMORY_TOKENS` | 记忆 token 预算的启发式上限。 |
| `JARVIS_APPROVAL_MODE` | 默认审批模式。 |
| `RUST_LOG` | Rust tracing 过滤器。 |

## 内置工具

Jarvis 自带命名空间化工具集：

- `echo`、`time.now`
- `http.fetch`
- `fs.read`、`fs.list`、`fs.write`、`fs.edit`、`fs.patch`
- `code.grep`
- `shell.exec`
- `git.status`、`git.diff`、`git.log`、`git.show`
- `workspace.context`
- 计划、审批和用户输入辅助工具

修改类工具默认需要显式启用，并会进入审批体系。binary composition root 决定注册哪些工具；`harness-core` 只知道 `ToolRegistry`。

## 架构

Jarvis 是一个 Cargo workspace：

```text
crates/
  harness-core/    Agent loop、message model、Tool/LlmProvider/Store traits
  harness-llm/     Provider implementations
  harness-mcp/     MCP client/server bridge
  harness-memory/  Sliding-window 和 summarizing memory
  harness-server/  Axum HTTP、SSE、WebSocket 和 UI serving
  harness-store/   SQLite/Postgres/MySQL stores
  harness-tools/   Built-in tools
apps/
  jarvis/          Server binary 和 composition root
  jarvis-cli/      Terminal coding-agent UI
  jarvis-web/      React Web App，编译进 server binary
```

核心设计规则：

> `harness-core` 不知道 HTTP、Provider、存储、MCP 或 Web UI 的存在。

更完整的分层和请求生命周期见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## MCP 模式

把 Jarvis 作为 MCP server 运行，通过 stdio 暴露本地 `ToolRegistry`：

```bash
cargo run -p jarvis -- --mcp-serve
```

或者在运行时接入外部 MCP server：

```bash
export JARVIS_MCP_SERVERS='fs=uvx mcp-server-filesystem /tmp,git=uvx mcp-server-git'
```

## 开发

```bash
cargo check --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm --prefix apps/jarvis-web run build
cargo build --release -p jarvis
```

如果修改的是由 `target/release/jarvis` 提供的 Web UI，需要先重新构建前端，再重新构建 Rust binary，让新的 `dist/` bundle 被嵌入。

## 文档

- [README.md](README.md) — 英文默认 README。
- [CHANGELOG.md](CHANGELOG.md) — 产品变更记录。
- [docs/user-guide.md](docs/user-guide.md) — 完整用户指南。
- [docs/user-guide-web.md](docs/user-guide-web.md) — Web UI 指南。
- [docs/user-guide-cli.md](docs/user-guide-cli.md) — 终端 UI 指南。
- [docs/user-guide-coding-agent.md](docs/user-guide-coding-agent.md) — Coding Agent 工作流示例。
- [ARCHITECTURE.md](ARCHITECTURE.md) — 系统架构。
- [DB.md](DB.md) — 持久化 schema 与 store 说明。

## 状态

Jarvis 已经可以作为本地 Coding Agent runtime 和可扩展 Agent harness 使用。核心 loop、多 Provider、Web/Terminal 前端、持久化会话、工作区工具、MCP 桥接、审批和记忆都已实现。部分产品表面仍在演进，尤其是长期记忆、更完整的项目/文档工作流，以及不同 Provider 的体验打磨。
