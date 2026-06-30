// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The browser's "mission orchestrator": a headless `claude` session, one per
//! research **Mission**, that sits a tier *above* the per-tab browse agents
//! (`browse.rs`). The user states a goal once; the orchestrator treats every
//! open tab and its page-discussion as a thread to be pulled, bundling that
//! context — both the user's curated **pins** (`mission_findings`) and **ambient
//! reach** into any tab — toward the goal, and finally synthesizes a brief.
//!
//! Mirrors `browse.rs` (keyed registry of `tokio::process::Child`, stream-json
//! reader, `*-delta`/`*-done`/`*-error`/`*-cancelled` events, DB-persisted
//! terminal turns) but is keyed by `mission_id` and reads *across* tabs: it
//! reuses the existing `/v1/browser/*` daemon surface (tabs map, per-tab thread,
//! snapshot) plus two new read-only mission routes (`/v1/mission/active`,
//! `/v1/mission/findings`). The orchestrator's resumable session id lives on the
//! `missions` row, so re-opening a mission resumes its conversation.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdout};

use crate::claude_proc::{classify_line, claude_command, resolve_claude_bin, StreamLine};
use crate::db::Database;
use crate::state::{now_millis, Mission, MissionFinding, MissionMessage};

/// One in-flight orchestrator turn. The registry owns the whole `Child`;
/// `start_kill()` is a synchronous non-blocking SIGKILL.
struct MissionProc {
    child: Child,
}

type MissionRegistry = Arc<Mutex<HashMap<String, MissionProc>>>;

/// Registry of running orchestrator turns, keyed by `mission_id`. Cloned into
/// managed Tauri state. The `std::sync::Mutex` is only ever held for a tiny
/// `lock → mutate → drop` critical section, never across `.await`.
#[derive(Clone)]
pub struct MissionState {
    procs: MissionRegistry,
    db: Arc<Database>,
    /// Absolute path to the `claude` binary, resolved lazily on first use —
    /// same TCC reasoning as `browse::BrowseState`.
    claude_bin: Arc<OnceLock<String>>,
}

impl MissionState {
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

    /// A mission's curated pins, oldest first. Lets the daemon serve
    /// `/v1/mission/findings` without exposing the private `db` handle.
    pub fn load_findings(&self, mission_id: &str) -> rusqlite::Result<Vec<MissionFinding>> {
        self.db.list_findings(mission_id)
    }

    /// Kill every running orchestrator turn. Backs `mission_kill_all` and teardown.
    pub fn kill_all(&self) {
        let drained: Vec<MissionProc> = {
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
struct MissionDelta {
    mission_id: String,
    text: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MissionDone {
    mission_id: String,
    message_id: String,
    body: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MissionError {
    mission_id: String,
    error: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MissionCancelled {
    mission_id: String,
}

/// Render the current pins as a markdown list for the first-turn prompt. Each
/// pin shows the user's note (their taste signal), where it came from, and the
/// pinned text. Empty when nothing is pinned yet.
fn render_findings(findings: &[MissionFinding]) -> String {
    if findings.is_empty() {
        return String::new();
    }
    let mut s = String::from("The user has pinned these findings so far:\n\n");
    for (i, f) in findings.iter().enumerate() {
        s.push_str(&format!("{}. ", i + 1));
        if let Some(note) = f.note.as_deref().filter(|n| !n.trim().is_empty()) {
            s.push_str(&format!("**{}** — ", note.trim()));
        }
        match (f.source_title.as_deref(), f.source_url.as_deref()) {
            (Some(t), Some(u)) if !t.trim().is_empty() => {
                s.push_str(&format!("from “{}” ({})\n", t.trim(), u.trim()))
            }
            (_, Some(u)) if !u.trim().is_empty() => s.push_str(&format!("from {}\n", u.trim())),
            _ => s.push('\n'),
        }
        let snippet: String = f.body.trim().chars().take(600).collect();
        for line in snippet.lines() {
            s.push_str("   > ");
            s.push_str(line);
            s.push('\n');
        }
        s.push('\n');
    }
    s
}

/// The first turn's prompt: the orchestrator's role, the mission goal, the pins
/// so far, how to read across the user's tabs and re-fetch the latest pins via
/// the local curl endpoints, and the user's message. Follow-up turns send the
/// user's text verbatim — the resumed session carries this context and can
/// re-`curl` for a fresh view.
fn build_first_turn_prompt(
    title: &str,
    goal: &str,
    findings: &[MissionFinding],
    user_text: &str,
) -> String {
    let mut p = String::from(
        "You are the ORCHESTRATOR of a research mission in Redline's embedded \
         browser. The user is researching across many browser tabs, each with \
         its own page discussion. Your job is to hold the mission's goal, pull \
         context from every relevant tab and from the user's pinned findings, \
         and weave it toward that goal — comparisons, what works and what to \
         avoid, gaps, and finally a synthesis the user can act on.\n\n",
    );
    if !title.trim().is_empty() {
        p.push_str(&format!("Mission: {}\n", title.trim()));
    }
    p.push_str("The mission's goal, in the user's words:\n\n");
    for line in goal.lines() {
        p.push_str("> ");
        p.push_str(line);
        p.push('\n');
    }
    p.push('\n');

    let pins = render_findings(findings);
    if !pins.is_empty() {
        p.push_str(&pins);
        p.push('\n');
    }

    p.push_str(
        "You can see and read across the user's tabs by calling these local \
         endpoints with curl (already permitted — no approval needed). Put the \
         URL immediately after `-s`:\n\n\
         - The mission's goal/title/status (in case you need it again):\n  \
         curl -s http://127.0.0.1:7676/v1/mission/active\n\
         - The user's PINNED findings — re-read this each turn, the user pins \
         more as they browse:\n  \
         curl -s http://127.0.0.1:7676/v1/mission/findings\n\
         - List every open tab — your map of the user's research. Each tab has a \
         number `n` (its position in the tab strip, what the USER sees), plus \
         url, title, and which is active:\n  \
         curl -s http://127.0.0.1:7676/v1/browser/tabs\n\
         - Read what was already discussed on a tab (the cheap way to absorb a \
         thread without re-deriving it):\n  \
         curl -s 'http://127.0.0.1:7676/v1/browser/thread?tab=<n>'\n\
         - See a tab's live page (url, title, selection, text, headings, links) \
         without disturbing the user's focus:\n  \
         curl -s 'http://127.0.0.1:7676/v1/browser/snapshot?tab=<n>'\n\
         - Go look at something yourself: open a URL in a NEW tab (leaves the \
         user's tabs open):\n  \
         curl -s http://127.0.0.1:7676/v1/browser/open -X POST \
         -H 'Content-Type: application/json' -d '{\"url\":\"https://example.com\"}'\n\
         - Switch the user INTO a tab (use only when they want to BE there):\n  \
         curl -s 'http://127.0.0.1:7676/v1/browser/focus?tab=<n>' -X POST\n\n\
         Reading a tab by `?tab=<n>` (its number from /tabs) is like a colleague \
         glancing at a neighbour's screen — it does NOT move the user's current \
         tab. Tab numbers are positional and shift as tabs open/close, so \
         re-read /tabs for the current mapping each task rather than remembering \
         a number across turns. When you name a tab to the user, use its NUMBER \
         and title (e.g. \"tab 2 — example.com\"), never an internal id.\n\n\
         You also have WebSearch and WebFetch (already permitted): use WebSearch \
         to look something up and WebFetch to pull a specific URL — to verify a \
         claim or fill a gap — rather than driving the user's tabs to a search \
         engine.\n\n\
         Follow the `mission` skill for how to gather across tabs, weave the \
         pins, and format your reply (comparison tables, what-I-liked / \
         what-I-didn't, a recommended outline; strict-mode mermaid only; never \
         raw HTML). Keep every reply oriented to the goal. Respond directly and \
         concisely in markdown.\n\n\
         The user says:\n",
    );
    for line in user_text.lines() {
        p.push_str("> ");
        p.push_str(line);
        p.push('\n');
    }
    p
}

// --- Mission CRUD commands -------------------------------------------------

/// Create a new mission and return it. The frontend then sets it active
/// (mirroring it to the daemon) and opens the orchestrator chat.
#[tauri::command]
pub fn mission_create(
    mission: tauri::State<'_, MissionState>,
    title: String,
    goal: String,
) -> Result<Mission, String> {
    if goal.trim().is_empty() {
        return Err("a mission needs a goal".to_string());
    }
    let now = now_millis();
    let title = if title.trim().is_empty() {
        // Fall back to the first line of the goal as a title.
        goal.lines()
            .next()
            .map(|l| l.trim().chars().take(80).collect::<String>())
            .filter(|l| !l.is_empty())
            .unwrap_or_else(|| "Untitled mission".to_string())
    } else {
        title.trim().to_string()
    };
    let m = Mission {
        mission_id: uuid::Uuid::new_v4().to_string(),
        title,
        goal: goal.trim().to_string(),
        status: "active".to_string(),
        created_at: now,
        updated_at: now,
    };
    mission
        .db
        .insert_mission(&m)
        .map_err(|e| format!("failed to create mission: {e}"))?;
    Ok(m)
}

/// All missions, newest/active first — for the start/switch/resume menu.
#[tauri::command]
pub fn mission_list(mission: tauri::State<'_, MissionState>) -> Result<Vec<Mission>, String> {
    mission
        .db
        .list_missions()
        .map_err(|e| format!("failed to list missions: {e}"))
}

/// Edit a mission's title/goal (inline-editable goal header).
#[tauri::command]
pub fn mission_set_goal(
    mission: tauri::State<'_, MissionState>,
    mission_id: String,
    title: String,
    goal: String,
) -> Result<(), String> {
    if goal.trim().is_empty() {
        return Err("a mission needs a goal".to_string());
    }
    mission
        .db
        .update_mission_goal(&mission_id, title.trim(), goal.trim(), now_millis())
        .map_err(|e| format!("failed to update mission: {e}"))
}

/// One tab in a mission's saved workspace. `id` is informational (re-minted on
/// reopen); `browse_id` is the durable key that reattaches the tab's discussion.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionTab {
    #[serde(default)]
    pub id: Option<String>,
    pub url: String,
    #[serde(default)]
    pub title: String,
    pub browse_id: String,
}

/// Save a mission's tab workspace, so re-entering it reopens these exact tabs
/// (each discussion reattaches from its `browseId`).
#[tauri::command]
pub fn mission_set_tabs(
    mission: tauri::State<'_, MissionState>,
    mission_id: String,
    tabs: Vec<MissionTab>,
) -> Result<(), String> {
    let json = serde_json::to_string(&tabs).map_err(|e| format!("failed to encode tabs: {e}"))?;
    mission
        .db
        .set_mission_tabs(&mission_id, &json)
        .map_err(|e| format!("failed to save mission tabs: {e}"))
}

/// A mission's saved tabs (empty if none saved yet).
#[tauri::command]
pub fn mission_get_tabs(
    mission: tauri::State<'_, MissionState>,
    mission_id: String,
) -> Result<Vec<MissionTab>, String> {
    match mission.db.get_mission_tabs(&mission_id) {
        Some(json) => serde_json::from_str(&json)
            .map_err(|e| format!("failed to decode mission tabs: {e}")),
        None => Ok(Vec::new()),
    }
}

/// Hard-delete a mission: purge the saved tabs' discussion threads (keyed by
/// `browse_id`), then the mission row + its pins + orchestrator chat.
#[tauri::command]
pub fn mission_delete(
    mission: tauri::State<'_, MissionState>,
    mission_id: String,
) -> Result<(), String> {
    // Purge the per-tab browse discussions this mission owned, so a deleted
    // mission leaves no orphaned threads behind.
    if let Some(json) = mission.db.get_mission_tabs(&mission_id) {
        if let Ok(tabs) = serde_json::from_str::<Vec<MissionTab>>(&json) {
            for t in tabs {
                let _ = mission.db.delete_browse_thread(&t.browse_id);
            }
        }
    }
    mission
        .db
        .delete_mission(&mission_id)
        .map_err(|e| format!("failed to delete mission: {e}"))
}

/// Pin a finding (the user's "I like this part"). Captures the source tab so the
/// orchestrator and findings board can attribute it.
#[tauri::command]
pub fn mission_add_finding(
    mission: tauri::State<'_, MissionState>,
    mission_id: String,
    body: String,
    note: Option<String>,
    browse_id: Option<String>,
    source_url: Option<String>,
    source_title: Option<String>,
) -> Result<MissionFinding, String> {
    if body.trim().is_empty() {
        return Err("nothing to pin".to_string());
    }
    let f = MissionFinding {
        id: uuid::Uuid::new_v4().to_string(),
        mission_id,
        browse_id: browse_id.filter(|s| !s.trim().is_empty()),
        source_url: source_url.filter(|s| !s.trim().is_empty()),
        source_title: source_title.filter(|s| !s.trim().is_empty()),
        body: body.trim().to_string(),
        note: note.filter(|s| !s.trim().is_empty()),
        created_at: now_millis(),
    };
    mission
        .db
        .insert_finding(&f)
        .map_err(|e| format!("failed to pin finding: {e}"))?;
    Ok(f)
}

#[tauri::command]
pub fn mission_list_findings(
    mission: tauri::State<'_, MissionState>,
    mission_id: String,
) -> Result<Vec<MissionFinding>, String> {
    mission
        .db
        .list_findings(&mission_id)
        .map_err(|e| format!("failed to load findings: {e}"))
}

#[tauri::command]
pub fn mission_remove_finding(
    mission: tauri::State<'_, MissionState>,
    finding_id: String,
) -> Result<(), String> {
    mission
        .db
        .delete_finding(&finding_id)
        .map_err(|e| format!("failed to remove finding: {e}"))
}

// --- Orchestrator chat commands --------------------------------------------

/// Send a turn to a mission's orchestrator. The first turn starts a fresh
/// `claude` session (capturing its id); later turns resume it. Streaming happens
/// via `mission-*` events — this returns as soon as the child is spawned.
#[tauri::command]
pub async fn mission_send(
    mission: tauri::State<'_, MissionState>,
    app: AppHandle,
    mission_id: String,
    text: String,
    cwd: Option<String>,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("empty message".to_string());
    }

    // Reject a second concurrent turn for the same mission.
    {
        let guard = mission.procs.lock().unwrap();
        if guard.contains_key(&mission_id) {
            return Err("the orchestrator is still replying".to_string());
        }
    }

    let prior_session = mission.db.get_mission_session(&mission_id);

    // Persist the user turn (a terminal row).
    let user_msg = MissionMessage {
        id: uuid::Uuid::new_v4().to_string(),
        mission_id: mission_id.clone(),
        role: "user".to_string(),
        body: text.clone(),
        status: "complete".to_string(),
        created_at: now_millis(),
    };
    mission
        .db
        .insert_mission_message(&user_msg)
        .map_err(|e| format!("failed to persist message: {e}"))?;

    // First turn wraps the message with the goal + pins + tool docs; follow-ups
    // are verbatim (the resumed session already carries that context and curls
    // /v1/mission/findings for fresh pins).
    let prompt = match &prior_session {
        None => {
            let m = mission
                .db
                .get_mission(&mission_id)
                .map_err(|e| format!("failed to load mission: {e}"))?
                .ok_or_else(|| "mission not found".to_string())?;
            let findings = mission.db.list_findings(&mission_id).unwrap_or_default();
            build_first_turn_prompt(&m.title, &m.goal, &findings, &text)
        }
        Some(_) => text.clone(),
    };

    // Same tool surface as the browse agent: Bash scoped to the localhost
    // bridge (three quoting variants), plus WebSearch/WebFetch. See browse.rs
    // for why all three prefix rules are required.
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
        "Read,Grep,Glob,WebFetch,WebSearch,Bash".to_string(),
        "--allowedTools".to_string(),
        "WebSearch".to_string(),
        "WebFetch".to_string(),
        "Bash(curl -s http://127.0.0.1:7676/*)".to_string(),
        "Bash(curl -s 'http://127.0.0.1:7676/*)".to_string(),
        "Bash(curl -s \"http://127.0.0.1:7676/*)".to_string(),
        "--strict-mcp-config".to_string(),
    ];
    if let Some(sid) = &prior_session {
        args.push("--resume".to_string());
        args.push(sid.clone());
    }

    let cwd = cwd
        .filter(|c| !c.trim().is_empty())
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| "/".to_string());

    let claude_bin = mission.claude_bin().await?;
    let mut cmd = claude_command(&claude_bin);
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
        mission
            .procs
            .lock()
            .unwrap()
            .insert(mission_id.clone(), MissionProc { child });
    }
    tauri::async_runtime::spawn(read_mission(
        app,
        mission.db.clone(),
        mission.procs.clone(),
        mission_id,
        stdout,
        stderr,
    ));
    Ok(())
}

/// Load a mission's persisted orchestrator turns, oldest first.
#[tauri::command]
pub fn get_mission_thread(
    mission: tauri::State<'_, MissionState>,
    mission_id: String,
) -> Result<Vec<MissionMessage>, String> {
    mission
        .db
        .load_mission_thread(&mission_id)
        .map_err(|e| format!("failed to load thread: {e}"))
}

/// Kill the in-flight orchestrator turn for a mission, if any.
#[tauri::command]
pub fn mission_cancel(
    mission: tauri::State<'_, MissionState>,
    mission_id: String,
) -> Result<(), String> {
    let proc = { mission.procs.lock().unwrap().remove(&mission_id) };
    if let Some(mut proc) = proc {
        let _ = proc.child.start_kill();
    }
    Ok(())
}

/// Kill every running orchestrator — also invoked on app teardown.
#[tauri::command]
pub fn mission_kill_all(mission: tauri::State<'_, MissionState>) -> Result<(), String> {
    mission.kill_all();
    Ok(())
}

// --- Streaming reader ------------------------------------------------------

/// Drive one orchestrator turn: stream stdout JSONL → `mission-delta` events,
/// then reap the child and emit a terminal `mission-done` / `mission-error` /
/// `mission-cancelled`. Mirrors `browse::read_browse`.
async fn read_mission(
    app: AppHandle,
    db: Arc<Database>,
    procs: MissionRegistry,
    mission_id: String,
    stdout: ChildStdout,
    stderr: ChildStderr,
) {
    let stdout_fut = async {
        let mut reader = BufReader::new(stdout).lines();
        let mut session: Option<String> = None;
        let mut final_text: Option<String> = None;
        let mut errored: Option<String> = None;
        let mut saw_json = false;
        while let Ok(Some(line)) = reader.next_line().await {
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
                StreamLine::Delta(text) => {
                    let _ = app.emit(
                        "mission-delta",
                        MissionDelta {
                            mission_id: mission_id.clone(),
                            text,
                        },
                    );
                }
                StreamLine::Final { text, session_id: sid } => {
                    if sid.is_some() {
                        session = sid;
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
        let mut buf = String::new();
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            buf.push_str(&l);
            buf.push('\n');
        }
        buf
    };
    let ((session, final_text, errored, saw_json), stderr_text) =
        tokio::join!(stdout_fut, stderr_fut);

    let proc = { procs.lock().unwrap().remove(&mission_id) };
    let cancelled = proc.is_none() && final_text.is_none();
    let exit_ok = match proc {
        Some(mut p) => p.child.wait().await.map(|s| s.success()).unwrap_or(false),
        None => false,
    };

    if cancelled {
        let _ = app.emit("mission-cancelled", MissionCancelled { mission_id });
        return;
    }
    if let Some(err) = errored {
        finish_error(&app, &db, &mission_id, &err);
        return;
    }
    if let Some(text) = final_text {
        if text.trim().is_empty() {
            finish_error(&app, &db, &mission_id, "claude produced an empty reply");
            return;
        }
        if let Some(sid) = &session {
            if let Err(e) = db.set_mission_session(&mission_id, sid) {
                tracing::warn!(error = %e, "failed to persist mission session id");
            }
        }
        let msg = MissionMessage {
            id: uuid::Uuid::new_v4().to_string(),
            mission_id: mission_id.clone(),
            role: "assistant".to_string(),
            body: text.clone(),
            status: "complete".to_string(),
            created_at: now_millis(),
        };
        if let Err(e) = db.insert_mission_message(&msg) {
            tracing::warn!(error = %e, "failed to persist assistant message");
        }
        let _ = app.emit(
            "mission-done",
            MissionDone {
                mission_id,
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
    finish_error(&app, &db, &mission_id, &why);
}

/// Persist a failed turn as a terminal `error` row and emit `mission-error`.
fn finish_error(app: &AppHandle, db: &Database, mission_id: &str, error: &str) {
    let msg = MissionMessage {
        id: uuid::Uuid::new_v4().to_string(),
        mission_id: mission_id.to_string(),
        role: "assistant".to_string(),
        body: error.to_string(),
        status: "error".to_string(),
        created_at: now_millis(),
    };
    if let Err(e) = db.insert_mission_message(&msg) {
        tracing::warn!(error = %e, "failed to persist error mission message");
    }
    let _ = app.emit(
        "mission-error",
        MissionError {
            mission_id: mission_id.to_string(),
            error: error.to_string(),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finding(note: &str, title: &str, url: &str, body: &str) -> MissionFinding {
        MissionFinding {
            id: uuid::Uuid::new_v4().to_string(),
            mission_id: "m1".to_string(),
            browse_id: Some("b1".to_string()),
            source_url: Some(url.to_string()),
            source_title: Some(title.to_string()),
            body: body.to_string(),
            note: Some(note.to_string()),
            created_at: 0,
        }
    }

    #[test]
    fn first_turn_prompt_embeds_goal_pins_and_routes() {
        let pins = vec![finding(
            "love the tone",
            "Acme Breach",
            "https://acme.example/breach",
            "We act fast when seconds matter.",
        )];
        let p = build_first_turn_prompt(
            "Data-breach page",
            "Draft my firm's data-breach practice page",
            &pins,
            "Compare the tabs I have open.",
        );
        // Goal + user message present.
        assert!(p.contains("Draft my firm's data-breach practice page"));
        assert!(p.contains("Compare the tabs I have open."));
        // Pins (note + source + body) woven in.
        assert!(p.contains("love the tone"));
        assert!(p.contains("Acme Breach"));
        assert!(p.contains("We act fast when seconds matter."));
        // Mission read-routes + the cross-tab browser routes documented.
        assert!(p.contains("/v1/mission/findings"));
        assert!(p.contains("/v1/mission/active"));
        assert!(p.contains("/v1/browser/tabs"));
        assert!(p.contains("/v1/browser/thread?tab=<n>"));
        assert!(p.contains("/v1/browser/snapshot?tab=<n>"));
    }

    #[test]
    fn first_turn_prompt_without_pins_omits_pin_section() {
        let p = build_first_turn_prompt("Untitled", "find good examples", &[], "hi");
        assert!(p.contains("find good examples"));
        assert!(!p.contains("pinned these findings"));
        // Routes are always documented even with no pins.
        assert!(p.contains("/v1/browser/tabs"));
    }
}
