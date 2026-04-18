# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Jarvis (package name `agent-lang`) is an Egg.js + [tegg](https://github.com/eggjs/tegg) TypeScript server that exposes an Agent/LLM platform. It wraps LangChain / LangGraph to provide agent orchestration, RAG, prompt management, an OpenAI-compatible MCP (Model Context Protocol) endpoint, conversation analysis, intent classification, and agent memory. Persistence is Sequelize over SQLite by default (`path/to/database.sqlite`), with optional Redis via `egg-redis`.

Runtime: Node `>=20.18.1` (the README line about Node 18 is out of date — trust `package.json` `engines`). TypeScript 5, target ES2022, module `NodeNext`.

## Commands

```bash
npm i

# Dev server (uses egg-bin, runs TypeScript directly via ts-node — DO NOT tsc first)
npm run dev                 # http://localhost:7001/

# If you ever ran `tsc` by mistake, delete the emitted .js files before `dev`:
npm run clean               # tsc -b --clean

# Lint (eslint-config-egg/typescript, cached)
npm run lint
npm run lint -- --fix

# Tests (mocha via egg-bin, bootstrap from @eggjs/mock)
npm test                    # runs `clean` + `lint --fix` (pretest) then `egg-bin test`
npm run test:local          # same test runner, skipping the clean+lint pretest
npx egg-bin test test/app/module/foo/service/HelloService.test.ts   # single file
npx egg-bin test --grep "should hello work"                          # by test name
npm run ci                  # coverage (egg-bin cov)

# Production build / run
npm run tsc                 # emit .js alongside .ts (prepublishOnly runs clean+tsc)
npm start                   # eggctl start --daemon --title=egg-server-agent-lang
npm stop
```

Important dev-mode rule (from README): **do not `tsc` during development**. Egg loads `.ts` directly; leftover `.js` files shadow the TS sources. If the dev server behaves oddly, run `npm run clean` first. `.gitignore` already excludes `app/**/*.js`, `test/**/*.js`, `config/**/*.js` for the same reason.

## Architecture

### Tegg single-module layout

All application code lives under one tegg module: `app/module/agent/`. The standard egg `app/controller`, `app/service`, `app/model` layout is nested inside that module:

- `app/module/agent/router.ts` — single source of truth for all HTTP routes. New endpoints must be registered here; controllers are not auto-mounted by convention.
- `app/module/agent/controller/*.ts` — thin HTTP handlers; read `ctx.request.body`, call services, set `ctx.body = { success, data }`.
- `app/module/agent/service/*.ts` — business logic; LangChain/LangGraph orchestration lives here.
- `app/module/agent/model/*.ts` — Sequelize models (class-based, with a static `associate(models)` hook). Schemas are documented in `DB.md`.
- `app/module/agent/app.ts` — egg boot hook. `didReady()` calls `ctx.service.mcpInit.init()` to register models and tools with the MCP host at startup.

Path alias `@/module/*` → `app/module/*` is configured in `tsconfig.json` and used by tests (e.g. `import { HelloService } from '@/module/foo/service/HelloService'`).

### Plugins (config/plugin.ts)

tegg plugins enabled: `tegg`, `teggConfig`, `teggController`, `teggSchedule`, `eventbusModule`, `aopModule`, `tracer`. Infra: `egg-sequelize` (SQLite), `egg-cors` (open `*`), `egg-redis`.

CSRF is disabled (`config.security.csrf.enable = false`) — this is an API-first service. CORS is permissive; don't tighten it without checking callers.

### The three agent execution paths

`Agent.workflow_type` (column on the `agents` table: `simple` | `conversation` | `graph`) selects which service handles `POST /api/agents/:id/chat`:

- `service/react_agent.ts` — LangChain `AgentExecutor` + `createOpenAIFunctionsAgent` for tool-using ReAct-style agents.
- `service/rag_agent.ts` — Retrieval-augmented: HyDE retriever + FAISS store + OpenAI embeddings, pulling docs from knowledge bases associated to the agent.
- `service/graph_agent.ts` — LangGraph `StateGraph` pipelines for multi-step flows; also exposed directly via `POST /api/agents/:id/graph-chat`.

The configurable/custom workflows live in `service/workflow.ts` + `model/agent_workflow.ts` + `model/agent_workflow_node.ts` (nodes with JSON `config`, `position`, `edges`) and are executed by `POST /api/workflows/:workflow_id/execute`.

### MCP (Model Context Protocol) layer

An OpenAI-compatible façade sits in front of the agent services:

- `POST /v1/chat/completions` (supports `stream: true` → SSE), `POST /v1/tools/:name/:toolCallId`, `GET /v1/models`, `GET /health` — handled by `controller/mcp.ts`.
- `service/mcp_host.ts` keeps in-memory `Map`s of registered models and tools and dispatches chat completions to them.
- `service/mcp_init.ts` runs on boot (`app.ts#didReady`), registering models from `app.config.ai.models` and tools from the `tools` DB table with the host. It also wires ReactAgent into MCP.
- `service/mcp_client.ts` / `service/mcp_server.ts` plus `controller/mcp_server.ts` and the `mcp_servers` table manage *external* MCP servers that can be called as tools.

When adding tools that should be callable through `/v1/...`, register them in `mcp_init.ts` (or create a row in the `tools` table with `status=1`) — otherwise the MCP host will not find them.

### Agent memory

`service/memory.ts` owns both tiers described in the README:

- **Short-term**: in-process `Map<"agentId:sessionId", {...}>` — cleared on restart or via `POST /api/agent-memories/short-term/clear`.
- **Long-term**: `memory` table, scored by an LLM (`memoryProcessSchema` via zod/StructuredOutputParser) for importance + summary, and retrieved into the system prompt on each turn.

Memory is injected into the Graph/RAG prompts as a `{memory}` template variable — preserve that when editing those prompts.

### Database & models

SQLite at `path/to/database.sqlite` (yes, that's a literal directory, not a placeholder — see `config/config.default.ts`). Sequelize models use class syntax with a named `schema` export; associations are declared in static `associate(models)` methods. `DB.md` has the authoritative table reference. Most list-typed columns (`tools`, `knowledge_base_ids`, `prompt_variables`, `model_parameters`) are stored as JSON-encoded `TEXT` — controllers `JSON.stringify` on write and services `JSON.parse` on read.

### AI provider config

`config.ai` (currently commented out in `config.default.ts`) is the expected shape for provider keys: `openai`, `anthropic`, `google`, `qianfan`, `zhipu`. Services reference `this.app.config.ai?.<provider>?.apiKey`. To run anything that actually hits an LLM, uncomment and fill in (or override via `config.local.ts` / env-specific config). Per-agent overrides are supported via the `llm_provider_configs` table and `provider_config_id`.

## Conventions

- Routes: add new endpoints only in `app/module/agent/router.ts`. Follow the existing grouping/comment style; MCP endpoints stay at the top of the file per the comment there.
- Response shape: `{ success: boolean, data?: ..., message?: string }`. Use `ctx.status = 404` etc. for errors and still return that envelope.
- JSON-stringify complex fields (tools, knowledge_base_ids, model_parameters, prompt_variables) when writing Agent rows; callers sometimes pass objects and sometimes strings — see the `typeof x === 'object' ? JSON.stringify(x) : x` pattern in `controller/agent.ts`.
- Tests use `import { app } from '@eggjs/mock/bootstrap'` and `app.httpRequest()` / `app.getEggObject(ServiceClass)`. Place new tests under `test/app/module/<module>/...` with a `.test.ts` suffix.
- Lint enforces `eslint-config-egg/typescript` + the `enforce-node-prefix` rule — use `node:assert`, `node:fs`, etc.
- `typings/` is auto-generated by `egg-ts-helper` — do not hand-edit.
