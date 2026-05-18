use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection};

use crate::state::{
    reparse_sections, Comment, CommentKind, CommentScope, CommentStatus, EditPayload, Resolution,
    ReviewSession, Revision, SessionStatus, StructuralPayload,
};

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
            "INSERT INTO sessions (session_id, project_path, project_name, created_at, status)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(session_id) DO UPDATE SET
                project_path = excluded.project_path,
                project_name = excluded.project_name,
                status = excluded.status",
            params![
                session.session_id,
                session.project_path,
                session.project_name,
                session.created_at,
                session_status_str(session.status),
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
            "INSERT INTO revisions (session_id, version_number, received_at, raw_plan_markdown)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(session_id, version_number) DO UPDATE SET
                received_at = excluded.received_at,
                raw_plan_markdown = excluded.raw_plan_markdown",
            params![
                session_id,
                revision.version_number,
                revision.received_at,
                revision.raw_plan_markdown,
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
        conn.execute(
            "INSERT INTO comments (
                id, session_id, version_number, type, scope, anchor_id,
                body, edit_original, edit_revised, created_at, status,
                resolution_body, resolution_version, resolution_accepted_at,
                block_id, structural_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
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
                structural_json = ?10
             WHERE session_id = ?11 AND id = ?12",
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
                session_id,
                comment.id,
            ],
        )?;
        Ok(())
    }

    pub fn delete_comment(&self, session_id: &str, comment_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM comments WHERE session_id = ?1 AND id = ?2",
            params![session_id, comment_id],
        )?;
        Ok(())
    }

    pub fn load_all(&self) -> rusqlite::Result<HashMap<String, ReviewSession>> {
        let conn = self.conn.lock().unwrap();
        let mut sessions: HashMap<String, ReviewSession> = HashMap::new();

        let mut stmt = conn.prepare(
            "SELECT session_id, project_path, project_name, created_at, status FROM sessions",
        )?;
        let rows = stmt.query_map([], |row| {
            let status_str: String = row.get(4)?;
            Ok(ReviewSession {
                session_id: row.get(0)?,
                project_path: row.get(1)?,
                project_name: row.get(2)?,
                created_at: row.get(3)?,
                revisions: Vec::new(),
                status: session_status_from(&status_str),
            })
        })?;
        for row in rows {
            let s = row?;
            sessions.insert(s.session_id.clone(), s);
        }
        drop(stmt);

        let mut stmt = conn.prepare(
            "SELECT session_id, version_number, received_at, raw_plan_markdown
             FROM revisions ORDER BY session_id, version_number",
        )?;
        let revs = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, u32>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        for r in revs {
            let (session_id, version_number, received_at, raw_plan_markdown) = r?;
            if let Some(s) = sessions.get_mut(&session_id) {
                let sections = reparse_sections(&raw_plan_markdown);
                s.revisions.push(Revision {
                    version_number,
                    received_at,
                    raw_plan_markdown,
                    sections,
                    comments: Vec::new(),
                });
            }
        }
        drop(stmt);

        let mut stmt = conn.prepare(
            "SELECT id, session_id, version_number, type, scope, anchor_id,
                    body, edit_original, edit_revised, created_at, status,
                    resolution_body, resolution_version, resolution_accepted_at,
                    block_id, structural_json
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
    fn add_and_retrieve_comments() {
        let store = make_store();
        let sections = reparse_sections("# A\n\nIntro paragraph.\n");
        store.upsert_plan("sess-1", "/tmp/proj", "# A\n\nIntro paragraph.\n".to_string(), sections);

        let req = NewCommentRequest {
            kind: CommentKind::Feedback,
            scope: Some(CommentScope::Structural),
            anchor_id: "A".to_string(),
            block_id: None,
            structural: None,
            body: "rethink this entire section".to_string(),
            edit: None,
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
        };
        let c2 = store.add_comment("sess-1", req2).expect("add 2");
        assert_eq!(c2.id, "c-002");
        assert!(c2.scope.is_none());

        let session = store.get("sess-1").expect("get session");
        assert_eq!(session.revisions[0].comments.len(), 2);
    }

    #[test]
    fn full_round_trip_state_machine() {
        use crate::feedback::serialize_feedback_payload;
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
            },
        )
        .expect("add comment");

        // Build the feedback payload and submit
        let (sections, draft_comments) = store
            .drafts_and_reopens_for_payload("sess-rt")
            .expect("session exists");
        assert_eq!(draft_comments.len(), 2);
        let payload = serialize_feedback_payload(&sections, &draft_comments);
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
        store.upsert_plan("sess-rt", "/tmp/proj", stripped, v2_sections);

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

        // Accept c-001, reopen c-002
        assert!(store.accept_resolution("sess-rt", "c-001"));
        assert!(store.reopen_resolution("sess-rt", "c-002"));

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

        // Submitting again should include the reopened c-002 but not the accepted c-001
        let (_, comments_for_round_2) = store
            .drafts_and_reopens_for_payload("sess-rt")
            .expect("session exists");
        let ids: Vec<&str> = comments_for_round_2.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, vec!["c-002"]);
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
            store.upsert_plan("sess-x", "/tmp/p", md.to_string(), reparse_sections(md));
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
        store.upsert_plan("s", "/tmp/s", md.to_string(), reparse_sections(md));

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
        store.upsert_plan("s", "/tmp/s", md.to_string(), reparse_sections(md));

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
        store.upsert_plan("sess-a", "/tmp/a", md.to_string(), reparse_sections(md));
        store.upsert_plan("sess-b", "/tmp/b", md.to_string(), reparse_sections(md));

        let mk = |body: &str| NewCommentRequest {
            kind: CommentKind::Question,
            scope: None,
            anchor_id: "A".to_string(),
            block_id: None,
            structural: None,
            body: body.to_string(),
            edit: None,
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
        store.upsert_plan("fresh", "/tmp/fresh", md.to_string(), reparse_sections(md));
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
                },
            )
            .expect("fresh session c-001 persists");
        assert_eq!(c.id, "c-001");

        let _ = std::fs::remove_file(&tmpfile);
    }
}
