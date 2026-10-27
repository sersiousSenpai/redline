// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! `db.rs`'s `mod tests`, moved out verbatim: a `#[path]` child of the
//! same parent, so `use super::*` still resolves as it did inline.

// The parse helper: no longer a `db` dependency (loading deliberately
// does NOT parse), but the fixtures still build revisions the way the
// interception path does.
use crate::state::reparse_sections;
use super::*;
use crate::state::{NewCommentRequest, SessionStore};
use std::sync::Arc;

fn make_store() -> SessionStore {
    let db = Arc::new(Database::open_in_memory().unwrap());
    SessionStore::new(db)
}

#[test]
fn flow_organization_migration_repairs_partial_and_foreign_stamps() {
    for stamp in [9, 10, 99] {
        let db = Database::open_in_memory().unwrap();
        let conn = db.lock_conn();
        conn.execute("ALTER TABLE sessions DROP COLUMN title_override", []).unwrap();
        conn.execute("ALTER TABLE companion_sessions DROP COLUMN archived_at", []).unwrap();
        conn.pragma_update(None, "user_version", stamp).unwrap();
        Database::migrate(&conn).unwrap();
        Database::migrate(&conn).unwrap();
        Database::verify_schema(&conn).unwrap();
        let actual: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(actual, stamp.max(10));
    }
}

#[test]
fn flow_organization_preserves_title_and_unarchives_on_new_plan() {
    let db = Arc::new(Database::open_in_memory().unwrap());
    let store = SessionStore::new(db.clone());
    store.upsert_plan("flow", "/repo", "# Original".into(), vec![], true, false);
    store.set_attach_state("flow", AttachState::Idle);
    assert!(db.rename_session("flow", Some("My title")).unwrap());
    assert!(db.archive_session("flow", true).unwrap());
    let summary = store.list().remove(0);
    assert!(summary.archived_at.is_some());
    assert_eq!(summary.title_override.as_deref(), Some("My title"));
    store.upsert_plan("flow", "/repo", "# Revised".into(), vec![], true, false);
    let summary = store.list().remove(0);
    assert!(summary.archived_at.is_none());
    assert_eq!(summary.title_override.as_deref(), Some("My title"));
    store.set_attach_state("flow", AttachState::Held);
    assert!(!db.archive_session("flow", true).unwrap());
    assert!(db.archive_session("flow", false).unwrap());
    assert!(!db.archive_session("missing", true).unwrap());
}

/// The flow sidebar files a chat under its folder and folds an archived
/// one away, so the list carries both; a fresh chat carries neither.
#[test]
fn listed_chats_carry_their_folder_and_archive() {
    let db = Database::open_in_memory().unwrap();
    let chat = |id: &str| crate::state::Companion {
        companion_id: id.into(),
        title: "Chat".into(),
        status: "active".into(),
        created_at: 1,
        updated_at: 1,
        model: None,
        effort: None,
        title_is_user_set: false,
        archived_at: None,
        project_path: None,
    };
    db.insert_companion(&chat("a")).unwrap();
    db.insert_companion(&chat("b")).unwrap();
    assert!(db.set_companion_project("a", Some("/code/din")).unwrap());
    assert!(db.archive_companion("a", true).unwrap());
    let listed = db.list_companions().unwrap();
    let a = listed.iter().find(|c| c.companion_id == "a").unwrap();
    let b = listed.iter().find(|c| c.companion_id == "b").unwrap();
    assert!(a.archived_at.is_some());
    assert_eq!(a.project_path.as_deref(), Some("/code/din"));
    assert_eq!((b.archived_at, b.project_path.as_deref()), (None, None));
    // Absent, not null, on the wire: the frontend reads `archivedAt?`.
    let wire = serde_json::to_value(b).unwrap();
    assert!(wire.get("archivedAt").is_none() && wire.get("projectPath").is_none());
    assert!(db.archive_companion("a", false).unwrap());
    assert!(db.list_companions().unwrap().iter().all(|c| c.archived_at.is_none()));
}

// --- Backend provenance (which harness authored the plan) --------------

#[test]
fn session_backend_and_model_survive_a_reload() {
    let db = Arc::new(Database::open_in_memory().unwrap());
    let store = SessionStore::new(db.clone());
    let md = "# Plan\n\nBody.\n";
    store.upsert_plan("thr_1", "/repo/x", md.to_string(), Vec::new(), true, false);
    store.set_backend("thr_1", Some("codex"), Some("gpt-5.6-sol"));

    let reloaded = SessionStore::new(db);
    let s = reloaded.get("thr_1").expect("session");
    assert_eq!(s.backend.as_deref(), Some("codex"));
    assert_eq!(s.model.as_deref(), Some("gpt-5.6-sol"));
    // …and the accessor restore branches on.
    assert_eq!(reloaded.backend_of("thr_1"), "codex");
}

#[test]
fn a_status_only_upsert_cannot_blank_the_backend() {
    // This is the whole reason the column is COALESCEd: most upserts exist
    // to move `status` or `attach_state` and carry no provenance at all.
    // One of them blanking the backend would send the NEXT restore down
    // the claude arm holding a Codex thread id — which does not error, it
    // silently starts a fresh session.
    let db = Arc::new(Database::open_in_memory().unwrap());
    let store = SessionStore::new(db.clone());
    let md = "# Plan\n\nBody.\n";
    store.upsert_plan("thr_1", "/repo/x", md.to_string(), Vec::new(), true, false);
    store.set_backend("thr_1", Some("codex"), Some("gpt-5.6-sol"));

    // A caller that knows nothing about backends writes the row back.
    let mut blind = store.get("thr_1").unwrap();
    blind.backend = None;
    blind.model = None;
    blind.status = crate::state::SessionStatus::Approved;
    db.upsert_session(&blind).unwrap();

    let reloaded = SessionStore::new(db);
    assert_eq!(reloaded.backend_of("thr_1"), "codex");
    assert_eq!(
        reloaded.get("thr_1").unwrap().model.as_deref(),
        Some("gpt-5.6-sol")
    );
}

#[test]
fn an_unstamped_session_reads_as_claude_code() {
    // Every pre-backend row, and every Claude session whose hook payload
    // carried no provider.
    let store = make_store();
    let md = "# Plan\n\nBody.\n";
    store.upsert_plan("s1", "/repo/x", md.to_string(), Vec::new(), true, false);
    assert!(store.get("s1").unwrap().backend.is_none());
    assert_eq!(store.backend_of("s1"), "claude-code");
    assert_eq!(store.backend_of("no-such-session"), "claude-code");
    // Blank/whitespace is not an answer either.
    store.set_backend("s1", Some("   "), None);
    assert_eq!(store.backend_of("s1"), "claude-code");
}

// --- Agent shelf (harness program A2) ----------------------------------

fn shelf_agent(id: &str, name: &str) -> HarnessAgent {
    HarnessAgent {
        agent_id: id.to_string(),
        name: name.to_string(),
        instruction: "Tighten every heading.".to_string(),
        folder_id: None,
        starred: false,
        created_at: 1000,
        updated_at: 1000,
        last_run_at: None,
        run_count: 0,
    }
}

#[test]
fn harness_agent_crud_round_trip() {
    let db = Database::open_in_memory().unwrap();
    db.insert_harness_agent(&shelf_agent("ha-1", "Header tightener")).unwrap();

    let got = db.get_harness_agent("ha-1").unwrap().expect("row exists");
    assert_eq!(got.name, "Header tightener");
    assert_eq!(got.instruction, "Tighten every heading.");
    assert!(!got.starred);
    assert_eq!(got.run_count, 0);

    assert!(db.update_harness_agent("ha-1", "Tightener", "Shorter.").unwrap());
    let got = db.get_harness_agent("ha-1").unwrap().unwrap();
    assert_eq!(got.name, "Tightener");
    assert_eq!(got.instruction, "Shorter.");
    assert!(got.updated_at >= 1000, "update bumps updated_at");

    db.set_harness_agent_starred("ha-1", true).unwrap();
    assert!(db.get_harness_agent("ha-1").unwrap().unwrap().starred);

    db.set_harness_agent_folder("ha-1", Some("f-1")).unwrap();
    assert_eq!(
        db.get_harness_agent("ha-1").unwrap().unwrap().folder_id.as_deref(),
        Some("f-1")
    );

    assert!(!db.update_harness_agent("nope", "x", "y").unwrap(), "missing row updates nothing");
    assert!(db.delete_harness_agent("ha-1").unwrap());
    assert!(db.get_harness_agent("ha-1").unwrap().is_none());
    assert!(!db.delete_harness_agent("ha-1").unwrap(), "second delete is a no-op");
}

/// A duplicate is `<name> copy`, never starred, with no run history — and
/// the run counter never reorders the shelf (`updated_at` untouched).
#[test]
fn harness_agent_duplicate_and_run_touch() {
    let db = Database::open_in_memory().unwrap();
    let mut a = shelf_agent("ha-1", "Summarizer");
    a.starred = true;
    a.folder_id = Some("f-9".to_string());
    db.insert_harness_agent(&a).unwrap();

    let copy = db
        .duplicate_harness_agent("ha-1", "ha-2")
        .unwrap()
        .expect("source exists");
    assert_eq!(copy.name, "Summarizer copy");
    assert_eq!(copy.instruction, a.instruction, "instruction deep-copied");
    assert_eq!(copy.folder_id.as_deref(), Some("f-9"), "stays in the folder");
    assert!(!copy.starred, "a copy is never starred");
    assert_eq!(copy.run_count, 0);
    assert!(db.duplicate_harness_agent("nope", "ha-3").unwrap().is_none());

    let before = db.get_harness_agent("ha-1").unwrap().unwrap().updated_at;
    db.touch_harness_agent_run("ha-1").unwrap();
    let after = db.get_harness_agent("ha-1").unwrap().unwrap();
    assert_eq!(after.run_count, 1);
    assert!(after.last_run_at.is_some());
    assert_eq!(after.updated_at, before, "a run must not reorder the shelf");
}

fn suggestion_row(id: &str, draft_id: &str) -> crate::state::DraftSuggestion {
    crate::state::DraftSuggestion {
        id: id.to_string(),
        draft_id: draft_id.to_string(),
        op: "replace_block".to_string(),
        block_id: Some("blk-1".to_string()),
        original: Some("old".to_string()),
        markdown: "new".to_string(),
        agent_id: Some("shelf:ha-1".to_string()),
        body: Some("Tightened.".to_string()),
        status: "pending".to_string(),
        created_at: 1000,
    }
}

/// Undo-after-accept (A3): only an APPLIED suggestion returns to the
/// pending queue. Rejected marks left the document, and a pending row has
/// nothing to undo — both must be no-ops.
#[test]
fn unresolve_returns_only_applied_suggestions_to_pending() {
    let db = Database::open_in_memory().unwrap();
    db.upsert_draft("d-1", Some("Doc"), None, "# Doc", None).unwrap();
    db.insert_draft_suggestion(&suggestion_row("s-applied", "d-1")).unwrap();
    db.insert_draft_suggestion(&suggestion_row("s-rejected", "d-1")).unwrap();
    db.insert_draft_suggestion(&suggestion_row("s-pending", "d-1")).unwrap();
    assert!(db.resolve_draft_suggestion("s-applied", "applied").unwrap());
    assert!(db.resolve_draft_suggestion("s-rejected", "rejected").unwrap());

    assert!(db.unresolve_draft_suggestion("s-applied").unwrap());
    assert!(!db.unresolve_draft_suggestion("s-rejected").unwrap());
    assert!(!db.unresolve_draft_suggestion("s-pending").unwrap());
    assert!(!db.unresolve_draft_suggestion("nope").unwrap());

    let pending = db.list_pending_draft_suggestions("d-1").unwrap();
    let ids: Vec<&str> = pending.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids, ["s-applied", "s-pending"], "undo re-queues; reject stays settled");
}

/// Preview copies (A3) are real `drafts` rows — the write contract needs
/// one — but they must never surface on the shelf, and the age-based
/// lister must offer only genuinely stale ones to the sweep.
#[test]
fn preview_drafts_stay_off_the_shelf_and_list_stale_by_age() {
    let db = Database::open_in_memory().unwrap();
    db.upsert_draft("d-real", Some("Real"), None, "# Real", None).unwrap();
    db.upsert_draft("preview-1", Some("Copy"), None, "# Real", None).unwrap();

    let listed = db.list_drafts().unwrap();
    let ids: Vec<&str> = listed.iter().map(|d| d.draft_id.as_str()).collect();
    assert_eq!(ids, ["d-real"], "a preview copy never reaches the shelf");

    // Fresh previews survive the sweep cutoff; stale ones are offered.
    let now = crate::ledger::now_millis();
    assert!(db.list_stale_preview_drafts(now - 60_000).unwrap().is_empty());
    let stale = db.list_stale_preview_drafts(now + 60_000).unwrap();
    assert_eq!(stale, ["preview-1"]);
    assert!(
        !db.list_stale_preview_drafts(now + 60_000).unwrap().contains(&"d-real".to_string()),
        "the sweep can only ever see the preview id-space"
    );
}

fn prompt_row<'a>(body: &'a str, bh: &'a str, sid: Option<&'a str>) -> crate::ledger::PromptRow<'a> {
    crate::ledger::PromptRow {
        ts: 1000,
        source: "hook",
        origin: "redline",
        surface: "pty",
        role: "user",
        user_text: None,
        session_id: None,
        claude_session_id: sid,
        mission_id: None,
        project_path: Some("/proj"),
        body,
        body_hash: bh,
        thread_kind: None,
        thread_id: None,
        parent_session_id: None,
            model: None,
        model_source: None,
    }
}

fn append<'a>(db: &Database, kind: &'a str, ph: &'a str) -> crate::ledger::LedgerEventRow {
    db.append_ledger_event(&crate::ledger::LedgerAppend {
        kind,
        author: "tester",
        ts: 1000,
        prompt_id: None,
        session_id: Some("s"),
        version_number: None,
        ref_kind: Some("session"),
        ref_id: Some("s"),
        payload_hash: ph,
    })
    .unwrap()
}

#[test]
fn ledger_chain_builds_and_verifies() {
    let db = Database::open_in_memory().unwrap();
    let e1 = append(&db, "prompt", "h1");
    let e2 = append(&db, "approval", "h2");
    let e3 = append(&db, "revision", "h3");
    // seq is monotonic, and each row commits to its predecessor's hash.
    assert_eq!((e1.seq, e2.seq, e3.seq), (1, 2, 3));
    assert_eq!(e1.prev_hash, crate::ledger::GENESIS_PREV);
    assert_eq!(e2.prev_hash, e1.entry_hash);
    assert_eq!(e3.prev_hash, e2.entry_hash);

    let v = db.verify_ledger_chain().unwrap();
    assert!(v.ok);
    assert_eq!(v.checked, 3);
    assert_eq!(v.first_bad_seq, None);
    assert_eq!(v.head_hash.as_deref(), Some(e3.entry_hash.as_str()));
}

// --- ClassMemory (Phase 2) --------------------------------------------

use crate::classmem::{Proposal, SplitPart};

fn accepted_node(db: &Database, id: &str, parent: Option<&str>, title: &str) {
    let now = crate::ledger::now_millis();
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO class_nodes
                (id, parent_id, kind, title, summary, project_path, ip_name,
                 status, pinned, curated_by, created_at, updated_at)
             VALUES (?1, ?2, 'node', ?3, NULL, NULL, NULL, 'accepted', 0, 'user', ?4, ?4)",
        params![id, parent, title, now],
    )
    .unwrap();
}

fn add_link(db: &Database, node: &str, kind: &str, target: &str) -> i64 {
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO class_links (node_id, target_kind, target_id, note, status, created_at)
             VALUES (?1, ?2, ?3, NULL, 'accepted', 1000)",
        params![node, kind, target],
    )
    .unwrap();
    conn.last_insert_rowid()
}

// --- Supersession + observations (temporal validity / patterns) --------

use crate::classmem::SupersessionOutcome;

fn assert_rejected(out: SupersessionOutcome) -> String {
    match out {
        SupersessionOutcome::Rejected(msg) => msg,
        other => panic!("expected Rejected, got {other:?}"),
    }
}

#[test]
fn supersession_guardrails() {
    let db = Database::open_in_memory().unwrap();
    let _p = append(&db, "prompt", "h1"); // seq 1 — not a decision
    let r1 = append(&db, "resolution", "h2"); // seq 2
    let a1 = append(&db, "approval", "h3"); // seq 3
    let r2 = append(&db, "review_verdict", "h4"); // seq 4

    // Non-decision kinds are never superseded (either side).
    assert_rejected(db.apply_supersession(1, r1.seq, "", "tester").unwrap());
    assert_rejected(db.apply_supersession(r1.seq, 1, "", "tester").unwrap());
    // Unknown seqs reject.
    assert_rejected(db.apply_supersession(r1.seq, 999, "", "tester").unwrap());
    // Old must precede new.
    assert_rejected(db.apply_supersession(a1.seq, r1.seq, "", "tester").unwrap());

    // Happy path: r1 → a1.
    match db.apply_supersession(r1.seq, a1.seq, "reversed", "tester").unwrap() {
        SupersessionOutcome::Applied { effective_old, new_seq, event_seq } => {
            assert_eq!((effective_old, new_seq), (r1.seq, a1.seq));
            // The supersede event landed on the chain, referencing old.
            let ev = db
                .list_ledger_events(1)
                .unwrap()
                .into_iter()
                .next()
                .unwrap();
            assert_eq!(ev.seq, event_seq);
            assert_eq!(ev.kind, "supersede");
            assert_eq!(ev.ref_kind.as_deref(), Some("ledger_event"));
            assert_eq!(ev.ref_id.as_deref(), Some(r1.seq.to_string().as_str()));
        }
        other => panic!("expected Applied, got {other:?}"),
    }

    // "At most once": superseding r1 again redirects to the chain head
    // (a1), so r1 → r2 records a1 → r2, not a second edge from r1.
    match db.apply_supersession(r1.seq, r2.seq, "newer again", "tester").unwrap() {
        SupersessionOutcome::Applied { effective_old, new_seq, .. } => {
            assert_eq!((effective_old, new_seq), (a1.seq, r2.seq));
        }
        other => panic!("expected Applied, got {other:?}"),
    }
    // The idempotent duplicate lands on "already the head" and rejects.
    assert_rejected(db.apply_supersession(r1.seq, r2.seq, "", "tester").unwrap());

    // The index answers both hops.
    let map = db.supersessions_for_seqs(&[r1.seq, a1.seq, r2.seq]).unwrap();
    assert_eq!(map.get(&r1.seq), Some(&a1.seq));
    assert_eq!(map.get(&a1.seq), Some(&r2.seq));
    assert_eq!(map.get(&r2.seq), None);
}

#[test]
fn supersede_and_observation_keep_chain_green() {
    // The hash-invariant tripwire: the two new event kinds coexist with
    // the old ones on one chain, and verification stays green — proof
    // that CanonicalEvent was untouched.
    let db = Database::open_in_memory().unwrap();
    append(&db, "prompt", "h1");
    let r = append(&db, "resolution", "h2");
    let a = append(&db, "approval", "h3");
    match db.apply_supersession(r.seq, a.seq, "why", "keeper").unwrap() {
        SupersessionOutcome::Applied { .. } => {}
        other => panic!("expected Applied, got {other:?}"),
    }
    accepted_node(&db, "cn-x", None, "X");
    assert!(db
        .insert_class_observation("cn-x", "a pattern", &[1, 2], "keeper")
        .unwrap()
        .is_some());
    let v = db.verify_ledger_chain().unwrap();
    assert!(v.ok, "chain must stay green: {v:?}");
    assert_eq!(v.checked, 5); // 3 seeds + supersede + observation
}

#[test]
fn insert_class_observation_sets_created_seq_and_dedups() {
    let db = Database::open_in_memory().unwrap();
    accepted_node(&db, "cn-x", None, "X");

    // Uncited / empty-summary / unknown-node inserts are rejected.
    assert!(db.insert_class_observation("cn-x", "s", &[], "keeper").unwrap().is_none());
    assert!(db.insert_class_observation("cn-x", "  ", &[1], "keeper").unwrap().is_none());
    assert!(db.insert_class_observation("ghost", "s", &[1], "keeper").unwrap().is_none());

    let id = db
        .insert_class_observation("cn-x", "deploys follow auth changes", &[4, 9], "keeper")
        .unwrap()
        .expect("first insert lands");
    let obs = db.list_class_observations("cn-x", false).unwrap();
    assert_eq!(obs.len(), 1);
    assert_eq!(obs[0].id, id);
    assert_eq!(obs[0].cite_seqs, vec![4, 9]);
    // The row points at its own `observation` ledger event.
    let seq = obs[0].created_seq.expect("created_seq backfilled");
    let ev = db.list_ledger_events(10).unwrap();
    let ev = ev.iter().find(|e| e.seq == seq).unwrap();
    assert_eq!(ev.kind, "observation");
    assert_eq!(ev.ref_id.as_deref(), Some("cn-x"));

    // Identical summary dedups — including after a retirement (B3's
    // re-validation replaces dismiss), so a retired pattern never
    // resurfaces under the same wording.
    assert!(db
        .insert_class_observation("cn-x", "deploys follow auth changes", &[4], "keeper")
        .unwrap()
        .is_none());
    let node = db.retire_observation(id, "the items moved on", "keeper").unwrap();
    assert_eq!(node.as_deref(), Some("cn-x"));
    assert!(db.list_class_observations("cn-x", false).unwrap().is_empty());
    // The old `include_dismissed` flag is ignored: retired rows are never served.
    assert!(db.list_class_observations("cn-x", true).unwrap().is_empty());
    assert!(db
        .insert_class_observation("cn-x", "deploys follow auth changes", &[4, 9], "keeper")
        .unwrap()
        .is_none());
    // Retiring twice is a no-op, and the retirement is on the chain.
    assert!(db.retire_observation(id, "again", "keeper").unwrap().is_none());
    assert!(db.verify_ledger_chain().unwrap().ok);
}

#[test]
fn collapse_retires_subtree_observations_but_keeps_their_events() {
    let db = Database::open_in_memory().unwrap();
    accepted_node(&db, "cn-root", None, "root");
    accepted_node(&db, "cn-cold", Some("cn-root"), "cold branch");
    append(&db, "prompt", "h1");
    db.insert_class_observation("cn-cold", "some pattern", &[1], "keeper")
        .unwrap()
        .expect("observation lands");

    // Stage + apply a collapse of the branch.
    let staged = db
        .stage_proposal(
            None,
            &Proposal::Collapse {
                node_id: "cn-cold".into(),
                summary: "digest".into(),
                cite_seqs: vec![1],
                rationale: None,
            },
        )
        .unwrap();
    assert!(matches!(staged, crate::classmem::StagedOutcome::Structural));
    let pid = db.list_class_proposals().unwrap()[0].id;
    assert!(db.apply_class_proposal(pid, "tester").unwrap().is_some());

    // The rows retired with the branch…
    assert!(db.list_class_observations("cn-cold", true).unwrap().is_empty());
    // …but the tamper-evident history remains and the chain stays green.
    assert!(db
        .list_ledger_events(10)
        .unwrap()
        .iter()
        .any(|e| e.kind == "observation"));
    assert!(db.verify_ledger_chain().unwrap().ok);
}

#[test]
fn supersede_proposal_stages_and_applies_through_the_review_machinery() {
    let db = Database::open_in_memory().unwrap();
    append(&db, "prompt", "h1");
    let r = append(&db, "resolution", "h2");
    let a = append(&db, "approval", "h3");

    // Stage-time screen: non-decision or unknown seqs are skipped.
    let skipped = db
        .stage_proposal(None, &Proposal::Supersede { old_seq: 1, new_seq: a.seq, rationale: None })
        .unwrap();
    assert!(matches!(skipped, crate::classmem::StagedOutcome::Skipped));

    let staged = db
        .stage_proposal(
            None,
            &Proposal::Supersede { old_seq: r.seq, new_seq: a.seq, rationale: Some("why".into()) },
        )
        .unwrap();
    assert!(matches!(staged, crate::classmem::StagedOutcome::Structural));
    // Identical pending proposal doesn't re-stage.
    let dup = db
        .stage_proposal(
            None,
            &Proposal::Supersede { old_seq: r.seq, new_seq: a.seq, rationale: Some("again".into()) },
        )
        .unwrap();
    assert!(matches!(dup, crate::classmem::StagedOutcome::Skipped));

    let props = db.list_class_proposals().unwrap();
    assert_eq!(props.len(), 1);
    assert_eq!(props[0].op, "supersede");
    let applied = db.apply_class_proposal(props[0].id, "tester").unwrap().expect("applies");
    assert_eq!(applied.op, "supersede");
    assert_eq!(applied.detail, format!("#{} → #{}", r.seq, a.seq));
    assert!(db.list_class_proposals().unwrap().is_empty());
    assert_eq!(
        db.supersessions_for_seqs(&[r.seq]).unwrap().get(&r.seq),
        Some(&a.seq)
    );
    assert!(db.verify_ledger_chain().unwrap().ok);
}

#[test]
fn pending_proposal_count_tracks_staging_and_resolution() {
    let db = Database::open_in_memory().unwrap();
    append(&db, "prompt", "h1");
    let r = append(&db, "resolution", "h2");
    let a = append(&db, "approval", "h3");
    assert_eq!(db.count_pending_class_proposals().unwrap(), 0);

    db.stage_proposal(
        None,
        &Proposal::Supersede { old_seq: r.seq, new_seq: a.seq, rationale: None },
    )
    .unwrap();
    assert_eq!(db.count_pending_class_proposals().unwrap(), 1);

    let pid = db.list_class_proposals().unwrap()[0].id;
    db.reject_class_proposal(pid).unwrap();
    assert_eq!(db.count_pending_class_proposals().unwrap(), 0);
}

fn count_reorg_events(db: &Database) -> i64 {
    let conn = db.conn.lock().unwrap();
    conn.query_row(
        "SELECT COUNT(*) FROM ledger_events WHERE kind = 'taxonomy_reorg'",
        [],
        |r| r.get(0),
    )
    .unwrap()
}

#[test]
fn class_tables_exist_and_seed_is_idempotent() {
    let db = Database::open_in_memory().unwrap();
    let rows = crate::classmem::seed_root_rows(&[
        "/x/redline".to_string(),
        "/x/muslimlegalconnect".to_string(),
    ]);
    assert_eq!(db.seed_class_roots(&rows).unwrap(), 3); // 2 repos + ~general
    assert_eq!(db.seed_class_roots(&rows).unwrap(), 0); // idempotent
    let nodes = db.list_class_nodes().unwrap();
    assert_eq!(nodes.len(), 3);
    // Live on creation since B3 (there is no `proposed` state any more).
    assert!(nodes.iter().all(|n| n.status == "accepted" && n.parent_id.is_none()));
}

#[test]
fn stage_create_writes_a_live_node_and_one_curate_event_records_it() {
    let db = Database::open_in_memory().unwrap();
    accepted_node(&db, "root-r", None, "redline");
    let create = Proposal::Create {
        parent_id: "root-r".into(),
        title: "Loop Engineering".into(),
        rationale: None,
    };
    let out = db.stage_proposal(None, &create).unwrap();
    assert!(matches!(out, crate::classmem::StagedOutcome::Node));
    let staged = db.list_class_nodes().unwrap();
    let node = staged.iter().find(|n| n.title == "Loop Engineering").unwrap();
    // B3: staging writes the row LIVE — nothing waits for an accept.
    assert_eq!(node.status, "accepted");
    crate::classmem::record_curate(&db, "tester", &node.id, "create", "");
    // Re-staging the same create is a skip, not a duplicate.
    assert!(matches!(db.stage_proposal(None, &create).unwrap(), crate::classmem::StagedOutcome::Skipped));
    // The legacy flip finds nothing on a current store.
    assert!(db.accept_all_pending("classifier").unwrap().is_empty());
    let n: i64 = {
        let conn = db.conn.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM ledger_events WHERE kind = 'class_curate'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    };
    assert_eq!(n, 1);
}

#[test]
fn browse_event_records_dedups_and_keeps_chain_green() {
    let db = Database::open_in_memory().unwrap();
    let ev = |browse_id: &str, text: &str| crate::ledger::BrowseEventInput {
        action: crate::ledger::BrowseAction::Navigate,
        browse_id: Some(browse_id.into()),
        url: "https://example.com".into(),
        title: Some("Example".into()),
        text: text.into(),
        from_event_id: None,
        author: None,
    };
    // First page records → a browse_event ledger row + a browse_events row.
    assert!(crate::ledger::record_browse_event(&db, ev("t1", "page one")).unwrap().is_some());
    // Same content back-to-back in the same tab is deduped (nothing written).
    assert!(crate::ledger::record_browse_event(&db, ev("t1", "page one")).unwrap().is_none());
    // A different page in the same tab records.
    assert!(crate::ledger::record_browse_event(&db, ev("t1", "page two")).unwrap().is_some());
    // The SAME content in a DIFFERENT tab records (content-identity grouping,
    // not global dedup).
    assert!(crate::ledger::record_browse_event(&db, ev("t2", "page one")).unwrap().is_some());

    // The event references its browse_events row; text + hash round-trip.
    let (url, title, text, chash) = db.get_browse_event(1).unwrap().unwrap();
    assert_eq!(url, "https://example.com");
    assert_eq!(title.as_deref(), Some("Example"));
    assert_eq!(text, "page one");
    assert_eq!(chash, crate::ledger::body_hash("page one"));

    // Two distinct pages under 't1' + one under 't2' == 3 stored events.
    let n: i64 = {
        let conn = db.conn.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM browse_events", [], |r| r.get(0)).unwrap()
    };
    assert_eq!(n, 3);

    // The hash chain still verifies with browse_event rows in it.
    assert!(db.verify_ledger_chain().unwrap().ok);

    // The classifier delta surfaces the page text as `body` under a synthetic
    // `browse_event` surface, so the classifier can file it under a class.
    let items = db.list_lake_items_since(0, 100).unwrap();
    let be = items.iter().find(|i| i.kind == "browse_event").unwrap();
    assert_eq!(be.surface.as_deref(), Some("browse_event"));
    assert_eq!(be.body.as_deref(), Some("page one"));
    assert_eq!(be.ref_kind.as_deref(), Some("browse_event"));
}

#[test]
fn browse_trail_edge_round_trips_and_stays_out_of_the_chain() {
    let db = Database::open_in_memory().unwrap();
    let ev = |text: &str, from: Option<i64>| crate::ledger::BrowseEventInput {
        action: crate::ledger::BrowseAction::Navigate,
        browse_id: Some("t1".into()),
        url: "https://example.com".into(),
        title: None,
        text: text.into(),
        from_event_id: from,
        author: None,
    };
    // Root, then a follow — the trail edge points at the preceding row.
    assert!(crate::ledger::record_browse_event(&db, ev("origin page", None)).unwrap().is_some());
    assert!(crate::ledger::record_browse_event(&db, ev("followed page", Some(1))).unwrap().is_some());
    let (root_from, follow_from): (Option<i64>, Option<i64>) = {
        let conn = db.conn.lock().unwrap();
        (
            conn.query_row("SELECT from_event_id FROM browse_events WHERE id = 1", [], |r| r.get(0)).unwrap(),
            conn.query_row("SELECT from_event_id FROM browse_events WHERE id = 2", [], |r| r.get(0)).unwrap(),
        )
    };
    assert_eq!(root_from, None, "a trail root has no edge");
    assert_eq!(follow_from, Some(1));
    // Non-hashed: the chain is blind to the edge and stays green.
    assert!(db.verify_ledger_chain().unwrap().ok);
}

#[test]
fn actor_authorship_separates_human_and_agent_events_on_one_chain() {
    let db = Database::open_in_memory().unwrap();
    // Human prompt (author: None → local_author).
    crate::ledger::record_prompt(
        &db,
        crate::ledger::PromptInput {
            source: crate::ledger::PromptSource::Hook,
            origin: crate::ledger::Origin::Redline,
            surface: "pty".into(),
            role: crate::ledger::CorpusRole::User,
            user_text: None,
            session_id: None,
            claude_session_id: Some("cs-h".into()),
            mission_id: None,
            project_path: None,
            body: "a human prompt".into(),
            thread: None,
            author: None,
            model: None,
            model_source: None,
        },
    )
    .unwrap()
    .unwrap();
    // Agent-constructed prompt authors as its surface seat.
    crate::ledger::record_prompt(
        &db,
        crate::ledger::PromptInput {
            source: crate::ledger::PromptSource::RustFirstTurn,
            origin: crate::ledger::Origin::Redline,
            surface: "browse".into(),
            role: crate::ledger::CorpusRole::User,
            user_text: None,
            session_id: None,
            claude_session_id: Some("cs-a".into()),
            mission_id: None,
            project_path: None,
            body: "a constructed agent prompt".into(),
            thread: None,
            author: Some("browse".into()),
            model: None,
            model_source: None,
        },
    )
    .unwrap()
    .unwrap();
    // Agent browse capture + agent curation carry their seat names.
    crate::ledger::record_browse_event(
        &db,
        crate::ledger::BrowseEventInput {
            action: crate::ledger::BrowseAction::Navigate,
            browse_id: Some("t1".into()),
            url: "https://example.com".into(),
            title: None,
            text: "driven page".into(),
            from_event_id: None,
            author: Some("browse".into()),
        },
    )
    .unwrap()
    .unwrap();
    accepted_node(&db, "cn-a", None, "A");
    crate::classmem::record_curate(&db, "classifier", "cn-a", "organize", "");
    crate::ledger::record_revision_event(&db, "s1", 1, "# plan", None).unwrap().unwrap();

    let mut authors: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for e in db.list_ledger_events(10).unwrap() {
        authors.insert(e.kind, e.author);
    }
    let local = crate::ledger::local_author();
    assert_eq!(authors["revision"], local);
    assert_eq!(authors["class_curate"], "classifier");
    assert_eq!(authors["browse_event"], "browse");
    // The prompt events: one local, one agent (same kind — check both exist).
    let prompt_authors: Vec<String> = db
        .list_ledger_events(10)
        .unwrap()
        .into_iter()
        .filter(|e| e.kind == "prompt")
        .map(|e| e.author)
        .collect();
    assert!(prompt_authors.contains(&local));
    assert!(prompt_authors.contains(&"browse".to_string()));

    // Mixed human/agent authors on ONE chain: verification stays green —
    // the P0 boundary proof (author was always hashed; only its value
    // sharpened).
    let v = db.verify_ledger_chain().unwrap();
    assert!(v.ok, "mixed-author chain must verify: {v:?}");
}

// --- Timeline query (Memory surface P1) --------------------------------

fn tprompt(db: &Database, surface: &str, body: &str, cs: &str, proj: &str, author: &str) {
    crate::ledger::record_prompt(
        db,
        crate::ledger::PromptInput {
            source: crate::ledger::PromptSource::Hook,
            origin: crate::ledger::Origin::Redline,
            surface: surface.into(),
            role: crate::ledger::CorpusRole::User,
            user_text: None,
            session_id: None,
            claude_session_id: Some(cs.into()),
            mission_id: None,
            project_path: Some(proj.into()),
            body: body.into(),
            thread: None,
            author: Some(author.into()),
            model: None,
            model_source: None,
        },
    )
    .unwrap()
    .unwrap();
}

#[test]
fn timeline_query_filters_cursor_and_provenance_joins() {
    let db = Database::open_in_memory().unwrap();
    tprompt(&db, "pty", "alpha prompt body", "cs-1", "/proj/a", "human");
    tprompt(&db, "browse", "beta prompt body", "cs-2", "/proj/b", "browse");
    crate::ledger::record_browse_event(
        &db,
        crate::ledger::BrowseEventInput {
            action: crate::ledger::BrowseAction::Navigate,
            browse_id: Some("t1".into()),
            url: "https://example.com/one".into(),
            title: Some("One".into()),
            text: "page one".into(),
            from_event_id: None,
            author: Some("browse".into()),
        },
    )
    .unwrap()
    .unwrap();
    append(&db, "approval", "h-app");

    let f = crate::context::LedgerFilters::default;
    let all = db.query_ledger_events(&f()).unwrap();
    assert_eq!(all.len(), 4);
    assert!(
        all.windows(2).all(|w| w[0].event.seq > w[1].event.seq),
        "pages are newest-first"
    );

    // Kind facet + preview from the prompt join.
    let prompts = db
        .query_ledger_events(&crate::context::LedgerFilters {
            kind: Some("prompt".into()),
            ..f()
        })
        .unwrap();
    assert_eq!(prompts.len(), 2);
    assert!(prompts.iter().all(|i| i.preview.is_some() && !i.compacted));

    // Actor facet spans event kinds (agent prompt + agent browse capture).
    let agent = db
        .query_ledger_events(&crate::context::LedgerFilters {
            author: Some("browse".into()),
            ..f()
        })
        .unwrap();
    assert_eq!(agent.len(), 2);

    // Surface + project facets ride the prompt join.
    let pty = db
        .query_ledger_events(&crate::context::LedgerFilters {
            surface: Some("pty".into()),
            ..f()
        })
        .unwrap();
    assert_eq!(pty.len(), 1);
    assert_eq!(pty[0].project_path.as_deref(), Some("/proj/a"));
    assert_eq!(pty[0].preview.as_deref(), Some("alpha prompt body"));

    // Bound-LIKE body search.
    let hit = db
        .query_ledger_events(&crate::context::LedgerFilters {
            q: Some("beta prompt".into()),
            ..f()
        })
        .unwrap();
    assert_eq!(hit.len(), 1);
    assert_eq!(hit[0].project_path.as_deref(), Some("/proj/b"));

    // Browse provenance is joined onto the event row.
    let be = db
        .query_ledger_events(&crate::context::LedgerFilters {
            kind: Some("browse_event".into()),
            ..f()
        })
        .unwrap();
    assert_eq!(be.len(), 1);
    assert_eq!(be[0].url.as_deref(), Some("https://example.com/one"));
    assert_eq!(be[0].action.as_deref(), Some("navigate"));
    assert_eq!(be[0].browse_id.as_deref(), Some("t1"));

    // Cursor pages chain without overlap and reach the whole history.
    let page1 = db
        .query_ledger_events(&crate::context::LedgerFilters {
            limit: Some(2),
            ..f()
        })
        .unwrap();
    assert_eq!(page1.len(), 2);
    let page2 = db
        .query_ledger_events(&crate::context::LedgerFilters {
            limit: Some(2),
            before_seq: Some(page1.last().unwrap().event.seq),
            ..f()
        })
        .unwrap();
    assert_eq!(page2.len(), 2);
    assert!(page2[0].event.seq < page1[1].event.seq);
}

#[test]
fn timeline_query_like_filter_is_injection_safe() {
    let db = Database::open_in_memory().unwrap();
    tprompt(&db, "pty", "sale is 100% real", "cs-a", "/p", "human");
    tprompt(&db, "pty", "sale is 100x real", "cs-b", "/p", "human");

    // LIKE metacharacters match literally, not as wildcards.
    let percent = db
        .query_ledger_events(&crate::context::LedgerFilters {
            q: Some("100%".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(percent.len(), 1);
    assert_eq!(percent[0].preview.as_deref(), Some("sale is 100% real"));

    // Hostile text stays a bound value; the table survives.
    let hostile = db
        .query_ledger_events(&crate::context::LedgerFilters {
            q: Some("'; DROP TABLE prompts; --".into()),
            ..Default::default()
        })
        .unwrap();
    assert!(hostile.is_empty());
    assert_eq!(db.query_ledger_events(&Default::default()).unwrap().len(), 2);
}

#[test]
fn timeline_query_class_filing_probes_respect_target_keyspaces() {
    let db = Database::open_in_memory().unwrap();
    // seq 1 = prompt; seq 2 = page, whose browse row id is 1.
    tprompt(&db, "pty", "filed prompt", "cs-1", "/p", "human");
    crate::ledger::record_browse_event(
        &db,
        crate::ledger::BrowseEventInput {
            action: crate::ledger::BrowseAction::Navigate,
            browse_id: Some("t1".into()),
            url: "https://example.com".into(),
            title: None,
            text: "a page".into(),
            from_event_id: None,
            author: None,
        },
    )
    .unwrap()
    .unwrap();

    accepted_node(&db, "cn-p", None, "Prompts");
    accepted_node(&db, "cn-b", None, "Pages");
    add_link(&db, "cn-p", "prompt", "1"); // prompt filed by ledger seq
    add_link(&db, "cn-b", "browse_event", "2"); // page filed by ledger seq
    // Historical malformed link: the page row id collides with a prompt
    // seq. It must never attach to the page (new writers also refuse it).
    accepted_node(&db, "cn-decoy", None, "Decoy");
    add_link(&db, "cn-decoy", "browse_event", "1");

    let all = db.query_ledger_events(&Default::default()).unwrap();
    let prompt = all.iter().find(|i| i.event.kind == "prompt").unwrap();
    assert_eq!(prompt.class_node_id.as_deref(), Some("cn-p"));
    assert_eq!(prompt.class_title.as_deref(), Some("Prompts"));
    let page = all.iter().find(|i| i.event.kind == "browse_event").unwrap();
    assert_eq!(page.class_node_id.as_deref(), Some("cn-b"));
    assert_eq!(page.class_title.as_deref(), Some("Pages"));
}

#[test]
fn timeline_query_citation_focus_filters_by_seqs_and_class_node() {
    let db = Database::open_in_memory().unwrap();
    // seq 1 = first prompt, seq 2 = page (row id 1), seq 3 = second prompt.
    tprompt(&db, "pty", "first prompt", "cs-1", "/p", "human");
    crate::ledger::record_browse_event(
        &db,
        crate::ledger::BrowseEventInput {
            action: crate::ledger::BrowseAction::Navigate,
            browse_id: Some("t1".into()),
            url: "https://example.com".into(),
            title: None,
            text: "a page".into(),
            from_event_id: None,
            author: None,
        },
    )
    .unwrap()
    .unwrap();
    tprompt(&db, "pty", "second prompt", "cs-2", "/p", "human");

    // The Ask agent's `#seq` chips: exact rows, still newest-first; an
    // unknown seq just doesn't match; an empty list is no filter at all.
    let f = crate::context::LedgerFilters::default;
    let picked = db
        .query_ledger_events(&crate::context::LedgerFilters {
            seqs: Some(vec![1, 3, 999]),
            ..f()
        })
        .unwrap();
    assert_eq!(
        picked.iter().map(|i| i.event.seq).collect::<Vec<_>>(),
        vec![3, 1]
    );
    let unfiltered = db
        .query_ledger_events(&crate::context::LedgerFilters {
            seqs: Some(vec![]),
            ..f()
        })
        .unwrap();
    assert_eq!(unfiltered.len(), 3);

    // All seq-addressable links share one keyspace. Only accepted links count.
    accepted_node(&db, "cn-x", None, "X");
    add_link(&db, "cn-x", "prompt", "1"); // the first prompt, by seq
    add_link(&db, "cn-x", "browse_event", "2"); // the page, by ledger seq
    let filed = db
        .query_ledger_events(&crate::context::LedgerFilters {
            class_node: Some("cn-x".into()),
            ..f()
        })
        .unwrap();
    assert_eq!(
        filed.iter().map(|i| i.event.seq).collect::<Vec<_>>(),
        vec![2, 1]
    );
    let none = db
        .query_ledger_events(&crate::context::LedgerFilters {
            class_node: Some("cn-missing".into()),
            ..f()
        })
        .unwrap();
    assert!(none.is_empty());
}

#[test]
fn timeline_query_map_focus_filters_by_thread_and_browse() {
    let db = Database::open_in_memory().unwrap();
    // seq 1 = browse event on tab t1; seq 2 = a linked-thread prompt;
    // seq 3 = a plain pty prompt (matches neither focus).
    crate::ledger::record_browse_event(
        &db,
        crate::ledger::BrowseEventInput {
            action: crate::ledger::BrowseAction::Navigate,
            browse_id: Some("t1".into()),
            url: "https://example.com".into(),
            title: None,
            text: "a page".into(),
            from_event_id: None,
            author: None,
        },
    )
    .unwrap()
    .unwrap();
    crate::ledger::record_prompt(
        &db,
        crate::ledger::PromptInput {
            source: crate::ledger::PromptSource::RustFirstTurn,
            origin: crate::ledger::Origin::Redline,
            surface: "linked".into(),
            role: crate::ledger::CorpusRole::User,
            user_text: None,
            session_id: None,
            claude_session_id: Some("cs-l".into()),
            mission_id: None,
            project_path: None,
            body: "linked turn".into(),
            thread: Some(crate::ledger::ThreadRef {
                thread_kind: "linked",
                thread_id: "L1".into(),
                parent_session_id: None,
            }),
            author: Some("linked".into()),
            model: None,
            model_source: None,
        },
    )
    .unwrap()
    .unwrap();
    tprompt(&db, "pty", "plain prompt", "cs-p", "/p", "human");

    let f = crate::context::LedgerFilters::default;
    let by_thread = db
        .query_ledger_events(&crate::context::LedgerFilters {
            thread_id: Some("L1".into()),
            ..f()
        })
        .unwrap();
    assert_eq!(
        by_thread.iter().map(|i| i.event.seq).collect::<Vec<_>>(),
        vec![2],
        "thread focus reaches exactly the thread's prompts"
    );
    let by_tab = db
        .query_ledger_events(&crate::context::LedgerFilters {
            browse_id: Some("t1".into()),
            ..f()
        })
        .unwrap();
    assert_eq!(
        by_tab.iter().map(|i| i.event.seq).collect::<Vec<_>>(),
        vec![1],
        "browse focus reaches exactly the tab's trail"
    );
    assert!(db
        .query_ledger_events(&crate::context::LedgerFilters {
            browse_id: Some("t-missing".into()),
            ..f()
        })
        .unwrap()
        .is_empty());
}

// --- memory map (Second Brain P5) --------------------------------------

/// Append a ledger event inside a named session — the map fixtures need
/// distinct session ids (the module-wide `append` hardcodes one).
fn append_in(
    db: &Database,
    kind: &str,
    session: &str,
    ph: &str,
) -> crate::ledger::LedgerEventRow {
    db.append_ledger_event(&crate::ledger::LedgerAppend {
        kind,
        author: "tester",
        ts: 1000,
        prompt_id: None,
        session_id: Some(session),
        version_number: None,
        ref_kind: Some("session"),
        ref_id: Some(session),
        payload_hash: ph,
    })
    .unwrap()
}

#[test]
fn memory_map_empty_lake_renders_empty_buckets() {
    let db = Database::open_in_memory().unwrap();
    let m = crate::context::build_memory_map(&db);
    assert!(m.nodes.is_empty());
    assert!(m.edges.is_empty());
}

#[test]
fn memory_map_builds_declared_nodes_and_edges_never_raw_prompts() {
    let db = Database::open_in_memory().unwrap();
    // Three events in session s1 (seqs 1–3): two get filed into classes.
    let e1 = append_in(&db, "prompt", "s1", "h1");
    let e2 = append_in(&db, "prompt", "s1", "h2");
    append_in(&db, "prompt", "s1", "h3");

    // Classes: A (root) ⊃ B; C apart; D/E share a project; P proposed.
    accepted_node(&db, "cn-a", None, "A");
    accepted_node(&db, "cn-b", Some("cn-a"), "B");
    accepted_node(&db, "cn-c", None, "C");
    {
        let now = crate::ledger::now_millis();
        let conn = db.conn.lock().unwrap();
        for id in ["cn-d", "cn-e"] {
            conn.execute(
                "INSERT INTO class_nodes
                        (id, parent_id, kind, title, summary, project_path, ip_name,
                         status, pinned, curated_by, created_at, updated_at)
                     VALUES (?1, NULL, 'node', upper(?1), NULL, '/pp', NULL,
                             'accepted', 0, 'user', ?2, ?2)",
                params![id, now],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO class_nodes
                    (id, parent_id, kind, title, summary, project_path, ip_name,
                     status, pinned, curated_by, created_at, updated_at)
                 VALUES ('cn-p', NULL, 'node', 'P', NULL, NULL, NULL,
                         'proposed', 0, NULL, ?1, ?1)",
            params![now],
        )
        .unwrap();
    }
    // Filings: A and B reach s1 through seq-keyed links; C by direct
    // session link — all three share s1, but A↔B is parent↔child.
    add_link(&db, "cn-a", "prompt", &e1.seq.to_string());
    add_link(&db, "cn-b", "prompt", &e2.seq.to_string());
    add_link(&db, "cn-c", "session", "s1");

    // Lineage: a browse tab under a plan session.
    db.insert_session_link("browse", "tab-1", "session", "s9", 1000)
        .unwrap();

    let m = crate::context::build_memory_map(&db);

    // Rule 1: classes and sessions only — the three prompts are mass,
    // never dots; the proposed node is not on the record yet.
    assert_eq!(
        m.nodes.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
        vec![
            "class:cn-a",
            "class:cn-b",
            "class:cn-c",
            "class:cn-d",
            "class:cn-e",
            "thread:browse:tab-1",
            "thread:session:s9",
        ]
    );
    let node = |id: &str| m.nodes.iter().find(|n| n.id == id).unwrap();
    assert_eq!(node("class:cn-a").mass, 1);
    assert_eq!(node("class:cn-b").parent_id.as_deref(), Some("class:cn-a"));
    assert_eq!(node("thread:browse:tab-1").kind, "thread");
    assert_eq!(node("thread:browse:tab-1").browse_id.as_deref(), Some("tab-1"));
    assert_eq!(
        node("thread:browse:tab-1").parent_id.as_deref(),
        Some("thread:session:s9")
    );
    assert_eq!(node("thread:session:s9").kind, "session");
    assert_eq!(node("thread:session:s9").session_id.as_deref(), Some("s9"));

    // Declared edges, deterministic order: contains, lineage, then the
    // derived co-occurrences — shared session A↔C and B↔C (parent↔child
    // A↔B is `contains`' job), shared project D↔E.
    let flat: Vec<(String, String, String, i64)> = m
        .edges
        .iter()
        .map(|e| (e.kind.clone(), e.from.clone(), e.to.clone(), e.weight))
        .collect();
    assert_eq!(
        flat,
        vec![
            ("co_occurs".into(), "class:cn-a".into(), "class:cn-c".into(), 1),
            ("co_occurs".into(), "class:cn-b".into(), "class:cn-c".into(), 1),
            ("co_occurs".into(), "class:cn-d".into(), "class:cn-e".into(), 1),
            ("contains".into(), "class:cn-a".into(), "class:cn-b".into(), 1),
            ("lineage".into(), "thread:session:s9".into(), "thread:browse:tab-1".into(), 1),
        ]
    );
    let basis = |from: &str, to: &str| {
        m.edges
            .iter()
            .find(|e| e.from == from && e.to == to)
            .and_then(|e| e.basis.as_deref().map(str::to_string))
    };
    assert_eq!(
        basis("class:cn-a", "class:cn-c").as_deref(),
        Some("1 shared session")
    );
    assert_eq!(
        basis("class:cn-d", "class:cn-e").as_deref(),
        Some("shared project")
    );

    // Determinism: the payload (minus the timestamp) is byte-identical
    // across builds — the seeded layout downstream depends on it.
    let again = crate::context::build_memory_map(&db);
    assert_eq!(
        serde_json::to_string(&m.nodes).unwrap(),
        serde_json::to_string(&again.nodes).unwrap()
    );
    assert_eq!(
        serde_json::to_string(&m.edges).unwrap(),
        serde_json::to_string(&again.edges).unwrap()
    );
}

#[test]
fn memory_map_supersedes_edge_resolves_to_class_else_session() {
    let db = Database::open_in_memory().unwrap();
    // The synthetic fixture the empty `supersessions` table demands: a
    // resolution in sA superseded by an approval in sB.
    let r1 = append_in(&db, "resolution", "sA", "h1");
    let a1 = append_in(&db, "approval", "sB", "h2");
    match db.apply_supersession(r1.seq, a1.seq, "newer", "tester").unwrap() {
        crate::classmem::SupersessionOutcome::Applied { .. } => {}
        other => panic!("expected Applied, got {other:?}"),
    }
    // The old decision is filed; the new one is not — so the edge runs
    // class → session, and sB becomes a node just by hosting a decision.
    accepted_node(&db, "cn-x", None, "X");
    add_link(&db, "cn-x", "decision", &r1.seq.to_string());

    let m = crate::context::build_memory_map(&db);
    assert!(m.nodes.iter().any(|n| n.id == "thread:session:sB"));
    let sup: Vec<&crate::context::MapEdge> =
        m.edges.iter().filter(|e| e.kind == "supersedes").collect();
    assert_eq!(sup.len(), 1);
    assert_eq!(sup[0].from, "class:cn-x");
    assert_eq!(sup[0].to, "thread:session:sB");
    assert_eq!(sup[0].weight, 1);
    assert_eq!(
        sup[0].basis.as_deref(),
        Some(format!("#{} → #{}", r1.seq, a1.seq).as_str())
    );
}

// --- user notes (Second Brain P3) --------------------------------------

fn nwrite(
    target: Option<(&str, &str)>,
    note_id: Option<i64>,
    text: Option<&str>,
    starred: Option<bool>,
) -> crate::context::NoteWrite {
    crate::context::NoteWrite {
        note_id,
        target_kind: target.map(|(k, _)| k.to_string()),
        target_id: target.map(|(_, id)| id.to_string()),
        text: text.map(str::to_string),
        starred,
    }
}

fn written(out: crate::context::NoteOutcome) -> crate::context::UserNote {
    match out {
        crate::context::NoteOutcome::Written(n) => n,
        other => panic!("expected Written, got {other:?}"),
    }
}

#[test]
fn user_note_acts_append_one_event_each_and_keep_the_chain_green() {
    let db = Database::open_in_memory().unwrap();
    tprompt(&db, "pty", "alpha prompt body", "cs-1", "/p", "human");
    let note_events =
        || db.list_ledger_events(50).unwrap().iter().filter(|e| e.kind == "note").count();

    // Write, then edit — same row, one event per act.
    let ev = |t: Option<&str>, s: Option<bool>| nwrite(Some(("ledger_event", "1")), None, t, s);
    let n1 = written(db.write_user_note(&ev(Some("check this against P2"), None), "human").unwrap());
    assert_eq!(n1.text, "check this against P2");
    assert_eq!(note_events(), 1);
    let n2 = written(db.write_user_note(&ev(Some("checked; superseded by P3"), None), "human").unwrap());
    assert_eq!(n2.id, n1.id, "one row per target — edits update it");
    assert_eq!(note_events(), 2);

    // A no-op act appends NOTHING.
    match db.write_user_note(&ev(Some("checked; superseded by P3"), None), "human").unwrap() {
        crate::context::NoteOutcome::Unchanged(_) => {}
        other => panic!("no-op must be Unchanged, got {other:?}"),
    }
    assert_eq!(note_events(), 2);

    // Star / unstar are their own acts on the same row.
    let n3 = written(db.write_user_note(&ev(None, Some(true)), "human").unwrap());
    assert!(n3.starred);
    assert_eq!(n3.id, n1.id);
    assert_eq!(note_events(), 3);
    match db.write_user_note(&ev(None, Some(true)), "human").unwrap() {
        crate::context::NoteOutcome::Unchanged(_) => {}
        other => panic!("re-star must be Unchanged, got {other:?}"),
    }
    let n4 = written(db.write_user_note(&ev(None, Some(false)), "human").unwrap());
    assert!(!n4.starred);
    assert_eq!(note_events(), 4);

    // The row reads back; the event references its target.
    let got = db.get_user_note("ledger_event", "1").unwrap().unwrap();
    assert_eq!(got.text, "checked; superseded by P3");
    assert_eq!(got.seq, n4.seq);
    let ev_row = db
        .list_ledger_events(50)
        .unwrap()
        .into_iter()
        .find(|e| e.kind == "note")
        .unwrap();
    assert_eq!(ev_row.ref_kind.as_deref(), Some("ledger_event"));
    assert_eq!(ev_row.ref_id.as_deref(), Some("1"));

    // Rejections: phantom target, no act, two acts at once.
    let rejected = |out: crate::context::NoteOutcome| {
        matches!(out, crate::context::NoteOutcome::Rejected(_))
    };
    assert!(rejected(
        db.write_user_note(&nwrite(Some(("ledger_event", "999")), None, Some("x"), None), "human")
            .unwrap()
    ));
    assert!(rejected(
        db.write_user_note(&nwrite(Some(("ledger_event", "1")), None, None, None), "human")
            .unwrap()
    ));
    assert!(rejected(
        db.write_user_note(
            &nwrite(Some(("ledger_event", "1")), None, Some("x"), Some(true)),
            "human"
        )
        .unwrap()
    ));
    assert!(rejected(
        db.write_user_note(&nwrite(Some(("diary", "1")), None, Some("x"), None), "human")
            .unwrap()
    ));

    // The one non-negotiable: `CanonicalEvent` untouched, chain green.
    let v = db.verify_ledger_chain().unwrap();
    assert!(v.ok, "note acts must not disturb the chain: {v:?}");
}

#[test]
fn standalone_notes_each_own_a_row_and_edit_by_id() {
    let db = Database::open_in_memory().unwrap();
    let a = written(
        db.write_user_note(&nwrite(None, None, Some("a loose thought"), None), "human").unwrap(),
    );
    let b = written(
        db.write_user_note(&nwrite(None, None, Some("another thought"), None), "human").unwrap(),
    );
    assert_eq!(a.target_kind, "none");
    assert_ne!(a.id, b.id, "each standalone thought is its own row");

    // The event references the ROW (ref_kind='none', ref_id=row id).
    let evs: Vec<_> = db
        .list_ledger_events(10)
        .unwrap()
        .into_iter()
        .filter(|e| e.kind == "note")
        .collect();
    assert_eq!(evs.len(), 2);
    assert!(evs.iter().all(|e| e.ref_kind.as_deref() == Some("none")));
    assert!(evs.iter().any(|e| e.ref_id.as_deref() == Some(&a.id.to_string() as &str)));

    // Edits address the row by id; an empty standalone is rejected.
    let a2 = written(
        db.write_user_note(&nwrite(None, Some(a.id), Some("a sharper thought"), None), "human")
            .unwrap(),
    );
    assert_eq!(a2.id, a.id);
    assert!(matches!(
        db.write_user_note(&nwrite(None, None, Some("   "), None), "human").unwrap(),
        crate::context::NoteOutcome::Rejected(_)
    ));

    // Starring one filters the list.
    written(db.write_user_note(&nwrite(None, Some(b.id), None, Some(true)), "human").unwrap());
    let all = db.list_user_notes(false, 100).unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].id, b.id, "most recently touched first");
    let starred = db.list_user_notes(true, 100).unwrap();
    assert_eq!(starred.len(), 1);
    assert_eq!(starred[0].id, b.id);

    assert!(db.verify_ledger_chain().unwrap().ok);
}

#[test]
fn timeline_carries_star_note_probes_and_facets_filter() {
    let db = Database::open_in_memory().unwrap();
    tprompt(&db, "pty", "alpha prompt body", "cs-1", "/p", "human"); // seq 1
    tprompt(&db, "pty", "beta prompt body", "cs-2", "/p", "human"); // seq 2
    written(
        db.write_user_note(&nwrite(Some(("ledger_event", "1")), None, None, Some(true)), "human")
            .unwrap(),
    ); // seq 3
    written(
        db.write_user_note(
            &nwrite(Some(("ledger_event", "2")), None, Some("remember the beta"), None),
            "human",
        )
        .unwrap(),
    ); // seq 4
    written(
        db.write_user_note(&nwrite(None, None, Some("a loose thought"), None), "human").unwrap(),
    ); // seq 5

    let all = db.query_ledger_events(&Default::default()).unwrap();
    assert_eq!(all.len(), 5);
    let by_seq = |s: i64| all.iter().find(|i| i.event.seq == s).unwrap();
    assert!(by_seq(1).starred && by_seq(1).note.is_none());
    assert_eq!(by_seq(2).note.as_deref(), Some("remember the beta"));
    assert!(!by_seq(2).starred);
    // A note event's list text is its row's current words, not a hash.
    assert_eq!(by_seq(5).preview.as_deref(), Some("a loose thought"));

    // Facets: starred = the annotated event + the star act's own event;
    // noted = the noted event + both text-bearing note events.
    let starred = db
        .query_ledger_events(&crate::context::LedgerFilters {
            starred: Some(true),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        starred.iter().map(|i| i.event.seq).collect::<Vec<_>>(),
        vec![3, 1]
    );
    let noted = db
        .query_ledger_events(&crate::context::LedgerFilters {
            noted: Some(true),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        noted.iter().map(|i| i.event.seq).collect::<Vec<_>>(),
        vec![5, 4, 2]
    );

    // Body search reaches note text.
    let hit = db
        .query_ledger_events(&crate::context::LedgerFilters {
            q: Some("loose thought".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(hit.iter().map(|i| i.event.seq).collect::<Vec<_>>(), vec![5]);
}

#[test]
fn note_events_are_lake_items_with_their_current_words() {
    let db = Database::open_in_memory().unwrap();
    tprompt(&db, "pty", "alpha prompt body", "cs-1", "/p", "human"); // seq 1
    written(
        db.write_user_note(
            &nwrite(Some(("ledger_event", "1")), None, Some("margin note"), None),
            "human",
        )
        .unwrap(),
    ); // seq 2
    let standalone = written(
        db.write_user_note(&nwrite(None, None, Some("a standalone thought"), None), "human")
            .unwrap(),
    ); // seq 3
    // An EDIT after the events were appended: the classifier reads the
    // row's CURRENT words for every act-event of that row.
    written(
        db.write_user_note(&nwrite(None, Some(standalone.id), Some("sharper words"), None), "human")
            .unwrap(),
    ); // seq 4

    let items = db.list_lake_items_since(0, 100).unwrap();
    assert_eq!(items.len(), 4);
    let notes: Vec<_> = items.iter().filter(|i| i.kind == "note").collect();
    assert_eq!(notes.len(), 3);
    assert!(notes.iter().all(|i| i.surface.as_deref() == Some("note")));
    assert_eq!(notes[0].body.as_deref(), Some("margin note"));
    assert!(notes[1..].iter().all(|i| i.body.as_deref() == Some("sharper words")));
}

#[test]
fn revert_link_removes_pointer_appends_compensating_event_and_keeps_chain_green() {
    let db = Database::open_in_memory().unwrap();
    // An accepted class with an accepted link — the gardener's "file" outcome.
    accepted_node(&db, "root-r", None, "redline");
    let link_id = add_link(&db, "root-r", "prompt", "42");
    // Record the accept as a curate event, like the gardener does.
    crate::classmem::record_curate(&db, "classifier", "root-r", "organize", "");
    assert!(db.verify_ledger_chain().unwrap().ok);

    // Revert → the pointer is gone, but the ledger only GREW (a compensating
    // 'revert' class_curate event), so the chain still verifies.
    assert!(crate::classmem::revert_link(&db, "tester", link_id).unwrap());
    assert!(db.list_class_links_for_node("root-r").unwrap().is_empty());
    assert!(db.verify_ledger_chain().unwrap().ok);

    // Two class_curate events exist: the original accept + the revert.
    let n: i64 = {
        let conn = db.conn.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM ledger_events WHERE kind = 'class_curate'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    };
    assert_eq!(n, 2);

    // Reverting a link that no longer exists is a no-op (false), no new event.
    assert!(!crate::classmem::revert_link(&db, "tester", link_id).unwrap());
}

#[test]
fn session_link_records_tree_row_and_event_and_keeps_chain_green() {
    let db = Database::open_in_memory().unwrap();
    append(&db, "prompt", "h1"); // pre-existing history

    // First link: tree row + a session_link ledger event, chain stays green.
    let seq = crate::ledger::record_session_link(&db, "browse", "tab-1", "session", "s9")
        .unwrap();
    assert!(seq.is_some());
    assert_eq!(
        db.session_tree_parent("browse", "tab-1").unwrap(),
        Some(("session".to_string(), "s9".to_string()))
    );
    let verdict = db.verify_ledger_chain().unwrap();
    assert!(verdict.ok, "chain must verify with a session_link event in it");

    // Idempotent: a child has one parent; re-linking is a no-op (no event).
    let again =
        crate::ledger::record_session_link(&db, "browse", "tab-1", "mission", "m1").unwrap();
    assert!(again.is_none());
    assert_eq!(
        db.session_tree_parent("browse", "tab-1").unwrap(),
        Some(("session".to_string(), "s9".to_string())),
        "first write wins"
    );

    // Children walk from the parent side.
    crate::ledger::record_session_link(&db, "voice", "s9", "session", "s9").unwrap();
    let kids = db.session_tree_children("session", "s9").unwrap();
    assert_eq!(kids.len(), 2);
    assert!(db.verify_ledger_chain().unwrap().ok);

    // Blank ids record nothing.
    assert!(crate::ledger::record_session_link(&db, "browse", " ", "session", "s9")
        .unwrap()
        .is_none());
}

#[test]
fn journal_appends_lists_and_prunes() {
    let db = Database::open_in_memory().unwrap();
    let first = db
        .append_journal("surface_switch", Some("plan"), Some("s1"), Some("My plan"), None)
        .unwrap();
    db.append_journal("nav", Some("browser"), None, Some("Example"), Some("https://x"))
        .unwrap();
    let head = db.journal_head().unwrap();
    assert!(head > first);

    // Delta read: strictly after `since`, oldest-first.
    let delta = db.list_journal_since(first, 100).unwrap();
    assert_eq!(delta.len(), 1);
    assert_eq!(delta[0].kind, "nav");
    assert_eq!(delta[0].detail.as_deref(), Some("https://x"));

    // Prune: rows older than the 2000-row window are dropped on insert.
    for i in 0..2005 {
        db.append_journal("agent_turn", Some("browse"), Some(&format!("t{i}")), None, None)
            .unwrap();
    }
    let n: i64 = {
        let conn = db.conn.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM context_journal", [], |r| r.get(0))
            .unwrap()
    };
    assert!(n <= 2000, "journal working set stays bounded, got {n}");
}

#[test]
fn friction_events_prune_on_insert_and_summarize_by_kind() {
    let db = Database::open_in_memory().unwrap();
    db.record_friction("stall_kill", Some("review"), Some("r1"), Some("180s"))
        .unwrap();
    for _ in 0..3 {
        db.record_friction("context_overflow", Some("browse"), Some("b1"), Some("too long"))
            .unwrap();
    }
    let summary = db.friction_summary(90 * 24 * 60 * 60 * 1000).unwrap();
    // Most-frequent first, so the digest ranks without re-sorting.
    assert_eq!(summary[0].kind, "context_overflow");
    assert_eq!(summary[0].count, 3);
    assert_eq!(summary[0].last_detail.as_deref(), Some("too long"));
    assert_eq!(summary[1].kind, "stall_kill");

    // `detail` is capped so one pathological error can't dominate the table.
    db.record_friction("transient_fail", None, None, Some(&"x".repeat(5000)))
        .unwrap();
    let long = db
        .friction_summary(i64::MAX / 2)
        .unwrap()
        .into_iter()
        .find(|f| f.kind == "transient_fail")
        .unwrap();
    assert_eq!(long.last_detail.unwrap().len(), 500);

    // Prune-on-insert: the working set stays bounded past the row cap.
    for i in 0..5010 {
        db.record_friction("turn_timeout", None, Some(&format!("t{i}")), None)
            .unwrap();
    }
    let n: i64 = {
        let conn = db.conn.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM friction_events", [], |r| r.get(0))
            .unwrap()
    };
    assert!(n <= 5000, "friction working set stays bounded, got {n}");
}

#[test]
fn a_window_older_than_every_row_summarizes_to_nothing() {
    let db = Database::open_in_memory().unwrap();
    db.record_friction("stall_kill", None, None, None).unwrap();
    // A zero-length window excludes everything written before "now".
    assert!(db.friction_summary(0).unwrap().len() <= 1);
}

#[test]
fn shipwright_dedupe_ignores_dismissed_so_a_dismissal_sticks() {
    let db = Database::open_in_memory().unwrap();
    let f = |id: &str, summary: &str| ShipwrightFinding {
        id: id.to_string(),
        run_id: "run-1".to_string(),
        category: "ci_coverage".to_string(),
        summary: summary.to_string(),
        evidence: Some("457 Rust tests, 0 workflows".to_string()),
        proposal: None,
        guard: None,
        files: Some(r#"[".github/workflows/ci.yml"]"#.to_string()),
        status: "pending".to_string(),
        dismissed: false,
        draft_id: None,
        created_at: 1,
        resolved_at: None,
    };
    assert!(db.insert_shipwright_finding(&f("a", "No test workflow")).unwrap().is_some());
    // Same (category, summary) → skipped, even before any dismissal.
    assert!(db.insert_shipwright_finding(&f("b", "No test workflow")).unwrap().is_none());

    db.dismiss_shipwright_finding_for_test("a").unwrap();
    // …and still skipped afterwards: a dismissed finding never resurfaces
    // under the same wording. This is the property the whole loop rests on.
    assert!(db.insert_shipwright_finding(&f("c", "No test workflow")).unwrap().is_none());
    assert!(db.list_shipwright_findings(false).unwrap().is_empty());
    assert_eq!(db.list_shipwright_findings(true).unwrap().len(), 1);

    // A genuinely new summary still lands.
    assert!(db.insert_shipwright_finding(&f("d", "No typecheck script")).unwrap().is_some());
}

#[test]
fn prompt_thread_provenance_round_trips_into_lake_items() {
    let db = Database::open_in_memory().unwrap();
    crate::ledger::record_prompt(
        &db,
        crate::ledger::PromptInput {
            source: crate::ledger::PromptSource::RustFirstTurn,
            origin: crate::ledger::Origin::Redline,
            surface: "browse".to_string(),
            role: crate::ledger::CorpusRole::User,
            user_text: None,
            session_id: None,
            claude_session_id: None,
            mission_id: None,
            project_path: None,
            body: "discuss this page".to_string(),
            thread: Some(crate::ledger::ThreadRef {
                thread_kind: "browse",
                thread_id: "tab-1".to_string(),
                parent_session_id: Some("s9".to_string()),
            }),
            author: None,
            model: None,
            model_source: None,
        },
    )
    .unwrap();
    let items = db.list_lake_items_since(0, 10).unwrap();
    let it = items.iter().find(|i| i.kind == "prompt").unwrap();
    assert_eq!(it.thread_kind.as_deref(), Some("browse"));
    assert_eq!(it.thread_id.as_deref(), Some("tab-1"));
    assert_eq!(it.parent_session_id.as_deref(), Some("s9"));
    // The chain is body-blind to the new columns: still green.
    assert!(db.verify_ledger_chain().unwrap().ok);
}

#[test]
fn generic_thread_reader_maps_kinds_and_rejects_unknown() {
    let db = Database::open_in_memory().unwrap();
    db.insert_browse_message(&BrowseMessage {
        id: "b1".into(),
        browse_id: "tab-1".into(),
        role: "user".into(),
        body: "hello".into(),
        status: "complete".into(),
        created_at: 10,
        backend: None,
        target_browse_id: None,
    })
    .unwrap();
    db.insert_browse_message(&BrowseMessage {
        id: "b2".into(),
        browse_id: "tab-1".into(),
        role: "assistant".into(),
        body: "hi".into(),
        status: "complete".into(),
        created_at: 20,
        backend: None,
        target_browse_id: None,
    })
    .unwrap();
    let msgs = db.load_thread_generic("browse", "tab-1", 50).unwrap().unwrap();
    assert_eq!(msgs.len(), 2);
    assert_eq!(msgs[0].role, "user", "oldest-first");
    let (count, last) = db.thread_stats("browse", "tab-1").unwrap();
    assert_eq!(count, 2);
    assert_eq!(last, Some(20));
    assert!(db.load_thread_generic("nope", "x", 10).unwrap().is_none());
}

/// The context route is how the Companion and every consult agent read a
/// peer thread. An `error` row is an assistant-role row REDLINE wrote —
/// serving it makes a peer agent reason from "the model said
/// `error_during_execution`". The UI still shows them; the machine route
/// must not.
#[test]
fn generic_thread_reader_hides_error_rows_and_still_serves_voice() {
    use crate::state::VoiceMessage;
    let db = Database::open_in_memory().unwrap();
    let msg = |id: &str, role: &str, body: &str, status: &str, at: i64| BrowseMessage {
        id: id.into(),
        browse_id: "tab-1".into(),
        role: role.into(),
        body: body.into(),
        status: status.into(),
        created_at: at,
        backend: None,
        target_browse_id: None,
    };
    db.insert_browse_message(&msg("b1", "user", "hello", "complete", 10)).unwrap();
    db.insert_browse_message(&msg("b2", "assistant", "error_during_execution", "error", 20))
        .unwrap();
    db.insert_browse_message(&msg("b3", "assistant", "hi", "complete", 30)).unwrap();

    let msgs = db.load_thread_generic("browse", "tab-1", 50).unwrap().unwrap();
    assert_eq!(msgs.len(), 2, "the error row is not served");
    assert!(
        !msgs.iter().any(|m| m.body.contains("error_during_execution")),
        "a machine token reached a peer agent"
    );
    // `thread_stats` is a count, not context — it deliberately still sees
    // every row, so a thread does not appear emptier than it is.
    assert_eq!(db.thread_stats("browse", "tab-1").unwrap().0, 3);

    // `voice_messages` has NO status column: the filter must be omitted
    // there rather than 500-ing a route three prompts advertise.
    db.insert_voice_message(&VoiceMessage {
        id: "v1".into(),
        session_key: "s-1".into(),
        role: "agent".into(),
        text: "spoken".into(),
        created_at: 10,
    })
    .unwrap();
    let voice = db.load_thread_generic("voice", "s-1", 50).unwrap().unwrap();
    assert_eq!(voice.len(), 1);
    assert_eq!(voice[0].body, "spoken");
}

#[test]
fn browse_events_fts_ranks_keyword_hits_and_is_injection_safe() {
    let db = Database::open_in_memory().unwrap();
    let page = |url: &str, title: &str, text: &str| crate::ledger::BrowseEventInput {
        action: crate::ledger::BrowseAction::Navigate,
        browse_id: Some("t1".into()),
        url: url.into(),
        title: Some(title.into()),
        text: text.into(),
        from_event_id: None,
        author: None,
    };
    crate::ledger::record_browse_event(
        &db,
        page("https://a.example", "Clerk auth", "Clerk provides authentication for Next.js apps"),
    )
    .unwrap();
    crate::ledger::record_browse_event(
        &db,
        page("https://b.example", "Postgres tuning", "vacuum and autovacuum settings for large tables"),
    )
    .unwrap();

    // A keyword search returns the matching page, not the other.
    let hits = db.search_browse_events("authentication", 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].url, "https://a.example");
    assert!(hits[0].snippet.contains('[') && hits[0].snippet.contains(']'));

    // A browse hit must be CITABLE. It used to carry `browse_events.id`,
    // which is a different id-space from the ledger `seq` that `#seq` chips
    // and the Timeline's filter both speak — so a page the Ask agent cited
    // pointed the user at some unrelated event. Verified 1:1 and complete
    // on live data (829 events, 829 ledger rows, 0 duplicates).
    let seq = hits[0].seq.expect("a browse hit carries its ledger seq");
    let ev = db.list_ledger_events(10).unwrap();
    let row = ev.iter().find(|e| e.seq == seq).expect("the seq resolves to a real event");
    assert_eq!(row.ref_kind.as_deref(), Some("browse_event"));
    assert_eq!(row.ref_id.as_deref(), Some(hits[0].id.to_string().as_str()));

    // The cascade widens only when the precise reading fails.
    let both = db.search_browse_events("vacuum authentication", 10).unwrap();
    assert_eq!(both.len(), 2, "no page has both terms, so the OR stage answers");
    assert!(both.iter().all(|h| h.stage == "or"));
    assert_eq!(
        db.search_browse_events("clerk authentication", 10).unwrap()[0].stage,
        "and",
        "…and a page with every term is found precisely"
    );

    // An FTS-operator-shaped query can't error out — it matches literally
    // (no such literal here) and simply returns nothing.
    assert!(db.search_browse_events("\"unterminated OR (", 10).unwrap().is_empty());
    // A query with no searchable tokens yields no hits (not an error).
    assert!(db.search_browse_events("   *  ", 10).unwrap().is_empty());
}

#[test]
fn filing_with_a_sub_class_writes_the_node_and_the_link_live() {
    let db = Database::open_in_memory().unwrap();
    accepted_node(&db, "root-r", None, "redline");
    // file with a new sub_class → the sub-node and the link, both live (B3).
    let out = db
        .stage_proposal(
            None,
            &Proposal::File {
                parent_id: "root-r".into(),
                sub_class: Some("Loop Engineering".into()),
                target_kind: "prompt".into(),
                target_id: "42".into(),
                note: None,
                rationale: None,
            },
        )
        .unwrap();
    assert!(matches!(out, crate::classmem::StagedOutcome::Link { created_node: true }));
    let sub = db
        .list_class_nodes()
        .unwrap()
        .into_iter()
        .find(|n| n.title == "Loop Engineering")
        .unwrap();
    assert_eq!(sub.status, "accepted");
    let link = db.list_class_links_for_node(&sub.id).unwrap().remove(0);
    assert_eq!(link.status, "accepted");
    assert_eq!(link.node_id, sub.id);
}

#[test]
fn promotion_preserves_id_links_and_subtree_and_writes_reorg() {
    let db = Database::open_in_memory().unwrap();
    accepted_node(&db, "root-a", None, "A");
    accepted_node(&db, "root-b", None, "B");
    accepted_node(&db, "grown", Some("root-a"), "Grown Topic");
    accepted_node(&db, "child", Some("grown"), "Child");
    let link_id = add_link(&db, "grown", "prompt", "99");

    // Stage + apply a promote of `grown` from root-a to root-b.
    db.stage_proposal(
        None,
        &Proposal::Promote {
            node_id: "grown".into(),
            new_parent_id: Some("root-b".into()),
            rationale: Some("earns its own class".into()),
        },
    )
    .unwrap();
    let prop = db.list_class_proposals().unwrap().remove(0);
    let applied = db.apply_class_proposal(prop.id, "tester").unwrap().unwrap();
    crate::classmem::record_reorg(&db, "tester", &applied.op, &applied.node_id, &applied.detail);

    let g = db.get_class_node("grown").unwrap().unwrap();
    assert_eq!(g.id, "grown"); // id preserved
    assert_eq!(g.parent_id.as_deref(), Some("root-b")); // re-parented
    // links preserved (same id)
    let links = db.list_class_links_for_node("grown").unwrap();
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].id, link_id);
    // subtree preserved
    assert_eq!(
        db.get_class_node("child").unwrap().unwrap().parent_id.as_deref(),
        Some("grown")
    );
    // proposal consumed + a reorg ledger event written
    assert!(db.list_class_proposals().unwrap().is_empty());
    assert_eq!(count_reorg_events(&db), 1);
}

#[test]
fn collapse_creates_digest_with_citations_and_removes_cold_branch() {
    let db = Database::open_in_memory().unwrap();
    accepted_node(&db, "root-r", None, "redline");
    accepted_node(&db, "cold", Some("root-r"), "Old Research");
    add_link(&db, "cold", "prompt", "10");
    // Two real ledger rows to cite (so link_preview can resolve them later).
    append(&db, "prompt", "h10");
    append(&db, "approval", "h11");

    db.stage_proposal(
        None,
        &Proposal::Collapse {
            node_id: "cold".into(),
            summary: "Explored X; parked, no position taken.".into(),
            cite_seqs: vec![1, 2],
            rationale: Some("cold, unpinned".into()),
        },
    )
    .unwrap();
    let prop = db.list_class_proposals().unwrap().remove(0);
    let applied = db.apply_class_proposal(prop.id, "tester").unwrap().unwrap();
    crate::classmem::record_reorg(&db, "tester", &applied.op, &applied.node_id, &applied.detail);

    // Original cold branch is gone.
    assert!(db.get_class_node("cold").unwrap().is_none());
    // A digest node exists under the root with the summary + citation links.
    let digest = db
        .list_class_nodes()
        .unwrap()
        .into_iter()
        .find(|n| n.kind == "digest")
        .unwrap();
    assert_eq!(digest.parent_id.as_deref(), Some("root-r"));
    assert_eq!(digest.summary.as_deref(), Some("Explored X; parked, no position taken."));
    let cites = db.list_class_links_for_node(&digest.id).unwrap();
    assert_eq!(cites.len(), 2);
    assert!(cites.iter().all(|l| l.target_kind == "ledger"));
    assert_eq!(count_reorg_events(&db), 1);
}

#[test]
fn activity_and_envelope_feed_coldness() {
    let db = Database::open_in_memory().unwrap();
    accepted_node(&db, "root-r", None, "redline");
    // Two ledger rows at distinct ts, linked under the node.
    {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO ledger_events (seq, ts, kind, author, payload_hash, prev_hash, entry_hash)
                 VALUES (1, 100, 'prompt', 't', 'p', 'x', 'y'), (2, 900, 'approval', 't', 'p2', 'y', 'z')",
            [],
        )
        .unwrap();
    }
    add_link(&db, "root-r", "prompt", "1");
    add_link(&db, "root-r", "decision", "2");
    let direct = db.node_direct_link_activity().unwrap();
    let (count, last) = direct.get("root-r").copied().unwrap();
    assert_eq!(count, 2);
    assert_eq!(last, Some(900)); // newest linked ledger ts
    let env = db.lake_envelope().unwrap();
    assert_eq!((env.oldest, env.newest), (100, 900));
}

#[test]
fn compaction_swaps_body_for_gist_but_keeps_chain_and_hash() {
    let db = Database::open_in_memory().unwrap();
    let seq = crate::ledger::record_prompt(
        &db,
        crate::ledger::PromptInput {
            source: crate::ledger::PromptSource::Hook,
            origin: crate::ledger::Origin::Redline,
            surface: "pty_plan".into(),
            role: crate::ledger::CorpusRole::User,
            user_text: None,
            session_id: Some("s1".into()),
            claude_session_id: Some("cs1".into()),
            mission_id: None,
            project_path: None,
            body: "a long cold prompt body destined to be compacted to a gist".into(),
            thread: None,
            author: None,
            model: None,
            model_source: None,
        },
    )
    .unwrap()
    .unwrap();
    let ev = db.list_ledger_events(10).unwrap();
    let prompt_ev = ev.iter().find(|e| e.seq == seq).unwrap();
    let pid = prompt_ev.prompt_id.unwrap();
    let orig_hash = prompt_ev.payload_hash.clone(); // == prompts.body_hash

    // Chain is intact before.
    assert!(db.verify_ledger_chain().unwrap().ok);

    // Compact it → a new ledger seq is returned.
    let cseq = db.compact_prompt_body(pid, "gist: a cold prompt", "cold", "agent", "keeper").unwrap();
    assert!(cseq.is_some());

    // The body now reads as the gist for every consumer.
    assert_eq!(
        db.get_prompt_body(pid).unwrap().as_deref(),
        Some("gist: a cold prompt")
    );

    // The chain STILL verifies — verification is body-blind.
    assert!(
        db.verify_ledger_chain().unwrap().ok,
        "chain survives a body swap"
    );

    // A `compaction` event referencing the prompt exists…
    let ev2 = db.list_ledger_events(10).unwrap();
    assert!(ev2
        .iter()
        .any(|e| e.kind == "compaction" && e.prompt_id == Some(pid)));

    // …and the ORIGINAL body_hash (dedup key + tamper-evident fact) is untouched.
    let bh: String = {
        let c = db.conn.lock().unwrap();
        c.query_row(
            "SELECT body_hash FROM prompts WHERE id = ?1",
            params![pid],
            |r| r.get(0),
        )
        .unwrap()
    };
    assert_eq!(bh, orig_hash, "body_hash is never rewritten");

    // Idempotent: compacting again is a no-op.
    assert!(db.compact_prompt_body(pid, "again", "cold", "agent", "keeper").unwrap().is_none());
}

#[test]
fn merge_folds_links_and_children_into_the_target() {
    let db = Database::open_in_memory().unwrap();
    accepted_node(&db, "root-r", None, "redline");
    accepted_node(&db, "auth1", Some("root-r"), "Auth");
    accepted_node(&db, "auth2", Some("root-r"), "Authentication");
    accepted_node(&db, "auth2child", Some("auth2"), "Clerk");
    add_link(&db, "auth1", "prompt", "1");
    add_link(&db, "auth2", "prompt", "2");

    db.stage_proposal(
        None,
        &Proposal::Merge {
            node_ids: vec!["auth1".into(), "auth2".into()],
            title: Some("Auth".into()),
            parent_id: None,
            rationale: None,
        },
    )
    .unwrap();
    let prop = db.list_class_proposals().unwrap().remove(0);
    db.apply_class_proposal(prop.id, "tester").unwrap().unwrap();

    // auth2 is gone; its link + child moved onto auth1.
    assert!(db.get_class_node("auth2").unwrap().is_none());
    assert_eq!(db.list_class_links_for_node("auth1").unwrap().len(), 2);
    assert_eq!(
        db.get_class_node("auth2child").unwrap().unwrap().parent_id.as_deref(),
        Some("auth1")
    );
}

#[test]
fn split_moves_named_links_into_new_sibling_nodes() {
    let db = Database::open_in_memory().unwrap();
    accepted_node(&db, "root-r", None, "redline");
    accepted_node(&db, "mixed", Some("root-r"), "Mixed");
    let l1 = add_link(&db, "mixed", "prompt", "1");
    let l2 = add_link(&db, "mixed", "prompt", "2");

    db.stage_proposal(
        None,
        &Proposal::Split {
            node_id: "mixed".into(),
            into: vec![
                SplitPart { title: "Clerk".into(), link_ids: vec![l1] },
                SplitPart { title: "Sessions".into(), link_ids: vec![l2] },
            ],
            rationale: None,
        },
    )
    .unwrap();
    let prop = db.list_class_proposals().unwrap().remove(0);
    db.apply_class_proposal(prop.id, "tester").unwrap().unwrap();

    let clerk = db
        .list_class_nodes()
        .unwrap()
        .into_iter()
        .find(|n| n.title == "Clerk")
        .unwrap();
    assert_eq!(clerk.parent_id.as_deref(), Some("root-r")); // sibling of `mixed`
    assert_eq!(db.list_class_links_for_node(&clerk.id).unwrap()[0].id, l1);
}

#[test]
fn staging_writes_live_rows_so_the_legacy_flip_finds_nothing() {
    let db = Database::open_in_memory().unwrap();
    accepted_node(&db, "root-r", None, "redline");
    db.stage_proposal(
        None,
        &Proposal::Create { parent_id: "root-r".into(), title: "Loop".into(), rationale: None },
    )
    .unwrap();
    db.stage_proposal(
        None,
        &Proposal::File {
            parent_id: "root-r".into(),
            sub_class: Some("Collab".into()),
            target_kind: "prompt".into(),
            target_id: "5".into(),
            note: None,
            rationale: None,
        },
    )
    .unwrap();
    // B3: nothing is `proposed`; both nodes and the link are live at once.
    assert!(db.list_class_nodes().unwrap().iter().all(|n| n.status == "accepted"));
    let collab = db
        .list_class_nodes()
        .unwrap()
        .into_iter()
        .find(|n| n.title == "Collab")
        .unwrap();
    assert_eq!(db.list_class_links_for_node(&collab.id).unwrap()[0].status, "accepted");
    // The pre-B3 flip is a no-op on a current store.
    assert!(db.accept_all_pending("classifier").unwrap().is_empty());
}

#[test]
fn lake_items_since_returns_delta_with_bodies() {
    let db = Database::open_in_memory().unwrap();
    // A prompt event (with a body) + a decision event (references a row).
    let pid = db.insert_prompt(&prompt_row("hello world", "bh1", Some("sess"))).unwrap().unwrap();
    db.append_ledger_event(&crate::ledger::LedgerAppend {
        kind: "prompt",
        author: "t",
        ts: 1,
        prompt_id: Some(pid),
        session_id: None,
        version_number: None,
        ref_kind: None,
        ref_id: None,
        payload_hash: "bh1",
    })
    .unwrap();
    append(&db, "approval", "ap1");
    let items = db.list_lake_items_since(0, 10).unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0].body.as_deref(), Some("hello world"));
    assert!(items[1].body.is_none()); // decision event has no stored body
    // since_seq filters.
    assert_eq!(db.list_lake_items_since(1, 10).unwrap().len(), 1);
}

#[test]
fn lake_items_exclude_machine_record_kinds() {
    let db = Database::open_in_memory().unwrap();
    append(&db, "approval", "d1");
    // Machine bookkeeping: body-less rows that would otherwise render to
    // the classifier under the "[decision references …]" fallback.
    for kind in ["router_verdict", "moot_turn", "work_file", "work_claim", "work_close"] {
        let ph = format!("m-{kind}");
        append(&db, kind, &ph);
    }
    let items = db.list_lake_items_since(0, 100).unwrap();
    assert_eq!(items.len(), 1, "only the human decision reaches the feed");
    assert_eq!(items[0].kind, "approval");
    // They stay on the chain — excluded from the feed, not from history.
    assert!(db.verify_ledger_chain().unwrap().ok);
}

/// Redline's own constructed prefaces never reach the classifier. Feeding
/// them in taught the taxonomy to describe Redline's instruction text
/// instead of the user's work — 5,809 preface chunks against 752 real ones.
/// `system` rows STAY: a task notification reports work the user's session
/// actually did, even though nobody typed it.
#[test]
fn classifier_delta_excludes_agent_prompts() {
    let db = Database::open_in_memory().unwrap();
    let seed = |body: &str, bh: &str, role: &str| {
        let mut row = prompt_row(body, bh, Some(bh));
        row.role = role;
        let pid = db.insert_prompt(&row).unwrap().unwrap();
        db.append_ledger_event(&crate::ledger::LedgerAppend {
            kind: "prompt",
            author: "t",
            ts: 1,
            prompt_id: Some(pid),
            session_id: None,
            version_number: None,
            ref_kind: None,
            ref_id: None,
            payload_hash: bh,
        })
        .unwrap();
        pid
    };
    seed("what did I decide about auth", "bh-user", "user");
    seed("You are the browse agent. …6KB of preface…", "bh-agent", "agent");
    seed("<task-notification>the run finished</task-notification>", "bh-sys", "system");

    let items = db.list_lake_items_since(0, 100).unwrap();
    let bodies: Vec<&str> = items.iter().filter_map(|i| i.body.as_deref()).collect();
    assert!(bodies.iter().any(|b| b.contains("what did I decide")));
    assert!(bodies.iter().any(|b| b.contains("task-notification")), "system rows stay");
    assert!(
        !bodies.iter().any(|b| b.contains("browse agent")),
        "an agent preface must never enter classification: {bodies:?}"
    );
}

/// A compacted prompt is SUMMARIZED, not empty — but compaction writes
/// `body = ''` rather than NULL, so `COALESCE(p.body, …)` silently handed
/// the classifier an empty string for all 224 compacted rows. They read as
/// content-free and were classified as such. `NULLIF(p.body, '')` is the fix.
#[test]
fn classifier_delta_resolves_a_compacted_gist() {
    let db = Database::open_in_memory().unwrap();
    let pid = db
        .insert_prompt(&prompt_row("the original cold body", "bh-cold", Some("s")))
        .unwrap()
        .unwrap();
    db.append_ledger_event(&crate::ledger::LedgerAppend {
        kind: "prompt",
        author: "t",
        ts: 1,
        prompt_id: Some(pid),
        session_id: None,
        version_number: None,
        ref_kind: None,
        ref_id: None,
        payload_hash: "bh-cold",
    })
    .unwrap();
    db.compact_prompt_body(pid, "gist: chose Yjs for collab", "cold", "agent", "keeper")
        .unwrap();

    let items = db.list_lake_items_since(0, 100).unwrap();
    let prompt_item = items.iter().find(|i| i.kind == "prompt").expect("the prompt is in the feed");
    assert_eq!(
        prompt_item.body.as_deref(),
        Some("gist: chose Yjs for collab"),
        "the gist stands in for the released body — not an empty string"
    );
}

/// A cold compaction is a guess and must be reversible; the archive is
/// derived data outside the chain, so the inflated bytes are re-hashed
/// against the recorded hash before they are trusted back into the row.
#[test]
fn archived_body_round_trips_and_verifies() {
    let db = Database::open_in_memory().unwrap();
    let body = "the original body, ".repeat(60);
    let bh = crate::ledger::body_hash(&body);
    let pid = db.insert_prompt(&prompt_row(&body, &bh, Some("s"))).unwrap().unwrap();
    db.compact_prompt_body(pid, "gist: a thing", "cold", "agent", "keeper").unwrap();
    assert_eq!(db.get_prompt_body(pid).unwrap().as_deref(), Some("gist: a thing"));
    let (rows, bytes) = db.archive_stats().unwrap();
    assert_eq!(rows, 1);
    assert!(bytes > 0 && bytes < body.len() as i64, "deflated, not stored raw");

    assert!(db.restore_prompt_body(pid).unwrap());
    assert_eq!(db.get_prompt_body(pid).unwrap().as_deref(), Some(body.as_str()));
    assert_eq!(db.archive_stats().unwrap().0, 0, "restore consumes the archive");
    assert!(!db.restore_prompt_body(pid).unwrap(), "nothing left to restore");

    // A corrupted blob is refused, never silently written back.
    db.compact_prompt_body(pid, "gist: again", "cold", "agent", "keeper").unwrap();
    {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "UPDATE prompt_archive SET blob = ?2 WHERE prompt_id = ?1",
            params![pid, polis_store::compaction::deflate_body("not the original body at all").unwrap()],
        )
        .unwrap();
    }
    assert!(db.restore_prompt_body(pid).is_err(), "hash mismatch is an error");
}

/// Forget must mean forget: no archive row survives it, and a forget over an
/// earlier cold compaction removes the copy that pass left behind.
#[test]
fn forget_leaves_no_archive_row() {
    let db = Database::open_in_memory().unwrap();
    let body = "something private, ".repeat(40);
    let bh = crate::ledger::body_hash(&body);
    let pid = db.insert_prompt(&prompt_row(&body, &bh, Some("s"))).unwrap().unwrap();

    // Direct forget → nothing archived.
    db.compact_prompt_body(pid, "[forgotten]", "forget", "deterministic", "yusuf")
        .unwrap();
    assert_eq!(db.archive_stats().unwrap().0, 0);

    // Cold first, then forget → the cold pass's archive is deleted too.
    let body2 = "also private, ".repeat(40);
    let bh2 = crate::ledger::body_hash(&body2);
    let pid2 = db.insert_prompt(&prompt_row(&body2, &bh2, Some("s2"))).unwrap().unwrap();
    db.compact_prompt_body(pid2, "gist", "cold", "agent", "keeper").unwrap();
    assert_eq!(db.archive_stats().unwrap().0, 1);
    db.restore_prompt_body(pid2).unwrap();
    db.compact_prompt_body(pid2, "[forgotten]", "forget", "deterministic", "yusuf")
        .unwrap();
    assert_eq!(
        db.archive_stats().unwrap().0,
        0,
        "a forget over a cold compaction must remove the recoverable copy"
    );
}

/// Insert a lake row AND its ledger event — the search paths join through
/// `ledger_events`, so a bare `insert_prompt` is invisible to them.
fn seed_indexed_prompt(
    db: &Database,
    body: &str,
    bh: &str,
    role: &str,
    user_text: Option<&str>,
) -> i64 {
    let mut row = prompt_row(body, bh, Some(bh));
    row.role = role;
    row.user_text = user_text;
    let pid = db.insert_prompt(&row).unwrap().unwrap();
    db.append_ledger_event(&crate::ledger::LedgerAppend {
        kind: "prompt",
        author: "tester",
        ts: 1000,
        prompt_id: Some(pid),
        session_id: None,
        version_number: None,
        ref_kind: None,
        ref_id: None,
        payload_hash: bh,
    })
    .unwrap();
    pid
}

/// THE FTS LANDMINE, defused before the caption column is ever written.
///
/// `browse_events_fts` is external-content and had only an `AFTER INSERT`
/// trigger — safe exactly as long as the table was insert-only. The vision
/// tier's `caption` is written by an UPDATE, and an external-content FTS
/// table whose content row changes without a matching `'delete'` row does
/// NOT error: it keeps offsets into text that no longer exists and
/// `snippet()` returns garbage. The delete/update pair has to exist first,
/// so it is tested first.
#[test]
fn browse_events_fts_survives_an_update() {
    let db = Database::open_in_memory().unwrap();
    crate::ledger::record_browse_event(
        &db,
        crate::ledger::BrowseEventInput {
            action: crate::ledger::BrowseAction::Navigate,
            browse_id: Some("t1".into()),
            url: "https://example.test/a".into(),
            title: Some("Original title".into()),
            text: "the original body mentions zeppelins".into(),
            from_event_id: None,
            author: None,
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(db.search_browse_events("zeppelins", 10).unwrap().len(), 1);

    // An UPDATE that rewrites the indexed text.
    {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "UPDATE browse_events SET title = ?1, text = ?2 WHERE id = 1",
            params!["Revised title", "the revised body mentions dirigibles"],
        )
        .unwrap();
    }
    assert!(
        db.search_browse_events("zeppelins", 10).unwrap().is_empty(),
        "the OLD text must leave the index, or it matches forever"
    );
    let hits = db.search_browse_events("dirigibles", 10).unwrap();
    assert_eq!(hits.len(), 1, "the NEW text must be findable");
    // …and `snippet()` must be readable rather than offsets into text that
    // no longer exists — the actual symptom of a missing delete trigger.
    assert!(
        hits[0].snippet.contains("dirigibles"),
        "snippet is garbage: {:?}",
        hits[0].snippet
    );

    // A DELETE removes it from the index too.
    {
        let conn = db.conn.lock().unwrap();
        conn.execute("DELETE FROM browse_events WHERE id = 1", []).unwrap();
    }
    assert!(db.search_browse_events("dirigibles", 10).unwrap().is_empty());
}

/// A picture of one of Redline's own surfaces reaches its Timeline row, is
/// counted as REFERENCED by the retention sweep, and carries the theme it
/// was taken under.
///
/// The referenced check is the load-bearing one: the sweep deletes anything
/// the database doesn't point at, so a surface shot missing from
/// `referenced_shot_keys` would be captured and then deleted on the next
/// pass — silently, and only visible as "the pictures never appear". That
/// is the same one-writer-erases-another's-files shape as the
/// `thumbs_prune` bug this program already had to fix once.
#[test]
fn a_surface_shot_reaches_its_row_and_survives_the_sweep() {
    let db = Database::open_in_memory().unwrap();
    let ev = append(&db, "approval", "ph-approve");
    db.record_surface_shot(ev.seq, "approval", "rl-approval-1", Some("frivolous"))
        .unwrap();

    // It reaches the Timeline row it belongs to.
    let items = crate::context::query_ledger(&db, &crate::context::LedgerFilters::default())
        .unwrap();
    let row = items.iter().find(|i| i.event.seq == ev.seq).expect("the event is listed");
    assert_eq!(row.shot_key.as_deref(), Some("rl-approval-1"));

    // The sweep can see it — otherwise it would be deleted as unreferenced.
    assert!(db.referenced_shot_keys().unwrap().contains("rl-approval-1"));
    let plan = crate::shots::plan_sweep(
        &[("rl-approval-1".to_string(), 40_000, crate::ledger::now_millis())],
        &db.referenced_shot_keys().unwrap(),
        crate::ledger::now_millis(),
        crate::shots::SHOTS_MAX_BYTES,
        crate::shots::SHOTS_MAX_AGE_DAYS,
    );
    assert!(plan.delete.is_empty(), "a referenced surface shot must survive");

    // The theme is stamped, so an old shot can be labelled rather than
    // silently looking like a rendering bug.
    let stored = db.surface_shots_for_seqs(&[ev.seq]).unwrap();
    assert_eq!(stored.get(&ev.seq).unwrap().1.as_deref(), Some("frivolous"));

    // Forgetting it removes the row, and the sweep then reclaims the file.
    assert_eq!(db.clear_surface_shot("rl-approval-1").unwrap(), 1);
    assert!(db.referenced_shot_keys().unwrap().is_empty());
}

/// A caption goes in its OWN column. `context_hash = body_hash(text)` is
/// the identity the shot key, the dedupe and the chain all rest on, so
/// folding a caption into `text` would silently re-key the page and orphan
/// its own picture.
#[test]
fn a_caption_never_re_keys_the_page_it_describes() {
    let db = Database::open_in_memory().unwrap();
    crate::ledger::record_browse_event(
        &db,
        crate::ledger::BrowseEventInput {
            action: crate::ledger::BrowseAction::Navigate,
            browse_id: Some("t1".into()),
            url: "https://dash.test/".into(),
            title: Some("Dashboard".into()),
            // A dark page: essentially no text after the title/url prefix.
            text: "Dashboard\nhttps://dash.test/\n\n".into(),
            from_event_id: None,
            author: None,
        },
    )
    .unwrap()
    .unwrap();
    let hash_before = db.context_hash_for_browse_id(1).unwrap().unwrap();
    db.set_shot_key_for_hash(&hash_before, "bs-abc123").unwrap();

    // It IS in the dark set, and captioning it takes it out.
    assert_eq!(db.pages_with_a_picture_but_no_text(10).unwrap().len(), 1);
    db.set_caption_for_hash(&hash_before, "A metrics dashboard with four charts")
        .unwrap();
    assert!(db.pages_with_a_picture_but_no_text(10).unwrap().is_empty());

    // The identity is unchanged, so the picture is still its picture.
    let hash_after = db.context_hash_for_browse_id(1).unwrap().unwrap();
    assert_eq!(hash_before, hash_after, "a caption must not re-key the page");
    assert!(db.referenced_shot_keys().unwrap().contains("bs-abc123"));

    // Forgetting the picture clears the pointer everywhere it appears.
    assert_eq!(db.clear_shot_key("bs-abc123").unwrap(), 1);
    assert!(db.referenced_shot_keys().unwrap().is_empty());
}

/// Porter earns its place by unifying inflections at no index cost — this
/// is the "compacting finds compaction" behaviour the Timeline promises.
#[test]
fn porter_stems_across_inflections() {
    let db = Database::open_in_memory().unwrap();
    seed_indexed_prompt(
        &db,
        "the keeper compaction pass released cold bodies",
        "bh-s",
        "user",
        None,
    );
    for q in ["compaction", "compacting", "compacted", "compact"] {
        assert_eq!(
            db.search_prompts_fts(q, 10).unwrap().len(),
            1,
            "{q:?} must reach the same document"
        );
    }
}

/// `tokenchars` keeps identifiers, paths and flags whole. Without it,
/// `src/db.rs` shreds into three tokens and `--allowedTools` into one bare
/// word, and neither can be searched for as itself.
#[test]
fn tokenchars_keep_identifiers_whole() {
    let db = Database::open_in_memory().unwrap();
    seed_indexed_prompt(
        &db,
        "pass --allowedTools to the spawn in src-tauri/src/db.rs for rl_del",
        "bh-t",
        "user",
        None,
    );
    for q in ["\"--allowedTools\"", "\"src-tauri/src/db.rs\"", "rl_del"] {
        assert_eq!(db.search_prompts_fts(q, 10).unwrap().len(), 1, "for {q}");
    }
}

/// Phase 1's corpus work becomes index size here: an agent row contributes
/// only the human's words, never the preface wrapped around them.
#[test]
fn fts_excludes_agent_bodies_but_keeps_user_text() {
    let db = Database::open_in_memory().unwrap();
    seed_indexed_prompt(
        &db,
        "You are the browse agent. Follow your browse skill. …preface…",
        "bh-agent",
        "agent",
        Some("does clerk charge per MAU"),
    );

    assert!(
        db.search_prompts_fts("preface", 10).unwrap().is_empty(),
        "the preface must not be searchable"
    );
    assert_eq!(
        db.search_prompts_fts("clerk", 10).unwrap().len(),
        1,
        "the question it wrapped must be"
    );
}

/// THE caveat this design retires. `'rebuild'` used to be forbidden here:
/// the triggers indexed `COALESCE(gist, body)` while rebuild re-read
/// `prompts.body` by column name — `''` for every compacted row — so
/// rebuilding silently dropped 224 gists out of the index. With the indexed
/// text as a generated column of the content table, the two paths read the
/// same expression and cannot disagree.
#[test]
fn prompts_fts_rebuild_is_now_correct() {
    let db = Database::open_in_memory().unwrap();
    seed_indexed_prompt(&db, "the warm body mentions widgets", "bh-warm", "user", None);
    let cold_id = seed_indexed_prompt(
        &db,
        "a long deliberation ending in sprockets, with the throwaway token zzyzx",
        "bh-cold",
        "user",
        None,
    );
    db.compact_prompt_body(cold_id, "gist: chose sprockets over widgets", "cold", "agent", "keeper")
        .unwrap();

    {
        let conn = db.conn.lock().unwrap();
        conn.execute("INSERT INTO prompts_fts(prompts_fts) VALUES('rebuild')", [])
            .unwrap();
    }
    assert_eq!(
        db.search_prompts_fts("widgets", 10).unwrap().len(),
        2,
        "the warm body and the cold row's gist both still match"
    );
    assert_eq!(
        db.search_prompts_fts("sprockets", 10).unwrap().len(),
        1,
        "the compacted row survives a rebuild through its gist"
    );
    assert!(
        db.search_prompts_fts("zzyzx", 10).unwrap().is_empty(),
        "and the RELEASED words stay released — a rebuild must not resurrect them"
    );
}

/// The cascade: `AND` is tried first and wins outright when it matches, so
/// a precise reading is never diluted by one-term-in-five noise.
#[test]
fn and_first_then_or_cascade() {
    let db = Database::open_in_memory().unwrap();
    for (i, body) in [
        "the browser tab suspension design",
        "browser windows generally",
        "tab bar styling",
    ]
    .iter()
    .enumerate()
    {
        seed_indexed_prompt(&db, body, &format!("bh-{i}"), "user", None);
    }

    let precise = db.search_prompts_ranked("browser tab suspension", 10).unwrap();
    assert_eq!(precise.len(), 1, "AND wins outright: {precise:?}");
    assert_eq!(precise[0].1, crate::query::MatchStage::And);

    // No document has all three, so the cascade widens — and SAYS it did.
    let widened = db.search_prompts_ranked("browser suspension zebra", 10).unwrap();
    assert!(widened.len() > 1);
    assert!(widened.iter().all(|(_, s)| *s == crate::query::MatchStage::Or));
}

/// The bug that made every natural-language question resolve `node: null`:
/// the whole raw query was one LIKE pattern.
#[test]
fn match_class_nodes_resolves_a_question() {
    let db = Database::open_in_memory().unwrap();
    db.seed_class_roots(&[
        ("n-browser".into(), "Embedded browser".into(), None),
        ("n-voice".into(), "Voice agent".into(), None),
    ])
    .unwrap();

    // Verbatim from the live probe that returned `node: null`.
    let hits = db
        .match_class_nodes("what did I decide about the browser tab suspension", 5)
        .unwrap();
    assert_eq!(
        hits.first().map(|n| n.id.as_str()),
        Some("n-browser"),
        "a question must resolve to its class: {hits:?}"
    );
    // A question about nothing in the catalog still resolves nothing —
    // widening must not invent a node.
    assert!(db
        .match_class_nodes("what did I decide about zebras", 5)
        .unwrap()
        .is_empty());
}

/// Every read of a prompt body must resolve the gist. `COALESCE(p.body, …)`
/// returns `''` for a compacted row — a silent content-free read, not an
/// error — so the invariant is pinned in source across the whole file.
#[test]
fn every_prompt_body_read_resolves_the_gist() {
    const SRC: &str = include_str!("db.rs");
    // Assembled at runtime so this test's own source doesn't match itself.
    let needle = format!("COALESCE(p.{}", "body");
    for (ix, _) in SRC.match_indices(&needle) {
        let line_end = SRC[ix..].find('\n').map(|n| ix + n).unwrap_or(SRC.len());
        let line_start = SRC[..ix].rfind('\n').map(|n| n + 1).unwrap_or(0);
        let line = &SRC[line_start..line_end];
        assert!(
            line.trim_start().starts_with("//"),
            "reading `p.body` without NULLIF returns '' for every compacted row — \
                 use PROMPT_TEXT.\n  {line}"
        );
    }
    // And the const itself says the right thing.
    assert_eq!(PROMPT_TEXT, "COALESCE(NULLIF(p.body, ''), p.gist)");
}

/// The grep arm's reason for existing: reach what tokenization cannot.
#[test]
fn grep_finds_what_fts_cannot() {
    let db = Database::open_in_memory().unwrap();
    seed_indexed_prompt(
        &db,
        "the spawn passes #[serde(rename_all = \"camelCase\")] and fails with \
             E0308: mismatched types",
        "bh-g",
        "user",
        None,
    );
    // A fragment INSIDE a token: no tokenizer can produce `rename_al`, so
    // this is unreachable through FTS by construction.
    let hits = db
        .grep_memory("rename_al", None, false, GrepScope::Prompts, 10)
        .unwrap();
    assert_eq!(hits.len(), 1, "the trigram index reaches inside a token");
    assert!(hits[0].excerpt.contains("rename_all"), "{}", hits[0].excerpt);
    assert!(hits[0].seq.is_some(), "a grep hit must be citable as #seq");

    // An error string with punctuation the tokenizer eats.
    assert_eq!(
        db.grep_memory("E0308:", None, false, GrepScope::Prompts, 10).unwrap().len(),
        1
    );
}

/// A needle shorter than a trigram cannot be answered from the index, so it
/// is refused BY NAME rather than silently becoming a full scan.
#[test]
fn grep_refuses_a_short_literal() {
    let db = Database::open_in_memory().unwrap();
    let err = db.grep_memory("ab", None, false, GrepScope::All, 10).unwrap_err();
    assert!(matches!(err, GrepError::LiteralTooShort { min: 3, got: 2 }));
    // The message has to teach the fix, not just report a failure.
    let msg = err.to_string();
    assert!(msg.contains("at least 3"), "{msg}");
    assert!(msg.contains("trigram"), "{msg}");
    // Whitespace doesn't buy length.
    assert!(db.grep_memory("  a  ", None, false, GrepScope::All, 10).is_err());
}

#[test]
fn grep_case_sensitive_post_filters() {
    let db = Database::open_in_memory().unwrap();
    seed_indexed_prompt(&db, "pass --allowedTools to the spawn", "bh-c1", "user", None);
    seed_indexed_prompt(&db, "pass --allowedtools to the spawn", "bh-c2", "user", None);
    assert_eq!(
        db.grep_memory("allowedTools", None, false, GrepScope::Prompts, 10).unwrap().len(),
        2,
        "case-insensitive is the default"
    );
    assert_eq!(
        db.grep_memory("allowedTools", None, true, GrepScope::Prompts, 10).unwrap().len(),
        1,
        "case-sensitivity post-filters rather than needing a second index"
    );
}

/// The regex is a VERIFIER over what the index returned — it narrows, never
/// widens, and a bad pattern is rejected before any query runs.
#[test]
fn grep_regex_verifies_the_indexed_candidates() {
    let db = Database::open_in_memory().unwrap();
    seed_indexed_prompt(&db, "error code E0308 in the build", "bh-r1", "user", None);
    seed_indexed_prompt(&db, "error code E0061 in the build", "bh-r2", "user", None);
    assert_eq!(
        db.grep_memory("error code", None, false, GrepScope::Prompts, 10).unwrap().len(),
        2
    );
    assert_eq!(
        db.grep_memory("error code", Some(r"E03\d\d"), false, GrepScope::Prompts, 10)
            .unwrap()
            .len(),
        1,
        "the regex filters the candidate set"
    );
    assert!(matches!(
        db.grep_memory("error code", Some("("), false, GrepScope::Prompts, 10).unwrap_err(),
        GrepError::BadRegex(_)
    ));
}

/// Run the migration against a COPY of a real database and print what it
/// did to the corpus. Not a unit test — a measuring instrument, kept in the
/// tree because "we shrank the index by 2.5 MB" is a claim about one
/// specific corpus and should be re-checkable on any other.
///
/// ```text
/// cp ~/Library/Application\ Support/com.redline.app/redline.db /tmp/real.db
/// REDLINE_REAL_DB=/tmp/real.db cargo test --lib real_db -- --ignored --nocapture
/// ```
///
/// It asserts only the invariants that must hold for ANY corpus — the chain
/// still verifies, no ledger event was appended, no body was mutated — and
/// prints the rest for a human to read.
#[test]
#[ignore = "needs REDLINE_REAL_DB pointing at a copy of a live database"]
fn real_db_migration_report() {
    let Ok(path) = std::env::var("REDLINE_REAL_DB") else {
        eprintln!("set REDLINE_REAL_DB to a COPY of a live redline.db");
        return;
    };
    let path = std::path::PathBuf::from(path);

    // Before: read with a bare connection so nothing migrates yet.
    let raw = rusqlite::Connection::open(&path).unwrap();
    let scalar = |c: &rusqlite::Connection, sql: &str| -> i64 {
        c.query_row(sql, [], |r| r.get(0)).unwrap_or(-1)
    };
    let events_before = scalar(&raw, "SELECT COUNT(*) FROM ledger_events");
    let prompts_before = scalar(&raw, "SELECT COUNT(*) FROM prompts");
    let bytes_before = scalar(
        &raw,
        "SELECT COALESCE(SUM(LENGTH(CAST(COALESCE(NULLIF(body,''),gist,'') AS BLOB))),0) FROM prompts",
    );
    let fts_before = scalar(
        &raw,
        "SELECT COALESCE(SUM(pgsize),0) FROM dbstat
             WHERE name LIKE '%_fts%' OR name LIKE '%_grep%'",
    );
    drop(raw);

    let db = Database::open(&path).unwrap();
    let conn = db.conn.lock().unwrap();
    println!("\n--- corpus composition ---");
    let mut stmt = conn
        .prepare(
            "SELECT COALESCE(role,'unclassified'), COUNT(*),
                        SUM(LENGTH(CAST(COALESCE(NULLIF(body,''),gist,'') AS BLOB)))
                 FROM prompts GROUP BY 1 ORDER BY 3 DESC",
        )
        .unwrap();
    let rows: Vec<(String, i64, i64)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    for (role, n, bytes) in &rows {
        println!(
            "  {role:<14} {n:>5} rows  {:>8.1} KB  ({:.1}%)",
            *bytes as f64 / 1024.0,
            100.0 * *bytes as f64 / bytes_before.max(1) as f64
        );
    }
    drop(stmt);

    println!("\n--- index sizes ---");
    let mut stmt = conn
        .prepare(
            "SELECT name, SUM(pgsize) FROM dbstat
                 WHERE name LIKE '%_fts%' OR name LIKE '%_grep%'
                 GROUP BY name ORDER BY 2 DESC",
        )
        .unwrap();
    let idx: Vec<(String, i64)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    for (name, bytes) in &idx {
        println!("  {name:<32} {:>8.1} KB", *bytes as f64 / 1024.0);
    }
    let fts_after: i64 = idx.iter().map(|(_, b)| *b).sum();
    println!(
        "\n  FTS total: {:.1} KB → {:.1} KB  ({:+.1} KB)",
        fts_before as f64 / 1024.0,
        fts_after as f64 / 1024.0,
        (fts_after - fts_before) as f64 / 1024.0
    );
    drop(stmt);

    // The invariants that must hold for any corpus.
    let events_after = scalar(&conn, "SELECT COUNT(*) FROM ledger_events");
    assert_eq!(
        events_after, events_before,
        "reclassification must append NOTHING to the chain"
    );
    assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM prompts"), prompts_before);
    assert_eq!(
        scalar(
            &conn,
            "SELECT COALESCE(SUM(LENGTH(CAST(COALESCE(NULLIF(body,''),gist,'') AS BLOB))),0) FROM prompts"
        ),
        bytes_before,
        "no body may be mutated by the migration"
    );
    assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM prompts WHERE role IS NULL"), 0);
    drop(conn);
    assert!(db.verify_ledger_chain().unwrap().ok, "the chain still verifies");

    // And the retrieval probes from the plan's verification section.
    println!("\n--- retrieval probes ---");
    for q in [
        "what did I decide about the browser tab suspension",
        "keeper compaction",
        "compacting",
    ] {
        let nodes = db.match_class_nodes(q, 3).unwrap();
        let pack = crate::context::build_answer_pack(&db, Some(q), None, 8);
        let bytes = serde_json::to_vec(&pack).unwrap().len();
        // Are any two surviving bodies near-duplicates of each other? This
        // is the "4 of 8 hits were the same boilerplate" check.
        let bodies: Vec<u64> = pack
            .prompt_hits
            .iter()
            .filter_map(|h| h.item.body.as_deref())
            .map(crate::dedup::simhash)
            .collect();
        let dupe_pairs = bodies
            .iter()
            .enumerate()
            .flat_map(|(i, a)| bodies[i + 1..].iter().map(move |b| (*a, *b)))
            .filter(|(a, b)| crate::dedup::near_duplicate(*a, *b))
            .count();
        println!(
            "  {q:?}\n    node: {:?}  bytes: {bytes}  promptHits: {}  browseHits: {}  \
                 notes: {}  dupePairs: {dupe_pairs}  truncated: {:?}  matchedNodes: {}",
            nodes.first().map(|n| n.title.as_str()),
            pack.prompt_hits.len(),
            pack.browse_hits.len(),
            pack.notes.len(),
            pack.truncated,
            pack.matched_nodes.len(),
        );
    }
    println!();
}

/// Session A2 of the Polis extraction: attaching the store to a database
/// the OLD migrations built (every install before A2) must be a no-op on
/// the record — zero events appended, no body mutated, no object dropped,
/// recreated or added (so no FTS rebuild), chain green — and must ADOPT the
/// two legacy version keys rather than re-run their blocks. The second
/// open must take the fast path.
///
/// ```text
/// cp ~/Library/Application\ Support/com.redline.app/backups/<newest>.db /tmp/real.db
/// REDLINE_REAL_DB=/tmp/real.db cargo test --lib real_db_attach -- --ignored --nocapture
/// ```
#[test]
#[ignore = "needs REDLINE_REAL_DB pointing at a copy of a live database"]
fn real_db_attach_is_a_noop() {
    let Ok(path) = std::env::var("REDLINE_REAL_DB") else {
        eprintln!("set REDLINE_REAL_DB to a COPY of a live redline.db");
        return;
    };
    let path = std::path::PathBuf::from(path);
    let scalar = |c: &rusqlite::Connection, sql: &str| -> i64 {
        c.query_row(sql, [], |r| r.get(0)).unwrap_or(-1)
    };
    let text = |c: &rusqlite::Connection, sql: &str| -> String {
        c.query_row(sql, [], |r| r.get(0)).unwrap_or_default()
    };
    // Every schema object except the store's own meta table: (type, name,
    // rootpage) in creation order. A rebuilt FTS table, a dropped index or
    // a newly created object all change this list.
    let objects = |c: &rusqlite::Connection| -> Vec<(String, String, i64)> {
        let mut stmt = c
            .prepare(
                "SELECT type, name, rootpage FROM sqlite_master
                     WHERE name NOT LIKE '%polis_meta%' ORDER BY rowid",
            )
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    };

    let raw = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        scalar(&raw, "SELECT COUNT(*) FROM sqlite_master WHERE name = 'polis_meta'"),
        0,
        "the copy must be one the store has never attached to"
    );
    let events_before = scalar(&raw, "SELECT COALESCE(MAX(seq), 0) FROM ledger_events");
    let prompts_before = scalar(&raw, "SELECT COUNT(*) FROM prompts");
    let bytes_before = scalar(
        &raw,
        "SELECT COALESCE(SUM(LENGTH(body)), 0) + COALESCE(SUM(LENGTH(gist)), 0) FROM prompts",
    );
    let head_before = text(&raw, "SELECT entry_hash FROM ledger_events ORDER BY seq DESC LIMIT 1");
    let legacy_lexical =
        text(&raw, "SELECT value FROM app_settings WHERE key = 'redline.memory.lexicalVersion'");
    let legacy_role = text(
        &raw,
        "SELECT value FROM app_settings WHERE key = 'redline.memory.corpusRoleVersion'",
    );
    let objects_before = objects(&raw);
    drop(raw);

    let db = Database::open(&path).unwrap();
    let report = db.last_attach().clone();
    assert!(report.adopted_keys >= 2, "both legacy version keys adopted (plus any memory settings the host had): {}", report.adopted_keys);
    assert!(report.migrated, "the first attach runs the idempotent block once");
    assert_eq!(db.meta("lexical_version").unwrap().as_deref(), Some(legacy_lexical.as_str()));
    assert_eq!(db.meta("corpus_role_version").unwrap().as_deref(), Some(legacy_role.as_str()));
    // The store's own version, not a literal: a store schema bump (B1's
    // class_runs columns took it 1 → 2) is a real migration the first
    // attach runs once — still zero events, still the same bodies.
    assert_eq!(db.meta("schema_version").unwrap().as_deref(), Some(polis_store::meta::STORE_SCHEMA_VERSION));
    {
        let conn = db.conn.lock().unwrap();
        assert_eq!(
            scalar(&conn, "SELECT COALESCE(MAX(seq), 0) FROM ledger_events"),
            events_before,
            "zero events appended"
        );
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM prompts"), prompts_before);
        assert_eq!(
            scalar(
                &conn,
                "SELECT COALESCE(SUM(LENGTH(body)), 0) + COALESCE(SUM(LENGTH(gist)), 0) FROM prompts"
            ),
            bytes_before,
            "no body or gist changed"
        );
        assert_eq!(
            text(&conn, "SELECT entry_hash FROM ledger_events ORDER BY seq DESC LIMIT 1"),
            head_before
        );
        let after = objects(&conn);
        let missing: Vec<_> = objects_before.iter().filter(|o| !after.contains(o)).collect();
        let added: Vec<_> = after.iter().filter(|o| !objects_before.contains(o)).collect();
        assert!(
            missing.is_empty(),
            "schema objects dropped or rebuilt on attach: {missing:?}"
        );
        // A store schema bump (`polis_store::meta::STORE_SCHEMA_VERSION`) may
        // CREATE objects on first attach — that is the one legitimate
        // "added". The allowance names exactly what each bump introduced,
        // by the version that introduced it, so an unexpected object (a
        // rebuilt FTS table, a stray index) still fails. Columns added by
        // ALTER do not appear here: the list reads type/name/rootpage.
        // 3 (B2): the `class_run_ops` journal (+ its PK autoindex) and the
        // two retire-mark indexes. (The store exposes no list of its own
        // objects yet; when it does, read it from there.)
        const STORE_BUMP_OBJECTS: &[&str] = &[
            // B2
            "class_run_ops",
            "sqlite_autoindex_class_run_ops_1",
            "idx_class_nodes_retired",
            "idx_class_links_retired",
            // E2 (identity): the two tables, their PK autoindexes, the
            // parent index, the scope index per scoped table, and — since
            // the store's f8d5066 fix (its first CREATE named `rowid`,
            // which SQLite refuses; a silent no-op this very check
            // exposed) — the partial `idx_<table>_unscoped` index per
            // scoped table.
            "principals",
            "sqlite_autoindex_principals_1",
            "principal_aliases",
            "sqlite_autoindex_principal_aliases_1",
            "idx_principals_parent",
            "idx_prompts_scope",
            "idx_browse_events_scope",
            "idx_user_notes_scope",
            "idx_class_nodes_scope",
            "idx_class_observations_scope",
            "idx_prompts_unscoped",
            "idx_browse_events_unscoped",
            "idx_user_notes_unscoped",
            "idx_class_nodes_unscoped",
            "idx_class_observations_unscoped",
            // B3 (autonomy): the proposal work queue's index.
            "idx_class_proposals_next",
            // C1 (centroid-first filing).
            "class_centroids",
            "sqlite_autoindex_class_centroids_1",
            // E3 (sharing core): the foreign tables, their PK autoindexes,
            // the chain index, the FTS table with its shadow tables and
            // triggers.
            "foreign_chains",
            "sqlite_autoindex_foreign_chains_1",
            "foreign_principals",
            "sqlite_autoindex_foreign_principals_1",
            "foreign_events",
            "sqlite_autoindex_foreign_events_1",
            "foreign_prompts",
            "sqlite_autoindex_foreign_prompts_1",
            "foreign_notes",
            "sqlite_autoindex_foreign_notes_1",
            "foreign_redactions",
            "sqlite_autoindex_foreign_redactions_1",
            "foreign_acks",
            "sqlite_autoindex_foreign_acks_1",
            "foreign_trust",
            "sqlite_autoindex_foreign_trust_1",
            "foreign_subscriptions",
            "idx_foreign_prompts_chain",
            "foreign_prompts_fts",
            "foreign_prompts_fts_data",
            "foreign_prompts_fts_idx",
            "foreign_prompts_fts_docsize",
            "foreign_prompts_fts_config",
            "foreign_prompts_fts_ai",
            "foreign_prompts_fts_ad",
            "foreign_prompts_fts_au",
            // E4 (the org node): the firm's catalog as a peer sees it, and
            // the relay's per-peer acknowledgements.
            "foreign_class_nodes",
            "sqlite_autoindex_foreign_class_nodes_1",
            "foreign_class_links",
            "sqlite_autoindex_foreign_class_links_1",
            "org_acks",
            "sqlite_autoindex_org_acks_1",
        ];
        let unexpected: Vec<_> = added
            .iter()
            .filter(|(_, name, _)| !STORE_BUMP_OBJECTS.contains(&name.as_str()))
            .collect();
        assert!(
            unexpected.is_empty(),
            "schema objects added on attach beyond the store's own bump: {unexpected:?} \
                 (allowed: {STORE_BUMP_OBJECTS:?}; store schema version {})",
            polis_store::meta::STORE_SCHEMA_VERSION
        );
    }
    assert!(db.verify_ledger_chain().unwrap().ok, "the chain still verifies");
    drop(db);

    let again = Database::open(&path).unwrap();
    assert!(!again.last_attach().migrated, "a current store runs no schema SQL on reopen");
    assert_eq!(again.last_attach().adopted_keys, 0);
    eprintln!(
        "real_db_attach_is_a_noop: events={events_before} prompts={prompts_before} \
             bytes={bytes_before} objects={} lexical={legacy_lexical} role={legacy_role}",
        objects_before.len()
    );
}

/// The one-time reclassification runs over rows captured before the column
/// was filled, leaves them byte-intact, and appends nothing to the chain.
#[test]
fn corpus_role_backfill_reclassifies_without_touching_the_chain() {
    let db = Database::open_in_memory().unwrap();
    let seed = |body: &str, bh: &str, source: &str| {
        let mut row = prompt_row(body, bh, Some(bh));
        row.source = source;
        db.insert_prompt(&row).unwrap().unwrap()
    };
    let user = seed("add auth to the app", "bh-a", "hook");
    let sys = seed("<task-notification>done</task-notification>", "bh-b", "hook");
    let agent = seed("first-turn preface", "bh-c", "rust_firstturn");
    let leaked = seed(&format!("You are the browse agent. {}", "x".repeat(2100)), "bh-d", "hook");
    append(&db, "approval", "keep-me");
    let events_before = db.max_ledger_seq().unwrap();

    {
        // Simulate an upgrade: clear the roles and the version key, then
        // re-run the migration.
        let conn = db.conn.lock().unwrap();
        conn.execute("UPDATE prompts SET role = NULL", []).unwrap();
        conn.execute(
            "DELETE FROM polis_meta WHERE key = ?1",
            params![polis_store::meta::CORPUS_ROLE_VERSION_KEY],
        )
        .unwrap();
    }
    // Run the STEP, not the runner. `attach` is a no-op on an
    // already-current store — that is the whole point of the version
    // stamp — so re-opening would test the fast path, not the backfill
    // this case is about. `run_migrations` is the step, unconditionally.
    db.run_migrations().unwrap();

    let role_of = |id: i64| -> String {
        let conn = db.conn.lock().unwrap();
        conn.query_row("SELECT role FROM prompts WHERE id = ?1", params![id], |r| r.get(0))
            .unwrap()
    };
    assert_eq!(role_of(user), "user");
    assert_eq!(role_of(sys), "system");
    assert_eq!(role_of(agent), "agent");
    assert_eq!(role_of(leaked), "agent", "the leaked captures are recognized by shape");

    // Reclassify, don't compact: bodies intact, zero new chain events.
    assert_eq!(db.get_prompt_body(user).unwrap().as_deref(), Some("add auth to the app"));
    assert_eq!(db.max_ledger_seq().unwrap(), events_before, "no events appended");
    assert!(db.verify_ledger_chain().unwrap().ok);

    // Composition is reportable — the number nobody could see.
    let comp = db.corpus_composition().unwrap();
    let rows_for = |r: &str| comp.iter().find(|(k, _, _)| k == r).map(|(_, n, _)| *n).unwrap_or(0);
    assert_eq!(rows_for("user"), 1);
    assert_eq!(rows_for("agent"), 2);
    assert_eq!(rows_for("system"), 1);
}

#[test]
fn ledger_tamper_is_detected_at_first_bad_seq() {
    let db = Database::open_in_memory().unwrap();
    append(&db, "prompt", "h1");
    append(&db, "approval", "h2");
    append(&db, "revision", "h3");
    // Mutate a hashed field on seq 2 directly, as a tamperer would.
    {
        let conn = db.conn.lock().unwrap();
        conn.execute("UPDATE ledger_events SET author = 'mallory' WHERE seq = 2", [])
            .unwrap();
    }
    let v = db.verify_ledger_chain().unwrap();
    assert!(!v.ok);
    assert_eq!(v.first_bad_seq, Some(2));
    assert_eq!(v.checked, 1, "verification stops at the first bad seq");
}

#[test]
fn prompt_insert_dedups_on_body_and_session() {
    let db = Database::open_in_memory().unwrap();
    // Same body + same claude session → deduped.
    assert!(db.insert_prompt(&prompt_row("hi", "bh1", Some("cs1"))).unwrap().is_some());
    assert!(db.insert_prompt(&prompt_row("hi", "bh1", Some("cs1"))).unwrap().is_none());
    // Same body, different session → distinct.
    assert!(db.insert_prompt(&prompt_row("hi", "bh1", Some("cs2"))).unwrap().is_some());
    // NULL sessions are treated as distinct (multiple allowed).
    assert!(db.insert_prompt(&prompt_row("hi", "bh1", None)).unwrap().is_some());
    assert!(db.insert_prompt(&prompt_row("hi", "bh1", None)).unwrap().is_some());
}

#[test]
fn revision_and_decision_events_are_idempotent() {
    let db = Database::open_in_memory().unwrap();
    assert!(crate::ledger::record_revision_event(&db, "s1", 1, "plan body", None).unwrap().is_some());
    // Same (session, version, payload) → skipped.
    assert!(crate::ledger::record_revision_event(&db, "s1", 1, "plan body", None).unwrap().is_none());
    // Changed body at same version → recorded.
    assert!(crate::ledger::record_revision_event(&db, "s1", 1, "edited", None).unwrap().is_some());

    let dec = |ph: &str| crate::ledger::DecisionInput {
        kind: crate::ledger::EventKind::Approval,
        author: Some("me".to_string()),
        session_id: Some("s1"),
        ref_kind: "session",
        ref_id: "s1",
        payload_hash: ph.to_string(),
    };
    assert!(crate::ledger::record_decision(&db, dec("p")).unwrap().is_some());
    assert!(crate::ledger::record_decision(&db, dec("p")).unwrap().is_none());
    assert!(db.verify_ledger_chain().unwrap().ok);
}

#[test]
fn snapshot_round_trips_and_verifies() {
    let dir = std::env::temp_dir().join(format!("redline-ledger-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let src = dir.join("live.db");
    {
        let db = Database::open(&src).unwrap();
        append(&db, "prompt", "h1");
        append(&db, "approval", "h2");
        let dest = dir.join("snap.db");
        db.snapshot_to(&dest).unwrap();
        // Reopen the snapshot independently → chain still verifies green.
        let snap = Database::open(&dest).unwrap();
        let v = snap.verify_ledger_chain().unwrap();
        assert!(v.ok);
        assert_eq!(v.checked, 2);
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// The beach-ball fix: a backup must complete while ANOTHER thread holds
/// the shared connection's lock — a sync command waiting on that lock is a
/// frozen main thread. Runs the vacuum with the lock held for its whole
/// length, then proves the copy carries the chain (read-only reopen, as
/// the keeper's deep walk does).
#[test]
fn snapshot_off_lock_runs_while_the_shared_lock_is_held() {
    let dir = std::env::temp_dir().join(format!("redline-offlock-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let src = dir.join("live.db");
    {
        let db = Database::open(&src).unwrap();
        append(&db, "prompt", "h1");
        append(&db, "approval", "h2");
        assert_eq!(
            db.file_path().map(|p| p.canonicalize().unwrap()),
            Some(src.canonicalize().unwrap())
        );
        let dest = dir.join("backups").join("snap.db");
        let held = db.lock_conn();
        let (tx, rx) = std::sync::mpsc::channel();
        let (s2, d2) = (src.clone(), dest.clone());
        std::thread::spawn(move || tx.send(Database::snapshot_file(&s2, &d2)).unwrap());
        let r = rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("the off-lock vacuum must not wait on the shared connection");
        drop(held);
        r.unwrap();
        let copy = polis_store::PolisStore::open_read_only(&dest).unwrap();
        let v = copy.verify_ledger_chain().unwrap();
        assert!(v.ok);
        assert_eq!(v.checked, 2);
        // The public entry point agrees (and an in-memory db falls back).
        let dest2 = dir.join("snap2.db");
        db.snapshot_off_lock(&dest2).unwrap();
        assert!(dest2.exists());
        let mem = Database::open_in_memory().unwrap();
        assert!(mem.file_path().is_none());
        mem.snapshot_off_lock(&dir.join("mem.db")).unwrap();
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// A fresh WAL database file in its own directory, removed on drop.
struct FileDb(std::path::PathBuf, Option<Arc<Database>>);
impl FileDb {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("redline-readers-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Database::open(&dir.join("live.db")).unwrap();
        assert!(db.readers.is_some(), "a WAL file reads on its own connections");
        Self(dir, Some(Arc::new(db)))
    }
    fn db(&self) -> Arc<Database> {
        self.1.clone().unwrap()
    }
}
impl Drop for FileDb {
    fn drop(&mut self) {
        self.1.take();
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The point of the readers: a poll's read finishes while another thread
/// holds the writer for as long as it likes. Before them, every sync
/// command reading a setting or a session list waited out a canary, an
/// embedding tick or a keeper pass on the shared lock.
#[test]
fn reads_finish_while_the_writer_is_held() {
    let file = FileDb::new();
    let db = file.db();
    let store = SessionStore::new(db.clone());
    store.upsert_plan("s", "/tmp/s", "# Plan\n\nBody.\n".into(), Vec::new(), true, false);
    db.set_setting("redline.ui.theme", "aurora").unwrap();
    let held = db.lock_conn();
    let (tx, rx) = std::sync::mpsc::channel();
    let reader = db.clone();
    std::thread::spawn(move || {
        let read = (reader.get_setting("redline.ui.theme"), reader.load_all().map(|all| all.len()));
        tx.send(read).unwrap();
    });
    let (theme, sessions) = rx
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("a read must not wait on the writer's lock");
    drop(held);
    assert_eq!(theme.as_deref(), Some("aurora"));
    assert_eq!(sessions.unwrap(), 1);
}

/// Read-your-writes, the contract the single lock gave for free: a read
/// that starts after a write returned sees it — on the same thread, and on
/// another thread told about the write — even on a reader that was open
/// before the write.
#[test]
fn a_read_sees_every_write_that_returned() {
    let file = FileDb::new();
    let db = file.db();
    // Open every reader first, so each one predates the writes below.
    let warm: Vec<_> = (0..READERS).map(|_| db.read_conn()).collect();
    drop(warm);
    for n in 0..20 {
        db.set_setting("n", &n.to_string()).unwrap();
        assert_eq!(db.get_setting("n"), Some(n.to_string()));
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let writer = db.clone();
    let writes = std::thread::spawn(move || {
        for n in 20..200 {
            writer.set_setting("n", &n.to_string()).unwrap();
            tx.send(n).unwrap();
        }
    });
    for written in rx {
        let seen: i64 = db.get_setting("n").unwrap().parse().unwrap();
        assert!(seen >= written, "read {seen} after write {written} returned");
    }
    writes.join().unwrap();
}

/// One read is one snapshot (a read of several statements can't see a
/// write land between them, as it couldn't holding the writer's lock),
/// and releasing it is what lets the next read see that write.
#[test]
fn one_read_is_one_snapshot_and_the_next_is_fresh() {
    let file = FileDb::new();
    let db = file.db();
    db.set_setting("k", "1").unwrap();
    let value = |conn: &Connection| -> String {
        conn.query_row("SELECT value FROM app_settings WHERE key = 'k'", [], |r| r.get(0)).unwrap()
    };
    let read = db.read_conn();
    assert_eq!(value(&read), "1");
    db.set_setting("k", "2").unwrap();
    assert_eq!(value(&read), "1", "a write never lands in the middle of a read");
    drop(read);
    assert_eq!(db.get_setting("k").as_deref(), Some("2"));
}

/// A write of several statements is one transaction, so a reader sees all
/// of it or none of it. Stopped at its last statement (a TEMP trigger on
/// the writer), a session delete leaves everything in place; statement by
/// statement, a reader found the session's thread, comments and
/// revisions gone under a session row that was still there.
#[test]
fn a_reader_never_sees_a_half_applied_delete_session() {
    let file = FileDb::new();
    let db = file.db();
    let store = crate::state::SessionStore::new(db.clone());
    let md = "# T\n\nBody.\n";
    store.upsert_plan("s", "/tmp/s", md.to_string(), reparse_sections(md), true, false);
    let comment = store
        .add_comment(
            "s",
            NewCommentRequest {
                id: None,
                kind: CommentKind::Question,
                scope: None,
                anchor_id: "A".to_string(),
                block_id: None,
                structural: None,
                body: "why?".to_string(),
                edit: None,
                selection: None,
                author: None,
                reviewer: None,
                external_created_at: None,
                share_request_id: None,
                attachments: Vec::new(),
                research: None,
            },
        )
        .unwrap();
    db.insert_thread_message(&ThreadMessage {
        id: "m1".into(),
        session_id: "s".into(),
        comment_id: comment.id.clone(),
        role: "assistant".into(),
        body: "because".into(),
        status: "complete".into(),
        created_at: 1,
        attachments: Vec::new(),
        mode: None,
    })
    .unwrap();
    let rows = |db: &Database| -> Vec<i64> {
        let read = db.read_conn();
        ["sessions", "revisions", "comments", "thread_messages"]
            .iter()
            .map(|table| {
                read.query_row(&format!("SELECT COUNT(*) FROM {table} WHERE session_id = 's'"), [], |r| r.get(0))
                    .unwrap()
            })
            .collect()
    };
    assert_eq!(rows(&db), [1, 1, 1, 1]);

    db.lock_conn()
        .execute_batch("CREATE TEMP TRIGGER hold_last BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'held'); END")
        .unwrap();
    assert!(db.delete_session("s").is_err());
    assert_eq!(rows(&db), [1, 1, 1, 1], "a failed delete deletes nothing");

    db.lock_conn().execute_batch("DROP TRIGGER temp.hold_last").unwrap();
    db.delete_session("s").unwrap();
    assert_eq!(rows(&db), [0, 0, 0, 0]);
}

/// A write routed through `read_conn` fails on either kind of database,
/// so a read path that starts writing is caught by its own tests — and a
/// read on the writer (in-memory, no readers) hands it back writable.
#[test]
fn a_read_connection_refuses_writes_and_leaves_the_writer_writable() {
    let file = FileDb::new();
    let memory = Arc::new(Database::open_in_memory().unwrap());
    assert!(memory.readers.is_none(), "an in-memory database reads on the writer");
    for db in [file.db(), memory] {
        let attempt = db
            .read_conn()
            .execute("INSERT INTO app_settings (key, value) VALUES ('x', 'y')", []);
        assert!(attempt.is_err(), "a read connection must refuse a write");
        assert_eq!(db.get_setting("x"), None);
        db.set_setting("x", "y").unwrap();
        assert_eq!(db.get_setting("x").as_deref(), Some("y"));
    }
}

/// The routed read paths run on a reader, inside its snapshot, as they do
/// on the writer: one of each family, against real rows.
#[test]
fn routed_reads_work_on_the_readers() {
    let file = FileDb::new();
    let db = file.db();
    let store = SessionStore::new(db.clone());
    store.upsert_plan("s", "/tmp/s", "# Plan\n\nBody.\n".into(), Vec::new(), true, false);
    store.upsert_plan("s", "/tmp/s", "# Plan\n\nBody, again.\n".into(), Vec::new(), false, false);
    let reloaded = db.load_session("s").unwrap().expect("session");
    assert_eq!(reloaded.revisions.len(), 2);
    assert_eq!(db.revision_markdown("s", 2).unwrap().as_deref(), Some("# Plan\n\nBody, again.\n"));
    assert!(db.list_drafts().unwrap().is_empty());
    assert!(db.list_companions().unwrap().is_empty());
    assert!(db.list_missions().unwrap().is_empty());
    assert!(db.list_orchestrations().unwrap().is_empty());
    assert!(db.runner_list().unwrap().is_empty());
    assert!(db.friction_summary(i64::MAX).is_ok());
    assert!(db.seat_activity(0).iter().all(|seat| seat.turns_total >= seat.turns_window));
}

#[test]
fn code_review_session_and_annotations_round_trip() {
    let db = Database::open_in_memory().unwrap();

    let r = CodeReviewSession {
        review_id: "rev-1".to_string(),
        repo_path: "/proj".to_string(),
        source: "uncommitted".to_string(),
        base_ref: None,
        commit_sha: None,
        terminal_id: Some("term-1".to_string()),
        round: 1,
        created_at: 100,
    };
    db.upsert_code_review(&r).unwrap();
    assert_eq!(db.get_code_review("rev-1").unwrap().repo_path, "/proj");
    assert_eq!(db.list_code_reviews().unwrap().len(), 1);

    // Re-running in the same repo finds THIS review (round continuity),
    // and the round bump persists through the same upsert path.
    let newer = CodeReviewSession {
        round: 2,
        ..r.clone()
    };
    db.upsert_code_review(&newer).unwrap();
    let latest = db.latest_code_review_for_repo("/proj").unwrap();
    assert_eq!(latest.review_id, "rev-1");
    assert_eq!(latest.round, 2);
    assert!(db.latest_code_review_for_repo("/other").is_none());

    let a = ReviewAnnotation {
        id: "rc-001".to_string(),
        review_id: "rev-1".to_string(),
        round: 1,
        file_path: "src/main.rs".to_string(),
        side: "new".to_string(),
        start_line: 42,
        end_line: 45,
        kind: "suggestion".to_string(),
        body: "tighten this".to_string(),
        suggestion_replacement: Some("let x = y?;".to_string()),
        quoted_text: "let x = y.unwrap();".to_string(),
        status: "draft".to_string(),
        resolution: None,
        created_at: 100,
        scope: "line".to_string(),
        label: Some("nitpick".to_string()),
        blocking: Some("non-blocking".to_string()),
        source: "user".to_string(),
    };
    db.insert_review_annotation(&a).unwrap();
    let listed = db.list_review_annotations("rev-1").unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].suggestion_replacement.as_deref(), Some("let x = y?;"));
    assert_eq!(listed[0].quoted_text, "let x = y.unwrap();");

    // The carry-forward pass re-homes round/lines/status via update.
    let carried = ReviewAnnotation {
        round: 2,
        start_line: 50,
        end_line: 53,
        status: "carried".to_string(),
        resolution: Some("Applied the ? operator".to_string()),
        ..a.clone()
    };
    db.update_review_annotation(&carried).unwrap();
    let after = db.list_review_annotations("rev-1").unwrap();
    assert_eq!(after[0].round, 2);
    assert_eq!(after[0].start_line, 50);
    assert_eq!(after[0].status, "carried");
    assert_eq!(after[0].resolution.as_deref(), Some("Applied the ? operator"));

    // Per-file viewed tracking: mark, re-mark (upsert), unmark.
    db.mark_review_viewed("rev-1", "src/main.rs", 100).unwrap();
    db.mark_review_viewed("rev-1", "src/main.rs", 200).unwrap();
    db.mark_review_viewed("rev-1", "src/lib.rs", 100).unwrap();
    assert_eq!(
        db.list_review_viewed("rev-1").unwrap(),
        vec!["src/lib.rs".to_string(), "src/main.rs".to_string()]
    );
    db.unmark_review_viewed("rev-1", "src/lib.rs").unwrap();
    assert_eq!(db.list_review_viewed("rev-1").unwrap().len(), 1);

    // Deleting an annotation removes it.
    db.delete_review_annotation("rev-1", "rc-001").unwrap();
    assert!(db.list_review_annotations("rev-1").unwrap().is_empty());
}

#[test]
fn mission_round_trips_with_findings_thread_and_session() {
    use crate::state::{Mission, MissionFinding, MissionMessage};
    let db = Database::open_in_memory().unwrap();

    let m = Mission {
        mission_id: "m1".to_string(),
        title: "Data-breach page".to_string(),
        goal: "Draft my firm's data-breach practice page".to_string(),
        status: "active".to_string(),
        created_at: 100,
        updated_at: 100,
    };
    db.insert_mission(&m).unwrap();
    assert_eq!(db.get_mission("m1").unwrap().unwrap().goal, m.goal);
    assert_eq!(db.list_missions().unwrap().len(), 1);

    // Resumable session id lives on the row.
    assert!(db.get_mission_session("m1").is_none());
    db.set_mission_session("m1", "sess-abc").unwrap();
    assert_eq!(db.get_mission_session("m1").as_deref(), Some("sess-abc"));

    // Editing the goal bumps updated_at.
    db.update_mission_goal("m1", "Breach page", "new goal", 200).unwrap();
    let edited = db.get_mission("m1").unwrap().unwrap();
    assert_eq!(edited.goal, "new goal");
    assert_eq!(edited.updated_at, 200);

    // Tab workspace round-trips as an opaque JSON blob (and does not bump
    // updated_at).
    assert!(db.get_mission_tabs("m1").is_none());
    db.set_mission_tabs("m1", r#"[{"id":"t0","url":"https://a","browseId":"b1"}]"#)
        .unwrap();
    assert!(db.get_mission_tabs("m1").unwrap().contains("b1"));
    assert_eq!(db.get_mission("m1").unwrap().unwrap().updated_at, 200);

    // Pins: insert, list (oldest first), delete.
    let f1 = MissionFinding {
        id: "f1".to_string(),
        mission_id: "m1".to_string(),
        browse_id: Some("b1".to_string()),
        source_url: Some("https://acme.example".to_string()),
        source_title: Some("Acme".to_string()),
        body: "great tone".to_string(),
        note: Some("liked this".to_string()),
        created_at: 110,
    };
    let f2 = MissionFinding {
        id: "f2".to_string(),
        created_at: 120,
        ..f1.clone()
    };
    db.insert_finding(&f1).unwrap();
    db.insert_finding(&f2).unwrap();
    let pins = db.list_findings("m1").unwrap();
    assert_eq!(pins.len(), 2);
    assert_eq!(pins[0].id, "f1");
    db.delete_finding("f1").unwrap();
    assert_eq!(db.list_findings("m1").unwrap().len(), 1);

    // Orchestrator chat turns round-trip oldest-first.
    db.insert_mission_message(&MissionMessage {
        id: "msg1".to_string(),
        mission_id: "m1".to_string(),
        role: "user".to_string(),
        body: "compare the tabs".to_string(),
        status: "complete".to_string(),
        created_at: 130,
    })
    .unwrap();
    let thread = db.load_mission_thread("m1").unwrap();
    assert_eq!(thread.len(), 1);
    assert_eq!(thread[0].role, "user");

    // Delete cascades: mission row + its pins + its chat all go.
    db.delete_mission("m1").unwrap();
    assert!(db.get_mission("m1").unwrap().is_none());
    assert_eq!(db.list_missions().unwrap().len(), 0);
    assert_eq!(db.list_findings("m1").unwrap().len(), 0);
    assert_eq!(db.load_mission_thread("m1").unwrap().len(), 0);
}

#[test]
fn restore_flag_is_one_shot_and_persists() {
    let db = Arc::new(Database::open_in_memory().unwrap());
    let store = SessionStore::new(db.clone());
    let md = "# Plan\n\nBody.\n";

    // Nothing to restore before any plan exists.
    assert!(store.restore_latest("s").is_none());

    // v1: a genuine plan.
    store.upsert_plan("s", "/tmp/s", md.to_string(), reparse_sections(md), true, false);

    // Arm a restore: one-shot — the second take observes nothing.
    store.arm_restore("s");
    assert!(store.take_restore("s"));
    assert!(!store.take_restore("s"));

    // The restore re-presents the plan the store already holds (cloned —
    // no body resupplied), tagged restored.
    let res = store.restore_latest("s").expect("restored");
    assert_eq!(res.version_number, 2);
    assert!(!res.is_new_session);

    let session = store.get("s").expect("session");
    assert_eq!(session.revisions.len(), 2);
    assert!(!session.revisions[0].restored);
    assert!(session.revisions[1].restored);
    // The clone is byte-for-byte the held latest revision.
    assert_eq!(
        session.revisions[1].raw_plan_markdown,
        session.revisions[0].raw_plan_markdown
    );

    // The restored flag survives a reload from the DB.
    let reloaded = SessionStore::new(db);
    let rs = reloaded.get("s").expect("reloaded session");
    assert!(!rs.revisions[0].restored);
    assert!(rs.revisions[1].restored);
}

#[test]
fn attach_state_persists_and_flips_on_reload() {
    let db = Arc::new(Database::open_in_memory().unwrap());
    let store = SessionStore::new(db.clone());
    let md = "# Plan\n\nBody.\n";
    for sid in ["held-s", "idle-s", "det-s"] {
        store.upsert_plan(sid, "/tmp/p", md.to_string(), reparse_sections(md), true, false);
    }
    store.set_attach_state("held-s", AttachState::Held);
    store.set_attach_state("det-s", AttachState::Detached);
    assert_eq!(store.get("held-s").unwrap().attach_state, AttachState::Held);
    assert_eq!(store.get("idle-s").unwrap().attach_state, AttachState::Idle);

    // Restart: a held POST can't survive, so Held must load as Detached —
    // in memory and on disk; the other states reload unchanged.
    let reloaded = SessionStore::new(db.clone());
    assert_eq!(
        reloaded.get("held-s").unwrap().attach_state,
        AttachState::Detached,
        "held must flip to detached across a restart"
    );
    assert_eq!(reloaded.get("idle-s").unwrap().attach_state, AttachState::Idle);
    assert_eq!(reloaded.get("det-s").unwrap().attach_state, AttachState::Detached);

    // The flip itself was persisted, not just computed in memory.
    let row: String = db
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT attach_state FROM sessions WHERE session_id = 'held-s'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(row, "detached");
}

#[test]
fn add_comment_honors_explicit_id_without_perturbing_sequence() {
    use crate::state::CommentKind;
    let db = Arc::new(Database::open_in_memory().unwrap());
    let store = SessionStore::new(db);
    let md = "# Plan\n\nBody.\n";
    store.upsert_plan("s", "/tmp/s", md.to_string(), reparse_sections(md), true, false);
    let req = |id: Option<&str>| NewCommentRequest {
        id: id.map(|s| s.to_string()),
        kind: CommentKind::Feedback,
        scope: None,
        anchor_id: "A".to_string(),
        block_id: None,
        structural: None,
        body: "b".to_string(),
        edit: None,
        selection: None,
        author: None,
        reviewer: None,
        external_created_at: None,
        share_request_id: None,
        attachments: Vec::new(),
        research: None,
    };
    // Normal mint starts the c-NNN sequence.
    let a = store.add_comment("s", req(None)).unwrap();
    assert_eq!(a.id, "c-001");
    // A collaborator-minted id (never plain c-NNN) is honored verbatim…
    let b = store.add_comment("s", req(Some("c-1187249-42"))).unwrap();
    assert_eq!(b.id, "c-1187249-42");
    // …and does not perturb the owner's sequence.
    let c = store.add_comment("s", req(None)).unwrap();
    assert_eq!(c.id, "c-002");
    // Re-delivering an existing id is idempotent: the existing comment
    // comes back untouched, nothing new is minted.
    let d = store.add_comment("s", req(Some("c-001"))).unwrap();
    assert_eq!(d.id, "c-001");
    assert_eq!(d.created_at, a.created_at);
    let all = store.get("s").unwrap().revisions.last().unwrap().comments.len();
    assert_eq!(all, 3);
    // Empty string is treated as absent.
    let e = store.add_comment("s", req(Some(""))).unwrap();
    assert_eq!(e.id, "c-003");
}

#[test]
fn restored_revision_carries_open_comments_forward() {
    use crate::state::{CommentKind, CommentStatus};
    let db = Arc::new(Database::open_in_memory().unwrap());
    let store = SessionStore::new(db.clone());
    let md = "# Plan\n\nBody.\n";
    store.upsert_plan("s", "/tmp/s", md.to_string(), reparse_sections(md), true, false);
    let comment = |body: &str| NewCommentRequest {
            id: None,
        kind: CommentKind::Feedback,
        scope: None,
        anchor_id: "A".to_string(),
        block_id: Some("rl:blk-1".to_string()),
        structural: None,
        body: body.to_string(),
        edit: None,
        selection: None,
        author: None,
        reviewer: None,
        external_created_at: None,
        share_request_id: None,
        attachments: Vec::new(),
        research: None,
    };
    // A submitted comment (stays on v1), a reopened one and a draft (carried).
    let settled = store.add_comment("s", comment("settled")).unwrap();
    store.mark_submitted("s");
    store.reopen_resolution("s", &settled.id, Some("follow-up"), false);
    let submitted = store.add_comment("s", comment("in flight")).unwrap();
    store.mark_submitted("s");
    store.reopen_resolution("s", &settled.id, Some("follow-up"), false);
    let draft = store.add_comment("s", comment("still drafting")).unwrap();

    // Re-presented via "Restore plan session" — the store clones the body
    // it holds; no plan is resupplied.
    store.restore_latest("s").expect("restored");

    let check = |store: &SessionStore, label: &str| {
        let session = store.get("s").expect("session");
        assert_eq!(session.revisions.len(), 2, "{label}");
        let v1 = &session.revisions[0];
        let v2 = &session.revisions[1];
        // Open work moved to the restored revision (the pane shows only
        // the latest revision's comments); settled work stayed put.
        assert_eq!(
            v1.comments.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            vec![submitted.id.as_str()],
            "{label}: only the in-flight comment stays on v1"
        );
        let carried: Vec<&Comment> = v2.comments.iter().collect();
        assert_eq!(carried.len(), 2, "{label}");
        let reopened = carried.iter().find(|c| c.id == settled.id).unwrap();
        assert!(matches!(reopened.status, CommentStatus::Reopened), "{label}");
        assert_eq!(reopened.reopen_note.as_deref(), Some("follow-up"), "{label}");
        let moved_draft = carried.iter().find(|c| c.id == draft.id).unwrap();
        assert!(matches!(moved_draft.status, CommentStatus::Draft), "{label}");
        // Identical body → anchors resolve unchanged; nothing was rewritten.
        assert_eq!(moved_draft.anchor_id, "A", "{label}");
        assert_eq!(moved_draft.block_id.as_deref(), Some("rl:blk-1"), "{label}");
    };
    check(&store, "in memory");
    check(&SessionStore::new(db), "after reload");
}

#[test]
fn delete_session_removes_memory_and_db() {
    use crate::state::{CommentKind, NewCommentRequest};
    let db = Arc::new(Database::open_in_memory().unwrap());
    let store = SessionStore::new(db.clone());
    let md = "# Plan\n\nBody.\n";
    store.upsert_plan("doomed", "/tmp/d", md.to_string(), reparse_sections(md), true, false);
    store
        .add_comment(
            "doomed",
            NewCommentRequest {
            id: None,
                kind: CommentKind::Question,
                scope: None,
                anchor_id: "A".to_string(),
                block_id: None,
                structural: None,
                body: "q".to_string(),
                edit: None,
                selection: None,
                author: None,
                reviewer: None,
                external_created_at: None,
                share_request_id: None,
                attachments: Vec::new(),
                research: None,
            },
        )
        .expect("add comment");
    store.upsert_plan("keep", "/tmp/k", md.to_string(), reparse_sections(md), true, false);
    // A staged offer against each — the doomed one must not outlive its plan.
    db.insert_comment_offer(&mk_offer("o-doomed", "doomed", 100))
        .unwrap();
    db.insert_comment_offer(&mk_offer("o-keep", "keep", 100))
        .unwrap();

    assert!(store.delete_session("doomed"));
    assert!(db.list_open_comment_offers("doomed").unwrap().is_empty());
    assert_eq!(db.list_open_comment_offers("keep").unwrap().len(), 1);
    assert!(!store.has_session("doomed"));
    assert!(store.get("doomed").is_none());
    assert!(store.has_session("keep")); // unrelated session untouched
    assert!(!store.delete_session("doomed")); // already gone → false

    // Survives a reload from the same DB (revisions + comments cascaded).
    let reloaded = SessionStore::new(db);
    assert!(reloaded.get("doomed").is_none());
    assert!(reloaded.get("keep").is_some());
}

#[test]
fn rekey_session_moves_plan_and_comments_onto_the_live_id() {
    use crate::state::{CommentKind, NewCommentRequest};
    let db = Arc::new(Database::open_in_memory().unwrap());
    let store = SessionStore::new(db.clone());
    let md = "# Held Plan\n\nBody.\n";
    // The held plan lives under the original review session id.
    store.upsert_plan("old", "/tmp/p", md.to_string(), reparse_sections(md), true, false);
    let draft = store
        .add_comment(
            "old",
            NewCommentRequest {
            id: None,
                kind: CommentKind::Feedback,
                scope: None,
                anchor_id: "A".to_string(),
                block_id: Some("rl:blk-1".to_string()),
                structural: None,
                body: "in flight".to_string(),
                edit: None,
                selection: None,
                author: None,
                reviewer: None,
                external_created_at: None,
                share_request_id: None,
                attachments: Vec::new(),
                research: None,
            },
        )
        .expect("add comment");

    // Restore handshake arrives under a forked/foreign id → rebind onto it.
    assert!(store.rekey_session("old", "new"));
    assert!(!store.has_session("old"));
    assert!(store.has_session("new"));

    // No-op guards: equal ids, missing source, occupied destination.
    assert!(!store.rekey_session("new", "new"));
    assert!(!store.rekey_session("missing", "new2"));
    store.upsert_plan("occupied", "/tmp/o", md.to_string(), reparse_sections(md), true, false);
    assert!(!store.rekey_session("new", "occupied"));

    let check = |store: &SessionStore, label: &str| {
        let s = store.get("new").expect("session under new id");
        assert_eq!(s.session_id, "new", "{label}");
        assert_eq!(s.revisions.len(), 1, "{label}");
        assert_eq!(s.revisions[0].raw_plan_markdown, md, "{label}");
        // The reviewer's open comment rode along with the session.
        let c = &s.revisions[0].comments;
        assert_eq!(c.len(), 1, "{label}");
        assert_eq!(c[0].id, draft.id, "{label}");
    };
    check(&store, "in memory");

    // Survives a reload — the DB rows moved, not just the in-memory map.
    let reloaded = SessionStore::new(db);
    assert!(reloaded.get("old").is_none());
    check(&reloaded, "after reload");

    // And the held plan now restores cleanly under the live id.
    let restored = store.restore_latest("new").expect("restore under new id");
    assert_eq!(restored.version_number, 2);
}

// Mirrors the `handle_plan` thread-classification predicate:
// a plan answers feedback iff it carries resolutions OR a submit_review
// denial is still outstanding. This pins the `has_outstanding_review`
// half (the resolutions half is exercised by the round-trip test).
#[test]
fn outstanding_review_drives_thread_classification() {
    use crate::state::{CommentKind, SessionStatus};
    let store = make_store();
    let md = "# Plan\n\nBody.\n";

    // Missing session → not outstanding (first plan starts a fresh thread).
    assert!(!store.has_outstanding_review("sess-c"));

    store.upsert_plan("sess-c", "/tmp/c", md.to_string(), reparse_sections(md), true, false);
    // v1 received, no comments yet → nothing outstanding.
    assert!(!store.has_outstanding_review("sess-c"));

    store
        .add_comment(
            "sess-c",
            NewCommentRequest {
            id: None,
                kind: CommentKind::Question,
                scope: None,
                anchor_id: "A".to_string(),
                block_id: None,
                structural: None,
                body: "why?".to_string(),
                edit: None,
                selection: None,
                author: None,
                reviewer: None,
                external_created_at: None,
                share_request_id: None,
                attachments: Vec::new(),
                research: None,
            },
        )
        .expect("add comment");
    // Draft only — the reviewer hasn't submitted; next plan is still fresh.
    assert!(!store.has_outstanding_review("sess-c"));

    store.mark_submitted("sess-c");
    // Submitted + InReview → the next inbound plan is a revision.
    assert!(store.has_outstanding_review("sess-c"));

    store.set_status("sess-c", SessionStatus::Approved);
    // Approved → a subsequent plan in the same terminal is a fresh thread.
    assert!(!store.has_outstanding_review("sess-c"));
}

#[test]
fn add_and_retrieve_comments() {
    let store = make_store();
    let sections = reparse_sections("# A\n\nIntro paragraph.\n");
    store.upsert_plan("sess-1", "/tmp/proj", "# A\n\nIntro paragraph.\n".to_string(), sections, true, false);

    let req = NewCommentRequest {
            id: None,
        kind: CommentKind::Feedback,
        scope: Some(CommentScope::Structural),
        anchor_id: "A".to_string(),
        block_id: None,
        structural: None,
        body: "rethink this entire section".to_string(),
        edit: None,
        selection: None,
        author: None,
        reviewer: None,
        external_created_at: None,
        share_request_id: None,
        attachments: Vec::new(),
        research: None,
    };
    let c1 = store.add_comment("sess-1", req).expect("add");
    assert_eq!(c1.id, "c-001");
    assert!(matches!(c1.kind, CommentKind::Feedback));
    assert!(matches!(c1.scope, Some(CommentScope::Structural)));

    let req2 = NewCommentRequest {
            id: None,
        kind: CommentKind::Question,
        scope: None,
        anchor_id: "A".to_string(),
        block_id: None,
        structural: None,
        body: "why?".to_string(),
        edit: None,
        selection: None,
        author: None,
        reviewer: None,
        external_created_at: None,
        share_request_id: None,
        attachments: Vec::new(),
        research: None,
    };
    let c2 = store.add_comment("sess-1", req2).expect("add 2");
    assert_eq!(c2.id, "c-002");
    assert!(c2.scope.is_none());

    let session = store.get("sess-1").expect("get session");
    assert_eq!(session.revisions[0].comments.len(), 2);
}

// Agent-in-doc (M4): `author` and `agent_state` survive insert → reload,
// and `set_agent_state` refuses comments that aren't agent-authored.
#[test]
fn agent_author_and_state_round_trip() {
    use crate::state::{CommentKind, EditPayload};
    let db = Arc::new(Database::open_in_memory().unwrap());
    let store = SessionStore::new(db.clone());
    let md = "# A\n\nIntro paragraph.\n";
    store.upsert_plan("sess-a", "/tmp/a", md.to_string(), reparse_sections(md), true, false);

    let agent = store
        .add_comment(
            "sess-a",
            NewCommentRequest {
            id: None,
                kind: CommentKind::Edit,
                scope: None,
                anchor_id: "A.p1".to_string(),
                block_id: Some("blk-1".to_string()),
                structural: None,
                body: "(edit)".to_string(),
                edit: Some(EditPayload {
                    original: "Intro paragraph.".to_string(),
                    revised: "Intro sentence.".to_string(),
                }),
                selection: None,
                author: Some("claude-code".to_string()),
                reviewer: None,
                external_created_at: None,
                share_request_id: None,
                attachments: Vec::new(),
                research: None,
            },
        )
        .expect("add agent comment");
    assert_eq!(agent.author.as_deref(), Some("claude-code"));
    assert!(agent.agent_state.is_none());

    let user = store
        .add_comment(
            "sess-a",
            NewCommentRequest {
            id: None,
                kind: CommentKind::Question,
                scope: None,
                anchor_id: "A".to_string(),
                block_id: None,
                structural: None,
                body: "why?".to_string(),
                edit: None,
                selection: None,
                author: None,
                reviewer: None,
                external_created_at: None,
                share_request_id: None,
                attachments: Vec::new(),
                research: None,
            },
        )
        .expect("add user comment");

    assert!(store.set_agent_state("sess-a", &agent.id, Some("accepted".to_string())));
    // Not agent-authored → refused.
    assert!(!store.set_agent_state("sess-a", &user.id, Some("accepted".to_string())));
    // Unknown comment → refused.
    assert!(!store.set_agent_state("sess-a", "c-999", Some("accepted".to_string())));

    let reloaded = SessionStore::new(db);
    let s = reloaded.get("sess-a").expect("session");
    let rc = &s.revisions[0].comments[0];
    assert_eq!(rc.author.as_deref(), Some("claude-code"));
    assert_eq!(rc.agent_state.as_deref(), Some("accepted"));
    let ru = &s.revisions[0].comments[1];
    assert!(ru.author.is_none());
    assert!(ru.agent_state.is_none());
}

// Review Request / live-collab attribution: `reviewer` survives insert →
// reload and stays None for owner-originated comments.
#[test]
fn reviewer_attribution_round_trips() {
    use crate::state::CommentKind;
    let db = Arc::new(Database::open_in_memory().unwrap());
    let store = SessionStore::new(db.clone());
    let md = "# Plan\n\nBody.\n";
    store.upsert_plan("sess-r", "/tmp/r", md.to_string(), reparse_sections(md), true, false);
    let mk = |reviewer: Option<&str>| NewCommentRequest {
        id: None,
        kind: CommentKind::Feedback,
        scope: None,
        anchor_id: "A".to_string(),
        block_id: Some("blk-1".to_string()),
        structural: None,
        body: "from a return".to_string(),
        edit: None,
        selection: None,
        author: None,
        reviewer: reviewer.map(|s| s.to_string()),
        external_created_at: None,
        share_request_id: None,
        attachments: Vec::new(),
        research: None,
    };
    let imported = store
        .add_comment("sess-r", mk(Some("John Doe")))
        .expect("add imported comment");
    assert_eq!(imported.reviewer.as_deref(), Some("John Doe"));
    let own = store.add_comment("sess-r", mk(None)).expect("add own comment");
    assert!(own.reviewer.is_none());

    let reloaded = SessionStore::new(db);
    let s = reloaded.get("sess-r").expect("session");
    assert_eq!(
        s.revisions[0].comments[0].reviewer.as_deref(),
        Some("John Doe")
    );
    assert!(s.revisions[0].comments[1].reviewer.is_none());
}

// Return provenance: `external_created_at` + `share_request_id` survive
// insert → reload and stay None for owner-originated comments.
#[test]
fn comment_attachments_round_trip_and_survive_a_rekey() {
    use crate::state::{CommentAttachment, CommentKind};
    let db = Arc::new(Database::open_in_memory().unwrap());
    let store = SessionStore::new(db.clone());
    let md = "# Plan\n\nBody.\n";
    store.upsert_plan("old-sid", "/tmp/p", md.to_string(), reparse_sections(md), true, false);
    let att = CommentAttachment {
        path: "/data/attachments/old-sid/ui-mock.png".to_string(),
        name: "ui-mock.png".to_string(),
        mime: "image/png".to_string(),
        bytes: 4096,
    };
    let with_files = store
        .add_comment(
            "old-sid",
            NewCommentRequest {
                id: None,
                kind: CommentKind::Feedback,
                scope: None,
                anchor_id: "A".to_string(),
                block_id: Some("blk-1".to_string()),
                structural: None,
                body: "make it look like this".to_string(),
                edit: None,
                selection: None,
                author: None,
                reviewer: None,
                external_created_at: None,
                share_request_id: None,
                attachments: vec![att.clone()],
                research: None,
            },
        )
        .expect("add comment with an attachment");
    assert_eq!(with_files.attachments, vec![att.clone()]);

    // A comment with no files stores NULL, not "[]" — the pre-attachment
    // shape is preserved exactly.
    let plain = store
        .add_comment(
            "old-sid",
            NewCommentRequest {
                id: None,
                kind: CommentKind::Feedback,
                scope: None,
                anchor_id: "A".to_string(),
                block_id: Some("blk-1".to_string()),
                structural: None,
                body: "just words".to_string(),
                edit: None,
                selection: None,
                author: None,
                reviewer: None,
                external_created_at: None,
                share_request_id: None,
                attachments: Vec::new(),
                research: None,
            },
        )
        .expect("add plain comment");
    assert!(plain.attachments.is_empty());

    // Survives a reload (the column round-trips).
    let reloaded = SessionStore::new(db.clone());
    let s = reloaded.get("old-sid").expect("session");
    let rc = s.revisions[0]
        .comments
        .iter()
        .find(|c| c.id == with_files.id)
        .expect("comment");
    assert_eq!(rc.attachments, vec![att]);

    // A restore handshake re-keys the session; the stored paths must follow
    // the directory, or the payload would name a file that isn't there.
    assert!(reloaded.rekey_session("old-sid", "new-sid"));
    let moved = reloaded.get("new-sid").expect("rekeyed session");
    let mc = moved.revisions[0]
        .comments
        .iter()
        .find(|c| c.id == with_files.id)
        .expect("comment");
    assert_eq!(
        mc.attachments[0].path,
        "/data/attachments/new-sid/ui-mock.png",
        "in-memory path follows the rekey"
    );
    let after = SessionStore::new(db);
    let dc = after.get("new-sid").expect("session after reload");
    assert_eq!(
        dc.revisions[0]
            .comments
            .iter()
            .find(|c| c.id == with_files.id)
            .expect("comment")
            .attachments[0]
            .path,
        "/data/attachments/new-sid/ui-mock.png",
        "the persisted path follows it too"
    );
}

#[test]
fn return_provenance_round_trips() {
    use crate::state::CommentKind;
    let db = Arc::new(Database::open_in_memory().unwrap());
    let store = SessionStore::new(db.clone());
    let md = "# Plan\n\nBody.\n";
    store.upsert_plan("sess-p", "/tmp/p", md.to_string(), reparse_sections(md), true, false);
    let mk = |prov: bool| NewCommentRequest {
        id: None,
        kind: CommentKind::Feedback,
        scope: None,
        anchor_id: "A".to_string(),
        block_id: Some("blk-1".to_string()),
        structural: None,
        body: "from a return".to_string(),
        edit: None,
        selection: None,
        author: None,
        reviewer: prov.then(|| "John Doe".to_string()),
        external_created_at: prov.then_some(1_700_000_100_000),
        share_request_id: prov.then(|| "req-abc123".to_string()),
        attachments: Vec::new(),
        research: None,
    };
    let imported = store
        .add_comment("sess-p", mk(true))
        .expect("add imported comment");
    assert_eq!(imported.external_created_at, Some(1_700_000_100_000));
    assert_eq!(imported.share_request_id.as_deref(), Some("req-abc123"));
    let own = store.add_comment("sess-p", mk(false)).expect("add own comment");
    assert!(own.external_created_at.is_none());
    assert!(own.share_request_id.is_none());

    let reloaded = SessionStore::new(db);
    let s = reloaded.get("sess-p").expect("session");
    let rc = &s.revisions[0].comments[0];
    assert_eq!(rc.external_created_at, Some(1_700_000_100_000));
    assert_eq!(rc.share_request_id.as_deref(), Some("req-abc123"));
    let ro = &s.revisions[0].comments[1];
    assert!(ro.external_created_at.is_none());
    assert!(ro.share_request_id.is_none());
}

// Shares/returns registry (IV.2): record → list round-trips, session
// scoping holds, and deleting a share leaves its returns intact.
#[test]
fn shares_and_returns_registry_round_trips() {
    let db = Database::open_in_memory().unwrap();
    let share = |req: &str, sess: &str, at: i64| ShareRecord {
        request_id: req.to_string(),
        session_id: sess.to_string(),
        reviewer_name: "Jordan".to_string(),
        note: "please look at §2".to_string(),
        base_version: 3,
        created_at: at,
    };
    db.record_share(&share("req-1", "sess-a", 100)).unwrap();
    db.record_share(&share("req-2", "sess-a", 200)).unwrap();
    db.record_share(&share("req-3", "sess-b", 300)).unwrap();

    let listed = db.list_shares("sess-a").unwrap();
    assert_eq!(listed.len(), 2);
    // Newest first.
    assert_eq!(listed[0].request_id, "req-2");
    assert_eq!(listed[1].request_id, "req-1");
    assert_eq!(listed[1].note, "please look at §2");
    assert_eq!(listed[1].base_version, 3);

    let ret = ShareReturnRecord {
        id: "ret-1".to_string(),
        request_id: "req-1".to_string(),
        session_id: "sess-a".to_string(),
        reviewer_name: "Jordan".to_string(),
        imported_at: 400,
        landed_version: 5,
        placed: 2,
        orphans: 1,
        comment_ids: vec!["c-004".to_string(), "c-005".to_string()],
    };
    db.record_share_return(&ret).unwrap();
    let returns = db.list_share_returns("sess-a").unwrap();
    assert_eq!(returns.len(), 1);
    assert_eq!(returns[0].landed_version, 5);
    assert_eq!(returns[0].comment_ids, vec!["c-004", "c-005"]);
    assert!(db.list_share_returns("sess-b").unwrap().is_empty());

    // Forgetting the share keeps the imported history.
    db.delete_share("req-1").unwrap();
    assert_eq!(db.list_shares("sess-a").unwrap().len(), 1);
    assert_eq!(db.list_share_returns("sess-a").unwrap().len(), 1);
}

#[test]
fn thread_messages_round_trip_and_ordering() {
    let db = Database::open_in_memory().unwrap();
    let mk = |id: &str, role: &str, body: &str, at: i64| ThreadMessage {
        id: id.to_string(),
        session_id: "s1".to_string(),
        comment_id: "c-001".to_string(),
        role: role.to_string(),
        body: body.to_string(),
        status: "complete".to_string(),
        created_at: at,
        attachments: Vec::new(),
        mode: None,
    };
    // Inserted out of order — load_thread must return them by created_at.
    db.insert_thread_message(&mk("m2", "assistant", "second", 200))
        .unwrap();
    db.insert_thread_message(&mk("m1", "user", "first", 100))
        .unwrap();
    // A message on a different comment must not leak into this thread.
    db.insert_thread_message(&ThreadMessage {
        comment_id: "c-002".to_string(),
        ..mk("m3", "user", "other", 150)
    })
    .unwrap();

    let thread = db.load_thread("s1", "c-001").unwrap();
    assert_eq!(
        thread.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        vec!["m1", "m2"],
    );
    assert_eq!(thread[0].body, "first");
    assert_eq!(thread[1].role, "assistant");

    db.delete_thread("s1", "c-001").unwrap();
    assert!(db.load_thread("s1", "c-001").unwrap().is_empty());
    // The scoped delete left the other comment's message intact.
    assert_eq!(db.load_thread("s1", "c-002").unwrap().len(), 1);
}

#[test]
fn thread_message_mode_persists_and_null_reads_as_none() {
    let db = Database::open_in_memory().unwrap();
    let mk = |id: &str, at: i64, mode: Option<&str>| ThreadMessage {
        id: id.to_string(),
        session_id: "s1".to_string(),
        comment_id: "c-001".to_string(),
        role: "user".to_string(),
        body: id.to_string(),
        status: "complete".to_string(),
        created_at: at,
        attachments: Vec::new(),
        mode: mode.map(str::to_string),
    };
    db.insert_thread_message(&mk("report", 100, None)).unwrap();
    db.insert_thread_message(&mk("chat", 200, Some("chat"))).unwrap();
    // A row written by a build from before the column: no `mode` at all.
    db.lock_conn()
        .execute(
            "INSERT INTO thread_messages (id, session_id, comment_id, role, body, status, created_at)
                 VALUES ('legacy', 's1', 'c-001', 'assistant', 'old', 'complete', 300)",
            [],
        )
        .unwrap();
    let thread = db.load_thread("s1", "c-001").unwrap();
    let modes: Vec<_> = thread.iter().map(|m| (m.id.as_str(), m.mode.as_deref())).collect();
    assert_eq!(modes, [("report", None), ("chat", Some("chat")), ("legacy", None)]);
    // The wire shape: a report row carries no `mode` key at all.
    let json = serde_json::to_value(&thread).unwrap();
    assert!(json[0].get("mode").is_none());
    assert_eq!(json[1]["mode"], "chat");
}

#[test]
fn voice_fork_session_round_trip_and_is_known() {
    let db = Database::open_in_memory().unwrap();
    // No memory yet → re-entry would fork fresh.
    assert!(db.get_voice_fork_session("plan-1").is_none());
    assert!(!db.is_known_fork_session("voice-xyz"));

    // First turn persists the fork id; re-entry resumes the same id.
    db.set_voice_fork_session("plan-1", "voice-xyz").unwrap();
    assert_eq!(
        db.get_voice_fork_session("plan-1").as_deref(),
        Some("voice-xyz"),
    );
    // A stray ExitPlanMode from the voice fork is recognized and ignored.
    assert!(db.is_known_fork_session("voice-xyz"));

    // Upsert replaces (e.g. a revision keeps one thread under a new id).
    db.set_voice_fork_session("plan-1", "voice-2").unwrap();
    assert_eq!(
        db.get_voice_fork_session("plan-1").as_deref(),
        Some("voice-2"),
    );

    db.clear_voice_fork_session("plan-1").unwrap();
    assert!(db.get_voice_fork_session("plan-1").is_none());
    assert!(!db.is_known_fork_session("voice-2"));
}

#[test]
fn voice_messages_round_trip_and_are_scoped_per_key() {
    let db = Database::open_in_memory().unwrap();
    let mk = |id: &str, key: &str, role: &str, text: &str, at: i64| VoiceMessage {
        id: id.to_string(),
        session_key: key.to_string(),
        role: role.to_string(),
        text: text.to_string(),
        created_at: at,
    };
    assert!(db.list_voice_messages("plan-1").unwrap().is_empty());

    // Inserted out of order — the read must come back oldest-first, which is
    // the order the panel replays them in.
    db.insert_voice_message(&mk("v2", "plan-1", "agent", "second", 200))
        .unwrap();
    db.insert_voice_message(&mk("v1", "plan-1", "you", "first", 100))
        .unwrap();
    db.insert_voice_message(&mk("v3", "plan-1", "note", "▶ Read the plan", 300))
        .unwrap();
    // A different voice key (here a drafter session) must not leak in.
    db.insert_voice_message(&mk("v4", "drafter:d-9", "you", "other", 150))
        .unwrap();

    let thread = db.list_voice_messages("plan-1").unwrap();
    assert_eq!(
        thread.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        vec!["v1", "v2", "v3"],
    );
    assert_eq!(thread[0].role, "you");
    assert_eq!(thread[0].text, "first");
    assert_eq!(thread[2].role, "note", "markers are part of the transcript");
    assert_eq!(db.list_voice_messages("drafter:d-9").unwrap().len(), 1);
}

fn mk_offer(id: &str, session: &str, at: i64) -> CommentOffer {
    CommentOffer {
        id: id.to_string(),
        session_id: session.to_string(),
        message_id: None,
        block_id: "rl:blk-abc".to_string(),
        body: "Make the retry budget configurable".to_string(),
        label: Some("Configurable retry budget".to_string()),
        agent_id: "voice".to_string(),
        status: "pending".to_string(),
        created_at: at,
        stale: false,
        explicit: false,
    }
}

#[test]
fn comment_offers_round_trip_and_are_scoped_per_session() {
    let db = Database::open_in_memory().unwrap();
    assert!(db.list_open_comment_offers("plan-1").unwrap().is_empty());

    db.insert_comment_offer(&mk_offer("o2", "plan-1", 200)).unwrap();
    db.insert_comment_offer(&mk_offer("o1", "plan-1", 100)).unwrap();
    db.insert_comment_offer(&mk_offer("o3", "plan-2", 150)).unwrap();

    let open = db.list_open_comment_offers("plan-1").unwrap();
    assert_eq!(
        open.iter().map(|o| o.id.as_str()).collect::<Vec<_>>(),
        vec!["o1", "o2"],
        "oldest-first, and another session's offers never leak in",
    );
    assert_eq!(open[0].label.as_deref(), Some("Configurable retry budget"));
    assert!(open[0].message_id.is_none(), "unbound until the reply lands");
    assert!(!open[0].stale, "staleness is computed on read, never stored");

    let one = db.get_comment_offer("o1").unwrap().unwrap();
    assert_eq!(one.body, "Make the retry budget configurable");
    assert!(db.get_comment_offer("nope").unwrap().is_none());

    // Dismissal takes a row out of the open list without deleting it.
    assert!(db.resolve_comment_offer("o2", "dismissed").unwrap());
    assert!(
        !db.resolve_comment_offer("o2", "dismissed").unwrap(),
        "only a pending row transitions",
    );
    assert_eq!(db.list_open_comment_offers("plan-1").unwrap().len(), 1);
}

#[test]
fn bind_comment_offers_respects_the_you_line_floor() {
    let db = Database::open_in_memory().unwrap();
    let you = |id: &str, at: i64| VoiceMessage {
        id: id.to_string(),
        session_key: "plan-1".to_string(),
        role: "you".to_string(),
        text: "…".to_string(),
        created_at: at,
    };
    // Turn 1 asked at t=100 and staged an offer; turn 2 asked at t=300.
    db.insert_voice_message(&you("y1", 100)).unwrap();
    db.insert_comment_offer(&mk_offer("old", "plan-1", 150)).unwrap();
    db.insert_voice_message(&you("y2", 300)).unwrap();
    db.insert_comment_offer(&mk_offer("new", "plan-1", 350)).unwrap();

    assert_eq!(db.count_open_offers_this_turn("plan-1").unwrap(), 1);
    assert_eq!(db.bind_comment_offers("plan-1", "msg-2").unwrap(), 1);
    assert_eq!(
        db.get_comment_offer("new").unwrap().unwrap().message_id.as_deref(),
        Some("msg-2"),
    );
    assert!(
        db.get_comment_offer("old").unwrap().unwrap().message_id.is_none(),
        "a turn that errored out leaves its offer loose, not mis-attributed",
    );
    // Already-bound rows are skipped by the next turn's bind.
    db.insert_voice_message(&you("y3", 500)).unwrap();
    assert_eq!(db.bind_comment_offers("plan-1", "msg-3").unwrap(), 0);
    assert_eq!(
        db.get_comment_offer("new").unwrap().unwrap().message_id.as_deref(),
        Some("msg-2"),
    );
    // Bound rows also stop counting against the per-turn cap.
    assert_eq!(db.count_open_offers_this_turn("plan-1").unwrap(), 0);
}

#[test]
fn claiming_an_offer_is_a_compare_and_set() {
    let db = Database::open_in_memory().unwrap();
    db.insert_comment_offer(&mk_offer("o1", "plan-1", 100)).unwrap();

    assert!(db.claim_comment_offer("o1").unwrap());
    assert!(
        !db.claim_comment_offer("o1").unwrap(),
        "a double-tap must not write two comments",
    );
    assert!(db.list_open_comment_offers("plan-1").unwrap().is_empty());

    // A failed write puts the chip back.
    db.release_comment_offer("o1").unwrap();
    assert_eq!(db.list_open_comment_offers("plan-1").unwrap().len(), 1);
    assert!(db.claim_comment_offer("o1").unwrap());
}

#[test]
fn deleting_comment_cascades_its_thread() {
    let store = make_store();
    let md = "# Plan\n\nBody.\n";
    store.upsert_plan("s1", "/tmp/x", md.to_string(), reparse_sections(md), true, false);
    let mk_q = || NewCommentRequest {
            id: None,
        kind: CommentKind::Question,
        scope: None,
        anchor_id: "A".to_string(),
        block_id: None,
        structural: None,
        body: "why?".to_string(),
        edit: None,
        selection: None,
        author: None,
        reviewer: None,
        external_created_at: None,
        share_request_id: None,
        attachments: Vec::new(),
        research: None,
    };
    store.add_comment("s1", mk_q()).expect("add comment");
    let db = store.database();
    db.insert_thread_message(&ThreadMessage {
        id: "m1".to_string(),
        session_id: "s1".to_string(),
        comment_id: "c-001".to_string(),
        role: "assistant".to_string(),
        body: "old answer".to_string(),
        status: "complete".to_string(),
        created_at: 100,
        attachments: Vec::new(),
        mode: None,
    })
    .unwrap();

    store.delete_comment("s1", "c-001");
    assert!(db.load_thread("s1", "c-001").unwrap().is_empty());

    // A new comment reuses the id `c-001` — it must start with an empty
    // thread, not resurface the deleted comment's answer.
    let reused = store.add_comment("s1", mk_q()).expect("re-add comment");
    assert_eq!(reused.id, "c-001");
    assert!(db.load_thread("s1", "c-001").unwrap().is_empty());
}

#[test]
fn comment_fork_session_set_get_clear() {
    let store = make_store();
    let md = "# Plan\n\nBody.\n";
    store.upsert_plan("s-fork", "/tmp/f", md.to_string(), reparse_sections(md), true, false);
    store
        .add_comment(
            "s-fork",
            NewCommentRequest {
            id: None,
                kind: CommentKind::Question,
                scope: None,
                anchor_id: "A".to_string(),
                block_id: None,
                structural: None,
                body: "why?".to_string(),
                edit: None,
                selection: None,
                author: None,
                reviewer: None,
                external_created_at: None,
                share_request_id: None,
                attachments: Vec::new(),
                research: None,
            },
        )
        .expect("add comment");
    let db = store.database();

    // Fresh comment: no fork yet.
    assert!(db.get_comment_fork("s-fork", "c-001").is_none());
    assert!(!db.is_known_fork_session("fork-xyz"));
    assert_eq!(db.get_comment_fork_seat("s-fork", "c-001"), (None, None));
    db.set_comment_fork_seat("s-fork", "c-001", Some("sonnet"), Some("high")).unwrap();
    assert_eq!(db.get_comment_fork_seat("s-fork", "c-001"), (Some("sonnet".into()), Some("high".into())));
    assert_eq!(db.get_comment_fork_seat("different-plan", "c-001"), (None, None));

    db.set_comment_fork("s-fork", "c-001", "fork-xyz", "claude-code")
        .unwrap();
    assert_eq!(
        db.get_comment_fork("s-fork", "c-001"),
        Some(("fork-xyz".to_string(), "claude-code".to_string())),
    );
    assert!(db.is_known_fork_session("fork-xyz"));

    // Provenance survives a re-fork onto the other harness, and the pair
    // moves together — a stale backend beside a fresh id is the bug this
    // column exists to prevent.
    db.set_comment_fork("s-fork", "c-001", "thr-codex", "codex")
        .unwrap();
    assert_eq!(
        db.get_comment_fork("s-fork", "c-001"),
        Some(("thr-codex".to_string(), "codex".to_string())),
    );

    // A legacy row — fork id written before the backend column existed —
    // reads as Claude rather than as "unknown".
    {
        let conn = db.lock_conn();
        conn.execute(
            "UPDATE comments SET fork_backend = NULL
                 WHERE session_id = 's-fork' AND id = 'c-001'",
            [],
        )
        .unwrap();
    }
    assert_eq!(
        db.get_comment_fork("s-fork", "c-001"),
        Some(("thr-codex".to_string(), "claude-code".to_string())),
    );

    db.clear_comment_fork("s-fork", "c-001").unwrap();
    assert!(db.get_comment_fork("s-fork", "c-001").is_none());
    assert!(!db.is_known_fork_session("fork-xyz"));
    assert_eq!(db.get_comment_fork_seat("s-fork", "c-001"), (Some("sonnet".into()), Some("high".into())), "discard clears the resume pointer, preserving the user's model choice");
    db.set_comment_fork_seat("s-fork", "c-001", None, None).unwrap();
    assert_eq!(db.get_comment_fork_seat("s-fork", "c-001"), (None, None));
    // Both halves went, not just the id.
    let leftover: Option<String> = {
        let conn = db.lock_conn();
        conn.query_row(
            "SELECT fork_backend FROM comments WHERE session_id = 's-fork' AND id = 'c-001'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    };
    assert_eq!(leftover, None, "clear must null the backend too");
}

#[test]
fn attach_discussion_matrix_and_rider_consumption() {
    use std::collections::HashMap;

    let store = make_store();
    let md = "# Plan\n\nBody.\n";
    store.upsert_plan("s-disc", "/tmp/d", md.to_string(), reparse_sections(md), true, false);
    for (kind, body) in [
        (CommentKind::Question, "Should we ship Beta?"),
        (CommentKind::Feedback, "Beta needs a rollback story."),
    ] {
        store
            .add_comment(
                "s-disc",
                NewCommentRequest {
            id: None,
                    kind,
                    scope: None,
                    anchor_id: "A".to_string(),
                    block_id: None,
                    structural: None,
                    body: body.to_string(),
                    edit: None,
                    selection: None,
                    author: None,
                    reviewer: None,
                    external_created_at: None,
                    share_request_id: None,
                    attachments: Vec::new(),
                    research: None,
                },
            )
            .expect("add comment");
    }
    let get = |id: &str| {
        store
            .get("s-disc")
            .unwrap()
            .revisions
            .into_iter()
            .flat_map(|r| r.comments)
            .find(|c| c.id == id)
            .unwrap()
    };

    // Draft + as_change: rider set in place, question promoted, status
    // unchanged (the rider rides with the next submit).
    store
        .attach_discussion("s-disc", "c-001", Some("Decision: yes."), true)
        .expect("draft attach");
    let q = get("c-001");
    assert!(matches!(q.status, CommentStatus::Draft));
    assert_eq!(q.reopen_note.as_deref(), Some("Decision: yes."));
    assert!(q.actionable);

    // Blank note detaches the rider and demotes the draft question.
    store
        .attach_discussion("s-disc", "c-001", None, false)
        .expect("detach");
    let q = get("c-001");
    assert!(matches!(q.status, CommentStatus::Draft));
    assert_eq!(q.reopen_note, None);
    assert!(!q.actionable);

    // Feedback rider attaches without promotion, then the batch goes out:
    // attaching to an in-flight comment is rejected.
    store
        .attach_discussion("s-disc", "c-002", Some("Claude: flag + revert."), false)
        .expect("feedback attach");
    store.mark_submitted("s-disc");
    assert!(store
        .attach_discussion("s-disc", "c-002", Some("late"), false)
        .is_err());

    // Resolution arrives: the draft rider is consumed with NO history
    // entry (there was no prior resolution to archive).
    let mut res = HashMap::new();
    res.insert("c-002".to_string(), "Added the rollback section.".to_string());
    store.attach_resolutions("s-disc", &res, 2);
    let f = get("c-002");
    assert!(matches!(f.status, CommentStatus::Resolved));
    assert_eq!(f.reopen_note, None);
    assert!(f.reopen_history.is_empty());
    assert_eq!(f.resolution.as_ref().unwrap().body, "Added the rollback section.");

    // Post-resolution attach delegates to the reopen path.
    store
        .attach_discussion("s-disc", "c-002", Some("Not quite — see §A."), false)
        .expect("post-resolution attach");
    let f = get("c-002");
    assert!(matches!(f.status, CommentStatus::Reopened));
    assert_eq!(f.reopen_note.as_deref(), Some("Not quite — see §A."));
    assert!(f.resolution.is_some());
}

#[test]
fn attach_resolutions_archives_round_for_submitted_reopen() {
    // Production flow: a reopened comment is flipped to Submitted by
    // mark_submitted BEFORE Claude's next plan attaches the re-resolution.
    // The archive must key on the prior resolution, not on `Reopened`.
    use std::collections::HashMap;

    let store = make_store();
    let md = "# Plan\n\nBody.\n";
    store.upsert_plan("s-arch", "/tmp/a", md.to_string(), reparse_sections(md), true, false);
    store
        .add_comment(
            "s-arch",
            NewCommentRequest {
            id: None,
                kind: CommentKind::Feedback,
                scope: None,
                anchor_id: "A".to_string(),
                block_id: None,
                structural: None,
                body: "Tighten this.".to_string(),
                edit: None,
                selection: None,
                author: None,
                reviewer: None,
                external_created_at: None,
                share_request_id: None,
                attachments: Vec::new(),
                research: None,
            },
        )
        .expect("add comment");
    store.mark_submitted("s-arch");
    let mut r1 = HashMap::new();
    r1.insert("c-001".to_string(), "Tightened.".to_string());
    store.attach_resolutions("s-arch", &r1, 2);
    assert!(store.reopen_resolution("s-arch", "c-001", Some("Go further."), false));
    store.mark_submitted("s-arch"); // reopened → submitted, as in the real flow
    let mut r2 = HashMap::new();
    r2.insert("c-001".to_string(), "Cut it to one line.".to_string());
    store.attach_resolutions("s-arch", &r2, 3);

    let c = store
        .get("s-arch")
        .unwrap()
        .revisions
        .into_iter()
        .flat_map(|r| r.comments)
        .find(|c| c.id == "c-001")
        .unwrap();
    assert!(matches!(c.status, CommentStatus::Resolved));
    assert_eq!(c.resolution.as_ref().unwrap().body, "Cut it to one line.");
    assert_eq!(c.reopen_note, None);
    assert_eq!(c.reopen_history.len(), 1);
    assert_eq!(c.reopen_history[0].resolution_body, "Tightened.");
    assert_eq!(c.reopen_history[0].reopen_note.as_deref(), Some("Go further."));
}

#[test]
fn full_round_trip_state_machine() {
    use crate::feedback::serialize_revise_payload;
    use crate::resolutions::extract_resolutions;
    use crate::state::CommentScope;
    use std::collections::HashMap;

    let store = make_store();

    // v1 arrives
    let v1_md = "# Plan\n\nIntro paragraph.\n\n## Detail\n\nDetailed body.\n";
    store.upsert_plan(
        "sess-rt",
        "/tmp/proj",
        v1_md.to_string(),
        reparse_sections(v1_md),
        true,
        false,
    );

    // Reviewer adds two comments
    store.add_comment(
        "sess-rt",
        NewCommentRequest {
            id: None,
            kind: CommentKind::Feedback,
            scope: Some(CommentScope::Structural),
            anchor_id: "A.1".to_string(),
            block_id: None,
            structural: None,
            body: "Rethink the detail section.".to_string(),
            edit: None,
            selection: None,
            author: None,
            reviewer: None,
            external_created_at: None,
            share_request_id: None,
            attachments: Vec::new(),
            research: None,
        },
    )
    .expect("add comment");
    store.add_comment(
        "sess-rt",
        NewCommentRequest {
            id: None,
            kind: CommentKind::Question,
            scope: None,
            anchor_id: "A".to_string(),
            block_id: None,
            structural: None,
            body: "Why this order?".to_string(),
            edit: None,
            selection: None,
            author: None,
            reviewer: None,
            external_created_at: None,
            share_request_id: None,
            attachments: Vec::new(),
            research: None,
        },
    )
    .expect("add comment");

    // Build the feedback payload and submit
    let (sections, draft_comments, body_markdown) = store
        .drafts_and_reopens_for_payload("sess-rt")
        .expect("session exists");
    assert_eq!(draft_comments.len(), 2);
    let payload = serialize_revise_payload(&sections, &draft_comments, &body_markdown);
    assert!(payload.contains("\"c-001\":"));
    assert!(payload.contains("\"c-002\":"));

    let submitted = store.mark_submitted("sess-rt");
    assert_eq!(submitted.len(), 2);

    // Verify comments are now submitted
    let session = store.get("sess-rt").unwrap();
    for c in session.revisions[0].comments.iter() {
        assert!(matches!(c.status, CommentStatus::Submitted));
    }

    // v2 arrives with REDLINE_RESOLUTIONS
    let v2_md = r#"<!-- REDLINE_RESOLUTIONS
{
  "c-001": "Restructured §A.1 to address the concern.",
  "c-002": "Reordered for clarity."
}
-->

# Plan v2

Refined intro.

## Detail

Restructured detail body.
"#;
    let extracted = extract_resolutions(v2_md);
    assert!(extracted.parse_error.is_none());
    assert_eq!(extracted.resolutions.len(), 2);

    let stripped = extracted.stripped_markdown.clone();
    let v2_sections = reparse_sections(&stripped);
    let report: HashMap<_, _> = extracted.resolutions.into_iter().collect();
    let attach_report = store.attach_resolutions("sess-rt", &report, 2);
    store.upsert_plan("sess-rt", "/tmp/proj", stripped, v2_sections, false, false);

    assert!(attach_report.unmatched_ids.is_empty());
    assert!(attach_report.unresolved_submitted_ids.is_empty());

    // v1 comments should now be resolved with attached bodies
    let session = store.get("sess-rt").unwrap();
    let c1 = session.revisions[0]
        .comments
        .iter()
        .find(|c| c.id == "c-001")
        .unwrap();
    assert!(matches!(c1.status, CommentStatus::Resolved));
    let res1 = c1.resolution.as_ref().expect("resolution attached");
    assert!(res1.body.contains("Restructured"));
    assert_eq!(res1.appeared_in_version, 2);

    // Accept c-001, reopen c-002 with a follow-up note
    assert!(store.accept_resolution("sess-rt", "c-001"));
    assert!(store.reopen_resolution("sess-rt", "c-002", Some("still wrong — see §B"), false));

    let session = store.get("sess-rt").unwrap();
    let c1 = session.revisions[0]
        .comments
        .iter()
        .find(|c| c.id == "c-001")
        .unwrap();
    assert!(matches!(c1.status, CommentStatus::Accepted));
    assert!(c1.resolution.as_ref().unwrap().accepted_at.is_some());

    let c2 = session.revisions[0]
        .comments
        .iter()
        .find(|c| c.id == "c-002")
        .unwrap();
    assert!(matches!(c2.status, CommentStatus::Reopened));
    // The note rode through the DB round-trip; the prior resolution stays
    // attached (continuity) but is no longer accepted.
    assert_eq!(c2.reopen_note.as_deref(), Some("still wrong — see §B"));
    assert!(c2.resolution.is_some());
    assert!(c2.resolution.as_ref().unwrap().accepted_at.is_none());

    // Submitting again should include the reopened c-002 but not the accepted c-001
    let (_, comments_for_round_2, _) = store
        .drafts_and_reopens_for_payload("sess-rt")
        .expect("session exists");
    let ids: Vec<&str> = comments_for_round_2.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids, vec!["c-002"]);

    // Claude re-resolves the reopened comment: the round is archived to
    // history and the consumed note is cleared.
    let mut round2 = HashMap::new();
    round2.insert("c-002".to_string(), "Now fixed in v3.".to_string());
    store.attach_resolutions("sess-rt", &round2, 3);

    let session = store.get("sess-rt").unwrap();
    let c2 = session.revisions[0]
        .comments
        .iter()
        .find(|c| c.id == "c-002")
        .unwrap();
    assert!(matches!(c2.status, CommentStatus::Resolved));
    assert_eq!(c2.reopen_note, None);
    assert_eq!(c2.resolution.as_ref().unwrap().body, "Now fixed in v3.");
    assert_eq!(c2.reopen_history.len(), 1);
    assert_eq!(
        c2.reopen_history[0].reopen_note.as_deref(),
        Some("still wrong — see §B")
    );
}

#[test]
fn ask_round_trip_attaches_resolutions_without_version_bump() {
    // Mirrors handle_plan's Ask path: prior submit was an all-question
    // batch, Claude returned the same plan with answers in the
    // resolution sidecar. The store side of that path must attach
    // resolutions to the CURRENT revision (appeared_in_version =
    // latest, not next) and NOT upsert a new revision row.
    use crate::resolutions::extract_resolutions;
    use std::collections::HashMap;

    let store = make_store();

    let v1_md = "# Plan\n\nIntro paragraph.\n\n# Beta\n\nbody.\n";
    store.upsert_plan(
        "sess-ask",
        "/tmp/proj",
        v1_md.to_string(),
        reparse_sections(v1_md),
        true,
        false,
    );

    store
        .add_comment(
            "sess-ask",
            NewCommentRequest {
            id: None,
                kind: CommentKind::Question,
                scope: None,
                anchor_id: "A".to_string(),
                block_id: None,
                structural: None,
                body: "Why this order?".to_string(),
                edit: None,
                selection: None,
                author: None,
                reviewer: None,
                external_created_at: None,
                share_request_id: None,
                attachments: Vec::new(),
                research: None,
            },
        )
        .expect("add q1");
    store
        .add_comment(
            "sess-ask",
            NewCommentRequest {
            id: None,
                kind: CommentKind::Question,
                scope: None,
                anchor_id: "B".to_string(),
                block_id: None,
                structural: None,
                body: "Why is Beta last?".to_string(),
                edit: None,
                selection: None,
                author: None,
                reviewer: None,
                external_created_at: None,
                share_request_id: None,
                attachments: Vec::new(),
                research: None,
            },
        )
        .expect("add q2");

    store.mark_submitted("sess-ask");

    // Ask round-trip: Claude returns the plan body unchanged + answers.
    let same_md_with_answers = r#"<!-- REDLINE_RESOLUTIONS
{
  "c-001": "Alphabetical, no narrative reason.",
  "c-002": "Same — alphabetical."
}
-->

# Plan

Intro paragraph.

# Beta

body.
"#;
    let extracted = extract_resolutions(same_md_with_answers);
    assert!(extracted.parse_error.is_none());
    assert_eq!(extracted.resolutions.len(), 2);

    // The current latest version is 1 — Ask path uses that, not 2.
    let latest_version = store
        .get("sess-ask")
        .and_then(|s| s.revisions.last().map(|r| r.version_number))
        .unwrap();
    assert_eq!(latest_version, 1);

    let report: HashMap<_, _> = extracted.resolutions.into_iter().collect();
    let attach_report = store.attach_resolutions("sess-ask", &report, latest_version);

    // Crucially: NO upsert_plan call here. The Ask path keeps the
    // same revision row.
    assert!(attach_report.unmatched_ids.is_empty());
    assert!(attach_report.unresolved_submitted_ids.is_empty());

    let session = store.get("sess-ask").unwrap();
    assert_eq!(
        session.revisions.len(),
        1,
        "Ask round-trip must not create a new revision"
    );

    for id in ["c-001", "c-002"] {
        let c = session.revisions[0]
            .comments
            .iter()
            .find(|c| c.id == id)
            .unwrap();
        assert!(matches!(c.status, CommentStatus::Resolved));
        let res = c.resolution.as_ref().expect("resolution attached");
        assert_eq!(
            res.appeared_in_version, 1,
            "answers belong to the current (unchanged) revision"
        );
    }

    // has_outstanding_review flips false now that all questions
    // resolved — a subsequent unrelated plan would correctly classify
    // as a thread_start.
    assert!(!store.has_outstanding_review("sess-ask"));
}

#[test]
fn interception_mode_setting_persists() {
    use crate::state::InterceptionMode;

    let tmpfile = tempfile_path();
    {
        let db = Database::open(&tmpfile).unwrap();
        assert!(db.get_setting("interception_mode").is_none());
        db.set_setting("interception_mode", InterceptionMode::Ambient.as_str())
            .unwrap();
        // Overwrite to confirm upsert semantics.
        db.set_setting("interception_mode", InterceptionMode::Paused.as_str())
            .unwrap();
    }
    let db2 = Database::open(&tmpfile).unwrap();
    let restored = db2
        .get_setting("interception_mode")
        .and_then(|s| InterceptionMode::from_str(&s));
    assert!(matches!(restored, Some(InterceptionMode::Paused)));
    let _ = std::fs::remove_file(&tmpfile);
}

#[test]
fn persistence_survives_restart() {
    let tmpfile = tempfile_path();
    {
        let db = Arc::new(Database::open(&tmpfile).unwrap());
        let store = SessionStore::new(db);
        let md = "# Title\n\nBody.\n";
        store.upsert_plan("sess-x", "/tmp/p", md.to_string(), reparse_sections(md), true, false);
        store.add_comment(
            "sess-x",
            NewCommentRequest {
            id: None,
                kind: CommentKind::Edit,
                scope: None,
                anchor_id: "A.p1".to_string(),
                block_id: None,
                structural: None,
                body: "swap wording".to_string(),
                edit: Some(EditPayload {
                    original: "Body.".to_string(),
                    revised: "Substance.".to_string(),
                }),
                selection: None,
                author: None,
                reviewer: None,
                external_created_at: None,
                share_request_id: None,
                attachments: Vec::new(),
                research: None,
            },
        )
        .expect("add comment");
    }
    let db2 = Arc::new(Database::open(&tmpfile).unwrap());
    let store2 = SessionStore::new(db2);
    let session = store2.get("sess-x").expect("session reloaded");
    assert_eq!(session.revisions.len(), 1);
    assert_eq!(session.revisions[0].comments.len(), 1);
    let comment = &session.revisions[0].comments[0];
    assert_eq!(comment.id, "c-001");
    assert_eq!(comment.body, "swap wording");
    assert!(matches!(comment.kind, CommentKind::Edit));
    let _ = std::fs::remove_file(&tmpfile);
}

#[test]
fn comment_block_id_persists_and_updates() {
    use crate::state::UpdateCommentRequest;

    let db = Arc::new(Database::open_in_memory().unwrap());
    let store = SessionStore::new(db.clone());
    let md = "# T\n\nBody.\n";
    store.upsert_plan("s", "/tmp/s", md.to_string(), reparse_sections(md), true, false);

    let c = store
        .add_comment(
            "s",
            NewCommentRequest {
            id: None,
                kind: CommentKind::Edit,
                scope: None,
                anchor_id: "A.p1".to_string(),
                block_id: Some("blk-abc123".to_string()),
                structural: None,
                body: "tighten".to_string(),
                edit: Some(EditPayload {
                    original: "Body.".to_string(),
                    revised: "Prose.".to_string(),
                }),
                selection: None,
                author: None,
                reviewer: None,
                external_created_at: None,
                share_request_id: None,
                attachments: Vec::new(),
                research: None,
            },
        )
        .expect("add");
    assert_eq!(c.block_id.as_deref(), Some("blk-abc123"));

    // Survives a reload from disk-backed state.
    let reloaded = SessionStore::new(db.clone());
    assert_eq!(
        reloaded.get("s").unwrap().revisions[0].comments[0]
            .block_id
            .as_deref(),
        Some("blk-abc123")
    );

    // update_comment can re-key the block id (block re-identification).
    store
        .update_comment(
            "s",
            "c-001",
            UpdateCommentRequest {
                body: None,
                scope: None,
                block_id: Some("blk-def456".to_string()),
                structural: None,
                edit: None,
                selection: None,
            },
        )
        .expect("update");
    let reloaded2 = SessionStore::new(db);
    assert_eq!(
        reloaded2.get("s").unwrap().revisions[0].comments[0]
            .block_id
            .as_deref(),
        Some("blk-def456")
    );
}

#[test]
fn structural_payload_round_trips_through_db() {
    use crate::state::{CommentKind, NewCommentRequest, StructuralPayload};

    let db = Arc::new(Database::open_in_memory().unwrap());
    let store = SessionStore::new(db.clone());
    let md = "# T\n\nAlpha.\n\nBeta.\n";
    store.upsert_plan("s", "/tmp/s", md.to_string(), reparse_sections(md), true, false);

    let c = store
        .add_comment(
            "s",
            NewCommentRequest {
            id: None,
                kind: CommentKind::BlockMove,
                scope: None,
                anchor_id: "A.p1".to_string(),
                block_id: Some("blk-x".to_string()),
                structural: Some(StructuralPayload {
                    op: "move".to_string(),
                    block_id: "blk-x".to_string(),
                    from_anchor: Some("A.p1".to_string()),
                    to_anchor: Some("A.p2".to_string()),
                    markdown: Some("Alpha.".to_string()),
                }),
                body: "reordered for flow".to_string(),
                edit: None,
                selection: None,
                author: None,
                reviewer: None,
                external_created_at: None,
                share_request_id: None,
                attachments: Vec::new(),
                research: None,
            },
        )
        .expect("add structural");
    assert!(matches!(c.kind, CommentKind::BlockMove));
    let sp = c.structural.as_ref().expect("payload set");
    assert_eq!(sp.op, "move");
    assert_eq!(sp.to_anchor.as_deref(), Some("A.p2"));

    // Survives reload from the backing DB.
    let reloaded = SessionStore::new(db);
    let rc = &reloaded.get("s").unwrap().revisions[0].comments[0];
    assert!(matches!(rc.kind, CommentKind::BlockMove));
    let rsp = rc.structural.as_ref().expect("payload survived");
    assert_eq!(rsp.op, "move");
    assert_eq!(rsp.block_id, "blk-x");
    assert_eq!(rsp.from_anchor.as_deref(), Some("A.p1"));
    assert_eq!(rsp.to_anchor.as_deref(), Some("A.p2"));
    assert_eq!(rsp.markdown.as_deref(), Some("Alpha."));
}

fn tempfile_path() -> std::path::PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!("redline-test-{}.db", uuid::Uuid::new_v4()));
    p
}

// ── Schema versioning ────────────────────────────────────────────────
//
// The fast path is the whole point of `PRAGMA user_version`, so it is the
// thing under test: an already-current database must execute NO schema
// SQL. Everything else here guards the ways a version stamp can lie.

fn user_version(path: &std::path::Path) -> i64 {
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap()
}

#[test]
fn a_fresh_database_lands_on_the_current_version() {
    let path = tempfile_path();
    {
        let store = SessionStore::new(Arc::new(Database::open(&path).unwrap()));
        // The schema is real, not just stamped: a write that touches the
        // tables and the ALTER-added columns has to succeed.
        let md = "# Fresh\n\nBody.\n";
        store.upsert_plan(
            "s-fresh",
            "/tmp/f",
            md.to_string(),
            crate::state::reparse_sections(md),
            true,
            false,
        );
        store.set_backend("s-fresh", Some("codex"), Some("gpt-5"));
    }
    assert_eq!(user_version(&path), Database::SCHEMA_VERSION);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn comment_fork_seat_schema_survives_reopening_without_duplicate_columns() {
    let path = tempfile_path();
    for _ in 0..2 {
        let db = Database::open(&path).unwrap();
        let conn = db.lock_conn();
        let mut query = conn.prepare("PRAGMA table_info(comments)").unwrap();
        let columns: Vec<String> = query.query_map([], |row| row.get(1)).unwrap().collect::<Result<_, _>>().unwrap();
        for column in ["fork_model", "fork_effort"] {
            assert_eq!(columns.iter().filter(|name| name.as_str() == column).count(), 1, "{column}");
        }
    }
    let _ = std::fs::remove_file(path);
}

#[test]
fn a_current_database_runs_no_migration_sql() {
    // The regression this exists to catch: reintroducing per-launch schema
    // replay. Before versioning, EVERY launch executed ~60
    // `CREATE TABLE IF NOT EXISTS`, ~50 `CREATE INDEX IF NOT EXISTS` and
    // 68 `ALTER TABLE ADD COLUMN` statements that were expected to fail,
    // in front of the window.
    let steps = || MIGRATION_STEPS_RUN.with(|c| c.get());
    let path = tempfile_path();
    MIGRATION_STEPS_RUN.with(|c| c.set(0));
    drop(Database::open(&path).unwrap());
    assert_eq!(steps(), 1, "the first open must build the schema exactly once");
    assert_eq!(user_version(&path), Database::SCHEMA_VERSION);

    // Every subsequent launch verifies shape using only read queries;
    // it never replays the schema migration steps.
    for _ in 0..3 {
        drop(Database::open(&path).unwrap());
    }
    assert_eq!(steps(), 1, "a current-schema launch re-ran a migration step");
    let _ = std::fs::remove_file(&path);
}

#[test]
fn a_legacy_version_zero_database_migrates_and_keeps_its_rows() {
    // The shape every existing install is in: a full schema written by a
    // pre-versioning build, with `user_version` never set.
    let path = tempfile_path();
    {
        let store = SessionStore::new(Arc::new(Database::open(&path).unwrap()));
        let md = "# Legacy\n\nBody.\n";
        store.upsert_plan(
            "legacy",
            "/tmp/l",
            md.to_string(),
            crate::state::reparse_sections(md),
            true,
            false,
        );
        store.set_backend("legacy", Some("codex"), Some("gpt-5"));
    }
    // Rewind the stamp: this is now indistinguishable from a database
    // written before versioning existed.
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.pragma_update(None, "user_version", 0i64).unwrap();
    }
    assert_eq!(user_version(&path), 0);

    let db = Database::open(&path).unwrap();
    assert_eq!(user_version(&path), Database::SCHEMA_VERSION);
    let sessions = db.load_all().unwrap();
    let legacy = sessions.get("legacy").expect("legacy session survived");
    assert_eq!(legacy.revisions.len(), 1);
    assert_eq!(legacy.revisions[0].raw_plan_markdown, "# Legacy\n\nBody.\n");
    // The provenance columns are part of the migration sequence, not
    // something a later build bolts on outside it.
    assert_eq!(legacy.backend.as_deref(), Some("codex"));
    assert_eq!(legacy.model.as_deref(), Some("gpt-5"));
    drop(db);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn foreign_version_two_history_shape_repairs_additively() {
    let path = tempfile_path();
    {
        let conn = Connection::open(&path).unwrap();
        // Exact collision: the pre-runner shape carrying cockpit's 2.
        Database::migrate_v1(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO sessions(session_id,project_path,project_name,created_at)
                 VALUES('foreign-history','/tmp/history','history',1);
                 INSERT INTO revisions(session_id,version_number,received_at,raw_plan_markdown)
                 VALUES('foreign-history',1,2,'# Kept plan');
                 INSERT INTO comments(id,session_id,version_number,type,anchor_id,body,created_at,status)
                 VALUES('kept-comment','foreign-history',1,'feedback','blk-kept','Keep this feedback',3,'draft');
                 PRAGMA user_version=2;"
        ).unwrap();
        assert!(conn.prepare("SELECT effort FROM sessions").is_err());
        assert!(conn.prepare("SELECT * FROM run_graphs").is_err());
    }
    let db = Database::open(&path).unwrap();
    assert_eq!(user_version(&path), Database::SCHEMA_VERSION);
    let sessions = db.load_all().unwrap();
    assert_eq!(db.plan_history_counts().unwrap(), (1, 1, 1));
    assert_eq!(sessions.len(), 1);
    let kept = &sessions["foreign-history"];
    assert_eq!(kept.effort, None);
    assert_eq!(kept.revisions.len(), 1);
    assert_eq!(kept.revisions[0].raw_plan_markdown, "# Kept plan");
    assert_eq!(kept.revisions[0].comments[0].body, "Keep this feedback");
    assert!(db.runner_list().unwrap().is_empty());
    drop(db);
    // A second open must remain readable and avoid another migration.
    assert_eq!(Database::open(&path).unwrap().load_all().unwrap().len(), 1);
    let _ = std::fs::remove_file(path);
}

#[test]
fn a_matching_stamp_with_missing_history_shape_is_refused_without_ddl() {
    for ddl in ["ALTER TABLE sessions DROP COLUMN effort", "DROP TABLE run_graphs"] {
        let path = tempfile_path();
        drop(Database::open(&path).unwrap());
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(ddl).unwrap();
        let schema_before: i64 = conn.query_row("PRAGMA schema_version", [], |r|r.get(0)).unwrap();
        drop(conn);
        // Even a current stamp must check shape; a read-only connection
        // demonstrates that this branch cannot try additive repair.
        let conn = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert!(Database::migrate(&conn).is_err());
        assert_eq!(conn.query_row("PRAGMA schema_version", [], |r|r.get::<_,i64>(0)).unwrap(), schema_before);
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r|r.get::<_,i64>(0)).unwrap(), Database::SCHEMA_VERSION);
        drop(conn);
        let _ = std::fs::remove_file(path);
    }
}

#[test]
fn version_three_repair_does_not_stamp_an_unusable_legacy_shape() {
    let conn = Connection::open_in_memory().unwrap();
    Database::migrate_v1(&conn).unwrap();
    conn.execute_batch("PRAGMA user_version=2; ALTER TABLE sessions DROP COLUMN model;").unwrap();
    assert!(Database::migrate(&conn).is_err());
    assert_eq!(conn.query_row("PRAGMA user_version", [], |r|r.get::<_,i64>(0)).unwrap(), 2);
}

fn history_snapshot(conn: &Connection) -> Vec<(Vec<String>, Vec<Vec<rusqlite::types::Value>>)> {
    [("sessions","session_id"),("revisions","session_id,version_number"),("comments","session_id,id")]
        .into_iter().map(|(table,order)| {
            let columns: Vec<String> = conn.prepare(&format!("PRAGMA table_info({table})")).unwrap()
                .query_map([],|r|r.get::<_,String>(1)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
                .into_iter().filter(|c|table!="sessions" || c!="effort").collect();
            let projection=columns.iter().map(|c|format!("\"{}\"",c.replace('"',"\"\""))).collect::<Vec<_>>().join(",");
            let rows=conn.prepare(&format!("SELECT {projection} FROM {table} ORDER BY {order}")).unwrap()
                .query_map([],|r|(0..columns.len()).map(|i|r.get(i)).collect::<rusqlite::Result<Vec<rusqlite::types::Value>>>()).unwrap()
                .collect::<rusqlite::Result<Vec<_>>>().unwrap();
            (columns,rows)
        }).collect()
}

#[test]
#[ignore = "requires a separately created SQLite recovery copy via REDLINE_HISTORY_RECOVERY_COPY"]
fn recovery_copy_opens_and_loads_all_history_without_changing_rows() {
    let path = std::path::PathBuf::from(std::env::var("REDLINE_HISTORY_RECOVERY_COPY").expect("set recovery COPY path"));
    assert!(path.file_name().unwrap().to_string_lossy().starts_with("redline-history-copy-"), "only a disposable recovery copy may be opened");
    let before = {
        let conn = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r|r.get::<_,i64>(0)).unwrap(), 2);
        history_snapshot(&conn)
    };
    let db = Database::open(&path).unwrap();
    let sessions = db.load_all().unwrap();
    let counts = (sessions.len(), sessions.values().map(|s|s.revisions.len()).sum::<usize>(), sessions.values().flat_map(|s|&s.revisions).map(|r|r.comments.len()).sum::<usize>());
    assert_eq!(counts, (before[0].1.len(),before[1].1.len(),before[2].1.len()));
    assert_eq!(db.plan_history_counts().unwrap(), (counts.0 as i64,counts.1 as i64,counts.2 as i64));
    assert!(history_snapshot(&db.lock_conn()) == before, "existing history cells changed during recovery migration");
    assert_eq!(db.lock_conn().query_row("PRAGMA quick_check", [], |r|r.get::<_,String>(0)).unwrap(), "ok");
    assert_eq!(user_version(&path), Database::SCHEMA_VERSION);
    println!("Recovery copy preserved and loaded {} sessions, {} revisions, {} comments; quick_check ok",counts.0,counts.1,counts.2);
}

#[test]
fn a_forward_stamp_with_a_usable_schema_opens_and_runs_no_migrations() {
    // THE regression. `PRAGMA user_version` is one 32-bit slot, and this
    // app has had two migration lineages claim it — the `cockpit` branch
    // shipped its own runner long before this one, so a developer machine
    // that ever ran a cockpit build carries a stamp (2) from an unrelated
    // numbering space. Refusing on the integer alone bricked exactly that
    // database: a hard panic in Tauri's setup, no window, no message.
    //
    // The schema is the authority. A forward stamp whose schema has
    // everything we need opens, runs NO steps, and — critically — does not
    // restamp: an older build replaying additive steps over a newer schema
    // is the corruption the refusal existed to prevent, and that is still
    // prevented.
    let path = tempfile_path();
    drop(Database::open(&path).unwrap());
    let foreign = Database::SCHEMA_VERSION + 1;
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.pragma_update(None, "user_version", foreign).unwrap();
    }

    let steps = || MIGRATION_STEPS_RUN.with(|c| c.get());
    MIGRATION_STEPS_RUN.with(|c| c.set(0));
    let db = match Database::open(&path) {
        Ok(db) => db,
        Err(e) => panic!("a usable schema must open whatever the stamp says: {e}"),
    };
    assert_eq!(steps(), 0, "a forward stamp must run no migration steps");
    assert_eq!(
        user_version(&path),
        foreign,
        "the other lineage's stamp must be left exactly as found"
    );
    // And it is genuinely usable, not merely open.
    let store = SessionStore::new(Arc::new(db));
    let md = "# Forward\n\nBody.\n";
    store.upsert_plan("fwd", "/tmp/f", md.to_string(), reparse_sections(md), true, false);
    assert!(store.get("fwd").is_some());
    let _ = std::fs::remove_file(&path);
}

#[test]
fn a_forward_stamp_missing_columns_we_need_is_refused() {
    // The protection that must survive the fix above: "newer" plus a
    // schema that genuinely lacks something this build reads is still a
    // refusal, with a message that names the fix.
    let path = tempfile_path();
    drop(Database::open(&path).unwrap());
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("DROP TABLE IF EXISTS drafts;").unwrap();
        conn.pragma_update(None, "user_version", Database::SCHEMA_VERSION + 7)
            .unwrap();
    }
    let err = match Database::open(&path) {
        Ok(_) => panic!("a forward stamp missing our columns must be refused"),
        Err(e) => e,
    };
    assert!(
        err.to_string().contains("newer than this build"),
        "unhelpful refusal: {err}"
    );
    // And the file is untouched — refusing is not corrupting.
    assert_eq!(user_version(&path), Database::SCHEMA_VERSION + 7);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn a_partly_migrated_database_fails_verification_instead_of_being_stamped() {
    // A v0 database whose earlier best-effort migration lost a column: the
    // stamp would say "current" and every read of that column would then
    // fail forever, one query at a time. `verify_schema` is what turns
    // that into one loud failure at open.
    let path = tempfile_path();
    drop(Database::open(&path).unwrap());
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        // Rebuild `sessions` without the provenance columns, then rewind
        // the stamp — and neuter the ALTER that would re-add them by
        // leaving a legacy-shaped table the batch cannot fix, which is
        // what a genuinely partial migration looks like.
        conn.execute_batch(
            "DROP TABLE IF EXISTS sessions;
                 CREATE TABLE sessions (
                     session_id TEXT PRIMARY KEY,
                     project_path TEXT NOT NULL,
                     project_name TEXT NOT NULL,
                     created_at INTEGER NOT NULL,
                     status TEXT NOT NULL DEFAULT 'in_review'
                 );",
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 0i64).unwrap();
    }
    // The v1 step's own ALTERs repair this one, which is the correct
    // outcome — so assert the repair happened AND the version advanced.
    match Database::open(&path) {
        Ok(db) => drop(db),
        Err(e) => panic!("a repairable legacy shape must open: {e}"),
    }
    assert_eq!(user_version(&path), Database::SCHEMA_VERSION);
    let conn = rusqlite::Connection::open(&path).unwrap();
    let mut stmt = conn.prepare("PRAGMA table_info(sessions)").unwrap();
    let columns: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    for required in ["attach_state", "updated_at", "run_state", "backend", "model"] {
        assert!(columns.contains(&required.to_string()), "{required} not restored");
    }
    drop(stmt);
    drop(conn);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn verify_schema_rejects_a_missing_table() {
    // The cheap half of the guard: a core table absent entirely.
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE sessions (session_id TEXT PRIMARY KEY);
             CREATE TABLE revisions (session_id TEXT);
             CREATE TABLE comments (id TEXT);",
    )
    .unwrap();
    let err = Database::verify_schema(&conn).expect_err("must reject");
    assert!(
        err.to_string().contains("table app_settings is missing"),
        "{err}"
    );
}

#[test]
fn verify_schema_rejects_a_missing_column() {
    // The half that catches a genuinely PARTIAL migration: every table
    // present, but an `ALTER TABLE ADD COLUMN` that silently didn't
    // happen. Built by opening a real database and then removing one
    // column, so the fixture cannot drift from the real schema.
    let path = tempfile_path();
    drop(Database::open(&path).unwrap());
    let conn = rusqlite::Connection::open(&path).unwrap();
    // SQLite ≥3.35 can drop a column; the bundled build is well past that.
    conn.execute_batch("ALTER TABLE sessions DROP COLUMN model;")
        .unwrap();
    let err = Database::verify_schema(&conn).expect_err("must reject");
    assert!(
        err.to_string().contains("sessions.model is missing"),
        "{err}"
    );
    assert!(err.to_string().contains("only partly migrated"), "{err}");
    drop(conn);
    let _ = std::fs::remove_file(&path);
}

/// The run-it batch shipped `comments.research` and `scaled_runs` inside
/// `migrate_v1`, so an existing v4 database never got them and every
/// launch died at "no such column: research". Built from a real database
/// with both removed and the stamp put back to 4: exactly a pre-batch
/// install.
#[test]
fn a_v4_database_gains_the_research_column_and_scaled_runs() {
    let path = tempfile_path();
    drop(Database::open(&path).unwrap());
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "ALTER TABLE comments DROP COLUMN research;
                 DROP TABLE scaled_runs;
                 PRAGMA user_version = 4;",
        )
        .unwrap();
    }
    let db = Database::open(&path).expect("a v4 database must open");
    {
        let conn = db.lock_conn();
        let stamp: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(stamp, Database::SCHEMA_VERSION);
    }
    // The history load that crashed reads the column; the build table works.
    db.load_all().expect("the history load reads the research column");
    drop(db);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn a_v5_database_gains_chat_project_and_changes_metadata() {
    let path = tempfile_path();
    drop(Database::open(&path).unwrap());
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("ALTER TABLE companion_sessions DROP COLUMN project_path; ALTER TABLE companion_messages DROP COLUMN meta; PRAGMA user_version=5;").unwrap();
        Database::verify_schema_at(&conn, 5).unwrap();
        assert!(Database::verify_schema_at(&conn, 6).is_err());
    }
    drop(Database::open(&path).unwrap());
    let conn = Connection::open(&path).unwrap();
    Database::verify_schema_at(&conn, 6).unwrap();
    Database::migrate_v6(&conn).unwrap(); // replay-safe
    drop(conn);
    let _ = std::fs::remove_file(path);
}

/// `thread_messages.mode` is read by every thread load, so a v6 database
/// must gain it at upgrade: the step `migrate_v1`'s own doc asks for, not
/// a line in it.
#[test]
fn a_v6_database_gains_the_thread_mode_column() {
    let path = tempfile_path();
    drop(Database::open(&path).unwrap());
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "INSERT INTO thread_messages (id, session_id, comment_id, role, body, status, created_at)
                   VALUES ('m1', 's1', 'c1', 'user', 'old', 'complete', 1);
                 ALTER TABLE thread_messages DROP COLUMN mode;
                 PRAGMA user_version=6;",
        )
        .unwrap();
        Database::verify_schema_at(&conn, 6).unwrap();
        assert!(Database::verify_schema_at(&conn, 7).is_err());
    }
    let db = Database::open(&path).expect("a v6 database must open");
    let thread = db.load_thread("s1", "c1").expect("the thread load reads the mode column");
    assert_eq!(thread.len(), 1);
    assert_eq!(thread[0].mode, None);
    drop(db);
    assert_eq!(user_version(&path), Database::SCHEMA_VERSION);
    let conn = Connection::open(&path).unwrap();
    Database::verify_schema_at(&conn, 7).unwrap();
    Database::migrate_v7(&conn).unwrap(); // replay-safe
    drop(conn);
    let _ = std::fs::remove_file(path);
}

/// The browse chat's model pick is a v8 step, not a `migrate_v1` edit: a
/// database already past v1 never runs v1 again.
#[test]
fn a_v7_database_gains_the_browse_chat_pick() {
    let path = tempfile_path();
    drop(Database::open(&path).unwrap());
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "INSERT INTO browse_threads (browse_id, claude_session_id) VALUES ('tab', 'sid');
                 INSERT INTO browse_messages (id, browse_id, role, body, status, created_at)
                     VALUES ('reply', 'tab', 'assistant', 'hi', 'complete', 1);
                 ALTER TABLE browse_threads DROP COLUMN backend;
                 ALTER TABLE browse_threads DROP COLUMN model;
                 ALTER TABLE browse_threads DROP COLUMN effort;
                 ALTER TABLE browse_threads DROP COLUMN codex_thread_id;
                 ALTER TABLE browse_threads DROP COLUMN codex_usage;
                 ALTER TABLE browse_messages DROP COLUMN backend;
                 PRAGMA user_version=7;",
        )
        .unwrap();
        Database::verify_schema_at(&conn, 7).unwrap();
        assert!(Database::verify_schema_at(&conn, 8).is_err());
    }
    let db = Database::open(&path).expect("a v7 database must open");
    assert_eq!(user_version(&path), Database::SCHEMA_VERSION);
    // The existing row keeps its session and reads as "never picked", with
    // no Codex thread; its old reply has no provider (it was Claude's).
    assert_eq!(db.get_browse_session("tab").as_deref(), Some("sid"));
    assert_eq!(db.get_browse_harness("tab"), BrowseHarness::default());
    assert_eq!(db.get_browse_codex_thread("tab"), None);
    assert_eq!(db.load_browse_thread("tab").unwrap()[0].backend, None);
    Database::migrate_v8(&db.lock_conn()).unwrap(); // replay-safe
    drop(db);
    let _ = std::fs::remove_file(path);
}

/// The tab a browse message was about is a v9 column: a database at v8
/// gains it, its rows read as "not kept", and the step replays safely.
#[test]
fn a_v8_database_gains_the_browse_message_target() {
    let path = tempfile_path();
    drop(Database::open(&path).unwrap());
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "INSERT INTO browse_messages (id, browse_id, role, body, status, created_at)
                     VALUES ('reply', 'tab', 'assistant', 'hi', 'complete', 1);
                 DROP INDEX idx_browse_messages_target;
                 ALTER TABLE browse_messages DROP COLUMN target_browse_id;
                 PRAGMA user_version=8;",
        )
        .unwrap();
        Database::verify_schema_at(&conn, 8).unwrap();
        assert!(Database::verify_schema_at(&conn, 9).is_err());
    }
    let db = Database::open(&path).expect("a v8 database must open");
    assert_eq!(user_version(&path), Database::SCHEMA_VERSION);
    assert_eq!(db.load_browse_thread("tab").unwrap()[0].target_browse_id, None);
    Database::migrate_v9(&db.lock_conn()).unwrap(); // replay-safe
    drop(db);
    let _ = std::fs::remove_file(path);
}

/// A foreign lineage's forward stamp never ran v9: the column is added
/// anyway (the schema is the authority), and the stamp is left alone.
#[test]
fn a_forward_stamp_gains_the_browse_message_target_without_a_restamp() {
    let path = tempfile_path();
    drop(Database::open(&path).unwrap());
    let foreign = Database::SCHEMA_VERSION + 3;
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "DROP INDEX idx_browse_messages_target;
                 ALTER TABLE browse_messages DROP COLUMN target_browse_id;",
        )
        .unwrap();
        conn.pragma_update(None, "user_version", foreign).unwrap();
    }
    let db = Database::open(&path).expect("a forward stamp missing only our additive column must open");
    assert!(db.load_browse_thread("tab").unwrap().is_empty());
    drop(db);
    assert_eq!(user_version(&path), foreign);
    let _ = std::fs::remove_file(path);
}

/// `/v1/browser/thread?tab=` reads what was discussed about a tab: its own
/// thread and the shared chat's turns sent against it, in time order —
/// never another tab's (BC-22). The shared chat's own thread is unchanged.
#[test]
fn a_tabs_thread_includes_the_shared_chat_turns_about_it() {
    let db = Database::open_in_memory().unwrap();
    let msg = |id: &str, thread: &str, target: Option<&str>, at: i64| BrowseMessage {
        id: id.into(),
        browse_id: thread.into(),
        role: if id.starts_with('u') { "user" } else { "assistant" }.into(),
        body: id.into(),
        status: "complete".into(),
        created_at: at,
        backend: None,
        target_browse_id: target.map(Into::into),
    };
    for row in [
        msg("u-own", "tab-a", Some("tab-a"), 10),
        msg("u-shared-a", "shared", Some("tab-a"), 20),
        msg("a-shared-a", "shared", Some("tab-a"), 30),
        msg("u-shared-b", "shared", Some("tab-b"), 40),
        msg("a-own", "tab-a", Some("tab-a"), 50),
        msg("u-old", "shared", None, 5),
    ] {
        db.insert_browse_message(&row).unwrap();
    }
    let about: Vec<String> = db.load_browse_thread_about("tab-a").unwrap().into_iter().map(|m| m.id).collect();
    assert_eq!(about, ["u-own", "u-shared-a", "a-shared-a", "a-own"]);
    let b: Vec<String> = db.load_browse_thread_about("tab-b").unwrap().into_iter().map(|m| m.id).collect();
    assert_eq!(b, ["u-shared-b"]);
    let shared = db.load_browse_thread("shared").unwrap();
    assert_eq!(shared.len(), 4);
    assert_eq!(shared[1].target_browse_id.as_deref(), Some("tab-a"), "a row keeps the page it was about");
}

/// The browse branch's own build stamped its columns as v7, without the
/// thread mode. Such a database must still open: v8 re-runs v7.
#[test]
fn a_database_stamped_7_by_the_browse_branch_gains_the_thread_mode() {
    let path = tempfile_path();
    drop(Database::open(&path).unwrap());
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("ALTER TABLE thread_messages DROP COLUMN mode; PRAGMA user_version=7;")
            .unwrap();
        assert!(Database::verify_schema_at(&conn, 7).is_err());
    }
    let db = Database::open(&path).expect("a browse-branch v7 database must open");
    assert!(db.load_thread("s1", "c1").unwrap().is_empty());
    drop(db);
    assert_eq!(user_version(&path), Database::SCHEMA_VERSION);
    let _ = std::fs::remove_file(path);
}

#[test]
fn a_browse_chat_pick_outlives_its_session_but_not_its_thread() {
    let db = Database::open_in_memory().unwrap();
    let pick = BrowseHarness {
        backend: Some("claude-code".into()),
        model: Some("opus".into()),
        effort: Some("high".into()),
    };
    assert_eq!(db.get_browse_harness("tab"), BrowseHarness::default());

    // Either write can come first; neither clobbers the other.
    db.set_browse_harness("tab", &pick).unwrap();
    db.set_browse_session("tab", "sid-1").unwrap();
    assert_eq!(db.get_browse_harness("tab"), pick);
    let sonnet = BrowseHarness { model: Some("sonnet".into()), effort: None, ..pick.clone() };
    db.set_browse_harness("tab", &sonnet).unwrap();
    assert_eq!(db.get_browse_session("tab").as_deref(), Some("sid-1"), "a model change resumes the same session");
    assert_eq!(db.get_browse_harness("tab"), sonnet);

    // A context-overflow reset forgets the session only.
    db.clear_browse_session("tab").unwrap();
    assert_eq!(db.get_browse_session("tab"), None);
    assert_eq!(db.get_browse_harness("tab"), sonnet);
    db.set_browse_session("tab", "sid-2").unwrap();
    assert_eq!(db.get_browse_harness("tab"), sonnet);

    // Clear history drops the whole row, pick included.
    db.delete_browse_thread("tab").unwrap();
    assert_eq!(db.get_browse_session("tab"), None);
    assert_eq!(db.get_browse_harness("tab"), BrowseHarness::default());
}

/// Each provider keeps its own resumable id: storing or forgetting the
/// Codex thread never touches the Claude session or the pick, and the
/// reverse. Clear history drops both.
#[test]
fn a_browse_chat_keeps_one_resumable_id_per_provider() {
    let db = Database::open_in_memory().unwrap();
    let pick = BrowseHarness { backend: Some("codex".into()), model: Some("gpt-5.5".into()), effort: None };
    db.set_browse_harness("tab", &pick).unwrap();
    db.set_browse_codex_thread("tab", "thread-1", r#"{"inputTokens":10}"#).unwrap();
    db.set_browse_session("tab", "sid-1").unwrap();
    assert_eq!(db.get_browse_codex_thread("tab").as_deref(), Some("thread-1"));
    assert_eq!(db.get_browse_codex_usage("tab").as_deref(), Some(r#"{"inputTokens":10}"#));
    assert_eq!(db.get_browse_session("tab").as_deref(), Some("sid-1"));
    assert_eq!(db.get_browse_harness("tab"), pick);

    // A Claude context reset leaves the Codex thread; a lost Codex thread
    // leaves the Claude session.
    db.clear_browse_session("tab").unwrap();
    assert_eq!(db.get_browse_codex_thread("tab").as_deref(), Some("thread-1"));
    db.set_browse_session("tab", "sid-2").unwrap();
    db.clear_browse_codex_thread("tab").unwrap();
    assert_eq!(db.get_browse_codex_thread("tab"), None);
    assert_eq!(db.get_browse_codex_usage("tab"), None);
    assert_eq!(db.get_browse_session("tab").as_deref(), Some("sid-2"));
    assert_eq!(db.get_browse_harness("tab"), pick);

    // A reply remembers which provider wrote it.
    db.insert_browse_message(&BrowseMessage {
        id: "a1".into(),
        browse_id: "tab".into(),
        role: "assistant".into(),
        body: "hi".into(),
        status: "complete".into(),
        created_at: 1,
        backend: Some("codex".into()),
        target_browse_id: None,
    })
    .unwrap();
    assert_eq!(db.load_browse_thread("tab").unwrap()[0].backend.as_deref(), Some("codex"));

    db.set_browse_codex_thread("tab", "thread-2", "{}").unwrap();
    db.delete_browse_thread("tab").unwrap();
    assert_eq!(db.get_browse_codex_thread("tab"), None);
    assert_eq!(db.get_browse_session("tab"), None);
}

#[test]
#[ignore = "requires a SQLite backup, never the user's live database"]
fn migrate_real_v5_backup_for_workbench() {
    let source = std::env::var("REDLINE_TEST_V5_DB").expect("set REDLINE_TEST_V5_DB to the disposable SQLite backup");
    let path = tempfile_path();
    std::fs::copy(source, &path).unwrap();
    let conn = Connection::open(&path).unwrap();
    assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 5);
    Database::migrate(&conn).unwrap();
    Database::verify_schema_at(&conn, 6).unwrap();
    drop(conn);
    let _ = std::fs::remove_file(path);
}

#[test]
fn the_migration_list_is_ordered_and_ends_at_the_current_version() {
    let versions: Vec<i64> = Database::MIGRATIONS.iter().map(|(v, _)| *v).collect();
    let mut sorted = versions.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(versions, sorted, "migrations must be ordered and unique");
    assert_eq!(
        versions.last().copied(),
        Some(Database::SCHEMA_VERSION),
        "SCHEMA_VERSION must match the last migration step"
    );
    assert_eq!(versions.first().copied(), Some(1), "steps start at 1");
}

#[test]
fn comment_ids_are_session_scoped() {
    use crate::state::UpdateCommentRequest;

    let db = Arc::new(Database::open_in_memory().unwrap());
    let store = SessionStore::new(db.clone());
    let md = "# A\n\nIntro.\n";
    store.upsert_plan("sess-a", "/tmp/a", md.to_string(), reparse_sections(md), true, false);
    store.upsert_plan("sess-b", "/tmp/b", md.to_string(), reparse_sections(md), true, false);

    let mk = |body: &str| NewCommentRequest {
            id: None,
        kind: CommentKind::Question,
        scope: None,
        anchor_id: "A".to_string(),
        block_id: None,
        structural: None,
        body: body.to_string(),
        edit: None,
        selection: None,
        author: None,
        reviewer: None,
        external_created_at: None,
        share_request_id: None,
        attachments: Vec::new(),
        research: None,
    };

    let a = store
        .add_comment("sess-a", mk("from a"))
        .expect("persist in sess-a");
    // Before the composite PK fix this collided on the global
    // `comments.id` PRIMARY KEY and failed to persist.
    let b = store
        .add_comment("sess-b", mk("from b"))
        .expect("persist in sess-b");
    assert_eq!(a.id, "c-001");
    assert_eq!(b.id, "c-001");

    // Updating sess-a's c-001 must not touch sess-b's c-001.
    store
        .update_comment(
            "sess-a",
            "c-001",
            UpdateCommentRequest {
                body: Some("a edited".to_string()),
                scope: None,
                block_id: None,
                structural: None,
                edit: None,
                selection: None,
            },
        )
        .expect("update sess-a c-001");
    // Reload from the DB so we assert on what was actually persisted,
    // not just in-memory state.
    let store2 = SessionStore::new(db.clone());
    assert_eq!(
        store2.get("sess-a").unwrap().revisions[0].comments[0].body,
        "a edited"
    );
    assert_eq!(
        store2.get("sess-b").unwrap().revisions[0].comments[0].body,
        "from b"
    );

    // Deleting sess-a's c-001 must leave sess-b's c-001 intact.
    assert!(store.delete_comment("sess-a", "c-001"));
    let store3 = SessionStore::new(db.clone());
    assert!(store3.get("sess-a").unwrap().revisions[0]
        .comments
        .is_empty());
    assert_eq!(
        store3.get("sess-b").unwrap().revisions[0].comments.len(),
        1
    );
}

#[test]
fn legacy_global_pk_db_migrates_to_composite() {
    let tmpfile = tempfile_path();

    // Build a database with the OLD schema: `comments.id` is a global
    // PRIMARY KEY, with one pre-existing comment.
    {
        let conn = Connection::open(&tmpfile).unwrap();
        conn.execute_batch(
            r#"
                CREATE TABLE sessions (
                    session_id TEXT PRIMARY KEY,
                    project_path TEXT NOT NULL,
                    project_name TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    status TEXT NOT NULL DEFAULT 'in_review'
                );
                CREATE TABLE revisions (
                    session_id TEXT NOT NULL,
                    version_number INTEGER NOT NULL,
                    received_at INTEGER NOT NULL,
                    raw_plan_markdown TEXT NOT NULL,
                    PRIMARY KEY (session_id, version_number)
                );
                CREATE TABLE comments (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    version_number INTEGER NOT NULL,
                    type TEXT NOT NULL,
                    scope TEXT,
                    anchor_id TEXT NOT NULL,
                    body TEXT NOT NULL,
                    edit_original TEXT,
                    edit_revised TEXT,
                    created_at INTEGER NOT NULL,
                    status TEXT NOT NULL
                );
                INSERT INTO sessions VALUES ('old', '/tmp/old', 'old', 1, 'in_review');
                INSERT INTO revisions VALUES ('old', 1, 1, '# Title\n\nBody.\n');
                INSERT INTO comments
                    (id, session_id, version_number, type, scope, anchor_id,
                     body, edit_original, edit_revised, created_at, status)
                VALUES
                    ('c-001', 'old', 1, 'question', NULL, 'A',
                     'legacy body', NULL, NULL, 1, 'submitted');
                "#,
        )
        .unwrap();
    }

    // Opening through Database::open runs migrate(), which must rebuild
    // `comments` with a composite (session_id, id) primary key.
    let db = Arc::new(Database::open(&tmpfile).unwrap());

    // Composite primary key: exactly two columns participate in the PK.
    {
        let conn = db.conn.lock().unwrap();
        let mut stmt = conn.prepare("PRAGMA table_info(comments)").unwrap();
        let pk_cols: i64 = stmt
            .query_map([], |row| row.get::<_, i64>(5))
            .unwrap()
            .map(|r| r.unwrap())
            .filter(|pk| *pk > 0)
            .count() as i64;
        assert_eq!(pk_cols, 2, "comments should have a composite primary key");
    }

    // The legacy comment is preserved.
    let store = SessionStore::new(db);
    let old = store.get("old").expect("legacy session reloaded");
    assert_eq!(old.revisions[0].comments.len(), 1);
    assert_eq!(old.revisions[0].comments[0].id, "c-001");
    assert_eq!(old.revisions[0].comments[0].body, "legacy body");

    // A brand-new session can now persist its own `c-001` without a
    // UNIQUE constraint violation (the original bug).
    let md = "# T\n\nP.\n";
    store.upsert_plan("fresh", "/tmp/fresh", md.to_string(), reparse_sections(md), true, false);
    let c = store
        .add_comment(
            "fresh",
            NewCommentRequest {
            id: None,
                kind: CommentKind::Question,
                scope: None,
                anchor_id: "T".to_string(),
                block_id: None,
                structural: None,
                body: "new session comment".to_string(),
                edit: None,
                selection: None,
                author: None,
                reviewer: None,
                external_created_at: None,
                share_request_id: None,
                attachments: Vec::new(),
                research: None,
            },
        )
        .expect("fresh session c-001 persists");
    assert_eq!(c.id, "c-001");

    // The post-rebuild fork_session_id / fork_backend columns landed on
    // the rebuilt legacy `comments` table — set/get round-trips on the
    // legacy row.
    let db = store.database();
    assert!(db.get_comment_fork("old", "c-001").is_none());
    db.set_comment_fork("old", "c-001", "fork-legacy", "claude-code")
        .unwrap();
    assert_eq!(
        db.get_comment_fork("old", "c-001"),
        Some(("fork-legacy".to_string(), "claude-code".to_string())),
    );

    let _ = std::fs::remove_file(&tmpfile);
}

// --- Session recency (updated_at) ----------------------------------

#[test]
fn migration_backfills_legacy_updated_at() {
    use crate::state::{AttachState, ReviewSession, SessionStatus};
    let db = Database::open_in_memory().unwrap();
    let mk = |id: &str, created: i64| ReviewSession {
        session_id: id.to_string(),
        project_path: "/repo".to_string(),
        project_name: "repo".to_string(),
        created_at: created,
        revisions: Vec::new(),
        status: SessionStatus::InReview,
        attach_state: AttachState::Idle,
        updated_at: 0,
        run_state: None,
        backend: None,
        model: None,
    effort: None,
    };
    db.upsert_session(&mk("with-rev", 500)).unwrap();
    db.insert_revision(
        "with-rev",
        &crate::state::Revision {
            version_number: 1,
            received_at: 700,
            raw_plan_markdown: "# P".to_string(),
            sections: Vec::new(),
            comments: Vec::new(),
            thread_start: true,
            restored: false,
        },
    )
    .unwrap();
    db.upsert_session(&mk("bare", 300)).unwrap();
    // Simulate rows written by a pre-updated_at build…
    db.zero_updated_at("with-rev");
    db.zero_updated_at("bare");
    // …and re-run the idempotent step: only 0-rows are backfilled. The
    // STEP, not the runner — `migrate()` is a no-op on an already-current
    // database, which is what the version stamp buys.
    {
        let conn = db.conn.lock().unwrap();
        Database::migrate_v1(&conn).unwrap();
    }
    let all = db.load_all().unwrap();
    assert_eq!(all["with-rev"].updated_at, 700); // latest revision time
    assert_eq!(all["bare"].updated_at, 300); // falls back to created_at
}

#[test]
fn thread_message_bumps_session_recency_ordering() {
    let db = Arc::new(Database::open_in_memory().unwrap());
    let store = SessionStore::new(db.clone());
    let md = "# Plan\n\nBody.\n";
    store.upsert_plan("a", "/tmp/a", md.to_string(), reparse_sections(md), true, false);
    store.upsert_plan("b", "/tmp/b", md.to_string(), reparse_sections(md), true, false);
    // Discussion activity lands on the DB directly (fork threads write
    // through Database, not the store); a strictly later stamp must float
    // "a" above "b" after a restart-shaped reload.
    let later = crate::state::now_millis() + 10_000;
    db.insert_thread_message(&ThreadMessage {
        id: "m1".to_string(),
        session_id: "a".to_string(),
        comment_id: "c-001".to_string(),
        role: "user".to_string(),
        body: "hi".to_string(),
        status: "complete".to_string(),
        created_at: later,
        attachments: Vec::new(),
        mode: None,
    })
    .unwrap();
    let reloaded = SessionStore::new(db.clone());
    let list = reloaded.list();
    assert_eq!(list[0].session_id, "a");
    assert_eq!(list[0].updated_at, later);
}

#[test]
fn comment_bumps_in_memory_updated_at() {
    use crate::state::CommentKind;
    let db = Arc::new(Database::open_in_memory().unwrap());
    let store = SessionStore::new(db);
    let md = "# Plan\n\nBody.\n";
    store.upsert_plan("s", "/tmp/s", md.to_string(), reparse_sections(md), true, false);
    let before = store.get("s").unwrap().updated_at;
    let c = store
        .add_comment(
            "s",
            NewCommentRequest {
                id: None,
                kind: CommentKind::Feedback,
                scope: None,
                anchor_id: "A".to_string(),
                block_id: None,
                structural: None,
                body: "b".to_string(),
                edit: None,
                selection: None,
                author: None,
                reviewer: None,
                external_created_at: None,
                share_request_id: None,
                attachments: Vec::new(),
                research: None,
            },
        )
        .unwrap();
    let after = store.get("s").unwrap().updated_at;
    assert!(after >= before);
    assert!(after >= c.created_at);
}

// --- Queue-status lifecycle (send-while-busy) ------------------------

/// One queue-capable row per surface, so the generic helpers are proven
/// against every table in the kind map they claim to cover.
fn seed_queueable_rows(db: &Database) {
    db.insert_browse_message(&crate::state::BrowseMessage {
        id: "qb".to_string(),
        browse_id: "tab-1".to_string(),
        role: "user".to_string(),
        body: "queued browse".to_string(),
        status: "queued".to_string(),
        created_at: 10,
        backend: None,
        target_browse_id: None,
    })
    .unwrap();
    // The retired linked discussion's table keeps the rows it holds, and
    // its kind stays mapped for them; nothing writes one now, so seed raw.
    db.lock_conn()
        .execute(
            "INSERT INTO linked_messages (id, linked_id, role, body, status, created_at)
                 VALUES ('ql', 'l-1', 'user', 'queued linked', 'queued', 10)",
            [],
        )
        .unwrap();
    db.insert_mission_message(&crate::state::MissionMessage {
        id: "qm".to_string(),
        mission_id: "m-1".to_string(),
        role: "user".to_string(),
        body: "queued mission".to_string(),
        status: "queued".to_string(),
        created_at: 10,
    })
    .unwrap();
    db.insert_mem_chat_message(&crate::state::MemChatMessage {
        id: "qc".to_string(),
        thread_id: "memchat".to_string(),
        role: "user".to_string(),
        body: "queued memchat".to_string(),
        status: "queued".to_string(),
        created_at: 10,
    })
    .unwrap();
}

/// The seeded linked rows' statuses, oldest first.
fn linked_statuses(db: &Database) -> Vec<String> {
    let conn = db.read_conn();
    let mut stmt = conn
        .prepare("SELECT status FROM linked_messages WHERE linked_id = 'l-1' ORDER BY created_at, id")
        .unwrap();
    let rows = stmt.query_map([], |row| row.get(0)).unwrap();
    rows.collect::<rusqlite::Result<_>>().unwrap()
}

#[test]
fn set_thread_message_status_flips_across_the_kind_map() {
    let db = Database::open_in_memory().unwrap();
    seed_queueable_rows(&db);
    for (kind, id) in [
        ("browse", "qb"),
        ("linked", "ql"),
        ("mission", "qm"),
        ("memchat", "qc"),
    ] {
        assert!(
            db.set_thread_message_status(kind, id, "complete").unwrap(),
            "{kind} row must flip"
        );
    }
    assert_eq!(db.load_browse_thread("tab-1").unwrap()[0].status, "complete");
    assert_eq!(linked_statuses(&db), ["complete"]);
    assert_eq!(db.load_mission_thread("m-1").unwrap()[0].status, "complete");
    assert_eq!(db.load_mem_chat_thread("memchat").unwrap()[0].status, "complete");
    // A miss and an unknown kind both report false, never error.
    assert!(!db.set_thread_message_status("browse", "nope", "unsent").unwrap());
    assert!(!db.set_thread_message_status("martian", "qb", "unsent").unwrap());
}

#[test]
fn delete_thread_message_removes_the_unqueued_row() {
    let db = Database::open_in_memory().unwrap();
    seed_queueable_rows(&db);
    assert!(db.delete_thread_message("browse", "qb").unwrap());
    assert!(db.load_browse_thread("tab-1").unwrap().is_empty());
    assert!(!db.delete_thread_message("browse", "qb").unwrap(), "already gone");
    assert!(!db.delete_thread_message("martian", "ql").unwrap());
    // The other surfaces' rows are untouched.
    assert_eq!(linked_statuses(&db).len(), 1);
}

#[test]
fn startup_sweep_flips_only_queued_rows_to_unsent() {
    let db = Database::open_in_memory().unwrap();
    seed_queueable_rows(&db);
    // A settled row that the sweep must not touch.
    db.insert_browse_message(&crate::state::BrowseMessage {
        id: "done".to_string(),
        browse_id: "tab-1".to_string(),
        role: "assistant".to_string(),
        body: "landed".to_string(),
        status: "complete".to_string(),
        created_at: 20,
        backend: None,
        target_browse_id: None,
    })
    .unwrap();
    assert_eq!(db.sweep_queued_to_unsent().unwrap(), 4);
    let browse = db.load_browse_thread("tab-1").unwrap();
    assert_eq!(browse[0].status, "unsent");
    assert_eq!(browse[1].status, "complete");
    assert_eq!(linked_statuses(&db), ["unsent"]);
    assert_eq!(db.load_mission_thread("m-1").unwrap()[0].status, "unsent");
    assert_eq!(db.load_mem_chat_thread("memchat").unwrap()[0].status, "unsent");
    // Idempotent: nothing left to flip.
    assert_eq!(db.sweep_queued_to_unsent().unwrap(), 0);
}

#[test]
fn thread_loads_return_queued_rows_in_send_order() {
    let db = Database::open_in_memory().unwrap();
    for (id, status, ts) in [
        ("u1", "complete", 1),
        ("a1", "complete", 2),
        ("q1", "queued", 3),
        ("q2", "queued", 4),
    ] {
        db.insert_browse_message(&crate::state::BrowseMessage {
            id: id.to_string(),
            browse_id: "tab-1".to_string(),
            role: "user".to_string(),
            body: id.to_string(),
            status: status.to_string(),
            created_at: ts,
            backend: None,
            target_browse_id: None,
        })
        .unwrap();
    }
    let rows = db.load_browse_thread("tab-1").unwrap();
    assert_eq!(
        rows.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        vec!["u1", "a1", "q1", "q2"],
        "queued rows load with the thread, oldest-first"
    );
}

// --- Agent Seat activity (Seat Assignment digest) -------------------

#[test]
fn seat_activity_counts_assistant_turns_in_and_out_of_window() {
    let db = Database::open_in_memory().unwrap();
    {
        let conn = db.conn.lock().unwrap();
        let mut msg = |table: &str, id: &str, owner: &str, role: &str, ts: i64| {
            conn.execute(
                &format!(
                    "INSERT INTO {table} (id, {owner_col}, role, body, status, created_at)
                         VALUES (?1, ?2, ?3, 'x', 'done', ?4)",
                    owner_col = owner
                ),
                params![id, "o1", role, ts],
            )
            .unwrap();
        };
        // Two assistant turns inside the window, one outside, one user turn
        // that must never count.
        msg("browse_messages", "b1", "browse_id", "assistant", 5_000);
        msg("browse_messages", "b2", "browse_id", "assistant", 6_000);
        msg("browse_messages", "b3", "browse_id", "assistant", 100);
        msg("browse_messages", "b4", "browse_id", "user", 5_500);
        msg("mission_messages", "m1", "mission_id", "assistant", 7_000);
    }
    let acts = db.seat_activity(1_000);
    let by = |seat: &str| {
        acts.iter()
            .find(|a| a.seat == seat)
            .unwrap_or_else(|| panic!("no {seat} row"))
            .clone()
    };
    let browse = by("browse");
    assert_eq!(browse.turns_window, 2, "only in-window assistant turns");
    assert_eq!(browse.turns_total, 3, "all-time excludes the user turn");
    assert_eq!(browse.last_ts, Some(6_000));
    assert_eq!(by("mission").turns_total, 1);
    // A seat with no rows reports zero rather than vanishing — the digest
    // needs the explicit "never ran" signal.
    let voice = by("voice");
    assert_eq!((voice.turns_window, voice.turns_total), (0, 0));
    assert_eq!(voice.last_ts, None);
}

#[test]
fn seat_activity_splits_plan_threads_from_drafter_comment_threads() {
    let db = Database::open_in_memory().unwrap();
    {
        let conn = db.conn.lock().unwrap();
        // A drafter comment thread: its comment_id resolves to draft_comments.
        conn.execute(
            "INSERT INTO draft_comments (id, draft_id, body, created_at)
                 VALUES ('dc1', 'd1', 'note', 100)",
            [],
        )
        .unwrap();
        let mut tm = |id: &str, comment: &str, ts: i64| {
            conn.execute(
                "INSERT INTO thread_messages
                       (id, session_id, comment_id, role, body, status, created_at)
                     VALUES (?1, 's1', ?2, 'assistant', 'x', 'done', ?3)",
                params![id, comment, ts],
            )
            .unwrap();
        };
        tm("t1", "dc1", 5_000); // drafter comment thread
        tm("t2", "plan-c1", 5_000); // plan sidecar thread
        tm("t3", "plan-c2", 5_000);
    }
    let acts = db.seat_activity(1_000);
    let count = |seat: &str| acts.iter().find(|a| a.seat == seat).unwrap().turns_total;
    assert_eq!(count("fork_drafter"), 1);
    assert_eq!(count("fork_plan"), 2, "unmatched comment_ids are plan threads");
}

#[test]
fn ai_review_activity_counts_agent_runs_not_reviews_the_user_opened() {
    let db = Database::open_in_memory().unwrap();
    {
        let conn = db.conn.lock().unwrap();
        // Three code reviews opened by hand…
        for i in 0..3 {
            conn.execute(
                "INSERT INTO review_sessions (review_id, repo_path, source, round, created_at)
                     VALUES (?1, '/repo', 'diff', 1, 5000)",
                params![format!("r{i}")],
            )
            .unwrap();
        }
        // …but the AI reviewer only ever ran on one of them, writing four
        // findings. Counting rows would say 4; counting reviews says 1.
        let mut ann = |id: &str, review: &str, source: &str, ts: i64| {
            conn.execute(
                "INSERT INTO review_annotations
                       (id, review_id, round, file_path, side, start_line, end_line,
                        kind, body, quoted_text, status, created_at, source)
                     VALUES (?1, ?2, 1, 'a.rs', 'new', 1, 1, 'comment', 'b', 'q', 'open', ?3, ?4)",
                params![id, review, ts, source],
            )
            .unwrap();
        };
        ann("a1", "r0", "ai", 5_000);
        ann("a2", "r0", "ai", 5_100);
        ann("a3", "r0", "ai", 5_200);
        ann("a4", "r0", "ai", 5_300);
        // A human comment on another review must never count as an AI run.
        ann("a5", "r1", "user", 5_400);
    }
    let acts = db.seat_activity(1_000);
    let ai = acts.iter().find(|a| a.seat == "ai_review").unwrap();
    assert_eq!(ai.turns_total, 1, "one AI run, not four findings or three reviews");
    assert_eq!(ai.turns_window, 1);
    assert_eq!(ai.last_ts, Some(5_300));
}

#[test]
fn keeper_is_not_inferred_from_per_prompt_compaction_events() {
    let db = Database::open_in_memory().unwrap();
    {
        let conn = db.conn.lock().unwrap();
        // Compaction events are written one per prompt — and the
        // deterministic fallback writes them even when no agent spawned.
        for i in 0..40 {
            conn.execute(
                "INSERT INTO ledger_events
                       (seq, ts, kind, author, payload_hash, prev_hash, entry_hash)
                     VALUES (?1, 5000, 'compaction', 'redline', 'p', 'x', ?2)",
                params![i + 1, format!("h{i}")],
            )
            .unwrap();
        }
    }
    // The seat must NOT claim 40 turns for an agent that may never have run.
    assert!(
        !db.seat_activity(1_000).iter().any(|a| a.seat == "keeper"),
        "keeper has no per-run record, so it must report nothing at all"
    );
}

#[test]
fn prompt_length_by_surface_reports_median_and_p90() {
    let db = Database::open_in_memory().unwrap();
    {
        let conn = db.conn.lock().unwrap();
        for (i, len) in [10usize, 20, 30, 40, 100].iter().enumerate() {
            conn.execute(
                "INSERT INTO prompts (ts, source, origin, surface, role, body, body_hash)
                     VALUES (1, 'hook', 'internal', 'browse', 'user', ?1, ?2)",
                params!["x".repeat(*len), format!("h{i}")],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO prompts (ts, source, origin, surface, role, body, body_hash)
                 VALUES (1, 'hook', 'internal', 'plan', 'user', 'xxx', 'hplan')",
            [],
        )
        .unwrap();
    }
    let rows = db.prompt_length_by_surface().unwrap();
    // Heaviest surface first.
    assert_eq!(rows[0].0, "browse");
    assert_eq!(rows[0].1, 5);
    assert_eq!(rows[0].2, 30, "median of 10/20/30/40/100");
    assert_eq!(rows[0].3, 100, "p90 lands on the long tail");
    assert_eq!(rows[1].0, "plan");
}

#[test]
fn seat_stats_upsert_accumulates_and_never_regresses_last_run() {
    let db = Database::open_in_memory().unwrap();
    assert!(db.get_seat_stat("browse").is_none());
    db.upsert_seat_stat("browse", Some(1_000), 2).unwrap();
    let s = db.get_seat_stat("browse").unwrap();
    assert_eq!(s.last_run_at, Some(1_000));
    assert_eq!(s.items_filed, 2);
    // Deltas accumulate; a None run timestamp leaves the old one standing.
    db.upsert_seat_stat("browse", None, 3).unwrap();
    let s = db.get_seat_stat("browse").unwrap();
    assert_eq!(s.last_run_at, Some(1_000));
    assert_eq!(s.items_filed, 5);
    // An out-of-order (older) run must not move last_run_at backwards.
    db.upsert_seat_stat("browse", Some(500), 0).unwrap();
    assert_eq!(db.get_seat_stat("browse").unwrap().last_run_at, Some(1_000));
    db.upsert_seat_stat("browse", Some(2_000), 0).unwrap();
    assert_eq!(db.get_seat_stat("browse").unwrap().last_run_at, Some(2_000));
    // A stats-only seat with no run yet keeps a NULL last_run_at.
    db.upsert_seat_stat("keeper", None, 1).unwrap();
    assert_eq!(db.get_seat_stat("keeper").unwrap().last_run_at, None);
    assert_eq!(db.list_seat_stats().unwrap().len(), 2);
}

#[test]
fn seat_burn_adds_per_day_and_rolls_up_both_axes() {
    let db = Database::open_in_memory().unwrap();
    db.add_seat_burn("browse", "2026-08-11", 100, 50, 10, 5, 1).unwrap();
    db.add_seat_burn("browse", "2026-08-11", 20, 10, 2, 1, 1).unwrap();
    db.add_seat_burn("browse", "2026-08-12", 7, 3, 0, 0, 1).unwrap();
    db.add_seat_burn("voice", "2026-08-12", 1, 1, 1, 1, 1).unwrap();

    let by_seat = db.seat_burn_totals_by_seat().unwrap();
    assert_eq!(by_seat.len(), 2);
    let browse = by_seat.iter().find(|r| r.seat.as_deref() == Some("browse")).unwrap();
    assert_eq!(browse.input_tokens, 127);
    assert_eq!(browse.output_tokens, 63);
    assert_eq!(browse.cache_read_tokens, 12);
    assert_eq!(browse.cache_creation_tokens, 6);
    assert_eq!(browse.spawns, 3);
    assert_eq!(browse.day, None, "seat rollup aggregates the day axis");

    let by_day = db.seat_burn_totals_by_day(30).unwrap();
    assert_eq!(by_day.len(), 2);
    assert_eq!(by_day[0].day.as_deref(), Some("2026-08-12"), "newest first");
    assert_eq!(by_day[0].input_tokens, 8, "both seats' burn folds in");
    assert_eq!(by_day[0].spawns, 2);
    assert_eq!(by_day[1].day.as_deref(), Some("2026-08-11"));
    assert_eq!(by_day[1].input_tokens, 120);
}

/// The overnight queue's ready frontier: approved AND never run. Every
/// other combination — in review, aborted, or any `run_state` at all
/// (including the parked `awaiting_review`) — stays out, so a queued run
/// can never re-queue itself.
// --- T0.1: the friction metric measures OPEN comments -------------------

/// A shared fixture for the friction metric: one `in_review` session
/// carrying one comment in each of the six lifecycle states, with the
/// `resolution_accepted_at` column deliberately populated the way the live
/// DB populates it (only on an explicit reviewer Accept).
fn friction_fixture() -> Database {
    use crate::state::{
        AttachState, Comment, CommentKind, CommentStatus, Resolution, ReviewSession, Revision,
        SessionStatus,
    };
    let db = Database::open_in_memory().unwrap();
    db.upsert_session(&ReviewSession {
        session_id: "s-friction".to_string(),
        project_path: "/repo/friction".to_string(),
        project_name: "friction".to_string(),
        created_at: 1_000,
        revisions: Vec::new(),
        status: SessionStatus::InReview,
        attach_state: AttachState::Idle,
        updated_at: 1_000,
        run_state: None,
        backend: None,
        model: None,
    effort: None,
    })
    .unwrap();
    db.insert_revision(
        "s-friction",
        &Revision {
            version_number: 1,
            received_at: 1_000,
            raw_plan_markdown: "# plan".to_string(),
            sections: Vec::new(),
            comments: Vec::new(),
            thread_start: true,
            restored: false,
        },
    )
    .unwrap();

    let mk = |id: &str, status: CommentStatus, resolution: Option<Resolution>| Comment {
        id: id.to_string(),
        kind: CommentKind::Feedback,
        scope: None,
        anchor_id: "A.1".to_string(),
        block_id: None,
        body: format!("body for {id}"),
        structural: None,
        edit: None,
        created_at: 1_000,
        status,
        resolution,
        selection: None,
        reopen_note: None,
        reopen_history: Vec::new(),
        actionable: false,
        author: None,
        agent_state: None,
        reviewer: None,
        external_created_at: None,
        share_request_id: None,
        attachments: Vec::new(),
        research: None,
    };
    let answered = |accepted_at: Option<i64>| {
        Some(Resolution {
            body: "done".to_string(),
            appeared_in_version: 2,
            accepted_at,
        })
    };

    // Open — each of these is still waiting on somebody.
    db.insert_comment("s-friction", 1, &mk("c-001", CommentStatus::Draft, None)).unwrap();
    db.insert_comment("s-friction", 1, &mk("c-002", CommentStatus::Submitted, None)).unwrap();
    db.insert_comment("s-friction", 1, &mk("c-003", CommentStatus::Reopened, None)).unwrap();
    // Closed. `c-004` is the population that broke the old metric: Claude
    // answered it, the reviewer never pressed Accept, so
    // `resolution_accepted_at` stays NULL forever.
    db.insert_comment("s-friction", 1, &mk("c-004", CommentStatus::Resolved, answered(None)))
        .unwrap();
    db.insert_comment(
        "s-friction",
        1,
        &mk("c-005", CommentStatus::Accepted, answered(Some(2_000))),
    )
    .unwrap();
    db.insert_comment("s-friction", 1, &mk("c-006", CommentStatus::Withdrawn, None)).unwrap();
    db
}

/// The metric counts comments whose STATUS is open, not comments the
/// reviewer never formally accepted. Six comments, one per state, must
/// score 3 — draft + submitted + reopened.
#[test]
fn in_review_friction_counts_open_statuses_not_acceptance() {
    let db = friction_fixture();

    let rows = db.in_review_friction().unwrap();
    assert_eq!(rows.len(), 1, "one in_review session");
    let (session_id, project_name, created_at, unresolved) = rows[0].clone();
    assert_eq!(session_id, "s-friction");
    assert_eq!(project_name, "friction");
    assert_eq!(created_at, 1_000);
    assert_eq!(
        unresolved, 3,
        "draft + submitted + reopened are open; resolved, accepted and \
             withdrawn are not"
    );

    // The regression this test exists for: with the old
    // `resolution_accepted_at IS NULL` rule the same fixture scored 5,
    // because everything except the explicitly-accepted `c-005` matched.
    let by_never_accepted: i64 = {
        let conn = db.conn.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM comments
                   WHERE session_id = 's-friction' AND resolution_accepted_at IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap()
    };
    assert_eq!(by_never_accepted, 5, "the old rule over-counted by 2");
    assert!(
        unresolved < by_never_accepted,
        "the open-status rule must be strictly tighter than the acceptance rule"
    );
}

/// A resolved comment the reviewer never accepted is answered, not
/// friction — the single most common shape in the live DB.
#[test]
fn in_review_friction_ignores_resolved_but_never_accepted() {
    use crate::state::CommentStatus;
    let db = friction_fixture();

    // Withdraw the three open ones; nothing open is left.
    for id in ["c-001", "c-002", "c-003"] {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "UPDATE comments SET status = ?2 WHERE session_id = 's-friction' AND id = ?1",
            params![id, CommentStatus::Withdrawn.as_str()],
        )
        .unwrap();
    }

    let rows = db.in_review_friction().unwrap();
    assert_eq!(
        rows[0].3, 0,
        "a session whose only remaining comments are resolved/accepted/withdrawn \
             carries no friction"
    );
}

// --- T0.2: the connection mutex survives a panic ------------------------

/// The failure this guard exists for, reproduced end to end. A panic
/// inside a closure that holds the connection guard poisons the mutex;
/// before `lock_conn()` every later lock unwrapped that `PoisonError` and
/// panicked — forever — while the window stayed up and looked alive.
///
/// The source invariant that keeps production off the bare `.unwrap()`
/// lives in `tests/poison_guard.rs`.
#[test]
fn poisoned_conn_recovers() {
    let db = Arc::new(Database::open_in_memory().unwrap());
    db.set_setting("before", "written").unwrap();

    // Exactly the production shape: the guard is live while the stack
    // unwinds, which is what poisons the mutex.
    let poisoner = Arc::clone(&db);
    let joined = std::thread::spawn(move || {
        let _guard = poisoner.conn.lock().unwrap();
        panic!("deliberate panic inside a db closure");
    })
    .join();
    assert!(joined.is_err(), "the helper thread must actually have panicked");
    assert!(db.conn.is_poisoned(), "and the mutex must actually be poisoned");

    // Every one of these goes through lock_conn().
    assert_eq!(
        db.get_setting("before").as_deref(),
        Some("written"),
        "data written before the poison is still readable"
    );
    db.set_setting("after", "still writable").unwrap();
    assert_eq!(
        db.get_setting("after").as_deref(),
        Some("still writable"),
        "and writes still land"
    );

    // A method with a different shape (prepare + query_map), to prove the
    // recovery is at the lock and not in one lucky code path.
    assert!(
        db.in_review_friction().is_ok(),
        "prepared-statement reads work on a recovered connection too"
    );
}

// --- T1.1: agent-authored comments converge instead of duplicating -------

/// Fixture shared by the convergence tests: a one-revision session and a
/// request builder whose author is the only thing that varies.
fn convergence_store() -> SessionStore {
    let store = make_store();
    let md = "# Plan\n\nBody.\n";
    store.upsert_plan("s", "/tmp/s", md.to_string(), reparse_sections(md), true, false);
    store
}

fn agent_req(
    author: Option<&str>,
    kind: crate::state::CommentKind,
    body: &str,
) -> NewCommentRequest {
    NewCommentRequest {
        id: None,
        kind,
        scope: None,
        anchor_id: "A".to_string(),
        block_id: Some("rl:blk-1".to_string()),
        structural: None,
        body: body.to_string(),
        edit: None,
        selection: None,
        author: author.map(|a| a.to_string()),
        reviewer: None,
        external_created_at: None,
        share_request_id: None,
        attachments: Vec::new(),
        research: None,
    }
}

/// A replayed agent finding returns the comment that already exists —
/// same id, same timestamp — instead of minting a ghost. Everything that
/// makes it a *different* finding still mints.
#[test]
fn agent_duplicate_feedback_converges_to_existing_comment() {
    use crate::state::CommentKind;
    let store = convergence_store();

    let first = store
        .add_comment("s", agent_req(Some("voice"), CommentKind::Feedback, "anchor drifts"))
        .unwrap();
    assert_eq!(first.id, "c-001");

    // The replay: byte-identical, and with incidental whitespace, since
    // the payload is re-serialized on the way back in.
    let replay = store
        .add_comment("s", agent_req(Some("voice"), CommentKind::Feedback, "anchor drifts"))
        .unwrap();
    assert_eq!(replay.id, "c-001", "a replayed agent finding must converge");
    assert_eq!(replay.created_at, first.created_at, "and keep its identity");
    let padded = store
        .add_comment("s", agent_req(Some("voice"), CommentKind::Feedback, "  anchor drifts \n"))
        .unwrap();
    assert_eq!(padded.id, "c-001", "convergence is on the trimmed body");

    // Different body, different author, different kind — all new work.
    let other_body = store
        .add_comment("s", agent_req(Some("voice"), CommentKind::Feedback, "other point"))
        .unwrap();
    assert_eq!(other_body.id, "c-002");
    let other_author = store
        .add_comment(
            "s",
            agent_req(Some("claude-code"), CommentKind::Feedback, "anchor drifts"),
        )
        .unwrap();
    assert_eq!(other_author.id, "c-003", "two agents can raise the same point");
    let other_kind = store
        .add_comment("s", agent_req(Some("voice"), CommentKind::Question, "anchor drifts"))
        .unwrap();
    assert_eq!(other_kind.id, "c-004", "a question is not the feedback");

    let total = store.get("s").unwrap().revisions.last().unwrap().comments.len();
    assert_eq!(total, 4);
}

/// The exact `5f85766f` shape: submit, restore the session, then let the
/// agent replay its feedback against the restored revision. The originals
/// were carried forward, not deleted, so the replay must find them.
#[test]
fn agent_duplicate_across_restored_revision_converges() {
    use crate::state::CommentKind;
    let store = convergence_store();

    let original = store
        .add_comment("s", agent_req(Some("voice"), CommentKind::Feedback, "anchor drifts"))
        .unwrap();
    store.mark_submitted("s");
    store.restore_latest("s").expect("restored");

    let replay = store
        .add_comment("s", agent_req(Some("voice"), CommentKind::Feedback, "anchor drifts"))
        .unwrap();
    assert_eq!(
        replay.id, original.id,
        "the restored revision hides the original from the UI, not from the store"
    );

    let session = store.get("s").unwrap();
    let ghosts = session
        .revisions
        .iter()
        .flat_map(|r| r.comments.iter())
        .filter(|c| c.body == "anchor drifts")
        .count();
    assert_eq!(ghosts, 1, "one finding, one comment, across every revision");
}

/// Once a finding is answered it is finished business — an agent raising
/// the same point afterwards is genuinely new, and must not be swallowed.
#[test]
fn agent_duplicate_after_resolution_mints_a_new_comment() {
    use crate::state::CommentKind;
    let store = convergence_store();

    let first = store
        .add_comment("s", agent_req(Some("voice"), CommentKind::Feedback, "anchor drifts"))
        .unwrap();
    store.mark_submitted("s");
    let mut resolutions = HashMap::new();
    resolutions.insert(first.id.clone(), "fixed in v2".to_string());
    store.attach_resolutions("s", &resolutions, 1);

    let again = store
        .add_comment("s", agent_req(Some("voice"), CommentKind::Feedback, "anchor drifts"))
        .unwrap();
    assert_ne!(again.id, first.id, "a resolved comment does not absorb a fresh raise");
}

/// Human comments keep minting. A reviewer typing the same correction on
/// two blocks is legitimate and happens in the live record — the
/// convergence rule is scoped to agent authors on purpose.
#[test]
fn human_identical_edits_still_mint_new_ids() {
    use crate::state::{CommentKind, EditPayload};
    let store = convergence_store();

    let mut req = || {
        let mut r = agent_req(None, CommentKind::Edit, "tighten this");
        r.edit = Some(EditPayload {
            original: "the thing".to_string(),
            revised: "this".to_string(),
        });
        r
    };
    let a = store.add_comment("s", req()).unwrap();
    let b = store.add_comment("s", req()).unwrap();
    assert_eq!(a.id, "c-001");
    assert_eq!(b.id, "c-002", "identical human edits stay distinct comments");

    // And an agent edit with a DIFFERENT payload is different work even
    // when the prose body matches.
    let mut agent_edit = || {
        let mut r = agent_req(Some("claude-code"), CommentKind::Edit, "tighten this");
        r.edit = Some(EditPayload {
            original: "the thing".to_string(),
            revised: "this".to_string(),
        });
        r
    };
    let c = store.add_comment("s", agent_edit()).unwrap();
    let c_replay = store.add_comment("s", agent_edit()).unwrap();
    assert_eq!(c_replay.id, c.id, "an identical agent edit converges");
    let mut different = agent_edit();
    different.edit = Some(EditPayload {
        original: "the thing".to_string(),
        revised: "that".to_string(),
    });
    let d = store.add_comment("s", different).unwrap();
    assert_ne!(d.id, c.id, "a different revised text is a different edit");
}

// --- T1.3: the resolution ledger emits stay wired -----------------------

/// Accepting a resolution is a decision, and the ledger row must point at
/// the COMMENT — not the session — or the Timeline can't tell which
/// finding was accepted.
#[test]
fn accepting_a_resolution_records_a_comment_scoped_ledger_event() {
    use crate::state::CommentKind;
    let db = Arc::new(Database::open_in_memory().unwrap());
    let store = SessionStore::new(db.clone());
    let md = "# Plan\n\nBody.\n";
    store.upsert_plan("s", "/tmp/s", md.to_string(), reparse_sections(md), true, false);

    let c = store
        .add_comment("s", agent_req(None, CommentKind::Feedback, "narrow this"))
        .unwrap();
    store.mark_submitted("s");
    let mut resolutions = HashMap::new();
    resolutions.insert(c.id.clone(), "narrowed".to_string());
    store.attach_resolutions("s", &resolutions, 2);
    assert!(store.accept_resolution("s", &c.id));

    let events = db.list_session_events("s").unwrap();
    let resolution: Vec<_> = events.iter().filter(|e| e.kind == "resolution").collect();
    assert_eq!(resolution.len(), 1, "exactly one resolution event");
    assert_eq!(resolution[0].ref_kind.as_deref(), Some("comment"));
    assert_eq!(
        resolution[0].ref_id.as_deref(),
        Some(c.id.as_str()),
        "the event names the accepted comment"
    );
    assert_eq!(resolution[0].session_id.as_deref(), Some("s"));
}

/// Reopening is the other half of the loop and is scoped the same way.
#[test]
fn reopening_records_a_comment_scoped_reopen_event() {
    use crate::state::CommentKind;
    let db = Arc::new(Database::open_in_memory().unwrap());
    let store = SessionStore::new(db.clone());
    let md = "# Plan\n\nBody.\n";
    store.upsert_plan("s", "/tmp/s", md.to_string(), reparse_sections(md), true, false);

    let c = store
        .add_comment("s", agent_req(None, CommentKind::Feedback, "narrow this"))
        .unwrap();
    store.mark_submitted("s");
    let mut resolutions = HashMap::new();
    resolutions.insert(c.id.clone(), "narrowed".to_string());
    store.attach_resolutions("s", &resolutions, 2);
    assert!(store.reopen_resolution("s", &c.id, Some("still too broad"), false));

    let events = db.list_session_events("s").unwrap();
    let reopen: Vec<_> = events.iter().filter(|e| e.kind == "reopen").collect();
    assert_eq!(reopen.len(), 1, "exactly one reopen event");
    assert_eq!(reopen[0].ref_kind.as_deref(), Some("comment"));
    assert_eq!(
        reopen[0].ref_id.as_deref(),
        Some(c.id.as_str()),
        "a session-scoped reopen would lose which finding came back"
    );
}

// --- T1.2: the one-time ghost repair ------------------------------------

/// Reproduces the live `5f85766f` shape and every near miss it must leave
/// alone: the ghost flips, a human duplicate doesn't, an agent duplicate
/// with no answered twin doesn't, and a second run is a no-op.
#[test]
fn ghost_repair_withdraws_only_superseded_agent_rows() {
    use crate::state::{
        AttachState, Comment, CommentKind, CommentStatus, Resolution, ReviewSession, Revision,
        SessionStatus,
    };
    let db = Database::open_in_memory().unwrap();
    db.upsert_session(&ReviewSession {
        session_id: "s-ghost".to_string(),
        project_path: "/repo/ghost".to_string(),
        project_name: "ghost".to_string(),
        created_at: 1,
        revisions: Vec::new(),
        status: SessionStatus::InReview,
        attach_state: AttachState::Idle,
        updated_at: 1,
        run_state: None,
        backend: None,
        model: None,
    effort: None,
    })
    .unwrap();
    db.insert_revision(
        "s-ghost",
        &Revision {
            version_number: 1,
            received_at: 1,
            raw_plan_markdown: "# plan".to_string(),
            sections: Vec::new(),
            comments: Vec::new(),
            thread_start: true,
            restored: false,
        },
    )
    .unwrap();

    let mk = |id: &str, author: Option<&str>, status: CommentStatus, body: &str, at: i64| {
        Comment {
            id: id.to_string(),
            kind: CommentKind::Feedback,
            scope: None,
            anchor_id: "A".to_string(),
            block_id: None,
            body: body.to_string(),
            structural: None,
            edit: None,
            created_at: at,
            status,
            resolution: matches!(status, CommentStatus::Resolved | CommentStatus::Accepted)
                .then(|| Resolution {
                    body: "answered".to_string(),
                    appeared_in_version: 1,
                    accepted_at: None,
                }),
            selection: None,
            reopen_note: None,
            reopen_history: Vec::new(),
            actionable: false,
            author: author.map(|a| a.to_string()),
            agent_state: None,
            reviewer: None,
            external_created_at: None,
            share_request_id: None,
            attachments: Vec::new(),
            research: None,
        }
    };
    let insert = |c: &Comment| db.insert_comment("s-ghost", 1, c).unwrap();

    // The ghost: agent-authored, submitted, answered later by an identical
    // row. This is the exact 5f85766f pair.
    insert(&mk("c-001", Some("voice"), CommentStatus::Submitted, "anchor drifts", 100));
    insert(&mk("c-002", Some("voice"), CommentStatus::Resolved, "anchor drifts", 200));
    // A human duplicate in the same shape — must survive untouched.
    insert(&mk("c-003", None, CommentStatus::Submitted, "same problem here", 100));
    insert(&mk("c-004", None, CommentStatus::Resolved, "same problem here", 200));
    // An agent duplicate with no ANSWERED twin — still open work.
    insert(&mk("c-005", Some("voice"), CommentStatus::Submitted, "still open", 100));
    insert(&mk("c-006", Some("voice"), CommentStatus::Submitted, "still open", 200));
    // A different agent said the same thing — not the same finding.
    insert(&mk("c-007", Some("claude-code"), CommentStatus::Submitted, "anchor drifts", 100));
    // And the ANSWERED row itself is never touched, in either direction:
    // the later copy is the one that carries the resolution.

    let status_of = |id: &str| -> String {
        let conn = db.conn.lock().unwrap();
        conn.query_row(
            "SELECT status FROM comments WHERE session_id = 's-ghost' AND id = ?1",
            params![id],
            |r| r.get(0),
        )
        .unwrap()
    };

    // `open_in_memory` already ran the migration once and latched the
    // marker, so clear it to exercise the repair against these rows.
    let run_repair = || {
        let conn = db.conn.lock().unwrap();
        Database::repair_superseded_agent_comments(&conn).unwrap();
    };
    {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM app_settings WHERE key = 'repair_ghost_comments_v1'",
            [],
        )
        .unwrap();
    }
    run_repair();

    assert_eq!(status_of("c-001"), "withdrawn", "the ghost is retired");
    assert_eq!(status_of("c-002"), "resolved", "the answered copy is the record");
    assert_eq!(status_of("c-003"), "submitted", "human duplicates are legitimate");
    assert_eq!(status_of("c-004"), "resolved");
    assert_eq!(status_of("c-005"), "submitted", "no answered twin, still open work");
    assert_eq!(status_of("c-006"), "submitted");
    assert_eq!(
        status_of("c-007"),
        "submitted",
        "a different agent raising the same point is a different finding"
    );

    // Resolution data is untouched — the repair only moves `status`.
    let res: Option<String> = {
        let conn = db.conn.lock().unwrap();
        conn.query_row(
            "SELECT resolution_body FROM comments WHERE session_id = 's-ghost' AND id = 'c-002'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    };
    assert_eq!(res.as_deref(), Some("answered"));

    // Exactly-once: a fresh ghost appearing after the marker is latched is
    // NOT swept — T1.1 is what stops new ones, not a recurring sweep.
    insert(&mk("c-008", Some("voice"), CommentStatus::Submitted, "late ghost", 300));
    insert(&mk("c-009", Some("voice"), CommentStatus::Resolved, "late ghost", 400));
    run_repair();
    assert_eq!(status_of("c-008"), "submitted", "the second run is a no-op");

    // And the marker records how many rows moved.
    assert_eq!(
        db.get_setting("repair_ghost_comments_v1").as_deref(),
        Some("1"),
        "the marker carries the repair's own count"
    );
}
