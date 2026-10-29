// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
mod agent;
mod ai_commit;
mod ai_review;
mod antigravity_hook;
mod asks;
mod auth;
mod binprobe;
mod bookshelf;
mod boot_trace;
mod browse;
mod browse_list;
mod browse_locate;
mod browse_organize;
mod browser_home;
mod browser_actions;
mod browser_events;
#[cfg(target_os = "macos")]
mod browser_popup;
mod browser_overlay;
mod browser_output;
mod browser_workspace;
mod bundle;
mod classmem;
mod claude_models;
mod model_catalog;
mod claude_proc;
mod code;
mod codehealth;
mod codex_app_server;
mod codex_conversation;
mod monochat;
mod codex_hook;
mod codex_profile;
mod combine;
mod companion;
mod companion_build;
mod companion_warm;
mod compose;
mod context;
mod convo;
mod cursor_hook;
mod db;
mod dedup;
mod devmap;
mod dictation;
mod dictation_whisper;
mod draft_chat;
mod embed;
mod extension;
mod extension_host;
mod extension_scaffold;
mod feedback;
mod workbench_menu;
/// File ▸ Print…: ⌘⌥P, since ⌘P is the workbench's Go to File (W4).
pub(crate) const PRINT_ACCELERATOR: &str = "CmdOrCtrl+Alt+P";
mod fork;
mod fsbrowse;
mod fswatch;
mod harness;
mod highlight;
mod hook;
mod hook_config;
mod hook_conflicts;
mod inspect;
mod keeper;
mod ledger;
mod librarian;
mod local_install;
mod marketplace;
/// The MCP snippet generator for the settings surface. The protocol itself is
/// served by the daemon at `/mcp` (`polis_mcp::http_service`, nested in
/// `run_server`); no proxy binary ships any more.
pub mod mcp;
mod plan_launch;
mod plan_provider;
mod plan_submission;
mod provider_hooks;
mod runtime_profile;
mod seatassign;

/// The memory schema's DDL from a fresh database — the referee
/// `tests/schema_golden.rs` pins while the memory tables move into
/// `polis-store` (Session A2 of the Polis extraction). Public because `db` is
/// not; the integration test is the only caller.
pub fn memory_schema_sql() -> String {
    let db = db::Database::open_in_memory().expect("fresh in-memory database");
    db.schema_sql().expect("memory schema dump")
}
mod memchat;
mod meter;
mod mirror;
mod mission;
mod mission_context;
mod mission_contracts;
mod mission_capture;
mod capture_ocr;
mod parser;
#[cfg(test)]
mod perf_guard;
mod pinned_fetch;
mod plan_meter;
mod polis_host;
/// Where the Polis Memory crates' sources are (asked of `cargo metadata`);
/// the same file the integration tests share as `tests/common`.
#[cfg(test)]
#[path = "../tests/common/mod.rs"]
mod polis_src;
mod postboot;
mod preflight;
mod probe;
mod project;
#[cfg(target_os = "macos")]
mod promised_drop;
mod pty;
mod push;
mod guided;
mod git_gui;
mod git_human;
#[cfg(test)]
mod git_test_support;
mod query;
mod renderer_memory;
mod repoicon;
mod resolutions;
mod restore_context;
mod review;
mod review_feedback;
mod transcript;
#[cfg(target_os = "macos")]
mod scroller_guard;
mod seat;
mod shipwright;
mod shots;
mod skill;
mod state;
mod term_attention;
mod thumbs;
mod transparency;
mod tts;
mod tts_studio;
mod turn;
mod turn_scorer;
mod update;
mod userconfig;
mod voice;
mod webview_guard;
mod worktree;
mod workspace_brief;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use axum::{
    extract::{ConnectInfo, Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Redirect},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::net::SocketAddr;
use tauri::{
    menu::{
        CheckMenuItem, Menu, MenuEvent, MenuItem, MenuItemBuilder, MenuItemKind,
        PredefinedMenuItem,
    },
    tray::TrayIconBuilder,
    AppHandle, Emitter, Listener, Manager,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tokio::sync::{oneshot, Notify};

use crate::db::Database;
use crate::hook::HookStatus;
use crate::skill::SkillStatus;
use crate::state::{
    now_millis, AttachState, Comment, InterceptionMode, NewCommentRequest, ReviewSession,
    SessionStatus, SessionStore, SessionSummary, SubmissionMode,
    UpdateCommentRequest,
};

const SETTING_MODE: &str = "interception_mode";
// Live-collaboration relay settings (Phase 1a): the self-hosted signaling
// URLs baked into invite codes, and the owner's display name for presence.
const SETTING_COLLAB_SIGNALING: &str = "collab_signaling";
const SETTING_COLLAB_DISPLAY_NAME: &str = "collab_display_name";
const SETTING_COLLAB_OWNER_SECRET: &str = "collab_owner_secret";
const DEFAULT_COLLAB_SIGNALING: &str = "ws://127.0.0.1:4444";
/// Seconds the Ambient decision window stays open before auto-approving.
const AMBIENT_WINDOW_SECS: u64 = 20;

/// Marker a resumed `claude` writes into its plan file on "Restore plan session"
/// (see `src/lib/resumeCommand.ts`). The daemon already holds the authoritative
/// plan, so on restore it re-presents its own latest revision and ignores the
/// submitted body — this sentinel both triggers that path and guards against a
/// stray submission overwriting a real plan with the placeholder.
/// Prefix of the marker a resumed `claude` writes to its plan file on restore.
/// The bare form is `<!-- REDLINE_RESTORE -->`; the resume command embeds the
/// held plan's session id as `<!-- REDLINE_RESTORE:<id> -->` so the daemon can
/// rebind the restore when the handshake arrives under a forked or foreign id
/// (see `restore_target_id`). Must stay in sync with `restoreSentinel()` in
/// `src/lib/resumeCommand.ts`.
const REDLINE_RESTORE_PREFIX: &str = "<!-- REDLINE_RESTORE";

/// The held plan's session id carried inside a restore sentinel, if any:
/// `<!-- REDLINE_RESTORE:abc-123 -->` → `Some("abc-123")`; the bare
/// `<!-- REDLINE_RESTORE -->` → `None`.
fn restore_target_id(raw_plan: &str) -> Option<String> {
    let needle = "<!-- REDLINE_RESTORE:";
    let start = raw_plan.find(needle)? + needle.len();
    let end = raw_plan[start..].find("-->")?;
    let id = raw_plan[start..start + end].trim();
    (!id.is_empty()).then(|| id.to_string())
}

/// `Some(target)` only when the plan body is *nothing but* a restore
/// sentinel — the handshake contract in `src/lib/resumeCommand.ts` is "write
/// exactly `<!-- REDLINE_RESTORE:<id> -->` as your plan file's contents", so
/// that is what we match. `Some(None)` for the bare form, `None` for any real
/// plan that merely *mentions* the sentinel. A bare `.contains()` here once
/// classified a 200-line plan that quoted the sentinel in an evidence table
/// as a restore handshake and waved it through uncaptured — any plan
/// documenting Redline's own restore protocol was silently unreviewable.
fn restore_handshake(raw_plan: &str) -> Option<Option<String>> {
    let body = raw_plan.trim();
    let rest = body.strip_prefix(REDLINE_RESTORE_PREFIX)?;
    let close = rest.find("-->")?;
    if !rest[close + "-->".len()..].trim().is_empty() {
        return None; // content after the sentinel — a real plan
    }
    let inner = rest[..close].trim();
    if !inner.is_empty() && !inner.starts_with(':') {
        return None; // `<!-- REDLINE_RESTORESOMETHING -->` is not the handshake
    }
    Some(restore_target_id(body))
}

/// The only id shape `rekey_session` may consume from hook input: a lowercase
/// UUID (8-4-4-4-12 hex), the shape of every claude session id. A rekey relocates a live review
/// wholesale (rows, comments, attachment paths), so it must require both a
/// sentinel-only body and a syntactically valid id; prose in a plan body must
/// never be able to move another session's data.
fn valid_session_id(id: &str) -> bool {
    // Claude currently uses lowercase UUIDs while Codex uses opaque thread
    // ids (for example `thr_…`). A restore id never reaches the filesystem by
    // itself, but it can re-key durable review state, so keep the accepted
    // alphabet deliberately narrow and bounded rather than treating it as an
    // arbitrary string.
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}

/// Pull the one official plan block from a Codex Plan-mode final message.
/// Requiring exactly one complete block keeps ordinary Stop hooks, prose that
/// merely discusses the marker, and malformed output out of the review store.
fn extract_codex_proposed_plan(message: &str) -> Option<String> {
    const OPEN: &str = "<proposed_plan>";
    const CLOSE: &str = "</proposed_plan>";
    let start = message.find(OPEN)?;
    if message[start + OPEN.len()..].contains(OPEN) {
        return None;
    }
    let body_start = start + OPEN.len();
    let close_rel = message[body_start..].find(CLOSE)?;
    let close = body_start + close_rel;
    if message[close + CLOSE.len()..].contains(CLOSE) {
        return None;
    }
    let body = message[body_start..close].trim();
    (!body.is_empty()).then(|| body.to_string())
}

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
    /// The reviewer's go-ahead to BUILD (Approve & build, an Ambient
    /// auto-approve), not a pass-through allow: `handle_plan_core` answers it
    /// with the call's own input as `updatedInput` (`answer_for_build`).
    #[serde(skip)]
    build_approval: bool,
}

#[derive(Serialize, Clone, Debug)]
struct HookSpecificOutput {
    #[serde(rename = "hookEventName")]
    hook_event_name: &'static str,
    #[serde(rename = "permissionDecision")]
    permission_decision: &'static str,
    #[serde(rename = "permissionDecisionReason")]
    permission_decision_reason: String,
    /// The tool input the decision stands for. On ExitPlanMode it is what
    /// makes an allow the person's answer: see `answer_for_build`.
    #[serde(rename = "updatedInput", skip_serializing_if = "Option::is_none")]
    updated_input: Option<Value>,
}

fn allow_response(reason: impl Into<String>) -> HookResponse {
    HookResponse {
        hook_specific_output: HookSpecificOutput {
            hook_event_name: "PreToolUse",
            permission_decision: "allow",
            permission_decision_reason: reason.into(),
            updated_input: None,
        },
        build_approval: false,
    }
}

/// The reviewer approved the plan to be built: an allow `handle_plan_core`
/// completes with the call's own input (`answer_for_build`).
fn approval_response(reason: impl Into<String>) -> HookResponse {
    HookResponse { build_approval: true, ..allow_response(reason) }
}

/// ExitPlanMode needs the person on claude 2.1.312: a PreToolUse `allow`
/// alone still raises the CLI's own "Ready to code? Would you like to
/// proceed?" prompt — and so does a PermissionRequest `allow` — unless the
/// decision carries `updatedInput` (the CLI then logs "Hook satisfied user
/// interaction for ExitPlanMode via updatedInput" and builds). Measured
/// 2026-10-28 against the installed CLI with the convo-mirror rig's PTY and
/// hooks (fresh session and `--resume`, haiku): allow alone → the prompt
/// stays and no answer dismisses it but a person's; allow + the call's own
/// `tool_input` → no prompt, the tool result in 0.2 s, no PermissionRequest
/// at all. The CLI reads the plan from the plan file, not from this input
/// (a replaced `plan` was ignored), so the input goes back as it came.
/// Approve & build used to end in that prompt; the walk's fresh Approve only
/// went through because a queued send's Enter answered it, and after a
/// Restore nothing did. A pass-through allow (Paused, a fork, a refused
/// restore) is not the person's answer and keeps the CLI's own prompt.
fn answer_for_build(mut response: HookResponse, payload: &Value) -> HookResponse {
    if response.build_approval && response.hook_specific_output.permission_decision == "allow" {
        let exit_plan = payload.get("tool_name").and_then(Value::as_str) == Some("ExitPlanMode");
        if let Some(input) = payload.get("tool_input").filter(|input| exit_plan && input.is_object()) {
            response.hook_specific_output.updated_input = Some(input.clone());
        }
    }
    response
}

fn deny_response(reason: impl Into<String>) -> HookResponse {
    HookResponse {
        build_approval: false,
        hook_specific_output: HookSpecificOutput {
            hook_event_name: "PreToolUse",
            permission_decision: "deny",
            permission_decision_reason: reason.into(),
            updated_input: None,
        },
    }
}

fn codex_stop_response(decision: HookResponse) -> Value {
    if decision.hook_specific_output.permission_decision == "deny" {
        json!({"decision":"block","reason":decision.hook_specific_output.permission_decision_reason})
    } else {
        // Approval queued a fresh implementation turn with new settings.
        // A hook continuation would inherit the planner's read-only sandbox.
        json!({})
    }
}

/// One held POST: the oneshot to answer it, the registration token that lets
/// the drop-guard remove only its own entry, and the dock terminal the POST
/// came from (`None` = external terminal / unresolvable) — drives the
/// per-terminal "plan intercepted" strip.
struct PendingEntry {
    token: u64,
    approval_id: String,
    approval_lock: Arc<tokio::sync::Mutex<()>>,
    codex_socket: Option<String>,
    tx: oneshot::Sender<HookResponse>,
    terminal_id: Option<String>,
}

struct ApprovalTicket {
    token: u64,
    id: String,
    codex_socket: Option<String>,
    lock: Arc<tokio::sync::Mutex<()>>,
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
                approval_id: uuid::Uuid::new_v4().to_string(),
                approval_lock: Arc::new(tokio::sync::Mutex::new(())),
                codex_socket: None,
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
    fn approval_ticket(&self, session_id: &str) -> Option<ApprovalTicket> {
        self.map
            .lock()
            .unwrap()
            .get(session_id)
            .map(|e| ApprovalTicket {
                token: e.token,
                id: e.approval_id.clone(),
                codex_socket: e.codex_socket.clone(),
                lock: e.approval_lock.clone(),
            })
    }
    fn owns(&self, session_id: &str, token: u64) -> bool {
        self.map
            .lock()
            .unwrap()
            .get(session_id)
            .is_some_and(|e| e.token == token)
    }
    fn set_codex_socket(&self, session_id: &str, token: u64, socket: Option<String>) {
        if let Some(entry) = self
            .map
            .lock()
            .unwrap()
            .get_mut(session_id)
            .filter(|e| e.token == token)
        {
            entry.codex_socket = socket;
        }
    }
    /// Remove and return this session's sender *iff* it is still the one
    /// registered under `token`. Used by the drop-guard: a hit means the held
    /// POST was cancelled (connection dropped) before any decision was sent.
    fn take_if_owned(&self, session_id: &str, token: u64) -> Option<oneshot::Sender<HookResponse>> {
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

/// One held code-review curl (`GET /v1/reviews/start`): the oneshot that will
/// carry the serialized feedback payload back as the response body, plus the
/// registration token that lets the drop-guard remove only its own entry.
/// The review analog of `PendingEntry` — answering plain text, keyed by
/// `review_id`, no terminal strip (the review pane itself is the indicator).
struct PendingReviewEntry {
    token: u64,
    tx: oneshot::Sender<String>,
    /// When this curl was held — pushes recorded BEFORE it are old news and
    /// must not be re-reported in the reply.
    held_at: i64,
}

#[derive(Clone)]
pub(crate) struct PendingReviews {
    map: Arc<StdMutex<HashMap<String, PendingReviewEntry>>>,
    next_token: Arc<AtomicU64>,
}

impl PendingReviews {
    fn new() -> Self {
        Self {
            map: Arc::new(StdMutex::new(HashMap::new())),
            next_token: Arc::new(AtomicU64::new(1)),
        }
    }
    /// Register a held review curl. A stale entry for the same review (an
    /// earlier `/redline-code-review` the agent abandoned or re-ran) is released
    /// with a benign superseded message rather than left hanging.
    fn register(&self, review_id: &str) -> (oneshot::Receiver<String>, u64) {
        let mut map = self.map.lock().unwrap();
        if let Some(stale) = map.remove(review_id) {
            tracing::warn!(review_id = %review_id, "superseding a stale held review curl");
            let _ = stale
                .tx
                .send("Superseded by a newer /redline-code-review from the same repo.".to_string());
        }
        let token = self.next_token.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        map.insert(
            review_id.to_string(),
            PendingReviewEntry {
                token,
                tx,
                held_at: now_millis(),
            },
        );
        (rx, token)
    }
    fn take(&self, review_id: &str) -> Option<oneshot::Sender<String>> {
        self.map.lock().unwrap().remove(review_id).map(|e| e.tx)
    }
    /// When the currently-held curl (if any) started waiting.
    fn held_since(&self, review_id: &str) -> Option<i64> {
        self.map.lock().unwrap().get(review_id).map(|e| e.held_at)
    }
    /// Drop-guard removal: only if this registration still owns the slot.
    fn take_if_owned(&self, review_id: &str, token: u64) -> Option<oneshot::Sender<String>> {
        let mut map = self.map.lock().unwrap();
        match map.get(review_id) {
            Some(e) if e.token == token => map.remove(review_id).map(|e| e.tx),
            _ => None,
        }
    }
    /// A curl is currently held for this review (Submit will answer it live).
    fn has(&self, review_id: &str) -> bool {
        self.map.lock().unwrap().contains_key(review_id)
    }
}

/// Held for the lifetime of a `handle_review_start` await; on drop (curl
/// cancelled, cap fired, response sent) it clears its own registration and
/// tells the UI the hold ended so the pane leaves "submit will reply" mode.
struct ReviewDetachGuard {
    pending: PendingReviews,
    app_handle: AppHandle,
    review_id: String,
    token: u64,
}

impl Drop for ReviewDetachGuard {
    fn drop(&mut self) {
        if self
            .pending
            .take_if_owned(&self.review_id, self.token)
            .is_some()
        {
            tracing::info!(review_id = %self.review_id, "held review curl detached before a decision");
        }
        // Emitted unconditionally: whether answered, cancelled, or capped, the
        // hold is over — the frontend re-checks `review_hold_active`.
        let _ = self.app_handle.emit(
            "review-released",
            ReviewReleasedEvent {
                review_id: self.review_id.clone(),
            },
        );
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

/// The "your feedback had nowhere to go" error, naming the harness that
/// actually left.
///
/// A Codex reviewer told "the Claude Code session ended" is being pointed at a
/// process they never started; the sentence stops describing a recoverable
/// state and starts reading as a bug in Redline. The recovery is identical for
/// both — Restore, then submit again — so only the name changes.
///
/// The phrase "no longer waiting" is load-bearing: `isDetachError` in
/// `src/App.tsx` matches on it to raise the detached banner, so both arms keep
/// it verbatim.
fn detached_delivery_error(backend: &str) -> String {
    let (who, what) = match backend.trim().to_ascii_lowercase().as_str() {
        "codex" => ("Codex", "the Codex session"),
        "cursor" => ("Cursor", "the Cursor session"),
        "antigravity" => ("Antigravity", "the Antigravity session"),
        _ => ("Claude", "the Claude Code session"),
    };
    format!(
        "{who} is no longer waiting for this plan — {what} ended or the hold \
         timed out. Use \"Restore plan session\" to resume it, then submit your \
         review again."
    )
}

/// Reconcile a session to `Detached` when an action (approve / submit)
/// discovers there is no held POST registered for it. The drop-guard and the
/// startup held→detached sweep catch *most* detaches, but a session can still
/// land in "sender gone, attach_state not Detached" through a timing gap (e.g.
/// a connection that closed without cancelling the held future). Without this,
/// the UI keeps showing a healthy-looking in-review plan whose Approve / Submit
/// buttons silently no-op and whose detached banner + Restore affordance never
/// appear. Mirror the `submit_review` send-failure path: persist Detached, tell
/// the UI, refresh the tray. Called right before returning the "no plan is
/// waiting" error so the frontend's `isDetachError` recovery (refresh summaries
/// → derived `detached`) has real state to pick up. The keeper bus's
/// `review-staleness-sweep` watch also calls this periodically (seen-twice,
/// conservative cadence), so the inconsistency reconciles even when no user
/// action trips over it.
fn mark_session_detached(app: &AppHandle, store: &SessionStore, session_id: &str) {
    store.set_attach_state(session_id, AttachState::Detached);
    // The claude process behind this session is gone (or unverifiable); drop its
    // stale pid so a later, unrelated process can't be mistaken for it.
    app.state::<LastClaudePid>().clear(session_id);
    let _ = app.emit(
        "session-detached",
        SessionEvent {
            session_id: session_id.to_string(),
        },
    );
    refresh_tray(app, store);
}

/// Does a plan session's agent exiting (the PTY it ran in is gone) reconcile
/// it to `Detached` now? Only while it is in review, not already detached,
/// and holding no POST — a held one's own drop-guard fires when the
/// connection closes, so this is the revising agent the revise watchdog would
/// otherwise take 90 s to call. The watchdog's liveness gate applies: a
/// `claude` still alive (it was not in that PTY after all) is never declared
/// dead; a pid never captured trusts the exit.
fn agent_exit_detaches(in_review: bool, detached: bool, held: bool, liveness: Option<bool>) -> bool {
    in_review && !detached && !held && liveness != Some(true)
}

/// The frontend saw the PTY a plan session runs in exit (and not because the
/// reviewer closed it): reconcile now instead of on the watchdog's next probe.
/// The `session-detached` it emits is what the automatic resume
/// (`src/lib/useAutoResume.ts`) answers. Returns whether it detached.
#[tauri::command]
async fn report_agent_exit(app: AppHandle, session_id: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<SessionStore>();
        let Some(session) = store.get(&session_id) else { return false };
        let in_review = matches!(session.status, SessionStatus::InReview);
        let detached = session.attach_state == AttachState::Detached;
        let held = app.state::<PendingResponses>().has(&session_id);
        let liveness = if in_review && !detached && !held {
            app.state::<LastClaudePid>().get(&session_id).map(|p| p.is_alive())
        } else {
            None
        };
        if !agent_exit_detaches(in_review, detached, held, liveness) {
            return false;
        }
        tracing::warn!(session_id = %session_id, "plan agent's terminal exited — marking detached");
        mark_session_detached(&app, &store, &session_id);
        true
    })
    .await
    .map_err(|e| e.to_string())
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

/// Holds, per session, the full serialized feedback payload of the most recent
/// `submit_review`, so it can be served out-of-band over the daemon's loopback
/// channel (`GET /v1/sessions/:id/feedback`) instead of being crammed into the
/// denied `ExitPlanMode` reason.
///
/// Sending a plan back keeps Claude in plan mode by *denying* its `ExitPlanMode`
/// call, and Claude Code renders any denied `PreToolUse` as a red `Error:` box
/// whose height is the reason's length — so a multi-KB payload reads as a scary
/// wall even though nothing failed. The `Error:` chrome itself can't be
/// suppressed from the hook side (`docs/protocol-verification.md` Exp. (h)); the
/// one lever we own is the reason's *size*. Moving the bulky body here lets the
/// denied reason shrink to a single calm line (`feedback_deny_reason`) while the
/// body still reaches the model byte-for-byte via the curl the redline skill is
/// pre-authorized to run. Set just before the deny is sent; overwritten on the
/// next submit; fetched idempotently (a duplicate or late curl re-reads it).
#[derive(Clone, Default)]
struct PendingFeedback(Arc<StdMutex<HashMap<String, String>>>);

impl PendingFeedback {
    fn new() -> Self {
        Self::default()
    }
    fn set(&self, session_id: &str, payload: String) {
        self.0
            .lock()
            .unwrap()
            .insert(session_id.to_string(), payload);
    }
    fn get(&self, session_id: &str) -> Option<String> {
        self.0.lock().unwrap().get(session_id).cloned()
    }
    fn clear(&self, session_id: &str) {
        self.0.lock().unwrap().remove(session_id);
    }
}

/// The reason carried by the denied send-back. It leads with a defusing
/// sentence so even the unavoidable `Error:` prefix Claude Code prepends reads
/// as benign, and it is mode-aware so the Ask round-trip keeps its "do not
/// change the plan body" contract.
///
/// The two backends differ in DELIVERY, and that is the whole reason `backend`
/// is a parameter:
///
/// - **claude-code** — one calm line plus a `GET …/feedback` URL. Keeping the
///   bulk out of it is what turned the old wall into a benign line, and the
///   body still reaches the model byte-for-byte via the stash.
/// - **codex** — the payload INLINE. A codex plan session runs under
///   `-s read-only`, and a command the model runs inside that sandbox cannot
///   reach 127.0.0.1 at all (verified against the real binary). Pointing it at
///   a URL would hand the reviewer's feedback to a model physically unable to
///   fetch it. A Stop hook's `reason` is a continuation instruction rather than
///   an error box, so inlining costs nothing there.
///
/// The payload is taken by reference and inlined HERE, at the one place that
/// knows this deny is a review send-back. Reading it back out of
/// `PendingFeedback` later would append a stale review to any *other* deny the
/// same session happens to get (an ask-mode violation, a fork pass-through)
/// — the stash outlives its delivery by design, so it is not a safe signal.
fn feedback_deny_reason(
    mode: SubmissionMode,
    session_id: &str,
    backend: &str,
    payload: &str,
) -> String {
    if matches!(backend, "codex" | "cursor" | "antigravity") {
        let lead = match mode {
            SubmissionMode::Revise => {
                "✅ Plan returned to Redline for revision — nothing failed. The reviewer's \
                 feedback follows; you already have it, so do not try to fetch anything. \
                 Produce the revised plan per your Redline plan contract (keep every \
                 `rl:blk-` marker exactly where its block's content remains, answer every \
                 comment id in a REDLINE_RESOLUTIONS block) and end your turn with one \
                 fresh `<proposed_plan>` block."
            }
            SubmissionMode::Ask => {
                "✅ Returned to Redline — the reviewer has questions and is NOT requesting \
                 changes. They follow; you already have them, so do not try to fetch \
                 anything. Answer them in the REDLINE_RESOLUTIONS block and re-emit the \
                 plan body byte-for-byte unchanged in one `<proposed_plan>` block."
            }
        };
        return format!("{lead}\n\n{payload}");
    }
    let url = format!("http://127.0.0.1:7676/v1/sessions/{session_id}/feedback");
    match mode {
        SubmissionMode::Revise => format!(
            "✅ Plan returned to Redline for revision — your feedback is loaded and nothing \
             failed. Read it with `curl -s {url}`, then produce the revised plan per your \
             `redline-plan-review` skill and call ExitPlanMode again."
        ),
        SubmissionMode::Ask => format!(
            "✅ Returned to Redline — the reviewer has questions about the plan and is NOT \
             requesting changes. Read them with `curl -s {url}`, then, per your \
             `redline-plan-review` skill, call ExitPlanMode again with the plan body \
             unchanged and your answers in the REDLINE_RESOLUTIONS block."
        ),
    }
}

/// How long, after a revise's feedback is delivered, we wait for Claude to come
/// back with a fresh plan before assuming the feedback was lost. A revise's
/// `deny` send *succeeds* even when the held POST's Claude has quietly abandoned
/// the wait (the socket lingered) — so the feedback vanishes silently and the
/// reviewer is left staring at a review that will never update. Claude normally
/// answers a revise by re-entering plan mode and re-POSTing within a few
/// seconds; this window is deliberately generous so a slow-but-alive re-plan is
/// never mistaken for a drop. See `arm_revise_watchdog`.
const REVISE_WATCHDOG: Duration = Duration::from_secs(90);

/// Per-session generation counter, bumped on every `submit_review`. The revise
/// watchdog captures the generation it armed under and bails if a newer submit
/// has since superseded it — so back-to-back revisions don't let an older
/// watchdog fire against a younger round-trip.
#[derive(Clone, Default)]
struct ReviseWatch(Arc<StdMutex<HashMap<String, u64>>>);

impl ReviseWatch {
    fn new() -> Self {
        Self::default()
    }
    /// Increment this session's generation and return the new value.
    fn bump(&self, session_id: &str) -> u64 {
        let mut map = self.0.lock().unwrap();
        let gen = map.entry(session_id.to_string()).or_insert(0);
        *gen += 1;
        *gen
    }
    fn current(&self, session_id: &str) -> u64 {
        self.0.lock().unwrap().get(session_id).copied().unwrap_or(0)
    }
}

/// The OS process behind a session's held POST — the long-lived `claude`/node
/// process that opened the hook connection. Captured on every plan POST and
/// probed by the revise watchdog: a live process means Claude is busy (or
/// blocked on a tool-permission prompt), not gone, so we must not declare it
/// detached just because a fresh plan hasn't arrived yet.
#[derive(Clone)]
struct ClaudeProc {
    pid: u32,
    /// `ps -o comm=` snapshot at capture time. Compared verbatim at probe time
    /// so a reused pid now running something else reads as dead (we never parse
    /// it — only test equality — so full-path vs basename doesn't matter).
    comm: String,
}

impl ClaudeProc {
    /// Alive iff a process with this pid exists *and* its command still matches
    /// what we captured (guards pid reuse). `comm_of` is injected for testing.
    fn is_alive_with(&self, comm_of: impl FnOnce(u32) -> Option<String>) -> bool {
        comm_of(self.pid).is_some_and(|c| c == self.comm)
    }
    fn is_alive(&self) -> bool {
        self.is_alive_with(current_comm)
    }
}

/// `ps -p <pid> -o comm=` — `None` when no such process (dead) or the output is
/// empty. One call yields both liveness and identity (for the reuse guard),
/// and shells out like the neighbouring `ppid_of`, so no new dependency.
/// `pub(crate)` because the Localhost dashboard needs the identical guard
/// before it signals a dev server (`devmap::dev_server_stop`).
pub(crate) fn current_comm(pid: u32) -> Option<String> {
    let out = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// Per-session record of the claude process behind the most recent plan POST.
/// In-memory (not persisted): a pid is only meaningful within one app-process
/// lifetime, and the watchdog task that reads it never survives a restart, so a
/// persisted pid would only risk matching a reused pid after relaunch. Refreshed
/// on every POST in `handle_plan`.
#[derive(Clone, Default)]
struct LastClaudePid(Arc<StdMutex<HashMap<String, ClaudeProc>>>);

impl LastClaudePid {
    fn set(&self, session_id: &str, proc: ClaudeProc) {
        self.0.lock().unwrap().insert(session_id.to_string(), proc);
    }
    fn get(&self, session_id: &str) -> Option<ClaudeProc> {
        self.0.lock().unwrap().get(session_id).cloned()
    }
    fn clear(&self, session_id: &str) {
        self.0.lock().unwrap().remove(session_id);
    }
}

/// What the revise watchdog should do when it wakes — extracted as a pure
/// function so the decision table is testable without 90s sleeps. `liveness` is
/// `None` when no pid was ever captured (lsof failed / unresolvable), in which
/// case we fall back to the original blind-timer detach.
#[derive(Debug, PartialEq, Eq)]
enum WatchdogStep {
    Stop,
    ReArm,
    Detach,
}

fn watchdog_step(
    has_plan: bool,
    gen_ok: bool,
    in_review: bool,
    liveness: Option<bool>,
) -> WatchdogStep {
    if has_plan || !gen_ok || !in_review {
        // A fresh plan landed, a newer revise superseded us, or the session was
        // approved/closed — nothing left to recover.
        return WatchdogStep::Stop;
    }
    match liveness {
        // Claude is alive: busy re-planning, or blocked on a permission prompt.
        // Keep watching so we still recover if it later dies.
        Some(true) => WatchdogStep::ReArm,
        // Dead, or pid never captured — the feedback was lost.
        Some(false) | None => WatchdogStep::Detach,
    }
}

/// Advance a plan's build chip (`building` when an agent starts building it,
/// `landed` when it is marked Completed) and tell the UI. The store setter
/// journals and reports whether the state actually changed; only a real
/// transition emits.
fn advance_run_state(app: &AppHandle, store: &SessionStore, session_id: &str, state: &str) {
    if advance_run_state_inner(store, session_id, state) {
        let _ = app.emit("run-state-changed", SessionEvent { session_id: session_id.to_string() });
    }
}

/// Set a plan's build state without requiring a window, for manual completion.
fn advance_run_state_inner(store: &SessionStore, session_id: &str, state: &str) -> bool {
    store.set_run_state(session_id, state)
}

/// Safety net for a revise whose feedback was delivered into a held POST that
/// Claude had already abandoned: spawn a task that, after `REVISE_WATCHDOG`,
/// checks whether Claude actually picked the feedback up. "Picked up" means
/// either a fresh plan is now held for the session (`pending.has`) or a newer
/// revise has since been submitted (generation advanced). If neither — and the
/// session is still in review (not approved/closed in the meantime) — we probe
/// whether the session's `claude` process is still alive: if it is, Claude is
/// merely busy or blocked on a tool-permission prompt (the daemon can't see the
/// prompt — it never parses the terminal), so we re-arm and keep watching
/// rather than falsely declaring the session dead. Only when the process is gone
/// (or was never captured) is the feedback truly lost — then reconcile to
/// `Detached` and surface the Restore affordance. A late plan that *does*
/// eventually arrive re-registers as `Held` and clears the derived detached
/// state, so flipping here is self-correcting.
fn arm_revise_watchdog(
    app: AppHandle,
    store: SessionStore,
    pending: PendingResponses,
    revise_watch: ReviseWatch,
    last_pid: LastClaudePid,
    session_id: String,
) {
    let armed_gen = revise_watch.bump(&session_id);
    schedule_revise_probe(
        app,
        store,
        pending,
        revise_watch,
        last_pid,
        session_id,
        armed_gen,
    );
}

/// One probe of the revise watchdog, scheduled through the keeper's watch bus
/// as an event-armed one-shot (`keeper::schedule_once`) — deliberately NOT a
/// periodic bus watch: it is armed by a submit, fires once after
/// `REVISE_WATCHDOG` (the bus's 30s tick quantizes the delay upward by at
/// most one tick; the window was always deliberately generous), and on
/// `ReArm` simply schedules the next probe. The semantics — the
/// `watchdog_step` decision table, the generation guard, and the liveness
/// probe (a live `claude` is busy or blocked, never declared dead) — are
/// unchanged from the old self-sleeping task.
fn schedule_revise_probe(
    app: AppHandle,
    store: SessionStore,
    pending: PendingResponses,
    revise_watch: ReviseWatch,
    last_pid: LastClaudePid,
    session_id: String,
    armed_gen: u64,
) {
    keeper::schedule_once(
        format!("revise-watchdog:{session_id}"),
        REVISE_WATCHDOG,
        move || {
            Box::pin(async move {
                let has_plan = pending.has(&session_id);
                let gen_ok = revise_watch.current(&session_id) == armed_gen;
                let in_review = matches!(
                    store.get(&session_id).map(|s| s.status),
                    Some(SessionStatus::InReview)
                );
                // Only probe the process when the cheap checks haven't already
                // settled it — keeps a single `ps` per live, still-waiting
                // session.
                let liveness = if has_plan || !gen_ok || !in_review {
                    None
                } else if let Some(proc) = last_pid.get(&session_id) {
                    Some(
                        tokio::task::spawn_blocking(move || proc.is_alive())
                            .await
                            .unwrap_or(false),
                    )
                } else {
                    None
                };

                match watchdog_step(has_plan, gen_ok, in_review, liveness) {
                    WatchdogStep::Stop => {}
                    WatchdogStep::ReArm => {
                        // Alive: busy re-planning or blocked on a permission
                        // prompt. Schedule another window; we'll detach if it
                        // later dies.
                        tracing::debug!(
                            session_id = %session_id,
                            "revise watchdog: claude still alive (busy or blocked on a \
                             permission prompt) — re-arming"
                        );
                        schedule_revise_probe(
                            app,
                            store,
                            pending,
                            revise_watch,
                            last_pid,
                            session_id,
                            armed_gen,
                        );
                    }
                    WatchdogStep::Detach => {
                        tracing::warn!(
                            session_id = %session_id,
                            "revise watchdog: no new plan and claude not alive — feedback \
                             likely lost, marking detached"
                        );
                        let _ = store.database().record_friction(
                            "revise_watchdog",
                            Some("plan"),
                            Some(&session_id),
                            Some("no new plan and claude not alive — feedback likely lost"),
                        );
                        mark_session_detached(&app, &store, &session_id);
                    }
                }
            }) as keeper::OneShotFut
        },
    );
}

/// Where the daemon's bind of `127.0.0.1:7676` has got to.
///
/// Three states, not a boolean, because the boolean conflated two very
/// different situations: "we have not tried yet" and "we tried and another
/// process owns the port". The frontend papered over that by *defaulting the
/// flag to true* so a fresh window wouldn't flash a scary banner — which meant
/// the honest answer and the optimistic guess were indistinguishable, and
/// nothing could legitimately wait for readiness. Now shell rendering ignores
/// this entirely and a launch awaits `Ready`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DaemonState {
    /// The bind has not resolved yet. Not an error, not a success.
    Starting,
    /// Bound. Plans arriving on the port land in this window.
    Ready,
    /// The bind failed — another process holds the port, so this window can
    /// capture no plans. The UI shows a blocking banner rather than looking
    /// healthy. Single-instance makes this rare; a non-Redline squatter on
    /// the port can still cause it.
    Failed,
}

impl DaemonState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Default)]
struct DaemonStatus(Arc<AtomicU8>);

/// `AtomicU8` discriminants for `DaemonState`. `Starting` is 0 so `Default`
/// (which every `DaemonStatus::new` uses) is the honest "not yet" state.
const DAEMON_STARTING: u8 = 0;
const DAEMON_READY: u8 = 1;
const DAEMON_FAILED: u8 = 2;

impl DaemonStatus {
    fn new() -> Self {
        Self(Arc::new(AtomicU8::new(DAEMON_STARTING)))
    }
    fn set_bound(&self, bound: bool) {
        self.0.store(
            if bound { DAEMON_READY } else { DAEMON_FAILED },
            Ordering::SeqCst,
        );
    }
    fn state(&self) -> DaemonState {
        match self.0.load(Ordering::SeqCst) {
            DAEMON_READY => DaemonState::Ready,
            DAEMON_FAILED => DaemonState::Failed,
            _ => DaemonState::Starting,
        }
    }
}

#[derive(Clone)]
struct AppState {
    store: SessionStore,
    app_handle: AppHandle,
    pending: PendingResponses,
    /// Held code-review curls (`/v1/reviews/start`), keyed by review id.
    pending_reviews: PendingReviews,
    expected_modes: ExpectedModes,
    /// Out-of-band feedback bodies served by `GET /v1/sessions/:id/feedback`,
    /// so the denied `ExitPlanMode` reason stays a single calm line. See
    /// `PendingFeedback`.
    pending_feedback: PendingFeedback,
    settings: Settings,
    claims: ClaimFlags,
    fork: fork::ForkState,
    daemon_status: DaemonStatus,
    /// The label of the browser tab the user is currently looking at, kept in
    /// sync by `browser_set_active`. The browse-agent daemon routes act on this
    /// tab so a headless agent can drive "the page on screen" without knowing
    /// tab ids. `None` when the browser pane is closed / has no tab.
    active_browser: ActiveBrowser,
    /// Mirror of every open browser tab, so the daemon routes can resolve a tab
    /// selector to a webview label / discussion `browse_id` and serve the tab
    /// registry. Kept in sync by `browser_set_tabs`.
    browser_tabs: BrowserTabs,
    /// Per-tab DOM snapshot cache, so the cache-aware read routes can serve a
    /// tab whose webview is suspended or not yet materialized.
    snapshot_cache: SnapshotCache,
    /// The active research mission (its goal/title/status), mirrored from the
    /// frontend so the daemon's `/v1/mission/*` routes can answer "what's the
    /// mission" and "what's pinned" for the orchestrator agent. `None` when no
    /// mission is active. Kept in sync by `mission_set_active`.
    active_mission: ActiveMission,
    /// Where the user is in the app right now (pane/surface + id), mirrored
    /// from the frontend by `surface_set_active`. Backs `GET /v1/surface/active`
    /// and the Companion's grounding.
    active_surface: ActiveSurface,
    /// Polis Memory's router state (Session A6 of the extraction): the owned
    /// `MemoryApi` handle, Redline's ingest observer, and the event bus its
    /// writes report on. The `FromRef` below is what lets
    /// `polis_server::router()` merge into this state.
    polis: polis_server::PolisState,
}

impl axum::extract::FromRef<AppState> for polis_server::PolisState {
    fn from_ref(state: &AppState) -> Self {
        state.polis.clone()
    }
}

/// The active mission's identity + goal, mirrored from the frontend (which owns
/// mission state, like the tab list). Backs the daemon's `/v1/mission/active`
/// route; the findings route resolves the `mission_id` from here, then loads the
/// pins from the DB via `MissionState`. Same ownership model as `ActiveBrowser`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveMissionInfo {
    mission_id: String,
    title: String,
    goal: String,
    status: String,
}

#[derive(Clone, Default)]
pub struct ActiveMission(Arc<StdMutex<Option<ActiveMissionInfo>>>);

impl ActiveMission {
    fn new() -> Self {
        Self::default()
    }
    fn set(&self, info: Option<ActiveMissionInfo>) {
        *self.0.lock().unwrap() = info.filter(|i| !i.mission_id.is_empty());
    }
    fn get(&self) -> Option<ActiveMissionInfo> {
        self.0.lock().unwrap().clone()
    }
    /// The active mission's `(title, goal)`, for baking mission-awareness into
    /// a chat's first-turn prompt (the orchestrator embeds the goal natively).
    /// `None` when no mission is active. Managed as Tauri state, so a send can
    /// read it without a frontend round-trip.
    pub fn active_goal(&self) -> Option<(String, String)> {
        self.0
            .lock()
            .unwrap()
            .as_ref()
            .map(|i| (i.title.clone(), i.goal.clone()))
    }
    /// The active mission's id — the parent candidate `resolve_parent` uses for
    /// browser-family threads created while a mission is running.
    pub fn active_id(&self) -> Option<String> {
        self.0.lock().unwrap().as_ref().map(|i| i.mission_id.clone())
    }
    /// Refresh the mirrored title/goal when the edited mission is the active
    /// one, so a goal edit reaches the daemon without a frontend re-push (the
    /// frontend mirror is id-driven and only re-pushes on identity change).
    pub fn update_goal_if_active(&self, mission_id: &str, title: &str, goal: &str) {
        let mut guard = self.0.lock().unwrap();
        if let Some(info) = guard.as_mut().filter(|i| i.mission_id == mission_id) {
            info.title = title.to_string();
            info.goal = goal.to_string();
        }
    }
}

/// Where the user is in the app right now, mirrored from the frontend (which
/// owns pane/tab state) via `surface_set_active`. Read by the Companion's
/// per-turn grounding, by `resolve_parent` when a new interaction thread is
/// created, and by the daemon's `GET /v1/surface/active`. Same ownership model
/// as `ActiveBrowser`/`ActiveMission`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceInfo {
    /// `plan | drafter | browser | review | servers | memory | terminal |
    /// welcome`. Free-form on purpose — a new surface needs no backend change
    /// here.
    pub kind: String,
    /// The surface's id in its own id-space (plan session id, draft id,
    /// browse id, review id). `None` for terminal/welcome.
    pub id: Option<String>,
    /// Human title: plan title, tab title, repo name.
    pub label: Option<String>,
    /// Secondary context: tab url, active file.
    pub detail: Option<String>,
    pub project_path: Option<String>,
    pub updated_at: i64,
}

#[derive(Clone, Default)]
pub struct ActiveSurface(Arc<StdMutex<SurfaceInfo>>);

impl ActiveSurface {
    fn new() -> Self {
        Self::default()
    }
    fn set(&self, info: SurfaceInfo) {
        if info.kind.trim().is_empty() {
            return;
        }
        *self.0.lock().unwrap() = info;
    }
    pub fn get(&self) -> SurfaceInfo {
        self.0.lock().unwrap().clone()
    }
    /// The `(kind, id)` pair `resolve_parent` matches on, when this surface
    /// carries an id.
    pub fn kind_and_id(&self) -> Option<(String, String)> {
        let s = self.0.lock().unwrap();
        s.id.as_ref()
            .filter(|id| !id.trim().is_empty())
            .map(|id| (s.kind.clone(), id.clone()))
    }
}

/// Mirror the frontend's "where is the user" into the backend. Queues a
/// `surface_switch` journal row when the surface identity actually changed
/// (kind or id), so pure metadata refreshes (title updates) stay quiet.
///
/// Stays on the main thread on purpose (calls keep their order for free) and
/// so must never wait on the database: it fires on every tab swap, and while
/// it took the writer for its journal row, a swap during a `memory_status` or
/// a dev-server scan beach-balled the window (2026-10-29). The row goes
/// through `enqueue_journal`, which only takes the queue's lock.
#[tauri::command]
fn surface_set_active(
    active: tauri::State<'_, ActiveSurface>,
    store: tauri::State<'_, SessionStore>,
    info: SurfaceInfo,
) {
    set_active_surface(&active, &store.database(), info);
}

/// `surface_set_active`'s body: an in-memory cell and a queued row.
fn set_active_surface(active: &ActiveSurface, db: &Database, mut info: SurfaceInfo) {
    if info.kind.trim().is_empty() {
        return;
    }
    info.updated_at = ledger::now_millis();
    let prev = active.get();
    let changed = prev.kind != info.kind || prev.id != info.id;
    active.set(info.clone());
    if changed {
        db.enqueue_journal(
            "surface_switch",
            Some(&info.kind),
            info.id.as_deref(),
            info.label.as_deref(),
            info.detail.as_deref(),
        );
    }
}

/// Shared "which browser tab is active" cell. The frontend owns the truth
/// (`BrowserPane`'s active tab); this mirrors it into the backend so the
/// `/v1/browser/*` daemon routes can resolve a webview label. Managed as Tauri
/// state (for `browser_set_active`) and cloned into `AppState` (for the daemon).
#[derive(Clone, Default)]
struct ActiveBrowser(Arc<StdMutex<Option<String>>>);

impl ActiveBrowser {
    fn new() -> Self {
        Self(Arc::new(StdMutex::new(None)))
    }
    fn set(&self, label: Option<String>) {
        *self.0.lock().unwrap() = label.filter(|l| !l.is_empty());
    }
    fn get(&self) -> Option<String> {
        self.0.lock().unwrap().clone()
    }
}

/// One open browser tab, mirrored from the frontend (`BrowserPane` owns the tab
/// list). Backs the `/v1/browser/tabs` registry and lets the daemon resolve a
/// tab *selector* (short id or label) to a webview label or its discussion
/// `browse_id` — so a browse agent can look at / drive / read the history of any
/// tab, not just the active one.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TabInfo {
    /// Short tab id (`t3`).
    id: String,
    /// Native webview label (`browser-t3`).
    label: String,
    url: String,
    title: String,
    #[serde(default)]
    favicon: Option<String>,
    /// This tab's discussion-thread key. Used by `/v1/browser/thread`; never
    /// returned by `/v1/browser/tabs` (it's a backend-internal handle).
    browse_id: String,
}

/// Shared mirror of the frontend's open-tab list. Same ownership model as
/// `ActiveBrowser`: the frontend is the source of truth and pushes updates via
/// `browser_set_tabs`; the daemon reads it to resolve cross-tab requests.
#[derive(Clone, Default)]
struct BrowserTabs(Arc<StdMutex<Vec<TabInfo>>>);

impl BrowserTabs {
    fn new() -> Self {
        Self::default()
    }
    fn set(&self, tabs: Vec<TabInfo>) {
        *self.0.lock().unwrap() = tabs;
    }
    fn get(&self) -> Vec<TabInfo> {
        self.0.lock().unwrap().clone()
    }
}

/// A cached DOM snapshot for one browser tab, keyed by webview label. Lets the
/// browse agent read / discuss a tab whose webview is suspended or not yet
/// materialized: the cache-aware `/v1/browser/*` read routes fall back to this
/// when the tab isn't live. Captured on navigation and just before a tab is
/// backgrounded (`browser_cache_snapshot`).
#[derive(Clone)]
struct CachedSnapshot {
    /// Raw JSON string from `SNAPSHOT_JS`.
    json: String,
    /// URL the snapshot was captured at (so callers can judge staleness).
    url: String,
    /// Capture time, epoch millis.
    captured_at: i64,
    /// Scroll offset `(x, y)` captured when the tab was suspended, re-applied
    /// when it wakes. `None` for snapshots captured from a still-live tab.
    scroll: Option<(f64, f64)>,
}

/// Backend-owned snapshot cache, keyed by webview label. Deliberately NOT a
/// field on `TabInfo`: `browser_set_tabs` wholesale-replaces the `BrowserTabs`
/// Vec on every poll-driven title/url update, which would clobber any snapshot
/// stored there. Pruned to the live tab set whenever the tab list changes.
#[derive(Clone, Default)]
struct SnapshotCache(Arc<StdMutex<HashMap<String, CachedSnapshot>>>);

impl SnapshotCache {
    fn new() -> Self {
        Self::default()
    }
    fn put(&self, label: String, snap: CachedSnapshot) {
        self.0.lock().unwrap().insert(label, snap);
    }
    fn get(&self, label: &str) -> Option<CachedSnapshot> {
        self.0.lock().unwrap().get(label).cloned()
    }
    /// Take (and clear) a suspended tab's saved scroll offset, so it's re-applied
    /// exactly once when the tab wakes.
    fn take_scroll(&self, label: &str) -> Option<(f64, f64)> {
        self.0
            .lock()
            .unwrap()
            .get_mut(label)
            .and_then(|s| s.scroll.take())
    }
    /// Drop cache entries whose label is no longer present, so closed tabs don't
    /// leak snapshots.
    fn retain(&self, keep: &std::collections::HashSet<String>) {
        self.0.lock().unwrap().retain(|label, _| keep.contains(label));
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PlanReceivedEvent {
    session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    launch_id: Option<String>,
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

/// Payload of `plan-passed-through`: an inbound plan answered `allow` without
/// being captured for review. Surfaced in the UI because a skipped capture
/// otherwise renders identically to "the user never submitted a plan".
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanPassedThroughEvent {
    session_id: String,
    reason: String,
}

/// Every `handle_plan` early return that answers `allow` without capturing
/// the plan goes through here: record it as friction and announce it to the
/// UI. Silent success is the failure mode that hid the sentinel-prose bug —
/// an error-shaped outcome must never be indistinguishable from a capture.
fn plan_passed_through(app_state: &AppState, session_id: &str, reason: &str) -> HookResponse {
    let _ = app_state.store.database().record_friction(
        "plan_passed_through",
        Some("plan"),
        Some(session_id),
        Some(reason),
    );
    if let Err(e) = app_state.app_handle.emit(
        "plan-passed-through",
        PlanPassedThroughEvent {
            session_id: session_id.to_string(),
            reason: reason.to_string(),
        },
    ) {
        tracing::warn!(error = %e, "failed to emit plan-passed-through");
    }
    allow_response(reason)
}

/// Steps 3→4 of the interception chain: register the held POST (superseding a
/// stale hold for the same session) with the dock terminal it resolved to.
/// Factored out of `handle_plan` so the capture→hold→indicator seam is
/// testable with an injected terminal id — the lsof/ps resolver (step 2) has
/// its own coverage and stays out of unit tests.
fn register_hold(
    pending: &PendingResponses,
    session_id: &str,
    terminal_id: Option<String>,
) -> (oneshot::Receiver<HookResponse>, u64) {
    match pending.register(session_id, terminal_id.clone()) {
        Some(pair) => pair,
        None => {
            if let Some(stale) = pending.take(session_id) {
                tracing::warn!(session_id = %session_id, "superseding a stale held POST for this session");
                let _ = stale.send(allow_response(
                    "Superseded by a newer plan from the same session.",
                ));
            }
            pending
                .register(session_id, terminal_id)
                .expect("pending slot freed above")
        }
    }
}

async fn handle_plan(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(app_state): State<AppState>,
    Json(payload): Json<Value>,
) -> Json<HookResponse> {
    Json(handle_plan_core(peer, app_state, payload).await)
}

/// Codex's Stop hook is the plan-mode equivalent of Claude Code's
/// `PreToolUse(ExitPlanMode)`. Normalize it into the existing plan wire shape
/// so parsing, persistence, review holds, Ambient mode, and restore all keep a
/// single implementation.
async fn handle_codex_stop(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(app_state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Json<Value> {
    // Every Stop names the launcher's socket: the conversation mirror's
    // binding for a dock terminal (`convo::codex`), plan or not.
    if let Some(terminal_id) = term_attention::terminal_header(&headers) {
        let socket = headers.get("X-Redline-Codex-Socket").and_then(|v| v.to_str().ok());
        convo::observe_codex(&app_state.app_handle, &terminal_id, socket, &payload);
    }
    // Gate on the BLOCK, not on the mode. A Redline-launched Codex session
    // runs in `default` mode with the plan contract injected as
    // `developer_instructions` (no CLI flag starts the TUI in native Plan
    // Mode), so a `permission_mode == "plan"` gate would reject every plan
    // this app launches. Safe because `extract_codex_proposed_plan` is already
    // strict — exactly one *complete* block, rejecting prose that merely
    // mentions the marker — and a natively-started Plan Mode session still
    // matches unchanged.
    let Some(plan) = payload
        .get("last_assistant_message")
        .and_then(Value::as_str)
        .and_then(extract_codex_proposed_plan)
    else {
        // An ordinary turn ended: in a dock terminal, that is "your turn".
        if let Some(terminal_id) = term_attention::terminal_header(&headers) {
            term_attention::observe_codex_stop(&app_state.app_handle, &terminal_id, &payload);
        }
        return Json(json!({}));
    };
    let normalized = json!({
        "session_id": payload.get("session_id").cloned().unwrap_or(Value::Null),
        "tool_use_id": payload.get("turn_id").cloned().unwrap_or(Value::Null),
        "cwd": payload.get("cwd").cloned().unwrap_or(Value::Null),
        "model": payload.get("model").cloned().unwrap_or(Value::Null),
        "tool_input": { "plan": plan },
        "redline_provider": "codex",
        "redline_codex_socket": headers.get("X-Redline-Codex-Socket").and_then(|v| v.to_str().ok()),
        "redline_launch_id": headers.get(plan_launch::HEADER).and_then(|v|v.to_str().ok())
    });
    let decision = handle_plan_core(peer, app_state, normalized).await;
    Json(codex_stop_response(decision))
}

/// The native CLIs have different wire formats, but share the same review hold.
async fn hold_provider_plan(
    peer: SocketAddr,
    state: AppState,
    submission: plan_submission::PlanSubmission,
    headers: &HeaderMap,
) -> Json<Value> {
    let backend = submission.backend;
    let mut payload = submission.into_payload();
    payload["redline_launch_id"] = json!(headers
        .get(plan_launch::HEADER)
        .and_then(|v| v.to_str().ok()));
    let response = handle_plan_core(peer, state, payload).await;
    let decision = if response.hook_specific_output.permission_decision == "deny" {
        plan_submission::ReviewDecision::Continue(
            response.hook_specific_output.permission_decision_reason,
        )
    } else {
        plan_submission::ReviewDecision::Approve
    };
    Json(decision.encode(backend))
}

fn provider_project(payload: &mut Value, headers: &HeaderMap) {
    if let Some(path) = headers
        .get("x-redline-project")
        .and_then(|v| v.to_str().ok())
        .filter(|p| std::path::Path::new(p).is_absolute())
    {
        payload["redlineProjectPath"] = json!(path);
        if payload
            .pointer("/workspace_roots/0")
            .and_then(Value::as_str)
            .is_none()
        {
            payload["workspace_roots"] = json!([path]);
        }
    }
}

async fn handle_cursor_prompt(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(mut payload): Json<Value>,
) -> Json<Value> {
    provider_project(&mut payload, &headers);
    let prompt = payload.get("prompt").and_then(Value::as_str).unwrap_or("");
    // The compact launch contract is agent context, never a human memory row.
    let prompt = prompt.strip_prefix("Use the installed redline-plan-review skill. Remain in read-only research and planning mode. Finish with exactly one complete <proposed_plan>...</proposed_plan> envelope containing the full plan.\n\n").unwrap_or(prompt);
    let normalized = json!({"prompt":prompt,"session_id":payload.get("conversation_id"),"cwd":payload.pointer("/workspace_roots/0"),"redline_provider":"cursor"});
    if let Ok(body) = serde_json::to_vec(&normalized) {
        let _ =
            polis_server::ingest::handle_prompts_ingest(State(state.polis), headers, body.into())
                .await;
    }
    Json(json!({"continue":true}))
}

async fn handle_cursor_response(headers: HeaderMap, Json(mut payload): Json<Value>) -> Json<Value> {
    provider_project(&mut payload, &headers);
    if !headers
        .get("x-redline-agent")
        .is_some_and(|v| !v.as_bytes().is_empty())
    {
        cursor_hook::record(&payload);
    }
    Json(json!({}))
}

async fn handle_cursor_stop(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Json<Value> {
    match cursor_hook::take(&payload).await {
        Some(submission) => hold_provider_plan(peer, state, submission, &headers).await,
        None => Json(json!({})),
    }
}

async fn handle_antigravity_stop(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(mut payload): Json<Value>,
) -> Json<Value> {
    if headers
        .get("x-redline-agent")
        .is_some_and(|v| !v.as_bytes().is_empty())
    {
        return Json(json!({"decision":"allow"}));
    }
    provider_project(&mut payload, &headers);
    match antigravity_hook::submission(&payload) {
        Ok(Some(submission)) => hold_provider_plan(peer, state, submission, &headers).await,
        Ok(None) => Json(json!({"decision":"allow"})),
        Err(error) => {
            tracing::warn!(%error, "Antigravity plan intake skipped");
            Json(json!({"decision":"allow"}))
        }
    }
}

async fn handle_plan_core(peer: SocketAddr, app_state: AppState, payload: Value) -> HookResponse {
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
        return allow_response("Redline is paused — this plan was auto-approved without review.");
    }

    // Model provenance: by ExitPlanMode time the transcript has assistant
    // turns, so any of this session's prompts still lacking a model (hook
    // captures carry no seat) get stamped here. Guarded to a single EXISTS
    // probe when there's nothing to do.
    backfill_from_transcript(&app_state.store.database(), &payload, &session_id);

    // A fork agent (a "Discuss" thread) inherits this hook. If one ever calls
    // ExitPlanMode, the POST arrives under the fork's own session id — never
    // capture it as a plan; that would spawn a phantom review revision.
    if app_state.fork.is_known_fork_session(&session_id) {
        tracing::info!(session_id = %session_id, "ignoring ExitPlanMode POST from a known fork session");
        return plan_passed_through(
            &app_state,
            &session_id,
            "This plan came from a Redline discussion-thread fork; it was not captured for review.",
        );
    }

    // Bulletproof restore rebind: a restore handshake carries the held plan's
    // session id (`<!-- REDLINE_RESTORE:<id> -->`). It can arrive under a
    // *different* id than the plan it names — `claude --resume` forks a new
    // session id, and a resume command pasted into an already-running Claude
    // REPL runs the handshake under that REPL's own id. When the sentinel names
    // a held session that isn't this one, re-key it onto the incoming id so the
    // rest of this handler — and every future revision from this terminal — sees
    // the held plan under the live session and restores it, instead of capturing
    // the placeholder as a brand-new plan.
    // The sentinel decision, made ONCE on the anchored contract: `Some` only
    // when the body is nothing but the sentinel. Every restore branch below
    // consumes this — never a substring probe over the plan body.
    let restore_sentinel = restore_handshake(&raw_plan);
    if let Some(Some(target)) = restore_sentinel.clone() {
        if !valid_session_id(&target) {
            tracing::warn!(
                session_id = %session_id, target = %target,
                "restore sentinel carries a malformed session id — refusing to rekey"
            );
        } else if target != session_id
            && !app_state.store.has_session(&session_id)
            && app_state.store.rekey_session(&target, &session_id)
        {
            tracing::info!(
                from = %target, to = %session_id,
                "rebound restore handshake to the live session id"
            );
            // Attachment files are stored under the session id and referenced
            // by absolute path. `rekey_session` already rewrote the paths; move
            // the directory they now point at (that half needs the app handle).
            fsbrowse::rekey_session_attachments(&app_state.app_handle, &target, &session_id);
        }
    }

    let resolution_result = resolutions::extract_resolutions(&raw_plan);
    if let Some(err) = resolution_result.parse_error.as_deref() {
        // A malformed REDLINE_RESOLUTIONS block from the model: computed here
        // on every revision and, until now, never counted anywhere.
        let _ = app_state.store.database().record_friction(
            "resolution_parse_error",
            Some("plan"),
            Some(&session_id),
            Some(err),
        );
    }
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
        Some(prev) => {
            parser::parse_plan_with_sidecars_relative_to(&resolution_result.stripped_markdown, prev)
        }
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
            .and_then(|s| {
                s.revisions
                    .last()
                    .map(|r| parser::plan_text_signature(&r.sections))
            })
            .unwrap_or_default();
        let new_sig = parser::plan_text_signature(&sections);
        prev_sig == new_sig
    };

    // Ask round-trip detection: the prior submit_review was an Ask batch AND
    // Claude returned the plan body unchanged.
    let ask_round_trip = expected_mode == Some(SubmissionMode::Ask) && same_as_prev;

    // One-shot restore: the reviewer re-presented an already-reviewed plan via
    // "Restore plan session". The daemon already holds the authoritative plan,
    // so restore re-presents its own latest revision and ignores the submitted
    // body (a resumed `claude` need only fire ExitPlanMode). Triggered by the
    // armed flag (always consumed, strictly one-shot) or the restore sentinel
    // the resume prompt writes — the sentinel also guards against a stray
    // submission clobbering a real plan with the placeholder. A restore only
    // applies to a session that has a revision to re-present.
    let restore_armed = app_state.store.take_restore(&session_id);
    let restore_requested =
        (restore_armed || restore_sentinel.is_some()) && !ask_round_trip;
    let restored = restore_requested && session_existed;

    // A restore sentinel that we still couldn't bind to any held plan — the
    // rebind above found no session under the named target, and none exists
    // under the incoming id either. The body is only the placeholder, so
    // persisting it would mint a phantom v1 rendering the literal sentinel
    // instead of a plan. Refuse and store nothing; nothing was lost.
    if restore_sentinel.is_some() && !session_existed {
        tracing::warn!(
            session_id = %session_id,
            "restore sentinel matched no held plan — refusing to persist the placeholder"
        );
        return plan_passed_through(
            &app_state,
            &session_id,
            "Redline couldn't restore this plan: no held plan matched. The original \
             review session may have been deleted. Re-open the plan from Redline.",
        );
    }

    // Ask-mode was expected but Claude modified the plan anyway. Surface
    // a soft warning to the UI and proceed as a normal Revise revision —
    // hard-failing would leave the user without their answers and the
    // terminal hung waiting for a verdict we never deliver.
    let ask_mode_violated = if expected_mode == Some(SubmissionMode::Ask) && !ask_round_trip {
        tracing::warn!(
            session_id = %session_id,
            "ask_mode_violation: Claude returned a modified plan body during an Ask round-trip"
        );
        // `tracing` writes to stderr, which goes nowhere when Redline launches
        // from /Applications — so the warning above was invisible in practice.
        let _ = app_state.store.database().record_friction(
            "ask_mode_violation",
            Some("plan"),
            Some(&session_id),
            Some("Claude returned a modified plan body during an Ask round-trip"),
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
    // same plan, just with resolutions attached. Likewise for a restore: the
    // submitted body is the placeholder, so re-present the latest revision the
    // daemon already holds (cloned into a new `restored` revision) rather than
    // parsing what Claude sent.
    let (version_number, is_new_session) = if ask_round_trip {
        let latest = app_state
            .store
            .get(&session_id)
            .and_then(|s| s.revisions.last().map(|r| r.version_number))
            .unwrap_or(1);
        (latest, false)
    } else if let Some(upsert) = restored
        .then(|| app_state.store.restore_latest(&session_id))
        .flatten()
    {
        // The held plan is the daemon's, on disk too: the plan file the CLI
        // will build from goes back from the restore marker to the plan
        // being re-presented, so an approval never builds from the marker.
        if let (Some(plan_file), Some(body)) = (
            payload.pointer("/tool_input/planFilePath").and_then(Value::as_str),
            app_state.store.get(&session_id).and_then(|s| s.revisions.last().map(|r| r.raw_plan_markdown.clone())),
        ) {
            if unprime_plan_file(plan_file, &body) {
                tracing::info!(session_id = %session_id, "restore: wrote the re-presented plan back over the marker");
            }
        }
        (upsert.version_number, upsert.is_new_session)
    } else {
        if restore_requested && !session_existed {
            tracing::warn!(
                session_id = %session_id,
                "restore requested for a session with no revision to re-present; storing submitted plan"
            );
        }
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

    let launch = plan_launch::claim(
        payload.get("redline_launch_id").and_then(Value::as_str), &session_id,
        payload.get("redline_provider").and_then(Value::as_str).or(Some("claude-code")), &cwd,
    );
    if let Some(meta) = &launch {
        app_state.store.set_backend(&session_id, Some(&meta.backend), meta.model.as_deref());
        app_state.store.set_effort(&session_id, meta.effort.as_deref());
        polis_host::bind_launch_lineage(&app_state.store, &session_id, &meta.body_hash, &payload);
    }

    // Provenance, from the payload the hook actually sent. `redline_provider`
    // is set by `handle_codex_stop`'s normalizer and absent for Claude, whose
    // model rides the same `model` field. Sticky: `set_backend` COALESCEs, so
    // a later status-only upsert can't blank what restore branches on.
    let hook_model = payload
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            // Codex sends `model` on the Stop payload; Claude's ExitPlanMode
            // hook input does not carry one at all. The transcript does, and
            // `backfill_from_transcript` already reads its tail for the lake —
            // so this is the same cheap read, taken only while the column is
            // still unknown.
            if app_state
                .store
                .get(&session_id)
                .and_then(|s| s.model)
                .is_some()
            {
                return None;
            }
            payload
                .get("transcript_path")
                .and_then(Value::as_str)
                .filter(|p| !p.is_empty())
                .and_then(model_from_transcript)
        });
    app_state.store.set_backend(
        &session_id,
        payload
            .get("redline_provider")
            .and_then(Value::as_str)
            .or(Some("claude-code")),
        hook_model.as_deref(),
    );

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
    let (held_terminal_id, claude_proc) = {
        let pty_state: pty::PtyState = (*app_state.app_handle.state::<pty::PtyState>()).clone();
        let peer_port = peer.port();
        tokio::task::spawn_blocking(move || {
            let (pid, terminal) = pty::client_pid_and_terminal_for_port(&pty_state, peer_port);
            // Snapshot the process identity now (off-runtime), so the revise
            // watchdog can later tell "Claude busy/blocked" from "Claude gone".
            let proc = pid.and_then(|p| current_comm(p).map(|comm| ClaudeProc { pid: p, comm }));
            (terminal, proc)
        })
        .await
        .ok()
        .unwrap_or((None, None))
    };
    if let Some(proc) = claude_proc {
        app_state
            .app_handle
            .state::<LastClaudePid>()
            .set(&session_id, proc);
    }

    // This POST is about to be held — record it before the event goes out so
    // the listener's summary refresh already sees Held (clearing any stale
    // Detached from a prior orphan).
    settle_inbound_plan_state(&app_state.store, &session_id);
    let event = PlanReceivedEvent {
        launch_id: launch.as_ref().map(|claim| claim.launch_id.clone()),
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
    extension_host::publish(
        ext_events::PLAN_RECEIVED,
        &ext_events::PlanReceived {
            session_id: session_id.clone(),
            version: i64::from(version_number),
            is_new_session,
            thread_start,
            mode: event_mode.to_string(),
            restored,
            ts_ms: extension_host::now_ms(),
        },
    );
    refresh_tray(&app_state.app_handle, &app_state.store);

    // Orphan fix: if a prior held POST for this session is still pending (Claude
    // re-entered plan mode, retried, or the earlier hold was abandoned), release
    // the stale waiter cleanly instead of leaving it hung, then take over.
    let (mut rx, token) = register_hold(&app_state.pending, &session_id, held_terminal_id);
    app_state.pending.set_codex_socket(
        &session_id,
        token,
        payload
            .get("redline_codex_socket")
            .and_then(Value::as_str)
            .map(str::to_owned),
    );
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
                        let ticket = app_state.pending.approval_ticket(&session_id);
                        let _approval_guard = match &ticket {
                            Some(ticket) => Some(ticket.lock.lock().await),
                            None => None,
                        };
                        // An explicit decision may have won while we waited for its lock.
                        if !app_state.pending.owns(&session_id, token) {
                            drop(_approval_guard);
                            let response = (&mut rx).await.unwrap_or_else(|_| deny_response(cancelled_msg));
                            app_state.claims.clear(&session_id);
                            return response;
                        }
                        let plan = app_state.store.get(&session_id)
                            .and_then(|s| s.revisions.last().map(|r| r.raw_plan_markdown.clone()))
                            .unwrap_or_else(|| raw_plan.clone());
                        // Keep the review held if the CLI cannot acknowledge
                        // the mode/sandbox transition. An empty Stop response
                        // would strand an approved plan in a read-only TUI.
                        if payload.get("redline_provider").and_then(Value::as_str) == Some("codex") {
                            let approval_id = ticket.as_ref().map(|t| t.id.as_str()).unwrap_or_default();
                            let socket = ticket.as_ref().and_then(|t| t.codex_socket.as_deref());
                            if let Err(error) = codex_app_server::queue_plan_implementation(socket, &session_id, &plan, approval_id).await {
                                tracing::warn!(%session_id, %error, "Codex Ambient handoff failed; awaiting explicit approval");
                                drop(_approval_guard);
                                let response = match (&mut rx).await {
                                    Ok(r) => r,
                                    Err(_) => deny_response(cancelled_msg),
                                };
                                app_state.claims.clear(&session_id);
                                return response;
                            }
                        }
                        // Window elapsed unclaimed — auto-approve and drop the
                        // pending sender so it is never orphaned.
                        let _ = app_state.pending.take_if_owned(&session_id, token);
                        app_state
                            .store
                            .set_attach_state(&session_id, AttachState::Idle);
                        tracing::info!(session_id = %session_id, "Ambient: decision window elapsed — auto-approving");
                        app_state.store.set_status(&session_id, SessionStatus::Approved);
                        asks::note_plan_approved(&session_id);
                        approval_response(
                            "Auto-approved (Ambient mode — the plan was not opened for review within the decision window).",
                        )
                    }
                }
            };
            app_state.claims.clear(&session_id);
            resp
        }
    };

    answer_for_build(response, &payload)
}

/// How many dated DB snapshots to retain under `backups/`.
const LEDGER_BACKUP_KEEP: usize = 7;

/// Crown-jewels backup: `VACUUM INTO` a dated snapshot of the whole DB under
/// `<app-data>/backups/`, then prune to the newest `keep`. The ledger is
/// append-only and hash-chained, so a corrupted `redline.db` would otherwise be
/// unrecoverable; the mirror/export are secondary content copies, this protects
/// the chain itself. Best-effort and self-contained — logs and returns on any
/// error rather than propagating.
///
/// Returns the snapshot's path on success, so the keeper's deep chain walk can
/// run against the copy instead of the live database's shared connection.
fn snapshot_database(
    db: &db::Database,
    data_dir: &std::path::Path,
    keep: usize,
) -> Option<std::path::PathBuf> {
    // One vacuum at a time. Three triggers (once per boot, every 6h, on quit)
    // and, since the startup one moved behind the reveal, real opportunity for
    // two to overlap — a quit during the launch snapshot, or a 6h tick landing
    // on a slow one. They each still happen; they take turns.
    let _serialized = postboot::snapshot_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let dir = data_dir.join("backups");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        tracing::warn!(error = %e, "could not create backups dir");
        return None;
    }
    // now_millis() is 13 digits until ~year 2286, so filenames sort
    // chronologically by plain lexical order.
    let dest = dir.join(format!("redline-{}.db", ledger::now_millis()));
    // VACUUM INTO refuses an existing destination (a same-millisecond retry).
    let _ = std::fs::remove_file(&dest);
    if let Err(e) = db.snapshot_off_lock(&dest) {
        tracing::warn!(error = %e, "ledger DB snapshot failed");
        return None;
    }
    tracing::info!(path = %dest.display(), "ledger DB snapshot written");

    if let Ok(entries) = std::fs::read_dir(&dir) {
        let mut snaps: Vec<std::path::PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.starts_with("redline-") && n.ends_with(".db"))
                    .unwrap_or(false)
            })
            .collect();
        snaps.sort();
        if snaps.len() > keep {
            for old in &snaps[..snaps.len() - keep] {
                let _ = std::fs::remove_file(old);
            }
        }
    }
    Some(dest)
}

// The capture route and its payload reader live in `polis_server::ingest`
// since Session A6 of the Polis extraction; the reader is re-imported here
// so the golden payload test below still names it.
#[allow(unused_imports)]
use polis_server::ingest_prompt_text;

/// How much of a transcript's tail the model backfill reads. Transcripts reach
/// many MB; the newest assistant message is what carries the answer, so the
/// tail is all that's ever read.
const TRANSCRIPT_TAIL_BYTES: u64 = 256 * 1024;

/// Newest `message.model` in the tail of a session transcript JSONL, or `None`
/// (no assistant turn yet — a brand-new session gets its model one hook fire
/// late; documented in docs/protocol-verification.md terms: the hook payload
/// itself carries no model field, the transcript is the only source).
fn model_from_transcript(path: &str) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(TRANSCRIPT_TAIL_BYTES)))
        .ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    // A mid-file seek lands mid-line (and possibly mid-UTF-8); the lossy
    // conversion + per-line parse skip the torn first line naturally.
    let text = String::from_utf8_lossy(&buf);
    for line in text.lines().rev() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if let Some(m) = v
            .pointer("/message/model")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|m| !m.is_empty())
        {
            return Some(m.to_string());
        }
    }
    None
}

/// Stamp `prompts.model` for a claude session from its hook payload's
/// transcript, where still unknown. Shared by both hook handlers; best-effort.
/// The `session_needs_model` guard keeps the hot path from re-reading a
/// transcript tail once every prompt of the session is stamped.
fn backfill_from_transcript(
    db: &db::Database,
    payload: &serde_json::Value,
    claude_session_id: &str,
) {
    if claude_session_id.is_empty() {
        return;
    }
    let Some(path) = payload
        .get("transcript_path")
        .and_then(serde_json::Value::as_str)
        .filter(|p| !p.is_empty())
    else {
        return;
    };
    // Stamp the path itself FIRST, and unconditionally. This hook fire is the
    // only authoritative source there is: `--resume` is scoped by the session's
    // STARTUP cwd, so the transcript's location cannot be derived from the
    // directory the session is working in. `plan_meter`'s tailer reads it —
    // and without it the interactive plan session, the surface the user spends
    // the most time in, is the one with no economics at all.
    if let Err(e) = db.set_session_transcript_path(claude_session_id, path) {
        tracing::warn!(error = %e, "failed to stamp session transcript path");
    }
    if !db.session_needs_model(claude_session_id) {
        return;
    }
    let Some(model) = model_from_transcript(path) else {
        return;
    };
    match db.backfill_session_model(claude_session_id, &model) {
        Ok(n) if n > 0 => {
            tracing::info!(model = %model, rows = n, "stamped prompt model from transcript");
        }
        Ok(_) => {}
        Err(e) => tracing::warn!(error = %e, "prompt model backfill failed"),
    }
}

/// Classify a captured prompt as belonging to a Redline-managed project or an
/// external harness session. Fact-based: a session running in a directory
/// Redline already tracks as a project is ours; anything else is external.
fn classify_prompt_origin(db: &db::Database, cwd: Option<&str>) -> ledger::Origin {
    if let Some(cwd) = cwd {
        if db
            .list_project_paths()
            .map(|paths| paths.iter().any(|p| p == cwd))
            .unwrap_or(false)
        {
            return ledger::Origin::Redline;
        }
    }
    ledger::Origin::External
}

// `POST /v1/prompts/ingest` is `polis_server::ingest::handle_prompts_ingest`
// (Session A6): the route's own contract — the size cap, the payload shape, the
// consume-once agent-prompt guard, the row, the response bodies — is the
// server's; everything in it that was Redline's (the restore-trigger answer,
// the seat header, the launch handoff, the project
// registry, the capture setting, the transcript backfill) is
// `polis_host::RedlineIngest`, the route's `IngestObserver`.

/// Look up a file of the app's built frontend (`dist/`). In a bundled release
/// the whole dist tree is compiled into the binary (`frontendDist`), so this
/// reads the embedded asset; under `tauri dev` nothing is embedded and it
/// falls back to the repo's `dist/` on disk (present after `npm run build`).
/// Since the viewer folded into the main build (B1d), this is how the daemon
/// serves `viewer/index.html` and the shared `/assets/*` chunks it references.
fn embedded_dist_file(app: &AppHandle, rel: &str) -> Option<Vec<u8>> {
    let resolver = app.asset_resolver();
    for key in [format!("/{rel}"), rel.to_string()] {
        if let Some(asset) = resolver.get(key) {
            return Some(asset.bytes);
        }
    }
    let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../dist")
        .join(rel);
    std::fs::read(&dev).ok()
}

/// Resolve the built browser-viewer directory (`dist-viewer/`) — the PRE-FOLD
/// standalone layout, kept serving as a fallback until the folded path is
/// proven. In a bundled release it rides along as a Tauri resource; in dev it
/// sits at the repo root next to the crate. `None` when it was never built
/// (the normal state after B1d — the folded viewer serves from
/// `embedded_dist_file` instead).
fn viewer_dist_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    if let Ok(p) = app
        .path()
        .resolve("dist-viewer", tauri::path::BaseDirectory::Resource)
    {
        if p.join("index.html").is_file() {
            return Some(p);
        }
    }
    let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist-viewer");
    if dev.join("index.html").is_file() {
        return Some(dev);
    }
    None
}

fn viewer_content_type(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") | Some("map") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        _ => "application/octet-stream",
    }
}

/// Serve one file from the viewer bundle, rejecting any path that isn't a
/// plain sequence of names (no `..`, no absolute components).
async fn serve_viewer_file(state: &AppState, rel: &str) -> axum::response::Response {
    let Some(base) = viewer_dist_dir(&state.app_handle) else {
        return (
            StatusCode::NOT_FOUND,
            "Viewer not built — run `npm run build`.",
        )
            .into_response();
    };
    let mut full = base.clone();
    for comp in std::path::Path::new(rel).components() {
        match comp {
            std::path::Component::Normal(c) => full.push(c),
            std::path::Component::RootDir | std::path::Component::CurDir => {}
            _ => return (StatusCode::BAD_REQUEST, "bad path").into_response(),
        }
    }
    match tokio::fs::read(&full).await {
        Ok(bytes) => ([(header::CONTENT_TYPE, viewer_content_type(&full))], bytes).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

/// `/viewer/` — the folded build's page first (embedded `viewer/index.html`,
/// whose chunk refs resolve at `/assets/*`), then the legacy standalone
/// bundle (whose refs resolve at `/viewer/assets/*`, still served below).
async fn handle_viewer_index(State(state): State<AppState>) -> axum::response::Response {
    if let Some(bytes) = embedded_dist_file(&state.app_handle, "viewer/index.html") {
        return ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], bytes).into_response();
    }
    serve_viewer_file(&state, "index.html").await
}

/// `/viewer/*path` — legacy standalone-bundle assets only; the folded page
/// never requests these.
async fn handle_viewer_asset(
    State(state): State<AppState>,
    Path(path): Path<String>,
) -> axum::response::Response {
    serve_viewer_file(&state, &path).await
}

/// `/assets/*path` — the shared build chunks the folded viewer page loads.
/// Same path hygiene as the legacy route: only plain name components reach
/// the lookup, and the lookup itself is confined to the built `dist/` tree
/// (embedded in release, on-disk in dev).
async fn handle_root_asset(
    State(state): State<AppState>,
    Path(path): Path<String>,
) -> axum::response::Response {
    let mut clean = std::path::PathBuf::new();
    for comp in std::path::Path::new(&path).components() {
        match comp {
            std::path::Component::Normal(c) => clean.push(c),
            std::path::Component::RootDir | std::path::Component::CurDir => {}
            _ => return (StatusCode::BAD_REQUEST, "bad path").into_response(),
        }
    }
    let rel = format!("assets/{}", clean.to_string_lossy());
    match embedded_dist_file(&state.app_handle, &rel) {
        Some(bytes) => {
            ([(header::CONTENT_TYPE, viewer_content_type(&clean))], bytes).into_response()
        }
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

use redline_extension_abi::events as ext_events;

/// `GET /v1/extensions` — installed extensions with live status (kind,
/// scopes, events, strikes, sanitized panel). Open: read-only surface, same
/// posture as the other list reads.
async fn handle_extensions_list() -> Json<Vec<extension_host::ExtensionInfo>> {
    Json(extension_host::snapshot())
}

#[derive(Deserialize)]
struct ExtensionPanelReq {
    markdown: String,
}

/// `POST /v1/extensions/:name/panel` — the sanctioned UI slot. The auth
/// middleware already demanded the `ui.panel` scope; this handler adds the
/// identity rule: an extension token may only write ITS OWN panel. The
/// master token (trusted surfaces the app itself spawned) may write any.
async fn handle_extension_panel(
    axum::extract::Path(name): axum::extract::Path<String>,
    headers: axum::http::HeaderMap,
    Json(req): Json<ExtensionPanelReq>,
) -> axum::response::Response {
    let bearer = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim);
    let allowed = match bearer {
        Some(t) if t == auth::daemon_token() => true,
        Some(t) => auth::grant_for(t).map(|g| g.name == name).unwrap_or(false),
        None => false,
    };
    if !allowed {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": "panel writes are per-extension: `name` must match the bearer's grant"
            })),
        )
            .into_response();
    }
    match extension_host::set_panel(&name, &req.markdown) {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(e) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

/// app_settings key holding the JSON list of user-disabled extension names.
const EXTENSIONS_DISABLED_KEY: &str = "extensions.disabled";

/// Installed extensions for the Extensions settings panel — the same
/// snapshot the open `/v1/extensions` route serves.
#[tauri::command]
fn extensions_list() -> Vec<extension_host::ExtensionInfo> {
    extension_host::snapshot()
}

/// Enable/disable an extension (trusted UI). Disable stops delivery
/// immediately; enable takes effect at the next launch (the status text
/// says so). The choice persists across boots in `app_settings`.
#[tauri::command]
fn extension_set_enabled(
    store: tauri::State<'_, SessionStore>,
    name: String,
    enabled: bool,
) -> Result<(), String> {
    let db = store.database();
    let mut disabled: std::collections::BTreeSet<String> = db
        .get_setting(EXTENSIONS_DISABLED_KEY)
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    if enabled {
        disabled.remove(&name);
    } else {
        disabled.insert(name.clone());
    }
    db.set_setting(
        EXTENSIONS_DISABLED_KEY,
        &serde_json::to_string(&disabled).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    extension_host::set_enabled(&name, enabled)
}

/// Uninstall an extension: drop it from the registry, revoke its token
/// immediately (B4 — per-boot rotation alone is too slow a revocation for
/// an explicit uninstall), and delete its folder.
#[tauri::command]
fn extension_uninstall(name: String) -> Result<(), String> {
    let dir = extension_host::remove(&name)?;
    auth::revoke_grant(&name);
    // Belt and braces: only ever delete inside ~/.redline/extensions.
    let root = extension::extensions_root().ok_or("no extensions root")?;
    if !dir.starts_with(&root) {
        return Err(format!(
            "refusing to delete {} (outside the extensions root)",
            dir.display()
        ));
    }
    // A link-installed extension (A5a): the LINK is the install — remove it
    // and only it. The author's project behind it is never ours to delete.
    match std::fs::symlink_metadata(&dir) {
        Ok(meta) if meta.file_type().is_symlink() => {
            std::fs::remove_file(&dir).map_err(|e| e.to_string())
        }
        _ => std::fs::remove_dir_all(&dir).map_err(|e| e.to_string()),
    }
}

/// A local folder inspected for install (A5a) — what the confirmation UI
/// shows before anything is written. For an extension the scopes/events are
/// the consent surface; a harness holds neither (it composes, it cannot
/// call), so its identity is the whole story.
#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum LocalInstallPreview {
    Harness {
        id: String,
        name: String,
    },
    Extension {
        name: String,
        ext_kind: String,
        version: Option<String>,
        scopes: Vec<String>,
        events: Vec<String>,
    },
}

/// Inspect a folder for local install: what is it, and what would it get?
/// Read-only — hard errors carry the validator's reason, the same posture
/// as the marketplace's pre-consent checks.
#[tauri::command]
fn local_install_inspect(path: String) -> Result<LocalInstallPreview, String> {
    let folder = std::path::Path::new(&path);
    match local_install::detect(folder)? {
        local_install::FolderKind::Harness => {
            let h = local_install::read_harness_identity(folder)?;
            Ok(LocalInstallPreview::Harness {
                id: h.id,
                name: h.name,
            })
        }
        local_install::FolderKind::Extension => {
            let m = extension::load_extension_folder(folder)?;
            Ok(LocalInstallPreview::Extension {
                name: m.name.clone(),
                ext_kind: m.kind().to_string(),
                version: m.version.clone(),
                scopes: m.scopes.clone(),
                events: m.events.clone(),
            })
        }
    }
}

/// Install a local folder (A5a): link it under the matching root and — for
/// a code extension — hot-load it through the same arm the marketplace
/// uses, so it runs now, not at the next launch. No registry, no sha256:
/// the folder the user picked and confirmed is the consent.
#[tauri::command]
fn local_install_confirm(
    store: tauri::State<'_, SessionStore>,
    path: String,
) -> Result<LocalInstallPreview, String> {
    let folder = std::path::Path::new(&path);
    match local_install::detect(folder)? {
        local_install::FolderKind::Harness => {
            let h = local_install::install_harness_folder(&userconfig::config_root(), folder)?;
            Ok(LocalInstallPreview::Harness {
                id: h.id,
                name: h.name,
            })
        }
        local_install::FolderKind::Extension => {
            let manifest = extension::load_extension_folder(folder)?;
            let name = manifest.name.clone();
            let disabled: std::collections::BTreeSet<String> = store
                .database()
                .get_setting(EXTENSIONS_DISABLED_KEY)
                .and_then(|raw| serde_json::from_str(&raw).ok())
                .unwrap_or_default();
            let root = extension::extensions_root().ok_or("no extensions root")?;
            // Link first: if the name is held by a real (curated or
            // hand-placed) directory this refuses before the live
            // registration is touched.
            let dest = local_install::link_extension_folder(&root, folder, &name)?;
            if extension_host::remove(&name).is_ok() {
                auth::revoke_grant(&name);
            }
            // Load THROUGH the link: the name==dir rule holds at the
            // installed path, and an external extension's `.token` lands in
            // the author's own folder, where their process reads it.
            let loaded = extension::load_extension_dir(&dest)?;
            let booted = extension::boot_token(loaded)?;
            extension_host::load_one(booted, disabled.contains(&name))?;
            tracing::info!("local install: linked {name} -> {}", path);
            Ok(LocalInstallPreview::Extension {
                name,
                ext_kind: manifest.kind().to_string(),
                version: manifest.version.clone(),
                scopes: manifest.scopes.clone(),
                events: manifest.events.clone(),
            })
        }
    }
}

/// Reload an installed extension from disk (A5a's iterate step): after the
/// author rebuilds their module, one click re-reads the manifest and bytes
/// through the link and re-registers — fresh token, fresh strikes, same
/// enabled/disabled choice. Works for any installed extension, but exists
/// for the linked ones.
#[tauri::command]
fn extension_reload(store: tauri::State<'_, SessionStore>, name: String) -> Result<(), String> {
    if !extension::valid_name(&name) {
        return Err(format!("invalid extension name {name:?}"));
    }
    let root = extension::extensions_root().ok_or("no extensions root")?;
    let dir = root.join(&name);
    // Validate the fresh state BEFORE dropping the live registration, so a
    // broken edit leaves the running install running and names the problem.
    let loaded = extension::load_extension_dir(&dir)?;
    let disabled: std::collections::BTreeSet<String> = store
        .database()
        .get_setting(EXTENSIONS_DISABLED_KEY)
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    if extension_host::remove(&name).is_ok() {
        auth::revoke_grant(&name);
    }
    let booted = extension::boot_token(loaded)?;
    extension_host::load_one(booted, disabled.contains(&name))
}

// --- Marketplace (Elevation B4, see `marketplace.rs`) ---------------------

/// app_settings keys for the SQLite-cached index document + fetch stamp.
const MARKETPLACE_CACHE_KEY: &str = "marketplace.index.cache";
const MARKETPLACE_FETCHED_KEY: &str = "marketplace.index.fetched_ms";

/// What the Browse tab renders: enriched entries plus provenance of the
/// document they came from.
#[derive(serde::Serialize)]
struct MarketplaceIndexView {
    fetched_ms: Option<i64>,
    /// "network" or "cache" — the Browse tab says which it is showing.
    source: String,
    warnings: Vec<String>,
    entries: Vec<marketplace::MarketEntry>,
}

/// The `(name, installed version)` join input for `marketplace::enrich`.
fn installed_pairs() -> Vec<(String, Option<String>)> {
    extension_host::snapshot()
        .into_iter()
        .map(|e| (e.name, e.version))
        .collect()
}

/// Fetch (or serve the cached) marketplace index. `refresh` forces a
/// network fetch — otherwise the cache wins and the network is touched only
/// when there is no cache at all (first open). A fetch failure falls back
/// to the cache with a warning instead of an error wall.
#[tauri::command(async)]
async fn marketplace_index(
    store: tauri::State<'_, SessionStore>,
    refresh: bool,
) -> Result<MarketplaceIndexView, String> {
    let cached = {
        let db = store.database();
        db.get_setting(MARKETPLACE_CACHE_KEY)
    };
    let mut warnings = Vec::new();
    let (raw, source) = if refresh || cached.is_none() {
        match marketplace::fetch_index().await {
            Ok(fresh) => {
                // Cache only a document that parses — a bad fetch must not
                // poison the consent path's cache.
                match marketplace::parse_index(&fresh) {
                    Ok(_) => {
                        let db = store.database();
                        let _ = db.set_setting(MARKETPLACE_CACHE_KEY, &fresh);
                        let _ = db.set_setting(
                            MARKETPLACE_FETCHED_KEY,
                            &extension_host::now_ms().to_string(),
                        );
                        (fresh, "network".to_string())
                    }
                    Err(why) => match cached {
                        Some(old) => {
                            warnings.push(format!("fetched index unusable ({why}) — showing cached"));
                            (old, "cache".to_string())
                        }
                        None => return Err(why),
                    },
                }
            }
            Err(why) => match cached {
                Some(old) => {
                    warnings.push(format!("{why} — showing cached"));
                    (old, "cache".to_string())
                }
                None => return Err(why),
            },
        }
    } else {
        (cached.expect("checked above"), "cache".to_string())
    };
    let (entries, parse_warnings) = marketplace::parse_index(&raw)?;
    warnings.extend(parse_warnings);
    let fetched_ms = {
        let db = store.database();
        db.get_setting(MARKETPLACE_FETCHED_KEY)
            .and_then(|s| s.parse().ok())
    };
    Ok(MarketplaceIndexView {
        fetched_ms,
        source,
        warnings,
        entries: marketplace::enrich(entries, &installed_pairs()),
    })
}

/// Install (or update) one extension from the cached index. Consent-bound:
/// `sha256` is the hash the user saw in the consent dialog, and the install
/// refuses if the cached entry no longer matches it. Downloads, verifies
/// (sha256 + exact size + wasm magic), writes the generated manifest, and
/// hot-registers — no relaunch. Updates drop and revoke the old
/// registration first; nothing ever updates without this explicit call.
#[tauri::command(async)]
async fn marketplace_install(
    store: tauri::State<'_, SessionStore>,
    name: String,
    sha256: String,
) -> Result<(), String> {
    let (raw, disabled) = {
        let db = store.database();
        let raw = db
            .get_setting(MARKETPLACE_CACHE_KEY)
            .ok_or("no marketplace index loaded — open Browse first")?;
        let disabled: std::collections::BTreeSet<String> = db
            .get_setting(EXTENSIONS_DISABLED_KEY)
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        (raw, disabled)
    };
    let (entries, _) = marketplace::parse_index(&raw)?;
    let entry = entries
        .into_iter()
        .find(|e| e.name == name)
        .ok_or_else(|| format!("extension {name:?} is not in the index"))?;
    if entry.artifact.sha256 != sha256 {
        return Err(
            "the index entry changed since you consented — refresh and review it again"
                .to_string(),
        );
    }
    if !marketplace::min_redline_ok(&entry.min_redline) {
        return Err(format!(
            "this extension needs Redline >= {} (you run {})",
            entry.min_redline,
            marketplace::APP_VERSION
        ));
    }
    // A manually-installed external extension owning this name is not ours
    // to overwrite.
    if let Some(existing) = extension_host::snapshot().iter().find(|e| e.name == name) {
        if existing.kind != extension::KIND_WASM {
            return Err(format!(
                "an external-process extension named {name:?} is already installed — remove it first"
            ));
        }
    }
    let bytes = marketplace::fetch_artifact(&entry).await?;
    let root = extension::extensions_root().ok_or("no extensions root")?;
    // Update path: drop the live registration and revoke its token before
    // touching the directory.
    if extension_host::remove(&name).is_ok() {
        auth::revoke_grant(&name);
    }
    let dir = marketplace::write_install(&entry, &bytes, &root)?;
    let loaded = extension::load_extension_dir(&dir)?;
    let booted = extension::boot_token(loaded)?;
    extension_host::load_one(booted, disabled.contains(&name))?;
    tracing::info!("marketplace: installed {name} v{}", entry.version);
    Ok(())
}

/// GET `/v1/liveness` — the identity card a booting sibling's preflight
/// reads off :7676 before deciding what "port in use" means: a Redline with
/// a window is a live instance to defer to; a Redline without one is a
/// headless leftover (window died, daemon survived by design) to retire via
/// `/v1/admin/shutdown`. Open by the read convention; `app` pins the answer
/// to this daemon rather than whatever else might squat on the port.
///
/// The count MUST come from `windows()`, not `webview_windows()`. Once the
/// browser pane attaches child webviews the main window stops being a 1:1
/// webview-window and drops out of `webview_windows()` entirely — the same
/// demotion `menu_anchor_window` already works around. Reading the webview
/// count here made a live, windowed app report `hasWindow:false`, which is
/// exactly the answer that tells a booting sibling's preflight to shut it
/// down — taking every hosted session with it.
async fn handle_liveness(State(app_state): State<AppState>) -> impl IntoResponse {
    let has_window = !app_state.app_handle.windows().is_empty();
    Json(json!({
        "app": "redline",
        "pid": std::process::id(),
        "hasWindow": has_window,
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

#[derive(Deserialize)]
struct PerfQ {
    #[serde(rename = "windowMs")]
    window_ms: Option<u64>,
}

/// The read `GET /v1/perf` evaluates in the main webview: the probe's
/// snapshot over the last `window_ms`, or `running:false` when it is off. The
/// window is a clamped integer, so nothing caller-supplied reaches the script.
fn perf_probe_script(window_ms: Option<u64>) -> String {
    let window_ms = window_ms.unwrap_or(60_000).clamp(1_000, 120_000);
    format!(
        "(function(){{try{{var p=window.__rlPerf;return JSON.stringify(p?{{running:true,snapshot:p.snapshot({window_ms})}}:{{running:false}});}}catch(e){{return JSON.stringify({{running:false,error:String(e)}});}}}})()"
    )
}

/// GET `/v1/perf?windowMs=` — the responsiveness probe's rolling input-latency
/// and frame-gap summary (docs/perf-budget.md "Responsiveness"), read out of
/// the main webview's `window.__rlPerf`, plus the renderer's footprint read
/// from outside it (`renderer`, rule 7) — that one even when the page can't
/// answer, which is when it matters most. A release build has no Web
/// Inspector, so this is how a release baseline is read;
/// `scripts/perf-idle.sh` prints it beside the GPU and renderer samples.
/// Pull-only: the probe runs only when switched on (always in dev, ⌘K in a
/// release build), and nothing is collected here or sent anywhere.
async fn handle_perf(
    State(app_state): State<AppState>,
    Query(q): Query<PerfQ>,
) -> axum::response::Response {
    let renderer = renderer_memory::current();
    if let Some(reading) = renderer {
        renderer_memory::note(reading);
    }
    let probe = daemon_eval(&app_state.app_handle, "main", &perf_probe_script(q.window_ms))
        .await
        .and_then(|raw| match serde_json::from_str::<Value>(&raw) {
            Ok(Value::Object(probe)) => Ok(probe),
            _ => Err("the page returned no usable result".to_string()),
        });
    match probe {
        Ok(mut probe) => {
            probe.insert("renderer".into(), json!(renderer));
            Json(probe).into_response()
        }
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": error, "renderer": renderer })),
        )
            .into_response(),
    }
}

/// POST `/v1/admin/shutdown` — gracefully retire this instance: answer, then
/// run the normal exit path (`RunEvent::Exit` snapshots the ledger and kills
/// every child agent/PTY) and release :1420/:7676 for the caller. Master
/// token only; the preflight authenticates with the on-disk `daemon.token`.
/// The exit is deferred a beat so the acknowledgment actually flushes.
async fn handle_admin_shutdown(State(app_state): State<AppState>) -> impl IntoResponse {
    tracing::info!("daemon shutdown requested (retiring this instance for a booting sibling)");
    let app = app_state.app_handle.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        app.exit(0);
    });
    Json(json!({ "ok": true, "pid": std::process::id() }))
}

async fn run_server(state: AppState) {
    // The Model Context Protocol surface (E1): polis-mcp's read tools over
    // the same `MemoryApi` this state already holds, nested at `/mcp` below.
    let memory_api = state.polis.api.clone();
    // Keep handles for the post-bind status update before the router consumes `state`.
    let daemon_status = state.daemon_status.clone();
    let app_handle = state.app_handle.clone();
    let app = Router::new()
        // Async-share browser viewer, served for the sender's local preview
        // (loopback only). `/viewer` → `/viewer/` so relative refs resolve;
        // the folded page's chunks load from `/assets/*` (shared with the
        // app build), while `/viewer/*path` keeps serving a legacy
        // standalone bundle if one is still on disk.
        .route("/viewer", get(|| async { Redirect::permanent("/viewer/") }))
        .route("/viewer/", get(handle_viewer_index))
        .route("/viewer/*path", get(handle_viewer_asset))
        .route("/assets/*path", get(handle_root_asset))
        .route("/v1/plan", post(handle_plan))
        // Terminal attention (terminal-wall Phase 1): the async Notification /
        // Stop / UserPromptSubmit hooks of an agent in a dock terminal.
        .route("/v1/term/event", post(term_attention::handle_event))
        // Permission / question cards (Flow): the blocking PermissionRequest
        // and AskUserQuestion hooks of an agent in a dock terminal.
        .route("/v1/term/ask", post(asks::handle_ask))
        .route("/v1/codex/stop", post(handle_codex_stop))
        .route("/v1/cursor/prompt", post(handle_cursor_prompt))
        .route("/v1/cursor/response", post(handle_cursor_response))
        .route("/v1/cursor/stop", post(handle_cursor_stop))
        .route("/v1/antigravity/stop", post(handle_antigravity_stop))
        // Agent-in-doc (M4): the per-user agent's surface — read the plan's
        // block structure, post a tracked suggestion against a block id.
        .route("/v1/sessions/:session_id/plan", get(handle_get_latest_plan))
        .route(
            "/v1/sessions/:session_id/suggestions",
            post(handle_suggest_edit),
        )
        // Voice agent (and any read-only agent): capture a spoken/requested change
        // as a tracked `[feedback]` comment without a verbatim rewrite. Lands the
        // same driver a reviewer's own feedback comment is; rides the next Revise.
        .route(
            "/v1/sessions/:session_id/comments",
            post(handle_suggest_feedback),
        )
        // …and the same content *offered* rather than written: the agent stages
        // it mid-turn, the discussion panel shows a `＋ Add as item` chip under
        // that reply, and only the user's tap creates the comment above.
        .route(
            "/v1/sessions/:session_id/comment-offers",
            post(handle_offer_feedback),
        )
        // Out-of-band feedback delivery (Layer 1): the denied `ExitPlanMode`
        // reason is now a single calm line; the full review payload is fetched
        // here by the model's pre-authorized curl. See `PendingFeedback`.
        .route(
            "/v1/sessions/:session_id/feedback",
            get(handle_get_feedback),
        )
        // Browse agent (browser pane): the headless browse agent reads and
        // drives the user's browser tabs through these routes via the
        // already-permitted `curl` allow. Reads take `?tab=` (a tab number or
        // a label) and otherwise read the tab on screen
        // (`AppState::active_browser`); `/action` acts only on the label its
        // body names. `/navigate`, `/click` and `/query` predate `/action`,
        // and `/active` predates `/tabs`; they still answer, but the prompt
        // and the skill no longer teach them.
        .route("/v1/browser/active", get(handle_browser_active))
        .route("/v1/browser/tabs", get(handle_browser_tabs))
        .route("/v1/browser/thread", get(handle_browser_thread))
        .route("/v1/browser/snapshot", get(handle_browser_snapshot))
        .route("/v1/browser/query", post(handle_browser_query))
        .route("/v1/browser/navigate", post(handle_browser_navigate))
        .route("/v1/browser/click", post(handle_browser_click))
        .route("/v1/browser/action", post(handle_browser_action))
        .route("/v1/browser/open", post(handle_browser_open))
        .route("/v1/browser/focus", post(handle_browser_focus))
        // Save the page the user is viewing (or a specific linked file) to disk.
        // The agent's only file-write path: a headless `curl -o` is auto-denied,
        // but this rides the same pre-authorized `curl` allow as the others.
        .route("/v1/browser/download", post(handle_browser_download))
        // Mission orchestrator (browser pane): two read-only routes the
        // orchestrator agent curls to know the goal and the user's pins. It
        // reaches the tabs themselves through the `/v1/browser/*` routes above.
        .route("/v1/mission/active", get(handle_mission_active))
        .route("/v1/mission/findings", get(handle_mission_findings))
        .route("/v1/missions/:mission_id", get(handle_scoped_mission))
        .route(
            "/v1/missions/:mission_id/findings",
            get(handle_scoped_findings),
        )
        .route(
            "/v1/missions/:mission_id/tabs",
            get(handle_scoped_tabs).post(handle_scoped_open),
        )
        .route(
            "/v1/missions/:mission_id/foundation",
            post(handle_mission_foundation),
        )
        // The Companion's fan-out: consult ANY surface's agent for a digest,
        // and the agent map it starts most cross-surface tasks from.
        .route("/v1/global/consult", post(handle_global_consult))
        .route("/v1/global/agents", get(handle_global_agents))
        // Code access (browse agent): read-only. `/projects` is the agent's map
        // of the user's known project folders; `/git` runs a whitelisted set of
        // read-only git ops (status/branch/log/diff/show) in one of them, so the
        // agent can "check our local branch" without fighting the Bash sandbox.
        // Both ride the same pre-authorized `curl` allow as `/v1/browser/*`.
        .route("/v1/code/projects", get(handle_code_projects))
        .route("/v1/code/map", get(handle_code_map))
        .route("/v1/code/git", get(handle_code_git))
        // Polis Memory (Session A6 of the extraction): the capture route
        // (`/v1/prompts/ingest`), the ClassMemory reads + proposals sink
        // (`/v1/memory/*`), the plan's memory writes, and the lake's context
        // reads (`/v1/context/{prompts,stats,browse/search,threads,tree}`)
        // are `polis_server::router()`'s — one router shared with the
        // standalone `polis` daemon, served here under THIS daemon's auth:
        // every polis row is mapped into `auth::all_routes()` (Redline's own
        // rows stay in `ROUTE_TABLE`), so the fail-closed rule holds across
        // the merge. All still ride the same pre-authorized `curl` allow.
        .merge(polis_server::router())
        // MCP (E1): `polis_mcp`'s streamable-HTTP service — the read tools
        // (`memory_search` first), resources and the grounding prompt over the
        // same handle — so `claude mcp add --transport http redline
        // http://127.0.0.1:7676/mcp` needs no bundled binary (the `redline-mcp`
        // proxy retired). Mounted as a ROUTE (`any_service`), not nested: the
        // transport's GET/POST/DELETE all hit exactly `/mcp`, axum sets
        // `MatchedPath` = "/mcp" for it, and `auth::ROUTE_TABLE` carries the
        // three Open rows. (`nest_service` would also serve `/mcp/anything`
        // with NO MatchedPath — outside the table, rmcp being path-agnostic —
        // so it is not used; a sub-path here is the router's own 404.)
        // E2: the five write tools ride this mount too; `require_mcp_write_token`
        // authorizes a `tools/call` of one of them exactly as its HTTP route
        // (bearer + scope), so the fail-closed rule holds and reads stay open.
        .route("/mcp", axum::routing::any_service(polis_mcp::http_service(memory_api)).layer(axum::middleware::from_fn(auth::require_mcp_write_token)))
        // Context access (Phase 3): the Librarian agent's friction digest —
        // ground-truth counts/staleness (backlog, held proposals, stalled
        // reviews, bulging branches). Read-only; rides the same `curl` allow.
        .route("/v1/context/overview", get(handle_context_overview))
        // The Shipwright's code digest as JSON — an on-demand re-read for the
        // Companion / voice agent / MCP surface. The Shipwright itself never
        // depends on this: its digest is baked into the spawn prompt.
        .route("/v1/context/codehealth", get(handle_context_codehealth))
        // Context access (Phase 4): one plan session's full history — plan
        // revisions + comment threads are Redline's own tables, so this read
        // stays here; the lake reads beside it moved into the polis router.
        .route(
            "/v1/context/sessions/:id/history",
            get(handle_context_session_history),
        )
        // Where the user is right now (mirrored ActiveSurface cell) and the
        // context-journal delta — the Companion's passive-awareness reads.
        .route("/v1/surface/active", get(handle_surface_active))
        .route("/v1/journal/recent", get(handle_journal_recent))
        // Prompt Drafter: the live draft's markdown mirror (read) and the
        // agent write-suggestion sink (tracked changes with accept/reject).
        .route("/v1/drafter/:draft_id/doc", get(handle_drafter_doc))
        .route(
            "/v1/drafter/:draft_id/suggestions",
            post(handle_draft_suggestion),
        )
        // Code Review surface: the `/redline-code-review` skill's blocking curl.
        // Captures the diff, opens the review pane, and HOLDS the response
        // until the reviewer submits — the plan-review hold applied to code.
        .route("/v1/reviews/start", get(handle_review_start))
        // External annotations: local tools read/post findings into a live
        // review (see the handler block's security notes).
        .route(
            "/v1/reviews/annotations",
            get(handle_review_annotations_list)
                .post(handle_review_annotations_add)
                .delete(handle_review_annotations_clear),
        )
        // WASM extension surface (Elevation B3): the installed-extensions
        // snapshot (status, strikes, panel) and the one sanctioned UI slot —
        // an extension replaces its own sanitized markdown panel. The panel
        // route is scope-guarded by the middleware (`ui.panel`) and
        // identity-guarded in the handler (name must match the grant).
        .route("/v1/extensions", get(handle_extensions_list))
        .route("/v1/extensions/:name/panel", post(handle_extension_panel))
        // Instance control plane: the boot preflight's "who holds this port"
        // probe, and the master-token-only graceful retirement it invokes
        // against a headless incumbent (window gone, daemon alive).
        .route("/v1/liveness", get(handle_liveness))
        .route("/v1/admin/shutdown", post(handle_admin_shutdown))
        // The responsiveness probe's readout (perf budget, "Responsiveness").
        .route("/v1/perf", get(handle_perf))
        // Control-plane auth (Shardplate Phase 2): every request is checked
        // against the frozen v1 contract in `auth::all_routes()` — mutating
        // routes demand the per-boot bearer token (or a scoped extension
        // token), hook-contract and read-only routes pass. Fails closed on
        // routes missing from the table, so registering a route here without
        // a contract entry is a loud 401, not a silent hole.
        .layer(axum::middleware::from_fn(auth::require_daemon_auth))
        .with_state(state);
    // The WASM extension host drives every guest `host_call` through THIS
    // exact router (single dispatch path — see extension_host.rs). A clone
    // of the served router, installed before the bind so an early event
    // delivery can never observe a half-configured surface.
    extension_host::install_router(app.clone());
    let addr = runtime_profile::current().daemon_addr();
    match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => {
            daemon_status.set_bound(true);
            boot_trace::mark(boot_trace::DAEMON_BIND);
            probe::record(probe::Milestone::Daemon, format!("bound {addr}"));
            tracing::info!(%addr, "Redline daemon listening");
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
            boot_trace::mark(boot_trace::DAEMON_BIND);
            tracing::error!(error = %e, %addr, "failed to bind the daemon");
            probe::record_failure(format!("the daemon could not bind {addr}: {e}"));
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

/// Out-of-band feedback delivery (Layer 1). The denied `ExitPlanMode` reason is
/// now a single calm line; the model fetches the full review payload here
/// (`curl -s http://127.0.0.1:7676/v1/sessions/<id>/feedback`, pre-authorized by
/// the redline skill's curl allow). The body is plain text, byte-identical to
/// what used to ride inline in `permissionDecisionReason` — the golden suites
/// guard those bytes. 404 when nothing is pending: a stale or duplicate fetch,
/// safe to ignore.
async fn handle_get_feedback(
    State(app_state): State<AppState>,
    Path(session_id): Path<String>,
) -> axum::response::Response {
    match app_state.pending_feedback.get(&session_id) {
        Some(payload) => (StatusCode::OK, payload).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            "No feedback is pending for this Redline session.".to_string(),
        )
            .into_response(),
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

async fn handle_suggest_feedback(
    State(app_state): State<AppState>,
    Path(session_id): Path<String>,
    Json(req): Json<agent::SuggestFeedbackRequest>,
) -> axum::response::Response {
    match agent::add_feedback_core(&app_state.store, &session_id, req) {
        Ok(comment) => {
            tracing::info!(
                session_id = %session_id,
                comment_id = %comment.id,
                author = comment.author.as_deref().unwrap_or(""),
                "agent feedback comment landed"
            );
            let landed = voice::land_feedback(&app_state.app_handle, &app_state.store, &session_id, comment, None);
            let _ = app_state.app_handle.emit(
                "comments-changed",
                SessionEvent {
                    session_id: session_id.clone(),
                },
            );
            refresh_tray(&app_state.app_handle, &app_state.store);
            (StatusCode::CREATED, Json(landed)).into_response()
        }
        Err(e) => agent_error_response(e).into_response(),
    }
}

/// How many items one turn may offer. Two is a conversation; a list of chips
/// under every reply is a form.
const MAX_OFFERS_PER_TURN: i64 = 2;

/// `POST /v1/sessions/:session_id/comment-offers` — stage an offered plan item.
///
/// This writes nothing to the plan. The block id is resolved **here**, at stage
/// time, so a bogus id 404s the agent while it can still re-read the plan
/// rather than becoming a chip that only fails when the user taps it. And
/// deliberately no `refresh_tray`: nothing is pending review yet.
async fn handle_offer_feedback(
    State(app_state): State<AppState>,
    Path(session_id): Path<String>,
    Json(req): Json<agent::OfferFeedbackRequest>,
) -> axum::response::Response {
    if req.body.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "body must not be empty").into_response();
    }
    if req.agent_id.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "agentId must not be empty").into_response();
    }
    if let Err(e) = agent::resolve_block_anchor(&app_state.store, &session_id, &req.block_id) {
        return agent_error_response(e).into_response();
    }

    let db = app_state.store.database();
    match db.count_open_offers_this_turn(&session_id) {
        Ok(n) if n >= MAX_OFFERS_PER_TURN => {
            return (
                StatusCode::CONFLICT,
                format!(
                    "this turn has already offered {n} items — say the rest out loud instead"
                ),
            )
                .into_response()
        }
        Err(e) => return browser_error_response(e.to_string()),
        Ok(_) => {}
    }

    let offer = state::CommentOffer {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: session_id.clone(),
        // Bound to its reply by `bind_comment_offers` when that turn finishes —
        // the offer necessarily lands first.
        message_id: None,
        block_id: req.block_id,
        body: req.body.trim().to_string(),
        label: req
            .label
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty()),
        agent_id: req.agent_id.trim().to_string(),
        status: "pending".to_string(),
        created_at: ledger::now_millis(),
        stale: false,
        explicit: req.explicit,
    };
    if let Err(e) = db.insert_comment_offer(&offer) {
        return browser_error_response(e.to_string());
    }
    tracing::info!(
        session_id = %session_id,
        offer_id = %offer.id,
        agent = %offer.agent_id,
        explicit = offer.explicit,
        "plan item offered (not written)"
    );
    // The agent's read-back names the section, so hand it the title it lands in.
    let section_title = agent::section_title_for(&app_state.store, &session_id, &offer.block_id);
    let _ = app_state.app_handle.emit("comment-offer", &offer);
    extension_host::publish(
        ext_events::COMMENT_OFFER,
        &ext_events::CommentOffer {
            offer_id: offer.id.clone(),
            session_id: offer.session_id.clone(),
            block_id: Some(offer.block_id.clone()),
            body: offer.body.clone(),
            agent_id: offer.agent_id.clone(),
            ts_ms: extension_host::now_ms(),
        },
    );
    let note = if offer.explicit {
        "staged — read it back in one sentence; Redline adds it after your read-back. Do not post it yourself"
    } else {
        "offered — the user taps ＋ Add as item to create it; do not post it yourself"
    };
    (
        StatusCode::CREATED,
        Json(serde_json::json!({
            "id": offer.id,
            "status": "pending",
            "explicit": offer.explicit,
            "sectionTitle": section_title,
            "note": note,
        })),
    )
        .into_response()
}

// --- Browse-agent daemon routes -------------------------------------------
// The browse agent (`browse.rs`) drives the active browser tab through these.
// Selectors and schemas only ever reach the page as data passed to
// `querySelector` (never eval'd code) — the same safety property as the scrape
// kernel. `click` is a fixed script; `navigate` is a direct `wv.navigate`.

/// Fixed in-page DOM-snapshot kernel: returns the page as JSON
/// `{url,title,selection,text,headings[],links[]}`, all bounded. Mirrors the
/// scrape kernel's "return a JSON string on every path" contract.
const SNAPSHOT_JS: &str = r#"(function(){try{
var sel = window.getSelection ? String(window.getSelection()) : "";
var headings = Array.prototype.slice.call(document.querySelectorAll("h1,h2,h3")).slice(0,100).map(function(h){return {tag:h.tagName.toLowerCase(), text:(h.innerText||"").trim().slice(0,200)};});
var links = Array.prototype.slice.call(document.querySelectorAll("a[href]")).slice(0,200).map(function(a){return {text:(a.innerText||"").trim().slice(0,120), href:a.href};});
var body = document.body ? (document.body.innerText||"") : "";
if (body.length > 20000) body = body.slice(0,20000);
return JSON.stringify({url:location.href, revision:window.__redline_revision?window.__redline_revision():String(performance.timeOrigin), title:document.title||"", selection:sel.slice(0,2000), text:body, headings:headings, links:links});
}catch(e){return JSON.stringify({url:location.href, title:document.title||"", selection:"", text:"", headings:[], links:[]});}})()"#;

/// The scrape interpreter behind the browse agent's `/v1/browser/query` route: a
/// pure data-walk over a schema, selectors only ever string arguments to
/// `querySelector`. Used to build the query program server-side from the schema
/// the agent POSTs.
const SCRAPE_INTERPRETER_JS: &str = r#"function(schema){
  var warnings = [];
  function clamp(s, max){
    if (typeof s !== "string" || !max || s.length <= max) return s;
    warnings.push("truncated to " + max + " chars");
    return s.slice(0, max);
  }
  function read(ctx, f){
    try {
      if (f.type === "list"){
        var sel = f.itemSelector || f.selector;
        var items = sel ? Array.prototype.slice.call(ctx.querySelectorAll(sel)) : [];
        return items.map(function(el){
          if (f.itemFields && f.itemFields.length){
            var o = {};
            f.itemFields.forEach(function(s){ o[s.name] = read(el, s); });
            return o;
          }
          return clamp(el.innerText || "", f.maxChars);
        });
      }
      var el = f.selector ? ctx.querySelector(f.selector) : ctx;
      if (!el){ warnings.push("no match: " + f.name + " [" + f.selector + "]"); return null; }
      switch (f.type){
        case "text": return clamp(el.innerText || "", f.maxChars);
        case "html": return clamp(el.innerHTML || "", f.maxChars);
        case "attr": return el.getAttribute(f.attribute || "");
        default: warnings.push("unknown type: " + f.type + " (" + f.name + ")"); return null;
      }
    } catch(e){ warnings.push(f.name + ": " + String(e)); return null; }
  }
  var base = schema.root ? (document.querySelector(schema.root) || document) : document;
  var data = {};
  (schema.fields || []).forEach(function(f){ data[f.name] = read(base, f); });
  return { ok:true, version: schema.version, schemaName: schema.name || "",
           url: location.href, title: document.title || "",
           data: data, warnings: warnings };
}"#;

/// Wrap a JSON-literal schema in the self-contained query program (mirrors
/// `buildScrapeProgram`). Built by concatenation so a `$&`/`$1` in a selector
/// can never corrupt anything.
fn build_query_program(schema_json: &str) -> String {
    format!(
        "(function(){{try{{return JSON.stringify(({})({}));}}catch(e){{return JSON.stringify({{ok:false,error:String(e)}});}}}})()",
        SCRAPE_INTERPRETER_JS, schema_json
    )
}

/// macOS-gated page eval for the daemon routes (the underlying
/// `eval_with_result` is macOS-only).
#[cfg(target_os = "macos")]
async fn daemon_eval(app: &AppHandle, label: &str, script: &str) -> Result<String, String> {
    eval_with_result(app, label, script).await
}
#[cfg(not(target_os = "macos"))]
async fn daemon_eval(_app: &AppHandle, _label: &str, _script: &str) -> Result<String, String> {
    Err("browser control is only supported on macOS".to_string())
}

/// 502 with `{error}` — the browse routes' failure shape (no active tab, the
/// page eval failed, …).
fn browser_error_response(msg: impl Into<String>) -> axum::response::Response {
    (
        StatusCode::BAD_GATEWAY,
        Json(serde_json::json!({ "error": msg.into() })),
    )
        .into_response()
}

/// Turn a page eval's raw JSON string into a JSON response, or a 502 if it came
/// back empty / unparseable (page gone, eval failed).
fn eval_json_response(raw: Result<String, String>) -> axum::response::Response {
    match raw {
        Ok(s) => match serde_json::from_str::<Value>(&s) {
            Ok(v) => Json(v).into_response(),
            Err(_) => browser_error_response("the page returned no usable result"),
        },
        Err(e) => browser_error_response(e),
    }
}

/// Optional `?tab=<selector>` on the browse routes — a 1-based tab NUMBER (its
/// position in the strip, e.g. `2`), a short tab id (`t3`), or a raw webview
/// label (`browser-t3`). Absent → act on the active tab.
#[derive(Deserialize)]
struct TabSel {
    tab: Option<String>,
}

/// Normalize an id/label selector to a webview label: a bare id (`t3`) becomes
/// `browser-t3`; a `browser-…` label passes through. (Ordinals are handled by
/// `resolve_selector`, not here — this is the id/label transform only.)
fn selector_to_label(sel: &str) -> String {
    if sel.starts_with("browser-") {
        sel.to_string()
    } else {
        format!("browser-{sel}")
    }
}

/// Map a 1-based tab NUMBER (its position in the mirrored strip order) to its
/// webview label. `0` and out-of-range return `None`.
fn label_for_ordinal(app_state: &AppState, n: usize) -> Option<String> {
    if n == 0 {
        return None;
    }
    app_state
        .browser_tabs
        .get()
        .get(n - 1)
        .map(|t| t.label.clone())
}

/// Resolve a `?tab=` selector to a webview label, accepting a 1-based tab number
/// (`2`), a short id (`t3`), or a raw label (`browser-t3`). A bare integer is
/// unambiguous — real ids always carry a `t` prefix — so it's treated as the
/// strip ordinal. Returns `None` for an out-of-range ordinal; id/label forms
/// always produce a (possibly non-existent) label that callers then validate.
fn resolve_selector(app_state: &AppState, sel: &str) -> Option<String> {
    if let Ok(n) = sel.parse::<usize>() {
        return label_for_ordinal(app_state, n);
    }
    Some(selector_to_label(sel))
}

/// Resolve which tab a browse route should act on: the `?tab=` selector if given
/// (validated against a live webview), else the active tab. Returns a ready 502
/// on failure so callers can `?`-style early-return it.
fn resolve_tab_label(
    app_state: &AppState,
    tab: Option<String>,
) -> Result<String, axum::response::Response> {
    match tab.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
        Some(sel) => {
            let label = resolve_selector(app_state, &sel)
                .ok_or_else(|| browser_error_response(format!("no such tab: {sel}")))?;
            if app_state.app_handle.get_webview(&label).is_some() {
                Ok(label)
            } else {
                Err(browser_error_response(format!("no such tab: {sel}")))
            }
        }
        None => app_state
            .active_browser
            .get()
            .ok_or_else(|| browser_error_response("no active browser tab")),
    }
}

/// Resolve a tab selector to its discussion `browse_id` via the mirrored tab
/// registry (for `/v1/browser/thread`). Absent selector → the active tab. Uses
/// the cache-aware label resolver so a SUSPENDED tab's thread (which lives in
/// the DB regardless of webview liveness) is still readable.
fn resolve_browse_id(
    app_state: &AppState,
    tab: Option<String>,
) -> Result<String, axum::response::Response> {
    let label = resolve_label_any(app_state, tab)?;
    known_browser_tab(app_state, &label)
        .map(|tab| tab.browse_id)
        .ok_or_else(|| browser_error_response(format!("no discussion thread for tab: {label}")))
}

fn known_browser_tab(state: &AppState, label: &str) -> Option<TabInfo> {
    state
        .browser_tabs
        .get()
        .into_iter()
        .find(|tab| tab.label == label)
        .or_else(|| {
            browser_workspace::find_tab(&state.store.database(), label)
                .ok()
                .flatten()
                .and_then(|value| serde_json::from_value(value).ok())
        })
}

/// Resolve a tab selector to a webview label WITHOUT requiring the webview to be
/// live — used by cache-aware read routes that can serve a suspended (or
/// not-yet-materialized) tab from the snapshot cache. An explicit `?tab=` is
/// validated against the mirrored tab registry so only real tabs resolve;
/// absent selector → the active tab. (Unlike `resolve_tab_label`, a registered
/// but non-live tab is accepted.)
fn resolve_label_any(
    app_state: &AppState,
    tab: Option<String>,
) -> Result<String, axum::response::Response> {
    match tab.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
        Some(sel) => {
            let label = resolve_selector(app_state, &sel)
                .ok_or_else(|| browser_error_response(format!("no such tab: {sel}")))?;
            if app_state.app_handle.get_webview(&label).is_some()
                || known_browser_tab(app_state, &label).is_some()
            {
                Ok(label)
            } else {
                Err(browser_error_response(format!("no such tab: {sel}")))
            }
        }
        None => app_state
            .active_browser
            .get()
            .ok_or_else(|| browser_error_response("no active browser tab")),
    }
}

/// Capture a tab's snapshot from the live page and refresh the cache. Best
/// effort: a failed eval leaves the prior cache entry untouched.
async fn refresh_snapshot_cache(app_state: &AppState, label: &str, json: &str) {
    let url = app_state
        .app_handle
        .get_webview(label)
        .and_then(|wv| webview_current_url(&wv))
        .unwrap_or_default();
    app_state.snapshot_cache.put(
        label.to_string(),
        CachedSnapshot {
            json: json.to_string(),
            url,
            captured_at: now_millis(),
            scroll: None,
        },
    );
}

/// Serialize one native preparation without retaining an unbounded set of locks.
/// Weak entries disappear after the last active/queued caller releases its Arc.
fn preparation_lock(key: &str) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: std::sync::OnceLock<StdMutex<std::collections::HashMap<String, std::sync::Weak<tokio::sync::Mutex<()>>>>> = std::sync::OnceLock::new();
    let mut locks = LOCKS.get_or_init(Default::default).lock().unwrap();
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(key).and_then(std::sync::Weak::upgrade) { return lock; }
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    locks.insert(key.to_owned(), Arc::downgrade(&lock));
    lock
}

/// The one Safari user agent every browser tab presents. `src/lib/safariUA.ts`
/// pins the same string for the thumbnail webviews; a test keeps them equal.
const SAFARI_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15";

/// The one way a browser tab's native webview is built, whether the pane asks
/// (`browser_create_tab`) or a background wake does (`ensure_live`), so every
/// tab has the same user agent and the Safari-style download handler. A
/// webview made through the JS `Webview` API could never get `on_download`, and
/// wry cancels downloads on a webview without one.
fn browser_tab_builder(label: &str, url: tauri::Url) -> tauri::webview::WebviewBuilder<tauri::Wry> {
    tauri::webview::WebviewBuilder::new(label, tauri::WebviewUrl::External(url))
        .focused(false)
        .accept_first_mouse(true)
        .user_agent(SAFARI_UA)
        .on_download(browser_output::on_download)
}

/// Where a new tab starts: the page itself for http(s) and about:blank, or
/// about:blank plus a file to load for `file://` (WebKit only opens local files
/// through `loadFileURL:allowingReadAccessToURL:`). Anything else is refused.
fn browser_tab_start(url: &str) -> Result<(tauri::Url, Option<std::path::PathBuf>), &'static str> {
    let parsed: tauri::Url = url.parse().map_err(|_| "The tab's address is invalid")?;
    match parsed.scheme() {
        "http" | "https" => Ok((parsed, None)),
        _ if parsed.as_str() == "about:blank" => Ok((parsed, None)),
        "file" => {
            let path = parsed.to_file_path().map_err(|_| "The tab's file address is invalid")?;
            Ok(("about:blank".parse().expect("static url"), Some(path)))
        }
        _ => Err("Unsupported tab address"),
    }
}

/// Load a local file into a tab, with read access to the file's folder so a
/// page's sibling assets resolve.
fn load_file_url(wv: &tauri::Webview, path: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let file = path.display().to_string();
        let dir = path.parent().map(|d| d.display().to_string()).unwrap_or_else(|| "/".into());
        wv.with_webview(move |pw| {
            use objc2_foundation::{NSString, NSURL};
            // SAFETY: `with_webview` runs on the main thread; `inner()` is the live WKWebView.
            unsafe {
                let Some(webview) = (pw.inner() as *mut objc2_web_kit::WKWebView).as_ref() else { return };
                let file = NSURL::fileURLWithPath_isDirectory(&NSString::from_str(&file), false);
                let dir = NSURL::fileURLWithPath_isDirectory(&NSString::from_str(&dir), true);
                let _ = webview.loadFileURL_allowingReadAccessToURL(&file, &dir);
            }
        })
        .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let url = tauri::Url::from_file_path(path).map_err(|_| "invalid file path".to_string())?;
        wv.navigate(url).map_err(|e| e.to_string())
    }
}

/// Create a browser tab's native webview for the pane, which then adopts it by
/// label (`Webview.getByLabel`) for show / hide / position as before. Shares
/// the wake lock with `ensure_live`, so a pane create racing a background wake
/// yields one webview, not a duplicate-label error.
#[tauri::command(async)]
async fn browser_create_tab(app: AppHandle, label: String, url: String, css: Option<String>, website: Option<String>, zoom: Option<f64>, selection_actions: Option<bool>) -> Result<(), String> {
    if !label.starts_with("browser-") || label.len() > 160 {
        return Err("Invalid browser tab label".into());
    }
    let (initial, file) = browser_tab_start(&url)?;
    let lock = preparation_lock(&format!("wake:{label}"));
    let _guard = lock.lock().await;
    if app.get_webview(&label).is_some() {
        return configure_browser_tab(&app, &label, css.as_deref().unwrap_or(""), website.as_deref().unwrap_or("default"), zoom.unwrap_or(1.0), selection_actions.unwrap_or(true));
    }
    let setup_label = label.clone();
    let window = app.get_window("main").ok_or("Browser window is unavailable")?;
    let handle = app.clone();
    let (send, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        if handle.get_webview(&label).is_some() { let _ = send.send(Ok(())); return; }
        let result = window
            .add_child(browser_tab_builder(&label, initial), tauri::LogicalPosition::new(-10000.0, -10000.0), tauri::LogicalSize::new(1.0, 1.0))
            .map_err(|e| e.to_string())
            .and_then(|view| match &file { Some(path) => load_file_url(&view, path), None => Ok(()) });
        let _ = send.send(result);
    })
    .map_err(|e| e.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(6), receive)
        .await
        .map_err(|_| "Browser creation is still pending".to_string())?
        .map_err(|_| "Browser creation was interrupted".to_string())??;
    configure_browser_tab(&app, &setup_label, css.as_deref().unwrap_or(""), website.as_deref().unwrap_or("default"), zoom.unwrap_or(1.0), selection_actions.unwrap_or(true))
}

/// Set a freshly created or woken tab up: gestures, autoresize, the floating
/// overlays' cut-outs, Redline's user scripts, and the new-window UI delegate
/// (installed here, once per webview, NOT from `install_user_scripts`, which
/// re-runs on every view-filter swap and would otherwise churn the delegate
/// and drop any open popups).
fn configure_browser_tab(app: &AppHandle, label: &str, css: &str, website: &str, zoom: f64, selection_actions: bool) -> Result<(), String> {
    let view = app.get_webview(label).ok_or("Browser view unavailable")?;
    browser_enable_gestures(app.clone(), label.to_owned())?;
    browser_enable_autoresize(app.clone(), label.to_owned(), Some(false))?;
    browser_overlay::attach_current(app, label)?;
    #[cfg(target_os = "macos")] {
        browser_events::install(app.clone(), &view)?;
        install_user_scripts(&view, css, selection_actions)?;
        let _ = browser_popup::install_new_window_delegate(&view);
    }
    #[cfg(not(target_os = "macos"))] let _ = (view, css, selection_actions);
    browser_events::browser_set_appearance(app.clone(), label.to_owned(), website.to_owned(), zoom)
}

/// Materialize a saved or suspended tab without requiring a mounted browser
/// pane or changing the active workspace. The pane can adopt it by stable label.
#[cfg(target_os = "macos")]
async fn ensure_live(app_state: &AppState, label: &str) -> Result<(), axum::response::Response> {
    let lock = preparation_lock(&format!("wake:{label}"));
    let _guard = lock.lock().await;
    browser_workspace::touch(label);
    if app_state.app_handle.get_webview(label).is_some() { return Ok(()); }
    let tab = known_browser_tab(app_state, label)
        .ok_or_else(|| browser_error_response("The saved tab is unavailable"))?;
    let (url, file) = browser_tab_start(&tab.url).map_err(browser_error_response)?;
    let requested_blank = url.as_str() == "about:blank" && file.is_none();
    let window = app_state.app_handle.get_window("main")
        .ok_or_else(|| browser_error_response("Browser window is unavailable"))?;
    let handle = app_state.app_handle.clone();
    let label_owned = label.to_owned();
    let (send, receive) = tokio::sync::oneshot::channel();
    app_state.app_handle.run_on_main_thread(move || {
        // The pane may have created the same stable label while this callback
        // was queued. Reuse it; do not hide or refocus an already visible tile.
        if handle.get_webview(&label_owned).is_some() { let _ = send.send(Ok(())); return; }
        let result = window.add_child(
            browser_tab_builder(&label_owned, url),
            tauri::LogicalPosition::new(-10000.0, -10000.0), tauri::LogicalSize::new(1024.0, 768.0),
        ).map_err(|e| e.to_string()).and_then(|view| {
            let setup = (|| {
                view.hide().map_err(|e| e.to_string())?;
                configure_browser_tab(&handle, &label_owned, "", "default", 1.0, true)?;
                if let Some(path) = &file { load_file_url(&view, path)?; }
                Ok(())
            })();
            if setup.is_err() { let _ = view.close(); }
            setup
        });
        let _ = send.send(result);
    }).map_err(|e| browser_error_response(e.to_string()))?;
    tokio::time::timeout(std::time::Duration::from_secs(6), receive).await
        .map_err(|_| browser_error_response("Browser creation is still pending; inspect the tab before retrying"))?
        .map_err(|_| browser_error_response("Browser creation was interrupted"))?
        .map_err(browser_error_response)?;
    // Inform a mounted pane so it can adopt the native view. This is never a
    // focus event, and no UI listener is required for the wake to complete.
    let id = label.strip_prefix("browser-").unwrap_or(label).to_string();
    let _ = app_state.app_handle.emit("browse-wake-tab", serde_json::json!({"id":id}));
    let ready = async {
        let probe = "JSON.stringify({ready:document.readyState,url:location.href})";
        loop {
            if let Ok(raw) = daemon_eval(&app_state.app_handle, label, probe).await {
                if let Ok(value) = serde_json::from_str::<Value>(&raw) {
                    if matches!(value["ready"].as_str(), Some("complete" | "interactive"))
                        && (requested_blank || value["url"].as_str().is_some_and(|url| url != "about:blank")) { return; }
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(80)).await;
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(4), ready).await
        .map_err(|_| browser_error_response("The tab was opened but its document is not ready yet"))?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
async fn ensure_live(_app_state: &AppState, _label: &str) -> Result<(), axum::response::Response> {
    Err(browser_error_response(
        "browser control is only supported on macOS",
    ))
}

async fn handle_browser_active(
    State(app_state): State<AppState>,
    Query(sel): Query<TabSel>,
) -> axum::response::Response {
    let label = match resolve_label_any(&app_state, sel.tab) {
        Ok(l) => l,
        Err(resp) => return resp,
    };
    if app_state.app_handle.get_webview(&label).is_some() {
        let script = r#"(function(){try{return JSON.stringify({url:location.href,title:document.title||""});}catch(e){return JSON.stringify({url:"",title:""});}})()"#;
        match daemon_eval(&app_state.app_handle, &label, script).await {
            Ok(s) => {
                let mut v: Value =
                    serde_json::from_str(&s).unwrap_or_else(|_| serde_json::json!({}));
                if let Some(obj) = v.as_object_mut() {
                    obj.insert("label".to_string(), Value::String(label));
                }
                Json(v).into_response()
            }
            Err(e) => browser_error_response(e),
        }
    } else if let Some(snap) = app_state.snapshot_cache.get(&label) {
        // Not live: report url/title from the cached snapshot.
        let cached: Value = serde_json::from_str(&snap.json).unwrap_or_else(|_| serde_json::json!({}));
        let url = cached
            .get("url")
            .cloned()
            .unwrap_or(Value::String(snap.url.clone()));
        let title = cached.get("title").cloned().unwrap_or(Value::String(String::new()));
        Json(serde_json::json!({
            "url": url,
            "title": title,
            "label": label,
            "cached": true,
            "capturedAt": snap.captured_at,
        }))
        .into_response()
    } else {
        browser_error_response(format!("tab '{label}' is not live and has no cached snapshot"))
    }
}

async fn handle_browser_snapshot(
    State(app_state): State<AppState>,
    Query(sel): Query<TabSel>,
) -> axum::response::Response {
    let label = match resolve_label_any(&app_state, sel.tab) {
        Ok(l) => l,
        Err(resp) => return resp,
    };
    if known_browser_tab(&app_state, &label).is_some_and(|tab| tab.url == "redline:newtab") {
        return eval_json_response(Ok(serde_json::json!({"url":"redline:newtab","title":"New tab","text":"Redline new tab home. Navigate to a URL to inspect a page.","links":[]}).to_string()));
    }
    // Live: snapshot the page and refresh the cache. Not live: serve the cached
    // snapshot. (Phase 3 will wake a suspended tab here when there is no cache
    // entry; for now that case is a 502.)
    if app_state.app_handle.get_webview(&label).is_some() {
        match daemon_eval(&app_state.app_handle, &label, SNAPSHOT_JS).await {
            Ok(json) => {
                refresh_snapshot_cache(&app_state, &label, &json).await;
                eval_json_response(Ok(json))
            }
            Err(e) => browser_error_response(e),
        }
    } else if let Some(snap) = app_state.snapshot_cache.get(&label) {
        // Serve the cached snapshot, tagged so the agent can judge staleness.
        let mut v: Value = serde_json::from_str(&snap.json).unwrap_or_else(|_| serde_json::json!({}));
        if let Some(obj) = v.as_object_mut() {
            obj.insert("cached".to_string(), Value::Bool(true));
            obj.insert("capturedAt".to_string(), Value::from(snap.captured_at));
        }
        Json(v).into_response()
    } else {
        // Not live and nothing cached — wake the tab in the background, then
        // snapshot the live page and seed the cache.
        if let Err(resp) = ensure_live(&app_state, &label).await {
            return resp;
        }
        match daemon_eval(&app_state.app_handle, &label, SNAPSHOT_JS).await {
            Ok(json) => {
                refresh_snapshot_cache(&app_state, &label, &json).await;
                eval_json_response(Ok(json))
            }
            Err(e) => browser_error_response(e),
        }
    }
}

async fn handle_browser_query(
    State(app_state): State<AppState>,
    Query(sel): Query<TabSel>,
    Json(schema): Json<Value>,
) -> axum::response::Response {
    // The explicit live-rehydrate path: a fresh query against the current DOM.
    // Resolve even a suspended tab, then wake it in the background.
    let label = match resolve_label_any(&app_state, sel.tab) {
        Ok(l) => l,
        Err(resp) => return resp,
    };
    if let Err(resp) = ensure_live(&app_state, &label).await {
        return resp;
    }
    let schema_json = match serde_json::to_string(&schema) {
        Ok(j) => j,
        Err(e) => return browser_error_response(format!("invalid schema: {e}")),
    };
    let program = build_query_program(&schema_json);
    eval_json_response(daemon_eval(&app_state.app_handle, &label, &program).await)
}

#[derive(Deserialize)]
struct NavigateReq {
    url: String,
}

async fn handle_browser_navigate(
    State(app_state): State<AppState>,
    Query(sel): Query<TabSel>,
    Json(req): Json<NavigateReq>,
) -> axum::response::Response {
    let label = match resolve_label_any(&app_state, sel.tab) {
        Ok(l) => l,
        Err(resp) => return resp,
    };
    if let Err(resp) = ensure_live(&app_state, &label).await {
        return resp;
    }
    action_response(
        &app_state,
        label,
        browser_actions::Operation::Navigate { url: req.url },
    )
    .await
}

#[derive(Deserialize)]
struct ClickReq {
    selector: String,
}

async fn handle_browser_click(
    State(app_state): State<AppState>,
    Query(sel): Query<TabSel>,
    Json(req): Json<ClickReq>,
) -> axum::response::Response {
    let label = match resolve_label_any(&app_state, sel.tab) {
        Ok(l) => l,
        Err(resp) => return resp,
    };
    if let Err(resp) = ensure_live(&app_state, &label).await {
        return resp;
    }
    action_response(
        &app_state,
        label,
        browser_actions::Operation::Click {
            selector: req.selector,
        },
    )
    .await
}

async fn action_response(
    state: &AppState,
    label: String,
    operation: browser_actions::Operation,
) -> axum::response::Response {
    let request = browser_actions::ActionRequest {
        operation_id: uuid::Uuid::new_v4().to_string(),
        label,
        expected_revision: None,
        timeout_ms: None,
        operation,
    };
    match browser_actions::execute(state.app_handle.clone(), request).await {
        Ok(result) => {
            Json(serde_json::json!({ "ok": result.status == "completed", "action": result }))
                .into_response()
        }
        Err(e) => browser_error_response(e),
    }
}
async fn handle_browser_action(
    State(state): State<AppState>,
    Json(request): Json<Value>,
) -> axum::response::Response {
    let request = match browser_actions::parse_request(request) {
        Ok(request) => request,
        Err(error) => return (StatusCode::UNPROCESSABLE_ENTITY, Json(serde_json::json!({ "error": error }))).into_response(),
    };
    if known_browser_tab(&state, &request.label).is_none() {
        return browser_error_response("The action targets a closed or unknown tab");
    }
    if let Err(response) = ensure_live(&state, &request.label).await {
        return response;
    }
    match browser_actions::execute(state.app_handle.clone(), request).await {
        Ok(result) => Json(result).into_response(),
        Err(error) => browser_error_response(error),
    }
}

/// `GET /v1/browser/tabs` — the open-tab registry, so a browse agent can see all
/// of the user's tabs (and which to address with `?tab=`). `browse_id` is kept
/// internal; the agent reads a tab's discussion via `/v1/browser/thread?tab=`.
async fn handle_browser_tabs(State(app_state): State<AppState>) -> axum::response::Response {
    let active = app_state.active_browser.get();
    let tabs: Vec<Value> = app_state
        .browser_tabs
        .get()
        .into_iter()
        .enumerate()
        .map(|(i, t)| {
            serde_json::json!({
                // `n` is the 1-based tab number shown in the strip and used with
                // the user ("tab 2"); also a valid `?tab=` selector. Positional —
                // it changes as tabs open/close, so re-read /tabs each task.
                "n": i + 1,
                "id": t.id,
                "label": t.label,
                "url": t.url,
                "title": t.title,
                "active": Some(&t.label) == active.as_ref(),
            })
        })
        .collect();
    Json(serde_json::json!({ "tabs": tabs })).into_response()
}

/// `GET /v1/browser/thread?tab=<id>` — another tab's persisted discussion
/// history (the cheap "check in with a colleague" primitive: read what was
/// discussed there, no extra agent turn). Defaults to the active tab.
async fn handle_browser_thread(
    State(app_state): State<AppState>,
    Query(sel): Query<TabSel>,
) -> axum::response::Response {
    let browse_id = match resolve_browse_id(&app_state, sel.tab) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let browse = app_state.app_handle.state::<browse::BrowseState>();
    match browse.load_thread(&browse_id) {
        Ok(messages) => {
            Json(serde_json::json!({ "browseId": browse_id, "messages": messages })).into_response()
        }
        Err(e) => browser_error_response(format!("failed to load thread: {e}")),
    }
}

/// `GET /v1/mission/active` — the active mission's goal/title/status, so the
/// orchestrator agent can re-ground on the goal at any point. `{active:false}`
/// when no mission is running.
async fn handle_mission_active(State(app_state): State<AppState>) -> axum::response::Response {
    match app_state.active_mission.get() {
        Some(info) => Json(serde_json::json!({
            "active": true,
            "missionId": info.mission_id,
            "title": info.title,
            "goal": info.goal,
            "status": info.status,
        }))
        .into_response(),
        None => Json(serde_json::json!({ "active": false })).into_response(),
    }
}

/// `GET /v1/mission/findings` — the active mission's pins (curated findings the
/// user pulled in). The orchestrator re-reads this each turn since the user pins
/// more as they browse. Resolves the `mission_id` from `active_mission`, then
/// loads from the DB via `MissionState`.
async fn handle_mission_findings(State(app_state): State<AppState>) -> axum::response::Response {
    let Some(info) = app_state.active_mission.get() else {
        return Json(serde_json::json!({ "active": false, "findings": [] })).into_response();
    };
    let mission = app_state.app_handle.state::<mission::MissionState>();
    match mission.load_findings(&info.mission_id) {
        Ok(findings) => {
            let pins: Vec<Value> = findings
                .into_iter()
                .map(|f| {
                    serde_json::json!({
                        "note": f.note,
                        "title": f.source_title,
                        "url": f.source_url,
                        "browseId": f.browse_id,
                        "body": f.body,
                    })
                })
                .collect();
            Json(serde_json::json!({ "missionId": info.mission_id, "findings": pins }))
                .into_response()
        }
        Err(e) => browser_error_response(format!("failed to load findings: {e}")),
    }
}

async fn handle_scoped_mission(
    State(state): State<AppState>,
    Path(mission_id): Path<String>,
) -> axum::response::Response {
    match state.store.database().get_mission(&mission_id) {
        Ok(Some(mission)) => Json(mission).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, "Mission not found").into_response(),
        Err(error) => browser_error_response(error.to_string()),
    }
}
async fn handle_scoped_tabs(
    State(state): State<AppState>,
    Path(mission_id): Path<String>,
) -> axum::response::Response {
    match browser_workspace::tabs(&state.store.database(), &mission_id) {
        Ok(tabs) => Json(serde_json::json!({ "missionId": mission_id, "workspaceId": mission_id, "tabs": tabs.into_iter().map(|mut tab| { if let Some(browse) = tab["browseId"].as_str() { let id = format!("t-{browse}"); tab["id"] = id.clone().into(); tab["label"] = format!("browser-{id}").into(); } tab }).collect::<Vec<_>>() })).into_response(),
        Err(error) => browser_error_response(error),
    }
}
/// Mission-owned pages can be created while another workspace is on screen.
async fn handle_scoped_open(
    State(state): State<AppState>,
    Path(mission_id): Path<String>,
    Json(request): Json<OpenReq>,
) -> axum::response::Response {
    let db = state.store.database();
    match db.get_mission(&mission_id) {
        Ok(Some(_)) => {},
        Ok(None) => return (StatusCode::NOT_FOUND, "Mission not found").into_response(),
        Err(error) => return browser_error_response(error.to_string()),
    }
    let Ok(url) = request.url.trim().parse::<tauri::Url>() else {
        return browser_error_response("Invalid page URL");
    };
    if !matches!(url.scheme(), "https" | "http") {
        return browser_error_response("Only HTTP pages are supported");
    }
    for _ in 0..3 {
        let saved = match browser_workspace::read(&db, &mission_id) {
            Ok(value) => value,
            Err(error) => return browser_error_response(error),
        };
        let revision = saved
            .as_ref()
            .and_then(|value| value["revision"].as_i64())
            .unwrap_or(0);
        let mut value = saved
            .unwrap_or_else(|| serde_json::json!({"tabs": [], "layout": {"preset":"research"}}));
        let mut tabs = match browser_workspace::tabs(&db, &mission_id) {
            Ok(value) => value,
            Err(error) => return browser_error_response(error),
        };
        // Older MissionTab rows stored a nullable, temporary id. Normalize
        // them before the durable workspace validates stable tab identities.
        for tab in &mut tabs {
            let Some(browse_id) = tab["browseId"].as_str().filter(|id| !id.is_empty()) else {
                return browser_error_response("A saved mission tab has no discussion identity");
            };
            tab["id"] = format!("t-{browse_id}").into();
        }
        let tab = if let Some(tab) = tabs.iter().find(|tab| {
            tab["url"]
                .as_str()
                .is_some_and(|existing| same_tab_url(existing, url.as_str()))
        }) {
            tab.clone()
        } else {
            let browse_id = uuid::Uuid::new_v4().to_string();
            let tab = serde_json::json!({"id":format!("t-{browse_id}"),"browseId":browse_id,"url":url.as_str(),"title":url.host_str().unwrap_or("Research page"),"dark":false,"chatOpen":false});
            tabs.push(tab.clone());
            tab
        };
        value["tabs"] = serde_json::json!(tabs);
        let updated = match browser_workspace::write(&db, &mission_id, value, Some(revision)) {
            Ok(value) => value,
            Err(error) if error.contains("changed during") => continue,
            Err(error) => return browser_error_response(error),
        };
        let label = format!("browser-t-{}", tab["browseId"].as_str().unwrap_or_default());
        let _ = state.app_handle.emit(
            "browser-workspace-tab-added",
            serde_json::json!({"workspaceId":mission_id,"tab":tab,"revision":updated["revision"]}),
        );
        if let Err(error) = ensure_live(&state, &label).await {
            return error;
        }
        return Json(serde_json::json!({"ok":true,"missionId":mission_id,"workspaceId":mission_id,"label":label,"tab":tab,"revision":updated["revision"]})).into_response();
    }
    browser_error_response(
        "The workspace changed while opening the page; retry from its latest tabs",
    )
}

async fn handle_scoped_findings(
    State(state): State<AppState>,
    Path(mission_id): Path<String>,
) -> axum::response::Response {
    let mission = state.app_handle.state::<mission::MissionState>();
    match mission.load_findings(&mission_id) {
        Ok(findings) => Json(serde_json::json!({ "missionId": mission_id, "workspaceId": mission_id, "findings": findings })).into_response(),
        Err(error) => browser_error_response(error.to_string()),
    }
}
async fn handle_mission_foundation(
    State(state): State<AppState>,
    Path(mission_id): Path<String>,
    Json(request): Json<Value>,
) -> axum::response::Response {
    let request = match mission_context::parse_request(request) {
        Ok(request) => request,
        Err(error) => return (StatusCode::UNPROCESSABLE_ENTITY, Json(serde_json::json!({ "error": error }))).into_response(),
    };
    use mission_context::FoundationAction as Action;
    if request.mission_id != mission_id || request.workspace_id != mission_id {
        return (StatusCode::BAD_REQUEST, "Mission scope mismatch").into_response();
    }
    if !matches!(
        &request.action,
        Action::Read
            | Action::GetCapture { .. }
            | Action::Resolve { .. }
            | Action::Export { .. }
            | Action::StartRun { .. }
            | Action::CheckpointRun { .. }
            | Action::FinishRun { .. }
            | Action::IngestFinding { .. }
            | Action::Observe { .. }
            | Action::EnqueueCapture { .. }
            | Action::IndexCapture { .. }
            | Action::SearchEvidence { .. }
            | Action::CuratedExamples
    ) {
        return (
            StatusCode::FORBIDDEN,
            "This operation requires the user's mission controls",
        )
            .into_response();
    }
    let db = state.store.database();
    match tokio::task::spawn_blocking(move || mission_context::dispatch(&db, request)).await {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(error)) => browser_error_response(error),
        Err(error) => browser_error_response(error.to_string()),
    }
}

#[derive(Deserialize)]
struct GlobalConsultReq {
    /// `browse | plan | mission | drafter`. `voice` and `companion`
    /// are rejected with pointed errors (see the handler).
    surface: String,
    /// The target's id in its surface's id-space — for `browse`, a tab
    /// selector (number / short id / label / url substring).
    id: String,
    question: String,
}

/// `POST /v1/global/consult` — the Companion "checks in with a colleague" on
/// ANY surface. Dispatches to that surface's own consult (each an inline-driven
/// turn behind a 180s ceiling, persisting check-in rows in the colleague's own
/// thread — except plan sessions, which run an ephemeral read-only fork and
/// persist nothing). Outer ceiling 240s so a wedged inner consult can't hold
/// this curl forever. Busy colleagues return a 502 the companion's skill
/// teaches as retry-or-glance. Reachability stays a DAG by documentation: only
/// the `companion` skill documents this route, so consult chains bottom out at depth 2.
async fn handle_global_consult(
    State(app_state): State<AppState>,
    Json(req): Json<GlobalConsultReq>,
) -> axum::response::Response {
    if req.question.trim().is_empty() {
        return browser_error_response("consult needs a question");
    }
    if req.id.trim().is_empty() {
        return browser_error_response("consult needs the target's id");
    }
    let handle = app_state.app_handle.clone();
    let question = req.question.clone();
    let outer = std::time::Duration::from_secs(240);
    let result: Result<(String, String), String> = match req.surface.as_str() {
        "browse" => {
            // Resolve the requested browser tab before consulting its page agent.
            let browse_id = match resolve_browse_id(&app_state, Some(req.id.clone())) {
                Ok(id) => id,
                Err(resp) => return resp,
            };
            let snapshot = resolve_label_any(&app_state, Some(req.id.clone()))
                .ok()
                .and_then(|label| app_state.snapshot_cache.get(&label).map(|s| s.json));
            let label = app_state
                .browser_tabs
                .get()
                .into_iter()
                .enumerate()
                .find(|(_, t)| t.browse_id == browse_id)
                .map(|(i, t)| format!("tab {} — {}", i + 1, t.title))
                .unwrap_or_else(|| "a browser tab".to_string());
            let browse = handle.state::<browse::BrowseState>().inner().clone();
            tokio::time::timeout(
                outer,
                browse.consult(handle.clone(), browse_id, question, snapshot),
            )
            .await
            .map_err(|_| "the consult timed out".to_string())
            .and_then(|r| r)
            .map(|digest| (digest, label))
        }
        "plan" => {
            let Some(session) = app_state.store.get(&req.id) else {
                return (StatusCode::NOT_FOUND, "no such plan session").into_response();
            };
            let label = session.project_name.clone();
            let cwd = session.project_path.clone();
            let fork = handle.state::<fork::ForkState>().inner().clone();
            tokio::time::timeout(outer, fork.consult_plan(req.id.clone(), cwd, question))
                .await
                .map_err(|_| "the consult timed out".to_string())
                .and_then(|r| r)
                .map(|digest| (digest, label))
        }
        "mission" => {
            let mission = handle.state::<mission::MissionState>().inner().clone();
            let label = app_state
                .store
                .database()
                .thread_label("mission", &req.id)
                .unwrap_or_else(|| "a mission".to_string());
            tokio::time::timeout(outer, mission.consult(req.id.clone(), question))
                .await
                .map_err(|_| "the consult timed out".to_string())
                .and_then(|r| r)
                .map(|digest| (digest, label))
        }
        "shipwright" => {
            // The Shipwright is a persistent thread, so a consult lands as a
            // check-in turn in its own session — it answers from its last digest
            // and findings instead of re-deriving them. That is the whole point:
            // the voice agent and Companion ASK it rather than rebuild its
            // context. `id` is the repo path (or empty for the default).
            let sess = handle.state::<ShipwrightSession>().inner().clone();
            let repo = if req.id.trim() == "-" || req.id.trim().is_empty() {
                std::env::current_dir()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_else(|_| ".".to_string())
            } else {
                req.id.clone()
            };
            let label = format!("the Shipwright on {repo}");
            let prior = sess.get();
            let question = format!(
                "A colleague is checking in. Answer from the digest and findings \
                 you already have — do NOT re-run your survey, and do NOT return \
                 JSON for this turn. Reply in prose, a few sentences, citing the \
                 numbers you already cited.\n\n{question}"
            );
            let repo_for_run = repo.clone();
            let burn_db = app_state.store.database();
            tokio::time::timeout(outer, async move {
                let (text, sid) =
                    shipwright::run_shipwright(&burn_db, &repo_for_run, question, prior.as_deref())
                        .await?;
                sess.set(sid);
                Ok::<String, String>(text)
            })
            .await
            .map_err(|_| "the consult timed out".to_string())
            .and_then(|r| r)
            .map(|digest| (digest, label))
        }
        "voice" => {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                "voice sessions run live and have no consult — read \
                 /v1/context/threads/voice/<id> instead",
            )
                .into_response();
        }
        "companion" => {
            // Chats ARE consultable. The blanket 422 this replaces was correct
            // when there was exactly one Companion; with named chat threads the
            // brainstorm is where the good thinking accumulates, and it already
            // appeared in /v1/global/agents — so refusing meant advertising a
            // colleague who then declined. The self-consult case is still
            // refused, by the busy reservation inside `consult`.
            let chat = handle.state::<companion::CompanionState>().inner().clone();
            let label = app_state
                .store
                .database()
                .thread_label("companion", &req.id)
                .unwrap_or_else(|| "a chat".to_string());
            tokio::time::timeout(outer, chat.consult(req.id.clone(), question))
                .await
                .map_err(|_| "the consult timed out".to_string())
                .and_then(|r| r)
                .map(|digest| (digest, label))
        }
        other => {
            return (
                StatusCode::BAD_REQUEST,
                format!(
                    "unknown surface `{other}` — one of \
                     browse|plan|mission|drafter|companion|shipwright"
                ),
            )
                .into_response();
        }
    };
    match result {
        Ok((digest, label)) => Json(serde_json::json!({
            "digest": digest,
            "surface": req.surface,
            "label": label,
        }))
        .into_response(),
        Err(e) => browser_error_response(e),
    }
}

/// `GET /v1/global/agents` — the Companion's map: every agent/thread across
/// the app with enough identity to glance or consult. Read-only aggregation
/// over the per-surface registries + the DB.
async fn handle_global_agents(State(app_state): State<AppState>) -> axum::response::Response {
    let handle = &app_state.app_handle;
    let db = app_state.store.database();

    // Plan sessions (external terminal claudes — consultable via ephemeral fork).
    let sessions: Vec<serde_json::Value> = app_state
        .store
        .list()
        .into_iter()
        .map(|s| {
            serde_json::json!({
                "surface": "plan",
                "id": s.session_id,
                "label": s.plan_title.unwrap_or(s.project_name),
                "status": s.status,
                "consultable": true,
                "busy": false,
            })
        })
        .collect();

    // Browser tabs (each with its own page-discussion agent).
    let browse_state = handle.state::<browse::BrowseState>();
    let tabs: Vec<serde_json::Value> = app_state
        .browser_tabs
        .get()
        .into_iter()
        .enumerate()
        .map(|(i, t)| {
            let (count, _) = db.thread_stats("browse", &t.browse_id).unwrap_or((0, None));
            serde_json::json!({
                "surface": "browse",
                "id": (i + 1).to_string(),
                "label": format!("tab {} — {}", i + 1, t.title),
                "detail": t.url,
                "messageCount": count,
                "consultable": true,
                "busy": browse_state.is_running(&t.browse_id),
            })
        })
        .collect();

    // Missions / linked / drafts / companions / voice from the DB. Busy flags
    // read each surface's turn registry — honest, not hardcoded.
    let mission_state = handle.state::<mission::MissionState>();
    let missions: Vec<serde_json::Value> = db
        .list_missions()
        .unwrap_or_default()
        .into_iter()
        .map(|m| {
            serde_json::json!({
                "surface": "mission",
                "id": m.mission_id,
                "label": m.title,
                "status": m.status,
                "consultable": true,
                "busy": mission_state.turn_active(&m.mission_id),
            })
        })
        .collect();
    // Chats — the unbound rooms. The comment above has named them since the
    // Companion was a singleton, but nothing ever built the list; now that a
    // chat is a named, consultable thread, a colleague map that omits it is a
    // colleague you cannot find.
    let companion_state = handle.state::<companion::CompanionState>();
    let chats: Vec<serde_json::Value> = db
        .list_companions()
        .unwrap_or_default()
        .into_iter()
        .map(|c| {
            let (count, _) = db.thread_stats("companion", &c.companion_id).unwrap_or((0, None));
            serde_json::json!({
                "surface": "companion",
                "id": c.companion_id,
                "label": c.title,
                "status": c.status,
                "messageCount": count,
                "consultable": true,
                "busy": companion_state.is_running(&c.companion_id),
            })
        })
        .collect();
    let reviews: Vec<serde_json::Value> = db
        .list_code_reviews()
        .unwrap_or_default()
        .into_iter()
        .take(10)
        .map(|r| {
            serde_json::json!({
                "surface": "review",
                "id": r.review_id,
                "label": r.repo_path,
                "detail": format!("round {}", r.round),
                "consultable": false,
                "busy": false,
            })
        })
        .collect();

    // The Shipwright: one persistent thread over the repo, not a per-item list.
    // It appears on the map so a colleague can ask it about code health instead
    // of re-deriving that context themselves.
    let shipwright_findings = db
        .list_shipwright_findings(false)
        .map(|f| f.len() as i64)
        .unwrap_or(0);
    let shipwright = serde_json::json!({
        "surface": "shipwright",
        "id": "-",
        "label": "the Shipwright (Redline's own code health)",
        "detail": format!("{shipwright_findings} open finding(s)"),
        "consultable": true,
        "busy": false,
    });

    Json(serde_json::json!({
        "activeSurface": app_state.active_surface.get(),
        "journalHead": db.journal_head().unwrap_or(0),
        "plans": sessions,
        "browserTabs": tabs,
        "missions": missions,
        "chats": chats,
        "reviews": reviews,
        "shipwright": shipwright,
        "notes": "consult browse|plan|mission|drafter|companion|shipwright \
                  via /v1/global/consult (the shipwright's id is `-`, or a repo \
                  path; a chat's is its companion id — you cannot consult the \
                  chat you are in); voice threads are read-only at \
                  /v1/context/threads/voice/<id>",
    }))
    .into_response()
}

/// Query for `GET /v1/code/git`. `ref` is a reserved word, so it's carried as
/// `git_ref` with a serde rename.
#[derive(Deserialize)]
struct CodeGitQ {
    repo: Option<String>,
    op: Option<String>,
    n: Option<u32>,
    #[serde(rename = "ref")]
    git_ref: Option<String>,
    base: Option<String>,
    file: Option<String>,
    stat: Option<String>,
}

/// `GET /v1/code/projects` — the browse agent's map of the user's known
/// projects (path, name, is_git, current branch), most-recent first. Read-only.
/// A code review is being requested by a held curl — the frontend opens the
/// review pane on this repo/source and enters "submit answers the agent" mode.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ReviewRequestedEvent {
    review_id: String,
    repo_path: String,
    source: String,
    round: i64,
}

/// A held review curl ended (answered, dismissed, capped, or cancelled).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ReviewReleasedEvent {
    review_id: String,
}

#[derive(Deserialize)]
struct ReviewStartQ {
    repo: Option<String>,
    source: Option<String>,
    base: Option<String>,
    sha: Option<String>,
}

/// Server-side cap on a held review curl. Deliberately just under Claude
/// Code's 10-minute Bash-tool ceiling (the skill asks for `timeout: 600000`):
/// the agent then receives our calm "still reviewing — re-run when ready"
/// line as the curl's output instead of a Bash timeout error killing the
/// call mid-flight. An abandoned review can also always be Dismissed.
const REVIEW_HOLD_CAP: Duration = Duration::from_secs(9 * 60 + 20);

/// `GET /v1/reviews/start?repo=<path>&source=<tag>[&base=][&sha=]` — the
/// blocking entry of the code-review loop:
/// resolve + parse the diff (empty → answer immediately, never hold); bump
/// the review round and re-anchor prior annotations onto the new diff; bind
/// the review to the dock terminal whose claude sent it; tell the UI to open
/// the pane; then HOLD until `submit_review_feedback` / `dismiss_review`
/// resolves the oneshot (or the cap fires). The resolved string is the curl's
/// stdout — the same session addresses it, exactly like a plan revise.
async fn handle_review_start(
    State(app_state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Query(q): Query<ReviewStartQ>,
) -> axum::response::Response {
    let db = app_state.store.database();
    let repo = q.repo.as_deref().unwrap_or("").trim().to_string();
    if repo.is_empty() {
        return (StatusCode::BAD_REQUEST, "missing ?repo= (pass $PWD)").into_response();
    }
    let source = match review::parse_source_tag(q.source.as_deref().unwrap_or("uncommitted")) {
        Ok(s) => s,
        Err(e) => return (StatusCode::BAD_REQUEST, e).into_response(),
    };
    let base = q.base.as_deref().filter(|s| !s.trim().is_empty());
    let sha = q.sha.as_deref().filter(|s| !s.trim().is_empty());

    // Capture the diff. Empty → answer immediately; never open a blocking
    // review over nothing.
    let (repo_canon, files) = match review::resolve_for_route(&db, &repo, source, base, sha).await
    {
        Ok(pair) => pair,
        Err(e) => return (StatusCode::BAD_REQUEST, e).into_response(),
    };
    if files.is_empty() {
        return (StatusCode::OK, "no changes to review\n").into_response();
    }

    // Continue the repo's review session; a re-run is the next ROUND, and
    // prior annotations re-anchor onto the fresh diff by content.
    let existing = db.latest_code_review_for_repo(&repo_canon);
    let mut session =
        match review::open_or_continue_review(&db, &repo_canon, source, base, sha) {
            Ok(s) => s,
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
        };
    if existing.is_some() {
        session.round += 1;
        if let Err(e) = db.upsert_code_review(&session) {
            return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response();
        }
        match review::carry_annotations_forward(&db, &session.review_id, session.round, &files)
        {
            Ok((carried, orphaned)) => {
                tracing::info!(
                    review_id = %session.review_id,
                    round = session.round,
                    carried,
                    orphaned,
                    "review round advanced; annotations re-anchored"
                );
            }
            Err(e) => tracing::warn!(error = %e, "carry_annotations_forward failed"),
        }
        let _ = app_state
            .app_handle
            .emit("review-annotations-changed", session.review_id.clone());
            extension_host::publish(
                ext_events::REVIEW_ANNOTATIONS_CHANGED,
                &ext_events::ReviewAnnotationsChanged {
                    review_id: session.review_id.clone(),
                    ts_ms: extension_host::now_ms(),
                },
            );
    }

    // Bind the review to the dock terminal whose claude sent this curl (the
    // intercept-strip ancestry walk). Off-runtime: lsof/ps shell-outs block.
    let terminal_id = {
        let pty_state: pty::PtyState = (*app_state.app_handle.state::<pty::PtyState>()).clone();
        let peer_port = peer.port();
        tokio::task::spawn_blocking(move || {
            pty::client_pid_and_terminal_for_port(&pty_state, peer_port).1
        })
        .await
        .ok()
        .flatten()
    };
    if terminal_id.is_some() {
        session.terminal_id = terminal_id;
        let _ = db.upsert_code_review(&session);
    }

    // Open the pane, then hold.
    let event = ReviewRequestedEvent {
        review_id: session.review_id.clone(),
        repo_path: session.repo_path.clone(),
        source: session.source.clone(),
        round: session.round,
    };
    if let Err(e) = app_state.app_handle.emit("review-requested", event) {
        tracing::warn!(error = %e, "failed to emit review-requested");
    }
    extension_host::publish(
        ext_events::REVIEW_STARTED,
        &ext_events::ReviewStarted {
            review_id: session.review_id.clone(),
            repo_path: session.repo_path.clone(),
            source: session.source.clone(),
            round: session.round,
            ts_ms: extension_host::now_ms(),
        },
    );
    // Companion journal: a code review opened (round n).
    let _ = db.append_journal(
        "review_start",
        Some("review"),
        Some(&session.review_id),
        Some(&session.repo_path),
        Some(&format!("round {}", session.round)),
    );

    let (rx, token) = app_state.pending_reviews.register(&session.review_id);
    let _guard = ReviewDetachGuard {
        pending: app_state.pending_reviews.clone(),
        app_handle: app_state.app_handle.clone(),
        review_id: session.review_id.clone(),
        token,
    };
    tracing::info!(
        review_id = %session.review_id,
        round = session.round,
        files = files.len(),
        "review curl held; blocking for reviewer"
    );

    let body = tokio::select! {
        r = rx => match r {
            Ok(text) => text,
            Err(_) => "The review was closed without feedback. Continue with what you were doing.\n".to_string(),
        },
        _ = tokio::time::sleep(REVIEW_HOLD_CAP) => {
            tracing::info!(review_id = %session.review_id, "review hold cap fired");
            format!("{}\n", review_feedback::CAP_EXPIRED_MESSAGE)
        }
    };
    (StatusCode::OK, body).into_response()
}

/// Whether a held review curl is waiting on this review — drives the pane's
/// "Submit sends to the agent" affordance (vs. read-only browsing).
#[tauri::command]
fn review_hold_active(pending: tauri::State<'_, PendingReviews>, review_id: String) -> bool {
    pending.has(&review_id)
}

/// Submit the review: serialize the current annotation set (or the approval
/// line) into the held curl's response. The review analog of `submit_review`.
#[tauri::command]
fn submit_review_feedback(
    app: AppHandle,
    review_state: tauri::State<'_, review::ReviewState>,
    pending: tauri::State<'_, PendingReviews>,
    review_id: String,
    approve: bool,
    approve_message: Option<String>,
) -> Result<(), String> {
    // A push made while THIS curl was held is news the agent needs (the work
    // already landed — don't commit it again); an older push was already
    // reported in an earlier round's reply.
    let held_since = pending.held_since(&review_id);
    let Some(tx) = pending.take(&review_id) else {
        return Err(
            "no agent is waiting on this review — run /redline-code-review in the \
             terminal first"
                .to_string(),
        );
    };
    let push = review_state
        .db
        .latest_push_for_review(&review_id)
        .filter(|p| held_since.is_some_and(|t| p.created_at >= t));
    let payload = if approve {
        let msg = approve_message
            .filter(|m| !m.trim().is_empty())
            .unwrap_or_else(|| review_feedback::DEFAULT_APPROVE_MESSAGE.to_string());
        // Approve + push is the natural "ship it" — the approval line carries
        // the same machine-validated block the feedback payload would.
        match &push {
            Some(p) => format!("{msg}\n\n{}", review_feedback::pushed_block(p)),
            None => format!("{msg}\n"),
        }
    } else {
        let session = review_state
            .db
            .get_code_review(&review_id)
            .ok_or_else(|| format!("no review {review_id}"))?;
        let annotations = review_state
            .db
            .list_review_annotations(&review_id)
            .map_err(|e| e.to_string())?;
        let text = review_feedback::serialize_review_payload(
            &session.repo_path,
            session.round,
            &annotations,
            push.as_ref(),
        );
        // Everything serialized is now on the agent's desk.
        for mut a in annotations {
            if a.status == "draft" || a.status == "carried" {
                a.status = "submitted".to_string();
                let _ = review_state.db.update_review_annotation(&a);
            }
        }
        let _ = app.emit("review-annotations-changed", review_id.clone());
        extension_host::publish(
            ext_events::REVIEW_ANNOTATIONS_CHANGED,
            &ext_events::ReviewAnnotationsChanged {
                review_id: review_id.clone(),
                ts_ms: extension_host::now_ms(),
            },
        );
        text
    };
    tracing::info!(review_id = %review_id, approve, "submit_review_feedback fired");
    tx.send(payload).map_err(|_| {
        // The curl died between `pending.take` and this send: the reviewer's
        // whole round — every annotation and the verdict — went nowhere, and
        // they find out from an error toast. Worth counting: it is the shape
        // of a review that "succeeded" and delivered nothing.
        db::note_friction(
            "review_submit_lost",
            Some("review"),
            Some(&review_id),
            Some(if approve { "approve" } else { "feedback" }),
        );
        "the review curl is no longer listening — re-run /redline-code-review".to_string()
    })
}

/// Dismiss hatch: unblock a held review the reviewer walked away from, with a
/// benign no-feedback reply. The pane stays open for later browsing.
#[tauri::command]
fn dismiss_review(
    pending: tauri::State<'_, PendingReviews>,
    review_id: String,
) -> Result<(), String> {
    let tx = pending
        .take(&review_id)
        .ok_or("no agent is waiting on this review")?;
    tracing::info!(review_id = %review_id, "review dismissed");
    tx.send(format!("{}\n", review_feedback::DISMISS_MESSAGE))
        .map_err(|_| "the review curl is no longer listening".to_string())
}

// --- external annotations API (`/v1/reviews/annotations`) -------------------
//
// Lets local tools (linters, scripts, other agents) read and post findings
// into a live review. Security posture: loopback-only bind + the known-projects
// allowlist + schema-only body validation + a required per-tool `source` tag
// (`user`/`ai` reserved). No session auto-creation: 404 without an existing
// review. Findings ingest through `review::ingest_annotation`, so a matched
// quote re-anchors across rounds exactly like a hand-placed annotation.

#[derive(serde::Deserialize)]
struct ExtAnnQ {
    repo: Option<String>,
    review: Option<String>,
    source: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExtAnnBody {
    #[serde(default)]
    file_path: Option<String>,
    #[serde(default)]
    side: Option<String>,
    #[serde(default)]
    quoted: Option<String>,
    #[serde(default)]
    line_hint: Option<i64>,
    body: String,
    #[serde(default)]
    suggestion: Option<String>,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    blocking: Option<String>,
    #[serde(default)]
    source: Option<String>,
}

/// Per-tool source tag: short, lowercase, and never the reserved authors.
fn valid_source_tag(s: &str) -> bool {
    (1..=32).contains(&s.len())
        && s != "user"
        && s != "ai"
        && s
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

/// Resolve `?repo=` (+ optional `?review=`) to an existing review session.
async fn resolve_review_for_api(
    db: &db::Database,
    repo: Option<&str>,
    review: Option<&str>,
) -> Result<state::CodeReviewSession, String> {
    let repo = repo.map(str::trim).filter(|s| !s.is_empty()).ok_or("missing ?repo=")?;
    if !code::is_known_project(db, repo) {
        return Err(format!("`{repo}` is not one of your known projects"));
    }
    // Sessions key on the canonical path (see review_open).
    let canon = std::fs::canonicalize(repo)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| repo.to_string());
    let session = match review.map(str::trim).filter(|s| !s.is_empty()) {
        Some(id) => db.get_code_review(id).filter(|s| s.repo_path == canon),
        None => db.latest_code_review_for_repo(&canon),
    };
    session.ok_or_else(|| {
        "no review session for this repo — open one in Redline (or run \
         /redline-code-review) first"
            .to_string()
    })
}

/// `GET /v1/reviews/annotations?repo=<path>[&review=<id>]`
async fn handle_review_annotations_list(
    State(app_state): State<AppState>,
    Query(q): Query<ExtAnnQ>,
) -> axum::response::Response {
    let db = app_state.store.database();
    let session = match resolve_review_for_api(&db, q.repo.as_deref(), q.review.as_deref()).await
    {
        Ok(s) => s,
        Err(e) => return browser_error_response(e),
    };
    match db.list_review_annotations(&session.review_id) {
        Ok(annotations) => Json(serde_json::json!({
            "reviewId": session.review_id,
            "round": session.round,
            "annotations": annotations,
        }))
        .into_response(),
        Err(e) => browser_error_response(e.to_string()),
    }
}

/// `POST /v1/reviews/annotations?repo=<path>[&review=<id>]` — one finding.
async fn handle_review_annotations_add(
    State(app_state): State<AppState>,
    Query(q): Query<ExtAnnQ>,
    Json(body): Json<ExtAnnBody>,
) -> axum::response::Response {
    let db = app_state.store.database();
    let session = match resolve_review_for_api(&db, q.repo.as_deref(), q.review.as_deref()).await
    {
        Ok(s) => s,
        Err(e) => return browser_error_response(e),
    };
    let source = body.source.as_deref().unwrap_or("external");
    if !valid_source_tag(source) {
        return browser_error_response(
            "invalid source tag (1-32 chars of [a-z0-9_-]; `user`/`ai` reserved)".to_string(),
        );
    }
    if body.body.trim().is_empty() || body.body.len() > 20_000 {
        return browser_error_response("body must be 1..20000 chars".to_string());
    }
    if let Some(side) = body.side.as_deref() {
        if side != "old" && side != "new" {
            return browser_error_response("side must be `old` or `new`".to_string());
        }
    }
    // Resolve the review's CURRENT diff so quote placement matches the pane.
    let source_tag = match review::parse_source_tag(&session.source) {
        Ok(s) => s,
        Err(e) => return browser_error_response(e),
    };
    let diff = match review::resolve_for_route(
        &db,
        &session.repo_path,
        source_tag,
        session.base_ref.as_deref(),
        session.commit_sha.as_deref(),
    )
    .await
    {
        Ok((_, d)) => d,
        Err(e) => return browser_error_response(e),
    };
    let finding = review::IncomingFinding {
        file: body.file_path,
        side: body.side,
        quoted: body.quoted,
        line_hint: body.line_hint,
        body: body.body,
        suggestion: body.suggestion,
        label: body.label,
        blocking: body.blocking,
    };
    match review::ingest_annotation(&db, &session, &diff, finding, "ext", source) {
        Ok(annotation) => {
            let _ = app_state
                .app_handle
                .emit("review-annotations-changed", session.review_id.clone());
                extension_host::publish(
                    ext_events::REVIEW_ANNOTATIONS_CHANGED,
                    &ext_events::ReviewAnnotationsChanged {
                        review_id: session.review_id.clone(),
                        ts_ms: extension_host::now_ms(),
                    },
                );
            Json(serde_json::json!({ "ok": true, "annotation": annotation })).into_response()
        }
        Err(e) => browser_error_response(e),
    }
}

/// `DELETE /v1/reviews/annotations?repo=<path>&source=<tag>` — clear one
/// source's draft findings (`user` refused; submitted history stays).
async fn handle_review_annotations_clear(
    State(app_state): State<AppState>,
    Query(q): Query<ExtAnnQ>,
) -> axum::response::Response {
    let db = app_state.store.database();
    let session = match resolve_review_for_api(&db, q.repo.as_deref(), q.review.as_deref()).await
    {
        Ok(s) => s,
        Err(e) => return browser_error_response(e),
    };
    let Some(source) = q.source.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
        return browser_error_response("missing ?source=".to_string());
    };
    if source == "user" {
        return browser_error_response(
            "refusing to bulk-clear the reviewer's own annotations".to_string(),
        );
    }
    match db.clear_review_annotations_by_source(&session.review_id, source) {
        Ok(n) => {
            if n > 0 {
                let _ = app_state
                    .app_handle
                    .emit("review-annotations-changed", session.review_id.clone());
                    extension_host::publish(
                        ext_events::REVIEW_ANNOTATIONS_CHANGED,
                        &ext_events::ReviewAnnotationsChanged {
                            review_id: session.review_id.clone(),
                            ts_ms: extension_host::now_ms(),
                        },
                    );
            }
            Json(serde_json::json!({ "ok": true, "cleared": n })).into_response()
        }
        Err(e) => browser_error_response(e.to_string()),
    }
}

#[derive(Deserialize)]
struct CodeMapQuery { repo: String }
async fn handle_code_map(State(app_state): State<AppState>, Query(query): Query<CodeMapQuery>) -> axum::response::Response {
    let db = app_state.store.database();
    match tokio::task::spawn_blocking(move || code::known_project_map(&db, &query.repo)).await {
        Ok(Ok(output)) => Json(serde_json::json!({ "ok": true, "output": output })).into_response(),
        Ok(Err(error)) => browser_error_response(error),
        Err(error) => browser_error_response(error.to_string()),
    }
}

async fn handle_code_projects(State(app_state): State<AppState>) -> axum::response::Response {
    let db = app_state.store.database();
    let projects = code::list_projects(&db).await;
    Json(serde_json::json!({ "projects": projects })).into_response()
}

/// `GET /v1/code/git?repo=<path>&op=<status|branch|log|diff|show>&n=&ref=&base=&file=&stat=`
/// — run a whitelisted read-only git op in one of the user's known projects.
/// `repo` is validated against the known-projects allowlist and the op against a
/// fixed whitelist (see `code::run_git`); nothing here writes.
async fn handle_code_git(
    State(app_state): State<AppState>,
    Query(q): Query<CodeGitQ>,
) -> axum::response::Response {
    let db = app_state.store.database();
    let stat = matches!(q.stat.as_deref(), Some("1") | Some("true"));
    let req = code::GitRequest {
        repo: q.repo.as_deref().unwrap_or("").trim(),
        op: q.op.as_deref().unwrap_or("").trim(),
        n: q.n,
        git_ref: q.git_ref.as_deref().filter(|s| !s.trim().is_empty()),
        base: q.base.as_deref().filter(|s| !s.trim().is_empty()),
        file: q.file.as_deref().filter(|s| !s.trim().is_empty()),
        stat,
    };
    match code::run_git(&db, req).await {
        Ok(output) => Json(serde_json::json!({ "ok": true, "output": output })).into_response(),
        Err(e) => browser_error_response(e),
    }
}

// --- ClassMemory (Phase 2) -------------------------------------------------
// The routes (`/v1/memory/*` and the lake's `/v1/context/*` reads) are
// `polis_server::routes` since Session A6 of the Polis extraction; what stays
// here is the Tauri command's node-view helper.

/// Ids of `root` and everything beneath it.

/// A link with a resolved display label + supersession status.

/// Node-view assembly for the Tauri command (the curl-bridge route is
/// `polis_server`'s, over the same facade view) — one shape
/// (`{node, children, links, observations}`) so the retrieval agents and the
/// pane can never drift. `Ok(None)` = no such node.
fn build_node_view(
    db: &crate::db::Database,
    id: &str,
) -> Result<Option<serde_json::Value>, String> {
    // The view is the facade's (`polis_memory::retrieval::node_view`, the
    // same `NodeView` the MCP tools serve); the command's JSON shape is its
    // serialization.
    polis_memory::retrieval::node_view(&polis_host::polis_for(db), id)
        .map(|v| v.map(|n| serde_json::to_value(n).unwrap_or(serde_json::Value::Null)))
        .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct ContextOverviewQ {
    /// Optional cap on the ranked lists (in-review, bulging). Clamped 1..=50.
    limit: Option<i64>,
}

/// `GET /v1/context/overview?limit=` — the Librarian's friction digest as JSON:
/// lake backlog, held structural proposals, stalled in-review sessions, bulging
/// branches, missions, source-trust coverage. Ground truth (never inferred),
/// internally bounded. Consumed by the Librarian (baked into its prompt via
/// `librarian.rs`, re-readable here) and the Phase-4 external MCP surface.
async fn handle_context_overview(
    State(app_state): State<AppState>,
    Query(q): Query<ContextOverviewQ>,
) -> axum::response::Response {
    let db = app_state.store.database();
    let limit = context::clamp_limit(q.limit);
    let digest = context::build_digest(&db, limit);
    Json(digest).into_response()
}

/// `GET /v1/context/sessions/:id/history` — one plan session's revision digests,
/// comment threads, and decision/curation ledger events. Read-only.
async fn handle_context_session_history(
    State(app_state): State<AppState>,
    Path(id): Path<String>,
) -> axum::response::Response {
    let db = app_state.store.database();
    match context::build_session_history(&db, &id) {
        Ok(Some(h)) => Json(h).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, "no such session").into_response(),
        Err(error) => {
            tracing::error!(%error, session_id = %id, "could not read session history");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("could not read session history: {error}"),
            )
                .into_response()
        }
    }
}

/// `GET /v1/surface/active` — where the user is in the app right now, mirrored
/// from the frontend. Read by the Companion mid-conversation. Read-only.
async fn handle_surface_active(State(app_state): State<AppState>) -> axum::response::Response {
    Json(app_state.active_surface.get()).into_response()
}

#[derive(Deserialize)]
struct JournalRecentQ {
    since_seq: Option<i64>,
    limit: Option<i64>,
}

/// `GET /v1/journal/recent?since_seq=&limit=` — the context-journal delta (what
/// the user did across surfaces), oldest-first. The Companion's mid-conversation
/// re-read of its "while you were away" feed. Read-only.
async fn handle_journal_recent(
    State(app_state): State<AppState>,
    Query(q): Query<JournalRecentQ>,
) -> axum::response::Response {
    let db = app_state.store.database();
    let limit = q.limit.unwrap_or(200).clamp(1, 500);
    match db.list_journal_since(q.since_seq.unwrap_or(0), limit) {
        Ok(rows) => {
            let head = db.journal_head().unwrap_or(0);
            Json(serde_json::json!({ "items": rows, "head": head })).into_response()
        }
        Err(e) => browser_error_response(e.to_string()),
    }
}

/// `POST /v1/browser/focus?tab=<id>` — switch the user INTO an existing tab:
/// bring it to the foreground AND move the discussion pane into its conversation
/// (a full switch, exactly like the user clicking that tab — distinct from the
/// anchored `/open`). The frontend owns the tab list, so this signals it via the
/// `browse-focus-tab` event, then waits for the tab to actually become active.
async fn handle_browser_focus(
    State(app_state): State<AppState>,
    Query(sel): Query<TabSel>,
) -> axum::response::Response {
    let Some(selector) = sel.tab.map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
    else {
        return browser_error_response("focus needs a ?tab=<number> (see /v1/browser/tabs)");
    };
    // Resolve via the registry (not just live webviews) so "focus tab 2" works
    // even when tab 2 is suspended — the frontend wakes it on the focus event.
    let label = match resolve_label_any(&app_state, Some(selector)) {
        Ok(l) => l,
        Err(resp) => return resp,
    };
    let id = label.strip_prefix("browser-").unwrap_or(&label).to_string();
    if let Err(e) = app_state
        .app_handle
        .emit("browse-focus-tab", serde_json::json!({ "id": id }))
    {
        return browser_error_response(format!("could not signal the browser pane: {e}"));
    }
    // Confirm the switch landed (the frontend mirrors the active tab back via
    // browser_set_active). Short budget — it's just a state flip + one IPC.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        if app_state.active_browser.get().as_deref() == Some(label.as_str()) {
            return Json(serde_json::json!({ "ok": true, "label": label, "id": id }))
                .into_response();
        }
        if std::time::Instant::now() >= deadline {
            return browser_error_response("timed out switching to that tab");
        }
        tokio::time::sleep(std::time::Duration::from_millis(60)).await;
    }
}

#[derive(Deserialize)]
struct OpenReq {
    url: String,
}

const LOOPBACK_HOSTS: [&str; 5] = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"];

/// Do these two URLs mean "the same tab"? The Rust half of `sameTabUrl` in
/// `src/lib/browseList.ts`, and it has to agree with it: the frontend now
/// FOCUSES an already-open tab instead of stacking a duplicate, so a request
/// that used to always produce a new active label often produces no label
/// change at all. Without this, `handle_browser_open` would sit out its whole
/// 6s budget and tell the agent a focus that worked had timed out.
///
/// Duplicated rather than shared because the rule is ten lines and the
/// alternative is an IPC round-trip inside a poll loop. Loopback matches on
/// effective port; everything else on normalized origin + path + query.
fn same_tab_url(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let (Ok(ua), Ok(ub)) = (a.parse::<tauri::Url>(), b.parse::<tauri::Url>()) else {
        return false;
    };
    let host = |u: &tauri::Url| u.host_str().unwrap_or("").to_ascii_lowercase();
    // `Url::port_or_known_default` fills in 80/443 for http/https, which is
    // exactly the "effective port" the JS side computes.
    let port = |u: &tauri::Url| u.port_or_known_default();
    let (ha, hb) = (host(&ua), host(&ub));
    let loop_a = LOOPBACK_HOSTS.contains(&ha.as_str());
    let loop_b = LOOPBACK_HOSTS.contains(&hb.as_str());
    if loop_a || loop_b {
        return loop_a && loop_b && port(&ua) == port(&ub);
    }
    if ua.scheme() != ub.scheme() || ha != hb || port(&ua) != port(&ub) {
        return false;
    }
    ua.path().trim_end_matches('/') == ub.path().trim_end_matches('/') && ua.query() == ub.query()
}

/// `POST /v1/browser/open` {url} — open the URL in a NEW tab and foreground it
/// (the frontend owns the tab list, so this signals `BrowserPane` via the
/// `browse-open-tab` event), then wait for that tab's webview to become active
/// and return its label. Unlike `/navigate` (which replaces the current tab),
/// this leaves the user's other tabs open.
async fn handle_browser_open(
    State(app_state): State<AppState>,
    Json(req): Json<OpenReq>,
) -> axum::response::Response {
    let url = req.url.trim().to_string();
    if url.parse::<tauri::Url>().is_err() {
        return browser_error_response(format!("invalid url: {url}"));
    }
    // Remember the current active label so we can detect the *new* tab.
    if let Err(e) = app_state
        .app_handle
        .emit("browse-open-tab", serde_json::json!({ "url": url }))
    {
        return browser_error_response(format!("could not signal the browser pane: {e}"));
    }
    // BrowserPane creates the native webview asynchronously, then activates it
    // (mirroring the label back via browser_set_active). Poll until the active
    // label resolves to a live webview showing what we asked for, or give up
    // (e.g. the tab cap was hit, so openTab no-ops and nothing ever changes).
    //
    // TWO ways to succeed, because `openTab` has two outcomes. A brand-new tab
    // changes the active label. Focusing an ALREADY-OPEN tab (the dedupe) may
    // not change it at all — the requested URL is already the active tab — so
    // the label test alone would report a correct focus as a timeout. The
    // second test asks the tab mirror what the active tab is actually showing.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(6);
    loop {
        if let Some(label) = app_state.active_browser.get() {
            let shows_it = app_state
                .browser_tabs
                .get()
                .iter()
                .any(|t| t.label == label && same_tab_url(&t.url, &url));
            if shows_it && app_state.app_handle.get_webview(&label).is_some() {
                let id = label.strip_prefix("browser-").unwrap_or(&label).to_string();
                return Json(
                    serde_json::json!({ "ok": true, "label": label, "id": id, "url": url }),
                )
                .into_response();
            }
        }
        if std::time::Instant::now() >= deadline {
            return browser_error_response(
                "timed out opening a new tab (the browser may have reached its tab limit)",
            );
        }
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    }
}

// --- Download (browse-agent file save) ------------------------------------
// The browse agent has no Write tool and a headless `curl -o` is auto-denied,
// so it cannot save a file — except through this route, which rides the same
// pre-authorized `curl` allow as the other browse endpoints. Bytes come from a
// fresh server-side `reqwest` fetch (with a real User-Agent — SEC EDGAR and many
// hosts 403 an empty one); a cookie-gated page the server can't see falls back
// to the tab's rendered HTML.

const MAX_DOWNLOAD_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Deserialize)]
struct DownloadReq {
    /// Omit → save the page the user is viewing (the resolved tab's URL).
    #[serde(default)]
    url: Option<String>,
    /// Omit → derive from the URL / Content-Disposition.
    #[serde(default)]
    filename: Option<String>,
    /// Omit → ~/Downloads.
    #[serde(default)]
    dir: Option<String>,
    /// true → native Save As panel instead of a silent ~/Downloads write.
    #[serde(default)]
    dialog: Option<bool>,
    /// "dom" → save the tab's rendered HTML instead of fetching the URL.
    #[serde(default)]
    mode: Option<String>,
}

enum FetchErr {
    Status(u16),
    TooLarge,
    Other(String),
}

struct Fetched {
    bytes: Vec<u8>,
    /// Filename from Content-Disposition, when the server supplied one.
    filename: Option<String>,
}

/// Fetch a URL's bytes with a descriptive User-Agent (required — many hosts 403
/// an empty UA), bounded by `MAX_DOWNLOAD_BYTES`. reqwest follows redirects.
async fn fetch_download(url: &str) -> Result<Fetched, FetchErr> {
    let client = reqwest::Client::builder()
        .user_agent("Redline/1.0 (+browser-download)")
        .build()
        .map_err(|e| FetchErr::Other(e.to_string()))?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| FetchErr::Other(e.to_string()))?;
    if !resp.status().is_success() {
        return Err(FetchErr::Status(resp.status().as_u16()));
    }
    if resp.content_length().is_some_and(|len| len > MAX_DOWNLOAD_BYTES) {
        return Err(FetchErr::TooLarge);
    }
    let filename = resp
        .headers()
        .get(reqwest::header::CONTENT_DISPOSITION)
        .and_then(|v| v.to_str().ok())
        .and_then(filename_from_content_disposition);
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| FetchErr::Other(e.to_string()))?;
    if bytes.len() as u64 > MAX_DOWNLOAD_BYTES {
        return Err(FetchErr::TooLarge);
    }
    Ok(Fetched {
        bytes: bytes.to_vec(),
        filename,
    })
}

/// The tab's rendered HTML — the fallback when a fresh fetch can't see a
/// cookie-gated page, or when the caller asks for `mode:"dom"`.
async fn dom_html(app_state: &AppState, label: Option<&str>) -> Result<String, String> {
    let Some(label) = label else {
        return Err("no browser tab to capture the page from".to_string());
    };
    let script = r#"(function(){try{return JSON.stringify(document.documentElement.outerHTML);}catch(e){return JSON.stringify("");}})()"#;
    let raw = daemon_eval(&app_state.app_handle, label, script).await?;
    let html: String = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if html.trim().is_empty() {
        return Err("the page returned no HTML".to_string());
    }
    Ok(html)
}

async fn handle_browser_download(
    State(app_state): State<AppState>,
    Query(sel): Query<TabSel>,
    Json(req): Json<DownloadReq>,
) -> axum::response::Response {
    let has_url = req
        .url
        .as_deref()
        .map(str::trim)
        .is_some_and(|u| !u.is_empty());

    // Resolve the tab once (for the default URL and any DOM capture). A
    // `url`-only download can still proceed when there is no active tab.
    let label: Option<String> = match resolve_tab_label(&app_state, sel.tab) {
        Ok(l) => Some(l),
        Err(resp) => {
            if has_url {
                None
            } else {
                return resp;
            }
        }
    };

    // The source URL: explicit `url`, else the resolved tab's current URL.
    let url = match req.url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
        Some(u) => u.to_string(),
        None => match label
            .as_deref()
            .and_then(|l| app_state.app_handle.get_webview(l))
            .and_then(|wv| webview_current_url(&wv))
        {
            Some(u) => u,
            None => return browser_error_response("could not read the tab's current url"),
        },
    };

    let want_dom = req.mode.as_deref() == Some("dom");

    // Gather the bytes: rendered DOM on request, else a fresh fetch with a DOM
    // fallback for pages the server-side client can't reach.
    let (bytes, header_name): (Vec<u8>, Option<String>) = if want_dom {
        match dom_html(&app_state, label.as_deref()).await {
            Ok(html) => (html.into_bytes(), None),
            Err(e) => return browser_error_response(e),
        }
    } else {
        match fetch_download(&url).await {
            Ok(f) => (f.bytes, f.filename),
            Err(FetchErr::Status(code)) => match dom_html(&app_state, label.as_deref()).await {
                Ok(html) => (html.into_bytes(), None),
                Err(_) => return browser_error_response(format!(
                    "the server returned HTTP {code} for that url and there is no page to capture"
                )),
            },
            Err(FetchErr::TooLarge) => {
                return browser_error_response("file is larger than the 100 MB download limit")
            }
            Err(FetchErr::Other(e)) => return browser_error_response(e),
        }
    };

    // Choose the filename: explicit wins, else Content-Disposition, else the URL.
    let raw_name = req
        .filename
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
        .or(header_name)
        .unwrap_or_else(|| download_filename(&url, want_dom));
    let name = sanitize_basename(&raw_name);
    let name = if name.is_empty() {
        "download".to_string()
    } else {
        name
    };

    // Write: a native Save panel, or a silent de-duplicated ~/Downloads write.
    if req.dialog == Some(true) {
        let picked = app_state
            .app_handle
            .dialog()
            .file()
            .set_file_name(&name)
            .blocking_save_file();
        let Some(fp) = picked else {
            return Json(serde_json::json!({ "cancelled": true })).into_response();
        };
        let path = match fp.into_path() {
            Ok(p) => p,
            Err(e) => return browser_error_response(format!("invalid save path: {e}")),
        };
        match std::fs::write(&path, &bytes) {
            Ok(()) => {
                tracing::info!(path = %path.display(), bytes = bytes.len(), "browse download (dialog)");
                download_ok_response(&path, bytes.len())
            }
            Err(e) => browser_error_response(e.to_string()),
        }
    } else {
        let dir = match req.dir.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
            Some(d) => std::path::PathBuf::from(d),
            None => match fsbrowse::home_dir() {
                Some(h) => std::path::Path::new(&h).join("Downloads"),
                None => return browser_error_response("could not resolve your home directory"),
            },
        };
        if let Err(e) = std::fs::create_dir_all(&dir) {
            return browser_error_response(format!("{}: {e}", dir.display()));
        }
        let path = dedup_path(&dir, &name);
        match std::fs::write(&path, &bytes) {
            Ok(()) => {
                tracing::info!(path = %path.display(), bytes = bytes.len(), "browse download");
                download_ok_response(&path, bytes.len())
            }
            Err(e) => browser_error_response(e.to_string()),
        }
    }
}

/// `{ saved, filename, bytes }` — the success shape the agent reports back.
fn download_ok_response(path: &std::path::Path, bytes: usize) -> axum::response::Response {
    Json(serde_json::json!({
        "saved": path.to_string_lossy(),
        "filename": path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        "bytes": bytes,
    }))
    .into_response()
}

/// Pull `filename=` out of a Content-Disposition header, as a safe basename.
fn filename_from_content_disposition(v: &str) -> Option<String> {
    for part in v.split(';') {
        if let Some(rest) = part.trim().strip_prefix("filename=") {
            let name = sanitize_basename(rest.trim().trim_matches('"'));
            if !name.is_empty() {
                return Some(name);
            }
        }
    }
    None
}

/// Derive a filename from a URL: the last path segment (query/fragment dropped),
/// else the host, else a generic fallback. `dom` saves get an `.html` suffix
/// since the bytes are rendered page HTML, not the URL's raw resource.
fn download_filename(url: &str, dom: bool) -> String {
    let path = url.split(['#', '?']).next().unwrap_or(url);
    let last = path.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    let base = sanitize_basename(last);
    let mut name = if base.is_empty() {
        let host = host_of(url);
        if host.is_empty() {
            "download".to_string()
        } else {
            host
        }
    } else {
        base
    };
    if dom {
        let lower = name.to_ascii_lowercase();
        if !lower.ends_with(".html") && !lower.ends_with(".htm") {
            name.push_str(".html");
        }
    }
    name
}

/// The host portion of a URL (no scheme, userinfo, port, or path), as a safe
/// basename — the filename fallback when the URL path has no usable segment.
fn host_of(url: &str) -> String {
    let after_scheme = url.splitn(2, "://").nth(1).unwrap_or(url);
    let authority = after_scheme.split('/').next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let host = host.split(':').next().unwrap_or(host);
    sanitize_basename(host)
}

/// Reduce any string to a safe bare filename: take the final path component,
/// drop separators / `..` / leading dots / control chars, clamp the length.
/// This is the security boundary — the endpoint writes fetched (and therefore
/// attacker-influenceable) bytes, so a derived or supplied name must never
/// escape the target directory.
pub(crate) fn sanitize_basename(input: &str) -> String {
    let last = input.rsplit(['/', '\\']).next().unwrap_or(input);
    let mut out: String = last.chars().filter(|c| !c.is_control()).collect();
    out = out.trim().trim_start_matches('.').trim().to_string();
    if out == ".." {
        return String::new();
    }
    if out.chars().count() > 200 {
        out = out.chars().take(200).collect();
    }
    out.trim().to_string()
}

/// Pick a non-colliding path in `dir` for `name`: `name`, then `name (1).ext`,
/// `name (2).ext`, … so a repeat download never clobbers an existing file.
pub(crate) fn dedup_path(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let chosen = dedup_name(name, |candidate| dir.join(candidate).exists());
    dir.join(chosen)
}

/// The naming logic behind `dedup_path`, split out so it is unit-testable with a
/// stub `exists` predicate (no filesystem needed).
fn dedup_name(name: &str, exists: impl Fn(&str) -> bool) -> String {
    if !exists(name) {
        return name.to_string();
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    let mut n = 1u32;
    loop {
        let candidate = format!("{stem} ({n}){ext}");
        if !exists(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// Mirror the browser pane's active tab into the backend so the `/v1/browser/*`
/// daemon routes know which webview to act on. Called by `BrowserPane` when the
/// active tab changes / the pane opens / closes (`None` = no active tab).
#[tauri::command]
fn browser_set_active(active: tauri::State<'_, ActiveBrowser>, label: Option<String>) {
    active.set(label);
}

/// Mirror the active research mission into the backend so the daemon's
/// `/v1/mission/*` routes can answer the orchestrator agent. Called by
/// `BrowserPane` when the active mission ID changes (`None` = no active
/// mission). ID-driven: the title/goal/status are looked up fresh from the DB
/// here — the frontend used to send them from its `missions` list, which is
/// empty until `mission_list` resolves, so every BrowserPane remount wiped the
/// mirror for a tick and mission-blind browse/linked agents spawned in that
/// window. The pins are loaded from the DB on demand, so only the mission's
/// identity needs mirroring.
///
/// In arrival order off the main thread (`IN_ORDER_COMMANDS`): it reads the
/// mission row, and BrowserPane fires it on every mount, so it is on the
/// path of every switch to the browser.
#[tauri::command]
fn mission_set_active(
    active: tauri::State<'_, ActiveMission>,
    store: tauri::State<'_, SessionStore>,
    mission_id: Option<String>,
) {
    let prev = active.active_id();
    let Some(id) = mission_id.filter(|id| !id.trim().is_empty()) else {
        active.set(None);
        return;
    };
    match store.database().get_mission(&id) {
        Ok(Some(m)) => {
            // Companion journal: a mission became active (identity change only
            // — re-pushes of the same id stay quiet).
            if prev.as_deref() != Some(id.as_str()) {
                store.database().enqueue_journal(
                    "mission_active",
                    Some("browser"),
                    Some(&id),
                    Some(&m.title),
                    None,
                );
            }
            active.set(Some(ActiveMissionInfo {
                mission_id: id,
                title: m.title,
                goal: m.goal,
                status: m.status,
            }));
        }
        Ok(None) => {
            eprintln!("[mission] set_active: unknown mission id {id}; clearing mirror");
            active.set(None);
        }
        Err(e) => {
            // Transient DB error: keep whatever the mirror held rather than
            // blinding a possibly-fine active mission.
            eprintln!("[mission] set_active: lookup failed for {id}: {e}");
        }
    }
}

/// Mirror the browser pane's full tab list into the backend so the daemon's
/// `/v1/browser/tabs` registry and cross-tab routes can resolve a tab selector
/// to a webview label / discussion `browse_id`. Called by `BrowserPane`
/// whenever the tab list changes (open/close/navigate/title update).
#[tauri::command]
fn browser_set_tabs(
    tabs: tauri::State<'_, BrowserTabs>,
    cache: tauri::State<'_, SnapshotCache>,
    list: Vec<TabInfo>,
) {
    // Prune snapshots for tabs that no longer exist before mirroring the list.
    let keep: std::collections::HashSet<String> = list.iter().map(|t| t.label.clone()).collect();
    cache.retain(&keep);
    tabs.set(list);
}

/// Capture the active-tab-style DOM snapshot of a specific browser tab, for the
/// browse agent's first-turn grounding. Returns the raw JSON string from
/// `SNAPSHOT_JS`. macOS-only (the underlying eval is).
#[tauri::command(async)]
async fn browser_snapshot(app: AppHandle, label: String) -> Result<String, String> {
    if app.state::<BrowserTabs>().get().iter().any(|tab| tab.label == label && tab.url == "redline:newtab") { return Ok(serde_json::json!({"url":"redline:newtab","title":"New tab","text":"Redline new tab home"}).to_string()); }
    daemon_eval(&app, &label, SNAPSHOT_JS).await
}

/// Capture a tab's DOM snapshot from the live page and store it in the backend
/// `SnapshotCache`, so the browse agent can read / discuss the tab later even
/// when its webview is suspended or gone. Called by `BrowserPane` on navigation
/// and just before a tab is backgrounded. Requires the webview to be live (it
/// evals the page); a missing webview is a soft no-op.
#[tauri::command(async)]
async fn browser_cache_snapshot(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    label: String,
    // `on_screen`: whether the webview is actually visible. The frontend
    // already computes this (`BrowserPane.tsx`), and the backend cannot —
    // WebKit snapshots a hidden view as a blank frame and reports success.
    // Absent (an older caller) means "don't capture", which fails safe.
    on_screen: Option<bool>,
    mission_id: Option<String>,
) -> Result<(), String> {
    if app.get_webview(&label).is_none() {
        return Ok(());
    }
    let json = daemon_eval(&app, &label, SNAPSHOT_JS).await?;
    let url = app
        .get_webview(&label)
        .and_then(|wv| webview_current_url(&wv))
        .unwrap_or_default();

    // ONE policy gates the text row and the picture together. A denylist that
    // suppressed the screenshot while `browse_events.text` kept the full DOM in
    // plaintext SQLite would be privacy theatre — the words are the sensitive
    // part and the pixels are a redundant copy of them. So this returns before
    // anything is recorded, not merely before the capture.
    {
        let db = store.database();
        let denylist = db.get_setting(shots::SETTING_SHOT_DENYLIST).unwrap_or_default();
        if !shots::capture_allowed(&denylist, &url) {
            return Ok(());
        }
    }

    // Dojo P2 — record this page as a browsing event in the lake (best-effort).
    // The normalized on-screen content + a content hash feed the "Browsing
    // Behavior" column; `record_browse_event` dedups a consecutive re-capture.
    if let Some((title, text)) = normalized_browse_text(&json, &url) {
        if !url.trim().is_empty() {
            let browse_id = app
                .state::<BrowserTabs>()
                .get()
                .into_iter()
                .find(|t| t.label == label)
                .map(|t| t.browse_id);
            let db = store.database();
            // The content hash IS the shot key's basis, so it is computed here
            // the same way `record_browse_event` computes it — content
            // addressing is what makes the 829 → 665 dedupe free and makes
            // "forget this picture" mean it in every tab that saw the page.
            let context_hash = ledger::body_hash(&text);
            let capture_mission = mission_id.as_deref().filter(|mission| {
                mission_context::capture_admission(
                    &db,
                    mission,
                    label.strip_prefix("browser-").unwrap_or(&label),
                    &url,
                )
                .is_ok()
            });
            let mission_text = capture_mission.map(|_| text.clone());
            match ledger::record_browse_event(
                &db,
                ledger::BrowseEventInput {
                    action: ledger::BrowseAction::Navigate,
                    browse_id,
                    url: url.clone(),
                    title: (!title.is_empty()).then(|| title.clone()),
                    text,
                    from_event_id: None,
                    author: None, // the human's own browsing
                },
            ) {
                Ok(Some(_)) => {
                    // The picture, taken in the SAME command that recorded the
                    // row: there is never a window where the row exists without
                    // its shot, and `looks_blank`'s existing retry still guards
                    // the too-early frame. Best-effort throughout — a page
                    // recorded without a picture is a normal state (NULL
                    // `shot_key`), a picture without a page is not.
                    if on_screen.unwrap_or(false)
                        && db
                            .get_setting(shots::SETTING_SHOTS_ENABLED)
                            .map(|v| v != "false")
                            .unwrap_or(true)
                    {
                        let key = shots::page_key(&context_hash);
                        match thumbs::capture_shot(&app, &label, shots::SHOT_WIDTH).await {
                            Ok(bytes) => match shots::write_shot(&app, &key, &bytes) {
                                Ok(_) => {
                                    if let (Some(mission_id), Some(page_text)) =
                                        (capture_mission, mission_text.as_ref())
                                    {
                                        let db = db.clone();
                                        let mission_id = mission_id.to_owned();
                                        let tab_id = label
                                            .strip_prefix("browser-")
                                            .unwrap_or(&label)
                                            .to_owned();
                                        let url = url.clone();
                                        let key = key.clone();
                                        let bytes = bytes.clone();
                                        let page_text = page_text.clone();
                                        let revision = serde_json::from_str::<Value>(&json).ok()
                                            .and_then(|snapshot| snapshot["revision"].as_str().map(str::to_owned));
                                        mission_capture::start_segment(app.clone(), db, mission_capture::SegmentSeed {
                                            mission_id, tab_id, label: label.clone(), url, key, bytes, page_text, revision,
                                        });
                                    }
                                    if let Err(e) = db.set_shot_key_for_hash(&context_hash, &key) {
                                        tracing::warn!(error = %e, "failed to bind a shot key");
                                    }
                                }
                                Err(e) => tracing::warn!(error = %e, "failed to write a page shot"),
                            },
                            Err(e) => tracing::debug!(error = %e, "no page shot for this capture"),
                        }
                    }
                    // Companion journal: a page the user landed on (url+title
                    // only — the content stays in the lake, not the journal).
                    let _ = db.append_journal(
                        "nav",
                        Some("browser"),
                        None,
                        (!title.is_empty()).then_some(title.as_str()),
                        Some(&url),
                    );
                    let _ = app.emit("ledger-changed", ());
                    extension_host::publish(
                        ext_events::LEDGER_CHANGED,
                        &ext_events::LedgerChanged {
                            ts_ms: extension_host::now_ms(),
                        },
                    );
                    let _ = app.emit("memory-changed", ());
                }
                Ok(None) => {} // consecutive duplicate — nothing recorded
                Err(e) => tracing::warn!(error = %e, "failed to record browse event"),
            }
        }
    }

    app.state::<SnapshotCache>().put(
        label,
        CachedSnapshot {
            json,
            url,
            captured_at: now_millis(),
            scroll: None,
        },
    );
    Ok(())
}

/// Build the normalized browsing text from a `SNAPSHOT_JS` JSON blob: the page
/// title, url, its `h1..h3` headings, and the body innerText, joined into one
/// searchable string (hashed to the context hash and retained for P3 retrieval).
/// Returns `(title, normalized_text)`, or `None` if the blob has no usable text.
fn normalized_browse_text(json: &str, url: &str) -> Option<(String, String)> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let title = v.get("title").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
    let body = v.get("text").and_then(|x| x.as_str()).unwrap_or("").trim();
    let headings = v
        .get("headings")
        .and_then(|x| x.as_array())
        .map(|hs| {
            hs.iter()
                .filter_map(|h| h.get("text").and_then(|t| t.as_str()))
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    if title.is_empty() && body.is_empty() && headings.is_empty() {
        return None;
    }
    let text = format!("{title}\n{url}\n\n{headings}\n\n{body}");
    Some((title, text))
}

/// Take (and clear) a suspended tab's saved scroll offset `[x, y]`, so the
/// frontend can re-apply it once after the woken webview reloads. `None` if the
/// tab wasn't suspended with a saved scroll.
#[tauri::command]
fn browser_consume_scroll(
    cache: tauri::State<'_, SnapshotCache>,
    label: String,
) -> Option<(f64, f64)> {
    cache.take_scroll(&label)
}

/// The cached DOM-snapshot JSON for a tab, if any — lets the discussion pane
/// ground a first turn from the cache when the tab's webview isn't live (instead
/// of failing the live capture).
#[tauri::command]
fn browser_cached_snapshot(
    cache: tauri::State<'_, SnapshotCache>,
    label: String,
) -> Option<String> {
    cache.get(&label).map(|s| s.json)
}

/// Whether a background tab may be suspended (its webview destroyed to reclaim
/// memory). False if the tab is the active one, has a browse turn streaming or
/// targeting it, or is playing media — so we never cut off what the user is
/// watching or an in-flight agent reply. The frontend calls this before
/// evicting an LRU tab.
#[tauri::command(async)]
async fn browser_can_suspend(app: AppHandle, label: String) -> Result<bool, String> {
    if browser_workspace::protected(&label) {
        return Ok(false);
    }
    if browser_actions::is_busy(&label) {
        return Ok(false);
    }
    // The active tab is never suspended.
    if app.state::<ActiveBrowser>().get().as_deref() == Some(label.as_str()) {
        return Ok(false);
    }
    // A tab with a streaming browse turn stays live until it finishes.
    let browse_id = app
        .state::<BrowserTabs>()
        .get()
        .into_iter()
        .find(|t| t.label == label)
        .map(|t| t.browse_id);
    if let Some(bid) = browse_id {
        if app.state::<browse::BrowseState>().is_running(&bid) {
            return Ok(false);
        }
    }
    // So does a tab a running turn was sent against: a shared chat's turn
    // runs on a thread no tab owns (BC-31).
    if app.state::<browse::BrowseState>().is_targeted(&label) {
        return Ok(false);
    }
    // A tab showing a PDF or a non-http document (blob:, data:, file:) can't
    // be rebuilt from a snapshot + URL, so it stays live like a pinned tab.
    if let Some(wv) = app.get_webview(&label) {
        if webview_current_url(&wv).is_some_and(|url| suspend_exempt_url(&url)) {
            return Ok(false);
        }
    }
    // A tab actively playing audio/video, mid-edit, or showing a PDF stays live.
    if app.get_webview(&label).is_some() {
        let probe = "(function(){try{return document.contentType==='application/pdf'||(document.activeElement&&document.activeElement.matches('input,textarea,[contenteditable]'))||[].slice.call(document.querySelectorAll('video,audio')).some(function(m){return !m.paused && !m.ended && m.currentTime>0;})?\"1\":\"0\";}catch(e){return \"0\";}})()";
        if let Ok(r) = daemon_eval(&app, &label, probe).await {
            if r == "1" {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

/// Whether a tab's address alone rules out suspension: a document that only
/// lives in this webview (blob:, data:, file:, …) or an http(s) `.pdf`.
fn suspend_exempt_url(url: &str) -> bool {
    match tauri::Url::parse(url) {
        Ok(u) if matches!(u.scheme(), "http" | "https") => u.path().to_ascii_lowercase().ends_with(".pdf"),
        Ok(u) => u.as_str() != "about:blank",
        Err(_) => false,
    }
}

/// Suspend a background tab: capture a fresh snapshot + scroll offset into the
/// `SnapshotCache`, then stop media and destroy the webview to reclaim its
/// WebContent process. The tab descriptor stays in the registry, so the tab is
/// still listed and discussable (served from the cache); a later action wakes it
/// (Phase 3). A missing webview is a soft no-op.
#[tauri::command(async)]
async fn browser_suspend(app: AppHandle, label: String) -> Result<(), String> {
    if app.get_webview(&label).is_none() {
        return Ok(());
    }
    // Snapshot the page and capture scroll BEFORE tearing the webview down.
    let json = daemon_eval(&app, &label, SNAPSHOT_JS).await?;
    let url = app
        .get_webview(&label)
        .and_then(|wv| webview_current_url(&wv))
        .unwrap_or_default();
    let scroll = daemon_eval(
        &app,
        &label,
        "(function(){try{return JSON.stringify([window.scrollX||0,window.scrollY||0]);}catch(e){return \"[0,0]\";}})()",
    )
    .await
    .ok()
    .and_then(|s| serde_json::from_str::<(f64, f64)>(&s).ok());
    app.state::<SnapshotCache>().put(
        label.clone(),
        CachedSnapshot {
            json,
            url,
            captured_at: now_millis(),
            scroll,
        },
    );
    // Stop in-page media, then destroy the webview (same teardown as a close).
    if browser_workspace::protected(&label) { return Err("Page became visible while suspending".into()); }
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.eval(STOP_MEDIA_JS);
        wv.close().map_err(|e| e.to_string())?;
        let _ = app.emit("browser-tab-suspended", serde_json::json!({ "label": label }));
    }
    Ok(())
}

/// "starting" | "ready" | "failed". The launch boundary polls this: shell
/// rendering never waits for the daemon, but starting a harness into a window
/// that owns no port would send the resulting plan to a different instance —
/// so ⏎ waits for a real answer rather than proceeding on the optimistic
/// default the boolean had to carry.
#[tauri::command]
fn daemon_state(daemon_status: tauri::State<'_, DaemonStatus>) -> String {
    daemon_status.state().as_str().to_string()
}

/// Everything the shell needs to render its first actionable frame, in one
/// consistent snapshot.
///
/// This exists because the boot effect used to fire eight separate `invoke`s
/// and `Promise.all` the lot — session list, interception mode, daemon status,
/// workspace manifest, harness flavor, harness list, *and* four integration
/// probes that can each spawn a child process. The shell was therefore no
/// faster than the slowest **probe**, and a machine with a slow `codex --help`
/// paid for it in front of the front door.
///
/// The split is by *question*, not by cost: what lands here is what decides
/// **which surface renders and what is on it**. Whether the hook is installed,
/// whether the skill is stale, whether curl is new enough — those decide
/// whether a *launch* will work, which is a question with a later deadline.
/// They live in `preflight_status`, called after the reveal.
///
/// One command rather than six also makes the snapshot *consistent*: the
/// harness list and the workspace manifest are read within one call, so the
/// shell can never compose a frame from a manifest and a harness set that
/// disagree because a file changed between two round trips.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapState {
    /// Session summaries, newest activity first, with the live held-sender
    /// map already folded in — same contract as `list_sessions`.
    sessions: Vec<SessionSummary>,
    /// The one session (if any) that is Claude literally paused mid-run
    /// waiting on a verdict. Boot lands on it instead of the front door.
    held_session_id: Option<String>,
    /// "active" | "ambient" | "paused".
    mode: String,
    /// "starting" | "ready" | "failed". Rendering never waits on this; a
    /// launch does.
    daemon: String,
    /// Raw `~/.redline/workspace.json`, or null. Decides what mounts.
    workspace: Option<String>,
    /// Which harness this BUILD is, if any (A7's boot entry).
    harness_flavor: Option<String>,
    /// Installed harness manifests, raw.
    harnesses: Vec<crate::userconfig::HarnessFileEntry>,
}

/// On the blocking pool (`OFF_MAIN_COMMANDS`) — reads two user-config trees off
/// disk. Nothing here spawns a child process, which is the whole point of the
/// split.
#[tauri::command]
fn bootstrap_state(
    store: tauri::State<'_, SessionStore>,
    pending: tauri::State<'_, PendingResponses>,
    settings: tauri::State<'_, Settings>,
    daemon_status: tauri::State<'_, DaemonStatus>,
) -> BootstrapState {
    let mut sessions = store.list();
    fold_pending_into_summaries(&mut sessions, &pending);
    let held_session_id = held_session_id(&sessions);
    BootstrapState {
        sessions,
        held_session_id,
        mode: settings.get().as_str().to_string(),
        daemon: daemon_status.state().as_str().to_string(),
        workspace: userconfig::get_workspace(),
        harness_flavor: userconfig::harness_flavor(),
        harnesses: userconfig::list_harnesses(),
    }
}

#[tauri::command]
fn list_sessions(
    store: tauri::State<'_, SessionStore>,
    pending: tauri::State<'_, PendingResponses>,
) -> Vec<SessionSummary> {
    let mut sessions = store.list();
    fold_pending_into_summaries(&mut sessions, &pending);
    sessions
}

#[tauri::command]
fn archive_session(app: AppHandle, store: tauri::State<'_, SessionStore>, pending: tauri::State<'_, PendingResponses>, session_id: String, archived: bool) -> Result<(), String> {
    if archived && pending.has(&session_id) {
        return Err("This session is waiting for review. Continue or approve it before archiving.".into());
    }
    if !store.database().archive_session(&session_id, archived).map_err(|e| e.to_string())? {
        return Err("Session is missing or still held for review.".into());
    }
    let _ = app.emit("session-status-changed", SessionEvent { session_id });
    Ok(())
}

#[tauri::command]
fn rename_session(app: AppHandle, store: tauri::State<'_, SessionStore>, session_id: String, title: String) -> Result<(), String> {
    let title = title.trim();
    if title.chars().count() > 200 || title.chars().any(char::is_control) {
        return Err("Use a title of at most 200 characters, without control characters.".into());
    }
    if !store.database().rename_session(&session_id, (!title.is_empty()).then_some(title)).map_err(|e| e.to_string())? {
        return Err("Session not found.".into());
    }
    let _ = app.emit("session-status-changed", SessionEvent { session_id });
    Ok(())
}

#[tauri::command]
fn archive_companion(store: tauri::State<'_, SessionStore>, companion_id: String, archived: bool) -> Result<(), String> {
    if !store.database().archive_companion(&companion_id, archived).map_err(|e| e.to_string())? {
        return Err("Conversation not found.".into());
    }
    Ok(())
}

/// Which session boot should land on instead of the front door.
///
/// A HELD session is Claude literally paused mid-run waiting on a verdict;
/// burying it behind a prompt box leaves an agent blocked with nothing on
/// screen saying so. Everything else — including the last plan you happened to
/// read — loses to the door, which is one click from the sidebar anyway.
///
/// Derived from the SAME list the shell will render (after the pending fold,
/// so a live held POST beats a lagging persisted state), which is what
/// guarantees the id it returns is in the list it routes within. The frontend
/// used to compute this itself from a separately-fetched list; one snapshot,
/// one derivation.
fn held_session_id(sessions: &[SessionSummary]) -> Option<String> {
    sessions
        .iter()
        .find(|s| s.attach_state == AttachState::Held)
        .map(|s| s.session_id.clone())
}

/// Step 4 of the interception chain: overlay the live held-sender map onto the
/// persisted summaries. A live sender is ground truth — never let a lagging
/// persisted state show "detached" while a POST is actually held. Factored out
/// of `list_sessions` so the capture→hold→indicator seam is unit-testable.
fn fold_pending_into_summaries(sessions: &mut [SessionSummary], pending: &PendingResponses) {
    for s in sessions.iter_mut() {
        s.held = pending.has(&s.session_id);
        if s.held {
            s.attach_state = AttachState::Held;
            s.held_terminal_id = pending.terminal_of(&s.session_id);
        }
    }
}

/// Session-state side effects of an inbound plan POST, recorded before the
/// `plan-received` event goes out so the listener's summary refresh already
/// observes them: the hold itself, and the return to review. The status
/// reset matters when a prior thread on this terminal session was approved —
/// a stale `Approved` would disable the Approve button for every later
/// thread. It must run AFTER classification: `has_outstanding_review` reads
/// the *old* status to tag a post-approval plan as a fresh thread. Factored
/// out so the invariant is unit-testable without a `tauri::AppHandle`.
fn settle_inbound_plan_state(store: &SessionStore, session_id: &str) {
    store.set_attach_state(session_id, AttachState::Held);
    store.set_status(session_id, SessionStatus::InReview);
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
        // The comments that referenced them are gone; don't leave their files
        // behind in app data.
        fsbrowse::delete_session_attachments(&app, &session_id);
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

/// The rows behind a Combine selection, in the caller's order.
///
/// Deliberately NOT `get_session` per id: that ships every revision plus every
/// comment plus the parsed sections across IPC, all of it discarded here. An
/// unknown id is an error, not a skip — a pill that silently vanished from a
/// combination would change what was merged without saying so.
fn combine_rows(
    store: &SessionStore,
    session_ids: &[String],
) -> Result<Vec<combine::SourceRow>, String> {
    let mut out = Vec::with_capacity(session_ids.len());
    for id in session_ids {
        let s = store
            .get(id)
            .ok_or_else(|| format!("no session found for id {id}"))?;
        let rev = s
            .revisions
            .last()
            .ok_or_else(|| format!("session {id} has no revisions yet"))?;
        let pending_count = s
            .revisions
            .iter()
            .flat_map(|r| r.comments.iter())
            .filter(|c| {
                matches!(
                    c.status,
                    state::CommentStatus::Draft | state::CommentStatus::Reopened
                )
            })
            .count() as u32;
        out.push(combine::SourceRow {
            session_id: s.session_id.clone(),
            project_name: s.project_name.clone(),
            project_path: s.project_path.clone(),
            version_number: rev.version_number,
            status: match s.status {
                SessionStatus::InReview => "in_review",
                SessionStatus::Approved => "approved",
                SessionStatus::Aborted => "aborted",
            }
            .to_string(),
            run_state: s.run_state.clone(),
            pending_count,
            raw_plan_markdown: rev.raw_plan_markdown.clone(),
        });
    }
    Ok(out)
}

/// What the pills show, plus the warnings and the one refusal. Called when the
/// pills are seeded and again whenever one is removed.
#[tauri::command]
fn combine_preview(
    store: tauri::State<'_, SessionStore>,
    session_ids: Vec<String>,
) -> Result<combine::CombinePreview, String> {
    Ok(combine::preview(&combine_rows(&store, &session_ids)?))
}

/// The brief that gets typed and the record that reaches the lake. Called once
/// on ⏎, not at preview time, so the brief reflects any revision that landed
/// in the meantime.
#[tauri::command]
fn combine_brief(
    store: tauri::State<'_, SessionStore>,
    session_ids: Vec<String>,
    instruction: Option<String>,
) -> Result<combine::CombineBrief, String> {
    let rows = combine_rows(&store, &session_ids)?;
    let preview = combine::preview(&rows);
    // The cap is enforced here too, not just in the preview: a revision that
    // landed between the preview and ⏎ could have pushed the selection over,
    // and a refusal is the whole point of the cap.
    if let Some(blocked) = preview.blocked {
        return Err(blocked);
    }
    // The journal is the friction/activity trail Shipwright and the Librarian
    // read — a different question from what the corpus remembers, which is why
    // it rides alongside the lake record rather than instead of it.
    let _ = store.database().append_journal(
        "plan_combine",
        Some("front-door"),
        preview.default_project_path.as_deref(),
        None,
        Some(&format!(
            "{} plans: {}",
            rows.len(),
            rows.iter()
                .map(|r| r.session_id.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )),
    );
    Ok(combine::compose(
        &rows,
        instruction.as_deref().unwrap_or(""),
    ))
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
fn export_revision_markdown(
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

/// Raw material the frontend wraps into an async-share `SnapshotPayload`.
///
/// Beyond the plan body, this now carries a *lean* projection of the plan's
/// depth — a revision timeline, prior discussion, resolved decisions, stats,
/// and a heading-only TOC — so the zero-install browser viewer can show "how
/// much more Redline has" without a server. Every enrichment field is
/// optional/skippable: old links (and links minted with the enrichment toggles
/// off) simply omit them, and old viewers ignore what they don't know.
///
/// Size discipline: the payload rides in a URL `#fragment`, so we ship
/// METADATA, not bodies — the timeline has no prior markdown, the TOC is
/// headings only (never `bodyMarkdown`/`paragraphs`, which would re-serialize
/// the whole plan), and discussion/decision text is truncated + capped.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanSnapshotData {
    /// Sidecar-augmented plan markdown — `rl:blk-` block identity rides along
    /// so the browser viewer's annotations re-anchor by blockId at import.
    markdown: String,
    plan_title: Option<String>,
    project_name: String,
    base_version: u32,

    // ── enrichment (all optional; empty collections are skipped) ──
    #[serde(skip_serializing_if = "Vec::is_empty")]
    revision_timeline: Vec<SnapRevisionMeta>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    discussion: Vec<SnapComment>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    decisions: Vec<SnapDecision>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stats: Option<SnapStats>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    toc: Vec<SnapTocNode>,
}

/// One revision's metadata for the viewer's timeline — no body, just enough to
/// render "vN · when · title" and badge thread-starts.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapRevisionMeta {
    version: u32,
    created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    thread_start: bool,
}

/// A prior comment/discussion thread, reduced + truncated for the viewer.
/// `author` is the HUMAN reviewer name only — the agent `author` id is never
/// forwarded to an external recipient.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapComment {
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    block_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    author: Option<String>,
    body: String,
    resolved: bool,
    created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    resolution: Option<String>,
}

/// A resolved decision, sourced from resolved/accepted comments (the
/// hash-chained ledger carries no human-readable title, so it can't feed this).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapDecision {
    title: String,
    decided_at: i64,
    disposition: &'static str,
}

/// Derived plan stats — small, confident numbers for the viewer's hero strip.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapStats {
    version_count: u32,
    section_count: u32,
    block_count: u32,
    word_count: u32,
    reading_minutes: u32,
}

/// One heading in the pruned table of contents (no body — that's the point).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapTocNode {
    title: String,
    level: u8,
    anchor_id: String,
    block_id: String,
}

// ── enrichment caps: bound the URL-fragment size regardless of plan depth ──
/// Most comments carried into the discussion panel.
const SNAP_MAX_DISCUSSION: usize = 30;
/// Most decisions in the digest.
const SNAP_MAX_DECISIONS: usize = 8;
/// Per-comment body truncation (chars).
const SNAP_BODY_MAX: usize = 280;
/// Per-resolution body truncation (chars).
const SNAP_RESOLUTION_MAX: usize = 200;
/// Revision title truncation (chars).
const SNAP_TITLE_MAX: usize = 80;
/// Reading speed for the reading-time estimate (words per minute).
const SNAP_WORDS_PER_MINUTE: u32 = 200;

/// Char-boundary-safe truncation with an ellipsis when clipped. Counts by
/// `char`, so multi-byte text never splits mid-codepoint.
fn snap_truncate(s: &str, max: usize) -> String {
    let trimmed = s.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// Count non-empty-title sections in a heading tree (matches the TOC's rule).
fn snap_section_count(sections: &[state::Section]) -> u32 {
    let mut n = 0u32;
    for s in sections {
        if !s.title.trim().is_empty() {
            n += 1;
        }
        n += snap_section_count(&s.children);
    }
    n
}

/// Count blocks (heading + paragraph blocks) across a heading tree.
fn snap_block_count(sections: &[state::Section]) -> u32 {
    let mut n = 0u32;
    for s in sections {
        n += 1; // the heading block itself
        n += s.paragraphs.len() as u32;
        n += snap_block_count(&s.children);
    }
    n
}

/// Walk the heading tree into a flat, pruned TOC — headings with real titles
/// only, carrying the stable ids the viewer scrolls by. Never touches bodies.
fn snap_toc(sections: &[state::Section], out: &mut Vec<SnapTocNode>) {
    for s in sections {
        let title = s.title.trim();
        if !title.is_empty() {
            out.push(SnapTocNode {
                title: snap_truncate(title, SNAP_TITLE_MAX),
                level: s.level,
                anchor_id: s.anchor_id.clone(),
                block_id: s.block_id.clone(),
            });
        }
        snap_toc(&s.children, out);
    }
}

/// Build the raw material for an async share snapshot: the plan markdown WITH
/// its `rl:blk-` sidecars intact — unlike `export_revision_markdown`, which
/// strips them for human-facing export. The frontend adds the request id +
/// per-request signing key and AES-encrypts the whole thing into an `RLS1.`
/// token that rides a URL `#fragment` (the plan never reaches a server).
///
/// `include_discussion` / `include_decisions` gate the two sensitive
/// enrichments (prior comment text + resolution rationale) at the source: when
/// off, that data is never even assembled, so it can't leak into the encrypted
/// fragment. The low-sensitivity enrichments (timeline / stats / TOC) always
/// ship — they're titles and counts.
#[tauri::command]
fn build_plan_snapshot(
    store: tauri::State<'_, SessionStore>,
    session_id: String,
    version_number: u32,
    include_discussion: bool,
    include_decisions: bool,
) -> Result<PlanSnapshotData, String> {
    let session = store
        .get(&session_id)
        .ok_or_else(|| format!("no session for id {session_id}"))?;
    let revision = session
        .revisions
        .iter()
        .find(|r| r.version_number == version_number)
        .ok_or_else(|| format!("revision v{version_number} not found"))?;
    // Title from the sidecar-stripped text; the returned markdown keeps the
    // sidecars so viewer annotations anchor by blockId losslessly.
    let clean = parser::strip_sidecar_lines(&revision.raw_plan_markdown);

    // ── revision timeline: metadata for every revision, no bodies ──
    let revision_timeline: Vec<SnapRevisionMeta> = session
        .revisions
        .iter()
        .map(|r| {
            let rc = parser::strip_sidecar_lines(&r.raw_plan_markdown);
            SnapRevisionMeta {
                version: r.version_number,
                created_at: r.received_at,
                title: parser::plan_title_from_markdown(&rc)
                    .map(|t| snap_truncate(&t, SNAP_TITLE_MAX)),
                thread_start: r.thread_start,
            }
        })
        .collect();

    // Comments live per-revision and carry forward; the full discussion across
    // the plan's life is the flattened aggregate (mirrors `Session::list`).
    let all_comments: Vec<&state::Comment> = session
        .revisions
        .iter()
        .flat_map(|r| r.comments.iter())
        .collect();

    // ── discussion: reduced + truncated + capped; human `reviewer` name only ──
    let discussion: Vec<SnapComment> = if include_discussion {
        let mut items: Vec<&state::Comment> = all_comments.clone();
        // Newest first, then cap — the recent thread is the most relevant.
        items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        items
            .into_iter()
            .take(SNAP_MAX_DISCUSSION)
            .map(|c| {
                let resolved = matches!(
                    c.status,
                    state::CommentStatus::Resolved | state::CommentStatus::Accepted
                );
                SnapComment {
                    kind: c.kind.as_str(),
                    block_id: c.block_id.clone(),
                    // `reviewer` is the human attribution; `author` is an agent
                    // id and is deliberately NOT forwarded to a recipient.
                    author: c.reviewer.clone(),
                    body: snap_truncate(&c.body, SNAP_BODY_MAX),
                    resolved,
                    created_at: c.created_at,
                    resolution: c
                        .resolution
                        .as_ref()
                        .map(|r| snap_truncate(&r.body, SNAP_RESOLUTION_MAX)),
                }
            })
            .collect()
    } else {
        Vec::new()
    };

    // ── decisions: resolved/accepted comments (or promoted questions) ──
    let decisions: Vec<SnapDecision> = if include_decisions {
        let mut resolved: Vec<&state::Comment> = all_comments
            .iter()
            .copied()
            .filter(|c| {
                matches!(
                    c.status,
                    state::CommentStatus::Resolved | state::CommentStatus::Accepted
                ) || (matches!(c.kind, state::CommentKind::Question) && c.actionable)
            })
            .collect();
        resolved.sort_by(|a, b| {
            let ak = a.resolution.as_ref().and_then(|r| r.accepted_at).unwrap_or(a.created_at);
            let bk = b.resolution.as_ref().and_then(|r| r.accepted_at).unwrap_or(b.created_at);
            bk.cmp(&ak)
        });
        resolved
            .into_iter()
            .take(SNAP_MAX_DECISIONS)
            .map(|c| SnapDecision {
                title: snap_truncate(&c.body, SNAP_TITLE_MAX),
                decided_at: c
                    .resolution
                    .as_ref()
                    .and_then(|r| r.accepted_at)
                    .unwrap_or(c.created_at),
                disposition: match c.status {
                    state::CommentStatus::Accepted => "accepted",
                    state::CommentStatus::Resolved => "resolved",
                    _ => "decision",
                },
            })
            .collect()
    } else {
        Vec::new()
    };

    // ── stats: derived counts + reading time ──
    let word_count = clean.split_whitespace().count() as u32;
    let stats = Some(SnapStats {
        version_count: session.revisions.len() as u32,
        section_count: snap_section_count(&revision.sections),
        block_count: snap_block_count(&revision.sections),
        word_count,
        reading_minutes: (word_count.div_ceil(SNAP_WORDS_PER_MINUTE)).max(1),
    });

    // ── pruned TOC ──
    let mut toc: Vec<SnapTocNode> = Vec::new();
    snap_toc(&revision.sections, &mut toc);

    Ok(PlanSnapshotData {
        markdown: revision.raw_plan_markdown.clone(),
        plan_title: parser::plan_title_from_markdown(&clean),
        project_name: session.project_name.clone(),
        base_version: revision.version_number,
        revision_timeline,
        discussion,
        decisions,
        stats,
        toc,
    })
}

/// Import a plan delivered as an async-share snapshot (via the `redline://`
/// deep link, decoded client-side) as a normal reviewable session — the
/// recipient gets full native track-changes + discussion, not just the browser
/// preview. This is deliberately NOT `POST /v1/plan`: no Claude process is
/// waiting on a hook, so the plan lands straight in the store through the same
/// `upsert_plan` primitive `handle_plan` uses. The sidecar markdown
/// reconstructs identical `sections`/`blockId`s. Returns the new session id.
#[tauri::command]
fn import_shared_plan(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    markdown: String,
    project_name: Option<String>,
) -> Result<String, String> {
    if markdown.trim().is_empty() {
        return Err("shared plan is empty".into());
    }
    let session_id = format!("shared-{}", uuid::Uuid::new_v4());
    // The last path component becomes the display name; pass the shared
    // project name (or a friendly default) so the session reads sensibly.
    let name = project_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Shared plan");
    let sections = state::reparse_sections(&markdown);
    store.upsert_plan(&session_id, name, markdown, sections, true, false);
    refresh_tray(&app, &store);
    Ok(session_id)
}

/// Save a frontend-built `.docx` export of one plan revision. The bytes are
/// produced by the JS export adapter (the format socket lives in the
/// frontend); this command only resolves the file name from the revision's
/// title, shows the save dialog, and writes. `async` for the same
/// blocking-dialog reason as `export_revision_markdown`.
#[tauri::command]
fn export_revision_docx(
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

const SETTING_OBSIDIAN_VAULT: &str = "redline.obsidianVault";

/// Turn a plan title into a safe Obsidian note filename (no path separators or
/// characters Obsidian/macOS dislike). Keeps it human-readable.
fn obsidian_note_filename(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '#' | '^'
            | '[' | ']' => ' ',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let trimmed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let base = if trimmed.is_empty() {
        "Redline plan".to_string()
    } else {
        trimmed
    };
    format!("{base}.md")
}

/// Save one plan revision as a note in the user's Obsidian vault. The vault
/// folder is asked for once (native folder picker) and remembered in settings;
/// after that a save writes straight into it. Returns the written path, or
/// `None` if the user cancels the first-run folder pick. Same
/// off-the-main-thread `async` reasoning as the export commands (the folder
/// picker blocks).
#[tauri::command]
fn save_revision_to_obsidian(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    session_id: String,
    version_number: u32,
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

    // Resolve the vault: a remembered, still-existing folder, else ask once.
    let remembered = store
        .database()
        .get_setting(SETTING_OBSIDIAN_VAULT)
        .filter(|p| !p.trim().is_empty() && std::path::Path::new(p).is_dir());
    let vault = match remembered {
        Some(p) => std::path::PathBuf::from(p),
        None => {
            let Some(dir) = app.dialog().file().blocking_pick_folder() else {
                return Ok(None); // user cancelled the vault pick
            };
            let path = dir.into_path().map_err(|e| format!("invalid folder: {e}"))?;
            store
                .database()
                .set_setting(SETTING_OBSIDIAN_VAULT, &path.to_string_lossy())
                .map_err(|e| e.to_string())?;
            path
        }
    };

    let name = parser::plan_title_from_markdown(&clean).unwrap_or(project_name);
    let file_path = vault.join(obsidian_note_filename(&name));
    std::fs::write(&file_path, clean).map_err(|e| e.to_string())?;
    tracing::info!(path = %file_path.display(), version = version_number, "saved revision to obsidian vault");
    Ok(Some(file_path.to_string_lossy().to_string()))
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
    pending_feedback: tauri::State<'_, PendingFeedback>,
    expected_modes: tauri::State<'_, ExpectedModes>,
    revise_watch: tauri::State<'_, ReviseWatch>,
    last_claude_pid: tauri::State<'_, LastClaudePid>,
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
    let payload = feedback::serialize_payload(mode, &sections, &comments, &current_plan_markdown);
    let submitted = store.mark_submitted(&session_id);
    tracing::info!(
        session_id = %session_id,
        count = submitted.len(),
        mode = ?mode,
        "submit_review fired",
    );

    // Close the second-revision race: when a new plan POST is in flight but
    // its sender hasn't been registered yet, wait briefly instead of bailing.
    let Some(tx) = pending
        .take_or_wait(&session_id, Duration::from_millis(2000))
        .await
    else {
        // No held POST even after the grace window: the session detached before
        // the reviewer hit submit, and neither the drop-guard nor the startup
        // sweep reconciled it. Roll the submit back (submitted → draft so the
        // feedback isn't stranded) and persist Detached + notify, so the UI
        // shows the detached banner and Restore button instead of a dead
        // in-review screen with no-op buttons.
        store.unmark_submitted(&session_id, &submitted);
        mark_session_detached(&app, &store, &session_id);
        let _ = app.emit(
            "comments-changed",
            SessionEvent {
                session_id: session_id.clone(),
            },
        );
        return Err(detached_delivery_error(&store.backend_of(&session_id)));
    };
    // Ordering invariant: set expected_mode BEFORE unblocking the hook.
    // Claude can't possibly send the next ExitPlanMode POST before this
    // tx.send() returns to the held handle_plan task, so the next
    // handle_plan invocation is guaranteed to see this entry.
    expected_modes.set(&session_id, mode);
    // Build the reason, then stash the payload — both BEFORE the deny is sent,
    // so a follow-up curl can never race ahead of the body being present.
    //
    // What the reason carries depends on the harness (see `feedback_deny_reason`):
    // Claude gets a single calm line plus the `GET …/feedback` URL, because
    // Claude Code renders the deny as a red `Error:` box sized to the reason and
    // keeping the bulk out of it is what turned the old wall into one benign
    // line. Codex gets the payload inline, because its plan session's sandbox
    // has no network and could never make that fetch. Either way the body also
    // reaches the stash, which is what `GET …/feedback` serves.
    let reason = feedback_deny_reason(mode, &session_id, &store.backend_of(&session_id), &payload);
    pending_feedback.set(&session_id, payload);
    // A failed send means the receiver is gone: the held POST already ended
    // (the Claude Code session/terminal closed, or the long hold timed out).
    // Don't pretend it worked. Roll back the submit (restore comments to draft,
    // drop the expected_mode + stashed feedback) and surface a clear error so the
    // reviewer can restore the session and resubmit, instead of their feedback
    // vanishing into a dead channel.
    if tx.send(deny_response(reason)).is_err() {
        expected_modes.take(&session_id);
        pending_feedback.clear(&session_id);
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
        return Err(detached_delivery_error(&store.backend_of(&session_id)));
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

    // The deny send above succeeds even into a held POST whose Claude has
    // quietly stopped listening, silently dropping the feedback. Arm a watchdog
    // that flips the session to Detached (→ Restore affordance) if no fresh plan
    // arrives within the window. Clone the managed handles out of their `State`
    // guards so the spawned task can outlive this command.
    arm_revise_watchdog(
        app.clone(),
        (*store).clone(),
        (*pending).clone(),
        (*revise_watch).clone(),
        (*last_claude_pid).clone(),
        session_id.clone(),
    );
    Ok(())
}

#[tauri::command]
async fn approve_plan(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    pending: tauri::State<'_, PendingResponses>,
    expected_modes: tauri::State<'_, ExpectedModes>,
    session_id: String,
) -> Result<(), String> {
    let session = store.get(&session_id).ok_or("plan session not found")?;
    let plan = session
        .revisions
        .last()
        .ok_or("session has no plan")?
        .raw_plan_markdown
        .clone();
    let ticket = pending.approval_ticket(&session_id);
    let _approval_guard = match &ticket {
        Some(ticket) => Some(ticket.lock.lock().await),
        None => None,
    };
    if let Some(ticket) = ticket.as_ref().filter(|t| {
        pending.owns(&session_id, t.token) && session.backend.as_deref() == Some("codex")
    }) {
        // Do this while Stop is still held, and propagate errors to the Approve
        // button. Never mark a plan approved when Codex cannot start building.
        codex_app_server::queue_plan_implementation(
            ticket.codex_socket.as_deref(),
            &session_id,
            &plan,
            &ticket.id,
        )
        .await?;
    }
    let Some(tx) = ticket
        .as_ref()
        .and_then(|t| pending.take_if_owned(&session_id, t.token))
    else {
        // The held POST is gone but this session wasn't reconciled to Detached
        // (drop-guard/sweep gap). Persist it now so the UI surfaces the detached
        // banner + Restore button instead of leaving Approve a silent no-op.
        mark_session_detached(&app, &store, &session_id);
        return Err("no plan is currently waiting for review on this session".to_string());
    };
    // Approving short-circuits any in-flight Ask round-trip — no follow-up
    // plan will arrive to consume the mode, so drop it here to avoid leaks.
    let _ = expected_modes.take(&session_id);
    store.set_status(&session_id, SessionStatus::Approved);
    // The CLI asks its own "proceed?" after the hook's allow; Approve answers
    // that too (asks.rs), so Approve & build never ends in the native prompt.
    asks::note_plan_approved(&session_id);
    let _ = tx.send(approval_response("Reviewer approved via Redline."));
    store.set_attach_state(&session_id, AttachState::Idle);
    tracing::info!(session_id = %session_id, "approve_plan fired");
    // "Approve & build": the same agent is building now. Recording it is what
    // keeps an approved-and-building plan from reading as "approved · not
    // built" — and from being picked up by the overnight queue, whose ready
    // set is exactly `approved AND run_state IS NULL`.
    record_plan_build(&store.database(), &session_id, session.backend.as_deref().unwrap_or("claude-code"), "approve");
    advance_run_state(&app, &store, &session_id, "building");
    let _ = app.emit(
        "session-status-changed",
        SessionEvent {
            session_id: session_id.clone(),
        },
    );
    refresh_tray(&app, &store);
    capture_approval_shot(&app, &store, &session_id);
    Ok(())
}

/// Photograph the moment a plan was approved.
///
/// Fired ONLY from approval, which is what keeps this cheap: at the observed
/// rate that is ~236 shots a year (~12 MB) against the browse stream's ~240 MB.
/// Detached from the caller so approval never waits on a screenshot, and
/// best-effort throughout — the approval is the event, the picture is a nicety.
fn capture_approval_shot(app: &AppHandle, store: &SessionStore, session_id: &str) {
    let app = app.clone();
    let db = store.database();
    let session_id = session_id.to_string();
    tauri::async_runtime::spawn(async move {
        // The seq of the approval that just landed — the shot is keyed to the
        // event so the Timeline row and the picture find each other.
        let Ok(Some(seq)) = db.latest_decision_seq(&session_id, "approval") else {
            return;
        };
        if let Some(key) = shots::capture_redline_surface(&app, &db, "approval", seq).await {
            tracing::debug!(seq, key, "captured an approval shot");
            let _ = app.emit("memory-changed", ());
        }
    });
}

/// The deny reason `approve_plan_later` sends into the held ExitPlanMode (or
/// Codex Stop). One calm ✅ line (Claude Code renders deny reasons in a red
/// Error box, so it leads with a defusing sentence): the plan is
/// approved, nothing builds yet, and the agent stays idle in plan mode until
/// the user starts the build from Redline — which resumes THIS session with a
/// trigger that voids this stand-down.
const BUILD_LATER_STAND_DOWN: &str = "✅ Plan approved in Redline — the build will start \
     later, from Redline. Do NOT implement this plan yet, do not revise it, and do not \
     call ExitPlanMode again. Acknowledge briefly and end your turn; the user will start \
     the build from Redline.";

/// The state-machine core of `approve_plan_later`: approve, deny with the
/// build-later stand-down, leave `run_state` NULL (that NULL is what "approved
/// · not built" IS). For Codex it never queues the implementation, because
/// nothing should build yet.
fn approve_plan_later_inner(
    store: &SessionStore,
    pending: &PendingResponses,
    expected_modes: &ExpectedModes,
    session_id: &str,
) -> Result<(), String> {
    let Some(tx) = pending.take(session_id) else {
        return Err("no plan is currently waiting for review on this session".to_string());
    };
    let _ = expected_modes.take(session_id);
    // `set_status(Approved)` records the Approval in the ledger, exactly as a
    // plain Approve does.
    store.set_status(session_id, SessionStatus::Approved);
    let _ = tx.send(deny_response(BUILD_LATER_STAND_DOWN));
    store.set_attach_state(session_id, AttachState::Idle);
    Ok(())
}

/// "Approve, build later": the plan is approved and waits in Redline, with
/// Build (same agent or a hand-off) and Reopen on its footer.
#[tauri::command]
fn approve_plan_later(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    pending: tauri::State<'_, PendingResponses>,
    expected_modes: tauri::State<'_, ExpectedModes>,
    session_id: String,
) -> Result<(), String> {
    if let Err(e) = approve_plan_later_inner(&store, &pending, &expected_modes, &session_id) {
        mark_session_detached(&app, &store, &session_id);
        return Err(e);
    }
    tracing::info!(session_id = %session_id, "approve_plan_later fired");
    let _ = store.database().append_journal("approve_later", Some("session"), Some(&session_id), None, None);
    let _ = app.emit(
        "session-status-changed",
        SessionEvent {
            session_id: session_id.clone(),
        },
    );
    refresh_tray(&app, &store);
    capture_approval_shot(&app, &store, &session_id);
    Ok(())
}

/// The journal row every build start writes. `build_launched` lives in the
/// context journal rather than as a new ledger kind: the event vocabulary is
/// owned by the pinned polis crate, and the approval itself is already a
/// ledger decision.
fn record_plan_build(db: &Database, session_id: &str, harness: &str, mode: &str) {
    let _ = db.append_journal(
        "build_launched",
        Some("session"),
        Some(session_id),
        Some(harness),
        Some(mode),
    );
}

/// `mode`: "same" (resume the planning agent) or "handoff" (a fresh session
/// on another harness, pointed at the approved plan file). Only an approved
/// plan builds.
fn mark_plan_build_inner(store: &SessionStore, session_id: &str, harness: &str, mode: &str) -> Result<(), String> {
    if !matches!(mode, "same" | "handoff") {
        return Err(format!("unknown build mode {mode}"));
    }
    let session = store.get(session_id).ok_or("plan session not found")?;
    if session.status != SessionStatus::Approved {
        return Err("only an approved plan can be built".to_string());
    }
    record_plan_build(&store.database(), session_id, harness, mode);
    Ok(())
}

/// Both build paths from an approved-but-unbuilt plan go through here: one
/// journal row, and `run_state = "building"` — the chip.
#[tauri::command]
fn mark_plan_build(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    session_id: String,
    harness: String,
    mode: String,
) -> Result<(), String> {
    mark_plan_build_inner(&store, &session_id, &harness, &mode)?;
    advance_run_state(&app, &store, &session_id, "building");
    Ok(())
}

/// Write an approved plan where a DIFFERENT agent can read it:
/// `<app data>/handoff/<sessionId>-v<N>.md`. The hand-off prompt is a short
/// pointer to this file — the plan itself is never typed into a PTY.
/// Returns the absolute path.
#[tauri::command]
fn write_plan_handoff(app: AppHandle, store: tauri::State<'_, SessionStore>, session_id: String) -> Result<String, String> {
    let session = store.get(&session_id).ok_or("plan session not found")?;
    if session.status != SessionStatus::Approved {
        return Err("only an approved plan can be handed off".to_string());
    }
    let rev = session.revisions.last().ok_or("session has no plan")?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("handoff");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe: String = session_id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    let path = dir.join(format!("{safe}-v{}.md", rev.version_number));
    std::fs::write(&path, &rev.raw_plan_markdown).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// B3: back to review — for "the plan itself was wrong", not "delivery
/// failed". The approval is reversed by ledger supersession (never a
/// delete — the hash chain stays intact); the session lands Detached, which
/// lights the existing banner + Restore button, the only real path back to a
/// live claude session.
/// The state-machine core of `unapprove_plan`, split from the
/// AppHandle-dependent side effects (events, tray) so the approval reversal
/// is unit-testable.
fn unapprove_plan_inner(store: &SessionStore, session_id: &str) -> Result<(), String> {
    let session = store
        .get(session_id)
        .ok_or_else(|| "no such session".to_string())?;
    if session.status != SessionStatus::Approved {
        return Err("session is not approved".to_string());
    }
    let db = store.database();
    // Ledger first, while the approval is still the current claim.
    if let Some(approval_seq) = db.latest_approval_seq(session_id) {
        let seq_str = approval_seq.to_string();
        match ledger::record_decision(
            &db,
            ledger::DecisionInput {
                kind: ledger::EventKind::Reopen,
                author: None,
                session_id: Some(session_id),
                ref_kind: "session",
                ref_id: session_id,
                payload_hash: ledger::decision_payload_hash(&[
                    ("status", "in_review"),
                    ("session", session_id),
                    ("supersedes", &seq_str),
                ]),
            },
        ) {
            Ok(Some(new_seq)) => {
                if let Err(e) = db.record_approval_supersession(
                    approval_seq,
                    new_seq,
                    "approval rescinded by the reviewer",
                ) {
                    tracing::warn!(error = %e, "failed to record approval supersession");
                }
            }
            // An identical rescission of this approval is already recorded.
            Ok(None) => {}
            Err(e) => tracing::warn!(error = %e, "failed to record un-approve decision"),
        }
    }
    // `set_status` early-returns on no-op and only fires its ledger/journal
    // side effects on the Approved branch, so the reverse direction here is
    // side-effect-free by construction.
    store.set_status(session_id, SessionStatus::InReview);
    // Never fake Held: `list_sessions` overrides attach state from the live
    // sender map, and no POST is held. Detached is honest — it lights the
    // banner + Restore button, the only real path back to a live session.
    store.set_attach_state(session_id, AttachState::Detached);
    let _ = db.append_journal(
        "approval_rescinded",
        Some("session"),
        Some(session_id),
        None,
        None,
    );
    Ok(())
}

#[tauri::command]
fn unapprove_plan(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    session_id: String,
) -> Result<(), String> {
    unapprove_plan_inner(&store, &session_id)?;
    store.clear_run_state(&session_id);
    let _ = app.emit("run-state-changed", SessionEvent { session_id: session_id.clone() });
    let _ = app.emit(
        "session-status-changed",
        SessionEvent {
            session_id: session_id.clone(),
        },
    );
    refresh_tray(&app, &store);
    Ok(())
}

/// Manual attribution never resolves a held hook or races a running build.
fn set_plan_state_inner(store: &SessionStore, pending: &PendingResponses, session_id: &str, state: &str) -> Result<(), String> {
    let session = store.get(session_id).ok_or("no such session")?;
    if !matches!(state, "in_review" | "approved" | "completed") {
        return Err("Choose In review, Approved · not built, or Completed".into());
    }
    if pending.has(session_id) {
        return Err("Claude is waiting on this plan — use Approve in the footer".into());
    }
    if state == "in_review" {
        if session.status == SessionStatus::Approved { unapprove_plan_inner(store, session_id)?; }
        else { store.set_status(session_id, SessionStatus::InReview); }
        store.clear_run_state(session_id);
        store.set_attach_state(session_id, AttachState::Detached);
    } else {
        store.set_status(session_id, SessionStatus::Approved);
        store.clear_run_state(session_id);
        store.set_attach_state(session_id, AttachState::Idle);
        if state == "completed" { advance_run_state_inner(store, session_id, "landed"); }
    }
    let detail = serde_json::json!({ "from": { "status": session.status, "runState": session.run_state }, "to": state }).to_string();
    let _ = store.database().append_journal("manual_state", Some("session"), Some(session_id), None, Some(&detail));
    Ok(())
}

#[tauri::command]
fn set_plan_state(app: AppHandle, store: tauri::State<'_, SessionStore>, pending: tauri::State<'_, PendingResponses>, session_id: String, state: String) -> Result<(), String> {
    set_plan_state_inner(&store, &pending, &session_id, &state)?;
    let _ = app.emit("run-state-changed", SessionEvent { session_id: session_id.clone() });
    let _ = app.emit("session-status-changed", SessionEvent { session_id });
    refresh_tray(&app, &store);
    Ok(())
}

fn set_session_project_inner(store: &SessionStore, session_id: &str, project_path: &str) -> Result<(), String> {
    let path = std::fs::canonicalize(project_path).map_err(|_| "Choose an existing project folder".to_string())?;
    if !path.is_dir() { return Err("Choose a project folder, not a file".into()); }
    let before = store.get(session_id).ok_or("no such session")?.project_path;
    let path = path.to_str().ok_or("The project path is not valid text")?;
    store.set_project(session_id, path)?;
    let detail = serde_json::json!({"from":before,"to":path}).to_string();
    let _ = store.database().append_journal("project_moved", Some("session"), Some(session_id), None, Some(&detail));
    Ok(())
}

#[tauri::command]
fn set_session_project(app: AppHandle, store: tauri::State<'_, SessionStore>, session_id: String, project_path: String) -> Result<(), String> {
    set_session_project_inner(&store, &session_id, &project_path)?;
    let _ = app.emit("session-status-changed", SessionEvent { session_id });
    Ok(())
}

/// A6: handoff breadcrumbs. There is no log file (`tracing` is stdout-only),
/// so each handoff stage lands in the context journal — the Companion feed
/// gets it for free and a stuck run is readable straight out of
/// `context_journal`.
const HANDOFF_STAGES: [&str; 4] = [
    "handoff_spawned",
    "handoff_launch_written",
    "handoff_prompt_written",
    "handoff_failed",
];

#[tauri::command]
fn record_handoff_event(
    store: tauri::State<'_, SessionStore>,
    session_id: String,
    stage: String,
    detail: Option<String>,
) -> Result<(), String> {
    if !HANDOFF_STAGES.contains(&stage.as_str()) {
        return Err(format!("unknown handoff stage: {stage}"));
    }
    store
        .database()
        .append_journal(
            &stage,
            Some("session"),
            Some(&session_id),
            detail.as_deref(),
            None,
        )
        .map_err(|e| e.to_string())?;
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

/// Appearance preferences (theme / font / lint names) live in `app_settings`
/// so a fork or second machine carries the user's appearance with the DB;
/// browser localStorage remains only the pre-paint cache (index.html replays
/// it before the bundle loads). The frontend read-through-migrates old
/// localStorage-only values into here on startup.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UiPrefs {
    theme: Option<String>,
    font: Option<String>,
    lint: Option<String>,
    /// Workspace-nudge bookkeeping (launch-habit history + retired
    /// suggestions) — an opaque JSON blob owned by src/lib/nudge.ts. In the
    /// DB rather than localStorage so "fires at most once" survives a
    /// cache clear.
    workspace_nudge: Option<String>,
    /// Seat Assignment run settings (`{posture, discretion}`) — an opaque JSON
    /// blob owned by `src/lib/seatAssign.ts`, in the DB so the choice survives
    /// reopening the dialog.
    seat_assign_prefs: Option<String>,
    review_pose: Option<String>,
    /// The user's dictation vocabulary (their own words and the corrections
    /// learned from them) — an opaque JSON blob owned by `src/audio/vocab.ts`.
    voice_vocab: Option<String>,
}

/// `key` → `app_settings` row; the allowlist keeps this command from becoming
/// a generic KV write surface.
fn ui_pref_setting_key(key: &str) -> Option<&'static str> {
    match key {
        "reviewPose" => Some("redline.ui.reviewPose"),
        "theme" => Some("redline.ui.theme"),
        "font" => Some("redline.ui.font"),
        "lint" => Some("redline.ui.lint"),
        "workspaceNudge" => Some("redline.ui.workspaceNudge"),
        "seatAssignPrefs" => Some("redline.ui.seatAssignPrefs"),
        "voiceVocab" => Some("redline.ui.voiceVocab"),
        _ => None,
    }
}

#[tauri::command]
fn get_ui_prefs(settings: tauri::State<'_, Settings>) -> UiPrefs {
    UiPrefs {
        review_pose: settings.db.get_setting("redline.ui.reviewPose"),
        theme: settings.db.get_setting("redline.ui.theme"),
        font: settings.db.get_setting("redline.ui.font"),
        lint: settings.db.get_setting("redline.ui.lint"),
        workspace_nudge: settings.db.get_setting("redline.ui.workspaceNudge"),
        seat_assign_prefs: settings.db.get_setting("redline.ui.seatAssignPrefs"),
        voice_vocab: settings.db.get_setting("redline.ui.voiceVocab"),
    }
}

#[tauri::command]
fn set_ui_pref(
    settings: tauri::State<'_, Settings>,
    key: String,
    value: String,
) -> Result<(), String> {
    let setting_key = ui_pref_setting_key(&key).ok_or_else(|| format!("unknown ui pref: {key}"))?;
    settings
        .db
        .set_setting(setting_key, &value)
        .map_err(|e| e.to_string())
}

/// Agent Seats (see `seat.rs`): the whole configured map plus the global
/// claude-binary override, for the settings pane.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentSeatsView {
    seats: std::collections::HashMap<String, seat::SeatConfig>,
    known_seats: Vec<String>,
    claude_bin: Option<String>,
    /// The same for codex. Its own row because `$PATH` routinely points at an
    /// older standalone build than the one the ChatGPT app ships.
    codex_bin: Option<String>,
    /// A previous chart is stashed, so Revert has something to restore.
    can_revert: bool,
    /// What each seat does, for the settings tooltips. Served from the same
    /// `SEAT_FACTS` the Seat Assignment agent reads, so the explanation the
    /// user hovers and the one the agent reasons from can never disagree.
    blurbs: Vec<seatassign::SeatBlurb>,
    /// What an unset seat runs when it isn't the CLI default (the voice seat's
    /// built-in brain), so its row can say so.
    builtin_defaults: std::collections::HashMap<String, seat::SeatConfig>,
}

fn agent_seats_view(db: &db::Database) -> AgentSeatsView {
    AgentSeatsView {
        seats: seat::all_seats(),
        known_seats: seat::KNOWN_SEATS.iter().map(|s| s.to_string()).collect(),
        claude_bin: seat::claude_bin_override(),
        codex_bin: seat::codex_bin_override(),
        can_revert: seat::has_snapshot(db),
        blurbs: seatassign::seat_blurbs(),
        builtin_defaults: seat::builtin_defaults(),
    }
}

#[tauri::command]
fn get_agent_seats(settings: tauri::State<'_, Settings>) -> AgentSeatsView {
    agent_seats_view(&settings.db)
}

#[tauri::command]
fn set_agent_seat(
    settings: tauri::State<'_, Settings>,
    seat_name: String,
    config: seat::SeatConfig,
) -> Result<(), String> {
    seat::set_seat(&settings.db, &seat_name, config)
}

#[tauri::command]
fn set_claude_bin_override(
    settings: tauri::State<'_, Settings>,
    path: String,
) -> Result<(), String> {
    seat::set_claude_bin_override(&settings.db, &path)
}

#[tauri::command]
fn set_codex_bin_override(
    settings: tauri::State<'_, Settings>,
    path: String,
) -> Result<(), String> {
    seat::set_codex_bin_override(&settings.db, &path)?;
    // Capability answers are cached per binary identity, so a NEW path
    // re-probes for free. Re-picking the SAME path is the user saying "look
    // again" — usually right after installing a newer codex over it — and
    // handing back the cached "too old" would be maddening.
    codex_app_server::forget_codex_capability(&path);
    Ok(())
}

/// What models the installed codex can run — the Front Door's backend picker
/// asks once per app session and caches. Live rather than hardcoded: the
/// catalog ships with the ChatGPT app and changes under us.
#[tauri::command(async)]
async fn model_catalog_snapshot(backend: String, force: Option<bool>) -> Result<model_catalog::Snapshot, String> {
    model_catalog::snapshot(backend, force.unwrap_or(false)).await
}

#[tauri::command(async)]
async fn codex_model_catalog() -> Result<Vec<codex_app_server::CodexModel>, String> {
    codex_app_server::model_catalog().await
}

#[tauri::command(async)]
async fn claude_model_catalog() -> Vec<claude_models::ClaudeModel> {
    claude_models::model_catalog().await
}

#[tauri::command(async)]
async fn install_provider_integration(
    backend: String,
) -> Result<plan_provider::ProviderProbe, String> {
    tokio::task::spawn_blocking(move || {
        if !matches!(backend.as_str(), "cursor" | "antigravity") {
            return Err("Unknown planning provider".into());
        }
        provider_hooks::install(&backend)?;
        skill::install_provider(&backend)?;
        plan_provider::probe(&backend)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(async)]
async fn set_provider_bin_override(
    store: tauri::State<'_, SessionStore>,
    backend: String,
    path: Option<String>,
) -> Result<plan_provider::ProviderProbe, String> {
    let db = store.database();
    tokio::task::spawn_blocking(move || plan_provider::set_override(&db, &backend, path))
        .await
        .map_err(|e| e.to_string())?
}

// --- Seat Assignment agent (see `seatassign.rs`) --------------------------

/// Run the Seat Assignment agent once and return its proposed chart. Read-only:
/// nothing is written until the user applies a pick, so no change events fire.
#[tauri::command(async)]
async fn seat_assignment_agent(
    store: tauri::State<'_, SessionStore>,
    state: tauri::State<'_, seatassign::SeatAssignState>,
    posture: String,
    discretion: i64,
) -> Result<seatassign::SeatAssignment, String> {
    let (prompt, allowed) = {
        let db = store.database();
        let digest = seatassign::build_seat_digest(&db);
        let allowed = seatassign::known_models(&digest);
        (
            seatassign::build_seat_prompt_from_digest(&digest, &posture, discretion),
            allowed,
        )
    };
    let cwd = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
    let started = std::time::Instant::now();
    let burn_db = store.database();
    let outcome = seatassign::run_seat_assigner(&burn_db, &state, &cwd, prompt).await;
    let elapsed = started.elapsed();
    let text = match outcome {
        Ok(t) => t,
        Err(e) => {
            seatassign::log_run(&format!("FAILED after {elapsed:?}: {e}"));
            return Err(e);
        }
    };
    let parsed = seatassign::parse_assignment(&text, &allowed);
    seatassign::log_run(&format!(
        "finished in {elapsed:?} — {} pick(s), summary={:?}\n--- reply ---\n{text}",
        parsed.picks.len(),
        parsed.summary
    ));
    Ok(parsed)
}

/// Stop an in-flight run. Idempotent — cancelling nothing is not an error.
#[tauri::command]
fn seat_assignment_cancel(state: tauri::State<'_, seatassign::SeatAssignState>) {
    state.cancel();
}

/// Probe proposed model ids. Aliases short-circuit without spawning, so the
/// common case costs nothing; only a custom id actually starts a process.
#[tauri::command(async)]
async fn seat_preflight(models: Vec<String>) -> Vec<seatassign::ModelCheck> {
    let mut out = Vec::new();
    for model in models {
        out.push(seatassign::preflight_model(&model).await);
    }
    out
}

/// Apply picks atomically. On the first apply of a card (`snapshot_first`) the
/// whole pre-apply map is stashed first, so Revert can undo the batch.
#[tauri::command]
fn apply_seat_picks(
    settings: tauri::State<'_, Settings>,
    picks: Vec<seatassign::SeatPick>,
    snapshot_first: bool,
) -> Result<AgentSeatsView, String> {
    if snapshot_first {
        seat::snapshot_seats(&settings.db)?;
    }
    let current = seat::all_seats();
    let updates: Vec<(String, seat::SeatConfig)> = picks
        .iter()
        .map(|p| {
            let base = current.get(&p.seat).cloned().unwrap_or_default();
            (p.seat.clone(), seatassign::merge_pick(&base, p))
        })
        .collect();
    seat::set_seats(&settings.db, &updates)?;
    Ok(agent_seats_view(&settings.db))
}

/// Undo the whole batch — the answer to "Apply all" collapsing a per-row review
/// into one click.
#[tauri::command]
fn revert_seat_assignment(settings: tauri::State<'_, Settings>) -> Result<AgentSeatsView, String> {
    seat::restore_snapshot(&settings.db)?;
    Ok(agent_seats_view(&settings.db))
}

/// Relay settings for live collaboration: the signaling server URLs minted
/// into invite codes and the owner's presence display name. Stored in
/// `app_settings` (signaling as a JSON array) so invites are prefilled.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelayConfig {
    signaling: Vec<String>,
    display_name: String,
}

#[tauri::command]
fn get_relay_config(settings: tauri::State<'_, Settings>) -> RelayConfig {
    let signaling = settings
        .db
        .get_setting(SETTING_COLLAB_SIGNALING)
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| vec![DEFAULT_COLLAB_SIGNALING.to_string()]);
    let display_name = settings
        .db
        .get_setting(SETTING_COLLAB_DISPLAY_NAME)
        .unwrap_or_default();
    RelayConfig {
        signaling,
        display_name,
    }
}

#[tauri::command]
fn set_relay_config(
    settings: tauri::State<'_, Settings>,
    signaling: Option<Vec<String>>,
    display_name: Option<String>,
) -> Result<(), String> {
    if let Some(urls) = signaling {
        let json = serde_json::to_string(&urls).map_err(|e| e.to_string())?;
        settings
            .db
            .set_setting(SETTING_COLLAB_SIGNALING, &json)
            .map_err(|e| e.to_string())?;
    }
    if let Some(name) = display_name {
        settings
            .db
            .set_setting(SETTING_COLLAB_DISPLAY_NAME, name.trim())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The owner's long-lived collaboration signing secret. Per-share HMAC keys
/// derive from it (`HMAC(secret, requestId)`), so verifying a signed async
/// return never requires storing per-share keys. Generated lazily on first
/// read — 32 random bytes hex-encoded — and stable after that so returns
/// minted against old shares keep verifying.
#[tauri::command]
fn get_owner_secret(settings: tauri::State<'_, Settings>) -> Result<String, String> {
    if let Some(existing) = settings.db.get_setting(SETTING_COLLAB_OWNER_SECRET) {
        if !existing.is_empty() {
            return Ok(existing);
        }
    }
    // Two v4 UUIDs = 32 bytes of OS randomness — no extra dependency.
    let mut bytes = Vec::with_capacity(32);
    bytes.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    bytes.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    let secret: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    settings
        .db
        .set_setting(SETTING_COLLAB_OWNER_SECRET, &secret)
        .map_err(|e| e.to_string())?;
    Ok(secret)
}

/// Durable Review Request registry (IV.2): shares + returns live in SQLite
/// via the daemon's database — localStorage was per-webview and couldn't
/// join with the comments a return produces (`comments.share_request_id`).
#[tauri::command]
fn record_share(
    store: tauri::State<'_, SessionStore>,
    share: crate::db::ShareRecord,
) -> Result<(), String> {
    store
        .database()
        .record_share(&share)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_share(store: tauri::State<'_, SessionStore>, request_id: String) -> Result<(), String> {
    store
        .database()
        .delete_share(&request_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_shares(
    store: tauri::State<'_, SessionStore>,
    session_id: String,
) -> Result<Vec<crate::db::ShareRecord>, String> {
    store.database().list_shares(&session_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn record_share_return(
    store: tauri::State<'_, SessionStore>,
    ret: crate::db::ShareReturnRecord,
) -> Result<(), String> {
    store
        .database()
        .record_share_return(&ret)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_share_returns(
    store: tauri::State<'_, SessionStore>,
    session_id: String,
) -> Result<Vec<crate::db::ShareReturnRecord>, String> {
    store
        .database()
        .list_share_returns(&session_id)
        .map_err(|e| e.to_string())
}

/// Per-session Review Request registry, stored as an opaque JSON blob the
/// frontend owns (`src/collab/reviewRequest.ts` defines the shape). Keyed
/// per session so requests survive restarts and background sessions.
#[tauri::command]
fn get_collab_requests(settings: tauri::State<'_, Settings>, session_id: String) -> String {
    settings
        .db
        .get_setting(&format!("collab_requests.{session_id}"))
        .unwrap_or_else(|| "[]".to_string())
}

#[tauri::command]
fn set_collab_requests(
    settings: tauri::State<'_, Settings>,
    session_id: String,
    json: String,
) -> Result<(), String> {
    settings
        .db
        .set_setting(&format!("collab_requests.{session_id}"), &json)
        .map_err(|e| e.to_string())
}

/// Per-session live-share state (room secret, epoch, admin token, signaling)
/// so a restart doesn't strand outstanding join codes: re-sharing the same
/// session reuses the persisted room instead of minting a new secret. An
/// empty/absent value means "never shared" — `None` clears it.
#[tauri::command]
fn get_collab_share(settings: tauri::State<'_, Settings>, session_id: String) -> Option<String> {
    settings
        .db
        .get_setting(&format!("collab_share.{session_id}"))
        .filter(|s| !s.is_empty())
}

#[tauri::command]
fn set_collab_share(
    settings: tauri::State<'_, Settings>,
    session_id: String,
    json: Option<String>,
) -> Result<(), String> {
    settings
        .db
        .set_setting(
            &format!("collab_share.{session_id}"),
            json.as_deref().unwrap_or(""),
        )
        .map_err(|e| e.to_string())
}

/// Reviewer explicitly opened an Ambient-mode plan for full review — cancels the
/// auto-approve and keeps the held POST waiting for an explicit decision.
#[tauri::command]
fn claim_review(claims: tauri::State<'_, ClaimFlags>, session_id: String) -> bool {
    claims.claim(&session_id)
}

/// Arm a one-shot restore for a session. Called when the reviewer clicks
/// "Restore plan session" (or copies the command for their own terminal) so the
/// next inbound plan that re-presents the identical body is tagged as a restore
/// ("vN restored") rather than a fresh version. See `SessionStore::arm_restore`.
///
/// Arms the same restore on the *prompt* side too: the resumed session's first
/// prompt submission is Redline's compact trigger, and this is what entitles it
/// to the hidden protocol and keeps it out of the lake. Two one-shots for one
/// click, consumed by the two different events a restore produces (the prompt
/// going in, the plan coming back).
#[tauri::command]
fn arm_restore(store: tauri::State<'_, SessionStore>, session_id: String) {
    store.arm_restore(&session_id);
    restore_context::arm(&session_id);
}

/// Where `claude --resume <id>` can actually find a session.
///
/// Claude Code scopes resumable sessions per project directory, and it derives
/// that directory from the cwd the session STARTED in — not the cwd it is in
/// now. A session launched from `~` that later `cd`s into `~/dialcrown` files
/// its transcript under `~/.claude/projects/-Users-me/`, so resuming it from
/// `~/dialcrown` fails with "No conversation found with session ID" even though
/// the conversation is right there on disk. Redline only ever knew the plan's
/// project path (the cwd at hook time), which is exactly the wrong one in that
/// case — so it asked, and got told no.
/// Whether the conversation's own history is there to be resumed into.
///
/// This was a Boolean, and a Boolean cannot answer it for both harnesses.
/// `false` meant one specific thing — "no transcript under `~/.claude`" — and
/// the UI spends it on a real warning ("resuming as a FRESH conversation
/// without the plan's history"). Reporting that for a Codex thread would be a
/// claim about a private session-file layout Redline deliberately never reads:
/// false, alarming, and unactionable. `Unchecked` is the honest third answer.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
enum RestoreHistory {
    /// A transcript for this id is on disk — the resume lands back inside the
    /// same conversation, with the plan's history in context.
    Available,
    /// Looked, and there is nothing to resume into. The restore still succeeds
    /// (the sentinel carries the held plan's id) but the session comes back
    /// FRESH. Usual cause: transcript saving off, via an inherited
    /// `CLAUDE_CODE_CHILD_SESSION` marker.
    Missing,
    /// Not looked at, deliberately. The default, because "no answer" is what
    /// every harness Redline hasn't taught this to deserves.
    #[default]
    Unchecked,
}

#[derive(Debug, Default, serde::Serialize)]
struct ResumeTarget {
    /// The cwd the resume command should run from. `None` only when there is
    /// nothing better to offer than the caller's own guess.
    cwd: Option<String>,
    /// Is there a conversation on disk to resume into — and did we even look?
    /// See `RestoreHistory`; only the Claude arm ever answers anything else.
    history: RestoreHistory,
    /// The transcript lives under a different cwd than the plan's project path:
    /// the case that used to fail outright.
    relocated: bool,
    /// The session's plan file now holds the restore marker, written HERE
    /// rather than by the resumed model. See `prime_plan_file`.
    primed: bool,
}

/// Session ids come from our own DB, but they end up in a path join — keep them
/// to the shape Claude Code actually issues so a doctored one can't walk out of
/// the projects directory.
use crate::claude_proc::find_transcript;
#[cfg(test)]
use crate::claude_proc::is_plain_session_id;

/// The first cwd a transcript records — the directory the session was launched
/// from, which is the one Claude Code named its project folder after. Later
/// records carry whatever the session `cd`'d to, so only the first one answers
/// "where can this be resumed from".
///
/// Reads a bounded prefix: the answer is in the opening records, and these files
/// run to megabytes.
fn startup_cwd_from_transcript(path: &std::path::Path) -> Option<String> {
    use std::io::BufRead;
    let file = std::fs::File::open(path).ok()?;
    for line in std::io::BufReader::new(file).lines().take(200) {
        let Ok(line) = line else { break };
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(cwd) = v.get("cwd").and_then(Value::as_str) {
            if !cwd.is_empty() {
                return Some(cwd.to_string());
            }
        }
    }
    None
}

/// Find a session's transcript anywhere under `~/.claude/projects`.
///
/// A scan rather than a computed folder name: Claude Code flattens `/` and `.`
/// (and possibly more, over time) into `-` when it names a project folder, and
/// that mangling is its business, not ours. Thirty-odd `stat`s cost nothing and
/// can't drift out of sync with a rule we don't own.

/// The plan file a session writes its plan into — `~/.claude/plans/<slug>.md`,
/// named once per session and stable across resumes (verified against Claude
/// Code 2.1.222: a resumed session in plan mode reports the same path it used
/// before). The transcript names it every time the session touched it, so the
/// LAST mention is the file in force.
///
/// This is what lets a restore cost one tool call instead of three: knowing the
/// path, Redline can write the marker itself.
fn plan_file_from_transcript(path: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let needle = "/.claude/plans/";
    let mut found = None;
    let mut from = 0usize;
    while let Some(hit) = text[from..].find(needle) {
        let start = from + hit;
        // Back up to the start of the absolute path; a transcript quotes it
        // inside JSON, so any quote/space/newline bounds it.
        let head = text[..start]
            .rfind(['"', ' ', '\n', '\\', '(', '`'])
            .map_or(0, |i| i + 1);
        // …and forward to the extension.
        if let Some(rel_end) = text[start..].find(".md") {
            let end = start + rel_end + 3;
            let candidate = &text[head..end];
            if candidate.starts_with('/') && !candidate.contains(['"', ' ', '\n']) {
                found = Some(candidate.to_string());
            }
            from = end;
        } else {
            break;
        }
    }
    found
}

/// Write the restore marker into the session's plan file, so the resumed model
/// has nothing left to do but call `ExitPlanMode`.
///
/// This takes nothing from the user that the restore didn't already take: the
/// old three-step handshake had the model `Write` this very marker over this
/// very file. All that changes is who does the write — and a local file write
/// costs microseconds where a model round trip costs seconds.
///
/// Only ever writes over a file that already EXISTS. A plan file that has been
/// cleaned up means the resumed session will mint a new name we can't predict,
/// and priming a path nobody will read would report a readiness we don't have.
fn prime_plan_file(plan_file: &str, session_id: &str) -> bool {
    let path = std::path::Path::new(plan_file);
    if !path.is_file() {
        return false;
    }
    std::fs::write(path, format!("{REDLINE_RESTORE_PREFIX}:{session_id} -->\n")).is_ok()
}

/// Undo [`prime_plan_file`] once the restore has fired: the plan file goes
/// back to the plan being re-presented. Only over a file that still holds a
/// restore marker — never over a plan the agent wrote since.
fn unprime_plan_file(plan_file: &str, body: &str) -> bool {
    let path = std::path::Path::new(plan_file);
    let Ok(current) = std::fs::read_to_string(path) else { return false };
    if !current.trim_start().starts_with(REDLINE_RESTORE_PREFIX) || body.trim().is_empty() {
        return false;
    }
    std::fs::write(path, body).is_ok()
}

/// Everything a "Restore plan session" needs to know, resolved against the
/// transcripts on disk: where the conversation can be resumed from, whether it
/// exists at all, and whether its plan file has been primed with the restore
/// marker (which lets the caller ask for a one-tool-call handshake).
#[tauri::command]
fn prepare_restore(
    session_id: String,
    project_path: Option<String>,
    // Which harness holds this conversation (`sessions.backend`). Absent reads
    // as Claude: every pre-backend row is one, and Claude is what this command
    // did unconditionally before there was anything else to be.
    backend: Option<String>,
) -> ResumeTarget {
    // The Codex arm, and it is a *refusal to look* rather than a lookup that
    // happens to come back empty. Everything below reads `~/.claude`: the
    // transcript scan, the startup-cwd recovery, and the plan-file prime. None
    // of the three has a Codex meaning — a Codex thread has no Claude
    // transcript by construction, and `codex resume` is not scoped by the
    // startup cwd the way `claude --resume` is. Running them anyway would cost
    // thirty stats to arrive at `Missing`, which the UI then reports to the
    // reviewer as "no saved transcript — resuming as a fresh conversation".
    // That sentence would be false, and it would be false every single time.
    //
    // So: the plan's own project directory, no Claude file touched, and no
    // answer claimed about history we never inspected.
    if backend.as_deref().is_some_and(|b| {
        matches!(
            b.trim().to_ascii_lowercase().as_str(),
            "codex" | "cursor" | "antigravity"
        )
    }) {
        return ResumeTarget {
            cwd: project_path,
            history: RestoreHistory::Unchecked,
            relocated: false,
            primed: false,
        };
    }
    let Some(transcript) = find_transcript(&session_id) else {
        return ResumeTarget {
            cwd: project_path,
            history: RestoreHistory::Missing,
            relocated: false,
            primed: false,
        };
    };
    let primed = plan_file_from_transcript(&transcript)
        .is_some_and(|f| prime_plan_file(&f, &session_id));
    let Some(cwd) = startup_cwd_from_transcript(&transcript) else {
        return ResumeTarget {
            cwd: project_path,
            history: RestoreHistory::Available,
            relocated: false,
            primed,
        };
    };
    let relocated = project_path.as_deref().is_some_and(|p| p != cwd);
    ResumeTarget {
        cwd: Some(cwd),
        history: RestoreHistory::Available,
        relocated,
        primed,
    }
}

/// Where a conversation can be RESUMED from, with no side effects: the
/// startup-cwd half of `prepare_restore`, without its plan-file prime. A build
/// resumes the planning session to IMPLEMENT the plan, and priming would
/// overwrite the very plan file the agent is about to read with the restore
/// marker. Claude only; everything else resumes from the project path.
#[tauri::command]
fn resume_startup_cwd(session_id: String, project_path: Option<String>, backend: Option<String>) -> Option<String> {
    resume_cwd_for(&session_id, project_path, backend.as_deref())
}

pub(crate) fn resume_cwd_for(session_id: &str, project_path: Option<String>, backend: Option<&str>) -> Option<String> {
    let claude = backend
        .as_deref()
        .map(|b| b.trim().to_ascii_lowercase())
        .is_none_or(|b| b.is_empty() || b == "claude-code" || b == "claude");
    if !claude {
        return project_path;
    }
    find_transcript(session_id)
        .and_then(|t| startup_cwd_from_transcript(&t))
        .or(project_path)
}

/// Reveal the main window. The window starts hidden and is shown once the
/// frontend has rendered its first themed frame, so launch never flashes white.
#[tauri::command]
fn show_main_window(app: AppHandle) {
    boot_trace::mark(boot_trace::WINDOW_REVEAL);
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
    // The candidate probe's evidence for two claims: the frontend rendered
    // (it only calls this once themed) and it completed a round trip to the
    // backend (it is a command).
    crate::probe::record(
        crate::probe::Milestone::Frontend,
        "rendered and completed an IPC round trip",
    );
    crate::probe::finish_if_probing(app.clone());
    // THE boundary. Everything the old `setup` closure did that nobody was
    // waiting for — the database snapshot, the hook repairs, the grammar set —
    // starts here, behind the first frame the user can act on. Once per
    // process; a resurrected window calls this again and must not re-snapshot.
    postboot::run(app);
}

/// Re-create the main window on a running instance that has none — the
/// single-instance handoff's answer to a headless incumbent (window died,
/// process lived on). Built from the same `tauri.conf.json` window config as
/// first boot, so it inherits the label ("main" by default), chrome, and the
/// hidden-until-painted reveal: the frontend calls `show_main_window` once
/// themed, with the same show-anyway fallback as setup so a JS error can't
/// leave the new window invisible forever.
fn resurrect_main_window(app: &AppHandle) {
    let Some(config) = app.config().app.windows.first().cloned() else {
        tracing::error!("no window config to resurrect the main window from");
        return;
    };
    let win = tauri::WebviewWindowBuilder::from_config(app, &config)
        .and_then(|b| b.build());
    match win {
        Ok(win) => {
            tracing::info!("re-created the main window on a headless instance");
            let fallback = win.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(2000)).await;
                let _ = fallback.show();
                let _ = fallback.set_focus();
            });
        }
        Err(e) => tracing::error!(error = %e, "could not re-create the main window"),
    }
}

/// Navigate one of the embedded browser tab webviews to a URL. The JS
/// `Webview` class can create/position/show/hide a child webview but cannot
/// navigate it or run scripts in it, so the browser pane routes those here.
/// `label` identifies the tab's webview (e.g. "browser-t0").
#[tauri::command]
fn browser_navigate(app: AppHandle, label: String, url: String) -> Result<(), String> {
    let wv = app
        .get_webview(&label)
        .ok_or_else(|| format!("browser webview '{label}' not found"))?;
    let parsed: tauri::Url = url
        .parse()
        .map_err(|_| format!("invalid url: {url}"))?;
    if parsed.scheme() == "file" {
        let path = parsed.to_file_path().map_err(|_| format!("invalid file url: {url}"))?;
        return load_file_url(&wv, &path);
    }
    wv.navigate(parsed).map_err(|e| e.to_string())
}

/// Evaluate JavaScript inside a browser tab's webview. This is the foundation
/// for the AI/scripting layer (DOM scraping, JSON export) — each tab can be
/// scripted independently by label; for now the pane uses it for back/forward.
#[tauri::command]
fn browser_eval(app: AppHandle, label: String, script: String) -> Result<(), String> {
    let wv = app
        .get_webview(&label)
        .ok_or_else(|| format!("browser webview '{label}' not found"))?;
    wv.eval(&script).map_err(|e| e.to_string())
}

/// JS that hard-stops every audio/video element in the page: pause it, mute it,
/// detach its source, and reload so the decoder/network session is torn down.
/// WKWebView keeps a media session alive after a plain `close()` — a YouTube
/// video keeps playing in the background with no visible tab — so we run this
/// before destroying the webview.
const STOP_MEDIA_JS: &str = "(function(){try{document.querySelectorAll('video,audio').forEach(function(m){try{m.pause();m.muted=true;m.removeAttribute('src');m.srcObject=null;m.load();}catch(e){}});}catch(e){}})()";

/// Stop in-page media and destroy a browser tab's webview. Closing a tab or the
/// whole browser pane must silence its audio; a bare `close()` doesn't reliably
/// reclaim WKWebView's media session, so we pause/detach all media first, then
/// close. The eval and close both dispatch to the UI thread in order, and either
/// path (JS pauses media, or close destroys the view) ends playback — so they
/// back each other up. Idempotent: a missing webview is a no-op success.
#[tauri::command]
fn browser_close(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.eval(STOP_MEDIA_JS);
        wv.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Read a browser tab's current URL **without** tripping wry's
/// `WKWebView.URL().unwrap()`. A freshly-created tab reports a nil `URL` until
/// it commits its first navigation, and wry's `Webview::url()` unwraps that nil
/// on the main event-loop thread — an abort that takes down the whole app (the
/// `.ok()` at our call sites never runs because the panic is inside wry). So we
/// reach the native WKWebView via `with_webview` and read `URL.absoluteString`
/// ourselves, mapping nil (and the empty string) to `None`. On non-macOS we fall
/// back to wry's getter, which doesn't have this flaw off WKWebView.
fn webview_current_url<R: tauri::Runtime>(wv: &tauri::Webview<R>) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel::<Option<String>>();
        if wv
            .with_webview(move |pw| {
                let ptr = pw.inner() as *mut objc2::runtime::AnyObject;
                // SAFETY: `with_webview` runs this on the UI thread and `inner()`
                // hands back the live WKWebView. `URL`/`absoluteString`/`UTF8String`
                // are nil-returning reads; we null-check each before chasing it.
                let url = unsafe {
                    ptr.as_ref().and_then(|obj| {
                        let nsurl: *mut objc2::runtime::AnyObject =
                            objc2::msg_send![obj, URL];
                        if nsurl.is_null() {
                            return None;
                        }
                        let abs: *mut objc2::runtime::AnyObject =
                            objc2::msg_send![nsurl, absoluteString];
                        if abs.is_null() {
                            return None;
                        }
                        let c: *const std::os::raw::c_char =
                            objc2::msg_send![abs, UTF8String];
                        if c.is_null() {
                            return None;
                        }
                        let s = std::ffi::CStr::from_ptr(c).to_string_lossy().into_owned();
                        (!s.is_empty()).then_some(s)
                    })
                };
                let _ = tx.send(url);
            })
            .is_err()
        {
            return None;
        }
        // When called off the main thread `with_webview` dispatches to the event
        // loop and returns before the closure runs, so block on the result.
        rx.recv_timeout(std::time::Duration::from_secs(2))
            .ok()
            .flatten()
    }
    #[cfg(not(target_os = "macos"))]
    {
        wv.url().ok().map(|u| u.to_string())
    }
}

/// Current URL of a browser tab's webview. The JS `Webview` API exposes no
/// navigation events or URL getter, so the pane polls this to keep the address
/// bar / tab title in sync with in-page navigation (link clicks, redirects).
/// A nil URL (tab not yet navigated) reports as the empty string, which the
/// pane's poll treats as "no change".
#[tauri::command]
fn browser_url(app: AppHandle, label: String) -> Result<String, String> {
    let wv = app
        .get_webview(&label)
        .ok_or_else(|| format!("browser webview '{label}' not found"))?;
    Ok(webview_current_url(&wv).unwrap_or_default())
}

/// Turn on WKWebView's two-finger back/forward swipe and trackpad pinch
/// magnification on a browser tab. Tauri 2.11 surfaces neither
/// `setAllowsBackForwardNavigationGestures` nor `setAllowsMagnification`
/// (both default off), so we reach the native WKWebView through
/// `with_webview()` and send the selectors with objc2. No-op on non-macOS.
fn browser_enable_gestures(app: AppHandle, label: String) -> Result<(), String> {
    let wv = app
        .get_webview(&label)
        .ok_or_else(|| format!("browser webview '{label}' not found"))?;
    #[cfg(target_os = "macos")]
    {
        wv.with_webview(|pw| {
            let ptr = pw.inner() as *mut objc2::runtime::AnyObject;
            // SAFETY: `with_webview` runs this on the UI thread and `inner()`
            // hands back the live WKWebView; each selector takes a single BOOL.
            unsafe {
                if let Some(obj) = ptr.as_ref() {
                    let _: () = objc2::msg_send![
                        obj,
                        setAllowsBackForwardNavigationGestures: objc2::runtime::Bool::new(true)
                    ];
                    // Enable two-finger pinch-to-zoom on the page.
                    let _: () =
                        objc2::msg_send![obj, setAllowsMagnification: objc2::runtime::Bool::new(true)];
                }
            }
        })
        .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = wv;
    }
    Ok(())
}

/// Let macOS resize a browser tab's webview in lockstep with the window instead
/// of us pushing new bounds over IPC every frame (which lags visibly during the
/// fullscreen animation). We set the WKWebView's `autoresizingMask` to flexible
/// width + height PLUS a flexible right margin
/// (`NSViewWidthSizable | NSViewMaxXMargin | NSViewHeightSizable` = 2 | 4 | 16 =
/// 22). The flexible right margin is what keeps the page-discussion split honest:
/// with only width flexible (mask 18) AppKit dumps the ENTIRE horizontal delta
/// into the webview's width and keeps the gap to the window's right edge fixed in
/// points — but when the discussion pane is open that gap IS the chat pane, which
/// the React flexbox grows by only its proportional (~38%) share, so the webview's
/// right edge outruns the chat's left edge and the page spills over it. Making the
/// right margin flexible too lets AppKit split the width delta PROPORTIONALLY
/// between the webview and the space to its right, matching the SplitPane's flex
/// ratio during the live drag. (Chat closed → right margin ≈ 0 → it absorbs ~0 of
/// the delta and the webview still takes it all, so one mask serves both cases.)
/// `syncBounds` still sets the exact rect at settle and on split/divider changes.
/// macOS-only; a no-op elsewhere.
fn browser_enable_autoresize(
    app: AppHandle,
    label: String,
    enabled: Option<bool>,
) -> Result<(), String> {
    let wv = app
        .get_webview(&label)
        .ok_or_else(|| format!("browser webview '{label}' not found"))?;
    #[cfg(target_os = "macos")]
    {
        wv.with_webview(move |pw| {
            let mask = if enabled.unwrap_or(true) {
                22usize
            } else {
                0usize
            };
            let ptr = pw.inner() as *mut objc2::runtime::AnyObject;
            // SAFETY: runs on the UI thread; `inner()` is the live WKWebView (an
            // NSView). `setAutoresizingMask:` takes a single NSUInteger.
            unsafe {
                if let Some(obj) = ptr.as_ref() {
                    let _: () = objc2::msg_send![obj, setAutoresizingMask: mask];
                }
            }
        })
        .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = wv;
    }
    Ok(())
}

/// Build the idempotent JS that installs (or removes) the Redline "View" filter
/// stylesheet on a page. Used both as the document-start user script — so the
/// filter is present *before* the page paints on every navigation (no flash) —
/// and as an immediate eval into the already-loaded page so a toggle applies
/// now. An empty `css` removes the stylesheet. The CSS is JSON-encoded into a
/// safe JS string literal so it can't break out of the snippet.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn view_inject_js(css: &str) -> String {
    let css_lit = serde_json::to_string(css).unwrap_or_else(|_| "\"\"".into());
    format!(
        r#"(function(){{
  var id='__redline_view__';
  var css={css_lit};
  var s=document.getElementById(id);
  if(!css){{ if(s) s.remove(); return; }}
  if(!s){{ s=document.createElement('style'); s.id=id; (document.head||document.documentElement).appendChild(s); }}
  s.textContent=css;
}})();"#
    )
}

/// Make an autoreleased NSString from a Rust str without an objc2-foundation
/// dependency. SAFETY: caller must be on a thread with an active autorelease
/// pool (the UI thread is); the returned string is valid until that pool drains
/// or it's retained by a consumer (here `initWithSource:` copies it).
#[cfg(target_os = "macos")]
unsafe fn ns_string(s: &str) -> *mut objc2::runtime::AnyObject {
    let c = std::ffi::CString::new(s).unwrap_or_default();
    let cls = objc2::class!(NSString);
    objc2::msg_send![cls, stringWithUTF8String: c.as_ptr()]
}

/// Document-start fullscreen adapter, installed in every frame so embedded
/// players expand inside their native webview and exit through Redline's controls.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn fullscreen_shim_js() -> &'static str {
    include_str!("browser_fullscreen.js")
}

/// Document-start user script (all frames) that makes "open in a new tab" work
/// for these child webviews. WebKit routes `target="_blank"`, `window.open`, and
/// cmd/middle-clicks to the WKUIDelegate's `createWebViewWithConfiguration:` —
/// which wry leaves unhandled here (no `new_window_req_handler`), so the request
/// is silently dropped and nothing opens. This shim intercepts those intents,
/// resolves them to absolute http(s) URLs, and queues them on the TOP frame's
/// `window.__redline_newtabs`; the pane polls + drains that queue (same eval
/// path as the fullscreen flag) and opens a real Redline tab. Plain same-tab
/// links are left untouched — they navigate normally. Sub-frames relay their
/// captures to the top frame via `postMessage` (the queue only lives at top,
/// which is what the native eval reads).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn newtab_shim_js() -> &'static str {
    r#"(function(){
  if (window.__redline_newtab_installed) return;
  window.__redline_newtab_installed = true;
  function isTop(){ return window===window.top; }
  function abs(u){ try{ return new URL(u, location.href).href; }catch(e){ return ""; } }
  function queue(u){
    u = abs(u);
    if (!/^https?:/i.test(u)) return;
    if (isTop()){
      var q = window.__redline_newtabs = window.__redline_newtabs || [];
      q.push(u);
      if (q.length > 20) q.splice(0, q.length - 20); // bound if the pane isn't draining
    } else {
      try{ window.top.postMessage({__rl_newtab:u}, '*'); }
      catch(e){ try{ window.parent.postMessage({__rl_newtab:u}, '*'); }catch(e2){} }
    }
  }
  // window.open handling splits by intent:
  //  • WITH a features string (width/height/popup) → a real popup (OAuth/SSO):
  //    let WebKit's native path run so our WKUIDelegate hosts it in a floating
  //    window with a live `window.opener`. Return the real WindowProxy.
  //  • WITHOUT features → "open in a new tab": route to a Redline tab and hand
  //    back a harmless stub (sites that poke the return value won't throw).
  var _open = window.open.bind(window);
  // A real popup is signalled by SIZE/popup features (width=/height=/popup).
  // A bare `noopener,noreferrer` (very common on plain "open in new tab" links)
  // is NOT a popup — those must open as a Redline tab, not a floating window.
  function isPopupFeatures(f){
    f = f ? String(f).toLowerCase() : '';
    return /\bwidth\s*=/.test(f) || /\bheight\s*=/.test(f) || /\bpopup\b/.test(f);
  }
  window.open = function(u, name, features){
    // A blob:/data: document (a site's "Download PDF" button) can't become a
    // Redline tab — another webview can't read this page's blob. Open it the
    // way a target=_blank blob link already opens: a WebKit-created popup with
    // a live opener, hosted by our UI delegate.
    if (!isPopupFeatures(features) && /^(blob|data):/i.test(String(u || ''))){
      try{ return _open(u, name || '_blank', 'popup,width=960,height=1100'); }catch(e){ return null; }
    }
    if (isPopupFeatures(features)){
      // Real popup (OAuth/SSO): let WebKit's native path run so our WKUIDelegate
      // hosts it in a floating window with a live `window.opener`.
      try{ return _open(u, name, features); }catch(e){ return null; }
    }
    // "Open in a new tab": route to a Redline tab, hand back a harmless stub.
    queue(u);
    return { closed:false, focus:function(){}, blur:function(){}, close:function(){}, postMessage:function(){} };
  };
  function anchorOf(node){
    var n = node;
    while (n && n.nodeType === 3) n = n.parentNode; // climb out of text nodes
    return n && n.closest ? n.closest('a[href]') : null;
  }
  document.addEventListener('click', function(e){
    var a = anchorOf(e.target);
    if (!a) return;
    // Middle-click is delivered as `auxclick` (handled below), so it's
    // intentionally not tested here — doing both would open the tab twice.
    var wantsNew = (a.target === '_blank') || e.metaKey || e.ctrlKey;
    if (!wantsNew) return;
    if (!/^https?:/i.test(a.href)) return; // let mailto:/#anchors behave normally
    e.preventDefault(); e.stopPropagation();
    queue(a.href);
  }, true);
  document.addEventListener('auxclick', function(e){
    if (e.button !== 1) return; // middle-click = new tab
    var a = anchorOf(e.target);
    if (!a || !/^https?:/i.test(a.href)) return;
    e.preventDefault(); e.stopPropagation();
    queue(a.href);
  }, true);
  window.addEventListener('message', function(e){
    var d = e && e.data;
    if (d && typeof d.__rl_newtab === 'string') queue(d.__rl_newtab);
  }, false);
})();"#
}

/// Document-start user script (MAIN FRAME ONLY) that draws Redline's
/// highlight-to-chat action bar inside the page. Finishing a selection pops a
/// small bar offering Ask about this · Define · Explain · Research · Copy ·
/// ＋ List; everything except Copy is queued on `window.__redline_selections`,
/// which the pane drains in the same 250 ms poll that already carries the
/// fullscreen flag and the new-tab queue.
///
/// Why the bar is drawn in-page rather than in React: the child webview is an
/// OS layer composited ABOVE the React DOM, and `window.getSelection()` in the
/// host document never sees page text — the same constraint that makes
/// bookmarks and view filters native popup menus. A native menu would float
/// correctly but only after a poll round-trip, which reads as lag on a gesture
/// this frequent.
///
/// Four details are load-bearing:
///  • The bar lives in a CLOSED shadow root on `documentElement` (stable across
///    `body` replacement) with `:host{all:initial}`, so page CSS can't reach it
///    and it can't leak styles into the page.
///  • Every button `preventDefault()`s its `mousedown`. Without it the click
///    collapses the very selection the bar exists to act on — the same line
///    that is load-bearing in `SelectionMenu.tsx` and the Drafter's toolbar.
///  • It positions ABSOLUTELY in document coordinates rather than
///    `position:fixed`. Redline's own "View" filters set `filter:` on `html`,
///    and a filtered element becomes the containing block for fixed
///    descendants — under 🎨 Dark a fixed bar would anchor to the top of the
///    *document*, not the viewport. Absolute coordinates resolve against the
///    same origin either way. That filter would also tint the bar, so it
///    counter-inverts itself when the page filter contains `invert`.
///  • `window.__redline_sel_off` gates it at runtime, so unchecking the
///    settings toggle takes the bar off the already-loaded page immediately
///    (see `selection_teardown_js`) instead of waiting for a navigation.
///
/// Selections inside a sub-frame don't offer the bar: it's registered main
/// frame only so ad/embed iframes never sprout a second one, and translating a
/// cross-origin child's range rect into top-frame coordinates isn't worth it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn selection_shim_js() -> &'static str {
    r##"(function(){
  // Cleared before the install guard so re-enabling the toggle revives a shim
  // that is already installed on this page.
  try{ window.__redline_sel_off = false; }catch(e){}
  if (window.__redline_sel_installed) return;
  window.__redline_sel_installed = true;
  var MAXQ=10, MAXLEN=4000, MINLEN=3, MAXHTML=1200, HOST_ATTR='data-redline-selection';
  var ACTIONS=[['ask','Ask about this'],['define','Define'],['explain','Explain'],
               ['research','Look up'],['copy','Copy'],['list','＋ Task']];
  var seq=0, host=null, bar=null, noteRow=null, noteInput=null;
  var pending=null, timer=0, suppressUntil=0, composing=false, noteMode='list', noteGo=null;

  function off(){ try{ return !!window.__redline_sel_off; }catch(e){ return false; } }
  // Never hijack typing: a selection anchored in a field or a rich-text editor
  // belongs to that editor, not to us.
  function editable(node){
    var n=node;
    while (n && n.nodeType===3) n=n.parentNode;
    while (n && n.nodeType===1){
      var t=(n.tagName||'').toLowerCase();
      if (t==='input'||t==='textarea'||t==='select') return true;
      if (n.isContentEditable) return true;
      n=n.parentNode;
    }
    return false;
  }
  function clean(s){
    return String(s||'').replace(/[ \t ]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
  }
  function flat(s){ return clean(s).replace(/\s+/g,' '); }
  function rectOf(sel){
    try{
      var r=sel.getRangeAt(0).getBoundingClientRect();
      if (r && (r.width||r.height)) return r;
      var rs=sel.getRangeAt(0).getClientRects();
      if (rs && rs.length) return rs[0];
    }catch(e){}
    return null;
  }

  // ── Describing the element the user highlighted ────────────────────────────
  // The point of all of this is one short phrase on a list item: "Search bar".
  // The shim's job is to gather the raw material honestly; deciding which field
  // wins lives in src/lib/pageLocator.ts, where it is pure and testable. So this
  // reports what the DOM says and never editorialises.
  var INLINE={span:1,em:1,strong:1,b:1,i:1,u:1,s:1,small:1,mark:1,code:1,font:1,
              abbr:1,time:1,sup:1,sub:1,cite:1,q:1,var:1,kbd:1,samp:1,bdi:1,bdo:1,wbr:1,br:1};
  var TEST_ATTRS=['data-testid','data-test-id','data-test','data-cy','data-qa','data-automation-id'];
  var NAME_ATTRS=['aria-label','data-label','data-name'];

  function attrOf(el,names){
    if (!el || !el.getAttribute) return '';
    for (var i=0;i<names.length;i++){
      var v=el.getAttribute(names[i]);
      if (v && flat(v)) return flat(v).slice(0,160);
    }
    return '';
  }
  function tagOf(el){ return ((el&&el.tagName)||'').toLowerCase(); }
  function textOf(el){
    var t='';
    try{ t = el.innerText || el.textContent || ''; }catch(e){}
    return flat(t).slice(0,200);
  }
  function classesOf(el){
    var raw='';
    // SVG elements carry an SVGAnimatedString, not a string.
    try{ raw = (typeof el.className==='string') ? el.className : (el.getAttribute('class')||''); }catch(e){}
    return flat(raw).split(' ').filter(function(c){ return c && c.length<=40; }).slice(0,6);
  }
  function labelFor(el){
    var lb=attrOf(el,['aria-labelledby']);
    if (lb){
      try{ var n=document.getElementById(lb.split(' ')[0]); if (n) return textOf(n).slice(0,120); }catch(e){}
    }
    try{ if (el.labels && el.labels.length) return textOf(el.labels[0]).slice(0,120); }catch(e){}
    var id=el.getAttribute && el.getAttribute('id');
    if (id){
      try{
        var esc=(window.CSS&&CSS.escape)?CSS.escape(id):id.replace(/["\\]/g,'\\$&');
        var l=document.querySelector('label[for="'+esc+'"]');
        if (l) return textOf(l).slice(0,120);
      }catch(e){}
    }
    return '';
  }
  // The nearest thing to an accessible name, in the order a screen reader would
  // find one. Short visible text counts for the elements whose text IS their
  // name (a button, a link, a heading); for a paragraph it would just be the
  // passage the user already highlighted.
  function nameOf(el){
    var v=attrOf(el,NAME_ATTRS);
    if (v) return v;
    v=labelFor(el);
    if (v) return v;
    var tag=tagOf(el);
    if (tag==='input'||tag==='textarea'||tag==='select'){
      v=attrOf(el,['placeholder','name','title']);
      if (v) return v;
    }
    if (tag==='img'||tag==='svg') { v=attrOf(el,['alt','title']); if (v) return v; }
    if (tag==='a'||tag==='button'||tag==='label'||tag==='summary'||/^h[1-6]$/.test(tag)){
      var t=textOf(el);
      if (t && t.length<=60) return t;
    }
    return attrOf(el,['title']);
  }
  function testIdOf(el){ return attrOf(el,TEST_ATTRS); }
  // A named element is one somebody labelled on purpose. That is the only
  // signal worth CLIMBING for: everything else is available on the element the
  // selection actually landed in.
  function named(el){ return !!(testIdOf(el) || attrOf(el,NAME_ATTRS) || attrOf(el,['aria-labelledby'])); }

  function elementFor(sel){
    var node=null;
    try{ node=sel.getRangeAt(0).commonAncestorContainer; }catch(e){}
    if (!node) node=sel.anchorNode;
    while (node && node.nodeType!==1) node=node.parentNode;
    if (!node) return null;
    // Out of pure text wrappers: a <span> inside a heading is not a component.
    var hops=0;
    while (node && INLINE[tagOf(node)] && node.parentNode && node.parentNode.nodeType===1 && hops++<5){
      if (named(node)) break;
      node=node.parentNode;
    }
    if (!node || node.nodeType!==1) return null;
    if (named(node)) return node;
    // Nothing here is named — look a little way up for something that is,
    // which is how "the text inside a card" resolves to the card.
    var up=node, steps=0;
    while (up && steps++<4){
      if (named(up)) return up;
      up=up.parentNode;
      if (!up || up.nodeType!==1) break;
    }
    return node;
  }
  var LANDMARK_TAGS={section:1,article:1,nav:1,header:1,footer:1,aside:1,main:1,form:1,dialog:1,figure:1,li:1,table:1};
  function landmarkOf(el){
    var n=el, steps=0;
    while (n && n.nodeType===1 && steps++<8){
      if (LANDMARK_TAGS[tagOf(n)] || attrOf(n,['role'])){
        var name=attrOf(n,NAME_ATTRS) || labelFor(n) || attrOf(n,['title']) || testIdOf(n);
        if (name) return name.slice(0,120);
      }
      n=n.parentNode;
    }
    return '';
  }
  function headingOf(el){
    var n=el, steps=0;
    while (n && n.nodeType===1 && steps++<8){
      var sib=n.previousElementSibling, scanned=0;
      while (sib && scanned++<12){
        if (/^h[1-6]$/.test(tagOf(sib))) return textOf(sib).slice(0,160);
        var inner=null;
        try{ inner=sib.querySelector('h1,h2,h3,h4,h5,h6'); }catch(e){}
        if (inner) return textOf(inner).slice(0,160);
        sib=sib.previousElementSibling;
      }
      n=n.parentNode;
    }
    return '';
  }
  function stepOf(el){
    var t=tagOf(el);
    var id=el.getAttribute && el.getAttribute('id');
    if (id && id.length<=40) return t+'#'+id;
    var cls=classesOf(el);
    return cls.length ? t+'.'+cls[0] : t;
  }
  function pathOf(el){
    var out=[], n=el, steps=0;
    while (n && n.nodeType===1 && tagOf(n)!=='html' && steps++<6){
      out.unshift(stepOf(n));
      n=n.parentNode;
    }
    return out.join(' > ');
  }
  function describe(sel){
    var el=null;
    try{ el=elementFor(sel); }catch(e){}
    if (!el) return null;
    var out=null;
    try{
      out={
        tag: tagOf(el),
        role: attrOf(el,['role']),
        name: nameOf(el),
        id: (el.getAttribute && el.getAttribute('id')) || '',
        testId: testIdOf(el),
        classes: classesOf(el),
        path: pathOf(el),
        landmark: landmarkOf(el),
        heading: headingOf(el),
        text: textOf(el)
      };
      // Raw markup for the background naming agent only — nothing on the
      // deterministic path reads it, so a page that refuses `outerHTML` costs
      // nothing.
      try{ out.html=String(el.outerHTML||'').slice(0,MAXHTML); }catch(e){}
    }catch(e){ return null; }
    return out;
  }
  // What the side pane reads when the user types their note there instead of
  // in the bar. Published on every evaluate, cleared the moment the selection
  // is: an item must never be anchored to something the user stopped pointing at.
  function publish(){
    try{
      window.__redline_sel_last = pending ? {
        text: pending.text, locator: pending.locator, ts: Date.now()
      } : null;
    }catch(e){}
  }

  function build(){
    if (bar) return bar;
    host=document.createElement('div');
    host.setAttribute(HOST_ATTR,'');
    var root=host.attachShadow({mode:'closed'});
    var st=document.createElement('style');
    st.textContent=':host{all:initial}'+
      '.wrap{position:absolute;z-index:2147483647;display:none;flex-direction:column;gap:4px;padding:3px;'+
      'border-radius:9px;-webkit-user-select:none;user-select:none;'+
      'font:500 12px/1.25 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;'+
      'background:#fff;color:#1c1c1e;border:1px solid rgba(0,0,0,.14);box-shadow:0 6px 22px rgba(0,0,0,.20)}'+
      '.row{display:flex;align-items:center;gap:1px;white-space:nowrap}'+
      '.wrap button{all:unset;cursor:default;padding:4px 8px;border-radius:6px;font:inherit;color:inherit}'+
      '.wrap button:hover{background:rgba(0,0,0,.08)}'+
      '.wrap .sep{width:1px;align-self:stretch;margin:2px 3px;background:rgba(0,0,0,.13)}'+
      '.note{display:none;align-items:center;gap:4px;padding:0 2px 2px}'+
      '.note input{all:unset;-webkit-user-select:text;user-select:text;width:280px;padding:5px 7px;'+
      'border-radius:6px;font:inherit;color:inherit;background:rgba(0,0,0,.05);'+
      'border:1px solid rgba(0,0,0,.12)}'+
      '.note button.go{background:#0a67d0;color:#fff;padding:5px 9px}'+
      '.note button.go:hover{background:#0a5ab6}'+
      '@media (prefers-color-scheme:dark){'+
      '.wrap{background:#26262a;color:#f2f2f5;border-color:rgba(255,255,255,.16);box-shadow:0 6px 22px rgba(0,0,0,.55)}'+
      '.wrap button:hover{background:rgba(255,255,255,.14)}'+
      '.wrap .sep{background:rgba(255,255,255,.18)}'+
      '.note input{background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.18)}}';
    root.appendChild(st);
    bar=document.createElement('div');
    bar.className='wrap';
    var row=document.createElement('div');
    row.className='row';
    ACTIONS.forEach(function(a){
      if (a[0]==='copy'){ var sp=document.createElement('div'); sp.className='sep'; row.appendChild(sp); }
      var b=document.createElement('button');
      b.type='button';
      b.setAttribute('data-rl-action',a[0]);
      b.textContent=a[1];
      // LOAD-BEARING: the default mousedown would collapse the selection this
      // bar exists to act on, so the click would arrive with nothing selected.
      b.addEventListener('mousedown',function(e){ e.preventDefault(); e.stopPropagation(); },true);
      b.addEventListener('click',function(e){ e.preventDefault(); e.stopPropagation(); pick(a[0],b); },true);
      row.appendChild(b);
    });
    bar.appendChild(row);

    // The note row. `＋ List` used to file the highlighted TEXT as the item,
    // which is the wrong half: the passage is WHERE, and what the user has to
    // say about it is the item. So the tap opens a field for the note and the
    // passage becomes the location instead.
    noteRow=document.createElement('div');
    noteRow.className='note';
    noteInput=document.createElement('input');
    noteInput.type='text';
    noteInput.setAttribute('maxlength','500');
    var go=document.createElement('button');
    go.type='button';
    go.className='go';
    go.textContent='Add'; noteGo=go;
    // The input MUST keep the default mousedown (it needs focus); the button
    // must not (it would blur the field and collapse the page selection).
    go.addEventListener('mousedown',function(e){ e.preventDefault(); e.stopPropagation(); },true);
    go.addEventListener('click',function(e){ e.preventDefault(); e.stopPropagation(); commitNote(); },true);
    noteInput.addEventListener('keydown',function(e){
      e.stopPropagation();
      if (e.key==='Enter'){ e.preventDefault(); commitNote(); }
      else if (e.key==='Escape'){ e.preventDefault(); closeNote(); hide(); }
    },true);
    // Typing churns `selectionchange`; without this the bar would re-evaluate
    // and re-place itself under the caret on every keystroke.
    noteInput.addEventListener('keyup',function(e){ e.stopPropagation(); },true);
    noteRow.appendChild(noteInput);
    noteRow.appendChild(go);
    bar.appendChild(noteRow);
    root.appendChild(bar);
    return bar;
  }
  function attach(){
    if (!host) build();
    // Re-attach after an SPA swapped the document out from under us.
    if (!host.isConnected){ try{ document.documentElement.appendChild(host); }catch(e){} }
  }
  // A Redline "View" filter tints the whole html subtree, ours included. The
  // dark preset is invert+hue-rotate, which is its own inverse — applying it
  // again on the bar hands back the colours as authored. The tint-only presets
  // (sepia/gray/dim/contrast) are left alone: mildly tinted but perfectly legible.
  function counterFilter(){
    var f='';
    try{ var cs=getComputedStyle(document.documentElement); f=cs.webkitFilter||cs.filter||''; }catch(e){}
    var v=/invert/.test(f)?'invert(100%) hue-rotate(180deg)':'';
    bar.style.webkitFilter=v; bar.style.filter=v;
  }
  function place(r){
    attach();
    counterFilter();
    bar.style.display='flex';
    bar.style.visibility='hidden';
    bar.style.top='0px'; bar.style.left='0px';
    var w=bar.offsetWidth, h=bar.offsetHeight;
    var sx=window.pageXOffset||0, sy=window.pageYOffset||0;
    var vw=window.innerWidth||0, vh=window.innerHeight||0;
    var top=r.top-h-10;                                  // above the passage…
    if (top<8) top=Math.min(vh-h-8, r.bottom+10);        // …flipped below when there's no room
    top=Math.max(8, top);
    var left=Math.max(8, Math.min(r.left+r.width/2-w/2, vw-w-8));
    bar.style.top=Math.round(top+sy)+'px';
    bar.style.left=Math.round(left+sx)+'px';
    bar.style.visibility='visible';
  }
  function closeNote(){
    composing=false;
    if (noteRow){ noteRow.style.display='none'; noteInput.value=''; }
  }
  function hide(){ closeNote(); if (bar) bar.style.display='none'; }
  function openNote(mode){
    noteMode=mode;
    if (!pending) return;
    composing=true;
    var excerpt=pending.text.length>24 ? pending.text.slice(0,24)+'…' : pending.text;
    noteInput.placeholder=(mode==='ask'?'Ask about “':'What about “')+excerpt+'”?';
    noteInput.maxLength=mode==='ask'?2000:500;
    noteGo.textContent=mode==='ask'?'Ask':'Add';
    noteRow.style.display='flex';
    // Re-place: the bar just grew a row and would otherwise overlap the passage.
    var r=null;
    try{ r=rectOf(window.getSelection()); }catch(e){}
    if (r) place(r);
    try{ noteInput.focus(); noteInput.select(); }catch(e){}
  }
  function commitNote(){
    var note=flat(noteInput.value);
    if (!note){ try{ noteInput.focus(); }catch(e){} return; }
    emit(noteMode, note.slice(0,noteMode==='ask'?2000:500));
  }
  function evaluate(){
    if (off()){ pending=null; publish(); hide(); return; }
    // Mid-note the selection is not the question any more — the field is. Any
    // re-evaluation here would move the bar out from under the user's caret.
    if (composing) return;
    if (Date.now()<suppressUntil) return;
    var s=null;
    try{ s=window.getSelection(); }catch(e){}
    if (!s || s.isCollapsed || !s.rangeCount){ pending=null; publish(); hide(); return; }
    if (editable(s.anchorNode) || editable(s.focusNode)){ pending=null; publish(); hide(); return; }
    var text=clean(s.toString());
    if (text.length<MINLEN){ pending=null; publish(); hide(); return; }
    var r=rectOf(s);
    if (!r){ pending=null; publish(); hide(); return; }
    if (text.length>MAXLEN) text=text.slice(0,MAXLEN);
    pending={ text:text, url:location.href, title:document.title||'', locator:describe(s) };
    publish();
    place(r);
  }
  function schedule(ms){
    if (timer) clearTimeout(timer);
    timer=setTimeout(function(){ timer=0; evaluate(); }, ms);
  }
  // `navigator.clipboard` needs a secure context and can be refused outright in
  // a WKWebView; the legacy path runs inside the click's user activation and
  // just works. Selecting the scratch textarea churns the page selection, hence
  // the short suppression window so the flash isn't eaten by `selectionchange`.
  function copyText(t){
    var ta=document.createElement('textarea');
    ta.value=t;
    ta.setAttribute('readonly','');
    ta.style.cssText='position:fixed;top:-2000px;left:-2000px;opacity:0';
    (document.body||document.documentElement).appendChild(ta);
    var ok=false;
    try{ ta.select(); ta.setSelectionRange(0,ta.value.length); ok=document.execCommand('copy'); }catch(e){}
    try{ ta.parentNode.removeChild(ta); }catch(e){}
    return ok;
  }
  function emit(action,note){
    var p=pending;
    if (!p){ hide(); return; }
    var q=window.__redline_selections=window.__redline_selections||[];
    q.push({ id:++seq, action:action, text:p.text, url:p.url, title:p.title,
             note:note||'', locator:p.locator||null });
    if (q.length>MAXQ) q.splice(0,q.length-MAXQ);   // bound if the pane isn't draining
    pending=null;
    publish();
    hide();
    // Collapse the selection, and not only for the visual "that landed" beat:
    // the `mouseup` preceding this click has already scheduled an evaluate, and
    // with the range still live that pass would pop the bar straight back up.
    try{ window.getSelection().removeAllRanges(); }catch(e){}
  }
  function pick(action,btn){
    var p=pending;
    if (!p){ hide(); return; }
    if (action==='copy'){
      suppressUntil=Date.now()+1200;
      var was=btn.textContent;
      btn.textContent=copyText(p.text)?'Copied':'Copy failed';
      setTimeout(function(){ try{ btn.textContent=was; }catch(e){} hide(); },700);
      return;
    }
    // ＋ List asks for the note first; every other action is already a complete
    // instruction and goes straight out.
    if (action==='list'||action==='ask'){ openNote(action); return; }
    emit(action,'');
  }

  document.addEventListener('selectionchange',function(){ schedule(180); },true);
  document.addEventListener('mouseup',function(){ schedule(10); },true);
  document.addEventListener('keyup',function(e){
    if (composing) return;
    if (e.shiftKey || e.key==='a' || e.metaKey || e.ctrlKey) schedule(10);
  },true);
  document.addEventListener('mousedown',function(e){
    if (!bar || bar.style.display==='none') return;
    var path=(e.composedPath&&e.composedPath())||[];
    if (host && path.indexOf(host)!==-1) return;      // a click on the bar itself
    hide();
  },true);
  // The bar is positioned in PAGE coordinates, so it rides a scroll correctly;
  // hiding is a deliberate "you've moved on" — which a half-typed note is not.
  window.addEventListener('scroll',function(){ if (!composing) hide(); },true);
  window.addEventListener('resize',function(){ if (!composing) hide(); });
  document.addEventListener('keydown',function(e){
    if (composing) return;                            // the field owns Escape
    if (e.key==='Escape'||e.keyCode===27) hide();
  },true);
})();"##
}

/// Take the selection action bar off the already-loaded page. Eval'd (never
/// registered) whenever `install_user_scripts` runs with the toggle off, so
/// unchecking "Highlight actions" is felt on the page you're reading rather
/// than on the next navigation. The flag is what the installed shim checks, so
/// this survives the fact that we can't un-run an IIFE.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn selection_teardown_js() -> &'static str {
    r##"(function(){
  try{ window.__redline_sel_off = true; }catch(e){}
  // With the bar gone the user can no longer see OR clear what they have
  // highlighted, so an add must stop silently anchoring to it.
  try{ window.__redline_sel_last = null; }catch(e){}
  try{
    var h=document.querySelector('[data-redline-selection]');
    if (h && h.parentNode) h.parentNode.removeChild(h);
  }catch(e){}
})();"##
}

/// Every document-start user script Redline installs on a browser tab, as
/// `(source, main_frame_only)`. Pure and platform-independent on purpose: the
/// objc registration below can't be unit-tested, but *which* scripts a given
/// (filter, toggle) pair produces is exactly the part worth a test.
///
/// The fullscreen and new-tab shims run in EVERY frame (the embed handshake and
/// a `target="_blank"` link in a sub-frame both need that); the selection bar
/// and the view filter are main-frame only, so ad/embed iframes neither sprout
/// a second bar nor get inverted.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn browser_user_scripts(css: &str, selection_actions: bool) -> Vec<(String, bool)> {
    let mut out = vec![
        (include_str!("browser_signals.js").to_string(), true),
        (include_str!("browser_frontdoor_shortcut.js").to_string(), false),
        (fullscreen_shim_js().to_string(), false),
        (newtab_shim_js().to_string(), false),
    ];
    if selection_actions {
        out.push((selection_shim_js().to_string(), true));
    }
    if !css.is_empty() {
        out.push((view_inject_js(css), true));
    }
    out
}

/// Add one document-start `WKUserScript` to a content controller. SAFETY: caller
/// is on the UI thread inside `with_webview`; `ucc` is the live
/// `WKUserContentController`. injectionTime 0 = AtDocumentStart. The controller
/// retains the script, so we release our alloc/init +1.
#[cfg(target_os = "macos")]
unsafe fn add_user_script(
    ucc: *mut objc2::runtime::AnyObject,
    source: &str,
    main_frame_only: bool,
) {
    let ns_source = ns_string(source);
    let cls = objc2::class!(WKUserScript);
    let script: *mut objc2::runtime::AnyObject = objc2::msg_send![cls, alloc];
    let script: *mut objc2::runtime::AnyObject = objc2::msg_send![
        script,
        initWithSource: ns_source,
        injectionTime: 0isize,
        forMainFrameOnly: objc2::runtime::Bool::new(main_frame_only),
    ];
    let _: () = objc2::msg_send![ucc, addUserScript: script];
    let _: () = objc2::msg_send![script, release];
}

/// Install Redline's document-start user scripts on a browser tab, replacing any
/// previously installed ones. `browser_user_scripts` decides the set; this
/// function is only the objc registration plus an eval of each source into the
/// already-loaded page, so a toggle takes effect on the page you're reading
/// rather than on the next navigation. Centralizing it keeps `browser_set_view`
/// from wiping the shims when it swaps filters.
///
/// Two sources are eval'd but never registered, because they exist to *undo*
/// something on the live page: `view_inject_js("")` strips the filter stylesheet
/// on a reset (skipping it left "Reset to normal" visually stuck), and
/// `selection_teardown_js` takes down the highlight bar when the toggle is off.
#[cfg(target_os = "macos")]
fn install_user_scripts(
    wv: &tauri::Webview,
    css: &str,
    selection_actions: bool,
) -> Result<(), String> {
    let scripts = browser_user_scripts(css, selection_actions);
    let mut evals: Vec<String> = scripts.iter().map(|(src, _)| src.clone()).collect();
    if css.is_empty() {
        evals.push(view_inject_js(css));
    }
    if !selection_actions {
        evals.push(selection_teardown_js().to_string());
    }
    let registered = scripts;
    wv.with_webview(move |pw| {
        let ptr = pw.inner() as *mut objc2::runtime::AnyObject;
        // SAFETY: `with_webview` runs on the UI thread and `inner()` is the live
        // WKWebView. We manage exactly our own user scripts here;
        // `removeAllUserScripts` only clears this tab's controller, and these
        // external-content browser webviews don't depend on injected Tauri init
        // scripts after creation (navigation/eval/url go through native commands).
        unsafe {
            let Some(webview) = ptr.as_ref() else { return };
            let config: *mut objc2::runtime::AnyObject = objc2::msg_send![webview, configuration];
            let ucc: *mut objc2::runtime::AnyObject =
                objc2::msg_send![config, userContentController];
            let _: () = objc2::msg_send![ucc, removeAllUserScripts];
            for (source, main_frame_only) in &registered {
                add_user_script(ucc, source, *main_frame_only);
            }
        }
    })
    .map_err(|e| e.to_string())?;
    for source in &evals {
        wv.eval(source).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Apply (or clear) a Redline "View" filter — dark mode, sepia, dim, etc. — to
/// a browser tab. The stylesheet is installed as a document-start `WKUserScript`
/// on the tab's WKWebView so it's painted before first frame on every load (no
/// flicker across navigation), and is also eval'd into the current page so the
/// toggle takes effect immediately. An empty `css` clears the filter. macOS-
/// only; a no-op elsewhere. The CSS comes from the pane's own presets.
#[tauri::command]
fn browser_set_view(
    app: AppHandle,
    label: String,
    css: String,
    selection_actions: Option<bool>,
) -> Result<(), String> {
    let wv = app
        .get_webview(&label)
        .ok_or_else(|| format!("browser webview '{label}' not found"))?;
    #[cfg(target_os = "macos")]
    {
        // Reinstall ALL of Redline's user scripts (shims + selection bar + this
        // filter) so swapping the filter never drops one of the others —
        // `install_user_scripts` rebuilds the whole set from scratch.
        install_user_scripts(&wv, &css, selection_actions.unwrap_or(true))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (wv, css, selection_actions);
    }
    Ok(())
}

/// Evaluate `script` in a browser tab and route WKWebView's
/// `evaluateJavaScript:completionHandler:` result back to the caller through a
/// completion block. The script MUST evaluate to a string (WKWebView hands the
/// result back as an NSString; a non-string return coerces to ""). This is the
/// machinery behind the generic `browser_eval_result` command. macOS-only.
#[cfg(target_os = "macos")]
async fn eval_with_result(app: &AppHandle, label: &str, script: &str) -> Result<String, String> {
    use std::sync::{Arc, Mutex};
    let wv = app
        .get_webview(label)
        .ok_or_else(|| format!("browser webview '{label}' not found"))?;
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
    let tx = Arc::new(Mutex::new(Some(tx)));
    let tx_cb = tx.clone();
    let script = script.to_owned();
    wv.with_webview(move |pw| {
        let ptr = pw.inner() as *mut objc2::runtime::AnyObject;
        let handler = block2::RcBlock::new(
            move |result: *mut objc2::runtime::AnyObject,
                  _err: *mut objc2::runtime::AnyObject| {
                // SAFETY: WKWebView invokes the completion handler on the UI
                // thread; `result` is an NSString (our script returns one) or
                // null on failure.
                let out = unsafe {
                    if result.is_null() {
                        String::new()
                    } else {
                        let c: *const std::os::raw::c_char =
                            objc2::msg_send![result, UTF8String];
                        if c.is_null() {
                            String::new()
                        } else {
                            std::ffi::CStr::from_ptr(c).to_string_lossy().into_owned()
                        }
                    }
                };
                if let Some(s) = tx_cb.lock().unwrap().take() {
                    let _ = s.send(Ok(out));
                }
            },
        );
        // SAFETY: runs on the UI thread via `with_webview`; `inner()` hands
        // back the live WKWebView. WKWebView copies the completion block, so
        // it outlives this `RcBlock` drop at the end of the closure.
        unsafe {
            let Some(webview) = ptr.as_ref() else {
                if let Some(s) = tx.lock().unwrap().take() {
                    let _ = s.send(Err("browser webview gone".into()));
                }
                return;
            };
            let js = ns_string(&script);
            let _: () = objc2::msg_send![
                webview,
                evaluateJavaScript: js,
                completionHandler: &*handler,
            ];
        }
    })
    .map_err(|e| e.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(3), rx).await
        .map_err(|_| "Page evaluation timed out".to_string())?
        .map_err(|_| "page eval cancelled".to_string())?
}

/// Evaluate a self-contained JS program in a browser tab and return its STRING
/// result (unlike fire-and-forget `browser_eval`). Used to poll page state such
/// as the in-window fullscreen flag set by the injected shim.
/// The program must return a string — non-string results coerce to "". macOS-only.
#[tauri::command(async)]
async fn browser_eval_result(
    app: AppHandle,
    label: String,
    script: String,
) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        eval_with_result(&app, &label, &script).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, label, script);
        Err("scrape is only supported on macOS".into())
    }
}

// ---------------------------------------------------------------------------
// Polis ledger commands (Phase 1)
// ---------------------------------------------------------------------------

/// Most-recent-first ledger events for the Ledger pane.
#[tauri::command]
fn ledger_list_events(
    store: tauri::State<'_, SessionStore>,
    limit: Option<i64>,
) -> Result<Vec<ledger::LedgerEventRow>, String> {
    store
        .database()
        .list_ledger_events(limit.unwrap_or(1000))
        .map_err(|e| e.to_string())
}

/// Re-walk the hash chain and report whether it verifies (and the first bad seq
/// if not).
#[tauri::command]
fn ledger_verify(store: tauri::State<'_, SessionStore>) -> Result<ledger::ChainVerdict, String> {
    store
        .database()
        .verify_ledger_chain()
        .map_err(|e| e.to_string())
}

/// Fetch a stored prompt body by id (the Ledger pane's body viewer).
#[tauri::command]
fn ledger_prompt_body(
    store: tauri::State<'_, SessionStore>,
    id: i64,
) -> Result<Option<String>, String> {
    store.database().get_prompt_body(id).map_err(|e| e.to_string())
}

/// `(prompt_id, model)` for every prompt with a recorded model — the Memory
/// inspector joins this onto its event rows for the per-row model chip and the
/// model filter. Off the main thread (`OFF_MAIN_COMMANDS`): a full-table scan
/// that grows with the lake.
#[tauri::command]
fn ledger_prompt_models(
    store: tauri::State<'_, SessionStore>,
) -> Result<Vec<(i64, String)>, String> {
    store
        .database()
        .list_prompt_models()
        .map_err(|e| e.to_string())
}

/// Filtered, cursor-paged Timeline query — the Memory surface's spine.
/// `ledger_list_events` above keeps its single capped read for the pill's
/// quick inspector; this one chains pages via `filters.before_seq`, so the
/// whole history is reachable. Off the main thread (`OFF_MAIN_COMMANDS`): pages
/// join provenance per row.
#[tauri::command]
fn ledger_query(
    store: tauri::State<'_, SessionStore>,
    filters: context::LedgerFilters,
) -> Result<Vec<context::TimelineItem>, String> {
    context::query_ledger(&store.database(), &filters)
}

/// Aggregate counts (per day / surface / kind / class / author) — the Memory
/// surface's facet rails + activity ribbon. Same builder as
/// `GET /v1/context/stats`, one thin caller each.
#[tauri::command]
fn context_stats(store: tauri::State<'_, SessionStore>) -> Result<context::ContextStats, String> {
    Ok(context::build_stats_cached(&store.database()))
}

/// The Map tab's data: classes + sessions as nodes, the four declared edge
/// kinds (Second Brain P5, §3). Data only — the deterministic seeded layout is
/// the frontend's pure `memoryMap.ts`. No route twin: the Map is a GUI-only
/// view, agents keep reading the structured routes.
#[tauri::command]
fn memory_map(store: tauri::State<'_, SessionStore>) -> Result<context::MemoryMapView, String> {
    Ok(context::build_memory_map(&store.database()))
}

/// One session-tree node with parent + child digests — the Timeline's session
/// grouping drill-down. Same assembly as `GET /v1/context/tree/:kind/:id`.
#[tauri::command]
fn context_thread_tree(
    store: tauri::State<'_, SessionStore>,
    kind: String,
    id: String,
) -> Result<serde_json::Value, String> {
    Ok(context::build_thread_tree(&store.database(), &kind, &id))
}

/// Read/write the capture toggle for external harness sessions (default on).
/// The shared ingest observer applies it to every provider's prompt adapter.
#[tauri::command]
fn ledger_get_capture_external(store: tauri::State<'_, SessionStore>) -> bool {
    store
        .database()
        .get_setting("redline.capture.externalSessions")
        .map(|v| v != "false")
        .unwrap_or(true)
}

#[tauri::command]
fn ledger_set_capture_external(
    store: tauri::State<'_, SessionStore>,
    enabled: bool,
) -> Result<(), String> {
    store
        .database()
        .set_setting(
            "redline.capture.externalSessions",
            if enabled { "true" } else { "false" },
        )
        .map_err(|e| e.to_string())
}

/// Record a plan launch, from whichever of Redline's doors made it: the Front
/// Door's one sentence, the Prompt Drafter's document, the browser's Send to
/// Claude Code, or a chat graduating. The plan session doesn't exist yet (claude hasn't
/// spawned), so there's no claude session id here; the launched body is
/// registered against the agent guard so the eventual hook fire for the spawned
/// session doesn't double-record it, and against the launch guard so that same
/// fire can bind this prompt row to the session now running it.
///
/// `origin` is ground truth for `surface`. It used to be hardcoded `"drafter"`,
/// which filed every front-door and browser launch in the lake as a drafter
/// launch — a live provenance bug, since `surface` feeds `resolve_parent` and
/// the Companion's account of what you did.
#[tauri::command]
fn record_plan_launch(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    active_mission: tauri::State<'_, ActiveMission>,
    active_surface: tauri::State<'_, ActiveSurface>,
    markdown: String,
    project_path: Option<String>,
    draft_id: Option<String>,
    // The chat this launch graduated from, when it came from one. Its plan
    // session becomes a CHILD of the conversation in the session tree — the
    // whole payoff of graduating rather than retyping: months later, "why did
    // we build this" walks back from the plan to the talk that produced it.
    chat_id: Option<String>,
    origin: Option<String>,
    // What the LAKE should hold, when that is not what was typed. Only
    // Combine passes it: the typed brief is up to 120 KB of concatenated,
    // machine-written source plans, and a `CorpusRole::User` row with
    // `author: None` is permanently uncompactable
    // (`keeper::select_compaction_candidates` filters `role != "user"`), so
    // filing the brief there would embed and FTS-index a machine blob as if a
    // human had typed it. `None` = record what you typed, which is what every
    // other door does and what makes this change additive.
    record_body: Option<String>,
    // The human's own words inside `record_body`, for the lexical index —
    // the sentence typed into the composer, without the provenance block
    // wrapped around it. `None` everywhere else, where the body IS the
    // human's writing.
    user_text: Option<String>,
    // Which harness this prompt was launched into, and at what model — the
    // door's own pick, known here and nowhere else. Before the backend picker
    // the launch passed no `--model` at all, which is why these were hardcoded
    // `None` below; they are a real answer now.
    backend: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    launch_id: Option<String>,
) -> Result<(), String> {
    let body = markdown.trim().to_string();
    if body.is_empty() {
        return Ok(());
    }
    // An unknown origin degrades to the door that has a document, matching what
    // the caller must have been — never a guess that widens the lie.
    let origin = origin
        .filter(|o| {
            matches!(
                o.as_str(),
                "front-door" | "drafter" | "browser" | "browser-island" | "chat" | "combine" | "front-door-run" | "plan-handoff"
            )
        })
        .unwrap_or_else(|| "drafter".to_string());
    // Qualify the slug with its harness: `opus` and `gpt-5.6-sol` share one
    // column, and a bare slug loses which CLI actually ran it.
    let launch_model = model.as_deref()
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .map(|m| match backend.as_deref().map(str::trim) {
            Some(provider @ ("codex" | "cursor" | "antigravity")) => format!("{provider}/{m}"),
            _ => m,
        });
    let bh = ledger::body_hash(&body);
    let db = store.database();
    let draft_id = draft_id.filter(|d| !d.trim().is_empty());
    let chat_id = chat_id.filter(|c| !c.trim().is_empty());
    // The thread this launch belongs to. A document and a chat are the same
    // shape here — a durable thread the spawned plan session descends from —
    // so one block serves both rather than a second, drifting copy. A chat
    // wins when both are present: `drafterDraftId` is whatever document
    // happens to be open, and inheriting it would file the graduation under an
    // unrelated draft.
    let owner: Option<(&'static str, &String)> = chat_id
        .as_ref()
        .map(|c| ("companion", c))
        .or_else(|| draft_id.as_ref().map(|d| ("drafter", d)));
    let thread = owner.map(|(kind, id)| {
        let surface = active_surface.kind_and_id();
        let parent = ledger::resolve_parent(
            None,
            active_mission.active_id().as_deref(),
            surface.as_ref().map(|(k, i)| (k.as_str(), i.as_str())),
            kind,
        );
        if let Some((pk, pid)) = &parent {
            let _ = ledger::record_session_link(&db, kind, id, pk, pid);
        }
        ledger::ThreadRef {
            thread_kind: kind,
            thread_id: id.clone(),
            parent_session_id: parent
                .filter(|(pk, _)| pk == "session")
                .map(|(_, pid)| pid),
        }
    });
    // What the friction/journal/guard rows key on: the thread that owns this
    // launch, whichever kind it is.
    let owner_id: Option<String> = owner.map(|(_, id)| id.clone());
    // The row's body, and — when it differs — its own hash, which the ingest
    // bind must follow instead of the guard key.
    let record_body = record_body
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty() && *r != body);
    let row_hash = record_body.as_deref().map(ledger::body_hash);
    let user_text = user_text
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    let launch_project = project_path.clone();
    let input = ledger::PromptInput {
        source: ledger::PromptSource::DrafterLaunch,
        origin: ledger::Origin::Redline,
        surface: origin.clone(),
        // Unchanged, and deliberately: this row IS the human's writing. The
        // `role: Agent` variant considered for Combine only existed to
        // contain a machine blob, and no machine blob reaches the lake.
        role: crate::ledger::CorpusRole::User,
        user_text,
        session_id: None,
        claude_session_id: None,
        mission_id: None,
        project_path,
        body: record_body.clone().unwrap_or_else(|| body.clone()),
        thread,
        author: None, // the launched prompt is the human's own writing
        // The door's pick, when it made one. `None` still falls through to the
        // transcript backfill once the session is bound and answering — the
        // only answer available for a launch left on the backend's default,
        // and the reason `model_source` must stay `None` alongside it rather
        // than claim a provenance nobody supplied.
        model: launch_model.clone(),
        model_source: launch_model.as_ref().map(|_| "launch".to_string()),
    };
    // Write the ledger row BEFORE arming either guard. Both guards exist to make
    // the spawned session's own hook fire *skip* this body; arming them first
    // meant a failed write left them armed for the 300s TTL, the hook skipped
    // the prompt, and the prompt existed nowhere at all — the launch succeeded,
    // the plan arrived, and nothing recorded what was asked. Recording first
    // makes the worst case "a prompt with no session link" instead of "no
    // prompt", and `record_friction` gives Shipwright and the Librarian the
    // failure rather than a silence.
    if let Err(e) = ledger::record_prompt(&db, input) {
        let _ = db.record_friction(
            "plan_launch_unrecorded",
            Some(&origin),
            owner_id.as_deref(),
            Some(&e),
        );
        return Err(e);
    }
    // Deliberately the FULL typed body, never the record: this is the hash the
    // spawned session's `UserPromptSubmit` hook will compute, and a miss here
    // means the hook does not skip and files the whole brief as a fresh prompt
    // row — the blob in the lake PLUS a stray short row.
    if let Some(id) = launch_id.as_deref() {
        plan_launch::register(
            id,
            &bh,
            launch_project.as_deref(),
            backend.as_deref(),
            model.as_deref(),
            effort.as_deref(),
        )?;
    }
    ledger::register_agent_prompt(&body);
    ledger::register_plan_launch(
        &bh,
        &origin,
        owner.map(|(k, i)| (k, i.as_str())),
        row_hash.as_deref(),
    );
    let _ = db.append_journal(
        "drafter_launch",
        Some(&origin),
        owner_id.as_deref(),
        None,
        None,
    );
    let _ = app.emit("ledger-changed", ());
    extension_host::publish(
        ext_events::LEDGER_CHANGED,
        &ext_events::LedgerChanged {
            ts_ms: extension_host::now_ms(),
        },
    );
    Ok(())
}

/// Persist the drafter's document. As of the Bookshelf this writes the **real
/// document** (`doc_json`, the TipTap fidelity source) as well as the markdown
/// mirror agents read via `GET /v1/drafter/:id/doc`. Called on the drafter's
/// existing 400ms persist debounce; the title is derived here (first ATX
/// heading, else first non-blank line) so the frontend sends only the content.
///
/// On the blocking pool (`OFF_MAIN_COMMANDS`) because it now serializes a whole
/// TipTap document on that debounce — perf-budget rule 4 governs exactly this,
/// and `codehealth`'s own `command_hygiene` probe would flag it otherwise.
#[tauri::command]
fn drafter_set_doc(
    store: tauri::State<'_, SessionStore>,
    draft_id: String,
    markdown: String,
    doc_json: Option<String>,
    project_path: Option<String>,
) -> Result<(), String> {
    if draft_id.trim().is_empty() {
        return Err("missing draft id".to_string());
    }
    let title = draft_title_from_markdown(&markdown);
    store
        .database()
        .upsert_draft(
            &draft_id,
            title.as_deref(),
            project_path.as_deref(),
            &markdown,
            doc_json.as_deref(),
        )
        .map_err(|e| e.to_string())
}

/// Record a contained React render crash. `ErrorBoundary` already catches these
/// and `console.error`s them — which lands in a devtools console nobody has
/// open. Lightweight by design (one bounded insert), so it stays sync.
#[tauri::command]
fn record_render_crash(
    store: tauri::State<'_, SessionStore>,
    region: String,
    message: String,
) -> Result<(), String> {
    let _ = store.database().record_friction(
        "render_crash",
        Some("ui"),
        None,
        Some(&format!("{region}: {message}")),
    );
    Ok(())
}

/// The document the Bookshelf stores: `{docJson, docMarkdown, projectPath}`.
/// `PromptDrafter` loads from here instead of localStorage — localStorage now
/// keeps only the *currently open* draft id, which is a UI preference.
#[tauri::command]
fn drafter_get_doc(
    store: tauri::State<'_, SessionStore>,
    draft_id: String,
) -> Result<serde_json::Value, String> {
    if draft_id.trim().is_empty() {
        return Err("missing draft id".to_string());
    }
    let db = store.database();
    let row = db.get_draft_doc(&draft_id).map_err(|e| e.to_string())?;
    let (doc_json, doc_markdown, project_path) = row.unwrap_or((None, String::new(), None));
    // When the DB last saw a write — what the crash-shadow recovery compares
    // its own stamp against. 0 for a row that doesn't exist yet.
    let updated_at = db
        .get_draft(&draft_id)
        .map_err(|e| e.to_string())?
        .map(|(_, _, _, at)| at)
        .unwrap_or(0);
    Ok(serde_json::json!({
        "docJson": doc_json,
        "docMarkdown": doc_markdown,
        "projectPath": project_path,
        "updatedAt": updated_at,
    }))
}

/// First ATX heading of a draft, else its first non-blank line (trimmed to a
/// display length) — the draft's human label in trees and journals.
pub(crate) fn draft_title_from_markdown(markdown: &str) -> Option<String> {
    for line in markdown.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with("<!--") {
            continue;
        }
        let t = t.trim_start_matches('#').trim();
        if t.is_empty() {
            continue;
        }
        let title: String = t.chars().take(80).collect();
        return Some(title);
    }
    None
}

/// `GET /v1/drafter/:draft_id/doc` — the live draft's markdown mirror, for the
/// drafter's discussion/voice/sidecar agents to re-read mid-conversation.
async fn handle_drafter_doc(
    State(app_state): State<AppState>,
    Path(draft_id): Path<String>,
) -> axum::response::Response {
    let db = app_state.store.database();
    match db.get_draft(&draft_id) {
        Ok(Some((title, project_path, markdown, updated_at))) => Json(serde_json::json!({
            "draftId": draft_id,
            "title": title,
            "projectPath": project_path,
            "markdown": markdown,
            "updatedAt": updated_at,
        }))
        .into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, "no such draft").into_response(),
        Err(e) => browser_error_response(e.to_string()),
    }
}

/// Parse markdown into the plan Section tree — the drafter voice panel's
/// Guided Walkthrough needs the same sections the plan pane gets from its
/// revisions, but a draft has no revision to carry them.
#[tauri::command]
fn parse_markdown_sections(markdown: String) -> Vec<state::Section> {
    parser::parse_plan_with_sidecars(&markdown).0
}

/// A draft's queued (pending) agent suggestions — drained by the drafter on
/// mount so proposals made while the pane was closed render as tracked changes.
#[tauri::command]
fn draft_suggestions_pending(
    store: tauri::State<'_, SessionStore>,
    draft_id: String,
) -> Result<Vec<state::DraftSuggestion>, String> {
    store
        .database()
        .list_pending_draft_suggestions(&draft_id)
        .map_err(|e| e.to_string())
}

/// Resolve a suggestion after the user accepts/rejects its tracked change.
#[tauri::command]
fn draft_suggestion_resolve(
    store: tauri::State<'_, SessionStore>,
    id: String,
    status: String,
) -> Result<bool, String> {
    if status != "applied" && status != "rejected" {
        return Err("status must be applied|rejected".to_string());
    }
    let updated = store
        .database()
        .resolve_draft_suggestion(&id, &status)
        .map_err(|e| e.to_string())?;
    if updated {
        extension_host::publish(
            ext_events::SUGGESTION_RESOLVED,
            &ext_events::SuggestionResolved {
                suggestion_id: id,
                status,
                ts_ms: extension_host::now_ms(),
            },
        );
    }
    Ok(updated)
}

/// Undo-after-accept (harness program A3): return an ACCEPTED suggestion to
/// the pending queue after the drafter reverses the accept in the document.
/// Applied-only — reject removed the marks, so there is nothing to un-resolve
/// back to. No extension event: `SUGGESTION_RESOLVED` announces a verdict,
/// and this is a verdict being taken back, not a new one; the eventual
/// re-resolve publishes normally.
#[tauri::command]
fn draft_suggestion_unresolve(
    store: tauri::State<'_, SessionStore>,
    id: String,
) -> Result<bool, String> {
    store
        .database()
        .unresolve_draft_suggestion(&id)
        .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct DraftSuggestionReq {
    op: String,
    // The contract teaches snake_case, but agents were long taught `blockId`/
    // `agentId` (and some models emit camelCase reflexively) — accept both so
    // a block-addressed op never 400s on casing alone.
    #[serde(default, alias = "blockId")]
    block_id: Option<String>,
    #[serde(default)]
    original: Option<String>,
    #[serde(default)]
    markdown: String,
    #[serde(default, alias = "agentId")]
    agent_id: Option<String>,
    #[serde(default)]
    body: Option<String>,
    /// Set by a sidecar comment-thread agent — scopes its writes to the
    /// comment's anchored block (a thread about one paragraph must never
    /// rewrite the whole prompt). The main discussion agent omits it.
    #[serde(default, alias = "commentId")]
    comment_id: Option<String>,
}

/// `POST /v1/drafter/:draft_id/suggestions` — the drafter agents' write path.
/// Validates against the CURRENT markdown mirror (unknown block / stale
/// `original` → 409, the agent's re-read-and-retry signal), queues the
/// suggestion (`pending`), and emits `drafter-suggestion` so an open drafter
/// renders it as a tracked change immediately; a closed pane drains the queue
/// on mount.
async fn handle_draft_suggestion(
    State(app_state): State<AppState>,
    Path(draft_id): Path<String>,
    Json(req): Json<DraftSuggestionReq>,
) -> axum::response::Response {
    let db = app_state.store.database();
    let mirror = match db.get_draft(&draft_id) {
        Ok(Some((_, _, markdown, _))) => markdown,
        Ok(None) => return (StatusCode::NOT_FOUND, "no such draft").into_response(),
        Err(e) => return browser_error_response(e.to_string()),
    };
    if let Err((code, msg)) = draft_chat::validate_suggestion(
        &mirror,
        &req.op,
        req.block_id.as_deref(),
        req.original.as_deref(),
        &req.markdown,
    ) {
        let status = StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_REQUEST);
        return (status, msg).into_response();
    }
    // Sidecar scope: a comment-thread agent may only touch its anchored block.
    if let Some(cid) = req.comment_id.as_deref().filter(|s| !s.trim().is_empty()) {
        let anchored = match db.get_draft_comment(cid) {
            Ok(Some(c)) if c.draft_id == draft_id => c.block_id,
            Ok(_) => {
                return (StatusCode::NOT_FOUND, "no such comment on this draft").into_response()
            }
            Err(e) => return browser_error_response(e.to_string()),
        };
        let Some(anchored) = anchored.filter(|b| !b.trim().is_empty()) else {
            return (
                StatusCode::FORBIDDEN,
                "this comment has no anchored block — discuss instead of editing",
            )
                .into_response();
        };
        let bare = |s: &str| s.trim().trim_start_matches("blk-").to_string();
        let target = req.block_id.as_deref().map(bare);
        if req.op == "append" || target.as_deref() != Some(bare(&anchored).as_str()) {
            return (
                StatusCode::FORBIDDEN,
                format!(
                    "a comment thread may only propose edits to its anchored block \
                     (`{anchored}`) — replace_block / insert_after / delete_block on \
                     that block only"
                ),
            )
                .into_response();
        }
    }
    let suggestion = state::DraftSuggestion {
        id: uuid::Uuid::new_v4().to_string(),
        draft_id: draft_id.clone(),
        op: req.op,
        block_id: req.block_id,
        original: req.original,
        markdown: req.markdown,
        agent_id: req.agent_id,
        body: req.body,
        status: "pending".to_string(),
        created_at: ledger::now_millis(),
    };
    if let Err(e) = db.insert_draft_suggestion(&suggestion) {
        return browser_error_response(e.to_string());
    }
    let _ = app_state.app_handle.emit("drafter-suggestion", &suggestion);
    (
        StatusCode::CREATED,
        Json(serde_json::json!({
            "id": suggestion.id,
            "status": "pending",
            "note": "queued as a tracked change — the user accepts or rejects it; re-read the doc to see the outcome",
        })),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// Polis Librarian command (Phase 3)
// ---------------------------------------------------------------------------

/// Run the on-demand Librarian agent once: build the ground-truth friction digest
/// from the DB, bake it into the spawn prompt, run the read-only agent headless
/// (MCP stripped, curl bridge), and parse its prioritized checklist back.
/// Read-only — nothing is mutated, so no change events are emitted; the checklist
/// is returned straight to the caller for rendering. Mirrors `classmem_organize`'s
/// spawn/parse shape (cwd = HOME, like the classifier).
#[tauri::command(async)]
async fn librarian_agent(
    store: tauri::State<'_, SessionStore>,
) -> Result<librarian::LibrarianResult, String> {
    let db = store.database();
    let digest = context::build_digest(&db, context::LIMIT_MAX as usize);
    let prompt = librarian::build_librarian_prompt_from_digest(&digest);
    let cwd = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
    let (text, _session) = librarian::run_librarian(&db, &cwd, prompt).await?;
    Ok(librarian::parse_checklist(&text))
}

// ---------------------------------------------------------------------------
// The Shipwright — a grounded self-improvement agent on the Redline repo
// ---------------------------------------------------------------------------

/// The Shipwright's persistent session id, so consults and L1 follow-ups land
/// in the SAME thread as the run they're about. Unlike the one-shot Librarian,
/// the Shipwright is a thread you can come back to — that's what lets the voice
/// agent and Companion *ask* it rather than rebuild its context.
#[derive(Clone, Default)]
struct ShipwrightSession(Arc<std::sync::Mutex<Option<String>>>);

impl ShipwrightSession {
    fn get(&self) -> Option<String> {
        self.0.lock().ok().and_then(|g| g.clone())
    }
    fn set(&self, sid: Option<String>) {
        if let (Ok(mut g), Some(sid)) = (self.0.lock(), sid) {
            *g = Some(sid);
        }
    }
}

/// What a Shipwright run produced, plus where it landed.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ShipwrightRun {
    summary: String,
    findings: Vec<shipwright::Finding>,
    /// The Bookshelf document the findings landed in. A **new** document every
    /// run — the user's current draft is never touched.
    draft_id: String,
    /// The rev the digest measured, so the UI can say so without re-deriving.
    short_rev: String,
    /// Findings skipped because an identical `(category, summary)` already
    /// exists — including one the user dismissed.
    duplicates: usize,
}

/// Run the Shipwright once: build the ground-truth code digest, bake it into the
/// spawn prompt, run the read-only agent headless against the repo, parse its
/// findings, persist them (deduped), and land them as a **new** Bookshelf
/// document the user trims and launches.
///
/// Read-only with respect to the repo at every step. The only writes are to
/// Redline's own DB: the findings and the document they became.
#[tauri::command(async)]
async fn shipwright_agent(
    store: tauri::State<'_, SessionStore>,
    session: tauri::State<'_, ShipwrightSession>,
    repo_path: Option<String>,
    folder_id: Option<String>,
) -> Result<ShipwrightRun, String> {
    let db = store.database();
    let repo = repo_path
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| {
            std::env::current_dir()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| ".".to_string())
        });
    let digest = {
        let db = db.clone();
        let repo = repo.clone();
        tokio::task::spawn_blocking(move || codehealth::build_code_digest(&db, &repo))
            .await
            .map_err(|e| e.to_string())?
    };
    let prompt = shipwright::build_shipwright_prompt_from_digest(&digest);
    let prior = session.get();
    let (text, sid) = shipwright::run_shipwright(&db, &repo, prompt, prior.as_deref()).await?;
    session.set(sid);
    let result = shipwright::parse_findings(&text);

    // Land the findings as a NEW document — the user's open draft is untouched.
    let run_id = uuid::Uuid::new_v4().to_string();
    let draft_id = uuid::Uuid::new_v4().to_string();
    let markdown = shipwright::findings_to_markdown(&result, &digest);
    let title = draft_title_from_markdown(&markdown);
    db.upsert_draft(
        &draft_id,
        title.as_deref(),
        Some(&repo),
        &markdown,
        // No TipTap body yet: the drafter builds one from the markdown when the
        // document is first opened. `doc_markdown` is what agents read either way.
        None,
    )
    .map_err(|e| e.to_string())?;
    if let Some(folder) = folder_id.as_deref().filter(|f| !f.trim().is_empty()) {
        let _ = db.move_draft(&draft_id, Some(folder));
    }

    let now = ledger::now_millis();
    let mut duplicates = 0usize;
    for f in &result.findings {
        let row = db::ShipwrightFinding {
            id: uuid::Uuid::new_v4().to_string(),
            run_id: run_id.clone(),
            category: f.category.clone(),
            summary: f.title.clone(),
            evidence: Some(f.evidence.clone()),
            proposal: Some(f.proposal.clone()),
            guard: Some(f.guard.clone()),
            files: serde_json::to_string(&f.files).ok(),
            status: "pending".to_string(),
            dismissed: false,
            draft_id: Some(draft_id.clone()),
            created_at: now,
            resolved_at: None,
        };
        match db.insert_shipwright_finding(&row) {
            Ok(None) => duplicates += 1,
            Ok(Some(_)) => {}
            Err(e) => tracing::warn!(error = %e, "failed to persist a Shipwright finding"),
        }
    }
    let _ = db.append_journal(
        "shipwright_run",
        Some("drafter"),
        Some(&draft_id),
        title.as_deref(),
        Some(&format!("{} finding(s)", result.findings.len())),
    );

    Ok(ShipwrightRun {
        summary: result.summary,
        findings: result.findings,
        draft_id,
        short_rev: digest.git.short_rev,
        duplicates,
    })
}

/// `GET /v1/context/codehealth` — the same digest as JSON, so an agent can
/// re-read it mid-conversation. The Shipwright never *depends* on this (its
/// digest is baked into the spawn prompt); it is for the Companion, the voice
/// agent, and the external MCP surface.
async fn handle_context_codehealth(
    State(app_state): State<AppState>,
    axum::extract::Query(q): axum::extract::Query<CodeHealthQ>,
) -> axum::response::Response {
    let db = app_state.store.database();
    let repo = q.repo.filter(|p| !p.trim().is_empty()).unwrap_or_else(|| {
        std::env::current_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| ".".to_string())
    });
    match tokio::task::spawn_blocking(move || codehealth::build_code_digest(&db, &repo)).await {
        Ok(digest) => Json(digest).into_response(),
        Err(e) => browser_error_response(e.to_string()),
    }
}

#[derive(Deserialize)]
struct CodeHealthQ {
    repo: Option<String>,
}

// ---------------------------------------------------------------------------
// Polis context access + portability commands (Phase 4)
// ---------------------------------------------------------------------------

/// The copyable `~/.claude.json` MCP snippet, the daemon's MCP URL and the
/// one-line `claude mcp add`, for the settings surface. External `claude`
/// sessions reach the memory over the daemon's `/mcp` (streamable HTTP, read
/// tools only); internal agents never use MCP (they keep `--strict-mcp-config`).
#[tauri::command]
fn mcp_config_snippet() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "snippet": mcp::claude_config_snippet(),
        "url": mcp::MCP_URL,
        "command": mcp::claude_add_command(),
    }))
}

/// Export a verifiable context bundle to a file the user picks. `scope` is one
/// of `session|mission|class|full`; `id` is required for the first three. The
/// bundle re-verifies from the file alone (each event self-certifies via its
/// `entry_hash`). A session-scoped export records F6 state so the Librarian can
/// stop flagging that plan as un-exported. Returns the saved path, or `None` if
/// the save dialog was cancelled.
#[tauri::command]
fn export_context_bundle(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    scope: String,
    id: Option<String>,
) -> Result<Option<String>, String> {
    let need_id = |id: Option<String>| {
        id.filter(|s| !s.trim().is_empty())
            .ok_or_else(|| format!("the `{scope}` scope needs an id"))
    };
    let bundle_scope = match scope.as_str() {
        "session" => bundle::BundleScope::Session(need_id(id.clone())?),
        "mission" => bundle::BundleScope::Mission(need_id(id.clone())?),
        "class" => bundle::BundleScope::Class(need_id(id.clone())?),
        "full" => bundle::BundleScope::Full,
        other => return Err(format!("unknown bundle scope `{other}`")),
    };

    // Build the bundle in a scoped block so no DB access is held across the
    // (blocking) save dialog.
    let (json_bytes, file_name, head_hash) = {
        let db = store.database();
        let b = bundle::build_bundle(&db, &bundle_scope)?;
        // Never ship a bundle that doesn't re-verify from itself — the whole
        // point is a portable, independently-checkable artifact.
        let verdict = bundle::verify_bundle(&b);
        if !verdict.ok {
            return Err(format!(
                "refusing to export: the bundle failed self-verification (first bad seq {:?})",
                verdict.first_bad_seq
            ));
        }
        let head = b.head_hash.clone();
        let name = format!("redline-context-{}.json", bundle_scope.kind());
        let js = serde_json::to_string_pretty(&b).map_err(|e| e.to_string())?;
        (js, name, head)
    };

    let picked = app
        .dialog()
        .file()
        .add_filter("JSON bundle", &["json"])
        .set_file_name(&file_name)
        .blocking_save_file();
    let Some(fp) = picked else {
        return Ok(None); // user cancelled
    };
    let path = fp.into_path().map_err(|e| format!("invalid save path: {e}"))?;
    std::fs::write(&path, json_bytes).map_err(|e| e.to_string())?;

    // F6: mark a session-scoped export so the Librarian's un-exported signal
    // clears for that plan. (Mission/class/full aren't per-plan; not recorded.)
    if let Some(sid) = bundle_scope.session_id() {
        let db = store.database();
        let _ = db.record_plan_export(sid, "session", Some(&head_hash));
        let _ = app.emit("ledger-changed", ());
        extension_host::publish(
            ext_events::LEDGER_CHANGED,
            &ext_events::LedgerChanged {
                ts_ms: extension_host::now_ms(),
            },
        );
    }
    tracing::info!(path = %path.display(), scope = %scope, "exported context bundle");
    Ok(Some(path.to_string_lossy().to_string()))
}

/// Current mirror status for the settings surface.
#[tauri::command]
fn mirror_status(store: tauri::State<'_, SessionStore>) -> Result<mirror::MirrorStatus, String> {
    Ok(mirror::status(&store.database()))
}

/// Point the mirror at a directory chosen via a native folder picker (empty ⇒
/// off). Does a full sync so the directory immediately reflects the ledger.
#[tauri::command]
fn pick_mirror_dir(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
) -> Result<Option<mirror::MirrorStatus>, String> {
    let picked = app.dialog().file().blocking_pick_folder();
    let Some(dir) = picked else {
        return Ok(None); // cancelled
    };
    let path = dir.into_path().map_err(|e| format!("invalid folder: {e}"))?;
    let st = mirror::set_dir(&store.database(), &path.to_string_lossy())?;
    let _ = app.emit("mirror-changed", ());
    Ok(Some(st))
}

/// Set (or clear, when empty) the mirror directory by path.
#[tauri::command]
fn set_mirror_dir(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    dir: String,
) -> Result<mirror::MirrorStatus, String> {
    let st = mirror::set_dir(&store.database(), &dir)?;
    let _ = app.emit("mirror-changed", ());
    Ok(st)
}

/// Rebuild the configured mirror from scratch (the recovery path if it drifts).
#[tauri::command]
fn mirror_rebuild(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
) -> Result<mirror::MirrorStatus, String> {
    let st = mirror::rebuild_configured(&store.database())?;
    let _ = app.emit("mirror-changed", ());
    Ok(st)
}

/// Sync any new ledger events into the mirror now (also runs on a timer).
#[tauri::command]
fn mirror_sync(
    store: tauri::State<'_, SessionStore>,
) -> Result<mirror::MirrorStatus, String> {
    let db = store.database();
    mirror::sync_if_enabled(&db);
    Ok(mirror::status(&db))
}

/// Scaffold a **dedicated** Obsidian vault for the memory mirror (the Dojo
/// default) and point the mirror at it. The user picks a *parent* location; we
/// create a `Redline Memory/` subfolder there, drop a minimal `.obsidian/` so
/// Obsidian opens it cleanly as its own vault (keeping Redline's notes out of the
/// user's existing graph), then reuse `mirror::set_dir` — which does the initial
/// full sync. Returns `None` if the picker was cancelled. Safe by construction:
/// the mirror is one-way and namespace-scoped, so it never clobbers other notes.
#[tauri::command]
fn create_memory_vault(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
) -> Result<Option<mirror::MirrorStatus>, String> {
    let Some(parent) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None); // cancelled
    };
    let parent = parent.into_path().map_err(|e| format!("invalid folder: {e}"))?;
    let vault = parent.join("Redline Memory");
    // Minimal `.obsidian/` marks the folder as a vault so it opens cleanly; an
    // empty `app.json` is enough (Obsidian fills the rest on first open).
    let obsidian = vault.join(".obsidian");
    std::fs::create_dir_all(&obsidian).map_err(|e| e.to_string())?;
    let app_json = obsidian.join("app.json");
    if !app_json.exists() {
        std::fs::write(&app_json, "{}\n").map_err(|e| e.to_string())?;
    }
    let st = mirror::set_dir(&store.database(), &vault.to_string_lossy())?;
    let _ = app.emit("mirror-changed", ());
    Ok(Some(st))
}

// ---------------------------------------------------------------------------
// Polis ClassMemory commands (Phase 2)
// ---------------------------------------------------------------------------

/// Run one classifier pass: seed roots (idempotent), compute the lake delta
/// since the last completed run, spawn the read-only classifier, parse its
/// structured-JSON proposals, and STAGE them (nothing is accepted). Returns the
/// per-op counts + a summary for the pane.
#[tauri::command(async)]
async fn classmem_organize(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
) -> Result<serde_json::Value, String> {
    let db = store.database();
    let _ = app.emit("classmem-changed", ()); // "running" pulse
    let outcome = classmem::organize_once(&db).await;
    let _ = app.emit("classmem-changed", ());
    let _ = app.emit("ledger-changed", ());
    extension_host::publish(
        ext_events::LEDGER_CHANGED,
        &ext_events::LedgerChanged {
            ts_ms: extension_host::now_ms(),
        },
    );
    let _ = app.emit("memory-changed", ());
    let o = outcome?;
    Ok(serde_json::json!({
        "staged": o.staged,
        "summary": o.summary,
        "autoApplied": o.auto_applied,
        "seqFrom": o.seq_from,
        "seqTo": o.seq_to,
    }))
}

/// The one quiet surface's data source: everything the memory pill + inspector
/// need in a single read. `live` is always true (the keeper is always running);
/// `backlog` is un-organized ledger growth; `chainOk` is a live re-verify.
///
/// Off the main thread (`OFF_MAIN_COMMANDS`) and INCREMENTAL, both
/// deliberately: this fires on a 60s poll and on every browse capture, and it
/// used to re-hash the entire ledger chain on the WebView main thread — the
/// exact shape `perf_guard.rs` exists to catch.
/// The full chain walk still runs, on the 6h `ledger-backup` keeper watch.
#[tauri::command]
fn memory_status(store: tauri::State<'_, SessionStore>) -> Result<serde_json::Value, String> {
    let db = store.database();
    let max_seq = db.max_ledger_seq().map_err(|e| e.to_string())?;
    let last_to = db.last_run_seq_to().map_err(|e| e.to_string())?;
    let run = db.latest_class_run().map_err(|e| e.to_string())?;
    let (last_organized_ts, last_summary) = match run {
        Some(r) if r.status == "done" => (r.finished_at, r.summary),
        _ => (None, None),
    };
    let chain = db
        .verify_ledger_chain_incremental()
        .map_err(|e| e.to_string())?;
    let (compacted, reclaimed, last_compaction_ts) =
        db.compaction_stats().map_err(|e| e.to_string())?;
    // The gardener's work queue (B3): structural proposals waiting for a run
    // — a fact the surface reports, never a count "to review".
    let queued_proposals = db
        .count_pending_class_proposals()
        .map_err(|e| e.to_string())?;
    // Corpus composition — the number that was missing. Reported as rows AND
    // bytes per role, because the two tell different stories: 397 machine rows
    // out of 1,213 is a third of the corpus by count and 92.6% of it by weight.
    let composition = db.corpus_composition().map_err(|e| e.to_string())?;
    let corpus_roles: Vec<serde_json::Value> = composition
        .iter()
        .map(
            |(role, rows, bytes)| serde_json::json!({ "role": role, "rows": rows, "bytes": bytes }),
        )
        .collect();
    let corpus_bytes: i64 = composition.iter().map(|(_, _, b)| *b).sum();
    let user_bytes: i64 = composition
        .iter()
        .filter(|(r, _, _)| r == "user")
        .map(|(_, _, b)| *b)
        .sum();
    let (gist_agent, gist_deterministic) = db.gist_source_counts().map_err(|e| e.to_string())?;
    let (archived_rows, archived_bytes) = db.archive_stats().map_err(|e| e.to_string())?;
    let (prefetch_hits, prefetch_turns) = db.prefetch_hit_rate().map_err(|e| e.to_string())?;
    // A HALF-BUILT semantic index degrades recall silently, so it is reported
    // rather than inferred: `pending` is the honest counterpart to `chunks`,
    // and `provider: "absent"` says the arm cannot run at all — which is a fact
    // about this machine, not about the user's history.
    let embeddings = match embed::provider_for(&db) {
        Some(p) => {
            let (chunks, pending) = db.embedding_stats(&p.model_id()).map_err(|e| e.to_string())?;
            serde_json::json!({
                "provider": embed::provider_kind().as_str(),
                "model": p.model_id(),
                "chunks": chunks,
                "pending": pending,
            })
        }
        None => serde_json::json!({
            "provider": embed::ProviderKind::Absent.as_str(),
            "model": null, "chunks": 0, "pending": 0,
        }),
    };
    Ok(serde_json::json!({
        "live": true,
        "itemCount": max_seq,
        "backlog": (max_seq - last_to).max(0),
        "lastOrganizedTs": last_organized_ts,
        "lastOrganizedSummary": last_summary,
        "chainOk": chain.ok,
        "compactedCount": compacted,
        "reclaimedBytes": reclaimed,
        "lastCompactionTs": last_compaction_ts,
        "queuedProposals": queued_proposals,
        "corpusRoles": corpus_roles,
        "corpusBytes": corpus_bytes,
        "corpusUserBytes": user_bytes,
        "keeperGistSource": { "agent": gist_agent, "deterministic": gist_deterministic },
        "archivedCount": archived_rows,
        "archivedBytes": archived_bytes,
        "askPrefetch": { "hits": prefetch_hits, "turns": prefetch_turns },
        "embeddings": embeddings,
    }))
}

/// Set (or clear) the embedding provider. Changing it invalidates the index —
/// vectors from two models are not comparable — so this drops them and lets the
/// keeper rebuild, which is safe precisely because the index is derived.
///
/// The key is stored in `app_settings` and read only in Rust; it never crosses
/// into the webview, and the network call is made from here. Same shape as the
/// premium TTS engines (`tts.rs`).
#[tauri::command]
fn memory_set_embed_provider(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    provider: String,
    key: Option<String>,
) -> Result<(), String> {
    let db = store.database();
    let provider = provider.trim();
    if !matches!(provider, "local" | "openai" | "") {
        return Err(format!("unknown embedding provider `{provider}`"));
    }
    db.set_setting(embed::SETTING_EMBED_PROVIDER, provider)
        .map_err(|e| e.to_string())?;
    if let Some(k) = key {
        db.set_setting(embed::SETTING_EMBED_KEY, k.trim())
            .map_err(|e| e.to_string())?;
    }
    // Two models' vectors are not comparable, so the old ones go.
    let _ = db.clear_embeddings();
    let _ = app.emit("memory-changed", ());
    Ok(())
}

/// What the settings row shows: the configured provider and whether a key is
/// present. The key itself is NEVER returned — only whether one is set.
#[tauri::command]
fn memory_embed_settings(
    store: tauri::State<'_, SessionStore>,
) -> Result<serde_json::Value, String> {
    let db = store.database();
    Ok(serde_json::json!({
        "provider": db
            .get_setting(embed::SETTING_EMBED_PROVIDER)
            .unwrap_or_else(|| "local".to_string()),
        "hasKey": db
            .get_setting(embed::SETTING_EMBED_KEY)
            .is_some_and(|k| !k.trim().is_empty()),
        "localAvailable": embed::provider_kind() != embed::ProviderKind::Absent,
        "localKind": embed::provider_kind().as_str(),
    }))
}

/// Explicit forget: release a prompt's words now (a manual compaction). The
/// ledger keeps the fact that it happened + the original body hash. Returns the
/// new ledger seq, or `null` if the prompt was already compacted/absent.
#[tauri::command]
fn memory_forget(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    prompt_id: i64,
) -> Result<Option<i64>, String> {
    let db = store.database();
    let seq = db
        .compact_prompt_body(
            prompt_id,
            "[forgotten]",
            "forget",
            keeper::GIST_SOURCE_DETERMINISTIC,
            &ledger::local_author(),
        )
        .map_err(|e| e.to_string())?;
    let _ = app.emit("memory-changed", ());
    let _ = app.emit("ledger-changed", ());
    extension_host::publish(
        ext_events::LEDGER_CHANGED,
        &ext_events::LedgerChanged {
            ts_ms: extension_host::now_ms(),
        },
    );
    Ok(seq)
}

/// Second Brain P3: one note/star act — write or edit a note's text, star or
/// unstar a target, or create a standalone thought (`targetKind` absent /
/// `none`). Exactly one of `text`/`starred` per call: each act appends one
/// `note` ledger event; the readable `user_notes` row updates in place.
/// Rejections (phantom target, no act) surface as command errors.
#[tauri::command]
fn memory_note_write(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    write: context::NoteWrite,
) -> Result<context::UserNote, String> {
    let db = store.database();
    match db
        .write_user_note(&write, &ledger::local_author())
        .map_err(|e| e.to_string())?
    {
        context::NoteOutcome::Written(n) => {
            let _ = app.emit("memory-changed", ());
            let _ = app.emit("ledger-changed", ());
            extension_host::publish(
                ext_events::LEDGER_CHANGED,
                &ext_events::LedgerChanged {
                    ts_ms: extension_host::now_ms(),
                },
            );
            Ok(n)
        }
        // A no-op wrote nothing — nothing to announce.
        context::NoteOutcome::Unchanged(n) => Ok(n),
        context::NoteOutcome::Rejected(why) => Err(why),
    }
}

/// The class tree (flat + link counts); the FE builds the hierarchy.
#[tauri::command]
fn classmem_tree(
    store: tauri::State<'_, SessionStore>,
) -> Result<Vec<polis_core::api::TreeNodeView>, String> {
    let db = store.database();
    let rows = db.list_class_nodes_with_counts().map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(node, link_count)| polis_core::api::TreeNodeView { node, link_count })
        .collect())
}

/// One node with its children, (label-resolved, supersession-aware) links,
/// and observations — the same shape the bridge route serves.
#[tauri::command]
fn classmem_node(
    store: tauri::State<'_, SessionStore>,
    id: String,
) -> Result<serde_json::Value, String> {
    let db = store.database();
    build_node_view(&db, &id)?.ok_or_else(|| "no such class node".to_string())
}

/// A citation on a collapse proposal: an exact ledger seq + a resolved snippet.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CitationView {
    seq: i64,
    label: Option<String>,
}

/// A queued structural proposal, enriched: the subject node's title + (for a
/// collapse) the digest's cited ledger rows. Since B3 the queue is the
/// gardener's, adjudicated run by run — a row here is WAITING FOR A RUN
/// (`attempts`, `nextAfterRun`, `expiresLakeTs` ride the flattened row),
/// never waiting for a person.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProposalView {
    #[serde(flatten)]
    row: crate::classmem::ClassProposalRow,
    node_title: Option<String>,
    citations: Vec<CitationView>,
}

/// The gardener's work queue (promote/split/merge/collapse/supersede — due
/// and deferred), enriched with the digest preview + citations the surface
/// shows as "waiting for a run".
#[tauri::command]
fn classmem_proposals(store: tauri::State<'_, SessionStore>) -> Result<Vec<ProposalView>, String> {
    let db = store.database();
    let rows = db.list_class_proposals().map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let node_title = row
                .node_id
                .as_deref()
                .and_then(|id| db.get_class_node(id).ok().flatten())
                .map(|n| n.title);
            let citations = if row.op == "collapse" {
                row.extra_json
                    .as_deref()
                    .and_then(|e| serde_json::from_str::<Vec<i64>>(e).ok())
                    .unwrap_or_default()
                    .into_iter()
                    .map(|seq| CitationView {
                        seq,
                        label: db.link_preview("ledger", &seq.to_string()),
                    })
                    .collect()
            } else {
                Vec::new()
            };
            ProposalView {
                row,
                node_title,
                citations,
            }
        })
        .collect())
}

/// The latest classifier run (status/summary/session) for the pane header.
#[tauri::command]
fn classmem_latest_run(
    store: tauri::State<'_, SessionStore>,
) -> Result<Option<classmem::ClassRun>, String> {
    store.database().latest_class_run().map_err(|e| e.to_string())
}

/// The gardener's runs, newest first (Session B2 of the Polis extraction):
/// organize / compaction / observations / revert, with what each did and
/// cost — the memory surface's run timeline. Same shape as
/// `GET /v1/memory/runs`.
#[tauri::command]
fn classmem_runs(limit: Option<i64>) -> Result<Vec<polis_core::types::ClassRun>, String> {
    use polis_core::MemoryApi;
    let api = polis_host::polis_handle().ok_or("memory is not installed")?;
    api.list_runs(limit.unwrap_or(50), &polis_core::Scope::default()).map_err(|e| e.to_string())
}

/// One run with its journaled ops (op, subjects, outcome, reason — no image
/// blobs). Same shape as `GET /v1/memory/runs/:id`.
#[tauri::command]
fn classmem_run(id: i64) -> Result<Option<polis_core::types::RunView>, String> {
    use polis_core::MemoryApi;
    let api = polis_host::polis_handle().ok_or("memory is not installed")?;
    api.run(id).map_err(|e| e.to_string())
}

/// Undo one run from its journal, in one transaction (§5.2). The store
/// refuses as data — "revert run #N first — …", past the vacuum horizon,
/// already reverted — and the reason comes back as the error string the
/// surface shows inline; nothing is deleted, and the revert is itself a run.
/// Emits what every memory write emits, so the surface, the ledger pane and
/// the status pill refresh.
#[tauri::command]
fn classmem_revert_run(
    app: AppHandle,
    id: i64,
) -> Result<polis_core::types::RevertReceipt, String> {
    use polis_core::MemoryApi;
    let api = polis_host::polis_handle().ok_or("memory is not installed")?;
    let receipt = api.revert_run(id).map_err(|e| e.to_string())?;
    let _ = app.emit("memory-changed", ());
    let _ = app.emit("ledger-changed", ());
    extension_host::publish(
        ext_events::LEDGER_CHANGED,
        &ext_events::LedgerChanged {
            ts_ms: extension_host::now_ms(),
        },
    );
    let _ = app.emit("classmem-changed", ());
    Ok(receipt)
}

/// The catalog's health (plan §6.3) — the gardener's efficacy rebuilt from
/// the runs, the canary trail and the live tree on every read: organize
/// latency, error rate, canary reverts + trend, fan-out, digest ratio,
/// orphan/duplicate rates, provenance violations, the queue depth. The
/// Health tab reads it lazily; it is NOT folded into `memory_status`, which
/// the pill polls on every `memory-changed`.
///
/// Calls `catalog_health` directly, NOT `MemoryApi::health()`: the full report
/// re-hashes the entire ledger chain first, only to throw that verdict away —
/// and holds the shared DB lock for the length of the walk. The chain verdict
/// is `memory_status`'s (incremental) and the Verify button's (full) job.
#[tauri::command]
fn memory_catalog_health() -> Result<Option<polis_core::types::CatalogHealth>, String> {
    let api = polis_host::polis_handle().ok_or("memory is not installed")?;
    Ok(Some(polis_memory::health::catalog_health(&api.view())))
}

// The human curation commands — accept / reject / pin / rename on nodes,
// links and structural proposals, dismiss / pin on observations, the
// organize gate — are gone (Session B3 of the Polis extraction, plan §5.4):
// the gardener applies under adjudication, nothing is held for a person,
// and what survives is `memory_note_write` / `memory_forget` / the B2
// `classmem_revert_run`. The proposals a run has not yet adjudicated are
// read through `classmem_proposals` as a queue, never as a review list.


/// On the blocking pool (`OFF_MAIN_COMMANDS`) — reads and parses
/// `~/.claude/settings.json`. Small, but file I/O on the main thread is file I/O
/// on the main thread (perf-budget rule 4).
#[tauri::command]
fn get_hook_status() -> HookStatus {
    hook::get_status()
}

#[tauri::command]
fn install_hook() -> Result<HookStatus, String> {
    let result = hook::install();
    if let Ok(status) = &result {
        tracing::info!(path = %status.settings_path, "installed redline hook");
        // Install the Polis prompt-capture hook alongside the plan hook.
        if let Err(e) = hook::install_capture() {
            tracing::warn!(error = %e, "failed to install prompt-capture hook");
        }
        // And the terminal-attention hooks (needs-you / your-turn / working).
        if let Err(e) = hook::install_attention() {
            tracing::warn!(error = %e, "failed to install terminal-attention hooks");
        }
    }
    // Re-read: the status above was taken before the attention hooks landed.
    result.map(|_| hook::get_status())
}

/// On the blocking pool (`OFF_MAIN_COMMANDS`) — `available` runs the codex
/// capability probe, which can spawn `codex --help` (and, on a machine with an
/// exotic install, an interactive login shell behind it). It once ran on the
/// main thread: a synchronous subprocess on the UI thread, fired on every boot.
#[tauri::command]
fn get_codex_hook_status() -> codex_hook::CodexHookStatus {
    codex_hook::get_status()
}

#[tauri::command]
fn install_codex_hook() -> Result<codex_hook::CodexHookStatus, String> {
    let result = codex_hook::install();
    if let Ok(status) = &result {
        tracing::info!(path = %status.hooks_path, "installed Redline Codex hooks");
    }
    result
}

/// Write the Codex config profile a plan session launches under — the ONLY
/// delivery of the plan contract on that path. Installed beside the hook and
/// the skill rather than written at launch, because `codex -p <name>` with no
/// such file is not an error: it is a session that plans without ever having
/// been told the revision contract. See `codex_profile`.
#[tauri::command]
fn install_codex_profile() -> Result<codex_profile::CodexProfileStatus, String> {
    let result = codex_profile::install();
    if let Ok(status) = &result {
        tracing::info!(path = %status.path, "installed the Redline Codex plan profile");
    }
    result
}

/// On the blocking pool (`OFF_MAIN_COMMANDS`) — same reason as
/// `get_skill_status`: reads the installed skill files off disk and compares
/// them with the shipped ones.
#[tauri::command]
fn get_codex_skill_status() -> SkillStatus {
    skill::get_codex_status()
}

#[tauri::command]
fn install_codex_skill() -> Result<SkillStatus, String> {
    skill::install_codex()
}

/// "Remove Redline Hook…" app-menu flow: confirm, remove Redline's entry from
/// ~/.claude/settings.json, report. Removal is reversible — the next launch
/// detects the missing hook and the setup modal offers the one-click install
/// again — but it silently disconnects Claude Code, so a stray menu click
/// must not be enough.
fn remove_hook_via_menu(app: &AppHandle) {
    const TITLE: &str = "Remove Redline Hook";
    if !hook::get_status().installed {
        app.dialog()
            .message("The Redline hook isn't installed — nothing to remove.")
            .title(TITLE)
            .kind(MessageDialogKind::Info)
            .show(|_| {});
        return;
    }
    let app_for_confirm = app.clone();
    app.dialog()
        .message(
            "Remove Redline's hook from Claude Code?\n\nNew plans will stop \
             opening in Redline. The next time you launch Redline, it will \
             offer to set the hook up again.",
        )
        .title(TITLE)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Remove".to_string(),
            "Cancel".to_string(),
        ))
        .show(move |confirmed| {
            if !confirmed {
                return;
            }
            let app = app_for_confirm;
            let _ = hook::uninstall_capture();
            let _ = hook::uninstall_attention();
            match hook::uninstall() {
                Ok(status) => {
                    tracing::info!(path = %status.settings_path, "removed redline hook");
                    app.dialog()
                        .message("The Redline hook was removed.")
                        .title(TITLE)
                        .kind(MessageDialogKind::Info)
                        .show(|_| {});
                }
                Err(e) => {
                    app.dialog()
                        .message(format!("Couldn't remove the hook:\n\n{e}"))
                        .title(TITLE)
                        .kind(MessageDialogKind::Error)
                        .show(|_| {});
                }
            }
        });
}

/// On the blocking pool (`OFF_MAIN_COMMANDS`) — walks the installed skill
/// directory and diffs its contents against the shipped payload.
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
            "installed the Redline skill bundle (and pruned any retired skill dirs)"
        );
    }
    result
}

/// Sync commands that run on the blocking pool instead of the main thread:
/// they read SQLite or the disk, and a poll or a click waits on them
/// (perf-budget rule 4). `#[tauri::command(async)]` moves a command off the
/// main thread too, but every one costs ~11 KB of release binary (a tokio task
/// built for its own future type, measured 2026-10-09 across 29 commands);
/// an entry here costs a string. A command whose calls must keep their order
/// doesn't belong here or in `(async)`: two calls can finish out of order.
/// It goes in `IN_ORDER_COMMANDS`.
const OFF_MAIN_COMMANDS: &[&str] = &[
    // The Bookshelf: every command touches SQLite, and the deletes cascade.
    "bookshelf_create_folder",
    "bookshelf_delete_draft",
    "bookshelf_delete_folder",
    "bookshelf_draft_impact",
    "bookshelf_folder_impact",
    "bookshelf_list",
    "bookshelf_migrate_local",
    "bookshelf_move_draft",
    "bookshelf_move_folder",
    "bookshelf_new_draft",
    "bookshelf_rename_draft",
    "bookshelf_rename_folder",
    "bookshelf_set_template",
    "bookshelf_touch_draft",
    "build_plan_snapshot",
    "browse_thread_harness",
    "browse_thread_set_harness",
    "companion_build_activity",
    // Waits for the main thread to end the utterance, then for its final
    // transcript.
    "dictation_cycle",
    // Runs git in the project.
    "dictation_identifiers",
    // Reads the settings and checks the model files on disk.
    "dictation_status",
    // Waits for the main thread to end the capture, then for Whisper.
    "dictation_stop",
    "draft_source_delete",
    "draft_source_import_file",
    "draft_source_list",
    "get_session",
    "get_ui_prefs",
    "install_codex_hook",
    "install_codex_profile",
    "install_codex_skill",
    "install_hook",
    "install_skill",
    "list_harnesses",
    "list_sessions",
    // Re-read on every turn while the activity panel is open.
    "monochat_traces",
    "prepare_restore",
    "term_attention_snapshot",
    "thread_meters",
    // The memory surfaces (pill, inspector, Health, Catalog, Cosmos, Ask) and the
    // mirror: every one reads or writes SQLite or the vault on disk.
    "classmem_latest_run",
    "classmem_node",
    "classmem_proposals",
    "classmem_revert_run",
    "classmem_run",
    "classmem_runs",
    "classmem_tree",
    "context_stats",
    "context_thread_tree",
    "create_memory_vault",
    "export_context_bundle",
    "ledger_get_capture_external",
    "ledger_list_events",
    "ledger_prompt_body",
    "ledger_prompt_models",
    "ledger_query",
    "ledger_set_capture_external",
    "ledger_verify",
    "memory_catalog_health",
    "memory_embed_settings",
    "memory_forget",
    "memory_map",
    "memory_note_write",
    "memory_set_embed_provider",
    "memory_status",
    "mirror_rebuild",
    "mirror_status",
    "mirror_sync",
    "pick_mirror_dir",
    "set_mirror_dir",
    // Extensions, the browser tabs, boot and session state, the drafter's document,
    // exports, and the install-status reads: disk, SQLite, a webview or a probe.
    "bootstrap_state",
    "browser_eval",
    "browser_navigate",
    "browser_set_tabs",
    "browser_set_view",
    "browser_url",
    "draft_suggestion_unresolve",
    "drafter_get_doc",
    "drafter_set_doc",
    "export_revision_docx",
    "export_revision_markdown",
    "extension_reload",
    "extension_uninstall",
    "get_codex_hook_status",
    "get_codex_skill_status",
    "get_hook_status",
    "get_skill_status",
    "local_install_confirm",
    "local_install_inspect",
    "mark_plan_build",
    "resume_startup_cwd",
    "save_revision_to_obsidian",
    "set_session_project",
    "write_plan_handoff",
    // The terminals' lifecycle and the wall's polls: a fork, a kill, an lsof or ps
    // scan. The frontend fences each id's spawn/attach/kill/resize itself
    // (`enqueuePtyOp`); `pty_write` and `pty_ack` stay on the main thread for
    // keystroke order.
    "pty_attach",
    "pty_cwd",
    "pty_cwds",
    "pty_detach",
    "pty_kill",
    "pty_kill_all",
    "pty_list",
    "pty_procs",
    "pty_resize",
    "pty_spawn",
    // The conversation mirror: the first read of a transcript (subscribe),
    // a page of it, a transcript lookup (prebind), and the paced typing of
    // a composer send, a steered one or a mid-session switch. `pty_interrupt`
    // and the answers stay on the main thread: one byte, one oneshot.
    "convo_page",
    "convo_prebind",
    "convo_set_mode",
    "convo_set_model",
    "convo_steer",
    "convo_subscribe",
    "pty_submit",
    // The agent harnesses: the agents table in SQLite, and an installed
    // harness's link on disk.
    "harness_agent_create",
    "harness_agent_delete",
    "harness_agent_duplicate",
    "harness_agent_list",
    "harness_agent_set_folder",
    "harness_agent_set_starred",
    "harness_agent_update",
    "harness_preview_discard",
    "harness_uninstall",
    // Files and the views of them: the file explorer and viewer, attachments, the
    // highlighter (a syntect parse), repo logos (an ancestor walk and hashes), and
    // the browser's tab pictures and memory shots on disk.
    "doc_lines",
    "highlight_diff",
    "import_attachment",
    "list_dir",
    "open_doc",
    "read_file_base64",
    "read_text_file",
    "repo_icon",
    "save_attachment",
    "save_text_file",
    "shot_forget",
    "shots_caption_backlog",
    "shots_get_policy",
    "shots_list",
    "shots_set_policy",
    "thumbs_list",
    "thumbs_prune",
    // The rest: the Localhost scan and stops (subprocesses, ports, project roots),
    // hook-conflict scans and file watches, browser workspaces on disk, Build
    // Redline's patch and preflight, Memory Ask's thread, a
    // page's appearance (waits on its webview), mission findings, and two memory
    // reads in lib.rs.
    "browser_set_appearance",
    "browser_workspace_delete",
    "browser_workspace_list",
    "browser_workspace_read",
    "browser_workspace_write",
    "dev_server_probe",
    "dev_server_stop",
    "dev_server_stop_plan",
    "dev_servers_scan",
    "memchat_clear",
    "memchat_thread",
    "mission_add_finding",
    // Read on every switch to the browser (useMission, BrowseHarnessChip).
    "get_agent_seats",
    "mission_get_tabs",
    "mission_list",
    "mission_list_findings",
    "remove_hook_conflicts",
    "scan_hook_conflicts",
    "unwatch_hook_conflicts",
    "watch_hook_conflicts",
    // Downloads, loads and asks the end-of-turn model, each waiting on it.
    "turn_scorer",
    // Drives a model download to its end.
    "whisper_install",
];

/// Sync commands that leave the main thread but keep the order their calls
/// arrived in: each takes a ticket as it arrives and runs on the pool when its
/// turn comes, one at a time. `save_workspace` is here because every
/// customization gesture fires one without waiting for the last, and two of
/// them racing on the pool could leave the older layout on disk for the next
/// launch to load. The comment writes wait on the database writer, and an
/// edit sent right after its add must not overtake it.
const IN_ORDER_COMMANDS: &[&str] = &[
    "save_workspace",
    "add_comment",
    "update_comment",
    "delete_comment",
    // On every switch to the browser (BrowserPane's mount), and the mirror it
    // sets must end on the LAST id sent. The tab save after it must not be
    // overtaken either.
    "mission_set_active",
    "mission_set_tabs",
];

/// The `IN_ORDER_COMMANDS` turn: the next ticket to hand out, and the ticket
/// whose call may run now.
static IN_ORDER_TICKETS: AtomicU64 = AtomicU64::new(0);
static IN_ORDER_TURN: (StdMutex<u64>, std::sync::Condvar) =
    (StdMutex::new(0), std::sync::Condvar::new());

/// The invoke handler, with the `OFF_MAIN_COMMANDS` and `IN_ORDER_COMMANDS`
/// handed to the blocking pool whole: one shared closure type, so routing a
/// command adds no code, where an `(async)` wrapper builds a task per command.
fn off_main<R: tauri::Runtime>(
    commands: impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    let commands = Arc::new(commands);
    move |invoke| {
        let command = invoke.message.command();
        // Taken here, on the thread the calls arrive on, so tickets follow
        // arrival order.
        let ticket = IN_ORDER_COMMANDS
            .contains(&command)
            .then(|| IN_ORDER_TICKETS.fetch_add(1, Ordering::Relaxed));
        if ticket.is_none() && !OFF_MAIN_COMMANDS.contains(&command) {
            return commands(invoke);
        }
        let commands = commands.clone();
        tauri::async_runtime::spawn_blocking(move || match ticket {
            Some(ticket) => in_turn(ticket, || commands(invoke)),
            None => commands(invoke),
        });
        true
    }
}

/// Run an `IN_ORDER_COMMANDS` call when its ticket's turn comes, then pass the
/// turn on, even when the call panics: otherwise every later one would wait
/// forever.
fn in_turn(ticket: u64, call: impl FnOnce() -> bool) -> bool {
    let (serving, passed) = &IN_ORDER_TURN;
    let mut serving = passed
        .wait_while(serving.lock().unwrap_or_else(|e| e.into_inner()), |now| *now != ticket)
        .unwrap_or_else(|e| e.into_inner());
    let handled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(call));
    *serving += 1;
    passed.notify_all();
    handled.unwrap_or(true)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    claude_proc::scrub_inherited_session_env();
    // The zero point for every boot milestone (docs/perf-budget.md "Boot
    // budget"). Before the subscriber, so the very first `Instant` is as close
    // to process start as this function can observe.
    boot_trace::init();
    // WHICH Redline this process is, decided before anything can read it: the
    // database path, the daemon port, the single-instance plugin, WebView
    // storage and every outward-facing integration all branch on it. A
    // candidate probe that resolved this late would already have bound the
    // installed app's port or opened the user's database. Production needs no
    // environment at all, so an ordinary launch is unchanged.
    let profile = runtime_profile::init_from_env();
    if profile.is_probe() {
        eprintln!("Redline starting as a candidate probe: {}", profile.describe());
    }
    probe::record(probe::Milestone::Started, profile.describe());
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".parse().unwrap()),
        )
        .init();

    // Before any window (and its scrollers) exists: defuse the AppKit/WebKit
    // scroller-style swap race that segfaulted the app — see scroller_guard.rs.
    #[cfg(target_os = "macos")]
    scroller_guard::pin_scroller_style();

    let builder = tauri::Builder::default()
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && payload.event() == tauri::webview::PageLoadEvent::Started {
                browser_events::hide_browser_tabs(webview.app_handle());
                // A reloaded stage starts over: its conversation subscriptions
                // went with the old page and must stop arming cards.
                convo::drop_subscriptions(webview.app_handle());
            }
        });
    // Must be the first plugin (Tauri v2 requirement). A second `redline`
    // launch hands off to the running instance and focuses its window
    // instead of opening a daemon-less duplicate that can't bind :7676 and
    // would silently miss every plan (it only shares the on-disk DB).
    //
    // A candidate probe must NOT install it. The handoff is by bundle
    // identifier, which a candidate shares with the installed app, so a probe
    // would focus the user's window and exit zero — reporting a healthy boot
    // the candidate never performed.
    let builder = if profile.single_instance() {
        builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Default window label is "main"; fall back to any window so this
            // keeps working if the label ever changes.
            let win = app
                .get_webview_window("main")
                .or_else(|| app.webview_windows().into_values().next());
            if let Some(w) = win {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            } else {
                // Headless incumbent: the window died (webview crash, close)
                // but the process — daemon, PTYs, held reviews — lived on.
                // The relaunch's intent is plainly "give me Redline back", so
                // re-present a main window instead of doing nothing.
                resurrect_main_window(app);
            }
        }))
    } else {
        builder
    };
    let builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // OS notifications for a terminal that needs you while Redline is in
        // the background. The frontend decides when; it alone knows "seen".
        .plugin(tauri_plugin_notification::init())
        // `redline://` deep links — the viewer's "Open in Redline" link lands a
        // shared plan as a full native review. Handled in the frontend via the
        // JS plugin's onOpenUrl (both cold-start and running-instance).
        .plugin(tauri_plugin_deep_link::init());
    // Dead-webview revival is a WKWebView concern; the hook only exists on
    // macOS/iOS builds (see webview_guard.rs for the policy).
    #[cfg(target_os = "macos")]
    let builder = builder.on_web_content_process_terminate(webview_guard::on_terminate);
    builder
        .invoke_handler(off_main(tauri::generate_handler![
            hook_conflicts::scan_hook_conflicts,
            hook_conflicts::remove_hook_conflicts,
            hook_conflicts::watch_hook_conflicts,
            hook_conflicts::unwatch_hook_conflicts,
            browser_events::browser_inspect,
            browser_events::pointer_pressed,
            browser_events::browser_set_appearance,
            browser_overlay::browser_overlay_regions,
            browser_workspace::browser_protect_tabs,
            browser_workspace::browser_workspace_read,
            browser_workspace::browser_workspace_write,
            browser_workspace::browser_workspace_list,
            browser_workspace::browser_workspace_delete,
            mission_context::mission_foundation,
            mission_capture::mission_capture_frame,
            mission_capture::mission_capture_retry,
            mission_context::conversation_prepare_handoff,
            extensions_list,
            extension_set_enabled,
            extension_uninstall,
            extension_reload,
            local_install_inspect,
            local_install_confirm,
            marketplace_index,
            marketplace_install,
            transparency::reduced_transparency,
            workbench_menu::set_workbench_menu,
            list_sessions,
            get_session,
            export_revision_markdown,
            export_revision_docx,
            save_revision_to_obsidian,
            delete_session,
            archive_session,
            rename_session,
            archive_companion,
            add_comment,
            update_comment,
            delete_comment,
            accept_agent_suggestion,
            submit_review,
            approve_plan,
            approve_plan_later,
            mark_plan_build,
            write_plan_handoff,
            resume_startup_cwd,
            unapprove_plan,
            set_plan_state,
            set_session_project,
            record_handoff_event,
            accept_resolution,
            reopen_resolution,
            attach_discussion,
            set_interception_mode,
            preflight::preflight_status,
            project::project_create,
            project::projects_parent,
            get_ui_prefs,
            set_ui_pref,
            get_agent_seats,
            set_agent_seat,
            set_claude_bin_override,
            set_codex_bin_override,
            codex_app_server::install_codex_cli,
            codex_model_catalog,
            model_catalog_snapshot,
            claude_model_catalog,
            install_provider_integration,
            set_provider_bin_override,
            seat_assignment_agent,
            seat_assignment_cancel,
            seat_preflight,
            apply_seat_picks,
            revert_seat_assignment,
            seat::get_seat_roster,
            userconfig::save_workspace,
            userconfig::list_harnesses,
            userconfig::harness_uninstall,
            get_relay_config,
            set_relay_config,
            get_owner_secret,
            build_plan_snapshot,
            import_shared_plan,
            record_share,
            delete_share,
            list_shares,
            record_share_return,
            list_share_returns,
            get_collab_requests,
            set_collab_requests,
            get_collab_share,
            set_collab_share,
            daemon_state,
            bootstrap_state,
            claim_review,
            arm_restore,
            report_agent_exit,
            prepare_restore,
            show_main_window,
            get_hook_status,
            install_hook,
            get_codex_hook_status,
            install_codex_hook,
            install_codex_profile,
            get_codex_skill_status,
            install_codex_skill,
            get_skill_status,
            install_skill,
            pty::pty_spawn,
            pty::pty_list,
            pty::pty_attach,
            pty::pty_detach,
            pty::pty_ack,
            pty::pty_write,
            pty::pty_write_checked,
            pty::pty_is_live,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_kill_all,
            pty::pty_cwd,
            pty::pty_cwds,
            pty::pty_procs,
            pty::pty_screen_tail,
            term_attention::term_attention_snapshot,
            term_attention::term_attention_interrupted,
            term_attention::set_attention_badge,
            convo::convo_subscribe,
            convo::convo_unsubscribe,
            convo::convo_page,
            convo::convo_expect,
            convo::convo_queue,
            convo::convo_unqueue,
            convo::convo_steer,
            convo::convo_prebind,
            convo::convo_set_mode,
            convo::convo_set_model,
            convo::convo_titles,
            asks::convo_answer_ask,
            pty::pty_submit,
            pty::pty_interrupt,
            fsbrowse::list_dir,
            fsbrowse::read_text_file,
            fsbrowse::read_file_base64,
            fsbrowse::save_text_file,
            fsbrowse::save_attachment,
            fsbrowse::import_attachment,
            fsbrowse::home_dir,
            repoicon::repo_icon,
            highlight::open_doc,
            highlight::doc_lines,
            highlight::highlight_diff,
            fswatch::watch_dir,
            fswatch::unwatch_dir,
            fork::fork_thread_send,
            fork::fork_thread_status,
            fork::get_thread,
            fork::fork_thread_cancel,
            fork::fork_thread_discard,
            fork::fork_thread_model,
            fork::fork_thread_set_model,
            fork::review_thread_send,
            fork::review_question_send,
            inspect::inspect_set,
            inspect::inspect_read,
            meter::thread_meters,
            browse::browse_send,
            browse::browse_turn_status,
            browse::get_browse_thread,
            browse::browse_thread_harness,
            browse::browse_thread_set_harness,
            browse::browse_cancel,
            browse::browse_unqueue,
            browse::browse_discard,
            browse_list::browse_list_get,
            browse_list::browse_list_start,
            browse_list::browse_list_add,
            browse_list::browse_list_update,
            browse_list::browse_list_remove,
            browse_list::browse_list_reorder,
            browse_list::browse_list_clear,
            browse_locate::browse_list_locate,
            mission::mission_create,
            mission::mission_list,
            mission::mission_set_goal,
            mission::mission_delete,
            mission::mission_set_tabs,
            mission::mission_get_tabs,
            mission::mission_add_finding,
            mission::mission_list_findings,
            mission::mission_remove_finding,
            mission::mission_send,
            mission::get_mission_thread,
            mission::mission_cancel,
            mission::mission_unqueue,
            mission::mission_turn_status,
            mission_set_active,
            review_hold_active,
            submit_review_feedback,
            dismiss_review,
            review::review_open,
            review::review_diff,
            review::review_fingerprint,
            review::review_commits,
            review::review_file_contents,
            review::review_branches,
            review::review_annotation_clear_source,
            review::review_question_add,
            review::review_question_list,
            review::review_question_delete,
            ai_review::ai_review_start,
            ai_review::ai_review_cancel,
            ai_review::ai_review_active,
            push::push_status,
            push::review_push,
            git_gui::git_gui_status,
            git_gui::git_gui_file_diff,
            git_gui::git_gui_log,
            git_gui::git_gui_commit_detail,
            git_gui::git_gui_commit_files,
            git_gui::git_gui_refs,
            git_gui::git_gui_stage,
            git_gui::git_gui_unstage,
            git_gui::git_gui_discard,
            git_gui::git_gui_apply_patch,
            git_gui::git_gui_commit,
            git_gui::git_gui_last_message,
            git_gui::git_gui_fetch,
            git_gui::git_gui_pull,
            git_gui::git_gui_push,
            git_gui::git_gui_checkout,
            git_gui::git_gui_branch_create,
            git_gui::git_gui_branch_delete,
            git_gui::git_gui_merge,
            git_gui::git_gui_rebase,
            git_gui::git_gui_continue,
            git_gui::git_gui_abort,
            git_gui::git_gui_cherry_pick,
            git_gui::git_gui_revert_commit,
            git_gui::git_gui_reset,
            git_gui::git_gui_tag_create,
            git_gui::git_gui_tag_delete,
            git_gui::git_gui_stash_save,
            git_gui::git_gui_stash_apply,
            git_gui::git_gui_stash_drop,
            git_gui::git_gui_stash_files,
            push::review_revert,
            push::review_last_push,
            ai_commit::ai_commit_draft,
            review::review_sessions_list,
            review::review_annotation_add,
            review::review_annotation_update,
            review::review_annotation_delete,
            review::review_annotation_list,
            review::review_mark_viewed,
            review::review_list_viewed,
            voice::voice_session_start,
            voice::voice_send,
            voice::voice_interrupt,
            voice::voice_clean,
            voice::voice_session_stop,
            voice::voice_session_probe,
            voice::voice_session_status,
            voice::voice_thread,
            voice::voice_note,
            voice::comment_offers_pending,
            voice::comment_offer_add,
            voice::comment_offer_dismiss,
            tts::tts_get_settings,
            tts::tts_set_settings,
            tts::tts_synth,
            tts::tts_cancel,
            tts::tts_kokoro_status,
            tts::tts_kokoro_install,
            tts::tts_kokoro_warm,
            tts_studio::tts_studio,
            dictation::dictation_start,
            dictation::dictation_stop,
            dictation::dictation_cycle,
            dictation::dictation_kill_all,
            dictation::dictation_status,
            dictation::dictation_identifiers,
            dictation_whisper::whisper_install,
            turn_scorer::turn_scorer,
            dictation_whisper::dictation_set_engine,
            devmap::dev_servers_scan,
            devmap::dev_server_stop,
            devmap::dev_server_stop_plan,
            devmap::dev_server_probe,
            browser_navigate,
            browser_create_tab,
            browse_organize::browser_organize_tabs,
            browser_home::browser_home_feed,
            browser_output::browser_print,
            browser_output::browser_save_page,
            browser_eval,
            browser_close,
            browser_url,
            browser_eval_result,
            browser_snapshot,
            browser_cache_snapshot,
            browser_cached_snapshot,
            browser_consume_scroll,
            browser_can_suspend,
            browser_suspend,
            browser_set_active,
            browser_set_tabs,
            thumbs::browser_take_thumbnail,
            thumbs::thumbs_list,
            thumbs::thumbs_prune,
            shots::shots_list,
            shots::shot_forget,
            shots::shots_caption_backlog,
            shots::shots_caption_run,
            shots::shots_get_policy,
            shots::shots_set_policy,
            surface_set_active,
            drafter_set_doc,
            drafter_get_doc,
            record_render_crash,
            bookshelf::bookshelf_list,
            bookshelf::bookshelf_migrate_local,
            bookshelf::bookshelf_new_draft,
            bookshelf::bookshelf_set_template,
            bookshelf::bookshelf_touch_draft,
            bookshelf::bookshelf_rename_draft,
            bookshelf::bookshelf_move_draft,
            bookshelf::bookshelf_draft_impact,
            bookshelf::bookshelf_delete_draft,
            bookshelf::bookshelf_create_folder,
            bookshelf::bookshelf_rename_folder,
            bookshelf::bookshelf_move_folder,
            bookshelf::bookshelf_folder_impact,
            bookshelf::bookshelf_delete_folder,
            bookshelf::draft_source_import_file,
            bookshelf::draft_source_list,
            bookshelf::draft_source_delete,
            draft_chat::draft_instruct,
            draft_chat::draft_turn_status,
            draft_chat::draft_chat_cancel,
            draft_chat::draft_comment_add,
            draft_chat::draft_comment_list,
            draft_chat::draft_comment_delete,
            harness::harness_agent_create,
            harness::harness_agent_list,
            harness::harness_agent_update,
            harness::harness_agent_set_starred,
            harness::harness_agent_set_folder,
            harness::harness_agent_delete,
            harness::harness_agent_duplicate,
            harness::harness_agent_run,
            harness::harness_agent_preview,
            harness::harness_preview_discard,
            fork::draft_thread_send,
            memchat::memchat_send,
            memchat::memchat_turn_status,
            memchat::memchat_thread,
            memchat::memchat_cancel,
            memchat::memchat_unqueue,
            memchat::memchat_clear,
            companion::companion_create,
            companion::companion_list,
            companion::companion_get_thread,
            companion::monochat_traces,
            monochat::monochat_policy_get,
            monochat::monochat_policy_set,
            companion::plan_origin_chat,
            companion::companion_graduations,
            companion::companion_rename,
            companion::companion_set_model,
            companion::companion_delete,
            companion::companion_send,
            companion::companion_handoff_seed,
            companion::companion_turn_status,
            companion::companion_cancel,
            companion::companion_unqueue,
            companion::companion_get_project,
            companion::companion_build_activity,
            companion::companion_set_project,
            companion::companion_steer,
            companion::companion_queue_promote,
            companion_build::companion_changes,
            companion_build::companion_undo,
            companion::companion_prewarm,
            companion::companion_release,
            companion::companion_context,
            draft_suggestions_pending,
            draft_suggestion_resolve,
            draft_suggestion_unresolve,
            parse_markdown_sections,
            browser_set_view,
            ledger_list_events,
            ledger_query,
            ledger_verify,
            ledger_prompt_body,
            ledger_prompt_models,
            context_stats,
            context_thread_tree,
            memory_map,
            ledger_get_capture_external,
            ledger_set_capture_external,
            combine_preview,
            combine_brief,
            record_plan_launch,
            classmem_organize,
            classmem_tree,
            classmem_node,
            classmem_proposals,
            classmem_latest_run,
            classmem_runs,
            classmem_run,
            classmem_revert_run,
            memory_catalog_health,
            memory_status,
            memory_forget,
            memory_set_embed_provider,
            memory_embed_settings,
            memory_note_write,
            librarian_agent,
            shipwright_agent,
            export_context_bundle,
            mirror_status,
            pick_mirror_dir,
            set_mirror_dir,
            mirror_rebuild,
            mirror_sync,
            create_memory_vault,
            mcp_config_snippet,
        ]))
        .setup(|app| {
            boot_trace::mark(boot_trace::SETUP_ENTER);
            transparency::observe(app.handle().clone());
            // Register the `redline://` scheme with the OS at runtime. In a
            // bundled release the Info.plist declaration is authoritative; this
            // best-effort call makes the deep link work in dev too. Harmless if
            // unsupported on the platform.
            #[allow(unused_imports)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(e) = app.deep_link().register_all() {
                    tracing::debug!(error = %e, "deep-link register_all (dev only) failed");
                }
            }

            // The hook repairs (timeout refresh, restore-curl permission,
            // prompt-capture install) used to run right here, synchronously,
            // in front of the window. They are file reads and rewrites under
            // `~/.claude` that nothing on screen depends on, so they moved to
            // `postboot`, behind the reveal — and `preflight_status` awaits
            // that coordinator, so a LAUNCH still cannot outrun them.

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

            // A screenshot thumbnail dragged in before it has settled is a
            // file promise, not a file: resolve those into real paths for the
            // frontend's drop router.
            #[cfg(target_os = "macos")]
            promised_drop::install(app.handle());

            // A candidate probe is handed a disposable directory. Everything
            // downstream — the database, the daemon token, backups, the
            // bookshelf, attachments — is rooted here, so overriding it once
            // is what keeps a probe out of the user's data entirely.
            let data_dir = match runtime_profile::current().data_dir_override() {
                Some(dir) => {
                    let dir = dir.to_path_buf();
                    if let Err(e) = std::fs::create_dir_all(&dir) {
                        eprintln!("Redline could not create its data directory {}: {e}", dir.display());
                        std::process::exit(1);
                    }
                    dir
                }
                None => app
                    .path()
                    .app_data_dir()
                    .expect("could not resolve app data dir"),
            };
            // This boot's master token, on disk (0600) for the dev preflight:
            // a later `npm run tauri dev` finds a headless leftover of this
            // instance holding :1420/:7676 and needs a credential we spawned
            // nothing to hand it. Boot survives a failed write — only the
            // retire-a-headless-instance path degrades (to a manual kill).
            match auth::persist_daemon_token(&data_dir) {
                Ok(path) => tracing::info!(path = %path.display(), "persisted daemon token"),
                Err(e) => tracing::warn!(error = %e, "could not persist daemon token"),
            }
            let db_path = data_dir.join("redline.db");
            tracing::info!(path = %db_path.display(), "opening sqlite database");
            // A failed open is fatal, but it must not be fatal like THIS was:
            // `.expect()` inside Tauri's setup panics across an Objective-C
            // frame that cannot unwind, so the process aborts with a raw
            // backtrace, no window, and nothing telling the user what to do.
            // Exit cleanly instead, and leave the reason somewhere a person
            // who double-clicked an icon can actually find it.
            let db = Arc::new(boot_trace::timed(boot_trace::DB_OPEN, || {
                Database::open(&db_path).unwrap_or_else(|e| {
                    let message = format!(
                        "Redline could not open its database and has to stop.\n\n\
                         Database: {}\n\
                         Reason:   {e}\n",
                        db_path.display()
                    );
                    tracing::error!("{message}");
                    let _ = std::fs::write(data_dir.join("boot-error.txt"), &message);
                    eprintln!("\n{message}");
                    crate::probe::record_failure(format!("database: {e}"));
                    std::process::exit(1);
                })
            }));
            crate::probe::record(crate::probe::Milestone::Database, "opened and migrated");

            // Polis backup: the once-per-boot snapshot moved to `postboot`.
            // `VACUUM INTO` walks the WHOLE database — on a large one it is by
            // far the longest single thing that ever ran in this closure, and
            // it ran before the window existed. The durability guarantees are
            // unchanged: once per boot (now after the reveal), every 6h (the
            // keeper's `ledger-backup` watch), and on quit. All three now take
            // turns through `postboot::snapshot_lock` — deferring the startup
            // one is exactly what makes them able to overlap.

            // Polis portable mirror (Phase 4): a continuous, one-way markdown
            // mirror of the ledger into the user-chosen directory. Off until a
            // dir is set (`redline.mirrorDir`). One startup sync here (off the
            // setup thread — it touches the filesystem); the 120s cadence is
            // re-homed onto the keeper's watch bus (the `mirror-sync` watch).
            // Best-effort and non-blocking — a mirror hiccup never touches the
            // app or the chain (the ledger stays source of truth).
            {
                let db_mir = db.clone();
                std::thread::spawn(move || {
                    mirror::sync_if_enabled(&db_mir);
                });
            }

            let settings = Settings::load(db.clone());
            app.manage(settings.clone());

            // Agent Seats: mirror the per-seat model/effort/binary config (and
            // the global claude-binary override) into the process-global store
            // before any agent can spawn.
            seat::load_from_db(&db);
            plan_provider::load_overrides(&db);

            let claims = ClaimFlags::new();
            app.manage(claims.clone());

            app.manage(pty::PtyState::new());
            app.manage(term_attention::TermAttentionState::default());
            {
                // A `working` whose agent went back to the shell is retired
                // here (term_attention::retire_finished): a 10 s look at the
                // ptys' foreground groups, no fork, idle when nothing works.
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(term_attention::RETIRE_TICK).await;
                        term_attention::retire_finished(&handle);
                    }
                });
            }
            app.manage(convo::ConvoState::default());
            app.manage(seatassign::SeatAssignState::new());

            app.manage(fswatch::FsWatcher::new(app.handle().clone()));

            // Cheap now: two empty maps. The grammar set itself is a shared
            // `OnceLock` built by `postboot` (or by the first file open, which
            // blocks on the same initialization) — building it here meant
            // deserializing `two_face`'s extended dump in front of the window
            // on every launch, for the majority of launches that never open a
            // file at all.
            // (The grammar warm-up itself moved with it — `warm_common`
            // reaches through `syntaxes()`, so warming here would have built
            // the whole set on a boot thread regardless of where the field
            // lived.)
            app.manage(Arc::new(highlight::Highlighter::new()));

            // `claude` resolution is deliberately lazy (first fork use): the
            // probe can shell out through the user's rc files, and macOS
            // attributes that child's file access to Redline — running it at
            // startup caused TCC folder prompts on every launch.
            // Built before SessionStore::new consumes the `db` Arc.
            let fork_state = fork::ForkState::new(db.clone());
            app.manage(fork_state.clone());

            // Browse agent (browser pane discussion). Same lazy-`claude`
            // reasoning as the fork state.
            let browse_state = browse::BrowseState::new(db.clone());
            app.manage(browse_state);

            // A tab's working list. Pure CRUD — no `claude`, nothing to
            // resolve lazily, so it holds the db and nothing else.
            app.manage(browse_list::BrowseListState::new(db.clone()));

            // Mission orchestrator (browser pane, a tier above the browse
            // agents). Same lazy-`claude` reasoning; reads across tabs + pins.
            let mission_state = mission::MissionState::new(db.clone());
            app.manage(mission_state);

            // Prompt Drafter discussion agent (per-draft). Same lazy-`claude`
            // reasoning; grounds on the draft's markdown mirror and writes back
            // via tracked suggestions.
            let draft_chat_state = draft_chat::DraftChatState::new(db.clone());
            app.manage(draft_chat_state);

            // The Memory surface's Ask agent: one persisted conversation over
            // the lake + catalog. Same lazy-`claude` reasoning; reads the
            // record through the local context/memory routes.
            let memchat_state = memchat::MemChatState::new(db.clone());
            app.manage(memchat_state);

            // The Companion: one global discussion spanning every surface.
            // Grounds each turn on the ActiveSurface mirror + journal delta.
            let companion_state = companion::CompanionState::new(db.clone());
            app.manage(companion_state);

            // Code Review surface: diff resolver + line-anchored annotation
            // store. Plain DB handle — no agent process of its own.
            app.manage(review::ReviewState::new(db.clone()));
            app.manage(ai_review::AiReviewState::new(db.clone()));

            // Voice agent (spoken plan discussion). One persistent `claude`
            // session per plan; same lazy-`claude` reasoning as the fork state.
            let voice_state = voice::VoiceState::new(db.clone());
            app.manage(voice_state);

            // Push-to-talk dictation (the voice agent's microphone). No
            // subprocess — native on-device speech-to-text, one capture at a
            // time. macOS-only under the hood; the state is cheap everywhere.
            app.manage(dictation::DictationState::new());

            // Pluggable Whisper backend for dictation: model download +
            // management and the resident whisper.cpp model. The `auto` engine
            // prefers it over Apple once the model (~140 MB) is downloaded into
            // the app data dir. Fully local — no audio leaves the device.
            app.manage(dictation_whisper::WhisperState::new(
                db.clone(),
                data_dir.clone(),
            ));

            // Voice TTS: engine choice + API key in app_settings, synth made
            // from Rust (cloud OpenAI, or the local Kokoro sidecar). The Kokoro
            // model lives under the app data dir, as does the studio voice,
            // whose state changes and install progress go out as events.
            let tts = tts::TtsState::new(db.clone(), data_dir.clone());
            let events = app.handle().clone();
            tts.studio().on_event(move |event, payload| {
                let _ = events.emit(event, payload);
            });
            // The optional end-of-turn model for hands-free voice: a process
            // of its own on the Kokoro runtime's interpreter, else the studio
            // voice's.
            app.manage(turn_scorer::TurnScorerState::new(
                &data_dir,
                tts.venv_python(),
                tts.studio().clone(),
            ));
            app.manage(tts);

            // Active browser tab tracker — shared with the daemon's
            // `/v1/browser/*` routes through `AppState`.
            let active_browser = ActiveBrowser::new();
            app.manage(active_browser.clone());

            let browser_tabs = BrowserTabs::new();
            app.manage(browser_tabs.clone());

            let snapshot_cache = SnapshotCache::new();
            app.manage(snapshot_cache.clone());

            let active_mission = ActiveMission::new();
            app.manage(active_mission.clone());

            let active_surface = ActiveSurface::new();
            app.manage(active_surface.clone());

            // The Shipwright's resumable session id — one persistent thread, so
            // an L1 follow-up or a consult check-in continues the run it's about.
            app.manage(ShipwrightSession::default());

            let store = boot_trace::timed(boot_trace::STORE_HYDRATE, || {
                SessionStore::try_new(db)
            }).unwrap_or_else(|e| {
                let message = format!(
                    "Redline could not load your session history and has to stop.\n\n\
                     Database: {}\n\
                     Reason:   {e}\n\n\
                     Your existing history has not been replaced with an empty session list.\n",
                    db_path.display()
                );
                tracing::error!("{message}");
                let _ = std::fs::write(data_dir.join("boot-error.txt"), &message);
                eprintln!("\n{message}");
                std::process::exit(1);
            });
            app.manage(store.clone());
            // Friction telemetry for the two contexts that hold no `Database`
            // (the axum auth middleware, chiefly). Installed once, right after
            // the store exists and before the daemon starts serving.
            db::install_friction_sink(store.database());
            // The memory seats' agent (Session A4 of the Polis extraction).
            polis_host::install_agent(Arc::new(polis_host::RedlineAgent));
            // This install's identity (E2): the key under <data>/polis/, the
            // store adopted under it — its own explicit step after attach
            // (attach appends nothing; the first adoption appends the bind).
            // Boot survives a failure: writes then carry the legacy author.
            if let Err(e) = polis_host::install_identity(&data_dir, &store.database()) {
                tracing::warn!(error = %e, "polis identity could not be installed; writes carry the login name");
            }
            // The owned handle (`MemoryApi`) for the router and the MCP mount (A6),
            // writing as the identity above (E2).
            polis_host::install_polis(store.database());

            // The interactive plan session's meter. One tailer for the app —
            // the PTY has no stream to parse, so its economics come from the
            // session transcript on a slow beat (see `plan_meter`).
            // The returned flag is the teardown lever. Nothing takes it yet —
            // the thread dies with the process — but a future `stop` needs it
            // to exist, and binding it says so rather than dropping it silently.
            let _plan_meter_stop = plan_meter::start(app.handle(), store.clone());

            let pending = PendingResponses::new();
            app.manage(pending.clone());

            let pending_reviews = PendingReviews::new();
            app.manage(pending_reviews.clone());

            let pending_feedback = PendingFeedback::new();
            app.manage(pending_feedback.clone());

            let expected_modes = ExpectedModes::new();
            app.manage(expected_modes.clone());

            app.manage(ReviseWatch::new());
            app.manage(LastClaudePid::default());

            // Memory as plumbing + the watch bus: the background keeper. One
            // 30s loop, two duties — the idle-gated memory passes (organize /
            // compact / observe: no buttons, no configs, one quiet pill) and
            // the watch bus that re-homes the app's background timers (mirror
            // sync, ledger backup, review-staleness sweep) plus the scheduled one-shots
            // (`keeper::schedule_once`, which the revise watchdog rides).
            // Spawned HERE, after the store, the held-POST map, and EVERY
            // managed state a bus act can reach — the staleness act calls
            // `mark_session_detached`, which does `app.state::<LastClaudePid>()`
            // and would panic if that manage raced this spawn. Anything a
            // keeper act touches must be managed above this line. Async (the
            // classifier / summarizer are), so it rides the Tauri runtime,
            // not a std thread. Best-effort: every step logs on error and
            // never brings the loop down.
            keeper::spawn(keeper::WatchCtx {
                app: app.handle().clone(),
                db: store.database(),
                store: store.clone(),
                pending: pending.clone(),
                data_dir: data_dir.clone(),
            });

            let daemon_status = DaemonStatus::new();
            app.manage(daemon_status.clone());

            // Polis Memory's router state (A6): the handle installed above,
            // Redline's ingest observer (the restore trigger, the launch
            // handoff, the seat header, the project registry,
            // the capture setting, the transcript backfill), and the same
            // event bus the gardener reports on.
            let polis = polis_server::PolisState {
                api: polis_host::polis_handle().expect("install_polis ran above"),
                ingest: Arc::new(polis_host::RedlineIngest::new(
                    app.handle().clone(),
                    store.clone(),
                )),
                events: Arc::new(polis_host::TauriEvents::new(app.handle().clone())),
                // E4: this daemon is not an org node — `/v1/sync/*` answers
                // 503 "not an org node"; the standalone `polis serve --org`
                // installs the real relay.
                sync: Arc::new(polis_core::sync::NoSyncRelay),
            };
            let app_state = AppState {
                store: store.clone(),
                app_handle: app.handle().clone(),
                pending,
                pending_reviews,
                pending_feedback,
                expected_modes,
                settings: settings.clone(),
                claims,
                fork: fork_state,
                daemon_status,
                active_browser,
                browser_tabs,
                snapshot_cache,
                active_mission,
                active_surface,
                polis,
            };
            tauri::async_runtime::spawn(run_server(app_state));
            boot_trace::mark(boot_trace::DAEMON_START);

            // Extension tokens (manifest v1 external + v2 wasm): mint
            // per-boot scoped tokens for every valid manifest under
            // ~/.redline/extensions, before any agent or extension can race
            // the daemon. Skip-with-warning posture — a bad manifest never
            // blocks the boot. Wasm extensions then run in-process on the
            // extension host; their token stays in memory only.
            if let Some(ext_root) = extension::extensions_root() {
                let booted = extension::install_boot_tokens(&ext_root);
                if !booted.is_empty() {
                    tracing::info!("{} extension token(s) issued", booted.len());
                }
                let disabled: std::collections::HashSet<String> = store
                    .database()
                    .get_setting(EXTENSIONS_DISABLED_KEY)
                    .and_then(|raw| serde_json::from_str(&raw).ok())
                    .unwrap_or_default();
                extension_host::start(app.handle().clone(), booted, &disabled);
                boot_trace::mark(boot_trace::EXTENSION_SCAN);

                // B4 metadata-only launch check: refresh the cached index
                // and surface available updates — but ONLY when a cache
                // already exists (the user has opened the marketplace at
                // least once). Redline never phones home on its own; see
                // docs/local-only-audit.md. Updates are never installed
                // here — installing is always an explicit, re-consented
                // user action.
                let launch_store = store.clone();
                let launch_app = app.handle().clone();
                if launch_store.database().get_setting(MARKETPLACE_CACHE_KEY).is_some() {
                    tauri::async_runtime::spawn(async move {
                        let Ok(fresh) = marketplace::fetch_index().await else {
                            return; // offline is fine — the cache stands
                        };
                        let Ok((entries, _)) = marketplace::parse_index(&fresh) else {
                            return;
                        };
                        {
                            let db = launch_store.database();
                            let _ = db.set_setting(MARKETPLACE_CACHE_KEY, &fresh);
                            let _ = db.set_setting(
                                MARKETPLACE_FETCHED_KEY,
                                &extension_host::now_ms().to_string(),
                            );
                        }
                        let updates: Vec<String> =
                            marketplace::enrich(entries, &installed_pairs())
                                .into_iter()
                                .filter(|m| {
                                    m.state == marketplace::InstallState::UpdateAvailable
                                })
                                .map(|m| format!("{} {}", m.entry.name, m.entry.version))
                                .collect();
                        if !updates.is_empty() {
                            db::note_friction(
                                "extension_update_available",
                                Some("extensions"),
                                None,
                                Some(&updates.join(", ")),
                            );
                            let _ = launch_app.emit("extensions-changed", ());
                        }
                    });
                }
            }

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

            // macOS app menu: take the stock menu (the default Edit submenu's
            // copy/paste must survive — this app is an editor) and slot
            // Check for Updates… / View README into the application submenu,
            // right after About — the standard macOS position.
            let app_menu = Menu::default(app.handle())?;
            let check_updates = MenuItem::with_id(
                app,
                "check_updates",
                "Check for Updates…",
                true,
                None::<&str>,
            )?;
            let show_tutorial = MenuItem::with_id(
                app,
                "show_tutorial",
                "Getting Started",
                true,
                None::<&str>,
            )?;
            let view_readme =
                MenuItem::with_id(app, "view_readme", "View README", true, None::<&str>)?;
            let send_feedback =
                MenuItem::with_id(app, "send_feedback", "Send Feedback…", true, None::<&str>)?;
            let remove_hook = MenuItem::with_id(
                app,
                "remove_hook",
                "Remove Redline Hook…",
                true,
                None::<&str>,
            )?;
            let top_items = app_menu.items()?;
            if let Some(MenuItemKind::Submenu(app_submenu)) = top_items.first() {
                app_submenu.insert_items(
                    &[
                        &PredefinedMenuItem::separator(app)?,
                        &check_updates,
                        &show_tutorial,
                        &view_readme,
                        &send_feedback,
                        &PredefinedMenuItem::separator(app)?,
                        &remove_hook,
                    ],
                    1,
                )?;
            }
            // ⌘W never closes the window. The stock File submenu (index 1 on
            // macOS) holds only "Close Window" bound to Cmd+W; swap it for our
            // own item carrying that accelerator and let the frontend close
            // from the inside out on the `menu-close-tab` event — browser
            // page → pane → tab (App owns the event; it routes a browser
            // page's close to the pane in front). The window closes on ⌘⇧W,
            // a workbench_menu.rs item. A menu key-equivalent fires regardless
            // of which (native) webview has focus, so it works even while a
            // video tab is focused.
            if let Some(MenuItemKind::Submenu(file_submenu)) = top_items.get(1) {
                while !file_submenu.items()?.is_empty() {
                    file_submenu.remove_at(0)?;
                }
                // Neutral "Close" label — honest whether it closes a browser
                // page, a pane or a tab.
                let close_tab = MenuItemBuilder::with_id("close_tab", "Close")
                    .accelerator("CmdOrCtrl+W")
                    .build(app)?;
                file_submenu.append(&close_tab)?;
                // ⌘⌥P prints the active browser tab (the pane decides
                // whether a browser tab is in front; see `menu-print`). ⌘P
                // is the workbench's Go to File (workbench_menu.rs).
                let print = MenuItemBuilder::with_id("print_page", "Print…")
                    .accelerator(PRINT_ACCELERATOR)
                    .build(app)?;
                file_submenu.append_items(&[&PredefinedMenuItem::separator(app)?, &print])?;
            }
            // The stock Edit submenu (index 2 on macOS) carries predefined
            // Undo/Redo whose Cmd+Z / Cmd+Shift+Z key-equivalents AppKit
            // resolves at the NSMenu layer — *before* the keystroke reaches the
            // WKWebView — so ProseMirror's (drafter) and Yjs's (plan editor)
            // history keymaps never run and undo is a silent no-op. Rebuild the
            // submenu without those two items: keep cut/copy/paste/select-all
            // (native roles the webview honors), and with nothing claiming the
            // undo accelerators they fall through to the webview, where the
            // editor's own history handles them.
            if let Some(MenuItemKind::Submenu(edit_submenu)) = top_items.get(2) {
                while !edit_submenu.items()?.is_empty() {
                    edit_submenu.remove_at(0)?;
                }
                edit_submenu.append_items(&[
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ])?;
            }
            app.set_menu(app_menu)?;
            // Menu event IDs are global: this handler and the tray's both see
            // every event, so each matches its own IDs and falls through.
            app.on_menu_event(|app, event: MenuEvent| match event.id().as_ref() {
                "check_updates" => update::check_for_updates(app.clone()),
                id @ ("view_readme" | "send_feedback" | "show_tutorial") => {
                    // Surface the window first so the modal never opens hidden.
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                    let event = match id {
                        "view_readme" => "menu-open-readme",
                        "send_feedback" => "menu-open-feedback",
                        _ => "menu-open-tutorial",
                    };
                    let _ = app.emit(event, ());
                }
                "remove_hook" => remove_hook_via_menu(app),
                // Cmd+W → App closes from the inside out: browser page →
                // pane → tab. Never the window (that is ⌘⇧W, below).
                "close_tab" => {
                    let _ = app.emit("menu-close-tab", ());
                }
                "print_page" => {
                    let _ = app.emit("menu-print", ());
                }
                // The workbench's own items (workbench_menu.rs): ⌘T / ⌘⇧T /
                // ⌘⇧W and the Tabs submenu, installed by the frontend as it
                // mounts. The number is an i32: a cycle direction (±1) or a
                // tab index (0..7, −1 = last).
                id => match workbench_menu::event_for(id) {
                    Some((event, Some(n))) => {
                        let _ = app.emit(event, n);
                    }
                    Some((event, None)) => {
                        let _ = app.emit(event, ());
                    }
                    None => {}
                },
            });

            // Background update check on launch: the same comparison the menu
            // item runs, but quiet — it only interrupts to offer a real rebuild,
            // staying silent when up to date or offline. Gives users the update
            // prompt hands-free instead of only when they remember to look.
            //
            // Not from a probe (it would reach the network and could offer to
            // rebuild the user's real checkout).
            if runtime_profile::current().external_effects() {
                update::check_for_updates_in_background(app.handle().clone());
            }

            boot_trace::mark(boot_trace::SETUP_DONE);
            Ok(())
        })
        .build({
            let mut context = tauri::generate_context!();
            if !runtime_profile::current().persist_webview_storage() {
                // Non-persistent WebView storage, decided before the window is
                // created because that is the only moment it can be.
                //
                // macOS keys cookies, local storage, IndexedDB and service
                // workers to the BUNDLE IDENTIFIER, which a candidate shares
                // with the installed app — so pointing the probe at a
                // different data directory does not move any of it. A probe
                // without this reads, and writes, the user's real browser
                // state.
                for window in context.config_mut().app.windows.iter_mut() {
                    window.incognito = true;
                }
            }
            context
        })
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // From here on this thread is the UI thread, and the database
            // must never be waited on from it (`db::mark_ui_thread`).
            if let tauri::RunEvent::Ready = event {
                db::mark_ui_thread();
            }
            // Kill any headless `claude` discussion forks on teardown so no
            // child is orphaned (PTYs SIGHUP-clean when their master closes).
            if let tauri::RunEvent::Exit = event {
                // Polis: a final crown-jewels snapshot of the ledger DB on quit.
                if let Some(store) = app_handle.try_state::<SessionStore>() {
                    if let Ok(dir) = app_handle.path().app_data_dir() {
                        let _ = snapshot_database(&store.database(), &dir, LEDGER_BACKUP_KEEP);
                    }
                }
                if let Some(fork) = app_handle.try_state::<fork::ForkState>() {
                    fork.kill_all();
                }
                if let Some(ai) = app_handle.try_state::<ai_review::AiReviewState>() {
                    ai.kill_all();
                }
                if let Some(browse) = app_handle.try_state::<browse::BrowseState>() {
                    browse.kill_all();
                }
                if let Some(mission) = app_handle.try_state::<mission::MissionState>() {
                    mission.kill_all();
                }
                if let Some(chat) = app_handle.try_state::<draft_chat::DraftChatState>() {
                    chat.kill_all();
                }
                if let Some(mem) = app_handle.try_state::<memchat::MemChatState>() {
                    mem.kill_all();
                }
                if let Some(comp) = app_handle.try_state::<companion::CompanionState>() {
                    comp.kill_all();
                }
                if let Some(voice) = app_handle.try_state::<voice::VoiceState>() {
                    voice.kill_all();
                }
                if let Some(dictation) = app_handle.try_state::<dictation::DictationState>() {
                    dictation.kill_all();
                }
                if let Some(whisper) = app_handle.try_state::<dictation_whisper::WhisperState>() {
                    whisper.kill();
                }
                if let Some(tts) = app_handle.try_state::<tts::TtsState>() {
                    tts.kokoro_kill();
                    tts.studio().kill();
                }
            }
        });
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "lib_plan_received_launch_tests.rs"]
mod plan_received_launch_tests;
