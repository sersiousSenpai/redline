// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Headless Claude Code forks backing per-comment discussion threads.
//!
//! Each "Discuss" thread runs `claude -p --resume <id> [--fork-session]
//! --output-format stream-json …` — a context-aware fork of the main
//! plan-mode session that answers a comment inline without disturbing the
//! held `:7676` hook. The first turn forks the main session (capturing a new
//! session id); follow-ups plain-resume the fork.
//!
//! Mirrors `pty.rs`'s keyed-registry pattern, but with `tokio::process`
//! (headless, no PTY) instead of `portable-pty`. Streaming text is pushed to
//! the frontend as `fork-delta` events; `fork-done` / `fork-error` /
//! `fork-cancelled` close a turn. `thread_messages` rows are written only
//! when a turn finishes — live streaming is frontend-only state.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdout, Command};

use crate::db::Database;
use crate::state::{now_millis, CommentKind, SessionStore, ThreadMessage};

/// Composite registry key. Comment ids are session-scoped (`c-001` restarts
/// per session), so a bare comment_id collides across sessions. NUL cannot
/// appear in a session UUID or a `c-NNN` id, so it is a safe separator.
fn fork_key(session_id: &str, comment_id: &str) -> String {
    format!("{session_id}\u{0}{comment_id}")
}

/// One in-flight forked `claude` turn. `tokio::process::Child::start_kill()`
/// is a synchronous, non-blocking SIGKILL, so no separate kill handle is
/// needed — the registry owns the whole `Child`.
struct ForkProc {
    child: Child,
}

type ForkRegistry = Arc<Mutex<HashMap<String, ForkProc>>>;

/// Registry of running fork turns, keyed by `fork_key`. Cloned into managed
/// Tauri state. The `std::sync::Mutex` is only ever held for a tiny
/// `lock → mutate → drop` critical section — never across an `.await`.
#[derive(Clone)]
pub struct ForkState {
    procs: ForkRegistry,
    db: Arc<Database>,
    /// Absolute path to the `claude` binary, resolved lazily on first fork
    /// use — a Finder-launched app inherits a minimal PATH and cannot find it
    /// by name. Resolution may shell out to the user's interactive rc files,
    /// and macOS attributes that child's file access to Redline (TCC), so it
    /// must never run at app startup.
    claude_bin: Arc<OnceLock<String>>,
}

impl ForkState {
    pub fn new(db: Arc<Database>) -> Self {
        Self {
            procs: Arc::new(Mutex::new(HashMap::new())),
            db,
            claude_bin: Arc::new(OnceLock::new()),
        }
    }

    /// The resolved `claude` path, computing it on first call. Runs on the
    /// blocking pool: a cache miss can spawn an interactive shell probe that
    /// takes a second or more, which must not stall the async runtime.
    async fn claude_bin(&self) -> Result<String, String> {
        let cell = self.claude_bin.clone();
        tokio::task::spawn_blocking(move || cell.get_or_init(resolve_claude_bin).clone())
            .await
            .map_err(|e| format!("failed to resolve the `claude` CLI: {e}"))
    }

    /// True if `session_id` is the forked session of any comment — the
    /// `handle_plan` guard against a stray `ExitPlanMode` POST from a fork.
    pub fn is_known_fork_session(&self, session_id: &str) -> bool {
        self.db.is_known_fork_session(session_id)
    }

    /// Kill every running fork. Backs the `fork_kill_all` command and the
    /// app-teardown hook so no `claude` child is left orphaned.
    pub fn kill_all(&self) {
        let drained: Vec<ForkProc> = {
            let mut guard = self.procs.lock().unwrap();
            guard.drain().map(|(_, p)| p).collect()
        };
        for mut proc in drained {
            let _ = proc.child.start_kill();
        }
    }
}

/// Resolve the absolute path to the `claude` binary. A Finder-launched macOS
/// app gets a minimal PATH with no shell rc, so `Command::new("claude")` can
/// fail even though `claude` works in a terminal. Three layers:
///
/// 1. Probe well-known install locations directly (native installer, nvm,
///    pnpm, bun, homebrew). Cheap, and touches no TCC-protected paths.
/// 2. Ask an *interactive* login shell (`-ilc`) — zsh sources `~/.zshrc` only
///    for interactive shells, which is where exotic installs put their PATH
///    lines. Interactive rcs may print banners, so only an output line that
///    is an existing file is accepted. This runs the user's full rc as a
///    child of Redline, and macOS attributes its file access to Redline
///    (TCC permission prompts) — which is why it is the fallback, not the
///    first probe.
/// 3. Fall back to the bare name (correct when launched from a terminal).
pub fn resolve_claude_bin() -> String {
    if let Some(path) = known_install_locations().into_iter().find(|p| p.is_file()) {
        return path.to_string_lossy().into_owned();
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    std::process::Command::new(&shell)
        .args(["-ilc", "command -v claude"])
        // An interactive rc that reads stdin must hit EOF, not hang.
        .stdin(Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .rev()
                .map(str::trim)
                .find(|line| Path::new(line).is_file())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "claude".to_string())
}

/// Well-known `claude` install locations to probe when the shell can't tell
/// us. nvm versions are checked newest-first (lexicographic, close enough —
/// any hit is a working binary).
fn known_install_locations() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        paths.push(home.join(".claude/local/claude")); // claude migrate-installer
        paths.push(home.join(".local/bin/claude")); // native installer
        paths.push(home.join("Library/pnpm/claude")); // pnpm global
        paths.push(home.join(".bun/bin/claude")); // bun global
        if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            let mut versions: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
            versions.sort();
            paths.extend(versions.into_iter().rev().map(|v| v.join("bin/claude")));
        }
    }
    paths.push(PathBuf::from("/opt/homebrew/bin/claude"));
    paths.push(PathBuf::from("/usr/local/bin/claude"));
    paths
}

// --- Event payloads --------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ForkDelta {
    session_id: String,
    comment_id: String,
    text: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ForkDone {
    session_id: String,
    comment_id: String,
    message_id: String,
    body: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ForkError {
    session_id: String,
    comment_id: String,
    error: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ForkCancelled {
    session_id: String,
    comment_id: String,
}

// --- stream-json parsing ---------------------------------------------------

/// What one `--output-format stream-json` line means to the fork reader.
/// See `docs/protocol-verification.md` Experiment (i) for the captured shapes.
#[derive(Debug, PartialEq)]
enum ForkLine {
    /// `system`/`init` — carries the forked session id.
    Init(String),
    /// A `text_delta` chunk of the assistant's reply.
    Delta(String),
    /// `result` success — the authoritative final text + fork session id.
    Final {
        text: String,
        session_id: Option<String>,
    },
    /// `result` with `is_error` — a failed turn.
    Failed(String),
    /// Everything else (status, hook events, the cumulative `assistant`
    /// snapshot, thinking `signature_delta`s, …) — produces no output.
    Ignore,
}

/// Classify a single parsed JSONL line. Pure — unit-tested against captured
/// fixtures. The `text_delta` discrimination is load-bearing: thinking blocks
/// also stream `content_block_delta`s, but with `delta.type == "signature_delta"`.
fn classify_line(v: &Value) -> ForkLine {
    match v.get("type").and_then(Value::as_str) {
        Some("system") if v.get("subtype").and_then(Value::as_str) == Some("init") => {
            match v.get("session_id").and_then(Value::as_str) {
                Some(sid) => ForkLine::Init(sid.to_string()),
                None => ForkLine::Ignore,
            }
        }
        Some("stream_event") => {
            let event = &v["event"];
            let is_text_delta = event.get("type").and_then(Value::as_str)
                == Some("content_block_delta")
                && event
                    .get("delta")
                    .and_then(|d| d.get("type"))
                    .and_then(Value::as_str)
                    == Some("text_delta");
            if is_text_delta {
                match event["delta"].get("text").and_then(Value::as_str) {
                    Some(text) if !text.is_empty() => ForkLine::Delta(text.to_string()),
                    _ => ForkLine::Ignore,
                }
            } else {
                ForkLine::Ignore
            }
        }
        Some("result") => {
            let session_id = v
                .get("session_id")
                .and_then(Value::as_str)
                .map(str::to_string);
            if v.get("is_error").and_then(Value::as_bool) == Some(true) {
                let msg = v
                    .get("result")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                    .or_else(|| v.get("subtype").and_then(Value::as_str))
                    .unwrap_or("claude reported an error")
                    .to_string();
                ForkLine::Failed(msg)
            } else {
                let text = v
                    .get("result")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                ForkLine::Final { text, session_id }
            }
        }
        _ => ForkLine::Ignore,
    }
}

/// The first turn's prompt — wraps the comment so the fork answers it with the
/// plan section in view, read-only, and without re-triggering plan mode.
/// Follow-up turns send the reviewer's text verbatim (the fork already carries
/// the discussion context).
fn build_first_turn_prompt(
    is_question: bool,
    anchor_id: &str,
    quoted: Option<&str>,
    opening: &str,
    prior_resolution: Option<&str>,
) -> String {
    let mut p = String::from(
        "You are discussing a plan you produced earlier in this session with \
         the person reviewing it in Redline.\n\n",
    );
    let verb = if is_question {
        "asked a question about"
    } else {
        "left a comment on"
    };
    p.push_str(&format!("They {verb} plan section §{anchor_id}"));
    match quoted {
        Some(q) if !q.trim().is_empty() => {
            p.push_str(", on this text:\n");
            for line in q.lines() {
                p.push_str("> ");
                p.push_str(line);
                p.push('\n');
            }
        }
        _ => p.push_str(".\n"),
    }
    p.push('\n');
    p.push_str("Their comment:\n");
    for line in opening.lines() {
        p.push_str("> ");
        p.push_str(line);
        p.push('\n');
    }
    // Ground the discussion in what was already resolved, so a follow-up on a
    // resolved item ("but what about X?") builds on the prior answer instead of
    // re-litigating it from scratch.
    if let Some(res) = prior_resolution {
        if !res.trim().is_empty() {
            p.push_str("\nYou previously resolved this comment with:\n");
            for line in res.lines() {
                p.push_str("> ");
                p.push_str(line);
                p.push('\n');
            }
        }
    }
    p.push_str(
        "\nRespond to the reviewer directly and concisely, in plain markdown \
         prose. This is a read-only discussion thread — do not edit files, do \
         not produce a new plan, and do not call ExitPlanMode. You may read \
         files, search the code, and fetch web pages or search the web to \
         ground your answer.",
    );
    p
}

// --- Commands --------------------------------------------------------------

/// Send a turn to a comment's fork agent. The first turn forks the main
/// session; later turns resume the comment's fork. Streaming happens via
/// `fork-*` events — this returns as soon as the child is spawned.
///
/// Must be `async`: Tauri runs async commands on its tokio runtime, and
/// `tokio::process::Command::spawn()` requires a tokio reactor.
#[tauri::command]
pub async fn fork_thread_send(
    fork: tauri::State<'_, ForkState>,
    store: tauri::State<'_, SessionStore>,
    app: AppHandle,
    session_id: String,
    comment_id: String,
    text: String,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("empty message".to_string());
    }
    let key = fork_key(&session_id, &comment_id);

    // Reject a second concurrent turn for the same comment.
    {
        let guard = fork.procs.lock().unwrap();
        if guard.contains_key(&key) {
            return Err("a reply is still streaming for this comment".to_string());
        }
    }

    // Resolve the comment + cwd from the in-memory store; the prior fork id
    // from the DB (never a possibly-stale in-memory copy).
    let session = store
        .get(&session_id)
        .ok_or_else(|| format!("no session {session_id}"))?;
    let cwd = session.project_path.clone();
    let comment = session
        .revisions
        .iter()
        .flat_map(|r| &r.comments)
        .find(|c| c.id == comment_id)
        .ok_or_else(|| format!("no comment {comment_id} in session {session_id}"))?;
    let prior_fork = fork.db.get_comment_fork_session(&session_id, &comment_id);

    // Persist the user turn (a terminal row).
    let user_msg = ThreadMessage {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: session_id.clone(),
        comment_id: comment_id.clone(),
        role: "user".to_string(),
        body: text.clone(),
        status: "complete".to_string(),
        created_at: now_millis(),
    };
    fork.db
        .insert_thread_message(&user_msg)
        .map_err(|e| format!("failed to persist message: {e}"))?;

    // Build the turn prompt — wrapped on the first turn, verbatim after. The
    // first turn uses `text` (the frontend's seed) so the persisted user row
    // and the prompt stay identical.
    let prompt = match &prior_fork {
        None => build_first_turn_prompt(
            matches!(comment.kind, CommentKind::Question),
            &comment.anchor_id,
            comment.selection.as_ref().map(|s| s.quoted_text.as_str()),
            &text,
            comment.resolution.as_ref().map(|r| r.body.as_str()),
        ),
        Some(_) => text.clone(),
    };

    // Read-only fork: built-in tools limited to Read/Grep/Glob plus the web
    // tools (WebFetch/WebSearch) so the discussion can ground answers in external
    // docs. The web tools have no repo or plan side effects, so the read-only
    // guarantee holds: Edit/Write/Bash/ExitPlanMode stay excluded and MCP is
    // stripped. Never plan mode. See docs/protocol-verification.md Experiment (i).
    let mut args: Vec<String> = vec![
        "-p".to_string(),
        prompt,
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--include-partial-messages".to_string(),
        "--verbose".to_string(),
        "--permission-mode".to_string(),
        "default".to_string(),
        "--tools".to_string(),
        "Read,Grep,Glob,WebFetch,WebSearch".to_string(),
        "--strict-mcp-config".to_string(),
    ];
    match &prior_fork {
        None => {
            args.push("--resume".to_string());
            args.push(session_id.clone());
            args.push("--fork-session".to_string());
        }
        Some(fork_sid) => {
            args.push("--resume".to_string());
            args.push(fork_sid.clone());
        }
    }

    // Spawn. Take stdout/stderr before the child enters the registry.
    // A Dock-launched app passes a minimal PATH to children; prepend the
    // resolved binary's directory so an `#!/usr/bin/env node` shebang (npm
    // installs) finds the `node` that lives alongside `claude`.
    let claude_bin = fork.claude_bin().await?;
    let mut cmd = Command::new(&claude_bin);
    if let Some(bin_dir) = Path::new(&claude_bin).parent().filter(|p| p.is_dir()) {
        let inherited = std::env::var("PATH").unwrap_or_default();
        cmd.env("PATH", format!("{}:{inherited}", bin_dir.display()));
    }
    let mut child = cmd
        .current_dir(&cwd)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!(
                    "could not find the `claude` CLI (looked for `{claude_bin}`). \
                     Install Claude Code, or launch Redline from a terminal \
                     so it inherits your shell's PATH."
                )
            } else {
                format!("failed to spawn claude: {e}")
            }
        })?;
    let stdout = child.stdout.take().ok_or("claude stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("claude stderr unavailable")?;

    // Register the running child, then start the reader. lock → insert → drop.
    {
        fork.procs
            .lock()
            .unwrap()
            .insert(key.clone(), ForkProc { child });
    }
    tauri::async_runtime::spawn(read_fork(
        app,
        fork.db.clone(),
        fork.procs.clone(),
        key,
        session_id,
        comment_id,
        stdout,
        stderr,
    ));
    Ok(())
}

/// Load a comment's persisted discussion turns, oldest first.
#[tauri::command]
pub fn get_thread(
    fork: tauri::State<'_, ForkState>,
    session_id: String,
    comment_id: String,
) -> Result<Vec<ThreadMessage>, String> {
    fork.db
        .load_thread(&session_id, &comment_id)
        .map_err(|e| format!("failed to load thread: {e}"))
}

/// Kill the in-flight turn for a comment, if any. `read_fork` then sees the
/// registry key already gone and emits `fork-cancelled`.
#[tauri::command]
pub fn fork_thread_cancel(
    fork: tauri::State<'_, ForkState>,
    session_id: String,
    comment_id: String,
) -> Result<(), String> {
    let key = fork_key(&session_id, &comment_id);
    let proc = { fork.procs.lock().unwrap().remove(&key) };
    if let Some(mut proc) = proc {
        let _ = proc.child.start_kill();
    }
    Ok(())
}

/// Discard a comment's whole thread: kill any in-flight turn, delete its
/// persisted messages, and clear `fork_session_id`. The host comment stays.
#[tauri::command]
pub fn fork_thread_discard(
    fork: tauri::State<'_, ForkState>,
    session_id: String,
    comment_id: String,
) -> Result<(), String> {
    let key = fork_key(&session_id, &comment_id);
    let proc = { fork.procs.lock().unwrap().remove(&key) };
    if let Some(mut proc) = proc {
        let _ = proc.child.start_kill();
    }
    fork.db
        .delete_thread(&session_id, &comment_id)
        .map_err(|e| format!("failed to delete thread: {e}"))?;
    fork.db
        .clear_comment_fork_session(&session_id, &comment_id)
        .map_err(|e| format!("failed to clear fork session: {e}"))?;
    Ok(())
}

/// Kill every running fork — also invoked on app teardown. Mirrors
/// `pty::pty_kill_all`.
#[tauri::command]
pub fn fork_kill_all(fork: tauri::State<'_, ForkState>) -> Result<(), String> {
    fork.kill_all();
    Ok(())
}

// --- Streaming reader ------------------------------------------------------

/// Drive one fork turn: stream stdout JSONL → `fork-delta` events, then
/// reap the child and emit a terminal `fork-done` / `fork-error` /
/// `fork-cancelled`. stdout and stderr are drained concurrently — a full
/// stderr pipe would otherwise block the child.
#[allow(clippy::too_many_arguments)]
async fn read_fork(
    app: AppHandle,
    db: Arc<Database>,
    procs: ForkRegistry,
    key: String,
    session_id: String,
    comment_id: String,
    stdout: ChildStdout,
    stderr: ChildStderr,
) {
    let stdout_fut = async {
        let mut reader = BufReader::new(stdout).lines();
        let mut fork_session: Option<String> = None;
        let mut final_text: Option<String> = None;
        let mut errored: Option<String> = None;
        let mut saw_json = false;
        while let Ok(Some(line)) = reader.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            // Tolerate stray non-JSON noise rather than aborting the turn.
            let Ok(v) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };
            saw_json = true;
            match classify_line(&v) {
                ForkLine::Init(sid) => fork_session = Some(sid),
                ForkLine::Delta(text) => {
                    let _ = app.emit(
                        "fork-delta",
                        ForkDelta {
                            session_id: session_id.clone(),
                            comment_id: comment_id.clone(),
                            text,
                        },
                    );
                }
                ForkLine::Final { text, session_id: sid } => {
                    if sid.is_some() {
                        fork_session = sid;
                    }
                    final_text = Some(text);
                }
                ForkLine::Failed(msg) => errored = Some(msg),
                ForkLine::Ignore => {}
            }
        }
        (fork_session, final_text, errored, saw_json)
    };
    let stderr_fut = async {
        let mut buf = String::new();
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            buf.push_str(&l);
            buf.push('\n');
        }
        buf
    };
    let ((fork_session, final_text, errored, saw_json), stderr_text) =
        tokio::join!(stdout_fut, stderr_fut);

    // Reap: pull the entry, then await the child. lock → remove → drop, no
    // `.await` inside the block. The key being gone before we removed it
    // means cancel/discard/kill_all already pulled it.
    let proc = { procs.lock().unwrap().remove(&key) };
    let cancelled = proc.is_none() && final_text.is_none();
    let exit_ok = match proc {
        Some(mut p) => p
            .child
            .wait()
            .await
            .map(|s| s.success())
            .unwrap_or(false),
        None => false,
    };

    if cancelled {
        let _ = app.emit(
            "fork-cancelled",
            ForkCancelled {
                session_id,
                comment_id,
            },
        );
        return;
    }
    if let Some(err) = errored {
        finish_error(&app, &db, &session_id, &comment_id, &err);
        return;
    }
    if let Some(text) = final_text {
        if text.trim().is_empty() {
            finish_error(
                &app,
                &db,
                &session_id,
                &comment_id,
                "claude produced an empty reply",
            );
            return;
        }
        // Persist the fork session id so the next turn resumes (not re-forks).
        if let Some(fork_sid) = &fork_session {
            if let Err(e) = db.set_comment_fork_session(&session_id, &comment_id, fork_sid) {
                tracing::warn!(error = %e, "failed to persist fork_session_id");
            }
        }
        let msg = ThreadMessage {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: session_id.clone(),
            comment_id: comment_id.clone(),
            role: "assistant".to_string(),
            body: text.clone(),
            status: "complete".to_string(),
            created_at: now_millis(),
        };
        if let Err(e) = db.insert_thread_message(&msg) {
            tracing::warn!(error = %e, "failed to persist assistant message");
        }
        let _ = app.emit(
            "fork-done",
            ForkDone {
                session_id,
                comment_id,
                message_id: msg.id,
                body: text,
            },
        );
        return;
    }

    // The stream ended without a `result` — surface stderr or a generic cause.
    let why = if !exit_ok && !stderr_text.trim().is_empty() {
        let detail: String = stderr_text.trim().chars().take(500).collect();
        format!("claude exited abnormally: {detail}")
    } else if !saw_json {
        "claude produced no parseable output".to_string()
    } else {
        "claude ended without producing a reply".to_string()
    };
    finish_error(&app, &db, &session_id, &comment_id, &why);
}

/// Persist a failed turn as a terminal `error` row and emit `fork-error`, so
/// the failure survives a reload and the thread leaves `streaming` state.
fn finish_error(
    app: &AppHandle,
    db: &Database,
    session_id: &str,
    comment_id: &str,
    error: &str,
) {
    let msg = ThreadMessage {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: session_id.to_string(),
        comment_id: comment_id.to_string(),
        role: "assistant".to_string(),
        body: error.to_string(),
        status: "error".to_string(),
        created_at: now_millis(),
    };
    if let Err(e) = db.insert_thread_message(&msg) {
        tracing::warn!(error = %e, "failed to persist error thread message");
    }
    let _ = app.emit(
        "fork-error",
        ForkError {
            session_id: session_id.to_string(),
            comment_id: comment_id.to_string(),
            error: error.to_string(),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(line: &str) -> ForkLine {
        classify_line(&serde_json::from_str::<Value>(line).unwrap())
    }

    #[test]
    fn classify_init_captures_session_id() {
        let line = r#"{"type":"system","subtype":"init","session_id":"fork-abc","tools":["Read"]}"#;
        assert_eq!(parse(line), ForkLine::Init("fork-abc".to_string()));
    }

    #[test]
    fn classify_text_delta_is_a_delta() {
        let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hello"}}}"#;
        assert_eq!(parse(line), ForkLine::Delta("hello".to_string()));
    }

    #[test]
    fn classify_signature_delta_is_ignored() {
        // Thinking blocks stream content_block_delta with a signature_delta —
        // it must NOT render as assistant text.
        let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"EtgEg...=="}}}"#;
        assert_eq!(parse(line), ForkLine::Ignore);
    }

    #[test]
    fn classify_assistant_snapshot_is_ignored() {
        // The cumulative `assistant` message would double-render against the
        // text deltas — it must be ignored.
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}"#;
        assert_eq!(parse(line), ForkLine::Ignore);
    }

    #[test]
    fn classify_result_success() {
        let line = r#"{"type":"result","subtype":"success","is_error":false,"result":"final answer","session_id":"fork-abc"}"#;
        assert_eq!(
            parse(line),
            ForkLine::Final {
                text: "final answer".to_string(),
                session_id: Some("fork-abc".to_string()),
            },
        );
    }

    #[test]
    fn classify_result_error() {
        let line = r#"{"type":"result","subtype":"error_during_execution","is_error":true,"result":"boom"}"#;
        assert_eq!(parse(line), ForkLine::Failed("boom".to_string()));
    }

    #[test]
    fn classify_misc_events_ignored() {
        for line in [
            r#"{"type":"system","subtype":"hook_started","hook_name":"SessionStart"}"#,
            r#"{"type":"system","subtype":"status","status":"requesting"}"#,
            r#"{"type":"rate_limit_event"}"#,
            r#"{"type":"stream_event","event":{"type":"message_stop"}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#,
        ] {
            assert_eq!(parse(line), ForkLine::Ignore, "should ignore: {line}");
        }
    }

    #[test]
    fn fork_key_is_session_scoped() {
        // The same comment id in different sessions must not collide.
        assert_ne!(fork_key("s1", "c-001"), fork_key("s2", "c-001"));
        assert_eq!(fork_key("s1", "c-001"), fork_key("s1", "c-001"));
    }

    #[test]
    fn first_turn_prompt_carries_comment_and_guardrails() {
        let p = build_first_turn_prompt(
            true,
            "A.1",
            Some("the detail section"),
            "Why this order?",
            None,
        );
        assert!(p.contains("Why this order?"));
        assert!(p.contains("the detail section"));
        assert!(p.contains("§A.1"));
        assert!(p.contains("asked a question"));
        // The read-only guardrail must always be present.
        assert!(p.contains("ExitPlanMode"));
        assert!(p.contains("do not edit files"));
    }

    #[test]
    fn first_turn_prompt_without_selection_uses_anchor_only() {
        let p = build_first_turn_prompt(false, "B", None, "Reconsider this.", None);
        assert!(p.contains("§B"));
        assert!(p.contains("left a comment"));
        assert!(p.contains("Reconsider this."));
    }

    #[test]
    fn first_turn_prompt_grounds_in_prior_resolution() {
        let p = build_first_turn_prompt(
            false,
            "A",
            None,
            "But what about retries?",
            Some("I added exponential backoff in §A."),
        );
        assert!(p.contains("You previously resolved this comment with:"));
        assert!(p.contains("exponential backoff"));
    }
}
