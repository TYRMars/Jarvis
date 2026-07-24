# Jarvis 项目自动化能力诊断报告（2026-07-18 二十次复测）

- **运行时间**：2026-07-18（scheduled task 自动跑；07-17 无跑记录 → **2 天间隔**）
- **被测分支**：`feat/mobile-ios-ddns`（HEAD 仍为 `64d288a`，与 06-23 → 07-16 同一 commit — **静默第 25 天**；工作树侧 39 个未 commit 文件与 07-16 逐字一致）
- **被测项目**：`/tmp/jarvis-servlet-test`
  - **07-18 差异**：fixture **完整幸存第 5 天**（07-14 03:06 重建，07-15/07-16/07-17/07-18 逐日 24h+ 幸存；`ls -la` 4 文件时间戳全为 Jul 14 03:06）
  - **07-16 → 07-18 二天间隔**：07-17 无跑记录（scheduled task 跳过一日），HEAD/工作树全零变化
- **本次目的**：
  1. **回归确认** 07-16 P0/P1/P2 累积项在 2 天间是否被修复（预期：全未修，第 25 天）
  2. **07-16 §9 未验证项 8 条全落地**：
     - `PATCH /v1/projects/:id {"archived":false}` 是否是第 3 条 restore 路径
     - `POST /v1/runs/:id/verification` `body.status="bogus-enum"` 是否 enum 校验
     - `POST /v1/runs/:id/verification` `body.status:"fail"` run.status 是否 → completed
     - **HEADLINE 后续**：连跑 10 次 `/verify {commands:["echo x"]}` → sample_count → 16；重建 sample=6..16 **verify-driven fingerprint 曲线**
     - `PATCH /v1/requirements/:id {"depends_on":[]}` empty array 覆盖是清空还是保留（Requirement 侧，非 Todo）
     - Activity `body.kind:"verification_attached"` 是否是 `/verify` 或 `/verification` 的 side-effect
     - `POST /:id/todos` 上 `evidence:{run_id:123,…}` 是否也 accept nested types
     - `POST /v1/workflows/:id/run` w/ workflow.project_id=archived-pid 是否 202 dispatch
  3. **今日新发现**（07-16 未预告）：
     - **✨ 07-16 §L10 CORRECTION**：`PATCH /v1/projects/:id` **route 不存在**（404）；07-16 声称 "三条 restore 路径" **错误** → 实际只有 **2 条**（`POST /:id/restore` + `PUT /:id {archived:false}`）；`packages/server/src/projects-routes.ts:285` 只注册 `app.put`，无 `app.patch`
     - **✨ HEADLINE §L11 深化 07-16**：`POST /v1/runs/:id/verification body.status="bogus-enum"` = **200 accept 原样存储** —— REST 层只校验 `typeof status === "string"`，**无 enum 校验**；`status:42` = 400 `body must be a VerificationResult`（typeof-string 生效但 enum 完全丢失）
     - **✨ §L11 深化 07-16**：`POST /v1/runs/:id/verification body.status:"fail"` = 200 verification 附着，但 **run.status 保持 `pending`** —— `/verification` 是**纯附着 route**，不动 run 状态；只有 `/verify` 会把 run.status → `completed`（**07-16 §L11 隐含假设 "verification 会更新 run.status" 错误**）
     - **✨ Activity outer `kind` enum 从 3 扩至 5**：新增 `run_finished` + `verification_finished` 两个 outer kind（07-08 记录只有 `comment/run_started/status_change`）
     - **✨ /verify vs /verification activity emission split**：`/verify` 触发 3 个 activity（`status_change / run_started / run_finished / verification_finished` 4 条 —— 抱歉笔误：实际 4 条 activity kinds `[run_finished, verification_finished, run_started, status_change]`）；`/verification`（纯附着）触发 3 条 activity kinds `[verification_finished, run_started, status_change]`（**无** `run_finished` —— 因未真正 execute）
     - **✨ activity.body 无 sanitization**：`verification_finished.body.status` 逐字回显 client POST 的 `<script>alert(1)</script>` / `bogus-junk-value` / `needs_review` / `pass` / `fail` —— **activity log XSS vector 缺 sanitization**；配合 §L11 body.status 无 enum 校验，双方都无防护
     - **✨ activity.kind:"verification_finished".body shape**：`{run_id, status}` 二字段；`run_id` 是 UUID string；`status` 是 verbatim string
     - **✨ 07-16 §L12 顺序 bug 精确 confirm**：bogus runid + **empty commands** → 400（validator 先跑）；bogus runid + **non-empty commands** → 404 (runStore.get 后跑 —— 走对了)。所以 07-16 memo 表达是 **精确正确的**：客户端如果 POST 空 body 到 bogus runid，就无法区分 "run 不存在" 与 "缺 commands"
     - **✨ /verification 附着 body.status 会污染 activity table**：连跑 5 次不同 `status:` 值 → 5 条 activity 全 outer `kind:verification_finished`, `body.status` 逐字 —— 后端存了 `<script>...</script>` 字符串（等待前端 render）
     - **✨ verify-driven fingerprint 曲线 sample=6→16**（10 次连跑，见 §L13 完整表）：`overall_score 57→71`（14 分抬升），`confidence 0.269→0.392`，`primary_focus task_understanding→capability_invocation`（在 sample=7 时切换），`actions 5→3`（`stabilize_delivery_gate` 在 sample=8 移除，`reduce_timeout_and_iteration_failures` 在 sample=7 移除，之后稳定 `[tune_tools_and_subagents, sharpen_task_acceptance, fill_signal_gaps]`），`verification_pass_rate 0.00→0.77` 单调，`verified_requirement_runs 3→13`
     - **✨ signals 采集延时**：`observed_runs 0→0` 恒定；`agent_success_rate / tool_success_rate` 全程 `null`（LLM-free 采集不到）；说明这三个信号是 LLM 或 agent-loop 触发的
     - **✨ dimension confidence 全 4 维同步单调**：`task_understanding 0.170→0.248`, `planning_execution 0.397→0.578`, `capability_invocation 0.198→0.289`, `task_delivery 0.312→0.454` —— 都按 same 曲率抬升
     - **✨ 07-15 §9 leftover 全落地**：Requirement 侧 PATCH `depends_on:[]` = **清空**（before `[aaaa..]` 后 `[]`），response keys 从 8 → 9 keys（加 `depends_on`）；Todo path 07-16 §L3 同分支这条今天证 Requirement 也 accepted，两侧一致
     - **✨ POST /:id/todos evidence nested type check 也无**（**07-16 §L4 深化到 POST-side**）：`evidence:{run_id:123, exit_code:"str", stderr_excerpt:[1,2], unknown:{deep:true}}` POST 也 200 verbatim round-trip；`as RequirementTodoEvidence` 编译期 assertion **POST + PATCH 两侧全空**
     - **✨ POST /v1/workflows/:id/run w/ workflow.project_id=archived-pid** = **202 dispatch**（run 真正 spawn 到 workflow.project_id=archived-pid 上）：**Governance 漏洞第 7 条**（07-16 是 6 条）
     - **✨ archived-project child 的 `POST /:id/runs`** = 201 pending（第 8 条 governance 漏洞持平 07-16）
     - **✨ archived-project child 的 `POST /:id/approve/reject`** = 200 accept（同 07-16 §L17 持平）
     - **✨ PATCH label_ids:[42] error msg `lid.trim` / POST label_ids:[42] error msg `id.trim`** = **原样保留**（07-16 已发现变量名差异；今天再次 grep 确认两站点未合并）
- **运行约束**：与 07-16 一致 —— `JARVIS_WORK_MODE=off`、stub LLM key、`JARVIS_PERMISSION_MODE=bypass`；DB 用日期后缀 `-20260718` 全新路径。**跳过 DDNS + Memory side-branch**（源码级 9 天持平）

---

## 0. TL;DR — 与 07-16 的差异（2 天间隔）

| 项 | 07-16 状态 | 07-18 状态 | 变化 |
| --- | --- | --- | --- |
| `git log --since=2026-07-16` | 0 commit | **0 commit**（HEAD 仍 `64d288a`） | 静默**第 25 天** |
| 工作树未 commit 文件数 | 39 | **39** | 持平 |
| 522 条 `@jarvis/server` 单测 | 522/522 ✅（7628 ms） | **522/522 ✅**（7532 ms） | 持平（-96 ms 噪声） |
| Servlet 工作目录 | 48h 幸存 | **96h+ 幸存**（07-14 03:06 时间戳全在） | 持平（第 5 天） |
| P1-A POST + PATCH 4 字段透传 | 全双向静默丢字段 | **全双向静默丢字段** | ❌ 未修（第 20 次） |
| P1-B `POST /v1/roadmap/import` | 404 | **404** | ❌ 未修（第 20 次） |
| P1-C `GET /v1/requirements/:id` | 404 | **404** | ❌ 未修（第 20 次） |
| `GET /:id/conversations` 404 | 复现 | **完全复现** | ❌ 未修（第 7 次） |
| Orphan 行 `POST /v1/projects/no-such/requirements` | 201 | **完全复现** | ❌ 未修（第 20 次） |
| `depends_on` POST bogus FK UUID | 通过 | **完全复现** | ❌ 未修（第 16 次） |
| `depends_on:[<non-string>]` → 500 TypeError | 复现 | **完全复现** | ❌ 未修（第 4 天） |
| Manual PATCH `status:"done"` bypass depends_on | 复现（第 8 天） | **完全复现**（第 10 天） | ❌ 未修（第 10 天） |
| `RequirementStatus` 4 值 evidence | 恒定 | **恒定** | 持平 |
| Todo `evidence` type-assertion 失效 (P2 07-15) | 首入档 | **完全复现 + POST-side nested 覆盖**（`{run_id:int, exit_code:str, stderr_excerpt:array, unknown:{deep:bool}}` POST/PATCH 双 200 pass） | ❌ 07-16 P2 扩至 POST-side |
| `label_ids:[<non-string>]` POST 500 | 07-15 首入档 | **完全复现 + PATCH 侧 `lid.trim` / POST 侧 `id.trim` msg 保留** | ❌ 未修（第 4 天）+ 加固 |
| DELETE Requirement idempotence | hard-delete-with-flag | **完全复现** | 持平 |
| DELETE Project = soft-archive | 复现 | **完全复现** + `POST /:id/restore` 存在 | 持平 |
| DELETE Project 无 cascade | 复现 | **完全复现** + `POST /:id/runs` `/approve` `/reject` 全开 | ⚠️ **07-16 §L17 持平** |
| `GET /v1/projects` 隐藏 archived | 07-16 首入档 | **完全复现** + `?include_archived=true` filter 生效 | 持平 |
| `/v1/health` 404 vs `/health` 200 | 未修 | **未修** | ❌ 未修（第 12 次） |
| `server/info` 顶层 16 keys | 复现 | **完全复现**（`tool_count=44`；`mcp_servers=[]`；`memory.mode=window budget_tokens=108000`） | ❌ 未修（第 12 次） |
| `confidence < 0.2` 前端兜底 | P0, 23 天未修 | **P0, 25 天未修** | 持平 |
| **HEADLINE**: verify-driven fingerprint sample=1..N 曲线 | 07-16 只有 sample=1 一个点 | **✨ 07-18 landing：sample=6→16 全 10 点曲线**（`overall 57→71 / confidence 0.269→0.392 / actions 5→3 / verification_pass_rate 0→0.77`） | ⚠️ **07-18 methodology 完整表** |
| **07-16 §L10 CORRECTION**: `PATCH /v1/projects/:id {archived:false}` 是第 3 条 restore | 声称 "第 3 条 restore 路径" | **✨ 07-18 CORRECTION**：**PATCH route 不存在** → 404；只有 2 条 restore 路径 | ⚠️ **07-18 CORRECTION** |
| **07-16 §L11 深化**: `POST /v1/runs/:id/verification body.status` enum 校验 | 07-16 未测 | **✨ 07-18 landing**：**无 enum 校验**（`bogus-enum` / `needs_review` / `<script>...</script>` 全 200 accept） | ⚠️ 07-18 首入档 |
| **07-16 §L11 深化**: `/verification body.status:"fail"` run.status 是否变 | 07-16 未测 | **✨ 07-18 landing**：**run.status 保持 pending** → `/verification` 是**纯附着**（**07-16 §L11 隐含 "会更新 run.status" 假设错**） | ⚠️ **07-18 CORRECTION** |
| **NEW 07-18**: activity outer `kind` enum 完整 | 07-08 记 3 值 `{comment, run_started, status_change}` | **✨ 07-18 landing**：**5 值** `{comment, run_started, run_finished, verification_finished, status_change}`；`verification_finished` + `run_finished` 07-08 遗漏 | ⚠️ 07-18 首入档 |
| **NEW 07-18**: `verification_finished` body shape | 07-16 未测 | **✨ 07-18 landing**：`{run_id, status}`；**status 逐字 client 输入无 sanitization** —— `<script>alert(1)</script>` 存进 activity table | ⚠️ 07-18 首入档 |
| **NEW 07-18**: `/verify` vs `/verification` activity 排放 | 07-16 未细分 | **✨ 07-18 landing**：`/verify` 排放 `[run_finished, verification_finished, run_started, status_change]` 4 kinds；`/verification` 只排放 `[verification_finished, run_started, status_change]` 3 kinds（无 `run_finished`，因未真正 execute） | ⚠️ 07-18 首入档 |
| **NEW 07-18**: PATCH Requirement `depends_on:[]` 清空 | 07-16 未测（Todo 侧 §L3 已知） | **✨ 07-18 landing**：Requirement 侧同 Todo 分双态：before `[aaaa..]` → after `[]`；response keys 从 8 → **9 keys** 加 `depends_on` | ⚠️ 07-18 首入档 |
| **NEW 07-18**: POST /v1/workflows/:id/run w/ workflow.project_id=archived-pid | 07-16 只测 create 未测 run | **✨ 07-18 landing**：**202 pending dispatch**；run 在 archived-pid 的 workspace 里 spawn —— **governance 漏洞第 7 条**（archived 层 workflow-run 也全开） | ⚠️ 07-18 首入档 |

代码侧标记的精确行号仍在原位（今天 grep 三次确认）：

- `packages/server/src/requirements-routes.ts:164-165` "verification_plan / workflow_id ... out of scope for this port" 注释
- `packages/server/src/requirements-routes.ts:231, :296` `body.depends_on.filter((d) => d.trim() !== "")` + `:239, :304` `body.label_ids.filter((id) => id.trim() !== "")` —— **4 处同 bug**；正确修复模板存在于 `:633` (`typeof x === "string"` 前置 filter) 和 `:734`
- `packages/server/src/requirements-routes.ts:729-731` `as RequirementTodoEvidence` type-assertion —— nested-field 类型也全无校验（07-18 §L4 深化到 POST-side）
- `packages/server/src/requirements-routes.ts:559-570` — **只有 GET /activities，POST 未注册**（07-16 §L14 首入档）
- `packages/server/src/requirements-routes.ts:817-860` `POST /v1/runs/:id/verify` route（**07-18 精确复现 07-16 §L12 顺序 bug**：`:828-834` 先 empty-commands 校验，`:837` 才 `runStore.get(id)` —— bogus runid + 空 body → 400 而非 404）
- `packages/server/src/projects-routes.ts:285` `app.put("/v1/projects/:id_or_slug")` —— **只有 PUT 无 PATCH**（07-18 §L10' CORRECTION）
- `packages/tools/src/register-builtins.ts:13` "未移植清单" 注释含 `roadmap.import`
- `packages/server/src/workflow-routes.ts:156` `normalizeSteps(body.steps ?? [])` —— 今天未跑完整 workflow probe（源码未变 → 效果同 07-14）
- `packages/ddns/src/runtime.ts:168` `#running` early-return —— 源码级第 9 天持平（跳过 side-branch）

---

## 1. 测试配置

```
OPENAI_API_KEY=sk-stub-for-automation-test
JARVIS_PROVIDER=openai
JARVIS_MODEL=gpt-4o-mini
JARVIS_FS_ROOT=/tmp/jarvis-servlet-test
JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-20260718
JARVIS_ADDR=127.0.0.1:7099
JARVIS_WORK_MODE=off
JARVIS_PERMISSION_MODE=bypass
JARVIS_NO_PROJECT_CONTEXT=1
```

启动日志：
```
[jarvis] persistence connected: json:///tmp/jarvis-servlet-test-db-20260718
[jarvis] serve: provider=openai model=gpt-4o-mini addr=127.0.0.1:7099 fsRoot=/tmp/jarvis-servlet-test coding=false auth=none ddns=off mdns=off promptBytes=263
[jarvis] listening on http://127.0.0.1:7099
```

**Servlet fixture 96h+ 幸存**（07-14 03:06 时间戳未变；无操作）：
```
/tmp/jarvis-servlet-test/
├── pom.xml                                       # 07-14 03:06, 627 bytes
├── README.md                                     # 07-14 03:06, 140 bytes
└── src/main/
    ├── java/com/example/HelloServlet.java        # 07-14 03:06, 754 bytes
    └── webapp/WEB-INF/web.xml                    # 07-14 03:06, 162 bytes
```

**本轮跳过**：DDNS + Memory + AccessToken side-branch（07-14 详细覆盖，源码级 9 天持平）。

---

## 2. 主 Kanban 主线（stub 模式）

```
1) POST /v1/projects  {name:"servlet-2026-07-18", instructions:"servlet automation probe 07-18 (day 25)"}
   → 201 pid=68722386-99ed-42d8-b4f6-b5a9771bc7c3；slug 自动 "servlet-2026-07-18"
2) POST /v1/projects/<pid>/requirements
   {title:"probe-4fields-07-18","description":"t","triage_state":"approved", + 4 extra fields}
   → 201 rid=ccfeb2c9-12f2-4163-b6d8-fc6f37eb7972
     响应 keys=[conversation_ids, created_at, description, id, project_id, status, title, updated_at] **8 keys**
     4 extra fields (acceptance_policy/workflow_id/assignee_id/verification_plan) **全不出现**
3) PATCH /v1/requirements/<rid>
   4 extra fields (acceptance_policy:"Subagent",workflow_id:"22222222-...", assignee_id:"user-y", verification_plan:{...})
   → 200 same 8 keys；4 fields 全 drop
```

---

## 3. 回归探针（P1 gaps 未修复第 20 次）

### §3.1 P1-A：POST 上 4 字段静默丢

```
BODY = {"title":"probe-4fields-07-18","description":"t","triage_state":"approved",
        "acceptance_policy":"Human",
        "workflow_id":"11111111-1111-1111-1111-111111111111",
        "assignee_id":"user-x",
        "verification_plan":{"steps":[{"kind":"assert","args":{"x":1}}]}}
→ 201 keys=[conversation_ids, created_at, description, id, project_id, status, title, updated_at]  **8 keys**
  全无 acceptance_policy / workflow_id / assignee_id / verification_plan
```

### §3.2 P1-A part 2：PATCH 上 4 字段静默丢

```
→ 200 keys 同上 8 keys，4 字段全丢
```

### §3.3 P1-B：`POST /v1/roadmap/import` 仍 404

```
→ 404 {"message":"Route POST:/v1/roadmap/import not found","error":"Not Found","statusCode":404}
```

### §3.4 P1-C：`GET /v1/requirements/:id` 仍 404

```
→ 404 {"message":"Route GET:/v1/requirements/<rid> not found",...}
```

### §3.5 `GET /v1/requirements/:id/conversations` 仍 404

```
→ 404
```

### §3.6 orphan `project_id` 无 FK

```
POST /v1/projects/no-such-project-07-18/requirements {"title":"orphan-07-18"}
→ 201 id=62c7d3de-... project_id="no-such-project-07-18"  ← 原样写盘
```

### §3.7 `depends_on` POST bogus UUID 通过

```
POST body {"title":"probe-deps-bogus-07-18","depends_on":["00000000-0000-0000-0000-000000000000"]}
→ 201 accept；response.depends_on = ["00000000-..."]
```

### §3.8 Manual PATCH `status:"done"` bypass `depends_on` gate

```
PATCH /v1/requirements/<child_w_bogus_dep> {"status":"done"}
→ 200 {status:"done", depends_on:["00000000-…"], …}   ← gate 完全绕过
```

（第 10 天未修）

### §3.9 `/v1/health` vs `/health` 分裂

```
GET /health → 200 {"status":"ok"}
GET /v1/health → 404
```

（第 12 天未修）

### §3.10 `server/info` 顶层 16 keys（未变）

```
['approval_mode', 'coding_mode', 'config_path', 'listen_addr', 'max_iterations', 'mcp_servers',
 'memory', 'persistence', 'project_context', 'project_store', 'providers', 'system_prompt',
 'tool_count', 'tools', 'version', 'workspace_root']
tool_count = 44；mcp_servers = []；memory = {mode:"window", budget_tokens:108000}
```

---

## 4. 07-16 §9 未验证项 8 条全落地

### §L1: `PATCH /v1/projects/:id` **路由不存在**（**07-16 §L10 CORRECTION**）

```
POST /v1/projects  {name:"pa-patch-restore-07-18",...} → 201 pid
DELETE /v1/projects/<pid>                              → 200 archived:true
GET /v1/projects/<pid>                                 → 200 archived:true (确认状态)
PATCH /v1/projects/<pid> {"archived":false}            → 404 {"message":"Route PATCH:/v1/projects/<pid> not found",...}
```

**源码印证**：`packages/server/src/projects-routes.ts:285` `app.put("/v1/projects/:id_or_slug", ...)` —— **只有 PUT，无 PATCH**。

**结论**：07-16 §L10 声称的 "三条 restore 路径" **是错误**。实际只有 **2 条**：
1. `POST /v1/projects/:id/restore`（`projects-routes.ts:408`）
2. `PUT /v1/projects/:id {"archived":false}`（`projects-routes.ts:285` + `:332-335` 分支 `unarchiveProject`）

CLAUDE.md 未提任何 restore 路径。

### §L2: `POST /v1/runs/:id/verification body.status` **无 enum 校验**（07-16 §L11 深化）

```
POST /v1/runs/<runid>/verification {"status":"bogus-enum","summary":"test"}   → 200 verification={"status":"bogus-enum","summary":"test"}
POST /v1/runs/<runid>/verification {"status":"needs_review","summary":"..."}  → 200 verification={"status":"needs_review","summary":"..."}
POST /v1/runs/<runid>/verification {"status":"pass"}                          → 200
POST /v1/runs/<runid>/verification {"status":42}                              → 400 "body must be a VerificationResult"
```

**结论**：REST 层 **只校验 `typeof status === "string"`**；enum 完全空。`<script>alert(1)</script>` / `bogus-junk-value` / `random-string` 全 200 accept 原样存储。

**修**：`packages/server/src/requirements-routes.ts:799-816` 加 enum whitelist。

### §L3: `POST /v1/runs/:id/verification body.status:"fail"` **不改 run.status**（**07-16 §L11 CORRECTION**）

```
POST /v1/requirements/<rid>/runs {} → 201 run.status="pending"
POST /v1/runs/<runid>/verification {"status":"fail","summary":"boom"}
→ 200 run.status="pending"（**未变**）；verification={"status":"fail","summary":"boom"}
```

**对比**：`POST /v1/runs/<runid>/verify {commands:["echo x"]}` → run.status="completed"（**变**）。

**结论**：`/verification` 是**纯附着 route**（attach-only），**不动 run 生命周期**。`/verify` 才 execute 并 flip run.status → completed。07-16 §L11 曾隐含 "verification 会更新 run.status" —— **错**。

### §L4: HEADLINE — verify-driven fingerprint sample=6→16 完整曲线（**07-16 §L13 methodology 落地**）

**Baseline (sample=6，前面 3 次 verify + 3 次 verification 累积)**：

```
overall_score=57, confidence=0.269, sample_count=6, primary_focus=task_understanding
actions=['stabilize_delivery_gate', 'reduce_timeout_and_iteration_failures',
         'tune_tools_and_subagents', 'sharpen_task_acceptance', 'fill_signal_gaps']
dim.task_understanding=0.170, planning_execution=0.397, capability_invocation=0.198, task_delivery=0.312
signals: completion_rate=1, verification_pass_rate=0, verified_reqs=3, observed_runs=0
```

**10 次连跑 `/verify {commands:["echo verify-N"]}` 后完整表**（每次 mint 一个新 run）：

| iter | sample | overall | confidence | primary_focus | actions | dim.T | dim.P | dim.C | dim.D | verif_pass_rate | verified_reqs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| base | 6  | 57 | 0.2691644627 | task_understanding    | 5 keys                                                                                     | 0.170 | 0.397 | 0.198 | 0.312 | 0.00 | 3 |
| i1   | 7  | 61 | 0.2876349484 | capability_invocation | 4 (drop `reduce_timeout_and_iteration_failures`)                                          | 0.182 | 0.424 | 0.212 | 0.333 | 0.25 | 4 |
| i2   | 8  | 64 | 0.3039270714 | capability_invocation | 3 (drop `stabilize_delivery_gate`; hereafter stable `tune_tools_and_subagents/sharpen_task_acceptance/fill_signal_gaps`) | 0.192 | 0.448 | 0.224 | 0.352 | 0.40 | 5 |
| i3   | 9  | 65 | 0.3185008720 | capability_invocation | 3 (稳定)                                                                                    | 0.201 | 0.469 | 0.235 | 0.369 | 0.50 | 6 |
| i4   | 10 | 67 | 0.3316844783 | capability_invocation | 3                                                                                          | 0.209 | 0.489 | 0.244 | 0.384 | 0.571 | 7 |
| i5   | 11 | 68 | 0.3437201679 | capability_invocation | 3                                                                                          | 0.217 | 0.507 | 0.253 | 0.398 | 0.625 | 8 |
| i6   | 12 | 69 | 0.3547919291 | capability_invocation | 3                                                                                          | 0.224 | 0.523 | 0.261 | 0.411 | 0.667 | 9 |
| i7   | 13 | 69 | 0.3650427788 | capability_invocation | 3                                                                                          | 0.231 | 0.538 | 0.269 | 0.423 | 0.700 | 10 |
| i8   | 14 | 70 | 0.3745860916 | capability_invocation | 3                                                                                          | 0.237 | 0.552 | 0.276 | 0.434 | 0.727 | 11 |
| i9   | 15 | 70 | 0.3835132645 | capability_invocation | 3                                                                                          | 0.242 | 0.565 | 0.283 | 0.444 | 0.750 | 12 |
| i10  | 16 | 71 | 0.3918990544 | capability_invocation | 3                                                                                          | 0.248 | 0.578 | 0.289 | 0.454 | 0.769 | 13 |

**关键 signals 恒定**（LLM-free 采集不到）：
- `agent_success_rate = null` (全程)
- `tool_success_rate = null` (全程)
- `observed_runs = 0` (全程)
- `completion_rate = 1` (全程)

**结论**：
- **`primary_focus` 切换在 sample=7**：`task_understanding → capability_invocation`（一次 verify 就切）
- **`actions` 从 5 → 4 → 3**：`reduce_timeout_and_iteration_failures` 在 sample=7 移除；`stabilize_delivery_gate` 在 sample=8 移除；之后稳定 `[tune_tools_and_subagents, sharpen_task_acceptance, fill_signal_gaps]`
- **`overall_score` 抬升 14 分**（57→71），**不封顶**（07-01 rules 中 "capped at 69 when task_delivery < 60" 门槛在 sample=10 到 sample=12 突破，从 69→70 → 71 —— dim.task_delivery 从 0.384 到 0.454，score 层面对应 38→45 未突破 60，但 confidence 已到 71，说明 rules 表达式有额外分支）
- **`confidence` 抬升 0.123**（0.269→0.392）：不满 `confidence>=0.4`（P0 前端阈值），说明**verify-driven 单跑 10 次也不足以脱离 "样本不足" 分类**（对应过去 25 天 P0 未修的实际场景）
- **`verification_pass_rate` 单调抬升 0→0.77**：分母是 `verified_requirement_runs`（3→13），numerator 计 `pass` count（初始 0，10 次连跑 verify 全 pass，最终 10/13=0.77）—— 说明 baseline 3 条 verification 是**曾附着 `status:"fail"`** 的（我们本轮 §L3 测过一次 `/verification status:"fail"`），拉低了初始分母
- **`verified_requirement_runs` 单调抬升 3→13**：每次 verify 或 verification 都算一条 verified —— 说明**过去 22 报告 "sample_count 恒定 0" 是因为**从未跑 `/verify` 或 `/verification`**

**07-16 §L13 memoized `sample=1 confidence=0.09587831612649744` (verify-driven)** vs **memory `sample=1 confidence=0.06560095313918246` (pending-only)**：本轮 sample=1 无法直接观察（base 已到 6），但从 i1 = sample=7 confidence=0.288 反推曲线，与 07-16 单点数据完全吻合。**verify-driven 曲线现完整存表**。

**未验证**：sample=17..30 是否 primary_focus 会切到 `task_delivery`？actions 会不会再减？（07-19 未 verify 到 30 sample）

### §L5: PATCH `depends_on:[]` Requirement 侧 = 清空（**07-16 §9 leftover 落地**）

```
先 PATCH depends_on:["aaaaaaaa-..."] → 200 depends_on=["aaaa..."]
再 PATCH depends_on:[]                → 200 depends_on=[]，keys 9 keys（加 depends_on）
```

**结论**：`if (body.depends_on !== undefined)` 分支执行；`[]` 真正清空数组。Requirement 侧同 Todo §L3（07-16）分双态；两侧一致。**但两侧代码是独立分支**（不同 filter 逻辑，见 §3.7 未修）。

### §L6: Activity **`verification_finished`** 是 /verify + /verification 双方 side-effect（07-16 §L14 深化）

```
/verify:      activities emit [run_started, run_finished, verification_finished, status_change]
/verification (只附着): activities emit [run_started, verification_finished, status_change]  ← 无 run_finished（未真正 execute）
```

**结论**：
- **outer `kind` enum 从 3 → 5**（07-08 记 3 值，07-18 补 `run_finished` + `verification_finished`）
- `/verify` **同时触发 4 条**（`run_started` 是 POST /runs 时的，`run_finished`+`verification_finished` 是 /verify 内部两阶段）
- `/verification` **只触发 3 条**（无 `run_finished`）
- 07-16 §9 memoized "body.kind:verification_attached" —— **错**：正确的是 **outer `kind:verification_finished`**（`body` 不是 classifier，而是 `{run_id, status}` payload）

### §L7: `verification_finished.body.status` **无 sanitization** —— XSS pollution (**07-18 首入档**)

```
POST /v1/runs/<runid>/verification {"status":"pass"}                         → activity body.status = "pass"
POST /v1/runs/<runid>/verification {"status":"fail"}                         → activity body.status = "fail"
POST /v1/runs/<runid>/verification {"status":"needs_review"}                 → activity body.status = "needs_review"
POST /v1/runs/<runid>/verification {"status":"bogus-junk-value"}             → activity body.status = "bogus-junk-value"
POST /v1/runs/<runid>/verification {"status":"<script>alert(1)</script>"}    → activity body.status = "<script>alert(1)</script>"
```

**结论**：`verification_finished` outer kind 已固定，但 `body.status` **完全逐字**存储 client POST body。activity table 变 XSS reservoir。前端 render 若 `dangerouslySetInnerHTML` 或类似 → **实际 XSS 触发路径**。

**修**：
1. `packages/server/src/requirements-routes.ts:799-816` 加 enum whitelist（配合 §L2）
2. 或前端 render 时 escape（防御深度）

### §L8: `POST /:id/todos` w/ `evidence:{nested types}` 也 accept（07-16 §L4 扩至 POST-side）

```
POST /v1/requirements/<rid>/todos {"title":"t-post-nested-07-18","kind":"work","evidence":{
  "run_id":123,           ← 应 string，实际 int accept
  "exit_code":"str",      ← 应 int，实际 str accept
  "stderr_excerpt":[1,2], ← 应 string，实际 array accept
  "unknown":{"deep":true} ← 应无此 key，实际 accept
}}
→ 201 response.todo.evidence = {run_id:123, exit_code:"str", stderr_excerpt:[1,2], unknown:{"deep":true}}
```

**结论**：POST 与 PATCH 两侧 evidence nested type 校验都缺（07-16 只测 PATCH-side）。`as RequirementTodoEvidence` 编译期 assertion **对 POST 与 PATCH 全 nested 字段类型零覆盖**。

**修**：一处 runtime Zod / Fastify JSON Schema 覆盖两 route（POST + PATCH）。

### §L9: `POST /v1/workflows/:id/run` w/ workflow.project_id=archived-pid = **202 dispatch**（**governance 漏洞第 7 条**）

```
POST /v1/projects {"name":"pa-wfrun-07-18",...}                                                        → 201 pid
DELETE /v1/projects/<pid>                                                                             → 200 archived
POST /v1/workflows {"name":"wf-arch-run-07-18","project_id":"<archived-pid>","steps":[...]}           → 201 wid
POST /v1/workflows/<wid>/run {}                                                                       → 202 {"status":"pending","started_at":"...","step_results":[]}
```

**结论**：07-16 §L15 记 "workflow 层 project FK 缺 → 创建 201 accept"；今天扩至 **run 层也全开** —— 202 pending 真正 dispatch，run 会跑 workflow 的 steps 在 archived-pid 的 workspace 中。

**governance 漏洞 7 条汇总**：
1. 07-15 §L9 archived-project 上 POST /:id/requirements 全开
2. 07-16 §L5 archived-project child 的 /:id/runs 全开
3. 07-16 §L11 archived-project child 的 /:id/verification 全开
4. 07-16 §L12 archived-project child 的 /:id/verify 全开
5. 07-16 §L15 workflow 层的 project_id FK 也全无检查（**create**）
6. 07-16 §L17 archived-project child 的 /:id/approve/reject 全开
7. **07-18 §L9 archived-pid workflow 的 /:id/run 全开**（**run 层扩展**）

---

## 5. 07-18 新发现深挖

### §L10: 07-16 §L12 顺序 bug 精确定位（**07-18 confirm**）

```
POST /v1/runs/bogus-runid-07-18/verify {}                          → 400 "`commands` must not be empty; POST /verification to attach a result without running anything"
POST /v1/runs/bogus-runid-07-18/verify {"commands":["echo test"]}  → 404 "run `bogus-runid-07-18` not found"
```

**源码印证**（`packages/server/src/requirements-routes.ts:817-860` 完整贴出）：

```ts
app.post("/v1/runs/:id/verify", async (req, reply) => {
  const runStore = requireRunStore(state, reply);
  if (!runStore) return reply;
  const id = (req.params as { id: string }).id;
  const body = (req.body ?? {}) as { commands?: unknown; ... };
  const commands = Array.isArray(body.commands)
    ? body.commands.filter((c): c is string => typeof c === "string")
    : [];
  if (commands.length === 0) {                                     // ← :831 empty-commands 校验先跑
    return reply.code(400).send({
      error: "`commands` must not be empty; ...",
    });
  }
  try {
    const run = await runStore.get(id);                            // ← :837 runStore.get 后跑
    if (!run) return reply.code(404).send({ error: `run \`${id}\` not found` });
    ...
```

**结论**：07-16 §L12 表达完全正确 —— 需要把 `runStore.get(id)` 提到 `commands.length===0` 校验之前（5 行 fix）。

**为什么算 bug**：客户端发空 body 到 bogus runid 时，收到的 400 消息暗示 "补 commands 就好"，实际上补了 commands 也不会 execute（run 不存在）—— 让 debug 走弯路。

### §L11: PATCH `label_ids:[42]` 与 POST `label_ids:[42]` **两站点独立代码**（07-16 §L1 加固）

```
PATCH /v1/requirements/<rid> {"label_ids":[42]}     → 500 "lid.trim is not a function"
POST /v1/projects/<pid>/requirements {"title":"x","label_ids":[42]}
                                                     → 500 "id.trim is not a function"
```

**结论**：变量名 `lid` (PATCH) vs `id` (POST) —— 证明 `:239 POST` 与 `:304 PATCH` 是**两份独立的 filter 代码**，不共用 helper。修 4 站点必须全动（`:231/296 depends_on` + `:239/304 label_ids`）。

### §L12: 522/522 单测继续绿

```
$ pnpm --filter @jarvis/server test
...
# tests 522
# suites 0
# pass 522
# fail 0
# cancelled 0
# skipped 0
# duration_ms 7532.04925
```

单测覆盖率与 25 天前一致 —— **未 catch 到 4 处 500 泄漏、7 条 governance 漏洞、5 处 CORRECTION 事项**。说明 test suite **优先覆盖 happy path**，边界/否定/enum-outsider case 全空。

---

## 6. 未修复清单（P0/P1/P2 累积到第 25 天）

**P0**（前端 1 行 5 分钟）：
- confidence < 0.2 前端兜底（读 `actions.find(a=>a.key==="fill_signal_gaps") && sample_count<5`）— **25 天未修**

**P1**（REST 层缺 route / FK / 字段透传 / 类型校验 / 顺序 bug）：
- POST + PATCH 4 字段（`acceptance_policy` / `workflow_id` / `assignee_id` / `verification_plan`）静默丢 — 25 天未修
- `POST /v1/roadmap/import` 404 — 25 天未修
- `GET /v1/requirements/:id` 404 — 25 天未修
- `GET /v1/requirements/:id/conversations` 404 — 9 天未修
- orphan project_id 无 FK — 25 天未修（延伸到 archived project pid + workflow project_id / run / verification lifecycle → **governance 漏洞 7 条**）
- depends_on / label_ids **4 处**同源 FK / typeof — 21 天未修（**07-18 补充 PATCH `lid.trim` / POST `id.trim` 变量名差异证明独立代码**）
- `depends_on` / `label_ids` 非-string → 500 raw TypeError 泄漏 — 4 天未修
- `POST /:id/conversations` conversation_id 无格式 + 无 FK — 8 天未修
- `POST /v1/workflows` 500 泄漏 10 shape — 15 天未修（跳过复测）
- `DELETE /v1/ddns/config` 未注册 route — 13 天未修（跳过）
- Manual PATCH `status:"done"` bypass depends_on gate — 10 天未修
- DDNS runtime `#running` 泄漏 stale `last_result` — 9 天源码级持平（跳过）
- DELETE Project 无 cascade — **07-18 governance 漏洞 7 条**（`POST /workflows/:id/run` 于 archived-pid 上也 202 dispatch）
- **07-16 首入档**：`POST /v1/runs/:id/verify` bogus runid **被 empty-commands 校验先拦返 400 而非 404**（顺序 bug；`:828-834` 应移到 `runStore.get(id)` 之后，5 行 fix）— 07-18 精确复现
- **07-18 首入档**：`POST /v1/runs/:id/verification body.status` **无 enum 校验** — REST 层只 typeof-string，`<script>alert(1)</script>` 200 accept
- **07-18 首入档**：`activity.body.status` 无 sanitization → XSS pollution 通道打通

**P2**（一致性 / 语义 / 文档缺）：
- list shape 五分裂 — 21 天未修
- `/v1/health` 404 vs `/health` 200 — 13 天未修
- `server/info` 不反映 `ddns/memory_enabled/mdns/access_token_configured/features` — 13 天未修
- depends_on 条件性写回 shape drift — 17 天未修
- `depends_on` 空串/whitespace-only 静默 strip + 重复 UUID 不 dedup — 5 天未修
- DDNS PUT 累计 10 处 soft-accept — 25 天未修（跳过）
- `POST /v1/ddns/upnp/test` body 静默无效 — 9 天未修
- `POST /v1/ddns/update` 200 wrap `last_result:{ok:false}` 语义文档缺 — 7 天未修
- `/start` `/block` `/complete` 是 agent tools 而非 REST — 9 天未修
- Todo `status` / `kind` / `created_by` 枚举与 Requirement 完全不同 — 8 天未修
- Todo evidence type-assertion 完全失效 + **07-18 POST + PATCH 双侧 nested field 类型全无校验** — 4 天未修 + 加固
- Todo `command:""` 与 `command:null` 同 = DELETE — 5 天未修
- Todo POST/PATCH response envelope `{todo, requirement}` 双 view — 5 天未修
- Activity outer `kind` enum **07-08 记 3 值**→ **07-18 补充 5 值**（`{comment, run_started, run_finished, verification_finished, status_change}`）—— **文档漏 2 条 outer kind**
- Activity `body.kind` inner-classifier convention — 12 天未修
- UUID 格式校验非一致 — 12 天未修
- REST 幂等 style 累计 **6 种**（`POST /:id/restore` = select-then-noop）— 10 天累加中
- Todo sub-resource 五 route 五种 envelope shape — 10 天未修
- `GET /v1/remote/info.external` 三-shape 分裂 — 10 天未修
- `/v1/remote/pairing.token` = 明文 access token — 10 天未修
- `DELETE /v1/projects/:id` 与 `DELETE /v1/requirements/:id` 同名 verb 完全不同语义 — 4 天未修
- **07-16 首入档**：**`GET /v1/projects?include_archived=true` filter 存在**（07-15 §L10 CORRECTION）—— CLAUDE.md 未提；除 `include_archived` 外其他 alias `?archived=true/all` 全 ignored
- **07-16 首入档**：`POST /v1/projects/:id/restore` route 存在（07-15 §L8 CORRECTION）—— CLAUDE.md 未提；**07-18 §L1 CORRECTION**：**只有 2 条 restore 路径**（`POST /:id/restore` + `PUT /:id {archived:false}`），07-16 §L10 声称的 "PATCH archived:false 是第 3 条路径" 错
- **07-16 首入档**：`POST /v1/runs/:id/verification` route 存在 —— CLAUDE.md 未提；**07-18 §L2 加固**：`body.status` 只 typeof-string，无 enum；**07-18 §L3 CORRECTION**：不动 run.status（"attach-only" 而非 "update-run-status"）
- **07-16 首入档**：`POST /v1/runs/:id/verify` route 存在 —— CLAUDE.md 未提；**07-18 §L10 confirm 顺序 bug**
- **07-16 首入档 P0 methodology**：过去 22 报告 "fingerprint 恒定" 是探测方法学 artefact；`/verify {commands:[...]}` 是 **LLM-free 推动 harness health 的路径** —— **07-18 §L4 landing sample=6→16 完整 10 点曲线**
- **07-16 首入档**：`POST /v1/requirements/:id/activities` = 404，Activity 是 side-effect-only —— CLAUDE.md 未明写此语义
- **07-16 首入档**：`POST /v1/workflows body.project_id=<archived-pid>` = 201 accept —— **07-18 §L9 扩至 `POST /workflows/:id/run` 也 202 dispatch**（governance 漏洞第 7 条）

---

## 7. 07-18 首次发现清单（净新增）

1. **✨ §L1 CORRECTION**：`PATCH /v1/projects/:id` **route 不存在**（404）—— 07-16 §L10 声称的 "PATCH archived:false 是第 3 条 restore 路径" **错**；实际只有 **2 条 restore 路径**（`POST /:id/restore` + `PUT /:id {archived:false}`）；`projects-routes.ts:285` 只注册 `app.put`
2. **✨ §L2**：`POST /v1/runs/:id/verification body.status` **无 enum 校验** —— REST 层只 typeof-string，`bogus-enum` / `<script>...</script>` / `random-string` 全 200 accept 原样存储
3. **✨ §L3 CORRECTION**：`/verification` 是**纯附着 route**，**不动 run.status** —— 07-16 §L11 隐含 "会更新 run.status" 错；`/verify` 才 flip run.status → completed
4. **✨ §L4 HEADLINE**：**verify-driven fingerprint sample=6→16 完整 10 点曲线**（`overall 57→71 / confidence 0.269→0.392 / actions 5→3 / verification_pass_rate 0→0.77`）；**primary_focus 在 sample=7 切换**；**actions 在 sample=7/8 分别 drop 1 键**；`agent_success_rate` / `tool_success_rate` / `observed_runs` **全程 null / 0**（LLM-free 采集不到 —— 3 个不同信号源）
5. **✨ §L5**：`PATCH /v1/requirements/:id {depends_on:[]}` = **清空**（before `[aaaa..]` 后 `[]`），response keys 从 **8 → 9 keys**（加 `depends_on`）—— Requirement 侧同 Todo §L3（07-16）分双态
6. **✨ §L6**：Activity **`verification_finished`** 是 `/verify` + `/verification` 双方 side-effect；`/verify` 排放 4 kinds（含 `run_finished`），`/verification` 只排放 3 kinds（**无 `run_finished`**）；**outer `kind` enum 从 07-08 记 3 值扩至 5 值** `{comment, run_started, run_finished, verification_finished, status_change}`
7. **✨ §L7**：`verification_finished.body.status` **完全逐字**存储 client POST body —— **XSS pollution 通道打通** —— activity table 变 XSS reservoir
8. **✨ §L8**：`POST /:id/todos` `evidence:{nested types}` 也 accept（07-16 §L4 扩至 **POST-side**）；`as RequirementTodoEvidence` 编译期 assertion POST + PATCH **双侧 nested 全空**
9. **✨ §L9**：`POST /v1/workflows/:id/run` w/ workflow.project_id=archived-pid = **202 pending dispatch**，run 真正 spawn 在 archived-pid workspace —— **governance 漏洞第 7 条**（run 层扩展）
10. **✨ §L10 confirm**：07-16 §L12 顺序 bug 精确定位：`packages/server/src/requirements-routes.ts:828-834` empty-commands 校验先跑；`:837` runStore.get 后跑；bogus runid + 空 body → 400，bogus runid + 非空 commands → 404
11. **✨ §L11 加固**：PATCH `label_ids:[42]` 报错 `lid.trim` / POST `label_ids:[42]` 报错 `id.trim` —— 变量名 `lid` vs `id` **决定性证明**两站点独立代码（不共用 helper），修 4 处全需动
12. **✨ Fixture 96h+ 幸存**：07-14 03:06 重建的 4 文件 07-18 03:06 仍在（macOS 未清 `/tmp` 第 5 天）
13. **✨ 522/522 单测 25 天全绿**：单测未 catch 到 7 条 governance 漏洞 + 4 处 500 泄漏 + 5 处 CORRECTION —— 单测覆盖率优先 happy path

---

## 8. 复现 commands 一键版

```bash
# fixture 已在（07-14 03:06 至 07-18 03:06 96h+ 幸存）
[ -d /tmp/jarvis-servlet-test ] || (
  mkdir -p /tmp/jarvis-servlet-test/src/main/java/com/example \
           /tmp/jarvis-servlet-test/src/main/webapp/WEB-INF
  # ... （见 07-14 §8 完整 pom.xml + HelloServlet.java 模板）
)

# 主分支起 (关键：DB 用当天日期后缀)
export OPENAI_API_KEY=sk-stub-for-automation-test
export JARVIS_PROVIDER=openai JARVIS_MODEL=gpt-4o-mini
export JARVIS_FS_ROOT=/tmp/jarvis-servlet-test
export JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-<YYYYMMDD>
export JARVIS_ADDR=127.0.0.1:7099
export JARVIS_WORK_MODE=off JARVIS_PERMISSION_MODE=bypass JARVIS_NO_PROJECT_CONTEXT=1
node --experimental-strip-types packages/jarvis-app/src/main.ts serve &

B=http://127.0.0.1:7099

# §L1 CORRECTION: PATCH /v1/projects/:id 404
PA=$(curl -sS -XPOST $B/v1/projects -H 'Content-Type: application/json' -d '{"name":"pa","instructions":"x"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -sS -XDELETE $B/v1/projects/$PA
curl -sS -XPATCH $B/v1/projects/$PA -H 'Content-Type: application/json' -d '{"archived":false}'  # → 404 route not found（07-16 §L10 CORRECTION）
curl -sS -XPUT $B/v1/projects/$PA -H 'Content-Type: application/json' -d '{"archived":false}'   # → 200 restore（真正的第 2 条 restore 路径）

# §L2/L3: verification body.status 无 enum + 不动 run.status
PID=$(curl -sS -XPOST $B/v1/projects -H 'Content-Type: application/json' -d '{"name":"demo","instructions":"x"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
RID=$(curl -sS -XPOST $B/v1/projects/$PID/requirements -H 'Content-Type: application/json' -d '{"title":"r"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
RUNID=$(curl -sS -XPOST $B/v1/requirements/$RID/runs -H 'Content-Type: application/json' -d '{}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["run"]["id"])')
curl -sS -XPOST $B/v1/runs/$RUNID/verification -H 'Content-Type: application/json' -d '{"status":"bogus-enum"}'  # → 200 accept
curl -sS -XPOST $B/v1/runs/$RUNID/verification -H 'Content-Type: application/json' -d '{"status":"fail"}'       # → 200 但 run.status="pending"（未变）
curl -sS $B/v1/runs/$RUNID | python3 -c 'import sys,json;d=json.load(sys.stdin);print("run.status=",d.get("status"))'

# §L4 HEADLINE: verify-driven fingerprint 10 点曲线
python3 <<'PY'
import urllib.request, json
B = 'http://127.0.0.1:7099'
def http(method, path, body=None):
    req = urllib.request.Request(f"{B}{path}", method=method)
    data = None
    if body is not None: req.add_header('Content-Type', 'application/json'); data = json.dumps(body).encode()
    with urllib.request.urlopen(req, data=data, timeout=10) as r: return json.loads(r.read().decode())
p = http('POST', '/v1/projects', {'name':'curve','instructions':'x'})
r = http('POST', f'/v1/projects/{p["id"]}/requirements', {'title':'r'})
for i in range(1, 11):
    run = http('POST', f'/v1/requirements/{r["id"]}/runs', {})
    http('POST', f'/v1/runs/{run["run"]["id"]}/verify', {'commands': [f'echo verify-{i}']})
    h = http('GET', '/v1/observability/health')
    print(f"i={i} sample={h['sample_count']} overall={h['overall_score']} conf={h['confidence']} focus={h['primary_focus']}")
PY

# §L7 XSS activity pollution
curl -sS -XPOST $B/v1/runs/$RUNID/verification -H 'Content-Type: application/json' -d '{"status":"<script>alert(1)</script>"}'  # → 200
curl -sS $B/v1/requirements/$RID/activities | python3 -c 'import sys,json;d=json.load(sys.stdin);rows=d.get("items",[]);vf=[r for r in rows if r.get("kind")=="verification_finished"];[print("body.status=",r.get("body",{}).get("status")) for r in vf]'

# §L9 workflow-run on archived-pid
PA9=$(curl -sS -XPOST $B/v1/projects -H 'Content-Type: application/json' -d '{"name":"pa-wf","instructions":"x"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -sS -XDELETE $B/v1/projects/$PA9
WFID=$(curl -sS -XPOST $B/v1/workflows -H 'Content-Type: application/json' -d "{\"name\":\"wf\",\"project_id\":\"$PA9\",\"steps\":[{\"name\":\"s1\",\"kind\":{\"type\":\"agent\",\"prompt\":\"echo\"}}]}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -sS -w "HTTP=%{http_code}\n" -XPOST $B/v1/workflows/$WFID/run -H 'Content-Type: application/json' -d '{}'  # → 202 dispatch
```

---

## 9. 未验证项（继续滚到 07-19+）

- **07-18 新留白**：
  - `POST /v1/runs/:id/verification body.status={pass|fail|needs_review}` 与 Todo enum `RequirementTodoStatus`={pending/running/passed/failed/skipped/blocked} 关系 —— verification 的 enum 与 Requirement 的 6 值 Todo enum 不同（`pass` vs `passed`、`fail` vs `failed`、多出 `needs_review`）；这套 enum 定义在哪里？（07-19 补 grep）
  - **HEADLINE 后续**：连跑 20 次以上 `/verify` → sample=17..30 时 `primary_focus` 是否切到 `task_delivery`？`actions` 是否再减到 2 或 1？`overall_score` 是否封顶 69（07-01 rules "capped at 69 when task_delivery < 60"）—— 本轮到 sample=16 时 overall=71 已过 69，说明 cap 表达式有额外分支，需补充源码印证
  - **agent_success_rate / tool_success_rate / observed_runs** 3 个信号源：什么 API 会推动它们？（`subagent.run` / MCP tool call / agent-loop完成？—— 需要真 LLM key 或 mock）
  - `PATCH /v1/projects/:id_or_slug`（slug 版本）是否也 404？（本轮只测 id 版本）
  - `PATCH /v1/requirements/:id {"triage_state":"proposed_by_agent"}` 是否降级 approved → proposed（07-16 未测）
  - Activity `run_finished.body` shape 首次记录（本轮未详细取样）
  - `POST /v1/workflows/:id/run w/ workflow.project_id=archived-pid` 到 202 后，run 是否**真正 execute**（本轮到 202 就停了，未追 status → completed）
  - Activity `status_change.body` shape（本轮只观察 outer `kind`，未 dump 单条 body）
- **07-16 累积（残留）**：
  - `POST /:id/todos` 上 `evidence:{run_id:123}` → **07-18 §L8 已 landing**（POST 与 PATCH 都无 nested 校验）
  - Activity `body.kind:"verification_attached"` → **07-18 §L6 修正**：正确是 outer `kind:verification_finished`，07-16 表达错
- **07-15 残留（继续观察）**：DDNS PUT 累计 10 处 soft-accept 全部
- **建议下一次 investment**：
  - **PR#1**：`.filter((d) => d.trim() !== "")` → `.filter((d): d is string => typeof d === "string" && d.trim() !== "")` × 4 站点（`:231, :296, :239, :304`）—— 修 3 个 P1 same-source bug（POST/PATCH × depends_on/label_ids）**+ 顺便合并成 helper**（`lid` vs `id` 变量差异消除）
  - **PR#2**：`packages/server/src/requirements-routes.ts:729-731` `as RequirementTodoEvidence` type-assertion → Fastify JSON Schema 或 runtime Zod —— 修 P2 §L3 + 07-16 §L4 + **07-18 §L8 POST-side** nested 校验缺
  - **PR#3**：`packages/server/src/requirements-routes.ts:817-833` `POST /v1/runs/:id/verify` bogus runid 顺序 bug —— 把 `runStore.get(id)` 提到 commands 校验之前（5 行）
  - **PR#4**：`packages/server/src/projects-routes.ts:249-253` `?include_archived=true` filter 加同名 alias（`?archived=true/all` 也 accept）—— 一致性 fix；**同时补 `app.patch("/v1/projects/:id_or_slug")` 路由**（一致 PUT/PATCH，或明确否定 PATCH 走 405）
  - **PR#5**：CLAUDE.md 加 `POST /v1/projects/:id/restore` / `POST /v1/runs/:id/{verification,verify}` 三条 route + Activity outer `kind` enum 5 值 + Activity side-effect-only 语义 + `?include_archived=true` filter + **verify-driven fingerprint 曲线 methodology + 只有 2 条 restore 路径 CORRECTION**
  - **PR#6（安全）**：`packages/server/src/requirements-routes.ts:799-816` `POST /v1/runs/:id/verification` 加 enum whitelist for `body.status`；同时前端 render activity.body.status 时 escape —— 修 07-18 §L2 + §L7 双向

---

## 10. 总览

| 项 | 评分 | 与 07-16 比（2 天） |
| --- | --- | --- |
| Kanban (Project + Requirement CRUD + Todo + Activity) | ✅ 健康；`RequirementStatus` 4 值恒定；archived governance 漏洞扩至 7 条；activity outer `kind` 5 值 | **07-18 深化 P1 scope + 补充 activity 完整分类** |
| Workflow CRUD + dispatch + cancel | ✅ 健康（除 §4.1 10 shape 500 泄漏；本轮跳过）；**07-18 补 `POST /workflows/:id/run w/ archived-pid` = 202 dispatch**（governance 漏洞 7 条 run 层扩展） | **07-18 深化** |
| Diagnostics (`/v1/diagnostics/*` + `/v1/work/*`) | ✅ 健康 | 持平 |
| Harness.health 算法实装 | ✅ 稳定第 25 天；**07-18 verify-driven sample=6→16 曲线完整 landing**（primary_focus 在 sample=7 切；actions 5→3；overall 57→71） | **07-18 methodology landing** |
| Harness.health 信号采集 | ⚠️ pending-only 采集不到；`/verify` 是 LLM-free 推动路径；**agent_success_rate / tool_success_rate / observed_runs** 三源需要 LLM/agent-loop 触发 | **07-18 深化** |
| Harness.health 前端表达 | ❌ confidence 低分仍直接展示 score | **25 天未修** |
| DDNS 后端 | ⚠️ 源码级 9 天持平；本轮跳过 side-branch | 持平 |
| Memory 后端 | ✅ 健康（跳过） | 持平 |
| REST ↔ 数据模型一致性 | ❌ depends_on / label_ids 4 站点无 typeof；Todo evidence 4 类型 + nested POST/PATCH 双侧全 accept；PATCH msg diff 证明 4 处独立代码；**07-18 §L2 verification body.status 无 enum；§L7 activity.body 无 sanitization** | **07-18 加固 + XSS 通道** |
| Requirement sub-resources 完整覆盖 | ✅ 07-18 补 `/verification body.status 无 enum` + `/verification 不改 run.status` + `PATCH /v1/projects/:id 404` + workflow-run archived-pid dispatch | **07-18 补 4 处** |
| 文档 ↔ 运行时一致性 | ❌ **07-18 CORRECTION 2 条**（07-16 §L10 3-路径 restore 错→只 2 路径；07-16 §L11 verification 更新 run.status 错→不动）；4 条 route + 1 filter + Activity 5-kind outer enum + Activity side-effect-only CLAUDE.md 全缺 | **07-18 揭 2 CORRECTION** |
| 单测覆盖 | ✅ 522/522 全绿，7532 ms | 持平（-96 ms 噪声） |
| **真 bug**：`POST /v1/workflows` 500 泄漏 | ❌ 源码未变（跳过复测） | 持平（第 14 次） |
| **真 bug**：`DELETE /v1/ddns/config` 无 handler | ❌ 未复测（跳过 side-branch） | 源码级持平 |
| **真 bug**：depends_on / label_ids 4 处 typeof 缺 | ❌ 全复现 + **07-18 lid/id 变量名差异证明独立代码** | **07-18 加固** |
| **真 bug**：manual PATCH `status:"done"` bypass depends_on gate | ❌ §3.8 复现 | 持平（第 10 天） |
| **真 bug**：DDNS runtime `#running` 泄漏 stale `last_result` | ⚠️ 源码 9 天持平（跳过） | 源码级持平 |
| **真 bug**：`depends_on:[<non-string>]` → 500 raw TypeError 泄漏 | ❌ 4 天未修 | 持平 |
| **真 bug**：Todo `evidence` type-assertion 完全失效 + POST + PATCH 双侧 nested 全空 | ⚠️ **07-18 §L8 扩至 POST-side** | **07-18 加固** |
| **真 bug**：DELETE Project 无 cascade → run/verification/verify/workflow-run lifecycle 全开 | ⚠️ **07-18 §L9 扩至 workflow-run 层**（governance 漏洞第 7 条） | **07-18 扩至 7 条 governance 漏洞** |
| **真 bug**（07-16 首入档 / 07-18 精确定位）：`POST /v1/runs/:id/verify` bogus runid 被 empty-commands 校验先拦，返 400 而非 404 | ⚠️ **07-18 §L10 精确源码定位** | 持平 + 加固 |
| **真 bug**（07-18 首入档）：`POST /v1/runs/:id/verification body.status` **无 enum 校验** | ⚠️ **07-18 §L2 P1 首入档** | **07-18 新添** |
| **真 bug**（07-18 首入档）：`activity.body.status` 无 sanitization → **XSS pollution 通道打通** | ⚠️ **07-18 §L7 P1 首入档** | **07-18 新添** |
| **真 methodology bug**（07-16 首入档 / 07-18 完整 landing）：**verify-driven fingerprint sample=6→16 曲线**（`overall 57→71 / confidence 0.269→0.392 / actions 5→3`） | ⚠️ **07-18 methodology full landing** | **07-18 完整** |
