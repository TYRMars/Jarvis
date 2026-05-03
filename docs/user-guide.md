# Jarvis 用户使用手册

> 给运维 / 应用开发者读的"如何把 Jarvis 跑起来并接进去"指南。
> 项目内部架构看 `ARCHITECTURE.md`,贡献者规则看 `CLAUDE.md`,
> 数据库 schema 看 `DB.md`,前瞻设计看 `docs/proposals/`。

## 目录

- [是什么 / 不是什么](#是什么--不是什么)
- [Quick start](#quick-start)
- [安装与构建](#安装与构建)
- [挑选 LLM provider](#挑选-llm-provider)
- [完整配置参考](#完整配置参考)
- [运行模式](#运行模式)
- [Web UI](#web-ui)
- [HTTP / WebSocket API](#http--websocket-api)
- [内置工具](#内置工具)
- [记忆(Memory)](#记忆memory)
- [会话持久化(Persistence)](#会话持久化persistence)
- [审批 / 安全](#审批--安全)
- [常见场景](#常见场景)
- [故障排查](#故障排查)
- [安全注意事项](#安全注意事项)

---

## 是什么 / 不是什么

**是什么**:Jarvis 是一个 Rust 编写的 **agent 运行时** —— 一个 HTTP 服务,
把你选定的 LLM(OpenAI / Anthropic / Google / Codex 任意一个)和一组工具
(读写文件、跑命令、抓 HTTP、grep 代码、外部 MCP 服务器…)拼成一个会
"思考-调工具-看结果-继续"的循环。

具体形态:

- 一个二进制 `jarvis`,默认监听 `0.0.0.0:7001`。
- 暴露 OpenAI 兼容的 `/v1/chat/completions` (blocking + SSE) 和一个
  WebSocket 多轮接口 `/v1/chat/ws`。
- 自带最小 Web UI 在 `/ui/`。
- 可选地挂一个 SQLite/Postgres/MySQL 存对话记录。
- 可选地以 stdio 方式作为 MCP server 暴露自己的工具集。

**不是什么**:不是 ChatGPT 替身,不是托管服务,不是模型本身 —— 它只
负责把你选的模型和工具粘起来。模型还是要你提供 API key 或用 ChatGPT
订阅。

---

## Quick start

### 前置条件

- Rust 工具链(rustup,1.80+)
- 至少一个 LLM 凭据:
  - OpenAI API key,或
  - Anthropic API key,或
  - Google API key,或
  - 已经 `codex login` 过的 ChatGPT 订阅(走 Codex provider)

### 推荐:交互式 onboarding

```bash
git clone <repo>
cd jarvis
cargo build --release -p jarvis    # 一次性 build

./target/release/jarvis init       # 交互式 wizard
# 选 provider → 输入 API key(隐藏输入)→ 选模型 →
# fs_root → 启用 fs.edit / shell.exec → 持久化 → memory → approval

./target/release/jarvis            # 启动,自动读 ~/.config/jarvis/config.toml
```

`jarvis init` 把:
- 偏好写到 `~/.config/jarvis/config.toml`
- API key 写到 `~/.config/jarvis/auth/<provider>.json`(`0600` 权限)

之后 `jarvis` 不带任何参数即可启动。`jarvis status` 随时查看当前生效配置。

### 不想走 wizard:env vars 一行起

```bash
export OPENAI_API_KEY=sk-...
cargo run -p jarvis
```

env vars 始终可用,优先级**高于**配置文件,可临时覆盖。看到日志:

```
INFO jarvis: provider=openai model=gpt-4o-mini
INFO jarvis: tools registered registered=6 mcp_servers=0
INFO jarvis: jarvis listening addr=0.0.0.0:7001
```

打开浏览器访问 <http://localhost:7001/ui/>,在输入框打字就能聊。

或者用 curl 直接验证:

```bash
curl localhost:7001/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"你好"}]}'
```

### 子命令一览

| 命令 | 作用 |
|---|---|
| `jarvis` | 启动 HTTP 服务器(同 `jarvis serve`) |
| `jarvis serve` | 显式启动,接受 `--addr` / `--provider` / `--model` 标志 |
| `jarvis init` | 交互式设置 wizard;`--force` 覆盖现有 config |
| `jarvis status` | 打印当前 provider / auth / 工具 / 持久化 / memory / approval 等所有状态 |
| `jarvis mcp-serve` | stdio MCP server 模式,把内置工具暴露给其他 agent |
| `jarvis login` | OAuth / API key 登录。`--provider codex` 走 PKCE 浏览器流程,`--device-code` 走设备码(headless) |
| `jarvis logout [--provider X]` | 清除某个 provider 的本地凭据;省略 `--provider` 默认 codex |

---

## 安装与构建

Jarvis 不发布二进制 release,自己 build。

```bash
# Debug 构建(开发用,启动快)
cargo build -p jarvis

# Release 构建(部署用,优化过的二进制)
cargo build --release -p jarvis
# 二进制路径:target/release/jarvis

# 直接运行
cargo run -p jarvis
cargo run --release -p jarvis
```

配置可以走两条路:

1. **环境变量**(`JARVIS_*` / `OPENAI_API_KEY` 等)—— 容器化部署、
   systemd、docker-compose 都很顺。
2. **TOML 配置文件**(从 PR 1 起支持)—— 一次配好长期用,适合本机 /
   工作站场景。

两条路可以混用:命令行 `--flag` > 环境变量 > 配置文件 > 内置默认。
也就是说,环境变量始终能临时覆盖文件里的设置。

### 配置文件位置

`jarvis` 按这个顺序找文件:

1. `--config <path>` 命令行标志
2. `$JARVIS_CONFIG`
3. `$XDG_CONFIG_HOME/jarvis/config.toml`
4. `~/.config/jarvis/config.toml`(macOS / Linux)
5. `%APPDATA%\jarvis\config.toml`(Windows)

找不到任何文件时,按纯环境变量模式跑(向后兼容)。

### 配置文件示例

```toml
# ~/.config/jarvis/config.toml

[server]
addr = "127.0.0.1:7001"

[provider]
name  = "codex"                   # = JARVIS_PROVIDER
model = "gpt-5-codex-mini"        # = JARVIS_MODEL

[provider.codex]
home = "/Users/me/.codex"         # = CODEX_HOME
reasoning_summary = "auto"
include_encrypted_reasoning = true

[provider.openai]
base_url = "https://api.openai.com/v1"

[tools]
fs_root           = "/Users/me/projects/foo"   # = JARVIS_FS_ROOT
enable_fs_edit    = true                       # = JARVIS_ENABLE_FS_EDIT
enable_shell_exec = true
shell_timeout_ms  = 30000

[memory]
tokens = 8000           # = JARVIS_MEMORY_TOKENS
mode   = "summary"      # = JARVIS_MEMORY_MODE
# model = "..."         # = JARVIS_MEMORY_MODEL

[persistence]
url = "sqlite:///Users/me/.local/share/jarvis/jarvis.db"

[approval]
mode = "deny"            # = JARVIS_APPROVAL_MODE

[mcp_servers]
fs   = "uvx mcp-server-filesystem /tmp"
git  = "uvx mcp-server-git"
```

> 字段名都和上文环境变量表里的语义一一对应。**`[provider]`/`[server]`
> 等是表头**,字段错写(比如 `[memry]`)会被严格拒绝并报告错误位置。
>
> API key 等机密**不放配置文件**——保留 `OPENAI_API_KEY` /
> `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` 等环境变量传入。后续的
> `jarvis init` / `jarvis login` 会把它们存到 `~/.config/jarvis/auth/`
> 下的独立文件里(`0600` 权限)。

---

## 挑选 LLM provider

通过 `JARVIS_PROVIDER` 选,默认 `openai`。

| Provider | 端点 | 凭据 | 计费 | 何时用 |
|---|---|---|---|---|
| `openai` | `api.openai.com/v1/chat/completions` | `OPENAI_API_KEY` | 按 token | 默认选项,GA 模型最稳 |
| `openai-responses` | `api.openai.com/v1/responses` | `OPENAI_API_KEY` | 按 token | 用 reasoning 模型(o1/o3/gpt-5),或想要 prompt cache |
| `anthropic` | `api.anthropic.com/v1/messages` | `ANTHROPIC_API_KEY` | 按 token | 长上下文 / Claude 系列 |
| `google` | `generativelanguage.googleapis.com` | `GOOGLE_API_KEY` 或 `GEMINI_API_KEY` | 按 token | Gemini 系列(streaming 已支持) |
| `codex` | `chatgpt.com/backend-api/codex/responses` | ChatGPT OAuth(`~/.codex/auth.json`) | **ChatGPT 订阅 flat-rate** | 你已经付 ChatGPT Plus / Pro,想免去 API key 计费 |

### 切换示例

```bash
# OpenAI(默认)
JARVIS_PROVIDER=openai            JARVIS_MODEL=gpt-4o-mini

# OpenAI Responses(reasoning 模型)
JARVIS_PROVIDER=openai-responses  JARVIS_MODEL=o1-mini

# Anthropic
JARVIS_PROVIDER=anthropic         JARVIS_MODEL=claude-3-5-sonnet-latest

# Google Gemini
JARVIS_PROVIDER=google            JARVIS_MODEL=gemini-1.5-flash

# Codex(用 ChatGPT 订阅)
# 一次性:从 OpenAI 官方 Codex CLI 登录
codex login
JARVIS_PROVIDER=codex             JARVIS_MODEL=gpt-5-codex-mini
```

> **关于 Codex provider**:它访问的 `chatgpt.com/backend-api/codex/responses`
> 不是 OpenAI 公开 API,路径之前改过一次。OpenAI 容忍第三方客户端
> 走这条路(他们自己的 Codex CLI 就这么做),但**没有契约保证它的稳定性**。
> 启动时会有一行 `info!` 日志提醒"subject to ChatGPT Terms of Service"。

---

## 完整配置参考

下面所有变量都是可选的,除非标注 *required*。

### 服务器

| Var | 默认 | 说明 |
|---|---|---|
| `JARVIS_ADDR` | `0.0.0.0:7001` | 监听地址。`127.0.0.1:8080` 之类 |
| `RUST_LOG` | `info` | tracing-subscriber 的过滤器。`info,jarvis=debug` 是常用值 |

### Provider 通用

| Var | 默认 | 说明 |
|---|---|---|
| `JARVIS_PROVIDER` | `openai` | `openai` / `openai-responses` / `anthropic` / `google` / `codex` |
| `JARVIS_MODEL` | per-provider | 见上表 |

### OpenAI / OpenAI Responses

| Var | 默认 | 说明 |
|---|---|---|
| `OPENAI_API_KEY` | — | *required* |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | 指向 OpenAI 兼容 gateway |
| `OPENAI_REASONING_SUMMARY` | — | `auto` / `concise` / `detailed`。仅 `openai-responses` 适用 |
| `OPENAI_INCLUDE_ENCRYPTED_REASONING` | — | 任意值开启;让 reasoning 块参与 prompt cache |
| `OPENAI_SERVICE_TIER` | — | `auto` / `priority` / `flex` |

### Anthropic

| Var | 默认 | 说明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | *required when provider=anthropic* |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com/v1` | |
| `ANTHROPIC_VERSION` | `2023-06-01` | API 版本 header |

### Google

| Var | 默认 | 说明 |
|---|---|---|
| `GOOGLE_API_KEY` 或 `GEMINI_API_KEY` | — | *required when provider=google* |
| `GOOGLE_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta` | |

### Codex

| Var | 默认 | 说明 |
|---|---|---|
| `CODEX_HOME` | `~/.codex` | 装 `auth.json` 的目录 |
| `CODEX_ACCESS_TOKEN` | — | 开发后门:静态 token,无 refresh |
| `CODEX_ACCOUNT_ID` | — | 配 `CODEX_ACCESS_TOKEN` 用的 `ChatGPT-Account-ID` |
| `CODEX_BASE_URL` | `https://chatgpt.com/backend-api` | |
| `CODEX_RESPONSES_PATH` | `/codex/responses` | 端点路径覆盖 |
| `CODEX_ORIGINATOR` | `jarvis` | `originator` header |
| `CODEX_REASONING_SUMMARY` | — | 同 `OPENAI_REASONING_SUMMARY` |
| `CODEX_INCLUDE_ENCRYPTED_REASONING` | — | 同上 |
| `CODEX_SERVICE_TIER` | — | 同上 |
| `CODEX_REFRESH_TOKEN_URL_OVERRIDE` | `https://auth.openai.com/oauth/token` | 测试用 |

### 工具沙箱

| Var | 默认 | 说明 |
|---|---|---|
| `JARVIS_FS_ROOT` | `.` | `fs.*` 工具和 `shell.exec` cwd 的沙箱根目录 |
| `JARVIS_ENABLE_FS_WRITE` | (off) | 任意值开启 `fs.write` |
| `JARVIS_ENABLE_FS_EDIT` | (off) | 任意值开启 `fs.edit` |
| `JARVIS_ENABLE_SHELL_EXEC` | (off) | 任意值开启 `shell.exec` |
| `JARVIS_SHELL_TIMEOUT_MS` | `30000` | `shell.exec` 默认超时 |

### 外部 MCP 工具

| Var | 默认 | 说明 |
|---|---|---|
| `JARVIS_MCP_SERVERS` | — | 逗号分隔,格式 `prefix=command arg1 arg2`。例:`fs=uvx mcp-server-filesystem /tmp` |

### 记忆

| Var | 默认 | 说明 |
|---|---|---|
| `JARVIS_MEMORY_TOKENS` | — | 任意 usize 启用 memory,数值是预算(启发式 token) |
| `JARVIS_MEMORY_MODE` | `window` | `window`(滑动窗口)/ `summary`(LLM 摘要) |
| `JARVIS_MEMORY_MODEL` | 同 `JARVIS_MODEL` | summary 模式下的摘要器模型 |

### 持久化

| Var | 默认 | 说明 |
|---|---|---|
| `JARVIS_DB_URL` | — | `sqlite::memory:` / `sqlite://./db.sqlite` / `postgres://...` / `mysql://...` |

### 审批

| Var | 默认 | 说明 |
|---|---|---|
| `JARVIS_APPROVAL_MODE` | (off) | `auto`(全过)/ `deny`(全拒)。WS 客户端可以覆盖为交互式 |

---

## 运行模式

### HTTP 服务器模式(默认)

```bash
cargo run -p jarvis
```

监听 `JARVIS_ADDR`,挂三条传输:

- `POST /v1/chat/completions` —— 阻塞返回
- `POST /v1/chat/completions/stream` —— SSE
- `GET  /v1/chat/ws` —— WebSocket(多轮、交互式审批)

Plus 一组持久化对话路由(挂了 `JARVIS_DB_URL` 才工作)和一个静态 `/ui/`。

### MCP server 模式

```bash
cargo run -p jarvis -- --mcp-serve
```

不起 HTTP,改用 stdio 暴露 Jarvis 内置工具集为一个 MCP server。这样
其他支持 MCP 的 agent(包括另一个 Jarvis 实例)可以把 Jarvis 当工具
来调。这种模式下**不读 `OPENAI_API_KEY`**,也不需要任何 LLM 凭据。

---

## Web UI

源:`apps/jarvis-web/`(vanilla HTML/CSS/JS,~600 LOC)。
编译期通过 `include_dir!` 烧进二进制,不需要单独部署。

```bash
cargo run -p jarvis  # 然后浏览器开
open http://localhost:7001/ui/
```

三栏布局:

- **左栏**:对话列表(只在配了 `JARVIS_DB_URL` 时启用;否则灰显
  `(persistence disabled — chat is ephemeral)`)。`+ New` 新建,
  点 row 续聊,鼠标悬停出现 `×` 删除按钮。
- **中栏**:聊天主区。流式输出,工具调用以可折叠 block 显示
  (点击 head 展开看 args + output)。
- **右栏**:审批面板。当某次调用落到 `requires_approval()=true` 的
  工具时(`fs.write` / `fs.edit` / `shell.exec`),会弹出一张卡片:
  - **Approve** —— 立即放行
  - **Deny** —— 拒绝(可填可选 reason),工具不会跑,模型看到 `tool denied: <reason>` 然后自己想办法

WS 断开会 1 秒自动重连。

---

## HTTP / WebSocket API

> 所有路径以 `JARVIS_ADDR` 为前缀。下面默认 `localhost:7001`。

### Health

```bash
curl localhost:7001/health
# {"status":"ok"}
```

### 阻塞式聊天 — `POST /v1/chat/completions`

```bash
curl localhost:7001/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "messages": [
      {"role":"system","content":"你是 jarvis"},
      {"role":"user","content":"列出当前目录的文件,挑最大的那个总结一下"}
    ]
  }'
```

返回:

```json
{
  "message":{"role":"assistant","content":"..."},
  "iterations":3,
  "history":[/* 完整对话,含每个 tool 调用 */]
}
```

> 路径名是 OpenAI Chat Completions 兼容,但**返回 shape 是 Jarvis 自己的**
> ——多了 `iterations` 和 `history`,因为这里是已经跑完了 agent loop。
> 不能直接当作 OpenAI 替身。

### SSE 流 — `POST /v1/chat/completions/stream`

```bash
curl -N localhost:7001/v1/chat/completions/stream \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"数到 3"}]}'
```

每个 event 是一个 JSON 编码的 `AgentEvent`:

| `type` | 含义 |
|---|---|
| `delta` | 助手文字增量(`content` 字段) |
| `assistant_message` | 一条完整 assistant 消息(可能含 tool_calls) |
| `approval_request` | 需要审批 —— 但 SSE 是单向,客户端没法回复;通常只用 WS |
| `approval_decision` | 审批结果 |
| `tool_start` | 工具开始执行(`id`/`name`/`arguments`) |
| `tool_end` | 工具结束(`content` 是它返回给模型的文本) |
| `done` | 终止;携带最终 `conversation` |
| `error` | 终止;`message` 是错误原因 |

### WebSocket — `GET /v1/chat/ws`

最完整的接口。客户端 → 服务端帧:

| `type` | payload | 行为 |
|---|---|---|
| `user` | `{content}` | 追加一条 user message,跑一轮 agent loop |
| `reset` | — | 清空内存对话(也退出持久化模式) |
| `resume` | `{id}` | 加载已存对话,进持久化模式(需要 `JARVIS_DB_URL`) |
| `new` | `{id?}` | 新建持久化对话(`id` 可省,服务端发 UUID) |
| `approve` | `{tool_call_id}` | 放行某个 `approval_request` |
| `deny` | `{tool_call_id, reason?}` | 拒绝 |

服务端 → 客户端帧:同 SSE 的 `AgentEvent`,加上三个控制帧 `started`
(回应 `new`)、`resumed`(回应 `resume`)、`reset`(回应 `reset`)。

**状态守门**:turn 进行中(还在等 LLM/工具)时,服务器拒绝新的
`user`/`reset`/`resume`/`new`,会发一条 `{type:"error","message":"turn in progress"}`。
但 `approve`/`deny` 在 turn 中是合法的。

简单 wscat 演示:

```bash
wscat -c ws://localhost:7001/v1/chat/ws

> {"type":"user","content":"读 README 然后写到 SUMMARY.md"}
< {"type":"delta","content":"我"}
< {"type":"delta","content":"会先读..."}
...
< {"type":"approval_request","id":"call_2","name":"fs.edit",...}
> {"type":"approve","tool_call_id":"call_2"}
< {"type":"approval_decision","id":"call_2","decision":{"decision":"approve"}}
< {"type":"tool_start","id":"call_2","name":"fs.edit",...}
< {"type":"tool_end","id":"call_2","content":"edited ..."}
< {"type":"delta","content":"完成"}
< {"type":"done","outcome":{"kind":"stopped","iterations":3},"conversation":{...}}
```

### 持久化对话 CRUD

需要 `JARVIS_DB_URL`。没设的话以下路由都返 `503 Service Unavailable`。

```bash
# 创建(可选 system / 自定义 id)
curl -X POST localhost:7001/v1/conversations \
  -H 'content-type: application/json' \
  -d '{"system":"你是 jarvis"}'
# → {"id":"7b6f..."}

# 列表(默认 limit=20)
curl 'localhost:7001/v1/conversations?limit=10'

# 取完整对话
curl localhost:7001/v1/conversations/7b6f...

# 删除
curl -X DELETE localhost:7001/v1/conversations/7b6f...

# 追加一轮 user message,跑 agent,持久化结果
curl -X POST localhost:7001/v1/conversations/7b6f.../messages \
  -H 'content-type: application/json' \
  -d '{"content":"现在请总结一下"}'

# SSE 版同样路径加 /stream
curl -N -X POST localhost:7001/v1/conversations/7b6f.../messages/stream \
  -H 'content-type: application/json' \
  -d '{"content":"再深入一点"}'
```

> 以 `__` 开头的 id 是内部命名空间(memory 用来存摘要),REST 列表
> 会过滤掉,GET / DELETE 它们都返 404。普通用户不需要管这件事。

---

## 内置工具

启动日志会打印当前注册的工具数:`tools registered registered=N`。

### 默认开启(read-only)

| 名称 | 说明 |
|---|---|
| `echo` | 把 `text` 参数原样返回。冒烟测试用 |
| `time.now` | 当前时间 `{unix, iso}` |
| `http.fetch` | GET/POST,默认 256 KiB body 上限 |
| `fs.read` | 读 `JARVIS_FS_ROOT` 下相对路径的文件 |
| `fs.list` | 列目录,返回 `{name,kind}` 数组 |
| `code.grep` | 在 `JARVIS_FS_ROOT` 下做正则搜索;尊重 `.gitignore` / 默认跳隐藏 / 二进制文件 |

### 可选(写 / 跑命令,默认关闭)

| 名称 | 启用方式 | 说明 |
|---|---|---|
| `fs.write` | `JARVIS_ENABLE_FS_WRITE=1` | 整文件覆盖写入。**触发 approval**(若配了 approver) |
| `fs.edit` | `JARVIS_ENABLE_FS_EDIT=1` | `old_string` → `new_string` 精确替换;`replace_all` 可选。**触发 approval** |
| `shell.exec` | `JARVIS_ENABLE_SHELL_EXEC=1` | 跑命令,默认 30s 超时,stdout/stderr 各 64 KiB 截断。**触发 approval** |

> **未来**会加上 OS 级沙箱(`sandbox-exec` / `bubblewrap` / 容器),
> 见 `docs/proposals/sandboxing.md`。当下 `shell.exec` 仅靠路径沙箱
> 和 approval gate,不要在不可信环境暴露。

### 通过 MCP 加工具

任何兼容 MCP 协议的服务器都能挂上来。Jarvis 把它们的工具加前缀注册
进来:

```bash
JARVIS_MCP_SERVERS='\
fs=uvx mcp-server-filesystem /tmp,\
git=uvx mcp-server-git'
```

那就会出现 `fs.read_file` / `fs.list_dir` / `git.log` 这样名字的工具
(具体看那个 MCP server 暴露什么)。

> Jarvis 自己也能反过来当 MCP server 给别人用 —— 见上文 `--mcp-serve`。

### 用插件一键装一组工具 + skill

`JARVIS_MCP_SERVERS` 是手动挂单个 MCP server 的方式;**插件**则是把"
一组 MCP server + 一组 skill"打成一个目录,一条命令装上、一条命令卸,
免去逐个写环境变量。Jarvis 自带一个最小内置 marketplace。

```bash
# 1. 启动服务器(插件命令通过 HTTP 跟它讲)
jarvis serve --workspace .

# 另开一个终端:
# 2. 浏览自带的 marketplace
jarvis plugin marketplace
# - code-review-pack          —— 内置 code-review skill
# - gitnexus                  —— GitNexus 知识图谱 MCP + 工作流 skill

# 3. 装上 GitNexus(把代码库当成图来查:调用链 / 影响面 / 跨文件搜索)
jarvis plugin install examples/plugins/gitnexus
# ✓ installed `gitnexus` (1 skills, 1 mcp)

# 4. 已装的列表 / 详情 / 卸载
jarvis plugin list
jarvis plugin info gitnexus
jarvis plugin remove gitnexus
```

插件本质是一个含 `plugin.json` 的目录,manifest 里同时列 `skills` 和
`mcp_servers`(参考 [`examples/plugins/`](../examples/plugins/) 里的两个示例)。
装完后 MCP 工具自动以前缀注册(GitNexus 的工具会变成
`gitnexus.context` / `gitnexus.impact` / `gitnexus.query` 等),
skill 进 catalog 参与自动激活。

> 限制:插件目前只在 `jarvis serve` 模式下生效,`jarvis-cli`
> 终端 agent 还没接 PluginManager。

---

## 记忆(Memory)

LLM 没有记忆,完整对话历史每次都重新发。对话长了之后(几十轮、长文
件读取过)会:

- 撞模型上下文窗口
- 速度变慢
- 钱越花越多

`JARVIS_MEMORY_TOKENS` 启用记忆,会在每次发请求前把对话压缩到这个
token 预算内。

### Window 模式(默认,免费)

```bash
JARVIS_MEMORY_TOKENS=8000 JARVIS_MEMORY_MODE=window
```

行为:

- 始终保留所有 system message
- 永远保留最新一个 turn(不管它有多大)
- 倒序加保留更早的 turn,直到预算用完
- 工具调用回合(assistant tool_calls + 它们的 tool 结果)永远绑成一组,不会被截开
- 丢掉东西会插一条 `[earlier turns omitted to fit context]` system 消息

简单、零成本、信息丢失硬。

### Summary 模式(贵,信息保留好)

```bash
JARVIS_MEMORY_TOKENS=8000 JARVIS_MEMORY_MODE=summary
```

被淘汰的 turn 不直接丢,而是发一次 LLM 调用让它压成一段摘要,塞为
synthetic system message。带三级缓存:in-memory → 持久化 store(配
了 `JARVIS_DB_URL` 时)→ LLM 调用。BLAKE3 内容哈希做 key,所以重启
后能从 store 拿回来。

代价:每个真正的 eviction 多一次 LLM call。命中率高的话(同一对话
反复进 budget),实际只调一次。

---

## 会话持久化(Persistence)

```bash
JARVIS_DB_URL=json:///Users/me/.local/share/jarvis/conversations
```

支持的 scheme:

- `json://<dir>` —— **默认**,每条 conversation 一个 JSON 文件,`<dir>` 是
  目录路径。无外部依赖,文件可以 `cat` 直接看内容,适合单用户 / 开发场景。
  `jarvis init` 选"持久化"时默认就用这个,目录在
  `~/.local/share/jarvis/conversations/`。
- `sqlite::memory:` —— 进程内,重启就没,适合测试
- `sqlite://./path.db` —— 文件,适合并发读写或大量 conversation
- `postgres://user:pw@host/db` —— 需要 `harness-store` 编 `postgres` feature
- `mysql://user:pw@host/db` —— 需要 `mysql` feature

> JSON store 的 list() 是 O(N) 文件读 —— 几百条 conversation 没问题,
> 上千条以后建议换 sqlite。

启用后:

- WS `resume` / `new` 帧能用,WS turn 结束时自动 save
- `/v1/conversations` REST 路由生效
- Web UI 左栏显示对话列表
- Summary memory 自动跨进程持久化(无需额外配置)

每条对话存为一行 `conversations(id, messages JSON, created_at, updated_at)`。

---

## 审批 / 安全

```bash
# 全自动通过(实际等于不开审批,但流式仍发 ApprovalRequest 事件可审计)
JARVIS_APPROVAL_MODE=auto

# 全部拒绝(panic button)
JARVIS_APPROVAL_MODE=deny
```

### 真正的交互式审批

走 WebSocket。Jarvis 给每个 socket 配一个独立 `ChannelApprover`,
**会覆盖**全局 `JARVIS_APPROVAL_MODE`。流程:

1. agent 跑到一个 `requires_approval()=true` 的工具调用
2. 服务端 yield `{type:"approval_request","id":"call_X","name":"fs.write",...}`
3. agent 暂停,等客户端回复
4. 客户端回 `{type:"approve","tool_call_id":"call_X"}` 或
   `{type:"deny","tool_call_id":"call_X","reason":"...optional..."}`
5. 服务端 yield `{type:"approval_decision",...}`
6. 工具继续(批准)/ 跳过(拒绝时模型看到 `tool denied: ...`)

Web UI 已经把这一套接好了——右栏的 approve/deny 按钮就是。

---

## 常见场景

### 场景 1:本机当 coding 助手

```bash
export OPENAI_API_KEY=sk-...
export JARVIS_FS_ROOT=$(pwd)
export JARVIS_ENABLE_FS_EDIT=1
export JARVIS_ENABLE_SHELL_EXEC=1
export JARVIS_DB_URL=sqlite://./jarvis.db
export JARVIS_MEMORY_TOKENS=12000
cargo run --release -p jarvis

# 浏览器开 /ui/,就在当前项目目录里干活
```

### 场景 2:用 ChatGPT 订阅免去 API 计费

```bash
# 一次性,直接走 jarvis 自带的 PKCE OAuth 流程(无需安装 OpenAI Codex CLI)
jarvis login --provider codex
# 浏览器打开 https://auth.openai.com/oauth/authorize?...
# 登录后回调到 http://localhost:1455/auth/callback,自动写
# ~/.config/jarvis/auth/codex.json

# 跑起来
JARVIS_PROVIDER=codex jarvis

# headless 环境(SSH / 容器 / 没浏览器)用 device-code
jarvis login --provider codex --device-code
# 显示一个短码 + 验证 URL,在任意有浏览器的设备上完成
```

> 已经有 `~/.codex/auth.json`(从 OpenAI 官方 Codex CLI)的话,jarvis
> 会**先**找自己 `~/.config/jarvis/auth/codex.json`,没有就 fall back
> 到 `~/.codex/auth.json`。两个文件 schema 完全一致,你可以互相搬。

### 场景 3:暴露给团队(共享后端)

```bash
# 内网部署
export JARVIS_ADDR=0.0.0.0:7001
export OPENAI_API_KEY=sk-...
export JARVIS_DB_URL=postgres://jarvis:pw@db.internal/jarvis
export JARVIS_MEMORY_TOKENS=8000
export JARVIS_MEMORY_MODE=summary
export JARVIS_APPROVAL_MODE=deny    # 全拒,等 WS 客户端逐次确认
# fs.write / shell.exec 不要开,共享环境太危险

cargo run --release -p jarvis
# 反向代理(nginx/caddy)在前面加 auth + TLS
```

> Jarvis 自身没有内置 auth。多用户场景一定要在前面套反向代理或
> 网关。

### 场景 4:从 Python 接进来

```python
import requests
# 阻塞式
r = requests.post(
    "http://localhost:7001/v1/chat/completions",
    json={"messages":[{"role":"user","content":"hi"}]},
)
print(r.json()["message"]["content"])
```

```python
# WS 流式 + 审批
import asyncio, json, websockets

async def main():
    async with websockets.connect("ws://localhost:7001/v1/chat/ws") as ws:
        await ws.send(json.dumps({"type":"user","content":"读 README 改成英文"}))
        async for raw in ws:
            ev = json.loads(raw)
            print(ev["type"], ev.get("content",""))
            if ev["type"] == "approval_request":
                yes = input(f"approve {ev['name']}? ").strip().lower() == "y"
                await ws.send(json.dumps({
                    "type": "approve" if yes else "deny",
                    "tool_call_id": ev["id"],
                }))
            if ev["type"] in ("done","error"):
                break

asyncio.run(main())
```

> 还没出官方 SDK,见 `docs/proposals/client-sdks.md`。

---

## 故障排查

### `OPENAI_API_KEY must be set`

provider=openai 必须设 API key。要么设 `OPENAI_API_KEY`,要么换
provider(`JARVIS_PROVIDER=anthropic` 等),要么用 `--mcp-serve` 跑
不需要 LLM 的 MCP server 模式。

### 持久化路由返 503

```
{"error":"persistence not configured; set JARVIS_DB_URL"}
```

直接原因 —— 没设 `JARVIS_DB_URL`。普通对话(`/v1/chat/...`)在没 DB
时仍可用,只是不会保存。

### WS 上 `turn in progress`

```
{"type":"error","message":"turn already in progress"}
```

上一轮还在跑(可能卡在 approval),收到了新的 `user`/`reset` 帧。
等 `done` 事件后再发,或者发 `reset` 清状态(注意 reset 会同时退出
持久化模式)。

### Codex 的 401 `auth refresh failed`

通常意味着 `~/.codex/auth.json` 过期 + refresh token 也失效。
最简单:

```bash
codex login    # 重新登录
```

或者把 `CODEX_HOME` 指向另一份有效的 auth.json。

### 工具调用全是 `tool denied`

看启动日志有没有 `approval_mode=deny`。如果有,改成 `auto` 或者去掉
`JARVIS_APPROVAL_MODE` 即可。WS 客户端要交互式审批就照前面 §[审批]。

### Web UI 连不上 WebSocket

- 浏览器 console 有 mixed-content 警告 → 你的页面是 HTTPS 但服务器
  是 HTTP。要么前端走 HTTP,要么前端反向代理 TLS 终结。
- 跨域 → Jarvis 默认不发 CORS 头(UI 同源情况下不需要)。如果你把
  UI 单独部署需要前面套反向代理统一域,或者加 CORS 中间件(目前需
  要改代码)。

### Codex provider 报 "endpoint not found"

OpenAI 又改路径了。看日志的 `endpoint=...`,然后:

```bash
# 试试新路径,例如:
CODEX_RESPONSES_PATH=/v2/codex/responses \
JARVIS_PROVIDER=codex cargo run -p jarvis
```

---

## 安全注意事项

1. **Token 不脱敏**。当前 `tracing` 不过滤 API key / OAuth token,
   `RUST_LOG=trace` 时可能写到日志。生产部署用 `RUST_LOG=info`
   起步,日志写到只有运维能看到的位置。
2. **`shell.exec` 没有 OS 级沙箱**。当前只有路径沙箱(cwd 限制在
   `JARVIS_FS_ROOT`)和 approval gate。生产 / 多租户 / 暴露给陌生人
   一定要等 OS 沙箱(见 `docs/proposals/sandboxing.md`)。
3. **`fs.edit` / `fs.write` 是写操作**,默认关闭。开了就要配
   `JARVIS_APPROVAL_MODE=deny` 加 WS 交互式审批,或者跑在隔离
   workspace 里。
4. **Codex 端点是非公开 API**。OpenAI 容忍但不承诺稳定。生产关键
   路径不建议依赖 Codex provider —— 用 `openai` / `openai-responses`
   走有 SLA 的公开 API。
5. **没有内置 auth**。Jarvis 默认对所有访问者开放。生产部署在前面
   套反向代理 / API gateway / mTLS。
6. **`JARVIS_FS_ROOT=/`** 等于无沙箱,别这么干。

---

## 接下来

- 项目内部如何分层 → `ARCHITECTURE.md`
- 数据库表结构 → `DB.md`
- 想写代码贡献 → `CLAUDE.md`(给开发者和 Claude 看的工作守则)
- 设计中的功能 → `docs/proposals/`
- 找 bug / 提 issue → 仓库 issue tracker
