//! On-disk permission store.
//!
//! Three scopes, two on-disk:
//!
//! | Scope | Where | Persistence |
//! |---|---|---|
//! | `User` | `~/.config/jarvis/permissions.json` | JSON file |
//! | `Project` | `<workspace_root>/.jarvis/permissions.json` | JSON file (committed) |
//! | `Session` | in-memory | dies with the process |
//!
//! All mutations go through a single [`tokio::sync::Mutex`] so two
//! simultaneous "Always allow" clicks from different sockets don't
//! lose each other's writes. The merged in-memory snapshot is kept
//! behind an `Arc<RwLock<PermissionTable>>` so the agent loop's
//! per-tool-call evaluation is a cheap read-lock + clone.
//!
//! After every mutation a single-shot `broadcast` notification fans
//! out to listeners — typically the WS handler that emits
//! `AgentEvent::PermissionRulesChanged` so live UIs refetch.
//!
//! ## On-disk shape
//!
//! ```json
//! {
//!   "default_mode": "ask",
//!   "deny":  [{ "tool": "shell.exec", "matchers": { "/command": "rm -rf *" } }],
//!   "ask":   [],
//!   "allow": [{ "tool": "fs.edit" }]
//! }
//! ```
//!
//! The on-disk shape is per-scope. The merged in-memory
//! `PermissionTable` (returned by `snapshot`) tags each rule with the
//! scope it came from via [`harness_core::ScopedRule`].

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use harness_core::permission::{
    Decision, PermissionMode, PermissionRule, PermissionStore, PermissionTable, Scope, ScopedRule,
};
use harness_core::BoxError;
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, Mutex, RwLock};

use crate::error::StoreError;

/// On-disk shape per scope. Same fields as `PermissionTable` but the
/// rules are unscoped (the scope is implicit in the file).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct OnDiskScope {
    #[serde(default)]
    default_mode: Option<PermissionMode>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    deny: Vec<PermissionRule>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    ask: Vec<PermissionRule>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    allow: Vec<PermissionRule>,
}

pub struct JsonFilePermissionStore {
    user_path: Option<PathBuf>,
    project_path: Option<PathBuf>,
    /// Per-scope state cache. Held behind a single mutex so two
    /// `append_rule` calls can't lose each other's writes.
    state: Mutex<ScopeState>,
    /// Read-side cache for the merged table (the hot path).
    snapshot: Arc<RwLock<PermissionTable>>,
    /// Single-shot fanout on every mutation.
    changed_tx: broadcast::Sender<()>,
}

struct ScopeState {
    user: OnDiskScope,
    project: OnDiskScope,
    session: OnDiskScope,
}

impl JsonFilePermissionStore {
    /// Open the store. Both paths are optional — a `None` scope is
    /// treated as empty (writes to that scope error). Tests pass
    /// `None`/`None` and rely on the `Session` scope only.
    pub async fn open(
        user_path: Option<PathBuf>,
        project_path: Option<PathBuf>,
    ) -> Result<Self, StoreError> {
        let user = match user_path.as_deref() {
            Some(p) => load_or_default(p).await?,
            None => OnDiskScope::default(),
        };
        let project = match project_path.as_deref() {
            Some(p) => load_or_default(p).await?,
            None => OnDiskScope::default(),
        };
        let state = ScopeState {
            user,
            project,
            session: OnDiskScope::default(),
        };
        let snapshot = Arc::new(RwLock::new(merge(&state)));
        let (changed_tx, _) = broadcast::channel(16);
        Ok(Self {
            user_path,
            project_path,
            state: Mutex::new(state),
            snapshot,
            changed_tx,
        })
    }

    fn path_for(&self, scope: Scope) -> Option<&PathBuf> {
        match scope {
            Scope::User => self.user_path.as_ref(),
            Scope::Project => self.project_path.as_ref(),
            Scope::Session => None,
        }
    }

    async fn refresh_snapshot(&self) {
        let state = self.state.lock().await;
        let table = merge(&state);
        let mut w = self.snapshot.write().await;
        *w = table;
    }
}

#[async_trait]
impl PermissionStore for JsonFilePermissionStore {
    async fn snapshot(&self) -> PermissionTable {
        self.snapshot.read().await.clone()
    }

    async fn append_rule(
        &self,
        scope: Scope,
        bucket: Decision,
        rule: PermissionRule,
    ) -> Result<(), BoxError> {
        {
            let mut state = self.state.lock().await;
            let target = mut_scope(&mut state, scope);
            bucket_mut(target, bucket).push(rule);
            // Persist if disk-backed.
            if let Some(path) = self.path_for(scope) {
                save(path, target).await.map_err(boxed)?;
            }
        }
        self.refresh_snapshot().await;
        let _ = self.changed_tx.send(());
        Ok(())
    }

    async fn delete_rule(
        &self,
        scope: Scope,
        bucket: Decision,
        index: usize,
    ) -> Result<(), BoxError> {
        {
            let mut state = self.state.lock().await;
            let target = mut_scope(&mut state, scope);
            let bucket_vec = bucket_mut(target, bucket);
            if index >= bucket_vec.len() {
                return Err(format!(
                    "delete_rule index {index} out of bounds (have {})",
                    bucket_vec.len()
                )
                .into());
            }
            bucket_vec.remove(index);
            if let Some(path) = self.path_for(scope) {
                save(path, target).await.map_err(boxed)?;
            }
        }
        self.refresh_snapshot().await;
        let _ = self.changed_tx.send(());
        Ok(())
    }

    async fn set_default_mode(
        &self,
        scope: Scope,
        mode: PermissionMode,
    ) -> Result<(), BoxError> {
        {
            let mut state = self.state.lock().await;
            let target = mut_scope(&mut state, scope);
            target.default_mode = Some(mode);
            if let Some(path) = self.path_for(scope) {
                save(path, target).await.map_err(boxed)?;
            }
        }
        self.refresh_snapshot().await;
        let _ = self.changed_tx.send(());
        Ok(())
    }

    fn subscribe(&self) -> broadcast::Receiver<()> {
        self.changed_tx.subscribe()
    }
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

fn mut_scope(state: &mut ScopeState, scope: Scope) -> &mut OnDiskScope {
    match scope {
        Scope::User => &mut state.user,
        Scope::Project => &mut state.project,
        Scope::Session => &mut state.session,
    }
}

fn bucket_mut(scope: &mut OnDiskScope, bucket: Decision) -> &mut Vec<PermissionRule> {
    match bucket {
        Decision::Deny => &mut scope.deny,
        Decision::Ask => &mut scope.ask,
        Decision::Allow => &mut scope.allow,
    }
}

/// Merge user → project → session into one `PermissionTable`.
/// Default mode picks the highest-priority scope that has one set
/// (`User > Project > Session`). Each rule keeps its scope tag in
/// `ScopedRule` so the rule engine can cite which file it came from.
fn merge(state: &ScopeState) -> PermissionTable {
    let default_mode = state
        .user
        .default_mode
        .or(state.project.default_mode)
        .or(state.session.default_mode)
        .unwrap_or_default();

    let mut table = PermissionTable {
        default_mode,
        deny: Vec::new(),
        ask: Vec::new(),
        allow: Vec::new(),
    };

    // User rules first, then project, then session — within each
    // bucket the first match wins, so user rules effectively win.
    for (scope, rules) in [
        (Scope::User, &state.user.deny),
        (Scope::Project, &state.project.deny),
        (Scope::Session, &state.session.deny),
    ] {
        for rule in rules {
            table.deny.push(ScopedRule {
                scope,
                rule: rule.clone(),
            });
        }
    }
    for (scope, rules) in [
        (Scope::User, &state.user.ask),
        (Scope::Project, &state.project.ask),
        (Scope::Session, &state.session.ask),
    ] {
        for rule in rules {
            table.ask.push(ScopedRule {
                scope,
                rule: rule.clone(),
            });
        }
    }
    for (scope, rules) in [
        (Scope::User, &state.user.allow),
        (Scope::Project, &state.project.allow),
        (Scope::Session, &state.session.allow),
    ] {
        for rule in rules {
            table.allow.push(ScopedRule {
                scope,
                rule: rule.clone(),
            });
        }
    }
    table
}

async fn load_or_default(path: &std::path::Path) -> Result<OnDiskScope, StoreError> {
    match tokio::fs::read(path).await {
        Ok(bytes) => serde_json::from_slice::<OnDiskScope>(&bytes).map_err(StoreError::from),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(OnDiskScope::default()),
        Err(e) => Err(StoreError::Other(Box::new(e))),
    }
}

async fn save(path: &std::path::Path, scope: &OnDiskScope) -> Result<(), StoreError> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| StoreError::Other(format!("create {}: {e}", parent.display()).into()))?;
    }
    let bytes = serde_json::to_vec_pretty(scope).map_err(StoreError::from)?;
    let tmp = path.with_extension("json.tmp");
    tokio::fs::write(&tmp, &bytes)
        .await
        .map_err(|e| StoreError::Other(Box::new(e)))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perm = std::fs::Permissions::from_mode(0o600);
        let _ = tokio::fs::set_permissions(&tmp, perm).await;
    }
    tokio::fs::rename(&tmp, path)
        .await
        .map_err(|e| StoreError::Other(Box::new(e)))?;
    Ok(())
}

fn boxed(e: StoreError) -> BoxError {
    Box::new(e)
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_core::permission::PermissionRule;
    use tempfile::tempdir;

    fn rule(tool: &str) -> PermissionRule {
        PermissionRule::whole_tool(tool)
    }

    #[tokio::test]
    async fn session_scope_works_without_disk() {
        let s = JsonFilePermissionStore::open(None, None).await.unwrap();
        s.append_rule(Scope::Session, Decision::Allow, rule("fs.edit"))
            .await
            .unwrap();
        let snap = s.snapshot().await;
        assert_eq!(snap.allow.len(), 1);
        assert_eq!(snap.allow[0].scope, Scope::Session);
        assert_eq!(snap.allow[0].rule.tool, "fs.edit");
    }

    #[tokio::test]
    async fn user_scope_persists_to_disk() {
        let dir = tempdir().unwrap();
        let user = dir.path().join("user.json");
        {
            let s = JsonFilePermissionStore::open(Some(user.clone()), None)
                .await
                .unwrap();
            s.append_rule(Scope::User, Decision::Allow, rule("fs.edit"))
                .await
                .unwrap();
        }
        // Reopen — rule must round-trip.
        let s = JsonFilePermissionStore::open(Some(user.clone()), None)
            .await
            .unwrap();
        let snap = s.snapshot().await;
        assert_eq!(snap.allow.len(), 1);
        assert_eq!(snap.allow[0].scope, Scope::User);
    }

    #[tokio::test]
    async fn delete_removes_by_index() {
        let s = JsonFilePermissionStore::open(None, None).await.unwrap();
        s.append_rule(Scope::Session, Decision::Allow, rule("a"))
            .await
            .unwrap();
        s.append_rule(Scope::Session, Decision::Allow, rule("b"))
            .await
            .unwrap();
        s.delete_rule(Scope::Session, Decision::Allow, 0)
            .await
            .unwrap();
        let snap = s.snapshot().await;
        assert_eq!(snap.allow.len(), 1);
        assert_eq!(snap.allow[0].rule.tool, "b");
    }

    #[tokio::test]
    async fn set_default_mode_applies_priority() {
        let dir = tempdir().unwrap();
        let user = dir.path().join("u.json");
        let project = dir.path().join("p.json");
        let s = JsonFilePermissionStore::open(Some(user), Some(project))
            .await
            .unwrap();

        // Project sets accept-edits; user is unset → table = accept-edits
        s.set_default_mode(Scope::Project, PermissionMode::AcceptEdits)
            .await
            .unwrap();
        assert_eq!(s.snapshot().await.default_mode, PermissionMode::AcceptEdits);

        // User overrides with auto → table = auto
        s.set_default_mode(Scope::User, PermissionMode::Auto)
            .await
            .unwrap();
        assert_eq!(s.snapshot().await.default_mode, PermissionMode::Auto);
    }

    #[tokio::test]
    async fn subscribe_fires_on_mutation() {
        let s = JsonFilePermissionStore::open(None, None).await.unwrap();
        let mut rx = s.subscribe();
        s.append_rule(Scope::Session, Decision::Allow, rule("x"))
            .await
            .unwrap();
        // Should have a notification waiting.
        assert!(rx.try_recv().is_ok());
    }

    #[tokio::test]
    async fn merge_orders_user_first_within_bucket() {
        let dir = tempdir().unwrap();
        let user = dir.path().join("u.json");
        let project = dir.path().join("p.json");
        let s = JsonFilePermissionStore::open(Some(user), Some(project))
            .await
            .unwrap();
        s.append_rule(Scope::Project, Decision::Allow, rule("from-project"))
            .await
            .unwrap();
        s.append_rule(Scope::User, Decision::Allow, rule("from-user"))
            .await
            .unwrap();
        let snap = s.snapshot().await;
        assert_eq!(snap.allow[0].scope, Scope::User);
        assert_eq!(snap.allow[0].rule.tool, "from-user");
        assert_eq!(snap.allow[1].scope, Scope::Project);
    }

    #[tokio::test]
    async fn concurrent_appends_dont_lose_writes() {
        let s = Arc::new(JsonFilePermissionStore::open(None, None).await.unwrap());
        let mut handles = Vec::new();
        for i in 0..16 {
            let s = s.clone();
            handles.push(tokio::spawn(async move {
                s.append_rule(
                    Scope::Session,
                    Decision::Allow,
                    rule(&format!("tool-{i}")),
                )
                .await
                .unwrap();
            }));
        }
        for h in handles {
            h.await.unwrap();
        }
        let snap = s.snapshot().await;
        assert_eq!(snap.allow.len(), 16);
    }
}
