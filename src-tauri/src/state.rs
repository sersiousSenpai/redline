use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::parser;

pub type SessionId = String;
pub type AnchorId = String;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Paragraph {
    pub anchor_id: AnchorId,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub anchor_id: AnchorId,
    pub level: u8,
    pub title: String,
    pub body_markdown: String,
    pub children: Vec<Section>,
    pub paragraphs: Vec<Paragraph>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub version_number: u32,
    pub received_at: i64,
    pub raw_plan_markdown: String,
    pub sections: Vec<Section>,
    pub comments: Vec<Comment>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub enum SessionStatus {
    InReview,
    Approved,
    Aborted,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSession {
    pub session_id: SessionId,
    pub project_path: String,
    pub project_name: String,
    pub created_at: i64,
    pub revisions: Vec<Revision>,
    pub status: SessionStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session_id: SessionId,
    pub project_name: String,
    pub project_path: String,
    pub latest_version: u32,
    pub created_at: i64,
    pub status: SessionStatus,
    pub pending_count: u32,
    pub awaiting_review: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommentKind {
    Edit,
    Feedback,
    Question,
}

impl CommentKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            CommentKind::Edit => "edit",
            CommentKind::Feedback => "feedback",
            CommentKind::Question => "question",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "edit" => Some(CommentKind::Edit),
            "feedback" => Some(CommentKind::Feedback),
            "question" => Some(CommentKind::Question),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommentScope {
    Local,
    Structural,
}

impl CommentScope {
    pub fn as_str(&self) -> &'static str {
        match self {
            CommentScope::Local => "local",
            CommentScope::Structural => "structural",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "local" => Some(CommentScope::Local),
            "structural" => Some(CommentScope::Structural),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[allow(dead_code)]
pub enum CommentStatus {
    Draft,
    Submitted,
    Resolved,
    Accepted,
    Reopened,
    Withdrawn,
}

impl CommentStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            CommentStatus::Draft => "draft",
            CommentStatus::Submitted => "submitted",
            CommentStatus::Resolved => "resolved",
            CommentStatus::Accepted => "accepted",
            CommentStatus::Reopened => "reopened",
            CommentStatus::Withdrawn => "withdrawn",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "draft" => Some(CommentStatus::Draft),
            "submitted" => Some(CommentStatus::Submitted),
            "resolved" => Some(CommentStatus::Resolved),
            "accepted" => Some(CommentStatus::Accepted),
            "reopened" => Some(CommentStatus::Reopened),
            "withdrawn" => Some(CommentStatus::Withdrawn),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditPayload {
    pub original: String,
    pub revised: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolution {
    pub body: String,
    pub appeared_in_version: u32,
    pub accepted_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: CommentKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<CommentScope>,
    pub anchor_id: String,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edit: Option<EditPayload>,
    pub created_at: i64,
    pub status: CommentStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution: Option<Resolution>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewCommentRequest {
    #[serde(rename = "type")]
    pub kind: CommentKind,
    pub scope: Option<CommentScope>,
    pub anchor_id: String,
    pub body: String,
    pub edit: Option<EditPayload>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCommentRequest {
    pub body: Option<String>,
    pub scope: Option<CommentScope>,
    pub edit: Option<EditPayload>,
}

#[derive(Clone)]
pub struct SessionStore {
    inner: Arc<Mutex<HashMap<SessionId, ReviewSession>>>,
    db: Arc<Database>,
}

pub struct UpsertResult {
    pub version_number: u32,
    pub is_new_session: bool,
}

impl SessionStore {
    pub fn new(db: Arc<Database>) -> Self {
        let map = db.load_all().unwrap_or_else(|e| {
            tracing::error!(error = %e, "failed to load sessions from db; starting empty");
            HashMap::new()
        });
        Self {
            inner: Arc::new(Mutex::new(map)),
            db,
        }
    }

    pub fn upsert_plan(
        &self,
        session_id: &str,
        project_path: &str,
        raw_plan: String,
        sections: Vec<Section>,
    ) -> UpsertResult {
        let now = now_millis();
        let project_name = derive_project_name(project_path);
        let mut map = self.inner.lock().unwrap();
        let session = map.entry(session_id.to_string()).or_insert_with(|| {
            let s = ReviewSession {
                session_id: session_id.to_string(),
                project_path: project_path.to_string(),
                project_name: project_name.clone(),
                created_at: now,
                revisions: Vec::new(),
                status: SessionStatus::InReview,
            };
            if let Err(e) = self.db.upsert_session(&s) {
                tracing::error!(error = %e, "failed to persist session");
            }
            s
        });
        let is_new_session = session.revisions.is_empty();
        let version_number = (session.revisions.len() as u32) + 1;
        let revision = Revision {
            version_number,
            received_at: now,
            raw_plan_markdown: raw_plan,
            sections,
            comments: Vec::new(),
        };
        if let Err(e) = self.db.insert_revision(session_id, &revision) {
            tracing::error!(error = %e, "failed to persist revision");
        }
        session.revisions.push(revision);
        UpsertResult {
            version_number,
            is_new_session,
        }
    }

    pub fn list(&self) -> Vec<SessionSummary> {
        let map = self.inner.lock().unwrap();
        let mut sessions: Vec<SessionSummary> = map
            .values()
            .map(|s| {
                let latest_version = s.revisions.last().map(|r| r.version_number).unwrap_or(0);
                let pending_count = s
                    .revisions
                    .iter()
                    .flat_map(|r| r.comments.iter())
                    .filter(|c| {
                        matches!(
                            c.status,
                            CommentStatus::Draft | CommentStatus::Reopened
                        )
                    })
                    .count() as u32;
                let awaiting_review = matches!(s.status, SessionStatus::InReview);
                SessionSummary {
                    session_id: s.session_id.clone(),
                    project_name: s.project_name.clone(),
                    project_path: s.project_path.clone(),
                    latest_version,
                    created_at: s.created_at,
                    status: s.status,
                    pending_count,
                    awaiting_review,
                }
            })
            .collect();
        sessions.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        sessions
    }

    pub fn get(&self, session_id: &str) -> Option<ReviewSession> {
        let map = self.inner.lock().unwrap();
        map.get(session_id).cloned()
    }

    pub fn add_comment(
        &self,
        session_id: &str,
        request: NewCommentRequest,
    ) -> Option<Comment> {
        let mut map = self.inner.lock().unwrap();
        let session = map.get_mut(session_id)?;

        if session.revisions.is_empty() {
            return None;
        }

        let next_n = session
            .revisions
            .iter()
            .flat_map(|r| r.comments.iter())
            .filter_map(|c| parse_comment_id(&c.id))
            .max()
            .unwrap_or(0)
            + 1;
        let id = format!("c-{:03}", next_n);

        let scope = match request.kind {
            CommentKind::Feedback => Some(request.scope.unwrap_or(CommentScope::Local)),
            _ => None,
        };
        let edit = match request.kind {
            CommentKind::Edit => request.edit.clone(),
            _ => None,
        };
        let comment = Comment {
            id,
            kind: request.kind,
            scope,
            anchor_id: request.anchor_id,
            body: request.body,
            edit,
            created_at: now_millis(),
            status: CommentStatus::Draft,
            resolution: None,
        };

        let latest = session.revisions.last_mut().expect("non-empty checked above");
        if let Err(e) = self
            .db
            .insert_comment(session_id, latest.version_number, &comment)
        {
            tracing::error!(error = %e, "failed to persist comment");
            return None;
        }
        latest.comments.push(comment.clone());
        Some(comment)
    }

    pub fn update_comment(
        &self,
        session_id: &str,
        comment_id: &str,
        update: UpdateCommentRequest,
    ) -> Option<Comment> {
        let mut map = self.inner.lock().unwrap();
        let session = map.get_mut(session_id)?;
        for revision in session.revisions.iter_mut() {
            if let Some(comment) = revision.comments.iter_mut().find(|c| c.id == comment_id) {
                if let Some(body) = update.body {
                    comment.body = body;
                }
                if matches!(comment.kind, CommentKind::Feedback) {
                    if let Some(scope) = update.scope {
                        comment.scope = Some(scope);
                    }
                }
                if matches!(comment.kind, CommentKind::Edit) {
                    if let Some(edit) = update.edit {
                        comment.edit = Some(edit);
                    }
                }
                if let Err(e) = self.db.update_comment(comment) {
                    tracing::error!(error = %e, "failed to persist comment update");
                }
                return Some(comment.clone());
            }
        }
        None
    }

    pub fn delete_comment(&self, session_id: &str, comment_id: &str) -> bool {
        let mut map = self.inner.lock().unwrap();
        let Some(session) = map.get_mut(session_id) else {
            return false;
        };
        for revision in session.revisions.iter_mut() {
            let before = revision.comments.len();
            revision.comments.retain(|c| c.id != comment_id);
            if revision.comments.len() != before {
                if let Err(e) = self.db.delete_comment(comment_id) {
                    tracing::error!(error = %e, "failed to delete comment from db");
                }
                return true;
            }
        }
        false
    }

    pub fn has_session(&self, session_id: &str) -> bool {
        self.inner.lock().unwrap().contains_key(session_id)
    }

    pub fn attach_resolutions(
        &self,
        session_id: &str,
        resolutions: &HashMap<String, String>,
        appeared_in_version: u32,
    ) -> ResolutionAttachReport {
        let mut report = ResolutionAttachReport::default();
        let mut map = self.inner.lock().unwrap();
        let Some(session) = map.get_mut(session_id) else {
            report.session_missing = true;
            return report;
        };

        let mut matched: HashMap<String, bool> = resolutions
            .keys()
            .map(|k| (k.clone(), false))
            .collect();

        for revision in session.revisions.iter_mut() {
            for comment in revision.comments.iter_mut() {
                if let Some(body) = resolutions.get(&comment.id) {
                    comment.resolution = Some(Resolution {
                        body: body.clone(),
                        appeared_in_version,
                        accepted_at: None,
                    });
                    comment.status = CommentStatus::Resolved;
                    matched.insert(comment.id.clone(), true);
                    if let Err(e) = self.db.update_comment(comment) {
                        tracing::error!(error = %e, "failed to persist resolution attach");
                    }
                }
            }
        }

        for (id, was_matched) in matched {
            if !was_matched {
                report.unmatched_ids.push(id);
            }
        }

        for revision in &session.revisions {
            for c in &revision.comments {
                if matches!(c.status, CommentStatus::Submitted)
                    && !resolutions.contains_key(&c.id)
                {
                    report.unresolved_submitted_ids.push(c.id.clone());
                }
            }
        }

        report
    }

    pub fn drafts_and_reopens_for_payload(&self, session_id: &str) -> Option<(Vec<Section>, Vec<Comment>)> {
        let map = self.inner.lock().unwrap();
        let session = map.get(session_id)?;
        let latest = session.revisions.last()?;
        let comments: Vec<Comment> = session
            .revisions
            .iter()
            .flat_map(|r| r.comments.iter())
            .filter(|c| {
                matches!(c.status, CommentStatus::Draft | CommentStatus::Reopened)
            })
            .cloned()
            .collect();
        Some((latest.sections.clone(), comments))
    }

    pub fn mark_submitted(&self, session_id: &str) -> Vec<String> {
        let mut map = self.inner.lock().unwrap();
        let Some(session) = map.get_mut(session_id) else {
            return Vec::new();
        };
        let mut ids = Vec::new();
        for revision in session.revisions.iter_mut() {
            for comment in revision.comments.iter_mut() {
                if matches!(
                    comment.status,
                    CommentStatus::Draft | CommentStatus::Reopened
                ) {
                    comment.status = CommentStatus::Submitted;
                    ids.push(comment.id.clone());
                    if let Err(e) = self.db.update_comment(comment) {
                        tracing::error!(error = %e, "failed to persist submit transition");
                    }
                }
            }
        }
        ids
    }

    pub fn set_status(&self, session_id: &str, status: SessionStatus) {
        let mut map = self.inner.lock().unwrap();
        if let Some(session) = map.get_mut(session_id) {
            session.status = status;
            if let Err(e) = self.db.upsert_session(session) {
                tracing::error!(error = %e, "failed to persist session status");
            }
        }
    }

    pub fn accept_resolution(&self, session_id: &str, comment_id: &str) -> bool {
        let now = now_millis();
        let mut map = self.inner.lock().unwrap();
        let Some(session) = map.get_mut(session_id) else {
            return false;
        };
        for revision in session.revisions.iter_mut() {
            for comment in revision.comments.iter_mut() {
                if comment.id == comment_id && comment.resolution.is_some() {
                    if let Some(res) = comment.resolution.as_mut() {
                        res.accepted_at = Some(now);
                    }
                    comment.status = CommentStatus::Accepted;
                    if let Err(e) = self.db.update_comment(comment) {
                        tracing::error!(error = %e, "failed to persist accept");
                    }
                    return true;
                }
            }
        }
        false
    }

    pub fn reopen_resolution(&self, session_id: &str, comment_id: &str) -> bool {
        let mut map = self.inner.lock().unwrap();
        let Some(session) = map.get_mut(session_id) else {
            return false;
        };
        for revision in session.revisions.iter_mut() {
            for comment in revision.comments.iter_mut() {
                if comment.id == comment_id {
                    comment.status = CommentStatus::Reopened;
                    if let Err(e) = self.db.update_comment(comment) {
                        tracing::error!(error = %e, "failed to persist reopen");
                    }
                    return true;
                }
            }
        }
        false
    }
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolutionAttachReport {
    pub session_missing: bool,
    pub unmatched_ids: Vec<String>,
    pub unresolved_submitted_ids: Vec<String>,
}

fn parse_comment_id(id: &str) -> Option<u32> {
    id.strip_prefix("c-").and_then(|n| n.parse().ok())
}

pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn derive_project_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| path.to_string())
}

pub fn reparse_sections(raw: &str) -> Vec<Section> {
    parser::parse_plan(raw)
}
