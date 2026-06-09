// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
use std::collections::{HashMap, HashSet};
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
    /// Structure-independent identity, stable across reparse within a revision.
    /// Persisted as an HTML-comment sidecar in `raw_plan_markdown`. The join
    /// key for track-changes / comments / diff; `anchor_id` stays positional.
    pub block_id: String,
    /// Verbatim markdown source for this block — rendered faithfully by the UI.
    pub markdown: String,
    /// Plain-text rendering, used for revision diffing.
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub anchor_id: AnchorId,
    /// Structure-independent identity for the heading block (see `Paragraph::block_id`).
    pub block_id: String,
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
    /// True when this revision begins a new review *thread* — a fresh,
    /// unrelated plan rather than a revision answering reviewer feedback.
    /// The frontend diffs/clears comments only within a thread, so a fresh
    /// plan renders clean instead of as a redline of the prior plan.
    pub thread_start: bool,
    /// True when this revision is a *restore* — the reviewer re-presented an
    /// already-reviewed plan via "Restore plan session" (same `session_id`,
    /// identical body). It re-uses the prior plan rather than advancing the
    /// substantive version, so the frontend labels it "vN restored" and skips
    /// it when numbering subsequent genuine revisions.
    pub restored: bool,
}

/// How the daemon treats incoming `ExitPlanMode` plans.
///
/// - `Active`   — intercept and block until the reviewer decides (original behavior).
/// - `Ambient`  — surface the plan, but auto-approve after a short decision window
///                unless the reviewer explicitly opens it for review.
/// - `Paused`   — killswitch: immediately auto-approve, capture nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InterceptionMode {
    Active,
    Ambient,
    Paused,
}

impl InterceptionMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            InterceptionMode::Active => "active",
            InterceptionMode::Ambient => "ambient",
            InterceptionMode::Paused => "paused",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "active" => Some(InterceptionMode::Active),
            "ambient" => Some(InterceptionMode::Ambient),
            "paused" => Some(InterceptionMode::Paused),
            _ => None,
        }
    }
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

/// A lightweight per-revision projection for the sidebar's revisions tree —
/// version, timestamp, and the thread-boundary flag, without the heavy
/// `raw_plan_markdown` / `sections` / `comments` payload.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionSummary {
    pub version_number: u32,
    pub received_at: i64,
    pub thread_start: bool,
    pub restored: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session_id: SessionId,
    pub project_name: String,
    pub project_path: String,
    pub latest_version: u32,
    /// Every revision of this session, oldest-first — drives the sidebar tree.
    pub revisions: Vec<RevisionSummary>,
    pub created_at: i64,
    pub status: SessionStatus,
    pub pending_count: u32,
    pub awaiting_review: bool,
    /// A POST is currently held for this session — Claude Code is blocked in
    /// its terminal waiting for review. Such a session must not be deleted.
    /// Set by the `list_sessions` command (the store can't see held POSTs).
    pub held: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
// kebab-case keeps edit/feedback/question identical to the legacy
// lowercase form while giving the new structural kinds hyphenated names.
#[serde(rename_all = "kebab-case")]
pub enum CommentKind {
    Edit,
    Feedback,
    Question,
    BlockInsert,
    BlockDelete,
    BlockMove,
}

impl CommentKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            CommentKind::Edit => "edit",
            CommentKind::Feedback => "feedback",
            CommentKind::Question => "question",
            CommentKind::BlockInsert => "block-insert",
            CommentKind::BlockDelete => "block-delete",
            CommentKind::BlockMove => "block-move",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "edit" => Some(CommentKind::Edit),
            "feedback" => Some(CommentKind::Feedback),
            "question" => Some(CommentKind::Question),
            "block-insert" => Some(CommentKind::BlockInsert),
            "block-delete" => Some(CommentKind::BlockDelete),
            "block-move" => Some(CommentKind::BlockMove),
            _ => None,
        }
    }

    pub fn is_structural(&self) -> bool {
        matches!(
            self,
            CommentKind::BlockInsert | CommentKind::BlockDelete | CommentKind::BlockMove
        )
    }
}

/// Which submission verb a batch of pending comments expresses.
///
/// `Ask` = the user wants Claude to answer questions about the plan without
/// editing it. `Revise` = at least one comment is a *driver* for a plan
/// change (Edit / Feedback / structural). The choice is inferred from the
/// batch, not picked in the UI, so backend payload assembly stays the
/// single source of truth.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubmissionMode {
    Ask,
    Revise,
}

impl SubmissionMode {
    pub fn infer(comments: &[Comment]) -> Self {
        // `CommentKind::Feedback` with `scope == Structural` is still a
        // *driver* — `is_structural()` is kind-based (BlockInsert/Delete/Move)
        // and intentionally returns false for scoped-structural feedback.
        // Matching on `Feedback` directly covers both scopes.
        let any_driver = comments.iter().any(|c| {
            c.kind.is_structural()
                || matches!(c.kind, CommentKind::Edit | CommentKind::Feedback)
                // A question the reviewer promoted into a decision drives the
                // plan, so even an all-questions batch flips to Revise.
                || (matches!(c.kind, CommentKind::Question) && c.actionable)
        });
        if any_driver { Self::Revise } else { Self::Ask }
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

/// Whole-block structural change (D5: an explicit reviewer gesture, never an
/// inferred delete+insert). Stored as `structural_json` and rendered into the
/// feedback payload's STRUCTURAL CHANGES section declaratively.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralPayload {
    /// "insert" | "delete" | "move".
    pub op: String,
    /// Stable id of the affected block (the join key).
    pub block_id: String,
    /// Anchor the block sat at before the change (move/delete).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_anchor: Option<String>,
    /// Anchor the block now sits at (move/insert).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_anchor: Option<String>,
    /// Inserted / deleted block body (verbatim markdown).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub markdown: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolution {
    pub body: String,
    pub appeared_in_version: u32,
    pub accepted_at: Option<i64>,
}

/// One archived reopen round. When a reviewer reopens a resolution and Claude
/// re-resolves it, the prior `{resolution body, reopen note, version}` is
/// pushed here before the live `resolution` is overwritten — so the card can
/// surface a collapsed "earlier rounds" trail without bloating the live state.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundHistoryEntry {
    pub resolution_body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reopen_note: Option<String>,
    pub version: u32,
}

/// Character-range anchor inside a single block's plain textContent. Drives
/// the persistent comment-highlight decoration and the Word-style click
/// bridge with the comment card. Block-relative so it survives Tiptap
/// transactions and revision regenerations (block_ids are stable, absolute
/// PM positions are not).
///
/// `sub_block_id`, when present, names the selection's range structurally
/// (e.g. `blk-X.s3.w2-w4` = sentence 3, words 2..4 of block X). The
/// resolver tiers through it first — stable across any revise where the
/// parent block survives — then falls back to `char_start`/`char_end`,
/// finally to `quoted_text` self-heal. Set only when the original
/// selection landed on whole-word / whole-line / whole-sentence
/// boundaries; partial selections leave it `None`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentSelection {
    pub char_start: u32,
    pub char_end: u32,
    pub quoted_text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sub_block_id: Option<String>,
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
    /// Stable join key to the plan block this comment is attached to (D1).
    /// Set for editor-originated comments; positional `anchor_id` stays for
    /// display. `None` for legacy / sidebar-only comments.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edit: Option<EditPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub structural: Option<StructuralPayload>,
    pub created_at: i64,
    pub status: CommentStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution: Option<Resolution>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<CommentSelection>,
    /// Pending follow-up the reviewer attached when reopening — the correction
    /// or extra context (typed, or promoted from a Discuss fork). Carried back
    /// to Claude in the next Revise payload, then cleared once re-resolved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reopen_note: Option<String>,
    /// Archived prior reopen rounds, oldest-first. Empty for comments that were
    /// never reopened-and-re-resolved.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reopen_history: Vec<RoundHistoryEntry>,
    /// A [question] the reviewer promoted into a directive ("Make this a
    /// change"). Flips the comment from answer-only to a plan driver: it
    /// counts toward Revise inference and is rendered as a `[decision]` Claude
    /// must apply. The original question body + prior answer stay intact for
    /// context. Always false for non-question kinds.
    #[serde(default)]
    pub actionable: bool,
}

/// One turn in a comment's fork-agent discussion thread (Phase 2). Rows are
/// terminal — persisted only once a turn finishes — so `status` is `complete`
/// or `error`; live streaming text is frontend-only state. The fork session
/// itself is tracked by the DB-only `comments.fork_session_id` column, not on
/// `Comment`, so resuming the right fork never reads a stale in-memory value.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMessage {
    pub id: String,
    pub session_id: String,
    pub comment_id: String,
    /// "user" | "assistant".
    pub role: String,
    pub body: String,
    /// "complete" | "error".
    pub status: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewCommentRequest {
    #[serde(rename = "type")]
    pub kind: CommentKind,
    pub scope: Option<CommentScope>,
    pub anchor_id: String,
    #[serde(default)]
    pub block_id: Option<String>,
    pub body: String,
    pub edit: Option<EditPayload>,
    #[serde(default)]
    pub structural: Option<StructuralPayload>,
    #[serde(default)]
    pub selection: Option<CommentSelection>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCommentRequest {
    pub body: Option<String>,
    pub scope: Option<CommentScope>,
    #[serde(default)]
    pub block_id: Option<String>,
    pub edit: Option<EditPayload>,
    #[serde(default)]
    pub structural: Option<StructuralPayload>,
    #[serde(default)]
    pub selection: Option<CommentSelection>,
}

#[derive(Clone)]
pub struct SessionStore {
    inner: Arc<Mutex<HashMap<SessionId, ReviewSession>>>,
    db: Arc<Database>,
    /// Sessions for which the reviewer has armed a one-shot "restore" — the
    /// next inbound plan that re-presents the identical body is tagged as a
    /// restore rather than a fresh version. Ephemeral (in-memory only): losing
    /// it across an app restart just means a restore labels as a normal new
    /// thread, which is acceptable and rare.
    pending_restores: Arc<Mutex<HashSet<SessionId>>>,
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
            pending_restores: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    /// Arm a one-shot restore for `session_id`: the next inbound plan that
    /// re-presents the identical body will be tagged as a restore. Called when
    /// the reviewer clicks "Restore plan session".
    pub fn arm_restore(&self, session_id: &str) {
        self.pending_restores
            .lock()
            .unwrap()
            .insert(session_id.to_string());
    }

    /// Consume the armed restore for `session_id`, returning whether one was
    /// set. Always clears the flag so it is strictly one-shot for the very
    /// next plan, restore or not.
    pub fn take_restore(&self, session_id: &str) -> bool {
        self.pending_restores.lock().unwrap().remove(session_id)
    }

    /// The backing database handle — test-only, for exercising fork-thread
    /// persistence (`thread_messages`, `comments.fork_session_id`) against a
    /// comment created the normal way through the store.
    #[cfg(test)]
    pub fn database(&self) -> Arc<Database> {
        self.db.clone()
    }

    pub fn upsert_plan(
        &self,
        session_id: &str,
        project_path: &str,
        raw_plan: String,
        sections: Vec<Section>,
        thread_start: bool,
        restored: bool,
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
            thread_start,
            restored,
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
                    revisions: s
                        .revisions
                        .iter()
                        .map(|r| RevisionSummary {
                            version_number: r.version_number,
                            received_at: r.received_at,
                            thread_start: r.thread_start,
                            restored: r.restored,
                        })
                        .collect(),
                    created_at: s.created_at,
                    status: s.status,
                    pending_count,
                    awaiting_review,
                    held: false,
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
    ) -> Result<Comment, String> {
        let mut map = self.inner.lock().unwrap();
        let session = map
            .get_mut(session_id)
            .ok_or_else(|| format!("no session found for id {session_id}"))?;

        if session.revisions.is_empty() {
            return Err(format!("session {session_id} has no revisions yet"));
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
        let structural = if request.kind.is_structural() {
            request.structural.clone()
        } else {
            None
        };
        let comment = Comment {
            id,
            kind: request.kind,
            scope,
            anchor_id: request.anchor_id,
            block_id: request.block_id,
            body: request.body,
            edit,
            structural,
            created_at: now_millis(),
            status: CommentStatus::Draft,
            resolution: None,
            selection: request.selection,
            reopen_note: None,
            reopen_history: Vec::new(),
            actionable: false,
        };

        let latest = session.revisions.last_mut().expect("non-empty checked above");
        if let Err(e) = self
            .db
            .insert_comment(session_id, latest.version_number, &comment)
        {
            tracing::error!(error = %e, "failed to persist comment");
            return Err(format!("failed to persist comment: {e}"));
        }
        latest.comments.push(comment.clone());
        Ok(comment)
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
                if update.block_id.is_some() {
                    comment.block_id = update.block_id;
                }
                if update.structural.is_some() && comment.kind.is_structural() {
                    comment.structural = update.structural;
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
                if let Some(selection) = update.selection {
                    comment.selection = Some(selection);
                }
                if let Err(e) = self.db.update_comment(session_id, comment) {
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
                if let Err(e) = self.db.delete_comment(session_id, comment_id) {
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

    /// Permanently remove a session and all its revisions/comments (memory +
    /// DB). Returns false if no such session. Callers must ensure no POST is
    /// currently held for it (an active terminal).
    pub fn delete_session(&self, session_id: &str) -> bool {
        let mut map = self.inner.lock().unwrap();
        if map.remove(session_id).is_none() {
            return false;
        }
        if let Err(e) = self.db.delete_session(session_id) {
            tracing::error!(error = %e, "failed to delete session from db");
        }
        true
    }

    /// True iff a `submit_review` denial is still outstanding for this session:
    /// the session is in review and at least one comment is awaiting a new
    /// revision (`Submitted`) or was reopened after an unsatisfactory
    /// resolution (`Reopened`). This is the signal that the *next* inbound
    /// plan is a revision answering feedback rather than a fresh, unrelated
    /// plan reusing the same Claude Code terminal session id.
    pub fn has_outstanding_review(&self, session_id: &str) -> bool {
        let map = self.inner.lock().unwrap();
        let Some(session) = map.get(session_id) else {
            return false;
        };
        if !matches!(session.status, SessionStatus::InReview) {
            return false;
        }
        session
            .revisions
            .iter()
            .flat_map(|r| r.comments.iter())
            .any(|c| matches!(c.status, CommentStatus::Submitted | CommentStatus::Reopened))
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
                    // Re-resolving a reopened comment closes a round: archive the
                    // prior resolution + the note that drove this round, then
                    // consume the note so a fresh reopen starts clean.
                    if matches!(comment.status, CommentStatus::Reopened) {
                        if let Some(prior) = comment.resolution.take() {
                            comment.reopen_history.push(RoundHistoryEntry {
                                resolution_body: prior.body,
                                reopen_note: comment.reopen_note.take(),
                                version: prior.appeared_in_version,
                            });
                        } else {
                            comment.reopen_note = None;
                        }
                    }
                    comment.resolution = Some(Resolution {
                        body: body.clone(),
                        appeared_in_version,
                        accepted_at: None,
                    });
                    comment.status = CommentStatus::Resolved;
                    matched.insert(comment.id.clone(), true);
                    if let Err(e) = self.db.update_comment(session_id, comment) {
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

    pub fn drafts_and_reopens_for_payload(
        &self,
        session_id: &str,
    ) -> Option<(Vec<Section>, Vec<Comment>, String)> {
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
        Some((
            latest.sections.clone(),
            comments,
            latest.raw_plan_markdown.clone(),
        ))
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
                    if let Err(e) = self.db.update_comment(session_id, comment) {
                        tracing::error!(error = %e, "failed to persist submit transition");
                    }
                }
            }
        }
        ids
    }

    /// Roll back a failed `submit_review`: restore the listed comments from
    /// Submitted back to Draft so the reviewer can re-run the plan and resubmit.
    /// (A reopened-then-submitted comment also returns to Draft — its content is
    /// preserved and it stays editable, which is all the rollback needs.)
    pub fn unmark_submitted(&self, session_id: &str, ids: &[String]) {
        let mut map = self.inner.lock().unwrap();
        let Some(session) = map.get_mut(session_id) else {
            return;
        };
        for revision in session.revisions.iter_mut() {
            for comment in revision.comments.iter_mut() {
                if matches!(comment.status, CommentStatus::Submitted)
                    && ids.contains(&comment.id)
                {
                    comment.status = CommentStatus::Draft;
                    if let Err(e) = self.db.update_comment(session_id, comment) {
                        tracing::error!(error = %e, "failed to persist submit rollback");
                    }
                }
            }
        }
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
                    if let Err(e) = self.db.update_comment(session_id, comment) {
                        tracing::error!(error = %e, "failed to persist accept");
                    }
                    return true;
                }
            }
        }
        false
    }

    /// Reopen a resolved (or already-accepted) resolution, attaching an optional
    /// follow-up note for the next Revise round. The prior `resolution` body is
    /// kept (it's the continuity Claude needs) but un-accepted; `note` replaces
    /// any pending note (an empty/blank note clears it).
    ///
    /// `as_change` promotes a [question] into a directive ("Make this a
    /// change"): the comment becomes a plan driver and is rendered as a
    /// `[decision]` Claude must apply, with `note` carrying the decision text.
    pub fn reopen_resolution(
        &self,
        session_id: &str,
        comment_id: &str,
        note: Option<&str>,
        as_change: bool,
    ) -> bool {
        let mut map = self.inner.lock().unwrap();
        let Some(session) = map.get_mut(session_id) else {
            return false;
        };
        let note = note.map(str::trim).filter(|s| !s.is_empty());
        for revision in session.revisions.iter_mut() {
            for comment in revision.comments.iter_mut() {
                if comment.id == comment_id {
                    comment.status = CommentStatus::Reopened;
                    comment.reopen_note = note.map(str::to_string);
                    if as_change {
                        comment.actionable = true;
                    }
                    if let Some(res) = comment.resolution.as_mut() {
                        res.accepted_at = None;
                    }
                    if let Err(e) = self.db.update_comment(session_id, comment) {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn comment(kind: CommentKind, scope: Option<CommentScope>) -> Comment {
        Comment {
            id: "c-0".to_string(),
            kind,
            scope,
            anchor_id: "A".to_string(),
            block_id: None,
            body: String::new(),
            edit: None,
            structural: None,
            created_at: 0,
            status: CommentStatus::Draft,
            resolution: None,
            selection: None,
            reopen_note: None,
            reopen_history: Vec::new(),
            actionable: false,
        }
    }

    #[test]
    fn submission_mode_empty_is_ask() {
        // An empty batch wouldn't actually pass `submit_review` (which
        // requires drafts/reopens), but the classifier should still answer
        // sensibly: no drivers → Ask.
        assert_eq!(SubmissionMode::infer(&[]), SubmissionMode::Ask);
    }

    #[test]
    fn submission_mode_all_questions_is_ask() {
        let batch = [
            comment(CommentKind::Question, None),
            comment(CommentKind::Question, None),
        ];
        assert_eq!(SubmissionMode::infer(&batch), SubmissionMode::Ask);
    }

    #[test]
    fn submission_mode_actionable_question_is_revise() {
        // A promoted question ("Make this a change") drives the plan, so even
        // an otherwise all-questions batch flips to Revise.
        let mut q = comment(CommentKind::Question, None);
        q.actionable = true;
        let batch = [comment(CommentKind::Question, None), q];
        assert_eq!(SubmissionMode::infer(&batch), SubmissionMode::Revise);
    }

    #[test]
    fn submission_mode_one_edit_is_revise() {
        let batch = [
            comment(CommentKind::Question, None),
            comment(CommentKind::Edit, None),
        ];
        assert_eq!(SubmissionMode::infer(&batch), SubmissionMode::Revise);
    }

    #[test]
    fn submission_mode_feedback_local_is_revise() {
        let batch = [comment(CommentKind::Feedback, Some(CommentScope::Local))];
        assert_eq!(SubmissionMode::infer(&batch), SubmissionMode::Revise);
    }

    #[test]
    fn submission_mode_feedback_structural_scope_is_revise() {
        // Regression: a `Feedback` with `scope == Structural` is NOT a
        // structural-kind comment (BlockInsert/Delete/Move) — it must still
        // be classified as a driver.
        let batch = [comment(
            CommentKind::Feedback,
            Some(CommentScope::Structural),
        )];
        assert_eq!(SubmissionMode::infer(&batch), SubmissionMode::Revise);
    }

    #[test]
    fn submission_mode_block_delete_is_revise() {
        let batch = [comment(CommentKind::BlockDelete, None)];
        assert_eq!(SubmissionMode::infer(&batch), SubmissionMode::Revise);
    }
}
