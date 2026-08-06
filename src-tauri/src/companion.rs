// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The **Companion**: one global discussion agent that follows the user across
//! EVERY surface of the app — plan reviews, the Prompt Drafter, the embedded
//! browser, missions, code review. Where a linked discussion (`linked.rs`)
//! spans browser *tabs*, the Companion spans *surfaces*; it is the app-wide
//! spanning conversation.
//!
//! Mirrors linked.rs structurally (keyed registry, fresh process per turn via
//! `bridge_args`, DB-persisted resumable session, `companion-*` events), with
//! two load-bearing differences:
//!
//! 1. **The frontend passes NOTHING about location.** `companion_send` reads
//!    the mirrored `ActiveSurface` cell itself, so every turn is grounded on
//!    where the user actually is.
//! 2. **Passive awareness is the context journal, not a ticking agent.** The
//!    backend journals meaningful activity as it happens (surface switches,
//!    revisions, navs, pins, verdicts, agent turns); each Companion turn is
//!    prefixed with the delta since its last turn ("while you were away") —
//!    identical warmth to a background watcher at zero background token cost.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdout};

use crate::browse::{is_context_overflow, is_transient};
use crate::claude_proc::{
    bridge_args, classify_line, mission_context_block, resolve_claude_bin,
    StreamLine,
};
use crate::db::{Database, JournalRow};
use crate::state::{now_millis, Companion, CompanionMessage};
use crate::SurfaceInfo;

struct CompanionProc {
    child: Child,
}

type CompanionRegistry = Arc<Mutex<HashMap<String, CompanionProc>>>;

/// Registry of running companion turns, keyed by `companion_id`. Cloned into
/// managed Tauri state; the mutex is only held for tiny critical sections,
/// never across `.await`.
#[derive(Clone)]
pub struct CompanionState {
    procs: CompanionRegistry,
    db: Arc<Database>,
    claude_bin: Arc<OnceLock<String>>,
}

impl CompanionState {
    pub fn new(db: Arc<Database>) -> Self {
        Self {
            procs: Arc::new(Mutex::new(HashMap::new())),
            db,
            claude_bin: Arc::new(OnceLock::new()),
        }
    }

    async fn claude_bin(&self) -> Result<String, String> {
        let cell = self.claude_bin.clone();
        tokio::task::spawn_blocking(move || cell.get_or_init(resolve_claude_bin).clone())
            .await
            .map_err(|e| format!("failed to resolve the `claude` CLI: {e}"))
    }

    /// Kill every running companion turn. Backs app teardown.
    pub fn kill_all(&self) {
        let drained: Vec<CompanionProc> = {
            let mut guard = self.procs.lock().unwrap();
            guard.drain().map(|(_, p)| p).collect()
        };
        for mut proc in drained {
            let _ = proc.child.start_kill();
        }
    }
}

// --- Event payloads ----------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompanionDelta {
    companion_id: String,
    text: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompanionDone {
    companion_id: String,
    message_id: String,
    body: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompanionError {
    companion_id: String,
    error: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompanionCancelled {
    companion_id: String,
}

// --- Surface + journal rendering ----------------------------------------------

/// One-line "where the user is" descriptor from the mirrored ActiveSurface —
/// the Companion's analog of linked's `TabContext::describe()`.
pub fn describe_surface(s: &SurfaceInfo) -> String {
    let label = s.label.as_deref().unwrap_or("").trim();
    let detail = s.detail.as_deref().unwrap_or("").trim();
    let named = |what: &str| -> String {
        match (label.is_empty(), detail.is_empty()) {
            (false, false) => format!("{what} — {label} ({detail})"),
            (false, true) => format!("{what} — {label}"),
            (true, false) => format!("{what} ({detail})"),
            (true, true) => what.to_string(),
        }
    };
    match s.kind.as_str() {
        "plan" => named("the plan review"),
        "drafter" => named("the Prompt Drafter"),
        "browser" => named("the embedded browser"),
        "review" => named("the code review"),
        "terminal" => named("the terminal"),
        _ => "the welcome screen".to_string(),
    }
}

/// Render the journal delta as a compact "While you were away" block:
/// one line per event, consecutive `nav` rows grouped ("browsed N pages,
/// ending at …"), byte-bounded (oldest lines dropped first — the tail is the
/// most relevant context). Empty string when there's nothing new.
pub fn render_journal_delta(rows: &[JournalRow], max_bytes: usize) -> String {
    if rows.is_empty() {
        return String::new();
    }
    let mut lines: Vec<String> = Vec::new();
    let mut i = 0usize;
    while i < rows.len() {
        let r = &rows[i];
        if r.kind == "nav" {
            // Group a run of navigations into one line.
            let mut j = i;
            while j + 1 < rows.len() && rows[j + 1].kind == "nav" {
                j += 1;
            }
            let last = &rows[j];
            let count = j - i + 1;
            let dest = last
                .label
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .or(last.detail.as_deref())
                .unwrap_or("a page");
            if count == 1 {
                lines.push(format!("- browsed to {dest}"));
            } else {
                lines.push(format!("- browsed {count} pages, ending at {dest}"));
            }
            i = j + 1;
            continue;
        }
        let label = r.label.as_deref().filter(|s| !s.trim().is_empty());
        let detail = r.detail.as_deref().filter(|s| !s.trim().is_empty());
        let surface = r.surface_kind.as_deref().unwrap_or("");
        let line = match r.kind.as_str() {
            "surface_switch" => match label {
                Some(l) => format!("- moved to the {surface} — {l}"),
                None => format!("- moved to the {surface}"),
            },
            "revision" => format!(
                "- a plan revision arrived{}{}",
                label.map(|l| format!(" — {l}")).unwrap_or_default(),
                detail.map(|d| format!(" ({d})")).unwrap_or_default(),
            ),
            "approval" => "- a plan was approved".to_string(),
            "review_start" => format!(
                "- a code review opened{}{}",
                label.map(|l| format!(" — {l}")).unwrap_or_default(),
                detail.map(|d| format!(" ({d})")).unwrap_or_default(),
            ),
            "review_verdict" => format!(
                "- a review verdict landed{}",
                label.map(|l| format!(" ({l})")).unwrap_or_default(),
            ),
            "mission_pin" => format!(
                "- pinned a finding{}",
                label.map(|l| format!(" — {l}")).unwrap_or_default(),
            ),
            "mission_active" => format!(
                "- a mission became active{}",
                label.map(|l| format!(" — {l}")).unwrap_or_default(),
            ),
            "drafter_launch" => "- launched a drafted prompt into a plan session".to_string(),
            "agent_turn" => format!("- the {surface} agent completed a turn"),
            other => format!("- {other}"),
        };
        lines.push(line);
        i += 1;
    }
    // Byte-bound, keeping the tail (most recent activity wins).
    let mut kept: Vec<&String> = Vec::new();
    let mut total = 0usize;
    for line in lines.iter().rev() {
        total += line.len() + 1;
        if total > max_bytes && !kept.is_empty() {
            break;
        }
        kept.push(line);
    }
    let dropped = lines.len() - kept.len();
    let mut out = String::from("WHILE YOU WERE AWAY — what the user did since your last turn:\n");
    if dropped > 0 {
        out.push_str(&format!("- (…{dropped} earlier events elided)\n"));
    }
    for line in kept.iter().rev() {
        out.push_str(line);
        out.push('\n');
    }
    out
}

// --- Prompt builders -----------------------------------------------------------

/// The cross-surface map + consult + staged-write contract. `pub(crate)`
/// because the voice agent embeds this verbatim too (the Companion's scope
/// folded into voice — one contract, two mouths, no drift).
pub(crate) fn routes_block() -> &'static str {
    "YOUR MAP AND GLANCE ROUTES — all local, already permitted (no approval \
     needed; put the URL immediately after `-s`):\n\
     - Every agent and thread across the app (who exists, what's busy, what's \
     consultable):\n  \
     curl -s http://127.0.0.1:7676/v1/global/agents\n\
     - Where the user is right now:\n  \
     curl -s http://127.0.0.1:7676/v1/surface/active\n\
     - Activity since a journal seq (your awareness feed, mid-conversation):\n  \
     curl -s 'http://127.0.0.1:7676/v1/journal/recent?since_seq=<n>'\n\
     - Any surface's discussion thread (browse / linked / mission / drafter / \
     companion / a plan session's comment threads):\n  \
     curl -s 'http://127.0.0.1:7676/v1/context/threads/<kind>/<id>'\n\
     - The session tree around a node (its parent + children with recency):\n  \
     curl -s 'http://127.0.0.1:7676/v1/context/tree/<kind>/<id>'\n\
     - A plan session's full history (revisions, comments, decisions):\n  \
     curl -s http://127.0.0.1:7676/v1/context/sessions/<id>/history\n\
     - The browser: /v1/browser/tabs, /v1/browser/snapshot?tab=<n>, \
     /v1/browser/thread?tab=<n>\n\
     - The user's organized memory: /v1/memory/tree, /v1/memory/node/<id>, \
     /v1/memory/prompts?node=<id>\n\
     - Filtered prompt history: /v1/context/prompts?thread_kind=&thread_id=&\
     parent_session=&session=&q=\n\n\
     CHECK IN WITH A COLLEAGUE. Every surface has its own agent holding its \
     full context — don't re-derive what a colleague already knows. Delegate a \
     synthesis and fold back only the digest (this is a write route — the two \
     `--variable`/`--expand-header` flags shown import the bearer token \
     straight from your environment; never write `$REDLINE_DAEMON_TOKEN` into \
     the command yourself, and note this needs curl >= 8.3):\n  \
     curl -s http://127.0.0.1:7676/v1/global/consult \
     --variable %REDLINE_DAEMON_TOKEN= \
     --expand-header \"Authorization: Bearer {{REDLINE_DAEMON_TOKEN}}\" -X POST \
     -H 'Content-Type: application/json' \
     -d '{\"surface\":\"<browse|plan|mission|linked|drafter>\",\"id\":\"<its id \
     — for browse, the tab number>\",\"question\":\"<what you need synthesized>\"}'\n\
     The response is {\"digest\":\"...\",\"surface\":\"...\",\"label\":\"...\"}. \
     A GLANCE (a fact, a title) you do yourself via the read routes above; a \
     SYNTHESIS you delegate. \"busy\" means retry-or-glance, not failure. Voice \
     sessions have no consult — read /v1/context/threads/voice/<id> instead.\n\n\
     WRITES — ONLY AT THE USER'S DIRECTION. When the user explicitly asks you \
     to capture something, you can create STAGED, REVIEWABLE artifacts — each \
     lands in the UI for their review, never as a silent change. If the target \
     is ambiguous (which plan, which draft), confirm in one line first. Every \
     write carries the same two flags shown, which import the bearer token \
     from your environment.\n\
     - An action item / feedback comment on a plan (fetch the plan first for a \
     blockId — anchor section-level feedback to a heading block):\n  \
     curl -s http://127.0.0.1:7676/v1/sessions/<session_id>/plan\n  \
     curl -s http://127.0.0.1:7676/v1/sessions/<session_id>/comments \
     --variable %REDLINE_DAEMON_TOKEN= \
     --expand-header \"Authorization: Bearer {{REDLINE_DAEMON_TOKEN}}\" -X POST \
     -H 'Content-Type: application/json' \
     -d '{\"blockId\":\"<the blockId>\",\"body\":\"<the item, in the user's \
     words>\",\"agentId\":\"companion\"}'\n\
     - A tracked suggestion in a Prompt Drafter document (read the doc first; \
     ops append | replace_block | insert_after | delete_block anchor on the \
     doc's current block ids and `original` bodies — a 409 means stale: \
     re-read and retry, exactly the drafter skill's contract):\n  \
     curl -s http://127.0.0.1:7676/v1/drafter/<draft_id>/doc\n  \
     curl -s http://127.0.0.1:7676/v1/drafter/<draft_id>/suggestions \
     --variable %REDLINE_DAEMON_TOKEN= \
     --expand-header \"Authorization: Bearer {{REDLINE_DAEMON_TOKEN}}\" -X POST \
     -H 'Content-Type: application/json' \
     -d '{\"op\":\"<op>\",\"block_id\":\"<anchor>\",\"original\":\"<current block \
     markdown, for replace/delete>\",\"markdown\":\"<new content>\",\
     \"agent_id\":\"companion\"}'\n\
     - A code-review annotation (a note on the open review's diff):\n  \
     curl -s 'http://127.0.0.1:7676/v1/reviews/annotations?repo=<repo_path>' \
     --variable %REDLINE_DAEMON_TOKEN= \
     --expand-header \"Authorization: Bearer {{REDLINE_DAEMON_TOKEN}}\" -X POST \
     -H 'Content-Type: application/json' \
     -d '{\"file_path\":\"<path>\",\"side\":\"new\",\"quoted\":\"<the exact \
     line(s)>\",\"body\":\"<the note>\",\"source\":\"companion\"}'\n\
     - A memory proposal (stage a filing into the user's organized memory — \
     staging only, they accept or reject it in the inspector):\n  \
     curl -s http://127.0.0.1:7676/v1/memory/proposals \
     --variable %REDLINE_DAEMON_TOKEN= \
     --expand-header \"Authorization: Bearer {{REDLINE_DAEMON_TOKEN}}\" -X POST \
     -H 'Content-Type: application/json' \
     -d '{\"proposals\":[{\"op\":\"file\",\"prompt_id\":<id>,\"node\":\"<class \
     path>\",\"reason\":\"<why>\"}]}'\n\
     NEVER: /v1/browser/* writes (the browser is the user's hands), plan \
     suggestions (/v1/sessions/<id>/suggestions — plan revision belongs to \
     that session's own claude), file edits, producing a plan, or \
     ExitPlanMode.\n"
}

/// The per-turn "where the user is" line, with the surface's id appended —
/// the write routes key on it (session id, draft id), so handing it over
/// saves the agent a curl round-trip through /v1/surface/active.
fn surface_line(surface: &SurfaceInfo) -> String {
    let mut line = describe_surface(surface);
    if let Some(id) = surface.id.as_deref().filter(|s| !s.trim().is_empty()) {
        line.push_str(&format!(" [surface id: {id}]"));
    }
    line
}

/// First turn: the spanning-app role, where the user is, the journal delta,
/// the map + consult contract, mission inheritance, and the user's message.
pub fn build_first_turn_prompt(
    surface: &SurfaceInfo,
    journal_delta: &str,
    user_text: &str,
    mission: Option<(&str, &str)>,
) -> String {
    let mut p = String::from(
        "You are the user's COMPANION in Redline: ONE continuous discussion that \
         follows them across every surface of the app — plan reviews, the Prompt \
         Drafter, the embedded browser, research missions, code reviews. You are \
         not bound to any surface and you carry no goal of your own; you are the \
         spanning conversation and the colleague who always knows where they've \
         been. Each turn tells you where they are now; weave continuity across \
         everything you've seen, referring back to earlier surfaces by name.\n\n\
         Follow your `companion` skill if you have it.\n\n",
    );
    p.push_str(&mission_context_block(mission));
    p.push_str(&format!(
        "The user is currently on {}.\n\n",
        surface_line(surface)
    ));
    if !journal_delta.trim().is_empty() {
        p.push_str(journal_delta.trim());
        p.push_str(
            "\n\nAbsorb that silently — it is ground truth of what happened, not \
             something to recite back unless asked.\n\n",
        );
    }
    p.push_str(routes_block());
    p.push_str(
        "\nFORMATTING — your replies render through Redline's markdown pipeline \
         (tables, strict-mode mermaid, fenced code, callouts). Never raw HTML. \
         You observe by default and WRITE only at the user's explicit \
         direction, through the write routes above — everything you write is a \
         staged, reviewable artifact, never a silent change; confirm an \
         ambiguous target in one line first. Never edit files, never produce a \
         plan, never call ExitPlanMode.\n\n\
         The user says:\n",
    );
    for line in user_text.lines() {
        p.push_str("> ");
        p.push_str(line);
        p.push('\n');
    }
    p
}

/// Follow-up: re-ground on the current surface + the journal delta since the
/// last turn. The resumed session already carries the role and the routes.
pub fn build_followup_prompt(
    surface: &SurfaceInfo,
    journal_delta: &str,
    user_text: &str,
) -> String {
    let mut p = format!("The user is now on {}.\n\n", surface_line(surface));
    if !journal_delta.trim().is_empty() {
        p.push_str(journal_delta.trim());
        p.push_str("\n\n");
    }
    p.push_str("The user says:\n");
    for line in user_text.lines() {
        p.push_str("> ");
        p.push_str(line);
        p.push('\n');
    }
    p
}

// --- CRUD commands -------------------------------------------------------------

#[tauri::command]
pub fn companion_create(
    companion: tauri::State<'_, CompanionState>,
    title: Option<String>,
) -> Result<Companion, String> {
    let now = now_millis();
    let title = title
        .map(|t| t.trim().chars().take(80).collect::<String>())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "Companion".to_string());
    let c = Companion {
        companion_id: uuid::Uuid::new_v4().to_string(),
        title,
        status: "active".to_string(),
        created_at: now,
        updated_at: now,
    };
    companion
        .db
        .insert_companion(&c)
        .map_err(|e| format!("failed to create companion: {e}"))?;
    Ok(c)
}

#[tauri::command]
pub fn companion_list(
    companion: tauri::State<'_, CompanionState>,
) -> Result<Vec<Companion>, String> {
    companion
        .db
        .list_companions()
        .map_err(|e| format!("failed to list companions: {e}"))
}

#[tauri::command]
pub fn companion_get_thread(
    companion: tauri::State<'_, CompanionState>,
    companion_id: String,
) -> Result<Vec<CompanionMessage>, String> {
    companion
        .db
        .load_companion_thread(&companion_id)
        .map_err(|e| format!("failed to load thread: {e}"))
}

#[tauri::command]
pub fn companion_delete(
    companion: tauri::State<'_, CompanionState>,
    companion_id: String,
) -> Result<(), String> {
    let proc = { companion.procs.lock().unwrap().remove(&companion_id) };
    if let Some(mut proc) = proc {
        let _ = proc.child.start_kill();
    }
    companion
        .db
        .delete_companion(&companion_id)
        .map_err(|e| format!("failed to delete companion: {e}"))
}

// --- Chat ------------------------------------------------------------------

/// How many journal bytes a turn preamble may spend. Breadcrumbs, not content.
const JOURNAL_DELTA_MAX_BYTES: usize = 4_000;
const JOURNAL_DELTA_MAX_ROWS: i64 = 300;

/// Send a turn. The frontend passes only the text — the backend grounds the
/// turn on the mirrored ActiveSurface and the journal delta itself, then
/// advances the companion's journal high-water mark.
#[tauri::command]
pub async fn companion_send(
    companion: tauri::State<'_, CompanionState>,
    active_surface: tauri::State<'_, crate::ActiveSurface>,
    active_mission: tauri::State<'_, crate::ActiveMission>,
    app: AppHandle,
    companion_id: String,
    text: String,
    cwd: Option<String>,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("empty message".to_string());
    }
    {
        let guard = companion.procs.lock().unwrap();
        if guard.contains_key(&companion_id) {
            return Err("the companion is still replying".to_string());
        }
    }

    let prior_session = companion.db.get_companion_session(&companion_id);
    let surface = active_surface.get();

    // The awareness feed: journal rows since this companion's last turn.
    let since = companion.db.get_companion_journal_seq(&companion_id);
    let journal_rows = companion
        .db
        .list_journal_since(since, JOURNAL_DELTA_MAX_ROWS)
        .unwrap_or_default();
    let journal_delta = render_journal_delta(&journal_rows, JOURNAL_DELTA_MAX_BYTES);
    let head = journal_rows.last().map(|r| r.id);

    // Persist the user turn WITH its surface tag.
    let user_msg = CompanionMessage {
        id: uuid::Uuid::new_v4().to_string(),
        companion_id: companion_id.clone(),
        role: "user".to_string(),
        body: text.clone(),
        status: "complete".to_string(),
        surface_kind: Some(surface.kind.clone()),
        surface_id: surface.id.clone(),
        surface_label: surface.label.clone(),
        created_at: now_millis(),
    };
    companion
        .db
        .insert_companion_message(&user_msg)
        .map_err(|e| format!("failed to persist message: {e}"))?;

    let mission = active_mission.active_goal();
    let prompt = match &prior_session {
        None => build_first_turn_prompt(
            &surface,
            &journal_delta,
            &text,
            mission.as_ref().map(|(t, g)| (t.as_str(), g.as_str())),
        ),
        Some(_) => build_followup_prompt(&surface, &journal_delta, &text),
    };

    // Polis ledger: the companion is always a session-tree ROOT (it spans
    // surfaces by design); first turns are captured with thread provenance.
    if prior_session.is_none() {
        crate::ledger::record_agent_prompt(
            &companion.db,
            crate::ledger::PromptSource::RustFirstTurn,
            "companion",
            &prompt,
            None,
            None,
            None,
            Some(crate::ledger::ThreadRef {
                thread_kind: "companion",
                thread_id: companion_id.clone(),
                parent_session_id: None,
            }),
            crate::seat::model_for("companion"),
        );
    } else {
        crate::ledger::register_agent_prompt(&crate::ledger::body_hash(&prompt));
    }

    // The delta is now folded into the conversation; advance the mark.
    if let Some(h) = head {
        let _ = companion.db.set_companion_journal_seq(&companion_id, h);
    }

    let args = bridge_args("companion", prompt, prior_session.as_deref());
    let cwd = cwd
        .filter(|c| !c.trim().is_empty())
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| "/".to_string());

    let claude_bin = companion.claude_bin().await?;
    let mut cmd = crate::claude_proc::claude_command_for_seat("companion", &claude_bin);
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
        companion
            .procs
            .lock()
            .unwrap()
            .insert(companion_id.clone(), CompanionProc { child });
    }
    tauri::async_runtime::spawn(read_companion(
        app,
        companion.db.clone(),
        companion.procs.clone(),
        companion_id,
        surface,
        stdout,
        stderr,
    ));
    Ok(())
}

#[tauri::command]
pub fn companion_cancel(
    companion: tauri::State<'_, CompanionState>,
    companion_id: String,
) -> Result<(), String> {
    let proc = { companion.procs.lock().unwrap().remove(&companion_id) };
    if let Some(mut proc) = proc {
        let _ = proc.child.start_kill();
    }
    Ok(())
}

#[tauri::command]
pub fn companion_kill_all(companion: tauri::State<'_, CompanionState>) {
    companion.kill_all();
}

// --- Reader ---------------------------------------------------------------

async fn read_companion(
    app: AppHandle,
    db: Arc<Database>,
    procs: CompanionRegistry,
    companion_id: String,
    surface: SurfaceInfo,
    stdout: ChildStdout,
    stderr: ChildStderr,
) {
    let mut lines = BufReader::new(stdout).lines();
    let mut stderr_lines = BufReader::new(stderr).lines();
    let mut session: Option<String> = None;
    let mut final_text: Option<String> = None;
    let mut errored: Option<String> = None;
    let mut saw_json = false;

    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        saw_json = true;
        match classify_line(&v) {
            StreamLine::Init(sid) => session = Some(sid),
            StreamLine::Delta(text) => {
                let _ = app.emit(
                    "companion-delta",
                    CompanionDelta {
                        companion_id: companion_id.clone(),
                        text,
                    },
                );
            }
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
    let mut stderr_text = String::new();
    while let Ok(Some(line)) = stderr_lines.next_line().await {
        stderr_text.push_str(&line);
        stderr_text.push('\n');
    }

    let proc = { procs.lock().unwrap().remove(&companion_id) };
    let cancelled = proc.is_none() && final_text.is_none();
    let exit_ok = match proc {
        Some(mut p) => p.child.wait().await.map(|s| s.success()).unwrap_or(false),
        None => false,
    };

    if cancelled {
        let _ = app.emit("companion-cancelled", CompanionCancelled { companion_id });
        return;
    }
    if let Some(err) = errored {
        let why = describe_turn_error(&db, &companion_id, &err);
        finish_error(&app, &db, &companion_id, &surface, &why);
        return;
    }
    if let Some(text) = final_text {
        if text.trim().is_empty() {
            finish_error(
                &app,
                &db,
                &companion_id,
                &surface,
                "claude produced an empty reply",
            );
            return;
        }
        if let Some(sid) = &session {
            if let Err(e) = db.set_companion_session(&companion_id, sid) {
                tracing::warn!(error = %e, "failed to persist companion session id");
            }
        }
        let msg = CompanionMessage {
            id: uuid::Uuid::new_v4().to_string(),
            companion_id: companion_id.clone(),
            role: "assistant".to_string(),
            body: text.clone(),
            status: "complete".to_string(),
            surface_kind: Some(surface.kind.clone()),
            surface_id: surface.id.clone(),
            surface_label: surface.label.clone(),
            created_at: now_millis(),
        };
        if let Err(e) = db.insert_companion_message(&msg) {
            tracing::warn!(error = %e, "failed to persist assistant message");
        }
        // Deliberately NO agent_turn journal append here — the Companion's own
        // turns must not echo back into its next "while you were away" delta.
        let _ = app.emit(
            "companion-done",
            CompanionDone {
                companion_id,
                message_id: msg.id,
                body: text,
            },
        );
        return;
    }

    let why = if !exit_ok && !stderr_text.trim().is_empty() {
        let detail: String = stderr_text.trim().chars().take(500).collect();
        format!("claude exited abnormally: {detail}")
    } else if !saw_json {
        "claude produced no parseable output".to_string()
    } else {
        "claude ended without producing a reply".to_string()
    };
    finish_error(&app, &db, &companion_id, &surface, &why);
}

/// Same recovery policy as browse/draft-chat: explicit context overflow resets
/// the resumable session; transient API errors keep it and ask for a retry.
fn describe_turn_error(db: &Database, companion_id: &str, error: &str) -> String {
    if is_context_overflow(error) {
        let _ = db.clear_companion_session(companion_id);
        return "This conversation outgrew the model's context window, so the turn \
                failed. I've reset its context — send your message again and I'll \
                pick up fresh from here (the replies above are kept)."
            .to_string();
    }
    if is_transient(error) {
        return "The model hit a momentary error on that turn. The conversation is \
                fine — send your message again in a moment."
            .to_string();
    }
    error.to_string()
}

fn finish_error(
    app: &AppHandle,
    db: &Database,
    companion_id: &str,
    surface: &SurfaceInfo,
    why: &str,
) {
    let msg = CompanionMessage {
        id: uuid::Uuid::new_v4().to_string(),
        companion_id: companion_id.to_string(),
        role: "assistant".to_string(),
        body: why.to_string(),
        status: "error".to_string(),
        surface_kind: Some(surface.kind.clone()),
        surface_id: surface.id.clone(),
        surface_label: surface.label.clone(),
        created_at: now_millis(),
    };
    if let Err(e) = db.insert_companion_message(&msg) {
        tracing::warn!(error = %e, "failed to persist error message");
    }
    let _ = app.emit(
        "companion-error",
        CompanionError {
            companion_id: companion_id.to_string(),
            error: why.to_string(),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn surface(kind: &str, label: Option<&str>, detail: Option<&str>) -> SurfaceInfo {
        SurfaceInfo {
            kind: kind.to_string(),
            id: Some("x-1".to_string()),
            label: label.map(str::to_string),
            detail: detail.map(str::to_string),
            project_path: None,
            updated_at: 0,
        }
    }

    fn row(id: i64, kind: &str, label: Option<&str>, detail: Option<&str>) -> JournalRow {
        JournalRow {
            id,
            ts: id,
            kind: kind.to_string(),
            surface_kind: Some("browser".to_string()),
            surface_id: None,
            label: label.map(str::to_string),
            detail: detail.map(str::to_string),
        }
    }

    #[test]
    fn describe_surface_names_the_surface_tolerantly() {
        assert_eq!(
            describe_surface(&surface("plan", Some("My plan"), None)),
            "the plan review — My plan"
        );
        assert_eq!(
            describe_surface(&surface("browser", Some("Docs"), Some("https://x"))),
            "the embedded browser — Docs (https://x)"
        );
        assert_eq!(describe_surface(&surface("welcome", None, None)), "the welcome screen");
    }

    #[test]
    fn journal_delta_groups_navs_and_bounds_bytes() {
        let rows = vec![
            row(1, "surface_switch", Some("My plan"), None),
            row(2, "nav", Some("Page A"), Some("https://a")),
            row(3, "nav", Some("Page B"), Some("https://b")),
            row(4, "nav", Some("Page C"), Some("https://c")),
            row(5, "revision", Some("My plan"), Some("v3")),
        ];
        let d = render_journal_delta(&rows, 4000);
        assert!(d.contains("WHILE YOU WERE AWAY"));
        assert!(d.contains("browsed 3 pages, ending at Page C"));
        assert!(!d.contains("Page A"), "grouped navs collapse to one line");
        assert!(d.contains("a plan revision arrived — My plan (v3)"));

        // Byte bound keeps the TAIL and says what was elided.
        let many: Vec<JournalRow> = (0..100)
            .map(|i| row(i, "surface_switch", Some(&format!("surface {i}")), None))
            .collect();
        let bounded = render_journal_delta(&many, 300);
        assert!(bounded.len() < 600);
        assert!(bounded.contains("surface 99"), "the newest event survives");
        assert!(bounded.contains("elided"));
        // Empty delta renders nothing at all.
        assert_eq!(render_journal_delta(&[], 4000), "");
    }

    #[test]
    fn first_turn_embeds_role_surface_journal_and_consult_contract() {
        let s = surface("plan", Some("Companion plan"), None);
        let p = build_first_turn_prompt(
            &s,
            "WHILE YOU WERE AWAY — what the user did since your last turn:\n- browsed to X\n",
            "what did I miss?",
            Some(("Research", "Find the best DB")),
        );
        assert!(p.contains("COMPANION"));
        assert!(p.contains("the plan review — Companion plan"));
        // The surface id rides the per-turn line (the write routes key on it).
        assert!(p.contains("[surface id: x-1]"));
        assert!(p.contains("WHILE YOU WERE AWAY"));
        assert!(p.contains("/v1/global/agents"));
        assert!(p.contains("/v1/global/consult"));
        assert!(p.contains("/v1/context/threads/"));
        assert!(p.contains("/v1/context/tree/"));
        assert!(p.contains("/v1/journal/recent"));
        assert!(p.contains("`companion` skill"));
        // Mission inheritance rides the shared block.
        assert!(p.contains("Find the best DB"));
        assert!(p.contains("what did I miss?"));

        // The write contract: user-directed only, staged/reviewable, all four
        // recipes present with the auth header, and the exclusions explicit.
        assert!(p.contains("WRITES — ONLY AT THE USER'S DIRECTION"));
        assert!(p.contains("curl -s http://127.0.0.1:7676/v1/sessions/<session_id>/plan"));
        assert!(p.contains("curl -s http://127.0.0.1:7676/v1/sessions/<session_id>/comments"));
        assert!(p.contains("\"agentId\":\"companion\""));
        assert!(p.contains("curl -s http://127.0.0.1:7676/v1/drafter/<draft_id>/doc"));
        assert!(p.contains("curl -s http://127.0.0.1:7676/v1/drafter/<draft_id>/suggestions"));
        assert!(p.contains("curl -s 'http://127.0.0.1:7676/v1/reviews/annotations?repo=<repo_path>'"));
        assert!(p.contains("\"source\":\"companion\""));
        assert!(p.contains("curl -s http://127.0.0.1:7676/v1/memory/proposals"));
        // The auth flags must survive verbatim as curl's own variable import:
        // shell expansion (`$REDLINE_DAEMON_TOKEN`) never reaches the daemon
        // because the agent bash sandbox rejects the command outright.
        assert!(p.contains(
            "--variable %REDLINE_DAEMON_TOKEN= \
             --expand-header \"Authorization: Bearer {{REDLINE_DAEMON_TOKEN}}\""
        ));
        assert!(!p.contains("Bearer $REDLINE_DAEMON_TOKEN"));
        assert!(p.contains("/v1/sessions/<id>/suggestions"), "plan-suggestion exclusion");
        assert!(p.contains("NEVER: /v1/browser/*"));
        // The old blanket read-only line is gone in favor of the new contract.
        assert!(p.contains("WRITE only at the user's explicit"));
        assert!(p.contains("staged, reviewable artifact"));
    }

    #[test]
    fn followup_regrounds_on_surface_without_reembedding_the_role() {
        let s = surface("drafter", None, None);
        let p = build_followup_prompt(&s, "", "and now?");
        assert!(p.contains("the Prompt Drafter"));
        // The surface id rides every turn — follow-up writes need it too.
        assert!(p.contains("[surface id: x-1]"));
        assert!(!p.contains("COMPANION"), "role is not re-embedded");
        assert!(!p.contains("/v1/global/consult"), "routes are not re-embedded");
        assert!(p.ends_with("> and now?\n"));
    }
}
