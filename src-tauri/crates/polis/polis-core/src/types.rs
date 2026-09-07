// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The read-side row and view types every consumer speaks: class nodes and
//! links, observations, lake items, notes, hits, timeline rows, the map, and
//! stats. Serde-only data — no store, no behaviour — so the server, the MCP
//! server and the generated clients all serialize one shape.

use serde::{Deserialize, Serialize};

use crate::ledger::LedgerEventRow;

/// A class node. A *class* is just a root (`parent_id == None`); depth is
/// emergent (no level enum). A `digest` node's `summary` is the agent-written
/// gist of a collapsed cold branch.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassNode {
    pub id: String,
    pub parent_id: Option<String>,
    pub kind: String, // "node" | "digest"
    pub title: String,
    pub summary: Option<String>,
    pub project_path: Option<String>,
    pub ip_name: Option<String>,
    pub status: String, // "proposed" | "accepted"
    pub pinned: bool,
    pub curated_by: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A pointer from a class node into the lake.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassLink {
    pub id: i64,
    pub node_id: String,
    pub target_kind: String, // prompt|session|revision|mission|decision|browse_event
    pub target_id: String,
    pub note: Option<String>,
    pub status: String,
    pub created_at: i64,
}

/// An agent-written pattern statement over a node's lake items. Derived,
/// never ground truth — retrieval surfaces these after facts/decisions,
/// labeled as patterns. `cite_seqs` is always non-empty (uncited = rejected).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassObservation {
    pub id: i64,
    pub node_id: String,
    pub summary: String,
    pub cite_seqs: Vec<i64>,
    pub created_seq: Option<i64>,
    pub pinned: bool,
    pub dismissed: bool,
    pub created_at: i64,
}

/// A compact prompt/decision item fed to the classifier and returned by
/// `GET /v1/memory/prompts`. Provenance (`project_path`/`surface`/dates) is
/// carried as ground truth — the classifier never infers where a memory came
/// from.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LakeItem {
    pub seq: i64,
    pub ts: i64,
    pub kind: String,   // prompt | resolution | approval | pin | ...
    pub surface: Option<String>,
    pub origin: Option<String>,
    pub role: Option<String>,
    pub session_id: Option<String>,
    pub mission_id: Option<String>,
    pub project_path: Option<String>,
    pub ref_kind: Option<String>,
    pub ref_id: Option<String>,
    /// The prompt body (truncated) for prompt items; `None` for decision events
    /// (they reference a row, not a stored body).
    pub body: Option<String>,
    /// Memory-by-session provenance (non-hashed `prompts` columns): the thread
    /// this prompt belongs to and the parent session it hangs under.
    pub thread_kind: Option<String>,
    pub thread_id: Option<String>,
    pub parent_session_id: Option<String>,
    /// The model that received the prompt, when recorded — carried as ground
    /// truth (seat flag or transcript backfill), never inferred. `None` for
    /// decision events and for prompts whose model was never established.
    pub model: Option<String>,
}

/// Outcome counts from staging a batch of proposals.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StageResult {
    pub created_nodes: usize,
    pub staged_links: usize,
    pub structural: usize,
    pub skipped: usize,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseHit {
    pub id: i64,
    /// The LEDGER seq for this page view — what `#seq` citations and the
    /// Timeline's filter both speak. Carrying only `browse_events.id` (which
    /// is a different id-space entirely) meant a page the Ask agent cited was
    /// uncitable: the chip pointed at a seq that was some unrelated prompt.
    /// `None` only if the ledger row is missing, which no live row is.
    pub seq: Option<i64>,
    pub ts: i64,
    pub url: String,
    pub title: Option<String>,
    pub snippet: String,
    pub score: f64,
    /// Which stage of the query cascade found this — `and` (every term present)
    /// or `or` (widened). Surfaced so "we found what you asked for" reads
    /// differently from "we widened until something matched".
    pub stage: String,
    /// The picture of this page, when one was captured. Completes the seam the
    /// visual layer is built on: a `#seq` chip → a Timeline row → a detail rail
    /// → a picture. An agent can say "there's a screenshot of this" instead of
    /// describing a page from its text alone.
    pub shot_key: Option<String>,
    /// A vision-tier description, for a page whose text didn't capture — the
    /// 12% of the corpus that is otherwise dark.
    pub caption: Option<String>,
}

/// One grep hit. `seq` is the ledger seq, so a hit is citable as `#seq` and
/// opens the Timeline exactly like every other citation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepHit {
    /// `prompt` | `browse`.
    pub kind: String,
    pub seq: Option<i64>,
    pub ts: i64,
    /// The surface for a prompt; the page title (or URL) for a browse hit.
    pub label: String,
    /// Text around the match — centered on it, never the head.
    pub excerpt: String,
}

/// What the grep arm searches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GrepScope {
    #[default]
    All,
    Prompts,
    Browse,
}

impl GrepScope {
    pub fn parse(s: Option<&str>) -> GrepScope {
        match s.map(str::trim) {
            Some("prompts") => GrepScope::Prompts,
            Some("browse") => GrepScope::Browse,
            _ => GrepScope::All,
        }
    }
    pub fn wants_prompts(self) -> bool {
        matches!(self, GrepScope::All | GrepScope::Prompts)
    }
    pub fn wants_browse(self) -> bool {
        matches!(self, GrepScope::All | GrepScope::Browse)
    }
}

// ---------------------------------------------------------------------------
// Session A3: the remaining store-side row and outcome types
// ---------------------------------------------------------------------------

/// The ledger event kinds that are claims (decisions) — the only kinds a
/// supersession may connect. Prompts/revisions are history, never superseded.
pub const DECISION_KINDS: [&str; 3] = ["resolution", "approval", "review_verdict"];

/// Outcome of validating + recording one supersession. `Rejected` is a
/// guardrail verdict (logged, proposal dropped), never a DB error.
#[derive(Debug, Clone, PartialEq)]
pub enum SupersessionOutcome {
    Applied {
        /// The seq actually superseded — may differ from the proposed old_seq
        /// when the op was redirected to the current head of its chain.
        effective_old: i64,
        new_seq: i64,
        event_seq: i64,
    },
    Rejected(String),
}

/// A queued structural reorg proposal (promote/split/merge/collapse/supersede).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassProposalRow {
    pub id: i64,
    pub run_id: Option<i64>,
    pub op: String,
    pub node_id: Option<String>,
    pub parent_id: Option<String>,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub extra_json: Option<String>,
    pub rationale: Option<String>,
    pub status: String,
    pub created_at: i64,
}

/// One classifier pass over the lake delta.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassRun {
    pub id: i64,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub status: String, // running | done | error
    pub seq_from: Option<i64>,
    pub seq_to: Option<i64>,
    pub claude_session_id: Option<String>,
    pub summary: Option<String>,
}

/// What `Database::stage_proposal` did with one proposal.
pub enum StagedOutcome {
    Node,
    Link { created_node: bool },
    Structural,
    Skipped,
}

/// The result of applying (accepting) a structural proposal — the facts the
/// caller needs to write the `taxonomy_reorg` ledger event.
pub struct AppliedReorg {
    pub op: String,
    pub node_id: String,
    pub detail: String,
}

/// Cap (and default) for the filtered lake read (`/v1/context/prompts`).
pub const PROMPT_LIMIT_MAX: i64 = 200;

pub fn clamp_prompt_limit(raw: Option<i64>) -> i64 {
    raw.unwrap_or(PROMPT_LIMIT_MAX).clamp(1, PROMPT_LIMIT_MAX)
}

/// The most lake items one classifier pass (and one `/v1/memory/prompts`
/// page) takes — the delta cap the organizer and the route share.
pub const MAX_DELTA_ITEMS: usize = 400;

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

/// A ledger event enriched with its prompt provenance + full body, as read by
/// `Database::list_mirror_events`. `body` is the full prompt body for prompt
/// events; `None` for revision/decision events (the writer fills revision
/// bodies from `revisions.raw_plan_markdown`).
#[derive(Debug, Clone)]
pub struct MirrorRow {
    pub event: LedgerEventRow,
    pub surface: Option<String>,
    pub origin: Option<String>,
    pub role: Option<String>,
    pub mission_id: Option<String>,
    pub project_path: Option<String>,
    pub body: Option<String>,
    /// Memory-by-session lineage (non-hashed `prompts` columns): the thread
    /// this prompt belongs to and the parent session it hangs under. Drives
    /// the `sessions/<parent>/` filing step + `parent:`/`thread:` frontmatter.
    pub thread_kind: Option<String>,
    pub thread_id: Option<String>,
    pub parent_session_id: Option<String>,
}
