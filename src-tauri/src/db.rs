// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use crate::state::{
    reparse_sections, AttachState, BrowseMessage, CodeReviewSession, Comment, CommentKind,
    CommentScope, CommentSelection, CommentStatus, EditPayload, LoopAttempt, LoopCheckpoint,
    LoopRun, Linked, LinkedMessage, LoopStateEntry, LoopSubtask, LoopTrace, Mission,
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

/// Decode a JSON string-array column (`deps_json`, `touched_paths_json`) into a
/// `Vec<String>`; NULL or malformed JSON yields an empty vec (never an error —
/// a missing edge list just means "no dependencies").
fn json_str_array(raw: Option<String>) -> Vec<String> {
    raw.and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
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

            -- Loop Orchestrator: once a reviewed plan is approved, an engine
            -- decomposes it into parallelizable subtasks, runs executor agents
            -- in isolated git worktrees, has a SEPARATE reviewer grade each
            -- against a rubric, and pauses at human checkpoints before any
            -- merge or final land. Mirrors the missions three-table shape: a
            -- parent run row holding the resumable planner session id, child
            -- subtask/attempt rows, and terminal trace/checkpoint rows. The
            -- durable truth across restarts is the `status` columns + session
            -- ids (the live processes are disposable). See looporch.rs.
            CREATE TABLE IF NOT EXISTS loop_runs (
                run_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                title TEXT NOT NULL,
                plan_md TEXT NOT NULL,
                repo_path TEXT NOT NULL,
                -- The user's real branch. Written only by the final land step,
                -- so a mid-run crash leaves it pristine.
                base_ref TEXT NOT NULL,
                -- `redline/loop/<run8>/integration`, forked off base_ref at run
                -- start; every approved subtask merges here, not into base.
                integration_branch TEXT NOT NULL,
                -- planning | running | paused_checkpoint | review | done | failed | cancelled
                status TEXT NOT NULL DEFAULT 'planning',
                planner_session_id TEXT,
                max_parallel INTEGER NOT NULL DEFAULT 3,
                max_attempts INTEGER NOT NULL DEFAULT 3,
                turn_budget INTEGER NOT NULL DEFAULT 40,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS loop_subtasks (
                subtask_id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                title TEXT NOT NULL,
                instructions TEXT NOT NULL,
                rubric TEXT NOT NULL,
                -- DAG edges (declared + synthetic file-overlap), JSON array of
                -- prerequisite subtask ids.
                deps_json TEXT,
                -- Planner-declared file globs; drives overlap serialization +
                -- the post-exec scope check. JSON array.
                touched_paths_json TEXT,
                -- pending | blocked | running | reviewing | needs_changes
                -- | awaiting_merge | merged | stuck | failed | skipped
                status TEXT NOT NULL DEFAULT 'pending',
                branch TEXT,
                worktree_path TEXT,
                attempts INTEGER NOT NULL DEFAULT 0,
                executor_session_id TEXT,
                -- planner-flagged migrations/deploys/network (checkpoint hint)
                irreversible INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (run_id) REFERENCES loop_runs(run_id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_loop_subtasks
                ON loop_subtasks (run_id, seq);

            CREATE TABLE IF NOT EXISTS loop_attempts (
                attempt_id TEXT PRIMARY KEY,
                subtask_id TEXT NOT NULL,
                attempt_no INTEGER NOT NULL,
                -- executor | reviewer
                role TEXT NOT NULL,
                -- running | complete | error
                status TEXT NOT NULL,
                -- pass | fail (reviewer only)
                verdict TEXT,
                score INTEGER,
                feedback TEXT,
                diff_stat TEXT,
                claude_session_id TEXT,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (subtask_id) REFERENCES loop_subtasks(subtask_id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_loop_attempts
                ON loop_attempts (subtask_id, created_at);

            -- Durable agent scratch store — survives restarts/kills.
            CREATE TABLE IF NOT EXISTS loop_state (
                run_id TEXT NOT NULL,
                scope TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (run_id, scope, key)
            );

            -- Append-only trajectory log.
            CREATE TABLE IF NOT EXISTS loop_traces (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                subtask_id TEXT,
                attempt_id TEXT,
                -- planner | reviewer_verdict | merge | checkpoint
                -- | termination | error | hill_suggestion
                kind TEXT NOT NULL,
                body TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_loop_traces
                ON loop_traces (run_id, created_at);

            -- Held human gates. The pending row is the durable truth; the
            -- in-memory oneshot sender is disposable and re-armed on restart.
            CREATE TABLE IF NOT EXISTS loop_checkpoints (
                checkpoint_id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                subtask_id TEXT,
                -- merge | subtask_stuck | land | destructive | plan_approval
                kind TEXT NOT NULL,
                summary TEXT NOT NULL,
                -- the human's choice + optional note / edited instructions
                decision_json TEXT,
                -- pending | approved | denied | expired
                status TEXT NOT NULL DEFAULT 'pending',
                created_at INTEGER NOT NULL,
                decided_at INTEGER,
                FOREIGN KEY (run_id) REFERENCES loop_runs(run_id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_loop_checkpoints
                ON loop_checkpoints (run_id, status);

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
        // Persisted attach state: lets detachment survive app restarts and be
        // visible for background sessions (the live `held` flag is recomputed
        // from in-memory senders and tells nothing after a crash).
        let _ = conn.execute(
            "ALTER TABLE sessions ADD COLUMN attach_state TEXT NOT NULL DEFAULT 'idle'",
            [],
        );
        Ok(())
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
            "INSERT INTO sessions (session_id, project_path, project_name, created_at, status, attach_state)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(session_id) DO UPDATE SET
                project_path = excluded.project_path,
                project_name = excluded.project_name,
                status = excluded.status,
                attach_state = excluded.attach_state",
            params![
                session.session_id,
                session.project_path,
                session.project_name,
                session.created_at,
                session_status_str(session.status),
                session.attach_state.as_str(),
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
        Ok(())
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
                author, agent_state
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)",
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
            ],
        )?;
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
                agent_state = ?19
             WHERE session_id = ?20 AND id = ?21",
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

    // --- Loop Orchestrator: runs ------------------------------------------

    pub fn insert_loop_run(&self, r: &LoopRun) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO loop_runs
                (run_id, session_id, title, plan_md, repo_path, base_ref,
                 integration_branch, status, planner_session_id, max_parallel,
                 max_attempts, turn_budget, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                r.run_id,
                r.session_id,
                r.title,
                r.plan_md,
                r.repo_path,
                r.base_ref,
                r.integration_branch,
                r.status,
                r.planner_session_id,
                r.max_parallel,
                r.max_attempts,
                r.turn_budget,
                r.created_at,
                r.updated_at,
            ],
        )?;
        Ok(())
    }

    fn map_loop_run(row: &rusqlite::Row) -> rusqlite::Result<LoopRun> {
        Ok(LoopRun {
            run_id: row.get(0)?,
            session_id: row.get(1)?,
            title: row.get(2)?,
            plan_md: row.get(3)?,
            repo_path: row.get(4)?,
            base_ref: row.get(5)?,
            integration_branch: row.get(6)?,
            status: row.get(7)?,
            planner_session_id: row.get(8)?,
            max_parallel: row.get(9)?,
            max_attempts: row.get(10)?,
            turn_budget: row.get(11)?,
            created_at: row.get(12)?,
            updated_at: row.get(13)?,
        })
    }

    const LOOP_RUN_COLS: &'static str =
        "run_id, session_id, title, plan_md, repo_path, base_ref, integration_branch, \
         status, planner_session_id, max_parallel, max_attempts, turn_budget, \
         created_at, updated_at";

    pub fn get_loop_run(&self, run_id: &str) -> rusqlite::Result<Option<LoopRun>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!("SELECT {} FROM loop_runs WHERE run_id = ?1", Self::LOOP_RUN_COLS),
            params![run_id],
            Self::map_loop_run,
        )
        .optional()
    }

    /// Distinct working directories the user has worked in, most-recent first —
    /// every `sessions.project_path` (a plan review) unioned with every
    /// `loop_runs.repo_path` (a Loop run). This is Redline's de-facto "projects"
    /// registry: it backs the browse agent's `/v1/code/projects` map and is the
    /// allowlist the read-only git route validates a `repo` against. Paths are
    /// returned verbatim (may no longer exist on disk — the caller filters).
    pub fn list_project_paths(&self) -> rusqlite::Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT path FROM (
                 SELECT project_path AS path, MAX(created_at) AS recent
                     FROM sessions GROUP BY project_path
                 UNION ALL
                 SELECT repo_path AS path, MAX(created_at) AS recent
                     FROM loop_runs GROUP BY repo_path
             )
             WHERE path IS NOT NULL AND path <> ''
             GROUP BY path
             ORDER BY MAX(recent) DESC",
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

    pub fn list_loop_runs(&self) -> rusqlite::Result<Vec<LoopRun>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM loop_runs ORDER BY created_at DESC",
            Self::LOOP_RUN_COLS
        ))?;
        let rows = stmt.query_map([], Self::map_loop_run)?;
        rows.collect()
    }

    /// Runs in a given status — the restart reconciler asks for `running`.
    pub fn list_loop_runs_by_status(&self, status: &str) -> rusqlite::Result<Vec<LoopRun>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM loop_runs WHERE status = ?1 ORDER BY created_at",
            Self::LOOP_RUN_COLS
        ))?;
        let rows = stmt.query_map(params![status], Self::map_loop_run)?;
        rows.collect()
    }

    pub fn update_loop_run_status(&self, run_id: &str, status: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE loop_runs SET status = ?2, updated_at = ?3 WHERE run_id = ?1",
            params![run_id, status, crate::state::now_millis()],
        )?;
        Ok(())
    }

    pub fn get_planner_session(&self, run_id: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT planner_session_id FROM loop_runs WHERE run_id = ?1",
            params![run_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    }

    pub fn set_planner_session(&self, run_id: &str, sid: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE loop_runs SET planner_session_id = ?2 WHERE run_id = ?1",
            params![run_id, sid],
        )?;
        Ok(())
    }

    /// Hard-delete a run and all its children (manual cascade — correct
    /// regardless of the `foreign_keys` PRAGMA, like `delete_mission`).
    pub fn delete_loop_run(&self, run_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM loop_attempts WHERE subtask_id IN
                (SELECT subtask_id FROM loop_subtasks WHERE run_id = ?1)",
            params![run_id],
        )?;
        conn.execute("DELETE FROM loop_subtasks WHERE run_id = ?1", params![run_id])?;
        conn.execute("DELETE FROM loop_state WHERE run_id = ?1", params![run_id])?;
        conn.execute("DELETE FROM loop_traces WHERE run_id = ?1", params![run_id])?;
        conn.execute("DELETE FROM loop_checkpoints WHERE run_id = ?1", params![run_id])?;
        conn.execute("DELETE FROM loop_runs WHERE run_id = ?1", params![run_id])?;
        Ok(())
    }

    // --- Loop Orchestrator: subtasks --------------------------------------

    pub fn insert_loop_subtask(&self, s: &LoopSubtask) -> rusqlite::Result<()> {
        let deps = serde_json::to_string(&s.deps).unwrap_or_else(|_| "[]".to_string());
        let touched =
            serde_json::to_string(&s.touched_paths).unwrap_or_else(|_| "[]".to_string());
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO loop_subtasks
                (subtask_id, run_id, seq, title, instructions, rubric, deps_json,
                 touched_paths_json, status, branch, worktree_path, attempts,
                 executor_session_id, irreversible)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                s.subtask_id,
                s.run_id,
                s.seq,
                s.title,
                s.instructions,
                s.rubric,
                deps,
                touched,
                s.status,
                s.branch,
                s.worktree_path,
                s.attempts,
                s.executor_session_id,
                s.irreversible as i64,
            ],
        )?;
        Ok(())
    }

    fn map_loop_subtask(row: &rusqlite::Row) -> rusqlite::Result<LoopSubtask> {
        Ok(LoopSubtask {
            subtask_id: row.get(0)?,
            run_id: row.get(1)?,
            seq: row.get(2)?,
            title: row.get(3)?,
            instructions: row.get(4)?,
            rubric: row.get(5)?,
            deps: json_str_array(row.get(6)?),
            touched_paths: json_str_array(row.get(7)?),
            status: row.get(8)?,
            branch: row.get(9)?,
            worktree_path: row.get(10)?,
            attempts: row.get(11)?,
            executor_session_id: row.get(12)?,
            irreversible: row.get::<_, i64>(13)? != 0,
        })
    }

    const LOOP_SUBTASK_COLS: &'static str =
        "subtask_id, run_id, seq, title, instructions, rubric, deps_json, \
         touched_paths_json, status, branch, worktree_path, attempts, \
         executor_session_id, irreversible";

    pub fn get_subtask(&self, subtask_id: &str) -> rusqlite::Result<Option<LoopSubtask>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!(
                "SELECT {} FROM loop_subtasks WHERE subtask_id = ?1",
                Self::LOOP_SUBTASK_COLS
            ),
            params![subtask_id],
            Self::map_loop_subtask,
        )
        .optional()
    }

    pub fn list_subtasks(&self, run_id: &str) -> rusqlite::Result<Vec<LoopSubtask>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM loop_subtasks WHERE run_id = ?1 ORDER BY seq",
            Self::LOOP_SUBTASK_COLS
        ))?;
        let rows = stmt.query_map(params![run_id], Self::map_loop_subtask)?;
        rows.collect()
    }

    pub fn update_subtask_status(&self, subtask_id: &str, status: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE loop_subtasks SET status = ?2 WHERE subtask_id = ?1",
            params![subtask_id, status],
        )?;
        Ok(())
    }

    pub fn set_subtask_worktree(&self, subtask_id: &str, worktree_path: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE loop_subtasks SET worktree_path = ?2 WHERE subtask_id = ?1",
            params![subtask_id, worktree_path],
        )?;
        Ok(())
    }

    pub fn get_executor_session(&self, subtask_id: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT executor_session_id FROM loop_subtasks WHERE subtask_id = ?1",
            params![subtask_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    }

    pub fn set_executor_session(&self, subtask_id: &str, sid: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE loop_subtasks SET executor_session_id = ?2 WHERE subtask_id = ?1",
            params![subtask_id, sid],
        )?;
        Ok(())
    }

    /// Bump the attempt counter and return the new value.
    pub fn incr_subtask_attempts(&self, subtask_id: &str) -> rusqlite::Result<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE loop_subtasks SET attempts = attempts + 1 WHERE subtask_id = ?1",
            params![subtask_id],
        )?;
        conn.query_row(
            "SELECT attempts FROM loop_subtasks WHERE subtask_id = ?1",
            params![subtask_id],
            |row| row.get(0),
        )
    }

    /// Edit-and-retry from the stuck checkpoint: overwrite the instructions and
    /// reset the attempt counter so the subtask re-enters scheduling fresh.
    pub fn edit_and_reset_subtask(
        &self,
        subtask_id: &str,
        instructions: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE loop_subtasks SET instructions = ?2, attempts = 0 WHERE subtask_id = ?1",
            params![subtask_id, instructions],
        )?;
        Ok(())
    }

    // --- Loop Orchestrator: attempts --------------------------------------

    pub fn insert_attempt(&self, a: &LoopAttempt) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO loop_attempts
                (attempt_id, subtask_id, attempt_no, role, status, verdict, score,
                 feedback, diff_stat, claude_session_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                a.attempt_id,
                a.subtask_id,
                a.attempt_no,
                a.role,
                a.status,
                a.verdict,
                a.score,
                a.feedback,
                a.diff_stat,
                a.claude_session_id,
                a.created_at,
            ],
        )?;
        Ok(())
    }

    /// Close out an attempt row with its terminal status + reviewer verdict.
    #[allow(clippy::too_many_arguments)]
    pub fn finish_attempt(
        &self,
        attempt_id: &str,
        status: &str,
        verdict: Option<&str>,
        score: Option<i64>,
        feedback: Option<&str>,
        diff_stat: Option<&str>,
        claude_session_id: Option<&str>,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE loop_attempts
             SET status = ?2, verdict = ?3, score = ?4, feedback = ?5,
                 diff_stat = ?6, claude_session_id = COALESCE(?7, claude_session_id)
             WHERE attempt_id = ?1",
            params![attempt_id, status, verdict, score, feedback, diff_stat, claude_session_id],
        )?;
        Ok(())
    }

    pub fn list_attempts(&self, subtask_id: &str) -> rusqlite::Result<Vec<LoopAttempt>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT attempt_id, subtask_id, attempt_no, role, status, verdict, score,
                    feedback, diff_stat, claude_session_id, created_at
             FROM loop_attempts WHERE subtask_id = ?1 ORDER BY created_at, attempt_no",
        )?;
        let rows = stmt.query_map(params![subtask_id], |row| {
            Ok(LoopAttempt {
                attempt_id: row.get(0)?,
                subtask_id: row.get(1)?,
                attempt_no: row.get(2)?,
                role: row.get(3)?,
                status: row.get(4)?,
                verdict: row.get(5)?,
                score: row.get(6)?,
                feedback: row.get(7)?,
                diff_stat: row.get(8)?,
                claude_session_id: row.get(9)?,
                created_at: row.get(10)?,
            })
        })?;
        rows.collect()
    }

    // --- Loop Orchestrator: durable scratch state -------------------------

    #[allow(dead_code)] // symmetric accessor; the daemon reads via loop_state_list
    pub fn loop_state_get(&self, run_id: &str, scope: &str, key: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT value FROM loop_state WHERE run_id = ?1 AND scope = ?2 AND key = ?3",
            params![run_id, scope, key],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn loop_state_set(
        &self,
        run_id: &str,
        scope: &str,
        key: &str,
        value: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO loop_state (run_id, scope, key, value, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(run_id, scope, key) DO UPDATE SET value = ?4, updated_at = ?5",
            params![run_id, scope, key, value, crate::state::now_millis()],
        )?;
        Ok(())
    }

    pub fn loop_state_list(&self, run_id: &str, scope: &str) -> rusqlite::Result<Vec<LoopStateEntry>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT run_id, scope, key, value, updated_at
             FROM loop_state WHERE run_id = ?1 AND scope = ?2 ORDER BY key",
        )?;
        let rows = stmt.query_map(params![run_id, scope], |row| {
            Ok(LoopStateEntry {
                run_id: row.get(0)?,
                scope: row.get(1)?,
                key: row.get(2)?,
                value: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })?;
        rows.collect()
    }

    // --- Loop Orchestrator: traces ----------------------------------------

    pub fn insert_trace(&self, t: &LoopTrace) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO loop_traces
                (id, run_id, subtask_id, attempt_id, kind, body, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![t.id, t.run_id, t.subtask_id, t.attempt_id, t.kind, t.body, t.created_at],
        )?;
        Ok(())
    }

    pub fn list_traces(&self, run_id: &str) -> rusqlite::Result<Vec<LoopTrace>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, run_id, subtask_id, attempt_id, kind, body, created_at
             FROM loop_traces WHERE run_id = ?1 ORDER BY created_at, id",
        )?;
        let rows = stmt.query_map(params![run_id], |row| {
            Ok(LoopTrace {
                id: row.get(0)?,
                run_id: row.get(1)?,
                subtask_id: row.get(2)?,
                attempt_id: row.get(3)?,
                kind: row.get(4)?,
                body: row.get(5)?,
                created_at: row.get(6)?,
            })
        })?;
        rows.collect()
    }

    // --- Loop Orchestrator: checkpoints -----------------------------------

    pub fn insert_checkpoint(&self, c: &LoopCheckpoint) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO loop_checkpoints
                (checkpoint_id, run_id, subtask_id, kind, summary, decision_json,
                 status, created_at, decided_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                c.checkpoint_id,
                c.run_id,
                c.subtask_id,
                c.kind,
                c.summary,
                c.decision_json,
                c.status,
                c.created_at,
                c.decided_at,
            ],
        )?;
        Ok(())
    }

    fn map_checkpoint(row: &rusqlite::Row) -> rusqlite::Result<LoopCheckpoint> {
        Ok(LoopCheckpoint {
            checkpoint_id: row.get(0)?,
            run_id: row.get(1)?,
            subtask_id: row.get(2)?,
            kind: row.get(3)?,
            summary: row.get(4)?,
            decision_json: row.get(5)?,
            status: row.get(6)?,
            created_at: row.get(7)?,
            decided_at: row.get(8)?,
        })
    }

    const LOOP_CHECKPOINT_COLS: &'static str =
        "checkpoint_id, run_id, subtask_id, kind, summary, decision_json, \
         status, created_at, decided_at";

    pub fn get_checkpoint(&self, checkpoint_id: &str) -> rusqlite::Result<Option<LoopCheckpoint>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!(
                "SELECT {} FROM loop_checkpoints WHERE checkpoint_id = ?1",
                Self::LOOP_CHECKPOINT_COLS
            ),
            params![checkpoint_id],
            Self::map_checkpoint,
        )
        .optional()
    }

    /// Record the human's decision on a checkpoint (status + decision payload).
    pub fn decide_checkpoint(
        &self,
        checkpoint_id: &str,
        status: &str,
        decision_json: Option<&str>,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE loop_checkpoints
             SET status = ?2, decision_json = ?3, decided_at = ?4
             WHERE checkpoint_id = ?1",
            params![checkpoint_id, status, decision_json, crate::state::now_millis()],
        )?;
        Ok(())
    }

    /// Pending checkpoints for a run (the UI shows these as held gates).
    pub fn list_pending_checkpoints(&self, run_id: &str) -> rusqlite::Result<Vec<LoopCheckpoint>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM loop_checkpoints
             WHERE run_id = ?1 AND status = 'pending' ORDER BY created_at",
            Self::LOOP_CHECKPOINT_COLS
        ))?;
        let rows = stmt.query_map(params![run_id], Self::map_checkpoint)?;
        rows.collect()
    }

    /// Every pending checkpoint across all runs — the restart reconciler
    /// re-arms each one's in-memory gate.
    #[allow(dead_code)] // reconcile re-arms per-run; kept for a global sweep
    pub fn list_all_pending_checkpoints(&self) -> rusqlite::Result<Vec<LoopCheckpoint>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM loop_checkpoints WHERE status = 'pending' ORDER BY created_at",
            Self::LOOP_CHECKPOINT_COLS
        ))?;
        let rows = stmt.query_map([], Self::map_checkpoint)?;
        rows.collect()
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
            "SELECT session_id, project_path, project_name, created_at, status, attach_state FROM sessions",
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
                    author, agent_state
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
    fn restored_revision_carries_open_comments_forward() {
        use crate::state::{CommentKind, CommentStatus};
        let db = Arc::new(Database::open_in_memory().unwrap());
        let store = SessionStore::new(db.clone());
        let md = "# Plan\n\nBody.\n";
        store.upsert_plan("s", "/tmp/s", md.to_string(), reparse_sections(md), true, false);
        let comment = |body: &str| NewCommentRequest {
            kind: CommentKind::Feedback,
            scope: None,
            anchor_id: "A".to_string(),
            block_id: Some("rl:blk-1".to_string()),
            structural: None,
            body: body.to_string(),
            edit: None,
            selection: None,
            author: None,
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
                    kind: CommentKind::Question,
                    scope: None,
                    anchor_id: "A".to_string(),
                    block_id: None,
                    structural: None,
                    body: "q".to_string(),
                    edit: None,
                    selection: None,
                    author: None,
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
                    kind: CommentKind::Feedback,
                    scope: None,
                    anchor_id: "A".to_string(),
                    block_id: Some("rl:blk-1".to_string()),
                    structural: None,
                    body: "in flight".to_string(),
                    edit: None,
                    selection: None,
                    author: None,
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
                    kind: CommentKind::Question,
                    scope: None,
                    anchor_id: "A".to_string(),
                    block_id: None,
                    structural: None,
                    body: "why?".to_string(),
                    edit: None,
                    selection: None,
                    author: None,
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
            kind: CommentKind::Feedback,
            scope: Some(CommentScope::Structural),
            anchor_id: "A".to_string(),
            block_id: None,
            structural: None,
            body: "rethink this entire section".to_string(),
            edit: None,
            selection: None,
            author: None,
        };
        let c1 = store.add_comment("sess-1", req).expect("add");
        assert_eq!(c1.id, "c-001");
        assert!(matches!(c1.kind, CommentKind::Feedback));
        assert!(matches!(c1.scope, Some(CommentScope::Structural)));

        let req2 = NewCommentRequest {
            kind: CommentKind::Question,
            scope: None,
            anchor_id: "A".to_string(),
            block_id: None,
            structural: None,
            body: "why?".to_string(),
            edit: None,
            selection: None,
            author: None,
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
                },
            )
            .expect("add agent comment");
        assert_eq!(agent.author.as_deref(), Some("claude-code"));
        assert!(agent.agent_state.is_none());

        let user = store
            .add_comment(
                "sess-a",
                NewCommentRequest {
                    kind: CommentKind::Question,
                    scope: None,
                    anchor_id: "A".to_string(),
                    block_id: None,
                    structural: None,
                    body: "why?".to_string(),
                    edit: None,
                    selection: None,
                    author: None,
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
            kind: CommentKind::Question,
            scope: None,
            anchor_id: "A".to_string(),
            block_id: None,
            structural: None,
            body: "why?".to_string(),
            edit: None,
            selection: None,
            author: None,
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
                    kind: CommentKind::Question,
                    scope: None,
                    anchor_id: "A".to_string(),
                    block_id: None,
                    structural: None,
                    body: "why?".to_string(),
                    edit: None,
                    selection: None,
                    author: None,
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
                        kind,
                        scope: None,
                        anchor_id: "A".to_string(),
                        block_id: None,
                        structural: None,
                        body: body.to_string(),
                        edit: None,
                        selection: None,
                        author: None,
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
                    kind: CommentKind::Feedback,
                    scope: None,
                    anchor_id: "A".to_string(),
                    block_id: None,
                    structural: None,
                    body: "Tighten this.".to_string(),
                    edit: None,
                    selection: None,
                    author: None,
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
                kind: CommentKind::Feedback,
                scope: Some(CommentScope::Structural),
                anchor_id: "A.1".to_string(),
                block_id: None,
                structural: None,
                body: "Rethink the detail section.".to_string(),
                edit: None,
                selection: None,
                author: None,
            },
        )
        .expect("add comment");
        store.add_comment(
            "sess-rt",
            NewCommentRequest {
                kind: CommentKind::Question,
                scope: None,
                anchor_id: "A".to_string(),
                block_id: None,
                structural: None,
                body: "Why this order?".to_string(),
                edit: None,
                selection: None,
                author: None,
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
                    kind: CommentKind::Question,
                    scope: None,
                    anchor_id: "A".to_string(),
                    block_id: None,
                    structural: None,
                    body: "Why this order?".to_string(),
                    edit: None,
                    selection: None,
                    author: None,
                },
            )
            .expect("add q1");
        store
            .add_comment(
                "sess-ask",
                NewCommentRequest {
                    kind: CommentKind::Question,
                    scope: None,
                    anchor_id: "B".to_string(),
                    block_id: None,
                    structural: None,
                    body: "Why is Beta last?".to_string(),
                    edit: None,
                    selection: None,
                    author: None,
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
            kind: CommentKind::Question,
            scope: None,
            anchor_id: "A".to_string(),
            block_id: None,
            structural: None,
            body: body.to_string(),
            edit: None,
            selection: None,
            author: None,
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
                    kind: CommentKind::Question,
                    scope: None,
                    anchor_id: "T".to_string(),
                    block_id: None,
                    structural: None,
                    body: "new session comment".to_string(),
                    edit: None,
                    selection: None,
                    author: None,
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
}
