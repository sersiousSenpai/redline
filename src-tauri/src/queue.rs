// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! P0 — the overnight queue. Launches approved-but-unrun plans while the user
//! sleeps: serial WITHIN a repo, parallel ACROSS repos, no worktrees, no merge
//! branches, no reconciler. Each queued run is instructed (via the orchestrate
//! skill plus a queued-mode addendum) to end COMMITTED to its own branch
//! `redline/run/<plan8>` and to PARK its review through the deferred mode of
//! `/v1/reviews/start` (`defer=1`) — the human resolves it in the morning
//! through the existing review pane. Nothing about human authority changes,
//! only when the human is asked.
//!
//! Explicit opt-in only: never at boot — the queue starts on an explicit
//! `queue_start` or the keeper's ready-depth nudge, and only ever over the
//! repos the user allow-listed in the queue config (house `app_settings`
//! pattern, like the seat map). A nightly token cap is checked before every
//! dequeue against the `seat_burn` totals.
//!
//! Crash semantics: the whole queue (config + per-entry state) persists as
//! JSON in `app_settings`, so a restart is simply correct — entries left in
//! `launched` by a dead process are reconciled to `stalled` at the next start
//! (the launcher never marks something running that it did not launch).

use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::db::Database;
use crate::state::SessionStore;

/// The `app_settings` key holding the queue config (repo allowlist + cap).
const SETTING_QUEUE_CONFIG: &str = "redline.nightQueue.config";
/// The `app_settings` key holding the durable queue state (entries).
const SETTING_QUEUE_STATE: &str = "redline.nightQueue.state";

/// Poll cadence while a queued child runs (stall/ceiling checks).
const QUEUE_POLL: Duration = Duration::from_secs(20);
/// Hard per-run ceiling: one hung run must never cost the whole night. Well
/// past any sane overnight run; the stall watchdog catches the never-started
/// case much earlier (`ORCHESTRATE_STALL_WINDOW`).
const QUEUE_RUN_CEILING: Duration = Duration::from_secs(3 * 60 * 60);

// --- persisted shapes --------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct QueueConfig {
    /// Repos (project paths) explicitly opted in to overnight runs.
    pub repos: Vec<String>,
    /// Nightly token budget (input + output across all seats, measured from
    /// the queue-start baseline). `None`/0 = uncapped.
    pub nightly_token_cap: Option<i64>,
}

/// One plan queued for the night. `state`: queued | launched | parked |
/// stalled — exactly the crash-safe vocabulary the runner records.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEntry {
    pub session_id: String,
    /// The serial-per-repo scheduler key: the CANONICALIZED project path.
    /// Two spellings of one physical repo (trailing slash, symlink) must
    /// collapse to ONE key — one serial worker — or they'd run in parallel
    /// inside the same tree. The raw recorded path rides in `raw_path`.
    pub repo: String,
    /// The raw project path as recorded on the plan — the child's cwd
    /// (canonicalization is scheduling identity, not a working directory).
    /// Empty on legacy rows; `work_dir()` falls back to `repo`.
    #[serde(default)]
    pub raw_path: String,
    /// The run's one branch: `redline/run/<plan8>`. The 3am agent commits to
    /// it; the parked review reads it. Never merged by anyone overnight.
    pub branch: String,
    pub state: String,
    #[serde(default)]
    pub review_id: Option<String>,
    #[serde(default)]
    pub launched_at: Option<i64>,
    #[serde(default)]
    pub ended_at: Option<i64>,
    #[serde(default)]
    pub note: Option<String>,
}

impl QueueEntry {
    /// Where the queued child runs: the raw recorded path, falling back to
    /// the scheduler key for legacy rows persisted before `raw_path` existed.
    pub(crate) fn work_dir(&self) -> &str {
        if self.raw_path.is_empty() {
            &self.repo
        } else {
            &self.raw_path
        }
    }
}

/// The night's durable record. `baseline_tokens` (the seat-burn grand total at
/// start) plus the per-entry timestamps are enough to compute the morning
/// "what the night cost" line later.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct QueueState {
    pub started_at: i64,
    pub baseline_tokens: i64,
    pub entries: Vec<QueueEntry>,
    /// Why dequeuing stopped early (cap crossed / stopped by the user), if it
    /// did. `None` = the queue drained (or is still running).
    pub stopped_reason: Option<String>,
}

// --- pure decision logic (unit-tested; no IO) --------------------------------

/// First 8 chars of the plan session id — the run's branch discriminator.
pub(crate) fn plan8(session_id: &str) -> String {
    session_id.chars().take(8).collect()
}

/// The run's one branch. One branch per run; NO merging, NO integration
/// branches — the 3am agent commits here and the parked review reads it.
pub(crate) fn run_branch(session_id: &str) -> String {
    format!("redline/run/{}", plan8(session_id))
}

/// The scheduler's one choice: the next entry to launch for `repo`. Strictly
/// serial WITHIN a repo — while any entry of the repo is `launched`, nothing
/// else in that repo is eligible. Parallelism across repos falls out of each
/// repo asking independently.
pub(crate) fn next_launch_index(entries: &[QueueEntry], repo: &str) -> Option<usize> {
    if entries
        .iter()
        .any(|e| e.repo == repo && e.state == "launched")
    {
        return None;
    }
    entries
        .iter()
        .position(|e| e.repo == repo && e.state == "queued")
}

/// Nightly spend gate, checked before every dequeue: `night_tokens` is the
/// input+output burn since the queue-start baseline. A `None`/non-positive cap
/// never stops the night.
pub(crate) fn cap_crossed(night_tokens: i64, cap: Option<i64>) -> bool {
    cap.is_some_and(|c| c > 0 && night_tokens >= c)
}

/// The queue's stall kill decision — the one-shot stall signal shape
/// (`orchestrate_stall_should_fire` after `ORCHESTRATE_STALL_WINDOW`) applied
/// to a queued child we own: past the window with the chip still on
/// `orchestrating` (no ingest claim ever arrived) the child is killed and the
/// night moves to the repo's next entry.
pub(crate) fn queue_stall_should_kill(run_state: Option<&str>, elapsed: Duration) -> bool {
    elapsed >= crate::ORCHESTRATE_STALL_WINDOW && crate::orchestrate_stall_should_fire(run_state)
}

/// Classify a finished run. Parked wins whenever the deferred review actually
/// landed (entry already flipped by `note_parked`, or the chip reached
/// `awaiting_review`); everything else — killed, crashed, exited without
/// parking — is `stalled`, and the scheduler simply moves on.
pub(crate) fn run_outcome(entry_parked: bool, run_state: Option<&str>) -> &'static str {
    if entry_parked || run_state == Some("awaiting_review") {
        "parked"
    } else {
        "stalled"
    }
}

/// Restart reconciliation: entries a previous process left in `launched`.
/// This process did not launch them, so it must not believe they run — they
/// are marked `stalled` before the night is rebuilt.
pub(crate) fn interrupted_indices(entries: &[QueueEntry]) -> Vec<usize> {
    entries
        .iter()
        .enumerate()
        .filter(|(_, e)| e.state == "launched")
        .map(|(i, _)| i)
        .collect()
}

/// Rebuild-time carry-forward: `queue_start` writes fresh state every night,
/// but the previous night's `parked` entries whose review is still unresolved
/// (the chip still says `awaiting_review`) must survive the rebuild — the
/// entry IS the durable review→plan link (`parked_plan_for_review`), and
/// destroying it makes the morning verdict bounce with "no agent is waiting
/// on this review". Resolved parks (chip walked on) and every other terminal
/// entry stay behind.
pub(crate) fn carry_forward_parked(
    prev: &[QueueEntry],
    run_state_of: impl Fn(&str) -> Option<String>,
) -> Vec<QueueEntry> {
    prev.iter()
        .filter(|e| {
            e.state == "parked"
                && run_state_of(&e.session_id).as_deref() == Some("awaiting_review")
        })
        .cloned()
        .collect()
}

/// Build the night's fresh entries from the ready frontier. BOTH the
/// allowlist match and the entry's scheduler key go through `canon`, so two
/// spellings of one physical repo collapse to one key — one serial worker —
/// while the raw recorded path rides along as the child's cwd. `carried`
/// (the previous night's preserved parks) is deduped out so no plan queues
/// twice.
pub(crate) fn build_entries(
    ready: Vec<(String, String, String)>,
    allowed: &[String],
    carried: &[QueueEntry],
) -> Vec<QueueEntry> {
    ready
        .into_iter()
        .filter(|(sid, project_path, _)| {
            allowed.contains(&canon(project_path))
                && !carried.iter().any(|c| c.session_id == *sid)
        })
        .map(|(sid, project_path, _)| QueueEntry {
            branch: run_branch(&sid),
            session_id: sid,
            repo: canon(&project_path),
            raw_path: project_path,
            state: "queued".to_string(),
            review_id: None,
            launched_at: None,
            ended_at: None,
            note: None,
        })
        .collect()
}

/// Distinct scheduler keys with launchable (`queued`) work — one serial
/// worker each. Carried parked entries spawn no worker.
pub(crate) fn worker_repos(entries: &[QueueEntry]) -> Vec<String> {
    let mut repos: Vec<String> = entries
        .iter()
        .filter(|e| e.state == "queued")
        .map(|e| e.repo.clone())
        .collect();
    repos.sort();
    repos.dedup();
    repos
}

/// The launch-time clean-tree gate's pure decision: only a VERIFIED-clean
/// probe (`Ok(false)`) launches. A dirty tree — live uncommitted sibling
/// work is this project's documented reality — or a failed probe skips the
/// repo's whole night: the addendum's `git add -A` commit must only ever
/// sweep up the run's OWN changes. NEVER a stash.
pub(crate) fn dirty_gate_should_skip(probe: &Result<bool, String>) -> bool {
    !matches!(probe, Ok(false))
}

/// The queued-mode prompt: the ordinary orchestrate handoff plus the
/// queued-mode addendum that overrides the skill's "leave uncommitted" and
/// "blocking review" sections — end committed to the run branch, park the
/// review via the deferred mode, never block on a human.
pub(crate) fn queued_prompt(session_id: &str, branch: &str) -> String {
    format!(
        "ultracode: execute the approved plan for Redline session {sid} as a multi-agent \
         workflow. First fetch it: curl -s \"http://127.0.0.1:7676/v1/sessions/{sid}/plan\" — \
         rawPlanMarkdown is the reviewed, approved plan. Follow your orchestrate skill for \
         the execution discipline, EXCEPT where this QUEUED-MODE ADDENDUM overrides it \
         (it overrides the skill's 'leave uncommitted' and 'blocking review' sections):\n\n\
         QUEUED MODE — this is an overnight queued run; no human is present.\n\
         1. Still POST the structured exit report exactly as the skill describes, when the \
         work ends.\n\
         2. Do NOT leave the changes uncommitted. When the work (and the report) is done, \
         from the repo root: create the run branch and commit EVERYTHING onto it —\n\
         git checkout -b {branch} (if it already exists: git checkout {branch})\n\
         git add -A\n\
         git commit -m \"redline queued run {p8}\"\n\
         git checkout -\n\
         One branch for this run only. NEVER merge it, never rebase it, never touch any \
         other branch, never push.\n\
         3. Do NOT run the blocking review curl. Instead PARK the review for the morning \
         (returns immediately):\n\
         curl -s \"http://127.0.0.1:7676/v1/reviews/start?repo=$PWD&source=runBranch&base={branch}&plan={sid}&defer=1\"\n\
         4. Never block waiting on a human: no held curls, no waiting on prompts. If \
         something genuinely needs a human decision, record it in the exit report and end \
         the session.",
        sid = session_id,
        branch = branch,
        p8 = plan8(session_id),
    )
}

// --- persistence (locked read-modify-write over app_settings) ----------------

/// Serializes every read-modify-write of the queue state JSON: repo workers
/// run in parallel and the deferred review handler (`note_parked`) writes from
/// the axum side. Held synchronously only — never across an await.
fn state_lock() -> &'static StdMutex<()> {
    static G: OnceLock<StdMutex<()>> = OnceLock::new();
    G.get_or_init(|| StdMutex::new(()))
}

pub(crate) fn load_config(db: &Database) -> QueueConfig {
    db.get_setting(SETTING_QUEUE_CONFIG)
        .and_then(|j| serde_json::from_str(&j).ok())
        .unwrap_or_default()
}

fn save_config(db: &Database, cfg: &QueueConfig) -> Result<(), String> {
    let json = serde_json::to_string(cfg).map_err(|e| e.to_string())?;
    db.set_setting(SETTING_QUEUE_CONFIG, &json)
        .map_err(|e| e.to_string())
}

pub(crate) fn load_state(db: &Database) -> Option<QueueState> {
    db.get_setting(SETTING_QUEUE_STATE)
        .and_then(|j| serde_json::from_str(&j).ok())
}

fn save_state(db: &Database, state: &QueueState) {
    if let Ok(json) = serde_json::to_string(state) {
        if let Err(e) = db.set_setting(SETTING_QUEUE_STATE, &json) {
            tracing::warn!(error = %e, "failed to persist overnight-queue state");
        }
    }
}

/// Locked read-modify-write. Returns false when no state exists yet.
fn with_state(db: &Database, f: impl FnOnce(&mut QueueState)) -> bool {
    let _g = state_lock().lock().unwrap();
    let Some(mut state) = load_state(db) else {
        return false;
    };
    f(&mut state);
    save_state(db, &state);
    true
}

/// The deferred review handler's queue hook: a queued run parked its review.
/// Flips the plan's entry to `parked` and records the review id. Quietly a
/// no-op when the plan is not in the current night (the deferred mode is
/// usable outside the queue).
pub(crate) fn note_parked(db: &Database, plan_sid: &str, review_id: &str) {
    with_state(db, |s| {
        if let Some(e) = s
            .entries
            .iter_mut()
            .find(|e| e.session_id == plan_sid && e.state != "stalled")
        {
            e.state = "parked".to_string();
            e.review_id = Some(review_id.to_string());
            e.ended_at = Some(crate::ledger::now_millis());
        }
    });
}

/// The durable review → plan link for a PARKED review (the in-memory
/// `orchestration_review_links` map does not survive a restart, but the queue
/// state does). Lets the morning verdict walk the run chip.
pub(crate) fn parked_plan_for_review(db: &Database, review_id: &str) -> Option<String> {
    let _g = state_lock().lock().unwrap();
    load_state(db)?
        .entries
        .iter()
        .find(|e| e.review_id.as_deref() == Some(review_id))
        .map(|e| e.session_id.clone())
}

/// One entry's current persisted state (the runner re-reads truth at run end;
/// `note_parked` may have flipped it under the running child).
fn entry_state(db: &Database, plan_sid: &str) -> Option<String> {
    let _g = state_lock().lock().unwrap();
    load_state(db)?
        .entries
        .iter()
        .find(|e| e.session_id == plan_sid)
        .map(|e| e.state.clone())
}

/// Reserve the repo's next queued entry (flip to `launched` under the lock)
/// and return it. Reserve-first: a crash between reserve and spawn reconciles
/// to `stalled` at the next start rather than double-launching.
fn reserve_next(db: &Database, repo: &str) -> Option<QueueEntry> {
    let _g = state_lock().lock().unwrap();
    let mut state = load_state(db)?;
    let idx = next_launch_index(&state.entries, repo)?;
    state.entries[idx].state = "launched".to_string();
    state.entries[idx].launched_at = Some(crate::ledger::now_millis());
    let entry = state.entries[idx].clone();
    save_state(db, &state);
    Some(entry)
}

/// Record a finished entry (never downgrades a `parked` entry to `stalled` —
/// the park already proved the run delivered).
fn finish_entry(db: &Database, plan_sid: &str, state: &str, note: Option<&str>) {
    with_state(db, |s| {
        if let Some(e) = s.entries.iter_mut().find(|e| e.session_id == plan_sid) {
            if e.state == "parked" && state == "stalled" {
                return;
            }
            e.state = state.to_string();
            e.ended_at = Some(crate::ledger::now_millis());
            if let Some(n) = note {
                e.note = Some(n.to_string());
            }
        }
    });
}

/// The note recorded on every entry the launch-time clean-tree gate skips.
pub(crate) const DIRTY_TREE_NOTE: &str = "dirty tree at queue start";

/// Skip a repo's entire night (the launch-time clean-tree gate): every
/// still-`queued` entry of the repo flips to `stalled` with the reason
/// recorded, so the morning surface says why nothing ran. Other repos are
/// untouched — their workers gate independently.
fn skip_repo_queued(db: &Database, repo: &str, note: &str) {
    with_state(db, |s| {
        for e in s
            .entries
            .iter_mut()
            .filter(|e| e.repo == repo && e.state == "queued")
        {
            e.state = "stalled".to_string();
            e.ended_at = Some(crate::ledger::now_millis());
            e.note = Some(note.to_string());
        }
    });
}

/// The cwd the repo's first launch would use — where the clean-tree gate
/// probes. `None` = nothing queued for the repo, so no gate is needed.
fn first_queued_cwd(db: &Database, repo: &str) -> Option<String> {
    let _g = state_lock().lock().unwrap();
    load_state(db)?
        .entries
        .iter()
        .find(|e| e.repo == repo && e.state == "queued")
        .map(|e| e.work_dir().to_string())
}

fn set_stopped_reason(db: &Database, reason: &str) {
    with_state(db, |s| {
        if s.stopped_reason.is_none() {
            s.stopped_reason = Some(reason.to_string());
        }
    });
}

/// Grand input+output token total across all seats and days — the cap works
/// on the DELTA from the queue-start baseline, so absolute history is fine.
fn grand_total_tokens(db: &Database) -> i64 {
    db.seat_burn_totals_by_seat()
        .map(|rows| {
            rows.iter()
                .map(|r| r.input_tokens + r.output_tokens)
                .sum()
        })
        .unwrap_or(0)
}

// --- the launcher ------------------------------------------------------------

/// Managed runtime flag: whether the night loop is live. Never armed at
/// boot — only `queue_start` flips this (the keeper's ready-depth nudge goes
/// through that same ignition).
pub struct QueueRuntime {
    running: Arc<AtomicBool>,
    active_workers: Arc<AtomicUsize>,
}

impl QueueRuntime {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            active_workers: Arc::new(AtomicUsize::new(0)),
        }
    }
}

impl Default for QueueRuntime {
    fn default() -> Self {
        Self::new()
    }
}

#[tauri::command]
pub fn queue_get_config(store: tauri::State<'_, SessionStore>) -> QueueConfig {
    load_config(&store.database())
}

#[tauri::command]
pub fn queue_set_config(
    store: tauri::State<'_, SessionStore>,
    repos: Vec<String>,
    nightly_token_cap: Option<i64>,
) -> Result<QueueConfig, String> {
    let cfg = QueueConfig {
        repos: repos
            .into_iter()
            .map(|r| r.trim().to_string())
            .filter(|r| !r.is_empty())
            .collect(),
        nightly_token_cap: nightly_token_cap.filter(|c| *c > 0),
    };
    save_config(&store.database(), &cfg)?;
    Ok(cfg)
}

/// The queue's whole observable surface: the runtime flag, the config, and
/// the persisted night state (entries with their per-entry states).
#[tauri::command]
pub fn queue_status(
    store: tauri::State<'_, SessionStore>,
    rt: tauri::State<'_, QueueRuntime>,
) -> serde_json::Value {
    let db = store.database();
    serde_json::json!({
        "running": rt.running.load(Ordering::SeqCst),
        "config": load_config(&db),
        "state": load_state(&db),
    })
}

/// Stop dequeuing. In-flight runs finish on their own (killing a mid-edit
/// child would leave a half-applied tree — worse than letting it park).
#[tauri::command]
pub fn queue_stop(
    store: tauri::State<'_, SessionStore>,
    rt: tauri::State<'_, QueueRuntime>,
) -> Result<(), String> {
    if rt.running.swap(false, Ordering::SeqCst) {
        set_stopped_reason(&store.database(), "stopped by the user");
    }
    Ok(())
}

/// Start the night: build the queue from the ready frontier (approved plans
/// with no run, in opted-in repos), carry forward the previous night's
/// still-unresolved parks (their review→plan links must survive the
/// rebuild), reconcile any stale `launched` entries from a dead process,
/// snapshot the token baseline, and spawn one serial worker per repo.
/// Never at boot — an explicit `queue_start` or the keeper's ready-depth
/// nudge (which calls this same ignition) is the only way in.
#[tauri::command]
pub fn queue_start(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    rt: tauri::State<'_, QueueRuntime>,
) -> Result<serde_json::Value, String> {
    if rt.active_workers.load(Ordering::SeqCst) > 0 {
        return Err("the overnight queue is still winding down — try again shortly".into());
    }
    if rt
        .running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("the overnight queue is already running".into());
    }
    let store = (*store).clone();
    let db = store.database();
    let cfg = load_config(&db);
    if cfg.repos.is_empty() {
        rt.running.store(false, Ordering::SeqCst);
        return Err(
            "no repos are opted in to the overnight queue — set the queue config first".into(),
        );
    }

    // Restart reconciliation BEFORE rebuilding: a previous process's
    // `launched` entries were never ours to believe in.
    if let Some(prev) = load_state(&db) {
        for i in interrupted_indices(&prev.entries) {
            let sid = prev.entries[i].session_id.clone();
            finish_entry(
                &db,
                &sid,
                "stalled",
                Some("the launcher restarted before this run ended"),
            );
            if crate::runwatch::is_live_run_state(db.get_run_state(&sid).as_deref()) {
                crate::advance_run_state(&app, &store, &sid, "stalled");
            }
        }
    }

    // Carry forward BEFORE overwriting: the previous night's parked entries
    // whose review is still unresolved (chip on `awaiting_review`) keep their
    // review→plan links, or the morning verdict finds nothing behind the
    // review id and bounces.
    let carried: Vec<QueueEntry> = {
        let _g = state_lock().lock().unwrap();
        load_state(&db)
            .map(|prev| carry_forward_parked(&prev.entries, |sid| db.get_run_state(sid)))
            .unwrap_or_default()
    };

    // The ready plan queue IS this query: approved AND never run.
    let ready = db
        .list_queue_ready_sessions()
        .map_err(|e| e.to_string())?;
    let allowed: Vec<String> = cfg
        .repos
        .iter()
        .map(|r| canon(r))
        .collect();
    let mut entries = build_entries(ready, &allowed, &carried);
    if entries.is_empty() {
        // Early return WITHOUT saving: the previous night's state — parked
        // links included — stays in place for the morning verdicts.
        rt.running.store(false, Ordering::SeqCst);
        return Err("no approved, unrun plans in the opted-in repos — nothing to queue".into());
    }
    let queued = entries.len();
    entries.extend(carried);

    let state = QueueState {
        started_at: crate::ledger::now_millis(),
        baseline_tokens: grand_total_tokens(&db),
        entries,
        stopped_reason: None,
    };
    {
        let _g = state_lock().lock().unwrap();
        save_state(&db, &state);
    }
    let _ = db.append_journal(
        "queue_started",
        Some("queue"),
        None,
        Some(&format!("{queued} plan(s) queued")),
        None,
    );

    // One serial worker per distinct repo key with launchable work; parallel
    // across repos. Carried parks spawn no worker.
    let repos = worker_repos(&state.entries);
    let mut handles = Vec::new();
    for repo in repos {
        rt.active_workers.fetch_add(1, Ordering::SeqCst);
        let app = app.clone();
        let store = store.clone();
        let running = rt.running.clone();
        let active = rt.active_workers.clone();
        let cap = cfg.nightly_token_cap;
        let baseline = state.baseline_tokens;
        handles.push(tauri::async_runtime::spawn(async move {
            repo_worker(app, store, running, repo, cap, baseline).await;
            active.fetch_sub(1, Ordering::SeqCst);
        }));
    }
    let running = rt.running.clone();
    let store_done = store.clone();
    tauri::async_runtime::spawn(async move {
        for h in handles {
            let _ = h.await;
        }
        running.store(false, Ordering::SeqCst);
        let _ = store_done.database().append_journal(
            "queue_finished",
            Some("queue"),
            None,
            None,
            None,
        );
    });
    Ok(serde_json::json!({ "queued": queued }))
}

/// Pure gate for `nudge` (unit-tested): start only when the queue is fully
/// quiescent (not running, no workers winding down), the user has explicitly
/// opted repos in, and no prior stop reason stands.
pub(crate) fn nudge_should_start(
    running: bool,
    winding_down_workers: usize,
    opted_in: bool,
    prior_stop: Option<&str>,
) -> bool {
    !running && winding_down_workers == 0 && opted_in && prior_stop.is_none()
}

/// The watch-bus nudge — the ready-depth watch's one entry point into the
/// queue. Attempts a dequeue pass by waking the queue's EXISTING ignition
/// (`queue_start`); the watch spawns nothing itself. Quiet no-op unless every
/// gate holds: the queue is quiescent, repos are explicitly opted in (the
/// queue still never runs for an unopted user), and no standing
/// `stopped_reason` — a night the user stopped, or the token cap ended,
/// STAYS stopped until the human starts the next night by hand
/// (`queue_start` writes fresh state); the watch never overrides a human or
/// cap stop.
pub(crate) fn nudge(app: &AppHandle) {
    use tauri::Manager;
    let store = app.state::<SessionStore>();
    let rt = app.state::<QueueRuntime>();
    let db = store.database();
    let standing_stop = load_state(&db).and_then(|s| s.stopped_reason);
    if !nudge_should_start(
        rt.running.load(Ordering::SeqCst),
        rt.active_workers.load(Ordering::SeqCst),
        !load_config(&db).repos.is_empty(),
        standing_stop.as_deref(),
    ) {
        return;
    }
    match queue_start(app.clone(), store, rt) {
        Ok(v) => tracing::info!(queued = %v, "ready-depth nudge started an overnight pass"),
        Err(e) => tracing::debug!(reason = %e, "ready-depth nudge: nothing to start"),
    }
}

/// One repo's serial night: clean-tree gate → (cap gate → reserve → launch →
/// drive → repeat).
async fn repo_worker(
    app: AppHandle,
    store: SessionStore,
    running: Arc<AtomicBool>,
    repo: String,
    cap: Option<i64>,
    baseline: i64,
) {
    let db = store.database();
    // Launch-time clean-tree gate (read-only; NEVER a stash): this queue runs
    // over repos whose documented reality is live uncommitted sibling work,
    // and the addendum's `git add -A` commit must only ever sweep up the
    // run's OWN changes. A repo that is dirty when its worker starts never
    // launches at all — its queued entries are skipped with the reason
    // recorded, and the other repos' nights proceed unaffected.
    if let Some(cwd) = first_queued_cwd(&db, &repo) {
        let probe = tokio::task::spawn_blocking(move || tree_dirty(&cwd))
            .await
            .unwrap_or_else(|e| Err(e.to_string()));
        if dirty_gate_should_skip(&probe) {
            let note = match probe {
                Ok(_) => DIRTY_TREE_NOTE.to_string(),
                Err(e) => format!("{DIRTY_TREE_NOTE} (probe failed: {e})"),
            };
            skip_repo_queued(&db, &repo, &note);
            tracing::warn!(
                repo = %repo, note = %note,
                "overnight queue: repo skipped by the clean-tree gate"
            );
            return;
        }
    }
    loop {
        if !running.load(Ordering::SeqCst) {
            break;
        }
        let night = grand_total_tokens(&db) - baseline;
        if cap_crossed(night, cap) {
            set_stopped_reason(
                &db,
                &format!("nightly token cap crossed ({night} tokens since queue start)"),
            );
            tracing::info!(repo = %repo, night, "overnight queue: token cap crossed — stopping");
            break;
        }
        let Some(entry) = reserve_next(&db, &repo) else {
            break;
        };
        drive_run(&app, &store, &entry).await;
    }
}

/// Launch one queued run through the one spawn chokepoint
/// (`claude_command_for_seat`, orchestrator seat) and babysit it: stall kill,
/// ceiling kill, and the parked/stalled classification at exit.
async fn drive_run(app: &AppHandle, store: &SessionStore, entry: &QueueEntry) {
    let db = store.database();
    let sid = entry.session_id.as_str();
    let prompt = queued_prompt(sid, &entry.branch);
    // Arm the same two ledger guards as an interactive Orchestrate launch:
    // the hook fire claims the prompt (not a lake prompt) and links the new
    // claude session under the plan — which is also the `running` beacon and
    // the run-watcher anchor.
    let bh = crate::ledger::body_hash(&prompt);
    crate::ledger::register_agent_prompt(&bh);
    crate::ledger::register_orchestration_prompt(&bh, sid);
    crate::advance_run_state(app, store, sid, "orchestrating");

    let claude_bin = match tokio::task::spawn_blocking(crate::claude_proc::resolve_claude_bin).await
    {
        Ok(b) => b,
        Err(e) => {
            finish_entry(&db, sid, "stalled", Some(&format!("claude resolve failed: {e}")));
            crate::advance_run_state(app, store, sid, "stalled");
            return;
        }
    };
    let mut cmd = crate::claude_proc::claude_command_for_seat("orchestrator", &claude_bin);
    let mut args: Vec<String> = vec![
        "-p".to_string(),
        prompt,
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--permission-mode".to_string(),
        "acceptEdits".to_string(),
        "--allowedTools".to_string(),
        "Bash".to_string(),
        "WebFetch".to_string(),
        "WebSearch".to_string(),
        "--strict-mcp-config".to_string(),
    ];
    args.extend(crate::seat::flag_args("orchestrator"));
    let mut child = match cmd
        .current_dir(entry.work_dir())
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            finish_entry(&db, sid, "stalled", Some(&format!("spawn failed: {e}")));
            crate::advance_run_state(app, store, sid, "stalled");
            return;
        }
    };
    tracing::info!(session_id = %sid, repo = %entry.repo, "overnight queue: run launched");

    // Drain the pipes off to the side (a full pipe would block the child);
    // the outcome is read from durable state, not from stdout.
    let drain = match (child.stdout.take(), child.stderr.take()) {
        (Some(o), Some(e)) => Some(tokio::spawn(crate::claude_proc::collect_turn(o, e))),
        _ => None,
    };

    let started = std::time::Instant::now();
    let mut killed: Option<String> = None;
    loop {
        // `Child::wait` is cancel-safe, so the poll-slice timeout loses
        // nothing; between slices we run the stall/ceiling checks.
        match tokio::time::timeout(QUEUE_POLL, child.wait()).await {
            Ok(_) => break,
            Err(_) => {
                if killed.is_some() {
                    continue; // kill already requested; wait for exit
                }
                let rs = db.get_run_state(sid);
                if queue_stall_should_kill(rs.as_deref(), started.elapsed()) {
                    killed = Some(
                        "stalled before the first beacon (no ingest claim) — killed, moving on"
                            .to_string(),
                    );
                    let _ = child.start_kill();
                } else if started.elapsed() >= QUEUE_RUN_CEILING {
                    killed = Some("run exceeded the overnight ceiling — killed".to_string());
                    let _ = child.start_kill();
                }
            }
        }
    }
    let turn = match drain {
        Some(h) => h.await.ok(),
        None => None,
    };

    // Truth at exit: the deferred park may have flipped the entry under us.
    let parked = entry_state(&db, sid).as_deref() == Some("parked");
    let rs = db.get_run_state(sid);
    let outcome = run_outcome(parked, rs.as_deref());
    if outcome == "parked" {
        finish_entry(&db, sid, "parked", None);
    } else {
        let note = killed
            .or_else(|| turn.as_ref().and_then(|t| t.errored.clone()))
            .unwrap_or_else(|| {
                format!(
                    "exited without parking a review (run_state={})",
                    rs.as_deref().unwrap_or("none")
                )
            });
        finish_entry(&db, sid, "stalled", Some(&note));
        crate::advance_run_state(app, store, sid, "stalled");
    }
    let _ = db.append_journal(
        "queue_run",
        Some("session"),
        Some(sid),
        Some(outcome),
        None,
    );
    tracing::info!(session_id = %sid, outcome, "overnight queue: run ended");
}

/// Read-only clean-tree probe for the launch gate: `git status --porcelain`
/// in the repo — ANY output (staged, unstaged, untracked) counts as dirty,
/// exactly the set the addendum's `git add -A` would sweep up. Never
/// mutates; NEVER a stash. Blocking (fast local git) — the worker calls it
/// through `spawn_blocking`.
fn tree_dirty(dir: &str) -> Result<bool, String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["status", "--porcelain"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!(
            "git status failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(!out.stdout.is_empty())
}

/// Canonicalized path string for allowlist comparison and the entry's
/// scheduler key (symlinks / trailing slashes collapse), falling back to the
/// trimmed input.
fn canon(p: &str) -> String {
    std::fs::canonicalize(p.trim())
        .map(|c| c.to_string_lossy().to_string())
        .unwrap_or_else(|_| p.trim().trim_end_matches('/').to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(sid: &str, repo: &str, state: &str) -> QueueEntry {
        QueueEntry {
            session_id: sid.to_string(),
            repo: repo.to_string(),
            raw_path: String::new(),
            branch: run_branch(sid),
            state: state.to_string(),
            review_id: None,
            launched_at: None,
            ended_at: None,
            note: None,
        }
    }

    #[test]
    fn same_repo_entries_run_strictly_sequential() {
        let mut entries = vec![entry("s1", "/r/a", "queued"), entry("s2", "/r/a", "queued")];
        // First dequeue: the older entry.
        assert_eq!(next_launch_index(&entries, "/r/a"), Some(0));
        entries[0].state = "launched".to_string();
        // While it runs, NOTHING else in the repo is eligible.
        assert_eq!(next_launch_index(&entries, "/r/a"), None);
        // Only its terminal state frees the next one.
        entries[0].state = "parked".to_string();
        assert_eq!(next_launch_index(&entries, "/r/a"), Some(1));
    }

    #[test]
    fn two_repos_are_both_eligible_in_parallel() {
        let entries = vec![entry("s1", "/r/a", "queued"), entry("s2", "/r/b", "queued")];
        assert_eq!(next_launch_index(&entries, "/r/a"), Some(0));
        assert_eq!(next_launch_index(&entries, "/r/b"), Some(1));
        // A launched run in one repo never blocks the other.
        let mut entries = entries;
        entries[0].state = "launched".to_string();
        assert_eq!(next_launch_index(&entries, "/r/b"), Some(1));
    }

    #[test]
    fn stall_frees_the_repos_next_entry() {
        // The failover: a stalled run is terminal — the scheduler moves to the
        // next entry in that repo instead of halting the night.
        let mut entries = vec![entry("s1", "/r/a", "launched"), entry("s2", "/r/a", "queued")];
        assert_eq!(next_launch_index(&entries, "/r/a"), None);
        entries[0].state = "stalled".to_string();
        assert_eq!(next_launch_index(&entries, "/r/a"), Some(1));
    }

    #[test]
    fn cap_crossed_stops_dequeuing() {
        assert!(!cap_crossed(999, Some(1000)));
        assert!(cap_crossed(1000, Some(1000)));
        assert!(cap_crossed(5000, Some(1000)));
        // Uncapped / degenerate caps never stop the night.
        assert!(!cap_crossed(i64::MAX, None));
        assert!(!cap_crossed(100, Some(0)));
        assert!(!cap_crossed(100, Some(-5)));
    }

    #[test]
    fn stall_kill_reuses_the_stall_signal_shape() {
        let w = crate::ORCHESTRATE_STALL_WINDOW;
        // Inside the window: never.
        assert!(!queue_stall_should_kill(Some("orchestrating"), w / 2));
        // Past the window with no beacon ever: kill.
        assert!(queue_stall_should_kill(Some("orchestrating"), w));
        // Any beacon (running / review / terminal) retires the stall kill.
        for s in [Some("running"), Some("awaiting_review"), Some("landed"), None] {
            assert!(!queue_stall_should_kill(s, w * 2), "must not kill on {s:?}");
        }
    }

    #[test]
    fn run_outcome_prefers_parked_and_stalls_the_rest() {
        // The deferred park (either evidence) means the run delivered.
        assert_eq!(run_outcome(true, None), "parked");
        assert_eq!(run_outcome(false, Some("awaiting_review")), "parked");
        // Exited without parking — whatever the chip says — is stalled.
        for s in [None, Some("orchestrating"), Some("running"), Some("in_code_review")] {
            assert_eq!(run_outcome(false, s), "stalled", "run_state {s:?}");
        }
    }

    #[test]
    fn interrupted_launched_entries_reconcile_on_restart() {
        let entries = vec![
            entry("s1", "/r/a", "parked"),
            entry("s2", "/r/a", "launched"),
            entry("s3", "/r/b", "queued"),
            entry("s4", "/r/b", "launched"),
        ];
        assert_eq!(interrupted_indices(&entries), vec![1, 3]);
    }

    #[test]
    fn nudge_gate_is_conservative() {
        // The happy path: quiescent + opted in + no standing stop.
        assert!(nudge_should_start(false, 0, true, None));
        // A live or winding-down night needs no nudge.
        assert!(!nudge_should_start(true, 0, true, None));
        assert!(!nudge_should_start(false, 1, true, None));
        // No opt-in → the queue still never starts itself.
        assert!(!nudge_should_start(false, 0, false, None));
        // A standing stop (user stop / cap crossed) is never overridden.
        assert!(!nudge_should_start(false, 0, true, Some("stopped by the user")));
    }

    #[test]
    fn branch_and_plan8_are_stable() {
        assert_eq!(plan8("abcdef12-3456-7890"), "abcdef12");
        assert_eq!(run_branch("abcdef12-3456-7890"), "redline/run/abcdef12");
        // Short ids never panic.
        assert_eq!(run_branch("ab"), "redline/run/ab");
    }

    #[test]
    fn queued_prompt_carries_branch_park_and_never_block() {
        let p = queued_prompt("abcdef12-3456", "redline/run/abcdef12");
        assert!(p.contains("/v1/sessions/abcdef12-3456/plan"));
        assert!(p.contains("git checkout -b redline/run/abcdef12"));
        // The deferred park curl, with the run-branch source and defer flag.
        assert!(p.contains("source=runBranch&base=redline/run/abcdef12&plan=abcdef12-3456&defer=1"));
        assert!(p.contains("Never block waiting on a human"));
        // Queued mode must not instruct a merge or a push.
        assert!(p.contains("NEVER merge"));
    }

    #[test]
    fn carry_forward_keeps_only_unresolved_parks() {
        let prev = vec![
            entry("p-open", "/r/a", "parked"),  // chip awaiting_review → carried
            entry("p-done", "/r/a", "parked"),  // chip landed → resolved, dropped
            entry("s-old", "/r/a", "stalled"),  // terminal, dropped
            entry("q-old", "/r/b", "queued"),   // rebuilt fresh, dropped
        ];
        let carried = carry_forward_parked(&prev, |sid| match sid {
            "p-open" => Some("awaiting_review".to_string()),
            "p-done" => Some("landed".to_string()),
            _ => None,
        });
        assert_eq!(carried.len(), 1);
        assert_eq!(carried[0].session_id, "p-open");
        assert_eq!(carried[0].state, "parked");
    }

    #[test]
    fn rebuild_carries_unresolved_parks_and_their_morning_links() {
        // Night 1 parked an entry with its review id — the durable morning
        // link. Night 2's `queue_start` rebuild must not destroy it.
        let db = Database::open_in_memory().unwrap();
        let mut parked = entry("plan-1", "/r/a", "parked");
        parked.review_id = Some("rev-1".to_string());
        save_state(
            &db,
            &QueueState {
                started_at: 1,
                baseline_tokens: 0,
                entries: vec![parked],
                stopped_reason: None,
            },
        );
        // The queue_start rebuild path: carry unresolved parks, build fresh
        // entries (the carried plan deduped out even if the frontier somehow
        // re-offered it), append the carried parks.
        let prev = load_state(&db).unwrap();
        let carried =
            carry_forward_parked(&prev.entries, |_| Some("awaiting_review".to_string()));
        let ready = vec![
            ("plan-2".to_string(), "/r/a".to_string(), "a".to_string()),
            ("plan-1".to_string(), "/r/a".to_string(), "a".to_string()),
        ];
        let mut entries = build_entries(ready, &[canon("/r/a")], &carried);
        assert_eq!(entries.len(), 1, "the carried plan must not re-queue");
        entries.extend(carried);
        save_state(
            &db,
            &QueueState {
                started_at: 2,
                baseline_tokens: 0,
                entries,
                stopped_reason: None,
            },
        );
        // The morning verdict's link survived the rebuild — the approve path
        // can still resolve awaiting_review → landed against this plan.
        assert_eq!(parked_plan_for_review(&db, "rev-1").as_deref(), Some("plan-1"));
        // Only the fresh entry is launchable; carried parks spawn no worker.
        let s = load_state(&db).unwrap();
        assert_eq!(next_launch_index(&s.entries, &canon("/r/a")), Some(0));
        assert_eq!(s.entries[0].session_id, "plan-2");
        assert_eq!(worker_repos(&s.entries), vec![canon("/r/a")]);
    }

    #[test]
    fn two_spellings_of_one_repo_get_one_worker() {
        // `canon` falls back to trailing-slash trimming for paths that don't
        // exist — the deterministic slice of canonicalization — so two
        // spellings of one physical repo collapse to one scheduler key.
        let ready = vec![
            ("s1".to_string(), "/no/such/repo".to_string(), "r".to_string()),
            ("s2".to_string(), "/no/such/repo/".to_string(), "r".to_string()),
        ];
        let entries = build_entries(ready, &[canon("/no/such/repo/")], &[]);
        assert_eq!(entries.len(), 2);
        // One key, two raw spellings: the key schedules, the raw path is cwd.
        assert_eq!(entries[0].repo, entries[1].repo);
        assert_eq!(entries[0].work_dir(), "/no/such/repo");
        assert_eq!(entries[1].work_dir(), "/no/such/repo/");
        // ONE serial worker; while s1 runs, s2 waits.
        let key = entries[0].repo.clone();
        assert_eq!(worker_repos(&entries), vec![key.clone()]);
        let mut entries = entries;
        entries[0].state = "launched".to_string();
        assert_eq!(next_launch_index(&entries, &key), None);
    }

    #[test]
    fn dirty_gate_launches_only_on_a_verified_clean_probe() {
        assert!(!dirty_gate_should_skip(&Ok(false)));
        assert!(dirty_gate_should_skip(&Ok(true)));
        assert!(dirty_gate_should_skip(&Err("git exploded".to_string())));
    }

    #[test]
    fn dirty_repo_is_skipped_with_note_while_clean_repo_proceeds() {
        // Self-cleaning temp dirs (no `tempfile` dep — the house
        // `std::env::temp_dir()` + uuid convention).
        struct TempTree(std::path::PathBuf);
        impl Drop for TempTree {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        fn git(dir: &std::path::Path, args: &[&str]) {
            let ok = std::process::Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(args)
                .output()
                .unwrap()
                .status
                .success();
            assert!(ok, "git {args:?} failed in {dir:?}");
        }
        let base = TempTree(
            std::env::temp_dir().join(format!("redline-queue-gate-{}", uuid::Uuid::new_v4())),
        );
        let dirty = base.0.join("dirty");
        let clean = base.0.join("clean");
        std::fs::create_dir_all(&dirty).unwrap();
        std::fs::create_dir_all(&clean).unwrap();
        git(&dirty, &["init", "-q"]);
        git(&clean, &["init", "-q"]);
        // The documented reality: live uncommitted sibling work.
        std::fs::write(dirty.join("wip.txt"), "uncommitted sibling work\n").unwrap();

        let dirty_probe = tree_dirty(dirty.to_str().unwrap());
        let clean_probe = tree_dirty(clean.to_str().unwrap());
        assert_eq!(dirty_probe, Ok(true));
        assert_eq!(clean_probe, Ok(false));
        assert!(dirty_gate_should_skip(&dirty_probe));
        assert!(!dirty_gate_should_skip(&clean_probe));

        // The worker's recording: the dirty repo's whole night is skipped
        // with the note; the clean repo's entry stays launchable.
        let db = Database::open_in_memory().unwrap();
        save_state(
            &db,
            &QueueState {
                started_at: 1,
                baseline_tokens: 0,
                entries: vec![
                    entry("s1", "/r/dirty", "queued"),
                    entry("s2", "/r/dirty", "queued"),
                    entry("s3", "/r/clean", "queued"),
                ],
                stopped_reason: None,
            },
        );
        skip_repo_queued(&db, "/r/dirty", DIRTY_TREE_NOTE);
        let s = load_state(&db).unwrap();
        for e in &s.entries[0..2] {
            assert_eq!(e.state, "stalled");
            assert_eq!(e.note.as_deref(), Some(DIRTY_TREE_NOTE));
            assert!(e.ended_at.is_some());
        }
        assert_eq!(s.entries[2].state, "queued");
        assert_eq!(s.entries[2].note, None);
        assert_eq!(next_launch_index(&s.entries, "/r/dirty"), None);
        assert_eq!(next_launch_index(&s.entries, "/r/clean"), Some(2));
    }

    #[test]
    fn note_parked_and_finish_round_trip_through_the_settings_row() {
        let db = Database::open_in_memory().unwrap();
        let state = QueueState {
            started_at: 1,
            baseline_tokens: 0,
            entries: vec![entry("plan-1", "/r/a", "launched")],
            stopped_reason: None,
        };
        save_state(&db, &state);
        // The deferred park flips the entry and records the review id…
        note_parked(&db, "plan-1", "rev-9");
        let s = load_state(&db).unwrap();
        assert_eq!(s.entries[0].state, "parked");
        assert_eq!(s.entries[0].review_id.as_deref(), Some("rev-9"));
        assert!(s.entries[0].ended_at.is_some());
        // …which is the durable morning link (survives a restart, unlike the
        // in-memory review-links map).
        assert_eq!(parked_plan_for_review(&db, "rev-9").as_deref(), Some("plan-1"));
        // A later stall classification must never downgrade the park.
        finish_entry(&db, "plan-1", "stalled", Some("late"));
        assert_eq!(load_state(&db).unwrap().entries[0].state, "parked");
        // Unknown plans are a quiet no-op.
        note_parked(&db, "ghost", "rev-x");
        assert_eq!(parked_plan_for_review(&db, "rev-x"), None);
    }
}
