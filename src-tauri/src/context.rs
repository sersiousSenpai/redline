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

/// Caps keep the digest bounded on a long history (mirrors `code.rs`'s bounds).
pub const MAX_IN_REVIEW: usize = 20;
pub const MAX_BULGING: usize = 8;
pub const MAX_MISSIONS: usize = 12;
pub const MAX_SOURCE_TRUST: usize = 8;
pub const MAX_HELD_PROPOSALS: usize = 20;
/// Cap on the F6 "un-exported approved plan" list (Phase 4).
pub const MAX_UNEXPORTED: usize = 20;
/// Clamp bounds for the route's optional `?limit=` (applies to the ranked lists).
pub const LIMIT_MIN: i64 = 1;
pub const LIMIT_MAX: i64 = 50;

/// Clamp + default for `GET /v1/context/prompts`'s `?limit=`.
pub const PROMPT_LIMIT_MAX: i64 = 200;
/// Byte budget on the `/v1/context/prompts` response (mirrors `code.rs`'s 60KB).
pub const MAX_CONTEXT_BYTES: usize = 60_000;

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
}

/// A queued structural proposal awaiting review (promote/split/merge/collapse).
/// A held `collapse` is the sharp case — destructive and pending a human.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeldProposal {
    pub id: i64,
    pub op: String,
    pub node_id: Option<String>,
    pub title: Option<String>,
    pub rationale: Option<String>,
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
    pub held_proposals: Vec<HeldProposal>,
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

    // Held structural proposals (destructive collapses sort first within the list).
    let mut held_proposals: Vec<HeldProposal> = db
        .list_class_proposals()
        .unwrap_or_default()
        .into_iter()
        .map(|p| HeldProposal {
            id: p.id,
            op: p.op,
            node_id: p.node_id,
            title: p.title,
            rationale: p.rationale,
        })
        .collect();
    held_proposals.sort_by_key(|p| if p.op == "collapse" { 0 } else { 1 });
    held_proposals.truncate(MAX_HELD_PROPOSALS);

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
        },
        held_proposals,
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

/// Filters for `GET /v1/context/prompts` (all optional, ANDed). `substring` is
/// bound as a `LIKE` parameter in `db::list_context_prompts` — never
/// interpolated into SQL — so an injection-shaped `q` can only ever fail to
/// match, never alter the query. `limit` is pre-clamped by `clamp_prompt_limit`.
#[derive(Debug, Clone, Default)]
pub struct PromptFilters {
    pub session_id: Option<String>,
    pub mission_id: Option<String>,
    pub surface: Option<String>,
    pub project: Option<String>,
    pub since_seq: Option<i64>,
    pub substring: Option<String>,
    pub limit: i64,
}

/// Clamp + default `GET /v1/context/prompts`'s `?limit=`.
pub fn clamp_prompt_limit(raw: Option<i64>) -> i64 {
    raw.unwrap_or(PROMPT_LIMIT_MAX).clamp(1, PROMPT_LIMIT_MAX)
}

/// Run a filtered prompt query and enforce the response byte budget. The DB
/// caps each body at 4000 chars already; this additionally drops trailing items
/// once the cumulative body size would exceed `MAX_CONTEXT_BYTES`, so a wide
/// `limit` on long prompts still can't blow up the response.
pub fn list_prompts(db: &Database, filters: &PromptFilters) -> Result<Vec<LakeItem>, String> {
    let mut items = db.list_context_prompts(filters).map_err(|e| e.to_string())?;
    let mut budget = MAX_CONTEXT_BYTES;
    let mut keep = 0usize;
    for it in &items {
        // ~120 bytes of metadata overhead per item + the (truncated) body.
        let cost = 120 + it.body.as_deref().map(str::len).unwrap_or(0);
        if keep > 0 && cost > budget {
            break;
        }
        budget = budget.saturating_sub(cost);
        keep += 1;
    }
    items.truncate(keep);
    Ok(items)
}

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
    let all = db.load_all().ok()?;
    let session = all.get(session_id)?;

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

/// `GET /v1/context/stats` — agent/MCP-facing counts (no UI). Every axis is a
/// `(label, count)` list plus the two grand totals.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextStats {
    pub generated_ts: i64,
    pub total_prompts: i64,
    pub total_events: i64,
    pub by_day: Vec<(String, i64)>,
    pub by_surface: Vec<(String, i64)>,
    pub by_kind: Vec<(String, i64)>,
    pub by_class: Vec<(String, i64)>,
}

/// Build the stats digest. Best-effort per axis (an unmigrated table yields an
/// empty list rather than failing the whole response).
pub fn build_stats(db: &Database) -> ContextStats {
    let by_day = db.prompt_counts_by_day().unwrap_or_default();
    let by_surface = db.prompt_counts_by_surface().unwrap_or_default();
    let by_kind = db.event_counts_by_kind().unwrap_or_default();
    let by_class = db.class_link_counts_by_root().unwrap_or_default();
    let total_prompts = by_surface.iter().map(|(_, c)| c).sum();
    let total_events = db.max_ledger_seq().unwrap_or(0);
    ContextStats {
        generated_ts: now_millis(),
        total_prompts,
        total_events,
        by_day,
        by_surface,
        by_kind,
        by_class,
    }
}

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
        "### Lake stewardship\n- total ledger events: {}\n- last Organize consumed up to seq: {}\n- **unstructured backlog: {}** (events awaiting the next Organize)\n\n",
        d.lake.total_events, d.lake.last_organized_seq, d.lake.backlog
    ));

    p.push_str("### Held structural proposals (destructive collapses first)\n");
    if d.held_proposals.is_empty() {
        p.push_str("- (none queued)\n");
    } else {
        for h in &d.held_proposals {
            p.push_str(&format!(
                "- op={} node={} title={} — {}\n",
                h.op,
                h.node_id.as_deref().unwrap_or("-"),
                h.title.as_deref().unwrap_or("-"),
                h.rationale.as_deref().unwrap_or("no rationale")
            ));
        }
    }
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
        assert!(d.held_proposals.is_empty());
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
            },
            held_proposals: vec![],
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
                role: None,
                session_id: Some(format!("sess-{surface}")),
                claude_session_id: Some(format!("cs-{body}")),
                mission_id: None,
                project_path: project.map(str::to_string),
                body: body.to_string(),
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
        crate::ledger::record_revision_event(&db, sid, 1, "# Plan\n\nDo the thing.").unwrap();
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
