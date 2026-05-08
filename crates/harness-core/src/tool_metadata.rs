//! Tool catalog metadata — Phase 1 of the model & tool compatibility
//! rollout.
//!
//! These types live alongside the [`Tool`](crate::Tool) trait but are
//! deliberately *not* part of it. The trait keeps a stable surface
//! (every existing impl in `harness-tools`, MCP bridge, plugin
//! adapters, subagent wrappers) and the registry layers on a parallel
//! [`ToolMetadata`] map keyed by tool name.
//!
//! Why a side-channel instead of trait methods:
//!
//! - The same wire-name can come from different sources (built-in vs
//!   MCP-spawned vs subagent wrapper) and the source is decided at
//!   registration time, not by the impl. A trait method would force
//!   every adapter to thread its own source field.
//! - Annotations evolve faster than the trait. Adding `risk` /
//!   `display_name` / `pack` over time without touching every Tool
//!   impl keeps churn low.
//!
//! The metadata is best-effort: a registration without explicit
//! metadata still works; the registry derives a conservative default
//! from the wire name + the trait's coarse [`ToolCategory`] +
//! `requires_approval` flag.

use serde::{Deserialize, Serialize};

use crate::tool::{Tool, ToolCategory};

/// Where this tool came from. Drives the Tool Catalog UI's "Source"
/// column and the per-source aggregate filter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ToolSource {
    /// Compiled-in tool from `harness-tools` or another in-tree
    /// crate.
    Builtin,
    /// External MCP server. `server` is the registration prefix the
    /// binary used (so the UI can correlate with the MCP servers
    /// page).
    Mcp { server: String },
    /// Plugin-installed tool. `plugin` is the plugin id from the
    /// plugin manager.
    Plugin { plugin: String },
    /// Wrapper around a sub-agent — `subagent.<name>` family.
    SubAgent { subagent: String },
}

impl ToolSource {
    pub fn is_default(&self) -> bool {
        matches!(self, ToolSource::Builtin)
    }
}

/// Finer-grained category for the Tool Catalog UI. Distinct from the
/// trait-level [`ToolCategory`] (which is read/write/exec/network and
/// drives Plan Mode filtering); this enum classifies *what kind of
/// product capability* the tool exposes so the catalog UI can group
/// related tools (`fs.read` + `fs.list` + `fs.search` under "File
/// Read", etc.).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolPackCategory {
    Search,
    Web,
    FileRead,
    FileWrite,
    CodeSearch,
    CodeEdit,
    Shell,
    Git,
    Project,
    Requirement,
    Todo,
    Doc,
    Memory,
    Skill,
    Cloud,
    Media,
    SubAgent,
    Mcp,
    #[default]
    Other,
}

impl ToolPackCategory {
    pub fn is_default(&self) -> bool {
        matches!(self, ToolPackCategory::Other)
    }
}

/// Risk class. Higher-risk tools should default to approval-gated
/// and surface a warning in the catalog UI. The mapping is *advice*
/// not policy — the actual approver gate is governed by
/// [`Tool::requires_approval`] and the configured `Approver`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolRisk {
    /// Pure observation. No state mutation, no outbound side
    /// effects. `fs.read`, `code.grep`, `git.diff`, `time.now`, …
    #[default]
    ReadOnly,
    /// Touches in-process metadata (TODOs, project rows, doc
    /// frontmatter). Recoverable / auditable but not free.
    MetadataWrite,
    /// Mutates the local workspace filesystem. `fs.write`,
    /// `fs.edit`, `fs.patch`.
    WorkspaceWrite,
    /// Spawns a subprocess. `shell.exec` and friends.
    Shell,
    /// Reads from / writes to the network. `http.fetch`, MCP
    /// remote tools whose semantics aren't introspected.
    Network,
    /// Causes side effects on external systems beyond simple HTTP
    /// (e.g. Slack post, GitHub PR, cloud mutation). MCP tools
    /// sourced from servers known to mutate external state.
    ExternalSideEffect,
    /// Reads or returns secrets. Today no in-tree tool is in this
    /// class; reserved for future credential-vault tools.
    SecretAccess,
}

/// One tool's catalog entry. Returned by `GET /v1/tools`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolMetadata {
    /// Wire name (e.g. `fs.read`, `github.create_pr`).
    pub name: String,
    /// Optional human-readable label. Defaults to `name` in the UI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// Description as advertised on the chat-completions tools
    /// array — copied from the underlying [`Tool::description`] at
    /// registration so the UI doesn't have to re-resolve.
    pub description: String,
    /// Side-effect class (Read / Write / Exec / Network) — mirrors
    /// the `Tool` trait method.
    pub trait_category: ToolCategory,
    /// Product-level grouping for catalog UI.
    #[serde(default, skip_serializing_if = "ToolPackCategory::is_default")]
    pub pack: ToolPackCategory,
    /// Where the tool came from.
    #[serde(
        default = "default_source",
        skip_serializing_if = "ToolSource::is_default"
    )]
    pub source: ToolSource,
    pub risk: ToolRisk,
    /// Whether the trait requested approval-gating. Mirrors the
    /// trait method at registration time.
    pub requires_approval: bool,
    /// Runtime enable/disable flag. Defaults to `true`. The admin
    /// route `PATCH /v1/tools/:name { enabled }` flips this — when
    /// set to `false` the registry's [`Tool::resolve`](crate::ToolRegistry::resolve)
    /// returns `None` and the LLM never sees the tool in `specs()`.
    /// Survives only in-process; restart returns to "all enabled".
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// JSON schema of the tool's argument object. Useful for the
    /// catalog UI to render an example invocation.
    pub input_schema: serde_json::Value,
    /// Whether the tool's spec is in the prompt cache window.
    /// Mirrors [`Tool::cacheable`].
    pub cacheable: bool,
    /// Whether this tool ends the agent's current turn (Plan Mode's
    /// exit-marker tool). Mirrors [`Tool::is_terminal`].
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_terminal: bool,
}

fn default_source() -> ToolSource {
    ToolSource::Builtin
}

fn default_true() -> bool {
    true
}

impl ToolMetadata {
    /// Build a default metadata snapshot from a registered tool.
    /// Source defaults to `Builtin` — callers that know better
    /// (the MCP bridge / plugin / subagent registrations) should
    /// override after construction.
    pub fn from_tool(tool: &dyn Tool) -> Self {
        let name = tool.name().to_string();
        let trait_category = tool.category();
        let requires_approval = tool.requires_approval();
        let pack = derive_pack(&name);
        let risk = derive_risk(&name, trait_category, requires_approval);
        Self {
            name,
            display_name: None,
            description: tool.description().to_string(),
            trait_category,
            pack,
            source: ToolSource::Builtin,
            risk,
            requires_approval,
            enabled: true,
            input_schema: tool.parameters(),
            cacheable: tool.cacheable(),
            is_terminal: tool.is_terminal(),
        }
    }

    pub fn with_source(mut self, source: ToolSource) -> Self {
        self.source = source;
        self
    }

    pub fn with_display_name(mut self, display_name: impl Into<String>) -> Self {
        self.display_name = Some(display_name.into());
        self
    }
}

/// Heuristic mapping from wire name to product pack. Keeps the
/// catalog grouping zero-config — the registrar gets it right for
/// every in-tree tool without having to wire the metadata manually.
pub fn derive_pack(name: &str) -> ToolPackCategory {
    if let Some((prefix, _)) = name.split_once('.') {
        match prefix {
            "fs" => {
                if name == "fs.read" || name == "fs.list" || name == "fs.search" {
                    ToolPackCategory::FileRead
                } else {
                    ToolPackCategory::FileWrite
                }
            }
            "code" => ToolPackCategory::CodeSearch,
            "shell" => ToolPackCategory::Shell,
            "git" => ToolPackCategory::Git,
            "http" | "web" | "browser" => ToolPackCategory::Web,
            "project" => ToolPackCategory::Project,
            "requirement" | "roadmap" | "triage_scan" | "triage" => ToolPackCategory::Requirement,
            "todo" => ToolPackCategory::Todo,
            "doc" => ToolPackCategory::Doc,
            "memory" => ToolPackCategory::Memory,
            "skill" => ToolPackCategory::Skill,
            "cloud" => ToolPackCategory::Cloud,
            "media" | "image" | "video" | "audio" => ToolPackCategory::Media,
            "subagent" | "codex" | "claude_code" | "reviewer" | "doc_reader" => {
                ToolPackCategory::SubAgent
            }
            "mcp" => ToolPackCategory::Mcp,
            _ => ToolPackCategory::Other,
        }
    } else {
        ToolPackCategory::Other
    }
}

/// Heuristic risk classification. Conservative: when in doubt,
/// returns the higher tier. Caller can override if the tool's
/// actual semantics warrant.
pub fn derive_risk(name: &str, trait_category: ToolCategory, requires_approval: bool) -> ToolRisk {
    // 1. Specific name overrides win first.
    match name {
        "shell.exec" | "shell.background" | "shell.kill" | "shell.logs" => return ToolRisk::Shell,
        "fs.write" | "fs.edit" | "fs.patch" => return ToolRisk::WorkspaceWrite,
        "http.fetch" | "web.search" | "web.extract" => return ToolRisk::Network,
        _ => {}
    }
    // 2. Prefix-based heuristics.
    if let Some(prefix) = name.split('.').next() {
        match prefix {
            "git" => {
                // Read-only git tools (status/diff/log/show) keep
                // ReadOnly; the write set (add/commit/merge/branch)
                // is approval-gated already.
                if requires_approval {
                    return ToolRisk::WorkspaceWrite;
                }
                return ToolRisk::ReadOnly;
            }
            "shell" => return ToolRisk::Shell,
            "subagent" | "codex" | "claude_code" | "reviewer" | "doc_reader" => {
                return ToolRisk::ExternalSideEffect;
            }
            "todo" | "project" | "requirement" | "doc" | "roadmap" | "triage" => {
                if requires_approval {
                    return ToolRisk::MetadataWrite;
                }
                // Pure metadata reads stay at ReadOnly even though
                // the namespace is "metadata".
                return ToolRisk::ReadOnly;
            }
            _ => {}
        }
    }
    // 3. Fall back to the trait-level category.
    match trait_category {
        ToolCategory::Read => ToolRisk::ReadOnly,
        ToolCategory::Write => {
            if requires_approval {
                ToolRisk::WorkspaceWrite
            } else {
                ToolRisk::MetadataWrite
            }
        }
        ToolCategory::Exec => ToolRisk::Shell,
        ToolCategory::Network => ToolRisk::Network,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fs_read_is_filereads_pack() {
        assert_eq!(derive_pack("fs.read"), ToolPackCategory::FileRead);
        assert_eq!(derive_pack("fs.list"), ToolPackCategory::FileRead);
        assert_eq!(derive_pack("fs.search"), ToolPackCategory::FileRead);
    }

    #[test]
    fn fs_write_is_filewrite_pack() {
        assert_eq!(derive_pack("fs.write"), ToolPackCategory::FileWrite);
        assert_eq!(derive_pack("fs.edit"), ToolPackCategory::FileWrite);
        assert_eq!(derive_pack("fs.patch"), ToolPackCategory::FileWrite);
    }

    #[test]
    fn shell_exec_classified_as_shell_risk() {
        assert_eq!(
            derive_risk("shell.exec", ToolCategory::Exec, true),
            ToolRisk::Shell
        );
    }

    #[test]
    fn fs_write_classified_as_workspace_write_risk() {
        assert_eq!(
            derive_risk("fs.write", ToolCategory::Write, true),
            ToolRisk::WorkspaceWrite
        );
    }

    #[test]
    fn http_fetch_is_network_risk() {
        assert_eq!(
            derive_risk("http.fetch", ToolCategory::Network, false),
            ToolRisk::Network
        );
    }

    #[test]
    fn read_only_git_stays_readonly() {
        assert_eq!(
            derive_risk("git.status", ToolCategory::Read, false),
            ToolRisk::ReadOnly,
        );
        assert_eq!(
            derive_risk("git.commit", ToolCategory::Write, true),
            ToolRisk::WorkspaceWrite,
        );
    }

    #[test]
    fn subagent_is_external_side_effect() {
        assert_eq!(
            derive_risk("subagent.review", ToolCategory::Write, true),
            ToolRisk::ExternalSideEffect,
        );
    }

    #[test]
    fn metadata_serde_round_trip() {
        let m = ToolMetadata {
            name: "fs.read".into(),
            display_name: None,
            description: "Read a file".into(),
            trait_category: ToolCategory::Read,
            pack: ToolPackCategory::FileRead,
            source: ToolSource::Builtin,
            risk: ToolRisk::ReadOnly,
            requires_approval: false,
            enabled: true,
            input_schema: serde_json::json!({"type": "object"}),
            cacheable: true,
            is_terminal: false,
        };
        let s = serde_json::to_string(&m).unwrap();
        let back: ToolMetadata = serde_json::from_str(&s).unwrap();
        assert_eq!(back.name, "fs.read");
        assert_eq!(back.risk, ToolRisk::ReadOnly);
        assert_eq!(back.pack, ToolPackCategory::FileRead);
    }

    #[test]
    fn mcp_source_round_trips() {
        let src = ToolSource::Mcp {
            server: "github".into(),
        };
        let s = serde_json::to_string(&src).unwrap();
        let back: ToolSource = serde_json::from_str(&s).unwrap();
        assert_eq!(back, src);
    }
}
