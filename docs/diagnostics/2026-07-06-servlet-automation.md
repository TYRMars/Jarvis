# Jarvis 项目自动化能力诊断报告（2026-07-06 十三次复测）

- **运行时间**：2026-07-06（scheduled task 自动跑）
- **被测分支**：`feat/mobile-ios-ddns`（HEAD 仍为 `64d288a`，与 06-23 → 07-05 同一 commit — **静默第 13 天**；工作树侧 39 个未 commit 文件与 07-04 / 07-05 完全一致，未 +/−）
- **被测项目**：`/tmp/jarvis-servlet-test`
  - **07-06 差异**：`src/main/java/com/example/HelloServlet.java` **连续 4 天完好**（07-03 手动重建后 07-04 / 07-05 / 07-06 无需 touch）；`.jarvis/memory/{MEMORY.md, shared/}` 目录树 07-03 memory probe 留下的 residual 也还在；本轮完全免动 fixture。
- **本次目的**：
  1. **回归确认** 07-05 P0/P1/P2 累积项在 1 天间是否被修复（预期：未修，静默第 13 天）
  2. **DDNS 配置跨启动持久化**：`~/.local/share/jarvis/ddns.json` 07-05 → 07-06 是否原样存活（预期：是；07-05 回写的 `test-jarvis-07-04-aaaa/AAAA/t2` 应作为 07-06 启动的"上一状态"复现）
  3. **07-05 §7 未验证项落地**（4 条一次跑通 + 意外新落地一批）：
     - `record_type:"MX"/"NS"/"SRV"` 全谱系（含 PTR/SOA/CAA）是否也 200
     - `interval_seconds:60.5` 浮点 → 60 还是 60.5 还是 error？（float 语义 = floor 还是 round？）
     - `port:65536` 超上界是否触发同 `port must be 1..65535` 400
     - `POST /v1/ddns/upnp/test` 参数化探测（externalPort/internalPort body params 是否消费？）
     - **`GET /v1/observability/health` 在 sample=2 时的 confidence** —— 07-05 直接跳到 sample=3 miss 了这一步
  4. **cross-day fingerprint**：sample=1/3/4 三个 confidence 常数与 07-05 完全一致是第 13 天
- **运行约束**：与 07-05 一致 —— `JARVIS_WORK_MODE=off`、stub LLM key、`JARVIS_PERMISSION_MODE=bypass`；DB 用日期后缀 `-20260706` 全新路径。DDNS + memory 分支另起 `-20260706-ddns` 后缀。为跑 sample=2 中间态另起了 `-20260706-sample2` 干净 DB + 独立端口（`:7098`）。probe 结束后 DDNS `~/.local/share/jarvis/ddns.json` 已回写 07-05 备份（`test-jarvis-07-04-aaaa/AAAA/t2`）。

---

## 0. TL;DR — 与 07-05 的差异

| 项 | 07-05 状态 | 07-06 状态 | 变化 |
| --- | --- | --- | --- |
| `git log --since=2026-07-05` | 0 commit | **0 commit**（HEAD 仍 `64d288a`） | 静默**第 13 天** |
| 工作树未 commit 文件数 | 39 个 | **39 个** | 持平 |
| 522 条 `@jarvis/server` 单测 | 522/522 ✅（7677 ms） | **522/522 ✅**（7717 ms） | 持平（+40 ms 噪声） |
| Servlet 工作目录 | HelloServlet.java 完好 + `.jarvis/memory/` residual | **完全相同**（`HelloServlet.java` 连续 4 天存活，`.jarvis/memory/{MEMORY.md, shared/tone.md}` 也在） | 07-03 fixture 修复延续到第 4 天 |
| P1-A POST + PATCH 4 字段透传 | 全双向静默丢字段 | **仍全双向静默丢字段** | ❌ 未修（第 13 次） |
| P1-B `POST /v1/roadmap/import` | 404 | **404** | ❌ 未修（第 13 次） |
| P1-C `GET /v1/requirements/:id` | 404 | **404** | ❌ 未修（第 13 次） |
| Orphan 行 `POST /v1/projects/no-such/requirements` | 201 + 原样回写 + GET 拉回 | **完全复现** | ❌ 未修（第 13 次） |
| `depends_on` 跨 id FK bogus (POST) | 通过 | **完全复现** | ❌ 未修（第 9 次） |
| `depends_on` PATCH-only bogus FK (07-05 落地) | 通过 | **完全复现**（同源 bug PATCH 侧再确认） | ❌ 未修（第 2 次） |
| `depends_on` 条件性写回 | omit→undefined, []→[], real→real | **完全复现** | ❌ 未修（第 9 次） |
| `/v1/projects` 列表裸数组 | 与 `{items:[]}` 系不一致 | **完全复现**（projects=bare array, workflows=`{items}`, workspaces=`{workspaces}` 三分裂） | ❌ 未修（第 8 次） |
| `confidence < 0.2` 前端兜底 | P0，12 天未修 | **P0，13 天未修** | 持平 |
| `POST /v1/workflows` 500 泄漏 | 10 500 / 6 400 (16 shape) | **完全复现**（本轮 13 shape 探针 → 10 500 / 3 400，与 07-05 的 10 500 严格对齐；三条 500 message 逐字命中 `steps.map is not a function` / `Cannot read properties of undefined (reading 'type')` / `Cannot read properties of undefined (reading 'trim')`） | ❌ 未修（第 7 次） |
| workflow-run cancel 幂等 + `finished_at` 不刷新 | cancel #1/#2/#3 200，`finished_at` 首次锁定 | **完全复现**（cancel #1/#2/#3 均 200，`finished_at=2026-07-06T02:15:01.912Z` 三次一字不差） | 持平 |
| cancelled run wire shape 7 keys | `[error, finished_at, id, started_at, status, step_results, workflow_id]` | **完全复现** | 持平 |
| workflow-run cancel 三态（07-05 落地：bogus 404 / cancelled 200 no-op / pending 200） | 落地 | **完全复现**（`bogus_uuid` → 404 `{error:"workflow run not found"}`；pending → 200；cancelled → 200 no-op） | 持平 |
| workflow 重名 | 两次 POST 同 name 都 201 UUID 不同 | **完全复现**（`dup-name-07-06` D1 `a6d1c4dd` / D2 `71248315`） | 持平 |
| `POST /v1/projects` 显式 `slug` 3 组合 | 显式 slug 首次 201 / 相同显式 slug 409 / 相同 name 无 slug 201 | **完全复现**（`probe-slug-07-06-a` 首次 201；重复 409 `"slug 'probe-slug-07-06-a' already in use"`；相同 name 无 slug → 派生 `probe-slug-07-06` 底名不冲突不加 `-2` 后缀） | 持平 |
| sample_count=1/3/4 三 fingerprint | `0.06560095313918246 / 0.13120190627836492 / 0.15232069614525703` | **完全复现（第 13 天）** | 持平 |
| **sample_count=2 confidence**（07-05 未验证项 #6） | 未测 | **✨ 首入档：`(overall_score=47, confidence=0.10397505073716999, primary_focus=planning_execution)`** | ✅ **07-05 §7 落地：sample=2 填齐 fingerprint 空档** |
| sample_count=0 baseline `(50, 0, task_understanding)` | 有 | **完全复现** | 持平 |
| DDNS 配置持久化路径 | `~/.local/share/jarvis/ddns.json`（0600 + 明文） | **持久化跨 07-05 → 07-06 存活**：启动前该文件仍是 07-05 回写的 `test-jarvis-07-04-aaaa/AAAA/t2`；今天为跑 probe 主动 `cp` 备份 + 再回写 | ✅ 07-04 → 07-05 → 07-06 三日结论保持 |
| `ddns.status` 8 keys（configured 分支） | `[configured, enabled, hostname, lan_addrs, last_result, provider, public_ip, reachable]` | **完全复现** | 持平 |
| `ddns.status` 4 keys（`configured:false` 分支，07-05 首入档） | 落地 | 07-06 未再跑（`configured:false` 分支需要 `rm ddns.json` 二次骚扰，本轮跳过） | ✅ 07-05 已文档化，暂无需复测 |
| `GET /v1/ddns/config` at configured 7 keys | 复现 | **完全复现** | 持平 |
| `PUT /v1/ddns/config` 不带 `record_type` → `"A"` 默认 | 07-05 落地 | **完全复现** | 持平 |
| **`record_type` 全谱系透传**（07-05 未验证项 #1） | 07-05 只测 CNAME/TXT 猜"任何字符串" | ⚠️ **07-06 穷举：MX/NS/SRV/PTR/SOA/CAA 全部 200 且逐字 echo passthrough**（record_type=`"MX"`→`"MX"`；record_type=`"NS"`→`"NS"`；…全部 6 记录类型透传）— DNS 记录类型 REST 层**任何字符串通过** | ✅ **07-05 §7 落地：REST 层零字符串校验，只靠 provider adapter 后端拒** |
| **`interval_seconds` 浮点语义**（07-05 未验证项 #2） | 07-05 只测 int 边界（0/-5/30/60 全 clamp 到 60；999999 无上限） | ⚠️ **07-06 首入档：float 走 `Math.floor` + min-clamp 60**：`60.5`→60、`60.9`→60、`59.5`→60、`300.7`→300、`60.1`→60 —— 是 truncation 语义（`Math.floor(v)` 再 clamp），不是 `Math.round`。跟 07-05 int min-clamp 是同一 clamp 出口 | ✅ **07-05 §7 落地：silent 双重变换（floor + min-clamp），无 API 文档** |
| **`port` 上界校验**（07-05 未验证项 #3） | 07-05 只测下界（0/-1 → 400） | ⚠️ **07-06 首入档：`port=65535` 200 / `port=65536` 400 `port must be 1..65535` / `port=100000` 同 400** —— 上下界对称校验，边界 65535 通过，超一个字节即 400，错误串一致 | ✅ **07-05 §7 落地：port 范围是 1..65535 闭区间双边硬校** |
| **`hostname` unicode / 长度**（07-06 意外新落地） | 隐含 | ⚠️ **07-06 首入档**：`"测试-中文-十三日.duckdns.org"` → 200 逐字回声（NO charset validation）；`hostname="a"*300` → 200（**NO length cap**）；`hostname=""` / hostname 缺省 → 400 `"'hostname' is required"` | ⚠️ **07-06 新落地：hostname 只校 non-empty，charset+长度全放行 → 可写入奇形怪状值** |
| **`provider` 5 枚举全覆盖**（07-06 首扩展） | 07-05 只测 `"nonexistent"` → 400 | ⚠️ **07-06 首入档 5 provider 全 200**：`cloudflare/duckdns/dyndns2/aliyun/dnspod` PUT 全 200 且原样透传；`nonexistent/bogus/null-thing` 全 400 `unknown DDNS provider "<v>"` | ✅ **07-06 全枚举扫描完成**（5 白名单 + 3 黑名单示例） |
| **`POST /v1/ddns/upnp/test` body-参数化**（07-05 未验证项 #5） | 07-05 只测 no-body 一次 | ⚠️ **07-06 首入档：body param 全被吞** —— `externalPort:9000` in body → 响应仍 `externalPort:7099`（服务端读的是 config port 而非 body）；`internalPort:7099` 同吞；`externalPort:"nine-thousand"`（bad type）**也不 400** 而是 200 no-op 走 config port —— 端点是 **no-parameter endpoint**，body 全被静默忽略 | ⚠️ **07-06 新落地：undocumented "body accepted but ignored"** |
| `POST /v1/ddns/update` 返 status shape 而非 `{ok}` | 是 | 07-06 未再测（07-05 已文档化） | 持平 |
| `DELETE /v1/ddns/config` 4-way body-parser split | 07-05 首入档（fetch 空 CT header → 415） | **本轮 curl 走的 3-shape 复现**：no CT header → 404、json+空 body → 400、json+`{}` → 404；`content-type:` 空 value（curl 语法删除 header）→ 404，与 07-05 fetch 走的 `Content-Type:""` 空字符串走的 415 是两个不同调用路径，07-05 分裂说明成立 | ✅ 07-05 落地维持 |
| `POST /v1/ddns/upnp/test` 4 keys `{mapped, externalPort, internalPort, message}` | 复现 | **完全复现**（新落地：**body 参数完全无效**，见上一行） | 持平 |
| `GET /v1/remote/pairing` 4 keys | 复现 | **完全复现**；`pairing_links.len=3`；`origins` 今天含 `http://probe-iv:7099`（cross-feature 集成第 4 天回归 —— hostname 会被最后一次 PUT 覆盖，今天最后成功 PUT 里 hostname 是 `probe-iv`，所以 origins 反映之） | 持平 |
| `GET /v1/remote/info.external` 3 keys | 复现 | **完全复现**（`hostname/public_ip/reachable`；`public_ip=67.200.120.26` from duckdns response） | 持平 |
| `POST /v1/memory/includes` target=含 MEMORY.md 的目录 | 落地 | **完全复现**（`shared/tone.md` 400 not found；`/tmp/shared-memory-07-06` 200 4 keys） | 持平 |
| `GET /v1/memory/includes` 加过之后 items | 4 keys `{target, kind:"local_path", resolves, path}` | **完全复现** | 持平 |
| `DELETE /v1/memory/includes` 幂等 | 07-04 首落地 200 no-op | **完全复现 + 07-05 落地的 "对从未加过的 target 也 200 no-op"** —— DELETE `/tmp/never-added-07-06` 也 3 keys 200 | 持平 |
| `POST /v1/memory/includes/refresh` local_path 400 | 落地 | **完全复现**（`"refresh only applies to git+ includes"`） | 持平 |
| `GET /v1/memory/includes?scope=user` | 落地 | **完全复现**（user-scope MEMORY.md 路径来自 `JARVIS_MEMORY_USER_ROOT`） | 持平 |
| backend=none `sync_setup / sync` 503 | 复现 | **完全复现** | 持平 |
| `server/info` 反映 DDNS/memory feature 开关状态 | 不反映（16 顶层 keys） | **仍不反映**（**17 顶层 keys**——比 07-05 多 1；full: `[approval_mode, coding_mode, config_path, listen_addr, max_iterations, mcp_servers, memory, persistence, project_context, project_store, providers, system_prompt, tool_count, tools, version, workspace_root]` **16 keys**——**07-05 报"16 顶层 keys"其实是错的，07-06 逐字数确认还是 16 keys**（07-05 差 1 打字错）；本轮内容与 07-05 一致，无 `ddns`/`memory_enabled`/`mdns` 字段） | ❌ 未修（第 5 次） |
| `/v1/health` 404 | 未修 | **未修** | ❌ 未修（第 5 次） |
| `no_op:true` 首次 approve 已批 | 复现 | **完全复现** | 持平 |
| `POST /v1/requirements/:id/reject` orphan 200 | 07-06 未再测 | — | — |
| trim-aware instructions 校验 | 复现 | **复现**（`instructions:""` → 400 `instructions must not be empty`；今 slug 3 组合 §3.7b B 组包含 empty-string 触发） | 持平 |

代码侧三个 deferred / 缺陷标记的精确行号仍在原位（今天 grep 三次确认）：
- `packages/server/src/requirements-routes.ts:164-165` 的 `"verification_plan / workflow_id three-state semantics are part of the full Rust handler but out of scope for this port"` 3 行注释。
- `packages/tools/src/register-builtins.ts:13` "未移植清单" 注释含 `"roadmap.import"`；`:166` `"(not yet ported)"`。
- `packages/server/src/workflow-routes.ts:156` 的 `normalizeSteps(body.steps ?? [])` —— 今天 13 shape 探针 10 种 500 泄漏全复现；`:90` `normalizeSteps` 头处（`:95`/:97`/:99` 递归到 pipeline/phase/parallel 也复用）。

---

## 1. 测试配置（分三次起）

### 主分支（§2 / §3 / §4.1-4.4）

```
OPENAI_API_KEY=sk-stub-for-automation-test
JARVIS_PROVIDER=openai
JARVIS_MODEL=gpt-4o-mini
JARVIS_FS_ROOT=/tmp/jarvis-servlet-test
JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-20260706
JARVIS_ADDR=127.0.0.1:7099
JARVIS_WORK_MODE=off
JARVIS_PERMISSION_MODE=bypass
JARVIS_NO_PROJECT_CONTEXT=1
```

启动日志：
```
[jarvis] persistence connected: json:///tmp/jarvis-servlet-test-db-20260706
[jarvis] serve: provider=openai model=gpt-4o-mini addr=127.0.0.1:7099 fsRoot=/tmp/jarvis-servlet-test coding=false auth=none ddns=off mdns=off promptBytes=263
[jarvis] listening on http://127.0.0.1:7099
```

### Sample=2 分支（§4.3b 中间态）

主分支所有变量 + 端口/DB 后缀：`JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-20260706-sample2` `JARVIS_ADDR=127.0.0.1:7098`。用途：一个从零开始的干净 DB，让 sample_count 一步一步从 0 → 1 → 2 → 3 递增，独立于主分支。

### DDNS + Memory 分支（§4.5 / §4.6）

```
# 主分支所有变量 +
JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-20260706-ddns
JARVIS_DDNS_ENABLE=1
JARVIS_ENABLE_MEMORY=1
JARVIS_MEMORY_USER_ROOT=/tmp/jarvis-mem-07-06
```

启动日志（DDNS 分支）：
```
[jarvis] persistence connected: json:///tmp/jarvis-servlet-test-db-20260706-ddns
[jarvis] serve: provider=openai model=gpt-4o-mini addr=127.0.0.1:7099 fsRoot=/tmp/jarvis-servlet-test coding=false auth=none ddns=on mdns=off promptBytes=263
[jarvis] listening on http://127.0.0.1:7099
[ddns] duckdns rejected the update (response: "KO") — check the token/subdomain
```

`[ddns] duckdns rejected the update` 一行即刻验证 `~/.local/share/jarvis/ddns.json` 从 07-05 存活到 07-06 —— 07-05 回写的假 `token:"t2"` 让 duckdns update 一 boot 就 `"KO"`，与预期完全一致。

---

## 2. 6 步 Kanban 主线（stub 模式）

```
1) POST /v1/projects  {name:"servlet-2026-07-06",instructions:"..."}
   → 201 project_id=9cde50b9…；slug 自动 "servlet-2026-07-06"（07-06 底 slug 首次可用，不需要 -2 后缀）
2) POST /v1/projects/<pid>/requirements ×6
   [hello wire, echo POST, maven pom, servlet review, smoke test, test blocked-by]
   全 201，全 triage_state=approved（body 传 approved）
3) GET /v1/projects/<pid>/requirements → items:6 全 backlog
4a) PATCH hello → in_progress               ✅ (200 8 keys)
4b) PATCH echo → review                     ✅ (200 8 keys)
4c) PATCH maven → done                      ✅ (200)  ← **stub 模式手动 PATCH 到 done 是允许的（07-05 已记）；auto-loop 拦截未测**
4d) POST /v1/requirements/<r>/complete      ✗ **本轮误用**：REST 侧无 /complete 路由；实际 grep requirements-routes.ts 只有 [patch, delete, /approve, /reject, /runs, /review, /activities, /todos, /conversations]
    → 404 route not found；kanban → Done 只能 PATCH status:done 或 subagent.review 侧走
4e) POST /v1/requirements/<smoke>/approve   ✅ (200 {no_op:true, approved:true} 因 default triage_state 已 approved)
    POST /v1/requirements/<smoke>/start     ✗ **本轮误用**：无 /start 路由；kanban 只有 PATCH status
4f) POST /v1/requirements/<test-blocked>/block ✗ **本轮误用**：无 /block 路由；agent 侧走 requirement.block **工具**（tools），REST 侧没入口
5) 最终 list：maven=done / echo=review / hello=in_progress / 其余 3 = backlog
```

**07-06 首入档**：`/start`、`/block`、`/complete` **都不是 REST 路由**（`grep '\.post("/v1/requirements' packages/server/src/requirements-routes.ts` 只见 `/approve` `/reject` `/review` `/runs` `/todos` `/conversations`）。它们只是 `harness-tools/src/requirement.ts` 里的 agent 侧 tools（`requirement.start` / `requirement.block` / `requirement.complete`）。REST 侧要在 kanban 上做状态转换只能通过 `PATCH /v1/requirements/:id status:"..."` 或 `POST .../approve/reject/review`。CLAUDE.md 的 tools 清单里列了这些 tool，但 REST route 清单没明说这 3 个 tool 无对应 REST，容易走错。

---

## 3. 回归探针（P1 gaps 未修复第 13 次）

### §3.1 P1-A：POST 上 4 字段静默丢

```
BODY = {"title":"probe-4fields","description":"t","triage_state":"approved",
        "acceptance_policy":"Human",
        "workflow_id":"11111111-1111-1111-1111-111111111111",
        "assignee_id":"user-x",
        "verification_plan":{"steps":[{"kind":"assert","args":{"x":1}}]}}
→ 201 8 keys [conversation_ids, created_at, description, id, project_id, status, title, updated_at]
   has acceptance_policy = false
   has workflow_id = false
   has assignee_id = false
   has verification_plan = false
```

### §3.2 PATCH 上同 4 字段静默丢

```
PATCH /v1/requirements/<newid>  {acceptance_policy:"Human", workflow_id:"...", assignee_id:"...", verification_plan:{steps:[]}}
→ 200 同样 8 keys；response 里 acceptance_policy=undefined workflow_id=undefined
```

### §3.3 P1-B：`POST /v1/roadmap/import` 依然 404

```
POST /v1/roadmap/import  {} → 404 "Route POST:/v1/roadmap/import not found"
```

### §3.4 P1-C：`GET /v1/requirements/:id` 依然 404

```
GET /v1/requirements/8857c965-551d-4672-9209-bbe38e372f27 → 404 "Route GET:... not found"
```

### §3.5 orphan project_id 依然被静默接受

```
POST /v1/projects/no-such-proj-07-06/requirements {...} → 201
   response.project_id = "no-such-proj-07-06"（原样落盘）
```

### §3.6 `depends_on` 跨 id FK 依然不校验

```
POST /v1/projects/<pid>/requirements {depends_on:["00000000-0000-0000-0000-000000000000"]}
→ 201 depends_on:["00000000-0000-0000-0000-000000000000"]  （原样写盘，从不校验存在性）
```

### §3.6b **PATCH-only-depends_on FK 缺陷（07-05 落地 07-06 再确认）**

```
new_row = POST /v1/projects/<pid>/requirements {title:"patch-dep-probe"}  # 无 depends_on
→ new_row 8 keys [conversation_ids, created_at, description, id, project_id, status, title, updated_at]

PATCH /v1/requirements/<new_row.id> {depends_on:["99999999-9999-9999-9999-999999999999"]}
→ 200 **9 keys**：多了 depends_on；bogus UUID 逐字写盘（**与 §3.6 POST 侧同源 FK bug，同一 store.write，无中心 validator**）
```

### §3.7 `POST /v1/workflows` 500 泄漏（13-shape 探针）

| body | status | 07-05 期望 | 07-06 实测 |
| --- | --- | --- | --- |
| `{name:"wf-1",steps:42}` | 500 | 500 `steps.map is not a function` | ✅ `500 "steps.map is not a function"` |
| `{name:"wf-2",steps:true}` | 500 | 500 | ✅ 500 |
| `{name:"wf-3",steps:"x"}` | 500 | 500 | ✅ 500 |
| `{name:"wf-4",steps:{}}` | 500 | 500 | ✅ 500 |
| `{name:"wf-5",steps:[42]}` | 500 | 500 `Cannot read properties of undefined (reading 'type')` | ✅ `500 "Cannot read properties of undefined (reading 'type')"` |
| `{name:"wf-6",steps:[null]}` | 500 | 500 `... reading 'id'` | ✅ 500 |
| `{name:"wf-7",steps:[{}]}` | 500 | 500 `... reading 'type'` | ✅ 500 |
| `{name:"wf-8",steps:[{"name":"x"}]}` | 500 | 500 `... reading 'type'` | ✅ 500 |
| `{name:"wf-9",steps:[{name,kind:{type:"bogus"}}]}` | 500 | 500 `steps is not iterable` | ✅ 500 |
| `{name:"wf-10",steps:[{name,kind:{type:"agent"}}]}` | 500 | 500 `Cannot read properties of undefined (reading 'trim')` | ✅ `500 "Cannot read properties of undefined (reading 'trim')"` |
| `{name:"wf-11",steps:[{name,kind:{type:"agent",prompt:""}}]}` | 400 | 400 `"agent step 'x' has an empty prompt"` | ✅ 400 |
| `{name:"wf-12",steps:null}` | 400 | 400 `"at least one agent step"` | ✅ 400 |
| `{name:"wf-13"}` | 400 | 400 | ✅ 400 |

**结果**：13/13 与 07-05 期望完全一致 —— 10 shape 泄漏 500 / 3 shape 400 硬校（对应 07-05 全表 16 shape 里的一个子集：07-05 还测了 `{steps:null}` `{}` `{name:""}` `body=null` `body=[]` 5 shape 都 400，本轮省略）。

### §3.7b `POST /v1/projects` slug 3 组合

```
A: {name:"probe-slug-07-06",slug:"probe-slug-07-06-a",instructions:"07-06"}
   → 201 slug="probe-slug-07-06-a" ✓
B: 相同 body A 再发一次
   → 409 {"error":"slug 'probe-slug-07-06-a' already in use"} ✓（首个显式-slug 409 路径复现第 5 次）
C: {name:"probe-slug-07-06",instructions:"07-06"}  # 无 slug
   → 201 slug="probe-slug-07-06"（**底名可用不加 -2 后缀**——07-05 已记的 "派生 slug 未被占用则不追加"）
```

### §3.7c 列表 shape 三分裂

```
GET /v1/projects   → Array? true  len=1
GET /v1/workflows  → { items:[...] }
GET /v1/workspaces → { workspaces:[...] }
```

三种不同 shape，无迁移路径。

---

## 4. 加深探针（今日专项）

### §4.1 `workflow-runs/:id/cancel` 三态（07-05 落地再确认 + finished_at 三次不变）

```
POST /v1/workflows {name:"cancel-freshness-07-06", steps:[{name:"a",kind:{type:"agent",prompt:"x"}}]} → 201 wf=8e988e2b…

POST /v1/workflows/<wf>/run  {}
   → 202 { id:<run>, workflow_id:<wf>, status:"pending", step_results:[], started_at:... }

POST /v1/workflow-runs/<run>/cancel  {}       # #1 pending → cancel
   → 200 { id, workflow_id, status:"cancelled", step_results:[],
           started_at, error:"run cancelled by operator",
           finished_at:"2026-07-06T02:15:01.912Z" }   ← 首次锁定

sleep 1;
POST /v1/workflow-runs/<run>/cancel  {}       # #2 cancelled → cancel (no-op)
   → 200 finished_at:"2026-07-06T02:15:01.912Z"      ← **不刷新** ✓

sleep 1;
POST /v1/workflow-runs/<run>/cancel  {}       # #3 又一次
   → 200 finished_at:"2026-07-06T02:15:01.912Z"      ← 三次一字不差 ✓

POST /v1/workflow-runs/11111111-2222-3333-4444-555555555555/cancel {}
   → 404 {"error":"workflow run not found"}   ← select-then-cancel 三态第 2 天复现 ✓

GET /v1/workflow-runs/<run>  → 7 keys [error, finished_at, id, started_at, status, step_results, workflow_id]
```

### §4.2 workflow 重名允许

```
POST /v1/workflows {name:"dup-name-07-06", steps:[{name,kind:{type:"agent",prompt:"x"}}]} × 2
   → 201 D1 id=a6d1c4dd / 201 D2 id=71248315   ← 两次都 201，UUID 不同
```

Workflow 侧 slug/name 无唯一约束。对比 projects 侧显式 slug 409：**语义不一致**（客户端必须 key by `id`）。

### §4.3 harness.health 全 fingerprint 5 采样（**07-05 §7 未验证项 #6 落地**）

主分支已跑 3 requirement runs 到 sample=3；再多打 1 个 run 得 sample=4；sample=2 用另起的 **干净 DB + 独立端口** 分支从 0 逐步递增：

| sample_count | overall_score | confidence | primary_focus | dim.confidence (task_understanding / planning_execution / capability_invocation / task_delivery) |
| --- | --- | --- | --- | --- |
| 0 (fresh boot) | 50 | 0 | task_understanding | — |
| 1 | 47 | **0.06560095313918246** | planning_execution | ✅ 07-05 复现 |
| **2** | **47** | ⚡**0.10397505073716999** | planning_execution | task_understanding=**0.06398464660748923** / planning_execution=**0.17595777817059538** / capability_invocation=**0.031992323303744616** / task_delivery=**0.14396545486685075** |
| 3 | 47 | **0.13120190627836492** | planning_execution | ✅ 07-05 复现 |
| 4 | 47 | **0.15232069614525703** | planning_execution | ✅ 07-05 复现 |

**公式再验证**（`confidence = ln(sample+1)/ln(31) × coverage`）：
- sample=2 → `ln(3)/ln(31) = 1.0986123.../3.4339872... = 0.3199232330374462`
- coverage = `0.10397505073716999 / 0.3199232330374462 = 0.32500000000000007` ≈ 0.325（与 memory 里 coverage 常数一致 ✓）

**算法稳定第 13 天**：sample=0/1/2/3/4 五格 fingerprint 从今天起全填齐；`sample_count → confidence` 完整映射可用作 regression smoke。

### §4.3b harness.health wire shape 再校准

```
top-level 12 keys = [actions, confidence, dimensions, evidence, generated_at,
                     overall_score, primary_focus, rules, sample_count, signals, sources, tool]
dimensions.count = 4；dim[*].keys = [confidence, drivers, key, label, score, summary]
dim.labels = ["Task understanding","Planning execution","Capability invocation","Task delivery"] （英文）
actions.count = 5；action.keys = [key, metric, next_steps, priority, title, tone, why]
actions = [
   stabilize_delivery_gate           priority=1 tone=danger
   reduce_timeout_and_iteration_failures priority=2 tone=warn
   tune_tools_and_subagents          priority=3 tone=warn
   sharpen_task_acceptance           priority=4 tone=warn
   fill_signal_gaps                  priority=5 tone=neutral   ← **P0 前端要读的那个 cold-start 信号**
]
signals.count = 20；sources.count = 3；rules.keys = [confidence, dimension_weights, overall, scale]
evidence = []（空数组）
```

`rules.dimension_weights` 4 个维度公式全内嵌（`task_understanding` / `planning_execution` / `capability_invocation` / `task_delivery`，18 derived rates 组合），07-05 已完整 dump。**"P0 需前端读 `actions.find(a=>a.key==="fill_signal_gaps") && sample_count < 5` 判断 cold-start" —— 07-06 sample=2 fingerprint 填齐进一步坐实：前端要判 cold-start 有明确阈值（sample_count<5 时 confidence<0.16 全部 danger 展示）。此改动依然 1 行 5 分钟，**十三天未修**。

### §4.4 `/v1/work/{overview,quality}` shape

`/v1/work/overview` 15 顶层 keys = `[actor_breakdown, as_of, blocked_requirements, blocked_truncated, missing_stores, project_leaderboard, recent_failures, requirement_status_counts, run_status_counts, running_now, since, throughput_by_day, truncated, verification_pass_rate, window_days]`
- `actor_breakdown = null`（stub 模式无 LLM 驱动，无 human/system/agent 破分）
- `verification_pass_rate = null`（未跑 verification）
- `throughput_by_day.len = 8`（7 天 + 今天）

`/v1/work/quality` 6 顶层 keys = `[as_of, since, top_failing_commands, truncated, verification_pass_rate_by_day, window_days]`
- `verification_pass_rate_by_day.len = 8`（同 throughput 频率）

### §4.4b `/v1/diagnostics/runs/{recent,stuck}` 差异

```
recent → { items:[…] }   items[0].keys = [conversation_id, id, logs, requirement_id, started_at, status]  (6 keys)
stuck  → { items:[…] }   items[0].keys = [age_seconds, conversation_id, id, logs, requirement_id, started_at, status]  (7 keys)
```

差别是 `age_seconds`；两者都带 `logs`（07-05 已记）。stuck 探针要求 `age_seconds >= threshold_seconds`；今天 4 runs 全 `age_seconds ≈ 45s`，`?threshold_seconds=1` 全返回。

### §4.5 DDNS 后端专项（**07-05 §7 未验证项 #1/#2/#3/#5 一并落地**）

#### §4.5.1 `record_type` REST 层零字符串校验（07-05 未验证项 #1 深化）

07-05 已测 `CNAME/TXT` 全 200；今天穷举 6 更多类型：

| record_type PUT | STATUS | 响应 echo |
| --- | --- | --- |
| `"MX"` | 200 | `"MX"` |
| `"NS"` | 200 | `"NS"` |
| `"SRV"` | 200 | `"SRV"` |
| `"PTR"` | 200 | `"PTR"` |
| `"SOA"` | 200 | `"SOA"` |
| `"CAA"` | 200 | `"CAA"` |

**结论**：DNS 记录全谱系（A/AAAA/CNAME/TXT/MX/NS/SRV/PTR/SOA/CAA + 07-05 猜测的"任何字符串"）**全部 REST 层通过**。校验只在 `POST /v1/ddns/update` 时由 provider adapter 实施（duckdns 只支持 A/AAAA，cloudflare/dnspod 之类可能支持更多），触发时才 fail。**REST 层无 fail-fast**。

#### §4.5.2 `interval_seconds` float 语义（07-05 未验证项 #2 深化）

| interval_seconds | STATUS | 响应 echo | 推断 |
| --- | --- | --- | --- |
| `60.5` | 200 | 60 | `Math.floor(60.5) = 60`，`< 60?` no → 60 |
| `60.9` | 200 | 60 | `Math.floor(60.9) = 60`，`< 60?` no → 60 |
| `59.5` | 200 | 60 | `Math.floor(59.5) = 59`，`< 60?` yes → clamp to 60 |
| `300.7` | 200 | 300 | `Math.floor(300.7) = 300` |
| `60.1` | 200 | 60 | `Math.floor(60.1) = 60` |
| `60.0000001` | 200 | 60 | `Math.floor(60.0000001) = 60` |

**结论**：float 输入走 `Math.floor` **truncation**（不是 round），再走 07-05 记的 min-clamp 60。300.7 → 300 是决定性证据（`Math.round(300.7) = 301`）。**silent 双重变换（floor + clamp）无 API 文档**，客户端 UI 传浮点会看到"我传 60.9 为什么落 60"。

#### §4.5.3 `port` 上下界对称硬校（07-05 未验证项 #3 深化）

| port | STATUS | error |
| --- | --- | --- |
| `65535` | 200 | — |
| `65536` | 400 | `"port must be 1..65535"` |
| `100000` | 400 | `"port must be 1..65535"` |
| `1` | 200 | — |
| `0` | 400 | `"port must be 1..65535"` |
| `-1` | 400 | `"port must be 1..65535"` |

**结论**：范围是 `[1, 65535]` **双边闭区间硬校**，错误串两侧一致。**唯一在 DDNS 侧行为一致的字段。**

#### §4.5.4 `provider` 5 枚举全扫描

| provider PUT | STATUS | body |
| --- | --- | --- |
| `"cloudflare"` | 200 | `provider:"cloudflare"` |
| `"duckdns"` | 200 | `provider:"duckdns"` |
| `"dyndns2"` | 200 | `provider:"dyndns2"` |
| `"aliyun"` | 200 | `provider:"aliyun"` |
| `"dnspod"` | 200 | `provider:"dnspod"` |
| `"nonexistent"` | 400 | `"unknown DDNS provider \"nonexistent\""` |
| `"bogus"` | 400 | `"unknown DDNS provider \"bogus\""` |
| `"null-thing"` | 400 | `"unknown DDNS provider \"null-thing\""` |

**结论**：5 provider 白名单硬校准；黑名单错误串 `"unknown DDNS provider \"<v>\""`。**与 `record_type` 零校验对比是**同一 PUT handler 里的**校验口径不一致**（provider 硬校、record_type 零校）。

#### §4.5.5 `hostname` 只校 non-empty（07-06 新落地）

| hostname PUT | STATUS | 备注 |
| --- | --- | --- |
| `""` | 400 | `"'hostname' is required"` |
| omitted | 400 | 同上 |
| `"测试-中文-十三日.duckdns.org"` | 200 | 逐字回声，**无 charset validation** |
| `"a"×300`（300 字符） | 200 | **无 length cap** |

**结论**：hostname 校验只有 non-empty。**Unicode 主机名 REST 通过但 DNS 层几乎必 fail**（IDN 需 punycode 转换）；**300 字符名 REST 通过但 DNS 层规范 253 字符上限**。**REST 层默认服务端信任客户端已做校验**——UI 侧要重复 DNS 名规范校准。

#### §4.5.6 `POST /v1/ddns/upnp/test` body 参数全被吞（**07-05 未验证项 #5 首入档**）

| POST body | STATUS | 响应 externalPort / internalPort |
| --- | --- | --- |
| `{}` | 200 | 7099 / 7099 |
| `{externalPort:9000}` | 200 | **7099 / 7099**（body 里的 9000 完全被吞） |
| `{internalPort:7099}` | 200 | 7099 / 7099 |
| `{externalPort:9000, internalPort:7099}` | 200 | 7099 / 7099 |
| `{externalPort:"nine-thousand"}`（bad type） | 200 | 7099 / 7099（bad type 不 400，直接吞） |

**结论**：`POST /v1/ddns/upnp/test` 是 **no-parameter endpoint**——body 完全被静默忽略；响应里的 `externalPort`/`internalPort` 全部读自 DDNS config port，与 body 无关。**client 无法参数化 UPnP 测试**（想测 8080 → 9000 mapping 只能改 config port 后 test）。**API 文档全缺**。响应 4 keys `[mapped, externalPort, internalPort, message]` 与 07-05 一致；`message:"no UPnP gateway found on the LAN — forward the port manually on your router"` 因本机无 UPnP router 一直如此。

#### §4.5.7 `DELETE /v1/ddns/config` 3-way split via curl（07-05 fetch 侧 4-way 的 curl 补集）

| DELETE request | STATUS | 说明 |
| --- | --- | --- |
| 无 `content-type` header（curl 默认） | 404 `"Route DELETE:/v1/ddns/config not found"` | Fastify route 未注册，真相 |
| `content-type: application/json` + empty body | 400 `FST_ERR_CTP_EMPTY_JSON_BODY` | Fastify body-parser 抢先 |
| `content-type: application/json` + `{}` body | 404 route not found | body-parser 通过后 route 未注册 |
| `content-type:`（curl 语法：删除 header） | 404 route not found | 与"无 header"一致 |

**结论**：curl 走 3 shape；07-05 用 fetch 传 `Content-Type:""` 空字符串走出 415 是 fetch 侧独有第 4 shape。综合两个 client 视角，**综合 4 shape split** 07-05 记录成立。**真相仍是 `packages/server/src/ddns-routes.ts` 没有 `app.delete("/v1/ddns/config")` 定义**。

#### §4.5.8 DDNS `~/.local/share/jarvis/ddns.json` 07-05 → 07-06 存活

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

这是 07-05 probe 结束后回写的 07-04 状态（`test-jarvis-07-04-aaaa/AAAA/t2`）。今日 boot 后 `GET /v1/ddns/status.hostname="test-jarvis-07-04-aaaa"` **一 boot 即读到**。DDNS 配置与 `JARVIS_DB_URL`（json://` prefix）**完全独立**，`~/.local/share/jarvis/ddns.json` 是磁盘唯一真源。今日已备份到 `/tmp/ddns-backup-07-06.json`，本轮 probe 结束后 `cp /tmp/ddns-backup-07-06.json ~/.local/share/jarvis/ddns.json` 回写。

### §4.6 Memory 后端（backend=none 分支复测）

```
GET /v1/memory/sync_status → 200 {backend:"none", user_root:"/tmp/jarvis-mem-07-06", workspace_root:"/tmp/jarvis-servlet-test"}
GET /v1/memory/includes?scope=workspace → 200 {scope:"workspace", memory_md:"/tmp/jarvis-servlet-test/.jarvis/memory/MEMORY.md", items:[]}
GET /v1/memory/includes?scope=user → 200 {scope:"user", memory_md:"/tmp/jarvis-mem-07-06/.jarvis/memory/MEMORY.md", items:[]}
POST /v1/memory/sync_setup {} → 503 {"error":"git sync setup only applies to the `git` backend","backend":"none"}
POST /v1/memory/sync {} → 503 {"error":"memory.sync only applies to the `git` backend — current backend is not git","backend":"none"}

# includes.add
mkdir -p /tmp/shared-memory-07-06 && echo "# tone\n- keep it terse" > /tmp/shared-memory-07-06/MEMORY.md

POST /v1/memory/includes {"target":"/tmp/shared-memory-07-06"}
   → 200 {ok:true, added:"/tmp/shared-memory-07-06", scope:"workspace", memory_md:"..."}

POST /v1/memory/includes {"target":"/tmp/shared-memory-07-06/MEMORY.md"}  # 文件而不是目录
   → 400 {"error":"include `.../MEMORY.md` has no MEMORY.md (looked at the directory itself and at .jarvis/memory/ underneath)"}

POST /v1/memory/includes {} → 400 {"error":"missing `target`"}

GET /v1/memory/includes?scope=workspace
   → items:[ {target, kind:"local_path", resolves:true, path:"/tmp/shared-memory-07-06"} ]  # 4 keys

POST /v1/memory/includes/refresh {"target":"/tmp/shared-memory-07-06"}
   → 400 {"error":"refresh only applies to git+ includes"}

DELETE /v1/memory/includes {"target":"/tmp/shared-memory-07-06"}  # #1 真删
   → 200 {ok:true, removed:"/tmp/shared-memory-07-06", scope:"workspace"}
DELETE 同 target  # #2
   → 200 {ok:true, removed:"/tmp/shared-memory-07-06", scope:"workspace"}   ← 幂等 no-op ✓
DELETE {"target":"/tmp/never-added-07-06"}  # 从未加过的 target
   → 200 {ok:true, removed:"/tmp/never-added-07-06", scope:"workspace"}   ← 07-05 的"对任何 target 200 no-op"再确认 ✓
```

**07-05 三种幂等风格再复习**（`DELETE /v1/memory/includes` **universal 200 no-op** vs `POST /v1/workflow-runs/:id/cancel` **select-then-cancel（bogus 404 / cancelled 200 no-op）** vs `POST /v1/requirements/:id/reject` bogus **404**）今日全部复现。

### §4.7 `/v1/remote/info` + `/v1/remote/pairing`

```
GET /v1/remote/info
  → {device_name:"zhangjianandeMacBook-Pro.local", lan_addrs:["192.168.1.164","198.18.0.1"],
     port:7099, external:{hostname:"probe-iv", public_ip:"67.200.120.26", reachable:null},
     requires_auth:false, version:"0.2.0"}   ← 6 顶层 keys ✓

GET /v1/remote/pairing
  → {device_name:..., token:null, origins:["http://192.168.1.164:7099","http://198.18.0.1:7099","http://probe-iv:7099"],
     pairing_links:[ 3 objects: {origin, link} ] }   ← 4 顶层 keys ✓
```

- `external.reachable=null`（duckdns 返 KO）
- `external.hostname="probe-iv"` —— 因今日 §4.5.2 最后成功 PUT 的 hostname 是 `probe-iv`；07-05 那次是 `test-jarvis-07-05-aaaa`。
- `token=null`（未设 `JARVIS_ACCESS_TOKEN`）
- `pairing_links[*].link` 是 `jarvis://pair?origin=<enc>&name=<enc>` scheme URL；`origins` 含 DDNS hostname —— **cross-feature 集成第 4 天回归**。

### §4.8 各"feature off" 503 pattern

```
/v1/agent-profiles          → 503
/v1/memories                → 503
/v1/learning/skill-usage    → 503
/v1/automations             → 503
/v1/channels                → 503
/v1/plugins                 → 503
/v1/diagnostics/worktrees/orphans → 503
/v1/diagnostics/memory      → **200** {backend:"unknown", stats_available:false}  ← 唯一 200+flag
/v1/skills                  → 503 {"error":"skill catalogue not configured"}
```

Feature-off 8 route 里 **7 走 503**，**1 走 200+flag**（`/v1/diagnostics/memory`）；**inconsistency 持平**。

### §4.9 `/v1/health` vs `/health`

```
GET /health    → 200 {status:"ok"}
GET /v1/health → 404 "Route GET:/v1/health not found"
```

07-05 已记；未修第 5 次。

---

## 5. 07-06 首次发现清单

1. **`/start` / `/block` / `/complete` REST 路由不存在**（§2 补入档）—— `POST /v1/requirements/:id/{start,block,complete}` 都 404 route not found；`packages/server/src/requirements-routes.ts` 只有 `[PATCH, DELETE /:id, POST /:id/approve, /reject, /review, /runs, /activities, /todos, /conversations]`。这 3 个只是 `harness-tools/src/requirement.ts` 里的 **agent-侧 tools**。CLAUDE.md 的 tools 部分列了它们，但 REST route 清单没把它们排除，容易走错（本轮就走错了）。**修法**：CLAUDE.md 明写 "agent tool，非 REST"。
2. **`record_type` 全谱系 6 类透传**（07-05 未验证项 #1 深化）：MX/NS/SRV/PTR/SOA/CAA 全 200 且逐字 echo passthrough。REST 层对 DNS 记录类型**零字符串校验**。
3. **`interval_seconds` 浮点 = `Math.floor(v)` + min-clamp 60**（07-05 未验证项 #2 首入档）：`60.5→60`、`60.9→60`、`300.7→300`（决定性证据）。**silent 双重变换**，无 API 文档。
4. **`port` 上下界双边硬校 `[1, 65535]`**（07-05 未验证项 #3 首入档）：`65536 → 400 "port must be 1..65535"`，与下界 error string 一致；`65535` 边界值通过。
5. **`hostname` 只校 non-empty**（07-06 意外新落地）：Unicode 中文名 200，300 字符长名 200。**REST 层默认信任客户端 DNS 规范校验**。UI 需自查。
6. **`POST /v1/ddns/upnp/test` body 全被吞**（07-05 未验证项 #5 首入档）：`externalPort:9000` in body → 响应 `externalPort:7099`（server 读 config port）；bad type 也不 400。**no-parameter endpoint**；文档全缺。
7. **`provider` 5 白名单全扫描 + 3 黑名单示例**（07-06 补齐）：`cloudflare/duckdns/dyndns2/aliyun/dnspod` 全 200；未知 → 400 `unknown DDNS provider "<v>"`。
8. **✨ `sample_count=2` fingerprint 首入档**（07-05 未验证项 #6 落地）：`(overall_score=47, confidence=0.10397505073716999, primary_focus=planning_execution)`。sample=0/1/2/3/4 五格 fingerprint 现在全填齐，`confidence = ln(sample+1)/ln(31) × 0.325` 公式过 sample=2 再确认。
9. **`server/info` 17 keys → 16 keys 校准**（07-05 数错 1）：full list `[approval_mode, coding_mode, config_path, listen_addr, max_iterations, mcp_servers, memory, persistence, project_context, project_store, providers, system_prompt, tool_count, tools, version, workspace_root]` **16 keys**。仍不含 `ddns` / `memory_enabled` / `mdns`。

## 6. 未修复清单（P0/P1/P2 累积）

**P0**（前端 1 行 5 分钟）：
- confidence < 0.2 前端兜底（读 `actions.find(a=>a.key==="fill_signal_gaps") && sample_count<5`）— **13 天未修**。**07-06 sample=2 fingerprint 填齐使阈值更清晰**：sample<5 时 confidence 全 <0.16，全部按 danger 展示，UI 交互冲击最大。

**P1**（REST 层缺 route / FK / 字段透传）：
- POST + PATCH 4 字段（`acceptance_policy` / `workflow_id` / `assignee_id` / `verification_plan`）静默丢 — 13 天未修
- `POST /v1/roadmap/import` 404 — 13 天未修
- `GET /v1/requirements/:id` 404 — 13 天未修
- orphan project_id 无 FK — 13 天未修
- `depends_on` 跨 id FK POST 侧无校验 — 9 天未修（同源 bug PATCH 侧 2 天未修）
- `POST /v1/workflows` 500 泄漏 10 shape — 7 天未修（`workflow-routes.ts:156` 单点 + 5 内 guard 处 = 6 处 type guard）
- `DELETE /v1/ddns/config` 未注册 route — 5 天未修

**P2**（一致性 / 语义 / 文档缺）：
- `/v1/projects` 列表裸数组，与 `{items}/{workspaces}` 三分裂 — 8 天未修
- `/v1/health` 404，`/health` 200 — 5 天未修
- `server/info` 不反映 `ddns/memory_enabled/mdns` — 5 天未修
- `/v1/diagnostics/memory` 200+flag vs 其余 feature-off 503 — 长期
- `depends_on` 条件性写回 shape drift — 9 天未修
- **07-06 新加**：DDNS PUT 3 处 soft-accept（`record_type` 零校验、`interval_seconds` silent floor+clamp、`credentials={}` 空对象接受）
- **07-06 新加**：`hostname` 只校 non-empty（Unicode + 300 字符全通过）
- **07-06 新加**：`POST /v1/ddns/upnp/test` body 静默无效（no-parameter endpoint）
- **07-06 新加**：`/start` `/block` `/complete` 是 agent tools 而非 REST，CLAUDE.md 未明写

---

## 7. 复现 commands 一键版

```bash
# 主分支（§2/§3/§4.1-4.4）
export OPENAI_API_KEY=sk-stub-for-automation-test
export JARVIS_PROVIDER=openai JARVIS_MODEL=gpt-4o-mini
export JARVIS_FS_ROOT=/tmp/jarvis-servlet-test
export JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-<YYYYMMDD>
export JARVIS_ADDR=127.0.0.1:7099
export JARVIS_WORK_MODE=off JARVIS_PERMISSION_MODE=bypass JARVIS_NO_PROJECT_CONTEXT=1
node --experimental-strip-types packages/jarvis-app/src/main.ts serve &
# Sample=2 干净 DB（§4.3b）
export JARVIS_ADDR=127.0.0.1:7098
export JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-<YYYYMMDD>-sample2
node --experimental-strip-types packages/jarvis-app/src/main.ts serve &
# DDNS + Memory 分支（§4.5/§4.6）
export JARVIS_DDNS_ENABLE=1 JARVIS_ENABLE_MEMORY=1
export JARVIS_MEMORY_USER_ROOT=/tmp/jarvis-mem-<YYYYMMDD>
export JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-<YYYYMMDD>-ddns
node --experimental-strip-types packages/jarvis-app/src/main.ts serve &

# 若要跑真 LLM 端到端
export OPENAI_API_KEY=<真 key> JARVIS_ENABLE_FS_WRITE=1 JARVIS_ENABLE_FS_EDIT=1 JARVIS_ENABLE_SHELL_EXEC=1
export JARVIS_WORK_MODE=auto JARVIS_WORK_TICK_SECONDS=10 JARVIS_WORK_MAX_CONCURRENT=1
# 07-02+ DDNS 后端复测
export JARVIS_DDNS_PROVIDER=duckdns JARVIS_DDNS_HOSTNAME=<真 duckdns 子域> \
       JARVIS_DDNS_CREDENTIALS='{"token":"<真 duckdns token>"}'
# 07-03 memory git 后端复测
export JARVIS_MEMORY_SYNC_BACKEND=git
# 07-03 access-token + pairing 复测
export JARVIS_ACCESS_TOKEN=<32B random>
```

未验证项（继续滚到下一次）：

- **仍留白**（06-30 → 07-06 累积）：subagent.review 真 flip、triage.scan_candidates 建 ProposedByScan、project.checks 识别 Maven 缺 pom.xml、bogus project_id 之后 agent 侧 requirement.list 是否拿回、step_results[*] shape 在有 LLM key 时、`POST /v1/workflow-runs/:succeeded_run/cancel` 是否 200 no-op（目前只测 cancelled → cancel 200，pending → cancel 200，bogus → 404）
- **07-03 → 07-06 累积新留白**：
  - `JARVIS_MEMORY_SYNC_BACKEND=git` 起飞后 `POST /v1/memory/sync_setup` / `sync` 的 happy-path shape
  - `POST /v1/memory/includes body={target:"git+https://..."}` happy path shape + `kind:"git"` include shape + `refresh` on `kind:"git"` happy path
  - `JARVIS_ACCESS_TOKEN=<token>` 起飞后 `GET /v1/remote/pairing` 的 `token` 字段 + `pairing_links[*].link` 是否带 `?token=<val>`
  - `POST /v1/ddns/upnp/test` 在真有 UPnP gateway 网络下的 shape（今天 message 是 "no UPnP gateway found"）
- **07-06 新留白**：
  - `PATCH /v1/requirements/:id status:"done"` 在 depends_on 未完成时是否被 auto-loop 拦截（今天 stub 模式手动 PATCH 是允许的，`patch-dep-probe` 里 `depends_on:["99999999-..."]` 也不阻塞 `POST /runs`；不知道有 auto-loop tick 时是否会把它挪回 backlog）
  - `POST /v1/ddns/update` 在假 `record_type:"MX"/"NS"/"SRV"` 时的 provider adapter 拒绝路径 —— REST 层通过后 provider adapter 会说什么？测试 provider adapter fail-fast 语义
  - `GET /v1/ddns/config` at `configured:false` 分支的 wire shape 07-05 已入档；07-06 未再复现（要 `rm ~/.local/share/jarvis/ddns.json`）
  - **07-06 新增**：hostname 300 字符 → provider adapter 是否 fail？REST 通过后 update 时才 fail 的具体错误串？
  - **07-06 新增**：`server/info.mcp_servers` shape（当有 MCP 时）
  - **07-06 新增**：`POST /v1/requirements/:id/review` 手动 dispatch（07-05 也未测）
  - **07-06 新增**：cross-project `depends_on`（一个 project 的 requirement 依赖另一 project 的 requirement id）—— auto-loop 是否会认为"依赖存在但状态未知"永远 pending？

---

## 8. 总览

| 项 | 评分 | 与 07-05 比 |
| --- | --- | --- |
| Kanban (Project + Requirement CRUD + 状态转换 + Activity) | ✅ 健康 | 持平 |
| Workflow CRUD + dispatch + cancel（bogus 404 / cancelled 200 no-op / `finished_at` 不刷新） | ✅ 健康（除 §3.7 的 10 种 500 泄漏） | 持平 |
| Diagnostics (`/v1/diagnostics/*` + `/v1/work/*`) | ✅ 健康 | 持平 |
| Harness.health 算法实装 | ✅ 稳定第 13 天 —— **5 fingerprint（sample=0/1/2/3/4）全填齐** | **07-06 sample=2 补齐** |
| Harness.health 信号采集 | ⚠️ 缺 LLM 驱动时无信号；`actor_breakdown` / `verification_pass_rate` 顶层 null | 持平 |
| Harness.health 前端表达 | ❌ confidence 低分仍直接展示 score | **13 天未修** |
| DDNS 后端 | ✅ 健康 + `status`/`config` 双分支 wire shape + PUT 5 校验矩阵（provider ✓白5黑3 / record_type ✗全谱系 / interval float floor+clamp / port 双边 [1,65535] 硬校 / hostname non-empty 唯一 / credentials {} 接受）+ `upnp/test` body 全吞 + `DELETE` 4-shape 综合 | **07-06 挖到底** |
| Memory 后端（backend=none） | ✅ 健康 + include target 语义 + scope=user + kind=local_path/git 枚举 + DELETE/refresh + DELETE 幂等 universal 200 no-op | 持平 |
| REST ↔ 数据模型一致性 | ❌ 4 字段 POST+PATCH 丢；project_id 无 FK；depends_on 跨 id 无 FK（POST + PATCH 同源）；无 `GET /v1/requirements/:id`；depends_on 条件性写回；list shape 三分裂 | 持平 |
| 文档 ↔ 运行时一致性 | ⚠️ roadmap.import 文档 ✅ 但 404；`server/info` 不反映 DDNS/memory；`POST /v1/memory/includes` body target 语义未文档化；`/v1/health` 404；DELETE 无 body 时 fastify 400/415（真相 = 无 route）；`upnp/test` + `remote/pairing` + `GET /v1/ddns/config` + `/start`/`/block`/`/complete` (agent tools) 完全未 REST 侧文档化；07-05 4 条 DDNS PUT soft-accept + 07-06 3 条新扩展 | **07-06 又揭底更多缺口** |
| 单测覆盖 | ✅ 522/522 全绿，7717 ms | 持平（噪声内） |
| **真 bug**：`POST /v1/workflows` 500 泄漏 | ❌ 13 shape 探针 → 10 500 / 3 400 全复现（与 07-05 全 16 shape 表的 10 500 严格对齐） | 持平（第 7 次） |
| **真 bug**：`DELETE /v1/ddns/config` 无 handler + 4-way split | ❌ 完全复现 | 持平 |
| **真 bug**：DDNS PUT 3+2 处 soft-accept | ❌ 07-05 3 处 + 07-06 新扩 2 处（hostname/upnp/test）全复现 | **07-06 加固 2 处** |
| 自动化的端到端验证（有 LLM key） | ❌ 本次仍未执行 | 持平 |

**总体判断**：HEAD 在 06-23 → 07-06 **十三天**没动，工作树未 commit 文件持平 39，所以 07-05 的所有 P0/P1/P2 结论**原样成立**。本次实际增量价值：

1. **07-05 §7 未验证项落地 4 条**（sample=2 是 12 天来最有信号一条）：
   - **✨ `sample_count=2 → confidence=0.10397505073716999`**（前端 cold-start 阈值判断的关键数据点）
   - **`record_type` 6 更多枚举（MX/NS/SRV/PTR/SOA/CAA）全 200 echo passthrough** —— 证明"REST 层对 DNS 记录类型零字符串校验"是绝对结论
   - **`interval_seconds` float 语义 = `Math.floor` + min-clamp 60** —— 双重变换首入档
   - **`port` 上下界对称硬校 `[1, 65535]`** —— 唯一 DDNS 侧一致校验的字段
2. **07-06 意外新落地 3 条**（07-05 未预告）：
   - **`hostname` 只校 non-empty** —— Unicode + 300 字符全通过，`REST 层默认信任客户端`
   - **`POST /v1/ddns/upnp/test` body 参数全被吞** —— no-parameter endpoint，body 静默无效
   - **`/start` / `/block` / `/complete` 是 agent tools 而非 REST 路由** —— §2 走错路径首次入档
3. **fingerprint 全填齐 & 公式再验证**：sample=0/1/2/3/4 五格 fingerprint 全在案，`ln(sample+1)/ln(31) × 0.325` 公式跨采样通过；**算法稳定第 13 天**。
4. **`server/info` 顶层 keys 校准**：07-05 记 "16 顶层 keys" 实测 16 —— 07-05 数字对；07-06 无变化。
5. **cross-day 持久化 chain 第 4 天**：`~/.local/share/jarvis/ddns.json` 07-04 → 07-05 → 07-06 三跳跨日存活，probe 结束回写 07-05 状态。

**建议**：下次合 P1 修复时**同时**做：①4 字段透传 create+patch；②project_id FK + `GET /v1/requirements/:id`；③depends_on FK（**07-05 加固：修一处同时 fix POST + PATCH**）；④workflow POST 6 处类型守卫；⑤`DELETE /v1/ddns/config` 加 route（清磁盘 + credentials 归零）；⑥`server/info` 补 ddns/mdns/memory_enabled 字段；⑦一次性 codify DDNS 5 route（status 双分支 shape + config GET/PUT 7↔1 keys 双分支 + upnp/test + remote/pairing）+ memory 4 route（含 target 目录语义 + kind 枚举 + DELETE universal 200 no-op）+ workflow-run cancel 三态语义（bogus 404 / cancelled 200 no-op / pending 200）+ cancelled workflow run `finished_at` 不刷新 + slug 409 到 CLAUDE.md；⑧**07-05 新增**：DDNS PUT 三处 soft-accept 改为 hard-reject（`record_type` 枚举 + `interval_seconds < 60` 400 + `credentials` per-provider 必填 key 校验）；⑨**07-06 新增**：`hostname` 加 punycode+长度 253 校验；`POST /v1/ddns/upnp/test` body param `externalPort`/`internalPort` 生效或明确 400；CLAUDE.md 明写 `/start` `/block` `/complete` 是 agent tools 无 REST 入口。

**P0 修复（13 天）**：前端读 `actions.find(a => a.key === "fill_signal_gaps") && sample_count < 5` 当 cold-start 兜底信号，改 1 行 5 分钟 —— 十三天延期的根本原因还是被误判成"需要重新设计"。**07-06 sample=2 fingerprint 填齐后阈值更清晰**：sample<5 全部走 danger 展示，冲击最大。

**Servlet 测试基线加固**：`/tmp/jarvis-servlet-test/src/main/java/com/example/HelloServlet.java` 07-03 手动重建后 07-04/07-05/07-06 完好**四天**；`.jarvis/memory/{MEMORY.md, shared/tone.md}` residual 也在。仍未固化 fixture 生命周期 —— 建议加一个 `scripts/servlet-fixture-reset.sh` 每次跑前重置（07-05 已提，未做）。
