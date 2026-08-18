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

use serde::{Deserialize, Serialize};

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
    /// Memory-by-session filters over the non-hashed provenance columns.
    pub thread_kind: Option<String>,
    pub thread_id: Option<String>,
    pub parent_session_id: Option<String>,
    /// Exact-match filter on the recorded model (`prompts.model`).
    pub model: Option<String>,
    /// Exact corpus-role filter (`user` | `agent` | `system`).
    pub role: Option<String>,
    /// Include `agent` rows — Redline's own constructed prefaces. Off by
    /// default: they are 87% of the corpus by weight and answer nobody's
    /// question, so a caller has to ask for them on purpose. An explicit
    /// `role=agent` overrides this, because then the caller HAS asked.
    pub include_agent: bool,
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
    let keep = budgeted_item_count(items.iter().map(|i| i.body.as_deref()));
    items.truncate(keep);
    Ok(items)
}

/// How many leading items fit in `MAX_CONTEXT_BYTES`, given each one's body.
/// Always at least one (a single oversized item is truncated by the DB layer,
/// not dropped — an empty response would read as "nothing recorded").
///
/// Shared by `/v1/context/prompts` and `/v1/memory/prompts`: an item cap alone
/// is not a bound when one item can be a 40KB page snapshot.
pub fn budgeted_item_count<'a>(bodies: impl Iterator<Item = Option<&'a str>>) -> usize {
    let mut budget = MAX_CONTEXT_BYTES;
    let mut keep = 0usize;
    for body in bodies {
        // ~120 bytes of metadata overhead per item + the (truncated) body.
        let cost = 120 + body.map(str::len).unwrap_or(0);
        if keep > 0 && cost > budget {
            break;
        }
        budget = budget.saturating_sub(cost);
        keep += 1;
    }
    keep
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

/// `GET /v1/context/stats` and the `context_stats` command — shared counts for
/// agents/MCP AND the Memory surface's facet rails and activity ribbon (the
/// old "no dashboard UI" stance was overturned by the Memory-as-a-Second-Brain
/// plan). Every axis is a `(label, count)` list plus the two grand totals.
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
    /// Ledger events per author — the Timeline's actor facet. Meaningful only
    /// since P0 made agents author as their seat name; older rows are uniformly
    /// the local human.
    pub by_author: Vec<(String, i64)>,
}

/// `build_stats` memoized on the ledger head. Five GROUP BY aggregations over
/// the whole lake, and the Memory surface's facet rails re-read them on every
/// `memory-changed` — which a browse capture burst fires repeatedly.
///
/// The head seq is a sound cache key because every axis this counts is derived
/// from a table that appends a ledger event when it changes: a prompt, an
/// event, a class link, an author. Nothing here can move without the head
/// moving, so a hit is never stale.
pub fn build_stats_cached(db: &Database) -> ContextStats {
    use std::sync::{Mutex, OnceLock};
    /// Minimum wall-clock between two rebuilds, ON TOP of the head-seq key.
    ///
    /// The head key alone is exactly wrong during the one situation that
    /// matters: a browse capture burst appends an event per page, so every
    /// poll sees a new head and rebuilds the full five-axis aggregate — the
    /// cache misses hardest precisely when the app is busiest. A 500 ms floor
    /// keeps the numbers live to the eye while collapsing a burst into one
    /// rebuild.
    const DEBOUNCE_MS: i64 = 500;
    static CACHE: OnceLock<Mutex<Option<(i64, i64, ContextStats)>>> = OnceLock::new();
    let cell = CACHE.get_or_init(|| Mutex::new(None));
    let head = db.max_ledger_seq().unwrap_or(0);
    let now = now_millis();
    if let Ok(guard) = cell.lock() {
        if let Some((at, built_ms, stats)) = guard.as_ref() {
            if *at == head || now - *built_ms < DEBOUNCE_MS {
                return stats.clone();
            }
        }
    }
    let fresh = build_stats(db);
    if let Ok(mut guard) = cell.lock() {
        *guard = Some((head, now, fresh.clone()));
    }
    fresh
}

/// Build the stats digest. Best-effort per axis (an unmigrated table yields an
/// empty list rather than failing the whole response).
pub fn build_stats(db: &Database) -> ContextStats {
    let by_day = db.prompt_counts_by_day().unwrap_or_default();
    let by_surface = db.prompt_counts_by_surface().unwrap_or_default();
    let by_kind = db.event_counts_by_kind().unwrap_or_default();
    let by_class = db.class_link_counts_by_root().unwrap_or_default();
    let by_author = db.event_counts_by_author().unwrap_or_default();
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
        by_author,
    }
}

// ---------------------------------------------------------------------------
// Timeline query (the Memory surface's spine)
// ---------------------------------------------------------------------------

/// Clamp + default for the Timeline's page size. Pages are cursor-chained
/// (`before_seq`), so the cap bounds one IPC payload, not the reachable
/// history — unlike `ledger_list_events`' old hard 1,000-row ceiling.
pub const LEDGER_PAGE_MAX: i64 = 500;

/// List-row preview length (chars). The detail rail fetches the full body.
pub const PREVIEW_CHARS: usize = 240;

/// Filters for `db::query_ledger_events` / the `ledger_query` command. All
/// clauses are ANDed; every value is bound, never spliced into SQL. `Default`
/// + `serde(default)` so the frontend sends only the axes it is filtering on.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LedgerFilters {
    /// Exact event kind (`prompt`, `approval`, `browse_event`, …).
    pub kind: Option<String>,
    /// Exact author — the actor facet (`local_author()` or a seat name).
    pub author: Option<String>,
    pub session_id: Option<String>,
    /// Prompt-provenance facets (via the `prompts` join; non-prompt events
    /// never match when one of these is set).
    pub surface: Option<String>,
    pub project: Option<String>,
    /// Substring over the prompt body (gist once compacted) — bound LIKE.
    pub q: Option<String>,
    /// Inclusive ts range, for the activity ribbon's date filter.
    pub since_ts: Option<i64>,
    pub until_ts: Option<i64>,
    /// Cursor: only events with `seq` strictly below this. Pages walk
    /// newest→oldest; the next cursor is the last returned row's `seq`.
    pub before_seq: Option<i64>,
    pub limit: Option<i64>,
    /// Star/note facets (Second Brain P3). Only `true` filters — `false`/absent
    /// means the axis is off, matching how the facet chips toggle.
    pub starred: Option<bool>,
    pub noted: Option<bool>,
    /// Citation focus (Second Brain P4): exact ledger seqs — the Ask agent's
    /// `#seq` chips drive the Timeline here. Empty behaves like absent.
    pub seqs: Option<Vec<i64>>,
    /// Citation focus: only events filed under this accepted class node.
    pub class_node: Option<String>,
    /// Map focus (Second Brain P5): prompts recorded on one agent thread
    /// (`prompts.thread_id` — a linked/drafter/mission/memchat conversation).
    pub thread_id: Option<String>,
    /// Map focus: one browse tab's trail (`browse_events.browse_id`).
    pub browse_id: Option<String>,
    /// Corpus-role facet (`user` | `agent` | `system`). The UI defaults it to
    /// `user`; flipping it is how the reclassified machine text stays visible
    /// rather than merely hidden. Non-prompt events are never excluded by it.
    pub role: Option<String>,
}

pub fn clamp_ledger_limit(raw: Option<i64>) -> i64 {
    raw.unwrap_or(LEDGER_PAGE_MAX).clamp(1, LEDGER_PAGE_MAX)
}

/// One Timeline row: the ledger event plus the read-side provenance the rail
/// renders — prompt columns when the event is a prompt, the browse columns
/// when it is a browse event, and the accepted class filing. All joined at
/// query time; nothing here is stored beyond the existing tables.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineItem {
    #[serde(flatten)]
    pub event: LedgerEventRow,
    pub surface: Option<String>,
    pub project_path: Option<String>,
    pub thread_kind: Option<String>,
    pub model: Option<String>,
    /// First `PREVIEW_CHARS` of the body (gist once compacted) — the list row.
    /// Clipped in SQL, so a 500-row page no longer carries megabytes of body
    /// text across the lock to render 240-character rows. The detail rail
    /// fetches the full text via `ledger_prompt_body`.
    pub preview: Option<String>,
    /// Full length of the text `preview` was clipped from — what makes the
    /// row's "…" honest without shipping the bytes it stands for.
    pub body_chars: Option<i64>,
    /// What kind of text this is (`user` | `agent` | `system`); `None` for a
    /// non-prompt event.
    pub role: Option<String>,
    /// The body was compacted away; `preview` shows the released gist.
    pub compacted: bool,
    pub browse_id: Option<String>,
    pub url: Option<String>,
    pub title: Option<String>,
    /// The browse verb (`navigate | select | submit | leave`).
    pub action: Option<String>,
    pub from_event_id: Option<i64>,
    /// The picture of this page, when there is one. `None` covers three real
    /// states — never captured, policy-denied, and the user forgot it — which
    /// is why it is stored rather than derived from the content hash.
    pub shot_key: Option<String>,
    /// A vision-tier description, for a page whose text didn't capture.
    pub caption: Option<String>,
    /// Accepted class filing (first link), for the class grouping + detail rail.
    pub class_node_id: Option<String>,
    pub class_title: Option<String>,
    /// Second Brain P3: this event is starred (annotated directly, or a `note`
    /// event whose own row is starred).
    pub starred: bool,
    /// The current text of the note ON this event (`user_notes` probe) — the
    /// detail rail's editor seed. `None` when empty/absent.
    pub note: Option<String>,
}

/// Timeline page, newest-first. Thin over `db::query_ledger_events`.
pub fn query_ledger(db: &Database, f: &LedgerFilters) -> Result<Vec<TimelineItem>, String> {
    db.query_ledger_events(f).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Memory map (Second Brain P5)
// ---------------------------------------------------------------------------

/// One Map node. §3 rule 1: nodes are classes and sessions — never raw
/// prompts; prompts appear only as `mass`. Exactly one of the four focus
/// handles is set, and it is what a click filters the Timeline by (§3 rule 4):
/// a class filing, a plan session, a browse tab's trail, or an agent thread.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapNode {
    /// Map keyspace: `class:<node_id>` | `thread:<kind>:<id>`.
    pub id: String,
    /// `class | digest | session | thread`.
    pub kind: String,
    pub label: String,
    /// Classes: filed-link count. Threads: message count. Radius, never dots.
    pub mass: i64,
    /// Same-keyspace structural parent (`contains` for classes, `lineage` for
    /// threads) — the layout prior.
    pub parent_id: Option<String>,
    pub pinned: bool,
    pub project_path: Option<String>,
    pub class_node_id: Option<String>,
    pub session_id: Option<String>,
    pub browse_id: Option<String>,
    pub thread_id: Option<String>,
}

/// One Map edge with DECLARED semantics (§3 rule 3): `contains` (class tree) ·
/// `lineage` (session → threads) · `supersedes` (decision chain, endpoints
/// resolved to their class/session) · `co_occurs` (the only derived edge —
/// classes sharing sessions or a project while filed apart).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapEdge {
    pub kind: String,
    pub from: String,
    pub to: String,
    pub weight: i64,
    /// Human line for the derived/chain edges ("3 shared sessions", "#12 → #40").
    pub basis: Option<String>,
}

/// The `memory_map` command's payload — data only; the deterministic layout is
/// the frontend's pure `memoryMap.ts` (same input → same picture).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryMapView {
    pub generated_ts: i64,
    pub nodes: Vec<MapNode>,
    pub edges: Vec<MapEdge>,
}

/// Assemble the Map: accepted classes + session-tree threads (plus sessions a
/// supersession resolves to), with the four declared edge kinds. Everything is
/// ordered (nodes by id, edges by kind/from/to) so the payload — and therefore
/// the seeded layout downstream — is deterministic. Best-effort per source: a
/// missing table yields empty buckets, never an error (some event kinds may
/// never have fired; the Map must render an honest empty state).
pub fn build_memory_map(db: &Database) -> MemoryMapView {
    use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

    let mut nodes: Vec<MapNode> = Vec::new();
    let mut edges: Vec<MapEdge> = Vec::new();

    // --- classes (accepted only — proposed nodes are not yet on the record) --
    let all_classes = db.list_class_nodes_with_counts().unwrap_or_default();
    let accepted: Vec<&(crate::classmem::ClassNode, i64)> = all_classes
        .iter()
        .filter(|(n, _)| n.status == "accepted")
        .collect();
    let accepted_ids: HashSet<&str> = accepted.iter().map(|(n, _)| n.id.as_str()).collect();
    let mut class_parent: HashMap<&str, &str> = HashMap::new();
    let mut class_project: HashMap<&str, Option<&str>> = HashMap::new();
    for (n, count) in &accepted {
        let parent = n
            .parent_id
            .as_deref()
            .filter(|p| accepted_ids.contains(p));
        if let Some(p) = parent {
            class_parent.insert(n.id.as_str(), p);
            edges.push(MapEdge {
                kind: "contains".into(),
                from: format!("class:{p}"),
                to: format!("class:{}", n.id),
                weight: 1,
                basis: None,
            });
        }
        class_project.insert(n.id.as_str(), n.project_path.as_deref());
        nodes.push(MapNode {
            id: format!("class:{}", n.id),
            kind: if n.kind == "digest" { "digest" } else { "class" }.into(),
            label: n.title.clone(),
            mass: *count,
            parent_id: parent.map(|p| format!("class:{p}")),
            pinned: n.pinned,
            project_path: n.project_path.clone(),
            class_node_id: Some(n.id.clone()),
            session_id: None,
            browse_id: None,
            thread_id: None,
        });
    }

    // --- session tree (lineage) ---------------------------------------------
    let tree_rows = db.list_session_tree_rows().unwrap_or_default();
    let mut threads: BTreeSet<(String, String)> = BTreeSet::new();
    let mut thread_parent: HashMap<(String, String), (String, String)> = HashMap::new();
    for (ck, cid, pk, pid) in &tree_rows {
        threads.insert((ck.clone(), cid.clone()));
        threads.insert((pk.clone(), pid.clone()));
        thread_parent
            .entry((ck.clone(), cid.clone()))
            .or_insert_with(|| (pk.clone(), pid.clone()));
        edges.push(MapEdge {
            kind: "lineage".into(),
            from: format!("thread:{pk}:{pid}"),
            to: format!("thread:{ck}:{cid}"),
            weight: 1,
            basis: None,
        });
    }

    // --- supersedes (decision chain, endpoints mapped per rule 1) -----------
    let pairs = db.list_supersession_pairs().unwrap_or_default();
    let seqs: Vec<i64> = pairs.iter().flat_map(|&(o, n)| [o, n]).collect();
    let endpoints = db.resolve_map_endpoints(&seqs).unwrap_or_default();
    // A decision lands on its class when filed, its session otherwise. A
    // session seen only here still becomes a node — it hosts a decision.
    let resolve = |seq: i64, threads: &mut BTreeSet<(String, String)>| -> Option<String> {
        let (session, class) = endpoints.get(&seq)?;
        if let Some(c) = class.as_deref().filter(|c| accepted_ids.contains(c)) {
            return Some(format!("class:{c}"));
        }
        let sid = session.as_deref()?;
        threads.insert(("session".into(), sid.to_string()));
        Some(format!("thread:session:{sid}"))
    };
    let mut chain: BTreeMap<(String, String), (i64, String)> = BTreeMap::new();
    for (old, new) in &pairs {
        let (Some(from), Some(to)) = (
            resolve(*old, &mut threads),
            resolve(*new, &mut threads),
        ) else {
            continue;
        };
        if from == to {
            continue;
        }
        let entry = chain
            .entry((from, to))
            .or_insert_with(|| (0, format!("#{old} → #{new}")));
        entry.0 += 1;
    }
    for ((from, to), (weight, basis)) in chain {
        edges.push(MapEdge {
            kind: "supersedes".into(),
            from,
            to,
            weight,
            basis: Some(basis),
        });
    }

    // --- thread nodes (labels + message-count mass, resolved per node) ------
    for (kind, id) in &threads {
        let (count, _) = db.thread_stats(kind, id).unwrap_or((0, None));
        let label = db
            .thread_label(kind, id)
            .unwrap_or_else(|| format!("{kind} {}", id.chars().take(8).collect::<String>()));
        let is_session = kind == "session";
        let is_browse = kind == "browse";
        nodes.push(MapNode {
            id: format!("thread:{kind}:{id}"),
            kind: if is_session { "session" } else { "thread" }.into(),
            label,
            mass: count,
            parent_id: thread_parent
                .get(&(kind.clone(), id.clone()))
                .map(|(pk, pid)| format!("thread:{pk}:{pid}")),
            pinned: false,
            project_path: None,
            class_node_id: None,
            session_id: is_session.then(|| id.clone()),
            browse_id: is_browse.then(|| id.clone()),
            thread_id: (!is_session && !is_browse).then(|| id.clone()),
        });
    }

    // --- co-occurs (the one derived edge, opt-in downstream) ----------------
    // Classes sharing sessions (through their accepted links) or a project
    // while filed apart. Direct parent↔child pairs are skipped — `contains`
    // already states that relation; the signal here is UNEXPECTED adjacency.
    let mut sessions_by_class: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    let pairs = db.class_session_pairs().unwrap_or_default();
    for (node, session) in &pairs {
        if accepted_ids.contains(node.as_str()) {
            sessions_by_class
                .entry(node.as_str())
                .or_default()
                .insert(session.as_str());
        }
    }
    let mut class_list: Vec<&str> = accepted_ids.iter().copied().collect();
    class_list.sort_unstable();
    for (i, a) in class_list.iter().enumerate() {
        for b in &class_list[i + 1..] {
            if class_parent.get(a) == Some(b) || class_parent.get(b) == Some(a) {
                continue;
            }
            let shared = match (sessions_by_class.get(a), sessions_by_class.get(b)) {
                (Some(sa), Some(sb)) => sa.intersection(sb).count() as i64,
                _ => 0,
            };
            let same_project = matches!(
                (class_project.get(a), class_project.get(b)),
                (Some(Some(pa)), Some(Some(pb))) if pa == pb
            );
            if shared == 0 && !same_project {
                continue;
            }
            let basis = match (shared, same_project) {
                (0, _) => "shared project".to_string(),
                (n, false) => format!("{n} shared session{}", if n == 1 { "" } else { "s" }),
                (n, true) => format!(
                    "{n} shared session{} · project",
                    if n == 1 { "" } else { "s" }
                ),
            };
            edges.push(MapEdge {
                kind: "co_occurs".into(),
                from: format!("class:{a}"),
                to: format!("class:{b}"),
                weight: shared + i64::from(same_project),
                basis: Some(basis),
            });
        }
    }

    nodes.sort_by(|a, b| a.id.cmp(&b.id));
    edges.sort_by(|a, b| {
        (a.kind.as_str(), a.from.as_str(), a.to.as_str())
            .cmp(&(b.kind.as_str(), b.from.as_str(), b.to.as_str()))
    });
    MemoryMapView {
        generated_ts: now_millis(),
        nodes,
        edges,
    }
}

// ---------------------------------------------------------------------------
// Answer pack — the batched retrieval read
// ---------------------------------------------------------------------------

/// Default `?limit=` on each list inside the answer pack.
pub const ANSWER_PACK_LIMIT: i64 = 20;
/// Clamp on that limit — a caller can widen a list, not unbound it.
pub const ANSWER_PACK_LIMIT_MAX: i64 = 60;

pub fn clamp_answer_pack_limit(raw: Option<i64>) -> i64 {
    raw.unwrap_or(ANSWER_PACK_LIMIT)
        .clamp(1, ANSWER_PACK_LIMIT_MAX)
}

/// One link out of the resolved node, with its label and supersession status
/// resolved — the same `(label, supersededBy)` decoration
/// `GET /v1/memory/node/:id` carries, so an agent reading the pack and an agent
/// reading the node route see one shape.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackLink {
    #[serde(flatten)]
    pub link: crate::classmem::ClassLink,
    pub label: Option<String>,
    /// The decision seq that superseded this link's target (`None` = current).
    pub superseded_by: Option<i64>,
}

/// The resolved node and everything hanging off it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackNode {
    pub node: crate::classmem::ClassNode,
    /// Children to depth 2 — enough for the agent to see where to descend
    /// next without a second call.
    pub children: Vec<crate::classmem::ClassNode>,
    pub grandchildren: Vec<crate::classmem::ClassNode>,
    pub links: Vec<PackLink>,
    pub observations: Vec<crate::classmem::ClassObservation>,
}

/// A matching prompt from the lake, carrying its supersession status so a
/// stale decision can't be read back as current.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackPromptHit {
    #[serde(flatten)]
    pub item: LakeItem,
    pub superseded_by: Option<i64>,
    /// Other hits that collapsed into this one — same body, or the same framing
    /// around a different question. Reported rather than hidden: "four copies"
    /// and "one copy, three duplicates suppressed" are different facts about
    /// the record, and the second is the true one.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub duplicate_of: Vec<i64>,
    /// Which stage of the query cascade found this: `and` (every term present)
    /// or `or` (widened) or `like` (substring fallback).
    pub stage: String,
    /// Every arm that found this hit, with its rank and score there. A hit
    /// found by two arms is stronger evidence than one found by either alone,
    /// and a `semantic`-only hit is *associated* rather than asserted — see
    /// [`Arm`] for the trust ordering.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub arms: Vec<ArmHit>,
}

/// One batched read that answers most memory questions: the resolved class
/// node with its subtree, links and observations, plus the user's own matching
/// notes, matching prompts from the lake and matching pages from the browse
/// stream.
///
/// It exists to collapse a 5–7 turn retrieval walk into ONE tool call. Which
/// is why the miss path is a design requirement, not a nicety: `promptHits`,
/// `browseHits` and `matchedNodes` are always populated from the query text,
/// even when node resolution fails outright or a caller passes a stale
/// `?node=`. A resolution miss must still hand back lexical evidence — never
/// an empty pack that pushes the agent back into the walk it was built to
/// replace.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerPack {
    /// The ledger head this pack was assembled at — the agent cites against it.
    pub head_seq: i64,
    pub query: Option<String>,
    /// `None` when nothing resolved; the lexical hits below still stand.
    pub node: Option<PackNode>,
    /// Runners-up from node resolution, so the agent can redirect in one step.
    pub matched_nodes: Vec<crate::classmem::ClassNode>,
    /// The user's own words — FIRST, and the last thing the budget trims.
    pub notes: Vec<UserNote>,
    pub prompt_hits: Vec<PackPromptHit>,
    pub browse_hits: Vec<crate::db::BrowseHit>,
    /// Literal/regex hits. Present only when the question LOOKS like it is
    /// reaching for a literal (a flag, a path, an identifier, a quoted phrase)
    /// — a trigram probe on every natural-language question would cost an index
    /// scan to return noise.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub grep_hits: Vec<crate::db::GrepHit>,
    /// Which arms ran, and what each returned. Read this before concluding
    /// anything from an empty list: an arm that did not run is ABSENT, which is
    /// a fact about the index rather than about the user's history.
    pub arm_coverage: Vec<ArmCoverage>,
    /// Which lists the byte budget cut, so the agent knows to narrow rather
    /// than conclude the record is empty.
    pub truncated: Vec<String>,
}

/// Assemble the pack. Every list is bounded by `limit`, and the whole response
/// is bounded by `MAX_CONTEXT_BYTES` — trimming links, then prompt hits, then
/// browse hits, and the user's notes only if nothing else is left to give.
pub fn build_answer_pack(
    db: &Database,
    q: Option<&str>,
    node_id: Option<&str>,
    limit: i64,
) -> AnswerPack {
    let head_seq = db.max_ledger_seq().unwrap_or(0);
    let query = q.map(str::trim).filter(|s| !s.is_empty());

    // --- resolve a node: the explicit id first, then the best title match ---
    let mut matched: Vec<crate::classmem::ClassNode> = query
        .map(|term| db.match_class_nodes(term, limit).unwrap_or_default())
        .unwrap_or_default();
    let resolved = node_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(|id| db.get_class_node(id).ok().flatten())
        // A stale `?node=` falls through to the best lexical match rather than
        // returning nothing — the miss path.
        .or_else(|| matched.first().cloned());
    if let Some(r) = &resolved {
        matched.retain(|n| n.id != r.id);
    }

    // Per-list ceilings applied BEFORE the byte budget. A bulging class can
    // hold thousands of links, and feeding all of them into a trim loop that
    // re-serializes per dropped item is quadratic on exactly the nodes most
    // worth asking about. The budget below still has the final say.
    let node_cap = (limit * 5).max(20) as usize;
    let mut over_cap: Vec<&str> = Vec::new();
    let node = resolved.map(|node| {
        let mut children = db.list_class_children(&node.id).unwrap_or_default();
        // ONE query for the whole generation, not one per child — the same
        // N+1 the Timeline's filing probe had, in the route that is supposed
        // to be the fast one. A node with 40 children cost 40 round trips
        // through the connection lock to build a list the pack then caps.
        // (`link_previews_for_seqs` is the idiom.)
        let child_ids: Vec<String> = children.iter().map(|c| c.id.clone()).collect();
        let mut grandchildren = db.list_class_children_for_parents(&child_ids).unwrap_or_default();
        if children.len() > node_cap {
            children.truncate(node_cap);
            over_cap.push("children");
        }
        if grandchildren.len() > node_cap {
            grandchildren.truncate(node_cap);
            over_cap.push("grandchildren");
        }
        let mut raw_links = db.list_class_links_for_node(&node.id).unwrap_or_default();
        if raw_links.len() > node_cap {
            raw_links.truncate(node_cap);
            over_cap.push("links");
        }
        let ledger_seq = |l: &crate::classmem::ClassLink| -> Option<i64> {
            matches!(l.target_kind.as_str(), "prompt" | "decision" | "ledger")
                .then(|| l.target_id.trim().parse().ok())
                .flatten()
        };
        let seqs: Vec<i64> = raw_links.iter().filter_map(ledger_seq).collect();
        // Two batched reads for the whole link set, not two per link.
        let labels = db.link_previews_for_seqs(&seqs).unwrap_or_default();
        let superseded = db.supersessions_for_seqs(&seqs).unwrap_or_default();
        let links: Vec<PackLink> = raw_links
            .into_iter()
            .map(|link| {
                let seq = ledger_seq(&link);
                PackLink {
                    label: seq.and_then(|s| labels.get(&s).cloned()),
                    superseded_by: seq.and_then(|s| superseded.get(&s).copied()),
                    link,
                }
            })
            .collect();
        let mut observations = db.list_class_observations(&node.id, false).unwrap_or_default();
        if observations.len() > node_cap {
            observations.truncate(node_cap);
            over_cap.push("observations");
        }
        PackNode { node, children, grandchildren, links, observations }
    });

    // --- lexical evidence: always produced, node or no node ---
    let notes = query
        .map(|term| db.search_user_notes(term, limit).unwrap_or_default())
        .unwrap_or_default();
    let plan = query.and_then(crate::query::plan_fts_query);
    let terms: Vec<String> = plan.as_ref().map(|p| p.terms.clone()).unwrap_or_default();

    let mut ranked = query
        .map(|term| {
            db.search_prompts_ranked(term, limit).unwrap_or_else(|e| {
                tracing::warn!(error = %e, "answer-pack: prompt search failed");
                Vec::new()
            })
        })
        .unwrap_or_default();

    // --- the semantic arm, and the FUSE the pipeline is named for ------------
    //
    // The arm reaches what shares no words with the question. It runs last and
    // it never replaces the lexical ordering — RRF fuses the two, so a hit both
    // arms found rises and a hit only one found still appears.
    //
    // Its absence is a first-class state: `provider_kind() == Absent` means no
    // on-device model (or a macOS below 14 with no sentence fallback either),
    // and the pack SAYS so rather than returning a short list that reads as an
    // empty history.
    let semantic = query.and_then(|term| {
        crate::embed::semantic_search(db, term, (limit * 3).max(24) as usize)
    });
    let semantic_prompt_hits: Vec<(i64, f64)> = semantic
        .as_ref()
        .map(|hits| {
            hits.iter()
                .filter(|h| h.target_kind == "prompt")
                .map(|h| (h.target_id, h.score as f64))
                .collect()
        })
        .unwrap_or_default();

    // Fuse the two prompt rankings. Keys are ledger seqs for the lexical arm
    // and prompt ids for the semantic one, so the semantic ids are resolved to
    // seqs first — a fusion over two different id-spaces would silently agree
    // with itself about nothing.
    let arms_by_seq: std::collections::HashMap<i64, Vec<ArmHit>> = if semantic_prompt_hits.is_empty()
    {
        std::collections::HashMap::new()
    } else {
        let ids: Vec<i64> = semantic_prompt_hits.iter().map(|(id, _)| *id).collect();
        let seq_of = db.seqs_for_prompt_ids(&ids).unwrap_or_default();
        let lexical: Vec<(String, f64)> = ranked
            .iter()
            .enumerate()
            .map(|(i, (it, _))| (it.seq.to_string(), -(i as f64)))
            .collect();
        let sem: Vec<(String, f64)> = semantic_prompt_hits
            .iter()
            .filter_map(|(id, s)| seq_of.get(id).map(|seq| (seq.to_string(), *s)))
            .collect();
        let fused = rrf_fuse(&[(Arm::Lexical, lexical), (Arm::Semantic, sem)]);

        // Reorder the lexical results by the fused score, then append any
        // semantic-only hits the lexical arm never saw. Appending rather than
        // interleaving is deliberate: a hit no term matched is weaker evidence
        // and should not displace one that did.
        let order: std::collections::HashMap<i64, usize> = fused
            .iter()
            .enumerate()
            .filter_map(|(rank, (k, _, _))| k.parse::<i64>().ok().map(|s| (s, rank)))
            .collect();
        ranked.sort_by_key(|(it, _)| order.get(&it.seq).copied().unwrap_or(usize::MAX));

        let known: std::collections::HashSet<i64> = ranked.iter().map(|(it, _)| it.seq).collect();
        let extra: Vec<i64> = fused
            .iter()
            .filter_map(|(k, _, _)| k.parse::<i64>().ok())
            .filter(|s| !known.contains(s))
            .take(limit as usize)
            .collect();
        if !extra.is_empty() {
            if let Ok(items) = db.lake_items_for_seqs(&extra) {
                ranked.extend(items.into_iter().map(|it| (it, crate::query::MatchStage::Or)));
            }
        }
        fused
            .into_iter()
            .filter_map(|(k, arms, _)| k.parse::<i64>().ok().map(|s| (s, arms)))
            .collect()
    };

    // fuse → DEDUP → CLIP → budget. The order is the fix: deduplicating after
    // clipping cannot work, because a head clip makes near-duplicates
    // byte-identical and clipping to a fixed 4,000 makes the budget's job
    // impossible. The live probe returned four copies of one preface and then
    // dropped every browse hit to fit them.
    let prompt_hits = {
        let bodies: Vec<String> = ranked
            .iter()
            .map(|(it, _)| it.body.clone().unwrap_or_default())
            .collect();
        let cands: Vec<crate::dedup::Candidate<'_>> = ranked
            .iter()
            .zip(bodies.iter())
            .map(|((it, _), body)| crate::dedup::Candidate {
                key: it.seq,
                // The lake's own exact-identity key, already stored and indexed.
                exact_hash: None,
                text: body.as_str(),
            })
            .collect();
        let verdicts = crate::dedup::dedup(&cands);
        let survivors: Vec<usize> = verdicts
            .iter()
            .enumerate()
            .filter(|(_, v)| matches!(v, crate::dedup::Verdict::Keep { .. }))
            .map(|(i, _)| i)
            .collect();
        // Per-hit budget is computed over the SURVIVORS, so suppressing
        // duplicates buys the remaining hits more room rather than less.
        let per_hit = crate::dedup::per_hit_budget(MAX_CONTEXT_BYTES, survivors.len());
        let hit_seqs: Vec<i64> = survivors.iter().map(|i| ranked[*i].0.seq).collect();
        let hit_superseded = db.supersessions_for_seqs(&hit_seqs).unwrap_or_default();
        survivors
            .into_iter()
            .map(|i| {
                let (item, stage) = ranked[i].clone();
                let absorbed = match &verdicts[i] {
                    crate::dedup::Verdict::Keep { absorbed } => absorbed.clone(),
                    crate::dedup::Verdict::Duplicate { .. } => Vec::new(),
                };
                let mut item = item;
                item.body = item
                    .body
                    .map(|b| crate::dedup::excerpt_around(&b, &terms, per_hit));
                PackPromptHit {
                    superseded_by: hit_superseded.get(&item.seq).copied(),
                    duplicate_of: absorbed,
                    stage: stage.as_str().to_string(),
                    arms: arms_by_seq.get(&item.seq).cloned().unwrap_or_default(),
                    item,
                }
            })
            .collect::<Vec<_>>()
    };

    // Browse events carry their own exact-identity key — `context_hash`, the
    // sha256 of the normalized DOM — and 20% of them are exact duplicates today
    // (829 rows, 665 distinct). Revisiting a page is a real signal about
    // attention, but four identical copies of it are not four pieces of evidence.
    let browse_hits = {
        let raw = query
            .map(|term| db.search_browse_events(term, limit).unwrap_or_default())
            .unwrap_or_default();
        let hashes = db
            .context_hashes_for_browse_ids(&raw.iter().map(|h| h.id).collect::<Vec<_>>())
            .unwrap_or_default();
        let texts: Vec<String> = raw
            .iter()
            .map(|h| format!("{} {}", h.title.clone().unwrap_or_default(), h.url))
            .collect();
        let cands: Vec<crate::dedup::Candidate<'_>> = raw
            .iter()
            .zip(texts.iter())
            .map(|(h, t)| crate::dedup::Candidate {
                key: h.seq.unwrap_or(h.id),
                exact_hash: hashes.get(&h.id).map(String::as_str),
                text: t.as_str(),
            })
            .collect();
        let verdicts = crate::dedup::dedup(&cands);
        raw.into_iter()
            .zip(verdicts.iter())
            .filter(|(_, v)| matches!(v, crate::dedup::Verdict::Keep { .. }))
            .map(|(h, _)| h)
            .collect::<Vec<_>>()
    };

    // The grep arm runs only when the question reaches for a literal. Its
    // needle is the longest quoted phrase, else the longest term — the most
    // specific thing the user actually typed.
    let literal_query = matches!((&plan, query), (Some(p), Some(raw)) if crate::query::looks_literal(p, raw));
    let grep_hits = match (&plan, query) {
        (Some(plan), Some(raw)) if crate::query::looks_literal(plan, raw) => {
            let needle = plan
                .phrases
                .iter()
                .chain(plan.terms.iter())
                .max_by_key(|t| t.chars().count())
                .cloned()
                .unwrap_or_default();
            db.grep_memory(&needle, None, false, crate::db::GrepScope::All, limit)
                .unwrap_or_default()
        }
        _ => Vec::new(),
    };

    // Every arm reports whether it RAN, not just what it returned.
    let arm_coverage = vec![
        ArmCoverage {
            arm: Arm::Node,
            ran: query.is_some() || node_id.is_some(),
            hits: usize::from(node.is_some()) + matched.len(),
            absent_because: None,
        },
        ArmCoverage {
            arm: Arm::Note,
            ran: query.is_some(),
            hits: notes.len(),
            absent_because: None,
        },
        ArmCoverage {
            arm: Arm::Lexical,
            ran: query.is_some(),
            hits: prompt_hits.len() + browse_hits.len(),
            absent_because: None,
        },
        ArmCoverage {
            arm: Arm::Grep,
            ran: !grep_hits.is_empty() || literal_query,
            hits: grep_hits.len(),
            absent_because: (!literal_query).then(|| {
                "the question doesn't name a literal (a flag, a path, an identifier)".to_string()
            }),
        },
        ArmCoverage {
            arm: Arm::Semantic,
            ran: semantic.is_some(),
            hits: semantic.as_ref().map(Vec::len).unwrap_or(0),
            absent_because: semantic.is_none().then(|| {
                match crate::embed::provider_kind() {
                    crate::embed::ProviderKind::Absent => {
                        "no on-device embedding provider is available".to_string()
                    }
                    _ => "the semantic index is not built yet".to_string(),
                }
            }),
        },
    ];

    let mut pack = AnswerPack {
        head_seq,
        query: query.map(str::to_string),
        node,
        matched_nodes: matched,
        notes,
        prompt_hits,
        browse_hits,
        grep_hits,
        arm_coverage,
        truncated: over_cap.into_iter().map(str::to_string).collect(),
    };
    enforce_pack_budget(&mut pack);
    pack
}

/// Trim the pack to `MAX_CONTEXT_BYTES` without ever letting one arm's results
/// erase another's.
///
/// The old rule was "drop whole lists in a fixed order, cheapest first", and it
/// had a failure mode the live probe hit exactly: browse hits were first in the
/// order, so a pack bloated by four copies of one preface dropped **every
/// page** before touching a single prompt. The user's question was answered
/// from one kind of evidence because the other kind was cheaper to delete.
///
/// The rule now: **every arm that produced anything keeps at least one hit.**
/// Above that floor, arms are trimmed in the same priority order (the user's
/// own notes dead last — they are the one human-authored signal), still in
/// proportional chunks, because each `size()` call re-serializes the pack and a
/// pop-one loop over a long list would be quadratic on exactly the biggest
/// packs. That chunking reasoning was sound and is kept verbatim.
///
/// An arm reduced to its floor is still reported in `truncated`: "one of many"
/// and "one, that's all there was" are different answers.
fn enforce_pack_budget(pack: &mut AnswerPack) {
    fn size(p: &AnswerPack) -> usize {
        serde_json::to_vec(p).map(|v| v.len()).unwrap_or(0)
    }
    if size(pack) <= MAX_CONTEXT_BYTES {
        return;
    }
    type Len = fn(&AnswerPack) -> usize;
    type Drop = fn(&mut AnswerPack, usize);
    /// Every arm that produced at least one hit keeps at least this many.
    const ARM_FLOOR: usize = 1;

    let steps: [(&str, Len, Drop); 5] = [
        ("browseHits", |p| p.browse_hits.len(), |p, n| {
            let keep = p.browse_hits.len().saturating_sub(n);
            p.browse_hits.truncate(keep);
        }),
        ("promptHits", |p| p.prompt_hits.len(), |p, n| {
            let keep = p.prompt_hits.len().saturating_sub(n);
            p.prompt_hits.truncate(keep);
        }),
        ("links", |p| p.node.as_ref().map(|n| n.links.len()).unwrap_or(0), |p, n| {
            if let Some(node) = p.node.as_mut() {
                let keep = node.links.len().saturating_sub(n);
                node.links.truncate(keep);
            }
        }),
        ("grepHits", |p| p.grep_hits.len(), |p, n| {
            let keep = p.grep_hits.len().saturating_sub(n);
            p.grep_hits.truncate(keep);
        }),
        ("notes", |p| p.notes.len(), |p, n| {
            let keep = p.notes.len().saturating_sub(n);
            p.notes.truncate(keep);
        }),
    ];

    // Pass one: trim every arm down towards its floor, in priority order.
    for (name, len, drop) in steps {
        let mut cut = false;
        while size(pack) > MAX_CONTEXT_BYTES && len(pack) > ARM_FLOOR {
            let over = len(pack) - ARM_FLOOR;
            drop(pack, (over / 4).max(1).min(over));
            cut = true;
        }
        if cut && !pack.truncated.iter().any(|t| t == name) {
            pack.truncated.push(name.to_string());
        }
        if size(pack) <= MAX_CONTEXT_BYTES {
            return;
        }
    }

    // Pass two: still over budget with every arm at its floor. Now the floor
    // itself has to give — but only after every arm has been reduced to it, so
    // what is lost is spread across the evidence rather than taken entirely
    // from whichever arm happened to sort first.
    for (name, len, drop) in steps {
        while size(pack) > MAX_CONTEXT_BYTES && len(pack) > 0 {
            drop(pack, 1);
            if !pack.truncated.iter().any(|t| t == name) {
                pack.truncated.push(name.to_string());
            }
        }
        if size(pack) <= MAX_CONTEXT_BYTES {
            return;
        }
    }
}

// ---------------------------------------------------------------------------
// Arms and fusion
// ---------------------------------------------------------------------------

/// Which retrieval arm produced a hit. This is the auditability half of what
/// replaced "no embedding model enters the product": a reader can always tell
/// what KIND of evidence they are looking at.
///
/// The trust ordering is real and is stated in the retrieval contract:
/// - `Node` — **curated**. A human accepted this class. It outranks everything.
/// - `Note` — the user's own margin words. Human-authored, quoted verbatim.
/// - `Lexical` — the terms are literally present.
/// - `Grep` — an exact string match, with no relevance claim beyond "it's here".
/// - `Semantic` — **associated**, not asserted. A vector said these are alike.
///   A `Semantic`-only hit must be verified before being stated as fact.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Arm {
    Node,
    Note,
    Lexical,
    Grep,
    Semantic,
}

impl Arm {
    pub fn as_str(self) -> &'static str {
        match self {
            Arm::Node => "node",
            Arm::Note => "note",
            Arm::Lexical => "lexical",
            Arm::Grep => "grep",
            Arm::Semantic => "semantic",
        }
    }
}

/// One arm's contribution to a hit: which arm, where it ranked, what it scored.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArmHit {
    pub arm: Arm,
    pub rank: usize,
    pub score: f64,
}

/// Reciprocal Rank Fusion's smoothing constant. 60 is the value from the
/// original paper and it is not a tuning dial here: it flattens the difference
/// between rank 1 and rank 2 enough that one arm's confident-but-wrong top hit
/// cannot dominate three other arms' agreement.
pub const RRF_K: f64 = 60.0;

/// Fuse ranked lists into one ordering by Reciprocal Rank Fusion.
///
/// RRF over score-normalization deliberately: the arms' scores are not
/// commensurable — bm25 is unbounded and negative-is-better, cosine is [-1,1],
/// and a grep hit has no score at all. Ranks are the only thing they share.
///
/// Returns each key with the arms that found it, ordered by fused score.
pub fn rrf_fuse(lists: &[(Arm, Vec<(String, f64)>)]) -> Vec<(String, Vec<ArmHit>, f64)> {
    let mut fused: std::collections::HashMap<String, (Vec<ArmHit>, f64)> =
        std::collections::HashMap::new();
    for (arm, hits) in lists {
        for (rank, (key, score)) in hits.iter().enumerate() {
            let contribution = 1.0 / (RRF_K + (rank + 1) as f64);
            let e = fused.entry(key.clone()).or_insert_with(|| (Vec::new(), 0.0));
            e.0.push(ArmHit { arm: *arm, rank: rank + 1, score: *score });
            e.1 += contribution;
        }
    }
    let mut out: Vec<(String, Vec<ArmHit>, f64)> =
        fused.into_iter().map(|(k, (arms, s))| (k, arms, s)).collect();
    // Deterministic: fused score desc, then key — never wall-clock or hash order.
    out.sort_by(|a, b| {
        b.2.partial_cmp(&a.2)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });
    out
}

/// Which arms ran and what each returned — so an empty result reads as "the
/// semantic index isn't built yet" rather than "you never thought about this".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArmCoverage {
    pub arm: Arm,
    /// `true` when the arm ran at all. A `false` here is the honest third
    /// state: absent, not empty.
    pub ran: bool,
    pub hits: usize,
    /// Why it did not run, when it did not.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub absent_because: Option<String>,
}

// ---------------------------------------------------------------------------
// Inline prefetch rendering (one-turn Ask)
// ---------------------------------------------------------------------------

/// Byte ceiling for the prefetched-evidence block baked into an Ask prompt.
/// Sized against `classmem::CATALOG_SNAPSHOT_MAX_BYTES`, which rides in the
/// same prompt: prototyped over the live pack (`q=browser&limit=8`, 400-char
/// bodies, one line per link) the render came to ~6 KB, so 12 KB is headroom
/// rather than a target.
pub const INLINE_PACK_MAX_BYTES: usize = 12_000;
/// Hits per arm in a prefetch — deliberately below `ANSWER_PACK_LIMIT`. The
/// prefetch is a first look, not the whole record; the agent can still curl for
/// more, and the block tells it when that is worth doing.
pub const INLINE_PACK_LIMIT: i64 = 8;
/// Per-hit body window in the inline render, against the DB layer's 4,000. Eight
/// hits at 4,000 would be the whole budget spent on one arm.
pub const INLINE_BODY_CHARS: usize = 400;

/// Render an answer pack as the compact evidence block that rides inside an Ask
/// prompt, or `None` when there is nothing honest to say.
///
/// **`None` is a real answer here.** An empty block is strictly worse than
/// silence: it reads to the model as "the record was searched and is empty",
/// which is a claim about the user's history rather than about the query. So a
/// query with no terms ("what can you do?") and a pack where every arm came
/// back empty both render nothing at all, and the agent falls through to its
/// normal retrieval — which is exactly today's behaviour, i.e. the downside of
/// a prefetch miss is bounded at the status quo.
///
/// The block is **honest about itself**, and that is what makes the escape
/// hatch safe. It names the terms that were searched, the basis on which a node
/// resolved, and any list that was trimmed — so the model can tell "the record
/// is empty on this" from "the prefetch looked in the wrong place", and knows
/// when curling is worth a turn. Without that distinction a prefetch is just a
/// confident way to be wrong.
pub fn render_answer_pack_block(
    pack: &AnswerPack,
    plan: Option<&crate::query::FtsPlan>,
    max_bytes: usize,
) -> Option<String> {
    let terms: Vec<String> = plan.map(|p| p.terms.clone()).unwrap_or_default();
    if terms.is_empty() && plan.map(|p| p.phrases.is_empty()).unwrap_or(true) {
        return None;
    }
    let empty = pack.node.is_none()
        && pack.notes.is_empty()
        && pack.prompt_hits.is_empty()
        && pack.browse_hits.is_empty()
        && pack.grep_hits.is_empty();
    if empty {
        return None;
    }

    let mut out = String::with_capacity(2048);
    out.push_str(&format!(
        "PREFETCHED EVIDENCE — assembled server-side from your question at seq {}.\n",
        pack.head_seq
    ));
    out.push_str(&format!("Searched: {}.\n", terms.join(", ")));
    if let Some(node) = &pack.node {
        // Say WHY it resolved. "Resolved: [[X]]" alone is an assertion; naming
        // the term that matched lets the model notice a wrong turn.
        let basis = terms
            .iter()
            .find(|t| node.node.title.to_lowercase().contains(t.as_str()))
            .map(|t| format!(" (matched \"{t}\" in the title)"))
            .unwrap_or_default();
        out.push_str(&format!("Resolved: [[{}]]{basis}.\n", node.node.title));
    } else {
        out.push_str("Resolved: no class matched — the lexical evidence below still stands.\n");
    }
    if !pack.truncated.is_empty() {
        out.push_str(&format!("TRIMMED: {}.\n", pack.truncated.join(", ")));
    }
    out.push_str(
        "If this answers the question, ANSWER — do not curl.\n\
         Curl the answer-pack ONLY when this block is empty on the subject you need, names \
         a node you want to descend into, or says it was TRIMMED.\n\n",
    );

    // The user's own words lead, exactly as in the pack itself.
    if !pack.notes.is_empty() {
        out.push_str("YOUR NOTES (human-authored — quote verbatim):\n");
        for n in &pack.notes {
            let star = if n.starred { "★ " } else { "" };
            out.push_str(&format!(
                "- {star}#{} {}\n",
                n.seq.unwrap_or(0),
                clip_line(&n.text, INLINE_BODY_CHARS)
            ));
        }
        out.push('\n');
    }
    if let Some(node) = &pack.node {
        if !node.children.is_empty() {
            let kids: Vec<&str> = node.children.iter().map(|c| c.title.as_str()).collect();
            out.push_str(&format!("Children of [[{}]]: {}\n\n", node.node.title, kids.join(" · ")));
        }
        if !node.links.is_empty() {
            out.push_str("FILED UNDER IT:\n");
            for l in &node.links {
                let sup = l
                    .superseded_by
                    .map(|s| format!(" [superseded by #{s}]"))
                    .unwrap_or_default();
                out.push_str(&format!(
                    "- #{} {}{sup}\n",
                    l.link.target_id,
                    clip_line(l.label.as_deref().unwrap_or("(no preview)"), 160)
                ));
            }
            out.push('\n');
        }
        if !node.observations.is_empty() {
            out.push_str("OBSERVATIONS (patterns, not facts — label them as such):\n");
            for o in &node.observations {
                out.push_str(&format!("- {}\n", clip_line(&o.summary, 200)));
            }
            out.push('\n');
        }
    }
    if !pack.prompt_hits.is_empty() {
        out.push_str("PROMPTS:\n");
        for h in &pack.prompt_hits {
            let sup = h
                .superseded_by
                .map(|s| format!(" [superseded by #{s}]"))
                .unwrap_or_default();
            let dupes = if h.duplicate_of.is_empty() {
                String::new()
            } else {
                format!(" [+{} near-identical]", h.duplicate_of.len())
            };
            // Name the arms. A hit two arms found is stronger evidence than one
            // either found alone, and a `semantic`-only hit is *associated*
            // rather than asserted — the reader can only weigh that if it says.
            let arms = if h.arms.is_empty() {
                String::new()
            } else {
                format!(
                    " ({})",
                    h.arms.iter().map(|a| a.arm.as_str()).collect::<Vec<_>>().join("+")
                )
            };
            out.push_str(&format!(
                "- #{}{sup}{dupes}{arms} {}\n",
                h.item.seq,
                clip_line(h.item.body.as_deref().unwrap_or(""), INLINE_BODY_CHARS)
            ));
        }
        out.push('\n');
    }
    if !pack.browse_hits.is_empty() {
        out.push_str("PAGES:\n");
        for b in &pack.browse_hits {
            out.push_str(&format!(
                "- #{} {} — {}\n",
                b.seq.unwrap_or(0),
                clip_line(b.title.as_deref().unwrap_or(""), 100),
                b.url
            ));
        }
        out.push('\n');
    }
    if !pack.grep_hits.is_empty() {
        out.push_str("LITERAL MATCHES:\n");
        for g in &pack.grep_hits {
            out.push_str(&format!(
                "- #{} {} {}\n",
                g.seq.unwrap_or(0),
                g.label,
                clip_line(&g.excerpt, 160)
            ));
        }
        out.push('\n');
    }

    // Clip at a line boundary, and SAY the block was clipped — a silently
    // truncated evidence block is the same lie as a silently truncated pack.
    if out.len() > max_bytes {
        let cut = out
            .char_indices()
            .take_while(|(i, _)| *i < max_bytes.saturating_sub(80))
            .map(|(i, _)| i)
            .last()
            .unwrap_or(0);
        let cut = out[..cut].rfind('\n').unwrap_or(cut);
        out.truncate(cut);
        out.push_str("\n[prefetch clipped to fit — curl the answer-pack for the rest]\n");
    }
    Some(out)
}

/// One line, newlines flattened, clipped with an ellipsis.
fn clip_line(s: &str, max: usize) -> String {
    let one = s.replace('\n', " ");
    if one.chars().count() <= max {
        one
    } else {
        one.chars().take(max).collect::<String>() + "…"
    }
}

/// The ticker line for a prefetched turn. `retrieval_status_label` narrates
/// curls, and a prefetched turn makes none — so without this the surface would
/// sit silent through the one part of the turn that used to show progress.
///
/// It reports a RESULT where the old ticker reported an ACTIVITY: "read
/// Embedded browser + 16 items…" rather than "searching your memory…".
pub fn prefetch_status_label(node: Option<&str>, hits: usize) -> String {
    match (node, hits) {
        (Some(title), 0) => format!("read {title}…"),
        (Some(title), n) => format!("read {title} + {n} items…"),
        (None, 0) => "nothing matched — asking anyway…".to_string(),
        (None, n) => format!("read {n} items…"),
    }
}

/// One user note/star row (`user_notes`) — the readable, current-state side of
/// `note` ledger events (Second Brain P3). Serialized camelCase for the Memory
/// surface.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserNote {
    pub id: i64,
    /// Latest `note` ledger event seq that touched this row.
    pub seq: Option<i64>,
    /// `ledger_event | class_node | session | none` (standalone thought).
    pub target_kind: String,
    pub target_id: Option<String>,
    pub text: String,
    pub starred: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One note-write act from the surface. Exactly ONE of `text` / `starred` per
/// call — each act appends exactly one `note` ledger event, so the record
/// stays one-act-one-event. `noteId` addresses a specific row (standalone
/// edits); otherwise the row is resolved (or created) by target.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NoteWrite {
    pub note_id: Option<i64>,
    /// Defaults to `none` (a standalone note) when absent.
    pub target_kind: Option<String>,
    pub target_id: Option<String>,
    pub text: Option<String>,
    pub starred: Option<bool>,
}

/// What a note-write did — the `SupersessionOutcome` shape: rejections are
/// data, not errors, and a no-op is explicit (it must append NO event).
#[derive(Debug)]
pub enum NoteOutcome {
    /// The act applied; one `note` ledger event was appended.
    Written(UserNote),
    /// Nothing changed (same text / same star) — no event appended.
    Unchanged(UserNote),
    Rejected(String),
}

/// One session-tree node with its parent and child digests — shared by
/// `GET /v1/context/tree/:kind/:id` AND the `context_thread_tree` command
/// (same assembly, two thin callers, so route and GUI can't drift).
pub fn build_thread_tree(db: &Database, kind: &str, id: &str) -> serde_json::Value {
    let parent = db.session_tree_parent(kind, id).ok().flatten();
    let children = db.session_tree_children(kind, id).unwrap_or_default();
    let child_digests: Vec<serde_json::Value> = children
        .into_iter()
        .map(|(ck, cid, created_at)| {
            let (count, last_ts) = db.thread_stats(&ck, &cid).unwrap_or((0, None));
            serde_json::json!({
                "kind": ck,
                "id": cid,
                "label": db.thread_label(&ck, &cid),
                "createdAt": created_at,
                "messageCount": count,
                "lastTs": last_ts,
            })
        })
        .collect();
    let (count, last_ts) = db.thread_stats(kind, id).unwrap_or((0, None));
    serde_json::json!({
        "node": {
            "kind": kind,
            "id": id,
            "label": db.thread_label(kind, id),
            "messageCount": count,
            "lastTs": last_ts,
        },
        "parent": parent.map(|(pk, pid)| serde_json::json!({
            "kind": pk,
            "id": pid,
            "label": db.thread_label(&pk, &pid),
        })),
        "children": child_digests,
    })
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
        db.accept_class_node(id).unwrap();
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

    /// The ticker reports a RESULT where the old one reported an ACTIVITY.
    #[test]
    fn prefetch_status_reports_what_was_read() {
        assert_eq!(
            prefetch_status_label(Some("Embedded browser"), 16),
            "read Embedded browser + 16 items…"
        );
        assert_eq!(prefetch_status_label(Some("Voice agent"), 0), "read Voice agent…");
        assert_eq!(prefetch_status_label(None, 4), "read 4 items…");
        // The honest empty case — never a silent ticker.
        assert_eq!(prefetch_status_label(None, 0), "nothing matched — asking anyway…");
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
        const RETRIEVAL: &[(&str, &str)] = &[
            ("query.rs", include_str!("query.rs")),
            ("dedup.rs", include_str!("dedup.rs")),
            ("embed.rs", include_str!("embed.rs")),
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
        for (name, src) in RETRIEVAL {
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
        const SRC: &str = include_str!("db.rs");
        let body = SRC
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

    /// RRF fuses by RANK, not by score — the arms' scores are not
    /// commensurable (bm25 is unbounded and negative-is-better, cosine is
    /// [-1,1], grep has no score at all), so ranks are the only shared unit.
    #[test]
    fn rrf_rewards_agreement_between_arms() {
        let lexical = vec![("a".to_string(), 9.0), ("b".to_string(), 8.0), ("c".to_string(), 7.0)];
        let semantic = vec![("c".to_string(), 0.91), ("a".to_string(), 0.88)];
        let fused = rrf_fuse(&[(Arm::Lexical, lexical), (Arm::Semantic, semantic)]);

        // `a` is rank 1 and rank 2 — found by both, so it leads.
        assert_eq!(fused[0].0, "a");
        assert_eq!(fused[0].1.len(), 2, "both arms are recorded on the hit");
        // `c` (ranks 3 and 1) beats `b` (rank 2 in one arm only): agreement
        // across arms outweighs a better position in one of them.
        let pos = |k: &str| fused.iter().position(|(x, _, _)| x == k).unwrap();
        assert!(pos("c") < pos("b"), "two arms agreeing beats one arm ranking higher");

        // Every hit names its arms with rank and score, so a `semantic`-only
        // hit is visibly *associated* rather than asserted.
        let b = &fused[pos("b")].1;
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].arm, Arm::Lexical);
        assert_eq!(b[0].rank, 2);

        // Deterministic on ties — never hash order.
        let tie = rrf_fuse(&[
            (Arm::Lexical, vec![("z".into(), 1.0)]),
            (Arm::Semantic, vec![("y".into(), 1.0)]),
        ]);
        assert_eq!(tie.iter().map(|(k, _, _)| k.as_str()).collect::<Vec<_>>(), ["y", "z"]);
        assert!(rrf_fuse(&[]).is_empty());
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

    /// The budget may starve nothing. The old rule dropped whole lists in a
    /// fixed order, so a bloated `promptHits` cost the user EVERY page before a
    /// single prompt was touched — which is what the live probe showed
    /// (`browseHits: 0`, `truncated: [browseHits, promptHits]`).
    #[test]
    fn budget_keeps_one_hit_per_arm() {
        let filler = "x".repeat(6_000);
        let mut pack = AnswerPack {
            head_seq: 1,
            query: Some("q".into()),
            node: None,
            matched_nodes: Vec::new(),
            notes: (0..30)
                .map(|i| UserNote {
                    id: i,
                    seq: Some(i),
                    target_kind: "none".into(),
                    target_id: None,
                    text: filler.clone(),
                    starred: false,
                    created_at: 0,
                    updated_at: 0,
                })
                .collect(),
            prompt_hits: (0..30)
                .map(|i| PackPromptHit {
                    item: LakeItem {
                        seq: i,
                        ts: 0,
                        kind: "prompt".into(),
                        ref_kind: None,
                        ref_id: None,
                        session_id: None,
                        surface: None,
                        origin: None,
                        role: None,
                        mission_id: None,
                        project_path: None,
                        body: Some(filler.clone()),
                        thread_kind: None,
                        thread_id: None,
                        parent_session_id: None,
                        model: None,
                    },
                    superseded_by: None,
                    duplicate_of: Vec::new(),
                    stage: "and".into(),
                    arms: Vec::new(),
                })
                .collect(),
            browse_hits: (0..30)
                .map(|i| crate::db::BrowseHit {
                    id: i,
                    seq: Some(i),
                    ts: 0,
                    url: format!("https://example.com/{i}"),
                    title: Some(filler.clone()),
                    snippet: filler.clone(),
                    score: 0.0,
                    stage: "and".into(),
                    shot_key: None,
                    caption: None,
                })
                .collect(),
            grep_hits: Vec::new(),
            arm_coverage: Vec::new(),
            truncated: Vec::new(),
        };
        enforce_pack_budget(&mut pack);

        let bytes = serde_json::to_vec(&pack).unwrap().len();
        assert!(bytes <= MAX_CONTEXT_BYTES, "{bytes} over budget");
        assert!(!pack.browse_hits.is_empty(), "pages must not be erased outright");
        assert!(!pack.prompt_hits.is_empty(), "prompts must not be erased outright");
        assert!(!pack.notes.is_empty(), "the user's own words least of all");
        // …and every arm that lost something says so.
        for arm in ["browseHits", "promptHits"] {
            assert!(
                pack.truncated.iter().any(|t| t == arm),
                "{arm} was trimmed and must report it: {:?}",
                pack.truncated
            );
        }
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
