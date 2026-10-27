// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! `db.rs`'s `mod prompt_fts_tests`, moved out verbatim: a `#[path]` child of the
//! same parent, so `use super::*` still resolves as it did inline.

use super::*;

fn seed(db: &Database, body: &str) -> i64 {
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
    .unwrap()
}

fn prompt_id_for(db: &Database, seq: i64) -> i64 {
    let conn = db.conn.lock().unwrap();
    conn.query_row(
        "SELECT prompt_id FROM ledger_events WHERE seq = ?1",
        params![seq],
        |r| r.get(0),
    )
    .unwrap()
}

/// The index must follow a body through its whole life: indexed on write,
/// re-indexed to the gist on compaction (released words genuinely stop
/// matching), and dropped on delete.
#[test]
fn prompts_fts_survives_compaction_and_forget() {
    let db = Database::open_in_memory().unwrap();
    let seq = seed(&db, "wire the loop executor before the demo");
    seed(&db, "an unrelated widget migration");

    // Insert trigger: searchable immediately.
    let hits = db.search_prompts_fts("executor", 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].seq, seq);

    // Compaction: the gist becomes the searchable text…
    let pid = prompt_id_for(&db, seq);
    db.compact_prompt_body(pid, "gist: the loop executor decision", "cold", "agent", "keeper")
        .unwrap();
    assert_eq!(
        db.search_prompts_fts("decision", 10).unwrap().len(),
        1,
        "the gist's words are searchable after compaction"
    );
    // …and the RELEASED words are gone from the index. "executor" survives
    // only because the gist happens to repeat it; "demo" did not.
    assert!(
        db.search_prompts_fts("demo", 10).unwrap().is_empty(),
        "released words must stop matching — that is what forgetting means"
    );

    // Explicit forget replaces the body with the sentinel.
    let pid2 = prompt_id_for(&db, 2);
    db.compact_prompt_body(pid2, "[forgotten]", "forget", "deterministic", "yusuf")
        .unwrap();
    assert!(db.search_prompts_fts("widget", 10).unwrap().is_empty());

    // The index agrees with itself.
    let conn = db.conn.lock().unwrap();
    conn.execute("INSERT INTO prompts_fts(prompts_fts) VALUES('integrity-check')", [])
        .expect("prompts_fts integrity-check must pass");
}

/// The `?q=` route filters through FTS when the query tokenizes, and falls
/// back to a bound LIKE when it doesn't — either way it returns rows, in
/// the route's own seq order.
#[test]
fn context_prompts_selects_fts_or_falls_back_to_like() {
    let db = Database::open_in_memory().unwrap();
    seed(&db, "wire the loop executor");
    seed(&db, "unrelated widget migration");
    seed(&db, "a second loop change");

    let find = |q: &str| {
        db.list_context_prompts(&crate::context::PromptFilters {
            substring: Some(q.to_string()),
            limit: 50,
            ..Default::default()
        })
        .unwrap()
    };
    // FTS path: token match, and the route's ascending seq order holds.
    let loops = find("loop");
    assert_eq!(loops.len(), 2);
    assert!(loops[0].seq < loops[1].seq, "seq ordering is unchanged");
    // FTS is word-based: a query of pure punctuation has no tokens and
    // must fall through to LIKE rather than erroring.
    assert!(find("!!!").is_empty(), "the LIKE fallback matched nothing");
    assert_eq!(find("widget").len(), 1);
    // A term that only appears mid-word is an honest FTS miss, not a crash.
    assert!(find("idge").is_empty());
}

/// An injection-shaped query can only ever fail to match.
#[test]
fn prompt_search_neutralizes_fts_operators() {
    let db = Database::open_in_memory().unwrap();
    seed(&db, "wire the loop executor");
    // FTS5 operators are quoted into literals by `sanitize_fts_query`.
    assert!(db.search_prompts_fts("loop OR widget*", 10).unwrap().len() <= 1);
    assert!(db.search_prompts_fts("\"", 10).unwrap().is_empty());
    assert!(db.search_prompts_fts("loop NEAR(x)", 10).unwrap().len() <= 1);
}
