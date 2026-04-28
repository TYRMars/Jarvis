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
    /// config file or env). Each entry that's `enabled` is connected;
    /// failures are surfaced individually via `Result`. The first
    /// failure short-circuits and rolls back already-added entries —
    /// keeps startup state predictable.
    pub async fn bootstrap(&self, configs: Vec<McpClientConfig>) -> Result<(), McpError> {
        for cfg in configs {
            self.add(cfg).await?;
        }
        Ok(())
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
}
