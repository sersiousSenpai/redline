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
//! - [`RedlineIngest`] — the capture route's `IngestObserver` (A6): every
//!   fork of `POST /v1/prompts/ingest` that was Redline's and not the
//!   memory's — the restore-trigger answer, the agent-seat header, the
//!   launch and orchestration handoffs, the project registry, the capture
//!   setting, the transcript backfill. The bodies are the old handler's.

use std::sync::{Arc, OnceLock};

use polis_core::api::ThreadMessage;
use polis_core::host::{
    Change, Clock, GardenerEvents, HostResolver, IdleSignal, IngestContext, IngestHeaders,
    IngestObserver,
};
use polis_core::ledger::Origin;
use polis_llm::{async_trait, Agent, AgentError, AgentReply, AgentRequest, Usage, UsageSink};
use polis_memory::{Polis, PolisHandle};
use tauri::{AppHandle, Emitter, Manager};

use crate::db::Database;
use crate::ledger;
use crate::meter::TurnMeter;
use crate::state::SessionStatus;
use crate::SessionStore;

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
        let args =
            crate::claude_proc::bridge_args(&seat, req.prompt.clone(), req.resume.as_deref());
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
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AgentError::spawn(format!("{seat} stdout unavailable")))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| AgentError::spawn(format!("{seat} stderr unavailable")))?;
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
    AGENT
        .get()
        .cloned()
        .unwrap_or_else(|| Arc::new(RedlineAgent))
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
        Database::revision_markdown(self, session, version)
            .ok()
            .flatten()
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

    /// The per-surface `*_messages` tables are Redline's; the thread route
    /// (`polis_server`'s since A6) reads them through here. A store error
    /// reads as "no such thread" — the route 404s rather than 502s, which is
    /// the same answer its callers get for a kind Redline has no table for.
    fn thread_messages(&self, kind: &str, id: &str, limit: i64) -> Option<Vec<ThreadMessage>> {
        self.load_thread_generic(kind, id, limit)
            .ok()
            .flatten()
            .map(|msgs| {
                msgs.into_iter()
                    .map(|m| ThreadMessage {
                        role: m.role,
                        body: m.body,
                        created_at: m.created_at,
                    })
                    .collect()
            })
    }
}

// ---------------------------------------------------------------------------
// The capture route's observer
// ---------------------------------------------------------------------------

/// Redline's side of `POST /v1/prompts/ingest` (served by `polis_server`
/// since A6): what the handler did that was Redline's and not the memory's.
/// The route calls these in its fixed order (`IngestObserver`'s docs); each
/// body is the old handler's block, verbatim, with the handler's locals
/// (`app_state.store`, `app_state.app_handle`, `claude_session_id`, `v`,
/// `cwd`) read off `self` and the [`IngestContext`].
pub struct RedlineIngest {
    app: AppHandle,
    store: SessionStore,
}

impl RedlineIngest {
    pub fn new(app: AppHandle, store: SessionStore) -> Self {
        Self { app, store }
    }
}

/// Share launch lineage binding between prompt capture and native providers
/// whose first reliable event is their completed plan.
pub fn bind_launch_lineage(store: &SessionStore, sid: &str, bh: &str, v: &serde_json::Value) {
    if let Some(claim) = ledger::claim_plan_launch(bh) {
        let db = store.database();
        // Bind the launch-time prompt row (recorded with no claude
        // session — claude hadn't spawned) to the session that now runs
        // it, then let the transcript stamp its model. This is the seam
        // that makes launched prompts reachable by the model backfill at
        // all, and it applies to every door: only the doors that own a
        // thread — a Drafter document, or a chat that graduated — carry
        // one to bind through.
        // The row's own hash when the door recorded something other
        // than what it typed (Combine), otherwise the guard key —
        // `None` is "same as the guard key", so the four original
        // doors resolve to exactly `bh` as before. Applied in BOTH
        // arms so the two can never drift, even though only the
        // threadless arm is reachable from Combine today.
        let row_key = claim.row_hash.as_deref().unwrap_or(bh);
        let bound = match claim.thread.as_ref() {
            Some((kind, id)) => {
                if let Err(e) = ledger::record_session_link(&db, "session", sid, kind, id) {
                    tracing::warn!(error = %e, kind = %kind, "failed to link launched session to its origin thread");
                }
                db.bind_threaded_prompt_session(row_key, kind, id, sid)
            }
            None => db.bind_launch_prompt_session(row_key, sid),
        };
        if let Err(e) = bound {
            tracing::warn!(
                error = %e, origin = %claim.origin,
                "failed to bind launch prompt to its session"
            );
        }
        crate::backfill_from_transcript(&db, v, sid);
    }
}

impl IngestObserver for RedlineIngest {
    /// A restore trigger, answered with the protocol the visible prompt no
    /// longer carries. This is the ONE fire per restore where that is true:
    /// the metadata rides the resumed `claude`'s environment, so it is on every
    /// prompt that session ever submits, and only the arming — placed by the
    /// click that dispatched the command — says which of them Redline wrote.
    /// Claiming it here is therefore both the answer and the exclusion: the
    /// trigger never reaches the lake, and the reviewer's own next prompt in
    /// that same terminal is captured byte-for-byte as it always was.
    fn intercept(&self, cx: &IngestContext<'_>) -> Option<serde_json::Value> {
        // Capture runs before the first plan creates a ReviewSession. Bind its
        // unique launch token now; handle_plan_core consumes the chosen fields
        // after creating the session. Ambiguous legacy body hashes never bind.
        if let Some(sid) = cx.session_id {
            crate::plan_launch::bind_prompt(
                cx.headers.get(crate::plan_launch::HEADER),
                &ledger::body_hash(cx.prompt.trim()),
                sid,
                cx.payload
                    .get("redline_provider")
                    .and_then(serde_json::Value::as_str),
                cx.cwd.unwrap_or(""),
            );
        }
        crate::restore_context::answer_with(cx.headers, cx.prompt)
    }

    /// The spawning Agent Seat, off the header the capture command forwards
    /// from the spawned `claude`'s own environment (`hook::CAPTURE_AGENT_HEADER`).
    fn agent_seat(&self, headers: &dyn IngestHeaders) -> Option<String> {
        headers
            .get(crate::hook::CAPTURE_AGENT_HEADER)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    }

    /// Every seat but one means "machine text, skip it". The restore seat is the
    /// exception, and only because its variable outlives its one prompt: the
    /// intercept already claimed the trigger, so a `restore`-seated fire that
    /// reaches here is the reviewer typing in a terminal Redline happened to
    /// open for them. Suppressing it would quietly delete their prompts from
    /// their own lake.
    fn seat_suppresses(&self, seat: &str) -> bool {
        seat != crate::restore_context::RESTORE_SEAT
    }

    fn on_agent_prompt_skipped(&self, cx: &IngestContext<'_>, bh: &str) {
        let claude_session_id = cx.session_id;
        let v = cx.payload;
        let cwd = cx.cwd;
        // The draft→launched-session handoff: this hook fire is the first
        // moment the spawned session's claude id is known. When the skipped
        // body was a drafter launch, link the new session under its draft —
        // the seam the whole temporal hierarchy hinges on.
        if let Some(sid) = claude_session_id {
            bind_launch_lineage(&self.store, sid, bh, v);
        }
        // The Orchestrate handoff, same seam: when the skipped body was an
        // Orchestrate launch, this hook fire is the first moment the
        // orchestrator session's claude id is known — link it under the plan
        // session it executes, and flip the run chip to `running` (the claim
        // itself proves the orchestrator came up, so the beacon fires even if
        // the payload carried no session id for the lineage row).
        if let Some(plan_sid) = ledger::claim_orchestration_prompt(bh) {
            if let Some(sid) = claude_session_id {
                let db = self.store.database();
                if let Err(e) =
                    ledger::record_session_link(&db, "session", sid, "session", &plan_sid)
                {
                    tracing::warn!(error = %e, "failed to link orchestrator session to its plan session");
                }
                // The one moment the orchestrator's transcript path is in
                // hand: anchor the run for the live monitor and start its
                // watcher. Runs execute in arbitrary project dirs — the path
                // must come from the payload, never be assumed under a
                // Redline project key.
                if let Some(tp) = v
                    .get("transcript_path")
                    .and_then(serde_json::Value::as_str)
                    .filter(|p| !p.is_empty())
                {
                    // Fold the launch-time terminal stash into the durable
                    // row (B5) — the one moment the row exists to hold it.
                    let launch_terminal = self
                        .app
                        .try_state::<crate::LaunchedTerminals>()
                        .and_then(|l| l.get(&plan_sid));
                    match db.upsert_orchestration(
                        &plan_sid,
                        sid,
                        tp,
                        cwd,
                        launch_terminal.as_deref(),
                    ) {
                        Ok(()) => {
                            crate::runwatch::start(&self.app, self.store.clone(), plan_sid.clone())
                        }
                        Err(e) => {
                            tracing::warn!(error = %e, "failed to anchor orchestration for the run monitor")
                        }
                    }
                }
            }
            crate::advance_run_state(&self.app, &self.store, &plan_sid, "running");
        }
    }

    fn classify_origin(&self, cwd: Option<&str>) -> Origin {
        crate::classify_prompt_origin(&self.store.database(), cwd)
    }

    /// External-session capture toggle (default on).
    fn capture_external(&self) -> bool {
        self.store
            .database()
            .get_setting("redline.capture.externalSessions")
            .map(|val| val != "false")
            .unwrap_or(true)
    }

    /// After the row exists: stamp this session's still-unstamped prompts from
    /// the transcript tail. A brand-new session has no assistant turn yet — its
    /// model lands on the next fire.
    fn on_recorded(&self, cx: &IngestContext<'_>, _seq: Option<i64>) {
        if let Some(sid) = cx.session_id {
            crate::backfill_from_transcript(&self.store.database(), cx.payload, sid);
        }
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

/// This install's identity (Session E2 of the Polis extraction, plan §4.5):
/// the Ed25519 key at `<app-data-dir>/polis/identity.key` — the same place
/// `polis init --from-redline <app-data-dir>` looks, so the CLI and this app
/// are ONE device on ONE chain. `None` until [`install_identity`] ran (tests,
/// and the window before setup).
static IDENTITY: OnceLock<Arc<polis_memory::identity::Identity>> = OnceLock::new();

/// Load or create the key under `data_dir/polis/`, adopt the store under it
/// (idempotent: aliases for every legacy author string, the device's ONE
/// `principal_bind`, the scope stamp — a second boot seeds, binds and stamps
/// nothing), and make the identity reachable to every record site. Its own
/// explicit step, never inside attach: attach appends nothing
/// (`real_db_attach_is_a_noop`); the first adoption appends exactly the bind.
pub fn install_identity(
    data_dir: &std::path::Path,
    db: &Database,
) -> Result<polis_memory::identity::AdoptReport, String> {
    use polis_memory::identity::{adopt, default_device_name, login_name, Identity};
    let dir = data_dir.join("polis");
    let (identity, created) = Identity::load_or_create(&dir, default_device_name())?;
    let identity = Arc::new(identity);
    let report = adopt(&db.polis_store(), &identity, &login_name())?;
    tracing::info!(
        key = %dir.join(polis_memory::identity::KEY_FILE).display(),
        created_key = created,
        principal = %identity.fingerprint(),
        device = %polis_core::identity::fingerprint(&identity.device_id()),
        device_name = %identity.device_name,
        bind_seq = ?report.bind_seq,
        bind_appended = !report.already_bound,
        aliases_seeded = report.aliases_seeded.len(),
        principals_seeded = report.principals_seeded,
        stamped = report.stamped,
        "polis identity adopted"
    );
    let _ = IDENTITY.set(identity);
    Ok(report)
}

/// The installed identity, if setup ran.
pub fn identity() -> Option<Arc<polis_memory::identity::Identity>> {
    IDENTITY.get().cloned()
}

/// The author a seat's own writes carry: `agent:<seat>` under this device
/// once an identity exists, the seat's name until then (the alias table
/// resolves the legacy string either way).
pub fn agent_author(seat: &str) -> String {
    match identity() {
        Some(id) => {
            if let Some(handle) = polis_handle() {
                if let Err(e) = polis_memory::identity::ensure_agent(&handle.store, &id, seat) {
                    tracing::warn!(error = %e, seat, "could not register the seat's agent principal");
                }
            }
            id.agent_id(seat)
        }
        None => seat.to_string(),
    }
}

/// Install the owned handle (setup) — what the router and the MCP mount
/// serve as `MemoryApi` (A6), writing as this install's identity when
/// [`install_identity`] ran first (E2). Idempotent.
pub fn install_polis(db: Arc<Database>) {
    let embedder = crate::embed::provider_for(&db);
    let handle = PolisHandle::new(db.polis_store(), Some(agent()), db.clone(), db)
        .with_embedder(embedder)
        .with_identity(identity());
    let _ = POLIS.set(Arc::new(handle));
}

/// The installed handle, if setup ran — what `AppState.polis` serves as the
/// router's `MemoryApi` (and the MCP mount's, E1).
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
            (
                rebuilt.input_tokens,
                rebuilt.output_tokens,
                rebuilt.cache_read_tokens,
                rebuilt.cache_creation_tokens
            ),
            (
                observed.input_tokens,
                observed.output_tokens,
                observed.cache_read_tokens,
                observed.cache_creation_tokens
            )
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
        assert_eq!(
            polis.agent.as_ref().map(|a| a.name()),
            Some("redline-claude-cli")
        );
    }

    #[test]
    fn the_owned_handle_serves_memory_api_over_the_same_store() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let handle = PolisHandle::new(db.polis_store(), None, db.clone(), db.clone());
        let api: &dyn MemoryApi = &handle;
        assert!(api.verify().unwrap().ok);
        assert!(api
            .tree(&polis_core::api::TreeRequest::default())
            .unwrap()
            .is_empty());
    }

    /// E2: adoption is idempotent — one `principal_bind` after the first
    /// call, none after the second — and the alias table resolves the login
    /// to the device and a seat to its agent. Runs against the library
    /// directly (the `OnceLock` is process-global, so the boot installer is
    /// exercised by the app, not here).
    #[test]
    fn adoption_binds_once_and_resolves_the_login_and_the_seats() {
        use polis_memory::identity::{adopt, Identity};
        let db = Database::open_in_memory().unwrap();
        crate::classmem::record_curate(&db, "classifier", "cn-x", "organize", "");
        let dir = std::env::temp_dir().join(format!(
            "redline-identity-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let (identity, created) = Identity::load_or_create(&dir, "test-box").unwrap();
        assert!(created);
        let store = db.polis_store();
        let head_before = store.chain_head().unwrap().0;
        let first = adopt(&store, &identity, "yusuf").unwrap();
        assert!(!first.already_bound);
        let (head, _) = store.chain_head().unwrap();
        assert_eq!(head, head_before + 1, "exactly the bind was appended");
        let top = store.list_ledger_events_asc(head - 1, 1).unwrap().remove(0);
        assert_eq!(top.kind, "principal_bind");
        assert_eq!(top.author, identity.device_id());
        let second = adopt(&store, &identity, "yusuf").unwrap();
        assert!(second.already_bound && second.aliases_seeded.is_empty() && second.stamped == 0);
        assert_eq!(
            store.chain_head().unwrap().0,
            head,
            "a second adoption appends nothing"
        );
        assert_eq!(
            store.resolve_author("yusuf").unwrap().as_deref(),
            Some(identity.device_id().as_str())
        );
        assert_eq!(
            store.resolve_author("classifier").unwrap().as_deref(),
            Some(identity.agent_id("classifier").as_str())
        );
        // A seat that has never written has its agent PRINCIPAL (seeded as a
        // builtin) but no alias row yet — aliases are for author strings the
        // lake has actually seen; `agent_author("keeper")` writes the id.
        assert!(store
            .get_principal(&identity.agent_id("keeper"))
            .unwrap()
            .is_some());
        assert_eq!(store.resolve_author("keeper").unwrap(), None);
        assert!(db.verify_ledger_chain().unwrap().ok);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The boot path's adoption on a COPY of the live database
    /// (`REDLINE_REAL_DB=<copy>`): what `install_identity` reports on first
    /// boot — the bind appended, every legacy author aliased, the rows
    /// stamped — and that the chain still verifies. Ignored: it needs the
    /// copy and it sets the process-global identity.
    #[test]
    #[ignore]
    fn real_db_install_identity_reports() {
        let Ok(path) = std::env::var("REDLINE_REAL_DB") else {
            eprintln!("set REDLINE_REAL_DB to a COPY of a live redline.db");
            return;
        };
        let db = Database::open(std::path::Path::new(&path)).unwrap();
        let store = db.polis_store();
        let before = store.chain_head().unwrap().0;
        let authors = store.distinct_authors().unwrap();
        let data_dir =
            std::env::temp_dir().join(format!("redline-identity-real-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data_dir);
        let t0 = std::time::Instant::now();
        let report = install_identity(&data_dir, &db).unwrap();
        let ms = t0.elapsed().as_millis();
        let (head, _) = store.chain_head().unwrap();
        assert_eq!(head, before + 1, "the first boot appends exactly the bind");
        assert!(!report.already_bound);
        assert!(db.verify_ledger_chain().unwrap().ok);
        let unresolved: Vec<_> = authors
            .iter()
            .filter(|a| store.resolve_author(a).unwrap().is_none())
            .cloned()
            .collect();
        assert!(unresolved.is_empty(), "unaliased authors: {unresolved:?}");
        assert!(data_dir
            .join("polis")
            .join(polis_memory::identity::KEY_FILE)
            .exists());
        // the user's writes now carry the device id; a seat's its agent id
        assert_eq!(crate::ledger::local_author(), report.device);
        assert_eq!(
            agent_author("keeper"),
            identity().unwrap().agent_id("keeper")
        );
        eprintln!(
            "real_db_install_identity: events {before} → {head} · authors {} · aliases +{} · principals +{} · stamped {} · unscoped {:?} · bind #{:?} · {} ms · key {}",
            authors.len(),
            report.aliases_seeded.len(),
            report.principals_seeded,
            report.stamped,
            report.unscoped,
            report.bind_seq,
            ms,
            data_dir.join("polis").display()
        );
        let _ = std::fs::remove_dir_all(&data_dir);
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
        use polis_memory::gardener::{step, GardenerConfig, GardenerState, Gate};
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
        assert!(gates
            .iter()
            .all(|g| matches!(g, Gate::Ran | Gate::NothingNew | Gate::Debounced)));
        // No model: the deterministic filing tier (C1, R12) may still file the
        // lake's unorganized items under their root's `~inbox` (a `class_curate`
        // event per filing), and the keeper's compaction may gist a cold prompt
        // by rule (a `compaction` event) — the two kinds a model-less pass may
        // append. Nothing structural, nothing twice: after the first pass that
        // found work, the rest must see nothing new.
        let events_after = db.max_ledger_seq().unwrap();
        let appended: Vec<String> = db
            .list_ledger_events_asc(events_before, 10_000)
            .unwrap()
            .into_iter()
            .map(|e| e.kind)
            .collect();
        assert!(
            appended.iter().all(|k| k == "class_curate" || k == "compaction"),
            "a model-less pass appended {appended:?} — only inbox filings (class_curate) and rule-gisted compactions are allowed"
        );
        let first_ran = gates.iter().position(|g| matches!(g, Gate::Ran));
        if let Some(i) = first_ran {
            assert!(
                !gates[i + 1..].iter().any(|g| matches!(g, Gate::Ran)),
                "the filing tier ran more than once on the same lake: {gates:?}"
            );
        }
        assert!(db.verify_ledger_chain().unwrap().ok);
        eprintln!(
            "real_db_gardener_ticks_behave: gates={gates:?} events={events_before}→{events_after} appended={}",
            appended.len()
        );
    }
}
