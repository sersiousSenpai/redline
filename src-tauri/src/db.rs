// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection};

use crate::state::{
    reparse_sections, AttachState, Comment, CommentKind, CommentScope, CommentSelection,
    CommentStatus, EditPayload, Resolution, ReviewSession, Revision, RoundHistoryEntry,
    SessionStatus, StructuralPayload, ThreadMessage,
};

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

    /// True if `session_id` is the forked session of any comment — used by
    /// `handle_plan` to ignore stray `ExitPlanMode` POSTs from a fork agent.
    pub fn is_known_fork_session(&self, session_id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT 1 FROM comments WHERE fork_session_id = ?1 LIMIT 1",
            params![session_id],
            |_| Ok(()),
        )
        .is_ok()
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
    fn restore_flag_is_one_shot_and_persists() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let store = SessionStore::new(db.clone());
        let md = "# Plan\n\nBody.\n";

        // v1: a genuine plan.
        store.upsert_plan("s", "/tmp/s", md.to_string(), reparse_sections(md), true, false);

        // Arm a restore: one-shot — the second take observes nothing.
        store.arm_restore("s");
        assert!(store.take_restore("s"));
        assert!(!store.take_restore("s"));

        // The restore re-presents the same plan, tagged restored.
        store.upsert_plan("s", "/tmp/s", md.to_string(), reparse_sections(md), true, true);

        let session = store.get("s").expect("session");
        assert_eq!(session.revisions.len(), 2);
        assert!(!session.revisions[0].restored);
        assert!(session.revisions[1].restored);

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

        // Same body re-presented via "Restore plan session".
        store.upsert_plan("s", "/tmp/s", md.to_string(), reparse_sections(md), true, true);

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
