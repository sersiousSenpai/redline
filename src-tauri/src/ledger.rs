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

use serde::Serialize;
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

/// A materialized ledger row, returned by append and list.
#[derive(Debug, Clone, Serialize)]
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
// Public record entry points
// ---------------------------------------------------------------------------

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
    };
    let prompt_id = match db.insert_prompt(&row).map_err(|e| e.to_string())? {
        Some(id) => id,
        None => return Ok(None), // dedup: identical (body, claude session) already stored
    };
    let author = local_author();
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
pub fn record_agent_prompt(
    db: &Database,
    source: PromptSource,
    surface: &str,
    body: &str,
    project_path: Option<String>,
    session_id: Option<String>,
    mission_id: Option<String>,
) {
    register_agent_prompt(&body_hash(body));
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
    };
    if let Err(e) = record_prompt(db, input) {
        tracing::warn!(error = %e, surface, "failed to record agent prompt to ledger");
    }
}

/// Emit a ledger event for a plan revision. Idempotent per
/// `(session_id, version_number, payload_hash)` — a re-received identical
/// revision does not spam the chain. Returns the new seq, or `None` if skipped.
pub fn record_revision_event(
    db: &Database,
    session_id: &str,
    version_number: i64,
    raw_plan_markdown: &str,
) -> Result<Option<i64>, String> {
    let ph = body_hash(raw_plan_markdown);
    if db
        .revision_event_exists(session_id, version_number, &ph)
        .map_err(|e| e.to_string())?
    {
        return Ok(None);
    }
    let author = local_author();
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
    fn decision_payload_hash_stable() {
        let a = decision_payload_hash(&[("k", "v"), ("n", "1")]);
        let b = decision_payload_hash(&[("k", "v"), ("n", "1")]);
        assert_eq!(a, b);
        let c = decision_payload_hash(&[("k", "v"), ("n", "2")]);
        assert_ne!(a, c);
    }
}
