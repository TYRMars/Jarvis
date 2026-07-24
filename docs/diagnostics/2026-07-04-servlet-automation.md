# Jarvis 项目自动化能力诊断报告（2026-07-04 十一次复测）

- **运行时间**：2026-07-04（scheduled task 自动跑）
- **被测分支**：`feat/mobile-ios-ddns`（HEAD 仍为 `64d288a`，与 06-23 → 07-03 同一 commit — **静默第 11 天**；工作树侧 39 个未 commit 文件与 07-03 完全一致，未 +/−）
- **被测项目**：`/tmp/jarvis-servlet-test`
  - **07-04 差异**：`src/main/java/com/example/HelloServlet.java` 今天启动时**又回来了**（07-03 报告里"启动时消失、手动重建"），13 行版本一字不差；07-03 手动重建的文件本身留在磁盘上，说明是 07-03 的 fixture 修复"复活"了基线，本轮不再动 fixture。
  - `.jarvis/memory/{MEMORY.md, shared/}` 目录树是 07-03 memory probe 留下的 residual —— 空 MEMORY.md + `shared/tone.md`；跟本轮 probe 无冲突（本轮 target 用 `/tmp/shared-memory-07-04`）。
- **本次目的**：
  1. **回归确认** 07-03 P0/P1/P2 累积项在 1 天间是否被修复（预期：未修，静默第 11 天）
  2. **DDNS 配置跨启动持久化**：`~/.local/share/jarvis/ddns.json` 07-03 → 07-04 是否原样存活（预期：是；07-03 PUT 的 `test-jarvis-07-03-aaaa` 应作为 07-04 启动的"上一状态"复现）
  3. **07-03 §7 未验证项落地**：`DELETE /v1/memory/includes` 幂等性（重复 DELETE 同一 target 是 200 no-op 还是 404）
  4. **`GET /v1/ddns/config` 从未入档的 wire shape**（07-02/07-03 未列 GET/PUT 一致性）
  5. **`POST /v1/ddns/update` 语义澄清**：07-03 已知"返 status shape 不返 `{ok}`"，07-04 二次校准
  6. **cross-day fingerprint**：sample=1/3/4 三个 confidence 常数与 07-03 完全一致是第 11 天
- **运行约束**：与 07-03 一致 —— `JARVIS_WORK_MODE=off`、stub LLM key、`JARVIS_PERMISSION_MODE=bypass`；DB 用日期后缀 `-20260704` 全新路径。DDNS + memory 分支另起 `-20260704-ddns` 后缀

---

## 0. TL;DR — 与 07-03 的差异

| 项 | 07-03 状态 | 07-04 状态 | 变化 |
| --- | --- | --- | --- |
| `git log --since=2026-07-03` | 0 commit | **0 commit**（HEAD 仍 `64d288a`） | 静默**第 11 天** |
| 工作树未 commit 文件数 | 39 个 | **39 个** | 持平 |
| 522 条 `@jarvis/server` 单测 | 522/522 ✅（7777 ms） | **522/522 ✅**（7896 ms） | 持平（+119 ms 噪声） |
| Servlet 工作目录 | 只剩空目录树，本次手动重建 | **`HelloServlet.java` 完整**（07-03 手动重建的 13 行文件留下来了）；07-03 memory probe 的 `.jarvis/memory/` residual 也在 | 07-04 免重建 |
| P1-A POST + PATCH 4 字段透传 | 全双向静默丢字段 | **仍全双向静默丢字段** | ❌ 未修（第 11 次） |
| P1-B `POST /v1/roadmap/import` | 404 | **404** | ❌ 未修（第 11 次） |
| P1-C `GET /v1/requirements/:id` | 404 | **404** | ❌ 未修（第 11 次） |
| Orphan 行 `POST /v1/projects/no-such/requirements` | 201 + 原样回写 | **201 + 原样回写 + GET 能拉回** | ❌ 未修（第 11 次） |
| `depends_on` 跨 id FK bogus | 通过 | **完全复现** | ❌ 未修（第 7 次） |
| `depends_on` 条件性写回 | omit→undefined, []→[], real→real | **完全复现** | ❌ 未修（第 7 次） |
| `/v1/projects` 列表裸数组 | 与 `{items:[]}` 系不一致 | **完全复现** | ❌ 未修（第 6 次） |
| `confidence < 0.2` 前端兜底 | P0，**10 天未修** | **P0，11 天未修** | 持平 |
| `POST /v1/workflows` 10 shape 500 泄漏 | 10 500 / 6 400 | **完全复现**（10 500 / 6 400） | ❌ 未修（第 5 次） |
| workflow-run cancel 幂等 + `finished_at` 不刷新 | cancel #1/#2/#3 200，`finished_at` 首次锁定 | **完全复现**（cancel #1/#2/#3 均 200，`finished_at=2026-07-03T19:07:03.288Z` 三次一字不差） | 持平 |
| cancelled run wire shape 7 keys | `[error, finished_at, id, started_at, status, step_results, workflow_id]` | **完全复现** | 持平 |
| workflow 重名 | 两次 POST 同 name 都 201 UUID 不同 | **完全复现** | 持平 |
| `POST /v1/projects` 显式 `slug` 3 组合 | 显式 slug 首次 201 / 相同显式 slug 409 / 相同 name 无 slug 201 | **完全复现**（`4.3.slug2` 409 `"slug 'custom-slug-07-04' already in use"`） | 持平 |
| sample_count=1/3/4 三 fingerprint | `0.06560095313918246 / 0.13120190627836492 / 0.15232069614525703` | **完全复现（第 11 天）** | 持平 |
| DDNS 配置持久化路径 | `~/.local/share/jarvis/ddns.json`（0600 + 明文） | **持久化跨 07-03 → 07-04 存活**：启动前 `hostname:"test-jarvis-07-03-aaaa"` 完整从上一天 PUT 留下 | ✅ 07-03 结论跨日再校准 |
| `ddns.status` 8 keys | `[configured, enabled, hostname, lan_addrs, last_result, provider, public_ip, reachable]` | **完全复现**（8 keys 一字不差）；`public_ip:"67.200.120.26"` + `last_result.ok:false` 都在 | 持平 |
| `POST /v1/ddns/update` 返 status shape 而非 `{ok}` | 是 | **完全复现**（返 8 keys 完整 status，无 `{ok}` 字段） | 持平 |
| `PUT /v1/ddns/config record_type:"AAAA"` accept | ✅ | **完全复现** | 持平 |
| **`GET /v1/ddns/config`**（07-03 未单独列 GET wire shape） | 隐含 | **200 6 keys `[credential_keys, hostname, interval_seconds, port, provider, record_type, upnp_enabled]`**（严格说 7 keys）；credentials 值仍不外泄 | ⚠️ 07-04 新入档 |
| `DELETE /v1/ddns/config` 无 route（3 shape 探） | 无 header→404，`application/json`+空 body→400，`{}`→404 | **完全复现 3 shape**（07-04 精准再校准；07-02 的 "footgun" 结论 07-03 已修正） | 持平 |
| `POST /v1/ddns/upnp/test` 4 keys | ✅ 复现 | **完全复现**（`mapped:false, externalPort/internalPort:7099, message` — actionable hint） | 持平 |
| `GET /v1/remote/pairing` 4 keys | ✅ 复现 | **完全复现**；`pairing_links.len=3`，`origins` 含今天 PUT 的新 DDNS hostname `test-jarvis-07-04-aaaa`（cross-feature 集成第 2 天回归） | 持平 |
| `GET /v1/remote/info.external` 3 keys | ✅ 复现 | **完全复现**（`hostname/public_ip/reachable`） | 持平 |
| `POST /v1/memory/includes` target=含 MEMORY.md 的目录 | ✅ 落地 | **完全复现**（`shared/tone.md` 400 not found；`/tmp/shared-memory-07-04` 200 4 keys） | 持平 |
| `GET /v1/memory/includes` 加过之后 items | 4 keys `{target, kind:"local_path", resolves, path}` | **完全复现** | 持平 |
| `DELETE /v1/memory/includes` 3 keys | ✅ 落地 | **完全复现**（`{ok, removed, scope}`） | 持平 |
| **`DELETE /v1/memory/includes` 幂等性**（07-03 §7 未验证） | 未测 | **200 no-op**：重复 DELETE 同 target 仍返 200 `{ok:true, removed, scope}` — 与首次 DELETE 完全等价；`{}` 仍返 400 `missing target` | ✅ **07-04 新落地** |
| `POST /v1/memory/includes/refresh` local_path 400 | ✅ 落地 | **完全复现** | 持平 |
| `GET /v1/memory/includes?scope=user` | ✅ 落地 | **完全复现**（scope=user 路径走 `JARVIS_MEMORY_USER_ROOT`） | 持平 |
| backend=none `sync_setup / sync` 503 | ✅ 复现 | **完全复现** | 持平 |
| `server/info` 反映 DDNS/memory feature 开关状态 | 不反映 | **仍不反映** | ❌ 未修（第 3 次） |
| `/v1/health` 404 | 未修 | **未修** | ❌ 未修（第 3 次） |
| `no_op:true` 首次 approve 已批 | 06-30 报 | **完全复现** | 持平 |
| `POST /v1/requirements/:id/reject` orphan 200 | 是 | **完全复现** | 持平 |
| trim-aware instructions 校验 | 是 | **完全复现**（`""` + `"   "` 都 400） | 持平 |

代码侧三个 deferred / 缺陷标记的精确行号仍在原位（今天 grep 三次确认）：
- `packages/server/src/requirements-routes.ts:164` 的 `"verification_plan / workflow_id three-state semantics are part of the full Rust handler but out of scope for this port"` 注释（07-03 报告已精确到 `:164`，今天完全一致 — 3 行长注释 `:164-166`）。
- `packages/tools/src/register-builtins.ts:13` "未移植清单" 注释 `"channel.send, codex.run, claude_code.run, roadmap.import ... not"`，`:166` `"(not yet ported)"`。
- `packages/server/src/workflow-routes.ts:156` 的 `normalizeSteps(body.steps ?? [])` —— 今天 10 种 500 泄漏 shape 全复现（`:212` 是 PATCH 分支同一 helper 复用点）。

---

## 1. 测试配置（分两次起）

### 主分支（§2 / §3 / §4.1-4.4）

```
OPENAI_API_KEY=sk-stub-for-automation-test
JARVIS_PROVIDER=openai
JARVIS_MODEL=gpt-4o-mini
JARVIS_FS_ROOT=/tmp/jarvis-servlet-test
JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-20260704
JARVIS_ADDR=127.0.0.1:7099
JARVIS_WORK_MODE=off
JARVIS_PERMISSION_MODE=bypass
JARVIS_NO_PROJECT_CONTEXT=1
```

启动日志：
```
[jarvis] persistence connected: json:///tmp/jarvis-servlet-test-db-20260704
[jarvis] serve: provider=openai model=gpt-4o-mini addr=127.0.0.1:7099 fsRoot=/tmp/jarvis-servlet-test coding=false auth=none ddns=off mdns=off promptBytes=263
[jarvis] listening on http://127.0.0.1:7099
```

### DDNS + Memory 分支（§4.5 / §4.6）

```
# 主分支所有变量 +
JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-20260704-ddns
JARVIS_DDNS_ENABLE=1
JARVIS_ENABLE_MEMORY=1
JARVIS_MEMORY_USER_ROOT=/tmp/jarvis-mem-07-04
```

启动日志（DDNS 分支）：
```
[jarvis] persistence connected: json:///tmp/jarvis-servlet-test-db-20260704-ddns
[jarvis] serve: provider=openai model=gpt-4o-mini addr=127.0.0.1:7099 fsRoot=/tmp/jarvis-servlet-test coding=false auth=none ddns=on mdns=off promptBytes=263
[jarvis] listening on http://127.0.0.1:7099
[ddns] duckdns rejected the update (response: "KO") — check the token/subdomain    # ★ 启动后立即打
```

**跨日持久化验证**：起飞后立刻 `GET /v1/ddns/status` 返 `configured:true, hostname:"test-jarvis-07-03-aaaa", record_type:"AAAA", credential_keys:["token"]` —— 完全是**07-03 PUT 后写进 `~/.local/share/jarvis/ddns.json` 的状态**，说明该文件跨 07-03 → 07-04 完整存活。`JARVIS_DB_URL` 换成 `-20260704-ddns` 全新路径**不影响 DDNS**（DDNS 配置在 `~/.local/share/jarvis/ddns.json`，DB URL 在 `~/.local/share/jarvis/conversations/` 或自定义 json 路径 —— 两条持久层完全独立）。这条 07-03 P2 结论今天跨日再校准 ✓。

`/v1/server/info` 主分支：44 tools、`project_store=true`、`persistence=json://…`、`approval_mode=bypass`、`max_iterations=80`、`coding_mode=false`、`workspace_root=/tmp/jarvis-servlet-test`、`memory.budget_tokens=108000`、`system_prompt.length=263` —— **与 07-03 完全一致**。DDNS 分支 `server/info` 同样不含 `ddns`/`features`/`memory_enabled` 顶层字段（第 3 次确认）。

工具集 44 条与 07-03 完全一致（今天不重复 dump）。

---

## 2. 6+1 步迭代轨迹（实测）

| 步 | 操作 | overall_score | confidence | sample_count | primary_focus |
| --- | --- | --- | --- | --- | --- |
| 1 | 4 个需求建好（hello / echo / maven / smoke），**未 mint run** | 50 | 0 | 0 | task_understanding |
| 2 | `POST :hello/runs` | 47 | **0.06560095313918246** | 1 | planning_execution |
| 3 | PATCH hello → in_progress | 47 | 0.06560095313918246 | 1 | planning_execution |
| 4 | `POST :echo/runs` + `POST :maven/runs` | 47 | **0.13120190627836492** | 3 | planning_execution |
| 5 | PATCH hello → review → done | 47 | 0.13120190627836492 | 3 | planning_execution |
| 6 | PATCH echo → in_progress → review → done | 47 | 0.13120190627836492 | 3 | planning_execution |
| **7** | **`POST :smoke/runs`** | **47** | **0.15232069614525703** | **4** | **planning_execution** |

**`0.06560095313918246`（sample=1）、`0.13120190627836492`（sample=3）、`0.15232069614525703`（sample=4）三个 fingerprint** 与 06-25 → 07-03 共 10 天完全一致 —— **算法稳定第 11 天**。

`/v1/observability/health.dimensions[*]` sample=4 完整：

| dim | score | confidence |
| --- | --- | --- |
| task_understanding    | 50 | 0.09373581301246586  |
| planning_execution    | 38 | 0.25777348578428116  ← 最低 score → primary_focus |
| capability_invocation | 50 | 0.04686790650623293  ← 最低 conf |
| task_delivery         | 50 | 0.2109055792780482   |

**per-dim confidence 与 07-03 逐位相等** —— fingerprint 稳定第 11 天。

`actions.keys` 完整 5 条 = `[stabilize_delivery_gate, reduce_timeout_and_iteration_failures, tune_tools_and_subagents, sharpen_task_acceptance, fill_signal_gaps]` —— 与 07-01 → 07-03 完全一致，**`fill_signal_gaps` 就是 P0 前端应读的 cold-start 兜底信号**（连续 11 天未修）。

`/v1/diagnostics/runs/recent` 返 **4 条**（含 7 步产生的所有 pending run），item[*] keys=`[conversation_id, id, logs, requirement_id, started_at, status]`——与 07-03 一致。

`/v1/diagnostics/runs/stuck` 行为：
- default（无 query）→ `items:[]` ✓
- `?threshold_seconds=1` → **今天 `items:[]`**（4 条 run 都在 <1s 内建完，没触发 age 阈值）—— 加固 07-01/07-02/07-03 的时间敏感结论

`/v1/work/overview`（15 keys；与 07-03 结构一致）：
```
requirement_status_counts: {backlog: 6, in_progress: 2, review: 0, done: 2}
run_status_counts:         {completed: 0, failed: 0, cancelled: 0}
actor_breakdown:           null           # ★ stub 模式仍 null
verification_pass_rate:    null           # ★ stub 模式仍 null
throughput_by_day:         len=8
project_leaderboard:       len=1 {project_id, project_name, runs_in_window: 4, completion_rate: 0}
```
**backlog=6** 与 07-03 完全对齐（本轮 probe 后续几步同样给同 project 建了 `policy-probe-07-04/dep-bogus-07-04/self-loop-07-04/deps-omit-07-04/deps-empty-07-04/deps-real-07-04` 共 6 个未拖过的 backlog 行）；`in_progress=2, done=2` 与 07-03 一致。**行为与 07-03 完全一致，只是步 7 之后又多建了 6 行**。

**迭代判断（与 06-25 → 07-03 完全一致）**：所有 kanban 拖拽只写 Activity 行，不动 sample_count；只有 `POST :id/runs` 拉动 sample_count；`confidence` 公式 `ln(n+1)/ln(31) × coverage` 在 stub 模式 coverage 恒 ≈ 0.325；**cold-start `overall_score=47` 依旧被前端当"健康差"渲染**，P0 已**连续 11 天未修**。**根本原因 07-01 已给**：前端读 `actions.find(a => a.key === "fill_signal_gaps")` 兜底，改 1 行 5 分钟。

---

## 3. P1 项回归（仍未修）

（今天用 07-03 同一份 mjs probe 一次性跑完，输出与 07-03 完全对齐）

### 3.1 4 字段 REST 透传 — POST + PATCH 双失（**第 11 次报告**）

```
POST /v1/projects/<pid>/requirements
  body={"title":"policy-probe-07-04","triage_state":"approved",
        "acceptance_policy":"Human", "workflow_id":"wf-test-string",
        "assignee_id":"agent-x",
        "verification_plan":{"checks":[{"name":"x","cmd":"true"}]}}
→ 201 keys=['conversation_ids','created_at','id','project_id','status','title','updated_at']
  4 字段全部 absent

PATCH /v1/requirements/<id> body=同上（acceptance_policy/workflow_id/assignee_id/verification_plan）
→ 200 keys 同上，4 字段仍全部 absent
```

**第 11 次报告**。今天 grep 确认拒收发生点仍在 `packages/server/src/requirements-routes.ts:164-166` 的 3 行注释 —— 4 字段没进 `CreateBody` / `UpdateBody` interface，进不了 handler。零改动。

### 3.2 `roadmap.import` — 仍 404（**第 11 次**）

```
POST /v1/roadmap/import → 404 {"message":"Route POST:/v1/roadmap/import not found","error":"Not Found","statusCode":404}
```

### 3.3 `GET /v1/requirements/:id` — 仍不存在（**第 11 次**）

```
GET /v1/requirements/<any> → 404 {"error":"Not Found","message":"...","statusCode":404}
```

### 3.4 Orphan 行 — project_id 仍可任意写（**第 11 次**）

```
POST /v1/projects/no-such-07-04/requirements
  body={"title":"orphan-07-04","triage_state":"approved"}
→ 201 project_id="no-such-07-04"

GET /v1/projects/no-such-07-04/requirements → 200 items.len=1
```

### 3.5 `depends_on` 跨 id FK — 仍不拒 bogus（**第 7 次**）；self-loop 仍拒 ✓

```
depends_on:["00000000-0000-0000-0000-000000000000"] → 201 写通
PATCH depends_on:[<self id>] → 400 "must not contain the requirement's own id (self-dependency)"
```

### 3.6 `depends_on` 条件性写回 — 完全复现（**第 7 次**）

```
POST omit depends_on          → resp.depends_on === undefined
POST depends_on:[]            → resp.depends_on === []
POST depends_on:["<real id>"] → resp.depends_on === ["<real id>"]
```

### 3.7 `POST /v1/workflows` 500 泄漏 — 10 shape 500 / 6 shape 400（**第 5 次报告 → 完全复现**）

| body | status | body.message |
| --- | --- | --- |
| `{steps: 42}` | **500** | `steps.map is not a function` |
| `{steps: true}` | **500** | 同上 |
| `{steps: "not-a-list"}` | **500** | 同上 |
| `{steps: {}}` | **500** | 同上 |
| `{steps: [42]}` | **500** | `Cannot read properties of undefined (reading 'type')` |
| `{steps: [null]}` | **500** | `Cannot read properties of null (reading 'id')` |
| `{steps: [{}]}` | **500** | `Cannot read properties of undefined (reading 'type')` |
| `{steps: [{name:"x"}]}` | **500** | 同上 |
| `{steps: [{name,kind:{type:"bogus"}}]}` | **500** | `steps is not iterable`（weird internal pointer 复现） |
| `{steps: [{name,kind:{type:"agent"}}]}` | **500** | `Cannot read properties of undefined (reading 'trim')` |
| `{steps: [{name,kind:{type:"agent",prompt:""}}]}` | **400** | `agent step 'x' has an empty prompt` ✓ |
| `{steps: null}` | **400** | `workflow must contain at least one agent step` ✓ |
| `{}` / `{name:""}` / `null` / `[]` | **400** | `name is required` ✓ |

修复清单与 07-01/07-02/07-03 一致（6 处类型守卫补 `packages/server/src/workflow-routes.ts:156-200` + `normalizeSteps` + `validateSteps`）。

---

## 4. 07-04 新落地 / 07-03 未验证项落地

### 4.1 `POST /v1/workflow-runs/:id/cancel` **cancel 3 次都幂等 + `finished_at` 首次锁定**（07-03 §4.1 完整回归）

```
# 建 workflow + dispatch pending run
POST /v1/workflows {name:"wf-07-04-cancel", steps:[{name:"s", kind:{type:"agent", prompt:"hi"}}]}
→ 201 wf_id=eb069683-7a2b-4376-a12a-a16b5fb5fd15

POST /v1/workflows/<wf_id>/run {} → 202 {id:<run_id>, workflow_id, status:"pending", step_results:[], started_at}

# --- Cancel #1: 首次真 cancel ---
POST /v1/workflow-runs/<run_id>/cancel {}
→ 200 {
    id, workflow_id,
    status: "cancelled",
    step_results: [],
    started_at,  finished_at: "2026-07-03T19:07:03.288Z",   # ★ UTC 时间戳
    error: "run cancelled by operator"
  }
# 7 keys ★

# --- Cancel #2/#3：对已 cancelled 的 run 再 cancel ---
POST /v1/workflow-runs/<run_id>/cancel {} × 2
→ 200 每次都返 7 keys；state 完全相同；`finished_at` 三次都是首次的 `2026-07-03T19:07:03.288Z`（**不刷新**，与 07-03 结论一致）
```

**07-03 §4.1 关键结论今天二次校准**：`finished_at` 在 cancel #2/#3 保持**首次 cancel 的时间戳**，**不刷新**——这佐证了幂等语义（"记录首次事件时间，后续 no-op"）而非"最后一次 write 时间"。

`GET /v1/workflow-runs/<bogus_uuid>` 未测；`POST /v1/workflow-runs/<bogus_uuid>/cancel` → `404 {error:"workflow run not found"}`（与 07-03 一致）。

### 4.2 workflow 重名允许（07-03 落地，07-04 二次回归）

```
POST /v1/workflows {name:"wf-dup-07-04", steps:[...]} → 201 id=<UUID1> name="wf-dup-07-04"
POST /v1/workflows {name:"wf-dup-07-04", steps:[...]} → 201 id=<UUID2> name="wf-dup-07-04"
```
✓ 二次落地，UUID 唯一，name 允许重复（`bf53fed8` vs `1a0e0c81`）。

### 4.3 `POST /v1/projects` 显式 `slug` 3 组合（07-03 落地，07-04 回归）

| # | body | 状态 | slug |
| --- | --- | --- | --- |
| 1 | `{name:"with-slug-07-04", slug:"custom-slug-07-04", instructions:"x"}` | **201** | `custom-slug-07-04` |
| 2 | 一样的 body 二次 POST | **409** | undefined，`error: "slug 'custom-slug-07-04' already in use"` |
| 3 | `{name:"with-slug-07-04", instructions:"x"}`（同 name，无显式 slug） | **201** | `with-slug-07-04`（server 用 name 派生，未占用） |

### 4.4 `sample_count=1/3/4` 三 fingerprint 稳定第 11 天 —— 见 §2 表。

### 4.5 DDNS 完整第三日：**跨日持久化 + `GET /v1/ddns/config` wire shape 首入档**

#### 4.5.1 持久化跨 07-03 → 07-04 存活 ★（07-03 P2 新入档项跨日再校准）

启动前 `~/.local/share/jarvis/ddns.json` 已存在（07-03 PUT 留下），未删。启动即 `GET /v1/ddns/status`：

```json
{
  "enabled": true,
  "configured": true,
  "lan_addrs": ["192.168.1.164", "198.18.0.1"],
  "reachable": null,
  "provider": "duckdns",
  "hostname": "test-jarvis-07-03-aaaa",          // ← ★ 07-03 PUT 的 hostname 存活
  "public_ip": "67.200.120.26",
  "last_result": {
    "ok": false,
    "message": "duckdns rejected the update (response: \"KO\") — check the token/subdomain"
  }
}
```

**证据链**：
- `JARVIS_DB_URL` 是 `-20260704-ddns` 全新路径（`/tmp/jarvis-servlet-test-db-20260704-ddns` 不存在于启动前）
- 但 DDNS status 里 hostname 是 07-03 PUT 的值 `"test-jarvis-07-03-aaaa"`
- ∴ **DDNS 配置持久层与 `JARVIS_DB_URL` 完全独立**，走 `~/.local/share/jarvis/ddns.json`

**07-03 P2 结论 07-04 跨日再确认**：**API 层永不回值 vs 磁盘层明文** —— 部署到多用户机器上、误 chmod 777、误 tar 打包备份都会外泄 credentials。**建议**在 CLAUDE.md DDNS 段显式写这两层语义分离。

#### 4.5.2 `GET /v1/ddns/status` 8 keys 完整版（07-03 已入档，07-04 二次回归）

```
keys=[configured, enabled, hostname, lan_addrs, last_result, provider, public_ip, reachable]
```

`public_ip` 07-04 起飞立即出现 `"67.200.120.26"`（DDNS runtime 后台 IP 查询在启动早期就异步完成）；`last_result.ok:false` + actionable message 也在（后台首次 update 循环即刻收到 duckdns "KO"）。

#### 4.5.3 `GET /v1/ddns/config` **07-04 首入档 wire shape** ★

07-02/07-03 只单独列了 PUT `/v1/ddns/config` 的返回 shape，从没跑过 GET。今天补齐：

```json
GET /v1/ddns/config → 200 {
  "provider": "duckdns",
  "hostname": "test-jarvis-07-03-aaaa",
  "port": 7099,
  "record_type": "AAAA",
  "interval_seconds": 300,
  "upnp_enabled": false,
  "credential_keys": ["token"]
}
```

**7 keys ★**：`[credential_keys, hostname, interval_seconds, port, provider, record_type, upnp_enabled]`。**注意**：`credentials` 值不返回，只返 `credential_keys` —— 与 PUT 响应一致，**GET/PUT 的 wire shape 对称完全对齐**（这一层"API 永不回值"的对称性 07-03 报告未显式验证）。

#### 4.5.4 `PUT /v1/ddns/config record_type:"AAAA"` ✓（07-03 落地）

```
PUT /v1/ddns/config body={
  provider: "duckdns", hostname: "test-jarvis-07-04-aaaa", port: 7099,
  interval_seconds: 300, credentials: {token: "t2"}, record_type: "AAAA"
}
→ 200 {provider, hostname:"test-jarvis-07-04-aaaa", port, record_type:"AAAA", interval_seconds, upnp_enabled:false, credential_keys:["token"]}
```

**7 keys** 与 §4.5.3 GET 完全对齐（PUT 响应 shape = GET 响应 shape）。

#### 4.5.5 `POST /v1/ddns/update` 返 status 8 keys 完整（07-03 结论 07-04 二次校准）

```
POST /v1/ddns/update {} → 200 {enabled, configured, lan_addrs, reachable, provider, hostname:"test-jarvis-07-04-aaaa", public_ip, last_result:{ok:false, message}}
```

**8 keys 完整 status** —— 未见 `{ok:true}` 之类"命令响应" wrapper，直接返最新 status。这个语义 07-03 已 clarify，今天二次确认（fire-and-forget + immediate-status）。

#### 4.5.6 `DELETE /v1/ddns/config` 3 shape 探（07-03 结论 07-04 二次校准）

```
# 无 header
DELETE /v1/ddns/config → 404 {"message":"Route DELETE:/v1/ddns/config not found","error":"Not Found","statusCode":404}

# application/json + 空 body
DELETE /v1/ddns/config → 400 FST_ERR_CTP_EMPTY_JSON_BODY

# application/json + body='{}'
DELETE /v1/ddns/config → 404 Route not found
```

**07-03 结论一字不差复现**：`DELETE /v1/ddns/config` **根本没有 route**，400 只是 Fastify body-parser 排序抢在 route 匹配之前的假象。

`packages/server/src/ddns-routes.ts` grep 再确认：
```
:56  app.get("/v1/ddns/status")
:62  app.get("/v1/ddns/config")
:69  app.put("/v1/ddns/config")
:82  app.post("/v1/ddns/update")
:93  app.post("/v1/ddns/upnp/test")
:114 app.get("/v1/remote/info")
:137 app.get("/v1/remote/pairing")
```

`app.delete("/v1/ddns/config")` 依旧缺失。

#### 4.5.7 `POST /v1/ddns/upnp/test` 4 keys（07-03 落地，07-04 回归）

```
POST /v1/ddns/upnp/test {} → 200 {
  mapped: false,
  externalPort: 7099,
  internalPort: 7099,
  message: "no UPnP gateway found on the LAN — forward the port manually on your router"
}
```

**4 keys ★**。actionable message 与 07-03 一字不差。

#### 4.5.8 `GET /v1/remote/pairing` 4 keys + DDNS cross-feature integration（07-03 落地，07-04 跨日回归）

```
GET /v1/remote/pairing → 200 {
  device_name: "zhangjianandeMacBook-Pro.local",
  token: null,                                                # ← 无 JARVIS_ACCESS_TOKEN
  origins: [
    "http://192.168.1.164:7099",
    "http://198.18.0.1:7099",
    "http://test-jarvis-07-04-aaaa:7099"                     # ← 今天 PUT 的新 DDNS hostname 直接进 origins
  ],
  pairing_links: [
    {origin: "http://192.168.1.164:7099", link: "jarvis://pair?origin=http%3A%2F%2F192.168.1.164%3A7099&name=zhangjianandeMacBook-Pro.local"},
    {origin: "http://198.18.0.1:7099", link: "jarvis://pair?origin=..."},
    {origin: "http://test-jarvis-07-04-aaaa:7099", link: "jarvis://pair?origin=..."}
  ]
}
```

**4 keys + cross-feature integration 第 2 天回归**：`origins` 与 `pairing_links` 数量对齐（各 3 条），DDNS hostname 直接进 pairing 列表 —— iOS 客户端扫描该 link 可以直接对外网（DDNS）+ LAN 两条路径同时握手。

`pairing_links[*]` 每条 2 keys `{origin, link}`，`link` 是 `jarvis://pair?origin=<urlencoded>&name=<device>` 的 URL 模板。

#### 4.5.9 `GET /v1/remote/info.external` 3 keys（07-03 落地，07-04 回归）

```
GET /v1/remote/info → 200 {
  device_name, lan_addrs, port: 7099,
  external: {
    hostname: "test-jarvis-07-04-aaaa",
    public_ip: "67.200.120.26",       # ← DDNS 配好后即填
    reachable: null                    # ← 未主动探测
  },
  requires_auth: false,
  version: "0.2.0"
}
```

**6 keys 顶层 + 3 keys `external`** —— 与 07-03 一字不差。

### 4.6 Memory 完整第三日：**07-03 §7 未验证项 `DELETE` 幂等性落地**

#### 4.6.1 `GET /v1/memory/includes` scope=workspace / user（07-03 落地，07-04 回归）

```
GET /v1/memory/includes → 200 {
  scope: "workspace",
  memory_md: "/tmp/jarvis-servlet-test/.jarvis/memory/MEMORY.md",
  items: []
}

GET /v1/memory/includes?scope=user → 200 {
  scope: "user",
  memory_md: "/tmp/jarvis-mem-07-04/.jarvis/memory/MEMORY.md",
  items: []
}
```

scope=user 时 `memory_md` 走 `JARVIS_MEMORY_USER_ROOT/.jarvis/memory/MEMORY.md` 路径。

#### 4.6.2 `POST /v1/memory/includes` target 语义（07-03 落地，07-04 回归）

```
POST /v1/memory/includes body={target:"shared/tone.md"} → 400 {error:"include path not found: shared/tone.md"}
```

追代码 `packages/tools/src/memory-tools.ts:886` `normaliseMemoryDir()`：**target 必须是"目录"**，且目录必须**含 MEMORY.md**（直接含 `<target>/MEMORY.md`，或含 `<target>/.jarvis/memory/MEMORY.md`）。

正确写法：

```
mkdir /tmp/shared-memory-07-04 && echo "# Shared tone 07-04" > /tmp/shared-memory-07-04/MEMORY.md

POST /v1/memory/includes body={target:"/tmp/shared-memory-07-04"} → 200 {
  ok: true,
  added: "/tmp/shared-memory-07-04",
  scope: "workspace",
  memory_md: "/tmp/jarvis-servlet-test/.jarvis/memory/MEMORY.md"
}
```

**4 keys ★**。与 07-03 一字不差。

#### 4.6.3 `GET /v1/memory/includes` 加过之后 shape（07-03 落地，07-04 回归）

```
GET /v1/memory/includes → 200 {
  scope: "workspace",
  memory_md: "/tmp/jarvis-servlet-test/.jarvis/memory/MEMORY.md",
  items: [
    {
      target: "/tmp/shared-memory-07-04",
      kind: "local_path",
      resolves: true,
      path: "/tmp/shared-memory-07-04"
    }
  ]
}
```

**item 4 keys ★**：`{target, kind:"local_path", resolves, path}`。

#### 4.6.4 `DELETE /v1/memory/includes` 幂等性 ★★ **07-03 §7 未验证项落地**

```
# 第 1 次 DELETE
DELETE /v1/memory/includes body={target:"/tmp/shared-memory-07-04"} → 200 {
  ok: true,
  removed: "/tmp/shared-memory-07-04",
  scope: "workspace"
}
# 3 keys ✓

# 第 2 次 DELETE 同一 target ← 07-04 关键新落地
DELETE /v1/memory/includes body={target:"/tmp/shared-memory-07-04"} → 200 {
  ok: true,
  removed: "/tmp/shared-memory-07-04",
  scope: "workspace"
}
# 3 keys 完全等价 —— **幂等 no-op**

# 空 target
DELETE /v1/memory/includes body={} → 400 {"error":"missing `target`"}
```

**07-04 关键新结论**：`DELETE /v1/memory/includes` **幂等** —— 重复 DELETE 同一 target 返 200 no-op，不是 404。这跟 `POST /v1/requirements/:id/reject` 的"bogus id 返 404"语义**不一致**（reject 非幂等；delete-include 幂等），也跟 `POST /v1/workflow-runs/:id/cancel` "对已 cancelled 幂等 finished_at 不刷新" 语义**同族**（同为 idempotent no-op）。

**建议**：CLAUDE.md 或 memory-sync-routes.ts 单元测试补一条"delete-include idempotence" 证明。

#### 4.6.5 `POST /v1/memory/includes/refresh` 对 local_path 不适用（07-03 落地，07-04 回归）

```
POST /v1/memory/includes/refresh body={target:"/tmp/shared-memory-07-04"} → 400 {error:"refresh only applies to git+ includes"}
POST /v1/memory/includes/refresh body={} → 400 {error:"missing `target`"}
```

**含义**：`kind:"local_path"` include 是**磁盘直读**，不需要 refresh；只有 `kind:"git"` include 需要 `git pull` 那样的 refresh（07-04 未测 git+ target — 需要 `JARVIS_MEMORY_SYNC_BACKEND=git` + 真 git url，滚下一次）。

#### 4.6.6 backend=none 下 sync_setup / sync 503（07-03 回归）

```
POST /v1/memory/sync_setup {} → 503 {error:"git sync setup only applies to the `git` backend", backend:"none"}
POST /v1/memory/sync {} → 503 {error:"memory.sync only applies to the `git` backend — current backend is not git", backend:"none"}
```
**完整复现 07-03 结论**。

### 4.7 `POST /v1/workflows` 500 body.message 字段（07-03 结论 07-04 三次回归）

10 shape 500 全部返 `{statusCode:500, error:"Internal Server Error", message:"<runtime message>"}`。今天 body.message 内容与 07-03 一字不差：`"steps.map is not a function"` / `"Cannot read properties of undefined ..."` / `"steps is not iterable"`。

### 4.8 不配 feature 的 4 种口径继续复现

```
/v1/diagnostics/memory        → 200 {backend:"unknown", stats_available:false}     # 200+flag
/v1/diagnostics/worktrees/orphans → 503 {error:"worktree feature not configured"}  # 503+hint
/v1/skills                    → 503 {error:"skill catalogue not configured"}        # 503+hint
/v1/plugins                   → 503 {error:"plugin manager not configured"}         # 503+hint
/v1/memories                  → 503 {error:"memory store not configured"}           # 503+hint
/v1/agent-profiles            → 503 {error:"agent profile store not configured"}    # 503+hint
/v1/automations               → 503 {error:"automation store not configured"}       # 503+hint
/v1/channels                  → 503 {error:"channel-instance store not configured"} # 503+hint
/v1/learning/skill-usage      → 503 {error:"learning store not configured"}         # 503+hint
/v1/memory/sync_status        → 503 {error:"memory tools are not enabled — set JARVIS_ENABLE_MEMORY=1 and restart"} # 503+actionable-hint
/v1/memory/includes           → 503 {error:"memory tools are not enabled — set JARVIS_ENABLE_MEMORY=1 and restart"} # 503+actionable-hint
```

**4 种体例**：503+hint 是 8 条主流；200+flag 是 1 条特例（`diagnostics/memory`，即使 `JARVIS_ENABLE_MEMORY=1` + backend=none 也返 200 + `{backend:"unknown", stats_available:false}`）；`memory/sync_status` + `memory/includes` 是"最好实践"的 503+actionable-hint（消息里给出 env var 名字 + 重启指令）—— **建议**统一到这种 actionable-hint 体例。

### 4.9 `POST /v1/requirements/:id/reject` shape 复现（07-03 回归）

```
POST /v1/requirements/<orphan_rid>/reject body={"reason":"test-reject-07-04"} → 200 {rejected:true, deleted:true, reason:"test-reject-07-04"}
```
**3 keys 与 07-03 一致**。orphan 行也能被 reject 且返 200 —— `reject` handler 按 requirement id 查而不校验 project_id 存在，与 §3.4 一致。

### 4.10 `/v1/version` + `/health` + `/v1/health` 三分裂（07-03 回归）

```
GET /v1/version  → 200 {name:"jarvis", version:"0.2.0"}
GET /health      → 200 {status:"ok"}
GET /v1/health   → 404 Route not found
```
**未修（第 3 次）**。

### 4.11 `GET /v1/workflows` vs 单 GET 分裂（07-03 回归）

```
GET /v1/workflows/<id> → 200 {created_at, description, id, name, steps, updated_at}   # 裸对象
GET /v1/workflows      → 200 {items: [...]}                                             # {items:[]}
```
**完全复现**。仍与 `/v1/projects` 的裸数组 3 种 list shape 分裂。

---

## 5. 单测健康

```
$ pnpm --filter @jarvis/server test
# tests 522, pass 522, fail 0, duration_ms 7896.667959
```

522/522 全绿，7896 ms（+119 ms vs 07-03，噪声范围内）。

| 日期 | tests | pass | fail | duration_ms |
| --- | --- | --- | --- | --- |
| 06-28 | 522 | 522 | 0 | 7706 |
| 06-29 | 522 | 522 | 0 | 7702 |
| 06-30 | 522 | 522 | 0 | 7703 |
| 07-01 | 522 | 522 | 0 | 7682 |
| 07-02 | 522 | 522 | 0 | 7784 |
| 07-03 | 522 | 522 | 0 | 7777 |
| **07-04** | 522 | 522 | 0 | **7896** |

11 天区间 7682-7896 ms（2.8% 浮动，纯 IO/调度噪声）。

`packages/store` sqlite ABI mismatch 与主诊断路径无关，本次不复测。

---

## 6. 合并建议优先级（06-23 → 07-04 十一日汇总）

| 优先级 | 项 | 文件/位置 | 累计状态 |
| --- | --- | --- | --- |
| **P0** | Web UI 在 cold-start 时折叠 `overall_score` 卡片。**方法**：判 `actions.find(a => a.key === "fill_signal_gaps")` 存在，直接渲染其 title `"补齐观测样本"`。1 个 if + 5 分钟 | `apps/jarvis-web/src/components/Observability/...` | 06-25 抬升，**11 天未修** |
| **P1（升级）** | `requirements-routes.ts` create+patch 加 `acceptance_policy / workflow_id / assignee_id / verification_plan` 透传；单测 happy path + bogus value + 真 UUID 三种 | `:164-166`、`:206`、`:255` + `packages/tools/src/requirement-tools.ts` | **第 11 次报告** |
| **P1** | `POST /v1/workflows` 6 处类型/字段守卫补齐 —— 顶层非数组 + 数组元素非 object + name 非 string + kind 非 object + kind.type 不在枚举 + agent.prompt 非 string；6 条反例单测 | `packages/server/src/workflow-routes.ts:156-200` + `workflow-routes.test.ts:115` | **第 5 次复现** |
| P1 | `roadmap.import` 工具 + REST 移植；或 CLAUDE.md 显式标记 deferred | `packages/tools/src/`、`CLAUDE.md` | **11 天未修** |
| P1 | requirements create/patch 加 project_id 存在性校验 → 404；同时新增 `GET /v1/requirements/:id` | `requirements-routes.ts:206/:255`，新增 `:?` | **第 10 次报告** |
| P1 | `depends_on` 跨 id 存在性校验 | `requirements-routes.ts:233-237/:298-302` | **7 天未修** |
| **P2（升级）** | Wire-shape codify 到 `docs/conventions/` 或 CLAUDE.md：`/v1/observability/health` / `runs/*` / `/v1/requirements/:id/runs` / `/v1/work/*` / `/v1/workflows` / `/v1/workflow-runs/:id`（含 `finished_at` 时间戳不刷新语义）/ `/v1/workspaces` / `/v1/remote/info`（含 DDNS 时 `external.hostname/public_ip/reachable`）/ `/v1/providers` / `/v1/version` / `/v1/ddns/status` 完整 8 keys / **`/v1/ddns/config` GET 7 keys（07-04 新入档）** / `/v1/ddns/upnp/test` 4 keys / `/v1/remote/pairing` 4 keys + cross-DDNS integration / `/v1/memory/*`（含 include kind 枚举 + target 语义 "含 MEMORY.md 的目录"） / **`DELETE /v1/memory/includes` 幂等 no-op 语义（07-04 新入档）** | `docs/conventions/` 或 CLAUDE.md | **07-04 新增 2 条**（`GET /v1/ddns/config` shape + `DELETE /v1/memory/includes` 幂等） |
| **P2（升级）** | "未配 feature" 路由口径统一 —— 4 种体例（503+hint / 503+actionable-hint / 200+flag / 200+空数据），推荐收敛到 **503+actionable-hint**（`memory/*` 已示范"消息里带 env var 名 + 重启指令"） | `packages/server/src/diagnostics-routes.ts` 等 | **7 天未修** |
| **P2（升级）** | list 路由 shape 收敛：3 种体例（裸数组 / `{items:[]}` / `{workspaces:[]}`）并存 | `projects-routes.ts` + `workspaces-routes.ts` + CLAUDE.md | **6 天未修** |
| **P2（升级 / 07-04 新扩）** | `server/info` 里补 `ddns` / `memory_enabled` / `mdns` 字段——即使 boolean 也让客户端一次读取 | `packages/server/src/server-info.ts` 附近 | **第 3 次报告** |
| **P2** | **DDNS 配置持久化路径 + 明文 credentials 语义写入 CLAUDE.md**：`~/.local/share/jarvis/ddns.json`（mode 0600，明文），"API 层永不回值 vs 磁盘层明文"两层语义分开写；**07-04 跨日再校准**"该文件不受 `JARVIS_DB_URL` 影响" | CLAUDE.md DDNS 段 + `packages/ddns/src/runtime.ts:149-153` 附近注释 | **07-03 入档，07-04 跨日校准** |
| **P2（升级）** | `POST /v1/workflows` 500 body 里错误文案在 `message` 字段而不是 `error` | CLAUDE.md 或 SDK docs | 07-02 报，**未修** |
| **P2（升级）** | **`DELETE /v1/ddns/config` 不是 Fastify content-type footgun 而是 route 缺失**。要么加 handler，要么 CLAUDE.md 显式说"清 DDNS 配置 = rm 磁盘 + 重启"；顺便修 Fastify body-parser 顺序（route 不存在时永远 404，不被 body 400 抢先） | `packages/server/src/ddns-routes.ts` + Fastify config | **07-03 修正诊断，07-04 未修** |
| P2 | approve idempotent + reject "软删非回退" 语义、instructions trim-aware、slug 冲突 409 vs 后缀行为、workflow name 允许重复无 slug 唯一——全部加进 CLAUDE.md | CLAUDE.md 项目段 + workflow 段 | 06-29 起，**6 天未修** |
| P2 | `depends_on` wire shape 稳定化（omit → server 补 `[]` 或客户端 normalize） | `requirements-routes.ts` 序列化处 | **7 天未修** |
| **P3（升级）** | CLAUDE.md 补 `POST /v1/memory/includes` 完整规范：`target` = "含 `MEMORY.md` 的目录"（不是文件、也不是任意路径）；`kind` 枚举 `"local_path"` / `"git"`；refresh 仅对 git+；**`DELETE /v1/memory/includes` 幂等（07-04 新入档）** | CLAUDE.md memory 段 | **07-04 补充幂等语义** |
| **P3** | CLAUDE.md 补 `POST /v1/ddns/upnp/test`（4 keys）+ `GET /v1/remote/pairing`（4 keys + `pairing_links[*]:{origin,link}` + 与 DDNS/access-token cross-feature）+ **`GET /v1/ddns/config` 7 keys**（07-04 新入档，含 GET/PUT wire shape 对称结论） | CLAUDE.md DDNS 段 | **07-04 新增** |
| P3 | `/v1/version` vs `/health` vs `/v1/health` 三分裂：`/v1/health` 404，补别名或 CLAUDE.md 说明 | `packages/server/src/router.ts` + CLAUDE.md | **第 3 次报告** |
| P3 | `/v1/diagnostics/runs/stuck?threshold_seconds=N` 行为在 CLAUDE.md 显式：仅返 `age_seconds >= N` 的 pending run；无 query 时 default > 4 秒 | `diagnostics-routes.ts` + CLAUDE.md | **5 天未修** |
| P3 | `ObservabilityStore` / `EvalStore` 的 env-driven 拉起方式在 CLAUDE.md 文档化 | CLAUDE.md | 未修 |
| **P3** | Servlet 测试目录 fixture `scripts/servlet-fixture-reset.sh` —— 07-03 手动重建 HelloServlet.java、07-04 起飞时又完好，说明 fixture 生命周期未固化；LLM-驱动测试前应能一键复位 | `Makefile` 或 `scripts/servlet-fixture-reset.sh` | 07-03 新增，07-04 保持 |

---

## 7. 复测剧本（有 LLM key 时；与 07-03 §7 一致 + 07-04 新增项）

```bash
export OPENAI_API_KEY=sk-...
export JARVIS_FS_ROOT=/tmp/jarvis-servlet-test
export JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-<date>
export JARVIS_WORK_MODE=auto
export JARVIS_WORK_TICK_SECONDS=10
export JARVIS_WORK_MAX_CONCURRENT=1
export JARVIS_ENABLE_FS_WRITE=1 JARVIS_ENABLE_FS_EDIT=1 JARVIS_ENABLE_SHELL_EXEC=1
export JARVIS_PERMISSION_MODE=bypass
# 07-02+ DDNS 后端复测
export JARVIS_DDNS_ENABLE=1 JARVIS_DDNS_PROVIDER=duckdns \
       JARVIS_DDNS_HOSTNAME=<真 duckdns 子域> JARVIS_DDNS_CREDENTIALS='{"token":"<真 duckdns token>"}'
# 07-03 新增：memory git 后端复测
export JARVIS_ENABLE_MEMORY=1 JARVIS_MEMORY_SYNC_BACKEND=git \
       JARVIS_MEMORY_USER_ROOT=/tmp/jarvis-mem-<date>
# 07-03 新增：access-token + pairing 复测
export JARVIS_ACCESS_TOKEN=<32B random>
node --experimental-strip-types packages/jarvis-app/src/main.ts serve &
# 6 步 → 等 2-3 个 tick
```

未验证项（继续滚到下一次）：

- **仍留白**（06-30 → 07-04 累积）：subagent.review 真 flip、triage.scan_candidates 建 ProposedByScan、project.checks 识别 Maven 缺 pom.xml、bogus project_id 之后 agent 侧 requirement.list 是否拿回、step_results[*] shape 在有 LLM key 时、`POST /v1/workflow-runs/:succeeded_run/cancel` 是否 200 no-op（目前只测 cancelled → cancel 200）
- **07-03 → 07-04 累积新留白**：
  - `JARVIS_MEMORY_SYNC_BACKEND=git` 起飞后 `POST /v1/memory/sync_setup` / `sync` 的 happy-path shape
  - `POST /v1/memory/includes body={target:"git+https://..."}` happy path shape + `kind:"git"` include shape + `refresh` on `kind:"git"` happy path
  - `PUT /v1/ddns/config record_type` 除 A/AAAA 外的枚举（"CNAME"? 现实里 duckdns 只支持 A/AAAA，但 provider=cloudflare 支持 CNAME）
  - `JARVIS_ACCESS_TOKEN=<token>` 起飞后 `GET /v1/remote/pairing` 的 `token` 字段 + `pairing_links[*].link` 是否带 `?token=<val>`
  - `POST /v1/ddns/upnp/test` 在真有 UPnP gateway 网络下的 shape（今天 message 是 "no UPnP gateway found"）
  - `POST /v1/ddns/upnp/test` 参数化探测（是否支持自定义 externalPort？body shape？）
- **07-04 新留白**：
  - `PUT /v1/ddns/config` 若不带 `record_type`，返回是 `record_type:"A"` 默认还是 undefined？（隐含 default）
  - `GET /v1/ddns/config` 在 `configured:false` 时的 wire shape（今天配好了跑不出这个分支）
  - `PATCH /v1/requirements/:id` 只传 `depends_on` 时 wire shape（今天全用 POST 探）
  - `POST /v1/workflow-runs/<bogus_uuid>/cancel` 与 `POST /v1/workflow-runs/<already-cancelled>/cancel` 都返 404 而不是 200 no-op —— 是否 route 层 idempotence 语义与 memory-includes 分裂？（今天只测了 cancelled → 200 no-op；缺"bogus/never-existed → 404"侧的对照，等 LLM key 后拉全 case）

---

## 8. 总览

| 项 | 评分 | 与 07-03 比 |
| --- | --- | --- |
| Kanban (Project + Requirement CRUD + 状态转换 + Activity) | ✅ 健康 | 持平 |
| Workflow CRUD + dispatch + cancel（幂等 + `finished_at` 不刷新） | ✅ 健康（除 §3.7 的 10 种 500 泄漏） | 持平 |
| Diagnostics (`/v1/diagnostics/*` + `/v1/work/*`) | ✅ 健康 | 持平 |
| Harness.health 算法实装 | ✅ 稳定第 11 天 —— 3 fingerprint（sample=1/3/4）全复现 | 持平 |
| Harness.health 信号采集 | ⚠️ 缺 LLM 驱动时无信号；`actor_breakdown` / `verification_pass_rate` 顶层 null | 持平 |
| Harness.health 前端表达 | ❌ confidence 低分仍直接展示 score | **11 天未修** |
| DDNS 后端 | ✅ 健康 + 8 keys status + `GET /v1/ddns/config` 7 keys（07-04 新入档）+ upnp/test + remote/pairing + cross-day 持久化再校准 | 07-04 补齐 `GET` wire shape |
| Memory 后端（backend=none） | ✅ 健康 + include target 语义 + scope=user + kind=local_path/git 枚举 + DELETE/refresh + **DELETE 幂等 no-op（07-04 新入档）** | 07-04 落地幂等语义 |
| REST ↔ 数据模型一致性 | ❌ 4 字段 POST+PATCH 丢；project_id 无 FK；depends_on 跨 id 无 FK；无 `GET /v1/requirements/:id`；depends_on 条件性写回；list shape 三分裂 | 持平（第 11 次） |
| 文档 ↔ 运行时一致性 | ⚠️ roadmap.import 文档 ✅ 但 404；`server/info` 不反映 DDNS/memory；`POST /v1/memory/includes` body target 语义未文档化；`/v1/health` 404；DELETE 无 body 时 fastify 400（真相 = 无 route）；`upnp/test` + `remote/pairing` + `GET /v1/ddns/config` 完全未文档化 | 07-04 揭底更多缺口 |
| 单测覆盖 | ✅ 522/522 全绿，7896 ms | 持平（噪声内） |
| **真 bug**：`POST /v1/workflows` 500 泄漏 | ❌ 10 shape 500 / 6 shape 400 完全复现 | 持平（第 5 次） |
| **真 bug**：`DELETE /v1/ddns/config` 无 handler | ❌ 3 shape 探完全复现 07-03 结论 | 持平 |
| 自动化的端到端验证（有 LLM key） | ❌ 本次仍未执行 | 持平 |

**总体判断**：HEAD 在 06-23 → 07-04 **十一天**没动，工作树未 commit 文件持平 39，所以 07-03 的所有 P0/P1/P2 结论**原样成立**。本次实际增量价值：

1. **07-03 §7 未验证项落地 1 条**：`DELETE /v1/memory/includes` **幂等** —— 重复 DELETE 同一 target 返 200 no-op（与 `POST /v1/workflow-runs/:id/cancel` "对已 cancelled 幂等" 同族，与 `POST /v1/requirements/:id/reject` "bogus id 返 404" 语义分裂）。
2. **`GET /v1/ddns/config` 7 keys wire shape 首入档**：`[credential_keys, hostname, interval_seconds, port, provider, record_type, upnp_enabled]` —— 与 `PUT` 响应 shape **完全对齐**（GET/PUT 对称，credentials 值均不外泄）。
3. **DDNS 配置跨 07-03 → 07-04 持久化跨日校准**：`~/.local/share/jarvis/ddns.json` 完整存活，与 `JARVIS_DB_URL` 完全独立 —— 07-03 P2 结论今天获得 cross-day 证据。
4. **算法稳定性 fingerprint 跨日再确认**：sample=1/3/4 三条 fingerprint 与 07-03 逐位相等 —— **算法稳定第 11 天**，用作 regression smoke 尤其可靠。
5. **cross-feature integration 跨日校准**：`/v1/remote/pairing.origins` 今天含 `http://test-jarvis-07-04-aaaa:7099`（今天 PUT 的新 hostname）—— iOS + DDNS pairing 流第 2 天走通。

**建议**：下次合 P1 修复时**同时**做：①4 字段透传 create+patch；②project_id FK + `GET /v1/requirements/:id`；③depends_on FK；④workflow POST 6 处类型守卫；⑤`DELETE /v1/ddns/config` 加 route（清磁盘 + credentials 归零）；⑥`server/info` 补 ddns/mdns/memory_enabled 字段；⑦一次性 codify DDNS 5 route（status 8 keys + config GET/PUT 7 keys 对称 + upnp/test + remote/pairing）+ memory 4 route（含 target 目录语义 + kind 枚举 + **DELETE 幂等 no-op**）+ cancelled workflow run `finished_at` 不刷新 + slug 409 到 CLAUDE.md。

**P0 修复（11 天）**：前端读 `actions.find(a => a.key === "fill_signal_gaps")` 当 cold-start 兜底信号，改 1 行 5 分钟 —— 十一天延期的根本原因还是被误判成"需要重新设计"。

**Servlet 测试基线加固**：`/tmp/jarvis-servlet-test/src/main/java/com/example/HelloServlet.java` 07-03 手动重建后今天完好；仍未固化 fixture 生命周期 —— 建议加一个 `scripts/servlet-fixture-reset.sh` 每次跑前重置。
