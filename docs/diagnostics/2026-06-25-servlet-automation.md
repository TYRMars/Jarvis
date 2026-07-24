# Jarvis 项目自动化能力诊断报告（2026-06-25 复测）

- **运行时间**：2026-06-25（scheduled task 自动跑）
- **被测分支**：`feat/mobile-ios-ddns`（Node runtime；与 06-23 同一基线，相关 REST 路径无新提交）
- **被测项目**：`/tmp/jarvis-servlet-test`（最小 Java Servlet 4.0 样例：`HelloServlet` + `EchoServlet` + `web.xml`，故意不带 Maven/Gradle，与 06-23 一致）
- **本次目的**：在 06-23 [首次诊断](2026-06-23-servlet-automation.md) 的基础上做**回归 + 增量验证**，确认 P1 修复进度，并对 `harness.health` 在"无 LLM key"环境下的迭代信号做更细颗粒度的复现
- **运行约束**：仍无可用 LLM key → `JARVIS_WORK_MODE=off`；所有结论来自 REST/store/单测层

---

## 0. 与 06-23 的整体差异（TL;DR）

| 项 | 06-23 状态 | 06-25 状态 | 变化 |
| --- | --- | --- | --- |
| 522 条 `@jarvis/server` 单测 | 全绿 | **全绿** | 持平 |
| P1-A `acceptance_policy` / `workflow_id` / `assignee_id` REST 透传 | 静默丢弃 | **仍静默丢弃** | ❌ 未修 |
| P1-B `POST /v1/roadmap/import` | 404 | **仍 404** | ❌ 未修 |
| P3 `harness.health` 在空工作区的 confidence | 0.10 | **0.18**（6 个 pending run） | 算法行为一致，仅样本数差异 |
| 新发现：`POST /v1/projects/:project_id/requirements` 对不存在的 `project_id` 无 FK 校验，落库 `project_id: ""` | （未观察）| 复现 | 新增 P2 |
| 新发现：06-23 写 `signals.requirement_runs` 嵌套对象与 `dimensions` 是 dict — 实测前者是 **int 计数**，后者是 **list** | 误读 | 已勘误 | 文档勘误 |

`requirements-routes.ts` 在 `:156-167` 仍带 explicit comment：

> `verification_plan / workflow_id` three-state semantics are part of the
> full Rust handler but out of scope for this port (no plan/workflow wiring
> on the Node AppState yet); a future pass adds them.

`register-builtins.ts:13` 也仍保留同样的"未移植清单"注释——所以两个 P1 项目的状态是**有意推后**，而不是被遗漏。

## 1. 测试配置（与 06-23 完全一致）

```
OPENAI_API_KEY=sk-stub-for-automation-test
JARVIS_PROVIDER=openai
JARVIS_MODEL=gpt-4o-mini
JARVIS_FS_ROOT=/tmp/jarvis-servlet-test
JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db
JARVIS_ADDR=127.0.0.1:7099
JARVIS_WORK_MODE=off
JARVIS_PERMISSION_MODE=bypass
JARVIS_NO_PROJECT_CONTEXT=1
```

启动日志：

```
[jarvis] persistence connected: json:///tmp/jarvis-servlet-test-db
[jarvis] serve: provider=openai model=gpt-4o-mini addr=127.0.0.1:7099 fsRoot=/tmp/jarvis-servlet-test coding=false auth=none ddns=off mdns=off promptBytes=263
```

`/v1/server/info`：`tools=44`、`project_store=true`、`persistence=json://…`。

## 2. 9 步迭代轨迹（实测）

> Servlet 项目下创建 4 个需求 → 串行迭代驱动 → 每步重读 `/v1/observability/health`。
> 由于 `JARVIS_WORK_MODE=off` + 无 LLM key，所有 `runs` 都停在 `pending`，
> `terminal_requirement_runs / completed / failed / verified` 全程为 0。

| 步 | 操作 | overall_score | confidence | sample_count | primary_focus |
| --- | --- | --- | --- | --- | --- |
| 1 | 4 个需求建好，HelloServlet mint 1 run | 47 | 0.18 | 6 | planning_execution |
| 2 | PATCH hello → done | 47 | 0.18 | 6 | planning_execution |
| 3 | 给 echo + maven 也 mint run | 47 | 0.18 | 6 | planning_execution |
| 4 | echo: backlog → in_progress → review | 47 | 0.18 | 6 | planning_execution |
| 5 | echo: review → done | 47 | 0.18 | 6 | planning_execution |
| 6 | `/v1/diagnostics/runs/stuck?threshold_seconds=1` → 3 条 pending（age=40s/40s/64s） |
| 7 | `/v1/work/overview` → `requirement_status_counts: {backlog:0, in_progress:1, review:0, done:2}` |
| 8 | `POST /v1/roadmap/import` → **HTTP 404** |
| 9 | `PATCH /v1/requirements/:maven {"acceptance_policy":"Human","workflow_id":"wf-test"}` → 200，再 GET 两字段均 `<missing>` |

最终 `/v1/observability/health` 关键切片：

```
overall_score=47  confidence=0.184  sample_count=6  primary_focus=planning_execution

sources:
  observability  : configured=false rows=0
  evals          : configured=false rows=0
  requirement_runs: configured=true  rows=6

signals (top-level int counts):
  observed_runs=0  agent_runs=0  tool_runs=0  subagent_runs=0  eval_cases=0
  requirement_runs=6
  terminal_requirement_runs=0  completed_requirement_runs=0
  failed_requirement_runs=0    cancelled_requirement_runs=0
  verified_requirement_runs=0  verification_passed=0
  agent_success_rate=None  tool_success_rate=None  subagent_success_rate=None
  eval_pass_rate=None      completion_rate=None    verification_pass_rate=None
  p95_latency_ms=None      error_hotspots=[]

actions (中文，按 priority+tone 排序):
  [1][danger ] 优先稳定交付闭环         — completed 0 / terminal 0
  [2][warn   ] 收敛规划执行失败          — timeout_like 0 / max_iteration_like 0
  [3][warn   ] 优化工具与 SubAgent 调用 — tools 0 / subagents 0
  [4][warn   ] 强化任务理解与验收表达   — capability eval cases 0
  [5][neutral] 补齐观测样本             — sample_count 6
```

**迭代判断**：连跑 5 个 kanban 状态转移 + 3 次 `runs` POST，`overall_score` 完全没动；`confidence` 从 0.15（06-23 报告值）涨到 0.18（多了 2 行 run），但仍远低于 0.2 的可用阈值。这印证 06-23 的"冷启动 + agent 跑挂"输出几乎相同的判断——本次相同分支再次复现，所以 06-23 §3.3 提出的"`confidence < 0.2` 在前端折叠为'样本不足'"的建议**优先级应抬高到 P1**：否则任何 dashboard 都会被 47 + 五条 danger/warn 误导。

## 3. P1 项的回归确认

### 3.1 `acceptance_policy` / `workflow_id` REST 透传 — 仍丢

```
PATCH /v1/requirements/<maven_id>
  body: {"acceptance_policy":"Human","workflow_id":"wf-test"}
→ 200 OK
GET   /v1/requirements/<maven_id>
→ {... no acceptance_policy ..., no workflow_id ...}
```

`packages/server/src/requirements-routes.ts:144-167` 的 `CreateBody` / `UpdateBody` interface 仍只列 `title / description / status / triage_state / depends_on / label_ids (+ conversation_ids)`；显式注释承认 `verification_plan` / `workflow_id` 出 scope。`acceptance_policy` 在 `/runs` POST 里被读到（`:439`：`item.acceptance_policy ?? "subagent"`，用于阻断 Human-policy 的 mint），所以**写不进去 = Human policy 永远拿不到** 这条死循环依旧成立。

### 3.2 `roadmap.import` — 仍 404

```
POST /v1/roadmap/import → 404 {"message":"Route POST:/v1/roadmap/import not found", ...}
```

`packages/tools/src/register-builtins.ts:13` 注释保持："`roadmap.import` 不在 Node `@jarvis/tools` surface" 的明确说明。**CLAUDE.md 与运行时仍不一致**——CLAUDE.md 第 ~`/v1/roadmap/import` ✅ 那一行需要标为 `(deferred)`，否则任何按文档来对接的客户端都会撞墙。

## 4. 新发现（06-23 未记录）

### 4.1 `POST /v1/projects/:project_id/requirements` 没有外键校验

用一个**不存在的** `project_id` 调 create requirement，仍然 201：

```
POST /v1/projects/<no_such_id>/requirements
  body: {"title":"x","triage_state":"approved"}
→ 201 {"id":"...","project_id":"","title":"x", ...}
```

`project_id` 字段被写成空串，落库后`/v1/projects/<no_such_id>/requirements` GET 拿不回来；只能通过 `/v1/requirements/<row_id>` 直查。

**影响**：是脏数据风险，但更主要的是诊断难度——这些孤儿行不会出现在任何 project-级别 UI 里，只能靠 store 文件巡检发现。

**建议**：`packages/server/src/requirements-routes.ts:206` create handler 先 `store.getProject(projectId)`（或对等查询），不存在 → 404。同时给 `:255` PATCH 加同样的校验。

### 4.2 `runs/stuck` 路由返回的是 `items[]`，不是 `rows[]`

06-23 报告里 §3.4 用 `rows[]` 计数；实测 `/v1/diagnostics/runs/stuck` 返回 `{"items":[...]}`，与其它 diagnostics 端点风格一致。**报告勘误**：原 §3.4 的"`?threshold_seconds=1` 把 47/64 s 的 run 拉出来"是对的，但解析键写错了；本次 3 行均带 `age_seconds`，含义未变。

### 4.3 `dimensions` 是 list，`signals.requirement_runs` 是 int

`/v1/observability/health` 响应里 `dimensions` 是 `[{score,weight,...}, ...]`（不是 dict 按维度键），`signals.requirement_runs` 直接是 `int`（不是嵌套 `{completed_count,...}` 对象——那些 sibling 字段以独立 key 形式平铺在 `signals` 下）。06-23 报告中 §3.3 的"`signals.requirement_runs={configured,rows}`"措辞是**指向 `sources.requirement_runs` 才对**。本次复测拿到的真实 schema 见 §2 输出。

不是 bug，但 `harness.health` wire shape 没有任何文档说明，未来加客户端时很容易踩。

## 5. 单测健康

```
$ pnpm --filter @jarvis/server test
...
# tests 522
# pass 522
# fail 0
# duration_ms 7964.879209
```

522/522 全绿，覆盖 auto-mode / requirements / observability / diagnostics / projects / worktrees / runs / verification / activities 等，相比 06-23 的 ~151 抽样这次跑了全套。

## 6. 建议优先级（合并 06-23 + 06-25）

| 优先级 | 项 | 文件/位置 | 状态 |
| --- | --- | --- | --- |
| **P0(新)** | Web UI 在 `confidence < 0.2` 时把 `overall_score` 替换成"样本不足"——"评分定格 47 + 五条 warn"是 cold-start 与 agent 全挂的同一信号，必须前端区分 | `apps/jarvis-web/src/...` | 待修 |
| P1 | `requirements-routes.ts` create/patch 增加 `acceptance_policy` / `workflow_id` / `assignee_id` / `verification_plan` 透传 + 单测；同步 `requirement.create` 工具 | `:144-167`、`:206`、`:255` + `packages/tools/src/requirement-tools.ts` | 06-23 提出，未修 |
| P1 | `roadmap.import` 工具 + REST 移植；或在 CLAUDE.md 显式标记 deferred | `packages/tools/src/`、`CLAUDE.md` | 06-23 提出，未修 |
| **P2(新)** | requirements create/patch 加 project_id 存在性校验，不存在 → 404，避免孤儿行 | `:206`、`:255` | 本次新增 |
| P2 | `/v1/observability/health` wire shape 文档化（`dimensions: []` / `signals.* int` / `sources.* {configured, rows}`） | `CLAUDE.md` 或 `docs/conventions/` | 06-23 漏记 |
| P3 | `runs/stuck` 默认 `threshold_seconds` 在 CLAUDE.md 路由清单里补一行；统一所有 diagnostics 路由都返回 `items[]` 的 contract 说明 | `CLAUDE.md` | 06-23 提出，未修 |
| P3 | `ObservabilityStore` / `EvalStore` 的 env-driven 拉起方式在 CLAUDE.md 文档化 | `CLAUDE.md` | 06-23 提出，未修 |

## 7. 复测剧本（带 LLM key 时，与 06-23 §6 一致）

```bash
export OPENAI_API_KEY=sk-...
export JARVIS_FS_ROOT=/tmp/jarvis-servlet-test
export JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db
export JARVIS_WORK_MODE=auto
export JARVIS_WORK_TICK_SECONDS=10
export JARVIS_WORK_MAX_CONCURRENT=1
export JARVIS_ENABLE_FS_WRITE=1 JARVIS_ENABLE_FS_EDIT=1 JARVIS_ENABLE_SHELL_EXEC=1
export JARVIS_PERMISSION_MODE=bypass
node --experimental-strip-types packages/jarvis-app/src/main.ts serve &
# 与本报告 §2 同样的 curl 序列 → 等 2-3 个 tick →
#   /v1/diagnostics/runs/recent 应出现 completed/failed；
#   /v1/observability/health 应 confidence>0.2 + completion_rate 非 null。
```

期望额外观察项（仍未验证，列入下次任务）：

- `subagent.review` 在 `Subagent` policy 下是否真把 review→done flip（需 `JARVIS_REVIEWER_AUTO_ACCEPT=1`）。
- `triage.scan_candidates` 能否把 `EchoServlet.java:8` 的 `TODO(jarvis): support POST body echo with content-length cap` 自动建成 `ProposedByScan` 需求。
- `project.checks` 能否识别"缺少 Maven/Gradle"并建议 `mvn archetype:generate` 或 `gradle init`。

## 8. 总览

| 项 | 评分 | 与 06-23 比 |
| --- | --- | --- |
| Kanban (Project + Requirement CRUD + 状态转换 + Activity 时间线) | ✅ 健康 | 持平 |
| Diagnostics (`/v1/diagnostics/*`、`/v1/work/*`) | ✅ 健康 | 持平 |
| Harness.health 算法实装 | ✅ 健康 | 持平 |
| Harness.health 信号采集 | ⚠️ 缺 LLM 驱动时无信号 | 持平 |
| Harness.health 前端表达 | ❌ confidence 低分仍直接展示 score | **P0 抬升** |
| REST ↔ 数据模型一致性 | ⚠️ `acceptance_policy` / `workflow_id` 静默丢弃，project_id 无 FK 校验 | 06-23 + 新发现 |
| 文档 ↔ 运行时一致性 | ⚠️ `roadmap.import` 文档存在但运行时 404；health wire shape 无文档 | 持平 |
| 单测覆盖 | ✅ 522/522 全绿 | 06-23 仅抽样 151，本次跑全套 |
| 自动化的端到端验证（有 LLM key） | ❌ 本次未执行 | 持平（无 key） |

**总体判断（无变化）**：Jarvis 项目自动化骨架在 Node 端依旧对齐 Rust 设计；阻塞"auto-loop 端到端跑通"的两点 REST 透传缺口和 `roadmap.import` 缺失在 06-23 → 06-25 的 2 天里没有改动。这次复测唯一的"新动作项"是**前端对 `confidence < 0.2` 的视觉折叠**——这是观察到 5 次迭代 score 完全没动后下沉出来的一线问题：harness.health 的数学没问题，但**它没法在 cold-start 状态下区分"还没开工"和"全面崩盘"**，前端必须帮算法兜底。
