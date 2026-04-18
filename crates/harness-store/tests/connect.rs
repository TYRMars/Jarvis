//! Integration tests for the `connect(url)` dispatcher.
//!
//! We only exercise backends that don't need an external server: in-memory
//! SQLite and a file-backed SQLite in a tempdir. Postgres/MySQL are covered
//! by whatever CI environment has those services available.

use harness_core::{Conversation, Message};
use harness_store::{connect, StoreError};

#[tokio::test]
async fn connect_sqlite_memory() {
    let store = connect("sqlite::memory:").await.unwrap();
    let mut conv = Conversation::new();
    conv.push(Message::user("ping"));
    store.save("id1", &conv).await.unwrap();
    let loaded = store.load("id1").await.unwrap().unwrap();
    assert_eq!(loaded.messages.len(), 1);
}

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
async fn unknown_scheme_errors() {
    match connect("redis://localhost:6379").await {
        Err(StoreError::UnsupportedScheme(s)) => assert_eq!(s, "redis"),
        Ok(_) => panic!("unexpected ok"),
        Err(other) => panic!("unexpected error: {other}"),
    }
}
