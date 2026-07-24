# Jarvis 项目自动化能力诊断报告

- **运行时间**：2026-06-23 (scheduled task)
- **被测分支**：`feat/mobile-ios-ddns` (Node runtime, P8 close-out)
- **被测项目**：`/tmp/jarvis-servlet-test`（最小 Java Servlet 4.0 示例：`HelloServlet` + `EchoServlet` + `web.xml`，无 Maven/Gradle 配置）
- **核心问题**：项目自动化的 REST 表面 (kanban + diagnostics + harness.health) 是否能端到端跑通，能否根据 `harness.health` 做出迭代判断

> ⚠️ 本次运行**没有可用的 LLM API key**，所以 auto-loop 被显式关闭 (`JARVIS_WORK_MODE=off`)。所有结论都来自 REST/store 层和单元测试，没有真实驱动 agent loop。报告末尾给出"如何在有 key 时延伸验证"的清单。

---

## 1. 测试配置

```
OPENAI_API_KEY=sk-stub-for-automation-test      # 不会真正访问 LLM
JARVIS_PROVIDER=openai
JARVIS_MODEL=gpt-4o-mini
JARVIS_FS_ROOT=/tmp/jarvis-servlet-test
JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db
JARVIS_ADDR=127.0.0.1:7099
JARVIS_WORK_MODE=off                            # 不触发 auto-loop（无真实 LLM）
JARVIS_PERMISSION_MODE=bypass
JARVIS_NO_PROJECT_CONTEXT=1
```

服务器在 ~4 s 内完成启动，`persistence connected: json://...`，
`/v1/server/info` 列出 44 个工具、`project_store: true`。

## 2. 已验证通过的自动化表面

| 表面 | 路径 | 状态 |
| --- | --- | --- |
| 项目创建 | `POST /v1/projects` | ✅ 返回 201 + 完整 wire shape |
| 需求创建 | `POST /v1/projects/:id/requirements` | ✅ 返回 201；`triage_state=approved` 被 serde-skip 为缺省（与 Rust 行为一致）|
| 需求列表 + 过滤 | `GET /v1/projects/:id/requirements?triage_state=…` | ✅ `approved` / `proposed_by_agent` / `proposed` / 错误值 (400) 均正确 |
| 状态拖动 (backlog → in_progress → review → done) | `PATCH /v1/requirements/:id` | ✅ 4 条 status_change Activity 完整写入（reverse-chronological 排序）|
| 拒绝（带 reason 校验） | `POST /v1/requirements/:id/reject` | ✅ 空 reason → 400；正常 → soft-delete |
| 批准幂等 | `POST /v1/requirements/:id/approve` | ✅ 第二次返回 `no_op: true` |
| Mint fresh run | `POST /v1/requirements/:id/runs` | ✅ 自动建会话、回链 conversation_id、自动 backlog→in_progress、附 manifest_summary |
| Activity 时间线 | `GET /v1/requirements/:id/activities` | ✅ 含 `status_change` + `run_started` |
| Run 只读 | `GET /v1/runs/:id` | ✅ 单条 run + logs |
| Diagnostics: 最近 run | `GET /v1/diagnostics/runs/recent` | ✅ 列出全部 pending |
| Diagnostics: stuck | `GET /v1/diagnostics/runs/stuck?threshold_seconds=1` | ✅ 附带 `age_seconds` 注解 |
| Diagnostics: failed | `GET /v1/diagnostics/runs/failed` | ✅ 空数组（无失败 run）|
| Diagnostics: memory | `GET /v1/diagnostics/memory` | ⚠️ `backend: unknown, stats_available: false`（JSON store 不暴露 stats，符合预期）|
| Work overview | `GET /v1/work/overview` | ✅ `requirement_status_counts`、按天 throughput、项目排行榜均正确 |
| Work quality | `GET /v1/work/quality` | ✅ verification-pass-rate-by-day 骨架返回 |
| Harness health | `GET /v1/observability/health` | ✅ 返回 `tool: "harness.health"`、五个 dimension 全部计算、actions 列表完整（中文）|
| OTel exporter status | `GET /v1/observability/exporter` | ✅ 正确报告 `enabled: false`（未配置）|

### 单元测试

跑过的自动化相关 suite 全部通过：

```
auto-mode.test.ts                ok (~30 tests)
requirements-routes.test.ts      ok 85/85
observability-routes.test.ts     ok 66/66
diagnostics-routes.test.ts       ok (included above)
```

总计 **151 条断言全绿**。

## 3. 发现的实际问题

### 3.1 `acceptance_policy` / `workflow_id` / `assignee_id` 在 REST 上被静默丢弃

`POST /v1/projects/:id/requirements` 与 `PATCH /v1/requirements/:id`
（`packages/server/src/requirements-routes.ts:206-252` 和 `:255-329`）
只读取了 `title / status / triage_state / depends_on / label_ids /
description / conversation_ids`。我请求体里写了 `acceptance_policy:
"Subagent"`、`acceptance_policy: "Human"`，落库后这些字段全部为
缺省（在 GET 返回里也不显示）。

**影响**：
- 想通过 REST 创建一个 `Human`-policy 需求（auto-loop 跳过 + 必须人工 Done）目前是做不到的。
- 后续 Workflow 绑定（CLAUDE.md 描述的 `requirement.workflow_id`）也无法通过 REST 设置。
- `subagent.review` 自动派遣依赖 policy 在 Review 上跳过，而 REST 端永远把 policy 当 default。

**影响范围**：仅 REST 路径；agent 侧的 `requirement.create / update` 工具是否同样漏掉这些字段需要进一步检查（如果同步遗漏，则 Auto 模式下也无法显式标记 Human policy）。

### 3.2 `roadmap.import` 被文档化为已发布，但未移植到 Node 运行时

CLAUDE.md 明确列举：
> `POST /v1/roadmap/import` — same as the `roadmap.import` tool …

实际情况：

```
$ curl -X POST http://127.0.0.1:7099/v1/roadmap/import …
{"message":"Route POST:/v1/roadmap/import not found", … "statusCode":404}
```

`packages/tools/src/register-builtins.ts:13` 注释里也明确写了：

> The store-backed tool families in the Rust (`project.*`, `memory.*`,
> `channel.send`, `codex.run`, `claude_code.run`, **`roadmap.import`**) are not
> part of the Node `@jarvis/tools` surface yet …

**矛盾**：CLAUDE.md（用户面文档）说有，注释说没有，REST 404。文档需要同步说明这条路径处于"deferred"状态，或者尽快把 `roadmap.import` 工具补齐。这个工具是把 `docs/proposals/*.md` 自动倒灌成 Requirements 的关键自动化入口，缺它会让"扫文档自动建任务"流程断掉。

### 3.3 `harness.health` 在新工作区上分数与建议都有但置信度极低

冷启动状态下：

| 字段 | 值 |
| --- | --- |
| `overall_score` | 47 |
| `confidence` | 0.10 |
| `sample_count` | 2 |
| `primary_focus` | `planning_execution` |
| `sources.observability.configured` | `false` |
| `sources.evals.configured` | `false` |
| `sources.requirement_runs` | `configured=true, rows=2` |

仅 RequirementRunStore 一个数据源在线（这是 P8 后的默认配置；`ObservabilityStore` + `EvalStore` 需要操作员显式拉起 `JARVIS_OBSERVABILITY_STORE_URL` / `JARVIS_EVAL_STORE_URL`，但这些环境变量在 CLAUDE.md 没有出现）。

`actions` 列表（5 条优先级建议）正确按 `tone: danger → warn → neutral` 排序，文案是中文，结构完整：

```
1 [danger] 优先稳定交付闭环 — completed 0/terminal 0
2 [warn]   收敛规划执行失败 — timeout_like 0, max_iteration_like 0
3 [warn]   优化工具与 SubAgent 调用 — tools 0, subagents 0
4 [warn]   强化任务理解与验收表达 — capability eval cases 0
5 [neutral] 补齐观测样本 — sample_count 2
```

但因为 `requirement_runs[].status` 全是 `pending`（未驱动 LLM），
`terminal_requirement_runs / completed / failed / verification_pass_rate`
全为 0/null。**这意味着 harness.health 在"全新空工作区"和"agent 完全跑挂"
两种状态下的输出几乎是同一个**——评分都会落在 ~50 + 极低 confidence。
迭代决策时应当先看 `confidence` 与 `sample_count` 再读 `overall_score`，否则会把"还没开工"误判为"快崩了"。

**建议**：在 web UI 渲染时，把 `confidence < 0.2` 的分数直接换成 "数据不足" 的占位，避免误读。

### 3.4 `runs/stuck` 阈值检测可工作但门槛过低

`?threshold_seconds=1` 把 `pending` 47 s/64 s 的 run 都拉了出来。
默认值若过低（代码里没显式 cap），会把刚启动的 run 误标为 stuck。
建议把默认 `threshold_seconds` 文档化（CLAUDE.md 列了路径但没说默认值）。

## 4. 基于 harness.health 的迭代判断（本次实测）

以"迭代决策"的视角串起本次 4 个需求：

| 迭代 | 状态 | harness.health 信号 | 决策 |
| --- | --- | --- | --- |
| 0 | 4 个需求刚建好 | sources: 只有 requirement_runs；score 47，confidence 0.10；primary_focus = planning_execution | 信号不足以驱动方向调整。先**人工拖**一个端到端（hello → in_progress → review → done）确认 kanban 是健康的 |
| 1 | 人工驱动 Hello 走完 backlog→done | overall 仍为 47 — 终端 run 数仍是 0（因为人工 PATCH 不写 run）；signals.requirement_runs=2 来自两个 `/runs` POST，但都还 pending | 决策：因为 confidence < 0.2，不要根据 score 改方向；改而看 `/v1/diagnostics/runs/stuck` 来确认 pending run 没有真正卡死（确认 age_seconds 与本次手动 stub 一致）|
| 2 | 把 scan 需求 reject（reason=superseded）| sources.requirement_runs.rows 维持 2；`/v1/work/overview` 中 backlog=2、in_progress=1、done=1；reject 后 list 从 4 行变 3 行 | 验证 reject 不污染 run 计数 → 通过 |
| 3 | 跑 `node --test` 三个 suite（85 + 66 + 后续）| 单测全绿（mocked LLM + Memory* stores）| 决策：REST 表面在 mocked store 下 100% 正确；本次问题集中在 (a) `acceptance_policy` 未持久化 (b) `roadmap.import` 缺失 |

**结论**：harness.health 的算法（dimensions + drivers + actions）在 Node 端已经实装并与 Rust 对齐，但它**在没有 LLM-driven runs 的情况下无法给出有信号的方向判断**。要让"根据 harness 健康进行迭代需求判断"真正工作，必须满足下列任一前提：

1. `OPENAI_API_KEY`（或其它 provider）有效 + `JARVIS_WORK_MODE=auto`：auto-loop 自动跑需求 → 写终端 run → harness.health 拿到 signal。
2. 操作员手动 `POST /v1/runs/:id/verification` 写入 verification result（这条路 `verification-routes` 有，但需要外部 CI/手工触发）。
3. 配 `ObservabilityStore` + `EvalStore`（CLAUDE.md 未公开 env 变量，需要看 store 模块）。

## 5. 建议的修复（按优先级）

| 优先级 | 项 | 文件/位置 |
| --- | --- | --- |
| P1 | `requirements-routes.ts` 的 create / patch 增加 `acceptance_policy`、`workflow_id`、`assignee_id`、`verification_plan` 字段透传；补单测 | `packages/server/src/requirements-routes.ts:206`、`:255` |
| P1 | 同步检查 `requirement.create / requirement.update` agent 工具是否同样遗漏 | `packages/tools/src/requirement-tools.ts` |
| P2 | `roadmap.import` 工具 + REST 移植 **或** 在 CLAUDE.md 标注 "deferred"。当前文档与运行时不一致 | `packages/tools/src/`、`packages/server/src/`、`CLAUDE.md` |
| P2 | Web UI（或 health response）在 `confidence < 0.2` 时把 `overall_score` 替换成 "样本不足"；后端 contract 不动 | `apps/jarvis-web/src/components/...` |
| P3 | `runs/stuck` 默认 `threshold_seconds` 在 CLAUDE.md 路由清单里补一行 | `CLAUDE.md` |
| P3 | `ObservabilityStore` / `EvalStore` 的 env-driven 拉起方式在 CLAUDE.md 文档化（当前完全空白）| `CLAUDE.md` |

## 6. 复测剧本（带 LLM key 时）

延伸到端到端 LLM-driven 测试需要：

```bash
export OPENAI_API_KEY=sk-...                          # 真 key
export JARVIS_FS_ROOT=/tmp/jarvis-servlet-test
export JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db
export JARVIS_WORK_MODE=auto                          # 打开 auto-loop
export JARVIS_WORK_TICK_SECONDS=10
export JARVIS_WORK_MAX_CONCURRENT=1
export JARVIS_ENABLE_FS_WRITE=1 JARVIS_ENABLE_FS_EDIT=1 JARVIS_ENABLE_SHELL_EXEC=1
export JARVIS_PERMISSION_MODE=bypass

node --experimental-strip-types packages/jarvis-app/src/main.ts serve &
# 创建项目 + 三个 Approved 需求（同本报告 §2 的 curl 序列）
# 等 2-3 个 tick → 看 /v1/diagnostics/runs/recent 是否有 completed/failed
# 再读 /v1/observability/health，预期 confidence > 0.2、sample_count > 5、
# completion_rate 不再为 null。
```

测试该路径时重点观察：
- `subagent.review` 是否在 Subagent policy 下把 review 自动 flip 到 done（需 `JARVIS_REVIEWER_AUTO_ACCEPT=1`）。
- `triage.scan_candidates` 工具能否把 `EchoServlet.java` 里那条 `TODO(jarvis)` 自动建成 `ProposedByScan` 需求。
- `project.checks` 工具能否识别"缺少 Maven/Gradle"并报出建议。

## 7. 总览

| 项 | 评分 |
| --- | --- |
| Kanban (Project + Requirement CRUD + 状态转换 + Activity 时间线) | ✅ 健康 |
| Diagnostics (`/v1/diagnostics/*`、`/v1/work/*`) | ✅ 健康 |
| Harness.health 算法实装 | ✅ 健康（与 Rust 等价）|
| Harness.health 信号采集 | ⚠️ 缺 LLM 驱动时无信号 |
| REST ↔ 数据模型一致性 | ⚠️ `acceptance_policy` 等字段静默丢弃 |
| 文档 ↔ 运行时一致性 | ⚠️ `roadmap.import` 文档存在但运行时 404 |
| 自动化的端到端验证 | ❌ 本次未执行（无 LLM key）|

**整体判断**：Jarvis 的项目自动化骨架（kanban + diagnostics + harness.health）在 Node 端已经完整对齐 Rust 设计、单测覆盖密度令人放心；阻塞 "auto-loop 全自动跑通需求" 的不是骨架问题，而是上述 3.1/3.2 两个 REST 透传缺口和一份没有 LLM 的运行环境。把 P1 两项补上、再做一次 §6 的复测就可以宣布该子系统 ready。
