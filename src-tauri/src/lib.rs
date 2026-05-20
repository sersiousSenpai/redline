// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
mod db;
mod feedback;
mod hook;
mod parser;
mod pty;
mod resolutions;
mod state;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use axum::{extract::State, routing::post, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Listener, Manager,
};
use tokio::sync::oneshot;

use crate::db::Database;
use crate::hook::HookStatus;
use crate::state::{
    now_millis, Comment, InterceptionMode, NewCommentRequest, ReviewSession, SessionStatus,
    SessionStore, SessionSummary, SubmissionMode, UpdateCommentRequest,
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

#[derive(Clone)]
struct PendingResponses(Arc<StdMutex<HashMap<String, oneshot::Sender<HookResponse>>>>);

impl PendingResponses {
    fn new() -> Self {
        Self(Arc::new(StdMutex::new(HashMap::new())))
    }
    fn register(&self, session_id: &str) -> Option<oneshot::Receiver<HookResponse>> {
        let mut map = self.0.lock().unwrap();
        if map.contains_key(session_id) {
            return None;
        }
        let (tx, rx) = oneshot::channel();
        map.insert(session_id.to_string(), tx);
        Some(rx)
    }
    fn take(&self, session_id: &str) -> Option<oneshot::Sender<HookResponse>> {
        self.0.lock().unwrap().remove(session_id)
    }
    /// A POST is currently held for this session (Claude Code is blocked in
    /// its terminal). Such a session is "active" and must not be deleted.
    fn has(&self, session_id: &str) -> bool {
        self.0.lock().unwrap().contains_key(session_id)
    }
    /// Remove and return every pending sender — used to release orphaned held
    /// POSTs when the interception mode changes away from Active.
    fn drain_all(&self) -> Vec<oneshot::Sender<HookResponse>> {
        let mut map = self.0.lock().unwrap();
        map.drain().map(|(_, tx)| tx).collect()
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

#[derive(Clone)]
struct AppState {
    store: SessionStore,
    app_handle: AppHandle,
    pending: PendingResponses,
    expected_modes: ExpectedModes,
    settings: Settings,
    claims: ClaimFlags,
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

    // Ask round-trip detection: the prior submit_review was an Ask batch
    // AND Claude returned the plan body unchanged (compared on a canonical
    // text signature that ignores cosmetic markdown / sidecar reflow).
    let ask_round_trip = expected_mode == Some(SubmissionMode::Ask)
        && session_existed
        && {
            let prev_sig = app_state
                .store
                .get(&session_id)
                .and_then(|s| s.revisions.last().map(|r| parser::plan_text_signature(&r.sections)))
                .unwrap_or_default();
            let new_sig = parser::plan_text_signature(&sections);
            prev_sig == new_sig
        };

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
    };
    if let Err(e) = app_state.app_handle.emit("plan-received", event) {
        tracing::warn!(error = %e, "failed to emit plan-received");
    }
    refresh_tray(&app_state.app_handle, &app_state.store);

    // Orphan fix: if a prior held POST for this session is still pending (Claude
    // re-entered plan mode, retried, or the earlier hold was abandoned), release
    // the stale waiter cleanly instead of leaving it hung, then take over.
    let mut rx = match app_state.pending.register(&session_id) {
        Some(rx) => rx,
        None => {
            if let Some(stale) = app_state.pending.take(&session_id) {
                tracing::warn!(session_id = %session_id, "superseding a stale held POST for this session");
                let _ = stale.send(allow_response(
                    "Superseded by a newer plan from the same session.",
                ));
            }
            app_state
                .pending
                .register(&session_id)
                .expect("pending slot freed above")
        }
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
    let app = Router::new()
        .route("/v1/plan", post(handle_plan))
        .with_state(state);
    match tokio::net::TcpListener::bind("127.0.0.1:7676").await {
        Ok(listener) => {
            tracing::info!("Redline daemon listening on http://127.0.0.1:7676");
            if let Err(e) = axum::serve(listener, app).await {
                tracing::error!(error = %e, "axum::serve exited");
            }
        }
        Err(e) => {
            tracing::error!(error = %e, "failed to bind 127.0.0.1:7676");
        }
    }
}

#[tauri::command]
fn list_sessions(
    store: tauri::State<'_, SessionStore>,
    pending: tauri::State<'_, PendingResponses>,
) -> Vec<SessionSummary> {
    let mut sessions = store.list();
    for s in &mut sessions {
        s.held = pending.has(&s.session_id);
    }
    sessions
}

/// Delete a session — rejected while a POST is held for it (its terminal is
/// still active and Claude Code is blocked waiting for review).
#[tauri::command]
fn delete_session(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    pending: tauri::State<'_, PendingResponses>,
    session_id: String,
) -> Result<bool, String> {
    if pending.has(&session_id) {
        return Err(
            "This session's terminal is still active (Claude Code is waiting for review). \
             Approve or continue it before deleting."
                .to_string(),
        );
    }
    let removed = store.delete_session(&session_id);
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

#[tauri::command]
fn submit_review(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    pending: tauri::State<'_, PendingResponses>,
    expected_modes: tauri::State<'_, ExpectedModes>,
    session_id: String,
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

    let tx = pending
        .take(&session_id)
        .ok_or_else(|| "no plan is currently waiting for review on this session".to_string())?;
    // Ordering invariant: set expected_mode BEFORE unblocking the hook.
    // Claude can't possibly send the next ExitPlanMode POST before this
    // tx.send() returns to the held handle_plan task, so the next
    // handle_plan invocation is guaranteed to see this entry.
    expected_modes.set(&session_id, mode);
    let _ = tx.send(deny_response(payload));

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
) -> Result<bool, String> {
    let ok = store.reopen_resolution(&session_id, &comment_id);
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
fn get_interception_mode(settings: tauri::State<'_, Settings>) -> String {
    settings.get().as_str().to_string()
}

/// Single source of truth for a mode transition: persist it, release any held
/// POSTs if we're no longer in Active, and broadcast `mode-changed` so the UI and
/// the tray menu stay in sync regardless of who initiated the change.
fn apply_mode(app: &AppHandle, mode: InterceptionMode) {
    app.state::<Settings>().set(mode);
    if mode != InterceptionMode::Active {
        for tx in app.state::<PendingResponses>().drain_all() {
            let _ = tx.send(allow_response(
                "Superseded — Redline interception mode changed; plan auto-approved.",
            ));
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".parse().unwrap()),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            get_session,
            delete_session,
            add_comment,
            update_comment,
            delete_comment,
            submit_review,
            approve_plan,
            accept_resolution,
            reopen_resolution,
            get_interception_mode,
            set_interception_mode,
            claim_review,
            get_hook_status,
            install_hook,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_kill_all,
            pty::pty_cwd,
        ])
        .setup(|app| {
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

            let store = SessionStore::new(db);
            app.manage(store.clone());

            let pending = PendingResponses::new();
            app.manage(pending.clone());

            let expected_modes = ExpectedModes::new();
            app.manage(expected_modes.clone());

            let app_state = AppState {
                store: store.clone(),
                app_handle: app.handle().clone(),
                pending,
                expected_modes,
                settings: settings.clone(),
                claims,
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
