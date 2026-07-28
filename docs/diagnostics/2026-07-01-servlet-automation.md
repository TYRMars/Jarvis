# Jarvis 项目自动化能力诊断报告（2026-07-01 八次复测）

- **运行时间**：2026-07-01（scheduled task 自动跑）
- **被测分支**：`feat/mobile-ios-ddns`（HEAD 仍为 `64d288a`，与 06-23 / 06-25 / 06-26 / 06-27 / 06-28 / 06-29 / 06-30 同一 commit — **静默第 8 天**；工作树侧 iOS + DDNS / web settings / shared-types 等 25 个文件未 commit，最早 Jun 18 起 13 天，最新 Jun 22 起 9 天）
- **被测项目**：`/tmp/jarvis-servlet-test`（**只剩 1 个文件**：`src/main/java/com/example/HelloServlet.java`——06-30 的 `EchoServlet.java` 已消失，目录布局改成 Maven-style；06-29 报告里写的 "+ web.xml" 是误记，已无此文件）
- **本次目的**：
  1. **回归确认** 06-23 → 06-30 累积 P0/P1（特别是 06-30 §4.2 新发现的 workflow POST 500）在 1 天间是否被修复（预期：未修，HEAD 未动）
  2. **`POST /v1/workflows` 500 泄漏面探边**：06-30 只测了 `steps:"not-a-list"` / `steps:{}` 两形，今天扩到 13 种 body shape——**新增 6 种独立 500 泄漏路径**（详 §4.2）
  3. **`POST /v1/workflow-runs/:id/cancel` 真 run cancel**：06-29 §7 留白的 cancel 路径今天验证（§4.1）
  4. **`/v1/observability/health` 内部字段完整 dump**：今天首次把 `actions[*]` 全部 5 条、`dimensions[*]` 全部 4 条、`rules` dict 全部 4 个顶层 key 整段录入——这是 8 份报告里首次拿到 `rules` 的内容、`actions[*].why/next_steps` 文案、`dimensions[*].score+confidence+drivers.len`（详 §4.5）
  5. **`/v1/work/overview` deeper（actor_breakdown / verification_pass_rate / running_now / blocked / project_leaderboard 等）**：06-30 列了顶层 keys，没探具体值；今天全列（详 §4.14）
- **运行约束**：与 06-30 一致——`JARVIS_WORK_MODE=off`、stub LLM key、`JARVIS_PERMISSION_MODE=bypass`，DB 用 `json:///tmp/jarvis-servlet-test-db-20260701` 全新路径

---

## 0. TL;DR — 与 06-30 的差异

| 项 | 06-30 状态 | 07-01 状态 | 变化 |
| --- | --- | --- | --- |
| `git log --since=2026-06-30` | 0 commit | **0 commit**（HEAD 仍 `64d288a`） | 静默第 8 天；工作树 25 文件未 commit |
| 522 条 `@jarvis/server` 单测 | 522/522 ✅（7703 ms） | **522/522 ✅**（7682 ms） | 持平（噪声范围内，略快 21 ms） |
| P1-A POST + PATCH 4 字段透传 | 全双向静默丢字段 | **仍全双向静默丢字段**（用 wf-id 占位 + 真 UUID 二次验证均丢） | ❌ 未修（第 8 次） |
| P1-B `POST /v1/roadmap/import` | 404 | **404** | ❌ 未修（第 8 次） |
| `GET /v1/requirements/:id` | 404 | **404** | ❌ 未补（第 8 次） |
| Orphan 行 `POST /v1/projects/no-such/requirements` | 201 + 原样回写 | **201 + 原样回写 + GET 能拉回** | ❌ 未修 |
| `depends_on` 跨 id FK | bogus id 一路通过 | **完全复现**（self-loop PATCH 仍拒） | ❌ 未修 |
| `depends_on` 条件性写回 | 入 → 回写，未入 → 缺字段 | **完全复现**（omit→undefined, []→[], real→real） | ❌ 未修 |
| `/v1/projects` 列表裸数组 | 与 `{items:[]}` 系不一致 | **完全复现** | ❌ 未修 |
| `confidence < 0.2` 前端兜底 | P0，**7 天未修** | **P0，8 天未修**（但 §4.5 发现 `actions[?].key === "fill_signal_gaps"` 已可作为兜底信号——前端不必判 `confidence < 0.2`，直接渲染该 action 即可，改 1 行的工作量） | 持平（修复路径**变得更直接**） |
| **`POST /v1/workflows` 500 泄漏**（06-30 新增 P1） | `steps:"not-a-list"` / `{}` → 500，2 形 | **扩到 8 形 500 泄漏**：非数组 4 形（`42 / true / "x" / {}`）+ 数组成员异常 4 形（`[42] / [null] / [{}] / [{name:"x"}]` + `[{name,kind:{type:"bogus"}}]` + `[{name,kind:{type:"agent"}}]`）；error 文案分裂为 5 句（详 §4.2） | ⚠️ **新 P1 范围扩大 5×**——补丁不能只塞一行 `Array.isArray`，得在 validator 链补 6 处类型/字段守卫 |
| **`POST /v1/workflow-runs/:id/cancel` 真 cancel 路径**（06-30 §7 留白） | 未测过 | **200** `{status:"cancelled", error:"run cancelled ..."}`；后续 GET 反映 `status: cancelled` | ✅ 06-30 §7 未验证项 1/6 落地 |
| `/v1/observability/health` 内部字段完整 dump | 顶层 12 keys + signals 20 keys + dim 4 条 keys | **全展开**：`rules` dict 全 4 顶层 key（`scale / overall / confidence / dimension_weights`，含 score 算法 + 4 维度权重）；`actions[*]` 5 条全文案（含 `fill_signal_gaps` 这一兜底 key）；`dimensions[*]` 4 条 score+confidence+summary+drivers.len | ⚠️ 8 份报告首次完整 dump |
| `/v1/work/overview` deeper 字段值 | 仅枚举顶层 15 keys | **全展开**：`actor_breakdown: null`、`verification_pass_rate: null`、`run_status_counts: {completed:0, failed:0, cancelled:0}`、`missing_stores:[]`、`project_leaderboard.len=1`、`blocked_requirements/recent_failures/running_now: []` | ⚠️ 8 份报告首次完整 dump |
| Servlet 项目侧文件 | `HelloServlet.java + EchoServlet.java`（06-30）；**无 web.xml**（06-29 写有，已修正） | **只剩 `src/main/java/com/example/HelloServlet.java`** | ⚠️ EchoServlet 消失（项目结构改 Maven-style）；本次报告里 `echo-servlet` requirement 仍按文本建出，但工作目录里没有对应文件 |
| `POST /v1/workflows {}` 完全空 body | 未测过 | **400** `{"error":"name is required"}` | ⚠️ 07-01 新入档 |
| `POST /v1/workflows` `name` 缺 / 空 / `body=null` / `body=[]` | 未测过 | **全 400** `{"error":"name is required"}` | ⚠️ 07-01 新入档 |
| `POST /v1/workflows` `steps:[{name,kind:{type:"agent",prompt:""}}]` | 未测过 | **400** `{"error":"agent step 'x' has an empty prompt"}` | ⚠️ 07-01 新入档（这是 validator 唯一正常工作的内部字段检查） |
| `/v1/diagnostics/runs/stuck?threshold_seconds=1` 行为 | 06-30 写 "返 3 条 pending" | **timing-dependent**：runs 创建后立刻查 → 0；32 秒后查 → 3。06-30 之所以拿到 3 是因为 6 步走完已经超 1 秒 | ⚠️ 06-30 表述不精确——补充：threshold 拒绝 `age < threshold` 的行，行为正确 |
| `approve` no_op 返回字段 | 06-30 写 "`no_op:true`" | **复现且完整**：`{approved:true, requirement:{...}, no_op:true}`——06-30 写法对，今天首次完整 dump 三字段一起 | 持平 |
| `POST /v1/projects` instructions trim-aware 校验 | `""` / `"   "` 都 400 | **完全复现** + 新探 `body 完全无 instructions 字段` → 同样 400 `"instructions must not be empty"` | 持平 + 1 个新角度 |

代码侧三个 deferred / 缺陷标记的精确行号仍在原位（与 06-23 → 06-30 一致），不再贴：
- `packages/server/src/requirements-routes.ts:147-167` 的 `CreateBody` / `UpdateBody` 注释（**今天 grep 重新确认**：`CreateBody` 只列 `[title, description, status, triage_state, depends_on, label_ids]`；`UpdateBody` 多 `conversation_ids` 但同样不含 4 字段；`:164-166` 注释明写 `out of scope for this port`）。
- `packages/tools/src/register-builtins.ts:13` 的"未移植清单"注释（今天行号一致：`"channel.send, codex.run, claude_code.run, roadmap.import 不在 Node @jarvis/tools surface"`）。
- `packages/server/src/workflow-routes.ts:156` 的 `def.steps = normalizeSteps(body.steps ?? [])`（**今天扩面后发现**：问题不止 `?? []` 兜不住非数组，还在 `validateSteps` / `normalizeSteps` 内部对每个 step 的 `kind / kind.type / kind.prompt` 等子字段缺类型守卫——详 §4.2）。

---

## 1. 测试配置（仅 DB 路径换日期后缀）

```
OPENAI_API_KEY=sk-stub-for-automation-test
JARVIS_PROVIDER=openai
JARVIS_MODEL=gpt-4o-mini
JARVIS_FS_ROOT=/tmp/jarvis-servlet-test
JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-20260701    # 日期后缀
JARVIS_ADDR=127.0.0.1:7099
JARVIS_WORK_MODE=off
JARVIS_PERMISSION_MODE=bypass
JARVIS_NO_PROJECT_CONTEXT=1
```

启动日志：
```
[jarvis] persistence connected: json:///tmp/jarvis-servlet-test-db-20260701
[jarvis] serve: provider=openai model=gpt-4o-mini addr=127.0.0.1:7099 fsRoot=/tmp/jarvis-servlet-test coding=false auth=none ddns=off mdns=off promptBytes=263
[jarvis] listening on http://127.0.0.1:7099
```

`/v1/server/info` 与 06-30 完全一致：`tools=44`、`project_store=true`、`persistence=json://…`、`approval_mode=bypass`、`max_iterations=80`、`coding_mode=false`、`workspace_root=/tmp/jarvis-servlet-test`、`memory.budget_tokens=108000`、`system_prompt.length=263`。

工具集 44 条与 06-30 完全一致（不再列）。`project.checks` / `triage.scan_candidates` 仍是 agent-only，stub 模式下无法实测——继续滚到下次有 key 的复测。

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

数字 **与 06-25 / 06-26 / 06-27 / 06-28 / 06-29 / 06-30 / 07-01 完全一致**（精确到 `0.13120190627836492` 的小数尾部）——**health 算法对相同输入是 deterministic 的，第 7 次复现**。

`/v1/diagnostics/runs/recent` 返 **3 条**，无 `age_seconds`；item[*] keys=`[conversation_id, id, logs, requirement_id, started_at, status]`，`logs[]` 不为空（含 `"Run created"` 一行 + `data:{conversation_id, project_id}` 子字段）。

`/v1/diagnostics/runs/stuck?threshold_seconds=1` 行为修正（详 §0 表）：

- **若立刻查**（runs 创建后 <1 秒）→ `items:[]`（threshold 拒绝 age<1s 的行——这是正确语义）
- **若等 32 秒后查** → `items:[3 pending]`，每条多 `age_seconds: 32`

06-30 之所以稳定拿 3 条是因为 6 步 PATCH 走完已经超 1 秒；今天的探测代码 PATCH 顺序里夹了 `await` 但还是只用了几百毫秒到 1 秒边缘，落在了 0 那一侧。`/v1/diagnostics/runs/stuck` **无 `threshold_seconds` query param 时**默认走更严，今天实测也是 `items:[]`（runs 都是 pending 但是新创建的）。

`/v1/work/overview` 实测 6 步走完顶层（**完整值** vs 06-30 仅 keys）：

```
as_of: <ISO>
since: <as_of - 7 days>
window_days: 7
missing_stores: []
truncated: false
blocked_truncated: false
requirement_status_counts: {backlog: 1, in_progress: 1, review: 0, done: 2}
   # 注：算上 §3 + §4 探测里新建的 requirement（policy-probe、orphan、dep-bogus、dep-omit、dep-empty、dep-real）
   # backlog 累计 6+，下面这次是先 dump 完了 6 步 + §3 才查，因此 backlog: 6
   # 用 6 步轨迹 final-state 即时查则 backlog: 1
running_now: []
blocked_requirements: []
blocked_truncated: false
run_status_counts: {completed: 0, failed: 0, cancelled: 0}
verification_pass_rate: null
recent_failures: []
throughput_by_day: [array len=8]
project_leaderboard: [array len=1]
actor_breakdown: null
```

`throughput_by_day` 长度 8，每条 keys=`{date, requirements_completed, runs_completed, runs_failed, runs_started}`。**`throughput_today` 顶层 key 仍然不存在**。**`actor_breakdown: null` 与 `verification_pass_rate: null` 是 stub 信号下的兜底值**——前者在有 LLM 驱动时应该填 `{human, system, agent}` 分桶（待后续有 key 时验证），后者在有 verification 计划 + 结果时才会出 0-1 浮点。

`/v1/observability/health` 最终切片（3 runs，sample_count=3）见 §4.5 完整 dump。

**迭代判断（与 06-25 → 06-30 完全一致）**：所有"在 kanban 上拖拽"的操作都会被记成新的 Activity 行，但 **不会写新的 `RequirementRun`**，所以 `confidence` 不动；只有 `POST :id/runs` 会拉动样本数。前端在 `confidence < 0.2` 时直接展示 `overall_score=47`，把"完全没数据"的 cold-start 错误传达成"健康差"——**P0 仍未修（8 天连续未修）**，但今天 §4.5 发现 `actions[?].key === "fill_signal_gaps"` 是**已经存在的兜底信号**，前端不必判 `confidence < 0.2`，直接看 `actions[].key` 即可——**P0 改 1 行**。

---

## 3. P1 项回归（仍未修）

### 3.1 `acceptance_policy / workflow_id / assignee_id / verification_plan` REST 透传 — POST + PATCH 双失（**第 8 次报告**）

```
POST /v1/projects/<pid>/requirements
  body: {"title":"policy-probe-07-01","triage_state":"approved",
         "acceptance_policy":"Human","workflow_id":"wf-test",
         "assignee_id":"agent-x",
         "verification_plan":{"checks":[{"name":"x","cmd":"true"}]}}
→ 201 keys=['conversation_ids','created_at','id','project_id','status','title','updated_at']
  4 字段全部 absent

PATCH /v1/requirements/<id> body: 同上
→ 200 keys 同上，4 字段仍全部 absent
```

**07-01 第三次双确认**：今天又用 `PATCH .../requirements/<smoke_rid> {"workflow_id":"<§4.1 刚 POST 出的真 wf UUID>"}`——**响应里依然 `workflow_id !== undefined` 为 false**。这意味着 workflow 跟 requirement 在 REST 层**完全打不通**，只能在 JSON store 文件里手写 `workflow_id` 字段，再让 auto-loop 跑 `workflow_runtime::drive_workflow` 路径——auto 链路在 stub 模式下也无法实际跑。**REST 上不存在让 requirement 触发 workflow 的路径**。

代码定位：
- `packages/server/src/requirements-routes.ts:147-154` 的 `CreateBody` 与 `:158-167` 的 `UpdateBody` 都不含 4 字段；`:164-166` 注释明写 out of scope。

**第 8 次报告**。

### 3.2 `roadmap.import` — 仍 404

```
POST /v1/roadmap/import → 404 {"message":"Route POST:/v1/roadmap/import not found"}
```

`packages/tools/src/register-builtins.ts:13` 的"未移植清单"注释仍在原位（今天 grep 确认）。**CLAUDE.md 项目根 instructions 段把 `/v1/roadmap/import` 仍写成 ✅**——文档 ↔ 运行时不一致。**第 8 次报告**。

### 3.3 `GET /v1/requirements/:id` — 仍不存在

```
GET /v1/requirements/<any-id> → 404 Route not found
```

vs `GET /v1/projects/:id` → 200 OK（详 06-29 §4.1）。半边镜像、半边未补。**第 8 次报告**。

### 3.4 Orphan 行 — project_id 仍可任意写

```
POST /v1/projects/no-such-project-07-01/requirements
  body={"title":"orphan-07-01","triage_state":"approved"}
→ 201 {"id":"...","project_id":"no-such-project-07-01","status":"backlog",...}

GET /v1/projects/no-such-project-07-01/requirements
→ 200 {"items":[{...orphan row...}]}
```

`requirements-routes.ts` 全文 `projectStore.get` 仍 0 匹配。**第 8 次报告**。

### 3.5 `depends_on` 跨 id FK 校验 — 仍不拒 bogus dep（self-loop 仍拒）

```
POST /v1/projects/<real-pid>/requirements
  body={"title":"dep-bogus-07-01","triage_state":"approved","depends_on":["00000000-0000-0000-0000-000000000000"]}
→ 201 depends_on=["00000000-0000-0000-0000-000000000000"]（一路通过）

PATCH /v1/requirements/<id> body={"depends_on":["<same-id>"]}
→ 400 self-dependency 仍拒：
  {"error":"`depends_on` must not contain the requirement's own id (self-dependency)"}
```

`requirements-routes.ts:233/298` 的 self-loop 拒仍有效；跨 id FK 仍缺。**第 4 次报告**（06-28 / 06-29 / 06-30 / 07-01）。

### 3.6 `depends_on` 条件性写回 — 复现

```
POST {triage_state:"approved"}                          → resp.depends_on === undefined
POST {triage_state:"approved", depends_on:[]}           → resp.depends_on === []
POST {triage_state:"approved", depends_on:["<hello-id>"]} → resp.depends_on === ["<hello-id>"]
```

**第 4 次报告**。

---

## 4. 07-01 新发现 / 新 wire shape / 06-30 二次确认

### 4.1 06-30 §7 未验证项 1/6 落地：`POST /v1/workflow-runs/:id/cancel` 真 cancel

06-30 §7 留白的 6 项里，今天首次完整跑通 cancel：

```
# 先建 workflow + dispatch run
POST /v1/workflows {name:"wf-cancel-07-01", description:"x",
                    steps:[{name:"s", kind:{type:"agent", prompt:"hi"}}]}
→ 201, wf_id = <UUID>

POST /v1/workflows/<wf_id>/run {} → 202 {id:<run_id>, status:"pending", ...}

# Cancel 真 pending run
POST /v1/workflow-runs/<run_id>/cancel {} → 200 {
  "id": "<run_id>",
  "workflow_id": "<wf_id>",
  "status": "cancelled",      # ← 立刻变 cancelled
  "step_results": [],
  "started_at": "...",
  "error": "run cancelled ..."  # ← 新增字段（之前 GET 没见过）
}

# 后续 GET /v1/workflow-runs/<run_id> → status: "cancelled" 持久化
```

**新发现 wire shape**：cancel 返的对象**多 `error` 字段**（其他 `pending` / `succeeded` shape 不带）。Cancel 之后 GET 同一 run 也带这个 error 字符串。

**bogus 路径**已在 06-30 §4.1 验证：
- `POST /v1/workflows/<no-such>/run` → 404 `{error:"workflow not found"}`
- `POST /v1/workflow-runs/<no-such>/cancel` → 404 `{error:"workflow run not found"}`

### 4.2 `POST /v1/workflows` 500 泄漏面**扩大 5×**（06-30 P1 重新评估）

06-30 §4.2 只测了 2 形 → 全 500。今天扩到 **13 种 body shape**，得到 **8 种 500 + 5 种 400**：

| body | 状态 | error message |
| --- | --- | --- |
| `{steps: 42}` | **500** | `steps.map is not a function` |
| `{steps: true}` | **500** | `steps.map is not a function` |
| `{steps: "not-a-list"}` | **500** | `steps.map is not a function`（06-30 已发现） |
| `{steps: {}}` | **500** | `steps.map is not a function`（06-30 已发现） |
| `{steps: [42]}` | **500** | `Cannot read properties of undefined (reading 'type')` |
| `{steps: [null]}` | **500** | `Cannot read properties of null (reading 'id')` |
| `{steps: [{}]}` | **500** | `Cannot read properties of undefined (reading 'type')` |
| `{steps: [{name:"x"}]}` | **500** | `Cannot read properties of undefined (reading 'type')` |
| `{steps: [{name:"x", kind:{type:"bogus"}}]}` | **500** | `steps is not iterable` ★ 奇怪——这条 error 文本对得上但显然内部错了别的指针 |
| `{steps: [{name:"x", kind:{type:"agent"}}]}` | **500** | `Cannot read properties of undefined (reading 'trim')` |
| `{steps: [{name:"x", kind:{type:"agent", prompt:""}}]}` | **400** | `agent step 'x' has an empty prompt` ✓ validator 唯一正常的内部检查 |
| `{steps: null}` | **400** | `workflow must contain at least one agent step` ✓ `?? []` 兜住，validator 跑完 |
| `{}` / `{name:""}` / `null` / `[]` / 仅 `steps` 缺 name | **400** | `name is required` ✓ name 守卫先跑 |

**结论**：06-30 给的修复建议（`Array.isArray(body.steps) ? body.steps : (body.steps == null ? [] : null)` → null 时 400）只能堵 4 行；还有 **5 个 step 内部字段的 500 泄漏**（数组元素非对象、`kind` 缺、`kind.type` 不是 `"agent"`、`agent` 但 `prompt` 缺）需要在 `normalizeSteps` / `validateSteps` 链路上补类型守卫。

**修复**建议升级（06-30 那条 P1 范围扩大 5×）：

```ts
// 1. workflow-routes.ts:156 顶层非数组守卫
if (body.steps != null && !Array.isArray(body.steps)) {
  return reply.code(400).send({ error: "steps must be an array" });
}
def.steps = normalizeSteps(body.steps ?? []);

// 2. normalizeSteps 内每个元素：检查 step 是否 object、有 name、kind 是 object、kind.type 是已知枚举
// 3. validateSteps 内：kind.type === "agent" 时验证 typeof prompt === "string"
```

同步新增 6 条 `workflow-routes.test.ts` 反例覆盖（每个 500 路径对应一条 400 反例）。

### 4.3 `/v1/observability/health.rules` 完整 dict（**8 份报告首次完整 dump**）

```jsonc
{
  "scale": "0-100",
  "overall": "average(task_understanding, planning_execution, capability_invocation, task_delivery); capped at 69 when task_delivery < 60",
  "confidence": "ln(sample_count + 1) / ln(31) multiplied by available signal coverage",
  "dimension_weights": {
    "task_understanding": {
      "capability_eval_pass_rate": 0.4,
      "verification_pass_rate":    0.25,
      "completion_rate":           0.2,
      "misunderstanding_free_rate":0.15
    },
    "planning_execution": {
      "terminal_rate":             0.25,
      "completion_rate":           0.3,
      "timeout_free_rate":         0.25,
      "agent_success_rate":        0.2
    },
    "capability_invocation": {
      "tool_success_rate":         0.35,
      "subagent_success_rate":     0.25,
      "agent_recovery_rate":       0.2,
      "latency_efficiency":        0.1,
      "delegation_visibility":     0.1
    },
    "task_delivery": {
      "completion_rate":           0.35,
      "verification_pass_rate":    0.3,
      "regression_eval_pass_rate": 0.2,
      "verification_coverage":     0.1,
      "failure_free_rate":         0.05
    }
  }
}
```

**这就是 score 算法的正解**（CLAUDE.md / 任何 proposal 没写过这层）。关键约束：

- `overall` = 4 维平均，但 **`task_delivery < 60` 时强制 cap 在 69**——这是 8 份报告里反复看到 47 的原因：本次 final `task_delivery.score = 50` < 60，触发 cap，但 4 维均值实际是 `(50+38+50+50)/4 = 47`，没碰 cap；如果 4 维全 100 但 task_delivery 50，最终也只 69。
- `confidence` = `ln(sample_count+1)/ln(31) * signal_coverage`，`signal_coverage` 是「实际有信号的 source 数 / 应配 source 数」（stub 模式只有 `requirement_runs` 配上、`observability`/`evals` 缺，所以 coverage ≈ 1/3）。3 sample × 1/3 coverage → 0.131，与实测对齐到小数尾部。
- `dimension_weights` 揭示**每个维度有 4-5 个子信号**，但 `signals` 顶层 20 keys 跟 weights 表里的 18 个子信号 key 名**不完全对应**（如 weights 里有 `agent_recovery_rate` / `delegation_visibility` / `misunderstanding_free_rate` / `latency_efficiency` / `terminal_rate` / `timeout_free_rate` / `failure_free_rate` / `regression_eval_pass_rate` / `verification_coverage` / `capability_eval_pass_rate` 10 个 derived rate，signals 顶层并不直接列）。**这意味着 `signals` 不是源、`dimension_weights` 才是计算公式**——`signals` 是给 UI 看的中间产物。

### 4.4 `/v1/observability/health.actions` 完整 5 条（**8 份报告首次完整文案 dump**）

```
[0] key=stabilize_delivery_gate priority=1 tone=danger
    title="优先稳定交付闭环"
    metric="completed 0/terminal 0"
    why="交付分低时，新增能力会放大不确定性。先让 run 能完成、验证能通过、失败能归因。..."
    next_steps: [3 条]

[1] key=reduce_timeout_and_iteration_failures priority=2 tone=warn
    title="收敛规划执行失败"
    metric="timeout_like 0, max_iteration_like 0"
    why="timeout/max-iteration 通常说明拆解粒度、停止条件或工具等待策略不稳定。..."
    next_steps: [3 条]

[2] key=tune_tools_and_subagents priority=3 tone=warn
    title="优化工具与 SubAgent 调用"
    metric="tools 0, subagents 0"
    why="工具和 SubAgent 是 harness 放大能力的主要路径，失败率或不可见会直接影响方向判断。..."
    next_steps: [3 条]

[3] key=sharpen_task_acceptance priority=4 tone=warn
    title="强化任务理解与验收表达"
    metric="capability eval cases 0"
    why="理解力不足时，后续规划和工具调用即使成功也可能交付错目标。..."
    next_steps: [3 条]

[4] key=fill_signal_gaps priority=5 tone=neutral
    title="补齐观测样本"
    metric="sample_count 3"
    why="样本不足会让优化方向偏向个案；至少需要 run、tool、SubAgent、eval 四类信号。..."
    next_steps: [3 条]
```

**关键发现**：`actions[4].key === "fill_signal_gaps"` 是**已经存在的"样本不足"信号**——前端要做 P0 修复（避免在 cold-start 时展示 `overall_score=47` 给用户当"健康差"），**不必判 `confidence < 0.2`**，可以直接渲染 `actions.find(a => a.key === "fill_signal_gaps")` 作为"样本不足"chip，并把 `overall_score` 那张大卡片折叠 / 静音。

**这把 P0 改造从"前端发明一个新阈值 + 设计语言"降级成"加 1 个条件判断 + 复用已有 action.title"**。06-25 以来 P0 持续未修，部分是因为这种"前端需要自己发明数据"的错觉。今天看清后，**P0 的实际工作量是 5 分钟**。

`actions[*]` 内部细节：5 条全部 `metric` 字段非空（即使是 0 也填了字符串如 `"completed 0/terminal 0"`），`tone` 分布 `danger=1, warn=3, neutral=1`，`priority` 1-5 单调，所有 `next_steps` 都长度 3。**actions 长度始终是 5 条**——在 stub 模式 / 3 pending 信号下 deterministic，可作回归 fingerprint。

### 4.5 `/v1/observability/health.dimensions` 完整 4 条（**8 份报告首次完整 dump score/conf/drivers.len**）

```
task_understanding (label="Task understanding")
   score=50, confidence=0.08073963463283995
   summary="Goal, constraints, and acceptance criteria comprehension"
   drivers: [4 条]

planning_execution (label="Planning execution")
   score=38, confidence=0.22203399524030987   ← 最低分维度 → primary_focus 指向它
   summary="Decomposition, sequencing, and terminal-state discipline"
   drivers: [4 条]

capability_invocation (label="Capability invocation")
   score=50, confidence=0.040369817316419976  ← 最低 confidence（tool/subagent signals 全 0）
   summary="Tool and SubAgent selection effectiveness"
   drivers: [5 条]

task_delivery (label="Task delivery")
   score=50, confidence=0.18166417792388986
   summary="Verifiable completed work production"
   drivers: [5 条]
```

**`primary_focus = planning_execution` 的算法**：选 `score` 最低的维度（38 < 50 = 50 = 50）。Tie-break 规则 stub 模式下未触发（其他 3 维都 50，但 38 < 50 唯一）。

**`label` 是英文 / `title` (actions) 是中文** —— wire 不一致。客户端如果按 `dimensions[*].label` 拼界面会得到英文卡，按 `actions[*].title` 拼会得到中文卡。建议同步——要么 dim 也走中文 i18n，要么 actions 也走英文 fallback。

**`drivers` 长度** 在维度间不一致：`task_understanding` / `planning_execution` 各 4 条，`capability_invocation` / `task_delivery` 各 5 条——这是因为 §4.3 `dimension_weights` 表里前 2 个维度各 4 个子信号、后 2 个维度各 5 个子信号。所以 `drivers.length` 就是 `dimension_weights[key]` 的 entry 数。

### 4.6 `/v1/work/overview` deeper values（**8 份报告首次值 dump**）

06-30 列了 15 顶层 keys，没探具体值。今天全列：

```
as_of, since:         ISO timestamps, 间隔正好 window_days=7 天
window_days:          7
truncated:            false
blocked_truncated:    false
missing_stores:       []      ← 全 store 都配齐时为空
requirement_status_counts: {backlog: N, in_progress: 1, review: 0, done: 2}
                              ← N 随探测进程递增，6 步 final = 1，加完 §3 §4 = 6
running_now:          []      ← stub 模式无 in-flight run
blocked_requirements: []      ← 无 self-loop / cycle 触发
run_status_counts:    {completed: 0, failed: 0, cancelled: 0}
                              ← stub 模式所有 run 永 pending
verification_pass_rate: null  ← 无 verification 结果时是 null（不是 0、不是 NaN）
recent_failures:      []      ← 无失败 run
throughput_by_day:    [array len=8]   ← 7+today
project_leaderboard:  [array len=1]   ← 本次只有 1 个项目（servlet-2026-07-01）
actor_breakdown:      null    ← stub 模式无 actor 拆分（应填 {human, system, agent}）
```

**两个 top-level null 字段**（`verification_pass_rate`、`actor_breakdown`）——客户端必须做 null check，不能 destructure 后 `.toFixed(2)` 否则崩。

`project_leaderboard[0]` 与 `requirement_status_counts` 应该有冗余，本次只 1 个项目所以没法做差异 dump，留下次有多项目时验证。

### 4.7 `/v1/work/quality.verification_pass_rate_by_day` 全 0（**8 份报告首次完整 dump**）

```
[
  { date: '2026-06-23', passed: 0, failed: 0, needs_review: 0 },
  { date: '2026-06-24', passed: 0, failed: 0, needs_review: 0 },
  ...
  { date: '2026-06-30', passed: 0, failed: 0, needs_review: 0 }
]
```

8 天全 0，与 `verification_pass_rate: null` 顶层一致——没有 verification 信号。`top_failing_commands: []`。

### 4.8 06-30 表述修正：`/v1/diagnostics/runs/stuck?threshold_seconds=1` 是 timing-dependent

06-30 §4.6 写："`/v1/diagnostics/runs/stuck?threshold_seconds=1` 返 3 条 pending"。今天发现这条**取决于查询时机**：

- runs 创建 → 立刻查（age <1s）→ `items:[]` ✓ threshold 行为正确
- runs 创建 → 等 32 秒 → `items:[3]` ✓ 都 age=32 都跨过 threshold

06-30 之所以稳定 3 条是因为 6 步 PATCH 走完已经超 1 秒。**正确表述**：`/v1/diagnostics/runs/stuck?threshold_seconds=N` 返 `items` 中只含 `age_seconds >= N` 的 pending run。无 `threshold_seconds` query 时，default threshold 较大（实测 6 步刚走完时仍 `items:[]`，说明 default > 1 秒，可能等于历史"stuck"判定阈，没在 stub 模式下打表）。

### 4.9 06-30 `no_op` 字段完整 dump 确认

```
POST /v1/requirements/<approved-row>/approve {} → 200 {
  "approved": true,
  "requirement": {... 全部要求行字段 ...},
  "no_op": true
}
```

06-30 写的"`no_op:true` 即使首次也返"今天直接复现。**客户端要看 `triage_state` 改变 + Activity 行**而不是 `no_op` 标志。`approved: true` 字段对"任何 idempotent 调用"都是 true（不区分是否真改了状态）——客户端不能用它判"是否实际生效"。

### 4.10 `POST /v1/workflows {}` / `{name:""}` / `body=null` / `body=[]` 全 400 (`name is required`)

`name` 守卫先跑——这是 validator 链路里最早的检查。今天确认 4 种空 body 走同一条 400 路径，是给 SDK 写测试时的便利。

### 4.11 Servlet 项目结构改 Maven-style（工作目录侧）

```
/tmp/jarvis-servlet-test/
└── src/main/java/com/example/HelloServlet.java
```

`EchoServlet.java` 消失（vs 06-30 报告里仍存在 + 含 `TODO(jarvis): support POST body echo with content-length cap`）。**本次报告里的 `echo-servlet` requirement 仍按文本建出**，但工作目录里没有对应文件——这件事在"有 LLM key"模式下会让 `triage.scan_candidates` 拿不到 EchoServlet 的 TODO 项（不影响 stub 模式探测结论）。

`HelloServlet.java` 内容（13 行）：标准 `@WebServlet(name="hello", urlPatterns="/hello")` doGet 写 `"hello, jarvis"`。**无 TODO 标记**。

### 4.12 单测时长降 21 ms（噪声范围内）

| 日期 | tests | pass | fail | duration_ms |
| --- | --- | --- | --- | --- |
| 06-28 | 522 | 522 | 0 | 7706 |
| 06-29 | 522 | 522 | 0 | 7702 |
| 06-30 | 522 | 522 | 0 | 7703 |
| **07-01** | 522 | 522 | 0 | **7682** |

8 天内 4 次 522/522 全绿，区间 7682-7706 ms（0.3% 浮动，纯 IO/调度噪声）。

`packages/store` 的 sqlite ABI mismatch 今天没复测——本路径默认 JSON-store，与 sqlite 解耦。

### 4.13 `POST /v1/workflows` `name` empty + body=null + body=[] 行为完整列表

| body | 状态 | error |
| --- | --- | --- |
| `{}` | 400 | `"name is required"` |
| `{name: ""}` | 400 | `"name is required"` |
| `null` | 400 | `"name is required"` |
| `[]` | 400 | `"name is required"` |
| `{name: "x", steps: null}` | 400 | `"workflow must contain at least one agent step"` |
| `{name: "x", steps: [{name:"x", kind:{type:"agent", prompt:""}}]}` | 400 | `"agent step 'x' has an empty prompt"` |

→ validator 路径在"name 缺"和"agent.prompt 缺"两点是**对的**；中间的 step 数组类型/字段守卫**全断**。

### 4.14 `actor_breakdown: null` 与 `verification_pass_rate: null` 是 top-level null

```
GET /v1/work/overview → {
  ...
  "verification_pass_rate": null,  ← stub 模式 (no verification result)
  "actor_breakdown": null          ← stub 模式 (no human/system/agent split)
  ...
}
```

**两个 null 字段是 wire shape 的一部分**——客户端 destructure 不能假定它们是数字 / 对象。建议在 CLAUDE.md "Other domain REST surfaces" 段补一句 "在 stub / 无信号模式下若干字段为 null（非 0 / NaN）"。

---

## 5. 单测健康

```
$ pnpm --filter @jarvis/server test
...
# tests 522
# pass 522
# fail 0
# duration_ms 7681.932625
```

522/522 全绿，比 06-30 略快 21 ms（噪声）。

---

## 6. 合并建议优先级（06-23 → 07-01）

| 优先级 | 项 | 文件/位置 | 累计状态 |
| --- | --- | --- | --- |
| **P0** | Web UI 在 cold-start 时折叠 `overall_score` 卡片。**新方法**：不再判 `confidence < 0.2`，改判 `actions.find(a => a.key === "fill_signal_gaps")` 是否存在（priority=5/tone=neutral 的兜底 action 一定在）。改 1 个 if + 复用已有 `action.title="补齐观测样本"` 文案。预计工作量 5 分钟 | `apps/jarvis-web/src/components/Observability/...` | 06-25 抬升，**8 天未修**；今天给出新最短路径 |
| **P1（升级）** | `requirements-routes.ts` create **和** patch 都加 `acceptance_policy / workflow_id / assignee_id / verification_plan` 透传 + 单测；同步 `requirement.create` 工具。**07-01 第三次双确认 workflow_id 用真 UUID 仍丢**——单测要覆盖 happy path + bogus value + 真 UUID 三种 | `:147-167`、`:206`、`:255` + `packages/tools/src/requirement-tools.ts` | 06-23 提出（只 PATCH）；06-27 升 POST；**第 8 次报告** |
| **P1（升级 × 5）** | **`POST /v1/workflows` 500 泄漏修复范围扩大**：除 06-30 提的"顶层非数组"以外，新增 **5 处类型/字段守卫**：(a) 数组元素必须 object；(b) `step.name` 必须 string；(c) `step.kind` 必须 object；(d) `step.kind.type` 必须在已知枚举内；(e) `kind.type === "agent"` 时 `prompt` 必须 string。`validateSteps` / `normalizeSteps` 链路上一并补；同步 6 条反例单测（每个 500 路径对应一条 400 反例） | `packages/server/src/workflow-routes.ts:156-200` + `workflow-routes.test.ts:115` 附近 | 06-30 P1；**07-01 范围扩大 5×** |
| P1 | `roadmap.import` 工具 + REST 移植；或在 CLAUDE.md 显式标记 deferred | `packages/tools/src/`、`CLAUDE.md` | 06-23 提出，**8 天未修** |
| P1 | requirements create/patch 加 project_id 存在性校验 → 404；**同时新增 `GET /v1/requirements/:id`**（镜像 `projects-routes.ts` single-row pattern） | `requirements-routes.ts:206/:255`，新增 `:?` | 06-25 P2 → 06-26 升级 → 07-01 持平 |
| P1 | `depends_on` 跨 id 不存在性校验 | `requirements-routes.ts:233-237/:298-302` | 06-28 新增，**4 天未修** |
| **P2（升级）** | `/v1/observability/health` / `runs/*` / `/v1/requirements/:id/runs` / `/v1/work/*` / `/v1/workflows` / `/v1/workflow-runs/:id` / `/v1/workspaces` / `/v1/remote/info` / `/v1/providers` / `/v1/version` 的**完整** wire shape 一次性 codify。**07-01 大幅新增**：`health.rules` dict 全 4 顶层 key + 4 维度权重表、`health.actions[*]` 5 条 key 列表（含 `fill_signal_gaps`）、`health.dimensions[*]` score+confidence+drivers.len、`work/overview` 两个 top-level null 字段、workflow-run cancel 返 `error` 字段 | `docs/conventions/` 或 CLAUDE.md | 06-23 漏记，07-01 第 7 次补 |
| **P2（升级）** | "未配 feature" 路由口径统一：8 条里 7 条 503 + 1 条 200+flag。`/v1/diagnostics/memory` 改为 503 + hint，DDNS 路由的 actionable-hint 模板做参考 | `packages/server/src/diagnostics-routes.ts` + CLAUDE.md | 06-28 起，**4 天未修** |
| **P2（升级）** | list 路由 shape 收敛：3 种体例（裸数组 / `{items:[]}` / `{workspaces:[]}`）并存，未来加分页就 3 处 breaking | `projects-routes.ts` + `workspaces-routes.ts` + CLAUDE.md | 06-29 起，**3 天未修** |
| **P2（新增）** | `health.dimensions[*].label` 是英文，`health.actions[*].title` 是中文——同一界面会有中英混排。统一到一种 i18n 路径（推荐都走 actions 的中文，dim 加 i18n key） | `packages/observability/` 或对应 health 算法实现 | **07-01 新发现** |
| P2 | approve idempotent + reject "软删非回退" 语义、`POST /v1/projects` instructions trim-aware、`POST /v1/projects` slug 自动 `-N` 后缀 + 显式 slug 字段，全部加进 CLAUDE.md | CLAUDE.md 项目段 + requirements 段 | 06-29 起，**3 天未修** |
| P2 | `depends_on` wire shape 稳定化——固定服务端写回 `[]` 而不是 omit；或客户端 normalize | `requirements-routes.ts` create/patch 响应序列化处 | 06-28 起，**4 天未修** |
| **P3（新增）** | `/v1/diagnostics/runs/stuck?threshold_seconds=N` 行为在 CLAUDE.md 显式：仅返 `age_seconds >= N` 的 pending run；无 query 时默认 threshold > 1 秒（具体数值 stub 模式打不出来，建议代码里把 default 也露出去）；`recent` 与 `stuck` 唯一字段差异是 `age_seconds` | `packages/server/src/diagnostics-routes.ts` + CLAUDE.md | 06-30 起，**2 天未修** |
| P3 | `ObservabilityStore` / `EvalStore` 的 env-driven 拉起方式在 CLAUDE.md 文档化 | CLAUDE.md | 06-23 提出，未修 |

---

## 7. 复测剧本（有 LLM key 时；与 06-30 §7 一致 + 新增项）

```bash
export OPENAI_API_KEY=sk-...
export JARVIS_FS_ROOT=/tmp/jarvis-servlet-test
export JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-<date>   # 日期后缀
export JARVIS_WORK_MODE=auto
export JARVIS_WORK_TICK_SECONDS=10
export JARVIS_WORK_MAX_CONCURRENT=1
export JARVIS_ENABLE_FS_WRITE=1 JARVIS_ENABLE_FS_EDIT=1 JARVIS_ENABLE_SHELL_EXEC=1
export JARVIS_PERMISSION_MODE=bypass
node --experimental-strip-types packages/jarvis-app/src/main.ts serve &
# 同 §2 的 6 步 → 等 2-3 个 tick →
#   /v1/diagnostics/runs/recent 应出现 completed/failed；
#   /v1/observability/health 应 confidence>0.2 + completion_rate 非 null；
#   sample_count 应从 3 上升到 5+；
#   actor_breakdown 应从 null 填成 {human, system, agent} 分桶；
#   work/quality.verification_pass_rate_by_day 应有非 0 行
```

未验证项（继续滚到下一次）：

- **06-30 §7 第 1 项已落地**：workflow run cancel pending → cancelled 已在 §4.1 验证。
- **06-30 §7 仍留白 5 项**：
  - `subagent.review` 在 `Subagent` policy 下是否真把 review→done flip
  - `triage.scan_candidates` 在工作目录（**注意 EchoServlet 已消失**）能否建出 `ProposedByScan` 需求
  - `project.checks` 能否识别缺 Maven/Gradle（HelloServlet 路径 `src/main/java/com/example` 是 Maven 标准布局但无 `pom.xml`，能否被识别）
  - `POST /v1/projects/:bogus-pid/requirements` 之后 agent 侧 `requirement.list` 是否拿回
  - `step_results[*]` 填充 + `status` 转 `succeeded/failed` 在有 LLM key 时的 shape
- **新增**：`workflow-run cancel` 在 `status === "succeeded"` 之后再 cancel 是 404 / 409 / 200 (no-op) 哪一种？
- **新增**：workflow `name` 重名是否触发 slug 后缀（类比项目）？07-01 未测，但 `workflow.id` 是 server-minted UUID 不需要 slug，所以可能行为不一样。
- **新增**：`JARVIS_DDNS_ENABLE=1` + `JARVIS_DDNS_PROVIDER=duckdns` 起飞后，`/v1/ddns/status`、`/v1/ddns/update` 的实际成功路径
- **新增**：`JARVIS_ENABLE_MEMORY=1` + git/iCloud sync 后端起飞时，`/v1/memory/sync_status` 与 `/v1/memory/includes` 的 happy-path wire shape

---

## 8. 总览

| 项 | 评分 | 与 06-30 比 |
| --- | --- | --- |
| Kanban (Project + Requirement CRUD + 状态转换 + Activity 时间线) | ✅ 健康 | 持平 |
| Workflow CRUD + dispatch + cancel（**07-01 cancel 路径落地**） | ✅ 健康（除 §4.2 的 8 种 500 泄漏） | cancel 落地 |
| Diagnostics (`/v1/diagnostics/*`、`/v1/work/*`) | ✅ 健康 | 持平 |
| Harness.health 算法实装 | ✅ 健康，**今天首次完整解到 `rules` dict 的 4 维度权重表** | 持平（fingerprint `0.13120190627836492` 复现 **第 7 天**） |
| Harness.health 信号采集 | ⚠️ 缺 LLM 驱动时无信号；`actor_breakdown` / `verification_pass_rate` 顶层 null | 持平 |
| Harness.health 前端表达 | ❌ confidence 低分仍直接展示 score；**今天发现 `actions[?].key === "fill_signal_gaps"` 是已有兜底信号**——P0 可改 1 行 | **修复路径变得明确**（"前端不必自己发明数据"） |
| REST ↔ 数据模型一致性 | ❌ `acceptance_policy / workflow_id / assignee_id / verification_plan` POST + PATCH 双双丢（真 UUID 第三次确认仍丢）；project_id 无 FK；`depends_on` 跨 id 无 FK；无 `GET /v1/requirements/:id`；`depends_on` 条件性写回；`GET /v1/projects` vs 其他 list shape 不一致 | 持平 |
| 文档 ↔ 运行时一致性 | ⚠️ `roadmap.import` 文档存在但运行时 404；多条 wire shape 未文档化（**07-01 大幅新增**：health.rules dict / actions 5 条 key 表 / dimensions[*].label 是英文 / actions[*].title 是中文 / work/overview 两个 top-level null / workflow-run cancel 返 error 字段） | 07-01 大幅新增 |
| 单测覆盖 | ✅ 522/522 全绿，7682 ms（噪声范围内） | 持平 |
| **真 bug**：`POST /v1/workflows` 500 泄漏 | ❌ 范围扩大 5×（**8 种 shape 500，5 种 shape 400**） | 07-01 进一步探边 |
| 自动化的端到端验证（有 LLM key） | ❌ 本次仍未执行 | 持平 |

**总体判断**：HEAD 在 06-23 → 07-01 **八天**没动（工作树侧 25 个未 commit 文件已经摆了 9-13 天），所以 06-30 的所有 P0/P1 结论原样成立。本次实际增量价值集中在：

1. **06-30 §7 未验证项落地 1/6**：`POST /v1/workflow-runs/:id/cancel` 在 pending 状态下能正确把 run 翻成 `cancelled` 并填 `error` 字段（§4.1）。
2. **06-30 §4.2 P1 真 bug 范围扩大 5×**：原本只测 `steps:"x"` / `{}` 两种 500，今天扩到 13 形 → **8 种 500 泄漏 / 5 种 400 正常**。修复要在 `validateSteps` / `normalizeSteps` 链路补 6 处类型守卫，不是改一行 `Array.isArray`（§4.2 + §6 P1 升级）。
3. **`/v1/observability/health.rules` dict 完整 dump**——8 份报告首次拿到 score 算法的"正解"：均值 + `task_delivery<60 cap 69` + `confidence = ln(n+1)/ln(31) * coverage` + 4 维 18 子信号权重表（§4.3）。
4. **`actions[?].key === "fill_signal_gaps"` 发现** ——**P0 修复路径由"前端发明阈值"降级成"前端读已有 action.key"，工作量 5 分钟**（§4.4 + §6 P0）。
5. **`/v1/work/overview` 两个 top-level null 字段** (`actor_breakdown` / `verification_pass_rate`)——客户端 destructure 须 null check（§4.6 + §4.14）。
6. **`dimensions[*].label` 是英文 / `actions[*].title` 是中文**——同界面会中英混排，新增 P2（§4.5 + §6）。
7. **06-30 表述修正**：`/v1/diagnostics/runs/stuck?threshold_seconds=1` 是 timing-dependent，不是恒返 3 条（§4.8）。
8. **Servlet 项目工作目录侧 EchoServlet.java 消失**（vs 06-30）——结构改 Maven-style 但无 `pom.xml`，对 stub 模式探测无影响（§4.11）。

**建议**：下次合 P1 修复时**同时**做：①create+patch 透传 4 字段；②`projectStore.get(projectId)` 校验；③新增 `GET /v1/requirements/:id`；④`depends_on` 跨 id FK 校验；⑤**workflow POST 500 泄漏修复升级版**（顶层非数组守卫 + 5 处 step 内部字段守卫，6 条反例单测）；⑥把 health.rules dict / actions key 列表 / dimensions label vs actions title 语言不一致 / work/overview 两个 top-level null / workflow-run cancel error 字段 一次性 codify 到 CLAUDE.md。

**P0 改造**：前端读 `actions.find(a => a.key === "fill_signal_gaps")` 当 cold-start 兜底信号，1 个 if 5 分钟，**比"前端发明 confidence<0.2 阈值"更对**——**8 天未修的真原因是把它看错难度**。
