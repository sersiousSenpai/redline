// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! `db.rs`'s `mod query_plan_guards`, moved out verbatim: a `#[path]` child of the
//! same parent, so `use super::*` still resolves as it did inline.

use super::*;

/// Assert the planner reaches every named table through an index. The
/// table name is matched to a word boundary — `SCAN prompts_fts VIRTUAL
/// TABLE INDEX` is an FTS MATCH lookup, not a scan of `prompts`.
fn assert_indexed(db: &Database, what: &str, sql: &str, tables: &[&str]) {
    let plan = db.explain_query_plan(sql).expect("EXPLAIN failed");
    for t in tables {
        let scanned = plan.split(" | ").any(|step| {
            step == format!("SCAN {t}") || step.starts_with(&format!("SCAN {t} "))
        });
        assert!(
            !scanned,
            "{what}: `{t}` is a full table SCAN — the retrieval hot path must \
                 stay indexed.\n  plan: {plan}"
        );
    }
    assert!(
        plan.contains("USING INDEX") || plan.contains("USING COVERING INDEX"),
        "{what}: the planner picked no index at all.\n  plan: {plan}"
    );
}

/// The Timeline's filing probe — "which accepted class is this target filed
/// under?" — runs once per page row. It reads `class_links` in the
/// target→node direction, which `idx_class_links_node` cannot serve.
#[test]
fn timeline_filing_probe_uses_the_target_index() {
    let db = Database::open_in_memory().unwrap();
    assert_indexed(
        &db,
        "timeline filing probe",
        "SELECT cl.node_id, cn.title, MIN(cl.id) FROM class_links cl
             JOIN class_nodes cn ON cn.id = cl.node_id
             WHERE cl.status = 'accepted'
               AND cl.target_kind IN ('prompt', 'decision', 'revision', 'note')
               AND cl.target_id IN ('1', '2')
             GROUP BY cl.target_id",
        &["class_links"],
    );
}

/// `/v1/context/prompts?q=` — the exact statement the route builds. The FTS
/// filter narrows `prompts` first, so the join runs prompts→ledger, and
/// without `idx_ledger_prompt` that direction scans the whole chain per
/// matching prompt. This is the query that used to be a LIKE cross-scan.
#[test]
fn context_prompts_search_uses_fts_and_the_prompt_index() {
    let db = Database::open_in_memory().unwrap();
    let sql = "SELECT le.seq FROM prompts p
             JOIN ledger_events le ON le.prompt_id = p.id
             WHERE 1 = 1
               AND p.id IN (SELECT rowid FROM prompts_fts WHERE prompts_fts MATCH '\"x\"')
             ORDER BY le.seq ASC LIMIT 10";
    assert_indexed(&db, "context prompts search", sql, &["ledger_events", "prompts"]);
    let plan = db.explain_query_plan(sql).unwrap();
    assert!(
        plan.contains("prompts_fts"),
        "the search must go through the FTS index, not a body scan.\n  plan: {plan}"
    );
}

/// The answer pack's bm25 arm drives from the FTS index.
#[test]
fn prompt_search_drives_from_the_fts_index() {
    let db = Database::open_in_memory().unwrap();
    let plan = db
        .explain_query_plan(
            "SELECT le.seq FROM prompts_fts
                 JOIN prompts p ON p.id = prompts_fts.rowid
                 JOIN ledger_events le ON le.prompt_id = p.id
                 WHERE prompts_fts MATCH '\"x\"' AND le.kind = 'prompt'
                 ORDER BY bm25(prompts_fts) LIMIT 10",
        )
        .unwrap();
    assert!(
        !plan.split(" | ").any(|s| s.starts_with("SCAN prompts ")),
        "the prompt table must be reached by rowid from the index.\n  plan: {plan}"
    );
    assert!(plan.contains("prompts_fts"), "plan: {plan}");
}

/// The Timeline's own search box — the last `LIKE '%…%'` full scan on the
/// surface, and the one the user drives directly.
///
/// What must be true: the match set comes from the index (once, as a
/// materialized list), and `prompts` is reached by rowid rather than
/// scanned. What must NOT be asserted: that `ledger_events` is untouched.
/// The Timeline is `ORDER BY le.seq DESC LIMIT n` over the whole chain, so
/// SQLite walks the seq b-tree backwards and stops at the limit — that walk
/// IS the ordering, and driving from the FTS index instead would mean
/// sorting by relevance, which is precisely the thing the design law
/// forbids here. The win is that the walk no longer reads a 6.3 KB body per
/// row to run a LIKE against it.
#[test]
fn timeline_q_drives_from_the_fts_index() {
    let db = Database::open_in_memory().unwrap();
    let sql = "SELECT le.seq FROM ledger_events le
             LEFT JOIN prompts p ON p.id = le.prompt_id
             WHERE 1 = 1
               AND p.id IN (SELECT rowid FROM prompts_fts WHERE prompts_fts MATCH '\"x\"')
             ORDER BY le.seq DESC LIMIT 100";
    let plan = db.explain_query_plan(sql).unwrap();
    assert!(
        plan.contains("prompts_fts"),
        "the Timeline's ?q= must ride the index, not scan every body.\n  plan: {plan}"
    );
    assert!(
        plan.contains("LIST SUBQUERY"),
        "the index probe must be materialized once, not re-run per row.\n  plan: {plan}"
    );
    assert!(
        !plan.split(" | ").any(|s| s == "SCAN p" || s.starts_with("SCAN p ")),
        "`prompts` must be reached by rowid, never scanned.\n  plan: {plan}"
    );
    assert!(
        !plan.contains("USE TEMP B-TREE"),
        "the seq order must come from the index, never a sort.\n  plan: {plan}"
    );
}

/// The grep arm must ride the trigram index. Without one there is no
/// candidate set at all and `LIKE '%…%'` degenerates into a 7 MB scan under
/// the connection lock — which is exactly why a bare `regexp` function was
/// rejected in favour of this shape.
#[test]
fn grep_drives_from_the_trigram_index() {
    let db = Database::open_in_memory().unwrap();
    let plan = db
        .explain_query_plan(
            "SELECT le.seq FROM prompts_grep
                 JOIN prompts p ON p.id = prompts_grep.rowid
                 JOIN ledger_events le ON le.prompt_id = p.id AND le.kind = 'prompt'
                 WHERE prompts_grep.fts_text LIKE '%needle%' ESCAPE '\\'
                 ORDER BY le.seq DESC LIMIT 30",
        )
        .unwrap();
    assert!(
        plan.contains("prompts_grep VIRTUAL TABLE INDEX"),
        "the LIKE must be answered by the trigram index.\n  plan: {plan}"
    );
    assert!(
        !plan.split(" | ").any(|s| s == "SCAN p" || s.starts_with("SCAN p ")),
        "`prompts` must be reached by rowid, never scanned.\n  plan: {plan}"
    );
}

/// Node resolution rides `class_nodes_fts`, not a LIKE over the catalog.
#[test]
fn class_node_match_drives_from_the_fts_index() {
    let db = Database::open_in_memory().unwrap();
    let plan = db
        .explain_query_plan(
            "SELECT n.id FROM class_nodes_fts
                 JOIN class_nodes n ON n.rowid = class_nodes_fts.rowid
                 WHERE class_nodes_fts MATCH '\"loop\"'
                 ORDER BY -bm25(class_nodes_fts, 5.0, 1.0) DESC LIMIT 5",
        )
        .unwrap();
    assert!(plan.contains("class_nodes_fts"), "plan: {plan}");
    assert!(
        !plan.split(" | ").any(|s| s.starts_with("SCAN class_nodes ")
            || s == "SCAN class_nodes"),
        "the catalog must be reached by rowid from its index.\n  plan: {plan}"
    );
}

/// The session spine (`/v1/context/sessions/:id/history`).
#[test]
fn session_events_use_the_session_index() {
    let db = Database::open_in_memory().unwrap();
    assert_indexed(
        &db,
        "session events",
        "SELECT seq FROM ledger_events WHERE session_id = 'abc' ORDER BY seq ASC",
        &["ledger_events"],
    );
}

/// The activity ribbon's date range.
#[test]
fn ledger_ts_range_uses_the_ts_index() {
    let db = Database::open_in_memory().unwrap();
    assert_indexed(
        &db,
        "ledger ts range",
        "SELECT seq FROM ledger_events WHERE ts >= 1 AND ts <= 2",
        &["ledger_events"],
    );
}

/// `compaction_stats` runs on every memory-status poll; the partial index
/// turns it into an index-only scan over the compacted set instead of a
/// walk of every prompt body in the lake.
#[test]
fn compaction_stats_uses_the_partial_index() {
    let db = Database::open_in_memory().unwrap();
    let plan = db
        .explain_query_plan(
            "SELECT COUNT(*), COALESCE(SUM(original_bytes), 0), MAX(compacted_at)
                 FROM prompts WHERE gist IS NOT NULL",
        )
        .unwrap();
    assert!(
        plan.contains("idx_prompts_compacted"),
        "compaction_stats must ride the partial index.\n  plan: {plan}"
    );
}

/// The Timeline's two `user_notes` probes carry no `target_kind <> 'none'`
/// predicate, so the pre-existing PARTIAL unique index could not serve them.
#[test]
fn user_note_probe_uses_the_unfiltered_target_index() {
    let db = Database::open_in_memory().unwrap();
    assert_indexed(
        &db,
        "user note probe",
        "SELECT text FROM user_notes WHERE target_kind = 'ledger_event' AND target_id = '7'",
        &["user_notes"],
    );
}
