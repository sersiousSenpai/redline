// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Redline's side of the Polis host traits (Sessions A4–A5 of the Polis
//! extraction, `docs/polis-extraction.md`).
//!
//! Polis asks its host for exactly what only the host has, through the
//! traits in `polis_core::host` and `polis_llm`; this module is every answer.
//!
//! - [`RedlineAgent`] — the memory seats' `claude -p` spawn, **unchanged**:
//!   the same `resolve_claude_bin`, the same `bridge_args` invariant block
//!   and seat flags, the same `claude_command_for_seat` (seat binary
//!   override + the agent-seat env the capture hook reads), the same
//!   `register_agent_prompt` guard, and the same stream-json drive
//!   (`claude_proc::collect_turn`, which folds the meter under the ONE
//!   accounting rule).
//! - `impl UsageSink for Database` — books a turn's cost exactly where
//!   `meter::book` always did, so the seat burn rows are unchanged.
//! - `impl HostResolver for Database` — the cross-table reads (`thread_label`,
//!   revisions, session status, decision evidence, surface shots).
//! - [`PtyIdle`], [`WallClock`], [`TauriEvents`] — the idle gate, the clock
//!   and the event bus the keeper's gardener step runs against.
//! - [`polis_for`] — the borrowed [`Polis`] view every shim builds from a
//!   `&Database`; [`install_polis`] / [`polis_handle`] — the owned
//!   [`PolisHandle`] (the `MemoryApi`) the router and MCP mount hold (A6).
//!
//! `RedlineIngest` (the `IngestObserver`) lands with the ingest route in A6.

use std::sync::{Arc, OnceLock};

use polis_core::host::{Change, Clock, GardenerEvents, HostResolver, IdleSignal};
use polis_llm::{async_trait, Agent, AgentError, AgentReply, AgentRequest, Usage, UsageSink};
use polis_memory::{Polis, PolisHandle};
use tauri::{AppHandle, Emitter};

use crate::db::Database;
use crate::meter::TurnMeter;
use crate::state::SessionStatus;

// ---------------------------------------------------------------------------
// The agent
// ---------------------------------------------------------------------------

/// The memory seats' `claude` spawn, as an [`Agent`].
#[derive(Debug, Default, Clone, Copy)]
pub struct RedlineAgent;

#[async_trait]
impl Agent for RedlineAgent {
    fn name(&self) -> &'static str {
        "redline-claude-cli"
    }

    async fn run(&self, req: AgentRequest) -> Result<AgentReply, AgentError> {
        let claude_bin = tokio::task::spawn_blocking(crate::claude_proc::resolve_claude_bin)
            .await
            .map_err(|e| AgentError::spawn(e.to_string()))?;
        // A headless `-p` fires the global UserPromptSubmit hook, so the exact
        // prompt is registered with the dedup guard BEFORE the spawn —
        // otherwise the hook would capture the pass's own (huge) prompt into
        // the lake, and the next run would try to classify it.
        crate::ledger::register_agent_prompt(&req.prompt);
        let seat = req.seat.clone();
        let args = crate::claude_proc::bridge_args(&seat, req.prompt.clone(), req.resume.as_deref());
        let mut cmd = crate::claude_proc::claude_command_for_seat(&seat, &claude_bin);
        if let Some(cwd) = &req.cwd {
            cmd.current_dir(cwd);
        }
        let mut child = cmd
            .args(&args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    AgentError::unavailable(format!(
                        "could not find the `claude` CLI (looked for `{claude_bin}`). \
                         Install Claude Code, or launch Redline from a terminal."
                    ))
                } else {
                    AgentError::spawn(format!("failed to spawn the {seat}: {e}"))
                }
            })?;
        let stdout = child.stdout.take().ok_or_else(|| AgentError::spawn(format!("{seat} stdout unavailable")))?;
        let stderr = child.stderr.take().ok_or_else(|| AgentError::spawn(format!("{seat} stderr unavailable")))?;
        let out = crate::claude_proc::collect_turn(stdout, stderr).await;
        let _ = child.wait().await;
        let usage = usage_from_meter(&out.meter);
        if let Some(msg) = out.errored {
            return Err(AgentError::turn(msg, usage, out.session));
        }
        match out.final_text {
            Some(text) => Ok(polis_llm::finish(text, out.session, usage, &req)),
            None => {
                let stderr: String = out.stderr_text.chars().take(2_000).collect();
                Err(AgentError::turn(
                    if stderr.trim().is_empty() {
                        format!("{seat} produced no output")
                    } else {
                        format!("{seat} failed: {}", stderr.trim())
                    },
                    usage,
                    out.session,
                ))
            }
        }
    }
}

/// The four counters (and the observed model) off a folded meter.
pub fn usage_from_meter(m: &TurnMeter) -> Usage {
    Usage {
        model: m.model.clone(),
        input_tokens: m.input_tokens,
        output_tokens: m.output_tokens,
        cache_read_tokens: m.cache_read_tokens,
        cache_creation_tokens: m.cache_creation_tokens,
    }
}

static AGENT: OnceLock<Arc<dyn Agent>> = OnceLock::new();

/// Install the process's memory agent (setup). Idempotent: a second install
/// is ignored.
pub fn install_agent(agent: Arc<dyn Agent>) {
    let _ = AGENT.set(agent);
}

/// The memory agent — the installed one, else Redline's own (so a test that
/// never ran setup still spawns exactly what the app would).
pub fn agent() -> Arc<dyn Agent> {
    AGENT.get().cloned().unwrap_or_else(|| Arc::new(RedlineAgent))
}

// ---------------------------------------------------------------------------
// Usage → the seat burn rows
// ---------------------------------------------------------------------------

/// Books a turn's cost through `meter::book` — the same `add_seat_burn` row,
/// with the same four counters and `spawns = 1`, that every memory pass
/// booked before the trait existed.
impl UsageSink for Database {
    fn book(&self, seat: &str, usage: &Usage) {
        let m = TurnMeter::from_totals(
            usage.model.clone(),
            usage.input_tokens,
            usage.output_tokens,
            usage.cache_read_tokens,
            usage.cache_creation_tokens,
        );
        crate::meter::book(self, seat, &m);
    }
}

// ---------------------------------------------------------------------------
// The host reads
// ---------------------------------------------------------------------------

/// Cross-table reads over the app's own tables.
impl HostResolver for Database {
    fn label(&self, kind: &str, id: &str) -> Option<String> {
        self.thread_label(kind, id)
    }

    fn thread_stats(&self, kind: &str, id: &str) -> Option<(i64, Option<i64>)> {
        Database::thread_stats(self, kind, id).ok()
    }

    fn project_roots(&self) -> Vec<String> {
        self.list_project_paths().unwrap_or_default()
    }

    fn revision_markdown(&self, session: &str, version: i64) -> Option<String> {
        Database::revision_markdown(self, session, version).ok().flatten()
    }

    fn revision_title(&self, session: &str, version: i64) -> Option<String> {
        let md = HostResolver::revision_markdown(self, session, version)?;
        crate::parser::plan_title_from_markdown(&md)
    }

    fn session_status(&self, session: &str) -> Option<String> {
        let s = self.load_session(session).ok().flatten()?;
        Some(
            match s.status {
                SessionStatus::InReview => "in_review",
                SessionStatus::Approved => "approved",
                SessionStatus::Aborted => "aborted",
            }
            .to_string(),
        )
    }

    fn decision_evidence(&self, seq: i64) -> Option<String> {
        self.decision_event_context(seq).ok().flatten()
    }

    fn surface_shot_keys(&self, seqs: &[i64]) -> Vec<(i64, String)> {
        Database::surface_shot_keys(self, seqs).unwrap_or_default()
    }
}

// ---------------------------------------------------------------------------
// Idle, clock, events
// ---------------------------------------------------------------------------

/// The keeper's idle gate: the last byte any dock terminal produced.
#[derive(Debug, Default, Clone, Copy)]
pub struct PtyIdle;

impl IdleSignal for PtyIdle {
    fn last_activity_ms(&self) -> i64 {
        crate::pty::last_pty_output_ms()
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct WallClock;

impl Clock for WallClock {
    fn now_ms(&self) -> i64 {
        crate::state::now_millis()
    }
}

/// The keeper's event bus: the three window events the memory surfaces listen
/// for, plus the extension host's `ledger.changed` when the chain grew.
pub struct TauriEvents {
    app: AppHandle,
}

impl TauriEvents {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl GardenerEvents for TauriEvents {
    fn changed(&self, what: &[Change]) {
        for change in what {
            match change {
                Change::Memory | Change::Embeddings => {
                    let _ = self.app.emit("memory-changed", ());
                }
                Change::Catalog => {
                    let _ = self.app.emit("classmem-changed", ());
                }
                Change::Ledger => {
                    let _ = self.app.emit("ledger-changed", ());
                    crate::extension_host::publish(
                        redline_extension_abi::events::LEDGER_CHANGED,
                        &redline_extension_abi::events::LedgerChanged {
                            ts_ms: crate::extension_host::now_ms(),
                        },
                    );
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The views
// ---------------------------------------------------------------------------

/// The borrowed [`Polis`] every shim and command builds from a `&Database`:
/// the store it carries, the installed agent, the database as its own host
/// and usage sink, and the embedder this host selects (`embed::provider_for`,
/// re-read per call so a pasted cloud key takes effect on the next tick —
/// as it always did).
pub fn polis_for(db: &Database) -> Polis<'_> {
    Polis::new(db, Some(agent()), db, db).with_embedder(crate::embed::provider_for(db))
}

static POLIS: OnceLock<Arc<PolisHandle>> = OnceLock::new();

/// Install the owned handle (setup) — what the router and the MCP mount
/// serve as `MemoryApi` (A6). Idempotent.
pub fn install_polis(db: Arc<Database>) {
    let embedder = crate::embed::provider_for(&db);
    let handle = PolisHandle::new(db.polis_store(), Some(agent()), db.clone(), db).with_embedder(embedder);
    let _ = POLIS.set(Arc::new(handle));
}

/// The installed handle, if setup ran. Consumed by the router and the MCP
/// mount in A6.
#[allow(dead_code)]
pub fn polis_handle() -> Option<Arc<PolisHandle>> {
    POLIS.get().cloned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use polis_core::MemoryApi;

    /// The booking seam must be lossless: what `meter::book` reads off a
    /// reconstructed meter is exactly what it read off the observed one.
    #[test]
    fn usage_round_trips_through_the_meter_without_changing_a_booking() {
        let mut observed = TurnMeter::new();
        let line: serde_json::Value = serde_json::json!({
            "type": "result", "subtype": "success", "is_error": false, "result": "ok",
            "usage": {"input_tokens": 120, "output_tokens": 30, "cache_read_input_tokens": 400, "cache_creation_input_tokens": 50},
            "modelUsage": {"claude-sonnet-5": {"contextWindow": 200000}}
        });
        observed.observe(&line);
        let usage = usage_from_meter(&observed);
        let rebuilt = TurnMeter::from_totals(
            usage.model.clone(),
            usage.input_tokens,
            usage.output_tokens,
            usage.cache_read_tokens,
            usage.cache_creation_tokens,
        );
        assert_eq!(observed.total_tokens(), rebuilt.total_tokens());
        assert_eq!(observed.is_empty(), rebuilt.is_empty());
        assert_eq!(
            (rebuilt.input_tokens, rebuilt.output_tokens, rebuilt.cache_read_tokens, rebuilt.cache_creation_tokens),
            (observed.input_tokens, observed.output_tokens, observed.cache_read_tokens, observed.cache_creation_tokens)
        );
        assert!(TurnMeter::from_totals(None, 0, 0, 0, 0).is_empty());
    }

    #[test]
    fn the_database_answers_the_host_traits() {
        let db = Database::open_in_memory().unwrap();
        let host: &dyn HostResolver = &db;
        assert_eq!(host.session_status("nope"), None);
        assert_eq!(host.revision_title("nope", 1), None);
        assert_eq!(host.decision_evidence(999), None);
        assert!(host.project_roots().is_empty());
        assert!(host.surface_shot_keys(&[1, 2]).is_empty());
        assert_eq!(host.label("browser", "t"), None);
        let polis = polis_for(&db);
        assert_eq!(polis.agent.as_ref().map(|a| a.name()), Some("redline-claude-cli"));
    }

    #[test]
    fn the_owned_handle_serves_memory_api_over_the_same_store() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let handle = PolisHandle::new(db.polis_store(), None, db.clone(), db.clone());
        let api: &dyn MemoryApi = &handle;
        assert!(api.verify().unwrap().ok);
        assert!(api.tree(&polis_core::api::TreeRequest::default()).unwrap().is_empty());
    }

    #[test]
    fn the_default_agent_is_redlines_own() {
        assert_eq!(agent().name(), "redline-claude-cli");
    }

    /// Session A5's gate: the gardener's step over a COPY of the live
    /// database, twenty ticks, no model — the gates evaluate, the
    /// deterministic tiers run, nothing errors, nothing lands on the chain,
    /// and the chain stays green.
    ///
    /// ```text
    /// REDLINE_REAL_DB=/tmp/real.db cargo test --lib real_db_gardener -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "needs REDLINE_REAL_DB pointing at a copy of a live database"]
    fn real_db_gardener_ticks_behave() {
        use polis_core::host::{Clock, GardenerEvents, IdleSignal};
        use polis_memory::gardener::{step, Gate, GardenerConfig, GardenerState};
        let Ok(path) = std::env::var("REDLINE_REAL_DB") else {
            eprintln!("set REDLINE_REAL_DB to a COPY of a live redline.db");
            return;
        };
        struct Idle;
        impl IdleSignal for Idle {
            fn last_activity_ms(&self) -> i64 {
                0
            }
        }
        struct Now(std::sync::Mutex<i64>);
        impl Clock for Now {
            fn now_ms(&self) -> i64 {
                *self.0.lock().unwrap()
            }
        }
        struct Quiet;
        impl GardenerEvents for Quiet {
            fn changed(&self, _what: &[Change]) {}
        }
        let db = Database::open(std::path::Path::new(&path)).unwrap();
        let events_before = db.max_ledger_seq().unwrap();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let mut polis = polis_for(&db);
        polis.agent = None; // never spend tokens from a test
        polis.embedder = None;
        let clock = Now(std::sync::Mutex::new(crate::state::now_millis()));
        let mut state = GardenerState::default();
        let cfg = GardenerConfig::default();
        let mut gates = Vec::new();
        for _ in 0..20 {
            let o = rt.block_on(step(&polis, &mut state, &Idle, &clock, &cfg, &Quiet));
            gates.push(o.gate);
            *clock.0.lock().unwrap() += cfg.min_interval_ms + 1;
        }
        assert!(gates.iter().all(|g| matches!(g, Gate::Ran | Gate::NothingNew | Gate::Debounced)));
        assert_eq!(db.max_ledger_seq().unwrap(), events_before, "no model → nothing appended");
        assert!(db.verify_ledger_chain().unwrap().ok);
        eprintln!("real_db_gardener_ticks_behave: gates={gates:?} events={events_before}");
    }
}
