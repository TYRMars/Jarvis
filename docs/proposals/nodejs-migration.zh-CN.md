# Node.js（Egg.js + tegg）→ Rust 迁移方案 —— 2026-06 最新版

> **Status:** In progress — 主体迁移已完成（`f40ff3d`，2026-04-18 一次性重建）；
> 本文档把散落在 commit message / 旧 CLAUDE.md / DB.md 里的迁移决策固化为
> 单一记录，并列出仍未迁移的遗留缺口与收尾计划。
> **Date:** 2026-06-10
> **Method:** 全部结论按 git 历史（`f40ff3d~1` 旧 TS 树 vs 当前 main）与
> 当前代码逐项核实，不依赖记忆。

---

## 1. 背景

旧实现是 Egg.js + [tegg](https://github.com/eggjs/tegg) 的 TypeScript 服务
（包名 `agent-lang`），包裹 LangChain / LangGraph：`app/module/agent/` 下约
17 个 controller、17 个 service、18 个 Sequelize model，SQLite 持久化
（`path/to/database.sqlite`），可选 egg-redis。

迁移采取**整体删除 + 从脚手架重建**，而非渐进式 strangler：
`f40ff3d`（"Reinitialise as Rust agent harness workspace"）一次提交删光 TS
代码，立起 `harness-core` / `harness-llm` / `harness-server` / `apps/jarvis`
四件套。当时没有独立的方案文档 —— 方案体现在三处：

1. **commit message**：脚手架范围（agent loop + OpenAI provider + `/v1/chat/completions` 端到端）。
2. **重写后的 README roadmap**：`harness-tools` / `harness-mcp` / `harness-memory` /
   `harness-store` / SSE / Anthropic+Google provider 六项。
3. **DB.md 迁移指引**：旧表是**功能清单而非要照搬的 schema**
   （"treat that as a feature inventory, not a schema to copy"）；
   点名 JSON-blob-in-TEXT 是第一个要修的问题。

两条架构原则自迁移起沿用至今：**`harness-core` 不知道 HTTP / provider /
存储 / MCP**；**`apps/jarvis` 是唯一组合根**（库 crate 不读 `std::env`）。

## 2. 当年 roadmap 完成度：6/6，全部超额

| 计划项 | 现状 |
|---|---|
| `harness-tools`（http fetch / shell / fs read） | ✅ 全套内置工具（fs/shell/git/code.grep/requirement/doc/memory/…） |
| `harness-mcp`（rmcp client + server） | ✅ 双向 + plugin 体系 |
| `harness-memory`（短期 + 长期两层） | ✅ SlidingWindow + Summarizing；长期记忆在 harness-learning + memory store |
| `harness-store`（sqlx 持久化） | ✅ 落地方案演化：默认 JSON 文件，SQLite/Postgres/MySQL opt-in feature |
| SSE 流式 | ✅ SSE + WebSocket 双通道 |
| Anthropic / Google provider | ✅ 另加 Responses/Codex、Kimi、Ollama |

## 3. 旧功能 → 新架构映射（逐项核实）

| 旧实现（`f40ff3d~1`） | 去向 | 状态 |
|---|---|---|
| `react_agent.ts`（LangChain `AgentExecutor`） | `harness-core::Agent` 自研循环，零框架依赖 | ✅ |
| `graph_agent.ts` + `agent_workflow{,_node}` 表（LangGraph） | `harness-workflow` 声明式 Workflow + `workflow_runtime` | ✅ |
| MCP host（`mcp_host.ts` 内存 Map）+ `mcp_servers` 表 | `harness-mcp` + `JARVIS_MCP_SERVERS` + plugin manifest | ✅ |
| `memory.ts` 短期（进程内 Map） | `harness-memory`（窗口/摘要，token 预算制） | ✅ |
| `memory.ts` 长期（`memory` 表 + LLM 重要性打分） | `harness-learning::MemoryItem` + store + `/v1/memories` + 注入/泄漏守卫 | ✅ |
| `conversations` 表 | `ConversationStore`（json 默认，SQL opt-in） | ✅ |
| `tools` 表（DB 行注册工具） | `ToolRegistry`（代码注册，命名空间化） | ✅（有意改为代码而非数据） |
| `llm_provider_configs` 表 | `ProviderProfile` 目录 + `/v1/providers` | ✅ |
| `intents` / `intent_examples`（意图分类） | `harness-router` 难度分级路由（HeuristicClassifier） | ✅ 被取代（意图→难度，语义不同但覆盖场景） |
| `conversation_analysis` / `agent_evaluation` | `harness-observability`（span 埋点 + dashboard 读侧） | ⚠️ eval **runner/grader** 未做（feature-gap-audit P1-4 在跟踪） |
| **`rag_agent.ts`（HyDE + FAISS + embeddings）+ `knowledge_bases` 表** | **无对应物** —— 当前工作区没有任何 vector store / embedding 实现 | ❌ 最大缺口 |
| `prompts` / `prompt_versions`（版本化 prompt 管理） | 部分被 agent-profiles（system prompt）+ skills 覆盖 | ❌ 无版本化管理 |
| qianfan / 智谱 provider 配置位 | 未移植（OpenAI-compatible base-url swap 可覆盖部分） | ⚠️ 按需 |
| `user` 表 | `harness-core::tenant`（多租户 Phase 0） | ⚠️ 范围已变，不算缺口 |

## 4. 与原方案的两处有意偏离（保留，不视为债务）

1. **持久化默认值**：DB.md 原规划 "sqlx + SQLite 默认 + `DATABASE_URL`"，
   实际为 `JARVIS_DB_URL` + JSON 文件默认、SQL 全部 opt-in —— 零依赖优先，
   对单机/桌面端场景正确。
2. **JSON blob**：当年点名要修的 "JSON 塞 TEXT 列" 被重新接受为简单方案
   （SQL 后端仍是 `conversations` 单表 + `messages` JSON 整体）。
   换后端的抽象边界在 store trait，不在行格式。

## 5. 收尾计划（按优先级）

### P0 — 知识库 / RAG（旧 `rag_agent` + `knowledge_bases` 的唯一未迁移大项）

按现行架构落位（能力 = 工具 + context builder，**不是**独立 agent 路径）：

- `harness_core::EmbeddingProvider` —— 小 trait（`embed(texts) -> Vec<Vec<f32>>`），
  与 `LlmProvider` 同级；impls 在 `harness-llm`（OpenAI / Google 各一）。
- 新 crate `crates/harness-knowledge/`（仅依赖 core）：
  `KnowledgeBase` / `Document` / `Chunk` 值类型 + `KnowledgeStore` trait +
  分块器 + 余弦检索（无向量库依赖，json 后端先行；向量库后端走 opt-in feature，
  复用 harness-store 的 feature 模式）。
- 工具：`knowledge.{list,search}` 常开只读，`knowledge.{create,add_doc,delete}`
  opt-in + 审批门禁（沿用 `fs.write` 先例）。
- REST：`/v1/knowledge*`，503-when-unconfigured 模式。
- 检索注入走工具调用（模型自主检索），不复刻旧版 HyDE 自动注入 —— 需要时再加。

### P1 — Eval runner（旧 `agent_evaluation` 的闭环缺口）

已由 [feature-gap-audit.md](feature-gap-audit.md) P1-4 跟踪，此处只挂链接，
不重复规划。

### P2 — Prompt 版本管理

旧 `prompts`/`prompt_versions` 的场景今天大半被 skills（SKILL.md 即版本化
prompt，走 git）+ agent-profiles 覆盖。建议**先不立独立 PromptStore**，
出现真实需求（运行时改 prompt + 回滚）再评估；届时挂在 agent-profiles
上加版本维度即可。

### 关闭项（明确不做）

- **意图分类**：harness-router 的难度路由 + provider 显式指定已覆盖路由需求。
- **旧 SQLite 数据导入**：`path/to/database.sqlite` 的旧数据自迁移起未被
  引用过；如确有需要保留的旧会话，可写一次性导入脚本（旧 `conversations`
  行 → `ConversationStore`），目前默认放弃。
- **egg-redis**：无对应需求方。

## 6. 验收

- [ ] `harness-knowledge` crate + json 后端 + 工具 + REST，`make lint` / `make test` 全绿
- [ ] 旧 `rag_agent` 等价场景跑通：建库 → 加文档 → 对话中 `knowledge.search` 命中
- [ ] 本表第 3 节所有 ❌ 项要么转 ✅，要么在"关闭项"给出明确理由
