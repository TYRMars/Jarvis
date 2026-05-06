# Jarvis Product Design: Chat / Work / Doc and Capability Packs

**Status:** Adopted
**Translation:** Chinese version lives at
[`product-design.zh-CN.md`](product-design.zh-CN.md). When this
document changes, update the Chinese translation in the same PR.
**Touches:** product information architecture, top-level navigation in
`apps/jarvis-web`, capability composition across `harness-skill`,
`harness-plugin`, `harness-tools`, `harness-work`, and
`harness-cloud`; follow-up README, user-guide, and Web UI copy.

## Context

Jarvis should not be framed only as a "coding agent" or a "chat UI".
The long-term product shape is three clear product surfaces, backed by
an extensible capability layer.

## Positioning

Jarvis is a **local-first, extensible AI workspace for small teams**.
It connects conversation, task execution, and durable documentation.

Primary audience:

- small software teams, roughly 2-20 people;
- indie product teams and internal-tool teams;
- teams that want AI help close to their code, docs, and private
  context;
- teams that need local-first control before they adopt cloud
  collaboration.

First product wedge: **Coding Work**.

The initial product should not try to be a generic office assistant,
full document editor, enterprise project-management suite, or
ChatGPT replacement. The first strong loop is:

```text
Chat about a coding need
  -> capture TODO / create Work task
  -> execute coding task with workspace context
  -> show diff, tests, verification, and review state
  -> capture follow-ups
  -> generate durable notes / changelog / technical doc
```

Product sentence:

> Jarvis is a local-first AI workspace for small teams, turning coding
> conversations into verified work and lasting documentation.

Product surfaces:

- **Chat:** immediate conversation, questions, tool calls, lightweight
  task handling.
- **Work:** projects, tasks, execution units, verification, review,
  and long-running progress.
- **Doc:** documents, sources, reports, knowledge capture, and exports.

Capability packs:

- **Coding:** code understanding, edits, tests, diffs, Git, PR support.
- **Office:** TODOs, schedules, drafts, spreadsheets, reports, meeting
  notes.
- **Research:** search, reading, extraction, synthesis, citations,
  research bundles.
- Future packs can cover data analysis, cloud operations, design
  review, legal/contracts, finance analysis, and other domains.

Capabilities are not top-level products. Coding can happen in Chat or
as a Work execution capability. Research can answer a Chat question,
feed Work context, or produce a Doc report. Product surfaces own user
experience and durable state; capability packs own reusable tools,
skills, prompts, context builders, and policies.

## Product Principles

1. **Few surfaces, many capabilities.**
   Keep top-level navigation to Chat / Work / Doc. Do not add a new
   top-level product surface for every new domain.

2. **Capabilities cut across surfaces.**
   Coding, Office, Research, and future packs can be enabled in Chat,
   Work, Doc, or any subset of them.

3. **State ownership is explicit.**
   Chat owns conversations. Work owns projects, units, runs, and
   verification. Doc owns documents, sources, drafts, citations, and
   exports. Capability packs should not invent parallel product state.

4. **Start lightweight, upgrade when needed.**
   A Chat message can become a TODO. A TODO can become a Work task. A
   research note can become a Doc. Doc action items can flow back into
   TODO / Work.

5. **Safety is shared.**
   Approvals, permission rules, sandboxing, cloud policy, and audit
   are cross-product infrastructure, not per-surface reinventions.

6. **Local-first, cloud-enhanced.**
   Chat / Work / Doc should all work locally. Cloud / Edge
   collaboration enhances deployment, routing, artifact storage, and
   remote execution.

## Cross-Product Concepts

These concepts are not product surfaces themselves, but they cut
across Chat / Work / Doc and shape how users perceive the system. They
are inspired by [Multica](https://github.com/multica-ai/multica)'s
"agents as teammates" framing:

- **AgentProfile.** Named, configured agents (avatar, provider, model,
  optional system prompt, optional tool allowlist). Users define
  multiple profiles in Settings; conversations and Requirement runs
  pick from this list. Without this, "agent" is an anonymous global
  default; with it, agents become real teammates that can be
  @mentioned, assigned, and trusted differently.

- **Activity timeline.** Every cross-product object — a Conversation,
  a Requirement, a DocProject — accumulates an append-only stream of
  activity rows: status changes, assignee changes, run starts, run
  finishes, verification results, comments. The timeline is the
  audit trail and the basis for any future diagnostics view.

- **Assignee on actionable objects.** Requirements (the kanban cards)
  carry an optional `assignee_id` pointing at an `AgentProfile`. The
  Doc and Chat surfaces don't need this in v0 but reserve room for
  it (e.g. "draft this report with Alice's writing voice" later).

These pieces are detailed in
[`work-orchestration.zh-CN.md`](work-orchestration.zh-CN.md) under
"借鉴 Multica 的产品形态".

## Information Architecture

```text
Jarvis
  Chat
    - conversation
    - tool activity
    - approvals
    - quick actions
    - lightweight TODO capture

  Work
    - project
    - TODO backlog
    - milestone / slice / task
    - WorkRun
    - verification / review
    - diagnostics

  Doc
    - source collection
    - outline
    - draft
    - citations / references
    - export
    - knowledge notes

  Settings
    - providers
    - models
    - permissions
    - workspaces
    - skills / plugins / MCP
    - cloud / edge
```

Chat / Work / Doc are top-level navigation. Capability packs appear
inside those surfaces as tools, panels, actions, templates, and skills.

## Capability Layer

A capability pack is a declarative bundle:

```rust
pub struct CapabilityPack {
    pub id: String,
    pub title: String,
    pub description: String,
    pub surfaces: Vec<ProductSurface>,
    pub tools: Vec<String>,
    pub skills: Vec<String>,
    pub prompts: Vec<PromptTemplate>,
    pub context_builders: Vec<String>,
    pub policies: Vec<PolicyRule>,
}

pub enum ProductSurface {
    Chat,
    Work,
    Doc,
}
```

This does not need to become a complex runtime system in v0. A simple
manifest is enough to declare:

- which product surfaces the pack appears in;
- which tools it needs;
- which skills it uses;
- which context it injects;
- which operations require approval;
- which artifacts it can produce.

## Product Surfaces

### Chat

Chat is the immediate interaction surface. It is best for exploration,
questions, quick commands, temporary tool use, and capturing ideas for
later.

Core objects:

```text
Conversation
Message
AgentEvent
ToolCall
Approval
HITL question
```

Expected capabilities:

- multi-turn conversation;
- streaming output;
- visible tool activity;
- approval cards;
- workspace context capsule;
- save message/result as TODO;
- create Work task from message/result;
- save answer/result as Doc draft or research note.

Chat should not become the long-term project state container. Anything
that outgrows a conversation should move to TODO, Work, or Doc.

### Work

Work is the long-running execution surface. It is best for coding
tasks, product plans, project execution, verification, review,
diagnostics, and Cloud / Edge dispatch.

Core objects:

```text
WorkProject
TodoItem
WorkUnit
WorkRun
WorkContextManifest
VerificationResult
Artifact
```

Expected capabilities:

- TODO board as the lightweight backlog;
- upgrade TODO into Work task;
- milestone / slice / task hierarchy;
- fresh session per unit;
- verification gate;
- optional worktree isolation;
- diagnostics / forensics;
- future Cloud dispatch to Edge nodes.

Work is the most capability-dense surface. Coding, Research, Office,
cloud operations, and other packs can all become Work execution
capabilities.

### Doc

Doc is the document and knowledge-production surface. It is best for
research notes, technical designs, reports, meeting notes, PRDs, user
guides, knowledge base entries, and exports.

Core objects:

```text
DocProject
DocSource
DocOutline
DocDraft
DocRevision
Citation
ExportArtifact
```

Expected capabilities:

- collect sources;
- search and extract;
- generate outlines;
- iterative drafting and revision;
- source and citation tracking;
- export Markdown / DOCX / PDF / PPTX;
- extract action items into TODO / Work;
- generate reports, changelogs, and postmortems from Work runs.

Doc is not just a rich-text editor. Its value is source-aware,
agent-assisted document production that connects back to Chat and Work.

## Capability Matrix

| Capability | Chat | Work | Doc |
|---|---|---|---|
| Coding | explain code, small patches, Q&A | task execution, tests, diffs, review, PR prep | technical design, changelog, API docs |
| Office | draft mail, summarize, create TODO | track action items, drive progress | meeting notes, weekly reports, slide/report material |
| Research | quick search, summaries, Q&A | research context for tasks | research bundles, reports, citations, knowledge base |
| Cloud Ops | inspect status, explain alerts | runbooks, deploy checks, Edge dispatch | incident reports, runbooks, postmortems |
| Data Analysis | quick calculations, data explanation | analysis tasks, metric validation | analysis reports, chart narratives |

When adding a new capability, answer:

- Which product surfaces can use it?
- Which tools and permissions does it need?
- Which context does it read?
- Which artifacts does it produce?
- Can it upgrade or flow back into other product objects?

## Extension Model

Use four layers:

```text
Tool
  A single callable primitive: fs.read, git.diff, todo.add, http.fetch

Skill
  Model-facing method and domain knowledge: coding, research, office-writing

Capability Pack
  A bundle of tools + skills + prompts + policies + context builders

Product Surface
  The actual Chat / Work / Doc user experience
```

Example: Coding capability

```text
Tools:
  workspace.context
  git.status
  git.diff
  code.grep
  fs.read
  fs.patch
  shell.exec
  checks.run

Skills:
  coding-agent
  code-review
  test-debugging

Surfaces:
  Chat: quick Q&A and small edits
  Work: verifiable task execution
  Doc: technical designs and change notes

Policies:
  fs.patch requires approval
  shell.exec requires approval unless a rule allows it
  destructive git commands disabled by default
```

Example: Research capability

```text
Tools:
  web.search
  http.fetch
  doc.extract
  source.save
  note.add

Skills:
  research-synthesis
  citation-aware-writing

Surfaces:
  Chat: quick research Q&A
  Work: research context for tasks
  Doc: research bundles and formal reports
```

Example: Office capability

```text
Tools:
  todo.add
  todo.update
  calendar.*
  mail.draft
  sheet.*
  doc.export

Skills:
  meeting-summary
  business-writing
  spreadsheet-analysis

Surfaces:
  Chat: quick drafting and summaries
  Work: action tracking and execution
  Doc: meeting notes, weekly reports, slide material
```

## State Flow

```text
Chat
  -> Save as TODO
  -> Create Work task
  -> Create Doc draft
  -> Attach to existing Work/Doc

TODO
  -> Start lightweight action in Chat
  -> Upgrade to Work task
  -> Include in Doc action items

Work
  -> Produce artifact
  -> Create follow-up TODO
  -> Generate Doc: report / design / changelog / postmortem

Doc
  -> Extract action items as TODO
  -> Create Work task from section
  -> Attach sources to Work manifest
```

The goal is connection without collapsing every surface into one giant
page.

## Architecture Mapping

```text
Product Surfaces
  apps/jarvis-web
    Chat routes/components
    Work routes/components
    Doc routes/components

Server APIs
  harness-server
    chat routes
    todos/work routes
    doc routes
    capability registry routes

Domain Crates
  harness-core      # agent loop, traits, message, approvals
  harness-work      # project/unit/run/verification
  harness-doc       # future: document/source/draft/export
  harness-cloud     # future: cloud/edge node and dispatch

Capability Crates
  harness-tools     # callable tools
  harness-skill     # skill catalog and selection
  harness-plugin    # external extensions
  harness-mcp       # MCP bridge

Storage
  harness-store     # conversation, todo, work, doc, permissions
```

`harness-doc` is a proposed future crate. Doc v0 can begin with a
proposal, UI route, and small API surface before the crate exists.

## Related Proposals

This product design is the reference document for product-surface
ownership. Related proposals should link back here and state whether
they affect a product surface, a capability pack, or infrastructure.

| Proposal | Relationship |
|---|---|
| [`work-orchestration.zh-CN.md`](work-orchestration.zh-CN.md) | Defines the Work surface: projects, units, runs, verification, and diagnostics. |
| [`persistent-todos.md`](persistent-todos.md) | Adopted lightweight Work backlog, also used by Chat capture and Doc action items. |
| [`aicoding-agent.md`](aicoding-agent.md) / [`aicoding-agent.zh-CN.md`](aicoding-agent.zh-CN.md) | Coding capability pack shared by Chat / Work / Doc. |
| [`cloud-capabilities.zh-CN.md`](cloud-capabilities.zh-CN.md) | Cloud / Edge infrastructure for all product surfaces. |
| [`client-sdks.md`](client-sdks.md) | SDKs should expose `chat`, `work`, `doc`, and `capabilities` namespaces. |
| [`web-ui.md`](web-ui.md) | Historical Web UI MVP; future UI should follow Chat / Work / Doc navigation. |
| [`onboarding.md`](onboarding.md) | First-run setup should communicate surfaces and initial capability choices. |
| [`permission-modes.md`](permission-modes.md) | Cross-product permission and approval layer. |
| [`sandboxing.md`](sandboxing.md) | Cross-product execution safety layer. |
| [`prompt-caching.md`](prompt-caching.md) | Cross-product performance layer for capability-heavy turns. |

## Doc v0

Chat and Work already have more foundation. Doc is the next product
surface that needs a crisp boundary. Minimum model:

```text
DocProject
  id
  workspace
  title
  kind: note | research | report | design | guide

DocSource
  id
  project_id
  kind: url | file | text | conversation | work_run
  title
  uri
  excerpt

DocDraft
  id
  project_id
  format: markdown
  content
  updated_at
```

v0 features:

- save Chat answer as Doc draft;
- generate a summary document from a WorkRun;
- add URL/file/text source;
- generate outline;
- edit Markdown draft;
- export Markdown;
- later: DOCX/PDF/PPTX export.

## Web UI Shape

Top-level navigation:

```text
Chat | Work | Doc
```

Chat:

- keep the current primary conversation experience;
- side/bottom panels can show TODO, Plan, Diff, Sources;
- message actions: save TODO, create Work task, save to Doc.

Work:

- left: project / unit tree;
- middle: run stream / manifest / verification;
- right: TODO / diff / review / diagnostics.

Doc:

- left: doc projects / sources;
- middle: editor / outline;
- right: source excerpts / citations / export / action items.

Settings remains the home for providers, permissions, MCP, skills,
plugins, and Cloud / Edge configuration.

## Iteration Plan

### Phase 1: Product Design Alignment and Coding Work Wedge

- Land this proposal.
- Keep [`product-design.zh-CN.md`](product-design.zh-CN.md) in sync.
- Update English and Chinese README language around Chat / Work / Doc.
- Use the positioning sentence consistently:
  "local-first AI workspace for small teams, turning coding
  conversations into verified work and lasting documentation."
- Align Web UI top-level navigation copy.
- Make TODO board explicitly part of the Work foundation.
- Scope the first product push around Coding Work, not generic office
  automation or a full Doc editor.

### Phase 2: Capability Pack Manifest

- Define capability manifest schema.
- Ship built-in `coding`, `office`, and `research` packs.
- Expose enabled capabilities in settings or a debug endpoint.
- Keep packs declarative first; avoid dynamic runtime complexity.

### Phase 3: Chat Conversion Actions

- Chat message -> TODO.
- Chat message -> Work task.
- Chat message -> Doc draft.
- Tool result -> Doc source / Work artifact.

### Phase 4: Coding Work MVP

- Follow `work-orchestration.zh-CN.md`.
- Create Work task from TODO.
- Start WorkRun manually.
- Add verification gate.
- Optimize the first Work templates, prompts, and UI states for coding
  tasks: workspace context, diff, tests, review, and follow-up capture.

### Phase 5: Doc as Work Output

- Add DocProject / DocSource / DocDraft.
- Add Doc route and Markdown editor.
- Create Doc from Chat / Work.
- Add source excerpts and outline.
- Prioritize technical notes, changelogs, implementation summaries,
  and postmortems generated from Coding Work.

### Phase 6: Capability Marketplace

- Align capability packs with skills/plugins.
- Third-party packs can declare tools, skills, prompts, surfaces, and
  policies.
- Integrate MCP server tools and Cloud / Edge tools.

## Risks and Trade-offs

- **Too many top-level surfaces.**
  Keep only Chat / Work / Doc. New domains become capabilities.

- **Premature capability abstraction.**
  Start with manifests and built-in packs. Add dynamic loading only
  after multiple packs stabilize.

- **Work and TODO overlap.**
  TODO is lightweight backlog. Work is an executable state machine.
  Do not make TODO complex.

- **Doc becomes a generic rich-text editor.**
  Doc's value is sources, citations, agent drafting, and
  Chat/Work feedback loops.

- **Coding dominates the product story.**
  Coding is a core capability, not the whole product. Jarvis is an
  extensible agent workspace.

## Acceptance Criteria

- Product docs clearly describe Chat / Work / Doc as the only
  top-level product surfaces.
- Product docs clearly identify small teams as the first audience and
  Coding Work as the first wedge.
- English product design is the primary document, with a synchronized
  Chinese translation.
- Capability layer defines at least Coding / Office / Research.
- Adding a new capability has a clear extension path without changing
  top-level navigation.
- TODO board is explicitly part of the Work foundation.
- Work and Doc proposals link back to this product design.
- Future Web UI work has a clear navigation and state-ownership model.
