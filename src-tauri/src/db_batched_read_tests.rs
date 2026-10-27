// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! `db.rs`'s `mod batched_read_tests`, moved out verbatim: a `#[path]` child of the
//! same parent, so `use super::*` still resolves as it did inline.

use super::*;

fn seed_prompt(db: &Database, body: &str) -> i64 {
    crate::ledger::record_prompt(
        db,
        crate::ledger::PromptInput {
            source: crate::ledger::PromptSource::Hook,
            origin: crate::ledger::Origin::Redline,
            surface: "pty_plan".to_string(),
            role: crate::ledger::CorpusRole::User,
            user_text: None,
            session_id: Some("s1".to_string()),
            claude_session_id: Some(format!("cs-{body}")),
            mission_id: None,
            project_path: Some("/repo".to_string()),
            body: body.to_string(),
            thread: None,
            author: None,
            model: None,
            model_source: None,
        },
    )
    .unwrap()
    .expect("the prompt must have been recorded")
}

/// The Timeline's filing column, batched. The precedence rule survives:
/// the EARLIEST accepted link wins, exactly as `ORDER BY cl.id LIMIT 1`
/// used to give.
#[test]
fn batched_filing_keeps_earliest_link_precedence() {
    let db = Database::open_in_memory().unwrap();
    let seq = seed_prompt(&db, "wire the loop executor");
    db.seed_class_roots(&[
        ("n-first".into(), "First Home".into(), None),
        ("n-second".into(), "Second Home".into(), None),
    ])
    .unwrap();
    // Two accepted filings on the SAME target; the earlier link id wins.
    for node in ["n-first", "n-second"] {
        db.stage_proposal(
            None,
            &crate::classmem::Proposal::File {
                parent_id: node.into(),
                sub_class: None,
                target_kind: "prompt".into(),
                target_id: seq.to_string(),
                note: None,
                rationale: None,
            },
        )
        .unwrap();
    }
    db.accept_all_pending("yusuf").unwrap();

    let items = db
        .query_ledger_events(&crate::context::LedgerFilters::default())
        .unwrap();
    let row = items.iter().find(|i| i.event.seq == seq).unwrap();
    assert_eq!(row.class_node_id.as_deref(), Some("n-first"));
    assert_eq!(row.class_title.as_deref(), Some("First Home"));
}

/// The batched link decorations must match what the per-link probes gave.
#[test]
fn link_previews_and_supersessions_batch_correctly() {
    let db = Database::open_in_memory().unwrap();
    let a = seed_prompt(&db, "first body");
    let b = seed_prompt(&db, "second body");
    let labels = db.link_previews_for_seqs(&[a, b, 9_999]).unwrap();
    assert_eq!(labels.get(&a).map(String::as_str), Some("first body"));
    assert_eq!(labels.get(&b).map(String::as_str), Some("second body"));
    assert!(labels.get(&9_999).is_none(), "absent seqs are absent");
    // Empty in, empty out — no query, no panic.
    assert!(db.link_previews_for_seqs(&[]).unwrap().is_empty());
    assert!(db.supersessions_for_seqs(&[]).unwrap().is_empty());
}

/// `load_session` must reconstruct exactly what `load_all` did for that
/// one id — the whole point is that the route stopped paying for the rest.
#[test]
fn load_session_matches_load_all_for_one_id() {
    use crate::state::{AttachState, ReviewSession, SessionStatus};
    let db = Database::open_in_memory().unwrap();
    let mk = |id: &str| ReviewSession {
        session_id: id.to_string(),
        project_path: "/repo".to_string(),
        project_name: "repo".to_string(),
        created_at: 500,
        revisions: Vec::new(),
        status: SessionStatus::InReview,
        attach_state: AttachState::Idle,
        updated_at: 500,
        run_state: None,
        backend: None,
        model: None,
    effort: None,
    };
    for id in ["wanted", "other"] {
        db.upsert_session(&mk(id)).unwrap();
        db.insert_revision(
            id,
            &crate::state::Revision {
                version_number: 1,
                received_at: 600,
                raw_plan_markdown: format!("# Plan {id}\n\nDo the thing."),
                sections: Vec::new(),
                comments: Vec::new(),
                thread_start: false,
                restored: false,
            },
        )
        .unwrap();
    }

    let all = db.load_all().unwrap();
    let one = db.load_session("wanted").unwrap().expect("session exists");
    let from_all = all.get("wanted").unwrap();
    assert_eq!(one.session_id, from_all.session_id);
    assert_eq!(one.revisions.len(), from_all.revisions.len());
    assert_eq!(
        one.revisions[0].raw_plan_markdown,
        from_all.revisions[0].raw_plan_markdown
    );
    assert_eq!(one.revisions[0].sections.len(), from_all.revisions[0].sections.len());
    // …and it does NOT drag the other session along.
    assert_eq!(all.len(), 2);
    assert!(db.load_session("nope").unwrap().is_none());
}

/// The incremental verify must agree with the full walk, keep agreeing as
/// the chain grows, and fall back to the full walk when its anchor can't
/// be trusted.
#[test]
fn incremental_chain_verify_tracks_the_full_walk() {
    let db = Database::open_in_memory().unwrap();
    // Empty chain: both agree, and the anchor is established.
    assert!(db.verify_ledger_chain_incremental().unwrap().ok);

    seed_prompt(&db, "one");
    seed_prompt(&db, "two");
    let full = db.verify_ledger_chain().unwrap();
    let inc = db.verify_ledger_chain_incremental().unwrap();
    assert!(inc.ok);
    assert_eq!(inc.head_hash, full.head_hash);
    assert_eq!(inc.checked, full.checked);

    // Grow it; the suffix walk keeps up.
    seed_prompt(&db, "three");
    let full = db.verify_ledger_chain().unwrap();
    let inc = db.verify_ledger_chain_incremental().unwrap();
    assert!(inc.ok);
    assert_eq!(inc.head_hash, full.head_hash);
    assert_eq!(inc.checked, full.checked);

    // A no-growth call is a pure anchor hit and still reports the head.
    let again = db.verify_ledger_chain_incremental().unwrap();
    assert!(again.ok);
    assert_eq!(again.head_hash, full.head_hash);

    // Corruption in the SUFFIX — the part the incremental walk actually
    // reads — must be caught exactly as the full walk catches it.
    seed_prompt(&db, "four");
    {
        let conn = db.conn.lock().unwrap();
        conn.execute("UPDATE ledger_events SET ts = ts + 1 WHERE seq = 4", [])
            .unwrap();
    }
    assert!(!db.verify_ledger_chain().unwrap().ok);
    let broken = db.verify_ledger_chain_incremental().unwrap();
    assert!(!broken.ok);
    assert_eq!(broken.first_bad_seq, Some(4));
}

/// The documented blind spot, pinned as a test so nobody later mistakes
/// the incremental verify for the full one: a retroactive edit to an
/// ALREADY-VERIFIED row slips past it. The 6h `ledger-backup` deep walk is
/// what catches that, which is why it stays wired up.
#[test]
fn incremental_verify_cannot_see_retroactive_tampering() {
    let db = Database::open_in_memory().unwrap();
    seed_prompt(&db, "one");
    seed_prompt(&db, "two");
    seed_prompt(&db, "three");
    // Anchor on the verified head.
    assert!(db.verify_ledger_chain_incremental().unwrap().ok);

    // Tamper with an old row, leaving its stored entry_hash alone.
    {
        let conn = db.conn.lock().unwrap();
        conn.execute("UPDATE ledger_events SET ts = ts + 1 WHERE seq = 1", [])
            .unwrap();
    }
    assert!(
        !db.verify_ledger_chain().unwrap().ok,
        "the deep walk catches it"
    );
    assert!(
        db.verify_ledger_chain_incremental().unwrap().ok,
        "the incremental walk does NOT — this is the stated trade, not a bug"
    );
}

/// A garbage anchor must not be trusted — the verify falls back to the
/// full walk and re-anchors rather than reporting a chain it never read.
#[test]
fn incremental_verify_falls_back_on_a_bad_anchor() {
    let db = Database::open_in_memory().unwrap();
    seed_prompt(&db, "one");
    seed_prompt(&db, "two");
    assert!(db.verify_ledger_chain_incremental().unwrap().ok);

    // An anchor pointing past the head (a rewound chain) and one whose
    // hash no longer matches both have to re-verify from scratch.
    // The anchor lives in the store's own `polis_meta` since Session A3.
    db.set_meta(PolisStore::VERIFY_LAST_SEQ, "9999").unwrap();
    assert!(db.verify_ledger_chain_incremental().unwrap().ok);
    assert_eq!(
        db.meta(PolisStore::VERIFY_LAST_SEQ).unwrap().as_deref(),
        Some("2"),
        "the fallback re-anchors on the real head"
    );

    db.set_meta(PolisStore::VERIFY_HEAD_HASH, &"0".repeat(64))
        .unwrap();
    let v = db.verify_ledger_chain_incremental().unwrap();
    assert!(v.ok);
    assert_eq!(v.checked, 2, "it walked the whole chain, not a suffix");
}
