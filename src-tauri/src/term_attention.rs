// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Terminal attention: which dock terminal's agent is working, is blocked on
//! you, or has finished its turn (terminal-wall Phase 1).
//!
//! Every dock PTY carries `REDLINE_TERMINAL_ID` (`pty_spawn`), and hook
//! commands inherit the agent's environment (measured, experiment (l) in
//! `docs/protocol-verification.md`), so each fire names its terminal exactly,
//! with no lsof walk:
//!
//! - Claude Code: async `Notification`, `Stop` and `UserPromptSubmit` command
//!   hooks (`hook::install_attention`) POST their payload to `/v1/term/event`
//!   with the id in `X-Redline-Terminal`.
//! - Codex: the existing Stop hook (`/v1/codex/stop`) and prompt capture
//!   (`/v1/prompts/ingest`) carry the same header.
//!
//! The same fires bind the terminal's conversation mirror (`convo::bind`):
//! SessionStart joins the three above, plus SessionEnd, and every fire also
//! carries `X-Redline-Entrypoint` so a nested `claude -p` can be told apart.
//!
//! A session in an external terminal carries no id and is ignored, and so is
//! an id that names no live dock terminal. The daemon keeps the latest
//! attention per terminal and emits [`EVENT`]; "seen", the shelf and OS
//! notifications belong to the frontend, because only it knows what is on
//! screen.
//!
//! No hook marks an Esc interrupt: the CLI fires neither Stop nor its idle
//! notification afterwards (measured), so a terminal stays `working` until
//! its next prompt unless the frontend clears it on the Esc it forwards.
//!
//! Latest-wins per terminal is deliberate. A `claude -p` started from inside
//! a dock agent's Bash tool inherits the same id and reports on the same
//! terminal (its hook environment is indistinguishable from a top-level
//! session's, measured), and a blocking Stop hook of the user's own makes a
//! Stop that the agent then continues past. Both are brief and both end in a
//! real Stop.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::pty::PtyState;

/// The header every attention fire names its terminal in.
pub const HEADER: &str = "X-Redline-Terminal";
/// The header carrying the CLI's `CLAUDE_CODE_ENTRYPOINT`: `cli` for the
/// TUI, `sdk-cli` for a `claude -p` (experiment (m), S2), which the
/// conversation mirror never binds a terminal to.
pub const ENTRYPOINT_HEADER: &str = "X-Redline-Entrypoint";
/// The variable `pty_spawn` sets on every dock shell, which the hooks forward.
pub const ENV_TERMINAL_ID: &str = "REDLINE_TERMINAL_ID";
/// Emitted with a [`TermAttention`] on every change.
pub const EVENT: &str = "term-attention";

/// Excerpts are a glance (a work line, a notification body), never the reply.
const EXCERPT_CHARS: usize = 240;
/// The final reply lands in the transcript 55-125 ms after Stop fires
/// (measured); the fallback waits well past that, and then gives up rather
/// than show the previous turn's reply.
const TRANSCRIPT_WAIT: Duration = Duration::from_secs(2);
const TRANSCRIPT_POLL: Duration = Duration::from_millis(100);
const TRANSCRIPT_TAIL_BYTES: u64 = 256 * 1024;

/// What a terminal's agent needs from you. The kind names line up with the
/// frontend's terminal states (`needs-you`, `your-turn`, `working`); `idle`
/// clears a `working` whose Stop never arrived.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Attention {
    /// A prompt went in, or a blocking dialog was answered.
    Working,
    /// The agent is blocked on you. `reason` is Claude Code's
    /// `notification_type` (`permission_prompt` covers AskUserQuestion too);
    /// `message` is its text, which for a permission card is the generic
    /// "Claude needs your permission" (measured).
    NeedsYou { reason: String, message: Option<String> },
    /// The agent finished its turn; `excerpt` is the end of its reply.
    YourTurn { excerpt: Option<String> },
    /// A `working` whose Stop never reached us, cleared by the CLI's idle
    /// reminder: the agent is at its prompt with nothing pending.
    Idle,
}

/// The latest attention for one terminal: the `term-attention` payload and a
/// `term_attention_snapshot` row. A new `at` is a new transition even when the
/// kind repeats (two permission prompts in a row are two needs).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TermAttention {
    pub terminal_id: String,
    #[serde(flatten)]
    pub attention: Attention,
    pub session_id: Option<String>,
    /// Unix ms the event arrived.
    pub at: i64,
}

/// Latest attention per terminal id.
#[derive(Clone, Default)]
pub struct TermAttentionState(Arc<Mutex<HashMap<String, TermAttention>>>);

impl TermAttentionState {
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, TermAttention>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn current(&self, terminal_id: &str) -> Option<Attention> {
        self.map().get(terminal_id).map(|entry| entry.attention.clone())
    }

    fn record(&self, entry: TermAttention) {
        self.map().insert(entry.terminal_id.clone(), entry);
    }

    /// Give a `your-turn` its excerpt once the transcript has it — only while
    /// it is still the terminal's latest event, so a late fill can never
    /// overwrite what happened since.
    fn fill_excerpt(&self, terminal_id: &str, at: i64, excerpt: String) -> Option<TermAttention> {
        let mut map = self.map();
        let entry = map.get_mut(terminal_id).filter(|entry| entry.at == at)?;
        let Attention::YourTurn { excerpt: slot @ None } = &mut entry.attention else {
            return None;
        };
        *slot = Some(excerpt);
        Some(entry.clone())
    }

    /// Every live terminal's latest attention; entries for terminals that have
    /// closed are dropped on the way.
    fn snapshot(&self, live: impl Fn(&str) -> bool) -> Vec<TermAttention> {
        let mut map = self.map();
        map.retain(|id, _| live(id));
        let mut rows: Vec<_> = map.values().cloned().collect();
        rows.sort_by(|a, b| a.at.cmp(&b.at).then_with(|| a.terminal_id.cmp(&b.terminal_id)));
        rows
    }
}

/// The terminal a request names, if it names a plausible one. Terminal ids
/// are the frontend's UUIDs; anything else (absent, empty, oversized, odd
/// characters) is a session outside the dock.
pub fn terminal_header(headers: &HeaderMap) -> Option<String> {
    headers
        .get(HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|id| crate::claude_proc::is_plain_session_id(id))
        .map(str::to_string)
}

fn text_field<'a>(payload: &'a Value, key: &str) -> Option<&'a str> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// What one Claude Code hook fire says about its terminal, given what that
/// terminal last said. `None` leaves the terminal as it was.
pub fn from_claude_hook(payload: &Value, current: Option<&Attention>) -> Option<Attention> {
    match payload.get("hook_event_name").and_then(Value::as_str)? {
        "UserPromptSubmit" => Some(Attention::Working),
        "Stop" => Some(Attention::YourTurn {
            excerpt: text_field(payload, "last_assistant_message").and_then(excerpt),
        }),
        "Notification" => from_notification(payload, current),
        _ => None,
    }
}

/// `notification_type` values from Claude Code's hooks reference; the ones
/// this CLI was seen to send are pinned in `docs/protocol-verification.md`.
fn from_notification(payload: &Value, current: Option<&Attention>) -> Option<Attention> {
    let message = text_field(payload, "message").map(|m| clip(m, EXCERPT_CHARS));
    let kind = match text_field(payload, "notification_type") {
        Some(kind) => kind,
        // A CLI that predates `notification_type` sent only these two.
        None => {
            let lower = message.as_deref()?.to_lowercase();
            if lower.contains("permission") {
                "permission_prompt"
            } else if lower.contains("waiting for your input") {
                "idle_prompt"
            } else {
                return None;
            }
        }
    };
    match kind {
        "permission_prompt" | "elicitation_dialog" | "elicitation_url_dialog"
        | "agent_needs_input" | "quota_auto_resume_stale" => Some(Attention::NeedsYou {
            reason: kind.to_string(),
            message,
        }),
        // The dialog was answered, or a usage-limit wait resumed the task.
        "elicitation_complete" | "elicitation_response" | "quota_auto_resume_fired" => {
            Some(Attention::Working)
        }
        // The wait ended without continuing: the task is back in your hands.
        "quota_auto_resume_disabled" => Some(Attention::YourTurn { excerpt: message }),
        // A minute or more after a finished turn this is only a reminder of
        // a `your-turn` already shown, so it must neither re-arm nor erase
        // it. Over a `working` it means that turn's Stop was lost (a daemon
        // restart, a dropped POST) and the agent is waiting. An Esc
        // interrupt fires neither (measured), so the frontend clears
        // `working` on the Esc itself.
        "idle_prompt" => matches!(current, Some(Attention::Working)).then_some(Attention::Idle),
        _ => None,
    }
}

/// The end of a reply, flattened to one line: its last paragraph with words
/// in it (where an agent puts its question or its ask), light markdown
/// removed, clipped to a glance.
pub fn excerpt(reply: &str) -> Option<String> {
    let paragraph = reply
        .split("\n\n")
        .map(|p| {
            p.lines()
                .map(|line| line.trim().trim_start_matches(['#', '>', '-', '*', ' ']))
                .filter(|line| !line.starts_with("```") && !line.starts_with('|'))
                .collect::<Vec<_>>()
                .join(" ")
                .replace("**", "")
                .replace('`', "")
        })
        .filter(|p| p.chars().any(char::is_alphanumeric))
        .last()?;
    Some(clip(&paragraph.split_whitespace().collect::<Vec<_>>().join(" "), EXCERPT_CHARS))
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max - 1).collect();
    format!("{}…", cut.trim_end())
}

/// The final reply of the turn in a Claude Code transcript tail, or `None`
/// while it has not been written yet. A user record (a prompt, or a tool
/// result the reply is still answering) after the last assistant text means
/// the reply is still to come; never resurrect the previous turn's.
pub fn last_reply(tail: &str) -> Option<String> {
    for line in tail.lines().rev().filter(|l| !l.trim().is_empty()) {
        let Ok(row) = serde_json::from_str::<Value>(line) else { continue };
        match row.get("type").and_then(Value::as_str) {
            Some("user") => return None,
            Some("assistant") => {
                let text: String = row
                    .pointer("/message/content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|block| block.get("text").and_then(Value::as_str))
                    .collect();
                if !text.trim().is_empty() {
                    return Some(text);
                }
                // A thinking or tool_use record: keep looking back.
            }
            _ => continue,
        }
    }
    None
}

/// The transcript a Stop payload names, if it is one of Claude Code's: a
/// `.jsonl` under its projects directory. The route is unauthenticated, so a
/// path anywhere else is never opened.
fn transcript_under(path: &str, projects: &Path) -> Option<PathBuf> {
    let canonical = Path::new(path).canonicalize().ok()?;
    let root = projects.canonicalize().ok()?;
    (canonical.starts_with(&root)
        && canonical.extension().is_some_and(|ext| ext == "jsonl")
        && canonical.is_file())
    .then_some(canonical)
}

/// `transcript_under` for a path the CLI may not have written yet:
/// SessionStart names its transcript before the first prompt creates it
/// (experiment (m), S1). The file, once it exists, must still be a `.jsonl`
/// file inside the projects directory.
pub(crate) fn transcript_target(path: &str, projects: &Path) -> Option<PathBuf> {
    let path = Path::new(path);
    if path.exists() {
        return transcript_under(path.to_str()?, projects);
    }
    let parent = path.parent()?.canonicalize().ok()?;
    let name = path.file_name()?;
    (parent.starts_with(projects.canonicalize().ok()?) && path.extension().is_some_and(|ext| ext == "jsonl"))
        .then(|| parent.join(name))
}

fn read_tail(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(TRANSCRIPT_TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.take(TRANSCRIPT_TAIL_BYTES).read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    // A mid-file start lands inside a record; drop the partial first line.
    Some(if start > 0 { text.split_once('\n').map_or(String::new(), |(_, rest)| rest.to_string()) } else { text.into_owned() })
}

/// Poll the transcript for the turn's final reply. Stop fires a beat before
/// the CLI writes it, so the first read usually comes back empty.
async fn wait_for_reply(path: PathBuf, wait: Duration) -> Option<String> {
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        let reply = tokio::task::spawn_blocking({
            let path = path.clone();
            move || read_tail(&path).and_then(|tail| last_reply(&tail))
        })
        .await
        .ok()
        .flatten();
        if reply.is_some() || tokio::time::Instant::now() >= deadline {
            return reply;
        }
        tokio::time::sleep(TRANSCRIPT_POLL).await;
    }
}

/// Store and broadcast one terminal's new attention. Ignored unless the id
/// names a live dock terminal.
fn apply(app: &AppHandle, terminal_id: &str, attention: Attention, session_id: Option<&str>) -> Option<TermAttention> {
    let state = app.try_state::<TermAttentionState>()?;
    if !app.try_state::<PtyState>()?.is_live(terminal_id) {
        return None;
    }
    let entry = TermAttention {
        terminal_id: terminal_id.to_string(),
        attention,
        session_id: session_id.filter(|s| !s.is_empty()).map(str::to_string),
        at: crate::ledger::now_millis(),
    };
    state.record(entry.clone());
    let _ = app.emit(EVENT, &entry);
    Some(entry)
}

/// A Claude Code attention hook's payload (`/v1/term/event`).
pub fn observe_claude(app: &AppHandle, terminal_id: &str, payload: &Value) {
    let current = app
        .try_state::<TermAttentionState>()
        .and_then(|state| state.current(terminal_id));
    let Some(attention) = from_claude_hook(payload, current.as_ref()) else { return };
    let needs_transcript = matches!(attention, Attention::YourTurn { excerpt: None })
        && payload.get("hook_event_name").and_then(Value::as_str) == Some("Stop");
    let Some(entry) = apply(app, terminal_id, attention, text_field(payload, "session_id")) else { return };
    // A CLI without `last_assistant_message`: take the excerpt from the
    // transcript once the reply lands, without holding up the state change.
    let transcript = needs_transcript
        .then(|| text_field(payload, "transcript_path"))
        .flatten()
        .zip(crate::claude_proc::claude_config_dir().map(|config| config.join("projects")))
        .and_then(|(path, projects)| transcript_under(path, &projects));
    if let Some(path) = transcript {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let Some(excerpt) = wait_for_reply(path, TRANSCRIPT_WAIT).await.as_deref().and_then(excerpt) else { return };
            let filled = app
                .try_state::<TermAttentionState>()
                .and_then(|state| state.fill_excerpt(&entry.terminal_id, entry.at, excerpt));
            if let Some(filled) = filled {
                let _ = app.emit(EVENT, &filled);
            }
        });
    }
}

/// A Codex Stop that carried no plan: the turn is over and it is your move.
pub fn observe_codex_stop(app: &AppHandle, terminal_id: &str, payload: &Value) {
    let excerpt = text_field(payload, "last_assistant_message").and_then(excerpt);
    apply(app, terminal_id, Attention::YourTurn { excerpt }, text_field(payload, "session_id"));
}

/// A prompt captured through `/v1/prompts/ingest` from a dock terminal (the
/// Codex prompt hook carries the header): the agent is on it.
pub fn observe_prompt(app: &AppHandle, terminal_id: &str, session_id: Option<&str>) {
    apply(app, terminal_id, Attention::Working, session_id);
}

/// POST `/v1/term/event` — the Claude Code attention hooks' sink. Always `{}`:
/// the hooks are async and fail-open, so nothing here can hold up a turn.
/// The same fires bind the terminal's conversation mirror (`convo`).
pub(crate) async fn handle_event(
    State(app_state): State<crate::AppState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Json<Value> {
    if let Some(terminal_id) = terminal_header(&headers) {
        observe_claude(&app_state.app_handle, &terminal_id, &payload);
        let entrypoint = headers.get(ENTRYPOINT_HEADER).and_then(|v| v.to_str().ok()).map(str::trim).filter(|v| !v.is_empty());
        crate::convo::observe_hook(&app_state.app_handle, &terminal_id, entrypoint, &payload);
    }
    Json(json!({}))
}

/// A hook that fired while Redline was closed left its payload in the
/// attention spool (`hook::SPOOL_DIR`, one file per terminal, the newest
/// event only). A relaunch that adopted those terminals replays each as if
/// it had just been POSTed: a CLI that blocked on a permission while
/// Redline was away reads "needs you" again. Spooled files of terminals no
/// one adopted are dropped once a day old; what is replayed is removed.
pub fn replay_spool(app: &AppHandle, live: &[String]) {
    let Some(dir) = spool_dir() else { return };
    for (terminal_id, payload) in take_spool(&dir, live, std::time::SystemTime::now()) {
        observe_claude(app, &terminal_id, &payload);
        crate::convo::observe_hook(app, &terminal_id, None, &payload);
    }
}

fn spool_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".redline/attention-spool"))
}

/// The spool's replayable entries for `live` terminals, removed as they are
/// read; stale entries of other terminals are removed too.
pub(crate) fn take_spool(dir: &Path, live: &[String], now: std::time::SystemTime) -> Vec<(String, Value)> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(id) = path.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix(".json")).map(str::to_string) else { continue };
        if live.contains(&id) {
            if let Some(payload) = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) {
                out.push((id, payload));
            }
            let _ = std::fs::remove_file(&path);
        } else {
            let old = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| now.duration_since(t).ok()).is_some_and(|age| age > Duration::from_secs(24 * 3600));
            if old {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// A `working` or `needs-you` at least this old whose shell is back in the
/// foreground is over: its agent exited, or was interrupted and then quit.
/// Younger ones are left alone — the scan can land between a prompt's hook
/// firing and the CLI taking the foreground.
const RETIRE_AFTER_MS: i64 = 5_000;
/// How often [`retire_finished`] looks. It reads each pty's foreground
/// process group from the kernel — no fork — so it is cheap enough to run
/// always, and does nothing while no terminal reports work.
pub const RETIRE_TICK: Duration = Duration::from_secs(10);

/// Retire the `working` and `needs-you` entries whose terminal's shell has
/// the foreground again: the agent that reported them is gone, and no hook
/// says so. Every reader of `term-attention` sees it — the sidebar's rows,
/// which used to spin until the terminal's next prompt, as well as the dock —
/// and the conversation mirror closes its turn and drops to its idle cadence.
pub fn retire_finished(app: &AppHandle) {
    let (Some(state), Some(ptys)) = (app.try_state::<TermAttentionState>(), app.try_state::<PtyState>()) else {
        return;
    };
    let now = crate::ledger::now_millis();
    let stale: HashMap<String, Option<String>> = state
        .map()
        .iter()
        .filter(|(_, e)| {
            now - e.at >= RETIRE_AFTER_MS && matches!(e.attention, Attention::Working | Attention::NeedsYou { .. })
        })
        .map(|(id, e)| (id.clone(), e.session_id.clone()))
        .collect();
    if stale.is_empty() {
        return;
    }
    for (id, shell, foreground) in crate::pty::foreground_snapshot(&ptys) {
        let Some(session_id) = stale.get(&id) else { continue };
        if shell.is_some() && foreground == shell {
            retire(app, &id, session_id.as_deref());
        }
    }
}

/// Clear a terminal's `working` / `needs-you` to `idle`: its agent is at the
/// prompt, or gone, with nothing pending. Broadcast like any transition, and
/// told to the conversation mirror so its turn closes too.
pub fn retire(app: &AppHandle, terminal_id: &str, session_id: Option<&str>) {
    if apply(app, terminal_id, Attention::Idle, session_id).is_some() {
        crate::convo::note_idle(app, terminal_id);
    }
}

/// The user pressed Esc or Ctrl-C in a dock terminal: whatever its agent was
/// doing or asking is over, and no hook will say so (an interrupt fires
/// neither Stop nor the idle notification, measured). The dock already clears
/// its own badge; this clears it for everyone else who reads `term-attention`.
#[tauri::command]
pub fn term_attention_interrupted(app: AppHandle, state: tauri::State<'_, TermAttentionState>, terminal_id: String) {
    let current = state.map().get(&terminal_id).cloned();
    let Some(entry) = current else { return };
    if matches!(entry.attention, Attention::Working | Attention::NeedsYou { .. }) {
        retire(&app, &terminal_id, entry.session_id.as_deref());
    }
}

/// Every live terminal's latest attention, for a frontend that is (re)booting.
#[tauri::command]
pub fn term_attention_snapshot(
    state: tauri::State<'_, TermAttentionState>,
    ptys: tauri::State<'_, PtyState>,
) -> Vec<TermAttention> {
    state.snapshot(|id| ptys.is_live(id))
}

/// The Dock badge: how many terminals need you. The frontend owns the count,
/// because "seen" lives there; zero clears the badge.
#[tauri::command]
pub fn set_attention_badge(window: tauri::Window, count: u32) -> Result<(), String> {
    window
        .set_badge_count((count > 0).then(|| i64::from(count)))
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_spool_gives_back_each_adopted_terminals_newest_event_once() {
        let dir = std::env::temp_dir().join(format!("rl-spool-take-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("kept.json"), br#"{"hook_event_name":"Notification","notification_type":"permission_prompt","message":"Claude needs your permission"}"#).unwrap();
        std::fs::write(dir.join("other.json"), b"{}").unwrap();
        std::fs::write(dir.join("broken.json"), b"{not json").unwrap();
        let live = vec!["kept".to_string(), "broken".to_string()];
        let got = take_spool(&dir, &live, std::time::SystemTime::now());
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].0, "kept");
        assert!(matches!(from_claude_hook(&got[0].1, None), Some(Attention::NeedsYou { .. })), "it lights needs-you");
        assert!(!dir.join("kept.json").exists() && !dir.join("broken.json").exists(), "read once");
        assert!(dir.join("other.json").exists(), "another app's terminal keeps its entry for a day");
        let later = std::time::SystemTime::now() + Duration::from_secs(25 * 3600);
        assert!(take_spool(&dir, &live, later).is_empty());
        assert!(!dir.join("other.json").exists(), "a day-old entry nobody adopted goes");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn note(kind: &str, message: &str) -> Value {
        json!({"hook_event_name": "Notification", "notification_type": kind, "message": message, "session_id": "s"})
    }

    /// Captured from claude 2.1.295 by `scripts/verify-attention-hooks.py`
    /// (paths shortened): an AskUserQuestion card, left unanswered.
    const NOTIFICATION_FIXTURE: &str = r#"{"session_id":"8d0c4f61-6c1e-4a59-9a4e-2f6a1d0c9b11","transcript_path":"/Users/u/.claude/projects/-tmp-proj/8d0c4f61-6c1e-4a59-9a4e-2f6a1d0c9b11.jsonl","cwd":"/tmp/proj","prompt_id":"3f1e","scratchpad_dir":"/tmp/s","hook_event_name":"Notification","message":"Claude needs your permission","notification_type":"permission_prompt"}"#;
    /// Captured the same way: the end of a turn.
    const STOP_FIXTURE: &str = r#"{"session_id":"8d0c4f61-6c1e-4a59-9a4e-2f6a1d0c9b11","transcript_path":"/Users/u/.claude/projects/-tmp-proj/8d0c4f61-6c1e-4a59-9a4e-2f6a1d0c9b11.jsonl","cwd":"/tmp/proj","prompt_id":"3f1e","permission_mode":"auto","effort":{"level":"medium"},"hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"You prefer red.","background_tasks":[],"session_crons":[],"scratchpad_dir":"/tmp/s"}"#;

    #[test]
    fn measured_payloads_map_to_needs_you_and_your_turn() {
        let notification: Value = serde_json::from_str(NOTIFICATION_FIXTURE).unwrap();
        assert_eq!(
            from_claude_hook(&notification, Some(&Attention::Working)),
            Some(Attention::NeedsYou { reason: "permission_prompt".into(), message: Some("Claude needs your permission".into()) })
        );
        let stop: Value = serde_json::from_str(STOP_FIXTURE).unwrap();
        assert_eq!(from_claude_hook(&stop, None), Some(Attention::YourTurn { excerpt: Some("You prefer red.".into()) }));
        let prompt = json!({"hook_event_name": "UserPromptSubmit", "prompt": "go", "session_id": "s"});
        assert_eq!(from_claude_hook(&prompt, Some(&Attention::YourTurn { excerpt: None })), Some(Attention::Working));
        assert_eq!(from_claude_hook(&json!({"hook_event_name": "PreToolUse"}), None), None);
        assert_eq!(from_claude_hook(&json!({}), None), None);
    }

    #[test]
    fn a_stop_without_last_assistant_message_waits_for_the_transcript() {
        for stop in [json!({"hook_event_name": "Stop"}), json!({"hook_event_name": "Stop", "last_assistant_message": "  "})] {
            assert_eq!(from_claude_hook(&stop, None), Some(Attention::YourTurn { excerpt: None }));
        }
    }

    #[test]
    fn notification_types_sort_into_blocked_resumed_and_ignored() {
        for kind in ["permission_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input", "quota_auto_resume_stale"] {
            assert!(matches!(from_claude_hook(&note(kind, "m"), None), Some(Attention::NeedsYou { reason, .. }) if reason == kind), "{kind}");
        }
        for kind in ["elicitation_complete", "elicitation_response", "quota_auto_resume_fired"] {
            assert_eq!(from_claude_hook(&note(kind, "m"), None), Some(Attention::Working), "{kind}");
        }
        assert_eq!(
            from_claude_hook(&note("quota_auto_resume_disabled", "Usage limit reached"), None),
            Some(Attention::YourTurn { excerpt: Some("Usage limit reached".into()) })
        );
        for kind in ["auth_success", "agent_completed", "something_new"] {
            assert_eq!(from_claude_hook(&note(kind, "m"), Some(&Attention::Working)), None, "{kind}");
        }
    }

    #[test]
    fn idle_prompt_only_clears_a_turn_that_never_got_its_stop() {
        let idle = note("idle_prompt", "Claude is waiting for your input");
        assert_eq!(from_claude_hook(&idle, Some(&Attention::Working)), Some(Attention::Idle));
        let your_turn = Attention::YourTurn { excerpt: Some("done".into()) };
        assert_eq!(from_claude_hook(&idle, Some(&your_turn)), None, "a reminder must not re-arm or erase your-turn");
        let needs = Attention::NeedsYou { reason: "permission_prompt".into(), message: None };
        assert_eq!(from_claude_hook(&idle, Some(&needs)), None);
        assert_eq!(from_claude_hook(&idle, None), None);
    }

    #[test]
    fn a_notification_without_a_type_is_read_from_its_message() {
        let legacy = |message: &str| json!({"hook_event_name": "Notification", "message": message});
        assert!(matches!(
            from_claude_hook(&legacy("Claude needs your permission to use Bash"), None),
            Some(Attention::NeedsYou { reason, message: Some(m) }) if reason == "permission_prompt" && m.ends_with("Bash")
        ));
        assert_eq!(from_claude_hook(&legacy("Claude is waiting for your input"), Some(&Attention::Working)), Some(Attention::Idle));
        assert_eq!(from_claude_hook(&legacy("Something else"), None), None);
        assert_eq!(from_claude_hook(&json!({"hook_event_name": "Notification"}), None), None);
    }

    #[test]
    fn excerpt_keeps_the_last_paragraph_flat_and_short() {
        assert_eq!(excerpt("I ran the tests.\n\nAll green.\n\nWhich API key should I use?").as_deref(), Some("Which API key should I use?"));
        assert_eq!(excerpt("## Done\n\n- **Built** the `shelf`\n- wired it\n\n```\n```").as_deref(), Some("Built the shelf wired it"));
        assert_eq!(excerpt("Summary:\n\n| a | b |\n|---|---|"), Some("Summary:".into()));
        assert_eq!(excerpt("   \n\n```\n```"), None);
        let long = excerpt(&"word ".repeat(200)).unwrap();
        assert_eq!(long.chars().count(), EXCERPT_CHARS);
        assert!(long.ends_with('…'));
    }

    fn row(kind: &str, content: Value) -> String {
        json!({"type": kind, "message": {"role": kind, "content": content}}).to_string()
    }

    #[test]
    fn last_reply_reads_the_final_text_and_never_the_previous_turn() {
        let prompt = row("user", json!("say hi"));
        let tool_use = row("assistant", json!([{"type": "tool_use", "name": "Bash", "input": {}}]));
        let tool_result = row("user", json!([{"type": "tool_result", "content": "ok"}]));
        let thinking = row("assistant", json!([{"type": "thinking", "thinking": "hmm"}]));
        let reply = row("assistant", json!([{"type": "text", "text": "All done."}]));
        let previous = row("assistant", json!([{"type": "text", "text": "Earlier reply."}]));
        let system = json!({"type": "system", "content": "stop hook ran"}).to_string();

        let finished = [prompt.as_str(), tool_use.as_str(), tool_result.as_str(), thinking.as_str(), reply.as_str(), system.as_str()].join("\n");
        assert_eq!(last_reply(&finished).as_deref(), Some("All done."));
        // Stop fires before the reply is written: the tail ends in the tool
        // result, or in the new prompt right after the previous turn's reply.
        assert_eq!(last_reply(&[prompt.as_str(), tool_use.as_str(), tool_result.as_str(), thinking.as_str()].join("\n")), None);
        assert_eq!(last_reply(&[previous.as_str(), prompt.as_str()].join("\n")), None);
        assert_eq!(last_reply(&format!("{{\"type\":\"assist\n{}", reply)).as_deref(), Some("All done."), "a torn first line is skipped");
        assert_eq!(last_reply(""), None);
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("redline-attn-{}-{name}-{}", std::process::id(), uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn only_a_jsonl_under_the_projects_dir_is_ever_opened() {
        let root = scratch("root");
        let projects = root.join("projects");
        std::fs::create_dir_all(projects.join("-p")).unwrap();
        let inside = projects.join("-p/s.jsonl");
        std::fs::write(&inside, "").unwrap();
        let wrong_ext = projects.join("-p/s.txt");
        std::fs::write(&wrong_ext, "").unwrap();
        let outside = root.join("s.jsonl");
        std::fs::write(&outside, "").unwrap();
        assert!(transcript_under(inside.to_str().unwrap(), &projects).is_some());
        assert!(transcript_under(wrong_ext.to_str().unwrap(), &projects).is_none());
        assert!(transcript_under(outside.to_str().unwrap(), &projects).is_none());
        let escape = projects.join("-p/../../s.jsonl");
        assert!(transcript_under(escape.to_str().unwrap(), &projects).is_none(), "dot-dot resolves outside");
        assert!(transcript_under(projects.join("-p/missing.jsonl").to_str().unwrap(), &projects).is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_transcript_not_yet_written_is_accepted_under_the_projects_dir_only() {
        let root = scratch("target");
        let projects = root.join("projects");
        std::fs::create_dir_all(projects.join("-p")).unwrap();
        let fresh = projects.join("-p/new.jsonl");
        assert!(transcript_target(fresh.to_str().unwrap(), &projects).is_some_and(|p| p.ends_with("-p/new.jsonl")));
        assert!(transcript_target(projects.join("-p/new.txt").to_str().unwrap(), &projects).is_none());
        assert!(transcript_target(root.join("new.jsonl").to_str().unwrap(), &projects).is_none());
        assert!(transcript_target(projects.join("-p/../../x.jsonl").to_str().unwrap(), &projects).is_none(), "dot-dot resolves outside");
        assert!(transcript_target(projects.join("-missing/x.jsonl").to_str().unwrap(), &projects).is_none(), "its folder must exist");
        std::fs::write(&fresh, "").unwrap();
        assert!(transcript_target(fresh.to_str().unwrap(), &projects).is_some(), "and once written, as before");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn the_transcript_fallback_waits_for_the_reply_to_land() {
        let dir = scratch("tail");
        let path = dir.join("s.jsonl");
        std::fs::write(&path, format!("{}\n", row("user", json!("which key?")))).unwrap();
        let writer = {
            let path = path.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(250)).await;
                let mut text = std::fs::read_to_string(&path).unwrap();
                text.push_str(&format!("{}\n", row("assistant", json!([{"type": "text", "text": "Paste the API key."}]))));
                std::fs::write(&path, text).unwrap();
            })
        };
        assert_eq!(wait_for_reply(path.clone(), Duration::from_secs(2)).await.as_deref(), Some("Paste the API key."));
        writer.await.unwrap();
        std::fs::write(&path, format!("{}\n", row("user", json!("next")))).unwrap();
        assert_eq!(wait_for_reply(path, Duration::from_millis(250)).await, None, "gives up instead of guessing");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn read_tail_drops_the_partial_first_record() {
        let dir = scratch("big");
        let path = dir.join("s.jsonl");
        let filler = row("assistant", json!([{"type": "text", "text": "x".repeat(1000)}]));
        let mut text = String::new();
        while (text.len() as u64) < TRANSCRIPT_TAIL_BYTES + 5000 {
            text.push_str(&filler);
            text.push('\n');
        }
        text.push_str(&row("assistant", json!([{"type": "text", "text": "the end"}])));
        std::fs::write(&path, &text).unwrap();
        let tail = read_tail(&path).unwrap();
        assert!(tail.len() as u64 <= TRANSCRIPT_TAIL_BYTES);
        assert!(tail.lines().all(|line| serde_json::from_str::<Value>(line).is_ok()), "every kept line is a whole record");
        assert_eq!(last_reply(&tail).as_deref(), Some("the end"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn entry(id: &str, attention: Attention, at: i64) -> TermAttention {
        TermAttention { terminal_id: id.into(), attention, session_id: None, at }
    }

    #[test]
    fn the_state_keeps_the_latest_per_terminal_and_fills_only_its_own_excerpt() {
        let state = TermAttentionState::default();
        state.record(entry("a", Attention::Working, 1));
        state.record(entry("a", Attention::YourTurn { excerpt: None }, 2));
        state.record(entry("b", Attention::Working, 3));
        assert_eq!(state.current("a"), Some(Attention::YourTurn { excerpt: None }));
        assert_eq!(state.fill_excerpt("a", 1, "stale".into()), None, "an older event's fill is dropped");
        assert_eq!(state.fill_excerpt("b", 3, "x".into()), None, "only a your-turn takes an excerpt");
        let filled = state.fill_excerpt("a", 2, "Done.".into()).unwrap();
        assert_eq!(filled.attention, Attention::YourTurn { excerpt: Some("Done.".into()) });
        assert_eq!(state.fill_excerpt("a", 2, "again".into()), None, "an excerpt is set once");
        assert_eq!(state.snapshot(|id| id != "b").iter().map(|e| e.terminal_id.as_str()).collect::<Vec<_>>(), ["a"]);
        assert_eq!(state.current("b"), None, "a closed terminal's entry is pruned by the snapshot");
    }

    #[test]
    fn the_wire_shape_is_flat_camel_case_with_a_kebab_kind() {
        let needs = entry("t1", Attention::NeedsYou { reason: "permission_prompt".into(), message: Some("m".into()) }, 5);
        assert_eq!(
            serde_json::to_value(&needs).unwrap(),
            json!({"terminalId": "t1", "kind": "needs-you", "reason": "permission_prompt", "message": "m", "sessionId": null, "at": 5})
        );
        assert_eq!(serde_json::to_value(entry("t", Attention::YourTurn { excerpt: None }, 1)).unwrap()["kind"], "your-turn");
        assert_eq!(serde_json::to_value(entry("t", Attention::Working, 1)).unwrap()["kind"], "working");
        assert_eq!(serde_json::to_value(entry("t", Attention::Idle, 1)).unwrap()["kind"], "idle");
    }

    #[test]
    fn only_a_plausible_terminal_id_is_read_from_the_header() {
        let with = |value: &str| {
            let mut headers = HeaderMap::new();
            headers.insert(HEADER, value.parse().unwrap());
            terminal_header(&headers)
        };
        assert_eq!(with("3b5e0c1a-9d1f-4e7a-8c43-0e9f2b6d7a10").as_deref(), Some("3b5e0c1a-9d1f-4e7a-8c43-0e9f2b6d7a10"));
        assert_eq!(with(" padded ").as_deref(), Some("padded"));
        assert_eq!(with(""), None, "an external session sends the header empty");
        assert_eq!(with("../etc"), None);
        assert_eq!(terminal_header(&HeaderMap::new()), None);
    }
}
