// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The ledger's write entry points — every way a memory row and its chained
//! event come into being: a prompt, a page view, a plan revision, a decision,
//! a thread link, a work or moot act, a curation or reorg of the catalog.
//! Lifted verbatim from Redline's `ledger.rs` / `classmem.rs` in Session A5
//! of the Polis extraction; the only change is the receiver (`&PolisStore`)
//! and the default author (the store's, where the host's `local_author()`
//! was).

#[allow(unused_imports)]
use polis_core::ledger::*;
#[allow(unused_imports)]
use polis_core::types::*;

use crate::PolisStore;

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
    /// Who authored this prompt: `None` is the local human (`store.author().to_string()`);
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
pub fn record_prompt(store: &PolisStore, input: PromptInput) -> Result<Option<i64>, String> {
    record_prompt_at(store, input, now_millis())
}

/// `record_prompt` with the caller's clock — an import carries the moment a
/// prompt happened, not the moment it was ingested.
pub fn record_prompt_at(store: &PolisStore, input: PromptInput, ts: i64) -> Result<Option<i64>, String> {
    let bh = body_hash(&input.body);
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
    let prompt_id = match store.insert_prompt(&row).map_err(|e| e.to_string())? {
        Some(id) => id,
        None => return Ok(None), // dedup: identical (body, claude session) already stored
    };
    let author = input.author.unwrap_or_else(|| store.author().to_string());
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
    let ev = store.append_ledger_event(&append).map_err(|e| e.to_string())?;
    Ok(Some(ev.seq))
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
pub fn record_browse_event(store: &PolisStore, input: BrowseEventInput) -> Result<Option<i64>, String> {
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
    let id = match store.insert_browse_event(&row).map_err(|e| e.to_string())? {
        Some(id) => id,
        None => return Ok(None), // consecutive duplicate for this tab
    };
    let author = input.author.unwrap_or_else(|| store.author().to_string());
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
    let ev = store.append_ledger_event(&append).map_err(|e| e.to_string())?;
    Ok(Some(ev.seq))
}

/// Emit a ledger event for a plan revision. Idempotent per
/// `(session_id, version_number, payload_hash)` — a re-received identical
/// revision does not spam the chain. Returns the new seq, or `None` if skipped.
/// `author` is the explicit actor; `None` is the local human (a revision from
/// the user's own supervised plan session).
pub fn record_revision_event(
    store: &PolisStore,
    session_id: &str,
    version_number: i64,
    raw_plan_markdown: &str,
    author: Option<&str>,
) -> Result<Option<i64>, String> {
    let ph = body_hash(raw_plan_markdown);
    if store
        .revision_event_exists(session_id, version_number, &ph)
        .map_err(|e| e.to_string())?
    {
        return Ok(None);
    }
    let author = author.map(str::to_string).unwrap_or_else(|| store.author().to_string());
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
    let ev = store.append_ledger_event(&append).map_err(|e| e.to_string())?;
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
pub fn record_decision(store: &PolisStore, input: DecisionInput) -> Result<Option<i64>, String> {
    if store
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
    let author = input.author.unwrap_or_else(|| store.author().to_string());
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
    let ev = store.append_ledger_event(&append).map_err(|e| e.to_string())?;
    Ok(Some(ev.seq))
}

/// Record a parent/child session-tree relation: insert the readable
/// `session_tree` row (idempotent — a child has at most one parent, first write
/// wins) and, when a row was actually inserted, emit a `session_link` ledger
/// event referencing it, committing to the `(child, parent)` identity via
/// `payload_hash`. Returns the new ledger seq, `None` when the relation already
/// existed. Best-effort at call sites — never block a spawn on it.
pub fn record_session_link(
    store: &PolisStore,
    child_kind: &str,
    child_id: &str,
    parent_kind: &str,
    parent_id: &str,
) -> Result<Option<i64>, String> {
    if child_id.trim().is_empty() || parent_id.trim().is_empty() {
        return Ok(None);
    }
    let row_id = match store
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
        store,
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
/// row via `store` first; this helper only appends the chain event, referencing
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
    store: &PolisStore,
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
        store,
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
    store: &PolisStore,
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
        store,
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

/// Record a `class_curate` decision event for an accepted/pinned/renamed node.
/// `actor` is who curated: the classifier's seat name on the auto-organize
/// path, the local human on a GUI accept/pin/rename.
pub fn record_curate(store: &PolisStore, actor: &str, node_id: &str, action: &str, detail: &str) {
    let ph = polis_core::ledger::decision_payload_hash(&[("action", action), ("node", node_id), ("detail", detail)]);
    if let Err(e) = record_decision(
        store,
        DecisionInput {
            kind: EventKind::ClassCurate,
            author: Some(actor.to_string()),
            session_id: None,
            ref_kind: "class_node",
            ref_id: node_id,
            payload_hash: ph,
        },
    ) {
        tracing::warn!(error = %e, node_id, action, "failed to record class-curate ledger event");
    }
}

/// Revert an accepted `file` (the gardener's — or a user's — most common
/// action): remove the class link and append a **compensating** `class_curate`
/// event (`action="revert"`). This is the rollback primitive that lets the
/// Librarian act by default while the human stays supervisor: a bad auto-file is
/// undone without ever deleting a ledger event, so `verify_ledger_chain` /
/// `verify_bundle` stay green — the reversal is *recorded*, not erased. Returns
/// `true` if a link was removed, `false` if the link id didn't exist.
pub fn revert_link(store: &PolisStore, actor: &str, link_id: i64) -> Result<bool, String> {
    match store.delete_class_link(link_id).map_err(|e| e.to_string())? {
        Some((node_id, target_kind, target_id)) => {
            let detail = format!("{target_kind}:{target_id}");
            record_curate(store, actor, &node_id, "revert", &detail);
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Record a `taxonomy_reorg` ledger event for an accepted structural op.
/// `actor` is who applied it — classifier seat name or the local human.
pub fn record_reorg(store: &PolisStore, actor: &str, op: &str, node_id: &str, detail: &str) {
    let ph = polis_core::ledger::decision_payload_hash(&[("op", op), ("node", node_id), ("detail", detail)]);
    let ts = now_millis();
    if let Err(e) = store.append_ledger_event(&polis_core::ledger::LedgerAppend {
        kind: EventKind::TaxonomyReorg.as_str(),
        author: actor,
        ts,
        prompt_id: None,
        session_id: None,
        version_number: None,
        ref_kind: Some("class_node"),
        ref_id: Some(node_id),
        payload_hash: &ph,
    }) {
        tracing::warn!(error = %e, op, node_id, "failed to record taxonomy-reorg ledger event");
    }
}
