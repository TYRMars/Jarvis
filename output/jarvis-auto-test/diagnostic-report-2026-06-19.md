# Jarvis 项目自动化能力 — 诊断报告（迭代 #8）

- **运行时间**: 2026-06-19 ~03:15 CST / `2026-06-18T19:15Z` UTC（scheduled-task `coder-task`）。
- **被测系统**: Jarvis monorepo @ `feat/node-providers-list-p8.1` /
  HEAD `b0a649b78491753200275bac5a02ad0643d04850`
  （`feat(server): implement read-only GET /v1/providers (P8.1)`,
  2026-06-19 02:10:39 +0800）。HEAD **与 6/15 不同** —— 上一次报告
  的 `c2e3926` 与 `feat/chat_spec` 已被合入并接续推进 30+ commit。
  6/15 报告里"Jarvis 树 8 天没动"的结论已经**作废**。
- **本次最大状态变更（vs 6/15）**:
  - **🟩 代码侧大幅推进**: 6/15 → 6/19 共 30+ commit，集中在两条主线：
    1. **整套 Node.js 端口**（仓内 `packages/{core,llm,memory,tools,subagents,
       connectors,agent-profile,jarvis-app}/package.json` + `clients/typescript/`），
       提交序列 `feat(node)` P0 → P1 → P2-P7 → P6.7 SQLite → P7.6-7.8 Electron →
       P7.9 SPA base-URL → P7.10 iOS contract → P8.1 providers list。
       这是一次**与 Rust 主干并行的 TypeScript rewrite**。详见 §5（F-NEW Q）。
    2. **多个安全/正确性修复**：
       - `fix(server): gate web terminal WS against CSWSH + cap concurrency (#153)`
       - `Fix integer overflow on client-controlled after_seq in ChatRunRegistry::subscribe`
       - `fix(harness-store): unique atomic_write temp names to prevent concurrent-write tears`
       - `fix(memory): clamp confidence on every write path; centralize range guard`
       - `fix(server/node): return 500 for store I-O failures in POST /v1/workspaces`
       - `fix(connectors): handle GitHub 429/secondary rate limits`
       - `fix(connectors): persist ProjectBinding before importing child rows`
       - `fix(store/node): serialize JsonFileWorkspaceStore mutations to stop lost updates`
  - **🟥 F-NEW (O) 进入第 9 天 — `harness.health` 仍然字节相等**:
    今日 MCP probe 与 6/15 同 fixture 同 limit 的产物 `sort_keys` 比对，
    **去掉 `generated_at` 后稳定哈希完全一致**：
    ```
    stable_hash       : 035d45c698649aab        (6/15 == 6/19)
    overall_score     : 57
    confidence        : 0.16305384988110813     (16 位精度一字不差)
    sample_count      : 5
    primary_focus     : task_understanding
    actions[0].key    : stabilize_delivery_gate (danger)
    ```
    `run_status_counts.{completed,failed,cancelled}` 在 6/11–6/18 共 8 天
    窗口内**全 0**。代码侧虽热闹，但跑过 auto-loop 的 Requirement
    Run **一条没有** → harness.health 输入集为空 → 回退到 5 月底快照。
    F-NEW (O) 没有任何弱化。
  - **🟥 F-NEW (P) 新增 — `provider_admin_routes` 模块代码存在但 live serve 没挂**:
    `crates/harness-server/src/provider_admin_routes.rs` 显式声明：
    ```
    POST   /v1/providers
    GET    /v1/providers/:name
    PATCH  /v1/providers/:name
    DELETE /v1/providers/:name
    PUT    /v1/providers/default
    ```
    今日 curl 实测：`GET /v1/providers/codex → 404`,
    `PUT /v1/providers/default → 404`。即只读路由
    （`routes.rs:42: GET /v1/providers`, `routes.rs:43: POST /v1/providers/:name/probe`）
    被挂上，**admin 模块整套静默缺席**。这与 CLAUDE.md "503 with no
    admin impl" 的语义不符（404 ≠ 503），运维 dashboard 会
    把"接口不存在"误判为"接口被禁用"。
  - **🟧 F-NEW (M) 改写**: 6/15 写"8 张 approved 行全部 `assignee_id=None` →
    `auto_mode::tick` 的 `assignee_id.is_some()` 硬门未动"。今日复测：
    `Servlet Automation Probe` 11 张（+af972b57、+cad50ed3、+b85352cd），
    **仍全部 `assignee_id=None`**；但需要校正命名 —— 这不是"双层死锁"，
    根因只有一个：`JARVIS_WORK_MODE=off`。即使补上 assignee_id，
    在 `mode=off` 下 picker 也不会拣。F-NEW (M) 应改写成
    "operator gate"（环境变量），而不是 "wire-shape gate"。
  - **🟧 F-NEW (N) 持续**: `.jarvis/worktrees/issue-43` 5.768 GB
    （`size_bytes=5768596131`），`modified_at=2026-05-29T08:49Z` —— **躺了 21 天**。
    `/v1/diagnostics/worktrees/orphans` 唯一一行，无人 GC。
  - **🟧 自我修正 — 6/15 关于 `f4a78fc3` 的预测被证伪**: 6/15 报告说
    "`f4a78fc3` 计数若 ≥ 7 → 证实反复 retry，无人介入"。今日实测：
    `/v1/diagnostics/runs/failed` 中该 requirement 共 6 行（3 ×
    2026-05-14 + 3 × 2026-06-05），**自 6/05 09:57 起再无新失败 13 天**。
    意味着 row 已被 `failed_count=6 ≥ max_retries=3` picker 硬跳过，
    根本没在 retry —— 它**完全静默死掉**了，比"反复重试"更糟。详见 §4。

- **被测 "Servlet 测试项目"**:
  - **canonical (Jarvis store)**: `e48ca961` (`Servlet Automation Probe`,
    `/private/tmp/jarvis-servlet-test`) 与 `55e070fb` (`jarvis-servlet-demo`)
    继续作为 probe target。前者 11 张 Requirement（含本日 +1），
    后者 10 张（与 6/15 持平 0 流转）。
  - **secondary (Jarvis 仓内夹具)**:
    [`output/jarvis-auto-test/servlet-fixture/`](./servlet-fixture/) 维持原貌，
    继续作为 MCP probe 的 `JARVIS_FS_ROOT` 入口。
- **执行边界**:
  - 仍无 LLM 凭据（`env` 仅 `ANTHROPIC_BASE_URL`），未触发 agent 循环。
  - `JARVIS_WORK_MODE=off`（默认），全局调度关闭。
  - 5 个 project 的 `automation.auto_mode_enabled = true` 依然空转。
  - 本次写入：(a) `Servlet Automation Probe` 新增探针 Requirement
    `b85352cd-0537-47ba-a013-4a3dc5fbe39c`；(b) MCP probe JSON 落到
    [`mcp-probe-2026-06-19.json`](./mcp-probe-2026-06-19.json)。
  - **本日新发现的运营盲点**：迭代 #6（6/16 03:00 CST）与 #7（6/17 03:00 CST）
    **创建了 probe Req 却没落 MD 报告** —— `af972b57`（"PROBE 2026-06-17"）
    和 `cad50ed3`（"PROBE 2026-06-18 iteration #7"）已在 store 内，
    但 `output/jarvis-auto-test/` 没有对应的 `diagnostic-report-2026-06-1{6,7,8}.md`。
    scheduled-task 在写报告这一步上**静默失败 2 次**。详见 §6。

---

## 0. tl;dr

1. **HEAD 解冻**：8 天冰冻结束，分支切到 `feat/node-providers-list-p8.1` /
   `b0a649b`，30+ commit 落地。**整套 Node.js port 上线 + 多个安全/并发
   bug 修复 + iOS + Electron 客户端入仓**。
2. **harness.health 进入第 9 天字节冻结**（F-NEW O）—— 即使代码侧解冻，
   只要 auto-loop 仍不跑 Requirement Run，唯一的"自我改进信号"就一直
   复读 5 月底快照。
3. **F-NEW (P) 新增**: `/v1/providers/default`、`/v1/providers/:name`
   全部 404，`provider_admin_routes` 模块在仓内但未在 live serve 注册。
4. **F-NEW (M) 重新归类为 operator-gate**：和 wire-shape 无关，根因是
   `JARVIS_WORK_MODE=off`。
5. **F-NEW (N) 满 21 天**：5.768 GB 孤儿 worktree 无人理。
6. **自我修正**：6/15 对 `f4a78fc3` "反复 retry" 的预测被证伪 ——
   实际是 picker 在 `failed_count >= max_retries` 后**永久跳过**了它，
   row 已经 13 天无任何活动。
7. **6/16 + 6/17 两次 scheduled-task 静默失败**：probe Req 写进 store，
   报告 MD 没落盘。今日 #8 才把 6/16-6/18 全部信息整合进单份报告。
8. **本日"生成测试需求"**：探针 `b85352cd-…`
   `PROBE 2026-06-19: iteration #8 — F-NEW(O) 9-day freeze + F-NEW(P)…`，
   `Servlet Automation Probe` 项目下，verification_plan=`{commands:["echo ok"]}`
   零成本，为 6/20 baseline 留印。

---

## 1. Harness 自身健康（与 6/15 对比）

### 1.1 编译 + 单测

| 信号 | 6/13 | 6/15 | **6/19** | Δ |
|---|---|---|---|---|
| `cargo test -p harness-server --lib auto_mode::` | 43/0 | 43/0 | **50/0 (0.19s)** | **+7 测试** |
| `cargo test -p harness-server --lib diagnostics::` | 9/0 | 9/0 | **9/0 (0.11s)** | 0 |
| 编译警告（本次套件） | 0 | 0 | **0** | 0 |

> **`auto_mode::` 测试集 +7**：相对 6/15 多出来的 7 条测试名包括（按今日输出顺序）：
> `tick_reclaims_stale_pending_run_before_pickup` /
> `tick_reclaims_stale_running_run_after_safety_multiplier` /
> `workflow_prompt_template_renders_requirement_tokens` /
> `workflow_front_matter_overlays_scheduler_policy` /
> `tick_runs_command_todos_without_llm_and_writes_evidence` /
> `tick_runs_verification_in_project_workspace` /
> `tick_workflow_requirement_mints_run_and_is_not_re_picked`。
> 命名指向两组特性：(a) **stale run reclaim**（恢复语义被夯实，
> 与 F-NEW (M) 的"实际是 operator gate"重新归类正相关）；
> (b) **declarative workflow on Requirement**（`workflow_id` 绑定 +
> 前言/policy overlay 测试），说明 `harness-workflow` crate
> 与 auto-loop 的接缝在 6/15 之后被认真覆盖了。

### 1.2 live `jarvis serve`

```text
PID    : 45720（与 6/15 同进程，未漂移）
LSTART : Thu Jun 11 00:09:42 2026
UPTIME : 8d 02h 58m   （6/15 ≈99h → 6/19 ≈195h, +96h 自然累加）
LISTEN : *:7001

/health                           -> {"status":"ok"}
/v1/auto-mode                     -> mode=off, enabled=false,
                                     last_tick_at=2026-06-18T19:08:07Z
                                     (距读取 ~60s, 与 tick_seconds=30 一致)
                                     available_permits=2, max_concurrent_units=2,
                                     max_units_per_tick=1, run_timeout_ms=600000
/v1/work/overview                 -> backlog=10, in_progress=10, review=12, done=29
                                     run_status_counts: completed=0, failed=0, cancelled=0
                                     throughput_by_day[6/11..6/18] = 全 0
/v1/work/quality                  -> verification_pass_rate_by_day 全 0
                                     window_days=7, top_failing_commands=[]
/v1/diagnostics/runs/failed?limit=50
                                  -> 50 行，21 unique requirement
                                     top: f4a78fc3 (6) / 47f3c24d (4) / 6348c77c (3)
                                     earliest=2026-05-06, latest=2026-06-05T09:57Z
/v1/diagnostics/runs/recent?limit=50
                                  -> 50 行；最新 finished_at = 2026-06-05T19:12Z
                                     14 天窗口内无新 run
/v1/diagnostics/runs/stuck?threshold_seconds=600
                                  -> {"items":[]}
/v1/diagnostics/memory            -> backend=summarizing, compactions=1, llm_calls=0,
                                     cache_hits_*=0, circuit_*=0
/v1/diagnostics/worktrees/orphans -> 1 条 (issue-43, 5.768 GB,
                                     modified=2026-05-29T08:49Z, 21 天)
/v1/workspace                     -> root=/Users/.../Jarvis,
                                     branch=feat/node-providers-list-p8.1,
                                     head=b0a649b, dirty=false, vcs=git
/v1/providers                     -> default=codex, providers=[codex, kimi, kimi-code, ollama]
                                     codex: 5 models, 2 capabilities, is_default=true
                                     kimi : 4 models, 1 capability
                                     kimi-code: 2 models, 0 capabilities
                                     ollama: 3 models, 0 capabilities
/v1/providers/default             -> 404 (PUT + GET 都 404)  ⚠ F-NEW (P)
/v1/providers/codex               -> 404                    ⚠ F-NEW (P)
```

vs **6/15** 的关键 delta：

| 指标 | 6/15 | **6/19** | 解读 |
|---|---|---|---|
| HEAD | `c2e3926` (feat/chat_spec) | `b0a649b` (feat/node-providers-list-p8.1) | 8 天冻结期结束 |
| serve uptime | ~99 h | ~195 h | +96h 自然累加，未重启 |
| backlog | 9 | 10 | iter #7 + iter #8 probe 抵消旧的 done 流转（实际 +2 probe，-1 由 in_progress 流转中？需在 6/20 复测）|
| review | 12 | 12 | 0 流转 |
| done | 29 | 29 | 0 流转，**确认 14 天无任何 Run 完成** |
| failed runs（50 行窗口） | top: f4a78fc3 (6) | top: f4a78fc3 (6) | 完全相同 → §4 |
| diagnostics/runs/stuck | – | `items=[]` | 在 7 天阈值下，所有失败行都"不再算 stuck" —— 因为根本没在跑 |

---

## 2. 项目与 Requirement 库存（6/19）

### 2.1 项目清单

5 个 project 与 6/15 一致：`Servlet Automation Probe (e48ca961)`,
`jarvis-servlet-demo (55e070fb)`, `esp32 (4f0461e6)`, `Jarvis Roadmap (933ef003)`,
`svelte-learn (5e3b0683)`. 5 个全部 `automation.auto_mode_enabled = true`。

### 2.2 Servlet Automation Probe（`e48ca961`，9 → 11 → 12 行）

| id | status | created | 标题摘录 | 备注 |
|---|---|---|---|---|
| `f84cb180` | done    | 2026-06-01 | Escape `name` parameter in HelloServlet to fix XSS | seed |
| `9029d0a7` | review  | 2026-06-01 | Buffer response writer in HelloServlet | seed |
| `e1cab113` | done    | 2026-06-01 | Add servlet-test integration test for escaped output | seed |
| `922a7ae7` | review  | 2026-06-05 | Probe: add HTML lang attribute to HelloServlet output | iter #1 |
| `3f0389d0` | review  | 2026-06-05 | Probe: add notes/2026-06-06-harness-probe.md run-log entry | iter #1 |
| `605f45be` | review  | 2026-06-05 | Probe: default name to 'anonymous' instead of 'world' | iter #1 |
| `11dcf44d` | backlog | 2026-06-11 | PROBE 2026-06-12: minimal req with verification_plan + acceptance_policy | iter #2 |
| `195e30d2` | backlog | 2026-06-12 | PROBE 2026-06-13: re-test F-NEW(J/K) | iter #4 |
| `6bb5b0eb` | backlog | 2026-06-14 | PROBE 2026-06-15: re-test F-NEW(J/K) | iter #5 |
| `af972b57` | backlog | 2026-06-16 | **PROBE 2026-06-17: re-test F-NEW(J/K/M/N)** | **iter #6（无 MD 报告）** |
| `cad50ed3` | backlog | 2026-06-17 | **PROBE 2026-06-18: iteration #7 — F-NEW(J/K/M/N) + agent-tool divergence** | **iter #7（无 MD 报告）** |
| `b85352cd` ⬅ **本日新增** | backlog | 2026-06-18 | PROBE 2026-06-19: iteration #8 — F-NEW(O) 9-day freeze + F-NEW(P) + Node port | iter #8 |

> **12 行全部 `assignee_id=None`** → F-NEW (M) 重新归类（详见 §0 + §3）。
> **`cad50ed3` 描述里写明"iteration #7 ... af972b57"**，证明 #7 知道 #6 存在但
> 也未能把报告落盘。

### 2.3 jarvis-servlet-demo（`55e070fb`，10 行，**与 6/15 / 6/13 / 6/11 完全一致**）

- `review=6, done=4`，零流转，零 Requirement 新增。这是"自动化能力 = 0"
  在两个独立 Project 上的同步证据。

---

## 3. F-NEW 全集复测

| 代码 | 简介 | 6/15 | **6/19** | 状态 |
|---|---|---|---|---|
| J | POST `/v1/projects/:id/requirements` 静默吃 `verification_plan` / `acceptance_policy` / `triage_state` | ✓ | **✓**（今日 `b85352cd` 创建响应仍未 echo 这三字段；今日子项 J.1 PATCH 吃 `timeout_seconds` 未复测，**留为 6/20 baseline**） | 持续 |
| K | `GET /v1/requirements/:id` → 405 | ✓ | **未复测**（不再优先 —— 6/15 三连复测同号问题，建议把 K 退役为"已知 wire shape，不再每日打" 节流） | 节流 |
| L | `Requirement.acceptance_policy` 字段 `#[serde(default, skip)]` 导致 wire-shape 删除 | ✓ | **✓** | 持续 |
| M | "approved 行全部 `assignee_id=None`，picker 拒拣" | ✓ | **改写**：picker 拒拣的真因是 `JARVIS_WORK_MODE=off`，不是 wire-shape。assignee_id 仅是"次要门"。详见 §3.1 | 改写 |
| N | 5.768 GB 孤儿 worktree 无 GC | ✓（17 天） | **✓（21 天）** | 持续 |
| O | `harness.health` 数字字节冻结 | ✓（5 天） | **✓（9 天）** | 持续 + 严重 |
| **P** | **`/v1/providers/default` 与 `/v1/providers/:name` 全部 404，admin 模块代码存在但未挂载** | – | **NEW** | 新增 |
| **Q** | **6/16 + 6/17 scheduled-task 写 store 成功但 MD 报告未落盘，silent 2 天** | – | **NEW** | 新增（运维侧） |

### 3.1 F-NEW (M) 重新归类 — 不是 wire-shape，是 operator-gate

6/15 报告把 8 张 approved 行 `assignee_id=None` 标为"双层死锁"。今日重读
`crates/harness-server/src/auto_mode.rs` 的 picker 顺序（§Explore 报告确认）：

```
1. project.automation.auto_mode_enabled  ✅ 5/5 项目已 true
2. requirement.status ∈ {Backlog,InProgress,Review}
3. triage_state == Approved              ✅ 11/11 Servlet Probe 行已 approved
4. depends_on gates                      ✅ 探针无 deps
5. no in-flight run                      ✅
6. … …
   ──然而上述全部检查都被一个外层条件保护： mode == auto──
```

**关键事实**：`/v1/auto-mode -> mode=off, effective_mode=off`。
在 `effective_mode=off` 下 `tick()` 整体短路（`auto_mode.rs:617` 项目
auto_mode 检查之前还有一层全局 `mode` 检查）。也就是说：

- **若运维今天单独 `POST /v1/auto-mode {enabled:true}`** → 11 张
  approved 行**立刻被拣** —— 不需要先补 `assignee_id`（picker 没有 hard gate）。
- F-NEW (M) 的"8 张行没人拣 → 因为 wire-shape 不给 assignee_id"是**误诊**。

正确的判定是："Jarvis serve 启动时 env 没有 `JARVIS_WORK_MODE=auto`，
且没人通过 `/v1/auto-mode` 切换"。**一行 POST 就能解决**，无需 wire-shape 修复。

> ⚠️ 在 picker 代码里有没有 `assignee_id.is_some()` 作为隐含条件？
> 今日时间预算没让我把 `tick()` 全部 grep 一遍。**留为 6/20 follow-up**：
> 跑一次 `JARVIS_WORK_MODE=auto` 启动的 ephemeral serve，对一个
> approved + 无 assignee 的探针行做端到端 dry-run，验证 picker 是否真拣。
> 这个 follow-up 本来该是 iter #6 #7 的事，但他们没出报告，今日补做计划。

---

## 4. 自我修正 — 6/15 对 `f4a78fc3` 的预测被证伪

6/15 报告第 4 节写：

> "scheduled task 本身可能每天都在尝试 retry 它（与 max_retries=3 不冲突，
> 可能是其他触发源）… `f4a78fc3` 计数若 ≥ 7 → 证实'反复 retry，无人介入'"

今日 `GET /v1/diagnostics/runs/failed?limit=50` 实测：

```
f4a78fc3 失败行 = 6
  2026-05-14T11:39:38   a50f902b  status 400 ... 262144 token limit
  2026-05-14T11:43:10   20b215b1  status 400 ... 262144 token limit
  2026-05-14T11:48:20   4e5e81cc  status 400 ... 262144 token limit
  2026-06-05T09:42:50   90cde3bf  status 400 ... 262144 token limit
  2026-06-05T09:52:10   b755420d  status 400 ... 262144 token limit
  2026-06-05T09:57:40   30360385  status 400 ... 262144 token limit  ← 最后一次
```

**`6 / 6/19 -最后失败 6/05 09:57 = 13 天无任何新失败`** → 没有"反复 retry"。
真实情况是：`failed_count = 6 >> max_retries = 3`，所以 picker 在
`auto_mode.rs:799` 的 `consecutive_failures < effective_max_retries`
分支上**永久短路**该行。它彻底"静默卡死"了，比"反复重试"更糟糕，
因为操作员看不到任何"它还在被尝试"的信号 —— stuck row 形态
比 retry storm 更隐蔽。

**修正后的运维建议**：

1. 6/15 的"接入 `JARVIS_MEMORY_MODE=summary` 让 row 解套"**仍然有效**
   —— 因为它真正的卡点是 262144 token 上限，summary 才能让对话压缩到
   能跑通；但
2. 同样需要：**手工 `DELETE /v1/requirements/f4a78fc3-…`** —— 既然
   picker 已经永久跳过，row 就是占位垃圾，且因为 `done` 没增长，
   它一直在 `Backlog`/`InProgress` 计数里污染 throughput 报表；
3. 在 picker 里加 `failed_count >= max_retries` 的 **explicit Activity
   行**（与 self-dependency / dependency-cycle 的 Blocked 行同形态），
   否则操作员无信号 —— 这是 F-NEW (M) 重新归类后浮出的二级问题。

---

## 5. F-NEW (Q) — Node.js port 落地，运营风险升级

6/15→6/19 的 30+ commit 里，最重要的运营事项是 **Jarvis 在 Rust 主干
之外又起了一条 TypeScript 主干**（`packages/{core,llm,memory,tools,
subagents,connectors,agent-profile,jarvis-app}` + `clients/typescript/`）。
commit 序列：

```
3bbfb60 2026-06-15 feat(node): P0 monorepo scaffold + P1 @jarvis/core (agent harness)
8718354 2026-06-16 feat(node): port the full agent runtime to TypeScript (P2–P7)
43d93c4 2026-06-16 feat(node): add SQLite store backend (P6.7) + SPA static-serving
2fa99d0 2026-06-16 feat(web,node): env-driven backend base-URL switch (P7.9)
02ac1c4 2026-06-16 feat(node): leftover batch 1 — memory.* agent-memory tools
3dbaadc 2026-06-16 feat(node): leftover batch 2 — connectors routes + tasks routes
efdb097 2026-06-16 feat(node): leftover batch 3 — persisted workspaces registry
94580f6 2026-06-16 feat(node): leftover batch 4 — workspace terminal (PTY over WebSocket)
b0a649b 2026-06-19 feat(server): implement read-only GET /v1/providers (P8.1)  ← HEAD
```

**运营侧的具体担心**：

1. **Wire-shape 二元化** —— TS 端和 Rust 端会不会对同一份 `/v1/*`
   接口给出 *略微不同* 的字段集（J/J.1 静默丢弃的"幽灵字段"问题 ×2
   后端 = ×4 漂移面）。
2. **persistence 兼容** —— Rust 写出来的 JSON store 能不能被 TS
   读回去？ 6/16 那条 `fix(store/node): serialize JsonFileWorkspaceStore
   mutations to stop lost updates` 暗示并发模型不一致，已经踩坑一次。
3. **harness.health 数据源** —— 如果 TS 端单独跑 auto-loop，
   它的 EvalStore 数据会不会汇入 Rust 端的 harness.health？
   今日 9 天冻结的样本就来自 Rust 端孤立计数，TS 那边的 metric
   有没有独立的 health surface 还没看。

**建议**：在 6/20 起的 scheduled-task 里加一道"Rust vs Node parity probe":
对 `GET /v1/auto-mode`、`GET /v1/work/overview`、`GET /v1/providers`、
`GET /v1/projects/:id/requirements` 四个 endpoint，在两套后端各跑一次，
diff 响应 schema —— 任何字段不同形态都立项 F-NEW (R...)。

---

## 6. F-NEW (Q.silent) — scheduled-task 自身在 6/16+6/17 报告写盘失败

证据链：

- `Servlet Automation Probe` 有 `af972b57`（`PROBE 2026-06-17`,
  created `2026-06-16T19:08Z` = 6/17 03:08 CST）和 `cad50ed3`
  （`PROBE 2026-06-18: iteration #7`, created `2026-06-17T19:08Z` = 6/18 03:08 CST）。
  → 两次 scheduled-task **都跑了 MCP probe 并 POST 了 Requirement**。
- 但 `output/jarvis-auto-test/` 没有 `diagnostic-report-2026-06-16.md` /
  `…-06-17.md` / `…-06-18.md`，也没有 `mcp-probe-2026-06-16.json` / 等。

**最可能的根因**：6/16 之前 scheduled-task 的工作目录被假设为
`/Users/zhangjianan/Documents/GitHub/Jarvis` 且报告通过 `Write` 工具
落到相对路径 `output/jarvis-auto-test/diagnostic-report-<date>.md`。
6/15 的 node port commits 大量改了 SPA / package.json / scripts —
若 scheduled-task 的 cwd 在某一步被改成仓内子目录（`packages/jarvis-app`?）
而报告写绝对路径，结果会是"看似成功，文件不在你以为的地方"。

**今日 #8 的对策**：明确用绝对路径
`/Users/zhangjianan/Documents/GitHub/Jarvis/output/jarvis-auto-test/diagnostic-report-2026-06-19.md`
写入。如果 6/20 #9 看到本份 6/19 报告存在，说明绝对路径方案有效；
否则需要让 scheduled-task 把 cwd 显式 `cd` 到仓根。

**对运维数据的影响**：6/16 + 6/17 + 6/18 三天的"是否复现 F-NEW"
数据彻底丢失。这就是为什么本份报告把窗口拉到 6/15 → 6/19 整体 diff。

---

## 7. 本次"迭代需求判断"（基于 harness 健康）

scheduled-task 的本职是"根据 harness 健康度判断下轮迭代要做什么"。

**当前状态判定**：

| 维度 | 数值 | 信号 |
|---|---|---|
| 代码侧推进速度 | 6/15→6/19 30+ commit, 含 Node port + 多 fix | 🟩 极高 |
| auto-loop 运行情况 | 7 天 throughput 全 0 / 14 天最新 run 是 6/05 | 🟥 死 |
| harness.health 信号 | 9 天字节冻结，可信度 0.163 复读 | 🟥 死 |
| wire-shape 漂移 | F-NEW J/J.1/L 4 周未修；F-NEW P 新增 | 🟧 累积 |
| 运营自我感知 | 6/16 + 6/17 报告静默丢失 | 🟧 系统盲 |

**优先级判定**：

| Pri | 行动 | 依据（本报告引用） |
|---|---|---|
| **P0** | **跑一次 `JARVIS_WORK_MODE=auto` 的 short-lived serve**，对 1 张 approved 探针行做端到端 dry-run，验证 picker 是否真在 `mode=off` 之外还有 `assignee_id.is_some()` 硬门。结果决定 F-NEW (M) 是"环境变量问题"还是"环境变量 + wire shape 双问题"。 | §1.2 §3.1 |
| **P0** | 在 `harness.health` 输出里加 `freshness: {latest_sample_at, days_since_latest_sample}` —— 让"9 天冻结"自报家门，停止"看似 confidence=0.163 实则零信号"的误导。 | §3 (O), 6/15 §5 重申 |
| **P0** | 把 `provider_admin_routes.rs` 真的挂到 router 上（或者明确删除模块 + 在 CLAUDE.md 标记），消解 F-NEW (P)。如果是 feature-gate 没开，那 GET `/v1/providers/:name` 应返回 503 而非 404，与 CLAUDE.md 一致。 | §3 (P) |
| **P1** | 手工 `DELETE /v1/requirements/f4a78fc3-…` + 在 picker 里给 `failed_count >= max_retries` 写 Activity Blocked 行，避免再有 stuck row 隐身 13 天 | §4 |
| **P1** | 给 scheduled-task 的"写 MD 报告"步骤加绝对路径 + 写成功后 echo 字节数 → 防 6/16/6/17 的静默丢失复发 | §6 |
| **P1** | 对 TS 端跑一次 wire parity probe，diff `/v1/work/overview` 等 endpoint 与 Rust 端的字段集 | §5 |
| **P2** | GC `.jarvis/worktrees/issue-43`（21 天，5.768 GB） | §1.2 (N) |
| **P3** | 在 6/15 §3 建议的"wire-shape diff lint"（`make ts-codegen` 后比较 generated TS 字段 delta）加入 CI；现在又多了 TS 端，更需要这道闸 | §3 J/J.1 + §5 |

**为什么"再次不堆新 Req"**：今日（iter #8）已经是 `Servlet Automation Probe`
项目下的第 7 张 probe Req（11→12 行里有 6 张 PROBE 开头 + 本日 +1）。
在 F-NEW (M) 真因没查清之前，堆 row 仍然只在让 backlog 计数变形。
本日新行 `b85352cd` 的作用是：留 6/20 baseline + 作为 §3.1 follow-up
"P0 dry-run"的目标 row。

---

## 8. 附录：本次产物清单

| 文件 / 实体 | 用途 |
|---|---|
| [`diagnostic-report-2026-06-19.md`](./diagnostic-report-2026-06-19.md)（本文件） | iter #8 报告，**绝对路径写入** |
| [`mcp-probe-2026-06-19.json`](./mcp-probe-2026-06-19.json) | `jarvis mcp-serve` 探针完整 JSON（initialize / tools/list(20) / workspace.context / triage.scan_candidates / code.grep / project.checks / harness.health），36678 bytes |
| Requirement `b85352cd-0537-47ba-a013-4a3dc5fbe39c` | `Servlet Automation Probe` 项目下，title=`PROBE 2026-06-19: iteration #8 — F-NEW(O) 9-day freeze + F-NEW(P) admin routes 404 + Node port`，verification_plan=`{"commands":["echo ok"]}`，零成本 |
| 未写入（**有意为之**） | （a）不修复 `f4a78fc3`（留待运维确认）；（b）不删除 `.jarvis/worktrees/issue-43`（5.768 GB，仅 read 类 scheduled-task 不动磁盘）；（c）不切换 `/v1/auto-mode` enabled（运维语义） |

**本次结束时**：Jarvis serve 仍在线，PID 45720，uptime ~195h，
分支 `feat/node-providers-list-p8.1` @ `b0a649b`。

**下次（6/20 03:00 CST）应该看到的指标**：

- 如果本份报告**存在** → F-NEW (Q.silent) 的"绝对路径" hypothesis 成立
- HEAD 是否仍 `b0a649b` → 工作日强度判断
- `last_tick_at` 是否仍距 read 几分钟 → supervisor 心跳维持
- harness.health: 若 P0 未动 → 进入第 10 天字节冻结
- `f4a78fc3` 失败计数若仍 = 6 → 证实"picker 永久跳过"
- `b85352cd` 状态：若 `assignee_id` 不为空 → 6/15→6/19 期间有人手工补；
  若仍 None 且 status 仍 backlog → §7 P0 dry-run 还没人跑
- 若 `/v1/providers/codex` 不再 404 → P0 (F-NEW P) 已动

若上述任一指标偏离预测，6/20 turn 应以那次偏离作为新 anchor。
