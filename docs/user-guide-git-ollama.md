# Jarvis 新增能力：本地 Ollama Provider 与只读 git 工具集

> 面向运维 / 应用开发者的"如何启用并使用这两类新能力"指南。
> 完整运维手册见 `docs/user-guide.md`，架构原理见 `ARCHITECTURE.md`，
> 全部环境变量见 `CLAUDE.md`。

---

## 速览

| 能力 | 类型 | 默认状态 | 关键入口 |
|---|---|---|---|
| Ollama provider | LLM 接入 | 关 | `JARVIS_PROVIDER=ollama` |
| `git.status` / `git.diff` / `git.log` / `git.show` | 内置工具 | **开** | `BuiltinsConfig::enable_git_read` |

两者互相独立，可以单独启用或同时启用。

---

## 1. 本地 Ollama Provider

### 是什么

[Ollama](https://ollama.com) 是一个本地 LLM 运行时，把 Llama 3 / Qwen /
Mistral / Gemma 等开源模型打包成一个本地 HTTP 服务，开箱即用。它在
`/v1/chat/completions` 暴露了一份 **OpenAI 兼容**接口，所以 Jarvis
直接复用 `OpenAiProvider`，无需新增 wire 层 —— 与现有 Kimi /
Moonshot 接入是同一套套路。

适用场景：

- 离线 / 内网环境，不能调外部 API。
- 隐私敏感数据（病历、合同、源代码），不想出公网。
- 模型评测：同一份对话喂给多个开源模型对比。
- 成本控制：高频跑批用本地模型，关键 turn 走云端模型（详见
  `JARVIS_PROVIDER` 切换 + 模型名前缀路由章节）。

### 准备工作

```bash
# 安装 ollama（macOS / Linux）
curl -fsSL https://ollama.com/install.sh | sh
# 拉一个模型
ollama pull llama3.2
# 启动后台服务（默认 11434 端口）
ollama serve   # 或者直接 `ollama run llama3.2` 也会顺带把服务起来
```

确认服务在跑：

```bash
curl -s http://localhost:11434/v1/models | head
```

### 启用

```bash
export JARVIS_PROVIDER=ollama
export JARVIS_MODEL=llama3.2          # 默认 llama3.2，可改成 qwen2.5、mistral、gemma3 等
# 可选：指向远程 Ollama 或 OpenWebUI 反代
# export OLLAMA_BASE_URL=http://gpu-box.local:11434/v1
# export OLLAMA_API_KEY=sk-...        # 本地 ollama 不需要；只有走 OpenWebUI 等带鉴权的反代时才填

cargo run -p jarvis
```

启动日志会打出 `provider=ollama model=llama3.2 ... endpoint=http://localhost:11434/v1/chat/completions`。

### 验证

冒烟测试：

```bash
curl -s http://localhost:7001/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"用一句话介绍你自己"}]}' \
  | jq .
```

或用 SSE 流式接口：

```bash
curl -N http://localhost:7001/v1/chat/completions/stream \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"hello"}]}'
```

### 常见疑问

**Q：Ollama 支持工具调用吗？**
支持，但只有部分模型在 OpenAI 兼容层上正确实现了 `tool_calls`
字段。`llama3.1` / `llama3.2` / `qwen2.5` / `mistral-nemo` 是已知
工作良好的；老的 `llama3` / `gemma2` 可能只返回纯文本。如果你
看到 `JARVIS_ENABLE_FS_WRITE=1` 等开关都打开了但模型从来不调
工具，先换一个明确支持 function calling 的模型。

**Q：模型名前缀路由会自动把请求送到 ollama 吗？**
不会。`serve.rs` 的 `ProviderRegistry` 默认前缀规则只覆盖了
`claude-`、`gemini-`、`gpt-5.`、`kimi-` 几族。如果你想让
`POST /v1/chat/completions` 里的 `model: "llama3.2"` 自动
落到 ollama provider，把 ollama 设为 primary 即可。多 provider
同时启用且想按模型名分流时，参考 `apps/jarvis/src/serve.rs`
里 `with_prefix_rule` 的写法自行扩展。

**Q：本地模型对超长上下文支持差，怎么办？**
`JARVIS_MEMORY_TOKENS=4096 JARVIS_MEMORY_MODE=summary` 开启
摘要式记忆压缩。摘要模型可以单独指定为同一个本地模型，也可以
切到云端的便宜模型 —— 只摘要不推理，便宜。

### 在 `jarvis status` 中的呈现

启用后，`jarvis status` 会把 ollama 列入 Auth 段，并对没设
`OLLAMA_API_KEY` 的本地场景输出 `○ no key (local server doesn't need
one)` 而不是 ✗，避免误导。

---

## 2. 只读 `git.*` 工具集

### 是什么

四个新内置工具，让模型直接读取仓库的 git 状态，不再需要走
`shell.exec` + `git status`：

| 工具名 | 作用 | 必填参数 | 关键可选参数 |
|---|---|---|---|
| `git.status` | 工作区状态 | — | — |
| `git.diff` | 工作区 / 暂存 / 跨修订版差异 | — | `staged`, `from`, `to`, `path`, `stat_only` |
| `git.log` | 最近提交列表 | — | `limit`(默认 20，硬上限 200), `revision`, `path`, `format=short\|full` |
| `git.show` | 单个 commit 元数据 + patch | `revision` | `metadata_only`, `path` |

实现位置：[`crates/harness-tools/src/git.rs`](../crates/harness-tools/src/git.rs)。
均通过 `git -C <fs_root>` 调宿主机的 `git` 二进制。

### 默认开启

读权限，无副作用，**默认注册**。与 `code.grep` / `fs.read` /
`fs.list` / `http.fetch` 同级，不走 approval。

### 关掉

如果宿主机没装 `git`，或你想缩减工具集（让模型上下文更干净），
任意一种方式即可：

```bash
# 环境变量
export JARVIS_DISABLE_GIT_READ=1

# 或 config.json
# [tools]
# enable_git_read = false
```

### 安全边界

这是把"shell 出去执行 git"换成"shell 出去执行 git，但参数受控"，
所以攻击面要单独说清楚：

- **作用域绑死 `JARVIS_FS_ROOT`**：每次调用都强制 `git -C <root>`，
  模型无法跳出沙箱根去读其它仓库。
- **任何参数都不允许以 `-` 开头**：阻止 `--upload-pack=evil` /
  `--exec=...` 等通过 `revision` / `path` 字段注入。
- **拒绝换行 / NUL 字节**：阻止 argv 拼接技巧。
- **超时 15 秒**：异常仓库（巨大 pack、网络挂载抖动）不会卡死循环。
- **stdout 截断 64 KiB**：超长 diff 不会撑爆上下文。
- **非 git 目录**：返回软提示 `(not a git repository)`，模型可
  自适应而不是 panic。

### 调用样例

下面以 `POST /v1/chat/completions` 单轮接口为例（流式 / WS 接口
工具调用形式相同）。

**让模型自己看 status：**

```json
{
  "messages": [
    {"role": "user", "content": "看看这个仓库现在有什么改动"}
  ]
}
```

模型 → `git.status` → 拿到类似：

```
## main...origin/main
 M src/foo.rs
?? notes/draft.md
```

**让模型 review 一段未提交改动：**

```json
{
  "messages": [
    {"role": "user", "content": "我刚改了 src/foo.rs，diff 看一下能不能合"}
  ]
}
```

模型大概率会先 `git.status` 再 `git.diff { "path": "src/foo.rs" }`，
然后写 review。

**让模型查谁改的某个文件：**

```json
{
  "messages": [
    {"role": "user", "content": "src/agent.rs 最近 5 次改动是干嘛的"}
  ]
}
```

模型 → `git.log { "path": "src/agent.rs", "limit": 5, "format": "full" }`
→ 用拿到的 author + body 写总结。

**让模型展开某个 commit：**

```json
{
  "messages": [
    {"role": "user", "content": "34cd366 这个 commit 都改了啥"}
  ]
}
```

模型 → `git.show { "revision": "34cd366" }`。

### 与 `shell.exec` 的关系

如果同时开启了 `JARVIS_ENABLE_SHELL_EXEC=1`，模型可能既能调
`git.status` 又能调 `shell.exec` 跑 `git status`。建议优先依赖
`git.*`：

- `git.*` 输出稳定（写死 `--porcelain=v1` / `--pretty=...`），不会
  被宿主 `git config alias.*` 或 `core.pager` 干扰。
- `git.*` 不需要审批；`shell.exec` 默认进 approval gate（如果
  设置了 `JARVIS_APPROVAL_MODE`），多一道交互。
- `git.*` 没有命令注入面，`shell.exec` 哪怕在 sandbox 里也是
  全功能 shell。

把"读"留给 `git.*`，把"写"（commit、checkout、apply patch）才
显式开 `shell.exec`。

---

## 3. 与既有特性的协作

| 既有特性 | 与 ollama / git.* 的关系 |
|---|---|
| `JARVIS_FS_ROOT` 沙箱 | `git.*` 完全遵守；ollama 与该沙箱无关。 |
| 审批机制 (`JARVIS_APPROVAL_MODE`) | `git.*` 全部是只读，不进 approval；ollama 不影响。 |
| 摘要式记忆 (`JARVIS_MEMORY_MODE=summary`) | 可以用 ollama 当摘要模型，离线压缩更便宜。 |
| 持久化 (`JARVIS_DB_URL`) | 与 provider / 工具集无关，照常工作。 |
| `--mcp-serve` 模式 | `git.*` 会随 ToolRegistry 一起暴露给上游 MCP 客户端，等于让其它 agent 也能读你这个仓库。 |
| Web UI (`/ui/`) | 工具调用卡片自动渲染 `git.*`，无需前端改动。 |

---

## 4. 故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 启动报 `provider=ollama is not recognised` | jarvis 二进制是旧版 | `cargo build -p jarvis` 重新编译 |
| `connection refused` 调 ollama | ollama 没起 / 端口被占 | `ollama serve` / `lsof -i :11434` |
| ollama 模型从不调工具 | 该模型不支持 function calling | 换 `llama3.2` / `qwen2.5` / `mistral-nemo` |
| `git.status` 全部返回 `(not a git repository)` | `JARVIS_FS_ROOT` 不在 git 工作树里 | 把 root 指到包含 `.git/` 的目录 |
| `git.diff` 报 `must not start with \`-\`` | 模型把 `--cached` 这类 flag 放进了 `from` / `path` | 这是预期保护；如确需 staged diff，让模型用 `staged: true` |
| `git: command not found` | 宿主机没有 git | 装 `git`，或 `JARVIS_DISABLE_GIT_READ=1` 关掉这组工具 |
| `jarvis status` 显示 ollama `✗ no OLLAMA_API_KEY...` | 旧版 jarvis 二进制 | 同上，重新编译；新版会显示 `○ no key (local server doesn't need one)` |

---

## 5. 进一步阅读

- [`docs/user-guide.md`](./user-guide.md) — 主用户手册，含完整 provider 列表、HTTP API、MCP、记忆、持久化等。
- [`docs/proposals/aicoding-agent.zh-CN.md`](./proposals/aicoding-agent.zh-CN.md) — 编码 agent 的整体路线图，`git.*` 是其中第一块拼图。
- [`CLAUDE.md`](../CLAUDE.md) — 全部环境变量清单与内部约定。
- [`crates/harness-tools/src/git.rs`](../crates/harness-tools/src/git.rs) — `git.*` 实现与单元测试，可作为新增只读工具的参考模板。
