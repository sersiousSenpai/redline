//! Agent-in-doc (M4): a user's Claude Code posts a tracked suggestion into
//! the live review, anchored by block id — never by position.
//!
//! Two operations, exposed both as HTTP routes on the :7676 daemon (the
//! agent's surface, documented in skills/redline/SKILL.md) and as Tauri
//! commands (lib.rs wraps the same cores):
//!
//!  - `get_latest_plan_core` — the published plan plus a flat block index
//!    (block id, anchor, markdown, whether an open comment already owns it)
//!    so the agent can anchor suggestions against real ids.
//!  - `suggest_edit_core` — lands the suggestion as a **draft [edit] comment
//!    carrying `author`**; the editor materializes it as M3 pending marks
//!    with the agent's authorId. From there the existing machinery owns it:
//!    accept resolves it in place, delete rejects it, submit ships it to
//!    Claude as a normal [edit].
//!
//! Invariant the Conflict checks protect: **one block ⇒ at most one open
//! suggestion** — exactly what `byBlock` dedupe, the pristine-block
//! materialize gate, and block-scoped rejection assume on the editor side.
//!
//! Known v1 limitation: the store only sees the published revision plus
//! draft comments the editor has flushed (debounced ~800ms); keystrokes
//! inside that window are invisible to the staleness/conflict guards.

use serde::{Deserialize, Serialize};

use crate::state::{
    Comment, CommentKind, CommentScope, CommentStatus, EditPayload, NewCommentRequest,
    ReviewSession, Section, SessionStore,
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestEditRequest {
    pub block_id: String,
    /// v1 accepts only "edit" — reserved for structural kinds later.
    pub kind: String,
    /// The block markdown the agent based its rewrite on. Optional but
    /// strongly recommended: a mismatch with the stored block is rejected as
    /// stale instead of silently proposing against content the agent never
    /// read.
    #[serde(default)]
    pub original: Option<String>,
    pub revised: String,
    pub agent_id: String,
    /// Optional rationale; rides the comment body (rendered as NOTE: in the
    /// feedback payload). Defaults to the editor's "(edit)" placeholder.
    #[serde(default)]
    pub body: Option<String>,
}

/// A directive feedback comment posted by an agent (e.g. the voice agent when
/// the reviewer asks to capture a change out loud). Unlike an edit suggestion it
/// carries no verbatim rewrite — it lands as a `[feedback]` driver anchored to a
/// block, exactly like a reviewer's own feedback comment, and rides the next
/// Revise round. Vague feedback should anchor to a heading block (section-level).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestFeedbackRequest {
    /// An `rl:blk-` id from `GET .../plan` — a heading block for section-level feedback.
    pub block_id: String,
    /// The feedback directive, verbatim.
    pub body: String,
    pub agent_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockInfo {
    pub block_id: String,
    pub anchor_id: String,
    /// "heading" | "paragraph".
    pub kind: &'static str,
    /// Verbatim block markdown — what `original` must match.
    pub markdown: String,
    /// An open (draft/reopened) comment already owns this block; a suggestion
    /// against it would 409.
    pub open_comment: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestPlanResponse {
    pub session_id: String,
    pub version_number: u32,
    /// Published plan markdown, including `<!-- rl:blk- -->` sidecars.
    pub raw_plan_markdown: String,
    pub blocks: Vec<BlockInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentError {
    NotFound(String),
    Conflict(String),
    BadRequest(String),
}

impl AgentError {
    pub fn message(&self) -> &str {
        match self {
            AgentError::NotFound(m) | AgentError::Conflict(m) | AgentError::BadRequest(m) => m,
        }
    }
}

/// Document-order flat walk of the section tree: each section's heading,
/// then its body paragraphs, then its children — mirroring the order the
/// blocks appear in the plan markdown.
fn flatten_blocks(sections: &[Section], out: &mut Vec<(String, String, &'static str, String)>) {
    for s in sections {
        out.push((
            s.block_id.clone(),
            s.anchor_id.clone(),
            "heading",
            format!("{} {}", "#".repeat(s.level as usize), s.title),
        ));
        for p in &s.paragraphs {
            out.push((
                p.block_id.clone(),
                p.anchor_id.clone(),
                "paragraph",
                p.markdown.clone(),
            ));
        }
        flatten_blocks(&s.children, out);
    }
}

/// Block ids owned by an open (draft/reopened) comment anywhere in the
/// session — the editor-side `byBlock`/owned-set notion, server-side.
fn open_comment_blocks(session: &ReviewSession) -> Vec<String> {
    session
        .revisions
        .iter()
        .flat_map(|r| r.comments.iter())
        .filter(|c| matches!(c.status, CommentStatus::Draft | CommentStatus::Reopened))
        .filter_map(|c| c.block_id.clone())
        .collect()
}

pub fn get_latest_plan_core(
    store: &SessionStore,
    session_id: &str,
) -> Result<LatestPlanResponse, AgentError> {
    let session = store
        .get(session_id)
        .ok_or_else(|| AgentError::NotFound(format!("no session found for id {session_id}")))?;
    let latest = session
        .revisions
        .last()
        .ok_or_else(|| AgentError::NotFound(format!("session {session_id} has no revisions")))?;

    let open = open_comment_blocks(&session);
    let mut flat = Vec::new();
    flatten_blocks(&latest.sections, &mut flat);
    let blocks = flat
        .into_iter()
        .map(|(block_id, anchor_id, kind, markdown)| BlockInfo {
            open_comment: open.contains(&block_id),
            block_id,
            anchor_id,
            kind,
            markdown,
        })
        .collect();

    Ok(LatestPlanResponse {
        session_id: session_id.to_string(),
        version_number: latest.version_number,
        raw_plan_markdown: latest.raw_plan_markdown.clone(),
        blocks,
    })
}

pub fn suggest_edit_core(
    store: &SessionStore,
    session_id: &str,
    req: SuggestEditRequest,
) -> Result<Comment, AgentError> {
    if req.kind != "edit" {
        return Err(AgentError::BadRequest(format!(
            "unsupported suggestion kind \"{}\" — v1 supports only \"edit\"",
            req.kind
        )));
    }
    if req.agent_id.trim().is_empty() {
        return Err(AgentError::BadRequest("agentId must not be empty".into()));
    }

    let session = store
        .get(session_id)
        .ok_or_else(|| AgentError::NotFound(format!("no session found for id {session_id}")))?;
    let latest = session
        .revisions
        .last()
        .ok_or_else(|| AgentError::NotFound(format!("session {session_id} has no revisions")))?;

    let mut flat = Vec::new();
    flatten_blocks(&latest.sections, &mut flat);
    let (anchor_id, stored_markdown) = flat
        .iter()
        .find(|(block_id, ..)| *block_id == req.block_id)
        .map(|(_, anchor, _, markdown)| (anchor.clone(), markdown.clone()))
        .ok_or_else(|| {
            AgentError::NotFound(format!(
                "no block {} in the latest revision — re-read the plan",
                req.block_id
            ))
        })?;

    if let Some(original) = &req.original {
        if *original != stored_markdown {
            return Err(AgentError::Conflict(format!(
                "stale suggestion: block {} no longer reads as the provided original — re-read the plan",
                req.block_id
            )));
        }
    }
    if req.revised == stored_markdown {
        return Err(AgentError::BadRequest(
            "revised matches the current block — nothing to propose".into(),
        ));
    }
    if open_comment_blocks(&session).contains(&req.block_id) {
        return Err(AgentError::Conflict(format!(
            "block {} already has an open comment — it must be resolved first",
            req.block_id
        )));
    }

    store
        .add_comment(
            session_id,
            NewCommentRequest {
                kind: CommentKind::Edit,
                scope: None,
                anchor_id,
                block_id: Some(req.block_id),
                body: req.body.unwrap_or_else(|| "(edit)".to_string()),
                // `original` is normalized to the stored block markdown: the
                // editor diffs seed-vs-revised, and the user flush echoes
                // seed-vs-accept-all — a verbatim agent `original` that
                // drifted would make the first flush rewrite this comment.
                edit: Some(EditPayload {
                    original: stored_markdown,
                    revised: req.revised,
                }),
                structural: None,
                selection: None,
                author: Some(req.agent_id),
            },
        )
        .map_err(AgentError::BadRequest)
}

/// Land a directive `[feedback]` comment on a block, anchored by id. Mirrors a
/// reviewer's own feedback comment (kind `Feedback`, local scope, carries
/// `author`) and rides Revise by `anchor_id`. Deliberately has **no**
/// staleness/no-op/exclusivity guards: feedback is conversational and coexists
/// with other comments on the same anchor (the one-open-per-block lock is an
/// edit-suggestion invariant only — see `suggest_edit_core`).
pub fn add_feedback_core(
    store: &SessionStore,
    session_id: &str,
    req: SuggestFeedbackRequest,
) -> Result<Comment, AgentError> {
    if req.agent_id.trim().is_empty() {
        return Err(AgentError::BadRequest("agentId must not be empty".into()));
    }
    if req.body.trim().is_empty() {
        return Err(AgentError::BadRequest(
            "feedback body must not be empty".into(),
        ));
    }

    let session = store
        .get(session_id)
        .ok_or_else(|| AgentError::NotFound(format!("no session found for id {session_id}")))?;
    let latest = session
        .revisions
        .last()
        .ok_or_else(|| AgentError::NotFound(format!("session {session_id} has no revisions")))?;

    let mut flat = Vec::new();
    flatten_blocks(&latest.sections, &mut flat);
    let anchor_id = flat
        .iter()
        .find(|(block_id, ..)| *block_id == req.block_id)
        .map(|(_, anchor, _, _)| anchor.clone())
        .ok_or_else(|| {
            AgentError::NotFound(format!(
                "no block {} in the latest revision — re-read the plan",
                req.block_id
            ))
        })?;

    store
        .add_comment(
            session_id,
            NewCommentRequest {
                kind: CommentKind::Feedback,
                scope: Some(CommentScope::Local),
                anchor_id,
                block_id: Some(req.block_id),
                body: req.body.trim().to_string(),
                edit: None,
                structural: None,
                selection: None,
                author: Some(req.agent_id),
            },
        )
        .map_err(AgentError::BadRequest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use crate::parser::parse_plan_with_sidecars;
    use std::sync::Arc;

    const MD: &str = "# Alpha\n\nIntro paragraph.\n\n## Sub\n\nSub body.\n";

    fn make_store() -> SessionStore {
        let store = SessionStore::new(Arc::new(Database::open_in_memory().unwrap()));
        // Mirror handle_plan: sidecars are injected before the plan is stored,
        // so `raw_plan_markdown` carries the block ids the agent anchors by.
        let (sections, with_sidecars) = parse_plan_with_sidecars(MD);
        store.upsert_plan("sess-1", "/tmp/p", with_sidecars, sections, true, false);
        store
    }

    fn paragraph_block(store: &SessionStore) -> BlockInfo {
        get_latest_plan_core(store, "sess-1")
            .unwrap()
            .blocks
            .into_iter()
            .find(|b| b.kind == "paragraph")
            .expect("plan has a paragraph block")
    }

    fn suggest(block: &BlockInfo, original: Option<&str>) -> SuggestEditRequest {
        SuggestEditRequest {
            block_id: block.block_id.clone(),
            kind: "edit".to_string(),
            original: original.map(str::to_string),
            revised: "Rewritten paragraph.".to_string(),
            agent_id: "claude-code".to_string(),
            body: None,
        }
    }

    #[test]
    fn latest_plan_lists_blocks_in_document_order() {
        let store = make_store();
        let plan = get_latest_plan_core(&store, "sess-1").unwrap();
        assert_eq!(plan.version_number, 1);
        assert!(plan.raw_plan_markdown.contains("rl:blk-"));
        let kinds: Vec<&str> = plan.blocks.iter().map(|b| b.kind).collect();
        assert_eq!(kinds, ["heading", "paragraph", "heading", "paragraph"]);
        assert_eq!(plan.blocks[0].markdown, "# Alpha");
        assert_eq!(plan.blocks[1].markdown, "Intro paragraph.");
        assert!(plan.blocks.iter().all(|b| !b.open_comment));
        assert!(plan.blocks.iter().all(|b| !b.block_id.is_empty()));
    }

    #[test]
    fn unknown_session_and_block_are_not_found() {
        let store = make_store();
        assert!(matches!(
            get_latest_plan_core(&store, "nope"),
            Err(AgentError::NotFound(_))
        ));
        let block = paragraph_block(&store);
        let mut req = suggest(&block, None);
        req.block_id = "blk-does-not-exist".to_string();
        assert!(matches!(
            suggest_edit_core(&store, "sess-1", req.clone()),
            Err(AgentError::NotFound(_))
        ));
        assert!(matches!(
            suggest_edit_core(&store, "nope", req),
            Err(AgentError::NotFound(_))
        ));
    }

    #[test]
    fn stale_original_conflicts() {
        let store = make_store();
        let block = paragraph_block(&store);
        let err = suggest_edit_core(&store, "sess-1", suggest(&block, Some("Old text.")));
        assert!(matches!(err, Err(AgentError::Conflict(ref m)) if m.contains("stale")));
    }

    #[test]
    fn bad_kind_and_noop_revision_are_rejected() {
        let store = make_store();
        let block = paragraph_block(&store);
        let mut req = suggest(&block, None);
        req.kind = "block-delete".to_string();
        assert!(matches!(
            suggest_edit_core(&store, "sess-1", req),
            Err(AgentError::BadRequest(_))
        ));
        let mut req = suggest(&block, None);
        req.revised = block.markdown.clone();
        assert!(matches!(
            suggest_edit_core(&store, "sess-1", req),
            Err(AgentError::BadRequest(_))
        ));
    }

    #[test]
    fn success_lands_a_draft_edit_with_author_and_normalized_original() {
        let store = make_store();
        let block = paragraph_block(&store);
        let c =
            suggest_edit_core(&store, "sess-1", suggest(&block, Some(&block.markdown))).unwrap();
        assert!(matches!(c.kind, CommentKind::Edit));
        assert!(matches!(c.status, CommentStatus::Draft));
        assert_eq!(c.author.as_deref(), Some("claude-code"));
        assert_eq!(c.block_id.as_deref(), Some(block.block_id.as_str()));
        assert_eq!(c.anchor_id, block.anchor_id);
        let edit = c.edit.expect("edit payload");
        assert_eq!(edit.original, block.markdown); // normalized to stored
        assert_eq!(edit.revised, "Rewritten paragraph.");
        assert_eq!(c.body, "(edit)");

        // …and the plan response now flags the block as owned.
        let owned = paragraph_block(&store);
        assert!(owned.open_comment);
    }

    #[test]
    fn occupied_block_conflicts_for_either_author() {
        let store = make_store();
        let block = paragraph_block(&store);
        suggest_edit_core(&store, "sess-1", suggest(&block, None)).unwrap();
        // Second agent suggestion on the same block → 409.
        let err = suggest_edit_core(&store, "sess-1", suggest(&block, None));
        assert!(matches!(err, Err(AgentError::Conflict(ref m)) if m.contains("open comment")));
    }

    #[test]
    fn user_draft_also_occupies_the_block() {
        let store = make_store();
        let block = paragraph_block(&store);
        store
            .add_comment(
                "sess-1",
                NewCommentRequest {
                    kind: CommentKind::Edit,
                    scope: None,
                    anchor_id: block.anchor_id.clone(),
                    block_id: Some(block.block_id.clone()),
                    body: "(edit)".to_string(),
                    edit: Some(EditPayload {
                        original: block.markdown.clone(),
                        revised: "User's own rewrite.".to_string(),
                    }),
                    structural: None,
                    selection: None,
                    author: None,
                },
            )
            .unwrap();
        assert!(matches!(
            suggest_edit_core(&store, "sess-1", suggest(&block, None)),
            Err(AgentError::Conflict(_))
        ));
    }

    fn feedback(block: &BlockInfo, body: &str) -> SuggestFeedbackRequest {
        SuggestFeedbackRequest {
            block_id: block.block_id.clone(),
            body: body.to_string(),
            agent_id: "voice".to_string(),
        }
    }

    #[test]
    fn feedback_unknown_session_and_block_are_not_found() {
        let store = make_store();
        let block = paragraph_block(&store);
        let mut req = feedback(&block, "make the timeout configurable");
        req.block_id = "blk-does-not-exist".to_string();
        assert!(matches!(
            add_feedback_core(&store, "sess-1", req.clone()),
            Err(AgentError::NotFound(_))
        ));
        assert!(matches!(
            add_feedback_core(&store, "nope", req),
            Err(AgentError::NotFound(_))
        ));
    }

    #[test]
    fn feedback_empty_body_or_agent_is_rejected() {
        let store = make_store();
        let block = paragraph_block(&store);
        assert!(matches!(
            add_feedback_core(&store, "sess-1", feedback(&block, "   ")),
            Err(AgentError::BadRequest(_))
        ));
        let mut req = feedback(&block, "real feedback");
        req.agent_id = "  ".to_string();
        assert!(matches!(
            add_feedback_core(&store, "sess-1", req),
            Err(AgentError::BadRequest(_))
        ));
    }

    #[test]
    fn feedback_lands_a_draft_feedback_with_author_and_anchor() {
        let store = make_store();
        let block = paragraph_block(&store);
        let c = add_feedback_core(&store, "sess-1", feedback(&block, "  make the timeout configurable  "))
            .unwrap();
        assert!(matches!(c.kind, CommentKind::Feedback));
        assert!(matches!(c.status, CommentStatus::Draft));
        assert!(matches!(c.scope, Some(CommentScope::Local)));
        assert_eq!(c.author.as_deref(), Some("voice"));
        assert_eq!(c.block_id.as_deref(), Some(block.block_id.as_str()));
        assert_eq!(c.anchor_id, block.anchor_id);
        assert_eq!(c.body, "make the timeout configurable"); // trimmed
        assert!(c.edit.is_none());
    }

    #[test]
    fn feedback_has_no_lock_and_coexists_across_blocks() {
        let store = make_store();
        let block = paragraph_block(&store);
        // Two feedback comments on the same block both succeed: add_feedback_core
        // itself holds no one-open-per-block lock.
        add_feedback_core(&store, "sess-1", feedback(&block, "first note")).unwrap();
        add_feedback_core(&store, "sess-1", feedback(&block, "second note")).unwrap();
        // Feedback on one block does not block an edit suggestion on a *different*,
        // clean block (the edit lock is per-block).
        let other = get_latest_plan_core(&store, "sess-1")
            .unwrap()
            .blocks
            .into_iter()
            .find(|b| b.kind == "paragraph" && b.block_id != block.block_id)
            .expect("a second paragraph block");
        assert!(suggest_edit_core(&store, "sess-1", suggest(&other, Some(&other.markdown))).is_ok());
    }
}
