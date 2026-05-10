# Project Connectors: Asana / Jira / Linear / GitHub Issues

**状态:** Proposed  
**Owner:** harness-server / harness-tools / harness-plugin  
**Last updated:** 2026-05-10

## 背景

Jarvis 现在已经有本地一等的 `Project`、`Requirement`、`Activity`、
`Comment`、`RequirementRun` 相关模型，以及 `/projects` 看板和 `project.*` /
`requirement.*` 工具。下一步接入 Asana、Jira、Linear、GitHub Issues、ClickUp 等
需求管理平台时，核心问题不是“给模型几个 HTTP 工具”，而是把外部项目结构稳定映射到
Jarvis 的本地 Project / Requirement 执行模型。

这类接入应该保持现有边界：

- `harness-core` 不知道 Asana / Jira / Linear。
- 外部平台接入不直接替代 Jarvis 的 Project / Requirement。
- Jarvis 本地 store 仍然是 agent 执行、审计、自动模式、验证结果的真源。
- 外部平台是需求来源、协作出口、状态同步目标。

## 目标

1. 默认带一组常见需求平台 connector，第一批优先 Asana。
2. 用户可以把外部 workspace / team / project 映射成 Jarvis `Project`。
3. 外部 task / issue 映射成 Jarvis `Requirement`，保留外部 id、url、更新时间和同步游标。
4. Agent 可以在 Jarvis 内完成需求拆解、执行、验证，并在用户批准后把状态 / 评论 / 链接同步回外部平台。
5. 同一套抽象服务 Asana、Jira、Linear、GitHub Issues、ClickUp，而不是每个平台独立改 UI / store / 工具。

## 非目标

- v1 不做双向实时协同编辑。先做显式 import / sync / push。
- v1 不让模型自由删除外部任务。删除 / close 这类动作必须审批。
- v1 不把外部平台字段完整镜像成本地 schema。未知字段保留在 connector metadata 里。
- v1 不依赖第三方 MCP server 作为唯一方案。MCP 可以作为补充工具，但 Project 同步需要 Jarvis 自己掌握映射和状态。

## 为什么不是只用 MCP

MCP server 很适合让模型临时查询外部系统，例如 `asana.search_tasks` 或
`linear.get_issue`。但它不够承载 Project connector：

- MCP 工具不知道 Jarvis 本地 `ProjectStore` / `RequirementStore`。
- 它不会自动维护外部 task 与本地 requirement 的稳定绑定。
- 它不能统一驱动 Web UI 的项目看板、Activity timeline、auto mode 和验证状态。
- 不同 MCP server 的工具命名、返回形状和分页语义不一致，难以作为同步层。

因此推荐分两层：

- **Connector layer:** Jarvis 原生同步层，负责身份、映射、分页、增量同步、冲突处理。
- **Optional MCP / tools:** 给模型做平台特定查询和小范围操作。

## 核心模型

新增一个 sibling crate：`crates/harness-connectors/`。

```rust
#[async_trait]
pub trait ProjectConnector: Send + Sync {
    fn id(&self) -> &'static str;          // "asana" / "jira" / "linear"
    fn display_name(&self) -> &'static str;

    async fn list_remote_projects(
        &self,
        account: &ConnectorAccount,
    ) -> Result<Vec<RemoteProject>, ConnectorError>;

    async fn import_project(
        &self,
        account: &ConnectorAccount,
        remote_project_id: &str,
        target: ImportTarget,
    ) -> Result<ProjectImportPlan, ConnectorError>;

    async fn pull_requirements(
        &self,
        account: &ConnectorAccount,
        binding: &ProjectBinding,
    ) -> Result<PullResult, ConnectorError>;

    async fn push_requirement(
        &self,
        account: &ConnectorAccount,
        binding: &RequirementBinding,
        change: RequirementPush,
    ) -> Result<PushResult, ConnectorError>;
}
```

Persisted binding types:

```rust
pub struct ConnectorAccount {
    pub id: String,
    pub connector: String,       // "asana"
    pub display_name: String,
    pub auth_ref: String,        // key into auth_store / keychain, never raw token
    pub created_at: String,
    pub updated_at: String,
}

pub struct ProjectBinding {
    pub id: String,
    pub connector: String,
    pub account_id: String,
    pub project_id: String,      // Jarvis Project id
    pub remote_project_id: String,
    pub remote_url: Option<String>,
    pub sync_cursor: Option<String>,
    pub field_mapping: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

pub struct RequirementBinding {
    pub id: String,
    pub connector: String,
    pub project_binding_id: String,
    pub requirement_id: String,  // Jarvis Requirement id
    pub remote_task_id: String,
    pub remote_url: Option<String>,
    pub remote_updated_at: Option<String>,
    pub last_pushed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}
```

Stores follow existing pattern: traits in the new crate or `harness-core` only if multiple
upper layers need them; concrete memory / JSON / SQLite / Postgres / MySQL backends in
`harness-store`.

## Asana v1 mapping

Asana object mapping:

| Asana | Jarvis |
|---|---|
| Workspace / Team | connector account metadata / import filter |
| Project | `Project` |
| Task | `Requirement` |
| Section | `Requirement.status` via configurable column mapping |
| Task name | `Requirement.title` |
| Notes / html_notes | `Requirement.description` |
| Tags / custom fields | `Requirement.label_ids` plus connector metadata |
| Comments / stories | `Comment` or `Activity` |
| Completed | `RequirementStatus::Done` when mapping permits |

Default column mapping for a new Asana project import:

| Jarvis status | Asana section candidates |
|---|---|
| `backlog` | Backlog, Todo, To do, Upcoming |
| `in_progress` | In Progress, Doing, Active |
| `review` | Review, QA, Verifying |
| `done` | Done, Complete, Completed |

If no Asana section matches, imported tasks start in `backlog` and the import plan records
unmapped sections for the UI to ask the user later.

## Tools

These tools should be default-on only after an account is configured. Read tools are safe;
write tools are approval-gated.

- `connector.accounts.list`
- `connector.projects.list_remote`
- `connector.projects.import`
- `connector.projects.sync`
- `connector.requirements.push`
- `asana.tasks.search`
- `asana.tasks.get`
- `asana.tasks.comment` (write, approval required)
- `asana.tasks.update_status` (write, approval required)

The generic `connector.*` tools are preferred in system prompts. Platform-specific tools are
fallbacks when the user asks for an Asana-specific lookup.

## API

Add server routes:

- `GET /v1/connectors`
- `GET /v1/connectors/accounts`
- `POST /v1/connectors/:connector/accounts`
- `GET /v1/connectors/:connector/projects`
- `POST /v1/connectors/:connector/projects/:remote_id/import`
- `POST /v1/project-bindings/:id/sync`
- `POST /v1/requirement-bindings/:id/push`

Web UI:

- Settings → Connectors: account auth and health.
- Project settings → External source: bind / unbind / sync.
- Requirement detail: external link, remote updated timestamp, push status.

## Auth

Asana v1 supports two modes:

1. Personal Access Token for local single-user setup.
2. OAuth later, once connector account UX is stable.

Tokens should go through the existing `auth_store` pattern, not config JSON. `plugin.json` and
Project rows must never persist raw access tokens.

Environment fallback for development:

```bash
ASANA_ACCESS_TOKEN=...
```

## Sync semantics

Pull:

- Fetch remote project tasks by page.
- Upsert Jarvis requirements by `(connector, remote_task_id)`.
- Preserve Jarvis-only fields such as `conversation_ids`, `todos`, `verification_plan`,
  `triage_state`, and `depends_on`.
- If remote task disappeared, mark binding stale; do not delete local requirement in v1.

Push:

- Only explicit user action or approved tool call.
- Push a narrow patch: status, comment, title / description if requested.
- On conflict (`remote_updated_at` newer than binding), return a conflict result and require
  user choice.

Activity:

- Every pull / push writes an Activity row with connector id, remote id, and summary.
- Connector errors should surface in Project settings and diagnostics.

## Plugin packaging

Keep two concepts separate:

- **Built-in connector implementation:** compiled Rust connector code shipped with Jarvis.
- **Default plugin pack:** optional skill + MCP companion that teaches the agent how to use the
  connector well and may expose extra platform-specific MCP tools.

Example future `examples/plugins/asana-projects/plugin.json`:

```json
{
  "name": "asana-projects",
  "version": "0.1.0",
  "description": "Asana project connector workflow pack for Jarvis Projects.",
  "author": "Jarvis Project",
  "license": "MIT",
  "skills": ["skills/asana-projects"]
}
```

The plugin can be listed in `/v1/plugins/marketplace`, but the actual sync engine should live in
`harness-connectors` so it can access stores, auth, diagnostics, and approval policy directly.

## Phased delivery

**Phase 1 — Asana read/import**

- `harness-connectors` crate with generic model + Asana client.
- Account loading from `ASANA_ACCESS_TOKEN` and auth store.
- `list_remote_projects`, `import_project`, `pull_requirements`.
- JSON-file binding stores.
- REST routes and CLI smoke command.

**Phase 2 — Web binding UX**

- Settings connector account panel.
- Project settings bind/import/sync panel.
- Requirement external link and sync badges.

**Phase 3 — Push back**

- Approval-gated status update and comment push.
- Conflict detection by remote updated timestamp.
- Activity rows for every push.

**Phase 4 — More platforms**

- Linear connector.
- Jira Cloud connector.
- GitHub Issues connector.
- ClickUp / Trello based on user demand.

**Phase 5 — Scheduling**

- Per-project sync interval.
- Manual sync stays available.
- Background sync writes diagnostics instead of interrupting chat.

## First PR scope

Keep the first PR intentionally narrow:

1. Add connector proposal and crate skeleton.
2. Add binding models and memory / JSON stores.
3. Add Asana read-only client for workspaces, projects, tasks.
4. Add `connector.projects.list_remote` and `connector.projects.import` tools.
5. Add marketplace entry for `asana-projects` skill pack only after the import path works.

This gets Asana projects into Jarvis Projects without committing to a broad integration surface too early.
