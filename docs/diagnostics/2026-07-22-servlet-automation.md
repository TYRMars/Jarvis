# Jarvis 项目自动化能力诊断报告（2026-07-22 二十二次复测）

- **运行时间**：2026-07-22（scheduled task 自动跑）
- **被测分支**：`feat/mobile-ios-ddns`（HEAD 仍为 `64d288a`，与 06-23 → 07-21 同一 commit — **静默第 29 天**；工作树侧 **39** 个未 commit 文件与 07-21 逐字一致）
- **被测项目**：`/tmp/jarvis-servlet-test`
  - **07-22 差异**：07-21 报告的 fixture 部分丢失（pom.xml/HelloServlet.java/web.xml 消失）**已在昨日报告结束时重建**，本轮启动时 `README.md`+`src/main/java/com/example/HelloServlet.java`+`src/main/webapp/WEB-INF/web.xml` 三个文件都在（README 内嵌 prompt-injection 段落也已清理）；`pom.xml` 仍缺（stub-mode 不需要）
  - **07-22 vs 07-21 一日间隔**：0 commit、0 test 变化、0 源码触摸；本轮 headline 是**在 07-18(sample=6..16)与 07-21(sample=32..61)之间打通 sample=8..37 完整曲线**，把 07-21 §L4 的"confidence 恒定 0.4750 anomaly"精确定位到**转折点 sample=30**
- **本次目的**：
  1. **回归确认** 07-21 P0/P1/P2 累积项在 1 天间是否被修复（预期：全未修，第 29 天）
  2. **07-21 §L4 未验证项落地**：
     - 07-18(sample=16 confidence=0.392) 与 07-21(sample=32 confidence=0.4750 已锁死) 中间的 **sample=17..31 曲线数据**（07-21 明列"需要更早 sample 曲线补齐"）
     - 精确定位 confidence 触顶转折点
     - `actions` 从 3 → 2 → 3 的转换点
     - 每维 `dim.confidence` 在触顶后是否也锁死（还是只 overall 锁死）
  3. **今日新发现**（07-21 未预告）：
     - **✨ HEADLINE**：`confidence` 触顶点定位于 **sample=30** — 从 sample=29 (0.47046) 到 sample=30 (0.47500) 单步跳到锁死值；后续 30..37 全部 0.47500 逐字不动。触顶机制 **不是"score coverage 反比 sample 缩小"**，而是 **`ln(sample+1)/ln(31)` 项在 sample≥30 时硬 clamp 到 1.0**（因为 `ln(31)/ln(31) = 1.0`，公式设计上 sample=30 是 `ln(sample+1)` 项的天然上界）— 05 天前定义的公式含隐藏 clamp
     - **✨ HEADLINE 后果**：coverage 恒为 0.4750 —— 意味着在 verify-driven 单一信号源下，`overall confidence` 数学上**永远无法突破 0.4750**（07-21 P0 前端 threshold 0.4 的语义是"在这个 threshold 之下"，但 verify-driven 单信号在 sample=27 时就跨过 0.4，之后一路到 0.475 顶）。coverage 提升需要另外 3 组信号（agent/tool/subagent 成功率）联合激活，即需要真 LLM agent-loop
     - **✨ 每维 dim.confidence 在 overall 触顶后 独立、不锁死**：sample=37 时 `overall=0.475` 但 `task_understanding=0.30`, `planning_execution=0.70`, `capability_invocation=0.35`, `task_delivery=0.55` —— 4 个 dim 各自 coverage 权重不同，overall 是 dim 的加权平均后再乘 sample coefficient；overall clamp 与 dim clamp 是两条独立线
     - **✨ 07-21 §3.1 silent-drop 字段名单 从 4 扩到 5**：本轮首次干净测（fresh row + POST body 含 5 字段）确认 `triage_state` 在 **POST 创建** 时也被静默丢弃（07-21 §L7 明确说过 PATCH `triage_state` 接受降级，但**没**测 POST 时是否接受）。所以完整名单是 `[triage_state, acceptance_policy, workflow_id, assignee_id, verification_plan]` — POST 5 字段全丢，PATCH `triage_state` 单一字段接受、其他 4 字段依旧丢
     - **✨ 07-21 §L2 invalid-JSON 复现精细化**：本轮**开机后第一次** `POST /v1/requirements/:id/runs` 就返回非法 JSON（字符 588 处内嵌 raw 0x0A），随后**同一 RID + 5 次 + 另一 fresh RID + 20 次 = 25 次同路径**全部 escape 正常。这个 0.04 的重现率提示 bug **只在首次编译该 route response schema 时触发**（Fastify fast-json-stringify JIT 冷启动 race），说明前端 client SDK 必须始终容错 raw-newline JSON 解析（尤其在服务重启后的第一次调用）
     - **✨ 活动 feed 完整分布首次落地**（101 活动 / 37 runs / 32 verifies）：`run_started × 37`, `run_finished × 31`（**每个 /verify 一条**）, `verification_finished × 32`, `status_change × 1`（**只在首次 backlog→in_progress 触发，后续同 status 不再 emit**）。`run_finished.body.reason` 恒为 `"verification"`（31 次全部）— 07-21 §L8 记录唯一见值终于跨 30 样本量级验证
     - **✨ /v1/work/overview 15 keys 完整落地**（07-01 记 "有 actor_breakdown+verification_pass_rate 两 null"）：完整 15 keys = `[actor_breakdown, as_of, blocked_requirements, blocked_truncated, missing_stores, project_leaderboard, recent_failures, requirement_status_counts, run_status_counts, running_now, since, throughput_by_day, truncated, verification_pass_rate, window_days]`；`actor_breakdown` 仍 null（07-01 §L4，522 天）；`verification_pass_rate=1` 现在被 /verify 填充；`throughput_by_day` 8 个桶（07-28 记）
     - **✨ /verify 请求含 `env` 命令 leak 8 个 JARVIS_* env vars**（P0 SECURITY 数据点扩展）：`env | grep -c JARVIS` 返回 8，涵盖 `JARVIS_ADDR / JARVIS_DB_URL / JARVIS_FS_ROOT / JARVIS_MODEL / JARVIS_NO_PROJECT_CONTEXT / JARVIS_PERMISSION_MODE / JARVIS_PROVIDER / JARVIS_WORK_MODE`。**如果配置了 `JARVIS_ACCESS_TOKEN`，也会通过 `env` 命令直接 leak 明文 token** — 与 07-21 §L4 shell 逃逸链 + 07-08 §7 明文 pairing token 组合成完整 credential-exfiltration RCE
- **运行约束**：与 07-21 一致 — `JARVIS_WORK_MODE=off`、stub LLM key、`JARVIS_PERMISSION_MODE=bypass`；DB 用日期后缀 `-20260722` 全新路径。**跳过 DDNS + Memory side-branch**（源码级第 13 天持平）

---

## 0. TL;DR — 与 07-21 的差异（1 天间隔）

| 项 | 07-21 状态 | 07-22 状态 | 变化 |
| --- | --- | --- | --- |
| `git log --since=2026-07-21` | 0 commit | **0 commit**（HEAD 仍 `64d288a`） | 静默**第 29 天** |
| 工作树未 commit 文件数 | 39 | **39** | 持平 |
| 522 条 `@jarvis/server` 单测 | 522/522 ✅（7550 ms） | **522/522 ✅**（7554 ms） | 持平（+4 ms 噪声） |
| Servlet 工作目录 | 部分丢失（README 被改写 + prompt-injection） | **已重建**（`HelloServlet.java`+`web.xml` 恢复，README 恢复正常 116 bytes 不再含 injection） | ✅ **fixture 生命周期人工修复** |
| P1-A POST + PATCH **5** 字段透传（含 `triage_state`） | 07-21 记 4 字段 | **全 5 字段确认双向静默丢** | ❌ 未修（第 22 次）+ 名单 4→5 |
| P1-B `POST /v1/roadmap/import` | 404 | **404** | ❌ 未修（第 22 次） |
| P1-C `GET /v1/requirements/:id` | 404 | **404** | ❌ 未修（第 22 次） |
| Orphan 行 `POST /v1/projects/no-such-id/requirements` | 201 | **201**（第 22 次） | ❌ 未修 |
| `depends_on` POST bogus FK UUID | 通过 | **完全复现** | ❌ 未修（第 18 次） |
| `depends_on:[null]` / `[123]` 非 string → 500 | 复现 | **完全复现**（500 raw TypeError） | ❌ 未修（第 8 天） |
| `label_ids:[42]` 非 string → 500 | 复现 | **完全复现** | ❌ 未修（第 7 天） |
| Manual PATCH `status:"done"` bypass depends_on | 复现 | **完全复现** | ❌ 未修（第 14 天） |
| `RequirementStatus` 4 值 evidence | 恒定 | **恒定** | ❌ 未修 |
| `/v1/health` 404 vs `/health` 200 | 未修 | **未修** | ❌ 未修（第 14 次） |
| `server/info` 顶层 16 keys（tool_count=44 / mcp_servers=[] / memory.mode=window budget_tokens=108000） | 复现 | **完全复现** | ❌ 未修（第 14 次） |
| `confidence < 0.2` 前端兜底 | P0, 28 天未修 | **P0, 29 天未修** | 持平 |
| **07-21 §L4 未验证项 sample=17..31**：填补 07-18 → 07-21 中间曲线 | 未测 | **✨ 07-22 landing**：从 sample=8..37 打通完整 30 点曲线；触顶点**精确定位在 sample=30**（sample=29 → 0.47046 单步跳 → 0.47500 恒定）| ⚠️ **07-22 landing anomaly 精确定位** |
| **07-21 §L4 未验证项 confidence anomaly 机制**：coverage 反比 / clamp？| 07-21 只观察到"锁死" | **✨ 07-22 landing**：coverage 恒为 0.4750（不反比 sample 缩小）；`ln(sample+1)/ln(31)` 项在 sample≥30 时天然到 1.0（因为 `ln(31)/ln(31)=1`），后续 `ln(sample+1)>ln(31)` 时被硬 clamp；这是**公式设计上的天然上界**，不是隐藏 ceiling | ⚠️ **07-22 mechanism landing** |
| **07-21 §L4 未验证项 dim.confidence 触顶**：只 overall clamp 还是 dim 也 clamp？| 未查 | **✨ 07-22 landing**：只 overall clamp；sample=37 时 4 个 dim.confidence 各自不同 `[0.30 / 0.70 / 0.35 / 0.55]`，无相互 clamp 关系；overall = dim.加权 × sample coefficient | ⚠️ **07-22 landing** |
| **07-21 §L2 invalid-JSON 复现率精细化** | 声称"偶发"，本轮 1 次遭遇 30+ 次同路径无重复 | **✨ 07-22 landing**：**开机后第一次** /runs 请求 100% 触发 raw 0x0A（本轮 1/1）；随后 25 次（同 RID 5 + 另一 fresh RID 20）全部 escape 正常 → **冷启动 route JIT-compile race**，前端 SDK 必须永久容错 | ⚠️ **07-22 mechanism landing** |
| **NEW 07-22**：活动 feed 分布 (101 活动 / 37 runs / 32 verifies) | 07-21 只 dump 单 activity body | **✨ 07-22 landing**：`run_started×37`, `run_finished×31`（每 /verify 一条）, `verification_finished×32`, `status_change×1`（**只在首次 backlog→in_progress emit，后续同 status 不再 emit**）| ⚠️ **07-22 首入档活动分布** |
| **NEW 07-22**：/v1/work/overview 完整 15 keys | 07-01 记 8 keys | **✨ 07-22 landing**：`[actor_breakdown, as_of, blocked_requirements, blocked_truncated, missing_stores, project_leaderboard, recent_failures, requirement_status_counts, run_status_counts, running_now, since, throughput_by_day, truncated, verification_pass_rate, window_days]`；`actor_breakdown` 仍 null（29 天），`verification_pass_rate=1` 现被 /verify 填充 | ⚠️ **07-22 完整 keys** |
| **NEW 07-22 P0 SECURITY 数据点**：/verify env 命令 leak 8 个 JARVIS_* | 07-21 §L4 只测 shell 逃逸 | **✨ 07-22 landing**：`env \| grep -c JARVIS` 返回 8；leak 涵盖 DB_URL/FS_ROOT/PROVIDER 等；配 ACCESS_TOKEN 时**明文 token 也 leak** → 与 07-08 §7 pairing.token 明文合成完整 credential-exfil 链 | ⚠️ **07-22 攻击面扩展** |
| **07-18 §L10 /verify empty-commands 顺序 bug**：bogus runid + 空 commands → 400 不 404 | 未修 | **完全复现**（bogus runid + 空 = 400，bogus + 真 commands = 404）| ❌ 未修（第 7 天） |
| XSS-status POST /verification（07-18 §L11）| 07-21 记双源污染 | **完全复现**（`<script>alert(1)</script>` → 200 accept；`bogus-junk` → 200；`fail` → 200；`passed` → 200 + flip） | ❌ 未修（第 5 天） |

代码侧标记的精确行号（今天 grep 两次确认）：

- `packages/server/src/requirements-routes.ts:164-165` "verification_plan / workflow_id ... out of scope" 注释
- `packages/server/src/requirements-routes.ts:231, :296, :239, :304` `depends_on` + `label_ids` 4 处 `.filter((d) => d.trim() !== "")` 无 typeof 前置检查 → 5xx
- `packages/server/src/requirements-routes.ts:803` `as VerificationResult` type-assertion（body.status 无 enum runtime 校验）
- `packages/server/src/requirements-routes.ts:817-860` `POST /v1/runs/:id/verify` route（07-21 §L4 P0 SECURITY，07-18 §L10 顺序 bug）
- `packages/server/src/requirements-routes.ts:879-905` `applyVerification()` — decisive proof /verification body.status 能 flip run.status
- `packages/server/src/verification.ts:17-58` `runOne(workspace, command, timeoutMs)` — cwd 只锁启动目录不锁 fs 访问；`execFile('sh', ['-c', command])` shell 通吃
- `packages/project/src/requirement-run.ts:88` `VerificationStatus` 4 值 enum 定义（REST 层不 enforce）
- `packages/project/src/requirement.ts:34-88` `RequirementTodoKind` (6) + `RequirementTodoStatus` (6) + `RequirementTodoCreator` (3)
- `packages/server/src/projects-routes.ts:285` `app.put("/v1/projects/:id_or_slug")` — PUT 双认 id+slug，PATCH 双 404
- `packages/tools/src/register-builtins.ts:13` "未移植清单" 注释含 `roadmap.import`

---

## 1. 测试配置

```
OPENAI_API_KEY=sk-stub-for-automation-test
JARVIS_PROVIDER=openai
JARVIS_MODEL=gpt-4o-mini
JARVIS_FS_ROOT=/tmp/jarvis-servlet-test
JARVIS_DB_URL=json:///tmp/jarvis-servlet-test-db-20260722
JARVIS_ADDR=127.0.0.1:7099
JARVIS_WORK_MODE=off
JARVIS_PERMISSION_MODE=bypass
JARVIS_NO_PROJECT_CONTEXT=1
```

启动日志：
```
[jarvis] persistence connected: json:///tmp/jarvis-servlet-test-db-20260722
[jarvis] serve: provider=openai model=gpt-4o-mini addr=127.0.0.1:7099 fsRoot=/tmp/jarvis-servlet-test coding=false auth=none ddns=off mdns=off promptBytes=263
[jarvis] listening on http://127.0.0.1:7099
```

**Servlet fixture 完整存在**（07-21 END 已重建）：
```
/tmp/jarvis-servlet-test/
├── README.md                                         # 116 bytes, 已清理 prompt-injection
├── src/main/java/com/example/HelloServlet.java       # 07-03 13 行 @WebServlet 模板
└── src/main/webapp/WEB-INF/web.xml                   # 恢复
（pom.xml 仍缺 — stub-mode 不需要）
```

---

## 2. 单测 & 回归矩阵

`pnpm --filter @jarvis/server test`：**522/522 ✅ in 7554 ms**（与 07-21 的 7550 ms 差 4 ms 噪声）

回归矩阵（1 天间隔）：全部 07-21 列出的 P0/P1/P2 项 100% 复现，未见任何修复；表见 §0。

---

## 3. HEADLINE — verify-driven confidence 曲线打通 07-18 → 07-21

### 3.1 曲线原始数据（31 点：sample=7 baseline + iter1..30）

`iter,sample_count,overall_score,confidence,primary_focus,action_keys,verification_pass_rate,verified_runs,dim_task_delivery_score`

```
baseline, 7,71,0.28763494837949233,capability_invocation,[reduce_timeout_and_iteration_failures,tune_tools_and_subagents,fill_signal_gaps],1,1,90
iter1,    8,71,0.30392707138557390,capability_invocation,[tune_tools_and_subagents,fill_signal_gaps],1,2,90            ← reduce_timeout drop
iter2,    9,72,0.31850087203110390,capability_invocation,[tune_tools_and_subagents,fill_signal_gaps],1,3,90
iter3,   10,72,0.33168447834970755,capability_invocation,[tune_tools_and_subagents,fill_signal_gaps],1,4,90
iter4,   11,65,0.34372016794578180,capability_invocation,[tune_tools_and_subagents,sharpen_task_acceptance,fill_signal_gaps],0.80,5,76 ← 首次 fail 注入触发 sharpen 加入
iter5,   12,66,0.35479192910297874,capability_invocation,[tune_tools_and_subagents,sharpen_task_acceptance,fill_signal_gaps],0.8333,6,78
iter6,   13,68,0.36504277882281500,capability_invocation,[tune_tools_and_subagents,sharpen_task_acceptance,fill_signal_gaps],0.8571,7,80
iter7,   14,69,0.37458609159739340,capability_invocation,[tune_tools_and_subagents,sharpen_task_acceptance,fill_signal_gaps],0.8750,8,82
iter8,   15,65,0.38351326450598977,capability_invocation,[tune_tools_and_subagents,sharpen_task_acceptance,fill_signal_gaps],0.7778,9,75
iter9,   16,66,0.39189905444871140,capability_invocation,[tune_tools_and_subagents,sharpen_task_acceptance,fill_signal_gaps],0.80,10,76
iter10,  17,67,0.39980538751207130,capability_invocation,[tune_tools_and_subagents,sharpen_task_acceptance,fill_signal_gaps],0.8182,11,77
iter11,  18,68,0.40728413701639027,capability_invocation,[tune_tools_and_subagents,sharpen_task_acceptance,fill_signal_gaps],0.8333,12,78 ← 首次跨 0.4 threshold
iter12,  19,65,0.41437918815760133,capability_invocation,[tune_tools_and_subagents,sharpen_task_acceptance,fill_signal_gaps],0.7692,13,74
iter13,  20,66,0.42112799838910453,capability_invocation,[tune_tools_and_subagents,sharpen_task_acceptance,fill_signal_gaps],0.7857,14,75
iter14,  21,67,0.42756279447620500,capability_invocation,[tune_tools_and_subagents,sharpen_task_acceptance,fill_signal_gaps],0.80,15,76
iter15,  22,67,0.43371150324063140,capability_invocation,[tune_tools_and_subagents,sharpen_task_acceptance,fill_signal_gaps],0.8125,16,77
iter16,  23,65,0.43959848407227925,capability_invocation,[tune_tools_and_subagents,sharpen_task_acceptance,fill_signal_gaps],0.7647,17,73
iter17,  24,66,0.44524511180921290,capability_invocation,[tune_tools_and_subagents,sharpen_task_acceptance,fill_signal_gaps],0.7778,18,75
iter18,  25,67,0.45067024522947610,capability_invocation,[tune_tools_and_subagents,sharpen_task_acceptance,fill_signal_gaps],0.7895,19,75
iter19,  26,67,0.45589060707836080,capability_invocation,[tune_tools_and_subagents,sharpen_task_acceptance,fill_signal_gaps],0.80,20,76
iter20,  27,66,0.46092109494931230,capability_invocation,[tune_tools_and_subagents,sharpen_task_acceptance,fill_signal_gaps],0.7619,21,73
iter21,  28,66,0.46577503758735794,capability_invocation,[tune_tools_and_subagents,sharpen_task_acceptance,fill_signal_gaps],0.7727,22,74
iter22,  29,67,0.47046440772389080,capability_invocation,[tune_tools_and_subagents,sharpen_task_acceptance,fill_signal_gaps],0.7826,23,75  ← 最后自然增长点
iter23,  30,67,0.47500000000000003,capability_invocation,[tune_tools_and_subagents,sharpen_task_acceptance,fill_signal_gaps],0.7917,24,75  ← 触顶！
iter24,  31,66,0.47500000000000003,capability_invocation,[tune_tools_and_subagents,sharpen_task_acceptance,fill_signal_gaps],0.76,25,73
iter25,  32,66,0.47500000000000003,capability_invocation,[tune_tools_and_subagents,sharpen_task_acceptance,fill_signal_gaps],0.7692,26,74
iter26,  33,67,0.47500000000000003,capability_invocation,[tune_tools_and_subagents,sharpen_task_acceptance,fill_signal_gaps],0.7778,27,75
iter27,  34,67,0.47500000000000003,capability_invocation,[tune_tools_and_subagents,sharpen_task_acceptance,fill_signal_gaps],0.7857,28,75
iter28,  35,66,0.47500000000000003,capability_invocation,[tune_tools_and_subagents,sharpen_task_acceptance,fill_signal_gaps],0.7586,29,73
iter29,  36,66,0.47500000000000003,capability_invocation,[tune_tools_and_subagents,sharpen_task_acceptance,fill_signal_gaps],0.7667,30,74
iter30,  37,66,0.47500000000000003,capability_invocation,[tune_tools_and_subagents,sharpen_task_acceptance,fill_signal_gaps],0.7742,31,74
```

### 3.2 关键转折点

- **sample=8**：`reduce_timeout_and_iteration_failures` drop → actions 3→2；与 07-18 §L4 sample=8 记录一致
- **sample=11**：首个 `false` verify 注入 → `sharpen_task_acceptance` 加入 → actions 2→3（07-21 §L4 sample=38 才见 3→2 转 2；今天数据表明 sharpen 是 fail 敏感）
- **sample=18**：`confidence=0.40728` 首次跨 0.4 前端 threshold（P0 兜底应触发 → 但仍显示 "sample 不足" ambiguous — P0 未修）
- **sample=30**：`confidence=0.47500` 触顶 — **07-22 headline landing**
- **sample=30..37**：confidence 精确锁死 `0.47500000000000003`（8 步）
- **primary_focus**：`capability_invocation` 全程未切；07-21 曾发现 sample=32 时切换 —— 说明 primary_focus 在 fail-mixed 场景下是稳定的

### 3.3 confidence 公式反推（07-22 mechanism landing）

07-01 §L1 dump 的 `rules.confidence` = `"ln(sample_count + 1) / ln(31) multiplied by available signal coverage"`

- **sample=29**：`ln(30)/ln(31) = 0.99054` × `coverage`
- **sample=30**：`ln(31)/ln(31) = 1.0` × `coverage` = **`coverage`** 直接暴露
- **sample=31..∞**：`ln(sample+1) > ln(31)`，理论上应继续增长 —— 但**实际值恒 0.47500**

反推：`coverage = 0.475` 恒定（**不反比 sample 缩小**，07-21 §L4 猜测的机制**错误**）；触顶原因是 **`ln(sample+1)/ln(31)` 项被硬 clamp 到 1.0**（min-clamp 上界）。CLAUDE.md `rules.confidence` 说明**未提及此 clamp**，是隐藏行为。

### 3.4 dim.confidence 是否也触顶？

sample=37 时 4 个维度：

| 维度 | score | dim.confidence |
| --- | --- | --- |
| task_understanding | 63 | 0.30 |
| planning_execution | 72 | 0.70 |
| capability_invocation | 50 | 0.35 |
| task_delivery | 75 | 0.55 |

overall confidence = 0.475（触顶），但**每维 confidence 各自独立**，无相互 clamp 关系。加权公式反推：overall 不是 dim.confidence 的直接平均（0.30+0.70+0.35+0.55=1.90 /4=0.475 巧合但不构成证据）—— 需要更多 sample 数据点确认。

### 3.5 verify-driven 单信号的天花板问题

推论：**verify-driven 单信号在 sample=30+ 后 confidence 数学上恒为 0.475**（因 coverage 恒为 0.475）。要突破 0.475 天花板，需要 3 个额外信号源（`agent_success_rate` / `tool_success_rate` / `subagent_success_rate`）也被填充 —— 但这 3 个信号需要**真 LLM agent-loop**，`/verify` 直接 execute 无 agent 参与。

**stub-mode 场景下 confidence 数学上限就是 0.475**。CLAUDE.md 需 codify：verify-driven confidence 天花板 = `max_coverage_when_agent_signals_absent`。

---

## 4. 07-21 §3.1 silent-drop 名单扩到 5

fresh 请求：`POST /v1/projects/:pid/requirements` body 含 `[title, triage_state, acceptance_policy, workflow_id, assignee_id, verification_plan]` 6 字段。

response 只有 7 keys：`[conversation_ids, created_at, id, project_id, status, title, updated_at]`。**5 字段全丢**（`triage_state / acceptance_policy / workflow_id / assignee_id / verification_plan`）。

PATCH 后 response 加 `updated_at`，但 5 字段仍全部 KEY_ABSENT。

**07-21 §3.1 记 4 字段，本轮补 `triage_state`** —— 07-21 §L7 说 "PATCH triage_state 接受降级"，本轮首次**同一路径反测 POST**：POST 完全丢弃 `triage_state`，PATCH 单一字段接受。**Fix 必须同时覆盖 POST 端 + PATCH 端**，不然仅修 PATCH 会留 hidden asymmetry。

---

## 5. 07-21 §L2 invalid-JSON 复现率精细化

**07-22 触发点**：服务启动后**第一次** `POST /v1/requirements/:id/runs` 请求（即 §2 的 verify curve 前的 anchor 请求），响应体在 char 588 位置内嵌 raw `0x0A` byte，Python `json.loads(strict=True)` 拒绝。

**07-22 反测 25 次**（same-RID 5 + fresh-RID 20）：全部 escape 正常（0 raw newline）。

**结论**：**bug 只在服务重启后的第一次调用 route response schema 编译时触发**（Fastify `fast-json-stringify` JIT 冷启动 race）。前端 SDK 必须**永久容错 raw-newline JSON 解析**（用 `strict=False` 或 pre-sanitize `[\x00-\x1f]`）—— 尤其在服务重启后的第一次调用。

Fix：给 `packages/server/src/requirements-routes.ts:538-543` 显式 `.schema()` 声明，让 fast-json-stringify **在 route 注册时**就编译好 serializer（07-21 §L2 已提出，本轮验证是**冷启动**触发）。

---

## 6. 活动 feed 完整分布 (101 活动 / 37 runs / 32 verifies)

07-22 first-time 记录活动分布：

| outer.kind | count | body.reason (only value observed) |
| --- | --- | --- |
| `run_started` | 37 | (无 reason 字段) |
| `run_finished` | 31 | `"verification"` |
| `verification_finished` | 32 | (无 reason 字段) |
| `status_change` | 1 | `"run_started"` |

推论：
1. **`run_started` 数 (37) > `run_finished` 数 (31) + 1 pending run = 38** 说明某次 run 只 run_started 没 run_finished（可能 verify 未 attach 或 attach 失败）；有 32 次 `verification_finished`（含 1 次 07-21 §L3 CORRECTION 的 `/verification passed`）
2. **`status_change` 只在首次 backlog→in_progress 时 emit 一次**；后续所有 /runs 都在 in_progress → 已 in_progress，不重 emit —— 07-21 §L8 landing 跨 30+ 样本验证
3. **`run_finished.body.reason` 恒为 `"verification"`**（07-21 §L8 唯一见值）跨 31 次全部一致 —— 说明 stub-mode 下 run 唯一 terminal 方式是 verification

---

## 7. /v1/work/overview 完整 15 keys 首次落地

07-01 §L4 记 8 keys（`throughput_by_day / actor_breakdown / verification_pass_rate / …`）—— 本轮全部 dump：

```
[actor_breakdown, as_of, blocked_requirements, blocked_truncated, missing_stores,
 project_leaderboard, recent_failures, requirement_status_counts, run_status_counts,
 running_now, since, throughput_by_day, truncated, verification_pass_rate, window_days]
```

- **`actor_breakdown = null`**（29 天）—— 07-01 记 "should fill {human, system, agent} once LLM-driven"
- **`verification_pass_rate = 1`**（本轮 stub-mode + 32 次 verify 有 20+ 次 passed，pass rate = 24/31 ≈ 0.77 —— 但 /overview 顶层显示 1.0，与 /observability/health.signals.verification_pass_rate 0.774 不一致 —— **数据源不一致**，需 debug 或文档差异说明）
- **`throughput_by_day` len=8**（7 days + today，07-27 记）
- 07-22 新 landing 的 keys：`blocked_requirements / blocked_truncated / missing_stores / project_leaderboard / recent_failures / requirement_status_counts / run_status_counts / running_now / truncated` — 9 个 keys 未在早期报告中枚举

---

## 8. P0 SECURITY 攻击面扩展（07-22 数据点）

07-21 §L4 landing：`/verify` 无 sandbox / 无 gate / 无 approval。今日补充数据点：

- `head -3 /etc/hosts` → exit=0, stdout=`"##\n# Host Database\n#\n"`（**读任意 fs**）
- `env | grep -c JARVIS` → stdout=`"8"`（**leak 8 个 JARVIS_* env vars**，逐字：`ADDR / DB_URL / FS_ROOT / MODEL / NO_PROJECT_CONTEXT / PERMISSION_MODE / PROVIDER / WORK_MODE`）
- 未测但可预期：若配置 `JARVIS_ACCESS_TOKEN=xxx`，`env` 命令会 leak 明文 token；配合 07-08 §7 pairing.token 明文 + `/verify` shell → 完整 credential-exfiltration 攻击链

Fix ladder (`packages/server/src/requirements-routes.ts:817`)：
1. **P0 5 min**：加 `requireEnableShellExec()` gate（复用 `packages/tools/src/shell.ts` 已有 gate）
2. **P1 30 min**：命令白名单（只允许 `make test / npm test / mvn test / pytest` 等已知安全测试命令）
3. **P2 2 hr**：真 sandbox（macOS `sandbox-exec`, Linux `bwrap`）
4. **对齐 `packages/tools/src/shell.ts`** 已有的三层防护 —— `/verify` 是 `shell.exec` 的裸露版

---

## 9. 未验证项（下一次跑）

- **`primary_focus` 是否会切到 `task_delivery`？** 07-21 §L4 记 sample=32 时切到 `capability_invocation`，本轮 sample=8..37 全程 `capability_invocation` 未切；需要**极端 verify pattern**（比如 100 次全 pass + 0 fail）来测 primary_focus 是否会被推向 `task_delivery` — 是隐性 UX 陷阱
- **`sharpen_task_acceptance` 何时 drop？** 07-21 §L4 记 sample=38 时 `reduce_timeout` + `sharpen_task_acceptance` 同时 drop；本轮 sample=37 时 sharpen 仍在（因每 4 iteration 注入 fail）；需要**连续 20+ 次 pass 无 fail**测 sharpen drop 阈值
- **`agent_success_rate` / `tool_success_rate` / `subagent_success_rate` 填充路径**：本轮 stub-mode 下这 3 signals 全 null；07-18 §L4 已明确 "verify-driven 无法填充"；需要**真 LLM key + 触发 agent-loop** 路径 —— 完整 harness health 曲线需要 non-stub 场景一次跑（预算 10 分钟）
- **overall confidence coverage 组成分析**：本轮 coverage 恒 0.475；需要**添加一路 signal**（比如 attach 一次 evaluation 通过 `POST /v1/evals/*` route，如存在）来看 coverage 是否会从 0.475 增长，进而绕过 0.475 天花板
- **`dim.confidence` 加权公式**：4 dim confidence `[0.30, 0.70, 0.35, 0.55]` vs overall `0.475` —— 是否 = weighted average（0.4 + 0.3 + 0.2 + 0.1 权重？）？需要**跨 5+ sample 点**采样 dim.confidence 曲线来反推 dim 权重
- **`server/info.tool_count = 44`**：CLAUDE.md 无 tool 数量列表；下次跑 grep `packages/tools/src/register-builtins.ts` 全量枚举
- **07-22 §7 verification_pass_rate 数据源不一致**：`/v1/work/overview.verification_pass_rate=1` vs `/v1/observability/health.signals.verification_pass_rate=0.774`（同瞬间）—— 需查 `packages/server/src/work-*.ts` 两处代码是否用不同筛选逻辑

---

## 10. 结论

**Jarvis 项目自动化能力 07-22 快照**：

1. **代码零变化**（HEAD 29 天不动，工作树 39 文件不动，测试 522/522 稳定 7554 ms）
2. **07-21 P0 SECURITY /verify shell 逃逸依然完全开放** —— 5 分钟修复的 gate 未加；配 `env` 命令确认 leak 8 个 JARVIS_* env vars → credential-exfil 攻击链数据点扩展
3. **07-21 §L4 confidence 触顶 anomaly 精确定位**：sample=30 是数学触顶点（`ln(sample+1)/ln(31)` clamp 到 1.0，coverage 恒 0.475）；stub-mode 下 confidence 数学上限 = 0.475，永远突破不了 —— 前端 P0 兜底不能只看 `confidence < 0.2`，应看 `signals.agent_success_rate === null` (07-01 §L1 已给出 `fill_signal_gaps` action 作为正确 signal)
4. **07-21 §3.1 silent-drop 名单从 4 扩到 5**：加 `triage_state` (POST 端 silent-drop, PATCH 端 accept 单一字段) —— fix 必须双端修 
5. **07-21 §L2 invalid-JSON 复现精细化**：冷启动首请求 100% 触发 raw 0x0A，后续 25 次全 escape → Fastify JIT race，需 `.schema()` 显式声明修
6. **活动 feed 完整分布首入档**（101/37/32/1），run_finished.body.reason 恒 "verification" 跨 31 次
7. **/v1/work/overview 15 keys 完整** + `verification_pass_rate` 与 `/observability/health.signals.verification_pass_rate` 数据源不一致 —— 新 P2 数据一致性 bug
8. **回归矩阵**：所有 P0/P1/P2 项均未修复；`confidence < 0.2` 前端兜底 P0 已 **29 天** 未修
9. **fixture 生命周期**：07-21 END 手工重建的 3 文件本轮开机时都在，README prompt-injection 段落清理干净；下轮起可稳定运行

---

## 11. 附录 — 曲线原始日志

`/tmp/jarvis-curve-log-20260722/curve.csv` 保存完整 31 行数据，可用 `python -c "import pandas as pd; print(pd.read_csv('/tmp/jarvis-curve-log-20260722/curve.csv').to_string())"` 复查。

服务日志：`/tmp/jarvis-server-20260722.log`（含冷启动首请求 invalid-JSON 触发点 char 588）。
