# Jarvis 项目自动化能力诊断报告（2026-06-27 四次复测）

- **运行时间**：2026-06-27（scheduled task 自动跑）
- **被测分支**：`feat/mobile-ios-ddns`（HEAD 仍为 `64d288a`，与 06-23 / 06-25 / 06-26 同一 commit，已连续 4 天无任何新提交）
- **被测项目**：`/tmp/jarvis-servlet-test`（`HelloServlet` + `EchoServlet` + `web.xml`，仍无 Maven/Gradle；`EchoServlet.java:7` 的 `TODO(jarvis):` 仍在）
- **本次目的**：
  1. **回归确认** 06-25 / 06-26 报告里的 P0 / P1 是否在 1 天间被修复（预期：未修，HEAD 未动）
  2. **勘误** 06-26 报告里的 1 处错记（`dimensions` 的具体 key 列表）
  3. **新发现**：相同的 `acceptance_policy / workflow_id / assignee_id / verification_plan` 透传缺口 **POST 路径也同样掉字段**——06-25/06-26 只测了 PATCH
- **运行约束**：与前三次一致——`JARVIS_WORK_MODE=off`、stub LLM key、`JARVIS_PERMISSION_MODE=bypass`

---

## 0. TL;DR — 与 06-26 的差异

| 项 | 06-26 状态 | 06-27 状态 | 变化 |
| --- | --- | --- | --- |
| `git log --since=2026-06-26` | 0 commit | **0 commit**（HEAD 仍 `64d288a`） | 静默第 4 天 |
| 522 条 `@jarvis/server` 单测 | 522/522 ✅ | **522/522 ✅**（duration 7.75 s） | 持平 |
| P1-A `acceptance_policy / workflow_id / assignee_id` PATCH 透传 | 仍静默丢弃 | **仍静默丢弃** | ❌ 未修 |
| **P1-A* POST 路径透传**（**新测点**） | 未单独测过 | **同样静默丢弃**——`POST /v1/projects/:id/requirements` 即便 body 带这些字段，响应里也全部缺席 | ⚠️ 缺口比 06-25/06-26 描述的更广 |
| P1-B `POST /v1/roadmap/import` | 仍 404 | **仍 404** | ❌ 未修 |
| `GET /v1/requirements/:id` | 06-26 勘误：不存在 | **仍 404**（无此路由） | ❌ 未补 |
| Orphan 行：`POST /v1/projects/no-such-project-id/requirements` | 201 + `project_id` 原样写回 | **201 + `project_id` 原样写回**，且 `GET /v1/projects/no-such-project-id/requirements` 200 返回该行 | 06-26 复现 |
| 06-26 §2 / §4.3 "dimensions list len=4: `task_understanding / planning_execution / tool_use / verification`" | 文档化 | **勘误：实际 keys 是 `task_understanding / planning_execution / capability_invocation / task_delivery`** | 06-26 keys 错记 |

代码侧两个 deferred 标记仍在原位，确认是显式延期不是遗忘：
- `packages/server/src/requirements-routes.ts:147-167` 的 `CreateBody` / `UpdateBody` 注释明确写 `verification_plan / workflow_id` 出 scope；`acceptance_policy / assignee_id` 连注释都没。
- `packages/tools/src/register-builtins.ts:13` 的"未移植清单"注释（含 `roadmap.import`）仍在原位。

---

## 1. 测试配置（与 06-26 完全一致）

```
OPENAI_API_KEY=sk-stub-for-automation-test
JARVIS_PROVIDER=openai
JARVIS_MODEL=gpt-4o-mini
JARVIS_FS_ROOT=/tmp/jarvis-servlet-test
JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db   # 先 rm -rf 清干净
JARVIS_ADDR=127.0.0.1:7099
JARVIS_WORK_MODE=off
JARVIS_PERMISSION_MODE=bypass
JARVIS_NO_PROJECT_CONTEXT=1
```

启动日志：
```
[jarvis] persistence connected: json:///tmp/jarvis-servlet-test-db
[jarvis] serve: provider=openai model=gpt-4o-mini addr=127.0.0.1:7099 fsRoot=/tmp/jarvis-servlet-test coding=false auth=none ddns=off mdns=off promptBytes=263
[jarvis] listening on http://127.0.0.1:7099
```

`/v1/server/info`：`tools=44`、`project_store=true`、`persistence=json://…`、`approval_mode=bypass`、`max_iterations=80`、`coding_mode=false`、`workspace_root=/tmp/jarvis-servlet-test`、`memory.budget_tokens=108000`。

工具集（44 条，与 06-26 持平）：

```
ask.text, code.grep, doc.{create,delete,draft.get,draft.save,get,list,search,update,upsert},
echo, exit_plan, fs.{find,list,read}, git.{diff,log,show,status}, http.fetch,
memory.{delete,include_add,include_list,include_refresh,include_remove,list,read,write},
plan.update, project.checks, requirement.{block,complete,create,delete,list,start,update},
subagent.{batch,read_doc,review}, time.now, triage.scan_candidates, workspace.context
```

注意：`project.checks` / `triage.scan_candidates` **只作为 agent 工具存在**（无对应 REST），所以在 stub LLM 模式下今天仍没法实测——只能 round-trip 到下一次有 key 的复测。

## 2. 6 步迭代轨迹（实测，全新 DB）

| 步 | 操作 | overall_score | confidence | sample_count | req_runs |
| --- | --- | --- | --- | --- | --- |
| 1 | 4 个需求建好（HelloServlet / Maven / EchoServlet / Smoke），**未 mint run** | 50 | 0.000 | 0 | 0 |
| 2 | `POST :hello/runs` | 47 | 0.066 | 1 | 1 |
| 3 | PATCH hello → in_progress | 47 | 0.066 | 1 | 1 |
| 4 | `POST :echo/runs` + `POST :maven/runs` | 47 | 0.131 | 3 | 3 |
| 5 | PATCH hello → review → done | 47 | 0.131 | 3 | 3 |
| 6 | PATCH echo → in_progress → review → done | 47 | 0.131 | 3 | 3 |

`/v1/diagnostics/runs/stuck?threshold_seconds=1` → 3 条 `pending`（`age_seconds≈26→149`），就是这 3 个 mint 出来又没人跑的 run。

`/v1/work/overview`（窗口 7 天，今日切片）：

```jsonc
{
  "requirement_status_counts": { "backlog": 1, "in_progress": 1, "review": 0, "done": 2 },
  "throughput_today":          { "date": "2026-06-26", "runs_started": 3, "runs_completed": 0,
                                  "runs_failed": 0, "requirements_completed": 2 },
  "keys": ["as_of","since","window_days","missing_stores","truncated","blocked_truncated",
           "requirement_status_counts","running_now","blocked_requirements","run_status_counts",
           "verification_pass_rate","recent_failures","throughput_by_day",
           "project_leaderboard","actor_breakdown"]
}
```

`/v1/observability/health` 最终切片（3 runs）：

```
overall_score=47  confidence=0.131  sample_count=3  primary_focus=planning_execution
sources:        observability {configured: false, rows: 0}
                evals         {configured: false, rows: 0}
                requirement_runs {configured: true, rows: 3}
dimensions:     list len=4
                keys=[task_understanding, planning_execution, capability_invocation, task_delivery]
actions:        list len=5
signals:        requirement_runs=3; observed/agent/tool/subagent/eval = 0
                terminal/completed/failed/verified = 0; all *_rate = null
```

**迭代判断（与 06-25/06-26 一致）**：所有"在 kanban 上拖拽"的操作都会被记成新的 Activity 行，但 **不会写新的 `RequirementRun`**，所以 `confidence` 不动；只有 `POST :id/runs` 会拉动样本数。前端在 `confidence < 0.2` 时若直接展示 `overall_score=47`，会把"完全没数据"的 cold-start 错误传达成"健康差"——P0 仍未修。

> **06-26 报告勘误**：原文表格 §2 说 `dimensions` keys 是 `task_understanding / planning_execution / tool_use / verification`。实测 **keys 是 `task_understanding / planning_execution / capability_invocation / task_delivery`**——见 `packages/server/src/observability-routes.ts:1034,1076,1133,1186` 四处定义点。06-26 漏抓了这条，今天补回。`tool_use` / `verification` 是其他子结构里的字段名（比如 `signals.verification_passed`），不是顶层维度键。

## 3. P1 项回归（仍未修）

### 3.1 `acceptance_policy / workflow_id / assignee_id` REST 透传 — POST 同样掉字段

06-25 / 06-26 都只验证了 PATCH 路径。本次额外测了 POST，结果一样：

```
POST /v1/projects/<pid>/requirements
  body: {"title":"policy-probe","triage_state":"approved",
         "acceptance_policy":"Human","workflow_id":"wf-test","assignee_id":"agent-x"}
→ 201 {"id":"...","title":"policy-probe","status":"backlog", ...}
  acceptance_policy: <absent>
  workflow_id:       <absent>
  assignee_id:       <absent>
```

`packages/server/src/requirements-routes.ts:147-154` 的 `CreateBody` interface 显式只列 `title / description / status / triage_state / depends_on / label_ids`——这 3 个字段连读都不读。同一个 `:439` 在 `/runs` POST 时确实会读 `item.acceptance_policy ?? "subagent"` 决定要不要给 Human policy 行兜底为 409（"complete manually"），但 **既然 create / update 全部丢字段，整条数据链路里 `item.acceptance_policy` 永远是 `undefined`**——Human policy 行为在 REST 路径下**实际触发不到**，只能靠手工写 JSON store 文件构造。

`verification_plan` 同样在 POST/PATCH 都被吞——`packages/server/src/requirements-routes.ts:164-166` 注释明确写 "out of scope for this port"。

**影响升级（vs 06-25/06-26）**：原报告里"PATCH 把字段静默丢弃"的描述其实是子集；完整事实是 **`acceptance_policy / workflow_id / assignee_id / verification_plan` 这 4 个字段，无论 create 还是 update，都进不去 store**。这等于把 06-26 P1 抬升成"整条 wire shape 与 domain model 脱节"——任何 SDK 客户端都无法用 REST 配出 Human policy / workflow 绑定的 requirement。

### 3.2 `roadmap.import` — 仍 404

```
POST /v1/roadmap/import → 404 {"message":"Route POST:/v1/roadmap/import not found"}
```

`packages/tools/src/register-builtins.ts:13` 的"未移植清单"注释仍在原位。**CLAUDE.md 路由清单与运行时仍不一致**（CLAUDE.md 写着 `/v1/roadmap/import` 是健康的）——建议要么补 `(deferred)` 标记，要么把工具 + REST 补齐。06-23 / 06-25 / 06-26 / 06-27 累计 4 次报告同条目。

### 3.3 `GET /v1/requirements/:id` — 仍不存在

```
GET /v1/requirements/<any-id> → 404 {"message":"Route GET:/v1/requirements/<id> not found"}
```

`packages/server/src/requirements-routes.ts` 的 17 条路由（POST/PATCH/DELETE/`/runs` / `/approve` / `/reject` / `/review` 等）里**仍然没有任何"按 id 单查"** 的入口。结合 §3.4 的 orphan 行问题，这是一条只剩"扫 JSON store 文件"才能可观察的盲区。

### 3.4 Orphan 行 — project_id 仍可任意写

```
POST /v1/projects/no-such-project-id/requirements  body={"title":"orphan-test","triage_state":"approved"}
→ 201 {"id":"...","project_id":"no-such-project-id", ...}

GET /v1/projects/no-such-project-id/requirements
→ 200 {"project_id":"no-such-project-id","items":[{...orphan row...}]}
```

实测可以通过把 bogus 路径里的 project id 再 GET 回去把行捞出来——但前提是客户端**记得**那个 bogus id。`requirements-routes.ts:206` 仍没有 `projectStore.get(projectId)` 校验。combined fix 仍是 06-26 §4.1 的方案：①POST/PATCH 增加 project_id 存在性校验；②新增 `GET /v1/requirements/:id`。

## 4. 06-26 报告勘误

### 4.1 `dimensions` keys 错记

06-26 报告表格 §2 末尾：

> `dimensions: list len=4 (task_understanding / planning_execution / tool_use / verification)`

实测响应（与 `packages/server/src/observability-routes.ts` 的代码定义一致）：

```jsonc
"dimensions": [
  { "key": "task_understanding",     "score": 50, "confidence": 0.081, "drivers": [...] },
  { "key": "planning_execution",     "score": 38, "confidence": 0.222, "drivers": [...] },
  { "key": "capability_invocation",  "score": ..., "confidence": ..., "drivers": [...] },
  { "key": "task_delivery",          "score": ..., "confidence": ..., "drivers": [...] }
]
```

`tool_use` / `verification` 在 06-26 报告里写到顶层 key，是混淆：

- `signals.verification_passed` / `signals.verified_requirement_runs` 是 `signals` 子字段；
- "tool" 字样只出现在 `signals.tool_runs` / `signals.tool_success_rate`；
- 顶层 `dimensions` 的第 3、4 维实际命名是 `capability_invocation`（"调用什么工具去做"）和 `task_delivery`（"是否真把活儿交付了"）。

合并建议：把 `dimensions` keys + `signals` 完整字段一次性 codify 到 `docs/conventions/` 或 CLAUDE.md 的 `/v1/observability/health` 路由段，避免 4 次连续报告里都要重新捏一遍 wire shape。

### 4.2 其他 06-26 勘误段（§4.2 / §4.3）仍成立

- `POST /v1/requirements/:id/runs` 的响应顶层是 `{run, conversation_id, manifest_summary, requirement}`，**无顶层 `run_id`**（取 id 走 `run.id`）。✅ 复现
- `/v1/observability/health.dimensions` 是 list（不是 dict）。✅ 复现
- `signals.requirement_runs` 是 int 计数（这次=3）。✅ 复现
- `sources.*` 是 `{configured, rows}` 对象。✅ 复现
- `/v1/diagnostics/runs/stuck` 返回 `{items:[...]}`，每条带 `age_seconds`。✅ 复现
- `/v1/diagnostics/runs/recent` 返回 `{items:[...]}`。✅ 复现（06-26 漏记 shape，今天补）

## 5. 单测健康

```
$ pnpm --filter @jarvis/server test
...
# tests 522
# pass 522
# fail 0
# duration_ms 7746.981458
```

522/522 全绿。

## 6. 合并建议优先级（06-23 → 06-25 → 06-26 → 06-27）

| 优先级 | 项 | 文件/位置 | 累计状态 |
| --- | --- | --- | --- |
| **P0** | Web UI 在 `confidence < 0.2` 时把 `overall_score` 替换成"样本不足"——cold-start 与全面崩盘的同 score 必须前端兜底 | `apps/jarvis-web/src/components/Observability/...` | 06-25 抬升，**4 天未修** |
| **P1（升级）** | `requirements-routes.ts` create **和** patch 都加 `acceptance_policy / workflow_id / assignee_id / verification_plan` 透传 + 单测；同步 `requirement.create` 工具 | `:147-167`、`:206`、`:255` + `packages/tools/src/requirement-tools.ts` | 06-23 提出（只 PATCH）；06-27 发现 POST 同样掉字段——抬升为"整条 wire shape 与 domain 脱节" |
| P1 | `roadmap.import` 工具 + REST 移植；或在 CLAUDE.md 显式标记 deferred | `packages/tools/src/`、`CLAUDE.md` | 06-23 提出，4 天未修 |
| P1 | requirements create/patch 加 project_id 存在性校验 → 404；**同时新增 `GET /v1/requirements/:id`**（直接 `store.get(id)`）。两件事一起做才能完整修掉 orphan 行的不可观察性 | `:206`、`:255`，新增 `:?` | 06-25 P2 → 06-26 升级 → 06-27 复现 |
| P2 | `/v1/observability/health` / `runs/*` / `/v1/requirements/:id/runs` 的 wire shape 文档化（`dimensions: list len=4` keys=`task_understanding/planning_execution/capability_invocation/task_delivery`；`signals.* int + *_rate null when no data`；`sources.* {configured, rows}`；`runs/:id mint` 返回 `{run, conversation_id, manifest_summary, requirement}` 无顶层 `run_id`；`runs/recent`/`runs/stuck` 都返回 `{items:[...]}`） | `docs/conventions/` 或 CLAUDE.md | 06-23 漏记，06-26 部分补，06-27 补 `dimensions` keys |
| P3 | `runs/stuck` 默认 `threshold_seconds` 在 CLAUDE.md 路由清单里补一行；统一所有 diagnostics 路由都返回 `items[]` 的 contract 说明 | `CLAUDE.md` | 06-23 提出，未修 |
| P3 | `ObservabilityStore` / `EvalStore` 的 env-driven 拉起方式在 CLAUDE.md 文档化 | `CLAUDE.md` | 06-23 提出，未修 |
| P3 | `POST /v1/projects` 必填 `instructions` 在 CLAUDE.md / 路由清单里显式注明（任何 SDK 客户端冷启动都会被 400 卡住） | `CLAUDE.md` 项目段 | 06-26 新增，未修 |

## 7. 复测剧本（有 LLM key 时；与 06-26 §7 一致）

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
# 同 §2 的 6 步 → 等 2-3 个 tick →
#   /v1/diagnostics/runs/recent 应出现 completed/failed；
#   /v1/observability/health 应 confidence>0.2 + completion_rate 非 null；
#   sample_count 应从 3 上升到 5+ (LLM 驱动后会写 RequirementRun 终态)。
```

未验证项（继续滚到下一次）：

- `subagent.review` 在 `Subagent` policy 下是否真把 review→done flip（需 `JARVIS_REVIEWER_AUTO_ACCEPT=1`）。
- `triage.scan_candidates` 能否把 `EchoServlet.java:7` 的 `TODO(jarvis): support POST body echo with content-length cap` 自动建成 `ProposedByScan` 需求（**`triage.scan_candidates` 只有 agent 工具，无 REST**——必须有 LLM key 才能驱动）。
- `project.checks` 能否识别"缺少 Maven/Gradle"并建议 `mvn archetype:generate` 或 `gradle init`（同样 agent-only）。

## 8. 总览

| 项 | 评分 | 与 06-26 比 |
| --- | --- | --- |
| Kanban (Project + Requirement CRUD + 状态转换 + Activity 时间线) | ✅ 健康 | 持平 |
| Diagnostics (`/v1/diagnostics/*`、`/v1/work/*`) | ✅ 健康 | 持平 |
| Harness.health 算法实装 | ✅ 健康 | 持平 |
| Harness.health 信号采集 | ⚠️ 缺 LLM 驱动时无信号 | 持平 |
| Harness.health 前端表达 | ❌ confidence 低分仍直接展示 score | 持平（P0 仍未修） |
| REST ↔ 数据模型一致性 | ❌ `acceptance_policy / workflow_id / assignee_id / verification_plan` POST + PATCH 双双丢；project_id 无 FK；无 `GET /v1/requirements/:id` | 06-27 在 06-26 基础上**再扩大一倍**——POST 同样掉字段 |
| 文档 ↔ 运行时一致性 | ⚠️ `roadmap.import` 文档存在但运行时 404；health 顶层 `dimensions` keys 未文档化（连诊断报告自己都写错一次） | 持平 |
| 单测覆盖 | ✅ 522/522 全绿 | 持平 |
| 自动化的端到端验证（有 LLM key） | ❌ 本次仍未执行 | 持平 |

**总体判断**：HEAD 在 06-23 → 06-27 四天内没动，所以 06-26 的所有结论原样成立；本次的实际增量价值是 **(1)** 把 06-25/06-26 一直在测的"PATCH 透传缺口"补成"POST + PATCH 双侧都掉字段"——`acceptance_policy / workflow_id / assignee_id / verification_plan` 在 wire shape 上**完全失联**；**(2)** 勘误 06-26 §2 的 `dimensions` keys（实际是 `task_understanding / planning_execution / capability_invocation / task_delivery`，不是 06-26 写的 `tool_use / verification`）。建议在下一次合 P1 修复时**同时**做：①create + patch 透传 4 字段；②`projectStore.get(projectId)` 校验；③新增 `GET /v1/requirements/:id`；④把 health/runs/`requirements/:id/runs` 的完整 wire shape 一次性 codify 到 `docs/conventions/` 或 CLAUDE.md，省得第 5 次复测又要重新数字段。
