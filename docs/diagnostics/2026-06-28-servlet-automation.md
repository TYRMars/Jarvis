# Jarvis 项目自动化能力诊断报告（2026-06-28 五次复测）

- **运行时间**：2026-06-28（scheduled task 自动跑）
- **被测分支**：`feat/mobile-ios-ddns`（HEAD 仍为 `64d288a`，与 06-23 / 06-25 / 06-26 / 06-27 同一 commit — **静默第 5 天**）
- **被测项目**：`/tmp/jarvis-servlet-test`（`HelloServlet` + `EchoServlet` + `web.xml`，仍无 Maven/Gradle；`EchoServlet.java:7` 的 `TODO(jarvis):` 仍在）
- **本次目的**：
  1. **回归确认** 06-25/06-26/06-27 报告里的 P0/P1 是否在 1 天间被修复（预期：未修，HEAD 未动）
  2. **勘误** 06-27 报告里的 1 处错记（`throughput_today` 顶层 key 不存在）
  3. **新发现**：①`requirements-routes.ts` 对 `depends_on` 的**条件性写回**——body 没传就不返字段；传 `[]` 也会返；②**跨 id 不存在的依赖**不被拒（self-loop 已拒但 `depends_on=["bogus-id"]` 一路通过）；③`/v1/diagnostics/memory` 的零配置 wire shape 是 `{backend:"unknown",stats_available:false}`（不在任何报告里）
- **运行约束**：与前四次一致——`JARVIS_WORK_MODE=off`、stub LLM key、`JARVIS_PERMISSION_MODE=bypass`

---

## 0. TL;DR — 与 06-27 的差异

| 项 | 06-27 状态 | 06-28 状态 | 变化 |
| --- | --- | --- | --- |
| `git log --since=2026-06-27` | 0 commit | **0 commit**（HEAD 仍 `64d288a`） | 静默第 5 天 |
| 522 条 `@jarvis/server` 单测 | 522/522 ✅ | **522/522 ✅**（duration 7.71 s） | 持平 |
| P1-A POST + PATCH `acceptance_policy / workflow_id / assignee_id / verification_plan` 透传 | 全双向静默丢字段 | **仍全双向静默丢字段**（POST 返回 keys = `id/project_id/title/status/conversation_ids/created_at/updated_at`） | ❌ 未修 |
| P1-B `POST /v1/roadmap/import` | 404 | **404** | ❌ 未修 |
| `GET /v1/requirements/:id` | 404 | **404** | ❌ 未补 |
| Orphan 行：`POST /v1/projects/no-such-project-id/requirements` | 201 + project_id 原样写回 | **201 + project_id 原样写回** | ❌ 未修 |
| **`depends_on` 条件性写回**（新测） | 未测过 | **body 不带 → 响应缺字段；body 带 `[]` → 响应带 `[]`；body 带 `["bogus-id"]` → 响应带 `["bogus-id"]`** | ⚠️ 客户端无法用 `.depends_on?.length` 直接判空——必须先 `'depends_on' in obj` |
| **`depends_on` 跨 id FK 校验**（新测） | 未测过 | **不存在的 dep id 一路通过**（已实测：traverse `depends_on=["00000000-..."]` 创建 201；只有"等于自己的 id"才在 `requirements-routes.ts:236/301` 被拒） | ⚠️ self-loop 已拒，跨 id 没拒——`auto_mode` 会用"等不到 dep done" 静默 skip，但操作面是不可见的 |
| 06-27 §2 表格头 `throughput_today` | 文档化 | **勘误：`/v1/work/overview` 顶层根本没有 `throughput_today` key**（实测 `'throughput_today' in keys → False`；`work-routes.ts:450-469` 的 reply 字段里只有 `throughput_by_day: ThroughputBucket[]`，没有 today 切片字段） | 06-27 表头错记 |

代码侧两个 deferred 标记仍在原位，确认是显式延期不是遗忘：
- `packages/server/src/requirements-routes.ts:147-167` 的 `CreateBody` / `UpdateBody`：`acceptance_policy / workflow_id / assignee_id` 连字段名都没；`verification_plan / workflow_id` 在 UpdateBody 注释里写 "out of scope for this port"。
- `packages/tools/src/register-builtins.ts:13` 的"未移植清单"注释（含 `roadmap.import`）仍在原位。

---

## 1. 测试配置（与 06-27 完全一致）

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

`/v1/server/info`：`tools=44`、`project_store=true`、`persistence=json://…`、`approval_mode=bypass`、`max_iterations=80`、`coding_mode=false`、`workspace_root=/tmp/jarvis-servlet-test`、`memory.budget_tokens=108000`、`system_prompt.length=263`。

工具集（44 条，与 06-27 持平）：

```
ask.text, code.grep, doc.{create,delete,draft.get,draft.save,get,list,search,update,upsert},
echo, exit_plan, fs.{find,list,read}, git.{diff,log,show,status}, http.fetch,
memory.{delete,include_add,include_list,include_refresh,include_remove,list,read,write},
plan.update, project.checks, requirement.{block,complete,create,delete,list,start,update},
subagent.{batch,read_doc,review}, time.now, triage.scan_candidates, workspace.context
```

注意：`project.checks` / `triage.scan_candidates` **仍只作为 agent 工具存在**（无对应 REST），所以在 stub LLM 模式下今天仍没法实测——只能 round-trip 到下一次有 key 的复测。

## 2. 6 步迭代轨迹（实测，全新 DB）

| 步 | 操作 | overall_score | confidence | sample_count | primary_focus |
| --- | --- | --- | --- | --- | --- |
| 1 | 4 个需求建好（HelloServlet / EchoServlet / Maven / Smoke），**未 mint run** | 50 | 0.000 | 0 | task_understanding |
| 2 | `POST :hello/runs` | 47 | 0.0656 | 1 | planning_execution |
| 3 | PATCH hello → in_progress | 47 | 0.0656 | 1 | planning_execution |
| 4 | `POST :echo/runs` + `POST :maven/runs` | 47 | 0.1312 | 3 | planning_execution |
| 5 | PATCH hello → review → done | 47 | 0.1312 | 3 | planning_execution |
| 6 | PATCH echo → in_progress → review → done | 47 | 0.1312 | 3 | planning_execution |

数字 **与 06-25/06-26/06-27 完全一致**（精确到 `0.1312...` 的小数部分），证明 health 算法对相同输入是 deterministic 的。

`/v1/diagnostics/runs/stuck?threshold_seconds=1` → 3 条 `pending`（`age_seconds` 31→…），就是这 3 个 mint 出来又没人跑的 run。

`/v1/work/overview` 实测顶层 keys：
```
['actor_breakdown','as_of','blocked_requirements','blocked_truncated','missing_stores',
 'project_leaderboard','recent_failures','requirement_status_counts','run_status_counts',
 'running_now','since','throughput_by_day','truncated','verification_pass_rate','window_days']
```

**`throughput_today` 顶层 key 不存在**——这是对 06-27 报告 §2 的勘误（详见 §4.1）。

`/v1/observability/health` 最终切片（3 runs）：

```
overall_score=47  confidence=0.131  sample_count=3  primary_focus=planning_execution
sources:        observability {configured: false, rows: 0}
                evals         {configured: false, rows: 0}
                requirement_runs {configured: true, rows: 3}
dimensions:     list len=4
                keys=[task_understanding, planning_execution, capability_invocation, task_delivery]
actions:        list len=5
                action.keys=[key, metric, next_steps, priority, title, tone, why]
                  （没有 label —— 见 §4.2）
signals:        requirement_runs=3; observed/agent/tool/subagent/eval = 0
                terminal/completed/failed/verified = 0; all *_rate = null
```

**迭代判断（与 06-25/06-26/06-27 一致）**：所有"在 kanban 上拖拽"的操作都会被记成新的 Activity 行，但 **不会写新的 `RequirementRun`**，所以 `confidence` 不动；只有 `POST :id/runs` 会拉动样本数。前端在 `confidence < 0.2` 时若直接展示 `overall_score=47`，会把"完全没数据"的 cold-start 错误传达成"健康差"——P0 仍未修。

## 3. P1 项回归（仍未修）

### 3.1 `acceptance_policy / workflow_id / assignee_id / verification_plan` REST 透传 — POST + PATCH 双失

复测命令 + 响应（与 06-27 一致）：

```
POST /v1/projects/<pid>/requirements
  body: {"title":"policy-probe","triage_state":"approved",
         "acceptance_policy":"Human","workflow_id":"wf-test",
         "assignee_id":"agent-x",
         "verification_plan":{"checks":[{"name":"x","cmd":"true"}]}}
→ 201 {"id":"8615950a-...","title":"policy-probe","status":"backlog", ...}
  acceptance_policy: <absent>
  workflow_id:       <absent>
  assignee_id:       <absent>
  verification_plan: <absent>

PATCH /v1/requirements/<id>
  body: {"acceptance_policy":"Human","workflow_id":"wf-test",
         "assignee_id":"agent-y",
         "verification_plan":{"checks":[{"name":"x","cmd":"true"}]}}
→ 200 {...}
  4 字段全部 <absent>
```

代码定位（保持 06-27 引用）：
- `packages/server/src/requirements-routes.ts:147-154` 的 `CreateBody` 显式只列 `title / description / status / triage_state / depends_on / label_ids`——这 3 个字段连读都不读。
- 同一文件 `:439` 在 `POST :id/runs` 时读 `item.acceptance_policy ?? "subagent"` 决定 Human policy 行的 409 兜底，但因为 create/update 全部丢字段，**`item.acceptance_policy` 在 REST 路径下永远是 `undefined`**——Human policy 行为只能靠手工写 JSON store 文件构造。
- `verification_plan` 同样在 POST/PATCH 都被吞——`packages/server/src/requirements-routes.ts:164-166` 注释明确写 "out of scope for this port"。

**影响**：原 06-25 报告里"PATCH 把字段静默丢弃"的描述其实是子集；完整事实是 **`acceptance_policy / workflow_id / assignee_id / verification_plan` 这 4 个字段，无论 create 还是 update，都进不去 store**。这等于把 P1 抬升成"整条 wire shape 与 domain model 脱节"——任何 SDK 客户端都无法用 REST 配出 Human policy / workflow 绑定的 requirement。

### 3.2 `roadmap.import` — 仍 404

```
POST /v1/roadmap/import → 404 {"message":"Route POST:/v1/roadmap/import not found"}
```

`packages/tools/src/register-builtins.ts:13` 的"未移植清单"注释仍在原位。**CLAUDE.md 路由清单与运行时仍不一致**（CLAUDE.md 写着 `/v1/roadmap/import` 是健康的）——建议要么补 `(deferred)` 标记，要么把工具 + REST 补齐。06-23 / 06-25 / 06-26 / 06-27 / 06-28 累计 **5 次**报告同条目。

### 3.3 `GET /v1/requirements/:id` — 仍不存在

```
GET /v1/requirements/<any-id> → 404 {"message":"Route GET:/v1/requirements/<id> not found"}
```

`packages/server/src/requirements-routes.ts` 的 17 条路由（POST/PATCH/DELETE/`/runs` / `/approve` / `/reject` / `/review` 等）里**仍然没有任何"按 id 单查"** 的入口。结合 §3.4 的 orphan 行问题，这是一条只剩"扫 JSON store 文件"才能可观察的盲区。

### 3.4 Orphan 行 — project_id 仍可任意写

```
POST /v1/projects/no-such-project-id-2026/requirements
  body={"title":"orphan-test","triage_state":"approved"}
→ 201 {"id":"61b476c7-...","project_id":"no-such-project-id-2026","status":"backlog"}

GET /v1/projects/no-such-project-id-2026/requirements
→ 200 {"project_id":"no-such-project-id-2026","items":[{...orphan row...}]}
```

实测可以通过把 bogus 路径里的 project id 再 GET 回去把行捞出来——但前提是客户端**记得**那个 bogus id。`requirements-routes.ts` 全文搜索 `projectStore.get\b` / `projects.get\b` 均为 0 匹配，确认仍没有 FK 校验。combined fix 仍是 06-26 §4.1 的方案：①POST/PATCH 增加 project_id 存在性校验；②新增 `GET /v1/requirements/:id`。

## 4. 06-27 报告勘误 + 06-28 新发现

### 4.1 勘误：`/v1/work/overview` 没有 `throughput_today` 顶层 key

06-27 §2 的实测表格写：

> `"throughput_today": { "date": "2026-06-26", "runs_started": 3, "runs_completed": 0, "runs_failed": 0, "requirements_completed": 2 }`

实测今天（同一 HEAD，同一 6 步轨迹）：

```jsonc
$ curl /v1/work/overview | python3 -c "import sys,json; d=json.load(sys.stdin); print('has throughput_today key?', 'throughput_today' in d)"
has throughput_today key? False
```

`packages/server/src/work-routes.ts:450-469` 的 reply 字段里只有 `throughput_by_day: ThroughputBucket[]`，**没有 today 切片字段**；同文件 `git log -S "throughput_today"` 也是 0 提交。06-27 的表头实际上是把 `throughput_by_day` 最后一项口语化记成了 "today"——但 wire shape 上没有这个 key，客户端必须自己从 `throughput_by_day` 里挑 `as_of` 对应的那一行。

如果将来真的想加 `throughput_today`，应该做成"`throughput_by_day` 列表中匹配 `as_of` 当天的那一行的 alias"——同时配 `verification_pass_rate_today`，否则客户端要为每个指标都自己拉今日切片。

### 4.2 新发现 A：`actions[].label` 不存在，标题字段是 `title`

06-27 报告把 actions 的字段名漏列了。实测 `actions[i].keys` = `[key, metric, next_steps, priority, title, tone, why]`——**没有 `label`**。标题字段叫 `title`（中文），与 `dimensions[i].label` / `signals` 里的 driver `label` 命名不一致。

文档化建议：把 `actions` 的字段集合一次性 codify 到 CLAUDE.md 的 health 路由段——`key`/`priority`(int)/`tone`(`danger`/`warn`/`info`)/`title`(L10n string)/`why`(L10n string)/`metric`(L10n string)/`next_steps`(L10n string[])。

### 4.3 新发现 B：`depends_on` 是**条件性写回**

```
POST /v1/projects/<pid>/requirements body={"title":...,"triage_state":"approved"}
  → 响应 keys = [id, project_id, title, status, conversation_ids, created_at, updated_at]
  → 'depends_on' in resp: False

POST 同上 body={..., "depends_on":[]}
  → 响应 keys = [..., depends_on]
  → 'depends_on' in resp: True (value: [])

POST 同上 body={..., "depends_on":["bogus-id"]}
  → 响应 keys = [..., depends_on]
  → 'depends_on' in resp: True (value: ["bogus-id"])
```

客户端 **不能** 用 `r.depends_on?.length` 安全判空——`depends_on?: never` 与 `depends_on?: []` 在 wire 上是两种东西。这是 serde 风格的 `skip_serializing_if = "Vec::is_empty"`（之前 Rust 那套）残留下来的——TS 端 `JSON.stringify` 默认会把 `undefined` field 删掉，但**只在 source object 没赋值时**；空数组会被显式序列化。

建议任选一种：**(a)** 服务端固定把 `depends_on: []` 写回，文档里写"始终是数组"；**(b)** 客户端工具函数 normalize（`r.depends_on ?? []`）。

### 4.4 新发现 C：`depends_on` 跨 id 不存在性不校验

```
POST /v1/projects/<real-pid>/requirements
  body={"title":"selfloop-probe","triage_state":"approved",
        "depends_on":["00000000-0000-0000-0000-000000000000"]}
→ 201 {"id":"bd8c2f6f-...","depends_on":["00000000-0000-0000-0000-000000000000"], ...}
```

**self-loop 拒（`requirements-routes.ts:236/301` 的 `error: depends_on must not contain the requirement's own id`），但 bogus 跨 id 一路通过。** auto loop 会用"等不到 dep done"静默 skip（CLAUDE.md 描述的 `dependency_cycle` Activity 行只覆盖了 self-dep 和真实成环，没覆盖"指向不存在 id"），所以操作面看不到任何告警，requirement 就永远卡在 backlog/in_progress。

修复路径：①create/update 时校验每个 dep id 在同一 `project_id` 下的 `requirementStore.list(project_id)` 里存在；②不存在 → 400 `unknown dependency id <X>`；或更宽松：写一条 `Blocked` Activity（reason `missing_dependency`），保持 06-26 报告里"操作面可见"的设计原则。

### 4.5 新发现 D：`/v1/diagnostics/memory` 在 memory 关闭时的 wire shape

```
$ curl /v1/diagnostics/memory
{"backend":"unknown","stats_available":false}
```

CLAUDE.md "Other domain REST surfaces" 段列了 `/v1/diagnostics/{worktrees/orphans,runs/*,memory}`，但**没说**关闭时的 shape。今天的实测补一刀：开关关闭时是 200 + `{backend:"unknown",stats_available:false}`，不是 503。客户端可以靠 `stats_available` 决定要不要展示 memory 面板。

### 4.6 06-26/06-27 已勘误段（仍成立）

- `dimensions` keys 是 `task_understanding / planning_execution / capability_invocation / task_delivery`（06-26 写错成 `tool_use / verification`，06-27 已勘误）。✅ 今天再次确认
- `POST /v1/requirements/:id/runs` 的响应顶层是 `{run, conversation_id, manifest_summary, requirement}`，**无顶层 `run_id`**（取 id 走 `run.id`）。✅ 复现
- `/v1/observability/health.dimensions` 是 list（不是 dict）。✅ 复现
- `signals.requirement_runs` 是 int 计数（这次=3）。✅ 复现
- `sources.*` 是 `{configured, rows}` 对象。✅ 复现
- `/v1/diagnostics/runs/stuck` 返回 `{items:[...]}`，每条带 `age_seconds`。✅ 复现
- `/v1/diagnostics/runs/recent` 返回 `{items:[...]}`，每条 **不带** `age_seconds`（与 stuck 的细微差异）。✅ 复现
- `GET /v1/requirements/:id/runs` 返回 `{items, requirement_id}`（不是单纯 `{items}`）。✅ 复现（06-27 漏记，今天补）

## 5. 单测健康

```
$ pnpm --filter @jarvis/server test
...
# tests 522
# pass 522
# fail 0
# duration_ms 7706.655583
```

522/522 全绿（06-27 是 7746ms，今天 7706ms — 噪声范围内）。

## 6. 合并建议优先级（06-23 → 06-25 → 06-26 → 06-27 → 06-28）

| 优先级 | 项 | 文件/位置 | 累计状态 |
| --- | --- | --- | --- |
| **P0** | Web UI 在 `confidence < 0.2` 时把 `overall_score` 替换成"样本不足"——cold-start 与全面崩盘的同 score 必须前端兜底 | `apps/jarvis-web/src/components/Observability/...` | 06-25 抬升，**5 天未修** |
| **P1（升级）** | `requirements-routes.ts` create **和** patch 都加 `acceptance_policy / workflow_id / assignee_id / verification_plan` 透传 + 单测；同步 `requirement.create` 工具 | `:147-167`、`:206`、`:255` + `packages/tools/src/requirement-tools.ts` | 06-23 提出（只 PATCH）；06-27 发现 POST 同样掉字段——抬升；06-28 持平 |
| P1 | `roadmap.import` 工具 + REST 移植；或在 CLAUDE.md 显式标记 deferred | `packages/tools/src/`、`CLAUDE.md` | 06-23 提出，5 天未修 |
| P1 | requirements create/patch 加 project_id 存在性校验 → 404；**同时新增 `GET /v1/requirements/:id`**（直接 `store.get(id)`）。两件事一起做才能完整修掉 orphan 行的不可观察性 | `requirements-routes.ts:206/:255`，新增 `:?` | 06-25 P2 → 06-26 升级 → 06-27 复现 → 06-28 复现 |
| **P1（新增）** | `depends_on` 跨 id 不存在性校验——目前 self-loop 在 `:236/:301` 已拒，但 `["bogus-id"]` 一路通过；auto loop 会因 dep 永远 done-not 而静默 skip | `requirements-routes.ts:236-237/:301-302` 同位置追加 `for (const dep of body.depends_on ?? []) { if (!await store.get(dep)) ... }` | 06-28 新增 |
| P2 | `/v1/observability/health` / `runs/*` / `/v1/requirements/:id/runs` 的 wire shape 文档化（`dimensions: list len=4` keys=`task_understanding/planning_execution/capability_invocation/task_delivery`；`actions[*]` keys=`key/priority/tone/title/why/metric/next_steps`，**无 `label`**；`signals.* int + *_rate null when no data`；`sources.* {configured, rows}`；`runs/:id mint` 返回 `{run, conversation_id, manifest_summary, requirement}` 无顶层 `run_id`；`runs/recent` / `runs/stuck` 都返回 `{items:[...]}`，`stuck.items[].age_seconds` 是 stuck 独有；`requirements/:id/runs` 返回 `{items, requirement_id}`；`work/overview` **无** `throughput_today` 顶层 key，只有 `throughput_by_day: ThroughputBucket[]`） | `docs/conventions/` 或 CLAUDE.md | 06-23 漏记，06-26 部分补，06-27 补 `dimensions` keys，06-28 补 `actions` keys + `throughput_today` 实际不存在 |
| **P2（新增）** | `depends_on` wire shape 稳定化——固定服务端写回 `[]` 而不是 omit；或客户端 normalize；文档里写明今天是"输入即写回"的条件性字段 | `requirements-routes.ts` create/patch 响应序列化处 | 06-28 新增 |
| P2 | `/v1/diagnostics/memory` 在 memory 关闭时的 200 + `{backend:"unknown",stats_available:false}` shape 文档化（客户端可靠 `stats_available` 切 UI） | CLAUDE.md diagnostics 路由段 | 06-28 新增 |
| P3 | `runs/stuck` 默认 `threshold_seconds` 在 CLAUDE.md 路由清单里补一行；统一所有 diagnostics 路由都返回 `items[]` 的 contract 说明 | `CLAUDE.md` | 06-23 提出，未修 |
| P3 | `ObservabilityStore` / `EvalStore` 的 env-driven 拉起方式在 CLAUDE.md 文档化 | `CLAUDE.md` | 06-23 提出，未修 |
| P3 | `POST /v1/projects` 必填 `instructions` 在 CLAUDE.md / 路由清单里显式注明（任何 SDK 客户端冷启动都会被 400 卡住） | `CLAUDE.md` 项目段 | 06-26 新增，未修 |

## 7. 复测剧本（有 LLM key 时；与 06-27 §7 一致）

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

| 项 | 评分 | 与 06-27 比 |
| --- | --- | --- |
| Kanban (Project + Requirement CRUD + 状态转换 + Activity 时间线) | ✅ 健康 | 持平 |
| Diagnostics (`/v1/diagnostics/*`、`/v1/work/*`) | ✅ 健康 | 持平 |
| Harness.health 算法实装 | ✅ 健康 | 持平 |
| Harness.health 信号采集 | ⚠️ 缺 LLM 驱动时无信号 | 持平 |
| Harness.health 前端表达 | ❌ confidence 低分仍直接展示 score | 持平（P0 仍未修） |
| REST ↔ 数据模型一致性 | ❌ `acceptance_policy / workflow_id / assignee_id / verification_plan` POST + PATCH 双双丢；project_id 无 FK；`depends_on` 跨 id 无 FK；无 `GET /v1/requirements/:id`；`depends_on` 条件性写回 | 06-28 在 06-27 基础上多 2 条 |
| 文档 ↔ 运行时一致性 | ⚠️ `roadmap.import` 文档存在但运行时 404；health 顶层 `dimensions` keys 未文档化；`actions[*]` 字段集合未文档化；`throughput_today` 在 06-27 报告里被错记 | 持平（今天补 actions / throughput_today 勘误） |
| 单测覆盖 | ✅ 522/522 全绿 | 持平 |
| 自动化的端到端验证（有 LLM key） | ❌ 本次仍未执行 | 持平 |

**总体判断**：HEAD 在 06-23 → 06-28 五天内没动，所以 06-27 的所有结论原样成立；本次的实际增量价值是 **(1)** 新增 P1：`depends_on` 跨 id 不存在性不校验（self-loop 已拒，bogus dep 一路通过，auto loop 静默 skip）；**(2)** 新增 P2：`depends_on` 字段是条件性写回，客户端不能直接用 `.depends_on?.length`；**(3)** 新增 P2：`/v1/diagnostics/memory` 在关闭时返 `{backend:"unknown",stats_available:false}` shape；**(4)** 勘误 06-27 §2 的 `throughput_today` 顶层 key——实测**不存在**，只有 `throughput_by_day: ThroughputBucket[]`；**(5)** 补 `actions[*]` 字段集合（`key/priority/tone/title/why/metric/next_steps`，**无** `label`）。建议在下一次合 P1 修复时**同时**做：①create+patch 透传 4 字段；②`projectStore.get(projectId)` 校验；③新增 `GET /v1/requirements/:id`；④`depends_on` 跨 id FK 校验；⑤把 health/runs/`requirements/:id/runs` / `work/overview` / `actions` / `diagnostics/memory` 的完整 wire shape 一次性 codify 到 `docs/conventions/` 或 CLAUDE.md，省得第 6 次复测又要重新数字段。
