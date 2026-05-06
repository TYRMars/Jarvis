//! `roadmap.import` — bootstrap the workspace's roadmap as Work
//! Requirements.
//!
//! Thin tool wrapper around
//! [`harness_requirement::import_proposals`]. The tool is registered
//! when both [`BuiltinsConfig::project_store`](crate::BuiltinsConfig)
//! and `requirement_store` are set; without either, the import has
//! nothing to write to.
//!
//! Posture: `ToolCategory::Write`, approval-gated. Bulk-writes a
//! Project plus N Requirements; the user should consciously approve.
//! Subsequent invocations are idempotent (a hidden marker in each
//! Requirement's `description` lets the import find existing rows
//! and skip / update them).

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use harness_core::{BoxError, ProjectStore, RequirementStore, Tool, ToolCategory};
use harness_requirement::{import_proposals, ImportOptions};
use serde_json::{json, Value};

pub struct RoadmapImportTool {
    projects: Arc<dyn ProjectStore>,
    requirements: Arc<dyn RequirementStore>,
    workspace_root: PathBuf,
}

impl RoadmapImportTool {
    pub fn new(
        projects: Arc<dyn ProjectStore>,
        requirements: Arc<dyn RequirementStore>,
        workspace_root: impl Into<PathBuf>,
    ) -> Self {
        Self {
            projects,
            requirements,
            workspace_root: workspace_root.into(),
        }
    }
}

#[async_trait]
impl Tool for RoadmapImportTool {
    fn name(&self) -> &str {
        "roadmap.import"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    fn requires_approval(&self) -> bool {
        true
    }

    fn description(&self) -> &str {
        "Bootstrap the current workspace's roadmap into Work: scan \
         `docs/proposals/*.md` (or `docs/roadmap/`, `roadmap/`, or \
         `ROADMAP.md`), parse each file's `**Status:**` line, and \
         create/update one Requirement per proposal under a \
         workspace-derived Project (slug `<workspace>-roadmap`). \
         Idempotent — re-runs only update Requirements whose \
         title/description/status changed. Returns a summary with \
         `{project_id, slug, name, created, updated, unchanged, total, items}`. \
         Run this once to set up Work tracking for any project."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "slug": {
                    "type": "string",
                    "description": "Override the auto-derived Project slug (defaults to `<workspace-basename>-roadmap`)."
                },
                "name": {
                    "type": "string",
                    "description": "Override the auto-derived Project display name."
                },
                "source_subdir": {
                    "type": "string",
                    "description": "Override the source path (relative to workspace root). Default discovery: docs/proposals → docs/roadmap → roadmap → ROADMAP.md."
                },
                "prune": {
                    "type": "boolean",
                    "description": "Delete imported Requirements whose source file no longer exists. Defaults to false (manual edits stay untouched)."
                }
            }
        })
    }

    fn summary_for_audit(&self, args: &Value) -> Option<String> {
        let mut bits: Vec<String> = Vec::new();
        if let Some(s) = args.get("slug").and_then(|v| v.as_str()) {
            bits.push(format!("slug={s}"));
        }
        if let Some(s) = args.get("source_subdir").and_then(|v| v.as_str()) {
            bits.push(format!("source={s}"));
        }
        if args.get("prune").and_then(|v| v.as_bool()).unwrap_or(false) {
            bits.push("prune=true".into());
        }
        if bits.is_empty() {
            Some("workspace defaults".into())
        } else {
            Some(bits.join(", "))
        }
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let opts: ImportOptions = if args.is_null() {
            ImportOptions::default()
        } else {
            serde_json::from_value(args)
                .map_err(|e| -> BoxError { format!("roadmap.import: bad args: {e}").into() })?
        };
        let workspace = harness_core::active_workspace_or(&self.workspace_root);
        let summary =
            import_proposals(&workspace, &self.projects, &self.requirements, opts).await?;
        Ok(serde_json::to_string_pretty(&summary)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_store::{MemoryProjectStore, MemoryRequirementStore};
    use tempfile::tempdir;

    #[tokio::test]
    async fn import_tool_creates_requirements_for_present_proposals() {
        let outer = tempdir().unwrap();
        let workspace = outer.path().join("acme");
        let proposals = workspace.join("docs/proposals");
        std::fs::create_dir_all(&proposals).unwrap();
        std::fs::write(
            proposals.join("widget.md"),
            "# Widget\n\n**Status:** Adopted\n\nIt ships.\n",
        )
        .unwrap();

        let projects: Arc<dyn ProjectStore> = Arc::new(MemoryProjectStore::new());
        let requirements: Arc<dyn RequirementStore> = Arc::new(MemoryRequirementStore::new());
        let tool = RoadmapImportTool::new(projects.clone(), requirements.clone(), workspace);

        let out: Value = serde_json::from_str(&tool.invoke(json!({})).await.unwrap()).unwrap();
        assert_eq!(out["slug"], "acme-roadmap");
        assert_eq!(out["created"], 1);
        let req = &requirements
            .list(out["project_id"].as_str().unwrap())
            .await
            .unwrap()[0];
        assert_eq!(req.title, "Widget");
    }

    #[tokio::test]
    async fn import_tool_honours_explicit_slug_override() {
        let outer = tempdir().unwrap();
        let workspace = outer.path().join("acme");
        std::fs::create_dir_all(&workspace).unwrap();
        let projects: Arc<dyn ProjectStore> = Arc::new(MemoryProjectStore::new());
        let requirements: Arc<dyn RequirementStore> = Arc::new(MemoryRequirementStore::new());
        let tool = RoadmapImportTool::new(projects, requirements, workspace);

        let out: Value = serde_json::from_str(
            &tool
                .invoke(json!({ "slug": "acme-product-roadmap" }))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(out["slug"], "acme-product-roadmap");
    }
}
