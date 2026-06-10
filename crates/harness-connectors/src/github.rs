//! GitHub Issues connector — the first shipped [`ProjectConnector`].
//!
//! Mapping: a *remote project* is a repository (`owner/repo`); a *remote
//! task* is an issue (number as a string). Pull requests are excluded
//! from pulls (GitHub's issues API returns them interleaved). The REST
//! base URL is injectable so tests (and GHES deployments) can point it
//! at a stub server.

use serde_json::Value;

use crate::{
    ConnectorAuth, ConnectorError, ProjectBinding, ProjectConnector, PullResult, PushAction,
    PushResult, RemoteIssue, RemoteIssueState, RemoteProject, RequirementPush,
};

const DEFAULT_BASE_URL: &str = "https://api.github.com";
/// Issues per page (GitHub max).
const PER_PAGE: usize = 100;
/// Hard cap on pages per pull — 1 000 issues. Beyond that a cursor-based
/// incremental pull (Phase 5) is the right tool, not a bigger loop.
const MAX_PAGES: usize = 10;

pub struct GitHubConnector {
    http: reqwest::Client,
    base_url: String,
}

impl Default for GitHubConnector {
    fn default() -> Self {
        Self::new()
    }
}

impl GitHubConnector {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::new(),
            base_url: DEFAULT_BASE_URL.to_string(),
        }
    }

    /// Point the connector at a different API root (tests / GHES).
    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into().trim_end_matches('/').to_string();
        self
    }

    fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        auth: &ConnectorAuth,
    ) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("{}{path}", self.base_url))
            .header("authorization", format!("Bearer {}", auth.token))
            .header("accept", "application/vnd.github+json")
            .header("x-github-api-version", "2022-11-28")
            .header("user-agent", "jarvis-connector")
    }

    async fn send(&self, req: reqwest::RequestBuilder) -> Result<Value, ConnectorError> {
        let resp = req
            .send()
            .await
            .map_err(|e| ConnectorError::Other(format!("github request failed: {e}")))?;
        let status = resp.status();
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        match status.as_u16() {
            200..=299 => Ok(body),
            401 | 403 => Err(ConnectorError::Auth(github_message(&body, status))),
            404 => Err(ConnectorError::NotFound(github_message(&body, status))),
            _ => Err(ConnectorError::Other(github_message(&body, status))),
        }
    }
}

fn github_message(body: &Value, status: reqwest::StatusCode) -> String {
    match body.get("message").and_then(Value::as_str) {
        Some(m) => format!("github {status}: {m}"),
        None => format!("github {status}"),
    }
}

/// `owner/repo` → validated path segments. Rejects anything that could
/// change the request path shape (empty parts, extra slashes).
fn split_repo(remote_project_id: &str) -> Result<(&str, &str), ConnectorError> {
    match remote_project_id.split('/').collect::<Vec<_>>().as_slice() {
        [owner, repo]
            if !owner.is_empty()
                && !repo.is_empty()
                && owner.chars().all(valid_repo_char)
                && repo.chars().all(valid_repo_char) =>
        {
            Ok((
                &remote_project_id[..owner.len()],
                &remote_project_id[owner.len() + 1..],
            ))
        }
        _ => Err(ConnectorError::Other(format!(
            "invalid github remote_project_id (want owner/repo): {remote_project_id:?}"
        ))),
    }
}

fn valid_repo_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')
}

/// Issue numbers are numeric; reject anything else before it reaches a
/// request path.
fn validate_issue_number(remote_task_id: &str) -> Result<&str, ConnectorError> {
    if !remote_task_id.is_empty() && remote_task_id.bytes().all(|b| b.is_ascii_digit()) {
        Ok(remote_task_id)
    } else {
        Err(ConnectorError::Other(format!(
            "invalid github issue number: {remote_task_id:?}"
        )))
    }
}

/// One GitHub REST issue object → normalized [`RemoteIssue`].
/// Returns `None` for pull requests (which the issues API interleaves).
pub(crate) fn parse_issue(v: &Value) -> Option<RemoteIssue> {
    if v.get("pull_request").is_some() {
        return None;
    }
    let number = v.get("number")?.as_u64()?;
    let state = match v.get("state").and_then(Value::as_str) {
        Some("closed") => RemoteIssueState::Closed,
        _ => RemoteIssueState::Open,
    };
    Some(RemoteIssue {
        id: number.to_string(),
        title: v
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        body: v
            .get("body")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string),
        state,
        url: v
            .get("html_url")
            .and_then(Value::as_str)
            .map(str::to_string),
        labels: v
            .get("labels")
            .and_then(Value::as_array)
            .map(|ls| {
                ls.iter()
                    .filter_map(|l| l.get("name").and_then(Value::as_str))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        updated_at: v
            .get("updated_at")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

#[async_trait::async_trait]
impl ProjectConnector for GitHubConnector {
    fn id(&self) -> &'static str {
        "github"
    }

    fn display_name(&self) -> &'static str {
        "GitHub Issues"
    }

    async fn list_remote_projects(
        &self,
        auth: &ConnectorAuth,
    ) -> Result<Vec<RemoteProject>, ConnectorError> {
        let body = self
            .send(self.request(
                reqwest::Method::GET,
                "/user/repos?per_page=100&sort=updated",
                auth,
            ))
            .await?;
        let repos = body
            .as_array()
            .ok_or_else(|| ConnectorError::Other("github: expected repo array".into()))?;
        Ok(repos
            .iter()
            .filter_map(|r| {
                Some(RemoteProject {
                    id: r.get("full_name")?.as_str()?.to_string(),
                    name: r
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    url: r
                        .get("html_url")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    description: r
                        .get("description")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                })
            })
            .collect())
    }

    async fn pull_requirements(
        &self,
        auth: &ConnectorAuth,
        binding: &ProjectBinding,
    ) -> Result<PullResult, ConnectorError> {
        let (owner, repo) = split_repo(&binding.remote_project_id)?;
        let mut issues = Vec::new();
        for page in 1..=MAX_PAGES {
            let path = format!(
                "/repos/{owner}/{repo}/issues?state=all&per_page={PER_PAGE}&page={page}"
            );
            let body = self.send(self.request(reqwest::Method::GET, &path, auth)).await?;
            let rows = body
                .as_array()
                .ok_or_else(|| ConnectorError::Other("github: expected issue array".into()))?;
            let n = rows.len();
            issues.extend(rows.iter().filter_map(parse_issue));
            if n < PER_PAGE {
                break;
            }
        }
        Ok(PullResult {
            issues,
            cursor: None,
        })
    }

    async fn fetch_issue(
        &self,
        auth: &ConnectorAuth,
        binding: &ProjectBinding,
        remote_task_id: &str,
    ) -> Result<RemoteIssue, ConnectorError> {
        let (owner, repo) = split_repo(&binding.remote_project_id)?;
        let number = validate_issue_number(remote_task_id)?;
        let body = self
            .send(self.request(
                reqwest::Method::GET,
                &format!("/repos/{owner}/{repo}/issues/{number}"),
                auth,
            ))
            .await?;
        parse_issue(&body).ok_or_else(|| {
            ConnectorError::Other(format!(
                "github issue {number} is a pull request or has an unexpected shape"
            ))
        })
    }

    async fn push_requirement(
        &self,
        auth: &ConnectorAuth,
        binding: &ProjectBinding,
        remote_task_id: &str,
        change: &RequirementPush,
    ) -> Result<PushResult, ConnectorError> {
        let (owner, repo) = split_repo(&binding.remote_project_id)?;
        let number = validate_issue_number(remote_task_id)?;
        let mut result = PushResult::default();

        if let Some(comment) = change.comment.as_deref().filter(|c| !c.trim().is_empty()) {
            self.send(
                self.request(
                    reqwest::Method::POST,
                    &format!("/repos/{owner}/{repo}/issues/{number}/comments"),
                    auth,
                )
                .json(&serde_json::json!({ "body": comment })),
            )
            .await?;
        }

        if let Some(action) = change.action {
            let state = match action {
                PushAction::Close => "closed",
                PushAction::Reopen => "open",
            };
            let body = self
                .send(
                    self.request(
                        reqwest::Method::PATCH,
                        &format!("/repos/{owner}/{repo}/issues/{number}"),
                        auth,
                    )
                    .json(&serde_json::json!({ "state": state })),
                )
                .await?;
            result.remote_updated_at = body
                .get("updated_at")
                .and_then(Value::as_str)
                .map(str::to_string);
        }

        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn split_repo_accepts_owner_repo_and_rejects_garbage() {
        assert_eq!(split_repo("tyrmars/jarvis").unwrap(), ("tyrmars", "jarvis"));
        assert!(split_repo("jarvis").is_err());
        assert!(split_repo("a/b/c").is_err());
        assert!(split_repo("/jarvis").is_err());
        assert!(split_repo("owner/re po").is_err());
        assert!(split_repo("owner/../repo").is_err());
    }

    #[test]
    fn issue_number_validation_rejects_path_tricks() {
        assert!(validate_issue_number("42").is_ok());
        assert!(validate_issue_number("").is_err());
        assert!(validate_issue_number("42/comments").is_err());
        assert!(validate_issue_number("../1").is_err());
    }

    #[test]
    fn parse_issue_normalizes_and_skips_pull_requests() {
        let issue = json!({
            "number": 97,
            "title": "auto_mode: depends_on cycle",
            "body": "## Summary\n…",
            "state": "open",
            "html_url": "https://github.com/TYRMars/Jarvis/issues/97",
            "labels": [{"name": "bug"}, {"name": "P1"}],
            "updated_at": "2026-06-08T01:18:36Z"
        });
        let r = parse_issue(&issue).unwrap();
        assert_eq!(r.id, "97");
        assert_eq!(r.state, RemoteIssueState::Open);
        assert_eq!(r.labels, vec!["bug", "P1"]);
        assert_eq!(r.url.as_deref(), Some("https://github.com/TYRMars/Jarvis/issues/97"));

        let pr = json!({
            "number": 98,
            "title": "a pull request",
            "state": "open",
            "pull_request": {"url": "…"}
        });
        assert!(parse_issue(&pr).is_none(), "PRs must be excluded from pulls");
    }

    #[test]
    fn parse_issue_maps_closed_state_and_blank_body() {
        let issue = json!({
            "number": 5,
            "title": "done thing",
            "body": "   ",
            "state": "closed"
        });
        let r = parse_issue(&issue).unwrap();
        assert_eq!(r.state, RemoteIssueState::Closed);
        assert!(r.body.is_none(), "blank bodies normalize to None");
    }
}
