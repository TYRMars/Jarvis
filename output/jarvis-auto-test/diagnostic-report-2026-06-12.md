# Jarvis 项目自动化能力 — 诊断报告（迭代 #3）

- **运行时间**: 2026-06-12（scheduled-task `coder-task`，第三次自动跑）
- **被测系统**: Jarvis monorepo @ `feat/chat_spec` / HEAD `c2e3926`（HEAD 与
  [2026-06-10 报告](./diagnostic-report.md) /
  [2026-06-11 报告](./diagnostic-report-2026-06-11.md) **再次同一 commit**，
  Jarvis 树本身 5 天没动）
- **本次最大状态变更（vs 6/11）**:
  - **`jarvis serve` 又活了** — PID `45720` 在 7001 端口监听，已运行 ~27 h。
    [2026-06-09 的 canonical 报告](#%E5%85%B3%E8%81%94%E5%85%83%E6%95%B0%E6%8D%AE)
    （`jarvis-servlet-demo` 仓库内的那份）当时它已冷启 72 h，所以本次活回来是
    *运维侧*的复活而不是 Jarvis 修复。可 `curl /v1/auto-mode` 看到
    `{ mode: "off", enabled: false, last_tick_at: "2026-06-11T19:10:59Z" }`
    —— **进程在线但调度仍然关闭**，原先"冷启 6 天"的死锁被替换成了
    "热启但闲置"的新形态。
  - **canonical Servlet 测试项目浮现** —— 在 `~/Documents/GitHub/jarvis-servlet-demo/`
    下发现 10 份历史报告（2026-05-10 → 2026-06-09），表明 *真正* 的 Servlet
    自动化测试项目并不是 [`servlet-fixture/`](./servlet-fixture/)（那是
    6/10 现造的本地夹具），而是这个 git 同侪仓库。**6/10 + 6/11 的报告
    走错了被测对象**，今天对齐到 canonical。
- **被测 "Servlet 测试项目"**:
  - **canonical**: project `e48ca961-cffe-4dcc-9c2e-0486363ddde4`
    = `Servlet Automation Probe` 与 `55e070fb-e11e-4a40-b047-2080509baf6f`
    = `jarvis-servlet-demo`（两者都在本机存储里活跃）
  - **secondary**: [`output/jarvis-auto-test/servlet-fixture/`](./servlet-fixture/)
    （延续 6/10、6/11 报告里的合成夹具，今天用于复测 MCP 工具表）
- **执行边界**:
  - 没有 LLM 凭据，因此**没有触发 agent 循环**（即使 `jarvis serve` 在线）
  - `JARVIS_WORK_MODE=off` 默认值，全局自动调度关闭
  - 5 个 project 的 `automation.auto_mode_enabled = true` 仍然不会触发 tick
  - 本次**有一次写入**：在 `Servlet Automation Probe` 项目下创建了一个
    探针 Requirement（`11dcf44d-5d1b-4088-9334-152eaab28c4c`） —— 这是本日
    "生成测试需求" 任务的直接交付物，并用它发现了一个**新**的 API
    smoking-gun（见 §3）

---

## 0. tl;dr

1. **Harness 编译 / 单测 / lint 仍然全绿**（`make check` / `auto_mode::` 43 ok /
   `diagnostics::` 9 ok），与 6/10、6/11 完全一致。代码侧没有回归。
2. **运维侧最大新增信号** —— `jarvis serve` 在 6/11 18:11 UTC 左右**自然复活**了
   一次（uptime 27 h），但 `mode=off`、`last_tick_at=2026-06-11T19:10:59`。
   也就是说 6/9 报告里 "F11 ≈ 72 h cold" 现在变成 "活但闲置 27 h"，**调度死锁
   形态不同了但本质相同：没有产出**。
3. **🟥 新 smoking-gun — F-NEW (J)**: `POST /v1/projects/:id/requirements`
   **静默丢弃** `verification_plan` 和 `acceptance_policy`，因为
   [`CreateBody`](../../crates/harness-server/src/requirements_routes.rs#L240)
   结构压根没有这两个字段，serde 默认忽略未知键。`PATCH /v1/requirements/:id`
   也**只**接受 `verification_plan`，`acceptance_policy` 在
   [`UpdateBody`](../../crates/harness-server/src/requirements_routes.rs#L338)
   里同样缺席。今天用 `POST → PATCH → 读盘` 的实测序列把这条钉死了，**这是
   canonical 6/09 报告 F-NEW (H) "16/16 Servlet reqs 缺 verification_plan"
   的根因**：不是 operator 忘记填，是 API 不让填。
4. **🟧 副发现 — F-NEW (K)**: `/v1/requirements/:id` 路由**没有** GET 方法
   ([routes 注册表 L88-L113](../../crates/harness-server/src/requirements_routes.rs#L88))。
   要读单条 Requirement 必须 list 父 project 后过滤，或直接读 JSON store。
   外部脚本想 "create → verify" 走不通最短路径，目前要 list 一次。
5. **harness.health 再次成为唯一可信的自描述信号源**:
   `overall_score=57`, `confidence=0.16`, `sample_count=5`, `primary_focus=
   "task_understanding"`, `actions[0]=stabilize_delivery_gate (danger)`
   —— 数字与 6/11 字节一致（5 个观察样本仍然全部是 May 26-31 的历史遗物，
   既然 auto-loop 没跑过，新样本就不可能产生）。
6. **持久死锁** —— `f4a78fc3-…` "优化 TODO board Web UI 交互与视觉体验" 的
   kimi 262144 token 上限失败已经从 2026-06-05 静止 7 天，3 次连续失败，
   是 `/v1/diagnostics/runs/failed` 里仅有的内容。
7. **本日"生成测试需求"** —— 1 张探针 Requirement
   `11dcf44d-5d1b-4088-9334-152eaab28c4c` 创建在 `Servlet Automation Probe`
   项目下，标题 `PROBE 2026-06-12: minimal req with verification_plan +
   acceptance_policy`。它本身是一颗安全的零成本探针（验证命令
   `["echo ok"]`），用来：
   - 复测 API 是否接受常规字段（结论：title/description/status/triage_state ✅）
   - 复测 API 是否接受治理字段（结论：verification_plan ❌ on create，
     ✅ on patch；acceptance_policy ❌ everywhere）
   - 给下一轮 scheduled-task 留下一个 "已知存在、已知字段齐全" 的 baseline 行

---

## 1. Harness 自身健康（与 6/11 对比）

### 1.1 编译 + 单测

| 信号 | 6/10 | 6/11 | **6/12** | Δ |
|---|---|---|---|---|
| `cargo test -p harness-server --lib auto_mode::` | 43 / 0 | 43 / 0 | **43 / 0** | 0 |
| `cargo test -p harness-server --lib diagnostics::` | 9 / 0 | 9 / 0 | **9 / 0** | 0 |
| `cargo build -p jarvis --bin jarvis` | 退 0 | 退 0 | **退 0** | 0 |
| 编译警告 | 0 | 0 | 0 | 0 |

> 工具版本：仓库 pinned toolchain；运行环境 macOS 15.5 (Darwin 25.5.0)，arm64。
> 与 6/11 完全等效。HEAD 5 天没动，这一节本就只是复核。

### 1.2 live `jarvis serve`（**本日新增的可观测面**）

```
PID    : 45720
ELAPSED: 01-03:01:09        # ~27 h
ROOT   : /Users/zhangjianan/Documents/GitHub/Jarvis    # 注意：是 Jarvis 仓库
LISTEN : *:7001
/health: {"status":"ok"}
```

`GET /v1/auto-mode`：

```json
{
  "enabled": false,
  "mode": "off",
  "effective_mode": "off",
  "last_tick_at": "2026-06-11T19:10:59.629534+00:00",
  "tick_seconds": 30,
  "max_concurrent_units": 2,
  "max_units_per_tick": 1,
  "max_retries": 3,
  "effective_max_retries": 3,
  "available_permits": 2,
  "run_timeout_ms": 600000,
  "configured": true
}
```

→ 运行时**完全在线**（permit 池就绪，tick 间隔 30 s 已注册），但 `mode=off`
等价于"自动调度阀门关闭"。`last_tick_at` 2026-06-11T19:10:59 是 22 分钟前 ——
也就是这台 jarvis 进程**在思考要不要 tick**，但每次 tick 都立即看到
`mode=off` 然后空跑结束。**这是新的一种"非死锁但也无产出"形态**，比 6/9
报告里的"进程不在线"更隐蔽，需要新增运维监控来识别。

### 1.3 dashboards

`GET /v1/work/overview`（窗口 7 天，截止 2026-06-11T19:11:08 UTC）:

```json
{
  "counts":   { "backlog": 5, "done": 29, "in_progress": 10, "review": 12 },
  "runs":     { "completed": 5, "failed": 3, "cancelled": 0 },
  "missing_stores": [],
  "running_now": [],
  "blocked_requirements": []
}
```

> backlog 5 ↑6 after my probe ↓ 注：以下"backlog 6"是本次 POST 之后的现场。
> 上表是 POST 之前的快照（API 返回时间 19:11:08 早于 POST 时间 19:12:41）。
> **POST 之后** 我又抓了一次 overview，counts = `backlog 6 / 29 / 10 / 12`，
> 单点 +1 落在 backlog —— 印证 Requirement 已写入。

`recent_failures[]` 三条都是 **同一个 Requirement (`f4a78fc3-…`)** 的 kimi
262144 token cap：

| run id | finished | requested tokens | error |
|---|---|---|---|
| `30360385-…` | 2026-06-05T09:57:40Z | **312602** | exceeded model token limit 262144 |
| `b755420d-…` | 2026-06-05T09:52:10Z | **290754** | 同上 |
| `90cde3bf-…` | 2026-06-05T09:42:50Z | **339758** | 同上 |

模型 `kimi-k2.6`，目标项目 `Jarvis Roadmap`，目标 Requirement 标题
"优化 TODO board Web UI 交互与视觉体验"。这是 6/9 报告 F-new-B 的延续，
**7 天没动过**，没有重试，没有降级到不同模型。

`/v1/diagnostics/runs/stuck?limit=10` = `{"items":[]}` — 没有卡住的 run，
**因为没在跑**（auto-mode 关）。

`/v1/diagnostics/worktrees/orphans` 仍然命中那个老对象：

```json
{
  "path": "/Users/zhangjianan/Documents/GitHub/Jarvis/.jarvis/worktrees/issue-43",
  "run_id": "issue-43",
  "modified_at": "2026-05-29T08:49:53Z",
  "size_bytes": 5768596131
}
```

→ **5.77 GB 孤儿 worktree**，5/29 之后 14 天没人清。6/9 报告 F12 描述的
"11 d"今天到了 14 d，按 ~400 MB/d 增速（虽然 mtime 没更新就不会再涨）
不变。这是个明确的 `POST /v1/diagnostics/worktrees/cleanup` 候选。

---

## 2. 被测 Servlet 项目对齐

### 2.1 三条线索

| 路径 | 角色 | 由谁创建 | 当前状态 |
|---|---|---|---|
| `~/Documents/GitHub/jarvis-servlet-demo/` (git, 1 commit, working tree dirty) | **canonical** Servlet 测试项目（持续被 jarvis 操作） | 用户手工 init | `pom.xml` ✅ `src/main/java/com/example/HelloServlet.java` ✅ + `HealthServlet.java` + 已 staged 的测试 `HelloServletTest.java` |
| project `55e070fb-…` "jarvis-servlet-demo" | 上面这条在 jarvis store 里的镜像 | jarvis 创建 | 10 reqs（done 4 / review 6），全部缺 `verification_plan` |
| project `e48ca961-…` "Servlet Automation Probe" | 同源探针项目 | jarvis 创建 | **7 reqs**（POST 后），新增的 `11dcf44d-…` 是今天的探针 |
| [`output/jarvis-auto-test/servlet-fixture/`](./servlet-fixture/) | **本地合成夹具**，6/10 现造 | 6/10 报告作者 | 没在 jarvis store 里有 project，纯文件系统对象 |

→ 6/10、6/11 报告**所谓 "Servlet 测试项目"实际是本地夹具**，跟用户线下用的
canonical 项目（10 份历史诊断的目标）**不是同一对象**。今天起以
`Servlet Automation Probe` (`e48ca961-…`) 作为 "项目自动化能力" 的官方
被测项目，本地夹具沦为 *MCP 工具复测 fixture*。

### 2.2 Servlet Automation Probe 当前清单（POST 后）

```
id        title                                            status   verification_plan
11dcf44d  PROBE 2026-06-12: …vp+ap                         backlog  ✅ {commands:["echo ok"]}
3f0389d0  Probe: add notes/2026-06-06-harness-probe.md     review   ❌ null
922a7ae7  Probe: add HTML lang attribute to HelloServlet   review   ❌ null
605f45be  Probe: default name to 'anonymous'               review   ❌ null
e1cab113  Add servlet-test integration test for escaped …  done     ❌ null
9029d0a7  Buffer response writer in HelloServlet           review   ❌ null
f84cb180  Escape `name` parameter in HelloServlet (XSS)    done     ❌ null
```

→ **7 中 6 个**没有 verification_plan。这跟 6/9 报告说"16/16 Servlet reqs
缺 verification_plan, 默认 acceptance_policy"的样本完全自洽。今天创建的
`11dcf44d-…` 是**整个项目里第一个**在 `verification_plan` 字段非空的 Requirement
—— 但走的不是 create 端口，是先 create + 后 PATCH（详见 §3）。

---

## 3. 🟥 F-NEW (J) — `verification_plan` / `acceptance_policy` 在 create 端口被静默丢弃

### 3.1 实测序列

```
POST /v1/projects/e48ca961-…/requirements
body = {
  "title": "PROBE 2026-06-12: …",
  "triage_state": "approved",
  "acceptance_policy": "Subagent",        # ← 在 body 里发送
  "verification_plan": {                  # ← 在 body 里发送
    "commands": [
      {"command":"echo ok","description":"smoke-test placeholder"}
    ]
  }
}

→ 201 Created
   body: { id: "11dcf44d-…", status: "backlog",
           # ❌ 既没有 verification_plan，也没有 acceptance_policy
         }

→ on-disk record (~/.local/share/jarvis/conversations/requirements/.../11dcf44d-…json):
   { id, project_id, title, description, status, conversation_ids, todos, ...
     # ❌ 同样没有这两个字段
   }
```

`triage_state` 字段被默认值 `approved` 处理（serde 跳过默认值），**实际 round-tripped 正确**。

### 3.2 根因 —— `CreateBody` 没有这两个字段

[`crates/harness-server/src/requirements_routes.rs:240-279`](../../crates/harness-server/src/requirements_routes.rs#L240)：

```rust
#[derive(Debug, Deserialize)]
struct CreateBody {
    title: String,
    #[serde(default)] description: Option<String>,
    #[serde(default)] status: Option<String>,
    #[serde(default)] triage_state: Option<String>,
    #[serde(default)] depends_on: Option<Vec<String>>,
    #[serde(default)] todos: Option<Vec<CreateRequirementTodoBody>>,
    #[serde(default)] label_ids: Option<Vec<String>>,
    // ← 没有 verification_plan: …
    // ← 没有 acceptance_policy: …
    // ← 没有 workflow_id: …
}
```

serde 默认行为是"忽略未知字段"，所以 POST 不会报错，operator 完全看不到
他发的字段被吞了。

### 3.3 PATCH 部分修复，但 `acceptance_policy` 还是死路

[同文件 L335-L377](../../crates/harness-server/src/requirements_routes.rs#L335):

```rust
#[derive(Debug, Deserialize)]
struct UpdateBody {
    #[serde(default)] title: Option<String>,
    #[serde(default)] description: Option<String>,
    #[serde(default)] status: Option<String>,
    #[serde(default)] conversation_ids: Option<Vec<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_plan")]
    verification_plan: OptionalPlan,    # ✅ 在 PATCH 这里
    #[serde(default)] triage_state: Option<String>,
    #[serde(default)] depends_on: Option<Vec<String>>,
    #[serde(default)] label_ids: Option<Vec<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_workflow")]
    workflow_id: OptionalWorkflow,      # ✅ 在 PATCH 这里
    // ← 还是没有 acceptance_policy: …
}
```

实测 PATCH 成功：

```
PATCH /v1/requirements/11dcf44d-…
body = {"verification_plan":{"commands":["echo ok"]},"acceptance_policy":"Subagent"}
→ 200
  body.verification_plan = {commands: ["echo ok"]}   ✅
  body.acceptance_policy = null                       ❌ 仍然被丢
```

> 小坑：`VerificationPlan.commands` 实际是 `Vec<String>` 而不是
> `Vec<{command, description}>`，第一次 PATCH 因为字段类型错配返回 422
> "expected a string"。CLAUDE.md 把 `VerificationPlan` 当宝贝引但**没贴 wire schema**。

### 3.4 全代码库搜证

```
grep -rn "acceptance_policy" crates/harness-server/src/
→ auto_mode.rs: 仅测试代码里手工 set
→ requirements_routes.rs:728 仅在 approve_endpoint 里"如果不是 Subagent 就不调 reviewer"
```

```
grep -rn "acceptance_policy" crates/harness-tools/src/
→ (no output)
```

→ **整个 server + tools 层**没有任何一处把 `acceptance_policy` 暴露到 wire
（除了测试夹具的 `req.acceptance_policy = …` 直接 mutation）。要把一行
Requirement 设成 `Human` policy，今天**只能**通过 Rust 代码直接构造
`Requirement` 值或直接编辑 JSON store —— 没有任何 HTTP / MCP / CLI 入口。

### 3.5 与 canonical 6/9 报告 F-NEW (H) 的关系

6/9 报告 F-NEW (H) 写道：

> "[…] default `acceptance_policy` + missing `verification_plan` means
> Review→Done never fires" — the reviewer-subagent path is structurally
> unreachable on all 16/16 Servlet reqs (`verification_plan=no`,
> `acceptance_policy=default` across the board)."

那份报告把这归因为"数据结构性缺失"。今天的实测把它升级为**"API 结构性缺失"**：

| 谁动得了 | `verification_plan` | `acceptance_policy` |
|---|---|---|
| `POST /v1/projects/:id/requirements` | ❌ 静默丢弃 | ❌ 静默丢弃 |
| `PATCH /v1/requirements/:id` | ✅ 三态 (omit/null/set) | ❌ 静默丢弃 |
| `requirement.*` 工具（agent-side） | ❌ 同样没有暴露 | ❌ 同样没有暴露 |
| 直接写 store JSON | ✅ (手动) | ✅ (手动) |

→ **16/16 Servlet reqs 缺 verification_plan，不是 operator 忘了填，是 API
没让填。要进 review→done 的 reviewer-subagent 自动闭环，今天的最小 patch 是：**

1. `CreateBody` 加 `verification_plan: Option<VerificationPlan>` 字段
2. `CreateBody` + `UpdateBody` 同时加 `acceptance_policy: Option<AcceptancePolicy>`
3. `requirement.create` / `requirement.update` 两个工具同样补字段
4. CLAUDE.md 的 "Approval policy" 段落把 wire schema 贴出来

这是一条**单 crate 单文件**的小补丁（顶多两个文件 + ts-codegen）。**今天没有
动手**因为 scheduled-task 的写动作仅限于"生成测试需求"；改 Jarvis API
表面属于代码改动，应由用户走正常 PR 流程。已用 §7 行动项 #1 标出。

---

## 4. 🟧 F-NEW (K) — `/v1/requirements/:id` 没有 GET

```
GET /v1/requirements/11dcf44d-… → 405 Method Not Allowed
```

[`requirements_routes.rs:93-96`](../../crates/harness-server/src/requirements_routes.rs#L93)
只注册了 `patch + delete`：

```rust
.route(
    "/v1/requirements/:id",
    patch(update_requirement).delete(delete_requirement),
)
```

读单行 Requirement 必须走 `GET /v1/projects/:project_id/requirements`
然后客户端过滤 id。**外部脚本想 "create → fetch → assert" 的循环路径多走
一跳**，今天实测里我也踩了一脚 —— 第一次 GET 返回 405，我误以为是 jq
parse 错误，绕了一段路才发现。

REST 维度的最小补丁：

```rust
.route(
    "/v1/requirements/:id",
    get(get_requirement).patch(...).delete(...),
)
```

`get_requirement` 实现就是 `store.get(&id).await` + 404/json 包装，大概
10 行 Rust。**今天没动手**，原因同 §3.5。

---

## 5. `harness.health` 实测（与 6/11 对比）

通过 [`mcp_probe.py`](./mcp_probe.py) 跑 `--mcp-serve` 拉起本地 binary（**不**
是上面 7001 的 long-running serve），20 个工具注册（与 6/11 一致），关键
出参：

```
overall_score : 57 / 100        # 与 6/11 字节一致
confidence    : 0.16             # 与 6/11 字节一致
primary_focus : task_understanding
sample_count  : 5
```

5 条样本仍然全部来自 `~/.local/share/jarvis/observability/` 的 May 26-31
历史遗物，因为 auto-loop 从 6/05 起没跑过新东西。

`actions[]` 五条迭代建议依次：
1. `stabilize_delivery_gate` (danger) — `completed 0 / terminal 0`
2. `reduce_timeout_and_iteration_failures` (warn) — `timeout_like 0, max_iteration_like 0`
3. `tune_tools_and_subagents` (warn) — `tools 5, subagents 0`
4. `sharpen_task_acceptance` (warn) — `capability eval cases 0`
5. `fill_signal_gaps` (neutral) — `sample_count 5`

> 与 6/11 实测**完全相同**——因为输入（5 条 May 历史样本）没变。这也证明
> `harness.health` 是**确定性聚合**：相同输入 → 相同输出。它**确实**可以
> 当外层 loop 的"下一轮迭代方向"信号源（6/11 §4.2 的论点今天复证一次）。

原始 JSON：[`mcp-probe-2026-06-12.json`](./mcp-probe-2026-06-12.json)
（36 KB，与 6/11 文件大小 1-byte 内偏差，结构等价）。

---

## 6. 本日"生成测试需求"交付物

### 6.1 写入操作清单

| # | 时间 (UTC) | 端口 | 方法 | URL | 结果 |
|---|---|---|---|---|---|
| 1 | 2026-06-11T19:12:41 | 7001 | POST | `/v1/projects/e48ca961-…/requirements` | 201; id=`11dcf44d-…`; `verification_plan` 静默丢弃 |
| 2 | 2026-06-11T19:13:33 | 7001 | PATCH | `/v1/requirements/11dcf44d-…` | 200; `verification_plan` ✅ 写入; `acceptance_policy` 仍 null |

净副作用：

- `Servlet Automation Probe` (`e48ca961-…`) 项目下多 1 行 Requirement
- workspace-wide req 计数从 `backlog 5 / done 29 / in_progress 10 / review 12 = 56`
  到 `backlog 6 / 29 / 10 / 12 = 57` —— 与 6/9 报告字节匹配 +1
- 没有触发任何 RequirementRun（auto-mode 关）
- 没有触发任何 worktree mutation
- 没有触发任何 LLM 调用

### 6.2 探针 Requirement 详情

```
id            : 11dcf44d-5d1b-4088-9334-152eaab28c4c
project       : Servlet Automation Probe (e48ca961-…)
title         : PROBE 2026-06-12: minimal req with verification_plan + acceptance_policy
status        : backlog
triage_state  : approved (default, serde-skipped)
verification_plan : { commands: ["echo ok"] }   ← PATCH 写入
acceptance_policy : null                          ← API 无法设置
depends_on    : []
todos         : [
  { kind: check,  title: "Confirm the requirement scope is understood",  status: pending },
  { kind: work,   title: "Implement the customer-visible requirement",    status: pending },
  { kind: review, title: "Verify the requirement is complete",            status: pending },
]
```

→ 这是整个 `Servlet Automation Probe` 项目里**第一个**带 `verification_plan`
的 Requirement。下一轮 scheduled-task 应当：
- 看 `/v1/work/overview.recent_failures[]` 里有没有 `11dcf44d-…` 的 run
  （`auto-mode=off` 状态下不会有）
- 如果用户线下打开 `JARVIS_WORK_MODE=auto`，这条会**立即**被 picker 选中
  （`triage_state=approved` + no inflight + no failed runs + no deps）
- 跑出 1 个 RequirementRun，验证 `verification_plan=["echo ok"]` 是否会被
  `auto_mode::drive_one` 真正执行（这是 6/9 F-NEW (H) 的 down-stream
  待验证点）

### 6.3 为什么只生成 1 张而不是一批

6/9 报告统计当前 12 个 stuck-at-Review 行**全部**已经在等评审。再追加 5
张 Servlet defect 候选只会让 Review 队列从 12 涨到 17，**放大同一个死锁**
而不解决任何问题。今天的 1 张写得**最小且最尖锐**：单一目的（探 API），
单一负载（echo ok），单一对照（同 project 其他 6 行无 verification_plan）。

---

## 7. 根据 harness.health + 实测做的迭代判断

按 `harness.health.actions[]` 的优先级排序，融合 §3-§6 实测：

| 优先级 | tone | 行动项 | 触发条件 | 推荐执行人 |
|---|---|---|---|---|
| 1 | 🟥 | **修 `CreateBody` / `UpdateBody` 暴露 `verification_plan` + `acceptance_policy`** —— 这是 F-NEW (J) 的最小补丁；不修则 reviewer-subagent 自动闭环对所有未来 Requirement 都不可达 | API 缺字段，operator/agent 无写入路径 | dev (源码 PR) |
| 2 | 🟧 | **修 `f4a78fc3-…` 的 kimi 262144 超限 run**：要么降级模型，要么拆需求 | 3 连失败已静止 7 天 | operator + dev |
| 3 | 🟧 | **`POST /v1/diagnostics/worktrees/cleanup`**（路由已存在）回收 5.77 GB 孤儿 worktree | mtime 5/29，14 天未触摸 | operator (curl 一行) |
| 4 | 🟧 | **决策 `JARVIS_WORK_MODE=auto`**：进程在线但调度关闭意味着 5 个 project 的 `auto_mode_enabled=true` 完全是装饰。要么打开，要么 UI 隐藏 toggle | `auto-mode.enabled = false` 已 27 h | operator |
| 5 | 🟦 | **补 `GET /v1/requirements/:id`** —— F-NEW (K)，10 行代码，减少外部脚本回环 | 405 Method Not Allowed | dev (源码 PR) |
| 6 | 🟦 | **CLAUDE.md 补 wire schema 段**：`VerificationPlan` 是 `Vec<String>` 不是结构化对象；`AcceptancePolicy` 实测只有 `Subagent` / `Human` 两种 wire form | 文档与实测不一致 | dev (doc PR) |
| 7 | ⬜ | **observability sample_count=5 仍然不动** —— 想让 `harness.health` 的 `overall_score` 真正可信，需要至少跑一遍真实 auto-loop。每周一次 scheduled-task 拉 serve + 跑合成需求是最低成本方案 | confidence 0.16 已 2 个 cycle | operator |

> 注：上表的 1-3 都是**已存在的代码 / 端点没动**，而不是要造新东西。Jarvis
> 现在的"项目自动化能力"瓶颈不在 capability，而在 wire surface 的**字段缺
> 失**和**配置默认关**。

---

## 8. 风险 / 已知限制

1. **HEAD 5 天没动** —— 自 6/07 `c2e3926` 起 Jarvis 树未推进；任何"哪个 commit
   引入了 F-NEW (J)"的回答都是"自始至今"，不是回归。
2. **本次唯一一次写入是 1 条 Requirement** —— 安全、可逆、可定位。若想删除，
   `DELETE /v1/requirements/11dcf44d-…` 一行即可（端点已注册）。
3. **canonical 项目 `jarvis-servlet-demo`（仓库外）今天没动它的工作树** ——
   6/9 报告里它在 `working tree has uncommitted Probe edits` 状态，今天仍然
   未推进，未提交，未 `git init` `/private/tmp/jarvis-servlet-test`（与
   6/9 报告 §1 第 8 项保持一致）。
4. **`harness.health` 的 `overall_score=57`、`confidence=0.16` 在 sample_count=5
   时不是可信判据**；可信的是 `primary_focus`、`actions[*].tone`、
   `error_hotspots` 这些不依赖样本比例的字段。
5. **本日没有触发任何 LLM 调用**，因此**没法验证** §6.2 探针在 auto-mode
   开启后是否真的会被 picker 选中并跑通 `echo ok` verification —— 这是
   有意的，scheduled-task 不应该绕过 operator 的开关决策。

---

## 9. 复现命令

```bash
# 1) Harness 健康自测（与 6/10 / 6/11 完全可比）
cd /Users/zhangjianan/Documents/GitHub/Jarvis
cargo test -p harness-server --lib auto_mode::
cargo test -p harness-server --lib diagnostics::
cargo build -p jarvis --bin jarvis

# 2) Live 自我描述（要求 jarvis serve 已在 7001 运行）
curl -sS http://127.0.0.1:7001/v1/auto-mode | jq
curl -sS http://127.0.0.1:7001/v1/work/overview | jq
curl -sS http://127.0.0.1:7001/v1/work/quality | jq
curl -sS 'http://127.0.0.1:7001/v1/diagnostics/runs/failed?limit=5' | jq
curl -sS http://127.0.0.1:7001/v1/diagnostics/worktrees/orphans | jq

# 3) MCP 工具表 + harness.health 单跑（无须 LLM key）
python3 output/jarvis-auto-test/mcp_probe.py > output/jarvis-auto-test/mcp-probe-2026-06-12.json

# 4) 复现 F-NEW (J) — verification_plan 在 create 端口被吞
curl -sS -X POST -H 'content-type: application/json' \
  -d '{"title":"repro","verification_plan":{"commands":["echo ok"]}}' \
  http://127.0.0.1:7001/v1/projects/e48ca961-cffe-4dcc-9c2e-0486363ddde4/requirements \
  | jq '{has_vp: (.verification_plan != null)}'
# 期望: { "has_vp": false }     ← 现状
# 修后: { "has_vp": true }
```

---

## 10. 附录

### 10.1 关键文件

| 路径 | 用途 |
|---|---|
| [diagnostic-report.md](./diagnostic-report.md) | 6/10 报告（剧本 + 单测健康） |
| [diagnostic-report-2026-06-11.md](./diagnostic-report-2026-06-11.md) | 6/11 报告（剧本 + 实测 MCP + 健康决策） |
| **diagnostic-report-2026-06-12.md** | 本报告（剧本 + 实测 live API + 新 smoking-gun + 写入） |
| [mcp-probe-2026-06-11.json](./mcp-probe-2026-06-11.json) | 6/11 MCP 原始出参 |
| [mcp-probe-2026-06-12.json](./mcp-probe-2026-06-12.json) | 本日 MCP 原始出参（与 6/11 字节级对照） |
| [mcp_probe.py](./mcp_probe.py) | MCP probe 脚本 |
| [servlet-fixture/](./servlet-fixture/) | 本地 Servlet 合成夹具（**非** canonical 测试项目） |

### 10.2 关联元数据

- canonical Servlet 测试项目历史报告（仓库外，今天未编辑）:
  `~/Documents/GitHub/jarvis-servlet-demo/JARVIS_AUTO_MODE_DIAGNOSTIC_*.md`
  共 10 份（2026-05-10 → 2026-06-09），本报告与其 F-NEW (H) 直接呼应
- jarvis 进程: `pid 45720`, `target/debug/jarvis`, uptime ~27 h
- 探针 Requirement: `11dcf44d-5d1b-4088-9334-152eaab28c4c` in project
  `e48ca961-cffe-4dcc-9c2e-0486363ddde4`
- on-disk store: `~/.local/share/jarvis/conversations/`（57→58 reqs）

### 10.3 最终结论

- ✅ **Harness 健康（代码层）**: 全绿。与 6/10、6/11 字节一致。
- ✅ **Harness 健康（运维层）**: `jarvis serve` 复活，但 auto-mode 关闭，
  等价于"在线但不工作"。
- 🟥 **项目自动化能力（API 层）**: 发现新 smoking-gun（F-NEW J）—
  `verification_plan` / `acceptance_policy` 在 wire 上不可达，
  解释了 canonical 6/9 报告"16/16 Servlet reqs 缺 verification_plan"
  的根因。**这是一个对外明确的 Jarvis 自身 bug，不是 operator 配置问题。**
- 🟧 **harness.health 作为迭代信号源**: 二度复证为确定性聚合，可作为
  外层 loop 的方向选择信号源；但 sample_count=5 不够，需要先跑真实
  auto-loop 让样本爬起来才能用 `overall_score` 做"是否继续"的二分判定。
- ✅ **本日"生成测试需求"任务**: 已交付 1 张安全、可定位、对 §3 有
  直接证据价值的探针 Requirement。

> *与 6/10、6/11 报告的关系*：
> - 6/10 给出"剧本（能力齐全）"
> - 6/11 给出"实测 MCP 工具 + 健康聚合"
> - **6/12 给出"实测 live REST API + 写入一条探针 + 发现 wire surface
>   的硬阻塞"** —— 三份连读，从"代码能跑"到"工具能调"到"端口能写"
>   层层下沉，定位出的瓶颈也从"还没跑"变成"跑的话也写不进关键字段"
