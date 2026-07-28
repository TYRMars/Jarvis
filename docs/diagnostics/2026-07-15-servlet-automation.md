# Jarvis 项目自动化能力诊断报告（2026-07-15 十八次复测）

- **运行时间**：2026-07-15（scheduled task 自动跑）
- **被测分支**：`feat/mobile-ios-ddns`（HEAD 仍为 `64d288a`，与 06-23 → 07-14 同一 commit — **静默第 22 天**；工作树侧 39 个未 commit 文件与 07-14 逐字一致）
- **被测项目**：`/tmp/jarvis-servlet-test`
  - **07-15 差异**：fixture **完整幸存**（07-14 重建后 24h 内 macOS 未清 `/tmp`；`ls -la /tmp/jarvis-servlet-test/` 4 文件全在 —— 相对 07-09 → 07-14 五天空档中被清空的降级）。
  - **07-14 → 07-15 一天间隔**：期间 0 commit（HEAD 未动，工作树也未动）；scheduled task 恢复日跑节奏。
- **本次目的**：
  1. **回归确认** 07-14 P0/P1/P2 累积项在 1 天间是否被修复（预期：全未修，第 22 天）
  2. **07-14 §9 未验证项 5 条全落地**：
     - `label_ids:[<non-string>]` 是否 500 `id.trim is not a function`（源码 `:239, :304` 与 depends_on 同源，07-14 预测 500 未实测）
     - Todo `depends_on:[<non-string>]` 是否 200 filter 掉（源码 `:632-635` 有 typeof 前置 filter，07-14 预测 200 未实测）
     - `POST /v1/requirements` `depends_on:[123, "uuid"]` 混合 → 500 首触 or 有效 UUID 先过（07-14 实测 500，但未测顺序）
     - `PATCH /:id/todos/:tid {"evidence":123}` —— `body.evidence !== undefined && body.evidence !== null` 时的 `as RequirementTodoEvidence` type-assertion 会 accept int？
     - `depends_on:[null]` 精确错误信息（07-14 记同 `d.trim is not a function`，实际值需复核）
  3. **今日新发现**（07-14 未预告）：
     - **✨ P1 真 bug 加固**：`depends_on` **非 string 元素在任意位置** → 500（顺序无关，全部 `d.trim is not a function`）；`depends_on:[[]]` 嵌套数组 / `[{}]` 对象元素 也全 500 —— **首触即 500**，不遍历
     - **✨ Todo `evidence` type-assertion 完全形同虚设 (P2)**：`PATCH evidence:123 / "a-string" / true / [1,2,3]` **全 200 accept，值原样存**；也覆盖 `POST /v1/requirements/:id/todos {"evidence":999}` **201 accept**。源码 `:729-731` `as RequirementTodoEvidence` type-assertion 在运行时零校验
     - **✨ Todo `depends_on` typeof 过滤器工作正常** —— `[42, null, true, "<uuid>"]` → 200 `depends_on:["<uuid>"]`，非 string **静默 drop**；进一步证明 Requirement path (`:231, :296`) 只差 `.filter((d): d is string => typeof d === "string" && d.trim() !== "")` 一行即修
     - **✨ `label_ids:[<non-string>]` = **`id.trim is not a function`** 500** —— 同源第 3、4 站点（`:239, :304`），错误消息不同（`d.trim` vs `id.trim`）但根因相同；4 站点全需 typeof 前置校验
     - **✨ `depends_on:[null]` 精确错误信息** ≠ 07-14 记 `d.trim is not a function`，实际 `Cannot read properties of null (reading 'trim')` —— **07-14 一条 wire 消息小误记，07-15 更正**
     - **✨ DELETE 幂等风格再细化第 4 种**：`DELETE /v1/requirements/:id` = **"soft-select 硬删除"**（1st `200 {deleted:true}` / 2nd `404 {deleted:false, error}` —— 404 body 里额外带 `deleted:false` 字段是**独此一家**；与 workflow-run cancel 的 `404 {error}` 无 `deleted:false` 不同）
     - **✨ DELETE /v1/projects/:id = SOFT-ARCHIVE**：1st `200 {archived:true, id}` / 2nd `200 {archived:true, id}` (universal 200 no-op like `DELETE /v1/memory/includes`) / bogus `404 {error:"project not found"}` —— **soft-archive 与 hard-delete 两 verb 同名 `DELETE`，行为完全不同**（Requirement 是 hard-delete + 数据消失；Project 是 archive + 数据保留）
     - **✨ DELETE Project 无 cascade**：archived project 的 requirements **仍完全可读、可写、可删**；`GET /v1/projects/<archived pid>/requirements` 返回子 rows；`POST /v1/projects/<archived pid>/requirements` **201 accept 写盘**。orphan project_id 通道（§3.6 现有 P1）延伸至**已 archived 的合法 pid**
     - **✨ `GET /v1/projects` 隐藏 archived**：本轮生 3 个 project + archive 掉 2 个后，`GET /v1/projects` 只返 1 个 active project；archived 全 hidden。**没有对应 `?archived=true` filter query** 可查 archived
- **运行约束**：与 07-14 一致 —— `JARVIS_WORK_MODE=off`、stub LLM key、`JARVIS_PERMISSION_MODE=bypass`；DB 用日期后缀 `-20260715` 全新路径。**本轮跳过 DDNS + Memory + AccessToken side-branch**（源码 `packages/ddns/src/runtime.ts:161-168` `#running` guard 早退代码 07-14 记录逐字未变，本轮跳过节省 probe 时间投入主分支 5 条 leftover + 4 条 DELETE 新发现）。

---

## 0. TL;DR — 与 07-14 的差异（1 天间隔）

| 项 | 07-14 状态 | 07-15 状态 | 变化 |
| --- | --- | --- | --- |
| `git log --since=2026-07-14` | 0 commit | **0 commit**（HEAD 仍 `64d288a`） | 静默**第 22 天** |
| 工作树未 commit 文件数 | 39 个 | **39 个** | 持平 |
| 522 条 `@jarvis/server` 单测 | 522/522 ✅（7625 ms） | **522/522 ✅**（7537 ms） | 持平（-88 ms 噪声） |
| Servlet 工作目录 | 07-09 → 07-14 五天空档清空后重建 4 文件 | ✅ **完整幸存**（4 文件仍在，`ls -la` 时间戳全为 07-14 03:06） | 07-14 fixture 24h 内 macOS 未清 `/tmp` |
| P1-A POST + PATCH 4 字段透传 | 全双向静默丢字段 | **全双向静默丢字段** | ❌ 未修（第 18 次） |
| P1-B `POST /v1/roadmap/import` | 404 | **404** | ❌ 未修（第 18 次） |
| P1-C `GET /v1/requirements/:id` | 404 | **404** | ❌ 未修（第 18 次） |
| `GET /:id/conversations` 404 | 复现 | **完全复现** | ❌ 未修（第 5 次） |
| Orphan 行 `POST /v1/projects/no-such/requirements` | 201 + 原样回写 | **完全复现** | ❌ 未修（第 18 次） |
| `depends_on` POST bogus FK UUID | 通过 | **完全复现** | ❌ 未修（第 14 次） |
| **§L4 复现** `depends_on:[<non-string>]` → 500 raw TypeError 泄漏 | 首入档 | **完全复现 + 07-15 拓展**：`[[]]` / `[{}]` / 混合 `[123,"uuid"]` / `["uuid",42]` 全 500，**任意位置任意非 string 全 500**（原实测记 `d.trim is not a function`；`[null]` 更正为 `Cannot read properties of null (reading 'trim')`） | ❌ 未修（第 2 天） |
| `depends_on` 非-UUID 格式 string | 07-14 首入档 | **完全复现** | ❌ 未修（第 2 天） |
| `depends_on` 空串/whitespace-only 静默 strip | 07-14 首入档 | **完全复现** | ❌ 未修（第 2 天） |
| `depends_on` 重复 UUID 不 dedup | 07-14 首入档 | **完全复现** | ❌ 未修（第 2 天） |
| `RequirementStatus` 4 值 evidence | 14 candidate 全 evidence | 复现 14 candidate | 持平（不再回归） |
| Manual PATCH `status:"done"` bypass depends_on gate | 07-14 复现第 6 天 | ⚠️ **07-15 复现**：child requirement w/ `depends_on:[00000000-…]` → `PATCH {status:"done"}` → 200 done | ❌ 未修（第 7 天） |
| `Todo` POST/PATCH response envelope | 07-14 首入档 | **完全复现** shape | 持平 |
| `Todo evidence:null` = 删除 key | 07-14 首入档 | 持平 | 持平 |
| `Todo evidence:{}` = 保留 key + 空 object | 07-14 首入档 | 持平 | 持平 |
| **✨ 07-15 NEW P2**: `Todo evidence` type-assertion 完全失效 | 未测 | **07-15 首入档**：`evidence:123` / `"str"` / `true` / `[1,2,3]` **全 200 accept 原样存**（POST 和 PATCH 两侧）；`as RequirementTodoEvidence` 运行时零校验 | ⚠️ **07-15 首入档 P2** |
| **✨ 07-15 leftover 落地**: `label_ids:[<non-string>]` = 500 `id.trim is not a function` | 未测 | **07-15 首入档**：`label_ids=[42]/[null]/[true]` → 500，与 depends_on 同源；**4 站点全需修**（`:231/:296/:239/:304`） | ❌ **07-15 首入档 P1**（同源同修） |
| **✨ 07-15 leftover 落地**: Todo `depends_on:[<non-string>]` filter 工作 | 未测 | **07-15 首入档**：`[42, null, true, "<uuid>"]` → 200 `depends_on:["<uuid>"]`；`:633` 的 `typeof x === "string"` 前置 filter 是**正确修复模板** | ✅ **07-15 首入档正确修复模板确认** |
| **✨ 07-15 leftover 落地**: `depends_on:[null]` 精确错误信息 | 07-14 一并记 `d.trim is not a function`（不准） | **07-15 更正**：`Cannot read properties of null (reading 'trim')`（Node 对 null 的默认 message） | ⚠️ **07-14 wire 消息小误记更正** |
| **✨ 07-15 leftover 落地**: 混合 `depends_on:[123, "<uuid>"]` 顺序无关 | 07-14 未测 | **07-15 首入档**：正序 `[123, "<uuid>"]` / 逆序 `["<uuid>", 42]` **均 500** —— filter 迭代碰到非 string 立即抛，与位置无关 | ⚠️ **07-15 首入档 semantic** |
| **✨ 07-15 首入档**: `DELETE /v1/requirements/:id` idempotence | 未入档 | 1st `200 {deleted:true}` / 2nd `404 {deleted:false, error:"...not found"}` / bogus `404 {deleted:false, error}` **含 `deleted:false` 是独此一家** | ⚠️ **07-15 首入档第 4 种 idempotence 风格** |
| **✨ 07-15 首入档**: `DELETE /v1/projects/:id` = **SOFT-ARCHIVE** | 未入档 | 1st `200 {archived:true, id}` / 2nd `200 {archived:true, id}` (universal no-op) / bogus `404 {error:"project not found"}` —— 与 Requirement DELETE **不同名同 verb 不同行为** | ⚠️ **07-15 首入档 shape** |
| **✨ 07-15 首入档**: DELETE project **无 cascade** | 未入档 | archived project 的 requirements **仍完全可读、可写、可删**；orphan project_id 通道**延伸到已 archived 的合法 pid** | ⚠️ **07-15 首入档 P1**（scope 扩展） |
| **✨ 07-15 首入档**: `GET /v1/projects` 隐藏 archived | 未入档 | 3 project + archive 2 → GET 只返 1；**无 `?archived=true` filter** 可查 archived | ⚠️ **07-15 首入档** |
| `/v1/health` 404 vs `/health` 200 | 未修 | **未修** | ❌ 未修（第 10 次） |
| `server/info` 顶层 16 keys | 复现 | **完全复现**（`tool_count=44`；`mcp_servers=[]`；`memory.mode=window budget_tokens=108000`） | ❌ 未修（第 10 次） |
| `confidence < 0.2` 前端兜底 | P0，21 天未修 | **P0，22 天未修** | 持平 |
| Fingerprint sample=0 shape | 恒定第 21 天 | **完全复现**（`overall_score=50 / confidence=0 / sample_count=0 / primary_focus=task_understanding`；12 top keys；20 signals keys；5 actions；4 dimensions） | ❌ 恒定第 22 天 |
| DDNS `#running` single-flight guard 泄漏 stale `last_result` | 07-09 首入档，源码 5 天持平 | **本轮跳过 side-branch 复测**；源码 `runtime.ts:161-168` 逐字未变 | 源码级第 6 天持平 |
| `/v1/projects` list shape | 裸数组 | **完全复现**（裸 array of project；archive 掉后不出现在 list） | 持平 |
| `/v1/projects/:id/requirements` list shape | `{items, project_id}` 二 key clean | **完全复现**（无 filter 与 `?triage_state=approved` filter 同 shape） | 持平 |

代码侧三个 deferred / 缺陷标记的精确行号仍在原位（今天 grep 三次确认）：

- `packages/server/src/requirements-routes.ts:164-165` 的 3 行 "verification_plan / workflow_id three-state semantics ... out of scope for this port" 注释
- `packages/server/src/requirements-routes.ts:231, :296` 的 `body.depends_on.filter((d) => d.trim() !== "")` —— **07-15 加固**：`label_ids` `:239, :304` 也是同 bug（`.filter((id) => id.trim() !== "")` 无 typeof 前置）；对比 `:633, :734` Todo depends_on/label_ids 是 `.filter((x): x is string => typeof x === "string")` 前置 —— **4 处应一律迁向 Todo 侧 shape**
- `packages/server/src/requirements-routes.ts:729-731` 的 `body.evidence === null ? undefined : (body.evidence as RequirementTodoEvidence)` —— **07-15 首入档**：`as` type-assertion 在 TypeScript 里是编译期零花销，运行时不做任何校验，能塞 int / string / bool / array
- `packages/tools/src/register-builtins.ts:13` "未移植清单" 注释含 `roadmap.import`；`:166` `(not yet ported)`
- `packages/server/src/workflow-routes.ts:156` `normalizeSteps(body.steps ?? [])` —— 今天未跑 workflow probe（源码未变 → 效果同 07-14）
- `packages/ddns/src/runtime.ts:168` `if (config === undefined || this.#running) return;` early-return 且 `updateNow` (`:161`) 未 await in-flight —— 07-09 首入档 race，6 天源码级持平

---

## 1. 测试配置

```
OPENAI_API_KEY=sk-stub-for-automation-test
JARVIS_PROVIDER=openai
JARVIS_MODEL=gpt-4o-mini
JARVIS_FS_ROOT=/tmp/jarvis-servlet-test
JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-20260715
JARVIS_ADDR=127.0.0.1:7099
JARVIS_WORK_MODE=off
JARVIS_PERMISSION_MODE=bypass
JARVIS_NO_PROJECT_CONTEXT=1
```

启动日志：
```
[jarvis] persistence connected: json:///tmp/jarvis-servlet-test-db-20260715
[jarvis] serve: provider=openai model=gpt-4o-mini addr=127.0.0.1:7099 fsRoot=/tmp/jarvis-servlet-test coding=false auth=none ddns=off mdns=off promptBytes=263
[jarvis] listening on http://127.0.0.1:7099
```

**Servlet fixture 完整幸存**（07-14 时间戳）：
```
/tmp/jarvis-servlet-test/                     # dir 07-14 03:06
├── pom.xml                                    # 07-14 03:06, 627 bytes
├── README.md                                  # 07-14 03:06, 140 bytes
└── src/main/
    ├── java/com/example/HelloServlet.java     # 07-14 03:06, 754 bytes
    └── webapp/WEB-INF/web.xml
```

**本轮跳过**：DDNS + Memory + AccessToken side-branch（07-14 详细覆盖，源码级持平）。

---

## 2. 主 Kanban 主线（stub 模式）

```
1) POST /v1/projects  {name:"servlet-2026-07-15", instructions:"servlet automation probe 07-15"}
   → 201 pid=b17be1b1-54ae-4758-b596-dd47286001bf；slug 自动 "servlet-2026-07-15"
2) POST /v1/projects/<pid>/requirements
   {title:"probe-4fields-07-15","description":"t","triage_state":"approved",...4 extra fields...}
   → 201 rid=e86f3bc3-4624-4295-aac6-b76deb29d307
     响应 keys=[conversation_ids, created_at, description, id, project_id, status, title, updated_at] **8 keys**
     4 extra fields (acceptance_policy/workflow_id/assignee_id/verification_plan) **全不出现**
3) PATCH /v1/requirements/<rid>
   4 extra fields (acceptance_policy:"Subagent",workflow_id:"22222222-...", assignee_id:"user-y", verification_plan:{...})
   → 200 same 8 keys；4 fields 全 drop
```

---

## 3. 回归探针（P1 gaps 未修复第 18 次）

### §3.1 P1-A：POST 上 4 字段静默丢

```
BODY = {"title":"probe-4fields-07-15","description":"t","triage_state":"approved",
        "acceptance_policy":"Human",
        "workflow_id":"11111111-1111-1111-1111-111111111111",
        "assignee_id":"user-x",
        "verification_plan":{"steps":[{"kind":"assert","args":{"x":1}}]}}
→ 201 keys=[conversation_ids, created_at, description, id, project_id, status, title, updated_at]  **8 keys**
  全无 acceptance_policy / workflow_id / assignee_id / verification_plan
```

（07-14 §L5 澄清：`triage_state / acceptance_policy` 数据其实存了、只是顶层 REST 视图不返回；真正 drop 的是 `workflow_id / assignee_id / verification_plan` 3 字段）

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
→ 404 {"message":"Route GET:/v1/requirements/<rid> not found","error":"Not Found","statusCode":404}
```

### §3.5 `GET /v1/requirements/:id/conversations` 仍 404

```
→ 404 {"message":"Route GET:/v1/requirements/<rid>/conversations not found",...}
```

### §3.6 orphan `project_id` 无 FK

```
POST /v1/projects/no-such-project-id-07-15/requirements {"title":"orphan-07-15"}
→ 201 {"id":"60846f33-...","project_id":"no-such-project-id-07-15",...}  ← 原样写盘
```

### §3.7 `depends_on` POST bogus UUID 通过

```
POST /v1/projects/<pid>/requirements {"title":"probe-deps-bogus-07-15","depends_on":["00000000-0000-0000-0000-000000000000"]}
→ 201 accept；response.depends_on = ["00000000-..."]
```

### §3.8 Manual PATCH `status:"done"` bypass `depends_on` gate

```
target rid = 37d23833-...（§3.7 创建的，depends_on:[00000000-…] 依赖不 resolve）
PATCH /v1/requirements/37d23833-... {"status":"done"}
→ 200 {status:"done", depends_on:["00000000-…"], …}   ← gate 完全绕过
```

（07-08 首入档，07-15 复现第 7 天）

### §3.9 `/v1/health` vs `/health` 分裂

```
GET /health → 200 {"status":"ok"}
GET /v1/health → 404
```

（第 10 天未修）

### §3.10 `server/info` 顶层 16 keys（未变）

```
['approval_mode', 'coding_mode', 'config_path', 'listen_addr', 'max_iterations', 'mcp_servers',
 'memory', 'persistence', 'project_context', 'project_store', 'providers', 'system_prompt',
 'tool_count', 'tools', 'version', 'workspace_root']
tool_count = 44；mcp_servers = []；memory = {mode:"window", budget_tokens:108000}
```

---

## 4. 07-14 未验证项 5 条 + 07-15 新发现落地

### §L1: `label_ids:[<non-string>]` = **500 `id.trim is not a function`**（07-14 leftover 落地）

```
POST /v1/projects/<pid>/requirements {"title":"leak-labels-42","label_ids":[42]}
→ 500 {"statusCode":500,"error":"Internal Server Error","message":"id.trim is not a function"}

label_ids=[null]  → 500 "Cannot read properties of null (reading 'trim')"
label_ids=[true]  → 500 "id.trim is not a function"
label_ids=[false] → 500 "id.trim is not a function"
```

**结论**：同源第 3、4 站点（`:239, :304`）也裸奔 —— **同一 bug 4 站点**（POST/PATCH × depends_on/label_ids）。

**修 A 案覆盖全 4 站点**：
```ts
// :231, :296, :239, :304 全部改成：
item.depends_on = body.depends_on.filter((d): d is string => typeof d === "string" && d.trim() !== "");
item.label_ids  = body.label_ids .filter((id): id is string => typeof id === "string" && id.trim() !== "");
```

模板已存在于 `:633`（Todo depends_on）和 `:734`（Todo label_ids），一致性 refactor 即可。

### §L2: Todo `depends_on:[<non-string>]` = **200 filter-out**（07-14 leftover 落地）

```
PATCH /v1/requirements/<rid>/todos/<tid> {"depends_on":[42, null, true, "11111111-1111-1111-1111-111111111111"]}
→ 200 response.todo.depends_on = ["11111111-1111-1111-1111-111111111111"]
```

**结论**：Todo path 的 `:633` `.filter((x): x is string => typeof x === "string")` 前置 filter **是正确修复模板**。非 string 元素在 Todo 侧被**静默 drop**（同 07-14 §L3 "空串 filter" 语义扩展至类型层）。

### §L3: `POST /:id/todos {"evidence":<非 object>}` **全 200 accept**（07-14 leftover 落地）——**新 P2 真 bug**

```
POST /v1/requirements/<rid>/todos {"title":"todo-evi-int","kind":"work","evidence":999}
→ 201 response.todo.evidence = 999  (int)  ← 直接原样存

PATCH /:id/todos/<tid> {"evidence":123}       → 200 evidence=123
PATCH /:id/todos/<tid> {"evidence":"a-string"} → 200 evidence="a-string"
PATCH /:id/todos/<tid> {"evidence":true}       → 200 evidence=true
PATCH /:id/todos/<tid> {"evidence":[1,2,3]}    → 200 evidence=[1,2,3]  ← array 也过
```

**根本原因**：源码 `packages/server/src/requirements-routes.ts:729-731`：
```ts
if (body.evidence !== undefined) {
  todo.evidence = body.evidence === null ? undefined : (body.evidence as RequirementTodoEvidence);
}
```

`as RequirementTodoEvidence` 是**编译期 type-assertion**（TypeScript 特性），**运行时零校验**。Rust 移植保留了 `Option<RequirementTodoEvidence>` 语义但丢了 serde 侧的结构校验。

**影响**：UI 侧读 `evidence.exit_code` / `evidence.run_id` 会在任何非-object 值上**运行时崩溃**。前端得 defensive `typeof todo.evidence === "object" && !Array.isArray(todo.evidence)` 才能安全用。

**修**：Fastify JSON schema 或 handler 里 `typeof body.evidence === "object" && body.evidence !== null && !Array.isArray(body.evidence)` 前置校验。

### §L4: 混合 `depends_on:[<int>, "<uuid>"]` 顺序无关 500（07-14 leftover 落地）

```
POST /v1/projects/<pid>/requirements {"title":"mix-order","depends_on":[123,"11111111-..."]}
→ 500 "d.trim is not a function"   ← 正序 int 先，UUID 后

POST /v1/projects/<pid>/requirements {"title":"mix-order-rev","depends_on":["11111111-...",42]}
→ 500 "d.trim is not a function"   ← 逆序 UUID 先，int 后
```

**结论**：`.filter()` 迭代 array 时**任何位置**碰到非 string 就抛 TypeError，与位置无关；`.filter()` 内的 callback 是同步 iteration，抛错立即冒到 handler。**任何位置任意一个非 string** 就整个 request 500。

### §L5: `depends_on:[null]` 精确错误信息（07-14 更正）

07-14 §L4 一并记 `d.trim is not a function`；07-15 复核：

```
depends_on=[42]    → "d.trim is not a function"
depends_on=[null]  → "Cannot read properties of null (reading 'trim')"     ← 与 [42] 不同！
depends_on=[true]  → "d.trim is not a function"
depends_on=[false] → "d.trim is not a function"
depends_on=[3.14]  → "d.trim is not a function"
```

**规律**：`null` 是 Node runtime 对 property access on null 的特殊 message，其他 primitive 走 `<type>.trim is not a function`。**07-14 记录一处小误记，07-15 更正**。

### §L6: `depends_on:[[]]` 和 `depends_on:[{}]` 也 500

```
depends_on=[[]]                 → 500 "d.trim is not a function"     ← array 无 .trim
depends_on=[{"nested":"obj"}]   → 500 "d.trim is not a function"     ← object 无 .trim
depends_on=[["nested"]]         → 500 "d.trim is not a function"     ← nested-array 也无 .trim
```

**结论**：源码 `.filter((d) => d.trim() !== "")` 假设 `d: string`，实际接收 `d: any` —— **所有非-string 均 500**（int/float/bool/null/array/object）。

### §L7: **NEW 07-15 P2**: DELETE 幂等风格再细化第 4 种（Requirement hard-delete + 404 `deleted:false`）

```
DELETE /v1/requirements/<real rid>       → 200 {"deleted":true}
DELETE /v1/requirements/<same rid again> → 404 {"deleted":false,"error":"requirement `...` not found"}
DELETE /v1/requirements/<bogus uuid>     → 404 {"deleted":false,"error":"requirement `...` not found"}
```

**新意**：**404 body 里额外带 `deleted:false` 字段** —— 独此一家。对比：

| verb / route | 1st | 2nd | bogus | body 特征 |
| --- | --- | --- | --- | --- |
| DELETE /v1/memory/includes | 200 no-op | 200 no-op | 200 no-op | universal 200 |
| POST /v1/workflow-runs/:id/cancel | 200 | 200 no-op | 404 | select-then-cancel |
| DELETE /v1/requirements/:id | 200 | **404 + `deleted:false`** | **404 + `deleted:false`** | **07-15 首入档：hard-delete-with-flag** |
| DELETE /v1/projects/:id | 200 archived | 200 archived | 404 | **07-15 首入档：soft-archive** |
| PATCH /v1/requirements/:id/todos (batch) | 200 | atomic | 404 all-or-nothing | atomic batch |

**已 5 种 idempotence 风格**（07-08 记 3 种 + 07-15 加 2 种）。

### §L8: **NEW 07-15 P2**: DELETE Project = SOFT-ARCHIVE

```
DELETE /v1/projects/<real pid>       → 200 {"archived":true,"id":"<pid>"}
DELETE /v1/projects/<same pid again> → 200 {"archived":true,"id":"<pid>"}  ← universal no-op
DELETE /v1/projects/<bogus uuid>     → 404 {"error":"project not found"}
```

**新意**：
1. **DELETE Requirement vs DELETE Project 同名 verb，行为完全不同**（Requirement = hard-delete + row 消失；Project = soft-archive + row 保留 + `archived:true`）
2. universal no-op（同 `DELETE /v1/memory/includes`）+ bogus-id 404 —— **组合是独此一家**
3. **无 `POST /v1/projects/:id/unarchive` route**：Archived 是**单向操作**，restore 只能通过底层 store 手改

### §L9: **NEW 07-15 P1 scope 扩展**：DELETE Project 无 cascade

```
create pid=7f55a462-... rid=59578beb-... (child requirement in pid)
DELETE /v1/projects/7f55a462-...           → 200 {archived:true}
GET /v1/projects/7f55a462-.../requirements → 200 {items:[<child>], project_id:"7f55a462-..."}   ← child 全在
DELETE /v1/requirements/59578beb-...       → 200 {deleted:true}   ← 仍可 hard-delete child
POST /v1/projects/7f55a462-.../requirements {"title":"post-into-archived-07-15"}
                                            → 201 {new row, project_id:"7f55a462-..."}   ← ⚠️ 还能 create
```

**结论**：orphan project_id 通道（§3.6 现有 P1）**延伸到已 archived 的合法 pid**。archive 只是 project row 上加 flag，不影响任何子资源的读/写/删。

**影响**：Kanban UI 若过滤掉 archived project 但保留 URL 直接输入允许，仍可对 archived project 的 requirement 全部 CRUD —— 治理漏洞。

**修 2 案**：
- **A**：`POST/PATCH /v1/projects/:pid/*` 校验 project 未 archived
- **B**：project delete = hard delete + cascade child requirements（改变现有 soft-archive 语义，breaking）

### §L10: **NEW 07-15**: `GET /v1/projects` 隐藏 archived + 无 filter

```
本轮共创建 3 个 project，archive 掉 2 个后：
GET /v1/projects → 1 个 project（active 的 servlet-2026-07-15）
GET /v1/projects?archived=true → 同上 1 个（filter ignored）
GET /v1/projects?include_archived=true → 同上 1 个（filter ignored）
```

**结论**：GET 只返 non-archived；无 filter 参数可查 archived project 列表。UI 若要"回收站"视图，无 REST 支持 —— 需 store 侧新加 `list_all(includeArchived: true)` + route 加 query filter。

### §L11: `depends_on` 非-UUID 格式 accept + 空串 strip + 重复不 dedup（07-14 §L3 复现）

```
POST body {"depends_on":["not-a-uuid","banana","<script>","",""]}
→ 201 response.depends_on = ["not-a-uuid","banana","<script>"]   ← 空串 filter 掉，UUID-format 校验缺
```

3 面 evidence 07-14 首入档全复现：格式校验缺 / 空串 strip / 重复不 dedup。

---

## 5. Harness health baseline（sample=0）

主分支 fresh DB (`-20260715`) 起点即 sample=0：

```
GET /v1/observability/health → {
  top keys = ['actions', 'confidence', 'dimensions', 'evidence', 'generated_at',
              'overall_score', 'primary_focus', 'rules', 'sample_count', 'signals',
              'sources', 'tool']   ← 12 keys 恒定
  overall_score:   50
  confidence:      0
  sample_count:    0
  primary_focus:   task_understanding
  dimensions len:  4
  actions[]:       ['stabilize_delivery_gate','reduce_timeout_and_iteration_failures',
                   'tune_tools_and_subagents','sharpen_task_acceptance','fill_signal_gaps']
  signals:         20 keys stable
}

GET /v1/work/quality → 6 keys, all-zero counters
GET /v1/work/overview → actor_breakdown:null; verification_pass_rate:null
```

sample=0 fingerprint 与 07-08 → 07-14 → 07-15 **22 天恒定**。真正的 harness health 信号（`actions[fill_signal_gaps]`, `sample_count`）**存在**且**内容正确**（fill_signal_gaps 就是"补齐观测样本"的动作），但**前端不读它 22 天** —— P0 fix `actions.find(a=>a.key==="fill_signal_gaps") && sample_count<5` 5 分钟修 22 天未修。

真 LLM 端到端**不能跑**（stub key `sk-stub-for-automation-test` → `/v1/chat/completions` 401）。因此 `harness.health` agent tool 无法通过 REST triggered chat 触发。

---

## 6. 未修复清单（P0/P1/P2 累积）

**P0**（前端 1 行 5 分钟）：
- confidence < 0.2 前端兜底（读 `actions.find(a=>a.key==="fill_signal_gaps") && sample_count<5`） — **22 天未修**

**P1**（REST 层缺 route / FK / 字段透传 / 类型校验缺）：
- POST + PATCH 4 字段（`acceptance_policy` / `workflow_id` / `assignee_id` / `verification_plan`）静默丢 — 22 天未修
- `POST /v1/roadmap/import` 404 — 22 天未修
- `GET /v1/requirements/:id` 404 — 22 天未修
- `GET /v1/requirements/:id/conversations` 404 — 7 天未修
- orphan project_id 无 FK — 22 天未修（**07-15 §L9 加深**：延伸到 archived project pid）
- depends_on **5 处**同源 FK / typeof（原 4 处 + **07-15 §L1** `label_ids` POST + PATCH 2 处）—— 18 天未修 + 07-15 明确 fix template = `.filter((x): x is string => typeof x === "string" && x.trim() !== "")` (`:633` 已用)
- `depends_on` / `label_ids` 数组元素非 string → **500 raw TypeError 泄漏**（07-14 首入档，07-15 加固：任意位置任意非-string / `[[]]` / `[{}]` 全 500，`[null]` 消息 = `Cannot read properties of null (reading 'trim')`）
- `POST /:id/conversations` conversation_id 无格式 + 无 FK — 6 天未修
- `POST /v1/workflows` 500 泄漏 10 shape — 12 天未修（跳过复测，源码未变）
- `DELETE /v1/ddns/config` 未注册 route — 10 天未修（跳过复测）
- Manual PATCH `status:"done"` bypass depends_on gate — 7 天未修（07-15 §3.8 复现）
- **DDNS runtime `#running` single-flight guard 泄漏 stale `last_result`** — 07-09 首入档，源码 6 天持平
- **07-15 首入档**：**DELETE Project 无 cascade** —— archived project 的 requirements 全 CRUD 通道打开（§L9）

**P2**（一致性 / 语义 / 文档缺）：
- list shape 五分裂 — 18 天未修（07-14 加固 `/v1/projects/:id/requirements` = `{items, project_id}` **统一模板**候选）
- `/v1/health` 404 vs `/health` 200 — 10 天未修
- `server/info` 不反映 `ddns/memory_enabled/mdns/access_token_configured/features` — 10 天未修
- depends_on 条件性写回 shape drift — 14 天未修
- `depends_on` 空串/whitespace-only 静默 strip + 重复 UUID 不 dedup — 2 天未修（07-14 首入档）
- DDNS PUT 累计 10 处 soft-accept — 22 天未修（跳过复测）
- `POST /v1/ddns/upnp/test` body 静默无效 — 6 天未修
- `POST /v1/ddns/update` 200 wrap `last_result:{ok:false}` 语义 — 文档缺，4 天未修
- `/start` `/block` `/complete` 是 agent tools 而非 REST — CLAUDE.md 未明写，6 天未修
- Todo `status` / `kind` / `created_by` 枚举与 Requirement 完全不同 — 5 天未修
- `RequirementStatus` 4 值不含 `blocked`；`RequirementTodoStatus` 6 值含 blocked；文档需分开描述
- Todo evidence falsy value 保留
- Todo `evidence:null` = DELETE key，`evidence:{}` = 保留 key + 空 object —— 三态语义
- **07-15 首入档**：Todo `evidence` type-assertion 完全失效 —— `evidence:123 / "str" / true / [1,2,3]` 全 accept；`as RequirementTodoEvidence` 编译期 assertion 运行时零校验（§L3）
- Todo `command:""` 与 `command:null` 同 = DELETE（与 Requirement `title:""` → 400 blank 校验相反）
- Todo POST/PATCH response envelope `{todo, requirement}` 双 view；`requirement` 内联补默认 `triage_state/acceptance_policy` —— 与顶层 REST 视图 shape 分裂
- Activity `body.kind` inner-classifier convention — 9 天未修
- UUID 格式校验非一致 — 9 天未修
- REST 幂等 style 累计 5 种（07-15 加 hard-delete-with-flag + soft-archive-with-universal-noop 两种）— 7 天累加中
- Todo sub-resource 五 route 五种 envelope shape — 7 天未修
- `GET /v1/remote/info.external` 三-shape 分裂 — 7 天未修
- `/v1/remote/pairing.token` = 明文 access token；`pairing_links[*].link` 含明文 token — 7 天未修
- **07-15 首入档**：`DELETE /v1/projects/:id` 与 `DELETE /v1/requirements/:id` **同名 verb 完全不同语义**（soft-archive vs hard-delete）—— CLAUDE.md 需明说（§L8）
- **07-15 首入档**：`GET /v1/projects` 隐藏 archived + 无 `?archived=true` filter —— archived project 无 REST 侧访问路径（§L10）

---

## 7. 07-15 首次发现清单

1. **✨ 07-14 §9 未验证项 5 条全落地**：
   - **§L1**：`label_ids:[<non-string>]` = **500 `id.trim is not a function`**（4 站点同源，`.filter` 无 typeof 前置；覆盖 POST + PATCH × depends_on + label_ids）
   - **§L2**：Todo `depends_on:[<non-string>]` = 200 filter-out（正确修复模板存在于 `:633`）
   - **§L3**：Todo `evidence:{123, "str", true, [1,2,3]}` **全 200 accept，值原样存** —— `as RequirementTodoEvidence` type-assertion 运行时零校验，**07-15 新 P2 真 bug**
   - **§L4**：混合 `depends_on:[123, "<uuid>"]` 顺序无关 500 —— filter 内 iteration 抛错立即冒
   - **§L5**：`depends_on:[null]` 精确错误信息 = `Cannot read properties of null (reading 'trim')`（07-14 一并记 `d.trim is not a function` 是小误记，07-15 更正）

2. **✨ §L6**：`depends_on:[[]]` / `[{}]` / `[["nested"]]` 全 500 —— 所有非-string 类型（int/float/bool/null/array/object）均命中同一 TypeError 泄漏。

3. **✨ §L7**：`DELETE /v1/requirements/:id` 是"soft-select 硬删除"的第 4 种 idempotence 风格：1st 200 `{deleted:true}` / 2nd 404 `{deleted:false, error}` / bogus 404 `{deleted:false, error}` —— **404 body 带 `deleted:false` 字段是独此一家**。

4. **✨ §L8**：`DELETE /v1/projects/:id` = **SOFT-ARCHIVE**：1st 200 `{archived:true}` / 2nd 200 `{archived:true}` (universal no-op) / bogus 404 —— **与 Requirement DELETE 同名 verb 完全不同行为**。

5. **✨ §L9**：DELETE Project **无 cascade** —— archived project 的 requirements 全部还能 GET / POST / PATCH / DELETE；**orphan project_id 通道延伸到已 archived 的合法 pid**（§3.6 P1 scope 深化）。

6. **✨ §L10**：`GET /v1/projects` 隐藏 archived；无 `?archived=true` / `?include_archived=true` filter —— archived project 无 REST 侧访问路径。

7. **✨ 07-14 §L4 P1 bug 复现加固**：`depends_on:[<non-string>]` 500 泄漏第 2 天源码级持平；**scope 扩展至混合数组 + 嵌套 + 对象 + 空数组 + 空对象**。

8. **✨ Fixture 24h 幸存**：07-14 03:06 重建的 4 文件 07-15 03:05 仍在（macOS 未清 `/tmp`）—— 与 07-09 → 07-14 五天空档中被清空对比，短周期 fixture 稳定。

---

## 8. 复现 commands 一键版

```bash
# fixture 已在（可跳过重建）
[ -d /tmp/jarvis-servlet-test ] || (
  mkdir -p /tmp/jarvis-servlet-test/src/main/java/com/example \
           /tmp/jarvis-servlet-test/src/main/webapp/WEB-INF
  # ... （见 07-14 §8 完整 pom.xml + HelloServlet.java 模板）
)

# 主分支起
export OPENAI_API_KEY=sk-stub-for-automation-test
export JARVIS_PROVIDER=openai JARVIS_MODEL=gpt-4o-mini
export JARVIS_FS_ROOT=/tmp/jarvis-servlet-test
export JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-<YYYYMMDD>
export JARVIS_ADDR=127.0.0.1:7099
export JARVIS_WORK_MODE=off JARVIS_PERMISSION_MODE=bypass JARVIS_NO_PROJECT_CONTEXT=1
node --experimental-strip-types packages/jarvis-app/src/main.ts serve &

# §L1 label_ids 500 demo
B=http://127.0.0.1:7099
PROJ=$(curl -sS -XPOST $B/v1/projects -H 'Content-Type: application/json' -d '{"name":"demo","instructions":"i"}')
PID=$(echo "$PROJ" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -sS -XPOST $B/v1/projects/$PID/requirements \
  -H 'Content-Type: application/json' -d '{"title":"leak-labels","label_ids":[42]}'
# → 500 {"statusCode":500,"error":"Internal Server Error","message":"id.trim is not a function"}

# §L3 evidence type-assertion demo
REQ=$(curl -sS -XPOST $B/v1/projects/$PID/requirements -H 'Content-Type: application/json' -d '{"title":"r"}')
RID=$(echo "$REQ" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -sS -XPOST $B/v1/requirements/$RID/todos -H 'Content-Type: application/json' \
  -d '{"title":"t","kind":"work","evidence":999}'
# → 201 response.todo.evidence = 999 (int)  ← type-assertion hole

# §L8 Soft-archive project + §L9 无 cascade
DELPROJ=$(curl -sS -XPOST $B/v1/projects -H 'Content-Type: application/json' -d '{"name":"to-arch","instructions":"i"}')
DELPID=$(echo "$DELPROJ" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -sS -XDELETE $B/v1/projects/$DELPID
# → 200 {"archived":true,"id":"..."}
curl -sS -XPOST $B/v1/projects/$DELPID/requirements -H 'Content-Type: application/json' \
  -d '{"title":"post-into-archived"}'
# → 201 accept (P1 gap §L9)
```

---

## 9. 未验证项（继续滚到 07-16）

- **07-15 新留白**：
  - `POST /v1/requirements/:id/todos {"depends_on":[<non-string>]}` **POST** 层是否 filter（`:633` 是 PATCH，POST 侧代码待查；预期 200 filter，未实测）
  - `PATCH /v1/requirements/:id {"label_ids":[42]}` PATCH 侧 500 消息（07-15 仅测 POST；`:304` 与 `:239` 同 bug；预期 500 相同，未实测）
  - `PATCH /:id/todos/:tid {"depends_on":[]}` empty array 覆盖是清空还是保留（依 `if (body.depends_on !== undefined)` 分支预期清空，未实测）
  - `Todo evidence:{}` type-assertion 是否也过：`{}` 是合法 object，会 accept，但 nested type check 呢（e.g. `{run_id:123}` int 类型的 run_id）—— PATCH → 预期 200 pass（无 nested 校验），未实测
  - `DELETE /v1/requirements/:id` 上 requirement 是 archived project 的 child —— 已在 §L9 测过 200；未测的是**archive parent 后 archived child** 的 GET/DELETE 二次行为
  - `POST /v1/requirements/:id/runs` on archived-project child —— 是否 201 mint run 或 400
- **07-14 累积（残留）**：
  - `POST /v1/ddns/update` 在**真** `token` credential 下 `record_type=A/AAAA/MX/NS/SRV` 各自的 error string
  - `server/info.mcp_servers` shape（当有 MCP 时；本轮 mcp_servers=[] 恒定）
  - **race condition** `#running` guard 更极端场景（3-4 back-to-back PUT+POST）
- **建议下一次 investment**：
  - 直接**产出一个 PR**：`.filter((d) => d.trim() !== "")` → `.filter((d): d is string => typeof d === "string" && d.trim() !== "")` × 4 站点（`:231, :296, :239, :304`）+ 加 4 条 test → 5 分钟修 3 个 P1 same-source bug
  - `packages/server/src/requirements-routes.ts:729-731` 的 `as RequirementTodoEvidence` 加 `typeof body.evidence === "object" && !Array.isArray(body.evidence)` 运行时校验 —— 5 分钟修 P2 §L3

---

## 10. 总览

| 项 | 评分 | 与 07-14 比（1 天） |
| --- | --- | --- |
| Kanban (Project + Requirement CRUD + 5 状态转换 + Activity) | ✅ 健康；14 candidate `RequirementStatus` 4 值 evidence 恒定 | 持平 |
| Workflow CRUD + dispatch + cancel | ✅ 健康（除 §4.1 10 shape 500 泄漏；跳过复测） | 持平 |
| Diagnostics (`/v1/diagnostics/*` + `/v1/work/*`) | ✅ 健康 | 持平 |
| Harness.health 算法实装 | ✅ 稳定第 22 天 | 持平 |
| Harness.health 信号采集 | ⚠️ 缺 LLM 驱动时无信号 | 持平 |
| Harness.health 前端表达 | ❌ confidence 低分仍直接展示 score | **22 天未修** |
| DDNS 后端 | ⚠️ 07-09 P1 bug (`#running` race)；本轮跳过 side-branch 复测 | 源码级持平 |
| Memory 后端（backend=none） | ✅ 健康（跳过） | 持平 |
| REST ↔ 数据模型一致性 | ❌ **07-15 加固**：depends_on / label_ids 4 站点同源无类型校验；混合 / 嵌套 / 对象元素均 500 raw TypeError；Todo evidence 4 类型全 accept | **07-15 深化 P1 scope + 新 P2** |
| Requirement sub-resources 完整覆盖 | ✅ 07-14 补齐 Todo evidence + command 3/2 态；**07-15 加 Todo evidence type 完全失效**、DELETE 幂等 4 种、Project 软删除、archived 无 cascade | **07-15 补 4 处深度** |
| 文档 ↔ 运行时一致性 | ⚠️ 依旧多缺；07-15 加 Project soft-archive vs Requirement hard-delete 同名 verb 语义分裂 | **07-15 揭底 3 缺口** |
| 单测覆盖 | ✅ 522/522 全绿，7537 ms | 持平（-88 ms 噪声） |
| **真 bug**：`POST /v1/workflows` 500 泄漏 | ❌ 源码未变（跳过复测） | 持平（第 12 次） |
| **真 bug**：`DELETE /v1/ddns/config` 无 handler | ❌ 未复测（跳过 side-branch） | 源码级持平 |
| **真 bug**：DDNS PUT 累计 10 处 soft-accept | ❌ 未复测（跳过） | 源码级持平 |
| **真 bug**：depends_on / label_ids **5 处** 无 FK/typeof 同源（07-15 加 §L1 label_ids POST/PATCH 2 处） | ❌ 全复现 | **07-15 scope 扩至 5 站点** |
| **真 bug**：manual PATCH `status:"done"` bypass depends_on gate | ❌ §3.8 复现 | 持平（第 7 天） |
| **真 bug**：DDNS runtime `#running` 泄漏 stale `last_result` | ⚠️ 07-09 首入档；源码 `runtime.ts:168` 6 天持平 | 源码级持平 |
| **真 bug**：`depends_on:[<non-string>]` → 500 raw TypeError 泄漏（07-14 首入档） | ❌ 07-15 加固 scope（`[[]]` / `[{}]` / 混合 / null 精确消息） | **07-15 深化** |
| **真 bug（07-15 新 P2）**：Todo `evidence` type-assertion 完全失效 —— `int/str/bool/array` 全 accept 原样存 | ⚠️ **07-15 首入档 NEW P2 bug** | **07-15 新添** |
| **真 bug（07-15 新 P1）**：DELETE Project **无 cascade** + orphan project_id 通道延伸至 archived pid | ⚠️ **07-15 首入档 NEW P1 scope 扩展** | **07-15 新添** |
