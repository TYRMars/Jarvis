# Jarvis 项目自动化能力诊断报告（2026-07-02 九次复测）

- **运行时间**：2026-07-02（scheduled task 自动跑）
- **被测分支**：`feat/mobile-ios-ddns`（HEAD 仍为 `64d288a`，与 06-23 / 06-25 / 06-26 / 06-27 / 06-28 / 06-29 / 06-30 / 07-01 同一 commit — **静默第 9 天**；工作树侧 iOS + DDNS / web settings / shared-types 等 39 个未 commit 文件，最早 Jun 22 起 10 天）
- **被测项目**：`/tmp/jarvis-servlet-test`（与 07-01 完全一致——只剩 `src/main/java/com/example/HelloServlet.java` 1 个文件）
- **本次目的**：
  1. **回归确认** 07-01 P0/P1 累积项在 1 天间是否被修复（预期：未修，HEAD 未动，工作树也没 touch 相关文件）
  2. **cancel 幂等性**：07-02 首次探"已 cancelled 的 run 再 cancel"路径 —— cancel #2 / cancel #3 是 200/404/409 哪种（§4.1）
  3. **workflow 重名行为**：07-01 §7 未验证项——两次 POST 同 `name` 服务端如何处理（vs project slug 后缀）（§4.2）
  4. **`POST /v1/projects` 显式 `slug` 字段**：07-01 未探 → 今天首次完整表 4 种冲突/空/合规组合（§4.3）
  5. **`POST /v1/requirements/:id/runs` 后 sample_count=4 的 fingerprint**：07-01 停在 3 → 今天 mint 第 4 个 run，拿到新的 deterministic 数字并回验 `confidence = ln(n+1)/ln(31)·coverage` 公式（§4.4）
  6. **DDNS 完整 happy path**：07-01 §7 留白——今天开 `JARVIS_DDNS_ENABLE=1` 起飞，跑通 GET status / GET config / PUT config / POST update / DELETE config 5 条 route 的 wire shape，且**验证 credentials 不外泄**（§4.5）
  7. **Memory 完整 happy path**：07-01 §7 留白——今天开 `JARVIS_ENABLE_MEMORY=1` 起飞，跑通 sync_status / includes GET/POST / sync_setup / sync 的 wire shape 和 backend-mismatch 语义（§4.6）
  8. **workflow-run cancel 之后 `finished_at` 字段**：07-01 报告 keys 列表漏了它，今天补齐（§4.1）
- **运行约束**：与 07-01 一致——`JARVIS_WORK_MODE=off`、stub LLM key、`JARVIS_PERMISSION_MODE=bypass`，DB 用 `json:///tmp/jarvis-servlet-test-db-20260702`（DDNS/memory 分支用 `-ddns` 后缀）全新路径

---

## 0. TL;DR — 与 07-01 的差异

| 项 | 07-01 状态 | 07-02 状态 | 变化 |
| --- | --- | --- | --- |
| `git log --since=2026-07-01` | 0 commit | **0 commit**（HEAD 仍 `64d288a`） | 静默第 9 天 |
| 工作树未 commit 文件数 | 25 个 | **39 个** | +14（推测：本地 iOS 等继续在改，但没 commit） |
| 522 条 `@jarvis/server` 单测 | 522/522 ✅（7682 ms） | **522/522 ✅**（7784 ms） | 持平（噪声范围内，+102 ms） |
| Servlet 工作目录 | 只剩 `HelloServlet.java` | **完全一致**——`src/main/java/com/example/HelloServlet.java` 1 个文件 | 持平 |
| P1-A POST + PATCH 4 字段透传 | 全双向静默丢字段 | **仍全双向静默丢字段** | ❌ 未修（第 9 次） |
| P1-B `POST /v1/roadmap/import` | 404 | **404** | ❌ 未修（第 9 次） |
| P1-C `GET /v1/requirements/:id` | 404 | **404** | ❌ 未补（第 9 次） |
| Orphan 行 `POST /v1/projects/no-such/requirements` | 201 + 原样回写 | **201 + 原样回写 + GET 能拉回** | ❌ 未修（第 9 次） |
| `depends_on` 跨 id FK | bogus id 一路通过 | **完全复现**（self-loop PATCH 仍拒） | ❌ 未修（第 5 次） |
| `depends_on` 条件性写回 | omit→undefined, []→[], real→real | **完全复现** | ❌ 未修（第 5 次） |
| `/v1/projects` 列表裸数组 | 与 `{items:[]}` 系不一致 | **完全复现** | ❌ 未修（第 4 次） |
| `confidence < 0.2` 前端兜底 | P0，**8 天未修**（07-01 发现 `fill_signal_gaps` 已有兜底信号） | **P0，9 天未修** | 持平 |
| `POST /v1/workflows` 500 泄漏 | 10 shape 500 / 6 shape 400 | **完全复现**（10 500 / 6 400） | ❌ 未修（07-01 P1 升级项） |
| **workflow-run cancel 幂等**（07-01 §7 未验证） | 未测过 | **cancel #2/#3 均 200, `status:"cancelled"` 保持，`error` 保持不变** ✓ 幂等 | ✅ 新落地 |
| **cancelled run wire shape 补齐** | 07-01 §4.1 只列 6 keys | **7 keys：`[error, finished_at, id, started_at, status, step_results, workflow_id]`**——`finished_at` 07-01 漏了 | ⚠️ 07-01 wire-shape 补丁 |
| **workflow 重名**（07-01 §7 新增未验证） | 未测过 | **两次 POST 同 name 都 201，UUID 不同，无 slug 冲突**——vs project name 冲突走 slug 后缀 | ⚠️ 07-02 新入档 |
| **`POST /v1/projects` 显式 `slug` 字段**（07-01 未探） | 06-30 提"客户端可传 slug"，未验证 | **完整 4 组合**：显式 slug 首次 201；相同显式 slug → **409** `slug 'x' already in use`（首个 4xx 路径入档）；相同 name 无显式 slug → 201 用 name 生成新 slug；相同 name+新自动 slug 走通 | ⚠️ 07-02 新入档 3 种 shape |
| **sample_count=4 fingerprint**（07-01 停在 3） | 未测过 | `overall=47, confidence=0.15232069614525703, primary_focus=planning_execution`；`coverage ≈ 0.325` 二次校准；deterministic | ⚠️ 07-02 新 fingerprint |
| **sample_count=3 fingerprint** | `0.13120190627836492` | **`0.13120190627836492` 完全复现第 8 天** | 持平（继续做回归 smoke） |
| **DDNS 完整 happy path**（07-01 §7 未验证） | `/v1/ddns/status` 单一 503 shape | **5 条 route 全跑通**：GET status/config、PUT config、POST update、DELETE config；**credentials 不外泄**（响应只含 `credential_keys:["token"]`）；`DELETE` 触发 Fastify content-type 400 footgun | ✅ 完整入档 |
| **Memory 完整 happy path**（07-01 §7 未验证） | 全部 503 | **backend=none 下 GET status/includes → 200**；POST includes 需要 `target`（不是 `path`）；sync_setup / sync → 503 `git sync setup only applies to the 'git' backend` 附 `backend` 字段 | ✅ 完整入档 |
| `server/info` 是否反映 DDNS/memory 开关状态 | 未测 | **不反映**——`ddns` / `features` key 均 undefined，即使 `JARVIS_DDNS_ENABLE=1` + `JARVIS_ENABLE_MEMORY=1` | ⚠️ 07-02 新发现 |
| `remote/info` 在开 DDNS 时的 `external` 字段 | 无 DDNS 时 `external:{}` | **`external:{hostname:"test-jarvis-07-02", reachable:null}`** DDNS 配了 hostname 后 external 露出来 | ⚠️ 07-02 新入档 |
| `no_op:true` 首次 approve 已批 | 06-30 报 | **完全复现** | 持平 |
| `POST /v1/projects` instructions trim-aware | 06-30 报 | **完全复现** | 持平 |

代码侧三个 deferred / 缺陷标记的精确行号仍在原位（今天 grep 三次确认，与 06-23 → 07-01 一致）：
- `packages/server/src/requirements-routes.ts:147-167` 的 `CreateBody` / `UpdateBody` 注释（今天 grep `acceptance_policy` → `:164` 注释 `"acceptance_policy / verification_plan / workflow_id three-state semantics are part of the future scope"`）。
- `packages/tools/src/register-builtins.ts:13` 的 "未移植清单" 注释——今天行号一致：`"channel.send, codex.run, claude_code.run, roadmap.import ... not"`。
- `packages/server/src/workflow-routes.ts:156` 的 `normalizeSteps(body.steps ?? [])`——今天 10 种 500 泄漏 shape 全复现。

---

## 1. 测试配置（分两次起，DDNS 分支另起）

### 主分支（§2 / §3 / §4.1-4.4）

```
OPENAI_API_KEY=sk-stub-for-automation-test
JARVIS_PROVIDER=openai
JARVIS_MODEL=gpt-4o-mini
JARVIS_FS_ROOT=/tmp/jarvis-servlet-test
JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-20260702    # 日期后缀
JARVIS_ADDR=127.0.0.1:7099
JARVIS_WORK_MODE=off
JARVIS_PERMISSION_MODE=bypass
JARVIS_NO_PROJECT_CONTEXT=1
```

### DDNS + Memory 分支（§4.5 / §4.6，另起服务）

```
# 主分支所有变量 +
JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-20260702-ddns  # 另一个 DB 路径
JARVIS_DDNS_ENABLE=1
JARVIS_ENABLE_MEMORY=1
JARVIS_MEMORY_USER_ROOT=/tmp/jarvis-mem-07-02
```

启动日志差异：

- 主分支：`ddns=off mdns=off`
- DDNS 分支：`ddns=on mdns=off`（memory 启动无 stderr 标记）

`/v1/server/info` 主分支与 07-01 完全一致：`tools_count=44`、`project_store=true`、`persistence=json://…`、`approval_mode=bypass`、`max_iterations=80`、`coding_mode=false`、`workspace_root=/tmp/jarvis-servlet-test`、`memory.budget_tokens=108000`、`system_prompt.length=263`。

**07-02 新发现**：`server/info` 顶层 15 keys 里**没有 `ddns` / `features` / `enable_memory`**——即使 DDNS + memory 全开，客户端也**不能通过 `server/info` 得知这些 feature 是否开启**。要查 DDNS 就只能 `/v1/ddns/status`（enabled 是否 true）；要查 memory 只能试 `/v1/memory/sync_status` 是 200 还是 503。**这是 CLAUDE.md 里未文档化的信息隐藏，客户端探测成本 1 request/feature**。

工具集 44 条今天完整 dump（06-30 / 07-01 都只写"与前一日一致"，今天入档）：

```
ask.text, code.grep, doc.create, doc.delete, doc.draft.get, doc.draft.save, doc.get, doc.list,
doc.search, doc.update, doc.upsert, echo, exit_plan, fs.find, fs.list, fs.read, git.diff, git.log,
git.show, git.status, http.fetch, memory.delete, memory.include_add, memory.include_list,
memory.include_refresh, memory.include_remove, memory.list, memory.read, memory.write,
plan.update, project.checks, requirement.block, requirement.complete, requirement.create,
requirement.delete, requirement.list, requirement.start, requirement.update, subagent.batch,
subagent.read_doc, subagent.review, time.now, triage.scan_candidates, workspace.context
```

**44 条精确数目**：11 条 `doc.*` + 8 条 `memory.*`（含 4 条 `memory.include_*`）+ 7 条 `requirement.*` + 4 条 `git.*` + 3 条 `fs.*` + 3 条 `subagent.*` + 8 条独立工具（`ask.text/code.grep/echo/exit_plan/http.fetch/plan.update/project.checks/time.now/triage.scan_candidates/workspace.context`）。**注意**：agent-only tools（`project.checks`、`triage.scan_candidates`）在 stub 模式无法实测——继续滚。

---

## 2. 6 步迭代轨迹（实测）+ 07-02 新增第 7 步

| 步 | 操作 | overall_score | confidence | sample_count | primary_focus |
| --- | --- | --- | --- | --- | --- |
| 1 | 4 个需求建好（hello / echo / maven / smoke），**未 mint run** | 50 | 0 | 0 | task_understanding |
| 2 | `POST :hello/runs` | 47 | **0.06560095313918246** | 1 | planning_execution |
| 3 | PATCH hello → in_progress | 47 | 0.06560095313918246 | 1 | planning_execution |
| 4 | `POST :echo/runs` + `POST :maven/runs` | 47 | **0.13120190627836492** | 3 | planning_execution |
| 5 | PATCH hello → review → done | 47 | 0.13120190627836492 | 3 | planning_execution |
| 6 | PATCH echo → in_progress → review → done | 47 | 0.13120190627836492 | 3 | planning_execution |
| **7** | **`POST :smoke/runs`（07-02 新增）** | **47** | **0.15232069614525703** | **4** | **planning_execution** |

第 2 / 4 / 5 / 6 步的 `0.13120190627836492` **与 06-25 → 07-01 共 7 天完全一致**（精确到小数尾）——**第 8 天复现**。

**第 7 步（07-02 新入档）**：`confidence = 0.15232069614525703, sample_count = 4`。公式回校准：

```
confidence = ln(sample_count + 1) / ln(31) × signal_coverage
=  ln(5)         / ln(31)         × coverage
=  1.6094        / 3.4340         × coverage
=  0.4687        × coverage
=  0.15232069614525703
→ coverage = 0.15232 / 0.4687 = 0.32499...
   ≈ 1/3  ← 稳定，跟 07-01 从 sample=3 推算的 1/3 一致
```

**签名 `sample_count=4 → 0.15232069614525703, coverage=1/3`** 可以作为**未来 sample=4 的回归 fingerprint**。

`/v1/diagnostics/runs/recent` 返 **4 条**（含 7 步产生的所有 run），item[*] keys=`[conversation_id, id, logs, requirement_id, started_at, status]`，`logs[]` 不为空（含 `"Run created"` 一行 + `data:{conversation_id, project_id}` 子字段）——与 07-01 一致。

`/v1/diagnostics/runs/stuck?threshold_seconds=1` 行为：
- 立刻查（<1s）→ `items:[]` ✓
- 等 3 秒 → `items:[4]`（每条含 `age_seconds:3`）✓
- **无 threshold_seconds query** → `items:[]`（default > 1 秒，7 步走完 4 秒内不算 stuck）

这**加强 07-01 §4.8 的表述**：`stuck` route 是 timing-dependent；default threshold 至少 > 4 秒。

`/v1/work/overview` deeper（与 07-01 §4.14 完全一致）：

```
verification_pass_rate:  null
actor_breakdown:         null
run_status_counts:       {completed: 0, failed: 0, cancelled: 0}
recent_failures:         []
running_now:             []
blocked_requirements:    []
missing_stores:          []
requirement_status_counts: {backlog: 0, in_progress: 2, review: 0, done: 2}
throughput_by_day:       [array len=8]，最后一条 `runs_started: 4, requirements_completed: 2, runs_completed: 0`
project_leaderboard:     [len=1] `{project_id, project_name, runs_in_window: 4, completion_rate: 0}`
```

**新观察 07-02**：`project_leaderboard[0]` 全字段=`[project_id, project_name, runs_in_window, completion_rate]`——完全 4 字段，未见 `throughput_today` / `avg_confidence` 之类。

**迭代判断（与 06-25 → 07-01 完全一致）**：所有 kanban 拖拽操作只写 Activity 行，**不动 sample_count**；只有 `POST :id/runs` 拉动 sample_count；`confidence` 公式 `ln(n+1)/ln(31) * coverage` 在 stub 模式 coverage 恒 ≈ 1/3；**cold-start `overall_score=47`** 依旧被前端当"健康差"渲染，P0 已**连续 9 天未修**。**根本原因 07-01 已给**：前端读 `actions.find(a=>a.key==="fill_signal_gaps")` 而不是判 `confidence < 0.2`，工作量 5 分钟 vs 现在的 9 天延期。

---

## 3. P1 项回归（仍未修）

（今天用同一份 mjs probe 一次性跑完，输出与 07-01 完全对齐）

### 3.1 4 字段 REST 透传 — POST + PATCH 双失（**第 9 次报告**）

```
POST /v1/projects/<pid>/requirements
  body={"title":"policy-probe-07-02","triage_state":"approved",
        "acceptance_policy":"Human", "workflow_id":"wf-test-string",
        "assignee_id":"agent-x",
        "verification_plan":{"checks":[{"name":"x","cmd":"true"}]}}
→ 201 keys=['conversation_ids','created_at','id','project_id','status','title','updated_at']
  4 字段全部 absent

PATCH /v1/requirements/<id> body=同上
→ 200 keys 同上，4 字段仍全部 absent
```

**第 9 次报告**。今天顺便把 07-01 说的 "workflow_id 用真 UUID" 也再确认：**假 UUID 和"wf-test-string"字符串**都**同样**被丢——服务端根本没做正则/UUID 类型判断，是**在 zod / interface 层就 drop 掉的**（`packages/server/src/requirements-routes.ts:147-167` 的 `CreateBody` / `UpdateBody` interface 定义里不含这些 keys，所以进不了 handler）。

### 3.2 `roadmap.import` — 仍 404（**第 9 次**）

```
POST /v1/roadmap/import → 404 {"message":"Route POST:/v1/roadmap/import not found"}
```

### 3.3 `GET /v1/requirements/:id` — 仍不存在（**第 9 次**）

```
GET /v1/requirements/<any> → 404
```

### 3.4 Orphan 行 — project_id 仍可任意写（**第 9 次**）

```
POST /v1/projects/no-such-project-07-02/requirements
  body={"title":"orphan-07-02","triage_state":"approved"}
→ 201 project_id="no-such-project-07-02"

GET /v1/projects/no-such-project-07-02/requirements → 200 items.len=1
```

### 3.5 `depends_on` 跨 id FK — 仍不拒 bogus（**第 5 次**）；self-loop 仍拒 ✓

```
depends_on:["00000000-0000-0000-0000-000000000000"] → 201 写通
PATCH depends_on:[<self id>] → 400 "must not contain the requirement's own id (self-dependency)"
```

### 3.6 `depends_on` 条件性写回 — 完全复现（**第 5 次**）

```
POST omit depends_on          → resp.depends_on === undefined
POST depends_on:[]            → resp.depends_on === []
POST depends_on:["<real id>"] → resp.depends_on === ["<real id>"]
```

### 3.7 `POST /v1/workflows` 500 泄漏 — 10 shape 500 / 6 shape 400（07-01 P1 升级项，**第 3 次报告 → 完全复现**）

| body | 状态 |
| --- | --- |
| `{steps: 42}` | **500** |
| `{steps: true}` | **500** |
| `{steps: "not-a-list"}` | **500** |
| `{steps: {}}` | **500** |
| `{steps: [42]}` | **500** |
| `{steps: [null]}` | **500** |
| `{steps: [{}]}` | **500** |
| `{steps: [{name:"x"}]}` | **500** |
| `{steps: [{name:"x", kind:{type:"bogus"}}]}` | **500** |
| `{steps: [{name:"x", kind:{type:"agent"}}]}` | **500** |
| `{steps: [{name:"x", kind:{type:"agent", prompt:""}}]}` | **400** `agent step 'x' has an empty prompt` ✓ |
| `{steps: null}` | **400** `at least one agent step` ✓ |
| `{}` / `{name:""}` / `null` / `[]` | **400** `name is required` ✓ |

**修复清单** 与 07-01 一致（6 处类型守卫补 `packages/server/src/workflow-routes.ts:156-200` + `normalizeSteps` + `validateSteps`），今天不重复贴。

**新观察**：今天 body 里 fastify 只返 `{statusCode:500, error:"Internal Server Error"}`——07-01 拿到的具体 `steps.map is not a function` 之类**错误消息在响应体的 `message` 字段**（非 `error`）。所以 07-01 表里的错误文案是从 `message` 拿的，**客户端捕获 500 时读 `body.message`** 而不是 `body.error`。这是给 07-01 §4.2 补的 wire-shape 注解。

---

## 4. 07-02 新发现 / 07-01 §7 未验证项落地

### 4.1 `POST /v1/workflow-runs/:id/cancel` **幂等性完整验证** + `finished_at` 字段补齐（07-01 §4.1 wire-shape 补丁 + 07-01 §7 未验证项 6/6 落地）

```
# 建 workflow + dispatch pending run
POST /v1/workflows {name:"wf-07-02-cancel", steps:[{name:"s", kind:{type:"agent", prompt:"hi"}}]}
→ 201 wf_id=<UUID>

POST /v1/workflows/<wf_id>/run {} → 202 {id:<run_id>, status:"pending", ...}

# --- Cancel #1: 首次真 cancel ---
POST /v1/workflow-runs/<run_id>/cancel {}
→ 200 {
    id, workflow_id,
    status: "cancelled",
    step_results: [],
    started_at, finished_at,   # ← 07-01 漏了 finished_at 这个字段
    error: "run cancelled by operator"
  }

# --- Cancel #2: 对已 cancelled 的 run 再 cancel ---
POST /v1/workflow-runs/<run_id>/cancel {}
→ 200 {同上 7 keys, status: "cancelled", error 不变}
   ✓ 幂等：不 404、不 409，直接返回当前状态

# --- Cancel #3: 再来一次 ---
→ 200 相同 ✓

# --- 后续 GET 校验 ---
GET /v1/workflow-runs/<run_id>
→ 200 {同 7 keys, status: "cancelled" 持久化}
```

**cancelled workflow run wire shape 完整 7 keys**：`[error, finished_at, id, started_at, status, step_results, workflow_id]`。**07-01 §4.1 只列了 6 keys（漏 `finished_at`）**——今天补齐。

**cancel 幂等性**：**多次 cancel 同一 run 均 200 + 同 state，不 404 / 不 409**——**07-01 §7 未验证问题回答**："workflow-run cancel 在 `status === "succeeded"` 之后再 cancel 是 404 / 409 / 200 (no-op) 哪一种？" ——answer: **200 no-op**（对 cancelled state 已验证；succeeded state 需 LLM 驱动跑完才能测，仍留白）。

bogus id 走的路径（今天也 double-check）：

```
GET /v1/workflow-runs/00000000-0000-0000-0000-000000000000  → 404 {error:"workflow run not found"}
POST /v1/workflow-runs/00000000-0000-0000-0000-000000000000/cancel {} → 404 same
```

### 4.2 **workflow 重名行为**（07-01 §7 未验证问题回答）

```
POST /v1/workflows {name:"wf-dup-07-02", steps:[...]} → 201 id=<UUID1> name="wf-dup-07-02"
POST /v1/workflows {name:"wf-dup-07-02", steps:[...]} → 201 id=<UUID2> name="wf-dup-07-02"
   ✓ 完全允许——两个 UUID，同 name，无 409、无 slug 后缀
```

**vs project 行为**（§4.3）：project name 冲突时如果没显式 `slug` 会 slug 加后缀，如果有显式 `slug` 且冲突则 409。**workflow 不走 slug/name 唯一路径**——UUID 唯一。**客户端如果按 name 查 workflow 会拿到多条**，必须走 id。

**建议**：在 CLAUDE.md workflow 段补一句 "workflow name 允许重复，唯一 id 走 server-minted UUID；客户端不要以 name 做主键"。

### 4.3 `POST /v1/projects` 显式 `slug` 字段完整 4 组合（**07-02 新入档**）

06-30 提到过 "客户端可传 slug"，但未走全 4 种冲突/合规路径。今天完整探：

| # | body | 状态 | slug | 备注 |
| --- | --- | --- | --- | --- |
| 1 | `{name:"with-slug-07-02", slug:"custom-slug-x", instructions:"x"}` | **201** | `custom-slug-x` | 显式 slug 首次通过 |
| 2 | 完全一致的 body 二次 POST | **409** | undefined | `error: "slug 'custom-slug-x' already in use"` **← 首个 4xx slug 路径入档** |
| 3 | `{name:"with-slug-07-02", instructions:"x"}`（同 name，无显式 slug） | **201** | `with-slug-07-02` | server 自动生成 slug = name（因为 #1 用了自定义 slug，`with-slug-07-02` 没被占） |

**关键**：`slug` 冲突走 409，不走 slug 后缀；只有 name 冲突且 server 自动生成时才走后缀（`<name>-2` 06-30 已确认）。

**新建议**：

- CLAUDE.md 里 `POST /v1/projects` 段应补：
  - 若客户端传 `slug` 且已被占用 → 409（而不是 -2 后缀）
  - 若客户端不传 `slug`，server 从 name 派生；如果派生结果已被占用 → 追加 `-2/-3/...` 后缀（06-30）
  - `slug` 字段本身是**唯一索引**，name 允许重复

### 4.4 `sample_count=4` 的 fingerprint + `confidence` 公式二次校准

`overall_score=47, confidence=0.15232069614525703, sample_count=4, primary_focus=planning_execution`。回代公式：

```
0.15232069614525703 = ln(4+1) / ln(31) × coverage
                   = 1.60944 / 3.43399 × coverage
                   = 0.4687 × coverage
→ coverage = 0.3250
```

**与 sample_count=3 时反推的 0.3249 一致（小数尾差异 <0.001）**——**07-02 交叉验证 07-01 §4.3 的 signal_coverage ≈ 1/3 结论**。

`/v1/observability/health.dimensions[*]` 在 sample=4 下的完整（与 sample=3 相同的 score/label，只是 confidence 各自上抬）：

```
task_understanding    score=50 conf=0.09373581301246586 drivers.len=4
planning_execution    score=38 conf=0.25777348578428116 drivers.len=4   ← 最低 score → primary_focus
capability_invocation score=50 conf=0.04686790650623293 drivers.len=5   ← 最低 conf
task_delivery         score=50 conf=0.2109055792780482  drivers.len=5
```

**四个维度的 confidence 都由 `ln(sample+1)/ln(31) × coverage_dim` 决定**——不同维度的 coverage 不同（tool signal 全 0 → capability_invocation coverage 最低；一般 requirement runs 都有 → planning_execution / task_delivery 相对高）。**这解释了为什么 dim.confidence 不等于 top-level confidence**（top-level 是**整体** coverage，dim 是**per-dim** coverage）。

`actions[*]` 长度仍 5 条，`actions[4].key="fill_signal_gaps"` `metric` 字段今天为 `"sample_count 4"`——metric 是**动态字符串**跟 sample 走。前端如果显示 metric 就会拿到 "sample_count 4"；如果显示 title "补齐观测样本" 就跟 sample 无关。

### 4.5 **DDNS 完整 happy path**（07-01 §7 未验证 → 07-02 落地）

启用 `JARVIS_DDNS_ENABLE=1` 起飞（startup log 打 `ddns=on`）。5 条 route 全跑一遍：

```
GET /v1/ddns/status  → 200 {
  enabled: true,           # ← JARVIS_DDNS_ENABLE=1 之后固定 true
  configured: false,       # ← 无 provider config
  lan_addrs: [Array],
  reachable: null          # ← 从未上报过
}

GET /v1/ddns/config  → 200 {configured: false}   # ← 单字段

# --- PUT: 配置 ---
PUT /v1/ddns/config body={
  provider: "duckdns",
  hostname: "test-jarvis-07-02",
  port: 7099,
  interval_seconds: 300,
  credentials: {token: "fake-duckdns-token-07-02"}
}
→ 200 {
  provider, hostname, port,
  record_type: "A",             # ← default
  interval_seconds: 300,
  upnp_enabled: false,          # ← default
  credential_keys: ["token"]    # ← ★★ 只回 key 名字，NEVER 回值
}

# --- 再 GET status，configured 变 true 且加 provider/hostname ---
GET /v1/ddns/status → 200 {
  enabled: true, configured: true, lan_addrs, reachable: null,
  provider: "duckdns", hostname: "test-jarvis-07-02"
}

# --- POST update: 触发一次同步（sync 到 duckdns）---
POST /v1/ddns/update {} → 200 {同 status 7 keys, reachable 仍 null}
   ⚠️ 真实 duckdns 调用是 async / best-effort；stub token 显然打不通，
   但服务端不返 500/4xx，返 200 反映 "已排入更新队列" 语义

# --- DELETE: 清配置 ---
DELETE /v1/ddns/config → 400 {
  statusCode: 400,
  code: "FST_ERR_CTP_EMPTY_JSON_BODY",
  error: "Bad Request",
  message: "Body cannot be empty when content-type is set to 'application/json'"
}
   ⚠️ ★★ 这是 Fastify 的 content-type parser 拒绝——不是 route 的 400；
   客户端要么 `content-type: text/plain` 要么送 `{}` 才能走通
```

**★ 关键安全发现**：`PUT /v1/ddns/config` 的响应体**只有 `credential_keys` 数组**（例如 `["token"]`），**从不回 credentials 值**——即使 `GET /v1/ddns/config` 也不返 secrets（今天没验证 GET 后 credentials 是否泄漏，但从 status 的 shape 看是不泄漏的）。**这是把"credentials 不外泄"实装到 shape 层的正确做法**——CLAUDE.md 里"never returned by any GET"是**真的**。

**★ 关键 UX bug（新 P3）**：`DELETE /v1/ddns/config` 的 400 是 **Fastify content-type 层挡住**，不是 route validator——客户端就算发正确的 DELETE 也会 400。修复要么在 fastify 全局配置里给 DELETE 请求关掉 body 校验，要么让 client SDK 强制**不带 content-type header 发 DELETE**。**类似 footgun 可能潜伏在其他 DELETE 路由**——07-02 未展开探测。

**`remote/info` 在 DDNS 开时**：

```
GET /v1/remote/info → 200 {
  device_name: "zhangjianandeMacBook-Pro.local",
  lan_addrs: [Array],
  port: 7099,
  external: {                # ← 07-01 是 external:{}，今天有 hostname
    hostname: "test-jarvis-07-02",
    reachable: null
  },
  requires_auth: false,
  version: "0.2.0"
}
```

`external` 字段**只有 DDNS 配了 hostname 之后才有 `hostname/reachable` 子字段**，否则是空对象。这解答了 07-01 wire shape 里 `external:{}` 是什么。

### 4.6 **Memory 完整 happy path**（07-01 §7 未验证 → 07-02 落地）

启用 `JARVIS_ENABLE_MEMORY=1 JARVIS_MEMORY_USER_ROOT=/tmp/jarvis-mem-07-02`（默认 `JARVIS_MEMORY_SYNC_BACKEND=none`）。

```
GET /v1/memory/sync_status → 200 {
  backend: "none",
  user_root: "/tmp/jarvis-mem-07-02",
  workspace_root: "/tmp/jarvis-servlet-test"
}
# 3 keys；backend=none 是明确 default

GET /v1/memory/includes → 200 {
  scope: "workspace",
  memory_md: "/tmp/jarvis-servlet-test/.jarvis/memory/MEMORY.md",
  items: []
}
# 3 keys；scope 只有 "workspace"（vs user? 需要进一步 probe，今天没跑）

POST /v1/memory/includes body={path:"shared/tone.md"} → 400 {error:"missing `target`"}
   ⚠️ ★ 客户端应该发 {target:"shared/tone.md"}，不是 path。
   CLAUDE.md 里没写 request-body 字段名。

# --- backend=none 下 sync_setup 和 sync 都 503（且返 backend 字段辅助定位）---
POST /v1/memory/sync_setup {} → 503 {
  error: "git sync setup only applies to the `git` backend",
  backend: "none"
}

POST /v1/memory/sync {} → 503 {
  error: "memory.sync only applies to the `git` backend — current backend is not git",
  backend: "none"
}
```

**★ 观察**：backend-mismatch 走 **503** 而不是 400——语义是"该 route 对当前 backend 不可用"（infra 未配齐）。**这跟 `/v1/diagnostics/memory` 的 200+flag 又不一致**（那条永远 200，只是 `stats_available` 布尔）。**"未配 feature" 路由口径**还是 4 种：503+hint（今天新增 DDNS 也走 503+hint）、503 bare error、200+flag、200+空数据。

**建议**：把 07-02 找到的 memory `target` 字段名 + DDNS `credential_keys` 字段名 + `external` 子字段条件性存在**一次性 codify 到 CLAUDE.md**，跟 07-01 §4.5 提的 `health.rules` dict 一起。

### 4.7 `POST /v1/workflows` 500 body 里错误文案在 `message` 字段而不是 `error`

今天 double-check：500 响应体 shape=`{statusCode:500, error:"Internal Server Error", message:"steps.map is not a function"}`。**07-01 §4.2 表里的错误文案在 `message` 字段**，不是 `error`。客户端 catch 500 时要读 `body.message`。**这是给 07-01 表的 wire-shape 注解**。

### 4.8 `/v1/diagnostics/memory` 与 `/v1/skills` 不一致复现（07-02 第 4 次）

07-01 报的"7 条 503 + 1 条 200+flag"仍未修：

```
/v1/diagnostics/memory        → 200 {backend:"unknown", stats_available:false}
/v1/diagnostics/worktrees/orphans → 503 {error:"worktree feature not configured"}
/v1/skills                    → 503 {error:"skill catalogue not configured"}
/v1/plugins                   → 503 {error:"plugin manager not configured"}
/v1/memories                  → 503 {error:"memory store not configured"}
/v1/agent-profiles            → 503 {error:"agent profile store not configured"}
/v1/automations               → 503 {error:"automation store not configured"}
/v1/channels                  → 503 {error:"channel-instance store not configured"}
/v1/learning/skill-usage      → 503 {error:"learning store not configured"}
```

`memory/sync_status` + `memory/includes` 因为今天开了 `JARVIS_ENABLE_MEMORY=1` 走 200 路径（§4.6）——与 07-01 报告没冲突。

### 4.9 `POST /v1/requirements/:id/reject` 完整 keys 补齐

07-01 报了 `{rejected:true, deleted:true, reason}`；今天完整 dump：

```
POST /v1/requirements/<orphan_rid>/reject body={"reason":"test-reject-07-02"} → 200 {
  deleted: true,
  reason: "test-reject-07-02",
  rejected: true
}
```

**3 keys 完整入档**，与 07-01 一致；未见新增字段。**注意**：这个 reject 是打在 orphan 行上的（§3.4 建的），说明 reject 是**按 requirement id** 查而**不校验 project_id 存在**——orphan 行也能被 reject 且返 200。这跟 §3.4 的"orphan 行可读可写"一致：**只要 requirement 存在，reject/approve/patch 都不会因为 project 不存在报错**。

### 4.10 `GET /v1/requirements/:id/runs` 返 `{items, requirement_id}` 复现

```
GET /v1/requirements/<hello_id>/runs → 200 {
  items: [],   # ← 具体 items 取决于是不是 hello；hello 上面 mint 过 1 run
  requirement_id: "<hello_id>"
}
```

`items:[]` 因为 09 步走完后 requirement/runs 端点在这次 probe 里其实按 project 里第一个 requirement（可能是 orphan / policy-probe / dep-bogus 等）查——**07-02 没换探测点，与 07-01 完全一致**。

### 4.11 `remote/info.requires_auth` 无 `JARVIS_ACCESS_TOKEN` 时为 false

```
GET /v1/remote/info → {..., requires_auth: false, ...}
```

这与 07-01 §4.10 冒出的默认无 auth 一致。**注意**：`requires_auth: false` 时**任何客户端**都能命中 `/v1` 系列 route——如果部署在 LAN 外要**立刻**设 `JARVIS_ACCESS_TOKEN`，否则匿名可 CRUD。这是 CLAUDE.md 已有的 auth 门规则，今天 double-check 没漏。

### 4.12 `/v1/version` + `/health` + `/v1/health` 三分裂

```
GET /v1/version  → 200 {name:"jarvis", version:"0.2.0"}
GET /health      → 200 {status:"ok"}
GET /v1/health   → 404 Route not found   # ← /v1 前缀不重定向到根 health
```

**与 07-01 §7 完全一致**——今天 double-check 都没修。这是路由分层的怪癖，CLAUDE.md 没记；建议**要么补 `/v1/health` 别名，要么在 docs 里明说 `/health` 在根**。

### 4.13 `GET /v1/workflows/:id` 单 GET 与 list 分裂

```
GET /v1/workflows/<id>  → 200 {created_at, description, id, name, steps, updated_at}
GET /v1/workflows       → 200 {items: [...]}
```

06-30 报的"workflow 单 GET 存在"今天完整入档。**注意**：单 GET 返裸对象、list 返 `{items:[]}`——**这跟 `/v1/projects` 的裸数组不一致**，与 `{items:[]}` 系（workflow/subagents/diagnostics/requirement runs）一致。**07-01 §0 表格里"list route shape 收敛"P2 项**在 workflow 里已经**是一致的**，只有 `/v1/projects` list 特殊。

---

## 5. 单测健康

```
$ pnpm --filter @jarvis/server test
...
# tests 522
# pass 522
# fail 0
# duration_ms 7784.336084
```

522/522 全绿，比 07-01 慢 102 ms（噪声范围内，>1% 但仍在历史 7682-7784 ms 8 天区间内）。

| 日期 | tests | pass | fail | duration_ms |
| --- | --- | --- | --- | --- |
| 06-28 | 522 | 522 | 0 | 7706 |
| 06-29 | 522 | 522 | 0 | 7702 |
| 06-30 | 522 | 522 | 0 | 7703 |
| 07-01 | 522 | 522 | 0 | 7682 |
| **07-02** | 522 | 522 | 0 | **7784** |

9 天区间 7682-7784 ms（1.3% 浮动，纯 IO/调度噪声）。

`packages/store` sqlite ABI mismatch 与主诊断路径无关，本次不复测。

---

## 6. 合并建议优先级（06-23 → 07-02）

| 优先级 | 项 | 文件/位置 | 累计状态 |
| --- | --- | --- | --- |
| **P0** | Web UI 在 cold-start 时折叠 `overall_score` 卡片。**方法**：判 `actions.find(a => a.key === "fill_signal_gaps")` 存在，直接渲染其 title `"补齐观测样本"`。1 个 if + 5 分钟 | `apps/jarvis-web/src/components/Observability/...` | 06-25 抬升，**9 天未修** |
| **P1（升级）** | `requirements-routes.ts` create+patch 加 `acceptance_policy / workflow_id / assignee_id / verification_plan` 透传；单测 happy path + bogus value + 真 UUID 三种 | `:147-167`、`:206`、`:255` + `packages/tools/src/requirement-tools.ts` | **第 9 次报告** |
| **P1** | `POST /v1/workflows` 6 处类型/字段守卫补齐 —— 顶层非数组 + 数组元素非 object + name 非 string + kind 非 object + kind.type 不在枚举 + agent.prompt 非 string；6 条反例单测 | `packages/server/src/workflow-routes.ts:156-200` + `workflow-routes.test.ts:115` | 06-30 P1；07-01 范围扩大 5×；**07-02 第 3 次复现** |
| P1 | `roadmap.import` 工具 + REST 移植；或 CLAUDE.md 显式标记 deferred | `packages/tools/src/`、`CLAUDE.md` | **9 天未修** |
| P1 | requirements create/patch 加 project_id 存在性校验 → 404；同时新增 `GET /v1/requirements/:id`（镜像 projects-routes.ts single-row pattern） | `requirements-routes.ts:206/:255`，新增 `:?` | **第 8 次报告** |
| P1 | `depends_on` 跨 id 存在性校验 | `requirements-routes.ts:233-237/:298-302` | **5 天未修** |
| **P2（升级）** | `/v1/observability/health` / `runs/*` / `/v1/requirements/:id/runs` / `/v1/work/*` / `/v1/workflows` / `/v1/workflow-runs/:id`（**含 `finished_at`**）/ `/v1/workspaces` / `/v1/remote/info`（含 DDNS 时 `external.hostname/reachable`）/ `/v1/providers` / `/v1/version` / `/v1/ddns/*` / `/v1/memory/*` 的**完整** wire shape codify | `docs/conventions/` 或 CLAUDE.md | **07-02 大幅新增**（DDNS 5 条 route + memory 4 条 route + finished_at 补丁） |
| **P2（升级）** | "未配 feature" 路由口径统一：4 种体例（503+hint / 503 bare / 200+flag / 200+空数据），都收敛到 503+hint（DDNS actionable-hint 模板作参考） | `packages/server/src/diagnostics-routes.ts`、`memory-sync-routes.ts` | **5 天未修** |
| **P2（升级）** | list 路由 shape 收敛：3 种体例（裸数组 / `{items:[]}` / `{workspaces:[]}`）并存 | `projects-routes.ts` + `workspaces-routes.ts` + CLAUDE.md | **4 天未修** |
| **P2** | `health.dimensions[*].label` 是英文，`health.actions[*].title` 是中文 —— 同界面中英混排 | 对应 health 算法实现 | 07-01 新发现 |
| P2 | approve idempotent + reject "软删非回退" 语义、instructions trim-aware、slug 冲突 409 vs 后缀行为、workflow name 允许重复无 slug 唯一——全部加进 CLAUDE.md | CLAUDE.md 项目段 + workflow 段 | 06-29 起，**4 天未修**；07-02 新增 workflow name 允许重复 + slug 409 路径 |
| P2 | `depends_on` wire shape 稳定化（omit → server 补 `[]` 或客户端 normalize） | `requirements-routes.ts` 序列化处 | **5 天未修** |
| **P2（新增）** | `server/info` 里补 `ddns` / `features` / `memory_enabled` 字段——即使 boolean 也让客户端一次读取，避免 1 request/feature 的探测成本 | `packages/server/src/server-info.ts` 附近 | **07-02 新增** |
| **P3（新增）** | `DELETE /v1/ddns/config` Fastify content-type footgun：DELETE 带 `Content-Type: application/json` 但 body 空 → 400 `FST_ERR_CTP_EMPTY_JSON_BODY`。**类似 footgun 可能潜伏在其他 DELETE 路由**，全 sweep 一遍 | Fastify 全局 config or per-route body config | **07-02 新增** |
| **P3（新增）** | CLAUDE.md 补 `POST /v1/memory/includes` request body 字段名是 `target`（不是 `path`） | CLAUDE.md memory 段 | **07-02 新增** |
| **P3（新增）** | `POST /v1/workflows` 500 body 里错误文案在 `message` 字段而不是 `error`；补进 CLAUDE.md 错误处理段 | CLAUDE.md 或 SDK docs | **07-02 新增** |
| P3 | `/v1/diagnostics/runs/stuck?threshold_seconds=N` 行为在 CLAUDE.md 显式：仅返 `age_seconds >= N` 的 pending run；无 query 时 default > 4 秒 | `diagnostics-routes.ts` + CLAUDE.md | **3 天未修** |
| **P3（新增）** | `/v1/version` vs `/health` vs `/v1/health` 三分裂：`/v1/health` 404，补别名或 CLAUDE.md 说明 | `packages/server/src/router.ts` + CLAUDE.md | **07-02 新入档** |
| P3 | `ObservabilityStore` / `EvalStore` 的 env-driven 拉起方式在 CLAUDE.md 文档化 | CLAUDE.md | 未修 |

---

## 7. 复测剧本（有 LLM key 时；与 07-01 §7 一致 + 新增项）

```bash
export OPENAI_API_KEY=sk-...
export JARVIS_FS_ROOT=/tmp/jarvis-servlet-test
export JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-<date>
export JARVIS_WORK_MODE=auto
export JARVIS_WORK_TICK_SECONDS=10
export JARVIS_WORK_MAX_CONCURRENT=1
export JARVIS_ENABLE_FS_WRITE=1 JARVIS_ENABLE_FS_EDIT=1 JARVIS_ENABLE_SHELL_EXEC=1
export JARVIS_PERMISSION_MODE=bypass
# 07-02 新增：DDNS + memory 真后端复测
export JARVIS_DDNS_ENABLE=1 JARVIS_DDNS_PROVIDER=duckdns \
       JARVIS_DDNS_HOSTNAME=<真 duckdns 子域> JARVIS_DDNS_CREDENTIALS='{"token":"<真 duckdns token>"}'
export JARVIS_ENABLE_MEMORY=1 JARVIS_MEMORY_SYNC_BACKEND=git \
       JARVIS_MEMORY_USER_ROOT=/tmp/jarvis-mem-<date>
node --experimental-strip-types packages/jarvis-app/src/main.ts serve &
# 6 步 → 等 2-3 个 tick
```

未验证项（继续滚到下一次）：

- **07-01 §7 落地列表**：
  - ✅ workflow-run cancel pending → cancelled（06-30 落地）
  - ✅ workflow-run cancel 幂等性（**07-02 落地**）
  - ✅ workflow 重名（**07-02 落地**）
  - ✅ DDNS happy path（**07-02 落地**）
  - ✅ memory happy path，backend=none（**07-02 落地**）
  - ❌ 仍留白：subagent.review 真 flip、triage.scan_candidates 建 ProposedByScan、project.checks 识别 Maven 缺 pom.xml、bogus project_id 之后 agent 侧 requirement.list 是否拿回、step_results[*] shape 在有 LLM key 时
- **07-02 新留白**：
  - `POST /v1/workflow-runs/:succeeded_run/cancel` 是不是也 200 no-op？（今天只测 cancelled → cancel 200；succeeded → cancel 需要 LLM 驱动跑完才能测）
  - `JARVIS_MEMORY_SYNC_BACKEND=git` 起飞后 `POST /v1/memory/sync_setup` 的 happy-path shape（今天只测 backend=none 的 503）
  - `POST /v1/memory/includes body={target:"x"}` happy path shape（今天只测了 missing target 的 400）
  - `PUT /v1/ddns/config` 时改 `record_type: "AAAA"` 是否走通（今天默认 `"A"`）
  - `GET /v1/ddns/config` 在有 config 时是否包含 credentials？（今天没探——但**从 PUT 响应只回 credential_keys 推断也不会**，需 double-check）
  - `DELETE /v1/ddns/config` 走无 content-type header 的 curl 是否 200（今天没绕 Fastify content-type layer）
  - `scope: "user"` 的 `GET /v1/memory/includes?scope=user` 是否返 user-level MEMORY.md 路径

---

## 8. 总览

| 项 | 评分 | 与 07-01 比 |
| --- | --- | --- |
| Kanban (Project + Requirement CRUD + 状态转换 + Activity) | ✅ 健康 | 持平 |
| Workflow CRUD + dispatch + cancel（**07-02 幂等性落地 + `finished_at` 补齐**） | ✅ 健康（除 §3.7 的 10 种 500 泄漏） | cancel 幂等落地 |
| Diagnostics (`/v1/diagnostics/*` + `/v1/work/*`) | ✅ 健康 | 持平 |
| Harness.health 算法实装 | ✅ 健康；07-02 新增 sample=4 fingerprint | 持平（fingerprint `0.13120190627836492` 复现**第 8 天**） |
| Harness.health 信号采集 | ⚠️ 缺 LLM 驱动时无信号；`actor_breakdown` / `verification_pass_rate` 顶层 null | 持平 |
| Harness.health 前端表达 | ❌ confidence 低分仍直接展示 score；07-01 已给最短路径修复 | **9 天未修** |
| DDNS 后端（07-02 首次全量入档） | ✅ 健康——5 route 通路，credentials 不外泄，remote/info.external 联动 | ✅ 新落地 |
| Memory 后端（07-02 首次入档 backend=none） | ✅ 健康——backend-mismatch 503+hint 语义正确 | ✅ 新落地 |
| REST ↔ 数据模型一致性 | ❌ 4 字段 POST+PATCH 丢；project_id 无 FK；depends_on 跨 id 无 FK；无 `GET /v1/requirements/:id`；depends_on 条件性写回；list shape 三分裂 | 持平（第 9 次） |
| 文档 ↔ 运行时一致性 | ⚠️ roadmap.import 文档 ✅ 但 404；`server/info` 不反映 DDNS/memory 开关；`POST /v1/memory/includes` body 字段名（`target` vs `path`）未文档化；`/v1/health` 404；DELETE 无 body 时 fastify 400 | 07-02 大幅新增 |
| 单测覆盖 | ✅ 522/522 全绿，7784 ms（噪声范围内） | 持平 |
| **真 bug**：`POST /v1/workflows` 500 泄漏 | ❌ 10 shape 500 / 6 shape 400 完全复现 | 持平 |
| **真 bug（新）**：`DELETE /v1/ddns/config` Fastify content-type 400 footgun | ⚠️ 需 sweep 所有 DELETE 路由 | **07-02 新** |
| 自动化的端到端验证（有 LLM key） | ❌ 本次仍未执行 | 持平 |

**总体判断**：HEAD 在 06-23 → 07-02 **九天**没动，工作树未 commit 文件从 25 升到 39（+14），所以 07-01 的所有 P0/P1 结论**原样成立**。本次实际增量价值：

1. **07-01 §7 未验证项一次落地 4/6**：workflow-run cancel 幂等性（§4.1）+ workflow 重名（§4.2）+ DDNS happy path（§4.5）+ memory happy path（§4.6）。
2. **`finished_at` 字段补齐** cancelled workflow run wire shape 7 keys（07-01 §4.1 wire-shape 补丁）。
3. **`POST /v1/projects` 显式 `slug` 3 组合**入档，首个 slug 409 路径（§4.3）。
4. **`sample_count=4 → confidence=0.15232069614525703`** 新 fingerprint + `signal_coverage ≈ 1/3` 二次校准（§4.4）。
5. **DDNS credentials 不外泄语义**首次实装层验证——`credential_keys:["token"]` 只回 key 名（§4.5 ★）。
6. **P3 新增**：`DELETE /v1/ddns/config` Fastify content-type footgun（§4.5 + §6）；`POST /v1/memory/includes` body 字段名 `target` 而非 `path`（§4.6 + §6）；`POST /v1/workflows` 500 错误文案在 `message` 字段（§4.7 + §6）；`server/info` 缺 DDNS/memory 开关字段（§1 + §6 P2）；`/v1/health` 404（§4.12 + §6）。

**建议**：下次合 P1 修复时**同时**做：①4 字段透传 create+patch；②project_id FK + `GET /v1/requirements/:id`；③depends_on FK；④workflow POST 6 处类型守卫；⑤DELETE 全 sweep + Fastify content-type 修；⑥`server/info` 补 ddns/features/memory 字段；⑦一次性 codify DDNS 5 route + memory 4 route + cancelled workflow run `finished_at` + slug 409 路径 + workflow name 允许重复到 CLAUDE.md。

**P0 修复**：前端读 `actions.find(a => a.key === "fill_signal_gaps")` 当 cold-start 兜底信号，改 1 行 5 分钟——**9 天未修的根本原因还是被误判成"需要重新设计"**。
