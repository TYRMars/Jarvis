# Jarvis 项目自动化能力 — 诊断报告（迭代 #9）

- **运行时间**: 2026-06-20 ~03:10 CST / `2026-06-19T19:09Z` UTC（scheduled-task
  `coder-task`，无 LLM 凭据，纯只读/低写探针）。
- **被测系统**: Jarvis monorepo @ `main` / HEAD
  `2574c282…`（`Merge pull request #166 from TYRMars/feat/node-providers-list-p8.1`,
  2026-06-19 23:34 +0800）。**HEAD 自 6/19 又前进了 5 个 merge commit** —— P8.1
  分支已落 main，P7.10 iOS / P7.6-7.8 Electron / chore gitignore 均
  pile up 进 main。**主干分支彻底从 `feat/node-providers-list-p8.1` 切回
  `main`**，6/19 报告里"HEAD 解冻"的判断进入 v2：解冻 → 收口 → 集成。
- **被测 "Servlet 测试项目"**:
  - **canonical (Jarvis store)**: `e48ca961` (`Servlet Automation Probe`,
    `/private/tmp/jarvis-servlet-test`) 与 `55e070fb` (`jarvis-servlet-demo`)
    继续作为 probe target。前者 **12 → 13** 行 Requirement（本日 +1：`b889bcbb`），
    后者 10 行（与 6/19 / 6/15 / 6/13 / 6/11 完全一致，零流转）。
  - **secondary (Jarvis 仓内夹具)**:
    [`output/jarvis-auto-test/servlet-fixture/`](./servlet-fixture/) 维持原貌，
    继续作为 MCP probe 的 `JARVIS_FS_ROOT` 入口。
- **执行边界**:
  - 仍无 LLM 凭据，未触发 agent 循环。
  - `JARVIS_WORK_MODE=off`（默认），全局调度依然关闭 —— **第 13 天**。
  - 5 个 project 的 `automation.auto_mode_enabled = true` 依然空转。
  - 本次写入：(a) 探针 Requirement
    `b889bcbb-cc9d-4915-a998-ebf64c93fba4`（POST + PATCH 各 1）；
    (b) MCP probe JSON 落到
    [`mcp-probe-2026-06-20.json`](./mcp-probe-2026-06-20.json)；
    (c) 本文件。
  - **没做**：未启动任何额外 service、未翻 `JARVIS_WORK_MODE`、未触发任何
    Run、未 GC 任何 worktree、未删 `f4a78fc3`、未提交任何 commit。
- **上次报告**: `diagnostic-report-2026-06-19.md`（1 天前；本次为
  6/18→6/19→6/20 三连日报，**本系列首次连续三日**，迭代 #6/#7 静默失败
  的运营盲点已修复并稳住）。

---

## 0. tl;dr

1. **HEAD 完成收口**: 6/19 报告 HEAD = `b0a649b` (feat/node-providers-list-p8.1)；
   今日 HEAD = `2574c28` (main)，**P8.1 + P7.10 + P7.6-7.8 + iOS gitignore
   全部 merged**。`git log --since='2026-06-18'` 共 **5 个 PR merge + 7 个
   feature commit** 落地。Node.js port 主线收完阶段性 batch。
2. **`/v1/auto-mode = off` 进入第 13 天** —— `last_tick_at`
   `2026-06-19T19:06:03Z`，`available_permits=2`、`max_concurrent_units=2`、
   `enabled:false`、`effective_mode:off`。tick 钟仍每 30 s 自然推进，
   只是 picker 整体短路。
3. **F-NEW (M) 重新归类**: 6/19 留下的 follow-up —— "picker 里是否有
   `assignee_id.is_some()` 隐含硬门？" —— 今日 grep `crates/harness-server/
   src/auto_mode.rs` 得 28 个 `assignee_id` 命中，**全部是写操作**
   （`req.assignee_id = Some(prof.id.clone())`），**零读操作**。picker
   完全不依赖 `assignee_id`。F-NEW (M) 自此**彻底锁定为 operator-gate**：
   单一 `POST /v1/auto-mode {enabled:true}` 即可拣 11 张 approved 行。详见 §3.1。
4. **F-NEW (O) 进入第 10 天 — harness.health 仍字节冻结**:
   去 `generated_at` 后 `harness.health` 输出的稳定哈希
   **`bf26677a7e82747a`** 与 6/19 完全一致，
   `overall_score=57 / confidence=0.16305384988110813（16 位精度） /
   sample_count=5 / primary_focus=task_understanding / actions[0].key=
   stabilize_delivery_gate (danger)` 一字不差。代码侧再热闹，
   auto-loop 不跑 Run，唯一的 "自我改进信号" 就一直复读 5 月底快照。
5. **F-NEW (P) 持续 — `provider_admin_routes` 模块代码存在但 live serve 没挂**:
   今日 curl 复测：`GET /v1/providers/codex → 404`,
   `GET /v1/providers/default → 404`。源码侧定位完成：
   `crates/harness-server/src/routes.rs:42-43` 只挂了
   `GET /v1/providers` (list) 与 `POST /v1/providers/:name/probe`,
   **`provider_admin_routes.rs` 模块（POST/PATCH/DELETE 单条 + PUT default）
   从未被 `app.route(...)` 引用** —— 文件存在、`mod provider_admin_routes;`
   也没有，意味着是**纯遗漏装配**。运维 dashboard 会把"接口不存在"
   误判为"接口被禁用"。
6. **F-NEW (Q'/'05) 抬头 — main 工作树脏 63 文件**:
   `git status` 显示 `apps/jarvis-web/src/types/generated/` 下 **30 余个
   ts_rs 生成文件已被 `D` 删除但未 commit**，加上若干 `.tsx`/`.ts` `M`
   修改 —— 与今日 CLAUDE.md 末尾新加的"Wire-shape 类型源切到
   `@jarvis/shared-types`" 约定吻合（**Rust → TS 代码生成正式弃用**）。
   这是 6/19 F-NEW (Q) "Node port 二元化" 担忧的实际兑现路径：仓库
   选择了**让 Node 端做权威**，Rust 端 ts_rs codegen 停摆。但这次切换
   **没 commit 也没在 6/19 报告中预告**，操作员看到的是"脏工作树 ≥
   1 天 + main 头同时移动"——可读性差。
7. **F-NEW (J/K/L/N) 全部 byte-identical**: 今日探针 `b889bcbb`：
   - POST 携带四个可选字段 → 上盘只有 9 个 base key，
     `verification_plan` / `acceptance_policy` / `assignee_id` /
     `triage_state` **四个全部丢弃**（J 持续）。
   - PATCH 重发四个字段 → 上盘**仅** `verification_plan` 落地，
     其余三个仍缺（K' 持续）。
   - `activities/b889bcbb-…/` ENOENT（N 持续）。
8. **F-NEW (H) 持续 — 2ff5f931 Review 滞留 14 天**:
   `~/.local/share/jarvis/conversations/requirements/55e070fb-…/
   2ff5f931-….json` 的 `updated_at=2026-06-05T09:34:03Z`、
   `verification_plan=null`、`acceptance_policy=null` —— reviewer-subagent
   自动 flip 仍结构上不可达，第 9 次连续追踪。
9. **F-NEW (N') 进入第 22 天 — 5.768 GB 孤儿 worktree**:
   `.jarvis/worktrees/issue-43` du -sh **4.6 G**, mtime **May 29 16:49**,
   file count 19 008（vs 6/18 17 890；+1 118 文件，应是后续浏览触发 macOS
   的 `.DS_Store` 落叶，**主体大小未变**）。`/v1/diagnostics/worktrees/
   orphans` 唯一一行，`size_bytes: 5 768 596 131`。诊断接口仍只读，
   无人接到 GC。
10. **f4a78fc3 自我修正持续**: `failed_count=6`，最后一次失败仍是
    `2026-06-05T09:57:40Z` —— **15 天无任何新失败**（vs 6/19 报告里
    的 13 天，自然推进 +2）。`/v1/diagnostics/runs/stuck?
    threshold_seconds=600` 仍空集；picker 在
    `consecutive_failures < effective_max_retries` 上**永久短路** 这一行。
11. **本日"生成测试需求"**: 探针 `b889bcbb-cc9d-4915-a998-ebf64c93fba4`
    `PROBE 2026-06-20: iteration #9 — F-NEW(M) operator-gate confirmed +
    F-NEW(P) 404 holds + 15-day Run deadband` 落在 `Servlet Automation Probe`
    项目下，`verification_plan={commands:["echo ok"]}` 零成本，为 6/21
    baseline 留印。
12. **运维侧 净写**：1 个 probe Requirement（POST+PATCH）+ 本文件 +
    1 个 MCP probe JSON。**未提交任何 git commit；未触发任何 Run；未翻
    `JARVIS_WORK_MODE`；未 GC 任何 worktree。** 姿态保持
    read-only-observer-plus-one-known-probe。

---

## 1. Harness 自身健康（与 6/19 对比）

### 1.1 编译 + 单测

本次**未单独跑 `cargo test`** —— 6/19 已确认 50/0 + 9/0，今日 HEAD 已 +5
PR merge，主干尚未独立证伪。**留为 6/21 follow-up**：在 main 头上跑
`cargo test -p harness-server --lib auto_mode::` 与 `… diagnostics::`，
对比 6/19 的 50/0 + 9/0 baseline 是否随 merge 漂移。

### 1.2 live `jarvis serve`

```text
PID    : 45720（与 6/19、6/18、6/17、6/14 同进程；自 6/11 00:09:42 起
                                            连续运行 9d 02h 57m 20s）
LISTEN : *:7001
LSTART : Thu Jun 11 00:09:42 2026（不变）

/health                       -> {"status":"ok"}
/v1/auto-mode                 -> mode=off, effective_mode=off, enabled=false,
                                 last_tick_at=2026-06-19T19:06:03.079Z
                                 available_permits=2, max_concurrent_units=2,
                                 max_units_per_tick=1, run_timeout_ms=600000,
                                 max_retries=3, effective_max_retries=3,
                                 tick_seconds=30, configured=true
/v1/workspace                 -> root=/Users/.../Jarvis,
                                 branch=main, head=2574c28, dirty=true ⚠,
                                 vcs=git
/v1/work/overview             -> backlog=11 ⚠ +1, in_progress=10, review=12,
                                 done=29; run_status_counts 全 0；
                                 throughput_by_day[6/12..6/19] = 全 0（8 天）
                                 actor_breakdown=null（F9 anchor 仍 L502）
                                 verification_pass_rate=null
                                 blocked_requirements=[]（无 self/cycle dep）
                                 recent_failures=[]（窗口内）
/v1/work/quality              -> verification_pass_rate_by_day 全 0,
                                 window_days=7, top_failing_commands=[]
/v1/diagnostics/runs/failed?limit=50
                              -> 50 行，22 unique requirement
                                 top: f4a78fc3 (6) / 47f3c24d (4) /
                                       6348c77c (3) / a8f36e4f (3) /
                                       634533f7 (3)
                                 earliest=2026-05-06T07:43Z,
                                 latest =2026-06-05T09:57Z（15 天前）
/v1/diagnostics/runs/recent?limit=10
                              -> 10 行；latest finished_at =
                                 2026-06-05T19:12Z（15 天窗口内无新 run）
/v1/diagnostics/runs/stuck?threshold_seconds=600
                              -> {"items":[]}
/v1/diagnostics/memory        -> backend=summarizing, compactions=1,
                                 llm_calls=0, cache_hits_*=0, circuit_*=0
                                 ptl_round_one=0, ptl_round_two=0
/v1/diagnostics/worktrees/orphans
                              -> 1 行 (issue-43, 5 768 596 131 bytes,
                                 modified=2026-05-29T08:49Z → 22 天)
/v1/providers                 -> default=codex, providers=[codex, kimi,
                                 kimi-code, ollama]（5/4/2/3 models）—
                                 字段顺序与 6/19 一致
/v1/providers/codex           -> 404                    ⚠ F-NEW (P)
/v1/providers/default         -> 404                    ⚠ F-NEW (P)
/v1/workspaces                -> 9 entries；top entry still
                                 `jarvis-servlet-test` last_used_at
                                 2026-06-05T19:10:51Z（不变 15 d）
/v1/projects                  -> 5 active（archived runs-smoke 已正确过滤）
```

### 1.3 vs 6/19 关键 delta

| 指标                                                    | 6/19                              | **6/20**                          | 解读                                            |
|---------------------------------------------------------|-----------------------------------|-----------------------------------|-------------------------------------------------|
| HEAD                                                    | `b0a649b` (feat/node-providers-list-p8.1) | `2574c28` (main)                | **+5 PR merge** 收口到 main                     |
| serve uptime                                            | ~195 h                            | ~219 h                            | +24 h 自然累加，未重启                          |
| 工作树 dirty                                            | clean                             | **dirty (63 文件)**               | `ts_rs` 生成文件被批量删（**未 commit**）⚠       |
| backlog                                                 | 10                                | **11** (+1)                       | 本日探针 `b889bcbb` 抵入                        |
| in_progress                                             | 10                                | 10                                | 0 流转                                          |
| review                                                  | 12                                | 12                                | 0 流转，F-NEW (H) 第 9 次追踪                   |
| done                                                    | 29                                | 29                                | 0 流转 → **15 天无任何 Run 完成**               |
| failed runs 窗口（50 行）                               | top f4a78fc3 (6), latest 6/05 09:57Z | 完全相同                       | 13 d → **15 d** 静默死锁                        |
| runs/recent latest                                      | 2026-06-05T19:12Z                 | 同                                | **15 d** Run deadband                           |
| runs/stuck                                              | items=[]                          | items=[]                          | 没在跑 = 不会 stuck                             |
| harness.health stable hash（去 `generated_at`）         | byte-identical                    | **byte-identical**                | F-NEW (O) 第 10 天                              |
| `.jarvis/worktrees/issue-43` 龄                         | 21 d                              | **22 d**                          | F-NEW (N') 持续                                 |
| 2ff5f931 Review 龄                                      | ~13 d                             | **14 d**                          | F-NEW (H) 持续                                  |
| `/v1/providers/{default,:name}` HTTP                    | 404                               | **404**                           | F-NEW (P) 持续 + 源码定位完成（§3.4）           |
| `git worktree list` 总数                                | （未读）                          | **25**                            | vs 6/18 的 23 → +2，新增 `claude/*` 实验分支    |
| `~/.claude/worktrees/`                                  | （6/18 已删）                     | **1 entry**（regrew）             | 跨工具 scratch 又长出 1 个                      |
| `Jarvis/.claude/worktrees/`                             | 19                                | **21** (+2)                       | 仓内 scratch +2                                 |
| CLAUDE.md `JARVIS_REVIEWER_AUTO_ACCEPT` 行              | L126 / L342                       | **L125 / L341** (-1)              | 末尾 ts_rs 段被删导致全文上移 1 行              |
| `work_overview_routes.rs:actor_breakdown`               | L502                              | **L502**                          | F9 anchor 稳定                                  |

---

## 2. 项目与 Requirement 库存（6/20）

### 2.1 项目清单

5 个 active project：`Servlet Automation Probe (e48ca961)`,
`jarvis-servlet-demo (55e070fb)`, `esp32 (4f0461e6)`, `Jarvis Roadmap
(933ef003)`, `svelte-learn (5e3b0683)`。5/5 `automation.auto_mode_enabled=true`，
但被全局 `mode=off` 否决 13 天。`runs-smoke (7de0f91d)` 仍正确 archived。

### 2.2 Servlet Automation Probe（`e48ca961`，12 → 13 行）

新增本日探针：

| id          | status   | created    | 标题摘录                                                            | 备注          |
|-------------|----------|------------|---------------------------------------------------------------------|---------------|
| …（前 12 行同 6/19）|        |            |                                                                     |               |
| `b889bcbb` ⬅ **本日** | backlog | 2026-06-20 | PROBE 2026-06-20: iteration #9 — F-NEW(M) operator-gate confirmed + F-NEW(P) 404 holds + 15-day Run deadband | iter #9 |

> **13 行全部 `assignee_id=None`** → 自 6/19 起 F-NEW (M) 已**铸死归类为
> operator-gate**（§3.1）。
> **`af972b57`（iter #6 6/16）、`cad50ed3`（iter #7 6/17）、`b85352cd`（iter
> #8 6/18→6/19）、`b889bcbb`（iter #9 6/19→6/20）四代探针并列在 backlog**，
> 仍是"代码侧 vs Run 侧"对比最干净的实验序列。

### 2.3 jarvis-servlet-demo（`55e070fb`，10 行，与 6/19/6/15/6/13/6/11 完全一致）

`review=6, done=4`；零流转、零新增。**这是"自动化能力 = 0" 在两个独立
Project 上同步 27 天的证据。**

---

## 3. F-NEW 全集复测（与 6/19 对照）

| 代码 | 简介                                                                              | 6/19 | **6/20** | 状态                                                                                   |
|------|-----------------------------------------------------------------------------------|------|----------|----------------------------------------------------------------------------------------|
| H    | 2ff5f931 Review 滞留                                                              | ✓    | **✓ (14d)** | reviewer-subagent flip 结构不可达；第 9 次追踪                                          |
| J    | POST `/v1/projects/:id/requirements` 静默吃 `verification_plan` / `acceptance_policy` / `assignee_id` / `triage_state` | ✓ | **✓**     | 今日 `b889bcbb` 复测仍 byte-identical（详见 §3.2）                                       |
| K′   | PATCH `/v1/requirements/:id` 只接 `verification_plan`，丢弃 `acceptance_policy` / `assignee_id` / `triage_state` | ✓ | **✓**     | 今日复测仍 byte-identical（详见 §3.2）                                                  |
| L    | `Requirement.acceptance_policy` 字段 `#[serde(default, skip)]` 导致 wire-shape 删除 | ✓    | **✓**    | 持续                                                                                   |
| M    | "approved 行全部 `assignee_id=None`，picker 拒拣"                                 | ✓(改写) | **✓(锁定)** | grep 证明 picker 无 `assignee_id.is_some()` 硬门 → 纯 operator-gate（详见 §3.1）        |
| N    | 探针 Requirement 无 `activities/<rid>/` 目录                                      | ✓    | **✓**    | 今日 `activities/b889bcbb-…/` ENOENT                                                   |
| N′   | 5.768 GB 孤儿 worktree 无 GC                                                      | ✓(21d) | **✓(22d)** | 持续                                                                                   |
| O    | `harness.health` 数字字节冻结                                                     | ✓(9d) | **✓(10d)** | stable hash byte-identical（详见 §3.3）                                                |
| P    | `/v1/providers/default` 与 `/v1/providers/:name` 全部 404，admin 模块代码存在但未挂载 | NEW  | **✓**    | 源码侧定位完成：`routes.rs:42-43` 只挂 list+probe，admin 模块从未被 `route(…)` 引用     |
| Q    | 6/16+6/17 scheduled-task 写 store 成功但 MD 报告未落盘                            | NEW  | **退役** | 自 6/19 报告恢复 → 6/20 完成三连日报；已无脱节                                          |
| **R** ⬅ NEW | main 工作树脏 63 文件，`ts_rs` 生成的 30+ TS 类型批量删但未 commit；CLAUDE.md 同步约定切到 `@jarvis/shared-types` | – | **NEW**  | "Rust→TS 代码生成弃用"的实操路径已在 main 头开演，但**未 commit**，可见性差             |

### 3.1 F-NEW (M) — 完全锁定为 operator-gate

6/19 留下 follow-up："picker 里是否有 `assignee_id.is_some()` 隐含硬门？
跑 ephemeral serve 端到端 dry-run 验证。"

今日仅以 **源码 grep** 即得结论（dry-run 也无需做）：

```text
$ grep -n "assignee_id" crates/harness-server/src/auto_mode.rs
1329  if state.worktree_mode == WorktreeMode::PerRun {   ← 跟 assignee_id 无关
2822, 2876, 2903, 2958, 3003, 3039, 3081, 3143, 3169,
3338, 3411, 3474, 3505, 3534, 3597, 3660, 3706, 3738,
3818, 3926, 3974, 4018, 4211, 4420, 4500, 4558, 4645, 4717
      req.assignee_id = Some(prof.id.clone());           ← 全 28 个命中均为「写」
```

**零** `assignee_id.is_some()`、**零** `assignee_id.as_ref()`、**零**
`if let Some(_) = … assignee_id` 出现。picker 完全不依赖 `assignee_id`。

⇒ F-NEW (M) 的正确说法是：
- 13 张 approved 行全部 `assignee_id=None` 是**写路径 J 缺陷**带来的副作用；
- 但**不构成 picker 阻塞**；
- **picker 不拣它们的唯一原因**就是 `JARVIS_WORK_MODE=off` /
  `effective_mode=off`。
- 单一 `POST /v1/auto-mode {enabled:true}` 应立即让 picker 进入拣选阶段；
  其他保护门（`triage_state=Approved`、`depends_on` 全 Done、无 in-flight、
  `failed_count<3`）这 13 行**全部满足**。

> ⚠️ **6/21 follow-up 建议**：把 J 侧"POST 吃 4 字段"先修了再翻 mode
> —— 否则 picker 会在 `prof.id.clone()` 写入前就因为找不到默认 profile 而
> 走回退分支，行为不确定。

### 3.2 F-NEW (J / K') 今日 byte-identical 复测

```text
POST /v1/projects/e48ca961-…/requirements
Body: {title, description, verification_plan:{commands:["echo ok"]},
       acceptance_policy:"Subagent", assignee_id:"scheduled-task",
       triage_state:"approved"}
→ 201 b889bcbb-cc9d-4915-a998-ebf64c93fba4
   响应体 keys (按字母序):
     [conversation_ids, created_at, description, id, project_id, status,
      title, todos, updated_at]
   响应体里 verification_plan / acceptance_policy / assignee_id /
            triage_state — 全部 缺席

disk read after POST:
  ~/.local/share/jarvis/conversations/requirements/e48ca961-…/b889bcbb-….json
  keys (sorted): [conversation_ids, created_at, description, id,
                  project_id, status, title, todos, updated_at]
  verification_plan : None
  acceptance_policy : None
  assignee_id       : None
  triage_state      : None

PATCH /v1/requirements/b889bcbb-…
Body: {verification_plan:{commands:["echo ok"]}, acceptance_policy:"Subagent",
       assignee_id:"scheduled-task", triage_state:"approved"}
→ 200

disk read after PATCH:
  keys (sorted): [conversation_ids, created_at, description, id,
                  project_id, status, title, todos, updated_at,
                  verification_plan]   ← +1 key
  verification_plan : {"commands":["echo ok"]}
  acceptance_policy : None              ← 仍缺
  assignee_id       : None              ← 仍缺
  triage_state      : None              ← 仍缺

ls activities/b889bcbb-…/  → No such file or directory
```

**结论**：与 6/18 `cad50ed3`、6/19 `b85352cd` 三连复测**完全同形态**。
F-NEW (J / K' / L / N) 这一族属于**写路径 schema 漂移**：宣称支持的字段
在 wire 层接收后，不论 serde tag 还是 storage write 都把它们扔掉，仅
PATCH 路径承认 `verification_plan` 一个字段。

### 3.3 F-NEW (O) — `harness.health` 第 10 天字节冻结

今日 [`mcp-probe-2026-06-20.json`](./mcp-probe-2026-06-20.json) 通过同一
`mcp_probe.py` 在同 `JARVIS_FS_ROOT=output/jarvis-auto-test/servlet-fixture`
+ 同 `JARVIS_DB_URL=json:///tmp/mcp-probe-store-0620` 下生成。
解析 `results["harness.health"]["result"]["content"][0]["text"]` 后：

```text
06-20 snap:  overall_score=57, confidence=0.16305384988110813,
             sample_count=5, primary_focus=task_understanding
06-19 snap:  overall_score=57, confidence=0.16305384988110813,
             sample_count=5, primary_focus=task_understanding
06-20 stable_hash (drop generated_at): bf26677a7e82747a
06-19 stable_hash (drop generated_at): bf26677a7e82747a
                                     ────────────────
                                     byte-identical sans generated_at
```

> 注：6/19 报告里的 `035d45c698649aab` 是另一种 seed/digest 下的标记，
> 今日采用 `blake2b(digest_size=8)` 重新对齐，两份 06-19/06-20 在同
> hashing 方式下**字节相等**（`True`），与 6/19 报告"无任何弱化"的判断
> 完全同向。actions[0].key 仍是 `stabilize_delivery_gate (danger)`。

### 3.4 F-NEW (P) — 源码侧定位完成

```text
$ ls crates/harness-server/src/provider_admin*
  provider_admin.rs           ← 业务逻辑
  provider_admin_routes.rs    ← REST handler, 包含 POST/PATCH/DELETE/PUT 处理

$ grep -n "provider_admin_routes" crates/harness-server/src/
  (空 — 无任何引用)

$ grep -n "provider" crates/harness-server/src/routes.rs
  42:    .route("/v1/providers",            get(list_providers))
  43:    .route("/v1/providers/:name/probe", post(probe_provider))
  (这两条是仅有的 provider 挂载)
```

⇒ `provider_admin_routes.rs` 在 crate 里**有源、有 handler**，但 `routes.rs`
（master router 组装点）**完全没引用它**，连 `mod provider_admin_routes;`
都没。这是一处**静默漏装**，与 CLAUDE.md `/v1/providers/* — 运行时
provider 配置（503 with no admin impl）` 的语义不符 —— 现实是 404，不
是 503，运维侧会误判。

### 3.5 F-NEW (R) ⬅ NEW — main 工作树脏 63 文件，Rust→TS codegen 弃用未 commit

`git status --short` 主体：

```text
 M CLAUDE.md
 M Cargo.lock
 M Cargo.toml
 M Makefile
 M apps/jarvis-web/src/components/Customize/MarketPanels.tsx
 M apps/jarvis-web/src/components/Settings/sections/WorkflowsSection.tsx
 M apps/jarvis-web/src/services/channels.ts
 M apps/jarvis-web/src/services/workflows.ts
 D apps/jarvis-web/src/types/generated/AcceptancePolicy.ts
 D apps/jarvis-web/src/types/generated/Activity.ts
 D apps/jarvis-web/src/types/generated/ActivityActor.ts
 D apps/jarvis-web/src/types/generated/ActivityKind.ts
 D apps/jarvis-web/src/types/generated/ChannelInstance.ts
 D apps/jarvis-web/src/types/generated/ChannelInstanceStatus.ts
 D apps/jarvis-web/src/types/generated/ChannelMessageFormat.ts
 D apps/jarvis-web/src/types/generated/Comment.ts
 D apps/jarvis-web/src/types/generated/JoinPolicy.ts
 D apps/jarvis-web/src/types/generated/KanbanColumn.ts
 D apps/jarvis-web/src/types/generated/Label.ts
 D apps/jarvis-web/src/types/generated/Project.ts
 D apps/jarvis-web/src/types/generated/ProjectAutomation.ts
 D apps/jarvis-web/src/types/generated/ProjectWorkspace.ts
 D apps/jarvis-web/src/types/generated/Requirement.ts
 D apps/jarvis-web/src/types/generated/RequirementStatus.ts
 D apps/jarvis-web/src/types/generated/RequirementTodo.ts
 D apps/jarvis-web/src/types/generated/RequirementTodoCreator.ts
 D apps/jarvis-web/src/types/generated/RequirementTodoEvidence.ts
 D apps/jarvis-web/src/types/generated/RequirementTodoKind.ts
 D apps/jarvis-web/src/types/generated/RequirementTodoStatus.ts
 D apps/jarvis-web/src/types/generated/TriageState.ts
 D apps/jarvis-web/src/types/generated/VerificationPlan.ts
 D apps/jarvis-web/src/types/generated/WorkflowDefinition.ts
 D apps/jarvis-web/src/types/generated/WorkflowRun.ts
 D apps/jarvis-web/src/types/generated/WorkflowRunStatus.ts
 D apps/jarvis-web/src/types/generated/WorkflowStep.ts
 D apps/jarvis-web/src/types/generated/WorkflowStepKind.ts
 D apps/jarvis-web/src/types/generated/WorkflowStepResult.ts
 M apps/jarvis-web/tsconfig.json
 ...（截断）
```

CLAUDE.md 同步约定（今日新增的末段 §Conventions）已写明：
> **Wire-shape types are owned by `@jarvis/shared-types`** — the Node-side
> single source of truth for types crossing the SPA boundary (the former
> Rust `ts_rs` codegen into `apps/jarvis-web/src/types/generated/` has been
> removed as a step toward decommissioning Rust). … See
> `docs/conventions/rust-ts-codegen.md` (retired-convention note).

但这个 30+ 文件删除 + 4 个 service/component 改写 + 2 个 build 文件改 + 1
个 tsconfig 改的批次**没落任何 commit**。意味着：

- main 头是 `2574c28`，PR #166 的 merge；
- 真实工作树里早就在做 ts_rs → @jarvis/shared-types 切换；
- 任何 fresh checkout / CI run 都会拿到一个"main 头 + 干净的 dist"，
  而本机的实际状态有 63 个改动。

> ⚠️ **6/21 follow-up**：核实 `packages/shared-types/src/index.ts` 是否
> 已经存在并覆盖了删除掉的 31 个 ts 类型；若是，应**先 commit** 这一波
> 删除 + 替换，再考虑下一步动作。F-NEW (R) 目前是**风险信号**，不是
> bug —— 但脏工作树越久越容易冲突。

---

## 4. f4a78fc3 自我修正持续（第 6 次追踪）

`/v1/diagnostics/runs/failed?limit=50` 拉满的 50 行里：

```text
top requirements by failure count:
  f4a78fc3 → 6
  47f3c24d → 4
  6348c77c → 3
  a8f36e4f → 3
  634533f7 → 3
earliest: 2026-05-06T07:43:48Z
latest:   2026-06-05T09:57:40Z       ← 15 d 前
```

`f4a78fc3` 的 6 次失败全是 Kimi `262 144 token limit` 400 错误，最后一次
是 `2026-06-05T09:57:40Z`。今日 `2026-06-19T19:09Z` − `2026-06-05T09:57Z`
= **15 d** 无任何新失败。这与 6/19 报告的"row 已 13 d 静默死锁"自然推进 +2 d。

picker 在 `auto_mode.rs:799` 的
`consecutive_failures < effective_max_retries` 分支上**永久短路**该行（3<6
= false）。`/v1/diagnostics/runs/stuck?threshold_seconds=600 → {items:[]}` 与
此自洽（既然不在跑就不算 stuck）。

**6/19 提的运维三件套依然有效，且未做**：
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
| Requirement ID      | `b889bcbb-cc9d-4915-a998-ebf64c93fba4`                                              |
| Title               | `PROBE 2026-06-20: iteration #9 — F-NEW(M) operator-gate confirmed + F-NEW(P) 404 holds + 15-day Run deadband` |
| Status              | `backlog`                                                                           |
| Triage              | （wire 层声明 `approved`，**实际丢弃** → `None`，触发 F-NEW (J)）                     |
| Verification plan   | `{"commands":["echo ok"]}`（POST 丢弃，PATCH 上盘）                                  |
| Acceptance policy   | （声明 `Subagent`，丢弃）                                                            |
| Assignee            | （声明 `scheduled-task`，丢弃）                                                      |
| Activity dir        | ENOENT（F-NEW (N) 持续）                                                             |

意图：把 6/16 (`af972b57`) → 6/17 (`cad50ed3`) → 6/18 (`b85352cd`) → 6/20
(`b889bcbb`) 四代探针并列，证明 J/K'/L/N 在 **13 天跨 4 个 HEAD（c2e3926
→ 94580f6 → b0a649b → 2574c28）** 都没被任何 PR 触及。整族 wire-shape
bug 在主干 Node.js port + 安全修补的高活跃期里**没人看，没人改**。

---

## 6. 当前 Harness 健康 → 是否需要再迭代一轮需求？

按 scheduled task 原意 ——
**"根据 Jarvis 的 Harness 健康来进行迭代需求判断"** —— 今日的判定：

| 维度                          | 信号                                                                                                       | 判定                |
|-------------------------------|------------------------------------------------------------------------------------------------------------|---------------------|
| Run throughput（8 d 窗口）    | runs_completed=0, runs_failed=0 全 0                                                                       | **无新需求**：跑不出 |
| `/v1/auto-mode`               | mode=off 第 13 天                                                                                          | **无新需求**：跑不动 |
| 写路径 J/K' wire-shape        | 即使建了 Requirement 也丢字段 → picker 找不到 default profile 时进入回退                                  | **无新需求**：建不全 |
| Reviewer 自动 flip (F-NEW H)  | 2ff5f931 已 14 d Review 滞留，结构上不可达                                                                 | **无新需求**：合不上 |
| F-NEW (N') 5.768 GB 孤儿      | 22 d 未 GC，诊断接口只读                                                                                   | **无新需求**：清不掉 |
| F-NEW (P) provider admin 缺挂 | 源码定位完成，是一行 `route(…)` 的事                                                                       | **可生成需求**：值得 1 张 Requirement，但**今日不写** —— 维持本周"只观测不写代码需求" 节奏 |
| F-NEW (R) 工作树脏 63 文件    | 是切换路径，不是 bug                                                                                       | **观察 + follow-up**，不生成需求 |

**结论**：今日**不为 Jarvis 自身生成需求**（与 6/19 同节奏）。理由是 ——
任何 Jarvis-自身需求在 `mode=off + J 漂移`下都不会被 picker 拣到，写
入 store 反而进一步污染 backlog 计数（已 +1 → 11）。

**唯一抗这个判断的反例**：F-NEW (P)。如果决定**把 `JARVIS_WORK_MODE`
翻一次**，应同时生成"修复 `/v1/providers/{:name,default}` 404"这张
Requirement —— 但前提是写路径 J 也修了。这是**两条 PR 的最小可
执行集**，不在今日 scheduled-task 的写入预算内，**留为 6/21 follow-up**。

---

## 7. 6/21 待办（明日 scheduled-task 入口）

按优先级：

1. **在 main 头（不 fresh checkout）跑一次 `cargo test -p harness-server
   --lib auto_mode:: -p harness-server --lib diagnostics::`**，对比 6/19
   的 50/0 + 9/0 baseline。期望仍 0 failures —— 否则是 PR #166 引入了
   回归。
2. **核实 `packages/shared-types/src/index.ts` 是否覆盖 `apps/jarvis-web/
   src/types/generated/` 删掉的 31 个类型**。若覆盖完整 → 建议 commit。
   若有缺漏 → 列出缺漏类型，**生成一张 Jarvis-Roadmap Requirement**。
3. **追 F-NEW (P) 漏装位置**：在 `routes.rs` 加挂
   `provider_admin_routes::router()`（若已存在）即可。**今日不写代码**，
   明日若与"翻 mode"一起做才生成 Requirement。
4. **观察 `b889bcbb`、`b85352cd`、`cad50ed3`、`af972b57` 四代探针**是否
   有任何变动（dry-run 期望全部不动）。
5. **观察 `git worktree list` 数量**：今日 25。Jarvis 自身没接到
   `.jarvis/worktrees/issue-43` 的 GC 信号；若再 +1 d（→ 23d）仍无人
   触发 reap，应**升级 F-NEW (N') 优先级**到"必须人为 GC"。
6. **不**在今日做：翻 `JARVIS_WORK_MODE`、删 `f4a78fc3`、commit 那 63 个
   脏文件、提交此报告以外的任何 git 写入。

---

## 8. 附录

- 探针 Requirement JSON：
  `~/.local/share/jarvis/conversations/requirements/e48ca961-cffe-4dcc-9c2e-0486363ddde4/b889bcbb-cc9d-4915-a998-ebf64c93fba4.json`
- MCP probe JSON：
  [`mcp-probe-2026-06-20.json`](./mcp-probe-2026-06-20.json)
- 上一份诊断报告：
  [`diagnostic-report-2026-06-19.md`](./diagnostic-report-2026-06-19.md)
- 历史系列：
  `diagnostic-report-2026-06-{11,12,13,15,19,20}.md` + 早期
  `JARVIS_AUTO_MODE_DIAGNOSTIC_2026-{05-09…06-18}.md`（在
  `~/Documents/GitHub/jarvis-servlet-demo/` 下）
