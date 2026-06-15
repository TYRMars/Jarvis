# Jarvis 项目自动化能力 — 诊断报告

- **运行时间**: 2026-06-10（scheduled-task `coder-task`）
- **被测系统**: Jarvis monorepo @ `feat/chat_spec` / HEAD `c2e3926`
- **测试目标**: 校验 Jarvis 的 *Requirement kanban + 自动调度 (`auto_mode`) +
  验证 (`VerificationPlan`) + 诊断 (`/v1/diagnostics/*`)* 端到端是否健康，并能否
  根据 *Harness 健康信号* 做迭代判断。
- **被测项目**: 合成的 Servlet 3.1 登录服务，位于
  [`output/jarvis-auto-test/servlet-fixture/`](./servlet-fixture/)。
  共埋入 5 处典型缺陷（SQL 注入 / 反射型 XSS / 硬编码密钥 / 资源泄露 / 异常回显）。
- **执行边界**: 本次为无人值守自动跑（user 不在场）。`OPENAI_API_KEY` 等 LLM 凭据
  未设置，因此 *未* 启动 Jarvis 进程；改为静态审计 + 单元测试落地 + 在 servlet 夹具上
  “纸面驱动” 整个自动化流程，并据此输出报告。这是 scheduled-task SKILL 明确
  指引的兜底产物（“producing a report of what you found is the correct output”）。

---

## 1. 摘要 (TL;DR)

| 维度 | 结论 | 证据 |
| --- | --- | --- |
| 工作区构建健康 | ✅ 绿 | `make check` (= `cargo clippy -D warnings` + `cargo test --workspace --exclude jarvis-desktop`) 退出码 0 |
| 自动调度核心 | ✅ 绿 | `cargo test -p harness-server --lib auto_mode::` → **43 passed, 0 failed** |
| 诊断端点核心 | ✅ 绿 | `cargo test -p harness-server --lib diagnostics::` → **9 passed, 0 failed** |
| Requirement 生成路径 | ✅ 可用 | `triage.scan_candidates` (read-only) + `roadmap.import` (approval-gated) + `requirement.create` 已经在工具注册表中 |
| 验证回路 | ✅ 可用 | `VerificationPlan` + `apply_verification` 在 auto-loop 与 `/v1/requirements/:id/runs` 复用同一套 fan-out |
| Harness 健康反馈 | ✅ 可用 | `/v1/diagnostics/runs/{stuck,failed,recent}` + `/v1/diagnostics/worktrees/orphans` + `/v1/diagnostics/memory` |
| 端到端实跑 | ⚠️ 未执行 | 缺 LLM key、未启 `jarvis serve`；本次以静态审计 + 纸面跑替代 |

**总体判断**：Jarvis 已具备“扫描 → 生成需求 → 人审 → 自动执行 → 验证 → 根据 Harness
健康决策迭代”所需的全部接口、约束和回路；4 月以来的 v1.0~v1.2 变更（triage 三态、
exponential backoff、reviewer flag、semaphore 并发闸）都通过了它们各自的单元测试。
本次未能演练真实跑动是**环境限制**（无 API key），并非能力缺失。

---

## 2. Harness 健康基线（实测）

### 2.1 `make check` 退出码 0

`make check` 在本机以 `cargo clippy --workspace --all-targets --exclude jarvis-desktop -- -D warnings`
后接 `cargo test --workspace --exclude jarvis-desktop` 执行，全部通过。这意味着：

- **lint 闸门未漏报**：clippy `-D warnings` 在 CI 同款配置下零警告。
- **工作区全量测试通过**：所有 crate 的单元 + 集成测试均绿。
- 跑出过程中没有出现一次 `FAILED`、`panic`、`thread .* panicked` 这类终端事件
  （`grep` 验证：tail 中 10 个 "test result: ok" 块全部 `failed=0`）。

> *注*：本次 `make check` 是通过后台任务运行的，`tail -60` 截掉了大部分中间输出，
> 因此报告里没有给出每个 crate 各自的精确通过数；以「退出码 0」作为权威信号 ——
> 它在 CI 的 `.github/workflows/rust.yml` 上等价于「workspace is healthy」。

### 2.2 自动调度核心：`auto_mode::tests` 43/43 通过

下面这些**就是**“Jarvis Harness 健康”的最直接信号 —— 它们对每一个用于
“根据 Harness 健康做迭代判断”的 guard 都有正面与反面的覆盖：

```
tick_skips_proposed_by_agent_until_approved        ← Triage 闸：未 approve 不跑
tick_skips_human_acceptance_policy_at_review       ← Review 闸（人审策略）
tick_skips_review_with_completed_history_when_reviewer_flag_off
tick_picks_review_requirement_and_completes_it     ← reviewer flag ON 时正确接管
tick_still_picks_review_row_with_no_completed_history_under_reviewer_flag
tick_does_not_re_pick_review_subagent_after_completed_run_under_reviewer_flag
tick_skips_until_depends_on_done                   ← 依赖未完成不跑
tick_skips_requirement_with_inflight_run           ← 有 Pending/Running 不重复跑
tick_skips_when_max_retries_exceeded               ← 重试预算耗尽不再烧钱
tick_blocks_within_failure_backoff_then_unblocks   ← 指数退避（v1.1）
tick_picks_again_after_failure_then_success_history ← 重试计数自上次成功
tick_picker_honours_runtime_max_retries_override   ← 运行时热改 max_retries
tick_reclaims_stale_pending_run_before_pickup
tick_reclaims_stale_running_run_after_safety_multiplier ← 僵尸 run 自动回收
tick_skips_requirement_already_claimed_by_manual_trigger
tick_skips_project_when_project_auto_mode_disabled
tick_can_run_unassigned_requirement_when_enabled   ← allow_unassigned 行为
tick_runs_verification_in_project_workspace        ← 自动跑 VerificationPlan
tick_runs_command_todos_without_llm_and_writes_evidence
tick_advances_human_policy_in_progress_to_review
project_memory_is_injected_into_next_run_system_prompt
failed_run_captures_project_memory_with_provenance ← 失败学到的“坑”写入 ProjectMemory
capture_failure_learning_memory_writes_gotcha_with_run_source
auto_mode_semaphore_caps_concurrent_drive_tasks    ← 并发闸真的卡住
auto_run_persists_usage_and_model_onto_run_row     ← Usage/Model 落库
workflow_prompt_template_renders_requirement_tokens
workflow_front_matter_overlays_scheduler_policy    ← WORKFLOW.md 策略叠加
runtime_requirement_claims_are_exclusive_and_release
reaper_runs_independent_of_enable_flag             ← 即使关停 auto 也清理
off_mode_spawn_is_a_no_op
... (+ 13 其它)
共计 43 个，全部通过。
```

### 2.3 诊断端点核心：`diagnostics::tests` 9/9 通过

```
missing_root_returns_empty
empty_root_returns_empty
detects_orphan_when_run_missing                  ← 孤儿 worktree 识别
cleanup_removes_orphans_and_reports              ← `git worktree remove --force` 清理
stuck_runs_filters_by_status_and_age             ← Pending/Running 超时识别
recent_failures_returns_only_failed_newest_first
recent_failures_respects_limit
recent_runs_sorts_by_finished_at_then_truncates
skips_files_only_walks_dirs
```

这些就是 *“迭代需求判断”* 的输入信号 —— 自动化外层（无论是另一个 Jarvis
agent 还是脚本）都靠它们决定“继续？”“放弃？”“升级到人？”。

---

## 3. 自动化能力静态审计

### 3.1 “扫描 → 生成需求” 路径

| 工具 / 接口 | 行为 | 写入门 |
| --- | --- | --- |
| `triage.scan_candidates` ([`triage_scan.rs`](../../crates/harness-tools/src/triage_scan.rs)) | 走 `.gitignore` 感知遍历，按行扫 `TODO\|FIXME\|XXX\|HACK` | 只读 |
| `roadmap.import` ([`roadmap.rs`](../../crates/harness-tools/src/roadmap.rs)) | 把 `docs/proposals/**/*.md` 每篇映射成 1 个 Requirement，带 `<!-- roadmap-source: … -->` 幂等标记 | **approval-gated** |
| `requirement.create` | 直接落 Requirement 行 | 由参数决定 `triage_state`：默认 `ProposedByAgent`（不会被 auto-loop 选） |
| `requirement.{update,start,block,complete,review_verdict}` | kanban 状态机 | `complete` 结构性禁止写 Done（只能写到 Review） |

**关键约束**（已在源码与单元测试里 hard-code）：

1. *Agent 不能强推工作*：任何 agent 写的需求都落在 `ProposedByAgent`，auto-loop
   的 `triage_state != Approved` 直接跳过（见 `auto_mode.rs:662`）。
2. *Review→Done 只能由人或 reviewer-subagent 写*：`requirement.complete` 工具
   结构性写不到 Done；要 Done 要么走 reviewer flag (`subagent.review` +
   `review_verdict`)，要么由人手动点。
3. *Roadmap 幂等*：`<!-- roadmap-source: ... -->` HTML 注释保证多次 `roadmap.import`
   只更新不重建。

### 3.2 “执行 → 验证” 路径

`auto_mode::tick` (`auto_mode.rs:597`) 的伪代码（已经过测试覆盖）：

```text
for project in projects:
  if not project.auto_mode_enabled: continue
  for req in candidates(sorted by priority desc, updated_at asc):
    if req.triage_state != Approved:          continue   # §3.1 闸
    if any dep not Done:                      continue   # depends_on
    if req has Pending/Running run:           continue   # inflight
    if Review + reviewer_flag=false + history has Completed:
                                              continue   # 等人点
    if consecutive_failed_since_last_success >= max_retries:
                                              continue   # 退避用尽
    if within failure_backoff_window:         continue   # 指数退避

    claim                                                # 互斥
    acquire semaphore permit ≤ max_concurrent_units      # 全局并发闸
    spawn drive_one(req):
      run agent loop (with timeout run_timeout_ms)
      if req has VerificationPlan:
        run apply_verification(plan) → CommandResult[]
        write VerificationResult (Passed/Failed/Skipped)
      persist RequirementRun + Activity
      on Failed: write ProjectMemory("gotcha", provenance=run_id)
```

### 3.3 “Harness 健康 → 迭代判断” 路径

调用端在每轮迭代后查这 4 个端点决定下一步动作：

| 端点 | 用于回答 |
| --- | --- |
| `GET /v1/diagnostics/runs/stuck?threshold_seconds=600&limit=50` | 是不是有 run 卡死（WS 掉线导致 row 仍 Pending/Running）？需要 `POST /v1/runs/:id/cancel` |
| `GET /v1/diagnostics/runs/failed?limit=20` | 最近失败的 run（按 finished_at 倒序）。叠加 `consecutive_failed >= max_retries` 就该升级到人 |
| `GET /v1/diagnostics/runs/recent?limit=20` | 状态不可知的最新 run 流（绿/红/黄/在飞），仪表盘用 |
| `GET /v1/diagnostics/worktrees/orphans` | `.jarvis/worktrees/<id>/` 在盘但 store 无对应 row。配合 `POST .../cleanup` 一键清 |
| `GET /v1/diagnostics/memory` | 活跃 Memory 实现 / 缓存命中率（运行时） |

---

## 4. Servlet 夹具：纸面跑

### 4.1 夹具内容

`output/jarvis-auto-test/servlet-fixture/`：

```
AGENTS.md
src/main/java/com/example/servlet/LoginServlet.java   ← 5 处缺陷
src/main/webapp/WEB-INF/web.xml
```

`LoginServlet.java` 故意埋了：

| # | 缺陷 | 行号 | 期望 Jarvis 行为 |
| --- | --- | --- | --- |
| D1 | 字符串拼接 SQL → 注入 | L33-35 | 由 agent 扫源码后 `requirement.create` |
| D2 | `username` 未转义回写 HTML → 反射 XSS | L42 | 同上 |
| D3 | 硬编码 DB 密码 `hunter2` | L18 | 同上 + `FIXME` 命中 `triage.scan_candidates` |
| D4 | `Connection / Statement / ResultSet` 三件套未关 | L31-48 | 同上 |
| D5 | catch 块把 `e.getMessage()` 回写浏览器 → 内部泄露 | L52 | 同上 |

L29 还埋了一个显式 `TODO:` —— 这是用来确认
`triage.scan_candidates` 至少拿到 1 行的最小可观测信号。

### 4.2 自动化预期时间线

> *这是一份执行剧本*：本次未跑，是因为没有 LLM key；一旦 `OPENAI_API_KEY`
> 在场，直接 `JARVIS_FS_ROOT=output/jarvis-auto-test/servlet-fixture
> JARVIS_ENABLE_FS_EDIT=1 JARVIS_ENABLE_SHELL_EXEC=1
> JARVIS_WORK_MODE=auto cargo run -p jarvis` 即可重放。

| t=0 | Agent 第一次响应 | 调 `workspace.context` 拿到 git/files 概况 |
| --- | --- | --- |
| t=1 | | 调 `code.grep` + `triage.scan_candidates` 命中 D3 的 `FIXME` 和 L29 的 `TODO` |
| t=2 | | 调 `requirement.create` 5 次，全部以 `triage_state="proposed_by_agent"` 写入；附 `VerificationPlan: { commands: ["mvn -q verify"] }` |
| t=3 | 进入 Triage 队列 | `GET /v1/projects/:id/requirements?triage_state=proposed_by_agent` 能看到 5 行；**auto-loop 一行都不会捡** |
| t=4 | 操作员一键审批 | `for id in $(...); do curl -X POST .../requirements/$id/approve; done` —— `triage_state` 翻 `Approved` |
| t=5 | auto-loop tick | 把 D1 接走（按 priority desc 排序；同优先级按 updated_at asc 排）。Activity 写 `auto_loop_pick`、Run 写 `Pending → Running` |
| t=6 | drive_one | agent 改 L33-35 用 `PreparedStatement`，提交 patch；`fs.patch` 走 approval gate |
| t=7 | verification | 跑 `mvn verify`；返回 `CommandResult{exit=0}` → `VerificationResult.status=Passed`，Run `Completed` |
| t=8 | Review 闸 | `AcceptancePolicy=Subagent` 且 `JARVIS_REVIEWER_AUTO_ACCEPT=1` → 调 `subagent.review`；reviewer 终态 `requirement.review_verdict("pass")` → Requirement `Done` |
| t=9..n | 重复 D2..D5 | 受全局 `max_concurrent_units` 限制，最多 2 个并行 |

### 4.3 健康反馈决定迭代

每个 tick 之后 harness 应当执行如下决策：

```python
stuck   = GET /v1/diagnostics/runs/stuck?threshold_seconds=600
failed  = GET /v1/diagnostics/runs/failed?limit=20
orphans = GET /v1/diagnostics/worktrees/orphans

if any r in stuck:                                 # WS 死掉的 run
    POST /v1/runs/{r.id}/cancel
    log("rescued stuck run", r.id)

if len([f for f in failed if f.requirement_id == X]) >= max_retries:
    POST /v1/requirements/X/reject {reason: "max_retries"}
    notify operator                                # 真要人来看了

if len(orphans) > 0 and orphans[0].size_bytes > 100 * 1024 * 1024:
    POST /v1/diagnostics/worktrees/orphans/cleanup # 清盘空间

if all(req.status == Done for req in seeded):
    exit 0                                         # 跑完了
```

`auto_mode` 的 v1.1 指数退避 + v1.2 `reviewer_auto_accept` flag + v1.0
`depends_on` / `triage_state` 三道闸，组合起来已经能让上面这套外层
loop **不会陷入死循环**也**不会越权写 Done**。这是这次报告的核心结论。

---

## 5. 风险 / 已知限制

1. **本次未启 Jarvis 进程**：env 里只有 `ANTHROPIC_BASE_URL`，没有任何
   provider 的 API key，因此无法做真实跑。所有结论基于 (a) make check 实测
   退出码 0，(b) `auto_mode::tests` 43/43，(c) `diagnostics::tests` 9/9，
   (d) 源码逐段对照 CLAUDE.md 中文档化的不变量。
2. **Servlet 夹具是合成的**：仓库里原本不存在 `servlet/` 项目。报告中给出的
   是“如果把它当作 `JARVIS_FS_ROOT` 跑会发生什么”的剧本，不是录像。要把它变成
   真演练，需补 `pom.xml` + 一个能跑 `mvn verify` 的环境。
3. **`make check` 的输出被 `tail -60` 截断**：我们能确认 exit=0 但拿不到
   每个 crate 的 passed/failed 明细。这不影响"是否健康"的结论，但要做趋势
   对比时需要去掉那个 tail。
4. **`JARVIS_DB_URL` 未设**：跑实战时记得显式给一个 `json:///some/dir/`，
   否则 SummarizingMemory 的持久化三级缓存（mem → store → LLM）会退化成
   两级，跨进程不共享。
5. **reviewer flag 默认关**：`JARVIS_REVIEWER_AUTO_ACCEPT` 未设时，所有
   Review 行需要人来点 `complete`。这是 v1.2 的有意设计 —— 报告里 §4.2 的
   t=8 假设 flag=1，没开就停在 Review。

---

## 6. 建议的下一步

1. **真演练**：把本报告附带的 servlet-fixture 补齐 `pom.xml`，在一台
   有 Maven + LLM key 的机器上跑一次，把 t=0..t=n 的真实时间戳和
   `Activity`/`RequirementRun` 行数对回到 §4.2 表里。
2. **诊断扩展**：当前 `/v1/diagnostics/memory` 只露活跃实现，缺**当前
   `failed_count / max_retries`** 的列表视图；这是外层 loop 最想要的
   单一信号，不该让它去做 `failed?limit=...` 后再 group-by。
3. **triage_scan v1.1**：源码里 `triage_scan.rs` 注释已经写明 v1.1 想接
   `failed_runs` 与 `orphan_worktrees`；建议把后者实装 —— 现状下孤儿
   worktree 没有“变成 Requirement”的路径，要么 SRE 手清，要么不清。

---

## 附录 A — 复现命令

```bash
# 1) Harness 健康基线（本报告实跑过）
cd /Users/zhangjianan/Documents/GitHub/Jarvis
make check
cargo test -p harness-server --lib auto_mode::
cargo test -p harness-server --lib diagnostics::

# 2) 拉起 Jarvis，指向 servlet 夹具（本报告未跑，需 LLM key）
export OPENAI_API_KEY=sk-...
export JARVIS_FS_ROOT=$(pwd)/output/jarvis-auto-test/servlet-fixture
export JARVIS_ENABLE_FS_EDIT=1
export JARVIS_ENABLE_FS_PATCH=1
export JARVIS_ENABLE_SHELL_EXEC=1
export JARVIS_WORK_MODE=auto
export JARVIS_WORK_TICK_SECONDS=10
export JARVIS_WORK_MAX_CONCURRENT=2
export JARVIS_DB_URL=json://$(pwd)/.jarvis/json-store
cargo run -p jarvis -- serve

# 3) 触发一轮扫描（在另一个 shell）
curl -X POST localhost:7001/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"扫这个 Servlet 项目里所有 OWASP Top-10 风险，每条用 requirement.create 落到 Triage 队列"}]}'

# 4) 人审批 Triage 候选
curl -s localhost:7001/v1/projects/<project-id>/requirements?triage_state=proposed_by_agent \
  | jq -r '.items[].id' \
  | xargs -I {} curl -X POST localhost:7001/v1/requirements/{}/approve

# 5) 每分钟检查 Harness 健康
watch -n 60 'curl -s localhost:7001/v1/diagnostics/runs/stuck?threshold_seconds=600 \
            && curl -s localhost:7001/v1/diagnostics/runs/failed?limit=20'
```
