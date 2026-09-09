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
    /// The parsed block tree.
    ///
    /// **Lazily materialized.** Inside `SessionStore`'s own map this is always
    /// EMPTY — `raw_plan_markdown` is the record, and the parse is a
    /// derivation of it. It is filled on the way out, by `SessionStore::get`
    /// and by the store's internal `sections_for`, from a cache keyed by
    /// (session, version).
    ///
    /// Startup used to parse every revision of every session in the history:
    /// `Database::load_sessions` called `reparse_sections` per row, so opening
    /// Redline meant a full markdown parse of every plan you had ever
    /// reviewed, before the window appeared, to render a sidebar that shows
    /// titles and dates. A `ReviewSession` handed OUT by the store always has
    /// this populated; the emptiness is an implementation detail of the map.
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub enum SessionStatus {
    InReview,
    Approved,
    Aborted,
}

/// Whether Claude Code is wired to this review right now.
///
/// - `Idle`     — no POST held and nothing unresolved: the last decision was
///                delivered (or the session is brand new / approved).
/// - `Held`     — a hook POST is currently held; Claude is blocked waiting.
/// - `Detached` — the held POST died before a decision (hook timeout, terminal
///                closed, app restart). Submitting/approving would no-op until
///                the reviewer restores the session.
///
/// Persisted so detachment survives app restarts and is visible for
/// background sessions — unlike the real-time `held` flag, which is
/// recomputed from live senders on every `list_sessions`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AttachState {
    Idle,
    Held,
    Detached,
}

impl AttachState {
    pub fn as_str(&self) -> &'static str {
        match self {
            AttachState::Idle => "idle",
            AttachState::Held => "held",
            AttachState::Detached => "detached",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "idle" => Some(AttachState::Idle),
            "held" => Some(AttachState::Held),
            "detached" => Some(AttachState::Detached),
            _ => None,
        }
    }
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
    pub attach_state: AttachState,
    /// Last-activity timestamp (revision/comment/thread message/status
    /// change) — the sidebar orders sessions by it, newest first.
    pub updated_at: i64,
    /// Orchestrated-run lifecycle (orchestrating | running | in_code_review |
    /// landed | stalled). `None` for plain Approves — deliberately separate
    /// from the frozen three-value `status` so reconciliation and the
    /// liveness watchdog stay untouched.
    pub run_state: Option<String>,
    /// Which harness authored this plan: `claude-code` | `codex`. `None` on
    /// every pre-backend row, which reads as claude-code everywhere it
    /// matters. Not cosmetic: RESTORE branches on it, because
    /// `claude --resume` handed a Codex thread id fails into a *fresh*
    /// session rather than an error.
    pub backend: Option<String>,
    /// The model that produced the latest revision. Codex sends it on the
    /// Stop payload; a Claude launch fills it from the door's pick.
    pub model: Option<String>,
    pub effort: Option<String>,
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
    /// First `# heading` of the latest revision's plan — the session's display
    /// name. Derived on `list()`, never persisted. `None` = heading-less plan.
    pub plan_title: Option<String>,
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
    /// The dock terminal tab whose `claude` the held POST came from — scopes
    /// the in-terminal "plan intercepted" strip to that tab only. `None`
    /// while not held, or when the plan was intercepted from an external
    /// terminal. Set by `list_sessions` alongside `held`.
    pub held_terminal_id: Option<String>,
    /// Persisted attach state — `Detached` means the held POST died before a
    /// decision and the session needs a restore before submit/approve work.
    pub attach_state: AttachState,
    /// Last-activity timestamp — `list()` sorts by it, newest first.
    pub updated_at: i64,
    /// Orchestrated-run lifecycle chip state; `None` for plain Approves.
    pub run_state: Option<String>,
    /// How the run actually executed — `workflow` or `sequential` — joined
    /// from the `orchestrations` row. `None` until the watcher settles it.
    /// Carried onto the summary (rather than left to the Runs surface) so the
    /// sidebar chip, the only run affordance visible without navigating away,
    /// can show that a run silently degraded to the sequential fallback.
    pub run_mode: Option<String>,
    /// Which harness authored the plan, and at what model — the session
    /// header's badge. `None` reads as claude-code.
    pub backend: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
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
        if any_driver {
            Self::Revise
        } else {
            Self::Ask
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

/// A file the reviewer attached to a comment — a screenshot of the UI they
/// mean, a mock, a log.
///
/// `path` is an ABSOLUTE local path, and that is the whole transport. The
/// revise payload is delivered as plain text to the user's real Claude Code
/// session, which has full tool access, so naming the file is strictly better
/// than base64-ing it into the prompt: no size blowup, no encoding, and Claude
/// reads it with the tool it already has. The file is *copied* into app data at
/// capture time (see `save_attachment` / `import_attachment`) precisely so this
/// path stays valid — submit can happen long after capture, and a source the
/// user has since moved or deleted would break the payload silently.
///
/// `bytes` and `mime` are recorded at capture so the UI can render a chip
/// without touching disk.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommentAttachment {
    /// Absolute path inside `<app_data_dir>/attachments/<session_id>/`.
    pub path: String,
    /// Display name (the original basename, sanitized and de-duplicated).
    pub name: String,
    /// Best-effort content type from the extension, e.g. "image/png".
    pub mime: String,
    pub bytes: u64,
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
    /// Who proposed this comment when it wasn't the reviewer: the agent id
    /// passed to `agent_suggest_edit` (M4). `None` for every user-originated
    /// comment, which keeps the serialized shape — and the feedback payload —
    /// byte-identical to the pre-M4 contract.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// In-place resolution of an agent suggestion while it is still a draft:
    /// `"accepted"` once the reviewer applied it in the editor. The comment
    /// deliberately stays Draft (it must keep owning its block and ride the
    /// submit payload as a normal [edit]); this field only drives the card
    /// chip. `None` for user comments and undecided agent suggestions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_state: Option<String>,
    /// Human attribution for comments that arrived from another person — a
    /// collaborator in a live room or an async Review Request return ("John
    /// Doe"). Distinct from `author`, which is an AGENT id and drives the M4
    /// block-lock; this field is display/attribution only. `None` for every
    /// comment the session owner wrote themselves, which keeps the serialized
    /// shape byte-identical to the pre-collab contract.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewer: Option<String>,
    /// When the external reviewer actually wrote this comment (the return
    /// payload's `createdAt`), as opposed to `created_at` — when the import
    /// landed it here. `None` for every owner-originated comment, keeping the
    /// serialized shape (and the feedback payload) byte-identical.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_created_at: Option<i64>,
    /// The Review Request this comment arrived on (the share's `requestId`),
    /// back-linking an imported comment to its share. `None` unless imported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub share_request_id: Option<String>,
    /// Files the reviewer attached to this comment ("make it look like this",
    /// plus a screenshot). Empty for every comment without one, which keeps the
    /// serialized shape — and the feedback payload — byte-identical to the
    /// pre-attachment contract.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<CommentAttachment>,
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
    /// Files the reviewer dropped into this follow-up. The fork can `Read` them
    /// during the discussion, and their paths ride the `attach_discussion`
    /// rider into the next Revise payload. Always empty on assistant turns.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<CommentAttachment>,
    pub created_at: i64,
}

/// One **code-review** session: the diff-review analog of a plan session.
/// Backed by the `review_sessions` table. `round` is the diff analog of a plan
/// revision — each Submit → agent-fix → re-review cycle increments it, and
/// annotations re-anchor across rounds by `quoted_text` (content identity;
/// line numbers are a hint). Named to avoid colliding with `ReviewSession`,
/// which predates this feature and means a *plan* review session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeReviewSession {
    pub review_id: String,
    pub repo_path: String,
    /// DiffSource tag: "uncommitted" | "staged" | "unstagedPlusUntracked" |
    /// "lastCommit" | "vsBase" | "commitSha".
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit_sha: Option<String>,
    /// The dock terminal whose `claude` opened this review (via the blocking
    /// `/v1/reviews/start` route). `None` for read-only browsing sessions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    pub round: i64,
    pub created_at: i64,
}

/// One line-anchored annotation on a code-review diff. Backed by the
/// `review_annotations` table — deliberately parallel to (not reusing) the
/// plan-review `comments` table, whose ProseMirror-shaped anchors can't
/// address git lines and whose serialized contract is byte-frozen.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewAnnotation {
    pub id: String,
    pub review_id: String,
    /// Round this annotation currently anchors to (bumped when carried forward).
    pub round: i64,
    pub file_path: String,
    /// "old" | "new" — which side of the diff the range addresses.
    pub side: String,
    pub start_line: i64,
    pub end_line: i64,
    /// "comment" | "deletion" | "suggestion".
    pub kind: String,
    pub body: String,
    /// The replacement text, when `kind == "suggestion"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggestion_replacement: Option<String>,
    /// Verbatim text of the selected lines — the DURABLE anchor. Re-review
    /// rounds re-locate this text in the new diff; `start_line`/`end_line`
    /// are only a hint into one specific round's diff.
    pub quoted_text: String,
    /// "draft" | "submitted" | "carried" | "orphaned".
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<String>,
    pub created_at: i64,
    /// "line" | "file" | "general" — what the annotation anchors to. `file`
    /// keeps `file_path` with zeroed lines and empty `quoted_text`; `general`
    /// additionally has an empty `file_path`. Explicit (not sentinel-derived)
    /// so line-anchored code paths never need to guess.
    #[serde(default = "default_annotation_scope")]
    pub scope: String,
    /// Optional conventional-comment label (praise, nitpick, suggestion,
    /// issue, todo, question, thought, chore, note, typo, polish). The payload
    /// serializer whitelists values — an unknown label is silently dropped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Label decoration: "blocking" | "non-blocking" | "if-minor".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocking: Option<String>,
    /// Who authored it: "user" (the reviewer), "ai" (the pre-review job), or
    /// an external tool's source tag.
    #[serde(default = "default_annotation_source")]
    pub source: String,
}

fn default_annotation_scope() -> String {
    "line".to_string()
}

fn default_annotation_source() -> String {
    "user".to_string()
}

/// An Ask-AI question about a diff selection — the reviewer's private
/// consultation. Deliberately NOT an annotation: it never serializes into the
/// feedback payload and is not carried across rounds. Its conversation lives
/// in `thread_messages` keyed `(review_id, question_id)`; the `ask-` id
/// namespace can't collide with `rc-`/`ai-` annotation ids.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewQuestion {
    pub id: String,
    pub review_id: String,
    pub file_path: String,
    pub side: String,
    pub start_line: i64,
    pub end_line: i64,
    pub quoted_text: String,
    pub created_at: i64,
}

/// One recorded commit-and-push from the Code Review surface. Backed by the
/// `review_pushes` table; `review_feedback.rs` reports the latest one back to
/// the waiting agent as the `PUSHED:` block.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushRecord {
    pub id: String,
    pub review_id: String,
    pub repo_path: String,
    pub remote: String,
    /// The push TARGET branch (never the checkout, which is untouched).
    pub branch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit_sha: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_number: Option<i64>,
    pub files: i64,
    pub created_at: i64,
}

/// One turn in a browser tab's browse-agent discussion thread. Mirrors
/// `ThreadMessage`, but scoped to a per-tab `browse_id` (a stable UUID the
/// frontend persists alongside its tab list) rather than a plan
/// session/comment — the browse agent is a standalone `claude` session, not a
/// fork of a plan. Rows are terminal (`complete` | `error`); live streaming
/// text is frontend-only state. The agent's own resumable session id lives in
/// the `browse_threads` table, not here.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseMessage {
    pub id: String,
    pub browse_id: String,
    /// "user" | "assistant".
    pub role: String,
    pub body: String,
    /// "complete" | "error".
    pub status: String,
    pub created_at: i64,
}

/// A browser tab's **working list** — the punch list built while clicking
/// around a running dev server, then handed to Claude Code or the Drafter in
/// one piece. Keyed on the same durable per-tab `browse_id` as `BrowseMessage`,
/// so the list reattaches to its tab the way the conversation does.
///
/// `template` is a frontend id, deliberately opaque here: which sections a
/// template shows is data (src/lib/browseList.ts), and adding one must not
/// touch Rust.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseList {
    pub browse_id: String,
    pub template: String,
    pub title: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One line of a `BrowseList`. `kind` is the template's own vocabulary
/// ("bug" | "fix" | "improvement" | "note"); `sort_idx` is the user's order,
/// rewritten wholesale on a drag rather than nudged.
///
/// `page_url` / `page_title` are the page the item was written ON — a list
/// built during a walkthrough crosses many screens, and the list row's single
/// title records only where the list was STARTED. `locator` is the pointer to
/// the component the note is about ("Search bar"), resolved from the element
/// the user highlighted. All three are optional: an item typed with nothing
/// selected, on a page whose URL we could not read, is still a valid item.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseListItem {
    pub id: String,
    pub browse_id: String,
    pub kind: String,
    pub body: String,
    pub done: bool,
    pub sort_idx: i64,
    pub page_url: Option<String>,
    pub page_title: Option<String>,
    pub locator: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A whole list in one payload — the list row plus its items, so the panel
/// renders from a single command rather than a two-call waterfall.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseListView {
    pub list: BrowseList,
    pub items: Vec<BrowseListItem>,
}

/// One visible line of a voice/discussion panel transcript. Mirrors
/// `BrowseMessage`, keyed by the voice key (a plan session id, or
/// `drafter:<draft_id>` — the same key `voice.rs` uses everywhere).
///
/// The agent's *memory* already survives everything (the forked claude session
/// id in `voice_sessions`); this is the matching persistence for what the user
/// can SEE. Without it the panel's transcript lived only in component state and
/// was destroyed by an incoming plan, a session switch, or a restart —
/// mid-conversation and unannounced.
///
/// Rows are written from Rust, not the panel, so a reply still lands when the
/// panel is unmounted. `role` mirrors the panel's own three line kinds rather
/// than the wire roles: "you" (the reviewer's turn, stored as its *displayed*
/// label), "agent", and "note" (markers like "▶ Read the plan").
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceMessage {
    pub id: String,
    pub session_key: String,
    /// "you" | "agent" | "note".
    pub role: String,
    pub text: String,
    pub created_at: i64,
}

/// A plan action item the voice agent *offered* but has not written. When the
/// agent proposes a concrete change out loud it stages the offer mid-turn over
/// the bridge; the panel renders a `＋ Add as item` chip under that reply, and
/// only the user's tap turns it into a real `[feedback]` comment.
///
/// Staging rather than writing is the whole point: an offer is not a write, so
/// it needs no "at the user's direction" gate — and the round trip where the
/// user says "add that as feedback" and the agent posts a second turn later
/// disappears.
///
/// `message_id` is the `voice_messages` row of the reply the offer came from,
/// filled in by `bind_comment_offers` once that reply is persisted (the offer's
/// curl necessarily lands *before* its own turn finishes). `None` means "loose"
/// — a valid render state, shown under the streaming bubble or at the tail.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentOffer {
    pub id: String,
    pub session_id: String,
    pub message_id: Option<String>,
    /// An `rl:blk-` id from `GET .../plan`, validated at stage time.
    pub block_id: String,
    /// The feedback directive, in plain words — what the comment would say.
    pub body: String,
    /// A ≤60-char chip line; falls back to a truncated `body` in the UI.
    pub label: Option<String>,
    pub agent_id: String,
    /// `pending | added | dismissed`.
    pub status: String,
    pub created_at: i64,
    /// The plan moved on and this offer's block is gone from the latest
    /// revision — the chip renders disabled. Computed on read, **not** a
    /// column: staleness is a fact about the current plan, not about the row.
    #[serde(default)]
    pub stale: bool,
}

/// One turn in a draft's discussion thread (the Prompt Drafter's 💬 agent).
/// Mirrors `BrowseMessage`, scoped to a `draft_id`. The agent's resumable
/// session id + the last doc hash it saw live in `draft_chat_threads`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftChatMessage {
    pub id: String,
    pub draft_id: String,
    /// "user" | "assistant".
    pub role: String,
    pub body: String,
    /// "complete" | "error".
    pub status: String,
    pub created_at: i64,
}

/// One turn in the Memory surface's Ask thread (Second Brain P4). Mirrors
/// `DraftChatMessage`, keyed by the constant memchat thread id; the agent's
/// resumable session id + the ledger high-water mark it last saw live in
/// `mem_chat_threads`. See memchat.rs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemChatMessage {
    pub id: String,
    pub thread_id: String,
    /// "user" | "assistant".
    pub role: String,
    pub body: String,
    /// "complete" | "error".
    pub status: String,
    pub created_at: i64,
}

/// A Companion session: ONE global discussion that follows the user across
/// every surface of the app (plan reviews, Prompt Drafter, browser, missions,
/// code review). Backed by `companion_sessions`; the resumable claude session
/// id lives on the row, and `last_journal_seq` is the high-water mark of
/// context-journal rows already folded into the conversation ("while you were
/// away"). See companion.rs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Companion {
    pub companion_id: String,
    pub title: String,
    /// "active" | "archived".
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
    /// Per-conversation `--model` override on top of the `companion` seat.
    /// `None` = the seat's own model. A brainstorm and a quick lookup are not
    /// the same workload, and the seat is one setting for both.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Per-conversation `--effort` override. Same contract as `model`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// The user renamed this chat, so the auto-titling pass must leave it be.
    #[serde(default)]
    pub title_is_user_set: bool,
}

/// One persisted turn in a Companion discussion. Each turn is surface-tagged
/// with where the user was when it was sent, so the UI can show "on the plan —
/// My plan" per message (the Companion's analog of linked's tab tags).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionMessage {
    pub id: String,
    pub companion_id: String,
    /// "user" | "assistant".
    pub role: String,
    pub body: String,
    /// "complete" | "error".
    pub status: String,
    pub surface_kind: Option<String>,
    pub surface_id: Option<String>,
    pub surface_label: Option<String>,
    pub created_at: i64,
}

/// A comment anchored to a draft block — the Prompt Drafter's sidecar
/// (selection-anchored discussion threads, like plan comments but leaner:
/// no kinds/resolutions/structural payloads). The thread itself lives in
/// `thread_messages` keyed `(draft_id, comment_id)` (the review-thread
/// precedent); the fork's resumable session id lives here.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftComment {
    pub id: String,
    pub draft_id: String,
    pub block_id: Option<String>,
    pub sel_char_start: Option<i64>,
    pub sel_char_end: Option<i64>,
    pub sel_quoted_text: Option<String>,
    pub body: String,
    pub author: Option<String>,
    pub created_at: i64,
    pub fork_session_id: Option<String>,
}

/// An agent write-suggestion against a draft — a tracked change the drafter
/// renders with accept/reject. Queued in `draft_suggestions` (status `pending`)
/// so a proposal made while the pane is closed is drained on mount.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftSuggestion {
    pub id: String,
    pub draft_id: String,
    /// `append | replace_block | insert_after | delete_block`.
    pub op: String,
    pub block_id: Option<String>,
    /// The block markdown the agent read (staleness guard).
    pub original: Option<String>,
    pub markdown: String,
    pub agent_id: Option<String>,
    /// Optional one-line rationale shown on the card.
    pub body: Option<String>,
    /// `pending | applied | rejected`.
    pub status: String,
    pub created_at: i64,
}

/// A research **Mission**: an orchestrator that sits a tier above the per-tab
/// browse agents, holding a shared goal across the whole browser pane. Backed by
/// the `missions` table; the orchestrator's own resumable `claude` session id
/// lives on the row (`claude_session_id`), so re-opening a mission resumes its
/// conversation. One active mission at a time per pane; archived missions stay
/// resumable. See `src-tauri/src/mission.rs`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mission {
    pub mission_id: String,
    pub title: String,
    pub goal: String,
    /// "active" | "archived".
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One **pin**: a curated finding the user pulled into a mission ("I like this
/// part / their tone here"). Captures the pinned text plus where it came from,
/// so the orchestrator and the findings board can attribute it. `browse_id` ties
/// it back to the source tab's discussion; all source fields are nullable so a
/// free-form note can be pinned too.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionFinding {
    pub id: String,
    pub mission_id: String,
    pub browse_id: Option<String>,
    pub source_url: Option<String>,
    pub source_title: Option<String>,
    pub body: String,
    pub note: Option<String>,
    pub created_at: i64,
}

/// One **thumbs verdict** the user gave on a source the browse agent surfaced in
/// tandem agent mode. Keyed by `(browse_id, source_url)` — re-clicking updates the
/// same row. `verdict` is +1 (up) or -1 (down); `domain` is derived from the url
/// so learning can aggregate preferences by host across tabs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFeedback {
    pub id: String,
    pub browse_id: String,
    pub source_url: String,
    pub source_title: Option<String>,
    pub domain: String,
    pub verdict: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One turn in a mission's orchestrator discussion thread. Mirrors
/// `BrowseMessage`, scoped to a `mission_id`. Rows are terminal
/// (`complete` | `error`); live streaming text is frontend-only state. The
/// orchestrator's resumable session id lives on the `missions` row, not here.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionMessage {
    pub id: String,
    pub mission_id: String,
    /// "user" | "assistant".
    pub role: String,
    pub body: String,
    /// "complete" | "error".
    pub status: String,
    pub created_at: i64,
}

/// A **Linked discussion**: ONE continuous conversation that follows the user
/// across every browser tab. Unlike a page discussion (one tab) or a mission
/// (one fixed goal), it has no goal — it is a spanning conversation. Backed by
/// the `linked_sessions` table; the agent's own resumable `claude` session id
/// lives on the row (`claude_session_id`), so re-opening resumes it. When a
/// tab's context gets heavy the linked agent "checks in with a colleague" — the
/// tab's own browse (`browse_id`) discussion — via `/v1/linked/consult`. See
/// `src-tauri/src/linked.rs`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Linked {
    pub linked_id: String,
    pub title: String,
    /// "active" | "archived".
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One turn in a linked discussion. Mirrors `MissionMessage`, but each turn is
/// **tab-tagged**: the `tab_*` fields snapshot which tab the user was on when
/// they sent (or the assistant answered) the turn, so the UI can show "on tab
/// N — Title" per message. Rows are terminal (`complete` | `error`); live
/// streaming text is frontend-only state. The resumable session id lives on the
/// `linked_sessions` row, not here.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedMessage {
    pub id: String,
    pub linked_id: String,
    /// "user" | "assistant".
    pub role: String,
    pub body: String,
    /// "complete" | "error".
    pub status: String,
    /// Which tab this turn was on (nullable — the first turn may precede any tab
    /// context). `tab_n` is the 1-based tab-strip ordinal at turn time.
    pub tab_browse_id: Option<String>,
    pub tab_n: Option<i64>,
    pub tab_title: Option<String>,
    pub tab_url: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewCommentRequest {
    /// Optional caller-minted id (live collab: a collaborator mints
    /// `c-{client}-{ts}` so one comment has one identity on both sides).
    /// Honored only when unique in the session; foreign-format ids parse as
    /// `None` in `parse_comment_id`, so the owner's `c-NNN` sequence is
    /// unperturbed.
    #[serde(default)]
    pub id: Option<String>,
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
    /// Set only by the agent endpoints; the frontend never sends it.
    #[serde(default)]
    pub author: Option<String>,
    /// Human attribution for imported/collaborator comments (see
    /// `Comment::reviewer`). Sent by the Review Request import path and the
    /// live-collab mirror; absent on every owner-originated comment.
    #[serde(default)]
    pub reviewer: Option<String>,
    /// Provenance for imported Review Request returns (see the matching
    /// fields on `Comment`); absent on every owner-originated comment.
    #[serde(default)]
    pub external_created_at: Option<i64>,
    #[serde(default)]
    pub share_request_id: Option<String>,
    /// Files captured by the composer before Save (see `Comment::attachments`).
    #[serde(default)]
    pub attachments: Vec<CommentAttachment>,
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
    /// Materialized `Revision::sections`, keyed by (session id, version).
    ///
    /// The store's own revisions carry empty `sections`; this is where a
    /// parsed one actually lives. Populated two ways: a revision that arrives
    /// already parsed (`upsert_plan` — the interception path has the sections
    /// in hand and must not throw them away only to re-parse on the next
    /// read), and a first read of a historical revision, which parses once.
    ///
    /// `Arc<Vec<Section>>` so handing the same parse to several readers is a
    /// refcount bump. Evicted when a session is deleted or re-keyed — the only
    /// two ways a (session, version) pair stops meaning what it meant.
    sections: Arc<Mutex<HashMap<(SessionId, u32), Arc<Vec<Section>>>>>,
}

pub struct UpsertResult {
    pub version_number: u32,
    pub is_new_session: bool,
}

impl SessionStore {
    pub fn new(db: Arc<Database>) -> Self {
        Self::try_new(db).expect("session history must load before opening the store")
    }

    /// A database read failure must never look like an empty history. Desktop
    /// startup reports this error before making an empty store available.
    pub fn try_new(db: Arc<Database>) -> rusqlite::Result<Self> {
        let mut map = db.load_all()?;
        // A held POST can never survive a process restart — any session
        // persisted as Held was orphaned when the previous instance died, so
        // it is detached now. Flip in memory and in one sweep on disk.
        let mut any_flipped = false;
        for s in map.values_mut() {
            if s.attach_state == AttachState::Held {
                s.attach_state = AttachState::Detached;
                any_flipped = true;
            }
        }
        if any_flipped {
            if let Err(e) = db.detach_held_sessions() {
                tracing::error!(error = %e, "failed to persist startup held→detached flip");
            }
        }
        Ok(Self {
            inner: Arc::new(Mutex::new(map)),
            db,
            pending_restores: Arc::new(Mutex::new(HashSet::new())),
            sections: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    // ── Lazy sections ────────────────────────────────────────────────────
    //
    // `reparse_sections` is a full markdown parse. Startup used to run one per
    // revision of every session ever reviewed, to build a list of titles and
    // dates — so the cost of opening Redline scaled with how much you had used
    // it. These three methods are the whole replacement: parse on the first
    // read that genuinely needs a block tree, keep it, and never parse for a
    // listing.

    /// Sections for one revision: cached, or parsed now and cached.
    ///
    /// Every read of a block tree goes through here. `raw_plan_markdown` is
    /// the record; this is the one place it becomes a parse.
    fn sections_for(&self, session_id: &str, revision: &Revision) -> Arc<Vec<Section>> {
        let key = (session_id.to_string(), revision.version_number);
        if let Some(hit) = self.sections.lock().unwrap().get(&key) {
            return hit.clone();
        }
        // Parsed OUTSIDE the cache lock: a large plan's parse must not
        // serialize every other session's reads behind it.
        let parsed = Arc::new(reparse_sections(&revision.raw_plan_markdown));
        self.sections.lock().unwrap().insert(key, parsed.clone());
        parsed
    }

    /// Remember sections that arrived already parsed. The interception path
    /// has just parsed the incoming plan to stamp block ids; re-parsing it on
    /// the next read would be pure waste.
    fn seed_sections(&self, session_id: &str, version: u32, sections: Vec<Section>) {
        self.sections
            .lock()
            .unwrap()
            .insert((session_id.to_string(), version), Arc::new(sections));
    }

    /// Drop every cached parse for a session. Called where a (session,
    /// version) pair stops meaning what it meant: deletion, and re-keying.
    fn forget_sections(&self, session_id: &str) {
        self.sections
            .lock()
            .unwrap()
            .retain(|(sid, _), _| sid != session_id);
    }

    /// Fill in a session's sections on the way out of the store. Callers
    /// outside `state.rs` only ever see fully-materialized sessions.
    fn materialize(&self, session: &mut ReviewSession) {
        let id = session.session_id.clone();
        for revision in session.revisions.iter_mut() {
            if revision.sections.is_empty() {
                revision.sections = (*self.sections_for(&id, revision)).clone();
            }
        }
    }

    /// Record an orchestrated run's lifecycle transition, in memory and on
    /// disk (the db setter also journals it). Returns whether the state
    /// actually changed, so callers emit the chip event only on a real
    /// transition.
    pub fn set_run_state(&self, session_id: &str, state: &str) -> bool {
        let changed = match self.db.set_run_state(session_id, state) {
            Ok(c) => c,
            Err(e) => {
                tracing::error!(error = %e, "failed to persist run state");
                false
            }
        };
        if changed {
            let mut map = self.inner.lock().unwrap();
            if let Some(session) = map.get_mut(session_id) {
                session.run_state = Some(state.to_string());
            }
        }
        changed
    }

    /// Return a session's run columns to NULL, in memory and on disk — the
    /// rollback for a handoff that never delivered ("the click was not
    /// evidence of a run"). `set_run_state` takes `&str` and structurally
    /// cannot write NULL; this is the only way back.
    pub fn clear_run_state(&self, session_id: &str) -> bool {
        let changed = match self.db.clear_run_state(session_id) {
            Ok(c) => c,
            Err(e) => {
                tracing::error!(error = %e, "failed to clear run state");
                false
            }
        };
        if changed {
            let mut map = self.inner.lock().unwrap();
            if let Some(session) = map.get_mut(session_id) {
                session.run_state = None;
            }
        }
        changed
    }

    /// Record the session's attach state (held / detached / idle), in memory
    /// and on disk. Callable with just a session id so the detach drop-guard
    /// can persist without cloning a session.
    pub fn set_attach_state(&self, session_id: &str, state: AttachState) {
        let mut map = self.inner.lock().unwrap();
        let Some(session) = map.get_mut(session_id) else {
            return;
        };
        if session.attach_state == state {
            return;
        }
        session.attach_state = state;
        session.updated_at = now_millis();
        if let Err(e) = self.db.set_session_attach_state(session_id, state.as_str()) {
            tracing::error!(error = %e, "failed to persist attach state");
        }
    }

    /// Bump a session's in-memory last-activity timestamp. Used by callers
    /// that persist activity through the `Database` directly (fork threads),
    /// where the DB row is already touched but the store copy would go stale.
    pub fn touch(&self, session_id: &str) {
        let mut map = self.inner.lock().unwrap();
        if let Some(session) = map.get_mut(session_id) {
            session.updated_at = now_millis();
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

    /// The backing database handle. Used by the `/v1/code/*` daemon routes to
    /// enumerate the user's known projects, and (in tests) to exercise
    /// fork-thread persistence against a comment created through the store.
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
                attach_state: AttachState::Idle,
                updated_at: now,
                run_state: None,
                backend: None,
                model: None,
                effort: None,
            };
            if let Err(e) = self.db.upsert_session(&s) {
                tracing::error!(error = %e, "failed to persist session");
            }
            s
        });
        let is_new_session = session.revisions.is_empty();
        let version_number = (session.revisions.len() as u32) + 1;
        // The incoming plan was already parsed (to stamp block ids), so the
        // parse goes straight into the cache rather than being thrown away and
        // redone on the first read. The map's copy carries an empty tree, like
        // every other revision in it.
        self.seed_sections(session_id, version_number, sections);
        let revision = Revision {
            version_number,
            received_at: now,
            raw_plan_markdown: raw_plan,
            sections: Vec::new(),
            comments: Vec::new(),
            thread_start,
            restored,
        };
        if let Err(e) = self.db.insert_revision(session_id, &revision) {
            tracing::error!(error = %e, "failed to persist revision");
        }
        // Polis ledger: record the plan edit (idempotent per session/version/hash).
        if let Err(e) = crate::ledger::record_revision_event(
            &self.db,
            session_id,
            version_number as i64,
            &revision.raw_plan_markdown,
            None, // the human's own supervised plan session
        ) {
            tracing::warn!(error = %e, "failed to record revision ledger event");
        }
        // Companion journal: a plan revision arrived (v{n}).
        let _ = self.db.append_journal(
            "revision",
            Some("plan"),
            Some(session_id),
            None,
            Some(&format!("v{version_number}")),
        );
        session.revisions.push(revision);
        session.updated_at = session.updated_at.max(now);
        if restored {
            self.carry_open_comments_forward(session, session_id, version_number);
        }
        UpsertResult {
            version_number,
            is_new_session,
        }
    }

    /// Re-present the session's latest revision as a new restored revision —
    /// cloning its body and sections from the store rather than from a plan
    /// Claude re-typed. This is the "Restore plan session" path: the daemon
    /// already holds the authoritative plan, so a resumed `claude` only needs to
    /// fire `ExitPlanMode` (the submitted body is ignored). Because the new
    /// revision is a byte-exact clone, every anchor/block id resolves the same
    /// and the open-comment carry-forward is correct by construction. Returns
    /// `None` if the session has no revisions to restore.
    pub fn restore_latest(&self, session_id: &str) -> Option<UpsertResult> {
        let mut map = self.inner.lock().unwrap();
        let session = map.get_mut(session_id)?;
        let latest = session.revisions.last()?;
        let version_number = (session.revisions.len() as u32) + 1;
        // A byte-exact clone of the body means a byte-exact clone of the
        // parse: seed the new version from the old one's cached tree rather
        // than parsing the same markdown a second time.
        let restored_sections = self.sections_for(session_id, latest);
        self.seed_sections(session_id, version_number, (*restored_sections).clone());
        let revision = Revision {
            version_number,
            received_at: now_millis(),
            raw_plan_markdown: latest.raw_plan_markdown.clone(),
            sections: Vec::new(),
            comments: Vec::new(),
            thread_start: false,
            restored: true,
        };
        if let Err(e) = self.db.insert_revision(session_id, &revision) {
            tracing::error!(error = %e, "failed to persist restored revision");
        }
        session.updated_at = session.updated_at.max(revision.received_at);
        session.revisions.push(revision);
        self.carry_open_comments_forward(session, session_id, version_number);
        Some(UpsertResult {
            version_number,
            is_new_session: false,
        })
    }

    /// Carry the reviewer's open work onto the just-pushed (restored) revision
    /// so the comment pane — which shows only the latest revision's comments —
    /// doesn't hide it. A restored revision re-presents the identical body, so
    /// every anchor/block id resolves the same. Settled comments stay put for
    /// the history views; drafts/reopens were already included in submits via
    /// the all-revisions flat-map, this makes them *visible* again.
    fn carry_open_comments_forward(
        &self,
        session: &mut ReviewSession,
        session_id: &str,
        version_number: u32,
    ) {
        let mut carried: Vec<Comment> = Vec::new();
        let last_idx = session.revisions.len() - 1;
        for revision in &mut session.revisions[..last_idx] {
            let mut kept = Vec::with_capacity(revision.comments.len());
            for c in revision.comments.drain(..) {
                if matches!(c.status, CommentStatus::Draft | CommentStatus::Reopened) {
                    carried.push(c);
                } else {
                    kept.push(c);
                }
            }
            revision.comments = kept;
        }
        for c in &carried {
            if let Err(e) = self
                .db
                .set_comment_revision(session_id, &c.id, version_number)
            {
                note_comment_persist_failure(session_id, "carried-forward comment", &e);
            }
        }
        session.revisions[last_idx].comments.extend(carried);
    }

    pub fn list(&self) -> Vec<SessionSummary> {
        // One small keyed read per refresh — the run chip needs a mode string
        // and nothing else from the runs table.
        let run_modes = self.db.run_modes();
        let map = self.inner.lock().unwrap();
        let mut sessions: Vec<SessionSummary> = map
            .values()
            .map(|s| {
                let latest_version = s.revisions.last().map(|r| r.version_number).unwrap_or(0);
                let pending_count = s
                    .revisions
                    .iter()
                    .flat_map(|r| r.comments.iter())
                    .filter(|c| matches!(c.status, CommentStatus::Draft | CommentStatus::Reopened))
                    .count() as u32;
                let awaiting_review = matches!(s.status, SessionStatus::InReview);
                let plan_title = s
                    .revisions
                    .last()
                    .and_then(|r| crate::parser::plan_title_from_markdown(&r.raw_plan_markdown));
                SessionSummary {
                    session_id: s.session_id.clone(),
                    project_name: s.project_name.clone(),
                    project_path: s.project_path.clone(),
                    plan_title,
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
                    held_terminal_id: None,
                    attach_state: s.attach_state,
                    updated_at: s.updated_at,
                    run_state: s.run_state.clone(),
                    run_mode: run_modes.get(s.session_id.as_str()).cloned(),
                    backend: s.backend.clone(),
                    model: s.model.clone(),
                    effort: s.effort.clone(),
                }
            })
            .collect();
        // Most recent activity first; creation time tiebreaks equal stamps.
        sessions.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then(b.created_at.cmp(&a.created_at))
        });
        sessions
    }

    /// Record which harness (and model) produced this session's plan.
    ///
    /// Separate from `upsert_plan` on purpose: provenance arrives on the hook
    /// payload, not from the parser, and threading it through the upsert
    /// signature would touch every caller and every test for a value only the
    /// plan route knows. Sticky by COALESCE at the DB layer, so a later
    /// status-only upsert can't blank it.
    pub fn set_backend(&self, session_id: &str, backend: Option<&str>, model: Option<&str>) {
        let clean = |v: Option<&str>| {
            v.map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_string)
        };
        let (backend, model) = (clean(backend), clean(model));
        if backend.is_none() && model.is_none() {
            return;
        }
        let mut map = self.inner.lock().unwrap();
        let Some(session) = map.get_mut(session_id) else {
            return;
        };
        if backend.is_some() {
            session.backend = backend;
        }
        if model.is_some() {
            session.model = model;
        }
        let snapshot = session.clone();
        drop(map);
        if let Err(e) = self.db.upsert_session(&snapshot) {
            tracing::error!(error = %e, "failed to persist session backend");
        }
    }

    /// The selected effort is launch provenance, not inferable from a model
    /// name or a transcript. Missing values never erase a persisted choice.
    pub fn set_effort(&self, session_id: &str, effort: Option<&str>) {
        let Some(effort) = effort.map(str::trim).filter(|value| !value.is_empty()) else {
            return;
        };
        let mut map = self.inner.lock().unwrap();
        let Some(session) = map.get_mut(session_id) else {
            return;
        };
        session.effort = Some(effort.to_owned());
        let snapshot = session.clone();
        drop(map);
        if let Err(e) = self.db.upsert_session(&snapshot) {
            tracing::error!(error = %e, "failed to persist session effort");
        }
    }

    /// Which harness this session runs on, defaulting to claude-code — every
    /// pre-backend row and every Claude session leaves the column NULL.
    pub fn backend_of(&self, session_id: &str) -> String {
        self.inner
            .lock()
            .unwrap()
            .get(session_id)
            .and_then(|s| s.backend.clone())
            .filter(|b| !b.trim().is_empty())
            .unwrap_or_else(|| "claude-code".to_string())
    }

    /// A session, with its sections materialized.
    ///
    /// THE read path: `get_session`, every agent route, the snapshot builder
    /// and the share exporter all come through here, which is why the lazy
    /// parse is invisible to them — a `ReviewSession` that has left the store
    /// always has its block trees.
    pub fn get(&self, session_id: &str) -> Option<ReviewSession> {
        let mut session = {
            let map = self.inner.lock().unwrap();
            map.get(session_id).cloned()?
        };
        // Materialized OUTSIDE the map lock: a first read of a large history
        // must not block a plan arriving on the daemon.
        self.materialize(&mut session);
        Some(session)
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

        // Explicit ids make delivery idempotent: re-adding an id the session
        // already has returns the existing comment unchanged instead of
        // minting a duplicate (the live-collab mirror can replay an add —
        // e.g. an IndexedDB-restored map entry — and must converge, not
        // multiply). Absent an explicit id, mint the next c-NNN.
        if let Some(id) = request.id.as_deref().filter(|id| !id.is_empty()) {
            if let Some(existing) = session
                .revisions
                .iter()
                .flat_map(|r| r.comments.iter())
                .find(|c| c.id == id)
            {
                return Ok(existing.clone());
            }
        }
        // Agent-authored comments converge on CONTENT, not on an id — the same
        // idempotency contract as above, reached the only way an agent can
        // reach it.
        //
        // `add_feedback_core` -> `add_comment` is a fire-and-forget route: the
        // voice agent and `claude-code` re-POST the same finding when a turn is
        // retried or replayed, and a restored revision hides the originals from
        // the UI without removing them — so the replay looked like new work and
        // minted a second copy of every finding. Session `5f85766f` carries 14
        // such ghosts: byte-identical `author='voice'` rows that inflate every
        // open-comment count downstream of them.
        //
        // Only OPEN comments absorb a replay. A resolved/accepted/withdrawn row
        // is finished business; an agent re-raising the same point afterwards is
        // genuinely a new comment.
        //
        // Human comments are deliberately exempt. A reviewer writing "same
        // problem here" against two different blocks is legitimate, happens in
        // the live record, and must keep minting distinct ids.
        if let Some(author) = request.author.as_deref() {
            let body_key = request.body.trim();
            let edit_matches = |c: &Comment| match (&c.edit, &request.edit) {
                (Some(a), Some(b)) => a.original == b.original && a.revised == b.revised,
                (None, None) => true,
                _ => false,
            };
            if let Some(existing) = session
                .revisions
                .iter()
                .flat_map(|r| r.comments.iter())
                .find(|c| {
                    matches!(
                        c.status,
                        CommentStatus::Draft | CommentStatus::Submitted | CommentStatus::Reopened
                    ) && c.author.as_deref() == Some(author)
                        && c.kind == request.kind
                        && c.body.trim() == body_key
                        && (request.kind != CommentKind::Edit || edit_matches(c))
                })
            {
                return Ok(existing.clone());
            }
        }

        let id = match request.id.as_deref().filter(|id| !id.is_empty()) {
            Some(id) => id.to_string(),
            None => {
                let next_n = session
                    .revisions
                    .iter()
                    .flat_map(|r| r.comments.iter())
                    .filter_map(|c| parse_comment_id(&c.id))
                    .max()
                    .unwrap_or(0)
                    + 1;
                format!("c-{:03}", next_n)
            }
        };

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
            author: request.author,
            agent_state: None,
            reviewer: request.reviewer,
            external_created_at: request.external_created_at,
            share_request_id: request.share_request_id,
            attachments: request.attachments,
        };

        let latest = session
            .revisions
            .last_mut()
            .expect("non-empty checked above");
        if let Err(e) = self
            .db
            .insert_comment(session_id, latest.version_number, &comment)
        {
            note_comment_persist_failure(session_id, "comment", &e);
            return Err(format!("failed to persist comment: {e}"));
        }
        latest.comments.push(comment.clone());
        session.updated_at = session.updated_at.max(comment.created_at);
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
                    note_comment_persist_failure(session_id, "comment update", &e);
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
    /// Rebind a held session onto `new_id` (the live session id a restore
    /// handshake arrived under). No-op returning false if the source is absent,
    /// the ids are equal, or `new_id` already holds a session (never clobber a
    /// live one). The whole in-memory session moves wholesale, so its
    /// revisions / open comments / attach-state ride along unchanged, and the
    /// DB rows follow via `db.rekey_session`.
    pub fn rekey_session(&self, old_id: &str, new_id: &str) -> bool {
        let mut map = self.inner.lock().unwrap();
        if old_id == new_id || map.contains_key(new_id) {
            return false;
        }
        let Some(mut session) = map.remove(old_id) else {
            return false;
        };
        session.session_id = new_id.to_string();
        if let Err(e) = self.db.rekey_session(old_id, new_id) {
            tracing::error!(error = %e, "failed to rekey session in db");
        }
        // Attachment paths embed the session id, so they move with the rows.
        // The directory itself is moved by the caller (it needs the app handle);
        // the two belong together — see `fsbrowse::rekey_session_attachments`.
        if let Err(e) = self.db.rekey_attachment_paths(old_id, new_id) {
            tracing::warn!(error = %e, "failed to rekey attachment paths");
        }
        for rev in &mut session.revisions {
            for c in &mut rev.comments {
                for a in &mut c.attachments {
                    a.path = a.path.replace(
                        &format!("/attachments/{old_id}/"),
                        &format!("/attachments/{new_id}/"),
                    );
                }
            }
        }
        map.insert(new_id.to_string(), session);
        // Cached parses are keyed by (session id, version); the id just
        // changed, so the old keys name a session that no longer exists. The
        // new id simply re-parses on its first read.
        self.forget_sections(old_id);
        true
    }

    pub fn delete_session(&self, session_id: &str) -> bool {
        let mut map = self.inner.lock().unwrap();
        if map.remove(session_id).is_none() {
            return false;
        }
        if let Err(e) = self.db.delete_session(session_id) {
            tracing::error!(error = %e, "failed to delete session from db");
        }
        // A new session could later be created under the same id (Claude Code
        // reuses terminal session ids); a stale parse under that key would
        // then be served for a different plan entirely.
        self.forget_sections(session_id);
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

        let mut matched: HashMap<String, bool> =
            resolutions.keys().map(|k| (k.clone(), false)).collect();

        for revision in session.revisions.iter_mut() {
            for comment in revision.comments.iter_mut() {
                if let Some(body) = resolutions.get(&comment.id) {
                    // Re-resolving a comment that already carried a resolution
                    // closes a round: archive the prior resolution + the note
                    // that drove this round, then consume the note so a fresh
                    // reopen starts clean. Keyed on the prior resolution, not
                    // on `Reopened` — by attach time mark_submitted has already
                    // flipped a reopened comment to Submitted.
                    if let Some(prior) = comment.resolution.take() {
                        comment.reopen_history.push(RoundHistoryEntry {
                            resolution_body: prior.body,
                            reopen_note: comment.reopen_note.take(),
                            version: prior.appeared_in_version,
                        });
                    } else {
                        // First resolution. Any draft-attached discussion rider
                        // was consumed by this round — clear it (the transcript
                        // itself persists in thread_messages).
                        comment.reopen_note = None;
                    }
                    comment.resolution = Some(Resolution {
                        body: body.clone(),
                        appeared_in_version,
                        accepted_at: None,
                    });
                    comment.status = CommentStatus::Resolved;
                    matched.insert(comment.id.clone(), true);
                    if let Err(e) = self.db.update_comment(session_id, comment) {
                        note_comment_persist_failure(session_id, "resolution attach", &e);
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
                if matches!(c.status, CommentStatus::Submitted) && !resolutions.contains_key(&c.id)
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
        // The map's revisions carry EMPTY sections by construction (see
        // `Revision::sections`), so the tree comes from `sections_for` —
        // parse-once, cached. The map lock is released before that call: a
        // first parse of a large plan must not hold up a plan arriving on the
        // daemon.
        let (latest, comments) = {
            let map = self.inner.lock().unwrap();
            let session = map.get(session_id)?;
            let latest = session.revisions.last()?.clone();
            let comments: Vec<Comment> = session
                .revisions
                .iter()
                .flat_map(|r| r.comments.iter())
                .filter(|c| matches!(c.status, CommentStatus::Draft | CommentStatus::Reopened))
                .cloned()
                .collect();
            (latest, comments)
        };
        let sections = self.sections_for(session_id, &latest);
        Some(((*sections).clone(), comments, latest.raw_plan_markdown))
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
                if matches!(comment.status, CommentStatus::Submitted) && ids.contains(&comment.id) {
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
            if session.status == status {
                return;
            }
            session.status = status;
            session.updated_at = now_millis();
            if let Err(e) = self.db.upsert_session(session) {
                tracing::error!(error = %e, "failed to persist session status");
            }
            // Polis ledger: a plan approval is a decision worth recording.
            if session.status == SessionStatus::Approved {
                if let Err(e) = crate::ledger::record_decision(
                    &self.db,
                    crate::ledger::DecisionInput {
                        kind: crate::ledger::EventKind::Approval,
                        author: None,
                        session_id: Some(session_id),
                        ref_kind: "session",
                        ref_id: session_id,
                        payload_hash: crate::ledger::decision_payload_hash(&[
                            ("status", "approved"),
                            ("session", session_id),
                        ]),
                    },
                ) {
                    tracing::warn!(error = %e, "failed to record approval ledger event");
                }
                // Companion journal: the plan was approved.
                let _ =
                    self.db
                        .append_journal("approval", Some("plan"), Some(session_id), None, None);
                // Producers wave: the approved plan's to-dos become durable
                // work items (one per top-level section, parented under the
                // plan itself). Strictly best-effort — filing logs on failure
                // and NEVER blocks or fails the status change.
                self.file_approval_work_items(session);
            }
        }
    }

    /// File the approved plan as durable work items: one `held` umbrella item
    /// for the plan itself plus one `open` child per top-level section (the
    /// house markdown conventions — a section = a top-level heading unit,
    /// already parsed into `Revision::sections`). The umbrella files `held`
    /// (the intake linkage precedent: an organizational node is parked
    /// context, never claimable work) so only the sections enter the ready
    /// frontier; when the plan has no parseable sections the single fallback
    /// item files `open` instead — it IS the work. Never zero items, never a
    /// crash in the approval path.
    ///
    /// Idempotency: the umbrella's title carries the plan version, and the
    /// whole filing is skipped while an unclosed umbrella with that exact
    /// `(origin_kind="session", origin_id=<session id>, title)` triple stands
    /// — approving the SAME version twice files nothing new, while a later
    /// version files its own set. Origin is PROVENANCE, never ownership.
    fn file_approval_work_items(&self, session: &ReviewSession) {
        /// Ledger actor + edge author for approval-filed items. A human act —
        /// no seat's `items_filed` is incremented here.
        const APPROVAL_ACTOR: &str = "plan-approval";
        let sid = session.session_id.as_str();
        // Through `sections_for`: this is called with a `&ReviewSession`
        // borrowed from the store's own map, whose revisions carry empty
        // section trees. Reading `r.sections` directly here would file an
        // approved plan as ONE fallback item instead of one per section.
        let latest = session.revisions.last().cloned();
        let materialized = latest.as_ref().map(|r| self.sections_for(sid, r));
        let (version, plan_md, sections): (u32, Option<&str>, &[Section]) =
            match (latest.as_ref(), materialized.as_deref()) {
                (Some(r), Some(parsed)) => (
                    r.version_number,
                    Some(r.raw_plan_markdown.as_str()),
                    parsed.as_slice(),
                ),
                _ => (0, None, &[]),
            };
        // The house plan shape is a single `#` title over `##` work sections
        // — when the parse yields exactly that, the `##` units are the plan's
        // real to-dos; a plan with several top-level headings files those
        // directly.
        let sections: &[Section] = match sections {
            [only] if !only.children.is_empty() => &only.children,
            other => other,
        };
        let plan_title = plan_md
            .and_then(parser::plan_title_from_markdown)
            .unwrap_or_else(|| session.project_name.clone());
        let parent_title = format!("Plan v{version} approved: {plan_title}");
        // This version's child titles, ordinal-prefixed exactly as they file
        // below (the dedupe triple keys on the title).
        let child_titles: Vec<String> = sections
            .iter()
            .enumerate()
            .map(|(i, s)| {
                let core = s.title.trim();
                if core.is_empty() {
                    format!("{}. (untitled section)", i + 1)
                } else {
                    format!("{}. {}", i + 1, core)
                }
            })
            .collect();
        // Skip while this version's filing stands in ANY form: the unclosed
        // umbrella, or any unclosed child of this version. The umbrella may
        // close first (children still open) — re-approving then must not
        // mint a second, childless held umbrella over the standing children.
        // A lookup FAULT also skips (with a warn): without the idempotency
        // answer, filing could duplicate.
        for title in std::iter::once(&parent_title).chain(child_titles.iter()) {
            match self
                .db
                .find_unclosed_work_item("session", Some(sid), Some(title))
            {
                Ok(Some(_)) => return, // this version's filing already stands
                Ok(None) => {}
                Err(e) => {
                    tracing::warn!(
                        session_id = %sid, error = %e,
                        "approval idempotency lookup failed; skipping the filing"
                    );
                    return;
                }
            }
        }
        let parent_status = if sections.is_empty() { "open" } else { "held" };
        let parent_body = if sections.is_empty() {
            // Unparseable / section-less plan: ONE item carries the whole
            // (sidecar-stripped) plan body — never zero.
            plan_md.map(parser::strip_sidecar_lines)
        } else {
            Some(format!(
                "Approved plan session {sid} (v{version}). The plan's \
                 top-level sections are filed as child items; this umbrella \
                 stays held so only the sections enter the ready frontier."
            ))
        };
        let parent_id = match self.db.file_produced_work_item(
            &parent_title,
            parent_body.as_deref(),
            "task",
            parent_status,
            2,
            "session",
            Some(sid),
            Some(&session.project_path),
            None,
            APPROVAL_ACTOR,
        ) {
            Ok(Some(id)) => id,
            Ok(None) => return, // an identical filing raced us in
            Err(e) => {
                tracing::warn!(
                    session_id = %sid, error = %e,
                    "failed to file the approved-plan work item"
                );
                return;
            }
        };
        for (s, title) in sections.iter().zip(child_titles.iter()) {
            // The ordinal prefix (already baked into `child_titles`) keeps
            // duplicate section titles distinct (the dedupe triple keys on
            // the title) and orders the frontier the way the plan reads.
            let body = parser::strip_sidecar_lines(&s.body_markdown);
            let body = (!body.trim().is_empty()).then_some(body);
            if let Err(e) = self.db.file_produced_work_item(
                title,
                body.as_deref(),
                "task",
                "open",
                2,
                "session",
                Some(sid),
                Some(&session.project_path),
                Some(&parent_id),
                APPROVAL_ACTOR,
            ) {
                tracing::warn!(
                    session_id = %sid, error = %e,
                    "failed to file a plan-section work item"
                );
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
                        note_comment_persist_failure(session_id, "accept", &e);
                    }
                    // Polis ledger: accepting a resolution is a decision.
                    let ph = crate::ledger::decision_payload_hash(&[
                        ("comment", comment_id),
                        ("accepted_at", &now.to_string()),
                        (
                            "body",
                            comment
                                .resolution
                                .as_ref()
                                .map(|r| r.body.as_str())
                                .unwrap_or(""),
                        ),
                    ]);
                    if let Err(e) = crate::ledger::record_decision(
                        &self.db,
                        crate::ledger::DecisionInput {
                            kind: crate::ledger::EventKind::Resolution,
                            author: None,
                            session_id: Some(session_id),
                            ref_kind: "comment",
                            ref_id: comment_id,
                            payload_hash: ph,
                        },
                    ) {
                        tracing::warn!(error = %e, "failed to record resolution ledger event");
                    }
                    return true;
                }
            }
        }
        false
    }

    /// Record the in-place resolution of an agent suggestion (M4): the comment
    /// stays Draft — it must keep owning its block in the editor and ride the
    /// submit payload as a normal [edit] — only `agent_state` changes (e.g.
    /// `Some("accepted")`). Returns false when the comment doesn't exist or
    /// isn't agent-authored.
    pub fn set_agent_state(
        &self,
        session_id: &str,
        comment_id: &str,
        state: Option<String>,
    ) -> bool {
        let mut map = self.inner.lock().unwrap();
        let Some(session) = map.get_mut(session_id) else {
            return false;
        };
        for revision in session.revisions.iter_mut() {
            for comment in revision.comments.iter_mut() {
                if comment.id == comment_id && comment.author.is_some() {
                    comment.agent_state = state;
                    if let Err(e) = self.db.update_comment(session_id, comment) {
                        note_comment_persist_failure(session_id, "agent state", &e);
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
                        note_comment_persist_failure(session_id, "reopen", &e);
                    }
                    // Polis ledger: reopening a resolution (optionally as a
                    // directive) is a decision, with its note in the hash.
                    let ph = crate::ledger::decision_payload_hash(&[
                        ("comment", comment_id),
                        ("note", note.unwrap_or("")),
                        ("as_change", if as_change { "1" } else { "0" }),
                    ]);
                    if let Err(e) = crate::ledger::record_decision(
                        &self.db,
                        crate::ledger::DecisionInput {
                            kind: crate::ledger::EventKind::Reopen,
                            author: None,
                            session_id: Some(session_id),
                            ref_kind: "comment",
                            ref_id: comment_id,
                            payload_hash: ph,
                        },
                    ) {
                        tracing::warn!(error = %e, "failed to record reopen ledger event");
                    }
                    return true;
                }
            }
        }
        false
    }

    /// Attach the outcome of a Discuss-with-Claude thread to its comment so it
    /// rides into the next submit. This is the status-aware front door for the
    /// thread's "Add to plan" / "Attach to next submit" affordance:
    ///
    /// - `Draft`: the rider (`reopen_note`) is set in place — no status change.
    ///   The next submit bundles it as discussion context; `as_change` promotes
    ///   a question to a `[decision]` driver. A blank `note` detaches the rider
    ///   (and demotes a not-yet-submitted promoted question).
    /// - `Resolved | Accepted | Reopened`: identical to `reopen_resolution` —
    ///   the discussion outcome is a follow-up on an existing resolution.
    /// - `Submitted`: rejected — the batch is in flight; escalate after Claude
    ///   responds. `Withdrawn`: rejected.
    pub fn attach_discussion(
        &self,
        session_id: &str,
        comment_id: &str,
        note: Option<&str>,
        as_change: bool,
    ) -> Result<(), String> {
        let status = {
            let map = self.inner.lock().unwrap();
            let session = map
                .get(session_id)
                .ok_or_else(|| format!("session not found: {session_id}"))?;
            session
                .revisions
                .iter()
                .flat_map(|r| r.comments.iter())
                .find(|c| c.id == comment_id)
                .map(|c| c.status)
                .ok_or_else(|| format!("comment not found: {comment_id}"))?
        };
        match status {
            CommentStatus::Draft => {
                let note = note.map(str::trim).filter(|s| !s.is_empty());
                let mut map = self.inner.lock().unwrap();
                let session = map
                    .get_mut(session_id)
                    .ok_or_else(|| format!("session not found: {session_id}"))?;
                for revision in session.revisions.iter_mut() {
                    for comment in revision.comments.iter_mut() {
                        if comment.id == comment_id {
                            comment.reopen_note = note.map(str::to_string);
                            if matches!(comment.kind, CommentKind::Question) {
                                if as_change {
                                    comment.actionable = true;
                                } else if note.is_none() {
                                    // Detaching the rider un-promotes a draft
                                    // question — without the discussion there
                                    // is no decision to apply.
                                    comment.actionable = false;
                                }
                            }
                            if let Err(e) = self.db.update_comment(session_id, comment) {
                                note_comment_persist_failure(session_id, "discussion attach", &e);
                            }
                            return Ok(());
                        }
                    }
                }
                Err(format!("comment not found: {comment_id}"))
            }
            CommentStatus::Resolved | CommentStatus::Accepted | CommentStatus::Reopened => {
                if self.reopen_resolution(session_id, comment_id, note, as_change) {
                    Ok(())
                } else {
                    Err(format!("comment not found: {comment_id}"))
                }
            }
            CommentStatus::Submitted => {
                Err("comment already sent — wait for Claude's response, then reopen".to_string())
            }
            CommentStatus::Withdrawn => Err("comment was withdrawn".to_string()),
        }
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

/// A comment write that never reached SQLite.
///
/// These were `tracing::error!` and nothing else: a log line in a console
/// nobody has open, for the one failure mode that silently loses a reviewer's
/// own work on the app's flagship surface. Now it also lands a
/// `friction_events` row, so the digests that rank what to fix can actually
/// see it. Deliberately not an `Err` return — the in-memory write already
/// happened and the caller's contract is unchanged; this is instrumentation,
/// not a behavior change.
fn note_comment_persist_failure(session_id: &str, what: &str, e: &impl std::fmt::Display) {
    tracing::error!(error = %e, session_id, what, "failed to persist a comment write");
    crate::db::note_friction(
        "comment_persist_failed",
        Some("plan"),
        Some(session_id),
        Some(&format!("{what}: {e}")),
    );
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
    // The whole point of the lazy-section work is that this stops running per
    // revision at startup, and "it felt faster" is not a test. Counted per
    // thread, not process-wide: the suite runs in parallel and every other
    // fixture parses plans, so a global counter would measure the suite.
    #[cfg(test)]
    SECTION_PARSES.with(|c| c.set(c.get() + 1));
    parser::parse_plan(raw)
}

#[cfg(test)]
thread_local! {
    /// How many full plan parses have happened on this thread.
    pub(crate) static SECTION_PARSES: std::cell::Cell<usize> =
        const { std::cell::Cell::new(0) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_read_error_is_not_an_empty_session_store() {
        let path = std::env::temp_dir().join(format!(
            "redline-history-load-error-{}.db", uuid::Uuid::new_v4()
        ));
        let db = Arc::new(crate::db::Database::open(&path).unwrap());
        seed_history(&db, 1, 2);
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn
            .execute("ALTER TABLE sessions RENAME COLUMN effort TO unavailable_effort", [])
            .unwrap();
        let error = match SessionStore::try_new(db.clone()) {
            Ok(_) => panic!("a failed history query must not produce an empty store"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("effort"));
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM revisions", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
        drop(conn);
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    // ── Lazy sections ────────────────────────────────────────────────────
    //
    // The law: a listing parses nothing, a first detailed read parses once,
    // and what it produces is what eager parsing produced. Startup used to
    // parse every revision of every session in the history — work thrown away
    // for every plan the user never opened, paid in front of the window.

    fn parses() -> usize {
        SECTION_PARSES.with(|c| c.get())
    }
    fn reset_parses() {
        SECTION_PARSES.with(|c| c.set(0));
    }

    /// A store rebuilt from disk, exactly as boot does it — the only way to
    /// observe hydration, since a store you just wrote to has its parses
    /// seeded by the write.
    fn reloaded(db: &Arc<crate::db::Database>) -> SessionStore {
        SessionStore::new(db.clone())
    }

    fn seed_history(db: &Arc<crate::db::Database>, sessions: usize, revisions: u32) {
        let store = SessionStore::new(db.clone());
        for i in 0..sessions {
            let sid = format!("hist-{i}");
            for v in 1..=revisions {
                let md = format!("# Plan {i} v{v}\n\n## Alpha\n\nBody.\n\n## Beta\n\nMore.\n");
                store.upsert_plan(
                    &sid,
                    "/tmp/hist",
                    md.clone(),
                    reparse_sections(&md),
                    v == 1,
                    false,
                );
            }
        }
    }

    #[test]
    fn hydrating_and_listing_sessions_parses_nothing() {
        let db = Arc::new(crate::db::Database::open_in_memory().unwrap());
        seed_history(&db, 12, 3);

        reset_parses();
        let store = reloaded(&db);
        assert_eq!(
            parses(),
            0,
            "startup parsed the history — 36 revisions, none of them opened"
        );

        let summaries = store.list();
        assert_eq!(summaries.len(), 12);
        // Titles come from the raw markdown, never from a parse.
        assert!(summaries.iter().all(|s| s.plan_title.is_some()));
        assert_eq!(parses(), 0, "listing sessions parsed a plan");
    }

    #[test]
    fn the_first_detailed_access_parses_exactly_once() {
        let db = Arc::new(crate::db::Database::open_in_memory().unwrap());
        seed_history(&db, 3, 2);
        let store = reloaded(&db);

        reset_parses();
        let first = store.get("hist-1").expect("session");
        assert_eq!(
            parses(),
            2,
            "one parse per revision of the session actually opened, and no others"
        );
        assert!(
            !first.revisions[0].sections.is_empty(),
            "sections must be materialized on the way out"
        );

        let again = store.get("hist-1").expect("session");
        assert_eq!(parses(), 2, "the second read re-parsed");
        assert_eq!(
            format!("{:?}", first.revisions[1].sections),
            format!("{:?}", again.revisions[1].sections),
            "the cached tree must be the same tree"
        );

        // A different session is a different key: it parses, the first does not.
        store.get("hist-2").expect("session");
        assert_eq!(parses(), 4);
    }

    #[test]
    fn on_demand_parsing_is_identical_to_eager_parsing() {
        // The body that is actually PERSISTED carries `rl:blk-` sidecars —
        // `parse_plan_with_sidecars` stamps them, and `upsert_plan` stores the
        // augmented text. That is what makes a later parse reproduce the same
        // block ids, which is what the whole lazy scheme rests on: a block id
        // is an anchor for comments, and a plan whose ids moved on reload
        // would orphan every one of them.
        let source = "# Title\n\nIntro.\n\n## One\n\n- a\n- b\n\n### Deep\n\n```rust\nfn x() {}\n```\n\n## Two\n\nEnd.\n";
        let (eager, augmented) = crate::parser::parse_plan_with_sidecars(source);

        let db = Arc::new(crate::db::Database::open_in_memory().unwrap());
        {
            let store = SessionStore::new(db.clone());
            store.upsert_plan("s", "/tmp/s", augmented, eager.clone(), true, false);
        }
        let lazy = reloaded(&db)
            .get("s")
            .expect("session")
            .revisions
            .pop()
            .expect("revision")
            .sections;
        assert_eq!(
            format!("{eager:?}"),
            format!("{lazy:?}"),
            "a lazily-parsed revision must be byte-identical to the eager parse, \
             block ids included"
        );
    }

    #[test]
    fn block_ids_are_stable_across_repeated_lazy_reads() {
        // Even for a body with NO sidecars (a hand-inserted row, a legacy
        // revision), the cache has to make ids stable: `parse_plan` mints
        // fresh ones when it finds no markers, so an uncached re-parse would
        // hand two readers two different sets of anchors for the same plan.
        let db = Arc::new(crate::db::Database::open_in_memory().unwrap());
        let md = "# Bare\n\n## Alpha\n\nNo sidecars here.\n";
        {
            let store = SessionStore::new(db.clone());
            store.upsert_plan(
                "bare",
                "/tmp/b",
                md.to_string(),
                reparse_sections(md),
                true,
                false,
            );
        }
        let store = reloaded(&db);
        let first = store.get("bare").expect("session").revisions.pop().unwrap();
        let second = store.get("bare").expect("session").revisions.pop().unwrap();
        assert_eq!(
            first.sections[0].block_id, second.sections[0].block_id,
            "two reads of the same revision produced different block ids"
        );
    }

    #[test]
    fn an_intercepted_revision_is_never_reparsed() {
        // The interception path already parsed the plan to stamp block ids.
        // Throwing that away and re-parsing on the first read would be pure
        // waste, and it is the obvious way to get this wrong.
        let db = Arc::new(crate::db::Database::open_in_memory().unwrap());
        let store = SessionStore::new(db);
        let md = "# Fresh\n\n## A\n\nBody.\n";
        let sections = reparse_sections(md);

        reset_parses();
        store.upsert_plan("s", "/tmp/s", md.to_string(), sections, true, false);
        let session = store.get("s").expect("session");
        assert_eq!(parses(), 0, "the incoming parse was thrown away and redone");
        assert!(!session.revisions[0].sections.is_empty());
    }

    #[test]
    fn a_restore_reuses_the_parse_of_the_body_it_clones() {
        let db = Arc::new(crate::db::Database::open_in_memory().unwrap());
        seed_history(&db, 1, 1);
        let store = reloaded(&db);
        store.get("hist-0").expect("session"); // materialize v1

        reset_parses();
        store.restore_latest("hist-0").expect("restored");
        let session = store.get("hist-0").expect("session");
        assert_eq!(
            parses(),
            0,
            "a byte-exact clone of the body re-parsed the same markdown"
        );
        assert_eq!(session.revisions.len(), 2);
        assert_eq!(
            format!("{:?}", session.revisions[0].sections),
            format!("{:?}", session.revisions[1].sections),
        );
    }

    #[test]
    fn deleting_a_session_forgets_its_parses() {
        // Claude Code reuses terminal session ids, so a later session can
        // arrive under a deleted one's id. Serving the old plan's block tree
        // for it would be a silent, very confusing wrong answer.
        let db = Arc::new(crate::db::Database::open_in_memory().unwrap());
        let store = SessionStore::new(db);
        let first = "# First\n\n## Alpha\n\nOne.\n";
        store.upsert_plan(
            "reused",
            "/tmp/r",
            first.to_string(),
            reparse_sections(first),
            true,
            false,
        );
        assert!(store.delete_session("reused"));

        let second = "# Second\n\n## Beta\n\nTwo.\n";
        store.upsert_plan(
            "reused",
            "/tmp/r",
            second.to_string(),
            reparse_sections(second),
            true,
            false,
        );
        let session = store.get("reused").expect("session");
        let rendered = format!("{:?}", session.revisions[0].sections);
        assert!(rendered.contains("Beta"), "stale parse served: {rendered}");
        assert!(!rendered.contains("Alpha"));
    }

    #[test]
    fn rekeying_a_session_forgets_its_parses() {
        let db = Arc::new(crate::db::Database::open_in_memory().unwrap());
        let store = SessionStore::new(db);
        let md = "# Plan\n\n## Gamma\n\nBody.\n";
        store.upsert_plan(
            "old-id",
            "/tmp/r",
            md.to_string(),
            reparse_sections(md),
            true,
            false,
        );
        store.get("old-id").expect("materialize");
        assert!(store.rekey_session("old-id", "new-id"));

        let moved = store.get("new-id").expect("session under the new id");
        assert!(format!("{:?}", moved.revisions[0].sections).contains("Gamma"));
    }

    #[test]
    fn attach_state_round_trips_through_str() {
        for state in [AttachState::Idle, AttachState::Held, AttachState::Detached] {
            assert_eq!(AttachState::from_str(state.as_str()), Some(state));
        }
        assert_eq!(AttachState::from_str("bogus"), None);
    }

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
            author: None,
            agent_state: None,
            reviewer: None,
            external_created_at: None,
            share_request_id: None,
            attachments: Vec::new(),
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

    // --- the approval producer: sections become durable work items ----------

    fn store_with_plan(md: &str) -> SessionStore {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let store = SessionStore::new(db);
        store.upsert_plan(
            "sess-appr",
            "/tmp/proj",
            md.to_string(),
            parser::parse_plan(md),
            true,
            false,
        );
        store
    }

    const PLAN_MD: &str = "# Ship the widget\n\n\
        Intro line.\n\n\
        ## Build the frobnicator\n\nDo the build.\n\n\
        ## Test it\n\nRun the suite.\n";

    #[test]
    fn approval_files_one_open_item_per_top_level_section_under_a_held_umbrella() {
        let store = store_with_plan(PLAN_MD);
        let db = store.database();
        store.set_status("sess-appr", SessionStatus::Approved);

        // The umbrella: version-keyed title, held, session provenance.
        let parent = db
            .find_unclosed_work_item("session", Some("sess-appr"), None)
            .unwrap()
            .expect("the approval filed items");
        // House shape: one `#` title over `##` sections — the `##` units are
        // the to-dos, so ONE root umbrella files with a child per `##`.
        let all = db.list_work_items(None, None, 50).unwrap();
        let roots: Vec<_> = all.iter().filter(|i| !i.id.contains('.')).collect();
        assert_eq!(roots.len(), 1);
        let umbrella = roots[0];
        assert!(
            umbrella.title.starts_with("Plan v1 approved:"),
            "{}",
            umbrella.title
        );
        assert!(umbrella.title.contains("Ship the widget"));
        assert_eq!(umbrella.status, "held");
        assert_eq!(umbrella.kind, "task");
        assert_eq!(umbrella.origin_kind.as_deref(), Some("session"));
        assert_eq!(umbrella.origin_id.as_deref(), Some("sess-appr"));
        assert_eq!(umbrella.project_path.as_deref(), Some("/tmp/proj"));
        assert_eq!(parent.origin_id, umbrella.origin_id);

        // One open child per `##` unit, ordinal-prefixed, edged.
        let mut children: Vec<_> = all.iter().filter(|i| i.id.contains('.')).collect();
        children.sort_by(|a, b| a.title.cmp(&b.title));
        assert_eq!(children.len(), 2, "two `##` heading units in this plan");
        assert_eq!(children[0].title, "1. Build the frobnicator");
        assert_eq!(children[1].title, "2. Test it");
        for child in &children {
            assert!(child.id.starts_with(&umbrella.id));
            assert_eq!(child.status, "open");
            assert_eq!(child.origin_kind.as_deref(), Some("session"));
            assert_eq!(child.origin_id.as_deref(), Some("sess-appr"));
            assert_eq!(child.project_path.as_deref(), Some("/tmp/proj"));
            let edges = db.list_work_edges_touching(&child.id).unwrap();
            assert!(edges
                .iter()
                .any(|e| e.edge_type == "parent-child" && e.from_id == umbrella.id));
        }
        assert_eq!(
            children[0].body.as_deref().map(str::trim),
            Some("Do the build."),
            "the section body rides the item"
        );

        // Frontier law: children claimable, the held umbrella not.
        let ready = db.list_ready_work_items(None, now_millis(), 50).unwrap();
        let ids: Vec<&str> = ready.iter().map(|i| i.id.as_str()).collect();
        for child in &children {
            assert!(ids.contains(&child.id.as_str()));
        }
        assert!(!ids.contains(&umbrella.id.as_str()));

        // A human act: no seat's items_filed moves.
        assert!(db.list_seat_stats().unwrap().is_empty());
        // And the chain stays verifiable after the filing.
        assert!(db.verify_ledger_chain().unwrap().ok, "chain intact");
    }

    #[test]
    fn approving_the_same_version_twice_files_nothing_new() {
        let store = store_with_plan(PLAN_MD);
        let db = store.database();
        store.set_status("sess-appr", SessionStatus::Approved);
        let count = db.list_work_items(None, None, 100).unwrap().len();
        assert!(count >= 1);
        // Approved → InReview → Approved again (a restore-shaped round trip):
        // the same version's filing already stands, so nothing duplicates.
        store.set_status("sess-appr", SessionStatus::InReview);
        store.set_status("sess-appr", SessionStatus::Approved);
        assert_eq!(db.list_work_items(None, None, 100).unwrap().len(), count);
    }

    #[test]
    fn reapproval_after_umbrella_close_mints_no_childless_second_umbrella() {
        let store = store_with_plan(PLAN_MD);
        let db = store.database();
        store.set_status("sess-appr", SessionStatus::Approved);
        let all = db.list_work_items(None, None, 100).unwrap();
        let umbrella = all
            .iter()
            .find(|i| !i.id.contains('.'))
            .expect("the umbrella filed")
            .clone();
        let count = all.len();
        // The umbrella closes while its children stand open…
        assert!(db
            .close_work_item(&umbrella.id, Some("done"), now_millis())
            .unwrap());
        // …and the SAME version is re-approved (a restore-shaped round trip).
        store.set_status("sess-appr", SessionStatus::InReview);
        store.set_status("sess-appr", SessionStatus::Approved);
        // No second umbrella: the standing open children ARE this version's
        // filing — refiling would mint a held umbrella with zero children
        // (every child dedupes away against the open originals).
        let after = db.list_work_items(None, None, 100).unwrap();
        assert_eq!(after.len(), count, "nothing refiled");
        assert!(
            after.iter().all(|i| i.status != "held"),
            "no childless held umbrella stands: {:?}",
            after
                .iter()
                .filter(|i| i.status == "held")
                .map(|i| &i.title)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn a_sectionless_plan_falls_back_to_one_open_item_and_approval_survives() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let store = SessionStore::new(db.clone());
        // No headings at all — `sections` parses empty (the fallback path).
        store.upsert_plan(
            "sess-flat",
            "/tmp/proj",
            "just prose, no headings".to_string(),
            Vec::new(),
            true,
            false,
        );
        store.set_status("sess-flat", SessionStatus::Approved);
        // The status change went through regardless.
        assert_eq!(
            store.get("sess-flat").unwrap().status,
            SessionStatus::Approved
        );
        // ONE item — never zero — and it is OPEN (it IS the work).
        let all = db.list_work_items(None, None, 50).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].status, "open");
        assert!(all[0].title.starts_with("Plan v1 approved:"));
        assert_eq!(all[0].origin_kind.as_deref(), Some("session"));
        assert_eq!(all[0].origin_id.as_deref(), Some("sess-flat"));
        assert_eq!(
            all[0].body.as_deref(),
            Some("just prose, no headings"),
            "the whole plan body rides the fallback item"
        );
    }

    #[test]
    fn a_later_version_files_its_own_set() {
        let store = store_with_plan(PLAN_MD);
        let db = store.database();
        store.set_status("sess-appr", SessionStatus::Approved);
        let v1_count = db.list_work_items(None, None, 100).unwrap().len();
        // A revision arrives (v2, new content) and is approved in turn.
        store.set_status("sess-appr", SessionStatus::InReview);
        let v2 = "# Ship the widget v2\n\n## Brand new work\n\nDo it.\n";
        store.upsert_plan(
            "sess-appr",
            "/tmp/proj",
            v2.to_string(),
            parser::parse_plan(v2),
            false,
            false,
        );
        store.set_status("sess-appr", SessionStatus::Approved);
        let all = db.list_work_items(None, None, 100).unwrap();
        assert!(all.len() > v1_count, "the new version filed its own items");
        assert!(all.iter().any(|i| i.title.starts_with("Plan v2 approved:")));
    }
}
