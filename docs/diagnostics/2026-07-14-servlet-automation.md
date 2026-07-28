# Jarvis 项目自动化能力诊断报告（2026-07-14 十七次复测）

- **运行时间**：2026-07-14（scheduled task 自动跑）
- **被测分支**：`feat/mobile-ios-ddns`（HEAD 仍为 `64d288a`，与 06-23 → 07-09 同一 commit — **静默第 21 天**；工作树侧 39 个未 commit 文件与 07-09 完全一致）
- **被测项目**：`/tmp/jarvis-servlet-test`
  - **07-14 差异**：`/tmp/jarvis-servlet-test` 整棵目录树 **不复存在**（07-09 → 07-14 五天间隔，macOS 重启清空 `/tmp` — 07-09 记的 `HelloServlet.java` 消失事件此番升级为 fixture 全清空）。本轮**重建全部 fixture**：`pom.xml` + `HelloServlet.java` + `web.xml` + `README.md`。
  - **07-09 → 07-14 五天空档**：期间 07-10 / 07-11 / 07-12 / 07-13 无 diagnostic 记录，也无 commit（相当于 scheduled task 五天连续空跑或未跑；HEAD 未动的 corroborating evidence 说明代码侧确实没人改过）。
- **本次目的**：
  1. **回归确认** 07-09 P0/P1/P2 累积项在 5 天间是否被修复（预期：未修，静默第 21 天）
  2. **07-09 未验证项 3 条落地**：
     - `PATCH /:id/todos/:tid {"evidence":null}` — clear 整个字段 还是保留空 object 还是设为 null？
     - `PATCH /:id/todos/:tid {"command":""}` — empty string 覆盖 与 delete-field 语义？
     - `POST /v1/requirements` 上 `depends_on:["not-a-uuid"]` 非-UUID 格式 —— 格式校验是否存在？
  3. **今日新发现**（07-09 未预告）：
     - **✨ P1 真 bug**：`depends_on:[<非-string>]` → **500 `d.trim is not a function`**（未 catch 的 `TypeError` + 原生 JS 错误消息泄漏）
     - **✨ Todo `evidence:{}` 空对象 vs `evidence:null` 语义不对称**：`{}` → **保留 key**（value=`{}`）；`null` → **删除 key**
     - **✨ `command:""` 与 `command:null` 同语义**：均**删除 key**；与 `title:""` → 400 blank 校验不一致
     - **✨ `depends_on` 空串/whitespace-only 静默 strip**（`""` / `"   "` / `"\t"` 全被 `.filter(d=>d.trim()!=="")` 过滤）
     - **✨ `depends_on` 重复 UUID 不 dedup**（与 07-09 batch-todo duplicate ids 同源模式）
     - **✨ Todo POST/PATCH response envelope 首入档**：`{todo:{…}, requirement:{…, triage_state:"approved", acceptance_policy:"subagent"}}` —— **requirement 内联 view 补齐了两个 POST 时没写的字段**（默认值补填），可视为**同一资源 REST 与 Todo sub-resource 视图 shape 分裂**的又一处
- **运行约束**：与 07-09 一致 —— `JARVIS_WORK_MODE=off`、stub LLM key、`JARVIS_PERMISSION_MODE=bypass`；DB 用日期后缀 `-20260714` 全新路径。**本轮跳过 DDNS + Memory + AccessToken side-branch**（源码 `packages/ddns/src/runtime.ts:161-168` `#running` guard 早退代码逐字未变 — 07-09 §4.5.6 race demo 结论 `stale last_result` bug 仍在；跳过节省 probe 时间转投主分支 5 条 leftover 落地）。

---

## 0. TL;DR — 与 07-09 的差异（5 天间隔）

| 项 | 07-09 状态 | 07-14 状态 | 变化 |
| --- | --- | --- | --- |
| `git log --since=2026-07-09` | 0 commit | **0 commit**（HEAD 仍 `64d288a`） | 静默**第 21 天** |
| 工作树未 commit 文件数 | 39 个 | **39 个** | 持平 |
| 522 条 `@jarvis/server` 单测 | 522/522 ✅（7707 ms） | **522/522 ✅**（7625 ms） | 持平（-82 ms 噪声） |
| Servlet 工作目录 | HelloServlet.java 07-08→07-09 消失（`com/example/` 空目录）；已恢复 | ⚠️ **整棵 fixture 07-09 → 07-14 消失**（`/tmp/jarvis-servlet-test` 目录不存在；macOS /tmp 五天空档清空） | ⚠️ **升级：单文件消失 → 全 fixture 消失** |
| P1-A POST + PATCH 4 字段透传 | 全双向静默丢字段 | **仍全双向静默丢字段** | ❌ 未修（第 17 次） |
| P1-B `POST /v1/roadmap/import` | 404 | **404** | ❌ 未修（第 17 次） |
| P1-C `GET /v1/requirements/:id` | 404 | **404** | ❌ 未修（第 17 次） |
| `GET /:id/conversations` 404 | 复现 | **完全复现** | ❌ 未修（第 4 次） |
| Orphan 行 `POST /v1/projects/no-such/requirements` | 201 + 原样回写 | **完全复现** | ❌ 未修（第 17 次） |
| `depends_on` POST bogus FK UUID | 通过 | **完全复现** | ❌ 未修（第 13 次） |
| `depends_on` 非-string 元素 → **500 `d.trim is not a function`** | 未测 | ✨ **07-14 首入档 P1 真 bug**：`[123]`/`[null]`/`[true]`/`[false]`/`[3.14]`/`[{}]`/`[[]]` 全 500，原生 `TypeError` message 泄漏 | ⚠️ **07-14 新 P1 bug** |
| `depends_on` 非-UUID 格式 string | 未测 | ✨ **07-14 首入档**：`"not-a-uuid"`/`"banana"`/`"<script>"` **200 accept**（无 UUID 格式校验）；`""`/`"   "`/`"\t"` 被 filter strip；重复 UUID **不 dedup** | ⚠️ **07-14 首入档 3 面 evidence**：no-format + strip-empty + no-dedup |
| `RequirementStatus` 4 值枚举 | 07-09 加 9 candidate → 全 400 | ✨ **07-14 再加固**：另测 `blocked/in_progress/backlog/review/done` 5 值，`[in_progress, backlog, review, done]` 4 值 200 accept，`blocked` 400；确认 **4 值集 = `[backlog, in_progress, review, done]`**，`blocked` 明确不在 REST 集内 | ✅ **07-14 加固闭合**（累计 14 candidate evidence） |
| Manual PATCH `status:"done"` bypass depends_on gate | 07-08 首落，07-09 未复测 | ⚠️ **07-14 复现**：child requirement w/ `depends_on:[00000000-…]`（不 resolve） → `PATCH {status:"done"}` → **200 done**（gate 完全绕过） | ❌ 未修（第 6 天） |
| `Todo` POST/PATCH response envelope | 未入档 | ✨ **07-14 首入档 shape**：`{todo:{…9 keys}, requirement:{…, triage_state:"approved", acceptance_policy:"subagent", todos:[…echoed]}}` —— **requirement 内联 view 补齐默认字段** vs 顶层 requirement REST（不含这两）**shape 分裂** | ⚠️ **07-14 首入档 shape** |
| **Todo `evidence:null` PATCH** | 07-09 leftover | ✨ **07-14 首入档**：**删除 evidence key**（response.todo 无 `evidence` field） | ⚠️ **07-14 首入档 clear 语义** |
| **Todo `evidence:{}` 空 object PATCH** | 未测 | ✨ **07-14 首入档**：**保留 evidence key**（`evidence={}`）；与 `null` 不同语义（`{}` 是"清空但 key 在"，`null` 是"删除 key"） | ⚠️ **07-14 首入档非对称语义** |
| **Todo `command:""` PATCH** | 07-09 leftover | ✨ **07-14 首入档**：**删除 command key** —— 与 `command:null` 同语义（`command:null` 也删除）；与 `title:""` 的 blank→400 语义不一致 | ⚠️ **07-14 首入档不对称**：Todo `command` 语义与 Requirement `title` 相反 |
| **Todo `command:null` PATCH** | 未测 | ✨ **07-14 首入档**：**删除 command key** —— 与 `""` 同语义 | 与 §L2 合并 |
| `/v1/health` 404 vs `/health` 200 | 未修 | **未修** | ❌ 未修（第 9 次） |
| `server/info` 顶层 16 keys | 07-09 复现 | **完全复现**（`tool_count=44`；`mcp_servers=[]`；`memory.mode=window` `budget_tokens=108000`） | ❌ 未修（第 9 次） |
| `confidence < 0.2` 前端兜底 | P0，16 天未修 | **P0，21 天未修** | 持平 |
| Fingerprint sample=0 shape | 6 top keys 恒定 | **完全复现**（`[as_of, since, top_failing_commands, truncated, verification_pass_rate_by_day, window_days]`；`actions=null`；`sample_count=null`） | ❌ 恒定第 21 天 |
| DDNS `#running` single-flight guard 泄漏 stale `last_result` | 07-09 首入档 P1 bug | **本轮跳过 side-branch 复测**；源码 `runtime.ts:168` early-return + `updateNow` no-await 逐字未变 | 持平（第 6 天源码级持平） |
| `/v1/projects` list shape | 裸数组 | **完全复现**（裸 array of project） | 持平 |
| `/v1/projects/:id/requirements` list shape | 未记 | ✨ **07-14 加固**：**`{items, project_id}` 二 key 视图**（无 filter 与 `?triage_state=approved` filter 均是此 shape）—— 与 07-08 P2 记 "list shape 五分裂" 的建议目标 shape 一致 | ✅ **07-14 首入档** shape confirmed clean |

代码侧三个 deferred / 缺陷标记的精确行号仍在原位（今天 grep 三次确认）：

- `packages/server/src/requirements-routes.ts:164-165` 的 3 行 "verification_plan / workflow_id three-state semantics ... out of scope for this port" 注释
- `packages/server/src/requirements-routes.ts:231, :296` 的 `body.depends_on.filter((d) => d.trim() !== "")` — **NEW P1**：无 `typeof x === "string"` 前置 filter，与 `:632-635` 的 Todo depends_on 有前置类型 filter 语义**不一致**
- `packages/tools/src/register-builtins.ts:13` "未移植清单" 注释含 `roadmap.import`；`:166` `(not yet ported)`
- `packages/server/src/workflow-routes.ts:156` `normalizeSteps(body.steps ?? [])` —— 今天未跑 workflow probe（源码未变 → 效果同 07-09）
- `packages/ddns/src/runtime.ts:168` `if (config === undefined || this.#running) return;` early-return 且 `updateNow` (`:161`) 未 await in-flight —— 07-09 首入档 race，5 天源码级持平

---

## 1. 测试配置

```
OPENAI_API_KEY=sk-stub-for-automation-test
JARVIS_PROVIDER=openai
JARVIS_MODEL=gpt-4o-mini
JARVIS_FS_ROOT=/tmp/jarvis-servlet-test
JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-20260714
JARVIS_ADDR=127.0.0.1:7099
JARVIS_WORK_MODE=off
JARVIS_PERMISSION_MODE=bypass
JARVIS_NO_PROJECT_CONTEXT=1
```

启动日志：
```
[jarvis] persistence connected: json:///tmp/jarvis-servlet-test-db-20260714
[jarvis] serve: provider=openai model=gpt-4o-mini addr=127.0.0.1:7099 fsRoot=/tmp/jarvis-servlet-test coding=false auth=none ddns=off mdns=off promptBytes=263
[jarvis] listening on http://127.0.0.1:7099
```

**Servlet fixture 重建**（07-09 → 07-14 macOS /tmp 清空后）：
```
/tmp/jarvis-servlet-test/
├── pom.xml                                # Maven war 包，servlet-api 4.0.1
├── README.md
└── src/main/
    ├── java/com/example/HelloServlet.java  # @WebServlet("/hello") + doGet 打招呼
    └── webapp/WEB-INF/web.xml
```

**本轮跳过**：DDNS + Memory + AccessToken side-branch（`JARVIS_ADDR=127.0.0.1:7097`，07-09 详细覆盖，本轮源码级持平）。

---

## 2. 主 Kanban 主线（stub 模式）

```
1) POST /v1/projects  {name:"servlet-2026-07-14", instructions:"servlet automation probe 07-14"}
   → 201 pid=635a7e7e-54d1-4248-a1aa-78f9dbe8c0cd；slug 自动 "servlet-2026-07-14"
2) POST /v1/projects/<pid>/requirements
   {title:"probe-4fields-07-14","description":"t","triage_state":"approved",...4 extra fields...}
   → 201 rid=7102002a-b9e9-4ed8-ba7e-eb522e226f11
     响应 keys=[conversation_ids, created_at, description, id, project_id, status, title, updated_at] **8 keys**
     4 extra fields (acceptance_policy/workflow_id/assignee_id/verification_plan) **全不出现**
3) PATCH /v1/requirements/<rid>
   4 extra fields (acceptance_policy:"Subagent",workflow_id:"22...", assignee_id:"user-y", verification_plan:{...})
   → 200 same 8 keys；4 fields 全 drop
```

---

## 3. 回归探针（P1 gaps 未修复第 17 次）

### §3.1 P1-A：POST 上 4 字段静默丢

```
BODY = {"title":"probe-4fields-07-14","description":"t","triage_state":"approved",
        "acceptance_policy":"Human",
        "workflow_id":"11111111-1111-1111-1111-111111111111",
        "assignee_id":"user-x",
        "verification_plan":{"steps":[{"kind":"assert","args":{"x":1}}]}}
→ 201 keys=[conversation_ids, created_at, description, id, project_id, status, title, updated_at]  **8 keys**
  全无 acceptance_policy / workflow_id / assignee_id / verification_plan
```

### §3.2 P1-A part 2：PATCH 上 4 字段静默丢

```
PATCH /v1/requirements/<rid>
 {"acceptance_policy":"Subagent","workflow_id":"22222222-...","assignee_id":"user-y",
  "verification_plan":{"steps":[{"kind":"cmd","args":{"c":"mvn test"}}]}}
→ 200 keys 同上 8 keys，4 字段全丢
```

### §3.3 P1-B：`POST /v1/roadmap/import` 仍 404

```
→ 404 {"message":"Route POST:/v1/roadmap/import not found","error":"Not Found","statusCode":404}
```

### §3.4 P1-C：`GET /v1/requirements/:id` 仍 404

```
→ 404
```

### §3.5 `GET /v1/requirements/:id/conversations` 仍 404

```
→ 404
```

（07-07 首入档，07-08 → 07-09 → 07-14 复现）

### §3.6 orphan `project_id` 无 FK

```
POST /v1/projects/no-such-project-id-07-14/requirements {"title":"orphan-07-14","description":"orphan"}
→ 201 {"id":"29ec5ca9-...","project_id":"no-such-project-id-07-14",...}  ← 原样写盘
```

### §3.7 `depends_on` POST bogus UUID 通过

```
POST /v1/projects/<pid>/requirements {"title":"probe-deps-bogus-07-14","depends_on":["00000000-0000-0000-0000-000000000000"]}
→ 201 accept；response.depends_on = ["00000000-..."]
```

### §3.8 Manual PATCH `status:"done"` bypass `depends_on` gate

```
target rid = 967238c4-…（§3.7 创建的，depends_on:[00000000-…] 依赖不 resolve）
PATCH /v1/requirements/967238c4-… {"status":"done"}
→ 200 {status:"done", depends_on:["00000000-…"], …}   ← gate 完全绕过
```

（07-08 首入档，07-14 复现第 6 天）

### §3.9 `RequirementStatus` 严格 4 值 evidence（14 candidate 加固）

07-09 记 9 candidate 全 400；07-14 补 5 candidate（`blocked, in_progress, backlog, review, done`）：

```
PATCH status:"draft"          → 400 unknown status `draft`
PATCH status:"cancelled"      → 400 unknown status `cancelled`
PATCH status:"on_hold"        → 400 unknown status `on_hold`
PATCH status:"pending"        → 400 unknown status `pending`
PATCH status:"planning"       → 400 unknown status `planning`
PATCH status:"approved"       → 400 unknown status `approved`
PATCH status:"active"         → 400 unknown status `active`
PATCH status:"shipped"        → 400 unknown status `shipped`
PATCH status:"archived"       → 400 unknown status `archived`
PATCH status:"blocked"        → 400 unknown status `blocked`
PATCH status:"in_progress"    → 200 status="in_progress"
PATCH status:"backlog"        → 200 status="backlog"
PATCH status:"review"         → 200 status="review"
PATCH status:"done"           → 200 status="done"
```

**结论**：`RequirementStatus` **严格 4 值** `[backlog|in_progress|review|done]`。UI 若在设计里想加"On Hold"或"Cancelled"列，得走 `triage_state=RejectedByAgent` 或 soft-delete + Activity 侧路径。

### §3.10 `/v1/health` vs `/health` 分裂

```
GET /health → 200 {"status":"ok"}
GET /v1/health → 404
```

（第 9 天未修）

### §3.11 `server/info` 顶层 16 keys（未变）

```
['approval_mode', 'coding_mode', 'config_path', 'listen_addr', 'max_iterations', 'mcp_servers',
 'memory', 'persistence', 'project_context', 'project_store', 'providers', 'system_prompt',
 'tool_count', 'tools', 'version', 'workspace_root']
tool_count = 44
mcp_servers = []
memory = {mode:"window", budget_tokens:108000}
providers[0] = {name:"openai", default_model:"gpt-4o-mini", models:["gpt-4o","gpt-4o-mini"], is_default:true, kind:"openai"}
```

仍无 `ddns/memory_enabled/mdns/access_token_configured/features`。

---

## 4. 07-09 leftover 3 条 + 5 条新 evidence 落地

### §L1: `PATCH /:id/todos/:tid {"evidence":null}` = **删除 evidence key**（07-09 leftover 落地）

```
step 1 (baseline): POST /:id/todos {"title":"todo-baseline-07-14","kind":"work","command":"npm test",
                     "evidence":{"run_id":"r-baseline","exit_code":42,"note":"baseline"}}
→ 200 response.todo keys = [command, created_at, created_by, evidence, id, kind, status, title, updated_at]   ← 9 keys

step 2: PATCH /:id/todos/:tid {"evidence":null}
→ 200 response.todo keys = [command, created_at, created_by, id, kind, status, title, updated_at]   ← 8 keys
  evidence field 完全从 response 消失
```

**结论**：`evidence:null` = **DELETE 语义**（不是 set-to-null）。源码 `requirements-routes.ts:729-731`：
```ts
if (body.evidence !== undefined) {
  todo.evidence = body.evidence === null ? undefined : (body.evidence as RequirementTodoEvidence);
}
```

`undefined` 被 JSON serializer skip（Node 移植后延续 Rust `#[serde(skip_serializing_if = "Option::is_none")]` 语义）。

### §L2: `PATCH command:""` 与 `PATCH command:null` **同语义 = 删除 key**（07-09 leftover 落地）

```
step 1: PATCH /:id/todos/:tid {"command":""}
→ 200 response.todo keys 无 command   ← DELETE

step 2: PATCH /:id/todos/:tid {"command":null}
→ 200 response.todo keys 无 command   ← DELETE
```

源码 `requirements-routes.ts:725-728`：
```ts
if (body.command !== undefined) {
  const c = typeof body.command === "string" ? body.command.trim() : "";
  todo.command = c === "" ? undefined : c;
}
```

**结论**：Todo `command` 语义 = "" 或 null → 删除。与 Requirement `title` 语义 (`""` → 400 blank 校验) **不一致**（`title` 是 mandatory，`command` 是 optional）—— UI 侧需注意"empty string 覆盖 = 删除"这个不对称。

### §L3: `POST /v1/requirements` `depends_on` 非-UUID 格式 accept 3 面 evidence（07-09 leftover 落地）

```
POST body {"depends_on":["not-a-uuid","banana","<script>","",""]}
→ 201 response.depends_on = ["not-a-uuid","banana","<script>"]   ← 空串 filter 掉，UUID-format 校验缺
```

3 面 evidence：

1. **格式校验缺**：`"not-a-uuid"` / `"banana"` / `"<script>"` (含 XSS-looking) 全 accept — 与已有 bogus-UUID (§3.7) 一致，任何 string 都通过
2. **空串静默 strip**：`""` / `"   "`（3-space） / `"\t"`（tab）全被 `.filter((d) => d.trim() !== "")` 过滤掉，client 没有 warning
3. **重复 UUID 不 dedup**：`["11111111-...", "11111111-...", "22222222-..."]` → response 三个原样保留（与 07-09 §4.2.1 batch-todo duplicate ids 2×response 是**同源 wire 不 dedup 模式**）

### §L4: **NEW P1 真 bug**：`depends_on:[<non-string>]` → **500 `d.trim is not a function`**（源码级 typeof 缺）

```
POST /v1/projects/<pid>/requirements {"title":"leak-check","depends_on":[42]}
→ 500 {"statusCode":500,"error":"Internal Server Error","message":"d.trim is not a function"}

同上，[123]/[null]/[true]/[false]/[3.14]/[{}]/[[]] 全 500 + 原生 TypeError message 泄漏
```

对比 `["nested_string"]`（数组套字符串，直觉是 array of arrays）→ 400 Bad Request（在 Fastify 更早的 body 校验层拒掉，不进 handler）。

**根本原因**：`requirements-routes.ts:231` (POST) 与 `:296` (PATCH)：
```ts
item.depends_on = body.depends_on.filter((d) => d.trim() !== "");
```

类型标注是 `depends_on?: string[]` 但**运行时零 `typeof` 校验**。相比 `:632-635` 的 Todo depends_on 有 `.filter((x): x is string => typeof x === "string")` 前置过滤 —— **REST /:id/requirements 少了这一步**。

**修 3 案**（推荐**方案 A**）：
1. **方案 A**：`filter((d): d is string => typeof d === "string" && d.trim() !== "")` — 与 Todo depends_on 一致；3 处：`:231, :296, :239 (label_ids)`, `:304 (label_ids PATCH)` 全部同源
2. **方案 B**：body 层 JSON schema 校验（Fastify schemas）在 handler 前拒
3. **方案 C**：`try/catch` 里显式对 TypeError → 400（**不推荐**，绕过根因）

**副作用**：500 + raw JS 错误消息泄漏也是一处轻信息披露（暴露 runtime = Node）—— error handler 应统一 `errorText(e)` 或 `"invalid depends_on element"` 兜底。

### §L5: Todo POST/PATCH response envelope shape 首入档

```
POST /v1/requirements/<rid>/todos {"title":"...","kind":"work","command":"npm test","evidence":{...}}
→ 200 response = {
    todo: {…9 keys: command, created_at, created_by, evidence, id, kind, status, title, updated_at},
    requirement: {
      id, project_id, title, status, conversation_ids,
      triage_state: "approved",            ← ⚠️ POST /v1/requirements 时没写这个，此 view 补默认
      acceptance_policy: "subagent",       ← ⚠️ 同上
      created_at, updated_at, description,
      todos: [ ...echoed todo ]
    }
  }
```

**结论**：
- Todo `{todo, requirement}` 双 view envelope 首入档（**05-XX 的 kanban 主线 REST 里从未有过这个 shape**）
- `requirement` 内联视图**补齐了 POST /v1/requirements 时不出现的 `triage_state` 和 `acceptance_policy` 默认值** —— 说明**同一 requirement 资源在两个 REST 视图里 shape 分裂**：
  - 顶层 `POST /v1/projects/:id/requirements` 响应：`8 keys`，无 `triage_state/acceptance_policy`（07-09 §3.1 记）
  - Todo POST wrapper.requirement 视图：`11 keys`，含默认补齐的 `triage_state="approved"` + `acceptance_policy="subagent"`

这就解释了 07-09 §3.1 记的"4 字段 POST + PATCH 静默丢字段"里 `acceptance_policy` 也丢的表象 —— **不是数据没存**，而是**顶层 REST 视图选择不返回**。要拿到实际存的 policy 值，得走**间接**路径（POST 一个 todo 拿 wrapper.requirement）。

### §L6: Todo `evidence:{}` **保留 key + value={}**（与 `null` 语义不对称）

```
PATCH /:id/todos/:tid {"evidence":{}}
→ 200 response.todo.evidence = {}   ← key 保留、value 是空 object
```

对比 `evidence:null` → **删除 key**。

**结论**：Todo evidence 三态：
- 缺失: key 不在
- `{}`: key 在 + 空 object
- `null` (via PATCH): 转 undefined → key 不在（与"缺失"同表现，写侧语义"清空"）

前端要区分"从没设过 evidence" vs "曾经设过后来清空"是**做不到**的（都是 no-key）。

---

## 5. Harness health baseline（sample=0）

主分支 fresh DB (`-20260714`) 起点即 sample=0：

```
GET /v1/work/quality → {
  as_of: "2026-07-13T19:07:33.401Z",
  since: "2026-07-06T19:07:33.401Z",
  window_days: 7,
  truncated: false,
  top_failing_commands: [],
  verification_pass_rate_by_day: [7-day slots all {passed:0, failed:0, needs_review:0}]
}

top keys = ['as_of', 'since', 'top_failing_commands', 'truncated',
            'verification_pass_rate_by_day', 'window_days']
actions = None                ← ⚠️ P0：前端兜底信号 missing
sample_count = None            ← ⚠️ P0：前端兜底信号 missing
```

sample=0 shape 与 07-08 → 07-09 → 07-14 **21 天恒定**。真正的 harness health 信号（`actions[fill_signal_gaps]`, `sample_count`）在 sample=0 状态下**根本不在响应里** —— 前端读 `actions.find(a=>a.key==="fill_signal_gaps") && sample_count<5` 的 5 分钟 P0 修复 **21 天未修**。

真 LLM 端到端还是**不能跑**（stub key `sk-stub-for-automation-test` → `/v1/chat/completions` 返回 `401 llm provider error: status 401: Incorrect API key provided`）。因此 `harness.health` agent tool 无法通过 REST triggered chat 触发。

---

## 6. 未修复清单（P0/P1/P2 累积）

**P0**（前端 1 行 5 分钟）：
- confidence < 0.2 前端兜底（读 `actions.find(a=>a.key==="fill_signal_gaps") && sample_count<5`） — **21 天未修**

**P1**（REST 层缺 route / FK / 字段透传 / 类型校验缺）：
- POST + PATCH 4 字段（`acceptance_policy` / `workflow_id` / `assignee_id` / `verification_plan`）静默丢 — 21 天未修（**07-14 §L5 澄清**：`triage_state / acceptance_policy` 数据其实存了，只是**顶层 REST 视图不返回**；`workflow_id / assignee_id / verification_plan` 3 字段是**真 drop**）
- `POST /v1/roadmap/import` 404 — 21 天未修
- `GET /v1/requirements/:id` 404 — 21 天未修
- `GET /v1/requirements/:id/conversations` 404 — 6 天未修
- orphan project_id 无 FK — 21 天未修
- depends_on 4 处同源 FK (POST/PATCH-only/cross-project/Todo) — 17 天未修
- **07-14 新加**：`depends_on` 数组元素非 string → 500 `d.trim is not a function`（`requirements-routes.ts:231, :296`）—— 建议 **方案 A** `.filter((d): d is string => typeof d === "string" && d.trim() !== "")`；同源 `label_ids` (`:239, :304`) 也需同修
- `POST /:id/conversations` conversation_id 无格式 + 无 FK — 5 天未修
- `POST /v1/workflows` 500 泄漏 10 shape — 11 天未修（本轮跳过复测，源码未变）
- `DELETE /v1/ddns/config` 未注册 route — 9 天未修（跳过复测）
- Manual PATCH `status:"done"` bypass depends_on gate — 6 天未修（07-14 §3.8 复现）
- **DDNS runtime `#running` single-flight guard 泄漏 stale `last_result`** — 07-09 首入档，源码 `runtime.ts:168` 5 天持平

**P2**（一致性 / 语义 / 文档缺）：
- list shape 五分裂 — 17 天未修
- `/v1/health` 404 vs `/health` 200 — 9 天未修
- `server/info` 不反映 `ddns/memory_enabled/mdns/access_token_configured/features` — 9 天未修
- depends_on 条件性写回 shape drift — 13 天未修
- **07-14 新加**：`depends_on` **空串/whitespace-only 静默 strip**（无 warning） + `depends_on` **重复 UUID 不 dedup**（与 07-09 batch-todo duplicate ids 同源 wire-side 不 dedup 模式）
- DDNS PUT 累计 10 处 soft-accept — 21 天未修（本轮跳过）
- `POST /v1/ddns/upnp/test` body 静默无效 — 5 天未修
- `POST /v1/ddns/update` 200 wrap `last_result:{ok:false}` 语义 — 文档缺，3 天未修
- `/start` `/block` `/complete` 是 agent tools 而非 REST — CLAUDE.md 未明写，5 天未修
- Todo `status` / `kind` / `created_by` 枚举与 Requirement 完全不同 — 4 天未修
- `RequirementStatus` 4 值不含 `blocked`；`RequirementTodoStatus` 6 值含 blocked；文档需分开描述 — 07-14 加固 14 candidate evidence
- Todo evidence falsy value 保留 — Node 移植后失去 Rust `#[serde(skip_serializing_if = "Option::is_none")]` 语义
- **07-14 新加**：Todo `evidence:null` = **DELETE key**，`evidence:{}` = **保留 key + 空 object** —— 三态语义 UI 侧要留意（无法区分"从没设过"vs "设过后 null 清"）
- **07-14 新加**：Todo `command:""` 与 `command:null` **同 = DELETE**（与 Requirement `title:""` → 400 blank 校验语义相反；`command` optional / `title` mandatory）
- **07-14 新加**：Todo POST/PATCH response envelope `{todo, requirement}` 双 view；`requirement` 内联补默认 `triage_state/acceptance_policy` —— 与顶层 REST 视图 shape 分裂
- **07-14 新加**：`/v1/projects/:id/requirements` 是 `{items, project_id}` **二 key clean shape** —— 与 07-08 P2 建议 shape 目标 (`{items, ...parent_id?}`) 一致；应作为 list shape 五分裂**统一模板**（其他 4 route 迁向该 shape 即可）
- Activity `body.kind` inner-classifier convention — 8 天未修
- UUID 格式校验非一致 — 08 天未修
- REST 幂等 style 累计三种 — 6 天未修
- Todo sub-resource 五 route 五种 envelope shape — 6 天未修（本轮 §L5 新增 6 shape）
- `GET /v1/remote/info.external` 三-shape 分裂 — 6 天未修（本轮跳过复测）
- `/v1/remote/pairing.token` = 明文 access token；`pairing_links[*].link` 含明文 token — 6 天未修（跳过）

---

## 7. 07-14 首次发现清单

1. **✨ NEW P1 真 bug**：`POST/PATCH /:id/requirements` body 上 `depends_on:[<non-string>]` → **500 `d.trim is not a function`**，原生 JS TypeError 消息泄漏。源码 `requirements-routes.ts:231, :296`（POST+PATCH），无 `typeof` 前置校验；同源 `label_ids` (`:239, :304`) 也需同修。**修 3 案**已列 §L4。也是**唯一一个新真 bug**（其余 6 条都是语义/shape 细化）。

2. **✨ Todo `evidence:null` PATCH 语义 = DELETE key**（07-09 leftover 落地）—— `evidence:null` → `todo.evidence = undefined` → JSON skip → response 无 `evidence` 字段。源码 `:729-731`。

3. **✨ Todo `evidence:{}` PATCH 语义 = 保留 key + 空 object**（与 null 不对称）—— 三态 UI 侧要留意（无法区分"从没设过"vs "设过后 null 清"）。

4. **✨ Todo `command:""` 与 `command:null` PATCH 均 = DELETE key**（07-09 leftover 落地）—— 与 `title:""` → 400 blank 校验语义**相反**（`command` optional / `title` mandatory）；源码 `:725-728` 显式 `c === "" ? undefined : c`。

5. **✨ `depends_on` 非-UUID 格式 string accept 3 面 evidence**（07-09 leftover 落地）：
   - 格式校验缺（`"not-a-uuid"` / `"banana"` / `"<script>"` 全 200）
   - 空串/whitespace-only 静默 strip（`""` / `"   "` / `"\t"` filter 掉）
   - 重复 UUID 不 dedup（与 07-09 batch-todo duplicate ids 同源模式）

6. **✨ Todo POST/PATCH response envelope shape 首入档**：`{todo:{…9 keys}, requirement:{…11 keys, triage_state:"approved" 默认补, acceptance_policy:"subagent" 默认补, todos:[…echoed]}}` —— **重要澄清**：07-09 §3.1 记的"4 字段静默丢字段"里 `triage_state / acceptance_policy` **数据其实存了**，只是**顶层 REST 视图不返回**；真正 drop 的是 `workflow_id / assignee_id / verification_plan` 3 字段。

7. **✨ `RequirementStatus` 14 candidate 全 evidence 闭合**（07-09 记 9 candidate 全 400 + 07-14 补 5 candidate `blocked, in_progress, backlog, review, done`）—— 4 值集 `[backlog, in_progress, review, done]` 严格证据闭合；`blocked` 明确不在 REST 集内。

8. **✨ `/v1/projects/:id/requirements` list shape confirmed clean**：`{items, project_id}` 二 key 视图；无 filter 与 `?triage_state=approved` filter 均同 shape。可作为 list-shape 五分裂**统一模板**（其他 route 迁 `{items, ...parent_id?}` 即可）。

9. **⚠️ Fixture 全 fixture 消失事件**：`/tmp/jarvis-servlet-test` 目录 07-09 → 07-14 五天空档间 macOS 重启清空 `/tmp`，07-09 记的 HelloServlet.java 单文件消失事件**升级为全 fixture 消失**。scheduled task 需保护 fixture（考虑 `~/jarvis-servlet-test` 或 `~/Library/Application Support/jarvis-servlet-test` 移出 `/tmp`）。本轮已重建 4 文件 fixture。

10. **⚠️ 5 天空档不合理**：07-09 → 07-14 之间无 diagnostic 记录、无 commit —— scheduled task 可能连续 4 天空跑失败或未跑，需回查 `~/.claude/scheduled-tasks/coder-task/` cron 日志。

---

## 8. 复现 commands 一键版

```bash
# fixture 重建（macOS /tmp 清空后）
mkdir -p /tmp/jarvis-servlet-test/src/main/java/com/example \
         /tmp/jarvis-servlet-test/src/main/webapp/WEB-INF
cat > /tmp/jarvis-servlet-test/pom.xml <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId><artifactId>hello-servlet</artifactId>
  <version>1.0.0</version><packaging>war</packaging>
  <properties>
    <maven.compiler.source>11</maven.compiler.source>
    <maven.compiler.target>11</maven.compiler.target>
  </properties>
  <dependencies>
    <dependency><groupId>javax.servlet</groupId><artifactId>javax.servlet-api</artifactId>
                <version>4.0.1</version><scope>provided</scope></dependency>
  </dependencies>
</project>
EOF
cat > /tmp/jarvis-servlet-test/src/main/java/com/example/HelloServlet.java <<'EOF'
package com.example;
import javax.servlet.*; import javax.servlet.annotation.*; import javax.servlet.http.*;
import java.io.IOException;
@WebServlet(name="HelloServlet", urlPatterns={"/hello"})
public class HelloServlet extends HttpServlet {
    @Override protected void doGet(HttpServletRequest req, HttpServletResponse resp)
            throws ServletException, IOException {
        resp.setContentType("text/plain; charset=UTF-8");
        String n = req.getParameter("name");
        if (n==null||n.trim().isEmpty()) n = "world";
        resp.getWriter().write("Hello, "+n+"!");
    }
}
EOF

# 主分支起
export OPENAI_API_KEY=sk-stub-for-automation-test
export JARVIS_PROVIDER=openai JARVIS_MODEL=gpt-4o-mini
export JARVIS_FS_ROOT=/tmp/jarvis-servlet-test
export JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-<YYYYMMDD>
export JARVIS_ADDR=127.0.0.1:7099
export JARVIS_WORK_MODE=off JARVIS_PERMISSION_MODE=bypass JARVIS_NO_PROJECT_CONTEXT=1
node --experimental-strip-types packages/jarvis-app/src/main.ts serve &

# §L4 500 leak demo
B=http://127.0.0.1:7099
PROJ=$(curl -sS -XPOST $B/v1/projects -H 'Content-Type: application/json' -d '{"name":"demo"}')
PID=$(echo "$PROJ" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -sS -XPOST $B/v1/projects/$PID/requirements \
  -H 'Content-Type: application/json' -d '{"title":"leak","depends_on":[42]}'
# → 500 {"statusCode":500,"error":"Internal Server Error","message":"d.trim is not a function"}
```

---

## 9. 未验证项（继续滚到下一次）

- **07-09 累积 (残留)**：
  - `POST /v1/ddns/update` 在**真** `token` credential 下 `record_type=A/AAAA/MX/NS/SRV` 各自的 error string
  - `server/info.mcp_servers` shape（当有 MCP 时；本轮 mcp_servers=[] 恒定）
  - **race condition** `#running` guard 更极端场景：3-4 back-to-back PUT+POST（本轮跳过 side-branch 未复测）
- **07-14 新留白**：
  - `label_ids:[<non-string>]` 是否也 500 `d.trim is not a function`（源码 `:239, :304` 与 depends_on 同源无类型校验；预期 500，未实测）
  - Todo `depends_on:[<non-string>]` 是否 200 filter 掉（源码 `:632-635` 有 `typeof x === "string"` 前置 filter，预期 200；未实测）
  - `POST /v1/requirements` `depends_on:[123, "11111111-..."]` 混合 → 500 首触 or 401 有效 UUID 先过（本轮实测 500，但未测顺序）
  - `PATCH /:id/todos/:tid {"evidence":123}`（非 object 类型）—— `body.evidence !== undefined && body.evidence !== null` 时的 `as RequirementTodoEvidence` type-assertion 会 accept int？
  - **fixture 保护**：把 `/tmp/jarvis-servlet-test` 迁到 `~/jarvis-servlet-test` 或 `~/Library/…`，避免 macOS 重启清空

---

## 10. 总览

| 项 | 评分 | 与 07-09 比（5 天） |
| --- | --- | --- |
| Kanban (Project + Requirement CRUD + 5 状态转换 + Activity) | ✅ 健康；14 candidate `RequirementStatus` 4 值 evidence 闭合 | **07-14 evidence 闭合** |
| Workflow CRUD + dispatch + cancel | ✅ 健康（除 §4.1 10 shape 500 泄漏；本轮跳过） | 持平 |
| Diagnostics (`/v1/diagnostics/*` + `/v1/work/*`) | ✅ 健康 | 持平 |
| Harness.health 算法实装 | ✅ 稳定第 21 天 | **持平** |
| Harness.health 信号采集 | ⚠️ 缺 LLM 驱动时无信号 | 持平 |
| Harness.health 前端表达 | ❌ confidence 低分仍直接展示 score | **21 天未修** |
| DDNS 后端 | ⚠️ 07-09 P1 bug (`#running` race)；本轮跳过 side-branch 复测（源码级持平） | 源码级持平 |
| Memory 后端（backend=none） | ✅ 健康 | 持平（跳过） |
| REST ↔ 数据模型一致性 | ❌ 07-14 澄清：`triage_state / acceptance_policy` **数据其实存了**，只是**顶层视图不返回**；真正 drop 的是 `workflow_id / assignee_id / verification_plan` 3 字段（Todo wrapper.requirement 视图能拿到 policy 值 —— 视图分裂）；orphan project_id、depends_on 4 处 FK 缺；**07-14 新 P1 bug**：depends_on 非 string 元素 → 500 raw TypeError message 泄漏 | **07-14 澄清 1 处 + 新 P1 1 处** |
| Requirement sub-resources 完整覆盖 | ✅ **07-14 补齐 Todo 深度**：evidence 3 态 (`null`=delete / `{}`=preserve empty / `undef`=missing) + command 2 态 (`""`=`null`=delete) + response envelope `{todo, requirement}` 首入档 | **07-14 补齐 Todo 3 面深度** |
| 文档 ↔ 运行时一致性 | ⚠️ 依旧多缺；07-14 加：depends_on 非 string 500 / evidence null vs {} 三态 / command "" = null = delete / RequirementStatus 4 值 vs 14 candidate | **07-14 又揭底 4 缺口** |
| 单测覆盖 | ✅ 522/522 全绿，7625 ms | 持平（-82 ms 噪声） |
| **真 bug**：`POST /v1/workflows` 500 泄漏 | ❌ 源码未变（跳过复测） | 持平（第 11 次） |
| **真 bug**：`DELETE /v1/ddns/config` 无 handler | ❌ 未复测（跳过 side-branch） | 源码级持平 |
| **真 bug**：DDNS PUT 累计 10 处 soft-accept | ❌ 未复测（跳过） | 源码级持平 |
| **真 bug**：depends_on 四处无 FK 同源 | ❌ 全复现（§3.7 复现） | 持平 |
| **真 bug**：manual PATCH `status:"done"` bypass depends_on gate | ❌ §3.8 复现 | 持平（第 6 天） |
| **真 bug**：DDNS runtime `#running` 泄漏 stale `last_result` | ⚠️ 07-09 首入档；源码 `runtime.ts:168` 5 天持平 | 源码级持平 |
| **真 bug（07-14 新）**：`depends_on:[<non-string>]` → 500 raw TypeError 泄漏 | ⚠️ **07-14 首入档 NEW P1 bug** | **07-14 新添** |
| 自动化的端到端验证（有 LLM key） | ❌ 本次仍未执行 | 持平 |
| **Fixture 保护**（`/tmp/jarvis-servlet-test`） | ⚠️ **07-14 升级问题**：单文件消失 → 全 fixture 消失 | ⚠️ **07-14 建议迁到 `~/` 下** |

**总体判断**：HEAD 在 06-23 → 07-14 **二十一天**没动，07-09 → 07-14 五天间隔仅**新增 1 条 P1 真 bug**（`depends_on:[<non-string>]` 500）+ **5 条语义 shape evidence**（Todo `evidence:null/{}` 三态 + Todo `command:""/null` delete + response envelope + depends_on 非-UUID 3 面 + RequirementStatus 14 candidate 闭合）+ **1 条实用 shape 首入档**（`/v1/projects/:id/requirements` 是 clean `{items, project_id}` 二 key，可作为 list shape 统一模板）。真正的**修**这五天没发生。

本轮实际增量价值：

1. **07-09 未验证项 3 条全落地**：
   - **✨ Todo `evidence:null` PATCH = DELETE key** (`:729-731`)
   - **✨ Todo `command:""` = `command:null` = DELETE key** (`:725-728`) + `command:""` 与 `title:""` 语义**相反** UI 陷阱
   - **✨ `depends_on` 非-UUID string accept 3 面**（no-format + strip-empty + no-dedup）

2. **07-14 意外新落地 4 条**（07-09 未预告）：
   - **✨ NEW P1 真 bug**：`depends_on:[<non-string>]` → 500 raw `TypeError` message 泄漏；源码级根因锁在 `requirements-routes.ts:231, :296`；修 3 案 §L4；**唯一新真 bug** —— **优先级建议：本周内合入**（3 行 typescript-safe `.filter((d): d is string => typeof d === "string" && d.trim() !== "")`）
   - **✨ Todo `evidence:{}` = 保留 key + 空 object**（与 `null` 不对称）—— 三态 UI 陷阱
   - **✨ Todo POST/PATCH `{todo, requirement}` 双 view envelope 首入档**，`requirement` 内联补默认 `triage_state/acceptance_policy` —— **澄清 07-09 §3.1 "4 字段静默丢字段" 是**两个视图分裂而非数据 drop**
   - **✨ `/v1/projects/:id/requirements` 是 `{items, project_id}` 二 key clean shape** —— list shape 统一模板已现

3. **`RequirementStatus` 14 candidate evidence 闭合**（07-09 9 + 07-14 5 → 严格 4 值集完全闭合）

4. **fingerprint sample=0 shape 21 天恒定** & `actions[fill_signal_gaps]` + `sample_count` 前端兜底 P0 依旧未修

5. **cross-day 持久化 chain 第 12 天**（`~/.local/share/jarvis/ddns.json` 07-04 → 07-14 十跳跨日存活，包括 07-09 → 07-14 五天空档 + 可能的 macOS 重启）

6. **fixture 中断升级**：07-09 单文件消失 → 07-14 全 fixture 消失（macOS 重启清空 `/tmp` 是原因；建议迁移 fixture 到 `~/` 下持久化）

**建议**（相较 07-09 添加 3 项）：
- ①-⑬（沿用 07-09 建议 13 项）
- ⑭ **07-14 新加**：`packages/server/src/requirements-routes.ts:231, :239, :296, :304` 4 处 `.filter((d) => d.trim() !== "")` 加 `typeof x === "string"` 前置校验（Todo `:632-635` 已有该模式，一致化即可）—— 单条 typescript-safe `.filter((d): d is string => typeof d === "string" && d.trim() !== "")` 就位；顺带修 `label_ids` 同源。**Impact**：修一处 P1 500 bug + 一处 TypeError message 泄漏；4 行改动
- ⑮ **07-14 新加**：CLAUDE.md 补充 Todo evidence 3 态语义 (`null`=delete / `{}`=preserve / `undef`=missing) + `command:""/null` = DELETE 语义 (vs Requirement `title:""` → 400 blank) + Todo POST/PATCH `{todo, requirement}` 双 view envelope shape
- ⑯ **07-14 新加**：Fixture 保护 —— 建议把 `/tmp/jarvis-servlet-test` 迁到 `~/jarvis-servlet-test`（scheduled-task cron 时 macOS 可能会重启清空 `/tmp`；本轮 fixture 全消失一次），或至少在 diagnostic script 里加 fixture idempotent 重建逻辑（本轮已有）

**P0 修复（21 天）**：前端读 `actions.find(a => a.key === "fill_signal_gaps") && sample_count < 5` 当 cold-start 兜底信号，1 行 5 分钟 —— 二十一天延期的根本原因还是被误判成"需要重新设计"。

**07-14 新 P1 修复优先建议**：`packages/server/src/requirements-routes.ts:231, :296` `depends_on` `.filter` 加 `typeof x === "string"` 前置校验 —— 修一处 500 crash + 一处 TypeError message 泄漏；4 行改动。同源 `label_ids` (`:239, :304`) 一起修一致化。**Impact**：修 07-14 唯一发现的新 P1 真 bug + 未来 P2 一致性 debt 一并清除。
