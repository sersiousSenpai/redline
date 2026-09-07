// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
mod agent;
mod ai_commit;
mod ai_review;
mod auth;
mod binprobe;
mod bookshelf;
mod boot_trace;
mod browse;
mod browse_list;
mod browse_locate;
#[cfg(target_os = "macos")]
mod browser_popup;
mod bundle;
mod classmem;
mod codehealth;
mod claude_proc;
mod code;
mod combine;
mod companion;
mod compose;
mod context;
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
mod fork;
mod fsbrowse;
mod fswatch;
mod harness;
mod highlight;
mod hook;
mod codex_hook;
mod codex_profile;
mod codex_app_server;
mod inspect;
mod intake;
mod moot;
mod keeper;
mod ledger;
mod linked;
mod librarian;
mod local_install;
mod marketplace;
mod seatassign;
/// App-side MCP remnant: the `~/.claude.json` snippet generator for the
/// settings surface. The protocol core + proxy binary moved to the
/// `crates/redline-mcp` workspace member (size lever — see that crate's docs).
pub mod mcp;

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
mod parser;
#[cfg(test)]
mod perf_guard;
mod postboot;
mod preflight;
mod project;
mod plan_meter;
mod polis_host;
mod pty;
mod push;
mod query;
mod queue;
mod repoicon;
mod resolutions;
mod restore_context;
mod review;
mod review_feedback;
mod runwatch;
#[cfg(target_os = "macos")]
mod scroller_guard;
mod webview_guard;
mod seat;
mod shipwright;
mod shots;
mod skill;
mod state;
mod thumbs;
mod tts;
mod turn;
mod update;
mod userconfig;
mod voice;
mod work;
mod worktree;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Duration;

use axum::{
    extract::{ConnectInfo, Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Redirect},
    routing::{get, post},
    Json, Router,
};
use std::net::SocketAddr;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{
    menu::{
        CheckMenuItem, Menu, MenuBuilder, MenuEvent, MenuItem, MenuItemBuilder, MenuItemKind,
        PredefinedMenuItem, SubmenuBuilder,
    },
    tray::TrayIconBuilder,
    AppHandle, Emitter, Listener, Manager,
};
use tokio::sync::{oneshot, Notify};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::db::Database;
use crate::hook::HookStatus;
use crate::skill::SkillStatus;
use crate::state::{
    now_millis, AttachState, Comment, InterceptionMode, NewCommentRequest, ReviewSession,
    SessionStatus, SessionStore, SessionSummary, SourceFeedback, SubmissionMode,
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
/// UUID (8-4-4-4-12 hex), the shape of every claude session id — the
/// `valid_agent_id` discipline from runwatch. A rekey relocates a live review
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
    /// Every review holding a curl right now. The abandoned-run sweep's
    /// evidence that a quiet run is waiting on a human rather than dead.
    pub(crate) fn held_ids(&self) -> Vec<String> {
        self.map.lock().unwrap().keys().cloned().collect()
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
    let (who, what) = if backend == "codex" {
        ("Codex", "the Codex session")
    } else {
        ("Claude", "the Claude Code session")
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
/// same session happens to get (an ask-mode violation, an orchestrator refusal)
/// — the stash outlives its delivery by design, so it is not a safe signal.
fn feedback_deny_reason(
    mode: SubmissionMode,
    session_id: &str,
    backend: &str,
    payload: &str,
) -> String {
    if backend == "codex" {
        let lead = match mode {
            SubmissionMode::Revise =>
                "✅ Plan returned to Redline for revision — nothing failed. The reviewer's \
                 feedback follows; you already have it, so do not try to fetch anything. \
                 Produce the revised plan per your Redline plan contract (keep every \
                 `rl:blk-` marker exactly where its block's content remains, answer every \
                 comment id in a REDLINE_RESOLUTIONS block) and end your turn with one \
                 fresh `<proposed_plan>` block.",
            SubmissionMode::Ask =>
                "✅ Returned to Redline — the reviewer has questions and is NOT requesting \
                 changes. They follow; you already have them, so do not try to fetch \
                 anything. Answer them in the REDLINE_RESOLUTIONS block and re-emit the \
                 plan body byte-for-byte unchanged in one `<proposed_plan>` block.",
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

/// Advance an orchestrated run's lifecycle chip and tell the UI — the one
/// emission seam every beacon (click, ingest claim, review start, review
/// feedback, stall, resolution) shares. The store setter journals and
/// reports whether the state actually changed; only a real transition emits.
fn advance_run_state(app: &AppHandle, store: &SessionStore, session_id: &str, state: &str) {
    if store.set_run_state(session_id, state) {
        // Landing a run closes out the work that run opened. Every close path
        // in `db.rs` already existed and none of them was ever reached from a
        // transition — `work_items` carries 595 rows and has never closed one,
        // so "open work" had stopped meaning anything.
        //
        // The scope is deliberately narrow: items whose origin IS this plan
        // session. Exit-report residue (origin `"plan_run"`) stays open on
        // purpose — that is precisely the work the run did NOT deliver, and
        // landing the run is not evidence it got done. Librarian items keep
        // their own close-then-recur cycle.
        if run_state_closes_work(state) {
            close_run_work_items(&store.database(), session_id);
        }
        let _ = app.emit(
            "run-state-changed",
            SessionEvent {
                session_id: session_id.to_string(),
            },
        );
    }
}

/// Which run states retire the run's open work. Exactly one: `landed` is the
/// only transition that means "this run is done". `stalled` explicitly does
/// not — a stalled run's work is still owed.
fn run_state_closes_work(state: &str) -> bool {
    state == "landed"
}

/// Close the work a landed run opened. Returns the ids that moved.
///
/// The seam behind `advance_run_state`'s `landed` transition, factored out so
/// it is testable without an `AppHandle`. Scope is deliberately narrow: items
/// whose origin IS this plan session. Exit-report residue (origin
/// `"plan_run"`) stays open on purpose — that is precisely the work the run
/// did NOT deliver, and landing the run is not evidence it got done. Librarian
/// items keep their own close-then-recur cycle.
fn close_run_work_items(db: &Database, session_id: &str) -> Vec<String> {
    match db.close_open_work_items_for_origin("session", session_id, "landed", ledger::now_millis())
    {
        Ok(ids) => {
            if !ids.is_empty() {
                tracing::info!(
                    session_id,
                    count = ids.len(),
                    items = ?ids,
                    "run landed — closed its session-origin work items"
                );
            }
            ids
        }
        Err(e) => {
            tracing::warn!(error = %e, session_id, "failed to close work items on landing");
            Vec::new()
        }
    }
}

/// Where the review-feedback beacon walks the run chip: an approval is the
/// human sign-off that ends the run (`landed`); a feedback round hands the
/// work back to the orchestrator (`running`).
fn review_verdict_run_state(approve: bool) -> &'static str {
    if approve {
        "landed"
    } else {
        "running"
    }
}

/// What a no-held-curl review submit does — the pure seam behind
/// `submit_review_feedback`'s parked (overnight) branch. Valid only when a
/// durable review→plan link exists AND the plan's chip still says
/// `awaiting_review`; then an approve LANDS the review (chip walks
/// `awaiting_review` → `landed`, still-unresolved annotations file as work
/// items) while a feedback verdict holds the park (chip unchanged, nothing
/// files — the annotations stay stored for the follow-up session).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ParkedVerdict {
    /// No parked review behind this id — reject the submit.
    NotParked,
    /// Approve: chip → `landed`; unresolved annotations file. Only here.
    Land,
    /// Feedback: chip stays `awaiting_review`; nothing files.
    Hold,
}

fn parked_verdict(link_present: bool, run_state: Option<&str>, approve: bool) -> ParkedVerdict {
    if !link_present || run_state != Some("awaiting_review") {
        ParkedVerdict::NotParked
    } else if approve {
        ParkedVerdict::Land
    } else {
        ParkedVerdict::Hold
    }
}

/// How long after the Orchestrate click we wait for ANY beacon before calling
/// the run stalled. The first beacon (the ingest claim → `running`) normally
/// arrives within seconds of the typed prompt landing.
const ORCHESTRATE_STALL_WINDOW: Duration = Duration::from_secs(5 * 60);

/// Pure step for the stall watchdog (the `watchdog_step` seam, one-shot
/// variant): fire only when the chip still reads `orchestrating` — no ingest
/// claim, no review, no report ever arrived. Any other value means a beacon
/// landed (or the run was never orchestrated) and the watchdog retires.
fn orchestrate_stall_should_fire(run_state: Option<&str>) -> bool {
    run_state == Some("orchestrating")
}

/// How long a run that reached `running` may go silent — nothing written
/// anywhere in its artifact set — before the stall sweep calls it.
///
/// `ORCHESTRATE_STALL_WINDOW` only ever walks `orchestrating → stalled`: it
/// covers the launch window and nothing after it. Once the ingest claim
/// landed, a run that then went quiet had no backstop short of the
/// abandoned-run sweep's full day, and the only earlier signal was the FE's
/// per-agent 3-minute dot — which requires someone to be watching the Runs
/// surface, i.e. exactly the thing a watchdog exists to not require.
///
/// An hour is deliberately generous: a workflow phase can be legitimately
/// quiet, and `run_last_activity_ms` already counts the subagent trees so a
/// healthy fan-out is never silent. A false positive costs a chip that reads
/// `stalled` until the next beacon overwrites it (`set_run_state` enforces no
/// ordering), which is the same self-correcting bargain the other two
/// watchdogs take.
pub(crate) const RUNNING_SILENCE_WINDOW: Duration = Duration::from_secs(60 * 60);

/// Pure decision for the running-silence half of the stall sweep. The two
/// vetoes are the abandoned-run sweep's, for the same reason: a run that is
/// quiet BECAUSE a human is holding it is not stalled, and saying so is a lie
/// the user then has to undo.
pub(crate) fn running_silence_should_stall(
    run_state: Option<&str>,
    silent_ms: i64,
    window_ms: i64,
    held_post: bool,
    review_link_live: bool,
) -> bool {
    run_state == Some("running")
        && silent_ms > window_ms
        && !held_post
        && !review_link_live
}

/// The run states the abandoned-run sweep may touch.
///
/// `orchestrating` is the 5-minute launch watchdog's territory (above);
/// `awaiting_review` is a deliberate overnight park, not an abandonment; and
/// `landed` / `stalled` are already terminal. What is left is a run that
/// claimed the work (`running`) or opened a review (`in_code_review`) and then
/// went silent — the live DB has one sitting in exactly that shape for 18+
/// days, because nothing was watching for it.
pub(crate) const ABANDONED_RUN_STATES: &[&str] = &["running", "in_code_review"];

/// How long a run may sit untouched before the sweep calls it abandoned. A
/// day, deliberately generous: a real run can be quiet for a long stretch, and
/// the cost of a false positive is only a chip that reads `stalled` until the
/// next beacon overwrites it.
pub(crate) const ABANDONED_RUN_WINDOW: Duration = Duration::from_secs(24 * 60 * 60);

/// Pure decision for the abandoned-run sweep — every clause must hold.
///
/// Evidence-gated rather than timer-only: a run that is quiet BECAUSE a human
/// is looking at it is not abandoned, and stalling it would be a lie the user
/// then has to undo. So the two ways a run can legitimately be waiting are
/// both vetoes — a held plan POST for this session, and a held code review
/// that resolves back to it (the T4.1 link chain).
///
/// Self-correcting by construction: `set_run_state` enforces no ordering, so a
/// late real beacon simply overwrites `stalled`.
pub(crate) fn abandoned_run_should_stall(
    run_state: Option<&str>,
    idle_ms: i64,
    window_ms: i64,
    held_post: bool,
    review_link_live: bool,
) -> bool {
    run_state.is_some_and(|s| ABANDONED_RUN_STATES.contains(&s))
        && idle_ms > window_ms
        && !held_post
        && !review_link_live
}

/// One-shot stall detection for an orchestrated launch, in the
/// `arm_revise_watchdog` shape. A later beacon simply overwrites `stalled`
/// (`set_run_state` enforces no ordering — the beacons are the truth), so a
/// false positive from a slow launch self-corrects.
///
/// Kept at its call sites as cheap belt-and-braces: the durable detector is
/// now the keeper bus's `orchestrate-stall-sweep` watch, which periodically
/// walks ANY session sitting in `orchestrating` past the window to `stalled`
/// — including one whose one-shot task died with a restart. This one-shot
/// merely catches the common case a sweep-cadence earlier.
fn arm_orchestrate_stall_watchdog(app: AppHandle, store: SessionStore, session_id: String) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(ORCHESTRATE_STALL_WINDOW).await;
        let state = store.database().get_run_state(&session_id);
        if orchestrate_stall_should_fire(state.as_deref()) {
            tracing::info!(session_id = %session_id, "orchestrate stall watchdog fired");
            advance_run_state(&app, &store, &session_id, "stalled");
        }
    });
}

/// review_id → plan session id for orchestrated runs: written when the
/// orchestrator's review curl carries `?plan=`, read by the feedback path to
/// cycle the run chip back to `running`. In-memory only — a held review
/// never survives a restart, and the durable record lives in `plan_runs`.
fn orchestration_review_links() -> &'static StdMutex<HashMap<String, String>> {
    static G: OnceLock<StdMutex<HashMap<String, String>>> = OnceLock::new();
    G.get_or_init(|| StdMutex::new(HashMap::new()))
}

/// The settings key mirroring one orchestrate -> review link.
fn orch_review_link_key(review_id: &str) -> String {
    format!("orch_review_link:{review_id}")
}

/// Record which plan session a code review closes out — in memory AND on disk.
///
/// The map above is this boot's fast path and dies with the process, which is
/// exactly the failure this fixes: a LIVE (held) orchestrated review that
/// outlives a restart loses its plan link, so the human's verdict lands on
/// nothing and the run's chip is stranded mid-flight. The parked path already
/// had durability through `queue::note_parked`; this gives the held path the
/// same, using the settings table already open in front of us.
fn register_orchestration_review_link(db: &Database, review_id: &str, plan_sid: &str) {
    orchestration_review_links()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(review_id.to_string(), plan_sid.to_string());
    if let Err(e) = db.set_setting(&orch_review_link_key(review_id), plan_sid) {
        tracing::warn!(error = %e, review_id, "failed to persist the orchestrate->review link");
    }
}

/// Resolve a review back to its plan session: this boot's map first (always
/// current), then the overnight queue's parked entry, then the durable mirror.
/// `None` means the review isn't orchestrated at all.
fn orchestration_review_link(db: &Database, review_id: &str) -> Option<String> {
    orchestration_review_links()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(review_id)
        .cloned()
        .or_else(|| queue::parked_plan_for_review(db, review_id))
        .or_else(|| db.get_setting(&orch_review_link_key(review_id)))
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
    schedule_revise_probe(app, store, pending, revise_watch, last_pid, session_id, armed_gen);
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
    /// Legacy boolean view for `get_daemon_status`, whose contract is "can
    /// this window capture plans". A still-`Starting` daemon answers `true`:
    /// the caller is asking whether to show the blocking banner, and the
    /// answer to that while a bind is in flight is "not yet".
    fn is_bound(&self) -> bool {
        self.state() != DaemonState::Failed
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
    /// the browse/linked first-turn prompts (the orchestrator embeds the goal
    /// natively). `None` when no mission is active. Managed as Tauri state, so
    /// `browse_send`/`linked_send` can read it without a frontend round-trip.
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

/// Mirror the frontend's "where is the user" into the backend. Appends a
/// `surface_switch` journal row when the surface identity actually changed
/// (kind or id), so pure metadata refreshes (title updates) stay quiet.
#[tauri::command]
fn surface_set_active(
    active: tauri::State<'_, ActiveSurface>,
    store: tauri::State<'_, SessionStore>,
    mut info: SurfaceInfo,
) {
    if info.kind.trim().is_empty() {
        return;
    }
    info.updated_at = ledger::now_millis();
    let prev = active.get();
    let changed = prev.kind != info.kind || prev.id != info.id;
    active.set(info.clone());
    if changed {
        let _ = store.database().append_journal(
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
fn plan_passed_through(
    app_state: &AppState,
    session_id: &str,
    reason: &str,
) -> HookResponse {
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
    Json(payload): Json<Value>,
) -> Json<Value> {
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
        return Json(json!({}));
    };
    let normalized = json!({
        "session_id": payload.get("session_id").cloned().unwrap_or(Value::Null),
        "tool_use_id": payload.get("turn_id").cloned().unwrap_or(Value::Null),
        "cwd": payload.get("cwd").cloned().unwrap_or(Value::Null),
        "model": payload.get("model").cloned().unwrap_or(Value::Null),
        "tool_input": { "plan": plan },
        "redline_provider": "codex"
    });
    let decision = handle_plan_core(peer, app_state, normalized).await;
    if decision.hook_specific_output.permission_decision == "deny" {
        // The reason already carries the full review inline — `submit_review`
        // builds it that way for codex, because this session's sandbox has no
        // network and could never fetch it.
        Json(json!({
            "decision": "block",
            "reason": decision.hook_specific_output.permission_decision_reason
        }))
    } else {
        // A successful Stop hook lets the completed Plan-mode turn finish.
        Json(json!({}))
    }
}

async fn handle_plan_core(
    peer: SocketAddr,
    app_state: AppState,
    payload: Value,
) -> HookResponse {
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
        return allow_response(
            "Redline is paused — this plan was auto-approved without review.",
        );
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

    // A7: a claude session linked as an orchestrator (the ingest claim wrote
    // `session → plan session` lineage) must never mint a review session of
    // its own. It was launched to EXECUTE an approved plan; an ExitPlanMode
    // from it would open a brand-new review in that repo and hold the
    // orchestrator for up to 12 hours behind a review nobody asked for.
    if let Some(plan_sid) = app_state
        .store
        .database()
        .orchestrator_parent_session(&session_id)
    {
        tracing::warn!(
            session_id = %session_id, plan_session = %plan_sid,
            "refusing ExitPlanMode from an orchestrator session"
        );
        let _ = app_state.store.database().record_friction(
            "orchestrator_plan_refused",
            Some("plan"),
            Some(&session_id),
            Some(&plan_sid),
        );
        return deny_response(
            "✅ You are the orchestrator for a plan already approved in Redline. Do NOT \
             plan or call ExitPlanMode — execute the approved plan as your launch prompt \
             instructs, then file the exit report and open the code review.",
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
            fsbrowse::rekey_session_attachments(
                &app_state.app_handle,
                &target,
                &session_id,
            );
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

    response
}

/// The daemon's bind address. Loopback-only by invariant (cold-wallet posture,
/// README.md/SPEC.md) — pinned by `daemon_binds_loopback_only`.
const DAEMON_ADDR: &str = "127.0.0.1:7676";

/// How many dated DB snapshots to retain under `backups/`.
const LEDGER_BACKUP_KEEP: usize = 7;

/// Crown-jewels backup: `VACUUM INTO` a dated snapshot of the whole DB under
/// `<app-data>/backups/`, then prune to the newest `keep`. The ledger is
/// append-only and hash-chained, so a corrupted `redline.db` would otherwise be
/// unrecoverable; the mirror/export are secondary content copies, this protects
/// the chain itself. Best-effort and self-contained — logs and returns on any
/// error rather than propagating.
fn snapshot_database(db: &db::Database, data_dir: &std::path::Path, keep: usize) {
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
        return;
    }
    // now_millis() is 13 digits until ~year 2286, so filenames sort
    // chronologically by plain lexical order.
    let dest = dir.join(format!("redline-{}.db", ledger::now_millis()));
    if let Err(e) = db.snapshot_to(&dest) {
        tracing::warn!(error = %e, "ledger DB snapshot failed");
        return;
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
}

/// Extract the submitted prompt text from a UserPromptSubmit payload. Empirical:
/// claude 2.1.199 delivers it at `prompt` (verified via the hook rig; see
/// docs/protocol-verification.md). We accept `user_input` too so a future key
/// rename degrades gracefully rather than silently capturing empties.
fn ingest_prompt_text(v: &serde_json::Value) -> String {
    v.get("prompt")
        .and_then(serde_json::Value::as_str)
        .or_else(|| v.get("user_input").and_then(serde_json::Value::as_str))
        .unwrap_or("")
        .trim()
        .to_string()
}

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
/// external `claude` session. Fact-based: a session running in a directory
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

/// `POST /v1/prompts/ingest` — the UserPromptSubmit capture hook's sink. Records
/// interactive prompts (PTY plan sessions + external sessions) into the ledger.
/// Fail-open: any error returns 200 so the hook never blocks prompt submission.
async fn handle_prompts_ingest(
    State(app_state): State<AppState>,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> axum::response::Response {
    // 64KB cap (reject oversized payloads without parsing).
    if body.len() > 64 * 1024 {
        return (StatusCode::OK, Json(serde_json::json!({ "skipped": "too_large" })))
            .into_response();
    }
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(&body) else {
        return (StatusCode::OK, Json(serde_json::json!({ "skipped": "unparseable" })))
            .into_response();
    };
    let prompt = ingest_prompt_text(&v);
    if prompt.is_empty() {
        return (StatusCode::OK, Json(serde_json::json!({ "skipped": "empty" }))).into_response();
    }
    let claude_session_id = v
        .get("session_id")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let cwd = v
        .get("cwd")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);

    // A headless `claude -p` fires this hook too, so Redline's own spawned
    // agents would be double-captured (Rust site + hook). The Rust site is
    // authoritative; it registers the body before spawn, so claim-and-skip here.
    //
    // The header is the primary mechanism and the hash guard is the fallback,
    // not the other way round: the guard can only recognize a body Rust predicts
    // byte-exactly, once, within 300s, while the header rides the spawn's own
    // environment and so also covers what an agent composes for itself mid-run
    // (sub-agent Task prompts, retries, resumed turns) — the residue that put
    // 4.32 MB of Redline's own instruction text into the searchable lake.
    //
    // Both are evaluated, and `claim_agent_prompt` runs FIRST and unconditionally
    // so the registration is consumed either way; the handoffs below (draft →
    // session, orchestration → run monitor) hang off this same branch and must
    // run for a header-marked spawn too — the overnight queue's orchestrator is
    // spawned through `claude_command_for_seat`, so it arrives here carrying the
    // header, and skipping early would cost it its `running` beacon and its
    // run-watcher anchor.
    let agent_seat = headers
        .get(hook::CAPTURE_AGENT_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    // A restore trigger, answered with the protocol the visible prompt no
    // longer carries. This is the ONE fire per restore where that is true:
    // the metadata rides the resumed `claude`'s environment, so it is on every
    // prompt that session ever submits, and only the arming — placed by the
    // click that dispatched the command — says which of them Redline wrote.
    // Claiming it here is therefore both the answer and the exclusion: the
    // trigger never reaches the lake, and the reviewer's own next prompt in
    // that same terminal is captured byte-for-byte as it always was.
    if let Some(body) = restore_context::answer(&headers, &prompt) {
        return (StatusCode::OK, Json(body)).into_response();
    }

    let bh = ledger::body_hash(&prompt);
    let claimed = ledger::claim_agent_prompt(&bh);
    // Every seat but one means "machine text, skip it". The restore seat is the
    // exception, and only because its variable outlives its one prompt: the
    // block above already claimed the trigger, so a `restore`-seated fire that
    // reaches here is the reviewer typing in a terminal Redline happened to
    // open for them. Suppressing it would quietly delete their prompts from
    // their own lake.
    let seat_suppresses = agent_seat
        .as_deref()
        .is_some_and(|s| s != restore_context::RESTORE_SEAT);
    if claimed || seat_suppresses {
        // The draft→launched-session handoff: this hook fire is the first
        // moment the spawned session's claude id is known. When the skipped
        // body was a drafter launch, link the new session under its draft —
        // the seam the whole temporal hierarchy hinges on.
        if let Some(claim) = ledger::claim_plan_launch(&bh) {
            if let Some(sid) = claude_session_id.as_deref().filter(|s| !s.is_empty()) {
                let db = app_state.store.database();
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
                let row_key = claim.row_hash.as_deref().unwrap_or(&bh);
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
                backfill_from_transcript(&db, &v, sid);
            }
        }
        // The Orchestrate handoff, same seam: when the skipped body was an
        // Orchestrate launch, this hook fire is the first moment the
        // orchestrator session's claude id is known — link it under the plan
        // session it executes, and flip the run chip to `running` (the claim
        // itself proves the orchestrator came up, so the beacon fires even if
        // the payload carried no session id for the lineage row).
        if let Some(plan_sid) = ledger::claim_orchestration_prompt(&bh) {
            if let Some(sid) = claude_session_id.as_deref().filter(|s| !s.is_empty()) {
                let db = app_state.store.database();
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
                    let launch_terminal = app_state
                        .app_handle
                        .try_state::<LaunchedTerminals>()
                        .and_then(|l| l.get(&plan_sid));
                    match db.upsert_orchestration(
                        &plan_sid,
                        sid,
                        tp,
                        cwd.as_deref(),
                        launch_terminal.as_deref(),
                    ) {
                        Ok(()) => runwatch::start(
                            &app_state.app_handle,
                            app_state.store.clone(),
                            plan_sid.clone(),
                        ),
                        Err(e) => {
                            tracing::warn!(error = %e, "failed to anchor orchestration for the run monitor")
                        }
                    }
                }
            }
            advance_run_state(&app_state.app_handle, &app_state.store, &plan_sid, "running");
        }
        return (
            StatusCode::OK,
            Json(serde_json::json!({
                "skipped": "agent_dup",
                "by": if claimed { "guard" } else { "header" },
                "seat": agent_seat,
            })),
        )
            .into_response();
    }

    let db = app_state.store.database();
    let origin = classify_prompt_origin(&db, cwd.as_deref());
    if origin == ledger::Origin::External {
        // External-session capture toggle (default on).
        let capture_external = db
            .get_setting("redline.capture.externalSessions")
            .map(|val| val != "false")
            .unwrap_or(true);
        if !capture_external {
            return (StatusCode::OK, Json(serde_json::json!({ "skipped": "external_off" })))
                .into_response();
        }
    }
    let surface = if origin == ledger::Origin::Redline {
        "pty"
    } else {
        "external"
    };
    let sid_for_backfill = claude_session_id.clone();
    let input = ledger::PromptInput {
        source: ledger::PromptSource::Hook,
        origin,
        surface: surface.to_string(),
        // The CLI fires `UserPromptSubmit` for its own injections too — a
        // `<task-notification>` or `<system-reminder>` arrives here shaped
        // exactly like a keystroke, and 109 of them were 1.78 MB of the lake.
        // They stay recorded (a task notification reports work the user's
        // session actually did) but they are not the user talking, and the
        // Timeline's role facet defaults to the user.
        role: ledger::CorpusRole::classify_captured(&prompt),
        user_text: None,
        session_id: None,
        claude_session_id,
        mission_id: None,
        project_path: cwd,
        body: prompt,
        thread: None,
        author: None, // hook-captured prompts are the human's own
        model: None,  // interactive sessions carry no seat; the transcript backfill stamps it
        model_source: None,
    };
    let response = match ledger::record_prompt(&db, input) {
        Ok(Some(seq)) => {
            let _ = app_state.app_handle.emit("ledger-changed", ());
            extension_host::publish(
                ext_events::LEDGER_CHANGED,
                &ext_events::LedgerChanged { ts_ms: extension_host::now_ms() },
            );
            (StatusCode::CREATED, Json(serde_json::json!({ "seq": seq }))).into_response()
        }
        Ok(None) => {
            (StatusCode::OK, Json(serde_json::json!({ "skipped": "dup" }))).into_response()
        }
        Err(e) => {
            tracing::warn!(error = %e, "prompt ingest failed");
            (StatusCode::OK, Json(serde_json::json!({ "skipped": "error" }))).into_response()
        }
    };
    // After the row exists: stamp this session's still-unstamped prompts from
    // the transcript tail. A brand-new session has no assistant turn yet — its
    // model lands on the next fire.
    if let Some(sid) = sid_for_backfill.as_deref().filter(|s| !s.is_empty()) {
        backfill_from_transcript(&db, &v, sid);
    }
    response
}

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
        Ok(bytes) => {
            ([(header::CONTENT_TYPE, viewer_content_type(&full))], bytes).into_response()
        }
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

/// `/viewer/` — the folded build's page first (embedded `viewer/index.html`,
/// whose chunk refs resolve at `/assets/*`), then the legacy standalone
/// bundle (whose refs resolve at `/viewer/assets/*`, still served below).
async fn handle_viewer_index(State(state): State<AppState>) -> axum::response::Response {
    if let Some(bytes) = embedded_dist_file(&state.app_handle, "viewer/index.html") {
        return (
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            bytes,
        )
            .into_response();
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
        Some(bytes) => (
            [(header::CONTENT_TYPE, viewer_content_type(&clean))],
            bytes,
        )
            .into_response(),
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
#[tauri::command(async)]
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
#[tauri::command(async)]
fn local_install_inspect(path: String) -> Result<LocalInstallPreview, String> {
    let folder = std::path::Path::new(&path);
    match local_install::detect(folder)? {
        local_install::FolderKind::Harness => {
            let h = local_install::read_harness_identity(folder)?;
            Ok(LocalInstallPreview::Harness { id: h.id, name: h.name })
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
#[tauri::command(async)]
fn local_install_confirm(
    store: tauri::State<'_, SessionStore>,
    path: String,
) -> Result<LocalInstallPreview, String> {
    let folder = std::path::Path::new(&path);
    match local_install::detect(folder)? {
        local_install::FolderKind::Harness => {
            let h = local_install::install_harness_folder(&userconfig::config_root(), folder)?;
            Ok(LocalInstallPreview::Harness { id: h.id, name: h.name })
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
#[tauri::command(async)]
fn extension_reload(
    store: tauri::State<'_, SessionStore>,
    name: String,
) -> Result<(), String> {
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
        .route("/v1/codex/stop", post(handle_codex_stop))
        // Polis prompt store (Phase 1): the global UserPromptSubmit capture hook
        // POSTs its stdin payload here. Fail-open by design — never 500s the hook.
        .route("/v1/prompts/ingest", post(handle_prompts_ingest))
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
        // drives the active browser tab through these routes via the
        // already-permitted `curl` allow. All act on the tab the user is
        // currently looking at (`AppState::active_browser`).
        .route("/v1/browser/active", get(handle_browser_active))
        .route("/v1/browser/tabs", get(handle_browser_tabs))
        .route("/v1/browser/thread", get(handle_browser_thread))
        .route("/v1/browser/snapshot", get(handle_browser_snapshot))
        .route("/v1/browser/query", post(handle_browser_query))
        .route("/v1/browser/navigate", post(handle_browser_navigate))
        .route("/v1/browser/click", post(handle_browser_click))
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
        // Linked discussion (browser pane): the "check in with a colleague" seam.
        // The linked agent POSTs here to run a tab's own browse agent for a
        // synthesized digest, keeping that tab's heavy thread out of its context.
        .route("/v1/linked/consult", post(handle_linked_consult))
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
        .route("/v1/code/git", get(handle_code_git))
        // ClassMemory (Phase 2): read-only catalog access for retrieval agents
        // (the class-router walk) + a staging-only proposals sink. All ride the
        // same pre-authorized `curl` allow. Nothing here accepts or moves a node
        // — POST /proposals only stages reviewable rows.
        .route("/v1/memory/tree", get(handle_memory_tree))
        .route("/v1/memory/node/:id", get(handle_memory_node))
        .route("/v1/memory/prompts", get(handle_memory_prompts))
        // The batched read: one call in place of the tree→node→search walk.
        .route("/v1/memory/answer-pack", get(handle_memory_answer_pack))
        .route("/v1/memory/grep", get(handle_memory_grep))
        .route("/v1/memory/proposals", post(handle_memory_proposals))
        // Context access (Phase 3): the Librarian agent's friction digest —
        // ground-truth counts/staleness (backlog, held proposals, stalled
        // reviews, bulging branches). Read-only; rides the same `curl` allow.
        .route("/v1/context/overview", get(handle_context_overview))
        // The Shipwright's code digest as JSON — an on-demand re-read for the
        // Companion / voice agent / MCP surface. The Shipwright itself never
        // depends on this: its digest is baked into the spawn prompt.
        .route("/v1/context/codehealth", get(handle_context_codehealth))
        // Context access (Phase 4): read-only query surface over the lake for
        // agents (internal via curl, external via the MCP proxy). Filtered
        // prompts, one session's full history, and aggregate stats. All bounded,
        // injection-safe (`q` is a bound LIKE), and ride the same `curl` allow.
        .route("/v1/context/prompts", get(handle_context_prompts))
        .route(
            "/v1/context/sessions/:id/history",
            get(handle_context_session_history),
        )
        .route("/v1/context/stats", get(handle_context_stats))
        .route("/v1/context/browse/search", get(handle_browse_search))
        // Memory-by-session (spine): generic read-only thread fetch across the
        // per-surface message tables, and the session-tree walk (a node with
        // its parent + child digests). Companion + external MCP consumers.
        .route("/v1/context/threads/:kind/:id", get(handle_context_thread))
        .route("/v1/context/tree/:kind/:id", get(handle_context_tree))
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
        // Orchestrated runs: the orchestrator session POSTs its structured
        // exit report here when the workflow ends, before opening the review.
        .route(
            "/v1/orchestration/report",
            post(handle_orchestration_report),
        )
        // Work graph (`work.rs` state plane): the durable item/edge store any
        // agent files into and claims from. Reads are open like every other
        // read surface; the writes carry the two work scopes. The handlers
        // live in `work.rs` — tables, queries, and routes only (no spawning).
        .route("/v1/work/ready", get(work::handle_work_ready))
        .route("/v1/work/:id", get(work::handle_work_get))
        .route("/v1/work", post(work::handle_work_file))
        .route("/v1/work/:id/claim", post(work::handle_work_claim))
        .route("/v1/work/:id/close", post(work::handle_work_close))
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
        // Control-plane auth (Shardplate Phase 2): every request is checked
        // against the frozen v1 contract in `auth::ROUTE_TABLE` — mutating
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
    match tokio::net::TcpListener::bind(DAEMON_ADDR).await {
        Ok(listener) => {
            daemon_status.set_bound(true);
            boot_trace::mark(boot_trace::DAEMON_BIND);
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
            boot_trace::mark(boot_trace::DAEMON_BIND);
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
    };
    if let Err(e) = db.insert_comment_offer(&offer) {
        return browser_error_response(e.to_string());
    }
    tracing::info!(
        session_id = %session_id,
        offer_id = %offer.id,
        agent = %offer.agent_id,
        "plan item offered (not written)"
    );
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
    (
        StatusCode::CREATED,
        Json(serde_json::json!({
            "id": offer.id,
            "status": "pending",
            "note": "offered — the user taps ＋ Add as item to create it; do not post it yourself",
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
return JSON.stringify({url:location.href, title:document.title||"", selection:sel.slice(0,2000), text:body, headings:headings, links:links});
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
    app_state
        .browser_tabs
        .get()
        .into_iter()
        .find(|t| t.label == label)
        .map(|t| t.browse_id)
        .ok_or_else(|| browser_error_response(format!("no discussion thread for tab: {label}")))
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
                || app_state.browser_tabs.get().iter().any(|t| t.label == label)
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

/// Ensure a tab's webview is live, waking a suspended one **in the background**.
/// This is deliberately NOT a focus switch (`/focus`): it asks `BrowserPane` to
/// recreate the webview hidden — the active tab and discussion pane don't move —
/// so the agent can run a live query/action on a background tab without
/// disturbing the user. Waits for the webview to materialize, then for the DOM
/// to be usable. No-op if the tab is already live.
#[cfg(target_os = "macos")]
async fn ensure_live(app_state: &AppState, label: &str) -> Result<(), axum::response::Response> {
    if app_state.app_handle.get_webview(label).is_some() {
        return Ok(());
    }
    let id = label.strip_prefix("browser-").unwrap_or(label).to_string();
    if let Err(e) = app_state
        .app_handle
        .emit("browse-wake-tab", serde_json::json!({ "id": id }))
    {
        return Err(browser_error_response(format!(
            "could not signal the browser pane: {e}"
        )));
    }
    // Wait for the webview to come back.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(6);
    loop {
        if app_state.app_handle.get_webview(label).is_some() {
            break;
        }
        if std::time::Instant::now() >= deadline {
            return Err(browser_error_response(format!("timed out waking tab '{label}'")));
        }
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    }
    // Wait for the DOM to be usable so an immediate query/click sees the page.
    // (There is no navigation-finished signal, so poll readyState briefly.)
    let ready_deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
    let probe = "(function(){try{return document.readyState;}catch(e){return \"\";}})()";
    loop {
        if let Ok(s) = daemon_eval(&app_state.app_handle, label, probe).await {
            if s == "complete" || s == "interactive" {
                break;
            }
        }
        if std::time::Instant::now() >= ready_deadline {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
async fn ensure_live(_app_state: &AppState, _label: &str) -> Result<(), axum::response::Response> {
    Err(browser_error_response("browser control is only supported on macOS"))
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
    let Some(wv) = app_state.app_handle.get_webview(&label) else {
        return browser_error_response(format!("browser webview '{label}' not found"));
    };
    let Ok(parsed) = req.url.parse() else {
        return browser_error_response(format!("invalid url: {}", req.url));
    };
    match wv.navigate(parsed) {
        Ok(()) => Json(serde_json::json!({ "ok": true, "url": req.url })).into_response(),
        Err(e) => browser_error_response(e.to_string()),
    }
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
    // Inject the selector as a JSON string literal — never as code.
    let sel_json = serde_json::to_string(&req.selector).unwrap_or_else(|_| "\"\"".to_string());
    let program = format!(
        "(function(){{try{{var el=document.querySelector({sel});if(!el){{return JSON.stringify({{ok:false,error:\"no match\"}});}}el.click();return JSON.stringify({{ok:true}});}}catch(e){{return JSON.stringify({{ok:false,error:String(e)}});}}}})()",
        sel = sel_json
    );
    eval_json_response(daemon_eval(&app_state.app_handle, &label, &program).await)
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
        Ok(messages) => Json(serde_json::json!({ "browseId": browse_id, "messages": messages }))
            .into_response(),
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

#[derive(Deserialize)]
struct ConsultReq {
    /// Tab selector — a 1-based tab number (from `/v1/browser/tabs`), id, or
    /// label. Absent → the active tab.
    tab: Option<String>,
    question: String,
}

/// `POST /v1/linked/consult` — the linked discussion "checks in with a
/// colleague". Runs the selected tab's OWN browse agent (which already holds
/// that tab's full thread) with a synthesis-framed question and returns only its
/// digest: `{digest, n, title}`. This is the map-reduce seam that lets one
/// conversation span many tabs without the linked agent re-deriving each tab's
/// heavy context itself. Blocks for the turn (bounded by `BrowseState::consult`'s
/// timeout); a busy tab returns a 502 the agent surfaces and retries.
async fn handle_linked_consult(
    State(app_state): State<AppState>,
    Json(req): Json<ConsultReq>,
) -> axum::response::Response {
    if req.question.trim().is_empty() {
        return browser_error_response("consult needs a question");
    }
    let browse_id = match resolve_browse_id(&app_state, req.tab.clone()) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    // Grounding snapshot for the colleague's first turn (best-effort from cache;
    // the colleague can /snapshot itself if there's none).
    let snapshot = match resolve_label_any(&app_state, req.tab.clone()) {
        Ok(label) => app_state.snapshot_cache.get(&label).map(|s| s.json),
        Err(_) => None,
    };
    // The tab's number + title for the response envelope, so the linked agent can
    // attribute the digest ("tab 2 — Example").
    let (n, title) = app_state
        .browser_tabs
        .get()
        .into_iter()
        .enumerate()
        .find(|(_, t)| t.browse_id == browse_id)
        .map(|(i, t)| (Some(i as i64 + 1), t.title))
        .unwrap_or((None, String::new()));

    let browse = app_state
        .app_handle
        .state::<browse::BrowseState>()
        .inner()
        .clone();
    match browse
        .consult(
            app_state.app_handle.clone(),
            browse_id,
            req.question,
            snapshot,
        )
        .await
    {
        Ok(digest) => Json(serde_json::json!({
            "digest": digest,
            "n": n,
            "title": title,
        }))
        .into_response(),
        Err(e) => browser_error_response(e),
    }
}

#[derive(Deserialize)]
struct GlobalConsultReq {
    /// `browse | plan | mission | linked | drafter`. `voice` and `companion`
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
/// the `companion` skill documents this route (linked documents only
/// /v1/linked/consult → browse), so consult chains bottom out at depth 2.
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
            // Tab selectors resolve exactly like /v1/linked/consult.
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
        "linked" => {
            let linked = handle.state::<linked::LinkedState>().inner().clone();
            let label = app_state
                .store
                .database()
                .thread_label("linked", &req.id)
                .unwrap_or_else(|| "a linked discussion".to_string());
            tokio::time::timeout(outer, linked.consult(req.id.clone(), question))
                .await
                .map_err(|_| "the consult timed out".to_string())
                .and_then(|r| r)
                .map(|digest| (digest, label))
        }
        "drafter" => {
            let chat = handle.state::<draft_chat::DraftChatState>().inner().clone();
            let label = app_state
                .store
                .database()
                .thread_label("drafter", &req.id)
                .unwrap_or_else(|| "a draft".to_string());
            tokio::time::timeout(outer, chat.consult(req.id.clone(), question))
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
                     browse|plan|mission|linked|drafter|companion|shipwright"
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
    let linked_state = handle.state::<linked::LinkedState>();
    let linkeds: Vec<serde_json::Value> = db
        .list_linked()
        .unwrap_or_default()
        .into_iter()
        .map(|l| {
            serde_json::json!({
                "surface": "linked",
                "id": l.linked_id,
                "label": l.title,
                "status": l.status,
                "consultable": true,
                "busy": linked_state.is_running(&l.linked_id),
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
        "linked": linkeds,
        "chats": chats,
        "reviews": reviews,
        "shipwright": shipwright,
        "notes": "consult browse|plan|mission|linked|drafter|companion|shipwright \
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
    /// Orchestrated runs: the plan session this review closes out. Links the
    /// review to the run chip (`in_code_review` on open, back to `running` on
    /// a feedback round). Absent for every ordinary review.
    plan: Option<String>,
    /// Deferred mode (`defer=1`): PARK the review instead of holding — the
    /// row is created (round bumped, annotations re-anchored) and the call
    /// returns immediately; the human resolves it in the morning through the
    /// existing pane. Queued overnight runs use this with `source=runBranch`,
    /// whose diff is durable on the run's committed branch. With `plan=`, the
    /// run chip walks to `awaiting_review`.
    defer: Option<String>,
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

    // Deferred (parked) mode — the overnight queue's morning handoff: the
    // review row exists (round bumped, annotations re-anchored) and the call
    // returns IMMEDIATELY instead of holding. No pane-open emit at 3am; the
    // run chip (`awaiting_review`) is the morning's discovery surface, and
    // the human resolves the review through the existing pane. The diff is
    // durable because a queued run ends committed to its run branch and this
    // review's source reads that branch.
    if matches!(
        q.defer.as_deref().map(str::trim),
        Some("1") | Some("true")
    ) {
        let _ = db.append_journal(
            "review_parked",
            Some("review"),
            Some(&session.review_id),
            Some(&session.repo_path),
            Some(&format!("round {}", session.round)),
        );
        if let Some(plan_sid) = q.plan.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            // Both links: the in-memory map (this boot's verdict path) plus a
            // durable mirror, and the queue entry (which the overnight runner
            // reads on its own).
            register_orchestration_review_link(&db, &session.review_id, plan_sid);
            queue::note_parked(&db, plan_sid, &session.review_id);
            advance_run_state(
                &app_state.app_handle,
                &app_state.store,
                plan_sid,
                "awaiting_review",
            );
        }
        tracing::info!(
            review_id = %session.review_id,
            round = session.round,
            files = files.len(),
            "review parked (deferred mode) — returning immediately"
        );
        return (
            StatusCode::OK,
            format!(
                "Review parked for the morning as review {} (round {}). The reviewer will go \
                 through it in Redline's review pane when they are back — do not wait for \
                 feedback; finish your exit report and end the session.\n",
                session.review_id, session.round
            ),
        )
            .into_response();
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

    // Orchestrated run: remember which plan session this review closes out
    // and flip its chip to `in_code_review`. Re-registered every round, and
    // mirrored to disk — a held review outlives any single curl, and now also
    // outlives a restart.
    if let Some(plan_sid) = q.plan.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        register_orchestration_review_link(&db, &session.review_id, plan_sid);
        advance_run_state(
            &app_state.app_handle,
            &app_state.store,
            plan_sid,
            "in_code_review",
        );
    }

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
fn review_hold_active(
    pending: tauri::State<'_, PendingReviews>,
    review_id: String,
) -> bool {
    pending.has(&review_id)
}

/// Submit the review: serialize the current annotation set (or the approval
/// line) into the held curl's response. The review analog of `submit_review`.
#[tauri::command]
fn submit_review_feedback(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
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
        // Parked (overnight) review: no curl is held — the queued run ended
        // hours ago with its diff committed to the run branch. The human's
        // morning verdict still lands: an approve walks the chip through the
        // SAME mapping a held review uses (`awaiting_review` → `landed`; no
        // ordering is enforced). A feedback verdict keeps `awaiting_review` —
        // the annotations are stored for the follow-up session; nothing is
        // running to hand them to.
        let db = review_state.db.clone();
        let plan_sid = orchestration_review_link(&db, &review_id);
        let run_state = plan_sid.as_deref().and_then(|sid| db.get_run_state(sid));
        let verdict = parked_verdict(plan_sid.is_some(), run_state.as_deref(), approve);
        if verdict == ParkedVerdict::NotParked {
            return Err(
                "no agent is waiting on this review — run /redline-code-review in the \
                 terminal first"
                    .to_string(),
            );
        }
        let plan_sid = plan_sid.expect("parked implies a plan link");
        if verdict == ParkedVerdict::Land {
            advance_run_state(&app, &store, &plan_sid, review_verdict_run_state(true));
            // Producers wave: a parked approval LANDS the review — file every
            // still-unresolved annotation as a durable work item.
            let filed = review::file_unresolved_annotations(&db, &review_id);
            if filed > 0 {
                tracing::info!(
                    review_id = %review_id, filed,
                    "parked review landing filed unresolved annotations as work items"
                );
            }
        }
        let _ = db.append_journal(
            "review_resolved_parked",
            Some("review"),
            Some(&review_id),
            Some(if approve { "approve" } else { "feedback" }),
            None,
        );
        tracing::info!(review_id = %review_id, approve, "parked review resolved (no held curl)");
        return Ok(());
    };
    let push = review_state
        .db
        .latest_push_for_review(&review_id)
        .filter(|p| held_since.is_some_and(|t| p.created_at >= t));
    let payload = if approve {
        // Producers wave: the approval LANDS the review — any annotation
        // still unresolved files as a durable work item instead of dropping
        // (it would otherwise never reach the agent: the approve payload
        // carries no annotations).
        let filed = review::file_unresolved_annotations(&review_state.db, &review_id);
        if filed > 0 {
            tracing::info!(
                review_id = %review_id, filed,
                "review landing filed unresolved annotations as work items"
            );
        }
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
    // Orchestrated run: a feedback round hands the work back to the
    // orchestrator — cycle the chip to `running`. An approval is the human
    // sign-off that ends the run's review — the chip walks to `landed` so no
    // "in code review" indication lingers once the reviewer has accepted.
    {
        // The full chain, not just the map: a review held across a restart
        // has an empty map and would otherwise silently strand its run chip.
        let plan_sid = orchestration_review_link(&review_state.db, &review_id);
        if let Some(plan_sid) = plan_sid {
            advance_run_state(&app, &store, &plan_sid, review_verdict_run_state(approve));
        }
    }
    tx.send(payload).map_err(|_| {
        // The curl died between `pending.take` and this send: the reviewer's
        // whole round — every annotation, the verdict, the run-state walk
        // above — went nowhere, and they find out from an error toast. The
        // run chip has already moved, which is why this is worth counting:
        // it is the shape of a review that "succeeded" and delivered nothing.
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

// --- orchestration exit report (`POST /v1/orchestration/report`) -------------

/// The orchestrator's exit report — its *claims*. Stored verbatim in
/// `plan_runs`; the report GUI pairs the claims against ground truth Redline
/// observed independently (diff stats, review rounds, elapsed since launch).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrchestrationReportBody {
    plan_session_id: String,
    #[serde(default)]
    script_path: Option<String>,
    #[serde(default)]
    workflow_ran: bool,
    /// Read by the GUI from the verbatim-stored body; deserialized here only
    /// so the documented shape lives in code.
    #[allow(dead_code)]
    #[serde(default)]
    summary: String,
    /// `[{title, planSection, verified, skipped, notes}]` — kept as raw JSON
    /// (the whole body is stored verbatim; the GUI is the schema's consumer).
    #[serde(default)]
    subtasks: Vec<serde_json::Value>,
}

/// Pure parse seam for the report route (unit-tested without axum).
fn parse_orchestration_report(v: &serde_json::Value) -> Result<OrchestrationReportBody, String> {
    let body: OrchestrationReportBody =
        serde_json::from_value(v.clone()).map_err(|e| format!("bad report body: {e}"))?;
    if body.plan_session_id.trim().is_empty() {
        return Err("planSessionId is required".to_string());
    }
    Ok(body)
}

/// Producers wave: subtasks the exit report says were NOT delivered
/// (`verified == false` or `skipped == true`) survive as open work items,
/// `origin_kind="plan_run"` / `origin_id=<plan session id>` (provenance,
/// never ownership), title from the subtask title, body from its notes. The
/// parse stays tolerant — a subtask missing its title or both flags is
/// skipped, never a failed ingestion — and a re-POSTed report is idempotent
/// (the filing helper dedupes on the provenance triple). The orchestrator
/// seat produced these, so its `items_filed` moves by the count filed.
fn file_exit_report_items(
    db: &db::Database,
    plan_sid: &str,
    subtasks: &[serde_json::Value],
    project_path: Option<&str>,
) -> usize {
    /// Ledger actor + edge author for exit-report filings.
    const REPORT_ACTOR: &str = "orchestrator-report";
    let mut filed = 0usize;
    for v in subtasks {
        let Some(title) = v
            .get("title")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|t| !t.is_empty())
        else {
            continue; // tolerate: a titleless claim files nothing
        };
        let verified = v.get("verified").and_then(serde_json::Value::as_bool);
        let skipped = v.get("skipped").and_then(serde_json::Value::as_bool);
        if verified.is_none() && skipped.is_none() {
            continue; // tolerate: not enough shape to judge delivery
        }
        if verified.unwrap_or(true) && !skipped.unwrap_or(false) {
            continue; // delivered — nothing survives
        }
        let notes = v
            .get("notes")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|n| !n.is_empty());
        let section = v
            .get("planSection")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let mut body = if skipped == Some(true) {
            "Skipped by the orchestrated run.".to_string()
        } else {
            "Ran but was NOT verified by the orchestrated run.".to_string()
        };
        if let Some(sec) = section {
            body.push_str(&format!(" Plan section: {sec}."));
        }
        if let Some(n) = notes {
            body.push_str(&format!("\n\n{n}"));
        }
        match db.file_produced_work_item(
            title,
            Some(&body),
            "task",
            "open",
            2,
            "plan_run",
            Some(plan_sid),
            project_path,
            None,
            REPORT_ACTOR,
        ) {
            Ok(Some(_)) => filed += 1,
            Ok(None) => {} // a re-POSTed report — already standing
            Err(e) => tracing::warn!(
                plan_session_id = %plan_sid, error = %e,
                "failed to file an exit-report work item"
            ),
        }
    }
    if filed > 0 {
        // items_filed becomes real for the orchestrator seat.
        if let Err(e) = db.upsert_seat_stat("orchestrator", None, filed as i64) {
            tracing::warn!(error = %e, "failed to bump orchestrator items_filed");
        }
    }
    filed
}

/// `POST /v1/orchestration/report` — the orchestrator session files its
/// structured exit report when the workflow ends, BEFORE opening the human
/// review (the skill's contract; the RunReport GUI opens on this event).
/// Token-protected: the orchestrator's PTY inherits `REDLINE_DAEMON_TOKEN`.
async fn handle_orchestration_report(
    State(app_state): State<AppState>,
    Json(v): Json<serde_json::Value>,
) -> axum::response::Response {
    let body = match parse_orchestration_report(&v) {
        Ok(b) => b,
        Err(e) => return (StatusCode::BAD_REQUEST, e).into_response(),
    };
    let plan_sid = body.plan_session_id.trim().to_string();
    if !app_state.store.has_session(&plan_sid) {
        return (
            StatusCode::NOT_FOUND,
            format!("no plan session {plan_sid}"),
        )
            .into_response();
    }
    let db = app_state.store.database();
    if let Err(e) = db.upsert_plan_run(
        &plan_sid,
        &v.to_string(),
        body.script_path.as_deref(),
        body.workflow_ran,
    ) {
        return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response();
    }
    // Producers wave: undelivered subtasks survive the report as open items
    // instead of living only inside the verbatim-stored claim blob.
    let project_path = app_state.store.get(&plan_sid).map(|s| s.project_path);
    let filed = file_exit_report_items(&db, &plan_sid, &body.subtasks, project_path.as_deref());
    if filed > 0 {
        tracing::info!(
            plan_session_id = %plan_sid, filed,
            "exit report filed undelivered subtasks as work items"
        );
    }
    let _ = db.append_journal(
        "orchestration_report",
        Some("session"),
        Some(&plan_sid),
        Some(if body.workflow_ran {
            "workflow"
        } else {
            "sequential"
        }),
        Some(&format!("{} subtask(s)", body.subtasks.len())),
    );
    tracing::info!(
        plan_session_id = %plan_sid,
        workflow_ran = body.workflow_ran,
        subtasks = body.subtasks.len(),
        "orchestration exit report filed"
    );
    // Tell the UI a report landed (App opens the RunReport container). The
    // run-state chip itself moves on the review-start beacon, not here.
    let _ = app_state.app_handle.emit(
        "orchestration-report",
        SessionEvent {
            session_id: plan_sid,
        },
    );
    (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response()
}

/// The stored run record for a plan session — RunReport's data source.
#[tauri::command]
fn get_plan_run(
    store: tauri::State<'_, SessionStore>,
    plan_session_id: String,
) -> Option<db::PlanRunRow> {
    store.database().get_plan_run(&plan_session_id)
}

/// The human verdict that closes an orchestrated run. `resolved` is the only
/// mark that advances the chip (→ `landed`); `needs_follow_up` / `abandoned`
/// are recorded and the chip stays visibly unresolved. Never inferred from
/// dismissing the review — this is a deliberate act.
#[tauri::command]
fn resolve_plan_run(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    plan_session_id: String,
    resolution: String,
    note: Option<String>,
) -> Result<bool, String> {
    let allowed = ["resolved", "needs_follow_up", "abandoned"];
    if !allowed.contains(&resolution.as_str()) {
        return Err(format!("unknown resolution `{resolution}`"));
    }
    let db = store.database();
    let ok = db
        .resolve_plan_run(&plan_session_id, &resolution, note.as_deref())
        .map_err(|e| e.to_string())?;
    if ok {
        let _ = db.append_journal(
            "run_resolution",
            Some("session"),
            Some(&plan_session_id),
            Some(&resolution),
            note.as_deref(),
        );
        if resolution == "resolved" {
            advance_run_state(&app, &store, &plan_session_id, "landed");
        }
        let _ = app.emit(
            "run-state-changed",
            SessionEvent {
                session_id: plan_session_id.clone(),
            },
        );
    }
    Ok(ok)
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

// --- ClassMemory routes (Phase 2) ------------------------------------------

/// A tree node as returned to a retrieval agent / the pane: the node plus its
/// total link count (leaf-count badge).
// The tree/link view rows are `polis-core` API types (Session A1 of the Polis
// extraction) — the same shape the MCP tools and the generated clients read.
use polis_core::api::{LinkView, TreeNodeView};

#[derive(Deserialize)]
struct MemoryTreeQ {
    project: Option<String>,
    root: Option<String>,
}

/// `GET /v1/memory/tree?project=&root=` — the accepted (and proposed) class tree,
/// flat with link counts (the caller/FE builds the hierarchy). Scoped to a single
/// root subtree when `root=<id>` or `project=<path>` is given. Read-only.
async fn handle_memory_tree(
    State(app_state): State<AppState>,
    Query(q): Query<MemoryTreeQ>,
) -> axum::response::Response {
    let db = app_state.store.database();
    let all = match db.list_class_nodes_with_counts() {
        Ok(v) => v,
        Err(e) => return browser_error_response(e.to_string()),
    };
    // Resolve an optional root filter (explicit root id, or the root bound to a
    // project path).
    let root_id: Option<String> = if let Some(r) = q.root.as_deref().filter(|s| !s.trim().is_empty()) {
        Some(r.trim().to_string())
    } else if let Some(p) = q.project.as_deref().filter(|s| !s.trim().is_empty()) {
        all.iter()
            .find(|(n, _)| n.parent_id.is_none() && n.project_path.as_deref() == Some(p.trim()))
            .map(|(n, _)| n.id.clone())
    } else {
        None
    };
    let views: Vec<TreeNodeView> = match &root_id {
        Some(rid) => {
            // Keep the root and its descendants.
            let keep = subtree_ids(&all, rid);
            all.into_iter()
                .filter(|(n, _)| keep.contains(&n.id))
                .map(|(node, link_count)| TreeNodeView { node, link_count })
                .collect()
        }
        None => all
            .into_iter()
            .map(|(node, link_count)| TreeNodeView { node, link_count })
            .collect(),
    };
    Json(serde_json::json!({ "nodes": views })).into_response()
}

/// Ids of `root` and everything beneath it.
fn subtree_ids(all: &[(crate::classmem::ClassNode, i64)], root: &str) -> std::collections::HashSet<String> {
    let mut keep = std::collections::HashSet::new();
    keep.insert(root.to_string());
    // Iterate to a fixpoint (tree is small).
    loop {
        let before = keep.len();
        for (n, _) in all {
            if let Some(p) = &n.parent_id {
                if keep.contains(p) {
                    keep.insert(n.id.clone());
                }
            }
        }
        if keep.len() == before {
            break;
        }
    }
    keep
}

/// A link with a resolved display label + supersession status.

/// Shared node-view assembly for the curl-bridge route AND the Tauri command —
/// one shape (`{node, children, links, observations}`) so the retrieval agents
/// and the pane can never drift. `Ok(None)` = no such node.
fn build_node_view(
    db: &crate::db::Database,
    id: &str,
) -> Result<Option<serde_json::Value>, String> {
    let Some(node) = db.get_class_node(id).map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    // Children straight off the parent index — never "read every node, then
    // filter"; the class table grows with the catalog.
    let children = db.list_class_children(id).map_err(|e| e.to_string())?;
    let raw_links = db.list_class_links_for_node(id).map_err(|e| e.to_string())?;
    let ledger_seq = |l: &crate::classmem::ClassLink| -> Option<i64> {
        matches!(l.target_kind.as_str(), "prompt" | "decision" | "ledger")
            .then(|| l.target_id.trim().parse().ok())
            .flatten()
    };
    let seqs: Vec<i64> = raw_links.iter().filter_map(&ledger_seq).collect();
    // Two batched reads for the whole link set — the per-link `link_preview`
    // took the connection mutex once per link, so a hundred-link node was a
    // hundred round trips through the shared lock.
    let labels = db.link_previews_for_seqs(&seqs).unwrap_or_default();
    let superseded = db.supersessions_for_seqs(&seqs).unwrap_or_default();
    let links: Vec<LinkView> = raw_links
        .into_iter()
        .map(|link| {
            let seq = ledger_seq(&link);
            LinkView {
                label: seq.and_then(|s| labels.get(&s).cloned()),
                superseded_by: seq.and_then(|s| superseded.get(&s).copied()),
                link,
            }
        })
        .collect();
    let observations = db
        .list_class_observations(id, false)
        .map_err(|e| e.to_string())?;
    Ok(Some(serde_json::json!({
        "node": node,
        "children": children,
        "links": links,
        "observations": observations,
    })))
}

/// `GET /v1/memory/node/:id` — one node, its children, its links (pointers
/// into the lake, with resolved labels + supersession status), and its
/// observations. The retrieval agent's descend step.
async fn handle_memory_node(
    State(app_state): State<AppState>,
    Path(id): Path<String>,
) -> axum::response::Response {
    let db = app_state.store.database();
    match build_node_view(&db, &id) {
        Ok(Some(view)) => Json(view).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, "no such class node").into_response(),
        Err(e) => browser_error_response(e),
    }
}

#[derive(Deserialize)]
struct AnswerPackQ {
    q: Option<String>,
    node: Option<String>,
    limit: Option<i64>,
}

/// `GET /v1/memory/answer-pack?q=&node=&limit=` — the retrieval agent's ONE
/// call. Resolves the question to a class node (explicitly via `?node=`, else
/// by best title match) and returns that node's subtree, links (labelled, with
/// `supersededBy`) and observations, together with the user's matching notes,
/// matching lake prompts and matching browsed pages.
///
/// It replaces a 5–7 turn walk, so it must never send the agent back into one:
/// the lexical arms are populated from `?q=` regardless of whether a node
/// resolved, and a stale `?node=` degrades to the best match instead of an
/// empty answer. Read-only, byte-bounded.
async fn handle_memory_answer_pack(
    State(app_state): State<AppState>,
    Query(q): Query<AnswerPackQ>,
) -> axum::response::Response {
    let db = app_state.store.database();
    let limit = context::clamp_answer_pack_limit(q.limit);
    // Assembly touches several tables under the DB lock — off the async
    // executor's thread, like every other heavy bridge read.
    let pack = tokio::task::spawn_blocking(move || {
        context::build_answer_pack(&db, q.q.as_deref(), q.node.as_deref(), limit)
    })
    .await;
    match pack {
        Ok(pack) => Json(pack).into_response(),
        Err(e) => browser_error_response(format!("answer-pack assembly failed: {e}")),
    }
}

#[derive(Deserialize)]
struct MemoryGrepQ {
    q: Option<String>,
    re: Option<String>,
    case: Option<String>,
    scope: Option<String>,
    limit: Option<i64>,
}

/// `GET /v1/memory/grep?q=&re=&case=&scope=&limit=` — literal and regex search
/// over the record, for the things tokenization cannot reach: flags
/// (`--allowedTools`), paths (`src-tauri/src/db.rs`), error strings,
/// attributes (`#[serde(rename_all)]`).
///
/// `q` is a substring answered from a trigram index and must be at least
/// `GREP_MIN_LITERAL` characters — shorter is refused by name rather than
/// silently turned into a scan. `re` is applied in Rust to what the index
/// returned, so a pathological pattern costs one pass over the candidates
/// instead of a walk of the corpus under the DB lock.
///
/// The bridge allow-list needs no change: `Bash(curl -s
/// http://127.0.0.1:7676/*)` already covers this in all three quoting variants
/// (`claude_proc::BRIDGE_INVARIANT_ARGS`).
async fn handle_memory_grep(
    State(app_state): State<AppState>,
    Query(q): Query<MemoryGrepQ>,
) -> axum::response::Response {
    let db = app_state.store.database();
    let literal = q.q.unwrap_or_default();
    let case_sensitive = matches!(q.case.as_deref(), Some("1") | Some("true"));
    let scope = db::GrepScope::parse(q.scope.as_deref());
    let limit = q.limit.unwrap_or(30);
    let re = q.re;
    let hits = tokio::task::spawn_blocking(move || {
        db.grep_memory(&literal, re.as_deref(), case_sensitive, scope, limit)
    })
    .await;
    match hits {
        Ok(Ok(hits)) => Json(serde_json::json!({ "hits": hits })).into_response(),
        // A refusal is a 400 WITH its reason in the body: the agent's next move
        // ("lengthen the needle") is only available if it can read why.
        Ok(Err(e)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
        Err(e) => browser_error_response(format!("grep failed: {e}")),
    }
}

#[derive(Deserialize)]
struct MemoryPromptsQ {
    since_seq: Option<i64>,
    limit: Option<i64>,
}

/// `GET /v1/memory/prompts?since_seq=&limit=` — the lake delta (prompts +
/// decision events) since a seq, oldest first. The classifier's delta input;
/// also a general context read. Bounded.
async fn handle_memory_prompts(
    State(app_state): State<AppState>,
    Query(q): Query<MemoryPromptsQ>,
) -> axum::response::Response {
    let db = app_state.store.database();
    let limit = q.limit.unwrap_or(200).clamp(1, classmem::MAX_DELTA_ITEMS as i64);
    let since = q.since_seq.unwrap_or(0).max(0);
    match db.list_lake_items_since(since, limit) {
        Ok(mut items) => {
            // Byte-budget the response, the way `/v1/context/prompts` does.
            // The item count was capped but the BYTES were not, and this
            // route's body column is `COALESCE(p.body, be.text, un.text)` —
            // `be.text` is a whole normalized page, so 400 browse items could
            // serialize megabytes under the DB lock. The route is live on the
            // MCP proxy, so a remote caller could ask for that at will.
            let kept = context::budgeted_item_count(items.iter().map(|i| i.body.as_deref()));
            items.truncate(kept);
            Json(serde_json::json!({ "items": items })).into_response()
        }
        Err(e) => browser_error_response(e.to_string()),
    }
}

/// `POST /v1/memory/proposals` {proposals:[…]} — stage a batch of classifier
/// proposals as reviewable rows. **Staging only** — nothing is accepted or
/// moved. Mirrors the parse the internal Organize path uses, so an external tool
/// (or the classifier itself) can stage over the curl bridge.
async fn handle_memory_proposals(
    State(app_state): State<AppState>,
    body: axum::body::Bytes,
) -> axum::response::Response {
    if body.len() > 256_000 {
        return (StatusCode::PAYLOAD_TOO_LARGE, "proposals payload too large").into_response();
    }
    let text = String::from_utf8_lossy(&body);
    let proposals = classmem::parse_proposals(&text);
    if proposals.is_empty() {
        return Json(serde_json::json!({ "ok": true, "staged": classmem::StageResult::default() }))
            .into_response();
    }
    let db = app_state.store.database();
    match classmem::stage_proposals(&db, None, &proposals) {
        Ok(staged) => {
            let _ = app_state.app_handle.emit("classmem-changed", ());
            Json(serde_json::json!({ "ok": true, "staged": staged })).into_response()
        }
        Err(e) => browser_error_response(e),
    }
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

#[derive(Deserialize)]
struct ContextPromptsQ {
    session: Option<String>,
    mission: Option<String>,
    surface: Option<String>,
    project: Option<String>,
    since_seq: Option<i64>,
    /// Free-text substring — bound as a LIKE parameter in the DB layer.
    q: Option<String>,
    limit: Option<i64>,
    thread_kind: Option<String>,
    thread_id: Option<String>,
    parent_session: Option<String>,
    /// Exact-match filter on the recorded model (`prompts.model`).
    model: Option<String>,
    /// Corpus role: `user` (default view) | `agent` | `system`.
    role: Option<String>,
    /// Opt in to Redline's own constructed prefaces, which are excluded by
    /// default. `1`/`true` to include.
    include_agent: Option<String>,
}

/// `GET /v1/context/prompts?session=&mission=&surface=&project=&since_seq=&q=&limit=&role=&include_agent=`
/// — filtered read of the captured-prompt lake. Every filter is ANDed; `q` is
/// planned through the FTS index (AND→OR→LIKE cascade). `agent` rows are
/// excluded unless asked for. Oldest-first, byte-bounded. Read-only.
async fn handle_context_prompts(
    State(app_state): State<AppState>,
    Query(q): Query<ContextPromptsQ>,
) -> axum::response::Response {
    let db = app_state.store.database();
    let filters = context::PromptFilters {
        session_id: q.session,
        mission_id: q.mission,
        surface: q.surface,
        project: q.project,
        since_seq: q.since_seq,
        substring: q.q,
        limit: context::clamp_prompt_limit(q.limit),
        thread_kind: q.thread_kind,
        thread_id: q.thread_id,
        parent_session_id: q.parent_session,
        model: q.model,
        role: q.role,
        include_agent: matches!(q.include_agent.as_deref(), Some("1") | Some("true")),
    };
    match context::list_prompts(&db, &filters) {
        Ok(items) => Json(serde_json::json!({ "items": items })).into_response(),
        Err(e) => browser_error_response(e),
    }
}

/// `GET /v1/context/sessions/:id/history` — one plan session's revision digests,
/// comment threads, and decision/curation ledger events. Read-only.
async fn handle_context_session_history(
    State(app_state): State<AppState>,
    Path(id): Path<String>,
) -> axum::response::Response {
    let db = app_state.store.database();
    match context::build_session_history(&db, &id) {
        Some(h) => Json(h).into_response(),
        None => (StatusCode::NOT_FOUND, "no such session").into_response(),
    }
}

/// `GET /v1/context/stats` — aggregate counts (per day / surface / kind /
/// class / author). Shared with the `context_stats` command: the Memory
/// surface's facet rails and activity ribbon read the same builder ("no
/// dashboard UI" was the memory-is-plumbing stance; the Memory-as-a-Second-
/// Brain plan deliberately overturned it). Read-only.
async fn handle_context_stats(State(app_state): State<AppState>) -> axum::response::Response {
    let db = app_state.store.database();
    Json(context::build_stats_cached(&db)).into_response()
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

#[derive(Deserialize)]
struct ContextThreadQ {
    limit: Option<i64>,
}

/// `GET /v1/context/threads/:kind/:id?limit=` — generic read-only fetch of any
/// surface's discussion thread (browse / linked / mission / companion / drafter
/// / a plan session's comment threads), tail-bounded, oldest-first.
async fn handle_context_thread(
    State(app_state): State<AppState>,
    Path((kind, id)): Path<(String, String)>,
    Query(q): Query<ContextThreadQ>,
) -> axum::response::Response {
    let db = app_state.store.database();
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    match db.load_thread_generic(&kind, &id, limit) {
        Ok(Some(msgs)) => {
            // Byte-bound the response like /v1/context/prompts: cap each body,
            // then drop leading turns once the budget is spent (tail wins).
            let mut msgs = msgs;
            for m in &mut msgs {
                if m.body.chars().count() > 4000 {
                    m.body = m.body.chars().take(4000).collect::<String>() + "…";
                }
            }
            let mut total = 0usize;
            let mut start = msgs.len();
            for (i, m) in msgs.iter().enumerate().rev() {
                total += 120 + m.body.len();
                if total > context::MAX_CONTEXT_BYTES {
                    break;
                }
                start = i;
            }
            let tail = &msgs[start..];
            Json(serde_json::json!({
                "kind": kind,
                "id": id,
                "label": db.thread_label(&kind, &id),
                "messages": tail,
            }))
            .into_response()
        }
        Ok(None) => (StatusCode::NOT_FOUND, "unknown thread kind").into_response(),
        Err(e) => browser_error_response(e.to_string()),
    }
}

/// `GET /v1/context/tree/:kind/:id` — one session-tree node with its parent and
/// child digests (message counts + recency), the traversable spine of
/// memory-by-session. Read-only.
async fn handle_context_tree(
    State(app_state): State<AppState>,
    Path((kind, id)): Path<(String, String)>,
) -> axum::response::Response {
    let db = app_state.store.database();
    Json(context::build_thread_tree(&db, &kind, &id)).into_response()
}

#[derive(Deserialize)]
struct BrowseSearchQ {
    /// Free-text query — tokenized + quoted into a safe FTS5 MATCH in the DB.
    q: Option<String>,
    limit: Option<i64>,
}

/// `GET /v1/context/browse/search?q=&limit=` — Dojo P3 lexical (BM25) search over
/// the browsing-behavior stream. High-volume, keyword-heavy browse events get
/// fuzzy full-text recall here (plans/prompts stay on the vectorless walk).
/// Read-only; returns `{items:[{id,ts,url,title,snippet,score}]}` best-first.
async fn handle_browse_search(
    State(app_state): State<AppState>,
    Query(q): Query<BrowseSearchQ>,
) -> axum::response::Response {
    let db = app_state.store.database();
    let query = q.q.unwrap_or_default();
    let limit = q.limit.unwrap_or(20).clamp(1, 100);
    match db.search_browse_events(&query, limit) {
        Ok(items) => Json(serde_json::json!({ "items": items })).into_response(),
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
    let before = app_state.active_browser.get();
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
            let is_new = before.as_deref() != Some(label.as_str());
            let shows_it = app_state
                .browser_tabs
                .get()
                .iter()
                .any(|t| t.label == label && same_tab_url(&t.url, &url));
            if (is_new || shows_it) && app_state.app_handle.get_webview(&label).is_some() {
                let id = label.strip_prefix("browser-").unwrap_or(&label).to_string();
                return Json(serde_json::json!({ "ok": true, "label": label, "id": id, "url": url }))
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
                Err(_) => {
                    return browser_error_response(format!(
                        "the server returned HTTP {code} for that url and there is no page to capture"
                    ))
                }
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
                let _ = store.database().append_journal(
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
                        &ext_events::LedgerChanged { ts_ms: extension_host::now_ms() },
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
fn browser_cached_snapshot(cache: tauri::State<'_, SnapshotCache>, label: String) -> Option<String> {
    cache.get(&label).map(|s| s.json)
}

/// Whether a background tab may be suspended (its webview destroyed to reclaim
/// memory). False if the tab is the active one, has a browse turn streaming, or
/// is playing media — so we never cut off what the user is watching or an
/// in-flight agent reply. The frontend calls this before evicting an LRU tab.
#[tauri::command(async)]
async fn browser_can_suspend(app: AppHandle, label: String) -> Result<bool, String> {
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
    // A tab actively playing audio/video stays live.
    if app.get_webview(&label).is_some() {
        let probe = "(function(){try{return [].slice.call(document.querySelectorAll('video,audio')).some(function(m){return !m.paused && !m.ended && m.currentTime>0;})?\"1\":\"0\";}catch(e){return \"0\";}})()";
        if let Ok(r) = daemon_eval(&app, &label, probe).await {
            if r == "1" {
                return Ok(false);
            }
        }
    }
    Ok(true)
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
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.eval(STOP_MEDIA_JS);
        wv.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Mount-time check: did the daemon bind its port? `false` → another process
/// holds 7676 and this window cannot capture plans. A bind still in flight
/// answers `true`; `daemon_state` is the three-state answer.
#[tauri::command]
fn get_daemon_status(daemon_status: tauri::State<'_, DaemonStatus>) -> bool {
    daemon_status.is_bound()
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

/// `(async)` — reads two user-config trees off disk. Nothing here spawns a
/// child process, which is the whole point of the split.
#[tauri::command(async)]
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
    Ok(combine::compose(&rows, instruction.as_deref().unwrap_or("")))
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
async fn save_revision_to_obsidian(
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
    let reason = feedback_deny_reason(
        mode,
        &session_id,
        &store.backend_of(&session_id),
        &payload,
    );
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
fn approve_plan(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    pending: tauri::State<'_, PendingResponses>,
    expected_modes: tauri::State<'_, ExpectedModes>,
    session_id: String,
) -> Result<(), String> {
    let Some(tx) = pending.take(&session_id) else {
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

/// The deny reason `orchestrate_plan` sends into the held ExitPlanMode. One
/// calm ✅ line in the `feedback_deny_reason` register — Claude Code renders
/// deny reasons in a red Error box, so it leads with a defusing sentence —
/// that stands the original session down: the plan is approved, but a
/// *separate* orchestrated session executes it.
const ORCHESTRATE_STAND_DOWN: &str = "✅ Plan approved in Redline — the reviewer is \
     executing it in a separate orchestrated session. Do NOT implement this plan, do \
     not revise it, and do not call ExitPlanMode again. Acknowledge briefly and end \
     your turn; this session's work is done.";

/// Approve-and-stand-down: the Orchestrate path. Body mirrors `approve_plan`
/// (pending.take → Approved → send → Idle → events) with two differences: the
/// held ExitPlanMode gets a **deny** carrying the stand-down text, and the
/// launch lands in the context journal. The original session was launched
/// `--permission-mode plan`, so the deny keeps it read-only — even a
/// disobedient model cannot collide with the orchestrator, where an allow
/// would exit plan mode and guarantee a collision. `pending_feedback` /
/// `expected_modes` stay unset and the revise watchdog is not armed (only
/// `submit_review` arms it; a stale one self-stops once status ≠ InReview).
/// The state-machine core of `orchestrate_plan`, split from the
/// AppHandle-dependent side effects (journal, events, tray, detach marking)
/// so the approve/deny mechanics are unit-testable — same seam as
/// `delete_session_inner`.
fn orchestrate_plan_inner(
    store: &SessionStore,
    pending: &PendingResponses,
    expected_modes: &ExpectedModes,
    session_id: &str,
) -> Result<(), String> {
    let Some(tx) = pending.take(session_id) else {
        return Err("no plan is currently waiting for review on this session".to_string());
    };
    let _ = expected_modes.take(session_id);
    store.set_status(session_id, SessionStatus::Approved);
    // Ignore send failure like `approve_plan` does: a dead receiver means the
    // original session already went away — no collision is possible, and the
    // orchestration is still valid.
    let _ = tx.send(deny_response(ORCHESTRATE_STAND_DOWN));
    store.set_attach_state(session_id, AttachState::Idle);
    Ok(())
}

#[tauri::command]
fn orchestrate_plan(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    pending: tauri::State<'_, PendingResponses>,
    expected_modes: tauri::State<'_, ExpectedModes>,
    session_id: String,
) -> Result<(), String> {
    if let Err(e) = orchestrate_plan_inner(&store, &pending, &expected_modes, &session_id) {
        // Same drop-guard/sweep gap as `approve_plan`: surface the detached
        // banner + Restore instead of leaving Orchestrate a silent no-op.
        mark_session_detached(&app, &store, &session_id);
        return Err(e);
    }
    tracing::info!(session_id = %session_id, "orchestrate_plan fired");
    let _ = store.database().append_journal(
        "orchestrate_launch",
        Some("session"),
        Some(&session_id),
        None,
        None,
    );
    // Run lifecycle: the click is the first beacon; the stall watchdog fires
    // `stalled` if no further beacon (ingest claim → `running`) ever arrives.
    advance_run_state(&app, &store, &session_id, "orchestrating");
    arm_orchestrate_stall_watchdog(app.clone(), (*store).clone(), session_id.clone());
    let _ = app.emit(
        "session-status-changed",
        SessionEvent {
            session_id: session_id.clone(),
        },
    );
    refresh_tray(&app, &store);
    Ok(())
}

/// Record an Orchestrate launch at click time, before the orchestrator's
/// prompt is typed into its PTY. The orchestrator session doesn't exist yet
/// (claude hasn't spawned), so this only arms the two ledger guards: the
/// agent guard (the typed prompt is launch boilerplate, not a lake prompt —
/// the hook fire claims-and-skips it) and the orchestration guard (that same
/// hook fire is the first moment the new claude session id is known, and
/// links it under the plan session it executes).
#[tauri::command]
fn record_orchestration_launch(
    launched: tauri::State<'_, LaunchedTerminals>,
    prompt: String,
    plan_session_id: String,
    terminal_id: Option<String>,
) -> Result<(), String> {
    let body = prompt.trim().to_string();
    if body.is_empty() || plan_session_id.trim().is_empty() {
        return Err("orchestrate launch needs a prompt and a plan session id".to_string());
    }
    let bh = ledger::body_hash(&body);
    ledger::register_agent_prompt(&body);
    // A retry re-arms both guards deliberately: `register_*` is a plain
    // insert, so re-registering after a claim or a `GUARD_TTL` expiry
    // genuinely re-arms — a reviewer who takes >5 min on the workflow card
    // must still get their `orchestrations` row.
    ledger::register_orchestration_prompt(&bh, plan_session_id.trim());
    if let Some(tid) = terminal_id.as_deref().filter(|t| !t.trim().is_empty()) {
        launched.set(plan_session_id.trim(), tid);
    }
    Ok(())
}

/// The Orchestrate launch modal's workflows-disabled probe (hook.rs owns the
/// settings reads). Takes the project so the run's OWN `.claude/settings*`
/// are read, not just the user-level file — the probe is about the run, and
/// a project-scoped `disableWorkflows` is exactly as binding.
#[tauri::command]
fn workflow_availability(project_path: Option<String>) -> hook::WorkflowAvailability {
    let dir = project_path
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(std::path::PathBuf::from);
    hook::workflow_availability(dir.as_deref())
}

/// Write the launch modal's checked Bash allow rules before the orchestrator
/// spawns (workflow subagents inherit the allowlist; unallowlisted Bash
/// queues permission prompts mid-fan-out).
#[tauri::command]
fn apply_orchestrate_allows(rules: Vec<String>) -> Result<(), String> {
    hook::apply_orchestrate_allows(&rules)
}

/// Terminal tabs orchestrated runs were launched into, keyed by plan session
/// id. In-memory (a tab id is meaningless across restarts); folded into the
/// `orchestrations` row when the ingest claim writes it, so a run's tab
/// survives even though the row doesn't exist until the claim. Written at
/// launch precisely so a FAILED handoff still leaves a trace of its tab.
#[derive(Clone, Default)]
struct LaunchedTerminals(Arc<StdMutex<HashMap<String, String>>>);

impl LaunchedTerminals {
    fn set(&self, plan_sid: &str, terminal_id: &str) {
        self.0
            .lock()
            .unwrap()
            .insert(plan_sid.to_string(), terminal_id.to_string());
    }
    fn get(&self, plan_sid: &str) -> Option<String> {
        self.0.lock().unwrap().get(plan_sid).cloned()
    }
    fn clear(&self, plan_sid: &str) {
        self.0.lock().unwrap().remove(plan_sid);
    }
}

/// The durable half of `reset_run` — both run rows, the run columns, and the
/// stale review link — everything that needs no AppHandle, so the idempotency
/// contract is unit-testable. Safe on a session that never ran.
fn reset_run_rows(store: &SessionStore, session_id: &str) {
    let db = store.database();
    let _ = db.delete_orchestration(session_id);
    let _ = db.delete_plan_run(session_id);
    store.clear_run_state(session_id);
    // The process-global review→plan link map has no other eviction; a stale
    // entry would walk the NEXT run's chip from a dead review.
    orchestration_review_links()
        .lock()
        .unwrap()
        .retain(|_, sid| sid != session_id);
}

/// Everything `reset_run` undoes, in one idempotent sweep: the watcher, both
/// run rows, the run columns, the stale review link, and the launch-tab
/// stash. Safe on a session with no run at all. Emits `run-state-changed`
/// unconditionally so the Runs surface drops any stale tiles.
fn reset_run_inner(app: &AppHandle, store: &SessionStore, session_id: &str) {
    runwatch::stop(app, session_id);
    reset_run_rows(store, session_id);
    if let Some(launched) = app.try_state::<LaunchedTerminals>() {
        launched.clear(session_id);
    }
    let _ = app.emit(
        "run-state-changed",
        SessionEvent {
            session_id: session_id.to_string(),
        },
    );
}

/// B1: clear a run without touching the approval — the rollback for a handoff
/// that never delivered, and the first half of "run it again".
#[tauri::command]
fn reset_run(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    session_id: String,
) -> Result<(), String> {
    reset_run_inner(&app, &store, &session_id);
    let _ = store.database().append_journal(
        "run_reset",
        Some("session"),
        Some(&session_id),
        None,
        None,
    );
    tracing::info!(session_id = %session_id, "run reset");
    Ok(())
}

/// B2 (backend half): re-enter the run lifecycle for an already-approved
/// plan. Deliberately NOT `orchestrate_plan_inner` — that requires a held
/// `oneshot::Sender` which no longer exists after the original approval,
/// which is exactly why re-running was impossible. The frontend follows this
/// with the same record-launch → seats → verified-handoff sequence as a
/// first launch.
#[tauri::command]
fn relaunch_run(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    session_id: String,
) -> Result<(), String> {
    let session = store
        .get(&session_id)
        .ok_or_else(|| "no such session".to_string())?;
    if session.status != SessionStatus::Approved {
        return Err("only an approved plan can be re-launched".to_string());
    }
    reset_run_inner(&app, &store, &session_id);
    let _ = store.database().append_journal(
        "orchestrate_relaunch",
        Some("session"),
        Some(&session_id),
        None,
        None,
    );
    advance_run_state(&app, &store, &session_id, "orchestrating");
    arm_orchestrate_stall_watchdog(app.clone(), (*store).clone(), session_id.clone());
    Ok(())
}

/// B3: back to review — for "the plan itself was wrong", not "delivery
/// failed". The approval is reversed by ledger supersession (never a
/// delete — the hash chain stays intact); the session lands Detached, which
/// lights the existing banner + Restore button, the only real path back to a
/// live claude session.
/// The state-machine core of `unapprove_plan`, split from the
/// AppHandle-dependent side effects (watcher stop, events, tray) so the
/// approval reversal is unit-testable — the `orchestrate_plan_inner` seam.
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
    reset_run_inner(&app, &store, &session_id);
    let _ = app.emit(
        "session-status-changed",
        SessionEvent {
            session_id: session_id.clone(),
        },
    );
    refresh_tray(&app, &store);
    Ok(())
}

/// B4: abort a live run. Terminal chip value `abandoned`; the watcher exits
/// (excluded from `is_live_run_state`) and boot rehydration skips it. Does
/// NOT kill the orchestrator process — returns the launch tab id (when known)
/// so the caller can name the tab to close instead.
#[tauri::command]
fn stand_down_run(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    session_id: String,
) -> Result<Option<String>, String> {
    runwatch::stop(&app, &session_id);
    advance_run_state(&app, &store, &session_id, "abandoned");
    let db = store.database();
    // Keep the RunReport bar in agreement with the chip when a report exists.
    let _ = db.resolve_plan_run(
        &session_id,
        "abandoned",
        Some("stood down from the run monitor"),
    );
    let _ = db.append_journal(
        "run_stand_down",
        Some("session"),
        Some(&session_id),
        None,
        None,
    );
    let terminal = app
        .try_state::<LaunchedTerminals>()
        .and_then(|l| l.get(&session_id))
        .or_else(|| db.get_orchestration(&session_id).and_then(|r| r.terminal_id));
    Ok(terminal)
}

/// A4: the handoff's delivery probe — polled by the frontend after typing the
/// orchestrator prompt; *leaving* `orchestrating` is the proof the ingest
/// claim fired (the only evidence a run actually started).
#[tauri::command]
fn get_run_state(store: tauri::State<'_, SessionStore>, session_id: String) -> Option<String> {
    store.database().get_run_state(&session_id)
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

/// The launch modal's inferred allow-rule candidates for a project (repo
/// markers → build/test Bash rules).
#[tauri::command]
fn orchestrate_allow_candidates(project_path: String) -> Vec<hook::AllowCandidate> {
    hook::orchestrate_allow_candidates(std::path::Path::new(&project_path))
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
}

/// `key` → `app_settings` row; the allowlist keeps this command from becoming
/// a generic KV write surface.
fn ui_pref_setting_key(key: &str) -> Option<&'static str> {
    match key {
        "theme" => Some("redline.ui.theme"),
        "font" => Some("redline.ui.font"),
        "lint" => Some("redline.ui.lint"),
        "workspaceNudge" => Some("redline.ui.workspaceNudge"),
        "seatAssignPrefs" => Some("redline.ui.seatAssignPrefs"),
        _ => None,
    }
}

#[tauri::command]
fn get_ui_prefs(settings: tauri::State<'_, Settings>) -> UiPrefs {
    UiPrefs {
        theme: settings.db.get_setting("redline.ui.theme"),
        font: settings.db.get_setting("redline.ui.font"),
        lint: settings.db.get_setting("redline.ui.lint"),
        workspace_nudge: settings.db.get_setting("redline.ui.workspaceNudge"),
        seat_assign_prefs: settings.db.get_setting("redline.ui.seatAssignPrefs"),
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
}

fn agent_seats_view(db: &db::Database) -> AgentSeatsView {
    AgentSeatsView {
        seats: seat::all_seats(),
        known_seats: seat::KNOWN_SEATS.iter().map(|s| s.to_string()).collect(),
        claude_bin: seat::claude_bin_override(),
        codex_bin: seat::codex_bin_override(),
        can_revert: seat::has_snapshot(db),
        blurbs: seatassign::seat_blurbs(),
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
async fn codex_model_catalog() -> Result<Vec<codex_app_server::CodexModel>, String> {
    codex_app_server::model_catalog().await
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
fn revert_seat_assignment(
    settings: tauri::State<'_, Settings>,
) -> Result<AgentSeatsView, String> {
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
    store.database().record_share(&share).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_share(
    store: tauri::State<'_, SessionStore>,
    request_id: String,
) -> Result<(), String> {
    store.database().delete_share(&request_id).map_err(|e| e.to_string())
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

/// Replace the owner secret (e.g. key rotation after a suspected leak).
/// Outstanding shared snapshots stop verifying their returns.
#[tauri::command]
fn set_owner_secret(
    settings: tauri::State<'_, Settings>,
    secret: String,
) -> Result<(), String> {
    if secret.trim().is_empty() {
        return Err("owner secret cannot be empty".into());
    }
    settings
        .db
        .set_setting(SETTING_COLLAB_OWNER_SECRET, secret.trim())
        .map_err(|e| e.to_string())
}

/// Per-session Review Request registry, stored as an opaque JSON blob the
/// frontend owns (`src/collab/reviewRequest.ts` defines the shape). Keyed
/// per session so requests survive restarts and background sessions.
#[tauri::command]
fn get_collab_requests(
    settings: tauri::State<'_, Settings>,
    session_id: String,
) -> String {
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
fn get_collab_share(
    settings: tauri::State<'_, Settings>,
    session_id: String,
) -> Option<String> {
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
fn is_plain_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

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
fn find_transcript(session_id: &str) -> Option<std::path::PathBuf> {
    if !is_plain_session_id(session_id) {
        return None;
    }
    let base = std::path::PathBuf::from(fsbrowse::home_dir()?)
        .join(".claude")
        .join("projects");
    let file = format!("{session_id}.jsonl");
    for entry in std::fs::read_dir(base).ok()?.flatten() {
        let candidate = entry.path().join(&file);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

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
    if backend.as_deref() == Some("codex") {
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

/// Reveal the main window. The window starts hidden and is shown once the
/// frontend has rendered its first themed frame, so launch never flashes white.
#[tauri::command]
fn show_main_window(app: AppHandle) {
    boot_trace::mark(boot_trace::WINDOW_REVEAL);
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
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
    let parsed = url
        .parse()
        .map_err(|_| format!("invalid url: {url}"))?;
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
#[tauri::command]
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
#[tauri::command]
fn browser_enable_autoresize(app: AppHandle, label: String) -> Result<(), String> {
    let wv = app
        .get_webview(&label)
        .ok_or_else(|| format!("browser webview '{label}' not found"))?;
    #[cfg(target_os = "macos")]
    {
        wv.with_webview(|pw| {
            let ptr = pw.inner() as *mut objc2::runtime::AnyObject;
            // SAFETY: runs on the UI thread; `inner()` is the live WKWebView (an
            // NSView). `setAutoresizingMask:` takes a single NSUInteger.
            unsafe {
                if let Some(obj) = ptr.as_ref() {
                    let _: () = objc2::msg_send![obj, setAutoresizingMask: 22usize];
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

/// Document-start user script that fakes the HTML5 Fullscreen API so a player's
/// "fullscreen" stays inside the page/viewport rather than being ignored (WebKit
/// element-fullscreen is disabled for these child webviews; enabling it would
/// escape to a separate whole-display Space we can't constrain to the host
/// window). Two layers run in EVERY frame (`forMainFrameOnly:false`):
///
/// 1. Base layer — overrides `requestFullscreen`/`webkit*` on `Element.prototype`
///    and `exitFullscreen`/`webkit*` on `document` to pin the target element to
///    the viewport (a fixed, full-bleed CSS class) and dispatch the change
///    events, plus `fullscreenElement`/`fullscreenEnabled` getters and a
///    capture-phase Escape handler. Only the TOP frame sets `window.__redline_fs`
///    — the flag the native side polls to expand the pane.
/// 2. Cross-frame handshake — for cross-origin iframe embeds, the child pins its
///    own player and `postMessage`s `{__rl_fs:'enter'}` to its parent; each
///    parent matches the sender against its `<iframe>` `contentWindow`s, pins
///    THAT iframe element, and re-posts up until the top frame sets the flag.
///    Exit reverses and bubbles the same way. Cross-origin-legal: only
///    `postMessage`, `event.source`/`contentWindow` identity, and styling the
///    parent-owned iframe element — never touching a cross-origin document.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn fullscreen_shim_js() -> &'static str {
    r#"(function(){
  if (window.__redline_fs_installed) return;
  window.__redline_fs_installed = true;
  var STYLE_ID='__redline_fs__', PIN='__redline_fs_pin__', IPIN='__redline_fs_iframe__';
  var tracked=null;          // element this frame pinned via requestFullscreen
  var pinnedIframes=[];       // iframe elements this frame pinned for a child
  function isTop(){ return window===window.top; }
  function ensureStyle(){
    if (document.getElementById(STYLE_ID)) return;
    var s=document.createElement('style'); s.id=STYLE_ID;
    s.textContent='.'+PIN+',.'+IPIN+'{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;z-index:2147483647!important;margin:0!important;background:#000!important;}'+'.'+IPIN+'{border:0!important;}';
    (document.head||document.documentElement).appendChild(s);
  }
  function setFlag(v){ if (isTop()){ try{ window.__redline_fs=!!v; }catch(e){} } }
  function fire(){
    try{ document.dispatchEvent(new Event('fullscreenchange')); }catch(e){}
    try{ document.dispatchEvent(new Event('webkitfullscreenchange')); }catch(e){}
  }
  function enterEl(el){
    el=el||document.documentElement; ensureStyle(); tracked=el;
    try{ el.classList.add(PIN); }catch(e){}
    if (isTop()) setFlag(true);
    else { try{ window.parent.postMessage({__rl_fs:'enter'},'*'); }catch(e){} }
    fire();
  }
  function exitEl(){
    if (tracked){ try{ tracked.classList.remove(PIN); }catch(e){} tracked=null; }
    if (isTop()) setFlag(false);
    else { try{ window.parent.postMessage({__rl_fs:'exit'},'*'); }catch(e){} }
    fire();
  }
  function exitAll(){
    if (tracked) exitEl();
    if (pinnedIframes.length){
      pinnedIframes.forEach(function(f){ try{ f.classList.remove(IPIN); }catch(e){} });
      pinnedIframes=[];
      if (isTop()) setFlag(false);
      else { try{ window.parent.postMessage({__rl_fs:'exit'},'*'); }catch(e){} }
      fire();
    }
  }
  try{ Element.prototype.requestFullscreen=function(){ enterEl(this); return Promise.resolve(); }; }catch(e){}
  try{ Element.prototype.webkitRequestFullscreen=function(){ enterEl(this); }; }catch(e){}
  try{ Element.prototype.webkitRequestFullScreen=function(){ enterEl(this); }; }catch(e){}
  try{ document.exitFullscreen=function(){ exitEl(); return Promise.resolve(); }; }catch(e){}
  try{ document.webkitExitFullscreen=function(){ exitEl(); }; }catch(e){}
  function defGet(obj,name,fn){ try{ Object.defineProperty(obj,name,{configurable:true,get:fn}); }catch(e){} }
  defGet(document,'fullscreenElement',function(){ return tracked; });
  defGet(document,'webkitFullscreenElement',function(){ return tracked; });
  defGet(document,'fullscreenEnabled',function(){ return true; });
  defGet(document,'webkitFullscreenEnabled',function(){ return true; });
  window.addEventListener('keydown',function(e){
    if (e.key==='Escape'||e.keyCode===27){ if (tracked||pinnedIframes.length) exitAll(); }
  },true);
  window.addEventListener('message',function(e){
    var d=e&&e.data; if (!d||(d.__rl_fs!=='enter'&&d.__rl_fs!=='exit')) return;
    var frames=document.querySelectorAll('iframe'), match=null;
    for (var i=0;i<frames.length;i++){
      try{ if (frames[i].contentWindow===e.source){ match=frames[i]; break; } }catch(err){}
    }
    if (!match) return;
    if (d.__rl_fs==='enter'){
      ensureStyle();
      try{ match.classList.add(IPIN); }catch(err){}
      if (pinnedIframes.indexOf(match)===-1) pinnedIframes.push(match);
      if (isTop()) setFlag(true);
      else { try{ window.parent.postMessage({__rl_fs:'enter'},'*'); }catch(err){} }
    } else {
      try{ match.classList.remove(IPIN); }catch(err){}
      var idx=pinnedIframes.indexOf(match); if (idx!==-1) pinnedIframes.splice(idx,1);
      if (isTop()) setFlag(false);
      else { try{ window.parent.postMessage({__rl_fs:'exit'},'*'); }catch(err){} }
    }
    fire();
  },false);
})();"#
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
               ['research','Research'],['copy','Copy'],['list','＋ List']];
  var seq=0, host=null, bar=null, noteRow=null, noteInput=null;
  var pending=null, timer=0, suppressUntil=0, composing=false;

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
    go.textContent='Add';
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
  function openNote(){
    if (!pending) return;
    composing=true;
    var excerpt=pending.text.length>24 ? pending.text.slice(0,24)+'…' : pending.text;
    noteInput.placeholder='What about “'+excerpt+'”?';
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
    emit('list', note);
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
    if (action==='list'){ openNote(); return; }
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

/// Install Redline's always-on browser user scripts (the in-window fullscreen
/// shim, the new-tab interceptor, and — when the toggle is on — the
/// highlight-to-chat selection bar) on a freshly created tab, with no view
/// filter. Invoked at tab creation AND on every wake from suspension, so video
/// fullscreen and the selection bar work before any "View" filter is applied;
/// `browser_set_view` later re-installs the same set alongside its CSS.
/// Also installs the new-window UI delegate here (once per webview, NOT from
/// `install_user_scripts`, which re-runs on every view-filter swap and would
/// otherwise churn the delegate and drop any open popups). macOS-only; a no-op
/// elsewhere.
#[tauri::command]
fn browser_install_shims(
    app: AppHandle,
    label: String,
    selection_actions: Option<bool>,
) -> Result<(), String> {
    let wv = app
        .get_webview(&label)
        .ok_or_else(|| format!("browser webview '{label}' not found"))?;
    #[cfg(target_os = "macos")]
    {
        install_user_scripts(&wv, "", selection_actions.unwrap_or(true))?;
        // Give this webview OAuth/SSO popup support (window.open with features →
        // a real popup window with a live opener). Best-effort: a failure here
        // must not block the tab from working.
        if let Err(e) = browser_popup::install_new_window_delegate(&wv) {
            eprintln!("browser_popup: failed to install new-window delegate: {e}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (wv, selection_actions);
    }
    Ok(())
}

/// Evaluate `script` in a browser tab and route WKWebView's
/// `evaluateJavaScript:completionHandler:` result back to the caller through a
/// completion block. The script MUST evaluate to a string (WKWebView hands the
/// result back as an NSString; a non-string return coerces to ""). This is the
/// machinery behind the generic `browser_eval_result` command. macOS-only.
#[cfg(target_os = "macos")]
async fn eval_with_result(
    app: &AppHandle,
    label: &str,
    script: &str,
) -> Result<String, String> {
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
    rx.await.map_err(|_| "page eval cancelled".to_string())?
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

/// Resolve a window to anchor a native popup menu over. The default label is
/// "main", but once the browser pane attaches its child webviews the main
/// window drops out of `webview_windows()` (it's no longer a 1:1 webview-window),
/// so `get_webview_window("main")` returns None. The underlying `Window` still
/// exists, so resolve that and fall back to any open window.
fn menu_anchor_window(app: &AppHandle) -> Option<tauri::Window> {
    app.get_window("main")
        .or_else(|| app.windows().into_values().next())
}

/// Build and pop up a native bookmarks menu over the embedded browser. HTML
/// can't overlay a native webview, so the menu must itself be native. Item
/// clicks return through `on_menu_event` as `bm-*` ids, forwarded to the
/// frontend as a `bookmark-menu-action` event. `titles` are the saved bookmark
/// names in order; the frontend acts by index.
#[tauri::command]
fn show_bookmarks_menu(
    app: AppHandle,
    titles: Vec<String>,
    current_bookmarked: bool,
    has_current: bool,
    x: f64,
    y: f64,
) -> Result<(), String> {
    let win = menu_anchor_window(&app).ok_or_else(|| "no main window".to_string())?;
    let mut mb = MenuBuilder::new(&app);
    if has_current {
        mb = if current_bookmarked {
            mb.text("bm-remove-current", "Remove this page")
        } else {
            mb.text("bm-add", "Add bookmark…")
        };
        mb = mb.separator();
    }
    if titles.is_empty() {
        let none = MenuItemBuilder::with_id("bm-none", "No bookmarks yet")
            .enabled(false)
            .build(&app)
            .map_err(|e| e.to_string())?;
        mb = mb.item(&none);
    } else {
        for (i, title) in titles.iter().enumerate() {
            let label = if title.is_empty() {
                "(untitled)"
            } else {
                title.as_str()
            };
            let sm = SubmenuBuilder::new(&app, label)
                .text(format!("bm-open-{i}"), "Open")
                .text(format!("bm-newtab-{i}"), "Open in New Tab")
                .text(format!("bm-rename-{i}"), "Rename…")
                .separator()
                .text(format!("bm-remove-{i}"), "Remove")
                .build()
                .map_err(|e| e.to_string())?;
            mb = mb.item(&sm);
        }
    }
    let menu = mb.build().map_err(|e| e.to_string())?;
    // Pop up at an explicit position (the ★ button, in window coords). Without
    // a position, muda relies on the current NSEvent — which is gone by the
    // time this async command runs on the main thread, so the menu never shows.
    win.popup_menu_at(&menu, tauri::LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

/// Pop up the native "View" filter menu over the embedded browser (HTML can't
/// overlay a native webview, same as bookmarks). `active` is the current filter
/// id ("dark", "sepia", … or "none") so the matching item shows a check. Clicks
/// return through `on_menu_event` as `view-*` ids, forwarded to the frontend as
/// a `view-menu-action` event; the pane maps them back to a filter mode.
#[tauri::command]
fn show_view_menu(app: AppHandle, active: String, x: f64, y: f64) -> Result<(), String> {
    let win = menu_anchor_window(&app).ok_or_else(|| "no main window".to_string())?;
    let filters = [
        ("view-dark", "Dark mode"),
        ("view-sepia", "Sepia"),
        ("view-gray", "Grayscale"),
        ("view-dim", "Dim"),
        ("view-contrast", "High contrast"),
    ];
    let mut mb = MenuBuilder::new(&app);
    for (id, label) in filters {
        let mode = id.strip_prefix("view-").unwrap_or(id);
        let item = CheckMenuItem::with_id(&app, id, label, true, active == mode, None::<&str>)
            .map_err(|e| e.to_string())?;
        mb = mb.item(&item);
    }
    mb = mb.separator().text("view-none", "Reset to normal");
    let menu = mb.build().map_err(|e| e.to_string())?;
    win.popup_menu_at(&menu, tauri::LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

/// Record a thumbs verdict (+1 up / -1 down) on a source the tandem agent
/// surfaced. Upserts on `(browse_id, source_url)`; the domain is derived here so
/// learning can aggregate by host. Called from the sources strip in BrowserChat.
#[tauri::command]
fn set_source_feedback(
    settings: tauri::State<'_, Settings>,
    browse_id: String,
    source_url: String,
    source_title: Option<String>,
    verdict: i64,
) -> Result<(), String> {
    let now = now_millis();
    let fb = SourceFeedback {
        id: uuid::Uuid::new_v4().to_string(),
        browse_id,
        domain: crate::db::domain_of(&source_url),
        source_url,
        source_title,
        verdict,
        created_at: now,
        updated_at: now,
    };
    settings
        .db
        .upsert_source_feedback(&fb)
        .map_err(|e| e.to_string())?;
    // Polis ledger: a source-trust verdict (thumbs up/down on a source) is a
    // curation signal.
    let ph = ledger::decision_payload_hash(&[
        ("source_feedback", &fb.id),
        ("domain", &fb.domain),
        ("verdict", &fb.verdict.to_string()),
    ]);
    if let Err(e) = ledger::record_decision(
        &settings.db,
        ledger::DecisionInput {
            kind: ledger::EventKind::SourceTrust,
            author: None,
            session_id: None,
            ref_kind: "source_feedback",
            ref_id: &fb.id,
            payload_hash: ph,
        },
    ) {
        tracing::warn!(error = %e, "failed to record source-trust ledger event");
    }
    Ok(())
}

/// Every thumbs verdict recorded on a tab's thread, so the sources strip can
/// restore its up/down state after a reload.
#[tauri::command]
fn get_source_feedback(
    settings: tauri::State<'_, Settings>,
    browse_id: String,
) -> Result<Vec<SourceFeedback>, String> {
    settings
        .db
        .get_source_feedback(&browse_id)
        .map_err(|e| e.to_string())
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
/// model filter. `(async)`: a full-table scan that grows with the lake.
#[tauri::command(async)]
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
/// whole history is reachable. `(async)`: pages join provenance per row.
#[tauri::command(async)]
fn ledger_query(
    store: tauri::State<'_, SessionStore>,
    filters: context::LedgerFilters,
) -> Result<Vec<context::TimelineItem>, String> {
    context::query_ledger(&store.database(), &filters)
}

/// Aggregate counts (per day / surface / kind / class / author) — the Memory
/// surface's facet rails + activity ribbon. Same builder as
/// `GET /v1/context/stats`, one thin caller each.
#[tauri::command(async)]
fn context_stats(store: tauri::State<'_, SessionStore>) -> Result<context::ContextStats, String> {
    Ok(context::build_stats_cached(&store.database()))
}

/// The Map tab's data: classes + sessions as nodes, the four declared edge
/// kinds (Second Brain P5, §3). Data only — the deterministic seeded layout is
/// the frontend's pure `memoryMap.ts`. No route twin: the Map is a GUI-only
/// view, agents keep reading the structured routes.
#[tauri::command(async)]
fn memory_map(store: tauri::State<'_, SessionStore>) -> Result<context::MemoryMapView, String> {
    Ok(context::build_memory_map(&store.database()))
}

/// BM25 search over captured browse pages — the Timeline's page-content
/// search. Same query/clamp discipline as `GET /v1/context/browse/search`.
#[tauri::command(async)]
fn context_search(
    store: tauri::State<'_, SessionStore>,
    q: String,
    limit: Option<i64>,
) -> Result<Vec<db::BrowseHit>, String> {
    store
        .database()
        .search_browse_events(&q, limit.unwrap_or(20).clamp(1, 100))
        .map_err(|e| e.to_string())
}

/// One session-tree node with parent + child digests — the Timeline's session
/// grouping drill-down. Same assembly as `GET /v1/context/tree/:kind/:id`.
#[tauri::command(async)]
fn context_thread_tree(
    store: tauri::State<'_, SessionStore>,
    kind: String,
    id: String,
) -> Result<serde_json::Value, String> {
    Ok(context::build_thread_tree(&store.database(), &kind, &id))
}

/// Read/write the "capture external claude sessions" toggle (default on).
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
                "front-door" | "drafter" | "browser" | "chat" | "combine"
            )
        })
        .unwrap_or_else(|| "drafter".to_string());
    // Qualify the slug with its harness: `opus` and `gpt-5.6-sol` share one
    // column, and a bare slug loses which CLI actually ran it.
    let launch_model = model
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .map(|m| match backend.as_deref().map(str::trim) {
            Some("codex") => format!("codex/{m}"),
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
        &ext_events::LedgerChanged { ts_ms: extension_host::now_ms() },
    );
    Ok(())
}

/// Persist the drafter's document. As of the Bookshelf this writes the **real
/// document** (`doc_json`, the TipTap fidelity source) as well as the markdown
/// mirror agents read via `GET /v1/drafter/:id/doc`. Called on the drafter's
/// existing 400ms persist debounce; the title is derived here (first ATX
/// heading, else first non-blank line) so the frontend sends only the content.
///
/// `(async)` because it now serializes a whole TipTap document on that debounce
/// — perf-budget rule 4 governs exactly this, and `codehealth`'s own
/// `command_hygiene` probe would flag it otherwise.
#[tauri::command(async)]
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
#[tauri::command(async)]
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
#[tauri::command(async)]
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
            Ok(_) => return (StatusCode::NOT_FOUND, "no such comment on this draft").into_response(),
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
    let result = librarian::parse_checklist(&text);
    // Producers wave: the checklist lands as durable work items (deduped
    // against the still-open backlog); the advisory strip renders unchanged.
    let filed = librarian::file_checklist_items(&db, &result);
    if filed > 0 {
        tracing::info!(filed, "librarian checklist filed as work items");
    }
    Ok(result)
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
        .unwrap_or_else(|| std::env::current_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| ".".to_string()));
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
    let mut fresh: Vec<(String, &shipwright::Finding)> = Vec::new();
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
            Ok(Some(id)) => fresh.push((id, f)),
            Err(e) => tracing::warn!(error = %e, "failed to persist a Shipwright finding"),
        }
    }
    // Producers wave: non-dismissed NEWLY-INSERTED findings file durable work
    // items — the `(category, summary)` finding dedupe (covering dismissed
    // findings too) is the idempotency backbone, so a duplicate or dismissed
    // finding never reaches the filer.
    let filed = shipwright::file_finding_items(&db, &fresh, &repo);
    if filed > 0 {
        tracing::info!(filed, "shipwright findings filed as work items");
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

/// Every finding the Shipwright has ever produced, for the review strip.
#[tauri::command(async)]
fn shipwright_findings(
    store: tauri::State<'_, SessionStore>,
    include_dismissed: bool,
) -> Result<Vec<db::ShipwrightFinding>, String> {
    store
        .database()
        .list_shipwright_findings(include_dismissed)
        .map_err(|e| e.to_string())
}

/// Record what the user did with a finding: `accepted` (it survived the trim
/// into the launched document) or `dismissed` (it never comes back under the
/// same wording). `shipped` is NOT settable here — it is detected.
#[tauri::command(async)]
fn shipwright_resolve(
    store: tauri::State<'_, SessionStore>,
    id: String,
    status: String,
    draft_id: Option<String>,
) -> Result<(), String> {
    if !matches!(status.as_str(), "accepted" | "dismissed" | "pending") {
        return Err(format!(
            "`{status}` is not a user verdict — `shipped` is detected from the \
             files a later commit touched, never self-declared"
        ));
    }
    store
        .database()
        .resolve_shipwright_finding(&id, &status, draft_id.as_deref())
        .map_err(|e| e.to_string())
}

/// Flip accepted findings to `shipped` when a later commit touched a file their
/// `files` array named. **Detection, not self-declaration** — self-declared
/// success is the one number an agent will always report favourably. Returns
/// how many flipped.
#[tauri::command(async)]
async fn shipwright_detect_shipped(
    store: tauri::State<'_, SessionStore>,
    repo_path: String,
) -> Result<usize, String> {
    let db = store.database();
    let candidates = db.shipwright_unshipped().map_err(|e| e.to_string())?;
    if candidates.is_empty() {
        return Ok(0);
    }
    // Files touched by the last 50 commits — a window wide enough to catch work
    // that landed over a few sessions, narrow enough to stay cheap.
    let repo = repo_path.clone();
    let touched: std::collections::HashSet<String> = tokio::task::spawn_blocking(move || {
        std::process::Command::new("/usr/bin/git")
            .arg("-C")
            .arg(&repo)
            .args(["--no-optional-locks", "log", "-50", "--name-only", "--format="])
            .stdin(std::process::Stdio::null())
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .map(str::trim)
                    .filter(|l| !l.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    })
    .await
    .map_err(|e| e.to_string())?;

    let mut flipped = 0;
    for (id, files_json) in candidates {
        let files: Vec<String> = serde_json::from_str(&files_json).unwrap_or_default();
        if files.iter().any(|f| touched.contains(f.as_str())) {
            db.resolve_shipwright_finding(&id, "shipped", None)
                .map_err(|e| e.to_string())?;
            flipped += 1;
        }
    }
    Ok(flipped)
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

/// Resolve the absolute path to the co-shipped `redline-mcp` binary — it sits
/// next to the main executable (dev: `target/<profile>/redline-mcp`; bundled:
/// alongside the app binary). Falls back to the bare name (PATH lookup).
fn resolve_mcp_bin() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("redline-mcp")))
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "redline-mcp".to_string())
}

/// The copyable `~/.claude.json` MCP snippet + the resolved binary path, for the
/// settings surface. External `claude` sessions install this to query Redline's
/// memory; internal agents never use MCP (they keep `--strict-mcp-config`).
#[tauri::command]
fn mcp_config_snippet() -> Result<serde_json::Value, String> {
    let bin = resolve_mcp_bin();
    Ok(serde_json::json!({
        "binPath": bin,
        "snippet": mcp::claude_config_snippet(&bin),
    }))
}

/// Export a verifiable context bundle to a file the user picks. `scope` is one
/// of `session|mission|class|full`; `id` is required for the first three. The
/// bundle re-verifies from the file alone (each event self-certifies via its
/// `entry_hash`). A session-scoped export records F6 state so the Librarian can
/// stop flagging that plan as un-exported. Returns the saved path, or `None` if
/// the save dialog was cancelled.
#[tauri::command]
async fn export_context_bundle(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    scope: String,
    id: Option<String>,
) -> Result<Option<String>, String> {
    let need_id = |id: Option<String>| id.filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("the `{scope}` scope needs an id"));
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
            &ext_events::LedgerChanged { ts_ms: extension_host::now_ms() },
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
async fn pick_mirror_dir(
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
async fn set_mirror_dir(
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
async fn mirror_rebuild(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
) -> Result<mirror::MirrorStatus, String> {
    let st = mirror::rebuild_configured(&store.database())?;
    let _ = app.emit("mirror-changed", ());
    Ok(st)
}

/// Sync any new ledger events into the mirror now (also runs on a timer).
#[tauri::command]
async fn mirror_sync(store: tauri::State<'_, SessionStore>) -> Result<mirror::MirrorStatus, String> {
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
async fn create_memory_vault(
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
        &ext_events::LedgerChanged { ts_ms: extension_host::now_ms() },
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
/// `(async)` and INCREMENTAL, both deliberately: this fires on a 60s poll and
/// on every browse capture, and it used to re-hash the entire ledger chain on
/// the WebView main thread — the exact shape `perf_guard.rs` exists to catch.
/// The full chain walk still runs, on the 6h `ledger-backup` keeper watch.
#[tauri::command(async)]
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
    let pending_proposals = db
        .count_pending_class_proposals()
        .map_err(|e| e.to_string())?;
    // Corpus composition — the number that was missing. Reported as rows AND
    // bytes per role, because the two tell different stories: 397 machine rows
    // out of 1,213 is a third of the corpus by count and 92.6% of it by weight.
    let composition = db.corpus_composition().map_err(|e| e.to_string())?;
    let corpus_roles: Vec<serde_json::Value> = composition
        .iter()
        .map(|(role, rows, bytes)| serde_json::json!({ "role": role, "rows": rows, "bytes": bytes }))
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
        "pendingProposals": pending_proposals,
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
#[tauri::command(async)]
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

/// Put a cold-compacted prompt's words back.
///
/// The other half of Phase 1.4, and the reason archiving was worth doing at
/// all: a cold compaction is a GUESS that you were finished with something, and
/// a guess you cannot undo is just a deletion with better manners. The inflated
/// bytes are re-hashed against the archive's recorded hash before they go
/// anywhere near the row — the archive is derived data outside the chain, so it
/// gets no trust it hasn't just earned.
///
/// Returns `false` when there is nothing archived: never compacted, compacted
/// before archiving existed, or forgotten on purpose (a forget deletes the
/// archive too — forget means forget).
#[tauri::command(async)]
fn memory_restore(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    prompt_id: i64,
) -> Result<bool, String> {
    let db = store.database();
    let restored = db.restore_prompt_body(prompt_id).map_err(|e| e.to_string())?;
    if restored {
        let _ = app.emit("memory-changed", ());
        let _ = app.emit("ledger-changed", ());
        extension_host::publish(
            ext_events::LEDGER_CHANGED,
            &ext_events::LedgerChanged { ts_ms: extension_host::now_ms() },
        );
    }
    Ok(restored)
}

/// Rebuild the semantic index from scratch: drop every vector for the current
/// model and let the keeper's watch re-embed. The escape hatch for a corrupt or
/// half-built index — the whole thing is DERIVED, so throwing it away costs
/// nothing but time and can never touch the record.
#[tauri::command(async)]
fn memory_reindex(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
) -> Result<serde_json::Value, String> {
    let db = store.database();
    let dropped = db.clear_embeddings().map_err(|e| e.to_string())?;
    let _ = app.emit("memory-changed", ());
    Ok(serde_json::json!({
        "dropped": dropped,
        "provider": embed::provider_kind().as_str(),
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
        &ext_events::LedgerChanged { ts_ms: extension_host::now_ms() },
    );
    Ok(seq)
}

/// Roll back a curation the gardener (or a user) accepted: remove the class link
/// and append a compensating `class_curate` event. The supervisor's override on
/// the always-on gardener — a bad auto-file is undone without ever deleting a
/// ledger event, so the hash chain stays green. Returns whether a link was
/// removed (`false` if the id was already gone).
#[tauri::command]
fn memory_revert_link(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    link_id: i64,
) -> Result<bool, String> {
    let db = store.database();
    let reverted = classmem::revert_link(&db, &ledger::local_author(), link_id)?;
    if reverted {
        let _ = app.emit("memory-changed", ());
        let _ = app.emit("ledger-changed", ());
        extension_host::publish(
            ext_events::LEDGER_CHANGED,
            &ext_events::LedgerChanged { ts_ms: extension_host::now_ms() },
        );
        let _ = app.emit("classmem-changed", ());
    }
    Ok(reverted)
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
                &ext_events::LedgerChanged { ts_ms: extension_host::now_ms() },
            );
            Ok(n)
        }
        // A no-op wrote nothing — nothing to announce.
        context::NoteOutcome::Unchanged(n) => Ok(n),
        context::NoteOutcome::Rejected(why) => Err(why),
    }
}

/// The note row annotating one target, if any — the detail rail's read (the
/// Timeline row already carries `starred`/`note`, so this serves the Catalog
/// and any non-timeline caller).
#[tauri::command]
fn memory_note_get(
    store: tauri::State<'_, SessionStore>,
    target_kind: String,
    target_id: String,
) -> Result<Option<context::UserNote>, String> {
    store
        .database()
        .get_user_note(&target_kind, &target_id)
        .map_err(|e| e.to_string())
}

/// Every note row (optionally starred-only), most recently touched first.
#[tauri::command]
fn memory_notes_list(
    store: tauri::State<'_, SessionStore>,
    starred_only: Option<bool>,
    limit: Option<i64>,
) -> Result<Vec<context::UserNote>, String> {
    store
        .database()
        .list_user_notes(starred_only.unwrap_or(false), limit.unwrap_or(500))
        .map_err(|e| e.to_string())
}

/// The class tree (flat + link counts); the FE builds the hierarchy.
#[tauri::command]
fn classmem_tree(store: tauri::State<'_, SessionStore>) -> Result<Vec<TreeNodeView>, String> {
    let db = store.database();
    let rows = db.list_class_nodes_with_counts().map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(node, link_count)| TreeNodeView { node, link_count })
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

/// A structural proposal enriched for review: the subject node's title + (for a
/// collapse) the digest's cited ledger rows.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProposalView {
    #[serde(flatten)]
    row: crate::classmem::ClassProposalRow,
    node_title: Option<String>,
    citations: Vec<CitationView>,
}

/// The pending structural proposals (promote/split/merge/collapse), enriched
/// with the digest preview + citations the pane shows for review.
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
            ProposalView { row, node_title, citations }
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

/// Whether Organize applies the classifier's work directly (default) or stages
/// it for per-item review. Default on: no required human decision-making.
#[tauri::command]
fn classmem_get_auto_apply(store: tauri::State<'_, SessionStore>) -> bool {
    store
        .database()
        .get_setting("redline.classmem.autoApply")
        .map(|v| v != "false")
        .unwrap_or(true)
}

#[tauri::command]
fn classmem_set_auto_apply(
    store: tauri::State<'_, SessionStore>,
    enabled: bool,
) -> Result<(), String> {
    store
        .database()
        .set_setting(
            "redline.classmem.autoApply",
            if enabled { "true" } else { "false" },
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn classmem_accept_node(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    id: String,
) -> Result<(), String> {
    let db = store.database();
    let flipped = db.accept_class_node(&id).map_err(|e| e.to_string())?;
    let actor = ledger::local_author();
    for nid in &flipped {
        classmem::record_curate(&db, &actor, nid, "accept", "");
    }
    let _ = app.emit("classmem-changed", ());
    let _ = app.emit("ledger-changed", ());
    extension_host::publish(
        ext_events::LEDGER_CHANGED,
        &ext_events::LedgerChanged { ts_ms: extension_host::now_ms() },
    );
    Ok(())
}

#[tauri::command]
fn classmem_reject_node(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    id: String,
) -> Result<(), String> {
    store.database().reject_class_node(&id).map_err(|e| e.to_string())?;
    let _ = app.emit("classmem-changed", ());
    Ok(())
}

#[tauri::command]
fn classmem_accept_link(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    link_id: i64,
) -> Result<(), String> {
    let db = store.database();
    if let Some((node_id, flipped)) = db.accept_class_link(link_id).map_err(|e| e.to_string())? {
        let actor = ledger::local_author();
        for nid in &flipped {
            classmem::record_curate(&db, &actor, nid, "accept", "");
        }
        classmem::record_curate(&db, &actor, &node_id, "accept_link", &link_id.to_string());
        let _ = app.emit("ledger-changed", ());
        extension_host::publish(
            ext_events::LEDGER_CHANGED,
            &ext_events::LedgerChanged { ts_ms: extension_host::now_ms() },
        );
    }
    let _ = app.emit("classmem-changed", ());
    Ok(())
}

#[tauri::command]
fn classmem_reject_link(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    link_id: i64,
) -> Result<(), String> {
    store.database().reject_class_link(link_id).map_err(|e| e.to_string())?;
    let _ = app.emit("classmem-changed", ());
    Ok(())
}

#[tauri::command]
fn classmem_accept_proposal(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    id: i64,
) -> Result<(), String> {
    let db = store.database();
    let actor = ledger::local_author();
    if let Some(applied) = db.apply_class_proposal(id, &actor).map_err(|e| e.to_string())? {
        // A supersede records its own `supersede` ledger event inside the
        // apply — recording a taxonomy_reorg on top would double-log it
        // (with an empty node_id, breaking the reorg contract).
        if applied.op != "supersede" {
            classmem::record_reorg(&db, &actor, &applied.op, &applied.node_id, &applied.detail);
        }
        let _ = app.emit("ledger-changed", ());
        extension_host::publish(
            ext_events::LEDGER_CHANGED,
            &ext_events::LedgerChanged { ts_ms: extension_host::now_ms() },
        );
    }
    let _ = app.emit("classmem-changed", ());
    Ok(())
}

#[tauri::command]
fn classmem_reject_proposal(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    id: i64,
) -> Result<(), String> {
    store.database().reject_class_proposal(id).map_err(|e| e.to_string())?;
    let _ = app.emit("classmem-changed", ());
    Ok(())
}

#[tauri::command]
fn classmem_pin_node(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    id: String,
    pinned: bool,
) -> Result<(), String> {
    let db = store.database();
    db.set_class_node_pinned(&id, pinned).map_err(|e| e.to_string())?;
    classmem::record_curate(&db, &ledger::local_author(), &id, "pin", if pinned { "1" } else { "0" });
    let _ = app.emit("classmem-changed", ());
    let _ = app.emit("ledger-changed", ());
    extension_host::publish(
        ext_events::LEDGER_CHANGED,
        &ext_events::LedgerChanged { ts_ms: extension_host::now_ms() },
    );
    Ok(())
}

/// Dismiss an observation — "never resurface this pattern". The row is kept
/// (dismissed=1) so the keeper's dedup guard keeps holding.
#[tauri::command]
fn classmem_dismiss_observation(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    id: i64,
) -> Result<(), String> {
    let db = store.database();
    if let Some(node_id) = db.set_observation_dismissed(id).map_err(|e| e.to_string())? {
        classmem::record_curate(&db, &ledger::local_author(), &node_id, "observation_dismiss", &id.to_string());
        let _ = app.emit("classmem-changed", ());
        let _ = app.emit("ledger-changed", ());
        extension_host::publish(
            ext_events::LEDGER_CHANGED,
            &ext_events::LedgerChanged { ts_ms: extension_host::now_ms() },
        );
    }
    Ok(())
}

/// Pin an observation — promote the pattern into the node's permanent context.
#[tauri::command]
fn classmem_pin_observation(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    id: i64,
    pinned: bool,
) -> Result<(), String> {
    let db = store.database();
    if let Some(node_id) = db.set_observation_pinned(id, pinned).map_err(|e| e.to_string())? {
        classmem::record_curate(
            &db,
            &ledger::local_author(),
            &node_id,
            "observation_pin",
            &format!("{id}:{}", pinned as i64),
        );
        let _ = app.emit("classmem-changed", ());
        let _ = app.emit("ledger-changed", ());
        extension_host::publish(
            ext_events::LEDGER_CHANGED,
            &ext_events::LedgerChanged { ts_ms: extension_host::now_ms() },
        );
    }
    Ok(())
}

#[tauri::command]
fn classmem_rename_node(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    id: String,
    title: String,
) -> Result<(), String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("title cannot be empty".into());
    }
    let db = store.database();
    db.rename_class_node(&id, &title).map_err(|e| e.to_string())?;
    classmem::record_curate(&db, &ledger::local_author(), &id, "rename", &title);
    let _ = app.emit("classmem-changed", ());
    let _ = app.emit("ledger-changed", ());
    extension_host::publish(
        ext_events::LEDGER_CHANGED,
        &ext_events::LedgerChanged { ts_ms: extension_host::now_ms() },
    );
    Ok(())
}

/// Pop up the native browser "Settings" menu over the embedded browser (HTML
/// can't overlay a native webview, same as bookmarks/view). `tandem` and
/// `highlight` are the current states of tandem agent mode and the
/// highlight-to-chat action bar, so each item shows the right check. A click
/// returns through `on_menu_event` — which forwards anything `bset-`-prefixed
/// as a `browser-settings-action` event — and the pane flips that persisted flag.
#[tauri::command]
fn show_browser_settings_menu(
    app: AppHandle,
    tandem: bool,
    highlight: bool,
    x: f64,
    y: f64,
) -> Result<(), String> {
    let win = menu_anchor_window(&app).ok_or_else(|| "no main window".to_string())?;
    let toggle = CheckMenuItem::with_id(
        &app,
        "bset-tandem",
        "Tandem agent mode",
        true,
        tandem,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let highlight_item = CheckMenuItem::with_id(
        &app,
        "bset-highlight",
        "Highlight actions",
        true,
        highlight,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let menu = MenuBuilder::new(&app)
        .item(&toggle)
        .item(&highlight_item)
        .build()
        .map_err(|e| e.to_string())?;
    win.popup_menu_at(&menu, tauri::LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

/// Native text prompt used to name / rename a bookmark — a native menu can't
/// host a text field. Uses macOS `display dialog`; returns None on cancel.
#[tauri::command]
fn prompt_text(message: String, default_value: String) -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        fn as_quote(s: &str) -> String {
            let mut out = String::with_capacity(s.len() + 2);
            out.push('"');
            for c in s.chars() {
                match c {
                    '\\' => out.push_str("\\\\"),
                    '"' => out.push_str("\\\""),
                    _ => out.push(c),
                }
            }
            out.push('"');
            out
        }
        let script = format!(
            "display dialog {} default answer {} with title \"Redline\" \
             buttons {{\"Cancel\", \"Save\"}} default button \"Save\"",
            as_quote(&message),
            as_quote(&default_value),
        );
        let out = std::process::Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()
            .map_err(|e| e.to_string())?;
        // Non-zero exit = user pressed Cancel (osascript errors on cancel).
        if !out.status.success() {
            return Ok(None);
        }
        let stdout = String::from_utf8_lossy(&out.stdout);
        let name = stdout
            .split("text returned:")
            .nth(1)
            .map(|s| s.trim_end().to_string());
        Ok(name)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (message, default_value);
        Ok(None)
    }
}

/// `(async)` — reads and parses `~/.claude/settings.json`. Small, but file I/O
/// on the main thread is file I/O on the main thread (perf-budget rule 4).
#[tauri::command(async)]
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
    }
    result
}

/// `(async)` — `available` runs the codex capability probe, which can spawn
/// `codex --help` (and, on a machine with an exotic install, an interactive
/// login shell behind it). This was a plain `#[tauri::command]`: a synchronous
/// subprocess on the UI thread, fired on every boot.
#[tauri::command(async)]
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

/// `(async)` — same reason as `get_skill_status`: reads the installed skill
/// files off disk and compares them with the shipped ones.
#[tauri::command(async)]
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

/// `(async)` — walks the installed skill directory and diffs its contents
/// against the shipped payload.
#[tauri::command(async)]
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The zero point for every boot milestone (docs/perf-budget.md "Boot
    // budget"). Before the subscriber, so the very first `Instant` is as close
    // to process start as this function can observe.
    boot_trace::init();
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
            } else {
                // Headless incumbent: the window died (webview crash, close)
                // but the process — daemon, PTYs, held reviews — lived on.
                // The relaunch's intent is plainly "give me Redline back", so
                // re-present a main window instead of doing nothing.
                resurrect_main_window(app);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // `redline://` deep links — the viewer's "Open in Redline" link lands a
        // shared plan as a full native review. Handled in the frontend via the
        // JS plugin's onOpenUrl (both cold-start and running-instance).
        .plugin(tauri_plugin_deep_link::init());
    // Dead-webview revival is a WKWebView concern; the hook only exists on
    // macOS/iOS builds (see webview_guard.rs for the policy).
    #[cfg(target_os = "macos")]
    let builder = builder.on_web_content_process_terminate(webview_guard::on_terminate);
    builder
        .invoke_handler(tauri::generate_handler![
            extensions_list,
            extension_set_enabled,
            extension_uninstall,
            extension_reload,
            local_install_inspect,
            local_install_confirm,
            marketplace_index,
            marketplace_install,
            list_sessions,
            get_session,
            export_revision_markdown,
            export_revision_docx,
            save_revision_to_obsidian,
            delete_session,
            add_comment,
            update_comment,
            delete_comment,
            agent_suggest_edit,
            get_latest_plan,
            accept_agent_suggestion,
            submit_review,
            approve_plan,
            orchestrate_plan,
            record_orchestration_launch,
            workflow_availability,
            apply_orchestrate_allows,
            orchestrate_allow_candidates,
            reset_run,
            relaunch_run,
            unapprove_plan,
            stand_down_run,
            get_run_state,
            record_handoff_event,
            get_plan_run,
            resolve_plan_run,
            queue::queue_start,
            queue::queue_stop,
            queue::queue_status,
            queue::queue_get_config,
            queue::queue_set_config,
            runwatch::orchestration_snapshot,
            runwatch::list_orchestrations,
            runwatch::orchestration_agent_tail,
            accept_resolution,
            reopen_resolution,
            attach_discussion,
            get_interception_mode,
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
            codex_model_catalog,
            seat_assignment_agent,
            seat_assignment_cancel,
            seat_preflight,
            apply_seat_picks,
            revert_seat_assignment,
            seat::get_seat_roster,
            work::get_work_graph,
            work::work_since,
            userconfig::get_workspace,
            userconfig::save_workspace,
            userconfig::list_harnesses,
            userconfig::harness_flavor,
            userconfig::harness_install_from_folder,
            userconfig::harness_uninstall,
            get_relay_config,
            set_relay_config,
            get_owner_secret,
            set_owner_secret,
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
            get_daemon_status,
            daemon_state,
            bootstrap_state,
            claim_review,
            arm_restore,
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
            pty::pty_ack,
            pty::pty_write,
            pty::pty_write_checked,
            pty::pty_is_live,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_kill_all,
            pty::pty_cwd,
            pty::pty_cwds,
            fsbrowse::list_dir,
            fsbrowse::read_text_file,
            fsbrowse::read_file_base64,
            fsbrowse::save_text_file,
            fsbrowse::ensure_dir,
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
            fork::review_thread_send,
            fork::review_question_send,
            fork::review_thread_discard,
            fork::fork_kill_all,
            inspect::inspect_set,
            inspect::inspect_read,
            meter::thread_meters,
            meter::plan_session_meter,
            browse::browse_send,
            browse::browse_turn_status,
            browse::get_browse_thread,
            browse::browse_cancel,
            browse::browse_unqueue,
            browse::browse_discard,
            browse::browse_kill_all,
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
            mission::mission_kill_all,
            linked::linked_create,
            linked::linked_list,
            linked::linked_get_thread,
            linked::linked_create_from_browse,
            linked::linked_send,
            linked::linked_cancel,
            linked::linked_unqueue,
            linked::linked_turn_status,
            linked::linked_delete,
            linked::linked_set_tabs,
            linked::linked_get_tabs,
            linked::linked_kill_all,
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
            push::review_revert,
            push::review_last_push,
            ai_commit::ai_commit_draft,
            review::review_sessions_list,
            review::review_delete,
            review::review_annotation_add,
            review::review_annotation_update,
            review::review_annotation_delete,
            review::review_annotation_list,
            review::review_mark_viewed,
            review::review_list_viewed,
            voice::voice_session_start,
            voice::voice_send,
            voice::voice_clean,
            voice::voice_session_stop,
            voice::voice_forget,
            voice::voice_kill_all,
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
            tts::tts_kokoro_status,
            tts::tts_kokoro_install,
            tts::tts_kokoro_warm,
            dictation::dictation_start,
            dictation::dictation_stop,
            dictation::dictation_cycle,
            dictation::dictation_kill_all,
            dictation_whisper::whisper_install,
            dictation_whisper::whisper_model_present,
            dictation_whisper::dictation_get_engine,
            dictation_whisper::dictation_set_engine,
            devmap::dev_servers_scan,
            devmap::dev_server_stop,
            devmap::dev_server_set_thumb,
            browser_navigate,
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
            intake::intake_triage,
            moot::moot_start,
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
            bookshelf::draft_source_add,
            bookshelf::draft_source_import_file,
            bookshelf::draft_source_list,
            bookshelf::draft_source_delete,
            draft_chat::draft_instruct,
            draft_chat::draft_turn_status,
            draft_chat::draft_chat_cancel,
            draft_chat::draft_chat_kill_all,
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
            fork::draft_thread_discard,
            memchat::memchat_send,
            memchat::memchat_turn_status,
            memchat::memchat_thread,
            memchat::memchat_cancel,
            memchat::memchat_unqueue,
            memchat::memchat_clear,
            memchat::memchat_kill_all,
            companion::companion_create,
            companion::companion_list,
            companion::companion_get_thread,
            companion::companion_rename,
            companion::companion_set_model,
            companion::companion_delete,
            companion::companion_send,
            companion::companion_turn_status,
            companion::companion_cancel,
            companion::companion_unqueue,
            companion::companion_kill_all,
            draft_suggestions_pending,
            draft_suggestion_resolve,
            draft_suggestion_unresolve,
            parse_markdown_sections,
            browser_enable_gestures,
            browser_enable_autoresize,
            browser_set_view,
            browser_install_shims,
            show_bookmarks_menu,
            show_view_menu,
            show_browser_settings_menu,
            set_source_feedback,
            get_source_feedback,
            ledger_list_events,
            ledger_query,
            ledger_verify,
            ledger_prompt_body,
            ledger_prompt_models,
            context_stats,
            context_search,
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
            classmem_get_auto_apply,
            classmem_set_auto_apply,
            classmem_accept_node,
            classmem_reject_node,
            classmem_accept_link,
            classmem_reject_link,
            classmem_accept_proposal,
            classmem_reject_proposal,
            classmem_pin_node,
            classmem_rename_node,
            classmem_dismiss_observation,
            classmem_pin_observation,
            memory_status,
            memory_forget,
            memory_reindex,
            memory_restore,
            memory_set_embed_provider,
            memory_embed_settings,
            memory_revert_link,
            memory_note_write,
            memory_note_get,
            memory_notes_list,
            prompt_text,
            librarian_agent,
            shipwright_agent,
            shipwright_findings,
            shipwright_resolve,
            shipwright_detect_shipped,
            export_context_bundle,
            mirror_status,
            pick_mirror_dir,
            set_mirror_dir,
            mirror_rebuild,
            mirror_sync,
            create_memory_vault,
            mcp_config_snippet,
        ])
        .setup(|app| {
            boot_trace::mark(boot_trace::SETUP_ENTER);
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

            let data_dir = app
                .path()
                .app_data_dir()
                .expect("could not resolve app data dir");
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
                    std::process::exit(1);
                })
            }));

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

            let claims = ClaimFlags::new();
            app.manage(claims.clone());

            app.manage(pty::PtyState::new());
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

            // Linked discussion (browser pane): one conversation spanning all
            // tabs. Same lazy-`claude` reasoning; delegates heavy tabs back to
            // their browse agents via the consult route.
            let linked_state = linked::LinkedState::new(db.clone());
            app.manage(linked_state);

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
            // Overnight queue (P0): runtime flag only — never armed at
            // boot; it starts on an explicit `queue_start` or the keeper's
            // ready-depth nudge over opted-in repos (both go through the
            // same `queue_start` ignition).
            app.manage(queue::QueueRuntime::new());

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
            // model lives under the app data dir.
            app.manage(tts::TtsState::new(db.clone(), data_dir.clone()));

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

            let store = boot_trace::timed(boot_trace::STORE_HYDRATE, || SessionStore::new(db));
            app.manage(store.clone());
            // Friction telemetry for the two contexts that hold no `Database`
            // (the axum auth middleware, chiefly). Installed once, right after
            // the store exists and before the daemon starts serving.
            db::install_friction_sink(store.database());
            // The memory seats' agent (Session A4 of the Polis extraction).
            polis_host::install_agent(Arc::new(polis_host::RedlineAgent));

            // Run watchers for the Orchestration Monitor. Rehydrate one per
            // still-live orchestrated run — the durable `orchestrations`
            // anchor is what survives a restart mid-run.
            app.manage(runwatch::RunWatchState::new());
            if let Ok(rows) = store.database().list_orchestrations() {
                for row in rows {
                    if runwatch::is_live_run_state(row.run_state.as_deref()) {
                        runwatch::start(app.handle(), store.clone(), row.plan_session_id);
                    }
                }
            }

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
            app.manage(LaunchedTerminals::default());

            // Memory as plumbing + the watch bus: the background keeper. One
            // 30s loop, two duties — the idle-gated memory passes (organize /
            // compact / observe: no buttons, no configs, one quiet pill) and
            // the watch bus that re-homes the app's background timers (mirror
            // sync, ledger backup, orchestrate-stall sweep, review-staleness
            // sweep, the ready-depth queue nudge) plus the scheduled one-shots
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
            // Make Cmd+W close the active browser TAB (or the window when the
            // browser isn't open) instead of always slamming the whole window
            // shut. The stock File submenu (index 1 on macOS) holds only "Close
            // Window" bound to Cmd+W; swap it for our own item carrying that
            // accelerator, and let the frontend decide tab-vs-window on the
            // `menu-close-tab` event. A menu key-equivalent fires regardless of
            // which (native) webview has focus, so it works even while a video
            // tab is focused.
            if let Some(MenuItemKind::Submenu(file_submenu)) = top_items.get(1) {
                while !file_submenu.items()?.is_empty() {
                    file_submenu.remove_at(0)?;
                }
                // Neutral "Close" label — honest whether it closes a browser
                // tab (pane open) or the window (pane closed).
                let close_tab = MenuItemBuilder::with_id("close_tab", "Close")
                    .accelerator("CmdOrCtrl+W")
                    .build(app)?;
                file_submenu.append(&close_tab)?;
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
                // Cmd+W → the browser pane closes its active tab; if the browser
                // isn't open, App falls back to closing the window.
                "close_tab" => {
                    let _ = app.emit("menu-close-tab", ());
                }
                // Bookmarks popup-menu clicks → let the browser pane act on them.
                id if id.starts_with("bm-") => {
                    let _ = app.emit("bookmark-menu-action", id.to_string());
                }
                // View-filter menu clicks → let the browser pane apply them.
                id if id.starts_with("view-") => {
                    let _ = app.emit("view-menu-action", id.to_string());
                }
                // Browser settings menu clicks (e.g. tandem toggle) → let the
                // browser pane flip the matching persisted flag.
                id if id.starts_with("bset-") => {
                    let _ = app.emit("browser-settings-action", id.to_string());
                }
                _ => {}
            });

            // Background update check on launch: the same comparison the menu
            // item runs, but quiet — it only interrupts to offer a real rebuild,
            // staying silent when up to date or offline. Gives users the update
            // prompt hands-free instead of only when they remember to look.
            update::check_for_updates_in_background(app.handle().clone());

            boot_trace::mark(boot_trace::SETUP_DONE);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Kill any headless `claude` discussion forks on teardown so no
            // child is orphaned (PTYs SIGHUP-clean when their master closes).
            if let tauri::RunEvent::Exit = event {
                // Polis: a final crown-jewels snapshot of the ledger DB on quit.
                if let Some(store) = app_handle.try_state::<SessionStore>() {
                    if let Ok(dir) = app_handle.path().app_data_dir() {
                        snapshot_database(&store.database(), &dir, LEDGER_BACKUP_KEEP);
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
                if let Some(linked) = app_handle.try_state::<linked::LinkedState>() {
                    linked.kill_all();
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
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    /// The selection bar is a user script like any other, so what it costs to
    /// get wrong is a tab that silently loses it. These pin the *set* — the one
    /// part of `install_user_scripts` that isn't objc.
    #[test]
    fn browser_user_scripts_includes_the_selection_bar_only_when_enabled() {
        let on = browser_user_scripts("", true);
        assert!(on.iter().any(|(src, _)| src.contains("__redline_sel_installed")));
        let off = browser_user_scripts("", false);
        assert!(!off.iter().any(|(src, _)| src.contains("__redline_sel_installed")));
        // Both shims survive either way — the toggle is not allowed to drop them.
        for set in [&on, &off] {
            assert!(set.iter().any(|(src, _)| src.contains("__redline_fs_installed")));
            assert!(set.iter().any(|(src, _)| src.contains("__redline_newtab_installed")));
        }
    }

    #[test]
    fn browser_user_scripts_keeps_the_view_filter_conditional_and_main_frame_only() {
        // No filter → no view script at all (an empty css is a *reset*, applied
        // by eval, never registered).
        assert!(!browser_user_scripts("", true)
            .iter()
            .any(|(src, _)| src.contains("__redline_view__")));
        let with_css = browser_user_scripts("html{filter:invert(100%)}", true);
        let view = with_css
            .iter()
            .find(|(src, _)| src.contains("__redline_view__"))
            .expect("view filter script");
        assert!(view.1, "the filter must not invert ad/embed iframes");
        // …and neither may the selection bar sprout a second copy in one.
        let sel = with_css
            .iter()
            .find(|(src, _)| src.contains("__redline_sel_installed"))
            .expect("selection script");
        assert!(sel.1, "the selection bar is main frame only");
        // The fullscreen embed handshake and the new-tab relay need every frame.
        for (src, main_only) in &with_css {
            if src.contains("__redline_fs_installed") || src.contains("__redline_newtab_installed") {
                assert!(!main_only);
            }
        }
    }

    #[test]
    fn selection_shim_carries_its_guard_and_every_action_id() {
        let js = selection_shim_js();
        // The double install (user script *and* the eval into the loaded page)
        // must be a no-op the second time.
        assert!(js.contains("if (window.__redline_sel_installed) return;"));
        // …but the runtime off-switch is cleared BEFORE that guard, or
        // re-checking the setting could never revive an installed shim.
        let cleared = js.find("__redline_sel_off = false").expect("off-switch clear");
        let guard = js.find("if (window.__redline_sel_installed) return;").unwrap();
        assert!(cleared < guard);
        for action in ["'ask'", "'define'", "'explain'", "'research'", "'copy'", "'list'"] {
            assert!(js.contains(action), "missing action {action}");
        }
        // Every queued action lands on the queue the pane drains.
        assert!(js.contains("window.__redline_selections"));
        // The one line that makes the whole gesture work.
        assert!(js.contains("e.preventDefault(); e.stopPropagation(); },true);"));
        // ＋ List asks for the note instead of filing the highlighted passage as
        // one: the passage is WHERE, the note is WHAT.
        assert!(js.contains("if (action==='list'){ openNote(); return; }"));
        // The side-pane composer reads its location from this, so it has to be
        // published on every evaluate AND cleared when the selection goes.
        assert!(js.contains("window.__redline_sel_last"));
        assert!(js.contains("pending=null; publish(); hide(); return;"));
        // The material the pointer is resolved from.
        for field in ["testId:", "landmark:", "heading:", "path:", "classes:"] {
            assert!(js.contains(field), "locator is missing {field}");
        }
        // Typing a note must not re-place the bar under the caret.
        assert!(js.contains("if (composing) return;"));
    }

    #[test]
    fn selection_teardown_flips_the_runtime_flag() {
        let js = selection_teardown_js();
        assert!(js.contains("__redline_sel_off = true"));
        assert!(js.contains("data-redline-selection"));
        // With no bar there is no way to see what is highlighted, so nothing
        // may still be silently anchoring to it.
        assert!(js.contains("__redline_sel_last = null"));
    }

    /// `same_tab_url` has to agree with `sameTabUrl` in browseList.ts, because
    /// the frontend's dedupe decides whether the active label changes and this
    /// decides whether that counts as success. A drift between the two shows up
    /// as `/v1/browser/open` reporting a timeout on a focus that worked.
    #[test]
    fn same_tab_url_matches_a_dev_server_by_port() {
        // The reported bug, in three strings: the card links one, the poll
        // rewrites the tab to another, a redirect produces the third.
        assert!(same_tab_url(
            "http://localhost:3000",
            "http://localhost:3000/"
        ));
        assert!(same_tab_url(
            "http://localhost:3000",
            "http://localhost:3000/dashboard"
        ));
        assert!(same_tab_url("http://127.0.0.1:3000/x", "http://localhost:3000"));
        assert!(same_tab_url("https://localhost:3000", "http://localhost:3000"));
        // Different port is a different server, loopback or not.
        assert!(!same_tab_url(
            "http://localhost:3000",
            "http://localhost:5173"
        ));
        // Loopback and public are two different machines.
        assert!(!same_tab_url("http://localhost:3000", "http://example.com:3000"));
    }

    #[test]
    fn same_tab_url_is_strict_off_loopback() {
        assert!(same_tab_url("https://example.com/a/", "https://example.com/a"));
        assert!(same_tab_url(
            "https://example.com/a#top",
            "https://example.com/a"
        ));
        assert!(same_tab_url("https://example.com:443/a", "https://example.com/a"));
        // A public site's paths are separate pages — only loopback collapses
        // them, and only because a dev server's identity is its port.
        assert!(!same_tab_url("https://example.com/a", "https://example.com/b"));
        assert!(!same_tab_url(
            "https://example.com/a?x=1",
            "https://example.com/a?x=2"
        ));
        assert!(!same_tab_url("https://example.com/a", "http://example.com/a"));
        // Unparseable on either side falls back to exact equality: never widen
        // a match we can't reason about.
        assert!(!same_tab_url("not a url", "https://example.com"));
        assert!(same_tab_url("not a url", "not a url"));
    }

    /// A failed ledger write must leave BOTH launch guards disarmed. Both exist
    /// to make the spawned session's own hook fire *skip* this body; arming
    /// them before the write meant a failed write left them armed for the 300s
    /// TTL, the hook skipped the prompt, and the prompt existed nowhere — the
    /// launch succeeded, the plan arrived, and nothing recorded what was asked.
    /// Ordering is the whole fix, so ordering is what's pinned.
    #[test]
    fn a_failed_ledger_write_leaves_both_launch_guards_disarmed() {
        const SRC: &str = include_str!("lib.rs");
        let body = SRC
            .split_once("fn record_plan_launch(")
            .expect("record_plan_launch exists")
            .1;
        let record = body.find("ledger::record_prompt(&db, input)").expect("records");
        let agent_guard = body.find("ledger::register_agent_prompt(&body)").expect("arms");
        let launch_guard = body.find("ledger::register_plan_launch(").expect("arms");
        assert!(
            record < agent_guard && record < launch_guard,
            "record_prompt must run BEFORE either guard is armed"
        );
        // ...and the failure must be visible to Shipwright/Librarian, not just
        // returned to a caller that used to drop it.
        let friction = body.find("record_friction(").expect("friction on the error path");
        assert!(friction < agent_guard, "friction is on the early-return path");
    }

    /// The suggestions endpoint teaches snake_case but agents long saw
    /// `blockId`/`agentId` — both casings must deserialize, or block ops 400
    /// on casing alone.
    #[test]
    fn draft_suggestion_req_accepts_both_casings() {
        let snake: DraftSuggestionReq = serde_json::from_str(
            r#"{"op":"replace_block","block_id":"blk-1","agent_id":"a","comment_id":"c","markdown":"x"}"#,
        )
        .unwrap();
        assert_eq!(snake.block_id.as_deref(), Some("blk-1"));
        assert_eq!(snake.agent_id.as_deref(), Some("a"));
        assert_eq!(snake.comment_id.as_deref(), Some("c"));
        let camel: DraftSuggestionReq = serde_json::from_str(
            r#"{"op":"replace_block","blockId":"blk-1","agentId":"a","commentId":"c","markdown":"x"}"#,
        )
        .unwrap();
        assert_eq!(camel.block_id.as_deref(), Some("blk-1"));
        assert_eq!(camel.agent_id.as_deref(), Some("a"));
        assert_eq!(camel.comment_id.as_deref(), Some("c"));
    }

    /// Golden: the exact UserPromptSubmit payload captured from claude 2.1.199
    /// (docs/protocol-verification.md). The submitted text is at `prompt` — NOT
    /// `user_input` as the public docs claim. Building against `user_input`
    /// alone would capture empties; this pins the empirical reality.
    #[test]
    fn ingest_reads_prompt_field_from_real_payload() {
        let golden = serde_json::json!({
            "session_id": "fbf661e8-3152-4f0d-bc43-e1bc07008f5a",
            "transcript_path": "/Users/x/.claude/projects/p/s.jsonl",
            "cwd": "/Users/x/proj",
            "prompt_id": "37137840-65f2-43a0-b280-7a3b7ad1564f",
            "permission_mode": "default",
            "hook_event_name": "UserPromptSubmit",
            "prompt": "say hi in one word"
        });
        assert_eq!(ingest_prompt_text(&golden), "say hi in one word");
        // Forward-compat: a hypothetical `user_input`-only payload still works.
        let alt = serde_json::json!({ "user_input": "  spaced  " });
        assert_eq!(ingest_prompt_text(&alt), "spaced");
        // No text → empty (the handler skips empties).
        assert_eq!(ingest_prompt_text(&serde_json::json!({ "prompt": "   " })), "");
        assert_eq!(ingest_prompt_text(&serde_json::json!({})), "");
    }

    /// Snapshot enrichment truncation must be char-boundary safe (never split a
    /// multi-byte codepoint) and only ellipsize when it actually clips.
    #[test]
    fn snap_truncate_is_char_boundary_safe() {
        // Short strings pass through, trimmed, no ellipsis.
        assert_eq!(snap_truncate("  hello  ", 80), "hello");
        // Over-length ASCII clips to max chars (incl. the ellipsis).
        let clipped = snap_truncate("abcdefghij", 5);
        assert_eq!(clipped.chars().count(), 5);
        assert!(clipped.ends_with('…'));
        // Multi-byte text never panics and stays valid UTF-8 at the boundary.
        let emoji = "😀😀😀😀😀😀";
        let t = snap_truncate(emoji, 3);
        assert_eq!(t.chars().count(), 3);
        assert!(t.ends_with('…'));
        // Reading-time rounds up and never reports zero.
        assert_eq!(0u32.div_ceil(SNAP_WORDS_PER_MINUTE).max(1), 1);
        assert_eq!(1u32.div_ceil(SNAP_WORDS_PER_MINUTE).max(1), 1);
        assert_eq!(201u32.div_ceil(SNAP_WORDS_PER_MINUTE).max(1), 2);
    }

    /// The resume cwd comes from the FIRST cwd a transcript records — the
    /// directory the session was launched from. A session that `cd`s elsewhere
    /// (the dialcrown case: started in `~`, worked in `~/dialcrown`) is still
    /// only resumable from where it started.
    #[test]
    fn startup_cwd_is_the_first_one_recorded_not_the_last() {
        let dir = std::env::temp_dir().join(format!("rl-resume-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let path = dir.join("t.jsonl");
        std::fs::write(
            &path,
            concat!(
                // Claude Code's opening record carries no cwd at all.
                "{\"type\":\"mode\",\"mode\":\"default\"}\n",
                "{\"type\":\"user\",\"cwd\":\"/Users/me\"}\n",
                "{\"type\":\"assistant\",\"cwd\":\"/Users/me\"}\n",
                "{\"type\":\"user\",\"cwd\":\"/Users/me/dialcrown\"}\n",
            ),
        )
        .unwrap();
        assert_eq!(
            startup_cwd_from_transcript(&path).as_deref(),
            Some("/Users/me")
        );

        // An empty cwd is not an answer — keep looking.
        let blank = dir.join("blank.jsonl");
        std::fs::write(
            &blank,
            concat!(
                "{\"type\":\"user\",\"cwd\":\"\"}\n",
                "{\"type\":\"user\",\"cwd\":\"/Users/me/repo\"}\n",
            ),
        )
        .unwrap();
        assert_eq!(
            startup_cwd_from_transcript(&blank).as_deref(),
            Some("/Users/me/repo")
        );

        // No cwd anywhere, unparseable lines, and a missing file all decline
        // rather than guess — the caller falls back to the project path.
        let none = dir.join("none.jsonl");
        std::fs::write(&none, "{\"type\":\"user\"}\nnot json\n").unwrap();
        assert_eq!(startup_cwd_from_transcript(&none), None);
        assert_eq!(startup_cwd_from_transcript(&dir.join("nope.jsonl")), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The detached-delivery error names the harness that actually left, and
    /// keeps the phrase the frontend's `isDetachError` matches on.
    #[test]
    fn detached_delivery_error_names_the_right_harness() {
        let codex = detached_delivery_error("codex");
        assert!(codex.starts_with("Codex is no longer waiting"));
        assert!(codex.contains("the Codex session ended"));
        // Never Claude's name on a Codex reviewer's failure.
        assert!(!codex.contains("Claude"));

        // Claude, and every legacy/unknown row, keep the sentence they had.
        for backend in ["claude-code", "", "gemini"] {
            let msg = detached_delivery_error(backend);
            assert!(msg.starts_with("Claude is no longer waiting"), "{backend}");
            assert!(msg.contains("the Claude Code session ended"), "{backend}");
        }

        // The banner trigger. `isDetachError` (src/App.tsx) substring-matches
        // this; losing it on either arm leaves the reviewer with a dead
        // in-review screen and no Restore button.
        for backend in ["codex", "claude-code"] {
            assert!(detached_delivery_error(backend).contains("no longer waiting"));
            assert!(detached_delivery_error(backend).contains("Restore plan session"));
        }
    }

    /// `prepare_restore` branches on the harness before it touches a single
    /// file. The Claude arm answers from `~/.claude`; the Codex arm declines to
    /// look, because every question it could ask there has a Claude-shaped
    /// answer and a Codex thread would fail all of them for the wrong reason.
    #[test]
    fn prepare_restore_only_reads_claude_files_for_a_claude_session() {
        // An id no transcript can exist for, so the Claude arm is guaranteed to
        // reach its "looked, found nothing" branch.
        let id = format!("rl-no-such-session-{}", uuid::Uuid::new_v4());
        let project = Some("/Users/me/redline".to_string());

        // Codex: the plan's project directory, and NO claim about history.
        let codex = prepare_restore(
            id.clone(),
            project.clone(),
            Some("codex".to_string()),
        );
        assert_eq!(codex.cwd.as_deref(), Some("/Users/me/redline"));
        assert_eq!(codex.history, RestoreHistory::Unchecked);
        // Nothing was relocated (no transcript was consulted to relocate to)
        // and no plan file was primed — Codex has none to prime.
        assert!(!codex.relocated);
        assert!(!codex.primed);

        // Claude, same id: it DID look, and says so. This is the contrast that
        // matters — `Missing` is what drives the reviewer-facing "resuming as a
        // fresh conversation" warning, and a Codex user must never see it.
        for backend in [None, Some("claude-code".to_string())] {
            let claude = prepare_restore(id.clone(), project.clone(), backend);
            assert_eq!(claude.history, RestoreHistory::Missing);
            assert_eq!(claude.cwd.as_deref(), Some("/Users/me/redline"));
            assert!(!claude.primed);
        }

        // An unknown harness is not Codex. Legacy rows and anything Redline
        // hasn't been taught fall to the Claude behaviour they've always had,
        // never to the arm that skips the lookup.
        assert_eq!(
            prepare_restore(id.clone(), project.clone(), Some("gemini".into())).history,
            RestoreHistory::Missing
        );

        // With no project path there is nothing to fall back to, and the Codex
        // arm says so rather than inventing a directory.
        let bare = prepare_restore(id, None, Some("codex".to_string()));
        assert_eq!(bare.cwd, None);
        assert_eq!(bare.history, RestoreHistory::Unchecked);
    }

    /// The three history states serialize to the strings the frontend switches
    /// on. A silent rename here would degrade every restore message to its
    /// fallback branch without failing anything.
    #[test]
    fn restore_history_serializes_as_the_ui_contract() {
        let j = |h: RestoreHistory| {
            serde_json::to_string(&ResumeTarget {
                cwd: None,
                history: h,
                relocated: false,
                primed: false,
            })
            .unwrap()
        };
        assert!(j(RestoreHistory::Available).contains("\"history\":\"available\""));
        assert!(j(RestoreHistory::Missing).contains("\"history\":\"missing\""));
        assert!(j(RestoreHistory::Unchecked).contains("\"history\":\"unchecked\""));
        // The old boolean is gone; nothing may still be reading it.
        assert!(!j(RestoreHistory::Available).contains("found"));
    }

    /// The plan file is read out of the transcript, last mention wins — a
    /// session that changed plan files mid-life is on its newest one.
    #[test]
    fn plan_file_is_the_last_one_the_transcript_names() {
        let dir = std::env::temp_dir().join(format!("rl-planfile-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let path = dir.join("t.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"tool\":\"Write\",\"file_path\":\"/Users/me/.claude/plans/old-name.md\"}\n",
                "{\"text\":\"wrote /Users/me/.claude/plans/wild-treasure.md ok\"}\n",
                "{\"type\":\"user\",\"cwd\":\"/Users/me\"}\n",
            ),
        )
        .unwrap();
        assert_eq!(
            plan_file_from_transcript(&path).as_deref(),
            Some("/Users/me/.claude/plans/wild-treasure.md")
        );

        // A transcript that never entered plan mode has no plan file, and a
        // missing transcript is not an error — both fall back to asking the
        // model to write the marker itself.
        let bare = dir.join("bare.jsonl");
        std::fs::write(&bare, "{\"type\":\"user\",\"cwd\":\"/Users/me\"}\n").unwrap();
        assert_eq!(plan_file_from_transcript(&bare), None);
        assert_eq!(plan_file_from_transcript(&dir.join("nope.jsonl")), None);

        // Priming refuses to invent a plan file: a path that isn't there means
        // the resumed session will mint a name we can't predict.
        assert!(!prime_plan_file(
            dir.join("absent.md").to_str().unwrap(),
            "abc-123"
        ));

        // …and over a real one it writes exactly the sentinel the daemon's
        // `restore_handshake` recognises.
        let plan = dir.join("plan.md");
        std::fs::write(&plan, "# An old plan body\n").unwrap();
        assert!(prime_plan_file(plan.to_str().unwrap(), "abc-123"));
        let written = std::fs::read_to_string(&plan).unwrap();
        assert_eq!(restore_handshake(&written), Some(Some("abc-123".into())));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Session ids are joined into a path, so anything that isn't the shape
    /// Claude Code issues is refused before it can climb out of the projects
    /// directory.
    #[test]
    fn session_ids_that_could_walk_the_filesystem_are_refused() {
        assert!(is_plain_session_id("4bf30a9f-3f6f-4e9d-8970-389c70869612"));
        assert!(is_plain_session_id("agent_a55a04f7bc248b80f"));
        assert!(!is_plain_session_id(""));
        assert!(!is_plain_session_id("../../etc/passwd"));
        assert!(!is_plain_session_id("a/b"));
        assert!(!is_plain_session_id("a.jsonl"));
        assert!(!is_plain_session_id(&"x".repeat(129)));
    }

    /// The transcript backfill: newest `message.model` wins, and a transcript
    /// with no assistant turn yields `None` — never a guess.
    #[test]
    fn model_from_transcript_reads_the_newest_model_from_the_tail() {
        let dir = std::env::temp_dir().join(format!("rl-model-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-older-model\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-newest-model\"}}\n",
                "{\"type\":\"system\",\"subtype\":\"turn_end\"}\n",
            ),
        )
        .unwrap();
        assert_eq!(
            model_from_transcript(path.to_str().unwrap()).as_deref(),
            Some("claude-newest-model")
        );

        // A brand-new session: user turn only → None (the model lands one
        // hook fire late, once an assistant message exists).
        let fresh = dir.join("fresh.jsonl");
        std::fs::write(
            &fresh,
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n",
        )
        .unwrap();
        assert_eq!(model_from_transcript(fresh.to_str().unwrap()), None);

        // Unreadable path → None, never an error path in the hook.
        assert_eq!(model_from_transcript("/nonexistent/nope.jsonl"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The seat stamp + transcript backfill contract on the prompts table:
    /// a seat-stamped row is never overwritten by the backfill, an unstamped
    /// row is, and the drafter launch row binds to its session exactly once.
    #[test]
    fn model_backfill_and_drafter_bind_respect_capture_truth() {
        let db = Database::open_in_memory().unwrap();
        // A drafter-launched prompt: no claude session yet, no model.
        let body = "# plan body";
        let bh = ledger::body_hash(body);
        ledger::record_prompt(
            &db,
            ledger::PromptInput {
                source: ledger::PromptSource::DrafterLaunch,
                origin: ledger::Origin::Redline,
                surface: "drafter".into(),
                role: crate::ledger::CorpusRole::User,
                user_text: None,
                session_id: None,
                claude_session_id: None,
                mission_id: None,
                project_path: None,
                body: body.into(),
                thread: Some(ledger::ThreadRef {
                    thread_kind: "drafter",
                    thread_id: "draft-1".into(),
                    parent_session_id: None,
                }),
                author: None,
                model: None,
                model_source: None,
            },
        )
        .unwrap();
        // A seat-stamped agent prompt under a live session.
        ledger::record_prompt(
            &db,
            ledger::PromptInput {
                source: ledger::PromptSource::RustFirstTurn,
                origin: ledger::Origin::Redline,
                surface: "browse".into(),
                role: crate::ledger::CorpusRole::User,
                user_text: None,
                session_id: None,
                claude_session_id: Some("cs-1".into()),
                mission_id: None,
                project_path: None,
                body: "discuss".into(),
                thread: None,
                author: None,
                model: Some("sonnet".into()),
                model_source: Some("seat".into()),
            },
        )
        .unwrap();

        // Bind the drafter row to its session (the ingest hook's claim moment).
        assert_eq!(db.bind_drafter_prompt_session(&bh, "draft-1", "cs-1").unwrap(), 1);
        // Re-binding matches nothing: claude_session_id is no longer NULL.
        assert_eq!(db.bind_drafter_prompt_session(&bh, "draft-1", "cs-2").unwrap(), 0);

        // The drafter row now lacks a model under cs-1 → backfill stamps it,
        // and the seat-stamped row keeps its capture-time truth.
        assert!(db.session_needs_model("cs-1"));
        assert_eq!(db.backfill_session_model("cs-1", "claude-from-transcript").unwrap(), 1);
        assert!(!db.session_needs_model("cs-1"), "everything stamped now");
        let models = db.list_prompt_models().unwrap();
        assert_eq!(models.len(), 2);
        assert!(models.iter().any(|(_, m)| m == "sonnet"));
        assert!(models.iter().any(|(_, m)| m == "claude-from-transcript"));
    }

    /// Cold-wallet posture pin: the daemon must bind loopback only, never a
    /// routable interface. If someone changes this, they change the invariant.
    #[test]
    fn daemon_binds_loopback_only() {
        assert_eq!(DAEMON_ADDR, "127.0.0.1:7676");
        assert!(
            DAEMON_ADDR.starts_with("127.0.0.1:"),
            "the daemon must bind loopback only (cold-wallet posture)"
        );
    }

    #[test]
    fn external_source_tags_are_fenced() {
        assert!(valid_source_tag("mylinter"));
        assert!(valid_source_tag("clippy-2"));
        assert!(valid_source_tag("a_b"));
        // Reserved authors and malformed tags are refused.
        assert!(!valid_source_tag("user"));
        assert!(!valid_source_tag("ai"));
        assert!(!valid_source_tag(""));
        assert!(!valid_source_tag("Has-Caps"));
        assert!(!valid_source_tag("space here"));
        assert!(!valid_source_tag(&"x".repeat(33)));
    }
    use crate::state::reparse_sections;
    use std::sync::Arc;

    // --- Browse-agent download helpers ------------------------------------

    #[test]
    fn sanitize_basename_strips_traversal_and_separators() {
        // Path separators: only the final component survives — the security
        // boundary that keeps a fetched/derived name inside the target dir.
        assert_eq!(sanitize_basename("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_basename("/abs/path/report.pdf"), "report.pdf");
        assert_eq!(sanitize_basename(r"C:\Users\x\evil.exe"), "evil.exe");
        // A lone `..` (or whitespace-only) is rejected so it can't name a dir.
        assert_eq!(sanitize_basename(".."), "");
        assert_eq!(sanitize_basename("   "), "");
        // Leading dots (dotfiles) and control chars are dropped.
        assert_eq!(sanitize_basename(".env"), "env");
        assert_eq!(sanitize_basename("a\u{0007}b.txt"), "ab.txt");
        // An ordinary name is untouched.
        assert_eq!(sanitize_basename("form20-f.htm"), "form20-f.htm");
    }

    #[test]
    fn download_filename_from_url_path() {
        assert_eq!(
            download_filename("https://www.sec.gov/Archives/edgar/form20-f.htm", false),
            "form20-f.htm"
        );
        // Query and fragment are dropped before taking the basename.
        assert_eq!(
            download_filename("https://x.com/a/file.pdf?v=2#frag", false),
            "file.pdf"
        );
        // Trailing slash → the last real segment.
        assert_eq!(download_filename("https://x.com/docs/report/", false), "report");
        // DOM saves get an .html suffix unless they already end in .htm(l).
        assert_eq!(download_filename("https://example.com/page", true), "page.html");
        assert_eq!(download_filename("https://x.com/a.htm", true), "a.htm");
    }

    #[test]
    fn host_of_extracts_bare_host() {
        assert_eq!(
            host_of("https://user:pass@www.sec.gov:443/path"),
            "www.sec.gov"
        );
        assert_eq!(host_of("http://example.com"), "example.com");
    }

    #[test]
    fn content_disposition_filename_is_parsed_and_sanitized() {
        assert_eq!(
            filename_from_content_disposition("attachment; filename=\"report.pdf\""),
            Some("report.pdf".to_string())
        );
        assert_eq!(
            filename_from_content_disposition("inline; filename=plain.txt"),
            Some("plain.txt".to_string())
        );
        // A traversal attempt in the header is reduced to a bare basename.
        assert_eq!(
            filename_from_content_disposition("attachment; filename=\"../../x.sh\""),
            Some("x.sh".to_string())
        );
        // No filename param → None (the caller derives from the URL instead).
        assert_eq!(filename_from_content_disposition("attachment"), None);
    }

    #[test]
    fn dedup_name_suffixes_only_on_collision() {
        // No collision → used as-is.
        assert_eq!(dedup_name("a.htm", |_| false), "a.htm");
        // The base name is taken → the suffix goes before the extension.
        assert_eq!(dedup_name("a.htm", |c| c == "a.htm"), "a (1).htm");
        // Base and (1) taken → (2).
        let taken = |c: &str| c == "a.htm" || c == "a (1).htm";
        assert_eq!(dedup_name("a.htm", taken), "a (2).htm");
        // Extensionless names get a bare " (1)" suffix.
        assert_eq!(dedup_name("README", |c| c == "README"), "README (1)");
    }

    fn make_store() -> SessionStore {
        let db = Arc::new(Database::open_in_memory().unwrap());
        SessionStore::new(db)
    }

    /// The combine reads: latest revision, caller's order, hard error on an
    /// unknown id. A pill that silently vanished would change what was merged
    /// without saying so.
    #[test]
    fn combine_rows_take_the_latest_revision_and_preserve_order() {
        let store = make_store();
        let v1 = "# Auth rework\n\nFirst pass.\n";
        let v2 = "# Auth rework\n\nSecond pass.\n";
        store.upsert_plan("s1", "/tmp/a", v1.to_string(), reparse_sections(v1), true, false);
        store.upsert_plan("s1", "/tmp/a", v2.to_string(), reparse_sections(v2), false, false);
        let b = "# Billing\n\nBody.\n";
        store.upsert_plan("s2", "/tmp/b", b.to_string(), reparse_sections(b), true, false);

        let rows = combine_rows(&store, &["s2".into(), "s1".into()]).unwrap();
        assert_eq!(
            rows.iter().map(|r| r.session_id.as_str()).collect::<Vec<_>>(),
            vec!["s2", "s1"],
            "the caller's order is the brief's order"
        );
        let auth = &rows[1];
        assert!(auth.raw_plan_markdown.contains("Second pass."), "latest revision only");
        assert_eq!(auth.version_number, 2);
        assert_eq!(auth.status, "in_review");

        let err = combine_rows(&store, &["s1".into(), "nope".into()]).unwrap_err();
        assert!(err.contains("nope"), "an unknown id errors rather than being skipped: {err}");
    }

    /// The bind must follow `row_hash` in BOTH arms. Only the threadless arm
    /// is reachable from Combine today, so a drift here would be invisible
    /// until the first combination launched from a thread — at which point it
    /// would bind a hash no row has.
    #[test]
    fn both_ingest_bind_arms_follow_the_claim_row_hash() {
        let body = std::fs::read_to_string(file!()).expect("read own source");
        let at = body
            .find("let row_key = claim.row_hash.as_deref().unwrap_or(&bh);")
            .expect("the ingest resolves a row key from the claim");
        // The window covers the whole `match claim.thread` block.
        let arms = &body[at..at + 900];
        assert!(
            arms.contains("db.bind_threaded_prompt_session(row_key,"),
            "the threaded arm still binds the guard key"
        );
        assert!(
            arms.contains("db.bind_launch_prompt_session(row_key,"),
            "the threadless arm still binds the guard key"
        );
        assert!(
            !arms.contains("bind_launch_prompt_session(&bh"),
            "a stale &bh bind is left in the ingest"
        );
    }

    /// `"combine"` must survive the origin filter, or every combination is
    /// filed in the lake as a drafter launch — `surface` feeds `resolve_parent`
    /// and the Companion's account of what you did.
    #[test]
    fn the_launch_origin_filter_accepts_combine() {
        let body = std::fs::read_to_string(file!()).expect("read own source");
        let f = body
            .split_once("fn record_plan_launch(")
            .expect("record_plan_launch exists")
            .1;
        let filter = f.split_once("unwrap_or_else").expect("origin filter").0;
        for origin in ["front-door", "drafter", "browser", "chat", "combine"] {
            assert!(
                filter.contains(&format!("\"{origin}\"")),
                "{origin} must be an accepted launch origin"
            );
        }
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
    fn restore_target_id_parses_embedded_session_id() {
        // Id-bearing sentinel → the held plan's session id (resume forks the id,
        // or the command was pasted into a running REPL).
        assert_eq!(
            restore_target_id("<!-- rl:blk-1 -->\n<!-- REDLINE_RESTORE:36c1d078-abc -->"),
            Some("36c1d078-abc".to_string())
        );
        // Whitespace inside the marker is tolerated.
        assert_eq!(
            restore_target_id("<!-- REDLINE_RESTORE:  s-9  -->"),
            Some("s-9".to_string())
        );
        // Bare sentinel → no target (same-session, in-place restore).
        assert_eq!(restore_target_id("<!-- REDLINE_RESTORE -->"), None);
        // Empty id and non-restore bodies → no target.
        assert_eq!(restore_target_id("<!-- REDLINE_RESTORE: -->"), None);
        assert_eq!(restore_target_id("# A real plan\n\nbody"), None);
    }

    #[test]
    fn restore_handshake_matches_only_sentinel_only_bodies() {
        // The handshake contract: the body IS the sentinel ("write exactly
        // `…` as your plan file's contents"). Both forms, whitespace-tolerant.
        assert_eq!(restore_handshake("<!-- REDLINE_RESTORE -->"), Some(None));
        assert_eq!(restore_handshake("  <!-- REDLINE_RESTORE -->\n"), Some(None));
        assert_eq!(
            restore_handshake("<!-- REDLINE_RESTORE:abc-123 -->"),
            Some(Some("abc-123".to_string()))
        );
        // Empty id degrades to the bare form, mirroring restore_target_id.
        assert_eq!(restore_handshake("<!-- REDLINE_RESTORE: -->"), Some(None));

        // A real plan that merely MENTIONS the sentinel — the bug this
        // anchoring exists to kill: a plan documenting the restore protocol
        // (quoting the sentinel in an evidence table) must be captured, not
        // classified as a handshake and waved through.
        assert_eq!(
            restore_handshake(
                "# Fix the restore path\n\nThe hook wrote `<!-- REDLINE_RESTORE -->` at 16:18:28.\n"
            ),
            None
        );
        assert_eq!(
            restore_handshake(
                "<!-- REDLINE_RESTORE:57b38664-9fa4-4b71-a5a2-fe88f70ac1b9 -->\n\n# Then a plan follows\n"
            ),
            None,
            "sentinel followed by real content is a plan, not a handshake"
        );
        // A different comment that shares the prefix is not the handshake.
        assert_eq!(restore_handshake("<!-- REDLINE_RESTOREX -->"), None);
        assert_eq!(restore_handshake("# A real plan\n\nbody"), None);
    }

    #[test]
    fn rekey_gate_accepts_provider_ids_but_rejects_path_like_input() {
        assert!(valid_session_id("57b38664-9fa4-4b71-a5a2-fe88f70ac1b9"));
        assert!(valid_session_id("thr_0199a213-81c0-7800-8aa1-bbab2a035a53"));
        assert!(valid_session_id("ABC_123"));
        assert!(!valid_session_id("../../etc/passwd"));
        assert!(!valid_session_id("contains spaces"));
        assert!(!valid_session_id(""));
        assert!(!valid_session_id(&"a".repeat(129)));
    }

    #[test]
    fn codex_plan_extraction_requires_one_complete_nonempty_block() {
        assert_eq!(
            extract_codex_proposed_plan("before\n<proposed_plan>\n# Build\n\nBody\n</proposed_plan>\nafter"),
            Some("# Build\n\nBody".to_string())
        );
        assert_eq!(extract_codex_proposed_plan("ordinary answer"), None);
        assert_eq!(extract_codex_proposed_plan("<proposed_plan> </proposed_plan>"), None);
        assert_eq!(extract_codex_proposed_plan("<proposed_plan># missing close"), None);
        assert_eq!(
            extract_codex_proposed_plan(
                "<proposed_plan># one</proposed_plan><proposed_plan># two</proposed_plan>"
            ),
            None
        );
    }

    #[test]
    fn captured_plan_registers_pending_entry_with_terminal() {
        // 0d: the capture→hold→indicator seam, end to end (steps 1→3→4 with
        // the terminal resolver injected; step 2's lsof/ps walk has its own
        // coverage). A plan that merely MENTIONS the restore sentinel takes
        // the capture path — restore_handshake says "not a handshake" — and
        // the hold it registers exposes its terminal to the summaries the
        // InterceptStrip reads.
        let body =
            "# A plan about restores\n\nQuoting `<!-- REDLINE_RESTORE:57b38664-9fa4-4b71-a5a2-fe88f70ac1b9 -->` as evidence.\n";
        assert_eq!(restore_handshake(body), None, "must be captured, not passed through");

        let store = make_store();
        let pending = PendingResponses::new();
        store.upsert_plan("s1", "/tmp/d", body.to_string(), reparse_sections(body), true, false);
        let (_rx, _token) = register_hold(&pending, "s1", Some("tab-a".to_string()));
        assert_eq!(pending.terminal_of("s1"), Some("tab-a".to_string()));

        let mut sessions = store.list();
        fold_pending_into_summaries(&mut sessions, &pending);
        let s = sessions.iter().find(|s| s.session_id == "s1").expect("summary");
        assert!(s.held, "captured plan must be held");
        assert_eq!(s.attach_state, AttachState::Held);
        assert_eq!(
            s.held_terminal_id.as_deref(),
            Some("tab-a"),
            "the strip's tab binding must survive the fold into summaries"
        );

        // A sentinel-only body is still a handshake (the restore path).
        assert!(restore_handshake("<!-- REDLINE_RESTORE -->").is_some());
    }

    #[test]
    fn boot_routes_to_a_held_session_and_only_a_held_one() {
        // The one carve-out to "boot lands on the front door". The pick comes
        // from the same folded list the shell renders, so it can never name a
        // session the sidebar doesn't have.
        let store = make_store();
        let pending = PendingResponses::new();
        let md = "# Plan\n\nBody.\n";
        for id in ["idle-a", "held-b", "idle-c"] {
            store.upsert_plan(id, "/tmp/d", md.to_string(), reparse_sections(md), true, false);
        }
        let mut sessions = store.list();
        fold_pending_into_summaries(&mut sessions, &pending);
        assert_eq!(
            held_session_id(&sessions),
            None,
            "nothing held: boot belongs to the front door"
        );

        // A live held POST is ground truth, even before the persisted state
        // catches up — which is exactly why the fold runs first.
        let (_rx, _token) = register_hold(&pending, "held-b", Some("tab-a".to_string()));
        let mut sessions = store.list();
        fold_pending_into_summaries(&mut sessions, &pending);
        let picked = held_session_id(&sessions).expect("held session claims the plate");
        assert_eq!(picked, "held-b");
        assert!(
            sessions.iter().any(|s| s.session_id == picked),
            "boot routed to a session that is not in the list it routes within"
        );
    }

    #[test]
    fn register_hold_supersedes_a_stale_held_post() {
        // The orphan fix moved into register_hold: a second POST for the same
        // session releases the stale waiter cleanly, then takes over.
        let pending = PendingResponses::new();
        let (rx1, _t1) = register_hold(&pending, "s1", None);
        let (_rx2, _t2) = register_hold(&pending, "s1", Some("tab-b".to_string()));
        let stale = rx1.blocking_recv().expect("stale waiter must be answered");
        assert_eq!(stale.hook_specific_output.permission_decision, "allow");
        assert_eq!(pending.terminal_of("s1"), Some("tab-b".to_string()));
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

    #[test]
    fn orchestrate_plan_inner_denies_with_stand_down_and_approves() {
        let store = make_store();
        let pending = PendingResponses::new();
        let expected_modes = ExpectedModes::new();
        let md = "# Plan\n\nBody.\n";
        store.upsert_plan("s1", "/tmp/d", md.to_string(), reparse_sections(md), true, false);
        let (rx, _token) = pending.register("s1", None).expect("register");
        expected_modes.set("s1", SubmissionMode::Ask);

        orchestrate_plan_inner(&store, &pending, &expected_modes, "s1")
            .expect("orchestrate with a held sender must succeed");

        // The held ExitPlanMode got a DENY carrying the stand-down text — the
        // session was launched in plan mode, so a deny keeps it read-only.
        let resp = rx.blocking_recv().expect("oneshot must have been sent");
        assert_eq!(resp.hook_specific_output.permission_decision, "deny");
        assert_eq!(
            resp.hook_specific_output.permission_decision_reason,
            ORCHESTRATE_STAND_DOWN
        );
        // Redline-side state matches a plain Approve.
        let session = store.get("s1").expect("session exists");
        assert_eq!(session.status, SessionStatus::Approved);
        assert_eq!(session.attach_state, AttachState::Idle);
        // The in-flight Ask mode was drained like approve_plan drains it.
        assert!(expected_modes.take("s1").is_none());
        // The pending slot is consumed — no double-fire window.
        assert!(pending.take("s1").is_none());
    }

    #[test]
    fn orchestrate_plan_inner_errs_without_held_sender() {
        let store = make_store();
        let pending = PendingResponses::new();
        let expected_modes = ExpectedModes::new();
        let md = "# Plan\n\nBody.\n";
        store.upsert_plan("s1", "/tmp/d", md.to_string(), reparse_sections(md), true, false);

        let err = orchestrate_plan_inner(&store, &pending, &expected_modes, "s1")
            .expect_err("no held sender → Err (the command marks Detached)");
        assert!(err.contains("no plan"), "got: {err}");
    }

    #[test]
    fn orchestrate_stall_step_fires_only_on_orchestrating() {
        // Only a run that never produced a beacon past the click is stalled;
        // any later state (or no orchestration at all) retires the watchdog.
        assert!(orchestrate_stall_should_fire(Some("orchestrating")));
        for s in [
            None,
            Some("running"),
            Some("in_code_review"),
            Some("landed"),
            Some("stalled"),
        ] {
            assert!(!orchestrate_stall_should_fire(s), "must not fire on {s:?}");
        }
    }

    /// The launch watchdog covers `orchestrating` and nothing after it — a run
    /// that reached `running` and then went quiet for an hour had no backstop
    /// short of the abandoned-run sweep's full day.
    #[test]
    fn running_silence_stalls_only_a_quiet_unheld_running_run() {
        let window = RUNNING_SILENCE_WINDOW.as_millis() as i64;
        let quiet = window + 1;

        assert!(running_silence_should_stall(Some("running"), quiet, window, false, false));

        // Not past the window yet.
        assert!(!running_silence_should_stall(Some("running"), window, window, false, false));
        // The launch window is the other half's territory; terminal states and
        // the deliberate overnight park are nobody's.
        for state in [
            None,
            Some("orchestrating"),
            Some("in_code_review"),
            Some("awaiting_review"),
            Some("landed"),
            Some("stalled"),
        ] {
            assert!(
                !running_silence_should_stall(state, quiet, window, false, false),
                "must not fire on {state:?}"
            );
        }
        // Quiet BECAUSE a human is holding it is not stalled — saying so would
        // be a lie the user has to undo.
        assert!(!running_silence_should_stall(Some("running"), quiet, window, true, false));
        assert!(!running_silence_should_stall(Some("running"), quiet, window, false, true));
    }

    /// P0 (overnight queue): a queued run parks at `awaiting_review`, and the
    /// morning approve walks it to `landed` through the EXISTING verdict
    /// mapping — `set_run_state` enforces no ordering, but this pins it.
    #[test]
    fn awaiting_review_parks_and_approve_walks_to_landed() {
        // Deliberately NOT live: no watcher wakes for a parked run.
        assert!(!runwatch::is_live_run_state(Some("awaiting_review")));
        // The verdict mapping is state-free: approve → landed.
        assert_eq!(review_verdict_run_state(true), "landed");
        assert_eq!(review_verdict_run_state(false), "running");
        let store = make_store();
        let md = "# Plan\n\nBody.\n";
        store.upsert_plan("s1", "/tmp/d", md.to_string(), reparse_sections(md), true, false);
        // The park (queued run ended, review deferred)…
        assert!(store.set_run_state("s1", "awaiting_review"));
        assert_eq!(
            store.database().get_run_state("s1").as_deref(),
            Some("awaiting_review")
        );
        // …and the morning approve, via the same mapping a held review uses.
        assert!(store.set_run_state("s1", review_verdict_run_state(true)));
        assert_eq!(store.database().get_run_state("s1").as_deref(), Some("landed"));
    }

    /// The parked (no-held-curl) verdict seam behind `submit_review_feedback`:
    /// the landed-walk + unresolved-annotation filing happen ONLY on an
    /// approve of a linked, still-awaiting review; a feedback verdict holds
    /// the park; a missing link or a walked-on chip rejects outright.
    #[test]
    fn parked_verdict_lands_only_on_approve() {
        use ParkedVerdict::*;
        assert_eq!(parked_verdict(true, Some("awaiting_review"), true), Land);
        assert_eq!(parked_verdict(true, Some("awaiting_review"), false), Hold);
        // No durable review→plan link (the destroyed-state failure): reject
        // regardless of the verdict.
        assert_eq!(parked_verdict(false, Some("awaiting_review"), true), NotParked);
        assert_eq!(parked_verdict(false, Some("awaiting_review"), false), NotParked);
        // A chip that already walked on (or never parked) is not a parked
        // review — approve must not re-land it, feedback must not hold it.
        for rs in [Some("landed"), Some("running"), Some("stalled"), None] {
            assert_eq!(parked_verdict(true, rs, true), NotParked, "run_state {rs:?}");
            assert_eq!(parked_verdict(true, rs, false), NotParked, "run_state {rs:?}");
        }

        // Driven against a seeded awaiting_review session: only the Land
        // verdict walks the chip; Hold leaves the park standing.
        let store = make_store();
        let md = "# Plan\n\nBody.\n";
        store.upsert_plan("s1", "/tmp/d", md.to_string(), reparse_sections(md), true, false);
        assert!(store.set_run_state("s1", "awaiting_review"));
        let verdict_for = |approve: bool| {
            parked_verdict(
                true,
                store.database().get_run_state("s1").as_deref(),
                approve,
            )
        };
        // Feedback first: the park holds, nothing walks.
        assert_eq!(verdict_for(false), Hold);
        assert_eq!(
            store.database().get_run_state("s1").as_deref(),
            Some("awaiting_review")
        );
        // Approve: Land → the chip resolves awaiting_review → landed.
        assert_eq!(verdict_for(true), Land);
        assert!(store.set_run_state("s1", review_verdict_run_state(true)));
        assert_eq!(store.database().get_run_state("s1").as_deref(), Some("landed"));
        // And a re-submit against the landed chip is no longer parked.
        assert_eq!(verdict_for(true), NotParked);
    }

    #[test]
    fn store_run_state_transitions_update_memory_and_db() {
        let store = make_store();
        let md = "# Plan\n\nBody.\n";
        store.upsert_plan("s1", "/tmp/d", md.to_string(), reparse_sections(md), true, false);

        assert!(store.set_run_state("s1", "orchestrating"));
        assert!(
            !store.set_run_state("s1", "orchestrating"),
            "same value → no transition (no event, no journal)"
        );
        assert!(store.set_run_state("s1", "running"));
        // Both the in-memory summary (the chip's source) and the DB agree.
        let summary = store.list().into_iter().find(|s| s.session_id == "s1").unwrap();
        assert_eq!(summary.run_state.as_deref(), Some("running"));
        assert_eq!(store.database().get_run_state("s1").as_deref(), Some("running"));
        // Unknown session: quietly false.
        assert!(!store.set_run_state("ghost", "running"));
        // One journal line per REAL transition.
        let journal = store.database().list_journal_since(0, 100).unwrap();
        let n = journal.iter().filter(|r| r.kind == "run_state").count();
        assert_eq!(n, 2);
    }

    #[test]
    fn plan_runs_report_resolve_get_round_trip() {
        let store = make_store();
        let db = store.database();
        assert!(db.get_plan_run("s1").is_none());
        assert!(
            !db.resolve_plan_run("s1", "resolved", None).unwrap(),
            "no report row → nothing to resolve"
        );

        db.upsert_plan_run("s1", r#"{"summary":"x"}"#, Some("/tmp/wf.js"), true)
            .unwrap();
        let run = db.get_plan_run("s1").unwrap();
        assert!(run.workflow_ran);
        assert_eq!(run.script_path.as_deref(), Some("/tmp/wf.js"));
        assert!(run.resolution.is_none());

        assert!(db
            .resolve_plan_run("s1", "needs_follow_up", Some("check X"))
            .unwrap());
        let run = db.get_plan_run("s1").unwrap();
        assert_eq!(run.resolution.as_deref(), Some("needs_follow_up"));
        assert_eq!(run.resolution_note.as_deref(), Some("check X"));
        assert!(run.resolved_at.is_some());

        // A re-run's fresh report reopens the human verdict.
        db.upsert_plan_run("s1", r#"{"summary":"y"}"#, None, false).unwrap();
        let run = db.get_plan_run("s1").unwrap();
        assert!(!run.workflow_ran);
        assert!(run.script_path.is_none());
        assert!(run.resolution.is_none(), "re-report resets the resolution");
    }

    #[test]
    fn orchestrations_anchor_discovery_round_trip() {
        let store = make_store();
        let db = store.database();
        assert!(db.get_orchestration("s1").is_none());
        // Discovery before an anchor is a no-op, not an insert.
        db.update_orchestration_discovery("s1", Some("wf_x"), None, None, None)
            .unwrap();
        assert!(db.get_orchestration("s1").is_none());

        db.upsert_orchestration("s1", "claude-1", "/t/p1.jsonl", Some("/proj"), Some("tab-1"))
            .unwrap();
        let row = db.get_orchestration("s1").unwrap();
        assert_eq!(row.claude_session_id, "claude-1");
        assert_eq!(row.transcript_path, "/t/p1.jsonl");
        assert_eq!(row.terminal_id.as_deref(), Some("tab-1"));
        assert!(row.run_id.is_none());

        db.update_orchestration_discovery("s1", Some("wf_a"), Some("/t/p1/wf"), None, Some("sequential"))
            .unwrap();
        // Partial update: passed values win (the sequential→workflow mode
        // upgrade), omitted columns keep what was discovered.
        db.update_orchestration_discovery("s1", None, None, Some("/t/s.js"), Some("workflow"))
            .unwrap();
        let row = db.get_orchestration("s1").unwrap();
        assert_eq!(row.run_id.as_deref(), Some("wf_a"));
        assert_eq!(row.transcript_dir.as_deref(), Some("/t/p1/wf"));
        assert_eq!(row.script_path.as_deref(), Some("/t/s.js"));
        assert_eq!(row.mode.as_deref(), Some("workflow"));

        // Re-run: the anchor overwrites and discovery resets — but a re-run
        // with no fresh terminal keeps the launch tab it already knew.
        db.upsert_orchestration("s1", "claude-2", "/t/p2.jsonl", None, None).unwrap();
        let row = db.get_orchestration("s1").unwrap();
        assert_eq!(row.claude_session_id, "claude-2");
        assert!(row.run_id.is_none(), "re-run resets discovery");
        assert!(row.mode.is_none());
        assert_eq!(
            row.terminal_id.as_deref(),
            Some("tab-1"),
            "an omitted terminal must not wipe the recorded launch tab"
        );

        db.upsert_orchestration("s0", "claude-0", "/t/p0.jsonl", None, None).unwrap();
        let rows = db.list_orchestrations().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].plan_session_id, "s0", "newest launch first");
    }

    #[test]
    fn clear_run_state_nulls_columns_and_journals() {
        let store = make_store();
        let md = "# Plan\n\nBody.\n";
        store.upsert_plan("s1", "/tmp/d", md.to_string(), reparse_sections(md), true, false);
        let db = store.database();

        assert!(store.set_run_state("s1", "orchestrating"));
        assert_eq!(db.get_run_state("s1").as_deref(), Some("orchestrating"));

        assert!(store.clear_run_state("s1"), "a set state must clear");
        assert_eq!(db.get_run_state("s1"), None, "run_state back to NULL");
        assert!(!store.clear_run_state("s1"), "clearing NULL is a no-op");
        // The in-memory mirror follows the DB.
        assert!(store.get("s1").unwrap().run_state.is_none());
        // Journalled as `run_state: cleared` so the Companion feed sees it.
        let journal = db.list_journal_since(0, 100).unwrap();
        assert!(
            journal.iter().any(|e| e.kind == "run_state" && e.label.as_deref() == Some("cleared")),
            "clear must journal"
        );
        // `set_run_state` after a clear works normally (NULL → value).
        assert!(store.set_run_state("s1", "orchestrating"));
        assert_eq!(db.get_run_state("s1").as_deref(), Some("orchestrating"));
    }

    #[test]
    fn reset_run_rows_is_idempotent_and_safe_on_a_session_that_never_ran() {
        let store = make_store();
        let md = "# Plan\n\nBody.\n";
        store.upsert_plan("s1", "/tmp/d", md.to_string(), reparse_sections(md), true, false);
        let db = store.database();

        // Never ran: nothing to delete, nothing to clear — must not panic.
        reset_run_rows(&store, "s1");
        assert_eq!(db.get_run_state("s1"), None);

        // A full run's traces all go.
        store.set_run_state("s1", "running");
        db.upsert_orchestration("s1", "claude-1", "/t/p.jsonl", None, Some("tab-1"))
            .unwrap();
        db.upsert_plan_run("s1", r#"{"summary":"x"}"#, None, true).unwrap();
        orchestration_review_links()
            .lock()
            .unwrap()
            .insert("rev-test-reset".to_string(), "s1".to_string());

        reset_run_rows(&store, "s1");
        assert_eq!(db.get_run_state("s1"), None);
        assert!(db.get_orchestration("s1").is_none());
        assert!(db.get_plan_run("s1").is_none());
        assert!(
            !orchestration_review_links().lock().unwrap().values().any(|v| v == "s1"),
            "the stale review link must be evicted"
        );
        // Twice in a row is fine.
        reset_run_rows(&store, "s1");
    }

    #[test]
    fn unapprove_plan_supersedes_the_approval_and_keeps_the_chain_intact() {
        let store = make_store();
        let md = "# Plan\n\nBody.\n";
        store.upsert_plan("s1", "/tmp/d", md.to_string(), reparse_sections(md), true, false);
        let db = store.database();

        // Not approved yet → refused.
        assert!(unapprove_plan_inner(&store, "s1").is_err());

        store.set_status("s1", SessionStatus::Approved);
        let approval_seq = db.latest_approval_seq("s1").expect("approval event recorded");

        unapprove_plan_inner(&store, "s1").expect("un-approve an approved session");
        let s = store.get("s1").unwrap();
        assert_eq!(s.status, SessionStatus::InReview);
        assert_eq!(s.attach_state, AttachState::Detached, "never fake Held");

        // The reversal is a supersession, never a delete: the approval event
        // is still in the chain, now superseded by the reopen decision.
        let map = db.supersessions_for_seqs(&[approval_seq]).unwrap();
        let new_seq = *map.get(&approval_seq).expect("approval must be superseded");
        assert!(new_seq > approval_seq);
        let verdict = db.verify_ledger_chain().unwrap();
        assert!(
            verdict.ok,
            "the hash chain must still verify after the rescission (first bad: {:?})",
            verdict.first_bad_seq
        );

        // Double un-approve: no longer approved → refused, and nothing broke.
        assert!(unapprove_plan_inner(&store, "s1").is_err());
    }

    #[test]
    fn orchestrator_parent_session_only_matches_the_orchestrate_lineage() {
        // A7's gate: `session → session` links are written exclusively by the
        // Orchestrate ingest claim, so their presence IS "this is an
        // orchestrator" — and nothing else may trip it.
        let store = make_store();
        let db = store.database();
        db.insert_session_link("session", "orch-1", "session", "plan-1", 1)
            .unwrap();
        db.insert_session_link("session", "drafted-1", "drafter", "d-1", 2)
            .unwrap();
        db.insert_session_link("voice", "plan-2", "session", "plan-2", 3)
            .unwrap();
        assert_eq!(
            db.orchestrator_parent_session("orch-1").as_deref(),
            Some("plan-1")
        );
        assert_eq!(db.orchestrator_parent_session("drafted-1"), None);
        assert_eq!(db.orchestrator_parent_session("plan-2"), None);
        assert_eq!(db.orchestrator_parent_session("unknown"), None);
    }

    #[test]
    fn orchestration_report_body_parses_and_validates() {
        let v = serde_json::json!({
            "planSessionId": "s1",
            "scriptPath": "/Users/me/.claude/projects/x/wf.js",
            "workflowRan": true,
            "summary": "done",
            "subtasks": [
                {"title": "t", "planSection": "A1", "verified": true, "skipped": false, "notes": ""}
            ]
        });
        let b = parse_orchestration_report(&v).unwrap();
        assert_eq!(b.plan_session_id, "s1");
        assert!(b.workflow_ran);
        assert_eq!(b.subtasks.len(), 1);

        // Only planSessionId is required; everything else defaults.
        let b = parse_orchestration_report(&serde_json::json!({"planSessionId": "s2"})).unwrap();
        assert!(!b.workflow_ran);
        assert!(b.script_path.is_none());
        assert!(b.subtasks.is_empty());

        assert!(parse_orchestration_report(&serde_json::json!({"planSessionId": "  "})).is_err());
        assert!(parse_orchestration_report(&serde_json::json!({})).is_err());
    }

    /// Producers wave: undelivered subtasks survive the exit report as open
    /// work items — tolerant parse, plan_run provenance, idempotent re-POST,
    /// orchestrator seat credit.
    #[test]
    fn exit_report_files_undelivered_subtasks_as_work_items() {
        let db = db::Database::open_in_memory().unwrap();
        let subtasks = vec![
            // Delivered — never files.
            serde_json::json!({"title": "done one", "verified": true, "skipped": false}),
            // Unverified — files, notes ride the body.
            serde_json::json!({"title": "flaky one", "verified": false, "skipped": false,
                               "planSection": "B2", "notes": "verify step timed out"}),
            // Skipped — files.
            serde_json::json!({"title": "skipped one", "verified": true, "skipped": true}),
            // Tolerance: no title / no flags / non-object → all skipped quietly.
            serde_json::json!({"verified": false}),
            serde_json::json!({"title": "shapeless"}),
            serde_json::json!("not an object"),
        ];
        let filed = file_exit_report_items(&db, "plan-9", &subtasks, Some("/tmp/proj"));
        assert_eq!(filed, 2);
        let items = db.list_work_items(None, None, 50).unwrap();
        assert_eq!(items.len(), 2);
        for item in &items {
            assert_eq!(item.origin_kind.as_deref(), Some("plan_run"));
            assert_eq!(item.origin_id.as_deref(), Some("plan-9"));
            assert_eq!(item.project_path.as_deref(), Some("/tmp/proj"));
            assert_eq!(item.kind, "task");
            assert_eq!(item.status, "open");
        }
        let flaky = items.iter().find(|i| i.title == "flaky one").unwrap();
        let body = flaky.body.as_deref().unwrap();
        assert!(body.contains("NOT verified"));
        assert!(body.contains("Plan section: B2"));
        assert!(body.contains("verify step timed out"));
        assert!(items.iter().any(|i| i.title == "skipped one"));
        // The orchestrator seat's items_filed became real…
        assert_eq!(db.get_seat_stat("orchestrator").unwrap().items_filed, 2);
        // …and a re-POSTed report files nothing new (idempotent).
        assert_eq!(
            file_exit_report_items(&db, "plan-9", &subtasks, Some("/tmp/proj")),
            0
        );
        assert_eq!(db.list_work_items(None, None, 50).unwrap().len(), 2);
        assert_eq!(db.get_seat_stat("orchestrator").unwrap().items_filed, 2);
        assert!(db.verify_ledger_chain().unwrap().ok, "chain intact");
    }

    #[test]
    fn orchestrate_stand_down_reads_calm_and_forbids_reexecution() {
        // The deny reason renders inside Claude Code's red Error box — it must
        // lead with the defusing ✅ and carry the three prohibitions.
        assert!(ORCHESTRATE_STAND_DOWN.starts_with("✅"));
        for needle in ["Do NOT implement", "do not revise", "ExitPlanMode"] {
            assert!(
                ORCHESTRATE_STAND_DOWN.contains(needle),
                "stand-down text is missing `{needle}`"
            );
        }
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
    fn revise_watch_generation_detects_supersession() {
        let watch = ReviseWatch::new();
        // No revise yet → generation reads 0.
        assert_eq!(watch.current("s1"), 0);

        // First revise: a watchdog armed under gen 1 still owns the wait.
        let armed_first = watch.bump("s1");
        assert_eq!(armed_first, 1);
        assert_eq!(watch.current("s1"), armed_first);

        // A second revise bumps the generation; the first watchdog must now see
        // itself superseded and bail, while the second one owns the wait.
        let armed_second = watch.bump("s1");
        assert_eq!(armed_second, 2);
        assert_ne!(watch.current("s1"), armed_first);
        assert_eq!(watch.current("s1"), armed_second);

        // Counters are per-session — an unrelated session is unaffected.
        assert_eq!(watch.current("s2"), 0);
        assert_eq!(watch.bump("s2"), 1);
        assert_eq!(watch.current("s1"), 2);
    }

    #[test]
    fn last_claude_pid_set_get_clear() {
        let map = LastClaudePid::default();
        assert!(map.get("s1").is_none(), "absent session reads None");

        map.set(
            "s1",
            ClaudeProc {
                pid: 1234,
                comm: "claude".into(),
            },
        );
        let got = map.get("s1").expect("present after set");
        assert_eq!(got.pid, 1234);
        assert_eq!(got.comm, "claude");

        // Overwrite replaces the prior record (refreshed on every POST).
        map.set(
            "s1",
            ClaudeProc {
                pid: 5678,
                comm: "node".into(),
            },
        );
        assert_eq!(map.get("s1").unwrap().pid, 5678);

        map.clear("s1");
        assert!(map.get("s1").is_none(), "cleared session reads None");
    }

    #[test]
    fn claude_proc_is_alive_guards_pid_reuse() {
        let proc = ClaudeProc {
            pid: 4242,
            comm: "claude".into(),
        };
        // Same pid, same command → alive.
        assert!(proc.is_alive_with(|_| Some("claude".to_string())));
        // No such process → dead.
        assert!(!proc.is_alive_with(|_| None));
        // Pid reused by a different command → dead (must not read as alive).
        assert!(!proc.is_alive_with(|_| Some("zsh".to_string())));
    }

    #[cfg(unix)]
    #[test]
    fn current_comm_reflects_process_liveness() {
        // Our own pid is obviously alive and names a non-empty command.
        let mine = current_comm(std::process::id());
        assert!(mine.is_some_and(|c| !c.is_empty()), "self must be alive");

        // A child we spawn and reap is dead by the time we probe its pid.
        let mut child = std::process::Command::new("true")
            .spawn()
            .expect("spawn `true`");
        let dead_pid = child.id();
        child.wait().expect("reap child");
        assert!(
            current_comm(dead_pid).is_none(),
            "a reaped process must read as dead"
        );
    }

    #[test]
    fn watchdog_step_decision_table() {
        // Any "already settled" signal stops the watchdog regardless of liveness.
        assert_eq!(
            watchdog_step(true, true, true, Some(true)),
            WatchdogStep::Stop,
            "a fresh plan landed → stop"
        );
        assert_eq!(
            watchdog_step(false, false, true, Some(true)),
            WatchdogStep::Stop,
            "a newer revise superseded us → stop"
        );
        assert_eq!(
            watchdog_step(false, true, false, Some(true)),
            WatchdogStep::Stop,
            "no longer in review → stop"
        );
        // Still waiting + claude alive → re-arm (the false-positive we fix).
        assert_eq!(
            watchdog_step(false, true, true, Some(true)),
            WatchdogStep::ReArm,
            "alive claude (busy/blocked) → keep watching, never detach"
        );
        // Still waiting + claude dead → detach.
        assert_eq!(
            watchdog_step(false, true, true, Some(false)),
            WatchdogStep::Detach,
            "dead claude → feedback lost, detach"
        );
        // Still waiting + pid never captured → fall back to blind-timer detach.
        assert_eq!(
            watchdog_step(false, true, true, None),
            WatchdogStep::Detach,
            "no pid → preserve today's behavior, detach"
        );
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
    fn inbound_plan_resets_stale_approved_status() {
        // The same-terminal-session repro: a thread is reviewed and approved,
        // then a fresh plan reuses the session. Without the status reset the
        // session stays `approved` forever and the frontend's
        // `status !== "approved"` gate disables the Approve button for every
        // later thread.
        use crate::state::{CommentKind, SessionStatus};
        let store = make_store();
        let md = "# Plan\n\nBody.\n";
        store.upsert_plan("s1", "/tmp/d", md.to_string(), reparse_sections(md), true, false);
        // A submitted comment from the approved thread must not leak into the
        // next plan's classification once the session is approved.
        store
            .add_comment(
                "s1",
                NewCommentRequest {
                id: None,
                    kind: CommentKind::Feedback,
                    scope: None,
                    anchor_id: "A".to_string(),
                    block_id: Some("rl:blk-1".to_string()),
                    structural: None,
                    body: "tighten this".to_string(),
                    edit: None,
                    selection: None,
                    author: None,
                    reviewer: None,
                    external_created_at: None,
                    share_request_id: None,
                    attachments: Vec::new(),
                },
            )
            .unwrap();
        store.mark_submitted("s1");
        store.set_status("s1", SessionStatus::Approved);

        // Classification reads the OLD status: an approved session has no
        // outstanding review, so the next plan starts a fresh thread.
        assert!(
            !store.has_outstanding_review("s1"),
            "approved session must classify the next plan as thread_start"
        );

        // The fresh plan arrives — upsert alone must not touch status...
        store.upsert_plan("s1", "/tmp/d", md.to_string(), reparse_sections(md), true, false);
        assert_eq!(store.get("s1").unwrap().status, SessionStatus::Approved);
        // ...the settle step (what handle_plan runs before emitting) does.
        settle_inbound_plan_state(&store, "s1");

        let s = store.get("s1").expect("session");
        assert_eq!(s.status, SessionStatus::InReview);
        assert_eq!(s.attach_state, AttachState::Held);
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

    // --- Layer 1: out-of-band feedback delivery -------------------------------

    #[test]
    fn pending_feedback_set_get_clear_roundtrip() {
        let pf = PendingFeedback::new();
        assert!(pf.get("s1").is_none(), "empty store has nothing pending");
        pf.set("s1", "FULL PAYLOAD".to_string());
        // Idempotent: a duplicate/late curl re-reads the same bytes.
        assert_eq!(pf.get("s1").as_deref(), Some("FULL PAYLOAD"));
        assert_eq!(pf.get("s1").as_deref(), Some("FULL PAYLOAD"));
        // A second submit overwrites, never appends.
        pf.set("s1", "NEWER".to_string());
        assert_eq!(pf.get("s1").as_deref(), Some("NEWER"));
        // Sessions are isolated.
        assert!(pf.get("s2").is_none());
        pf.clear("s1");
        assert!(pf.get("s1").is_none(), "clear (rollback path) removes it");
    }

    /// A stand-in for a real review payload — the bytes the golden suites pin.
    const PAYLOAD: &str = "FEEDBACK:\n[edit, local] c-001\n\nCURRENT PLAN\n# Plan\n";

    #[test]
    fn feedback_deny_reason_is_calm_one_liner_with_fetch_url() {
        let revise = feedback_deny_reason(SubmissionMode::Revise, "abc-123", "claude-code", PAYLOAD);
        // The defusing words lead so the unavoidable `Error:` prefix reads benign.
        assert!(revise.starts_with("✅ Plan returned to Redline for revision"));
        assert!(revise.contains("nothing"), "must reassure nothing failed");
        // Points at the out-of-band channel with the real session id.
        assert!(revise.contains(
            "curl -s http://127.0.0.1:7676/v1/sessions/abc-123/feedback"
        ));
        // Single logical line — no bulky body inlined (that's the whole point).
        assert!(!revise.contains("FEEDBACK:"));
        assert!(!revise.contains("CURRENT PLAN"));
        assert!(!revise.contains('\n'), "reason must be one line, got: {revise}");
        // Both arms name the skill — the deny reason is one of the two places
        // the plan session ever hears the contract exists.
        assert!(revise.contains("redline-plan-review"));

        let ask = feedback_deny_reason(SubmissionMode::Ask, "abc-123", "claude-code", PAYLOAD);
        // Ask keeps its load-bearing "do not change the plan body" contract.
        assert!(ask.contains("NOT"));
        assert!(ask.contains("unchanged"));
        assert!(ask.contains(
            "curl -s http://127.0.0.1:7676/v1/sessions/abc-123/feedback"
        ));
        assert!(!ask.contains('\n'), "reason must be one line, got: {ask}");
        assert!(ask.contains("redline-plan-review"));
    }

    #[test]
    fn the_codex_deny_reason_inlines_the_review_it_could_never_fetch() {
        // A codex plan session runs under `-s read-only`; a command the model
        // runs in that sandbox cannot reach 127.0.0.1 at all. Handing it a URL
        // would stall the round-trip with the feedback sitting one hop away.
        for mode in [SubmissionMode::Revise, SubmissionMode::Ask] {
            let reason = feedback_deny_reason(mode, "abc-123", "codex", PAYLOAD);
            assert!(reason.starts_with("✅"), "must still lead defusing");
            assert!(!reason.contains("curl"), "got: {reason}");
            assert!(!reason.contains("127.0.0.1"), "got: {reason}");
            // The payload itself, byte-for-byte, is the delivery.
            assert!(reason.ends_with(PAYLOAD), "got: {reason}");
            // …and it must name the submission shape codex actually has.
            assert!(reason.contains("<proposed_plan>"), "got: {reason}");
            assert!(!reason.contains("ExitPlanMode"), "got: {reason}");
        }
        let revise = feedback_deny_reason(SubmissionMode::Revise, "abc-123", "codex", PAYLOAD);
        // The two halves whose absence is silent.
        assert!(revise.contains("rl:blk-"));
        assert!(revise.contains("REDLINE_RESOLUTIONS"));
        // Ask keeps its load-bearing "do not change the plan body" contract.
        let ask = feedback_deny_reason(SubmissionMode::Ask, "abc-123", "codex", PAYLOAD);
        assert!(ask.contains("NOT"));
        assert!(ask.contains("unchanged"));
    }

    #[test]
    fn the_claude_deny_reason_still_inlines_nothing() {
        // The whole point of the out-of-band channel: a wall of text in an
        // `Error:` box is the failure this replaced.
        for mode in [SubmissionMode::Revise, SubmissionMode::Ask] {
            let reason = feedback_deny_reason(mode, "abc-123", "claude-code", PAYLOAD);
            assert!(!reason.contains("CURRENT PLAN"), "got: {reason}");
            assert!(!reason.contains("FEEDBACK:"), "got: {reason}");
        }
    }

    #[test]
    fn codex_stop_gates_on_the_block_not_the_mode() {
        // A Redline-launched codex runs in `default` mode with the contract
        // injected — no CLI flag starts the TUI in native Plan Mode — so a
        // permission_mode gate would reject every plan this app launches.
        let one = "here you go\n<proposed_plan>\n# Plan\n\nBody.\n</proposed_plan>";
        assert_eq!(
            extract_codex_proposed_plan(one).as_deref(),
            Some("# Plan\n\nBody.")
        );
        // …while the strictness that makes the relaxed gate safe still holds.
        assert!(extract_codex_proposed_plan("no block here").is_none());
        assert!(
            extract_codex_proposed_plan("I will emit a <proposed_plan> block soon").is_none(),
            "prose that merely names the marker must never be captured"
        );
        assert!(
            extract_codex_proposed_plan(
                "<proposed_plan>a</proposed_plan><proposed_plan>b</proposed_plan>"
            )
            .is_none(),
            "two blocks are ambiguous, not a plan"
        );
        assert!(extract_codex_proposed_plan("<proposed_plan>   </proposed_plan>").is_none());
    }

    // --- T4.1: the orchestrate -> review link survives a restart ------------

    /// The in-memory link map is this boot's fast path and dies with the
    /// process. A live orchestrated review outlives a restart (the human comes
    /// back to it in the morning), and before the durable mirror its verdict
    /// landed on nothing: `advance_run_state` was never called and the run's
    /// chip sat in `in_code_review` forever. The live DB has exactly one such
    /// session, stuck 18+ days.
    #[test]
    fn review_link_survives_link_map_loss() {
        let db = Database::open_in_memory().unwrap();
        let review_id = "rev-t41";
        let plan_sid = "plan-t41";

        register_orchestration_review_link(&db, review_id, plan_sid);
        assert_eq!(
            orchestration_review_link(&db, review_id).as_deref(),
            Some(plan_sid),
            "the map serves the link while the process lives"
        );

        // The restart: the process-global map is gone, the DB is not.
        orchestration_review_links()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(review_id);
        assert_eq!(
            orchestration_review_link(&db, review_id).as_deref(),
            Some(plan_sid),
            "the durable mirror is what makes the morning verdict land"
        );

        // A review that was never orchestrated still resolves to nothing —
        // the fallback must not invent a link.
        assert_eq!(orchestration_review_link(&db, "rev-unknown"), None);
    }

    // --- T4.2: landing a run closes the work it opened ----------------------

    /// `work_items` carried 595 rows and had never closed one — every close
    /// path existed, none was reached from a transition. Landing is the
    /// transition that means "done"; nothing else is.
    #[test]
    fn landing_a_run_closes_its_sessions_open_items() {
        use crate::work::WorkItem;
        let db = Database::open_in_memory().unwrap();
        let item = |id: &str, origin_kind: &str, origin_id: &str, status: &str| WorkItem {
            id: id.to_string(),
            title: format!("item {id}"),
            body: None,
            status: status.to_string(),
            priority: 2,
            kind: "task".to_string(),
            assignee: None,
            claimed_at: None,
            lease_expires_at: None,
            closed_at: None,
            close_reason: None,
            defer_until: None,
            origin_kind: Some(origin_kind.to_string()),
            origin_id: Some(origin_id.to_string()),
            project_path: Some("/repo".to_string()),
            pinned: false,
            created_at: 1,
            updated_at: 1,
        };
        // Two open items this session opened…
        db.insert_work_item(&item("w-1", "session", "s1", "open")).unwrap();
        db.insert_work_item(&item("w-2", "session", "s1", "open")).unwrap();
        // …one already closed (must not be re-stamped)…
        db.insert_work_item(&item("w-3", "session", "s1", "closed")).unwrap();
        // …the exit-report residue, which is exactly the UNDELIVERED work…
        db.insert_work_item(&item("w-4", "plan_run", "s1", "open")).unwrap();
        // …and another session's work.
        db.insert_work_item(&item("w-5", "session", "s2", "open")).unwrap();

        // Only `landed` retires work.
        assert!(run_state_closes_work("landed"));
        for s in ["running", "in_code_review", "awaiting_review", "stalled", "orchestrating"] {
            assert!(!run_state_closes_work(s), "{s} must not close work");
        }

        let mut moved = close_run_work_items(&db, "s1");
        moved.sort();
        assert_eq!(moved, vec!["w-1".to_string(), "w-2".to_string()]);

        let status = |id: &str| db.get_work_item(id).expect("row").status;
        assert_eq!(status("w-1"), "closed");
        assert_eq!(status("w-2"), "closed");
        assert_eq!(
            db.get_work_item("w-1").unwrap().close_reason.as_deref(),
            Some("landed"),
            "the reason names the transition that closed it"
        );
        assert_eq!(
            status("w-4"),
            "open",
            "exit-report residue IS the undelivered work — landing is not evidence it got done"
        );
        assert_eq!(status("w-5"), "open", "another session's work is untouched");

        // The already-closed row keeps its original stamp.
        assert_eq!(db.get_work_item("w-3").unwrap().close_reason, None);

        // Idempotent: landing twice moves nothing the second time.
        assert!(close_run_work_items(&db, "s1").is_empty());
    }

    // --- T4.3: the abandoned-run sweep --------------------------------------

    /// The decision table, in the shape of `watchdog_step_decision_table`.
    /// Every clause is a veto, because the cost of a false positive is a chip
    /// that lies to the user about a run that is actually fine.
    #[test]
    fn abandoned_run_decision_table() {
        let window = ABANDONED_RUN_WINDOW.as_millis() as i64;
        let day = window + 1;

        // The shape the sweep exists for: a run that claimed the work, or
        // opened a review, and then went silent for a day.
        assert!(
            abandoned_run_should_stall(Some("running"), day, window, false, false),
            "a silent `running` run is abandoned"
        );
        assert!(
            abandoned_run_should_stall(Some("in_code_review"), day, window, false, false),
            "a silent `in_code_review` run is abandoned"
        );

        // States the sweep must not touch.
        for state in [
            // the 5-minute launch watchdog's territory
            Some("orchestrating"),
            // a deliberate overnight park
            Some("awaiting_review"),
            // already terminal
            Some("landed"),
            Some("stalled"),
            // never orchestrated at all
            None,
        ] {
            assert!(
                !abandoned_run_should_stall(state, day, window, false, false),
                "must not stall {state:?}"
            );
        }

        // Inside the window: not yet.
        assert!(!abandoned_run_should_stall(Some("running"), window, window, false, false));
        assert!(!abandoned_run_should_stall(Some("running"), 0, window, false, false));

        // The two vetoes: a human is demonstrably still holding it.
        assert!(
            !abandoned_run_should_stall(Some("running"), day, window, true, false),
            "a held plan POST means Claude is blocked waiting on the reviewer"
        );
        assert!(
            !abandoned_run_should_stall(Some("in_code_review"), day, window, false, true),
            "a held code review linked to this run is the opposite of abandoned"
        );
        assert!(
            !abandoned_run_should_stall(Some("running"), day, window, true, true),
            "both vetoes together still veto"
        );
    }

    /// `held_ids` is the sweep's evidence source; pin that it reports exactly
    /// the reviews holding a curl.
    #[test]
    fn pending_reviews_reports_its_held_ids() {
        let pending = PendingReviews::new();
        assert!(pending.held_ids().is_empty());
        let (_rx, _token) = pending.register("rev-1");
        assert_eq!(pending.held_ids(), vec!["rev-1".to_string()]);
        let _ = pending.take("rev-1");
        assert!(
            pending.held_ids().is_empty(),
            "a released curl stops vetoing the sweep"
        );
    }
}
