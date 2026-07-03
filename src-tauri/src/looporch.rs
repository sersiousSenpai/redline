// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The **Loop Orchestrator**: once a reviewed plan is approved in Redline, this
//! engine decomposes it into parallelizable subtasks, runs **executor** agents
//! in isolated git worktrees (`worktree.rs`), has a **separate reviewer** agent
//! grade each output against a rubric (never the maker grading itself), persists
//! everything so long trajectories survive restarts, and pauses at **human
//! checkpoints** before any merge or the final land into the user's base.
//!
//! It is a near-clone of `mission.rs` — a keyed registry of `tokio::process::
//! Child`, resumable `claude` sessions, stream-json readers, and SQLite-persisted
//! turns — reusing `claude_proc` directly. The genuinely new subsystem is the
//! git worktree isolation in `worktree.rs`.
//!
//! Four nested loops: the **executor loop** (`spawn_subtask_cycle`), the
//! **verification loop** (reviewer + bounded retry), the **event-driven loop**
//! (`schedule`, re-entrant on every completion), and the **hill-climbing loop**
//! (`loop_analyze`, surface-only in v1).

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdout};
use tokio::sync::{oneshot, OwnedSemaphorePermit, Semaphore};

use crate::claude_proc::{classify_line, claude_command, resolve_claude_bin, StreamLine};
use crate::db::Database;
use crate::state::{
    now_millis, LoopAttempt, LoopCheckpoint, LoopRun, LoopSubtask, LoopTrace,
};
use crate::worktree::{slugify, MergeOutcome, WorktreeManager};

/// Human checkpoints hold for up to 12h (like the hook's held-POST timeout).
const CHECKPOINT_TIMEOUT: Duration = Duration::from_secs(12 * 60 * 60);

/// How often a running turn emits a `loop-heartbeat` (elapsed + liveness proof)
/// so the UI can show a live timer and know the turn hasn't silently died.
const HEARTBEAT_TICK: Duration = Duration::from_secs(3);

/// Planner stall ceiling: the planner is a single model call that streams
/// partial-message deltas *while it thinks*, so genuine progress is never
/// silent. If it emits nothing at all for this long it's wedged (not merely
/// slow), and we kill it and fail the run loudly instead of hanging forever on
/// "Planning…". Executors/reviewers are bounded separately by the turn budget.
const PLANNER_STALL: Duration = Duration::from_secs(300);

// --- Roles & process registry ----------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Role {
    Planner,
    Executor,
    Reviewer,
}

impl Role {
    fn as_str(self) -> &'static str {
        match self {
            Role::Planner => "planner",
            Role::Executor => "executor",
            Role::Reviewer => "reviewer",
        }
    }
}

/// One in-flight `claude` turn. Carries `run_id` so `loop_cancel` can kill every
/// process belonging to a run without knowing its per-turn key.
struct LoopProc {
    child: Child,
    run_id: String,
}

// --- Checkpoint gate (held-oneshot, modeled on `PendingResponses`) ----------

/// The human's decision on a held checkpoint. Not a bare bool — the stuck
/// checkpoint needs a multi-way choice plus an optional payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointDecision {
    /// merge: `approve` | `deny`. stuck: `edit_retry` | `skip` | `abandon`.
    /// land: `approve` | `deny`.
    pub action: String,
    pub note: Option<String>,
    pub edited_instructions: Option<String>,
}

/// Keyed by `checkpoint_id`. The in-memory sender is disposable; the pending
/// `loop_checkpoints` row is the durable truth, re-armed on restart.
#[derive(Clone)]
struct CheckpointGate {
    map: Arc<Mutex<HashMap<String, oneshot::Sender<CheckpointDecision>>>>,
}

impl CheckpointGate {
    fn new() -> Self {
        Self {
            map: Arc::new(Mutex::new(HashMap::new())),
        }
    }
    /// Arm a gate for `checkpoint_id`, returning the receiver the driver awaits.
    fn arm(&self, checkpoint_id: &str) -> oneshot::Receiver<CheckpointDecision> {
        let (tx, rx) = oneshot::channel();
        self.map.lock().unwrap().insert(checkpoint_id.to_string(), tx);
        rx
    }
    /// Take the sender for `checkpoint_id` (the decide command fires it).
    fn take(&self, checkpoint_id: &str) -> Option<oneshot::Sender<CheckpointDecision>> {
        self.map.lock().unwrap().remove(checkpoint_id)
    }
    fn drain(&self) {
        self.map.lock().unwrap().clear();
    }
}

// --- Engine state ----------------------------------------------------------

/// Registry + resources for the Loop Orchestrator, cloned into managed Tauri
/// state (all fields are `Arc`, so `Clone` is cheap and shares one engine).
#[derive(Clone)]
pub struct LoopState {
    /// One in-flight turn per key (`planner:<run>` or a subtask id).
    procs: Arc<Mutex<HashMap<String, LoopProc>>>,
    db: Arc<Database>,
    claude_bin: Arc<OnceLock<String>>,
    git: Arc<WorktreeManager>,
    /// Per-run `max_parallel` gate.
    sems: Arc<Mutex<HashMap<String, Arc<Semaphore>>>>,
    /// Per-run mutex serializing scheduling + merges (both mutate run progress).
    run_locks: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    checkpoints: CheckpointGate,
    /// Set once in `setup`; lets spawned tasks emit `loop-*` events.
    app: Arc<OnceLock<AppHandle>>,
}

impl LoopState {
    pub fn new(db: Arc<Database>, worktree_root: PathBuf) -> Self {
        Self {
            procs: Arc::new(Mutex::new(HashMap::new())),
            db,
            claude_bin: Arc::new(OnceLock::new()),
            git: Arc::new(WorktreeManager::new(worktree_root)),
            sems: Arc::new(Mutex::new(HashMap::new())),
            run_locks: Arc::new(Mutex::new(HashMap::new())),
            checkpoints: CheckpointGate::new(),
            app: Arc::new(OnceLock::new()),
        }
    }

    /// Wire the app handle so the engine can emit events. Called once in `setup`.
    pub fn attach_app(&self, app: AppHandle) {
        let _ = self.app.set(app);
    }

    /// A run's rubric/subtask lookups for the daemon routes, without exposing db.
    pub fn subtask(&self, subtask_id: &str) -> Option<LoopSubtask> {
        self.db.get_subtask(subtask_id).ok().flatten()
    }
    pub fn run(&self, run_id: &str) -> Option<LoopRun> {
        self.db.get_loop_run(run_id).ok().flatten()
    }
    pub fn run_subtasks(&self, run_id: &str) -> Vec<LoopSubtask> {
        self.db.list_subtasks(run_id).unwrap_or_default()
    }
    /// Latest reviewer feedback for a subtask (the resumed executor fetches this
    /// out-of-band, mirroring `/v1/sessions/:id/feedback`).
    pub fn latest_feedback(&self, subtask_id: &str) -> Option<String> {
        self.db
            .list_attempts(subtask_id)
            .ok()?
            .into_iter()
            .rev()
            .find(|a| a.role == "reviewer" && a.feedback.is_some())
            .and_then(|a| a.feedback)
    }
    #[allow(dead_code)] // exposed for future single-key reads; daemon lists by scope
    pub fn state_get(&self, run_id: &str, scope: &str, key: &str) -> Option<String> {
        self.db.loop_state_get(run_id, scope, key)
    }
    pub fn state_set(&self, run_id: &str, scope: &str, key: &str, value: &str) {
        let _ = self.db.loop_state_set(run_id, scope, key, value);
    }
    pub fn db_state_list(&self, run_id: &str, scope: &str) -> Vec<(String, String)> {
        self.db
            .loop_state_list(run_id, scope)
            .unwrap_or_default()
            .into_iter()
            .map(|e| (e.key, e.value))
            .collect()
    }

    async fn claude_bin(&self) -> Result<String, String> {
        let cell = self.claude_bin.clone();
        tokio::task::spawn_blocking(move || cell.get_or_init(resolve_claude_bin).clone())
            .await
            .map_err(|e| format!("failed to resolve the `claude` CLI: {e}"))
    }

    fn sem_for(&self, run_id: &str, max_parallel: i64) -> Arc<Semaphore> {
        let mut guard = self.sems.lock().unwrap();
        guard
            .entry(run_id.to_string())
            .or_insert_with(|| Arc::new(Semaphore::new(max_parallel.max(1) as usize)))
            .clone()
    }

    fn run_lock(&self, run_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut guard = self.run_locks.lock().unwrap();
        guard
            .entry(run_id.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    fn emit<P: Serialize + Clone>(&self, event: &str, payload: P) {
        if let Some(app) = self.app.get() {
            let _ = app.emit(event, payload);
        }
    }

    fn emit_run_status(&self, run_id: &str, status: &str) {
        let _ = self.db.update_loop_run_status(run_id, status);
        self.emit(
            "loop-run-status",
            RunStatusEvent {
                run_id: run_id.to_string(),
                status: status.to_string(),
            },
        );
    }

    fn set_subtask_status(&self, subtask_id: &str, status: &str) {
        let _ = self.db.update_subtask_status(subtask_id, status);
        if let Some(s) = self.db.get_subtask(subtask_id).ok().flatten() {
            self.emit("loop-subtask-status", s);
        }
    }

    fn trace(&self, run_id: &str, subtask_id: Option<&str>, kind: &str, body: &str) {
        let _ = self.db.insert_trace(&LoopTrace {
            id: uuid::Uuid::new_v4().to_string(),
            run_id: run_id.to_string(),
            subtask_id: subtask_id.map(str::to_string),
            attempt_id: None,
            kind: kind.to_string(),
            body: body.to_string(),
            created_at: now_millis(),
        });
    }

    /// Kill every running turn — backs `loop_kill_all` and teardown.
    pub fn kill_all(&self) {
        let drained: Vec<LoopProc> = {
            let mut guard = self.procs.lock().unwrap();
            guard.drain().map(|(_, p)| p).collect()
        };
        for mut proc in drained {
            let _ = proc.child.start_kill();
        }
        self.checkpoints.drain();
    }
}

// --- Event payloads --------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoopDelta {
    run_id: String,
    subtask_id: Option<String>,
    role: String,
    text: String,
}

/// Periodic "still working" pulse for an in-flight turn: carries how long the
/// turn has been running so the UI can render a live timer, and — by arriving at
/// all — proves the backend turn is alive (the planning card shows a live dot).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoopHeartbeat {
    run_id: String,
    subtask_id: Option<String>,
    role: String,
    elapsed_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunStatusEvent {
    run_id: String,
    status: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoopErrorEvent {
    run_id: String,
    error: String,
}

/// A composite view for the trajectory UI.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopSnapshot {
    run: LoopRun,
    subtasks: Vec<LoopSubtask>,
    checkpoints: Vec<LoopCheckpoint>,
}

// --- Turn plumbing ---------------------------------------------------------

struct TurnOutput {
    session_id: Option<String>,
    text: String,
}

enum TurnError {
    Cancelled,
    Failed(String),
}

impl LoopState {
    /// Spawn one headless `claude` turn under `key`, stream its deltas as
    /// `loop-delta` events, and await completion — returning the final text +
    /// session id (or a cancellation/failure). Unlike `mission.rs` this does NOT
    /// emit a terminal event; the caller (the subtask cycle) decides what the
    /// outcome means.
    #[allow(clippy::too_many_arguments)]
    async fn run_turn(
        &self,
        key: String,
        run_id: &str,
        subtask_id: Option<&str>,
        role: Role,
        args: Vec<String>,
        cwd: &std::path::Path,
        stall: Option<Duration>,
    ) -> Result<TurnOutput, TurnError> {
        let claude_bin = self
            .claude_bin()
            .await
            .map_err(TurnError::Failed)?;
        let mut cmd = claude_command(&claude_bin);
        let mut child = cmd
            .current_dir(cwd)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| TurnError::Failed(format!("failed to spawn claude: {e}")))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| TurnError::Failed("claude stdout unavailable".to_string()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| TurnError::Failed("claude stderr unavailable".to_string()))?;
        {
            self.procs.lock().unwrap().insert(
                key.clone(),
                LoopProc {
                    child,
                    run_id: run_id.to_string(),
                },
            );
        }

        // Drive the stream alongside a heartbeat ticker: every tick emits a
        // `loop-heartbeat` (live timer + liveness proof) and, when a `stall`
        // ceiling is set (the planner), kills a wedged turn that has produced no
        // output for that long so it fails loudly instead of hanging.
        let started = Instant::now();
        // Milliseconds-into-the-turn at the last byte of output; 0 = nothing yet.
        let last_activity = Arc::new(AtomicU64::new(0));
        let stream_fut =
            self.read_stream(run_id, subtask_id, role, stdout, stderr, started, last_activity.clone());
        tokio::pin!(stream_fut);
        let mut stalled = false;
        let (session, final_text, errored, saw_json) = loop {
            tokio::select! {
                res = &mut stream_fut => break res,
                _ = tokio::time::sleep(HEARTBEAT_TICK) => {
                    let elapsed = started.elapsed();
                    self.emit(
                        "loop-heartbeat",
                        LoopHeartbeat {
                            run_id: run_id.to_string(),
                            subtask_id: subtask_id.map(str::to_string),
                            role: role.as_str().to_string(),
                            elapsed_ms: elapsed.as_millis() as u64,
                        },
                    );
                    if let Some(limit) = stall {
                        let last = last_activity.load(Ordering::Relaxed);
                        let silent = elapsed.saturating_sub(Duration::from_millis(last));
                        if !stalled && silent >= limit {
                            // Wedged: kill the child so the stream reader unblocks
                            // and the loop resolves; reported as a stall below.
                            if let Some(mut p) = self.procs.lock().unwrap().remove(&key) {
                                let _ = p.child.start_kill();
                            }
                            stalled = true;
                        }
                    }
                }
            }
        };

        if stalled {
            let secs = stall.map(|d| d.as_secs()).unwrap_or(0);
            return Err(TurnError::Failed(format!(
                "claude produced no output for {secs}s — killed as stalled"
            )));
        }

        let proc = { self.procs.lock().unwrap().remove(&key) };
        let cancelled = proc.is_none() && final_text.is_none();
        let exit_ok = match proc {
            Some(mut p) => p.child.wait().await.map(|s| s.success()).unwrap_or(false),
            None => false,
        };

        if cancelled {
            return Err(TurnError::Cancelled);
        }
        if let Some(err) = errored {
            return Err(TurnError::Failed(err));
        }
        match final_text {
            Some(text) if !text.trim().is_empty() => Ok(TurnOutput {
                session_id: session,
                text,
            }),
            Some(_) => Err(TurnError::Failed("claude produced an empty reply".to_string())),
            None => {
                let why = if !exit_ok {
                    "claude exited abnormally".to_string()
                } else if !saw_json {
                    "claude produced no parseable output".to_string()
                } else {
                    "claude ended without producing a reply".to_string()
                };
                Err(TurnError::Failed(why))
            }
        }
    }

    /// Read one turn's stdout JSONL → `loop-delta`s + accumulated final text,
    /// draining stderr concurrently. Mirrors `mission::read_mission`'s reader.
    #[allow(clippy::too_many_arguments)]
    async fn read_stream(
        &self,
        run_id: &str,
        subtask_id: Option<&str>,
        role: Role,
        stdout: ChildStdout,
        stderr: ChildStderr,
        started: Instant,
        last_activity: Arc<AtomicU64>,
    ) -> (Option<String>, Option<String>, Option<String>, bool) {
        let stdout_fut = async {
            let mut reader = BufReader::new(stdout).lines();
            let mut session: Option<String> = None;
            let mut final_text: Option<String> = None;
            let mut errored: Option<String> = None;
            let mut saw_json = false;
            while let Ok(Some(line)) = reader.next_line().await {
                // Any byte of output resets the stall clock — proof the turn is
                // making progress even if it's only streaming a partial message.
                last_activity.store(started.elapsed().as_millis() as u64, Ordering::Relaxed);
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<Value>(trimmed) else {
                    continue;
                };
                saw_json = true;
                match classify_line(&v) {
                    StreamLine::Init(sid) => session = Some(sid),
                    StreamLine::Delta(text) => self.emit(
                        "loop-delta",
                        LoopDelta {
                            run_id: run_id.to_string(),
                            subtask_id: subtask_id.map(str::to_string),
                            role: role.as_str().to_string(),
                            text,
                        },
                    ),
                    StreamLine::Final { text, session_id } => {
                        if session_id.is_some() {
                            session = session_id;
                        }
                        final_text = Some(text);
                    }
                    StreamLine::Failed(msg) => errored = Some(msg),
                    StreamLine::Ignore => {}
                }
            }
            (session, final_text, errored, saw_json)
        };
        let stderr_fut = async {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(_)) = lines.next_line().await {}
        };
        let (out, ()) = tokio::join!(stdout_fut, stderr_fut);
        out
    }
}

// --- Argument builders (pure, testable) ------------------------------------

fn base_turn_args(prompt: &str) -> Vec<String> {
    vec![
        "-p".to_string(),
        prompt.to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--include-partial-messages".to_string(),
        "--verbose".to_string(),
        "--strict-mcp-config".to_string(),
    ]
}

/// Planner/reviewer read-only surface: no Edit/Write tool exists, so the agent
/// physically cannot modify files even under `bypassPermissions`.
fn read_only_args(prompt: &str) -> Vec<String> {
    let mut a = base_turn_args(prompt);
    a.extend([
        "--permission-mode".to_string(),
        "bypassPermissions".to_string(),
        "--tools".to_string(),
        "Read,Grep,Glob,Bash".to_string(),
    ]);
    a
}

/// The executor genuinely edits, in an isolated throwaway worktree — hence the
/// edit tools + `bypassPermissions` (no interactive prompt is possible headless,
/// and the blast radius is one disposable worktree). `--resume` on retries
/// carries maker context + reviewer feedback.
fn build_executor_args(prompt: &str, resume: Option<&str>) -> Vec<String> {
    let mut a = base_turn_args(prompt);
    a.extend([
        "--permission-mode".to_string(),
        "bypassPermissions".to_string(),
        "--tools".to_string(),
        "Read,Edit,Write,Grep,Glob,Bash".to_string(),
    ]);
    if let Some(sid) = resume {
        a.push("--resume".to_string());
        a.push(sid.to_string());
    }
    a
}

/// The reviewer is ALWAYS a fresh grader — never `--resume` of the executor
/// session (the load-bearing maker/grader separation; enforced by this function
/// having no resume parameter, and by `reviewer_never_resumes` below).
fn build_reviewer_args(prompt: &str) -> Vec<String> {
    read_only_args(prompt)
}

// --- Planner prompt + decomposition ----------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlannerSubtask {
    title: String,
    instructions: String,
    #[serde(default)]
    rubric: String,
    #[serde(default)]
    touched_paths: Vec<String>,
    #[serde(default)]
    deps: Vec<String>,
    #[serde(default)]
    irreversible: bool,
}

fn build_planner_prompt(plan_md: &str, corrective: bool) -> String {
    let mut p = String::from(
        "You are the PLANNER of a Loop Orchestrator run in Redline. An approved \
         implementation plan follows. Decompose it into independent, individually-\
         verifiable subtasks that executor agents can each complete in an isolated \
         git worktree, and that a separate reviewer can grade against a concrete \
         rubric. You are in the target repository — use Read/Grep/Glob to ground \
         the decomposition in the real files. Follow the `loop-orchestrator` skill \
         (planner contract).\n\n\
         Requirements per subtask: independence (minimal shared files), a machine-\
         checkable rubric (each criterion a pass/fail assertion + the exact command \
         or observation that checks it), bounded scope, an explicit `deps` list \
         (referencing other subtasks by their exact `title`), declared `touchedPaths` \
         (file globs you expect to modify — mandatory, machine-checked), and an \
         `irreversible` flag for migrations/deploys/network.\n\n\
         Output EXACTLY ONE fenced ```json code block containing an array of objects \
         `[{\"title\",\"instructions\",\"rubric\",\"touchedPaths\",\"deps\",\"irreversible\"}]` \
         and NOTHING else — no prose before or after.\n\n",
    );
    if corrective {
        p.push_str(
            "IMPORTANT: your previous reply could not be parsed as a JSON array. \
             Reply with ONLY the fenced ```json array this time.\n\n",
        );
    }
    p.push_str("The approved plan:\n\n");
    p.push_str(plan_md);
    p
}

/// Extract the last fenced ```json block (or the last balanced `[...]`) from a
/// possibly-chatty reply. The planner/reviewer are told to emit only JSON, but a
/// stray sentence must not break parsing.
fn extract_last_json_array(text: &str) -> Option<String> {
    // Prefer fenced blocks. Scan all ``` fences; keep the last whose body starts
    // with `[`.
    let mut best: Option<String> = None;
    let bytes = text.as_bytes();
    let mut i = 0;
    while let Some(open) = text[i..].find("```") {
        let start = i + open + 3;
        // Skip an optional language tag on the same line.
        let after_lang = match text[start..].find('\n') {
            Some(nl) => start + nl + 1,
            None => break,
        };
        let Some(close_rel) = text[after_lang..].find("```") else {
            break;
        };
        let body = text[after_lang..after_lang + close_rel].trim();
        if body.starts_with('[') {
            best = Some(body.to_string());
        }
        i = after_lang + close_rel + 3;
        if i >= bytes.len() {
            break;
        }
    }
    if best.is_some() {
        return best;
    }
    // Fallback: last top-level balanced [...] .
    let open = text.rfind('[')?;
    let mut depth = 0i32;
    for (idx, ch) in text[open..].char_indices() {
        match ch {
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(text[open..open + idx + 1].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

/// True when two globbed path-sets are considered overlapping for the purpose of
/// adding a synthetic serialization edge. Pragmatic (the runtime scope check is
/// the real guard): equal after glob-stripping, or one prefix contains the other.
fn paths_overlap(a: &[String], b: &[String]) -> bool {
    fn prefix(glob: &str) -> String {
        // Strip trailing glob segments so `src/foo/**`, `src/foo/*`, `src/foo/`
        // all reduce to `src/foo`.
        let g = glob.trim().trim_end_matches('/');
        let cut = g.find(['*', '?', '[']).unwrap_or(g.len());
        g[..cut].trim_end_matches('/').to_string()
    }
    for x in a {
        let px = prefix(x);
        for y in b {
            let py = prefix(y);
            if px.is_empty() || py.is_empty() {
                continue;
            }
            if px == py
                || px.starts_with(&format!("{py}/"))
                || py.starts_with(&format!("{px}/"))
                || x.trim() == y.trim()
            {
                return true;
            }
        }
    }
    false
}

/// Extract the last fenced ```json object (or last balanced `{...}`) — the
/// reviewer's `{verdict,score,feedback}`.
fn extract_last_json_object(text: &str) -> Option<String> {
    let mut best: Option<String> = None;
    let mut i = 0;
    while let Some(open) = text[i..].find("```") {
        let start = i + open + 3;
        let after_lang = match text[start..].find('\n') {
            Some(nl) => start + nl + 1,
            None => break,
        };
        let Some(close_rel) = text[after_lang..].find("```") else {
            break;
        };
        let body = text[after_lang..after_lang + close_rel].trim();
        if body.starts_with('{') {
            best = Some(body.to_string());
        }
        i = after_lang + close_rel + 3;
    }
    if best.is_some() {
        return best;
    }
    let open = text.rfind('{')?;
    let mut depth = 0i32;
    for (idx, ch) in text[open..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(text[open..open + idx + 1].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

/// Glob-lite match: `*`/`**` are both "any run of characters". Exact and
/// directory-prefix matches are handled specially. Backs the scope check —
/// pragmatic, not a full glob engine.
fn simple_glob_match(pat: &str, path: &str) -> bool {
    let pat = pat.trim();
    let path = path.trim();
    if pat == path {
        return true;
    }
    if !pat.contains('*') && !pat.contains('?') {
        let dir = pat.trim_end_matches('/');
        return path == dir || path.starts_with(&format!("{dir}/"));
    }
    wildcard_match(pat, path)
}

fn wildcard_match(pat: &str, path: &str) -> bool {
    let parts: Vec<&str> = pat.split('*').filter(|s| !s.is_empty()).collect();
    if parts.is_empty() {
        return true; // pattern was all stars
    }
    let starts_star = pat.starts_with('*');
    let ends_star = pat.ends_with('*');
    let mut pos = 0usize;
    for (i, part) in parts.iter().enumerate() {
        match path[pos..].find(part) {
            Some(idx) => {
                if i == 0 && !starts_star && idx != 0 {
                    return false;
                }
                pos += idx + part.len();
            }
            None => return false,
        }
    }
    if !ends_star {
        return path.ends_with(parts.last().unwrap());
    }
    true
}

/// Files that strayed outside the declared scope, or `None` when everything is
/// in-scope. An empty declaration means "not enforced" (returns `None`).
fn out_of_scope(changed: &[String], globs: &[String]) -> Option<Vec<String>> {
    if globs.is_empty() {
        return None;
    }
    let stray: Vec<String> = changed
        .iter()
        .filter(|p| !globs.iter().any(|g| simple_glob_match(g, p)))
        .cloned()
        .collect();
    if stray.is_empty() {
        None
    } else {
        Some(stray)
    }
}

// --- Executor / reviewer prompts -------------------------------------------

fn build_executor_prompt(
    subtask: &LoopSubtask,
    worktree: &std::path::Path,
    feedback: Option<&str>,
) -> String {
    let id = &subtask.subtask_id;
    let run = &subtask.run_id;
    let paths = if subtask.touched_paths.is_empty() {
        "(none declared)".to_string()
    } else {
        subtask.touched_paths.join(", ")
    };
    let mut p = format!(
        "You are the EXECUTOR for one subtask of a Loop Orchestrator run, working \
         in an ISOLATED git worktree at `{wt}`. Follow the `loop-orchestrator` \
         skill (executor contract).\n\n\
         Your subtask id is `{id}`. Fetch your full contract (title, instructions, \
         rubric, declared touched paths) with:\n  \
         curl -s 'http://127.0.0.1:7676/v1/loop/subtask?id={id}'\n\n\
         Subtask: {title}\n\n{instructions}\n\n\
         Declared touched paths (STAY WITHIN THESE): {paths}\n\n\
         Make the smallest correct change that satisfies the rubric. Run the \
         verification commands yourself before you finish. Record progress with a \
         POST to http://127.0.0.1:7676/v1/loop/state (fields run=`{run}`, \
         scope=`{id}`, key, value). Do NOT run `git commit` — the orchestrator \
         commits your worktree. Do NOT edit files outside your declared touched \
         paths. End by stating exactly what you changed and how you verified it.",
        wt = worktree.display(),
        title = subtask.title,
        instructions = subtask.instructions,
    );
    if let Some(fb) = feedback.filter(|f| !f.trim().is_empty()) {
        p.push_str(&format!(
            "\n\nA PREVIOUS ATTEMPT WAS REJECTED. The reviewer said:\n> {}\n\
             Address this specifically. You can also re-fetch it out-of-band:\n  \
             curl -s 'http://127.0.0.1:7676/v1/loop/feedback?id={id}'",
            fb.replace('\n', "\n> ")
        ));
    }
    p
}

fn build_reviewer_prompt(subtask: &LoopSubtask, integration_branch: &str) -> String {
    format!(
        "You are the REVIEWER for one subtask of a Loop Orchestrator run. You did \
         NOT write this code — you are a separate, strict grader. Follow the \
         `loop-orchestrator` skill (reviewer contract).\n\n\
         Inspect the change by running, in this worktree:\n  \
         git diff {ib}\n\n\
         Grade STRICTLY and ONLY against this rubric — nothing else:\n\n{rubric}\n\n\
         Output EXACTLY ONE fenced ```json block \
         {{\"verdict\":\"pass|fail\",\"score\":<0-100>,\"feedback\":\"<actionable>\"}} \
         and nothing else. Never edit files. Never rubber-stamp.",
        ib = integration_branch,
        rubric = subtask.rubric,
    )
}

#[derive(Debug, Deserialize)]
struct ReviewerVerdict {
    verdict: String,
    #[serde(default)]
    score: Option<i64>,
    #[serde(default)]
    feedback: Option<String>,
}

// --- Orchestration ---------------------------------------------------------

impl LoopState {
    /// The planner pass + first schedule, run off-thread so `loop_start` returns
    /// immediately with a `planning` run the UI can show.
    async fn run_planner_and_start(&self, run_id: String) {
        let Some(run) = self.run(&run_id) else {
            return;
        };
        let repo = PathBuf::from(&run.repo_path);
        let run8 = run.run_id[..8].to_string();

        // Planner turn — one retry on unparseable JSON.
        let mut subtasks: Option<Vec<PlannerSubtask>> = None;
        let mut planner_session: Option<String> = None;
        for attempt in 0..2 {
            let prompt = build_planner_prompt(&run.plan_md, attempt > 0);
            let args = read_only_args(&prompt);
            match self
                .run_turn(
                    format!("planner:{run_id}"),
                    &run_id,
                    None,
                    Role::Planner,
                    args,
                    &repo,
                    Some(PLANNER_STALL),
                )
                .await
            {
                Ok(out) => {
                    planner_session = out.session_id.clone();
                    if let Some(json) = extract_last_json_array(&out.text) {
                        if let Ok(parsed) = serde_json::from_str::<Vec<PlannerSubtask>>(&json) {
                            if !parsed.is_empty() {
                                subtasks = Some(parsed);
                                break;
                            }
                        }
                    }
                    // else loop to the corrective retry
                }
                Err(TurnError::Cancelled) => {
                    self.emit_run_status(&run_id, "cancelled");
                    return;
                }
                Err(TurnError::Failed(e)) => {
                    self.fail_run(&run_id, &format!("planner failed: {e}"));
                    return;
                }
            }
        }
        let Some(planner_subtasks) = subtasks else {
            self.fail_run(&run_id, "the planner did not produce a valid subtask array");
            return;
        };
        if let Some(sid) = &planner_session {
            let _ = self.db.set_planner_session(&run_id, sid);
        }

        // Persist subtasks with seq/branch/slug + resolved deps + synthetic edges.
        let built = self.materialize_subtasks(&run, &run8, &planner_subtasks);
        for s in &built {
            if let Err(e) = self.db.insert_loop_subtask(s) {
                self.fail_run(&run_id, &format!("failed to persist subtasks: {e}"));
                return;
            }
        }

        // Cut the integration branch + worktree.
        if let Err(e) = self
            .git
            .init_integration(&repo, &run.integration_branch, &run.base_ref, &run8)
            .await
        {
            self.fail_run(&run_id, &format!("failed to create the integration branch: {e}"));
            return;
        }

        self.trace(
            &run_id,
            None,
            "planner",
            &format!("decomposed into {} subtasks", built.len()),
        );

        // Ripeness warnings are surfaced (trace) but non-blocking in v1; a dirty
        // repo was already a hard stop in `loop_start`.
        for w in ripeness_warnings(&built) {
            self.trace(&run_id, None, "termination", &format!("ripeness: {w}"));
        }

        self.emit_run_status(&run_id, "running");
        self.schedule(run_id).await;
    }

    /// Turn the planner's raw array into persisted `LoopSubtask`s: assign
    /// seq/branch/slug, resolve `deps` (declared by title) to subtask ids, and
    /// add synthetic serialization edges between overlapping `touchedPaths`.
    fn materialize_subtasks(
        &self,
        run: &LoopRun,
        run8: &str,
        raw: &[PlannerSubtask],
    ) -> Vec<LoopSubtask> {
        // First pass: mint ids + branches.
        let mut built: Vec<LoopSubtask> = raw
            .iter()
            .enumerate()
            .map(|(i, r)| {
                let seq = (i + 1) as i64;
                let slug = slugify(&r.title);
                LoopSubtask {
                    subtask_id: uuid::Uuid::new_v4().to_string(),
                    run_id: run.run_id.clone(),
                    seq,
                    title: r.title.clone(),
                    instructions: r.instructions.clone(),
                    rubric: r.rubric.clone(),
                    deps: Vec::new(),
                    touched_paths: r.touched_paths.clone(),
                    status: "pending".to_string(),
                    branch: Some(format!("redline/loop/{run8}/{seq}-{slug}")),
                    worktree_path: None,
                    attempts: 0,
                    executor_session_id: None,
                    irreversible: r.irreversible,
                }
            })
            .collect();

        // Title → id lookup (case-insensitive) for declared deps.
        let by_title: HashMap<String, String> = built
            .iter()
            .map(|s| (s.title.trim().to_lowercase(), s.subtask_id.clone()))
            .collect();

        // Resolve declared deps.
        for (i, r) in raw.iter().enumerate() {
            let mut deps: Vec<String> = Vec::new();
            for d in &r.deps {
                if let Some(id) = by_title.get(&d.trim().to_lowercase()) {
                    if id != &built[i].subtask_id && !deps.contains(id) {
                        deps.push(id.clone());
                    }
                }
            }
            built[i].deps = deps;
        }

        // Synthetic file-overlap edges: for any pair whose touchedPaths overlap,
        // serialize lower-seq → higher-seq (add the lower as a dep of the higher).
        for hi in 0..built.len() {
            for lo in 0..hi {
                if paths_overlap(&built[lo].touched_paths, &built[hi].touched_paths) {
                    let lo_id = built[lo].subtask_id.clone();
                    if !built[hi].deps.contains(&lo_id) {
                        built[hi].deps.push(lo_id);
                    }
                }
            }
        }
        built
    }

    /// The event-driven loop: (re-)schedule ready subtasks, detect terminal
    /// state, open the land checkpoint, or fail a deadlocked DAG. Serialized per
    /// run and a no-op unless the run is `running`.
    async fn schedule(&self, run_id: String) {
        let lock = self.run_lock(&run_id);
        let _guard = lock.lock().await;

        let Some(run) = self.run(&run_id) else {
            return;
        };
        if run.status != "running" {
            return;
        }
        let subtasks = self.run_subtasks(&run_id);
        // Local status map, mutated as we mark blocked / spawn.
        let mut status: HashMap<String, String> =
            subtasks.iter().map(|s| (s.subtask_id.clone(), s.status.clone())).collect();

        let is_doomed = |st: &str| st == "failed";
        // Fixpoint: mark pending subtasks blocked when a dep is doomed/blocked.
        loop {
            let mut changed = false;
            for s in &subtasks {
                if status.get(&s.subtask_id).map(String::as_str) != Some("pending") {
                    continue;
                }
                let blocked = s.deps.iter().any(|d| {
                    let ds = status.get(d).map(String::as_str).unwrap_or("failed");
                    is_doomed(ds) || ds == "blocked"
                });
                if blocked {
                    status.insert(s.subtask_id.clone(), "blocked".to_string());
                    self.set_subtask_status(&s.subtask_id, "blocked");
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }

        // Ready = pending with every dep merged/skipped.
        let sem = self.sem_for(&run_id, run.max_parallel);
        let mut spawned = 0usize;
        for s in &subtasks {
            if status.get(&s.subtask_id).map(String::as_str) != Some("pending") {
                continue;
            }
            let ready = s.deps.iter().all(|d| {
                matches!(status.get(d).map(String::as_str), Some("merged") | Some("skipped"))
            });
            if !ready {
                continue;
            }
            match Semaphore::try_acquire_owned(sem.clone()) {
                Ok(permit) => {
                    status.insert(s.subtask_id.clone(), "running".to_string());
                    self.set_subtask_status(&s.subtask_id, "running");
                    self.clone().spawn_subtask_cycle(s.clone(), permit);
                    spawned += 1;
                }
                Err(_) => break, // out of permits; a later completion re-schedules
            }
        }

        // Terminal / deadlock detection against the updated local map.
        let in_flight = subtasks.iter().any(|s| {
            matches!(
                status.get(&s.subtask_id).map(String::as_str),
                Some("running") | Some("reviewing") | Some("needs_changes") | Some("awaiting_merge")
            )
        });
        let all_terminal = subtasks.iter().all(|s| {
            matches!(
                status.get(&s.subtask_id).map(String::as_str),
                Some("merged") | Some("skipped") | Some("failed")
            )
        });

        if all_terminal {
            let any_merged = subtasks
                .iter()
                .any(|s| status.get(&s.subtask_id).map(String::as_str) == Some("merged"));
            let any_failed = subtasks
                .iter()
                .any(|s| status.get(&s.subtask_id).map(String::as_str) == Some("failed"));
            drop(_guard);
            if any_merged {
                self.open_land_checkpoint(&run).await;
            } else if any_failed {
                self.fail_run(&run_id, "all subtasks failed or were skipped");
            } else {
                self.finish_run(&run_id);
            }
            return;
        }

        if !in_flight && spawned == 0 {
            drop(_guard);
            self.trace(&run_id, None, "termination", "deadlock: no ready subtasks but work remains");
            self.fail_run(&run_id, "the subtask DAG deadlocked (a cycle or an abandoned prerequisite)");
        }
    }

    /// One subtask's full executor→reviewer→retry cycle, holding a `max_parallel`
    /// permit for its duration. Exits by opening a merge or stuck checkpoint, or
    /// on a terminal/cancelled outcome; then re-schedules the run.
    fn spawn_subtask_cycle(self, subtask: LoopSubtask, permit: OwnedSemaphorePermit) {
        tauri::async_runtime::spawn(async move {
            let _permit = permit; // released when this task ends
            let subtask_id = subtask.subtask_id.clone();
            let run_id = subtask.run_id.clone();
            let Some(run) = self.run(&run_id) else {
                return;
            };
            let run8 = run.run_id[..8].to_string();
            let repo = PathBuf::from(&run.repo_path);
            let ib = run.integration_branch.clone();
            let branch = subtask
                .branch
                .clone()
                .unwrap_or_else(|| format!("redline/loop/{run8}/{}-task", subtask.seq));
            let slug = slugify(&subtask.title);

            // Ensure (or reuse) the worktree, forked off the integration tip.
            let worktree = match self
                .git
                .create_worktree(&repo, &ib, &branch, &run8, subtask.seq, &slug)
                .await
            {
                Ok(w) => w,
                Err(e) => {
                    self.trace(&run_id, Some(&subtask_id), "error", &format!("worktree: {e}"));
                    self.set_subtask_status(&subtask_id, "failed");
                    self.schedule(run_id).await;
                    return;
                }
            };
            let _ = self.db.set_subtask_worktree(&subtask_id, &worktree.to_string_lossy());

            let budget = Duration::from_secs((run.turn_budget.max(1) as u64) * 60);

            loop {
                // Bail if the run was cancelled/failed out from under us.
                match self.run(&run_id) {
                    Some(r) if r.status == "running" || r.status == "paused_checkpoint" => {}
                    _ => return,
                }
                let attempt_no = self.db.incr_subtask_attempts(&subtask_id).unwrap_or(1);
                self.set_subtask_status(&subtask_id, "running");

                // --- Executor turn ---
                let resume = self.db.get_executor_session(&subtask_id);
                let feedback = if resume.is_some() {
                    self.latest_feedback(&subtask_id)
                } else {
                    None
                };
                let fresh = self.subtask(&subtask_id).unwrap_or_else(|| subtask.clone());
                let ex_prompt = build_executor_prompt(&fresh, &worktree, feedback.as_deref());
                let ex_args = build_executor_args(&ex_prompt, resume.as_deref());
                let ex_attempt = self.new_attempt(&subtask_id, attempt_no, Role::Executor);

                let ex_result = tokio::time::timeout(
                    budget,
                    self.run_turn(
                        subtask_id.clone(),
                        &run_id,
                        Some(&subtask_id),
                        Role::Executor,
                        ex_args,
                        &worktree,
                        None,
                    ),
                )
                .await;

                match ex_result {
                    Err(_elapsed) => {
                        // Budget exceeded — kill any lingering child, fail attempt.
                        if let Some(mut p) = self.procs.lock().unwrap().remove(&subtask_id) {
                            let _ = p.child.start_kill();
                        }
                        let _ = self.db.finish_attempt(&ex_attempt, "error", None, None, Some("exceeded turn budget"), None, None);
                        self.trace(&run_id, Some(&subtask_id), "termination", "executor exceeded turn budget");
                        if self.route_failure(&run, &subtask_id, attempt_no, "the executor exceeded its turn budget").await {
                            self.schedule(run_id).await;
                            return;
                        }
                        continue;
                    }
                    Ok(Err(TurnError::Cancelled)) => {
                        let _ = self.db.finish_attempt(&ex_attempt, "error", None, None, None, None, None);
                        return;
                    }
                    Ok(Err(TurnError::Failed(e))) => {
                        let _ = self.db.finish_attempt(&ex_attempt, "error", None, None, Some(&e), None, None);
                        if self.route_failure(&run, &subtask_id, attempt_no, &format!("the executor failed to run: {e}")).await {
                            self.schedule(run_id).await;
                            return;
                        }
                        continue;
                    }
                    Ok(Ok(out)) => {
                        if let Some(sid) = &out.session_id {
                            let _ = self.db.set_executor_session(&subtask_id, sid);
                        }
                        let _ = self.db.finish_attempt(&ex_attempt, "complete", None, None, None, None, out.session_id.as_deref());
                    }
                }

                // --- Scope check + commit ---
                let changed = self.git.changed_paths(&worktree, &ib).await.unwrap_or_default();
                if changed.is_empty() {
                    if self.route_failure(&run, &subtask_id, attempt_no, "no changes were made to the worktree").await {
                        self.schedule(run_id).await;
                        return;
                    }
                    continue;
                }
                if let Some(stray) = out_of_scope(&changed, &fresh.touched_paths) {
                    let msg = format!(
                        "you edited files outside your declared touched paths ({}); revert them or stay in scope",
                        stray.join(", ")
                    );
                    self.trace(&run_id, Some(&subtask_id), "error", &msg);
                    if self.route_failure(&run, &subtask_id, attempt_no, &msg).await {
                        self.schedule(run_id).await;
                        return;
                    }
                    continue;
                }
                let commit_msg = format!("{}: attempt {}", fresh.title, attempt_no);
                if let Err(e) = self.git.commit_all(&worktree, &commit_msg).await {
                    self.trace(&run_id, Some(&subtask_id), "error", &format!("commit: {e}"));
                }
                let diff_stat = self.git.diff_stat(&worktree, &ib).await.unwrap_or_default();

                // --- Reviewer turn (SEPARATE agent, never resumes the executor) ---
                self.set_subtask_status(&subtask_id, "reviewing");
                let rv_prompt = build_reviewer_prompt(&fresh, &ib);
                let rv_args = build_reviewer_args(&rv_prompt);
                let rv_attempt = self.new_attempt(&subtask_id, attempt_no, Role::Reviewer);
                let rv = self
                    .run_turn(
                        subtask_id.clone(),
                        &run_id,
                        Some(&subtask_id),
                        Role::Reviewer,
                        rv_args,
                        &worktree,
                        None,
                    )
                    .await;

                let verdict = match rv {
                    Err(TurnError::Cancelled) => {
                        let _ = self.db.finish_attempt(&rv_attempt, "error", None, None, None, None, None);
                        return;
                    }
                    Err(TurnError::Failed(e)) => {
                        let _ = self.db.finish_attempt(&rv_attempt, "error", Some("fail"), None, Some(&e), Some(&diff_stat), None);
                        ReviewerVerdict { verdict: "fail".into(), score: None, feedback: Some(format!("reviewer errored: {e}")) }
                    }
                    Ok(out) => extract_last_json_object(&out.text)
                        .and_then(|j| serde_json::from_str::<ReviewerVerdict>(&j).ok())
                        .unwrap_or(ReviewerVerdict {
                            verdict: "fail".into(),
                            score: None,
                            feedback: Some("the reviewer did not emit a parseable verdict".into()),
                        }),
                };

                let passed = verdict.verdict.trim().eq_ignore_ascii_case("pass");
                let _ = self.db.finish_attempt(
                    &rv_attempt,
                    "complete",
                    Some(if passed { "pass" } else { "fail" }),
                    verdict.score,
                    verdict.feedback.as_deref(),
                    Some(&diff_stat),
                    None,
                );
                self.trace(
                    &run_id,
                    Some(&subtask_id),
                    "reviewer_verdict",
                    &format!("{} — {}", if passed { "pass" } else { "fail" }, verdict.feedback.as_deref().unwrap_or("")),
                );

                if passed {
                    self.set_subtask_status(&subtask_id, "awaiting_merge");
                    // Permit released on return; the merge happens behind a checkpoint.
                    self.create_checkpoint(&run_id, Some(&subtask_id), "merge", &diff_stat).await;
                    return;
                }
                // Failed: retry (resume executor) or open the stuck checkpoint.
                if attempt_no >= run.max_attempts {
                    self.set_subtask_status(&subtask_id, "stuck");
                    let summary = format!(
                        "Exhausted {} attempts.\n\nLast reviewer feedback:\n{}\n\nDiff:\n{}",
                        run.max_attempts,
                        verdict.feedback.as_deref().unwrap_or("(none)"),
                        diff_stat
                    );
                    self.create_checkpoint(&run_id, Some(&subtask_id), "subtask_stuck", &summary).await;
                    return;
                }
                self.set_subtask_status(&subtask_id, "needs_changes");
                // loop → re-spawn executor resuming with feedback
            }
        });
    }

    /// Shared failure routing for a non-reviewer failure (budget/exec/scope/no-op):
    /// returns `true` when the retry cap is hit and a stuck checkpoint was opened
    /// (caller should stop), `false` to retry the loop.
    async fn route_failure(&self, run: &LoopRun, subtask_id: &str, attempt_no: i64, reason: &str) -> bool {
        if attempt_no >= run.max_attempts {
            self.set_subtask_status(subtask_id, "stuck");
            let summary = format!("Exhausted {} attempts.\n\n{}", run.max_attempts, reason);
            self.create_checkpoint(&run.run_id, Some(subtask_id), "subtask_stuck", &summary).await;
            true
        } else {
            self.set_subtask_status(subtask_id, "needs_changes");
            false
        }
    }

    fn new_attempt(&self, subtask_id: &str, attempt_no: i64, role: Role) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let _ = self.db.insert_attempt(&LoopAttempt {
            attempt_id: id.clone(),
            subtask_id: subtask_id.to_string(),
            attempt_no,
            role: role.as_str().to_string(),
            status: "running".to_string(),
            verdict: None,
            score: None,
            feedback: None,
            diff_stat: None,
            claude_session_id: None,
            created_at: now_millis(),
        });
        id
    }

    // --- Checkpoints ------------------------------------------------------

    /// Insert + arm a checkpoint, pause the run, and spawn its decision driver.
    async fn create_checkpoint(&self, run_id: &str, subtask_id: Option<&str>, kind: &str, summary: &str) {
        let cp = LoopCheckpoint {
            checkpoint_id: uuid::Uuid::new_v4().to_string(),
            run_id: run_id.to_string(),
            subtask_id: subtask_id.map(str::to_string),
            kind: kind.to_string(),
            summary: summary.to_string(),
            decision_json: None,
            status: "pending".to_string(),
            created_at: now_millis(),
            decided_at: None,
        };
        let _ = self.db.insert_checkpoint(&cp);
        self.trace(run_id, subtask_id, "checkpoint", &format!("{kind} checkpoint opened"));
        self.emit_run_status(run_id, "paused_checkpoint");
        self.emit("loop-checkpoint", cp.clone());
        self.spawn_checkpoint_driver(cp);
    }

    /// Arm the gate and await the human decision (or a 12h expiry), then dispatch.
    fn spawn_checkpoint_driver(&self, cp: LoopCheckpoint) {
        let rx = self.checkpoints.arm(&cp.checkpoint_id);
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            let decision = tokio::select! {
                d = rx => d.ok(),
                _ = tokio::time::sleep(CHECKPOINT_TIMEOUT) => None,
            };
            match decision {
                Some(d) => {
                    let status = if d.action == "deny" { "denied" } else { "approved" };
                    let json = serde_json::to_string(&d).ok();
                    let _ = this.db.decide_checkpoint(&cp.checkpoint_id, status, json.as_deref());
                    this.on_checkpoint_decided(cp, d).await;
                }
                None => {
                    let _ = this.db.decide_checkpoint(&cp.checkpoint_id, "expired", None);
                    this.emit(
                        "loop-error",
                        LoopErrorEvent {
                            run_id: cp.run_id.clone(),
                            error: "a checkpoint expired after 12h; the run is still paused".to_string(),
                        },
                    );
                }
            }
        });
    }

    async fn on_checkpoint_decided(&self, cp: LoopCheckpoint, decision: CheckpointDecision) {
        match cp.kind.as_str() {
            "merge" => self.decide_merge(&cp, &decision).await,
            "subtask_stuck" => self.decide_stuck(&cp, &decision).await,
            "land" => self.decide_land(&cp, &decision).await,
            _ => {}
        }
    }

    async fn decide_merge(&self, cp: &LoopCheckpoint, decision: &CheckpointDecision) {
        let run_id = cp.run_id.clone();
        let Some(subtask_id) = cp.subtask_id.clone() else { return };
        let Some(run) = self.run(&run_id) else { return };
        let Some(subtask) = self.subtask(&subtask_id) else { return };
        let run8 = run.run_id[..8].to_string();
        let repo = PathBuf::from(&run.repo_path);
        let branch = subtask.branch.clone().unwrap_or_default();

        if decision.action != "approve" {
            // Deny → route back to the executor with the note as feedback.
            if let Some(note) = decision.note.as_deref().filter(|n| !n.trim().is_empty()) {
                let fb = self.new_attempt(&subtask_id, subtask.attempts, Role::Reviewer);
                let _ = self.db.finish_attempt(&fb, "complete", Some("fail"), None, Some(note), None, None);
            }
            self.set_subtask_status(&subtask_id, "pending");
            self.trace(&run_id, Some(&subtask_id), "merge", "merge denied — routed back to executor");
            self.resume_or_pause(&run_id).await;
            return;
        }

        // Approve → serialized merge into the integration branch.
        let lock = self.run_lock(&run_id);
        let outcome = {
            let _g = lock.lock().await;
            self.git.merge_into_integration(&run8, &branch).await
        };
        match outcome {
            Ok(MergeOutcome::Merged) => {
                self.set_subtask_status(&subtask_id, "merged");
                if let Some(wt) = subtask.worktree_path.as_deref() {
                    let _ = self.git.cleanup(&repo, std::path::Path::new(wt), &branch, false).await;
                }
                self.trace(&run_id, Some(&subtask_id), "merge", "merged into integration");
            }
            Ok(MergeOutcome::Conflict) => {
                // Route back so the executor can rebase onto the integration tip.
                let fb = self.new_attempt(&subtask_id, subtask.attempts, Role::Reviewer);
                let _ = self.db.finish_attempt(
                    &fb, "complete", Some("fail"), None,
                    Some(&format!("merge conflict against integration; run `git rebase {}` in your worktree and resolve", run.integration_branch)),
                    None, None,
                );
                self.set_subtask_status(&subtask_id, "pending");
                self.trace(&run_id, Some(&subtask_id), "merge", "merge conflict — routed back to executor to rebase");
            }
            Err(e) => {
                self.set_subtask_status(&subtask_id, "stuck");
                self.create_checkpoint(&run_id, Some(&subtask_id), "subtask_stuck", &format!("merge failed: {e}")).await;
                return;
            }
        }
        self.resume_or_pause(&run_id).await;
    }

    async fn decide_stuck(&self, cp: &LoopCheckpoint, decision: &CheckpointDecision) {
        let run_id = cp.run_id.clone();
        let Some(subtask_id) = cp.subtask_id.clone() else { return };
        match decision.action.as_str() {
            "edit_retry" => {
                if let Some(instr) = decision.edited_instructions.as_deref().filter(|s| !s.trim().is_empty()) {
                    let _ = self.db.edit_and_reset_subtask(&subtask_id, instr);
                } else {
                    // No edit — just reset the counter and try again.
                    if let Some(s) = self.subtask(&subtask_id) {
                        let _ = self.db.edit_and_reset_subtask(&subtask_id, &s.instructions);
                    }
                }
                self.set_subtask_status(&subtask_id, "pending");
                self.trace(&run_id, Some(&subtask_id), "checkpoint", "stuck → edit & retry");
            }
            "skip" => {
                self.set_subtask_status(&subtask_id, "skipped");
                self.trace(&run_id, Some(&subtask_id), "checkpoint", "stuck → skipped");
            }
            _ => {
                // abandon (default): dependents will block.
                self.set_subtask_status(&subtask_id, "failed");
                self.trace(&run_id, Some(&subtask_id), "checkpoint", "stuck → abandoned");
            }
        }
        self.resume_or_pause(&run_id).await;
    }

    async fn decide_land(&self, cp: &LoopCheckpoint, decision: &CheckpointDecision) {
        let run_id = cp.run_id.clone();
        let Some(run) = self.run(&run_id) else { return };
        let repo = PathBuf::from(&run.repo_path);
        if decision.action != "approve" {
            self.emit_run_status(&run_id, "review");
            self.trace(&run_id, None, "termination", "land denied — integration branch left intact for manual landing");
            return;
        }
        match self.git.land_integration(&repo, &run.base_ref, &run.integration_branch).await {
            Ok(MergeOutcome::Merged) => {
                self.trace(&run_id, None, "merge", "landed integration into base");
                self.finish_run(&run_id);
            }
            Ok(MergeOutcome::Conflict) => {
                self.emit_run_status(&run_id, "review");
                self.trace(&run_id, None, "termination", "land conflict — base moved; integration left intact");
                self.emit("loop-error", LoopErrorEvent { run_id: run_id.clone(), error: "landing conflicted with the base branch; integration branch left intact".into() });
            }
            Err(e) => {
                self.emit_run_status(&run_id, "review");
                self.trace(&run_id, None, "termination", &format!("land failed: {e}"));
                self.emit("loop-error", LoopErrorEvent { run_id: run_id.clone(), error: format!("landing failed: {e}") });
            }
        }
    }

    /// After a non-terminal checkpoint decision: keep paused if other gates are
    /// open, else resume the run and re-schedule.
    async fn resume_or_pause(&self, run_id: &str) {
        match self.run(run_id) {
            Some(r) if matches!(r.status.as_str(), "done" | "failed" | "cancelled" | "review") => return,
            None => return,
            _ => {}
        }
        if self.db.list_pending_checkpoints(run_id).map(|c| !c.is_empty()).unwrap_or(false) {
            self.emit_run_status(run_id, "paused_checkpoint");
        } else {
            self.emit_run_status(run_id, "running");
            self.schedule(run_id.to_string()).await;
        }
    }

    async fn open_land_checkpoint(&self, run: &LoopRun) {
        let run8 = run.run_id[..8].to_string();
        let int_wt = self.git.integration_worktree(&run8);
        let summary = self
            .git
            .diff_stat(&int_wt, &run.base_ref)
            .await
            .unwrap_or_else(|_| "(diff unavailable)".to_string());
        let summary = if summary.trim().is_empty() {
            "No net changes to land.".to_string()
        } else {
            summary
        };
        self.create_checkpoint(&run.run_id, None, "land", &summary).await;
    }

    fn finish_run(&self, run_id: &str) {
        self.emit_run_status(run_id, "done");
        self.emit("loop-done", RunStatusEvent { run_id: run_id.to_string(), status: "done".to_string() });
    }

    fn fail_run(&self, run_id: &str, why: &str) {
        self.trace(run_id, None, "error", why);
        self.emit_run_status(run_id, "failed");
        self.emit("loop-error", LoopErrorEvent { run_id: run_id.to_string(), error: why.to_string() });
    }

    // --- Restart reconciler ----------------------------------------------

    /// On app start, revive interrupted runs: the process tree died on quit, so
    /// reset in-flight subtasks, re-adopt worktrees, re-arm pending checkpoints,
    /// and re-schedule anything `running`. Durable truth = the DB status columns.
    pub async fn reconcile_on_start(&self) {
        let mut runs = self.db.list_loop_runs_by_status("running").unwrap_or_default();
        runs.extend(self.db.list_loop_runs_by_status("paused_checkpoint").unwrap_or_default());
        for run in runs {
            let run8 = run.run_id[..8].to_string();
            let repo = PathBuf::from(&run.repo_path);
            // Re-adopt the integration worktree (branch persists across restarts).
            let _ = self
                .git
                .adopt_integration(&repo, &run.integration_branch, &run.base_ref, &run8)
                .await;

            for s in self.run_subtasks(&run.run_id) {
                // In-flight turns are dead — reset them to be re-driven.
                if matches!(s.status.as_str(), "running" | "reviewing" | "needs_changes") {
                    self.set_subtask_status(&s.subtask_id, "pending");
                }
                // Re-adopt any subtask worktree that a non-terminal subtask owns.
                if !matches!(s.status.as_str(), "merged" | "skipped" | "failed") {
                    if let Some(branch) = &s.branch {
                        let slug = slugify(&s.title);
                        let _ = self
                            .git
                            .adopt_worktree(&repo, &run.integration_branch, branch, &run8, s.seq, &slug)
                            .await;
                    }
                }
            }

            // Re-arm every pending checkpoint's gate + driver.
            for cp in self.db.list_pending_checkpoints(&run.run_id).unwrap_or_default() {
                self.emit("loop-checkpoint", cp.clone());
                self.spawn_checkpoint_driver(cp);
            }

            if run.status == "running" {
                self.schedule(run.run_id.clone()).await;
            }
        }
    }
}

/// v1 ripeness warnings (non-blocking; dirty-repo is a hard stop upstream).
fn ripeness_warnings(subtasks: &[LoopSubtask]) -> Vec<String> {
    let mut w = Vec::new();
    if subtasks.len() < 2 {
        w.push("only one subtask — the loop adds little over running it directly".to_string());
    } else if subtasks.iter().all(|s| !s.deps.is_empty()) && subtasks.iter().skip(1).all(|s| !s.deps.is_empty()) {
        // Rough "pure chain" heuristic: nothing is a fresh root beyond the first.
        let roots = subtasks.iter().filter(|s| s.deps.is_empty()).count();
        if roots < 2 {
            w.push("the subtasks form a dependency chain — little parallelism available".to_string());
        }
    }
    for s in subtasks {
        if s.rubric.trim().is_empty() {
            w.push(format!("subtask “{}” has an empty rubric — it can't be graded", s.title));
        }
    }
    w
}

// --- Tauri commands --------------------------------------------------------

/// Hand an approved plan to the Loop Orchestrator. Validates the repo (git,
/// clean, base ref resolves) synchronously — a dirty repo is a HARD stop — then
/// returns a `planning` run and drives the planner pass off-thread.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn loop_start(
    loop_state: tauri::State<'_, LoopState>,
    session_id: String,
    title: String,
    plan_md: String,
    repo_path: String,
    base_ref: String,
    max_parallel: Option<i64>,
    max_attempts: Option<i64>,
    turn_budget: Option<i64>,
) -> Result<LoopRun, String> {
    let engine = (*loop_state).clone();
    if plan_md.trim().is_empty() {
        return Err("the plan is empty".to_string());
    }
    let repo = PathBuf::from(&repo_path);
    if !engine.git.is_git_repo(&repo).await {
        return Err(format!("`{repo_path}` is not a git repository"));
    }
    if !engine.git.ref_exists(&repo, &base_ref).await {
        return Err(format!("base ref `{base_ref}` does not resolve in the repo"));
    }
    // NOTE: a dirty working tree is deliberately NOT a hard stop here. Each
    // executor worktree is a clean checkout forked off a COMMITTED ref (the
    // integration branch cut from base_ref), so the user's uncommitted work is
    // never touched or included — the run simply operates on committed code.
    // Cleanliness only matters at the final land, which `land_integration`
    // guards on its own. The UI surfaces a soft warning about the dirty tree.

    let run_id = uuid::Uuid::new_v4().to_string();
    let run8 = &run_id[..8];
    let now = now_millis();
    let run = LoopRun {
        run_id: run_id.clone(),
        session_id,
        title: if title.trim().is_empty() { "Loop run".to_string() } else { title.trim().to_string() },
        plan_md,
        repo_path,
        base_ref,
        integration_branch: format!("redline/loop/{run8}/integration"),
        status: "planning".to_string(),
        planner_session_id: None,
        max_parallel: max_parallel.filter(|n| *n > 0).unwrap_or(3),
        max_attempts: max_attempts.filter(|n| *n > 0).unwrap_or(3),
        turn_budget: turn_budget.filter(|n| *n > 0).unwrap_or(40),
        created_at: now,
        updated_at: now,
    };
    engine.db.insert_loop_run(&run).map_err(|e| format!("failed to create run: {e}"))?;
    engine.emit("loop-run-status", RunStatusEvent { run_id: run_id.clone(), status: "planning".to_string() });

    let engine2 = engine.clone();
    let rid = run_id.clone();
    tauri::async_runtime::spawn(async move { engine2.run_planner_and_start(rid).await });
    Ok(run)
}

/// Pre-flight repo state for the start dialog: is it a git repo, is it clean,
/// and what's its current branch (to prefill the base ref). Lets the UI warn
/// about a dirty tree BEFORE the user clicks Start (a dirty repo is a hard stop
/// in `loop_start`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    is_git: bool,
    clean: bool,
    current_branch: Option<String>,
    dirty_count: usize,
}

#[tauri::command]
pub async fn loop_repo_status(
    loop_state: tauri::State<'_, LoopState>,
    repo_path: String,
) -> Result<RepoStatus, String> {
    let engine = (*loop_state).clone();
    let repo = PathBuf::from(&repo_path);
    if repo_path.trim().is_empty() || !engine.git.is_git_repo(&repo).await {
        return Ok(RepoStatus { is_git: false, clean: false, current_branch: None, dirty_count: 0 });
    }
    let dirty_count = engine.git.dirty_count(&repo).await.unwrap_or(0);
    let current_branch = engine.git.current_branch(&repo).await.ok().filter(|b| b != "HEAD");
    Ok(RepoStatus {
        is_git: true,
        clean: dirty_count == 0,
        current_branch,
        dirty_count,
    })
}

#[tauri::command]
pub fn loop_list(loop_state: tauri::State<'_, LoopState>) -> Result<Vec<LoopRun>, String> {
    loop_state.db.list_loop_runs().map_err(|e| format!("failed to list runs: {e}"))
}

#[tauri::command]
pub fn loop_get(loop_state: tauri::State<'_, LoopState>, run_id: String) -> Result<LoopSnapshot, String> {
    let run = loop_state.db.get_loop_run(&run_id).map_err(|e| e.to_string())?.ok_or("run not found")?;
    let subtasks = loop_state.db.list_subtasks(&run_id).unwrap_or_default();
    let checkpoints = loop_state.db.list_pending_checkpoints(&run_id).unwrap_or_default();
    Ok(LoopSnapshot { run, subtasks, checkpoints })
}

#[tauri::command]
pub fn loop_subtask_attempts(loop_state: tauri::State<'_, LoopState>, subtask_id: String) -> Result<Vec<LoopAttempt>, String> {
    loop_state.db.list_attempts(&subtask_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn loop_traces(loop_state: tauri::State<'_, LoopState>, run_id: String) -> Result<Vec<LoopTrace>, String> {
    loop_state.db.list_traces(&run_id).map_err(|e| e.to_string())
}

/// The human decides a held checkpoint (`merge`/`subtask_stuck`/`land`). Fires
/// the armed gate; the driver task does the actual work.
#[tauri::command]
pub fn loop_checkpoint_decide(
    loop_state: tauri::State<'_, LoopState>,
    checkpoint_id: String,
    action: String,
    note: Option<String>,
    edited_instructions: Option<String>,
) -> Result<(), String> {
    let cp = loop_state
        .db
        .get_checkpoint(&checkpoint_id)
        .map_err(|e| e.to_string())?
        .ok_or("checkpoint not found")?;
    if cp.status != "pending" {
        return Err("this checkpoint was already decided".to_string());
    }
    let decision = CheckpointDecision { action, note, edited_instructions };
    match loop_state.checkpoints.take(&checkpoint_id) {
        Some(tx) => {
            let _ = tx.send(decision);
            Ok(())
        }
        None => Err("this checkpoint is not currently armed — try again in a moment".to_string()),
    }
}

/// Cancel a run: kill its in-flight turns, drop its held checkpoints, mark it
/// cancelled. The user's base was never touched, so nothing to unwind there.
#[tauri::command]
pub fn loop_cancel(loop_state: tauri::State<'_, LoopState>, run_id: String) -> Result<(), String> {
    let engine = (*loop_state).clone();
    let drained: Vec<LoopProc> = {
        let mut guard = engine.procs.lock().unwrap();
        let keys: Vec<String> = guard.iter().filter(|(_, p)| p.run_id == run_id).map(|(k, _)| k.clone()).collect();
        keys.into_iter().filter_map(|k| guard.remove(&k)).collect()
    };
    for mut p in drained {
        let _ = p.child.start_kill();
    }
    for cp in engine.db.list_pending_checkpoints(&run_id).unwrap_or_default() {
        let _ = engine.checkpoints.take(&cp.checkpoint_id);
    }
    engine.emit_run_status(&run_id, "cancelled");
    Ok(())
}

#[tauri::command]
pub fn loop_kill_all(loop_state: tauri::State<'_, LoopState>) -> Result<(), String> {
    loop_state.kill_all();
    Ok(())
}

/// Delete a run: kill its turns, prune its worktrees + integration branch, and
/// drop every row. Failed/`review` runs keep the integration branch for
/// inspection (partial work isn't discarded on a run that needs manual landing).
#[tauri::command]
pub async fn loop_delete(loop_state: tauri::State<'_, LoopState>, run_id: String) -> Result<(), String> {
    let engine = (*loop_state).clone();
    // Kill any in-flight turns + release held checkpoints first.
    let drained: Vec<LoopProc> = {
        let mut guard = engine.procs.lock().unwrap();
        let keys: Vec<String> = guard.iter().filter(|(_, p)| p.run_id == run_id).map(|(k, _)| k.clone()).collect();
        keys.into_iter().filter_map(|k| guard.remove(&k)).collect()
    };
    for mut p in drained {
        let _ = p.child.start_kill();
    }
    for cp in engine.db.list_pending_checkpoints(&run_id).unwrap_or_default() {
        let _ = engine.checkpoints.take(&cp.checkpoint_id);
    }
    if let Some(run) = engine.run(&run_id) {
        let run8 = run.run_id[..8].to_string();
        let keep_integration = matches!(run.status.as_str(), "failed" | "review");
        let _ = engine
            .git
            .cleanup_run(std::path::Path::new(&run.repo_path), &run8, &run.integration_branch, keep_integration)
            .await;
    }
    engine.db.delete_loop_run(&run_id).map_err(|e| format!("failed to delete run: {e}"))
}

/// Deferred event-driven trigger stub (no scheduler in v1).
#[tauri::command]
pub fn loop_tick(_loop_state: tauri::State<'_, LoopState>) -> Result<(), String> {
    Ok(())
}

/// Hill-climb (v1: surface only). One planner-resume turn over the full trace
/// log; suggestions are persisted as `hill_suggestion` traces and NEVER applied.
#[tauri::command]
pub async fn loop_analyze(loop_state: tauri::State<'_, LoopState>, run_id: String) -> Result<(), String> {
    let engine = (*loop_state).clone();
    let run = engine.run(&run_id).ok_or("run not found")?;
    let planner_session = engine.db.get_planner_session(&run_id);
    let traces = engine.db.list_traces(&run_id).unwrap_or_default();
    let mut log = String::new();
    for t in &traces {
        log.push_str(&format!("[{}] {}\n", t.kind, t.body));
    }
    let prompt = format!(
        "Analyze this Loop Orchestrator trajectory. Which subtasks needed the most \
         retries, where did reviewers repeatedly fail makers, which rubric criteria \
         were ambiguous? Propose concrete prompt/decomposition/config improvements. \
         Output a fenced ```json array of short suggestion strings. DO NOT apply \
         anything.\n\nTrajectory log:\n{log}"
    );
    let args = read_only_args(&prompt);
    let mut cmd_args = args;
    if let Some(sid) = &planner_session {
        cmd_args.push("--resume".to_string());
        cmd_args.push(sid.clone());
    }
    let repo = PathBuf::from(&run.repo_path);
    match engine
        .run_turn(format!("analyze:{run_id}"), &run_id, None, Role::Planner, cmd_args, &repo, None)
        .await
    {
        Ok(out) => {
            engine.trace(&run_id, None, "hill_suggestion", &out.text);
            Ok(())
        }
        Err(TurnError::Cancelled) => Err("analysis cancelled".to_string()),
        Err(TurnError::Failed(e)) => Err(format!("analysis failed: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reviewer_never_resumes_the_executor_session() {
        // The load-bearing maker/grader separation: the reviewer arg builder must
        // NEVER carry a --resume (it takes no session parameter at all).
        let args = build_reviewer_args("grade this");
        assert!(!args.iter().any(|a| a == "--resume"), "reviewer must never resume a session");
        // The executor, by contrast, resumes on retry.
        let ex = build_executor_args("do work", Some("exec-session-123"));
        assert!(ex.windows(2).any(|w| w[0] == "--resume" && w[1] == "exec-session-123"));
        // And the reviewer never sees the executor session even incidentally.
        assert!(!build_reviewer_args("g").iter().any(|a| a == "exec-session-123"));
    }

    #[test]
    fn extract_json_array_from_chatty_reply() {
        let text = "Sure! Here is the decomposition:\n```json\n[{\"title\":\"A\"}]\n```\nHope that helps.";
        assert_eq!(extract_last_json_array(text).unwrap(), "[{\"title\":\"A\"}]");
        // Bare array, no fence.
        assert_eq!(extract_last_json_array("noise [1, 2, 3] tail").unwrap(), "[1, 2, 3]");
        // Last block wins.
        let two = "```json\n[1]\n```\nthen\n```json\n[2]\n```";
        assert_eq!(extract_last_json_array(two).unwrap(), "[2]");
    }

    #[test]
    fn extract_json_object_verdict() {
        let text = "My verdict:\n```json\n{\"verdict\":\"pass\",\"score\":90}\n```";
        let v: ReviewerVerdict = serde_json::from_str(&extract_last_json_object(text).unwrap()).unwrap();
        assert_eq!(v.verdict, "pass");
        assert_eq!(v.score, Some(90));
    }

    #[test]
    fn overlapping_paths_get_serialized() {
        assert!(paths_overlap(&["src/a.rs".into()], &["src/a.rs".into()]));
        assert!(paths_overlap(&["src/foo/**".into()], &["src/foo/bar.rs".into()]));
        assert!(!paths_overlap(&["src/a.rs".into()], &["src/b.rs".into()]));
        assert!(!paths_overlap(&["frontend/**".into()], &["backend/**".into()]));
    }

    #[test]
    fn scope_check_flags_strays() {
        let changed = vec!["src/a.rs".to_string(), "src/evil.rs".to_string()];
        // Declared only a.rs → evil.rs is a stray.
        assert_eq!(out_of_scope(&changed, &["src/a.rs".into()]), Some(vec!["src/evil.rs".to_string()]));
        // Glob covers both → in scope.
        assert_eq!(out_of_scope(&changed, &["src/**".into()]), None);
        // No declaration → not enforced.
        assert_eq!(out_of_scope(&changed, &[]), None);
    }

    #[test]
    fn glob_matches_common_shapes() {
        assert!(simple_glob_match("src/**", "src/a/b.rs"));
        assert!(simple_glob_match("src/foo", "src/foo/bar.rs"));
        assert!(simple_glob_match("*.rs", "main.rs"));
        assert!(simple_glob_match("src/a.rs", "src/a.rs"));
        assert!(!simple_glob_match("src/a.rs", "src/b.rs"));
        assert!(!simple_glob_match("*.rs", "main.ts"));
    }
}

