//! Working-context channel — "what the agent has its hands on right now".
//!
//! Long-running agent loops compact older turns out of the prompt as
//! the context window fills. Plain truncation / summarisation throws
//! away the *operational* state that the recent turns carried: which
//! files the agent had been reading, which plan it was working
//! against, etc. After compaction the assistant looks at a clean slate
//! and re-grep's files it already knew about, or forgets that it had
//! a plan in progress.
//!
//! `WorkingContext` is the smallest amount of state we can reinject
//! after compaction to keep that situational awareness. It's *not* a
//! second memory — it's a tiny, bounded, latest-only snapshot of:
//!
//! - **Recent files** the agent has touched (FIFO, capped). Tools that
//!   read or write a file call [`note_file`]; the snapshot lists each
//!   path at most once with the most-recent access at the head.
//! - **Latest plan snapshot** — whatever the most recent
//!   `plan.update` carried. Forwarded by the agent loop from the
//!   `plan` task-local channel; tools don't have to do anything new.
//!
//! ## Wire model
//!
//! - The agent loop installs a per-run [`Arc<Mutex<WorkingContext>>`]
//!   in a [`tokio::task_local`] via [`with_working_context`] **once
//!   per `Agent::run` / `Agent::run_stream` invocation**, not per
//!   tool — every tool dispatch and every memory `compact` call sees
//!   the same accumulating snapshot.
//! - Memory backends read the latest snapshot via [`snapshot`] inside
//!   their `compact` implementation and append a `System` block
//!   `=== working context ===` to the returned slice. The block is
//!   appended only at the wire stage (`build_request`); the
//!   canonical [`crate::Conversation`] is never mutated, mirroring
//!   how compacted summaries already work.
//! - Outside an agent invocation (e.g. tool unit tests) the channel
//!   is absent and all mutators are no-ops, so callers can use these
//!   helpers freely without standing up a harness.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use futures::Stream;
use serde::Serialize;

use crate::plan::PlanItem;

/// How many distinct recently-touched files we surface to the model
/// after compaction. The list is the FIFO tail; older entries fall
/// off as new ones land. 20 paths fit in ~1 KiB of system message
/// even with long workspace-relative paths, which is well within the
/// SUMMARY_RESERVE_TOKENS budget that `harness-memory` carves out.
pub const DEFAULT_RECENT_FILES_CAP: usize = 20;

/// How many distinct recently-issued commands / search patterns we
/// surface alongside the files. Smaller cap than files because each
/// entry is a free-form string the model has to read in full; 8 is
/// enough to capture the relevant "I just ran `cargo test`,
/// `grep foo`, ..." trail without crowding the prompt.
pub const DEFAULT_RECENT_COMMANDS_CAP: usize = 8;
/// Max length per recorded command. Long shell pipelines get
/// truncated with an ellipsis so a runaway `find ... -exec ...` line
/// doesn't blow the budget.
pub const MAX_COMMAND_LENGTH: usize = 200;

/// A bounded, monotonically-updated snapshot of the agent's current
/// operational state. Clone is cheap-ish (Vec / VecDeque clone) — call
/// it once per `compact` call.
#[derive(Debug, Clone, Default, Serialize)]
pub struct WorkingContext {
    /// Most-recently-touched files, head = newest, tail = oldest. Each
    /// path appears at most once; a fresh touch moves the path back
    /// to the head rather than duplicating it.
    pub recent_files: VecDeque<PathBuf>,
    /// Latest plan snapshot the agent published via `plan.update`.
    /// `None` until the first emission this run.
    pub latest_plan: Option<Vec<PlanItem>>,
    /// FIFO cap for `recent_files`. Stored on the struct so tests can
    /// override it without going through globals.
    pub files_cap: usize,
    /// Most-recently-issued shell commands / search patterns, same
    /// FIFO + dedup invariant as `recent_files`. Pruned at
    /// [`MAX_COMMAND_LENGTH`] before storage so any single entry
    /// stays readable in the system-prompt block.
    pub recent_commands: VecDeque<String>,
    /// FIFO cap for `recent_commands`.
    pub commands_cap: usize,
}

impl WorkingContext {
    pub fn new(files_cap: usize) -> Self {
        Self {
            recent_files: VecDeque::with_capacity(files_cap),
            latest_plan: None,
            files_cap,
            recent_commands: VecDeque::with_capacity(DEFAULT_RECENT_COMMANDS_CAP),
            commands_cap: DEFAULT_RECENT_COMMANDS_CAP,
        }
    }

    /// Promote `path` to the head of `recent_files`, deduping and
    /// trimming to `files_cap`. Empty paths are ignored.
    pub fn note_file(&mut self, path: PathBuf) {
        if path.as_os_str().is_empty() {
            return;
        }
        // Dedup: remove any prior entry equal to this path so the
        // newest occurrence wins.
        if let Some(pos) = self.recent_files.iter().position(|p| p == &path) {
            self.recent_files.remove(pos);
        }
        self.recent_files.push_front(path);
        while self.recent_files.len() > self.files_cap {
            self.recent_files.pop_back();
        }
    }

    /// Promote `cmd` to the head of `recent_commands`. Empty inputs
    /// are ignored; over-long commands are truncated with an
    /// ellipsis. Same dedup-and-front-promotion policy as
    /// `recent_files` so the trail reflects "most-recent first".
    pub fn note_command(&mut self, cmd: String) {
        let trimmed = cmd.trim();
        if trimmed.is_empty() {
            return;
        }
        let value = if trimmed.chars().count() > MAX_COMMAND_LENGTH {
            // Truncate on char boundary so we don't slice mid-UTF-8.
            let mut s: String = trimmed.chars().take(MAX_COMMAND_LENGTH - 1).collect();
            s.push('…');
            s
        } else {
            trimmed.to_string()
        };
        if let Some(pos) = self.recent_commands.iter().position(|c| c == &value) {
            self.recent_commands.remove(pos);
        }
        self.recent_commands.push_front(value);
        while self.recent_commands.len() > self.commands_cap {
            self.recent_commands.pop_back();
        }
    }

    /// Replace the plan snapshot wholesale.
    pub fn note_plan(&mut self, items: Vec<PlanItem>) {
        self.latest_plan = Some(items);
    }

    /// Whether there's anything worth rendering. Memory backends skip
    /// the injected block entirely when this returns false so they
    /// don't waste tokens on an empty header.
    pub fn is_empty(&self) -> bool {
        self.recent_files.is_empty()
            && self.latest_plan.is_none()
            && self.recent_commands.is_empty()
    }

    /// Render to the wire-shape `System` message body. The format is
    /// stable so other tools / tests can grep for the header.
    /// Returns `None` when the context is empty.
    pub fn render(&self) -> Option<String> {
        if self.is_empty() {
            return None;
        }
        let mut buf = String::from("=== working context ===\n");
        if !self.recent_files.is_empty() {
            buf.push_str("recent files (most recent first):\n");
            for p in &self.recent_files {
                buf.push_str("- ");
                buf.push_str(&p.display().to_string());
                buf.push('\n');
            }
        }
        if !self.recent_commands.is_empty() {
            buf.push_str("\nrecent commands (most recent first):\n");
            for c in &self.recent_commands {
                buf.push_str("- ");
                buf.push_str(c);
                buf.push('\n');
            }
        }
        if let Some(items) = self.latest_plan.as_ref() {
            if !items.is_empty() {
                buf.push_str("\ncurrent plan:\n");
                for item in items {
                    let status = match item.status {
                        crate::plan::PlanStatus::Pending => "[ ]",
                        crate::plan::PlanStatus::InProgress => "[~]",
                        crate::plan::PlanStatus::Completed => "[x]",
                        crate::plan::PlanStatus::Cancelled => "[-]",
                    };
                    buf.push_str(status);
                    buf.push(' ');
                    buf.push_str(&item.title);
                    if let Some(note) = item.note.as_deref() {
                        buf.push_str(" (");
                        buf.push_str(note);
                        buf.push(')');
                    }
                    buf.push('\n');
                }
            }
        }
        Some(buf)
    }
}

tokio::task_local! {
    /// Per-run working-context slot. Scoped by [`with_working_context`]
    /// at the top of `Agent::run` and `Agent::run_stream`.
    static WORKING_CTX: Arc<Mutex<WorkingContext>>;
}

/// Note that the current task touched a file. No-op when no
/// listener is installed (unit tests, etc.).
pub fn note_file(path: impl Into<PathBuf>) {
    let path = path.into();
    let _ = WORKING_CTX.try_with(|wc| {
        if let Ok(mut wc) = wc.lock() {
            wc.note_file(path);
        }
    });
}

/// Forward a `plan.update` snapshot into the working context. Called
/// by the agent loop after relaying a `PlanUpdate` event, so tools
/// don't need to do anything extra.
pub fn note_plan(items: Vec<PlanItem>) {
    let _ = WORKING_CTX.try_with(|wc| {
        if let Ok(mut wc) = wc.lock() {
            wc.note_plan(items);
        }
    });
}

/// Record a shell command / search pattern in the current task's
/// working context. Called by tools that issue meaningful "what
/// did the agent just do" actions — today `shell.exec` and
/// `code.grep`. No-op when no listener is installed.
pub fn note_command(cmd: impl Into<String>) {
    let cmd = cmd.into();
    let _ = WORKING_CTX.try_with(|wc| {
        if let Ok(mut wc) = wc.lock() {
            wc.note_command(cmd);
        }
    });
}

/// Read-only snapshot of the current working context. `None` when
/// no listener is installed. Returns a clone — the lock is held only
/// for the duration of the clone.
pub fn snapshot() -> Option<WorkingContext> {
    WORKING_CTX
        .try_with(|wc| wc.lock().ok().map(|guard| guard.clone()))
        .ok()
        .flatten()
}

/// Whether a working-context slot is installed for the current task.
pub fn is_active() -> bool {
    WORKING_CTX.try_with(|_| ()).is_ok()
}

/// Run `fut` with a fresh `WorkingContext` installed as the active
/// slot. Used by the agent loop to scope context accumulation to a
/// single `run` / `run_stream` invocation; the slot is cleared when
/// `fut` completes.
pub async fn with_working_context<F, R>(fut: F) -> R
where
    F: std::future::Future<Output = R>,
{
    with_working_context_capped(DEFAULT_RECENT_FILES_CAP, fut).await
}

/// Same as [`with_working_context`] but lets the caller pin the
/// recent-files cap. Used by tests; production callers should prefer
/// the default.
pub async fn with_working_context_capped<F, R>(files_cap: usize, fut: F) -> R
where
    F: std::future::Future<Output = R>,
{
    let slot = Arc::new(Mutex::new(WorkingContext::new(files_cap)));
    WORKING_CTX.scope(slot, fut).await
}

/// Wrap a `Stream` so each `poll_next` runs with a per-stream
/// [`WorkingContext`] installed as the active task-local slot. Use
/// this for streaming entry points (like `Agent::run_stream`) whose
/// body can't be wrapped in [`with_working_context`] because
/// `async_stream::yield` cannot traverse a `tokio::task_local`
/// async scope.
pub fn scope_stream<S: Stream + 'static>(stream: S) -> WorkingContextStream<S> {
    WorkingContextStream::new(stream, DEFAULT_RECENT_FILES_CAP)
}

/// Same as [`scope_stream`] but lets callers (typically tests) pin
/// the `recent_files` cap.
pub fn scope_stream_capped<S: Stream + 'static>(
    stream: S,
    files_cap: usize,
) -> WorkingContextStream<S> {
    WorkingContextStream::new(stream, files_cap)
}

/// Stream adapter created by [`scope_stream`]: every `poll_next`
/// borrows the per-stream slot synchronously via `sync_scope` so the
/// task_local is visible inside the inner stream's body for that
/// poll.
pub struct WorkingContextStream<S> {
    inner: Pin<Box<S>>,
    ctx: Arc<Mutex<WorkingContext>>,
}

impl<S> WorkingContextStream<S> {
    fn new(inner: S, files_cap: usize) -> Self {
        Self {
            inner: Box::pin(inner),
            ctx: Arc::new(Mutex::new(WorkingContext::new(files_cap))),
        }
    }
}

impl<S: Stream> Stream for WorkingContextStream<S> {
    type Item = S::Item;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let ctx = self.ctx.clone();
        WORKING_CTX.sync_scope(ctx, || self.inner.as_mut().poll_next(cx))
    }
}

/// Convenience wrapper for tools that already canonicalised a path
/// against a sandbox root: pass the absolute path the tool resolved
/// (not the model's input). Strips a workspace root prefix when
/// available so the recorded path is portable across machines.
pub fn note_file_relative_to<P: AsRef<Path>>(path: P, workspace_root: Option<&Path>) {
    let path = path.as_ref();
    let to_record = match workspace_root.and_then(|root| path.strip_prefix(root).ok()) {
        Some(rel) => rel.to_path_buf(),
        None => path.to_path_buf(),
    };
    note_file(to_record);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::{PlanItem, PlanStatus};

    #[tokio::test]
    async fn note_file_dedupes_and_caps() {
        with_working_context_capped(3, async {
            note_file("a");
            note_file("b");
            note_file("c");
            note_file("a"); // promotes a back to head
            note_file("d"); // evicts the oldest (b)
            let snap = snapshot().unwrap();
            let paths: Vec<_> = snap
                .recent_files
                .iter()
                .map(|p| p.display().to_string())
                .collect();
            assert_eq!(paths, vec!["d", "a", "c"]);
        })
        .await;
    }

    #[tokio::test]
    async fn note_plan_replaces() {
        with_working_context(async {
            note_plan(vec![PlanItem {
                id: "1".into(),
                title: "first".into(),
                status: PlanStatus::InProgress,
                note: None,
            }]);
            note_plan(vec![
                PlanItem {
                    id: "1".into(),
                    title: "first".into(),
                    status: PlanStatus::Completed,
                    note: None,
                },
                PlanItem {
                    id: "2".into(),
                    title: "second".into(),
                    status: PlanStatus::InProgress,
                    note: None,
                },
            ]);
            let snap = snapshot().unwrap();
            let plan = snap.latest_plan.unwrap();
            assert_eq!(plan.len(), 2);
            assert_eq!(plan[0].status, PlanStatus::Completed);
        })
        .await;
    }

    #[tokio::test]
    async fn snapshot_outside_scope_is_none() {
        assert!(!is_active());
        assert!(snapshot().is_none());
        // The point: no panic.
        note_file("ignored");
        note_plan(vec![]);
    }

    #[tokio::test]
    async fn render_emits_header_with_files_and_plan() {
        with_working_context(async {
            note_file("src/lib.rs");
            note_plan(vec![PlanItem {
                id: "x".into(),
                title: "do thing".into(),
                status: PlanStatus::InProgress,
                note: Some("waiting on review".into()),
            }]);
            let body = snapshot().unwrap().render().unwrap();
            assert!(body.starts_with("=== working context ==="), "got: {body}");
            assert!(body.contains("- src/lib.rs"));
            assert!(body.contains("[~] do thing (waiting on review)"));
        })
        .await;
    }

    #[tokio::test]
    async fn render_empty_returns_none() {
        with_working_context(async {
            let snap = snapshot().unwrap();
            assert!(snap.is_empty());
            assert!(snap.render().is_none());
        })
        .await;
    }

    #[tokio::test]
    async fn note_command_dedupes_truncates_and_renders() {
        with_working_context(async {
            super::note_command("cargo test");
            super::note_command("cargo clippy");
            super::note_command("cargo test"); // dedup, promotes
            let huge = "x".repeat(MAX_COMMAND_LENGTH * 2);
            super::note_command(huge);
            let snap = snapshot().unwrap();
            let cmds: Vec<_> = snap.recent_commands.iter().cloned().collect();
            // 3 distinct entries, newest at head.
            assert_eq!(cmds.len(), 3);
            assert_eq!(cmds[1], "cargo test"); // promoted on dedup
            assert_eq!(cmds[2], "cargo clippy");
            // The huge entry was truncated with an ellipsis.
            assert!(cmds[0].ends_with('…'));
            assert!(cmds[0].chars().count() <= MAX_COMMAND_LENGTH);

            let rendered = snap.render().unwrap();
            assert!(rendered.contains("recent commands"));
            assert!(rendered.contains("- cargo test"));
        })
        .await;
    }

    #[tokio::test]
    async fn note_file_relative_to_strips_workspace_root() {
        let root = std::path::PathBuf::from("/workspace/proj");
        with_working_context(async {
            note_file_relative_to(root.join("src/lib.rs"), Some(&root));
            note_file_relative_to("/elsewhere/a.txt", Some(&root)); // absolute kept
            let snap = snapshot().unwrap();
            let paths: Vec<_> = snap
                .recent_files
                .iter()
                .map(|p| p.display().to_string())
                .collect();
            assert!(
                paths.iter().any(|p| p == "src/lib.rs"),
                "expected stripped path, got: {paths:?}"
            );
            assert!(
                paths.iter().any(|p| p == "/elsewhere/a.txt"),
                "expected absolute kept, got: {paths:?}"
            );
        })
        .await;
    }
}
