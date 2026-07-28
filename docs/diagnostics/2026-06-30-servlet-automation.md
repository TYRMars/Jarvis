# Jarvis 项目自动化能力诊断报告（2026-06-30 七次复测）

- **运行时间**：2026-06-30（scheduled task 自动跑）
- **被测分支**：`feat/mobile-ios-ddns`（HEAD 仍为 `64d288a`，与 06-23 / 06-25 / 06-26 / 06-27 / 06-28 / 06-29 同一 commit — **静默第 7 天**；工作树侧 iOS + DDNS 改动从 Jun 22 起 25 个文件未 commit，含本次新覆盖的 `packages/server/src/{auth,ddns-routes}.ts` 与 `packages/ddns/`）
- **被测项目**：`/tmp/jarvis-servlet-test`（`HelloServlet` + `EchoServlet`，**无 `web.xml`**——06-29 报告里写的 "+ web.xml" 是误记；`EchoServlet.java:7` 的 `TODO(jarvis): support POST body echo with content-length cap` 仍在）
- **本次目的**：
  1. **回归确认** 06-23 → 06-29 累积 P0/P1 在 1 天间是否被修复（预期：未修，HEAD 未动）
  2. **完成 06-29 §7 未验证项**：`POST /v1/workflows` 创建 + `POST /:id/run` dispatch 全链路（成功覆盖，新增 §4.1）
  3. **补全更多 wire shape**：`/v1/version`、`/v1/remote/info`、`/v1/ddns/status`、`/v1/memory/{sync_status,includes}`、`/v1/agent-profiles`、`/v1/memories`、`/v1/learning/skill-usage`、`/v1/providers`、`/v1/automations`、`/v1/channels`、`/v1/plugins`、`/v1/workspaces`、`/v1/diagnostics/worktrees/orphans`
  4. **修正 06-29 报错**：
     - **`/v1/observability/health.rules` 是 `dict` 不是 `list`**（06-29 §4.5 写 "顶层数组" 错）；`evidence` 是 `list len=0`，不是"顶层结构"
     - **`/v1/subagents` 只返 2 条（`read_doc, review`），不是 06-29 说的 3 条**——`subagent.batch` 是 fan-out 工具，不是 SubAgent 注册表条目（`packages/subagents/src/batch.ts:59`），`SubAgentRegistry` 仅 `read_doc + review`
  5. **新发现 1 个真实 bug**：`POST /v1/workflows` 当 `body.steps` 是非 iterable 非 null（字符串 / 对象）时，validator 链未捕获，**500 `steps.map is not a function`** 泄漏。详 §4.2。
- **运行约束**：与 06-29 一致——`JARVIS_WORK_MODE=off`、stub LLM key、`JARVIS_PERMISSION_MODE=bypass`，DB 用 `json:///tmp/jarvis-servlet-test-db-20260630` 全新路径（避开 `rm -rf` 触发的 auto-mode 保护）

---

## 0. TL;DR — 与 06-29 的差异

| 项 | 06-29 状态 | 06-30 状态 | 变化 |
| --- | --- | --- | --- |
| `git log --since=2026-06-29` | 0 commit | **0 commit**（HEAD 仍 `64d288a`） | 静默第 7 天；工作树侧 25 个文件未 commit（含 iOS + DDNS） |
| 522 条 `@jarvis/server` 单测 | 522/522 ✅（7702 ms） | **522/522 ✅**（7703 ms） | 持平（噪声范围内） |
| P1-A POST + PATCH 4 字段透传 | 全双向静默丢字段 | **仍全双向静默丢字段** | ❌ 未修（第 7 次） |
| P1-B `POST /v1/roadmap/import` | 404 | **404** | ❌ 未修（第 7 次） |
| `GET /v1/requirements/:id` | 404 | **404** | ❌ 未补（第 7 次） |
| Orphan 行 `POST /v1/projects/no-such/requirements` | 201 + 原样回写 | **201 + 原样回写** | ❌ 未修 |
| `depends_on` 跨 id FK | bogus id 一路通过 | **完全复现** | ❌ 未修 |
| `depends_on` 条件性写回 | 入 → 回写，未入 → 缺字段 | **完全复现** | ❌ 未修 |
| `/v1/projects` 列表裸数组 | 与 `{items:[]}` 系不一致 | **完全复现** | ❌ 未修 |
| `confidence < 0.2` 前端兜底 | P0，**6 天未修** | **P0，7 天未修** | 持平 |
| **`POST /v1/workflows` 创建 + dispatch**（06-30 首次完整覆盖） | §7 留白 | **201 / 202 全链路通**，wire shape 入档（§4.1） | ✅ 06-29 §7 未验证项 1/5 落地 |
| **`POST /v1/workflows` 500 泄漏**（06-30 新发现） | 未测过 | `body.steps` 是非 iterable 非 null 时 `steps.map is not a function` 200→500，未被 validator 捕获 | ⚠️ **新增 P1 真 bug**（§4.2） |
| **`PATCH /v1/requirements/:id` 用真实 `workflow_id` 二次验证**（06-30 新测） | 只用占位串测过 | **仍丢字段**（用 `wf-id` 与刚 POST 出来的真 UUID 都丢） | ❌ 第 7 次报告 |
| **`/v1/observability/health.rules` 类型**（06-30 修正） | 06-29 §4.5 写 "顶层数组" | **`dict`**（不是 list） | ⚠️ 06-29 错记 |
| **`/v1/observability/health.evidence` 类型**（06-30 修正） | 06-29 写 "顶层结构" | **`list len=0`** | ⚠️ 06-29 错记 |
| **`/v1/observability/health.dimensions[*]` keys**（06-30 首次枚举） | 未列 | `[confidence, drivers, key, label, score, summary]`——含 `label`（与 `actions[*]` 不含 `label` 形成对比） | ⚠️ 06-30 新入档 |
| **`/v1/subagents` 条数**（06-30 修正） | 06-29 写 "3 条（batch/read_doc/review）" | **2 条（`read_doc, review`）** | ⚠️ 06-29 把 tool surface（含 fan-out 工具）跟 SubAgentRegistry 混了 |
| **`/v1/version`**（06-30 新测） | 未测过 | **200** `{"name":"jarvis","version":"0.2.0"}`；`/v1/health` 是 404、`/health` 是 200（区分根 vs `/v1`） | ⚠️ 06-30 新入档 |
| **`/v1/remote/info`**（06-30 新测；iOS-DDNS 分支专用） | 未测过 | **200** `{device_name, lan_addrs:[2], port:7099, external:{}, requires_auth:false, version:"0.2.0"}` | ⚠️ 06-30 新入档；属未 commit 的 DDNS 工作树代码 |
| **`/v1/ddns/status`**（06-30 新测） | 未测过 | **503** `{error: "DDNS not enabled — set JARVIS_DDNS_ENABLE=1 and restart"}` | ⚠️ 06-30 新入档；路由已挂、默认关 |
| **`/v1/memory/sync_status` + `/v1/memory/includes`**（06-30 新测） | 未测过 | **503** `{error: "memory tools are not enabled — set JARVIS_ENABLE_MEMORY=1 and restart"}` | ⚠️ 06-30 新入档；与 `/v1/diagnostics/memory` 关闭态 200+flag 又是一种口径 |
| **`/v1/agent-profiles / memories / learning/skill-usage / automations / channels / plugins`**（06-30 新测） | 未测过 | **全部 503** `<store> not configured`——错误信息体例彼此一致 | ⚠️ 06-30 新入档 |
| **`/v1/providers`**（06-30 新测） | 未测过 | **200** `{default:"openai", providers:[{name, default_model, models:[], is_default:true, kind:"openai"}]}` | ⚠️ 06-30 新入档 |
| **`/v1/workspaces`**（06-30 新测；非 `/v1/workspace` 单数） | 未测过 | **200** `{workspaces: []}`——**又一种 list shape**（既不是裸数组，也不是 `{items:[]}`） | ⚠️ 06-30 新入档 |
| **`/v1/diagnostics/worktrees/orphans`**（06-30 新测） | 未测过 | **503** `{error: "worktree feature not configured"}` | ⚠️ 06-30 新入档 |
| **`POST /v1/projects` 重名 slug 自动加 `-N` 后缀**（06-30 新测） | 未测过 | `name="servlet-2026-06-30"` 第二次 → `slug="servlet-2026-06-30-2"` 201 OK | ⚠️ 06-30 新入档 |
| **`POST /v1/projects` 显式 `slug` 字段被接受**（06-30 新测） | 未测过 | `{name:"X Y Z", slug:"custom-slug-2026-06-30", ...}` → 201 OK | ⚠️ 06-30 新入档 |

代码侧两个 deferred 标记仍在原位（与 06-23 → 06-29 一致），不再贴：
- `packages/server/src/requirements-routes.ts:147-167` 的 `CreateBody` / `UpdateBody` 注释（实测命中 `:164-166` 的 "out of scope for this port"）。
- `packages/tools/src/register-builtins.ts:13` 的"未移植清单"注释。

---

## 1. 测试配置（仅 DB 路径换日期后缀，其余与 06-29 完全一致）

```
OPENAI_API_KEY=sk-stub-for-automation-test
JARVIS_PROVIDER=openai
JARVIS_MODEL=gpt-4o-mini
JARVIS_FS_ROOT=/tmp/jarvis-servlet-test
JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-20260630    # 日期后缀，避免 rm -rf
JARVIS_ADDR=127.0.0.1:7099
JARVIS_WORK_MODE=off
JARVIS_PERMISSION_MODE=bypass
JARVIS_NO_PROJECT_CONTEXT=1
```

启动日志：
```
[jarvis] persistence connected: json:///tmp/jarvis-servlet-test-db-20260630
[jarvis] serve: provider=openai model=gpt-4o-mini addr=127.0.0.1:7099 fsRoot=/tmp/jarvis-servlet-test coding=false auth=none ddns=off mdns=off promptBytes=263
[jarvis] listening on http://127.0.0.1:7099
```

`/v1/server/info` 与 06-29 完全一致：`tools=44`、`project_store=true`、`persistence=json://…`、`approval_mode=bypass`、`max_iterations=80`、`coding_mode=false`、`workspace_root=/tmp/jarvis-servlet-test`、`memory.budget_tokens=108000`、`system_prompt.length=263`。

工具集（44 条，与 06-29 完全一致）：

```
ask.text, code.grep, doc.{create,delete,draft.get,draft.save,get,list,search,update,upsert},
echo, exit_plan, fs.{find,list,read}, git.{diff,log,show,status}, http.fetch,
memory.{delete,include_add,include_list,include_refresh,include_remove,list,read,write},
plan.update, project.checks, requirement.{block,complete,create,delete,list,start,update},
subagent.{batch,read_doc,review}, time.now, triage.scan_candidates, workspace.context
```

但要注意：**`/v1/subagents` 只返 `read_doc, review` 两条**（详 §4.10 修正）。`project.checks` / `triage.scan_candidates` 仍只作为 agent 工具存在，stub LLM 模式下今天仍没法实测——继续滚到下次有 key 的复测。

---

## 2. 6 步迭代轨迹（实测，全新 DB）

| 步 | 操作 | overall_score | confidence | sample_count | primary_focus |
| --- | --- | --- | --- | --- | --- |
| 1 | 4 个需求建好（hello / echo / maven / smoke），**未 mint run** | 50 | 0.000 | 0 | task_understanding |
| 2 | `POST :hello/runs` | 47 | 0.0656 | 1 | planning_execution |
| 3 | PATCH hello → in_progress | 47 | 0.0656 | 1 | planning_execution |
| 4 | `POST :echo/runs` + `POST :maven/runs` | 47 | 0.13120190627836492 | 3 | planning_execution |
| 5 | PATCH hello → review → done | 47 | 0.13120190627836492 | 3 | planning_execution |
| 6 | PATCH echo → in_progress → review → done | 47 | 0.13120190627836492 | 3 | planning_execution |

数字 **与 06-25 / 06-26 / 06-27 / 06-28 / 06-29 完全一致**（精确到 `0.13120190627836492` 的小数尾部），证明 health 算法对相同输入是 deterministic 的——连续 6 次复测同一切片，可以把这组数字当作"零 LLM 信号下 3 个 pending run"的 canonical fingerprint。

`/v1/diagnostics/runs/stuck?threshold_seconds=1` 返 **3 条 `pending`**（带 `age_seconds`，3 条都是 6 步轨迹里 mint 的 run）。`/v1/diagnostics/runs/recent` 同样 3 条但不带 `age_seconds`——这是 5 次报告确认的 stuck/recent 唯一字段差异。两个路由的 `items[*].logs` 字段都存在且为空数组（06-29 §4.6 确认）。

`/v1/work/overview` 实测顶层 keys（与 06-29 完全一致）：
```
['actor_breakdown','as_of','blocked_requirements','blocked_truncated','missing_stores',
 'project_leaderboard','recent_failures','requirement_status_counts','run_status_counts',
 'running_now','since','throughput_by_day','truncated','verification_pass_rate','window_days']
```

`throughput_by_day` 长度 8，每条 keys=`{date, requirements_completed, runs_completed, runs_failed, runs_started}`。**`throughput_today` 顶层 key 仍然不存在**。`requirement_status_counts` 在 6 步走完 + §4.1 workflow 创建后 = `{backlog:3, in_progress:1, review:0, done:2}`。

`/v1/observability/health` 最终切片（3 runs）：

```
overall_score=47  confidence=0.131  sample_count=3  primary_focus=planning_execution
sources:        observability {configured: false, rows: 0}
                evals         {configured: false, rows: 0}
                requirement_runs {configured: true, rows: 3}
dimensions:     list len=4, dim[*].keys = {confidence, drivers, key, label, score, summary}  ← 06-30 首次枚举
                dimension keys = [task_understanding, planning_execution, capability_invocation, task_delivery]
actions:        list len=5, action[*].keys = {key, metric, next_steps, priority, title, tone, why}（无 label）
signals:        20 keys（详 §4.5）；terminal/completed/failed/verified = 0；所有 *_rate = null
rules:          ★ dict（06-29 错记为 list）
evidence:       ★ list len=0（06-29 错记为 "顶层结构"）
```

**迭代判断（与 06-25 → 06-29 完全一致）**：所有"在 kanban 上拖拽"的操作都会被记成新的 Activity 行，但 **不会写新的 `RequirementRun`**，所以 `confidence` 不动；只有 `POST :id/runs` 会拉动样本数。前端在 `confidence < 0.2` 时若直接展示 `overall_score=47`，会把"完全没数据"的 cold-start 错误传达成"健康差"——P0 仍未修（**7 天连续未修**）。

---

## 3. P1 项回归（仍未修）

### 3.1 `acceptance_policy / workflow_id / assignee_id / verification_plan` REST 透传 — POST + PATCH 双失

```
POST /v1/projects/<pid>/requirements
  body: {"title":"policy-probe","triage_state":"approved",
         "acceptance_policy":"Human","workflow_id":"wf-test",
         "assignee_id":"agent-x",
         "verification_plan":{"checks":[{"name":"x","cmd":"true"}]}}
→ 201 keys=['conversation_ids','created_at','id','project_id','status','title','updated_at']
  4 字段全部 absent

PATCH /v1/requirements/<id> body: 同上
→ 200 keys 同上，4 字段仍全部 absent
```

**06-30 加强**：本次用 `PATCH .../requirements/<smoke_rid> {"workflow_id":"<刚 POST 出来的真 UUID>"}` 二次验证——**响应里依然没有 `workflow_id` 字段**，确认与占位值的行为完全一致，不是"格式不对就吞"的兜底。

代码定位（保持引用）：
- `packages/server/src/requirements-routes.ts:147-154` 的 `CreateBody` 只列 `title / description / status / triage_state / depends_on / label_ids`。
- 同文件 `:439` 在 `POST :id/runs` 时读 `item.acceptance_policy ?? "subagent"`——但因为 create/update 全部丢字段，**Human policy 行的 409 兜底永远不可达**。
- `:164-166` 注释明确写 `out of scope for this port`。

**影响**：与 06-29 一致。**第 7 次报告**。

### 3.2 `roadmap.import` — 仍 404

```
POST /v1/roadmap/import → 404 {"message":"Route POST:/v1/roadmap/import not found"}
```

`packages/tools/src/register-builtins.ts:13` 的"未移植清单"注释仍在原位。CLAUDE.md 路由清单仍写"`/v1/roadmap/import` ✅"——文档 ↔ 运行时不一致。**第 7 次报告**。

### 3.3 `GET /v1/requirements/:id` — 仍不存在

```
GET /v1/requirements/<any-id> → 404 Route not found
```

vs `GET /v1/projects/:id` → 200 OK（详 06-29 §4.1）。半边镜像、半边未补，建议合 P1 时一次性补齐。

### 3.4 Orphan 行 — project_id 仍可任意写

```
POST /v1/projects/no-such-project-2026-06-30/requirements
  body={"title":"orphan","triage_state":"approved"}
→ 201 {"id":"...","project_id":"no-such-project-2026-06-30","status":"backlog",...}

GET /v1/projects/no-such-project-2026-06-30/requirements
→ 200 {"items":[{...orphan row...}]}
```

`requirements-routes.ts` 全文 `projectStore.get` 仍 0 匹配。**第 7 次报告**。

### 3.5 `depends_on` 跨 id FK 校验 — 仍不拒 bogus dep（self-loop 仍拒）

```
POST /v1/projects/<real-pid>/requirements
  body={"title":"dep-c","triage_state":"approved","depends_on":["00000000-..."]}
→ 201 depends_on=["00000000-..."]（一路通过）

PATCH /v1/requirements/<id> body={"depends_on":["<same-id>"]}
→ 400 self-dependency 仍拒
```

`requirements-routes.ts:233/298` 的 self-loop 拒仍有效；跨 id FK 仍缺。auto loop 会用"等不到 dep done"静默 skip。**第 3 次报告**（06-28 / 06-29 / 06-30）。

---

## 4. 06-30 新发现 / 新 wire shape / 06-29 修正

### 4.1 新发现 A：`POST /v1/workflows` 创建 + dispatch 全链路覆盖（06-29 §7 未验证项 1/5 落地）

06-29 §7 留白的"workflows CRUD + run dispatch"今天完整跑通：

**正确 body shape**（top-level `steps[]`，**不是** `definition.steps[]`，**也不是** `kind:"agent"` 这种 enum 字符串形态）：

```json
POST /v1/workflows
{
  "name": "wf-2026-06-30-correct",
  "description": "smoke",
  "steps": [
    { "name": "step1", "kind": { "type": "agent", "prompt": "hello" } }
  ]
}
→ 201 {
  "id": "<uuid>",
  "name": "wf-2026-06-30-correct",
  "description": "smoke",
  "steps": [
    { "id": "<server-minted-uuid>", "name": "step1",
      "kind": { "type": "agent", "prompt": "hello" } }
  ],
  "created_at": "2026-06-29T19:08:55.933Z",
  "updated_at": "2026-06-29T19:08:55.933Z"
}
```

源码：`packages/server/src/workflow-routes.ts:156` `def.steps = normalizeSteps(body.steps ?? [])`——**只读 top-level**。验证器 `validateSteps`（同文件 `:110`）调 `agentStepCount(def)`，要求至少 1 个 `kind.type === "agent"`。

**dispatch**：

```
POST /v1/workflows/<wf_id>/run {}
→ 202 {
  "id": "<run_id>",
  "workflow_id": "<wf_id>",
  "status": "pending",
  "step_results": [],
  "started_at": "..."
}
```

**注意是 202（Accepted）不是 200**——文档化时要写清。

**单 run 查询**：

```
GET /v1/workflow-runs/<run_id>
→ 200 keys=['id', 'started_at', 'status', 'step_results', 'workflow_id']  # 同 dispatch 形状
```

**workflow 全部 runs**：

```
GET /v1/workflows/<wf_id>/runs
→ 200 {"items": [...]}  # {items:[]} 系
```

**bogus id**：

- `POST /v1/workflows/<no-such>/run` → 404 `{"error":"workflow not found"}`
- `POST /v1/workflow-runs/<no-such>/cancel` → 404 `{"error":"workflow run not found"}`

**关联到 requirement**：试图 `PATCH /v1/requirements/<rid> {"workflow_id": "<刚 POST 出的真 UUID>"}`，**响应里仍然无 `workflow_id` 字段**——再次确认 §3.1 的 `workflow_id` 在 REST 路径被吞，无论是占位串还是真 UUID 都没用。这表示当前实现里，**workflow 跟 requirement 在 REST 层完全打不通**——只能在 JSON store 文件里手写 `workflow_id`，再让 auto-loop 跑 `workflow_runtime::drive_workflow` 路径。

### 4.2 新发现 B：`POST /v1/workflows` 当 `body.steps` 是非 iterable 非 null 时 500 泄漏（真 bug，新 P1）

```
POST /v1/workflows {"name":"x","description":"x","steps":"not-a-list"}
→ 500 {"statusCode":500,"error":"Internal Server Error","message":"steps.map is not a function"}

POST /v1/workflows {"name":"x","description":"x","steps":{}}
→ 500 {"statusCode":500,"error":"Internal Server Error","message":"steps.map is not a function"}

POST /v1/workflows {"name":"x","description":"x","steps":null}
→ 400 {"error":"workflow must contain at least one agent step"}  # null 是 OK 的（?? [] 兜住）
```

`packages/server/src/workflow-routes.ts:156`：

```ts
def.steps = normalizeSteps(body.steps ?? []);   // ?? 兜 null/undefined，未兜非数组
```

`normalizeSteps` 直接 `steps.map(...)`，当 `body.steps` 是字符串 / 对象时，`??` 不触发但 `.map` 缺失 → 500。

**Fix 建议**：把 `body.steps ?? []` 换成 `Array.isArray(body.steps) ? body.steps : []`（且失败时返 400 `"steps must be an array"`），与 validator 的 400 路径打齐。同时 `packages/server/src/workflow-routes.test.ts:115` 已经覆盖了空 steps 的 400 路径，补一条非数组 steps 的 400 单测即可。

### 4.3 修正 A：`/v1/observability/health.rules` 是 **dict** 不是 list；`evidence` 是 **list len=0**

06-29 §4.5 列：

> rules:          顶层数组（新发现，详见 §4.5）
> evidence:       顶层结构（新发现，详见 §4.5）

实测：

```
type(h["rules"])    == dict
type(h["evidence"]) == list, len = 0
```

06-29 错记。需要在 wire shape 文档里写正确。`rules` 是 dict（具体 keys 待 LLM 驱动后才能填，stub 模式下空），`evidence` 是 `list[]`（同样空）。

### 4.4 修正 B：`/v1/subagents` 只返 2 条（`read_doc, review`），不是 3 条

06-29 §4.9 写：

> 3 条 subagent（与 `/v1/server/info.tools` 里的 `subagent.{batch,read_doc,review}` 对应）

实测：

```
GET /v1/subagents → 200 {"items":[
  {"name":"read_doc",...,"tool_name":"subagent.read_doc",...},
  {"name":"review",  ...,"tool_name":"subagent.review",  ...}
]}
items_count = 2
```

源码：`packages/subagents/src/batch.ts:59` 定义 `subagent.batch` 是一个**普通 Tool**（fan-out 工具），不是 SubAgent 注册表条目。`packages/server/src/subagents-routes.ts:73-74` 的 `collect(state.subagents)` 只读 `SubAgentRegistry`，里头只有 `read_doc + review`（codex/claude_code 默认未启）。所以：

- `/v1/server/info.tools` 列 3 个 `subagent.*` 工具：✓ 对（含 batch 工具）
- `/v1/subagents` 列 2 个 SubAgent：✓ 对（不含 batch，batch 不是 subagent）

06-29 把这两个 surface 串了。每条 item 实测 keys=`[description, name, parameters, requires_approval, tool_name]`。

### 4.5 `/v1/observability/health` 完整顶层 12 keys + signals 20 keys（持平 06-29 §4.5）

```
top keys (12): [actions, confidence, dimensions, evidence, generated_at,
                overall_score, primary_focus, rules, sample_count, signals,
                sources, tool]

signals keys (20): agent_runs, agent_success_rate, cancelled_requirement_runs,
                   completed_requirement_runs, completion_rate, error_hotspots,
                   eval_cases, eval_pass_rate, failed_requirement_runs,
                   observed_runs, p95_latency_ms, requirement_runs, subagent_runs,
                   subagent_success_rate, terminal_requirement_runs, tool_runs,
                   tool_success_rate, verification_pass_rate, verification_passed,
                   verified_requirement_runs

sources keys: [evals, observability, requirement_runs]
  each: {configured: bool, rows: int}

dimensions: list len=4, dim[*] keys = {confidence, drivers, key, label, score, summary}
   ← 06-30 首次完整枚举；含 `label`（与 `actions[*]` 不含 `label` 形成对比）

actions: list len=5, action[*] keys = {key, metric, next_steps, priority, title, tone, why}
   （无 `label`，仅 `key`/`title`）
```

### 4.6 新发现 C：`/v1/version` 200，`/v1/health` 404，`/health` 200

```
GET /v1/version → 200 {"name":"jarvis","version":"0.2.0"}
GET /v1/health   → 404
GET /health      → 200 {"status":"ok"}
GET /version     → 404
GET /info        → 404
```

健康检查走 `/health`（无 `/v1/` 前缀），版本号走 `/v1/version`——两条 SDK / 负载均衡器最常用的路由分歧、且双向都没文档化。建议在 CLAUDE.md "Other domain REST surfaces" 段补一条 `/health (always 200)` + `/v1/version`。

### 4.7 新发现 D：`/v1/remote/info` wire shape（与 iOS-DDNS 分支强相关）

```
GET /v1/remote/info
→ 200 {
  "device_name": "<os-hostname>",
  "lan_addrs": ["192.168.1.x", "198.18.x.x"],
  "port": 7099,
  "external": {},     # 当 DDNS 关 / 无外部信号时为空对象
  "requires_auth": false,
  "version": "0.2.0"
}
```

这是 iOS app（`apps/jarvis-ios/Sources/Networking/Discovery.swift` 等未 commit 文件）拿来做 bootstrap 的核心字段。`requires_auth` 直接镜像 `JARVIS_ACCESS_TOKEN` 是否设置；`external` 在 DDNS 启用后会带 `{hostname, port, ip}`（详 §4.8）。这是 06-30 首次入档，因 06-23 → 06-29 都没测过这条路由——但代码已经在工作树里写好。

### 4.8 新发现 E：`/v1/ddns/status` 503（路由已挂、默认关）

```
GET /v1/ddns/status → 503 {"error":"DDNS not enabled — set JARVIS_DDNS_ENABLE=1 and restart"}
```

`packages/server/src/ddns-routes.ts`（未 commit，但被 `state.ts` 引用）。错误消息体例对客户端非常友好（直接告诉 SDK 怎么打开）——比 `/v1/diagnostics/memory` 的 200+flag 体例 **更明确**。建议未来扩 DDNS 路由时把 GET/PUT/POST 都打上同样的 503-with-actionable-hint 模板。

### 4.9 新发现 F：`/v1/memory/sync_status` + `/v1/memory/includes` 503（路由已挂、默认关）

```
GET /v1/memory/sync_status → 503 {"error":"memory tools are not enabled — set JARVIS_ENABLE_MEMORY=1 and restart"}
GET /v1/memory/includes    → 503 {"error":"memory tools are not enabled — set JARVIS_ENABLE_MEMORY=1 and restart"}
```

P8.x 提到的 `/v1/memory/sync*` + `/v1/memory/includes*` 路由 **是真的存在**——只是 stub 模式下因 `JARVIS_ENABLE_MEMORY` 未设走 503 兜底。CLAUDE.md 写的 "memoryRuntime 缺失时 503" 对得上。

### 4.10 新发现 G：5 条"未配 store" 路由口径基本一致 503，但内容措辞不齐

```
GET /v1/agent-profiles     → 503 "agent profile store not configured"
GET /v1/memories           → 503 "memory store not configured"
GET /v1/learning/skill-usage → 503 "learning store not configured"
GET /v1/automations        → 503 "automation store not configured"
GET /v1/channels           → 503 "channel-instance store not configured"
GET /v1/plugins            → 503 "plugin manager not configured"
GET /v1/diagnostics/worktrees/orphans → 503 "worktree feature not configured"

# 对比的 200+flag 路由：
GET /v1/diagnostics/memory → 200 {"backend":"unknown","stats_available":false}
```

8 条 "feature 未启" 的路由里：

- **7 条返 503**，错误 body 都是 `{error: "<thing> not configured"}` 或 `<thing> not enabled — set <ENV> and restart`
- **1 条（`/v1/diagnostics/memory`）返 200+flag**

口径不一致问题 06-28 / 06-29 都提过；今天又多了 5 条 503 样本。建议**统一收敛到 503 + actionable hint**（DDNS 路由的写法最优——告诉客户端要设哪个 env），把 `/v1/diagnostics/memory` 也改成 503 + hint。这能让 SDK 写一套通用 503 处理器。

### 4.11 新发现 H：`/v1/providers` wire shape

```
GET /v1/providers → 200 {
  "default": "openai",
  "providers": [
    {"name":"openai", "default_model":"gpt-4o-mini", "models":["gpt-4o","gpt-4o-mini"],
     "is_default": true, "kind":"openai"}
  ]
}
```

每条 provider 5 字段。`models` 数组是 server 启动时探测的（实测含 `gpt-4o` + `gpt-4o-mini` 两条，与 `JARVIS_MODEL` 默认值对齐）。`kind` 与 `name` 形如同——但保留分立是为 Kimi / Ollama 这种"复用 OpenAI wire"的别名（CLAUDE.md provider 矩阵里写过）。

### 4.12 新发现 I：`/v1/workspaces`（复数）= `{workspaces:[]}` shape——又一种 list 体例

```
GET /v1/workspaces → 200 {"workspaces": []}
```

**这是第三种 list 体例**：

| 路由 | 顶层 shape |
| --- | --- |
| `GET /v1/projects` | 裸数组 `[...]` |
| `GET /v1/workflows` / `/v1/subagents` / `/v1/diagnostics/runs/*` / `/v1/skills` 等 | `{"items":[]}` |
| **`GET /v1/workspaces`** | `{"workspaces":[]}` ← 06-30 新发现 |
| `GET /v1/work/overview / quality` | 复合对象（非 list） |

3 种 list 体例并存，未来加分页就有 3 处 breaking 风险。建议：要么趁早全收敛到 `{items:[]}`，要么文档 codify "已知特例"。

### 4.13 新发现 J：`POST /v1/projects` 的 slug 行为

```
# 1) 不传 slug → 从 name 自动派生
POST /v1/projects {"name":"slug-probe-2026-06-30","instructions":"x"}
→ 201 name="slug-probe-2026-06-30" slug="slug-probe-2026-06-30"

# 2) 重名 → slug 自动加 -2 后缀（不报 409 conflict）
POST /v1/projects {"name":"servlet-2026-06-30","instructions":"dup"}
→ 201 name="servlet-2026-06-30" slug="servlet-2026-06-30-2"   # name 重名，slug 自动让

# 3) 显式 slug 字段被接受
POST /v1/projects {"name":"X Y Z 2026-06-30","instructions":"x","slug":"custom-slug-2026-06-30"}
→ 201 name="X Y Z 2026-06-30" slug="custom-slug-2026-06-30"

# 4) 空 name
POST /v1/projects {"instructions":"x"} → 400 {"error":"name must not be empty"}
```

slug 自动让的行为对 SDK 不是显然——客户端建项目后必须读响应里的 `slug` 而不是自己拼，否则 URL 撕裂。CLAUDE.md 项目段未提。

### 4.14 `/v1/diagnostics/runs/{recent,stuck}` 与 `/v1/work/quality` shape 持平 06-29

```
recent.items[*].keys = [conversation_id, id, logs, requirement_id, started_at, status]
stuck.items[*].keys  = [age_seconds, conversation_id, id, logs, requirement_id, started_at, status]
                       ← 仅 age_seconds 是 stuck 独有

GET /v1/work/quality → 200 top keys (6):
  [as_of, since, top_failing_commands, truncated, verification_pass_rate_by_day, window_days]
verification_pass_rate_by_day[*].keys = [date, failed, needs_review, passed]  # len=8
```

`/v1/workspace`（单数）非 git 目录形态：

```
GET /v1/workspace → 200 {"root":"/tmp/jarvis-servlet-test","vcs":"none"}   # 与 06-29 一致
```

---

## 5. 单测健康

```
$ pnpm --filter @jarvis/server test
...
# tests 522
# pass 522
# fail 0
# duration_ms 7703.45975
```

522/522 全绿。

| 日期 | tests | pass | fail | duration_ms |
| --- | --- | --- | --- | --- |
| 06-28 | 522 | 522 | 0 | 7706 |
| 06-29 | 522 | 522 | 0 | 7702 |
| 06-30 | 522 | 522 | 0 | 7703 |

完美持平。

`packages/store` 的 sqlite ABI mismatch（memory 引用过）今天没复测——本路径默认 JSON-store，与 sqlite 解耦。

---

## 6. 合并建议优先级（06-23 → 06-30）

| 优先级 | 项 | 文件/位置 | 累计状态 |
| --- | --- | --- | --- |
| **P0** | Web UI 在 `confidence < 0.2` 时把 `overall_score` 替换成"样本不足"——cold-start 与全面崩盘的同 score 必须前端兜底 | `apps/jarvis-web/src/components/Observability/...` | 06-25 抬升，**7 天未修** |
| **P1（升级）** | `requirements-routes.ts` create **和** patch 都加 `acceptance_policy / workflow_id / assignee_id / verification_plan` 透传 + 单测；同步 `requirement.create` 工具。**06-30 用真 UUID 二次验证 `workflow_id` 仍丢**——加单测时把 happy path 跟 bogus value 都覆盖 | `:147-167`、`:206`、`:255` + `packages/tools/src/requirement-tools.ts` | 06-23 提出（只 PATCH）；06-27 升 POST；**第 7 次报告** |
| **P1（新增）** | **`POST /v1/workflows` 500 泄漏修复**：`body.steps` 非数组时 validator 不拦，泄漏 `steps.map is not a function`。Fix：`Array.isArray(body.steps) ? body.steps : (body.steps == null ? [] : null)` → null 时返 400 `"steps must be an array"`。同步加 `workflow-routes.test.ts` 反例 | `packages/server/src/workflow-routes.ts:156` + `packages/server/src/workflow-routes.test.ts:115` 附近 | **06-30 新增真 bug** |
| P1 | `roadmap.import` 工具 + REST 移植；或在 CLAUDE.md 显式标记 deferred | `packages/tools/src/`、`CLAUDE.md` | 06-23 提出，**7 天未修** |
| P1 | requirements create/patch 加 project_id 存在性校验 → 404；**同时新增 `GET /v1/requirements/:id`**（镜像 `projects-routes.ts` single-row pattern） | `requirements-routes.ts:206/:255`，新增 `:?` | 06-25 P2 → 06-26 升级 → 06-30 持平 |
| P1 | `depends_on` 跨 id 不存在性校验 | `requirements-routes.ts:233-237/:298-302` | 06-28 新增，**3 天未修** |
| **P2（升级）** | `/v1/observability/health` / `runs/*` / `/v1/requirements/:id/runs` / `/v1/work/*` / `/v1/workflows` / `/v1/workflow-runs/:id` / `/v1/workspaces` / `/v1/remote/info` / `/v1/providers` / `/v1/version` 的完整 wire shape 一次性 codify。06-30 已把 health 的 `rules:dict` / `evidence:list[]`、`dimensions[*].keys` 含 `label`、workflow POST 正确 shape、workflow-run dispatch 202、`/v1/workspaces:{workspaces:[]}` 等全部入档 | `docs/conventions/` 或 CLAUDE.md | 06-23 漏记，06-30 第 6 次补 |
| **P2（升级）** | "未配 feature" 路由口径统一：8 条里 7 条 503 + 1 条 200+flag，建议全收敛到 503 + actionable hint（DDNS 路由的写法最优）。`/v1/diagnostics/memory` 改为 503 + hint | `packages/server/src/diagnostics-routes.ts` + CLAUDE.md | 06-28 起，06-30 升级（多 5 条 503 样本） |
| **P2（升级）** | list 路由 shape 收敛：3 种体例（裸数组 / `{items:[]}` / `{workspaces:[]}`）并存，未来加分页就 3 处 breaking。要么趁早 wrap，要么 codify "特例" | `projects-routes.ts` + `workspaces-routes.ts` + CLAUDE.md | 06-29 起，06-30 升级（多 `/v1/workspaces` 第 3 种） |
| P2 | approve idempotent + reject "软删非回退" 语义、`POST /v1/projects` instructions trim-aware、`POST /v1/projects` slug 自动 `-N` 后缀 + 显式 slug 字段，全部加进 CLAUDE.md | CLAUDE.md 项目段 + requirements 段 | 06-29 起，06-30 加 slug 行为 |
| P2 | `depends_on` wire shape 稳定化——固定服务端写回 `[]` 而不是 omit；或客户端 normalize | `requirements-routes.ts` create/patch 响应序列化处 | 06-28 起，**3 天未修** |
| P3 | `runs/stuck` 默认 `threshold_seconds` 在 CLAUDE.md 补；统一所有 diagnostics 路由 `{items:[]}` contract（recent 与 stuck 都 `{items:[]}`，差异仅 `stuck.items[].age_seconds`） | CLAUDE.md | 06-23 提出，未修 |
| P3 | `ObservabilityStore` / `EvalStore` 的 env-driven 拉起方式在 CLAUDE.md 文档化 | CLAUDE.md | 06-23 提出，未修 |

---

## 7. 复测剧本（有 LLM key 时；与 06-29 §7 一致）

```bash
export OPENAI_API_KEY=sk-...
export JARVIS_FS_ROOT=/tmp/jarvis-servlet-test
export JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-<date>   # 日期后缀，避开 rm -rf
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

- **05-29 §7 第 1 项已落地**：`POST /v1/workflows` 创建 + dispatch 在 §4.1 完整验证。
- `subagent.review` 在 `Subagent` policy 下是否真把 review→done flip（需 `JARVIS_REVIEWER_AUTO_ACCEPT=1` + 真 LLM）。
- `triage.scan_candidates` 能否把 `EchoServlet.java:7` 的 `TODO(jarvis): support POST body echo with content-length cap` 自动建成 `ProposedByScan` 需求（agent-only，无 REST，必须有 LLM key 才能驱动）。
- `project.checks` 能否识别"缺少 Maven/Gradle"并建议 `mvn archetype:generate` 或 `gradle init`（同样 agent-only）。
- `POST /v1/projects/:bogus-pid/requirements` 之后能否用 `requirement.list` 工具（agent 侧）拿回——目前只能用 REST `GET /v1/projects/:bogus-pid/requirements`。
- **新增**：workflow run 在 stub LLM 模式下保持 `pending` 不动；有 LLM key 时验证 `step_results[*]` 填充 + `status` 转 `succeeded/failed`，及 `/v1/workflow-runs/:id/cancel` 对真正 in-flight 的 run 是否能 abort。
- **新增**：`JARVIS_DDNS_ENABLE=1` + `JARVIS_DDNS_PROVIDER=duckdns` 起飞后，`/v1/ddns/status`、`/v1/ddns/update` 的实际成功路径（iOS 端 `DDNSView` 文件已就位但未 commit），以及 `/v1/remote/info.external` 字段填充时的形状。
- **新增**：`JARVIS_ENABLE_MEMORY=1` + git/iCloud sync 后端起飞时，`/v1/memory/sync_status` 与 `/v1/memory/includes` 的 happy-path wire shape。

---

## 8. 总览

| 项 | 评分 | 与 06-29 比 |
| --- | --- | --- |
| Kanban (Project + Requirement CRUD + 状态转换 + Activity 时间线) | ✅ 健康 | 持平 |
| Workflow CRUD + dispatch（**06-30 首次端到端**） | ✅ 健康（除 §4.2 的 500 泄漏） | 落地（06-29 §7 留白） |
| Diagnostics (`/v1/diagnostics/*`、`/v1/work/*`) | ✅ 健康 | 持平 |
| Harness.health 算法实装 | ✅ 健康 | 持平（fingerprint `0.13120190627836492` 复现 7 天） |
| Harness.health 信号采集 | ⚠️ 缺 LLM 驱动时无信号 | 持平 |
| Harness.health 前端表达 | ❌ confidence 低分仍直接展示 score | 持平（P0 仍 7 天未修） |
| REST ↔ 数据模型一致性 | ❌ `acceptance_policy / workflow_id / assignee_id / verification_plan` POST + PATCH 双双丢（真 UUID 也丢）；project_id 无 FK；`depends_on` 跨 id 无 FK；无 `GET /v1/requirements/:id`；`depends_on` 条件性写回；`GET /v1/projects` vs 其他 list shape 不一致 | 06-30 在 06-29 基础上多 1 条 wf-id 用真 UUID 仍丢的二次确认 |
| 文档 ↔ 运行时一致性 | ⚠️ `roadmap.import` 文档存在但运行时 404；多条 wire shape（health.rules:dict / evidence:list[] / dimensions[*]含label / runs/recent.items[].logs / work/quality 顶层 / workspace 非 git 形态 / approve-reject 语义 / projects slug 自动后缀 + 显式 slug / workflow POST 正确 shape / workflow-run dispatch 202 / `/v1/workspaces:{workspaces:[]}` / `/v1/remote/info` / `/v1/ddns/*` / `/v1/memory/sync*` / `/v1/agent-profiles / memories / learning / automations / channels / plugins` 503 体例 / `/v1/providers` / `/v1/version` / `/health` 与 `/v1/health` 分歧）未文档化 | 06-30 大幅新增（详 §6 P2 项） |
| 单测覆盖 | ✅ 522/522 全绿 | 持平 |
| **新真 bug**：`POST /v1/workflows` 500 泄漏 | ❌ | 06-30 首次发现 |
| 自动化的端到端验证（有 LLM key） | ❌ 本次仍未执行 | 持平 |

**总体判断**：HEAD 在 06-23 → 06-30 七天内没动（工作树侧的 `feat/mobile-ios-ddns` iOS + DDNS 25 个未 commit 文件已经摆了 8 天，最早 Jun 22），所以 06-29 的所有 P0/P1 结论原样成立。本次实际增量价值集中在：

1. **06-29 §7 未验证项落地 1/5**：`POST /v1/workflows` 创建 + dispatch 端到端通了，wire shape 完整入档（§4.1）。**正确 body 是 top-level `steps[]`、`kind:{type:"agent", prompt}`，**不是** `definition.steps` 也不是 enum-string 形态。**dispatch 返 202** 不是 200。
2. **1 个真 bug**：`POST /v1/workflows` 当 `body.steps` 是非 iterable 非 null 时，`?? []` 兜不住 → 500 泄漏 `steps.map is not a function`（§4.2，列入 P1）。
3. **06-29 两处错记修正**：`health.rules` 是 dict 不是 list；`health.evidence` 是 list len=0 不是"顶层结构"；`/v1/subagents` 是 2 条不是 3 条（batch 是 fan-out 工具不是 subagent）。
4. **大批新 wire shape 入档**：`/v1/version` / `/v1/remote/info` / `/v1/ddns/status` / `/v1/memory/sync*` + `/v1/memory/includes` / `/v1/agent-profiles` / `/v1/memories` / `/v1/learning/skill-usage` / `/v1/providers` / `/v1/automations` / `/v1/channels` / `/v1/plugins` / `/v1/workspaces`（注意是 `{workspaces:[]}` 不是 `{items:[]}`）/ `/v1/diagnostics/worktrees/orphans` / `/health` 与 `/v1/health` 分歧 / 项目 slug 自动 `-N` 后缀 + 显式 slug 字段——这是给"7 条 503-feature-not-configured + 1 条 200+flag"的口径统一建议提供了完整证据。

**建议**：下次合 P1 修复时**同时**做：①create+patch 透传 4 字段；②`projectStore.get(projectId)` 校验；③新增 `GET /v1/requirements/:id`（镜像 `projects-routes.ts` single-row pattern）；④`depends_on` 跨 id FK 校验；⑤**新加：workflow POST 500 泄漏修复**（§4.2 fix）；⑥把 health/runs/work/workspace/subagents/skills/diagnostics-memory/requirements/projects/workflows/workflow-runs/version/remote/ddns/memory-sync/agent-profiles/memories/learning/providers/automations/channels/plugins 的**完整** wire shape 一次性 codify。
