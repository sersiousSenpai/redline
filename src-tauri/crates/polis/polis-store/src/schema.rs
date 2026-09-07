// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The memory schema — the Polis lake, its class catalog and the derived
//! indexes — as DDL, byte-for-byte what Redline's `migrate_v1` ran (Session A2
//! of the Polis extraction). Every SQL literal keeps its original indentation
//! on purpose: SQLite stores a CREATE statement's text as written, and the
//! golden `tests/golden/memory_schema.sql` in the Redline repo is the referee
//! that nothing here drifted by a byte.
//!
//! Idempotent throughout (`IF NOT EXISTS`, best-effort `ALTER TABLE`), so the
//! same code is both "create a fresh store" and "bring an existing one
//! current"; the two paths cannot diverge. Versioned as a unit by
//! `polis_meta.schema_version` — the runner in `lib.rs` skips all of this on
//! an already-current store.

use rusqlite::{params, Connection};

use crate::meta;

/// How much of a `system` row (a `<task-notification>` / `<system-reminder>`
/// the CLI injected) enters the searchable text. Enough to name what happened,
/// not the whole dump — see the `fts_text` note in `migrate`.
pub const SYSTEM_INDEX_CHARS: usize = 600;

/// The `app_settings` key the one-time corpus-role backfill records itself
/// under, and the version it writes. Bumping the version re-runs the
/// classification over any row still NULL — it never touches a row that already
/// has a role, so a user's own correction survives an upgrade.
///
/// Phase 2's `fts_text` generated column reads `role`, so it MUST key on this
/// same counter and run after it: created first, it would compute against NULL
/// roles and index every preface.
pub const CORPUS_ROLE_VERSION: &str = "1";

/// The memory tables, in creation order. What `PolisStore::schema_sql` dumps
/// (with their indexes, triggers and FTS shadow tables) and what
/// `verify` checks for after a migration.
pub const MEMORY_TABLES: &[&str] = &[
    "prompts",
    "ledger_events",
    "class_nodes",
    "class_links",
    "class_proposals",
    "class_runs",
    "supersessions",
    "user_notes",
    "class_observations",
    "plan_exports",
    "browse_events",
    "session_tree",
    "prompt_archive",
    "embeddings",
];

/// The FTS5 tables of the lexical layer (`lexical.rs`), for the schema dump.
pub const LEXICAL_TABLES: &[&str] = &[
    "prompts_fts",
    "browse_events_fts",
    "class_nodes_fts",
    "prompts_grep",
    "browse_grep",
];

/// The migration steps, in the order Redline ran them. Associated functions
/// on a unit struct so every moved block keeps its original 8-space body
/// indentation (the multi-line SQL literals depend on it).
pub struct Migration;

impl Migration {
    /// The content tables and their indexes — the memory statements of the
    /// original v1 batch, in their original relative order.
    pub fn tables(conn: &Connection) -> rusqlite::Result<()> {
        conn.execute_batch(
            r#"
            -- Polis data lake: the raw, complete prompt store. One row per
            -- captured prompt (hook / drafter / rust-firstturn / voice). Bodies
            -- live here (ledger-owned) so a session delete can never orphan the
            -- hash chain. Dedup on (body_hash, claude_session_id).
            CREATE TABLE IF NOT EXISTS prompts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL,
                source TEXT NOT NULL,
                origin TEXT NOT NULL DEFAULT 'redline',
                surface TEXT NOT NULL,
                role TEXT,
                session_id TEXT,
                claude_session_id TEXT,
                mission_id TEXT,
                project_path TEXT,
                body TEXT NOT NULL,
                body_hash TEXT NOT NULL
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_prompts_dedup
                ON prompts (body_hash, claude_session_id);

            -- Polis ledger: append-only, hash-chained, author-attributed record
            -- of prompts, plan revisions, decisions and curation signals.
            -- entry_hash = sha256(prev_hash ‖ canonical-json(event)); genesis
            -- prev = 64 zeros. Decision kinds reference an existing row by
            -- (ref_kind, ref_id) + payload_hash rather than a deletable FK, so
            -- deleting the referenced session can't break the chain.
            CREATE TABLE IF NOT EXISTS ledger_events (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL,
                kind TEXT NOT NULL,
                author TEXT NOT NULL,
                prompt_id INTEGER,
                session_id TEXT,
                version_number INTEGER,
                ref_kind TEXT,
                ref_id TEXT,
                payload_hash TEXT NOT NULL,
                prev_hash TEXT NOT NULL,
                entry_hash TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_ledger_kind ON ledger_events (kind);

            CREATE INDEX IF NOT EXISTS idx_ledger_ref ON ledger_events (ref_kind, ref_id);

            -- Polis ClassMemory (Phase 2): an agent-classified, human-curated,
            -- vectorless class CATALOG *over* the lake. Nodes only ever hold
            -- POINTERS (class_links) into the ledger/prompt store — reorganizing
            -- the tree never touches or re-copies underlying data. A class is
            -- just a root node (parent_id NULL); depth is emergent (no level
            -- enum). A `digest` node's `summary` is the agent-written gist of a
            -- collapsed cold branch, with class_links back to the exact ledger
            -- rows it cites. Every node/link carries status{proposed,accepted}:
            -- nothing enters or moves without a user accept.
            CREATE TABLE IF NOT EXISTS class_nodes (
                id TEXT PRIMARY KEY,
                parent_id TEXT,               -- NULL = a root (a class)
                kind TEXT NOT NULL DEFAULT 'node',   -- node | digest
                title TEXT NOT NULL,
                summary TEXT,                 -- digest gist; NULL for plain nodes
                project_path TEXT,            -- optional binding on any node
                ip_name TEXT,                 -- whose plan it was (provenance)
                status TEXT NOT NULL DEFAULT 'proposed',  -- proposed | accepted
                pinned INTEGER NOT NULL DEFAULT 0,        -- anti-decay marker
                curated_by TEXT,              -- 'classifier' | author on accept
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_class_nodes_parent ON class_nodes (parent_id);

            CREATE INDEX IF NOT EXISTS idx_class_nodes_status ON class_nodes (status);

            -- Pointers from a class node into the lake. target_kind is one of
            -- prompt|session|revision|mission|decision|browse_event; target_id is
            -- that row's id (prompt id / session id / ledger seq / mission id /
            -- browse_events id). Reorganizing the tree re-parents nodes; links
            -- ride along untouched.
            CREATE TABLE IF NOT EXISTS class_links (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                node_id TEXT NOT NULL,
                target_kind TEXT NOT NULL,
                target_id TEXT NOT NULL,
                note TEXT,
                status TEXT NOT NULL DEFAULT 'proposed',  -- proposed | accepted
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_class_links_node ON class_links (node_id);

            CREATE UNIQUE INDEX IF NOT EXISTS idx_class_links_dedup
                ON class_links (node_id, target_kind, target_id);

            -- Structural reorg proposals (promote/split/merge/collapse) that
            -- can't be expressed as a single node's status. Additive proposals
            -- (file/create) stage directly as proposed class_nodes/class_links;
            -- these operate on EXISTING accepted nodes, so they queue here for
            -- review. Accept applies the op to the tree + writes a taxonomy_reorg
            -- ledger event, then drops the row; reject just drops it.
            CREATE TABLE IF NOT EXISTS class_proposals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id INTEGER,
                op TEXT NOT NULL,             -- promote | split | merge | collapse
                node_id TEXT,                 -- primary subject node
                parent_id TEXT,               -- new parent (promote) / merge target parent
                title TEXT,                   -- merge target / collapse digest title
                summary TEXT,                 -- collapse digest gist
                extra_json TEXT,              -- op-specific payload (split parts, merge ids, cite seqs)
                rationale TEXT,               -- agent's stated why (size/recency/coherence)
                status TEXT NOT NULL DEFAULT 'proposed',
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_class_proposals_status ON class_proposals (status);

            -- One classifier pass over the lake delta. Bounds the seq window it
            -- consumed so the next run is delta-based, and records the claude
            -- session id + a short summary for the pane.
            CREATE TABLE IF NOT EXISTS class_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                started_at INTEGER NOT NULL,
                finished_at INTEGER,
                status TEXT NOT NULL,         -- running | done | error
                seq_from INTEGER,
                seq_to INTEGER,
                claude_session_id TEXT,
                summary TEXT
            );

            -- Supersession index: decision old_seq was replaced by new_seq.
            -- Plain and NEVER hashed — the tamper-evident fact is the
            -- `supersede` ledger event (event_seq); this table is only the fast
            -- "is seq X superseded?" lookup so retrieval never re-parses
            -- payloads. PRIMARY KEY(old_seq) enforces "superseded at most
            -- once" — a later supersession targets the current chain head.
            CREATE TABLE IF NOT EXISTS supersessions (
                old_seq INTEGER PRIMARY KEY,  -- the superseded decision event
                new_seq INTEGER NOT NULL,     -- the superseding decision event
                event_seq INTEGER NOT NULL,   -- the supersede ledger event
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_supersessions_new
                ON supersessions (new_seq);

            -- Second Brain P3: the user's own margin notes + stars over the
            -- record. Readable and EDITABLE rows in a plain, never-hashed side
            -- table — the `supersessions` pattern: the tamper-evident facts are
            -- the `note` ledger events (each act appends one, committing to
            -- {action, text}); this table only holds the current state so the
            -- UI never re-parses payloads. One row per annotated target
            -- (partial unique below); target_kind 'none' rows are standalone
            -- thoughts, each its own row, referenced by the event as
            -- (ref_kind='none', ref_id=id). A note is a curation signal for
            -- the classifier, NEVER provenance. Nothing here is ever deleted.
            CREATE TABLE IF NOT EXISTS user_notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                seq INTEGER,                  -- latest `note` ledger event seq
                target_kind TEXT NOT NULL,    -- ledger_event | class_node | session | none
                target_id TEXT,               -- event seq / node id / session id; NULL when standalone
                text TEXT NOT NULL DEFAULT '',
                starred INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_user_notes_target
                ON user_notes (target_kind, target_id) WHERE target_kind <> 'none';

            CREATE INDEX IF NOT EXISTS idx_user_notes_starred
                ON user_notes (starred, updated_at);

            -- Agent-written pattern observations over a node's lake items
            -- (recurrence / trend / co-occurrence). Derived, never ground
            -- truth: the classifier must never file by one. cite_seqs is a
            -- non-empty JSON array of the exact ledger seqs the pattern was
            -- derived from — an uncited observation is rejected upstream.
            -- Rows retire when their node's subtree collapses/merges away;
            -- the `observation` ledger events remain as history.
            CREATE TABLE IF NOT EXISTS class_observations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                node_id TEXT NOT NULL,
                summary TEXT NOT NULL,
                cite_seqs TEXT NOT NULL,      -- JSON array of ledger seqs
                created_seq INTEGER,          -- the observation ledger event seq
                pinned INTEGER NOT NULL DEFAULT 0,
                dismissed INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_class_observations_node
                ON class_observations (node_id, dismissed);

            -- Polis Phase 4: which sessions have been exported as a portable
            -- context bundle. This is the state that finally backs the
            -- Librarian's deferred F6 "un-exported approved plan" friction signal
            -- (Spike 3a parked it pending Phase 4). One row per (session, scope)
            -- export; `head_hash` records the ledger head the bundle pinned, so a
            -- later chain-growth can distinguish "exported at head X" if we ever
            -- want staleness. UNIQUE keeps re-exports idempotent on the signal.
            CREATE TABLE IF NOT EXISTS plan_exports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                scope TEXT NOT NULL,          -- session | mission | class | full
                head_hash TEXT,
                exported_at INTEGER NOT NULL
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_exports_session
                ON plan_exports (session_id, scope);

            -- Polis P2 (Dojo "Browsing Behavior"): the pages the user landed on,
            -- with the normalized on-screen content that was there + a content
            -- context-hash. Ledger-owned body store: a `browse_event` ledger row
            -- references a row here by (ref_kind='browse_event', ref_id=id) +
            -- payload_hash = context_hash, exactly like a decision event, so a
            -- session delete can never orphan the chain. `text` (title + url +
            -- headings + body) is retained so later lexical retrieval (P3 FTS5)
            -- has something to index; `context_hash` groups every event that
            -- touched the same content across sessions/tabs.
            CREATE TABLE IF NOT EXISTS browse_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL,
                action TEXT NOT NULL,          -- verb vocabulary: 'navigate' | 'select' | 'submit' | 'leave'
                                              -- (enforced by ledger::BrowseAction, not a CHECK — additive widening)
                browse_id TEXT,               -- the tab's discussion-thread key
                url TEXT NOT NULL,
                title TEXT,
                text TEXT NOT NULL,           -- normalized page content (for P3 FTS)
                context_hash TEXT NOT NULL,   -- body_hash over `text`
                from_event_id INTEGER         -- trail edge: preceding browse_events.id (NULL = trail root)
            );

            CREATE INDEX IF NOT EXISTS idx_browse_events_hash ON browse_events (context_hash);

            CREATE INDEX IF NOT EXISTS idx_browse_events_tab ON browse_events (browse_id);

            -- Dojo P3: a lexical (BM25) full-text index over browse events.
            -- Browsing is high-volume and keyword-heavy, so lexical recall beats
            -- dense vectors as the first cut — and FTS5 ships with SQLite, so
            -- there is no new dependency, no embedding model, and retrieval stays
            -- auditable (you can see which terms matched).
            --
            -- DESIGN LAW, amended twice. It first read "only this noisy stream
            -- gets lexical search; plans/prompts keep the vectorless ClassMemory
            -- walk", then "…and no embedding model enters the product".
            --
            -- What survives, and is now enforced by guard tests rather than by
            -- convention: **a ranked fuzzy index must not become the taxonomy.**
            -- In one line — the arms decide what you READ; the tree decides what
            -- things ARE. Node resolution never consults a lake ranking, no
            -- retrieval path writes to the catalog, and the classifier's input is
            -- chain order and never a ranking.
            --
            -- What is retired: "lexical vs walk" was never the real distinction,
            -- and "no embedding model" was a proxy for two concerns (binary size,
            -- auditability) that are better met directly — by an OS-provided
            -- embedding service with zero model bytes in the binary, and by
            -- labeling every hit with the arm that found it.
            --
            -- The index definitions themselves live in the versioned lexical
            -- block further down, not here: they depend on columns added by the
            -- ALTERs below (`role`, `user_text`, `gist`), and they carry a
            -- tokenizer that must be able to change without a hand-written
            -- migration per change.

            -- Memory-by-session: the readable parent/child relation across the
            -- app's disjoint thread id-spaces. A child (browse tab thread,
            -- linked discussion, mission, voice session, draft, review, …)
            -- hangs under a parent session or mission. Referenced by id, never
            -- FK-cascaded, so deletes can't orphan the ledger; each accepted
            -- row is committed to the chain by a `session_link` ledger event.
            CREATE TABLE IF NOT EXISTS session_tree (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                child_kind TEXT NOT NULL,
                child_id TEXT NOT NULL,
                parent_kind TEXT NOT NULL,
                parent_id TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_session_tree_child
                ON session_tree (child_kind, child_id);

            CREATE INDEX IF NOT EXISTS idx_session_tree_parent
                ON session_tree (parent_kind, parent_id);

            -- Retrieval-path indexes. Every one of these covers a query that was
            -- a full table scan on the read side of the Memory surface — the
            -- probes an agent's retrieval turn and the Timeline page both pay
            -- for, per row, under the single connection lock.
            --
            -- The Timeline's filing probe asks "which node is this target filed
            -- under?" — the reverse of `idx_class_links_node`, so it had no
            -- index at all and scanned the link table once per page row.
            CREATE INDEX IF NOT EXISTS idx_class_links_target
                ON class_links (target_kind, target_id, status);

            -- Ledger lookups by provenance rather than by seq: the prompt join
            -- direction (`/v1/context/prompts`), the session spine, and the
            -- activity-ribbon date range.
            CREATE INDEX IF NOT EXISTS idx_ledger_prompt ON ledger_events (prompt_id);

            CREATE INDEX IF NOT EXISTS idx_ledger_session ON ledger_events (session_id);

            CREATE INDEX IF NOT EXISTS idx_ledger_ts ON ledger_events (ts);

            -- The existing unique index on user_notes is PARTIAL
            -- (`WHERE target_kind <> 'none'`), so the Timeline's two note joins
            -- — which don't carry that predicate — couldn't use it.
            CREATE INDEX IF NOT EXISTS idx_user_notes_target_all
                ON user_notes (target_kind, target_id);

            -- `supersessions.old_seq` is the PK, but the batched
            -- `WHERE old_seq IN (…)` reader wants it as a named index too on
            -- databases where the table predates the current schema.
            CREATE INDEX IF NOT EXISTS idx_supersessions_old
                ON supersessions (old_seq);
            "#,
        )?;
        Ok(())
    }

    /// Additive columns, the corpus-role backfill (gated on
    /// `polis_meta.corpus_role_version`), the lake's read-path indexes, the
    /// compaction archive and the browse picture columns.
    pub fn additive(conn: &Connection) -> rusqlite::Result<()> {
        // Memory-as-plumbing: cold-prompt compaction. When the background keeper
        // gists a cold body, `gist` holds the summary (NULL = warm/full body),
        // `compacted_at` stamps it, and `original_bytes` records what was
        // reclaimed. `body_hash` is NEVER touched — it stays the ORIGINAL (the
        // tamper-evident fact the ledger commits to, and the dedup key), so the
        // chain and every bundle stay verifiable after the words are released.
        let _ = conn.execute("ALTER TABLE prompts ADD COLUMN gist TEXT", []);
        let _ = conn.execute("ALTER TABLE prompts ADD COLUMN compacted_at INTEGER", []);
        let _ = conn.execute("ALTER TABLE prompts ADD COLUMN original_bytes INTEGER", []);
        // `compaction_stats` aggregates over exactly this partial set, on every
        // memory-status poll. It lives down here rather than in the batch above
        // because it references migrated columns — the batch runs before the
        // ALTERs on an upgrade, where `gist` does not exist yet.
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_prompts_compacted
                ON prompts (compacted_at) WHERE gist IS NOT NULL",
            [],
        );

        // --- Corpus hygiene: what kind of text a lake row IS -----------------
        //
        // `prompts.role` shipped in the original DDL and was NULL on every row,
        // which is how the corpus reached 92.6% machine text unnoticed: 4.32 MB
        // of leaked agent prefaces, 1.25 MB recorded on purpose, and 1.78 MB of
        // `<task-notification>`/`<system-reminder>` injections, against ~120 KB
        // of genuine user prompts. `user_text` carries the human's own words out
        // of an agent row's constructed body so the lexical index can read the
        // question instead of the preface. Both are non-hashed and chain-safe —
        // only `prompt_id` + `body_hash` enter the chained event (the
        // gist/thread_kind precedent).
        let _ = conn.execute("ALTER TABLE prompts ADD COLUMN user_text TEXT", []);
        // Which tier produced a compacted row's gist: `agent` (the keeper's
        // summarizer ran) or `deterministic` (it didn't, and the fallback kept a
        // window of the text). Without this the two are indistinguishable after
        // the fact, which is how 47% of gists came to be raw truncations while
        // the reclaim number looked like a success.
        let _ = conn.execute("ALTER TABLE prompts ADD COLUMN gist_source TEXT", []);

        // One-time reclassification of everything captured before the column
        // was filled. RECLASSIFY, NOT COMPACT — deliberately. Compacting the
        // 397 machine rows instead would append 397 `compaction` events to a
        // 2,938-event chain (+13.5%), irreversibly, and destroy the very
        // evidence needed to audit whether this classification was right. An
        // UPDATE of a non-hashed column leaves the rows byte-intact, the ledger
        // untouched, zero new events, and is fully reversible. Reclaiming the
        // disk is a separate, honest act (`keeper::select_compaction_candidates`
        // now targets `agent`/`system` first).
        //
        // Guarded on a version key, and keyed on the SAME counter as the Phase-2
        // `fts_text` generated column: that column reads `role`, so if it were
        // ever created first it would compute against NULL and index every
        // preface. Ordering here is arithmetic, not preference.
        {
            let done: Option<String> = conn
                .query_row(
                    "SELECT value FROM polis_meta WHERE key = ?1",
                    params![meta::CORPUS_ROLE_VERSION_KEY],
                    |r| r.get(0),
                )
                .ok();
            if done.as_deref() != Some(CORPUS_ROLE_VERSION) {
                // The order of the CASE arms is the classification, and each arm
                // is evidence-backed:
                //   1. the CLI's injections announce themselves by prefix;
                //   2. `rust_firstturn`/`voice_stream` are Redline's own
                //      constructed prompts by definition of the source;
                //   3. the leaked captures came in through the hook wearing no
                //      such marking — they are recognizable only by shape, and
                //      "opens with `You are ` and runs past 2 KB" is a first-turn
                //      preface, not something a person types;
                //   4. everything else is the user. Defaulting to `user` is the
                //      conservative direction: a misfiled user prompt stays
                //      searchable, a misfiled agent prompt disappears from view.
                let _ = conn.execute(
                    "UPDATE prompts SET role = CASE
                        WHEN TRIM(body) LIKE '<task-notification>%'
                          OR TRIM(body) LIKE '<system-reminder>%'   THEN 'system'
                        WHEN source IN ('rust_firstturn','voice_stream') THEN 'agent'
                        WHEN body LIKE 'You are %' AND LENGTH(body) > 2000 THEN 'agent'
                        ELSE 'user' END
                     WHERE role IS NULL",
                    [],
                );
                let _ = conn.execute(
                    "INSERT INTO polis_meta (key, value) VALUES (?1, ?2)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    params![meta::CORPUS_ROLE_VERSION_KEY, CORPUS_ROLE_VERSION],
                );
            }
        }
        // The lake's read paths, indexed. Every one of these backs a filter the
        // Timeline or a `/v1/context` route actually offers; without them each
        // faceted read is a full scan of `prompts` under the connection lock.
        // Composite `(x, ts)` rather than `(x)` alone because every one of these
        // reads is ordered by time within its facet.
        for ddl in [
            "CREATE INDEX IF NOT EXISTS idx_prompts_ts ON prompts (ts)",
            "CREATE INDEX IF NOT EXISTS idx_prompts_role ON prompts (role)",
            "CREATE INDEX IF NOT EXISTS idx_prompts_surface_ts ON prompts (surface, ts)",
            "CREATE INDEX IF NOT EXISTS idx_prompts_project_ts ON prompts (project_path, ts)",
            "CREATE INDEX IF NOT EXISTS idx_prompts_session ON prompts (session_id)",
            "CREATE INDEX IF NOT EXISTS idx_prompts_claude_sess ON prompts (claude_session_id)",
            "CREATE INDEX IF NOT EXISTS idx_prompts_thread ON prompts (thread_kind, thread_id)",
            "CREATE INDEX IF NOT EXISTS idx_prompts_model ON prompts (model)",
        ] {
            let _ = conn.execute(ddl, []);
        }

        // Compaction archive. A cold compaction releases the words at 59:1 and
        // used to be irrecoverable; that is a fine trade for machine text and a
        // terrible one for anything else, and "fine" was being decided by a
        // heuristic. Archiving the deflated original makes the decision
        // reversible, which is what lets the blade stay sharp.
        //
        // `body_hash` is stored beside the blob and re-verified on restore: the
        // archive is derived data outside the hash chain, so nothing may be
        // trusted back into a prompt row without proving it is the same bytes
        // the chain committed to. `algo` leaves room for a future codec without
        // a migration. Forget deletes from here too — forget must mean forget.
        let _ = conn.execute(
            "CREATE TABLE IF NOT EXISTS prompt_archive (
                prompt_id INTEGER PRIMARY KEY,
                body_hash TEXT NOT NULL,
                algo TEXT NOT NULL,
                original_bytes INTEGER NOT NULL,
                blob BLOB NOT NULL,
                archived_at INTEGER NOT NULL
            )",
            [],
        );

        // The picture store's pointer. NULL means no picture, and it is stored
        // rather than derived from `context_hash` because NULL has to be able
        // to mean three different real things: never captured, policy-denied,
        // and the user forgot it. A derived key could only ever say "the file
        // should exist", which is a different claim.
        let _ = conn.execute("ALTER TABLE browse_events ADD COLUMN shot_key TEXT", []);
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_browse_events_shot ON browse_events (shot_key)",
            [],
        );
        // A vision-tier caption for a page whose text didn't capture. Kept in
        // its OWN column and never appended into `text`, because
        // `context_hash = body_hash(text)` is the identity that the shot key,
        // the dedupe and the hash chain all rest on — folding a caption into
        // `text` would silently re-key the page.
        let _ = conn.execute("ALTER TABLE browse_events ADD COLUMN caption TEXT", []);
        Ok(())
    }

    /// The semantic index — derived, droppable, rebuildable.
    pub fn embeddings(conn: &Connection) -> rusqlite::Result<()> {
        // Semantic index — a DERIVED index, exactly like `prompts_fts`: not on
        // the hash chain, droppable, rebuildable from the content tables. That
        // is what makes an embedding model admissible at all; nothing here is
        // evidence, so nothing here can corrupt the record.
        //
        // `vec` is `dim` int8 bytes of an L2-normalized vector, with its scale
        // beside it. `source_hash` makes re-runs free (unchanged text is
        // skipped) and makes a model change a clean re-index rather than a
        // migration: rows carry the `model` that produced them, and a different
        // model simply has no rows yet.
        let _ = conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS embeddings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                target_kind TEXT NOT NULL,       -- prompt | browse_event | class_node
                target_id INTEGER NOT NULL,
                chunk_ix INTEGER NOT NULL,
                char_start INTEGER NOT NULL,
                char_len INTEGER NOT NULL,
                dim INTEGER NOT NULL,
                scale REAL NOT NULL,
                vec BLOB NOT NULL,
                model TEXT NOT NULL,
                source_hash TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_embeddings_chunk
                ON embeddings (target_kind, target_id, chunk_ix, model);
            CREATE INDEX IF NOT EXISTS idx_embeddings_target
                ON embeddings (target_kind, target_id);",
        );
        Ok(())
    }

    /// Provenance columns that landed after the lexical layer.
    pub fn provenance(conn: &Connection) -> rusqlite::Result<()> {
        // Memory-by-session provenance: which interaction thread a prompt
        // belongs to (browse_id / linked_id / draft_id / …) and the parent plan
        // session that thread hangs under. Non-hashed (only prompt_id +
        // body_hash enter the chained event), so purely additive and
        // chain-safe — the gist/compacted_at precedent.
        let _ = conn.execute("ALTER TABLE prompts ADD COLUMN thread_kind TEXT", []);
        let _ = conn.execute("ALTER TABLE prompts ADD COLUMN thread_id TEXT", []);
        let _ = conn.execute("ALTER TABLE prompts ADD COLUMN parent_session_id TEXT", []);

        // Model provenance: which model actually received a prompt, carried as
        // ground truth. `model_source` says how we know — 'seat' (the spawn's
        // own `--model` flag) or 'transcript' (backfilled from the session's
        // JSONL). NULL means the CLI default applied and we refuse to guess.
        // Non-hashed (only prompt_id + body_hash enter the chained event), so
        // additive and chain-safe — the gist/thread_kind precedent.
        let _ = conn.execute("ALTER TABLE prompts ADD COLUMN model TEXT", []);
        let _ = conn.execute("ALTER TABLE prompts ADD COLUMN model_source TEXT", []);

        // Behavioral foundation (P0): the trail edge — which browse event this
        // one followed from. Non-hashed (only `context_hash` enters the chained
        // event), so purely additive and chain-safe. NULL = trail root, and
        // every pre-existing row. The verb widening of `action` needs no
        // migration: it is enforced in Rust (`ledger::BrowseAction`), not by a
        // CHECK, and existing rows are all already 'navigate'.
        let _ = conn.execute("ALTER TABLE browse_events ADD COLUMN from_event_id INTEGER", []);
        Ok(())
    }

    /// Every memory table exists — the store's own schema check, run after a
    /// migration so a half-applied step is refused rather than stamped.
    pub fn verify(conn: &Connection) -> rusqlite::Result<()> {
        let mut stmt = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")?;
        let present: std::collections::HashSet<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<_>>()?;
        for table in MEMORY_TABLES.iter().chain(LEXICAL_TABLES) {
            if !present.contains(*table) {
                return Err(rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_ERROR),
                    Some(format!("polis-store schema check: table {table} is missing")),
                ));
            }
        }
        Ok(())
    }
}

/// Every `sqlite_master` row that belongs to a memory table (its own DDL, its
/// indexes and triggers, and an FTS table's `<name>_*` shadow tables), in
/// creation order, rendered as SQL — the golden's input.
pub fn schema_sql(conn: &Connection) -> rusqlite::Result<String> {
    let mut stmt =
        conn.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY rowid")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?,
        ))
    })?;
    let mut out = String::from(
        "-- Memory schema golden: every sqlite_master row of the Polis lake + catalog\n\
         -- tables from a fresh in-memory Database, in creation order.\n\
         -- Regenerate: UPDATE_GOLDEN=1 cargo test --test schema_golden\n\n",
    );
    for row in rows {
        let (ty, name, tbl, sql) = row?;
        let owned = MEMORY_TABLES
            .iter()
            .chain(LEXICAL_TABLES)
            .any(|t| tbl == *t || name.starts_with(&format!("{t}_")));
        if !owned {
            continue;
        }
        match sql {
            Some(sql) => out.push_str(&format!("-- {ty} {name} ({tbl})\n{sql};\n\n")),
            None => out.push_str(&format!("-- {ty} {name} ({tbl}) [auto]\n\n")),
        }
    }
    Ok(out)
}
