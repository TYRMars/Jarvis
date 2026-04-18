# Database schema

The Rust rewrite has no persistence layer yet — agents, conversations, and tools live
only in memory inside `apps/jarvis`. Schema design is deferred until the
`harness-store` crate is introduced.

When that crate lands it should:

- Use `sqlx` against SQLite by default, with the URL taken from `DATABASE_URL`.
- Own its migrations under `crates/harness-store/migrations/` (`sqlx migrate`).
- Expose repository traits (`AgentRepo`, `ConversationRepo`, `ToolRepo`, `MemoryRepo`)
  rather than leaking `sqlx` types through the public API, so other backends remain
  possible.

The previous TypeScript codebase modelled `agents`, `conversations`, `agent_workflows`,
`agent_workflow_nodes`, `prompts`, `prompt_versions`, `tools`, `knowledge_bases`,
`memory`, `mcp_servers`, `intents`, `intent_examples`, and `llm_provider_configs` —
treat that as a feature inventory, not a schema to copy. Most of those tables stored
JSON blobs in `TEXT` columns, which is the first thing the rewrite should fix.
