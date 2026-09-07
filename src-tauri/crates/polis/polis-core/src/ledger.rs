// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The pure half of the append-only, hash-chained, author-attributed ledger:
//! hashing, the canonical event, the event kinds and row types, the chain
//! verdict and the consume-once guards. No I/O — the store (`polis-store`)
//! appends and verifies with these, and a bundle can be verified from this
//! module alone.
//!
//! ```text
//! entry_hash = sha256( prev_hash ‖ canonical-json(event) )
//! genesis prev = 64 zeros
//! ```
//!
//! Lifted byte-for-byte from Redline's `ledger.rs` in Session A1 of the Polis
//! extraction; the hash fixtures in the tests below pin that nothing moved.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Genesis predecessor hash: 64 hex zeros (32 zero bytes).
pub const GENESIS_PREV: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// Where a captured prompt came from — recorded as fact, never inferred.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptSource {
    /// The global `UserPromptSubmit` hook (interactive PTY plan sessions +
    /// external sessions).
    Hook,
    /// A plan launch through any of Redline's three doors — the Front Door, the
    /// Prompt Drafter, or the browser's Send (`record_plan_launch` command).
    /// The wire value stays `drafter_launch` because it is stored in the lake;
    /// which door it came through is `surface`, not this.
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

/// What KIND of text a lake row is — the corpus's own composition, as opposed
/// to `PromptSource` (which mechanism captured it) or `Origin` (whose session it
/// belonged to). Three values, exhaustively:
///
/// - `User` — a human typed it. This is the signal the lake exists to hold.
/// - `Agent` — Redline constructed it. A first-turn preface, a framing wrapper,
///   a queued-run instruction: our own words, addressed to a model.
/// - `System` — the CLI injected it. `<task-notification>` and
///   `<system-reminder>` fire `UserPromptSubmit` exactly as a keystroke does.
///
/// Kept as a required field on `PromptInput` rather than an `Option`: the column
/// existed and was NULL on all 1,213 rows, and that silence is precisely how the
/// corpus reached 92.6% machine text without anyone seeing it. A new row must
/// say what it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CorpusRole {
    User,
    Agent,
    System,
}

impl CorpusRole {
    pub fn as_str(self) -> &'static str {
        match self {
            CorpusRole::User => "user",
            CorpusRole::Agent => "agent",
            CorpusRole::System => "system",
        }
    }

    /// The prefixes the CLI's own injections open with. `UserPromptSubmit` fires
    /// for these as it does for typing, so the hook path is the only place they
    /// can be told apart — by their shape, which is stable and documented.
    pub const SYSTEM_PREFIXES: [&'static str; 2] = ["<task-notification>", "<system-reminder>"];

    /// Classify a hook-captured payload. Only ever `System` or `User`: an
    /// agent-constructed body never reaches this path (the guard and the
    /// `X-Redline-Agent` header both skip it upstream), and inferring `Agent`
    /// from shape here would relabel a user who quotes a preface.
    pub fn classify_captured(body: &str) -> CorpusRole {
        let head = body.trim_start();
        if Self::SYSTEM_PREFIXES.iter().any(|p| head.starts_with(p)) {
            CorpusRole::System
        } else {
            CorpusRole::User
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
    /// Work graph: a work item was filed. References the `work_items` row by
    /// `(ref_kind="work_item", ref_id=item id)` — provenance, never a foreign
    /// key: the item row (and this event) outlive whatever origin filed it.
    /// Commits to `(item, action, actor, detail, at)` via `payload_hash`.
    WorkFile,
    /// Work graph: a work item was claimed (an assignee took the lease).
    /// Same reference + payload shape as [`EventKind::WorkFile`].
    WorkClaim,
    /// Work graph: a work item was closed (done / wontfix / superseded — the
    /// reason rides in the payload). Same shape as [`EventKind::WorkFile`].
    WorkClose,
    /// Moot: one participant's turn in a bounded, on-the-record multi-agent
    /// conversation convened on a single work item (`moot.rs`). References the
    /// subject item by `(ref_kind="work_item", ref_id=item id)` — the
    /// `record_work_event` shape: provenance, never a foreign key — and
    /// commits to `(item, moot, round, seat, digest, at)` via `payload_hash`,
    /// where `digest` is the content hash of the turn's text. The readable
    /// transcript lives in the moot's Bookshelf document; this event is what
    /// makes every turn tamper-evident even after the document is edited.
    MootTurn,
    /// SHADOW attention router: the AI pre-review pass's triage verdict for one
    /// code review — `auto` or `attend`, recorded and NEVER acted on. Distinct
    /// from [`EventKind::ReviewVerdict`] (the HUMAN's annotation resolution) on
    /// purpose: a machine verdict must never enter the decision stream
    /// ClassMemory retrieves as "what the user decided". References the review
    /// by `(ref_kind="code_review", ref_id=review id)` and commits to
    /// `{review, verdict, reason, signals, bar, cited_seq, at}` via
    /// `payload_hash`; the readable sidecar lives in `app_settings` under
    /// `redline.router.verdict.<review id>`.
    RouterVerdict,
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
            EventKind::WorkFile => "work_file",
            EventKind::WorkClaim => "work_claim",
            EventKind::WorkClose => "work_close",
            EventKind::MootTurn => "moot_turn",
            EventKind::RouterVerdict => "router_verdict",
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
    pub role: &'a str,
    /// The human's own words inside an `agent` row's constructed prompt — the
    /// question the preface wraps. Non-hashed and chain-safe (the
    /// `gist`/`thread_kind` precedent): only `prompt_id` + `body_hash` enter the
    /// chained event. This is what the lexical index reads for an agent row, so
    /// a first-turn preface stops being 155 copies of searchable boilerplate
    /// while the row itself stays byte-intact for audit.
    pub user_text: Option<&'a str>,
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

/// How long a registration stays claimable. Shared by every consume-once
/// guard (agent prompts here; plan-launch and orchestration handoffs in the
/// host) so they expire on one clock.
pub const GUARD_TTL: Duration = Duration::from_secs(300);

fn agent_guard() -> &'static TtlGuard<()> {
    static G: OnceLock<TtlGuard<()>> = OnceLock::new();
    G.get_or_init(|| TtlGuard::new(GUARD_TTL))
}

/// Record that a Rust construction site is about to spawn an agent with this
/// prompt body, so the hook path can recognize and skip the duplicate.
///
/// Takes the BODY, never a hash, and keys on the *trimmed* body — deliberately,
/// and the signature is the fix. `ingest_prompt_text` trims the hook payload
/// before hashing it, while every construction site here hashed the body as
/// constructed; a prompt ending in `\n` therefore hashed two different ways and
/// could never be claimed. That single asymmetry leaked 4.32 MB of Redline's own
/// agent prefaces into the searchable lake (237 rows, the same first-turn
/// preface up to 9× over). Taking `&str` for a hash made the two spellings
/// indistinguishable at every call site; taking the body makes the trim the
/// guard's own business, once.
///
/// `every_constructed_agent_prompt_is_claimable` pins that no call site ever
/// hands this a hash again.
pub fn register_agent_prompt(body: &str) {
    agent_guard().register(body_hash(body.trim()), ());
}

/// Consume a registration: returns `true` if this body was registered by a Rust
/// site (meaning the hook ingest should skip it as an already-recorded
/// duplicate). Removes the entry so a second, genuinely-distinct hook prompt
/// with the same body is not swallowed.
pub fn claim_agent_prompt(body_hash: &str) -> bool {
    agent_guard().claim(body_hash).is_some()
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

// ---------------------------------------------------------------------------
// Consume-once guard with a TTL
// ---------------------------------------------------------------------------

/// A consume-once map with a TTL: register a value under a key, and the first
/// `claim` of that key takes it. Entries older than the TTL are pruned on
/// every access, so a registration that is never claimed cannot leak.
///
/// The agent-prompt guard above is `TtlGuard<()>`; Redline's plan-launch and
/// orchestration handoff guards are `TtlGuard<LaunchClaim>` and
/// `TtlGuard<String>` over the same mechanism — one implementation, three
/// instances, identical prune/insert/remove order to what each had hand-rolled.
pub struct TtlGuard<V> {
    map: Mutex<HashMap<String, (V, Instant)>>,
    ttl: Duration,
}

impl<V> TtlGuard<V> {
    pub fn new(ttl: Duration) -> Self {
        Self { map: Mutex::new(HashMap::new()), ttl }
    }

    fn prune(&self, map: &mut HashMap<String, (V, Instant)>) {
        let now = Instant::now();
        let ttl = self.ttl;
        map.retain(|_, (_, t)| now.duration_since(*t) < ttl);
    }

    /// Register `value` under `key`, replacing any live registration.
    pub fn register(&self, key: String, value: V) {
        let mut g = self.map.lock().unwrap();
        self.prune(&mut g);
        g.insert(key, (value, Instant::now()));
    }

    /// Consume the registration under `key`, if one is live.
    pub fn claim(&self, key: &str) -> Option<V> {
        let mut g = self.map.lock().unwrap();
        self.prune(&mut g);
        g.remove(key).map(|(v, _)| v)
    }
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
        let body = format!("guardtest-{}", now_millis());
        let bh = body_hash(&body);
        assert!(!claim_agent_prompt(&bh), "unregistered → not claimed");
        register_agent_prompt(&body);
        assert!(claim_agent_prompt(&bh), "registered → claimed");
        assert!(!claim_agent_prompt(&bh), "consume-once → second claim fails");
    }

    /// THE regression test for the lake-pollution bug. Every Rust construction
    /// site registers the body it is about to spawn with; the capture hook
    /// hashes the payload *after* trimming it. A constructed prompt that ends
    /// in a newline — most of them — hashed two different ways, so the guard
    /// never fired and the preface landed in the searchable lake anyway.
    #[test]
    fn agent_prompt_guard_is_trim_insensitive() {
        let core = format!("You are the drafter agent.\nguardtest-{}", now_millis());
        for spelling in [
            format!("{core}\n"),
            format!("{core}\n\n"),
            format!("  {core}  "),
            format!("\n{core}"),
        ] {
            register_agent_prompt(&spelling);
            // What the hook computes: `ingest_prompt_text` trims, then hashes.
            let hook_hash = body_hash(spelling.trim());
            assert!(
                claim_agent_prompt(&hook_hash),
                "the hook's trimmed hash must claim a registration made from {spelling:?}"
            );
        }
    }

    /// What the hook path may and may not conclude from a payload's shape.
    #[test]
    fn classify_corpus_role_table() {
        let cases: &[(&str, CorpusRole)] = &[
            ("<task-notification>agent finished</task-notification>", CorpusRole::System),
            ("<system-reminder>your todo list is empty</system-reminder>", CorpusRole::System),
            // Leading whitespace/newlines don't disguise an injection.
            ("\n  <system-reminder>x</system-reminder>", CorpusRole::System),
            ("add auth to the app", CorpusRole::User),
            ("", CorpusRole::User),
            // A user QUOTING an injection is still the user talking — the marker
            // has to open the payload, not merely appear in it.
            ("why do I keep seeing <system-reminder> blocks?", CorpusRole::User),
            // Shape alone never yields `Agent` here: an agent body is skipped
            // upstream by the header + guard, and guessing would relabel a user
            // who pastes a preface into their own prompt.
            ("You are Redline's memory keeper. Summarize these.", CorpusRole::User),
        ];
        for (body, want) in cases {
            assert_eq!(CorpusRole::classify_captured(body), *want, "for {body:?}");
        }
    }

    /// The chain's hash function is PINNED to a vector computed outside Rust
    /// (python: sha256(64 zeros ‖ compact JSON of the canonical fields)). This
    /// is the byte-identity gate of the extraction: if the canonical field
    /// order, the JSON spelling of `None`, or the prev‖json concatenation ever
    /// moved, every existing chain would verify red — so this test, not a
    /// re-derivation, is the referee.
    #[test]
    fn entry_hash_vector_is_pinned() {
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
        assert_eq!(
            compute_entry_hash(GENESIS_PREV, &e),
            "5e2a21400985e35191aba83b423cac31b6e65a897d78ef1470655f5123934801"
        );
    }

    #[test]
    fn ttl_guard_is_consume_once_and_prunes() {
        let g: TtlGuard<u32> = TtlGuard::new(Duration::from_millis(40));
        g.register("k".into(), 7);
        assert_eq!(g.claim("k"), Some(7));
        assert_eq!(g.claim("k"), None, "consume-once");
        g.register("k".into(), 8);
        std::thread::sleep(Duration::from_millis(60));
        assert_eq!(g.claim("k"), None, "expired registrations are pruned");
    }
}
