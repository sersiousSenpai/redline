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
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdout};

use crate::claude_proc::{classify_line, resolve_claude_bin, StreamLine};
use crate::db::Database;
use crate::state::{
    now_millis, CommentAttachment, CommentKind, ReviewAnnotation, SessionStore, ThreadMessage,
};

/// Where a thread's resumable fork-session id is persisted: plan comments
/// store it on their `comments` row; review annotations on their
/// `review_annotations` row; Ask-AI questions on their `review_questions`
/// row. Everything else about a turn (registry, events, `thread_messages`)
/// is shared verbatim between the thread kinds.
#[derive(Clone, Copy)]
enum ThreadTarget {
    PlanComment,
    ReviewAnnotation,
    ReviewQuestion,
    /// A Prompt Drafter sidecar thread — keys on `(draft_id, comment_id)`,
    /// fork session persisted on the `draft_comments` row.
    DraftComment,
}

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
    /// Unix-ms when this turn was registered — surfaced by
    /// `fork_thread_status` so a remounted thread can restore its elapsed
    /// counter after a session switch.
    started_at: i64,
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

    /// "Check in with a colleague" targeting a PLAN SESSION, for the
    /// Companion's `/v1/global/consult`. Plan sessions are external terminal
    /// claudes Redline must never disturb — so each consult runs an EPHEMERAL
    /// read-only fork (`--resume <session_id> --fork-session`, the same trick
    /// discussion threads use), returns the digest, and persists nothing: the
    /// fork session id is thrown away, and there is no natural thread to write
    /// check-in rows into (the exchange lives in the Companion's own thread).
    pub async fn consult_plan(
        &self,
        session_id: String,
        cwd: String,
        question: String,
    ) -> Result<String, String> {
        if question.trim().is_empty() {
            return Err("nothing to ask the colleague".to_string());
        }
        let key = format!("consult\u{0}{session_id}");
        {
            let guard = self.procs.lock().unwrap();
            if guard.contains_key(&key) {
                return Err(
                    "that plan session is already being consulted — try again in a moment"
                        .to_string(),
                );
            }
        }
        let framed = format!(
            "You are an ephemeral read-only fork of this planning session. The \
             user's COMPANION — their global cross-surface discussion — is \
             checking in about THIS plan and its conversation so far. Synthesize \
             what matters for their question as a tight DIGEST (not a transcript, \
             not a new plan; never call ExitPlanMode). Be concise. Their \
             question:\n\n{}",
            question.trim()
        );
        crate::ledger::register_agent_prompt(&crate::ledger::body_hash(&framed));

        let mut args: Vec<String> = discussion_fork_args("fork_plan", framed);
        args.push("--resume".to_string());
        args.push(session_id.clone());
        args.push("--fork-session".to_string());

        let claude_bin = self.claude_bin().await?;
        let mut cmd = crate::claude_proc::claude_command_for_seat("fork_plan", &claude_bin);
        let mut child = cmd
            .current_dir(&cwd)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("failed to spawn claude: {e}"))?;
        let stdout = child.stdout.take().ok_or("claude stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("claude stderr unavailable")?;
        {
            self.procs
                .lock()
                .unwrap()
                .insert(
                key.clone(),
                ForkProc {
                    child,
                    started_at: now_millis(),
                },
            );
        }

        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(180),
            crate::claude_proc::collect_turn(stdout, stderr),
        )
        .await;
        let proc = { self.procs.lock().unwrap().remove(&key) };
        let outcome = match outcome {
            Ok(o) => o,
            Err(_) => {
                if let Some(mut p) = proc {
                    let _ = p.child.start_kill();
                }
                let _ = self.db.record_friction(
                    "turn_timeout",
                    Some("fork"),
                    Some(&key),
                    Some("180s turn ceiling"),
                );
                return Err("the colleague took too long to respond".to_string());
            }
        };
        if let Some(mut p) = proc {
            let _ = p.child.wait().await;
        }
        if let Some(err) = outcome.errored {
            return Err(err);
        }
        outcome
            .final_text
            .filter(|t| !t.trim().is_empty())
            .ok_or_else(|| "the colleague produced no reply".to_string())
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

/// The first turn's prompt — wraps the comment so the fork answers it with the
/// plan section in view, read-only, and without re-triggering plan mode.
/// Follow-up turns send the reviewer's text verbatim (the fork already carries
/// the discussion context).
/// Tell the fork about files the reviewer attached. Absolute local paths are the
/// whole transport — this fork has `Read`, so naming them is enough. Returns an
/// empty string when there are none, so the prompt stays byte-identical to the
/// pre-attachment contract for every discussion without a file.
fn attachments_block(attachments: &[CommentAttachment]) -> String {
    if attachments.is_empty() {
        return String::new();
    }
    let mut p = String::from(
        "\nThey attached these files. Read them with the Read tool before \
         answering — they are local paths:\n",
    );
    for a in attachments {
        p.push_str(&format!("- {} ({})\n", a.path, a.mime));
    }
    p
}

fn build_first_turn_prompt(
    is_question: bool,
    anchor_id: &str,
    quoted: Option<&str>,
    opening: &str,
    prior_resolution: Option<&str>,
    attachments: &[CommentAttachment],
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
    p.push_str(&attachments_block(attachments));
    p.push_str(
        "\nFollow the `sidecar` skill for how to structure this reply: lead with \
         the answer, then add a table, mermaid diagram, or callout only when it \
         adds signal. Respond directly and concisely in markdown — no raw HTML. \
         This is a read-only discussion thread — do not edit files, do not \
         produce a new plan, and do not call ExitPlanMode. You may read files, \
         search the code, and fetch web pages or search the web to ground your \
         answer.",
    );
    p
}

// --- Spawn args -------------------------------------------------------------

/// Base spawn args for a read-only **discussion fork** (the sidecar / code-review
/// discussion modality). The tool surface is the read-only
/// `Read,Grep,Glob,WebFetch,WebSearch` set PLUS `Bash` scoped — via
/// `--allowedTools` — to the localhost daemon's `curl` bridge, in the same three
/// quoting variants `claude_proc::bridge_args` uses. That scoped `curl` allow is
/// the discussion fork's **ClassMemory retrieval surface**: the class-router in
/// the `sidecar` / `conversation` skills walks `/v1/memory/*` to answer
/// "what did I decide / research about X" against the user's own catalog.
///
/// This is a **conscious loosening** of the former read-only-no-`Bash` fork
/// invariant (Phase 3 of the Polis program). The allow is a literal prefix
/// confined to `http://127.0.0.1:7676/` — headless `-p` auto-denies any `Bash`
/// invocation that doesn't match it — so a fork still cannot write files, run
/// arbitrary commands, or reach any host but the local daemon. `Edit`/`Write`/
/// `ExitPlanMode` stay out of `--tools`, and `--strict-mcp-config` still strips
/// MCP. See `docs/protocol-verification.md` Experiment (i).
///
/// All fork spawn sites share this one builder so the tool surface can't
/// drift between them; each caller appends its own `--resume [--fork-session]`
/// tail. `prompt` is moved into the returned vector (arg position after `-p`).
/// `seat` is the fork's Agent Seat category (`fork_plan` / `fork_review` /
/// `fork_drafter`) — unconfigured categories add no flags, so the thread
/// inherits its parent surface exactly (see `seat.rs`).
fn discussion_fork_args(seat: &str, prompt: String) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(),
        prompt,
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--include-partial-messages".to_string(),
        "--verbose".to_string(),
        "--permission-mode".to_string(),
        "default".to_string(),
        "--tools".to_string(),
        "Read,Grep,Glob,WebFetch,WebSearch,Bash".to_string(),
        "--allowedTools".to_string(),
        "WebSearch".to_string(),
        "WebFetch".to_string(),
        // The ONLY Bash allow: the localhost daemon curl bridge, three quotings
        // (plain / single- / double-quoted URL) — identical to `bridge_args`.
        "Bash(curl -s http://127.0.0.1:7676/*)".to_string(),
        "Bash(curl -s 'http://127.0.0.1:7676/*)".to_string(),
        "Bash(curl -s \"http://127.0.0.1:7676/*)".to_string(),
        "--strict-mcp-config".to_string(),
    ];
    args.extend(crate::seat::flag_args(seat));
    args
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
    // Files the reviewer dropped into this follow-up composer.
    attachments: Option<Vec<CommentAttachment>>,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("empty message".to_string());
    }
    let turn_attachments = attachments.unwrap_or_default();
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
        attachments: turn_attachments.clone(),
    };
    fork.db
        .insert_thread_message(&user_msg)
        .map_err(|e| format!("failed to persist message: {e}"))?;
    // The DB row is already touched by insert_thread_message; keep the
    // in-memory store's activity stamp in step so the sidebar reorders.
    store.touch(&session_id);

    // Build the turn prompt — wrapped on the first turn, verbatim after. The
    // first turn uses `text` (the frontend's seed) so the persisted user row
    // and the prompt stay identical.
    let prompt = match &prior_fork {
        None => {
            // Turn one sees everything already attached to the comment as well
            // as anything dropped into this opening message.
            let mut all = comment.attachments.clone();
            all.extend(turn_attachments.iter().cloned());
            build_first_turn_prompt(
                matches!(comment.kind, CommentKind::Question),
                &comment.anchor_id,
                comment.selection.as_ref().map(|s| s.quoted_text.as_str()),
                &text,
                comment.resolution.as_ref().map(|r| r.body.as_str()),
                &all,
            )
        }
        // Follow-ups go verbatim, so a file dropped into one has to announce
        // itself — otherwise the fork never learns the path exists.
        Some(_) => format!("{text}{}", attachments_block(&turn_attachments)),
    };

    // Polis ledger: record the first-turn discussion prompt with its true
    // surface + thread provenance (the parent is this comment's plan session —
    // explicit, never inferred); keep every agent turn out of the global-hook
    // capture stream.
    if prior_fork.is_none() {
        let _ = crate::ledger::record_session_link(
            &fork.db,
            "fork",
            &comment_id,
            "session",
            &session_id,
        );
        crate::ledger::record_agent_prompt(
            &fork.db,
            crate::ledger::PromptSource::RustFirstTurn,
            "fork",
            &prompt,
            Some(cwd.clone()),
            Some(session_id.clone()),
            None,
            Some(crate::ledger::ThreadRef {
                thread_kind: "fork",
                thread_id: comment_id.clone(),
                parent_session_id: Some(session_id.clone()),
            }),
            crate::seat::model_for("fork_plan"),
        );
    } else {
        crate::ledger::register_agent_prompt(&crate::ledger::body_hash(&prompt));
    }

    // Read-only discussion fork: the Read/Grep/Glob + web tool surface plus the
    // scoped localhost-daemon `curl` allow (the ClassMemory retrieval surface).
    // Edit/Write/ExitPlanMode stay excluded and MCP is stripped; never plan mode.
    // See `discussion_fork_args` and docs/protocol-verification.md Experiment (i).
    let mut args: Vec<String> = discussion_fork_args("fork_plan", prompt);
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
    // `claude_command` prepends the binary's own dir to PATH so an
    // `#!/usr/bin/env node` shebang (npm installs) finds its `node`.
    let claude_bin = fork.claude_bin().await?;
    let mut cmd = crate::claude_proc::claude_command_for_seat("fork_plan", &claude_bin);
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
            .insert(
                key.clone(),
                ForkProc {
                    child,
                    started_at: now_millis(),
                },
            );
    }
    tauri::async_runtime::spawn(read_fork(
        app,
        fork.db.clone(),
        fork.procs.clone(),
        key,
        session_id,
        comment_id,
        ThreadTarget::PlanComment,
        stdout,
        stderr,
    ));
    Ok(())
}

/// First-turn prompt for a **review annotation** discussion: grounded on the
/// diff range + annotation instead of a plan block. Unlike plan threads there
/// is no session to fork — the agent starts fresh in the repo and reads the
/// code itself (the quoted lines + file:line anchor tell it exactly where).
fn build_review_first_turn_prompt(ann: &ReviewAnnotation, opening: &str) -> String {
    let mut p = String::from(
        "You are discussing a CODE CHANGE with the person reviewing it in \
         Redline's code-review pane.\n\n",
    );
    let what = match ann.kind.as_str() {
        "suggestion" => "proposed a replacement for",
        "deletion" => "marked for deletion",
        _ => "left a comment on",
    };
    let lines = if ann.start_line == ann.end_line {
        format!("line {}", ann.start_line)
    } else {
        format!("lines {}-{}", ann.start_line, ann.end_line)
    };
    p.push_str(&format!(
        "They {what} `{}` ({} side, {lines}):\n",
        ann.file_path, ann.side
    ));
    for line in ann.quoted_text.lines() {
        p.push_str("> ");
        p.push_str(line);
        p.push('\n');
    }
    if let Some(replacement) = ann
        .suggestion_replacement
        .as_deref()
        .filter(|r| !r.trim().is_empty())
    {
        p.push_str("\nTheir suggested replacement:\n");
        for line in replacement.lines() {
            p.push_str("> ");
            p.push_str(line);
            p.push('\n');
        }
    }
    p.push_str("\nTheir message:\n");
    for line in opening.lines() {
        p.push_str("> ");
        p.push_str(line);
        p.push('\n');
    }
    if let Some(res) = ann.resolution.as_deref().filter(|r| !r.trim().is_empty()) {
        p.push_str("\nThis annotation was previously resolved with:\n");
        for line in res.lines() {
            p.push_str("> ");
            p.push_str(line);
            p.push('\n');
        }
    }
    p.push_str(
        "\nStart by reading the file around those lines to ground your answer \
         in the real code. Follow the `sidecar` skill for how to structure the \
         reply: lead with the answer, then add a table, mermaid diagram, or \
         callout only when it adds signal. Respond directly and concisely in \
         markdown — no raw HTML. This is a read-only discussion thread — do \
         not edit files, do not produce a new plan, and do not call \
         ExitPlanMode. You may read files, search the code, and fetch web \
         pages or search the web.",
    );
    p
}

/// Send a turn to a review annotation's discussion agent. Mirrors
/// `fork_thread_send` with two differences: the thread keys on
/// `(review_id, annotation_id)`, and the first turn starts a FRESH session in
/// the review's repo (there is no plan session to fork) grounded on the diff
/// range via the prompt. Follow-ups resume the annotation's own session.
#[tauri::command]
pub async fn review_thread_send(
    fork: tauri::State<'_, ForkState>,
    app: AppHandle,
    review_id: String,
    annotation_id: String,
    text: String,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("empty message".to_string());
    }
    let key = fork_key(&review_id, &annotation_id);
    {
        let guard = fork.procs.lock().unwrap();
        if guard.contains_key(&key) {
            return Err("a reply is still streaming for this annotation".to_string());
        }
    }

    let session = fork
        .db
        .get_code_review(&review_id)
        .ok_or_else(|| format!("no review {review_id}"))?;
    let cwd = session.repo_path.clone();
    let annotation = fork
        .db
        .list_review_annotations(&review_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|a| a.id == annotation_id)
        .ok_or_else(|| format!("no annotation {annotation_id} in review {review_id}"))?;
    let prior_fork = fork
        .db
        .get_review_annotation_fork_session(&review_id, &annotation_id);

    let user_msg = ThreadMessage {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: review_id.clone(),
        comment_id: annotation_id.clone(),
        role: "user".to_string(),
        body: text.clone(),
        status: "complete".to_string(),
        created_at: now_millis(),
        attachments: Vec::new(),
    };
    fork.db
        .insert_thread_message(&user_msg)
        .map_err(|e| format!("failed to persist message: {e}"))?;

    let prompt = match &prior_fork {
        None => build_review_first_turn_prompt(&annotation, &text),
        Some(_) => text.clone(),
    };

    if prior_fork.is_none() {
        let _ = crate::ledger::record_session_link(
            &fork.db,
            "review_thread",
            &annotation_id,
            "review",
            &review_id,
        );
        crate::ledger::record_agent_prompt(
            &fork.db,
            crate::ledger::PromptSource::RustFirstTurn,
            "review_fork",
            &prompt,
            Some(cwd.clone()),
            Some(review_id.clone()),
            None,
            Some(crate::ledger::ThreadRef {
                thread_kind: "review_thread",
                thread_id: annotation_id.clone(),
                parent_session_id: Some(review_id.clone()),
            }),
            crate::seat::model_for("fork_review"),
        );
    } else {
        crate::ledger::register_agent_prompt(&crate::ledger::body_hash(&prompt));
    }

    // Same read-only discussion-fork tool surface as plan threads (scoped curl
    // allow included — see `discussion_fork_args`).
    let mut args: Vec<String> = discussion_fork_args("fork_review", prompt);
    // First turn: fresh session (no --resume). Follow-ups resume it.
    if let Some(fork_sid) = &prior_fork {
        args.push("--resume".to_string());
        args.push(fork_sid.clone());
    }

    let claude_bin = fork.claude_bin().await?;
    let mut cmd = crate::claude_proc::claude_command_for_seat("fork_review", &claude_bin);
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

    {
        fork.procs
            .lock()
            .unwrap()
            .insert(
                key.clone(),
                ForkProc {
                    child,
                    started_at: now_millis(),
                },
            );
    }
    tauri::async_runtime::spawn(read_fork(
        app,
        fork.db.clone(),
        fork.procs.clone(),
        key,
        review_id,
        annotation_id,
        ThreadTarget::ReviewAnnotation,
        stdout,
        stderr,
    ));
    Ok(())
}

/// First-turn grounding for an Ask-AI question: the anchor + quoted lines +
/// the reviewer's question. Read-only, answer-focused — the agent explains,
/// it does not edit.
fn build_question_first_turn_prompt(
    q: &crate::state::ReviewQuestion,
    question: &str,
) -> String {
    let mut p = String::new();
    p.push_str(
        "You are answering a reviewer's question during a code review. They \
         selected a range in the diff and asked about it — answer the question; \
         do NOT propose a to-do list or edit anything.\n\n",
    );
    p.push_str(&format!(
        "The selection: {} ({} side), lines {}-{}.\n",
        q.file_path, q.side, q.start_line, q.end_line
    ));
    if !q.quoted_text.trim().is_empty() {
        p.push_str("The selected lines:\n\n");
        for line in q.quoted_text.lines() {
            p.push_str("> ");
            p.push_str(line);
            p.push('\n');
        }
        p.push('\n');
    }
    p.push_str(&format!("The reviewer's question (verbatim):\n\n{question}\n\n"));
    p.push_str(
        "Start by reading the file around those lines for context. Follow the \
         `sidecar` skill's formatting if available. You are read-only: do not \
         edit files, and never call ExitPlanMode.",
    );
    p
}

/// Ask-AI about a selection — a question thread, not an annotation. Same
/// fresh-session + resume mechanics as `review_thread_send`; messages persist
/// under `(review_id, ask-NNN)` and the answer NEVER enters the feedback
/// payload.
#[tauri::command]
pub async fn review_question_send(
    fork: tauri::State<'_, ForkState>,
    app: AppHandle,
    review_id: String,
    question_id: String,
    text: String,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("empty message".to_string());
    }
    let key = fork_key(&review_id, &question_id);
    {
        let guard = fork.procs.lock().unwrap();
        if guard.contains_key(&key) {
            return Err("a reply is still streaming for this question".to_string());
        }
    }

    let session = fork
        .db
        .get_code_review(&review_id)
        .ok_or_else(|| format!("no review {review_id}"))?;
    let cwd = session.repo_path.clone();
    let question = fork
        .db
        .list_review_questions(&review_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|q| q.id == question_id)
        .ok_or_else(|| format!("no question {question_id} in review {review_id}"))?;
    let prior_fork = fork
        .db
        .get_review_question_fork_session(&review_id, &question_id);

    let user_msg = ThreadMessage {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: review_id.clone(),
        comment_id: question_id.clone(),
        role: "user".to_string(),
        body: text.clone(),
        status: "complete".to_string(),
        created_at: now_millis(),
        attachments: Vec::new(),
    };
    fork.db
        .insert_thread_message(&user_msg)
        .map_err(|e| format!("failed to persist message: {e}"))?;

    let prompt = match &prior_fork {
        None => build_question_first_turn_prompt(&question, &text),
        Some(_) => text.clone(),
    };

    if prior_fork.is_none() {
        let _ = crate::ledger::record_session_link(
            &fork.db,
            "review_question",
            &question_id,
            "review",
            &review_id,
        );
        crate::ledger::record_agent_prompt(
            &fork.db,
            crate::ledger::PromptSource::RustFirstTurn,
            "review_question",
            &prompt,
            Some(cwd.clone()),
            Some(review_id.clone()),
            None,
            Some(crate::ledger::ThreadRef {
                thread_kind: "review_question",
                thread_id: question_id.clone(),
                parent_session_id: Some(review_id.clone()),
            }),
            crate::seat::model_for("fork_review"),
        );
    } else {
        crate::ledger::register_agent_prompt(&crate::ledger::body_hash(&prompt));
    }

    // Same read-only discussion-fork tool surface as the annotation threads
    // (scoped curl allow included — see `discussion_fork_args`).
    let mut args: Vec<String> = discussion_fork_args("fork_review", prompt);
    if let Some(fork_sid) = &prior_fork {
        args.push("--resume".to_string());
        args.push(fork_sid.clone());
    }

    let claude_bin = fork.claude_bin().await?;
    let mut cmd = crate::claude_proc::claude_command_for_seat("fork_review", &claude_bin);
    let mut child = cmd
        .current_dir(&cwd)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("failed to spawn claude: {e}"))?;
    let stdout = child.stdout.take().ok_or("claude stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("claude stderr unavailable")?;

    {
        fork.procs
            .lock()
            .unwrap()
            .insert(
                key.clone(),
                ForkProc {
                    child,
                    started_at: now_millis(),
                },
            );
    }
    tauri::async_runtime::spawn(read_fork(
        app,
        fork.db.clone(),
        fork.procs.clone(),
        key,
        review_id,
        question_id,
        ThreadTarget::ReviewQuestion,
        stdout,
        stderr,
    ));
    Ok(())
}

/// Discard a review annotation's whole thread: kill any in-flight turn,
/// delete its messages, clear the resume session. The annotation stays.
#[tauri::command]
pub fn review_thread_discard(
    fork: tauri::State<'_, ForkState>,
    review_id: String,
    annotation_id: String,
) -> Result<(), String> {
    let key = fork_key(&review_id, &annotation_id);
    let proc = { fork.procs.lock().unwrap().remove(&key) };
    if let Some(mut proc) = proc {
        let _ = proc.child.start_kill();
    }
    fork.db
        .delete_thread(&review_id, &annotation_id)
        .map_err(|e| format!("failed to delete thread: {e}"))?;
    fork.db
        .clear_review_annotation_fork_session(&review_id, &annotation_id)
        .map_err(|e| format!("failed to clear fork session: {e}"))?;
    Ok(())
}

/// First-turn grounding for a Prompt Drafter sidecar thread: the anchored
/// block + quoted selection + the live-doc route + the block-SCOPED write
/// contract (this thread may only propose edits to its own block).
fn build_draft_first_turn_prompt(
    draft_id: &str,
    comment: &crate::state::DraftComment,
    opening: &str,
) -> String {
    let mut p = String::from(
        "You are discussing one part of a document in Redline's Prompt Drafter — \
         a PROMPT the user is authoring to launch a fresh Claude Code planning \
         session. They anchored a comment to a block of the draft and opened \
         this thread about it.\n\n",
    );
    if let Some(bid) = comment.block_id.as_deref().filter(|s| !s.is_empty()) {
        p.push_str(&format!("The anchored block id: `{bid}`\n"));
    }
    if let Some(q) = comment
        .sel_quoted_text
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        p.push_str("The text they selected:\n");
        for line in q.lines() {
            p.push_str("> ");
            p.push_str(line);
            p.push('\n');
        }
    }
    p.push_str(&format!(
        "\nThe live draft (the user edits it continuously — re-read before \
         answering about wording; already permitted, no approval needed):\n  \
         curl -s http://127.0.0.1:7676/v1/drafter/{draft_id}/doc\n\n\
         You may propose an edit to YOUR anchored block only — post a tracked \
         suggestion (rendered with accept/reject) with `commentId` set so the \
         daemon can scope-check it. This write route needs the bearer token: add \
         the two `--variable`/`--expand-header` flags shown after the URL, which \
         import it straight from the environment — never write \
         `$REDLINE_DAEMON_TOKEN` into the command yourself (requires curl \
         >= 8.3):\n  \
         curl -s http://127.0.0.1:7676/v1/drafter/{draft_id}/suggestions \
         --variable %REDLINE_DAEMON_TOKEN= \
         --expand-header \"Authorization: Bearer {{{{REDLINE_DAEMON_TOKEN}}}}\" -X POST \
         -H 'Content-Type: application/json' -d '{{\"op\":\"replace_block\",\
\"blockId\":\"<your block>\",\"original\":\"<its markdown as you read it>\",\
\"markdown\":\"<your rewrite>\",\"commentId\":\"{comment_id}\",\
\"agentId\":\"draft-thread\"}}'\n\
         Ops allowed for you: `replace_block`, `insert_after`, `delete_block` — \
         all against your anchored block. A 409 means the block changed or \
         already carries an open suggestion: re-read the doc and retry. \
         \"Discuss this paragraph\" must never rewrite the whole prompt.\n\n",
        comment_id = comment.id,
    ));
    p.push_str("Their message:\n");
    for line in opening.lines() {
        p.push_str("> ");
        p.push_str(line);
        p.push('\n');
    }
    p.push_str(
        "\nFollow the `sidecar` skill for how to structure the reply: lead with \
         the answer, then add a table, mermaid diagram, or callout only when it \
         adds signal. Respond in markdown — no raw HTML. Outside the scoped \
         suggestion endpoint above you are read-only: do not edit files, do not \
         produce a plan, and never call ExitPlanMode.",
    );
    p
}

/// Send a turn to a draft comment's discussion agent. Mirrors
/// `review_thread_send` (fresh session on the first turn — a draft has no plan
/// session to fork — resumed thereafter); messages persist in `thread_messages`
/// keyed `(draft_id, comment_id)`.
#[tauri::command]
pub async fn draft_thread_send(
    fork: tauri::State<'_, ForkState>,
    app: AppHandle,
    draft_id: String,
    comment_id: String,
    text: String,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("empty message".to_string());
    }
    let key = fork_key(&draft_id, &comment_id);
    {
        let guard = fork.procs.lock().unwrap();
        if guard.contains_key(&key) {
            return Err("a reply is still streaming for this comment".to_string());
        }
    }

    let comment = fork
        .db
        .get_draft_comment(&comment_id)
        .map_err(|e| e.to_string())?
        .filter(|c| c.draft_id == draft_id)
        .ok_or_else(|| format!("no comment {comment_id} on draft {draft_id}"))?;
    let cwd = fork
        .db
        .get_draft(&draft_id)
        .ok()
        .flatten()
        .and_then(|(_, project, _, _)| project)
        .filter(|p| !p.trim().is_empty())
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| "/".to_string());
    let prior_fork = fork.db.get_draft_comment_fork_session(&comment_id);

    let user_msg = ThreadMessage {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: draft_id.clone(),
        comment_id: comment_id.clone(),
        role: "user".to_string(),
        body: text.clone(),
        status: "complete".to_string(),
        created_at: now_millis(),
        attachments: Vec::new(),
    };
    fork.db
        .insert_thread_message(&user_msg)
        .map_err(|e| format!("failed to persist message: {e}"))?;

    let prompt = match &prior_fork {
        None => build_draft_first_turn_prompt(&draft_id, &comment, &text),
        Some(_) => text.clone(),
    };

    if prior_fork.is_none() {
        let _ = crate::ledger::record_session_link(
            &fork.db,
            "drafter_fork",
            &comment_id,
            "drafter",
            &draft_id,
        );
        crate::ledger::record_agent_prompt(
            &fork.db,
            crate::ledger::PromptSource::RustFirstTurn,
            "drafter_fork",
            &prompt,
            Some(cwd.clone()),
            None,
            None,
            Some(crate::ledger::ThreadRef {
                thread_kind: "drafter_fork",
                thread_id: comment_id.clone(),
                parent_session_id: None,
            }),
            crate::seat::model_for("fork_drafter"),
        );
    } else {
        crate::ledger::register_agent_prompt(&crate::ledger::body_hash(&prompt));
    }

    let mut args: Vec<String> = discussion_fork_args("fork_drafter", prompt);
    if let Some(fork_sid) = &prior_fork {
        args.push("--resume".to_string());
        args.push(fork_sid.clone());
    }

    let claude_bin = fork.claude_bin().await?;
    let mut cmd = crate::claude_proc::claude_command_for_seat("fork_drafter", &claude_bin);
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

    {
        fork.procs
            .lock()
            .unwrap()
            .insert(
                key.clone(),
                ForkProc {
                    child,
                    started_at: now_millis(),
                },
            );
    }
    tauri::async_runtime::spawn(read_fork(
        app,
        fork.db.clone(),
        fork.procs.clone(),
        key,
        draft_id,
        comment_id,
        ThreadTarget::DraftComment,
        stdout,
        stderr,
    ));
    Ok(())
}

/// Discard a draft comment's whole thread: kill any in-flight turn, delete its
/// messages, clear the resume session. The comment stays.
#[tauri::command]
pub fn draft_thread_discard(
    fork: tauri::State<'_, ForkState>,
    draft_id: String,
    comment_id: String,
) -> Result<(), String> {
    let key = fork_key(&draft_id, &comment_id);
    let proc = { fork.procs.lock().unwrap().remove(&key) };
    if let Some(mut proc) = proc {
        let _ = proc.child.start_kill();
    }
    fork.db
        .delete_thread(&draft_id, &comment_id)
        .map_err(|e| format!("failed to delete thread: {e}"))?;
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

/// Snapshot of whether a thread has a turn in flight right now.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkThreadStatus {
    pub streaming: bool,
    pub started_at: Option<i64>,
}

/// Core lookup shared by the command and its test.
fn thread_status_in(procs: &ForkRegistry, scope_id: &str, item_id: &str) -> ForkThreadStatus {
    let guard = procs.lock().unwrap();
    match guard.get(&fork_key(scope_id, item_id)) {
        Some(p) => ForkThreadStatus {
            streaming: true,
            started_at: Some(p.started_at),
        },
        None => ForkThreadStatus {
            streaming: false,
            started_at: None,
        },
    }
}

/// Whether a discussion thread has a turn streaming right now, and since
/// when. Generic over all four fork families — plan comments, review
/// annotations, review questions, drafter comments — because they share one
/// registry keyed by `fork_key(scope, item)`. Streaming state is otherwise
/// component-local in the frontend: switching sessions unmounts the thread,
/// and a remount would look idle mid-turn (silent thinking stretches emit no
/// deltas) until the send path rejected with "a reply is still streaming".
/// The thread components seed from this on mount instead.
#[tauri::command]
pub fn fork_thread_status(
    fork: tauri::State<'_, ForkState>,
    scope_id: String,
    item_id: String,
) -> ForkThreadStatus {
    thread_status_in(&fork.procs, &scope_id, &item_id)
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
    target: ThreadTarget,
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
                StreamLine::Init(sid) => fork_session = Some(sid),
                StreamLine::Delta(text) => {
                    let _ = app.emit(
                        "fork-delta",
                        ForkDelta {
                            session_id: session_id.clone(),
                            comment_id: comment_id.clone(),
                            text,
                        },
                    );
                }
                StreamLine::Final { text, session_id: sid } => {
                    if sid.is_some() {
                        fork_session = sid;
                    }
                    final_text = Some(text);
                }
                StreamLine::Failed(msg) => errored = Some(msg),
                StreamLine::Ignore => {}
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
        // For review threads, `session_id`/`comment_id` are the review /
        // annotation ids and the resume id lives on the annotation row.
        if let Some(fork_sid) = &fork_session {
            let persisted = match target {
                ThreadTarget::PlanComment => {
                    db.set_comment_fork_session(&session_id, &comment_id, fork_sid)
                }
                ThreadTarget::ReviewAnnotation => {
                    db.set_review_annotation_fork_session(&session_id, &comment_id, fork_sid)
                }
                ThreadTarget::ReviewQuestion => {
                    db.set_review_question_fork_session(&session_id, &comment_id, fork_sid)
                }
                ThreadTarget::DraftComment => {
                    db.set_draft_comment_fork_session(&comment_id, fork_sid)
                }
            };
            if let Err(e) = persisted {
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
            attachments: Vec::new(),
        };
        if let Err(e) = db.insert_thread_message(&msg) {
            tracing::warn!(error = %e, "failed to persist assistant message");
        }
        // Companion journal: a discussion-thread fork completed a turn.
        let _ = db.append_journal("agent_turn", Some("fork"), Some(&comment_id), None, None);
        // No-op for review/question threads, whose ids aren't plan sessions.
        app.state::<SessionStore>().touch(&session_id);
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
        attachments: Vec::new(),
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

    // stream-json line classification is covered by `claude_proc`'s own tests.

    /// The draft-thread write contract authenticates via curl's own variable
    /// import. It is built from a `format!` string, so the literal braces are
    /// quadrupled in source; the wrong escape level renders `{TOKEN}` and the
    /// suggestion silently 401s at runtime with nothing to see in the UI.
    #[test]
    fn draft_thread_prompt_imports_the_token_with_curl_not_the_shell() {
        let comment = crate::state::DraftComment {
            id: "c-1".to_string(),
            draft_id: "d-9".to_string(),
            block_id: Some("rl:blk-abc".to_string()),
            sel_char_start: None,
            sel_char_end: None,
            sel_quoted_text: Some("the selected line".to_string()),
            body: "tighten this".to_string(),
            author: None,
            created_at: 0,
            fork_session_id: None,
        };
        let p = build_draft_first_turn_prompt("d-9", &comment, "what about X?");

        // The URL stays immediately after `-s` so the command-prefix allow
        // rules still match, with the auth flags after it.
        assert!(p.contains("curl -s http://127.0.0.1:7676/v1/drafter/d-9/suggestions"));
        assert!(p.contains(
            "--variable %REDLINE_DAEMON_TOKEN= \
             --expand-header \"Authorization: Bearer {{REDLINE_DAEMON_TOKEN}}\""
        ));
        // Shell expansion never survives the agent bash sandbox.
        assert!(!p.contains("Bearer $REDLINE_DAEMON_TOKEN"));
        // The scoping payload still round-trips its `format!` args.
        assert!(p.contains("\"commentId\":\"c-1\""));
    }

    /// The Phase-3 fork loosening must grant EXACTLY the scoped localhost-daemon
    /// curl allow and nothing broader: no bare `Bash` allow, no other curl host,
    /// and no write/plan tools in the tool set. This is the guard on the
    /// consciously-widened read-only fork invariant.
    #[test]
    fn discussion_fork_args_grant_only_the_scoped_localhost_curl_allow() {
        let args = discussion_fork_args("fork_plan", "the prompt".to_string());

        // `-p <prompt>` leads; MCP is stripped; never plan mode.
        assert_eq!(args[0], "-p");
        assert_eq!(args[1], "the prompt");
        assert!(args.iter().any(|a| a == "--strict-mcp-config"));
        assert!(!args.iter().any(|a| a == "plan"), "must never be plan mode");

        // The `--tools` set: Bash is present (for curl) but no write/plan tools.
        let tools_idx = args.iter().position(|a| a == "--tools").unwrap();
        let tools = &args[tools_idx + 1];
        assert_eq!(tools, "Read,Grep,Glob,WebFetch,WebSearch,Bash");
        for forbidden in ["Edit", "Write", "ExitPlanMode", "NotebookEdit", "Task"] {
            assert!(
                !tools.split(',').any(|t| t == forbidden),
                "`{forbidden}` must not be in the discussion-fork tool set"
            );
        }

        // The `--allowedTools` values run from just after the flag to the next
        // flag (`--strict-mcp-config`). It must be EXACTLY the two web tools plus
        // the three scoped-curl quoting variants — nothing else.
        let allow_idx = args.iter().position(|a| a == "--allowedTools").unwrap();
        let allow: Vec<&str> = args[allow_idx + 1..]
            .iter()
            .take_while(|a| !a.starts_with("--"))
            .map(String::as_str)
            .collect();
        assert_eq!(
            allow,
            vec![
                "WebSearch",
                "WebFetch",
                "Bash(curl -s http://127.0.0.1:7676/*)",
                "Bash(curl -s 'http://127.0.0.1:7676/*)",
                "Bash(curl -s \"http://127.0.0.1:7676/*)",
            ],
            "the allow-list must be exactly the web tools + the three scoped curl variants"
        );

        // No bare `Bash` allow (that would permit arbitrary commands), and every
        // Bash allow targets ONLY the localhost daemon.
        for a in &allow {
            if a.starts_with("Bash(") {
                assert!(
                    a.contains("curl -s http://127.0.0.1:7676/")
                        || a.contains("curl -s 'http://127.0.0.1:7676/")
                        || a.contains("curl -s \"http://127.0.0.1:7676/"),
                    "Bash allow `{a}` must be scoped to the localhost daemon"
                );
            }
        }
        assert!(
            !allow.iter().any(|a| *a == "Bash"),
            "a bare `Bash` allow would defeat the scoping — it must never appear"
        );
    }

    #[test]
    fn fork_key_is_session_scoped() {
        // The same comment id in different sessions must not collide.
        assert_ne!(fork_key("s1", "c-001"), fork_key("s2", "c-001"));
        assert_eq!(fork_key("s1", "c-001"), fork_key("s1", "c-001"));
    }

    #[test]
    fn thread_status_streams_while_registered_and_idles_after_removal() {
        // The status command is what lets a remounted thread rediscover an
        // in-flight turn after a session switch — it must mirror the registry
        // exactly: streaming (with the start stamp) while the entry exists,
        // idle the moment it's removed.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let procs: ForkRegistry = Arc::new(Mutex::new(HashMap::new()));
            let idle = thread_status_in(&procs, "scope-1", "item-1");
            assert!(!idle.streaming);
            assert_eq!(idle.started_at, None);

            let child = tokio::process::Command::new("sleep")
                .arg("30")
                .kill_on_drop(true)
                .spawn()
                .expect("spawn sleep");
            let key = fork_key("scope-1", "item-1");
            procs.lock().unwrap().insert(
                key.clone(),
                ForkProc {
                    child,
                    started_at: 1234,
                },
            );

            let live = thread_status_in(&procs, "scope-1", "item-1");
            assert!(live.streaming);
            assert_eq!(live.started_at, Some(1234));
            // Scoping holds: the same item id in another scope reads idle.
            assert!(!thread_status_in(&procs, "scope-2", "item-1").streaming);

            let mut p = procs.lock().unwrap().remove(&key).unwrap();
            let _ = p.child.start_kill();
            let done = thread_status_in(&procs, "scope-1", "item-1");
            assert!(!done.streaming);
            assert_eq!(done.started_at, None);
        });
    }

    #[test]
    fn first_turn_prompt_carries_comment_and_guardrails() {
        let p = build_first_turn_prompt(
            true,
            "A.1",
            Some("the detail section"),
            "Why this order?",
            None,
            &[],
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
        let p = build_first_turn_prompt(false, "B", None, "Reconsider this.", None, &[]);
        assert!(p.contains("§B"));
        assert!(p.contains("left a comment"));
        assert!(p.contains("Reconsider this."));
    }

    fn review_ann(kind: &str) -> ReviewAnnotation {
        ReviewAnnotation {
            id: "rc-001".to_string(),
            review_id: "rev-1".to_string(),
            round: 1,
            file_path: "src/db.rs".to_string(),
            side: "new".to_string(),
            start_line: 42,
            end_line: 45,
            kind: kind.to_string(),
            body: String::new(),
            suggestion_replacement: if kind == "suggestion" {
                Some("let x = y?;".to_string())
            } else {
                None
            },
            quoted_text: "let x = y.unwrap();".to_string(),
            status: "draft".to_string(),
            resolution: None,
            created_at: 1,
            scope: "line".to_string(),
            label: None,
            blocking: None,
            source: "user".to_string(),
        }
    }

    #[test]
    fn review_first_turn_prompt_grounds_on_the_diff_range() {
        let p = build_review_first_turn_prompt(&review_ann("suggestion"), "Safer this way?");
        assert!(p.contains("src/db.rs"));
        assert!(p.contains("lines 42-45"));
        assert!(p.contains("new side"));
        assert!(p.contains("> let x = y.unwrap();"));
        assert!(p.contains("> let x = y?;"));
        assert!(p.contains("Safer this way?"));
        assert!(p.contains("proposed a replacement"));
        // Read-only guardrails, same bar as plan threads.
        assert!(p.contains("ExitPlanMode"));
        assert!(p.contains("do not edit files"));
        // Grounding instruction: read the real file first.
        assert!(p.contains("reading the file"));
    }

    #[test]
    fn review_first_turn_prompt_kind_variants() {
        let del = build_review_first_turn_prompt(&review_ann("deletion"), "why keep this?");
        assert!(del.contains("marked for deletion"));
        let mut single = review_ann("comment");
        single.end_line = 42;
        let c = build_review_first_turn_prompt(&single, "hm");
        assert!(c.contains("left a comment"));
        assert!(c.contains("line 42"));
        assert!(!c.contains("lines 42"));
    }

    #[test]
    fn review_first_turn_prompt_carries_prior_resolution() {
        let mut ann = review_ann("comment");
        ann.resolution = Some("Fixed by using ?".to_string());
        let p = build_review_first_turn_prompt(&ann, "still crashes though");
        assert!(p.contains("previously resolved"));
        assert!(p.contains("Fixed by using ?"));
    }

    #[test]
    fn first_turn_prompt_grounds_in_prior_resolution() {
        let p = build_first_turn_prompt(
            false,
            "A",
            None,
            "But what about retries?",
            Some("I added exponential backoff in §A."),
            &[],
        );
        assert!(p.contains("You previously resolved this comment with:"));
        assert!(p.contains("exponential backoff"));
    }
}
