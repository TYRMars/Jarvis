# 借鉴 opencode：闭合 Agent 的「编辑→验证」与「暂停→交互」环路

> **Status:** In progress ——
> **P0.1（HITL 原生问答接线）已落地**（core HITL 通道 + agent 循环 + WS `hitl_response`
> 帧 + `ask.text` 解 stub）；
> **P0.2（编辑后 LSP 诊断回灌）已落地**（新 `@jarvis/lsp` 包 + `fs.{write,edit,patch}`
> 追加 `<diagnostics>` 块 + `JARVIS_ENABLE_LSP` 门控；mock-server 端到端测试全绿）；
> **P0.3（反应式上下文压缩最小切片）已落地**（从模型 `contextWindow` 推导默认压缩预算
> + `SummarizingMemory` 改用结构化锚点摘要模板）；
> **P0.4（原生 web 搜索 + HTML→Markdown）已落地**（`http.fetch` 加 `format:"markdown"`
> 经 `node-html-markdown` 抽取；web 搜索复用 MCP 桥，文档化）；
> P0 全部完成。P1/P2 条目 Proposed。所有改动 typecheck/lint/test 全绿。
>
> 来源：对 `opencode`（v1.17.9，Bun + Effect-TS）16 个能力维度做深度对比 +
> 独立核验 Jarvis 现状后的借鉴清单。核验环节专门复查"Jarvis 是否已具备"，
> 以免推荐已有能力。

## 一句话结论

opencode 真正值得借鉴的不是"更多功能"，而是**闭合两个环路**：

1. **编辑→验证**：opencode 在每次 `edit/write/patch` 后把 LSP 诊断回灌进工具结果，
   让模型当场看到自己引入的类型错误并自我纠错。Jarvis 今天编辑后**只返回成功文本**，
   模型只能手动 `shell.exec` 跑 typechecker 再 grep。
2. **暂停→交互**：opencode 的 agent 能中途向人发起结构化问答并阻塞等待回答。
   Jarvis 的 `ask.text` 工具是个**已声明的 deferred stub**——前端 UI 已全部建好，
   只差 core 的 HITL 通道与 2 个 WS 帧。

优先补这两条环路（外加反应式上下文压缩、原生 web 搜索、Plan Mode 真实落地），
大多是"接线已有零件"而非新架构，把 Jarvis 从"会编辑的 agent"升级成
"会验证、会问的 agent"。

## 能力对比总表（16 维 → 结论）

| 能力 | opencode | Jarvis 现状 | 结论 |
|---|---|---|---|
| HITL 结构化问答 | `question/index.ts`（Deferred 阻塞） | `ask.text` 是 deferred stub；**web 前端已全建好** | **P0 借鉴（高）** |
| 编辑后 LSP 诊断回灌 | `lsp/diagnostic.ts` + edit 回灌 | 编辑后无任何回灌 | **P0/P1 借鉴（高）** |
| 反应式上下文压缩 | `session/{overflow,compaction,summary}.ts` | 每轮无条件压到固定 env 预算；Usage 被丢弃 | **P0 借鉴（中）** |
| 原生 web 搜索 + HTML→MD | `tool/{websearch,webfetch,mcp-websearch}.ts` | 仅 `http.fetch` 返回截断原始 HTML | **P0 借鉴（中）** |
| Plan Mode 强制只读 | `agent/agent.ts` ruleset + `tool/plan.ts` | "名词"齐全但**纯装饰**：write 工具仍可调用、`exit_plan` 不停 turn | **P1 借鉴（中）** |
| 快照与回退（跨 turn undo） | `snapshot/index.ts` + `session/revert.ts` | 有 worktree 隔离，但无事后 undo / per-message diff | **P1 借鉴（中）** |
| 完整 LSP 工具（hover/def/refs） | `lsp/*` + `tool/lsp.ts` | 无 | **P1 借鉴（高）** |
| 自定义命令 / 提示模板 | `command/*` + `$ARGUMENTS` 展开 | 有 Skills（自动激活），无显式带参命令 | **P1 借鉴（低-中）** |
| 分层配置文件（opencode.json） | `config/*` | 纯 env + flag，零磁盘配置 | **P2 借鉴（运维体验）** |
| 模糊编辑 + codex apply_patch | `tool/edit.ts`（737 行级联） | `fs.edit` 单次唯一替换 + `fs.patch`（diffy） | **P2 借鉴（低-中）** |
| 动态模型目录 + OAuth login | `provider/* auth/*` | 静态 env；codex OAuth 已有 | **P2 部分借鉴** |
| 持久/后台 shell（agent 轴） | one-shot bash | `shell.exec` 等价 | **已对齐，不借鉴** |
| 代码自动格式化 | `format/*` | 无（可经 `project.checks` 引导） | **低价值** |
| 按模型定制 prompt | `session/prompt/*.txt` | 单 coding/general 切换 | **低价值** |
| 会话分享（公开 URL） | `share/*`（依赖 hosted backend） | 无 | **P2 需求驱动（自托管查看器）** |
| 编辑器集成 / ACP（Zed） | `acp/*` | 无 | **战略级，需求驱动（先 spike）** |

## 落地顺序

### P0 — 补全已投入 / 闭合环路（先做）
1. **HITL 原生问答接线** —— `@jarvis/core` HITL 通道 + chat WS `hitl_response` 帧 + `ask.text` 解 stub。
2. **编辑后 LSP 诊断回灌** —— 最小 LSP client + `fs.{edit,write,patch}` 追加 `<diagnostics>` 块。
3. **反应式压缩最小切片** —— 从模型 `contextWindow` 推导预算 + 结构化摘要锚点模板。
4. **web 搜索 + HTML→Markdown** —— `http.fetch` 加 `format`，搜索复用 `@jarvis/mcp` 客户端。

### P1 — 高价值能力（中-高成本）
5. Plan Mode 真实落地（mode-signal 通道 + 请求构建期 tool-filter + `isTerminal` 停 turn）。
6. 快照与回退（`@jarvis/snapshot` shadow-git 树 + `POST /v1/conversations/:id/revert`）。
7. 完整 LSP 工具（`code.lsp` 9 操作，3-4 个 server 仅 PATH 探测）。
8. 反应式压缩完整版（413 中途恢复 + overflow 触发 + tool-output 剪枝）。
9. 自定义命令（`@jarvis/command` 包，仿 `@jarvis/skill`）。

### P2 — 运维体验 / 战略选项（需求驱动）
10. 分层配置文件 · 11. 动态模型目录 + OAuth login + github-copilot · 12. 模糊编辑 +
codex apply_patch · 13. 自托管会话分享查看器 · 14. ACP 编辑器集成（先 spike）。

---

## P0.1 详细设计：HITL 原生问答接线

**目标**：让 agent 在运行中通过 `ask.text` 向人发起结构化问答（确认 / 自由输入 /
单选 / review）并**阻塞等待**回答，回答以文本形式回灌给模型。

**关键事实**：Web 前端的 HITL 层**已经全部建好**——`AskTextCard.tsx`、`hitlSlice.ts`、
`hitlFrames.ts`、`types/frames.ts` 的帧类型、socket 白名单都在；缺的只是后端：
core 的 HITL 通道、WS 的 `hitl_response` 处理、以及把 `ask.text` 的 deferred stub 解开。

### 架构（对称于已有的 Approval 网关）

HITL 拆成两半，分别对应工具侧与传输侧——与 approval 网关同构：

- **工具侧（task-local）**：`@jarvis/core/hitl.ts` 用 `AsyncLocalStorage` 暴露
  `requestHuman(req)` / `withHitl(sink, fn)` / `hitlActive()`，与 `plan.ts` /
  `progress.ts` 同构。`ask.text` 调 `requestHuman(req)`，无 sink 时立刻得到
  `expired` 响应（阻塞 run / 无传输的 SSE 场景下仍给模型一个文本结果）。
- **传输侧（config）**：`HumanLayer` 接口 + `ChannelHuman` 实现，与
  `Approver` / `ChannelApprover` 同构。`AgentConfig.human?` 承载它。

### 数据流

```
ask.text.invoke → requestHuman(req)            [工具侧 task-local]
  → 循环装入的 hitlSink(req):
      queue.push({type:"hitl_request", request}) [→ 流式 yield 给客户端]
      response = await config.human.request(req)  [ChannelHuman 登记 pending]
      queue.push({type:"hitl_response", response})[→ echo，前端卡片据此 resolve]
      return response
客户端渲染 AskTextCard → 用户作答 → 发送扁平帧
  {type:"hitl_response", request_id, status, payload, reason}
WS onFrame case "hitl_response" → pendingHitl.get(request_id)(response)
  → ChannelHuman 的 Promise resolve → 工具拿到回答 → 返回 JSON 给模型
```

### 线协议（必须严格匹配既有前端）

- **客户端→服务端**（`AskTextCard` 发出，**扁平**）：
  `{ type:"hitl_response", request_id, status, payload, reason }`
- **服务端→客户端 请求**：`{ type:"hitl_request", request: HitlRequest }`
- **服务端→客户端 echo**：`{ type:"hitl_response", response: HitlResponse }`
  —— 卡片在收到 echo 前保持 `pending`，故 echo 必发。
- `HitlResponse.status ∈ approved | denied | submitted | cancelled | expired`。
- turn 结束时前端 `finalizePendingHitls()` 自动把未决卡片标记 `cancelled (turn ended)`，
  故服务端只需在 turn 结束时 `pendingHitl.clear()`（与 approval 一致）。

### 触及文件

| 文件 | 改动 |
|---|---|
| `packages/core/src/hitl.ts`（新） | 值类型 + task-local 通道 + `HumanLayer` / `ChannelHuman` |
| `packages/core/src/index.ts` | 导出 hitl 模块 |
| `packages/core/src/agent.ts` | `AgentConfig.human?`；`AgentEvent` 加 `hitl_request`/`hitl_response`；runStream 工具分发处装 `withHitl` sink |
| `packages/tools/src/ask.ts` | `#dispatch` 改为 `await requestHuman(req)`，复用 core 类型 |
| `packages/server/src/state.ts` | `createAgent(approver?, human?)` 签名 |
| `packages/jarvis-app/src/state.ts` | `createAgent` 透传 `human` 到 `AgentConfig` |
| `packages/server/src/chat-routes.ts` | per-socket `ChannelHuman` + `pendingHitl` map + `case "hitl_response"` |

### 已知边界（与 approval 一致，本期不处理）

socket 在 HITL 未决时关闭，未决的工具 Promise 不会被 resolve——但承载它的生成器
仅被在途的 `runTurn` 引用，turn 结束即 GC。这与现有 approval 的行为一致，
是既有条件而非本改动引入。后续可加 `socket close` 钩子统一 fail 未决
approval + hitl（与 abort 信号联动）。

---

## P0.2 详细设计：编辑后 LSP 诊断回灌（已落地）

**目标**：闭合 agent 的「编辑→验证」环路。`fs.write` / `fs.edit` / `fs.patch` 成功后，
把该文件的 LSP **错误**（仅 severity=1）以 `<diagnostics file="…">` 文本块追加进工具
结果——agent 循环本就把工具输出当文本回灌，**无需改动循环**，模型即可当场看到
自己引入的类型错误并自我纠错。

### 架构

新增叶子包 **`@jarvis/lsp`**（零运行时依赖，不读 `process.env`）：

- `protocol.ts` —— LSP 类型最小切片（Position/Range/Diagnostic）。
- `diagnostic.ts` —— `report(file, diags)`：errors-only `<diagnostics>` 块（逐字借鉴
  opencode `lsp/diagnostic.ts`）。
- `client.ts` —— 极简 LSP client：`child_process` spawn + 手写 `Content-Length`
  JSON-RPC 帧（**不引入 `vscode-jsonrpc`**），只走 **push diagnostics**
  （`textDocument/publishDiagnostics`，TS/Pyright/gopls/rust-analyzer 开文件即推）。
  **跳过** opencode 的 pull/workspace 诊断与 dynamic-registration（最重最脆的部分）。
  保留唯一关键时序：**settle 窗口**——服务器常先推空数组再推真实诊断（tsserver
  syntactic→semantic），故 `openAndDiagnose` 在“最后一次推送后 `settleMs`”才 resolve。
- `registry.ts` —— 扩展名→server（PATH 探测；缺失即 no-op，**不自动下载** server）。
  PATH 由组合根注入（`SearchEnv`），库本身不读 `process.env`。
- `manager.ts` —— `LspManager`：按语言惰性 spawn、复用、`report(absPaths)` →
  合并诊断块；`dispose()` 关停。`initialize` 带 `processId`，父进程死时 server 自杀。

### 集成（解耦，core 不动）

`@jarvis/tools` 定义结构化钩子 `DiagnosticsHook = (absPaths) => Promise<string>`
（`diagnostics.ts`），`FsConfig` / `BuiltinsConfig` 新增可选 `diagnostics`，写工具成功后
`withDiagnostics(result, hook, paths)` 追加块（**best-effort，绝不让诊断失败破坏编辑**）。
组合根（`jarvis-app/tools.ts`）在 `JARVIS_ENABLE_LSP` 且开了写工具时构建 `LspManager`
并把 `report` 作为钩子注入；`@jarvis/tools` 与 `@jarvis/lsp` 无依赖（鸭子类型）。

### 触及文件

| 文件 | 改动 |
|---|---|
| `packages/lsp/**`（新包） | client / manager / registry / diagnostic / protocol + mock-server 测试 |
| `packages/tools/src/diagnostics.ts`（新） | `DiagnosticsHook` + `withDiagnostics` |
| `packages/tools/src/{fs.ts,patch.ts,register-builtins.ts}` | 写工具追加诊断块 + `BuiltinsConfig.diagnostics` |
| `packages/jarvis-app/src/{config.ts,tools.ts}` | `JARVIS_ENABLE_LSP` + 构建/注入 `LspManager`（PATH 注入） |

### 验证

`packages/lsp/src/manager.test.ts` 用真实子进程 mock LSP server 端到端验证帧/握手/
didOpen/push 诊断/settle 窗口/多文件复用/缺失 server 降级；`packages/tools/src/
diagnostics.test.ts` 验证 fs.{write,edit,patch} 注入。本机无 `typescript-language-server`，
真实 server 集成测试留作后续（需 CI 装 server）。

---

## P0.3 详细设计：反应式上下文压缩最小切片（已落地）

**目标**：让压缩**随模型上下文窗口自适应**，并显著改善摘要召回。此前 `JARVIS_MEMORY_TOKENS`
未设时**完全不压缩**（每轮发全量历史，直到 provider 413）。

### (a) 从 `contextWindow` 推导默认预算（`packages/jarvis-app/src/state.ts`）

新增 `resolveMemoryBudget(config)`：显式 `JARVIS_MEMORY_TOKENS` 优先；否则用
`lookupCapability(canonicalKind(provider), model)?.contextWindow`（`@jarvis/llm` 的
能力目录，此前仅用于 UI 徽章）推导 `budget = contextWindow − reserved`，其中
`reserved = clamp(0.2 × ctx, 4k, 20k)`（借鉴 opencode `overflow.ts` 的 `COMPACTION_BUFFER`
上限）。未知模型 → `undefined` → 维持"不装 memory"的历史行为（纯增量，无回退风险）。
`buildMemory` 与 `serverInfo.memory.budget_tokens` 均改用它。
例：gpt-4o-mini 128k → 预算 108k；典型对话从不触发，超长对话改为压缩而非 413。

### (b) 结构化锚点摘要模板（`packages/memory/src/summarizing.ts`）

`DEFAULT_SUMMARY_PROMPT` 由自由段落换成 opencode `SUMMARY_TEMPLATE` 的结构化锚点
（Goal / Constraints / Progress[Done/InProgress/Blocked] / Key Decisions / Next Steps /
Critical Context / Relevant Files），给模型固定槽位、显著提升后续 turn 依赖事实的召回；
输出以 `## Goal` 起，前导剥离器不误伤。`DEFAULT_SUMMARY_MAX_TOKENS` 400 → 800。

**已知边界**：opencode 的 "update-merge"（回传旧摘要让模型修订而非重写）**本期不做**——
`SummarizingMemory` 是单例共享、单槽全局缓存，无法安全取到**按会话**的旧摘要（会跨会话污染）。
后续若需，要么按会话线程化摘要状态，要么给缓存槽加"旧 dropped 集是新集前缀"的守卫。

### 验证

`packages/jarvis-app/src/wiring.test.ts`（`resolveMemoryBudget` 显式/已知/未知三态 +
`buildMemory` 已知模型派生 / 未知模型 undefined）；`packages/memory/src/summarizing.test.ts`
（结构化模板含全部 section + 经真实 compaction 作为 system 提示送达 summariser）。

---

## P0.4 详细设计：原生 web 搜索 + HTML→Markdown 抽取（已落地）

### (A) `http.fetch` HTML→Markdown（`packages/tools/src/http.ts` + `html-markdown.ts`）

此前 `http.fetch` 返回**带 header 的截断原始 HTML**，对 LLM 读文档极不友好且烧 token。
新增 `format` 参数（`raw` 默认 / `markdown`）：`markdown` 时把 HTML 响应转干净 Markdown，
**非 HTML（JSON/XML/纯文本）原样透传**（`looksLikeHtml` 按 content-type 决策，缺失则嗅探
body 前 1KB），所以模型可无脑传 `format:"markdown"` 而不会破坏 API 响应。转换走
`node-html-markdown`（Node 原生、无 jsdom、号称最快），**lazy-import**——仅在真正请求
markdown 时加载，保持启动精简；转换 best-effort，出错回退原文，绝不让 fetch 失败。
现有 SSRF 防护与敏感 header 剥离全部保留。借鉴 opencode `tool/webfetch.ts`（其用 turndown，
Node 侧改用更轻的 node-html-markdown）。

### (B) web 搜索 —— 复用现有 MCP 桥（零自研代码）

不新增原生 `web.search` 工具：Jarvis 的 `@jarvis/mcp` 桥已把任意远程 MCP server 的工具
注册为 `<prefix>.<tool>`。把搜索类 MCP server 经 `JARVIS_MCP_SERVERS` 接入即可，例如
`JARVIS_MCP_SERVERS='web=npx -y exa-mcp-server'` → 自动得到 `web.search` 等工具
（API key 经该 server 自身的 env 注入；也可走 Composio 托管 MCP）。这正是 opencode
`tool/mcp-websearch.ts` 的 `tools/call` 适配在 Jarvis 架构里的等价物，无需重复造轮子。

### 验证

`packages/tools/src/http.test.ts`：`htmlToMarkdown`（标题/链接/列表）、`looksLikeHtml`
（content-type 决策 + 嗅探）、`format=markdown` 转 HTML、`format=markdown` 透传 JSON、
默认 `raw` 保留 HTML。
