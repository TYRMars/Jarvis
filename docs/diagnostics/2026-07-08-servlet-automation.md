# Jarvis 项目自动化能力诊断报告（2026-07-08 十五次复测）

- **运行时间**：2026-07-08（scheduled task 自动跑）
- **被测分支**：`feat/mobile-ios-ddns`（HEAD 仍为 `64d288a`，与 06-23 → 07-07 同一 commit — **静默第 15 天**；工作树侧 39 个未 commit 文件与 07-04 / 07-05 / 07-06 / 07-07 完全一致，未 +/−）
- **被测项目**：`/tmp/jarvis-servlet-test`
  - **07-08 差异**：`src/main/java/com/example/HelloServlet.java` **连续 6 天完好**（07-03 手动重建后 07-04 / 07-05 / 07-06 / 07-07 / 07-08 无需 touch）；`.jarvis/memory/{MEMORY.md, shared/}` 目录树 07-03 memory probe 留下的 residual 也还在；本轮完全免动 fixture。
- **本次目的**：
  1. **回归确认** 07-07 P0/P1/P2 累积项在 1 天间是否被修复（预期：未修，静默第 15 天）
  2. **DDNS 配置跨启动持久化**：`~/.local/share/jarvis/ddns.json` 07-07 → 07-08 是否原样存活（预期：是；07-07 结束回写的 `test-jarvis-07-04-aaaa/AAAA/t2` 应作为 07-08 启动的"上一状态"复现）
  3. **07-07 未验证项落地**（一次跑通 6 条）：
     - `DELETE /v1/requirements/:id/todos/:todo_id`（源码未查是否存在）
     - **batch `PATCH /v1/requirements/:id/todos {ids, status}`**（07-07 未测 — 源码 :657-693 —— 特别是 mixed real+bogus 的 atomic-vs-partial 行为）
     - **Todo `evidence` field wire shape**（`{run_id, exit_code, stdout_excerpt, stderr_excerpt, artifact_url, note}` 6 optional keys 是否全 round-trip）
     - **Todo `depends_on` FK**（预期同 requirement.depends_on = 不校验）
     - **`POST /v1/requirements/:id/conversations` 上真 UUID 但不存在的 conversation** —— 07-07 只测了 `"not-a-uuid"` 字符串
     - **`GET /v1/ddns/config` @ `configured:false`**（需 `rm ~/.local/share/jarvis/ddns.json`；07-05 已推测 1 key `{configured:false}`）
     - **`JARVIS_ACCESS_TOKEN=<val>` 起飞后 `/v1/remote/pairing`**（07-07 累积留白 —— token 字段 + `pairing_links[*].link` 带 `?token=<val>`）
  4. **cross-day fingerprint**：sample=0/1/2/3/4 五个 fingerprint 与 07-07 完全一致是第 15 天
- **运行约束**：与 07-07 一致 —— `JARVIS_WORK_MODE=off`、stub LLM key、`JARVIS_PERMISSION_MODE=bypass`；DB 用日期后缀 `-20260708` 全新路径。DDNS + memory 分支另起 `-20260708-ddns` 后缀，并且**故意 rm `~/.local/share/jarvis/ddns.json` 后启动**以逼出 `configured:false` 分支。为跑 sample=2/3 中间态另起了 `-20260708-sample2` 干净 DB + 独立端口（`:7098`）。probe 结束后 DDNS `~/.local/share/jarvis/ddns.json` 已回写 07-07 备份（`test-jarvis-07-04-aaaa/AAAA/t2`）。

---

## 0. TL;DR — 与 07-07 的差异

| 项 | 07-07 状态 | 07-08 状态 | 变化 |
| --- | --- | --- | --- |
| `git log --since=2026-07-07` | 0 commit | **0 commit**（HEAD 仍 `64d288a`） | 静默**第 15 天** |
| 工作树未 commit 文件数 | 39 个 | **39 个** | 持平 |
| 522 条 `@jarvis/server` 单测 | 522/522 ✅（7625 ms） | **522/522 ✅**（7719 ms） | 持平（+94 ms 噪声） |
| Servlet 工作目录 | HelloServlet.java 完好 + `.jarvis/memory/` residual | **完全相同**（`HelloServlet.java` **连续 6 天存活**，`.jarvis/memory/{MEMORY.md, shared/}` 也在） | 07-03 fixture 修复延续到第 6 天 |
| P1-A POST + PATCH 4 字段透传 | 全双向静默丢字段 | **仍全双向静默丢字段** | ❌ 未修（第 15 次） |
| P1-B `POST /v1/roadmap/import` | 404 | **404** | ❌ 未修（第 15 次） |
| P1-C `GET /v1/requirements/:id` | 404 | **404** | ❌ 未修（第 15 次） |
| Orphan 行 `POST /v1/projects/no-such/requirements` | 201 + 原样回写 | **完全复现** | ❌ 未修（第 15 次） |
| `depends_on` 跨 id FK bogus (POST) | 通过 | **完全复现** | ❌ 未修（第 11 次） |
| `depends_on` PATCH-only bogus FK | 通过 | **完全复现** | ❌ 未修（第 4 次） |
| `depends_on` cross-project id FK | 通过（07-07 首入档） | **完全复现** | ❌ 未修（第 2 次） |
| `depends_on` 条件性写回 | omit→undefined, []→[], real→real | **完全复现** | ❌ 未修（第 11 次） |
| `/v1/projects` 列表裸数组 vs `{items}` vs `{workspaces}` | 三分裂 | ⚠️ **07-08 首入档：其实是五分裂** —— `{items, project_id}` (projects/:pid/requirements) 与 `{items, requirement_id}` (requirements/:rid/todos, runs) 各自算一种 shape，7 条不同 list 路径共 5 种 shape | ⚠️ **07-08 深化**：不是三分裂，是五分裂 |
| `confidence < 0.2` 前端兜底 | P0，14 天未修 | **P0，15 天未修** | 持平 |
| `POST /v1/workflows` 500 泄漏 | 13 shape 探针 10 500 / 3 400 | **完全复现** | ❌ 未修（第 9 次） |
| workflow-run cancel 三态 + `finished_at` 首次锁定 | bogus 404 / cancelled 200 no-op / pending 200 | **完全复现**（cancel #1/#2/#3 均 200，`finished_at=2026-07-07T19:11:12.041Z` 三次一字不差） | 持平 |
| cancelled run wire shape 7 keys | `[error, finished_at, id, started_at, status, step_results, workflow_id]` | **完全复现** | 持平 |
| workflow 重名 | 两次 POST 同 name 都 201 UUID 不同 | **完全复现**（`dup-name-07-08` D1 `9b24190d` / D2 `9ef57120`） | 持平 |
| `POST /v1/projects` 显式 `slug` 3 组合 | 完全复现 | 未再复测（与 07-07 一致） | 持平（跳过） |
| sample_count=0/1/2/3/4 五 fingerprint | 全填齐（sample=0/1/3 常数、sample=2/4 含 4-dim 具体值） | **完全复现（第 15 天）** —— 五格 confidence 常数逐字与 07-07 一致 | 持平 |
| DDNS 配置持久化路径 | `~/.local/share/jarvis/ddns.json`（0600 + 明文） | **持久化跨 07-07 → 07-08 存活**：启动前该文件仍是 07-07 回写的 `test-jarvis-07-04-aaaa/AAAA/t2`；今天为跑 `configured:false` 分支主动 `cp` 备份 + 再回写 | ✅ 07-04 → 07-05 → 07-06 → 07-07 → 07-08 **五跳跨日**（现每日复测都能验证跨日持久性） |
| `ddns.status` 8 keys（configured 分支） | 完全复现 | **完全复现** | 持平 |
| `GET /v1/ddns/config` at configured 7 keys | 完全复现 | **完全复现** | 持平 |
| **`GET /v1/ddns/config` @ configured:false**（07-07 留白 #6） | 未测（07-05 推测 1 key） | ✨ **07-08 首入档 evidence**：**1 key `{configured:false}`** —— 07-05 推测坐实 | ✅ **07-05 推测 → 07-08 实证** |
| **`GET /v1/ddns/status` @ configured:false**（同链） | 未测 | ✨ **07-08 首入档 evidence**：**4 keys `{enabled, configured:false, lan_addrs, reachable}`** —— 掉了 configured 分支的 `provider/hostname/public_ip/last_result` | ✅ **07-05 推测 → 07-08 实证** |
| **`GET /v1/remote/info.external` 分支**（07-08 意外发现） | 只有 `{}` (07-02) 与 `{hostname, public_ip, reachable}` (configured 时) 两种 | ✨ **07-08 首入档：`external` 有 3 种 shape**：`{}`（pre-DDNS 未 enable）、`{reachable:null}`（DDNS enable 但 config 空）、`{hostname, public_ip, reachable}`（configured） | ⚠️ **07-08 加固**：external 分支 3-shape |
| **`GET /v1/remote/pairing.token` w/ `JARVIS_ACCESS_TOKEN`**（07-07 留白 #7） | 07-04 说 token:null until set；set 后未测 | ✨ **07-08 首入档 evidence**：**token = 明文 access token 值**（原样返回），`pairing_links[*].link = jarvis://pair?origin=<URL-encoded>&name=<host>&token=<明文>` | ✅ **07-04 推测 → 07-08 实证**（含安全 side-effect 见 §5.4） |
| `PUT /v1/ddns/config` 不带 `record_type` → `"A"` 默认 | 落地 | **完全复现** | 持平 |
| `record_type` 全谱系透传 | 10 类 (A/AAAA/CNAME/TXT/MX/NS/SRV/PTR/SOA/CAA) 全 200 echo | ✨ **07-08 扩至 16 类**：新增 `DS/DNSKEY/NAPTR/URI/SVCB/HTTPS` 全 200 echo | ⚠️ **07-08 扩展**：16 类全 accept-passthrough |
| `interval_seconds` 浮点语义 = `Math.floor(v)` + min-clamp 60 | 6 float 例证（`60.5/59.5/60.1/60.9/60.0000001/300.7/61.5/100.999`） | **完全复现 + 新增 2 例**：`200.5 → 200`、`200.999 → 200` | ✅ **07-08 加固**：非 clamp 边界的 truncation 再 2 条 |
| `port` 上下界 `[1, 65535]` 双边硬校 | 落地 | **完全复现**（`port=1` 200，`port=65535` 200，`port=65536/-1/0` 全 400） | 持平 |
| `provider` 5 白名单硬校 + 未知 → 400 `unknown DDNS provider "<v>"` | 落地 | **完全复现**（`bogus-provider` → 400） | 持平 |
| `cloudflare provider` + `credentials:{}` 空 → 200 | 07-05 只测 duckdns | ✨ **07-08 首入档**：`cloudflare` 也 200 accept `credentials:{}`；响应 `credential_keys:[]`（0 keys） | ✅ **07-08 加固**：credentials 空对象跨 provider 通吃 |
| `hostname` 只校 non-empty | Unicode + 300 字符 200 | **完全复现** | 持平 |
| `hostname` 300 char → remote/pairing 跨界渗透 | 07-07 首入档 | ✨ **07-08 加固入档具体字节数**：`external.hostname` 300 chars、`origins[ddns index]` 长度 307（`http://` + hostname，无端口）、`pairing_links[N].link` 长度 411（`jarvis://pair?origin=<URL-encoded 300>&name=<host>&token=<40 chars>`） | ⚠️ **07-08 补精确 bytes**：iOS 扫码得到 411 字节 URL |
| `POST /v1/ddns/upnp/test` body 参数全被吞 | 落地 | **完全复现**（`{externalPort:9999,foo:"bar"}` → 响应 `externalPort:7097`；`internalPort:7097`；bad type 全 200 no-op） | 持平 |
| **`POST /v1/ddns/update` w/ fake `record_type=MX` + duckdns**（07-06 留白 #2） | 未测 | ✨ **07-08 首入档 evidence**：**200 with `last_result:{ok:false, message:"missing credential(s): api_token"}`** —— duckdns adapter 先校 credentials 后校 record_type，所以 record_type 层从未 REST-adapter-vertical 拒绝；update 层报错在 credential | ✅ **07-06 留白 → 07-08 landed** |
| `DELETE /v1/ddns/config` curl 4-shape split | 落地 | 未复测（同一 fix 逻辑） | 持平（跳过） |
| `POST /v1/memory/includes` 全流程 | 落地 | **完全复现** | 持平 |
| `DELETE /v1/memory/includes` 幂等 universal 200 no-op | 落地 | **完全复现**（`/tmp/never-added-07-08` 也 200 no-op） | 持平 |
| `POST /v1/memory/includes/refresh` local_path → 400 | 落地 | **完全复现** | 持平 |
| `GET /v1/memory/includes?scope=user` | 落地 | **完全复现**（`user_root=/tmp/jarvis-mem-20260708/.jarvis/memory/MEMORY.md`） | 持平 |
| `server/info` 顶层 16 keys | 落地 | **完全复现**（`[approval_mode, coding_mode, config_path, listen_addr, max_iterations, mcp_servers, memory, persistence, project_context, project_store, providers, system_prompt, tool_count, tools, version, workspace_root]`；仍无 `ddns/memory_enabled/mdns/access_token_configured/features`） | ❌ 未修（第 7 次） |
| `/v1/health` 404 vs `/health` 200 | 未修 | **未修** | ❌ 未修（第 7 次） |
| `no_op:true` 首次 approve 已批 | 复现 | **完全复现** | 持平 |
| `POST /v1/requirements/:id/review` 4 状态 | 07-07 首入档 | 未再复测（骨架已锁） | 持平（跳过） |
| `POST /v1/requirements/:id/reject` 三态 | 07-07 首入档：无 reason / `reason:""` → 400 | ✨ **07-08 深化**：加测 `reason:"   "`（whitespace-only）也 → 400 `must not be blank`（trim-aware 不止空串，还含全空白） | ⚠️ **07-08 补 trim 边界** |
| `POST /v1/requirements/:id/conversations` REST 存在 | 07-07 首入档：POST 侧存在，conversation_id `"not-a-uuid"` 通过 | ✨ **07-08 深化**（3 个 07-07 未追）：<br>(a) **真 UUID 但不存在的 conversation** → **200 通过**（无 FK 存在性校验 —— 与 `not-a-uuid` 同族 no-check）<br>(b) **`{appended:false}` 出现在 dedup 时** —— 07-07 说"conversation_ids 累积不去重"，**这条错了**：同 conversation_id 二次 POST → `{appended:false, requirement:{...conversation_ids 不变}}`；服务端**做 dedup**<br>(c) `updated_at` 在 no-op dedup 时**不变** | ⚠️ **07-07 需要一处订正 + 补 no-FK 落地 + `appended` 字段落地** |
| **全 `todos` sub-resource 五 route 全 shape**（07-07 首入档 kind/status/creator 6-6-3） | POST/GET/PATCH todos + `evidence` 6 field 与 `depends_on` FK 未测 | ✨ **07-08 首入档 evidence + 补 3 route 五 route 全覆盖**（见 §5.6）：<br>- **evidence 6 field**（`run_id/exit_code/stdout_excerpt/stderr_excerpt/artifact_url/note`）**全 round-trip 保留** —— 即便 `exit_code:0` 和 `stderr_excerpt:""` 这类 falsy 值都不 omit（**违反 `skip_serializing_if` Rust 注释语义**）<br>- **Todo depends_on 无 FK**（同 requirement.depends_on）<br>- **`DELETE /:id/todos/:todo_id` 是 universal 200 no-op** —— bogus todo_id、已删的重删、外围 RID 真但 TID 假全部 `200 {deleted:true, requirement:{...}}`（对齐 DELETE `/memory/includes`）；**唯有外围 RID 假才 404**<br>- **batch `PATCH /:id/todos {ids, status}` 是 ATOMIC**：mixed real+bogus id → 404，real ids **status 不变**（before/after `running` 快照对比坐实）；与 DELETE 的 universal 200 no-op 形成同一 API 内**两种截然不同的幂等 style**<br>- **batch PATCH 校验矩阵**：`ids:[]`/`ids 缺` 都 400 `ids must be a non-empty array`；`status` 缺 → 400 `unknown todo status \`undefined\``；`status:"done"` → 400（与 Requirement.status 完全不同）<br>- **单 Todo `PATCH /:id/todos/:tid` 支持字段**：`title/kind/status/depends_on` 全通过，wire 侧 `{todo, requirement:{...13 fields}}` 双 envelope 与 POST 侧同源 | ⚠️ **07-08 补齐全 sub-resource 深度矩阵** |
| **`RequirementStatus` 枚举 4 值**（07-08 意外发现） | CLAUDE.md 未列，07-07 也未记 | ✨ **07-08 首入档 evidence**：**enum 只 4 值 `backlog|in_progress|review|done`** —— PATCH `status:"blocked"` → **400 `unknown status \`blocked\``**。历史 6-step "Kanban" 名义上包含 blocked，但那是 agent tool + `RequirementTodoStatus`（Todo 那边独立 6 值含 blocked），**Requirement 顶层 status 无 blocked**。`block_reason` 字段仍在 requirement schema 里，是否只在 Todo 层用还是 requirement 层也可挂需要查代码 —— 至少 REST `PATCH` 不能设 requirement.status:"blocked" | ⚠️ **07-08 首落 evidence 补 CLAUDE.md 遗漏** |
| **manual `PATCH status:"done"` bypass depends_on gate**（07-06 留白 #1） | 未测 | ✨ **07-08 首入档 evidence**：R1 有 `depends_on:[R2 in P2 backlog]` 未完成，PATCH `status:"done"` → **200 通过，R1.status 直接 done**。**depends_on gate 只作用 auto-loop（`JARVIS_WORK_MODE=auto`），manual PATCH 不 enforcement** | ✅ **07-06 留白 → 07-08 landed** |

代码侧三个 deferred / 缺陷标记的精确行号仍在原位（今天 grep 三次确认）：
- `packages/server/src/requirements-routes.ts:164-165` 的 `"verification_plan / workflow_id three-state semantics are part of the full Rust handler but out of scope for this port"` 3 行注释。
- `packages/tools/src/register-builtins.ts:13` "未移植清单" 注释含 `"roadmap.import"`；`:166` `"(not yet ported)"`。
- `packages/server/src/workflow-routes.ts:156` 的 `normalizeSteps(body.steps ?? [])` —— 今天 13 shape 探针 10 种 500 泄漏全复现。

---

## 1. 测试配置（分三次起）

### 主分支（§2 / §3 / §4.1-4.4 / §4.9-4.11）

```
OPENAI_API_KEY=sk-stub-for-automation-test
JARVIS_PROVIDER=openai
JARVIS_MODEL=gpt-4o-mini
JARVIS_FS_ROOT=/tmp/jarvis-servlet-test
JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-20260708
JARVIS_ADDR=127.0.0.1:7099
JARVIS_WORK_MODE=off
JARVIS_PERMISSION_MODE=bypass
JARVIS_NO_PROJECT_CONTEXT=1
```

启动日志：
```
[jarvis] persistence connected: json:///tmp/jarvis-servlet-test-db-20260708
[jarvis] serve: provider=openai model=gpt-4o-mini addr=127.0.0.1:7099 fsRoot=/tmp/jarvis-servlet-test coding=false auth=none ddns=off mdns=off promptBytes=263
[jarvis] listening on http://127.0.0.1:7099
```

### Sample=2/3 分支（§4.5 中间态）

```
JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-20260708-sample2
JARVIS_ADDR=127.0.0.1:7098
```

启动前 `rm -rf /tmp/jarvis-servlet-test-db-20260708-sample2` 保干净。

### DDNS + Memory + AccessToken 分支（§4.6-§4.8）

```
JARVIS_ADDR=127.0.0.1:7097
JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-20260708-ddns
JARVIS_DDNS_ENABLE=1
JARVIS_ENABLE_MEMORY=1
JARVIS_MEMORY_USER_ROOT=/tmp/jarvis-mem-20260708
JARVIS_ACCESS_TOKEN=probe-token-07-08-abcd1234efgh5678
```

**关键操作**：启动前 `rm ~/.local/share/jarvis/ddns.json` 以逼出 `configured:false` 分支（07-05 未验证）。

启动日志（注意 `auth=token ddns=on`，与主分支 `auth=none ddns=off` 对比）：
```
[jarvis] serve: provider=openai model=gpt-4o-mini addr=127.0.0.1:7097 fsRoot=/tmp/jarvis-servlet-test coding=false auth=token ddns=on mdns=off promptBytes=263
```

probe 结束后 DDNS `~/.local/share/jarvis/ddns.json` 已回写 07-07 备份（`test-jarvis-07-04-aaaa/AAAA/t2`）。

---

## 2. 5 步 Kanban 主线（stub 模式）

**07-08 校正**：历史 "6 步" 是名义描述，实测 `RequirementStatus` 只 4 值 `backlog|in_progress|review|done`（不含 `blocked`），所以完整状态跃迁最多 4 → 4 组合再加 approve/reject 侧路。今日走 5 步 happy path，去掉 `blocked`：

```
1) POST /v1/projects  {name:"servlet-2026-07-08",instructions:"..."}
   → 201 pid=62d46674-9018-4654-86ba-82241862acd3；slug 自动 "servlet-2026-07-08"（底 slug 首次可用，不需要 -2 后缀）
2) POST /v1/projects/<pid>/requirements
   {title:"add HttpServlet with GET support",description:"..."}
   → 201 rid=4a958990-1bc1-4e8a-936e-4e8c15830be7；triage_state 默认 approved（body 无字段）；status:backlog
3) POST /v1/requirements/<rid>/approve → 200 {approved:true, no_op:true}（触发 §3.9）
4a) PATCH → in_progress                     ✅ (200 8 keys)
4b) PATCH → status:"blocked" (probe)         ❌ 400 {"error":"unknown status \`blocked\`"} —— 07-08 首落
4c) PATCH → in_progress (no-op)              ✅ (200 8 keys)
4d) PATCH → review                           ✅ (200 8 keys)
4e) PATCH → done                             ✅ (200 8 keys)
```

**07-08 首入档**：`PATCH status:"blocked"` **不合法**。`RequirementStatus` 是 4-value 枚举（源码 `packages/project/src/requirement.ts:15`），不含 `blocked`；但 `RequirementTodoStatus` 是 6-value 枚举，**含** `blocked`（源码 :53-59）。UI 使用"blocked" label 时必须知道自己指的是哪层。`block_reason` 字段仍在 requirement schema 中定义（07-06 CLAUDE.md 论断），但没有 REST 路径能把它 set 上 —— 应该是 agent tool `requirement.block` 独占的写路径。

**07-06 已入档**：`/start`、`/block`、`/complete` **都不是 REST 路由**（agent-侧 tools），今日不再走错。今日新加：**"blocked" 也不是 REST 侧合法的 status transition**（虽然 PATCH `status` 校验错误只报"unknown status"，没直接说"only 4 legal transitions"）。

---

## 3. 回归探针（P1 gaps 未修复第 15 次）

### §3.1 P1-A：POST 上 4 字段静默丢

```
BODY = {"title":"probe-4fields-07-08","description":"t","triage_state":"approved",
        "acceptance_policy":"Human",
        "workflow_id":"11111111-1111-1111-1111-111111111111",
        "assignee_id":"user-x",
        "verification_plan":{"steps":[{"kind":"assert","args":{"x":1}}]}}
→ 201 8 keys [conversation_ids, created_at, description, id, project_id, status, title, updated_at]
  完全没有 acceptance_policy / workflow_id / assignee_id / verification_plan
```

### §3.2 PATCH 上 4 字段静默丢

`PATCH /v1/requirements/:id` with same 4 fields:
```
→ 200，响应 wire shape 与 POST 相同 8 keys —— 与 07-05 §3.5 首入档的 double-drop 结论完全一致
```

### §3.3 P1-B：`POST /v1/roadmap/import` 仍 404

```
→ 404 {"message":"Route POST:/v1/roadmap/import not found","error":"Not Found","statusCode":404}
```
Fastify's `message` 命中 07-02 §4.10 记录 —— 500 是 `body.message`，404 也是 `body.message`。

### §3.4 P1-C：`GET /v1/requirements/:id` 仍 404

```
→ 404 {"message":"Route GET:/v1/requirements/<rid> not found",...}
```
（07-06 §3.4 已记 asymmetric with `GET /v1/projects/:id` 存在；07-07 未修；07-08 未修）

### §3.5 orphan `project_id` 无 FK

```
POST /v1/projects/no-such-project-id/requirements {"title":"orphan-07-08","description":"orphan"}
→ 201 {"id":"...","project_id":"no-such-project-id",...}  ← 原样写盘
```

### §3.6 depends_on POST bogus UUID 通过

```
POST /v1/projects/<pid>/requirements {"title":"probe-deps-bogus-07-08","depends_on":["00000000-..."]}
→ 201 完全 accept；response.depends_on = ["00000000-..."]
```

### §3.6b depends_on PATCH-only bogus UUID 通过（07-05 首入档）

```
PATCH /v1/requirements/<real>/ {"depends_on":["11111111-..."]}
→ 200 全 accept
```

### §3.6c depends_on cross-project id 通过（07-07 首入档）

```
PID2 = <new project>；RID2 in PID2 = <real requirement in P2>
PATCH RID (in PID) with {"depends_on":[RID2 (in PID2)]}
→ 200 全 accept，跨 project store 边界的 id 也接受
```

**三条同源 FK 缺陷**（POST bogus + PATCH-only bogus + cross-project）**统统未修**，正如 07-07 建议：修法是一个中心 `validateDependsOn` helper 同时覆盖三个上下文。

### §3.7 depends_on 条件性写回 shape drift

```
create without depends_on → response.keys 8 keys（无 depends_on）
create with depends_on:[] → response.keys 9 keys（含 depends_on:[]）
create with depends_on:[<uuid>] → response.keys 9 keys（含 depends_on:[<uuid>]）
```

07-07 起累计 shape 依赖 body 有无 field；今天再看一次仍是这样。UI 客户端不能安全用 `r.depends_on?.length`（omit 与 [] 语义有差）。

### §3.8 `no_op:true` 首次 approve 已批（default triage_state=approved）

```
create → approve → 200 {"approved":true,"no_op":true,"requirement":{...}}
```

15 天前的 06-25 findings 完全一致；这个"首次 approve 立返 no_op"是 default `triage_state="approved"` 的自然结果，但没有明文文档。

### §3.9 `POST /v1/requirements/:id/reject` 3-state validation matrix

07-07 首入档 3-state（bogus id → 404 / 无 reason → 400 / `reason:""` → 400 trim-aware）；07-08 **补第 4 组**：

```
(d) reason="   "（whitespace-only）→ 400 {"error":"`reason` must not be blank"}
```

**结论加固**：`reason` 校验是完整 trim-aware（去 leading/trailing whitespace 后判 empty），不是仅 `.length === 0`。UI 前端如果只做 `reason.length > 0` 会送 400。

### §3.10 list shape 五分裂（07-08 深化：不是三分裂）

07-07 之前累计称 "三分裂"（bare `[...]` / `{items}` / `{workspaces}`）。今日**逐 route 探明**，五分裂：

| shape | routes |
| --- | --- |
| `[...]` 裸数组 | `/v1/projects` |
| `{items:[...]}` 纯 items | `/v1/workflows`, `/v1/subagents`, `/v1/diagnostics/runs/recent`, `/v1/diagnostics/runs/stuck` |
| `{workspaces:[...]}` 独 uniquely-keyed | `/v1/workspaces` |
| `{items:[...], project_id}` items + parent-id | `/v1/projects/:pid/requirements` |
| `{items:[...], requirement_id}` items + parent-id | `/v1/requirements/:rid/todos`, `/v1/requirements/:rid/runs` |

**5 种 shape 分布在 9 条不同 list 路径**。若客户端封装了统一 `deserializeList()` helper，会跨 shape 崩溃。

### §3.11 workflow-run cancel 三态复现

```
bogus id → 404 {"error":"workflow run not found"}
pending run → 200 first cancel 带 finished_at=2026-07-07T19:11:12.041Z
same run → 200 no-op idempotent；finished_at 依旧 =2026-07-07T19:11:12.041Z（不刷新）
same run 再次 → 200 no-op；finished_at 仍不变
```

三次 cancel 逐字与 07-07 一致；`error:"run cancelled by operator"` 也一字不差。

### §3.12 workflow 重名 → 两次 201 UUID 不同

```
POST /v1/workflows {name:"dup-name-07-08",...} → 201 id=9b24190d-c8e3-44d6-bfc9-e5a213cdbd5c
POST /v1/workflows {name:"dup-name-07-08",...} → 201 id=9ef57120-e09c-4c19-965c-7a0fbba7d2fb
```

无 409、无 slug 唯一性校验；Client 必须按 `id` 键（不能按 `name` 键）。

---

## 4. 首落 / 深化的 wire-shape 探针

### §4.1 `POST /v1/workflows` 500 泄漏 13-shape 探针

（本节与 07-06/07-07 完全一致，10 500 / 3 400 全复现）

| body | HTTP | message |
| --- | --- | --- |
| `steps:42 / true / "x" / {}` | 500 | `steps.map is not a function` |
| `steps:[42]` | 500 | `Cannot read properties of undefined (reading 'type')` |
| `steps:[null]` | 500 | `Cannot read properties of null (reading 'id')` |
| `steps:[{}]` | 500 | 同上 |
| `steps:[{name:"x"}]` | 500 | 同上 |
| `steps:[{name,kind:{type:"bogus"}}]` | 500 | `steps is not iterable` |
| `steps:[{name,kind:{type:"agent"}}]` | 500 | `Cannot read properties of undefined (reading 'trim')` |
| `steps:[{name,kind:{type:"agent",prompt:""}}]` | 400 | ✓ `agent step 'x' has an empty prompt` |
| `steps:null` | 400 | ✓ `workflow must contain at least one agent step` |
| `{}` empty body | 400 | ✓ `name is required` |

修法（继续从 07-07 落地）：`workflow-routes.ts:156` 顶层 guard + 5 inner guard 处 = **6 处 type guard**，不是 1 处。

### §4.2 workflow-run cancel 三态 + `finished_at` 首次锁定 wire shape

正确 UUID：`d39ea966-efb9-411f-86d5-a3a3b7803b05`（本日主分支 workflow-run）

```json
{"id":"d39ea966-...","workflow_id":"732ad85c-...","status":"cancelled",
 "step_results":[],"started_at":"2026-07-07T19:11:10.944Z",
 "error":"run cancelled by operator","finished_at":"2026-07-07T19:11:12.041Z"}
```

**7 keys 完全对齐 07-02 §4.9 首入档**：`[error, finished_at, id, started_at, status, step_results, workflow_id]`。

### §4.3 Todo sub-resource **全 5 route 深度矩阵**（07-07 未完 → 07-08 补齐）

#### §4.3.1 `POST /v1/requirements/:id/todos` — evidence 6-field round-trip

```
BODY = {"title":"todo-with-evidence-07-08","kind":"work",
        "evidence":{"run_id":"r-x","exit_code":0,"stdout_excerpt":"ok",
                     "stderr_excerpt":"","artifact_url":"https://ex/a","note":"n"}}
```

**Response outer envelope 2 keys `{todo, requirement}`**（双 envelope，与 06-30 首入档 POST /workflows 类似）。

`todo` 内 8 keys `[created_at, created_by, evidence, id, kind, status, title, updated_at]`，`evidence` 内 **6 keys 全 round-trip 保留**：
```json
"evidence":{"run_id":"r-x","exit_code":0,"stdout_excerpt":"ok",
            "stderr_excerpt":"","artifact_url":"https://ex/a","note":"n"}
```

**注意 `exit_code:0` 和 `stderr_excerpt:""` 都保留** —— falsy 值不 omit，**违背** `packages/project/src/requirement.ts:91-102` 里那 6 行 `/** \`#[serde(skip_serializing_if = "Option::is_none")]\`. */` Rust 注释语义。Node 侧就是原样 stringify，跨 falsy 边界不砸值。UI 前端逻辑不能靠"如果 exit_code 不存在则未运行"—— 得看 `hasOwnProperty("exit_code")` 或 `evidence` 是否存在。

`requirement` 内嵌 13 keys（**07-07 首入档已记**）：`acceptance_policy:"subagent", triage_state:"approved"` 都在 —— 与 POST /requirements 出去的 8 keys shape **完全不同**（07-07 P1 建议：统一 wire shape）。

#### §4.3.2 `POST /:id/todos` — `depends_on` bogus UUID 通过（无 FK）

```
BODY = {"title":"todo-deps-bogus-07-08","kind":"work",
        "depends_on":["00000000-0000-0000-0000-000000000000"]}
```

response `todo.depends_on = ["00000000-..."]` —— 与 requirement.depends_on 同族 no-FK-check。**同源 FK 缺陷 sight #4**（前三：POST /requirements bogus / PATCH-only bogus / cross-project）。

#### §4.3.3 `POST /:id/todos` — 最小 body 默认值

```
BODY = {"title":"todo-minimal-07-08"}  ← 只 title 一个字段
→ response.todo = 7 keys [created_at, created_by, id, kind, status, title, updated_at]
   - status = "pending"（default）
   - kind = "work"（default）
   - created_by = "human"（default）
   - depends_on 不存在（omit）
   - evidence 不存在（omit）
   - command 不存在（omit）
```

**关键**：`title` 是唯一必需字段；`kind/status/creator` 各自 default，没有则 omit；`depends_on/evidence/command` 缺则 omit。

#### §4.3.4 `GET /:id/todos` — list wire shape 3 keys

```json
{"items":[...],"requirement_id":"4a958990-..."}
```

**2 keys** `{items, requirement_id}` —— 与 POST /todos 的双 envelope 完全不同。**列 shape 是 §3.10 五分裂里的第 5 种**。

items[*] 内每个 todo 8 keys（同 §4.3.1 的 todo shape）。

#### §4.3.5 batch `PATCH /:id/todos {ids, status}` — **首入档 ATOMIC 语义 + 校验矩阵**

**happy path**:
```
BODY = {"ids":["<TID1>","<TID2>"],"status":"running"}
→ 200 {"todos":[{id:TID1,status:running,...},{id:TID2,status:running,...}]}   ← 单 key `todos:[...]`
```

**校验矩阵**（全 400 + 特定 error 串）：

| body | HTTP | error |
| --- | --- | --- |
| `{ids:[TID1], status:"done"}` | 400 | `unknown todo status \`done\`` |
| `{ids:[], status:"passed"}` | 400 | `\`ids\` must be a non-empty array` |
| `{status:"passed"}` (no ids) | 400 | 同上 |
| `{ids:[TID1]}` (no status) | 400 | `unknown todo status \`undefined\`` |
| `{ids:["00000000-..."], status:"passed"}` (all bogus) | **404** | `todo \`00000000-...\` not found` |

**07-08 首入档 ATOMIC 证明**（关键新发现）：
```
BEFORE: TID1.status="running"（07-07 已确定 :657-693 只支持 batch status）
BODY  : {"ids":["<real TID1>","<bogus UUID>"],"status":"passed"}
→ 404 {"error":"todo \`<bogus UUID>\` not found"}
AFTER : TID1.status="running"（**没变**）
```

**结论**：validate all IDs first → apply status if all valid，任何一个 id miss 则整个 batch 拒。与 `DELETE /:id/todos/:tid` 的 universal 200 no-op（下条）**同一 API 下两种截然不同的 idempotence style**。

#### §4.3.6 `DELETE /:id/todos/:todo_id` — **首入档 universal 200 no-op**

|情境 | HTTP | body |
| --- | --- | --- |
| real TID | 200 | `{"deleted":true, "requirement":{...13 fields, todos 列表已剔除该 TID}}` |
| bogus TID (`00000000-...`) | **200** | 同上 shape，requirement.todos 不变 |
| 已删的 TID 再删 | **200** | 同上 shape |
| bogus 外围 RID + real TID | **404** | `{"error":"requirement \`00000000-...\` not found"}` |

**结论**：
- todo_id 层是 **universal 200 no-op**（对齐 `DELETE /v1/memory/includes`）；
- 外围 requirement_id 层**仍**做 FK 硬校 404。
- 与 batch PATCH（§4.3.5）的 404-on-any-unknown-id 形成一 API 内两种幂等 style（**已是第三种 style 差别累计**：见 07-04 累计的 `DELETE /memory/includes` 系列）。

#### §4.3.7 单 `PATCH /:id/todos/:tid` — wire shape 与支持字段

```
BODY = {"kind":"ci","title":"updated-07-08","depends_on":["deadbeef-..."]}
→ 200 outer envelope 2 keys `{todo, requirement}`（同 POST /todos）
   todo 9 keys: [created_at, created_by, depends_on, evidence, id, kind, status, title, updated_at]
   requirement 13 keys（同 POST /todos 嵌套）
```

支持字段（源码 :690-712 已列，wire 侧本次确认）：`title / kind / status / depends_on`（evidence / command 未测；07-06 记 :690-712 也列了 `evidence` + `command`，待下轮补）。

### §4.4 `POST /v1/requirements/:id/conversations` — **07-07 3 项 correction + 深化**

07-07 首入档记："`{requirement, appended:true}`" + "conversation_ids 累积（不去重）"。今日精查：

#### §4.4.1 真 UUID 但不存在的 conversation → 200 通过（无 FK 存在性校验）

```
BODY = {"conversation_id":"11111111-2222-3333-4444-555555555555"} ← 真 UUID shape 但从没 create 过
→ 200 {"requirement":{...conversation_ids:["11111111-..."]},"appended":true}
```

**结论**：`conversation_id` 上**无格式校验**（07-07 已记：`"not-a-uuid"` 通过）**也无存在性 FK**（今日新加）—— 是**双重 no-check**，与 POST /requirements 上 `project_id` 无 FK（§3.5）+ requirement.depends_on 无 FK（§3.6/§3.6b/§3.6c）**同族**。共 4 处 no-check now。

#### §4.4.2 dedup 落地 —— **07-07 修正**（"累积不去重" → **有 dedup**）

首次 POST 同 CVID → `{appended:true, requirement.conversation_ids 加 1}`
二次 POST 相同 CVID → `{appended:false, requirement.conversation_ids 不变, updated_at 不变}`
三次 POST 相同 CVID → `{appended:false, ...}`（累积 idempotent）

**这是对 07-07 memo 里"conversation_ids 数组累积（不去重）"的直接修正**。07-07 应该只测了首次 append，只看了 requirement.conversation_ids 数组变化（首次 +1），没注意到二次时 `appended:false` + 数组不变。

Wire shape 完整入档：
```json
{"appended": <boolean>,
 "requirement": {"id":"...","...":"...", "conversation_ids":[...], /* 13 fields */}}
```

#### §4.4.3 GET side 不存在

```
GET /v1/requirements/<rid>/conversations → 404 (route not registered)
```
（07-07 已记，今日 confirmed）—— read-side 稀薄。

### §4.5 harness.health fingerprint sample=0/1/2/3/4 全 5 格逐字复现（第 15 天）

主分支起点即 sample=0（fresh DB）：
```
sample=0 → overall_score=50, confidence=0, primary_focus=task_understanding, dim.conf 全 0
```

Kick 1 run → sample=1；kick 2 more → sample=3；kick 1 more → sample=4。全在主分支 DB 上累加。

Sample=2 从副 DB（7098 端口）走：起 fresh → kick 1 run（sample=1 验证） → kick 1 run（sample=2 关键中间态） → kick 1 run（sample=3 验证）。

**Fingerprint 完整**（15 天恒定，与 07-07 逐字一致）：
| sample | overall_score | confidence | primary_focus | dim confidences |
| --- | --- | --- | --- | --- |
| 0 | 50 | 0 | task_understanding | 全 0 |
| 1 | 47 | 0.06560095313918246 | planning_execution | 未细记 |
| 2 | 47 | 0.10397505073716999 | planning_execution | task_understanding=0.06398464660748923 / planning_execution=0.17595777817059538 / capability_invocation=0.031992323303744616 / task_delivery=0.14396545486685075 |
| 3 | 47 | 0.13120190627836492 | planning_execution | 未细记 |
| 4 | 47 | 0.15232069614525703 | planning_execution | task_understanding=0.09373581301246586 / planning_execution=0.25777348578428116 / capability_invocation=0.04686790650623293 / task_delivery=0.2109055792780482 |

**07-08 确认 sample=4 dim.confidence 4 值与 07-07 逐字一致**：0.09373581301246586 / 0.25777348578428116 / 0.04686790650623293 / 0.2109055792780482。

`actions[fill_signal_gaps].title="补齐观测样本"`（tone=neutral）—— P0 前端 1 行读法仍是 `actions.find(a => a.key === "fill_signal_gaps") && sample_count < 5`；15 天未修。

### §4.6 DDNS + Memory + AccessToken side-branch（`configured:false` 分支首入档）

#### §4.6.1 `GET /v1/ddns/config` @ configured:false（**07-05 推测 → 07-08 evidence**）

```
GET /v1/ddns/config → 200 {"configured":false}   ← **1 key**
```

`credentials/hostname/interval_seconds/port/provider/record_type/upnp_enabled` 全都不出现 —— 与 configured 分支的 7 keys 是完全不同的 shape 分支。**Client 必须 branch on `body.configured === false`**（07-05 §4.4 已警告）。

#### §4.6.2 `GET /v1/ddns/status` @ configured:false（**07-05 推测 → 07-08 evidence**）

```
GET /v1/ddns/status → 200 {"enabled":true,"configured":false,"lan_addrs":["192.168.1.164","198.18.0.1"],"reachable":null}   ← 4 keys
```

Configured 分支的 `provider/hostname/public_ip/last_result` 全部 drop —— **07-05 §4.5.7 推测坐实**。

#### §4.6.3 `GET /v1/remote/info.external` 三-shape 分支（**07-08 新发现**）

三种 `external` shape：
| 情境 | `external` shape |
| --- | --- |
| DDNS off | `{}` 空对象（06-30 已记） |
| DDNS enable 但 config 空 | `{"reachable":null}` **1 key**（**07-08 首入档**） |
| DDNS enable + config 已 set + provider 已 query | `{"hostname":"...","public_ip":"...","reachable":<bool|null>}` **3 keys**（07-03 已记） |

**三 shape 均无 `TypeError` 保护** —— UI 客户端 destructure `external.hostname` 时**必须**先 branch on 存在性。

#### §4.6.4 `GET /v1/remote/pairing` with `JARVIS_ACCESS_TOKEN` set（**07-04 推测 → 07-08 evidence**）

```
GET /v1/remote/pairing → 200
{
  "device_name": "zhangjianandeMacBook-Pro.local",
  "token": "probe-token-07-08-abcd1234efgh5678",    ← 明文 access token
  "origins": ["http://192.168.1.164:7097","http://198.18.0.1:7097"],
  "pairing_links": [
    {"origin":"http://192.168.1.164:7097",
     "link":"jarvis://pair?origin=http%3A%2F%2F192.168.1.164%3A7097&name=zhangjianandeMacBook-Pro.local&token=probe-token-07-08-abcd1234efgh5678"},
    {"origin":"http://198.18.0.1:7097","link":"..."}
  ]
}
```

**关键 evidence**：
1. **`token` 字段是明文 access token 原样返回** —— 15 chars+ token 直接可见；
2. **`pairing_links[*].link = jarvis://pair?origin=...&name=...&token=<明文>`** —— access token URL-encoded 拼进 query；
3. 结合 §4.6.5 hostname 300 chars 情境，link 长度可膨到 411 chars（iOS 扫码 URL 极端场景）。

**安全 side-effect**：`/v1/remote/pairing` 未列作任何 auth-required 名单，仍然 loopback bypass；但**从 LAN 上访问 loopback bypass 是不存在的**（bypass 只覆盖 127.0.0.1）。所以 LAN 手机能 hit `/v1/remote/pairing` 时**必须先带 token** —— 否则 auth middleware 拒 401 —— 换言之，除非攻击者已经有 token 才能拿到 pairing 页；那这个"token 明文回显"的自我强化倒也不产生新暴露。**BUT** 若 pairing 页 origin 被截屏/日志/浏览器缓存意外泄漏，明文 token 也就随之泄。UI/iOS 端 handle `pairing_links[*].link` 时**必须**注意"这个字符串本身包含 secret"。

#### §4.6.5 DDNS PUT 三处 soft-accept **加固**

（07-05 记 3 处，07-06 加 2 处，07-07 加 1 处，07-08 加 2 处）

**07-08 新数据**：
- **`provider:"cloudflare"` + `credentials:{}` 空对象 → 200 accept**（07-05 只测 duckdns），响应 `credential_keys:[]`（0 keys）。cross-provider 通吃 credentials 空对象。
- **`record_type` 全谱系扩至 16 类**（07-06 已记 10）：新增 `DS/DNSKEY/NAPTR/URI/SVCB/HTTPS` 全 200 echo passthrough。至此 A/AAAA/CNAME/TXT/MX/NS/SRV/PTR/SOA/CAA/DS/DNSKEY/NAPTR/URI/SVCB/HTTPS 共 16 类零校验。REST 层认可**任何字符串**为 record_type。
- **`interval_seconds` float 语义 2 新数据点**：`200.5 → 200`、`200.999 → 200`（`Math.round(200.999)=201` 排除 round）。至此累计 9 数据点全都印证 `Math.floor + min-clamp 60`。

#### §4.6.6 `port` 双边硬校（不再复现）

`port=1 / 65535` → 200；`port=0 / -1 / 65536` → 400 `port must be 1..65535`。（07-06 已完全定型；今日仅复现）

#### §4.6.7 `provider` 白名单硬校

`bogus-provider` → 400 `unknown DDNS provider "bogus-provider"`。（07-06 已记 5 白名单 `[cloudflare, duckdns, dyndns2, aliyun, dnspod]`）

#### §4.6.8 `hostname` 300 char 跨界渗透**具体字节数**（**07-08 加固**）

```
PUT /v1/ddns/config {"provider":"duckdns","hostname":"a"×300,"port":80,...}
→ 200 逐字接受

GET /v1/remote/info.external.hostname → 长度 300（原样 echo）
GET /v1/remote/pairing.origins.length → 3（多了个 ddns 派生的 origin）
                     .origins[ddns].length → 307（"http://" 7 + hostname 300，port:80 默认不加）
                     .pairing_links[N].link.length → 411
                       ← `jarvis://pair?origin=<URL-encoded 300 chars 需 300 chars>&name=<24 chars>&token=<40 chars>`
```

**iOS 扫码得到 411 bytes 的 URL**。DNS 253 spec 边界必然 fail；iOS 端也许会先崩 QR decoder。**全链路 zero fail-fast**，07-07 首入档；07-08 补精确字节数。

#### §4.6.9 `POST /v1/ddns/upnp/test` body silently ignored（07-06 记）

```
BODY = {"externalPort":9999,"foo":"bar"}
→ 200 {"mapped":false,"externalPort":7097,"internalPort":7097,"message":"no UPnP gateway..."}
```

`externalPort:9999` 提交，响应 `externalPort:7097`（从 config port 或 listen port 读，不是 body）。`foo:"bar"` 未反应。No-parameter endpoint 伪装成 parameterized POST；07-06 已记，今日 confirmed。

#### §4.6.10 `POST /v1/ddns/update` fake `record_type=MX` + duckdns（**07-06 留白 landed**）

```
PUT /v1/ddns/config {"provider":"duckdns","hostname":"test-jarvis-07-08.duckdns.org","port":7097,
                     "record_type":"MX","credentials":{"token":"fake-token"}}
→ 200 (record_type 层 accept)

POST /v1/ddns/update
→ 200 {"enabled":true,"configured":true,"lan_addrs":[...],"reachable":null,
       "provider":"duckdns","hostname":"...","public_ip":"67.200.120.26",
       "last_result":{"ok":false,"message":"missing credential(s): api_token"}}
```

**关键 evidence**：
1. `POST /v1/ddns/update` **不 raise 400/500** —— 用 200 wrap 包 `last_result:{ok:false, message}`。UI 客户端得 hard-check `last_result.ok`，不能只查 HTTP status；
2. `duckdns adapter` 的失败**先查 credentials 后查 record_type** —— 我传 `{token:"fake-token"}` 但 adapter 报 `missing credential(s): api_token`。所以 duckdns 期望的 credential key 名是 `api_token` 而不是 `token`。**这与 07-04 / 07-06 memo 里"duckdns 用 `token` key"的假设冲突** —— 要么 07-04 记法有误，要么 adapter 版本变了。**待查代码**：`packages/ddns/src/duckdns.ts` 里 required credential key name；
3. `record_type=MX` 无论如何都不会被 duckdns adapter 直接拒 —— credential 缺就先挂了。真正 exercise record_type 检查得先给 duckdns 一个真 `api_token`（TODO 待 08-09+）。

**这条 evidence 已 landed 07-06 留白 #2**，但同时暴露出 07-04 memo 里 "credential key: token" 可能是老记忆。

### §4.7 Memory 后端（backend=none）— 全 route 完全复现 07-07 逐字

（本节所有 request/response 与 07-07 §4.6 一字不差；不重录）

`/v1/memory/sync_status` → 200 `{backend:"none", user_root, workspace_root}`
`/v1/memory/includes` → `{scope, memory_md, items:[]}`
`POST /v1/memory/includes` `{target}` → `{ok:true, added, scope, memory_md}`
`DELETE /v1/memory/includes` `{target}` → 200 no-op universal（**已 add / 从未 add / 空 target(400)** 三分支）
`POST /v1/memory/includes/refresh` `{target}` for `local_path` kind → 400 `refresh only applies to git+ includes`
`POST /v1/memory/sync` at `backend=none` → 503 `memory.sync only applies to the \`git\` backend — current backend is not git`
`GET /v1/memory/includes?scope=user` → 200 with `user_root/.jarvis/memory/MEMORY.md`

### §4.8 `server/info` 顶层 16 keys（**未加 ddns/memory_enabled/access_token_configured/mdns/features**）

```
16 keys = [approval_mode, coding_mode, config_path, listen_addr, max_iterations, mcp_servers,
           memory, persistence, project_context, project_store, providers, system_prompt,
           tool_count, tools, version, workspace_root]
```

即便本次 side-branch 已 enable DDNS + memory + access_token，`server/info` 里没有一个 feature flag 反映这些 —— 客户端必须 hit `/v1/ddns/status` + `/v1/memory/sync_status` + `/v1/remote/info` 分别探 3 个 endpoint。07-01 P2，7 天未修（跨 07-02 到 07-08）。

### §4.9 `/v1/health` vs `/health` 分裂

```
GET /health → 200 {"status":"ok"}
GET /v1/health → 404 {"message":"Route GET:/v1/health not found",...}
```
（07-02 已记，7 天未修）

### §4.10 manual `PATCH status:"done"` bypass depends_on gate（**07-06 留白 #1 landed**）

设置阶段：R1 in PID 有 `depends_on:[R2 in PID2 backlog]`（R2 从未 approve / 从未 done）。

Direct manual PATCH：
```
PATCH /v1/requirements/<R1> {"status":"done"}
→ 200，response.status = "done"
```

**R1 直接 done，无视 depends_on:[R2 backlog]**。所以 **depends_on gate 只作用于 auto-loop scheduler**（`packages/server/src/auto_mode.ts` — 07-07 memo 已提），不作用于 manual PATCH。CLAUDE.md 讲了 "Auto-loop guards ... all `depends_on` reach Done" 但没有明说 "manual PATCH 不 enforce" —— 这一条 evidence 该 codify 到 CLAUDE.md 里。

后果：UI 允许用户直接把有 depends_on 未完成的 requirement 拉到 Done 列，dependency 图会自破。

---

## 5. 07-08 首次发现清单

1. **✨ `RequirementStatus` 枚举 4 值实证 + `PATCH status:"blocked"` → 400 `unknown status`**（`packages/project/src/requirement.ts:15` 硬编码 `backlog|in_progress|review|done` 无 `blocked`；`RequirementTodoStatus` :53-59 才是 6 值含 blocked。UI 若允许操作员把 requirement 拉入"blocked"列，只能通过 agent tool `requirement.block` 走间接路径 —— 但那个 tool 也不是 REST 侧的 direct PATCH。CLAUDE.md 缺证。）

2. **✨ list shape 五分裂，不是三分裂**（07-06/07-07 累计说 "bare / `{items}` / `{workspaces}` 三分裂"）：
   - `[...]` 裸数组：`/v1/projects` 独此一家
   - `{items:[...]}` 纯 items：`/v1/workflows`, `/v1/subagents`, `/v1/diagnostics/runs/recent`, `/v1/diagnostics/runs/stuck`
   - `{workspaces:[...]}` 特殊 key：`/v1/workspaces` 独此一家
   - `{items:[...], project_id}`：`/v1/projects/:pid/requirements`
   - `{items:[...], requirement_id}`：`/v1/requirements/:rid/todos`, `/v1/requirements/:rid/runs`

   **5 shape × 9 route** —— 与 07-07 三分裂相比多两种"items + parent-id"变体。一致化建议：全部对齐 `{items, ...meta}` 二 keys 模型（保留 `project_id/workspace_id/requirement_id` context），砍 `/v1/projects` 的 bare array（P1 breaking change）。

3. **✨ `POST /v1/requirements/:id/conversations` conversation_id 无 FK 存在性校验**（07-07 只查了 `"not-a-uuid"`；07-08 加：真 UUID shape 但从未存在的 conversation ID `"11111111-2222-3333-4444-555555555555"` 也 200 通过 —— 是**双重 no-check**（无格式 + 无 FK））。合累计**四处同族 no-FK 缺陷**：orphan project_id / depends_on bogus/PATCH-only/cross-project / conversation_id 全 accept。

4. **✨ `conversation_ids` 数组**是** deduped**（**07-07 memo 修正**）—— 07-07 说"累积不去重"错。今日精查：同 conversation_id 二次 POST 返回 `{appended:false, requirement:...}` 且 `conversation_ids` 数组不变、`updated_at` 也不刷。dedup 语义是 API 侧的，客户端**不需要**自己去重。

5. **✨ Todo `evidence` 6-field 全 round-trip 保留（含 falsy 值）**：`exit_code:0` 和 `stderr_excerpt:""` **都保留**在响应里 —— **违背** 源码 `packages/project/src/requirement.ts:91-102` 里注释的 `#[serde(skip_serializing_if = "Option::is_none")]` 语义（Rust 侧原意 Option::None 才 skip，但 falsy 非 None 应该保留；Node 移植后**任何 hasOwnProperty 的值都保留**，`exit_code:0` 不 skip）。UI 端逻辑不能靠"如果 exit_code 不存在则未运行"—— 必须 `evidence?.hasOwnProperty("exit_code")` 或 `evidence !== undefined`。

6. **✨ Todo `depends_on` bogus UUID 通过（第 4 处同源 FK 缺陷）**（`packages/server/src/requirements-routes.ts` :634-638 允许 `body.depends_on:string[]` 落盘 无校验）。

7. **✨ `DELETE /v1/requirements/:id/todos/:todo_id` 是 universal 200 no-op**（对齐 `DELETE /v1/memory/includes` 家族）：bogus todo_id / 已删的 TID / 无关 TID 全 `200 {deleted:true, requirement:{...}}`。**唯有外围 requirement_id 层做 FK 硬校 404**。REST 幂等 style **已累计三种**：全 200 no-op（DELETE 家族）/ "select-then-cancel" 三态（cancel 家族）/ ATOMIC 全或无（batch PATCH todos 家族）。

8. **✨ batch `PATCH /v1/requirements/:id/todos {ids, status}` 是 ATOMIC**（**首入档 hard evidence**）：
   - happy: `{ids:[TID1,TID2], status:"running"}` → 200 `{todos:[...]}` 单 key 响应
   - mixed real+bogus id: 404 `todo <bogus> not found` + real IDs status **不变**（before/after `running` 快照 confirmed）
   - 校验矩阵：`ids:[]` / `ids缺` → 400 `ids must be a non-empty array`；`status缺` → 400 `unknown todo status \`undefined\``；`status:"done"` → 400（`RequirementTodoStatus` 6 值不含 done）

9. **✨ `POST /v1/ddns/update` w/ `record_type=MX` + duckdns 走 credential-first 拒回路径**（**07-06 留白 #2 landed**）：`POST /v1/ddns/update` 返回 **200** wrapping `last_result:{ok:false, message:"missing credential(s): api_token"}`。**证明**：
   - update 层错误封在 200 body 里，不 raise HTTP 4xx/5xx（客户端得 hard-check `last_result.ok`）；
   - duckdns adapter 期望 credential key 是 `api_token`（不是 07-04 memo 里"key: token"的假设）；
   - `record_type=MX` 无论如何都不 exercise —— 得先 pass credential check 才轮到 record_type，本次 credential 早挂；

10. **✨ 跨-provider `credentials:{}` 空对象通吃**（`cloudflare` 侧首入档；07-05 已记 duckdns）—— 响应 `credential_keys:[]` (0 keys)。

11. **✨ `record_type` 16 类全 passthrough**（07-06 记 10 类；07-08 +6 `DS/DNSKEY/NAPTR/URI/SVCB/HTTPS`）—— DNS 记录类型 REST 层零校验，何种字符串都 echo。

12. **✨ `interval_seconds` float 2 新数据点**（`200.5 → 200`、`200.999 → 200`）—— 07-06/07-07 clamp 域和边界都记过，今日补 non-clamp 域普通 `Math.floor` 结论加固。

13. **✨ `POST /v1/requirements/:id/reject` `reason:"   "` (whitespace-only) → 400** —— 07-07 首入档"空串 → 400 trim-aware"，今日补：任何"trim 后为空"的 reason（空白字符串）都命中同一 400，扩展 `trim-aware` 语义边界。

14. **✨ manual `PATCH status:"done"` bypass depends_on gate**（**07-06 留白 #1 landed**）—— R1 有未完成 depends_on 但 manual PATCH 直接 `status:"done"` 通过。auto-loop gate ≠ manual PATCH gate。

15. **✨ DDNS `configured:false` 分支的 `/v1/ddns/config` 与 `/v1/ddns/status` shape 首落 evidence**（07-05 推测坐实）：`config` 分支 1 key `{configured:false}`；`status` 分支 4 keys `{enabled, configured:false, lan_addrs, reachable}`。**Client 必须 branch on `body.configured === false`**。

16. **✨ `GET /v1/remote/info.external` 有第三种 shape `{reachable:null}`**（DDNS 已 enable 但 config 空的中间态；07-08 首入档）。三-shape 分裂。

17. **✨ `GET /v1/remote/pairing.token` = 明文 access token；`pairing_links[*].link` 包含 `&token=<明文>`**（07-04 推测 → 07-08 evidence）—— iOS QR pairing 全流水线的最终 URL 长度可达 411 chars（hostname 300 chars 边界情境）。**安全评估**：由于 `pairing` endpoint 本身受 auth-required guard 保护（remote 情境下），token 泄漏"自我强化不产生新暴露"；但 pairing 页 URL 一旦被 accidentally 截屏 / 日志 / 浏览器缓存，明文 token 直接跟着漏。UI/iOS 端处理 `pairing_links[*].link` 时**必须**知道字符串本身含 secret。

---

## 6. 未修复清单（P0/P1/P2 累积）

**P0**（前端 1 行 5 分钟）：
- confidence < 0.2 前端兜底（读 `actions.find(a=>a.key==="fill_signal_gaps") && sample_count<5`）— **15 天未修**。sample=0/1/2/3/4 五格 fingerprint 常数已全填齐 15 天恒定 —— sample<5 时 confidence 全 <0.16 是精确阈值。

**P1**（REST 层缺 route / FK / 字段透传）：
- POST + PATCH 4 字段（`acceptance_policy` / `workflow_id` / `assignee_id` / `verification_plan`）静默丢 — 15 天未修
- `POST /v1/roadmap/import` 404 — 15 天未修
- `GET /v1/requirements/:id` 404 — 15 天未修
- `GET /v1/requirements/:id/conversations` 404（07-07 加入）— read-side 稀薄同 §3.4 pattern
- orphan project_id 无 FK — 15 天未修
- `depends_on` 跨 id FK POST 侧无校验 — 11 天未修
- `depends_on` PATCH-only bogus FK — 4 天未修
- `depends_on` cross-project id FK — 2 天未修
  （三条同源 + 07-08 Todo depends_on FK 也不校验 = **四条同源 FK 缺陷** —— 修法 = 一个中心 `validateDependsOn` helper 覆盖 requirement POST + PATCH + cross-project + Todo）
- `POST /:id/conversations` conversation_id 无格式校验（07-07 加入）+ **07-08 新加：无存在性 FK**（真 UUID 但不存在的 conversation 也 200 通过）— 4-way no-check 家族
- `POST /v1/workflows` 500 泄漏 10 shape — 9 天未修（`workflow-routes.ts:156` 单点 + 5 内 guard 处 = 6 处 type guard）
- `DELETE /v1/ddns/config` 未注册 route — 7 天未修
- **07-08 新加**：manual PATCH `status:"done"` bypass depends_on gate（07-06 留白 landed）— 应该在 requirement PATCH 处也验 depends_on 或明文 warn client

**P2**（一致性 / 语义 / 文档缺）：
- **07-08 深化**：list shape **五分裂**（07-07 描述"三分裂"低估），跨 9 route 五种不同 wrapper —— 一致化建议整齐 `{items, ...parent_id?}` 二 key 模型
- `/v1/health` 404，`/health` 200 — 7 天未修
- `server/info` 不反映 `ddns/memory_enabled/mdns/access_token_configured/features` — 7 天未修
- `/v1/diagnostics/memory` 200+flag vs 其余 feature-off 503 — 长期
- `depends_on` 条件性写回 shape drift — 11 天未修
- DDNS PUT 三处 soft-accept + hostname 跨界渗透 411 bytes — 15 天未修（`record_type` 现 16 类零校 / `interval_seconds` 静默 Math.floor+clamp / `credentials={}` 跨-provider 通吃 / `hostname` 300 chars 无长度校 也无 punycode）
- `POST /v1/ddns/upnp/test` body 静默无效（no-parameter endpoint）— 3 天未修
- `POST /v1/ddns/update` 200 wrap `last_result:{ok:false}` 语义 —— HTTP status 反映"路由成功"不反映"操作成功"；文档缺
- **07-08 新加**：duckdns adapter 期望 `api_token` credential key（07-04 memo 里"token" key 已老）—— 待查 `packages/ddns/src/duckdns.ts`
- `/start` `/block` `/complete` 是 agent tools 而非 REST，CLAUDE.md 未明写 — 3 天未修
- `POST /:id/review` body 静默无效（07-07 加入）
- CLAUDE.md 未列 `POST /:id/conversations` REST 存在（07-07 加入）
- Todo `status` / `kind` / `created_by` 枚举与 Requirement 完全不同（07-07 加入）
- **07-08 新加**：`RequirementStatus` 只 4 值不含 `blocked`；CLAUDE.md/README 未文档
- **07-08 新加**：Todo evidence falsy values（`exit_code:0` / `stderr_excerpt:""`）不 skip —— Node 侧移植后失去 Rust `#[serde(skip_serializing_if = "Option::is_none")]` 语义，注释误导
- Activity `body.kind` inner-classifier convention（07-07 加入）
- UUID 格式校验非一致（07-07 加固）
- **07-08 新加**：REST 幂等 style 累计三种（universal 200 no-op / select-then-cancel 三态 / atomic 全或无）—— 类 API 内混用同类 verb（DELETE, cancel, batch PATCH）却不同幂等；文档缺
- **07-08 新加**：Todo sub-resource 五 route 五种 envelope shape（`{todo, requirement}` / `{items, requirement_id}` / `{todos}` / `{deleted, requirement}` / `{todo, requirement}` 单 PATCH）—— 应该统一
- **07-08 新加**：`GET /v1/remote/info.external` 三-shape 分裂（`{}` / `{reachable:null}` / `{hostname, public_ip, reachable}`）—— 客户端 destructure 需 branch
- **07-08 新加**：`/v1/remote/pairing.token` = 明文 access token；`pairing_links[*].link` 含明文 token —— 安全 side-effect 已入档

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

# Sample=2 干净 DB（§4.5）
export JARVIS_ADDR=127.0.0.1:7098
export JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-<YYYYMMDD>-sample2
node --experimental-strip-types packages/jarvis-app/src/main.ts serve &

# DDNS + Memory + AccessToken 分支（§4.6/§4.7）—— 重点：rm ddns.json 逼出 configured:false 分支
rm ~/.local/share/jarvis/ddns.json
export JARVIS_ADDR=127.0.0.1:7097
export JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-<YYYYMMDD>-ddns
export JARVIS_DDNS_ENABLE=1 JARVIS_ENABLE_MEMORY=1
export JARVIS_MEMORY_USER_ROOT=/tmp/jarvis-mem-<YYYYMMDD>
export JARVIS_ACCESS_TOKEN=<probe-token-YYYYMMDD-random>
node --experimental-strip-types packages/jarvis-app/src/main.ts serve &

# 若要跑真 LLM 端到端
export OPENAI_API_KEY=<真 key> JARVIS_ENABLE_FS_WRITE=1 JARVIS_ENABLE_FS_EDIT=1 JARVIS_ENABLE_SHELL_EXEC=1
export JARVIS_WORK_MODE=auto JARVIS_WORK_TICK_SECONDS=10 JARVIS_WORK_MAX_CONCURRENT=1
# DDNS 真后端复测
export JARVIS_DDNS_PROVIDER=duckdns JARVIS_DDNS_HOSTNAME=<真 duckdns 子域> \
       JARVIS_DDNS_CREDENTIALS='{"api_token":"<真 duckdns key>"}'   ← 07-08 evidence 说 key 名可能是 api_token，不是 token
# memory git 后端复测
export JARVIS_MEMORY_SYNC_BACKEND=git
```

未验证项（继续滚到下一次）：

- **仍留白**（06-30 → 07-08 累积）：subagent.review 实际 flip requirement.status（stub 无 LLM 只落 activity）；triage.scan_candidates 建 ProposedByScan；project.checks 识别 Maven 缺 pom.xml；step_results[*] shape 在有 LLM key 时；`POST /v1/workflow-runs/:succeeded_run/cancel` 是否 200 no-op
- **07-03 → 07-08 累积新留白**：
  - `JARVIS_MEMORY_SYNC_BACKEND=git` 起飞后 `POST /v1/memory/sync_setup` / `sync` 的 happy-path shape
  - `POST /v1/memory/includes body={target:"git+https://..."}` happy path shape + `kind:"git"` include shape + `refresh` on `kind:"git"` happy path
  - `POST /v1/ddns/upnp/test` 在真有 UPnP gateway 网络下的 shape
- **07-06 留白**（残留）：
  - `POST /v1/ddns/update` 在**真** `api_token` credential 下 `record_type=A/AAAA` 的 happy 路径 vs `record_type=MX/NS/SRV` 的 fail 路径分别的错误串（今日只测了 credential-first fail，record_type-first fail 路径仍待）
  - `server/info.mcp_servers` shape（当有 MCP 时）
- **07-07 留白**：
  - **Todo `evidence` field POST/PATCH body 校验行为**：`{run_id:123}`（非-string）会否 400？`{unknown_field:"x"}` 是否 strict schema drop？
  - 单 `PATCH /:id/todos/:tid` 也传 `evidence` 字段是否 round-trip / 是否 merge / 是否覆盖
  - **Todo `command` field wire shape** —— 源码 :690-712 支持 command，本次未测 evidence 与 command 混用行为
- **07-08 新留白**：
  - **`GET /v1/remote/info.external.hostname` 300 chars 情境下 iOS `jarvis://pair?origin=...` scheme 在 iOS 端 URL parser / QR decoder 是否 crash**（zero fail-fast → client-side crash 场景）
  - `POST /v1/ddns/update` 在有真 `api_token` 的 duckdns 下：`record_type=MX/SRV/CNAME/TXT` 各自的 fail 消息（duckdns adapter 只支持 A/AAAA）
  - `packages/ddns/src/duckdns.ts` 源码是否真的 credential key = `api_token` （grep to confirm 07-08 evidence）
  - `RequirementStatus` 4 值以外的其他候选是否也 400（`draft` / `cancelled` / `on_hold` 等常见）
  - Todo 单 `PATCH /:id/todos/:tid` 传 `evidence:{unknown_field}` 是否原样保留（extension） 或 strip
  - `POST /v1/ddns/update` 5+ 次连续调时 auto-populate 的 `public_ip` 是否有 cache TTL

---

## 8. 总览

| 项 | 评分 | 与 07-07 比 |
| --- | --- | --- |
| Kanban (Project + Requirement CRUD + 5 状态转换 + Activity) | ✅ 健康 + `RequirementStatus` 4 值 evidence + `blocked` PATCH 400 首落 | **07-08 补 4-value evidence** |
| Workflow CRUD + dispatch + cancel（bogus 404 / cancelled 200 no-op / `finished_at` 不刷新） | ✅ 健康（除 §4.1 的 10 种 500 泄漏） | 持平 |
| Diagnostics (`/v1/diagnostics/*` + `/v1/work/*`) | ✅ 健康 | 持平 |
| Harness.health 算法实装 | ✅ 稳定第 15 天 —— sample=0/1/2/3/4 全填齐；sample=2/4 dim.confidence 4 数字仍逐字对齐 | **持平** |
| Harness.health 信号采集 | ⚠️ 缺 LLM 驱动时无信号 | 持平 |
| Harness.health 前端表达 | ❌ confidence 低分仍直接展示 score | **15 天未修** |
| DDNS 后端 | ✅ 健康 + configured:false 双分支 shape 首落 + credential-first update fail 路径首落 + 16 类 record_type 零校验 + 411 bytes iOS pairing URL 极端情境 | **07-08 加固三条 evidence** |
| Memory 后端（backend=none） | ✅ 健康 + 全 include/refresh 语义 + DELETE 幂等 universal 200 no-op | 持平 |
| REST ↔ 数据模型一致性 | ❌ 4 字段 POST+PATCH 丢；project_id 无 FK；depends_on 4 处无 FK（POST + PATCH + cross-project + **07-08 Todo depends_on**）；无 `GET /v1/requirements/:id`；`POST /:id/conversations` 存在但 CLAUDE.md 未列且 GET 缺；`conversation_ids` **dedup 已落地 07-07 memo 需修正**；depends_on 条件性写回；list shape **五分裂**（07-08 深化）；UUID 格式校验非一致；`RequirementStatus` 4 值不含 blocked（**07-08 加固**） | **07-08 加固 5 缺陷** |
| Requirement sub-resources 完整覆盖 | ✅ **07-08 补齐 Todo 全 5 route 深度矩阵**：POST 双 envelope + evidence 6 field round-trip（含 falsy） / GET items+requirement_id / batch PATCH **ATOMIC** + 校验矩阵 / DELETE **universal 200 no-op** + 幂等 style 差别评述 / 单 PATCH 支持字段 | **07-08 补齐 Todo 深度** |
| 文档 ↔ 运行时一致性 | ⚠️ 依旧多缺；07-08 又揭底 blocked 4 值 evidence + `conversation_ids` dedup / duckdns credential key = `api_token` (not token) / list shape 5-way / Todo evidence falsy 保留 / 3-shape `external` / `pairing_links[*].link` 含明文 token | **07-08 又揭底 6 缺口** |
| 单测覆盖 | ✅ 522/522 全绿，7719 ms | 持平（噪声内） |
| **真 bug**：`POST /v1/workflows` 500 泄漏 | ❌ 13 shape 探针 → 10 500 / 3 400 全复现（逐字命中 07-07 全部 msg） | 持平（第 9 次） |
| **真 bug**：`DELETE /v1/ddns/config` 无 handler + curl 4-shape split | ❌ 完全复现（今日跳过） | 持平 |
| **真 bug**：DDNS PUT 3+2+1+2 处 soft-accept | ❌ 累计 **8 处 soft-accept** —— 07-05 3 处（record_type 无枚举 / interval_seconds 静默 clamp / credentials={} 空）+ 07-06 2 处（hostname 无长/字符校 + upnp/test body no-op）+ 07-07 1 处（hostname 跨界渗透）+ 07-08 2 处（record_type 扩至 16 类零校 / cloudflare 也 credentials={} 通吃） | **07-08 加固** |
| **真 bug**：depends_on 四处无 FK 同源 | ❌ 全复现 + **Todo depends_on 也无 FK** 首入档 | **07-08 加固**（第 4 处） |
| **真 bug**：manual PATCH `status:"done"` bypass depends_on gate | ⚠️ **07-08 首落**（07-06 留白 landed）—— 影响 dependency 图 UI 侧完整性 | **07-08 新添** |
| 自动化的端到端验证（有 LLM key） | ❌ 本次仍未执行 | 持平 |

**总体判断**：HEAD 在 06-23 → 07-08 **十五天**没动，工作树未 commit 文件持平 39，所以 07-07 的所有 P0/P1/P2 结论**原样成立**。本次实际增量价值：

1. **07-07 未验证项落地 7 条一次跑通**：
   - **✨ Todo `evidence` 6 field 全 round-trip**（含 `exit_code:0` 和 `stderr_excerpt:""` falsy 值保留 — 违背 Rust 注释语义 `#[serde(skip_serializing_if = "Option::is_none")]`）
   - **✨ Todo `depends_on` bogus UUID 通过**（第 4 处同源 FK 缺陷）
   - **✨ `DELETE /:id/todos/:todo_id` 是 universal 200 no-op**（bogus TID / 重删 / 无关 TID 全 200；只有外围 RID 层 FK 硬校 404）
   - **✨ batch `PATCH /:id/todos {ids, status}` 是 ATOMIC**（mixed real+bogus id → 404，real IDs 不变）+ 完整校验矩阵
   - **✨ `POST /:id/conversations` 上真 UUID 但不存在的 conversation → 200 通过**（**双重 no-check** = 无格式 + 无 FK）
   - **✨ `GET /v1/ddns/config` @ configured:false = 1 key `{configured:false}`** + `GET /v1/ddns/status` @ configured:false = 4 keys（**07-05 推测坐实**）
   - **✨ `GET /v1/remote/pairing.token` = 明文 access token**；`pairing_links[*].link` 包含 `&token=<明文>`；411 bytes URL 极端情境（**07-04 推测坐实**）
2. **07-06 未验证项落地 1 条**：
   - **✨ manual `PATCH status:"done"` bypass depends_on gate** —— auto-loop gate ≠ manual PATCH gate
3. **07-07 memo 需 1 处订正**：
   - **`conversation_ids` IS deduped** —— `{appended:false}` 是 dedup 信号；`updated_at` 不刷；数组不变
4. **07-08 意外新落地 6 条**（07-07 未预告）：
   - **✨ `RequirementStatus` 只 4 值** —— `PATCH status:"blocked"` → 400 `unknown status`；`RequirementTodoStatus` 是独立的 6 值（含 blocked），UI 极易混淆
   - **✨ list shape 五分裂** —— 07-07 记的"三分裂"低估；9 route 5 种 shape
   - **✨ Todo `evidence` 6 field falsy 值不 skip** —— Node 侧移植后失去 Rust `skip_serializing_if` 语义，注释误导
   - **✨ `POST /v1/ddns/update` 200 wrap `last_result:{ok:false}` 语义** —— HTTP status 表"路由成功"不表"操作成功"；duckdns adapter credential key 期望 `api_token`（07-04 memo "token" 已老，待查代码）
   - **✨ DDNS `record_type` 扩至 16 类零校验**（+6 类 `DS/DNSKEY/NAPTR/URI/SVCB/HTTPS`）
   - **✨ REST 幂等 style 累计三种**：universal 200 no-op（DELETE 家族）/ select-then-cancel 三态（cancel 家族）/ ATOMIC 全或无（batch PATCH todos 家族）—— API 内混用同类 verb 不同 style
5. **fingerprint 稳定第 15 天** & sample=0/1/2/3/4 五格全填齐（sample=2 dim.conf 4 数与 07-06 一致 / sample=4 dim.conf 4 数与 07-07 一致）
6. **cross-day 持久化 chain 第 6 天**：`~/.local/share/jarvis/ddns.json` 07-03 → 07-04 → 07-05 → 07-06 → 07-07 → 07-08 六跳跨日存活

**建议**：下次合 P1 修复时**同时**做（相较 07-07 添加 4 项）：①4 字段透传 create+patch **且统一 sub-resource 响应 shape**（P1；07-07 记 8 vs 13 keys 差别，07-08 补 5 种 envelope）；②project_id FK + `GET /v1/requirements/:id` + `GET /v1/requirements/:id/conversations`；③depends_on FK 中心 helper **覆盖 requirement POST + PATCH + cross-project + Todo 4 处**（**07-08 新加 Todo 第 4 处**）；④workflow POST 6 处类型守卫；⑤`DELETE /v1/ddns/config` 加 route；⑥`server/info` 补 ddns/mdns/memory_enabled/access_token_configured 字段；⑦一次性 codify 到 CLAUDE.md（延续 07-07 建议 +）：**RequirementStatus 4 值 vs RequirementTodoStatus 6 值差异**（**07-08 新**）+ manual PATCH 不 enforce depends_on gate（**07-08 新**）+ `conversation_ids` dedup 语义（**07-08 修正**）+ Todo evidence falsy 值不 skip 语义（**07-08 新**）；⑧DDNS PUT 全 8 处 soft-accept 逐一转 hard-reject（含 07-08 record_type enum 校）；⑨CLAUDE.md 明写 `/start` `/block` `/complete` 是 agent tools 无 REST；⑩**07-08 新**：`packages/ddns/src/duckdns.ts` 里 credential key 名 (`api_token` vs `token`) 与 CLAUDE.md 文档统一；⑪**07-08 新**：list shape 5-way 统一成 `{items, ...parent_id?}` 二 key 模型（P1 breaking change on `/v1/projects`）；⑫**07-08 新**：`POST /v1/ddns/update` 语义澄清 —— 200 表 "route hit" 不表 "operation ok"；文档 + typing 都得补。

**P0 修复（15 天）**：前端读 `actions.find(a => a.key === "fill_signal_gaps") && sample_count < 5` 当 cold-start 兜底信号，1 行 5 分钟 —— 十五天延期的根本原因还是被误判成"需要重新设计"。

**Servlet 测试基线加固**：`/tmp/jarvis-servlet-test/src/main/java/com/example/HelloServlet.java` 07-03 手动重建后连续**六天**完好；`.jarvis/memory/{MEMORY.md, shared/tone.md}` residual 也在。仍未固化 fixture 生命周期 —— `scripts/servlet-fixture-reset.sh` 07-05/07-06/07-07 已提，未做。
