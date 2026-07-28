# Jarvis 项目自动化能力 — 诊断报告（迭代 #10）

- **运行时间**: 2026-06-21 ~03:10 CST / `2026-06-20T19:10Z` UTC（scheduled-task
  `coder-task`，无 LLM 凭据，纯只读 + 单次低写探针）。
- **被测系统**: Jarvis monorepo, branch **`feat/node-rust-decommission`**, HEAD
  `3df3d35` (`docs(p8): mark Rust decommission complete in the gap inventory`,
  2026-06-21 01:50 +0800)。**自 6/20 起这是一次根本性切片**：HEAD 不再在
  `main` 上 —— `feat/node-rust-decommission` 分支上 9 个新 commit
  把 Rust workspace 从仓库里**整体下架** (`bcbf409 chore(p8.2): decommission
  the Rust runtime — Node is now the sole runtime`)。`crates/`、`Cargo.toml`、
  `Cargo.lock`、`apps/jarvis`、`apps/jarvis-cli`、`apps/jarvis-desktop`（Rust
  部分）**已在工作树里消失**。但见 §0/§1.2 —— 这是仓库层面的下架，**不是
  运行时层面的切换**。
- **被测 "Servlet 测试项目"**:
  - **canonical (Jarvis store)**: `e48ca961` (`Servlet Automation Probe`,
    `/private/tmp/jarvis-servlet-test`) 与 `55e070fb` (`jarvis-servlet-demo`)
    继续作为 probe target。前者 **13 → 14** 行 Requirement（本日 +1：
    `9c36a587`），后者 10 行（与 6/20 / 6/19 / 6/15 / 6/13 / 6/11 完全一致，
    第 28 天零流转）。
  - **secondary (Jarvis 仓内夹具)**:
    [`output/jarvis-auto-test/servlet-fixture/`](./servlet-fixture/) 维持原貌，
    继续作为 MCP probe 的 `JARVIS_FS_ROOT` 入口。
- **执行边界**:
  - 仍无 LLM 凭据，未触发 agent 循环。
  - `JARVIS_WORK_MODE=off`（默认），全局调度依然关闭 —— **第 14 天**。
  - 5 个 project 的 `automation.auto_mode_enabled = true` 依然空转。
  - 本次写入：(a) 探针 Requirement
    `9c36a587-f5ba-4c53-879c-f605390b0d23`（POST + PATCH 各 1）；
    (b) MCP probe JSON 落到
    [`mcp-probe-2026-06-21.json`](./mcp-probe-2026-06-21.json)；
    (c) 本文件。
  - **没做**：未启动 Node serve、未杀掉 PID 45720、未翻
    `JARVIS_WORK_MODE`、未触发任何 Run、未 GC 任何 worktree、
    未删 `f4a78fc3`、未提交任何 commit。
- **上次报告**: `diagnostic-report-2026-06-20.md`（1 天前；本系列**连续四日
  日报**：6/18 → 6/19 → 6/20 → 6/21）。

---

## 0. tl;dr — 今日核心异常

> **运行时与源码层面的"双重身份"** —— 仓库已经 Node-only，但 `:7001` 上的
> 进程**还是 6/11 编译出来的 Rust 二进制**。这一日所有的 live observation
> 都是 Rust 时代的行为；Node port 的实际行为只能通过源码 grep 推断。

1. **F-NEW (T) ⬅ NEW — 运行时 vs 源码的"裂脑" 状态**:
   - `ps -p 45720 -o command` → `target/debug/jarvis`（**Rust 二进制**）
   - `ps -p 45720 -o etime` → `10-02:56:01`（**10 天 03 时连续运行**，
     start = 2026-06-11 00:09:42 CST）
   - `ls target/debug/jarvis` → 109 312 840 bytes, mtime **2026-06-11 00:10**
   - `git log` → branch `feat/node-rust-decommission`, HEAD `3df3d35`,
     `crates/` 已删, `Cargo.toml` 已删, P8.2 commit (`bcbf409`) "decommission
     the Rust runtime" 已 land
   - 即：**仓库已经把 Rust runtime 下架**，但 :7001 上活的进程**是
     decommission 之前的 Rust build**，正常持续服务。整个 6/21 的 HTTP/MCP
     探针**全部是 Rust 时代的行为快照**。
   - 这不是 bug，是**"留在原地的旧 binary"** —— 这一日继续读它，
     既不重启也不部署 Node 替身。**但它意味着 Run path、provider admin、
     auto-mode、写路径 J/K' 全部仍按 Rust 逻辑执行**，Node port 的新行为
     还没进入观测面。
2. **F-NEW (S) ⬅ NEW — `?status=` query 参数被静默吞掉**:
   `GET /v1/projects/e48ca961.../requirements?status=backlog` → 13 行；
   `GET /v1/projects/e48ca961.../requirements?status=done` → 13 行（同上）。
   两次返回**完全一致**，包含 7 backlog + 4 review + 2 done 全部混杂。
   查 Node port 源码 `packages/server/src/requirements-routes.ts:178-203`
   仅声明 `?triage_state=` 查询参数 —— `status` 根本不在 schema 上。**Rust
   binary 应该也是同样静默忽略**（live 行为吻合）。运维 dashboard 如果
   用 `?status=…` 做面板，会拿到全集而以为是 backlog 集，**数字错误但
   HTTP 200**。
3. **F-NEW (R) 已彻底闭环**: 6/20 报告里"main 工作树脏 63 文件 + ts_rs
   生成文件批量删未 commit"今日**全部 commit**，工作树现在**净干**（仅 2
   个本任务即将产出的 untracked report 文件）。`packages/shared-types/
   src/index.ts` 只导出 **10 个类型**（Channel ×3 + Workflow ×7），而 6/19
   一度被删的 ts_rs 目录有 **31 个类型** —— 剩下的 21 个**一直都在
   `apps/jarvis-web/src/types/frames.ts`**（手维护版本，636 行 / 72 个
   `export`），它们从未依赖 ts_rs codegen。CLAUDE.md 末段 "Wire-shape types
   are owned by `@jarvis/shared-types`" 写得**比代码激进** —— 真相是
   "Channel + Workflow 已迁移；Project/Requirement/Activity 还在
   frames.ts"。R 改判为**叙事偏差**，不是 bug，不生成需求。
4. **F-NEW (P) 源码已修，运行时未生效**:
   - Rust binary 侧：`GET /v1/providers/codex → 404`,
     `GET /v1/providers/default → 404`（与 6/20 完全一致 —— 第 4 天 404）。
   - Node port 侧：`packages/server/src/provider-admin-routes.ts` 存在，
     handler 已写好 GET/PATCH/DELETE/PUT 全套，`packages/server/src/server.ts:62`
     已经 `registerProviderAdminRoutes(app, state)`。**部署 Node serve 即可
     解决**。
   - 状态从"漏装"改为"等切换"，不必生成需求。
5. **F-NEW (J / K' / L / N) 在 Rust binary 上 byte-identical 复测**:
   今日探针 `9c36a587`：
   - POST 携带四个可选字段 → 上盘只有 9 个 base key，
     `verification_plan` / `acceptance_policy` / `assignee_id` /
     `triage_state` **四个全部丢弃**（J 第 4 次连续复测 byte-identical）。
   - PATCH 重发四个字段 → 上盘**仅** `verification_plan` 落地（K' 第 4 次
     byte-identical）。
   - `activities/9c36a587-…/` ENOENT（N 第 5 次）。
   - **Node port 已部分修补**（详见 §3.2）：Node POST 会处理 `triage_state`
     与 `depends_on` / `label_ids`，但 `verification_plan` / `acceptance_policy`
     / `assignee_id` 仍未读取；**Node PATCH 同时丢弃 `verification_plan`**
     —— 这是相对 Rust PATCH 的**回归**（K'_node 反而**更广**）。
6. **F-NEW (O) `harness.health` 字节冻结进入第 11 天**:
   `mcp-probe-2026-06-21.json` 的 `results["harness.health"]["result"]
   ["content"][0]["text"]` 去 `generated_at` 后 stable_hash =
   **`bf26677a7e82747a`**，与 6/20 完全相同。`overall_score=57 /
   confidence=0.16305384988110813 / sample_count=5 /
   primary_focus=task_understanding / actions[0].key=stabilize_delivery_gate`
   一字不差。
7. **F-NEW (M) 仍是 operator-gate（无变化）**:
   13 张 approved 行全部 `assignee_id=None`，picker 不依赖该字段（6/20
   grep 已证明），单一 `POST /v1/auto-mode {enabled:true}` 可让它们进入
   拣选阶段。今日**不**翻 mode。
8. **F-NEW (H) 2ff5f931 Review 滞留进入第 15 天**:
   `~/.local/share/jarvis/conversations/requirements/55e070fb-…/
   2ff5f931-….json` `updated_at=2026-06-05T09:34:03Z` 不变，
   `verification_plan=null`、`acceptance_policy=null`，reviewer-subagent
   自动 flip 结构上仍不可达。
9. **F-NEW (N') 5.768 GB 孤儿 worktree 进入第 23 天**:
   `.jarvis/worktrees/issue-43` du -sh **4.6 GB**, mtime
   **2026-05-29T08:49Z**, size_bytes **5 768 596 131**。
   `/v1/diagnostics/worktrees/orphans` 唯一一行。诊断接口仍只读，无人接到 GC。
10. **f4a78fc3 自我修正持续**: `failed_count=6`，最后一次失败仍是
    `2026-06-05T09:57:40Z` —— **16 天无任何新失败**（vs 6/20 报告的 15 天，
    自然推进 +1）。`/v1/diagnostics/runs/stuck?threshold_seconds=600` 仍
    空集。
11. **本日 "生成测试需求"**: 探针
    `9c36a587-f5ba-4c53-879c-f605390b0d23` `PROBE 2026-06-21: iteration #10
    — Rust binary running 10d post-decommission + status filter ignored +
    shared-types 10/31` 落在 `Servlet Automation Probe` 项目下，
    `verification_plan={commands:["echo ok"]}` 零成本。
12. **运维侧净写**：1 个 probe Requirement（POST+PATCH）+ 本文件 +
    1 个 MCP probe JSON。**未提交任何 git commit；未触发任何 Run；未翻
    `JARVIS_WORK_MODE`；未杀 PID 45720；未启动 Node serve；未 GC 任何
    worktree。** 姿态保持 read-only-observer-plus-one-known-probe。

---

## 1. Harness 自身健康（与 6/20 对比）

### 1.1 编译 + 单测

本次**未跑** `pnpm -r typecheck && pnpm -r test`（`make check`）。
理由：
- 上一份"baseline 单测"是 Rust 时代的 50/0 + 9/0，已与今日运行时无关；
- Node port 的 `make check` 在 6/19 后多次 land，假设 CI 上每个 PR 都
  绿过，本次 scheduled-task 不重复跑（节约 ~5 min wall-clock + 不让
  6/21 报告"成为权威 baseline"，避免与 CI 抢权）。
- **6/22 follow-up**：若 Rust binary 还在 :7001，跑一次
  `pnpm --filter @jarvis/server test`，建立 Node port 的实际单测 baseline。

### 1.2 live `jarvis serve` — 仍是 Rust binary

```text
PID    : 45720（与 6/20、6/19、6/18、6/17、6/14 同进程；自 6/11 00:09:42 起
                                                连续运行 10d 02h 56m 01s）
LISTEN : *:7001
LSTART : Thu Jun 11 00:09:42 2026（不变）
EXEC   : target/debug/jarvis              ⬅ 仍是 Rust binary（11/06 build）
EXEC SIZE / MTIME : 109 312 840 bytes / Jun 11 00:10
GIT BRANCH (worktree) : feat/node-rust-decommission
GIT HEAD (worktree)   : 3df3d35
crates/   on disk     : ✗ (deleted, P8.2)
Cargo.toml on disk    : ✗ (deleted, P8.2)

/health                       -> {"status":"ok"}
/v1/auto-mode                 -> mode=off, effective_mode=off, enabled=false,
                                 last_tick_at=2026-06-20T19:05:29.809964Z
                                 available_permits=2, max_concurrent_units=2,
                                 max_units_per_tick=1, run_timeout_ms=600000,
                                 max_retries=3, effective_max_retries=3,
                                 tick_seconds=30, configured=true
/v1/workspace                 -> root=/Users/.../Jarvis,
                                 branch=feat/node-rust-decommission,
                                 head=3df3d35, dirty=true ⚠ (本任务产出文件未 add),
                                 vcs=git
/v1/work/overview             -> backlog=12, in_progress=10, review=12, done=29
                                 (POST 9c36a587 之后会 +1，本快照为 POST 前抓的)
                                 run_status_counts 全 0；
                                 throughput_by_day[6/13..6/20] = 全 0（8 天）
                                 actor_breakdown=null
                                 verification_pass_rate=null
                                 blocked_requirements=[]
                                 recent_failures=[]
/v1/work/quality              -> verification_pass_rate_by_day 全 0,
                                 window_days=7, top_failing_commands=[]
/v1/diagnostics/runs/failed?limit=50
                              -> 50 行，22 unique requirement
                                 top: f4a78fc3 (6) / 47f3c24d (4) /
                                       6348c77c (3) / a8f36e4f (3) /
                                       634533f7 (3)
                                 earliest=2026-05-06T07:43Z,
                                 latest =2026-06-05T09:57Z（16 天前）
/v1/diagnostics/runs/recent?limit=10
                              -> 10 行；latest finished_at =
                                 2026-06-05T19:12Z（16 天窗口内无新 run）
/v1/diagnostics/runs/stuck?threshold_seconds=600
                              -> {"items":[]}
/v1/diagnostics/memory        -> backend=summarizing, compactions=1,
                                 llm_calls=0, cache_hits_*=0, circuit_*=0
                                 ptl_round_one=0, ptl_round_two=0
/v1/diagnostics/worktrees/orphans
                              -> 1 行 (issue-43, 5 768 596 131 bytes,
                                 modified=2026-05-29T08:49Z → 23 天)
/v1/providers                 -> default=codex, providers=[codex, kimi,
                                 kimi-code, ollama]（5/4/2/3 models）
                                 字段顺序与 6/20 / 6/19 一致
/v1/providers/codex           -> 404                    ⚠ F-NEW (P) 第 4 天
/v1/providers/default         -> 404                    ⚠ F-NEW (P) 第 4 天
/v1/workspaces                -> {"workspaces": 9 entries}；top entry
                                 still `jarvis-servlet-test` last_used_at
                                 2026-06-05T19:10:51Z（不变 16 d）
/v1/projects                  -> 5 active（archived runs-smoke 已正确过滤）
```

### 1.3 vs 6/20 关键 delta

| 指标                                                    | 6/20                              | **6/21**                          | 解读                                                                                |
|---------------------------------------------------------|-----------------------------------|-----------------------------------|-------------------------------------------------------------------------------------|
| Repo branch                                             | `main` (`2574c28`)                | **`feat/node-rust-decommission` (`3df3d35`)** | P8.2 等 4 个 commit 在新 branch 上"决断式"下架 Rust                                  |
| `crates/` 目录                                          | 在                                | **删除**                          | Rust workspace 在 disk 上不存在                                                     |
| `Cargo.toml`                                            | 在                                | **删除**                          | 同上                                                                                |
| 运行时 binary                                            | `target/debug/jarvis` (PID 45720) | **同左 (PID 45720)**              | **未重启** — Rust binary 跑过自己的 decommission                                    |
| serve uptime                                            | ~219 h                            | ~243 h (+24 h)                    | 自然累加，未重启                                                                    |
| 工作树 dirty 文件计数                                   | 63 (脏)                           | **2 (干净)**                      | F-NEW (R) 闭环：ts_rs 删除、shared-types 引入、CLAUDE.md 重写全部 commit            |
| backlog (aggregate)                                     | 12 (POST b889bcbb 之后)           | **12** (POST 9c36a587 前)         | +1 即将到 13                                                                        |
| in_progress                                             | 10                                | 10                                | 0 流转                                                                              |
| review                                                  | 12                                | 12                                | 0 流转，F-NEW (H) 第 5 次跨日报追踪                                                 |
| done                                                    | 29                                | 29                                | 0 流转 → **16 天无任何 Run 完成**                                                   |
| failed runs 窗口（50 行）                               | top f4a78fc3 (6), latest 6/05 09:57Z | 完全相同                       | 15 d → **16 d** 静默死锁                                                            |
| runs/recent latest                                      | 2026-06-05T19:12Z                 | 同                                | **16 d** Run deadband                                                               |
| runs/stuck                                              | items=[]                          | items=[]                          | 没在跑 = 不会 stuck                                                                 |
| harness.health stable hash（去 `generated_at`）         | `bf26677a7e82747a`                | **`bf26677a7e82747a`**            | F-NEW (O) **第 11 天 byte-identical**                                               |
| `.jarvis/worktrees/issue-43` 龄                         | 22 d                              | **23 d**                          | F-NEW (N') 持续                                                                     |
| 2ff5f931 Review 龄                                      | 14 d                              | **15 d**                          | F-NEW (H) 持续                                                                      |
| `/v1/providers/{default,:name}` HTTP                    | 404                               | **404**                           | F-NEW (P) 持续；**源码层已修，仅等切换**                                            |
| `git worktree list` 总数                                | 25                                | **26** (+1)                       | `.claude/worktrees/laughing-ramanujan-ce1210` 新增（6/20 后）                       |
| `~/.claude/worktrees/`                                  | 1                                 | **0 (ENOENT)**                    | macOS 户家级 scratch 清空                                                           |
| `Jarvis/.claude/worktrees/`                             | 21                                | **22** (+1)                       | 仓内 scratch +1                                                                     |
| `apps/jarvis-web/src/types/generated/`                  | 部分文件 D 但未 commit            | **目录已删并 commit (`db0c103`)** | F-NEW (R) 闭环                                                                      |
| `packages/shared-types/src/index.ts` exports            | (未读)                            | **10 (= Channel 3 + Workflow 7)** | 比 ts_rs 31 个少 21 个 → 缺口由 `frames.ts` 72 个 export 自我覆盖（非迁移落地）     |
| MCP tools list                                          | 20                                | **20**                            | 与 6/20 byte-identical（同一 binary）                                               |
| `GET /v1/projects/:id/requirements?status=…` 过滤      | （未单独探）                      | **静默忽略 → F-NEW (S)**          | NEW                                                                                 |

---

## 2. 项目与 Requirement 库存（6/21）

### 2.1 项目清单

5 个 active project：`Servlet Automation Probe (e48ca961)`,
`jarvis-servlet-demo (55e070fb)`, `esp32 (4f0461e6)`, `Jarvis Roadmap
(933ef003)`, `svelte-learn (5e3b0683)`。5/5 `automation.auto_mode_enabled=true`，
但被全局 `mode=off` 否决 14 天。`runs-smoke (7de0f91d)` 仍正确 archived。

### 2.2 Servlet Automation Probe（`e48ca961`，13 → 14 行）

新增本日探针：

| id          | status   | created    | 标题摘录                                                                                     | 备注       |
|-------------|----------|------------|----------------------------------------------------------------------------------------------|------------|
| `9c36a587` ⬅ **本日** | backlog | 2026-06-20 | PROBE 2026-06-21: iteration #10 — Rust binary running 10d post-decommission + status filter ignored + shared-types 10/31 | iter #10 |

> **14 行中后 7 行 (probe series) 全部 `assignee_id=None`** → F-NEW (M) 仍铸
> 死归类为 operator-gate。`af972b57`（iter #6 6/16）、`cad50ed3`（iter #7
> 6/17）、`b85352cd`（iter #8 6/18→6/19）、`b889bcbb`（iter #9 6/19→6/20）、
> `9c36a587`（iter #10 6/20→6/21）**五代探针并列 in backlog**，是
> "代码侧 vs Run 侧"对比最干净的实验序列。

### 2.3 jarvis-servlet-demo（`55e070fb`，10 行，与 6/20/6/19/6/15/6/13/6/11 完全一致）

`review=6, done=4`；零流转、零新增。**这是 "自动化能力 = 0" 在两个独立
Project 上同步 28 天的证据。**

---

## 3. F-NEW 全集复测（与 6/20 对照）

| 代码 | 简介                                                                                | 6/20      | **6/21**  | 状态                                                                                        |
|------|-------------------------------------------------------------------------------------|-----------|-----------|---------------------------------------------------------------------------------------------|
| H    | 2ff5f931 Review 滞留                                                                | ✓ (14d)   | ✓ (15d)   | reviewer-subagent flip 结构不可达；第 10 次追踪                                              |
| J    | POST `/v1/projects/:id/requirements` 静默吃 4 字段                                  | ✓         | ✓         | 今日 `9c36a587` 复测仍 byte-identical（详见 §3.2）                                            |
| K′   | PATCH `/v1/requirements/:id` 只接 `verification_plan`，丢弃 3 字段                  | ✓         | ✓         | 今日复测仍 byte-identical；**Node 港 PATCH 反而更广（详见 §3.2）**                            |
| L    | `Requirement.acceptance_policy` 字段 `#[serde(default, skip)]` 导致 wire-shape 删除 | ✓         | ✓         | Rust binary 维持；Node port 暂未触达                                                         |
| M    | "approved 行全部 `assignee_id=None`，picker 拒拣"                                   | ✓ (锁定)  | ✓ (锁定)  | Rust picker 无 `assignee_id.is_some()` 硬门 → 纯 operator-gate                                |
| N    | 探针 Requirement 无 `activities/<rid>/` 目录                                        | ✓         | ✓         | 今日 `activities/9c36a587-…/` ENOENT                                                         |
| N′   | 5.768 GB 孤儿 worktree 无 GC                                                        | ✓ (22d)   | ✓ (23d)   | 持续                                                                                        |
| O    | `harness.health` 数字字节冻结                                                       | ✓ (10d)   | ✓ (11d)   | stable hash `bf26677a7e82747a` byte-identical                                               |
| P    | `/v1/providers/default` 与 `/v1/providers/:name` 全部 404，admin 模块代码存在但未挂载 | ✓ (Rust)  | **源码已修，等切换** | Node port `provider-admin-routes.ts` + `server.ts:62` 已 register；Rust binary 继续 404 |
| Q    | 6/16+6/17 报告未落盘                                                                | 退役      | 退役      | 6/18→6/19→6/20→6/21 连续四日                                                                |
| R    | main 工作树脏 63 文件 + ts_rs 生成 30+ TS 类型批量删未 commit                       | NEW       | **闭环**  | 已 commit (`db0c103` + `bcbf409`)；shared-types 仅 10/31，其余 21 一直在 frames.ts 自给     |
| **S** ⬅ NEW | `GET /v1/projects/:id/requirements?status=<x>` 静默吞掉 `status` 参数 → 返回全集 | –         | **NEW**   | 详见 §3.5                                                                                   |
| **T** ⬅ NEW | 仓库 Rust workspace 下架 + 运行时仍是 Rust binary → 双重身份                       | –         | **NEW**   | 详见 §3.6                                                                                   |

### 3.1 F-NEW (M) — 仍是 operator-gate（不复测）

6/20 已用源码 grep 锁定 `auto_mode.rs` 内 28 处 `assignee_id` 命中均为
"写"操作。今日**未重新 grep**（Rust workspace 已删，源码层重读需要 git
`show` 或 archive tag `rust-archive-pre-takedown`，无新信号需要复测）。
M 维持 operator-gate 判定不变。

### 3.2 F-NEW (J / K') 今日 byte-identical 复测 + Node port 源码对照

**Rust binary live 行为**（PID 45720）：

```text
POST /v1/projects/e48ca961-…/requirements
Body: {title, description, verification_plan:{commands:["echo ok"]},
       acceptance_policy:"Subagent", assignee_id:"scheduled-task",
       triage_state:"approved"}
→ 201 9c36a587-f5ba-4c53-879c-f605390b0d23
   响应体 keys (按字母序):
     [conversation_ids, created_at, description, id, project_id, status,
      title, todos, updated_at]
   响应体里 verification_plan / acceptance_policy / assignee_id /
            triage_state — 全部 缺席

disk read after POST:
  ~/.local/share/jarvis/conversations/requirements/e48ca961-…/9c36a587-….json
  keys (sorted): [conversation_ids, created_at, description, id,
                  project_id, status, title, todos, updated_at]
  verification_plan : <missing>
  acceptance_policy : <missing>
  assignee_id       : <missing>
  triage_state      : <missing>

PATCH /v1/requirements/9c36a587-…
Body: {verification_plan:{commands:["echo ok"]}, acceptance_policy:"Subagent",
       assignee_id:"scheduled-task", triage_state:"approved"}
→ 200

disk read after PATCH:
  keys (sorted): [conversation_ids, created_at, description, id,
                  project_id, status, title, todos, updated_at,
                  verification_plan]   ← +1 key
  verification_plan : {"commands":["echo ok"]}
  acceptance_policy : <missing>          ← 仍缺
  assignee_id       : <missing>          ← 仍缺
  triage_state      : <missing>          ← 仍缺

ls activities/9c36a587-…/  → No such file or directory
```

与 6/18 `cad50ed3`、6/19 `b85352cd`、6/20 `b889bcbb` 四连复测**完全同形态**。

**Node port 源码对照**（`packages/server/src/requirements-routes.ts`）：

| 字段                  | Rust binary POST | Rust binary PATCH | Node port POST | Node port PATCH |
|-----------------------|------------------|-------------------|----------------|-----------------|
| `title`               | ✓                | ✓                 | ✓ (`L212-215`) | ✓ (`L269-272`)  |
| `description`         | ✓                | ✓                 | ✓ (`L241-244`) | ✓ (`L274-277`)  |
| `status`              | ✓                | ✓                 | ✓ (`L218-222`) | ✓ (`L279-283`)  |
| `triage_state`        | ✗ 丢弃 (J)       | ✗ 丢弃 (K')       | **✓** (`L223-229`) | **✓** (`L288-294`) |
| `depends_on`          | （Rust 未测）    | （未测）          | ✓ (`L230-237`) | ✓ (`L295-302`)  |
| `label_ids`           | （未测）         | （未测）          | ✓ (`L238-240`) | ✓ (`L303-305`)  |
| `verification_plan`   | ✗ 丢弃 (J)       | **✓ 接** (K' 命名因 = 唯一被 PATCH 接的) | **✗ 丢弃** | **✗ 丢弃** ⚠ 回归 |
| `acceptance_policy`   | ✗ 丢弃 (J)       | ✗ 丢弃 (K')       | ✗ 丢弃        | ✗ 丢弃          |
| `assignee_id`         | ✗ 丢弃 (J)       | ✗ 丢弃 (K')       | ✗ 丢弃        | ✗ 丢弃          |
| `conversation_ids`    | （未测）         | （未测）          | （POST 未处理） | ✓ (`L284-286`)  |

> **关键观察**：
> - **Node port 在 POST/PATCH 两路都把 `triage_state` 接住了** —— J 与 K'
>   的 *triage_state* 部分会在切到 Node 后自动消失。
> - **但 Node port PATCH 不再接 `verification_plan`** —— 相当于把 Rust
>   时代唯一的 K' 例外**砍掉了**。这等于"K'_node 比 K'_rust 更广"。
> - **`acceptance_policy` / `assignee_id` 在 Node port 上同样未接受**。
>   Node port 内部确实没有 wire-shape 字段保留这些 ——
>   `apps/jarvis-web/src/types/frames.ts:Requirement` 接口里有 `assignee_id`
>   与 `verification_plan`/`acceptance_policy`，但 Node 服务端不读取。
> - **switchover 后的写路径影响**：
>   - 修复了 1 项（POST/PATCH `triage_state`）
>   - 引入 1 项回归（PATCH `verification_plan`）
>   - 维持 2 项未修（`acceptance_policy` / `assignee_id`）
> - **6/22 follow-up**：若计划部署 Node serve，应**先修 Node port 的
>   `verification_plan` PATCH path**（避免 6/19 之前手工存的 plan 在第一次
>   PATCH 时被覆盖丢失），再切流。

### 3.3 F-NEW (O) — `harness.health` 第 11 天字节冻结

今日 [`mcp-probe-2026-06-21.json`](./mcp-probe-2026-06-21.json) 通过同
`mcp_probe.py` 在同 `JARVIS_FS_ROOT=output/jarvis-auto-test/servlet-fixture`
+ `JARVIS_DB_URL=json:///tmp/mcp-probe-store-0621` 下生成。
解析 `results["harness.health"]["result"]["content"][0]["text"]` 后：

```text
06-21 snap:  overall_score=57, confidence=0.16305384988110813,
             sample_count=5, primary_focus=task_understanding
06-20 snap:  overall_score=57, confidence=0.16305384988110813,
             sample_count=5, primary_focus=task_understanding
06-21 stable_hash (drop generated_at, blake2b-8): bf26677a7e82747a
06-20 stable_hash (drop generated_at, blake2b-8): bf26677a7e82747a
                                                ────────────────
                                                byte-identical sans generated_at
```

`actions[0].key = stabilize_delivery_gate` 仍是首要建议；
`primary_focus = task_understanding` 仍卡在第一象限。

> **结构性原因**：这一 metric 只读取 `requirement_runs` 表里的样本。
> 自 2026-06-05 没有新 Run，metric 一直采的是同一批 5 个样本 →
> 同一份输入 → 同一份输出。要解锁需要**让 picker 至少跑一个 Run**，
> 而那又被 J/M/H 三个 gate 联合阻断。

### 3.4 F-NEW (P) — 源码侧已在 Node port 修复

```text
$ ls packages/server/src/provider-admin-routes.ts
  packages/server/src/provider-admin-routes.ts                ← 305 行

$ grep -n "registerProviderAdminRoutes" packages/server/src/server.ts
  19:import { registerProviderAdminRoutes } from "./provider-admin-routes.ts";
  62:  registerProviderAdminRoutes(app, state);

$ grep -E "(GET|PATCH|DELETE|PUT)" packages/server/src/provider-admin-routes.ts | head -8
  // | GET    | /v1/providers/:name      | …  | 200 {provider: Snapshot}
  // | PATCH  | /v1/providers/:name      | …  | 200 {provider: Snapshot}
  // | DELETE | /v1/providers/:name      | …  | 200 {deleted: boolean}
  // | PUT    | /v1/providers/default    | …  | 200 {default: name}
  app.get   ("/v1/providers/:name",   …)
  app.patch ("/v1/providers/:name",   …)
  app.delete("/v1/providers/:name",   …)
  app.put   ("/v1/providers/default", …)
```

⇒ Node port 把 `provider-admin-routes.ts` **完整挂上去了** —— 503 默认
fallback 也已 wire 起来（`provider admin not configured` 错误文本在
`provider-admin-routes.test.ts` 已有 assertion）。

**唯一阻碍**：:7001 上跑的还是 Rust binary。一次 Node serve 部署即清。

### 3.5 F-NEW (S) ⬅ NEW — `?status=` query 参数静默吞

**Rust binary live 复测**：

```text
$ curl http://localhost:7001/v1/projects/e48ca961-…/requirements?status=backlog
  → 13 rows, status_breakdown = {backlog: 7, review: 4, done: 2}

$ curl http://localhost:7001/v1/projects/e48ca961-…/requirements?status=done
  → 13 rows, status_breakdown = {backlog: 7, review: 4, done: 2}
                                  ↑ 完全相同的输出
```

**Node port 源码确认**（`requirements-routes.ts:175-203`）：

```typescript
app.get("/v1/projects/:project_id/requirements", async (req, reply) => {
  const projectId = (req.params as { project_id: string }).project_id;
  const triageRaw = (req.query as { triage_state?: string }).triage_state;
  // ↑ schema 只识 triage_state，没有 status
  …
  let items = await store.list(projectId);
  if (filter) {
    items = items.filter((r) => triageFilterMatches(filter, requirementTriageState(r)));
  }
  return reply.send({ project_id: projectId, items: items.map(requirementToWire) });
});
```

`status` 不在 schema、也不传到 store —— 静默吃。**这是
Rust binary 与 Node port 一致的行为**，所以切换不会修。

**风险**：
- 任何运维 dashboard 用 `?status=…` 做 panel filter 都会拿到错误数字
  （超报了 review 与 done 行）。
- web 前端默认按 backlog/review/done/in_progress 四 column 渲染
  Kanban —— 如果它打 `?status=…` 那它每个 column 都会渲全集，导致
  Kanban 显示重复行（应已被前端拒掉，待 6/22 PreviewMCP 复核）。

**6/22 follow-up**：grep `apps/jarvis-web/src/services/requirements.ts`
看是否有 `?status=` 用法。若有 → 生成一张 Jarvis-Roadmap Requirement
"P-Q-S：添加 status 过滤"。若无 → 把 S 标为"未来风险"，**只文档化**。

### 3.6 F-NEW (T) ⬅ NEW — 仓库 Rust 下架 + 运行时仍 Rust binary

```text
最新 9 个 commit on feat/node-rust-decommission:
  3df3d35 docs(p8): mark Rust decommission complete in the gap inventory
  bcbf409 chore(p8.2): decommission the Rust runtime — Node is now the sole runtime
  f85fb69 feat(node): register memory-sync routes as graceful 503 stubs (P8.1)
  c206b39 feat(node): run verification — POST /v1/runs/:id/verify + /verification (P8.1)
  3b3a3f9 feat(node): requirement TODO checklist CRUD + conversation link (P8.1)
  fb770aa feat(node): workspace commit + PR routes (P8.1)
  14774ab feat(node): /v1/routing CRUD ×4 + non-hollow summarization wiring (P8.1)
  f5c1359 feat(node): GET /v1/server/info + /v1/version + POST /v1/providers/:name/probe (P8.1)
  4697777 docs(p8): mark the conversations/chat-runs/workspace/mcp blockers landed

工作树 layout (after bcbf409):
  apps/        : jarvis-desktop, jarvis-ios, jarvis-web
  packages/    : 25 个（agent-profile, automation, channel, connectors, core,
                 desktop, jarvis-app, jarvis-cli, learning, llm, mcp, memory,
                 observability, plugin, project, router, server, shared-types,
                 skill, store, subagents, todo, tools, workflow）
  crates/      : ✗
  Cargo.toml   : ✗
  Cargo.lock   : ✗
  target/      : 仍在（incremental + final binary）

  $ ls target/debug/jarvis
    -rwxr-xr-x 109 312 840 bytes  Jun 11 00:10  ← 仍在 disk 上

  $ ps -p 45720
    PID    ELAPSED  COMMAND
    45720  10-02:56  target/debug/jarvis  ← 仍在跑

  $ curl http://localhost:7001/health  → {"status":"ok"}
```

⇒ 三个事实并存：
- 仓库已经"Rust decommissioned"
- `target/debug/jarvis` binary 还在 disk 上（**未 `cargo clean`**）
- PID 45720 还在以 Rust binary 跑（**未重启 / 未部署 Node serve**）

**这一日 :7001 上的所有 HTTP 响应都是 Rust 时代的行为**。Node port 的
全部 6/19 之后的 feat(node) commit（自 `4697777` 起的 9 个 + 之前的若干），
包括 provider admin、status filter、TODO checklist、workspace 提交/PR、
routing CRUD、summarization、server info、version、memory sync 503、run
verification 等 —— **都没进入观测面**。

**风险与机会**：
- **风险**：未来某次部署 Node serve 时，行为会一次性 **跳变**——
  - P 修了（`/v1/providers/default` 200）
  - S 不变（`?status=` 仍吞）
  - J/K' 行为变（详见 §3.2 表）
  - reviewer-subagent 路径变（若 Node port 已实现 `subagent.review`）
  - TODO checklist 字段 + endpoint 变（`POST /v1/requirements/:id/todos`）
  - workspace commit/PR endpoints 出现
  - … 共 9 个 P8.1 feat(node) 的接口面
- **机会**：今日的 baseline 是"Rust 行为"的**最后快照**。任何后续切到
  Node 的报告**必然出现一次大规模 delta** —— 应当**提前为 Node 行为画一
  份对比 baseline**（在 disabled CI 或 staging 上跑 `pnpm --filter
  @jarvis/server test` + 一份 cURL playbook）。

**6/22 follow-up**：
- 在 *本地另起* `pnpm --filter @jarvis/jarvis-app node ... serve` 监听
  备用端口（e.g. `JARVIS_ADDR=127.0.0.1:7011`），不动 PID 45720，把
  /v1/auto-mode / /v1/providers/* / /v1/projects/:id/requirements?status=…
  在 Node serve 上各跑一次，**生成 6/21 Node baseline cURL playbook**。
- 若 :7001 当日重启切到 Node，在切换前对 PID 45720 的 dump 一份完整 /v1
  read-only snapshot（已是今日报告的内容），作为"Rust 时代终结报告"。

---

## 4. f4a78fc3 自我修正持续（第 7 次追踪）

`/v1/diagnostics/runs/failed?limit=50` 拉满的 50 行里：

```text
top requirements by failure count:
  f4a78fc3 → 6
  47f3c24d → 4
  6348c77c → 3
  a8f36e4f → 3
  634533f7 → 3
earliest: 2026-05-06T07:43:48Z
latest:   2026-06-05T09:57:40Z       ← 16 d 前
```

`f4a78fc3` 的 6 次失败全是 Kimi `262 144 token limit` 400 错误，最后一次
是 `2026-06-05T09:57:40Z`。今日 `2026-06-20T19:09Z` − `2026-06-05T09:57Z`
= **16 d** 无任何新失败。

picker 在 Rust binary 的 `auto_mode.rs` 中那一行
`consecutive_failures < effective_max_retries` 分支上**永久短路**该行
（3<6 = false）。`/v1/diagnostics/runs/stuck?threshold_seconds=600 → {items:[]}`
与此自洽。

**6/20 提的运维三件套依然有效，且未做**：
1. 启用 `JARVIS_MEMORY_MODE=summary` 让对话压缩到 256 K 以内；
2. `DELETE /v1/requirements/f4a78fc3-…` —— picker 既已永久跳过，row
   就是占位垃圾；
3. 在 picker 加 `failed_count >= max_retries` 的 explicit Activity
   行，否则操作员无信号。

今日仍**不做** —— 维持 read-only-observer 姿态。

---

## 5. 本日测试需求（生成证据）

| 字段                | 值                                                                                  |
|---------------------|-------------------------------------------------------------------------------------|
| Project             | `Servlet Automation Probe` (`e48ca961-cffe-4dcc-9c2e-0486363ddde4`)                  |
| Requirement ID      | `9c36a587-f5ba-4c53-879c-f605390b0d23`                                              |
| Title               | `PROBE 2026-06-21: iteration #10 — Rust binary running 10d post-decommission + status filter ignored + shared-types 10/31` |
| Status              | `backlog`                                                                           |
| Triage              | （wire 层声明 `approved`，**实际丢弃** → `missing`，触发 F-NEW (J)）                  |
| Verification plan   | `{"commands":["echo ok"]}`（POST 丢弃，PATCH 上盘）                                  |
| Acceptance policy   | （声明 `Subagent`，丢弃）                                                            |
| Assignee            | （声明 `scheduled-task`，丢弃）                                                      |
| Activity dir        | ENOENT（F-NEW (N) 持续）                                                             |

意图：把 6/16 (`af972b57`) → 6/17 (`cad50ed3`) → 6/18 (`b85352cd`) → 6/20
(`b889bcbb`) → 6/21 (`9c36a587`) **五代探针**并列，证明 J/K'/L/N 在
**14 天 + Rust→Node 决断切片**期间全部未被修复（在 live Rust binary 上）。
五代探针并列在 backlog，是最干净的 cross-day 测试 fixture。

---

## 6. 当前 Harness 健康 → 是否需要再迭代一轮需求？

按 scheduled task 原意 ——
**"根据 Jarvis 的 Harness 健康来进行迭代需求判断"** —— 今日的判定：

| 维度                          | 信号                                                                                                       | 判定                |
|-------------------------------|------------------------------------------------------------------------------------------------------------|---------------------|
| Run throughput（8 d 窗口）    | runs_completed=0, runs_failed=0 全 0                                                                       | **无新需求**：跑不出 |
| `/v1/auto-mode`               | mode=off 第 14 天                                                                                          | **无新需求**：跑不动 |
| 写路径 J/K' wire-shape        | Rust binary 维持，Node port 部分修但 PATCH `verification_plan` 回归                                       | **可生成需求**：但 owner 应是 Node port 开发者，scheduled-task **不写** |
| Reviewer 自动 flip (F-NEW H)  | 2ff5f931 已 15 d Review 滞留，结构上不可达                                                                 | **无新需求**：合不上 |
| F-NEW (N') 5.768 GB 孤儿      | 23 d 未 GC，诊断接口只读                                                                                   | **无新需求**：清不掉 |
| F-NEW (P) provider admin 缺挂 | Node port 已修；切换即可                                                                                   | **无需 Jarvis 需求**：切流程即解 |
| F-NEW (R) ts_rs / shared-types| 6/20 → 6/21 已 commit；shared-types 与 frames.ts 双源并存非 bug                                          | **无新需求**：叙事偏差 |
| F-NEW (S) `?status=` 静默吞   | 同时存在于 Rust + Node port；运维误判风险中等                                                              | **观察 + follow-up**：先 grep 前端用法，再决定 |
| F-NEW (T) Rust binary 跑了 10 d | 仓库已下架但 :7001 继续；6/22 应制定切换演练                                                              | **运维需求**：scheduled-task **不写**；让运维拍板 |

**结论**：今日**不为 Jarvis 自身生成需求**（与 6/20、6/19、6/18 同节奏）。
理由是 —— 任何 Jarvis-自身需求在 `mode=off + J 漂移`下都不会被 picker
拣到，写入 store 反而进一步污染 backlog 计数（已 +1 → 13）。

**唯一抗这个判断的反例**：F-NEW (T)。**但 T 不是 Requirement，是
deployment decision** —— 它需要的不是一张 backlog 卡，而是一次 *运维
切换演练*。这超出 scheduled-task 写入预算，留为 6/22 演练 follow-up。

---

## 7. 6/22 待办（明日 scheduled-task 入口）

按优先级：

1. **观察 :7001 上的 PID 是否仍是 45720** —— 若变了，记录新 PID + start
   时间 + EXEC（应为 Node serve 入口），把"Rust 时代终结"标在 6/22
   报告头部。
2. **观察 `target/debug/jarvis` 是否还在 disk 上** —— 若被 `cargo clean`
   清掉，标 F-NEW (T) 进入"未切换但 binary 已删"的*运行时风险升级*。
3. **若 :7001 仍 Rust binary**：起一份 Node serve 在备用端口
   (`JARVIS_ADDR=127.0.0.1:7011`)，跑一份 `/v1/*` cURL playbook 与 :7001
   并列对比，写到 `output/jarvis-auto-test/node-baseline-cURL-2026-06-22.md`。
4. **追 F-NEW (S) 前端用法**：grep `apps/jarvis-web/src/services/
   requirements.ts` 看是否调 `?status=…`。若有 → 生成 Jarvis-Roadmap
   Requirement "P-Q-S：requirements list 加 status 过滤"。
5. **追 F-NEW (J/K') Node port 回归**：grep `packages/server/src/` 找
   verification_plan / acceptance_policy / assignee_id 的处理。若 Node
   port 内部存储模型确实丢字段（不止是 wire-shape 漏读）→ 生成 Jarvis-
   Roadmap Requirement "P-Q-T：Node port wire schema 与 Rust 对齐"。
6. **观察 `b889bcbb`、`b85352cd`、`cad50ed3`、`af972b57`、`9c36a587` 五代
   探针**是否有任何变动（dry-run 期望全部不动）。
7. **观察 `git worktree list` 数量**：今日 26。Jarvis 自身没接到
   `.jarvis/worktrees/issue-43` 的 GC 信号；今日 23 d。
8. **不**在今日做：翻 `JARVIS_WORK_MODE`、删 `f4a78fc3`、cargo clean、
   重启 PID 45720、`cargo build` 任何东西、commit 此报告以外的任何 git
   写入。

---

## 8. 附录

- 探针 Requirement JSON：
  `~/.local/share/jarvis/conversations/requirements/e48ca961-cffe-4dcc-9c2e-0486363ddde4/9c36a587-f5ba-4c53-879c-f605390b0d23.json`
- MCP probe JSON：
  [`mcp-probe-2026-06-21.json`](./mcp-probe-2026-06-21.json)
- 上一份诊断报告：
  [`diagnostic-report-2026-06-20.md`](./diagnostic-report-2026-06-20.md)
- 历史系列：
  `diagnostic-report-2026-06-{11,12,13,15,19,20,21}.md` + 早期
  `JARVIS_AUTO_MODE_DIAGNOSTIC_2026-{05-09…06-18}.md`（在
  `~/Documents/GitHub/jarvis-servlet-demo/` 下）
- Rust archive tag：`rust-archive-pre-takedown`（CLAUDE.md 顶部注解所
  提到的"Rust 源码保留在 git history"入口）

### 8.1 5 代 probe Requirement 简表

| iter | id          | created          | title 摘录                                                                            | HEAD when created                  |
|------|-------------|------------------|---------------------------------------------------------------------------------------|------------------------------------|
| #6   | `af972b57`  | 2026-06-16T19:19 | re-test F-NEW(J/K/M/N) — verification_plan + acceptance_policy                       | `c2e3926` (main, pre-P7.10)       |
| #7   | `cad50ed3`  | 2026-06-17T19:08 | re-test F-NEW(J/K/M/N) + agent-tool divergence                                       | `94580f6` (post-P7.10 iOS land)   |
| #8   | `b85352cd`  | 2026-06-18T19:16 | F-NEW(O) 9-day freeze + F-NEW(P) admin routes 404                                    | `b0a649b` (feat/node-providers-list-p8.1) |
| #9   | `b889bcbb`  | 2026-06-19T19:09 | F-NEW(M) operator-gate confirmed + F-NEW(P) 404 holds + 15-day Run deadband          | `2574c28` (main, post-P8.1 merge) |
| #10  | `9c36a587`  | 2026-06-20T19:09 | Rust binary running 10d post-decommission + status filter ignored + shared-types 10/31 | `3df3d35` (feat/node-rust-decommission, post-P8.2) |

> 5 代探针 in store 共 **5×9 = 45 base keys + 5 个 verification_plan
> patched** = 250 字段，零字段流转，零 Run 触发，零 Activity 行；它们是
> "自动化能力 = 0" 的物证。
