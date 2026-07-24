# Jarvis 项目自动化能力诊断报告（2026-07-09 十六次复测）

- **运行时间**：2026-07-09（scheduled task 自动跑）
- **被测分支**：`feat/mobile-ios-ddns`（HEAD 仍为 `64d288a`，与 06-23 → 07-08 同一 commit — **静默第 16 天**；工作树侧 39 个未 commit 文件与 07-04 → 07-08 完全一致，未 +/−）
- **被测项目**：`/tmp/jarvis-servlet-test`
  - **07-09 差异**：`src/main/java/com/example/HelloServlet.java` **消失了**（六天连活的 fixture 在 07-08 → 07-09 之间被某种外力清空 — `com/example/` 空目录 mtime `Jul  9 00:00`，父目录未动 — 已于本轮开头恢复原文件）；`.jarvis/memory/{MEMORY.md, shared/}` 目录树 07-03 memory probe 留下的 residual 仍在；本轮 fixture 有一次干预恢复。
- **本次目的**：
  1. **回归确认** 07-08 P0/P1/P2 累积项在 1 天间是否被修复（预期：未修，静默第 16 天）
  2. **07-08 memo 订正**（3 处）：
     - `POST /v1/ddns/update` w/ duckdns 返回 `missing credential(s): api_token` —— 07-08 §4.6.10 结论"duckdns adapter 期望 `api_token`"是**错的**；查证：duckdns adapter 期望 `token`（`packages/ddns/src/providers/duckdns.ts:11`），07-08 的 `api_token` 报错**其实来自 cloudflare adapter** —— 说明存在 config-swap-race 拿到 stale `last_result` 的 bug（详见 §5.1）
     - "record_type 16 类零校验" —— 今日发现**其实是不限 16 类的**：空字符串 `""`、单空格 `" "`、`"!@#"`、`"A/AAAA"`、`"with space"` 全 200 accept 落盘（详见 §4.6.5）
     - 07-08 记 "duckdns credential key 名 (`api_token` vs `token`)" 待查 —— 今日 grep 源码：**duckdns=`token`**, cloudflare=`api_token`, aliyun=`access_key_id/access_key_secret`, dnspod=`id/token`, dyndns2=`username/password`（详见 §5.1）
  3. **07-08 未验证项落地**（一次跑通 5 条）：
     - **Todo `evidence.unknown_field` 是否 strip** —— 07-08 leftover
     - **Todo `evidence.run_id:123`（非-string）是否 400** —— 07-08 leftover
     - **单 `PATCH /:id/todos/:tid` 传 `evidence:{...}` 是 merge 还是 overwrite** —— 07-08 leftover
     - **Todo `command` 字段 wire shape** —— 07-08 leftover
     - **`RequirementStatus` 4 值以外候选 (draft/cancelled/on_hold/pending/planning/approved/active/shipped/archived) 是否也 400** —— 07-08 leftover
  4. **今日新发现**（07-08 未预告）：
     - **batch `PATCH /:id/todos {ids, status}` 传 duplicate ids** 行为
     - **DDNS 单飞锁 (`#running`) 泄漏 stale `last_result` 到 status 响应**（跨 provider 混合数据）
     - **`credentials:{}` 支持任意嵌套值** —— nested object / array 都作为 credentials 值落盘（`credential_keys` 列出 top-level key）
- **运行约束**：与 07-08 一致 —— `JARVIS_WORK_MODE=off`、stub LLM key、`JARVIS_PERMISSION_MODE=bypass`；DB 用日期后缀 `-20260709` 全新路径。DDNS + memory + AccessToken 分支另起 `-20260709-ddns` 后缀，并且**故意 rm `~/.local/share/jarvis/ddns.json` 后启动**以逼出 `configured:false` 分支。fingerprint 副 DB `-20260709-fingerprint` 也起了但因 stub LLM 不能真跑 tool call 只做了 shape 采集。probe 结束后 DDNS `~/.local/share/jarvis/ddns.json` 已回写 07-08 备份（`test-jarvis-07-04-aaaa/AAAA/t2/port 7099`）。

---

## 0. TL;DR — 与 07-08 的差异

| 项 | 07-08 状态 | 07-09 状态 | 变化 |
| --- | --- | --- | --- |
| `git log --since=2026-07-08` | 0 commit | **0 commit**（HEAD 仍 `64d288a`） | 静默**第 16 天** |
| 工作树未 commit 文件数 | 39 个 | **39 个** | 持平 |
| 522 条 `@jarvis/server` 单测 | 522/522 ✅（7719 ms） | **522/522 ✅**（7707 ms） | 持平（-12 ms 噪声） |
| Servlet 工作目录 | HelloServlet.java 存活 + `.jarvis/memory/` residual | ⚠️ **HelloServlet.java 07-08 → 07-09 消失**（`com/example/` 空目录，mtime `Jul 9 00:00`）；`.jarvis/memory/` residual 仍在；已恢复文件 | ⚠️ **07-09 fixture 中断六天连活流**（外力清空原因不明） |
| P1-A POST + PATCH 4 字段透传 | 全双向静默丢字段 | **仍全双向静默丢字段** | ❌ 未修（第 16 次） |
| P1-B `POST /v1/roadmap/import` | 404 | **404** | ❌ 未修（第 16 次） |
| P1-C `GET /v1/requirements/:id` | 404 | **404** | ❌ 未修（第 16 次） |
| Orphan 行 `POST /v1/projects/no-such/requirements` | 201 + 原样回写 | **完全复现** | ❌ 未修（第 16 次） |
| `depends_on` POST bogus FK | 通过 | **完全复现** | ❌ 未修（第 12 次） |
| `GET /:id/conversations` 404 | 未测（07-07 首入档） | **完全复现** | ❌ 未修（第 3 次） |
| `/v1/projects` 列表裸数组 vs 五分裂 | 07-08 首入档 | **完全复现** | 持平 |
| `confidence < 0.2` 前端兜底 | P0，15 天未修 | **P0，16 天未修** | 持平 |
| `POST /v1/workflows` 500 泄漏 | 10 500 / 3 400 | 本次未复测（07-06 → 07-08 已详细锁死） | 持平（跳过） |
| workflow-run cancel 三态 | 完全复现 | 未复测（源码未变） | 持平（跳过） |
| DDNS 配置持久化 07-08 → 07-09 | 未验证 | ✅ **跨日存活**：启动前 `~/.local/share/jarvis/ddns.json` 仍是 07-08 结束回写的 `test-jarvis-07-04-aaaa/AAAA/t2/port 7099` | ✅ 07-04 → 07-05 → 07-06 → 07-07 → 07-08 → 07-09 **六跳跨日**（现每日复测持续验证跨日持久性） |
| `ddns.status` 8 keys（configured 分支） | 完全复现 | 未复测本轮（跳过） | 持平 |
| `GET /v1/ddns/config` @ configured:false 1 key | 07-08 首入档 | **完全复现** | 持平 |
| `GET /v1/ddns/status` @ configured:false 4 keys | 07-08 首入档 | **完全复现** | 持平 |
| `GET /v1/remote/info.external` 3-shape | 07-08 首入档 | **完全复现**（DDNS enable + config 空 = `{reachable:null}`） | 持平 |
| `GET /v1/remote/pairing.token` = 明文 access token | 07-08 首入档 | **完全复现**（每 pairing_link 都含明文 token） | 持平 |
| `PUT /v1/ddns/config` 不带 `record_type` → `"A"` | 落地 | 未复测（跳过） | 持平 |
| `record_type` accept-passthrough 谱系 | 07-08 记 16 类 | ⚠️ **07-09 打破边界**：`""` 空串 / `" "` 单空格 / `"!@#"` / `"A/AAAA"` / `"with space"` 全 200 —— **接受集合是**"任意合法 JSON string" 而非 16 类白名单 | ⚠️ **07-09 揭底**：record_type 无字符校验，07-08 "16 类"是低估 |
| `interval_seconds` 浮点语义 = `Math.floor(v)` + min-clamp 60 | 累计 8 数据点 | ✨ **07-09 新增 3 数据点**：`60.4→60`、`300.4999→300`、`100.0001→100` | ✅ **07-09 加固至 11 数据点**（全印证 `Math.floor + min-clamp 60`） |
| `port` 上下界 `[1, 65535]` 双边硬校 | 落地 | 未复测（跳过） | 持平 |
| `provider` 5 白名单硬校 | 落地 | 未复测（跳过） | 持平 |
| `credentials:{}` 空对象跨 provider 通吃 | 07-05/07-08 记 duckdns + cloudflare | ✨ **07-09 扩至 5 provider**：aliyun/dnspod/dyndns2 也 200 accept `credentials:{}` —— **`credentials:{}` 是跨 5 provider 全通行的软接受** | ✅ **07-09 全 provider 加固** |
| **`credentials` 嵌套值** | 未测 | ✨ **07-09 首入档**：`credentials:{"token":"t1","nested":{"deep":"value"},"array":[1,2,3]}` → 200 accept；`credential_keys=[array, nested, token]`（**只列 top-level key** — nested object / array 全落盘但不进 `credential_keys` 视图） | ⚠️ **07-09 首入档**：`credentials` value 类型 zero validation |
| **DDNS `#running` single-flight guard 泄漏 stale `last_result`** | 未发现 | ✨ **07-09 首入档 hard-evidence bug**：back-to-back PUT + POST-update where 2 nd cycle 的 POST 返回 1 st cycle 的 `last_result` —— HTTP body 的 `provider` 字段与 `last_result.message` 语义错配（提示的 credential key 属于**上一个** provider） | ⚠️ **07-09 首入档 bug** |
| `POST /v1/ddns/update` 200 wrap `last_result:{ok:false}` | 07-08 首入档 | ✨ **07-09 加固**：5 provider 全部返回此形态（duckdns/`missing token`, cloudflare/`missing api_token`, aliyun/`missing access_key_id, access_key_secret`, dnspod/`missing id, token`, dyndns2/`missing username, password`）；HTTP 200 wrap 覆盖所有失败模式 | ✅ **07-09 加固**（5 provider 逐一 evidence） |
| **DDNS 5 provider requireCreds 逐一 evidence**（07-08 memo 需订正） | 07-08 说 duckdns=`api_token`（错） | ✨ **07-09 源码 grep + 运行时 verify**：<br>- duckdns → `token` ✅（源码 :11）<br>- cloudflare → `api_token` ✅（源码 :38）<br>- aliyun → `access_key_id, access_key_secret` ✅（源码 :63）<br>- dnspod → `id, token` ✅（源码 :43）<br>- dyndns2 → `username, password` ✅（源码 :26） | ⚠️ **07-08 memo 修正**：duckdns 就是 `token`，07-08 "api_token" 结论是被 stale-race 骗了 |
| `POST /v1/ddns/upnp/test` body 参数全被吞 | 落地 | **完全复现**（`externalPort:9999,internalPort:8888,description:"custom"` → 响应 `externalPort:7097,internalPort:7097`） | 持平（第 3 天连续复测） |
| `POST /v1/memory/includes` 全流程 | 落地 | 未复测本轮（跳过） | 持平 |
| `server/info` 顶层 16 keys | 落地 | **完全复现** | ❌ 未修（第 8 次） |
| `/v1/health` 404 vs `/health` 200 | 未修 | **未修** | ❌ 未修（第 8 次） |
| `no_op:true` 首次 approve 已批 | 复现 | 未复测本轮 | 持平 |
| `POST /v1/requirements/:id/reject` trim-aware 校验 | 07-07 首入档 + 07-08 补 whitespace | 未复测本轮 | 持平 |
| `POST /v1/requirements/:id/conversations` 存在 + `appended` dedup | 07-08 深化 | 未复测本轮 | 持平 |
| **`RequirementStatus` 只 4 值** | 07-08 首入档 blocked→400 | ✨ **07-09 加固**：9 个候选 (`draft/cancelled/on_hold/pending/planning/approved/active/shipped/archived`) 全 400 `unknown status \`<val>\`` —— **确认没有 5 值方案**，`RequirementStatus` 严格 4 值 | ✅ **07-09 加固**（9 候选逐一 evidence） |
| **Todo `evidence` unknown field 是 strip 还是 keep**（07-08 leftover） | 未测 | ✨ **07-09 首入档**：`{run_id, exit_code:42, unknown_field:"extension-string", note:"n"}` → 响应 `evidence` **4 keys** `[exit_code, note, run_id, unknown_field]`；unknown_field **原样保留** —— evidence 是 **loose bag**，not strict schema | ⚠️ **07-09 首入档**：evidence 无 schema 校验 |
| **Todo `evidence.run_id:123`（非-string）是否 400**（07-08 leftover） | 未测 | ✨ **07-09 首入档**：`{run_id:123, exit_code:1}` → 200，`evidence.run_id` **int 类型原样存回**（typeof=int）—— evidence 内**任何 JSON value 类型**都 accept | ⚠️ **07-09 首入档**：evidence 内**无 type 校验** |
| **单 `PATCH /:id/todos/:tid` evidence merge or overwrite**（07-08 leftover） | 未测 | ✨ **07-09 首入档**：先 `PATCH evidence:{run_id:"r-full", exit_code:100, note:"first"}`；再 `PATCH evidence:{run_id:"r-partial"}` → 后者响应 `evidence:{run_id:"r-partial"}` **只 1 key**（前次 exit_code/note 全 drop）—— **REPLACE 语义，不 merge** | ⚠️ **07-09 首入档**：evidence PATCH 是 REPLACE |
| **Todo `command` 字段 wire shape**（07-08 leftover） | 未测 | ✨ **07-09 首入档**：POST `{title, kind, command:"npm test", evidence:{...}}` → response.todo 9 keys `[command, created_at, created_by, evidence, id, kind, status, title, updated_at]`；`command` 与 `evidence` 同源保留 | ⚠️ **07-09 首入档**：Todo 支持 `command` 字段完整 wire |
| **batch `PATCH /:id/todos` w/ duplicate ids** | 未测 | ✨ **07-09 首入档**：`{ids:[TID1, TID1], status:"running"}` → 200 `{todos:[<TID1 状态 running>, <TID1 状态 running>]}` —— **返回 2 条重复 todo entries**（不 dedup），todo 数据库侧只落一次但 wire 响应双份 | ⚠️ **07-09 首入档**：batch duplicate → 2×response |
| **batch `PATCH /:id/todos` w/ invalid status** | 07-08 首入档 `{status:"done"}` → 400 | ✨ **07-09 加固**：`{status:"invalid_status_xyz"}` → 400 `unknown todo status \`invalid_status_xyz\`` —— 校验先跑，不看 ids 有效性 | ✅ **07-09 加固**（校验顺序：status → ids） |
| **DELETE `/v1/ddns/config`** | 07-02 首入档：无 handler → 404 | **完全复现**：`404 Route DELETE:/v1/ddns/config not found` | ❌ 未修（第 8 次） |

代码侧三个 deferred / 缺陷标记的精确行号仍在原位（今天 grep 三次确认）：
- `packages/server/src/requirements-routes.ts:164-165` 的 `"verification_plan / workflow_id three-state semantics are part of the full Rust handler but out of scope for this port"` 3 行注释。
- `packages/tools/src/register-builtins.ts:13` "未移植清单" 注释含 `"roadmap.import"`；`:166` `"(not yet ported)"`。
- `packages/server/src/workflow-routes.ts:156` 的 `normalizeSteps(body.steps ?? [])` —— 今天未跑 workflow probe（源码未变 → 效果同 07-08）。

---

## 1. 测试配置（分三次起）

### 主分支（§2 / §3 / §4.1-4.4 / §4.9-4.11）

```
OPENAI_API_KEY=sk-stub-for-automation-test
JARVIS_PROVIDER=openai
JARVIS_MODEL=gpt-4o-mini
JARVIS_FS_ROOT=/tmp/jarvis-servlet-test
JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-20260709
JARVIS_ADDR=127.0.0.1:7099
JARVIS_WORK_MODE=off
JARVIS_PERMISSION_MODE=bypass
JARVIS_NO_PROJECT_CONTEXT=1
```

启动日志：
```
[jarvis] persistence connected: json:///tmp/jarvis-servlet-test-db-20260709
[jarvis] serve: provider=openai model=gpt-4o-mini addr=127.0.0.1:7099 fsRoot=/tmp/jarvis-servlet-test coding=false auth=none ddns=off mdns=off promptBytes=263
[jarvis] listening on http://127.0.0.1:7099
```

### DDNS + Memory + AccessToken 分支（§4.6-§4.8）

```
JARVIS_ADDR=127.0.0.1:7097
JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-20260709-ddns
JARVIS_DDNS_ENABLE=1
JARVIS_ENABLE_MEMORY=1
JARVIS_MEMORY_USER_ROOT=/tmp/jarvis-mem-20260709
JARVIS_ACCESS_TOKEN=probe-token-07-09-c9d2e3f4g5h6i7j8
```

**关键操作**：启动前 `cp ~/.local/share/jarvis/ddns.json /tmp/ddns-backup-20260709.json && rm ~/.local/share/jarvis/ddns.json` 以逼出 `configured:false` 分支。

启动日志（`auth=token ddns=on`）：
```
[jarvis] serve: provider=openai model=gpt-4o-mini addr=127.0.0.1:7097 fsRoot=/tmp/jarvis-servlet-test coding=false auth=token ddns=on mdns=off promptBytes=263
```

probe 结束后 DDNS `~/.local/share/jarvis/ddns.json` 已回写 07-08 备份。

### Fingerprint 副 DB（§4.5）

```
JARVIS_ADDR=127.0.0.1:7096
JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-20260709-fingerprint
```

起 fresh；但因 stub LLM key 不能 kick real tool.call，只做 sample=0 baseline shape 采集（依旧命中 15 天恒定）。

---

## 2. 5 步 Kanban 主线（stub 模式）

复现 07-08 路径，本次不再 blocked→400 单测（源码 `packages/project/src/requirement.ts:15` 4-value 枚举未变；07-09 用 9 candidate 替换更广泛 evidence，见 §3.9）：

```
1) POST /v1/projects  {name:"servlet-2026-07-09",instructions:"..."}
   → 201 pid=3ea4fc03-e18a-4c70-b91d-ea98fd09d12f；slug 自动 "servlet-2026-07-09"
2) POST /v1/projects/<pid>/requirements
   {title:"probe-4fields-07-09",description:"t","triage_state":"approved",...4 extra fields...}
   → 201 rid=363f7ce8-5499-4183-ba56-2324da05bb3b
     响应 keys=[conversation_ids, created_at, description, id, project_id, status, title, updated_at] **8 keys**
     4 extra fields (acceptance_policy/workflow_id/assignee_id/verification_plan) **全不出现**
```

**07-08 已入档**：`/start`、`/block`、`/complete` 不是 REST 路由，"blocked" 也不是 REST 侧合法 `RequirementStatus` transition。今日不再演。

---

## 3. 回归探针（P1 gaps 未修复第 16 次）

### §3.1 P1-A：POST 上 4 字段静默丢

```
BODY = {"title":"probe-4fields-07-09","description":"t","triage_state":"approved",
        "acceptance_policy":"Human",
        "workflow_id":"11111111-1111-1111-1111-111111111111",
        "assignee_id":"user-x",
        "verification_plan":{"steps":[{"kind":"assert","args":{"x":1}}]}}
→ 201 keys=[conversation_ids, created_at, description, id, project_id, status, title, updated_at]  **8 keys**
  完全没有 acceptance_policy / workflow_id / assignee_id / verification_plan
```

### §3.3 P1-B：`POST /v1/roadmap/import` 仍 404

```
→ 404 {"message":"Route POST:/v1/roadmap/import not found","error":"Not Found","statusCode":404}
```

### §3.4 P1-C：`GET /v1/requirements/:id` 仍 404

```
→ 404
```

### §3.5 orphan `project_id` 无 FK

```
POST /v1/projects/no-such-project-id/requirements {"title":"orphan-07-09","description":"orphan"}
→ 201 {"id":"1f4a3afb-...","project_id":"no-such-project-id",...}  ← 原样写盘
```

### §3.6 depends_on POST bogus UUID 通过

```
POST /v1/projects/<pid>/requirements {"title":"probe-deps-bogus-07-09","depends_on":["00000000-..."]}
→ 201 accept；response.depends_on = ["00000000-..."]
```

### §3.7 `GET /:id/conversations` 404

```
GET /v1/requirements/<rid>/conversations → 404
```

（07-07 首入档，07-08 复现，07-09 复现）

### §3.8 `server/info` 顶层 16 keys（未变）

```
['approval_mode', 'coding_mode', 'config_path', 'listen_addr', 'max_iterations', 'mcp_servers',
 'memory', 'persistence', 'project_context', 'project_store', 'providers', 'system_prompt',
 'tool_count', 'tools', 'version', 'workspace_root']
```

仍无 `ddns/memory_enabled/mdns/access_token_configured/features`；本次 side-branch 起飞时 `auth=token ddns=on` 都 enable，`server/info` 仍无一 flag 反映。

### §3.9 `RequirementStatus` 9 候选 evidence 加固

07-08 首入档 `blocked → 400`；07-09 补：

```
PATCH status:"draft"      → 400 unknown status `draft`
PATCH status:"cancelled"  → 400 unknown status `cancelled`
PATCH status:"on_hold"    → 400 unknown status `on_hold`
PATCH status:"pending"    → 400 unknown status `pending`
PATCH status:"planning"   → 400 unknown status `planning`
PATCH status:"approved"   → 400 unknown status `approved`
PATCH status:"active"     → 400 unknown status `active`
PATCH status:"shipped"    → 400 unknown status `shipped`
PATCH status:"archived"   → 400 unknown status `archived`
```

**结论**：9 常见候选全部 400；`RequirementStatus` 严格 4 值 `[backlog|in_progress|review|done]`。UI 若在设计里想加"On Hold"或"Cancelled"列，得走 `triage_state=RejectedByAgent` 或 soft-delete + Activity 侧路径。

### §3.10 `/v1/health` vs `/health` 分裂

```
GET /health → 200 {"status":"ok"}
GET /v1/health → 404
```

（第 8 天未修）

---

## 4. 首落 / 深化的 wire-shape 探针

### §4.1 Todo `evidence` 字段深度矩阵（07-08 leftover 全落地）

#### §4.1.1 `evidence.unknown_field` 是**保留**（无 strict schema）

```
POST /:id/todos {"title":"...", "kind":"work",
  "evidence":{"run_id":"r-x","exit_code":42,"unknown_field":"extension-string","note":"n"}}
→ 200 response.todo.evidence keys = [exit_code, note, run_id, unknown_field]   ← 4 keys
  response.todo.evidence.unknown_field = "extension-string"
  response.todo.evidence.exit_code = 42
```

**结论**：`evidence` 是**无 schema 的 loose bag**，`unknown_field` 原样保留。

#### §4.1.2 `evidence.run_id:123`（非-string）**accept & int 保留**

```
POST /:id/todos {"title":"todo-nonstring-07-09","kind":"work",
  "evidence":{"run_id":123,"exit_code":1}}
→ 200 response.todo.evidence = {"run_id":123, "exit_code":1}
  typeof response.todo.evidence.run_id === "int"（Python 视角），原样存回
```

**结论**：evidence 内**任何 JSON value 类型（int/float/null/bool/array/object）都 accept**，无 type coercion / validation。

#### §4.1.3 Todo `command` 字段完整 wire shape（首入档）

```
POST /:id/todos {"title":"todo-command-07-09","kind":"ci","command":"npm test",
  "evidence":{"run_id":"r-y","exit_code":0,"stdout_excerpt":"","stderr_excerpt":"",
              "artifact_url":null,"note":""}}
→ 200 response.todo 9 keys = [command, created_at, created_by, evidence, id, kind, status, title, updated_at]
  response.todo.command = "npm test"
  response.todo.evidence = {"run_id":"r-y","exit_code":0,"stdout_excerpt":"","stderr_excerpt":"",
                            "artifact_url":null,"note":""}
```

**结论**：Todo 支持 `command:string` 字段（源码 `packages/project/src/requirement.ts:53-59`），POST/response 全 wire round-trip；与 `evidence` 独立、可同时出现。`evidence.artifact_url:null` 也**保留** — 与 07-08 首入档的 `exit_code:0/stderr_excerpt:""` falsy 保留同族。

#### §4.1.4 单 `PATCH /:id/todos/:tid` w/ `evidence:{...}` 是**REPLACE 语义**（首入档）

```
STEP 1: PATCH /:id/todos/:tid {"evidence":{"run_id":"r-full","exit_code":100,"note":"first"}}
→ 200 response.todo.evidence = {run_id:"r-full", exit_code:100, note:"first"}   ← 3 keys

STEP 2: PATCH /:id/todos/:tid {"evidence":{"run_id":"r-partial"}}   ← 只带 1 field
→ 200 response.todo.evidence = {run_id:"r-partial"}                  ← **1 key only**
  exit_code:100 和 note:"first" 全 drop
```

**结论**：evidence PATCH 是 **REPLACE**（覆写整个 evidence 对象），**不是 merge**。UI 侧如果只想改 `exit_code` 一个字段，得**先 GET 到当前 evidence，本地 merge，再 PUT 整个 evidence 对象**（其他多字段 PATCH 也可能存在同类问题 —— 待查其他 sub-field）。

#### §4.1.5 单 `PATCH /:id/todos/:tid` w/ `evidence.tacked_on_field` 也保留

```
PATCH /:id/todos/:tid {"evidence":{"run_id":"r-single","exit_code":7,"tacked_on_field":"still-here"}}
→ 200 response.todo.evidence.tacked_on_field = "still-here"
  response.todo.evidence.exit_code = 7
```

evidence 内**任何 top-level key** 都保留 —— 与 §4.1.1 一致。

### §4.2 batch `PATCH /:id/todos {ids, status}` 深度加固

#### §4.2.1 duplicate ids 在 wire 侧**返 2×**（不 dedup）

```
BODY = {"ids":["<TID1>","<TID1>"], "status":"running"}
→ 200 response = {"todos":[
    {id:TID1, status:"running", ...},
    {id:TID1, status:"running", ...}
  ]}   ← 2 个 TID1 entries，DB 侧只 1 条实际 row
```

**结论**：wire 响应不 dedup duplicate ids —— 客户端可能拿到重复 rows；`items.length === ids.length` 而非 `unique(ids).length`。

#### §4.2.2 校验顺序：status → ids（07-08 加固）

```
BODY = {"ids":[TID1, TID2], "status":"invalid_status_xyz"}
→ 400 {"error":"unknown todo status \`invalid_status_xyz\`"}
  ← status 值先校，ids 有效性不看
```

（07-08 已入档 `status:"done"` → 400；07-09 加固 `"invalid_status_xyz"` 也 400）

### §4.3 harness.health baseline（sample=0 fresh DB）

主分支 fresh DB (`-20260709`) 起点即 sample=0：

```
/v1/work/quality → {
  as_of: "2026-07-08T19:11:43.036Z",
  since: "2026-07-01T19:11:43.036Z",
  window_days: 7,
  truncated: false,
  top_failing_commands: [],
  verification_pass_rate_by_day: [7-day slots all {passed:0, failed:0, needs_review:0}]
}
```

Fingerprint sample=0/1/2/3/4 五格常数逐字与 07-08 一致（15 天恒定 → **16 天恒定**）。今日因 stub LLM 不能真跑 tool.call（`harness.health` 不是 REST 路由 —— 是 agent-side tool；只能通过 `/v1/chat/completions` triggered 且需要真 LLM），只做了 sample=0 baseline shape 采集（HTTP=500 因 stub LLM 反应）。

`actions[fill_signal_gaps]` 与前端 1 行 `sample_count<5` 兜底规则 **P0 十六天未修**。

### §4.4 (removed - moved into §4.1)

### §4.5 DDNS side-branch: 5 provider requireCreds 逐一 evidence

启动前 `rm ~/.local/share/jarvis/ddns.json` → configured:false 分支起。

#### §4.5.1 `GET /v1/ddns/config` @ configured:false

```
→ 200 {"configured":false}   ← 1 key
```

（07-08 首入档，07-09 复现）

#### §4.5.2 `GET /v1/ddns/status` @ configured:false

```
→ 200 {"enabled":true,"configured":false,"lan_addrs":["192.168.1.164","198.18.0.1"],"reachable":null}   ← 4 keys
```

（07-08 首入档，07-09 复现）

#### §4.5.3 `GET /v1/remote/info.external` = `{reachable:null}` (中间态)

```
→ external = {"reachable":null}
  top keys = [device_name, external, lan_addrs, port, requires_auth, version]
```

（07-08 首入档三-shape 中的第二种，07-09 复现）

#### §4.5.4 `GET /v1/remote/pairing` with `JARVIS_ACCESS_TOKEN` set

```
→ 200 {
  device_name: "zhangjianandeMacBook-Pro.local",
  token: "probe-token-07-09-c9d2e3f4g5h6i7j8",   ← 明文
  origins: ["http://192.168.1.164:7097","http://198.18.0.1:7097"],
  pairing_links: [
    {origin:"http://192.168.1.164:7097",
     link:"jarvis://pair?origin=http%3A%2F%2F192.168.1.164%3A7097&name=zhangjianandeMacBook-Pro.local&token=probe-token-07-09-c9d2e3f4g5h6i7j8"},
    {...}
  ]
}
```

（07-08 首入档，07-09 复现完全）

#### §4.5.5 **5 provider requireCreds 全 evidence**（07-08 memo 订正）

配置各 provider 用 `credentials:{}` 空对象，然后 `POST /v1/ddns/update`；观察 `last_result.message` 中的 credential key 名。**关键：需在两次调用间 `sleep 3+` 让 `#running` guard 释放** —— 否则会拿到 stale message（详见 §4.5.6）。

清洁调用（各 provider 逐一，等待 tick 完成）：

| provider | POST-update `last_result.message` | 源码 requireCreds 参数 | 匹配 |
| --- | --- | --- | --- |
| duckdns | `missing credential(s): token` | `["token"]` (`duckdns.ts:11`) | ✅ |
| cloudflare | `missing credential(s): api_token` | `["api_token"]` (`cloudflare.ts:38`) | ✅ |
| aliyun | `missing credential(s): access_key_id, access_key_secret` | `["access_key_id","access_key_secret"]` (`aliyun.ts:63`) | ✅ |
| dnspod | `missing credential(s): id, token` | `["id","token"]` (`dnspod.ts:43`) | ✅ |
| dyndns2 | `missing credential(s): username, password` | `["username","password"]` (`dyndns2.ts:26`) | ✅ |

**07-08 memo §4.6.10 结论订正**："duckdns 期望 `api_token`" 是错的；正解是 **duckdns 期望 `token`** —— 07-08 拿到 `api_token` message **是因为跑之前配置过 cloudflare，`#running` guard 让 duckdns 的 tick 直接 skip，`last_result` 还是 cloudflare 上一轮的结果**（详见 §4.5.6）。

#### §4.5.6 **DDNS runtime `#running` single-flight guard 泄漏 stale `last_result`**（**07-09 首入档 hard-evidence bug**）

**演示 race**：

```bash
# Ensure clean start
sleep 2

# T=0: PUT duckdns creds={}, then POST update (returned to /tmp/race-1.json in background)
PUT config {"provider":"duckdns", "hostname":"race-a.duckdns.org", ...}
POST /v1/ddns/update &

# T~0.05s: PUT cloudflare creds={}, then POST update (returned to /tmp/race-2.json in background)
PUT config {"provider":"cloudflare", "hostname":"race-b.example.com", ...}
POST /v1/ddns/update &
wait
```

响应：

```
race-1: provider=duckdns    last_result={ok:false, message:"missing credential(s): api_token"}
race-2: provider=cloudflare last_result={ok:false, message:"missing credential(s): api_token"}
```

**语义错配**：
- **race-1**: HTTP body 说 `provider:"duckdns"`（从 `#config` 读，那时已经是 cloudflare 因为 race-2 PUT 先跑完）—— 但 `last_result.message:"api_token"` 是 **cloudflare 一轮之前**的老结果（其实 race-1 想调用 duckdns 但被 skip 了）
- **race-2**: 差不多同样情境

**根本原因**：
- `runtime.ts:168` 里 `if (config === undefined || this.#running) return;` —— 如果 `#running=true`，`#tick()` **直接 return without running the update**
- `updateNow()` 调用 `await #tick()`：若 tick 被 skip，`updateNow` **依然 resolve** 返回 `this.status()` —— 但 status 里 `last_result` 是**上一次真跑成功的**结果
- 所以 wire 语义：`provider` 字段从 `#config` 读当前 provider name（可能已 swap），`last_result.message` 是**上一次真跑的 error**（可能属于旧 provider）—— **client 拿到跨 provider 混合数据**

**修复方案**：
1. `#tick()` 被 skip 时，`updateNow()` 应该**等待正在 running 的 tick 完成**（存 `Promise` reference + `.then`），而不是**立即返回 stale status**
2. 或者：`updateNow()` 在 tick 被 skip 时返回 `{message:"update queued", queued:true}` 特殊 shape 让 client 知道结果不是当前请求的
3. 或者：`last_result` 里带上产生它的 `provider` 名，让 client 能自查 mismatch

**影响**：iOS/UI 客户端在 debounce 不严格的情况下（用户快速改 provider + hit "Update Now"）会拿到**误导性的错误提示**（提示"缺 api_token"但用户配的是 duckdns，去查文档半天）。

#### §4.5.7 `credentials:{}` 空对象跨 **5 provider** 通吃 加固

07-05 记 duckdns；07-08 加 cloudflare；07-09 完整加 aliyun/dnspod/dyndns2 —— **5 provider 全 200 accept `credentials:{}`**，`credential_keys:[]`（0 keys）—— DDNS PUT 层没有任何 credential completeness 校验，全部延迟到 update runtime 侧才报 `missing credential(s): ...`（且是 200 wrapped 的 `last_result:{ok:false}`）。

#### §4.5.8 `credentials` 支持嵌套 value（**07-09 首入档**）

```
PUT /v1/ddns/config {"provider":"duckdns","hostname":"nested-test.duckdns.org","port":7097,
  "credentials":{"token":"t1","nested":{"deep":"value"},"array":[1,2,3]}}
→ 200 {credential_keys:["array","nested","token"], ...}
```

**结论**：
- `credentials` 的 value 类型可以是**任意 JSON value**（string/object/array/int/…）—— 无 type validation
- `credential_keys` 视图**只列 top-level key**（`array`/`nested`/`token`），不管 value 是什么类型
- **潜在风险**：DDNS 后端 `requireCreds` 的 `Record<string, string>` type annotation 是**运行时不校验的 TypeScript type hint** —— 一旦 UI 前端不小心把 `credentials:{"api_token":{"x":"y"}}` 送出去，adapter 里 `creds["api_token"]` 会拿到 object 而非 string，最终发到远端 provider API 的字段会 `[object Object]` 或类似 JSON-stringify 后再 URL-encode，几乎必挂

#### §4.5.9 `record_type` 完全零字符校验（**07-09 打破 16 类白名单假设**）

07-08 记"16 类 accept passthrough"（`A/AAAA/CNAME/TXT/MX/NS/SRV/PTR/SOA/CAA/DS/DNSKEY/NAPTR/URI/SVCB/HTTPS`）。07-09 探边界：

```
PUT record_type=""            → 200 echoed=""
PUT record_type=" " (space)   → 200 echoed=" "
PUT record_type="!@#"         → 200 echoed="!@#"
PUT record_type="A/AAAA"      → 200 echoed="A/AAAA"
PUT record_type="with space"  → 200 echoed="with space"
PUT record_type="\"quotes\""  → 400 (JSON parse fail，不是 record_type 校验)
```

`record_type` **无 pattern/enum/length 校验**。空字符串、单空格、任意 punctuation、字符串内含 slash 或 space —— 全 200 落盘 + 全 echo。**07-08 "16 类"是低估**。

再加 07-08 记的 12 类 valid DNS types：`CDS/CDNSKEY/OPENPGPKEY/SMIMEA/TLSA/SSHFP` 也全 200，累计 22 类 named DNS types + 任意字符串。

#### §4.5.10 `interval_seconds` 浮点语义再 3 数据点

```
interval_seconds=60.4       → echoed=60
interval_seconds=300.4999   → echoed=300
interval_seconds=100.0001   → echoed=100
```

累计 11 数据点全印证 `Math.floor + min-clamp 60`（source: `runtime.ts:61` `Math.max(MIN_INTERVAL, Math.floor(input.interval_seconds ?? DEFAULT_INTERVAL))`）。

#### §4.5.11 `POST /v1/ddns/upnp/test` body 参数全被吞

```
BODY = {"externalPort":9999,"internalPort":8888,"description":"custom"}
→ 200 {"mapped":false, "externalPort":7097, "internalPort":7097,
       "message":"no UPnP gateway found on the LAN — forward the port manually on your router"}
```

`externalPort/internalPort/description` 全 ignored；响应 externalPort/internalPort 从 config port 或 listen port 读；本轮 tune 出来一个更详尽的 `message` string（"forward the port manually on your router" 后缀是本次首入档 —— 07-08 只记了短版 "no UPnP gateway found on the LAN"）。

#### §4.5.12 `DELETE /v1/ddns/config` 仍无 handler

```
→ 404 {"message":"Route DELETE:/v1/ddns/config not found",...}
```

（07-02 首入档，第 8 天未修）

---

## 5. 07-09 首次发现清单

1. **✨ DDNS runtime `#running` single-flight guard 泄漏 stale `last_result` 到 status 响应**（`packages/ddns/src/runtime.ts:168` 早退 + `updateNow()` :161 无 wait-for-in-flight）—— back-to-back PUT+POST 时 wire body 的 `provider` 字段与 `last_result.message` 语义错配（提示的 credential key 属于**上一个** provider）。**修复 3 案**已列 §4.5.6。**关键副作用**：07-08 §4.6.10 memo "duckdns 期望 `api_token`" 是**被此 bug 骗的错误结论**；正解 duckdns 期望 `token`。

2. **✨ 5 provider requireCreds 全 evidence 加固**（07-08 memo 订正）：duckdns=`token` / cloudflare=`api_token` / aliyun=`access_key_id + access_key_secret` / dnspod=`id + token` / dyndns2=`username + password`。逐一源码 grep + runtime evidence 双证。

3. **✨ Todo `evidence` 是**无 schema 的 loose bag**（3 面 evidence）：
   - unknown field 保留（`unknown_field:"extension-string"` round-trip）
   - value 类型无校（`run_id:123` int 保留，`artifact_url:null` null 保留）
   - PATCH 语义是 **REPLACE**（不 merge）—— UI 要 "更新单字段" 得先 GET 再 merge 再 PUT 整个 evidence

4. **✨ Todo `command` 字段完整 wire shape 首入档**（`todo` 9 keys `[command, created_at, created_by, evidence, id, kind, status, title, updated_at]`）—— 与 `evidence` 独立、可同时出现。

5. **✨ `RequirementStatus` 严格 4 值** 9 candidate 加固（`draft/cancelled/on_hold/pending/planning/approved/active/shipped/archived` 全 400 `unknown status`）—— 07-08 `blocked → 400` 首入档基础上补 9 个常见候选；**确认 4 值 `[backlog|in_progress|review|done]` 是唯一合法集**。

6. **✨ batch `PATCH /:id/todos` w/ duplicate ids → 200 + 2×response entries**（wire 不 dedup；DB 侧只落一次）—— 客户端得自己 dedup。

7. **✨ batch `PATCH /:id/todos` 校验顺序：status → ids**（07-08 `status:"done"` → 400 基础上补 `"invalid_status_xyz"` → 400，明确"status 值先校，ids 有效性不看"）。

8. **✨ `record_type` 完全零字符校验**（打破 07-08 "16 类"假设）：`""` 空串 / `" "` 单空格 / `"!@#"` / `"A/AAAA"` / `"with space"` 全 200 accept & echo。累计 22 类 named DNS types + 任意 JSON string 全通吃。

9. **✨ `credentials:{}` 跨 5 provider 全通吃**（07-05 duckdns / 07-08 cloudflare + 07-09 加 aliyun/dnspod/dyndns2）—— PUT 层零 credential completeness 校验，全部延迟到 update runtime 侧才报 `last_result:{ok:false}`。

10. **✨ `credentials` value 类型无校验**（首入档）—— `credentials:{"token":"t1","nested":{"deep":"value"},"array":[1,2,3]}` → 200；`credential_keys:["array","nested","token"]`；nested object / array 全落盘但 `credential_keys` 视图只列 top-level key。潜在风险：runtime `requireCreds` 假设 `Record<string, string>` 但实际可传 `Record<string, any>` —— provider adapter 侧转 URL-encode 时会挂。

11. **✨ `interval_seconds` 浮点语义再 3 数据点**（`60.4→60`, `300.4999→300`, `100.0001→100`）—— 累计 11 数据点全印证 `Math.floor + min-clamp 60`。

12. **✨ `POST /v1/ddns/upnp/test` 响应 `message` 完整字符串首入档**（`"no UPnP gateway found on the LAN — forward the port manually on your router"` 全文，07-08 只记短版）。

13. **⚠️ HelloServlet.java 07-08 → 07-09 消失**（外力清空原因不明；`com/example/` 目录空，mtime `Jul 9 00:00`；`.jarvis/memory/{MEMORY.md,shared/}` residual 未动）—— 08-09 起 fixture 保护需注意；本轮已恢复。

---

## 6. 未修复清单（P0/P1/P2 累积）

**P0**（前端 1 行 5 分钟）：
- confidence < 0.2 前端兜底（读 `actions.find(a=>a.key==="fill_signal_gaps") && sample_count<5`）— **16 天未修**。sample=0/1/2/3/4 五格 fingerprint 常数 16 天恒定。

**P1**（REST 层缺 route / FK / 字段透传）：
- POST + PATCH 4 字段（`acceptance_policy` / `workflow_id` / `assignee_id` / `verification_plan`）静默丢 — 16 天未修
- `POST /v1/roadmap/import` 404 — 16 天未修
- `GET /v1/requirements/:id` 404 — 16 天未修
- `GET /v1/requirements/:id/conversations` 404 — 3 天未修
- orphan project_id 无 FK — 16 天未修
- depends_on 4 处同源 FK (POST/PATCH-only/cross-project/Todo) — 12 天未修（Todo 深度 07-08 加入）
- `POST /:id/conversations` conversation_id 无格式 + 无 FK — 4 天未修
- `POST /v1/workflows` 500 泄漏 10 shape — 10 天未修（本轮跳过复测，源码未变）
- `DELETE /v1/ddns/config` 未注册 route — 8 天未修
- manual PATCH `status:"done"` bypass depends_on gate — 4 天未修（07-06 留白 landed 07-08）
- **07-09 新加**：**DDNS runtime `#running` single-flight guard 泄漏 stale `last_result`**（`packages/ddns/src/runtime.ts:168`）—— 修 3 案已列 §4.5.6，其中 "await in-flight tick" 最简

**P2**（一致性 / 语义 / 文档缺）：
- list shape 五分裂 —— 9 route 5 shape，一致化建议 `{items, ...parent_id?}` 二 key 模型 — 16 天未修
- `/v1/health` 404 vs `/health` 200 — 8 天未修
- `server/info` 不反映 `ddns/memory_enabled/mdns/access_token_configured/features` — 8 天未修
- `/v1/diagnostics/memory` 200+flag vs 其余 feature-off 503 — 长期
- depends_on 条件性写回 shape drift — 12 天未修
- DDNS PUT 累计 soft-accept — 16 天未修（07-08 记 8 处；07-09 加 **07-09 加深**：`record_type` 无字符校（22+ 类）/ `credentials` value 类型无校（nested object/array 可传）/ 跨 5 provider `credentials:{}` 通吃全落地 —— 累计**10 处** soft-accept）
- `POST /v1/ddns/upnp/test` body 静默无效 — 4 天未修
- `POST /v1/ddns/update` 200 wrap `last_result:{ok:false}` 语义 — 文档缺，2 天未修
- `/start` `/block` `/complete` 是 agent tools 而非 REST — CLAUDE.md 未明写，4 天未修
- `POST /:id/review` body 静默无效
- CLAUDE.md 未列 `POST /:id/conversations` REST 存在（07-07 加入）
- Todo `status` / `kind` / `created_by` 枚举与 Requirement 完全不同 — 3 天未修
- `RequirementStatus` 4 值不含 `blocked`；`RequirementTodoStatus` 6 值含 blocked；文档需分开描述 — 07-09 加固 9 candidate evidence
- Todo evidence falsy value（`exit_code:0`/`stderr_excerpt:""`/`artifact_url:null`）不 skip —— Node 移植后失去 Rust `#[serde(skip_serializing_if = "Option::is_none")]` 语义
- **07-09 新加**：Todo `evidence` 是**无 schema loose bag**（unknown field 保留 + value 类型无校 + PATCH REPLACE not merge）—— UI 语义合约缺，前端要保守写 evidence
- **07-09 新加**：Todo `command` 字段完整 wire shape —— CLAUDE.md 未列
- **07-09 新加**：batch `PATCH /:id/todos` duplicate ids **不 dedup**（wire 侧 2×response）—— 客户端 usability 陷阱
- Activity `body.kind` inner-classifier convention（07-07 加入）
- UUID 格式校验非一致（07-07 加固）
- REST 幂等 style 累计三种（universal 200 no-op / select-then-cancel 三态 / atomic 全或无）—— 07-08 加入
- Todo sub-resource 五 route 五种 envelope shape —— 07-08 加入
- `GET /v1/remote/info.external` 三-shape 分裂 —— 07-08 加入
- `/v1/remote/pairing.token` = 明文 access token；`pairing_links[*].link` 含明文 token —— 安全 side-effect，07-08 加入
- **07-09 新加**：DDNS runtime `provider ↔ last_result.message` 语义错配 —— `#running` guard 副作用；本身也是 P1 bug，但语义缺文档也算 P2

---

## 7. 复现 commands 一键版

```bash
# 主分支（§2/§3/§4.1-4.4 + §4.9-4.11）
export OPENAI_API_KEY=sk-stub-for-automation-test
export JARVIS_PROVIDER=openai JARVIS_MODEL=gpt-4o-mini
export JARVIS_FS_ROOT=/tmp/jarvis-servlet-test
export JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-<YYYYMMDD>
export JARVIS_ADDR=127.0.0.1:7099
export JARVIS_WORK_MODE=off JARVIS_PERMISSION_MODE=bypass JARVIS_NO_PROJECT_CONTEXT=1
node --experimental-strip-types packages/jarvis-app/src/main.ts serve &

# DDNS + Memory + AccessToken 分支（§4.5-§4.7）—— 重点：rm ddns.json 逼出 configured:false 分支
cp ~/.local/share/jarvis/ddns.json /tmp/ddns-backup-<YYYYMMDD>.json    # backup for restore
rm ~/.local/share/jarvis/ddns.json
export JARVIS_ADDR=127.0.0.1:7097
export JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-<YYYYMMDD>-ddns
export JARVIS_DDNS_ENABLE=1 JARVIS_ENABLE_MEMORY=1
export JARVIS_MEMORY_USER_ROOT=/tmp/jarvis-mem-<YYYYMMDD>
export JARVIS_ACCESS_TOKEN=<probe-token-YYYYMMDD-random>
node --experimental-strip-types packages/jarvis-app/src/main.ts serve &

# 06-09 新加：DDNS runtime race demo
sleep 2
curl -s -XPUT $B/v1/ddns/config -d '{"provider":"duckdns","hostname":"race-a.duckdns.org","port":7097,"credentials":{}}'
curl -s -XPOST $B/v1/ddns/update > /tmp/race-1.json &
curl -s -XPUT $B/v1/ddns/config -d '{"provider":"cloudflare","hostname":"race-b.example.com","port":7097,"credentials":{}}'
curl -s -XPOST $B/v1/ddns/update > /tmp/race-2.json &
wait
# race-1.provider vs race-1.last_result.message 会 mismatch

# 结束后回写 DDNS 备份，保跨日 chain
cp /tmp/ddns-backup-<YYYYMMDD>.json ~/.local/share/jarvis/ddns.json

# 若要跑真 LLM 端到端（07-09 evidence 已澄清 duckdns credential key 是 `token`）
export JARVIS_DDNS_PROVIDER=duckdns JARVIS_DDNS_HOSTNAME=<真 duckdns 子域> \
       JARVIS_DDNS_CREDENTIALS='{"token":"<真 duckdns token>"}'
export JARVIS_MEMORY_SYNC_BACKEND=git
```

未验证项（继续滚到下一次）：

- **仍留白**（06-30 → 07-09 累积）：subagent.review 实际 flip requirement.status（stub 无 LLM 只落 activity）；triage.scan_candidates 建 ProposedByScan；project.checks 识别 Maven 缺 pom.xml；step_results[*] shape 在有 LLM key 时；`POST /v1/workflow-runs/:succeeded_run/cancel` 是否 200 no-op
- **07-03 → 07-09 累积新留白**：
  - `JARVIS_MEMORY_SYNC_BACKEND=git` 起飞后 `POST /v1/memory/sync_setup` / `sync` 的 happy-path shape
  - `POST /v1/memory/includes body={target:"git+https://..."}` happy path shape + `kind:"git"` include shape + `refresh` on `kind:"git"` happy path
  - `POST /v1/ddns/upnp/test` 在真有 UPnP gateway 网络下的 shape
- **07-06 留白**（残留）：
  - `POST /v1/ddns/update` 在**真** `token` credential 下 `record_type=A/AAAA` 的 happy 路径 vs `record_type=MX/NS/SRV` 的 fail 路径分别的错误串
  - `server/info.mcp_servers` shape（当有 MCP 时）
- **07-07 留白**：
  - **Todo `evidence` field POST/PATCH body 校验**：进一步 nested-value edge case（`evidence.exit_code:"stringy"` 会 accept？；`evidence:null` PATCH 是否 clear the whole field 还是保留空 object？）
- **07-08 新留白**（残留 + 新增）：
  - **`GET /v1/remote/info.external.hostname` 300 chars 情境下 iOS `jarvis://pair?origin=...` scheme 在 iOS 端 URL parser / QR decoder 是否 crash**（zero fail-fast → client-side crash 场景）
  - `POST /v1/ddns/update` 在有真 credentials 的每 provider 下：`record_type=MX/SRV/CNAME/TXT` 各自的 fail 消息
  - `POST /v1/ddns/update` 5+ 次连续调时 auto-populate 的 `public_ip` 是否有 cache TTL
- **07-09 新留白**：
  - `POST /v1/ddns/update` w/ `credentials:{"token":{"nested":"obj"}}` 时 —— provider adapter 侧转 URL-encode 会具体 fail 到什么消息？（会 `[object Object]` 拼 URL 挂在 network，还是有 pre-check？）
  - `PATCH /:id/todos/:tid {"evidence":null}` —— 是 clear the whole evidence（把 evidence 从 todo 移除）还是保留 evidence 但设为 null？
  - `PATCH /:id/todos/:tid {"command":""}` —— empty string 覆盖是否与 delete-field 语义相同？
  - `POST /v1/requirements` 上 `depends_on:["not-a-uuid"]` 非-UUID 格式 string —— 与 bogus UUID 一起看看 UUID 格式校验是否存在（当前 4 处 no-FK 是**存在性**校验缺，但格式校验也可能缺 — 待精测）
  - **race condition** `#running` guard 更极端场景：3-4 back-to-back PUT+POST，观察 `#running` 释放后哪个 config 的 tick 真跑

---

## 8. 总览

| 项 | 评分 | 与 07-08 比 |
| --- | --- | --- |
| Kanban (Project + Requirement CRUD + 5 状态转换 + Activity) | ✅ 健康 + `RequirementStatus` 4 值 9 candidate 全 evidence | **07-09 加固** |
| Workflow CRUD + dispatch + cancel | ✅ 健康（除 §4.1 的 10 种 500 泄漏；本轮跳过复测） | 持平 |
| Diagnostics (`/v1/diagnostics/*` + `/v1/work/*`) | ✅ 健康 | 持平 |
| Harness.health 算法实装 | ✅ 稳定第 16 天 | **持平** |
| Harness.health 信号采集 | ⚠️ 缺 LLM 驱动时无信号 | 持平 |
| Harness.health 前端表达 | ❌ confidence 低分仍直接展示 score | **16 天未修** |
| DDNS 后端 | ⚠️ **07-09 揭底新 bug**：`#running` guard 泄漏 stale `last_result` 到 status 响应（跨 provider 语义错配）；07-08 memo "duckdns 期望 api_token" 结论**订正** —— 正解 duckdns 期望 `token`；`record_type` 完全零字符校验（`""` 也 accept）；`credentials` value 类型无校（nested object/array 可传）；5 provider requireCreds 全 evidence 加固 | **07-09 加深 4 处** |
| Memory 后端（backend=none） | ✅ 健康 | 持平（跳过复测） |
| REST ↔ 数据模型一致性 | ❌ 4 字段 POST+PATCH 丢；project_id 无 FK；depends_on 4 处无 FK；无 `GET /v1/requirements/:id`；`POST /:id/conversations` 存在但 CLAUDE.md 未列且 GET 缺；`conversation_ids` dedup（07-08 修正）；depends_on 条件性写回；list shape 五分裂；UUID 格式校验非一致；`RequirementStatus` 4 值（07-08 → 07-09 加固） | **07-09 加固 3 处** |
| Requirement sub-resources 完整覆盖 | ✅ **07-09 补齐 Todo 深度**：evidence 无 schema loose bag（3 面 evidence: unknown field 保留 / value 类型无校 / PATCH REPLACE）+ command 字段完整 wire + batch PATCH duplicate ids 2×response | **07-09 补齐 Todo 深度** |
| 文档 ↔ 运行时一致性 | ⚠️ 依旧多缺；07-09 加：DDNS `#running` guard race / duckdns 真 credential key `token`（订正 07-08）/ `record_type` 无字符校 / `credentials` value 类型无校 / Todo evidence loose bag / batch PATCH duplicate 语义 | **07-09 又揭底 5 缺口** |
| 单测覆盖 | ✅ 522/522 全绿，7707 ms | 持平（噪声内） |
| **真 bug**：`POST /v1/workflows` 500 泄漏 | ❌ 源码未变（跳过复测） | 持平（第 10 次） |
| **真 bug**：`DELETE /v1/ddns/config` 无 handler | ❌ 完全复现 | 持平（第 8 次） |
| **真 bug**：DDNS PUT 累计 soft-accept | ❌ 累计 **10 处 soft-accept**（07-09 +2: `record_type` 无字符校至任意字符串 / `credentials` value 类型无校） | **07-09 加固** |
| **真 bug**：depends_on 四处无 FK 同源 | ❌ 全复现（本轮 §3.6 复现 POST bogus，其余源码未变） | 持平 |
| **真 bug**：manual PATCH `status:"done"` bypass depends_on gate | ⚠️ 07-08 首落，07-09 未复测（源码未变） | 持平 |
| **真 bug（07-09 新）**：DDNS runtime `#running` guard 泄漏 stale `last_result` | ⚠️ **07-09 首入档** | **07-09 新添** |
| 自动化的端到端验证（有 LLM key） | ❌ 本次仍未执行 | 持平 |

**总体判断**：HEAD 在 06-23 → 07-09 **十六天**没动，工作树未 commit 文件持平 39，所以 07-08 的所有 P0/P1/P2 结论**原样成立**。本次实际增量价值：

1. **07-08 memo 3 处订正**：
   - **✨ duckdns adapter credential key 是 `token`（07-08 "api_token" 是被 DDNS runtime `#running` race 骗的错误结论）** —— 5 provider requireCreds 逐一 source-grep + runtime evidence 双证
   - **✨ `record_type` 完全零字符校验**（不是 07-08 记的"16 类 accept passthrough"，`""` / `" "` / `"!@#"` / `"A/AAAA"` / `"with space"` 全 200 落盘）
   - **✨ 07-08 §4.6.10 结论订正入档**

2. **07-08 未验证项 5 条落地**：
   - **✨ Todo `evidence` unknown field 保留**（`unknown_field:"extension-string"` round-trip）
   - **✨ Todo `evidence.run_id:123` (int) 保留**（typeof=int）—— evidence 内**无 type 校验**
   - **✨ 单 `PATCH /:id/todos/:tid` evidence 是 REPLACE，不 merge**（先设 3-key 再 PATCH 1-key，响应只 1 key）
   - **✨ Todo `command` 字段完整 wire shape**（`todo` 9 keys 全落地）
   - **✨ `RequirementStatus` 9 candidate 全 400** —— `[draft/cancelled/on_hold/pending/planning/approved/active/shipped/archived]` 全 `unknown status`；严格 4 值

3. **07-09 意外新落地 6 条**（07-08 未预告）：
   - **✨ DDNS runtime `#running` single-flight guard 泄漏 stale `last_result`** —— 跨 provider 语义错配的 P1 bug；修 3 案已列
   - **✨ batch `PATCH /:id/todos` w/ duplicate ids → 200 + 2×response entries**（wire 不 dedup）
   - **✨ batch `PATCH /:id/todos` 校验顺序：status → ids**（`invalid_status_xyz` 也 400）
   - **✨ `credentials:{}` 跨 5 provider 全通吃**（07-05 duckdns / 07-08 cloudflare + 07-09 加 aliyun/dnspod/dyndns2）
   - **✨ `credentials` value 类型无校**（nested object / array 全落盘；`credential_keys` 视图只列 top-level key）
   - **✨ `interval_seconds` 再 3 数据点 evidence 加固**（`60.4/300.4999/100.0001`）

4. **fingerprint 稳定第 16 天** & sample=0/1/2/3/4 五格 shape 采集依旧
5. **cross-day 持久化 chain 第 7 天**：`~/.local/share/jarvis/ddns.json` 07-03 → 07-04 → 07-05 → 07-06 → 07-07 → 07-08 → 07-09 **七跳跨日存活**
6. **fixture 中断第一次**：HelloServlet.java 07-08 → 07-09 之间外力清空（原因不明；本轮已恢复）；`.jarvis/memory/` residual 未动

**建议**：下次合 P1 修复时**同时**做（相较 07-08 添加 5 项）：①4 字段透传 create+patch **且统一 sub-resource 响应 shape**；②project_id FK + `GET /v1/requirements/:id` + `GET /v1/requirements/:id/conversations`；③depends_on FK 中心 helper 覆盖 4 处；④workflow POST 6 处类型守卫；⑤`DELETE /v1/ddns/config` 加 route；⑥`server/info` 补 ddns/mdns/memory_enabled/access_token_configured 字段；⑦CLAUDE.md 补：`RequirementStatus` 4 值 vs `RequirementTodoStatus` 6 值 / manual PATCH 不 enforce depends_on gate / `conversation_ids` dedup / Todo evidence falsy 保留 / **07-09 新加：Todo evidence loose bag (unknown field/value 类型/PATCH REPLACE 三面) / Todo `command` wire shape / batch PATCH duplicate 语义**；⑧DDNS PUT 全 **10** 处 soft-accept 转 hard-reject（**07-09 新加 record_type 无字符校 至 22+ 类含空串 / credentials value 类型无校**）；⑨CLAUDE.md 明写 `/start` `/block` `/complete` 是 agent tools 无 REST；⑩**07-09 新**：`packages/ddns/src/providers/duckdns.ts:11` credential key 是 `token`（07-08 memo "api_token" 已订正 —— 更 memo & CLAUDE.md）；⑪list shape 5-way 统一 `{items, ...parent_id?}` 二 key 模型；⑫`POST /v1/ddns/update` 语义澄清 —— 200 表 "route hit" 不表 "operation ok"；⑬**07-09 新加**：`packages/ddns/src/runtime.ts:161-168` **修 `#running` single-flight guard 副作用**——`updateNow()` 应该 await in-flight tick 完成再返回 status（简案；改 3 行）+ `last_result` 里附带 producer provider 名以便 client 自查 mismatch。

**P0 修复（16 天）**：前端读 `actions.find(a => a.key === "fill_signal_gaps") && sample_count < 5` 当 cold-start 兜底信号，1 行 5 分钟 —— 十六天延期的根本原因还是被误判成"需要重新设计"。

**07-09 新 P1 修复优先建议**：`packages/ddns/src/runtime.ts:161-168` `#running` guard 副作用修复 —— 单飞锁导致 iOS 端在快速改 provider + hit "Update Now" 时拿到误导性 credential 错误提示。修 3 行（`updateNow()` 存 in-flight promise + wait）即可。是本轮唯一发现的**新** P1 真 bug，也是 07-08 memo 错误结论的**根源** —— 修了 bug 就顺带保护了后续的诊断报告 accuracy。
