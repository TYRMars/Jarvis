//! OpenAPI emission + version endpoint — the server-side foundation for
//! the client SDKs (`clients/typescript`, `clients/python`).
//!
//! ```text
//! GET /v1/version      → { name, version }
//! GET /v1/openapi.json → OpenAPI 3.0 document
//! ```
//!
//! The document is built programmatically here rather than derived from
//! handler annotations: most handlers respond with ad-hoc `json!` bodies,
//! so there are no typed response structs for a derive-based generator to
//! walk. This module is therefore the *curated* public surface — the
//! endpoints SDKs are expected to call — not an exhaustive mirror of every
//! route. When a route's wire shape changes, update the matching schema
//! here (the SDK packages consume this document).

use axum::{response::Json, routing::get, Router};
use serde_json::{json, Value};

use crate::state::AppState;

/// Crate version — the workspace version, stamped at compile time.
pub(crate) const VERSION: &str = env!("CARGO_PKG_VERSION");

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/version", get(version))
        .route("/v1/openapi.json", get(openapi_json))
}

async fn version() -> Json<Value> {
    Json(json!({ "name": "jarvis", "version": VERSION }))
}

async fn openapi_json() -> Json<Value> {
    Json(document())
}

/// Build the OpenAPI 3.0 document for the curated public surface.
pub(crate) fn document() -> Value {
    json!({
        "openapi": "3.0.3",
        "info": {
            "title": "Jarvis Agent Runtime API",
            "description": "Curated public HTTP surface of the Jarvis agent runtime. \
                Namespaces follow the product design: `chat` (completions + conversations), \
                `work` (projects + requirements kanban), `memory` (long-term memory rows). \
                Endpoints backed by an unconfigured store reply `503`.",
            "version": VERSION,
        },
        "servers": [ { "url": "/" } ],
        "paths": paths(),
        "components": {
            "schemas": schemas(),
            "parameters": {
                "Id": {
                    "name": "id",
                    "in": "path",
                    "required": true,
                    "schema": { "type": "string" }
                }
            },
            "responses": {
                "StoreUnavailable": {
                    "description": "Backing store not configured on this deployment (503)"
                }
            }
        },
    })
}

fn paths() -> Value {
    let mut paths = base_paths();
    if let (Some(base), Some(Value::Object(extra))) =
        (paths.as_object_mut(), Some(connector_paths()))
    {
        for (k, v) in extra {
            base.insert(k, v);
        }
    }
    paths
}

fn base_paths() -> Value {
    json!({
        "/health": {
            "get": {
                "tags": ["meta"],
                "summary": "Liveness probe",
                "operationId": "health",
                "responses": { "200": { "description": "Server is up" } }
            }
        },
        "/v1/version": {
            "get": {
                "tags": ["meta"],
                "summary": "Server name + semantic version",
                "operationId": "getVersion",
                "responses": { "200": { "description": "Version info", "content": { "application/json": {
                    "schema": { "type": "object", "properties": {
                        "name": { "type": "string" },
                        "version": { "type": "string" }
                    }, "required": ["name", "version"] }
                } } } }
            }
        },
        "/v1/server/info": {
            "get": {
                "tags": ["meta"],
                "summary": "Runtime configuration snapshot (provider, model, tools, memory mode)",
                "operationId": "getServerInfo",
                "responses": { "200": { "description": "Server info", "content": { "application/json": {
                    "schema": { "type": "object", "additionalProperties": true }
                } } } }
            }
        },
        "/v1/chat/completions": {
            "post": {
                "tags": ["chat"],
                "summary": "Blocking agent run over a message list",
                "operationId": "chatCompletions",
                "requestBody": { "required": true, "content": { "application/json": {
                    "schema": { "$ref": "#/components/schemas/ChatCompletionsRequest" }
                } } },
                "responses": { "200": { "description": "Final assistant message + run metadata", "content": { "application/json": {
                    "schema": { "$ref": "#/components/schemas/ChatCompletionsResponse" }
                } } } }
            }
        },
        "/v1/chat/completions/stream": {
            "post": {
                "tags": ["chat"],
                "summary": "Streaming agent run (SSE; each `data:` line is one AgentEvent)",
                "operationId": "chatCompletionsStream",
                "requestBody": { "required": true, "content": { "application/json": {
                    "schema": { "$ref": "#/components/schemas/ChatCompletionsRequest" }
                } } },
                "responses": { "200": { "description": "SSE stream of AgentEvent JSON frames", "content": { "text/event-stream": {
                    "schema": { "type": "string" }
                } } } }
            }
        },
        "/v1/conversations": {
            "post": {
                "tags": ["chat"],
                "summary": "Create a persisted conversation",
                "operationId": "createConversation",
                "requestBody": { "required": false, "content": { "application/json": {
                    "schema": { "type": "object", "properties": {
                        "system": { "type": "string", "nullable": true },
                        "id": { "type": "string", "nullable": true },
                        "project": { "type": "string", "nullable": true }
                    } }
                } } },
                "responses": {
                    "201": { "description": "Created", "content": { "application/json": {
                        "schema": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }
                    } } },
                    "503": { "$ref": "#/components/responses/StoreUnavailable" }
                }
            },
            "get": {
                "tags": ["chat"],
                "summary": "List persisted conversations",
                "operationId": "listConversations",
                "parameters": [ { "name": "limit", "in": "query", "schema": { "type": "integer" } } ],
                "responses": {
                    "200": { "description": "Conversation summaries", "content": { "application/json": {
                        "schema": { "type": "object", "additionalProperties": true }
                    } } },
                    "503": { "$ref": "#/components/responses/StoreUnavailable" }
                }
            }
        },
        "/v1/conversations/{id}": {
            "get": {
                "tags": ["chat"],
                "summary": "Fetch one conversation (full message history)",
                "operationId": "getConversation",
                "parameters": [ { "$ref": "#/components/parameters/Id" } ],
                "responses": {
                    "200": { "description": "Conversation", "content": { "application/json": {
                        "schema": { "type": "object", "additionalProperties": true }
                    } } },
                    "404": { "description": "Unknown id" },
                    "503": { "$ref": "#/components/responses/StoreUnavailable" }
                }
            },
            "delete": {
                "tags": ["chat"],
                "summary": "Delete a conversation",
                "operationId": "deleteConversation",
                "parameters": [ { "$ref": "#/components/parameters/Id" } ],
                "responses": {
                    "200": { "description": "Deleted" },
                    "503": { "$ref": "#/components/responses/StoreUnavailable" }
                }
            }
        },
        "/v1/conversations/{id}/messages": {
            "post": {
                "tags": ["chat"],
                "summary": "Append a user message, run the agent, persist + return the result",
                "operationId": "postConversationMessage",
                "parameters": [ { "$ref": "#/components/parameters/Id" } ],
                "requestBody": { "required": true, "content": { "application/json": {
                    "schema": { "type": "object", "properties": {
                        "content": { "type": "string" },
                        "model": { "type": "string", "nullable": true },
                        "provider": { "type": "string", "nullable": true }
                    }, "required": ["content"] }
                } } },
                "responses": {
                    "200": { "description": "Run result", "content": { "application/json": {
                        "schema": { "type": "object", "properties": {
                            "id": { "type": "string" },
                            "message": { "$ref": "#/components/schemas/Message" },
                            "iterations": { "type": "integer" },
                            "history": { "type": "array", "items": { "$ref": "#/components/schemas/Message" } }
                        } }
                    } } },
                    "404": { "description": "Unknown id" },
                    "503": { "$ref": "#/components/responses/StoreUnavailable" }
                }
            }
        },
        "/v1/conversations/{id}/messages/stream": {
            "post": {
                "tags": ["chat"],
                "summary": "Streaming variant of postConversationMessage (SSE AgentEvent frames; saves on Done)",
                "operationId": "postConversationMessageStream",
                "parameters": [ { "$ref": "#/components/parameters/Id" } ],
                "requestBody": { "required": true, "content": { "application/json": {
                    "schema": { "type": "object", "properties": {
                        "content": { "type": "string" },
                        "model": { "type": "string", "nullable": true },
                        "provider": { "type": "string", "nullable": true }
                    }, "required": ["content"] }
                } } },
                "responses": { "200": { "description": "SSE stream of AgentEvent JSON frames", "content": { "text/event-stream": {
                    "schema": { "type": "string" }
                } } } }
            }
        },
        "/v1/projects": {
            "post": {
                "tags": ["work"],
                "summary": "Create a project",
                "operationId": "createProject",
                "requestBody": { "required": true, "content": { "application/json": {
                    "schema": { "type": "object", "additionalProperties": true, "properties": {
                        "name": { "type": "string" }
                    }, "required": ["name"] }
                } } },
                "responses": {
                    "201": { "description": "Created project", "content": { "application/json": {
                        "schema": { "type": "object", "additionalProperties": true }
                    } } },
                    "503": { "$ref": "#/components/responses/StoreUnavailable" }
                }
            },
            "get": {
                "tags": ["work"],
                "summary": "List projects",
                "operationId": "listProjects",
                "responses": {
                    "200": { "description": "Projects", "content": { "application/json": {
                        "schema": { "type": "object", "additionalProperties": true }
                    } } },
                    "503": { "$ref": "#/components/responses/StoreUnavailable" }
                }
            }
        },
        "/v1/projects/{id_or_slug}": {
            "get": {
                "tags": ["work"],
                "summary": "Fetch one project by id or slug",
                "operationId": "getProject",
                "parameters": [ { "name": "id_or_slug", "in": "path", "required": true, "schema": { "type": "string" } } ],
                "responses": {
                    "200": { "description": "Project", "content": { "application/json": {
                        "schema": { "type": "object", "additionalProperties": true }
                    } } },
                    "404": { "description": "Unknown project" },
                    "503": { "$ref": "#/components/responses/StoreUnavailable" }
                }
            }
        },
        "/v1/projects/{project_id}/requirements": {
            "get": {
                "tags": ["work"],
                "summary": "List a project's requirements (kanban rows)",
                "operationId": "listRequirements",
                "parameters": [
                    { "name": "project_id", "in": "path", "required": true, "schema": { "type": "string" } },
                    { "name": "triage_state", "in": "query", "schema": { "type": "string",
                        "enum": ["approved", "proposed_by_agent", "proposed_by_scan", "proposed"] } }
                ],
                "responses": {
                    "200": { "description": "Requirements", "content": { "application/json": {
                        "schema": { "type": "object", "additionalProperties": true }
                    } } },
                    "503": { "$ref": "#/components/responses/StoreUnavailable" }
                }
            },
            "post": {
                "tags": ["work"],
                "summary": "Create a requirement",
                "operationId": "createRequirement",
                "parameters": [ { "name": "project_id", "in": "path", "required": true, "schema": { "type": "string" } } ],
                "requestBody": { "required": true, "content": { "application/json": {
                    "schema": { "type": "object", "additionalProperties": true, "properties": {
                        "title": { "type": "string" }
                    }, "required": ["title"] }
                } } },
                "responses": {
                    "201": { "description": "Created requirement", "content": { "application/json": {
                        "schema": { "type": "object", "additionalProperties": true }
                    } } },
                    "503": { "$ref": "#/components/responses/StoreUnavailable" }
                }
            }
        },
        "/v1/requirements/{id}": {
            "get": {
                "tags": ["work"],
                "summary": "Fetch one requirement",
                "operationId": "getRequirement",
                "parameters": [ { "$ref": "#/components/parameters/Id" } ],
                "responses": {
                    "200": { "description": "Requirement", "content": { "application/json": {
                        "schema": { "type": "object", "additionalProperties": true }
                    } } },
                    "404": { "description": "Unknown id" },
                    "503": { "$ref": "#/components/responses/StoreUnavailable" }
                }
            },
            "patch": {
                "tags": ["work"],
                "summary": "Patch a requirement (title / status / fields)",
                "operationId": "patchRequirement",
                "parameters": [ { "$ref": "#/components/parameters/Id" } ],
                "requestBody": { "required": true, "content": { "application/json": {
                    "schema": { "type": "object", "additionalProperties": true }
                } } },
                "responses": {
                    "200": { "description": "Patched requirement" },
                    "404": { "description": "Unknown id" },
                    "503": { "$ref": "#/components/responses/StoreUnavailable" }
                }
            },
            "delete": {
                "tags": ["work"],
                "summary": "Soft-delete a requirement",
                "operationId": "deleteRequirement",
                "parameters": [ { "$ref": "#/components/parameters/Id" } ],
                "responses": {
                    "200": { "description": "Deleted" },
                    "503": { "$ref": "#/components/responses/StoreUnavailable" }
                }
            }
        },
        "/v1/requirements/{id}/approve": {
            "post": {
                "tags": ["work"],
                "summary": "Approve a proposed requirement (idempotent)",
                "operationId": "approveRequirement",
                "parameters": [ { "$ref": "#/components/parameters/Id" } ],
                "responses": {
                    "200": { "description": "Approved (or no-op)" },
                    "404": { "description": "Unknown id" },
                    "503": { "$ref": "#/components/responses/StoreUnavailable" }
                }
            }
        },
        "/v1/requirements/{id}/reject": {
            "post": {
                "tags": ["work"],
                "summary": "Reject a proposed requirement (writes a rejected Activity, then soft-deletes)",
                "operationId": "rejectRequirement",
                "parameters": [ { "$ref": "#/components/parameters/Id" } ],
                "requestBody": { "required": true, "content": { "application/json": {
                    "schema": { "type": "object", "properties": {
                        "reason": { "type": "string" }
                    }, "required": ["reason"] }
                } } },
                "responses": {
                    "200": { "description": "Rejected" },
                    "404": { "description": "Unknown id" },
                    "503": { "$ref": "#/components/responses/StoreUnavailable" }
                }
            }
        },
        "/v1/requirements/{id}/runs": {
            "get": {
                "tags": ["work"],
                "summary": "List a requirement's runs",
                "operationId": "listRequirementRuns",
                "parameters": [ { "$ref": "#/components/parameters/Id" } ],
                "responses": {
                    "200": { "description": "Runs" },
                    "503": { "$ref": "#/components/responses/StoreUnavailable" }
                }
            },
            "post": {
                "tags": ["work"],
                "summary": "Mint a fresh-session run (does not start the auto loop)",
                "operationId": "startRequirementRun",
                "parameters": [ { "$ref": "#/components/parameters/Id" } ],
                "responses": {
                    "201": { "description": "Run created" },
                    "404": { "description": "Unknown id" },
                    "503": { "$ref": "#/components/responses/StoreUnavailable" }
                }
            }
        },
        "/v1/memories": {
            "get": {
                "tags": ["memory"],
                "summary": "List long-term memory rows",
                "operationId": "listMemories",
                "parameters": [
                    { "name": "scope", "in": "query", "schema": { "type": "string", "enum": ["user", "project", "workspace"] } },
                    { "name": "limit", "in": "query", "schema": { "type": "integer" } }
                ],
                "responses": {
                    "200": { "description": "Memory rows" },
                    "503": { "$ref": "#/components/responses/StoreUnavailable" }
                }
            },
            "post": {
                "tags": ["memory"],
                "summary": "Create a user-scope memory row (validator-gated; rejections are 400)",
                "operationId": "createMemory",
                "requestBody": { "required": true, "content": { "application/json": {
                    "schema": { "type": "object", "additionalProperties": true }
                } } },
                "responses": {
                    "201": { "description": "Created" },
                    "400": { "description": "Validator rejection (injection / credential-like / oversized)" },
                    "503": { "$ref": "#/components/responses/StoreUnavailable" }
                }
            }
        },
        "/v1/memories/{id}": {
            "patch": {
                "tags": ["memory"],
                "summary": "Patch a memory row (atomic read-modify-write)",
                "operationId": "patchMemory",
                "parameters": [ { "$ref": "#/components/parameters/Id" } ],
                "requestBody": { "required": true, "content": { "application/json": {
                    "schema": { "type": "object", "additionalProperties": true }
                } } },
                "responses": {
                    "200": { "description": "Patched" },
                    "400": { "description": "Validator rejection" },
                    "404": { "description": "Unknown id" },
                    "503": { "$ref": "#/components/responses/StoreUnavailable" }
                }
            },
            "delete": {
                "tags": ["memory"],
                "summary": "Delete a memory row",
                "operationId": "deleteMemory",
                "parameters": [ { "$ref": "#/components/parameters/Id" } ],
                "responses": {
                    "200": { "description": "Deletion result `{ deleted: bool }`" },
                    "503": { "$ref": "#/components/responses/StoreUnavailable" }
                }
            }
        }
    })
}


fn connector_paths() -> Value {
    json!({
        "/v1/connectors": {
            "get": {
                "tags": ["work"],
                "summary": "List registered project connectors (GitHub Issues, …)",
                "operationId": "listConnectors",
                "responses": { "200": { "description": "Connector kinds" } }
            }
        },
        "/v1/connectors/accounts": {
            "get": {
                "tags": ["work"],
                "summary": "List connector accounts (auth_ref names a secret, never a token)",
                "operationId": "listConnectorAccounts",
                "responses": {
                    "200": { "description": "Accounts" },
                    "503": { "$ref": "#/components/responses/StoreUnavailable" }
                }
            }
        },
        "/v1/connectors/{connector}/accounts": {
            "post": {
                "tags": ["work"],
                "summary": "Create a connector account",
                "operationId": "createConnectorAccount",
                "parameters": [ { "name": "connector", "in": "path", "required": true, "schema": { "type": "string" } } ],
                "requestBody": { "required": true, "content": { "application/json": {
                    "schema": { "type": "object", "properties": {
                        "display_name": { "type": "string" },
                        "auth_ref": { "type": "string", "description": "NAME of the secret (e.g. GITHUB_TOKEN); raw tokens are rejected" }
                    }, "required": ["display_name", "auth_ref"] }
                } } },
                "responses": {
                    "201": { "description": "Created" },
                    "400": { "description": "auth_ref looks like a raw token" },
                    "404": { "description": "Unknown connector" },
                    "503": { "$ref": "#/components/responses/StoreUnavailable" }
                }
            }
        },
        "/v1/connectors/{connector}/projects": {
            "get": {
                "tags": ["work"],
                "summary": "List remote projects visible to an account",
                "operationId": "listConnectorRemoteProjects",
                "parameters": [
                    { "name": "connector", "in": "path", "required": true, "schema": { "type": "string" } },
                    { "name": "account_id", "in": "query", "required": true, "schema": { "type": "string" } }
                ],
                "responses": {
                    "200": { "description": "Remote projects" },
                    "404": { "description": "Unknown connector/account" },
                    "502": { "description": "Remote API failure" },
                    "503": { "$ref": "#/components/responses/StoreUnavailable" }
                }
            }
        },
        "/v1/connectors/{connector}/import": {
            "post": {
                "tags": ["work"],
                "summary": "Bind a remote project and run the initial issue import",
                "operationId": "importConnectorProject",
                "parameters": [ { "name": "connector", "in": "path", "required": true, "schema": { "type": "string" } } ],
                "requestBody": { "required": true, "content": { "application/json": {
                    "schema": { "type": "object", "properties": {
                        "account_id": { "type": "string" },
                        "remote_project_id": { "type": "string", "description": "GitHub: owner/repo" },
                        "project_id": { "type": "string", "nullable": true },
                        "name": { "type": "string", "nullable": true }
                    }, "required": ["account_id", "remote_project_id"] }
                } } },
                "responses": {
                    "201": { "description": "Binding + import summary" },
                    "409": { "description": "Remote project already bound" },
                    "503": { "$ref": "#/components/responses/StoreUnavailable" }
                }
            }
        },
        "/v1/project-bindings/{id}/sync": {
            "post": {
                "tags": ["work"],
                "summary": "Re-pull a bound remote project (idempotent upsert; local status never clobbered)",
                "operationId": "syncProjectBinding",
                "parameters": [ { "$ref": "#/components/parameters/Id" } ],
                "responses": {
                    "200": { "description": "Sync summary" },
                    "404": { "description": "Unknown binding" },
                    "503": { "$ref": "#/components/responses/StoreUnavailable" }
                }
            }
        },
        "/v1/requirement-bindings/{id}/push": {
            "post": {
                "tags": ["work"],
                "summary": "Write back to the remote issue (close/reopen and/or comment; 409 on remote drift unless force)",
                "operationId": "pushRequirementBinding",
                "parameters": [ { "$ref": "#/components/parameters/Id" } ],
                "requestBody": { "required": true, "content": { "application/json": {
                    "schema": { "type": "object", "properties": {
                        "action": { "type": "string", "enum": ["close", "reopen"], "nullable": true },
                        "comment": { "type": "string", "nullable": true },
                        "force": { "type": "boolean", "default": false }
                    } }
                } } },
                "responses": {
                    "200": { "description": "Updated binding" },
                    "400": { "description": "Empty push" },
                    "409": { "description": "Remote changed since last sync" },
                    "503": { "$ref": "#/components/responses/StoreUnavailable" }
                }
            }
        }
    })
}

fn schemas() -> Value {
    json!({
        "Message": {
            "type": "object",
            "description": "Chat message in the OpenAI chat-completions wire shape; \
                `role` is the discriminator (`system` / `user` / `assistant` / `tool`).",
            "properties": {
                "role": { "type": "string", "enum": ["system", "user", "assistant", "tool"] },
                "content": { "type": "string", "nullable": true },
                "tool_calls": { "type": "array", "items": { "type": "object", "additionalProperties": true } },
                "tool_call_id": { "type": "string", "nullable": true }
            },
            "required": ["role"],
            "additionalProperties": true
        },
        "ChatCompletionsRequest": {
            "type": "object",
            "properties": {
                "model": { "type": "string", "nullable": true },
                "provider": { "type": "string", "nullable": true,
                    "description": "Explicit provider name; wins over a provider/model form on `model`." },
                "messages": { "type": "array", "items": { "$ref": "#/components/schemas/Message" } }
            },
            "required": ["messages"]
        },
        "ChatCompletionsResponse": {
            "type": "object",
            "properties": {
                "message": { "$ref": "#/components/schemas/Message" },
                "iterations": { "type": "integer" },
                "history": { "type": "array", "items": { "$ref": "#/components/schemas/Message" } }
            },
            "required": ["message", "iterations", "history"]
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use harness_core::{Agent, AgentConfig, ChatRequest, ChatResponse, Error, LlmProvider};
    use std::sync::Arc;
    use tower::ServiceExt;

    struct StubLlm;
    #[async_trait::async_trait]
    impl LlmProvider for StubLlm {
        async fn complete(&self, _: ChatRequest) -> Result<ChatResponse, Error> {
            Err(Error::Provider("stub".into()))
        }
    }

    fn test_state() -> AppState {
        AppState::new(Arc::new(Agent::new(
            Arc::new(StubLlm) as Arc<dyn LlmProvider>,
            AgentConfig::new("stub-model"),
        )))
    }

    #[test]
    fn document_is_openapi_3_with_crate_version() {
        let doc = document();
        assert_eq!(doc["openapi"], "3.0.3");
        assert_eq!(doc["info"]["version"], VERSION);
    }

    #[test]
    fn document_covers_core_paths() {
        let doc = document();
        let paths = doc["paths"].as_object().unwrap();
        for p in [
            "/health",
            "/v1/version",
            "/v1/chat/completions",
            "/v1/chat/completions/stream",
            "/v1/conversations",
            "/v1/conversations/{id}/messages",
            "/v1/projects",
            "/v1/projects/{project_id}/requirements",
            "/v1/requirements/{id}/approve",
            "/v1/memories",
        ] {
            assert!(paths.contains_key(p), "missing path: {p}");
        }
    }

    #[test]
    fn schema_refs_all_resolve() {
        // Walk the document for `$ref` strings and assert each points at
        // an existing component, so a typo can't ship a dangling ref.
        let doc = document();
        let mut refs = Vec::new();
        collect_refs(&doc, &mut refs);
        assert!(!refs.is_empty());
        for r in refs {
            let key = r
                .strip_prefix("#/components/")
                .unwrap_or_else(|| panic!("non-local ref: {r}"));
            let mut node = &doc["components"];
            for part in key.split('/') {
                node = &node[part];
            }
            assert!(!node.is_null(), "dangling $ref: {r}");
        }
    }

    fn collect_refs(v: &Value, out: &mut Vec<String>) {
        match v {
            Value::Object(map) => {
                for (k, val) in map {
                    if k == "$ref" {
                        if let Some(s) = val.as_str() {
                            out.push(s.to_string());
                        }
                    } else {
                        collect_refs(val, out);
                    }
                }
            }
            Value::Array(items) => {
                for item in items {
                    collect_refs(item, out);
                }
            }
            _ => {}
        }
    }

    #[tokio::test]
    async fn version_endpoint_returns_crate_version() {
        let router = crate::routes::router(test_state());
        let resp = router
            .oneshot(
                Request::builder()
                    .uri("/v1/version")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["name"], "jarvis");
        assert_eq!(v["version"], VERSION);
    }

    #[tokio::test]
    async fn openapi_endpoint_serves_document() {
        let router = crate::routes::router(test_state());
        let resp = router
            .oneshot(
                Request::builder()
                    .uri("/v1/openapi.json")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20)
            .await
            .unwrap();
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["info"]["version"], VERSION);
        assert!(v["paths"]["/v1/chat/completions"].is_object());
    }
}
