//! Shared lock for tests that mutate process-wide environment
//! variables (`HOME`, `XDG_CONFIG_HOME`, `JARVIS_CONFIG_HOME`, …).
//!
//! `cargo test` runs in parallel by default. Multiple tests touching
//! the same env vars race and clobber each other's state, producing
//! flaky failures that don't reproduce under `--test-threads=1`. Each
//! such test acquires this mutex via [`lock`] and holds the guard for
//! the duration of its env mutations.
//!
//! The guard is poisoned-recovered: a panicking test should not wedge
//! every other env-mutating test in the suite.

use std::sync::{Mutex, MutexGuard, OnceLock};

static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub fn lock() -> MutexGuard<'static, ()> {
    ENV_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
