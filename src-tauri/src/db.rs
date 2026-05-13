use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection};

use crate::state::{
    reparse_sections, Comment, CommentKind, CommentScope, CommentStatus, EditPayload, Resolution,
    ReviewSession, Revision, SessionStatus,
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

            CREATE TABLE IF NOT EXISTS comments (
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
                status TEXT NOT NULL,
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
        conn.execute(
            "INSERT INTO comments (
                id, session_id, version_number, type, scope, anchor_id,
                body, edit_original, edit_revised, created_at, status,
                resolution_body, resolution_version, resolution_accepted_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
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
            ],
        )?;
        Ok(())
    }

    pub fn update_comment(&self, comment: &Comment) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        let (edit_original, edit_revised) = match &comment.edit {
            Some(e) => (Some(e.original.as_str()), Some(e.revised.as_str())),
            None => (None, None),
        };
        let (res_body, res_version, res_accepted) = match &comment.resolution {
            Some(r) => (Some(r.body.as_str()), Some(r.appeared_in_version), r.accepted_at),
            None => (None, None, None),
        };
        conn.execute(
            "UPDATE comments SET
                scope = ?1,
                body = ?2,
                edit_original = ?3,
                edit_revised = ?4,
                status = ?5,
                resolution_body = ?6,
                resolution_version = ?7,
                resolution_accepted_at = ?8
             WHERE id = ?9",
            params![
                comment.scope.map(|s| s.as_str()),
                comment.body,
                edit_original,
                edit_revised,
                comment.status.as_str(),
                res_body,
                res_version,
                res_accepted,
                comment.id,
            ],
        )?;
        Ok(())
    }

    pub fn delete_comment(&self, comment_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM comments WHERE id = ?1", params![comment_id])?;
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
                    resolution_body, resolution_version, resolution_accepted_at
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
                    body: row.get(6)?,
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
                body: "Rethink the detail section.".to_string(),
                edit: None,
            },
        );
        store.add_comment(
            "sess-rt",
            NewCommentRequest {
                kind: CommentKind::Question,
                scope: None,
                anchor_id: "A".to_string(),
                body: "Why this order?".to_string(),
                edit: None,
            },
        );

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
                    body: "swap wording".to_string(),
                    edit: Some(EditPayload {
                        original: "Body.".to_string(),
                        revised: "Substance.".to_string(),
                    }),
                },
            );
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

    fn tempfile_path() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("redline-test-{}.db", uuid::Uuid::new_v4()));
        p
    }
}
