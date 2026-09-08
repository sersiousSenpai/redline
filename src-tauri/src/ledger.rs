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
// The record writers moved to `polis_store::record` in Session A5 (they need
// only the store and its author); every `crate::ledger::record_*` call site
// keeps its path, and a `&Database` coerces to `&PolisStore` through Deref.
#[allow(unused_imports)]
pub use polis_store::record::{
    record_browse_event, record_decision, record_moot_turn, record_prompt, record_prompt_at,
    record_revision_event, record_session_link, record_work_event, resolve_parent, BrowseAction,
    BrowseEventInput, DecisionInput, PromptInput, ThreadRef,
};
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
    // E2: once this install has an identity, the user's writes are authored
    // by the DEVICE id (plan §4.5 — never a chosen name). The login below is
    // the legacy string the alias table resolves to that same device, so
    // history and new events read as one author.
    if let Some(id) = crate::polis_host::identity() {
        return id.device_id();
    }
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
        // …as `agent:<seat>` under this device once an identity exists (E2),
        // as the seat's name until then (the alias table resolves both).
        author: Some(crate::polis_host::agent_author(surface)),
        model,
        model_source,
    };
    if let Err(e) = record_prompt(db, input) {
        tracing::warn!(error = %e, surface, "failed to record agent prompt to ledger");
    }
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
            ("polis_host.rs", include_str!("polis_host.rs")),
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
