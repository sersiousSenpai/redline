// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
mod agent;
mod browse;
mod claude_proc;
mod db;
mod dictation;
mod feedback;
mod fork;
mod fsbrowse;
mod fswatch;
mod highlight;
mod hook;
mod mission;
mod parser;
#[cfg(test)]
mod perf_guard;
mod pty;
mod resolutions;
mod skill;
mod state;
mod tts;
mod update;
mod voice;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use axum::{
    extract::{ConnectInfo, Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use std::net::SocketAddr;
use serde::{Deserialize, Serialize};
use serde_json::Value;
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
    SessionStatus, SessionStore, SessionSummary, SubmissionMode, UpdateCommentRequest,
};

const SETTING_MODE: &str = "interception_mode";
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
/// → derived `detached`) has real state to pick up.
fn mark_session_detached(app: &AppHandle, store: &SessionStore, session_id: &str) {
    store.set_attach_state(session_id, AttachState::Detached);
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

/// The calm, self-explaining reason that replaces the full payload in the denied
/// `ExitPlanMode` send-back. It leads with a defusing sentence so even the
/// unavoidable `Error:` prefix Claude Code prepends reads as benign, then points
/// the model at the out-of-band `GET …/feedback` channel for the full review.
/// Mode-aware so the Ask round-trip keeps its "do not change the plan body"
/// contract. The full feedback (which `PendingFeedback` now holds) is fetched,
/// not inlined — see `PendingFeedback` for why.
fn feedback_deny_reason(mode: SubmissionMode, session_id: &str) -> String {
    let url = format!("http://127.0.0.1:7676/v1/sessions/{session_id}/feedback");
    match mode {
        SubmissionMode::Revise => format!(
            "✅ Plan returned to Redline for revision — your feedback is loaded and nothing \
             failed. Read it with `curl -s {url}`, then produce the revised plan and call \
             ExitPlanMode again."
        ),
        SubmissionMode::Ask => format!(
            "✅ Returned to Redline — the reviewer has questions about the plan and is NOT \
             requesting changes. Read them with `curl -s {url}`, then call ExitPlanMode again \
             with the plan body unchanged and your answers in the REDLINE_RESOLUTIONS block."
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

/// Safety net for a revise whose feedback was delivered into a held POST that
/// Claude had already abandoned: spawn a task that, after `REVISE_WATCHDOG`,
/// checks whether Claude actually picked the feedback up. "Picked up" means
/// either a fresh plan is now held for the session (`pending.has`) or a newer
/// revise has since been submitted (generation advanced). If neither — and the
/// session is still in review (not approved/closed in the meantime) — the
/// feedback was lost, so reconcile to `Detached` and surface the Restore
/// affordance. A late plan that *does* eventually arrive re-registers as `Held`
/// and clears the derived detached state, so flipping here is self-correcting.
fn arm_revise_watchdog(
    app: AppHandle,
    store: SessionStore,
    pending: PendingResponses,
    revise_watch: ReviseWatch,
    session_id: String,
) {
    let armed_gen = revise_watch.bump(&session_id);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(REVISE_WATCHDOG).await;
        // Claude re-planned (a new POST is held) — feedback landed.
        if pending.has(&session_id) {
            return;
        }
        // A newer revise superseded this one — its own watchdog now owns the wait.
        if revise_watch.current(&session_id) != armed_gen {
            return;
        }
        // Approved or otherwise resolved since the revise — nothing to recover.
        if !matches!(
            store.get(&session_id).map(|s| s.status),
            Some(SessionStatus::InReview)
        ) {
            return;
        }
        tracing::warn!(
            session_id = %session_id,
            "revise watchdog: no new plan within window — feedback likely lost, marking detached"
        );
        mark_session_detached(&app, &store, &session_id);
    });
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
struct ActiveMission(Arc<StdMutex<Option<ActiveMissionInfo>>>);

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

    // Bulletproof restore rebind: a restore handshake carries the held plan's
    // session id (`<!-- REDLINE_RESTORE:<id> -->`). It can arrive under a
    // *different* id than the plan it names — `claude --resume` forks a new
    // session id, and a resume command pasted into an already-running Claude
    // REPL runs the handshake under that REPL's own id. When the sentinel names
    // a held session that isn't this one, re-key it onto the incoming id so the
    // rest of this handler — and every future revision from this terminal — sees
    // the held plan under the live session and restores it, instead of capturing
    // the placeholder as a brand-new plan.
    if let Some(target) = restore_target_id(&raw_plan) {
        if target != session_id
            && !app_state.store.has_session(&session_id)
            && app_state.store.rekey_session(&target, &session_id)
        {
            tracing::info!(
                from = %target, to = %session_id,
                "rebound restore handshake to the live session id"
            );
        }
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
    // "Restore plan session". The daemon already holds the authoritative plan,
    // so restore re-presents its own latest revision and ignores the submitted
    // body (a resumed `claude` need only fire ExitPlanMode). Triggered by the
    // armed flag (always consumed, strictly one-shot) or the restore sentinel
    // the resume prompt writes — the sentinel also guards against a stray
    // submission clobbering a real plan with the placeholder. A restore only
    // applies to a session that has a revision to re-present.
    let restore_armed = app_state.store.take_restore(&session_id);
    let restore_requested =
        (restore_armed || raw_plan.contains(REDLINE_RESTORE_PREFIX)) && !ask_round_trip;
    let restored = restore_requested && session_existed;

    // A restore sentinel that we still couldn't bind to any held plan — the
    // rebind above found no session under the named target, and none exists
    // under the incoming id either. The body is only the placeholder, so
    // persisting it would mint a phantom v1 rendering the literal sentinel
    // instead of a plan. Refuse and store nothing; nothing was lost.
    if raw_plan.contains(REDLINE_RESTORE_PREFIX) && !session_existed {
        tracing::warn!(
            session_id = %session_id,
            "restore sentinel matched no held plan — refusing to persist the placeholder"
        );
        return Json(allow_response(
            "Redline couldn't restore this plan: no held plan matched. The original \
             review session may have been deleted. Re-open the plan from Redline.",
        ));
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
        // Voice agent (and any read-only agent): capture a spoken/requested change
        // as a tracked `[feedback]` comment without a verbatim rewrite. Lands the
        // same driver a reviewer's own feedback comment is; rides the next Revise.
        .route(
            "/v1/sessions/:session_id/comments",
            post(handle_suggest_feedback),
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
        .and_then(|wv| wv.url().ok())
        .map(|u| u.to_string())
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
    // (mirroring the label back via browser_set_active). Poll until a NEW active
    // label resolves to a live webview, or give up (e.g. the tab cap was hit, so
    // openTab no-ops and the active tab never changes).
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(6);
    loop {
        if let Some(label) = app_state.active_browser.get() {
            let is_new = before.as_deref() != Some(label.as_str());
            if is_new && app_state.app_handle.get_webview(&label).is_some() {
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
            .and_then(|wv| wv.url().ok())
        {
            Some(u) => u.to_string(),
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
fn sanitize_basename(input: &str) -> String {
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
fn dedup_path(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
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
/// `BrowserPane` when the active mission changes / its goal is edited / it's
/// archived (`None` = no active mission). The pins are loaded from the DB on
/// demand, so only the mission's identity + goal need mirroring here.
#[tauri::command]
fn mission_set_active(
    active: tauri::State<'_, ActiveMission>,
    mission_id: Option<String>,
    title: Option<String>,
    goal: Option<String>,
    status: Option<String>,
) {
    active.set(mission_id.filter(|id| !id.trim().is_empty()).map(|id| {
        ActiveMissionInfo {
            mission_id: id,
            title: title.unwrap_or_default(),
            goal: goal.unwrap_or_default(),
            status: status.unwrap_or_else(|| "active".to_string()),
        }
    }));
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
async fn browser_cache_snapshot(app: AppHandle, label: String) -> Result<(), String> {
    if app.get_webview(&label).is_none() {
        return Ok(());
    }
    let json = daemon_eval(&app, &label, SNAPSHOT_JS).await?;
    let url = app
        .get_webview(&label)
        .and_then(|wv| wv.url().ok())
        .map(|u| u.to_string())
        .unwrap_or_default();
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
        .and_then(|wv| wv.url().ok())
        .map(|u| u.to_string())
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
    pending_feedback: tauri::State<'_, PendingFeedback>,
    expected_modes: tauri::State<'_, ExpectedModes>,
    revise_watch: tauri::State<'_, ReviseWatch>,
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
        return Err(
            "Claude is no longer waiting for this plan — the Claude Code session \
             ended or the hold timed out. Use \"Restore plan session\" to resume \
             it, then submit your review again."
                .to_string(),
        );
    };
    // Ordering invariant: set expected_mode BEFORE unblocking the hook.
    // Claude can't possibly send the next ExitPlanMode POST before this
    // tx.send() returns to the held handle_plan task, so the next
    // handle_plan invocation is guaranteed to see this entry.
    expected_modes.set(&session_id, mode);
    // Stash the full payload for out-of-band fetch BEFORE the deny is sent, so
    // the model's follow-up curl can never race ahead of the body being present.
    // The denied reason itself is now a single calm line; Claude Code renders
    // the deny as a red `Error:` box sized to the reason, so keeping the bulk
    // out of it is what turns the old scary wall into one benign line. The body
    // still reaches the model byte-for-byte via `GET …/feedback`.
    pending_feedback.set(&session_id, payload);
    let reason = feedback_deny_reason(mode, &session_id);
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

/// Current URL of a browser tab's webview. The JS `Webview` API exposes no
/// navigation events or URL getter, so the pane polls this to keep the address
/// bar / tab title in sync with in-page navigation (link clicks, redirects).
#[tauri::command]
fn browser_url(app: AppHandle, label: String) -> Result<String, String> {
    let wv = app
        .get_webview(&label)
        .ok_or_else(|| format!("browser webview '{label}' not found"))?;
    wv.url().map(|u| u.to_string()).map_err(|e| e.to_string())
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
#[cfg(target_os = "macos")]
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
#[cfg(target_os = "macos")]
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
/// previously installed ones. The fullscreen shim is ALWAYS installed (all
/// frames, so the embed handshake works); the "View" filter CSS is installed
/// only when `css` is non-empty (main frame only, as before). Both sources are
/// also eval'd into the already-loaded page for immediate effect. Centralizing
/// this keeps `browser_set_view` from wiping the shim when it swaps filters.
#[cfg(target_os = "macos")]
fn install_user_scripts(wv: &tauri::Webview, css: &str) -> Result<(), String> {
    let shim = fullscreen_shim_js();
    // Always build the view JS: for a non-empty filter it sets the stylesheet;
    // for an EMPTY css (a reset) it *removes* the `__redline_view__` style. We
    // only install it as a document-start user script when non-empty, but we
    // always eval it (see below) so a reset clears the already-loaded page too.
    let view = view_inject_js(css);
    let install_view = !css.is_empty();
    let shim_owned = shim.to_string();
    let view_owned = view.clone();
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
            // Shim in every frame (top page + sub-frames) for the embed handshake.
            add_user_script(ucc, &shim_owned, false);
            // View filter only on the main frame (don't invert ad/embed iframes).
            if install_view {
                add_user_script(ucc, &view_owned, true);
            }
        }
    })
    .map_err(|e| e.to_string())?;
    // Apply to the page that's already loaded so the change is instant. The view
    // JS is eval'd even on a reset (empty css) — that's what strips the live
    // page's filter; skipping it left "Reset to normal" visually stuck until the
    // next navigation.
    wv.eval(shim).map_err(|e| e.to_string())?;
    wv.eval(&view).map_err(|e| e.to_string())?;
    Ok(())
}

/// Apply (or clear) a Redline "View" filter — dark mode, sepia, dim, etc. — to
/// a browser tab. The stylesheet is installed as a document-start `WKUserScript`
/// on the tab's WKWebView so it's painted before first frame on every load (no
/// flicker across navigation), and is also eval'd into the current page so the
/// toggle takes effect immediately. An empty `css` clears the filter. macOS-
/// only; a no-op elsewhere. The CSS comes from the pane's own presets.
#[tauri::command]
fn browser_set_view(app: AppHandle, label: String, css: String) -> Result<(), String> {
    let wv = app
        .get_webview(&label)
        .ok_or_else(|| format!("browser webview '{label}' not found"))?;
    #[cfg(target_os = "macos")]
    {
        // Reinstall ALL of Redline's user scripts (fullscreen shim + this filter)
        // so swapping the filter never drops the shim.
        install_user_scripts(&wv, &css)?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (wv, css);
    }
    Ok(())
}

/// Install Redline's always-on browser user scripts (currently the in-window
/// fullscreen shim) on a freshly created tab, with no view filter. Invoked once
/// at tab creation so video fullscreen works even before any "View" filter is
/// applied; `browser_set_view` later re-installs the shim alongside its CSS.
/// macOS-only; a no-op elsewhere.
#[tauri::command]
fn browser_install_shims(app: AppHandle, label: String) -> Result<(), String> {
    let wv = app
        .get_webview(&label)
        .ok_or_else(|| format!("browser webview '{label}' not found"))?;
    #[cfg(target_os = "macos")]
    {
        install_user_scripts(&wv, "")?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = wv;
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
            "installed Redline skills (redline + sidecar)"
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
            fsbrowse::save_text_file,
            fsbrowse::ensure_dir,
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
            browse::browse_send,
            browse::get_browse_thread,
            browse::browse_cancel,
            browse::browse_discard,
            browse::browse_kill_all,
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
            mission::mission_kill_all,
            mission_set_active,
            voice::voice_session_start,
            voice::voice_send,
            voice::voice_clean,
            voice::voice_session_stop,
            voice::voice_forget,
            voice::voice_kill_all,
            voice::voice_session_probe,
            tts::tts_get_settings,
            tts::tts_set_settings,
            tts::tts_synth,
            tts::tts_kokoro_status,
            tts::tts_kokoro_install,
            tts::tts_kokoro_warm,
            dictation::dictation_start,
            dictation::dictation_stop,
            dictation::dictation_kill_all,
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
            browser_enable_gestures,
            browser_enable_autoresize,
            browser_set_view,
            browser_install_shims,
            show_bookmarks_menu,
            show_view_menu,
            prompt_text,
        ])
        .setup(|app| {
            // Silently bring an existing install's hook timeout up to date, so a
            // user who installed under the old 10-minute timeout gets the long
            // hold without re-running setup. No-op if not installed / current.
            hook::ensure_timeout_current();

            // Backfill the restore-curl permission for installs that predate it,
            // so "Restore plan session" runs its daemon fetch hands-free instead
            // of stalling on an approval prompt. No-op if not installed / present.
            hook::ensure_restore_permission();

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

            // Mission orchestrator (browser pane, a tier above the browse
            // agents). Same lazy-`claude` reasoning; reads across tabs + pins.
            let mission_state = mission::MissionState::new(db.clone());
            app.manage(mission_state);

            // Voice agent (spoken plan discussion). One persistent `claude`
            // session per plan; same lazy-`claude` reasoning as the fork state.
            let voice_state = voice::VoiceState::new(db.clone());
            app.manage(voice_state);

            // Push-to-talk dictation (the voice agent's microphone). No
            // subprocess — native on-device speech-to-text, one capture at a
            // time. macOS-only under the hood; the state is cheap everywhere.
            app.manage(dictation::DictationState::new());

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

            let store = SessionStore::new(db);
            app.manage(store.clone());

            let pending = PendingResponses::new();
            app.manage(pending.clone());

            let pending_feedback = PendingFeedback::new();
            app.manage(pending_feedback.clone());

            let expected_modes = ExpectedModes::new();
            app.manage(expected_modes.clone());

            app.manage(ReviseWatch::new());

            let daemon_status = DaemonStatus::new();
            app.manage(daemon_status.clone());

            let app_state = AppState {
                store: store.clone(),
                app_handle: app.handle().clone(),
                pending,
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
                _ => {}
            });

            // Background update check on launch: the same comparison the menu
            // item runs, but quiet — it only interrupts to offer a real rebuild,
            // staying silent when up to date or offline. Gives users the update
            // prompt hands-free instead of only when they remember to look.
            update::check_for_updates_in_background(app.handle().clone());

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
                if let Some(browse) = app_handle.try_state::<browse::BrowseState>() {
                    browse.kill_all();
                }
                if let Some(mission) = app_handle.try_state::<mission::MissionState>() {
                    mission.kill_all();
                }
                if let Some(voice) = app_handle.try_state::<voice::VoiceState>() {
                    voice.kill_all();
                }
                if let Some(dictation) = app_handle.try_state::<dictation::DictationState>() {
                    dictation.kill_all();
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
        // Both forms are detected as restore handshakes by the prefix.
        assert!("<!-- REDLINE_RESTORE:x -->".contains(REDLINE_RESTORE_PREFIX));
        assert!("<!-- REDLINE_RESTORE -->".contains(REDLINE_RESTORE_PREFIX));
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
                    kind: CommentKind::Feedback,
                    scope: None,
                    anchor_id: "A".to_string(),
                    block_id: Some("rl:blk-1".to_string()),
                    structural: None,
                    body: "tighten this".to_string(),
                    edit: None,
                    selection: None,
                    author: None,
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

    #[test]
    fn feedback_deny_reason_is_calm_one_liner_with_fetch_url() {
        let revise = feedback_deny_reason(SubmissionMode::Revise, "abc-123");
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

        let ask = feedback_deny_reason(SubmissionMode::Ask, "abc-123");
        // Ask keeps its load-bearing "do not change the plan body" contract.
        assert!(ask.contains("NOT"));
        assert!(ask.contains("unchanged"));
        assert!(ask.contains(
            "curl -s http://127.0.0.1:7676/v1/sessions/abc-123/feedback"
        ));
        assert!(!ask.contains('\n'), "reason must be one line, got: {ask}");
    }
}
