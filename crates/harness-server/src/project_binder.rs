//! Late-binding [`Project`](harness_core::Project) injection.
//!
//! For every turn of every project-bound conversation we want the
//! project's current `instructions` to reach the LLM as part of the
//! system prompt — *without* ever persisting that string into the
//! conversation. That way editing a project propagates immediately to
//! every existing conversation that references it (the headline
//! "live binding" property of the feature).
//!
//! Mechanics:
//!
//! 1. **Before** dispatching to the agent: [`materialise`] loads the
//!    project from the store and inserts a synthetic
//!    `=== project: <name> ===\n<instructions>` system message into
//!    the conversation right after any existing leading `System`
//!    blocks. The returned [`PreparedConversation`] records the
//!    insertion index.
//! 2. **After** the agent finishes: [`strip_project_block`] removes
//!    that exact synthetic message from the conversation that came
//!    back on `AgentEvent::Done`, leaving the canonical history clean.
//!    Saving the stripped conversation is what makes the binding live.
//!
//! The injection is at insertion-index `L` where `L` is the count of
//! leading `System` messages **before** injection. So the final
//! ordering is `[<base systems>, <project block>, <rest of conv>]`.
//! This satisfies two constraints:
//!
//! - The agent's own `ensure_system_prompt` (which only fires when
//!   the conversation has no leading `System`) sees the existing base
//!   system and stays out of the way.
//! - Memory backends ([`SlidingWindowMemory`] / [`SummarizingMemory`])
//!   keep all leading systems intact during compaction, so the
//!   project block survives summarisation untouched.
//!
//! When `project_id` is `None`, when the project store isn't wired up,
//! or when the referenced project is missing / archived, the binder is
//! a pure no-op: same conversation goes in and out, `injected_at`
//! stays `None`, the `strip_project_block` call does nothing.

use std::sync::Arc;

use harness_core::{BoxError, Conversation, Message, ProjectStore};
use tracing::warn;

/// Outcome of [`materialise`]: the prepared conversation plus the
/// information needed by [`strip_project_block`] to undo the
/// injection on the way out.
#[derive(Debug, Clone)]
pub(crate) struct PreparedConversation {
    pub conversation: Conversation,
    /// Index where the project block was inserted, or `None` when no
    /// injection happened (no project bound, store missing, project
    /// archived/deleted).
    pub injected_at: Option<usize>,
}

/// Inject a project's instructions as a synthetic `System` message
/// into `conv`. Position: right after any leading `System` messages.
///
/// Returns a [`PreparedConversation`] holding the modified
/// conversation plus the index that was inserted at; pair the result
/// with [`strip_project_block`] to remove the injected message before
/// persisting the agent's output.
pub(crate) async fn materialise(
    project_store: Option<&Arc<dyn ProjectStore>>,
    conv: Conversation,
    project_id: Option<&str>,
) -> Result<PreparedConversation, BoxError> {
    let Some(pid) = project_id else {
        return Ok(PreparedConversation {
            conversation: conv,
            injected_at: None,
        });
    };
    let Some(store) = project_store else {
        // Bound to a project but no store wired up — surface a warning
        // and fall through. The conversation is still usable.
        warn!(
            project_id = pid,
            "conversation references a project but no project store is configured"
        );
        return Ok(PreparedConversation {
            conversation: conv,
            injected_at: None,
        });
    };
    let project = match store.load(pid).await? {
        Some(p) if !p.archived => p,
        Some(_) => {
            warn!(project_id = pid, "bound project is archived; skipping injection");
            return Ok(PreparedConversation {
                conversation: conv,
                injected_at: None,
            });
        }
        None => {
            warn!(project_id = pid, "bound project no longer exists; skipping injection");
            return Ok(PreparedConversation {
                conversation: conv,
                injected_at: None,
            });
        }
    };
    let block = render_project_block(&project);
    let mut messages = conv.messages;
    let pos = leading_system_count(&messages);
    messages.insert(pos, Message::system(block));
    Ok(PreparedConversation {
        conversation: Conversation {
            messages,
            ..Default::default()
        },
        injected_at: Some(pos),
    })
}

/// Inverse of [`materialise`] — drop the synthetic project block at
/// `prepared.injected_at` from a conversation. Idempotent / safe if
/// the message at that index isn't a `System` (e.g. the agent
/// somehow rearranged things), in which case it's a no-op.
pub(crate) fn strip_project_block(
    mut conv: Conversation,
    prepared: &PreparedConversation,
) -> Conversation {
    let Some(idx) = prepared.injected_at else {
        return conv;
    };
    if idx >= conv.messages.len() {
        return conv;
    }
    if !matches!(&conv.messages[idx], Message::System { .. }) {
        return conv;
    }
    conv.messages.remove(idx);
    conv
}

fn leading_system_count(messages: &[Message]) -> usize {
    messages
        .iter()
        .take_while(|m| matches!(m, Message::System { .. }))
        .count()
}

/// Render the per-turn project context block. Includes the structured
/// metadata the agent needs to ground its answers — name, slug,
/// optional one-line description, the workspace folder list, and the
/// project's free-form `instructions` body. Without this enrichment
/// the agent only saw the user-authored `instructions` string and had
/// to discover everything else (slug, folders, branch) via tool calls.
///
/// Stable, fence-shaped header (`=== project: ... ===`) so
/// [`strip_project_block`] can find the injected message via the
/// `injected_at` index without parsing the body. The trailing
/// `=== /project ===` close marker isn't required for stripping but
/// reads more naturally as a delimited block.
fn render_project_block(project: &harness_core::Project) -> String {
    let mut out = String::with_capacity(256);
    out.push_str("=== project: ");
    out.push_str(&project.name);
    if !project.slug.is_empty() {
        out.push_str(" (");
        out.push_str(&project.slug);
        out.push(')');
    }
    out.push_str(" ===\n");
    if let Some(desc) = project.description.as_deref() {
        let trimmed = desc.trim();
        if !trimmed.is_empty() {
            out.push_str(trimmed);
            out.push('\n');
        }
    }
    if !project.workspaces.is_empty() {
        out.push_str("\nWorkspaces:\n");
        for ws in &project.workspaces {
            out.push_str("- ");
            if let Some(name) = ws.name.as_deref() {
                let n = name.trim();
                if !n.is_empty() {
                    out.push_str(n);
                    out.push_str(" — ");
                }
            }
            out.push_str(&ws.path);
            out.push('\n');
        }
    }
    let instr = project.instructions.trim();
    if !instr.is_empty() {
        out.push_str("\nInstructions:\n");
        out.push_str(instr);
        out.push('\n');
    }
    out.push_str("=== /project ===");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use harness_core::{BoxError, Project};
    use std::collections::HashMap;
    use tokio::sync::RwLock;

    #[derive(Default)]
    struct FakeProjectStore {
        inner: RwLock<HashMap<String, Project>>,
    }

    impl FakeProjectStore {
        async fn put(&self, p: Project) {
            self.inner.write().await.insert(p.id.clone(), p);
        }
    }

    #[async_trait]
    impl ProjectStore for FakeProjectStore {
        async fn save(&self, project: &Project) -> Result<(), BoxError> {
            self.inner
                .write()
                .await
                .insert(project.id.clone(), project.clone());
            Ok(())
        }
        async fn load(&self, id: &str) -> Result<Option<Project>, BoxError> {
            Ok(self.inner.read().await.get(id).cloned())
        }
        async fn find_by_slug(&self, _slug: &str) -> Result<Option<Project>, BoxError> {
            Ok(None)
        }
        async fn list(&self, _: bool, _: u32) -> Result<Vec<Project>, BoxError> {
            Ok(Vec::new())
        }
        async fn delete(&self, _: &str) -> Result<bool, BoxError> {
            Ok(false)
        }
        async fn archive(&self, id: &str) -> Result<bool, BoxError> {
            if let Some(p) = self.inner.write().await.get_mut(id) {
                p.archive();
                return Ok(true);
            }
            Ok(false)
        }
    }

    #[tokio::test]
    async fn no_project_id_is_noop() {
        let conv = Conversation::new();
        let out = materialise(None, conv.clone(), None).await.unwrap();
        assert!(out.injected_at.is_none());
        assert_eq!(out.conversation.messages.len(), 0);
    }

    #[tokio::test]
    async fn missing_store_warns_and_passes_through() {
        let conv = Conversation::new();
        let out = materialise(None, conv, Some("p-x")).await.unwrap();
        assert!(out.injected_at.is_none());
    }

    #[tokio::test]
    async fn injects_after_leading_systems() {
        let store = FakeProjectStore::default();
        let p = Project::new("Writing", "be lyrical").with_slug("w");
        let pid = p.id.clone();
        store.put(p).await;
        let store_arc: Arc<dyn ProjectStore> = Arc::new(store);

        let mut conv = Conversation::new();
        conv.push(Message::system("base prompt"));
        conv.push(Message::user("hi"));

        let out = materialise(Some(&store_arc), conv, Some(&pid))
            .await
            .unwrap();
        assert_eq!(out.injected_at, Some(1));
        assert_eq!(out.conversation.messages.len(), 3);
        match &out.conversation.messages[1] {
            Message::System { content, .. } => {
                assert!(content.starts_with("=== project: Writing (w) ==="));
                assert!(content.contains("be lyrical"));
                // Closing marker tells the agent the block is delimited.
                assert!(content.contains("=== /project ==="));
            }
            other => panic!("expected injected System, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn injected_block_includes_workspaces_and_description() {
        let store = FakeProjectStore::default();
        let mut p = Project::new("Jarvis Product", "Be helpful.")
            .with_slug("jarvis-product")
            .with_description("Upper-layer product workspace.");
        p.set_workspaces(vec![
            harness_core::ProjectWorkspace {
                path: "/Users/zj/Jarvis".into(),
                name: Some("Repo".into()),
            },
            harness_core::ProjectWorkspace::new("/Users/zj/Notes"),
        ]);
        let pid = p.id.clone();
        store.put(p).await;
        let store_arc: Arc<dyn ProjectStore> = Arc::new(store);

        let conv = Conversation::new();
        let out = materialise(Some(&store_arc), conv, Some(&pid))
            .await
            .unwrap();
        let Message::System { content, .. } = &out.conversation.messages[0] else {
            panic!("expected System");
        };
        // Header carries name + slug.
        assert!(content.starts_with("=== project: Jarvis Product (jarvis-product) ==="));
        // Description renders verbatim (one line below the header).
        assert!(content.contains("Upper-layer product workspace."));
        // Workspaces are listed under a clear header.
        assert!(content.contains("Workspaces:"));
        assert!(content.contains("- Repo — /Users/zj/Jarvis"));
        assert!(content.contains("- /Users/zj/Notes"));
        // Instructions still present.
        assert!(content.contains("Instructions:"));
        assert!(content.contains("Be helpful."));
        assert!(content.trim_end().ends_with("=== /project ==="));
    }

    #[tokio::test]
    async fn injected_block_omits_empty_optional_sections() {
        let store = FakeProjectStore::default();
        // Minimal project: no description, no workspaces, instructions only.
        let p = Project::new("Mini", "Stay terse.").with_slug("mini");
        let pid = p.id.clone();
        store.put(p).await;
        let store_arc: Arc<dyn ProjectStore> = Arc::new(store);

        let conv = Conversation::new();
        let out = materialise(Some(&store_arc), conv, Some(&pid))
            .await
            .unwrap();
        let Message::System { content, .. } = &out.conversation.messages[0] else {
            panic!("expected System");
        };
        // No `Workspaces:` label when the list is empty — keeps the
        // block tight for instruction-only projects.
        assert!(!content.contains("Workspaces:"));
        // Still has the close marker.
        assert!(content.trim_end().ends_with("=== /project ==="));
    }

    #[tokio::test]
    async fn injects_at_zero_when_no_leading_system() {
        let store = FakeProjectStore::default();
        let p = Project::new("X", "i").with_slug("x");
        let pid = p.id.clone();
        store.put(p).await;
        let store_arc: Arc<dyn ProjectStore> = Arc::new(store);

        let mut conv = Conversation::new();
        conv.push(Message::user("hi"));

        let out = materialise(Some(&store_arc), conv, Some(&pid))
            .await
            .unwrap();
        assert_eq!(out.injected_at, Some(0));
        assert!(matches!(out.conversation.messages[0], Message::System { .. }));
    }

    #[tokio::test]
    async fn archived_project_is_skipped() {
        let store = FakeProjectStore::default();
        let mut p = Project::new("X", "i").with_slug("x");
        p.archive();
        let pid = p.id.clone();
        store.put(p).await;
        let store_arc: Arc<dyn ProjectStore> = Arc::new(store);

        let conv = Conversation::new();
        let out = materialise(Some(&store_arc), conv, Some(&pid))
            .await
            .unwrap();
        assert!(out.injected_at.is_none());
    }

    #[test]
    fn strip_removes_injected_block() {
        let mut conv = Conversation::new();
        conv.push(Message::system("base"));
        conv.push(Message::system("=== project: X ===\nbody"));
        conv.push(Message::user("hi"));
        let prepared = PreparedConversation {
            conversation: conv.clone(),
            injected_at: Some(1),
        };
        let stripped = strip_project_block(conv, &prepared);
        assert_eq!(stripped.messages.len(), 2);
        assert!(matches!(stripped.messages[0], Message::System { .. }));
        assert!(matches!(stripped.messages[1], Message::User { .. }));
    }

    #[test]
    fn strip_is_noop_when_index_is_none() {
        let mut conv = Conversation::new();
        conv.push(Message::user("hi"));
        let prepared = PreparedConversation {
            conversation: conv.clone(),
            injected_at: None,
        };
        let stripped = strip_project_block(conv, &prepared);
        assert_eq!(stripped.messages.len(), 1);
    }

    #[test]
    fn strip_is_noop_when_index_no_longer_points_at_a_system() {
        let mut conv = Conversation::new();
        conv.push(Message::user("hi"));
        let prepared = PreparedConversation {
            conversation: conv.clone(),
            injected_at: Some(5),
        };
        let stripped = strip_project_block(conv.clone(), &prepared);
        assert_eq!(stripped.messages.len(), conv.messages.len());
    }
}
