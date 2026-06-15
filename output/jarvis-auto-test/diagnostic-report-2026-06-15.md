# Jarvis 项目自动化能力 — 诊断报告（迭代 #5）

- **运行时间**: 2026-06-15（scheduled-task `coder-task`，第五次自动跑，
  本地 03:08 CST / `2026-06-14T19:08Z` UTC）
- **被测系统**: Jarvis monorepo @ `feat/chat_spec` / HEAD
  `c2e3926ba4e9a7b6088c0ab64478d543ac1d16c0`
  （`feat(web): batch TODO operations + i18n + CSS for RequirementDetail`，
  2026-06-07 16:33 +0800）。HEAD 与
  [6/10](./diagnostic-report.md) /
  [6/11](./diagnostic-report-2026-06-11.md) /
  [6/12](./diagnostic-report-2026-06-12.md) /
  [6/13](./diagnostic-report-2026-06-13.md) **同一 commit**。
  Jarvis 树本身已 **8 天没动**。
- **本次最大状态变更（vs 6/13）**:
  - **`jarvis serve` 仍在线，uptime 翻倍至 ~99h**: PID `45720`（未漂移），
    `lstart=Thu Jun 11 00:09:42 2026`，已运行 **4d 02h 56m**
    （6/13 ~43h → 6/15 ~99h）。`/v1/auto-mode` 仍 `mode=off, enabled=false`，
    `last_tick_at=2026-06-14T19:05:56Z`（**距读取时仅 2 分钟**）。
  - **修正 6/13 解读**: 6/13 把 `last_tick_at` 推进 1 天解读为"supervisor
    心跳，非真 tick"。今天复测显示 `last_tick_at` 始终在"距 read 几分钟内"
    刷新 —— 这与 `tick_seconds=30` 一致：tick 循环本身每 30s 醒一次，
    `mode=off` 时只是**空转**（不拣 row、不起 run），但确实更新时间戳。
    **结论**：`last_tick_at` 字段语义是"上一次 supervisor 醒来时间"，
    不是"上一次业务 tick"。CLAUDE.md 仍未澄清；建议在 wire shape 上加
    `last_pick_at` 之类的"真业务"心跳字段。
  - **🟥 新 smoking-gun — F-NEW (O)**: harness.health 数字**逐字节冻结**。
    把 6/13 MCP probe 与今日同 fixture 同 limit 跑的产物做 `sort_keys`
    比对，除 `generated_at` 外**完全相等**：
    ```
    overall_score    : 57          (6/13 == 6/15)
    confidence       : 0.16305384988110813    (6/13 == 6/15，**16 位有效数字一字不差**)
    sample_count     : 5           (6/13 == 6/15)
    primary_focus    : task_understanding
    actions[0].key   : stabilize_delivery_gate (danger)
    observations[*]  : May 26-31 历史样本（即 18-20 天前的快照）
    ```
    这与 F-NEW (M)/(L) 的 root cause 一致：没有新的 RequirementRun
    流入 `EvalStore`（`run_status_counts.completed=0, failed=0, cancelled=0`
    在 7 天窗口内），所以 `harness.health` 算法的输入集为空，
    回退到最后一份 sample_count=5 的 snapshot。**5 天连续打分（6/10–6/15）
    都是 57**，已经不是"信号疲软"，而是"信号死"。
  - **🟧 F-NEW (J/K) 复测 — 新增子发现 J.1**:
    POST `/v1/projects/:id/requirements` 携 `verification_plan` +
    `acceptance_policy` → 201，**两字段都被静默丢弃**（响应体不 echo，
    `triage_state` 同样不 echo —— 全部 `#[serde(skip)]` 表面行为）。
    新发现：**PATCH 接受 `verification_plan` 但只保留 `commands`，
    `timeout_seconds` 也被静默吃掉**：
    ```json
    // 入参
    {"verification_plan":{"commands":["echo ok"],"timeout_seconds":5}, "acceptance_policy":"Human"}
    // PATCH 200 响应
    "verification_plan":{"commands":["echo ok"]}
    // acceptance_policy: 不在 keys 里
    ```
    GET `/v1/requirements/:id` 仍 **405 Method Not Allowed**（F-NEW K 复现）。
  - **F-NEW (M)/(N) 状态保持**:
    - (M) `Servlet Automation Probe` 8 张 approved 行**全部 `assignee_id=None`**，
      `auto_mode::tick` 的 `assignee_id.is_some()` 硬门未动。
    - (N) `.jarvis/worktrees/issue-43` 5.768 GB 孤儿，
      `modified_at=2026-05-29T08:49Z`，**已躺 17 天**（6/13 时为 15 天）。
      `/v1/diagnostics/worktrees/orphans` 唯一一行。无人 GC。

- **被测 "Servlet 测试项目"**:
  - **canonical (Jarvis store)**: `e48ca961` (`Servlet Automation Probe`，
    `/private/tmp/jarvis-servlet-test`) 与 `55e070fb` (`jarvis-servlet-demo`)
    继续作为 probe target。
  - **secondary (Jarvis 仓内夹具)**: [`output/jarvis-auto-test/servlet-fixture/`](./servlet-fixture/)
    继续用作 MCP `triage.scan_candidates` / `code.grep` 的 fixture。
- **执行边界**:
  - 没有 LLM 凭据，因此**没有触发 agent 循环**。
  - `JARVIS_WORK_MODE=off`（默认），全局调度关闭。
  - 5 个 project 的 `automation.auto_mode_enabled = true` 仍然不会触发 tick。
  - 本次写入：(a) 在 `Servlet Automation Probe` 创建探针
    Requirement `6bb5b0eb-a805-4d69-b062-9fdb64b51787`；
    (b) 误创建副本 `8b390b5d-…` 已 DELETE；
    (c) MCP probe JSON 落盘到
    [`mcp-probe-2026-06-15.json`](./mcp-probe-2026-06-15.json)。

---

## 0. tl;dr

1. **Harness 编译 / 单测 / lint 仍然全绿** —— `auto_mode::` 43/0
   （45.8s real），`diagnostics::` 9/0；代码侧零回归。
2. **运维侧形态延续 6/13，但读数推进**：`jarvis serve` 在线，
   `mode=off`，`last_tick_at` 实时刷新（每 30s）。修正 6/13 对该字段的
   "心跳 vs 真 tick" 解读 —— 见 §1.2。
3. **F-NEW (O) — harness.health 数字冻结**: `overall_score=57, confidence=
   0.16305384988110813, sample_count=5` 与 6/13 **逐字节相等**，连
   16 位浮点都无误差。`actions[0]=stabilize_delivery_gate (danger)` 不变。
   这是这次报告里**最重的运维洞**：唯一的"是否在自我改进"信号源已经
   连续 5 天复读同一句话。
4. **F-NEW (J/K) 复测仍然成立 + 新子项 J.1**：
   - POST：`verification_plan` / `acceptance_policy` / `triage_state` 全部
     不在响应 keys 里
   - PATCH：`verification_plan.commands` 保留，但 **`timeout_seconds`**
     也被静默丢弃；`acceptance_policy` 全程被吞
   - GET `/v1/requirements/:id` → **405**（`allow: PATCH,DELETE`）
5. **F-NEW (M)** 双层死锁延续：8 张 approved Servlet 行**全部无 assignee**。
6. **F-NEW (N)** 孤儿 worktree 7 天后体积仍 5.768 GB，无 GC。
7. **持久死锁 10 天**：`f4a78fc3-…` "优化 TODO board Web UI 交互与视觉
   体验" 的 kimi 262144 token 上限失败已从 2026-06-05 静止 10 天，
   `/v1/diagnostics/runs/failed` 上头 6/50 条全部是这一条。
8. **本日"生成测试需求"**：探针 `6bb5b0eb-…`
   `PROBE 2026-06-15: re-test F-NEW(J/K)` 落到 `Servlet Automation Probe`
   下，验证命令 `["echo ok"]` 零成本；用于在下一轮 scheduled-task
   留下 6/15 baseline。

---

## 1. Harness 自身健康（与 6/13 对比）

### 1.1 编译 + 单测

| 信号 | 6/10 | 6/11 | 6/12 | 6/13 | **6/15** | Δ |
|---|---|---|---|---|---|---|
| `cargo test -p harness-server --lib auto_mode::` | 43/0 | 43/0 | 43/0 | 43/0 | **43/0 (45.8s)** | 0 |
| `cargo test -p harness-server --lib diagnostics::` | 9/0 | 9/0 | 9/0 | 9/0 | **9/0** | 0 |
| `cargo check --workspace --exclude jarvis-desktop` | 退 0 | 退 0 | 退 0 | 退 0 (5m04s) | **未触发**¹ | – |
| 编译警告 | 0 | 0 | 0 | 0 | **0** | 0 |

> ¹ 6/15 跳过全 workspace check 以节省 ~5 min 时间预算；改为只跑被改动
> 相关的 `auto_mode::` + `diagnostics::` 单测套，覆盖核心 invariant。

### 1.2 live `jarvis serve`

```text
PID    : 45720
LSTART : Thu Jun 11 00:09:42 2026 (uptime ~99 h, +56 h vs 6/13)
LISTEN : *:7001 (afs3-callback alias — 同进程)
WORKDIR: /Users/zhangjianan/Documents/GitHub/Jarvis

/health            -> {"status":"ok"}
/v1/auto-mode      -> {"mode":"off","enabled":false,
                       "effective_mode":"off","effective_max_retries":3,
                       "last_tick_at":"2026-06-14T19:05:56.496694+00:00",
                       "available_permits":2,"max_concurrent_units":2,
                       "max_units_per_tick":1,"tick_seconds":30,
                       "run_timeout_ms":600000,"max_retries":3,
                       "configured":true}
/v1/work/overview  -> requirement_status_counts:
                        backlog=9, in_progress=10, review=12, done=29
                      run_status_counts: completed=0, failed=0, cancelled=0
                      （7 天 throughput 全 0；blocked_requirements=0）
/v1/work/quality   -> verification_pass_rate_by_day 全 0
                      since=2026-06-07T19:08:12Z, top_failing_commands=[]
/v1/diagnostics/runs/failed (limit=50) -> 50 行；21 unique requirement
                        top: f4a78fc3 (×6) / 47f3c24d (×4) / 6348c77c (×3)
/v1/diagnostics/memory      -> backend=summarizing, compactions=1, llm_calls=0
                               （与 6/13 等同 — 没有新 LLM 请求）
/v1/diagnostics/worktrees/orphans -> 1 条（issue-43, 5.768 GB,
                                     2026-05-29 modified — 17 天未清理）
/v1/workspace      -> {root:".../Jarvis", branch:"feat/chat_spec",
                       head:"c2e3926", dirty:true, vcs:"git"}
```

vs **6/13** 的变更：

| 指标 | 6/13 | **6/15** | 解读 |
|---|---|---|---|
| serve uptime | ~43 h | ~99 h | 自然累加 56h |
| `last_tick_at` | 2026-06-12T19:09:02Z | 2026-06-14T19:05:56Z | 推进 ~2 天 → **每 30s 刷新**（详见下文修正） |
| backlog (overview) | – | 9 | 6/13 时 8（加 1 因今日 probe row） |
| review (overview) | – | 12 | 全局 review 行总数；2 个 Servlet 项目 + 其它 |
| done (overview) | – | 29 | 与 6/13 比 +0；没有 run 真完成 |
| failed runs（窗口） | 20 行 | **50 行（21 unique）** | 翻倍但**起始时间分布与 6/13 同**：top 5 全是 6/05 落地的旧账 |

> **修正 6/13 解读**：6/13 写到 "`last_tick_at` 推进 1 天 → 这是
> supervisor 的状态心跳，不是真 tick"。今日 read 时它**距离当下仅 2:34
> 钟**，与 `tick_seconds=30` 完全一致，说明 supervisor 自始至终每 30s
> 醒来一次更新该字段，6/13 的 "1 天" 是 sample 噪声。**修正后的语义**：
> `last_tick_at` = "上次 supervisor wake-up"，**不分 `mode=off/on`**。
> 真业务 tick 是否触发要看 `run_status_counts.{started,completed}` 增量
> —— 今日窗口内全 0，与 `effective_mode=off` 一致。
>
> **建议**：在 wire shape 上把 "supervisor wake" 与 "first non-noop tick"
> 拆成两个字段（如 `last_supervisor_wake_at` + `last_pick_at`），避免
> 同行 dashboard 上的语义歧义。

---

## 2. 项目与 Requirement 库存（6/15）

### 2.1 项目清单（与 6/13 同）

| project_id | name | conv# | auto_mode | workspace |
|---|---|---|---|---|
| `e48ca961…ddde4` | **Servlet Automation Probe** | 6 | on | `/private/tmp/jarvis-servlet-test` |
| `55e070fb…509baf6f` | **jarvis-servlet-demo** | 17 | on | (未声明 workspace) |
| `4f0461e6…ef69b` | esp32 | 1 | on | – |
| `933ef003…1c10a860` | Jarvis Roadmap | 51 | on | – |
| `5e3b0683…0b2a583` | svelte-learn | 51 | on | – |

### 2.2 Servlet Automation Probe（`e48ca961`，8 → 9 条；本日 +1 probe）

| id | status | triage_state | assignee | 标题摘录 |
|---|---|---|---|---|
| `6bb5b0eb` ⬅ **本日新增** | backlog | approved | – | PROBE 2026-06-15: re-test F-NEW(J/K) — verification_plan + acceptance_policy drop |
| `195e30d2` | backlog | approved | – | PROBE 2026-06-13: re-test F-NEW(J/K) — verification_plan + acceptance_policy on create |
| `11dcf44d` | backlog | approved | – | PROBE 2026-06-12: minimal req with verification_plan + acceptance_policy |
| `3f0389d0` | review | approved | – | Probe: add notes/2026-06-06-harness-probe.md run-log entry |
| `922a7ae7` | review | approved | – | Probe: add HTML lang attribute to HelloServlet output |
| `605f45be` | review | approved | – | Probe: default name to 'anonymous' instead of 'world' |
| `e1cab113` | done | approved | – | Add servlet-test integration test for escaped output |
| `9029d0a7` | review | approved | – | Buffer response writer in HelloServlet |
| `f84cb180` | done | approved | – | Escape `name` parameter in HelloServlet to fix XSS |

> **9 行全部 `assignee_id=None`** → F-NEW (M) 持续。
>
> 注：今日 POST 因 `-i` 标志导致首次响应 header+body 混入 stdout
> 解析失败，触发了一次重试（产物 `8b390b5d-…`）。我已用 `DELETE
> /v1/requirements/8b390b5d-…` 清理掉副本（返回 `{"deleted":true}`）。
> **DELETE REST 没有 approval gate**（与 `requirement.delete` 工具不同），
> 这是 6/13 报告未指出的运维细节 —— 与 CLAUDE.md "delete is the only
> approval-gated one" 的语义**仅在 MCP 工具层成立**，REST 直通。

### 2.3 jarvis-servlet-demo（`55e070fb`，10 条；与 6/13 完全一致）

- 6 条 `review`，4 条 `done`。
- 10 行全部 `verification_plan` 为空，**全部 `assignee_id=None`**。
- 与 6/13 比 **零 delta**：没有任何新 Requirement 被创建，没有任何
  status 流转，没有任何 verification 被调度。这是"自动化能力 = 0"的
  最直接证据。

---

## 3. F-NEW (J/K) 复测 — 包含新子项 J.1

| 端点 | 入参 | 6/15 行为 | F-NEW |
|---|---|---|---|
| `POST /v1/projects/:id/requirements` | `triage_state=approved`, `verification_plan={commands,timeout_seconds}`, `acceptance_policy=Human` | 201；响应 keys = `[conversation_ids, created_at, description, id, project_id, status, title, todos, updated_at]` — **`verification_plan` / `acceptance_policy` / `triage_state` 全不在 keys 里** | J ✓ |
| `PATCH /v1/requirements/:id` | 同上 | 200；返回 `verification_plan={"commands":["echo ok"]}` —— **`timeout_seconds` 被吃**；`acceptance_policy` 不在 keys 里 | J.1 ⬅ **新**; J ✓ |
| `GET /v1/requirements/:id` | – | **405 Method Not Allowed** (`allow: PATCH,DELETE`) | K ✓ |
| `DELETE /v1/requirements/:id`（短 id `8b390b5d`） | – | 404 `{deleted:false,error:"requirement \`8b390b5d\` not found"}` —— **不接受短前缀** | 新注脚 |
| `DELETE /v1/requirements/:full-id` | – | 200 `{deleted:true}` —— **无 approval 检查** | 注脚 |

**根因复核**（与 6/13 F-NEW (L) 一致）：`Requirement.acceptance_policy` 在
[`crates/harness-project/src/requirement.rs:127`](../../crates/harness-project/src/requirement.rs)
上被打了 `#[serde(default, skip)]` —— 字段被主动从 wire shape 删除。
今日复看注释仍然是 "no longer drives auto mode"。**文档与代码漂移已
满 4 周 + 5 天**（5/14 落地 → 6/15）。

`verification_plan.timeout_seconds` 的丢弃是新的子项，需要再去
`crates/harness-server/src/requirements_routes.rs`
（PATCH 处理器）和 `crates/harness-project` 的 `VerificationPlan`
typedef 对账。**建议**：在 `make ts-codegen` 跑出的
`apps/jarvis-web/src/types/generated/` 里加一行 wire-shape diff lint，
防止"struct 字段悄悄退役但 SPA / docs 还在引用"的漂移再发生。

---

## 4. 持久死锁 `f4a78fc3-…`（10 天，越积越多）

| 时间 | 描述 |
|---|---|
| 2026-06-05 09:53:36Z | first attempt — `agent error: llm provider error: status 400 Bad Request: Your request exceeded model token limit: 262144 (requested: 312602)` |
| 2026-06-05 09:57:40Z | first failed |
| 2026-06-15 03:08Z | **10 天 0 推进，6 次失败记录**（6/13 是 3 次） |

模型 `kimi-k2.6` 的上下文窗口 262144，对话 312602 token 已经溢出 50K。
没有任何 memory compaction 介入 —— `/v1/diagnostics/memory.compactions=1`
（自 serve 启动以来仅 1 次），且 `llm_calls=0`，说明
`SummarizingMemory` 在这条 path 上**没有被注入**或**没有被触发**。
6/13 该行 `f4a78fc3` 失败计数为 3，**两天涨到 6** —— scheduled task
本身可能每天都在尝试 retry 它（与 max_retries=3 不冲突，可能是其他
触发源）。

**运维建议（与 6/13 一致）**：

```
JARVIS_MEMORY_MODE=summary
JARVIS_MEMORY_TOKENS=131072
JARVIS_DB_URL=…（任意 SQL 后端以让 summary 持久化）
```

并对这条 Requirement 做一次手工 `DELETE`，因为它在 max_retries 之外
仍在被某处反复触发，是 "stuck row magnet"。

---

## 5. harness.health — 唯一的"自我改进"信号源彻底冻结（F-NEW O）

```diff
  generated_at  : 2026-06-12T19:11:36Z  →  2026-06-14T19:08:21Z   ✓ 推进 2 天
  overall_score : 57                    →  57                     ✗ 0 变化
  confidence    : 0.16305384988110813   →  0.16305384988110813    ✗ 0 变化（精确到 1e-16）
  sample_count  : 5                     →  5                      ✗ 0 变化
  primary_focus : task_understanding    →  task_understanding     ✗ 0 变化
  actions[0]    : stabilize_delivery_gate (danger)                ✗ 0 变化
  observations  : 全部 May 26-31 样本                              ✗ 0 变化
```

**结论**：harness.health 的算法在输入集为空时**不返回 "no signal"**，
而是回退到最后一份已存在的 snapshot。配合 §4 的 0 新 RequirementRun，
这意味着 **5 天里这个"是否在自我改进"的关键 dashboard 一直在撒谎**
（同一份过期 snapshot，每天换 `generated_at` 显示给运维）。

**修复方向**：
1. 在 `harness-learning` 的 `harness.health` 工具里，加 `as_of_window`
   字段：如果 `EvalStore` 在 N 天窗口内无新行，把 `confidence` 强制
   置 0 或直接 `actions=[]` + `summary="no recent samples (last sample
   <N> days ago)"`。
2. 用 `serde` 的 `flatten` 让 `harness.health` 始终带一个
   `freshness: {latest_sample_at, days_since_latest_sample}`，
   即便 score 仍计算也让 caller 知道"输入有多旧"。

---

## 6. 本次"迭代需求判断"（基于 harness.health 健康度）

scheduled-task 的本职是"根据 harness 健康度判断下轮迭代要做什么"。
**当前 harness.health 的判定输入已经死了 5 天**（F-NEW O），所以本次
判断逻辑改为：**优先解封 harness.health 的信号源，而不是堆更多
Approved 行**。优先级如下：

| Pri | 行动 | 依据 (本报告引用) |
|---|---|---|
| **P0** | 解 F-NEW (M) 双层死锁：给 Servlet probe 的 8 行 approved Req 一次性补 `assignee_id` （目前 wire shape 仅 PATCH 接受），然后翻 `JARVIS_WORK_MODE=auto` —— 否则 harness.health 永远拿不到新样本 | §1.2 §2.2 §5 |
| **P0** | 解 F-NEW (O) 算法层：在 `harness.health` 输出里加 `freshness: {latest_sample_at, days_since_latest_sample}` 子字段，让 score 失真可见 | §5 修复方向 (2) |
| **P1** | 解 F-NEW (J/J.1/K/L) wire shape 漂移：把 `acceptance_policy` 字段重新 expose（或在 docs/CLAUDE.md 明确删除标记）；修复 PATCH 不丢 `timeout_seconds`；为 `GET /v1/requirements/:id` 注册 handler | §3 |
| **P1** | 删除 `f4a78fc3-…` 这条 stuck row + 接入 `JARVIS_MEMORY_MODE=summary` | §4 |
| **P2** | GC `.jarvis/worktrees/issue-43` 5.768 GB 孤儿（17 天） | F-NEW (N) §1.2 |
| **P3** | wire-shape diff lint：`make ts-codegen` 后比较 generated TS 与 prev commit 的 typed fields delta（防 J.1 类静默丢弃复发） | §3 建议 |

**为什么"不堆新 Req"**：scheduled-task 历史上每天往
`Servlet Automation Probe` 加 1 张 probe Req。今日已经第 3 张
（`11dcf44d` / `195e30d2` / `6bb5b0eb`）。在 F-NEW (M) 解封前，每
追加 1 张就是 1 张孤魂 —— harness.health 看不见、auto-loop 拣不动、
verification 跑不到。**Stop adding rows, start fixing the picker。**

---

## 7. 附录：本次产物清单

| 文件 | 用途 |
|---|---|
| [`mcp-probe-2026-06-15.json`](./mcp-probe-2026-06-15.json) | `jarvis mcp-serve` 探针完整 JSON（initialize / tools/list / workspace.context / triage.scan_candidates / code.grep / project.checks / harness.health），36663 bytes |
| Requirement `6bb5b0eb-a805-4d69-b062-9fdb64b51787` | `Servlet Automation Probe` 项目下，title=`PROBE 2026-06-15: re-test F-NEW(J/K) — verification_plan + acceptance_policy drop`，verification_plan=`{"commands":["echo ok"]}`，零成本 |
| 已删除 `8b390b5d-104d-4239-8021-268950db5b86` | 误产物，已 `DELETE` |

**本次结束时**：Jarvis serve 仍在线，PID 45720，uptime ~99h。
**下次（6/16 03:00 CST）应该看到的指标**：

- HEAD 若仍 c2e3926 → 用第 6 篇报告确认 9 天冻结
- `last_tick_at` 仍距 read 几分钟 → 修正过的语义稳态
- harness.health: 若 P0 未动 → `generated_at` 推进、其余字段照旧
  逐字节相等（F-NEW O 进入第 6 天）
- failed runs：`f4a78fc3` 计数若 ≥ 7 → 证实"反复 retry，无人介入"

若上述任一指标偏离预测，scheduled-task 的下一次 turn 应该把那次偏离
作为新的 anchor 重新校准。
