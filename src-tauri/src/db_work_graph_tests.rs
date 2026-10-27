// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! `db.rs`'s `mod work_graph_tests`, moved out verbatim: a `#[path]` child of the
//! same parent, so `use super::*` still resolves as it did inline.

use super::*;
use crate::ledger::EventKind;
use crate::work::WorkItem;
use std::sync::Arc;

fn item(id: &str, now: i64) -> WorkItem {
    WorkItem {
        id: id.to_string(),
        title: format!("item {id}"),
        body: None,
        status: "open".to_string(),
        priority: 2,
        kind: "task".to_string(),
        assignee: None,
        claimed_at: None,
        lease_expires_at: None,
        closed_at: None,
        close_reason: None,
        defer_until: None,
        origin_kind: None,
        origin_id: None,
        project_path: None,
        pinned: false,
        created_at: now,
        updated_at: now,
    }
}

/// Every ready-CTE test below goes through here, so each one also pins
/// `count_ready_work_items` (the memory pill's count) to the page's length
/// — across blocked, deferred, cyclic and lease-expired shapes.
fn ready_ids(db: &Database, now: i64) -> Vec<String> {
    let mut ids: Vec<String> = db
        .list_ready_work_items(None, now, 50)
        .unwrap()
        .into_iter()
        .map(|i| i.id)
        .collect();
    assert_eq!(
        db.count_ready_work_items(None, now).unwrap(),
        ids.len() as i64,
        "work_ready_count must equal list_ready_work_items().len()"
    );
    ids.sort();
    ids
}

// --- (a) ready-CTE semantics -----------------------------------------

#[test]
fn ready_hides_a_blocked_item_until_its_blocker_closes() {
    let db = Database::open_in_memory().unwrap();
    let now = 1_000_000;
    db.insert_work_item(&item("rl-blkr", now)).unwrap();
    db.insert_work_item(&item("rl-tgt", now)).unwrap();
    db.insert_work_edge("rl-blkr", "rl-tgt", "blocks", None, now)
        .unwrap();
    // The unclosed blocker hides the target; the blocker itself is ready.
    assert_eq!(ready_ids(&db, now), vec!["rl-blkr"]);
    // Blocker closes → the target appears.
    assert!(db.close_work_item("rl-blkr", Some("done"), now).unwrap());
    assert_eq!(ready_ids(&db, now), vec!["rl-tgt"]);
    // A dangling blocks edge (from-item row never existed) does NOT
    // block: there is no item left to close (schema law — no FKs).
    db.insert_work_edge("rl-ghost", "rl-tgt", "blocks", None, now)
        .unwrap();
    assert_eq!(ready_ids(&db, now), vec!["rl-tgt"]);
    // A non-blocks edge from an open item does not block either.
    db.insert_work_item(&item("rl-rel", now)).unwrap();
    db.insert_work_edge("rl-rel", "rl-tgt", "relates-to", None, now)
        .unwrap();
    assert_eq!(ready_ids(&db, now), vec!["rl-rel", "rl-tgt"]);
    // CLAIMED and HELD blockers still block — the CTE rule is
    // `b.status != 'closed'`, not `== 'open'`.
    db.insert_work_item(&item("rl-cblk", now)).unwrap();
    db.insert_work_item(&item("rl-tgt2", now)).unwrap();
    db.insert_work_edge("rl-cblk", "rl-tgt2", "blocks", None, now)
        .unwrap();
    assert!(db
        .claim_work_item("rl-cblk", "agent-a", now, Some(now + 10_000))
        .unwrap());
    let mut held = item("rl-hblk", now);
    held.status = "held".to_string();
    db.insert_work_item(&held).unwrap();
    db.insert_work_edge("rl-hblk", "rl-tgt2", "blocks", None, now)
        .unwrap();
    assert!(
        !ready_ids(&db, now).contains(&"rl-tgt2".to_string()),
        "a claimed + a held blocker both stand — the target stays hidden"
    );
    // Closing the claimed one is not enough: the held one still blocks.
    assert!(db.close_work_item("rl-cblk", Some("done"), now).unwrap());
    assert!(
        !ready_ids(&db, now).contains(&"rl-tgt2".to_string()),
        "the held blocker alone still hides the target"
    );
    // Both closed → the target appears.
    assert!(db.close_work_item("rl-hblk", Some("done"), now).unwrap());
    assert!(ready_ids(&db, now).contains(&"rl-tgt2".to_string()));
}

#[test]
fn ready_terminates_and_answers_sanely_on_a_parent_child_cycle() {
    let db = Database::open_in_memory().unwrap();
    let now = 1_000_000;
    // Two items in a parent-child CYCLE, one of them deferred.
    let mut a = item("rl-cyc-a", now);
    a.defer_until = Some(now + 60_000);
    db.insert_work_item(&a).unwrap();
    db.insert_work_item(&item("rl-cyc-b", now)).unwrap();
    db.insert_work_edge("rl-cyc-a", "rl-cyc-b", "parent-child", None, now)
        .unwrap();
    db.insert_work_edge("rl-cyc-b", "rl-cyc-a", "parent-child", None, now)
        .unwrap();
    db.insert_work_item(&item("rl-solo", now)).unwrap();
    // The query RETURNS (`UNION` dedupes, so the recursive walk
    // terminates on the cycle) with sane content: both cycle members sit
    // beneath the deferred one, the free item is ready.
    assert_eq!(ready_ids(&db, now), vec!["rl-solo"]);
    // The defer passes → the whole cycle surfaces.
    assert_eq!(
        ready_ids(&db, now + 60_000),
        vec!["rl-cyc-a", "rl-cyc-b", "rl-solo"]
    );
}

#[test]
fn unclosed_list_filters_inside_the_limit_and_edges_read_in_one_batch() {
    let db = Database::open_in_memory().unwrap();
    let now = 1_000_000;
    // More OLD closed rows than the bound, then live items created later.
    for i in 0..60i64 {
        let mut it = item(&format!("rl-old{i}"), now - 1_000 + i);
        it.status = "closed".to_string();
        it.closed_at = Some(now);
        db.insert_work_item(&it).unwrap();
    }
    db.insert_work_item(&item("rl-live-a", now)).unwrap();
    db.insert_work_item(&item("rl-live-b", now + 1)).unwrap();
    db.insert_work_edge("rl-live-a", "rl-live-b", "blocks", None, now)
        .unwrap();
    // The closed filter sits INSIDE the limit: a bound smaller than the
    // closed backlog still returns every live item, no closed ones.
    let items = db.list_unclosed_work_items(50).unwrap();
    let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(ids, vec!["rl-live-a", "rl-live-b"]);
    // ONE batched edges read over those ids returns each edge once.
    let owned: Vec<String> = items.iter().map(|i| i.id.clone()).collect();
    let edges = db.list_work_edges_touching_any(&owned, 50).unwrap();
    assert_eq!(edges.len(), 1);
    assert_eq!(edges[0].edge_type, "blocks");
    assert_eq!(edges[0].from_id, "rl-live-a");
    // No ids → no read at all.
    assert!(db.list_work_edges_touching_any(&[], 50).unwrap().is_empty());
}

#[test]
fn find_unclosed_distinguishes_no_match_from_a_db_fault() {
    let db = Database::open_in_memory().unwrap();
    let now = 1_000_000;
    // A real no-match is Ok(None), never an error.
    assert!(db
        .find_unclosed_work_item("ghost", None, None)
        .unwrap()
        .is_none());
    let mut it = item("rl-idem", now);
    it.origin_kind = Some("test".to_string());
    db.insert_work_item(&it).unwrap();
    assert!(db
        .find_unclosed_work_item("test", None, None)
        .unwrap()
        .is_some());
    // A genuine DB fault surfaces as Err — and the producer path SKIPS
    // the filing on it instead of degrading idempotency to best-effort.
    {
        let conn = db.conn.lock().unwrap();
        conn.execute_batch("ALTER TABLE work_items RENAME TO work_items_gone")
            .unwrap();
    }
    assert!(db.find_unclosed_work_item("test", None, None).is_err());
    assert!(
        db.file_produced_work_item(
            "t", None, "task", "open", 2, "test", None, None, None, "tester",
        )
        .is_err(),
        "filing must refuse (not duplicate) when the lookup faults"
    );
    {
        let conn = db.conn.lock().unwrap();
        conn.execute_batch("ALTER TABLE work_items_gone RENAME TO work_items")
            .unwrap();
    }
    // The fault healed → nothing was filed during it.
    assert_eq!(db.list_work_items(None, None, 50).unwrap().len(), 1);
}

#[test]
fn ready_hides_a_deferred_item_until_its_time_arrives() {
    let db = Database::open_in_memory().unwrap();
    let now = 1_000_000;
    let mut d = item("rl-dfr", now);
    d.defer_until = Some(now + 5_000);
    db.insert_work_item(&d).unwrap();
    assert!(ready_ids(&db, now).is_empty(), "still deferred");
    // Boundary: `defer_until <= now` is ready.
    assert_eq!(ready_ids(&db, now + 5_000), vec!["rl-dfr"]);
}

#[test]
fn ready_hides_descendants_of_a_deferred_ancestor() {
    let db = Database::open_in_memory().unwrap();
    let now = 1_000_000;
    // Deferred parent → open child → open grandchild, plus a free sibling.
    let mut p = item("rl-par", now);
    p.defer_until = Some(now + 60_000);
    db.insert_work_item(&p).unwrap();
    db.insert_work_item(&item("rl-par.1", now)).unwrap();
    db.insert_work_item(&item("rl-par.1.1", now)).unwrap();
    db.insert_work_item(&item("rl-free", now)).unwrap();
    db.insert_work_edge("rl-par", "rl-par.1", "parent-child", None, now)
        .unwrap();
    db.insert_work_edge("rl-par.1", "rl-par.1.1", "parent-child", None, now)
        .unwrap();
    // The child is open and undeferred itself, but its ANCESTOR is
    // deferred — the recursive walk hides the whole subtree.
    assert_eq!(ready_ids(&db, now), vec!["rl-free"]);
    // The parent's defer passes → the whole chain surfaces at once.
    assert_eq!(
        ready_ids(&db, now + 60_000),
        vec!["rl-free", "rl-par", "rl-par.1", "rl-par.1.1"]
    );
}

// --- (b) the claim race ----------------------------------------------

#[test]
fn competing_claims_yield_exactly_one_winner() {
    let db = Arc::new(Database::open_in_memory().unwrap());
    let now = 1_000_000;
    db.insert_work_item(&item("rl-race", now)).unwrap();
    let mut handles = Vec::new();
    for agent in ["agent-a", "agent-b"] {
        let db = Arc::clone(&db);
        handles.push(std::thread::spawn(move || {
            db.claim_work_item("rl-race", agent, now, Some(now + 10_000))
                .unwrap()
        }));
    }
    let wins: Vec<bool> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(
        wins.iter().filter(|w| **w).count(),
        1,
        "exactly one competing claim may win"
    );
    let it = db.get_work_item("rl-race").unwrap();
    assert_eq!(it.status, "claimed");
    assert!(
        matches!(it.assignee.as_deref(), Some("agent-a") | Some("agent-b")),
        "the row belongs to whichever claimer won"
    );
    assert_eq!(it.lease_expires_at, Some(now + 10_000));
}

// --- (c) lease expiry ------------------------------------------------

#[test]
fn an_expired_lease_returns_the_item_to_open_and_ready() {
    let db = Database::open_in_memory().unwrap();
    let now = 1_000_000;
    db.insert_work_item(&item("rl-lease", now)).unwrap();
    assert!(db
        .claim_work_item("rl-lease", "agent-a", now, Some(now + 1_000))
        .unwrap());
    assert!(ready_ids(&db, now).is_empty(), "claimed ⇒ not ready");
    // Lease still live → nothing expires.
    assert_eq!(db.expire_work_leases(now + 500).unwrap(), 0);
    // Boundary is STRICT (`lease_expires_at < now`, not `<=`): at
    // exactly t == lease_expires_at nothing expires either.
    assert_eq!(db.expire_work_leases(now + 1_000).unwrap(), 0);
    assert_eq!(db.get_work_item("rl-lease").unwrap().status, "claimed");
    // Lease lapsed → the claim clears wholesale.
    let later = now + 2_000;
    assert_eq!(db.expire_work_leases(later).unwrap(), 1);
    let it = db.get_work_item("rl-lease").unwrap();
    assert_eq!(it.status, "open");
    assert!(it.assignee.is_none());
    assert!(it.claimed_at.is_none());
    assert!(it.lease_expires_at.is_none());
    assert_eq!(it.updated_at, later);
    // …and the item is ready + claimable again (far-future lease so the
    // sweep below only ever considers the open-ended claim).
    assert_eq!(ready_ids(&db, later), vec!["rl-lease"]);
    assert!(db
        .claim_work_item("rl-lease", "agent-b", later, Some(later + 10_000_000))
        .unwrap());
    // An open-ended claim (NULL lease) never expires.
    db.insert_work_item(&item("rl-forever", now)).unwrap();
    assert!(db.claim_work_item("rl-forever", "agent-c", now, None).unwrap());
    assert_eq!(db.expire_work_leases(now + 1_000_000).unwrap(), 0);
    assert_eq!(db.get_work_item("rl-forever").unwrap().status, "claimed");
}

// --- (d) lifecycle events keep the chain green ------------------------

#[test]
fn file_claim_close_events_append_and_keep_chain_green() {
    let db = Database::open_in_memory().unwrap();
    let now = 1_000_000;
    db.insert_work_item(&item("rl-led", now)).unwrap();
    assert!(crate::ledger::record_work_event(
        &db,
        EventKind::WorkFile,
        "rl-led",
        Some("filer"),
        None,
        now
    )
    .unwrap()
    .is_some());
    assert!(db
        .claim_work_item("rl-led", "agent-a", now + 1, Some(now + 3_600_000))
        .unwrap());
    assert!(crate::ledger::record_work_event(
        &db,
        EventKind::WorkClaim,
        "rl-led",
        Some("agent-a"),
        None,
        now + 1
    )
    .unwrap()
    .is_some());
    assert!(db.close_work_item("rl-led", Some("done"), now + 2).unwrap());
    assert!(crate::ledger::record_work_event(
        &db,
        EventKind::WorkClose,
        "rl-led",
        Some("agent-a"),
        Some("done"),
        now + 2
    )
    .unwrap()
    .is_some());
    // The whole lifecycle is on the chain and the chain verifies.
    let n: i64 = {
        let conn = db.conn.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM ledger_events
                 WHERE kind IN ('work_file', 'work_claim', 'work_close')
                   AND ref_kind = 'work_item' AND ref_id = 'rl-led'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    };
    assert_eq!(n, 3);
    assert!(db.verify_ledger_chain().unwrap().ok, "chain intact");
    // Close-exactly-once: a second close is a no-op conflict and the row
    // keeps its first close_reason/closed_at.
    assert!(!db.close_work_item("rl-led", Some("again"), now + 9).unwrap());
    let it = db.get_work_item("rl-led").unwrap();
    assert_eq!(it.closed_at, Some(now + 2));
    assert_eq!(it.close_reason.as_deref(), Some("done"));
    assert!(db.verify_ledger_chain().unwrap().ok);
}

// --- (e) provenance outlives the origin -------------------------------

#[test]
fn deleting_the_origin_row_leaves_the_item_standing_and_ready() {
    let db = Database::open_in_memory().unwrap();
    let now = 1_000_000;
    db.upsert_plan_run("X", "{}", None, false).unwrap();
    let mut it = item("rl-orph", now);
    it.origin_kind = Some("plan_run".to_string());
    it.origin_id = Some("X".to_string());
    db.insert_work_item(&it).unwrap();
    // The origin dies — provenance is a TEXT breadcrumb, never a foreign
    // key, so nothing may cascade (the direct regression test for the
    // old CASCADE defect).
    assert!(db.delete_plan_run("X").unwrap());
    assert!(db.get_plan_run("X").is_none());
    let survivor = db.get_work_item("rl-orph").expect("item outlives origin");
    assert_eq!(survivor.origin_kind.as_deref(), Some("plan_run"));
    assert_eq!(survivor.origin_id.as_deref(), Some("X"));
    assert_eq!(ready_ids(&db, now), vec!["rl-orph"], "still ready");
}

// --- (f) the state-plane boundary guard --------------------------------

/// BOUNDARY GUARD — mirrors the include_str! style of
/// `every_known_event_has_a_tap_beside_its_emit_site`: the work graph is
/// a state plane (tables, queries, route handlers). `work.rs` may never
/// name the seat-spawn chokepoint symbol nor spawn a process; execution
/// engines live elsewhere and talk to the plane over the routes. The
/// needles live HERE so the scanned file stays clean.
#[test]
fn work_state_plane_never_names_the_spawn_chokepoint_or_spawns() {
    let work = include_str!("work.rs");
    for needle in ["claude_command_for_seat", "Command::new", "spawn("] {
        assert_eq!(
            work.matches(needle).count(),
            0,
            "work.rs must contain zero occurrences of `{needle}` — \
                 the work graph is a state plane, never an execution engine"
        );
    }
}
