// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Polis context access (Phase 3): the **friction digest** the Librarian agent
//! reasons over, computed as **ground truth** from Redline's own database.
//!
//! One builder, two consumers:
//! 1. `librarian.rs` bakes `render_digest_prompt_block` into the Librarian's spawn
//!    prompt, so the core loop never depends on the agent successfully curling
//!    (the same discipline `classmem::build_classifier_prompt` uses).
//! 2. `GET /v1/context/overview` serves the same `FrictionDigest` as JSON — an
//!    on-demand re-read for the agent and the Phase-4 external MCP surface.
//!
//! Everything here is read-only and bounded: each collection is capped so a long
//! history can't blow up the prompt or the response. The friction *taxonomy* and
//! *priority order* live in `skills/librarian/SKILL.md` and
//! `docs/polis-librarian-spike-3a.md`; this module only supplies the numbers.

use serde::Serialize;

use crate::classmem::LakeItem;
use crate::db::Database;
use crate::ledger::{now_millis, LedgerEventRow};
use crate::state::SessionStatus;

#[allow(unused_imports)]
pub use polis_memory::retrieval::{PROMPT_LIMIT_MAX, clamp_prompt_limit};

#[cfg(test)]
/// Signature-preserving shim (Session A5 of the Polis extraction): the body
/// is `polis_memory::retrieval::list_prompts`; this reaches it through `polis_for`.
pub fn list_prompts(db: &Database, filters: &PromptFilters) -> Result<Vec<LakeItem>, String> {
    polis_memory::retrieval::list_prompts(&crate::polis_host::polis_for(db), filters)
}

/// Test-only shim (Session A5): the aggregate the cached builder wraps;
/// production reads go through `build_stats_cached`.
#[cfg(test)]
pub fn build_stats(db: &Database) -> ContextStats {
    polis_memory::retrieval::build_stats(&crate::polis_host::polis_for(db))
}

/// Signature-preserving shim (Session A5 of the Polis extraction): the body
/// is `polis_memory::retrieval::build_stats_cached`; this reaches it through `polis_for`.
pub fn build_stats_cached(db: &Database) -> ContextStats {
    polis_memory::retrieval::build_stats_cached(&crate::polis_host::polis_for(db))
}

/// Signature-preserving shim (Session A5 of the Polis extraction): the body
/// is `polis_memory::retrieval::build_memory_map`; this reaches it through `polis_for`.
pub fn build_memory_map(db: &Database) -> MemoryMapView {
    polis_memory::retrieval::build_memory_map(&crate::polis_host::polis_for(db))
}

/// Signature-preserving shim (Session A5 of the Polis extraction): the body
/// is `polis_memory::retrieval::build_answer_pack`; this reaches it through `polis_for`.
pub fn build_answer_pack(
    db: &Database,
    q: Option<&str>,
    node_id: Option<&str>,
    limit: i64,
) -> AnswerPack {
    polis_memory::retrieval::build_answer_pack(&crate::polis_host::polis_for(db), q, node_id, limit)
}

/// Signature-preserving shim (Session A5 of the Polis extraction): the body
/// is `polis_memory::retrieval::build_thread_tree`; this reaches it through `polis_for`.
pub fn build_thread_tree(db: &Database, kind: &str, id: &str) -> serde_json::Value {
    polis_memory::retrieval::build_thread_tree(&crate::polis_host::polis_for(db), kind, id)
}

/// Signature-preserving shim (Session A5): the Timeline page comes from the
/// store, with the host's own pictures joined by `HostResolver::surface_shot_keys`.
pub fn query_ledger(db: &Database, f: &LedgerFilters) -> Result<Vec<TimelineItem>, String> {
    polis_memory::retrieval::query_ledger(&crate::polis_host::polis_for(db), f)
}


// The answer-pack vocabulary (types, byte budget, RRF fusion, the inline
// evidence render) and the read-side row types live in `polis-core` (Session
// A1 of the Polis extraction, docs/polis-extraction.md). Re-exported so every
// `crate::context::…` call site is unchanged.
// `#[allow(unused_imports)]`: a shim re-exports for PATH STABILITY, not for use
// inside this module — what nothing here touches still has call sites elsewhere
// (or in tests), and the lint cannot see across cfgs.
#[allow(unused_imports)]
pub use polis_core::pack::{
    budgeted_item_count, clamp_answer_pack_limit, clip_line, enforce_pack_budget,
    prefetch_status_label, render_answer_pack_block, rrf_fuse, AnswerPack, Arm, ArmCoverage,
    ArmHit, PackLink, PackNode, PackPromptHit, ANSWER_PACK_LIMIT, ANSWER_PACK_LIMIT_MAX,
    INLINE_BODY_CHARS, INLINE_PACK_LIMIT, INLINE_PACK_MAX_BYTES, MAX_CONTEXT_BYTES, RRF_K,
};
#[allow(unused_imports)]
pub use polis_core::types::{
    clamp_ledger_limit, ContextStats, LedgerFilters, MapEdge, MapNode, MemoryMapView, NoteOutcome,
    NoteWrite, PromptFilters, TimelineItem, UserNote, LEDGER_PAGE_MAX, PREVIEW_CHARS,
};

/// Caps keep the digest bounded on a long history (mirrors `code.rs`'s bounds).
pub const MAX_IN_REVIEW: usize = 20;
pub const MAX_BULGING: usize = 8;
pub const MAX_MISSIONS: usize = 12;
pub const MAX_SOURCE_TRUST: usize = 8;
/// Cap on the F6 "un-exported approved plan" list (Phase 4).
pub const MAX_UNEXPORTED: usize = 20;
/// Clamp bounds for the route's optional `?limit=` (applies to the ranked lists).
pub const LIMIT_MIN: i64 = 1;
pub const LIMIT_MAX: i64 = 50;

fn days_since(now: i64, then: i64) -> i64 {
    ((now - then).max(0)) / 86_400_000
}

// ---------------------------------------------------------------------------
// Digest shape (serialized by the route + rendered into the prompt)
// ---------------------------------------------------------------------------

/// The lake-stewardship signal: how far the taxonomy has fallen behind the lake.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LakeSignal {
    /// The head ledger seq (== total events, seq is 1-based autoincrement).
    pub total_events: i64,
    /// The seq the last accepted Organize consumed up to.
    pub last_organized_seq: i64,
    /// Unstructured backlog = `total_events − last_organized_seq` (never < 0).
    pub backlog: i64,
    /// The gardener's work queue: structural proposals waiting for a run
    /// (due or deferred). A FACT about the lake since Session B3 of the
    /// Polis extraction, not friction — nothing in it waits for a person.
    pub queued_proposals: i64,
}

/// An in-review session with unresolved comments — stalled in-flight work.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InReviewSignal {
    pub session_id: String,
    pub project: String,
    pub age_days: i64,
    pub unresolved_comments: i64,
}

/// A class node whose link pile has grown — a promote/split candidate.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulgingBranch {
    pub id: String,
    pub title: String,
    pub project: Option<String>,
    pub link_count: i64,
}

/// A mission and how long since it was created.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionSignal {
    pub id: String,
    pub title: String,
    pub age_days: i64,
}

/// An approved plan that has never been exported as a portable bundle — the
/// Librarian's deferred F6 friction, now backed by real Phase-4 state
/// (`plan_exports`). "Verifiably portable memory" is a headline Redline claim;
/// an approved plan you never exported is a gap the Librarian can now name
/// honestly (it could not in Phase 3, hence the "never fabricate" rule then).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnExportedSignal {
    pub session_id: String,
    pub project: String,
    pub age_days: i64,
}

/// The whole friction picture, ground truth. As of Phase 4 it carries the
/// `un_exported` signal — the F6 "un-exported approved plan" friction that Spike
/// 3a deferred for lack of backing state. The `plan_exports` table now supplies
/// it, so the Librarian may (and should) surface it — the Phase-3 "never
/// fabricate" caveat is retired for this one signal.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrictionDigest {
    pub generated_ts: i64,
    pub lake: LakeSignal,
    pub in_review: Vec<InReviewSignal>,
    pub bulging_branches: Vec<BulgingBranch>,
    pub missions: Vec<MissionSignal>,
    /// F6 (Phase 4): approved plans with no export bundle yet.
    pub un_exported: Vec<UnExportedSignal>,
    /// `(domain, feedback_count)` — informational source-trust coverage.
    pub source_trust: Vec<(String, i64)>,
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/// Build the friction digest from the DB. `limit` (already clamped by the caller)
/// caps the ranked lists; each also has its own hard cap. Best-effort per signal:
/// a table that isn't migrated yet (e.g. an old DB with no `class_*`) yields an
/// empty list for that signal rather than failing the whole digest.
pub fn build_digest(db: &Database, limit: usize) -> FrictionDigest {
    let now = now_millis();

    // Lake stewardship: backlog since the last accepted Organize.
    let total_events = db.max_ledger_seq().unwrap_or(0);
    let last_organized_seq = db.last_run_seq_to().unwrap_or(0);
    let backlog = (total_events - last_organized_seq).max(0);

    // The gardener's queue depth — a fact (B3), never a "held for review" list.
    let queued_proposals = db.count_pending_class_proposals().unwrap_or(0);

    // Stalled in-review work: sessions with unresolved comments, most-unresolved
    // and oldest first (the archetypal friction row bubbles to the top).
    let mut in_review: Vec<InReviewSignal> = db
        .in_review_friction()
        .unwrap_or_default()
        .into_iter()
        .map(|(session_id, project, created_at, unresolved)| InReviewSignal {
            session_id,
            project,
            age_days: days_since(now, created_at),
            unresolved_comments: unresolved,
        })
        .collect();
    in_review.sort_by(|a, b| {
        b.unresolved_comments
            .cmp(&a.unresolved_comments)
            .then(b.age_days.cmp(&a.age_days))
    });
    in_review.truncate(limit.min(MAX_IN_REVIEW));

    // Bulging branches: non-root nodes with the largest link piles (promote/split
    // candidates). Roots are the seeded classes themselves — not "bulging".
    let mut bulging: Vec<BulgingBranch> = db
        .list_class_nodes_with_counts()
        .unwrap_or_default()
        .into_iter()
        .filter(|(n, count)| n.parent_id.is_some() && *count > 0)
        .map(|(n, count)| BulgingBranch {
            id: n.id,
            title: n.title,
            project: n.project_path,
            link_count: count,
        })
        .collect();
    bulging.sort_by(|a, b| b.link_count.cmp(&a.link_count));
    bulging.truncate(limit.min(MAX_BULGING));

    let mut missions: Vec<MissionSignal> = db
        .list_missions()
        .unwrap_or_default()
        .into_iter()
        .map(|m| MissionSignal {
            id: m.mission_id,
            title: m.title,
            age_days: days_since(now, m.created_at),
        })
        .collect();
    missions.truncate(MAX_MISSIONS);

    // F6: approved plans with no export bundle (Phase 4 state, real at last).
    let mut un_exported: Vec<UnExportedSignal> = db
        .un_exported_approved_sessions()
        .unwrap_or_default()
        .into_iter()
        .map(|(session_id, project, approved_at)| UnExportedSignal {
            session_id,
            project,
            age_days: days_since(now, approved_at),
        })
        .collect();
    un_exported.truncate(limit.min(MAX_UNEXPORTED));

    let mut source_trust = db.domain_feedback_summary().unwrap_or_default();
    source_trust.truncate(MAX_SOURCE_TRUST);

    FrictionDigest {
        generated_ts: now,
        lake: LakeSignal {
            total_events,
            last_organized_seq,
            backlog,
            queued_proposals,
        },
        in_review,
        bulging_branches: bulging,
        missions,
        un_exported,
        source_trust,
    }
}

/// Clamp a caller-supplied `?limit=` into the accepted range.
pub fn clamp_limit(raw: Option<i64>) -> usize {
    raw.unwrap_or(LIMIT_MAX).clamp(LIMIT_MIN, LIMIT_MAX) as usize
}

// ---------------------------------------------------------------------------
// Phase 4 route builders: /v1/context/prompts, /sessions/:id/history, /stats
// ---------------------------------------------------------------------------

/// A revision reduced to a digest (no body) for the session-history route.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionDigest {
    pub version_number: u32,
    pub received_at: i64,
    /// Byte length of the revision markdown (a size cue without shipping it).
    pub bytes: usize,
    pub title: Option<String>,
    pub comment_count: usize,
    pub restored: bool,
}

/// A comment reduced to its thread essentials for the session-history route.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentThread {
    pub id: String,
    pub kind: String,
    pub anchor_id: String,
    pub body: String,
    pub status: String,
    pub resolution: Option<String>,
    pub resolved: bool,
    pub author: Option<String>,
    pub reviewer: Option<String>,
}

/// `GET /v1/context/sessions/:id/history` — revision digests + comment threads +
/// the session's decision events, joined from `load_all()` and the ledger.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistory {
    pub session_id: String,
    pub project: String,
    pub status: String,
    pub created_at: i64,
    pub revisions: Vec<RevisionDigest>,
    pub comments: Vec<CommentThread>,
    /// Decision/curation ledger events tied to this session (prompt & revision
    /// events are already represented by `revisions`, so they're excluded).
    pub decision_events: Vec<LedgerEventRow>,
}

/// Build a session's history, or `None` if the session id is unknown.
pub fn build_session_history(db: &Database, session_id: &str) -> Option<SessionHistory> {
    // ONE session, not the whole review history reparsed to keep one entry.
    let session = &db.load_session(session_id).ok()??;

    let revisions: Vec<RevisionDigest> = session
        .revisions
        .iter()
        .map(|r| RevisionDigest {
            version_number: r.version_number,
            received_at: r.received_at,
            bytes: r.raw_plan_markdown.len(),
            title: crate::parser::plan_title_from_markdown(&r.raw_plan_markdown),
            comment_count: r.comments.len(),
            restored: r.restored,
        })
        .collect();

    // Comments live per-revision; flatten across the session's revisions.
    let comments: Vec<CommentThread> = session
        .revisions
        .iter()
        .flat_map(|r| r.comments.iter())
        .map(|c| CommentThread {
            id: c.id.clone(),
            kind: format!("{:?}", c.kind).to_lowercase(),
            anchor_id: c.anchor_id.clone(),
            body: c.body.clone(),
            status: format!("{:?}", c.status).to_lowercase(),
            resolution: c.resolution.as_ref().map(|res| res.body.clone()),
            resolved: c
                .resolution
                .as_ref()
                .map(|res| res.accepted_at.is_some())
                .unwrap_or(false),
            author: c.author.clone(),
            reviewer: c.reviewer.clone(),
        })
        .collect();

    let decision_events: Vec<LedgerEventRow> = db
        .list_session_events(session_id)
        .unwrap_or_default()
        .into_iter()
        .filter(|e| e.kind != "prompt" && e.kind != "revision")
        .collect();

    let status = match session.status {
        SessionStatus::InReview => "in_review",
        SessionStatus::Approved => "approved",
        SessionStatus::Aborted => "aborted",
    }
    .to_string();

    Some(SessionHistory {
        session_id: session.session_id.clone(),
        project: session.project_name.clone(),
        status,
        created_at: session.created_at,
        revisions,
        comments,
        decision_events,
    })
}

// ---------------------------------------------------------------------------
// Timeline query (the Memory surface's spine)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Memory map (Second Brain P5)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Answer pack — the batched retrieval read
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Prompt rendering (ground truth baked into the Librarian's spawn prompt)
// ---------------------------------------------------------------------------

/// Render the digest as a compact, ground-truth markdown block for the
/// Librarian's prompt. Numbers only — the SKILL supplies the priority order
/// and the agent supplies the ranking judgment.
pub fn render_digest_prompt_block(d: &FrictionDigest) -> String {
    let mut p = String::new();
    p.push_str("## Friction digest (GROUND TRUTH — do not re-derive; rank these)\n\n");

    p.push_str(&format!(
        "### Lake stewardship\n- total ledger events: {}\n- last Organize consumed up to seq: {}\n- **unstructured backlog: {}** (events awaiting the next Organize)\n- gardener queue: {} structural proposal(s) waiting for a run (a fact — the gardener adjudicates them itself; nothing here needs a person)\n\n",
        d.lake.total_events, d.lake.last_organized_seq, d.lake.backlog, d.lake.queued_proposals
    ));
    p.push('\n');

    p.push_str("### In-review sessions (unresolved comments × age)\n");
    if d.in_review.is_empty() {
        p.push_str("- (no in-review sessions)\n");
    } else {
        for s in &d.in_review {
            p.push_str(&format!(
                "- session {} ({}) — {} unresolved comment(s), {}d old\n",
                s.session_id, s.project, s.unresolved_comments, s.age_days
            ));
        }
    }
    p.push('\n');

    p.push_str("### Bulging branches (promote/split candidates)\n");
    if d.bulging_branches.is_empty() {
        p.push_str("- (none)\n");
    } else {
        for b in &d.bulging_branches {
            p.push_str(&format!(
                "- {} (id={}) — {} linked item(s)\n",
                b.title, b.id, b.link_count
            ));
        }
    }
    p.push('\n');

    p.push_str("### Missions in flight\n");
    if d.missions.is_empty() {
        p.push_str("- (none)\n");
    } else {
        for m in &d.missions {
            p.push_str(&format!("- {} (id={}) — {}d old\n", m.title, m.id, m.age_days));
        }
    }
    p.push('\n');

    p.push_str("### Un-exported approved plans (F6 — now a real signal)\n");
    if d.un_exported.is_empty() {
        p.push_str("- (none — every approved plan has a portable bundle)\n");
    } else {
        for u in &d.un_exported {
            p.push_str(&format!(
                "- session {} ({}) — approved {}d ago, no export bundle\n",
                u.session_id, u.project, u.age_days
            ));
        }
    }
    p.push('\n');

    if !d.source_trust.is_empty() {
        p.push_str("### Source-trust coverage (informational)\n");
        for (domain, count) in &d.source_trust {
            p.push_str(&format!("- {domain}: {count} feedback signal(s)\n"));
        }
        p.push('\n');
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_db_yields_a_valid_bounded_digest() {
        let db = Database::open_in_memory().unwrap();
        let d = build_digest(&db, clamp_limit(None));
        // A fresh workspace: zero backlog, empty lists — a correct, honest state.
        assert_eq!(d.lake.backlog, 0);
        assert_eq!(d.lake.queued_proposals, 0);
        assert!(d.in_review.is_empty());
        assert!(d.bulging_branches.is_empty());
        // The prompt block renders without panicking and marks itself ground truth.
        let block = render_digest_prompt_block(&d);
        assert!(block.contains("GROUND TRUTH"));
        assert!(block.contains("unstructured backlog: 0"));
    }

    #[test]
    fn backlog_is_events_minus_last_organized_never_negative() {
        // Pure arithmetic guard on the flagship signal.
        let d = FrictionDigest {
            generated_ts: 0,
            lake: LakeSignal {
                total_events: 5,
                last_organized_seq: 12,
                backlog: (5i64 - 12).max(0),
                queued_proposals: 0,
            },
            in_review: vec![],
            bulging_branches: vec![],
            missions: vec![],
            un_exported: vec![],
            source_trust: vec![],
        };
        assert_eq!(d.lake.backlog, 0, "backlog clamps at 0 (never negative)");
    }

    #[test]
    fn clamp_limit_bounds_the_route_param() {
        assert_eq!(clamp_limit(None), LIMIT_MAX as usize);
        assert_eq!(clamp_limit(Some(0)), LIMIT_MIN as usize);
        assert_eq!(clamp_limit(Some(9999)), LIMIT_MAX as usize);
        assert_eq!(clamp_limit(Some(-4)), LIMIT_MIN as usize);
        assert_eq!(clamp_limit(Some(10)), 10);
    }

    #[test]
    fn clamp_prompt_limit_bounds_the_route_param() {
        assert_eq!(clamp_prompt_limit(None), PROMPT_LIMIT_MAX);
        assert_eq!(clamp_prompt_limit(Some(0)), 1);
        assert_eq!(clamp_prompt_limit(Some(99999)), PROMPT_LIMIT_MAX);
        assert_eq!(clamp_prompt_limit(Some(25)), 25);
    }

    // A small helper: capture a prompt on a surface/project so the filtered
    // reads have something to bite on.
    fn seed_prompt(db: &Database, surface: &str, project: Option<&str>, body: &str) {
        crate::ledger::record_prompt(
            db,
            crate::ledger::PromptInput {
                source: crate::ledger::PromptSource::Hook,
                origin: crate::ledger::Origin::Redline,
                surface: surface.to_string(),
                role: crate::ledger::CorpusRole::User,
                user_text: None,
                session_id: Some(format!("sess-{surface}")),
                claude_session_id: Some(format!("cs-{body}")),
                mission_id: None,
                project_path: project.map(str::to_string),
                body: body.to_string(),
                thread: None,
                author: None,
                model: None,
                model_source: None,
            },
        )
        .unwrap();
    }

    #[test]
    fn context_prompts_filter_by_surface_and_project() {
        let db = Database::open_in_memory().unwrap();
        seed_prompt(&db, "pty_plan", Some("/repo/a"), "add auth to the app");
        seed_prompt(&db, "browse", Some("/repo/b"), "research clerk pricing");
        seed_prompt(&db, "pty_plan", Some("/repo/a"), "wire up the ledger");

        let by_surface = list_prompts(
            &db,
            &PromptFilters {
                surface: Some("pty_plan".into()),
                limit: clamp_prompt_limit(None),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(by_surface.len(), 2, "only pty_plan prompts");

        let by_project = list_prompts(
            &db,
            &PromptFilters {
                project: Some("/repo/b".into()),
                limit: clamp_prompt_limit(None),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(by_project.len(), 1);
        assert_eq!(by_project[0].surface.as_deref(), Some("browse"));
    }

    #[test]
    fn context_prompts_filter_by_thread_and_parent_session() {
        let db = Database::open_in_memory().unwrap();
        seed_prompt(&db, "pty_plan", Some("/repo/a"), "plain plan prompt");
        crate::ledger::record_prompt(
            &db,
            crate::ledger::PromptInput {
                source: crate::ledger::PromptSource::RustFirstTurn,
                origin: crate::ledger::Origin::Redline,
                surface: "browse".to_string(),
                role: crate::ledger::CorpusRole::User,
                user_text: None,
                session_id: None,
                claude_session_id: None,
                mission_id: None,
                project_path: None,
                body: "tab-scoped question".to_string(),
                thread: Some(crate::ledger::ThreadRef {
                    thread_kind: "browse",
                    thread_id: "tab-42".to_string(),
                    parent_session_id: Some("sess-parent".to_string()),
                }),
                author: None,
                model: None,
                model_source: None,
            },
        )
        .unwrap();

        let by_thread = list_prompts(
            &db,
            &PromptFilters {
                thread_kind: Some("browse".into()),
                thread_id: Some("tab-42".into()),
                limit: clamp_prompt_limit(None),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(by_thread.len(), 1);
        assert_eq!(by_thread[0].body.as_deref(), Some("tab-scoped question"));

        let by_parent = list_prompts(
            &db,
            &PromptFilters {
                parent_session_id: Some("sess-parent".into()),
                limit: clamp_prompt_limit(None),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(by_parent.len(), 1);
        assert_eq!(by_parent[0].thread_id.as_deref(), Some("tab-42"));

        // A thread filter that matches nothing returns nothing (not everything).
        let none = list_prompts(
            &db,
            &PromptFilters {
                thread_kind: Some("linked".into()),
                limit: clamp_prompt_limit(None),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(none.is_empty());
    }

    #[test]
    fn context_prompts_substring_is_bound_not_injectable() {
        let db = Database::open_in_memory().unwrap();
        seed_prompt(&db, "pty_plan", None, "harmless plan body");
        seed_prompt(&db, "pty_plan", None, "another entry");

        // An injection-shaped q must be treated as a literal LIKE needle: it
        // matches nothing (no body contains it) and — critically — does not
        // drop the table or return everything.
        let evil = list_prompts(
            &db,
            &PromptFilters {
                substring: Some("'; DROP TABLE prompts;--".into()),
                limit: clamp_prompt_limit(None),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(evil.is_empty(), "injection-shaped q matches nothing");
        // The table is intact — a real substring still works afterward.
        let hit = list_prompts(
            &db,
            &PromptFilters {
                substring: Some("harmless".into()),
                limit: clamp_prompt_limit(None),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(hit.len(), 1);
        // LIKE metacharacters are escaped: a bare '%' wildcard matches literally.
        let pct = list_prompts(
            &db,
            &PromptFilters {
                substring: Some("%".into()),
                limit: clamp_prompt_limit(None),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(pct.is_empty(), "'%' is escaped, not a wildcard");
    }

    #[test]
    fn context_prompts_respect_since_seq_and_limit() {
        let db = Database::open_in_memory().unwrap();
        for i in 0..5 {
            seed_prompt(&db, "pty_plan", None, &format!("body {i}"));
        }
        let all = list_prompts(
            &db,
            &PromptFilters {
                limit: clamp_prompt_limit(None),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(all.len(), 5);
        let after = list_prompts(
            &db,
            &PromptFilters {
                since_seq: Some(all[2].seq),
                limit: clamp_prompt_limit(None),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(after.len(), 2, "seq strictly greater than the 3rd");
        let capped = list_prompts(
            &db,
            &PromptFilters {
                limit: 2,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(capped.len(), 2);
    }

    /// Seed an accepted class node with a child and one link into the lake.
    fn seed_class(db: &Database, id: &str, title: &str) {
        db.seed_class_roots(&[(id.to_string(), title.to_string(), Some("/repo".into()))])
            .unwrap();
    }

    /// The inline block must be honest about itself — that property is what
    /// makes "do not curl" safe to say. It names the terms searched, the basis
    /// on which a node resolved, and any list that was trimmed.
    #[test]
    fn the_prefetch_block_states_what_it_searched_and_what_it_trimmed() {
        let db = Database::open_in_memory().unwrap();
        seed_class(&db, "n-browser", "Embedded browser");
        seed_prompt(&db, "pty_plan", Some("/repo"), "the browser tab suspension design");

        let q = "what did I decide about the browser tab suspension";
        let plan = crate::query::plan_fts_query(q).unwrap();
        let mut pack = build_answer_pack(&db, Some(q), None, INLINE_PACK_LIMIT);
        pack.truncated.push("promptHits".to_string());
        let block =
            render_answer_pack_block(&pack, Some(&plan), INLINE_PACK_MAX_BYTES).expect("a block");

        assert!(block.starts_with("PREFETCHED EVIDENCE"));
        assert!(block.contains("Searched: decide, browser, tab, suspension."), "{block}");
        assert!(block.contains("Resolved: [[Embedded browser]]"), "{block}");
        assert!(block.contains("matched \"browser\" in the title"), "{block}");
        assert!(block.contains("TRIMMED: promptHits."), "{block}");
        // The escape hatch, stated in terms the model can act on.
        assert!(block.contains("If this answers the question, ANSWER — do not curl."));
        assert!(block.contains("says it was TRIMMED"));
    }

    /// An empty block is strictly worse than silence: it reads as "the record
    /// was searched and is empty", which is a claim about the user's history
    /// rather than about the query. Both empty cases must render `None`.
    #[test]
    fn an_empty_prefetch_renders_nothing_at_all() {
        let db = Database::open_in_memory().unwrap();
        // No terms at all.
        let pack = build_answer_pack(&db, Some("what can you do?"), None, INLINE_PACK_LIMIT);
        let plan = crate::query::plan_fts_query("what can you do?");
        // (all-stopword queries DO produce terms — the interesting case is a
        // query that plans to nothing)
        assert!(crate::query::plan_fts_query("--- ///").is_none());
        assert!(render_answer_pack_block(&pack, None, INLINE_PACK_MAX_BYTES).is_none());

        // Terms, but every arm came back empty.
        let plan = plan.unwrap();
        let empty = build_answer_pack(&db, Some("zebra quagga"), None, INLINE_PACK_LIMIT);
        assert!(render_answer_pack_block(&empty, Some(&plan), INLINE_PACK_MAX_BYTES).is_none());
    }

    /// A clipped block SAYS it was clipped — a silently truncated evidence
    /// block is the same lie as a silently truncated pack.
    #[test]
    fn a_clipped_prefetch_block_admits_it() {
        let db = Database::open_in_memory().unwrap();
        for i in 0..20 {
            let body: String = (0..200).map(|j| format!("loop t{i}w{j} ")).collect();
            seed_prompt(&db, "pty_plan", Some("/repo"), &body);
        }
        let plan = crate::query::plan_fts_query("loop").unwrap();
        let pack = build_answer_pack(&db, Some("loop"), None, INLINE_PACK_LIMIT);
        let block = render_answer_pack_block(&pack, Some(&plan), 1_200).expect("a block");
        assert!(block.len() <= 1_200, "{} bytes", block.len());
        assert!(block.contains("[prefetch clipped to fit"), "{block}");
    }

    /// GOLDEN QUESTIONS — retrieval is the thing that regresses silently, so it
    /// gets a fixture rather than a spot check. Each row is
    /// `question → the node it must resolve → a seq that must be in the pack`.
    /// A failure here means a planner or ranking change quietly stopped finding
    /// something a user could previously ask for.
    #[test]
    fn golden_questions_resolve_and_cite() {
        let db = Database::open_in_memory().unwrap();
        seed_class(&db, "n-browser", "Embedded browser");
        seed_class(&db, "n-keeper", "Memory keeper compaction");
        seed_class(&db, "n-voice", "Voice agent");

        // (body, surface) — the seq is the insertion order, 1-based.
        let corpus = [
            "the browser tab suspension keeps three webviews live at a time",
            "keeper compaction releases cold prompt bodies into gists",
            "the voice agent needs full-duplex AEC for barge-in",
            "pass --allowedTools to every headless spawn in src-tauri/src/claude_proc.rs",
            "compacting the ledger must never touch a user role row",
        ];
        for body in corpus {
            seed_prompt(&db, "pty_plan", Some("/repo"), body);
        }

        let cases: &[(&str, Option<&str>, &[&str])] = &[
            // A natural-language question must resolve its class — the exact
            // shape that returned `node: null` on the live daemon.
            (
                "what did I decide about the browser tab suspension",
                Some("Embedded browser"),
                &["tab suspension"],
            ),
            // Porter: the question's inflection differs from the corpus's.
            ("compacting cold bodies", Some("Memory keeper compaction"), &["compaction releases"]),
            // A bare topic word.
            ("voice", Some("Voice agent"), &["full-duplex AEC"]),
            // A literal no tokenizer can hold — the grep arm's job.
            ("--allowedTools", None, &["--allowedTools"]),
            // A question about nothing in the record resolves nothing, and says
            // so by being empty rather than by inventing a class.
            ("zebra quagga", None, &[]),
        ];

        for (q, want_node, want_snippets) in cases {
            let pack = build_answer_pack(&db, Some(q), None, INLINE_PACK_LIMIT);
            match want_node {
                Some(title) => assert_eq!(
                    pack.node.as_ref().map(|n| n.node.title.as_str()),
                    Some(*title),
                    "{q:?} must resolve [[{title}]]"
                ),
                None => {}
            }
            let haystack = format!(
                "{} {}",
                pack.prompt_hits
                    .iter()
                    .filter_map(|h| h.item.body.clone())
                    .collect::<Vec<_>>()
                    .join(" "),
                pack.grep_hits
                    .iter()
                    .map(|g| g.excerpt.clone())
                    .collect::<Vec<_>>()
                    .join(" ")
            );
            for snippet in *want_snippets {
                assert!(
                    haystack.contains(snippet),
                    "{q:?} must surface {snippet:?}; got: {haystack}"
                );
            }
            if want_snippets.is_empty() {
                assert!(pack.prompt_hits.is_empty(), "{q:?} must find nothing: {:?}", pack.prompt_hits);
            }
        }
    }

    // --- THE THREE TAXONOMY INVARIANTS ------------------------------------
    //
    // These are what make a ranked fuzzy index — and now an embedding model —
    // admissible in a product built on a human-curated catalog. In one line:
    // **the arms decide what you READ; the tree decides what things ARE.**
    // Each is a guard test rather than a comment, because the failure mode is
    // silent: a retrieval change that starts writing to the catalog looks like
    // better recall right up until the taxonomy is describing rankings.

    /// **1. Node resolution never consults a lake ranking.** Classes come from
    /// `class_nodes_fts` and the explicit `?node=` — human-accepted text only.
    /// A bm25 or vector hit on a PROMPT can never create, rename, reparent or
    /// reorder a class, however strongly it matches.
    #[test]
    fn answer_pack_node_arm_ignores_lake_hits() {
        let db = Database::open_in_memory().unwrap();
        seed_class(&db, "n-voice", "Voice agent");
        // A prompt that screams "browser tab suspension" while NO class by that
        // name exists. A lake-driven resolver would happily mint or promote one.
        for _ in 0..5 {
            seed_prompt(
                &db,
                "pty_plan",
                Some("/repo"),
                "browser tab suspension browser tab suspension design",
            );
        }
        let before: Vec<String> = db
            .list_class_nodes()
            .unwrap()
            .into_iter()
            .map(|n| format!("{}|{}|{:?}", n.id, n.title, n.parent_id))
            .collect();

        let pack = build_answer_pack(&db, Some("browser tab suspension"), None, ANSWER_PACK_LIMIT);
        // The lexical arm found the prompts…
        assert!(!pack.prompt_hits.is_empty(), "the evidence is there");
        // …and the node arm resolved NOTHING, because no human ever accepted a
        // class by that name. An empty `node` beside full `promptHits` is the
        // correct, honest shape.
        assert!(
            pack.node.is_none(),
            "a lake hit must never conjure a class: {:?}",
            pack.node.map(|n| n.node.title)
        );

        let after: Vec<String> = db
            .list_class_nodes()
            .unwrap()
            .into_iter()
            .map(|n| format!("{}|{}|{:?}", n.id, n.title, n.parent_id))
            .collect();
        assert_eq!(before, after, "retrieval must not have touched the catalog");
    }

    /// **2. No retrieval path writes to the catalog.** A source invariant, in
    /// the `size_guard.rs` style: the modules that answer questions may read
    /// the tree and may never mutate it. Enforced in source rather than by
    /// review because a single well-meaning "let's file this while we're here"
    /// would turn the taxonomy into a function of search behaviour.
    #[test]
    fn retrieval_modules_never_write_the_catalog() {
        // The two pure modules live in polis-core (a git dependency since
        // the extraction's A7); the shims at `src/query.rs` / `src/dedup.rs`
        // are one re-export each, so the guard reads the moved sources —
        // from wherever cargo checked the crate out — or it guards nothing.
        let retrieval: Vec<(&str, String)> = vec![
            ("query.rs", crate::polis_src::polis_source("polis-core", "src/query.rs")),
            ("dedup.rs", crate::polis_src::polis_source("polis-core", "src/dedup.rs")),
            ("embed.rs", include_str!("embed.rs").to_string()),
        ];
        // Every catalog-mutating entry point on `Database`.
        const WRITES: &[&str] = &[
            "stage_proposal",
            "accept_class_node",
            "accept_all_pending",
            "seed_class_roots",
            "revert_link",
            "clear_embeddings", // …and even the index's own reset is not theirs
        ];
        for (name, src) in &retrieval {
            for w in WRITES {
                assert!(
                    !src.contains(w),
                    "{name} names `{w}` — retrieval reads the catalog, never writes it"
                );
            }
        }
    }

    /// **3. The classifier's input is chain order, never a ranking.** What the
    /// taxonomy is built FROM must stay the record's own sequence: feed it a
    /// relevance-ordered slice and the tree starts describing what searches
    /// well rather than what happened.
    #[test]
    fn classifier_delta_takes_no_query() {
        // The delta reader is a `PolisStore` method since Session A3 of the
        // Polis extraction; the guard reads the moved source from the
        // dependency's checkout.
        let src = crate::polis_src::polis_source("polis-store", "src/catalog.rs");
        let body = src
            .split_once("pub fn list_lake_items_since(")
            .expect("the classifier's delta reader exists")
            .1;
        let sig_end = body.find(')').unwrap();
        let signature = &body[..sig_end];
        // Parameter NAMES, parsed — a substring check trips over `since_seq`.
        let params: Vec<&str> = signature
            .split(',')
            .filter_map(|p| p.split(':').next())
            .map(str::trim)
            .filter(|p| !p.is_empty() && *p != "&self")
            .collect();
        for banned in ["q", "query", "term", "match"] {
            assert!(
                !params.contains(&banned),
                "the classifier's delta must take no query parameter (`{banned}` in {params:?})"
            );
        }
        // …and its body orders by seq, ascending, full stop.
        let stmt_end = body.find("let rows =").unwrap_or(body.len());
        let stmt = &body[..stmt_end];
        assert!(stmt.contains("ORDER BY le.seq ASC"), "chain order is the contract");
        assert!(!stmt.contains("bm25("), "no ranking may enter the classifier's input");
    }

    /// An arm that did not run says so. This is what stops an empty result
    /// reading as "you never thought about this" when the truth is "the
    /// semantic index isn't built yet".
    #[test]
    fn arm_coverage_distinguishes_absent_from_empty() {
        let db = Database::open_in_memory().unwrap();
        seed_prompt(&db, "pty_plan", Some("/repo"), "the loop executor");
        let pack = build_answer_pack(&db, Some("loop"), None, ANSWER_PACK_LIMIT);

        let arm = |a: Arm| pack.arm_coverage.iter().find(|c| c.arm == a).expect("every arm reports");
        // The lexical arm ran and found something.
        assert!(arm(Arm::Lexical).ran);
        assert!(arm(Arm::Lexical).hits > 0);
        // The grep arm did NOT run — and names the reason rather than looking
        // like an arm that searched and found nothing.
        let grep = arm(Arm::Grep);
        assert!(!grep.ran);
        assert!(grep.absent_because.as_deref().unwrap_or("").contains("literal"));
        // The semantic arm's state depends on the machine; either way it is
        // explicit, never a silent zero.
        let sem = arm(Arm::Semantic);
        assert_eq!(sem.ran, sem.absent_because.is_none());
    }

    /// The pack's shape contract: the user's own words lead, the resolved node
    /// carries its subtree/links/observations, links carry `supersededBy`, and
    /// the whole thing stays inside the byte budget.
    #[test]
    fn answer_pack_is_bounded_and_notes_lead() {
        let db = Database::open_in_memory().unwrap();
        seed_class(&db, "root-loop", "Loop Engineering");
        seed_prompt(&db, "pty_plan", Some("/repo"), "wire the loop executor");
        seed_prompt(&db, "browse", Some("/repo"), "loop retry semantics");
        // The user's own margin note on the first prompt's event.
        db.write_user_note(
            &NoteWrite {
                target_kind: Some("ledger_event".into()),
                target_id: Some("1".into()),
                text: Some("the loop executor decision was mine".into()),
                ..Default::default()
            },
            "yusuf",
        )
        .unwrap();
        // A link off the node into the lake, and a supersession over it.
        db.stage_proposal(
            None,
            &crate::classmem::Proposal::File {
                parent_id: "root-loop".into(),
                sub_class: None,
                target_kind: "prompt".into(),
                target_id: "1".into(),
                note: None,
                rationale: None,
            },
        )
        .unwrap();
        db.accept_all_pending("yusuf").unwrap();

        let pack = build_answer_pack(&db, Some("loop"), None, ANSWER_PACK_LIMIT);
        assert_eq!(pack.head_seq, db.max_ledger_seq().unwrap());
        // The node resolved off the query alone.
        let node = pack.node.as_ref().expect("the node must resolve from `q`");
        assert_eq!(node.node.id, "root-loop");
        assert_eq!(node.links.len(), 1, "the accepted link rides along");
        assert!(
            node.links[0].label.is_some(),
            "labels are resolved in one batched read"
        );
        assert!(node.links[0].superseded_by.is_none(), "nothing superseded it");
        // The human-authored signal is present and leads.
        assert_eq!(pack.notes.len(), 1);
        assert!(pack.notes[0].text.contains("the loop executor decision was mine"));
        // Lexical evidence from the lake.
        assert_eq!(pack.prompt_hits.len(), 2);
        assert!(pack.prompt_hits.iter().all(|h| h.superseded_by.is_none()));
        // Budgeted.
        let bytes = serde_json::to_vec(&pack).unwrap().len();
        assert!(bytes <= MAX_CONTEXT_BYTES, "{bytes} bytes exceeds the budget");
        assert!(pack.truncated.is_empty(), "nothing to trim at this size");
    }

    /// The miss path is the whole reason the route is worth having: a query
    /// that resolves to NO node must still hand back one-call lexical
    /// evidence, never an empty pack that pushes the agent back into the walk.
    #[test]
    fn answer_pack_miss_path_still_returns_lexical_evidence() {
        let db = Database::open_in_memory().unwrap();
        seed_prompt(&db, "pty_plan", Some("/repo"), "the peculiar widget migration");
        db.write_user_note(
            &NoteWrite {
                text: Some("widget migration was a slog".into()),
                ..Default::default()
            },
            "yusuf",
        )
        .unwrap();

        // Nothing has been organized — there is no catalog to resolve against.
        let pack = build_answer_pack(&db, Some("widget"), None, ANSWER_PACK_LIMIT);
        assert!(pack.node.is_none(), "no catalog, so nothing resolves");
        assert_eq!(pack.prompt_hits.len(), 1, "the lake still answers");
        assert_eq!(pack.notes.len(), 1, "and so do the user's own words");

        // A STALE `?node=` must degrade the same way, not blank the pack.
        let stale = build_answer_pack(&db, Some("widget"), Some("no-such-node"), ANSWER_PACK_LIMIT);
        assert!(stale.node.is_none());
        assert_eq!(stale.prompt_hits.len(), 1);
        assert_eq!(stale.notes.len(), 1);

        // And a query matching nothing says so honestly rather than erroring.
        let empty = build_answer_pack(&db, Some("zzzznothing"), None, ANSWER_PACK_LIMIT);
        assert!(empty.node.is_none());
        assert!(empty.prompt_hits.is_empty());
        assert!(empty.notes.is_empty());
    }

    /// Twenty large, GENUINELY DISTINCT prompts now fit inside the budget —
    /// because the per-hit window is divided among them instead of each
    /// claiming a flat 4,000 characters. Before Phase 3 this pack could not fit
    /// and paid for it by dropping whole arms.
    #[test]
    fn answer_pack_fits_distinct_hits_without_dropping_an_arm() {
        let db = Database::open_in_memory().unwrap();
        for i in 0..20 {
            // Distinct vocabulary per prompt, so nothing collapses as a
            // near-duplicate: this measures the budget, not the deduper.
            let big: String = (0..1_000).map(|j| format!("term{i}n{j} ")).collect();
            seed_prompt(&db, "pty_plan", Some("/repo"), &format!("loop {big}"));
        }
        db.write_user_note(
            &NoteWrite {
                text: Some("loop notes matter most".into()),
                ..Default::default()
            },
            "yusuf",
        )
        .unwrap();

        let pack = build_answer_pack(&db, Some("loop"), None, ANSWER_PACK_LIMIT_MAX);
        let bytes = serde_json::to_vec(&pack).unwrap().len();
        assert!(bytes <= MAX_CONTEXT_BYTES, "{bytes} bytes exceeds the budget");
        assert_eq!(pack.notes.len(), 1, "the user's own words survive");
        assert!(!pack.truncated.contains(&"notes".to_string()));
        assert!(
            pack.prompt_hits.len() >= 8,
            "hits survive as excerpts rather than being dropped whole: {}",
            pack.prompt_hits.len()
        );
    }

    /// The live failure, replayed. `?q=keeper compaction` returned four copies
    /// of the same ClassMemory boilerplate among eight top hits — each clipped
    /// at 4,000 characters from the HEAD, which is exactly why they looked
    /// identical — and the byte budget then dropped every browse hit to fit them.
    #[test]
    fn pack_never_returns_four_copies_of_one_preface() {
        let db = Database::open_in_memory().unwrap();
        let preface = "You are Redline's ClassMemory orchestrator. You organize the user's raw \
                       prompt and decision lake into an emergent class tree. You are READ-ONLY \
                       over the lake, and your organization is applied directly. "
            .repeat(10);
        // The same 6 KB framing wrapped around four different questions — the
        // shape that produced the live result.
        for q in [
            "what did I decide about compaction?",
            "what did I decide about the keeper?",
            "what did I decide about gists?",
            "what did I decide about cold prompts?",
        ] {
            seed_prompt(&db, "pty_plan", Some("/repo"), &format!("{preface}\n\nkeeper compaction — {q}"));
        }
        seed_prompt(&db, "pty_plan", Some("/repo"), "keeper compaction runs on the watch bus");

        let pack = build_answer_pack(&db, Some("keeper compaction"), None, ANSWER_PACK_LIMIT_MAX);
        let framed = pack
            .prompt_hits
            .iter()
            .filter(|h| h.item.body.as_deref().is_some_and(|b| b.contains("ClassMemory orchestrator")))
            .count();
        assert!(
            framed <= 1,
            "four copies of one preface must collapse to one: {framed} survived"
        );
        // And the suppression is REPORTED, not silent.
        assert!(
            pack.prompt_hits.iter().any(|h| !h.duplicate_of.is_empty()),
            "the collapsed copies must be named: {:?}",
            pack.prompt_hits.iter().map(|h| &h.duplicate_of).collect::<Vec<_>>()
        );
        // The distinct prompt is not crowded out.
        assert!(pack
            .prompt_hits
            .iter()
            .any(|h| h.item.body.as_deref().is_some_and(|b| b.contains("watch bus"))));
    }

    /// A bulging class must not be able to make the pack quadratic: the link
    /// list is capped before the byte budget ever runs, and the cap is
    /// reported rather than silently applied.
    #[test]
    fn answer_pack_caps_a_bulging_node_before_budgeting() {
        let db = Database::open_in_memory().unwrap();
        seed_class(&db, "root-big", "Big Class");
        for i in 0..400 {
            seed_prompt(&db, "pty_plan", Some("/repo"), &format!("big item {i}"));
            db.stage_proposal(
                None,
                &crate::classmem::Proposal::File {
                    parent_id: "root-big".into(),
                    sub_class: None,
                    target_kind: "prompt".into(),
                    target_id: (i + 1).to_string(),
                    note: None,
                    rationale: None,
                },
            )
            .unwrap();
        }
        db.accept_all_pending("yusuf").unwrap();

        let pack = build_answer_pack(&db, Some("Big"), None, ANSWER_PACK_LIMIT);
        let node = pack.node.as_ref().expect("the node resolves");
        assert!(
            node.links.len() <= (ANSWER_PACK_LIMIT * 5).max(20) as usize,
            "the link list must be capped, got {}",
            node.links.len()
        );
        assert!(
            pack.truncated.contains(&"links".to_string()),
            "a capped list is reported, never silently trimmed: {:?}",
            pack.truncated
        );
        let bytes = serde_json::to_vec(&pack).unwrap().len();
        assert!(bytes <= MAX_CONTEXT_BYTES, "{bytes} bytes exceeds the budget");
    }

    #[test]
    fn stats_count_by_surface_and_kind() {
        let db = Database::open_in_memory().unwrap();
        seed_prompt(&db, "pty_plan", None, "one");
        seed_prompt(&db, "pty_plan", None, "two");
        seed_prompt(&db, "browse", None, "three");
        let stats = build_stats(&db);
        assert_eq!(stats.total_prompts, 3);
        // Each prompt also emits a `prompt` ledger event → 3 events.
        assert_eq!(stats.total_events, 3);
        let pty = stats.by_surface.iter().find(|(s, _)| s == "pty_plan").unwrap();
        assert_eq!(pty.1, 2);
        let promptk = stats.by_kind.iter().find(|(k, _)| k == "prompt").unwrap();
        assert_eq!(promptk.1, 3);
    }

    #[test]
    fn un_exported_signal_populates_from_approved_unexported_sessions() {
        use crate::state::{AttachState, ReviewSession, SessionStatus};
        let db = Database::open_in_memory().unwrap();
        let mk = |id: &str, status| ReviewSession {
            session_id: id.to_string(),
            project_path: "/repo".to_string(),
            project_name: "repo".to_string(),
            created_at: 1_000,
            revisions: Vec::new(),
            status,
            attach_state: AttachState::Idle,
            updated_at: 1_000,
            run_state: None,
            backend: None,
            model: None,
        };
        db.upsert_session(&mk("approved-unexported", SessionStatus::Approved)).unwrap();
        db.upsert_session(&mk("approved-exported", SessionStatus::Approved)).unwrap();
        db.upsert_session(&mk("still-in-review", SessionStatus::InReview)).unwrap();
        db.record_plan_export("approved-exported", "session", Some("deadbeef")).unwrap();

        let d = build_digest(&db, clamp_limit(None));
        assert_eq!(d.un_exported.len(), 1, "only the approved, un-exported one");
        assert_eq!(d.un_exported[0].session_id, "approved-unexported");
        // And it renders honestly into the ground-truth block.
        let block = render_digest_prompt_block(&d);
        assert!(block.contains("Un-exported approved plans"));
        assert!(block.contains("approved-unexported"));
    }

    #[test]
    fn session_history_joins_revisions_comments_and_decisions() {
        use crate::state::{AttachState, ReviewSession, SessionStatus};
        let db = Database::open_in_memory().unwrap();
        let sid = "hist-sess";
        db.upsert_session(&ReviewSession {
            session_id: sid.to_string(),
            project_path: "/repo".to_string(),
            project_name: "repo".to_string(),
            created_at: 500,
            revisions: Vec::new(),
            status: SessionStatus::InReview,
            attach_state: AttachState::Idle,
            updated_at: 500,
            run_state: None,
            backend: None,
            model: None,
        })
        .unwrap();
        // A revision row (what `load_all` reads) + its ledger event.
        db.insert_revision(
            sid,
            &crate::state::Revision {
                version_number: 1,
                received_at: 600,
                raw_plan_markdown: "# Plan\n\nDo the thing.".to_string(),
                sections: Vec::new(),
                comments: Vec::new(),
                thread_start: false,
                restored: false,
            },
        )
        .unwrap();
        crate::ledger::record_revision_event(&db, sid, 1, "# Plan\n\nDo the thing.", None).unwrap();
        // A decision event on the session (an approval).
        crate::ledger::record_decision(
            &db,
            crate::ledger::DecisionInput {
                kind: crate::ledger::EventKind::Approval,
                author: Some("yusuf".into()),
                session_id: Some(sid),
                ref_kind: "session",
                ref_id: sid,
                payload_hash: crate::ledger::decision_payload_hash(&[("status", "approved")]),
            },
        )
        .unwrap();

        let h = build_session_history(&db, sid).expect("history for a known session");
        assert_eq!(h.session_id, sid);
        assert_eq!(h.revisions.len(), 1);
        assert_eq!(h.revisions[0].title.as_deref(), Some("Plan"));
        // The approval shows up as a decision event; the revision event does not.
        assert_eq!(h.decision_events.len(), 1);
        assert_eq!(h.decision_events[0].kind, "approval");
        assert!(build_session_history(&db, "no-such-session").is_none());
    }
}
