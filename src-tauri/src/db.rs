// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use crate::state::{
    reparse_sections, AttachState, BrowseMessage, CodeReviewSession, Comment, CommentKind,
    CommentScope, CommentSelection, CommentStatus, EditPayload, Linked, LinkedMessage, Mission,
    MissionFinding, MissionMessage, Resolution, ReviewAnnotation, ReviewQuestion,
    ReviewSession, Revision, RoundHistoryEntry, SessionStatus, SourceFeedback, StructuralPayload,
    ThreadMessage,
};

/// Reduce a URL to a bare host for feedback aggregation: strip scheme, any path/
/// query, a leading `www.`, and lowercase it. Best-effort — a URL we can't parse
/// falls back to the trimmed input so a row is never lost.
pub fn domain_of(url: &str) -> String {
    let s = url.trim();
    let after_scheme = s.split("://").nth(1).unwrap_or(s);
    let host = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(after_scheme);
    // Drop any userinfo@ and :port.
    let host = host.rsplit('@').next().unwrap_or(host);
    let host = host.split(':').next().unwrap_or(host);
    host.trim_start_matches("www.").to_ascii_lowercase()
}

/// Serialize a comment's reopen-round history for the `reopen_history` column.
/// Empty history stores NULL (keeps pre-feature and never-reopened rows clean).
fn reopen_history_to_json(history: &[RoundHistoryEntry]) -> Option<String> {
    if history.is_empty() {
        return None;
    }
    serde_json::to_string(history).ok()
}

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(path)?;
        let db = Self {
            conn: Mutex::new(conn),
        };
        db.migrate()?;
        Ok(db)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> rusqlite::Result<Self> {
        let conn = Connection::open_in_memory()?;
        let db = Self {
            conn: Mutex::new(conn),
        };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY,
                project_path TEXT NOT NULL,
                project_name TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'in_review'
            );

            CREATE TABLE IF NOT EXISTS revisions (
                session_id TEXT NOT NULL,
                version_number INTEGER NOT NULL,
                received_at INTEGER NOT NULL,
                raw_plan_markdown TEXT NOT NULL,
                PRIMARY KEY (session_id, version_number),
                FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS comments (
                id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                version_number INTEGER NOT NULL,
                type TEXT NOT NULL,
                scope TEXT,
                anchor_id TEXT NOT NULL,
                body TEXT NOT NULL,
                edit_original TEXT,
                edit_revised TEXT,
                created_at INTEGER NOT NULL,
                status TEXT NOT NULL,
                PRIMARY KEY (session_id, id),
                FOREIGN KEY (session_id, version_number)
                    REFERENCES revisions(session_id, version_number) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS thread_messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                comment_id TEXT NOT NULL,
                role TEXT NOT NULL,
                body TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_thread_messages
                ON thread_messages (session_id, comment_id, created_at);

            -- Browser browse-agent discussion threads. Scoped to a per-tab
            -- `browse_id` (frontend-persisted UUID), independent of any plan
            -- session. `browse_threads` holds the agent's resumable claude
            -- session id so a tab's follow-ups resume rather than re-spawn.
            CREATE TABLE IF NOT EXISTS browse_messages (
                id TEXT PRIMARY KEY,
                browse_id TEXT NOT NULL,
                role TEXT NOT NULL,
                body TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_browse_messages
                ON browse_messages (browse_id, created_at);

            CREATE TABLE IF NOT EXISTS browse_threads (
                browse_id TEXT PRIMARY KEY,
                claude_session_id TEXT
            );

            -- The voice agent's per-plan memory: the forked `claude` session id
            -- that holds the spoken discussion, keyed by the plan's session id.
            -- Re-entering voice mode resumes the same conversation, and it
            -- survives app restarts. The live process is disposable; this row
            -- is the memory. See src-tauri/src/voice.rs.
            CREATE TABLE IF NOT EXISTS voice_sessions (
                session_id TEXT PRIMARY KEY,
                fork_session_id TEXT NOT NULL
            );

            -- Research Missions: an orchestrator that holds one shared goal
            -- across the whole browser pane, a tier above the per-tab browse
            -- agents. The orchestrator's resumable claude session id lives on
            -- the row, so re-opening a mission resumes its conversation.
            -- `mission_findings` are the user's pins (curated findings pulled
            -- from any tab); `mission_messages` are the orchestrator chat turns
            -- (terminal rows, mirroring browse_messages). See mission.rs.
            CREATE TABLE IF NOT EXISTS missions (
                mission_id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                goal TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                claude_session_id TEXT,
                tabs_json TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS mission_findings (
                id TEXT PRIMARY KEY,
                mission_id TEXT NOT NULL,
                browse_id TEXT,
                source_url TEXT,
                source_title TEXT,
                body TEXT NOT NULL,
                note TEXT,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_mission_findings
                ON mission_findings (mission_id, created_at);

            CREATE TABLE IF NOT EXISTS mission_messages (
                id TEXT PRIMARY KEY,
                mission_id TEXT NOT NULL,
                role TEXT NOT NULL,
                body TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_mission_messages
                ON mission_messages (mission_id, created_at);

            -- Linked discussions: ONE continuous conversation that follows the
            -- user across every browser tab (no goal, unlike a mission). The
            -- resumable `claude` session id lives on the row; `linked_messages`
            -- are the chat turns (terminal rows, mirroring mission_messages) and
            -- carry a per-turn tab tag (which tab the user was on). Consults into
            -- a tab's context reuse that tab's own browse thread. See linked.rs.
            CREATE TABLE IF NOT EXISTS linked_sessions (
                linked_id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                claude_session_id TEXT,
                tabs_json TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS linked_messages (
                id TEXT PRIMARY KEY,
                linked_id TEXT NOT NULL,
                role TEXT NOT NULL,
                body TEXT NOT NULL,
                status TEXT NOT NULL,
                tab_browse_id TEXT,
                tab_n INTEGER,
                tab_title TEXT,
                tab_url TEXT,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_linked_messages
                ON linked_messages (linked_id, created_at);

            -- Tandem agent mode: per-source thumbs the user gives on the sources
            -- the browse agent surfaces. One row per (browse_id, source_url); a
            -- re-click updates `verdict` (+1 up / -1 down) and `updated_at`.
            -- `domain` is derived from the url so learning can aggregate by host.
            CREATE TABLE IF NOT EXISTS source_feedback (
                id TEXT PRIMARY KEY,
                browse_id TEXT NOT NULL,
                source_url TEXT NOT NULL,
                source_title TEXT,
                domain TEXT NOT NULL,
                verdict INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                UNIQUE (browse_id, source_url)
            );

            CREATE INDEX IF NOT EXISTS idx_source_feedback_domain
                ON source_feedback (domain);

            -- Code Review surface: the diff-review analog of plan sessions.
            -- Parallel tables (NOT the plan-review `comments` contract, which
            -- is byte-frozen): honest line-anchor columns plus `quoted_text`,
            -- the durable content anchor that re-locates across review rounds.
            CREATE TABLE IF NOT EXISTS review_sessions (
                review_id TEXT PRIMARY KEY,
                repo_path TEXT NOT NULL,
                source TEXT NOT NULL,
                base_ref TEXT,
                commit_sha TEXT,
                terminal_id TEXT,
                round INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS review_annotations (
                id TEXT NOT NULL,
                review_id TEXT NOT NULL,
                round INTEGER NOT NULL,
                file_path TEXT NOT NULL,
                side TEXT NOT NULL,
                start_line INTEGER NOT NULL,
                end_line INTEGER NOT NULL,
                kind TEXT NOT NULL,
                body TEXT NOT NULL,
                suggestion_replacement TEXT,
                quoted_text TEXT NOT NULL,
                status TEXT NOT NULL,
                resolution TEXT,
                created_at INTEGER NOT NULL,
                fork_session_id TEXT,
                scope TEXT NOT NULL DEFAULT 'line',
                label TEXT,
                blocking TEXT,
                source TEXT NOT NULL DEFAULT 'user',
                PRIMARY KEY (review_id, id)
            );

            CREATE INDEX IF NOT EXISTS idx_review_annotations
                ON review_annotations (review_id, file_path, start_line);

            CREATE TABLE IF NOT EXISTS review_viewed (
                review_id TEXT NOT NULL,
                file_path TEXT NOT NULL,
                viewed_at INTEGER NOT NULL,
                PRIMARY KEY (review_id, file_path)
            );

            CREATE TABLE IF NOT EXISTS review_questions (
                id TEXT NOT NULL,
                review_id TEXT NOT NULL,
                file_path TEXT NOT NULL,
                side TEXT NOT NULL,
                start_line INTEGER NOT NULL,
                end_line INTEGER NOT NULL,
                quoted_text TEXT NOT NULL,
                fork_session_id TEXT,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (review_id, id)
            );

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
            -- prompt|session|revision|mission|decision; target_id is that row's
            -- id (prompt id / session id / ledger seq / mission id). Reorganizing
            -- the tree re-parents nodes; links ride along untouched.
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
            "#,
        )?;
        // Best-effort additive migrations (errors on existing columns are ignored)
        let _ = conn.execute(
            "ALTER TABLE comments ADD COLUMN resolution_body TEXT",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE comments ADD COLUMN resolution_version INTEGER",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE comments ADD COLUMN resolution_accepted_at INTEGER",
            [],
        );
        // A mission's saved tab workspace (JSON `[{id,url,title,browseId}]`), so
        // re-entering a mission reopens its exact tabs with their discussions.
        let _ = conn.execute("ALTER TABLE missions ADD COLUMN tabs_json TEXT", []);
        // Review-annotation discussion forks (P3.5) — for review_annotations
        // tables created before the column landed on this branch.
        let _ = conn.execute(
            "ALTER TABLE review_annotations ADD COLUMN fork_session_id TEXT",
            [],
        );
        // Parity sprint: annotation scope (line|file|general), conventional
        // labels + blocking decoration, and the authoring source (user|ai|tool).
        let _ = conn.execute(
            "ALTER TABLE review_annotations ADD COLUMN scope TEXT NOT NULL DEFAULT 'line'",
            [],
        );
        let _ = conn.execute("ALTER TABLE review_annotations ADD COLUMN label TEXT", []);
        let _ = conn.execute("ALTER TABLE review_annotations ADD COLUMN blocking TEXT", []);
        let _ = conn.execute(
            "ALTER TABLE review_annotations ADD COLUMN source TEXT NOT NULL DEFAULT 'user'",
            [],
        );

        // Memory-as-plumbing: cold-prompt compaction. When the background keeper
        // gists a cold body, `gist` holds the summary (NULL = warm/full body),
        // `compacted_at` stamps it, and `original_bytes` records what was
        // reclaimed. `body_hash` is NEVER touched — it stays the ORIGINAL (the
        // tamper-evident fact the ledger commits to, and the dedup key), so the
        // chain and every bundle stay verifiable after the words are released.
        let _ = conn.execute("ALTER TABLE prompts ADD COLUMN gist TEXT", []);
        let _ = conn.execute("ALTER TABLE prompts ADD COLUMN compacted_at INTEGER", []);
        let _ = conn.execute("ALTER TABLE prompts ADD COLUMN original_bytes INTEGER", []);

        // Migration: comment ids are session-scoped (`c-001` restarts per
        // session), but legacy databases declared `id TEXT PRIMARY KEY`
        // (globally unique), which made every new session fail with
        // "UNIQUE constraint failed: comments.id" on its first comment.
        // Rebuild the table with a composite primary key `(session_id, id)`.
        // The additive ALTERs above run first, so the legacy table is
        // guaranteed to have all 14 columns before we copy.
        let legacy_pk: bool = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'comments'",
                [],
                |row| row.get::<_, String>(0),
            )
            .map(|sql| sql.contains("id TEXT PRIMARY KEY"))
            .unwrap_or(false);
        if legacy_pk {
            conn.execute_batch(
                r#"
                BEGIN;
                CREATE TABLE comments_new (
                    id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    version_number INTEGER NOT NULL,
                    type TEXT NOT NULL,
                    scope TEXT,
                    anchor_id TEXT NOT NULL,
                    body TEXT NOT NULL,
                    edit_original TEXT,
                    edit_revised TEXT,
                    created_at INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    resolution_body TEXT,
                    resolution_version INTEGER,
                    resolution_accepted_at INTEGER,
                    PRIMARY KEY (session_id, id),
                    FOREIGN KEY (session_id, version_number)
                        REFERENCES revisions(session_id, version_number) ON DELETE CASCADE
                );
                INSERT INTO comments_new (
                    id, session_id, version_number, type, scope, anchor_id,
                    body, edit_original, edit_revised, created_at, status,
                    resolution_body, resolution_version, resolution_accepted_at
                )
                SELECT
                    id, session_id, version_number, type, scope, anchor_id,
                    body, edit_original, edit_revised, created_at, status,
                    resolution_body, resolution_version, resolution_accepted_at
                FROM comments;
                DROP TABLE comments;
                ALTER TABLE comments_new RENAME TO comments;
                COMMIT;
                "#,
            )?;
        }
        // Stable block identity for editor-originated comments (Milestone C).
        // Added after the legacy rebuild so both fresh and rebuilt `comments`
        // tables gain it; idempotent (error on existing column ignored).
        let _ = conn.execute("ALTER TABLE comments ADD COLUMN block_id TEXT", []);
        // Whole-block structural payload, JSON-encoded (Milestone D).
        let _ = conn.execute("ALTER TABLE comments ADD COLUMN structural_json TEXT", []);
        // Review-thread boundary. Legacy rows default to 1 (thread start) so an
        // upgraded DB renders prior plans clean rather than as spurious redline.
        let _ = conn.execute(
            "ALTER TABLE revisions ADD COLUMN thread_start INTEGER NOT NULL DEFAULT 1",
            [],
        );
        // Restore marker. Legacy rows default to 0 (not a restore) so an
        // upgraded DB renders exactly as before.
        let _ = conn.execute(
            "ALTER TABLE revisions ADD COLUMN restored INTEGER NOT NULL DEFAULT 0",
            [],
        );
        // Selection-anchor columns for the Word-style comment-highlight
        // feature (Part B). All three are NULL for pre-feature rows so the
        // editor simply skips painting a highlight — the comment still
        // appears in the sidebar with its block anchor.
        let _ = conn.execute(
            "ALTER TABLE comments ADD COLUMN sel_char_start INTEGER",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE comments ADD COLUMN sel_char_end INTEGER",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE comments ADD COLUMN sel_quoted_text TEXT",
            [],
        );
        // Fork-agent discussion threads (Phase 2): the Claude Code session id
        // of the comment's forked discussion, NULL until its first "Discuss"
        // turn. Added in the post-rebuild ALTER group so a rebuilt `comments`
        // table gains it too — the legacy rebuild's explicit-column
        // `INSERT … SELECT` runs earlier and would otherwise drop it.
        let _ = conn.execute(
            "ALTER TABLE comments ADD COLUMN fork_session_id TEXT",
            [],
        );
        // Sub-block-grained selection anchor (e.g. `blk-X.s3.w2-w4`). NULL
        // for pre-feature rows and for any selection that doesn't land on a
        // clean word / line / sentence boundary — the comment still has
        // `sel_char_start` / `sel_char_end` as its primary anchor, and the
        // resolver tiers through this id first when present.
        let _ = conn.execute(
            "ALTER TABLE comments ADD COLUMN sel_sub_block_id TEXT",
            [],
        );
        // Reopen continuity: the reviewer's pending follow-up note attached on
        // reopen, and a JSON array of archived prior reopen rounds. Both NULL/
        // empty for pre-feature rows. Post-rebuild ALTER group, same reasoning
        // as `fork_session_id` above.
        let _ = conn.execute(
            "ALTER TABLE comments ADD COLUMN reopen_note TEXT",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE comments ADD COLUMN reopen_history TEXT",
            [],
        );
        // A [question] the reviewer promoted into a plan-driving directive.
        // 0/NULL for every pre-feature row and every non-promoted comment.
        let _ = conn.execute(
            "ALTER TABLE comments ADD COLUMN actionable INTEGER NOT NULL DEFAULT 0",
            [],
        );
        // Agent-in-doc (M4): the agent id that proposed the comment (NULL for
        // every user-originated comment) and the in-place resolution of a
        // still-draft agent suggestion ("accepted"). Post-rebuild ALTER group,
        // same reasoning as `fork_session_id` above.
        let _ = conn.execute("ALTER TABLE comments ADD COLUMN author TEXT", []);
        let _ = conn.execute("ALTER TABLE comments ADD COLUMN agent_state TEXT", []);
        // Live-collab / Review Request attribution: the human reviewer a
        // comment came from ("John Doe"). NULL for every owner-originated
        // comment and every pre-collab row. Distinct from `author` (agent id).
        let _ = conn.execute("ALTER TABLE comments ADD COLUMN reviewer TEXT", []);
        // Persisted attach state: lets detachment survive app restarts and be
        // visible for background sessions (the live `held` flag is recomputed
        // from in-memory senders and tells nothing after a crash).
        let _ = conn.execute(
            "ALTER TABLE sessions ADD COLUMN attach_state TEXT NOT NULL DEFAULT 'idle'",
            [],
        );
        // Last-activity timestamp: the sidebar orders sessions by it. Bumped
        // on every revision/comment/thread message/status change. Legacy rows
        // (updated_at = 0) are backfilled from their latest revision — the
        // best recency proxy already on disk. Both statements are idempotent.
        let _ = conn.execute(
            "ALTER TABLE sessions ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0",
            [],
        );
        let _ = conn.execute(
            "UPDATE sessions SET updated_at = MAX(
                created_at,
                COALESCE((SELECT MAX(received_at) FROM revisions r
                          WHERE r.session_id = sessions.session_id), created_at)
             ) WHERE updated_at = 0",
            [],
        );
        Ok(())
    }

    /// Bump a session's last-activity timestamp. Takes the already-locked
    /// connection (the `Mutex` is not reentrant — never call `self.conn.lock()`
    /// here). `MAX` keeps the value monotonic under out-of-order events.
    fn touch_session(conn: &Connection, session_id: &str, at: i64) {
        let _ = conn.execute(
            "UPDATE sessions SET updated_at = MAX(updated_at, ?1) WHERE session_id = ?2",
            params![at, session_id],
        );
    }

    /// Test-only: force a session's `updated_at` back to 0 to simulate a row
    /// written by a pre-`updated_at` build (the migration backfill's target).
    #[cfg(test)]
    pub(crate) fn zero_updated_at(&self, session_id: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE sessions SET updated_at = 0 WHERE session_id = ?1",
            params![session_id],
        )
        .unwrap();
    }

    pub fn get_setting(&self, key: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .ok()
    }

    pub fn set_setting(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn upsert_session(&self, session: &ReviewSession) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO sessions (session_id, project_path, project_name, created_at, status, attach_state, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(session_id) DO UPDATE SET
                project_path = excluded.project_path,
                project_name = excluded.project_name,
                status = excluded.status,
                attach_state = excluded.attach_state,
                updated_at = MAX(sessions.updated_at, excluded.updated_at)",
            params![
                session.session_id,
                session.project_path,
                session.project_name,
                session.created_at,
                session_status_str(session.status),
                session.attach_state.as_str(),
                session.updated_at,
            ],
        )?;
        Ok(())
    }

    pub fn insert_revision(
        &self,
        session_id: &str,
        revision: &Revision,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO revisions (session_id, version_number, received_at, raw_plan_markdown, thread_start, restored)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(session_id, version_number) DO UPDATE SET
                received_at = excluded.received_at,
                raw_plan_markdown = excluded.raw_plan_markdown,
                thread_start = excluded.thread_start,
                restored = excluded.restored",
            params![
                session_id,
                revision.version_number,
                revision.received_at,
                revision.raw_plan_markdown,
                revision.thread_start as i64,
                revision.restored as i64,
            ],
        )?;
        Self::touch_session(&conn, session_id, revision.received_at);
        Ok(())
    }

    // ------------------------------------------------------------------
    // Polis ledger (Phase 1): prompt store + hash chain
    // ------------------------------------------------------------------

    /// Insert a prompt row, deduped on (body_hash, claude_session_id). Returns
    /// the new row id, or `None` if an identical prompt was already stored.
    pub fn insert_prompt(&self, p: &crate::ledger::PromptRow) -> rusqlite::Result<Option<i64>> {
        let conn = self.conn.lock().unwrap();
        let changed = conn.execute(
            "INSERT INTO prompts
                (ts, source, origin, surface, role, session_id, claude_session_id,
                 mission_id, project_path, body, body_hash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(body_hash, claude_session_id) DO NOTHING",
            params![
                p.ts,
                p.source,
                p.origin,
                p.surface,
                p.role,
                p.session_id,
                p.claude_session_id,
                p.mission_id,
                p.project_path,
                p.body,
                p.body_hash,
            ],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        Ok(Some(conn.last_insert_rowid()))
    }

    /// Fetch a stored prompt body by id. When the row has been compacted, the
    /// gist stands in for the released body — so every reader (the ledger pane
    /// viewer, the bundle join, the mirror, the context routes) transparently
    /// sees the gist and no caller has to special-case compaction.
    pub fn get_prompt_body(&self, id: i64) -> rusqlite::Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT COALESCE(gist, body) FROM prompts WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()
    }

    /// Compact a cold prompt: swap its stored body for `gist` and emit a
    /// `compaction` ledger event proving the swap. The original `body_hash`
    /// stays untouched (the tamper-evident fact + dedup key), so
    /// `verify_ledger_chain` and `verify_bundle` remain green — they are
    /// body-blind. Idempotent via the `gist IS NULL` guard: a re-compaction of
    /// an already-compacted row is a no-op returning `Ok(None)`. On success
    /// returns the new ledger seq. `reason` distinguishes an automatic gist
    /// (`"cold"`) from an explicit forget (`"forget"`).
    pub fn compact_prompt_body(
        &self,
        prompt_id: i64,
        gist: &str,
        reason: &str,
    ) -> rusqlite::Result<Option<i64>> {
        let conn = self.conn.lock().unwrap();
        // Read the original body + hash under the same lock, then swap — all
        // atomic with the ledger append below so the chain can't race.
        let row: Option<(String, String)> = conn
            .query_row(
                "SELECT body, body_hash FROM prompts WHERE id = ?1 AND gist IS NULL",
                params![prompt_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((body, body_hash)) = row else {
            return Ok(None); // no such warm prompt (already compacted, or gone)
        };
        let original_bytes = body.len() as i64;
        let ts = crate::ledger::now_millis();
        conn.execute(
            "UPDATE prompts
                SET gist = ?2, body = '', compacted_at = ?3, original_bytes = ?4
             WHERE id = ?1 AND gist IS NULL",
            params![prompt_id, gist, ts, original_bytes],
        )?;
        // The compaction event references the prompt and pins the ORIGINAL body
        // hash + the gist hash + the reason, so "what was forgotten" is provable
        // even if the prompt row is later purged.
        let gist_hash = crate::ledger::body_hash(gist);
        let ph = crate::ledger::decision_payload_hash(&[
            ("original_body_hash", &body_hash),
            ("gist_hash", &gist_hash),
            ("reason", reason),
        ]);
        let author = crate::ledger::local_author();
        let pid_str = prompt_id.to_string();
        let ev = Self::append_ledger_event_locked(
            &conn,
            &crate::ledger::LedgerAppend {
                kind: crate::ledger::EventKind::Compaction.as_str(),
                author: &author,
                ts,
                prompt_id: Some(prompt_id),
                session_id: None,
                version_number: None,
                ref_kind: Some("prompt"),
                ref_id: Some(pid_str.as_str()),
                payload_hash: &ph,
            },
        )?;
        Ok(Some(ev.seq))
    }

    /// Compaction candidates: warm prompts (`gist IS NULL`) at least `size_floor`
    /// bytes, each paired with an ACCEPTED class node it is linked into. A prompt
    /// links into a node by ledger seq (`class_links.target_id` = the prompt
    /// event's seq), so we resolve seq → `prompt_id` here. Returns
    /// `(prompt_id, byte_len, node_id)` rows — the keeper groups them by prompt
    /// and applies the cold/pinned/size interlocks in pure code. A prompt not yet
    /// classified into any node produces no rows (only classified-and-cold data
    /// is ever gisted).
    pub fn list_compaction_candidates(
        &self,
        size_floor: i64,
    ) -> rusqlite::Result<Vec<(i64, i64, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT p.id, LENGTH(CAST(p.body AS BLOB)) AS bytes, l.node_id
             FROM prompts p
             JOIN ledger_events le ON le.prompt_id = p.id AND le.kind = 'prompt'
             JOIN class_links l
               ON l.target_kind = 'prompt'
              AND CAST(l.target_id AS INTEGER) = le.seq
              AND l.status = 'accepted'
             WHERE p.gist IS NULL
               AND LENGTH(CAST(p.body AS BLOB)) >= ?1",
        )?;
        let rows = stmt.query_map(params![size_floor], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?))
        })?;
        rows.collect()
    }

    /// Fetch the full (uncompacted) bodies for a set of prompt ids — the input
    /// the keeper's summarizer (and its deterministic fallback) gist from. Only
    /// warm rows are returned; an already-compacted id is silently skipped.
    pub fn get_prompt_bodies(&self, ids: &[i64]) -> rusqlite::Result<Vec<(i64, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut out = Vec::with_capacity(ids.len());
        let mut stmt =
            conn.prepare("SELECT body FROM prompts WHERE id = ?1 AND gist IS NULL")?;
        for &id in ids {
            let body: Option<String> = stmt
                .query_row(params![id], |r| r.get(0))
                .optional()?;
            if let Some(b) = body {
                out.push((id, b));
            }
        }
        Ok(out)
    }

    /// Aggregate compaction stats for the memory pill/inspector:
    /// `(compacted_count, reclaimed_bytes, newest_compacted_at?)`.
    pub fn compaction_stats(&self) -> rusqlite::Result<(i64, i64, Option<i64>)> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(original_bytes), 0),
                    MAX(compacted_at)
             FROM prompts WHERE gist IS NOT NULL",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
    }

    // -----------------------------------------------------------------------
    // Phase 4 — context access + portability (routes / export / mirror)
    // -----------------------------------------------------------------------

    /// Filtered prompt query backing `GET /v1/context/prompts`. Every optional
    /// filter is ANDed; the free-text `substring` is bound (never string-
    /// interpolated) so an injection-shaped `q` can only ever LIKE-match, not
    /// alter the SQL. Oldest-first, capped at `limit`.
    pub fn list_context_prompts(
        &self,
        f: &crate::context::PromptFilters,
    ) -> rusqlite::Result<Vec<crate::classmem::LakeItem>> {
        let conn = self.conn.lock().unwrap();
        // Build a parameterized WHERE; each clause pushes a bound value so no
        // caller string ever reaches the SQL text.
        let mut sql = String::from(
            "SELECT le.seq, le.ts, le.kind, le.ref_kind, le.ref_id, le.session_id,
                    p.surface, p.origin, p.role, p.mission_id, p.project_path, p.body
             FROM prompts p
             JOIN ledger_events le ON le.prompt_id = p.id
             WHERE 1 = 1",
        );
        let mut binds: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(s) = f.session_id.as_deref().filter(|s| !s.is_empty()) {
            sql.push_str(" AND p.session_id = ?");
            binds.push(Box::new(s.to_string()));
        }
        if let Some(m) = f.mission_id.as_deref().filter(|s| !s.is_empty()) {
            sql.push_str(" AND p.mission_id = ?");
            binds.push(Box::new(m.to_string()));
        }
        if let Some(s) = f.surface.as_deref().filter(|s| !s.is_empty()) {
            sql.push_str(" AND p.surface = ?");
            binds.push(Box::new(s.to_string()));
        }
        if let Some(p) = f.project.as_deref().filter(|s| !s.is_empty()) {
            sql.push_str(" AND p.project_path = ?");
            binds.push(Box::new(p.to_string()));
        }
        if let Some(seq) = f.since_seq {
            sql.push_str(" AND le.seq > ?");
            binds.push(Box::new(seq.max(0)));
        }
        if let Some(q) = f.substring.as_deref().filter(|s| !s.is_empty()) {
            // Escape LIKE metacharacters so the query text is matched literally.
            let escaped = q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
            sql.push_str(" AND p.body LIKE ? ESCAPE '\\'");
            binds.push(Box::new(format!("%{escaped}%")));
        }
        sql.push_str(" ORDER BY le.seq ASC LIMIT ?");
        binds.push(Box::new(f.limit.max(1)));

        let mut stmt = conn.prepare(&sql)?;
        let refs: Vec<&dyn rusqlite::ToSql> = binds.iter().map(|b| b.as_ref()).collect();
        let rows = stmt.query_map(refs.as_slice(), |r| {
            let body: Option<String> = r.get(11)?;
            Ok(crate::classmem::LakeItem {
                seq: r.get(0)?,
                ts: r.get(1)?,
                kind: r.get(2)?,
                ref_kind: r.get(3)?,
                ref_id: r.get(4)?,
                session_id: r.get(5)?,
                surface: r.get(6)?,
                origin: r.get(7)?,
                role: r.get(8)?,
                mission_id: r.get(9)?,
                project_path: r.get(10)?,
                body: body.map(|b| {
                    if b.chars().count() > 4000 {
                        b.chars().take(4000).collect::<String>() + "…"
                    } else {
                        b
                    }
                }),
            })
        })?;
        rows.collect()
    }

    /// All ledger events tied to a session (`session_id` column match),
    /// oldest-first — the decision-event spine of `GET /v1/context/sessions/:id/
    /// history`. Prompt, revision, and decision events all carry `session_id`.
    pub fn list_session_events(
        &self,
        session_id: &str,
    ) -> rusqlite::Result<Vec<crate::ledger::LedgerEventRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT seq, ts, kind, author, prompt_id, session_id, version_number,
                    ref_kind, ref_id, payload_hash, prev_hash, entry_hash
             FROM ledger_events WHERE session_id = ?1 ORDER BY seq ASC",
        )?;
        let rows = stmt.query_map(params![session_id], Self::row_to_ledger_event)?;
        rows.collect()
    }

    /// Every ledger event, oldest-first, optionally after `since_seq` — the
    /// ordered spine an export bundle / mirror walks. `limit` caps a huge
    /// history. Ascending (unlike `list_ledger_events`, which is newest-first
    /// for the pane).
    pub fn list_ledger_events_asc(
        &self,
        since_seq: i64,
        limit: i64,
    ) -> rusqlite::Result<Vec<crate::ledger::LedgerEventRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT seq, ts, kind, author, prompt_id, session_id, version_number,
                    ref_kind, ref_id, payload_hash, prev_hash, entry_hash
             FROM ledger_events WHERE seq > ?1 ORDER BY seq ASC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![since_seq.max(0), limit.max(0)], Self::row_to_ledger_event)?;
        rows.collect()
    }

    /// Shared row→`LedgerEventRow` mapper (the column order every ledger SELECT
    /// above uses), so the three readers can't drift.
    fn row_to_ledger_event(r: &rusqlite::Row) -> rusqlite::Result<crate::ledger::LedgerEventRow> {
        Ok(crate::ledger::LedgerEventRow {
            seq: r.get(0)?,
            ts: r.get(1)?,
            kind: r.get(2)?,
            author: r.get(3)?,
            prompt_id: r.get(4)?,
            session_id: r.get(5)?,
            version_number: r.get(6)?,
            ref_kind: r.get(7)?,
            ref_id: r.get(8)?,
            payload_hash: r.get(9)?,
            prev_hash: r.get(10)?,
            entry_hash: r.get(11)?,
        })
    }

    /// Prompt ids captured under a mission — the mission-scope filter for export
    /// bundles (ledger_events has no `mission_id`; the prompt row carries it).
    pub fn mission_prompt_ids(&self, mission_id: &str) -> rusqlite::Result<Vec<i64>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id FROM prompts WHERE mission_id = ?1")?;
        let rows = stmt.query_map(params![mission_id], |r| r.get::<_, i64>(0))?;
        rows.collect()
    }

    /// The raw markdown of one revision (the body a `revision` ledger event
    /// references but does not own) — for snapshotting into a mirror note /
    /// export bundle at write time.
    pub fn revision_markdown(
        &self,
        session_id: &str,
        version_number: i64,
    ) -> rusqlite::Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT raw_plan_markdown FROM revisions WHERE session_id = ?1 AND version_number = ?2",
            params![session_id, version_number],
            |r| r.get(0),
        )
        .optional()
    }

    /// Enriched ledger events (ascending, after `since_seq`) for the portable
    /// mirror: each event joined to its prompt provenance + full body. Revision
    /// bodies (`revisions.raw_plan_markdown`) are joined by the mirror writer,
    /// not here (a `revision` event has no `prompt_id`).
    pub fn list_mirror_events(
        &self,
        since_seq: i64,
        limit: i64,
    ) -> rusqlite::Result<Vec<crate::mirror::MirrorRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT le.seq, le.ts, le.kind, le.author, le.prompt_id, le.session_id,
                    le.version_number, le.ref_kind, le.ref_id, le.payload_hash,
                    le.prev_hash, le.entry_hash,
                    p.surface, p.origin, p.role, p.mission_id, p.project_path, p.body
             FROM ledger_events le
             LEFT JOIN prompts p ON le.prompt_id = p.id
             WHERE le.seq > ?1 ORDER BY le.seq ASC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![since_seq.max(0), limit.max(0)], |r| {
            Ok(crate::mirror::MirrorRow {
                event: crate::ledger::LedgerEventRow {
                    seq: r.get(0)?,
                    ts: r.get(1)?,
                    kind: r.get(2)?,
                    author: r.get(3)?,
                    prompt_id: r.get(4)?,
                    session_id: r.get(5)?,
                    version_number: r.get(6)?,
                    ref_kind: r.get(7)?,
                    ref_id: r.get(8)?,
                    payload_hash: r.get(9)?,
                    prev_hash: r.get(10)?,
                    entry_hash: r.get(11)?,
                },
                surface: r.get(12)?,
                origin: r.get(13)?,
                role: r.get(14)?,
                mission_id: r.get(15)?,
                project_path: r.get(16)?,
                body: r.get(17)?,
            })
        })?;
        rows.collect()
    }

    /// Prompt counts grouped by UTC day (`YYYY-MM-DD`), oldest day first —
    /// `/v1/context/stats` day histogram.
    pub fn prompt_counts_by_day(&self) -> rusqlite::Result<Vec<(String, i64)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch') AS day, COUNT(*)
             FROM prompts GROUP BY day ORDER BY day ASC",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        rows.collect()
    }

    /// Prompt counts grouped by capture surface — `/v1/context/stats`.
    pub fn prompt_counts_by_surface(&self) -> rusqlite::Result<Vec<(String, i64)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT surface, COUNT(*) FROM prompts GROUP BY surface ORDER BY COUNT(*) DESC",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        rows.collect()
    }

    /// Ledger event counts grouped by kind — `/v1/context/stats`.
    pub fn event_counts_by_kind(&self) -> rusqlite::Result<Vec<(String, i64)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT kind, COUNT(*) FROM ledger_events GROUP BY kind ORDER BY COUNT(*) DESC",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        rows.collect()
    }

    /// Accepted-class-node counts per root class (title → linked-item count
    /// rolled over the whole subtree) — the "class" axis of `/v1/context/stats`.
    /// Roots only; a repo-less lake yields just `~general`.
    pub fn class_link_counts_by_root(&self) -> rusqlite::Result<Vec<(String, i64)>> {
        let nodes = self.list_class_nodes_with_counts()?;
        // Map node → (parent, title, own link count).
        let mut parent: std::collections::HashMap<String, Option<String>> = std::collections::HashMap::new();
        let mut title: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        let mut own: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
        for (n, c) in &nodes {
            parent.insert(n.id.clone(), n.parent_id.clone());
            title.insert(n.id.clone(), n.title.clone());
            own.insert(n.id.clone(), *c);
        }
        // Roll each node's own count up to its root.
        let root_of = |mut id: String| -> Option<String> {
            for _ in 0..64 {
                match parent.get(&id) {
                    Some(Some(p)) => id = p.clone(),
                    Some(None) => return Some(id),
                    None => return None,
                }
            }
            None
        };
        let mut totals: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
        for (id, c) in &own {
            if let Some(root) = root_of(id.clone()) {
                *totals.entry(root).or_insert(0) += *c;
            }
        }
        let mut out: Vec<(String, i64)> = totals
            .into_iter()
            .map(|(root, c)| (title.get(&root).cloned().unwrap_or(root), c))
            .collect();
        out.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        Ok(out)
    }

    /// Record that a session was exported as a portable bundle (backs the
    /// Librarian's F6 signal). Idempotent per `(session_id, scope)` — a
    /// re-export refreshes `head_hash`/`exported_at`.
    pub fn record_plan_export(
        &self,
        session_id: &str,
        scope: &str,
        head_hash: Option<&str>,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO plan_exports (session_id, scope, head_hash, exported_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(session_id, scope) DO UPDATE SET
                head_hash = excluded.head_hash,
                exported_at = excluded.exported_at",
            params![session_id, scope, head_hash, crate::ledger::now_millis()],
        )?;
        Ok(())
    }

    /// Approved sessions that have never been exported as a bundle — the
    /// Librarian's deferred F6 "un-exported approved plan" friction, now real.
    /// Returns `(session_id, project_name, approved_at)`, oldest first.
    pub fn un_exported_approved_sessions(&self) -> rusqlite::Result<Vec<(String, String, i64)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT s.session_id, s.project_name, s.created_at
             FROM sessions s
             WHERE s.status = 'approved'
               AND NOT EXISTS (
                   SELECT 1 FROM plan_exports e
                   WHERE e.session_id = s.session_id
               )
             ORDER BY s.created_at ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
        })?;
        rows.collect()
    }

    /// Append an event to the hash chain. Reads the current head under the write
    /// lock, computes `entry_hash = sha256(prev_hash ‖ canonical(event))`, and
    /// inserts with an explicit monotonic `seq` — all atomic under the single
    /// `Mutex<Connection>` writer, so the chain can't race.
    pub fn append_ledger_event(
        &self,
        a: &crate::ledger::LedgerAppend,
    ) -> rusqlite::Result<crate::ledger::LedgerEventRow> {
        let conn = self.conn.lock().unwrap();
        Self::append_ledger_event_locked(&conn, a)
    }

    /// The append core, callable with an already-held connection lock so a
    /// caller that mutates a row and appends its proof event (e.g.
    /// `compact_prompt_body`) does both atomically without re-locking.
    fn append_ledger_event_locked(
        conn: &rusqlite::Connection,
        a: &crate::ledger::LedgerAppend,
    ) -> rusqlite::Result<crate::ledger::LedgerEventRow> {
        let head: Option<(i64, String)> = conn
            .query_row(
                "SELECT seq, entry_hash FROM ledger_events ORDER BY seq DESC LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let (prev_seq, prev_hash) = head.unwrap_or((0, crate::ledger::GENESIS_PREV.to_string()));
        let seq = prev_seq + 1;
        let canon = crate::ledger::CanonicalEvent {
            seq,
            ts: a.ts,
            kind: a.kind,
            author: a.author,
            prompt_id: a.prompt_id,
            session_id: a.session_id,
            version_number: a.version_number,
            ref_kind: a.ref_kind,
            ref_id: a.ref_id,
            payload_hash: a.payload_hash,
        };
        let entry_hash = crate::ledger::compute_entry_hash(&prev_hash, &canon);
        conn.execute(
            "INSERT INTO ledger_events
                (seq, ts, kind, author, prompt_id, session_id, version_number,
                 ref_kind, ref_id, payload_hash, prev_hash, entry_hash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                seq,
                a.ts,
                a.kind,
                a.author,
                a.prompt_id,
                a.session_id,
                a.version_number,
                a.ref_kind,
                a.ref_id,
                a.payload_hash,
                prev_hash,
                entry_hash,
            ],
        )?;
        Ok(crate::ledger::LedgerEventRow {
            seq,
            ts: a.ts,
            kind: a.kind.to_string(),
            author: a.author.to_string(),
            prompt_id: a.prompt_id,
            session_id: a.session_id.map(str::to_string),
            version_number: a.version_number,
            ref_kind: a.ref_kind.map(str::to_string),
            ref_id: a.ref_id.map(str::to_string),
            payload_hash: a.payload_hash.to_string(),
            prev_hash,
            entry_hash,
        })
    }

    /// Most-recent-first ledger events, capped at `limit`.
    pub fn list_ledger_events(
        &self,
        limit: i64,
    ) -> rusqlite::Result<Vec<crate::ledger::LedgerEventRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT seq, ts, kind, author, prompt_id, session_id, version_number,
                    ref_kind, ref_id, payload_hash, prev_hash, entry_hash
             FROM ledger_events ORDER BY seq DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], |r| {
            Ok(crate::ledger::LedgerEventRow {
                seq: r.get(0)?,
                ts: r.get(1)?,
                kind: r.get(2)?,
                author: r.get(3)?,
                prompt_id: r.get(4)?,
                session_id: r.get(5)?,
                version_number: r.get(6)?,
                ref_kind: r.get(7)?,
                ref_id: r.get(8)?,
                payload_hash: r.get(9)?,
                prev_hash: r.get(10)?,
                entry_hash: r.get(11)?,
            })
        })?;
        rows.collect()
    }

    /// True if a revision event for this (session, version) already exists with
    /// the same payload hash — the idempotency guard for the revision path.
    pub fn revision_event_exists(
        &self,
        session_id: &str,
        version_number: i64,
        payload_hash: &str,
    ) -> rusqlite::Result<bool> {
        let conn = self.conn.lock().unwrap();
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM ledger_events
             WHERE kind = 'revision' AND session_id = ?1
               AND version_number = ?2 AND payload_hash = ?3",
            params![session_id, version_number, payload_hash],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }

    /// True if an identical decision event already exists — idempotency guard
    /// for the decision path.
    pub fn decision_event_exists(
        &self,
        kind: &str,
        ref_kind: &str,
        ref_id: &str,
        payload_hash: &str,
    ) -> rusqlite::Result<bool> {
        let conn = self.conn.lock().unwrap();
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM ledger_events
             WHERE kind = ?1 AND ref_kind = ?2 AND ref_id = ?3 AND payload_hash = ?4",
            params![kind, ref_kind, ref_id, payload_hash],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }

    /// Re-walk the whole chain, recomputing each `entry_hash` from stored fields
    /// and checking `prev_hash` linkage. Reports the first seq that fails.
    pub fn verify_ledger_chain(&self) -> rusqlite::Result<crate::ledger::ChainVerdict> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT seq, ts, kind, author, prompt_id, session_id, version_number,
                    ref_kind, ref_id, payload_hash, prev_hash, entry_hash
             FROM ledger_events ORDER BY seq ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(crate::ledger::LedgerEventRow {
                seq: r.get(0)?,
                ts: r.get(1)?,
                kind: r.get(2)?,
                author: r.get(3)?,
                prompt_id: r.get(4)?,
                session_id: r.get(5)?,
                version_number: r.get(6)?,
                ref_kind: r.get(7)?,
                ref_id: r.get(8)?,
                payload_hash: r.get(9)?,
                prev_hash: r.get(10)?,
                entry_hash: r.get(11)?,
            })
        })?;

        let mut prev = crate::ledger::GENESIS_PREV.to_string();
        let mut checked = 0i64;
        let mut head = None;
        for row in rows {
            let e = row?;
            // Linkage: this row must commit to its actual predecessor.
            if e.prev_hash != prev {
                return Ok(crate::ledger::ChainVerdict {
                    ok: false,
                    checked,
                    first_bad_seq: Some(e.seq),
                    head_hash: None,
                });
            }
            let canon = crate::ledger::CanonicalEvent {
                seq: e.seq,
                ts: e.ts,
                kind: &e.kind,
                author: &e.author,
                prompt_id: e.prompt_id,
                session_id: e.session_id.as_deref(),
                version_number: e.version_number,
                ref_kind: e.ref_kind.as_deref(),
                ref_id: e.ref_id.as_deref(),
                payload_hash: &e.payload_hash,
            };
            let recomputed = crate::ledger::compute_entry_hash(&e.prev_hash, &canon);
            if recomputed != e.entry_hash {
                return Ok(crate::ledger::ChainVerdict {
                    ok: false,
                    checked,
                    first_bad_seq: Some(e.seq),
                    head_hash: None,
                });
            }
            prev = e.entry_hash.clone();
            head = Some(e.entry_hash);
            checked += 1;
        }
        Ok(crate::ledger::ChainVerdict {
            ok: true,
            checked,
            first_bad_seq: None,
            head_hash: head,
        })
    }

    /// Snapshot the whole database to `dest` via `VACUUM INTO` (a consistent
    /// copy even while the app runs). The crown-jewels backup that protects the
    /// chain itself; mirror/export are secondary content copies.
    pub fn snapshot_to(&self, dest: &Path) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        // VACUUM INTO requires the destination not already exist.
        let _ = std::fs::remove_file(dest);
        conn.execute("VACUUM INTO ?1", params![dest.to_string_lossy()])?;
        Ok(())
    }

    // ------------------------------------------------------------------
    // Polis ClassMemory (Phase 2): the catalog over the lake
    // ------------------------------------------------------------------

    /// Seed one proposed root per (id, title, project_path), idempotent — a root
    /// that already exists (by id) is left untouched, so re-seeding never
    /// re-proposes an already-accepted class. Returns how many were newly seeded.
    pub fn seed_class_roots(
        &self,
        rows: &[(String, String, Option<String>)],
    ) -> rusqlite::Result<usize> {
        let conn = self.conn.lock().unwrap();
        let now = crate::ledger::now_millis();
        let mut seeded = 0;
        for (id, title, project) in rows {
            let changed = conn.execute(
                "INSERT INTO class_nodes
                    (id, parent_id, kind, title, summary, project_path, ip_name,
                     status, pinned, curated_by, created_at, updated_at)
                 VALUES (?1, NULL, 'node', ?2, NULL, ?3, NULL, 'proposed', 0,
                         'classifier', ?4, ?4)
                 ON CONFLICT(id) DO NOTHING",
                params![id, title, project, now],
            )?;
            seeded += changed;
        }
        Ok(seeded)
    }

    fn row_to_class_node(r: &rusqlite::Row) -> rusqlite::Result<crate::classmem::ClassNode> {
        Ok(crate::classmem::ClassNode {
            id: r.get(0)?,
            parent_id: r.get(1)?,
            kind: r.get(2)?,
            title: r.get(3)?,
            summary: r.get(4)?,
            project_path: r.get(5)?,
            ip_name: r.get(6)?,
            status: r.get(7)?,
            pinned: r.get::<_, i64>(8)? != 0,
            curated_by: r.get(9)?,
            created_at: r.get(10)?,
            updated_at: r.get(11)?,
        })
    }

    /// Every class node (proposed + accepted), for tree building in Rust.
    pub fn list_class_nodes(&self) -> rusqlite::Result<Vec<crate::classmem::ClassNode>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, parent_id, kind, title, summary, project_path, ip_name,
                    status, pinned, curated_by, created_at, updated_at
             FROM class_nodes ORDER BY title ASC",
        )?;
        let rows = stmt.query_map([], Self::row_to_class_node)?;
        rows.collect()
    }

    pub fn get_class_node(&self, id: &str) -> rusqlite::Result<Option<crate::classmem::ClassNode>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, parent_id, kind, title, summary, project_path, ip_name,
                    status, pinned, curated_by, created_at, updated_at
             FROM class_nodes WHERE id = ?1",
            params![id],
            Self::row_to_class_node,
        )
        .optional()
    }

    /// The links on one node (accepted + proposed).
    pub fn list_class_links_for_node(
        &self,
        node_id: &str,
    ) -> rusqlite::Result<Vec<crate::classmem::ClassLink>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, node_id, target_kind, target_id, note, status, created_at
             FROM class_links WHERE node_id = ?1 ORDER BY id ASC",
        )?;
        let rows = stmt.query_map(params![node_id], |r| {
            Ok(crate::classmem::ClassLink {
                id: r.get(0)?,
                node_id: r.get(1)?,
                target_kind: r.get(2)?,
                target_id: r.get(3)?,
                note: r.get(4)?,
                status: r.get(5)?,
                created_at: r.get(6)?,
            })
        })?;
        rows.collect()
    }

    /// Stage one parsed proposal as reviewable rows (never accepts). Additive
    /// proposals become `proposed` nodes/links; structural ones queue in
    /// `class_proposals`. See `classmem` for the accept path.
    pub fn stage_proposal(
        &self,
        run_id: Option<i64>,
        p: &crate::classmem::Proposal,
    ) -> rusqlite::Result<crate::classmem::StagedOutcome> {
        use crate::classmem::{Proposal, StagedOutcome};
        let conn = self.conn.lock().unwrap();
        let now = crate::ledger::now_millis();
        let exists = |id: &str| -> rusqlite::Result<bool> {
            let n: i64 = conn.query_row(
                "SELECT COUNT(*) FROM class_nodes WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )?;
            Ok(n > 0)
        };
        match p {
            Proposal::Create { parent_id, title, .. } => {
                if !exists(parent_id)? {
                    return Ok(StagedOutcome::Skipped);
                }
                // Don't re-propose an identical child.
                let dup: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM class_nodes WHERE parent_id = ?1 AND title = ?2",
                    params![parent_id, title],
                    |r| r.get(0),
                )?;
                if dup > 0 {
                    return Ok(StagedOutcome::Skipped);
                }
                let id = crate::classmem::new_node_id();
                conn.execute(
                    "INSERT INTO class_nodes
                        (id, parent_id, kind, title, summary, project_path, ip_name,
                         status, pinned, curated_by, created_at, updated_at)
                     VALUES (?1, ?2, 'node', ?3, NULL, NULL, NULL, 'proposed', 0,
                             'classifier', ?4, ?4)",
                    params![id, parent_id, title, now],
                )?;
                Ok(StagedOutcome::Node)
            }
            Proposal::File {
                parent_id,
                sub_class,
                target_kind,
                target_id,
                note,
                ..
            } => {
                if !exists(parent_id)? {
                    return Ok(StagedOutcome::Skipped);
                }
                let mut created_node = false;
                // Resolve (or stage) the node the link attaches to.
                let target_node = match sub_class {
                    Some(sc) if !sc.trim().is_empty() => {
                        let existing: Option<String> = conn
                            .query_row(
                                "SELECT id FROM class_nodes WHERE parent_id = ?1 AND title = ?2 LIMIT 1",
                                params![parent_id, sc.trim()],
                                |r| r.get(0),
                            )
                            .optional()?;
                        match existing {
                            Some(id) => id,
                            None => {
                                let id = crate::classmem::new_node_id();
                                conn.execute(
                                    "INSERT INTO class_nodes
                                        (id, parent_id, kind, title, summary, project_path,
                                         ip_name, status, pinned, curated_by, created_at, updated_at)
                                     VALUES (?1, ?2, 'node', ?3, NULL, NULL, NULL, 'proposed', 0,
                                             'classifier', ?4, ?4)",
                                    params![id, parent_id, sc.trim(), now],
                                )?;
                                created_node = true;
                                id
                            }
                        }
                    }
                    _ => parent_id.clone(),
                };
                let changed = conn.execute(
                    "INSERT INTO class_links
                        (node_id, target_kind, target_id, note, status, created_at)
                     VALUES (?1, ?2, ?3, ?4, 'proposed', ?5)
                     ON CONFLICT(node_id, target_kind, target_id) DO NOTHING",
                    params![target_node, target_kind, target_id, note, now],
                )?;
                if changed == 0 && !created_node {
                    return Ok(StagedOutcome::Skipped);
                }
                Ok(StagedOutcome::Link { created_node })
            }
            Proposal::Promote { node_id, new_parent_id, rationale } => {
                if !exists(node_id)? {
                    return Ok(StagedOutcome::Skipped);
                }
                self.insert_structural_locked(
                    &conn, run_id, "promote", Some(node_id), new_parent_id.as_deref(),
                    None, None, None, rationale.as_deref(), now,
                )?;
                Ok(StagedOutcome::Structural)
            }
            Proposal::Split { node_id, into, rationale } => {
                if !exists(node_id)? {
                    return Ok(StagedOutcome::Skipped);
                }
                let extra = serde_json::to_string(into).unwrap_or_else(|_| "[]".into());
                self.insert_structural_locked(
                    &conn, run_id, "split", Some(node_id), None, None, None,
                    Some(&extra), rationale.as_deref(), now,
                )?;
                Ok(StagedOutcome::Structural)
            }
            Proposal::Merge { node_ids, title, parent_id, rationale } => {
                // Every referenced node must exist.
                for id in node_ids {
                    if !exists(id)? {
                        return Ok(StagedOutcome::Skipped);
                    }
                }
                let extra = serde_json::to_string(node_ids).unwrap_or_else(|_| "[]".into());
                self.insert_structural_locked(
                    &conn, run_id, "merge", node_ids.first().map(String::as_str),
                    parent_id.as_deref(), title.as_deref(), None,
                    Some(&extra), rationale.as_deref(), now,
                )?;
                Ok(StagedOutcome::Structural)
            }
            Proposal::Collapse { node_id, summary, cite_seqs, rationale } => {
                if !exists(node_id)? {
                    return Ok(StagedOutcome::Skipped);
                }
                let extra = serde_json::to_string(cite_seqs).unwrap_or_else(|_| "[]".into());
                self.insert_structural_locked(
                    &conn, run_id, "collapse", Some(node_id), None, None,
                    Some(summary), Some(&extra), rationale.as_deref(), now,
                )?;
                Ok(StagedOutcome::Structural)
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_structural_locked(
        &self,
        conn: &rusqlite::Connection,
        run_id: Option<i64>,
        op: &str,
        node_id: Option<&str>,
        parent_id: Option<&str>,
        title: Option<&str>,
        summary: Option<&str>,
        extra_json: Option<&str>,
        rationale: Option<&str>,
        now: i64,
    ) -> rusqlite::Result<()> {
        conn.execute(
            "INSERT INTO class_proposals
                (run_id, op, node_id, parent_id, title, summary, extra_json,
                 rationale, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'proposed', ?9)",
            params![run_id, op, node_id, parent_id, title, summary, extra_json, rationale, now],
        )?;
        Ok(())
    }

    /// Accept a proposed node and any proposed ancestors (so no accepted node is
    /// ever orphaned under a proposed parent). Returns the ids newly flipped to
    /// accepted (for ledger events). Idempotent on already-accepted nodes.
    pub fn accept_class_node(&self, id: &str) -> rusqlite::Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        Self::accept_node_chain(&conn, id)
    }

    fn accept_node_chain(conn: &rusqlite::Connection, id: &str) -> rusqlite::Result<Vec<String>> {
        let now = crate::ledger::now_millis();
        let mut flipped = Vec::new();
        let mut cur = Some(id.to_string());
        let mut guard = 0;
        while let Some(nid) = cur {
            guard += 1;
            if guard > 32 {
                break;
            }
            let row: Option<(Option<String>, String)> = conn
                .query_row(
                    "SELECT parent_id, status FROM class_nodes WHERE id = ?1",
                    params![nid],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let Some((parent, status)) = row else { break };
            if status == "proposed" {
                conn.execute(
                    "UPDATE class_nodes SET status = 'accepted', curated_by = ?2, updated_at = ?3 WHERE id = ?1",
                    params![nid, crate::ledger::local_author(), now],
                )?;
                flipped.push(nid.clone());
            }
            cur = parent;
        }
        Ok(flipped)
    }

    /// Accept EVERY currently-proposed node and link in one shot — the
    /// auto-organize path (Organize applies the classifier's work directly
    /// rather than gating it behind per-item review). Returns the node ids that
    /// were flipped, so the caller can emit their `class_curate` ledger events.
    /// Structural proposals are applied separately (see `apply_class_proposal`).
    pub fn accept_all_pending(&self) -> rusqlite::Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let now = crate::ledger::now_millis();
        let author = crate::ledger::local_author();
        let mut stmt = conn.prepare("SELECT id FROM class_nodes WHERE status = 'proposed'")?;
        let ids: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<_>>()?;
        drop(stmt);
        conn.execute(
            "UPDATE class_nodes SET status = 'accepted', curated_by = ?1, updated_at = ?2
             WHERE status = 'proposed'",
            params![author, now],
        )?;
        conn.execute(
            "UPDATE class_links SET status = 'accepted' WHERE status = 'proposed'",
            [],
        )?;
        Ok(ids)
    }

    /// Accept a proposed link, ensuring its node (and ancestors) are accepted.
    /// Returns (node_id, newly-accepted ancestor node ids).
    pub fn accept_class_link(&self, link_id: i64) -> rusqlite::Result<Option<(String, Vec<String>)>> {
        let conn = self.conn.lock().unwrap();
        let node_id: Option<String> = conn
            .query_row(
                "SELECT node_id FROM class_links WHERE id = ?1",
                params![link_id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(node_id) = node_id else { return Ok(None) };
        conn.execute(
            "UPDATE class_links SET status = 'accepted' WHERE id = ?1",
            params![link_id],
        )?;
        let flipped = Self::accept_node_chain(&conn, &node_id)?;
        Ok(Some((node_id, flipped)))
    }

    /// Reject (delete) a node and its whole proposed/accepted subtree + links.
    /// Used to reject a proposed node; also the cleanup primitive for merges.
    pub fn reject_class_node(&self, id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        Self::delete_node_subtree(&conn, id)
    }

    fn delete_node_subtree(conn: &rusqlite::Connection, id: &str) -> rusqlite::Result<()> {
        // Gather the subtree (BFS) so we delete children before/with the root.
        let mut stack = vec![id.to_string()];
        let mut all = Vec::new();
        let mut guard = 0;
        while let Some(nid) = stack.pop() {
            guard += 1;
            if guard > 10_000 {
                break;
            }
            all.push(nid.clone());
            let mut stmt =
                conn.prepare("SELECT id FROM class_nodes WHERE parent_id = ?1")?;
            let kids: Vec<String> = stmt
                .query_map(params![nid], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<_>>()?;
            stack.extend(kids);
        }
        for nid in &all {
            conn.execute("DELETE FROM class_links WHERE node_id = ?1", params![nid])?;
            conn.execute("DELETE FROM class_nodes WHERE id = ?1", params![nid])?;
        }
        Ok(())
    }

    pub fn reject_class_link(&self, link_id: i64) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM class_links WHERE id = ?1", params![link_id])?;
        Ok(())
    }

    pub fn set_class_node_pinned(&self, id: &str, pinned: bool) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE class_nodes SET pinned = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, pinned as i64, crate::ledger::now_millis()],
        )?;
        Ok(())
    }

    pub fn rename_class_node(&self, id: &str, title: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE class_nodes SET title = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, title, crate::ledger::now_millis()],
        )?;
        Ok(())
    }

    fn row_to_proposal(r: &rusqlite::Row) -> rusqlite::Result<crate::classmem::ClassProposalRow> {
        Ok(crate::classmem::ClassProposalRow {
            id: r.get(0)?,
            run_id: r.get(1)?,
            op: r.get(2)?,
            node_id: r.get(3)?,
            parent_id: r.get(4)?,
            title: r.get(5)?,
            summary: r.get(6)?,
            extra_json: r.get(7)?,
            rationale: r.get(8)?,
            status: r.get(9)?,
            created_at: r.get(10)?,
        })
    }

    /// The pending structural proposals (promote/split/merge/collapse).
    pub fn list_class_proposals(&self) -> rusqlite::Result<Vec<crate::classmem::ClassProposalRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, run_id, op, node_id, parent_id, title, summary, extra_json,
                    rationale, status, created_at
             FROM class_proposals WHERE status = 'proposed' ORDER BY id ASC",
        )?;
        let rows = stmt.query_map([], Self::row_to_proposal)?;
        rows.collect()
    }

    pub fn get_class_proposal(
        &self,
        id: i64,
    ) -> rusqlite::Result<Option<crate::classmem::ClassProposalRow>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, run_id, op, node_id, parent_id, title, summary, extra_json,
                    rationale, status, created_at
             FROM class_proposals WHERE id = ?1",
            params![id],
            Self::row_to_proposal,
        )
        .optional()
    }

    pub fn reject_class_proposal(&self, id: i64) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM class_proposals WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Apply (accept) a structural proposal: mutate the accepted tree and drop
    /// the proposal row. Returns the facts for the `taxonomy_reorg` ledger event.
    /// Promotion re-parents preserving id/links/pins/subtree; collapse creates a
    /// digest node citing exact ledger seqs and removes the cold subtree.
    pub fn apply_class_proposal(
        &self,
        id: i64,
    ) -> rusqlite::Result<Option<crate::classmem::AppliedReorg>> {
        let p = match self.get_class_proposal(id)? {
            Some(p) => p,
            None => return Ok(None),
        };
        let conn = self.conn.lock().unwrap();
        let now = crate::ledger::now_millis();
        let detail: String = match p.op.as_str() {
            "promote" => {
                let node = p.node_id.clone().unwrap_or_default();
                // new_parent may be NULL → promote to a root.
                conn.execute(
                    "UPDATE class_nodes SET parent_id = ?2, updated_at = ?3 WHERE id = ?1",
                    params![node, p.parent_id, now],
                )?;
                format!("→ parent {}", p.parent_id.as_deref().unwrap_or("(root)"))
            }
            "collapse" => {
                let node = p.node_id.clone().unwrap_or_default();
                // Hard guard (covers the manual path too): pins are an absolute
                // anti-decay veto — never collapse a pinned branch. Drop the
                // proposal as a no-op; unpin first to collapse.
                if Self::subtree_pinned(&conn, &node)? {
                    self.drop_proposal_locked(&conn, id)?;
                    return Ok(None);
                }
                // Parent + title of the cold branch, for the digest placement.
                let (parent, title): (Option<String>, String) = conn.query_row(
                    "SELECT parent_id, title FROM class_nodes WHERE id = ?1",
                    params![node],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?;
                let digest_id = crate::classmem::new_node_id();
                let digest_title = p.title.clone().unwrap_or_else(|| format!("{title} (digest)"));
                conn.execute(
                    "INSERT INTO class_nodes
                        (id, parent_id, kind, title, summary, project_path, ip_name,
                         status, pinned, curated_by, created_at, updated_at)
                     VALUES (?1, ?2, 'digest', ?3, ?4, NULL, NULL, 'accepted', 0,
                             ?5, ?6, ?6)",
                    params![digest_id, parent, digest_title, p.summary, crate::ledger::local_author(), now],
                )?;
                // Citation links to the exact ledger seqs.
                if let Some(extra) = &p.extra_json {
                    if let Ok(seqs) = serde_json::from_str::<Vec<i64>>(extra) {
                        for seq in &seqs {
                            conn.execute(
                                "INSERT INTO class_links
                                    (node_id, target_kind, target_id, note, status, created_at)
                                 VALUES (?1, 'ledger', ?2, NULL, 'accepted', ?3)
                                 ON CONFLICT(node_id, target_kind, target_id) DO NOTHING",
                                params![digest_id, seq.to_string(), now],
                            )?;
                        }
                    }
                }
                // Remove the cold subtree (its sourcing now lives in the digest's
                // citations, one hop away).
                Self::delete_node_subtree(&conn, &node)?;
                format!("digest {digest_id}")
            }
            "merge" => {
                let ids: Vec<String> = p
                    .extra_json
                    .as_deref()
                    .and_then(|e| serde_json::from_str(e).ok())
                    .unwrap_or_default();
                if ids.is_empty() {
                    self.drop_proposal_locked(&conn, id)?;
                    return Ok(None);
                }
                let target = ids[0].clone();
                if let Some(t) = &p.title {
                    conn.execute(
                        "UPDATE class_nodes SET title = ?2, updated_at = ?3 WHERE id = ?1",
                        params![target, t, now],
                    )?;
                }
                if let Some(parent) = &p.parent_id {
                    conn.execute(
                        "UPDATE class_nodes SET parent_id = ?2, updated_at = ?3 WHERE id = ?1",
                        params![target, parent, now],
                    )?;
                }
                for other in ids.iter().skip(1) {
                    // Move links and children onto the target, then delete it.
                    conn.execute(
                        "UPDATE OR IGNORE class_links SET node_id = ?2 WHERE node_id = ?1",
                        params![other, target],
                    )?;
                    conn.execute(
                        "DELETE FROM class_links WHERE node_id = ?1",
                        params![other],
                    )?;
                    conn.execute(
                        "UPDATE class_nodes SET parent_id = ?2, updated_at = ?3 WHERE parent_id = ?1",
                        params![other, target, now],
                    )?;
                    conn.execute("DELETE FROM class_nodes WHERE id = ?1", params![other])?;
                }
                format!("merged {} into {target}", ids.len())
            }
            "split" => {
                let node = p.node_id.clone().unwrap_or_default();
                let parent: Option<String> = conn.query_row(
                    "SELECT parent_id FROM class_nodes WHERE id = ?1",
                    params![node],
                    |r| r.get(0),
                )?;
                let parts: Vec<crate::classmem::SplitPart> = p
                    .extra_json
                    .as_deref()
                    .and_then(|e| serde_json::from_str(e).ok())
                    .unwrap_or_default();
                let mut made = 0;
                for part in &parts {
                    let nid = crate::classmem::new_node_id();
                    conn.execute(
                        "INSERT INTO class_nodes
                            (id, parent_id, kind, title, summary, project_path, ip_name,
                             status, pinned, curated_by, created_at, updated_at)
                         VALUES (?1, ?2, 'node', ?3, NULL, NULL, NULL, 'accepted', 0,
                                 ?4, ?5, ?5)",
                        params![nid, parent, part.title, crate::ledger::local_author(), now],
                    )?;
                    for lid in &part.link_ids {
                        conn.execute(
                            "UPDATE OR IGNORE class_links SET node_id = ?2 WHERE id = ?1 AND node_id = ?3",
                            params![lid, nid, node],
                        )?;
                    }
                    made += 1;
                }
                format!("split into {made}")
            }
            _ => {
                self.drop_proposal_locked(&conn, id)?;
                return Ok(None);
            }
        };
        self.drop_proposal_locked(&conn, id)?;
        Ok(Some(crate::classmem::AppliedReorg {
            op: p.op,
            node_id: p.node_id.unwrap_or_default(),
            detail,
        }))
    }

    fn drop_proposal_locked(&self, conn: &rusqlite::Connection, id: i64) -> rusqlite::Result<()> {
        conn.execute("DELETE FROM class_proposals WHERE id = ?1", params![id])?;
        Ok(())
    }

    // --- class runs + lake delta ---

    /// The maximum ledger seq (the delta ceiling for a classifier run). 0 if the
    /// chain is empty.
    pub fn max_ledger_seq(&self) -> rusqlite::Result<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT COALESCE(MAX(seq), 0) FROM ledger_events", [], |r| r.get(0))
    }

    /// The seq the last completed classifier run consumed up to — the delta
    /// floor for the next run. 0 when no run has completed.
    pub fn last_run_seq_to(&self) -> rusqlite::Result<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT COALESCE(MAX(seq_to), 0) FROM class_runs WHERE status = 'done'",
            [],
            |r| r.get(0),
        )
    }

    /// Friction rows for the Orchestration digest: every `in_review` session with
    /// its unresolved-comment count (comments whose resolution was never accepted)
    /// and `created_at`, oldest first. Returns `(session_id, project_name,
    /// created_at, unresolved_count)`. Pure read; the orchestrator ranks these.
    pub fn in_review_friction(&self) -> rusqlite::Result<Vec<(String, String, i64, i64)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT s.session_id, s.project_name, s.created_at,
                (SELECT COUNT(*) FROM comments c
                   WHERE c.session_id = s.session_id
                     AND c.resolution_accepted_at IS NULL) AS unresolved
             FROM sessions s
             WHERE s.status = 'in_review'
             ORDER BY s.created_at ASC",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn insert_class_run(&self, seq_from: i64, seq_to: i64) -> rusqlite::Result<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO class_runs (started_at, status, seq_from, seq_to)
             VALUES (?1, 'running', ?2, ?3)",
            params![crate::ledger::now_millis(), seq_from, seq_to],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn finish_class_run(
        &self,
        id: i64,
        status: &str,
        claude_session_id: Option<&str>,
        summary: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE class_runs SET status = ?2, finished_at = ?3, claude_session_id = ?4, summary = ?5
             WHERE id = ?1",
            params![id, status, crate::ledger::now_millis(), claude_session_id, summary],
        )?;
        Ok(())
    }

    pub fn latest_class_run(&self) -> rusqlite::Result<Option<crate::classmem::ClassRun>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, started_at, finished_at, status, seq_from, seq_to, claude_session_id, summary
             FROM class_runs ORDER BY id DESC LIMIT 1",
            [],
            |r| {
                Ok(crate::classmem::ClassRun {
                    id: r.get(0)?,
                    started_at: r.get(1)?,
                    finished_at: r.get(2)?,
                    status: r.get(3)?,
                    seq_from: r.get(4)?,
                    seq_to: r.get(5)?,
                    claude_session_id: r.get(6)?,
                    summary: r.get(7)?,
                })
            },
        )
        .optional()
    }

    /// Lake items (prompts + decision events) with `seq > since_seq`, oldest
    /// first — the classifier's delta input and the `/v1/memory/prompts` route.
    /// Bodies are truncated to keep the vector light.
    pub fn list_lake_items_since(
        &self,
        since_seq: i64,
        limit: i64,
    ) -> rusqlite::Result<Vec<crate::classmem::LakeItem>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT le.seq, le.ts, le.kind, le.ref_kind, le.ref_id, le.session_id,
                    p.surface, p.origin, p.role, p.mission_id, p.project_path, p.body
             FROM ledger_events le
             LEFT JOIN prompts p ON le.prompt_id = p.id
             WHERE le.seq > ?1
             ORDER BY le.seq ASC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![since_seq, limit], |r| {
            let body: Option<String> = r.get(11)?;
            Ok(crate::classmem::LakeItem {
                seq: r.get(0)?,
                ts: r.get(1)?,
                kind: r.get(2)?,
                ref_kind: r.get(3)?,
                ref_id: r.get(4)?,
                session_id: r.get(5)?,
                surface: r.get(6)?,
                origin: r.get(7)?,
                role: r.get(8)?,
                mission_id: r.get(9)?,
                project_path: r.get(10)?,
                body: body.map(|b| {
                    if b.chars().count() > 4000 {
                        b.chars().take(4000).collect::<String>() + "…"
                    } else {
                        b
                    }
                }),
            })
        })?;
        rows.collect()
    }

    /// Every node plus its total link count (one query, no N+1) — backs the tree
    /// view's leaf-count badges.
    pub fn list_class_nodes_with_counts(
        &self,
    ) -> rusqlite::Result<Vec<(crate::classmem::ClassNode, i64)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT n.id, n.parent_id, n.kind, n.title, n.summary, n.project_path,
                    n.ip_name, n.status, n.pinned, n.curated_by, n.created_at, n.updated_at,
                    (SELECT COUNT(*) FROM class_links l WHERE l.node_id = n.id) AS link_count
             FROM class_nodes n ORDER BY n.title ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((Self::row_to_class_node(r)?, r.get::<_, i64>(12)?))
        })?;
        rows.collect()
    }

    /// Per-node DIRECT link activity: `node_id → (link_count, newest_ts?)`. The
    /// timestamp is the max `ledger_events.ts` among the node's own links that
    /// resolve to a ledger seq (prompt/decision/ledger). Rolled up into subtree
    /// stats by `classmem::subtree_stats` — the temporal facts that give "cold"
    /// a scope.
    pub fn node_direct_link_activity(
        &self,
    ) -> rusqlite::Result<std::collections::HashMap<String, (i64, Option<i64>)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT l.node_id, COUNT(*),
                    MAX(CASE WHEN l.target_kind IN ('prompt','decision','ledger')
                        THEN (SELECT le.ts FROM ledger_events le
                              WHERE le.seq = CAST(l.target_id AS INTEGER))
                        ELSE NULL END)
             FROM class_links l GROUP BY l.node_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, Option<i64>>(2)?))
        })?;
        let mut map = std::collections::HashMap::new();
        for row in rows {
            let (id, count, ts) = row?;
            map.insert(id, (count, ts));
        }
        Ok(map)
    }

    /// The lake's temporal envelope (oldest/newest ledger ts) — the reference
    /// frame coldness is measured against (never wall-clock).
    pub fn lake_envelope(&self) -> rusqlite::Result<crate::classmem::LakeEnvelope> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT COALESCE(MIN(ts), 0), COALESCE(MAX(ts), 0) FROM ledger_events",
            [],
            |r| {
                Ok(crate::classmem::LakeEnvelope {
                    oldest: r.get(0)?,
                    newest: r.get(1)?,
                })
            },
        )
    }

    fn subtree_pinned(conn: &rusqlite::Connection, id: &str) -> rusqlite::Result<bool> {
        let mut stack = vec![id.to_string()];
        let mut guard = 0;
        while let Some(nid) = stack.pop() {
            guard += 1;
            if guard > 10_000 {
                break;
            }
            let pinned: Option<i64> = conn
                .query_row("SELECT pinned FROM class_nodes WHERE id = ?1", params![nid], |r| {
                    r.get(0)
                })
                .optional()?;
            if pinned == Some(1) {
                return Ok(true);
            }
            let mut stmt = conn.prepare("SELECT id FROM class_nodes WHERE parent_id = ?1")?;
            let kids: Vec<String> = stmt
                .query_map(params![nid], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<_>>()?;
            stack.extend(kids);
        }
        Ok(false)
    }

    /// True if a node or any descendant is pinned — the anti-decay veto the
    /// collapse guard consults. Production code calls `Self::subtree_pinned`
    /// under an already-held lock; this locking wrapper exists for tests.
    #[cfg(test)]
    pub fn subtree_has_pin(&self, id: &str) -> rusqlite::Result<bool> {
        let conn = self.conn.lock().unwrap();
        Self::subtree_pinned(&conn, id)
    }

    /// A short human label for a link target (best-effort). Prompt/decision/
    /// ledger targets carry a numeric ledger seq — resolve it to the prompt body
    /// snippet or the event kind. Other kinds render from the id alone.
    pub fn link_preview(&self, target_kind: &str, target_id: &str) -> Option<String> {
        if !matches!(target_kind, "prompt" | "decision" | "ledger") {
            return None;
        }
        let seq: i64 = target_id.trim().parse().ok()?;
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT le.kind, p.body
             FROM ledger_events le LEFT JOIN prompts p ON le.prompt_id = p.id
             WHERE le.seq = ?1",
            params![seq],
            |r| {
                let kind: String = r.get(0)?;
                let body: Option<String> = r.get(1)?;
                Ok(match body {
                    Some(b) => {
                        let one = b.replace('\n', " ");
                        let snip: String = one.chars().take(120).collect();
                        snip
                    }
                    None => format!("[{kind} event]"),
                })
            },
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn insert_comment(
        &self,
        session_id: &str,
        version_number: u32,
        comment: &Comment,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        let (edit_original, edit_revised) = match &comment.edit {
            Some(e) => (Some(e.original.as_str()), Some(e.revised.as_str())),
            None => (None, None),
        };
        let (res_body, res_version, res_accepted) = match &comment.resolution {
            Some(r) => (Some(r.body.as_str()), Some(r.appeared_in_version), r.accepted_at),
            None => (None, None, None),
        };
        let structural_json = comment
            .structural
            .as_ref()
            .and_then(|s| serde_json::to_string(s).ok());
        let (sel_char_start, sel_char_end, sel_quoted_text, sel_sub_block_id) =
            match &comment.selection {
                Some(s) => (
                    Some(s.char_start as i64),
                    Some(s.char_end as i64),
                    Some(s.quoted_text.as_str()),
                    s.sub_block_id.as_deref(),
                ),
                None => (None, None, None, None),
            };
        let reopen_history_json = reopen_history_to_json(&comment.reopen_history);
        conn.execute(
            "INSERT INTO comments (
                id, session_id, version_number, type, scope, anchor_id,
                body, edit_original, edit_revised, created_at, status,
                resolution_body, resolution_version, resolution_accepted_at,
                block_id, structural_json,
                sel_char_start, sel_char_end, sel_quoted_text,
                sel_sub_block_id, reopen_note, reopen_history, actionable,
                author, agent_state, reviewer
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26)",
            params![
                comment.id,
                session_id,
                version_number,
                comment.kind.as_str(),
                comment.scope.map(|s| s.as_str()),
                comment.anchor_id,
                comment.body,
                edit_original,
                edit_revised,
                comment.created_at,
                comment.status.as_str(),
                res_body,
                res_version,
                res_accepted,
                comment.block_id,
                structural_json,
                sel_char_start,
                sel_char_end,
                sel_quoted_text,
                sel_sub_block_id,
                comment.reopen_note,
                reopen_history_json,
                comment.actionable as i64,
                comment.author,
                comment.agent_state,
                comment.reviewer,
            ],
        )?;
        Self::touch_session(&conn, session_id, comment.created_at);
        Ok(())
    }

    pub fn update_comment(&self, session_id: &str, comment: &Comment) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        let (edit_original, edit_revised) = match &comment.edit {
            Some(e) => (Some(e.original.as_str()), Some(e.revised.as_str())),
            None => (None, None),
        };
        let (res_body, res_version, res_accepted) = match &comment.resolution {
            Some(r) => (Some(r.body.as_str()), Some(r.appeared_in_version), r.accepted_at),
            None => (None, None, None),
        };
        let structural_json = comment
            .structural
            .as_ref()
            .and_then(|s| serde_json::to_string(s).ok());
        let (sel_char_start, sel_char_end, sel_quoted_text, sel_sub_block_id) =
            match &comment.selection {
                Some(s) => (
                    Some(s.char_start as i64),
                    Some(s.char_end as i64),
                    Some(s.quoted_text.as_str()),
                    s.sub_block_id.as_deref(),
                ),
                None => (None, None, None, None),
            };
        let reopen_history_json = reopen_history_to_json(&comment.reopen_history);
        conn.execute(
            "UPDATE comments SET
                scope = ?1,
                body = ?2,
                edit_original = ?3,
                edit_revised = ?4,
                status = ?5,
                resolution_body = ?6,
                resolution_version = ?7,
                resolution_accepted_at = ?8,
                block_id = ?9,
                structural_json = ?10,
                sel_char_start = ?11,
                sel_char_end = ?12,
                sel_quoted_text = ?13,
                sel_sub_block_id = ?14,
                reopen_note = ?15,
                reopen_history = ?16,
                actionable = ?17,
                author = ?18,
                agent_state = ?19,
                reviewer = ?20
             WHERE session_id = ?21 AND id = ?22",
            params![
                comment.scope.map(|s| s.as_str()),
                comment.body,
                edit_original,
                edit_revised,
                comment.status.as_str(),
                res_body,
                res_version,
                res_accepted,
                comment.block_id,
                structural_json,
                sel_char_start,
                sel_char_end,
                sel_quoted_text,
                sel_sub_block_id,
                comment.reopen_note,
                reopen_history_json,
                comment.actionable as i64,
                comment.author,
                comment.agent_state,
                comment.reviewer,
                session_id,
                comment.id,
            ],
        )?;
        Ok(())
    }

    /// Targeted attach-state write — callable from the detach drop-guard with
    /// just a session id, no session clone needed.
    pub fn set_session_attach_state(
        &self,
        session_id: &str,
        state: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE sessions SET attach_state = ?1 WHERE session_id = ?2",
            params![state, session_id],
        )?;
        Self::touch_session(&conn, session_id, crate::state::now_millis());
        Ok(())
    }

    /// Startup sweep: a held POST never survives a restart, so every session
    /// persisted as 'held' was orphaned by the previous instance.
    pub fn detach_held_sessions(&self) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE sessions SET attach_state = 'detached' WHERE attach_state = 'held'",
            [],
        )?;
        Ok(())
    }

    /// Move a comment to another revision. `update_comment` deliberately never
    /// touches `version_number`; carrying drafts onto a restored revision is
    /// the one place that re-homes a comment.
    pub fn set_comment_revision(
        &self,
        session_id: &str,
        comment_id: &str,
        version_number: u32,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE comments SET version_number = ?1 WHERE session_id = ?2 AND id = ?3",
            params![version_number, session_id, comment_id],
        )?;
        Ok(())
    }

    pub fn delete_comment(&self, session_id: &str, comment_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        // Cascade the comment's discussion thread. Comment ids are reused
        // (`c-{max+1}`), so leaving these rows would resurface a deleted
        // comment's answer under the next comment that inherits its id.
        conn.execute(
            "DELETE FROM thread_messages WHERE session_id = ?1 AND comment_id = ?2",
            params![session_id, comment_id],
        )?;
        conn.execute(
            "DELETE FROM comments WHERE session_id = ?1 AND id = ?2",
            params![session_id, comment_id],
        )?;
        Ok(())
    }

    /// Delete a session and its revisions/comments. Explicit child deletes so
    /// this is correct regardless of the `foreign_keys` PRAGMA.
    /// Move every row for `old_id` to `new_id` across the session-scoped tables.
    /// Used to rebind a held plan onto the live session when a restore handshake
    /// lands under a different id than the plan it names (resume forks the id, or
    /// the command was pasted into a running Claude REPL). Foreign keys aren't
    /// enforced on this connection (see `delete_session`, which deletes each
    /// table by hand), so a straight per-table column UPDATE is safe and
    /// order-independent. Caller guarantees `new_id` holds no session yet.
    pub fn rekey_session(&self, old_id: &str, new_id: &str) -> rusqlite::Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        // Foreign keys are enforced on this connection, and the session-scoped
        // tables form a chain (comments/briefs → revisions → sessions). Renaming
        // them one at a time transiently dangles a child, so defer FK checks to
        // commit, by which point every table is consistent again.
        tx.execute_batch("PRAGMA defer_foreign_keys = ON")?;
        // `briefs` is created lazily and absent from fresh (test) DBs; skip any
        // table that doesn't exist. Order is irrelevant under deferred checks.
        for table in ["thread_messages", "comments", "briefs", "revisions", "sessions"] {
            let present: i64 = tx.query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name = ?1",
                params![table],
                |r| r.get(0),
            )?;
            if present == 0 {
                continue;
            }
            tx.execute(
                &format!("UPDATE {table} SET session_id = ?1 WHERE session_id = ?2"),
                params![new_id, old_id],
            )?;
        }
        tx.commit()
    }

    pub fn delete_session(&self, session_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM thread_messages WHERE session_id = ?1",
            params![session_id],
        )?;
        conn.execute(
            "DELETE FROM comments WHERE session_id = ?1",
            params![session_id],
        )?;
        conn.execute(
            "DELETE FROM revisions WHERE session_id = ?1",
            params![session_id],
        )?;
        conn.execute(
            "DELETE FROM sessions WHERE session_id = ?1",
            params![session_id],
        )?;
        Ok(())
    }

    // --- Fork-agent discussion threads (Phase 2) ---------------------------
    // `thread_messages` rows are terminal: written only when a turn finishes.
    // `comments.fork_session_id` is a DB-only column (not on the `Comment`
    // struct) so resuming a fork never reads a stale in-memory value.

    pub fn insert_thread_message(&self, msg: &ThreadMessage) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO thread_messages
                (id, session_id, comment_id, role, body, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                msg.id,
                msg.session_id,
                msg.comment_id,
                msg.role,
                msg.body,
                msg.status,
                msg.created_at,
            ],
        )?;
        Self::touch_session(&conn, &msg.session_id, msg.created_at);
        Ok(())
    }

    pub fn load_thread(
        &self,
        session_id: &str,
        comment_id: &str,
    ) -> rusqlite::Result<Vec<ThreadMessage>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, comment_id, role, body, status, created_at
             FROM thread_messages
             WHERE session_id = ?1 AND comment_id = ?2
             ORDER BY created_at, id",
        )?;
        let rows = stmt.query_map(params![session_id, comment_id], |row| {
            Ok(ThreadMessage {
                id: row.get(0)?,
                session_id: row.get(1)?,
                comment_id: row.get(2)?,
                role: row.get(3)?,
                body: row.get(4)?,
                status: row.get(5)?,
                created_at: row.get(6)?,
            })
        })?;
        rows.collect()
    }

    pub fn delete_thread(&self, session_id: &str, comment_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM thread_messages WHERE session_id = ?1 AND comment_id = ?2",
            params![session_id, comment_id],
        )?;
        Ok(())
    }

    pub fn get_comment_fork_session(
        &self,
        session_id: &str,
        comment_id: &str,
    ) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT fork_session_id FROM comments WHERE session_id = ?1 AND id = ?2",
            params![session_id, comment_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    }

    pub fn set_comment_fork_session(
        &self,
        session_id: &str,
        comment_id: &str,
        fork_session_id: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE comments SET fork_session_id = ?1 WHERE session_id = ?2 AND id = ?3",
            params![fork_session_id, session_id, comment_id],
        )?;
        Ok(())
    }

    pub fn clear_comment_fork_session(
        &self,
        session_id: &str,
        comment_id: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE comments SET fork_session_id = NULL WHERE session_id = ?1 AND id = ?2",
            params![session_id, comment_id],
        )?;
        Ok(())
    }

    /// True if `session_id` is the forked session of any comment *or* the voice
    /// agent — used by `handle_plan` to ignore stray `ExitPlanMode` POSTs from a
    /// fork agent.
    pub fn is_known_fork_session(&self, session_id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT 1 FROM comments WHERE fork_session_id = ?1
             UNION ALL
             SELECT 1 FROM voice_sessions WHERE fork_session_id = ?1
             LIMIT 1",
            params![session_id],
            |_| Ok(()),
        )
        .is_ok()
    }

    // --- Browser browse-agent threads --------------------------------------
    // Mirrors the fork-thread helpers above, keyed by a per-tab `browse_id`
    // instead of (session_id, comment_id). The agent's resumable claude
    // session id is tracked in `browse_threads`, not on any in-memory struct.

    pub fn insert_browse_message(&self, msg: &BrowseMessage) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO browse_messages
                (id, browse_id, role, body, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                msg.id,
                msg.browse_id,
                msg.role,
                msg.body,
                msg.status,
                msg.created_at,
            ],
        )?;
        Ok(())
    }

    pub fn load_browse_thread(&self, browse_id: &str) -> rusqlite::Result<Vec<BrowseMessage>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, browse_id, role, body, status, created_at
             FROM browse_messages
             WHERE browse_id = ?1
             ORDER BY created_at, id",
        )?;
        let rows = stmt.query_map(params![browse_id], |row| {
            Ok(BrowseMessage {
                id: row.get(0)?,
                browse_id: row.get(1)?,
                role: row.get(2)?,
                body: row.get(3)?,
                status: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?;
        rows.collect()
    }

    /// Delete a tab's whole thread: its turns and its persisted agent session.
    pub fn delete_browse_thread(&self, browse_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM browse_messages WHERE browse_id = ?1",
            params![browse_id],
        )?;
        conn.execute(
            "DELETE FROM browse_threads WHERE browse_id = ?1",
            params![browse_id],
        )?;
        Ok(())
    }

    pub fn get_browse_session(&self, browse_id: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT claude_session_id FROM browse_threads WHERE browse_id = ?1",
            params![browse_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    }

    pub fn set_browse_session(
        &self,
        browse_id: &str,
        claude_session_id: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO browse_threads (browse_id, claude_session_id)
             VALUES (?1, ?2)
             ON CONFLICT(browse_id) DO UPDATE SET claude_session_id = ?2",
            params![browse_id, claude_session_id],
        )?;
        Ok(())
    }

    /// Forget a tab's resumable `claude` session id WITHOUT touching its message
    /// history. Used to recover from a *poisoned* session — one whose accumulated
    /// tool-output context (page snapshots, WebFetch, code reads, git diffs) grew
    /// past the model's window and now throws on every `--resume`. Dropping the id
    /// makes the next turn start a fresh session (re-embedding a snapshot) instead
    /// of re-sending the over-limit context forever. The visible thread is kept.
    pub fn clear_browse_session(&self, browse_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM browse_threads WHERE browse_id = ?1",
            params![browse_id],
        )?;
        Ok(())
    }

    // --- Missions ----------------------------------------------------------
    // The research-mission orchestrator: one shared goal across the browser
    // pane, with curated pins (`mission_findings`) and a resumable chat
    // (`mission_messages` + the `claude_session_id` on the row). Mirrors the
    // browse helpers above but keyed by `mission_id`. See mission.rs.

    pub fn insert_mission(&self, m: &Mission) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO missions
                (mission_id, title, goal, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![m.mission_id, m.title, m.goal, m.status, m.created_at, m.updated_at],
        )?;
        Ok(())
    }

    pub fn get_mission(&self, mission_id: &str) -> rusqlite::Result<Option<Mission>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT mission_id, title, goal, status, created_at, updated_at
             FROM missions WHERE mission_id = ?1",
            params![mission_id],
            |row| {
                Ok(Mission {
                    mission_id: row.get(0)?,
                    title: row.get(1)?,
                    goal: row.get(2)?,
                    status: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            },
        )
        .optional()
    }

    /// Missions newest-first (active before archived, then by recency), for the
    /// start/switch/resume menu.
    pub fn list_missions(&self) -> rusqlite::Result<Vec<Mission>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT mission_id, title, goal, status, created_at, updated_at
             FROM missions
             ORDER BY (status = 'active') DESC, updated_at DESC, created_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Mission {
                mission_id: row.get(0)?,
                title: row.get(1)?,
                goal: row.get(2)?,
                status: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?;
        rows.collect()
    }

    /// Update a mission's goal (and/or title) and bump `updated_at`.
    pub fn update_mission_goal(
        &self,
        mission_id: &str,
        title: &str,
        goal: &str,
        updated_at: i64,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE missions SET title = ?2, goal = ?3, updated_at = ?4
             WHERE mission_id = ?1",
            params![mission_id, title, goal, updated_at],
        )?;
        Ok(())
    }

    pub fn get_mission_session(&self, mission_id: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT claude_session_id FROM missions WHERE mission_id = ?1",
            params![mission_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    }

    pub fn set_mission_session(
        &self,
        mission_id: &str,
        claude_session_id: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE missions SET claude_session_id = ?2 WHERE mission_id = ?1",
            params![mission_id, claude_session_id],
        )?;
        Ok(())
    }

    /// Save a mission's tab workspace (JSON). Deliberately does NOT bump
    /// `updated_at` — tab churn shouldn't reorder the mission list.
    pub fn set_mission_tabs(&self, mission_id: &str, tabs_json: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE missions SET tabs_json = ?2 WHERE mission_id = ?1",
            params![mission_id, tabs_json],
        )?;
        Ok(())
    }

    pub fn get_mission_tabs(&self, mission_id: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT tabs_json FROM missions WHERE mission_id = ?1",
            params![mission_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    }

    /// Hard-delete a mission and all its data (pins + orchestrator chat). The
    /// caller purges the saved tabs' browse threads first (those are keyed by
    /// `browse_id`, independent of the mission row).
    pub fn delete_mission(&self, mission_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM mission_findings WHERE mission_id = ?1",
            params![mission_id],
        )?;
        conn.execute(
            "DELETE FROM mission_messages WHERE mission_id = ?1",
            params![mission_id],
        )?;
        conn.execute("DELETE FROM missions WHERE mission_id = ?1", params![mission_id])?;
        Ok(())
    }

    // --- Mission findings (pins) -------------------------------------------

    pub fn insert_finding(&self, f: &MissionFinding) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO mission_findings
                (id, mission_id, browse_id, source_url, source_title, body, note, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                f.id,
                f.mission_id,
                f.browse_id,
                f.source_url,
                f.source_title,
                f.body,
                f.note,
                f.created_at,
            ],
        )?;
        Ok(())
    }

    pub fn list_findings(&self, mission_id: &str) -> rusqlite::Result<Vec<MissionFinding>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, mission_id, browse_id, source_url, source_title, body, note, created_at
             FROM mission_findings
             WHERE mission_id = ?1
             ORDER BY created_at, id",
        )?;
        let rows = stmt.query_map(params![mission_id], |row| {
            Ok(MissionFinding {
                id: row.get(0)?,
                mission_id: row.get(1)?,
                browse_id: row.get(2)?,
                source_url: row.get(3)?,
                source_title: row.get(4)?,
                body: row.get(5)?,
                note: row.get(6)?,
                created_at: row.get(7)?,
            })
        })?;
        rows.collect()
    }

    pub fn delete_finding(&self, finding_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM mission_findings WHERE id = ?1",
            params![finding_id],
        )?;
        Ok(())
    }

    // --- Source feedback (tandem mode thumbs) ------------------------------

    /// Record (or update) a thumbs verdict for a surfaced source. Upserts on
    /// `(browse_id, source_url)`: a second click flips `verdict` and bumps
    /// `updated_at` while keeping the original `created_at`.
    pub fn upsert_source_feedback(&self, f: &SourceFeedback) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO source_feedback
                (id, browse_id, source_url, source_title, domain, verdict, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(browse_id, source_url) DO UPDATE SET
                verdict = excluded.verdict,
                source_title = excluded.source_title,
                domain = excluded.domain,
                updated_at = excluded.updated_at",
            params![
                f.id,
                f.browse_id,
                f.source_url,
                f.source_title,
                f.domain,
                f.verdict,
                f.created_at,
                f.updated_at,
            ],
        )?;
        Ok(())
    }

    /// All verdicts recorded on a tab's thread, so the sources strip can restore
    /// its up/down state after a reload.
    pub fn get_source_feedback(&self, browse_id: &str) -> rusqlite::Result<Vec<SourceFeedback>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, browse_id, source_url, source_title, domain, verdict, created_at, updated_at
             FROM source_feedback
             WHERE browse_id = ?1
             ORDER BY updated_at, id",
        )?;
        let rows = stmt.query_map(params![browse_id], |row| {
            Ok(SourceFeedback {
                id: row.get(0)?,
                browse_id: row.get(1)?,
                source_url: row.get(2)?,
                source_title: row.get(3)?,
                domain: row.get(4)?,
                verdict: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })?;
        rows.collect()
    }

    /// Net thumbs score per domain across ALL tabs (sum of +1/-1), most-liked
    /// first. Feeds the learned "preferred / avoided sources" line injected into
    /// the tandem agent prompt.
    pub fn domain_feedback_summary(&self) -> rusqlite::Result<Vec<(String, i64)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT domain, SUM(verdict) AS score
             FROM source_feedback
             GROUP BY domain
             ORDER BY score DESC, domain",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        rows.collect()
    }

    // --- Mission chat turns ------------------------------------------------

    pub fn insert_mission_message(&self, msg: &MissionMessage) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO mission_messages
                (id, mission_id, role, body, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![msg.id, msg.mission_id, msg.role, msg.body, msg.status, msg.created_at],
        )?;
        Ok(())
    }

    pub fn load_mission_thread(&self, mission_id: &str) -> rusqlite::Result<Vec<MissionMessage>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, mission_id, role, body, status, created_at
             FROM mission_messages
             WHERE mission_id = ?1
             ORDER BY created_at, id",
        )?;
        let rows = stmt.query_map(params![mission_id], |row| {
            Ok(MissionMessage {
                id: row.get(0)?,
                mission_id: row.get(1)?,
                role: row.get(2)?,
                body: row.get(3)?,
                status: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?;
        rows.collect()
    }

    // --- Linked discussions ------------------------------------------------
    // One continuous conversation spanning all browser tabs (no goal). Mirrors
    // the mission helpers above but keyed by `linked_id`; turns carry a tab tag.
    // See linked.rs.

    pub fn insert_linked(&self, l: &Linked) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO linked_sessions
                (linked_id, title, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![l.linked_id, l.title, l.status, l.created_at, l.updated_at],
        )?;
        Ok(())
    }

    /// Linked discussions newest-first (active before archived, then recency),
    /// for the start/switch/resume menu.
    pub fn list_linked(&self) -> rusqlite::Result<Vec<Linked>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT linked_id, title, status, created_at, updated_at
             FROM linked_sessions
             ORDER BY (status = 'active') DESC, updated_at DESC, created_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Linked {
                linked_id: row.get(0)?,
                title: row.get(1)?,
                status: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })?;
        rows.collect()
    }

    pub fn get_linked_session(&self, linked_id: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT claude_session_id FROM linked_sessions WHERE linked_id = ?1",
            params![linked_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    }

    pub fn set_linked_session(
        &self,
        linked_id: &str,
        claude_session_id: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE linked_sessions SET claude_session_id = ?2 WHERE linked_id = ?1",
            params![linked_id, claude_session_id],
        )?;
        Ok(())
    }

    /// Save a linked discussion's tab workspace (JSON). Like the mission helper,
    /// this does NOT bump `updated_at` — tab churn shouldn't reorder the list.
    pub fn set_linked_tabs(&self, linked_id: &str, tabs_json: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE linked_sessions SET tabs_json = ?2 WHERE linked_id = ?1",
            params![linked_id, tabs_json],
        )?;
        Ok(())
    }

    pub fn get_linked_tabs(&self, linked_id: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT tabs_json FROM linked_sessions WHERE linked_id = ?1",
            params![linked_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    }

    /// Hard-delete a linked discussion and its chat. Does NOT touch any tab's
    /// browse thread — consults live in those tabs' own discussions, which the
    /// user may still want.
    pub fn delete_linked(&self, linked_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM linked_messages WHERE linked_id = ?1",
            params![linked_id],
        )?;
        conn.execute(
            "DELETE FROM linked_sessions WHERE linked_id = ?1",
            params![linked_id],
        )?;
        Ok(())
    }

    pub fn insert_linked_message(&self, msg: &LinkedMessage) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO linked_messages
                (id, linked_id, role, body, status, tab_browse_id, tab_n, tab_title, tab_url, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                msg.id,
                msg.linked_id,
                msg.role,
                msg.body,
                msg.status,
                msg.tab_browse_id,
                msg.tab_n,
                msg.tab_title,
                msg.tab_url,
                msg.created_at,
            ],
        )?;
        Ok(())
    }

    pub fn load_linked_thread(&self, linked_id: &str) -> rusqlite::Result<Vec<LinkedMessage>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, linked_id, role, body, status, tab_browse_id, tab_n, tab_title, tab_url, created_at
             FROM linked_messages
             WHERE linked_id = ?1
             ORDER BY created_at, id",
        )?;
        let rows = stmt.query_map(params![linked_id], |row| {
            Ok(LinkedMessage {
                id: row.get(0)?,
                linked_id: row.get(1)?,
                role: row.get(2)?,
                body: row.get(3)?,
                status: row.get(4)?,
                tab_browse_id: row.get(5)?,
                tab_n: row.get(6)?,
                tab_title: row.get(7)?,
                tab_url: row.get(8)?,
                created_at: row.get(9)?,
            })
        })?;
        rows.collect()
    }

    /// Distinct working directories the user has worked in, most-recent first —
    /// every `sessions.project_path` (a plan review). This is Redline's de-facto
    /// "projects" registry: it backs the browse agent's `/v1/code/projects` map
    /// and is the allowlist the read-only git route validates a `repo` against.
    /// Paths are returned verbatim (may no longer exist on disk — the caller
    /// filters).
    pub fn list_project_paths(&self) -> rusqlite::Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT project_path AS path FROM sessions
             WHERE project_path IS NOT NULL AND project_path <> ''
             GROUP BY project_path
             ORDER BY MAX(created_at) DESC",
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect()
    }

    // --- code-review surface -------------------------------------------------

    const REVIEW_SESSION_COLS: &'static str =
        "review_id, repo_path, source, base_ref, commit_sha, terminal_id, round, created_at";

    fn map_code_review(row: &rusqlite::Row<'_>) -> rusqlite::Result<CodeReviewSession> {
        Ok(CodeReviewSession {
            review_id: row.get(0)?,
            repo_path: row.get(1)?,
            source: row.get(2)?,
            base_ref: row.get(3)?,
            commit_sha: row.get(4)?,
            terminal_id: row.get(5)?,
            round: row.get(6)?,
            created_at: row.get(7)?,
        })
    }

    pub fn upsert_code_review(&self, r: &CodeReviewSession) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO review_sessions
                 (review_id, repo_path, source, base_ref, commit_sha, terminal_id, round, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(review_id) DO UPDATE SET
                 repo_path = excluded.repo_path,
                 source = excluded.source,
                 base_ref = excluded.base_ref,
                 commit_sha = excluded.commit_sha,
                 terminal_id = excluded.terminal_id,
                 round = excluded.round",
            params![
                r.review_id,
                r.repo_path,
                r.source,
                r.base_ref,
                r.commit_sha,
                r.terminal_id,
                r.round,
                r.created_at,
            ],
        )?;
        Ok(())
    }

    pub fn get_code_review(&self, review_id: &str) -> Option<CodeReviewSession> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!(
                "SELECT {} FROM review_sessions WHERE review_id = ?1",
                Self::REVIEW_SESSION_COLS
            ),
            params![review_id],
            Self::map_code_review,
        )
        .ok()
    }

    pub fn list_code_reviews(&self) -> rusqlite::Result<Vec<CodeReviewSession>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM review_sessions ORDER BY created_at DESC",
            Self::REVIEW_SESSION_COLS
        ))?;
        let rows = stmt.query_map([], Self::map_code_review)?;
        rows.collect()
    }

    /// The most recent review session for a repo — how a re-run of
    /// `/redline-review` in the same repo continues the SAME review (next
    /// round) instead of minting a parallel one.
    pub fn latest_code_review_for_repo(&self, repo_path: &str) -> Option<CodeReviewSession> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!(
                "SELECT {} FROM review_sessions WHERE repo_path = ?1
                 ORDER BY created_at DESC LIMIT 1",
                Self::REVIEW_SESSION_COLS
            ),
            params![repo_path],
            Self::map_code_review,
        )
        .ok()
    }

    pub fn delete_code_review(&self, review_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM review_annotations WHERE review_id = ?1",
            params![review_id],
        )?;
        conn.execute(
            "DELETE FROM review_viewed WHERE review_id = ?1",
            params![review_id],
        )?;
        conn.execute(
            "DELETE FROM review_sessions WHERE review_id = ?1",
            params![review_id],
        )?;
        Ok(())
    }

    const REVIEW_ANNOTATION_COLS: &'static str =
        "id, review_id, round, file_path, side, start_line, end_line, kind, body, \
         suggestion_replacement, quoted_text, status, resolution, created_at, \
         scope, label, blocking, source";

    fn map_review_annotation(row: &rusqlite::Row<'_>) -> rusqlite::Result<ReviewAnnotation> {
        Ok(ReviewAnnotation {
            id: row.get(0)?,
            review_id: row.get(1)?,
            round: row.get(2)?,
            file_path: row.get(3)?,
            side: row.get(4)?,
            start_line: row.get(5)?,
            end_line: row.get(6)?,
            kind: row.get(7)?,
            body: row.get(8)?,
            suggestion_replacement: row.get(9)?,
            quoted_text: row.get(10)?,
            status: row.get(11)?,
            resolution: row.get(12)?,
            created_at: row.get(13)?,
            scope: row.get(14)?,
            label: row.get(15)?,
            blocking: row.get(16)?,
            source: row.get(17)?,
        })
    }

    pub fn insert_review_annotation(&self, a: &ReviewAnnotation) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            &format!(
                "INSERT INTO review_annotations ({})
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                         ?15, ?16, ?17, ?18)",
                Self::REVIEW_ANNOTATION_COLS
            ),
            params![
                a.id,
                a.review_id,
                a.round,
                a.file_path,
                a.side,
                a.start_line,
                a.end_line,
                a.kind,
                a.body,
                a.suggestion_replacement,
                a.quoted_text,
                a.status,
                a.resolution,
                a.created_at,
                a.scope,
                a.label,
                a.blocking,
                a.source,
            ],
        )?;
        Ok(())
    }

    /// Full-row update (except identity + created_at + source). The
    /// carry-forward pass re-homes an annotation's round/lines/status through
    /// this same path.
    pub fn update_review_annotation(&self, a: &ReviewAnnotation) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE review_annotations SET
                 round = ?1, file_path = ?2, side = ?3, start_line = ?4, end_line = ?5,
                 kind = ?6, body = ?7, suggestion_replacement = ?8, quoted_text = ?9,
                 status = ?10, resolution = ?11, scope = ?12, label = ?13, blocking = ?14
             WHERE review_id = ?15 AND id = ?16",
            params![
                a.round,
                a.file_path,
                a.side,
                a.start_line,
                a.end_line,
                a.kind,
                a.body,
                a.suggestion_replacement,
                a.quoted_text,
                a.status,
                a.resolution,
                a.scope,
                a.label,
                a.blocking,
                a.review_id,
                a.id,
            ],
        )?;
        Ok(())
    }

    pub fn delete_review_annotation(&self, review_id: &str, id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM review_annotations WHERE review_id = ?1 AND id = ?2",
            params![review_id, id],
        )?;
        Ok(())
    }

    pub fn list_review_annotations(
        &self,
        review_id: &str,
    ) -> rusqlite::Result<Vec<ReviewAnnotation>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM review_annotations WHERE review_id = ?1
             ORDER BY file_path, start_line, created_at",
            Self::REVIEW_ANNOTATION_COLS
        ))?;
        let rows = stmt.query_map(params![review_id], Self::map_review_annotation)?;
        rows.collect()
    }

    /// The annotation's discussion-fork claude session id (resume target).
    /// Deliberately NOT on `ReviewAnnotation` — always read fresh from disk,
    /// mirroring `comments.fork_session_id`.
    pub fn get_review_annotation_fork_session(
        &self,
        review_id: &str,
        id: &str,
    ) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT fork_session_id FROM review_annotations
             WHERE review_id = ?1 AND id = ?2",
            params![review_id, id],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    }

    pub fn set_review_annotation_fork_session(
        &self,
        review_id: &str,
        id: &str,
        fork_session_id: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE review_annotations SET fork_session_id = ?3
             WHERE review_id = ?1 AND id = ?2",
            params![review_id, id, fork_session_id],
        )?;
        Ok(())
    }

    pub fn clear_review_annotation_fork_session(
        &self,
        review_id: &str,
        id: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE review_annotations SET fork_session_id = NULL
             WHERE review_id = ?1 AND id = ?2",
            params![review_id, id],
        )?;
        Ok(())
    }

    pub fn mark_review_viewed(
        &self,
        review_id: &str,
        file_path: &str,
        viewed_at: i64,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO review_viewed (review_id, file_path, viewed_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(review_id, file_path) DO UPDATE SET viewed_at = excluded.viewed_at",
            params![review_id, file_path, viewed_at],
        )?;
        Ok(())
    }

    pub fn unmark_review_viewed(&self, review_id: &str, file_path: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM review_viewed WHERE review_id = ?1 AND file_path = ?2",
            params![review_id, file_path],
        )?;
        Ok(())
    }

    pub fn list_review_viewed(&self, review_id: &str) -> rusqlite::Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT file_path FROM review_viewed WHERE review_id = ?1 ORDER BY file_path",
        )?;
        let rows = stmt.query_map(params![review_id], |row| row.get::<_, String>(0))?;
        rows.collect()
    }

    /// Remove a source's DRAFT annotations only — submitted/carried history is
    /// feedback the agent already saw and must stay auditable.
    pub fn clear_review_annotations_by_source(
        &self,
        review_id: &str,
        source: &str,
    ) -> rusqlite::Result<usize> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM review_annotations
             WHERE review_id = ?1 AND source = ?2 AND status = 'draft'",
            params![review_id, source],
        )
    }

    // --- Ask-AI questions ----------------------------------------------------

    const REVIEW_QUESTION_COLS: &'static str =
        "id, review_id, file_path, side, start_line, end_line, quoted_text, created_at";

    fn map_review_question(row: &rusqlite::Row<'_>) -> rusqlite::Result<ReviewQuestion> {
        Ok(ReviewQuestion {
            id: row.get(0)?,
            review_id: row.get(1)?,
            file_path: row.get(2)?,
            side: row.get(3)?,
            start_line: row.get(4)?,
            end_line: row.get(5)?,
            quoted_text: row.get(6)?,
            created_at: row.get(7)?,
        })
    }

    pub fn insert_review_question(&self, q: &ReviewQuestion) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            &format!(
                "INSERT INTO review_questions ({})
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                Self::REVIEW_QUESTION_COLS
            ),
            params![
                q.id,
                q.review_id,
                q.file_path,
                q.side,
                q.start_line,
                q.end_line,
                q.quoted_text,
                q.created_at,
            ],
        )?;
        Ok(())
    }

    pub fn list_review_questions(&self, review_id: &str) -> rusqlite::Result<Vec<ReviewQuestion>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM review_questions WHERE review_id = ?1
             ORDER BY file_path, start_line, created_at",
            Self::REVIEW_QUESTION_COLS
        ))?;
        let rows = stmt.query_map(params![review_id], Self::map_review_question)?;
        rows.collect()
    }

    pub fn delete_review_question(&self, review_id: &str, id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM review_questions WHERE review_id = ?1 AND id = ?2",
            params![review_id, id],
        )?;
        Ok(())
    }

    /// The question's Ask-AI claude session id (resume target) — read fresh
    /// from disk, mirroring `review_annotations.fork_session_id`.
    pub fn get_review_question_fork_session(
        &self,
        review_id: &str,
        id: &str,
    ) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT fork_session_id FROM review_questions WHERE review_id = ?1 AND id = ?2",
            params![review_id, id],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    }

    pub fn set_review_question_fork_session(
        &self,
        review_id: &str,
        id: &str,
        session: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE review_questions SET fork_session_id = ?1 WHERE review_id = ?2 AND id = ?3",
            params![session, review_id, id],
        )?;
        Ok(())
    }

    // --- Voice-agent session (per-plan memory) -----------------------------
    // The voice agent's conversation is a forked claude session, persisted by
    // the plan's session id so re-entering voice mode resumes it. The live
    // process is disposable (`voice.rs`); this row is the memory.

    pub fn get_voice_fork_session(&self, session_id: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT fork_session_id FROM voice_sessions WHERE session_id = ?1",
            params![session_id],
            |row| row.get::<_, String>(0),
        )
        .ok()
    }

    pub fn set_voice_fork_session(
        &self,
        session_id: &str,
        fork_session_id: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO voice_sessions (session_id, fork_session_id)
             VALUES (?1, ?2)
             ON CONFLICT(session_id) DO UPDATE SET fork_session_id = ?2",
            params![session_id, fork_session_id],
        )?;
        Ok(())
    }

    pub fn clear_voice_fork_session(&self, session_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM voice_sessions WHERE session_id = ?1",
            params![session_id],
        )?;
        Ok(())
    }

    pub fn load_all(&self) -> rusqlite::Result<HashMap<String, ReviewSession>> {
        let conn = self.conn.lock().unwrap();
        let mut sessions: HashMap<String, ReviewSession> = HashMap::new();

        let mut stmt = conn.prepare(
            "SELECT session_id, project_path, project_name, created_at, status, attach_state, updated_at FROM sessions",
        )?;
        let rows = stmt.query_map([], |row| {
            let status_str: String = row.get(4)?;
            let attach_str: String = row.get(5)?;
            Ok(ReviewSession {
                session_id: row.get(0)?,
                project_path: row.get(1)?,
                project_name: row.get(2)?,
                created_at: row.get(3)?,
                revisions: Vec::new(),
                status: session_status_from(&status_str),
                attach_state: AttachState::from_str(&attach_str).unwrap_or(AttachState::Idle),
                updated_at: row.get(6)?,
            })
        })?;
        for row in rows {
            let s = row?;
            sessions.insert(s.session_id.clone(), s);
        }
        drop(stmt);

        let mut stmt = conn.prepare(
            "SELECT session_id, version_number, received_at, raw_plan_markdown, thread_start, restored
             FROM revisions ORDER BY session_id, version_number",
        )?;
        let revs = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, u32>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)? != 0,
                row.get::<_, i64>(5)? != 0,
            ))
        })?;
        for r in revs {
            let (session_id, version_number, received_at, raw_plan_markdown, thread_start, restored) = r?;
            if let Some(s) = sessions.get_mut(&session_id) {
                let sections = reparse_sections(&raw_plan_markdown);
                s.revisions.push(Revision {
                    version_number,
                    received_at,
                    raw_plan_markdown,
                    sections,
                    comments: Vec::new(),
                    thread_start,
                    restored,
                });
            }
        }
        drop(stmt);

        let mut stmt = conn.prepare(
            "SELECT id, session_id, version_number, type, scope, anchor_id,
                    body, edit_original, edit_revised, created_at, status,
                    resolution_body, resolution_version, resolution_accepted_at,
                    block_id, structural_json,
                    sel_char_start, sel_char_end, sel_quoted_text,
                    sel_sub_block_id, reopen_note, reopen_history, actionable,
                    author, agent_state, reviewer
             FROM comments
             ORDER BY session_id, version_number, created_at",
        )?;
        let comments = stmt.query_map([], |row| {
            let kind_str: String = row.get(3)?;
            let scope_str: Option<String> = row.get(4)?;
            let status_str: String = row.get(10)?;
            let edit_original: Option<String> = row.get(7)?;
            let edit_revised: Option<String> = row.get(8)?;
            let edit = match (edit_original, edit_revised) {
                (Some(o), Some(r)) => Some(EditPayload {
                    original: o,
                    revised: r,
                }),
                _ => None,
            };
            let res_body: Option<String> = row.get(11)?;
            let res_version: Option<u32> = row.get(12)?;
            let res_accepted: Option<i64> = row.get(13)?;
            let block_id: Option<String> = row.get(14)?;
            let structural_json: Option<String> = row.get(15)?;
            let structural = structural_json
                .as_deref()
                .and_then(|s| serde_json::from_str::<StructuralPayload>(s).ok());
            let resolution = match (res_body, res_version) {
                (Some(b), Some(v)) => Some(Resolution {
                    body: b,
                    appeared_in_version: v,
                    accepted_at: res_accepted,
                }),
                _ => None,
            };
            let sel_char_start: Option<i64> = row.get(16)?;
            let sel_char_end: Option<i64> = row.get(17)?;
            let sel_quoted_text: Option<String> = row.get(18)?;
            let sel_sub_block_id: Option<String> = row.get(19)?;
            let selection = match (sel_char_start, sel_char_end, sel_quoted_text) {
                (Some(start), Some(end), Some(text)) => Some(CommentSelection {
                    char_start: start.max(0) as u32,
                    char_end: end.max(0) as u32,
                    quoted_text: text,
                    sub_block_id: sel_sub_block_id,
                }),
                _ => None,
            };
            let reopen_note: Option<String> = row.get(20)?;
            let reopen_history_json: Option<String> = row.get(21)?;
            let reopen_history = reopen_history_json
                .as_deref()
                .and_then(|s| serde_json::from_str::<Vec<RoundHistoryEntry>>(s).ok())
                .unwrap_or_default();
            let actionable: bool = row.get::<_, i64>(22)? != 0;
            let author: Option<String> = row.get(23)?;
            let agent_state: Option<String> = row.get(24)?;
            let reviewer: Option<String> = row.get(25)?;
            Ok((
                row.get::<_, String>(1)?, // session_id
                row.get::<_, u32>(2)?,    // version_number
                Comment {
                    id: row.get(0)?,
                    kind: CommentKind::from_str(&kind_str).unwrap_or(CommentKind::Feedback),
                    scope: scope_str.and_then(|s| CommentScope::from_str(&s)),
                    anchor_id: row.get(5)?,
                    block_id,
                    body: row.get(6)?,
                    structural,
                    edit,
                    created_at: row.get(9)?,
                    status: CommentStatus::from_str(&status_str).unwrap_or(CommentStatus::Draft),
                    resolution,
                    selection,
                    reopen_note,
                    reopen_history,
                    actionable,
                    author,
                    agent_state,
                    reviewer,
                },
            ))
        })?;
        for c in comments {
            let (session_id, version_number, comment) = c?;
            if let Some(s) = sessions.get_mut(&session_id) {
                if let Some(r) = s
                    .revisions
                    .iter_mut()
                    .find(|r| r.version_number == version_number)
                {
                    r.comments.push(comment);
                }
            }
        }

        Ok(sessions)
    }
}

fn session_status_str(s: SessionStatus) -> &'static str {
    match s {
        SessionStatus::InReview => "in_review",
        SessionStatus::Approved => "approved",
        SessionStatus::Aborted => "aborted",
    }
}

fn session_status_from(s: &str) -> SessionStatus {
    match s {
        "approved" => SessionStatus::Approved,
        "aborted" => SessionStatus::Aborted,
        _ => SessionStatus::InReview,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{NewCommentRequest, SessionStore};
    use std::sync::Arc;

    fn make_store() -> SessionStore {
        let db = Arc::new(Database::open_in_memory().unwrap());
        SessionStore::new(db)
    }

    fn prompt_row<'a>(body: &'a str, bh: &'a str, sid: Option<&'a str>) -> crate::ledger::PromptRow<'a> {
        crate::ledger::PromptRow {
            ts: 1000,
            source: "hook",
            origin: "redline",
            surface: "pty",
            role: None,
            session_id: None,
            claude_session_id: sid,
            mission_id: None,
            project_path: Some("/proj"),
            body,
            body_hash: bh,
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
        assert!(nodes.iter().all(|n| n.status == "proposed" && n.parent_id.is_none()));
    }

    #[test]
    fn stage_create_then_accept_writes_curate_event_and_is_idempotent() {
        let db = Database::open_in_memory().unwrap();
        accepted_node(&db, "root-r", None, "redline");
        let out = db
            .stage_proposal(
                None,
                &Proposal::Create {
                    parent_id: "root-r".into(),
                    title: "Loop Engineering".into(),
                    rationale: None,
                },
            )
            .unwrap();
        assert!(matches!(out, crate::classmem::StagedOutcome::Node));
        let staged = db.list_class_nodes().unwrap();
        let node = staged.iter().find(|n| n.title == "Loop Engineering").unwrap();
        assert_eq!(node.status, "proposed");

        // Accept → accepted + exactly one class_curate ledger event.
        let flipped = db.accept_class_node(&node.id).unwrap();
        assert_eq!(flipped, vec![node.id.clone()]);
        for nid in &flipped {
            crate::classmem::record_curate(&db, nid, "accept", "");
        }
        assert_eq!(db.get_class_node(&node.id).unwrap().unwrap().status, "accepted");
        // Re-accept flips nothing (idempotent — no duplicate flip).
        assert!(db.accept_class_node(&node.id).unwrap().is_empty());
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
    fn accepting_a_link_accepts_its_ancestor_chain() {
        let db = Database::open_in_memory().unwrap();
        accepted_node(&db, "root-r", None, "redline");
        // file with a new sub_class → stages a proposed sub-node + a proposed link.
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
        assert_eq!(sub.status, "proposed");
        let link = db.list_class_links_for_node(&sub.id).unwrap().remove(0);
        assert_eq!(link.status, "proposed");

        // Accepting the link accepts the (proposed) sub-node too.
        let (node_id, flipped) = db.accept_class_link(link.id).unwrap().unwrap();
        assert_eq!(node_id, sub.id);
        assert_eq!(flipped, vec![sub.id.clone()]);
        assert_eq!(db.get_class_node(&sub.id).unwrap().unwrap().status, "accepted");
        assert_eq!(
            db.list_class_links_for_node(&sub.id).unwrap()[0].status,
            "accepted"
        );
    }

    #[test]
    fn reject_node_deletes_its_subtree_and_links() {
        let db = Database::open_in_memory().unwrap();
        accepted_node(&db, "root-r", None, "redline");
        accepted_node(&db, "topic", Some("root-r"), "Topic");
        accepted_node(&db, "sub", Some("topic"), "Sub");
        add_link(&db, "sub", "prompt", "7");
        db.reject_class_node("topic").unwrap();
        assert!(db.get_class_node("topic").unwrap().is_none());
        assert!(db.get_class_node("sub").unwrap().is_none());
        assert!(db.list_class_links_for_node("sub").unwrap().is_empty());
        assert!(db.get_class_node("root-r").unwrap().is_some()); // root untouched
    }

    #[test]
    fn promotion_preserves_id_links_pins_and_subtree_and_writes_reorg() {
        let db = Database::open_in_memory().unwrap();
        accepted_node(&db, "root-a", None, "A");
        accepted_node(&db, "root-b", None, "B");
        accepted_node(&db, "grown", Some("root-a"), "Grown Topic");
        accepted_node(&db, "child", Some("grown"), "Child");
        let link_id = add_link(&db, "grown", "prompt", "99");
        db.set_class_node_pinned("grown", true).unwrap();

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
        let applied = db.apply_class_proposal(prop.id).unwrap().unwrap();
        crate::classmem::record_reorg(&db, &applied.op, &applied.node_id, &applied.detail);

        let g = db.get_class_node("grown").unwrap().unwrap();
        assert_eq!(g.id, "grown"); // id preserved
        assert_eq!(g.parent_id.as_deref(), Some("root-b")); // re-parented
        assert!(g.pinned); // pin preserved
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
        let applied = db.apply_class_proposal(prop.id).unwrap().unwrap();
        crate::classmem::record_reorg(&db, &applied.op, &applied.node_id, &applied.detail);

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
    fn collapse_refuses_a_pinned_branch() {
        let db = Database::open_in_memory().unwrap();
        accepted_node(&db, "root-r", None, "redline");
        accepted_node(&db, "cold", Some("root-r"), "Pinned Topic");
        add_link(&db, "cold", "prompt", "1");
        db.set_class_node_pinned("cold", true).unwrap();
        assert!(db.subtree_has_pin("cold").unwrap());

        db.stage_proposal(
            None,
            &Proposal::Collapse {
                node_id: "cold".into(),
                summary: "should not happen".into(),
                cite_seqs: vec![1],
                rationale: None,
            },
        )
        .unwrap();
        let prop = db.list_class_proposals().unwrap().remove(0);
        // Pins veto collapse — the op is a no-op and the branch survives intact.
        assert!(db.apply_class_proposal(prop.id).unwrap().is_none());
        assert!(db.get_class_node("cold").unwrap().is_some());
        assert!(db.list_class_nodes().unwrap().iter().all(|n| n.kind != "digest"));
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
                role: None,
                session_id: Some("s1".into()),
                claude_session_id: Some("cs1".into()),
                mission_id: None,
                project_path: None,
                body: "a long cold prompt body destined to be compacted to a gist".into(),
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
        let cseq = db.compact_prompt_body(pid, "gist: a cold prompt", "cold").unwrap();
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
        assert!(db.compact_prompt_body(pid, "again", "cold").unwrap().is_none());
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
        db.apply_class_proposal(prop.id).unwrap().unwrap();

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
        db.apply_class_proposal(prop.id).unwrap().unwrap();

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
    fn accept_all_pending_applies_the_whole_staged_batch() {
        let db = Database::open_in_memory().unwrap();
        accepted_node(&db, "root-r", None, "redline");
        // Stage a create + a file (proposed node + proposed link).
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
        // Before: two proposed nodes.
        assert_eq!(
            db.list_class_nodes().unwrap().iter().filter(|n| n.status == "proposed").count(),
            2
        );
        // Auto-organize flips everything to accepted in one shot.
        let flipped = db.accept_all_pending().unwrap();
        assert_eq!(flipped.len(), 2);
        assert!(db.list_class_nodes().unwrap().iter().all(|n| n.status == "accepted"));
        let collab = db
            .list_class_nodes()
            .unwrap()
            .into_iter()
            .find(|n| n.title == "Collab")
            .unwrap();
        assert_eq!(db.list_class_links_for_node(&collab.id).unwrap()[0].status, "accepted");
        // Idempotent: nothing left to flip.
        assert!(db.accept_all_pending().unwrap().is_empty());
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
        assert!(crate::ledger::record_revision_event(&db, "s1", 1, "plan body").unwrap().is_some());
        // Same (session, version, payload) → skipped.
        assert!(crate::ledger::record_revision_event(&db, "s1", 1, "plan body").unwrap().is_none());
        // Changed body at same version → recorded.
        assert!(crate::ledger::record_revision_event(&db, "s1", 1, "edited").unwrap().is_some());

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

        // Deleting the review sweeps annotations + viewed rows with it.
        db.delete_review_annotation("rev-1", "rc-001").unwrap();
        assert!(db.list_review_annotations("rev-1").unwrap().is_empty());
        db.insert_review_annotation(&a).unwrap();
        db.delete_code_review("rev-1").unwrap();
        assert!(db.get_code_review("rev-1").is_none());
        assert!(db.list_review_annotations("rev-1").unwrap().is_empty());
        assert!(db.list_review_viewed("rev-1").unwrap().is_empty());
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
                },
            )
            .expect("add comment");
        store.upsert_plan("keep", "/tmp/k", md.to_string(), reparse_sections(md), true, false);

        assert!(store.delete_session("doomed"));
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
                },
            )
            .expect("add comment");
        let db = store.database();

        // Fresh comment: no fork yet.
        assert!(db.get_comment_fork_session("s-fork", "c-001").is_none());
        assert!(!db.is_known_fork_session("fork-xyz"));

        db.set_comment_fork_session("s-fork", "c-001", "fork-xyz")
            .unwrap();
        assert_eq!(
            db.get_comment_fork_session("s-fork", "c-001").as_deref(),
            Some("fork-xyz"),
        );
        assert!(db.is_known_fork_session("fork-xyz"));

        db.clear_comment_fork_session("s-fork", "c-001").unwrap();
        assert!(db.get_comment_fork_session("s-fork", "c-001").is_none());
        assert!(!db.is_known_fork_session("fork-xyz"));
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
                },
            )
            .expect("fresh session c-001 persists");
        assert_eq!(c.id, "c-001");

        // The post-rebuild fork_session_id column landed on the rebuilt
        // legacy `comments` table — set/get round-trips on the legacy row.
        let db = store.database();
        assert!(db.get_comment_fork_session("old", "c-001").is_none());
        db.set_comment_fork_session("old", "c-001", "fork-legacy")
            .unwrap();
        assert_eq!(
            db.get_comment_fork_session("old", "c-001").as_deref(),
            Some("fork-legacy"),
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
        // …and re-run the idempotent migration: only 0-rows are backfilled.
        db.migrate().unwrap();
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
                },
            )
            .unwrap();
        let after = store.get("s").unwrap().updated_at;
        assert!(after >= before);
        assert!(after >= c.created_at);
    }
}
