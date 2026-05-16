//! Online market proxies for MCP servers and Skills.
//!
//! The web UI reads these endpoints instead of calling public
//! registries directly. That keeps CORS, source-specific JSON
//! normalisation, and install-time validation in one server-side
//! place.

use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use axum::{
    extract::{Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use harness_skill::{parse_skill, SkillCatalog, SkillEntry, SkillSource};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::state::AppState;
use crate::state_layers::SkillsLayer;

const MCP_REGISTRY_URL: &str = "https://registry.modelcontextprotocol.io/v0.1/servers";
const SKILLS_SH_URL: &str = "https://skills.sh";
const USER_AGENT: &str = "jarvis-market/0.1";
const MAX_SKILL_BYTES: usize = 512 * 1024;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/market/mcp", get(search_mcp))
        .route("/v1/market/skills", get(search_skills))
        .route("/v1/market/skills/install", post(install_skill))
}

#[derive(Debug, Deserialize)]
struct MarketQuery {
    q: Option<String>,
    limit: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MarketMcpEntry {
    name: String,
    title: Option<String>,
    description: Option<String>,
    version: Option<String>,
    repository_url: Option<String>,
    remotes: Vec<MarketMcpRemote>,
    packages: Vec<MarketMcpPackage>,
    is_latest: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MarketMcpRemote {
    transport_type: String,
    url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MarketMcpPackage {
    registry_type: String,
    identifier: String,
    version: Option<String>,
    transport_type: Option<String>,
    required_env: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MarketSkillEntry {
    source: String,
    skill_id: String,
    name: String,
    installs: Option<u64>,
    is_official: bool,
    install_hint: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallSkillRequest {
    source: String,
    skill_id: String,
}

#[allow(clippy::result_large_err)]
fn require_catalog(skills: &SkillsLayer) -> Result<Arc<RwLock<SkillCatalog>>, Response> {
    skills.catalog.clone().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "skill catalogue not configured" })),
        )
            .into_response()
    })
}

#[allow(clippy::result_large_err)]
fn require_user_skill_dir(skills: &SkillsLayer) -> Result<PathBuf, Response> {
    skills.user_dir.clone().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "user skill directory not configured" })),
        )
            .into_response()
    })
}

async fn search_mcp(Query(q): Query<MarketQuery>) -> Response {
    let limit = q.limit.unwrap_or(20).clamp(1, 50);
    let mut url = format!("{MCP_REGISTRY_URL}?limit={limit}");
    if let Some(query) = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        url.push_str("&search=");
        url.push_str(&encode_component(query));
    }
    let client = match http_client() {
        Ok(client) => client,
        Err(e) => return market_error(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    let res = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => return market_error(StatusCode::BAD_GATEWAY, format!("mcp registry: {e}")),
    };
    if !res.status().is_success() {
        return market_error(
            StatusCode::BAD_GATEWAY,
            format!("mcp registry returned {}", res.status()),
        );
    }
    let body: Value = match res.json().await {
        Ok(v) => v,
        Err(e) => return market_error(StatusCode::BAD_GATEWAY, format!("mcp registry json: {e}")),
    };
    let entries = body
        .get("servers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(normalise_mcp_entry)
        .collect::<Vec<_>>();
    (StatusCode::OK, Json(json!({ "servers": entries }))).into_response()
}

async fn search_skills(Query(q): Query<MarketQuery>) -> Response {
    let limit = q.limit.unwrap_or(30).clamp(1, 100);
    let query = q.q.as_deref().unwrap_or("").trim().to_ascii_lowercase();
    let client = match http_client() {
        Ok(client) => client,
        Err(e) => return market_error(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    let text = match client.get(SKILLS_SH_URL).send().await {
        Ok(r) => match r.text().await {
            Ok(text) => text,
            Err(e) => return market_error(StatusCode::BAD_GATEWAY, format!("skills.sh body: {e}")),
        },
        Err(e) => return market_error(StatusCode::BAD_GATEWAY, format!("skills.sh: {e}")),
    };
    let mut entries = extract_skills_sh_entries(&text);
    if !query.is_empty() {
        entries.retain(|e| {
            e.name.to_ascii_lowercase().contains(&query)
                || e.skill_id.to_ascii_lowercase().contains(&query)
                || e.source.to_ascii_lowercase().contains(&query)
        });
    }
    entries.truncate(limit);
    (StatusCode::OK, Json(json!({ "skills": entries }))).into_response()
}

async fn install_skill(
    State(skills): State<SkillsLayer>,
    Json(req): Json<InstallSkillRequest>,
) -> Response {
    let catalog = match require_catalog(&skills) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let user_dir = match require_user_skill_dir(&skills) {
        Ok(d) => d,
        Err(r) => return r,
    };
    if !valid_github_source(&req.source) || !valid_skill_path_part(&req.skill_id) {
        return market_error(StatusCode::BAD_REQUEST, "invalid skill source or id");
    }

    let (text, url) = match download_skill_md(&req.source, &req.skill_id).await {
        Ok(v) => v,
        Err(e) => return market_error(StatusCode::BAD_GATEWAY, e),
    };
    if text.len() > MAX_SKILL_BYTES {
        return market_error(
            StatusCode::BAD_REQUEST,
            format!("SKILL.md is too large ({} bytes)", text.len()),
        );
    }
    let parsed = match parse_skill(&text) {
        Ok(p) => p,
        Err(e) => return market_error(StatusCode::BAD_REQUEST, format!("invalid SKILL.md: {e}")),
    };
    let skill_dir = user_dir.join(&parsed.manifest.name);
    let skill_path = skill_dir.join("SKILL.md");
    if let Err(e) = tokio::fs::create_dir_all(&skill_dir).await {
        return market_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("create skill dir: {e}"),
        );
    }
    if let Err(e) = tokio::fs::write(&skill_path, &text).await {
        return market_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("write SKILL.md: {e}"),
        );
    }
    let entry = SkillEntry {
        manifest: parsed.manifest,
        body: parsed.body,
        path: skill_path,
        source: SkillSource::User,
    };
    let summary = json!({
        "name": entry.manifest.name,
        "description": entry.manifest.description,
        "license": entry.manifest.license,
        "allowed_tools": entry.manifest.allowed_tools,
        "activation": entry.manifest.activation,
        "keywords": entry.manifest.keywords,
        "version": entry.manifest.version,
        "source": entry.source,
        "path": entry.path.display().to_string(),
        "downloaded_from": url,
    });
    match catalog.write() {
        Ok(mut guard) => guard.insert(entry),
        Err(_) => {
            return market_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "skill catalogue lock poisoned",
            )
        }
    }
    (StatusCode::CREATED, Json(json!({ "skill": summary }))).into_response()
}

fn normalise_mcp_entry(raw: &Value) -> Option<MarketMcpEntry> {
    let server = raw.get("server")?;
    let name = server.get("name")?.as_str()?.to_string();
    let meta = raw
        .get("_meta")?
        .get("io.modelcontextprotocol.registry/official");
    let remotes = server
        .get("remotes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|r| {
            Some(MarketMcpRemote {
                transport_type: r.get("type")?.as_str()?.to_string(),
                url: r.get("url")?.as_str()?.to_string(),
            })
        })
        .collect::<Vec<_>>();
    let packages = server
        .get("packages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|p| {
            let required_env = p
                .get("environmentVariables")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|e| {
                    e.get("isRequired")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                })
                .filter_map(|e| e.get("name").and_then(Value::as_str).map(str::to_string))
                .collect();
            Some(MarketMcpPackage {
                registry_type: p.get("registryType")?.as_str()?.to_string(),
                identifier: p.get("identifier")?.as_str()?.to_string(),
                version: p.get("version").and_then(Value::as_str).map(str::to_string),
                transport_type: p
                    .get("transport")
                    .and_then(|t| t.get("type"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                required_env,
            })
        })
        .collect::<Vec<_>>();
    Some(MarketMcpEntry {
        name,
        title: server
            .get("title")
            .and_then(Value::as_str)
            .map(str::to_string),
        description: server
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string),
        version: server
            .get("version")
            .and_then(Value::as_str)
            .map(str::to_string),
        repository_url: server
            .get("repository")
            .and_then(|r| r.get("url"))
            .and_then(Value::as_str)
            .map(str::to_string),
        remotes,
        packages,
        is_latest: meta
            .and_then(|m| m.get("isLatest"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn extract_skills_sh_entries(text: &str) -> Vec<MarketSkillEntry> {
    let mut entries = Vec::new();
    let normalized = text.replace("\\\"", "\"").replace("\\/", "/");
    let mut rest = normalized.as_str();
    while let Some(source_idx) = rest.find("\"source\":\"") {
        rest = &rest[source_idx + "\"source\":\"".len()..];
        let Some(source_end) = rest.find('"') else {
            break;
        };
        let source = unescape_json_string(&rest[..source_end]);
        let after_source = &rest[source_end..];
        let Some(skill_idx) = after_source.find("\"skillId\":\"") else {
            rest = after_source;
            continue;
        };
        let after_skill = &after_source[skill_idx + "\"skillId\":\"".len()..];
        let Some(skill_end) = after_skill.find('"') else {
            break;
        };
        let skill_id = unescape_json_string(&after_skill[..skill_end]);
        let after_id = &after_skill[skill_end..];
        let name = find_json_string(after_id, "\"name\":\"").unwrap_or_else(|| skill_id.clone());
        let installs = find_json_u64(after_id, "\"installs\":");
        let is_official = find_json_bool(after_id, "\"isOfficial\":").unwrap_or(false);
        if valid_github_source(&source) && valid_skill_path_part(&skill_id) {
            entries.push(MarketSkillEntry {
                install_hint: format!("{} / {}", source, skill_id),
                source,
                skill_id,
                name,
                installs,
                is_official,
            });
        }
        rest = after_id;
        if entries.len() >= 5000 {
            break;
        }
    }
    dedupe_skills(entries)
}

fn dedupe_skills(entries: Vec<MarketSkillEntry>) -> Vec<MarketSkillEntry> {
    let mut seen = std::collections::BTreeSet::new();
    entries
        .into_iter()
        .filter(|e| seen.insert((e.source.clone(), e.skill_id.clone())))
        .collect()
}

async fn download_skill_md(source: &str, skill_id: &str) -> Result<(String, String), String> {
    let client = http_client()?;
    let branches = ["main", "master"];
    let paths = [
        format!("skills/{skill_id}/SKILL.md"),
        format!("{skill_id}/SKILL.md"),
        format!(".agents/skills/{skill_id}/SKILL.md"),
    ];
    let mut last = String::new();
    for branch in branches {
        for path in &paths {
            let url = format!("https://raw.githubusercontent.com/{source}/{branch}/{path}");
            match client.get(&url).send().await {
                Ok(res) if res.status().is_success() => match res.text().await {
                    Ok(text) => return Ok((text, url)),
                    Err(e) => last = e.to_string(),
                },
                Ok(res) => last = format!("{} returned {}", url, res.status()),
                Err(e) => last = e.to_string(),
            }
        }
    }
    Err(format!("could not download SKILL.md: {last}"))
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .default_headers({
            let mut headers = header::HeaderMap::new();
            headers.insert(
                header::ACCEPT_ENCODING,
                header::HeaderValue::from_static("identity"),
            );
            headers
        })
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("http client: {e}"))
}

fn valid_github_source(s: &str) -> bool {
    let parts: Vec<_> = s.split('/').collect();
    parts.len() == 2 && parts.iter().all(|p| valid_github_part(p))
}

fn valid_github_part(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
}

fn valid_skill_path_part(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 160
        && !s.contains("..")
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
}

fn find_json_string(s: &str, key: &str) -> Option<String> {
    let idx = s.find(key)?;
    let rest = &s[idx + key.len()..];
    let end = rest.find('"')?;
    Some(unescape_json_string(&rest[..end]))
}

fn find_json_u64(s: &str, key: &str) -> Option<u64> {
    let idx = s.find(key)?;
    let rest = &s[idx + key.len()..];
    let digits = rest
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>();
    digits.parse().ok()
}

fn find_json_bool(s: &str, key: &str) -> Option<bool> {
    let idx = s.find(key)?;
    let rest = &s[idx + key.len()..];
    if rest.starts_with("true") {
        Some(true)
    } else if rest.starts_with("false") {
        Some(false)
    } else {
        None
    }
}

fn unescape_json_string(s: &str) -> String {
    s.replace("\\/", "/")
        .replace("\\\"", "\"")
        .replace("\\\\", "\\")
}

fn encode_component(s: &str) -> String {
    s.bytes()
        .flat_map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![b as char]
            }
            _ => format!("%{b:02X}").chars().collect(),
        })
        .collect()
}

fn market_error(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "error": msg.into() }))).into_response()
}
