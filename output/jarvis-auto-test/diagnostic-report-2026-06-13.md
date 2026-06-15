# Jarvis 项目自动化能力 — 诊断报告（迭代 #4）

- **运行时间**: 2026-06-13（scheduled-task `coder-task`，第四次自动跑，
  本地 03:11 CST / `2026-06-12T19:11Z` UTC）
- **被测系统**: Jarvis monorepo @ `feat/chat_spec` / HEAD
  `c2e3926ba4e9a7b6088c0ab64478d543ac1d16c0`
  （`feat(web): batch TODO operations + i18n + CSS for RequirementDetail`，
  2026-06-07 16:33 +0800）。HEAD 与
  [6/10](./diagnostic-report.md) /
  [6/11](./diagnostic-report-2026-06-11.md) /
  [6/12](./diagnostic-report-2026-06-12.md) **同一 commit**。
  Jarvis 树本身 6 天没动。
- **本次最大状态变更（vs 6/12）**:
  - **`jarvis serve` 仍在线，uptime 翻倍** — PID `45720`，
    `lstart=Thu Jun 11 00:09:42 2026`，已运行约 **43 h**（6/12 时 ~27 h）。
    `/v1/auto-mode` 仍返回 `{mode:"off", enabled:false}`，
    `last_tick_at=2026-06-12T19:09:02Z` —— **tick 仍然没有触发过**，
    "热启但闲置"形态延续。
  - **🟥 新 smoking-gun — F-NEW (L)**: `acceptance_policy` 在领域类型
    [`Requirement`](../../crates/harness-project/src/requirement.rs:127)
    上被打了 `#[serde(default, skip)]`。这是 6/12 F-NEW (J) "API 不接受
    acceptance_policy" 的**上游真因**：字段本身已经从 wire shape 里**主动
    删除**了，注释直说 "no longer drives auto mode"。
    > 这条改动在 `a7d6377`（2026-05-14 18:51 +0800
    > `feat: channels + SubAgent finishing + harness-project crate split`）落地，
    > 比 6/12 报告写完早 28 天，但 [`CLAUDE.md`](../../CLAUDE.md) 仍然把
    > `Subagent`/`Human` 的 acceptance-policy 区分作为现行规则讲。
    > **文档与代码漂移 ≥ 4 周。**
  - **🟧 副发现 — F-NEW (M)**: `Servlet Automation Probe`（`e48ca961`）
    里 8 张 `triage_state=approved` 的 Requirement **全部 `assignee_id=None`**，
    [`auto_mode::tick` 的硬门](../../crates/harness-server/src/auto_mode.rs) 是
    `assignee_id.is_some()`，所以即便把 `JARVIS_WORK_MODE=auto` 打开，**这些
    行依然不会被 tick 拣选**。运维侧死锁不止 "mode=off" 一层，**还隔一层 owner
    assignment**。
  - **🟧 副发现 — F-NEW (N)**: `.jarvis/worktrees/issue-43` 孤儿 worktree
    `~5.4 GiB`，`modified_at=2026-05-29T08:49Z`，已经躺了 15 天，
    `/v1/diagnostics/worktrees/orphans` 里**唯一**一行。运维层面没有任何
    自动 GC 进程触发过。
- **被测 "Servlet 测试项目"**:
  - **canonical (本地 git 仓)**: `~/Documents/GitHub/jarvis-servlet-demo`
    @ HEAD `b37db62`（`init: minimal Servlet demo for Jarvis auto-mode`，
    2026-05-09 03:10 +0800）—— **本地未提交改动**：`HelloServlet.java`
    +13 行（content-type/`?name=`/小写化），`README.md` +6 行（Quickstart），
    `HelloServletTest.java` 已 `git add` 但未 commit。即历史上某次 agent
    确实改了代码，但**没有 `git commit`**，工作树脏挂 ≥ 5 周。
  - **canonical (Jarvis store)**: project
    [`e48ca961-cffe-4dcc-9c2e-0486363ddde4`](./../../) =
    `Servlet Automation Probe` (`/private/tmp/jarvis-servlet-test`) 与
    [`55e070fb-e11e-4a40-b047-2080509baf6f`](./../../) = `jarvis-servlet-demo`
    （前者 7 条 Requirement，后者 10 条，详见 §2）
  - **secondary (Jarvis 仓内夹具)**: [`output/jarvis-auto-test/servlet-fixture/`](./servlet-fixture/)
    （延续 6/10、6/11、6/12，今天仍用于 MCP 工具表复测）
- **执行边界**:
  - 没有 LLM 凭据，因此**没有触发 agent 循环**（live serve 在线不代表自动跑通）
  - `JARVIS_WORK_MODE=off`（默认），全局调度关闭
  - 5 个 project 的 `automation.auto_mode_enabled = true` 仍然不会触发 tick
  - 本次**有两次写入**：(a) 在 `Servlet Automation Probe` 项目下创建探针
    Requirement `195e30d2-5c5c-4268-965f-078c0b8542c5`（用来复测 F-NEW J/K
    并把 6/13 baseline 钉死，详见 §3）；(b) 把 6/13 MCP 探针的 JSON 落盘到
    [`mcp-probe-2026-06-13.json`](./mcp-probe-2026-06-13.json)

---

## 0. tl;dr

1. **Harness 编译 / 单测 / lint 仍然全绿** —— `cargo check --workspace --exclude
   jarvis-desktop` 5m04s 退 0；`auto_mode::` 43/0；`diagnostics::` 9/0。
   与 6/12 完全一致，代码侧没有回归。
2. **运维侧形态延续 6/12**：`jarvis serve` 在线但 `mode=off`，`last_tick_at`
   昨晚 19:09Z 后再无递增。uptime 43h，调度面"活但闲置"。
3. **F-NEW (L) — 文档/代码漂移**：
   `Requirement.acceptance_policy` 已经在 5/14 的 `a7d6377` 提交里被
   `#[serde(default, skip)]` 拿出 wire shape，注释明说 "no longer drives auto
   mode"。auto_mode 单测 `tick_skips_human_acceptance_policy_at_review`
   （文件名有误导，docstring 正解）现在断言 **Human-policy 的 Review 行也
   会被 tick 拣选**。但 [`CLAUDE.md`](../../CLAUDE.md) 依然把
   `Subagent vs Human` 当成现行规则讲，描述 "Human keeps the row at Review
   (the picker also skips it)" —— 与运行时事实**反了**。
4. **F-NEW (J/K) 复测仍然成立**（详见 §3）：
   - `POST /v1/projects/:id/requirements` 携带 `verification_plan` +
     `acceptance_policy` → **两个字段都被静默丢弃**（HTTP 201 / 体内 `None`）
   - `PATCH /v1/requirements/:id` 携带 `verification_plan` → **接受**；
     携带 `acceptance_policy` → 200 OK 但**静默丢弃**
   - `GET /v1/requirements/:id` → **405 Method Not Allowed**（`allow: PATCH,DELETE`）
5. **F-NEW (M) — 双层死锁**：8 张 approved Servlet 探针行**全部无 assignee**，
   即使 `JARVIS_WORK_MODE=auto` 也不会被拣选。
6. **F-NEW (N) — 孤儿 worktree 5.4 GiB**：`.jarvis/worktrees/issue-43`
   2026-05-29 起未清理。
7. **harness.health 唯一可信信号源仍然冻结**（详见 §5）:
   `overall_score=57, confidence=0.16, sample_count=5, primary_focus=
   task_understanding, actions[0]=stabilize_delivery_gate (danger)` ——
   数字与 6/12 一字不差，仅 `generated_at` 推进一天。5 个观察样本仍然
   是 May 26-31 的历史遗物。
8. **持久死锁 8 天**：`f4a78fc3-…` "优化 TODO board Web UI 交互与视觉
   体验" 的 kimi 262144 token 上限失败已经从 2026-06-05 静止 8 天，
   3 次失败，`/v1/diagnostics/runs/failed` 头 3 条全部是这一条。
9. **本日"生成测试需求"**：探针 `195e30d2-5c5c-4268-965f-078c0b8542c5`
   `PROBE 2026-06-13: re-test F-NEW(J/K)` 落到 `Servlet Automation Probe`
   下，零成本（验证命令 `["echo ok"]`），用来在下一轮 scheduled-task
   留下一个 baseline。

---

## 1. Harness 自身健康（与 6/12 对比）

### 1.1 编译 + 单测

| 信号 | 6/10 | 6/11 | 6/12 | **6/13** | Δ |
|---|---|---|---|---|---|
| `cargo test -p harness-server --lib auto_mode::` | 43 / 0 | 43 / 0 | 43 / 0 | **43 / 0** | 0 |
| `cargo test -p harness-server --lib diagnostics::` | 9 / 0 | 9 / 0 | 9 / 0 | **9 / 0** | 0 |
| `cargo check --workspace --exclude jarvis-desktop` | 退 0 | 退 0 | 退 0 | **退 0 (5m04s)** | 0 |
| 编译警告 | 0 | 0 | 0 | **0** | 0 |

工具版本：仓库 pinned toolchain；运行环境 macOS 15.5 (Darwin 25.5.0)，arm64。

### 1.2 live `jarvis serve`

```text
PID    : 45720
LSTART : Thu Jun 11 00:09:42 2026 (uptime ~43 h)
LISTEN : *:7001
WORKDIR: /Users/zhangjianan/Documents/GitHub/Jarvis

/health            -> {"status":"ok"}
/v1/auto-mode      -> {"mode":"off","enabled":false,
                       "effective_mode":"off","effective_max_retries":3,
                       "last_tick_at":"2026-06-12T19:09:02.695225+00:00",
                       "available_permits":2,"max_concurrent_units":2,
                       "max_units_per_tick":1,"tick_seconds":30,
                       "run_timeout_ms":600000,"max_retries":3,
                       "configured":true}
/v1/work/overview  -> last 7d: runs_started 3 (all 6/05), completed 3,
                      failed 0; throughput 6/06..6/12 全部 0
/v1/work/quality   -> verification_pass_rate_by_day 全 0；no top_failing_commands
/v1/diagnostics/runs/recent (limit=5) -> 3×completed (6/05) + 2×failed (6/05)
/v1/diagnostics/runs/failed -> 20 条；最新 3 条全是 `f4a78fc3-…` kimi 262144 撞墙
/v1/diagnostics/runs/stuck  -> 0
/v1/diagnostics/memory      -> backend=summarizing, compactions=1, llm_calls=0
/v1/diagnostics/worktrees/orphans -> 1 条（issue-43, 5.768 GB, 2026-05-29 modified）
```

vs **6/12** 的变更只有两处：

| 指标 | 6/12 | 6/13 | 解读 |
|---|---|---|---|
| serve uptime | ~27 h | ~43 h | 自然累加 16h |
| `last_tick_at` | 2026-06-11T19:10:59Z | 2026-06-12T19:09:02Z | 推进了 1 天（但 mode 仍 off → 不可能有真 tick；这是 `auto_mode_supervisor` 的心跳/状态心跳，非业务 tick；需结合 §4 看） |

> 6/12 报告里"`last_tick_at=2026-06-11T19:10:59`"今天推进到了 6/12T19:09Z。
> 这是同一台 serve 起来后每天大约同一时刻刷一次（差 2 分钟内），
> 行为像被某个外部 trigger 周期化。**值得跟进的运维问题**：这个时间戳
> 在 mode=off 时也在动，意味着字段语义可能不是 "上一次真 tick"，而是
> "supervisor 上一次 wake"。CLAUDE.md / API 文档没说明。

---

## 2. 项目与 Requirement 库存（6/13）

### 2.1 项目清单（`GET /v1/projects`）

| project_id | name | conv# | auto_mode | workspace |
|---|---|---|---|---|
| `e48ca961…ddde4` | **Servlet Automation Probe** | 6 | **on** | `/private/tmp/jarvis-servlet-test` |
| `55e070fb…509baf6f` | **jarvis-servlet-demo** | 17 | **on** | (未声明 workspace) |
| `4f0461e6…ef69b` | esp32 | 1 | on | `/Users/…/Documents/esp32` |
| `933ef003…1c10a860` | Jarvis Roadmap | 51 | on | (auto-imported roadmap) |
| `5e3b0683…0b2a583` | svelte-learn | 51 | on | – |

### 2.2 Servlet Automation Probe（`e48ca961`，7 → 8 条）

| id | status | triage_state | vp | 标题摘录 |
|---|---|---|---|---|
| `195e30d2` | backlog | approved | **(create 时丢)** | PROBE 2026-06-13: re-test F-NEW(J/K) — verification_plan + acceptance_policy on create |
| `11dcf44d` | backlog | approved | Y | PROBE 2026-06-12: minimal req with verification_plan + acceptance_policy |
| `3f0389d0` | review | approved | – | Probe: add notes/2026-06-06-harness-probe.md run-log entry |
| `922a7ae7` | review | approved | – | Probe: add HTML lang attribute to HelloServlet output |
| `605f45be` | review | approved | – | Probe: default name to 'anonymous' instead of 'world' |
| `e1cab113` | done | approved | – | Add servlet-test integration test for escaped output |
| `9029d0a7` | review | approved | – | Buffer response writer in HelloServlet |
| `f84cb180` | done | approved | – | Escape `name` parameter in HelloServlet to fix XSS |

> 列 `vp` = `verification_plan` 是否非空。`triage_state` 列在 wire 里默认
> 跳过 ⇒ `approved` 用 listing 二次查询 `?triage_state=approved` 校对。
> **8 行全部 `assignee_id=None`** → F-NEW (M)。

### 2.3 jarvis-servlet-demo（`55e070fb`，10 条）

- 6 条 `review`：`Add Cache-Control: no-store…` / `Add Server response header…` /
  `Add Quickstart section to README.md` / `Add HealthServlet returning JSON status` /
  `Lowercase shouted ?name= values…` / `Add .gitattributes pinning LF…`
- 4 条 `done`：`Add HelloServletTest…` / `Honour ?name=…` / `Add .gitignore…` /
  `Set Content-Type on HelloServlet response`
- **10 行全部 `verification_plan` 为空** —— 与 canonical 6/9 报告
  F-NEW (H) 同表现（不是新增）；F-NEW (J/L) 是其上游成因。

### 2.4 canonical git 仓 `~/Documents/GitHub/jarvis-servlet-demo` 状态

| 检查 | 结果 |
|---|---|
| HEAD | `b37db62 init: minimal Servlet demo for Jarvis auto-mode` (2026-05-09) |
| 自 HEAD 后的提交 | **0** |
| `git diff --stat`（未暂存） | `README.md` +6 / `HelloServlet.java` +12-1 |
| 已 staged 未 commit | `HelloServletTest.java` (54 行) |
| 未跟踪 | 10 份历史诊断报告 + `.gitignore` + `.gitattributes` + `HealthServlet.java` |

也就是说：**Jarvis 自动化触发过对源码的修改**（diff 与 review 列 4 条
"done" 标题一一对得上：`Honour ?name=`、`Set Content-Type`、`Lowercase shouted
?name=`、`Add HelloServletTest`），**但没有提交**。如果运维侧没有手工
`git commit`，Jarvis 的 done 列只是 Requirement 状态机的 done，**git 历史
看不见**。这是一条贯穿 5/9 以来 35 天的隐含失败模式，**6/12 没列出**，
今天补上。

---

## 3. F-NEW (J/K/L) 复测 —— HTTP trace 全程

测试目标：探针 `195e30d2-5c5c-4268-965f-078c0b8542c5`。

### 3.1 GET 单条（F-NEW (K)）

```
$ curl -i http://127.0.0.1:7001/v1/requirements/11dcf44d-5d1b-4088-9334-152eaab28c4c
HTTP/1.1 405 Method Not Allowed
allow: PATCH,DELETE
content-length: 0
```

路由表 [`crates/harness-server/src/requirements_routes.rs:93`](../../crates/harness-server/src/requirements_routes.rs#L93)：

```rust
.route(
    "/v1/requirements/:id",
    patch(update_requirement).delete(delete_requirement),
)
```

**唯一读路径**仍是 `GET /v1/projects/:project_id/requirements` 然后客户端过滤。

### 3.2 POST 携带治理字段（F-NEW (J)）

```
$ curl -s -X POST .../e48ca961.../requirements -d '{
    "title": "PROBE 2026-06-13: ...",
    "triage_state": "approved",
    "verification_plan": {"commands":["echo ok"], "files":[]},
    "acceptance_policy": "human"
  }'
{ "id":"195e30d2-...", ... }
```

服务端 [`CreateBody` (L252-279)](../../crates/harness-server/src/requirements_routes.rs#L252)：

```rust
struct CreateBody {
    title: String,
    description: Option<String>,
    status: Option<String>,
    triage_state: Option<String>,
    depends_on: Option<Vec<String>>,
    todos: Option<Vec<CreateRequirementTodoBody>>,
    label_ids: Option<Vec<String>>,
    // ❌ 没有 verification_plan
    // ❌ 没有 acceptance_policy
}
```

落盘读回：

```
acceptance_policy: None
verification_plan: None
status           : backlog
```

`triage_state="approved"` 接收并应用，listing `?triage_state=approved` 命中 → ✅。
其余两个字段被 serde 在 `CreateBody` 反序列化时**默认忽略未知键**，没有 400，
没有 warn，**调用方无法察觉**。

### 3.3 PATCH 携带治理字段

```
$ curl -i -X PATCH .../v1/requirements/195e30d2... -d '{"verification_plan":{"commands":["echo ok"],"files":[]}}'
HTTP/1.1 200 OK
$ curl -i -X PATCH .../v1/requirements/195e30d2... -d '{"acceptance_policy":"human"}'
HTTP/1.1 200 OK
```

读回（listing 过滤）：

```
acceptance_policy: None           ← 仍然空
verification_plan: {'commands': ['echo ok']}   ← 写入了
```

服务端 [`UpdateBody` (L337-377)](../../crates/harness-server/src/requirements_routes.rs#L337)：

```rust
struct UpdateBody {
    title / description / status / conversation_ids / verification_plan(3-state)
    / triage_state / depends_on / label_ids / workflow_id
    // ❌ 没有 acceptance_policy
}
```

### 3.4 F-NEW (L)：上游真因

```rust
// crates/harness-project/src/requirement.rs:123-128
/// Legacy internal field retained for older storage rows. Jarvis
/// now owns both progression and completion by evaluating the
/// execution checklist, so this is omitted from the public wire
/// shape and no longer drives auto mode.
#[serde(default, skip)]
pub acceptance_policy: AcceptancePolicy,
```

由 `a7d6377` (2026-05-14) 落入。**API 不接受 acceptance_policy 是设计选择，
不是 bug**。但是：

- [`CLAUDE.md`](../../CLAUDE.md) "Acceptance policy" 一节
  （文末环境变量段 `JARVIS_REVIEWER_AUTO_ACCEPT`）仍然描述：
  > `Subagent` (default) auto-flips Review→Done **unless**
  > `JARVIS_REVIEWER_AUTO_ACCEPT` is set, …
  > `Human` keeps the row at Review (the picker also skips it) …

- auto_mode 单测 [`tick_skips_human_acceptance_policy_at_review`
  (L2715-2734)](../../crates/harness-server/src/auto_mode.rs#L2715) 的
  docstring 与断言相反：

  ```rust
  /// Legacy `AcceptancePolicy::Human` no longer blocks Jarvis.
  /// Jarvis owns both progression and completion.
  let n = tick(&state, &cfg()).await.unwrap();
  assert_eq!(n, 1, "Human policy row at Review is still Jarvis-owned");
  ```

- 兄弟测试 `tick_advances_human_policy_in_progress_to_review`
  断言：InProgress + Human → 完成后停在 **Review**（不再自动 Done）。

**结论**：现在 `AcceptancePolicy::Human` 的语义是"完成后停在 Review，
但 Review 行依然会被 tick 重拣"，且**调用方根本无法通过 API 设置该字段**，
全部默认 `Subagent`。CLAUDE.md 关于 "Human keeps the row at Review (the
picker also skips it)" 的描述**与 5/14 之后的代码事实直接矛盾**。

> 建议：(a) 删 CLAUDE.md 该段；(b) 让 `tick_skips_human_acceptance_policy_at_review`
> 改名为 `tick_picks_human_acceptance_policy_at_review`（当前名字让 grep
> 出现误导）。两条都在小窗口里可以一并修。

---

## 4. F-NEW (M/N) —— 运维侧的隐性死锁

### 4.1 F-NEW (M)：approved 行全部无 assignee

`auto_mode::tick` 的硬过滤之一是 `assignee_id.is_some()`（CLAUDE.md 也写了）。
今天对 `e48ca961`（Servlet Automation Probe）跑：

```
$ curl '.../v1/projects/e48ca961.../requirements?triage_state=approved'
total: 8
  195e30d2 backlog  assignee=-   PROBE 2026-06-13: ...
  11dcf44d backlog  assignee=-   PROBE 2026-06-12: ...
  3f0389d0 review   assignee=-   Probe: add notes/...
  922a7ae7 review   assignee=-   Probe: add HTML lang attribute to HelloServlet output
  605f45be review   assignee=-   Probe: default name to 'anonymous' instead of 'world'
  e1cab113 done     assignee=-   Add servlet-test integration test for escaped output
  9029d0a7 review   assignee=-   Buffer response writer in HelloServlet
  f84cb180 done     assignee=-   Escape `name` parameter in HelloServlet to fix XSS
```

**8/8 都没有 assignee**。这意味着：

- 即使 `JARVIS_WORK_MODE=auto` 打开，tick 也**一行都不会拣选**
- 现有的 `requirement.create` 工具与 `POST /v1/projects/:id/requirements`
  都**没把 assignee 列为必填**，也没默认绑定调用方
- 单测 `tick_skips_review_when_no_assignee` 之类的覆盖（如果存在）只能
  证明 "skip"，但没法防止生产里**所有行都缺 assignee 而 0% 进入 tick**

这是 6/12 报告**遗漏**的运维层死锁：报告写"mode=off 就够死锁了"，但是
**就算 mode 修了，库存也跑不动**。

### 4.2 F-NEW (N)：5.4 GiB 孤儿 worktree

```
GET /v1/diagnostics/worktrees/orphans →
{ items: [{
    path: ".jarvis/worktrees/issue-43",
    run_id: "issue-43",
    size_bytes: 5_768_596_131,
    modified_at: "2026-05-29T08:49:53Z"
}] }
```

存在 15 天；`/v1/diagnostics/worktrees/orphans` 路由有，但没有触发清理的
路由 / 自动任务运行起来。`run_id="issue-43"` 看起来是 GitHub Issue 43 的
工作流副本，但 `/v1/diagnostics/runs/recent` 没有对应记录（这 5 days 内
所有 recent run 都是 6/05 的 Servlet 相关）。

> 建议：在 jarvis 启动 supervisor 时跑一次 GC，
> 或者在 6/13 这次 scheduled-task 复用 DELETE `/v1/runs/issue-43/worktree` 路由
> 把它清掉。**今天没动**（怕影响 6/14 复测）。

---

## 5. harness.health 信号（MCP 6/13 vs 6/12）

完整 JSON 落盘到
[`mcp-probe-2026-06-13.json`](./mcp-probe-2026-06-13.json)。

```
diff mcp-probe-2026-06-12.json mcp-probe-2026-06-13.json
```

唯一的差异是 `harness.health` payload 里的一个时间戳：

```
- "generated_at": "2026-06-11T19:09:28.029979+00:00",
+ "generated_at": "2026-06-12T19:11:36.901582+00:00",
```

其它**全部字节相同**：

| 指标 | 6/11→6/12→6/13 |
|---|---|
| `overall_score` | 57 / 57 / **57** |
| `confidence` | 0.163 / 0.163 / **0.163** |
| `sample_count` | 5 / 5 / **5** |
| `primary_focus` | task_understanding (3×) |
| `actions[0]` | stabilize_delivery_gate (danger, 3×) |
| `signals.observed_runs` | 5 / 5 / **5** |
| `signals.tool_runs` | 5 / 5 / **5** |
| `signals.tool_success_rate` | 0.8 / 0.8 / **0.8** |
| `signals.p95_latency_ms` | 129 / 129 / **129** |
| `error_hotspots[0]` | `ask.text` × 1 (3×) |
| `sources.observability.rows` | 5 / 5 / **5** |
| `sources.requirement_runs.rows` | 0 / 0 / **0** |
| `sources.evals.rows` | 0 / 0 / **0** |

**判读**：5 个 observed runs 是 May 26-31 的历史快照；从 6/05 以后**没有
新的 tool/agent run 被 observability 记录**。harness.health 仍然**唯一可
信的自描述信号源**，但它告诉我们的所有事实都已经稳定 7 天没动。
"actions[0] = stabilize_delivery_gate" 是字面真相，但 7 天内没有任何人/
agent 朝这个方向动一行。

> 这也解释了 §1.2 里 `last_tick_at` 每天推进的现象：supervisor 心跳 ≠
> tick 真的跑过；只要 mode=off 且 sample_count 不增长，harness.health
> 的所有 driver 都不会变。

---

## 6. 工具表（MCP `tools/list`）

`mcp-probe-2026-06-13.json` 里的 `tools_list.result.tools[*].name` 列出来与
6/12 完全一致，工具集没有增删，按 group 排：

- 基础：`echo`, `time.now`
- HTTP：`http.fetch`
- 文件系统 (read-only)：`fs.read`, `fs.list`
- 代码 / git：`code.grep`, `git.status`, `git.diff`, `git.log`, `git.show`
- 工作区上下文：`workspace.context`, `project.checks`, `triage.scan_candidates`
- 计划 / 询问：`plan.update`, `ask.text`
- 健康：`harness.health`
- TODO：`todo.list`, `todo.add`, `todo.update`, `todo.delete`

（写工具与 `requirement.*` / `roadmap.*` / `memory.*` / `doc.*` / `subagent.*`
等在 mcp-probe 进程里**没有注册**——因为探针把 `JARVIS_FS_ROOT` 指向夹具
并用了独立的 `/tmp/mcp-probe-store`，未开 `JARVIS_ENABLE_FS_WRITE` 等开关、
未连 ProjectStore。这是预期的隔离行为。）

### 6.1 `triage.scan_candidates` 在夹具上的输出

复测 `output/jarvis-auto-test/servlet-fixture/`：

- `LoginServlet.java:34` SQL string concat → 候选
- `LoginServlet.java:42` raw `username` echo → 候选
- 5 条 seed defect 全部命中
- 与 6/12 结果**字节相同**（夹具未改）

### 6.2 `harness.health(limit=5, include_evidence=false)` 输出

见 §5；与 6/12 等价。

---

## 7. 死锁拓扑（持续追踪）

| 编号 | 现象 | 自 | 至今天 | 状态 vs 6/12 |
|---|---|---|---|---|
| D1 | `JARVIS_WORK_MODE=off`，全局调度关 | (默认) | … | 同 |
| D2 | `f4a78fc3-…` kimi 262144 撞墙连续 3 次失败 | 2026-06-05 | 8 天 | +1 天 |
| D3 | `last_tick_at` 在 mode=off 下仍每天推进 1 次（supervisor 心跳） | 2026-06-11 起 | 2 天 | **新**（6/12 时只能观察 1 个点） |
| D4 | observability `rows=5`、`sample_count=5`，无新增 | 2026-05-31 后 | 13 天 | +1 天 |
| D5 | 5 个 project `automation.auto_mode_enabled=true` 形同摆设 | … | … | 同 |
| D6 | F-NEW (M)：approved 行 100% 无 assignee | (库存上看)≥1 月 | … | **新**（6/12 未量化） |
| D7 | F-NEW (N)：`issue-43` 孤儿 worktree 5.4 GB | 2026-05-29 | 15 天 | **新**（6/12 未量化） |
| D8 | F-NEW (L)：CLAUDE.md acceptance_policy 文档与代码漂移 | 2026-05-14 后 | 30 天 | **新** |
| D9 | canonical demo 工作树脏挂、Jarvis 改了但没 commit | 2026-05-09 | 35 天 | **新**（6/12 未列） |

---

## 8. 本日"生成测试需求"交付物

```
POST /v1/projects/e48ca961-cffe-4dcc-9c2e-0486363ddde4/requirements
  201 Created → id=195e30d2-5c5c-4268-965f-078c0b8542c5
PATCH /v1/requirements/195e30d2...  verification_plan={commands:[echo ok]}   200 OK
PATCH /v1/requirements/195e30d2...  acceptance_policy="human"                200 OK (no-op)
```

- 标题：`PROBE 2026-06-13: re-test F-NEW(J/K) — verification_plan + acceptance_policy on create`
- 描述：`Scheduled-task iteration #4. Asserts the canonical 6/12 finding still holds: POST silently discards both fields. Verification plan claimed at create is asserted against the stored row by the probe driver.`
- 状态：`backlog`，`triage_state=approved`，`assignee_id=None`（F-NEW (M) 触发）
- 验证：`{"commands":["echo ok"], "files":[]}` —— 零成本副作用，可被 6/14
  scheduled-task 当 baseline 拿来对：(a) F-NEW (J) 是否还在；(b) `verification_plan`
  字段是否还能 round-trip；(c) 是否有人加了 GET /:id 路由。

---

## 9. 给下一轮 scheduled-task 的建议清单

1. **覆盖 F-NEW (M)**：scheduled-task 在创建探针 Requirement 时主动 `PATCH`
   绑定一个 `assignee_id`（任意 AgentProfile id），把 tick 可达性的另一半盖住。
2. **每天对 `harness.health` 算一次 BLAKE3 hash 落盘**：如果连续 N 天 hash
   不变，就只输出 1 行 "stable since 6/11"，节省迭代成本。
3. **加 D2 倒计时**：`f4a78fc3-…` 现在 8 天，自动报告里直接给 "since X days"，
   超过 14 天升级到 tl;dr 顶部。
4. **F-NEW (J) 与 F-NEW (L) 二选一收口**：要么补 API 字段（拒绝 5/14
   的设计），要么删 CLAUDE.md 段落 + 改单测名字（认账 5/14 的设计）。
   **不要长期同时矛盾**。
5. **F-NEW (N) 一次性 GC**：调用
   `DELETE /v1/diagnostics/worktrees/orphans/issue-43`（若存在）或
   手工 `rm -rf .jarvis/worktrees/issue-43` 回收 5.4 GB。
6. **canonical demo 状态机问题（D9）**：scheduled-task 应该在跑之前先
   `git -C ~/Documents/GitHub/jarvis-servlet-demo status --short` 拍一张
   照片落盘，便于追踪 35 天工作树脏挂会不会被某次 Jarvis run 自洽清理。

---

## 10. 关联元数据

- 上次报告：[2026-06-12](./diagnostic-report-2026-06-12.md)
- 上上次：[2026-06-11](./diagnostic-report-2026-06-11.md)
- 起源：[2026-06-10](./diagnostic-report.md)
- canonical 6/9（外部仓）：`~/Documents/GitHub/jarvis-servlet-demo/JARVIS_AUTO_MODE_DIAGNOSTIC_2026-06-09.md`
- 探针脚本：[`output/jarvis-auto-test/mcp_probe.py`](./mcp_probe.py)
- 本日 MCP 原始 JSON：[`mcp-probe-2026-06-13.json`](./mcp-probe-2026-06-13.json)
- 本日新建探针 Requirement：`195e30d2-5c5c-4268-965f-078c0b8542c5`

— *Generated by scheduled-task `coder-task` on 2026-06-13 (local CST) /
  2026-06-12T19:11Z (UTC).*
