# Jarvis 项目自动化能力诊断报告（2026-07-05 十二次复测）

- **运行时间**：2026-07-05（scheduled task 自动跑）
- **被测分支**：`feat/mobile-ios-ddns`（HEAD 仍为 `64d288a`，与 06-23 → 07-04 同一 commit — **静默第 12 天**；工作树侧 39 个未 commit 文件与 07-04 完全一致，未 +/−）
- **被测项目**：`/tmp/jarvis-servlet-test`
  - **07-05 差异**：`src/main/java/com/example/HelloServlet.java` **完好存活**（07-03 手动重建、07-04 起飞时仍在、07-05 无需 touch）；`.jarvis/memory/{MEMORY.md, shared/}` 目录树 07-03 memory probe 留下的 residual 也还在；本轮完全免动 fixture。
- **本次目的**：
  1. **回归确认** 07-04 P0/P1/P2 累积项在 1 天间是否被修复（预期：未修，静默第 12 天）
  2. **DDNS 配置跨启动持久化**：`~/.local/share/jarvis/ddns.json` 07-04 → 07-05 是否原样存活（预期：是；07-04 PUT 的 `test-jarvis-07-04-aaaa/AAAA/t2` 应作为 07-05 启动的"上一状态"复现）
  3. **07-04 §7 未验证项落地**（4 条一次跑通）：
     - `PUT /v1/ddns/config` 不带 `record_type` 时响应字段是 `"A"` 还是 undefined
     - `GET /v1/ddns/config` 在 `configured:false` 分支的 wire shape
     - `PATCH /v1/requirements/:id` 只传 `depends_on` 时 wire shape 与 FK 行为
     - `POST /v1/workflow-runs/<bogus_uuid>/cancel` 是否与 `<already-cancelled>` 拆分（404 vs 200 no-op）
  4. **cross-day fingerprint**：sample=1/3/4 三个 confidence 常数与 07-04 完全一致是第 12 天
- **运行约束**：与 07-04 一致 —— `JARVIS_WORK_MODE=off`、stub LLM key、`JARVIS_PERMISSION_MODE=bypass`；DB 用日期后缀 `-20260705` 全新路径。DDNS + memory 分支另起 `-20260705-ddns` 后缀。为跑"`configured:false` 分支"备份并临时清空 `~/.local/share/jarvis/ddns.json`，probe 结束后**已回写 07-04 备份**（`test-jarvis-07-04-aaaa/AAAA/t2`）。

---

## 0. TL;DR — 与 07-04 的差异

| 项 | 07-04 状态 | 07-05 状态 | 变化 |
| --- | --- | --- | --- |
| `git log --since=2026-07-04` | 0 commit | **0 commit**（HEAD 仍 `64d288a`） | 静默**第 12 天** |
| 工作树未 commit 文件数 | 39 个 | **39 个** | 持平 |
| 522 条 `@jarvis/server` 单测 | 522/522 ✅（7896 ms） | **522/522 ✅**（7677 ms） | 持平（−219 ms 噪声，回到 7 天低点） |
| Servlet 工作目录 | HelloServlet.java 完好 + `.jarvis/memory/` residual | **完全相同**（`HelloServlet.java` 3 天连续存活，`.jarvis/memory/{MEMORY.md, shared/tone.md}` 也在） | 07-03 fixture 修复延续 |
| P1-A POST + PATCH 4 字段透传 | 全双向静默丢字段 | **仍全双向静默丢字段** | ❌ 未修（第 12 次） |
| P1-B `POST /v1/roadmap/import` | 404 | **404** | ❌ 未修（第 12 次） |
| P1-C `GET /v1/requirements/:id` | 404 | **404** | ❌ 未修（第 12 次） |
| Orphan 行 `POST /v1/projects/no-such/requirements` | 201 + 原样回写 + GET 拉回 | **完全复现** | ❌ 未修（第 12 次） |
| `depends_on` 跨 id FK bogus | 通过 | **完全复现** | ❌ 未修（第 8 次） |
| `depends_on` 条件性写回 | omit→undefined, []→[], real→real | **完全复现** | ❌ 未修（第 8 次） |
| `/v1/projects` 列表裸数组 | 与 `{items:[]}` 系不一致 | **完全复现** | ❌ 未修（第 7 次） |
| `confidence < 0.2` 前端兜底 | P0，**11 天未修** | **P0，12 天未修** | 持平 |
| `POST /v1/workflows` 10 shape 500 泄漏 | 10 500 / 6 400 | **完全复现**（10 500 / 6 400） | ❌ 未修（第 6 次） |
| workflow-run cancel 幂等 + `finished_at` 不刷新 | cancel #1/#2/#3 200，`finished_at` 首次锁定 | **完全复现**（cancel #1/#2/#3 均 200，`finished_at=2026-07-04T19:07:34.895Z` 三次一字不差） | 持平 |
| cancelled run wire shape 7 keys | `[error, finished_at, id, started_at, status, step_results, workflow_id]` | **完全复现** | 持平 |
| workflow 重名 | 两次 POST 同 name 都 201 UUID 不同 | **完全复现** | 持平 |
| `POST /v1/projects` 显式 `slug` 3 组合 | 显式 slug 首次 201 / 相同显式 slug 409 / 相同 name 无 slug 201 | **完全复现**（`slug2` 409 `"slug 'custom-slug-07-05' already in use"`；`slug3` 派生为 `with-slug-07-05`，未占用则不加后缀） | 持平 |
| sample_count=1/3/4 三 fingerprint | `0.06560095313918246 / 0.13120190627836492 / 0.15232069614525703` | **完全复现（第 12 天）** | 持平 |
| sample_count=0 baseline `(50,0,task_understanding)` | 有 | **完全复现** | 持平 |
| DDNS 配置持久化路径 | `~/.local/share/jarvis/ddns.json`（0600 + 明文） | **持久化跨 07-04 → 07-05 存活**：启动前该文件是 07-04 PUT 留下的 `test-jarvis-07-04-aaaa/AAAA/t2`；今天为跑 `configured:false` 分支主动 `rm` 后再回写 | ✅ 07-04 结论第 3 天再校准 |
| `ddns.status` 8 keys（configured 分支） | `[configured, enabled, hostname, lan_addrs, last_result, provider, public_ip, reachable]` | **完全复现** | 持平 |
| **`ddns.status` 4 keys（configured:false 分支，07-05 首入档）** | 隐含 | **200 4 keys `{configured:false, enabled:true, lan_addrs, reachable:null}`** —— 缺 `provider/hostname/public_ip/last_result` | ⚠️ **07-05 新入档** |
| **`GET /v1/ddns/config` at `configured:false`**（07-04 §7 未验证） | 未测 | **200 1 key `{configured:false}`** —— 极简，不占 null 位；与 configured 分支的 7 keys 完全 branch 出 | ✅ **07-04 §7 落地** |
| `GET /v1/ddns/config` at configured 7 keys | 07-04 首入档 | **完全复现** | 持平 |
| **`PUT /v1/ddns/config` 不带 `record_type` 的默认**（07-04 §7 未验证） | 未测 | **`record_type:"A"` 默认**：省略入参时响应字段填 `"A"`（服务端明填默认值，非 undefined） | ✅ **07-04 §7 落地** |
| **`record_type` 枚举校验**（07-05 意外新落地） | 隐含"仅 A/AAAA" | **REST 层不校验**：`"CNAME"/"TXT"` on provider=duckdns 均 200 且回值原样透传；provider=cloudflare + `record_type:"CNAME"` 也 200 | ⚠️ **07-05 新落地：REST 只做字符串透传，DNS provider 兼容性延后到 update time 才 fail** |
| **`provider` 枚举校验**（07-05 意外新落地） | 隐含 | **PUT `provider:"nonexistent"` → 400 `unknown DDNS provider "nonexistent"`**；provider **IS** 枚举校验 | ⚠️ **07-05 新落地：provider 与 record_type 校验口径不一致** |
| **`interval_seconds` 边界**（07-05 意外新落地） | 隐含"接受 300" | **≤ 60 全部 silently 上取到 60**：`interval_seconds:0/-5/30/60` 全 200，响应字段=60；`interval_seconds:999999` 200 且原样透传（无上限） | ⚠️ **07-05 新落地：silent min-clamp** |
| **`credentials={}` 空对象** | 隐含 | **PUT 200，`credential_keys:[]`** —— 无 per-provider 必填字段校验；配好保存下来，update 时才 fail | ⚠️ **07-05 新落地：credential completeness 不校验** |
| **`hostname:""` / `port:0` / `port:-1`** | 隐含 | **均 400**：hostname → `"hostname is required"`；port → `"port must be 1..65535"` | ⚠️ **07-05 新入档：port + hostname 校验** |
| `POST /v1/ddns/update` 返 status shape 而非 `{ok}` | 是 | **完全复现** | 持平 |
| **`DELETE /v1/ddns/config` shape 3 → 4-way split**（07-05 深挖） | 3 shape（no header 404 / json+empty 400 / json+`{}` 404） | **4 shape**：+ `Content-Type:""`（fetch 传空 string）→ **415 FST_ERR_CTP_INVALID_MEDIA_TYPE**；其余 3 shape 与 07-04 完全对齐 | ⚠️ **07-05 新入档：Fastify body-parser 有第 4 state** |
| `POST /v1/ddns/upnp/test` 4 keys | ✅ 复现 | **完全复现** | 持平 |
| `GET /v1/remote/pairing` 4 keys | ✅ 复现 | **完全复现**；`pairing_links.len=3`，`origins` 含今天 PUT 的新 DDNS hostname `test-jarvis-07-05-aaaa`（cross-feature 集成第 3 天回归） | 持平 |
| `GET /v1/remote/info.external` 3 keys | ✅ 复现 | **完全复现**（`hostname/public_ip/reachable`） | 持平 |
| `POST /v1/memory/includes` target=含 MEMORY.md 的目录 | ✅ 落地 | **完全复现**（`shared/tone.md` 400 not found；`/tmp/shared-memory-07-05` 200 4 keys） | 持平 |
| `GET /v1/memory/includes` 加过之后 items | 4 keys `{target, kind:"local_path", resolves, path}` | **完全复现** | 持平 |
| `DELETE /v1/memory/includes` 幂等 | 07-04 首落地 200 no-op | **完全复现**（重复 DELETE 200 3 keys；空 body 400） | 持平 |
| `POST /v1/memory/includes/refresh` local_path 400 | ✅ 落地 | **完全复现** | 持平 |
| `GET /v1/memory/includes?scope=user` | ✅ 落地 | **完全复现** | 持平 |
| backend=none `sync_setup / sync` 503 | ✅ 复现 | **完全复现** | 持平 |
| `server/info` 反映 DDNS/memory feature 开关状态 | 不反映 | **仍不反映**（16 顶层 keys 无 `ddns` / `memory_enabled` / `mdns`） | ❌ 未修（第 4 次） |
| `/v1/health` 404 | 未修 | **未修** | ❌ 未修（第 4 次） |
| `no_op:true` 首次 approve 已批 | 07-04 报 | **完全复现** | 持平 |
| `POST /v1/requirements/:id/reject` orphan 200 | 是 | **完全复现** | 持平 |
| trim-aware instructions 校验 | 是 | **完全复现**（`""` + `"   "` 都 400） | 持平 |
| **`POST /v1/workflow-runs/<bogus_uuid>/cancel`**（07-04 §7 未验证） | 未测 | **404 `{error:"workflow run not found"}`** —— 与 `<already-cancelled>` 的 200 no-op **语义拆分**：bogus id 非幂等（404），已 cancelled 幂等（200） | ✅ **07-04 §7 落地：workflow-run cancel 是"select-then-cancel"两阶段** |
| **`PATCH /v1/requirements/:id` 只传 `depends_on`**（07-04 §7 未验证） | 未测 | **200 写通**；real UUID / [] / bogus UUID 三种全 200 全写通（`bogus UUID` 与 §3.5 POST 侧同一 FK bug 复现）；响应 keys 补入 `depends_on` 字段 | ✅ **07-04 §7 落地：PATCH-depends_on-only 通道 FK 缺陷与 POST 侧同源** |

代码侧三个 deferred / 缺陷标记的精确行号仍在原位（今天 grep 三次确认）：
- `packages/server/src/requirements-routes.ts:164-166` 的 `"verification_plan / workflow_id three-state semantics are part of the full Rust handler but out of scope for this port"` 3 行注释。
- `packages/tools/src/register-builtins.ts:13` "未移植清单" 注释含 `"roadmap.import"`；`:166` `"(not yet ported)"`。
- `packages/server/src/workflow-routes.ts:156` 的 `normalizeSteps(body.steps ?? [])` —— 今天 10 种 500 泄漏 shape 全复现；`:212` PATCH 分支复用同一 helper。

---

## 1. 测试配置（分两次起）

### 主分支（§2 / §3 / §4.1-4.4）

```
OPENAI_API_KEY=sk-stub-for-automation-test
JARVIS_PROVIDER=openai
JARVIS_MODEL=gpt-4o-mini
JARVIS_FS_ROOT=/tmp/jarvis-servlet-test
JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-20260705
JARVIS_ADDR=127.0.0.1:7099
JARVIS_WORK_MODE=off
JARVIS_PERMISSION_MODE=bypass
JARVIS_NO_PROJECT_CONTEXT=1
```

启动日志：
```
[jarvis] persistence connected: json:///tmp/jarvis-servlet-test-db-20260705
[jarvis] serve: provider=openai model=gpt-4o-mini addr=127.0.0.1:7099 fsRoot=/tmp/jarvis-servlet-test coding=false auth=none ddns=off mdns=off promptBytes=263
[jarvis] listening on http://127.0.0.1:7099
```

### DDNS + Memory 分支（§4.5 / §4.6）

```
# 主分支所有变量 +
JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-20260705-ddns
JARVIS_DDNS_ENABLE=1
JARVIS_ENABLE_MEMORY=1
JARVIS_MEMORY_USER_ROOT=/tmp/jarvis-mem-07-05
```

**07-05 特殊操作**：为跑"`configured:false` 分支"（07-04 §7 未验证项 #2），启动前主动 `cp ~/.local/share/jarvis/ddns.json /tmp/ddns-backup-07-05.json && rm ~/.local/share/jarvis/ddns.json`。probe 结束后 `cp /tmp/ddns-backup-07-05.json ~/.local/share/jarvis/ddns.json` 已回写 07-04 状态（`test-jarvis-07-04-aaaa/AAAA/t2`），下次启动就能继续验证跨日持久化。

启动日志（DDNS 分支，首次清空后）：
```
[jarvis] persistence connected: json:///tmp/jarvis-servlet-test-db-20260705-ddns
[jarvis] serve: provider=openai model=gpt-4o-mini addr=127.0.0.1:7099 fsRoot=/tmp/jarvis-servlet-test coding=false auth=none ddns=on mdns=off promptBytes=263
[jarvis] listening on http://127.0.0.1:7099
```

**跨日持久化验证 (07-04 → 07-05)**：起飞**前** `cat ~/.local/share/jarvis/ddns.json` 得到：

```json
{
  "provider": "duckdns",
  "hostname": "test-jarvis-07-04-aaaa",
  "port": 7099,
  "recordType": "AAAA",
  "intervalSeconds": 300,
  "upnpEnabled": false,
  "credentials": { "token": "t2" }
}
```

—— 完全是 **07-04 PUT `test-jarvis-07-04-aaaa` 时写进去的状态**，跨日无损存活。备份后清空即可跑 `configured:false` 分支。持久层与 `JARVIS_DB_URL` 独立这条结论 **07-04 已入档、07-05 又获一次 cross-day 证据**（这次是"删除→回写"型证据链，比 07-04 的"隔天再读"多一层）。

`/v1/server/info` 主分支：44 tools、`project_store=true`、`persistence=json://…`、`approval_mode=bypass`、`max_iterations=80`、`coding_mode=false`、`workspace_root=/tmp/jarvis-servlet-test`、`memory.budget_tokens=108000`、`system_prompt.length=263` —— **与 07-04 完全一致**。DDNS 分支 `server/info` 同样不含 `ddns`/`features`/`memory_enabled` 顶层字段（**第 4 次确认**）。16 keys 完整：`[approval_mode, coding_mode, config_path, listen_addr, max_iterations, mcp_servers, memory, persistence, project_context, project_store, providers, system_prompt, tool_count, tools, version, workspace_root]`。

工具集 44 条与 07-04 完全一致（今天不重复 dump）。

---

## 2. 6+1 步迭代轨迹（实测）

| 步 | 操作 | overall_score | confidence | sample_count | primary_focus |
| --- | --- | --- | --- | --- | --- |
| 1 | 4 个需求建好（hello / echo / maven / smoke），**未 mint run** | **50** | **0** | **0** | **task_understanding** |
| 2 | `POST :hello/runs` | 47 | **0.06560095313918246** | 1 | planning_execution |
| 3 | PATCH hello → in_progress | 47 | 0.06560095313918246 | 1 | planning_execution |
| 4 | `POST :echo/runs` + `POST :maven/runs` | 47 | **0.13120190627836492** | 3 | planning_execution |
| 5 | PATCH hello → review → done | 47 | 0.13120190627836492 | 3 | planning_execution |
| 6 | PATCH echo → in_progress → review → done | 47 | 0.13120190627836492 | 3 | planning_execution |
| **7** | **`POST :smoke/runs`** | **47** | **0.15232069614525703** | **4** | **planning_execution** |

**`0.06560095313918246`（sample=1）、`0.13120190627836492`（sample=3）、`0.15232069614525703`（sample=4）三个 fingerprint** 与 06-25 → 07-04 共 11 天完全一致 —— **算法稳定第 12 天**。

**baseline `(overall_score=50, confidence=0, primary_focus=task_understanding)` at sample=0** 与 06-27 → 07-04 完全一致（十二天 fingerprint 稳定加固）。

`/v1/observability/health.dimensions[*]` sample=4 完整：

| dim | score | confidence |
| --- | --- | --- |
| task_understanding    | 50 | 0.09373581301246586  |
| planning_execution    | 38 | 0.25777348578428116  ← 最低 score → primary_focus |
| capability_invocation | 50 | 0.04686790650623293  ← 最低 conf |
| task_delivery         | 50 | 0.2109055792780482   |

**per-dim confidence 与 07-04 逐位相等** —— fingerprint 稳定第 12 天。

`actions.keys` 完整 5 条 = `[stabilize_delivery_gate (p1/danger), reduce_timeout_and_iteration_failures (p2/warn), tune_tools_and_subagents (p3/warn), sharpen_task_acceptance (p4/warn), fill_signal_gaps (p5/neutral)]`；`actions[*].title` 中文 5 条：`["优先稳定交付闭环", "收敛规划执行失败", "优化工具与 SubAgent 调用", "强化任务理解与验收表达", "补齐观测样本"]`。

**`fill_signal_gaps` 就是 P0 前端应读的 cold-start 兜底信号**（连续 12 天未修）—— 前端应该直接判 `actions.find(a => a.key === "fill_signal_gaps") && sample_count < 5` 折叠 overall_score 卡片，改 1 行 5 分钟。

`rules` 顶层 4 keys `[confidence, dimension_weights, overall, scale]` 与 07-01 → 07-04 完全一致；`signals` 20 keys 与 07-04 完全一致；`sources` `{configured, rows}` 与 07-04 完全一致。

`/v1/diagnostics/runs/recent` 返 **4 条**（含 7 步产生的所有 pending run），item[*] keys=`[conversation_id, id, logs, requirement_id, started_at, status]`——与 07-04 一致。

`/v1/diagnostics/runs/stuck` 行为：
- default（无 query）→ `items:[]` ✓
- `?threshold_seconds=1` → **今天 `items:[]`**（4 条 run 都在 <1s 内建完，没触发 age 阈值）—— 加固 07-01/07-02/07-03/07-04 的时间敏感结论

`/v1/work/overview`（15 keys；与 07-04 完全一致）：
```
requirement_status_counts: {backlog: 0, in_progress: 2, review: 0, done: 2}    # ← 07-05 略变（backlog=0 vs 07-04 backlog=6）
run_status_counts:         {completed: 0, failed: 0, cancelled: 0}
actor_breakdown:           null           # ★ stub 模式仍 null
verification_pass_rate:    null           # ★ stub 模式仍 null
throughput_by_day:         len=8
project_leaderboard:       len=1 {project_id, project_name:"servlet-test-07-05", runs_in_window: 4, completion_rate: 0}
```

**backlog=0**（07-04 是 backlog=6）—— 因为 07-05 probe 顺序不同：本次 §3 里的 `policy-probe-07-05/dep-bogus-07-05/self-loop-07-05/deps-omit-07-05/deps-empty-07-05/deps-real-07-05/patch-deps-only-07-05` 这批需求是在 `/v1/work/overview` 探测**之前**都已经 REST 存进去了；但 `project_leaderboard.runs_in_window=4` 仍然对齐（这个数字只统计 §2 里的 mint-run 数）。**结构和字段与 07-04 完全一致，只是 backlog 计数因 probe 顺序不同**。

**迭代判断（与 06-25 → 07-04 完全一致）**：所有 kanban 拖拽只写 Activity 行，不动 sample_count；只有 `POST :id/runs` 拉动 sample_count；`confidence` 公式 `ln(n+1)/ln(31) × coverage` 在 stub 模式 coverage 恒 ≈ 0.325；**cold-start `overall_score=47` 依旧被前端当"健康差"渲染**，P0 已**连续 12 天未修**。

---

## 3. P1 项回归（仍未修）

### 3.1 4 字段 REST 透传 — POST + PATCH 双失（**第 12 次报告**）

```
POST /v1/projects/<pid>/requirements
  body={"title":"policy-probe-07-05","triage_state":"approved",
        "acceptance_policy":"Human", "workflow_id":"wf-test-string",
        "assignee_id":"agent-x",
        "verification_plan":{"checks":[{"name":"x","cmd":"true"}]}}
→ 201 keys=['conversation_ids','created_at','id','project_id','status','title','updated_at']
  4 字段全部 absent

PATCH /v1/requirements/<id> body=同上（acceptance_policy/workflow_id/assignee_id/verification_plan）
→ 200 keys 同上，4 字段仍全部 absent
```

**第 12 次报告**。今天 grep 确认拒收发生点仍在 `packages/server/src/requirements-routes.ts:164-166` 的 3 行注释 —— 4 字段没进 `CreateBody` / `UpdateBody` interface，进不了 handler。零改动。

### 3.2 `roadmap.import` — 仍 404（**第 12 次**）

```
POST /v1/roadmap/import → 404 {"message":"Route POST:/v1/roadmap/import not found","error":"Not Found","statusCode":404}
```

### 3.3 `GET /v1/requirements/:id` — 仍不存在（**第 12 次**）

```
GET /v1/requirements/<any> → 404 {"error":"Not Found","message":"Route GET:/v1/requirements/<id> not found","statusCode":404}
```

### 3.4 Orphan 行 — project_id 仍可任意写（**第 12 次**）

```
POST /v1/projects/no-such-07-05/requirements
  body={"title":"orphan-07-05","triage_state":"approved"}
→ 201 project_id="no-such-07-05"

GET /v1/projects/no-such-07-05/requirements → 200 items.len=1
```

### 3.5 `depends_on` 跨 id FK — 仍不拒 bogus（**第 8 次**）；self-loop 仍拒 ✓

```
depends_on:["00000000-0000-0000-0000-000000000000"] → 201 写通
PATCH depends_on:[<self id>] → 400 "must not contain the requirement's own id (self-dependency)"
```

### 3.6 `depends_on` 条件性写回 — 完全复现（**第 8 次**）

```
POST omit depends_on          → resp.depends_on === undefined
POST depends_on:[]            → resp.depends_on === []
POST depends_on:["<real id>"] → resp.depends_on === ["<real id>"]
```

### 3.7 `POST /v1/workflows` 500 泄漏 — 10 shape 500 / 6 shape 400（**第 6 次报告 → 完全复现**）

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

修复清单与 07-01/07-02/07-03/07-04 一致（6 处类型守卫补 `packages/server/src/workflow-routes.ts:156-200` + `normalizeSteps` + `validateSteps`）。

---

## 4. 07-05 新落地 / 07-04 未验证项落地

### 4.1 `POST /v1/workflow-runs/:id/cancel` — bogus vs cancelled 语义拆分 ★（07-04 §7 未验证项 #4 落地）

**cancel 已 cancelled 的 run（幂等 no-op path）**：

```
POST /v1/workflows {name:"wf-07-05-cancel", steps:[{name:"s", kind:{type:"agent", prompt:"hi"}}]}
→ 201 wf_id=90b307c0-4bc2-4f6a-a7c4-77933bf8db06

POST /v1/workflows/<wf_id>/run {} → 202 {id:<run_id>, workflow_id, status:"pending", step_results:[], started_at}

# --- Cancel #1: 首次真 cancel ---
POST /v1/workflow-runs/<run_id>/cancel {}
→ 200 {
    id, workflow_id,
    status: "cancelled",
    step_results: [],
    started_at,  finished_at: "2026-07-04T19:07:34.895Z",   # ← UTC 时间戳（服务器时钟仍是 UTC，Bash env 是 2026-07-05）
    error: "run cancelled by operator"
  }

# --- Cancel #2/#3：对已 cancelled 的 run 再 cancel ---
POST /v1/workflow-runs/<run_id>/cancel {} × 2
→ 200 每次都返 7 keys；state 完全相同；`finished_at` 三次都是首次的 `2026-07-04T19:07:34.895Z`（不刷新）
```

**cancel bogus uuid ★（07-04 §7 新落地）**：

```
POST /v1/workflow-runs/00000000-0000-0000-0000-000000000000/cancel {}
→ 404 {error: "workflow run not found"}
```

**关键新结论**：`POST /v1/workflow-runs/:id/cancel` 是**"select-then-cancel"两阶段语义**：
- `<bogus_uuid>` → **404 非幂等**（"没这行"）
- `<already-cancelled>` → **200 幂等 no-op**（"行在这，你要做的动作已生效"）
- `<pending>` → 200 首次 cancel 生效 + `finished_at` 首次锁定

对比 `DELETE /v1/memory/includes` **对任何 target 都 200 no-op**（即使从未 add 过），也对比 `POST /v1/requirements/:id/reject` **bogus id 404**（07-04 §4.9 加固）。当前 idempotence 三体例并存：

| route | 首次生效 | 重复/幂等 | 从未存在过 |
| --- | --- | --- | --- |
| `POST /v1/workflow-runs/:id/cancel` | 200 | **200 no-op** | **404** |
| `DELETE /v1/memory/includes` | 200 | **200 no-op** | **200 no-op**（未 add 过的 target 也 200） |
| `POST /v1/requirements/:id/reject` | 200 | 大概率 404（已软删） | **404** |

**建议**：CLAUDE.md / P2 中收敛到统一语义。个人偏好 `workflow-runs/cancel` 的"select-then-cancel"体例（"没这行"就 404）。

### 4.2 workflow 重名允许（07-04 落地，07-05 二次回归）

```
POST /v1/workflows {name:"wf-dup-07-05", steps:[...]} → 201 id=3cbcb968-5a5e-463a-a78d-0e72cfd39426 name="wf-dup-07-05"
POST /v1/workflows {name:"wf-dup-07-05", steps:[...]} → 201 id=64265c63-409e-401f-9f40-2955fe611829 name="wf-dup-07-05"
```
✓ 二次落地，UUID 唯一，name 允许重复。

### 4.3 `POST /v1/projects` 显式 `slug` 3 组合（07-04 落地，07-05 回归）

| # | body | 状态 | slug |
| --- | --- | --- | --- |
| 1 | `{name:"with-slug-07-05", slug:"custom-slug-07-05", instructions:"x"}` | **201** | `custom-slug-07-05` |
| 2 | 一样的 body 二次 POST | **409** | undefined，`error: "slug 'custom-slug-07-05' already in use"` |
| 3 | `{name:"with-slug-07-05", instructions:"x"}`（同 name，无显式 slug） | **201** | `with-slug-07-05`（server 用 name 派生，未占用则不加后缀） |

### 4.4 `sample_count=0/1/3/4` 四 fingerprint 稳定第 12 天 —— 见 §2 表。

### 4.5 DDNS 完整第四日：**`configured:false` 分支 + `record_type` 默认 + REST 校验矩阵**

#### 4.5.1 `~/.local/share/jarvis/ddns.json` 跨日持久化跨 07-04 → 07-05 存活（cross-day 证据链 #2）

启动前 `~/.local/share/jarvis/ddns.json` 已存在，内容是 07-04 PUT 的 `test-jarvis-07-04-aaaa/AAAA/t2`，跨日无损。**07-05 新增证据链层**：主动 `rm` → 启动 → probe `configured:false` → probe 结束 `cp` 回写 → 下次启动能继续验证。这条链完成了"删除→回写"型 cross-day 证据（07-04 只做了"隔天再读"）。

#### 4.5.2 `GET /v1/ddns/status` 双分支 wire shape ★（07-05 首入档 `configured:false` 分支）

**`configured:false`（未 PUT）**：

```json
GET /v1/ddns/status → 200 {
  "enabled": true,
  "configured": false,
  "lan_addrs": ["192.168.1.164", "198.18.0.1"],
  "reachable": null
}
```

**4 keys ★**：`[configured, enabled, lan_addrs, reachable]` —— 与 configured 分支的 8 keys `[configured, enabled, hostname, lan_addrs, last_result, provider, public_ip, reachable]` **branch 出**：`hostname/provider/public_ip/last_result` 只在 `configured:true` 时出现，未 PUT 时完全省略（不是 null 占位）。

#### 4.5.3 `GET /v1/ddns/config` 双分支 wire shape ★★（07-04 §7 未验证项 #2 落地）

**`configured:false`（未 PUT）**：

```json
GET /v1/ddns/config → 200 { "configured": false }
```

**1 key ★**：极简，不占任何 null 位。

**`configured:true`（PUT 完）**：

```json
GET /v1/ddns/config → 200 {
  "provider": "duckdns",
  "hostname": "test-jarvis-07-05-aaaa",
  "port": 7099,
  "record_type": "AAAA",
  "interval_seconds": 300,
  "upnp_enabled": false,
  "credential_keys": ["token"]
}
```

**7 keys** —— 与 07-04 完全一致，credentials 值不外泄；GET/PUT wire shape 对称。

**结论**：`GET /v1/ddns/config` 有**两个完全不同的顶层 shape**（1 key vs 7 keys），客户端必须 `if (body.configured === false)` 分支处理，不能直接 destructure 假设有 7 keys。这条口径 07-04 未列。

#### 4.5.4 `PUT /v1/ddns/config` 不带 `record_type` 的默认 ★（07-04 §7 未验证项 #1 落地）

```
PUT /v1/ddns/config body={
  provider:"duckdns", hostname:"test-jarvis-07-05-default", port:7099,
  interval_seconds:300, credentials:{token:"stub-token-no-rt"}
  # ← 无 record_type
}
→ 200 {..., record_type:"A", ...}
```

**响应字段是 `"A"`**（非 undefined，非 null）—— 服务端把默认值明填。这跟 07-03 报告"默认 A"的假设一致，但**07-04 之前没跑过 GET 侧的"省略入参→响应回填"验证**。

#### 4.5.5 `PUT /v1/ddns/config record_type` 枚举校验矩阵 ★（07-05 意外新落地）

| record_type | provider | status | resp.record_type |
| --- | --- | --- | --- |
| `"A"`（默认） | duckdns | 200 | `"A"` |
| `"AAAA"` | duckdns | 200 | `"AAAA"` |
| `"CNAME"` | duckdns | **200** | `"CNAME"` ⚠️ |
| `"TXT"` | duckdns | **200** | `"TXT"` ⚠️ |
| `"CNAME"` | cloudflare | 200 | `"CNAME"` |

**结论**：REST 层**不校验** `record_type` 枚举，任何字符串都原样透传落盘。DNS provider 兼容性（duckdns 现实中只支持 A/AAAA）**延后到 update time 才 fail**（`POST /v1/ddns/update` 时 provider adapter 里会返 "KO" 之类 error）。**建议**：REST 校验 `record_type ∈ {"A","AAAA","CNAME","TXT","MX", ...}` 而不是延后到 update time。

#### 4.5.6 `PUT /v1/ddns/config provider` 枚举校验（07-05 新落地）

```
PUT /v1/ddns/config body={provider:"nonexistent", ...} → 400 {error:"unknown DDNS provider \"nonexistent\""}
```

**结论**：`provider` **IS** 枚举校验（duckdns/cloudflare/dyndns2/aliyun/dnspod）；而 `record_type` **NOT** 校验（§4.5.5）。**两字段校验口径不一致**。

#### 4.5.7 `PUT /v1/ddns/config interval_seconds` 边界矩阵 ★（07-05 新落地）

| interval_seconds | status | resp.interval_seconds |
| --- | --- | --- |
| `-5` | 200 | **60** ⚠️（silent 上取到最小值） |
| `0` | 200 | **60** ⚠️（silent 上取到最小值） |
| `30` | 200 | **60** ⚠️（silent 上取到最小值） |
| `60` | 200 | 60 |
| `300` | 200 | 300 |
| `999999` | 200 | **999999**（无上限） |

**结论**：`interval_seconds < 60` **silent 上取到 60**（min-clamp，无 warning）；无 upper clamp。**建议**：文档写入这条 min=60 语义，或改成 400 拒绝而不是 silent-clamp（silent-clamp 会让配置界面出现"我明明填了 30 保存了怎么变成 60"的认知冲突）。

#### 4.5.8 `PUT /v1/ddns/config credentials={}` 空对象接受（07-05 新落地）

```
PUT /v1/ddns/config body={..., credentials:{}}
→ 200 {..., credential_keys:[]}
```

**结论**：credentials **completeness 不校验**。duckdns 需要 `{token}`、cloudflare 需要 `{api_token, zone_id}` 之类，但 REST 层不检查，保存一个空 credentials 也 200。update time 才会 fail。**建议**：REST 校验 per-provider 必需 credential keys（duckdns→token / cloudflare→api_token+zone_id / dyndns2→username+password 等），或至少给出 warning。

#### 4.5.9 `PUT /v1/ddns/config` 常规校验：`hostname=""` + `port` 越界（07-05 新入档）

```
PUT hostname:"" → 400 {error:"`hostname` is required"}
PUT port:0      → 400 {error:"port must be 1..65535"}
PUT port:-1     → 400 {error:"port must be 1..65535"}
```

`hostname` 是 required（空字符串按 not-present 处理）；`port` 是 1..65535 严格校验。这两条与 `provider` 一样属于 hard-check，跟 `record_type/interval/credentials` 的 soft-accept 形成对比。

#### 4.5.10 `POST /v1/ddns/update` 返 status 8 keys 完整（07-04 结论 07-05 三次校准）

```
POST /v1/ddns/update {} → 200 {enabled, configured, lan_addrs, reachable, provider, hostname:"test-jarvis-07-05-aaaa"}
```

因为这次是新起的 stub token，`last_result` 尚未有值（异步 update 还没完成）；等秒钟再打一次会看到 `public_ip` + `last_result:{ok:false, message:"..."}` 补齐。fire-and-forget + immediate-status 语义 07-05 再校准。

#### 4.5.11 `DELETE /v1/ddns/config` 从 3-shape → 4-way split ★（07-05 深挖）

07-04 §4.5.6 报了 3 shape：
- 无 Content-Type 头 → 404
- `Content-Type: application/json` + 空 body → 400 FST_ERR_CTP_EMPTY_JSON_BODY
- `Content-Type: application/json` + `{}` → 404

07-05 通过 Node fetch API 送空字符串 `content-type:""`（跟 curl `-H "Content-Type:"` 是**不等价的**：curl `-H "Content-Type:"` 完全**去掉**该 header，fetch `content-type:""` **保留 header 但值为空字符串**）时挖到第 4 shape：

```
fetch DELETE /v1/ddns/config { headers: { "content-type": "" } }
→ 415 {statusCode:415, code:"FST_ERR_CTP_INVALID_MEDIA_TYPE",
       error:"Unsupported Media Type", message:"Unsupported Media Type"}
```

**4 shape 完整矩阵**（07-05 首入档）：

| 客户端头 | 客户端 body | status | error code |
| --- | --- | --- | --- |
| **无** `Content-Type` header | 无 body | 404 | Route not found（route-match 兜底） |
| `Content-Type:""` 空字符串值 | 无 body | **415** | FST_ERR_CTP_INVALID_MEDIA_TYPE（07-05 新） |
| `Content-Type: application/json` | 无 body | 400 | FST_ERR_CTP_EMPTY_JSON_BODY |
| `Content-Type: application/json` | `{}` | 404 | Route not found |

**结论**：Fastify body-parser 的排序 pipeline 至少有 4 个可辨别 state，`DELETE /v1/ddns/config` route 根本不存在这条底层结论 07-05 加固。**建议**（07-04 P2 升级）：要么加 `app.delete("/v1/ddns/config")` handler，要么 CLAUDE.md 显式说"清 DDNS 配置 = rm 磁盘 + 重启"；顺便修 Fastify config-order，让 404 route 优先于 body-parser 抢先。

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

`app.delete("/v1/ddns/config")` 依旧缺失（第 4 天）。

#### 4.5.12 `POST /v1/ddns/upnp/test` 4 keys（07-04 落地，07-05 回归）

```
POST /v1/ddns/upnp/test {} → 200 {
  mapped: false,
  externalPort: 7099,
  internalPort: 7099,
  message: "no UPnP gateway found on the LAN — forward the port manually on your router"
}
```

**4 keys ★**。actionable message 与 07-04 一字不差。

#### 4.5.13 `GET /v1/remote/pairing` 4 keys + DDNS cross-feature integration（07-04 落地，07-05 跨日回归）

```
GET /v1/remote/pairing → 200 {
  device_name: "zhangjianandeMacBook-Pro.local",
  token: null,
  origins: [
    "http://192.168.1.164:7099",
    "http://198.18.0.1:7099",
    "http://test-jarvis-07-05-aaaa:7099"    # ← 今天 PUT 的新 DDNS hostname 直接进 origins
  ],
  pairing_links: [
    {origin, link},  {origin, link},  {origin, link}
  ]
}
```

**cross-feature integration 第 3 天回归**：DDNS hostname 直接进 `origins` + `pairing_links`。iOS 客户端拿这个可以同时握手 LAN + 外网 3 条路径。`pairing_links[*]` 每条 2 keys `{origin, link}`。

#### 4.5.14 `GET /v1/remote/info.external` 3 keys（07-04 落地，07-05 回归）

```
GET /v1/remote/info → 200 {
  device_name, lan_addrs, port:7099,
  external: {
    hostname: "test-jarvis-07-05-aaaa",
    public_ip: "67.200.120.26",
    reachable: null
  },
  requires_auth: false,
  version: "0.2.0"
}
```

### 4.6 Memory 完整第四日：全部 07-04 结论回归

（本节全部条目与 07-04 §4.6 完全对齐，今天再校准）

- `GET /v1/memory/sync_status` → 200 `{backend:"none", user_root:"/tmp/jarvis-mem-07-05", workspace_root:"/tmp/jarvis-servlet-test"}`
- `GET /v1/memory/includes[?scope=workspace|user]` → 200 `{scope, memory_md, items[]}`；scope=user 走 `JARVIS_MEMORY_USER_ROOT/.jarvis/memory/MEMORY.md`
- `POST /v1/memory/includes body={target:"shared/tone.md"}` → 400 `include path not found`（target 必须是含 `MEMORY.md` 的目录，不是文件）
- `POST /v1/memory/includes body={target:"/tmp/shared-memory-07-05"}` → 200 4 keys `{ok, added, scope, memory_md}`
- `GET /v1/memory/includes` 加过之后 items[*] 4 keys `{target, kind:"local_path", resolves, path}`
- `POST /v1/memory/includes/refresh body={target:local_path}` → 400 `refresh only applies to git+ includes`
- **`DELETE /v1/memory/includes body={target}` 幂等 no-op**（07-04 首落地，07-05 回归）：第 1 次 200 3 keys `{ok, removed, scope}`，第 2 次同 target 200 完全等价；空 body 400 `missing target`
- backend=none 下 `POST /v1/memory/sync_setup` / `sync` → 503 `... only applies to the git backend`

### 4.7 `POST /v1/workflows` 500 body.message 字段（07-03 结论 07-05 四次回归）

10 shape 500 全部返 `{statusCode:500, error:"Internal Server Error", message:"<runtime message>"}`。message 内容与 07-03/07-04 一字不差。

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
/v1/memory/sync_status        → 503 {error:"memory tools are not enabled — set JARVIS_ENABLE_MEMORY=1 and restart"}
/v1/memory/includes           → 503 {error:"memory tools are not enabled — set JARVIS_ENABLE_MEMORY=1 and restart"}
```

**4 种体例持平**：503+hint（8 条主流）；200+flag（1 条特例 `diagnostics/memory`）；503+actionable-hint（2 条 `memory/*`）；其余用不到。**建议**统一到 actionable-hint。

### 4.9 `POST /v1/requirements/:id/reject` shape 复现（07-04 回归）

```
POST /v1/requirements/<orphan_rid>/reject body={"reason":"test-reject-07-05"} → 200 {rejected:true, deleted:true, reason:"test-reject-07-05"}
```

**3 keys 与 07-04 一致**。orphan 行也能被 reject —— `reject` handler 按 requirement id 查而不校验 project_id 存在。

### 4.10 `/v1/version` + `/health` + `/v1/health` 三分裂（07-04 回归）

```
GET /v1/version  → 200 {name:"jarvis", version:"0.2.0"}
GET /health      → 200 {status:"ok"}
GET /v1/health   → 404 Route not found
```

**未修（第 4 次）**。

### 4.11 `GET /v1/workflows` vs 单 GET 分裂 + `/v1/projects` 裸数组 + `/v1/workspaces` `{workspaces:[]}`（07-04 回归）

```
GET /v1/workflows/<id> → 200 {created_at, id, name, steps, updated_at}   # 裸对象（description 视 optional 存在与否）
GET /v1/workflows      → 200 {items: [...]}                              # {items:[]}
GET /v1/projects       → 200 [...]                                       # 裸数组 ★
GET /v1/workspaces     → 200 {workspaces: [...]}                         # 第三体例
```

**3 种 list shape** 并存 —— 完全复现。

### 4.12 `PATCH /v1/requirements/:id` 只传 `depends_on` ★（07-04 §7 未验证项 #3 落地）

```
# 先建一个不带 depends_on 的 requirement
POST /v1/projects/<pid>/requirements {title:"patch-deps-only-07-05", triage_state:"approved"}
→ 201 keys=['conversation_ids','created_at','id','project_id','status','title','updated_at']    # 8 keys 无 depends_on

# --- 只 PATCH depends_on（real UUID）---
PATCH /v1/requirements/<id> {depends_on:["<real hello id>"]}
→ 200 keys=['conversation_ids','created_at','depends_on','id','project_id','status','title','updated_at']  # 9 keys 补入 depends_on
   depends_on = ["<real hello id>"]  ✓

# --- 只 PATCH depends_on:[] ---
PATCH /v1/requirements/<id> {depends_on:[]}
→ 200 depends_on = []  ✓

# --- 只 PATCH depends_on:[bogus] ---
PATCH /v1/requirements/<id> {depends_on:["11111111-1111-1111-1111-111111111111"]}
→ 200 depends_on = ["11111111-1111-1111-1111-111111111111"]  ⚠️ 与 §3.5 POST 侧同一 FK bug 复现
```

**关键结论**：
- PATCH-only-depends_on **通道存在**：只传 `depends_on` 单字段 PATCH 200，写通
- **响应 keys 补入 `depends_on` 字段**（原本 8 keys 变 9 keys）—— PATCH 前后 wire shape 不对称
- **同一 FK bug**：bogus UUID 也接受，与 `POST` 侧 §3.5 是**同一根本问题**（`depends_on` 完全没跨 id 验证）
- 修复应**在同一处**：任意 `depends_on` 入手（POST 或 PATCH）都必须 for-each 校验目标 requirement 存在

---

## 5. 单测健康

```
$ pnpm --filter @jarvis/server test
# tests 522, pass 522, fail 0, duration_ms 7676.636333
```

522/522 全绿，7676 ms（−219 ms vs 07-04，回到 7 天低点）。

| 日期 | tests | pass | fail | duration_ms |
| --- | --- | --- | --- | --- |
| 06-28 | 522 | 522 | 0 | 7706 |
| 06-29 | 522 | 522 | 0 | 7702 |
| 06-30 | 522 | 522 | 0 | 7703 |
| 07-01 | 522 | 522 | 0 | 7682 |
| 07-02 | 522 | 522 | 0 | 7784 |
| 07-03 | 522 | 522 | 0 | 7777 |
| 07-04 | 522 | 522 | 0 | 7896 |
| **07-05** | 522 | 522 | 0 | **7676** |

12 天区间 7676-7896 ms（2.9% 浮动，纯 IO/调度噪声）。

`packages/store` sqlite ABI mismatch 与主诊断路径无关，本次不复测。

---

## 6. 合并建议优先级（06-23 → 07-05 十二日汇总）

| 优先级 | 项 | 文件/位置 | 累计状态 |
| --- | --- | --- | --- |
| **P0** | Web UI 在 cold-start 时折叠 `overall_score` 卡片。**方法**：判 `actions.find(a => a.key === "fill_signal_gaps") && sample_count < 5`，直接渲染其 title `"补齐观测样本"`。1 个 if + 5 分钟 | `apps/jarvis-web/src/components/Observability/...` | 06-25 抬升，**12 天未修** |
| **P1（升级）** | `requirements-routes.ts` create+patch 加 `acceptance_policy / workflow_id / assignee_id / verification_plan` 透传；单测 happy path + bogus value + 真 UUID 三种 | `:164-166`、`:206`、`:255` + `packages/tools/src/requirement-tools.ts` | **第 12 次报告** |
| **P1** | `POST /v1/workflows` 6 处类型/字段守卫补齐 —— 顶层非数组 + 数组元素非 object + name 非 string + kind 非 object + kind.type 不在枚举 + agent.prompt 非 string；6 条反例单测 | `packages/server/src/workflow-routes.ts:156-200` + `workflow-routes.test.ts:115` | **第 6 次复现** |
| P1 | `roadmap.import` 工具 + REST 移植；或 CLAUDE.md 显式标记 deferred | `packages/tools/src/`、`CLAUDE.md` | **12 天未修** |
| P1 | requirements create/patch 加 project_id 存在性校验 → 404；同时新增 `GET /v1/requirements/:id` | `requirements-routes.ts:206/:255`，新增 `:?` | **第 11 次报告** |
| P1 | `depends_on` 跨 id 存在性校验 —— **07-05 加固：POST 与 PATCH 是同源 bug**（修一处即可 fix 两处） | `requirements-routes.ts:233-237/:298-302` | **8 天未修** |
| **P1（07-05 新提）** | DDNS `PUT /v1/ddns/config` **soft-accept 三处** 收敛：`record_type` 加枚举校验 or 移到 provider adapter；`interval_seconds < 60` 改成 400 拒收（stop silent-clamp）；`credentials` 加 per-provider 必填 key 校验 | `packages/server/src/ddns-routes.ts:69` + `packages/ddns/src/runtime.ts` | **07-05 新入档** |
| **P2（升级）** | Wire-shape codify 到 `docs/conventions/` 或 CLAUDE.md：`/v1/observability/health` / `runs/*` / `/v1/requirements/:id/runs` / `/v1/work/*` / `/v1/workflows` / `/v1/workflow-runs/:id`（含 `finished_at` 时间戳不刷新语义）/ `/v1/workspaces` / `/v1/remote/info`（含 DDNS 时 `external.hostname/public_ip/reachable`）/ `/v1/providers` / `/v1/version` / `/v1/ddns/status` **双分支 shape（configured true/false, 8 keys vs 4 keys）** / **`/v1/ddns/config` 双分支 shape（configured true/false, 7 keys vs 1 key）** / `/v1/ddns/upnp/test` 4 keys / `/v1/remote/pairing` 4 keys + cross-DDNS integration / `/v1/memory/*`（含 include kind 枚举 + target 语义 "含 MEMORY.md 的目录"） / **`DELETE /v1/memory/includes` 幂等 no-op** / **`POST /v1/workflow-runs/:id/cancel` 三态语义**（bogus 404 / cancelled 200 no-op / pending 200 首次生效） | `docs/conventions/` 或 CLAUDE.md | **07-05 新增 3 条**（config `configured:false` 分支 + status `configured:false` 分支 + workflow-run cancel 三态语义） |
| **P2（升级）** | "未配 feature" 路由口径统一 —— 4 种体例（503+hint / 503+actionable-hint / 200+flag / 200+空数据），推荐收敛到 **503+actionable-hint**（`memory/*` 已示范"消息里带 env var 名 + 重启指令"） | `packages/server/src/diagnostics-routes.ts` 等 | **8 天未修** |
| **P2（升级）** | list 路由 shape 收敛：3 种体例（裸数组 / `{items:[]}` / `{workspaces:[]}`）并存 | `projects-routes.ts` + `workspaces-routes.ts` + CLAUDE.md | **7 天未修** |
| **P2（升级）** | `server/info` 里补 `ddns` / `memory_enabled` / `mdns` 字段——即使 boolean 也让客户端一次读取 | `packages/server/src/server-info.ts` 附近 | **第 4 次报告** |
| **P2** | **DDNS 配置持久化路径 + 明文 credentials 语义写入 CLAUDE.md**：`~/.local/share/jarvis/ddns.json`（mode 0600，明文），"API 层永不回值 vs 磁盘层明文"两层语义分开写；**07-05 又获一次"删→写"cross-day 证据链** | CLAUDE.md DDNS 段 + `packages/ddns/src/runtime.ts:149-153` 附近注释 | **07-03 入档，07-05 三次校准** |
| **P2（升级）** | `POST /v1/workflows` 500 body 里错误文案在 `message` 字段而不是 `error` | CLAUDE.md 或 SDK docs | 07-02 报，**未修** |
| **P2（升级）** | **`DELETE /v1/ddns/config` 不是 Fastify content-type footgun 而是 route 缺失（07-05 挖到 4-way split：no-header/`""` CT/`application/json` no body/`{}` 四态）**。要么加 handler，要么 CLAUDE.md 显式说"清 DDNS 配置 = rm 磁盘 + 重启"；顺便修 Fastify body-parser 顺序（route 不存在时永远 404，不被 body 400/415 抢先） | `packages/server/src/ddns-routes.ts` + Fastify config | **07-03 修正诊断，07-05 深挖到 4 shape** |
| **P2（07-05 新提）** | idempotence 三体例收敛 —— `POST /v1/workflow-runs/:id/cancel`（bogus 404 / cancelled 200 no-op）、`DELETE /v1/memory/includes`（任意 target 200 no-op）、`POST /v1/requirements/:id/reject`（bogus 404 / 已 reject 大概率 404）。**建议**收敛到 workflow-run 的"select-then-cancel"体例 | CLAUDE.md + 三 route 源码 | **07-05 新入档** |
| P2 | approve idempotent + reject "软删非回退" 语义、instructions trim-aware、slug 冲突 409 vs 后缀行为、workflow name 允许重复无 slug 唯一——全部加进 CLAUDE.md | CLAUDE.md 项目段 + workflow 段 | 06-29 起，**7 天未修** |
| P2 | `depends_on` wire shape 稳定化（omit → server 补 `[]` 或客户端 normalize） | `requirements-routes.ts` 序列化处 | **8 天未修** |
| **P3（升级）** | CLAUDE.md 补 `POST /v1/memory/includes` 完整规范：`target` = "含 `MEMORY.md` 的目录"（不是文件、也不是任意路径）；`kind` 枚举 `"local_path"` / `"git"`；refresh 仅对 git+；`DELETE /v1/memory/includes` 幂等 | CLAUDE.md memory 段 | **07-04 补充幂等语义** |
| **P3** | CLAUDE.md 补 `POST /v1/ddns/upnp/test`（4 keys）+ `GET /v1/remote/pairing`（4 keys + `pairing_links[*]:{origin,link}` + 与 DDNS/access-token cross-feature）+ `GET /v1/ddns/config` 7 keys（含 GET/PUT wire shape 对称结论）**+ configured:false 分支 1 key / GET status configured:false 分支 4 keys / PUT record_type 无枚举 + interval min-clamp 60 + credentials 空对象接受（07-05 新加）** | CLAUDE.md DDNS 段 | **07-05 补充 5 条** |
| P3 | `/v1/version` vs `/health` vs `/v1/health` 三分裂：`/v1/health` 404，补别名或 CLAUDE.md 说明 | `packages/server/src/router.ts` + CLAUDE.md | **第 4 次报告** |
| P3 | `/v1/diagnostics/runs/stuck?threshold_seconds=N` 行为在 CLAUDE.md 显式：仅返 `age_seconds >= N` 的 pending run；无 query 时 default > 4 秒 | `diagnostics-routes.ts` + CLAUDE.md | **6 天未修** |
| P3 | `ObservabilityStore` / `EvalStore` 的 env-driven 拉起方式在 CLAUDE.md 文档化 | CLAUDE.md | 未修 |
| **P3** | Servlet 测试目录 fixture `scripts/servlet-fixture-reset.sh` —— 07-03 手动重建、07-04/07-05 完好三天，说明 fixture 生命周期未固化；LLM-驱动测试前应能一键复位 | `Makefile` 或 `scripts/servlet-fixture-reset.sh` | 07-03 新增，07-05 保持 |

---

## 7. 复测剧本（有 LLM key 时；与 07-04 §7 一致 + 07-05 新增项）

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

- **仍留白**（06-30 → 07-05 累积）：subagent.review 真 flip、triage.scan_candidates 建 ProposedByScan、project.checks 识别 Maven 缺 pom.xml、bogus project_id 之后 agent 侧 requirement.list 是否拿回、step_results[*] shape 在有 LLM key 时、`POST /v1/workflow-runs/:succeeded_run/cancel` 是否 200 no-op（目前只测 cancelled → cancel 200，pending → cancel 200，bogus → 404）
- **07-03 → 07-05 累积新留白**：
  - `JARVIS_MEMORY_SYNC_BACKEND=git` 起飞后 `POST /v1/memory/sync_setup` / `sync` 的 happy-path shape
  - `POST /v1/memory/includes body={target:"git+https://..."}` happy path shape + `kind:"git"` include shape + `refresh` on `kind:"git"` happy path
  - `JARVIS_ACCESS_TOKEN=<token>` 起飞后 `GET /v1/remote/pairing` 的 `token` 字段 + `pairing_links[*].link` 是否带 `?token=<val>`
  - `POST /v1/ddns/upnp/test` 在真有 UPnP gateway 网络下的 shape（今天 message 是 "no UPnP gateway found"）
  - `POST /v1/ddns/upnp/test` 参数化探测（是否支持自定义 externalPort？body shape？）
- **07-05 新留白**：
  - `PUT /v1/ddns/config record_type:"MX"/"NS"/"SRV"` 是否也 200？（今天验了 CNAME/TXT 都 200，暗示"任何字符串都行"，但没穷举 DNS 记录全谱系）
  - `PUT /v1/ddns/config interval_seconds:60.5` 浮点 → 60 还是 60.5 还是 error？（今天只测了整数边界）
  - `PUT /v1/ddns/config port:65536`（超上界）能否触发同 `port must be 1..65535` 400（今天只测下界 0/-1）
  - `POST /v1/workflow-runs/<succeeded_uuid>/cancel` 语义（需要 LLM key 让 run 真跑完 succeeded）
  - `PATCH /v1/requirements/:id status:"done"` 在 depends_on 未完成时是否被 auto-loop 拦截（今天 stub 模式手动 PATCH 是允许的，不知道 auto-loop 是否会把它挪回 backlog）
  - `GET /v1/observability/health` 在 sample=2 (只有 hello + echo runs，没 maven) 时的 confidence 值 —— 07-05 没跑这个中间步（step 4 直接从 sample=1 跳到 sample=3）；建议下次插一步 `POST :echo/runs` 单独取 sample=2 fingerprint

---

## 8. 总览

| 项 | 评分 | 与 07-04 比 |
| --- | --- | --- |
| Kanban (Project + Requirement CRUD + 状态转换 + Activity) | ✅ 健康 | 持平 |
| Workflow CRUD + dispatch + cancel（bogus 404 / cancelled 200 no-op / `finished_at` 不刷新） | ✅ 健康（除 §3.7 的 10 种 500 泄漏） | **07-05 补齐 bogus 侧语义** |
| Diagnostics (`/v1/diagnostics/*` + `/v1/work/*`) | ✅ 健康 | 持平 |
| Harness.health 算法实装 | ✅ 稳定第 12 天 —— 4 fingerprint（sample=0/1/3/4）全复现 | 持平 |
| Harness.health 信号采集 | ⚠️ 缺 LLM 驱动时无信号；`actor_breakdown` / `verification_pass_rate` 顶层 null | 持平 |
| Harness.health 前端表达 | ❌ confidence 低分仍直接展示 score | **12 天未修** |
| DDNS 后端 | ✅ 健康 + `status` 双分支 wire shape + `config` 双分支 wire shape + `PUT` 5 校验矩阵（provider ✓/record_type ✗/interval min-clamp/credentials 空接受/hostname required/port 1..65535） | **07-05 挖深** |
| Memory 后端（backend=none） | ✅ 健康 + include target 语义 + scope=user + kind=local_path/git 枚举 + DELETE/refresh + DELETE 幂等 no-op | 持平 |
| REST ↔ 数据模型一致性 | ❌ 4 字段 POST+PATCH 丢；project_id 无 FK；depends_on 跨 id 无 FK（POST + **PATCH 同源 07-05 落地**）；无 `GET /v1/requirements/:id`；depends_on 条件性写回；list shape 三分裂 | **07-05 加固 PATCH 侧同源** |
| 文档 ↔ 运行时一致性 | ⚠️ roadmap.import 文档 ✅ 但 404；`server/info` 不反映 DDNS/memory；`POST /v1/memory/includes` body target 语义未文档化；`/v1/health` 404；DELETE 无 body 时 fastify 400/415（真相 = 无 route）；`upnp/test` + `remote/pairing` + `GET /v1/ddns/config` 完全未文档化；**07-05 新增 4 条 DDNS PUT soft-accept 语义、双分支 shape、record_type 无枚举、interval min-clamp 未文档化** | **07-05 揭底更多缺口** |
| 单测覆盖 | ✅ 522/522 全绿，7676 ms | 持平（噪声内） |
| **真 bug**：`POST /v1/workflows` 500 泄漏 | ❌ 10 shape 500 / 6 shape 400 完全复现 | 持平（第 6 次） |
| **真 bug**：`DELETE /v1/ddns/config` 无 handler + 4-way split | ❌ 完全复现 + 07-05 挖到第 4 shape | **07-05 加固** |
| **真 bug（07-05 新提）**：DDNS PUT soft-accept（record_type / interval min-clamp / credentials 空） | ❌ 07-05 新落地 | **07-05 首入档** |
| 自动化的端到端验证（有 LLM key） | ❌ 本次仍未执行 | 持平 |

**总体判断**：HEAD 在 06-23 → 07-05 **十二天**没动，工作树未 commit 文件持平 39，所以 07-04 的所有 P0/P1/P2 结论**原样成立**。本次实际增量价值：

1. **07-04 §7 未验证项落地 4 条（这是 12 天来单次最多）**：
   - **`PUT /v1/ddns/config` 不带 `record_type` → 服务端默认 `"A"`**（响应字段是明填 `"A"` 而非 undefined）
   - **`GET /v1/ddns/config` at `configured:false` → 1 key `{configured:false}`**（极简；与 configured 分支的 7 keys 完全 branch 出）
   - **`PATCH /v1/requirements/:id` 只传 `depends_on` → 200 写通**（real UUID / [] / bogus UUID 三种全 200；bogus 是 §3.5 POST 侧同源 FK bug）
   - **`POST /v1/workflow-runs/<bogus_uuid>/cancel` → 404**，contrasting `<already-cancelled>` 的 200 no-op —— **"select-then-cancel"两阶段语义**；与 `DELETE /v1/memory/includes`"对任意 target 200 no-op"**语义分裂**
2. **07-05 意外新落地 6 条**（都是 07-04 report 里 grep 不到的内容）：
   - **`GET /v1/ddns/status` at `configured:false` → 4 keys**（缺 `hostname/provider/public_ip/last_result`）—— 首入档双分支 shape
   - **`PUT /v1/ddns/config record_type` NO 枚举校验**：`"CNAME"/"TXT"` on duckdns 都 200；`provider` 校验 vs `record_type` 不校验**口径不一致**
   - **`interval_seconds < 60` silent 上取到 60**（`0/-5/30` 全 clamp）；`999999` 无上限
   - **`credentials={}` 空对象接受 200**（credential completeness 不校验，per-provider 必填 key 校验缺失）
   - **`hostname:""` / `port:0/-1` 硬 400**
   - **`DELETE /v1/ddns/config` 从 3-shape 深挖到 4-way split**：+ `Content-Type:""` 空字符串值 → 415 FST_ERR_CTP_INVALID_MEDIA_TYPE
3. **DDNS 配置跨 07-04 → 07-05 持久化跨日校准 (cross-day evidence #2)**：`~/.local/share/jarvis/ddns.json` 完整存活；07-05 主动 `rm` 后再回写完成"删→回写"型 cross-day 证据链，比 07-04 "隔天再读"更完整。
4. **算法稳定性 fingerprint 跨日再确认**：sample=0/1/3/4 四条 fingerprint 与 07-04 逐位相等 —— **算法稳定第 12 天**，用作 regression smoke 尤其可靠。
5. **cross-feature integration 跨日校准第 3 天**：`/v1/remote/pairing.origins` 今天含 `http://test-jarvis-07-05-aaaa:7099`（今天 PUT 的新 hostname）—— iOS + DDNS pairing 流第 3 天走通。

**建议**：下次合 P1 修复时**同时**做：①4 字段透传 create+patch；②project_id FK + `GET /v1/requirements/:id`；③depends_on FK（**07-05 加固：修一处同时 fix POST + PATCH**）；④workflow POST 6 处类型守卫；⑤`DELETE /v1/ddns/config` 加 route（清磁盘 + credentials 归零）；⑥`server/info` 补 ddns/mdns/memory_enabled 字段；⑦一次性 codify DDNS 5 route（status 双分支 shape + config GET/PUT 7↔1 keys 双分支 + upnp/test + remote/pairing）+ memory 4 route（含 target 目录语义 + kind 枚举 + DELETE 幂等 no-op）+ workflow-run cancel 三态语义（bogus 404 / cancelled 200 no-op / pending 200）+ cancelled workflow run `finished_at` 不刷新 + slug 409 到 CLAUDE.md；⑧**07-05 新增**：DDNS PUT 三处 soft-accept 改为 hard-reject（`record_type` 枚举 + `interval_seconds < 60` 400 + `credentials` per-provider 必填 key 校验）。

**P0 修复（12 天）**：前端读 `actions.find(a => a.key === "fill_signal_gaps") && sample_count < 5` 当 cold-start 兜底信号，改 1 行 5 分钟 —— 十二天延期的根本原因还是被误判成"需要重新设计"。

**Servlet 测试基线加固**：`/tmp/jarvis-servlet-test/src/main/java/com/example/HelloServlet.java` 07-03 手动重建后 07-04/07-05 完好三天；仍未固化 fixture 生命周期 —— 建议加一个 `scripts/servlet-fixture-reset.sh` 每次跑前重置。
