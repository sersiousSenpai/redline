// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The append-only, hash-chained, author-attributed prompt & decision ledger —
//! the "data lake" keystone of the Polis program (Phase 1).
//!
//! Every prompt Redline can see, every plan revision, and every decision or
//! curation signal becomes a `ledger_events` row whose `entry_hash` commits to
//! the previous row's hash:
//!
//! ```text
//! entry_hash = sha256( prev_hash ‖ canonical-json(event) )
//! genesis prev = 64 zeros
//! ```
//!
//! Bodies (prompt text, revision markdown) live in ledger-owned tables so a
//! session delete can never break the chain — decision events reference the
//! rows they describe by `(ref_kind, ref_id)` + a `payload_hash`, never by a
//! deletable foreign key. Verification re-walks the chain and reports the first
//! seq whose stored hash disagrees with a recomputation.
//!
//! The hashing/serialization here is the single source of truth used by BOTH
//! the append path (`Database::append_ledger_event`) and the verify path
//! (`Database::verify_ledger_chain`) so they can never drift.

use std::sync::OnceLock;

use polis_core::ledger::{TtlGuard, GUARD_TTL};

use crate::db::Database;

// The pure half of the ledger — hashing, kinds, the canonical event, the row
// types, the chain verdict and the agent-prompt guard — lives in `polis-core`
// (Session A1 of the Polis extraction, docs/polis-extraction.md). Re-exported
// here so every `crate::ledger::…` call site is unchanged.
// `#[allow(unused_imports)]`: a shim re-exports for PATH STABILITY, not for use
// inside this module — what nothing here touches still has call sites elsewhere
// (or in tests), and the lint cannot see across cfgs.
#[allow(unused_imports)]
pub use polis_core::ledger::{
    body_hash, claim_agent_prompt, compute_entry_hash, decision_payload_hash, now_millis,
    register_agent_prompt, sha256_hex, BrowseEventRow, CanonicalEvent, ChainVerdict, CorpusRole,
    EventKind, LedgerAppend, LedgerEventRow, Origin, PromptRow, PromptSource, GENESIS_PREV,
};

/// The local author attributed to an event when no collaborator identity is
/// supplied. Overridable via `REDLINE_AUTHOR`; falls back to the OS login name,
/// then `"local"`. Stored per event and hashed into `entry_hash`, so changing
/// it retroactively would break the chain — which is the point.
pub fn local_author() -> String {
    std::env::var("REDLINE_AUTHOR")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| std::env::var("USER").ok().filter(|s| !s.trim().is_empty()))
        .unwrap_or_else(|| "local".to_string())
}

// ---------------------------------------------------------------------------
// Drafted-prompt handoff guard
// ---------------------------------------------------------------------------
//
// The launch→session lineage: `record_plan_launch` registers the launched
// body's hash here WITH the door it came through and, when there is one, the
// draft id; when the spawned session's first `UserPromptSubmit` hook fire
// arrives at the ingest handler (and is claim-skipped by the agent guard
// above), the handler claims this map too — at that exact moment the claude
// session id is known, so the ingest can bind the launch-time prompt row to the
// session running it, and record `session_link(session → drafter draft)` for
// the door that has a document. Same TTL/consume-once semantics as the agent
// guard.

/// What a plan launch registered about itself, held until the spawned session's
/// first hook fire claims it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchClaim {
    /// Which door launched it: `front-door` | `drafter` | `browser` | `chat`
    /// | `combine`.
    pub origin: String,
    /// The THREAD it was launched from, as `(kind, id)` — a Drafter document
    /// (`drafter`) or a chat (`companion`). `None` for the doors that own no
    /// thread — the front door's one sentence and the browser's Send — whose
    /// prompts still need binding even though there is nothing to link them to.
    pub thread: Option<(String, String)>,
    /// The hash of the PROMPT ROW's body, when it differs from the guard key.
    ///
    /// Every door but one records the body it typed, so one hash serves as
    /// both the guard key (what the spawned session's hook will hash) and the
    /// row key (what the bind looks up). Combine is the exception: it types a
    /// brief of concatenated source plans but records only the human's typed
    /// context plus the source hashes — because a launch filed as
    /// `CorpusRole::User` with `author: None` is, by that role, uncompactable
    /// (`keeper::select_compaction_candidates` filters `role != "user"`), and
    /// filing 120 KB of machine-written plan text under it would put a
    /// permanently-uncompactable blob into the searchable lake.
    ///
    /// The guard key MUST stay the full typed body or `claim_agent_prompt`
    /// misses and the hook files the whole brief as a fresh prompt anyway.
    /// `None` means "same as the guard key" — so all four existing doors stay
    /// byte-identical.
    pub row_hash: Option<String>,
}

fn launch_guard() -> &'static TtlGuard<LaunchClaim> {
    static G: OnceLock<TtlGuard<LaunchClaim>> = OnceLock::new();
    G.get_or_init(|| TtlGuard::new(GUARD_TTL))
}

/// Register a prompt body about to be launched into a new plan session,
/// carrying the door it came through and the draft id (when the door has a
/// document) the eventual session should be linked under.
pub fn register_plan_launch(
    body_hash: &str,
    origin: &str,
    thread: Option<(&str, &str)>,
    row_hash: Option<&str>,
) {
    launch_guard().register(
        body_hash.to_string(),
        LaunchClaim {
            origin: origin.to_string(),
            thread: thread.map(|(k, i)| (k.to_string(), i.to_string())),
            row_hash: row_hash.map(str::to_string),
        },
    );
}

/// Consume a plan-launch registration: what this body was launched from, or
/// `None` if the body wasn't a plan launch at all.
pub fn claim_plan_launch(body_hash: &str) -> Option<LaunchClaim> {
    launch_guard().claim(body_hash)
}

// ---------------------------------------------------------------------------
// Orchestration handoff guard
// ---------------------------------------------------------------------------
//
// The Orchestrate lineage: `record_orchestration_launch` registers the typed
// orchestrator prompt's hash here WITH the plan session id it will execute;
// when the orchestrator session's first `UserPromptSubmit` hook fire arrives
// at the ingest handler, the handler claims this map — at that exact moment
// the new claude session id is known, so the ingest records
// `session_link(session → plan session)` and advances the run state. Same
// TTL/consume-once semantics as the guards above.

fn orchestration_guard() -> &'static TtlGuard<String> {
    static G: OnceLock<TtlGuard<String>> = OnceLock::new();
    G.get_or_init(|| TtlGuard::new(GUARD_TTL))
}

/// Register an orchestrator prompt body about to be typed into a fresh
/// session, carrying the plan session id whose approved plan it executes.
pub fn register_orchestration_prompt(body_hash: &str, plan_session_id: &str) {
    orchestration_guard().register(body_hash.to_string(), plan_session_id.to_string());
}

/// Consume an orchestration registration: the plan session id this body was
/// launched to execute, or `None` if the body wasn't an Orchestrate launch.
pub fn claim_orchestration_prompt(body_hash: &str) -> Option<String> {
    orchestration_guard().claim(body_hash)
}

// ---------------------------------------------------------------------------
// Public record entry points
// ---------------------------------------------------------------------------

/// Memory-by-session provenance for a captured prompt: which interaction
/// thread it belongs to and (when resolvable) the parent session that thread
/// hangs under. Stored in non-hashed `prompts` columns — never in the chain.
#[derive(Debug, Clone)]
pub struct ThreadRef {
    /// `browse | linked | mission | voice | drafter | drafter_chat | fork |
    /// review_thread | review_question | companion | memchat | shelf_agent |
    /// shelf_preview` — the thread's kind.
    pub thread_kind: &'static str,
    /// The thread's own id in its id-space (browse_id, linked_id, …).
    pub thread_id: String,
    /// The parent plan session, when one is resolvable at capture time.
    pub parent_session_id: Option<String>,
}

/// The full set of fields needed to record a prompt.
pub struct PromptInput {
    pub source: PromptSource,
    pub origin: Origin,
    pub surface: String,
    /// What kind of text this is. Required, never inferred downstream — see
    /// [`CorpusRole`] for why the `Option` it replaced was the bug.
    pub role: CorpusRole,
    pub session_id: Option<String>,
    pub claude_session_id: Option<String>,
    pub mission_id: Option<String>,
    pub project_path: Option<String>,
    pub body: String,
    pub thread: Option<ThreadRef>,
    /// Who authored this prompt: `None` is the local human (`local_author()`);
    /// an agent-constructed prompt carries its seat/surface name so per-actor
    /// trajectories stay separable. Hashed into the chain via `CanonicalEvent`.
    pub author: Option<String>,
    /// The model that received this prompt, when known at capture — a seat's
    /// explicit `--model` flag. `None` means the CLI default applied: store
    /// nothing, never a guess (the transcript backfill fills it in later).
    pub model: Option<String>,
    /// How the model is known: `"seat"` at capture, `"transcript"` on
    /// backfill. Always `None` when `model` is.
    pub model_source: Option<String>,
    /// For an `Agent` row: the human's own words the constructed prompt wraps.
    /// `None` for a pure tool agent (classifier, keeper, librarian, shipwright,
    /// seat assignment) — nobody asked those anything, so nothing of theirs
    /// should ever enter the search corpus. See [`PromptRow::user_text`].
    pub user_text: Option<String>,
}

/// Record a prompt into the lake + emit its ledger event. Returns the new
/// ledger `seq`, or `None` if the prompt was a duplicate (same body + claude
/// session) and nothing was written. Best-effort: never a hard error path for
/// callers, but surfaces DB errors as `Err` for logging.
pub fn record_prompt(db: &Database, input: PromptInput) -> Result<Option<i64>, String> {
    let bh = body_hash(&input.body);
    let ts = now_millis();
    let row = PromptRow {
        ts,
        source: input.source.as_str(),
        origin: input.origin.as_str(),
        surface: &input.surface,
        role: input.role.as_str(),
        user_text: input.user_text.as_deref(),
        session_id: input.session_id.as_deref(),
        claude_session_id: input.claude_session_id.as_deref(),
        mission_id: input.mission_id.as_deref(),
        project_path: input.project_path.as_deref(),
        body: &input.body,
        body_hash: &bh,
        thread_kind: input.thread.as_ref().map(|t| t.thread_kind),
        thread_id: input.thread.as_ref().map(|t| t.thread_id.as_str()),
        parent_session_id: input
            .thread
            .as_ref()
            .and_then(|t| t.parent_session_id.as_deref()),
        model: input.model.as_deref(),
        model_source: input.model_source.as_deref(),
    };
    let prompt_id = match db.insert_prompt(&row).map_err(|e| e.to_string())? {
        Some(id) => id,
        None => return Ok(None), // dedup: identical (body, claude session) already stored
    };
    let author = input.author.unwrap_or_else(local_author);
    let append = LedgerAppend {
        kind: EventKind::Prompt.as_str(),
        author: &author,
        ts,
        prompt_id: Some(prompt_id),
        session_id: input.session_id.as_deref(),
        version_number: None,
        ref_kind: None,
        ref_id: None,
        payload_hash: &bh,
    };
    let ev = db.append_ledger_event(&append).map_err(|e| e.to_string())?;
    Ok(Some(ev.seq))
}

/// Record a Rust-constructed agent first-turn prompt: registers the exact body
/// with the dedup guard (so the global `UserPromptSubmit` hook's later fire for
/// the spawned session is claimed-and-skipped) and writes the ledger prompt
/// event. Best-effort — logs on error, never propagates, so a spawn is never
/// blocked by ledger bookkeeping. `body` must be the exact prompt string the
/// agent receives, or the guard won't match the hook.
///
/// `user_text` is the human's own words inside `body` — the question the preface
/// wraps. The row stores `body` byte-intact (audit) but the lexical index reads
/// `user_text` (search), which is what stops Redline's own instruction text from
/// being 87% of its own corpus. Pass `None` from the pure tool agents — the
/// classifier, keeper, librarian, shipwright and seat-assignment prompts wrap
/// nobody's question, so nothing of theirs belongs in the search corpus at all.
#[allow(clippy::too_many_arguments)]
pub fn record_agent_prompt(
    db: &Database,
    source: PromptSource,
    surface: &str,
    body: &str,
    user_text: Option<&str>,
    project_path: Option<String>,
    session_id: Option<String>,
    mission_id: Option<String>,
    thread: Option<ThreadRef>,
    model: Option<String>,
) {
    register_agent_prompt(body);
    let model_source = model.as_ref().map(|_| "seat".to_string());
    let input = PromptInput {
        source,
        origin: Origin::Redline,
        surface: surface.to_string(),
        role: CorpusRole::Agent,
        session_id,
        claude_session_id: None,
        mission_id,
        project_path,
        body: body.to_string(),
        user_text: user_text
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_string),
        thread,
        // The constructed body is the surface agent's artifact, so it authors
        // the event as itself — the surface string is already ground truth here.
        author: Some(surface.to_string()),
        model,
        model_source,
    };
    if let Err(e) = record_prompt(db, input) {
        tracing::warn!(error = %e, surface, "failed to record agent prompt to ledger");
    }
}

/// The browse-event verb vocabulary — what actually happened on the page. Every
/// verb is a discrete act, never an inferred duration (no dwell — attention is
/// measured by returns and trail depth, both derived from acts already stored).
/// `Navigate` is the only production emit today; the rest complete the seam
/// `browse_events.action` was designed with ("left open for finer-grained
/// interactions later") so capture can widen without another schema change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowseAction {
    /// A page came on screen.
    Navigate,
    /// Text on the page was selected/highlighted. Capture is deliberately
    /// deferred (like the two below) until a rendered trail shows what is
    /// missing — the vocabulary exists so capture is a new emit call, not a
    /// schema change.
    #[allow(dead_code)]
    Select,
    /// A form on the page was submitted.
    #[allow(dead_code)]
    Submit,
    /// The page was left (tab closed or navigated away).
    #[allow(dead_code)]
    Leave,
}

impl BrowseAction {
    pub fn as_str(&self) -> &'static str {
        match self {
            BrowseAction::Navigate => "navigate",
            BrowseAction::Select => "select",
            BrowseAction::Submit => "submit",
            BrowseAction::Leave => "leave",
        }
    }
}

/// Fields for recording a browsing event — a page the user landed on (Dojo P2).
pub struct BrowseEventInput {
    /// What happened, from the closed verb vocabulary above.
    pub action: BrowseAction,
    /// The tab's discussion-thread key, so events can be grouped per tab.
    pub browse_id: Option<String>,
    pub url: String,
    pub title: Option<String>,
    /// Normalized on-screen content (title + url + headings + body). Hashed to
    /// the context hash and retained for later lexical retrieval (P3 FTS5).
    pub text: String,
    /// Trail edge: the `browse_events.id` this event followed from (a click or
    /// navigation chain), when known. `None` for trail roots — and for every
    /// event today; the column exists so trails can be captured later without
    /// a migration.
    pub from_event_id: Option<i64>,
    /// Who performed the act: `None` is the local human; an agent driving the
    /// tab (the browse agent over the curl bridge) passes its seat name.
    pub author: Option<String>,
}

/// Record a browsing event into the lake: store the normalized page content in
/// the ledger-owned `browse_events` table and emit a `browse_event` ledger event
/// referencing it by `(ref_kind="browse_event", ref_id=id)` with the content hash
/// as `payload_hash`. Returns the new seq, or `None` if the content was a
/// consecutive duplicate for the tab (nothing written). Best-effort — surfaces DB
/// errors as `Err` for logging; never blocks the browser.
pub fn record_browse_event(db: &Database, input: BrowseEventInput) -> Result<Option<i64>, String> {
    let ch = body_hash(&input.text);
    let ts = now_millis();
    let row = BrowseEventRow {
        ts,
        action: input.action.as_str(),
        browse_id: input.browse_id.as_deref(),
        url: &input.url,
        title: input.title.as_deref(),
        text: &input.text,
        context_hash: &ch,
        from_event_id: input.from_event_id,
    };
    let id = match db.insert_browse_event(&row).map_err(|e| e.to_string())? {
        Some(id) => id,
        None => return Ok(None), // consecutive duplicate for this tab
    };
    let author = input.author.unwrap_or_else(local_author);
    let ref_id = id.to_string();
    let append = LedgerAppend {
        kind: EventKind::BrowseEvent.as_str(),
        author: &author,
        ts,
        prompt_id: None,
        session_id: None,
        version_number: None,
        ref_kind: Some("browse_event"),
        ref_id: Some(&ref_id),
        payload_hash: &ch,
    };
    let ev = db.append_ledger_event(&append).map_err(|e| e.to_string())?;
    Ok(Some(ev.seq))
}

/// Emit a ledger event for a plan revision. Idempotent per
/// `(session_id, version_number, payload_hash)` — a re-received identical
/// revision does not spam the chain. Returns the new seq, or `None` if skipped.
/// `author` is the explicit actor; `None` is the local human (a revision from
/// the user's own supervised plan session).
pub fn record_revision_event(
    db: &Database,
    session_id: &str,
    version_number: i64,
    raw_plan_markdown: &str,
    author: Option<&str>,
) -> Result<Option<i64>, String> {
    let ph = body_hash(raw_plan_markdown);
    if db
        .revision_event_exists(session_id, version_number, &ph)
        .map_err(|e| e.to_string())?
    {
        return Ok(None);
    }
    let author = author.map(str::to_string).unwrap_or_else(local_author);
    let append = LedgerAppend {
        kind: EventKind::Revision.as_str(),
        author: &author,
        ts: now_millis(),
        prompt_id: None,
        session_id: Some(session_id),
        version_number: Some(version_number),
        ref_kind: Some("revision"),
        ref_id: Some(session_id),
        payload_hash: &ph,
    };
    let ev = db.append_ledger_event(&append).map_err(|e| e.to_string())?;
    Ok(Some(ev.seq))
}

/// A decision or curation signal referencing an existing row. `payload_hash` is
/// a hash of a canonical form of the referenced decision (computed by the
/// caller from the row it just wrote). Idempotent per
/// `(kind, ref_kind, ref_id, payload_hash)`.
pub struct DecisionInput<'a> {
    pub kind: EventKind,
    pub author: Option<String>,
    pub session_id: Option<&'a str>,
    pub ref_kind: &'a str,
    pub ref_id: &'a str,
    pub payload_hash: String,
}

/// Record a decision/curation event. Returns the new seq, or `None` if an
/// identical decision was already recorded.
pub fn record_decision(db: &Database, input: DecisionInput) -> Result<Option<i64>, String> {
    if db
        .decision_event_exists(
            input.kind.as_str(),
            input.ref_kind,
            input.ref_id,
            &input.payload_hash,
        )
        .map_err(|e| e.to_string())?
    {
        return Ok(None);
    }
    let author = input.author.unwrap_or_else(local_author);
    let append = LedgerAppend {
        kind: input.kind.as_str(),
        author: &author,
        ts: now_millis(),
        prompt_id: None,
        session_id: input.session_id,
        version_number: None,
        ref_kind: Some(input.ref_kind),
        ref_id: Some(input.ref_id),
        payload_hash: &input.payload_hash,
    };
    let ev = db.append_ledger_event(&append).map_err(|e| e.to_string())?;
    Ok(Some(ev.seq))
}

/// Record a parent/child session-tree relation: insert the readable
/// `session_tree` row (idempotent — a child has at most one parent, first write
/// wins) and, when a row was actually inserted, emit a `session_link` ledger
/// event referencing it, committing to the `(child, parent)` identity via
/// `payload_hash`. Returns the new ledger seq, `None` when the relation already
/// existed. Best-effort at call sites — never block a spawn on it.
pub fn record_session_link(
    db: &Database,
    child_kind: &str,
    child_id: &str,
    parent_kind: &str,
    parent_id: &str,
) -> Result<Option<i64>, String> {
    if child_id.trim().is_empty() || parent_id.trim().is_empty() {
        return Ok(None);
    }
    let row_id = match db
        .insert_session_link(child_kind, child_id, parent_kind, parent_id, now_millis())
        .map_err(|e| e.to_string())?
    {
        Some(id) => id,
        None => return Ok(None), // this child is already linked
    };
    let ph = decision_payload_hash(&[
        ("child_kind", child_kind),
        ("child_id", child_id),
        ("parent_kind", parent_kind),
        ("parent_id", parent_id),
    ]);
    record_decision(
        db,
        DecisionInput {
            kind: EventKind::SessionLink,
            author: None,
            session_id: (parent_kind == "session").then_some(parent_id),
            ref_kind: "session_link",
            ref_id: &row_id.to_string(),
            payload_hash: ph,
        },
    )
}

/// Record a work-item lifecycle act (file / claim / close) — the
/// `record_session_link` shape: the CALLER inserts/updates the `work_items`
/// row via `db` first; this helper only appends the chain event, referencing
/// the item by `(ref_kind="work_item", ref_id=item id)` and committing to
/// `(item, action, actor, detail, at)` via `payload_hash`. Provenance, never
/// ownership: the event holds no foreign key, so the item (or its origin)
/// being deleted later cannot break the chain.
///
/// `at` should be the row's own `updated_at`: a same-instant double post
/// dedupes (via `record_decision`'s idempotency), while a genuinely later
/// re-act — a re-claim after a lease lapse — still records. Best-effort at
/// call sites — never block the row write on it. Returns the new seq, `None`
/// when this exact act was already recorded.
pub fn record_work_event(
    db: &Database,
    kind: EventKind,
    item_id: &str,
    actor: Option<&str>,
    detail: Option<&str>,
    at: i64,
) -> Result<Option<i64>, String> {
    debug_assert!(
        matches!(
            kind,
            EventKind::WorkFile | EventKind::WorkClaim | EventKind::WorkClose
        ),
        "record_work_event is for work-item lifecycle kinds only"
    );
    if item_id.trim().is_empty() {
        return Ok(None);
    }
    let at_str = at.to_string();
    let ph = decision_payload_hash(&[
        ("item", item_id),
        ("action", kind.as_str()),
        ("actor", actor.unwrap_or("")),
        ("detail", detail.unwrap_or("")),
        ("at", &at_str),
    ]);
    record_decision(
        db,
        DecisionInput {
            kind,
            author: actor
                .map(str::trim)
                .filter(|a| !a.is_empty())
                .map(str::to_string),
            session_id: None,
            ref_kind: "work_item",
            ref_id: item_id,
            payload_hash: ph,
        },
    )
}

/// Record one moot turn — the `record_work_event` shape: the CALLER lands the
/// readable transcript (the moot's Bookshelf document) first; this helper only
/// appends the chain event, referencing the subject item by
/// `(ref_kind="work_item", ref_id=item id)` and committing to
/// `(item, moot, round, seat, digest, at)` via `payload_hash` — `turn_digest`
/// is the content hash of the turn's text, so the transcript document can be
/// edited (that's the moot's intervention channel) while every turn as spoken
/// stays tamper-evident. Best-effort at call sites — never block the moot on
/// it. Returns the new seq, `None` when this exact turn was already recorded.
pub fn record_moot_turn(
    db: &Database,
    item_id: &str,
    moot_id: &str,
    round: u32,
    seat: &str,
    turn_digest: &str,
    at: i64,
) -> Result<Option<i64>, String> {
    if item_id.trim().is_empty() || moot_id.trim().is_empty() {
        return Ok(None);
    }
    let round_s = round.to_string();
    let at_s = at.to_string();
    let ph = decision_payload_hash(&[
        ("item", item_id),
        ("moot", moot_id),
        ("round", &round_s),
        ("seat", seat),
        ("digest", turn_digest),
        ("at", &at_s),
    ]);
    record_decision(
        db,
        DecisionInput {
            kind: EventKind::MootTurn,
            // The speaking seat, namespaced so a seat name can never collide
            // with a human author identity.
            author: Some(format!("moot:{seat}")),
            session_id: None,
            ref_kind: "work_item",
            ref_id: item_id,
            payload_hash: ph,
        },
    )
}

/// One SHADOW attention-router verdict for one completed AI pre-review pass.
/// `verdict` is the CLOSED vocabulary `auto` | `attend` — there is no third
/// tier, because a machine never overrules the human. `signals` are the
/// checkable risk signals that fired, `bar` is the published attend threshold
/// they were judged at, and `cited_seq` (when present) is a VALIDATED ledger
/// seq of a user decision the diff contradicts. `at` is the pass-completion
/// timestamp: an identical same-instant double post dedupes, while each later
/// pass records its own verdict.
pub struct ReviewVerdictRecord<'a> {
    pub review_session_id: &'a str,
    pub verdict: &'a str,
    pub reason: &'a str,
    pub signals: &'a [String],
    pub bar: usize,
    pub cited_seq: Option<i64>,
    pub at: i64,
}

/// Record a shadow router verdict — the `record_session_link` shape: a
/// readable, self-describing row first (the house `app_settings` KV, keyed
/// `redline.router.verdict.<review id>` — signals + bar ride in it, so the
/// calibration record explains itself), then one chain event committing to the
/// full payload. SHADOW MODE: this is the verdict's ONLY sink besides the FE
/// banner payload — nothing reads it to open, hold, land, or skip anything.
/// Best-effort at call sites — never block the review on it. Returns the new
/// seq, `None` when this exact verdict was already recorded.
pub fn record_review_verdict(
    db: &Database,
    rec: &ReviewVerdictRecord,
) -> Result<Option<i64>, String> {
    if !matches!(rec.verdict, "auto" | "attend") {
        return Err(format!(
            "router verdict must be 'auto' or 'attend' (got '{}') — no other tier exists",
            rec.verdict
        ));
    }
    if rec.review_session_id.trim().is_empty() {
        return Ok(None);
    }
    let signals_joined = rec.signals.join(",");
    let bar_s = rec.bar.to_string();
    let cited_s = rec.cited_seq.map(|s| s.to_string()).unwrap_or_default();
    let at_s = rec.at.to_string();
    let ph = decision_payload_hash(&[
        ("review_session_id", rec.review_session_id),
        ("verdict", rec.verdict),
        ("reason", rec.reason),
        ("signals", &signals_joined),
        ("bar", &bar_s),
        ("cited_seq", &cited_s),
        ("at", &at_s),
    ]);
    let readable = serde_json::json!({
        "reviewSessionId": rec.review_session_id,
        "verdict": rec.verdict,
        "reason": rec.reason,
        "signals": rec.signals,
        "bar": rec.bar,
        "citedSeq": rec.cited_seq,
        "at": rec.at,
    })
    .to_string();
    db.set_setting(
        &format!("redline.router.verdict.{}", rec.review_session_id),
        &readable,
    )
    .map_err(|e| e.to_string())?;
    record_decision(
        db,
        DecisionInput {
            kind: EventKind::RouterVerdict,
            author: Some("router".to_string()),
            session_id: Some(rec.review_session_id),
            ref_kind: "code_review",
            ref_id: rec.review_session_id,
            payload_hash: ph,
        },
    )
}

/// Resolve the parent for a NEW interaction thread — called ONCE at thread
/// creation; the relation is then recorded via `record_session_link` and never
/// re-derived. Precedence:
///   explicit seed (voice→plan, drafter-from-mission→mission, fork→its session)
///   > the active mission, for browser-family surfaces (browse, linked)
///   > the active surface's plan session (the user was looking at plan X)
///   > none (a root thread).
/// The companion is always a root: it spans surfaces by design.
pub fn resolve_parent(
    explicit: Option<(&str, &str)>,
    active_mission_id: Option<&str>,
    active_surface: Option<(&str, &str)>, // (kind, id) when the surface carries an id
    child_kind: &str,
) -> Option<(String, String)> {
    if child_kind == "companion" {
        return None;
    }
    if let Some((kind, id)) = explicit {
        return Some((kind.to_string(), id.to_string()));
    }
    if matches!(child_kind, "browse" | "linked") {
        if let Some(m) = active_mission_id.filter(|m| !m.trim().is_empty()) {
            return Some(("mission".to_string(), m.to_string()));
        }
    }
    if let Some(("plan", id)) = active_surface {
        if !id.trim().is_empty() {
            return Some(("session".to_string(), id.to_string()));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The signature is the fix: `register_agent_prompt` takes the BODY. Handing
    /// it a hash still type-checks (both are `&str`), which is exactly how the
    /// two spellings stayed indistinguishable for 237 rows — so the invariant is
    /// pinned in source rather than left to review. Table-driven over every file
    /// that arms the guard.
    #[test]
    fn every_constructed_agent_prompt_is_claimable() {
        const SOURCES: &[(&str, &str)] = &[
            ("browse.rs", include_str!("browse.rs")),
            ("classmem.rs", include_str!("classmem.rs")),
            ("companion.rs", include_str!("companion.rs")),
            ("draft_chat.rs", include_str!("draft_chat.rs")),
            ("fork.rs", include_str!("fork.rs")),
            ("intake.rs", include_str!("intake.rs")),
            ("keeper.rs", include_str!("keeper.rs")),
            ("ledger.rs", include_str!("ledger.rs")),
            ("lib.rs", include_str!("lib.rs")),
            ("librarian.rs", include_str!("librarian.rs")),
            ("linked.rs", include_str!("linked.rs")),
            ("memchat.rs", include_str!("memchat.rs")),
            ("mission.rs", include_str!("mission.rs")),
            ("moot.rs", include_str!("moot.rs")),
            ("queue.rs", include_str!("queue.rs")),
            ("seatassign.rs", include_str!("seatassign.rs")),
            ("shipwright.rs", include_str!("shipwright.rs")),
            ("voice.rs", include_str!("voice.rs")),
        ];
        let mut armed = 0usize;
        for (name, src) in SOURCES {
            for (ix, _) in src.match_indices("register_agent_prompt(") {
                let arg_start = ix + "register_agent_prompt(".len();
                // Char-safe: these files are full of em dashes, so a byte slice
                // can land mid-codepoint.
                let arg: String = src[arg_start..]
                    .chars()
                    .take_while(|c| *c != ')')
                    .take(120)
                    .collect();
                // The call in this file's own definition/test scaffolding is the
                // only place a literal body is built inline; everywhere else the
                // argument must be a body binding, never a hash.
                assert!(
                    !arg.contains("body_hash"),
                    "{name}: register_agent_prompt must be handed the BODY, not a hash \
                     (`{arg}`) — hashing at the call site is what made the trimmed and \
                     untrimmed spellings indistinguishable"
                );
                armed += 1;
            }
        }
        assert!(armed >= 20, "expected the guard to be armed across the surfaces, saw {armed}");
    }

    #[test]
    fn resolve_parent_precedence_table() {
        // explicit seed always wins
        assert_eq!(
            resolve_parent(Some(("session", "s1")), Some("m1"), Some(("plan", "s2")), "voice"),
            Some(("session".into(), "s1".into()))
        );
        // browser-family surfaces prefer the active mission
        assert_eq!(
            resolve_parent(None, Some("m1"), Some(("plan", "s2")), "browse"),
            Some(("mission".into(), "m1".into()))
        );
        assert_eq!(
            resolve_parent(None, Some("m1"), None, "linked"),
            Some(("mission".into(), "m1".into()))
        );
        // non-browser kinds ignore the mission and fall to the focused plan
        assert_eq!(
            resolve_parent(None, Some("m1"), Some(("plan", "s2")), "drafter"),
            Some(("session".into(), "s2".into()))
        );
        // browse with no mission falls to the focused plan too
        assert_eq!(
            resolve_parent(None, None, Some(("plan", "s2")), "browse"),
            Some(("session".into(), "s2".into()))
        );
        // a non-plan surface is not a parent
        assert_eq!(resolve_parent(None, None, Some(("browser", "t1")), "browse"), None);
        // the companion is always a root
        assert_eq!(
            resolve_parent(Some(("session", "s1")), Some("m1"), Some(("plan", "s2")), "companion"),
            None
        );
        // blank ids never produce a parent
        assert_eq!(resolve_parent(None, Some("  "), Some(("plan", " ")), "browse"), None);
    }

    #[test]
    fn launch_guard_claims_once_with_origin_and_owning_thread() {
        let bh = format!("draftguard-{}", now_millis());
        assert_eq!(claim_plan_launch(&bh), None);
        register_plan_launch(&bh, "drafter", Some(("drafter", "draft-7")), None);
        assert_eq!(
            claim_plan_launch(&bh),
            Some(LaunchClaim {
                origin: "drafter".to_string(),
                thread: Some(("drafter".to_string(), "draft-7".to_string())),
                row_hash: None,
            })
        );
        assert_eq!(claim_plan_launch(&bh), None, "consume-once");
    }

    /// A chat graduating owns its launched prompt exactly as a document does —
    /// the claim carries the thread KIND, so the seam that links the spawned
    /// plan session under its origin works for both.
    #[test]
    fn launch_guard_carries_a_chat_as_the_owning_thread() {
        let bh = format!("chatguard-{}", now_millis());
        register_plan_launch(&bh, "chat", Some(("companion", "chat-3")), None);
        let claim = claim_plan_launch(&bh).expect("a graduation registers");
        assert_eq!(claim.origin, "chat");
        assert_eq!(
            claim.thread,
            Some(("companion".to_string(), "chat-3".to_string())),
            "the kind must ride along, or the link is filed under a draft"
        );
    }

    /// Combine types one body and records another. The guard MUST stay keyed
    /// on what gets typed — that is the hash the spawned session's hook will
    /// compute — while the bind follows `row_hash` to the row that actually
    /// exists. `None` keeps every other door byte-identical.
    #[test]
    fn launch_guard_carries_a_separate_row_hash_when_the_row_is_not_the_body() {
        let typed = format!("combineguard-typed-{}", now_millis());
        let row = format!("combineguard-row-{}", now_millis());
        register_plan_launch(&typed, "combine", None, Some(&row));
        // Claimed by the TYPED hash — the only one the hook can produce.
        let claim = claim_plan_launch(&typed).expect("the typed body is the guard key");
        assert_eq!(claim.origin, "combine");
        assert_eq!(claim.row_hash.as_deref(), Some(row.as_str()));
        // The row hash is not itself a key.
        assert_eq!(claim_plan_launch(&row), None);
    }

    #[test]
    fn launch_guard_holds_the_doors_that_have_no_document() {
        // The front door and the browser's Send launch the same plan session
        // with nothing to link it under. They still register, because binding
        // the prompt row to its session is what the claim is *for* — leaving
        // them out is why those prompts had a permanently NULL session id.
        let bh = format!("fdguard-{}", now_millis());
        register_plan_launch(&bh, "front-door", None, None);
        let claim = claim_plan_launch(&bh).expect("a threadless launch still registers");
        assert_eq!(claim.origin, "front-door");
        assert_eq!(claim.thread, None);
    }

    #[test]
    fn orchestration_guard_claims_once_with_plan_session_id() {
        let bh = format!("orchguard-{}", now_millis());
        assert_eq!(claim_orchestration_prompt(&bh), None);
        register_orchestration_prompt(&bh, "plan-sid-9");
        assert_eq!(
            claim_orchestration_prompt(&bh),
            Some("plan-sid-9".to_string())
        );
        assert_eq!(claim_orchestration_prompt(&bh), None, "consume-once");
    }

    #[test]
    fn orchestration_guard_rearms_after_a_claim() {
        // Pins the handoff-retry path against the GUARD_TTL bug: a retry
        // re-calls `record_orchestration_launch`, and because register is a
        // plain insert, re-registering after a claim (or an expiry) genuinely
        // re-arms — the retried prompt still earns its `orchestrations` row.
        let bh = format!("orchguard-rearm-{}", now_millis());
        register_orchestration_prompt(&bh, "plan-sid-3");
        assert_eq!(
            claim_orchestration_prompt(&bh),
            Some("plan-sid-3".to_string())
        );
        register_orchestration_prompt(&bh, "plan-sid-3");
        assert_eq!(
            claim_orchestration_prompt(&bh),
            Some("plan-sid-3".to_string()),
            "a re-registered body must claim again"
        );
    }

    #[test]
    fn decision_payload_hash_stable() {
        let a = decision_payload_hash(&[("k", "v"), ("n", "1")]);
        let b = decision_payload_hash(&[("k", "v"), ("n", "1")]);
        assert_eq!(a, b);
        let c = decision_payload_hash(&[("k", "v"), ("n", "2")]);
        assert_ne!(a, c);
    }

    #[test]
    fn review_verdict_records_once_per_pass_and_chain_stays_green() {
        let db = Database::open_in_memory().unwrap();
        let signals = vec!["auth_surface".to_string(), "tests_missing".to_string()];
        let rec = ReviewVerdictRecord {
            review_session_id: "rev-1",
            verdict: "attend",
            reason: "touches the auth scope table",
            signals: &signals,
            bar: 1,
            cited_seq: None,
            at: 1234,
        };
        let seq = record_review_verdict(&db, &rec).unwrap();
        assert!(seq.is_some(), "a completed pass records a verdict");
        // Exactly one event per pass: the identical act dedupes…
        assert_eq!(record_review_verdict(&db, &rec).unwrap(), None);
        // …while a genuinely later pass (new `at`) records its own verdict.
        let rec2 = ReviewVerdictRecord { at: 5678, ..rec };
        assert!(record_review_verdict(&db, &rec2).unwrap().is_some());

        let v = db.verify_ledger_chain().unwrap();
        assert!(v.ok, "recording a router verdict must keep the chain green");
        assert_eq!(v.checked, 2);

        // The readable sidecar is self-describing: verdict + signals + bar.
        let side = db.get_setting("redline.router.verdict.rev-1").unwrap();
        let j: serde_json::Value = serde_json::from_str(&side).unwrap();
        assert_eq!(j["verdict"], "attend");
        assert_eq!(j["bar"], 1);
        assert_eq!(j["signals"], serde_json::json!(["auth_surface", "tests_missing"]));
        assert_eq!(j["citedSeq"], serde_json::Value::Null);
    }

    #[test]
    fn review_verdict_rejects_any_third_tier() {
        // The vocabulary is CLOSED: auto | attend. A machine never overrules
        // the human, so "block" (or anything else) cannot even be recorded.
        let db = Database::open_in_memory().unwrap();
        for bad in ["block", "hold", "reject", "", "AUTO"] {
            let rec = ReviewVerdictRecord {
                review_session_id: "rev-1",
                verdict: bad,
                reason: "r",
                signals: &[],
                bar: 1,
                cited_seq: None,
                at: 1,
            };
            assert!(
                record_review_verdict(&db, &rec).is_err(),
                "'{bad}' must be unrecordable"
            );
        }
        assert_eq!(db.max_ledger_seq().unwrap(), 0, "nothing landed on the chain");
    }
}
