//! Fire-and-forget skill-usage telemetry emitter.
//!
//! The agent loop is hot — every WS turn calls
//! [`merged_skills_for_turn`](crate::routes) and we don't want a disk
//! round-trip blocking the response. This module owns the seam: callers
//! build a small `Vec<SkillUsageEvent>` from the catalog (sync, cheap) and
//! hand it to [`spawn_record`], which fires a detached `tokio::spawn` that
//! flushes the events to the configured [`SkillUsageStore`].
//!
//! Failures degrade silently — a flaky learning store must never break the
//! agent's user-visible turn. We log at WARN so operators see the drop in
//! `/v1/learning/skill-usage` traffic against expected activations.
//!
//! Phase 0 of `docs/proposals/self-improving-agent.zh-CN.md`.

use std::sync::{Arc, RwLock};

use harness_learning::{
    MemoryFilter, MemoryItem, MemoryScope, MemoryStore, SkillScope, SkillSource,
    SkillUsageAction, SkillUsageEvent, SkillUsageStore,
};
use harness_skill::SkillCatalog;
use tracing::warn;

/// Translate the catalog's own `SkillSource` (which is a `Copy`-able
/// enum with kebab-case serde and no `Other` variant) into the
/// `harness-learning` wire enum.
pub fn map_source(src: harness_skill::SkillSource) -> SkillSource {
    match src {
        harness_skill::SkillSource::Bundled => SkillSource::Bundled,
        harness_skill::SkillSource::User => SkillSource::User,
        harness_skill::SkillSource::Workspace => SkillSource::Workspace,
        harness_skill::SkillSource::Plugin => SkillSource::Plugin,
    }
}

/// Pick the scope for an emit. When the agent is bound to a workspace
/// path, the workspace scope is more useful (it lets the UI distinguish
/// "this user's Rust skill is hot across all projects" from "the rust
/// skill is hot in this one repo"). Falls back to user-scope.
pub fn workspace_scope(workspace: Option<&std::path::Path>) -> SkillScope {
    match workspace.and_then(|p| p.to_str()) {
        Some(s) => SkillScope::workspace(s),
        None => SkillScope::user(),
    }
}

/// Build a `Used` event per name. Names that don't resolve in the
/// catalog are skipped (catalog drift between turn-build and emit-time
/// is rare but possible; better to drop than to fabricate a source).
///
/// Sync + pure: easy to test without standing up tokio.
pub fn build_used_events(
    catalog: Option<&Arc<RwLock<SkillCatalog>>>,
    names: &[String],
    scope: SkillScope,
    conversation_id: Option<String>,
) -> Vec<SkillUsageEvent> {
    let Some(cat_arc) = catalog else {
        return Vec::new();
    };
    let Ok(guard) = cat_arc.read() else {
        return Vec::new();
    };
    names
        .iter()
        .filter_map(|name| {
            let entry = guard.get(name)?;
            Some(SkillUsageEvent {
                id: String::new(),
                skill_name: name.clone(),
                source: map_source(entry.source),
                action: SkillUsageAction::Used,
                scope: scope.clone(),
                conversation_id: conversation_id.clone(),
                requirement_id: None,
                run_id: None,
                created_at: String::new(),
                attributes: serde_json::Value::Null,
            })
        })
        .collect()
}

/// Build a single `Viewed` event by name. Returns `None` when the
/// catalog doesn't know the skill so the caller can decide whether to
/// log or just drop.
pub fn build_viewed_event(
    catalog: Option<&Arc<RwLock<SkillCatalog>>>,
    name: &str,
    scope: SkillScope,
    conversation_id: Option<String>,
) -> Option<SkillUsageEvent> {
    let cat_arc = catalog?;
    let guard = cat_arc.read().ok()?;
    let entry = guard.get(name)?;
    Some(SkillUsageEvent {
        id: String::new(),
        skill_name: name.to_string(),
        source: map_source(entry.source),
        action: SkillUsageAction::Viewed,
        scope,
        conversation_id,
        requirement_id: None,
        run_id: None,
        created_at: String::new(),
        attributes: serde_json::Value::Null,
    })
}

/// Async flush. Public so call sites that already own a runtime context
/// can `await` it directly (e.g. in tests) instead of going through
/// [`spawn_record`].
pub async fn record_events(store: Arc<dyn SkillUsageStore>, events: Vec<SkillUsageEvent>) {
    for ev in events {
        let name = ev.skill_name.clone();
        if let Err(e) = store.record_event(ev).await {
            warn!(skill = %name, error = %e, "skill usage emit failed");
        }
    }
}

/// Fire-and-forget wrapper used from the agent loop / WS handlers. No-op
/// when `store` is `None` (the learning store is optional) or when
/// `events` is empty (the common no-skill turn).
pub fn spawn_record(store: Option<Arc<dyn SkillUsageStore>>, events: Vec<SkillUsageEvent>) {
    let Some(store) = store else { return };
    if events.is_empty() {
        return;
    }
    tokio::spawn(async move {
        record_events(store, events).await;
    });
}

// =========================================================================
// User Memory prompt-context fetch
// =========================================================================

/// Hard cap on the byte size of the User-Memory block we inject into the
/// system prompt. Matches one full `MemoryItem::BODY_CAP` plus a little
/// header overhead — typical rows are ≪ this, so 3–5 short preferences
/// will usually all fit before we start dropping. Operators who want a
/// larger budget can override at a follow-up config-block stage; we
/// pick a conservative default to keep system-prompt overhead bounded.
pub const USER_MEMORY_PROMPT_CAP: usize = 2048;

/// Fetch user-scope memories for prompt injection. Pinned-first +
/// recent-first (the store already orders this way), capped at
/// [`USER_MEMORY_PROMPT_CAP`] bytes total across `title + body` lengths.
///
/// Returns an empty Vec when the store is `None` so callers can blindly
/// call this without guarding the option. Failures are logged at WARN
/// and produce an empty Vec — the agent loop must never break because
/// the memory store is flaky.
pub async fn fetch_user_memories_for_prompt(
    store: Option<&Arc<dyn MemoryStore>>,
) -> Vec<MemoryItem> {
    let Some(store) = store else { return Vec::new() };
    let filter = MemoryFilter {
        scope: Some(MemoryScope::User),
        // 50 keeps the query cheap; the cap below enforces the real
        // byte budget. Even at the max we'd pull at most a couple
        // hundred KiB of rows — well within reason for a single
        // turn's prep work.
        limit: Some(50),
        ..Default::default()
    };
    let all = match store.list(filter).await {
        Ok(rows) => rows,
        Err(e) => {
            warn!(error = %e, "user memory fetch for prompt failed; injecting empty block");
            return Vec::new();
        }
    };
    take_until_byte_cap(all, USER_MEMORY_PROMPT_CAP)
}

/// Walk `items` in order and take rows until the total byte size of
/// `title + body` exceeds `cap`. Always returns at least the first row
/// even if it alone exceeds `cap` (so a single big pinned memory still
/// lands) — the caller can render with truncation if needed.
fn take_until_byte_cap(items: Vec<MemoryItem>, cap: usize) -> Vec<MemoryItem> {
    let mut total = 0usize;
    let mut out = Vec::new();
    for item in items {
        let cost = item.title.len() + item.body.len();
        if !out.is_empty() && total.saturating_add(cost) > cap {
            break;
        }
        total = total.saturating_add(cost);
        out.push(item);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_skill::{SkillCatalog, SkillEntry, SkillManifest};
    use harness_store::MemorySkillUsageStore;
    use std::path::PathBuf;

    fn catalog_with(name: &str) -> Arc<RwLock<SkillCatalog>> {
        let mut cat = SkillCatalog::default();
        let manifest = SkillManifest {
            name: name.into(),
            description: "test skill".into(),
            license: None,
            allowed_tools: Vec::new(),
            activation: harness_skill::SkillActivation::default(),
            keywords: Vec::new(),
            paths: Vec::new(),
            version: None,
        };
        let entry = SkillEntry {
            manifest,
            body: "body".into(),
            path: PathBuf::from("/tmp/skills").join(name).join("SKILL.md"),
            source: harness_skill::SkillSource::User,
        };
        cat.insert(entry);
        Arc::new(RwLock::new(cat))
    }

    #[test]
    fn build_used_events_drops_unknown_names() {
        let cat = catalog_with("rust-debugger");
        let events = build_used_events(
            Some(&cat),
            &["rust-debugger".into(), "ghost-skill".into()],
            SkillScope::user(),
            Some("conv-1".into()),
        );
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].skill_name, "rust-debugger");
        assert_eq!(events[0].action, SkillUsageAction::Used);
        assert_eq!(events[0].source, SkillSource::User);
        assert_eq!(events[0].conversation_id.as_deref(), Some("conv-1"));
    }

    #[test]
    fn build_used_events_no_catalog_is_empty() {
        let events = build_used_events(None, &["x".into()], SkillScope::user(), None);
        assert!(events.is_empty());
    }

    #[test]
    fn build_viewed_event_resolves_source() {
        let cat = catalog_with("k");
        let ev = build_viewed_event(Some(&cat), "k", SkillScope::user(), None).unwrap();
        assert_eq!(ev.action, SkillUsageAction::Viewed);
        assert_eq!(ev.source, SkillSource::User);
    }

    #[test]
    fn workspace_scope_picks_workspace_when_path_set() {
        let scope = workspace_scope(Some(std::path::Path::new("/tmp/ws")));
        match scope {
            SkillScope::Workspace { workspace } => assert_eq!(workspace, "/tmp/ws"),
            _ => panic!("expected Workspace scope"),
        }
    }

    #[test]
    fn workspace_scope_falls_back_to_user() {
        assert!(matches!(workspace_scope(None), SkillScope::User));
    }

    #[tokio::test]
    async fn record_events_writes_each_to_store() {
        let store: Arc<dyn SkillUsageStore> = Arc::new(MemorySkillUsageStore::new());
        let events = vec![
            SkillUsageEvent {
                id: String::new(),
                skill_name: "a".into(),
                source: SkillSource::User,
                action: SkillUsageAction::Used,
                scope: SkillScope::user(),
                conversation_id: None,
                requirement_id: None,
                run_id: None,
                created_at: String::new(),
                attributes: serde_json::Value::Null,
            },
            SkillUsageEvent {
                id: String::new(),
                skill_name: "b".into(),
                source: SkillSource::User,
                action: SkillUsageAction::Used,
                scope: SkillScope::user(),
                conversation_id: None,
                requirement_id: None,
                run_id: None,
                created_at: String::new(),
                attributes: serde_json::Value::Null,
            },
        ];
        record_events(store.clone(), events).await;
        let listed = store
            .list_events(harness_learning::SkillUsageFilter::default())
            .await
            .unwrap();
        assert_eq!(listed.len(), 2);
    }

    #[test]
    fn spawn_record_no_op_when_store_is_none() {
        // Should not panic / require a runtime.
        spawn_record(None, Vec::new());
    }

    // ---- user memory fetch -----------------------------------------------

    fn mem(title: &str, body: &str) -> MemoryItem {
        MemoryItem::new(MemoryScope::user(), harness_learning::MemoryKind::Fact, title, body)
    }

    #[test]
    fn take_until_byte_cap_respects_cap_after_first() {
        let items = vec![
            mem("a", &"x".repeat(100)),
            mem("b", &"y".repeat(100)),
            mem("c", &"z".repeat(100)),
        ];
        let kept = take_until_byte_cap(items, 250);
        // First (~101B) + second (~101B) = ~202B; third would push over.
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[0].title, "a");
        assert_eq!(kept[1].title, "b");
    }

    #[test]
    fn take_until_byte_cap_always_returns_first() {
        let items = vec![mem("alone", &"x".repeat(10_000))];
        let kept = take_until_byte_cap(items, 10);
        // Even though one row exceeds the cap, we keep it so the agent
        // still sees the user's most important pinned fact.
        assert_eq!(kept.len(), 1);
    }

    #[tokio::test]
    async fn fetch_returns_empty_when_store_is_none() {
        let v = fetch_user_memories_for_prompt(None).await;
        assert!(v.is_empty());
    }

    #[tokio::test]
    async fn fetch_returns_recorded_user_memories() {
        let store: Arc<dyn MemoryStore> =
            Arc::new(harness_store::MemoryMemoryStore::new());
        store.upsert(mem("zh-CN", "reply in zh-CN")).await.unwrap();
        let pinned = mem("be terse", "max 3 sentences");
        let mut pinned = pinned;
        pinned.pinned = true;
        store.upsert(pinned).await.unwrap();
        let v = fetch_user_memories_for_prompt(Some(&store)).await;
        assert_eq!(v.len(), 2);
        // Pinned comes first per the store's sort.
        assert!(v[0].pinned);
    }
}
