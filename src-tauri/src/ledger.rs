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

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::db::Database;

/// Genesis predecessor hash: 64 hex zeros (32 zero bytes).
pub const GENESIS_PREV: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// Where a captured prompt came from — recorded as fact, never inferred.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptSource {
    /// The global `UserPromptSubmit` hook (interactive PTY plan sessions +
    /// external sessions).
    Hook,
    /// The Prompt Drafter launch (`record_drafted_prompt` command).
    DrafterLaunch,
    /// A Rust-constructed first-turn prompt for a spawned agent
    /// (fork / browse / mission / linked).
    RustFirstTurn,
    /// The voice agent's stdin-delivered first-turn prompt.
    VoiceStream,
}

impl PromptSource {
    pub fn as_str(self) -> &'static str {
        match self {
            PromptSource::Hook => "hook",
            PromptSource::DrafterLaunch => "drafter_launch",
            PromptSource::RustFirstTurn => "rust_firstturn",
            PromptSource::VoiceStream => "voice_stream",
        }
    }
}

/// Whether a captured prompt belongs to a Redline-managed session or an
/// external `claude` session that happened to trip the global hook.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    Redline,
    External,
}

impl Origin {
    pub fn as_str(self) -> &'static str {
        match self {
            Origin::Redline => "redline",
            Origin::External => "external",
        }
    }
}

/// A ledger event kind. Prompt/revision events carry a body via `payload_hash`
/// into a ledger-owned table; decision/curation kinds reference an existing row
/// by `(ref_kind, ref_id)` and hash a canonical form of it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventKind {
    Prompt,
    Revision,
    Resolution,
    Approval,
    Reopen,
    ReviewVerdict,
    Pin,
    SourceTrust,
    /// ClassMemory (Phase 2): a taxonomy reorganization — an accepted
    /// promote / split / merge / collapse. "Memory edits are part of the Polis
    /// record" (plan Decision #3), so the tree's own history is time-travelable.
    /// References the moved/created node by `(ref_kind="class_node", ref_id)`.
    TaxonomyReorg,
    /// ClassMemory (Phase 2): a class node or link was accepted into the tree
    /// (an additive `file`/`create` proposal), or pinned/renamed — a curation
    /// signal (what you valued / how you organized). References the node.
    ClassCurate,
    /// Memory-as-plumbing: a cold prompt body was compacted to a gist (or
    /// forgotten). The act of forgetting is itself part of the record — the
    /// event retains the ORIGINAL `body_hash` as tamper-evident proof of what
    /// was there, so the chain and every bundle stay verifiable even though the
    /// stored body is gone. References the prompt by `(ref_kind="prompt", ref_id)`.
    Compaction,
    /// Dojo P2 ("Browsing Behavior"): a page the user landed on. The normalized
    /// on-screen content lives in the ledger-owned `browse_events` table; this
    /// event references it by `(ref_kind="browse_event", ref_id)` and carries the
    /// page content-hash as `payload_hash`.
    BrowseEvent,
    /// Memory-by-session: a child interaction thread (browse / linked / mission /
    /// voice / drafter / fork / companion) was attached to a parent session or
    /// mission. The readable relation lives in the `session_tree` table; this
    /// event references that row by `(ref_kind="session_link", ref_id)` and
    /// commits to its `(child, parent)` identity via `payload_hash`, making the
    /// hierarchy tamper-evident without touching `CanonicalEvent`.
    SessionLink,
    /// Supersession: a newer decision replaces an older one on the same subject.
    /// References the SUPERSEDED event by `(ref_kind="ledger_event",
    /// ref_id=old_seq)` — the first event-to-event reference — and commits to
    /// `(superseded_by, rationale)` via `payload_hash`. Never an edit: the old
    /// decision stays in the lake; the queryable "is seq X superseded?" index
    /// lives in the plain `supersessions` side table, never the hashed event.
    Supersede,
    /// An agent-written pattern statement (recurrence / trend / co-occurrence)
    /// over a class node's lake items. Derived, never ground truth. The readable
    /// row lives in `class_observations`; this event references the node by
    /// `(ref_kind="class_node", ref_id)` and commits to `(node, summary, cites)`
    /// via `payload_hash`, so observation history is tamper-evident even after
    /// the row is retired.
    Observation,
    /// Second Brain P3: the user's own margin note / star over the record. The
    /// readable, editable row lives in the plain `user_notes` side table (the
    /// `supersessions` pattern); each act (write / edit / star / unstar) appends
    /// one of these, referencing the annotated target by `(ref_kind ∈
    /// ledger_event | class_node | session, ref_id)` — or `(ref_kind="none",
    /// ref_id=row id)` for a standalone thought — and committing to
    /// `{action, text}` via `payload_hash`. Edits append; nothing is destroyed.
    /// A note is a strong CURATION signal for the classifier, never provenance.
    Note,
}

impl EventKind {
    pub fn as_str(self) -> &'static str {
        match self {
            EventKind::Prompt => "prompt",
            EventKind::Revision => "revision",
            EventKind::Resolution => "resolution",
            EventKind::Approval => "approval",
            EventKind::Reopen => "reopen",
            EventKind::ReviewVerdict => "review_verdict",
            EventKind::Pin => "pin",
            EventKind::SourceTrust => "source_trust",
            EventKind::TaxonomyReorg => "taxonomy_reorg",
            EventKind::ClassCurate => "class_curate",
            EventKind::Compaction => "compaction",
            EventKind::BrowseEvent => "browse_event",
            EventKind::SessionLink => "session_link",
            EventKind::Supersede => "supersede",
            EventKind::Observation => "observation",
            EventKind::Note => "note",
        }
    }
}

/// Unix milliseconds now. Ledger events stamp their own `ts` at record time;
/// verify reads the stored `ts`, so wall-clock is captured, never recomputed.
pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

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

/// sha256 of `data`, lowercase hex.
pub fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    let mut s = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write;
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// Hash a body (prompt text, revision markdown, …).
pub fn body_hash(body: &str) -> String {
    sha256_hex(body.as_bytes())
}

/// The canonical, deterministic form of an event that gets hashed. Field order
/// is fixed by declaration order; `Option`s serialize as JSON `null`. This is
/// the ONLY place the event shape is defined, so append and verify agree by
/// construction.
#[derive(Debug, Serialize)]
pub struct CanonicalEvent<'a> {
    pub seq: i64,
    pub ts: i64,
    pub kind: &'a str,
    pub author: &'a str,
    pub prompt_id: Option<i64>,
    pub session_id: Option<&'a str>,
    pub version_number: Option<i64>,
    pub ref_kind: Option<&'a str>,
    pub ref_id: Option<&'a str>,
    pub payload_hash: &'a str,
}

/// `entry_hash = sha256( prev_hash ‖ canonical-json(event) )`. `prev_hash` is a
/// fixed-length 64-char hex string, so the concatenation boundary is
/// unambiguous.
pub fn compute_entry_hash(prev_hash: &str, ev: &CanonicalEvent) -> String {
    let canon = serde_json::to_string(ev).unwrap_or_default();
    let mut buf = String::with_capacity(prev_hash.len() + canon.len());
    buf.push_str(prev_hash);
    buf.push_str(&canon);
    sha256_hex(buf.as_bytes())
}

/// Fields passed to `Database::append_ledger_event`. `seq`, `prev_hash`, and
/// `entry_hash` are assigned by the append under the DB write lock.
pub struct LedgerAppend<'a> {
    pub kind: &'a str,
    pub author: &'a str,
    pub ts: i64,
    pub prompt_id: Option<i64>,
    pub session_id: Option<&'a str>,
    pub version_number: Option<i64>,
    pub ref_kind: Option<&'a str>,
    pub ref_id: Option<&'a str>,
    pub payload_hash: &'a str,
}

/// A materialized ledger row, returned by append and list. `Deserialize` so an
/// exported context bundle can be re-loaded and re-verified in-process.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEventRow {
    pub seq: i64,
    pub ts: i64,
    pub kind: String,
    pub author: String,
    pub prompt_id: Option<i64>,
    pub session_id: Option<String>,
    pub version_number: Option<i64>,
    pub ref_kind: Option<String>,
    pub ref_id: Option<String>,
    pub payload_hash: String,
    pub prev_hash: String,
    pub entry_hash: String,
}

/// A row to insert into the ledger-owned `prompts` table.
pub struct PromptRow<'a> {
    pub ts: i64,
    pub source: &'a str,
    pub origin: &'a str,
    pub surface: &'a str,
    pub role: Option<&'a str>,
    pub session_id: Option<&'a str>,
    pub claude_session_id: Option<&'a str>,
    pub mission_id: Option<&'a str>,
    pub project_path: Option<&'a str>,
    pub body: &'a str,
    pub body_hash: &'a str,
    /// Memory-by-session provenance (non-hashed — only `prompt_id` + `body_hash`
    /// enter the chained event, so these columns are free to add/populate).
    pub thread_kind: Option<&'a str>,
    pub thread_id: Option<&'a str>,
    pub parent_session_id: Option<&'a str>,
    /// Model provenance (non-hashed, same precedent): the model that received
    /// the prompt and how we know (`"seat"` / `"transcript"`). NULL = unknown.
    pub model: Option<&'a str>,
    pub model_source: Option<&'a str>,
}

/// A row to insert into the ledger-owned `browse_events` table (Dojo P2).
pub struct BrowseEventRow<'a> {
    pub ts: i64,
    pub action: &'a str,
    pub browse_id: Option<&'a str>,
    pub url: &'a str,
    pub title: Option<&'a str>,
    pub text: &'a str,
    pub context_hash: &'a str,
    /// Trail edge to the preceding `browse_events.id`, when known (non-hashed —
    /// only `context_hash` enters the chained event, so the column is free to
    /// add/populate).
    pub from_event_id: Option<i64>,
}

/// The result of verifying the whole chain.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainVerdict {
    pub ok: bool,
    pub checked: i64,
    /// First seq whose stored hash disagrees with a recomputation, or whose
    /// `prev_hash` doesn't link to its predecessor. `None` when the chain is
    /// intact.
    pub first_bad_seq: Option<i64>,
    /// The head (latest) `entry_hash` when the chain is intact — the value a
    /// snapshot/export can pin.
    pub head_hash: Option<String>,
}

// ---------------------------------------------------------------------------
// Agent-prompt dedup guard
// ---------------------------------------------------------------------------
//
// A headless `claude -p` fires `UserPromptSubmit` too (verified empirically),
// so Redline's own spawned agents (fork/browse/mission/linked/voice) would be
// captured BOTH at their Rust construction site AND again by the global hook.
// The Rust site is authoritative (it knows the surface/mission/project as
// fact), so it registers the constructed body's hash here *before* spawning the
// agent; the hook's ingest handler then claims-and-skips that body. Registering
// before spawn makes this race-free. Consume-once + a TTL prune keep the map
// from leaking when a registered agent never reaches the hook (e.g. it errored
// out before processing its prompt).

const GUARD_TTL: Duration = Duration::from_secs(300);

fn agent_guard() -> &'static Mutex<HashMap<String, Instant>> {
    static G: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    G.get_or_init(|| Mutex::new(HashMap::new()))
}

fn prune(map: &mut HashMap<String, Instant>) {
    let now = Instant::now();
    map.retain(|_, t| now.duration_since(*t) < GUARD_TTL);
}

/// Record that a Rust construction site is about to spawn an agent with this
/// prompt body, so the hook path can recognize and skip the duplicate.
pub fn register_agent_prompt(body_hash: &str) {
    let mut g = agent_guard().lock().unwrap();
    prune(&mut g);
    g.insert(body_hash.to_string(), Instant::now());
}

/// Consume a registration: returns `true` if this body was registered by a Rust
/// site (meaning the hook ingest should skip it as an already-recorded
/// duplicate). Removes the entry so a second, genuinely-distinct hook prompt
/// with the same body is not swallowed.
pub fn claim_agent_prompt(body_hash: &str) -> bool {
    let mut g = agent_guard().lock().unwrap();
    prune(&mut g);
    g.remove(body_hash).is_some()
}

// ---------------------------------------------------------------------------
// Drafted-prompt handoff guard
// ---------------------------------------------------------------------------
//
// The draft→launched-session lineage: `record_drafted_prompt` registers the
// launched body's hash here WITH its draft id; when the spawned session's first
// `UserPromptSubmit` hook fire arrives at the ingest handler (and is
// claim-skipped by the agent guard above), the handler claims this map too —
// at that exact moment the claude session id is known, so the ingest can record
// `session_link(session → drafter draft)`. Same TTL/consume-once semantics as
// the agent guard.

fn drafted_guard() -> &'static Mutex<HashMap<String, (String, Instant)>> {
    static G: OnceLock<Mutex<HashMap<String, (String, Instant)>>> = OnceLock::new();
    G.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Register a drafted prompt body about to be launched into a new plan session,
/// carrying the draft id the eventual session should be linked under.
pub fn register_drafted_prompt(body_hash: &str, draft_id: &str) {
    let mut g = drafted_guard().lock().unwrap();
    let now = Instant::now();
    g.retain(|_, (_, t)| now.duration_since(*t) < GUARD_TTL);
    g.insert(body_hash.to_string(), (draft_id.to_string(), now));
}

/// Consume a drafted-prompt registration: the draft id this body was launched
/// from, or `None` if the body wasn't a drafter launch.
pub fn claim_drafted_prompt(body_hash: &str) -> Option<String> {
    let mut g = drafted_guard().lock().unwrap();
    let now = Instant::now();
    g.retain(|_, (_, t)| now.duration_since(*t) < GUARD_TTL);
    g.remove(body_hash).map(|(draft_id, _)| draft_id)
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
    /// review_thread | review_question | companion | memchat` — the thread's
    /// kind.
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
    pub role: Option<String>,
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
        role: input.role.as_deref(),
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
#[allow(clippy::too_many_arguments)]
pub fn record_agent_prompt(
    db: &Database,
    source: PromptSource,
    surface: &str,
    body: &str,
    project_path: Option<String>,
    session_id: Option<String>,
    mission_id: Option<String>,
    thread: Option<ThreadRef>,
    model: Option<String>,
) {
    register_agent_prompt(&body_hash(body));
    let model_source = model.as_ref().map(|_| "seat".to_string());
    let input = PromptInput {
        source,
        origin: Origin::Redline,
        surface: surface.to_string(),
        role: None,
        session_id,
        claude_session_id: None,
        mission_id,
        project_path,
        body: body.to_string(),
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

/// Convenience: hash a small canonical decision descriptor (a set of key=value
/// fields) so callers don't each hand-roll a format. Fields are joined in the
/// order given, so keep it stable per call site.
pub fn decision_payload_hash(fields: &[(&str, &str)]) -> String {
    let mut s = String::new();
    for (k, v) in fields {
        s.push_str(k);
        s.push('=');
        s.push_str(v);
        s.push('\n');
    }
    sha256_hex(s.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_known_vector() {
        // sha256("") — the canonical empty-string digest.
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn entry_hash_is_deterministic_and_chains() {
        let e = CanonicalEvent {
            seq: 1,
            ts: 1000,
            kind: "prompt",
            author: "local",
            prompt_id: Some(7),
            session_id: Some("sess"),
            version_number: None,
            ref_kind: None,
            ref_id: None,
            payload_hash: "abc",
        };
        let h1 = compute_entry_hash(GENESIS_PREV, &e);
        let h2 = compute_entry_hash(GENESIS_PREV, &e);
        assert_eq!(h1, h2, "same input → same hash");
        // A different predecessor yields a different hash (the chain binds).
        let h3 = compute_entry_hash(&h1, &e);
        assert_ne!(h1, h3);
        assert_eq!(h1.len(), 64);
    }

    #[test]
    fn changing_author_changes_hash() {
        let ev = |author| CanonicalEvent {
            seq: 1,
            ts: 1000,
            kind: "approval",
            author,
            prompt_id: None,
            session_id: Some("s"),
            version_number: None,
            ref_kind: Some("session"),
            ref_id: Some("s"),
            payload_hash: "p",
        };
        assert_ne!(
            compute_entry_hash(GENESIS_PREV, &ev("alice")),
            compute_entry_hash(GENESIS_PREV, &ev("bob")),
            "author is inside the hash"
        );
    }

    #[test]
    fn agent_guard_claims_once() {
        let bh = format!("guardtest-{}", now_millis());
        assert!(!claim_agent_prompt(&bh), "unregistered → not claimed");
        register_agent_prompt(&bh);
        assert!(claim_agent_prompt(&bh), "registered → claimed");
        assert!(!claim_agent_prompt(&bh), "consume-once → second claim fails");
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
    fn drafted_guard_claims_once_with_draft_id() {
        let bh = format!("draftguard-{}", now_millis());
        assert_eq!(claim_drafted_prompt(&bh), None);
        register_drafted_prompt(&bh, "draft-7");
        assert_eq!(claim_drafted_prompt(&bh), Some("draft-7".to_string()));
        assert_eq!(claim_drafted_prompt(&bh), None, "consume-once");
    }

    #[test]
    fn decision_payload_hash_stable() {
        let a = decision_payload_hash(&[("k", "v"), ("n", "1")]);
        let b = decision_payload_hash(&[("k", "v"), ("n", "1")]);
        assert_eq!(a, b);
        let c = decision_payload_hash(&[("k", "v"), ("n", "2")]);
        assert_ne!(a, c);
    }
}
