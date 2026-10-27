// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! `db.rs`'s `mod runner_persistence_tests`, moved out verbatim: a `#[path]` child of the
//! same parent, so `use super::*` still resolves as it did inline.

use super::*;
#[test]
fn effort_survives_status_upserts_and_disk_reload() {
    let path =
        std::env::temp_dir().join(format!("redline-effort-{}.sqlite", uuid::Uuid::new_v4()));
    {
        let db = Database::open(&path).unwrap();
        let mut session = ReviewSession {
            session_id: "effort-session".into(),
            project_path: "/tmp".into(),
            project_name: "tmp".into(),
            created_at: 1,
            status: SessionStatus::InReview,
            attach_state: AttachState::Idle,
            updated_at: 1,
            run_state: None,
            backend: Some("codex".into()),
            model: Some("gpt-test".into()),
            effort: Some("high".into()),
            revisions: Vec::new(),
        };
        db.upsert_session(&session).unwrap();
        session.backend = None;
        session.model = None;
        session.effort = None;
        session.updated_at = 2;
        db.upsert_session(&session).unwrap();
    }
    let db = Database::open(&path).unwrap();
    let session = db.load_session("effort-session").unwrap().unwrap();
    assert_eq!(session.backend.as_deref(), Some("codex"));
    assert_eq!(session.model.as_deref(), Some("gpt-test"));
    assert_eq!(session.effort.as_deref(), Some("high"));
    drop(db);
    let _ = std::fs::remove_file(path);
}
#[test]
fn disk_restart_rehydrates_graph_and_rearms_interrupted_gate() {
    let path = std::env::temp_dir().join(format!(
        "redline-run-restart-{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    {
        let db = Database::open(&path).unwrap();
        let mut graph: crate::runner_graph::RunGraph =
            serde_json::from_str(include_str!("../../src/lib/runner/fixtures/basic.json"))
                .unwrap();
        graph.status = "running".into();
        graph.nodes[0].status = "running".into();
        graph.nodes[0].attempt = 1;
        graph.nodes[0].child_session_id = Some("saved-context".into());
        db.runner_create(&graph).unwrap();
        db.runner_claim(&graph.run_id, "n-api", "api/durable.rs", 1)
            .unwrap();
    }
    let db = Database::open(&path).unwrap();
    let recovered = db.runner_recover().unwrap();
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].nodes[0].status, "awaiting_human");
    assert_eq!(
        recovered[0].nodes[0].child_session_id.as_deref(),
        Some("saved-context")
    );
    assert_eq!(
        db.runner_claims("run-fixture").unwrap()[0].released_at,
        None
    );
    drop(db);
    let _ = std::fs::remove_file(path);
}
