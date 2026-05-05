//! Read-only listing of built-in SubAgents registered as
//! `subagent.<name>` tools in the canonical [`ToolRegistry`].
//!
//! These are *not* the same as named [`AgentProfile`]s served at
//! `/v1/agent-profiles*` — those are user-defined identity bundles
//! (name + provider + model + system prompt) the kanban can assign
//! requirements to. SubAgents are delegation primitives baked into
//! the binary (`read_doc` / `review` / `codex` / `claude_code`); the
//! main agent invokes them as tools.
//!
//! The Settings UI's "Subagents" tab renders this list as read-only
//! cards alongside the editable agent-profile rows so operators can
//! see what's available out of the box without poking at the tool
//! catalogue.
//!
//! Endpoints:
//!
//! - `GET /v1/subagents` — list (always 200; empty array when none
//!   registered, e.g. when `JARVIS_DISABLE_SUBAGENTS` is set).

use axum::{response::Json, routing::get, Router};
use serde::Serialize;
use serde_json::{json, Value};

use crate::state::AppState;

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/v1/subagents", get(list))
}

/// One built-in SubAgent. The wire shape is intentionally a strict
/// subset of [`harness_core::ToolSpec`] plus the SubAgent-specific
/// `requires_approval` flag the UI uses to label "needs approval"
/// vs. "auto-runs".
#[derive(Debug, Serialize)]
struct SubAgentDescriptor {
    /// Bare subagent name, e.g. `read_doc`. Equivalent to
    /// `tool_name` minus the `subagent.` prefix.
    name: String,
    /// Full tool name as it appears in the agent's catalogue,
    /// e.g. `subagent.read_doc`.
    tool_name: String,
    /// One-line description from the wrapping `Tool::description`
    /// (the SubAgent's own description, after the adapter forwards
    /// it). Used as the card subtitle.
    description: String,
    /// `true` when the wrapping `subagent.<name>` tool is gated by
    /// the approver — i.e. the subagent can mutate the workspace
    /// (codex / claude_code).
    requires_approval: bool,
    /// JSON schema for the tool input. Surfaced for diagnostics —
    /// not currently rendered by the UI.
    parameters: Value,
}

async fn list(axum::extract::State(state): axum::extract::State<AppState>) -> Json<Value> {
    let items = collect(&state);
    Json(json!({ "items": items }))
}

fn collect(state: &AppState) -> Vec<SubAgentDescriptor> {
    let Ok(reg) = state.tools.read() else {
        return Vec::new();
    };
    let mut items: Vec<SubAgentDescriptor> = reg
        .specs_filtered(|t| t.name().starts_with("subagent."))
        .into_iter()
        .filter_map(|spec| {
            let tool = reg.resolve(&spec.name)?;
            let bare = spec
                .name
                .strip_prefix("subagent.")
                .unwrap_or(&spec.name)
                .to_string();
            Some(SubAgentDescriptor {
                name: bare,
                tool_name: spec.name,
                description: spec.description,
                requires_approval: tool.requires_approval(),
                parameters: spec.parameters,
            })
        })
        .collect();
    items.sort_by(|a, b| a.name.cmp(&b.name));
    items
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use harness_core::{
        Agent, AgentConfig, BoxError, ChatRequest, ChatResponse, LlmProvider, Tool, ToolRegistry,
    };
    use serde_json::Value;
    use std::sync::Arc;
    use tower::ServiceExt;

    struct StubLlm;
    #[async_trait]
    impl LlmProvider for StubLlm {
        async fn complete(&self, _: ChatRequest) -> Result<ChatResponse, harness_core::Error> {
            Err(harness_core::Error::Provider("stub".into()))
        }
    }

    /// Tiny stand-in tool — we don't need a real subagent wrapper for
    /// the route's test, just something that registers under the
    /// `subagent.` prefix and reports `requires_approval`.
    struct FakeSubAgentTool {
        name: String,
        approval: bool,
    }

    #[async_trait]
    impl Tool for FakeSubAgentTool {
        fn name(&self) -> &str {
            &self.name
        }
        fn description(&self) -> &str {
            "fake subagent for tests"
        }
        fn parameters(&self) -> Value {
            json!({"type":"object"})
        }
        fn requires_approval(&self) -> bool {
            self.approval
        }
        async fn invoke(&self, _: Value) -> Result<String, BoxError> {
            Ok("ok".into())
        }
    }

    fn state_with(tools: Vec<FakeSubAgentTool>) -> AppState {
        let cfg = AgentConfig::new("stub-model");
        let agent = Arc::new(Agent::new(Arc::new(StubLlm) as _, cfg));
        let state = AppState::new(agent);
        // Replace the canonical registry with one carrying our test tools.
        let mut reg = ToolRegistry::new();
        for t in tools {
            reg.register(t);
        }
        let canonical = std::sync::Arc::new(std::sync::RwLock::new(reg));
        state.with_tools(canonical)
    }

    fn app(state: AppState) -> axum::Router {
        super::router().with_state(state)
    }

    async fn read_json(resp: axum::response::Response) -> Value {
        let bytes = to_bytes(resp.into_body(), 64 * 1024).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn empty_when_no_subagents_registered() {
        let resp = app(state_with(vec![]))
            .oneshot(
                Request::builder()
                    .uri("/v1/subagents")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = read_json(resp).await;
        assert_eq!(v["items"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn lists_only_subagent_prefixed_tools_sorted() {
        let resp = app(state_with(vec![
            FakeSubAgentTool {
                name: "subagent.review".into(),
                approval: false,
            },
            FakeSubAgentTool {
                name: "subagent.codex".into(),
                approval: true,
            },
            // Non-subagent tool: must be ignored.
            FakeSubAgentTool {
                name: "fs.read".into(),
                approval: false,
            },
        ]))
        .oneshot(
            Request::builder()
                .uri("/v1/subagents")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = read_json(resp).await;
        let items = v["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        // Sorted by bare name asc.
        assert_eq!(items[0]["name"], "codex");
        assert_eq!(items[0]["tool_name"], "subagent.codex");
        assert_eq!(items[0]["requires_approval"], true);
        assert_eq!(items[1]["name"], "review");
        assert_eq!(items[1]["requires_approval"], false);
    }
}
