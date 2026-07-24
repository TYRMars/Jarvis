# Jarvis 项目自动化能力诊断报告（2026-06-29 六次复测）

- **运行时间**：2026-06-29（scheduled task 自动跑）
- **被测分支**：`feat/mobile-ios-ddns`（HEAD 仍为 `64d288a`，与 06-23 / 06-25 / 06-26 / 06-27 / 06-28 同一 commit — **静默第 6 天**；工作树侧的 iOS + DDNS 改动仍未 commit）
- **被测项目**：`/tmp/jarvis-servlet-test`（`HelloServlet` + `EchoServlet` + `web.xml`，仍无 Maven/Gradle；`EchoServlet.java:7` 的 `TODO(jarvis):` 仍在）
- **本次目的**：
  1. **回归确认** 06-25 → 06-28 报告里所有 P0/P1 是否在 1 天间被修复（预期：未修，HEAD 未动）
  2. **补全 wire shape**：06-28 未盖到的 `GET /v1/projects/:id`、`GET /v1/projects`（列表）、`/v1/work/quality`、`/v1/observability/health` 顶层 `rules / evidence`、`/v1/diagnostics/runs/recent.items[].logs`、`/v1/workspace` 在非 git 目录下的形状、approve/reject 幂等行为、`/v1/subagents` 列表
  3. **新发现**：①`GET /v1/projects/:id` **存在并工作**——与 `GET /v1/requirements/:id` 的 404 形成不对称；②`GET /v1/projects` 返回**裸数组**，与 `/v1/workflows` `/v1/subagents` `/v1/diagnostics/runs/*` 的 `{items:[]}` 不一致；③`POST /v1/requirements/:id/approve` 在 backlog（未审批过的）行上首次调用就返回 `no_op:true`——与"幂等仅在重复时为 no-op"的直觉不符；④`POST /v1/requirements/:id/reject` 对已 approved 行会**软删**整行；⑤`POST /v1/projects` 的 instructions 校验是 trim-aware（`""` / `"   "` 都 400）；⑥`/v1/observability/health` 顶层有 `rules` + `evidence` 字段，前 6 次报告都漏列；⑦`/v1/diagnostics/runs/recent.items[].logs` 与 stuck 同样存在（06-28 漏列）
- **运行约束**：与前五次一致——`JARVIS_WORK_MODE=off`、stub LLM key、`JARVIS_PERMISSION_MODE=bypass`，DB 用 `json:///tmp/jarvis-servlet-test-db-20260629` 全新路径（避免 `rm -rf` 触发 auto-mode 保护）

---

## 0. TL;DR — 与 06-28 的差异

| 项 | 06-28 状态 | 06-29 状态 | 变化 |
| --- | --- | --- | --- |
| `git log --since=2026-06-28` | 0 commit | **0 commit**（HEAD 仍 `64d288a`） | 静默第 6 天 |
| 522 条 `@jarvis/server` 单测 | 522/522 ✅（7706ms） | **522/522 ✅**（duration 7.702 s） | 持平（噪声范围内） |
| P1-A POST + PATCH 4 字段透传（`acceptance_policy / workflow_id / assignee_id / verification_plan`） | 全双向静默丢字段 | **仍全双向静默丢字段**（实测 POST/PATCH 响应 keys = `id/project_id/title/status/conversation_ids/created_at/updated_at`） | ❌ 未修 |
| P1-B `POST /v1/roadmap/import` | 404 | **404** | ❌ 未修 |
| `GET /v1/requirements/:id` | 404 | **404** | ❌ 未补 |
| **`GET /v1/projects/:id`**（06-29 新测） | 未测过 | **200 OK**（返回 `{id,slug,name,instructions,tags,workspaces,archived,created_at,updated_at}`） | ⚠️ 与 requirements 的 404 形成 wire-shape 不对称 |
| **`GET /v1/projects` 顶层 shape**（06-29 新测） | 未测过 | **裸数组**（`type=list`），不是 `{items:[]}` | ⚠️ 与 `/v1/workflows` `/v1/subagents` `/v1/diagnostics/runs/*` 不一致 |
| Orphan 行：`POST /v1/projects/no-such-id/requirements` | 201 + project_id 原样写回 | **201 + project_id 原样写回** | ❌ 未修 |
| `depends_on` 条件性写回 | 入 → 写回，未入 → 不返回 | **完全复现**（body 不带 → 缺字段；body `[]` → `[]`；body bogus id → bogus id 原样写回） | ❌ 未修 |
| `depends_on` 跨 id FK 校验 | 不存在的 dep id 一路通过；只 self-loop 拒 | **完全复现**（self-loop 仍 400，bogus id 仍 201） | ❌ 未修 |
| `/v1/diagnostics/memory` 关闭态 | `{backend:"unknown",stats_available:false}` | **完全复现** | ❌ 文档未补 |
| `/v1/work/overview` 无 `throughput_today` | 已勘误确认 | **再次复现**（顶层 14 keys 与 06-28 一致） | ✅ 文档化建议仍待补 |
| `actions[*]` 字段集合 | `[key, metric, next_steps, priority, title, tone, why]` — 无 `label` | **完全复现** | ✅ 文档化建议仍待补 |
| **`/v1/observability/health` 顶层 `rules` + `evidence`**（06-29 新测） | 前六报告都没列 | **存在**（top keys = `[actions, confidence, dimensions, evidence, generated_at, overall_score, primary_focus, rules, sample_count, signals, sources, tool]`） | ⚠️ 06-29 新增 wire-shape 补丁 |
| **`/v1/diagnostics/runs/recent.items[].logs`**（06-29 新测） | 06-28 列了 `conversation_id/id/requirement_id/started_at/status`，没列 `logs` | **存在**（recent 与 stuck 都带 `logs`；stuck 额外有 `age_seconds`） | ⚠️ 06-29 补 |
| **`/v1/work/quality`**（06-29 新测） | 未测过 | **200 OK** 顶层 `{as_of, since, top_failing_commands, truncated, verification_pass_rate_by_day, window_days}`；`verification_pass_rate_by_day[*]` = `{date, passed, failed, needs_review}` | ⚠️ 06-29 wire shape 入档 |
| **`POST /v1/projects` 空白校验**（06-29 新测） | 06-26 说"非空 instructions"，未细化 | **trim-aware**（`""` / `"   "` 都 400 `instructions must not be empty`） | ⚠️ 06-29 收紧 |
| **approve 在 backlog 上的幂等**（06-29 新测） | 未测过 | **首次 approve 也返 `no_op:true`**（因为待测行 `triage_state` 已是 approved——backlog 是 kanban 列，不是 triage 状态） | ⚠️ 06-29 新发现 |
| **reject 已 approved 行**（06-29 新测） | 未测过 | **软删整行**（`{rejected:true, deleted:true, reason}`） | ⚠️ 06-29 新发现 |
| **`POST /v1/requirements/:bogus_id/reject`**（06-29 新测） | 未测过 | **404 `requirement <id> not found`**（与 approve 的 idempotent no_op 路径不同——非幂等） | ⚠️ 06-29 新发现 |
| `/v1/workspace` 非 git 目录 | 未测过 | **200 OK** `{root, vcs:"none"}`（没 `branch/head/dirty`） | ⚠️ 06-29 wire shape 入档 |

代码侧两个 deferred 标记仍在原位（与 06-28 一致），不再贴：
- `packages/server/src/requirements-routes.ts:147-167` 的 `CreateBody` / `UpdateBody` 注释。
- `packages/tools/src/register-builtins.ts:13` 的"未移植清单"注释。

---

## 1. 测试配置（与 06-28 几乎一致，仅 DB 路径换全新文件夹）

```
OPENAI_API_KEY=sk-stub-for-automation-test
JARVIS_PROVIDER=openai
JARVIS_MODEL=gpt-4o-mini
JARVIS_FS_ROOT=/tmp/jarvis-servlet-test
JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-20260629    # 06-29 起改用带日期后缀的新路径，避开 rm -rf
JARVIS_ADDR=127.0.0.1:7099
JARVIS_WORK_MODE=off
JARVIS_PERMISSION_MODE=bypass
JARVIS_NO_PROJECT_CONTEXT=1
```

启动日志：
```
[jarvis] persistence connected: json:///tmp/jarvis-servlet-test-db-20260629
[jarvis] serve: provider=openai model=gpt-4o-mini addr=127.0.0.1:7099 fsRoot=/tmp/jarvis-servlet-test coding=false auth=none ddns=off mdns=off promptBytes=263
[jarvis] listening on http://127.0.0.1:7099
```

`/v1/server/info`：`tools=44`、`project_store=true`、`persistence=json://…`、`approval_mode=bypass`、`max_iterations=80`、`coding_mode=false`、`workspace_root=/tmp/jarvis-servlet-test`、`memory.budget_tokens=108000`、`system_prompt.length=263`。

工具集（44 条，与 06-28 完全一致）：

```
ask.text, code.grep, doc.{create,delete,draft.get,draft.save,get,list,search,update,upsert},
echo, exit_plan, fs.{find,list,read}, git.{diff,log,show,status}, http.fetch,
memory.{delete,include_add,include_list,include_refresh,include_remove,list,read,write},
plan.update, project.checks, requirement.{block,complete,create,delete,list,start,update},
subagent.{batch,read_doc,review}, time.now, triage.scan_candidates, workspace.context
```

`project.checks` / `triage.scan_candidates` 仍只作为 agent 工具存在（无对应 REST），stub LLM 模式下今天仍没法实测——继续滚到下次有 key 的复测。

## 2. 6 步迭代轨迹（实测，全新 DB）

| 步 | 操作 | overall_score | confidence | sample_count | primary_focus |
| --- | --- | --- | --- | --- | --- |
| 1 | 4 个需求建好（HelloServlet / EchoServlet / Maven / Smoke），**未 mint run** | 50 | 0.000 | 0 | task_understanding |
| 2 | `POST :hello/runs` | 47 | 0.0656 | 1 | planning_execution |
| 3 | PATCH hello → in_progress | 47 | 0.0656 | 1 | planning_execution |
| 4 | `POST :echo/runs` + `POST :maven/runs` | 47 | 0.1312 | 3 | planning_execution |
| 5 | PATCH hello → review → done | 47 | 0.1312 | 3 | planning_execution |
| 6 | PATCH echo → in_progress → review → done | 47 | 0.1312 | 3 | planning_execution |

数字 **与 06-25 / 06-26 / 06-27 / 06-28 完全一致**（精确到 `0.13120190627836492` 的小数尾部），证明 health 算法对相同输入是 deterministic 的——连续 5 次复测同一切片，可以把这组数字当作"零 LLM 信号下 3 个 pending run"的 canonical fingerprint。

`/v1/diagnostics/runs/stuck?threshold_seconds=1` → 3 条 `pending`（`age_seconds` ~50→0），就是这 3 个 mint 出来又没人跑的 run。`/v1/diagnostics/runs/recent` 同样返 3 条但**不带 `age_seconds`**——这是历史报告里反复确认的 stuck/recent 唯一字段差异。

`/v1/work/overview` 实测顶层 keys（与 06-28 完全一致）：
```
['actor_breakdown','as_of','blocked_requirements','blocked_truncated','missing_stores',
 'project_leaderboard','recent_failures','requirement_status_counts','run_status_counts',
 'running_now','since','throughput_by_day','truncated','verification_pass_rate','window_days']
```

`throughput_by_day` 长度 8（最近 7 天 + 今天），每条 keys=`{date, requirements_completed, runs_completed, runs_failed, runs_started}`。**`throughput_today` 顶层 key 仍然不存在**（06-27 错记已在 06-28 勘误，今天再次确认）。

`/v1/observability/health` 最终切片（3 runs）：

```
overall_score=47  confidence=0.131  sample_count=3  primary_focus=planning_execution
sources:        observability {configured: false, rows: 0}
                evals         {configured: false, rows: 0}
                requirement_runs {configured: true, rows: 3}
dimensions:     list len=4
                keys=[task_understanding, planning_execution, capability_invocation, task_delivery]
actions:        list len=5
                action.keys=[key, metric, next_steps, priority, title, tone, why]  (无 label，与 06-28 一致)
signals:        20 keys（见 §4.5 完整集合）
                terminal/completed/failed/verified = 0; all *_rate = null
rules:          顶层数组（新发现，详见 §4.5）
evidence:       顶层结构（新发现，详见 §4.5）
```

**迭代判断（与 06-25 → 06-28 完全一致）**：所有"在 kanban 上拖拽"的操作都会被记成新的 Activity 行，但 **不会写新的 `RequirementRun`**，所以 `confidence` 不动；只有 `POST :id/runs` 会拉动样本数。前端在 `confidence < 0.2` 时若直接展示 `overall_score=47`，会把"完全没数据"的 cold-start 错误传达成"健康差"——P0 仍未修（6 天连续未修）。

## 3. P1 项回归（仍未修）

### 3.1 `acceptance_policy / workflow_id / assignee_id / verification_plan` REST 透传 — POST + PATCH 双失

复测命令 + 响应（与 06-28 同形）：

```
POST /v1/projects/<pid>/requirements
  body: {"title":"policy-probe","triage_state":"approved",
         "acceptance_policy":"Human","workflow_id":"wf-test",
         "assignee_id":"agent-x",
         "verification_plan":{"checks":[{"name":"x","cmd":"true"}]}}
→ 201 keys=['conversation_ids','created_at','id','project_id','status','title','updated_at']
  acceptance_policy/workflow_id/assignee_id/verification_plan: 4 字段全部 absent

PATCH /v1/requirements/<id>
  body: 同上 4 字段
→ 200 keys 同上，4 字段仍全部 absent
```

代码定位（保持 06-28 引用）：
- `packages/server/src/requirements-routes.ts:147-154` 的 `CreateBody` 显式只列 `title / description / status / triage_state / depends_on / label_ids`。
- 同一文件 `:439` 在 `POST :id/runs` 时读 `item.acceptance_policy ?? "subagent"` 决定 Human policy 行的 409 兜底，但因为 create/update 全部丢字段，**`item.acceptance_policy` 在 REST 路径下永远是 `undefined`**——Human policy 行为只能靠手工写 JSON store 文件构造。
- `verification_plan` 同样在 POST/PATCH 都被吞——`:164-166` 注释明确写 "out of scope for this port"。

**影响**：与 06-28 完全一致——`acceptance_policy / workflow_id / assignee_id / verification_plan` 这 4 个字段，无论 create 还是 update，都进不去 store，**任何 SDK 客户端都无法用 REST 配出 Human policy / workflow 绑定的 requirement**。06-23 → 06-29 累计 **6 次**报告。

### 3.2 `roadmap.import` — 仍 404

```
POST /v1/roadmap/import → 404 {"message":"Route POST:/v1/roadmap/import not found"}
```

`packages/tools/src/register-builtins.ts:13` 的"未移植清单"注释仍在原位。**CLAUDE.md 路由清单与运行时仍不一致**（CLAUDE.md 写着 `/v1/roadmap/import` 是健康的）。06-23 / 06-25 / 06-26 / 06-27 / 06-28 / 06-29 累计 **6 次**报告同条目。

### 3.3 `GET /v1/requirements/:id` — 仍不存在

```
GET /v1/requirements/<any-id> → 404 {"message":"Route GET:/v1/requirements/<id> not found"}
```

`packages/server/src/requirements-routes.ts` 的 17 条路由（POST/PATCH/DELETE/`/runs` / `/approve` / `/reject` / `/review` 等）里**仍然没有任何"按 id 单查"** 的入口。结合 §3.4 的 orphan 行问题，是一条只剩"扫 JSON store 文件"才能可观察的盲区。

**06-29 对照实测**：`GET /v1/projects/:id` **存在并工作**（200 OK，返回完整 project 对象）。`packages/server/src/projects-routes.ts` 有 single-row GET，`requirements-routes.ts` 没有——典型的"半移植"，建议二者口径打齐。

### 3.4 Orphan 行 — project_id 仍可任意写

```
POST /v1/projects/no-such-project-id-2026-06-29/requirements
  body={"title":"orphan-test","triage_state":"approved"}
→ 201 {"id":"...","project_id":"no-such-project-id-2026-06-29","status":"backlog"}

GET /v1/projects/no-such-project-id-2026-06-29/requirements
→ 200 {"project_id":"...","items":[{...orphan row...}]}
```

`requirements-routes.ts` 全文 `projectStore.get\b` 仍 0 匹配。combined fix 仍是 06-26 §4.1 的方案：①POST/PATCH 增加 project_id 存在性校验；②新增 `GET /v1/requirements/:id`（要么 single-row 直读，要么按 16 字节 UUID 扫所有 project 的 JSON 文件）。

### 3.5 `depends_on` 跨 id FK 校验 — 仍不拒 bogus dep（self-loop 仍拒）

```
POST /v1/projects/<real-pid>/requirements
  body={"title":"dep-c","triage_state":"approved",
        "depends_on":["00000000-0000-0000-0000-000000000000"]}
→ 201 {"id":"...","depends_on":["00000000-0000-0000-0000-000000000000"], ...}

PATCH /v1/requirements/<id> body={"depends_on":["<same-id>"]}
→ 400 {"error":"`depends_on` must not contain the requirement's own id (self-dependency)"}
```

`requirements-routes.ts:233/298` 的 self-loop 拒仍有效；跨 id 的 FK 校验仍缺。auto loop 会用"等不到 dep done"静默 skip。06-28 提出，**1 天未修**。

## 4. 06-29 新发现 / 新 wire shape 补丁

### 4.1 新发现 A：`GET /v1/projects/:id` **存在并工作**——与 requirements 的 404 不对称

```
GET /v1/projects/fb6e9114-1a00-40f9-a9b8-9c010cd7a2c6
→ 200 {"id":"fb6e9114-...","slug":"probe-2026-06-29","name":"probe-2026-06-29",
       "instructions":"probe","tags":[],"workspaces":[],"archived":false,
       "created_at":"2026-06-28T19:08:42.939Z","updated_at":"2026-06-28T19:08:42.939Z"}
```

vs `GET /v1/requirements/<any-id>` → **404 route not found**（§3.3）。这强化了 §3.3 的建议：**修 GET requirement single-row 时，直接镜像 `projects-routes.ts` 的 single-row pattern 即可**——半边已经做了，把另半边补齐就行，不是从零开发。

### 4.2 新发现 B：`GET /v1/projects` 返回**裸数组**——与 `{items:[]}` 系不一致

```
$ curl /v1/projects | python3 -c "import sys,json; d=json.load(sys.stdin); print(type(d).__name__)"
list
```

与其他列表路由对照：

| 路由 | 顶层 shape |
| --- | --- |
| `GET /v1/projects` | **`[...]`** (裸数组) |
| `GET /v1/workflows` | `{"items":[]}` |
| `GET /v1/subagents` | `{"items":[]}` |
| `GET /v1/diagnostics/runs/recent` | `{"items":[]}` |
| `GET /v1/diagnostics/runs/stuck` | `{"items":[]}` |
| `GET /v1/requirements/:id/runs` | `{"items":[], "requirement_id":...}` |
| `GET /v1/projects/:pid/requirements` | `{"project_id":..., "items":[]}` |

只有 `/v1/projects` 是裸数组，其他全部 wrapped。如果未来想加分页/游标，`/v1/projects` 这条会是 breaking change——建议要么趁早 wrap 成 `{items:[]}` 并立 deprecation alias，要么文档里写明"projects 是特例"，避免 SDK 一次反序列化 codify 错。

### 4.3 新发现 C：approve/reject 的幂等 + 副作用语义

```
# 在新建的 backlog 行上调 approve（注意 backlog 是 kanban 列，triage_state 默认就是 approved）
POST /v1/requirements/<rid>/approve {}
→ 200 {"approved":true, "requirement":{...status:"backlog"...}, "no_op":true}

# 再 approve 一次
POST /v1/requirements/<rid>/approve {}
→ 200 同上，仍 no_op:true

# reject 已 approved 的行
POST /v1/requirements/<rid>/reject {"reason":"changed-my-mind"}
→ 200 {"rejected":true, "deleted":true, "reason":"changed-my-mind"}
# → 行被软删（GET /v1/projects/<pid>/requirements 不再返回它）

# reject 不存在的 id
POST /v1/requirements/00000000-.../reject {"reason":"smoke"}
→ 404 {"error":"requirement `00000000-...` not found"}
# → 非幂等（与 approve 的 idempotent no_op 路径不同）
```

两个隐性合约：
1. **approve 的"首次也 no-op"**：如果 `triage_state` 已经是 `approved`（这是 POST/PATCH 默认），approve 返 `no_op:true`——客户端不能把 `no_op:false` 当作"我刚刚 promote 了"的信号，应该看 `triage_state` 改变 + Activity row。
2. **reject 不仅"拒"还会"删"**：`reject` 的语义其实是**审批失败 → 软删**，不是"打回 backlog"。CLAUDE.md `/v1/requirements/:id/reject` 段说"writes a rejected Activity before soft-delete"——是对的，但容易被读成"删除是 reject 的副作用之一"而不是"reject = delete + reason"。建议文档加一句"reject 在所有 status 下都软删，不是回退状态"。
3. **approve idempotent 路径返 200 + `no_op`，reject 对 bogus id 返 404**——两条路径的"未命中"行为不一致，SDK 写包装时容易踩到。

### 4.4 新发现 D：`POST /v1/projects` instructions 校验是 trim-aware

```
POST /v1/projects {"name":"X"}                           → 400 instructions must not be empty
POST /v1/projects {"name":"X","instructions":""}         → 400 instructions must not be empty
POST /v1/projects {"name":"X","instructions":"   "}      → 400 instructions must not be empty
POST /v1/projects {"name":"X","instructions":"probe"}    → 201
```

`packages/server/src/projects-routes.ts` 的 instructions 校验做了 `.trim()`——比 06-26 报告里"非空"的描述更紧。CLAUDE.md 文档化时要写明"非空白"而不是"非空"，否则 SDK 客户端会写 `instructions: " " || existing` 当 fallback，被全 400 拦。

### 4.5 新发现 E：`/v1/observability/health` 顶层有 `rules` 和 `evidence` 字段

```
$ curl /v1/observability/health | python3 -c "import sys,json; print(sorted(json.load(sys.stdin).keys()))"
['actions', 'confidence', 'dimensions', 'evidence', 'generated_at',
 'overall_score', 'primary_focus', 'rules', 'sample_count', 'signals', 'sources', 'tool']
```

前 6 次报告（06-23 → 06-28）的 §2 表格列了 `overall_score / confidence / sample_count / primary_focus / dimensions / actions / signals / sources`，**漏列 `rules` 和 `evidence`**——是 health 算法的两个公开字段，前端可能用它解释"为什么这个 score"，建议在 wire-shape 文档化时把 12 个顶层 keys 全写齐。

`signals` 完整 20 keys（同样首次完整列出）：

```
agent_runs, agent_success_rate, cancelled_requirement_runs,
completed_requirement_runs, completion_rate, error_hotspots, eval_cases,
eval_pass_rate, failed_requirement_runs, observed_runs, p95_latency_ms,
requirement_runs, subagent_runs, subagent_success_rate,
terminal_requirement_runs, tool_runs, tool_success_rate,
verification_pass_rate, verification_passed, verified_requirement_runs
```

`sources` 3 keys：`evals / observability / requirement_runs`，每条 `{configured, rows}` 对象（06-26/06-27/06-28 已确认）。

### 4.6 新发现 F：`/v1/diagnostics/runs/recent.items[].logs` 字段存在

06-28 §4.6 列 `runs/recent` items keys 时漏了 `logs`：

```
recent.items[0] keys=['conversation_id', 'id', 'logs', 'requirement_id', 'started_at', 'status']
stuck.items[0]  keys=['age_seconds', 'conversation_id', 'id', 'logs', 'requirement_id', 'started_at', 'status']
```

`logs` 是 array（这次空），与 stuck 一致。stuck 唯一独有的字段仍只是 `age_seconds`。

### 4.7 新发现 G：`/v1/work/quality` wire shape

```
GET /v1/work/quality
→ 200 {
  "as_of": "2026-06-28T19:08:42.957Z",
  "since": "2026-06-21T19:08:42.957Z",
  "window_days": 7,
  "truncated": false,
  "top_failing_commands": [],
  "verification_pass_rate_by_day": [
    {"date":"2026-06-21","passed":0,"failed":0,"needs_review":0},
    ...8 条总计...
  ]
}
```

`/v1/work/overview` + `/v1/work/quality` 是 dashboard 的两条公开路由，但 06-28 报告里只覆盖了 overview。今天补齐 quality 的 wire shape。`top_failing_commands` 空数组（stub LLM 模式下 tool_runs=0，本来就没有）；`verification_pass_rate_by_day` 形状镜像 `throughput_by_day` 的"近 7 天 + 今天"。

### 4.8 新发现 H：`/v1/workspace` 在非 git 目录下的 shape

```
GET /v1/workspace
→ 200 {"root":"/tmp/jarvis-servlet-test","vcs":"none"}
```

CLAUDE.md 写 `→ {root,vcs,branch?,head?,dirty?}`——优化项是可选的（`?`），实测在 `vcs=none` 时确实只有 root + vcs，没有 branch/head/dirty。文档与运行时一致 ✅。值得入档的是"non-git 返 `vcs:"none"` 而不是 503"——客户端可以靠这个字段决定要不要画 git 面板。

### 4.9 新发现 I：`/v1/subagents` 列表 wire shape

```
GET /v1/subagents → 200 {"items":[{"name":"read_doc","tool_name":"subagent.read_doc","description":"..."}, ...]}
```

3 条 subagent（与 `/v1/server/info.tools` 里的 `subagent.{batch,read_doc,review}` 对应），每条 keys = `{name, tool_name, description, ...}`。`{items:[]}` 风格，与 §4.2 列表里的 wrapped 系一致。

### 4.10 新发现 J：`/v1/skills` 在未配 catalogue 时是 503

```
GET /v1/skills → 503 {"error":"skill catalogue not configured"}
```

与 `/v1/diagnostics/memory` 关闭时的 `{backend:"unknown",stats_available:false}` + 200 形成对照——同样是"未配置"，skills 返 503，memory 返 200 + 标记位。哪种更对取决于"未配 == 不可用" vs "未配 == 还在配，先返默认值"。两条路由口径不一致，建议要么打齐 503，要么打齐 200+flag。

## 5. 单测健康

```
$ pnpm --filter @jarvis/server test
...
# tests 522
# pass 522
# fail 0
# duration_ms 7702.164917
```

522/522 全绿（06-28 是 7706ms，今天 7702ms — 噪声范围内）。

## 6. 合并建议优先级（06-23 → 06-25 → 06-26 → 06-27 → 06-28 → 06-29）

| 优先级 | 项 | 文件/位置 | 累计状态 |
| --- | --- | --- | --- |
| **P0** | Web UI 在 `confidence < 0.2` 时把 `overall_score` 替换成"样本不足"——cold-start 与全面崩盘的同 score 必须前端兜底 | `apps/jarvis-web/src/components/Observability/...` | 06-25 抬升，**6 天未修** |
| **P1（升级）** | `requirements-routes.ts` create **和** patch 都加 `acceptance_policy / workflow_id / assignee_id / verification_plan` 透传 + 单测；同步 `requirement.create` 工具 | `:147-167`、`:206`、`:255` + `packages/tools/src/requirement-tools.ts` | 06-23 提出（只 PATCH）；06-27 发现 POST 同样掉字段——抬升；06-29 持平 |
| P1 | `roadmap.import` 工具 + REST 移植；或在 CLAUDE.md 显式标记 deferred | `packages/tools/src/`、`CLAUDE.md` | 06-23 提出，**6 天未修** |
| P1 | requirements create/patch 加 project_id 存在性校验 → 404；**同时新增 `GET /v1/requirements/:id`**（直接镜像 `projects-routes.ts` 的 single-row pattern，半边已写好）。两件事一起做才能完整修掉 orphan 行的不可观察性 | `requirements-routes.ts:206/:255`，新增 `:?` | 06-25 P2 → 06-26 升级 → 06-29 持平 |
| P1 | `depends_on` 跨 id 不存在性校验——目前 self-loop 在 `:233/:298` 已拒，但 `["bogus-id"]` 一路通过 | `requirements-routes.ts:233-237/:298-302` 同位置追加 `for (const dep of body.depends_on ?? []) { if (!await store.get(dep)) ... }` | 06-28 新增，06-29 持平 |
| **P2（新增）** | `GET /v1/projects` 列表 vs 其他列表路由的 shape 不一致（裸数组 vs `{items:[]}`），未来加分页会 breaking。要么趁早 wrap，要么文档里写明特例 | `packages/server/src/projects-routes.ts` 的 GET handler；以及 CLAUDE.md `/v1/projects` 段 | 06-29 新增 |
| **P2（升级）** | `/v1/observability/health` / `runs/*` / `/v1/requirements/:id/runs` / `/v1/work/*` 的完整 wire shape 文档化。06-29 把"top-level 12 keys 含 `rules`+`evidence`"、"`signals` 完整 20 keys"、"`runs/recent.items[].logs`"、"`work/quality` 4 顶层 keys"、"`workspace` 在非 git 目录的形状" 全部 codify。**建议这次直接把 health/runs/work/workspace/subagents/skills/diagnostics-memory/requirements/projects 9 条路由一次性入档**，省得第 7 次复测继续滚字段集合 | `docs/conventions/` 或 CLAUDE.md | 06-23 漏记，06-29 第 5 次补 |
| **P2（新增）** | approve 的 idempotent + reject 的"软删而非回退"语义需要在 CLAUDE.md `/v1/requirements/:id/{approve,reject}` 段显式写明——目前文档只说"approve idempotent" + "reject 在 soft-delete 前写 Activity"，没说 `no_op:true` 在首次也会触发，以及 reject 对 bogus id 返 404（与 approve 的 idempotent 路径不一致） | CLAUDE.md `/v1/requirements/:id/{approve,reject}` 段 | 06-29 新增 |
| **P2（新增）** | `POST /v1/projects` 的 instructions 校验是 trim-aware（`""` / `"   "` 都 400），CLAUDE.md 写成"非空"会被 SDK 误用 | CLAUDE.md 项目段 | 06-29 收紧 06-26 的描述 |
| P2 | `depends_on` wire shape 稳定化——固定服务端写回 `[]` 而不是 omit；或客户端 normalize；文档里写明今天是"输入即写回"的条件性字段 | `requirements-routes.ts` create/patch 响应序列化处 | 06-28 新增，06-29 持平 |
| P2 | `/v1/diagnostics/memory` 在 memory 关闭时的 200 + `{backend:"unknown",stats_available:false}` shape 文档化（客户端可靠 `stats_available` 切 UI）；同时记录 `/v1/skills` 在未配 catalogue 时是 503 ——同为"未配"的两条路由口径不一致 | CLAUDE.md diagnostics + skills 段 | 06-28 新增，06-29 升级（加 skills 对比） |
| P3 | `runs/stuck` 默认 `threshold_seconds` 在 CLAUDE.md 路由清单里补一行；统一所有 diagnostics 路由都返回 `items[]` 的 contract 说明（`recent` 与 `stuck` 都 `{items:[]}`，差异仅 `stuck.items[].age_seconds`） | `CLAUDE.md` | 06-23 提出，未修 |
| P3 | `ObservabilityStore` / `EvalStore` 的 env-driven 拉起方式在 CLAUDE.md 文档化 | `CLAUDE.md` | 06-23 提出，未修 |

## 7. 复测剧本（有 LLM key 时；与 06-28 §7 一致）

```bash
export OPENAI_API_KEY=sk-...
export JARVIS_FS_ROOT=/tmp/jarvis-servlet-test
export JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-<date>   # 06-29 改用日期后缀，避开 rm -rf 触发的 auto-mode 保护
export JARVIS_WORK_MODE=auto
export JARVIS_WORK_TICK_SECONDS=10
export JARVIS_WORK_MAX_CONCURRENT=1
export JARVIS_ENABLE_FS_WRITE=1 JARVIS_ENABLE_FS_EDIT=1 JARVIS_ENABLE_SHELL_EXEC=1
export JARVIS_PERMISSION_MODE=bypass
node --experimental-strip-types packages/jarvis-app/src/main.ts serve &
# 同 §2 的 6 步 → 等 2-3 个 tick →
#   /v1/diagnostics/runs/recent 应出现 completed/failed；
#   /v1/observability/health 应 confidence>0.2 + completion_rate 非 null；
#   sample_count 应从 3 上升到 5+ (LLM 驱动后会写 RequirementRun 终态)。
```

未验证项（继续滚到下一次）：

- `subagent.review` 在 `Subagent` policy 下是否真把 review→done flip（需 `JARVIS_REVIEWER_AUTO_ACCEPT=1`）。
- `triage.scan_candidates` 能否把 `EchoServlet.java:7` 的 `TODO(jarvis): support POST body echo with content-length cap` 自动建成 `ProposedByScan` 需求（**agent-only，无 REST**——必须有 LLM key 才能驱动）。
- `project.checks` 能否识别"缺少 Maven/Gradle"并建议 `mvn archetype:generate` 或 `gradle init`（同样 agent-only）。
- `POST /v1/workflows` 创建 + `/v1/workflows/:id/run` dispatch 全链路（06-29 实测 list 是 `{items:[]}`，但 create/run 路径未触发）。
- `POST /v1/projects/:bogus-pid/requirements` 之后能否用 `requirement.list` 工具（agent 侧）拿回——目前只能用 REST `GET /v1/projects/:bogus-pid/requirements`。

## 8. 总览

| 项 | 评分 | 与 06-28 比 |
| --- | --- | --- |
| Kanban (Project + Requirement CRUD + 状态转换 + Activity 时间线) | ✅ 健康 | 持平 |
| Diagnostics (`/v1/diagnostics/*`、`/v1/work/*`) | ✅ 健康 | 持平（06-29 补齐 `/v1/work/quality` 与 `runs/recent.items[].logs` 形状） |
| Harness.health 算法实装 | ✅ 健康 | 持平 |
| Harness.health 信号采集 | ⚠️ 缺 LLM 驱动时无信号 | 持平 |
| Harness.health 前端表达 | ❌ confidence 低分仍直接展示 score | 持平（P0 仍 6 天未修） |
| REST ↔ 数据模型一致性 | ❌ `acceptance_policy / workflow_id / assignee_id / verification_plan` POST + PATCH 双双丢；project_id 无 FK；`depends_on` 跨 id 无 FK；无 `GET /v1/requirements/:id`；`depends_on` 条件性写回；`GET /v1/projects` vs 其他列表的 shape 不一致 | 06-29 在 06-28 基础上多 1 条（projects 列表 shape） |
| 文档 ↔ 运行时一致性 | ⚠️ `roadmap.import` 文档存在但运行时 404；多条 wire shape（health.rules/evidence、signals 完整 20 keys、runs/recent.items[].logs、work/quality 顶层、workspace 非 git 形态、approve/reject 语义、projects instructions trim-aware、skills 503 vs diagnostics/memory 200+flag）未文档化 | 06-29 大幅新增（详 §6 P2 项） |
| 单测覆盖 | ✅ 522/522 全绿 | 持平 |
| 自动化的端到端验证（有 LLM key） | ❌ 本次仍未执行 | 持平 |

**总体判断**：HEAD 在 06-23 → 06-29 六天内没动（工作树侧的 `feat/mobile-ios-ddns` iOS+DDNS 改动仍未 commit），所以 06-28 的所有 P0/P1 结论原样成立。本次实际增量价值集中在**补 wire shape**：
1. **新发现** ①`GET /v1/projects/:id` 工作（与 requirements 的 404 不对称）；②`GET /v1/projects` 是**裸数组**而非 `{items:[]}`（列表路由家族里的特例）；③approve 在 backlog 首次也返 `no_op:true`，reject 对已 approved 行**软删**整行，reject 对 bogus id **404**（与 approve idempotent 路径不一致）；④`POST /v1/projects` instructions 校验是 **trim-aware**；⑤`/v1/observability/health` 顶层有 `rules` 和 `evidence` 两个字段（前 6 报告漏列）；⑥`/v1/diagnostics/runs/recent.items[].logs` 字段存在（06-28 漏列）；⑦`/v1/work/quality` 顶层 4 keys + `verification_pass_rate_by_day` 形状；⑧`/v1/workspace` 在非 git 目录下返 `{root, vcs:"none"}` 而不是 503；⑨`/v1/subagents` `{items:[]}`；⑩`/v1/skills` 未配 catalogue 返 503（与 `/v1/diagnostics/memory` 同样未配返 200+flag 的口径不一致）。
2. **建议**：下一次合 P1 修复时**同时**做：①create+patch 透传 4 字段；②`projectStore.get(projectId)` 校验；③新增 `GET /v1/requirements/:id`（直接镜像 `projects-routes.ts` single-row pattern）；④`depends_on` 跨 id FK 校验；⑤把 health/runs/work/workspace/subagents/skills/diagnostics-memory/requirements/projects 9 条路由的**完整** wire shape 一次性 codify 到 `docs/conventions/` 或 CLAUDE.md——否则第 7 次复测又要重新数字段。
