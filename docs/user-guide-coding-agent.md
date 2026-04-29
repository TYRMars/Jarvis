# Jarvis Coding Agent 工作流指南

> 面向想用 Jarvis 修代码的开发者。本文是端到端 walkthrough：从工作区
> 指定到最终 diff，覆盖 plan / fs.patch / git.diff / project.checks
> 等所有 coding-agent 相关能力。
>
> 配置参考见 `docs/user-guide.md`，前瞻设计见
> `docs/proposals/aicoding-agent.zh-CN.md`。

---

## 速览

Jarvis 的 coding agent 不是单独的二进制 —— 而是同一个 `jarvis serve`
在以下条件全部满足时**自动**进入 coding 模式：

1. 启动时指定了一个工作区（`--workspace` / `JARVIS_FS_ROOT`）；
2. 启用了至少一个修改类工具（`fs.edit` / `fs.write` / `fs.patch` /
   `shell.exec`）；
3. 没有显式设置 `[agent].system_prompt` 覆盖。

满足后，agent 自动切换到 coding-aware system prompt（要求
inspect → plan → patch → check → report 的工作循环），**并且工作区根目录的
`AGENTS.md` / `CLAUDE.md` / `AGENT.md` 会自动拼接到 system prompt**
（合计上限 32 KiB；用 `JARVIS_NO_PROJECT_CONTEXT=1` 关闭，
`JARVIS_PROJECT_CONTEXT_BYTES=N` 调上限），并且这些工具会被注册：

| 工具 | 默认状态 | 必须审批？ | 作用 |
|---|---|---|---|
| `workspace.context` | 开 | 否 | 仓库速览（branch / dirty / manifest） |
| `git.status` / `git.diff` / `git.log` / `git.show` | 开 | 否 | 只读 git 检视 |
| `code.grep` / `fs.read` / `fs.list` | 开 | 否 | 工作区探索 |
| `project.checks` | 开 | 否 | 推荐 test/lint/build 命令 |
| `plan.update` | 开 | 否 | 把计划推到事件流 → UI 渲染 |
| `fs.edit` | 关（`JARVIS_ENABLE_FS_EDIT=1`） | **是** | 单点 unique-string 替换 |
| `fs.patch` | 关（`JARVIS_ENABLE_FS_PATCH=1`） | **是** | 多 hunk unified diff，原子提交 |
| `fs.write` | 关（`JARVIS_ENABLE_FS_WRITE=1`） | **是** | 整文件写入（建议只用于新建） |
| `shell.exec` | 关（`JARVIS_ENABLE_SHELL_EXEC=1`） | **是** | 跑测试 / 构建命令 |

---

## 1. 启动一个 coding session

最小可用的 coding setup（可信本地环境，自动审批）：

```bash
export JARVIS_PROVIDER=openai          # 或 anthropic / codex / kimi / ollama
export OPENAI_API_KEY=sk-...
export JARVIS_ENABLE_FS_EDIT=1
export JARVIS_ENABLE_FS_PATCH=1
export JARVIS_ENABLE_SHELL_EXEC=1
export JARVIS_APPROVAL_MODE=auto       # 跳过手动审批，开发期方便

cargo run -p jarvis -- serve --workspace ~/code/myrepo
```

启动日志会出现：

```
INFO workspace=/Users/you/code/myrepo workspace root resolved
INFO provider=openai model=gpt-4o-mini registered=14 mcp_servers=0 tools registered
```

工具数 = 内置只读 (`workspace.context` / `project.checks` /
`plan.update` / `fs.read` / `fs.list` / `code.grep` / `http.fetch` /
`time.now` / `echo` + `git.status` / `git.diff` / `git.log` /
`git.show`) + 你启用的修改类工具。

打开 `http://localhost:7001/ui/` 进 Web UI。chat header 右上角会出现
一个 **workspace badge**，显示当前根 + 分支 + dirty 状态，例如
`~/code/myrepo · main●`；点击会重新探一次 git 状态。鼠标悬停看
完整路径和短 sha。

右侧 workspace rail 默认显示 **Tasks**（已运行的工具卡片）和
**Plan**（agent 计划清单）两个卡片；Plan 还没有内容时显示空态。

### 不开服务也想确认 workspace 解析对了？

```bash
cargo run -q -p jarvis -- workspace
# workspace: /Users/you/code/myrepo
# vcs:       git
# branch:    main (34cd366) ✓ clean

cargo run -q -p jarvis -- workspace --json
# {"branch":"main","dirty":false,"head":"34cd366",
#  "root":"/Users/you/code/myrepo","vcs":"git"}
```

`jarvis workspace` 复用与 `jarvis serve` 完全一致的解析顺序
（`--workspace > JARVIS_FS_ROOT > [tools].fs_root > .`），所以打印出来
什么样，agent 就在什么目录里干活，不用再猜。`--json` 形式跟
`GET /v1/workspace` HTTP 接口同 schema，方便接 CI / shell 脚本。

### 想严格手动审批？

把 `JARVIS_APPROVAL_MODE=auto` 换成不设（或换成 `deny` 配合 WS 客户端
覆盖）。WS 协议下每次 `fs.edit` / `fs.patch` / `fs.write` /
`shell.exec` 都会先弹一张 approval 卡，你按 Approve / Deny。

---

## 2. 一次完整的 turn 长什么样

让我们以"修一个失败的测试"为例。用户输入：

```
帮我修一下 crates/harness-core/src/message.rs 里那个 tool-call
arg 的序列化测试，现在它在 main 上挂了
```

agent 的典型动作序列（你会在 UI 里看到）：

### Step 1 — 工作区定向

agent 第一件事通常是 `workspace.context`：

```json
{
  "root": "/Users/you/code/myrepo",
  "vcs": "git",
  "branch": "main",
  "head": "34cd366",
  "dirty": false,
  "instructions": ["AGENTS.md", "CLAUDE.md", "README.md"],
  "manifest": ["Cargo.toml", "apps/jarvis/Cargo.toml", ...],
  "tools_root_top_level": ["apps", "crates", "docs", ...]
}
```

UI: Tasks 卡片出现一行 `workspace.context · done`。

### Step 2 — 写下计划

agent 调 `plan.update`：

```json
{
  "items": [
    {"id": "find-test", "title": "Locate the failing test", "status": "in_progress"},
    {"id": "read-src",  "title": "Read message.rs to understand current shape", "status": "pending"},
    {"id": "patch",     "title": "Patch the serializer", "status": "pending"},
    {"id": "verify",    "title": "Run cargo test -p harness-core message::", "status": "pending"}
  ]
}
```

UI: 右侧 Plan 卡片立即从空态变成四行清单，第一行带蓝色 spinner
（`in_progress`），其它三行灰圈 `todo`。Plan 是**全量替换**的，
agent 后面每次 `plan.update` 都会发完整列表，UI 直接 swap。

### Step 3 — 探查仓库

`git.status` 看是否有 dirty 改动 → `code.grep` / `fs.read` 找文件 →
agent 标 `find-test` 为 `completed`、`read-src` 为 `in_progress`。

### Step 4 — 改代码（patch）

复杂改动用 `fs.patch`，会先弹 approval 卡（如果你没设
`JARVIS_APPROVAL_MODE=auto`）：

```diff
diff --git a/crates/harness-core/src/message.rs b/crates/harness-core/src/message.rs
--- a/crates/harness-core/src/message.rs
+++ b/crates/harness-core/src/message.rs
@@ -120,7 +120,7 @@
 fn serialize_tool_args(args: &Value) -> String {
-    args.to_string()
+    serde_json::to_string(args).unwrap_or_else(|_| "{}".to_string())
 }
```

Approve 之后，agent 收到结构化结果：

```
applied 1 file(s):
  M crates/harness-core/src/message.rs   (+1 -1)
```

UI 渲染：
- Task 卡片显示 `fs.patch · done`
- 工具卡展开后，**args.diff 用 `UnifiedDiffViewer` 高亮**：
  红色 `-`、绿色 `+`、蓝色 `@@` 头、灰色文件头
- 顶部统计条：`+1 -1 · 6 lines`

简单单点改用 `fs.edit`（uniqueness-checked replace）就够了。
`fs.write` 留给真正新建文件的场景。

### Step 5 — 跑检查

agent 调 `project.checks`，拿到 Cargo 项目的命令建议：

```json
{
  "suggestions": [
    {"manifest": "Cargo.toml", "kind": "check", "command": "cargo check --workspace", "why": "..."},
    {"manifest": "Cargo.toml", "kind": "lint",  "command": "cargo clippy --workspace --all-targets -- -D warnings", "why": "..."},
    {"manifest": "Cargo.toml", "kind": "test",  "command": "cargo test --workspace", "why": "..."}
  ]
}
```

注意 `project.checks` **只建议**。agent 想真跑必须显式调
`shell.exec`：

```json
{ "command": "cargo test -p harness-core message::", "timeout_ms": 60000 }
```

如果开了 approval 又不是 auto 模式，这里再弹一张审批卡。Approve →
shell 跑起来，stdout / stderr 通过 `tool_progress` 事件流式回到 UI，
你能实时看到 `running 5 tests ... test message::serialize ... ok`。

### Step 6 — 收尾确认

agent 调 `git.diff` 看最终改动 —— 这次返回的 diff 也会**自动用
diff 高亮**渲染（不是普通 `<pre>`）。

最后 `plan.update` 把所有 item 标 `completed`，并输出收尾 markdown：

> Changed `crates/harness-core/src/message.rs:120-123`: replaced
> the unwrap-style `to_string` with explicit `serde_json::to_string`
> + safe fallback. Verified with `cargo test -p harness-core
> message::` (5 passed). Did not run clippy — no behaviour change
> beyond the one line. No residual risk; the fallback only triggers
> if `Value` contains an embedded `f64::NAN`, which the existing
> tool-call schema doesn't allow.

---

## 3. UI 渲染速查

| 事件 | UI 体现 |
|---|---|
| `tool_start` | 聊天里出现可折叠工具卡 + Tasks 卡片新增一行 `running` |
| `tool_progress` | 卡片自动展开，stdout/stderr 实时滚动 |
| `tool_end` | 卡片显示 `done` / `error` / `denied` |
| `plan_update` | 右侧 Plan 卡片整体 swap（全量替换） |
| `approval_request` | 审批面板弹卡片，含工具名 + 参数 |
| `approval_decision` | 卡片关闭，对应 task 状态更新 |

特殊渲染：

- `fs.edit` args → 计算 diff（基于 `diff` npm crate）+ 行号
- `fs.patch` args.diff → unified diff 高亮
- `git.diff` output → unified diff 高亮（仅当 output 非空且非 `(no changes)`）

---

## 4. 配置参考

| 入口 | 用途 |
|---|---|
| `--workspace <path>` (CLI) | 工作区根目录，**最高优先级** |
| `JARVIS_FS_ROOT` (env) | 同上，env 形式 |
| `[tools].fs_root` (config.toml) | 同上，config 形式 |
| `JARVIS_ENABLE_FS_EDIT/WRITE/PATCH/SHELL_EXEC` (env) | 启用对应修改类工具 |
| `JARVIS_DISABLE_GIT_READ` (env) | 当宿主没装 `git` 时关掉 `git.*` 工具 |
| `JARVIS_APPROVAL_MODE=auto/deny` (env) | 默认审批策略（WS 客户端可覆盖） |
| `[agent].system_prompt` (config.toml) | 完全覆盖 system prompt |
| `[agent].coding_prompt_auto = false` (config.toml) | 禁用 coding 提示自动切换 |
| `[agent].include_project_context = false` (config.toml) / `JARVIS_NO_PROJECT_CONTEXT=1` (env) / `--no-project-context` (CLI) | 关闭 AGENTS.md / CLAUDE.md 自动注入 |
| `[agent].project_context_max_bytes = N` (config.toml) / `JARVIS_PROJECT_CONTEXT_BYTES=N` (env) | 调整项目上下文注入上限（默认 32768） |

---

## 5. 安全模型

默认安全：

- 所有只读工具（包括 `git.*`、`workspace.context`、`project.checks`、
  `plan.update`）不进 approval。
- `fs.edit`、`fs.write`、`fs.patch`、`shell.exec` 全部 `requires_approval = true`。
- `fs.write` / `fs.edit` / `fs.patch` / `shell.exec` 默认全关。
- `fs.patch` 是**原子提交**：任意一个文件的任意一个 hunk apply 不上，
  整个 patch 回滚，磁盘上不留半成品。
- 路径沙箱：所有路径参数都通过 `resolve_under` —— 拒绝 `..` 和绝对路径。

推荐策略：

| 场景 | 策略 |
|---|---|
| 本地交互（你坐在屏幕前） | `JARVIS_APPROVAL_MODE=auto` 或 不设 + WS 手动审批 |
| 远程 / 共享开发机 | 不设 `JARVIS_APPROVAL_MODE`，让 WS 客户端逐次审批 |
| CI / 非交互 | `JARVIS_APPROVAL_MODE=deny`，所有修改类工具直接拒绝 |
| 完全只读 review | 不开 `fs.*` 写工具，不开 `shell.exec`，只用 `git.*` + `code.grep` |

---

## 6. 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 模型不调 `workspace.context` 就直接 grep | 检查 system prompt：是否被 `[agent].system_prompt` 覆盖了？coding 提示明文要求"先 inspect"。 |
| `fs.patch` 报 `apply patch on ... ` | hunk 没法 clean apply。先让 agent 跑 `git.diff` 看现状，再重新生成 patch。 |
| `fs.patch` 报 `binary patches are not supported` | 二进制文件不支持，建议改用 `fs.write`（如果是新文件）或避免操作二进制。 |
| Plan 卡片一直空 | 模型没主动调 `plan.update`。多发生在小模型上。可以在用户消息里明确要求"先写一个计划"。 |
| `project.checks` 返回空 | 工作区根没有任何已识别 manifest（`Cargo.toml` / `package.json` / `pyproject.toml` / `go.mod`）。这是正常的 —— 不是所有项目都有标准 manifest。 |
| diff 高亮没生效 | 检查工具名：只有 `git.diff` (output) 和 `fs.patch` (args.diff) 走 `UnifiedDiffViewer`。手写的 diff 文本走默认 `<pre>`。 |

---

## 7. 持久化 TODO 看板

`plan.update` 是 *本回合* 的工作清单，每次重发即覆盖；重置或重启就没了。
长跑场景（多日重构、跨会话调试）需要一个 *跨 turn / 跨重启* 的 backlog
—— 这就是持久化 TODO 看板。

**开启**：

默认就开着——开箱就用 JSON 文件持久化到
`~/.local/share/jarvis/conversations/`，跨重启活下来。

```bash
cargo run -p jarvis -- serve --workspace ~/code/myproj
```

如果你想换路径或换后端：

```bash
# 自定义 JSON 路径
JARVIS_DB_URL=json:///path/to/dir cargo run -p jarvis -- serve ...

# 启用 SQLite（需要 cargo feature）
JARVIS_DB_URL=sqlite:/path/to.db \
  cargo run -p jarvis --features sqlite -- serve ...
```

要彻底关掉 TODO 看板（保留会话持久化）：`JARVIS_DISABLE_TODOS=1`。

**Agent 工具**（`ToolCategory::Read`，无审批门）：

| 工具 | 作用 |
|---|---|
| `todo.list` | 列出当前 workspace 的全部 TODO，最多 500 条。 |
| `todo.add` | `{title, status?, notes?}` → 新增一条。 |
| `todo.update` | `{id, title?, status?, notes?}` → 局部更新。 |
| `todo.delete` | `{ids: [..]}` → 批量删除，每次最多 50 个 id（防误删）。 |

`status ∈ {pending, in_progress, completed, cancelled, blocked}`。

**REST**（同名约定，503 = 没配 store）：

```
GET    /v1/todos?workspace=<abs path>
POST   /v1/todos                      # body: {title, status?, notes?, workspace?}
PATCH  /v1/todos/:id                  # body: 任何子集 {title, status, notes}
DELETE /v1/todos/:id
```

**Web UI**：右栏面板菜单里点开 "TODOs"。可直接添加 / 切换状态 / 删除；
agent 通过 `todo.*` 工具的修改也会实时推到打开的面板，无需手动刷新。

**和 `plan.update` 的区别**：plan 是一回合内的 working steps（顶部
"Plan" 面板），todos 是跨会话的项目 backlog（"TODOs" 面板）。两者并存。

---

## 8. 进一步阅读

- [`docs/proposals/aicoding-agent.zh-CN.md`](./proposals/aicoding-agent.zh-CN.md) — 设计思路与未来路线
- [`docs/proposals/persistent-todos.md`](./proposals/persistent-todos.md) — 持久化 TODO 看板设计
- [`docs/user-guide.md`](./user-guide.md) — 完整运维手册
- [`docs/user-guide-git-ollama.md`](./user-guide-git-ollama.md) — `git.*` 与 Ollama provider 详细用法
- [`CLAUDE.md`](../CLAUDE.md) — 全部 env vars / 内部约定 / 工具语义
- [`crates/harness-tools/src/`](../crates/harness-tools/src/) — 所有内置工具源码，可作为新增工具的模板
