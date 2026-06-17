//! Project connectors — sync external issue trackers into Jarvis's local
//! Project / Requirement model (docs/proposals/project-connectors.zh-CN.md).
//!
//! Design boundaries (from the proposal):
//! - The local store stays the source of truth for execution, audit and
//!   auto mode; the external platform is a requirement *source* and a
//!   status-sync *target*.
//! - `ConnectorAccount.auth_ref` names a secret (e.g. an env var); raw
//!   tokens are never persisted. Library code never reads `std::env` —
//!   the composition root resolves `auth_ref` → token and passes a
//!   [`ConnectorAuth`] down.
//! - v1 is explicit import / sync / push. No background sync, no remote
//!   deletes.
//!
//! First shipped connector: GitHub Issues ([`GitHubConnector`]); the
//! trait is platform-neutral so Asana / Linear / Jira slot in later.

mod github;

pub use github::GitHubConnector;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// Boxed error alias matching the store-trait convention used across
/// the workspace.
pub type BoxError = Box<dyn std::error::Error + Send + Sync>;

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

// ---------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum ConnectorError {
    /// Authentication / authorization failure against the remote API.
    #[error("connector auth error: {0}")]
    Auth(String),
    /// Remote object (repo / project / issue) does not exist or is not
    /// visible to the token.
    #[error("remote not found: {0}")]
    NotFound(String),
    /// The remote changed since we last synced; the caller must re-pull
    /// or pass `force`.
    #[error("remote conflict: remote updated at {remote_updated_at}")]
    Conflict { remote_updated_at: String },
    /// The remote throttled us (HTTP 429 or a 403 secondary/abuse rate
    /// limit). This is a **transient** condition — distinct from
    /// [`Auth`](ConnectorError::Auth) so callers don't rotate a valid
    /// token in response to a throttle. `retry_after` carries the
    /// server-advertised cooldown in seconds when present.
    #[error("connector rate limited (retry_after={retry_after:?}s)")]
    RateLimited { retry_after: Option<u64> },
    /// Transport / decode / unexpected-shape failures.
    #[error("connector error: {0}")]
    Other(String),
}

impl ConnectorError {
    /// Whether the failure is transient and the same call may succeed on
    /// retry. Only throttles ([`RateLimited`](ConnectorError::RateLimited))
    /// qualify today — auth/not-found/conflict/other are all terminal for
    /// the caller.
    pub fn is_retryable(&self) -> bool {
        matches!(self, ConnectorError::RateLimited { .. })
    }
}

// ---------------------------------------------------------------------
// Value types
// ---------------------------------------------------------------------

/// A configured account for one connector. `auth_ref` names a secret
/// (v1: an environment-variable name) — never the raw token.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConnectorAccount {
    pub id: String,
    /// Connector id this account belongs to (`"github"`, …).
    pub connector: String,
    pub display_name: String,
    /// Key into the secret resolver (v1: env-var name, e.g. `GITHUB_TOKEN`).
    pub auth_ref: String,
    pub created_at: String,
    pub updated_at: String,
}

impl ConnectorAccount {
    pub fn new(
        connector: impl Into<String>,
        display_name: impl Into<String>,
        auth_ref: impl Into<String>,
    ) -> Self {
        let ts = now();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            connector: connector.into(),
            display_name: display_name.into(),
            auth_ref: auth_ref.into(),
            created_at: ts.clone(),
            updated_at: ts,
        }
    }
}

/// Resolved credential handed to connector calls. Built by the
/// composition root from [`ConnectorAccount::auth_ref`]; never stored.
#[derive(Clone)]
pub struct ConnectorAuth {
    pub token: String,
}

impl std::fmt::Debug for ConnectorAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never leak the token through Debug formatting / logs.
        f.debug_struct("ConnectorAuth").field("token", &"***").finish()
    }
}

/// External project (GitHub repo, Asana project, …) as listed by
/// [`ProjectConnector::list_remote_projects`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RemoteProject {
    /// Connector-scoped stable id (GitHub: `owner/repo`).
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Binding between a Jarvis [`Project`](https://docs.rs) row and one
/// remote project.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectBinding {
    pub id: String,
    pub connector: String,
    pub account_id: String,
    /// Jarvis `Project::id`.
    pub project_id: String,
    /// Connector-scoped remote project id (GitHub: `owner/repo`).
    pub remote_project_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_url: Option<String>,
    /// Opaque incremental-sync cursor (unused by v1 GitHub pull).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_cursor: Option<String>,
    /// Connector-specific mapping knobs; unknown remote fields live here
    /// rather than widening the local schema.
    #[serde(default)]
    pub field_mapping: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

impl ProjectBinding {
    pub fn new(
        connector: impl Into<String>,
        account_id: impl Into<String>,
        project_id: impl Into<String>,
        remote_project_id: impl Into<String>,
    ) -> Self {
        let ts = now();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            connector: connector.into(),
            account_id: account_id.into(),
            project_id: project_id.into(),
            remote_project_id: remote_project_id.into(),
            remote_url: None,
            sync_cursor: None,
            field_mapping: serde_json::Value::Null,
            created_at: ts.clone(),
            updated_at: ts,
        }
    }

    pub fn touch(&mut self) {
        self.updated_at = now();
    }
}

/// Binding between a Jarvis `Requirement` row and one remote issue.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RequirementBinding {
    pub id: String,
    pub connector: String,
    pub project_binding_id: String,
    /// Jarvis `Requirement::id`.
    pub requirement_id: String,
    /// Connector-scoped issue id (GitHub: the issue number as a string).
    pub remote_task_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_url: Option<String>,
    /// Remote `updated_at` as of the last pull/push — the conflict
    /// baseline for pushes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_pushed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl RequirementBinding {
    pub fn new(
        connector: impl Into<String>,
        project_binding_id: impl Into<String>,
        requirement_id: impl Into<String>,
        remote_task_id: impl Into<String>,
    ) -> Self {
        let ts = now();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            connector: connector.into(),
            project_binding_id: project_binding_id.into(),
            requirement_id: requirement_id.into(),
            remote_task_id: remote_task_id.into(),
            remote_url: None,
            remote_updated_at: None,
            last_pushed_at: None,
            created_at: ts.clone(),
            updated_at: ts,
        }
    }

    pub fn touch(&mut self) {
        self.updated_at = now();
    }
}

/// Normalized remote issue, the lingua franca between connectors and
/// the server's import/sync logic.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RemoteIssue {
    /// Connector-scoped stable id (GitHub: issue number as a string).
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    pub state: RemoteIssueState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteIssueState {
    Open,
    Closed,
}

/// Result of one [`ProjectConnector::pull_requirements`] call.
#[derive(Debug, Clone, Default)]
pub struct PullResult {
    pub issues: Vec<RemoteIssue>,
    /// Opaque cursor to persist on the binding for incremental pulls
    /// (v1 GitHub always returns `None` — full pull, idempotent upsert).
    pub cursor: Option<String>,
}

/// Narrow, explicit write-back. v1 supports closing/reopening the
/// remote issue and posting one comment; both optional, both explicit
/// (the server never derives a push from local status changes).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RequirementPush {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<PushAction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PushAction {
    Close,
    Reopen,
}

#[derive(Debug, Clone, Default)]
pub struct PushResult {
    /// Remote `updated_at` after the push, when the API reports it —
    /// becomes the new conflict baseline on the binding.
    pub remote_updated_at: Option<String>,
}

// ---------------------------------------------------------------------
// Connector trait
// ---------------------------------------------------------------------

#[async_trait]
pub trait ProjectConnector: Send + Sync {
    /// Stable connector id (`"github"`); keys accounts and bindings.
    fn id(&self) -> &'static str;
    fn display_name(&self) -> &'static str;

    /// List remote projects visible to the token (for the bind UI).
    async fn list_remote_projects(
        &self,
        auth: &ConnectorAuth,
    ) -> Result<Vec<RemoteProject>, ConnectorError>;

    /// Full pull of the remote project's issues, normalized.
    async fn pull_requirements(
        &self,
        auth: &ConnectorAuth,
        binding: &ProjectBinding,
    ) -> Result<PullResult, ConnectorError>;

    /// Fetch one issue — the conflict-detection probe before a push.
    async fn fetch_issue(
        &self,
        auth: &ConnectorAuth,
        binding: &ProjectBinding,
        remote_task_id: &str,
    ) -> Result<RemoteIssue, ConnectorError>;

    /// Apply a narrow write-back to one remote issue.
    async fn push_requirement(
        &self,
        auth: &ConnectorAuth,
        binding: &ProjectBinding,
        remote_task_id: &str,
        change: &RequirementPush,
    ) -> Result<PushResult, ConnectorError>;
}

// ---------------------------------------------------------------------
// Store traits (backends live in harness-store)
// ---------------------------------------------------------------------

#[async_trait]
pub trait ConnectorAccountStore: Send + Sync {
    async fn upsert(&self, account: &ConnectorAccount) -> Result<(), BoxError>;
    async fn get(&self, id: &str) -> Result<Option<ConnectorAccount>, BoxError>;
    async fn list(&self) -> Result<Vec<ConnectorAccount>, BoxError>;
    async fn delete(&self, id: &str) -> Result<bool, BoxError>;
}

#[async_trait]
pub trait ProjectBindingStore: Send + Sync {
    async fn upsert(&self, binding: &ProjectBinding) -> Result<(), BoxError>;
    async fn get(&self, id: &str) -> Result<Option<ProjectBinding>, BoxError>;
    /// `project_id = None` lists everything.
    async fn list(&self, project_id: Option<&str>) -> Result<Vec<ProjectBinding>, BoxError>;
    async fn delete(&self, id: &str) -> Result<bool, BoxError>;
}

#[async_trait]
pub trait RequirementBindingStore: Send + Sync {
    async fn upsert(&self, binding: &RequirementBinding) -> Result<(), BoxError>;
    async fn get(&self, id: &str) -> Result<Option<RequirementBinding>, BoxError>;
    async fn list_for_project_binding(
        &self,
        project_binding_id: &str,
    ) -> Result<Vec<RequirementBinding>, BoxError>;
    async fn find_by_remote(
        &self,
        project_binding_id: &str,
        remote_task_id: &str,
    ) -> Result<Option<RequirementBinding>, BoxError>;
    async fn find_by_requirement(
        &self,
        requirement_id: &str,
    ) -> Result<Option<RequirementBinding>, BoxError>;
    async fn delete(&self, id: &str) -> Result<bool, BoxError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_debug_never_leaks_token() {
        let auth = ConnectorAuth {
            token: "ghp_supersecret".into(),
        };
        let s = format!("{auth:?}");
        assert!(!s.contains("supersecret"), "Debug leaked the token: {s}");
    }

    #[test]
    fn account_auth_ref_is_a_name_not_a_token() {
        let a = ConnectorAccount::new("github", "personal", "GITHUB_TOKEN");
        let json = serde_json::to_string(&a).unwrap();
        assert!(json.contains("GITHUB_TOKEN"));
        assert_eq!(a.connector, "github");
    }

    #[test]
    fn only_rate_limited_is_retryable() {
        assert!(ConnectorError::RateLimited { retry_after: Some(30) }.is_retryable());
        assert!(ConnectorError::RateLimited { retry_after: None }.is_retryable());
        assert!(!ConnectorError::Auth("nope".into()).is_retryable());
        assert!(!ConnectorError::NotFound("gone".into()).is_retryable());
        assert!(!ConnectorError::Other("boom".into()).is_retryable());
        assert!(!ConnectorError::Conflict {
            remote_updated_at: "2026-06-17T00:00:00Z".into()
        }
        .is_retryable());
    }

    #[test]
    fn push_wire_shape_round_trips() {
        let p: RequirementPush =
            serde_json::from_str(r#"{"action":"close","comment":"done"}"#).unwrap();
        assert_eq!(p.action, Some(PushAction::Close));
        assert_eq!(p.comment.as_deref(), Some("done"));
        let empty: RequirementPush = serde_json::from_str("{}").unwrap();
        assert!(empty.action.is_none() && empty.comment.is_none());
    }
}
