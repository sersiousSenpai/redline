// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
mod agent;
mod db;
mod feedback;
mod fork;
mod fsbrowse;
mod fswatch;
mod highlight;
mod hook;
mod parser;
#[cfg(test)]
mod perf_guard;
mod pty;
mod resolutions;
mod skill;
mod state;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use axum::{
    extract::{ConnectInfo, Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use std::net::SocketAddr;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Listener, Manager,
};
use tokio::sync::{oneshot, Notify};
use tauri_plugin_dialog::DialogExt;

use crate::db::Database;
use crate::hook::HookStatus;
use crate::skill::SkillStatus;
use crate::state::{
    now_millis, AttachState, Comment, InterceptionMode, NewCommentRequest, ReviewSession,
    SessionStatus, SessionStore, SessionSummary, SubmissionMode, UpdateCommentRequest,
};

const SETTING_MODE: &str = "interception_mode";
/// Seconds the Ambient decision window stays open before auto-approving.
const AMBIENT_WINDOW_SECS: u64 = 20;

/// Interception mode, persisted to the `app_settings` table and mirrored in memory.
#[derive(Clone)]
struct Settings {
    mode: Arc<StdMutex<InterceptionMode>>,
    db: Arc<Database>,
}

impl Settings {
    fn load(db: Arc<Database>) -> Self {
        let mode = db
            .get_setting(SETTING_MODE)
            .and_then(|s| InterceptionMode::from_str(&s))
            .unwrap_or(InterceptionMode::Active);
        Self {
            mode: Arc::new(StdMutex::new(mode)),
            db,
        }
    }
    fn get(&self) -> InterceptionMode {
        *self.mode.lock().unwrap()
    }
    fn set(&self, mode: InterceptionMode) {
        *self.mode.lock().unwrap() = mode;
        if let Err(e) = self.db.set_setting(SETTING_MODE, mode.as_str()) {
            tracing::error!(error = %e, "failed to persist interception mode");
        }
    }
}

/// Per-session "the reviewer opened this for full review" flags, used by Ambient
/// mode to convert a transient decision window into a held review.
#[derive(Clone, Default)]
struct ClaimFlags(Arc<StdMutex<HashMap<String, Arc<AtomicBool>>>>);

impl ClaimFlags {
    fn new() -> Self {
        Self::default()
    }
    fn register(&self, session_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.0
            .lock()
            .unwrap()
            .insert(session_id.to_string(), flag.clone());
        flag
    }
    /// Returns true if a decision window for this session was found and claimed.
    fn claim(&self, session_id: &str) -> bool {
        match self.0.lock().unwrap().get(session_id) {
            Some(flag) => {
                flag.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }
    fn clear(&self, session_id: &str) {
        self.0.lock().unwrap().remove(session_id);
    }
}

#[derive(Serialize, Clone, Debug)]
struct HookResponse {
    #[serde(rename = "hookSpecificOutput")]
    hook_specific_output: HookSpecificOutput,
}

#[derive(Serialize, Clone, Debug)]
struct HookSpecificOutput {
    #[serde(rename = "hookEventName")]
    hook_event_name: &'static str,
    #[serde(rename = "permissionDecision")]
    permission_decision: &'static str,
    #[serde(rename = "permissionDecisionReason")]
    permission_decision_reason: String,
}

fn allow_response(reason: impl Into<String>) -> HookResponse {
    HookResponse {
        hook_specific_output: HookSpecificOutput {
            hook_event_name: "PreToolUse",
            permission_decision: "allow",
            permission_decision_reason: reason.into(),
        },
    }
}

fn deny_response(reason: impl Into<String>) -> HookResponse {
    HookResponse {
        hook_specific_output: HookSpecificOutput {
            hook_event_name: "PreToolUse",
            permission_decision: "deny",
            permission_decision_reason: reason.into(),
        },
    }
}

/// One held POST: the oneshot to answer it, the registration token that lets
/// the drop-guard remove only its own entry, and the dock terminal the POST
/// came from (`None` = external terminal / unresolvable) — drives the
/// per-terminal "plan intercepted" strip.
struct PendingEntry {
    token: u64,
    tx: oneshot::Sender<HookResponse>,
    terminal_id: Option<String>,
}

#[derive(Clone)]
struct PendingResponses {
    map: Arc<StdMutex<HashMap<String, PendingEntry>>>,
    next_token: Arc<AtomicU64>,
    // Woken on every register() so a take_or_wait() racing the next plan can
    // wake immediately when the new POST arrives instead of polling.
    notify: Arc<Notify>,
}

impl PendingResponses {
    fn new() -> Self {
        Self {
            map: Arc::new(StdMutex::new(HashMap::new())),
            next_token: Arc::new(AtomicU64::new(1)),
            notify: Arc::new(Notify::new()),
        }
    }
    /// Register a held POST for this session. Returns the receiver to await plus
    /// a unique token identifying *this* registration — used by the drop-guard
    /// (`take_if_owned`) so a cancelled request removes only its own entry.
    fn register(
        &self,
        session_id: &str,
        terminal_id: Option<String>,
    ) -> Option<(oneshot::Receiver<HookResponse>, u64)> {
        let mut map = self.map.lock().unwrap();
        if map.contains_key(session_id) {
            return None;
        }
        let token = self.next_token.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        map.insert(
            session_id.to_string(),
            PendingEntry {
                token,
                tx,
                terminal_id,
            },
        );
        drop(map);
        self.notify.notify_waiters();
        Some((rx, token))
    }
    fn take(&self, session_id: &str) -> Option<oneshot::Sender<HookResponse>> {
        self.map.lock().unwrap().remove(session_id).map(|e| e.tx)
    }
    /// Remove and return this session's sender *iff* it is still the one
    /// registered under `token`. Used by the drop-guard: a hit means the held
    /// POST was cancelled (connection dropped) before any decision was sent.
    fn take_if_owned(
        &self,
        session_id: &str,
        token: u64,
    ) -> Option<oneshot::Sender<HookResponse>> {
        let mut map = self.map.lock().unwrap();
        match map.get(session_id) {
            Some(e) if e.token == token => map.remove(session_id).map(|e| e.tx),
            _ => None,
        }
    }
    /// The dock terminal whose `claude` this session's held POST came from.
    /// `None` when nothing is held, or the POST originated outside the dock.
    fn terminal_of(&self, session_id: &str) -> Option<String> {
        self.map
            .lock()
            .unwrap()
            .get(session_id)
            .and_then(|e| e.terminal_id.clone())
    }
    /// Like `take` but if no sender is registered yet, wait up to `timeout` for
    /// the next `register` call (for any session) and retry. Closes the race
    /// where the user clicks submit between a plan's POST arriving and its
    /// sender being registered — the second-revision silent-drop bug.
    async fn take_or_wait(
        &self,
        session_id: &str,
        timeout: Duration,
    ) -> Option<oneshot::Sender<HookResponse>> {
        if let Some(tx) = self.take(session_id) {
            return Some(tx);
        }
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            // Subscribe to the next notification BEFORE re-checking the map to
            // avoid a lost-wakeup if register() runs between our take and our
            // await.
            let notified = self.notify.notified();
            if let Some(tx) = self.take(session_id) {
                return Some(tx);
            }
            tokio::select! {
                _ = notified => continue,
                _ = tokio::time::sleep_until(deadline) => return self.take(session_id),
            }
        }
    }
    /// A POST is currently held for this session (Claude Code is blocked in
    /// its terminal). Such a session is "active" and must not be deleted.
    fn has(&self, session_id: &str) -> bool {
        self.map.lock().unwrap().contains_key(session_id)
    }
    /// Remove and return every pending sender with its session id — used to
    /// release orphaned held POSTs when the interception mode changes away
    /// from Active (the caller also settles each session's attach state).
    fn drain_all(&self) -> Vec<(String, oneshot::Sender<HookResponse>)> {
        let mut map = self.map.lock().unwrap();
        map.drain().map(|(sid, e)| (sid, e.tx)).collect()
    }
}

/// Held for the lifetime of a `handle_plan` await. On drop it removes the
/// session's pending sender *iff it is still our own* (`take_if_owned`). A hit
/// means the future was cancelled — the held POST's connection dropped (hook
/// timeout, terminal/session closed, app restart) before any decision was sent
/// — so the sender would otherwise linger as a dead channel that a later
/// `submit_review` sends into silently. We clean it up and tell the UI the
/// session has detached so it stops showing a healthy-looking review.
/// On the normal path the sender was already `take`n, so this is a no-op.
struct DetachGuard {
    pending: PendingResponses,
    app_handle: AppHandle,
    store: SessionStore,
    session_id: String,
    token: u64,
}

impl Drop for DetachGuard {
    fn drop(&mut self) {
        if self
            .pending
            .take_if_owned(&self.session_id, self.token)
            .is_some()
        {
            tracing::info!(
                session_id = %self.session_id,
                "held POST detached before a decision — releasing orphan and notifying UI"
            );
            // Persist BEFORE emitting: the event listener refreshes summaries,
            // which must already observe the detached state.
            self.store
                .set_attach_state(&self.session_id, AttachState::Detached);
            let _ = self.app_handle.emit(
                "session-detached",
                SessionEvent {
                    session_id: self.session_id.clone(),
                },
            );
        }
    }
}

/// Records, per session, the submission mode of the most recent
/// `submit_review` so the *next* inbound plan can be classified as an
/// Ask round-trip (plan body unchanged + answers in resolutions) rather
/// than a normal revision. Set by `submit_review` immediately before
/// unblocking the held hook; consumed by the next `handle_plan` for the
/// same session.
#[derive(Clone, Default)]
struct ExpectedModes(Arc<StdMutex<HashMap<String, SubmissionMode>>>);

impl ExpectedModes {
    fn new() -> Self {
        Self::default()
    }
    fn set(&self, session_id: &str, mode: SubmissionMode) {
        self.0
            .lock()
            .unwrap()
            .insert(session_id.to_string(), mode);
    }
    fn take(&self, session_id: &str) -> Option<SubmissionMode> {
        self.0.lock().unwrap().remove(session_id)
    }
}

/// Whether the daemon successfully bound `127.0.0.1:7676`. False means another
/// process holds the port, so this window can capture no plans — the UI checks
/// this on mount (and listens for `daemon-bind-failed`) to show a blocking
/// banner instead of looking healthy. Single-instance makes this rare, but a
/// non-Redline squatter on the port can still trip it.
#[derive(Clone, Default)]
struct DaemonStatus(Arc<AtomicBool>);

impl DaemonStatus {
    fn new() -> Self {
        Self::default()
    }
    fn set_bound(&self, bound: bool) {
        self.0.store(bound, Ordering::SeqCst);
    }
    fn is_bound(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

#[derive(Clone)]
struct AppState {
    store: SessionStore,
    app_handle: AppHandle,
    pending: PendingResponses,
    expected_modes: ExpectedModes,
    settings: Settings,
    claims: ClaimFlags,
    fork: fork::ForkState,
    daemon_status: DaemonStatus,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PlanReceivedEvent {
    session_id: String,
    version: u32,
    is_new_session: bool,
    /// This plan begins a new review thread (fresh, unrelated plan) rather
    /// than a revision answering reviewer feedback. See `Revision::thread_start`.
    thread_start: bool,
    resolutions_attached: usize,
    unmatched_resolution_ids: Vec<String>,
    unresolved_submitted_ids: Vec<String>,
    resolution_parse_error: Option<String>,
    /// Whether this plan is an Ask round-trip (questions answered, plan
    /// body unchanged, no version bump) or a normal Revise revision.
    mode: &'static str,
    /// Some(true) when the user submitted an Ask batch but Claude returned
    /// a plan with a changed body anyway — the UI surfaces a warning and
    /// the change is processed as a normal Revise revision.
    #[serde(skip_serializing_if = "Option::is_none")]
    ask_mode_violated: Option<bool>,
    /// This plan is a "Restore plan session" re-presentation (identical body,
    /// no version semantics) — the UI nudges about carried-over drafts.
    restored: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SessionEvent {
    session_id: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DecisionWindowEvent {
    session_id: String,
    version: u32,
    /// Absolute epoch-millis after which Ambient mode auto-approves.
    deadline_ms: i64,
    window_secs: u64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ModeEvent {
    mode: String,
}

fn refresh_tray(app: &AppHandle, store: &SessionStore) {
    let list = store.list();
    let awaiting = list.iter().filter(|s| s.awaiting_review).count();
    let pending: u32 = list
        .iter()
        .filter(|s| s.awaiting_review)
        .map(|s| s.pending_count)
        .sum();
    let tooltip = if awaiting == 0 {
        "Redline".to_string()
    } else if pending == 0 {
        format!(
            "Redline · {awaiting} active session{}",
            if awaiting == 1 { "" } else { "s" }
        )
    } else {
        format!(
            "Redline · {pending} pending comment{} across {awaiting} session{}",
            if pending == 1 { "" } else { "s" },
            if awaiting == 1 { "" } else { "s" }
        )
    };
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

async fn handle_plan(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(app_state): State<AppState>,
    Json(payload): Json<Value>,
) -> Json<HookResponse> {
    let session_id = payload
        .get("session_id")
        .and_then(|v| v.as_str())
        .unwrap_or("?")
        .to_string();
    let tool_use_id = payload
        .get("tool_use_id")
        .and_then(|v| v.as_str())
        .unwrap_or("?")
        .to_string();
    let cwd = payload
        .get("cwd")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let raw_plan = payload
        .pointer("/tool_input/plan")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let mode = app_state.settings.get();

    // Paused = killswitch: auto-approve immediately, capture nothing.
    if mode == InterceptionMode::Paused {
        tracing::info!(session_id = %session_id, tool_use_id = %tool_use_id, "Redline paused — auto-approving without capture");
        return Json(allow_response(
            "Redline is paused — this plan was auto-approved without review.",
        ));
    }

    // A fork agent (a "Discuss" thread) inherits this hook. If one ever calls
    // ExitPlanMode, the POST arrives under the fork's own session id — never
    // capture it as a plan; that would spawn a phantom review revision.
    if app_state.fork.is_known_fork_session(&session_id) {
        tracing::info!(session_id = %session_id, "ignoring ExitPlanMode POST from a known fork session");
        return Json(allow_response(
            "This plan came from a Redline discussion-thread fork; it was not captured for review.",
        ));
    }

    let resolution_result = resolutions::extract_resolutions(&raw_plan);
    // Parse and stamp every block with a stable sidecar id; the augmented
    // markdown is what we persist so block ids survive the reparse-on-load
    // model. When a previous revision exists, rebind freshly-minted v2 ids to
    // their v1 counterparts where the plain-text signature matches — this is
    // the safety net for when Claude rewrites the plan body and drops the
    // `<!-- rl:blk-… -->` markers, which would otherwise paint every block
    // as new in the diff (the 100%-highlight bug).
    let prev_sections_for_rebind: Option<Vec<state::Section>> = app_state
        .store
        .get(&session_id)
        .and_then(|s| s.revisions.last().map(|r| r.sections.clone()));
    let (sections, plan_markdown) = match &prev_sections_for_rebind {
        Some(prev) => parser::parse_plan_with_sidecars_relative_to(
            &resolution_result.stripped_markdown,
            prev,
        ),
        None => parser::parse_plan_with_sidecars(&resolution_result.stripped_markdown),
    };
    let section_count = sections.len();

    // Consume the expected mode (if any) recorded by the most recent
    // submit_review for this session. When Ask, this plan should be the
    // answer-only round-trip: same plan body, resolutions in the sidecar.
    let expected_mode = app_state.expected_modes.take(&session_id);

    let session_existed = app_state.store.has_session(&session_id);

    // Whether Claude returned the plan body unchanged vs the latest revision,
    // on a canonical text signature that ignores cosmetic markdown / sidecar
    // reflow. Drives both Ask round-trip detection and restore tagging.
    let same_as_prev = session_existed && {
        let prev_sig = app_state
            .store
            .get(&session_id)
            .and_then(|s| s.revisions.last().map(|r| parser::plan_text_signature(&r.sections)))
            .unwrap_or_default();
        let new_sig = parser::plan_text_signature(&sections);
        prev_sig == new_sig
    };

    // Ask round-trip detection: the prior submit_review was an Ask batch AND
    // Claude returned the plan body unchanged.
    let ask_round_trip = expected_mode == Some(SubmissionMode::Ask) && same_as_prev;

    // One-shot restore: the reviewer re-presented an already-reviewed plan via
    // "Restore plan session" (frontend armed the flag). Tag it only when the
    // body is genuinely unchanged; if Claude actually revised during the
    // restore, it falls through to a normal new revision (it really is one).
    // Always consume the flag so it is strictly one-shot.
    let restore_armed = app_state.store.take_restore(&session_id);
    let restored = restore_armed && same_as_prev && !ask_round_trip;

    // Ask-mode was expected but Claude modified the plan anyway. Surface
    // a soft warning to the UI and proceed as a normal Revise revision —
    // hard-failing would leave the user without their answers and the
    // terminal hung waiting for a verdict we never deliver.
    let ask_mode_violated = if expected_mode == Some(SubmissionMode::Ask) && !ask_round_trip {
        tracing::warn!(
            session_id = %session_id,
            "ask_mode_violation: Claude returned a modified plan body during an Ask round-trip"
        );
        Some(true)
    } else {
        None
    };

    // Classify BEFORE attach_resolutions mutates comment statuses. An inbound
    // plan is a *revision* (diff against the prior plan, keep its comments)
    // only if it answers feedback: it carries a REDLINE_RESOLUTIONS block, or
    // a submit_review denial is still outstanding for this session. Otherwise
    // it starts a fresh thread (clean render, empty comment pane) — this is
    // what happens when a new, unrelated plan reuses the same terminal session.
    let answers_feedback = !resolution_result.resolutions.is_empty()
        || app_state.store.has_outstanding_review(&session_id);
    let thread_start = !ask_round_trip && (!session_existed || !answers_feedback);

    // Attach resolutions. For an Ask round-trip the resolution belongs to
    // the *current* latest revision (no version bump); otherwise it
    // belongs to the next revision (existing behavior).
    let (attach_report, resolutions_attached) = if session_existed
        && !resolution_result.resolutions.is_empty()
    {
        let appeared_in_version = if ask_round_trip {
            app_state
                .store
                .get(&session_id)
                .and_then(|s| s.revisions.last().map(|r| r.version_number))
                .unwrap_or(1)
        } else {
            app_state
                .store
                .get(&session_id)
                .map(|s| s.revisions.len() as u32 + 1)
                .unwrap_or(1)
        };
        let report = app_state.store.attach_resolutions(
            &session_id,
            &resolution_result.resolutions,
            appeared_in_version,
        );
        (report, resolution_result.resolutions.len())
    } else {
        (Default::default(), 0)
    };

    // Skip upsert_plan for an Ask round-trip — the latest revision is the
    // same plan, just with resolutions attached.
    let (version_number, is_new_session) = if ask_round_trip {
        let latest = app_state
            .store
            .get(&session_id)
            .and_then(|s| s.revisions.last().map(|r| r.version_number))
            .unwrap_or(1);
        (latest, false)
    } else {
        let upsert = app_state.store.upsert_plan(
            &session_id,
            &cwd,
            plan_markdown,
            sections,
            thread_start,
            restored,
        );
        (upsert.version_number, upsert.is_new_session)
    };

    let event_mode: &'static str = if ask_round_trip { "ask" } else { "revise" };

    tracing::info!(
        session_id = %session_id,
        tool_use_id = %tool_use_id,
        plan_len = raw_plan.len(),
        sections = section_count,
        version = version_number,
        new_session = is_new_session,
        thread_start = thread_start,
        mode = event_mode,
        ask_violated = ask_mode_violated.is_some(),
        resolutions = resolutions_attached,
        unmatched = attach_report.unmatched_ids.len(),
        unresolved = attach_report.unresolved_submitted_ids.len(),
        parse_error = ?resolution_result.parse_error,
        "POST /v1/plan parsed; blocking for reviewer"
    );

    // Pin this hold to the dock terminal whose `claude` sent it, by walking
    // the TCP peer's process ancestry down to one of our spawned shells. None
    // when the POST came from an external terminal (or resolution fails) —
    // then no dock tab shows the "plan intercepted" strip, by design. The
    // lsof/ps shell-outs block, so hop off the async runtime for them.
    let held_terminal_id = {
        let pty_state: pty::PtyState = (*app_state.app_handle.state::<pty::PtyState>()).clone();
        let peer_port = peer.port();
        tokio::task::spawn_blocking(move || {
            pty::terminal_for_client_port(&pty_state, peer_port)
        })
        .await
        .ok()
        .flatten()
    };

    // This POST is about to be held — record it before the event goes out so
    // the listener's summary refresh already sees Held (clearing any stale
    // Detached from a prior orphan).
    app_state
        .store
        .set_attach_state(&session_id, AttachState::Held);
    let event = PlanReceivedEvent {
        session_id: session_id.clone(),
        version: version_number,
        is_new_session,
        thread_start,
        resolutions_attached,
        unmatched_resolution_ids: attach_report.unmatched_ids,
        unresolved_submitted_ids: attach_report.unresolved_submitted_ids,
        resolution_parse_error: resolution_result.parse_error,
        mode: event_mode,
        ask_mode_violated,
        restored,
    };
    if let Err(e) = app_state.app_handle.emit("plan-received", event) {
        tracing::warn!(error = %e, "failed to emit plan-received");
    }
    refresh_tray(&app_state.app_handle, &app_state.store);

    // Orphan fix: if a prior held POST for this session is still pending (Claude
    // re-entered plan mode, retried, or the earlier hold was abandoned), release
    // the stale waiter cleanly instead of leaving it hung, then take over.
    let (mut rx, token) = match app_state
        .pending
        .register(&session_id, held_terminal_id.clone())
    {
        Some(pair) => pair,
        None => {
            if let Some(stale) = app_state.pending.take(&session_id) {
                tracing::warn!(session_id = %session_id, "superseding a stale held POST for this session");
                let _ = stale.send(allow_response(
                    "Superseded by a newer plan from the same session.",
                ));
            }
            app_state
                .pending
                .register(&session_id, held_terminal_id)
                .expect("pending slot freed above")
        }
    };
    // If this request is cancelled (the held connection drops before a decision),
    // the guard removes our orphaned sender and notifies the UI. On the normal
    // decision path the sender was already taken, so the guard is a no-op.
    let _detach_guard = DetachGuard {
        pending: app_state.pending.clone(),
        app_handle: app_state.app_handle.clone(),
        store: app_state.store.clone(),
        session_id: session_id.clone(),
        token,
    };

    let cancelled_msg = "User cancelled the review and does not want to proceed with this plan.";

    let response = match mode {
        InterceptionMode::Paused => unreachable!("handled before parsing"),
        InterceptionMode::Active => match rx.await {
            Ok(r) => r,
            Err(_) => {
                tracing::info!(session_id = %session_id, "review channel closed without explicit decision");
                deny_response(cancelled_msg)
            }
        },
        InterceptionMode::Ambient => {
            let deadline_ms = now_millis() + (AMBIENT_WINDOW_SECS as i64) * 1000;
            if let Err(e) = app_state.app_handle.emit(
                "plan-decision-window",
                DecisionWindowEvent {
                    session_id: session_id.clone(),
                    version: version_number,
                    deadline_ms,
                    window_secs: AMBIENT_WINDOW_SECS,
                },
            ) {
                tracing::warn!(error = %e, "failed to emit plan-decision-window");
            }
            let claimed = app_state.claims.register(&session_id);
            let resp = tokio::select! {
                r = &mut rx => match r {
                    Ok(r) => r,
                    Err(_) => deny_response(cancelled_msg),
                },
                _ = tokio::time::sleep(Duration::from_secs(AMBIENT_WINDOW_SECS)) => {
                    if claimed.load(Ordering::SeqCst) {
                        // Reviewer opened it — convert to a full held review and
                        // wait for the explicit decision (bounded by the hook timeout).
                        tracing::info!(session_id = %session_id, "Ambient: claimed for full review");
                        match (&mut rx).await {
                            Ok(r) => r,
                            Err(_) => deny_response(cancelled_msg),
                        }
                    } else {
                        // Window elapsed unclaimed — auto-approve and drop the
                        // pending sender so it is never orphaned.
                        let _ = app_state.pending.take(&session_id);
                        app_state
                            .store
                            .set_attach_state(&session_id, AttachState::Idle);
                        tracing::info!(session_id = %session_id, "Ambient: decision window elapsed — auto-approving");
                        allow_response(
                            "Auto-approved (Ambient mode — the plan was not opened for review within the decision window).",
                        )
                    }
                }
            };
            app_state.claims.clear(&session_id);
            resp
        }
    };

    Json(response)
}

async fn run_server(state: AppState) {
    // Keep handles for the post-bind status update before the router consumes `state`.
    let daemon_status = state.daemon_status.clone();
    let app_handle = state.app_handle.clone();
    let app = Router::new()
        .route("/v1/plan", post(handle_plan))
        // Agent-in-doc (M4): the per-user agent's surface — read the plan's
        // block structure, post a tracked suggestion against a block id.
        .route("/v1/sessions/:session_id/plan", get(handle_get_latest_plan))
        .route(
            "/v1/sessions/:session_id/suggestions",
            post(handle_suggest_edit),
        )
        .with_state(state);
    match tokio::net::TcpListener::bind("127.0.0.1:7676").await {
        Ok(listener) => {
            daemon_status.set_bound(true);
            tracing::info!("Redline daemon listening on http://127.0.0.1:7676");
            // with_connect_info: handle_plan reads the peer's port to bind a
            // held plan to the dock terminal whose claude sent it.
            if let Err(e) = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            {
                tracing::error!(error = %e, "axum::serve exited");
            }
        }
        Err(e) => {
            daemon_status.set_bound(false);
            tracing::error!(error = %e, "failed to bind 127.0.0.1:7676");
            // Tell the (now daemon-less) window so it shows a blocking banner.
            // Emit even though the webview may not have mounted its listener yet
            // — `get_daemon_status` is the authoritative mount-time check.
            let _ = app_handle.emit(
                "daemon-bind-failed",
                SessionEvent {
                    session_id: String::new(),
                },
            );
        }
    }
}

fn agent_error_response(err: agent::AgentError) -> (StatusCode, Json<Value>) {
    let code = match err {
        agent::AgentError::NotFound(_) => StatusCode::NOT_FOUND,
        agent::AgentError::Conflict(_) => StatusCode::CONFLICT,
        agent::AgentError::BadRequest(_) => StatusCode::BAD_REQUEST,
    };
    (code, Json(serde_json::json!({ "error": err.message() })))
}

async fn handle_get_latest_plan(
    State(app_state): State<AppState>,
    Path(session_id): Path<String>,
) -> axum::response::Response {
    match agent::get_latest_plan_core(&app_state.store, &session_id) {
        Ok(plan) => Json(plan).into_response(),
        Err(e) => agent_error_response(e).into_response(),
    }
}

async fn handle_suggest_edit(
    State(app_state): State<AppState>,
    Path(session_id): Path<String>,
    Json(req): Json<agent::SuggestEditRequest>,
) -> axum::response::Response {
    match agent::suggest_edit_core(&app_state.store, &session_id, req) {
        Ok(comment) => {
            tracing::info!(
                session_id = %session_id,
                comment_id = %comment.id,
                author = comment.author.as_deref().unwrap_or(""),
                "agent suggestion landed"
            );
            let _ = app_state.app_handle.emit(
                "comments-changed",
                SessionEvent {
                    session_id: session_id.clone(),
                },
            );
            refresh_tray(&app_state.app_handle, &app_state.store);
            (StatusCode::CREATED, Json(comment)).into_response()
        }
        Err(e) => agent_error_response(e).into_response(),
    }
}

/// Mount-time check: did the daemon bind its port? `false` → another process
/// holds 7676 and this window cannot capture plans.
#[tauri::command]
fn get_daemon_status(daemon_status: tauri::State<'_, DaemonStatus>) -> bool {
    daemon_status.is_bound()
}

#[tauri::command]
fn list_sessions(
    store: tauri::State<'_, SessionStore>,
    pending: tauri::State<'_, PendingResponses>,
) -> Vec<SessionSummary> {
    let mut sessions = store.list();
    for s in &mut sessions {
        s.held = pending.has(&s.session_id);
        // A live sender is ground truth — never let a lagging persisted state
        // show "detached" while a POST is actually held.
        if s.held {
            s.attach_state = AttachState::Held;
            s.held_terminal_id = pending.terminal_of(&s.session_id);
        }
    }
    sessions
}

/// Core of `delete_session` minus the Tauri-runtime concerns (event emit,
/// tray refresh). Factored out so the force-drain behavior is unit-testable
/// without spinning a `tauri::AppHandle`.
fn delete_session_inner(
    store: &SessionStore,
    pending: &PendingResponses,
    session_id: &str,
    force: bool,
) -> Result<bool, String> {
    if pending.has(session_id) {
        if !force {
            return Err(
                "This session's terminal is still active (Claude Code is waiting for review). \
                 Approve or continue it before deleting."
                    .to_string(),
            );
        }
        if let Some(tx) = pending.take(session_id) {
            let _ = tx.send(deny_response("Session deleted by reviewer."));
        }
    }
    Ok(store.delete_session(session_id))
}

/// Delete a session. By default, rejected while a POST is held (its terminal
/// is still active and Claude Code is blocked waiting for review). When
/// `force = true`, the held POST is drained with a `deny_response` so Claude
/// Code's hook returns cleanly before the session row is removed — this
/// covers the stale-held-state case where the underlying terminal is gone
/// but the in-memory channel is still registered.
#[tauri::command]
fn delete_session(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    pending: tauri::State<'_, PendingResponses>,
    session_id: String,
    force: Option<bool>,
) -> Result<bool, String> {
    let removed = delete_session_inner(&store, &pending, &session_id, force.unwrap_or(false))?;
    if removed {
        let _ = app.emit(
            "session-status-changed",
            SessionEvent {
                session_id: session_id.clone(),
            },
        );
        refresh_tray(&app, &store);
    }
    Ok(removed)
}

#[tauri::command]
fn get_session(store: tauri::State<'_, SessionStore>, id: String) -> Option<ReviewSession> {
    store.get(&id)
}

/// Collapse an arbitrary name into a filesystem-safe slug: alphanumerics kept,
/// every other run collapsed to a single `-`, trimmed, capped so a long title
/// can't make an unwieldy filename.
fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for c in name.chars() {
        if c.is_alphanumeric() {
            out.push(c);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    out.chars().take(60).collect::<String>().trim_matches('-').to_string()
}

/// A filesystem-safe default file name for an exported revision, e.g.
/// `Redline-Fixes-Improvements-Pass-v3-20260608-143012.md`. `name` is the plan
/// title (falling back to the project name). `stamp` is a pre-formatted local
/// date/time supplied by the frontend; omitted → no stamp.
fn export_file_name(name: &str, version: u32, stamp: Option<&str>, ext: &str) -> String {
    let stem = slugify(name);
    let stem = if stem.is_empty() { "plan" } else { &stem };
    match stamp.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => format!("{stem}-v{version}-{s}.{ext}"),
        None => format!("{stem}-v{version}.{ext}"),
    }
}

/// Export one plan revision as clean markdown (block-id sidecars stripped) to a
/// file the user picks. `async` is required: the command then runs on the async
/// runtime rather than the main thread, where `blocking_save_file` would
/// deadlock the event loop. Returns the saved path, or `None` if cancelled.
#[tauri::command]
async fn export_revision_markdown(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    session_id: String,
    version_number: u32,
    stamp: Option<String>,
) -> Result<Option<String>, String> {
    // Resolve the revision and strip sidecars in a scoped block so no store
    // lock is held across the (blocking) save dialog.
    let (clean, project_name) = {
        let session = store
            .get(&session_id)
            .ok_or_else(|| format!("no session for id {session_id}"))?;
        let revision = session
            .revisions
            .iter()
            .find(|r| r.version_number == version_number)
            .ok_or_else(|| format!("revision v{version_number} not found"))?;
        (
            parser::strip_sidecar_lines(&revision.raw_plan_markdown),
            session.project_name.clone(),
        )
    };

    // Name the file after the plan's own title; fall back to the project name.
    let name = parser::plan_title_from_markdown(&clean).unwrap_or(project_name);

    let picked = app
        .dialog()
        .file()
        .add_filter("Markdown", &["md"])
        .set_file_name(export_file_name(
            &name,
            version_number,
            stamp.as_deref(),
            "md",
        ))
        .blocking_save_file();

    let Some(file_path) = picked else {
        return Ok(None); // user cancelled the save dialog
    };
    let path = file_path
        .into_path()
        .map_err(|e| format!("invalid save path: {e}"))?;
    std::fs::write(&path, clean).map_err(|e| e.to_string())?;
    tracing::info!(path = %path.display(), version = version_number, "exported revision markdown");
    Ok(Some(path.to_string_lossy().to_string()))
}

/// Save a frontend-built `.docx` export of one plan revision. The bytes are
/// produced by the JS export adapter (the format socket lives in the
/// frontend); this command only resolves the file name from the revision's
/// title, shows the save dialog, and writes. `async` for the same
/// blocking-dialog reason as `export_revision_markdown`.
#[tauri::command]
async fn export_revision_docx(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    session_id: String,
    version_number: u32,
    stamp: Option<String>,
    bytes: Vec<u8>,
) -> Result<Option<String>, String> {
    let (clean, project_name) = {
        let session = store
            .get(&session_id)
            .ok_or_else(|| format!("no session for id {session_id}"))?;
        let revision = session
            .revisions
            .iter()
            .find(|r| r.version_number == version_number)
            .ok_or_else(|| format!("revision v{version_number} not found"))?;
        (
            parser::strip_sidecar_lines(&revision.raw_plan_markdown),
            session.project_name.clone(),
        )
    };
    let name = parser::plan_title_from_markdown(&clean).unwrap_or(project_name);

    let picked = app
        .dialog()
        .file()
        .add_filter("Word document", &["docx"])
        .set_file_name(export_file_name(
            &name,
            version_number,
            stamp.as_deref(),
            "docx",
        ))
        .blocking_save_file();

    let Some(file_path) = picked else {
        return Ok(None); // user cancelled the save dialog
    };
    let path = file_path
        .into_path()
        .map_err(|e| format!("invalid save path: {e}"))?;
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    tracing::info!(path = %path.display(), version = version_number, "exported revision docx");
    Ok(Some(path.to_string_lossy().to_string()))
}

#[tauri::command]
fn add_comment(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    session_id: String,
    request: NewCommentRequest,
) -> Result<Comment, String> {
    let result = store.add_comment(&session_id, request)?;
    let _ = app.emit(
        "comments-changed",
        SessionEvent {
            session_id: session_id.clone(),
        },
    );
    refresh_tray(&app, &store);
    Ok(result)
}

#[tauri::command]
fn update_comment(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    session_id: String,
    comment_id: String,
    update: UpdateCommentRequest,
) -> Result<Comment, String> {
    let result = store
        .update_comment(&session_id, &comment_id, update)
        .ok_or_else(|| format!("no comment {comment_id} in session {session_id}"))?;
    let _ = app.emit(
        "comments-changed",
        SessionEvent {
            session_id: session_id.clone(),
        },
    );
    refresh_tray(&app, &store);
    Ok(result)
}

#[tauri::command]
fn delete_comment(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    session_id: String,
    comment_id: String,
) -> Result<bool, String> {
    let removed = store.delete_comment(&session_id, &comment_id);
    if removed {
        let _ = app.emit(
            "comments-changed",
            SessionEvent {
                session_id: session_id.clone(),
            },
        );
        refresh_tray(&app, &store);
    }
    Ok(removed)
}

/// Agent-in-doc (M4): same core as POST /v1/sessions/:id/suggestions, for
/// in-process callers. The suggestion lands as a draft [edit] comment with
/// `author`; the editor materializes it as pending marks.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn agent_suggest_edit(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    session_id: String,
    block_id: String,
    kind: String,
    original: Option<String>,
    revised: String,
    agent_id: String,
    body: Option<String>,
) -> Result<Comment, String> {
    let comment = agent::suggest_edit_core(
        &store,
        &session_id,
        agent::SuggestEditRequest {
            block_id,
            kind,
            original,
            revised,
            agent_id,
            body,
        },
    )
    .map_err(|e| e.message().to_string())?;
    let _ = app.emit(
        "comments-changed",
        SessionEvent {
            session_id: session_id.clone(),
        },
    );
    refresh_tray(&app, &store);
    Ok(comment)
}

/// Agent-in-doc (M4): the published plan + flat block index, same core as
/// GET /v1/sessions/:id/plan.
#[tauri::command]
fn get_latest_plan(
    store: tauri::State<'_, SessionStore>,
    session_id: String,
) -> Result<agent::LatestPlanResponse, String> {
    agent::get_latest_plan_core(&store, &session_id).map_err(|e| e.message().to_string())
}

/// Record the in-place acceptance of a still-draft agent suggestion. The
/// editor has already applied the marks; this only persists the card state
/// (the comment deliberately stays Draft — see state::set_agent_state).
#[tauri::command]
fn accept_agent_suggestion(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    session_id: String,
    comment_id: String,
) -> Result<bool, String> {
    let updated = store.set_agent_state(&session_id, &comment_id, Some("accepted".to_string()));
    if updated {
        let _ = app.emit(
            "comments-changed",
            SessionEvent {
                session_id: session_id.clone(),
            },
        );
        refresh_tray(&app, &store);
    }
    Ok(updated)
}

/// Keystroke sequence that selects "give feedback" on Claude Code's plan-mode
/// rejection menu, so the reviewer doesn't have to click through it after
/// pressing "Continue revising". Provisional default — the exact selector is
/// part of Claude Code's TUI and must be confirmed by an interactive run
/// against the target version. Recorded in `docs/protocol-verification.md`
/// alongside the other empirically-verified hook behaviors.
///
/// The frontend gates this inject behind an opt-in flag so a wrong default
/// never mashes random keys into someone's terminal.
const MENU_SKIP_KEYSTROKE: &str = "3\r";

/// `terminal_id` is the PTY id of the terminal currently hosting this
/// session's `claude`; when `auto_continue` is `Some(true)` and this is
/// `Some`, the menu-skip keystroke is written into that PTY after the held
/// POST is released so Claude Code's plan-rejection menu is invisible to the
/// reviewer. `auto_continue` defaults to `None` (= disabled); the frontend
/// must explicitly opt in once the keystroke has been verified for the
/// user's Claude Code version (see `MENU_SKIP_KEYSTROKE`).
#[tauri::command]
async fn submit_review(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    pending: tauri::State<'_, PendingResponses>,
    expected_modes: tauri::State<'_, ExpectedModes>,
    pty: tauri::State<'_, pty::PtyState>,
    session_id: String,
    terminal_id: Option<String>,
    auto_continue: Option<bool>,
) -> Result<(), String> {
    let Some((sections, comments, current_plan_markdown)) =
        store.drafts_and_reopens_for_payload(&session_id)
    else {
        return Err(format!("session not found: {session_id}"));
    };
    if comments.is_empty() {
        return Err(
            "no draft or reopened comments to submit — add at least one or approve instead"
                .to_string(),
        );
    }

    let mode = SubmissionMode::infer(&comments);
    let payload = feedback::serialize_payload(
        mode,
        &sections,
        &comments,
        &current_plan_markdown,
    );
    let submitted = store.mark_submitted(&session_id);
    tracing::info!(
        session_id = %session_id,
        count = submitted.len(),
        mode = ?mode,
        "submit_review fired",
    );

    // Close the second-revision race: when a new plan POST is in flight but
    // its sender hasn't been registered yet, wait briefly instead of bailing.
    let tx = pending
        .take_or_wait(&session_id, Duration::from_millis(2000))
        .await
        .ok_or_else(|| "no plan is currently waiting for review on this session".to_string())?;
    // Ordering invariant: set expected_mode BEFORE unblocking the hook.
    // Claude can't possibly send the next ExitPlanMode POST before this
    // tx.send() returns to the held handle_plan task, so the next
    // handle_plan invocation is guaranteed to see this entry.
    expected_modes.set(&session_id, mode);
    // A failed send means the receiver is gone: the held POST already ended
    // (the Claude Code session/terminal closed, or the long hold timed out).
    // Don't pretend it worked. Roll back the submit (restore comments to draft,
    // drop the expected_mode) and surface a clear error so the reviewer can
    // restore the session and resubmit, instead of their feedback vanishing
    // into a dead channel.
    if tx.send(deny_response(payload)).is_err() {
        expected_modes.take(&session_id);
        store.unmark_submitted(&session_id, &submitted);
        // Detachment discovered at decision time — we held the sender, so the
        // drop-guard can't fire for it anymore. Persist and announce it here.
        store.set_attach_state(&session_id, AttachState::Detached);
        let _ = app.emit(
            "session-detached",
            SessionEvent {
                session_id: session_id.clone(),
            },
        );
        let _ = app.emit(
            "comments-changed",
            SessionEvent {
                session_id: session_id.clone(),
            },
        );
        refresh_tray(&app, &store);
        tracing::warn!(
            session_id = %session_id,
            "submit_review delivery failed — held POST no longer listening; rolled back"
        );
        return Err(
            "Claude is no longer waiting for this plan — the Claude Code session \
             ended or the hold timed out. Use \"Restore plan session\" to resume \
             it, then submit your review again."
                .to_string(),
        );
    }
    store.set_attach_state(&session_id, AttachState::Idle);

    // Best-effort: skip Claude Code's "Auto-accept / Edit / Feedback / Reject"
    // prompt by feeding the configured keystroke into the embedded terminal.
    // Off by default; a missing PTY is a silent no-op (the reviewer probably
    // closed the tab — the menu will surface for them in their own terminal).
    if auto_continue.unwrap_or(false) {
        if let Some(tid) = terminal_id.as_deref() {
            if let Err(e) = pty::pty_write_bytes(&pty, tid, MENU_SKIP_KEYSTROKE.as_bytes()) {
                tracing::warn!(
                    error = %e,
                    terminal_id = tid,
                    "auto-continue PTY inject failed (non-fatal)"
                );
            }
        }
    }

    let _ = app.emit(
        "comments-changed",
        SessionEvent {
            session_id: session_id.clone(),
        },
    );
    refresh_tray(&app, &store);
    Ok(())
}

#[tauri::command]
fn approve_plan(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    pending: tauri::State<'_, PendingResponses>,
    expected_modes: tauri::State<'_, ExpectedModes>,
    session_id: String,
) -> Result<(), String> {
    let tx = pending
        .take(&session_id)
        .ok_or_else(|| "no plan is currently waiting for review on this session".to_string())?;
    // Approving short-circuits any in-flight Ask round-trip — no follow-up
    // plan will arrive to consume the mode, so drop it here to avoid leaks.
    let _ = expected_modes.take(&session_id);
    store.set_status(&session_id, SessionStatus::Approved);
    let _ = tx.send(allow_response("Reviewer approved via Redline."));
    store.set_attach_state(&session_id, AttachState::Idle);
    tracing::info!(session_id = %session_id, "approve_plan fired");
    let _ = app.emit(
        "session-status-changed",
        SessionEvent {
            session_id: session_id.clone(),
        },
    );
    refresh_tray(&app, &store);
    Ok(())
}

#[tauri::command]
fn accept_resolution(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    session_id: String,
    comment_id: String,
) -> Result<bool, String> {
    let ok = store.accept_resolution(&session_id, &comment_id);
    if ok {
        let _ = app.emit(
            "comments-changed",
            SessionEvent {
                session_id: session_id.clone(),
            },
        );
        refresh_tray(&app, &store);
    }
    Ok(ok)
}

#[tauri::command]
fn reopen_resolution(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    session_id: String,
    comment_id: String,
    note: Option<String>,
    as_change: Option<bool>,
) -> Result<bool, String> {
    let ok = store.reopen_resolution(
        &session_id,
        &comment_id,
        note.as_deref(),
        as_change.unwrap_or(false),
    );
    if ok {
        let _ = app.emit(
            "comments-changed",
            SessionEvent {
                session_id: session_id.clone(),
            },
        );
        refresh_tray(&app, &store);
    }
    Ok(ok)
}

/// Attach a Discuss-thread outcome to its comment so it rides into the next
/// submit — works on drafts (rider set in place) and on resolved/accepted/
/// reopened comments (delegates to the reopen path). A blank note detaches.
#[tauri::command]
fn attach_discussion(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    session_id: String,
    comment_id: String,
    note: Option<String>,
    as_change: Option<bool>,
) -> Result<(), String> {
    store.attach_discussion(
        &session_id,
        &comment_id,
        note.as_deref(),
        as_change.unwrap_or(false),
    )?;
    let _ = app.emit(
        "comments-changed",
        SessionEvent {
            session_id: session_id.clone(),
        },
    );
    refresh_tray(&app, &store);
    Ok(())
}

#[tauri::command]
fn get_interception_mode(settings: tauri::State<'_, Settings>) -> String {
    settings.get().as_str().to_string()
}

/// Single source of truth for a mode transition: persist it, release any held
/// POSTs if we're no longer in Active, and broadcast `mode-changed` so the UI and
/// the tray menu stay in sync regardless of who initiated the change.
fn apply_mode(app: &AppHandle, mode: InterceptionMode) {
    app.state::<Settings>().set(mode);
    if mode != InterceptionMode::Active {
        for (session_id, tx) in app.state::<PendingResponses>().drain_all() {
            let _ = tx.send(allow_response(
                "Superseded — Redline interception mode changed; plan auto-approved.",
            ));
            app.state::<SessionStore>()
                .set_attach_state(&session_id, AttachState::Idle);
        }
    }
    tracing::info!(mode = %mode.as_str(), "interception mode changed");
    let _ = app.emit(
        "mode-changed",
        ModeEvent {
            mode: mode.as_str().to_string(),
        },
    );
}

#[tauri::command]
fn set_interception_mode(app: AppHandle, mode: String) -> Result<(), String> {
    let parsed = InterceptionMode::from_str(&mode).ok_or_else(|| format!("invalid mode: {mode}"))?;
    apply_mode(&app, parsed);
    Ok(())
}

/// Reviewer explicitly opened an Ambient-mode plan for full review — cancels the
/// auto-approve and keeps the held POST waiting for an explicit decision.
#[tauri::command]
fn claim_review(claims: tauri::State<'_, ClaimFlags>, session_id: String) -> bool {
    claims.claim(&session_id)
}

/// Arm a one-shot restore for a session. Called when the reviewer clicks
/// "Restore plan session" so the next inbound plan that re-presents the
/// identical body is tagged as a restore ("vN restored") rather than a fresh
/// version. See `SessionStore::arm_restore`.
#[tauri::command]
fn arm_restore(store: tauri::State<'_, SessionStore>, session_id: String) {
    store.arm_restore(&session_id);
}

/// Reveal the main window. The window starts hidden and is shown once the
/// frontend has rendered its first themed frame, so launch never flashes white.
#[tauri::command]
fn show_main_window(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn get_hook_status() -> HookStatus {
    hook::get_status()
}

#[tauri::command]
fn install_hook() -> Result<HookStatus, String> {
    let result = hook::install();
    if let Ok(status) = &result {
        tracing::info!(path = %status.settings_path, "installed redline hook");
    }
    result
}

#[tauri::command]
fn get_skill_status() -> SkillStatus {
    skill::get_status()
}

#[tauri::command]
fn install_skill() -> Result<SkillStatus, String> {
    let result = skill::install();
    if let Ok(status) = &result {
        tracing::info!(
            path = %status.skill_path,
            version = status.version,
            "installed redline skill"
        );
    }
    result
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".parse().unwrap()),
        )
        .init();

    tauri::Builder::default()
        // Must be the first plugin (Tauri v2 requirement). A second `redline`
        // launch hands off to the running instance and focuses its window
        // instead of opening a daemon-less duplicate that can't bind :7676 and
        // would silently miss every plan (it only shares the on-disk DB).
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Default window label is "main"; fall back to any window so this
            // keeps working if the label ever changes.
            let win = app
                .get_webview_window("main")
                .or_else(|| app.webview_windows().into_values().next());
            if let Some(w) = win {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            get_session,
            export_revision_markdown,
            export_revision_docx,
            delete_session,
            add_comment,
            update_comment,
            delete_comment,
            agent_suggest_edit,
            get_latest_plan,
            accept_agent_suggestion,
            submit_review,
            approve_plan,
            accept_resolution,
            reopen_resolution,
            attach_discussion,
            get_interception_mode,
            set_interception_mode,
            get_daemon_status,
            claim_review,
            arm_restore,
            show_main_window,
            get_hook_status,
            install_hook,
            get_skill_status,
            install_skill,
            pty::pty_spawn,
            pty::pty_ack,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_kill_all,
            pty::pty_cwd,
            fsbrowse::list_dir,
            fsbrowse::read_text_file,
            fsbrowse::read_file_base64,
            fsbrowse::home_dir,
            highlight::open_doc,
            highlight::doc_lines,
            fswatch::watch_dir,
            fswatch::unwatch_dir,
            fork::fork_thread_send,
            fork::get_thread,
            fork::fork_thread_cancel,
            fork::fork_thread_discard,
            fork::fork_kill_all,
        ])
        .setup(|app| {
            // Silently bring an existing install's hook timeout up to date, so a
            // user who installed under the old 10-minute timeout gets the long
            // hold without re-running setup. No-op if not installed / current.
            hook::ensure_timeout_current();

            // Open at a generous, Safari-style fraction of whatever display the
            // window lands on, centered — a fixed pixel size feels small on a
            // large monitor and oversized on a laptop, so size relative to the
            // screen like Safari does. The window starts hidden (config) and is
            // shown here after sizing so there's no resize flash on launch.
            if let Some(win) = app.get_webview_window("main") {
                if let Ok(Some(monitor)) = win.current_monitor() {
                    let scale = monitor.scale_factor();
                    let size = monitor.size();
                    let logical_w = size.width as f64 / scale;
                    let logical_h = size.height as f64 / scale;
                    // ~86% wide × ~90% tall leaves room for the menu bar / Dock;
                    // clamped so it never gets cramped or absurdly large.
                    let w = (logical_w * 0.86).clamp(1100.0, 1900.0);
                    let h = (logical_h * 0.90).clamp(720.0, 1200.0);
                    let _ = win.set_size(tauri::LogicalSize::new(w, h));
                }
                let _ = win.center();
                // Reveal the window only once the frontend has painted its first
                // themed frame (it calls `show_main_window`), so launch never
                // shows a flash of white. Fallback: show anyway after a short
                // delay so a JS error can't leave the window invisible forever.
                let fallback = win.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(2000)).await;
                    let _ = fallback.show();
                });
            }

            let data_dir = app
                .path()
                .app_data_dir()
                .expect("could not resolve app data dir");
            let db_path = data_dir.join("redline.db");
            tracing::info!(path = %db_path.display(), "opening sqlite database");
            let db = Arc::new(
                Database::open(&db_path).expect("failed to open sqlite database"),
            );

            let settings = Settings::load(db.clone());
            app.manage(settings.clone());

            let claims = ClaimFlags::new();
            app.manage(claims.clone());

            app.manage(pty::PtyState::new());

            app.manage(fswatch::FsWatcher::new(app.handle().clone()));

            // Warm syntect's per-grammar regexes off the hot path so the first
            // real file open doesn't pay the one-time compile cost on the user's
            // click. The compiled-regex cache lives in the shared SyntaxSet, so
            // the background warm benefits the managed instance the commands use.
            let highlighter = Arc::new(highlight::Highlighter::new());
            {
                let hl = highlighter.clone();
                std::thread::spawn(move || hl.warm_common());
            }
            app.manage(highlighter);

            // Resolve `claude` once — a Finder-launched app has a minimal PATH.
            // Built before SessionStore::new consumes the `db` Arc.
            let fork_state = fork::ForkState::new(db.clone(), fork::resolve_claude_bin());
            app.manage(fork_state.clone());

            let store = SessionStore::new(db);
            app.manage(store.clone());

            let pending = PendingResponses::new();
            app.manage(pending.clone());

            let expected_modes = ExpectedModes::new();
            app.manage(expected_modes.clone());

            let daemon_status = DaemonStatus::new();
            app.manage(daemon_status.clone());

            let app_state = AppState {
                store: store.clone(),
                app_handle: app.handle().clone(),
                pending,
                expected_modes,
                settings: settings.clone(),
                claims,
                fork: fork_state,
                daemon_status,
            };
            tauri::async_runtime::spawn(run_server(app_state));

            // Tray menu mirrors the interception mode (radio-style check items).
            let current = settings.get();
            let mi_active = CheckMenuItem::with_id(
                app,
                "mode_active",
                "Active — review every plan",
                true,
                current == InterceptionMode::Active,
                None::<&str>,
            )?;
            let mi_ambient = CheckMenuItem::with_id(
                app,
                "mode_ambient",
                "Ambient — auto-approve unless opened",
                true,
                current == InterceptionMode::Ambient,
                None::<&str>,
            )?;
            let mi_paused = CheckMenuItem::with_id(
                app,
                "mode_paused",
                "Paused — pass everything through",
                true,
                current == InterceptionMode::Paused,
                None::<&str>,
            )?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Redline", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&mi_active, &mi_ambient, &mi_paused, &sep, &quit],
            )?;

            // Keep the three check items consistent with whatever mode is active,
            // whether the change came from the tray or the in-app toggle.
            let checks = (mi_active.clone(), mi_ambient.clone(), mi_paused.clone());
            let sync_checks = move |mode: InterceptionMode| {
                let _ = checks.0.set_checked(mode == InterceptionMode::Active);
                let _ = checks.1.set_checked(mode == InterceptionMode::Ambient);
                let _ = checks.2.set_checked(mode == InterceptionMode::Paused);
            };
            let sync_for_event = sync_checks.clone();
            app.handle().listen("mode-changed", move |ev| {
                if let Ok(m) = serde_json::from_str::<ModeEvent>(ev.payload()) {
                    if let Some(mode) = InterceptionMode::from_str(&m.mode) {
                        sync_for_event(mode);
                    }
                }
            });

            let _tray = TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Redline")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event: MenuEvent| {
                    let mode = match event.id().as_ref() {
                        "mode_active" => Some(InterceptionMode::Active),
                        "mode_ambient" => Some(InterceptionMode::Ambient),
                        "mode_paused" => Some(InterceptionMode::Paused),
                        "quit" => {
                            app.exit(0);
                            return;
                        }
                        _ => None,
                    };
                    if let Some(mode) = mode {
                        apply_mode(app, mode);
                        sync_checks(mode);
                    }
                })
                .build(app)?;

            refresh_tray(app.handle(), &store);

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Kill any headless `claude` discussion forks on teardown so no
            // child is orphaned (PTYs SIGHUP-clean when their master closes).
            if let tauri::RunEvent::Exit = event {
                if let Some(fork) = app_handle.try_state::<fork::ForkState>() {
                    fork.kill_all();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use crate::state::reparse_sections;
    use std::sync::Arc;

    fn make_store() -> SessionStore {
        let db = Arc::new(Database::open_in_memory().unwrap());
        SessionStore::new(db)
    }

    #[test]
    fn export_name_uses_plan_title() {
        let title = parser::plan_title_from_markdown(
            "<!-- rl:blk-1 -->\n# Redline — Fixes & Improvements Pass\n\nbody",
        );
        assert_eq!(
            title.as_deref(),
            Some("Redline — Fixes & Improvements Pass")
        );
        assert_eq!(
            export_file_name(&title.unwrap(), 2, Some("20260608-234706"), "md"),
            "Redline-Fixes-Improvements-Pass-v2-20260608-234706.md"
        );
    }

    #[test]
    fn export_name_falls_back_and_ignores_non_headings() {
        // A `#!`-style line or code `#` is not a heading.
        assert_eq!(parser::plan_title_from_markdown("#!/bin/bash\n#fff\ntext"), None);
        // No title → caller falls back to the project name.
        assert_eq!(
            export_file_name("my project", 1, None, "md"),
            "my-project-v1.md"
        );
        assert_eq!(
            export_file_name("my project", 1, None, "docx"),
            "my-project-v1.docx"
        );
    }

    #[test]
    fn delete_session_inner_refuses_held_without_force() {
        let store = make_store();
        let pending = PendingResponses::new();
        let md = "# Plan\n\nBody.\n";
        store.upsert_plan("s1", "/tmp/d", md.to_string(), reparse_sections(md), true, false);
        let _rx = pending.register("s1", None).expect("register first time");

        let err = delete_session_inner(&store, &pending, "s1", false)
            .expect_err("held session must be refused without force");
        assert!(err.contains("still active"), "got: {err}");
        assert!(pending.has("s1"), "held entry must survive a refused delete");
        assert!(store.has_session("s1"), "store row must survive a refused delete");
    }

    #[test]
    fn delete_session_inner_force_drains_held_then_deletes() {
        let store = make_store();
        let pending = PendingResponses::new();
        let md = "# Plan\n\nBody.\n";
        store.upsert_plan("s1", "/tmp/d", md.to_string(), reparse_sections(md), true, false);
        let (rx, _token) = pending.register("s1", None).expect("register first time");

        let removed = delete_session_inner(&store, &pending, "s1", true)
            .expect("force delete must succeed");
        assert!(removed, "delete must report true for an existing session");
        assert!(!pending.has("s1"), "held entry must be drained");
        assert!(!store.has_session("s1"), "store row must be gone");

        // The drained oneshot received a deny response so Claude Code's hook
        // returns cleanly rather than timing out.
        let resp = rx.blocking_recv().expect("oneshot must have been sent");
        assert_eq!(resp.hook_specific_output.permission_decision, "deny");
        assert!(
            resp.hook_specific_output
                .permission_decision_reason
                .contains("deleted"),
            "reason should mention deletion, got: {}",
            resp.hook_specific_output.permission_decision_reason
        );
    }

    #[tokio::test]
    async fn take_or_wait_returns_immediately_when_sender_present() {
        let pending = PendingResponses::new();
        let _rx = pending.register("s1", None).expect("first register");

        let tx = pending
            .take_or_wait("s1", Duration::from_secs(5))
            .await
            .expect("sender was already registered");
        // The senderslot must be drained — a second take returns None.
        assert!(pending.take("s1").is_none(), "take must remove the slot");
        // Sending into the channel still works (no double-take).
        let _ = tx.send(allow_response("ok"));
    }

    #[tokio::test]
    async fn take_or_wait_waits_for_late_register() {
        // The bug-5 race: take_or_wait fires before the next plan's POST
        // registers its sender. The take must wake up when register() runs
        // and return the freshly-registered sender, not bail out.
        let pending = PendingResponses::new();
        let waiter = {
            let pending = pending.clone();
            tokio::spawn(async move {
                pending
                    .take_or_wait("s2", Duration::from_secs(2))
                    .await
                    .map(|_| ())
            })
        };
        // Yield long enough that the waiter is parked on `notified()`.
        tokio::time::sleep(Duration::from_millis(50)).await;
        let _rx = pending.register("s2", None).expect("late register");
        let got = waiter.await.expect("waiter task panicked");
        assert!(got.is_some(), "take_or_wait must wake on register");
    }

    #[tokio::test]
    async fn take_or_wait_times_out_when_no_sender_ever_arrives() {
        let pending = PendingResponses::new();
        let out = pending
            .take_or_wait("nobody", Duration::from_millis(50))
            .await;
        assert!(out.is_none(), "take_or_wait must time out cleanly");
    }

    #[test]
    fn take_if_owned_only_removes_matching_token() {
        let pending = PendingResponses::new();
        let (_rx1, token1) = pending.register("s1", None).expect("first register");

        // Supersede: take the original and register a fresh one (new token).
        let _ = pending.take("s1").expect("take original");
        let (_rx2, token2) = pending.register("s1", None).expect("re-register");
        assert_ne!(token1, token2, "tokens must be unique per registration");

        // The stale guard (token1) must NOT clobber the new registration.
        assert!(
            pending.take_if_owned("s1", token1).is_none(),
            "stale token must not remove a superseding entry"
        );
        assert!(pending.has("s1"), "the live entry must survive");

        // The owning guard (token2) reclaims its own orphaned sender.
        assert!(
            pending.take_if_owned("s1", token2).is_some(),
            "matching token must remove its own entry"
        );
        assert!(!pending.has("s1"), "entry gone after owned take");
    }

    #[test]
    fn terminal_binding_lives_and_dies_with_the_held_entry() {
        // The per-terminal "plan intercepted" strip reads terminal_of(); the
        // binding must exist exactly while the POST is held — once the entry
        // is taken (decision / supersede / detach), no tab may keep the strip.
        let pending = PendingResponses::new();
        let (_rx, _token) = pending
            .register("s1", Some("tab-a".to_string()))
            .expect("register");
        assert_eq!(pending.terminal_of("s1"), Some("tab-a".to_string()));
        assert_eq!(
            pending.terminal_of("s2"),
            None,
            "unheld session has no binding"
        );

        let _ = pending.take("s1").expect("take");
        assert_eq!(
            pending.terminal_of("s1"),
            None,
            "binding must vanish with the held entry"
        );

        // External-terminal intercepts hold with no binding at all.
        let (_rx2, _) = pending.register("s1", None).expect("re-register");
        assert_eq!(pending.terminal_of("s1"), None);
    }

    #[test]
    fn send_into_dropped_receiver_is_an_error() {
        // Models the timed-out / detached held POST: submit_review must detect
        // this and roll back rather than report a false success.
        let pending = PendingResponses::new();
        let (rx, _token) = pending.register("s1", None).expect("register");
        drop(rx); // receiver gone — the held POST ended
        let tx = pending.take("s1").expect("sender still in map");
        assert!(
            tx.send(allow_response("late")).is_err(),
            "sending into a dropped receiver must fail"
        );
    }

    #[test]
    fn drain_all_returns_session_ids_with_senders() {
        // apply_mode settles each drained session's attach state, so the
        // drain must say *which* sessions it released.
        let pending = PendingResponses::new();
        let (_rx1, _) = pending.register("s1", None).expect("register s1");
        let (_rx2, _) = pending.register("s2", None).expect("register s2");
        let mut drained: Vec<String> = pending
            .drain_all()
            .into_iter()
            .map(|(sid, _tx)| sid)
            .collect();
        drained.sort();
        assert_eq!(drained, vec!["s1".to_string(), "s2".to_string()]);
        assert!(!pending.has("s1"));
        assert!(!pending.has("s2"));
    }

    #[test]
    fn delete_session_inner_non_held_path_unchanged() {
        let store = make_store();
        let pending = PendingResponses::new();
        let md = "# Plan\n\nBody.\n";
        store.upsert_plan("s1", "/tmp/d", md.to_string(), reparse_sections(md), true, false);

        // No POST held → both force values behave identically.
        let removed = delete_session_inner(&store, &pending, "s1", false)
            .expect("non-held delete must succeed");
        assert!(removed);
        assert!(!store.has_session("s1"));
    }
}
