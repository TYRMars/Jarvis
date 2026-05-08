# Self-Improving Agent：记忆、技能与后台策展

**Status:** Proposed.
**Touches:** `harness-core` 新增长期学习 trait / 事件钩子，
`harness-store` 新增 learning store 或扩展现有 project memory store，
`harness-tools` 新增 `memory.*` / `skill.*` 管理工具，
`harness-skill` 新增可写技能与使用遥测，
`harness-server` 新增 review / curator / skill REST API，
`apps/jarvis` 负责配置与后台任务 wiring，
`apps/jarvis-web` 新增 Project Lessons / Skills / Curator UI。

## Motivation

Jarvis 现在已经有 Agent loop、skill catalog、project memory、
TODO / Requirement / Run / Activity 等持久化基础，但它的“学习”还没有形成闭环：

- 一次成功调试、修复、验证流程，下一次不一定会被复用。
- 用户纠正了 Jarvis 的风格或工作方式，这个偏好容易留在当前会话里。
- 项目的踩坑记录、操作约定、验证命令分散在聊天、需求、TODO、文档里。
- 技能库可以被加载，但还缺少“使用遥测、自动修补、长期整理”的生命周期。

目标不是在线训练模型权重，而是给 Jarvis 一套工程化的外部认知系统：
把每次工作中值得复用的经验沉淀为 Memory / Skill / Project Lesson，
在未来会话中自动召回，并定期清理、合并、归档。

## Product alignment

这个能力属于 Chat / Work / Doc 的横向基础设施，不是新的顶层产品面。

- **Chat**：学习用户偏好、沟通方式、长期事实。
- **Work**：把成功工作流、失败原因、验证门禁沉淀为项目经验。
- **Doc**：把长期知识、运行手册、决策记录转成可编辑文档。
- **Capability packs**：Coding、Office、Research 等能力包通过 Skill / Tool /
  Prompt hook 注入自己的领域知识。

第一落点应该服务 Coding Work：让 Jarvis 从每次需求执行、修复失败、
代码审查和验证中变得更熟悉项目。

## Non-goals

- 不做模型权重微调、RLHF、在线训练。
- 不让后台任务静默修改用户代码或外部系统。
- 不把所有聊天自动塞进长期记忆；只保存经过策略筛选的摘要事实。
- 不把 Skill 做成 issue tracker。Skill 保存“如何做一类任务”，
  Requirement / TODO 保存“具体要做什么”。
- 不让 `harness-core` 依赖文件系统、HTTP、数据库、LLM provider 或 web server。

## Concept model

Jarvis 的自我成长由三类持久资产组成：

| Asset | 作用 | 生命周期 |
|---|---|---|
| User Memory | 用户偏好、身份、沟通约定 | 跨项目、跨会话；用户可编辑 |
| Project Memory | 项目事实、踩坑、约定、失败原因 | project-scoped；可从 run failure 自动生成 |
| Skill | 某类任务的可复用操作手册 | user / workspace / plugin scoped；可加载、修补、归档 |

其中 Memory 回答“用户是谁、项目是什么”，Skill 回答“这类任务以后怎么做”。
两者都应进入提示词，但预算和召回策略不同：

- Memory 是短小事实，进入 system / context block。
- Skill 是程序性知识，先通过 catalog 暴露摘要，命中后再加载正文。
- Project Memory 可以按项目、需求、标签、最近失败记录进行裁剪注入。

## High-level loop

```text
用户发起 Chat / Work / Doc 任务
  -> Agent 运行，使用 tools / skills / project context
  -> 完成后产生 RunOutcome / AgentEvent / Activity
  -> LearningReview 后台 fork 审查本轮会话
  -> 写入 User Memory / Project Memory / Skill patch
  -> SkillUsage 记录 view/use/patch/create/delete
  -> Curator 定期整理 agent-created skills
  -> 下次会话根据用户、项目、任务召回
  -> Agent 行为发生可解释的改变
```

后台 review 必须在主响应发送后运行，且失败不影响用户任务。

## Core surfaces

`harness-core` 保持纯 trait 层，只定义抽象能力和事件，不读配置、不碰磁盘。

```rust
#[async_trait]
pub trait LearningStore: Send + Sync {
    async fn list_memories(&self, scope: MemoryScope) -> Result<Vec<MemoryItem>, BoxError>;
    async fn upsert_memory(&self, item: MemoryItem) -> Result<(), BoxError>;
    async fn delete_memory(&self, id: &str) -> Result<bool, BoxError>;

    async fn record_skill_usage(&self, event: SkillUsageEvent) -> Result<(), BoxError>;
    async fn skill_usage_report(&self, scope: SkillScope) -> Result<Vec<SkillUsageRow>, BoxError>;
}

#[async_trait]
pub trait LearningReviewer: Send + Sync {
    async fn review_turn(&self, input: LearningReviewInput) -> Result<LearningReviewOutput, BoxError>;
}
```

`LearningReviewer` 是可插拔的：MVP 可以是一个由 `apps/jarvis` wiring 的
LLM fork；未来也可以换成规则引擎、本地小模型或云端 reviewer。

### Agent integration

在 `Agent::run` / `run_stream` 的主路径中只做三件事：

1. 开始前调用 context builder，注入相关 Memory / Project Memory / Skill catalog 摘要。
2. 工具调用时记录 `skill.view` / `skill.manage` 等 usage event。
3. 完成后发出 `LearningReviewRequested` 或调用一个 post-run hook。

不要在 tool loop 中同步执行长期 review。它会增加延迟，也会污染用户的主任务上下文。

## Wire model

### MemoryItem

```rust
pub struct MemoryItem {
    pub id: String,
    pub scope: MemoryScope,
    pub kind: MemoryKind,
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    pub source: MemorySource,
    pub confidence: f32,
    pub pinned: bool,
    pub created_at: String,
    pub updated_at: String,
    pub last_used_at: Option<String>,
}

pub enum MemoryScope {
    User,
    Project { project_id: String },
    Workspace { path: String },
}

pub enum MemoryKind {
    Preference,
    Fact,
    Lesson,
    Gotcha,
    Convention,
}
```

`ProjectMemory` 已经存在，可以二选一：

- Phase 1 复用 `ProjectMemory`，只新增 User Memory。
- Phase 2 把 `ProjectMemory` 迁移到统一 `MemoryItem`。

推荐 Phase 1 复用，避免过早重构。

### SkillUsageEvent

```rust
pub struct SkillUsageEvent {
    pub skill_name: String,
    pub source: SkillSource,
    pub action: SkillUsageAction,
    pub scope: SkillScope,
    pub conversation_id: Option<String>,
    pub requirement_id: Option<String>,
    pub run_id: Option<String>,
    pub created_at: String,
}

pub enum SkillUsageAction {
    Listed,
    Viewed,
    Used,
    Patched,
    Created,
    Archived,
    Restored,
}
```

Usage 不写进 `SKILL.md` frontmatter，避免 operational telemetry 和用户维护的技能正文冲突。

### SkillLifecycle

```rust
pub struct SkillLifecycle {
    pub skill_name: String,
    pub source: SkillSource,
    pub created_by: SkillCreator,
    pub state: SkillState,
    pub pinned: bool,
    pub absorbed_into: Option<String>,
    pub archived_at: Option<String>,
    pub updated_at: String,
}

pub enum SkillState {
    Active,
    Stale,
    Archived,
}

pub enum SkillCreator {
    User,
    Agent,
    Bundled,
    Plugin,
}
```

Curator 只允许操作 `created_by = Agent` 的 Skill。Bundled / Plugin / User-authored
技能默认不可自动归档。

## Storage

`harness-store` 提供 `LearningStore` 的 Memory / JSON-file / SQL 实现。
默认仍应是零配置 JSON-file，路径跟现有 store bundle 对齐：

```text
<data-dir>/learning/
  memories/<scope>/<id>.json
  skill-usage/<workspace-hash>/<skill-name>.json
  skill-lifecycle/<skill-name>.json
  curator-state.json
  curator-reports/<timestamp>/report.md
```

SQL 后端可以后置，表形状：

```sql
memories(id, scope_kind, scope_id, kind, title, body, tags_json,
         source_json, confidence, pinned, created_at, updated_at, last_used_at)

skill_usage(id, skill_name, source, action, scope_json,
            conversation_id, requirement_id, run_id, created_at)

skill_lifecycle(skill_name, source, created_by, state, pinned,
                absorbed_into, archived_at, updated_at)
```

## Tools

新增工具放在 `harness-tools`，通过 `BuiltinsConfig` opt-in 注册。

| Tool | 类型 | 说明 |
|---|---|---|
| `memory.list` | read | 列出 user / project / workspace memory |
| `memory.add` | write | 新增长期记忆 |
| `memory.update` | write | 修改标题、正文、标签、pin |
| `memory.delete` | write | 删除长期记忆，需权限策略 |
| `skill.list` | read | 返回 catalog 摘要 + usage/lifecycle 状态 |
| `skill.view` | read | 加载完整 `SKILL.md` 或 supporting file |
| `skill.manage` | write | create / patch / write_file / archive / restore |

`skill.manage` 需要防线：

- 写入只能发生在 user / workspace skill roots。
- `archive` 代替 delete；真正 delete 只给人类 REST/UI。
- `archive` agent-created skill 时必须传 `absorbed_into`：
  - 非空：表示内容已合并到 umbrella skill。
  - 空字符串：表示纯 pruning。
- patch 后重新 parse frontmatter；失败则回滚。
- supporting file 只允许 `references/`、`templates/`、`scripts/`、`assets/`。

## Learning review

LearningReview 是主任务结束后的后台 fork。输入是裁剪后的本轮上下文：

```rust
pub struct LearningReviewInput {
    pub conversation_id: Option<String>,
    pub project_id: Option<String>,
    pub workspace: Option<String>,
    pub requirement_id: Option<String>,
    pub run_id: Option<String>,
    pub messages: Vec<Message>,
    pub tool_events: Vec<ToolEventSummary>,
    pub loaded_skills: Vec<String>,
    pub outcome: RunOutcomeSummary,
}
```

输出是结构化 patch plan，而不是让 reviewer 直接任意执行：

```rust
pub struct LearningReviewOutput {
    pub memory_writes: Vec<MemoryWrite>,
    pub skill_writes: Vec<SkillWrite>,
    pub notes: Vec<String>,
}
```

MVP 可以让 reviewer fork 持有 `memory.*` 和 `skill.manage` 工具直接写入，
但最终形态建议改为 two-step：

1. reviewer 产生结构化 plan；
2. `LearningStore` / `SkillManager` 按策略执行，记录 audit。

触发策略：

- Memory：每 N 个用户 turn 检查一次，默认 10。
- Skill：当本轮工具调用次数超过阈值、使用过 skill、用户纠正 Jarvis、
  或 Work run 从失败中恢复时触发。
- Project lesson：RequirementRun 失败或 retry 成功后触发。

Review prompt 的核心规则：

- 用户偏好进入 User Memory，也应进入相关 Skill 的“如何服务这个用户”部分。
- 任务流程、调试技巧、验证命令进入 Skill。
- 项目结构、约定、失败原因进入 Project Memory。
- 优先 patch 已加载 Skill；其次 patch 现有 umbrella；最后才创建新 Skill。
- 新 Skill 必须是类别级，不得用 PR 编号、错误字符串、临时代号命名。

## Curator

Curator 是定期维护技能库的后台任务，不在每轮主任务里运行。

职责：

- 根据 usage 把 agent-created skills 标记为 `stale`。
- 长期未使用时归档到 `.archive`，保留 restore 能力。
- 合并过窄的 session-specific skill 到 umbrella skill。
- 把一次性细节移动到 `references/`、`templates/` 或 `scripts/`。
- 生成 report，更新 `curator-state`。

调度：

- 默认每 7 天检查一次。
- 首次安装只 seed `last_run_at`，不立即 mutate。
- 只在系统 idle 或显式命令时运行。
- 提供 dry-run，生成报告但不写入。

安全不变量：

- 只碰 `created_by = Agent`。
- pinned skill 永不自动 stale/archive。
- 不删除，最多 archive。
- 每次真实运行前创建 snapshot。
- 每次归档都记录 consolidated / pruned 分类。

## Prompt injection and privacy

长期记忆会进入提示词，因此写入前必须扫描：

- `ignore previous instructions`
- `system prompt override`
- 读取 `.env` / token / credential 的命令
- invisible unicode control chars
- 明确要求欺骗用户或隐藏行为的文本

被拒绝的写入进入 audit log，不进入 Memory / Skill。

用户可在 UI 中：

- 查看所有 User Memory / Project Memory。
- pin / edit / delete。
- 关闭自动 review。
- 对单次 review 选择 approve-only 模式。

## REST API

```text
GET    /v1/memories?scope=user|project|workspace
POST   /v1/memories
PATCH  /v1/memories/:id
DELETE /v1/memories/:id

GET    /v1/skills
GET    /v1/skills/:name
POST   /v1/skills
PATCH  /v1/skills/:name
POST   /v1/skills/:name/archive
POST   /v1/skills/:name/restore

GET    /v1/learning/reviews
POST   /v1/learning/reviews/run
GET    /v1/learning/curator/status
POST   /v1/learning/curator/run
POST   /v1/learning/curator/pause
POST   /v1/learning/curator/resume
```

WS frames：

- `memory_upserted`
- `memory_deleted`
- `skill_usage_recorded`
- `skill_lifecycle_changed`
- `learning_review_completed`
- `curator_report_created`

## Web UI

### Settings / Skills

- Skill catalog 列表：name、description、source、state、last used、patch count。
- Skill detail：正文、supporting files、usage history、pin/archive/restore。
- Agent-created badge 与 bundled/plugin/user source badge。

### Projects / Lessons

复用现有 `ProjectMemoryPanel` / `ProjectLessonsPanel`：

- 按 kind 分组：Lesson / Gotcha / Context / Convention。
- 显示来源 run / requirement。
- 支持 pin、edit、delete、convert to Doc。

### Work Overview / Harness Evolution

展示：

- 最近 review 写入了什么。
- Curator 本周合并 / 归档了多少技能。
- 哪些技能命中最多、哪些长期 stale。
- 哪些失败模式重复出现。

## Configuration

由 `apps/jarvis` 读取配置并 wiring，库 crate 不读 env。

```toml
[learning]
enabled = true
review_mode = "auto"          # auto | approve | off
memory_review_interval = 10
skill_review_min_tool_calls = 5
curator_enabled = true
curator_interval_hours = 168
curator_stale_after_days = 30
curator_archive_after_days = 90

[learning.reviewer]
provider = "main"             # main | named provider
model = ""
max_iterations = 16
```

Env 只作为 composition root 的覆盖：

- `JARVIS_LEARNING=0`
- `JARVIS_LEARNING_REVIEW_MODE=approve`
- `JARVIS_CURATOR=0`

## Rollout

### Phase 0：可观测但不自动写

- Skill usage telemetry。
- Memory / Skill REST list。
- Review dry-run，生成 report。
- UI 展示 report，不执行 mutation。

验收：

- 加载 skill 会记录 view/use。
- 完成一次 Work run 后可手动触发 review dry-run。
- report 中能区分建议写入 Memory、Project Memory、Skill。

### Phase 1：User / Project Memory 自动写入

- `memory.add/update/delete` 工具。
- User Memory + 现有 ProjectMemory 注入 prompt。
- Review fork 可自动写 memory，默认 approve-only 可配置。

验收：

- 用户表达“以后回答短一点”，下次会话能体现。
- Run failure 自动生成 Project Gotcha。
- interrupted / failed incomplete turn 不写长期记忆。

### Phase 2：可写 Skill

- `skill.view` / `skill.manage` 工具。
- workspace / user skill root 写入。
- patch rollback + security scan。
- Skill 使用和 patch 遥测。

验收：

- 使用某个技能时发现缺步骤，Agent 能 patch 该技能。
- 复杂成功任务后，Agent 能提议保存为 class-level skill。
- 新技能不会用 PR 编号或一次性错误字符串命名。

### Phase 3：Curator

- Curator state / reports / snapshot。
- stale/archive/pin/restore。
- umbrella consolidation。
- cron / idle 调度。

验收：

- agent-created 且长期未使用的 skill 被标记 stale。
- pinned skill 不被归档。
- curator dry-run 不产生 mutation。
- archive 可 restore。

### Phase 4：知识闭环进入 Work / Doc

- Project Lessons 可转 Doc。
- Work Overview 显示学习质量。
- RequirementRun retry 能召回相关 gotcha / skill。

验收：

- 同一项目重复失败时，下一次 run 的 prompt 包含之前失败教训。
- 用户能从 UI 看见 Jarvis “学到了什么”，并能编辑或删除。

## Testing

Rust tests：

- `harness-core`：Learning trait mock、post-run hook 不影响 `AgentEvent::Done`。
- `harness-store`：Memory / skill usage JSON-file roundtrip，SQL migration。
- `harness-tools`：memory scan、skill patch rollback、archive restore。
- `harness-server`：REST + WS events。
- `harness-skill`：source precedence、agent-created lifecycle。

Web tests：

- Settings Skills list / detail。
- Project Lessons CRUD。
- Curator report rendering。

E2E：

1. 用户纠正偏好。
2. review 写入 memory。
3. 新会话自动召回。
4. 使用 skill 遇到缺陷。
5. review patch skill。
6. curator dry-run 报告合并建议。

## Open questions

- Reviewer 默认是自动写，还是 approve-only？建议开发期 approve-only，个人本地可 auto。
- User Memory 是否独立 store，还是复用 `ProjectMemory` 的模型扩展？
- Skill 写入路径是否默认 workspace-only，user-scope 需要显式确认？
- Curator 是否使用主 provider，还是单独 auxiliary reviewer provider？
- 是否需要把 review output 保存成 Doc，形成“学习日志”？

