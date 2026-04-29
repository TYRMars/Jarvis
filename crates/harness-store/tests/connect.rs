//! Integration tests for the `connect(url)` dispatcher.
//!
//! We only exercise backends that don't need an external server: in-memory
//! SQLite and a file-backed SQLite in a tempdir. Postgres/MySQL are covered
//! by whatever CI environment has those services available.

use harness_core::{Conversation, Message};
use harness_store::{connect, StoreError};

#[cfg(feature = "sqlite")]
#[tokio::test]
async fn connect_sqlite_memory() {
    let store = connect("sqlite::memory:").await.unwrap();
    let mut conv = Conversation::new();
    conv.push(Message::user("ping"));
    store.save("id1", &conv).await.unwrap();
    let loaded = store.load("id1").await.unwrap().unwrap();
    assert_eq!(loaded.messages.len(), 1);
}

#[cfg(feature = "sqlite")]
#[tokio::test]
async fn connect_sqlite_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("jarvis.db");
    let url = format!("sqlite://{}", path.display());

    let store = connect(&url).await.unwrap();
    let mut conv = Conversation::new();
    conv.push(Message::user("hello"));
    store.save("abc", &conv).await.unwrap();
    drop(store);

    // Reopen the same file and make sure the row survived.
    let store = connect(&url).await.unwrap();
    let loaded = store.load("abc").await.unwrap().unwrap();
    assert_eq!(loaded.messages.len(), 1);

    let rows = store.list(10).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, "abc");
    assert_eq!(rows[0].message_count, 1);
}

#[tokio::test]
async fn connect_json_file_backend() {
    let dir = tempfile::tempdir().unwrap();
    let convo_dir = dir.path().join("conversations");
    let url = format!("json://{}", convo_dir.display());

    let store = connect(&url).await.unwrap();
    let mut conv = Conversation::new();
    conv.push(Message::user("hello from json"));
    store.save("c-json", &conv).await.unwrap();
    drop(store);

    // Reopen, verify survival on disk.
    let store = connect(&url).await.unwrap();
    let loaded = store.load("c-json").await.unwrap().unwrap();
    assert_eq!(loaded.messages.len(), 1);

    let rows = store.list(10).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, "c-json");
}

#[tokio::test]
async fn connect_json_short_form_also_works() {
    // `json:path` (no double slash) — useful when the path is
    // relative or when avoiding URL escaping for the leading `/`.
    let dir = tempfile::tempdir().unwrap();
    let convo_dir = dir.path().join("conversations");
    let url = format!("json:{}", convo_dir.display());
    let store = connect(&url).await.unwrap();
    let conv = Conversation::new();
    store.save("empty", &conv).await.unwrap();
    assert!(store.load("empty").await.unwrap().is_some());
}

#[tokio::test]
async fn unknown_scheme_errors() {
    match connect("redis://localhost:6379").await {
        Err(StoreError::UnsupportedScheme(s)) => assert_eq!(s, "redis"),
        Ok(_) => panic!("unexpected ok"),
        Err(other) => panic!("unexpected error: {other}"),
    }
}
