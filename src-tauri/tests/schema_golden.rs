// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Golden: the memory schema (the Polis lake, its lexical layer and the class
//! catalog) as a fresh `Database` creates it, every `sqlite_master` row in
//! creation order. This is the referee for the Polis extraction (Program A,
//! docs/polis-extraction.md): Session A2 moves the DDL byte-for-byte into
//! `polis-store`, and this test is what proves "byte-for-byte". Regenerate
//! with `UPDATE_GOLDEN=1 cargo test --test schema_golden` — and if you had to,
//! say why in the commit, because a schema change is a migration.

#[test]
fn memory_schema_golden_is_current() {
    let rendered = redline_lib::memory_schema_sql();
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/memory_schema.sql");
    if std::env::var("UPDATE_GOLDEN").is_ok() {
        std::fs::write(&path, &rendered).expect("write memory schema golden");
        return;
    }
    let committed = std::fs::read_to_string(&path).expect(
        "tests/golden/memory_schema.sql missing — run UPDATE_GOLDEN=1 cargo test --test schema_golden",
    );
    assert_eq!(
        committed, rendered,
        "the memory schema drifted from tests/golden/memory_schema.sql — a memory DDL \
         change is a migration; regenerate with UPDATE_GOLDEN=1 cargo test --test schema_golden \
         and say why"
    );
}

/// The golden must cover every memory table the extraction plan names — a
/// table missing here would move to polis-store unrefereed.
#[test]
fn memory_schema_golden_covers_every_memory_table() {
    let rendered = redline_lib::memory_schema_sql();
    for table in [
        "prompts",
        "ledger_events",
        "class_nodes",
        "class_links",
        "class_proposals",
        "class_runs",
        "supersessions",
        "class_observations",
        "user_notes",
        "plan_exports",
        "browse_events",
        "session_tree",
        "prompt_archive",
        "embeddings",
        // E2 (identity)
        "principals",
        "principal_aliases",
    ] {
        assert!(
            rendered.contains(&format!("-- table {table} (")),
            "memory table `{table}` is not in the schema dump"
        );
    }
    assert!(rendered.contains("USING fts5"), "the lexical layer (FTS5) is part of the schema");
}
