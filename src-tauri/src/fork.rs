// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Headless agent forks backing per-comment discussion threads.
//!
//! Each "Discuss" thread is a context-aware fork of the plan session that
//! answers a comment inline without disturbing the held `:7676` hook. The
//! first turn forks the plan session (capturing a new session id); follow-ups
//! plain-resume the fork.
//!
//! **Two command protocols, one lifecycle.** A plan-comment thread runs on the
//! harness that AUTHORED the plan (`sessions.backend`), because a fork is a
//! fork *of that conversation*:
//!
//! - `claude-code` — `claude -p --resume <id> [--fork-session] --output-format
//!   stream-json --include-partial-messages …`, classified by
//!   `claude_proc::classify_line`. Token-level deltas.
//! - `codex` — `codex -s read-only -a never --search -c
//!   developer_instructions=… exec fork|resume --json --skip-git-repo-check
//!   <id> <prompt>`, classified by `classify_codex_line`. `codex exec --json`
//!   has no delta flag, so the reply lands as ONE `item.completed` chunk.
//!
//! Handing one CLI the other's id does not error — `claude --resume <codex
//! thread>` silently starts a FRESH session — so the backend is persisted
//! beside the fork id (`comments.fork_backend`) and a mismatch is repaired by
//! re-forking on the right harness rather than resumed.
//!
//! Everything downstream of the classifier is shared: `fork-delta` events,
//! `fork-done` / `fork-error` / `fork-cancelled`, cancellation, the partial
//! buffer, and `thread_messages` rows written only when a turn finishes.
//!
//! Review-annotation, Ask-AI and Drafter threads stay on the standalone Claude
//! path: they have no plan session to fork, so there is no provenance to obey.
//!
//! Mirrors `pty.rs`'s keyed-registry pattern, but with `tokio::process`
//! (headless, no PTY) instead of `portable-pty`.

use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

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
use crate::turn::{self, PartialBuf, TurnStatus, Turns};

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

/// Which harness a discussion fork runs on. Only plan-comment threads can be
/// anything but `Claude`: the other three families start a fresh session in a
/// repo rather than forking a conversation, so there is no provenance to obey.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ForkBackend {
    Claude,
    Codex,
}

impl ForkBackend {
    /// Read a stored `sessions.backend` / `comments.fork_backend` value.
    /// Anything missing, blank or unrecognised is Claude — every row written
    /// before this column existed belongs to the only implementation there
    /// then was.
    fn from_stored(value: &str) -> Self {
        if value.trim().eq_ignore_ascii_case("codex") {
            Self::Codex
        } else {
            Self::Claude
        }
    }

    /// The persisted form, matching `sessions.backend`.
    fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude-code",
            Self::Codex => "codex",
        }
    }

    /// The CLI's own name — what failure text must say, so "codex exited
    /// abnormally" never reads as a Claude problem the user can't find.
    fn cli(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
}

/// Composite registry key. Comment ids are session-scoped (`c-001` restarts
/// per session), so a bare comment_id collides across sessions. NUL cannot
/// appear in a session UUID or a `c-NNN` id, so it is a safe separator.
fn fork_key(session_id: &str, comment_id: &str) -> String {
    format!("{session_id}\u{0}{comment_id}")
}

/// Registry of running fork turns, keyed by `fork_key`, on the shared
/// `turn::Turns` contract (atomic slot reservation + probeable partial
/// buffer + `started_at` for the elapsed counter). Cloned into managed Tauri
/// state.
#[derive(Clone)]
pub struct ForkState {
    turns: Arc<Turns<()>>,
    db: Arc<Database>,
    /// Absolute path to the `claude` binary, resolved lazily on first fork
    /// use — a Finder-launched app inherits a minimal PATH and cannot find it
    /// by name. Resolution may shell out to the user's interactive rc files,
    /// and macOS attributes that child's file access to Redline (TCC), so it
    /// must never run at app startup.
    claude_bin: Arc<OnceLock<String>>,
    /// Absolute path to the `codex` binary, resolved lazily on the same terms
    /// and for a sharper reason: on a machine with the ChatGPT desktop app,
    /// `$PATH` usually still resolves `codex` to an older standalone build
    /// with no `exec fork` at all.
    codex_bin: Arc<OnceLock<String>>,
}

impl ForkState {
    pub fn new(db: Arc<Database>) -> Self {
        Self {
            turns: Arc::new(Turns::new()),
            db,
            claude_bin: Arc::new(OnceLock::new()),
            codex_bin: Arc::new(OnceLock::new()),
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
        // Atomic reservation; early `?` returns release it via the guard's Drop.
        let slot = self.turns.begin(&key).map_err(|_| {
            "that plan session is already being consulted — try again in a moment".to_string()
        })?;
        let framed = format!(
            "You are an ephemeral read-only fork of this planning session. The \
             user's COMPANION — their global cross-surface discussion — is \
             checking in about THIS plan and its conversation so far. Synthesize \
             what matters for their question as a tight DIGEST (not a transcript, \
             not a new plan; never call ExitPlanMode). Be concise. Their \
             question:\n\n{}",
            question.trim()
        );
        crate::ledger::register_agent_prompt(&framed);

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
        if let Err(mut child) = slot.attach(child) {
            // Cancelled during the spawn window — the reservation is gone.
            let _ = child.start_kill();
            return Err("the consult was cancelled".to_string());
        }

        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(180),
            crate::claude_proc::collect_turn_seated(&self.db, "fork_plan", stdout, stderr),
        )
        .await;
        let proc = self.turns.take(&key).and_then(|p| p.child);
        let outcome = match outcome {
            Ok(o) => o,
            Err(_) => {
                if let Some(mut child) = proc {
                    let _ = child.start_kill();
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
        if let Some(mut child) = proc {
            let _ = child.wait().await;
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

    /// The resolved `codex` path, on the same lazy/blocking terms as
    /// `claude_bin` — `resolve_codex_bin` can end in an interactive login-shell
    /// probe, which must never run on the async runtime or at app startup.
    async fn codex_bin(&self) -> Result<String, String> {
        let cell = self.codex_bin.clone();
        tokio::task::spawn_blocking(move || {
            cell.get_or_init(crate::codex_app_server::resolve_codex_bin)
                .clone()
        })
        .await
        .map_err(|e| format!("failed to resolve the `codex` CLI: {e}"))
    }

    /// True if `session_id` is the forked session of any comment — the
    /// `handle_plan` guard against a stray `ExitPlanMode` POST from a fork.
    pub fn is_known_fork_session(&self, session_id: &str) -> bool {
        self.db.is_known_fork_session(session_id)
    }

    /// Kill every running fork. Backs the `fork_kill_all` command and the
    /// app-teardown hook so no `claude` child is left orphaned.
    pub fn kill_all(&self) {
        self.turns.kill_all();
    }
}

// --- Event payloads --------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ForkDelta {
    session_id: String,
    comment_id: String,
    text: String,
    /// This delta's position in the turn's stream — `fork_thread_status`
    /// reports the seq already folded into `partial`, and the frontend drops
    /// any delta at or below that watermark.
    seq: u64,
}

/// What the turn is spending and what it is doing. Flattened so the composite
/// key the frontend hook matches on (`sessionId` + `commentId`) stays at the
/// top level, like every other fork event.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ForkMeter {
    session_id: String,
    comment_id: String,
    #[serde(flatten)]
    meter: turn::MeterPayload,
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

/// A transient failure is being retried, silently, on the same message. The
/// turn never leaves `streaming` — this only changes what the bubble says
/// while the second attempt runs.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ForkRetry {
    session_id: String,
    comment_id: String,
    /// 1-based index of the attempt about to start (always 2 today).
    attempt: u32,
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

/// Render the turns a REPLACEMENT fork must inherit as text.
///
/// A replacement happens when the stored fork belongs to the other harness (see
/// `fork_thread_send`): the transcript the reviewer can see is real and must
/// not vanish, but the conversation behind it cannot be resumed. So the visible
/// history is carried into the new fork's first turn as *context*, bounded in
/// both turns and characters — a discussion thread can run long, and the point
/// is continuity, not replaying the whole exchange.
///
/// Only completed, non-error turns: an error row is Redline's own failure text,
/// never something the previous agent said.
fn continuity_block(messages: &[ThreadMessage]) -> Option<String> {
    /// Turns carried forward, newest-last.
    const MAX_TURNS: usize = 8;
    /// Per-turn character ceiling — a pasted stack trace must not crowd out
    /// the turns around it.
    const MAX_CHARS: usize = 1_200;

    let usable: Vec<&ThreadMessage> = messages
        .iter()
        .filter(|m| m.status == "complete" && !m.body.trim().is_empty())
        .collect();
    if usable.is_empty() {
        return None;
    }
    let recent = &usable[usable.len().saturating_sub(MAX_TURNS)..];
    let mut out = String::from(
        "This discussion already has history, carried over from an earlier \
         agent. Treat it as CONTEXT ONLY — you did not write these replies, and \
         you are not being asked to repeat or defend them:\n",
    );
    for m in recent {
        let who = if m.role == "user" { "Reviewer" } else { "Assistant" };
        let body = m.body.trim();
        let truncated: String = body.chars().take(MAX_CHARS).collect();
        out.push_str(&format!("\n{who}: {truncated}"));
        if truncated.len() < body.len() {
            out.push('…');
        }
        out.push('\n');
    }
    Some(out)
}

fn build_first_turn_prompt(
    is_question: bool,
    anchor_id: &str,
    quoted: Option<&str>,
    opening: &str,
    prior_resolution: Option<&str>,
    attachments: &[CommentAttachment],
    // Prior turns to inherit (`continuity_block`). `None` for an ordinary
    // first turn, which keeps this prompt byte-identical to the one every
    // Claude discussion has always been given.
    continuity: Option<&str>,
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
    // Inherited history sits BEFORE the message it leads up to, and relabels
    // that message as the latest one — "their comment" would otherwise read as
    // the opening of a conversation that visibly already happened.
    if let Some(block) = continuity.filter(|c| !c.trim().is_empty()) {
        p.push_str(block);
        p.push('\n');
        p.push_str("Their latest message:\n");
    } else {
        p.push_str("Their comment:\n");
    }
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
        crate::claude_proc::HEADLESS_TOOLS.to_string(),
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

/// The Codex fork's `developer_instructions`.
///
/// A Codex discussion fork inherits the plan session's whole rollout, and that
/// rollout carries the *planning* contract (`codex_profile::CONTRACT`, layered
/// in by `-p redline-plan`). Two things follow, and this text exists for both:
///
/// 1. **The plan profile must NOT be re-applied here.** Its contract tells the
///    model to end its turn with a `<proposed_plan>` block, which the Stop hook
///    would then capture as a revision of the very plan under review — a
///    discussion thread silently rewriting the document it is discussing.
/// 2. **The inherited history must be demoted to context.** Without saying so,
///    a forked thread reads its own planning instructions as still in force.
///
/// So the sandbox stays `read-only` with approvals `never` (the physical half),
/// and this is the instruction half. Kept short: it is prepended to a
/// conversation that already has thousands of tokens of plan behind it.
const CODEX_SIDECAR_INSTRUCTIONS: &str = "\
You are a READ-ONLY SIDE CONVERSATION about a plan you already produced. The \
planning history you inherited is CONTEXT ONLY: any earlier instruction to \
produce, revise or submit a plan is void for this conversation.

Rules for every turn here:
- Never emit a `<proposed_plan>` block, and never submit or revise the plan. \
The reviewer routes anything actionable back into the plan themselves.
- Never edit, create or delete files, and never run a command that changes \
anything. Reading the repo, searching it and searching the web are all fine.
- Answer the reviewer directly, in Markdown, leading with the answer. Add a \
table, a mermaid diagram or a short code block only where it adds signal. No \
raw HTML.
- The turn prompt may mention a `sidecar` skill or `ExitPlanMode`; both are \
Claude-side and do not apply to you. Ignore them and answer directly.";

/// Spawn args for one Codex discussion-fork turn.
///
/// `subcommand` is `fork` on the first turn (of the PLAN thread, minting a new
/// thread id) and `resume` thereafter (of this discussion's own thread). The
/// two take identical flags, which is why they share one builder.
///
/// Flag placement is not stylistic: `-s`, `-a`, `--search` and `-c` are
/// TOP-LEVEL options and are rejected after the subcommand, while `--json` and
/// `--skip-git-repo-check` belong to `exec fork` / `exec resume`. Verified
/// against codex-cli 0.149.0-alpha.4.3.
///
/// No `-p redline-plan`: see `CODEX_SIDECAR_INSTRUCTIONS`. `-s read-only -a
/// never` is the physical counterpart to the Claude arm's withheld
/// `Edit`/`Write` tools, and `--search` its `WebSearch`/`WebFetch` allow.
fn codex_discussion_fork_args(
    subcommand: &str,
    thread_id: &str,
    prompt: String,
) -> Vec<String> {
    vec![
        "-s".to_string(),
        "read-only".to_string(),
        "-a".to_string(),
        "never".to_string(),
        "--search".to_string(),
        "-c".to_string(),
        // `-c` parses its value as TOML and only falls back to a raw literal
        // when that fails, so the instructions are TOML-quoted rather than
        // handed over bare (`codex_profile::toml_string`, same encoder the
        // profile file uses).
        format!(
            "developer_instructions={}",
            crate::codex_profile::toml_string(CODEX_SIDECAR_INSTRUCTIONS)
        ),
        "exec".to_string(),
        subcommand.to_string(),
        "--json".to_string(),
        // Discussion threads follow the plan session's cwd, which is not
        // required to be a git repo (a plan can be about anything).
        "--skip-git-repo-check".to_string(),
        thread_id.to_string(),
        prompt,
    ]
}

/// One classified line of `codex exec --json` output.
///
/// Deliberately its own enum rather than `claude_proc::StreamLine`: the two
/// protocols disagree about what a "final" line is. Claude ends a turn with one
/// authoritative `result` carrying the whole reply; Codex emits each agent
/// message as it completes and then a separate `turn.completed` with only
/// usage. Pure, so the whole wire contract is testable from fixtures.
#[derive(Debug, PartialEq, Eq)]
enum CodexLine {
    /// `thread.started` — the thread this turn runs in. On `exec fork` that is
    /// the NEW fork id (what gets persisted); on `exec resume` it is the id we
    /// passed in, so persisting it again is a harmless no-op.
    Thread(String),
    /// A completed `agent_message` item — reply text.
    Message(String),
    /// `turn.completed` — the turn ended cleanly. Carries only usage, never
    /// text, so it is never mistaken for a reply.
    Completed,
    /// `turn.failed`, a top-level `error`, or a completed `error` item.
    Failed(String),
    /// `turn.started`, `item.started`/`item.updated`, and every non-message
    /// item (`reasoning`, `command_execution`, `file_change`, `mcp_tool_call`,
    /// `web_search`, `todo_list`) — a reviewer must never see the agent's
    /// scratch work rendered as its answer.
    Ignore,
}

fn classify_codex_line(v: &Value) -> CodexLine {
    let text_at = |v: &Value, path: &str| {
        v.pointer(path)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    match v.get("type").and_then(Value::as_str) {
        Some("thread.started") => match text_at(v, "/thread_id") {
            Some(id) => CodexLine::Thread(id),
            None => CodexLine::Ignore,
        },
        Some("item.completed") => match v.pointer("/item/type").and_then(Value::as_str) {
            Some("agent_message") => match text_at(v, "/item/text") {
                Some(text) => CodexLine::Message(text),
                None => CodexLine::Ignore,
            },
            Some("error") => CodexLine::Failed(
                text_at(v, "/item/message")
                    .unwrap_or_else(|| "codex reported an error".to_string()),
            ),
            _ => CodexLine::Ignore,
        },
        Some("turn.completed") => CodexLine::Completed,
        Some("turn.failed") | Some("error") => CodexLine::Failed(
            text_at(v, "/error/message")
                .or_else(|| text_at(v, "/message"))
                .unwrap_or_else(|| "codex reported an error".to_string()),
        ),
        _ => CodexLine::Ignore,
    }
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

    // Reject a second concurrent turn for the same comment. The reservation
    // is atomic and spans the whole spawn; early `?` returns release it via
    // the guard's Drop.
    let slot = fork
        .turns
        .begin(&key)
        .map_err(|_| "a reply is still streaming for this comment".to_string())?;

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

    // Which harness authored this plan — the fork has to run on it, because a
    // fork is a fork OF that conversation. Legacy/absent provenance is Claude.
    let backend = ForkBackend::from_stored(&store.backend_of(&session_id));

    // The stored fork, and whether it is still usable. A fork id from the OTHER
    // harness must never be resumed: neither CLI errors on the other's id, so
    // resuming would silently open a fresh, contextless conversation under an
    // id Redline then keeps writing to. Instead the plan session is re-forked
    // on the right harness and the visible transcript is carried across
    // (`continuity_block`) — this is the repair path for any Codex session that
    // already picked up a stray Claude fork.
    let stored_fork = fork.db.get_comment_fork(&session_id, &comment_id);
    let mismatched = stored_fork
        .as_ref()
        .is_some_and(|(_, b)| ForkBackend::from_stored(b) != backend);
    let prior_fork: Option<String> = if mismatched {
        None
    } else {
        stored_fork.map(|(id, _)| id)
    };
    // The turns already on screen, needed only when re-forking — reading them
    // otherwise would be a query per follow-up for nothing.
    let carried = if mismatched {
        fork.db
            .load_thread(&session_id, &comment_id)
            .unwrap_or_default()
    } else {
        Vec::new()
    };

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
                // Empty for a genuine first turn, so that prompt is unchanged;
                // populated only when replacing a wrong-harness fork.
                continuity_block(&carried).as_deref(),
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
            Some(&text),
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
        crate::ledger::register_agent_prompt(&prompt);
    }

    // Build the command on the plan's own harness. Both arms are read-only —
    // Claude by withholding Edit/Write/ExitPlanMode from `--tools` (plus the
    // scoped localhost-daemon curl allow, the ClassMemory retrieval surface),
    // Codex by `-s read-only -a never`. Neither ever runs in plan mode. See
    // `discussion_fork_args` / `codex_discussion_fork_args` and
    // docs/protocol-verification.md Experiment (i).
    let spawn = match backend {
        ForkBackend::Claude => {
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
            ForkSpawn {
                backend,
                seat: "fork_plan",
                bin: fork.claude_bin().await?,
                cwd: cwd.clone(),
                args,
            }
        }
        ForkBackend::Codex => {
            // First turn forks the PLAN thread (minting a new id); follow-ups
            // resume this discussion's own thread.
            let (subcommand, thread_id) = match &prior_fork {
                None => ("fork", session_id.as_str()),
                Some(fork_sid) => ("resume", fork_sid.as_str()),
            };
            ForkSpawn {
                backend,
                seat: "fork_plan",
                bin: fork.codex_bin().await?,
                cwd: cwd.clone(),
                args: codex_discussion_fork_args(subcommand, thread_id, prompt),
            }
        }
    };

    // Spawn. Take stdout/stderr before the child enters the registry.
    let (child, stdout, stderr) = spawn.spawn()?;

    // Attach the running child to the reservation, then start the reader.
    let token = slot.token();
    let buf = slot.buf();
    if let Err(mut child) = slot.attach(child) {
        // Cancelled during the spawn window.
        let _ = child.start_kill();
        let _ = app.emit(
            "fork-cancelled",
            ForkCancelled {
                session_id,
                comment_id,
            },
        );
        return Ok(());
    }
    tauri::async_runtime::spawn(read_fork(
        app,
        fork.db.clone(),
        fork.turns.clone(),
        buf,
        key,
        token,
        session_id,
        comment_id,
        ThreadTarget::PlanComment,
        spawn,
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
    // Atomic reservation; early `?` returns release it via the guard's Drop.
    let slot = fork
        .turns
        .begin(&key)
        .map_err(|_| "a reply is still streaming for this annotation".to_string())?;

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
            Some(&text),
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
        crate::ledger::register_agent_prompt(&prompt);
    }

    // Same read-only discussion-fork tool surface as plan threads (scoped curl
    // allow included — see `discussion_fork_args`).
    let mut args: Vec<String> = discussion_fork_args("fork_review", prompt);
    // First turn: fresh session (no --resume). Follow-ups resume it.
    if let Some(fork_sid) = &prior_fork {
        args.push("--resume".to_string());
        args.push(fork_sid.clone());
    }

    let spawn = ForkSpawn {
        // No plan session behind these threads — always the standalone Claude
        // path (see the module header).
        backend: ForkBackend::Claude,
        seat: "fork_review",
        bin: fork.claude_bin().await?,
        cwd: cwd.clone(),
        args,
    };
    let (child, stdout, stderr) = spawn.spawn()?;

    let token = slot.token();
    let buf = slot.buf();
    if let Err(mut child) = slot.attach(child) {
        // Cancelled during the spawn window.
        let _ = child.start_kill();
        let _ = app.emit(
            "fork-cancelled",
            ForkCancelled {
                session_id: review_id,
                comment_id: annotation_id,
            },
        );
        return Ok(());
    }
    tauri::async_runtime::spawn(read_fork(
        app,
        fork.db.clone(),
        fork.turns.clone(),
        buf,
        key,
        token,
        review_id,
        annotation_id,
        ThreadTarget::ReviewAnnotation,
        spawn,
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
    // Atomic reservation; early `?` returns release it via the guard's Drop.
    let slot = fork
        .turns
        .begin(&key)
        .map_err(|_| "a reply is still streaming for this question".to_string())?;

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
            Some(&text),
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
        crate::ledger::register_agent_prompt(&prompt);
    }

    // Same read-only discussion-fork tool surface as the annotation threads
    // (scoped curl allow included — see `discussion_fork_args`).
    let mut args: Vec<String> = discussion_fork_args("fork_review", prompt);
    if let Some(fork_sid) = &prior_fork {
        args.push("--resume".to_string());
        args.push(fork_sid.clone());
    }

    let spawn = ForkSpawn {
        // No plan session behind these threads — always the standalone Claude
        // path (see the module header).
        backend: ForkBackend::Claude,
        seat: "fork_review",
        bin: fork.claude_bin().await?,
        cwd: cwd.clone(),
        args,
    };
    let (child, stdout, stderr) = spawn.spawn()?;

    let token = slot.token();
    let buf = slot.buf();
    if let Err(mut child) = slot.attach(child) {
        // Cancelled during the spawn window.
        let _ = child.start_kill();
        let _ = app.emit(
            "fork-cancelled",
            ForkCancelled {
                session_id: review_id,
                comment_id: question_id,
            },
        );
        return Ok(());
    }
    tauri::async_runtime::spawn(read_fork(
        app,
        fork.db.clone(),
        fork.turns.clone(),
        buf,
        key,
        token,
        review_id,
        question_id,
        ThreadTarget::ReviewQuestion,
        spawn,
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
    if let Some(mut child) = fork.turns.take(&key).and_then(|p| p.child) {
        let _ = child.start_kill();
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
    // Atomic reservation; early `?` returns release it via the guard's Drop.
    let slot = fork
        .turns
        .begin(&key)
        .map_err(|_| "a reply is still streaming for this comment".to_string())?;

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
            Some(&text),
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
        crate::ledger::register_agent_prompt(&prompt);
    }

    let mut args: Vec<String> = discussion_fork_args("fork_drafter", prompt);
    if let Some(fork_sid) = &prior_fork {
        args.push("--resume".to_string());
        args.push(fork_sid.clone());
    }

    let spawn = ForkSpawn {
        // No plan session behind these threads — always the standalone Claude
        // path (see the module header).
        backend: ForkBackend::Claude,
        seat: "fork_drafter",
        bin: fork.claude_bin().await?,
        cwd: cwd.clone(),
        args,
    };
    let (child, stdout, stderr) = spawn.spawn()?;

    let token = slot.token();
    let buf = slot.buf();
    if let Err(mut child) = slot.attach(child) {
        // Cancelled during the spawn window.
        let _ = child.start_kill();
        let _ = app.emit(
            "fork-cancelled",
            ForkCancelled {
                session_id: draft_id,
                comment_id,
            },
        );
        return Ok(());
    }
    tauri::async_runtime::spawn(read_fork(
        app,
        fork.db.clone(),
        fork.turns.clone(),
        buf,
        key,
        token,
        draft_id,
        comment_id,
        ThreadTarget::DraftComment,
        spawn,
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
    if let Some(mut child) = fork.turns.take(&key).and_then(|p| p.child) {
        let _ = child.start_kill();
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

/// Core lookup shared by the command and its test.
fn thread_status_in(turns: &Turns<()>, scope_id: &str, item_id: &str) -> TurnStatus {
    turns.status(&fork_key(scope_id, item_id))
}

/// Whether a discussion thread has a turn streaming right now, since when,
/// and the reply text streamed so far (`partial` + its delta `seq`
/// watermark — the turn-contract extension; existing callers only read
/// `streaming`/`startedAt` and are unaffected). Generic over all four fork
/// families — plan comments, review annotations, review questions, drafter
/// comments — because they share one registry keyed by
/// `fork_key(scope, item)`. Streaming state is otherwise component-local in
/// the frontend: switching sessions unmounts the thread, and a remount would
/// look idle mid-turn (silent thinking stretches emit no deltas) until the
/// send path rejected with "a reply is still streaming". The thread
/// components seed from this on mount instead.
#[tauri::command]
pub fn fork_thread_status(
    fork: tauri::State<'_, ForkState>,
    scope_id: String,
    item_id: String,
) -> TurnStatus {
    thread_status_in(&fork.turns, &scope_id, &item_id)
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
    if let Some(mut child) = fork.turns.take(&key).and_then(|p| p.child) {
        let _ = child.start_kill();
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
    if let Some(mut child) = fork.turns.take(&key).and_then(|p| p.child) {
        let _ = child.start_kill();
    }
    fork.db
        .delete_thread(&session_id, &comment_id)
        .map_err(|e| format!("failed to delete thread: {e}"))?;
    fork.db
        .clear_comment_fork(&session_id, &comment_id)
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
/// Everything one fork turn's child process needs to run — kept whole instead
/// of being consumed at the spawn, because the auto-retry has to run it a
/// second time.
///
/// The retry deliberately re-runs the IDENTICAL arg vector. On a first turn
/// that means re-forking the plan session rather than resuming the fork the
/// failed attempt happened to mint: reusing that id would replay the question
/// *inside* that fork and answer it twice. The cost is one orphaned
/// transcript, which is the cheaper trade.
struct ForkSpawn {
    backend: ForkBackend,
    /// The agent seat. Picks the model/effort flags already baked into `args`,
    /// and labels the child's environment for the prompt-capture hooks.
    seat: &'static str,
    bin: String,
    cwd: String,
    args: Vec<String>,
}

impl ForkSpawn {
    /// Start the child and take its pipes. Callable more than once for the
    /// same turn; every call produces a fresh, identically-configured process.
    fn spawn(&self) -> Result<(Child, ChildStdout, ChildStderr), String> {
        let mut cmd = match self.backend {
            // `claude_command_for_seat` prepends the binary's own dir to PATH
            // so an `#!/usr/bin/env node` shebang (npm installs) finds `node`.
            ForkBackend::Claude => {
                crate::claude_proc::claude_command_for_seat(self.seat, &self.bin)
            }
            ForkBackend::Codex => {
                let mut cmd = tokio::process::Command::new(&self.bin);
                // The same labelling the claude arm gets from
                // `claude_command_for_seat`: command-type capture hooks run
                // inside the child's environment, so this is how a
                // Redline-constructed prompt stays recognisable as machine
                // text rather than the user's typing.
                cmd.env(crate::claude_proc::ENV_AGENT_SEAT, self.seat);
                cmd
            }
        };
        let bin = &self.bin;
        let cli = self.backend.cli();
        let mut child = cmd
            .current_dir(&self.cwd)
            .args(&self.args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    match self.backend {
                        ForkBackend::Claude => format!(
                            "could not find the `claude` CLI (looked for `{bin}`). \
                             Install Claude Code, or launch Redline from a terminal \
                             so it inherits your shell's PATH."
                        ),
                        ForkBackend::Codex => format!(
                            "could not find the `codex` CLI (looked for `{bin}`). \
                             This plan was written by Codex, so its discussions need \
                             Codex too — install it, or point Redline at it in \
                             Settings."
                        ),
                    }
                } else {
                    format!("failed to spawn {cli}: {e}")
                }
            })?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("{cli} stdout unavailable"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| format!("{cli} stderr unavailable"))?;
        Ok((child, stdout, stderr))
    }
}

/// How long to wait before an auto-retry: long enough that a capacity blip has
/// a chance to clear, short enough that the reviewer reads it as one slow turn
/// rather than a hang.
const RETRY_DELAY: Duration = Duration::from_secs(2);

/// Whether a drained attempt should be quietly run again.
///
/// Three conditions, all necessary:
/// - `attempt == 1` — one retry and only one. A second transient failure in a
///   row is signal, not noise, and the reviewer should see it.
/// - `!streamed` — nothing reached the screen. A silent respawn after partial
///   text would have to un-say it.
/// - the error is transient — an overload/capacity blip, not an overflow (the
///   session is over-limit and would fail identically) and not a hard failure.
fn should_retry(attempt: u32, streamed: bool, errored: Option<&str>) -> bool {
    attempt == 1 && !streamed && errored.is_some_and(crate::claude_proc::is_transient)
}

/// What one attempt's drain produced.
struct ForkDrain {
    fork_session: Option<String>,
    final_text: Option<String>,
    errored: Option<String>,
    saw_json: bool,
    /// Whether any `fork-delta` reached the frontend on this attempt.
    ///
    /// This is the auto-retry's precondition. Once a partial reply is on
    /// screen a silent respawn would have to un-say it, and the reviewer would
    /// watch the answer rewrite itself. A transient `error_during_execution`
    /// carries an empty `result` and streams nothing at all, so the case this
    /// whole mechanism exists for is still covered.
    streamed: bool,
    stderr_text: String,
}

/// Drain one attempt's stdout and stderr to EOF, emitting deltas as they land.
/// Split out of `read_fork` because the auto-retry runs it twice.
async fn drain_fork(
    app: &AppHandle,
    buf: &Arc<Mutex<PartialBuf>>,
    session_id: &str,
    comment_id: &str,
    backend: ForkBackend,
    // The fork's Agent Seat, for the Codex arm's model provenance.
    seat: &str,
    stdout: ChildStdout,
    stderr: ChildStderr,
) -> ForkDrain {
    // Codex names no model on the wire; the seat's configured one is the only
    // truth available, and it is the one the badge should show.
    let codex_model = crate::seat::model_for(seat);
    let codex_model = codex_model.as_deref();
    let stdout_fut = async {
        let mut reader = BufReader::new(stdout).lines();
        let mut fork_session: Option<String> = None;
        let mut final_text: Option<String> = None;
        let mut errored: Option<String> = None;
        let mut saw_json = false;
        let mut streamed = false;
        let mut pacer = turn::MeterPacer::default();
        // One delta emitter for both protocols, so the frontend's
        // append-before-emit / seq-watermark contract cannot diverge between
        // them. See `turn::push_delta`.
        let emit_delta = |text: String| {
            let seq = turn::push_delta(buf, &text);
            let _ = app.emit(
                "fork-delta",
                ForkDelta {
                    session_id: session_id.to_string(),
                    comment_id: comment_id.to_string(),
                    text,
                    seq,
                },
            );
        };
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
            // The raw wire, for the inspector. A no-op when it's off —
            // one relaxed atomic load, nothing buffered.
            crate::inspect::capture("fork", comment_id, trimmed);
            // Second pass over the same value — the meter reads what
            // `classify_line` throws away. Codex lines simply fold to nothing,
            // which is the honest reading of a protocol that reports no usage.
            if let Some(payload) = turn::push_meta(buf, &v) {
                if pacer.due(&payload) {
                    let _ = app.emit(
                        "fork-meter",
                        ForkMeter {
                            session_id: session_id.to_string(),
                            comment_id: comment_id.to_string(),
                            meter: payload,
                        },
                    );
                }
            }
            match backend {
                ForkBackend::Claude => match classify_line(&v) {
                    StreamLine::Init(sid) => fork_session = Some(sid),
                    StreamLine::Delta(text) => {
                        streamed = true;
                        emit_delta(text);
                    }
                    StreamLine::Final { text, session_id: sid } => {
                        if sid.is_some() {
                            fork_session = sid;
                        }
                        final_text = Some(text);
                    }
                    StreamLine::Failed(msg) => errored = Some(msg),
                    StreamLine::Ignore => {}
                },
                ForkBackend::Codex => match classify_codex_line(&v) {
                    CodexLine::Thread(id) => fork_session = Some(id),
                    CodexLine::Message(text) => {
                        // `codex exec --json` has no delta flag, so a message
                        // arrives whole. It is still pushed through the delta
                        // path: that is what fills the partial buffer a
                        // mid-turn remount recovers from, and what puts the
                        // reply on screen a beat before `fork-done`.
                        streamed = true;
                        emit_delta(text.clone());
                        // Codex can complete more than one agent message in a
                        // turn and has no single authoritative "result" line,
                        // so they accumulate — last-wins would silently drop
                        // everything said before the closing paragraph.
                        match &mut final_text {
                            Some(prev) => {
                                prev.push_str("\n\n");
                                prev.push_str(&text);
                            }
                            None => final_text = Some(text),
                        }
                    }
                    CodexLine::Failed(msg) => errored = Some(msg),
                    CodexLine::Completed => {
                        // Codex reports no usage on any captured shape, so
                        // this is provenance more than economics: the badge
                        // reads "Codex · <model>" instead of nothing. The
                        // fold still goes through the ONE accounting rule.
                        let codex = crate::meter::from_codex_turn(&v, codex_model);
                        if !codex.is_empty() {
                            let mut b = buf.lock().unwrap();
                            b.meter = codex;
                        }
                    }
                    CodexLine::Ignore => {}
                },
            }
        }
        (fork_session, final_text, errored, saw_json, streamed)
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
    let ((fork_session, final_text, errored, saw_json, streamed), stderr_text) =
        tokio::join!(stdout_fut, stderr_fut);
    ForkDrain {
        fork_session,
        final_text,
        errored,
        saw_json,
        streamed,
        stderr_text,
    }
}

async fn read_fork(
    app: AppHandle,
    db: Arc<Database>,
    turns: Arc<Turns<()>>,
    buf: Arc<Mutex<PartialBuf>>,
    key: String,
    // The reservation's token. Threaded through so the terminal reap and the
    // retry's `reattach` only ever touch THIS turn's slot — a successor
    // started after a cancel must not be stolen by a dead reader.
    token: u64,
    session_id: String,
    comment_id: String,
    target: ThreadTarget,
    // The recipe that produced the running child, kept so a transient failure
    // can be retried on an identical one.
    spawn: ForkSpawn,
    stdout: ChildStdout,
    stderr: ChildStderr,
) {
    // Which protocol this child speaks, and whose name its failures carry.
    let backend = spawn.backend;
    let cli = backend.cli();

    // Drain, and on a transient failure that produced no visible text at all,
    // quietly run the turn once more. One retry only: a second transient
    // failure is signal, not noise, and the reviewer should see it.
    let mut stdout = stdout;
    let mut stderr = stderr;
    let mut attempt: u32 = 1;
    let drain = loop {
        let d = drain_fork(&app, &buf, &session_id, &comment_id, backend, spawn.seat, stdout, stderr)
            .await;

        if !should_retry(attempt, d.streamed, d.errored.as_deref()) {
            break d;
        }

        attempt += 1;
        // Say so before the wait, so the bubble stops looking stalled.
        let _ = app.emit(
            "fork-retry",
            ForkRetry {
                session_id: session_id.clone(),
                comment_id: comment_id.clone(),
                attempt,
            },
        );
        tokio::time::sleep(RETRY_DELAY).await;

        // Cancelled during the wait? Don't spawn a child just to kill it. The
        // token-matched `reattach` below is still the correctness boundary —
        // this only skips the pointless work in the common case.
        if !turns.is_running(&key) {
            break d;
        }
        // A spawn failure here is not worth reporting over the transient error
        // that caused the retry — fall through to the normal error path.
        let Ok((child, out, err)) = spawn.spawn() else {
            break d;
        };
        // Swap the child INTO the existing reservation rather than taking a new
        // one: the turn must stay busy across the retry so Stop keeps killing
        // the live child and a queued send cannot start underneath it.
        match turns.reattach(&key, token, child) {
            Ok(previous) => {
                // The exhausted child has already hit EOF on both pipes; reap
                // it so it does not linger.
                if let Some(mut old) = previous {
                    let _ = old.wait().await;
                }
            }
            Err(mut fresh) => {
                // Cancelled (or superseded) during the wait — kill what we just
                // spawned and let the terminal path settle this as cancelled.
                let _ = fresh.start_kill();
                break d;
            }
        }
        stdout = out;
        stderr = err;
    };

    let ForkDrain {
        fork_session,
        final_text,
        errored,
        saw_json,
        stderr_text,
        streamed: _,
    } = drain;

    // Reap: pull the entry, then await the child. The key being gone before
    // we removed it means cancel/discard/kill_all already pulled it. Removal
    // happens BEFORE the terminal event — the (Phase 3) queue drain fires at
    // terminal time and must pass the busy guard.
    let proc = turns.take_owned(&key, token);
    let cancelled = proc.is_none() && final_text.is_none();
    let exit_ok = match proc.and_then(|p| p.child) {
        Some(mut child) => child.wait().await.map(|s| s.success()).unwrap_or(false),
        None => false,
    };

    // ABOVE the terminal branch, so success, error and cancelled all book.
    // A cancelled turn spent its input tokens too — and a RETRIED turn spent
    // both attempts', which is why the meter lives on the buffer across the
    // retry loop rather than per drain.
    let settled = crate::meter::settle(&db, spawn.seat, &buf);
    if !settled.is_empty() {
        let _ = app.emit(
            "fork-meter",
            ForkMeter {
                session_id: session_id.clone(),
                comment_id: comment_id.clone(),
                meter: turn::MeterPayload {
                    rev: settled.rev,
                    meter: settled.clone(),
                    activity: None,
                    discrete: true,
                },
            },
        );
    }

    'terminal: {
    if cancelled {
        let _ = app.emit(
            "fork-cancelled",
            ForkCancelled {
                session_id,
                comment_id,
            },
        );
        break 'terminal;
    }
    if let Some(err) = errored {
        // Humanise BEFORE persisting: `err` is a machine string
        // (`error_during_execution`), and `finish_error` writes it into
        // `thread_messages.body` under an assistant role, where the reviewer
        // reads it as Claude's reply and peer agents read it as context.
        let why = describe_fork_error(&db, target, &session_id, &comment_id, &err);
        let row = finish_error(&app, &db, &session_id, &comment_id, &why);
        crate::meter::attach(&db, "fork", &row, &settled);
        break 'terminal;
    }
    if let Some(text) = final_text {
        if text.trim().is_empty() {
            let row = finish_error(
                &app,
                &db,
                &session_id,
                &comment_id,
                &format!("{cli} produced an empty reply"),
            );
            crate::meter::attach(&db, "fork", &row, &settled);
            break 'terminal;
        }
        // Persist the fork session id so the next turn resumes (not re-forks).
        // For plan comments the BACKEND rides with it — the id alone cannot say
        // which binary can resume it, and a mismatch is what re-forks the thread
        // rather than silently opening a contextless conversation.
        // For review threads, `session_id`/`comment_id` are the review /
        // annotation ids and the resume id lives on the annotation row.
        if let Some(fork_sid) = &fork_session {
            let persisted = match target {
                ThreadTarget::PlanComment => {
                    db.set_comment_fork(&session_id, &comment_id, fork_sid, backend.as_str())
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
        // The badge and the footer outlive the turn.
        crate::meter::attach(&db, "fork", &msg.id, &settled);
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
        break 'terminal;
    }

    // The stream ended without a final message — surface stderr or a generic
    // cause. Named for the harness that actually ran: a Codex fork reporting
    // that "claude failed" sends the user looking in the wrong place. These
    // three are already human AND carry a stderr tail worth keeping, so they
    // skip `describe_fork_error` (which passes them through unchanged anyway,
    // unless the tail happens to contain a word like "timeout").
    let why = if !exit_ok && !stderr_text.trim().is_empty() {
        let detail: String = stderr_text.trim().chars().take(500).collect();
        format!("{cli} exited abnormally: {detail}")
    } else if !saw_json {
        format!("{cli} produced no parseable output")
    } else {
        format!("{cli} ended without producing a reply")
    };
    let row = finish_error(&app, &db, &session_id, &comment_id, &why);
    crate::meter::attach(&db, "fork", &row, &settled);
    }
}

/// Translate a failed fork turn into the sentence to show. The branches and
/// the wording live once, in `claude_proc::describe_turn_error`; what is
/// fork's own is the overflow recovery, dispatched on `ThreadTarget` exactly
/// like the `set_*_fork_session` match in `read_fork`. Clearing the stored
/// fork id is what makes the next turn start a fresh discussion instead of
/// re-`--resume`-ing a context that has already proved too big.
///
/// Only the `StreamLine::Failed` path routes through here. The generic endings
/// ("claude exited abnormally: …") are already human AND carry a stderr tail
/// worth keeping, so they go straight to `finish_error` — running them through
/// a classifier that matches the substring "timeout" would throw that detail
/// away for a generic retry sentence.
fn describe_fork_error(
    db: &Database,
    target: ThreadTarget,
    session_id: &str,
    comment_id: &str,
    error: &str,
) -> String {
    crate::claude_proc::describe_turn_error(
        db,
        crate::claude_proc::TurnErrorCopy {
            surface: "fork",
            subject: Some(session_id),
            noun: "discussion",
            next: "I'll start fresh on this thread",
        },
        error,
        || {
            let cleared = match target {
                ThreadTarget::PlanComment => db.clear_comment_fork(session_id, comment_id),
                ThreadTarget::ReviewAnnotation => {
                    db.clear_review_annotation_fork_session(session_id, comment_id)
                }
                ThreadTarget::ReviewQuestion => {
                    db.clear_review_question_fork_session(session_id, comment_id)
                }
                ThreadTarget::DraftComment => db.clear_draft_comment_fork_session(comment_id),
            };
            if let Err(e) = cleared {
                tracing::warn!(error = %e, "failed to clear over-limit fork session");
            }
        },
    )
}

/// Persist a failed turn as a terminal `error` row and emit `fork-error`, so
/// the failure survives a reload and the thread leaves `streaming` state.
fn finish_error(
    app: &AppHandle,
    db: &Database,
    session_id: &str,
    comment_id: &str,
    error: &str,
) -> String {
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
    // `fork` is the second-busiest prompt surface in the app; a turn that ends
    // without a reply is the failure its users actually feel, and it emitted
    // nothing into the evidence pipeline.
    crate::db::note_friction(
        "fork_turn_failed",
        Some("fork"),
        Some(session_id),
        Some(&error.chars().take(200).collect::<String>()),
    );
    let _ = app.emit(
        "fork-error",
        ForkError {
            session_id: session_id.to_string(),
            comment_id: comment_id.to_string(),
            error: error.to_string(),
        },
    );
    // The id the caller attaches this turn's meter to.
    msg.id
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

        // The `--tools` set: Bash is present (for curl) and Skill so the fork
        // can actually load its skill body, but no write/plan tools. Pin the
        // spawn site to the shared const so the two can't drift apart.
        let tools_idx = args.iter().position(|a| a == "--tools").unwrap();
        let tools = &args[tools_idx + 1];
        assert_eq!(tools, "Read,Grep,Glob,WebFetch,WebSearch,Bash,Skill");
        assert_eq!(*tools, crate::claude_proc::HEADLESS_TOOLS);
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
        // exactly: streaming (with the start stamp and buffered partial)
        // while the entry exists, idle the moment it's removed.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let turns: Arc<Turns<()>> = Arc::new(Turns::new());
            let idle = thread_status_in(&turns, "scope-1", "item-1");
            assert!(!idle.streaming);
            assert_eq!(idle.started_at, None);
            assert_eq!(idle.partial, None);

            let key = fork_key("scope-1", "item-1");
            let slot = turns.begin(&key).expect("begin");
            let buf = slot.buf();
            let child = tokio::process::Command::new("sleep")
                .arg("30")
                .kill_on_drop(true)
                .spawn()
                .expect("spawn sleep");
            slot.attach(child).expect("attach onto live reservation");
            turn::push_delta(&buf, "so far");

            let live = thread_status_in(&turns, "scope-1", "item-1");
            assert!(live.streaming);
            assert!(live.started_at.is_some());
            assert_eq!(live.partial.as_deref(), Some("so far"));
            assert_eq!(live.seq, 1);
            // Scoping holds: the same item id in another scope reads idle.
            assert!(!thread_status_in(&turns, "scope-2", "item-1").streaming);

            if let Some(mut child) = turns.take(&key).and_then(|p| p.child) {
                let _ = child.start_kill();
            }
            let done = thread_status_in(&turns, "scope-1", "item-1");
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
        let p = build_first_turn_prompt(false, "B", None, "Reconsider this.", None, &[], None);
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
            None,
        );
        assert!(p.contains("You previously resolved this comment with:"));
        assert!(p.contains("exponential backoff"));
    }

    // --- Codex plan-comment forks -----------------------------------------

    fn thread_msg(role: &str, body: &str, status: &str) -> ThreadMessage {
        ThreadMessage {
            id: format!("m-{role}-{body}"),
            session_id: "s-1".to_string(),
            comment_id: "c-001".to_string(),
            role: role.to_string(),
            body: body.to_string(),
            status: status.to_string(),
            created_at: 0,
            attachments: Vec::new(),
        }
    }

    /// Stored provenance is the only thing that can answer "which binary can
    /// resume this id" — both id spaces are UUIDs — so an absent or unknown
    /// value must land on Claude, which is what every pre-column row is.
    #[test]
    fn stored_backend_defaults_to_claude() {
        assert_eq!(ForkBackend::from_stored("codex"), ForkBackend::Codex);
        assert_eq!(ForkBackend::from_stored("Codex"), ForkBackend::Codex);
        assert_eq!(ForkBackend::from_stored(" codex "), ForkBackend::Codex);
        for legacy in ["", "  ", "claude-code", "anything-else"] {
            assert_eq!(
                ForkBackend::from_stored(legacy),
                ForkBackend::Claude,
                "`{legacy}` must read as claude"
            );
        }
        assert_eq!(ForkBackend::Codex.as_str(), "codex");
        assert_eq!(ForkBackend::Claude.as_str(), "claude-code");
    }

    /// The first Codex turn forks the PLAN thread. Every element here is
    /// load-bearing and several are position-sensitive: `-s`/`-a`/`--search`/`-c`
    /// are top-level options codex rejects after the subcommand, while `--json`
    /// belongs to `exec fork`.
    #[test]
    fn codex_first_turn_forks_the_plan_thread_read_only() {
        let args = codex_discussion_fork_args("fork", "plan-thread-uuid", "the prompt".to_string());

        // Sandbox + approvals: the physical half of "read-only discussion".
        let sandbox = args.iter().position(|a| a == "-s").expect("-s");
        assert_eq!(args[sandbox + 1], "read-only");
        let approval = args.iter().position(|a| a == "-a").expect("-a");
        assert_eq!(args[approval + 1], "never");
        // Web research parity with the Claude arm's WebSearch/WebFetch allow.
        assert!(args.iter().any(|a| a == "--search"));

        // The subcommand pair, the thread, then the prompt — in that order.
        let exec = args.iter().position(|a| a == "exec").expect("exec");
        assert_eq!(args[exec + 1], "fork");
        assert!(args[exec..].iter().any(|a| a == "--json"));
        assert!(args[exec..].iter().any(|a| a == "--skip-git-repo-check"));
        assert_eq!(args[args.len() - 2], "plan-thread-uuid");
        assert_eq!(args[args.len() - 1], "the prompt");

        // Top-level flags must all precede `exec`.
        for flag in ["-s", "-a", "--search", "-c"] {
            let at = args.iter().position(|a| a == flag).unwrap();
            assert!(at < exec, "`{flag}` is a top-level option and must precede `exec`");
        }

        // NEVER the plan profile: its contract would have this thread emit a
        // `<proposed_plan>` block, which the Stop hook captures as a revision
        // of the very plan being discussed.
        assert!(
            !args.iter().any(|a| a == "-p" || a == "--profile"),
            "the plan profile must not be layered onto a discussion fork"
        );
        assert!(!args.iter().any(|a| a.contains("redline-plan")));

        // The sidecar contract rides as TOML-quoted developer_instructions.
        let instructions = args
            .iter()
            .find(|a| a.starts_with("developer_instructions="))
            .expect("developer_instructions");
        let value = instructions.trim_start_matches("developer_instructions=");
        assert!(value.starts_with('"') && value.ends_with('"'), "must be TOML-quoted");
        let parsed: toml::Value =
            toml::from_str(&format!("k = {value}\n")).expect("must parse as TOML");
        let delivered = parsed["k"].as_str().unwrap();
        assert_eq!(delivered, CODEX_SIDECAR_INSTRUCTIONS);
        assert!(delivered.contains("<proposed_plan>"), "must forbid plan submission");
        assert!(delivered.contains("CONTEXT ONLY"), "inherited history is context");
        assert!(delivered.contains("Never edit"), "must forbid edits");
        assert!(delivered.contains("Markdown"), "must ask for a direct markdown answer");
    }

    /// Follow-ups resume the DISCUSSION's own thread — never re-fork the plan,
    /// which would throw away everything already said.
    #[test]
    fn codex_follow_up_resumes_the_discussion_thread() {
        let first = codex_discussion_fork_args("fork", "plan-thread", "a".to_string());
        let next = codex_discussion_fork_args("resume", "fork-thread", "b".to_string());
        let exec = next.iter().position(|a| a == "exec").expect("exec");
        assert_eq!(next[exec + 1], "resume");
        assert_eq!(next[next.len() - 2], "fork-thread");
        // Identical otherwise: same sandbox, same instructions, same flags.
        assert_eq!(first.len(), next.len());
        assert_eq!(first[..exec], next[..exec]);
    }

    /// The Claude arm is untouched by the Codex work — the flag block, the
    /// partial-message streaming and the fork/resume tail must all still be
    /// exactly what they were.
    #[test]
    fn claude_first_turn_and_follow_up_args_are_unchanged() {
        let mut first = discussion_fork_args("fork_plan", "the prompt".to_string());
        first.extend([
            "--resume".to_string(),
            "plan-session".to_string(),
            "--fork-session".to_string(),
        ]);
        assert!(first.iter().any(|a| a == "--include-partial-messages"));
        assert_eq!(&first[first.len() - 3..], ["--resume", "plan-session", "--fork-session"]);

        let mut next = discussion_fork_args("fork_plan", "the prompt".to_string());
        next.extend(["--resume".to_string(), "fork-session-id".to_string()]);
        assert_eq!(&next[next.len() - 2..], ["--resume", "fork-session-id"]);
        assert!(!next.iter().any(|a| a == "--fork-session"));
        // And nothing Codex leaked into it.
        for codex_only in ["exec", "--json", "--search", "--skip-git-repo-check"] {
            assert!(!first.iter().any(|a| a == codex_only));
        }
    }

    /// The `codex exec --json` wire contract, from lines the real CLI emits
    /// (captured against codex-cli 0.149.0-alpha.4.3).
    #[test]
    fn codex_jsonl_yields_the_fork_id_the_reply_and_errors_only() {
        let line = |raw: &str| classify_codex_line(&serde_json::from_str(raw).unwrap());

        assert_eq!(
            line(r#"{"type":"thread.started","thread_id":"01a0619d-69a5-7cd3"}"#),
            CodexLine::Thread("01a0619d-69a5-7cd3".to_string()),
        );
        assert_eq!(
            line(r#"{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"The answer."}}"#),
            CodexLine::Message("The answer.".to_string()),
        );
        assert_eq!(
            line(r#"{"type":"turn.completed","usage":{"input_tokens":18612,"output_tokens":5}}"#),
            CodexLine::Completed,
        );

        // Noise a reviewer must never see rendered as an answer.
        for noise in [
            r#"{"type":"turn.started"}"#,
            r#"{"type":"item.started","item":{"type":"agent_message","text":"partial"}}"#,
            r#"{"type":"item.completed","item":{"type":"reasoning","text":"thinking out loud"}}"#,
            r#"{"type":"item.completed","item":{"type":"command_execution","command":"ls"}}"#,
            r#"{"type":"item.completed","item":{"type":"web_search","query":"tcp"}}"#,
            r#"{"type":"item.completed","item":{"type":"todo_list","items":[]}}"#,
            r#"{"type":"thread.started"}"#,
            r#"{"type":"something.new"}"#,
        ] {
            assert_eq!(line(noise), CodexLine::Ignore, "must ignore: {noise}");
        }

        // Failures, in all three shapes.
        assert_eq!(
            line(r#"{"type":"turn.failed","error":{"message":"model overloaded"}}"#),
            CodexLine::Failed("model overloaded".to_string()),
        );
        assert_eq!(
            line(r#"{"type":"error","message":"no rollout found for thread id"}"#),
            CodexLine::Failed("no rollout found for thread id".to_string()),
        );
        assert_eq!(
            line(r#"{"type":"item.completed","item":{"type":"error","message":"sandbox denied"}}"#),
            CodexLine::Failed("sandbox denied".to_string()),
        );
        // A failure with nothing quotable still surfaces AS a failure.
        assert_eq!(
            line(r#"{"type":"turn.failed"}"#),
            CodexLine::Failed("codex reported an error".to_string()),
        );
    }

    /// An ordinary first turn must produce the prompt it always has — the
    /// continuity block exists for the repair path only.
    #[test]
    fn continuity_is_absent_from_an_ordinary_first_turn() {
        let plain = build_first_turn_prompt(false, "A", None, "Why?", None, &[], None);
        let empty = build_first_turn_prompt(
            false,
            "A",
            None,
            "Why?",
            None,
            &[],
            continuity_block(&[]).as_deref(),
        );
        assert_eq!(plain, empty, "no usable history must change nothing");
        assert!(plain.contains("Their comment:"));
        assert!(!plain.contains("Their latest message:"));
    }

    /// Replacing a wrong-harness fork keeps the transcript the reviewer can
    /// see: it rides into the new fork as context, bounded, and error rows —
    /// which are Redline's own failure text, not something an agent said —
    /// stay out.
    #[test]
    fn a_replacement_fork_inherits_the_visible_transcript_as_context() {
        let history = vec![
            thread_msg("user", "Why this order?", "complete"),
            thread_msg("assistant", "Because the parser needs it first.", "complete"),
            thread_msg("assistant", "claude exited abnormally: boom", "error"),
            thread_msg("assistant", "   ", "complete"),
        ];
        let block = continuity_block(&history).expect("history to carry");
        assert!(block.contains("CONTEXT ONLY"));
        assert!(block.contains("Reviewer: Why this order?"));
        assert!(block.contains("Assistant: Because the parser needs it first."));
        assert!(
            !block.contains("exited abnormally"),
            "Redline's own error rows are not conversation"
        );

        let p = build_first_turn_prompt(
            false,
            "A.1",
            None,
            "And what about retries?",
            None,
            &[],
            Some(&block),
        );
        assert!(p.contains("Their latest message:"));
        assert!(p.contains("And what about retries?"));
        assert!(p.contains("Because the parser needs it first."));
        // Still the same read-only guardrails.
        assert!(p.contains("do not edit files"));
    }

    /// The screenshot bug, guarded on every surface `fork.rs` backs: a raw
    /// `error_during_execution` must never survive as the body of a
    /// `thread_messages` row — it renders under a byline and peer agents read
    /// it as context.
    #[test]
    fn a_transient_failure_is_humanised_for_every_thread_target() {
        let db = Database::open_in_memory().unwrap();
        for target in [
            ThreadTarget::PlanComment,
            ThreadTarget::ReviewAnnotation,
            ThreadTarget::ReviewQuestion,
            ThreadTarget::DraftComment,
        ] {
            let msg = describe_fork_error(&db, target, "s-1", "c-1", "error_during_execution");
            assert!(!msg.contains("error_during_execution"), "leaked: {msg}");
            assert!(!msg.contains('_'), "machine-looking token in: {msg}");
            assert!(msg.to_lowercase().contains("again"), "no way forward: {msg}");
        }
    }

    /// The overflow branch's recovery, per target: forget the stored fork so
    /// the next turn starts a fresh discussion instead of re-`--resume`-ing a
    /// context that already proved too big. A transient error must NOT do
    /// this — the session is fine.
    #[test]
    fn overflow_clears_the_stored_fork_transient_keeps_it() {
        use crate::state::{
            AttachState, CodeReviewSession, Comment, CommentStatus, DraftComment, ReviewQuestion,
            ReviewSession, Revision, SessionStatus,
        };

        let db = Database::open_in_memory().unwrap();

        // Parent rows first — every thread table is foreign-keyed to the
        // session / review / draft it hangs off.
        db.upsert_session(&ReviewSession {
            session_id: "s-1".to_string(),
            project_path: "/repo".to_string(),
            project_name: "repo".to_string(),
            created_at: 1,
            revisions: Vec::new(),
            status: SessionStatus::InReview,
            attach_state: AttachState::Idle,
            updated_at: 1,
            run_state: None,
            backend: None,
            model: None,
        })
        .unwrap();
        db.insert_revision(
            "s-1",
            &Revision {
                version_number: 1,
                received_at: 1,
                raw_plan_markdown: "# plan".to_string(),
                sections: Vec::new(),
                comments: Vec::new(),
                thread_start: true,
                restored: false,
            },
        )
        .unwrap();
        db.upsert_code_review(&CodeReviewSession {
            review_id: "rev-1".to_string(),
            repo_path: "/repo".to_string(),
            source: "uncommitted".to_string(),
            base_ref: None,
            commit_sha: None,
            terminal_id: None,
            round: 1,
            created_at: 1,
        })
        .unwrap();
        db.upsert_draft("d-1", Some("draft"), None, "# draft", None).unwrap();

        // --- plan comment ---
        db.insert_comment(
            "s-1",
            1,
            &Comment {
                id: "c-1".to_string(),
                kind: CommentKind::Feedback,
                scope: None,
                anchor_id: "A.1".to_string(),
                block_id: None,
                body: "why?".to_string(),
                structural: None,
                edit: None,
                created_at: 1,
                status: CommentStatus::Draft,
                resolution: None,
                selection: None,
                reopen_note: None,
                reopen_history: Vec::new(),
                actionable: false,
                author: None,
                agent_state: None,
                reviewer: None,
                external_created_at: None,
                share_request_id: None,
                attachments: Vec::new(),
            },
        )
        .unwrap();
        db.set_comment_fork("s-1", "c-1", "fork-sid", "claude-code").unwrap();
        describe_fork_error(&db, ThreadTarget::PlanComment, "s-1", "c-1", "error_during_execution");
        assert!(
            db.get_comment_fork("s-1", "c-1").is_some(),
            "a transient error must keep the session"
        );
        describe_fork_error(
            &db,
            ThreadTarget::PlanComment,
            "s-1",
            "c-1",
            "prompt is too long: 1200000 tokens",
        );
        assert!(db.get_comment_fork("s-1", "c-1").is_none());

        // --- review annotation ---
        db.insert_review_annotation(&ReviewAnnotation {
            id: "rc-1".to_string(),
            review_id: "rev-1".to_string(),
            round: 1,
            file_path: "src/main.rs".to_string(),
            side: "new".to_string(),
            start_line: 1,
            end_line: 1,
            kind: "comment".to_string(),
            body: "why?".to_string(),
            suggestion_replacement: None,
            quoted_text: "let x = 1;".to_string(),
            status: "draft".to_string(),
            resolution: None,
            created_at: 1,
            scope: "line".to_string(),
            label: None,
            blocking: None,
            source: "user".to_string(),
        })
        .unwrap();
        db.set_review_annotation_fork_session("rev-1", "rc-1", "fork-sid").unwrap();
        describe_fork_error(
            &db,
            ThreadTarget::ReviewAnnotation,
            "rev-1",
            "rc-1",
            "maximum context length exceeded",
        );
        assert!(db.get_review_annotation_fork_session("rev-1", "rc-1").is_none());

        // --- review question (the clear helper this fix had to add) ---
        db.insert_review_question(&ReviewQuestion {
            id: "rq-1".to_string(),
            review_id: "rev-1".to_string(),
            file_path: "src/main.rs".to_string(),
            side: "new".to_string(),
            start_line: 1,
            end_line: 1,
            quoted_text: "let x = 1;".to_string(),
            created_at: 1,
        })
        .unwrap();
        db.set_review_question_fork_session("rev-1", "rq-1", "fork-sid").unwrap();
        describe_fork_error(
            &db,
            ThreadTarget::ReviewQuestion,
            "rev-1",
            "rq-1",
            "error_during_execution",
        );
        assert!(
            db.get_review_question_fork_session("rev-1", "rq-1").is_some(),
            "a transient error must keep the session"
        );
        describe_fork_error(
            &db,
            ThreadTarget::ReviewQuestion,
            "rev-1",
            "rq-1",
            "the prompt is too long",
        );
        assert!(db.get_review_question_fork_session("rev-1", "rq-1").is_none());

        // --- draft comment (the other clear helper this fix had to add) ---
        db.insert_draft_comment(&DraftComment {
            id: "dc-1".to_string(),
            draft_id: "d-1".to_string(),
            block_id: None,
            sel_char_start: None,
            sel_char_end: None,
            sel_quoted_text: None,
            body: "tighten this".to_string(),
            author: None,
            created_at: 1,
            fork_session_id: None,
        })
        .unwrap();
        db.set_draft_comment_fork_session("dc-1", "fork-sid").unwrap();
        describe_fork_error(
            &db,
            ThreadTarget::DraftComment,
            "d-1",
            "dc-1",
            "error_during_execution",
        );
        assert!(
            db.get_draft_comment_fork_session("dc-1").is_some(),
            "a transient error must keep the session"
        );
        describe_fork_error(
            &db,
            ThreadTarget::DraftComment,
            "d-1",
            "dc-1",
            "input exceeds the context window",
        );
        assert!(db.get_draft_comment_fork_session("dc-1").is_none());
    }

    /// The auto-retry's whole decision, in one place. The `streamed` guard is
    /// the load-bearing one: retrying after text is on screen would make the
    /// answer rewrite itself.
    #[test]
    fn a_transient_failure_retries_once_and_only_with_nothing_on_screen() {
        // Transient, nothing streamed → retry.
        assert!(should_retry(1, false, Some("error_during_execution")));
        assert!(should_retry(1, false, Some("model overloaded, please retry")));
        // …but only once.
        assert!(!should_retry(2, false, Some("error_during_execution")));
        // Partial text already on screen → never.
        assert!(!should_retry(1, true, Some("error_during_execution")));
        // Not transient → never. An overflow would fail identically on a
        // resume, and a hard failure is not a blip.
        assert!(!should_retry(1, false, Some("prompt is too long")));
        assert!(!should_retry(1, false, Some("claude exited abnormally: boom")));
        // No error at all → nothing to retry.
        assert!(!should_retry(1, false, None));
    }

    /// Bounded on both axes: a long thread carries its most recent turns, and
    /// one enormous turn cannot crowd out the rest.
    #[test]
    fn continuity_is_bounded_by_turns_and_by_size() {
        let mut history: Vec<ThreadMessage> = (0..20)
            .map(|i| thread_msg("user", &format!("turn{i}"), "complete"))
            .collect();
        history.push(thread_msg("assistant", &"x".repeat(5_000), "complete"));
        let block = continuity_block(&history).expect("history");
        assert!(block.contains("turn19"), "the newest turns are the ones kept");
        assert!(!block.contains("turn0:"), "the oldest turns are dropped");
        assert!(block.contains('…'), "an oversized turn is truncated, not dropped");
        assert!(block.len() < 8_000, "the block stays bounded: {}", block.len());
    }
}
