//! HTTP routes for the skill catalogue.
//!
//! `GET    /v1/skills`              — list every loaded skill
//! `GET    /v1/skills/:name`        — fetch one skill (manifest + body)
//! `POST   /v1/skills/reload`       — re-scan disk roots
//!
//! All endpoints require an `Arc<RwLock<SkillCatalog>>` on
//! `AppState`. Without one, every route returns 503 so callers can
//! distinguish "feature not enabled" from "really broken".

use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use harness_learning::{
    SkillCreator, SkillLifecycle, SkillLifecycleStore, SkillState, SkillSource as LearningSkillSource,
};
use harness_skill::{SkillCatalog, SkillSource};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc as StdArc;
use tracing::info;

use crate::state::AppState;
use crate::state_layers::{LearningLayer, SkillsLayer};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/skills", get(list))
        .route("/v1/skills/:name", get(get_one))
        .route("/v1/skills/reload", post(reload))
        .route("/v1/skills/:name/lifecycle", get(get_lifecycle))
        .route("/v1/skills/:name/archive", post(archive_skill))
        .route("/v1/skills/:name/restore", post(restore_skill))
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

async fn list(State(skills): State<SkillsLayer>) -> Response {
    let cat = match require_catalog(&skills) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let guard = match cat.read() {
        Ok(g) => g,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "skill catalogue lock poisoned" })),
            )
                .into_response();
        }
    };
    let entries: Vec<_> = guard
        .entries()
        .map(|e| {
            json!({
                "name": e.manifest.name,
                "description": e.manifest.description,
                "license": e.manifest.license,
                "allowed_tools": e.manifest.allowed_tools,
                "activation": e.manifest.activation,
                "keywords": e.manifest.keywords,
                "version": e.manifest.version,
                "source": e.source,
                "path": e.path.display().to_string(),
            })
        })
        .collect();
    (StatusCode::OK, Json(json!({ "skills": entries }))).into_response()
}

async fn get_one(
    State(skills): State<SkillsLayer>,
    State(learning): State<LearningLayer>,
    Path(name): Path<String>,
) -> Response {
    let cat = match require_catalog(&skills) {
        Ok(c) => c,
        Err(r) => return r,
    };
    // Phase 0 self-improving-agent — record the view event before
    // returning the body. Fire-and-forget; never block the read
    // path on the learning store.
    let viewed = crate::learning_emit::build_viewed_event(
        Some(&cat),
        &name,
        harness_learning::SkillScope::user(),
        None,
    );
    if let Some(ev) = viewed {
        crate::learning_emit::spawn_record(learning.skill_usage.clone(), vec![ev]);
    }
    let guard = match cat.read() {
        Ok(g) => g,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "skill catalogue lock poisoned" })),
            )
                .into_response();
        }
    };
    match guard.get(&name) {
        Some(e) => (
            StatusCode::OK,
            Json(json!({
                "name": e.manifest.name,
                "description": e.manifest.description,
                "license": e.manifest.license,
                "allowed_tools": e.manifest.allowed_tools,
                "activation": e.manifest.activation,
                "keywords": e.manifest.keywords,
                "version": e.manifest.version,
                "source": e.source,
                "path": e.path.display().to_string(),
                "body": e.body,
            })),
        )
            .into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "no such skill", "name": name })),
        )
            .into_response(),
    }
}

async fn reload(State(skills): State<SkillsLayer>) -> Response {
    let cat = match require_catalog(&skills) {
        Ok(c) => c,
        Err(r) => return r,
    };
    // Catalog mutations (plugin install / uninstall) flow through
    // the manager, so the on-disk roots aren't the only source of
    // truth anymore — a naive re-scan would clobber plugin entries.
    // We stay conservative here: surface the current count and let
    // a future "rescan disk roots and merge" build on this once the
    // semantics are pinned down.
    info!("skills/reload received (no-op stub)");
    let count = cat.read().map(|g| g.len()).unwrap_or(0);
    (
        StatusCode::OK,
        Json(json!({ "count": count, "reloaded": false })),
    )
        .into_response()
}

// ---- Phase 2 skill lifecycle -------------------------------------------

#[allow(clippy::result_large_err)]
fn require_lifecycle(
    learning: &LearningLayer,
) -> Result<StdArc<dyn SkillLifecycleStore>, Response> {
    learning.skill_lifecycle.clone().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "skill lifecycle store not configured" })),
        )
            .into_response()
    })
}

/// Translate the catalog's source enum into the learning crate's
/// (which carries an extra `Other` variant we never hit here).
fn map_source(src: SkillSource) -> LearningSkillSource {
    match src {
        SkillSource::Bundled => LearningSkillSource::Bundled,
        SkillSource::User => LearningSkillSource::User,
        SkillSource::Workspace => LearningSkillSource::Workspace,
        SkillSource::Plugin => LearningSkillSource::Plugin,
    }
}

/// Infer who created a skill from its catalog source. Phase 2
/// heuristic: bundled / plugin / user map straight across; workspace
/// skills are assumed agent-or-user authored and tracked as `User`
/// until the `skill.manage create` tool starts stamping `Agent`
/// explicitly. This keeps the Curator's "only touch agent-created"
/// guard conservative — it won't auto-archive anything until a real
/// agent-created provenance exists.
fn infer_creator(src: SkillSource) -> SkillCreator {
    match src {
        SkillSource::Bundled => SkillCreator::Bundled,
        SkillSource::Plugin => SkillCreator::Plugin,
        SkillSource::User | SkillSource::Workspace => SkillCreator::User,
    }
}

/// Fetch the lifecycle row for `name`, seeding a default `Active` row
/// from the catalog entry when the store has none yet. Returns the
/// row or a `Response` (404 when the skill isn't in the catalog at
/// all, 503 when neither store is configured).
#[allow(clippy::result_large_err)]
async fn lifecycle_or_seed(
    skills: &SkillsLayer,
    learning: &LearningLayer,
    name: &str,
) -> Result<(StdArc<dyn SkillLifecycleStore>, SkillLifecycle), Response> {
    let store = require_lifecycle(learning)?;
    if let Some(existing) = store
        .get(name)
        .await
        .map_err(|e| internal(&e.to_string()))?
    {
        return Ok((store, existing));
    }
    // No row yet — seed from the catalog so archive/restore work the
    // first time without a separate "register" step.
    let cat = require_catalog(skills)?;
    let (source, found) = {
        let guard = cat.read().map_err(|_| poisoned())?;
        match guard.get(name) {
            Some(e) => (e.source, true),
            None => (SkillSource::User, false),
        }
    };
    if !found {
        return Err((
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "no such skill", "name": name })),
        )
            .into_response());
    }
    let seeded = SkillLifecycle::new(name, map_source(source), infer_creator(source));
    Ok((store, seeded))
}

fn internal(msg: &str) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": msg })),
    )
        .into_response()
}

fn poisoned() -> Response {
    internal("skill catalogue lock poisoned")
}

async fn get_lifecycle(
    State(skills): State<SkillsLayer>,
    State(learning): State<LearningLayer>,
    Path(name): Path<String>,
) -> Response {
    match lifecycle_or_seed(&skills, &learning, &name).await {
        Ok((_store, row)) => (StatusCode::OK, Json(json!({ "lifecycle": row }))).into_response(),
        Err(r) => r,
    }
}

#[derive(Debug, Deserialize, Default)]
struct ArchiveBody {
    /// Umbrella skill this one was merged into. Empty / absent means a
    /// plain pruning. Recorded verbatim on the lifecycle row.
    #[serde(default)]
    absorbed_into: Option<String>,
}

async fn archive_skill(
    State(skills): State<SkillsLayer>,
    State(learning): State<LearningLayer>,
    Path(name): Path<String>,
    body: Option<Json<ArchiveBody>>,
) -> Response {
    let (store, mut row) = match lifecycle_or_seed(&skills, &learning, &name).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    let absorbed = body.and_then(|Json(b)| b.absorbed_into).filter(|s| !s.is_empty());
    row.state = SkillState::Archived;
    row.archived_at = Some(chrono::Utc::now().to_rfc3339());
    row.absorbed_into = absorbed;
    match store.upsert(row).await {
        Ok(saved) => {
            info!(skill = %name, "skill archived via REST");
            (StatusCode::OK, Json(json!({ "lifecycle": saved }))).into_response()
        }
        Err(e) => internal(&e.to_string()),
    }
}

async fn restore_skill(
    State(skills): State<SkillsLayer>,
    State(learning): State<LearningLayer>,
    Path(name): Path<String>,
) -> Response {
    let (store, mut row) = match lifecycle_or_seed(&skills, &learning, &name).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    row.state = SkillState::Active;
    row.archived_at = None;
    row.absorbed_into = None;
    match store.upsert(row).await {
        Ok(saved) => {
            info!(skill = %name, "skill restored via REST");
            (StatusCode::OK, Json(json!({ "lifecycle": saved }))).into_response()
        }
        Err(e) => internal(&e.to_string()),
    }
}

/// Helper used by the binary at startup: build the canonical roots
/// list `(user_dir, workspace_dir)` honouring the `JARVIS_SKILLS_DIR`
/// override. Returned in load order — workspace shadows user.
pub fn default_roots(
    user_dir: Option<PathBuf>,
    workspace_dir: Option<PathBuf>,
) -> Vec<(PathBuf, SkillSource)> {
    let mut out = Vec::new();
    if let Some(p) = user_dir {
        out.push((p, SkillSource::User));
    }
    if let Some(p) = workspace_dir {
        out.push((p, SkillSource::Workspace));
    }
    out
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    use crate::state::AppState;
    use axum::body::Body;
    use axum::http::Request;
    use harness_core::{Agent, AgentConfig, ChatRequest, ChatResponse, Error, LlmProvider};
    use harness_skill::{SkillCatalog, SkillEntry, SkillManifest};
    use harness_store::MemorySkillLifecycleStore;
    use std::path::PathBuf;
    use std::sync::{Arc, RwLock};
    use tower::ServiceExt;

    struct StubLlm;
    #[async_trait::async_trait]
    impl LlmProvider for StubLlm {
        async fn complete(&self, _: ChatRequest) -> Result<ChatResponse, Error> {
            Err(Error::Provider("stub".into()))
        }
    }

    fn catalog_with(name: &str, source: SkillSource) -> Arc<RwLock<SkillCatalog>> {
        let mut cat = SkillCatalog::default();
        cat.insert(SkillEntry {
            manifest: SkillManifest {
                name: name.into(),
                description: "d".into(),
                license: None,
                allowed_tools: Vec::new(),
                activation: harness_skill::SkillActivation::default(),
                keywords: Vec::new(),
                paths: Vec::new(),
                version: None,
            },
            body: "body".into(),
            path: PathBuf::from("/tmp/skills").join(name).join("SKILL.md"),
            source,
        });
        Arc::new(RwLock::new(cat))
    }

    fn state_with(name: &str, source: SkillSource) -> AppState {
        let agent = Arc::new(Agent::new(
            Arc::new(StubLlm) as Arc<dyn LlmProvider>,
            AgentConfig::new("stub-model"),
        ));
        AppState::new(agent)
            .with_skills(catalog_with(name, source))
            .with_skill_lifecycle_store(Arc::new(MemorySkillLifecycleStore::new()))
    }

    #[tokio::test]
    async fn lifecycle_seeds_active_then_archive_then_restore() {
        let router = crate::routes::router(state_with("rust-debugger", SkillSource::Workspace));

        // GET lifecycle seeds an Active row.
        let req = Request::builder()
            .uri("/v1/skills/rust-debugger/lifecycle")
            .body(Body::empty())
            .unwrap();
        let resp = router.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["lifecycle"]["state"], "active");

        // Archive with absorbed_into.
        let req = Request::builder()
            .method("POST")
            .uri("/v1/skills/rust-debugger/archive")
            .header("content-type", "application/json")
            .body(Body::from(json!({"absorbed_into": "debugging-umbrella"}).to_string()))
            .unwrap();
        let resp = router.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["lifecycle"]["state"], "archived");
        assert_eq!(v["lifecycle"]["absorbed_into"], "debugging-umbrella");
        assert!(v["lifecycle"]["archived_at"].is_string());

        // Restore.
        let req = Request::builder()
            .method("POST")
            .uri("/v1/skills/rust-debugger/restore")
            .body(Body::empty())
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        let v = body_json(resp).await;
        assert_eq!(v["lifecycle"]["state"], "active");
        assert!(v["lifecycle"]["archived_at"].is_null());
    }

    #[tokio::test]
    async fn lifecycle_404_for_unknown_skill() {
        let router = crate::routes::router(state_with("known", SkillSource::User));
        let req = Request::builder()
            .uri("/v1/skills/ghost/lifecycle")
            .body(Body::empty())
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn lifecycle_503_without_store() {
        let agent = Arc::new(Agent::new(
            Arc::new(StubLlm) as Arc<dyn LlmProvider>,
            AgentConfig::new("stub-model"),
        ));
        // Catalog present, but no lifecycle store wired.
        let state = AppState::new(agent).with_skills(catalog_with("k", SkillSource::User));
        let router = crate::routes::router(state);
        let req = Request::builder()
            .uri("/v1/skills/k/lifecycle")
            .body(Body::empty())
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn bundled_skill_infers_bundled_creator() {
        let router = crate::routes::router(state_with("doc", SkillSource::Bundled));
        let req = Request::builder()
            .uri("/v1/skills/doc/lifecycle")
            .body(Body::empty())
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        let v = body_json(resp).await;
        assert_eq!(v["lifecycle"]["created_by"], "bundled");
    }

    async fn body_json(resp: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(resp.into_body(), 8192).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }
}
