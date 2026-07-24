# Jarvis 项目自动化能力诊断报告（2026-06-26 三次复测）

- **运行时间**：2026-06-26（scheduled task 自动跑）
- **被测分支**：`feat/mobile-ios-ddns`（HEAD 仍为 `64d288a`，与 06-25 / 06-23 同一 commit，无任何新提交）
- **被测项目**：`/tmp/jarvis-servlet-test`（`HelloServlet` + `EchoServlet` + `web.xml`，仍无 Maven/Gradle）
- **本次目的**：
  1. **回归确认** 06-25 报告里的 P1 / P2 是否在 2 天间被修复（预期：未修，HEAD 未动）
  2. **勘误** 06-25 报告里的两处错记（`/v1/requirements/:id` 直查 + `POST …/runs` 的 wire shape）
  3. **新发现**：从勘误推出的更深一层 orphan-行可观察性缺口
- **运行约束**：与前两次一致——`JARVIS_WORK_MODE=off`、stub LLM key、`JARVIS_PERMISSION_MODE=bypass`

---

## 0. TL;DR — 与 06-25 的差异

| 项 | 06-25 状态 | 06-26 状态 | 变化 |
| --- | --- | --- | --- |
| `git log --since=2026-06-23` | 1 commit | **0 commit**（HEAD 未动） | 平静 |
| 522 条 `@jarvis/server` 单测 | 522/522 ✅ | **522/522 ✅**（duration 7.77 s） | 持平 |
| P1-A `acceptance_policy` / `workflow_id` / `assignee_id` REST 透传 | 仍静默丢弃 | **仍静默丢弃** | ❌ 未修 |
| P1-B `POST /v1/roadmap/import` | 仍 404 | **仍 404** | ❌ 未修 |
| P2 `POST /v1/projects/:bad_id/requirements` orphan 行 | 201 但 `project_id=""` | **201 且 `project_id` 原样写回**（不再被清成空串） | 行为变化，见 §4.1 |
| `harness.health` 在空工作区的 confidence | 0.18 (6 runs) | **0.18 → 0.20**（多了 1 orphan-请求行 → 7 runs） | 算法行为一致 |
| 06-25 §4.1 "可以通过 `/v1/requirements/<row_id>` 直查 orphan 行" | 文档化为 workaround | **勘误：该路由根本不存在**（HTTP 404） | 报告错记 |
| 06-25 §2 "`run_id`" 字段 | 隐式声称 | **勘误：`POST :id/runs` 的 wire shape 是 `{run, conversation_id, manifest_summary, requirement}`，无顶层 `run_id`** | 报告错记 |

`requirements-routes.ts:146-167` 的 `CreateBody` / `UpdateBody` 显式注释仍在，`register-builtins.ts:13` 的"未移植清单"注释也仍在——两个 P1 是**显式 deferred**，不是被遗忘。

## 1. 测试配置（与 06-25 完全一致）

```
OPENAI_API_KEY=sk-stub-for-automation-test
JARVIS_PROVIDER=openai
JARVIS_MODEL=gpt-4o-mini
JARVIS_FS_ROOT=/tmp/jarvis-servlet-test
JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db   # 先 rm -rf 清干净
JARVIS_ADDR=127.0.0.1:7099
JARVIS_WORK_MODE=off
JARVIS_PERMISSION_MODE=bypass
JARVIS_NO_PROJECT_CONTEXT=1
```

启动日志：
```
[jarvis] persistence connected: json:///tmp/jarvis-servlet-test-db
[jarvis] serve: provider=openai model=gpt-4o-mini addr=127.0.0.1:7099 fsRoot=/tmp/jarvis-servlet-test coding=false auth=none ddns=off mdns=off promptBytes=263
[jarvis] listening on http://127.0.0.1:7099
```

`/v1/server/info`：`tools=44`、`project_store=true`、`persistence=json://…`、`approval_mode=bypass`、`max_iterations=80`。

**回归到了 06-25 §1 中漏写的细节**：创建 project 必须带非空 `instructions`（`packages/server/src/projects-routes.ts:215`），否则 400。06-25 报告没记，但实测 06-23 / 06-25 都依赖这一点。

## 2. 9 步迭代轨迹（实测）

| 步 | 操作 | overall_score | confidence | sample_count | req_runs |
| --- | --- | --- | --- | --- | --- |
| 1 | 4 个需求建好（HelloServlet / Maven / EchoServlet / Smoke）| 47 | 0.131 | 3 | 3 |
| 2 | mint run on hello | 47 | 0.152 | 4 | 4 |
| 3 | PATCH hello → in_progress | 47 | 0.152 | 4 | 4 |
| 4 | mint run on echo + maven | 47 | 0.184 | 6 | 6 |
| 5 | PATCH hello → review → done | 47 | 0.184 | 6 | 6 |
| 6 | PATCH echo → in_progress → review → done | 47 | 0.184 | 6 | 6 |
| 7 | `/v1/diagnostics/runs/stuck?threshold_seconds=1` → 3 条 pending（`age_seconds=41/41/42`） | — | — | — | — |
| 8 | `/v1/work/overview` → `requirement_status_counts: {backlog:1, in_progress:1, review:0, done:2}` | — | — | — | — |
| 9 | `POST /v1/roadmap/import` → **HTTP 404** + `PATCH /v1/requirements/:maven {"acceptance_policy":"Human","workflow_id":"wf-test"}` → 200, 但响应里两字段都缺席 | — | — | — | — |

最终 `/v1/observability/health` 切片（7 runs 时——多 1 行来自 orphan-FK 测试）：

```
overall_score=47  confidence=0.197  sample_count=7  primary_focus=planning_execution
sources:        observability (cfg=false rows=0) | evals (cfg=false rows=0) | requirement_runs (cfg=true rows=7)
dimensions:     list len=4  (task_understanding / planning_execution / tool_use / verification — 4，不是 5)
actions:        list len=5  (1 danger + 3 warn + 1 neutral，文案 / 优先级与 06-25 一致)
signals:        terminal/completed/failed/verified = 0/0/0/0；agent/tool/subagent/eval = 0；rates 全 None
```

**迭代判断（与 06-25 一致）**：所有"在 kanban 上拖拽"的操作都会被记成新的 Activity 行，但不会写新的 `RequirementRun`，所以 `confidence` 不动；只有 `POST :id/runs` 会拉动样本数。这印证 06-25 §2 末尾的结论——`confidence < 0.2` 在前端必须折叠为"样本不足"，否则会被 47 + 5 条 danger/warn **完全误导**。

> **06-25 报告勘误 1**：原文说"`dimensions` 是 list len 5"。实测 **len=4**（`task_understanding` / `planning_execution` / `tool_use` / `verification`，无 `responsiveness`）。同时 actions len=5 — `dimensions` ≠ `actions`，前者衡量"做得怎么样"、后者是行动建议，长度不必相等。

## 3. P1 项回归（仍未修）

### 3.1 `acceptance_policy` / `workflow_id` REST 透传 — 仍丢

```
PATCH /v1/requirements/<maven_id>
  body: {"acceptance_policy":"Human","workflow_id":"wf-test"}
→ 200 OK，响应体里这两字段 **缺席**
```

`packages/server/src/requirements-routes.ts:147-167` 的 `CreateBody` / `UpdateBody` interface 仍只列 `title / description / status / conversation_ids / triage_state / depends_on / label_ids`，注释明确写 `verification_plan / workflow_id` 出 scope，`acceptance_policy` 连注释都没（但 `:439` 在 `/runs` POST 里会读 `item.acceptance_policy ?? "subagent"` 用于阻断 Human policy 自动 mint）——**写不进 = Human policy 永远拿不到** 死循环仍成立。

### 3.2 `roadmap.import` — 仍 404

```
POST /v1/roadmap/import → 404 {"message":"Route POST:/v1/roadmap/import not found"}
```

`packages/tools/src/register-builtins.ts:13` 仍保留"`roadmap.import` 不在 Node `@jarvis/tools` surface"的明确注释。**CLAUDE.md 与运行时仍不一致**——CLAUDE.md `/v1/roadmap/import` ✅ 那行需要 `(deferred)` 标记。

## 4. 06-25 报告的两处勘误 + 由此推出的新发现

### 4.1 **没有 `GET /v1/requirements/:id`**（06-25 §4.1 错记）

`grep -nE "app\.(get|post|patch|delete).*requirements" packages/server/src/requirements-routes.ts` 列全 17 个路由（`:175`、`:206`、`:255`、`:332`、`:346`、`:380`、`:423`、`:458`、`:547`、`:560`、`:588`、`:601`、`:659`、`:693`、`:752`、`:777`），**没有任何一条**是 `GET /v1/requirements/:id`。06-25 §4.1 提到的"只能通过 `/v1/requirements/<row_id>` 直查"是**根本不存在的路径**——实测 404。

orphan 行实测（这次 `project_id` 也**不再清成空串**了，是按请求路径里的 bogus id 落库）：

```
POST /v1/projects/no-such-project-id/requirements  body={"title":"orphan-test","triage_state":"approved"}
→ 201 {"id":"...","project_id":"no-such-project-id", ...}
```

**真正影响**（比 06-25 §4.1 严重）：因为唯一的"按 id 单查"路径就是把这个 bogus project id 再回灌进 `/v1/projects/no-such-project-id/requirements`——**任何不知道这个魔术 id 的客户端都无法发现这一行**；project store 里这个 `no-such-project-id` 又不存在，UI 也不会枚举它。等于 orphan 行**只能靠扫 JSON store 文件本身才能发现**。

**建议合并 06-25 P2**：
- `packages/server/src/requirements-routes.ts:206` 的 POST handler 先 `store.getProject?(projectId)` / `projectStore.get(projectId)`，不存在 → 404。
- 同时给 `:255` PATCH 加同一校验。
- 顺手补上 `GET /v1/requirements/:id`（直接 `store.get(id)`，404 兜底）——客户端有了它，diagnostic + UI deep-link 都会简单很多。

### 4.2 **`POST /v1/requirements/:id/runs` 的 wire shape**（06-25 §2 隐式错记）

实测：
```jsonc
{
  "run":               { "id": "<uuid>", "requirement_id": "...", "conversation_id": "...",
                         "status": "pending", "started_at": "...", "logs": [...] },
  "conversation_id":   "<uuid>",
  "manifest_summary":  "...",
  "requirement":       { ...full requirement after status flip... }
}
```

没有顶层 `run_id` 字段。06-25 §2 表格里那一列 `mint run …→ run_id` 看着像存在，其实任何前端要取 run id 都得读 `run.id`。

**建议**：写到 CLAUDE.md 路由清单或 `docs/conventions/`——和 4.3 一起把 `harness.health` / `runs` 系列的 wire shape 一次性 codify。

### 4.3 06-25 §2 / §4.3 已勘误的部分 — 复测仍成立

- `/v1/observability/health` 顶层 `dimensions` 是 **list**，长度 4。
- `signals.requirement_runs` 是 **int 计数**（这次值 = 7）。
- `sources.*` 是 `{configured, rows}` 对象（不是 signals 的子结构）。
- `/v1/diagnostics/runs/stuck` 返回 `{items: [...]}`，每条带 `age_seconds`。
- `/v1/work/overview` 的 `throughput_by_day` 是按 `as_of` 倒推 7 天的窗口数组，今天那行 `runs_started=7 runs_completed=0 runs_failed=0 requirements_completed=2`——**与 kanban PATCH 同步**。

## 5. 单测健康

```
$ pnpm --filter @jarvis/server test
...
# tests 522
# pass 522
# fail 0
# duration_ms 7774.338459
```

522/522 全绿，与 06-25 完全一致。

## 6. 合并建议优先级（06-23 → 06-25 → 06-26）

| 优先级 | 项 | 文件/位置 | 累计状态 |
| --- | --- | --- | --- |
| **P0** | Web UI 在 `confidence < 0.2` 时把 `overall_score` 替换成"样本不足"——cold-start 与全面崩盘的同 score 必须前端兜底 | `apps/jarvis-web/src/components/Observability/...` | 06-25 抬升，**未修** |
| P1 | `requirements-routes.ts` create/patch 增加 `acceptance_policy` / `workflow_id` / `assignee_id` / `verification_plan` 透传 + 单测；同步 `requirement.create` 工具 | `:147-167`、`:206`、`:255` + `packages/tools/src/requirement-tools.ts` | 06-23 提出，**未修** |
| P1 | `roadmap.import` 工具 + REST 移植；或在 CLAUDE.md 显式标记 deferred | `packages/tools/src/`、`CLAUDE.md` | 06-23 提出，**未修** |
| **P1（合并升级）** | requirements create/patch 加 project_id 存在性校验 → 404；**同时新增 `GET /v1/requirements/:id`**（直接 `store.get(id)`）。两件事一起做才能完整修掉 orphan 行的不可观察性 | `:206`、`:255`，新增 `:?` | 06-25 P2 → 06-26 升级 |
| P2 | `/v1/observability/health` / `runs/*` / `/v1/requirements/:id/runs` 等 wire shape 文档化（`dimensions: list len=4`、`signals.* int`、`sources.* {configured, rows}`、`runs/:id mint` 返回 `{run, conversation_id, manifest_summary, requirement}` 无顶层 `run_id`） | `docs/conventions/` 或 CLAUDE.md | 06-23 漏记，06-26 补全 |
| P3 | `runs/stuck` 默认 `threshold_seconds` 在 CLAUDE.md 路由清单里补一行；统一所有 diagnostics 路由都返回 `items[]` 的 contract 说明 | `CLAUDE.md` | 06-23 提出，未修 |
| P3 | `ObservabilityStore` / `EvalStore` 的 env-driven 拉起方式在 CLAUDE.md 文档化 | `CLAUDE.md` | 06-23 提出，未修 |
| P3 | `POST /v1/projects` 必填 `instructions` 在 CLAUDE.md / 路由清单里显式注明（任何 SDK 客户端冷启动都会被 400 卡住） | `CLAUDE.md` 项目段 | 06-26 新增 |

## 7. 复测剧本（有 LLM key 时；与 06-25 §7 一致）

```bash
export OPENAI_API_KEY=sk-...
export JARVIS_FS_ROOT=/tmp/jarvis-servlet-test
export JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db
export JARVIS_WORK_MODE=auto
export JARVIS_WORK_TICK_SECONDS=10
export JARVIS_WORK_MAX_CONCURRENT=1
export JARVIS_ENABLE_FS_WRITE=1 JARVIS_ENABLE_FS_EDIT=1 JARVIS_ENABLE_SHELL_EXEC=1
export JARVIS_PERMISSION_MODE=bypass
node --experimental-strip-types packages/jarvis-app/src/main.ts serve &
# 同 §2 的 9 步 → 等 2-3 个 tick →
#   /v1/diagnostics/runs/recent 应出现 completed/failed；
#   /v1/observability/health 应 confidence>0.2 + completion_rate 非 null。
```

未验证项（继续滚到下一次）：

- `subagent.review` 在 `Subagent` policy 下是否真把 review→done flip（需 `JARVIS_REVIEWER_AUTO_ACCEPT=1`）。
- `triage.scan_candidates` 能否把 `EchoServlet.java:8` 的 `TODO(jarvis): support POST body echo with content-length cap` 自动建成 `ProposedByScan` 需求。
- `project.checks` 能否识别"缺少 Maven/Gradle"并建议 `mvn archetype:generate` 或 `gradle init`。

## 8. 总览

| 项 | 评分 | 与 06-25 比 |
| --- | --- | --- |
| Kanban (Project + Requirement CRUD + 状态转换 + Activity 时间线) | ✅ 健康 | 持平 |
| Diagnostics (`/v1/diagnostics/*`、`/v1/work/*`) | ✅ 健康 | 持平 |
| Harness.health 算法实装 | ✅ 健康 | 持平 |
| Harness.health 信号采集 | ⚠️ 缺 LLM 驱动时无信号 | 持平 |
| Harness.health 前端表达 | ❌ confidence 低分仍直接展示 score | 持平（P0 仍未修） |
| REST ↔ 数据模型一致性 | ⚠️ `acceptance_policy` / `workflow_id` 丢；project_id 无 FK；**无 `GET /v1/requirements/:id`** | 06-26 在 06-25 基础上**再发现一个缺口** |
| 文档 ↔ 运行时一致性 | ⚠️ `roadmap.import` 文档存在但运行时 404；health/runs wire shape 无文档 | 持平 |
| 单测覆盖 | ✅ 522/522 全绿 | 持平 |
| 自动化的端到端验证（有 LLM key） | ❌ 本次仍未执行 | 持平 |

**总体判断**：HEAD 在 06-23 → 06-26 三天内没动，所以 06-25 的所有结论原样成立；本次的实际增量价值是**勘误 06-25 §4.1 / §2 的两处错记**，并由勘误顺出一个比"orphan 行有空 project_id"更严重的可观察性缺口——orphan 行**根本不能按 id 单查**，连诊断 fall-back 路径都不存在。建议把 06-25 的 P2（FK 校验）和"新增 `GET /v1/requirements/:id`"合并成一个 P1 一起修；否则前端 deep-link / 客户端 retry 任何要"按 id 取 requirement"的场景都还得绕路 `/v1/projects/:project_id/requirements` 整表过滤。
