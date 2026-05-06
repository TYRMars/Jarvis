//! Late-binding persistent-TODO injection.
//!
//! For every coding turn, the *current* pending / in-progress /
//! blocked TODOs for the active workspace are flattened into a
//! synthetic `=== project todos ===` system message and inserted
//! after the leading System block(s). The agent loop sees them as
//! part of the prompt without needing to call `todo.list`. After
//! the turn finishes, the strip helper removes that exact synthetic
//! message so the canonical persisted history stays clean.
//!
//! Mirrors [`crate::project_binder`] verbatim — same insertion
//! position rules, same idempotent strip, same no-op fall-throughs
//! when the store is missing or no TODOs match. The two binders
//! stack: project block goes in first, then the TODOs block, then
//! the rest of the conversation.
//!
//! Opt out via env var `JARVIS_NO_TODOS_IN_PROMPT` (read in the
//! binary's composition root and threaded through as the
//! `include` argument).

use std::sync::Arc;

use harness_core::{BoxError, Conversation, Message, TodoStatus, TodoStore};
use tracing::warn;

/// Maximum TODO items rendered into the system block. Above this we
/// truncate with a `... and N more` line — the long tail is not
/// useful to the model, and large prompts blow up token budgets.
const MAX_INJECTED_ITEMS: usize = 20;

/// Outcome of [`materialise_todos`]: the prepared conversation plus
/// the index information needed by [`strip_todo_block`].
#[derive(Debug, Clone, Default)]
pub(crate) struct PreparedTodos {
    /// Index where the TODO block was inserted, or `None` when no
    /// injection happened (no store, no matching items, opted out).
    pub injected_at: Option<usize>,
}

/// Inject a `=== project todos ===` block into `conv` containing
/// the `pending` / `in_progress` / `blocked` items for `workspace`.
/// Insertion goes right after the existing leading `System` block(s),
/// which keeps it after any project_binder block from the same
/// turn (the project block gets its slot first, then we land
/// immediately after).
///
/// `workspace` should already be canonicalised by the caller (the
/// REST/WS layer canonicalises via
/// [`harness_core::canonicalize_workspace`]).
pub(crate) async fn materialise_todos(
    todo_store: Option<&Arc<dyn TodoStore>>,
    mut conv: Conversation,
    workspace: Option<&str>,
    include: bool,
) -> Result<(Conversation, PreparedTodos), BoxError> {
    if !include {
        return Ok((conv, PreparedTodos::default()));
    }
    let Some(store) = todo_store else {
        return Ok((conv, PreparedTodos::default()));
    };
    let Some(workspace) = workspace else {
        // No workspace pinned on the current session/server — we
        // can't query. Silent no-op is correct: the model still
        // has access to `todo.list` if it wants to ask.
        return Ok((conv, PreparedTodos::default()));
    };
    let items = match store.list(workspace).await {
        Ok(rows) => rows,
        Err(e) => {
            warn!(error = %e, workspace, "todo binder: list failed; skipping injection");
            return Ok((conv, PreparedTodos::default()));
        }
    };
    let active: Vec<_> = items
        .into_iter()
        .filter(|t| {
            matches!(
                t.status,
                TodoStatus::Pending | TodoStatus::InProgress | TodoStatus::Blocked
            )
        })
        .collect();
    if active.is_empty() {
        return Ok((conv, PreparedTodos::default()));
    }
    let block = format_block(&active);
    let pos = leading_system_count(&conv.messages);
    conv.messages.insert(pos, Message::system(block));
    Ok((
        conv,
        PreparedTodos {
            injected_at: Some(pos),
        },
    ))
}

/// Inverse of [`materialise_todos`] — drop the synthetic block at
/// `prepared.injected_at`. Idempotent / safe: if the message at
/// that index isn't a `System` whose body starts with the sentinel,
/// it's a no-op (so a misbehaving agent rearranging messages
/// doesn't cause the strip to chop the wrong row).
pub(crate) fn strip_todo_block(mut conv: Conversation, prepared: &PreparedTodos) -> Conversation {
    let Some(idx) = prepared.injected_at else {
        return conv;
    };
    if idx >= conv.messages.len() {
        return conv;
    }
    let should_remove = matches!(
        &conv.messages[idx],
        Message::System { content, .. } if content.starts_with("=== project todos ===")
    );
    if should_remove {
        conv.messages.remove(idx);
    }
    conv
}

fn leading_system_count(messages: &[Message]) -> usize {
    messages
        .iter()
        .take_while(|m| matches!(m, Message::System { .. }))
        .count()
}

fn format_block(items: &[harness_core::TodoItem]) -> String {
    let total = items.len();
    let shown = total.min(MAX_INJECTED_ITEMS);
    let mut out = String::with_capacity(96 * shown);
    out.push_str("=== project todos ===\n");
    out.push_str(
        "(Persistent backlog for this workspace — survives across turns, sessions, and restarts. \
         The id at the start of each line is the handle for todo.update / todo.delete. \
         Use todo.add to record NEW follow-ups you discover this turn. \
         Do NOT use plan.update for these — that is the ephemeral, in-turn channel.)\n",
    );
    for item in items.iter().take(shown) {
        let status = item.status.as_wire();
        let priority = match item.priority {
            Some(p) => format!(" ({})", p.as_wire()),
            None => String::new(),
        };
        out.push_str(&format!(
            "- {id}  [{status}]{priority} {title}",
            id = item.id,
            title = item.title,
        ));
        if let Some(notes) = item.notes.as_deref().filter(|n| !n.is_empty()) {
            out.push_str(&format!(" — {notes}"));
        }
        out.push('\n');
    }
    if total > shown {
        out.push_str(&format!(
            "... and {} more (call todo.list for the full list)\n",
            total - shown
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use harness_core::{TodoEvent, TodoItem, TodoStatus};
    use std::collections::HashMap;
    use tokio::sync::{broadcast, RwLock};

    /// Minimal in-memory `TodoStore` for these tests — duplicates the
    /// shape used by `harness-tools::todo::tests` so we don't need a
    /// dev-dep on `harness-store`.
    struct FakeTodoStore {
        inner: RwLock<HashMap<String, TodoItem>>,
        tx: broadcast::Sender<TodoEvent>,
    }
    impl FakeTodoStore {
        fn new() -> Self {
            let (tx, _) = broadcast::channel(8);
            Self {
                inner: RwLock::new(HashMap::new()),
                tx,
            }
        }
        async fn put(&self, item: TodoItem) {
            self.inner.write().await.insert(item.id.clone(), item);
        }
    }
    #[async_trait]
    impl TodoStore for FakeTodoStore {
        async fn list(&self, workspace: &str) -> Result<Vec<TodoItem>, BoxError> {
            Ok(self
                .inner
                .read()
                .await
                .values()
                .filter(|t| t.workspace == workspace)
                .cloned()
                .collect())
        }
        async fn get(&self, id: &str) -> Result<Option<TodoItem>, BoxError> {
            Ok(self.inner.read().await.get(id).cloned())
        }
        async fn upsert(&self, item: &TodoItem) -> Result<(), BoxError> {
            self.inner
                .write()
                .await
                .insert(item.id.clone(), item.clone());
            Ok(())
        }
        async fn delete(&self, id: &str) -> Result<bool, BoxError> {
            Ok(self.inner.write().await.remove(id).is_some())
        }
        fn subscribe(&self) -> broadcast::Receiver<TodoEvent> {
            self.tx.subscribe()
        }
    }

    fn item(workspace: &str, title: &str, status: TodoStatus) -> TodoItem {
        let mut t = TodoItem::new(workspace, title);
        t.status = status;
        t
    }

    #[tokio::test]
    async fn no_store_is_noop() {
        let conv = Conversation::new();
        let (out, p) = materialise_todos(None, conv.clone(), Some("/r"), true)
            .await
            .unwrap();
        assert!(p.injected_at.is_none());
        assert_eq!(out.messages.len(), 0);
    }

    #[tokio::test]
    async fn no_workspace_pinned_is_noop() {
        let store = FakeTodoStore::new();
        let store_arc: Arc<dyn TodoStore> = Arc::new(store);
        let conv = Conversation::new();
        let (out, p) = materialise_todos(Some(&store_arc), conv, None, true)
            .await
            .unwrap();
        assert!(p.injected_at.is_none());
        assert_eq!(out.messages.len(), 0);
    }

    #[tokio::test]
    async fn opt_out_skips_even_with_items() {
        let store = FakeTodoStore::new();
        store.put(item("/r", "x", TodoStatus::Pending)).await;
        let store_arc: Arc<dyn TodoStore> = Arc::new(store);
        let conv = Conversation::new();
        let (out, p) = materialise_todos(Some(&store_arc), conv, Some("/r"), false)
            .await
            .unwrap();
        assert!(p.injected_at.is_none());
        assert_eq!(out.messages.len(), 0);
    }

    #[tokio::test]
    async fn empty_active_set_is_noop() {
        let store = FakeTodoStore::new();
        store.put(item("/r", "done", TodoStatus::Completed)).await;
        store.put(item("/r", "skip", TodoStatus::Cancelled)).await;
        let store_arc: Arc<dyn TodoStore> = Arc::new(store);
        let conv = Conversation::new();
        let (out, p) = materialise_todos(Some(&store_arc), conv, Some("/r"), true)
            .await
            .unwrap();
        assert!(p.injected_at.is_none());
        assert_eq!(out.messages.len(), 0);
    }

    #[tokio::test]
    async fn injects_after_leading_systems_with_filter() {
        let store = FakeTodoStore::new();
        let alive1 = item("/r", "alive-1", TodoStatus::Pending);
        let alive2 = item("/r", "alive-2", TodoStatus::InProgress);
        let alive3 = item("/r", "alive-3", TodoStatus::Blocked);
        let alive_ids = [alive1.id.clone(), alive2.id.clone(), alive3.id.clone()];
        store.put(alive1).await;
        store.put(alive2).await;
        store.put(alive3).await;
        store
            .put(item("/r", "ignore-1", TodoStatus::Completed))
            .await;
        store
            .put(item("/r", "ignore-2", TodoStatus::Cancelled))
            .await;
        store
            .put(item("/other", "wrong-workspace", TodoStatus::Pending))
            .await;
        let store_arc: Arc<dyn TodoStore> = Arc::new(store);

        let mut conv = Conversation::new();
        conv.push(Message::system("base prompt"));
        conv.push(Message::user("hi"));

        let (out, p) = materialise_todos(Some(&store_arc), conv, Some("/r"), true)
            .await
            .unwrap();
        assert_eq!(p.injected_at, Some(1));
        assert_eq!(out.messages.len(), 3);
        match &out.messages[1] {
            Message::System { content, .. } => {
                assert!(content.starts_with("=== project todos ==="));
                assert!(content.contains("alive-1"));
                assert!(content.contains("alive-2"));
                assert!(content.contains("alive-3"));
                assert!(!content.contains("ignore-"));
                assert!(!content.contains("wrong-workspace"));
                for id in &alive_ids {
                    assert!(
                        content.contains(id),
                        "expected injected block to contain id {id}, got:\n{content}"
                    );
                }
            }
            other => panic!("expected injected System, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn truncates_at_cap_with_more_marker() {
        let store = FakeTodoStore::new();
        for i in 0..(MAX_INJECTED_ITEMS + 5) {
            store
                .put(item("/r", &format!("t{i}"), TodoStatus::Pending))
                .await;
        }
        let store_arc: Arc<dyn TodoStore> = Arc::new(store);
        let conv = Conversation::new();
        let (out, p) = materialise_todos(Some(&store_arc), conv, Some("/r"), true)
            .await
            .unwrap();
        assert!(p.injected_at.is_some());
        match &out.messages[0] {
            Message::System { content, .. } => {
                assert!(content.contains("... and 5 more"));
            }
            _ => panic!(),
        }
    }

    #[test]
    fn strip_removes_injected_block() {
        let mut conv = Conversation::new();
        conv.push(Message::system("base"));
        conv.push(Message::system("=== project todos ===\nbody"));
        conv.push(Message::user("hi"));
        let prepared = PreparedTodos {
            injected_at: Some(1),
        };
        let stripped = strip_todo_block(conv, &prepared);
        assert_eq!(stripped.messages.len(), 2);
        assert!(matches!(stripped.messages[0], Message::System { .. }));
        assert!(matches!(stripped.messages[1], Message::User { .. }));
    }

    #[test]
    fn strip_is_noop_when_index_is_none() {
        let mut conv = Conversation::new();
        conv.push(Message::user("hi"));
        let stripped = strip_todo_block(conv, &PreparedTodos::default());
        assert_eq!(stripped.messages.len(), 1);
    }

    #[test]
    fn strip_is_noop_when_index_no_longer_points_at_a_system() {
        let mut conv = Conversation::new();
        conv.push(Message::user("hi"));
        let prepared = PreparedTodos {
            injected_at: Some(0),
        };
        let stripped = strip_todo_block(conv, &prepared);
        assert_eq!(stripped.messages.len(), 1);
    }
}
