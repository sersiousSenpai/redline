// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Redline's side of the Polis host traits (Session A4 of the Polis
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
//!   accounting rule). What the trait adds is a seam: the gardener no longer
//!   knows it is talking to a CLI.
//! - [`RedlineUsage`] — books a turn's cost exactly where `meter::book`
//!   always did, so the seat burn rows are unchanged.
//! - [`RedlineHost`] — the cross-table reads (`thread_label`, revisions,
//!   session status, decision evidence) over `Database`.
//! - [`PtyIdle`], [`WallClock`], [`TauriEvents`] — the idle gate, the clock
//!   and the event bus the keeper uses today.
//!
//! Consumed by `classmem::run_classifier` / `keeper::run_keeper_summarizer`
//! now and by the `Polis` handle from A5; `RedlineIngest` (the
//! `IngestObserver`) lands with the ingest route in A6.

#![allow(dead_code)]

use std::sync::{Arc, OnceLock};

use polis_core::host::{Change, Clock, GardenerEvents, HostResolver, IdleSignal};
use polis_llm::{async_trait, Agent, AgentError, AgentReply, AgentRequest, Usage, UsageSink};
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
pub struct RedlineUsage<'a> {
    db: &'a Database,
}

impl<'a> RedlineUsage<'a> {
    pub fn new(db: &'a Database) -> Self {
        Self { db }
    }
}

impl UsageSink for RedlineUsage<'_> {
    fn book(&self, seat: &str, usage: &Usage) {
        let m = TurnMeter::from_totals(
            usage.model.clone(),
            usage.input_tokens,
            usage.output_tokens,
            usage.cache_read_tokens,
            usage.cache_creation_tokens,
        );
        crate::meter::book(self.db, seat, &m);
    }
}

// ---------------------------------------------------------------------------
// The host reads
// ---------------------------------------------------------------------------

/// Cross-table reads over the app's own tables.
pub struct RedlineHost {
    db: Arc<Database>,
}

impl RedlineHost {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }
}

impl HostResolver for RedlineHost {
    fn label(&self, kind: &str, id: &str) -> Option<String> {
        self.db.thread_label(kind, id)
    }

    fn thread_stats(&self, kind: &str, id: &str) -> Option<(i64, Option<i64>)> {
        self.db.thread_stats(kind, id).ok()
    }

    fn project_roots(&self) -> Vec<String> {
        self.db.list_project_paths().unwrap_or_default()
    }

    fn revision_markdown(&self, session: &str, version: i64) -> Option<String> {
        self.db.revision_markdown(session, version).ok().flatten()
    }

    fn revision_title(&self, session: &str, version: i64) -> Option<String> {
        let md = self.revision_markdown(session, version)?;
        crate::parser::plan_title_from_markdown(&md)
    }

    fn session_status(&self, session: &str) -> Option<String> {
        let s = self.db.load_session(session).ok().flatten()?;
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
        self.db.decision_event_context(seq).ok().flatten()
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

#[cfg(test)]
mod tests {
    use super::*;

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
        // …and an all-zero usage stays "empty", so `book` skips it as before.
        assert!(TurnMeter::from_totals(None, 0, 0, 0, 0).is_empty());
    }

    #[test]
    fn the_host_reads_answer_over_a_real_database() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let host = RedlineHost::new(db);
        assert_eq!(host.session_status("nope"), None);
        assert_eq!(host.revision_title("nope", 1), None);
        assert_eq!(host.decision_evidence(999), None);
        assert!(host.project_roots().is_empty());
        let boxed: Box<dyn HostResolver> = Box::new(RedlineHost::new(Arc::new(Database::open_in_memory().unwrap())));
        assert_eq!(boxed.label("browser", "t"), None);
    }

    #[test]
    fn the_default_agent_is_redlines_own() {
        assert_eq!(agent().name(), "redline-claude-cli");
    }
}
