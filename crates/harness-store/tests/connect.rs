//! Integration tests for the `connect(url)` dispatcher.
//!
//! We only exercise backends that don't need an external server: in-memory
//! SQLite and a file-backed SQLite in a tempdir. Postgres/MySQL are covered
//! by whatever CI environment has those services available.

use harness_core::{Conversation, Message};
use harness_observability::{EvalBaseline, EvalFilter, ObservabilityFilter, ObservedOutcome, ObservedRun, ObservedRunKind};
use harness_store::{connect, connect_evals, connect_observability, connect_workflows, StoreError};
use harness_workflow::{WorkflowDefinition, WorkflowRun, WorkflowStep, WorkflowStepKind};

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
async fn connect_json_observability_backend() {
    let dir = tempfile::tempdir().unwrap();
    let url = format!("json:{}", dir.path().join("observability").display());
    let store = connect_observability(&url).await.unwrap();
    let run = ObservedRun {
        id: "run-connect".into(),
        trace_id: None,
        span_id: None,
        parent_run_id: None,
        kind: ObservedRunKind::Agent,
        name: "jarvis.agent.run".into(),
        started_at: "2026-05-08T00:00:00Z".into(),
        ended_at: None,
        duration_ms: None,
        outcome: ObservedOutcome::Success,
        conversation_id: None,
        project_id: None,
        workspace_hash: None,
        attributes: serde_json::json!({}),
        metrics: serde_json::json!({}),
        artifact_ids: Vec::new(),
    };
    store.append_run(&run).await.unwrap();
    let rows = store
        .list_runs(ObservabilityFilter::default())
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, "run-connect");
}

#[tokio::test]
async fn connect_json_eval_backend() {
    let dir = tempfile::tempdir().unwrap();
    let url = format!("json:{}", dir.path().join("evals").display());
    let store = connect_evals(&url).await.unwrap();
    let baseline = EvalBaseline {
        id: "baseline-connect".into(),
        suite: "smoke".into(),
        suite_kind: harness_observability::EvalSuiteKind::Smoke,
        created_at: "2026-05-08T00:00:00Z".into(),
        git_ref: None,
        model: None,
        summary: serde_json::json!({}),
        cases: serde_json::json!({}),
    };
    store.save_baseline(&baseline).await.unwrap();
    assert!(store
        .list_case_results(EvalFilter::default())
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        store.load_baseline("baseline-connect").await.unwrap(),
        Some(baseline)
    );
}

#[tokio::test]
async fn connect_json_workflow_backend() {
    let dir = tempfile::tempdir().unwrap();
    let url = format!("json:{}", dir.path().join("data").display());

    // Definition survives a reopen.
    let mut def = WorkflowDefinition::new("ship");
    def.steps = vec![WorkflowStep::new(
        "research",
        WorkflowStepKind::Agent {
            prompt: "look around".into(),
            subagent: None,
            model: None,
            output_key: Some("notes".into()),
        },
    )];
    {
        let store = connect_workflows(&url).await.unwrap();
        store.upsert(&def).await.unwrap();
        // A run bound to a requirement.
        let mut run = WorkflowRun::new(def.id.clone(), Some("req-1".into()));
        run.finish(harness_workflow::WorkflowRunStatus::Succeeded);
        store.upsert_run(&run).await.unwrap();
    }

    let store = connect_workflows(&url).await.unwrap();
    let loaded = store.get(&def.id).await.unwrap().unwrap();
    assert_eq!(loaded, def);
    assert_eq!(store.list().await.unwrap().len(), 1);

    // Run filters.
    assert_eq!(
        store.list_runs(Some(&def.id), None).await.unwrap().len(),
        1
    );
    assert_eq!(
        store.list_runs(None, Some("req-1")).await.unwrap().len(),
        1
    );
    assert!(store
        .list_runs(None, Some("req-other"))
        .await
        .unwrap()
        .is_empty());

    assert!(store.delete(&def.id).await.unwrap());
    assert!(store.get(&def.id).await.unwrap().is_none());
}

#[tokio::test]
async fn connect_workflows_falls_back_to_memory_for_non_json() {
    // Non-json scheme returns a usable (in-memory) store rather than
    // erroring, so the feature works under any DB backend.
    let store = connect_workflows("sqlite::memory:").await.unwrap();
    let def = WorkflowDefinition::new("ephemeral");
    store.upsert(&def).await.unwrap();
    assert_eq!(store.list().await.unwrap().len(), 1);
}

#[tokio::test]
async fn unknown_scheme_errors() {
    match connect("redis://localhost:6379").await {
        Err(StoreError::UnsupportedScheme(s)) => assert_eq!(s, "redis"),
        Ok(_) => panic!("unexpected ok"),
        Err(other) => panic!("unexpected error: {other}"),
    }
}
