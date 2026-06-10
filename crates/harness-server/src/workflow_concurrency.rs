//! Process-wide governance for manually-dispatched workflow runs.
//!
//! `POST /v1/workflows/:id/run` fire-and-forgets a [`tokio::spawn`]. Left
//! ungoverned that is three bugs at once (issue #78): unbounded concurrent
//! runs (resource exhaustion), no way to cancel an in-flight run, and rows
//! stuck `Running` forever after a process restart.
//!
//! [`WorkflowRunGate`] is the single shared object that closes all three:
//!
//! - **Cap** — an [`Arc<Semaphore>`] sized from `JARVIS_WORKFLOW_MAX_CONCURRENT`
//!   (mirroring the auto loop's `JARVIS_WORK_MAX_CONCURRENT`). The manual
//!   route reserves a permit *before* minting a run; at capacity it returns
//!   `429` instead of spawning, so a flood of POSTs can't fan out unbounded.
//! - **Cancel** — manual spawns register their [`AbortHandle`] keyed by run
//!   id; [`WorkflowRunGate::cancel`] aborts the task so an in-flight run can
//!   actually be stopped.
//! - **Liveness** — every run records its presence for the duration of
//!   execution via an [`InflightGuard`]. The stale-run reaper consults
//!   [`WorkflowRunGate::is_active`] so it never reclaims a run that is still
//!   alive *in this process* — only genuinely orphaned rows (left `Running`
//!   by a crashed prior process) get reaped by age.
//!
//! Cheap to clone (two `Arc`s); lives on [`AppState`](crate::state::AppState).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::task::AbortHandle;

/// Fallback global cap when the binary doesn't set one explicitly.
/// Matches the auto loop's `max_concurrent_units` default so the two
/// schedulers behave the same out of the box.
pub const DEFAULT_WORKFLOW_MAX_CONCURRENT: usize = 2;

#[derive(Default)]
struct Inner {
    /// Run ids alive *in this process* (manual or auto path). The reaper
    /// skips these regardless of age — they will finalize themselves.
    inflight: HashSet<String>,
    /// Abort handles for cancellable (manual-route) runs.
    handles: HashMap<String, AbortHandle>,
}

/// Shared, cloneable governor for workflow runs. See module docs.
#[derive(Clone)]
pub struct WorkflowRunGate {
    sem: Arc<Semaphore>,
    inner: Arc<Mutex<Inner>>,
    capacity: usize,
}

impl WorkflowRunGate {
    /// Build a gate that admits at most `max_concurrent` manual runs at
    /// once (clamped to ≥1 so a misconfigured `0` doesn't deadlock the
    /// route).
    pub fn new(max_concurrent: usize) -> Self {
        let capacity = max_concurrent.max(1);
        Self {
            sem: Arc::new(Semaphore::new(capacity)),
            inner: Arc::new(Mutex::new(Inner::default())),
            capacity,
        }
    }

    /// Reserve a run slot, or `None` when already at capacity. The
    /// returned permit must be held (moved into the spawned task) for the
    /// lifetime of the run; dropping it releases the slot.
    pub fn try_acquire(&self) -> Option<OwnedSemaphorePermit> {
        self.sem.clone().try_acquire_owned().ok()
    }

    /// Record that `run_id` is executing in this process. The returned
    /// guard clears the record (and any registered abort handle) on drop
    /// — which runs on normal completion *and* on task abort, so the
    /// liveness set never leaks.
    pub fn mark_inflight(&self, run_id: impl Into<String>) -> InflightGuard {
        let run_id = run_id.into();
        if let Ok(mut g) = self.inner.lock() {
            g.inflight.insert(run_id.clone());
        }
        InflightGuard {
            inner: Arc::clone(&self.inner),
            run_id,
        }
    }

    /// Register a manual run's abort handle so [`cancel`](Self::cancel)
    /// can stop it. Overwrites any prior handle for the same id.
    pub fn register_handle(&self, run_id: impl Into<String>, handle: AbortHandle) {
        if let Ok(mut g) = self.inner.lock() {
            g.handles.insert(run_id.into(), handle);
        }
    }

    /// Abort the in-flight task for `run_id` if one is registered.
    /// Returns `true` when a live task was aborted, `false` when nothing
    /// cancellable was found (already finished, never registered, or
    /// orphaned by a prior process).
    pub fn cancel(&self, run_id: &str) -> bool {
        let handle = self
            .inner
            .lock()
            .ok()
            .and_then(|mut g| g.handles.remove(run_id));
        match handle {
            Some(h) => {
                h.abort();
                true
            }
            None => false,
        }
    }

    /// Is `run_id` executing in this process right now?
    pub fn is_active(&self, run_id: &str) -> bool {
        self.inner
            .lock()
            .map(|g| g.inflight.contains(run_id))
            .unwrap_or(false)
    }

    /// Number of runs currently executing in this process.
    pub fn active_count(&self) -> usize {
        self.inner.lock().map(|g| g.inflight.len()).unwrap_or(0)
    }

    /// Configured global cap (post-clamp).
    pub fn capacity(&self) -> usize {
        self.capacity
    }
}

impl Default for WorkflowRunGate {
    fn default() -> Self {
        Self::new(DEFAULT_WORKFLOW_MAX_CONCURRENT)
    }
}

/// Drop guard that clears a run's liveness record (and abort handle) when
/// the executing future ends — by completion or by abort. Returned from
/// [`WorkflowRunGate::mark_inflight`].
pub struct InflightGuard {
    inner: Arc<Mutex<Inner>>,
    run_id: String,
}

impl Drop for InflightGuard {
    fn drop(&mut self) {
        if let Ok(mut g) = self.inner.lock() {
            g.inflight.remove(&self.run_id);
            g.handles.remove(&self.run_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capacity_is_clamped_to_at_least_one() {
        assert_eq!(WorkflowRunGate::new(0).capacity(), 1);
        assert_eq!(WorkflowRunGate::new(5).capacity(), 5);
    }

    #[test]
    fn try_acquire_bounds_concurrency() {
        let gate = WorkflowRunGate::new(1);
        let first = gate.try_acquire();
        assert!(first.is_some(), "first slot must be admitted");
        assert!(
            gate.try_acquire().is_none(),
            "second slot must be rejected at capacity 1"
        );
        // Releasing the permit frees the slot again.
        drop(first);
        assert!(gate.try_acquire().is_some(), "slot reopens after drop");
    }

    #[test]
    fn inflight_guard_marks_and_clears() {
        let gate = WorkflowRunGate::new(2);
        assert!(!gate.is_active("r1"));
        let guard = gate.mark_inflight("r1");
        assert!(gate.is_active("r1"));
        assert_eq!(gate.active_count(), 1);
        drop(guard);
        assert!(!gate.is_active("r1"));
        assert_eq!(gate.active_count(), 0);
    }

    #[tokio::test]
    async fn cancel_aborts_registered_task() {
        let gate = WorkflowRunGate::new(2);
        // A task that would run effectively forever.
        let handle = tokio::spawn(async {
            tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
        });
        gate.register_handle("r1", handle.abort_handle());
        assert!(gate.cancel("r1"), "registered handle must report cancelled");
        // The task observes the abort.
        let joined = handle.await;
        assert!(joined.is_err_and(|e| e.is_cancelled()));
        // A second cancel finds nothing.
        assert!(!gate.cancel("r1"));
    }

    #[test]
    fn cancel_unknown_run_is_false() {
        let gate = WorkflowRunGate::new(2);
        assert!(!gate.cancel("nope"));
    }
}
