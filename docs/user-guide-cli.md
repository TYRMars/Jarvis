# Jarvis CLI 用户指南

> 在终端里跑 Jarvis —— 不开浏览器，不起 HTTP 服务，直接进对话。
> 适合：快速一次性问答、shell pipeline、SSH 远程机、CI 脚本。
>
> 完整 coding-agent 工作流见 [`user-guide-coding-agent.md`](./user-guide-coding-agent.md)；
> Web UI 用法见 [`user-guide-web.md`](./user-guide-web.md)。

---

## 速览

`jarvis-cli` 是 `jarvis` 的姊妹二进制（同一 workspace），把
`harness-core::Agent` **进程内**跑起来。没有 HTTP、没有 WS、没有
session store —— 一次进程对应一个对话。

两种模式：

| 模式 | 触发 | 用途 |
|---|---|---|
| 交互式 REPL（默认） | 直接 `jarvis-cli` | 多轮对话，tty 审批 (`y/n/a/d`)，Ctrl-C 取消当前 turn |
| 管道模式 | `--no-interactive` | 一问一答，无人审批（自动 deny），适合 shell 脚本 |

---

## 1. 安装与构建

```bash
cargo build --release -p jarvis-cli
# 二进制位于 target/release/jarvis-cli
```

或开发期直接：

```bash
cargo run -q -p jarvis-cli -- [options]
```

---

## 2. 快速上手

最小可用：

```bash
export OPENAI_API_KEY=sk-...
cd ~/code/myrepo
cargo run -q -p jarvis-cli
```

启动横幅：

```
jarvis-cli · openai · (default) · /Users/you/code/myrepo
type a prompt and Enter; /reset clears, /policy lists, /quit exits, Ctrl-C aborts the current turn.
>
```

输入第一条 prompt：

```
> 看一下这个仓库当前有哪些改动
● 我先看一下工作区状态。
⚙ workspace.context {}
  → {"root":"/Users/you/code/myrepo","vcs":"git","branch":"main",...
⚙ git.status {}
  → ## main...origin/main
●  当前分支 main，clean，最近 5 个 commit 都是关于 ...
>
```

每个事件类型有不同前缀：

| 前缀 | 含义 |
|---|---|
| `●` (绿) | assistant 回复（流式） |
| `⚙` (青) | tool 开始调用 |
| `→` (灰) | tool 结束 + 单行预览 |
| `│` (灰/红) | shell.exec 实时 stdout/stderr |
| `⚠` (黄) | 等待审批的 tool |
| `☰` (青) | plan.update 计划清单 |
| `⤬` (黄) | turn 被 Ctrl-C 中断 |
| `✗` (红) | 错误 |

---

## 3. 审批：`y` / `n` / `a` / `d`

修改类工具（`fs.edit` / `fs.patch` / `fs.write` / `shell.exec`）默认
都进审批。当 agent 想调用时：

```
⚠ approve fs.edit? {"path":"src/foo.rs","old_string":"...","new_string":"..."}
  [y]es / [n]o / [a]lways / [d]eny-always >
```

| 输入 | 行为 |
|---|---|
| `y` / `yes` / 直接回车 | 这次允许，不影响后续同名工具 |
| `n` / `no` / 其它任何输入 | 这次拒绝 |
| `a` / `always` | 允许，**且** 把 `fs.edit` 加入会话白名单（之后所有 `fs.edit` 自动通过） |
| `d` / `deny-always` | 拒绝，**且** 把 `fs.edit` 加入会话黑名单（之后所有 `fs.edit` 自动拒绝，模型会看到 deny 提示并适应） |

会话策略只在当前进程有效。`/reset` 不清；`/quit` 才清。

被拒绝的工具 → agent 看到 `tool denied: <reason>` → 通常会换一个
工具或道歉，**不会**导致整个 turn 崩溃。

---

## 4. 内置 slash 命令

| 命令 | 作用 |
|---|---|
| `/quit` / `/exit` | 干净退出 |
| `/reset` | 清空当前对话（会话审批策略保留） |
| `/policy` | 提示如何用 `a`/`d` 设策略（v0 不显示已设条目） |

未来可能加：`/save <id>` / `/load <id>`（需要持久化），`/model <name>`
切模型。

---

## 5. CLI 参数

```
jarvis-cli [OPTIONS]

  --workspace <PATH>          沙箱根目录（默认 cwd），别名 --fs-root
  --provider <NAME>           openai (默认) / anthropic / google / ollama
  --model <NAME>              覆盖该 provider 的默认模型
  --allow-shell               启用 shell.exec（默认关）
  --allow-fs-write            启用 fs.write（默认关；fs.edit/fs.patch 默认开）
  --no-git-read               关闭 git.* 只读工具集
  --no-interactive            管道模式（见下）
  --prompt <TEXT>             管道模式的 prompt（不给则读 stdin 到 EOF）
  --max-iterations <N>        每个 turn 的循环上限（默认 30）
  --no-project-context        不自动加载 AGENTS.md / CLAUDE.md / AGENT.md 到 system prompt
                              （默认开；同 JARVIS_NO_PROJECT_CONTEXT=1）
```

环境变量（与 `jarvis serve` 同名同义）：

- `OPENAI_API_KEY` / `OPENAI_BASE_URL`
- `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_VERSION`
- `GOOGLE_API_KEY` 或 `GEMINI_API_KEY` / `GOOGLE_BASE_URL`
- `OLLAMA_BASE_URL` / `OLLAMA_API_KEY`
- `JARVIS_MODEL`
- `JARVIS_NO_PROJECT_CONTEXT` —— 同 `--no-project-context`，关闭项目说明自动注入
- `JARVIS_PROJECT_CONTEXT_BYTES` —— 调整 AGENTS.md / CLAUDE.md 注入上限（默认 32 KiB）
- `NO_COLOR` —— 强制纯文本输出（pipe 时自动检测）
- `RUST_LOG` —— tracing 级别，默认 `warn`；设 `info` 可看到 `loaded project instructions ... bytes=N`

CLI 不读 `[tools] / [agent]` config 文件 —— 与 `jarvis serve` 不同，
这里 `--workspace` / `--allow-*` 直接覆盖一切，env 是 fallback。
要复杂配置请用 `jarvis serve`。

---

## 6. 管道模式实战

`--no-interactive` 把 CLI 变成 unix-style 工具：读 stdin / `--prompt`，
跑一个 turn，把最终 assistant 文本写到 stdout，结束。**审批策略硬编码
为 `AlwaysDeny`** —— 没有人在场就不能改东西，安全默认。

简单问答：

```bash
echo "总结这个 README" | jarvis-cli --no-interactive > summary.txt
```

带 prompt：

```bash
jarvis-cli --no-interactive --prompt "解释 src/main.rs 第 50-80 行做了什么"
```

CI 用法（注意 stderr 单独流，便于 grep 不带颜色）：

```bash
jarvis-cli --no-interactive --provider ollama --model qwen2.5 \
  --workspace /workspace \
  --prompt "review the diff against main and flag risks" \
  > review.md 2> jarvis.log
```

由于 `AlwaysDeny`，`fs.write` / `fs.edit` / `fs.patch` / `shell.exec`
全都跑不动 —— 只能拿到模型基于 `git.diff` / `code.grep` / `fs.read` /
`workspace.context` 等只读工具的回答。要写文件得用 `jarvis serve`
+ WS approval。

---

## 7. 与 `jarvis serve` 的对比

| 维度 | `jarvis-cli` | `jarvis serve` |
|---|---|---|
| 传输 | stdin/stdout | HTTP / WS / SSE |
| 多用户 | 单进程单会话 | 多并发会话 |
| 持久化 | 无（v0） | `JARVIS_DB_URL`（sqlite/pg/mysql/json） |
| 审批 UI | tty `y/n/a/d` | Web 卡片 / 程序化 ChannelApprover |
| Web UI | 无 | `/ui/`，含 plan 渲染、diff 高亮 |
| MCP server | 无 | `jarvis mcp-serve` |
| 多 provider 同时启用 | 否（一个进程一个 provider） | 是（`--enable`） |
| 适用场景 | 一次性、SSH、脚本 | 团队共享、长会话、Web |

两者共享 `harness-core` / `harness-tools` / `harness-llm` —— 工具
行为、wire 格式、审批语义完全一致。CLI 是同一只动物的另一种皮。

---

## 8. 故障排查

| 现象 | 处理 |
|---|---|
| `OPENAI_API_KEY is required for provider=openai` | 设环境变量；或 `--provider ollama` 走本地 |
| 启动卡在 `>` 不响应 | 检查终端是否 attach 到 tty；管道场景请加 `--no-interactive` |
| 颜色全乱 / 颜色没了 | 设 `NO_COLOR=1` 强制纯文本；管道时自动检测，应该已经是纯文本 |
| `(auto-denied by session policy)` 没法回头 | 退出重启进程；策略表只在当前进程内 |
| `--no-interactive` 一直不返回 | 检查是否在等 stdin EOF（用 `--prompt` 或 `< file` / `echo ... \|`） |
| 模型不调工具 | 该模型可能不支持 function calling（`gemma2`、老 `llama3` 等）；换 `gpt-4o-mini` / `qwen2.5` / `claude-3-5-sonnet-latest` 等 |

---

## 9. 进一步阅读

- [`docs/proposals/cli.md`](./proposals/cli.md) —— 设计文档与未来步骤（持久化、TUI 等）
- [`docs/user-guide-coding-agent.md`](./user-guide-coding-agent.md) —— 端到端 coding 工作流（plan / patch / check / report）
- [`apps/jarvis-cli/src/runner.rs`](../apps/jarvis-cli/src/runner.rs) —— REPL 主循环；`tokio::select!` 三通道模式可作为新前端的参考
- [`CLAUDE.md`](../CLAUDE.md) —— 全部环境变量 + 工具语义
