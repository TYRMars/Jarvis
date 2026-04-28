//! `project.checks` — suggest test / lint / build commands based on
//! the manifests present in the workspace.
//!
//! Strictly **suggestion-only**: this tool returns a JSON list of
//! commands the model could plausibly run, without executing
//! anything. The model decides whether to actually invoke
//! `shell.exec` (which has its own approval gate). Keeps the
//! "model knows what to run" knowledge out of the model and in
//! one inspectable allowlist.
//!
//! Always-on, read-only — same posture as `workspace.context`.
//! Detection mirrors that tool's MANIFEST_FILES + container-dir
//! conventions so what the model sees here lines up with what it
//! sees from `workspace.context`.

use std::path::PathBuf;

use async_trait::async_trait;
use harness_core::{BoxError, Tool, ToolCategory};
use serde::Serialize;
use serde_json::{json, Value};

pub struct ProjectChecksTool {
    root: PathBuf,
}

impl ProjectChecksTool {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
}

#[derive(Serialize)]
struct Suggestion {
    /// Manifest filename that triggered the suggestion (relative to root).
    manifest: String,
    /// Short label for the kind of check (`"test"` / `"lint"` / `"build"` / `"check"`).
    kind: &'static str,
    /// Shell command line to run from the workspace root.
    command: String,
    /// One-line rationale.
    why: &'static str,
}

#[async_trait]
impl Tool for ProjectChecksTool {
    fn name(&self) -> &str {
        "project.checks"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    fn description(&self) -> &str {
        "Suggest project-appropriate test / lint / build commands \
         based on the manifests present in the workspace. \
         Read-only — returns a JSON list of `{manifest, kind, command, why}` \
         entries. Does NOT execute anything; pair with `shell.exec` \
         (approval-gated) to actually run a suggested command."
    }

    fn parameters(&self) -> Value {
        json!({ "type": "object", "properties": {} })
    }

    fn cacheable(&self) -> bool {
        true
    }

    async fn invoke(&self, _args: Value) -> Result<String, BoxError> {
        let root = self.root.clone();
        let suggestions = tokio::task::spawn_blocking(move || gather(&root))
            .await
            .map_err(|e| -> BoxError { format!("checks task panicked: {e}").into() })?;

        let payload = json!({ "suggestions": suggestions });
        serde_json::to_string_pretty(&payload)
            .map_err(|e| -> BoxError { format!("serialize checks: {e}").into() })
    }
}

fn gather(root: &std::path::Path) -> Vec<Suggestion> {
    let canonical = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let mut out = Vec::new();
    let mut seen_kinds: Vec<(&str, &str)> = Vec::new();

    let mut record = |s: Suggestion, seen: &mut Vec<(&'static str, &'static str)>| {
        // Dedup on (manifest_kind, kind) — if a monorepo has 12
        // package.jsons we don't want 36 lint suggestions; the
        // model can shell out to per-package commands itself.
        let m_kind: &'static str = match s.manifest.split('/').next_back().unwrap_or("") {
            "Cargo.toml" => "cargo",
            "package.json" => "npm",
            "pyproject.toml" => "python",
            "go.mod" => "go",
            _ => "other",
        };
        if seen.contains(&(m_kind, s.kind)) {
            return;
        }
        seen.push((m_kind, s.kind));
        out.push(s);
    };

    // Root-level manifests first. These get rich, opinionated
    // suggestions because they're the canonical "the whole project"
    // entry point.
    if canonical.join("Cargo.toml").is_file() {
        record(
            Suggestion {
                manifest: "Cargo.toml".into(),
                kind: "check",
                command: "cargo check --workspace".into(),
                why: "Fast type check across all crates; catches compile errors without running tests.",
            },
            &mut seen_kinds,
        );
        record(
            Suggestion {
                manifest: "Cargo.toml".into(),
                kind: "lint",
                command: "cargo clippy --workspace --all-targets -- -D warnings".into(),
                why: "Project lint gate: clippy with warnings-as-errors across every target.",
            },
            &mut seen_kinds,
        );
        record(
            Suggestion {
                manifest: "Cargo.toml".into(),
                kind: "test",
                command: "cargo test --workspace".into(),
                why: "Run all unit + integration tests across the workspace.",
            },
            &mut seen_kinds,
        );
    }
    if canonical.join("package.json").is_file() {
        record(
            Suggestion {
                manifest: "package.json".into(),
                kind: "test",
                command: "npm test".into(),
                why: "Standard npm test entry; check `package.json:scripts.test` to confirm.",
            },
            &mut seen_kinds,
        );
        record(
            Suggestion {
                manifest: "package.json".into(),
                kind: "lint",
                command: "npm run lint".into(),
                why: "Conventional `lint` script; safe no-op if not defined.",
            },
            &mut seen_kinds,
        );
        record(
            Suggestion {
                manifest: "package.json".into(),
                kind: "build",
                command: "npm run build".into(),
                why: "Conventional `build` script; produces shippable artifacts.",
            },
            &mut seen_kinds,
        );
    }
    if canonical.join("pyproject.toml").is_file() {
        record(
            Suggestion {
                manifest: "pyproject.toml".into(),
                kind: "test",
                command: "pytest".into(),
                why: "Default Python test runner; respects `pyproject.toml:[tool.pytest]`.",
            },
            &mut seen_kinds,
        );
        record(
            Suggestion {
                manifest: "pyproject.toml".into(),
                kind: "lint",
                command: "ruff check .".into(),
                why: "Fast Python linter; honours `[tool.ruff]` if present, otherwise defaults.",
            },
            &mut seen_kinds,
        );
    }
    if canonical.join("go.mod").is_file() {
        record(
            Suggestion {
                manifest: "go.mod".into(),
                kind: "test",
                command: "go test ./...".into(),
                why: "Run all Go tests under the module.",
            },
            &mut seen_kinds,
        );
        record(
            Suggestion {
                manifest: "go.mod".into(),
                kind: "lint",
                command: "go vet ./...".into(),
                why: "Built-in static checker; flags suspicious constructs.",
            },
            &mut seen_kinds,
        );
        record(
            Suggestion {
                manifest: "go.mod".into(),
                kind: "build",
                command: "go build ./...".into(),
                why: "Compile every package without producing binaries.",
            },
            &mut seen_kinds,
        );
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn rust_workspace_emits_cargo_suggestions() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("Cargo.toml"), "[workspace]\n").unwrap();
        let tool = ProjectChecksTool::new(dir.path());
        let out: Value = serde_json::from_str(&tool.invoke(json!({})).await.unwrap()).unwrap();
        let cmds: Vec<&str> = out["suggestions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["command"].as_str().unwrap())
            .collect();
        assert!(cmds.iter().any(|c| c.starts_with("cargo check")));
        assert!(cmds.iter().any(|c| c.contains("clippy")));
        assert!(cmds.iter().any(|c| c.starts_with("cargo test")));
    }

    #[tokio::test]
    async fn empty_workspace_returns_empty_list() {
        let dir = tempdir().unwrap();
        let tool = ProjectChecksTool::new(dir.path());
        let out: Value = serde_json::from_str(&tool.invoke(json!({})).await.unwrap()).unwrap();
        assert_eq!(out["suggestions"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn polyglot_repo_emits_per_ecosystem_suggestions() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("Cargo.toml"), "[workspace]\n").unwrap();
        std::fs::write(dir.path().join("package.json"), "{}\n").unwrap();
        let tool = ProjectChecksTool::new(dir.path());
        let out: Value = serde_json::from_str(&tool.invoke(json!({})).await.unwrap()).unwrap();
        let manifests: Vec<&str> = out["suggestions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["manifest"].as_str().unwrap())
            .collect();
        assert!(manifests.contains(&"Cargo.toml"));
        assert!(manifests.contains(&"package.json"));
    }
}
