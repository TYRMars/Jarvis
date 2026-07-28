# Jarvis 项目自动化能力诊断报告（2026-07-07 十四次复测）

- **运行时间**：2026-07-07（scheduled task 自动跑）
- **被测分支**：`feat/mobile-ios-ddns`（HEAD 仍为 `64d288a`，与 06-23 → 07-06 同一 commit — **静默第 14 天**；工作树侧 39 个未 commit 文件与 07-04 / 07-05 / 07-06 完全一致，未 +/−）
- **被测项目**：`/tmp/jarvis-servlet-test`
  - **07-07 差异**：`src/main/java/com/example/HelloServlet.java` **连续 5 天完好**（07-03 手动重建后 07-04 / 07-05 / 07-06 / 07-07 无需 touch）；`.jarvis/memory/{MEMORY.md, shared/}` 目录树 07-03 memory probe 留下的 residual 也还在；本轮完全免动 fixture。
- **本次目的**：
  1. **回归确认** 07-06 P0/P1/P2 累积项在 1 天间是否被修复（预期：未修，静默第 14 天）
  2. **DDNS 配置跨启动持久化**：`~/.local/share/jarvis/ddns.json` 07-06 → 07-07 是否原样存活（预期：是；07-06 结束回写的 `test-jarvis-07-04-aaaa/AAAA/t2` 应作为 07-07 启动的"上一状态"复现）
  3. **07-06 未验证项落地**（一次跑通 6 条）：
     - `POST /v1/requirements/:id/review` **manual dispatch** 全 4 状态矩阵（`in_progress` / `review` / `done` / bogus id）
     - **cross-project depends_on** REST 侧写入行为
     - `POST /v1/requirements/:id/reject` 校验（bogus id、无 reason、空 reason）
     - `POST /v1/requirements/:id/conversations` 首入档（POST 侧存在但 GET 缺失）
     - `POST /v1/requirements/:id/todos` 全 shape + kind/status 枚举穷举
     - `PATCH /v1/requirements/:id/todos/:todo_id` shape + status/kind 枚举穷举
  4. **cross-day fingerprint**：sample=0/1/2/3/4 五个 fingerprint 与 07-06 完全一致是第 14 天
- **运行约束**：与 07-06 一致 —— `JARVIS_WORK_MODE=off`、stub LLM key、`JARVIS_PERMISSION_MODE=bypass`；DB 用日期后缀 `-20260707` 全新路径。DDNS + memory 分支另起 `-20260707-ddns` 后缀。为跑 sample=2 中间态另起了 `-20260707-sample2` 干净 DB + 独立端口（`:7098`）。probe 结束后 DDNS `~/.local/share/jarvis/ddns.json` 已回写 07-06 备份（`test-jarvis-07-04-aaaa/AAAA/t2`）。

---

## 0. TL;DR — 与 07-06 的差异

| 项 | 07-06 状态 | 07-07 状态 | 变化 |
| --- | --- | --- | --- |
| `git log --since=2026-07-06` | 0 commit | **0 commit**（HEAD 仍 `64d288a`） | 静默**第 14 天** |
| 工作树未 commit 文件数 | 39 个 | **39 个** | 持平 |
| 522 条 `@jarvis/server` 单测 | 522/522 ✅（7717 ms） | **522/522 ✅**（7625 ms） | 持平（-92 ms 噪声） |
| Servlet 工作目录 | HelloServlet.java 完好 + `.jarvis/memory/` residual | **完全相同**（`HelloServlet.java` **连续 5 天存活**，`.jarvis/memory/{MEMORY.md, shared/}` 也在） | 07-03 fixture 修复延续到第 5 天 |
| P1-A POST + PATCH 4 字段透传 | 全双向静默丢字段 | **仍全双向静默丢字段** | ❌ 未修（第 14 次） |
| P1-B `POST /v1/roadmap/import` | 404 | **404** | ❌ 未修（第 14 次） |
| P1-C `GET /v1/requirements/:id` | 404 | **404** | ❌ 未修（第 14 次） |
| Orphan 行 `POST /v1/projects/no-such/requirements` | 201 + 原样回写 | **完全复现** | ❌ 未修（第 14 次） |
| `depends_on` 跨 id FK bogus (POST) | 通过 | **完全复现** | ❌ 未修（第 10 次） |
| `depends_on` PATCH-only bogus FK | 通过 | **完全复现** | ❌ 未修（第 3 次） |
| **`depends_on` cross-project id FK**（07-06 未验证项 #7 落地） | 未测 | ⚠️ **首入档：PATCH R1 (in PID) with depends_on=[R_P2 in PROJ2] → 200 写入通过** | ⚠️ **07-06 §7 落地：跨项目 id FK **也**不校验，同 §3.5 orphan project_id 一样 store 一律信任 |
| `depends_on` 条件性写回 | omit→undefined, []→[], real→real | **完全复现** | ❌ 未修（第 10 次） |
| `/v1/projects` 列表裸数组 | projects=bare, workflows=`{items}`, workspaces=`{workspaces}` | **完全复现**（三分裂） | ❌ 未修（第 9 次） |
| `confidence < 0.2` 前端兜底 | P0，13 天未修 | **P0，14 天未修** | 持平 |
| `POST /v1/workflows` 500 泄漏 | 10 500 / 3 400（13 shape） | **完全复现**（今 13 shape 探针 10 500 / 3 400 逐字命中） | ❌ 未修（第 8 次） |
| workflow-run cancel 三态 + `finished_at` 首次锁定 | bogus 404 / cancelled 200 no-op / pending 200 | **完全复现**（cancel #1/#2/#3 均 200，`finished_at=2026-07-06T19:08:19.548Z` 三次一字不差） | 持平 |
| cancelled run wire shape 7 keys | `[error, finished_at, id, started_at, status, step_results, workflow_id]` | **完全复现** | 持平 |
| workflow 重名 | 两次 POST 同 name 都 201 UUID 不同 | **完全复现**（`dup-name-07-07` D1 `884b44ae` / D2 `5e944e92`） | 持平 |
| `POST /v1/projects` 显式 `slug` 3 组合 | 显式 slug 首次 201 / 相同显式 slug 409 / 相同 name 无 slug 201 | **完全复现**（`probe-slug-07-07-a` 首次 201；重复 409 `"slug 'probe-slug-07-07-a' already in use"`；相同 name 无 slug → 派生 `probe-slug-07-07` 底名可用不加 -2 后缀） | 持平 |
| sample_count=0/1/2/3/4 五 fingerprint | 全填齐 | **完全复现（第 14 天）** —— sample=0/1/2/3/4 五格 confidence 常数逐字与 07-06 一致 | 持平 |
| DDNS 配置持久化路径 | `~/.local/share/jarvis/ddns.json`（0600 + 明文） | **持久化跨 07-06 → 07-07 存活**：启动前该文件仍是 07-06 回写的 `test-jarvis-07-04-aaaa/AAAA/t2`；今天为跑 probe 主动 `cp` 备份 + 再回写 | ✅ 07-04 → 07-05 → 07-06 → 07-07 **四日结论保持**（现每日复测都能验证跨日持久性） |
| `ddns.status` 8 keys（configured 分支） | `[configured, enabled, hostname, lan_addrs, last_result, provider, public_ip, reachable]` | **完全复现** | 持平 |
| `GET /v1/ddns/config` at configured 7 keys | 复现 | **完全复现** | 持平 |
| `PUT /v1/ddns/config` 不带 `record_type` → `"A"` 默认 | 落地 | **完全复现** | 持平 |
| `record_type` 全谱系透传 | REST 层零字符串校验 A/AAAA/CNAME/TXT/MX/NS/SRV/PTR/SOA/CAA 全 200 echo | **完全复现**（今 10 类全 200 逐字回声，`MX/NS/SRV/PTR/SOA/CAA` 复测通过） | 持平 |
| `interval_seconds` 浮点语义 = `Math.floor(v)` + min-clamp 60 | 6 float 例证已落地 | **完全复现 + 新增 2 例**：`61.5 → 61`（首次 non-clamp 落数）、`100.999 → 100`（进一步 truncation 确认） | ✅ **07-07 加固**：非 60 边界的 float truncation 首次入档 |
| `port` 上下界 `[1, 65535]` 双边硬校 | 落地 | **完全复现**（`port=1` 200 首次入档为最小值边界；65535/65536/100000/0/-1 全复现） | 持平 |
| `provider` 5 白名单硬校 + 未知 → 400 `unknown DDNS provider "<v>"` | 落地 | **完全复现** | 持平 |
| `hostname` 只校 non-empty | Unicode + 300 字符 200 | **完全复现**（`"测试-中文-十四日.duckdns.org"` → 200 逐字；`"a"×300` → 200） | 持平 |
| `POST /v1/ddns/upnp/test` body 参数全被吞 | 落地 | **完全复现**（`{externalPort:9000}` → 响应 `externalPort:7097`；bad type 也不 400） | 持平 |
| `DELETE /v1/ddns/config` curl 3-shape split | 落地 | **完全复现** | 持平 |
| `POST /v1/memory/includes` 全流程 | 落地 | **完全复现** | 持平 |
| `DELETE /v1/memory/includes` 幂等 universal 200 no-op | 落地 | **完全复现**（`/tmp/never-added-07-07` 也 200 no-op） | 持平 |
| `POST /v1/memory/includes/refresh` local_path → 400 | 落地 | **完全复现** | 持平 |
| `GET /v1/memory/includes?scope=user` | 落地 | **完全复现** | 持平 |
| `server/info` 顶层 16 keys | 落地 | **完全复现**（16 keys，仍无 `ddns/memory_enabled/mdns`） | ❌ 未修（第 6 次） |
| `/v1/health` 404 vs `/health` 200 | 未修 | **未修** | ❌ 未修（第 6 次） |
| `no_op:true` 首次 approve 已批 | 复现 | **完全复现** | 持平 |
| **`POST /v1/requirements/:id/review` 4 状态**（07-06 未验证项 落地） | 未测 | ✨ **首入档 4-state matrix**：`in_progress → 409`、`review → 202 dispatched:true`、`done → 409`、bogus → 404 | ✅ **07-06 §7 落地**（POST /:id/review 全语义补齐） |
| **`POST /v1/requirements/:id/reject`** 校验（07-06 未验证项 深化） | 06-27 仅记 "reason 必需" | ⚠️ **首入档**：无 reason → 400 `\`reason\` must not be blank`；`reason:""` → 同 400；bogus id → 404 | ✅ 三分校验矩阵首入档 |
| **`POST /v1/requirements/:id/conversations` REST 存在**（07-07 意外发现） | 全无文档 | ⚠️ **首入档**：POST 存在返 `{requirement, appended:true}`；GET 侧 404；bogus id → 404；bogus conv_id `not-a-uuid` 200 通过（no format check） | ⚠️ **07-07 新落地**：REST 侧存在但 CLAUDE.md 未文档化 |
| **`todos` sub-resource 5 route 全 shape**（07-07 意外发现） | POST 部分记录 | ⚠️ **首入档全面枚举**（详情见 §5 首次发现清单） | ⚠️ **07-07 全 sub-resource 首入档** |

代码侧三个 deferred / 缺陷标记的精确行号仍在原位（今天 grep 三次确认）：
- `packages/server/src/requirements-routes.ts:164-165` 的 `"verification_plan / workflow_id three-state semantics are part of the full Rust handler but out of scope for this port"` 3 行注释。
- `packages/tools/src/register-builtins.ts:13` "未移植清单" 注释含 `"roadmap.import"`；`:166` `"(not yet ported)"`。
- `packages/server/src/workflow-routes.ts:156` 的 `normalizeSteps(body.steps ?? [])` —— 今天 13 shape 探针 10 种 500 泄漏全复现。

---

## 1. 测试配置（分三次起）

### 主分支（§2 / §3 / §4.1-4.4）

```
OPENAI_API_KEY=sk-stub-for-automation-test
JARVIS_PROVIDER=openai
JARVIS_MODEL=gpt-4o-mini
JARVIS_FS_ROOT=/tmp/jarvis-servlet-test
JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-20260707
JARVIS_ADDR=127.0.0.1:7099
JARVIS_WORK_MODE=off
JARVIS_PERMISSION_MODE=bypass
JARVIS_NO_PROJECT_CONTEXT=1
```

启动日志：
```
[jarvis] persistence connected: json:///tmp/jarvis-servlet-test-db-20260707
[jarvis] serve: provider=openai model=gpt-4o-mini addr=127.0.0.1:7099 fsRoot=/tmp/jarvis-servlet-test coding=false auth=none ddns=off mdns=off promptBytes=263
[jarvis] listening on http://127.0.0.1:7099
```

### Sample=2 分支（§4.3 中间态）

主分支所有变量 + 端口/DB 后缀：`JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-20260707-sample2` `JARVIS_ADDR=127.0.0.1:7098`。用途：一个从零开始的干净 DB，让 sample_count 一步一步从 0 → 1 → 2 → 3 递增，独立于主分支。

### DDNS + Memory 分支（§4.5 / §4.6）

```
# 主分支所有变量 +
JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-20260707-ddns
JARVIS_ADDR=127.0.0.1:7097
JARVIS_DDNS_ENABLE=1
JARVIS_ENABLE_MEMORY=1
JARVIS_MEMORY_USER_ROOT=/tmp/jarvis-mem-07-07
```

启动日志（DDNS 分支）：
```
[jarvis] persistence connected: json:///tmp/jarvis-servlet-test-db-20260707-ddns
[jarvis] serve: provider=openai model=gpt-4o-mini addr=127.0.0.1:7097 fsRoot=/tmp/jarvis-servlet-test coding=false auth=none ddns=on mdns=off promptBytes=263
[jarvis] listening on http://127.0.0.1:7097
[ddns] duckdns rejected the update (response: "KO") — check the token/subdomain
```

`[ddns] duckdns rejected the update` 一行即刻验证 `~/.local/share/jarvis/ddns.json` 从 07-06 存活到 07-07 —— 07-06 回写的假 `token:"t2"` 让 duckdns update 一 boot 就 `"KO"`，与预期完全一致。**跨日持久化第 4 天**。

---

## 2. 6 步 Kanban 主线（stub 模式）

```
1) POST /v1/projects  {name:"servlet-2026-07-07",instructions:"..."}
   → 201 project_id=230594a0…；slug 自动 "servlet-2026-07-07"（底 slug 首次可用，不需要 -2 后缀）
2) POST /v1/projects/<pid>/requirements ×6
   [hello wire, echo POST, maven pom, servlet review, smoke test, blocked by]
   全 201，全 triage_state=approved（body 传 approved）
3) GET /v1/projects/<pid>/requirements → items:6 全 backlog
4a) PATCH hello → in_progress               ✅ (200 8 keys)
4b) PATCH echo → review                     ✅ (200 8 keys)
4c) PATCH maven → done                      ✅ (200 8 keys)
4d) POST /v1/requirements/<smoke>/approve   ✅ (200 {no_op:true, approved:true} 因 default triage_state 已 approved)
5) 最终 list：maven=done / echo=review / hello=in_progress / 其余 3 = backlog
```

**07-06 已入档**：`/start`、`/block`、`/complete` **都不是 REST 路由**（agent-侧 tools）。CLAUDE.md 未明写这一点。**今日不再走错**（已按 06-25 之后的 PATCH+/approve 路径写）。

---

## 3. 回归探针（P1 gaps 未修复第 14 次）

### §3.1 P1-A：POST 上 4 字段静默丢

```
BODY = {"title":"probe-4fields-07-07","description":"t","triage_state":"approved",
        "acceptance_policy":"Human",
        "workflow_id":"11111111-1111-1111-1111-111111111111",
        "assignee_id":"user-x",
        "verification_plan":{"steps":[{"kind":"assert","args":{"x":1}}]}}
→ 201 8 keys [conversation_ids, created_at, description, id, project_id, status, title, updated_at]
   has acceptance_policy = False
   has workflow_id = False
   has assignee_id = False
   has verification_plan = False
```

### §3.2 PATCH 上同 4 字段静默丢

```
new = POST {title:"probe-4fields-patch-07-07",triage_state:"approved"}
PATCH /v1/requirements/<new>  {acceptance_policy:"Human", workflow_id:"...", assignee_id:"...", verification_plan:{steps:[]}}
→ 200 同样 8 keys；response 里 acceptance_policy=undefined workflow_id=undefined
```

**07-07 新的重要观察**：**sub-resource POST 端点的响应中，requirement 对象 DO 带 `acceptance_policy` / `triage_state` / `depends_on`**（POST /:id/todos、POST /:id/conversations、PATCH /:id/todos/:todo_id 三处均如此），且 `acceptance_policy` 默认值 = `"subagent"`（默认小写）。**wire-shape 极其非对称**：`POST /requirements` 8 keys 抹掉这 3 字段；`POST /:id/todos`、`POST /:id/conversations`、`PATCH /:id/todos/:todo_id` 内嵌的 `requirement` 是 ~13 keys 全字段。**若同一客户端来回读写不同 endpoint，会看到"POST 时看不见 acceptance_policy，PATCH todo 后又看见"的诡异 shape 抖动**。P1-A 的修法要**统一 shape**（要么全带、要么全去），而非局部补 4 字段。

### §3.3 P1-B：`POST /v1/roadmap/import` 依然 404

```
POST /v1/roadmap/import  {} → 404 "Route POST:/v1/roadmap/import not found"
```

### §3.4 P1-C：`GET /v1/requirements/:id` 依然 404

```
GET /v1/requirements/d3a0e9db-12b1-471b-8651-5ce35ea3ac90 → 404 "Route GET:... not found"
```

### §3.5 orphan project_id 依然被静默接受

```
POST /v1/projects/no-such-proj-07-07/requirements {title:"orphan-07-07",...} → 201
   response.project_id = "no-such-proj-07-07"（原样落盘）
```

### §3.6 `depends_on` 跨 id FK 依然不校验（POST 侧）

```
POST /v1/projects/<pid>/requirements {depends_on:["00000000-0000-0000-0000-000000000000"]}
→ 201 depends_on:["00000000-0000-0000-0000-000000000000"]  （原样写盘）
```

### §3.6b **PATCH-only-depends_on FK 缺陷（复测第 3 次）**

```
new = POST {title:"patch-dep-07-07",triage_state:"approved"}  # 无 depends_on
PATCH /v1/requirements/<new> {depends_on:["99999999-9999-9999-9999-999999999999"]}
→ 200 8 keys，含 `depends_on` (顶级)；bogus UUID 逐字写盘
```

### §3.6c **CROSS-PROJECT `depends_on` FK 也不校验（07-07 首入档 —— 07-06 未验证项 #7 落地）**

```
PROJ2 = POST /v1/projects {name:"cross-project-07-07"} → id=8c1596c8…
R_P2 = POST /v1/projects/<PROJ2>/requirements {title:"in-project-2"} → id=62356a80…
PATCH /v1/requirements/<R1 in PID> {depends_on:["<R_P2 in PROJ2>"]}
→ 200 written through：R1 现在指向另一个 project 里的 requirement id
   R1.project_id ≠ R_P2.project_id 但 REST 不 reject
```

**结论**：`depends_on` 完全不做 FK / cross-project 校验 —— **既不校验 id 存在（bogus UUID 通过），也不校验 project 匹配（跨项目 id 通过）**。auto-loop 处理 cross-project 依赖的行为是 07-06 §7 未验证项之一 —— stub 模式下手工 PATCH 之后 R1 状态保持 `in_progress`，没有被 auto-loop 挪回 backlog（因为 auto-loop off）。**修法应是一处中心 `validateDependsOn` helper** 覆盖 POST(§3.6) + PATCH(§3.6b) + cross-project(§3.6c) 三处，同时报 `bogus id` 与 `cross-project id`。

### §3.6d `depends_on` 条件性写回

```
{title:"dep-omit-07-07"} → response.depends_on:None（键完全缺失）
{title:"dep-empty-07-07",depends_on:[]} → response.depends_on:[]
```

### §3.7 `POST /v1/workflows` 500 泄漏（13-shape 探针）

| body | status | msg | 07-06 期望 |
| --- | --- | --- | --- |
| `{steps:42}` | 500 | `steps.map is not a function` | ✅ |
| `{steps:true}` | 500 | `steps.map is not a function` | ✅ |
| `{steps:"x"}` | 500 | `steps.map is not a function` | ✅ |
| `{steps:{}}` | 500 | `steps.map is not a function` | ✅ |
| `{steps:[42]}` | 500 | `Cannot read properties of undefined (reading 'type')` | ✅ |
| `{steps:[null]}` | 500 | `Cannot read properties of null (reading 'id')` | ✅ |
| `{steps:[{}]}` | 500 | `Cannot read properties of undefined (reading 'type')` | ✅ |
| `{steps:[{"name":"x"}]}` | 500 | `Cannot read properties of undefined (reading 'type')` | ✅ |
| `{steps:[{name,kind:{type:"bogus"}}]}` | 500 | `steps is not iterable` | ✅ |
| `{steps:[{name,kind:{type:"agent"}}]}` | 500 | `Cannot read properties of undefined (reading 'trim')` | ✅ |
| `{steps:[{name,kind:{type:"agent",prompt:""}}]}` | 400 | `agent step 'x' has an empty prompt` | ✅ |
| `{steps:null}` | 400 | `workflow must contain at least one agent step` | ✅ |
| `{name:"wf-13"}` | 400 | `workflow must contain at least one agent step` | ✅ |

**结果**：13/13 与 07-06 期望完全一致 —— 10 shape 泄漏 500 / 3 shape 400 硬校，逐字命中。

### §3.7b `POST /v1/projects` slug 3 组合

```
A: {name:"probe-slug-07-07",slug:"probe-slug-07-07-a"}
   → 201 slug="probe-slug-07-07-a" ✓
B: 相同 body A 再发一次
   → 409 {"error":"slug 'probe-slug-07-07-a' already in use"} ✓
C: {name:"probe-slug-07-07"}  # 无 slug
   → 201 slug="probe-slug-07-07"（底名可用不加 -2 后缀）
```

### §3.7c 列表 shape 三分裂

```
GET /v1/projects   → Array, len=3
GET /v1/workflows  → { items:[] }  # 但今日已 POST 3 workflows，count=3
GET /v1/workspaces → { workspaces:[] }
```

---

## 4. 加深探针（今日专项）

### §4.1 `workflow-runs/:id/cancel` 三态（07-06 落地再确认 + finished_at 三次不变）

```
POST /v1/workflows {name:"cancel-freshness-07-07", steps:[{name:"a",kind:{type:"agent",prompt:"x"}}]} → 201 wf=3f238a6e…

POST /v1/workflows/<wf>/run  {}
   → 202 { id:<run>, workflow_id:<wf>, status:"pending", step_results:[], started_at:... }
     run=507a4588-eb27-405f-95dd-8fa120ef8923

POST /v1/workflow-runs/<run>/cancel  {}       # #1 pending → cancel
   → 200 { id, workflow_id, status:"cancelled", step_results:[],
           started_at, error:"run cancelled by operator",
           finished_at:"2026-07-06T19:08:19.548Z" }   ← 首次锁定

sleep 1;
POST /v1/workflow-runs/<run>/cancel  {}       # #2 cancelled → cancel (no-op)
   → 200 finished_at:"2026-07-06T19:08:19.548Z"      ← **不刷新** ✓

sleep 1;
POST /v1/workflow-runs/<run>/cancel  {}       # #3 又一次
   → 200 finished_at:"2026-07-06T19:08:19.548Z"      ← 三次一字不差 ✓

POST /v1/workflow-runs/11111111-2222-3333-4444-555555555555/cancel {}
   → 404 {"error":"workflow run not found"}   ← select-then-cancel 三态第 3 天复现 ✓

GET /v1/workflow-runs/<run>  → 7 keys [error, finished_at, id, started_at, status, step_results, workflow_id]
```

### §4.2 workflow 重名允许

```
POST /v1/workflows {name:"dup-name-07-07", steps:[{name,kind:{type:"agent",prompt:"x"}}]} × 2
   → 201 D1 id=884b44ae / 201 D2 id=5e944e92   ← 两次都 201，UUID 不同
```

### §4.3 harness.health 全 fingerprint 5 采样（第 14 天全填齐）

主分支已跑 4 requirement runs 到 sample=4；sample=2 用另起的 **干净 DB + 独立端口** 分支从 0 逐步递增：

| sample_count | overall_score | confidence | primary_focus | dim.confidence (task_understanding / planning_execution / capability_invocation / task_delivery) |
| --- | --- | --- | --- | --- |
| 0 (fresh boot) | 50 | 0 | task_understanding | — |
| 1 | 47 | **0.06560095313918246** | planning_execution | ✅ 07-06 复现 |
| 2 | 47 | **0.10397505073716999** | planning_execution | task_understanding=**0.06398464660748923** / planning_execution=**0.17595777817059538** / capability_invocation=**0.031992323303744616** / task_delivery=**0.14396545486685075** ✅ 07-06 复现 |
| 3 | 47 | **0.13120190627836492** | planning_execution | ✅ 07-06 复现 |
| 4 | 47 | **0.15232069614525703** | planning_execution | task_understanding=**0.09373581301246586** / planning_execution=**0.25777348578428116** / capability_invocation=**0.04686790650623293** / task_delivery=**0.2109055792780482** |

**算法稳定第 14 天**：sample=0/1/2/3/4 五格 fingerprint 逐字复现；`confidence = ln(sample+1)/ln(31) × 0.325` 公式跨采样通过。**dim.confidence sample=4 全 4 dim 首次入档**（07-06 只入档 sample=2 的 dim.confidence）；`planning_execution` dim 的 confidence 系数（0.55）仍主导，为 primary_focus 稳定原因。

### §4.3b harness.health wire shape 再校准（第 14 天不变）

```
top-level 12 keys = [actions, confidence, dimensions, evidence, generated_at,
                     overall_score, primary_focus, rules, sample_count, signals, sources, tool]
dimensions.count = 4；dim[*].keys = [confidence, drivers, key, label, score, summary]
actions.count = 5；signals.count = 20；sources.count = 3；rules.keys = [confidence, dimension_weights, overall, scale]
evidence = []（空数组）
```

**07-06 sample=2 fingerprint 填齐后阈值更清晰**：sample<5 全部 confidence <0.16，全走 danger 展示 → **P0 前端 1 行 5 分钟**（`actions.find(a=>a.key==="fill_signal_gaps") && sample_count<5` 判 cold-start），十四天延期依旧。

### §4.4 `/v1/work/{overview,quality}` shape

`/v1/work/overview` 15 顶层 keys = `[actor_breakdown, as_of, blocked_requirements, blocked_truncated, missing_stores, project_leaderboard, recent_failures, requirement_status_counts, run_status_counts, running_now, since, throughput_by_day, truncated, verification_pass_rate, window_days]`
- `actor_breakdown = null`
- `verification_pass_rate = null`
- `throughput_by_day.len = 8`

`/v1/work/quality` 6 顶层 keys = `[as_of, since, top_failing_commands, truncated, verification_pass_rate_by_day, window_days]`
- `verification_pass_rate_by_day.len = 8`

### §4.4b `/v1/diagnostics/runs/{recent,stuck}` 差异

```
recent → { items:[…] }   items[0].keys = [conversation_id, id, logs, requirement_id, started_at, status]  (6 keys)
stuck  → { items:[…] }   items[0].keys = [age_seconds, conversation_id, id, logs, requirement_id, started_at, status]  (7 keys)
```

今日 4 pending runs 全 age>1s，`?threshold_seconds=1` 全返回。

### §4.5 DDNS 后端专项（07-06 结论全复现 + 2 新数据点）

#### §4.5.1 `record_type` REST 层零字符串校验（第 14 天）

10 类 DNS 记录（A / AAAA / CNAME / TXT / MX / NS / SRV / PTR / SOA / CAA）**全 200 逐字 echo passthrough**。REST 层零校验。

#### §4.5.2 `interval_seconds` float 语义（07-07 新 2 数据点）

| interval_seconds | STATUS | 响应 echo | 推断 |
| --- | --- | --- | --- |
| `60.5` | 200 | 60 | floor → 60，clamp 不触 |
| `60.9` | 200 | 60 | floor → 60 |
| `59.5` | 200 | 60 | floor → 59，clamp → 60 |
| `300.7` | 200 | 300 | floor → 300 |
| `60.1` | 200 | 60 | floor → 60 |
| `60.0000001` | 200 | 60 | floor → 60 |
| **`61.5`** | 200 | **61** | ✨ **07-07 新**：floor → 61（首次非-60 non-clamp 数据点） |
| **`100.999`** | 200 | **100** | ✨ **07-07 新**：floor → 100（进一步 truncation 确认，`Math.round(100.999) = 101`） |

**结论**：`61.5 → 61` 是决定性证据 —— 输入 > clamp 阈值时 `Math.floor` 明显不是 `Math.round`。加上 `100.999 → 100`，`Math.floor + min-clamp 60` 语义**在 clamp 边界外**再确认。仍然 **silent 双重变换无 API 文档**。

#### §4.5.3 `port` 上下界对称硬校 `[1, 65535]`

| port | STATUS | error |
| --- | --- | --- |
| `1` | 200 | — （最小值首次入档为边界值） |
| `65535` | 200 | — |
| `65536` | 400 | `"port must be 1..65535"` |
| `100000` | 400 | `"port must be 1..65535"` |
| `0` | 400 | `"port must be 1..65535"` |
| `-1` | 400 | `"port must be 1..65535"` |

#### §4.5.4 `provider` 5 白名单 + 3 黑名单

| provider PUT | STATUS |
| --- | --- |
| `cloudflare/duckdns/dyndns2/aliyun/dnspod` | 200 |
| `nonexistent/bogus/null-thing` | 400 `unknown DDNS provider "<v>"` |

#### §4.5.5 `hostname` 只校 non-empty

| hostname PUT | STATUS | 备注 |
| --- | --- | --- |
| `""` | 400 | `"\`hostname\` is required"` |
| omitted | 400 | 同上 |
| `"测试-中文-十四日.duckdns.org"` | 200 | 逐字回声 |
| `"a"×300`（300 字符） | 200 | **无 length cap** |

**07-07 意外**：300 字符 hostname 在 §4.5.5 存活后 **直接漏进 remote/info + remote/pairing origins**：

```
GET /v1/remote/info.external.hostname = "aaaa...a" (300 chars)
GET /v1/remote/pairing.origins[2] = "http://aaaa...a:7097" (URI-encoded 到 pairing_links[2].link 的 jarvis://pair?origin=... query)
GET /v1/remote/pairing.pairing_links[2].link 中的 origin URL 参数 URI-encode 后长度 ~350 字符
```

**300 字符 hostname 不但 PUT 通过，还渗透到 pairing 链接** —— iOS 客户端扫码得到超长 URL；DNS 层最终必然拒（253 字符规范上限）。整个流水线全无 fail-fast。

#### §4.5.6 `POST /v1/ddns/upnp/test` body 参数全被吞

| POST body | STATUS | 响应 externalPort / internalPort |
| --- | --- | --- |
| `{}` | 200 | 7097 / 7097 |
| `{externalPort:9000}` | 200 | 7097 / 7097 |
| `{internalPort:8080}` | 200 | 7097 / 7097 |
| `{externalPort:9000,internalPort:8080}` | 200 | 7097 / 7097 |
| `{externalPort:"nine-thousand"}` | 200 | 7097 / 7097 |

**结论**：no-parameter endpoint 第 2 天复现。响应 4 keys `[mapped, externalPort, internalPort, message]`。

#### §4.5.7 `DELETE /v1/ddns/config` curl 3-shape

| DELETE request | STATUS | 说明 |
| --- | --- | --- |
| 无 CT header | 404 | Fastify route 未注册 |
| CT application/json + empty body | 400 `FST_ERR_CTP_EMPTY_JSON_BODY` | body-parser 抢先 |
| CT application/json + `{}` body | 404 | body-parser 通过后 route 未注册 |

#### §4.5.8 DDNS `~/.local/share/jarvis/ddns.json` 07-06 → 07-07 存活

启动前 `cat ~/.local/share/jarvis/ddns.json`：
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

**跨日持久化第 4 天**：07-04 → 07-05 → 07-06 → 07-07 四跳全存活。本轮 probe 结束已回写 07-06 备份 `test-jarvis-07-04-aaaa/AAAA/t2`（`cp /tmp/ddns-backup-07-07.json ~/.local/share/jarvis/ddns.json`）。

### §4.6 Memory 后端（backend=none 分支复测）

```
GET /v1/memory/sync_status → 200 {backend:"none", user_root:"/tmp/jarvis-mem-07-07", workspace_root:"/tmp/jarvis-servlet-test"}
GET /v1/memory/includes?scope=workspace → 200 {scope:"workspace", memory_md, items:[]}
GET /v1/memory/includes?scope=user → 200 {scope:"user", memory_md, items:[]}
POST /v1/memory/sync_setup {} → 503 {"error":"git sync setup only applies to the \`git\` backend","backend":"none"}
POST /v1/memory/sync {} → 503 {"error":"memory.sync only applies to the \`git\` backend — current backend is not git","backend":"none"}

# includes.add
mkdir -p /tmp/shared-memory-07-07 && echo "# tone\n- keep it terse" > /tmp/shared-memory-07-07/MEMORY.md

POST /v1/memory/includes {"target":"/tmp/shared-memory-07-07"}
   → 200 {ok:true, added, scope:"workspace", memory_md}

POST /v1/memory/includes {"target":"/tmp/shared-memory-07-07/MEMORY.md"}  # 文件而不是目录
   → 400 {"error":"include \`.../MEMORY.md\` has no MEMORY.md (looked at the directory itself and at .jarvis/memory/ underneath)"}

POST /v1/memory/includes {} → 400 {"error":"missing \`target\`"}

GET /v1/memory/includes?scope=workspace
   → items:[ {target, kind:"local_path", resolves:true, path} ]  # 4 keys

POST /v1/memory/includes/refresh {"target":"/tmp/shared-memory-07-07"}
   → 400 {"error":"refresh only applies to git+ includes"}

DELETE /v1/memory/includes {"target":"/tmp/shared-memory-07-07"}  # #1 真删
   → 200 {ok:true, removed:"/tmp/shared-memory-07-07", scope:"workspace"}
DELETE 同 target  # #2
   → 200 幂等 no-op ✓
DELETE {"target":"/tmp/never-added-07-07"}
   → 200 幂等 no-op ✓
```

三种幂等风格再复现：`DELETE /v1/memory/includes` universal 200 no-op / `POST /v1/workflow-runs/:id/cancel` select-then-cancel / `POST /v1/requirements/:id/reject` bogus 404.

### §4.7 `/v1/remote/info` + `/v1/remote/pairing`（今日 300 字符 hostname 漏出）

```
GET /v1/remote/info
  → {device_name, lan_addrs:["192.168.1.164","198.18.0.1"], port:7097,
     external:{hostname:"<300 chars 'a'>", public_ip:"67.200.120.26", reachable:null},
     requires_auth:false, version:"0.2.0"}   ← 6 顶层 keys

GET /v1/remote/pairing
  → {device_name, token:null,
     origins:["http://192.168.1.164:7097","http://198.18.0.1:7097","http://<300 chars 'a'>:7097"],
     pairing_links:[ 3 objects: {origin, link} ] }   ← 4 顶层 keys
```

- `external.hostname` = **300 字符 `"aaaa...a"`**（今日 §4.5.5 最后一次 PUT 遗留） —— **跨界渗透**：DDNS PUT 不校验 → hostname 直接进入 remote/info → 再直接编码到 remote/pairing 的 `jarvis://pair?origin=...` link。iOS 扫码会拿到超长 URL。

### §4.8 各"feature off" 503 pattern（第 14 天不变）

```
/v1/agent-profiles          → 503 "agent profile store not configured"
/v1/memories                → 503 "memory store not configured"
/v1/learning/skill-usage    → 503 "learning store not configured"
/v1/automations             → 503 "automation store not configured"
/v1/channels                → 503 "channel-instance store not configured"
/v1/plugins                 → 503 "plugin manager not configured"
/v1/diagnostics/worktrees/orphans → 503 "worktree feature not configured"
/v1/skills                  → 503 "skill catalogue not configured"
/v1/diagnostics/memory      → **200** {backend:"unknown", stats_available:false}  ← 唯一 200+flag
```

Feature-off 8 route 里 **7 走 503**，**1 走 200+flag** —— inconsistency 持平。

### §4.9 `/v1/health` vs `/health`

```
GET /health    → 200 {status:"ok"}
GET /v1/health → 404 "Route GET:/v1/health not found"
```

### §4.10 **`POST /v1/requirements/:id/review` manual dispatch 4-state matrix（07-06 未验证项落地）**

```
attempt on hello (status=in_progress):
  → 409 {"error":"requirement not at review","status":"in_progress"}

attempt on echo (status=review):
  → 202 {"dispatched":true,"requirement_id":"706b70d0-..."}

attempt on maven (status=done):
  → 409 {"error":"requirement not at review","status":"done"}

attempt on bogus id 00000000-...:
  → 404 {"error":"requirement \`00000000-...\` not found"}

/review with body {note:"ignored"} → 202 same shape (body 完全 no-op consumed)
/review no body                    → 202 same shape
second call same requirement (status=review) → 202 dispatched:true again (idempotent — 每次 dispatch 一次 reviewer subagent)
```

**结论**：4 状态 + body no-op + 幂等 —— review 是 "select-then-fire" 语义，与 workflow-run cancel 的 "select-then-cancel" 同族。**唯一的 gate 是 `status === "review"`；trigger 是幂等的**（每次都会新 fire）。**07-06 未验证项 #7 首日全条覆盖**。

**409 error message shape** = `{error, status:"<current-status>"}` —— error string + 当前状态字段（首次入档语义）。

**07-07 副作用**：R2（`echo POST`，`status=review`）跑完 /review 后 activity 里落下一条 `kind:"comment", body:{kind:"reviewer_dispatched_manually"}` 记录 —— **手动 dispatch 用 comment 而非新 kind** 是 activity 类型体系的一个"复用"决策。

### §4.11 **`POST /v1/requirements/:id/reject` 三态**

```
reject with reason={reason:"test"} on bogus id:
  → 404 {"error":"requirement \`00000000-...\` not found"}

reject on real id without reason field:
  → 400 {"error":"\`reason\` must not be blank"}

reject on real id with reason="":
  → 400 {"error":"\`reason\` must not be blank"}   ← 空串 = trim-aware
```

**07-07 首入档全 3 校验**：bogus id → 404 (**非幂等** — 与 approve 的 200 no-op 对称对比)；reason 必需 + trim-aware（`""` 也 400）；错误串 `\`reason\` must not be blank`。

### §4.12 **`POST /v1/requirements/:id/conversations` 首入档（REST 侧存在但 CLAUDE.md 未文档化）**

```
POST /v1/requirements/<R1>/conversations
  body={"conversation_id":"11111111-1111-1111-1111-111111111111"}
  → 200 {requirement:{...13 fields}, appended:true}

POST body={} (missing conversation_id)
  → 400 {"error":"\`conversation_id\` is required"}

POST body={"conversation_id":"not-a-uuid"}  # bad format
  → 200 written through — REST 层 zero format check

POST on bogus requirement id:
  → 404 {"error":"requirement \`00000000-...\` not found"}

GET /v1/requirements/<R1>/conversations
  → 404 {"message":"Route GET:...not found"}   # 仅 POST 侧存在
```

**结论**：
- **POST 存在，GET 缺失**（与 §3.4 `GET /v1/requirements/:id` 缺失是一个 pattern —— read-side 稀薄）
- **`conversation_id` 无 UUID 格式校验** —— `"not-a-uuid"` 直接落盘并进入 `conversation_ids` 数组
- **requirement id FK 生效**（bogus → 404）
- **响应体的 `requirement` 是 ~13 keys 全 shape**（含 `acceptance_policy:"subagent"` + `triage_state:"approved"` + `depends_on`），与 POST /requirements 的 8 keys **shape 大不同**
- **`conversation_ids` 是数组累积** —— 每次 POST 只 append，不去重

### §4.13 **`todos` sub-resource 五 route 首入档全 shape**

**Todo model** `packages/project/src/requirement.ts:34-88`：

```typescript
RequirementTodoKind    = "work" | "check" | "ci" | "deploy" | "review" | "manual"   // 6 值
RequirementTodoStatus  = "pending" | "running" | "passed" | "failed" | "skipped" | "blocked"  // 6 值
RequirementTodoCreator = "human" | "agent" | "workflow"  // 3 值
```

**`POST /v1/requirements/:id/todos`** —— 创建 todo：

```
minimal: {title:"t1"}  → 201 {todo:{id, title, kind:"work"(默认), status:"pending"(默认), created_by:"human"(默认), ...}, requirement:{...13 fields}}

kind matrix (源码值):
  work     → 201 ✓  |  check → 201 ✓  |  ci → 201 ✓  |  deploy → 201 ✓  |  review → 201 ✓  |  manual → 201 ✓
  verify   → 400 "unknown todo kind \`verify\`"
  implement → 400 "unknown todo kind \`implement\`"
  docs      → 400 "unknown todo kind \`docs\`"
  test      → 400 "unknown todo kind \`test\`"
  bogus     → 400 "unknown todo kind \`bogus\`"

status matrix (POST 覆盖默认):
  pending / blocked / running / passed / failed / skipped → 201 ✓ (6 值全接受)
  done      → 400 "unknown todo status \`done\`"
  in_progress → 400 "unknown todo status \`in_progress\`"
  open / closed / completed / review / resolved / active → 全 400

body 无 title  → 400 "\`title\` must not be blank"
body title=""  → 400 "\`title\` must not be blank"  (trim-aware)
body 有 evidence:{run_id, ...}  → 201 written through
body 有 depends_on:[<todo-ids>]  → 201 written through (无 FK check)
body 有 created_by="human"/"agent"/"workflow"  → 201 ✓；其他 → 400 "unknown todo creator \`...\`"
```

**副作用**：POST /todos 落一条 `activity kind:"comment", body:{kind:"requirement_todo_created", todo_id, todo_kind, title}` —— 与 /review 的 `body.kind:"reviewer_dispatched_manually"` 同族 (activity 复用 comment kind + inner body.kind 分类)。

**`GET /v1/requirements/:id/todos`** —— 拉 todo 列表：

```
→ 200 {requirement_id, items:[{id, title, kind, status, created_by, created_at, updated_at}]}
   items[*] 7 keys (todo 主 shape)
```

**`PATCH /v1/requirements/:id/todos/:todo_id`** —— 更新单条 todo：

```
PATCH status=pending/running/passed/failed/skipped/blocked → 200 ✓ (6 值全接受)
PATCH status=done → 400 "unknown todo status \`done\`"
PATCH status=<其他> → 400

PATCH title=""  → 400 "\`title\` must not be blank"
PATCH title="renamed"  → 200 {todo:{title:"renamed",...}, requirement:{...13 fields}}

PATCH 支持字段：title, status, kind, command, evidence, depends_on  (源码 :690-712)
```

**`DELETE /v1/requirements/:id/todos/:todo_id`** —— 未实测（08-08+ 需覆盖）

**`PATCH /v1/requirements/:id/todos`** (batch) —— **07-07 未测**，源码在 :657-693 —— 批 status 更新，body `{ids:[...], status:"..."}`：ids 非空数组必需，status 6-枚举校验。08-08 需覆盖。

### §4.14 服务端信息（`server/info` 16 keys 复现）

```
tool_count = 47
mcp_servers = []  ← 无 MCP 时为空数组
memory = { mode: "window", budget_tokens: 108000 }
providers = [{name:"openai", ...}]   ← 数组 shape
persistence = "json:///tmp/..."
```

16 顶层 keys 完全复现 07-06；仍无 `ddns` / `memory_enabled` / `mdns` / `access_token_configured` —— 客户端需分别 hit `/v1/ddns/status` / `/v1/memory/sync_status` / `/v1/remote/info` 3 个 endpoint 才知全部 feature 开关状态。

---

## 5. 07-07 首次发现清单

1. **✨ `POST /v1/requirements/:id/review` 4-state matrix 全落地**（07-06 未验证项 #7 首日覆盖）：
   - `status=in_progress` → 409 `{error:"requirement not at review", status:"in_progress"}`
   - `status=review` → 202 `{dispatched:true, requirement_id}`
   - `status=done` → 409 `{error:"requirement not at review", status:"done"}`
   - bogus id → 404 `{error:"requirement \`...\` not found"}`
   - **body 无关**（`{note:"ignored"}` 也 200 no-op consumed，与 `POST /v1/ddns/upnp/test` 同族）
   - **幂等 fire** —— 二次同 requirement /review 再 dispatch，落两条 `reviewer_dispatched_manually` activity
2. **✨ `depends_on` cross-project id FK 也不校验**（07-06 未验证项 #7 深化）：`PATCH R1(in P1) depends_on=[<R in P2>]` → 200 通过。加上 §3.6（bogus UUID 通过）+ §3.6b（PATCH-only bogus 通过），得**三条同源同修法的 FK 缺陷**。修法 = 一个中心 `validateDependsOn` helper 同时覆盖 POST + PATCH + cross-project 三情境。
3. **✨ `POST /v1/requirements/:id/conversations` REST 侧存在** but CLAUDE.md 未文档化：
   - POST body `{conversation_id}` 必需（缺 → 400 `\`conversation_id\` is required`）
   - **conversation_id 无 UUID 格式校验**（`"not-a-uuid"` 200 通过）
   - requirement id FK 生效（bogus → 404）
   - 响应 `{requirement:{...13 fields}, appended:true}`
   - **GET 侧不存在**（404），与 §3.4 `GET /v1/requirements/:id` 缺失同 pattern
   - `conversation_ids` 数组累积（不去重）
4. **✨ 全 `todos` sub-resource shape + 枚举穷举**（`packages/project/src/requirement.ts:34-88` 权威源码）：
   - `TodoKind` 6 值：`work` / `check` / `ci` / `deploy` / `review` / `manual`（对客户端不直观 —— `test`/`docs`/`implement` 全 400）
   - `TodoStatus` 6 值：`pending` / `running` / `passed` / `failed` / `skipped` / `blocked`（`done`/`in_progress` 全 400 —— **与 requirement.status 完全不同！易混淆**）
   - `TodoCreator` 3 值：`human` / `agent` / `workflow`
   - todo POST 落 `activity kind:"comment", body:{kind:"requirement_todo_created",...}`
   - **PATCH 支持 body fields = title/status/kind/command/evidence/depends_on**（源码 :690-712，wire shape 未文档化）
   - **未测：DELETE + batch PATCH `/todos` (`{ids, status}`)** —— 08-08+ 需覆盖
5. **✨ `POST /v1/requirements/:id/reject` 三态**（07-06 未验证项 #2 深化）：
   - bogus id → 404
   - 无 reason → 400 `\`reason\` must not be blank`
   - `reason:""` → 400 `\`reason\` must not be blank`（trim-aware）
6. **✨ `interval_seconds` float 语义 2 新数据点**：`61.5 → 61`（首个非 60 clamp 边界数据点）、`100.999 → 100`（非 60 clamp 域，`Math.round(100.999)=101` 排除 round 语义）。`Math.floor + min-clamp 60` 语义在 clamp 边界外的 truncation 再确认。
7. **✨ hostname 300 字符 → remote/pairing origin 漏出（cross-feature 渗透）**：
   - §4.5.5 `PUT /v1/ddns/config hostname=<300 'a'>` → 200 逐字接受
   - §4.7 `GET /v1/remote/info.external.hostname` = 同 300 字符
   - §4.7 `GET /v1/remote/pairing.origins[2]` = `http://<300 'a'>:7097`
   - `pairing_links[2].link` = `jarvis://pair?origin=<URI-encoded 300 chars>&name=...`
   - iOS 扫码得到超长 URL，DNS 层规范 253 字符必然 fail —— 全流水线**零 fail-fast**
8. **✨ `POST /v1/requirements/:id/conversations` 上 `conversation_id="not-a-uuid"` 200 通过**：与 §3.6/§3.6b/§3.6c depends_on 无 FK/format 校验、§3.5 orphan project_id 无 FK 校验同族 —— **REST 层普遍信任客户端 UUID 格式**，仅 `requirement.id` / `workflow_run.id` 硬校 404。**"which id fields are format-checked" 是一个隐性 API contract**。
9. **✨ Activity `kind` 复用 pattern**：`activity.kind ∈ {comment, run_started, status_change}`，`comment` 是通用容器 —— `body.kind:"requirement_todo_created"` / `body.kind:"reviewer_dispatched_manually"` / `body.kind:"requirement_todos_batch_updated"` 全部**嵌套**在 `kind:"comment"` 下。UI 分类需读 **`body.kind`（inner）** 而非 `kind`（outer）。
10. **✨ POST /:id/review body no-op**（body 完全被吞类似 `POST /v1/ddns/upnp/test`）—— body `{note:"ignored"}` 与 no-body 响应完全一致。文档缺。

---

## 6. 未修复清单（P0/P1/P2 累积）

**P0**（前端 1 行 5 分钟）：
- confidence < 0.2 前端兜底（读 `actions.find(a=>a.key==="fill_signal_gaps") && sample_count<5`）— **14 天未修**。sample=2 fingerprint 填齐后阈值明确（sample<5 时 confidence 全 <0.16）。

**P1**（REST 层缺 route / FK / 字段透传）：
- POST + PATCH 4 字段（`acceptance_policy` / `workflow_id` / `assignee_id` / `verification_plan`）静默丢 — 14 天未修
  - **07-07 补加**：wire-shape 非对称—— POST /requirements = 8 keys 抹掉，POST /:id/todos + /:id/conversations + PATCH /:id/todos/:tid 里内嵌 requirement = ~13 keys 全字段。修法应统一 shape。
- `POST /v1/roadmap/import` 404 — 14 天未修
- `GET /v1/requirements/:id` 404 — 14 天未修
- **`GET /v1/requirements/:id/conversations` 404**（07-07 新加，仅 POST 侧存在）—— read-side 稀薄同 §3.4 pattern
- orphan project_id 无 FK — 14 天未修
- `depends_on` 跨 id FK POST 侧无校验 — 10 天未修（同源 bug PATCH 侧 3 天未修；07-07 加固 **cross-project 也不校验** —— 三条同源，修法 = 中心 `validateDependsOn` helper）
- **`POST /:id/conversations` conversation_id 无 UUID 格式校验**（07-07 新加）—— 同族 no-format-check bug
- `POST /v1/workflows` 500 泄漏 10 shape — 8 天未修（`workflow-routes.ts:156` 单点 + 5 内 guard 处 = 6 处 type guard）
- `DELETE /v1/ddns/config` 未注册 route — 6 天未修

**P2**（一致性 / 语义 / 文档缺）：
- `/v1/projects` 列表裸数组，与 `{items}/{workspaces}` 三分裂 — 9 天未修
- `/v1/health` 404，`/health` 200 — 6 天未修
- `server/info` 不反映 `ddns/memory_enabled/mdns/access_token` — 6 天未修
- `/v1/diagnostics/memory` 200+flag vs 其余 feature-off 503 — 长期
- `depends_on` 条件性写回 shape drift — 10 天未修
- DDNS PUT 3 处 soft-accept（`record_type` 零校验、`interval_seconds` silent floor+clamp、`credentials={}` 空对象接受）— 3 天未修
- `hostname` 只校 non-empty（Unicode + 300 字符全通过）— 2 天未修
  - **07-07 加固**：300 字符 hostname → remote/pairing origin 漏出 → iOS pairing 超长 URL，**cross-feature 渗透**
- `POST /v1/ddns/upnp/test` body 静默无效（no-parameter endpoint）— 2 天未修
- `/start` `/block` `/complete` 是 agent tools 而非 REST，CLAUDE.md 未明写 — 2 天未修
- **`POST /:id/review` body 静默无效**（07-07 新加）—— 与 upnp/test body 同族
- **CLAUDE.md 未列 `POST /:id/conversations` REST 存在**（07-07 新加）
- **Todo `status` / `kind` / `created_by` 枚举与 Requirement 完全不同**（07-07 新加）—— 客户端极易混淆（`done`→400、`work` 是默认 kind）；文档缺
- **Activity `body.kind` inner-classifier convention**（07-07 新加）—— UI 分类需读 inner，未文档化
- **UUID 格式校验非一致**（07-07 加固）—— 只有 `requirement.id` / `workflow_run.id` 硬校 404；`project_id` / `conversation_id` / `depends_on[*]` / `assignee_id` 全无 UUID 格式校验

---

## 7. 复现 commands 一键版

```bash
# 主分支（§2/§3/§4.1-4.4 + §4.10-4.14）
export OPENAI_API_KEY=sk-stub-for-automation-test
export JARVIS_PROVIDER=openai JARVIS_MODEL=gpt-4o-mini
export JARVIS_FS_ROOT=/tmp/jarvis-servlet-test
export JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-<YYYYMMDD>
export JARVIS_ADDR=127.0.0.1:7099
export JARVIS_WORK_MODE=off JARVIS_PERMISSION_MODE=bypass JARVIS_NO_PROJECT_CONTEXT=1
node --experimental-strip-types packages/jarvis-app/src/main.ts serve &
# Sample=2 干净 DB（§4.3）
export JARVIS_ADDR=127.0.0.1:7098
export JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-<YYYYMMDD>-sample2
node --experimental-strip-types packages/jarvis-app/src/main.ts serve &
# DDNS + Memory 分支（§4.5/§4.6）
export JARVIS_ADDR=127.0.0.1:7097
export JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-<YYYYMMDD>-ddns
export JARVIS_DDNS_ENABLE=1 JARVIS_ENABLE_MEMORY=1
export JARVIS_MEMORY_USER_ROOT=/tmp/jarvis-mem-<YYYYMMDD>
node --experimental-strip-types packages/jarvis-app/src/main.ts serve &

# 若要跑真 LLM 端到端
export OPENAI_API_KEY=<真 key> JARVIS_ENABLE_FS_WRITE=1 JARVIS_ENABLE_FS_EDIT=1 JARVIS_ENABLE_SHELL_EXEC=1
export JARVIS_WORK_MODE=auto JARVIS_WORK_TICK_SECONDS=10 JARVIS_WORK_MAX_CONCURRENT=1
# DDNS 真后端复测
export JARVIS_DDNS_PROVIDER=duckdns JARVIS_DDNS_HOSTNAME=<真 duckdns 子域> \
       JARVIS_DDNS_CREDENTIALS='{"token":"<真 duckdns token>"}'
# memory git 后端复测
export JARVIS_MEMORY_SYNC_BACKEND=git
# access-token + pairing 复测
export JARVIS_ACCESS_TOKEN=<32B random>
```

未验证项（继续滚到下一次）：

- **仍留白**（06-30 → 07-07 累积）：subagent.review **实际 flip requirement.status** 的行为（stub 无 LLM 只落 activity，不改 status）；triage.scan_candidates 建 ProposedByScan；project.checks 识别 Maven 缺 pom.xml；step_results[*] shape 在有 LLM key 时；`POST /v1/workflow-runs/:succeeded_run/cancel` 是否 200 no-op
- **07-03 → 07-07 累积新留白**：
  - `JARVIS_MEMORY_SYNC_BACKEND=git` 起飞后 `POST /v1/memory/sync_setup` / `sync` 的 happy-path shape
  - `POST /v1/memory/includes body={target:"git+https://..."}` happy path shape + `kind:"git"` include shape + `refresh` on `kind:"git"` happy path
  - `JARVIS_ACCESS_TOKEN=<token>` 起飞后 `GET /v1/remote/pairing` 的 `token` 字段 + `pairing_links[*].link` 是否带 `?token=<val>`
  - `POST /v1/ddns/upnp/test` 在真有 UPnP gateway 网络下的 shape
- **07-06 留白**：
  - `PATCH /v1/requirements/:id status:"done"` 在 depends_on 未完成时是否被 auto-loop 拦截
  - `POST /v1/ddns/update` 在假 `record_type:"MX"/"NS"/"SRV"` 时的 provider adapter 拒绝路径
  - `GET /v1/ddns/config` at `configured:false` 分支 (要 `rm ~/.local/share/jarvis/ddns.json`)
  - hostname 300 字符 → provider adapter 是否 fail？REST 通过后 update 时才 fail 的具体错误串？
  - `server/info.mcp_servers` shape（当有 MCP 时）
- **07-07 新留白**：
  - `DELETE /v1/requirements/:id/todos/:todo_id` (源码未查是否存在)
  - **batch `PATCH /v1/requirements/:id/todos`** `{ids:[...], status:"..."}` 语义 —— 源码 :657-693，未测
  - **Todo `evidence` field** wire shape 全字段 —— `{run_id, exit_code, stdout_excerpt, stderr_excerpt, artifact_url, note}` 6 optional keys；POST/PATCH 端 evidence body 校验行为未测
  - **Todo `depends_on` FK** —— 源码 :634-638 允许 `body.depends_on:string[]` 落盘，是否 FK check？（大概率同 requirement.depends_on = 不校验）
  - **`POST /v1/requirements/:id/conversations` 上 conversation_id 存在性 FK** —— `not-a-uuid` 200 通过说明无格式校验；真 UUID 但不存在的 conversation 呢？
  - `POST /v1/requirements/:id/review` 在 acceptance_policy=`"Human"` 时的分支（因 §3.1 4 字段被抹掉，policy 无法从 REST 侧设 `Human`，此分支无法从 REST 单独测）

---

## 8. 总览

| 项 | 评分 | 与 07-06 比 |
| --- | --- | --- |
| Kanban (Project + Requirement CRUD + 状态转换 + Activity) | ✅ 健康 + `/review` 4-state / `/reject` 三态 首入档 | **07-07 加固** |
| Workflow CRUD + dispatch + cancel（bogus 404 / cancelled 200 no-op / `finished_at` 不刷新） | ✅ 健康（除 §3.7 的 10 种 500 泄漏） | 持平 |
| Diagnostics (`/v1/diagnostics/*` + `/v1/work/*`) | ✅ 健康 | 持平 |
| Harness.health 算法实装 | ✅ 稳定第 14 天 —— sample=0/1/2/3/4 全填齐；sample=4 dim.confidence 4 数首次入档 | **07-07 sample=4 dim.conf 补齐** |
| Harness.health 信号采集 | ⚠️ 缺 LLM 驱动时无信号；顶层 `actor_breakdown` / `verification_pass_rate` null | 持平 |
| Harness.health 前端表达 | ❌ confidence 低分仍直接展示 score | **14 天未修** |
| DDNS 后端 | ✅ 健康 + record_type/interval_seconds/port/provider/hostname 五校验矩阵 + upnp/test body 全吞 + DELETE 3-shape + 300 字符 hostname 跨界渗透到 pairing origin | **07-07 cross-feature 渗透新落地** |
| Memory 后端（backend=none） | ✅ 健康 + 全 include/refresh 语义 + DELETE 幂等 universal 200 no-op | 持平 |
| REST ↔ 数据模型一致性 | ❌ 4 字段 POST+PATCH 丢；project_id 无 FK；depends_on 三处无 FK（POST+PATCH+cross-project 同源）；无 `GET /v1/requirements/:id`；`POST /:id/conversations` 存在但 CLAUDE.md 未列且 GET 缺；depends_on 条件性写回；list shape 三分裂；UUID 格式校验非一致（仅 requirement/workflow_run 硬校） | **07-07 加固 3 缺陷** |
| Requirement sub-resources 完整覆盖 | ✅ **07-07 全 shape 首入档**：POST/GET/PATCH todos + POST /review + POST /reject + POST /conversations + GET /activities；Todo 6 kind + 6 status + 3 creator 全枚举穷举 | **07-07 补齐** |
| 文档 ↔ 运行时一致性 | ⚠️ roadmap.import 文档 ✅ 但 404；`server/info` 不反映 DDNS/memory；`POST /:id/conversations` 完全无 REST 文档；`/v1/health` 404；DELETE 无 body 时 fastify 400/415（真相 = 无 route）；upnp/test + remote/pairing + GET /ddns/config + /start/block/complete + review body no-op + Todo enum 差异全未文档；Activity `body.kind` inner-classifier convention 未文档 | **07-07 又揭底更多缺口** |
| 单测覆盖 | ✅ 522/522 全绿，7625 ms | 持平（噪声内） |
| **真 bug**：`POST /v1/workflows` 500 泄漏 | ❌ 13 shape 探针 → 10 500 / 3 400 全复现（逐字命中 07-06 全部 msg） | 持平（第 8 次） |
| **真 bug**：`DELETE /v1/ddns/config` 无 handler + 3-shape split | ❌ 完全复现 | 持平 |
| **真 bug**：DDNS PUT 3+2+1 处 soft-accept | ❌ 07-05 3 处 + 07-06 hostname/upnp 2 处 + 07-07 加固 hostname 跨界渗透 1 处 | **07-07 加固** |
| **真 bug**：depends_on 三处无 FK 同源 | ❌ 全复现 + cross-project 首入档 | **07-07 加固** |
| 自动化的端到端验证（有 LLM key） | ❌ 本次仍未执行 | 持平 |

**总体判断**：HEAD 在 06-23 → 07-07 **十四天**没动，工作树未 commit 文件持平 39，所以 07-06 的所有 P0/P1/P2 结论**原样成立**。本次实际增量价值：

1. **07-06 未验证项落地 6 条一次跑通**：
   - **✨ `POST /:id/review` 4-state matrix 全落地**（含 body no-op + 幂等 fire + 409 `{error, status}` shape）
   - **✨ `POST /:id/reject` 三态**（bogus 404 / 无 reason 400 / 空 reason trim-aware 400）
   - **✨ cross-project `depends_on` FK 也不校验** —— 与 §3.6 (POST bogus) + §3.6b (PATCH-only bogus) 得三条同源 FK 缺陷
   - **✨ `POST /:id/conversations` REST 侧存在** —— CLAUDE.md 未列，`conversation_id` 无 UUID 格式校验，GET 缺
   - **✨ 全 `todos` sub-resource 五 route + Todo `kind`/`status`/`creator` 三 6-6-3 枚举穷举** —— `packages/project/src/requirement.ts:34-88` 权威源码
   - **✨ `interval_seconds` float truncation 2 新数据点**（`61.5→61` 首个非-60 clamp 域数据点）
2. **07-07 意外新落地 3 条**（07-06 未预告）：
   - **✨ hostname 300 字符 → remote/pairing origin 跨界渗透** —— 全流水线零 fail-fast，iOS pairing 拿超长 URL
   - **✨ Activity `body.kind` inner-classifier convention** —— UI 分类需读 inner；`comment` 是通用容器
   - **✨ UUID 格式校验非一致** —— 只有 `requirement.id` / `workflow_run.id` 硬校；`project_id` / `conversation_id` / `depends_on[*]` / `assignee_id` 全放行
3. **fingerprint 稳定第 14 天** & **sample=4 dim.confidence 补齐**（sample=2 是 07-06 补齐；今日补 sample=4 四 dim 具体 confidence）
4. **cross-day 持久化 chain 第 5 天**：`~/.local/share/jarvis/ddns.json` 07-03 → 07-04 → 07-05 → 07-06 → 07-07 五跳跨日存活

**建议**：下次合 P1 修复时**同时**做（相较 07-06 添加 3 项）：①4 字段透传 create+patch **且统一 sub-resource 响应 shape**（07-07 新加：POST /:id/todos + POST /:id/conversations + PATCH todos 内嵌 requirement 是 13 keys，POST /requirements 是 8 keys —— 决定要统一到哪一边）；②project_id FK + `GET /v1/requirements/:id` + **`GET /v1/requirements/:id/conversations`**（07-07 新加）；③depends_on FK 中心 helper 覆盖 **POST + PATCH + cross-project 三处**（07-07 加固）；④workflow POST 6 处类型守卫；⑤`DELETE /v1/ddns/config` 加 route；⑥`server/info` 补 ddns/mdns/memory_enabled/access_token_configured 字段；⑦一次性 codify 到 CLAUDE.md：DDNS 5 route + memory 4 route + workflow-run cancel 三态 + slug 409 + **`POST /:id/review` 4-state + `POST /:id/reject` 三态 + `POST /:id/conversations` + `POST /:id/todos` + Todo 6 status/6 kind/3 creator 枚举**（07-07 新加）；⑧DDNS PUT 三处 soft-accept + hostname 跨界渗透改 hard-reject（`hostname` 加 punycode + 253 长度校 + record_type 枚举 + interval < 60 400 + credentials per-provider required key 校）；⑨CLAUDE.md 明写 `/start` `/block` `/complete` 是 agent tools 无 REST；⑩**07-07 新**：`POST /:id/conversations` 上 conversation_id UUID 格式校 + statement of Activity `body.kind` inner-classifier convention + 统一 sub-resource wire-shape 决策。

**P0 修复（14 天）**：前端读 `actions.find(a => a.key === "fill_signal_gaps") && sample_count < 5` 当 cold-start 兜底信号，1 行 5 分钟 —— 十四天延期的根本原因还是被误判成"需要重新设计"。

**Servlet 测试基线加固**：`/tmp/jarvis-servlet-test/src/main/java/com/example/HelloServlet.java` 07-03 手动重建后连续**五天**完好；`.jarvis/memory/{MEMORY.md, shared/tone.md}` residual 也在。仍未固化 fixture 生命周期 —— `scripts/servlet-fixture-reset.sh` 07-05/07-06 已提，未做。
