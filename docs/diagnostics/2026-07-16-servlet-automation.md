# Jarvis 项目自动化能力诊断报告（2026-07-16 十九次复测）

- **运行时间**：2026-07-16（scheduled task 自动跑）
- **被测分支**：`feat/mobile-ios-ddns`（HEAD 仍为 `64d288a`，与 06-23 → 07-15 同一 commit — **静默第 23 天**；工作树侧 39 个未 commit 文件与 07-15 逐字一致）
- **被测项目**：`/tmp/jarvis-servlet-test`
  - **07-16 差异**：fixture **完整幸存第 3 天**（07-14 03:06 重建，07-15 24h 幸存，07-16 48h 幸存；`ls -la` 4 文件时间戳全为 Jul 14 03:06）
  - **07-15 → 07-16 一天间隔**：期间 0 commit（HEAD 未动，工作树也未动）；scheduled task 恢复日跑节奏
- **本次目的**：
  1. **回归确认** 07-15 P0/P1/P2 累积项在 1 天间是否被修复（预期：全未修，第 23 天）
  2. **07-15 §9 未验证项 6 条全落地**：
     - `POST /v1/requirements/:id/todos {"depends_on":[<non-string>]}` POST 层是否 filter（`:601-635` POST-side 与 `:693-745` PATCH-side 是否共用同一 helper）
     - `PATCH /v1/requirements/:id {"label_ids":[42]}` PATCH 侧 500 消息（`:304` 与 POST `:239` 是否同错）
     - `PATCH /:id/todos/:tid {"depends_on":[]}` empty array 覆盖是清空还是保留
     - Todo `evidence` nested 结构（`{run_id:123,exit_code:"str",...}` 是否有 nested type check）
     - archived-parent → archived-child 的 POST /:id/runs 是否 201 或 400
     - `DELETE /v1/requirements/<child_of_archived>` 二次行为
  3. **今日新发现**（07-15 未预告）：
     - **✨ 07-15 §L8/§L10 CORRECTION**：`POST /v1/projects/:id/restore` **route 是存在的**（`packages/server/src/projects-routes.ts:408`）；07-15 声称 "restore 只能通过底层 store 手改" **是错误结论**
     - **✨ 07-15 §L10 CORRECTION**：`GET /v1/projects?include_archived=true` **filter 是被识别的**（`projects-routes.ts:249-253`）；07-15 声称 "无 filter 参数可查 archived project 列表" **也是错误结论**（唯一识别的 key 是 `include_archived`；其他别名 `archived=true/all` 全 ignored）
     - **✨ 07-15 §L8 EXPANSION**：`PUT /v1/projects/:id` body `{"archived":false}` 也 restore —— 第 3 条 restore 路径（重复的语义暴露）
     - **✨ 前所未记 route 首入档 §L16**：`POST /v1/runs/:id/verification` — 附加外部计算 VerificationResult，200 pass；empty body 400；bogus runid 404；CLAUDE.md 未提及
     - **✨ 前所未记 route 首入档 §L17**：`POST /v1/runs/:id/verify` — 在 run 的 workspace 执行 `commands[]`，200 → status=`completed`；空 commands 400（**含 sibling route 提示，是 codebase 最好的错误消息之一**）；bogus runid **被 empty-commands 校验先拦，返回 400 而非 404** —— 顺序 bug
     - **✨ HEADLINE 07-16 P1 methodology 发现**：**"22 天 fingerprint 恒定" 是探测方法学 artefact**，不是算法特性。用 `POST /v1/runs/:id/verify {commands:["echo x"]}` **不需要 LLM key** 即可推动 harness health 信号 —— fingerprint `overall_score` `50 → 76`、`confidence` `0 → 0.09587831612649744`、`sample_count` `0 → 1`、`primary_focus` `task_understanding → capability_invocation`、`actions` `[5 keys] → [tune_tools_and_subagents, fill_signal_gaps]`。**过去 22 报告全部漏了这条路径**，用了 stub-only pending 分布得到"锁死"的印象
     - **✨ Todo `evidence` **nested type check** 完全不存在**（07-15 P2 加深）：PATCH `evidence:{run_id:123, exit_code:"str", stderr_excerpt:[1,2], unknown:{deep:true}}` 全 200 accept，nested field types 全无校验；`as RequirementTodoEvidence` 编译期 assertion **对 nested 字段类型零覆盖**
     - **✨ POST /v1/requirements/:id/activities = 404**（route 不存在）；grep 源码 `:559-570` 只有 GET，无 POST；activities 是 **side-effect-only**（approve/reject/status-change/todo-create/reviewer-dispatch 触发）；文档未说明
     - **✨ PATCH `label_ids` 错误消息 = `lid.trim is not a function`**（07-15 §L1 leftover 落地；不同于 POST 的 `id.trim`），变量名微差异证明源码是两份独立 `.filter` 而非共用 helper
     - **✨ `POST /v1/requirements/:id/todos {depends_on:[42,null,true,"<uuid>"]}` = 200 filter-out**（POST 侧同 PATCH `:633` 修复模板）—— 07-15 §9 leftover 落地
     - **✨ PATCH Todo `depends_on:[]` = 清空**（200 accept，前 `[uuid]` 后 `[]`）—— 07-15 §9 leftover 落地
     - **✨ archived-project child 的 POST /:id/runs = 201 pending**（新 governance 漏洞，从 07-15 §L9 "CRUD 通道全开" 扩至 "run lifecycle 也全开"）
     - **✨ archived-project child 的 approve = 200 no_op**、**reject = 200 rejected+deleted**（child 的 approve/reject 完全不受 parent archive 影响）
     - **✨ approve/reject 上 requirement 找不到时 HTTP 都 = 404**（07-15 未记 HTTP status；今天补齐）
     - **✨ `POST /v1/workflows` `project_id=<archived-pid>` = 201 accept**（workflow 层无 FK 也无 archive-gate，与 requirement §3.6 orphan 通道同源）
- **运行约束**：与 07-15 一致 —— `JARVIS_WORK_MODE=off`、stub LLM key、`JARVIS_PERMISSION_MODE=bypass`；DB 用日期后缀 `-20260716` 全新路径。**跳过 DDNS + Memory side-branch**（源码级 7 天持平）

---

## 0. TL;DR — 与 07-15 的差异（1 天间隔）

| 项 | 07-15 状态 | 07-16 状态 | 变化 |
| --- | --- | --- | --- |
| `git log --since=2026-07-15` | 0 commit | **0 commit**（HEAD 仍 `64d288a`） | 静默**第 23 天** |
| 工作树未 commit 文件数 | 39 | **39** | 持平 |
| 522 条 `@jarvis/server` 单测 | 522/522 ✅（7537 ms） | **522/522 ✅**（7628 ms） | 持平（+91 ms 噪声） |
| Servlet 工作目录 | 24h 幸存 | **48h 幸存**（07-14 03:06 时间戳全在） | 持平 |
| P1-A POST + PATCH 4 字段透传 | 全双向静默丢字段 | **全双向静默丢字段** | ❌ 未修（第 19 次） |
| P1-B `POST /v1/roadmap/import` | 404 | **404** | ❌ 未修（第 19 次） |
| P1-C `GET /v1/requirements/:id` | 404 | **404** | ❌ 未修（第 19 次） |
| `GET /:id/conversations` 404 | 复现 | **完全复现** | ❌ 未修（第 6 次） |
| Orphan 行 `POST /v1/projects/no-such/requirements` | 201 | **完全复现** | ❌ 未修（第 19 次） |
| `depends_on` POST bogus FK UUID | 通过 | **完全复现** | ❌ 未修（第 15 次） |
| `depends_on:[<non-string>]` → 500 TypeError | 复现 | **完全复现** | ❌ 未修（第 3 天） |
| Manual PATCH `status:"done"` bypass depends_on | 复现（第 7 天） | **完全复现**（第 8 天） | ❌ 未修（第 8 天） |
| `RequirementStatus` 4 值 evidence | 恒定 | **恒定** | 持平 |
| Todo `evidence` type-assertion 失效 (P2 07-15) | 首入档 | **完全复现 + nested 覆盖**（`{run_id:int, exit_code:str, stderr_excerpt:array, unknown:{deep:bool}}` 全 200 pass） | ❌ 07-15 P2 深化 |
| `label_ids:[<non-string>]` POST 500 | 07-15 首入档 | **完全复现 + PATCH 侧 500 msg `lid.trim is not a function` 落地** | ❌ 未修（第 2 天）+ 加固 |
| DELETE Requirement idempotence | hard-delete-with-flag | **完全复现** | 持平 |
| DELETE Project = soft-archive | 复现 | **完全复现** + `POST /:id/restore` 存在 | ⚠️ **07-15 §L8 CORRECTION** |
| DELETE Project 无 cascade | 复现 | **完全复现** + `POST /:id/runs` 也不受 archive 阻挡 | ⚠️ **07-15 §L9 深化到 run lifecycle** |
| `GET /v1/projects` 隐藏 archived | 07-15 首入档 | **完全复现** + `?include_archived=true` filter 实际存在 | ⚠️ **07-15 §L10 CORRECTION** |
| `/v1/health` 404 vs `/health` 200 | 未修 | **未修** | ❌ 未修（第 11 次） |
| `server/info` 顶层 16 keys | 复现 | **完全复现**（`tool_count=44`；`mcp_servers=[]`；`memory.mode=window budget_tokens=108000`） | ❌ 未修（第 11 次） |
| `confidence < 0.2` 前端兜底 | P0, 22 天未修 | **P0, 23 天未修** | 持平 |
| **HEADLINE**: Fingerprint sample=0 恒定 vs `/verify` 推动 | 22 天 "恒定" | **✨ 07-16 打破**：clean sample=0 verbatim 恒定（overall=50, conf=0, primary=task_understanding, actions=5）；跑一次 `/verify {commands:["echo x"]}` → `overall=76, conf=0.09587831612649744, sample=1, primary=capability_invocation, actions=[tune_tools_and_subagents, fill_signal_gaps]`。**LLM-free 推动 harness health** | ⚠️ **07-16 methodology 首入档** |
| **✨ 07-16 NEW route**: `POST /v1/runs/:id/verification` | 未入档 | **07-16 首入档**：附加外部计算 result；empty=400 `body must be a VerificationResult`；有 body=200 附着；bogus runid=404 | ⚠️ 07-16 首入档 |
| **✨ 07-16 NEW route**: `POST /v1/runs/:id/verify` | 未入档 | **07-16 首入档**：执行 commands；空=400（含 sibling route 提示）；1st `commands:["echo ok"]`=200 status→completed；2nd=200 再跑（idempotent-execute）；**bogus runid 被 empty-commands 校验先拦，返 400 而非 404**（顺序 bug） | ⚠️ 07-16 首入档 + 1 顺序 bug |
| **✨ 07-16 NEW route**: `POST /v1/projects/:id/restore` | 07-15 声明不存在 | **07-16 CORRECTION**：`projects-routes.ts:408` 存在；1st→200；2nd→200 (universal no-op)；on non-archived→200 no-op；bogus pid→404 | ⚠️ **07-15 §L8 CORRECTION** |
| **✨ 07-16 NEW route**: `POST /v1/requirements/:id/activities` | 未入档 | **07-16 首入档**：404 route not found；activities 只有 GET，是 side-effect-only（approve/reject/status/todo/reviewer 写入） | ⚠️ 07-16 首入档 |
| **✨ 07-16 NEW leaf**: `POST /v1/workflows body.project_id=<archived-pid>` | 未测 | **201 accept**（workflow 无 FK + 无 archive-gate，与 requirement §3.6 同源） | ⚠️ 07-16 首入档 |

代码侧标记的精确行号仍在原位（今天 grep 三次确认）：

- `packages/server/src/requirements-routes.ts:164-165` "verification_plan / workflow_id ... out of scope for this port" 注释
- `packages/server/src/requirements-routes.ts:231, :296` `body.depends_on.filter((d) => d.trim() !== "")` + `:239, :304` `body.label_ids.filter((id) => id.trim() !== "")` —— **4 处同 bug**；正确修复模板存在于 `:633` (`typeof x === "string"` 前置 filter) 和 `:734`
- `packages/server/src/requirements-routes.ts:729-731` `as RequirementTodoEvidence` type-assertion —— nested-field 类型也全无校验（07-16 §L11 深化）
- `packages/tools/src/register-builtins.ts:13` "未移植清单" 注释含 `roadmap.import`
- `packages/server/src/workflow-routes.ts:156` `normalizeSteps(body.steps ?? [])` —— 今天未跑完整 workflow probe（源码未变 → 效果同 07-14）
- `packages/ddns/src/runtime.ts:168` `#running` early-return —— 源码级第 7 天持平（跳过 side-branch）
- `packages/server/src/requirements-routes.ts:799-816` `POST /v1/runs/:id/verification` route（07-16 首次实测；`body.status` string 校验 + bogus runid 404）
- `packages/server/src/requirements-routes.ts:817-857` `POST /v1/runs/:id/verify` route（07-16 首次实测；`commands` 非空 array 校验 + `resolveRunWorkspace` + `executePlan` 执行）
- `packages/server/src/projects-routes.ts:249-253` `include_archived` filter 实际生效（07-15 §L10 CORRECTION）
- `packages/server/src/projects-routes.ts:408` `POST /:id/restore` route 存在（07-15 §L8 CORRECTION）
- `packages/server/src/projects-routes.ts:285-334` PUT `archived:false` 走 restore 分支（第 3 条 restore 路径）

---

## 1. 测试配置

```
OPENAI_API_KEY=sk-stub-for-automation-test
JARVIS_PROVIDER=openai
JARVIS_MODEL=gpt-4o-mini
JARVIS_FS_ROOT=/tmp/jarvis-servlet-test
JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-20260716
JARVIS_ADDR=127.0.0.1:7099
JARVIS_WORK_MODE=off
JARVIS_PERMISSION_MODE=bypass
JARVIS_NO_PROJECT_CONTEXT=1
```

启动日志：
```
[jarvis] persistence connected: json:///tmp/jarvis-servlet-test-db-20260716
[jarvis] serve: provider=openai model=gpt-4o-mini addr=127.0.0.1:7099 fsRoot=/tmp/jarvis-servlet-test coding=false auth=none ddns=off mdns=off promptBytes=263
[jarvis] listening on http://127.0.0.1:7099
```

**Servlet fixture 48h 幸存**（07-14 03:06 时间戳未变；无操作）：
```
/tmp/jarvis-servlet-test/
├── pom.xml                                       # 07-14 03:06, 627 bytes
├── README.md                                     # 07-14 03:06, 140 bytes
└── src/main/
    ├── java/com/example/HelloServlet.java        # 07-14 03:06, 754 bytes
    └── webapp/WEB-INF/web.xml                    # 07-14 03:06, 162 bytes
```

**本轮跳过**：DDNS + Memory + AccessToken side-branch（07-14 详细覆盖，源码级 7 天持平）。

---

## 2. 主 Kanban 主线（stub 模式）

```
1) POST /v1/projects  {name:"servlet-2026-07-16", instructions:"servlet automation probe 07-16 (day 23)"}
   → 201 pid=b85dd338-6225-476a-8f9c-0435b1485689；slug 自动 "servlet-2026-07-16"
2) POST /v1/projects/<pid>/requirements
   {title:"probe-4fields-07-16","description":"t","triage_state":"approved", + 4 extra fields}
   → 201 rid=97959423-08e4-4d28-a1b6-7aa7d9a5acb2
     响应 keys=[conversation_ids, created_at, description, id, project_id, status, title, updated_at] **8 keys**
     4 extra fields (acceptance_policy/workflow_id/assignee_id/verification_plan) **全不出现**
3) PATCH /v1/requirements/<rid>
   4 extra fields (acceptance_policy:"Subagent",workflow_id:"22222222-...", assignee_id:"user-y", verification_plan:{...})
   → 200 same 8 keys；4 fields 全 drop
```

---

## 3. 回归探针（P1 gaps 未修复第 19 次）

### §3.1 P1-A：POST 上 4 字段静默丢

```
BODY = {"title":"probe-4fields-07-16","description":"t","triage_state":"approved",
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
POST /v1/projects/no-such-project-07-16/requirements {"title":"orphan-07-16"}
→ 201 id=a54880e1-... project_id="no-such-project-07-16"  ← 原样写盘
```

### §3.7 `depends_on` POST bogus UUID 通过

```
POST body {"title":"probe-deps-bogus-07-16","depends_on":["00000000-0000-0000-0000-000000000000"]}
→ 201 accept；response.depends_on = ["00000000-..."]
```

### §3.8 Manual PATCH `status:"done"` bypass `depends_on` gate

```
PATCH /v1/requirements/<child_w_bogus_dep> {"status":"done"}
→ 200 {status:"done", depends_on:["00000000-…"], …}   ← gate 完全绕过
```

（第 8 天未修）

### §3.9 `/v1/health` vs `/health` 分裂

```
GET /health → 200 {"status":"ok"}
GET /v1/health → 404
```

（第 11 天未修）

### §3.10 `server/info` 顶层 16 keys（未变）

```
['approval_mode', 'coding_mode', 'config_path', 'listen_addr', 'max_iterations', 'mcp_servers',
 'memory', 'persistence', 'project_context', 'project_store', 'providers', 'system_prompt',
 'tool_count', 'tools', 'version', 'workspace_root']
tool_count = 44；mcp_servers = []；memory = {mode:"window", budget_tokens:108000}
```

---

## 4. 07-15 未验证项 6 条 + 07-16 新发现全落地

### §L1: PATCH `label_ids:[<non-string>]` 500（07-15 §9 leftover 落地）

```
PATCH /v1/requirements/<rid> {"label_ids":[42]}   → 500 "lid.trim is not a function"
PATCH /v1/requirements/<rid> {"label_ids":[null]} → 500 "Cannot read properties of null (reading 'trim')"
```

**规律**：PATCH 变量名 `lid`（不同于 POST 侧 `id`）—— 证明 `:239 POST` 与 `:304 PATCH` 是**两份独立 filter 代码**，非共用 helper。修 4 站点必须全动。

### §L2: POST Todo `depends_on:[<non-string>]` = 200 filter-out（07-15 §9 leftover 落地）

```
POST /v1/requirements/<rid>/todos {"title":"t-post-depsnonstr","kind":"work",
  "depends_on":[42,null,true,"11111111-1111-1111-1111-111111111111"]}
→ 201 response.todo.depends_on = ["11111111-1111-1111-1111-111111111111"]
```

**结论**：POST-side 也用 `typeof` 前置 filter（对应 `:601-635`），与 PATCH-side `:693-745` 对齐。**Todo path 两侧一致**，Requirement path 4 站点全需迁移。

### §L3: PATCH Todo `depends_on:[]` = 清空（07-15 §9 leftover 落地）

```
先 PATCH depends_on:["aaaaaaaa-..."] → 200 deps=["aaaaaaaa-..."]
再 PATCH depends_on:[]                → 200 deps=[]
```

**结论**：`if (body.depends_on !== undefined)` 分支执行；`[]` 会真正清空数组。**Todo undefined-vs-empty-array 分双态**（Requirement 侧未测同分支，07-17 补）。

### §L4: Todo `evidence` **nested-field 类型全无校验**（07-15 §L3 深化）

```
PATCH /v1/requirements/<rid>/todos/<tid> {"evidence":{
  "run_id":123,            ← 应 string，实际 int accept
  "exit_code":"str",       ← 应 int，实际 str accept
  "stderr_excerpt":[1,2],  ← 应 string，实际 array accept
  "unknown":{"deep":true}  ← 应无此 key，实际 accept
}}
→ 200 response.todo.evidence = {run_id:123, exit_code:"str", stderr_excerpt:[1,2], unknown:{deep:true}}
```

**结论**：源码 `:729-731` `as RequirementTodoEvidence` 编译期 assertion **对 nested field 的类型也零覆盖**。前端读 `evidence.exit_code` 若期待 int 会崩；`evidence.run_id` 若期待 string 拼 URL 会拼出 `.../runs/123` 而非 UUID。**Rust 侧 serde 的 nested 结构校验丢失更彻底**。

**修**：需要一个真正的 runtime schema validator（Zod / ajv / Fastify JSON Schema）取代 `as` 类型断言。

### §L5: archived-project child 的 `POST /:id/runs` = 201 pending（07-15 §L9 深化）

```
PARC_ID = create + archive project
CHILD_RID = POST /v1/projects/<PARC_ID>/requirements ... (before archive)
POST /v1/requirements/<CHILD_RID>/runs {} → 201
  run.id=..., status=pending, conversation_id 自动 mint
```

**结论**：archive parent 后，child 的**整个 run lifecycle**（create/read/verify）**全部畅通**。07-15 §L9 记 "CRUD 通道全开" 只覆盖 CRUD；今天扩至 run + verification + activity（后者 route 不存在，但 side-effect 通道畅通）+ `POST /:id/conversations`。

### §L6: DELETE `/v1/requirements/<child_of_archived>` = 一次 200 二次 404（07-15 §9 leftover 落地）

```
DELETE /v1/requirements/<CHILD_RID>       → 200 {"deleted":true}
DELETE /v1/requirements/<CHILD_RID again> → 404 {"deleted":false,"error":"requirement ` ...` not found"}
```

**结论**：archived-parent 上下文对 child DELETE **零影响**；语义与非-archived child 同 §L7 07-15 hard-delete-with-flag。

---

## 5. 07-16 新发现深挖

### §L7: `POST /v1/projects/:id/restore` route 存在（**07-15 §L8 CORRECTION**）

```
PA = create + archive
POST /v1/projects/<PA>/restore   → 200 {archived:false, ...}     ← 复位成功
POST /v1/projects/<PA>/restore   → 200 (universal no-op，2nd call)
POST /v1/projects/<FRESH>/restore → 200 (non-archived 无变化 no-op)
POST /v1/projects/no-such-pid/restore → 404 {"error":"project not found"}
```

**新 idempotence 风格**：**select-then-noop** —— bogus 404 vs valid+任何-state 200（不管 archived / active）。

**与 07-15 §L15 5-way idempotence style 汇总扩至 6-way**：
| verb / route | 幂等风格 |
| --- | --- |
| DELETE /v1/memory/includes | universal 200 no-op（任意 target） |
| POST /v1/workflow-runs/:id/cancel | select-then-cancel（bogus 404 / pending 200 / cancelled 200 no-op） |
| DELETE /v1/requirements/:id | hard-delete-with-flag（1st 200 / 2nd 404 body `deleted:false`） |
| DELETE /v1/projects/:id | soft-archive-with-universal-noop（1st + 2nd 都 200 archived:true / bogus 404） |
| PATCH /v1/requirements/:id/todos (batch) | atomic all-or-nothing（bogus 404 无副作用） |
| **07-16 加**：POST /v1/projects/:id/restore | **select-then-noop**（bogus 404 / valid+任何-state 200 no-op） |

### §L8: `GET /v1/projects?include_archived=true` filter 实际生效（**07-15 §L10 CORRECTION**）

```
本轮共创建 6 个 project + archive 4 个后：
GET /v1/projects                        → 1 个（默认 active-only）
GET /v1/projects?include_archived=true  → 5 个（返 active + archived）  ← ✅ filter 生效
GET /v1/projects?archived=true          → 1 个（filter ignored）
GET /v1/projects?archived=all           → 1 个（filter ignored）
GET /v1/projects?include_archived=1     → 5 个（`asBool` 也 accept 1/0/true/false）
```

**源码印证**：`packages/server/src/projects-routes.ts:249-253`：
```ts
const query = req.query as { limit?: string; include_archived?: string };
const includeArchived = asBool(query.include_archived);
const rows = await store.list(includeArchived, limit);
```

**结论**：07-15 §L10 "archived project 无 REST 侧访问路径" **是错误结论**；实际有两条路径：
1. `GET /v1/projects?include_archived=true` — list 视图（新入档）
2. `GET /v1/projects/:id` — 单行视图（07-16 §L9 首入档）

### §L9: `GET /v1/projects/:archived-id` 单行 GET 返 archived project（**07-15 §L10 补强**）

```
PAID = archived project id
GET /v1/projects/<PAID> → 200 {..., archived:true, name:"arch-approve-07-16"}
```

**结论**：单行 GET **永远返 project**（无论 archived）；有 `archived:true` flag；client 可以主动检查。前端 "回收站" 视图**可以从 单行 GET + list `?include_archived=true` filter 组合搭出**，无需新 route。

### §L10: `PUT /v1/projects/:id {"archived":false}` = 第 3 条 restore 路径

```
PA2 = create + archive
PUT /v1/projects/<PA2> {"archived":false} → 200 {archived:false}
```

**结论**：三条 restore 路径都可用：
1. `POST /:id/restore`（§L7）
2. `PUT /:id {"archived":false}`（§L10）
3. `PATCH /:id {"archived":false}` — 未直接测，但源码 PUT 与 PATCH 共享 update-body handler，等价预期

**语义 debt**：三条路径全过一个 update-project handler；`POST /:id/restore` 是 "语义 alias" 而非独立分支。CLAUDE.md 未说明 restore 有 3 条路径。

### §L11: `POST /v1/runs/:id/verification` — 附加外部计算 result（**未入档 route 首入档**）

```
POST /v1/runs/<runid>/verification {}                  → 400 {"error":"body must be a VerificationResult"}
POST /v1/runs/<runid>/verification {"status":"pass","summary":"..."}
                                                        → 200 { ...full run object..., "verification":{"status":"pass","summary":"..."}}
POST /v1/runs/bogus-runid-07-16/verification {"status":"pass"}
                                                        → 404 {"error":"run `bogus-runid-07-16` not found"}
```

**源码位置**：`packages/server/src/requirements-routes.ts:799-816`；CLAUDE.md 完全未提。

**校验**：`typeof result.status !== "string"` → 400；**只校验 status 是 string，不校验 enum 值**（`status:"bogus-value"` 未测；07-17 补）。runid 是 UUID 格式非-强制（bogus 是 "bogus-runid-07-16" 也走 store.get → not-found → 404）。

### §L12: `POST /v1/runs/:id/verify` — 执行 commands（**未入档 route 首入档 + 顺序 bug**）

```
POST /v1/runs/<runid>/verify {}                          → 400 "`commands` must not be empty; POST /verification to attach a result without running anything"
POST /v1/runs/<runid>/verify {"commands":["echo ok-07-16"]}
                                                          → 200 run object, status=completed
POST /v1/runs/<same runid>/verify {"commands":["echo second"]}
                                                          → 200 (idempotent-execute; 覆盖前 verification)
POST /v1/runs/bogus-verify-07-16/verify {}               → 400 (**顺序 bug**: 应该 404，但被 empty-commands 校验先拦)
```

**源码位置**：`packages/server/src/requirements-routes.ts:817-857`；CLAUDE.md 完全未提。

**顺序 bug 定位**：`:824-833` 先做 `Array.isArray(body.commands)` filter + 非空校验，`:836` 才做 `runStore.get(id)`。bogus runid + 空 body → 400 而非 404，客户端无法判断 run 是否存在（须先跑 GET /v1/runs/:id）。**修 5 行**：把 runStore.get 提到 commands 校验之前。

**优点**：empty-commands 错误消息 **`;POST /verification to attach a result without running anything`** 是 codebase 里**最佳的错误消息之一**，主动指向 sibling route。

### §L13: **HEADLINE**: Fingerprint 22 天 "恒定" 是探测方法学 artefact

**Clean sample=0** (verbatim 恒定第 23 天)：
```
overall_score=50, confidence=0, sample_count=0, primary_focus=task_understanding
actions=['stabilize_delivery_gate', 'reduce_timeout_and_iteration_failures', 'tune_tools_and_subagents',
        'sharpen_task_acceptance', 'fill_signal_gaps']
```

**跑一次 `/verify {commands:["echo hello"]}` 后**（**LLM-free**）：
```
overall_score=76 (↑26),  confidence=0.09587831612649744 (↑from 0),  sample_count=1,
primary_focus=capability_invocation (from task_understanding),
actions=['tune_tools_and_subagents', 'fill_signal_gaps']  ← 从 5 keys 减到 2 keys
signals.tool_success_rate  = null
signals.verification_pass_rate = 1     ← 从 null → 1
signals.observed_runs      = 0         ← 观察源不同，仍 0
signals.completion_rate    = 1         ← 从 null → 1
```

**结论**：
- 过去 22 天 "fingerprint 恒定" 是因为**从未跑过 `/verify` / `/verification`**，全程 pending run 分布 → 算法输入不变 → fingerprint 不动
- **今天证明：LLM-free 也能推动 harness health**（`/verify {commands:["echo x"]}` 就够）
- 单个 `/verify pass` → 3 个 dim.confidence 上移 → `primary_focus` 切到 capability_invocation → actions 从 5 精简到 2 → **algo 完全响应**
- **methodology 收获**：往后的 automation probe 应该**分两模式跑**：(a) "pending-only" 校验 sample=0 baseline 恒定；(b) "verify-driven" 校验 algo 响应曲线
- **07-16 之后 fingerprint sample=N 表也需要重建**：过去 sample=1..4 的 confidence 都是 pending-only 场景下的，加上 completion_rate=1 / verification_pass_rate=1 会**不同**

**新问题**：能否用 `/verify` 反复推 sample_count？连跑 10 次 verify → sample_count 应该 →10；07-17 补 sample=10 fingerprint table。

### §L14: `POST /v1/requirements/:id/activities` = 404（route 不存在）

```
POST /v1/requirements/<CHILD_RID>/activities {"kind":"comment","body":{"note":"..."}}
→ 404 {"message":"Route POST:/v1/requirements/<rid>/activities not found",...}
```

**源码印证**：`:559-570` 只注册了 GET，无 POST。Activities 是 **side-effect-only**：
- approve → Activity {kind:"comment", body:{kind:"requirement_approved"}}
- reject → Activity {kind:"comment", body:{kind:"requirement_rejected"}}
- status change → Activity {kind:"status_change"}
- todo create → Activity {kind:"comment", body:{kind:"requirement_todo_created"}}
- batch todo update → Activity {kind:"comment", body:{kind:"requirement_todos_batch_updated"}}
- reviewer manual dispatch → Activity {kind:"comment", body:{kind:"reviewer_dispatched_manually"}}
- verify/verification success → Activity {kind:"comment", body:{kind:"verification_attached"}}（未确认，07-17 补）
- run created → run.logs (**不是 activity**)

**结论**：客户端**不能主动写 activity**，只能通过其他 route 侧-effect 触发。CLAUDE.md 未明写这条 "Activity is side-effect-only" 语义。若要写自由格式 comment，需要新建 POST route。

### §L15: `POST /v1/workflows body.project_id=<archived-pid>` = 201 accept

```
POST /v1/workflows {"name":"wf-arch-07-16","project_id":"<archived-pid>",
                    "steps":[{"name":"s1","kind":{"type":"agent","prompt":"echo"}}]}
→ 201 workflow object with project_id="<archived-pid>"
```

**结论**：workflow 层同 requirement §3.6 orphan project_id 同 bug 源。`POST /v1/projects/:archived-pid/requirements` 已知 201 accept，今天证 workflow 也 201 accept。**Governance 漏洞第 5 条**：
1. 07-15 §L9 archived-project 上 POST /:id/requirements 全开
2. 07-16 §L5 archived-project child 的 /:id/runs 全开
3. 07-16 §L11 archived-project child 的 /:id/verification 全开
4. 07-16 §L12 archived-project child 的 /:id/verify 全开
5. **07-16 §L15 workflow 层的 project_id FK 也全无检查**

### §L16: approve/reject 上 requirement 找不到时 HTTP=404（07-15 补齐）

```
POST /v1/requirements/00000000-0000-0000-0000-999999999999/approve  → 404 {"error":"requirement ` ...` not found"}
POST /v1/requirements/00000000-0000-0000-0000-999999999999/reject {"reason":"x"} → 404 {"error":"requirement ` ...` not found"}
```

**结论**：approve **不再** 是 "on bogus, 200 no_op"；on bogus rid **确实 404**。**07-15 表达有误**：memory 中 "approve is idempotent-no_op vs reject 404" 是关于 `triage_state` 已 approved（幂等）vs reject 已删（404）。今天证明 **bogus id 上两者都 404**，一致。

### §L17: archived-project child 的 approve/reject 完全不受 parent archive 影响

```
CHILD = child of archived project
POST /v1/requirements/<CHILD>/approve → 200 {approved:true, no_op:true} (triage_state 默认已 approved)
POST /v1/requirements/<CHILD>/reject {"reason":"x"} → 200 {rejected:true, deleted:true, reason:"x"}
```

**结论**：child 的 approve/reject **完全不受 parent archive 影响**（governance 漏洞第 6 条），跟 §L5 run lifecycle 平行。

### §L18: 批量 Todo PATCH atomic edge cases 加固

```
PATCH /v1/requirements/<rid>/todos {"ids":[],"status":"pending"}
                                    → 400 "`ids` must be a non-empty array"
PATCH ...  {"ids":["00000000-0000-0000-0000-999999999999"],"status":"pending"}
                                    → 404 "todo ` ...` not found"（atomic：其他 real ids 不受影响）
PATCH ... {"ids":["<real-tid>"],"status":""}
                                    → 400 "unknown todo status ``"
```

**结论**：batch atomic 语义**验证第 3 次持平**；empty-status 走 `unknown todo status` 报错（不 trim，`""` 原样 echo）；empty-ids 走 non-empty-array 报错。

---

## 6. 未修复清单（P0/P1/P2 累积到第 23 天）

**P0**（前端 1 行 5 分钟）：
- confidence < 0.2 前端兜底（读 `actions.find(a=>a.key==="fill_signal_gaps") && sample_count<5`）— **23 天未修**

**P1**（REST 层缺 route / FK / 字段透传 / 类型校验 / 顺序 bug）：
- POST + PATCH 4 字段（`acceptance_policy` / `workflow_id` / `assignee_id` / `verification_plan`）静默丢 — 23 天未修
- `POST /v1/roadmap/import` 404 — 23 天未修
- `GET /v1/requirements/:id` 404 — 23 天未修
- `GET /v1/requirements/:id/conversations` 404 — 8 天未修
- orphan project_id 无 FK — 23 天未修（延伸到 archived project pid + workflow project_id / run lifecycle / verification lifecycle → **governance 漏洞 6 条**）
- depends_on / label_ids **5 处**同源 FK / typeof — 19 天未修（**07-16 补 PATCH label_ids 500 msg 变量名 `lid.trim`**）
- `depends_on` / `label_ids` 非-string → 500 raw TypeError 泄漏 — 3 天未修
- `POST /:id/conversations` conversation_id 无格式 + 无 FK — 7 天未修
- `POST /v1/workflows` 500 泄漏 10 shape — 13 天未修（跳过复测）
- `DELETE /v1/ddns/config` 未注册 route — 11 天未修（跳过）
- Manual PATCH `status:"done"` bypass depends_on gate — 8 天未修
- DDNS runtime `#running` 泄漏 stale `last_result` — 7 天源码级持平（跳过）
- DELETE Project 无 cascade — 3 天未修（**07-16 §L5 扩至 run + /:id/verification / /:id/verify lifecycle 全开**）
- **07-16 首入档**：`POST /v1/runs/:id/verify` bogus runid **被 empty-commands 校验先拦返 400 而非 404**（顺序 bug；`:824-833` 应移到 `runStore.get(id)` 之后）

**P2**（一致性 / 语义 / 文档缺）：
- list shape 五分裂 — 19 天未修
- `/v1/health` 404 vs `/health` 200 — 11 天未修
- `server/info` 不反映 `ddns/memory_enabled/mdns/access_token_configured/features` — 11 天未修
- depends_on 条件性写回 shape drift — 15 天未修
- `depends_on` 空串/whitespace-only 静默 strip + 重复 UUID 不 dedup — 3 天未修
- DDNS PUT 累计 10 处 soft-accept — 23 天未修（跳过）
- `POST /v1/ddns/upnp/test` body 静默无效 — 7 天未修
- `POST /v1/ddns/update` 200 wrap `last_result:{ok:false}` 语义文档缺 — 5 天未修
- `/start` `/block` `/complete` 是 agent tools 而非 REST — 7 天未修
- Todo `status` / `kind` / `created_by` 枚举与 Requirement 完全不同 — 6 天未修
- Todo evidence type-assertion 完全失效 + **07-16 补 nested field 类型也全无校验** — 2 天未修 + 加固
- Todo `command:""` 与 `command:null` 同 = DELETE — 3 天未修
- Todo POST/PATCH response envelope `{todo, requirement}` 双 view — 3 天未修
- Activity `body.kind` inner-classifier convention — 10 天未修
- UUID 格式校验非一致 — 10 天未修
- REST 幂等 style 累计 **6 种**（**07-16 加 select-then-noop for POST /:id/restore**）— 8 天累加中
- Todo sub-resource 五 route 五种 envelope shape — 8 天未修
- `GET /v1/remote/info.external` 三-shape 分裂 — 8 天未修
- `/v1/remote/pairing.token` = 明文 access token — 8 天未修
- `DELETE /v1/projects/:id` 与 `DELETE /v1/requirements/:id` 同名 verb 完全不同语义 — 2 天未修
- **07-16 首入档**：**`GET /v1/projects?include_archived=true` filter 存在**（07-15 §L10 CORRECTION）—— CLAUDE.md 未提；除 `include_archived` 外其他 alias `?archived=true/all` 全 ignored
- **07-16 首入档**：`POST /v1/projects/:id/restore` route 存在（07-15 §L8 CORRECTION）—— CLAUDE.md 未提；语义 alias 有 3 条路径（`POST /:id/restore` / `PUT /:id {archived:false}` / `PATCH /:id {archived:false}`）
- **07-16 首入档**：`POST /v1/runs/:id/verification` route 存在 —— CLAUDE.md 未提；只 accept `body.status` string，无 enum 校验
- **07-16 首入档**：`POST /v1/runs/:id/verify` route 存在 —— CLAUDE.md 未提
- **07-16 首入档 P0 methodology**：过去 22 报告 "fingerprint 恒定" 是探测方法学 artefact，非算法特性；`/verify {commands:[...]}` 是 **LLM-free 推动 harness health 的路径**；memoized sample=1..4 confidence 曲线是**只在 pending-only 场景下** valid（07-16 §L13）
- **07-16 首入档**：`POST /v1/requirements/:id/activities` = 404，Activity 是 side-effect-only —— CLAUDE.md 未明写此语义
- **07-16 首入档**：`POST /v1/workflows body.project_id=<archived-pid>` = 201 accept；workflow 层 project FK 也无检查

---

## 7. 07-16 首次发现清单（净新增）

1. **✨ 07-15 §L8 CORRECTION**：`POST /v1/projects/:id/restore` **route 存在**（`projects-routes.ts:408`）；07-15 声明 "restore 只能通过底层 store 手改" 错误
2. **✨ 07-15 §L10 CORRECTION**：`GET /v1/projects?include_archived=true` **filter 实际生效**（`projects-routes.ts:249-253`）；07-15 声明 "无 filter 参数可查 archived" 错误
3. **✨ §L10**：`PUT /v1/projects/:id {"archived":false}` = 第 3 条 restore 路径（三条 restore 路径共存）
4. **✨ §L11**：`POST /v1/runs/:id/verification` 首入档 —— 附加外部计算 result；body.status string 校验，bogus runid 404
5. **✨ §L12**：`POST /v1/runs/:id/verify` 首入档 —— 执行 commands 在 run's workspace；空 400（含 sibling route 提示）；**bogus runid 顺序 bug**（被 empty-commands 校验先拦返 400 而非 404）
6. **✨ §L13 HEADLINE methodology 发现**：22 天 "fingerprint 恒定" 是探测方法学 artefact；`/verify {commands:["echo x"]}` **LLM-free** 推动 harness health（`overall=50 → 76, confidence=0 → 0.096, sample=0 → 1, primary_focus 切换, actions 5→2`）—— **过去 22 报告全漏了这条路径**
7. **✨ §L4**：Todo `evidence` **nested-field 类型全无校验**（07-15 P2 深化）—— `{run_id:int, exit_code:str, stderr_excerpt:array, unknown:{deep:bool}}` 全 accept
8. **✨ §L14**：`POST /v1/requirements/:id/activities` = 404；Activity 是 side-effect-only（GET 存在，POST 不存在）—— CLAUDE.md 未明写
9. **✨ §L15**：`POST /v1/workflows body.project_id=<archived-pid>` = 201 accept（governance 漏洞第 5 条）
10. **✨ §L7 idempotence style 6-way**：`POST /v1/projects/:id/restore` = **select-then-noop**（bogus 404 / valid+任何-state 200 no-op）—— 与 workflow-run cancel 的 3-state 略不同
11. **✨ §L9**：`GET /v1/projects/:archived-id` 单行 GET 返 archived project 含 `archived:true` flag —— 前端"回收站"可无 API 变动地搭出
12. **✨ §L1 PATCH msg diff**：PATCH `label_ids:[42]` 报错 msg = `lid.trim`（POST 是 `id.trim`）—— 变量名微差异证明 4 处 `.filter` 是**独立代码**，非共用 helper
13. **✨ §L2 POST-side Todo depends_on filter 工作**：与 PATCH-side 一致 → Todo path 两侧一致，Requirement path 4 站点全需迁
14. **✨ §L3 PATCH Todo depends_on:[] = 清空**：`if (body.depends_on !== undefined)` 分支执行；`[]` 真正清空
15. **✨ §L5**：archived-project child 的 `POST /:id/runs` 201 pending（governance 漏洞扩至 run lifecycle）
16. **✨ §L17**：archived-project child 的 approve/reject 完全不受影响（governance 漏洞第 6 条）
17. **✨ §L16**：approve/reject bogus rid = 404 一致（memory 中 "approve idempotent-no_op vs reject 404" 是关于 `triage_state` 已 approved 幂等 vs reject 已删 404；bogus id 上两者都 404 —— 07-15 表达有误）
18. **✨ Fixture 48h 幸存**：07-14 03:06 重建的 4 文件 07-16 03:06 仍在（macOS 未清 `/tmp` 第 2 天）

---

## 8. 复现 commands 一键版

```bash
# fixture 已在
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

# HEADLINE §L13 demo: LLM-free 推动 fingerprint
curl -sS $B/v1/observability/health | python3 -c 'import sys,json;d=json.load(sys.stdin);print("BEFORE:",d["overall_score"],d["confidence"],d["primary_focus"])'
PID=$(curl -sS -XPOST $B/v1/projects -H 'Content-Type: application/json' -d '{"name":"demo","instructions":"x"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
RID=$(curl -sS -XPOST $B/v1/projects/$PID/requirements -H 'Content-Type: application/json' -d '{"title":"r"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
RUNID=$(curl -sS -XPOST $B/v1/requirements/$RID/runs -H 'Content-Type: application/json' -d '{}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["run"]["id"])')
curl -sS -XPOST $B/v1/runs/$RUNID/verify -H 'Content-Type: application/json' -d '{"commands":["echo ok"]}' > /dev/null
curl -sS $B/v1/observability/health | python3 -c 'import sys,json;d=json.load(sys.stdin);print("AFTER: ",d["overall_score"],d["confidence"],d["primary_focus"])'
# → BEFORE: 50 0 task_understanding
# → AFTER:  76 0.09587831612649744 capability_invocation

# §L7 restore route 存在
PA=$(curl -sS -XPOST $B/v1/projects -H 'Content-Type: application/json' -d '{"name":"pa","instructions":"x"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -sS -XDELETE $B/v1/projects/$PA
curl -sS -XPOST $B/v1/projects/$PA/restore   # → 200 archived:false

# §L8 include_archived filter
curl -sS "$B/v1/projects?include_archived=true" | python3 -c 'import sys,json;print("count=",len(json.load(sys.stdin)))'

# §L11/L12 verification/verify
curl -sS -XPOST $B/v1/runs/$RUNID/verification -H 'Content-Type: application/json' -d '{"status":"pass","summary":"manual"}'  # 200 attach
curl -sS -XPOST $B/v1/runs/bogus-id/verify -d '{}'  # 400 顺序 bug（应 404）

# §L4 nested evidence type
TID=$(curl -sS -XPOST $B/v1/requirements/$RID/todos -H 'Content-Type: application/json' -d '{"title":"t","kind":"work"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["todo"]["id"])')
curl -sS -XPATCH $B/v1/requirements/$RID/todos/$TID -H 'Content-Type: application/json' -d '{"evidence":{"run_id":123,"exit_code":"str","stderr_excerpt":[1,2],"unknown":{"deep":true}}}'
# → 200 evidence={"run_id":123,"exit_code":"str","stderr_excerpt":[1,2],"unknown":{"deep":true}}
```

---

## 9. 未验证项（继续滚到 07-17）

- **07-16 新留白**：
  - `PATCH /v1/projects/:id {"archived":false}` = restore（第 3 条路径的实测；今天只测了 PUT）
  - `POST /v1/runs/:id/verification` `body.status="bogus-enum"` 是否 400（今天只测 empty vs status:"pass"）
  - `POST /v1/runs/:id/verification` `body.status:"fail"` 是否也 status→completed（今天只测 pass）
  - **HEADLINE 后续**：连跑 10 次 `/verify {commands:["echo x"]}` → sample_count 是否 → 10；重建 sample=1..10 fingerprint table（today's `sample=1 confidence=0.09587831612649744`，与 memory 的 `sample=1 confidence=0.06560095313918246` 不同 —— 证明 pending-only vs verify-driven 两条曲线要独立记）
  - `PATCH /v1/requirements/:id {"depends_on":[]}` empty array 覆盖：Requirement 侧同 Todo §L3 分双态吗
  - Activity `body.kind:"verification_attached"` 是否是 `/verify` 或 `/verification` 的 side-effect（07-16 未探）
  - `POST /:id/todos` 上 `evidence:{run_id:123}` 是否也 accept（今天只测 PATCH 上 evidence nested type，POST 侧未测）
  - `POST /v1/workflows/:id/run` w/ workflow.project_id=archived-pid 是否 202 dispatch（今天只测创建，未测 run）
  - **07-14 累积（残留）**：
    - `POST /v1/ddns/update` 在**真** `token` credential 下 `record_type=A/AAAA/MX/NS/SRV` 各自 error string
    - `server/info.mcp_servers` shape（当有 MCP 时；本轮 mcp_servers=[] 恒定）
    - race condition `#running` guard 更极端场景（3-4 back-to-back PUT+POST）
- **07-15 残留（继续观察）**：DDNS PUT 累计 10 处 soft-accept 全部
- **建议下一次 investment**：
  - **PR#1**：`.filter((d) => d.trim() !== "")` → `.filter((d): d is string => typeof d === "string" && d.trim() !== "")` × 4 站点（`:231, :296, :239, :304`）—— 修 3 个 P1 same-source bug（POST/PATCH × depends_on/label_ids）
  - **PR#2**：`packages/server/src/requirements-routes.ts:729-731` `as RequirementTodoEvidence` type-assertion → Fastify JSON Schema 或 runtime Zod —— 修 P2 §L3 + 07-16 §L4 nested 校验缺
  - **PR#3**：`packages/server/src/requirements-routes.ts:817-833` `POST /v1/runs/:id/verify` bogus runid 顺序 bug —— 把 `runStore.get(id)` 提到 commands 校验之前（5 行）
  - **PR#4**：`packages/server/src/projects-routes.ts:249-253` `?include_archived=true` filter 加同名 alias（`?archived=true/all` 也 accept）—— 一致性 fix
  - **PR#5**：CLAUDE.md 加 `POST /v1/projects/:id/restore` / `POST /v1/runs/:id/{verification,verify}` 三条 route + Activity side-effect-only 语义 + `?include_archived=true` filter —— 4 处文档补齐

---

## 10. 总览

| 项 | 评分 | 与 07-15 比（1 天） |
| --- | --- | --- |
| Kanban (Project + Requirement CRUD + Todo + Activity) | ✅ 健康；`RequirementStatus` 4 值恒定；archived governance 漏洞扩至 6 条 | **07-16 深化 P1 scope** |
| Workflow CRUD + dispatch + cancel | ✅ 健康（除 §4.1 10 shape 500 泄漏；本轮跳过）；今天补 `body.project_id=archived-pid` = 201 accept | **07-16 新入档** |
| Diagnostics (`/v1/diagnostics/*` + `/v1/work/*`) | ✅ 健康 | 持平 |
| Harness.health 算法实装 | ✅ 稳定第 23 天（sample=0 verbatim 恒定；`/verify` 推动可复现） | **07-16 methodology 首入档** |
| Harness.health 信号采集 | ⚠️ pending-only 收集不到；`/verify` 是 LLM-free 推动路径 | **07-16 首入档** |
| Harness.health 前端表达 | ❌ confidence 低分仍直接展示 score | **23 天未修** |
| DDNS 后端 | ⚠️ 源码级 7 天持平；本轮跳过 side-branch | 持平 |
| Memory 后端 | ✅ 健康（跳过） | 持平 |
| REST ↔ 数据模型一致性 | ❌ depends_on / label_ids 4 站点无 typeof；Todo evidence 4 类型 + nested 全 accept；PATCH msg diff 证明 4 处独立代码 | **07-16 深化** |
| Requirement sub-resources 完整覆盖 | ✅ 07-16 补 `/verification` `/verify` `/restore` + `/activities` 404 + workflow project_id FK 缺 | **07-16 补 5 处** |
| 文档 ↔ 运行时一致性 | ❌ 4 条 route + 1 filter + Activity side-effect-only 语义 CLAUDE.md 全缺 | **07-16 揭底 5 缺口** |
| 单测覆盖 | ✅ 522/522 全绿，7628 ms | 持平（+91 ms 噪声） |
| **真 bug**：`POST /v1/workflows` 500 泄漏 | ❌ 源码未变（跳过复测） | 持平（第 13 次） |
| **真 bug**：`DELETE /v1/ddns/config` 无 handler | ❌ 未复测（跳过 side-branch） | 源码级持平 |
| **真 bug**：depends_on / label_ids 4 处 typeof 缺 | ❌ 全复现 + PATCH msg diff 加固 | **07-16 加固** |
| **真 bug**：manual PATCH `status:"done"` bypass depends_on gate | ❌ §3.8 复现 | 持平（第 8 天） |
| **真 bug**：DDNS runtime `#running` 泄漏 stale `last_result` | ⚠️ 源码 7 天持平（跳过） | 源码级持平 |
| **真 bug**：`depends_on:[<non-string>]` → 500 raw TypeError 泄漏 | ❌ 3 天未修 | 持平 |
| **真 bug**：Todo `evidence` type-assertion 完全失效 + **nested 全无校验** | ⚠️ 07-15 P2 + 07-16 §L4 深化 | **07-16 加固** |
| **真 bug**：DELETE Project 无 cascade → run/verification/verify lifecycle 全开 | ⚠️ 07-15 P1 + 07-16 §L5/§L11/§L12/§L15 4 处扩展 | **07-16 扩至 6 条 governance 漏洞** |
| **真 bug**（07-16 首入档）：`POST /v1/runs/:id/verify` bogus runid 被 empty-commands 校验先拦，返 400 而非 404 | ⚠️ **07-16 P1 首入档** | **07-16 新添** |
| **真 methodology bug**（07-16 首入档）：22 天 "fingerprint 恒定" 是探测方法学 artefact，非算法特性 | ⚠️ **07-16 P1 methodology 首入档** | **07-16 新添** |
