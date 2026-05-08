//! Runtime manager for MCP servers.
//!
//! Sits between the harness `ToolRegistry` (shared as
//! `Arc<RwLock<ToolRegistry>>`) and a set of running [`McpClient`]s.
//! Lets API handlers, the CLI, or the plugin manager add / remove /
//! list MCP servers while an agent is running, without restarting
//! the process.
//!
//! Locking discipline: every public method does its async work
//! (network round-trips, child-process spawning) **before** taking
//! the registry write lock. The lock is then held only for the brief
//! time it takes to insert/remove HashMap entries. Holding a
//! `std::sync::RwLock` guard across `.await` would not even compile
//! (the guard is `!Send`); the split-collect/insert design satisfies
//! that automatically.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use harness_core::ToolRegistry;
use serde::Serialize;
use tokio::sync::Mutex;
use tracing::{debug, info, warn};

use crate::client::{McpClient, McpClientConfig};
use crate::error::McpError;

/// Status of one server in the manager.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum McpServerStatus {
    /// Connected and registered.
    Running,
    /// In the catalog but not currently connected (config disabled,
    /// or a previous connect failed).
    Stopped,
    /// Live connection is unhealthy (last health probe failed).
    Unhealthy,
}

/// One server's view as exposed via API.
#[derive(Debug, Clone, Serialize)]
pub struct McpServerInfo {
    pub prefix: String,
    pub config: McpClientConfig,
    pub status: McpServerStatus,
    pub tools: Vec<String>,
}

struct Slot {
    config: McpClientConfig,
    client: Option<Arc<McpClient>>,
    tools: Vec<String>,
    status: McpServerStatus,
}

/// Per-server outcome from [`McpManager::bootstrap_with_report`].
#[derive(Debug, Default, Clone)]
pub struct BootstrapReport {
    /// `(prefix, registered_tool_names)` for each server that came
    /// up cleanly.
    pub added: Vec<(String, Vec<String>)>,
    /// `(prefix, error)` for each server that failed. The slot is
    /// kept around as `Stopped` so the operator can hit `reload`.
    pub failed: Vec<(String, String)>,
}

/// Owns running MCP clients keyed by prefix.
pub struct McpManager {
    registry: Arc<RwLock<ToolRegistry>>,
    /// Outer mutex serialises the manager's mutating operations.
    /// Inside it, `slots` is plain (not behind another lock) — only
    /// one writer at a time holds the outer mutex.
    slots: Mutex<HashMap<String, Slot>>,
}

impl McpManager {
    /// Build an empty manager bound to a shared `ToolRegistry`.
    pub fn new(registry: Arc<RwLock<ToolRegistry>>) -> Self {
        Self {
            registry,
            slots: Mutex::new(HashMap::new()),
        }
    }

    /// Bulk-import a set of configs (typically from the user's
    /// config file or env). Each `enabled` entry is connected
    /// independently; per-server failures are logged at WARN and the
    /// failing server is recorded in the manager as `Stopped` so the
    /// catalog UI can show "this one didn't come up — click reload to
    /// retry". Phase 2 tolerance contract: **a single bad MCP server
    /// must never kill `jarvis serve`**.
    ///
    /// Returns a tuple of `(added_ok, failed)` where `failed` carries
    /// the prefix + error string for each server that didn't connect.
    /// Returning `Result` instead of `Vec<…>` keeps the historical
    /// signature usable for callers that don't care about partial
    /// failure (the `Result` is always `Ok(())` now).
    pub async fn bootstrap(&self, configs: Vec<McpClientConfig>) -> Result<(), McpError> {
        let _ = self.bootstrap_with_report(configs).await;
        Ok(())
    }

    /// Variant of [`bootstrap`](Self::bootstrap) that returns the
    /// per-server outcome — successful adds plus the list of failures
    /// (prefix → error message). The composition root logs both lists
    /// at startup and surfaces the failures via
    /// `GET /v1/mcp/servers` (failed entries land as `Stopped` slots).
    pub async fn bootstrap_with_report(&self, configs: Vec<McpClientConfig>) -> BootstrapReport {
        let mut report = BootstrapReport::default();
        for cfg in configs {
            let prefix = cfg.prefix.clone();
            match self.add(cfg.clone()).await {
                Ok(names) => {
                    report.added.push((prefix, names));
                }
                Err(e) => {
                    warn!(
                        prefix = %prefix,
                        error = %e,
                        "mcp server failed to start; recording as Stopped",
                    );
                    // Best-effort: stash a stopped-slot entry so the
                    // UI can show the server with its last error.
                    // If even this insert fails (e.g. the slot lock
                    // is poisoned) we just drop the failure — the
                    // operator already saw the WARN.
                    let mut slots = self.slots.lock().await;
                    slots.entry(prefix.clone()).or_insert_with(|| Slot {
                        config: cfg.clone(),
                        client: None,
                        tools: Vec::new(),
                        status: McpServerStatus::Stopped,
                    });
                    report.failed.push((prefix, e.to_string()));
                }
            }
        }
        report
    }

    /// Add a server. Connects, registers its tools, stashes the
    /// client. Returns the final-registered tool names.
    ///
    /// Errors:
    /// - Conflict if the prefix is already in the manager.
    /// - Conflict if any of the to-be-registered tool names already
    ///   exist in the registry (catches collisions with built-ins or
    ///   other plugins). The client is shut down before returning.
    /// - Any underlying `McpError` from spawning / handshake.
    pub async fn add(&self, config: McpClientConfig) -> Result<Vec<String>, McpError> {
        let prefix = config.prefix.clone();
        {
            let slots = self.slots.lock().await;
            if slots.contains_key(&prefix) {
                return Err(McpError::Other(format!(
                    "mcp prefix `{prefix}` already registered"
                )));
            }
        }

        if !config.enabled {
            // Catalog-only entry. Record it as Stopped so the UI / API
            // sees it.
            let mut slots = self.slots.lock().await;
            slots.insert(
                prefix.clone(),
                Slot {
                    config,
                    client: None,
                    tools: Vec::new(),
                    status: McpServerStatus::Stopped,
                },
            );
            return Ok(Vec::new());
        }

        // Network: connect + collect tools (no lock held).
        let client = McpClient::connect(&config).await?;
        let pairs = match client.collect_remote_tools(&config).await {
            Ok(p) => p,
            Err(e) => {
                client.shutdown().await;
                return Err(e);
            }
        };

        // Validation + insert under the write lock. Conflict checks
        // happen here so the registry stays consistent with `slots`.
        let names: Vec<String> = pairs.iter().map(|(n, _)| n.clone()).collect();
        let conflict = {
            let reg = self
                .registry
                .read()
                .map_err(|e| McpError::Other(format!("registry poisoned: {e}")))?;
            names.iter().find(|n| reg.contains(n)).cloned()
        };
        if let Some(name) = conflict {
            client.shutdown().await;
            return Err(McpError::Other(format!(
                "tool name `{name}` would conflict with an existing registration"
            )));
        }

        {
            let mut reg = self
                .registry
                .write()
                .map_err(|e| McpError::Other(format!("registry poisoned: {e}")))?;
            for (_, tool) in pairs {
                reg.register_arc(tool);
            }
        }

        let mut slots = self.slots.lock().await;
        slots.insert(
            prefix.clone(),
            Slot {
                config,
                client: Some(Arc::new(client)),
                tools: names.clone(),
                status: McpServerStatus::Running,
            },
        );
        info!(prefix = %prefix, count = names.len(), "mcp server added");
        Ok(names)
    }

    /// Remove a server. Unregisters its tools and shuts the client
    /// down. Idempotent: missing prefix returns `false`.
    pub async fn remove(&self, prefix: &str) -> Result<bool, McpError> {
        let slot = {
            let mut slots = self.slots.lock().await;
            slots.remove(prefix)
        };
        let Some(slot) = slot else {
            return Ok(false);
        };
        // Drop tools from the registry first so no in-flight call
        // can resolve a tool whose backing client we're about to kill.
        {
            let mut reg = self
                .registry
                .write()
                .map_err(|e| McpError::Other(format!("registry poisoned: {e}")))?;
            let _ = reg.unregister_prefix(prefix);
        }
        if let Some(arc_client) = slot.client {
            if let Some(client) = Arc::into_inner(arc_client) {
                client.shutdown().await;
            }
            // else: a concurrent `health` probe still holds an Arc;
            // when it drops the Arc the underlying child is reaped
            // by the rmcp service drop impl. No leak.
        }
        info!(prefix = %prefix, "mcp server removed");
        Ok(true)
    }

    /// Probe the named server with `tools/list`. Updates the slot
    /// status (`Running` ↔ `Unhealthy`) and returns the tool count
    /// reported by the server.
    pub async fn health(&self, prefix: &str) -> Result<usize, McpError> {
        let client = {
            let slots = self.slots.lock().await;
            let Some(slot) = slots.get(prefix) else {
                return Err(McpError::Other(format!("unknown mcp prefix `{prefix}`")));
            };
            slot.client
                .clone()
                .ok_or_else(|| McpError::Other(format!("mcp server `{prefix}` is stopped")))?
        };
        let result = client.health().await;
        let mut slots = self.slots.lock().await;
        if let Some(slot) = slots.get_mut(prefix) {
            slot.status = match &result {
                Ok(_) => McpServerStatus::Running,
                Err(_) => McpServerStatus::Unhealthy,
            };
        }
        result
    }

    /// Snapshot of every server's current state.
    pub async fn list(&self) -> Vec<McpServerInfo> {
        let slots = self.slots.lock().await;
        let mut out: Vec<McpServerInfo> = slots
            .values()
            .map(|s| McpServerInfo {
                prefix: s.config.prefix.clone(),
                config: s.config.clone(),
                status: s.status,
                tools: s.tools.clone(),
            })
            .collect();
        out.sort_by(|a, b| a.prefix.cmp(&b.prefix));
        out
    }

    /// Look up one server by prefix.
    pub async fn get(&self, prefix: &str) -> Option<McpServerInfo> {
        let slots = self.slots.lock().await;
        slots.get(prefix).map(|s| McpServerInfo {
            prefix: s.config.prefix.clone(),
            config: s.config.clone(),
            status: s.status,
            tools: s.tools.clone(),
        })
    }

    /// Replace a server's config in place: removes the old, adds the
    /// new. The `prefix` on `new_config` must match `prefix`.
    pub async fn replace(
        &self,
        prefix: &str,
        new_config: McpClientConfig,
    ) -> Result<Vec<String>, McpError> {
        if new_config.prefix != prefix {
            return Err(McpError::Other(format!(
                "config prefix `{}` does not match `{}`",
                new_config.prefix, prefix
            )));
        }
        if !self.remove(prefix).await? {
            warn!(prefix, "replace: previous slot not found, treating as add");
        }
        let added = self.add(new_config).await?;
        debug!(prefix, count = added.len(), "mcp server replaced");
        Ok(added)
    }

    /// Restart a server using its currently-stored config. Equivalent
    /// to `replace(prefix, get(prefix).config)` but never deletes the
    /// slot on failure: if the fresh connect doesn't come up, a
    /// `Stopped` placeholder is left in place so the operator can hit
    /// reload again. Returns the freshly-registered tool names on
    /// success.
    ///
    /// Used by the `POST /v1/mcp/servers/:prefix/reload` endpoint to
    /// recover from a stuck connection without restarting Jarvis.
    pub async fn reload(&self, prefix: &str) -> Result<Vec<String>, McpError> {
        let cfg = {
            let slots = self.slots.lock().await;
            slots
                .get(prefix)
                .map(|s| s.config.clone())
                .ok_or_else(|| McpError::Other(format!("unknown mcp prefix `{prefix}`")))?
        };
        match self.replace(prefix, cfg.clone()).await {
            Ok(names) => Ok(names),
            Err(e) => {
                // `replace` removed the old slot before the failed
                // add. Restore a Stopped placeholder so the catalog
                // entry survives — same contract as
                // `bootstrap_with_report`.
                let mut slots = self.slots.lock().await;
                slots.entry(prefix.to_string()).or_insert_with(|| Slot {
                    config: cfg,
                    client: None,
                    tools: Vec::new(),
                    status: McpServerStatus::Stopped,
                });
                Err(e)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::McpClientConfig;
    use harness_core::ToolRegistry;
    use std::sync::{Arc, RwLock};

    /// Bootstrap should never panic on a config that fails to spawn.
    /// The bad entry lands as a Stopped slot so the UI / API can show
    /// the error and offer reload, while siblings keep going.
    #[tokio::test]
    async fn bootstrap_records_failed_servers_as_stopped() {
        let reg = Arc::new(RwLock::new(ToolRegistry::new()));
        let mgr = McpManager::new(reg);

        let bad = McpClientConfig::new("bad", "/no/such/binary-that-cannot-exist", Vec::new());
        let report = mgr.bootstrap_with_report(vec![bad]).await;
        assert_eq!(report.added.len(), 0);
        assert_eq!(report.failed.len(), 1);
        assert_eq!(report.failed[0].0, "bad");

        // Slot should still exist, recorded as Stopped.
        let slot = mgr.get("bad").await.expect("slot present");
        assert_eq!(slot.status, McpServerStatus::Stopped);
        assert!(slot.tools.is_empty());
    }

    #[tokio::test]
    async fn bootstrap_legacy_signature_returns_ok_even_on_failure() {
        let reg = Arc::new(RwLock::new(ToolRegistry::new()));
        let mgr = McpManager::new(reg);
        let bad = McpClientConfig::new("bad2", "/no/such/binary-zzz", Vec::new());
        // The Result-returning shim must keep returning Ok(()) so
        // `apps/jarvis::serve` startup never aborts on a bad MCP
        // entry.
        assert!(mgr.bootstrap(vec![bad]).await.is_ok());
        let slot = mgr.get("bad2").await.expect("slot present");
        assert_eq!(slot.status, McpServerStatus::Stopped);
    }

    #[tokio::test]
    async fn reload_unknown_prefix_errors() {
        let reg = Arc::new(RwLock::new(ToolRegistry::new()));
        let mgr = McpManager::new(reg);
        let err = mgr.reload("nope").await.unwrap_err();
        assert!(err.to_string().contains("unknown mcp prefix"));
    }

    /// Reload on a Stopped slot retries the connect (and is expected
    /// to fail again because the bogus binary still doesn't exist) —
    /// but the slot is preserved either way.
    #[tokio::test]
    async fn reload_retries_failed_server_keeping_slot() {
        let reg = Arc::new(RwLock::new(ToolRegistry::new()));
        let mgr = McpManager::new(reg);
        let bad = McpClientConfig::new("bad3", "/no/such/binary-aaa", Vec::new());
        mgr.bootstrap_with_report(vec![bad]).await;
        let _ = mgr.reload("bad3").await; // expected to fail again
                                          // Either way, the slot is still around.
        let slot = mgr.get("bad3").await;
        assert!(slot.is_some(), "reload must not delete the slot on failure");
    }
}
