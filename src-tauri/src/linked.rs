// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The browser's "linked discussion": a headless `claude` session that holds ONE
//! continuous conversation spanning every browser tab. Unlike a page discussion
//! (`browse.rs`, one tab) or a mission (`mission.rs`, one fixed goal), a linked
//! discussion has no goal — it simply follows the user as they switch tabs, so
//! the whole browse is one thread.
//!
//! Mirrors `mission.rs` structurally (keyed registry of `tokio::process::Child`,
//! stream-json reader, `*-delta`/`*-done`/`*-error`/`*-cancelled` events,
//! DB-persisted terminal turns) but is keyed by `linked_id` and differs in two
//! load-bearing ways:
//!
//! 1. **Every turn is re-grounded on the current tab.** Where mission/browse send
//!    follow-ups verbatim, a linked follow-up must be re-told which tab the user
//!    is now on (`build_followup_prompt`) — the tab changes between turns.
//! 2. **Consult = map-reduce delegation.** When a tab's context gets heavy the
//!    agent "checks in with a colleague" by curling `POST /v1/linked/consult`,
//!    which runs *that tab's* browse agent (`BrowseState::consult`) and returns
//!    only a digest — keeping the heavy per-tab thread out of this conversation.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdout};

use crate::claude_proc::{
    bridge_args, classify_line, claude_command, mission_context_block, resolve_claude_bin,
    StreamLine,
};
use crate::db::Database;
use crate::state::{now_millis, Linked, LinkedMessage};

/// One in-flight linked turn. The registry owns the whole `Child`; `start_kill()`
/// is a synchronous non-blocking SIGKILL.
struct LinkedProc {
    child: Child,
}

type LinkedRegistry = Arc<Mutex<HashMap<String, LinkedProc>>>;

/// Registry of running linked turns, keyed by `linked_id`. Cloned into managed
/// Tauri state. The `std::sync::Mutex` is only ever held for a tiny
/// `lock → mutate → drop` critical section, never across `.await`.
#[derive(Clone)]
pub struct LinkedState {
    procs: LinkedRegistry,
    db: Arc<Database>,
    /// Absolute path to the `claude` binary, resolved lazily on first use —
    /// same TCC reasoning as `browse::BrowseState`.
    claude_bin: Arc<OnceLock<String>>,
}

impl LinkedState {
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

    /// Kill every running linked turn. Backs `linked_kill_all` and teardown.
    pub fn kill_all(&self) {
        let drained: Vec<LinkedProc> = {
            let mut guard = self.procs.lock().unwrap();
            guard.drain().map(|(_, p)| p).collect()
        };
        for mut proc in drained {
            let _ = proc.child.start_kill();
        }
    }

    /// "Check in with a colleague" for the Companion's `/v1/global/consult`:
    /// run THIS linked discussion to completion with a synthesis-framed
    /// question and return only its digest. Mirrors `BrowseState::consult`;
    /// check-in + digest rows land in the linked thread (untabbed — the
    /// visit isn't tied to any browser tab).
    pub async fn consult(&self, linked_id: String, question: String) -> Result<String, String> {
        if question.trim().is_empty() {
            return Err("nothing to ask the colleague".to_string());
        }
        {
            let guard = self.procs.lock().unwrap();
            if guard.contains_key(&linked_id) {
                return Err(
                    "the linked discussion is busy — try again in a moment".to_string(),
                );
            }
        }
        let prior_session = self.db.get_linked_session(&linked_id);

        let check_in = LinkedMessage {
            id: uuid::Uuid::new_v4().to_string(),
            linked_id: linked_id.clone(),
            role: "user".to_string(),
            body: format!("🧭 Companion checking in — {}", question.trim()),
            status: "complete".to_string(),
            tab_browse_id: None,
            tab_n: None,
            tab_title: None,
            tab_url: None,
            created_at: now_millis(),
        };
        if let Err(e) = self.db.insert_linked_message(&check_in) {
            tracing::warn!(error = %e, "failed to persist consult check-in");
        }

        let framed = format!(
            "The user's COMPANION — their global cross-surface discussion — is \
             checking in with you about THIS linked discussion. Synthesize what \
             matters here for their question as a tight DIGEST (not a \
             transcript, not a fresh reply to the user). Be concise. Their \
             question:\n\n{}",
            question.trim()
        );
        let prompt = match &prior_session {
            None => build_first_turn_prompt(&TabContext::default(), None, &framed, None),
            Some(_) => framed.clone(),
        };
        crate::ledger::register_agent_prompt(&crate::ledger::body_hash(&prompt));

        let args = bridge_args(prompt, prior_session.as_deref());
        let cwd = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
        let claude_bin = self.claude_bin().await?;
        let mut cmd = claude_command(&claude_bin);
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
                .insert(linked_id.clone(), LinkedProc { child });
        }

        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(180),
            crate::claude_proc::collect_turn(stdout, stderr),
        )
        .await;
        let proc = { self.procs.lock().unwrap().remove(&linked_id) };
        let outcome = match outcome {
            Ok(o) => o,
            Err(_) => {
                if let Some(mut p) = proc {
                    let _ = p.child.start_kill();
                }
                return Err("the colleague took too long to respond".to_string());
            }
        };
        if let Some(mut p) = proc {
            let _ = p.child.wait().await;
        }
        if let Some(err) = outcome.errored {
            return Err(err);
        }
        let Some(text) = outcome.final_text.filter(|t| !t.trim().is_empty()) else {
            return Err("the colleague produced no reply".to_string());
        };
        if let Some(sid) = &outcome.session {
            let _ = self.db.set_linked_session(&linked_id, sid);
        }
        let reply = LinkedMessage {
            id: uuid::Uuid::new_v4().to_string(),
            linked_id: linked_id.clone(),
            role: "assistant".to_string(),
            body: text.clone(),
            status: "complete".to_string(),
            tab_browse_id: None,
            tab_n: None,
            tab_title: None,
            tab_url: None,
            created_at: now_millis(),
        };
        if let Err(e) = self.db.insert_linked_message(&reply) {
            tracing::warn!(error = %e, "failed to persist consult reply");
        }
        Ok(text)
    }
}

// --- Event payloads --------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LinkedDelta {
    linked_id: String,
    text: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LinkedDone {
    linked_id: String,
    message_id: String,
    body: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LinkedError {
    linked_id: String,
    error: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LinkedCancelled {
    linked_id: String,
}

/// The tab the user is on for a given turn. Only the number (`n`, its 1-based
/// position in the tab strip — what the user sees) is named to the agent; the
/// `browse_id` is durable state the UI carries but the prompt never mentions,
/// matching the browse/mission "address tabs by number" convention.
#[derive(Debug, Clone, Default)]
struct TabContext {
    n: Option<i64>,
    title: String,
    url: String,
}

impl TabContext {
    /// A one-line "you are on tab N — Title (url)" descriptor, tolerant of
    /// missing pieces (a fresh tab may have no title yet).
    fn describe(&self) -> String {
        let title = self.title.trim();
        let url = self.url.trim();
        match (self.n, title.is_empty(), url.is_empty()) {
            (Some(n), false, false) => format!("tab {n} — {title} ({url})"),
            (Some(n), true, false) => format!("tab {n} — {url}"),
            (Some(n), false, true) => format!("tab {n} — {title}"),
            (Some(n), true, true) => format!("tab {n}"),
            (None, false, false) => format!("{title} ({url})"),
            (None, true, false) => url.to_string(),
            (None, false, true) => title.to_string(),
            (None, true, true) => "a browser tab".to_string(),
        }
    }
}

/// The first turn's prompt: the spanning-conversation role, the current tab, the
/// live snapshot for grounding, the cross-tab read routes, the CONSULT mechanism
/// (how to check in with a colleague), and the user's message. Follow-up turns
/// re-ground on the current tab (`build_followup_prompt`) since it changes.
fn build_first_turn_prompt(
    tab: &TabContext,
    snapshot: Option<&str>,
    user_text: &str,
    mission: Option<(&str, &str)>,
) -> String {
    let mut p = String::from(
        "You are ONE continuous discussion that follows the user across the tabs \
         of Redline's embedded browser. Unlike a page discussion (bound to one \
         tab) or a mission (bound to one goal), you have NO fixed goal — you are a \
         spanning conversation. Each turn tells you which tab the user is \
         currently on; weave the thread across tabs as they move, referring back \
         to what you saw on earlier tabs by number and title.\n\n",
    );
    // A linked discussion has no goal of its OWN, but it can still run inside an
    // active mission — when it does, orient the spanning conversation to that goal.
    p.push_str(&mission_context_block(mission));
    p.push_str(&format!(
        "The user is currently on {}.\n\n",
        tab.describe()
    ));
    if let Some(snap) = snapshot {
        if !snap.trim().is_empty() {
            p.push_str("Here is a snapshot of that tab right now:\n\n");
            p.push_str(snap.trim());
            p.push_str("\n\n");
        }
    }
    p.push_str(
        "You can see and read across every open tab by calling these local \
         endpoints with curl (already permitted — no approval needed). Put the \
         URL immediately after `-s`:\n\n\
         - List every open tab — your map of the user's browse. Each has a number \
         `n` (its position in the tab strip, what the USER sees), plus url, \
         title, and which is active:\n  \
         curl -s http://127.0.0.1:7676/v1/browser/tabs\n\
         - Glance at a tab's live page (url, title, selection, text, headings, \
         links) WITHOUT moving the user's focus:\n  \
         curl -s 'http://127.0.0.1:7676/v1/browser/snapshot?tab=<n>'\n\
         - Read what was already discussed on a tab (the cheap way to absorb a \
         thread):\n  \
         curl -s 'http://127.0.0.1:7676/v1/browser/thread?tab=<n>'\n\
         - Open a URL in a NEW tab (leaves the user's tabs open):\n  \
         curl -s http://127.0.0.1:7676/v1/browser/open -X POST \
         -H 'Content-Type: application/json' -d '{\"url\":\"https://example.com\"}'\n\
         - Switch the user INTO a tab (only when they want to BE there):\n  \
         curl -s 'http://127.0.0.1:7676/v1/browser/focus?tab=<n>' -X POST\n\n\
         Reading a tab by `?tab=<n>` is like glancing at a neighbour's screen — it \
         does NOT move the user's current tab. Tab numbers are positional and \
         shift as tabs open/close, so re-read /tabs for the current mapping each \
         task rather than remembering a number across turns. Name a tab to the \
         user by its NUMBER and title (e.g. \"tab 2 — example.com\"), never an id.\n\n\
         CHECK IN WITH A COLLEAGUE. When synthesizing a tab's material gets heavy, \
         don't re-derive it yourself — that tab has its OWN page-discussion agent \
         holding its full thread. Ask it to synthesize, and only its digest comes \
         back to you (you stay light). Call:\n  \
         curl -s http://127.0.0.1:7676/v1/linked/consult -X POST \
         -H 'Content-Type: application/json' \
         -d '{\"tab\":\"<n>\",\"question\":\"<what you need synthesized from that tab>\"}'\n\
         The response is JSON {\"digest\":\"...\",\"n\":<n>,\"title\":\"...\"}. Fold the \
         digest into your reply; do NOT paste the tab's raw thread. Rule of thumb: \
         a GLANCE (a fact, a title, a link) you do yourself with /snapshot?tab= or \
         /thread?tab=; a SYNTHESIS of a deep tab you DELEGATE via /consult. \
         Consulting runs a real turn in that tab's own discussion (so it shows up \
         there) — use it when it earns its keep, not for every mention. If a \
         consult replies that the tab is busy, that means retry-or-glance, not \
         failure.\n\n\
         You also have WebSearch and WebFetch (already permitted): WebSearch to \
         look something up, WebFetch to pull a specific URL — to verify a claim or \
         fill a gap — rather than driving the user's tabs to a search engine.\n\n\
         Follow the `linked` skill for the spanning-conversation discipline, when \
         to check in with a colleague, and how to format your reply (tables, \
         strict-mode mermaid only, never raw HTML). Respond directly and \
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

/// A follow-up turn: the resumed session already carries the role, the routes,
/// and the consult contract, but MUST be re-told the current tab (it changes as
/// the user browses) and gets a fresh snapshot to ground on.
fn build_followup_prompt(tab: &TabContext, snapshot: Option<&str>, user_text: &str) -> String {
    let mut p = format!("The user is now on {}.\n\n", tab.describe());
    if let Some(snap) = snapshot {
        if !snap.trim().is_empty() {
            p.push_str("Snapshot of that tab right now:\n\n");
            p.push_str(snap.trim());
            p.push_str("\n\n");
        }
    }
    p.push_str("The user says:\n");
    for line in user_text.lines() {
        p.push_str("> ");
        p.push_str(line);
        p.push('\n');
    }
    p
}

// --- CRUD commands ---------------------------------------------------------

/// Create a new linked discussion and return it. No goal is required — a linked
/// discussion is just a spanning conversation, so the frontend opens the chat
/// immediately after.
#[tauri::command]
pub fn linked_create(
    linked: tauri::State<'_, LinkedState>,
    title: Option<String>,
) -> Result<Linked, String> {
    let now = now_millis();
    let title = title
        .map(|t| t.trim().chars().take(80).collect::<String>())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "Linked discussion".to_string());
    let l = Linked {
        linked_id: uuid::Uuid::new_v4().to_string(),
        title,
        status: "active".to_string(),
        created_at: now,
        updated_at: now,
    };
    linked
        .db
        .insert_linked(&l)
        .map_err(|e| format!("failed to create linked discussion: {e}"))?;
    Ok(l)
}

/// All linked discussions, active/newest first — for the start/switch/resume menu.
#[tauri::command]
pub fn linked_list(linked: tauri::State<'_, LinkedState>) -> Result<Vec<Linked>, String> {
    linked
        .db
        .list_linked()
        .map_err(|e| format!("failed to list linked discussions: {e}"))
}

/// Load a linked discussion's persisted turns, oldest first.
#[tauri::command]
pub fn linked_get_thread(
    linked: tauri::State<'_, LinkedState>,
    linked_id: String,
) -> Result<Vec<LinkedMessage>, String> {
    linked
        .db
        .load_linked_thread(&linked_id)
        .map_err(|e| format!("failed to load thread: {e}"))
}

/// Save a linked discussion's tab workspace (the tabs it has spanned), so
/// re-entering it can reopen them. Reuses the mission tab shape.
#[tauri::command]
pub fn linked_set_tabs(
    linked: tauri::State<'_, LinkedState>,
    linked_id: String,
    tabs: Vec<crate::mission::MissionTab>,
) -> Result<(), String> {
    let json = serde_json::to_string(&tabs).map_err(|e| format!("failed to encode tabs: {e}"))?;
    linked
        .db
        .set_linked_tabs(&linked_id, &json)
        .map_err(|e| format!("failed to save linked tabs: {e}"))
}

/// A linked discussion's saved tabs (empty if none saved yet).
#[tauri::command]
pub fn linked_get_tabs(
    linked: tauri::State<'_, LinkedState>,
    linked_id: String,
) -> Result<Vec<crate::mission::MissionTab>, String> {
    match linked.db.get_linked_tabs(&linked_id) {
        Some(json) => {
            serde_json::from_str(&json).map_err(|e| format!("failed to decode linked tabs: {e}"))
        }
        None => Ok(Vec::new()),
    }
}

/// Hard-delete a linked discussion (its chat only — a consult's turns live in the
/// tabs' own browse threads, which the user may still want).
#[tauri::command]
pub fn linked_delete(
    linked: tauri::State<'_, LinkedState>,
    linked_id: String,
) -> Result<(), String> {
    let proc = { linked.procs.lock().unwrap().remove(&linked_id) };
    if let Some(mut proc) = proc {
        let _ = proc.child.start_kill();
    }
    linked
        .db
        .delete_linked(&linked_id)
        .map_err(|e| format!("failed to delete linked discussion: {e}"))
}

// --- Chat commands ---------------------------------------------------------

/// Send a turn to a linked discussion. The first turn starts a fresh `claude`
/// session (capturing its id); later turns resume it. Every turn is tab-tagged
/// with the tab the user is currently on. Streaming happens via `linked-*`
/// events — this returns as soon as the child is spawned.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn linked_send(
    linked: tauri::State<'_, LinkedState>,
    active_mission: tauri::State<'_, crate::ActiveMission>,
    active_surface: tauri::State<'_, crate::ActiveSurface>,
    app: AppHandle,
    linked_id: String,
    text: String,
    tab_n: Option<i64>,
    tab_browse_id: Option<String>,
    tab_url: Option<String>,
    tab_title: Option<String>,
    snapshot: Option<String>,
    cwd: Option<String>,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("empty message".to_string());
    }

    // Reject a second concurrent turn for the same discussion.
    {
        let guard = linked.procs.lock().unwrap();
        if guard.contains_key(&linked_id) {
            return Err("the linked discussion is still replying".to_string());
        }
    }

    let prior_session = linked.db.get_linked_session(&linked_id);

    let tab = TabContext {
        n: tab_n,
        title: tab_title.clone().unwrap_or_default(),
        url: tab_url.clone().unwrap_or_default(),
    };

    // Persist the user turn WITH its tab tag, so the UI can show which tab each
    // message was on.
    let user_msg = LinkedMessage {
        id: uuid::Uuid::new_v4().to_string(),
        linked_id: linked_id.clone(),
        role: "user".to_string(),
        body: text.clone(),
        status: "complete".to_string(),
        tab_browse_id: tab_browse_id.clone(),
        tab_n,
        tab_title: tab_title.clone(),
        tab_url: tab_url.clone(),
        created_at: now_millis(),
    };
    linked
        .db
        .insert_linked_message(&user_msg)
        .map_err(|e| format!("failed to persist message: {e}"))?;

    // First turn embeds the role + snapshot + routes + consult docs; follow-ups
    // re-ground on the current tab (which changed since the last turn). When a
    // mission is active, the first turn also bakes in its goal.
    let mission = active_mission.active_goal();
    let prompt = match &prior_session {
        None => build_first_turn_prompt(
            &tab,
            snapshot.as_deref(),
            &text,
            mission.as_ref().map(|(t, g)| (t.as_str(), g.as_str())),
        ),
        Some(_) => build_followup_prompt(&tab, snapshot.as_deref(), &text),
    };

    // Polis ledger: record the first-turn linked-discussion prompt WITH its
    // thread provenance + session-tree link (a linked discussion created while
    // a mission is active hangs under that mission; else root — tab-level
    // parents would be wrong for a spanning thread); keep every agent turn out
    // of the global-hook capture stream.
    if prior_session.is_none() {
        let surface = active_surface.kind_and_id();
        let parent = crate::ledger::resolve_parent(
            None,
            active_mission.active_id().as_deref(),
            surface.as_ref().map(|(k, i)| (k.as_str(), i.as_str())),
            "linked",
        );
        if let Some((pk, pid)) = &parent {
            let _ = crate::ledger::record_session_link(&linked.db, "linked", &linked_id, pk, pid);
        }
        crate::ledger::record_agent_prompt(
            &linked.db,
            crate::ledger::PromptSource::RustFirstTurn,
            "linked",
            &prompt,
            cwd.clone(),
            None,
            None,
            Some(crate::ledger::ThreadRef {
                thread_kind: "linked",
                thread_id: linked_id.clone(),
                parent_session_id: parent
                    .filter(|(pk, _)| pk == "session")
                    .map(|(_, pid)| pid),
            }),
        );
    } else {
        crate::ledger::register_agent_prompt(&crate::ledger::body_hash(&prompt));
    }

    let args = bridge_args(prompt, prior_session.as_deref());

    let cwd = cwd
        .filter(|c| !c.trim().is_empty())
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| "/".to_string());

    let claude_bin = linked.claude_bin().await?;
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
        linked
            .procs
            .lock()
            .unwrap()
            .insert(linked_id.clone(), LinkedProc { child });
    }
    tauri::async_runtime::spawn(read_linked(
        app,
        linked.db.clone(),
        linked.procs.clone(),
        linked_id,
        tab,
        tab_browse_id,
        stdout,
        stderr,
    ));
    Ok(())
}

/// Kill the in-flight turn for a linked discussion, if any.
#[tauri::command]
pub fn linked_cancel(
    linked: tauri::State<'_, LinkedState>,
    linked_id: String,
) -> Result<(), String> {
    let proc = { linked.procs.lock().unwrap().remove(&linked_id) };
    if let Some(mut proc) = proc {
        let _ = proc.child.start_kill();
    }
    Ok(())
}

/// Kill every running linked turn — also invoked on app teardown.
#[tauri::command]
pub fn linked_kill_all(linked: tauri::State<'_, LinkedState>) -> Result<(), String> {
    linked.kill_all();
    Ok(())
}

// --- Streaming reader ------------------------------------------------------

/// Drive one linked turn: stream stdout JSONL → `linked-delta` events, then reap
/// the child and emit a terminal `linked-done` / `linked-error` /
/// `linked-cancelled`. Mirrors `mission::read_mission`. The assistant row is
/// tagged with the same tab as the user turn that prompted it.
#[allow(clippy::too_many_arguments)]
async fn read_linked(
    app: AppHandle,
    db: Arc<Database>,
    procs: LinkedRegistry,
    linked_id: String,
    tab: TabContext,
    tab_browse_id: Option<String>,
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
                        "linked-delta",
                        LinkedDelta {
                            linked_id: linked_id.clone(),
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

    let proc = { procs.lock().unwrap().remove(&linked_id) };
    let cancelled = proc.is_none() && final_text.is_none();
    let exit_ok = match proc {
        Some(mut p) => p.child.wait().await.map(|s| s.success()).unwrap_or(false),
        None => false,
    };

    if cancelled {
        let _ = app.emit("linked-cancelled", LinkedCancelled { linked_id });
        return;
    }
    if let Some(err) = errored {
        finish_error(&app, &db, &linked_id, &tab, &tab_browse_id, &err);
        return;
    }
    if let Some(text) = final_text {
        if text.trim().is_empty() {
            finish_error(
                &app,
                &db,
                &linked_id,
                &tab,
                &tab_browse_id,
                "claude produced an empty reply",
            );
            return;
        }
        if let Some(sid) = &session {
            if let Err(e) = db.set_linked_session(&linked_id, sid) {
                tracing::warn!(error = %e, "failed to persist linked session id");
            }
        }
        let msg = LinkedMessage {
            id: uuid::Uuid::new_v4().to_string(),
            linked_id: linked_id.clone(),
            role: "assistant".to_string(),
            body: text.clone(),
            status: "complete".to_string(),
            tab_browse_id: tab_browse_id.clone(),
            tab_n: tab.n,
            tab_title: some_nonempty(&tab.title),
            tab_url: some_nonempty(&tab.url),
            created_at: now_millis(),
        };
        if let Err(e) = db.insert_linked_message(&msg) {
            tracing::warn!(error = %e, "failed to persist assistant message");
        }
        // Companion journal: the linked discussion completed a turn.
        let _ = db.append_journal("agent_turn", Some("linked"), Some(&linked_id), None, None);
        let _ = app.emit(
            "linked-done",
            LinkedDone {
                linked_id,
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
    finish_error(&app, &db, &linked_id, &tab, &tab_browse_id, &why);
}

/// `Some(trimmed)` when non-empty, else `None` — for the nullable tab-tag columns.
fn some_nonempty(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

/// Persist a failed turn as a terminal `error` row and emit `linked-error`.
fn finish_error(
    app: &AppHandle,
    db: &Database,
    linked_id: &str,
    tab: &TabContext,
    tab_browse_id: &Option<String>,
    error: &str,
) {
    let msg = LinkedMessage {
        id: uuid::Uuid::new_v4().to_string(),
        linked_id: linked_id.to_string(),
        role: "assistant".to_string(),
        body: error.to_string(),
        status: "error".to_string(),
        tab_browse_id: tab_browse_id.clone(),
        tab_n: tab.n,
        tab_title: some_nonempty(&tab.title),
        tab_url: some_nonempty(&tab.url),
        created_at: now_millis(),
    };
    if let Err(e) = db.insert_linked_message(&msg) {
        tracing::warn!(error = %e, "failed to persist error linked message");
    }
    let _ = app.emit(
        "linked-error",
        LinkedError {
            linked_id: linked_id.to_string(),
            error: error.to_string(),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab(n: i64, title: &str, url: &str) -> TabContext {
        TabContext {
            n: Some(n),
            title: title.to_string(),
            url: url.to_string(),
        }
    }

    #[test]
    fn first_turn_prompt_embeds_tab_snapshot_consult_and_routes() {
        let p = build_first_turn_prompt(
            &tab(2, "Example", "https://example.com"),
            Some(r#"{"url":"https://example.com","title":"Example"}"#),
            "Compare this with the last tab.",
            None,
        );
        // Current tab + user text present.
        assert!(p.contains("tab 2 — Example (https://example.com)"));
        assert!(p.contains("Compare this with the last tab."));
        // With no active mission, no mission block is injected.
        assert!(!p.contains("A research MISSION is currently active"));
        // Snapshot woven in.
        assert!(p.contains("\"title\":\"Example\""));
        // The consult mechanism + cross-tab read routes are documented.
        assert!(p.contains("/v1/linked/consult"));
        assert!(p.contains("/v1/browser/tabs"));
        assert!(p.contains("/v1/browser/thread?tab=<n>"));
        assert!(p.contains("/v1/browser/snapshot?tab=<n>"));
        // The spanning-conversation framing.
        assert!(p.contains("follows the user across the tabs"));
    }

    #[test]
    fn followup_prompt_regrounds_on_current_tab() {
        let p = build_followup_prompt(
            &tab(3, "Docs", "https://docs.example.com"),
            None,
            "What about here?",
        );
        // Re-grounds on the new tab and carries the user text...
        assert!(p.contains("now on tab 3 — Docs (https://docs.example.com)"));
        assert!(p.contains("What about here?"));
        // ...but does NOT repeat the full role preamble or consult docs (the
        // resumed session already holds them).
        assert!(!p.contains("/v1/linked/consult"));
        assert!(!p.contains("follows the user across the tabs"));
    }

    #[test]
    fn first_turn_without_snapshot_still_documents_consult() {
        let p = build_first_turn_prompt(&tab(1, "", ""), None, "hi", None);
        assert!(p.contains("hi"));
        assert!(p.contains("/v1/linked/consult"));
        assert!(p.contains("The user is currently on tab 1."));
        // No empty snapshot header when there's no snapshot.
        assert!(!p.contains("snapshot of that tab right now"));
    }

    #[test]
    fn first_turn_prompt_embeds_active_mission_goal() {
        let p = build_first_turn_prompt(
            &tab(1, "Example", "https://example.com"),
            None,
            "Find the best sources for me.",
            Some(("Data-breach page", "Draft my firm's data-breach practice page")),
        );
        // The mission goal is baked into the spanning conversation.
        assert!(p.contains("A research MISSION is currently active"));
        assert!(p.contains("Draft my firm's data-breach practice page"));
        assert!(p.contains("/v1/mission/active"));
        // The spanning-conversation framing is still present.
        assert!(p.contains("follows the user across the tabs"));
    }
}
