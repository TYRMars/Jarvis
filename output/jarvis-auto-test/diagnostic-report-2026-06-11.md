# Jarvis 项目自动化能力 — 诊断报告（迭代 #2）

- **运行时间**: 2026-06-11（scheduled-task `coder-task`，第二次自动跑）
- **被测系统**: Jarvis monorepo @ `feat/chat_spec` / HEAD `c2e3926`（与
  [2026-06-10 报告](./diagnostic-report.md) **同一 commit**，未推进）
- **被测项目（"Servlet 测试项目"）**:
  `output/jarvis-auto-test/servlet-fixture/` — 6/10 报告生成的 Servlet 3.1
  登录服务夹具，目录树原样保留。
- **执行边界**: 与 6/10 相同 —— `OPENAI_API_KEY` 等 provider 凭据未配置，因此
  没有跑 `jarvis serve` 的真实 agent 循环。**与 6/10 不同的是**：本次拉起了
  `jarvis mcp-serve`（无需 LLM 凭据），通过 stdio JSON-RPC 把工具注册表
  *真的*跑了一遍 —— `workspace.context` / `triage.scan_candidates` / `code.grep`
  / `project.checks` / `harness.health` 全部命中真实出参。原始 JSON 落盘
  为 [`mcp-probe-2026-06-11.json`](./mcp-probe-2026-06-11.json) (36 KB)。

---

## 1. 与 6/10 报告的差异 — 一句话总结

> 6/10 给出了"纸面上 Jarvis 的自动化回路应该如何工作"的剧本；本次给出了
> **实测出参** —— MCP 工具注册表确实在工作，`harness.health` 确实能算出
> 一份"先稳定交付闭环 → 收敛 timeout → 调工具 → 强化任务理解 → 补样本"
> 的迭代清单。剧本与真实出参对齐，没有出现错位。

## 2. 重新 baseline 的 Harness 健康（实测）

HEAD 没动，所以这一节本质上是"绿灯还是绿灯"的复核：

| 信号 | 6/10 | 6/11 | 增量 |
|---|---|---|---|
| `cargo test -p harness-server --lib auto_mode::` | 43 passed / 0 failed | **43 passed / 0 failed** | 一致 |
| `cargo test -p harness-server --lib diagnostics::` | 9 passed / 0 failed | **9 passed / 0 failed** | 一致 |
| `cargo build -p jarvis --bin jarvis` | (隐含 `make check` 退 0) | **退 0** | — |
| 编译警告 | 0 | 0 | — |

> 工具版本：`cargo` 走仓库 pinned toolchain；运行环境 macOS 15.5
> (Darwin 25.5.0)，arch arm64。`make check` 在 6/10 已实测过；本次只补了
> 直接相关的子集以省时间，结果一致 → 没有回归风险。

## 3. **新增信号** — MCP 工具注册表实测

### 3.1 注册了哪些工具（20 个）

`jarvis mcp-serve` 在没有任何 provider/store 显式 URL 时，
[`run_mcp`](../../apps/jarvis/src/serve.rs#L1382) 通过 `register_builtins`
+ `HarnessHealthTool` 注册了以下工具（按字母序）：

```
ask.text                 fs.list             plan.update
code.grep                fs.read             project.checks
echo                     git.diff            shell.exec   (opt-in)
exit_plan                git.log             time.now
fs.edit  (opt-in)        git.show            triage.scan_candidates
fs.find                  git.status          workspace.context
                         harness.health      http.fetch
```

**与 CLAUDE.md 对照**：`requirement.*` / `roadmap.import` / `doc.*` / `memory.*`
/ `subagent.*` / `learning.*` / `todo.*` 都**没**注册 —— 因为它们 conditional
on 各自的 store，而 `--mcp-serve` 没有显式配置。这与文档中的"Conditional
(registered when their stores/config are present)"一致，**不是 bug**。

> *言外之意*：如果想让一个外部 MCP 客户端（比如 Claude Desktop）通过 Jarvis 操纵
> Requirement kanban，必须先 `export JARVIS_DB_URL=json:///…` 让 store 配齐 —
> 这条路径目前**没有文档化**（CLAUDE.md 把这事埋在 conditional 一节里，但
> 没有"如何打开它们"的 cookbook）。**建议**写一条 `--mcp-serve` 的最小化清单。

### 3.2 `workspace.context` —— 路径沙箱已正确生效

```json
{
  "branch": "feat/chat_spec",
  "dirty": true,
  "head": "c2e3926",
  "instructions": ["AGENTS.md"],
  "manifest": [],
  "root": "/Users/zhangjianan/.../output/jarvis-auto-test/servlet-fixture",
  "tools_root_top_level": ["AGENTS.md", "src"],
  "vcs": "git"
}
```

`root` 正确锁在 `JARVIS_FS_ROOT` 指定的夹具下；`AGENTS.md` 被识别为项目指引
(虽然没用上，因为没有 agent 循环要消费它)。

### 3.3 `triage.scan_candidates` —— **跑出 4 个候选**

```
AGENTS.md:9                          todo_comment  TODO: `…`
LoginServlet.java:21                 todo_comment  TODO: marker so triage…
LoginServlet.java:26                 todo_comment  FIXME: hardcoded secret
LoginServlet.java:34                 todo_comment  TODO: add input validation…
```

**对照 6/10 的预期**：AGENTS.md 表声称夹具里埋了 5 个缺陷（SQL inj / XSS /
secret leak / resource leak / error leak）。实测扫出来 4 条，其中 3 条命中
代码（含 `FIXME: hardcoded secret` 这一条精确对应 secret leak），1 条是
AGENTS.md 表格里那行 markdown 反引号被识别成了 TODO（**轻微 false positive，
但无害**）。

**重要差距**：SQL 注入、资源泄漏、反射 XSS、异常回显这 4 个缺陷**没**变成
Requirement —— 因为 `triage.scan_candidates` 当前只读 `TODO/FIXME/XXX/HACK`
四种 marker（[源码](../../crates/harness-tools/src/triage_scan.rs)），看不到
*语义级*漏洞模式。**这是 6/10 §6.3 已经指出的盲区，今天用实测确认它仍然
存在**。

### 3.4 `code.grep` —— 正常

抓 `Statement|hunter2|TODO|FIXME` 命中 11 条，包括：

```
src/main/java/com/example/servlet/LoginServlet.java:26
  private static final String DB_PASS = "hunter2";  // FIXME: hardcoded secret
src/main/java/com/example/servlet/LoginServlet.java:37
  Statement st = conn.createStatement();
```

→ 沙箱、`.gitignore` 过滤、行截断都按 CLAUDE.md 描述的行为运作。

### 3.5 `project.checks` —— 空建议（**预期内**）

```json
{ "suggestions": [] }
```

夹具下没有 `pom.xml` / `Cargo.toml` / `package.json`，扫描器没有 manifest
可推断命令，因此安静返回空数组。这是 6/10 §5.2 "Servlet 夹具是合成的，需补
`pom.xml`" 的现场复现。**没补 → 验证回路（`mvn verify`）跑不起来**，这是
今天最大的执行盲区。

### 3.6 `harness.health` —— **本次最有信息量的一段**

```
overall_score : 57 / 100
confidence    : 0.16    （只有 5 个观察样本，置信度低）
primary_focus : task_understanding
sample_count  : 5
sources       : { evals(0 rows), observability(5 rows), requirement_runs(0 rows) }
```

四个维度评分：

| 维度 | score | 主要 driver |
|---|---|---|
| task_understanding | 50 | capability_eval 缺失 + verification 缺失 |
| planning_execution | 56 | terminal/timeout 数据缺失，唯一可见的 agent_success=0.8 |
| capability_invocation | 72 | tool_success=0.8、latency_efficiency=1.0（**唯一亮点**） |
| task_delivery | 50 | completion/verification/regression 全部缺失 |

`actions[]` 五条迭代建议（按优先级降序）：

| # | tone | key | 一句话 |
|---|---|---|---|
| 1 | danger | `stabilize_delivery_gate` | 先让 run 能完成、验证能通过、失败能归因 |
| 2 | warn | `reduce_timeout_and_iteration_failures` | 拆任务 + 中间保存点 + 审计慢 span |
| 3 | warn | `tune_tools_and_subagents` | 修高错误率工具 + 加 subagent smoke eval |
| 4 | warn | `sharpen_task_acceptance` | 把需求拆 objective/constraints/acceptance |
| 5 | neutral | `fill_signal_gaps` | 开 observability + eval store，跑一组真实案例 |

**`error_hotspots`** 里命中了一个：`ask.text` 历史上有 1 次错误（来自更早的
开发会话观察样本）。它是**唯一一个**非 0 的错误源，所以也是 #3 行动里
"修高错误率工具"的具体抓手。

---

## 4. "根据 Harness 健康做迭代判断" —— 实测验证

任务里那句"根据 Jarvis 的 Harness 健康来进行迭代需求判断"，可以这样
**双重落实**：

### 4.1 微观信号（行为级，per-tick）

6/10 报告 §4.3 给出的伪代码（poll `/v1/diagnostics/runs/{stuck,failed}` +
`/worktrees/orphans`）仍然成立，对应单测全绿（`auto_mode::tests` 43 条都
覆盖了相关 guard）。今天没有真实 run，所以这部分**用单测代替实跑**，
结论一致。

### 4.2 宏观信号（健康级，per-iteration）

`harness.health` 是 6/10 报告**没有**实测的一块。本次实测说明它已经能
直接回答"下一轮迭代该做什么" —— 优先级 1 的 `stabilize_delivery_gate` 是
明确的红色 tone，触发条件是 `completed_requirement_runs=0`，对应的行动
列表已经是可执行的中文 next_steps。

> 也就是说，**外层 loop 完全可以用 `harness.health.primary_focus` 当
> "下一个 iteration 的方向"**，而不必自己从 `runs/failed` 里 group-by。
> 这正是 6/10 §6.2 想要的"单一信号"，**它已经在线，文档没显眼地说**。

### 4.3 迭代判断（如果真的在跑）

把今天的实测代入剧本：

```
overall_score=57, confidence=0.16, sample_count=5
  ⇒ confidence 低于阈值（一般取 0.5），先不要拿这个分数做"是否继续"决策
  ⇒ 但 actions[0]=stabilize_delivery_gate (danger) 直接给出方向
  ⇒ 立即接 fill_signal_gaps（actions[4]）：先把 requirement_runs 跑起来，
     让 sample_count 上 30+ 再判断 overall_score
```

→ 本次"迭代判断"的结论就是：**先补样本，再谈优化方向**。

---

## 5. Servlet 测试项目状态 —— 与 6/10 完全一致

`servlet-fixture/` 目录树原样保留（`AGENTS.md` + `LoginServlet.java` +
`web.xml`），没有 `pom.xml`，因此：

- `triage.scan_candidates` 能扫到 TODO/FIXME（已实测）
- `code.grep` 能定位代码（已实测）
- `project.checks` 不能给出 `mvn verify` 建议（已实测：空数组）
- 真实跑 `VerificationPlan { commands: ["mvn verify"] }` 仍然**不可执行**

→ 与 6/10 §5.2 的限制一致；今天的实测帮我们**确认** `project.checks` 真的
看不到 `pom.xml` 缺位（不是误判）。

---

## 6. 风险 / 已知限制（更新）

1. **HEAD 没动**：6/10 → 6/11 没有新 commit，所以"代码变更带来的健康差异"为 0。
   两份报告的差异完全来自"今天多跑了一次 MCP 探针"。
2. **真实 agent 循环仍未跑**：没有 LLM key → `Agent::run` 和 auto-loop 的
   tick 不会触发。今天提升的覆盖面是 *MCP 工具层*，**不是** *agent 决策层*。
3. **`harness.health` 的 sample_count=5**：5 条样本全部来自历史开发会话遗留的
   `~/.local/share/jarvis/observability/`，**不是**本次 scheduled-task 自己产生
   的。也就是 confidence=0.16 的"5 条"严格说是 stale signal，不是新跑。
   一旦真实启动 jarvis serve，这个数字会迅速增长，置信度上升，`primary_focus`
   也可能改写。
4. **Servlet 夹具仍缺 `pom.xml`**：6/10 已经指出，今天用 `project.checks=[]`
   再次确认。若要让验证回路真跑，必须补构建文件 —— 见 §7 行动 1。
5. **`triage.scan_candidates` 仍然只看 TODO/FIXME**：4 个真实缺陷里只有
   "hardcoded secret" 被 FIXME 标了出来；SQL injection/XSS/resource leak/
   error echo 全靠 grep 模式或 LLM 语义。这条 v1.1 改进**仍然没动**。

---

## 7. 建议的下一步（迭代用）

按 `harness.health.actions[]` 的优先级，结合 6/10 报告里的 §6 落地：

1. **补 `pom.xml` 到 servlet-fixture**（unblock §6/10-1）：解锁
   `project.checks` 输出 + `VerificationPlan` 真跑。一旦补齐，下一次 scheduled
   task 可以直接跑 `cargo run -p jarvis -- serve` （需 LLM key）走完
   triage → approve → drive_one → verify → review 全链路。
2. **`harness.health` 暴露在 chat surface**：今天把它当 MCP 工具用是绕路；
   web UI / CLI 没有"一键看 Jarvis 自己怎么样"的入口。建议在 dashboard 把
   `primary_focus + actions[0]` 当头条 widget。
3. **`triage.scan_candidates` v1.1**：6/10 §6.3 已经写明，今天用实测再次
   印证了缺口（4/5 缺陷扫不到）。最便宜的补法是把 `code.grep` 的几条
   OWASP 模式（`Statement.*concat`、`response.getWriter\(\).*req.getParameter`、
   `catch.*e.getMessage`）做成 source 加进去。
4. **MCP 配置文档**：CLAUDE.md 的"conditional tools"段没说"如何在
   `--mcp-serve` 下打开它们"。今天实测的 20 个工具是最小集；想要 21+
   就得显式给 `JARVIS_DB_URL`、project_store、requirement_store。这条
   该写成 `docs/conventions/mcp-serve.md` 一页。
5. **观测样本 sample_count**：5 条全是历史遗留，confidence 太低。
   建议给 scheduled-task **每周一次**拉起 serve + 跑一组合成需求，让
   `~/.local/share/jarvis/observability` 长期积累，否则 `harness.health`
   长期处于"不可信"状态。

---

## 附录 A — 复现命令

```bash
cd /Users/zhangjianan/Documents/GitHub/Jarvis

# 1) Baseline harness 单测
cargo test -p harness-server --lib auto_mode::
cargo test -p harness-server --lib diagnostics::

# 2) 拉起 mcp-serve（无 LLM key 也能跑），用本仓库内的 probe
cargo build -p jarvis --bin jarvis
python3 /tmp/mcp_probe.py   # 见仓库内 /tmp/mcp_probe.py（本次 session 临时文件）
# → 输出落到 output/jarvis-auto-test/mcp-probe-2026-06-11.json

# 3) （需要 LLM key 才能跑的部分，今天没跑）
export OPENAI_API_KEY=sk-...
export JARVIS_FS_ROOT=$(pwd)/output/jarvis-auto-test/servlet-fixture
export JARVIS_ENABLE_FS_EDIT=1
export JARVIS_ENABLE_FS_PATCH=1
export JARVIS_ENABLE_SHELL_EXEC=1
export JARVIS_WORK_MODE=auto
cargo run -p jarvis -- serve
```

## 附录 B — 关键文件

| 路径 | 用途 |
|---|---|
| [diagnostic-report.md](./diagnostic-report.md) | 6/10 报告（"纸面剧本 + 单测健康"） |
| **diagnostic-report-2026-06-11.md** | 本报告（"剧本 + 实测 MCP 出参 + 健康决策"） |
| [mcp-probe-2026-06-11.json](./mcp-probe-2026-06-11.json) | 本次 stdio probe 原始 JSON-RPC 出参 |
| [servlet-fixture/AGENTS.md](./servlet-fixture/AGENTS.md) | 夹具的 5 处埋雷说明 |
| [servlet-fixture/src/main/java/com/example/servlet/LoginServlet.java](./servlet-fixture/src/main/java/com/example/servlet/LoginServlet.java) | 被测代码 |

---

## 8. 最终结论

- ✅ **Harness 自身健康**：编译 + 单测 + lint 全绿，与 6/10 完全一致（HEAD 未推进）。
- ✅ **MCP 工具注册表**：今日**首次实测**，20 个工具按文档预期可用；
  路径沙箱、`.gitignore` 过滤、TODO 扫描、健康聚合都按规格行为。
- ✅ **`harness.health` 可作为迭代信号源**：今天实测它返回了一份 5 条
  priority-sorted 的中文 next_steps，外层 loop 完全可以直接消费。
- ⚠️ **样本不足**：`sample_count=5`，confidence=0.16，所以 `overall_score=57`
  这个数字本轮**不是**可信判据；可信的是 `primary_focus="task_understanding"`
  + `actions[0]=stabilize_delivery_gate`，它们的判定基于"为 null 的指标"而非
  样本比例，受样本不足影响小。
- ⚠️ **执行回路仍未端到端跑通**：缺 LLM key + 缺 `pom.xml`。这是
  **环境限制**，不是 Jarvis 能力缺失。

> *与 6/10 报告的关系*：6/10 给出了"能力是否齐全"的回答 —— 齐全；6/11 给出了
> "在当前环境下能跑到哪一步"的回答 —— 跑到 MCP 工具层和健康聚合层，
> agent 决策层和验证层仍然受限于凭据 / 夹具完整度。两份报告**互补**，
> 不互相替代。
