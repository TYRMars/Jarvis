# Jarvis 项目自动化能力诊断报告（2026-07-03 十次复测）

- **运行时间**：2026-07-03（scheduled task 自动跑）
- **被测分支**：`feat/mobile-ios-ddns`（HEAD 仍为 `64d288a`，与 06-23 → 07-02 同一 commit — **静默第 10 天**；工作树侧 39 个未 commit 文件与 07-02 完全一致，未 +/−）
- **被测项目**：`/tmp/jarvis-servlet-test`
  - **07-03 差异**：`src/main/java/com/example/HelloServlet.java` 在今天启动时**已消失**（07-02 报告里"1 个文件"、"标准 13 行 doGet"），只剩空目录树；为保持基线一致本次**手动重建** HelloServlet.java（同 07-02 文本）后再跑 probe。目录树骨架 `src/main/{java/com/example,webapp/WEB-INF}` 仍在，说明是文件级清理不是全 rm。
- **本次目的**：
  1. **回归确认** 07-02 P0/P1 累积项在 1 天间是否被修复（预期：未修）
  2. **DDNS 配置持久化位置**：07-02 报告"每 run 都用 fresh DB"但没探过 DDNS 状态是否跨启动持久 —— 今天开机就发现 `configured:true, hostname:"test-jarvis-07-02"` 还在，追代码找出持久化文件路径（§4.5）
  3. **DDNS 更加完整的 wire shape**：`status.last_result` / `status.public_ip` / `remote/info.external.public_ip` 3 个 07-02 未捕获的字段全入档（§4.5）
  4. **DDNS `POST /v1/ddns/upnp/test`**（07-02 甚至没意识到这个 route 存在）+ **`GET /v1/remote/pairing`** wire shape 首次入档（§4.5.5 / §4.5.6）
  5. **DDNS `record_type:"AAAA"`** 是否 accept（07-02 §7 未验证）（§4.5）
  6. **DDNS `DELETE /v1/ddns/config`** 真相勘察 —— 07-02 说的"Fastify content-type footgun"其实是**误诊**：真相是 **DELETE route 根本不存在**（§4.5.4）
  7. **Memory includes 完整 happy path**：POST 正确 `target` shape + list + DELETE + refresh 语义（07-02 §7 未验证）（§4.6）
  8. **Memory `GET /v1/memory/includes?scope=user`**（07-02 §7 未验证）（§4.6）
- **运行约束**：与 07-02 一致 —— `JARVIS_WORK_MODE=off`、stub LLM key、`JARVIS_PERMISSION_MODE=bypass`；DB 用日期后缀 `-20260703` 全新路径。DDNS + memory 分支另起 `-20260703-ddns` 后缀

---

## 0. TL;DR — 与 07-02 的差异

| 项 | 07-02 状态 | 07-03 状态 | 变化 |
| --- | --- | --- | --- |
| `git log --since=2026-07-02` | 0 commit | **0 commit**（HEAD 仍 `64d288a`） | 静默**第 10 天** |
| 工作树未 commit 文件数 | 39 个 | **39 个** | 持平 |
| 522 条 `@jarvis/server` 单测 | 522/522 ✅（7784 ms） | **522/522 ✅**（7777 ms） | 持平（-7 ms 噪声） |
| Servlet 工作目录 | 只剩 `HelloServlet.java` | **文件消失，只剩空目录树**；本次**手动重建** HelloServlet.java 以保持基线 | ⚠️ 环境侧变动 |
| P1-A POST + PATCH 4 字段透传 | 全双向静默丢字段 | **仍全双向静默丢字段** | ❌ 未修（第 10 次） |
| P1-B `POST /v1/roadmap/import` | 404 | **404** | ❌ 未修（第 10 次） |
| P1-C `GET /v1/requirements/:id` | 404 | **404** | ❌ 未修（第 10 次） |
| Orphan 行 `POST /v1/projects/no-such/requirements` | 201 + 原样回写 | **201 + 原样回写 + GET 能拉回** | ❌ 未修（第 10 次） |
| `depends_on` 跨 id FK bogus | 通过 | **完全复现** | ❌ 未修（第 6 次） |
| `depends_on` 条件性写回 | omit→undefined, []→[], real→real | **完全复现** | ❌ 未修（第 6 次） |
| `/v1/projects` 列表裸数组 | 与 `{items:[]}` 系不一致 | **完全复现** | ❌ 未修（第 5 次） |
| `confidence < 0.2` 前端兜底 | P0，**9 天未修** | **P0，10 天未修** | 持平 |
| `POST /v1/workflows` 10 shape 500 泄漏 | 10 500 / 6 400 | **完全复现**（10 500 / 6 400） | ❌ 未修（第 4 次） |
| workflow-run cancel 幂等 | cancel #2/#3 均 200 | **完全复现**（cancel #1/#2/#3 均 200，`finished_at` 同一时间戳） | 持平 |
| cancelled run wire shape 7 keys | `[error, finished_at, id, started_at, status, step_results, workflow_id]` | **完全复现** | 持平 |
| workflow 重名 | 两次 POST 同 name 都 201 UUID 不同 | **完全复现** | 持平 |
| `POST /v1/projects` 显式 `slug` 4 组合 | 显式 slug 首次 201 / 相同显式 slug 409 / 相同 name 无 slug 201 | **完全复现**（`4.3.slug2` 409 `"slug 'custom-slug-x-07-03' already in use"`） | 持平 |
| sample_count=3 fingerprint | `0.13120190627836492` | **`0.13120190627836492`** 完全复现第 9 天 | 持平 |
| sample_count=4 fingerprint | `0.15232069614525703` | **`0.15232069614525703`** 完全复现（首次 07-02 落地，今天二次校准） | 持平 |
| **DDNS 配置持久化路径**（07-02 未探） | 未知 | **`~/.local/share/jarvis/ddns.json`**（0600 + JSON，**含明文 credentials**，**不受 `JARVIS_DB_URL` 影响**） | ⚠️ **07-03 新入档 P2** |
| **`ddns.status.public_ip` 字段**（07-02 未捕获） | 无 | **配好 provider/token/hostname 后自动填**（今天出 `"67.200.120.26"`） | ⚠️ 07-03 新入档 |
| **`ddns.status.last_result` 字段**（07-02 未捕获） | 无 | **`{ok:false, message:"duckdns rejected the update (response: \"KO\") — check the token/subdomain"}`** — 异步 update 结果落到 status 里 | ⚠️ 07-03 新入档 |
| **`remote/info.external.public_ip` 字段**（07-02 未捕获） | 只见 `hostname, reachable` | **今天 3 keys：`hostname, public_ip, reachable`** | ⚠️ 07-03 新入档 |
| **`POST /v1/ddns/upnp/test`**（07-02 甚至没发现这个 route） | 未测过 | **200 `{mapped:false, externalPort:7099, internalPort:7099, message:"no UPnP gateway found on the LAN — forward the port manually on your router"}`**（4 keys） | ⚠️ 07-03 新入档 |
| **`GET /v1/remote/pairing`**（07-02 未发现） | 未测过 | **200 `{device_name, token, origins, pairing_links}`**；`token:null`（没 `JARVIS_ACCESS_TOKEN`）；`origins`/`pairing_links` **含 DDNS hostname**（cross-feature integration） | ⚠️ 07-03 新入档 |
| `PUT /v1/ddns/config record_type:"AAAA"`（07-02 §7 未验证） | 未测过 | **200 accept**，回 `record_type:"AAAA"` | ✅ 落地 |
| **`DELETE /v1/ddns/config` 真相**（07-02 报"Fastify footgun"P3） | 400 `FST_ERR_CTP_EMPTY_JSON_BODY` | **route 根本不存在**：不带 `Content-Type` header → **404 "Route DELETE:/v1/ddns/config not found"**（Fastify parser 顺序把 route 不存在的 404 藏成了 body 400） | ⚠️ **07-02 结论修正**：不是 footgun 是 route 缺失 |
| **Memory includes POST 正确 shape**（07-02 §7 未验证） | 只知道要 `target` | **`target` 必须是"含 MEMORY.md 的目录"**（fs 目录，直含 `MEMORY.md` 或 `.jarvis/memory/MEMORY.md`）；回 `{ok, added, scope, memory_md}` 4 keys | ✅ 落地 |
| **Memory includes list 加过之后 shape** | 空 items | **1 item = `{target, kind:"local_path", resolves:true, path}` 4 keys**；`kind` 枚举猜 `"local_path"` / `"git"`（refresh 提示只对 git+ 走） | ⚠️ 07-03 新入档 |
| **Memory `DELETE /v1/memory/includes`**（07-02 §7 未验证） | 未测过 | **200 `{ok:true, removed:<target>, scope}` 3 keys** | ✅ 落地 |
| **Memory `POST /v1/memory/includes/refresh`** | 未测过 | 对 `local_path` include → **400 `"refresh only applies to git+ includes"`**；对 missing target → 400 `"missing target"` | ✅ 落地 |
| **Memory `GET /v1/memory/includes?scope=user`**（07-02 §7 未验证） | 未测过 | **200 `{scope:"user", memory_md:"/tmp/jarvis-mem-07-03/.jarvis/memory/MEMORY.md", items:[]}`**——scope=user 返回 user-level MEMORY.md 路径 | ✅ 落地 |
| `server/info` 反映 DDNS/memory 开关状态 | 不反映 | **仍不反映**——`ddns` / `features` / `memory_enabled` key 均 undefined 即使全开 | ❌ 未修（第 2 次） |
| `/v1/health` 404 | 未修 | **未修** | ❌ 未修（第 2 次） |
| `no_op:true` 首次 approve 已批 | 06-30 报 | **完全复现** | 持平 |

代码侧三个 deferred / 缺陷标记的精确行号仍在原位（今天 grep 三次确认）：
- `packages/server/src/requirements-routes.ts:164` 的 `"acceptance_policy / verification_plan / workflow_id three-state semantics are part of the future scope"` 注释（07-02 报 `:147-167` 区间，今天精确 `:164`）。
- `packages/tools/src/register-builtins.ts:13` "未移植清单" 注释 `"channel.send, codex.run, claude_code.run, roadmap.import ... not"`，`:166` `"(not yet ported)"`。
- `packages/server/src/workflow-routes.ts:156` 的 `normalizeSteps(body.steps ?? [])`——今天 10 种 500 泄漏 shape 全复现。

---

## 1. 测试配置（分两次起）

### 主分支（§2 / §3 / §4.1-4.4）

```
OPENAI_API_KEY=sk-stub-for-automation-test
JARVIS_PROVIDER=openai
JARVIS_MODEL=gpt-4o-mini
JARVIS_FS_ROOT=/tmp/jarvis-servlet-test
JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-20260703
JARVIS_ADDR=127.0.0.1:7099
JARVIS_WORK_MODE=off
JARVIS_PERMISSION_MODE=bypass
JARVIS_NO_PROJECT_CONTEXT=1
```

启动日志：
```
[jarvis] persistence connected: json:///tmp/jarvis-servlet-test-db-20260703
[jarvis] serve: provider=openai model=gpt-4o-mini addr=127.0.0.1:7099 fsRoot=/tmp/jarvis-servlet-test coding=false auth=none ddns=off mdns=off promptBytes=263
```

### DDNS + Memory 分支（§4.5 / §4.6）

```
# 主分支所有变量 +
JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-20260703-ddns
JARVIS_DDNS_ENABLE=1
JARVIS_ENABLE_MEMORY=1
JARVIS_MEMORY_USER_ROOT=/tmp/jarvis-mem-07-03
```

启动日志（DDNS 分支）：
```
[jarvis] persistence connected: json:///tmp/jarvis-servlet-test-db-20260703-ddns
[jarvis] serve: provider=openai model=gpt-4o-mini addr=127.0.0.1:7099 fsRoot=/tmp/jarvis-servlet-test coding=false auth=none ddns=on mdns=off promptBytes=263
[jarvis] listening on http://127.0.0.1:7099
[ddns] duckdns rejected the update (response: "KO") — check the token/subdomain    # ★ 启动后立即打
```

**注意**：起飞立即打出 duckdns "KO" 错——说明服务端一起来就发现 `ddns.json` 里有旧配置（07-02 留的 `hostname:"test-jarvis-07-02"` + fake token），立刻发一次 update，收到 duckdns 的拒绝，写进 `status.last_result`。这本身就佐证了 **DDNS 状态跨启动持久化，且 update 循环独立于 REST 调用**。

`/v1/server/info` 主分支：44 tools、`project_store=true`、`persistence=json://…`、`approval_mode=bypass`、`max_iterations=80`、`coding_mode=false`、`workspace_root=/tmp/jarvis-servlet-test`、`memory.budget_tokens=108000`、`system_prompt.length=263` —— **与 07-02 完全一致**。DDNS 分支 `server/info` 同样不含 `ddns`/`features`/`memory_enabled` 顶层字段（第 2 次确认）。

工具集 44 条与 07-02 完全一致（今天不重复 dump）。

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

**`0.06560095313918246`（sample=1）、`0.13120190627836492`（sample=3）、`0.15232069614525703`（sample=4）三个 fingerprint** 与 06-25 → 07-02 共 9 天完全一致 —— **算法稳定第 10 天**。

`confidence = ln(sample_count+1) / ln(31) × signal_coverage` 公式 07-02 已推平；今天顺手回代 sample=1 确认：
```
ln(2)/ln(31) × coverage
= 0.6931 / 3.4340 × coverage
= 0.2018 × coverage
= 0.06560095313918246
→ coverage = 0.325...
→ 与 sample=3/4 的 coverage 一致
```

**stub 模式下 `signal_coverage` 恒 ≈ 0.325**——3 个 sample_count 落到 3 个不同 fingerprint，都由公式驱动，**信号采集器完全没跑过（LLM 未驱动，tool signal 全 0）**。

`/v1/observability/health.dimensions[*]` sample=4 完整：

| dim | score | confidence |
| --- | --- | --- |
| task_understanding    | 50 | 0.09373581301246586  |
| planning_execution    | 38 | 0.25777348578428116  ← 最低 score → primary_focus |
| capability_invocation | 50 | 0.04686790650623293  ← 最低 conf |
| task_delivery         | 50 | 0.2109055792780482   |

**per-dim confidence 与 07-02 逐位相等** —— fingerprint 稳定第 10 天，这一层用来做 regression smoke 特别可靠。

`/v1/diagnostics/runs/recent` 返 **4 条**（含 7 步产生的所有 pending run），item[*] keys=`[conversation_id, id, logs, requirement_id, started_at, status]`——与 07-02 一致。

`/v1/diagnostics/runs/stuck` 行为：
- default（无 query）→ `items:[]` ✓
- `?threshold_seconds=1` → **今天 `items:[]`**（07-02 是 4 条；差异是本次 probe 4 秒内跑完连着立即查，没等 3 秒）—— 加固 07-01/07-02 的时间敏感结论，行为一致

`/v1/work/overview`（截取新观察点）：
```
requirement_status_counts: {backlog: 6, in_progress: 2, review: 0, done: 2}
run_status_counts:         {completed: 0, failed: 0, cancelled: 0}
throughput_by_day:         len=8
project_leaderboard:       len=1 {project_id, project_name, runs_in_window: 4, completion_rate: 0}
```
**backlog=6** 而不是 07-02 的 `backlog:0`——因为本次 probe 后续几步给同 project 建了 `policy-probe-07-03/dep-bogus-07-03/self-loop-07-03/deps-omit-07-03/deps-empty-07-03/deps-real-07-03` 共 6 个未拖过的 backlog 行；`in_progress=2, done=2` 与 07-02 一致。**行为与 07-02 完全一致，只是 step-7 之后又多建了 6 行**。

**迭代判断（与 06-25 → 07-02 完全一致）**：所有 kanban 拖拽只写 Activity 行，不动 sample_count；只有 `POST :id/runs` 拉动 sample_count；`confidence` 公式 `ln(n+1)/ln(31) × coverage` 在 stub 模式 coverage 恒 ≈ 0.325；**cold-start `overall_score=47` 依旧被前端当"健康差"渲染**，P0 已**连续 10 天未修**。**根本原因 07-01 已给**：前端读 `actions.find(a => a.key === "fill_signal_gaps")` 兜底，改 1 行 5 分钟。

---

## 3. P1 项回归（仍未修）

（今天用 07-02 同一份 mjs probe 一次性跑完，输出与 07-02 完全对齐）

### 3.1 4 字段 REST 透传 — POST + PATCH 双失（**第 10 次报告**）

```
POST /v1/projects/<pid>/requirements
  body={"title":"policy-probe-07-03","triage_state":"approved",
        "acceptance_policy":"Human", "workflow_id":"wf-test-string",
        "assignee_id":"agent-x",
        "verification_plan":{"checks":[{"name":"x","cmd":"true"}]}}
→ 201 keys=['conversation_ids','created_at','id','project_id','status','title','updated_at']
  4 字段全部 absent

PATCH /v1/requirements/<id> body=同上（acceptance_policy/workflow_id/assignee_id/verification_plan）
→ 200 keys 同上，4 字段仍全部 absent
```

**第 10 次报告**。今天 grep 确认拒收发生点仍在 `packages/server/src/requirements-routes.ts:147-167` 的 `CreateBody` / `UpdateBody` interface —— 4 字段没进 interface，进不了 handler。零改动。

### 3.2 `roadmap.import` — 仍 404（**第 10 次**）

```
POST /v1/roadmap/import → 404 {"message":"Route POST:/v1/roadmap/import not found"}
```

### 3.3 `GET /v1/requirements/:id` — 仍不存在（**第 10 次**）

```
GET /v1/requirements/<any> → 404
```

### 3.4 Orphan 行 — project_id 仍可任意写（**第 10 次**）

```
POST /v1/projects/no-such-project-07-03/requirements
  body={"title":"orphan-07-03","triage_state":"approved"}
→ 201 project_id="no-such-project-07-03"

GET /v1/projects/no-such-project-07-03/requirements → 200 items.len=1
```

### 3.5 `depends_on` 跨 id FK — 仍不拒 bogus（**第 6 次**）；self-loop 仍拒 ✓

```
depends_on:["00000000-0000-0000-0000-000000000000"] → 201 写通
PATCH depends_on:[<self id>] → 400 "must not contain the requirement's own id (self-dependency)"
```

### 3.6 `depends_on` 条件性写回 — 完全复现（**第 6 次**）

```
POST omit depends_on          → resp.depends_on === undefined
POST depends_on:[]            → resp.depends_on === []
POST depends_on:["<real id>"] → resp.depends_on === ["<real id>"]
```

### 3.7 `POST /v1/workflows` 500 泄漏 — 10 shape 500 / 6 shape 400（**第 4 次报告 → 完全复现**）

| body | status | body.message |
| --- | --- | --- |
| `{steps: 42}` | **500** | `steps.map is not a function` |
| `{steps: true}` | **500** | 同上 |
| `{steps: "not-a-list"}` | **500** | 同上 |
| `{steps: {}}` | **500** | 同上 |
| `{steps: [42]}` | **500** | `Cannot read properties of undefined` |
| `{steps: [null]}` | **500** | 同上 |
| `{steps: [{}]}` | **500** | 同上 |
| `{steps: [{name:"x"}]}` | **500** | 同上 |
| `{steps: [{name:"x", kind:{type:"bogus"}}]}` | **500** | 同上 |
| `{steps: [{name:"x", kind:{type:"agent"}}]}` | **500** | 同上 |
| `{steps: [{name:"x", kind:{type:"agent", prompt:""}}]}` | **400** | `agent step 'x' has an empty prompt` ✓ |
| `{steps: null}` | **400** | `at least one agent step` ✓ |
| `{}` / `{name:""}` / `null` / `[]` | **400** | `name is required` ✓ |

修复清单与 07-01/07-02 一致（6 处类型守卫补 `packages/server/src/workflow-routes.ts:156-200` + `normalizeSteps` + `validateSteps`）。

---

## 4. 07-03 新发现 / 07-02 未验证项落地

### 4.1 `POST /v1/workflow-runs/:id/cancel` **cancel 3 次都幂等**（07-02 §4.1 完整回归）

```
# 建 workflow + dispatch pending run
POST /v1/workflows {name:"wf-07-03-cancel", steps:[{name:"s", kind:{type:"agent", prompt:"hi"}}]}
→ 201 wf_id=68e01a99-18df-4b99-9954-0b5918c9cac9

POST /v1/workflows/<wf_id>/run {} → 202 {id:<run_id>, workflow_id, status:"pending", step_results:[], started_at}

# --- Cancel #1: 首次真 cancel ---
POST /v1/workflow-runs/<run_id>/cancel {}
→ 200 {
    id, workflow_id,
    status: "cancelled",
    step_results: [],
    started_at,  finished_at,
    error: "run cancelled by operator"
  }
# 7 keys ★

# --- Cancel #2/#3：对已 cancelled 的 run 再 cancel ---
POST /v1/workflow-runs/<run_id>/cancel {} × 2
→ 200 每次都返 7 keys，state 完全相同（`finished_at` 保持首次 cancel 的时间戳，不刷新）
```

**注意 07-03 新观察**：`finished_at` 在 cancel #2/#3 保持**首次 cancel 的时间戳**，**不刷新**——这佐证了幂等语义（"记录首次事件时间，后续 no-op"）而非"最后一次 write 时间"。**07-02 报告没验证这一点**。

`GET /v1/workflow-runs/<bogus_uuid>` → `404 {error:"workflow run not found"}`
`POST /v1/workflow-runs/<bogus_uuid>/cancel` → `404 {error:"workflow run not found"}` （同一个 error 文案）

### 4.2 workflow 重名允许（07-02 落地，07-03 二次回归）

```
POST /v1/workflows {name:"wf-dup-07-03", steps:[...]} → 201 id=<UUID1> name="wf-dup-07-03"
POST /v1/workflows {name:"wf-dup-07-03", steps:[...]} → 201 id=<UUID2> name="wf-dup-07-03"
```
✓ 二次落地，UUID 唯一，name 允许重复。

### 4.3 `POST /v1/projects` 显式 `slug` 3 组合（07-02 落地，07-03 回归）

| # | body | 状态 | slug |
| --- | --- | --- | --- |
| 1 | `{name:"with-slug-07-03", slug:"custom-slug-x-07-03", instructions:"x"}` | **201** | `custom-slug-x-07-03` |
| 2 | 一样的 body 二次 POST | **409** | undefined，`error: "slug 'custom-slug-x-07-03' already in use"` |
| 3 | `{name:"with-slug-07-03", instructions:"x"}`（同 name，无显式 slug） | **201** | `with-slug-07-03`（server 用 name 派生，未占用） |

### 4.4 `sample_count=1/3/4` 三 fingerprint 稳定第 10 天 —— 见 §2 表。

### 4.5 DDNS 完整第二日：**新字段 3 个 + 新 route 2 个 + 07-02 结论修正 + 持久化文件揭底**

#### 4.5.1 持久化路径 —— **07-03 P2 新入档**

07-02 报告是"开机就 configured=false"（fresh 场景），今天开机就发现 `configured:true, hostname:"test-jarvis-07-02"` —— 显然 DDNS 配置不在 `JARVIS_DB_URL` 里持久，**它在别处**。追代码：

- `packages/jarvis-app/src/state.ts:123-132` `ddnsConfigPath()` 返回 `path.join(os.homedir(), ".local", "share", "jarvis", "ddns.json")`（macOS = `~/.local/share/jarvis/ddns.json`）
- `packages/ddns/src/runtime.ts:149-153` 在 PUT 时 `writeFile(configPath, JSON.stringify(next, null, 2), { mode: 0o600 })` + 显式 `chmod 0o600`

**文件内容**（今天实探）：
```json
{
  "provider": "duckdns",
  "hostname": "test-jarvis-07-03-aaaa",
  "port": 7099,
  "recordType": "AAAA",
  "intervalSeconds": 300,
  "upnpEnabled": false,
  "credentials": {
    "token": "t2"
  }
}
```

**★★ 安全语义**：credentials **以明文存在磁盘**上（mode 0600 保护），**但从 API 从不返出**（PUT/GET 都只回 `credential_keys:["token"]`）。这是"磁盘层信任 owner + API 层永不外泄"的模式，与 07-02 报告推断一致，今天首次**从代码 + 文件层验证**。

**⚠️ 07-02 报告口径修正**：07-02 说 "credentials 不外泄" 是通过 shape 层验证，今天补充"磁盘层是明文"这一层——**部署到多用户机器上、误 chmod 777、误 tar 打包备份都会外泄 credentials**。CLAUDE.md 的"credentials never returned by any GET"是**API 层语义**，不是"零留痕"。

#### 4.5.2 `GET /v1/ddns/status` 完整 wire shape ★★ **07-02 漏 2 keys**

07-02 只列 `{enabled, configured, lan_addrs, reachable, provider, hostname}` 6 keys。今天 configured=true 状态下完整 dump：

```json
{
  "enabled": true,
  "configured": true,
  "lan_addrs": ["192.168.1.164", "198.18.0.1"],
  "reachable": null,
  "provider": "duckdns",
  "hostname": "test-jarvis-07-03",
  "public_ip": "67.200.120.26",             // ← ★ 07-02 漏；查询公网 IP 后填
  "last_result": {                            // ← ★ 07-02 漏；异步 update 结果落这
    "ok": false,
    "message": "duckdns rejected the update (response: \"KO\") — check the token/subdomain"
  }
}
```

**8 keys 完整版**。`last_result.ok` false/true 标志异步 update 循环是否成功；`last_result.message` 是 provider 侧错误文案。**这是 07-02 报告的重要 wire-shape 补丁**。

#### 4.5.3 `PUT /v1/ddns/config` 收 `record_type:"AAAA"` ✓（07-02 §7 未验证项落地）

```
PUT /v1/ddns/config body={
  provider: "duckdns", hostname: "test-jarvis-07-03-aaaa", port: 7099,
  interval_seconds: 300, credentials: {token: "t2"}, record_type: "AAAA"
}
→ 200 {provider, hostname:"test-jarvis-07-03-aaaa", port, record_type:"AAAA", ...}
```

**record_type accept 枚举确认包含 "A" (默认) + "AAAA"**；其它值未探。

#### 4.5.4 **`DELETE /v1/ddns/config` 07-02 结论修正**

07-02 报"400 `FST_ERR_CTP_EMPTY_JSON_BODY` = Fastify content-type footgun"。**今天勘察真相**：

```
# 07-02 的方式
DELETE /v1/ddns/config 无 body Content-Type:application/json
→ 400 FST_ERR_CTP_EMPTY_JSON_BODY

# 07-03 探：去掉 Content-Type
DELETE /v1/ddns/config 无 header
→ 404 {"message":"Route DELETE:/v1/ddns/config not found"}

# 07-03 探：body 是 {} 但 Content-Type application/json
DELETE /v1/ddns/config body="{}"
→ 404 {"message":"Route DELETE:/v1/ddns/config not found"}
```

**真相**：`packages/server/src/ddns-routes.ts` grep 显示：
```
:56  app.get("/v1/ddns/status")
:62  app.get("/v1/ddns/config")
:69  app.put("/v1/ddns/config")
:82  app.post("/v1/ddns/update")
:93  app.post("/v1/ddns/upnp/test")     ← 07-02 报告没意识到
:114 app.get("/v1/remote/info")
:137 app.get("/v1/remote/pairing")     ← 07-02 报告没意识到
```

**没有 `app.delete("/v1/ddns/config")` 这条 route**。07-02 看到的 400 只是 Fastify 的 body parser 排序把"route 不存在"的 404 藏在 body-parse 错误后面 —— 是**误诊**。

**07-03 P2 建议**：
- 要么加 `app.delete("/v1/ddns/config")`（清配置文件 + credentials）
- 要么 CLAUDE.md 明说"清配置只能删磁盘 `~/.local/share/jarvis/ddns.json` + 重启"
- 顺便修 Fastify content-type parser 顺序：让路由不存在时永远返 404 而不是被 body-parser 错误抢先

#### 4.5.5 `POST /v1/ddns/upnp/test` **07-02 漏 route**

```
POST /v1/ddns/upnp/test {} → 200 {
  mapped: false,
  externalPort: 7099,
  internalPort: 7099,
  message: "no UPnP gateway found on the LAN — forward the port manually on your router"
}
```

**4 keys ★**。UPnP 探测走 M-SEARCH，找不到 gateway 就 mapped=false，附 actionable message。**这是 CLAUDE.md 里 DDNS 段完全没提到的 route**。

#### 4.5.6 `GET /v1/remote/pairing` **07-02 漏 route**

```
GET /v1/remote/pairing → 200 {
  device_name: "zhangjianandeMacBook-Pro.local",
  token: null,                                                # ← 无 JARVIS_ACCESS_TOKEN
  origins: [
    "http://192.168.1.164:7099",
    "http://198.18.0.1:7099",
    "http://test-jarvis-07-03-aaaa:7099"                     # ← DDNS hostname 直接进 origins
  ],
  pairing_links: [
    {origin, link: "jarvis://pair?origin=<url-encoded>&name=<device>"},
    ...
  ]
}
```

**4 keys ★**。`pairing_links[*]` 每条 2 keys `{origin, link}`。**cross-feature integration ★★**：`origins` 包含 DDNS hostname —— iOS 端扫描/接收这个 pairing link 可以直接对外网（DDNS）+ LAN 两条路径同时握手。**这是"iOS + DDNS"功能路径的关键一步**，CLAUDE.md 应该补齐。

**注意**：`token:null` 是因为**没设 `JARVIS_ACCESS_TOKEN`**——一旦设置，pairing link 会附 `?token=<value>`，客户端拿到就带 bearer 走 REST。今天未测这条子路径。

#### 4.5.7 `POST /v1/ddns/update` 回全套 status wire shape ★

```
POST /v1/ddns/update {} → 200 {
  # 完整回 status 8 keys（enabled, configured, lan_addrs, reachable, provider, hostname, public_ip, last_result）
}
```

**observation**：`update` 是 fire-and-forget + immediate-status，不返 `{ok:true}` 之类，直接返最新 status。**这个语义 07-02 也未 clarify**。

#### 4.5.8 `remote/info.external` 3 keys ★ 07-02 漏 `public_ip`

```
GET /v1/remote/info → 200 {
  device_name, lan_addrs, port,
  external: {
    hostname: "test-jarvis-07-03-aaaa",
    public_ip: "67.200.120.26",     # ← 07-02 报告只见 hostname + reachable
    reachable: null
  },
  requires_auth: false,
  version: "0.2.0"
}
```

`external.public_ip` 07-02 漏——今天首入档。**触发条件**：一旦 DDNS 配好 + provider 拉过公网 IP 就填。

### 4.6 Memory 完整第二日：**target 目录语义 + 4 route 全 happy path 落地**

07-02 §4.6 只跑通 GET status/includes + POST includes(missing target)/sync_setup/sync 5 条，`POST includes(with target)` 走的是 `{path:"..."}`（missing target 400），没跑通 happy path。今天全落地：

#### 4.6.1 `GET /v1/memory/includes?scope=user` **07-02 §7 未验证项落地**

```
GET /v1/memory/includes → 200 {
  scope: "workspace",
  memory_md: "/tmp/jarvis-servlet-test/.jarvis/memory/MEMORY.md",
  items: []
}

GET /v1/memory/includes?scope=user → 200 {
  scope: "user",
  memory_md: "/tmp/jarvis-mem-07-03/.jarvis/memory/MEMORY.md",
  items: []
}
```

`scope` 枚举确认包含 `"workspace"` / `"user"`。scope=user 时 `memory_md` 走 `JARVIS_MEMORY_USER_ROOT/.jarvis/memory/MEMORY.md` 路径。

#### 4.6.2 `POST /v1/memory/includes` target 语义 —— **07-02 报告 target 名字对，但 target 内涵漏说**

07-02 只知道要 `target` 而不是 `path`。今天完整探：

```
POST /v1/memory/includes body={target:"shared/tone.md"} → 400 {error:"include path not found: shared/tone.md"}
```

追代码 `packages/tools/src/memory-tools.ts:886` `normaliseMemoryDir()`：
- **target 必须是"目录"**（不是文件！）
- 目录必须**含 MEMORY.md**（直接含 `<target>/MEMORY.md`，或含 `<target>/.jarvis/memory/MEMORY.md`）

正确写法：

```
mkdir /tmp/shared-memory && echo "# Shared tone" > /tmp/shared-memory/MEMORY.md

POST /v1/memory/includes body={target:"/tmp/shared-memory"} → 200 {
  ok: true,
  added: "/tmp/shared-memory",
  scope: "workspace",
  memory_md: "/tmp/jarvis-servlet-test/.jarvis/memory/MEMORY.md"
}
```

**4 keys ★**。`added` 回显 target；`scope` 表示 target 加进了 workspace-level MEMORY.md 的 include 表；`memory_md` 顶层 MEMORY.md 路径不变。

#### 4.6.3 `GET /v1/memory/includes` 加过之后 shape

```
GET /v1/memory/includes → 200 {
  scope: "workspace",
  memory_md: "/tmp/jarvis-servlet-test/.jarvis/memory/MEMORY.md",
  items: [
    {
      target: "/tmp/shared-memory",
      kind: "local_path",
      resolves: true,
      path: "/tmp/shared-memory"
    }
  ]
}
```

**item 4 keys ★**。`kind` 枚举猜 `"local_path"` / `"git"`（下文 refresh 提示"only applies to git+ includes"侧证）。`resolves` bool 表示 target 是否可达。**这是 07-02 完全没跑到的 shape**。

#### 4.6.4 `DELETE /v1/memory/includes` **07-02 §7 未验证项落地**

```
DELETE /v1/memory/includes body={target:"/tmp/shared-memory"} → 200 {
  ok: true,
  removed: "/tmp/shared-memory",
  scope: "workspace"
}
# 3 keys ★

# 空 target 时
DELETE /v1/memory/includes body={} → 400 {error:"missing `target`"}
```

DELETE 幂等：同 target 再 DELETE 一次今天没测（下次滚）。

#### 4.6.5 `POST /v1/memory/includes/refresh` 对 local_path 不适用

```
POST /v1/memory/includes/refresh body={target:"/tmp/shared-memory"} → 400 {error:"refresh only applies to git+ includes"}
POST /v1/memory/includes/refresh body={} → 400 {error:"missing `target`"}
```

**含义**：`kind:"local_path"` include 是**磁盘直读**，不需要 refresh；只有 `kind:"git"` include（想必是 `git+<url>` target）需要 `git pull` 那样的 refresh。**这也侧证了 kind 枚举**。

#### 4.6.6 backend=none 下 sync_setup / sync 503（07-02 回归）

```
POST /v1/memory/sync_setup {} → 503 {error:"git sync setup only applies to the `git` backend", backend:"none"}
POST /v1/memory/sync {} → 503 {error:"memory.sync only applies to the `git` backend — current backend is not git", backend:"none"}
```
**完整复现 07-02 结论**。

### 4.7 `POST /v1/workflows` 500 body.message 字段（07-02 结论 07-03 二次回归）

10 shape 500 全部返 `{statusCode:500, error:"Internal Server Error", message:"<runtime message>"}`。今天 body.message 内容与 07-02 一字不差：`"steps.map is not a function"` / `"Cannot read properties of undefined ..."`。

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
```

**4 种体例**：503+hint 是 8 条主流；200+flag 是 1 条特例（`diagnostics/memory`，即使 `JARVIS_ENABLE_MEMORY=1` + backend=none 也返 200 + `{backend:"unknown", stats_available:false}`）；还有 07-02 报的 503 bare 和 200+空数据两种。

### 4.9 `POST /v1/requirements/:id/reject` shape 复现

```
POST /v1/requirements/<orphan_rid>/reject body={"reason":"test-reject-07-03"} → 200 {rejected:true, deleted:true, reason:"test-reject-07-03"}
```
**3 keys 与 07-02 一致**。orphan 行也能被 reject 且返 200——`reject` handler 按 requirement id 查而不校验 project_id 存在，与 §3.4 一致。

### 4.10 `/v1/version` + `/health` + `/v1/health` 三分裂（07-02 回归）

```
GET /v1/version  → 200 {name:"jarvis", version:"0.2.0"}
GET /health      → 200 {status:"ok"}
GET /v1/health   → 404 Route not found
```
**未修（第 2 次）**。

### 4.11 `GET /v1/workflows` vs 单 GET 分裂（07-02 回归）

```
GET /v1/workflows/<id> → 200 {created_at, description, id, name, steps, updated_at}   # 裸对象
GET /v1/workflows      → 200 {items: [...]}                                            # {items:[]}
```
**完全复现**。仍与 `/v1/projects` 的裸数组 3 种 list shape 分裂。

---

## 5. 单测健康

```
$ pnpm --filter @jarvis/server test
# tests 522, pass 522, fail 0, duration_ms 7777
```

522/522 全绿，7777 ms（-7 ms vs 07-02，噪声范围内）。

| 日期 | tests | pass | fail | duration_ms |
| --- | --- | --- | --- | --- |
| 06-28 | 522 | 522 | 0 | 7706 |
| 06-29 | 522 | 522 | 0 | 7702 |
| 06-30 | 522 | 522 | 0 | 7703 |
| 07-01 | 522 | 522 | 0 | 7682 |
| 07-02 | 522 | 522 | 0 | 7784 |
| **07-03** | 522 | 522 | 0 | **7777** |

10 天区间 7682-7784 ms（1.3% 浮动，纯 IO/调度噪声）。

`packages/store` sqlite ABI mismatch 与主诊断路径无关，本次不复测。

---

## 6. 合并建议优先级（06-23 → 07-03 十日汇总）

| 优先级 | 项 | 文件/位置 | 累计状态 |
| --- | --- | --- | --- |
| **P0** | Web UI 在 cold-start 时折叠 `overall_score` 卡片。**方法**：判 `actions.find(a => a.key === "fill_signal_gaps")` 存在，直接渲染其 title `"补齐观测样本"`。1 个 if + 5 分钟 | `apps/jarvis-web/src/components/Observability/...` | 06-25 抬升，**10 天未修** |
| **P1（升级）** | `requirements-routes.ts` create+patch 加 `acceptance_policy / workflow_id / assignee_id / verification_plan` 透传；单测 happy path + bogus value + 真 UUID 三种 | `:147-167`、`:206`、`:255` + `packages/tools/src/requirement-tools.ts` | **第 10 次报告** |
| **P1** | `POST /v1/workflows` 6 处类型/字段守卫补齐 —— 顶层非数组 + 数组元素非 object + name 非 string + kind 非 object + kind.type 不在枚举 + agent.prompt 非 string；6 条反例单测 | `packages/server/src/workflow-routes.ts:156-200` + `workflow-routes.test.ts:115` | **第 4 次复现** |
| P1 | `roadmap.import` 工具 + REST 移植；或 CLAUDE.md 显式标记 deferred | `packages/tools/src/`、`CLAUDE.md` | **10 天未修** |
| P1 | requirements create/patch 加 project_id 存在性校验 → 404；同时新增 `GET /v1/requirements/:id` | `requirements-routes.ts:206/:255`，新增 `:?` | **第 9 次报告** |
| P1 | `depends_on` 跨 id 存在性校验 | `requirements-routes.ts:233-237/:298-302` | **6 天未修** |
| **P2（升级）** | Wire-shape codify 到 `docs/conventions/` 或 CLAUDE.md：`/v1/observability/health` / `runs/*` / `/v1/requirements/:id/runs` / `/v1/work/*` / `/v1/workflows` / `/v1/workflow-runs/:id`（含 `finished_at` 时间戳不刷新语义）/ `/v1/workspaces` / `/v1/remote/info`（含 DDNS 时 `external.hostname/public_ip/reachable`）/ `/v1/providers` / `/v1/version` / **`/v1/ddns/status` 完整 8 keys（新增 `public_ip` + `last_result`）** / `/v1/ddns/upnp/test`（4 keys） / `/v1/remote/pairing`（4 keys + cross-DDNS integration） / `/v1/memory/*`（含 include kind 枚举 + target 语义 "含 MEMORY.md 的目录"） | `docs/conventions/` 或 CLAUDE.md | **07-03 大幅新增**（4 条新 wire shape + 2 条新 route + include 语义补齐） |
| **P2（升级）** | "未配 feature" 路由口径统一 —— 4 种体例（503+hint / 503 bare / 200+flag / 200+空数据），都收敛到 503+hint | `packages/server/src/diagnostics-routes.ts`、`memory-sync-routes.ts` | **6 天未修** |
| **P2（升级）** | list 路由 shape 收敛：3 种体例（裸数组 / `{items:[]}` / `{workspaces:[]}`）并存 | `projects-routes.ts` + `workspaces-routes.ts` + CLAUDE.md | **5 天未修** |
| **P2（升级 / 07-03 新扩）** | `server/info` 里补 `ddns` / `memory_enabled` / `mdns` 字段——即使 boolean 也让客户端一次读取 | `packages/server/src/server-info.ts` 附近 | **第 2 次报告** |
| **P2（新增 P2）** | **DDNS 配置持久化路径 + 明文 credentials 语义写入 CLAUDE.md**：`~/.local/share/jarvis/ddns.json`（mode 0600，明文），"API 层永不回值 vs 磁盘层明文"两层语义分开写 | CLAUDE.md DDNS 段 + `packages/ddns/src/runtime.ts:149-153` 附近注释 | **07-03 新入档** |
| **P2（升级）** | `POST /v1/workflows` 500 body 里错误文案在 `message` 字段而不是 `error` | CLAUDE.md 或 SDK docs | 07-02 报，**未修** |
| **P2（升级 / 07-03 结论修正）** | **`DELETE /v1/ddns/config` 不是 Fastify content-type footgun 而是 route 缺失**。要么加 handler，要么 CLAUDE.md 显式说"清 DDNS 配置 = rm 磁盘 + 重启"；顺便修 Fastify body-parser 顺序（route 不存在时永远 404，不被 body 400 抢先） | `packages/server/src/ddns-routes.ts` + Fastify config | **07-03 结论修正 + 未修** |
| P2 | approve idempotent + reject "软删非回退" 语义、instructions trim-aware、slug 冲突 409 vs 后缀行为、workflow name 允许重复无 slug 唯一——全部加进 CLAUDE.md | CLAUDE.md 项目段 + workflow 段 | 06-29 起，**5 天未修** |
| P2 | `depends_on` wire shape 稳定化（omit → server 补 `[]` 或客户端 normalize） | `requirements-routes.ts` 序列化处 | **6 天未修** |
| **P3（升级）** | CLAUDE.md 补 `POST /v1/memory/includes` 完整规范：`target` = "含 `MEMORY.md` 的目录"（不是文件、也不是任意路径）；`kind` 枚举 `"local_path"` / `"git"`；refresh 仅对 git+ | CLAUDE.md memory 段 | **07-03 补充新语义** |
| **P3** | CLAUDE.md 补 `POST /v1/ddns/upnp/test`（4 keys）+ `GET /v1/remote/pairing`（4 keys + `pairing_links[*]:{origin,link}` + 与 DDNS/access-token cross-feature） | CLAUDE.md DDNS 段 | **07-03 新增** |
| P3 | `/v1/version` vs `/health` vs `/v1/health` 三分裂：`/v1/health` 404，补别名或 CLAUDE.md 说明 | `packages/server/src/router.ts` + CLAUDE.md | **第 2 次报告** |
| P3 | `/v1/diagnostics/runs/stuck?threshold_seconds=N` 行为在 CLAUDE.md 显式：仅返 `age_seconds >= N` 的 pending run；无 query 时 default > 4 秒 | `diagnostics-routes.ts` + CLAUDE.md | **4 天未修** |
| P3 | `ObservabilityStore` / `EvalStore` 的 env-driven 拉起方式在 CLAUDE.md 文档化 | CLAUDE.md | 未修 |
| **P3（新增）** | Servlet 测试目录（`/tmp/jarvis-servlet-test/src/main/java/com/example/HelloServlet.java`）今天开机时**已消失**——不影响本轮 stub 结论，但下轮 LLM-驱动测试需**固化**基线（考虑 fixture 或 makefile 复位步骤） | `Makefile` 或 `scripts/servlet-fixture-reset.sh` | **07-03 新增** |

---

## 7. 复测剧本（有 LLM key 时；与 07-02 §7 一致 + 07-03 新增项）

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

- **仍留白**（06-30 → 07-03 累积）：subagent.review 真 flip、triage.scan_candidates 建 ProposedByScan、project.checks 识别 Maven 缺 pom.xml、bogus project_id 之后 agent 侧 requirement.list 是否拿回、step_results[*] shape 在有 LLM key 时、`POST /v1/workflow-runs/:succeeded_run/cancel` 是否 200 no-op（今天只测 cancelled → cancel 200）
- **07-03 新留白**：
  - `JARVIS_MEMORY_SYNC_BACKEND=git` 起飞后 `POST /v1/memory/sync_setup` / `sync` 的 happy-path shape
  - `POST /v1/memory/includes body={target:"git+https://..."}` happy path shape + `kind:"git"` include shape + `refresh` on `kind:"git"` happy path
  - `PUT /v1/ddns/config record_type` 除 A/AAAA 外的枚举（"CNAME"? 现实里 duckdns 只支持 A/AAAA，但 provider=cloudflare 支持 CNAME）
  - `JARVIS_ACCESS_TOKEN=<token>` 起飞后 `GET /v1/remote/pairing` 的 `token` 字段 + `pairing_links[*].link` 是否带 `?token=<val>`
  - `POST /v1/ddns/upnp/test` 在真有 UPnP gateway 网络下的 shape（今天 message 是 "no UPnP gateway found"）
  - `POST /v1/ddns/upnp/test` 参数化探测（是否支持自定义 externalPort？body shape？）
  - `DELETE /v1/memory/includes` 幂等（今天没测重复 DELETE 是 200 no-op 还是 404）

---

## 8. 总览

| 项 | 评分 | 与 07-02 比 |
| --- | --- | --- |
| Kanban (Project + Requirement CRUD + 状态转换 + Activity) | ✅ 健康 | 持平 |
| Workflow CRUD + dispatch + cancel（幂等 + `finished_at` 不刷新） | ✅ 健康（除 §3.7 的 10 种 500 泄漏） | 07-03 补 finished_at 不刷新语义 |
| Diagnostics (`/v1/diagnostics/*` + `/v1/work/*`) | ✅ 健康 | 持平 |
| Harness.health 算法实装 | ✅ 稳定第 10 天 —— 3 fingerprint（sample=1/3/4）全复现 | 持平 |
| Harness.health 信号采集 | ⚠️ 缺 LLM 驱动时无信号；`actor_breakdown` / `verification_pass_rate` 顶层 null | 持平 |
| Harness.health 前端表达 | ❌ confidence 低分仍直接展示 score | **10 天未修** |
| DDNS 后端 | ✅ 健康 + 4 keys 补齐 + upnp/test / remote/pairing 首入档 + config 持久化路径揭底 + credentials 磁盘明文安全语义澄清 | 07-03 大幅补齐 |
| Memory 后端（backend=none） | ✅ 健康 + include target 语义澄清（"含 MEMORY.md 的目录"）+ scope=user 落地 + kind=local_path/git 枚举侧证 + DELETE/refresh 落地 | 07-03 大幅补齐 |
| REST ↔ 数据模型一致性 | ❌ 4 字段 POST+PATCH 丢；project_id 无 FK；depends_on 跨 id 无 FK；无 `GET /v1/requirements/:id`；depends_on 条件性写回；list shape 三分裂 | 持平（第 10 次） |
| 文档 ↔ 运行时一致性 | ⚠️ roadmap.import 文档 ✅ 但 404；`server/info` 不反映 DDNS/memory；`POST /v1/memory/includes` body target 语义未文档化；`/v1/health` 404；DELETE 无 body 时 fastify 400（真相 = 无 route）；`upnp/test` + `remote/pairing` 完全未文档化 | 07-03 揭底更多缺口 |
| 单测覆盖 | ✅ 522/522 全绿，7777 ms | 持平（噪声内） |
| **真 bug**：`POST /v1/workflows` 500 泄漏 | ❌ 10 shape 500 / 6 shape 400 完全复现 | 持平（第 4 次） |
| **真 bug**：`DELETE /v1/ddns/config` 无 handler（07-02 结论修正） | ❌ 从"footgun"降级为"缺 route + parser 顺序遮蔽" | 07-03 修正诊断 |
| 自动化的端到端验证（有 LLM key） | ❌ 本次仍未执行 | 持平 |

**总体判断**：HEAD 在 06-23 → 07-03 **十天**没动，工作树未 commit 文件持平 39，所以 07-02 的所有 P0/P1 结论**原样成立**。本次实际增量价值：

1. **07-02 §7 未验证项落地 4 条**：`memory/includes` happy path（POST + DELETE + refresh + scope=user）——4 条 route 全通 + include kind 枚举侧证。
2. **DDNS wire shape 大补**：`status` 新增 `public_ip` + `last_result` 两 keys（8 keys 完整版）；`remote/info.external` 新增 `public_ip`；两条**07-02 未发现的 route**（`upnp/test` + `remote/pairing`）首入档；`record_type:"AAAA"` accept ✓。
3. **07-02 结论修正**：`DELETE /v1/ddns/config` 不是 "Fastify content-type footgun"，是 **route 根本不存在** —— 400 的表象是 body-parser 顺序抢在 route match 之前。
4. **DDNS 配置持久化路径揭底**：`~/.local/share/jarvis/ddns.json`（mode 0600，明文 credentials）—— **API 层永不回值 vs 磁盘层明文**两层语义分开写。
5. **Cross-feature integration 观察**：`/v1/remote/pairing.origins/pairing_links` 包含 DDNS hostname —— iOS + DDNS 功能路径的关键一步。
6. **算法稳定性 fingerprint 再确认**：sample=1/3/4 三条 fingerprint 与 07-02 逐位相等 —— 用做 regression smoke 特别可靠。

**建议**：下次合 P1 修复时**同时**做：①4 字段透传 create+patch；②project_id FK + `GET /v1/requirements/:id`；③depends_on FK；④workflow POST 6 处类型守卫；⑤`DELETE /v1/ddns/config` 加 route（清磁盘 + credentials 归零）；⑥`server/info` 补 ddns/mdns/memory_enabled 字段；⑦一次性 codify DDNS 5 route（status 8 keys + upnp/test + remote/pairing）+ memory 4 route（含 target 目录语义 + kind 枚举）+ cancelled workflow run `finished_at` 不刷新 + slug 409 到 CLAUDE.md。

**P0 修复（10 天）**：前端读 `actions.find(a => a.key === "fill_signal_gaps")` 当 cold-start 兜底信号，改 1 行 5 分钟——十天延期的根本原因还是被误判成"需要重新设计"。

**Servlet 测试基线加固**：`/tmp/jarvis-servlet-test/src/main/java/com/example/HelloServlet.java` 今天启动前已消失（07-02 报告里明确存在）；虽然不影响 stub 模式结论，但 LLM-驱动测试需固化基线——建议加一个 `scripts/servlet-fixture-reset.sh` 每次跑前重置。
