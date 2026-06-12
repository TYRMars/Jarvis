//! Process-wide per-requirement write serialization.
//!
//! The requirement / todo REST handlers each do a non-atomic
//! read-modify-write of the *whole* `Requirement` row: load it, mutate
//! one field (a todo's status, the triage state, a linked conversation
//! id, …), then write the entire row back. With nothing serializing
//! those handlers, two requests targeting the same requirement can both
//! read the same snapshot and each write their own change back — the
//! last write clobbers the other. That is the lost-update race in
//! issue #121: a select-all "Pass" that fans out one PATCH per todo
//! leaves only a non-deterministic subset actually persisted.
//!
//! [`RequirementLocks`] hands out one async mutex per requirement id.
//! A handler holds the guard across its whole `get → mutate → upsert`
//! sequence, so concurrent writers to the *same* requirement queue up
//! instead of racing. Writers to *different* requirements take
//! different mutexes and still run fully in parallel.
//!
//! This is the server-side half of the fix the issue recommends
//! ("per-requirement locking / serialized writes"); it makes every
//! writer correct regardless of how the client batches its calls.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

/// Per-requirement-id async write locks, shared process-wide.
///
/// Cheap to clone (one `Arc`); always present on `AppState`. The map is
/// pruned opportunistically on every acquire so it stays bounded by the
/// number of requirements with an *in-flight* write rather than the
/// number ever touched.
#[derive(Clone, Default)]
pub struct RequirementLocks {
    inner: Arc<Mutex<HashMap<String, Arc<AsyncMutex<()>>>>>,
}

impl RequirementLocks {
    /// Acquire the write lock for `id`, awaiting any current holder.
    ///
    /// Hold the returned guard across the entire read-modify-write
    /// (`store.get` … `store.upsert`/`delete`) and drop it at end of
    /// scope to release. Different ids never contend.
    pub async fn lock(&self, id: &str) -> OwnedMutexGuard<()> {
        let mutex = {
            // `std::sync::Mutex`, held only for the HashMap touch — never
            // across an `.await`. Recover rather than panic on poison so
            // a crashed sibling can't wedge every later writer.
            let mut map = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let mutex = map.entry(id.to_string()).or_default().clone();
            // Drop entries nobody is using anymore. An entry with a
            // strong count of 1 is referenced only by the map itself —
            // no task is holding or awaiting it — so removing it can't
            // split mutual exclusion. The entry we just cloned for `id`
            // has count >= 2 and is retained.
            map.retain(|_, m| Arc::strong_count(m) > 1);
            mutex
        };
        mutex.lock_owned().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn same_id_serializes_critical_sections() {
        let locks = RequirementLocks::default();
        // Shared, deliberately racy counter: each task reads it, yields,
        // then writes read+1. Without the lock the interleaving loses
        // increments; with it the final value is exactly N.
        let value = Arc::new(AtomicUsize::new(0));
        let n = 16;
        let mut handles = Vec::new();
        for _ in 0..n {
            let locks = locks.clone();
            let value = value.clone();
            handles.push(tokio::spawn(async move {
                let _guard = locks.lock("req-1").await;
                let seen = value.load(Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(2)).await;
                value.store(seen + 1, Ordering::SeqCst);
            }));
        }
        for h in handles {
            h.await.unwrap();
        }
        assert_eq!(value.load(Ordering::SeqCst), n);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn different_ids_do_not_block_each_other() {
        let locks = RequirementLocks::default();
        let a = locks.lock("a").await;
        // A different id must be acquirable while `a` is still held;
        // if it blocked this would hang the test.
        let b = tokio::time::timeout(Duration::from_secs(1), locks.lock("b"))
            .await
            .expect("lock on a different id must not block");
        drop((a, b));
    }

    #[tokio::test]
    async fn idle_entries_are_pruned() {
        let locks = RequirementLocks::default();
        {
            let _g = locks.lock("gone").await;
        } // guard dropped → entry now referenced only by the map
        // The next acquire (any id) sweeps the dead "gone" entry.
        let _g = locks.lock("other").await;
        let map = locks
            .inner
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        assert!(!map.contains_key("gone"));
        assert!(map.contains_key("other"));
    }
}
