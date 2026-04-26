//! On-disk JSON-file [`ConversationStore`](harness_core::ConversationStore).
//!
//! One JSON file per conversation, all in one directory. The simplest
//! possible "real" backend — no external dependency, no migrations,
//! no daemon. Suited to single-user / dev / "I just want it to work"
//! deployments. For multi-process or large-scale use, prefer the
//! sqlite / postgres / mysql backends.
//!
//! ## Layout
//!
//! ```text
//! <dir>/
//!   <id>.json                # one per conversation
//!   <id>.json.tmp            # transient, only during writes
//! ```
//!
//! ## ID → filename
//!
//! The harness uses arbitrary strings as conversation ids (UUIDs by
//! default, but `__memory__.summary:<hash>` for the summary cache).
//! `:` is illegal on Windows filenames, so we **percent-encode** any
//! byte that isn't `[A-Za-z0-9._-]` for the filename, and decode
//! again on `list()`. UUIDs round-trip without any escaping.
//!
//! ## Atomicity
//!
//! Writes go to `<id>.json.tmp` first and rename onto `<id>.json` —
//! a crash mid-write leaves the previous good file untouched.
//! Concurrent writers to the same id race; last-write-wins is the
//! contract (the trait offers no read-modify-write semantics).

use std::path::PathBuf;

use async_trait::async_trait;
use chrono::Utc;
use harness_core::{BoxError, Conversation, ConversationRecord, ConversationStore, Message};
use serde::{Deserialize, Serialize};

use crate::error::StoreError;

pub struct JsonFileConversationStore {
    dir: PathBuf,
}

impl JsonFileConversationStore {
    /// Open or create a store at `dir`. The directory is created
    /// (recursively) if missing; existing files are not touched.
    pub fn open(dir: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let dir = dir.into();
        std::fs::create_dir_all(&dir).map_err(|e| {
            StoreError::Other(format!("create {}: {e}", dir.display()).into())
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perm = std::fs::Permissions::from_mode(0o700);
            let _ = std::fs::set_permissions(&dir, perm);
        }
        Ok(Self { dir })
    }

    fn path_for(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{}.json", encode_id(id)))
    }
}

/// On-disk shape: id + timestamps + the existing `Conversation`
/// payload. We keep timestamps inside the file (not from filesystem
/// `mtime`) because the filesystem's clock isn't ours.
#[derive(Debug, Serialize, Deserialize)]
struct StoredConversation {
    id: String,
    created_at: String,
    updated_at: String,
    messages: Vec<Message>,
}

#[async_trait]
impl ConversationStore for JsonFileConversationStore {
    async fn save(&self, id: &str, conversation: &Conversation) -> Result<(), BoxError> {
        let path = self.path_for(id);
        let now = Utc::now().to_rfc3339();
        // Preserve created_at across overwrites.
        let created_at = match tokio::fs::read(&path).await {
            Ok(bytes) => match serde_json::from_slice::<StoredConversation>(&bytes) {
                Ok(s) => s.created_at,
                Err(_) => now.clone(),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => now.clone(),
            Err(e) => return Err(Box::new(e)),
        };

        let stored = StoredConversation {
            id: id.to_string(),
            created_at,
            updated_at: now,
            messages: conversation.messages.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&stored).map_err(StoreError::from)?;

        let tmp = path.with_extension("json.tmp");
        tokio::fs::write(&tmp, &bytes).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perm = std::fs::Permissions::from_mode(0o600);
            let _ = tokio::fs::set_permissions(&tmp, perm).await;
        }
        tokio::fs::rename(&tmp, &path).await?;
        Ok(())
    }

    async fn load(&self, id: &str) -> Result<Option<Conversation>, BoxError> {
        let path = self.path_for(id);
        let bytes = match tokio::fs::read(&path).await {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(Box::new(e)),
        };
        let stored: StoredConversation = serde_json::from_slice(&bytes)
            .map_err(StoreError::from)?;
        Ok(Some(Conversation {
            messages: stored.messages,
        }))
    }

    async fn list(&self, limit: u32) -> Result<Vec<ConversationRecord>, BoxError> {
        let mut entries: Vec<ConversationRecord> = Vec::new();
        let mut dir = match tokio::fs::read_dir(&self.dir).await {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(Box::new(e)),
        };
        while let Some(entry) = dir.next_entry().await? {
            let path = entry.path();
            // skip directories, .tmp files, anything not ending in .json
            if !path.extension().is_some_and(|e| e == "json") {
                continue;
            }
            let name = match path.file_name().and_then(|s| s.to_str()) {
                Some(n) => n,
                None => continue,
            };
            if name.ends_with(".json.tmp") {
                continue;
            }
            let bytes = match tokio::fs::read(&path).await {
                Ok(b) => b,
                Err(_) => continue,
            };
            let stored: StoredConversation = match serde_json::from_slice(&bytes) {
                Ok(s) => s,
                Err(_) => continue,
            };
            entries.push(ConversationRecord {
                id: stored.id,
                created_at: stored.created_at,
                updated_at: stored.updated_at,
                message_count: stored.messages.len(),
            });
        }
        // Newest first by updated_at — RFC 3339 strings are
        // lexicographically comparable.
        entries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        entries.truncate(limit as usize);
        Ok(entries)
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        let path = self.path_for(id);
        match tokio::fs::remove_file(&path).await {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(Box::new(e)),
        }
    }
}

// ---------- id <-> filename ----------

/// Percent-encode any byte that isn't `[A-Za-z0-9._-]`. UUIDs and
/// most random ids pass through unchanged; `:` (used by the
/// `__memory__.summary:` namespace) becomes `%3A`.
fn encode_id(id: &str) -> String {
    let mut out = String::with_capacity(id.len());
    for b in id.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_') {
            out.push(b as char);
        } else {
            use std::fmt::Write;
            let _ = write!(out, "%{:02X}", b);
        }
    }
    out
}

/// Inverse of `encode_id`. Returns `None` on malformed input
/// (truncated `%XX`, non-hex). Used only for sanity checks in tests
/// — `list()` reads ids out of the file body, not the filename.
#[cfg(test)]
fn decode_id(name: &str) -> Option<String> {
    let bytes = name.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = (bytes[i + 1] as char).to_digit(16)?;
            let lo = (bytes[i + 2] as char).to_digit(16)?;
            out.push(((hi * 16 + lo) & 0xff) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_core::Message;
    use tempfile::tempdir;

    fn convo(content: &str) -> Conversation {
        let mut c = Conversation::new();
        c.push(Message::user(content));
        c
    }

    #[tokio::test]
    async fn save_load_round_trip() {
        let dir = tempdir().unwrap();
        let store = JsonFileConversationStore::open(dir.path()).unwrap();

        store.save("c1", &convo("hello")).await.unwrap();
        let loaded = store.load("c1").await.unwrap().unwrap();
        assert_eq!(loaded.messages.len(), 1);
    }

    #[tokio::test]
    async fn save_overwrites_and_preserves_created_at() {
        let dir = tempdir().unwrap();
        let store = JsonFileConversationStore::open(dir.path()).unwrap();

        store.save("c1", &convo("first")).await.unwrap();
        let first_created = first_record(&store).await.created_at;
        // tiny sleep so updated_at differs
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;

        store.save("c1", &convo("second")).await.unwrap();
        let updated = first_record(&store).await;
        assert_eq!(updated.created_at, first_created);
        assert!(updated.updated_at > first_created);
    }

    #[tokio::test]
    async fn list_orders_newest_first() {
        let dir = tempdir().unwrap();
        let store = JsonFileConversationStore::open(dir.path()).unwrap();

        store.save("a", &convo("x")).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        store.save("b", &convo("y")).await.unwrap();

        let rows = store.list(10).await.unwrap();
        let ids: Vec<_> = rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["b", "a"]);
    }

    #[tokio::test]
    async fn list_respects_limit() {
        let dir = tempdir().unwrap();
        let store = JsonFileConversationStore::open(dir.path()).unwrap();
        for i in 0..5 {
            store.save(&format!("c{i}"), &convo("x")).await.unwrap();
        }
        let rows = store.list(3).await.unwrap();
        assert_eq!(rows.len(), 3);
    }

    #[tokio::test]
    async fn delete_idempotent_and_reports_existence() {
        let dir = tempdir().unwrap();
        let store = JsonFileConversationStore::open(dir.path()).unwrap();

        store.save("c1", &convo("x")).await.unwrap();
        assert!(store.delete("c1").await.unwrap());
        assert!(store.load("c1").await.unwrap().is_none());
        assert!(!store.delete("c1").await.unwrap());
    }

    #[tokio::test]
    async fn handles_internal_namespace_ids_with_colons() {
        // `__memory__.summary:<hash>` is the SummarizingMemory key
        // shape. ":" is illegal on Windows filenames; percent-
        // encoding has to round-trip.
        let dir = tempdir().unwrap();
        let store = JsonFileConversationStore::open(dir.path()).unwrap();

        let id = "__memory__.summary:abcdef0123456789";
        store.save(id, &convo("summary text")).await.unwrap();
        let loaded = store.load(id).await.unwrap().unwrap();
        assert_eq!(loaded.messages.len(), 1);

        // The on-disk filename should NOT contain a literal colon.
        let mut found_filename = None;
        for entry in std::fs::read_dir(dir.path()).unwrap() {
            let entry = entry.unwrap();
            let name = entry.file_name().into_string().unwrap();
            if name.ends_with(".json") {
                found_filename = Some(name);
                break;
            }
        }
        let name = found_filename.expect("no .json file written");
        assert!(!name.contains(':'), "filename leaked a colon: {name}");
        assert!(name.contains("%3A"), "expected %3A escape, got {name}");

        // Round trip via list() returns the original id.
        let rows = store.list(10).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, id);
    }

    #[tokio::test]
    async fn list_skips_tmp_and_unparseable_files() {
        let dir = tempdir().unwrap();
        let store = JsonFileConversationStore::open(dir.path()).unwrap();

        store.save("good", &convo("x")).await.unwrap();
        std::fs::write(dir.path().join("c1.json.tmp"), b"not real").unwrap();
        std::fs::write(dir.path().join("garbage.json"), b"{ not json").unwrap();

        let rows = store.list(10).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "good");
    }

    #[test]
    fn encode_decode_round_trip() {
        for raw in [
            "uuid-style-7b6f8e9c",
            "__memory__.summary:abc123",
            "weird/path",
            "with spaces and !@#",
            "中文",
        ] {
            let enc = encode_id(raw);
            let dec = decode_id(&enc).expect("decode");
            assert_eq!(dec, raw, "round trip failed for {raw:?}");
        }
    }

    async fn first_record(store: &JsonFileConversationStore) -> ConversationRecord {
        let rows = store.list(1).await.unwrap();
        rows.into_iter().next().expect("no records")
    }
}
