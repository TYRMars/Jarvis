//! Read-only file inspection endpoints for the Files panel in the
//! right rail. Two routes, both keyed off `AppState::workspace_root`
//! with a per-request `?root=<abs>` override (mirrors the diff
//! endpoints):
//!
//! - `GET /v1/workspace/list?root=<abs>&dir=<rel>` — directory
//!   listing. Returns `{root, dir, parent, entries: [{name, kind,
//!   size?, mtime?}]}`. Sandboxed via the same `..`/absolute-path
//!   rejection as the `fs.*` agent tools, with one extra rule: the
//!   `.git` directory is filtered out so the user doesn't waste
//!   clicks expanding it.
//!
//! - `GET /v1/workspace/read?root=<abs>&path=<rel>` — file read.
//!   Caps at 1 MiB and reports `truncated`/`binary` on the wire so
//!   the UI can render a placeholder for binary files instead of a
//!   garbled hex dump. `binary` is a NUL-byte heuristic on the
//!   first 8 KiB — same one Git uses.
//!
//! Both routes are read-only; they don't need an approval gate.

use std::path::{Component, Path, PathBuf};

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::get,
    Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::fs;

use crate::state::AppState;

/// Hard cap on a single file read. Anything bigger gets truncated
/// (with a sentinel) so the client doesn't OOM rendering a huge
/// generated file.
const MAX_READ_BYTES: usize = 1024 * 1024;

/// First-byte budget for binary detection. Same heuristic Git uses:
/// any NUL byte in the leading window flips the file to "binary".
const BINARY_SNIFF_BYTES: usize = 8 * 1024;

/// Cap on how many entries one directory listing returns. Pathological
/// directories (`node_modules`, `target/debug/deps`) can have tens of
/// thousands of files and rendering them all in the panel is useless.
const MAX_ENTRIES_PER_DIR: usize = 2000;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/workspace/list", get(list_dir))
        .route("/v1/workspace/read", get(read_file))
}

#[derive(Debug, Deserialize)]
struct ListQuery {
    /// Absolute path to the workspace root. Optional — falls back to
    /// `AppState::workspace_root` when absent.
    root: Option<String>,
    /// Subdirectory relative to root. Empty / absent = the root itself.
    dir: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ReadQuery {
    root: Option<String>,
    path: String,
}

#[derive(Debug, Serialize)]
struct Entry {
    name: String,
    /// `dir` | `file` | `symlink` | `other`. We don't follow
    /// symlinks here — `fs::metadata` does follow, so we use
    /// `symlink_metadata` to classify and return the link target's
    /// kind only when the user actually opens the file.
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
    /// Best-effort modification time (RFC-3339). None for FS that
    /// don't expose mtime or for entries we couldn't stat.
    #[serde(skip_serializing_if = "Option::is_none")]
    mtime: Option<String>,
}

fn bad_request(msg: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response()
}

fn server_error(msg: impl std::fmt::Display) -> Response {
    tracing::warn!(error = %msg, "workspace files failed");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": msg.to_string() })),
    )
        .into_response()
}

/// Re-implement the diff endpoint's `resolve_workspace` shape locally
/// so this module doesn't reach into a sibling module's privates.
/// Keeps the security policy explicit at each entry point.
#[allow(clippy::result_large_err)]
fn resolve_workspace(
    state: &AppState,
    override_root: Option<&str>,
) -> Result<PathBuf, Response> {
    if let Some(raw) = override_root {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(bad_request("`root` must not be empty"));
        }
        if trimmed.contains(['\0', '\n', '\r']) {
            return Err(bad_request("`root` contains forbidden characters"));
        }
        if !Path::new(trimmed).is_absolute() {
            return Err(bad_request("`root` must be an absolute path"));
        }
        let canonical = std::fs::canonicalize(trimmed)
            .map_err(|e| bad_request(&format!("`root` does not resolve: {e}")))?;
        if !canonical.is_dir() {
            return Err(bad_request("`root` is not a directory"));
        }
        return Ok(canonical);
    }
    state.workspace_root.clone().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "workspace root not configured" })),
        )
            .into_response()
    })
}

/// Reject path traversal / absolute paths the same way `fs.*` tools
/// do via `sandbox::resolve_under`. Empty input is fine here (means
/// "the root itself") — the caller decides whether that's allowed.
fn safe_relative(rel: &str) -> Result<&str, &'static str> {
    if rel.starts_with('/') {
        return Err("path must be relative to the workspace root");
    }
    if rel.contains(['\0', '\n']) {
        return Err("path contains forbidden characters");
    }
    let p = Path::new(rel);
    for comp in p.components() {
        match comp {
            Component::ParentDir => return Err("path must not contain `..`"),
            Component::Prefix(_) | Component::RootDir => {
                return Err("absolute path components are not allowed");
            }
            _ => {}
        }
    }
    Ok(rel)
}

// ----------------------------------------------------------------------
// GET /v1/workspace/list
// ----------------------------------------------------------------------

async fn list_dir(State(state): State<AppState>, Query(q): Query<ListQuery>) -> Response {
    let root = match resolve_workspace(&state, q.root.as_deref()) {
        Ok(r) => r,
        Err(r) => return r,
    };
    let dir_rel_owned = q.dir.unwrap_or_default();
    let dir_rel = match safe_relative(&dir_rel_owned) {
        Ok(s) => s,
        Err(e) => return bad_request(e),
    };

    let target = if dir_rel.is_empty() {
        root.clone()
    } else {
        root.join(dir_rel)
    };

    let mut read_dir = match fs::read_dir(&target).await {
        Ok(r) => r,
        Err(e) => return server_error(format!("read_dir({}): {e}", target.display())),
    };

    let mut entries: Vec<Entry> = Vec::new();
    let mut truncated = false;
    while entries.len() < MAX_ENTRIES_PER_DIR {
        let next = match read_dir.next_entry().await {
            Ok(Some(e)) => e,
            Ok(None) => break,
            Err(e) => return server_error(format!("next_entry: {e}")),
        };
        let name = match next.file_name().into_string() {
            Ok(s) => s,
            Err(_) => continue, // skip non-UTF-8 names
        };
        // Hide noisy directories the user almost never wants to expand.
        if dir_rel.is_empty() && name == ".git" {
            continue;
        }
        let meta = match next.metadata().await {
            Ok(m) => m,
            Err(_) => continue,
        };
        let kind = if meta.file_type().is_symlink() {
            "symlink"
        } else if meta.is_dir() {
            "dir"
        } else if meta.is_file() {
            "file"
        } else {
            "other"
        };
        let size = if meta.is_file() { Some(meta.len()) } else { None };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339().into());
        entries.push(Entry { name, kind, size, mtime });
    }
    if read_dir.next_entry().await.ok().flatten().is_some() {
        truncated = true;
    }

    // Sort: directories first, then alphabetically, case-insensitive.
    entries.sort_by(|a, b| {
        match (a.kind, b.kind) {
            ("dir", k) if k != "dir" => std::cmp::Ordering::Less,
            (k, "dir") if k != "dir" => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    let parent = if dir_rel.is_empty() {
        None
    } else {
        Path::new(dir_rel)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
    };

    Json(json!({
        "root": root.to_string_lossy(),
        "dir": dir_rel,
        "parent": parent,
        "entries": entries,
        "truncated": truncated,
    }))
    .into_response()
}

// ----------------------------------------------------------------------
// GET /v1/workspace/read
// ----------------------------------------------------------------------

async fn read_file(State(state): State<AppState>, Query(q): Query<ReadQuery>) -> Response {
    let root = match resolve_workspace(&state, q.root.as_deref()) {
        Ok(r) => r,
        Err(r) => return r,
    };
    let rel = match safe_relative(&q.path) {
        Ok(s) => s,
        Err(e) => return bad_request(e),
    };
    if rel.is_empty() {
        return bad_request("path must not be empty");
    }
    let target = root.join(rel);

    let meta = match fs::metadata(&target).await {
        Ok(m) => m,
        Err(e) => return server_error(format!("stat({}): {e}", target.display())),
    };
    if meta.is_dir() {
        return bad_request("path is a directory; use /v1/workspace/list");
    }
    let size = meta.len();

    let bytes = match fs::read(&target).await {
        Ok(b) => b,
        Err(e) => return server_error(format!("read({}): {e}", target.display())),
    };

    let sniff_end = bytes.len().min(BINARY_SNIFF_BYTES);
    let binary = bytes[..sniff_end].contains(&0);
    if binary {
        return Json(json!({
            "path": rel,
            "size": size,
            "binary": true,
            "truncated": false,
            "content": "",
        }))
        .into_response();
    }

    let truncated = bytes.len() > MAX_READ_BYTES;
    let slice = if truncated { &bytes[..MAX_READ_BYTES] } else { &bytes[..] };
    // Lossy is safe here: we already proved there are no NUL bytes
    // in the sniff window, but trailing UTF-8 multibyte sequences
    // can still split at the truncation boundary.
    let mut content = String::from_utf8_lossy(slice).to_string();
    if truncated {
        content.push_str("\n[... truncated; file larger than read cap ...]\n");
    }

    Json(json!({
        "path": rel,
        "size": size,
        "binary": false,
        "truncated": truncated,
        "content": content,
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_relative_blocks_traversal() {
        assert!(safe_relative("src/foo.rs").is_ok());
        assert!(safe_relative("").is_ok());
        assert!(safe_relative("/etc/passwd").is_err());
        assert!(safe_relative("../etc").is_err());
        assert!(safe_relative("a/../../b").is_err());
        assert!(safe_relative("a\nb").is_err());
    }
}
