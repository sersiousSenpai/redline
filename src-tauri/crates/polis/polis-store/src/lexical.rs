// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The lexical layer, versioned as one unit: the tokenizer, the generated
//! `fts_text`/`fts_head`/`fts_tail` columns, and the five FTS5 tables with
//! their sync triggers. DERIVED — droppable and rebuildable from the content
//! tables, never on the hash chain — so a tokenizer change is a version bump
//! (`LEXICAL_VERSION`) and the rebuild is the migration. Byte-for-byte what
//! Redline's `migrate_v1` ran (Session A2 of the Polis extraction).

use rusqlite::{params, Connection};

use crate::meta;
use crate::schema::SYSTEM_INDEX_CHARS;

/// The ONE tokenizer every lexical index in this database is built with, in
/// SQL-escaped form (the inner quotes are doubled for embedding in
/// `tokenize='…'`).
///
/// - `porter` — stemming, so "compacting" finds "compaction". Measured free:
///   123 KB stemmed vs 125 KB unstemmed over the cleaned corpus.
/// - `remove_diacritics 2` — the Unicode-correct variant (1 mishandles
///   multi-codepoint sequences).
/// - `tokenchars '_-./@'` — keeps `rl_del`, `src/db.rs`, `--allowedTools` and
///   `user@host` as SINGLE tokens instead of shredding them at every
///   punctuation mark. This is why the grep arm has less to cover.
///
/// One tokenizer for prompts, browse events and the catalog, deliberately: a
/// query planned for one index has to mean the same thing in the others, or a
/// term that matched a page silently misses the prompt that discussed it.
pub const TOKENIZER: &str = "porter unicode61 remove_diacritics 2 tokenchars ''_-./@''";

/// Prefix indexes at 2 and 3 characters — enough for the OR-with-prefix stage of
/// the query cascade to reach short stems without indexing every prefix length.
///
/// Applied to the SMALL indexes only (prompts, the catalog). A prefix index is
/// not free: adding it to `browse_events_fts`, which covers 5.7 MB of page DOM,
/// measured **+1.3 MB — it doubled that index** for a stage that runs only when
/// the precise reading already failed. FTS5 still answers `"term"*` without one
/// by walking the term-index range, which over 829 documents is nothing. Same
/// reasoning that keeps browse `text` out of the trigram arm: the big text
/// column is where index tricks stop paying.
pub const PREFIX_SIZES: &str = "2 3";

/// Version key for the whole derived lexical layer. Bumping this drops and
/// rebuilds every FTS table — which is the migration, because an FTS5
/// tokenizer is fixed at creation time.
pub const LEXICAL_VERSION: &str = "2";

pub struct Lexical;

impl Lexical {
    /// The generated columns + the versioned FTS block. Rebuilds only when
    /// `polis_meta.lexical_version` is not `LEXICAL_VERSION`.
    pub fn ensure(conn: &Connection) -> rusqlite::Result<()> {
        // --- The lexical layer, versioned ------------------------------------
        //
        // Everything here (tokenizer, indexed expression, column weighting) is
        // DERIVED: droppable and rebuildable from the content tables, never on
        // the hash chain. So it is versioned as one unit rather than migrated
        // statement by statement — changing the tokenizer is a version bump, not
        // a hand-written ALTER, and the rebuild is the migration.
        //
        // Two things are load-bearing:
        //
        // 1. **Generated columns.** The old triggers indexed
        //    `COALESCE(gist, body)` while the content table held `body = ''` for
        //    every compacted row — a divergence that made FTS5's own `'rebuild'`
        //    command WRONG (it re-reads by column name and would have silently
        //    dropped 224 gists), which is why the code carried a comment
        //    forbidding it. Making the indexed text a real generated column of
        //    the content table removes the divergence by construction: the
        //    triggers write `new.fts_head`/`new.fts_tail`, `'rebuild'` reads the
        //    same two columns, and they cannot disagree. `'rebuild'` is now
        //    correct, and `prompts_fts_rebuild_is_now_correct` pins it.
        //
        // 2. **`fts_text` reads `user_text` for an agent row.** This is where
        //    Phase 1's corpus work turns into index size: porter over the
        //    cleaned corpus measures 123 KB against today's 2,642 KB. The role
        //    backfill above MUST have run first or this computes against NULL
        //    roles and indexes every preface — which is why both key on
        //    `meta::CORPUS_ROLE_VERSION_KEY` and run in one migration step.
        //
        // The head/tail split lets bm25 weight the opening of a prompt (where a
        // 6 KB body states its ask) over its interior, at zero extra index bytes
        // since the two columns are disjoint slices of the same text.
        // What each role contributes to the searchable text, measured on the
        // live corpus (1,215 rows / 7.65 MB):
        //
        //   agent   447 rows  5.6 MB (73.3%) → its `user_text` only
        //   system  110 rows  1.8 MB (24.0%) → its first SYSTEM_INDEX_CHARS
        //   user    658 rows  208 KB ( 2.7%) → all of it
        //
        // The `system` rule is the one judgement call here. A
        // `<task-notification>` is a real event in the user's history — it
        // reports work their own session did — so it stays in the corpus and on
        // the Timeline. But it is not their words, and its BODY is a dump of
        // agent output: indexing all 1.8 MB of it would leave the lexical layer
        // 90% machine text even after the agent rows are gone, and every
        // question would compete with agent-speak for recall. The notification
        // says what finished in its opening lines, so a head window keeps it
        // findable at ~7% of the bytes.
        let _ = conn.execute(
            &format!(
                "ALTER TABLE prompts ADD COLUMN fts_text TEXT GENERATED ALWAYS AS (
                    CASE WHEN role = 'agent'  THEN COALESCE(NULLIF(user_text, ''), '')
                         WHEN role = 'system' THEN substr(COALESCE(NULLIF(body, ''), gist, ''),
                                                          1, {SYSTEM_INDEX_CHARS})
                         ELSE COALESCE(NULLIF(body, ''), gist, '') END) VIRTUAL"
            ),
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE prompts ADD COLUMN fts_head TEXT
                GENERATED ALWAYS AS (substr(fts_text, 1, 400)) VIRTUAL",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE prompts ADD COLUMN fts_tail TEXT
                GENERATED ALWAYS AS (substr(fts_text, 401)) VIRTUAL",
            [],
        );

        {
            let built: Option<String> = conn
                .query_row(
                    "SELECT value FROM polis_meta WHERE key = ?1",
                    params![meta::LEXICAL_VERSION_KEY],
                    |r| r.get(0),
                )
                .ok();
            if built.as_deref() != Some(LEXICAL_VERSION) {
                // Drop first: an FTS5 table's tokenizer is fixed at creation, so
                // a tokenizer change is a re-creation. The shadow tables go with
                // it (DROP on the virtual table removes them).
                let _ = conn.execute_batch(
                    "DROP TRIGGER IF EXISTS prompts_fts_ai;
                     DROP TRIGGER IF EXISTS prompts_fts_ad;
                     DROP TRIGGER IF EXISTS prompts_fts_au;
                     DROP TABLE IF EXISTS prompts_fts;
                     DROP TRIGGER IF EXISTS browse_events_ai;
                     DROP TRIGGER IF EXISTS browse_events_ad;
                     DROP TRIGGER IF EXISTS browse_events_au;
                     DROP TABLE IF EXISTS browse_events_fts;
                     DROP TRIGGER IF EXISTS class_nodes_fts_ai;
                     DROP TRIGGER IF EXISTS class_nodes_fts_ad;
                     DROP TRIGGER IF EXISTS class_nodes_fts_au;
                     DROP TABLE IF EXISTS class_nodes_fts;
                     DROP TRIGGER IF EXISTS prompts_grep_ai;
                     DROP TRIGGER IF EXISTS prompts_grep_ad;
                     DROP TRIGGER IF EXISTS prompts_grep_au;
                     DROP TABLE IF EXISTS prompts_grep;
                     DROP TRIGGER IF EXISTS browse_grep_ai;
                     DROP TABLE IF EXISTS browse_grep;",
                );
                let ddl = format!(
                    r#"
                    CREATE VIRTUAL TABLE prompts_fts USING fts5(
                        fts_head, fts_tail,
                        content='prompts', content_rowid='id',
                        tokenize='{TOKENIZER}', prefix='{PREFIX_SIZES}'
                    );
                    -- `prompts` is NOT insert-only: compaction rewrites
                    -- gist/body in place and a forget releases the words, so the
                    -- full trigger set is required, with FTS5's `'delete'` idiom
                    -- supplying the OLD text on the way out. Getting this wrong
                    -- doesn't error — it returns garbage from snippet().
                    CREATE TRIGGER prompts_fts_ai AFTER INSERT ON prompts BEGIN
                        INSERT INTO prompts_fts (rowid, fts_head, fts_tail)
                        VALUES (new.id, new.fts_head, new.fts_tail);
                    END;
                    CREATE TRIGGER prompts_fts_ad AFTER DELETE ON prompts BEGIN
                        INSERT INTO prompts_fts (prompts_fts, rowid, fts_head, fts_tail)
                        VALUES ('delete', old.id, old.fts_head, old.fts_tail);
                    END;
                    CREATE TRIGGER prompts_fts_au AFTER UPDATE ON prompts BEGIN
                        INSERT INTO prompts_fts (prompts_fts, rowid, fts_head, fts_tail)
                        VALUES ('delete', old.id, old.fts_head, old.fts_tail);
                        INSERT INTO prompts_fts (rowid, fts_head, fts_tail)
                        VALUES (new.id, new.fts_head, new.fts_tail);
                    END;

                    -- No `prefix=` here, deliberately: see PREFIX_SIZES. This
                    -- index covers 5.7 MB of page DOM and a prefix index over
                    -- it measured +1.3 MB, doubling it.
                    CREATE VIRTUAL TABLE browse_events_fts USING fts5(
                        title, url, text,
                        content='browse_events', content_rowid='id',
                        tokenize='{TOKENIZER}'
                    );
                    -- `browse_events` USED to be insert-only, which is why an
                    -- AFTER INSERT trigger alone was safe. It no longer is:
                    -- `caption` (the vision tier) is written by an UPDATE, and
                    -- an external-content FTS table whose content row changes
                    -- without a matching `'delete'` row does not error — it
                    -- returns GARBAGE from snippet(), because the index still
                    -- holds offsets into text that no longer exists. The full
                    -- trigger set lands HERE, before the caption column is ever
                    -- written to, and `browse_events_fts_survives_an_update`
                    -- pins it.
                    CREATE TRIGGER browse_events_ai AFTER INSERT ON browse_events BEGIN
                        INSERT INTO browse_events_fts (rowid, title, url, text)
                        VALUES (new.id, new.title, new.url, new.text);
                    END;
                    CREATE TRIGGER browse_events_ad AFTER DELETE ON browse_events BEGIN
                        INSERT INTO browse_events_fts (browse_events_fts, rowid, title, url, text)
                        VALUES ('delete', old.id, old.title, old.url, old.text);
                    END;
                    CREATE TRIGGER browse_events_au AFTER UPDATE ON browse_events BEGIN
                        INSERT INTO browse_events_fts (browse_events_fts, rowid, title, url, text)
                        VALUES ('delete', old.id, old.title, old.url, old.text);
                        INSERT INTO browse_events_fts (rowid, title, url, text)
                        VALUES (new.id, new.title, new.url, new.text);
                    END;

                    -- The catalog gets an index of its own — the highest-leverage
                    -- single fix in the program. `match_class_nodes` LIKEd the
                    -- ENTIRE raw query as one `%…%` pattern, so any
                    -- question-shaped `?q=` resolved no node at all and the
                    -- answer pack silently degraded to lexical-only. 125 rows;
                    -- the index is single-digit KB.
                    CREATE VIRTUAL TABLE class_nodes_fts USING fts5(
                        title, summary,
                        content='class_nodes', content_rowid='rowid',
                        tokenize='{TOKENIZER}', prefix='{PREFIX_SIZES}'
                    );
                    CREATE TRIGGER class_nodes_fts_ai AFTER INSERT ON class_nodes BEGIN
                        INSERT INTO class_nodes_fts (rowid, title, summary)
                        VALUES (new.rowid, new.title, COALESCE(new.summary, ''));
                    END;
                    CREATE TRIGGER class_nodes_fts_ad AFTER DELETE ON class_nodes BEGIN
                        INSERT INTO class_nodes_fts (class_nodes_fts, rowid, title, summary)
                        VALUES ('delete', old.rowid, old.title, COALESCE(old.summary, ''));
                    END;
                    CREATE TRIGGER class_nodes_fts_au AFTER UPDATE ON class_nodes BEGIN
                        INSERT INTO class_nodes_fts (class_nodes_fts, rowid, title, summary)
                        VALUES ('delete', old.rowid, old.title, COALESCE(old.summary, ''));
                        INSERT INTO class_nodes_fts (rowid, title, summary)
                        VALUES (new.rowid, new.title, COALESCE(new.summary, ''));
                    END;

                    -- The grep arm: trigram indexes, which answer arbitrary
                    -- substring `LIKE '%…%'` from an INDEX instead of a scan.
                    -- This is the Google-Code-Search shape — an index proposes
                    -- candidates, a regex verifies them in Rust — and it is the
                    -- only honest way to reach what tokenization cannot: error
                    -- strings, `#[serde(rename_all)]`, a fragment of a path.
                    --
                    -- A bare `regexp` function over "a candidate set" was
                    -- rejected: without an index there IS no candidate set, so
                    -- it degenerates into a 7 MB scan under the connection lock.
                    --
                    -- What is deliberately NOT indexed: browse `text`. A
                    -- trigram index over 5.7 MB of page DOM measured ~5.7 MB of
                    -- index, and substring search INSIDE a rendered page is not
                    -- a question anyone asks — you ask WHICH page, and
                    -- url + title answers that.
                    CREATE VIRTUAL TABLE prompts_grep USING fts5(
                        fts_text, content='prompts', content_rowid='id',
                        tokenize='trigram'
                    );
                    CREATE TRIGGER prompts_grep_ai AFTER INSERT ON prompts BEGIN
                        INSERT INTO prompts_grep (rowid, fts_text) VALUES (new.id, new.fts_text);
                    END;
                    CREATE TRIGGER prompts_grep_ad AFTER DELETE ON prompts BEGIN
                        INSERT INTO prompts_grep (prompts_grep, rowid, fts_text)
                        VALUES ('delete', old.id, old.fts_text);
                    END;
                    CREATE TRIGGER prompts_grep_au AFTER UPDATE ON prompts BEGIN
                        INSERT INTO prompts_grep (prompts_grep, rowid, fts_text)
                        VALUES ('delete', old.id, old.fts_text);
                        INSERT INTO prompts_grep (rowid, fts_text) VALUES (new.id, new.fts_text);
                    END;

                    CREATE VIRTUAL TABLE browse_grep USING fts5(
                        url, title, content='browse_events', content_rowid='id',
                        tokenize='trigram'
                    );
                    CREATE TRIGGER browse_grep_ai AFTER INSERT ON browse_events BEGIN
                        INSERT INTO browse_grep (rowid, url, title)
                        VALUES (new.id, new.url, COALESCE(new.title, ''));
                    END;
                    "#
                );
                if let Err(e) = conn.execute_batch(&ddl) {
                    tracing::warn!(error = %e, "lexical index rebuild failed");
                }
                // `'rebuild'` — correct now, for the first time, because every
                // indexed column resolves against a real column of its content
                // table. No `%_docsize` guard is needed either: this runs once
                // per version, not once per boot.
                for table in [
                    "prompts_fts",
                    "browse_events_fts",
                    "class_nodes_fts",
                    "prompts_grep",
                    "browse_grep",
                ] {
                    let _ = conn.execute(&format!("INSERT INTO {table}({table}) VALUES('rebuild')"), []);
                }
                let _ = conn.execute(
                    "INSERT INTO polis_meta (key, value) VALUES (?1, ?2)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    params![meta::LEXICAL_VERSION_KEY, LEXICAL_VERSION],
                );
            }
        }
        Ok(())
    }
}
