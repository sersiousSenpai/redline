// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! `db.rs`'s `mod runner_tests`, moved out verbatim: a `#[path]` child of the
//! same parent, so `use super::*` still resolves as it did inline.

use super::*;
use crate::runner_graph::RunGraph;
fn fixture() -> RunGraph {
    serde_json::from_str(include_str!("../../src/lib/runner/fixtures/basic.json")).unwrap()
}
fn setup() -> Database {
    let db = Database::open_in_memory().unwrap();
    db.runner_create(&fixture()).unwrap();
    db
}
fn running(db: &Database) -> RunGraph {
    db.runner_update("run-fixture", None, |g, _| {
        g.status = "running".into();
        g.nodes[0].status = "running".into();
        g.nodes[1].status = "running".into();
        g.nodes[0].attempt = 1;
        g.nodes[1].attempt = 1;
        Ok(())
    })
    .unwrap()
}
#[test]
fn graph_revision_rejects_lost_updates_and_keeps_normalized_rows() {
    let db = setup();
    let g = running(&db);
    assert_eq!(g.rev, 1);
    assert!(db
        .runner_update("run-fixture", Some(0), |g, _| {
            g.status = "done".into();
            Ok(())
        })
        .unwrap_err()
        .starts_with("409"));
    assert_eq!(db.runner_get("run-fixture").unwrap().status, "running");
    let conn = db.lock_conn();
    let status: String = conn
        .query_row(
            "SELECT status FROM run_nodes WHERE node_id='n-api'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(status, "running");
}
#[test]
fn single_use_update_error_preserves_graph_rows_revision_and_claims() {
    let db = setup();
    let before = running(&db);
    db.runner_claim("run-fixture", "n-api", "claimed.rs", 1).unwrap();
    let replacement = String::from("passed");
    let mut calls = 0;
    let result = db.runner_update("run-fixture", Some(before.rev), |g, _| {
        calls += 1;
        // Moving this String out makes the callback FnOnce, not FnMut.
        g.nodes[0].status = replacement;
        g.status = "done".into();
        Err("mutation failed".into())
    });
    assert_eq!(calls, 1);
    assert_eq!(result.unwrap_err(), "mutation failed");
    assert_eq!(db.runner_get("run-fixture").unwrap(), before);
    assert!(db.runner_claims("run-fixture").unwrap()[0].released_at.is_none());
    let status: String = db.lock_conn().query_row(
        "SELECT status FROM run_nodes WHERE node_id='n-api'", [], |r| r.get(0)
    ).unwrap();
    assert_eq!(status, "running");
}
#[test]
fn first_write_claims_and_terminal_release_serialize_real_paths() {
    let db = setup();
    running(&db);
    db.runner_claim("run-fixture", "n-api", "shared.ts", 1)
        .unwrap();
    assert!(db
        .runner_claim("run-fixture", "n-ui", "shared.ts", 1)
        .unwrap_err()
        .contains("n-api"));
    db.runner_update("run-fixture", None, |g, _| {
        g.nodes[0].status = "passed".into();
        Ok(())
    })
    .unwrap();
    db.runner_claim("run-fixture", "n-ui", "shared.ts", 1).unwrap();
    assert_eq!(
        db.runner_claims("run-fixture")
            .unwrap()
            .iter()
            .filter(|c| c.released_at.is_none())
            .count(),
        1
    );
}
#[test]
fn hints_are_not_authority_but_enforced_scope_is() {
    let db = setup();
    running(&db);
    db.runner_claim("run-fixture", "n-api", "outside.rs", 1)
        .unwrap();
    db.runner_update("run-fixture", None, |g, _| {
        g.nodes[1].enforce_scope = true;
        Ok(())
    })
    .unwrap();
    assert!(db
        .runner_claim("run-fixture", "n-ui", "not-ui.rs", 1)
        .unwrap_err()
        .contains("enforced scope"));
    db.runner_claim("run-fixture", "n-ui", "ui/view.ts", 1)
        .unwrap();
}
#[test]
fn scoped_and_global_checks_veto_covered_writes() {
    let db = setup();
    running(&db);
    db.runner_claim("run-fixture", "n-api", "api/x.rs", 1).unwrap();
    db.runner_update("run-fixture", None, |g, _| {
        g.nodes[0].status = "passed".into();
        g.nodes[2].status = "verifying".into();
        g.nodes[2].check_global = false;
        Ok(())
    })
    .unwrap();
    assert!(db
        .runner_claim("run-fixture", "n-ui", "api/x.rs", 1)
        .unwrap_err()
        .contains("verification barrier"));
    db.runner_claim("run-fixture", "n-ui", "ui/free.ts", 1)
        .unwrap();
    db.runner_update("run-fixture", None, |g, _| {
        g.nodes[2].check_global = true;
        Ok(())
    })
    .unwrap();
    assert!(db.runner_claim("run-fixture", "n-ui", "other.rs", 1).is_err());
}
#[test]
fn live_review_vetoes_every_write_even_when_marked_scoped() {
    let db=setup();running(&db);
    db.runner_claim("run-fixture","n-api","api/x.rs", 1).unwrap();
    db.runner_update("run-fixture",None,|g,_| {
        g.nodes[0].status="passed".into();
        g.nodes[2].kind="review".into();g.nodes[2].status="running".into();g.nodes[2].check_global=false;
        Ok(())
    }).unwrap();
    for path in ["api/x.rs","unrelated/new.rs"] {
        assert!(db.runner_claim("run-fixture","n-ui",path, 1).unwrap_err().contains("verification barrier"));
    }
    db.runner_update("run-fixture",None,|g,_|{g.nodes[2].status="passed".into();Ok(())}).unwrap();
    db.runner_claim("run-fixture","n-ui","api/x.rs", 1).unwrap();
}
#[test]
fn recovered_old_attempt_cannot_write_after_successor_starts() {
    let db=setup();running(&db);
    db.runner_claim("run-fixture","n-api","before.rs",1).unwrap();
    db.runner_recover().unwrap();
    assert!(db.runner_claim("run-fixture","n-api","recovered.rs",1).is_err());
    db.runner_update("run-fixture",None,|g,_| {
        g.status="running".into();g.nodes[0].status="running".into();g.nodes[0].attempt=2;Ok(())
    }).unwrap();
    assert!(db.runner_claim("run-fixture","n-api","stale.rs",1).unwrap_err().contains("stale run attempt"));
    assert!(db.runner_claim("run-fixture","n-api","missing.rs",0).is_err());
    db.runner_claim("run-fixture","n-api","successor.rs",2).unwrap();
    assert!(!db.runner_claims("run-fixture").unwrap().iter().any(|c|c.path=="stale.rs"));
}
#[test]
fn restart_retains_claims_and_resume_handles_but_never_lies_about_processes() {
    let db = setup();
    running(&db);
    db.runner_claim("run-fixture", "n-api", "x.rs", 1).unwrap();
    db.runner_update("run-fixture", None, |g, _| {
        g.nodes[0].child_session_id = Some("resume-id".into());
        Ok(())
    })
    .unwrap();
    let recovered = db.runner_recover().unwrap();
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].status, "paused");
    assert_eq!(recovered[0].nodes[0].status, "awaiting_human");
    assert_eq!(
        recovered[0].nodes[0].child_session_id.as_deref(),
        Some("resume-id")
    );
    assert_eq!(
        db.runner_claims("run-fixture").unwrap()[0].released_at,
        None
    );
    assert!(db.runner_claim("run-fixture", "n-api", "new.rs", 1).is_err());
    assert!(db.runner_recover().unwrap().is_empty());
}
#[test]
fn concurrent_claims_have_one_winner() {
    let db = Arc::new(setup());
    running(&db);
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let handles: Vec<_> = ["n-api", "n-ui"]
        .into_iter()
        .map(|id| {
            let db = db.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                db.runner_claim("run-fixture", id, "same.ts", 1)
            })
        })
        .collect();
    barrier.wait();
    let wins = handles
        .into_iter()
        .filter(|h| h.thread().id() != std::thread::current().id())
        .map(|h| h.join().unwrap().is_ok())
        .filter(|v| *v)
        .count();
    assert_eq!(wins, 1);
}
