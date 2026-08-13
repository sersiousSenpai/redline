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

use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{ChildStderr, ChildStdout};

use crate::claude_proc::{
    bridge_args, classify_line, mission_context_block, resolve_claude_bin,
    StreamLine,
};
use crate::db::Database;
use crate::state::{now_millis, Linked, LinkedMessage};
use crate::turn::{self, PartialBuf, QueuedTurn, SendOutcome, SendSlot, TurnStatus, Turns};

/// Everything a queued linked send needs to start later. The resume state and
/// prompt framing are resolved at START time (`start_linked_turn`) — a
/// drained turn must resume the session the turn ahead of it just
/// established. The tab tag and snapshot ARE captured at enqueue time: they
/// describe the tab the user was on when they typed.
pub struct QueuedLinkedSend {
    text: String,
    tab_n: Option<i64>,
    tab_browse_id: Option<String>,
    tab_url: Option<String>,
    tab_title: Option<String>,
    snapshot: Option<String>,
    cwd: Option<String>,
}

/// Registry of running linked turns, keyed by `linked_id`, on the shared
/// `turn::Turns` contract (atomic slot reservation + probeable partial
/// buffer). Cloned into managed Tauri state.
#[derive(Clone)]
pub struct LinkedState {
    turns: Arc<Turns<QueuedLinkedSend>>,
    db: Arc<Database>,
    /// Absolute path to the `claude` binary, resolved lazily on first use —
    /// same TCC reasoning as `browse::BrowseState`.
    claude_bin: Arc<OnceLock<String>>,
}

impl LinkedState {
    pub fn new(db: Arc<Database>) -> Self {
        Self {
            turns: Arc::new(Turns::new()),
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

    /// Whether a linked turn is streaming for this discussion. Feeds the
    /// Companion's `/v1/global/agents` busy flag.
    pub fn is_running(&self, linked_id: &str) -> bool {
        self.turns.is_running(linked_id)
    }

    /// Kill every running linked turn. Backs `linked_kill_all` and teardown.
    pub fn kill_all(&self) {
        self.turns.kill_all();
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
        // Atomic reservation; early `?` returns release it via the guard's Drop.
        let slot = self.turns.begin(&linked_id).map_err(|_| {
            "the linked discussion is busy — try again in a moment".to_string()
        })?;
        let resume = resume_state(&self.db, &linked_id);

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
        let prompt = match &resume {
            ResumeState::Resume(_) => framed.clone(),
            ResumeState::ForkFrom(_, origin) => build_first_turn_prompt(
                &TabContext::default(),
                None,
                &framed,
                None,
                Some(origin.as_deref().unwrap_or("a tab's page discussion")),
            ),
            ResumeState::Fresh => {
                build_first_turn_prompt(&TabContext::default(), None, &framed, None, None)
            }
        };
        crate::ledger::register_agent_prompt(&crate::ledger::body_hash(&prompt));

        let args = args_for(prompt, &resume);
        let cwd = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
        let claude_bin = self.claude_bin().await?;
        let mut cmd = crate::claude_proc::claude_command_for_seat("linked", &claude_bin);
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
        let token = slot.token();
        if let Err(mut child) = slot.attach(child) {
            // Cancelled during the spawn window — the reservation is gone.
            let _ = child.start_kill();
            return Err("the consult was cancelled".to_string());
        }

        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(180),
            crate::claude_proc::collect_turn(stdout, stderr),
        )
        .await;
        // Token-matched: a consult draining its stream after a cancel must
        // not reap a successor turn started in the meantime.
        let proc = self.turns.take_owned(&linked_id, token).and_then(|p| p.child);
        let outcome = match outcome {
            Ok(o) => o,
            Err(_) => {
                if let Some(mut child) = proc {
                    let _ = child.start_kill();
                }
                let _ = self.db.record_friction(
                    "turn_timeout",
                    Some("linked"),
                    Some(&linked_id),
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
    /// This delta's position in the turn's stream — `linked_turn_status`
    /// reports the seq already folded into `partial`, and the frontend drops
    /// any delta at or below that watermark.
    seq: u64,
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

/// A queued send left the queue and became the streaming turn — the frontend
/// flips its bubble's "Queued" chip off.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LinkedQueueAdvanced {
    linked_id: String,
    message_id: String,
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
/// `converted_from` is the origin descriptor when this discussion was converted
/// from a per-tab chat — the spawn `--resume`s that chat's session with
/// `--fork-session`, so the model already holds the tab conversation and must
/// be told its role now widens rather than re-introduced from scratch.
fn build_first_turn_prompt(
    tab: &TabContext,
    snapshot: Option<&str>,
    user_text: &str,
    mission: Option<(&str, &str)>,
    converted_from: Option<&str>,
) -> String {
    let mut p = String::new();
    if let Some(origin) = converted_from {
        p.push_str(&format!(
            "This session RESUMES your page discussion on {origin} — the user \
             chose to continue that conversation as a LINKED discussion, so \
             everything you discussed there carries forward. Your role now \
             WIDENS: from this turn on you span ALL the user's tabs, not just \
             that page.\n\n"
        ));
    }
    // CACHE-STABLE ORDERING — after the (fork-only) continuation note, ALL
    // invariant text (role intro, routes, consult contract, skill reference)
    // forms one stable prefix; every variable section (mission, current tab,
    // snapshot, user text) comes after it. Same information, pinned order —
    // two fresh first turns share a byte-identical cacheable prefix. Guarded
    // by `first_turn_invariant_prefix_is_byte_stable`.
    p.push_str(
        "You are ONE continuous discussion that follows the user across the tabs \
         of Redline's embedded browser. Unlike a page discussion (bound to one \
         tab) or a mission (bound to one goal), you have NO fixed goal — you are a \
         spanning conversation. Each turn tells you which tab the user is \
         currently on; weave the thread across tabs as they move, referring back \
         to what you saw on earlier tabs by number and title.\n\n",
    );
    p.push_str(
        "You can see and read across every open tab by calling these local \
         endpoints with curl (already permitted — no approval needed). Put the \
         URL immediately after `-s`. Write routes need the bearer token: add \
         `--variable %REDLINE_DAEMON_TOKEN= --expand-header \"Authorization: \
         Bearer {{REDLINE_DAEMON_TOKEN}}\"` after the URL, which imports it \
         straight from the environment — never write `$REDLINE_DAEMON_TOKEN` \
         into the command yourself (requires curl >= 8.3):\n\n\
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
         curl -s http://127.0.0.1:7676/v1/browser/open \
         --variable %REDLINE_DAEMON_TOKEN= \
         --expand-header \"Authorization: Bearer {{REDLINE_DAEMON_TOKEN}}\" -X POST \
         -H 'Content-Type: application/json' -d '{\"url\":\"https://example.com\"}'\n\
         - Switch the user INTO a tab (only when they want to BE there):\n  \
         curl -s 'http://127.0.0.1:7676/v1/browser/focus?tab=<n>' \
         --variable %REDLINE_DAEMON_TOKEN= \
         --expand-header \"Authorization: Bearer {{REDLINE_DAEMON_TOKEN}}\" -X POST\n\n\
         Reading a tab by `?tab=<n>` is like glancing at a neighbour's screen — it \
         does NOT move the user's current tab. Tab numbers are positional and \
         shift as tabs open/close, so re-read /tabs for the current mapping each \
         task rather than remembering a number across turns. Name a tab to the \
         user by its NUMBER and title (e.g. \"tab 2 — example.com\"), never an id.\n\n\
         CHECK IN WITH A COLLEAGUE. When synthesizing a tab's material gets heavy, \
         don't re-derive it yourself — that tab has its OWN page-discussion agent \
         holding its full thread. Ask it to synthesize, and only its digest comes \
         back to you (you stay light). Call:\n  \
         curl -s http://127.0.0.1:7676/v1/linked/consult \
         --variable %REDLINE_DAEMON_TOKEN= \
         --expand-header \"Authorization: Bearer {{REDLINE_DAEMON_TOKEN}}\" -X POST \
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
         concisely in markdown.\n\n",
    );
    // --- variable content below; nothing invariant may follow ---
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
    p.push_str("The user says:\n");
    for line in user_text.lines() {
        p.push_str("> ");
        p.push_str(line);
        p.push('\n');
    }
    p
}

/// How a linked turn should attach to a `claude` session: resume the
/// discussion's own established session; FORK the originating browse session
/// (the first turn of a CONVERTED discussion — `--resume <browse sid>
/// --fork-session`, so the tab's own session is untouched); or start fresh.
/// Fork state is retry-safe: it is only reported while `claude_session_id` is
/// still NULL, so a failed first turn re-forks and an established chat never
/// re-forks (see `Database::get_linked_fork_from`).
enum ResumeState {
    Resume(String),
    /// (browse session to fork, human origin descriptor for the prompt)
    ForkFrom(String, Option<String>),
    Fresh,
}

fn resume_state(db: &Database, linked_id: &str) -> ResumeState {
    if let Some(sid) = db.get_linked_session(linked_id) {
        ResumeState::Resume(sid)
    } else if let Some((sid, origin)) = db.get_linked_fork_from(linked_id) {
        ResumeState::ForkFrom(sid, origin)
    } else {
        ResumeState::Fresh
    }
}

/// The arg vector for a linked turn given its resume state — `bridge_args`
/// appends `--resume` last, so the fork flag rides right behind it, exactly
/// like fork.rs does for plan-session forks.
fn args_for(prompt: String, resume: &ResumeState) -> Vec<String> {
    match resume {
        ResumeState::Resume(sid) => bridge_args("linked", prompt, Some(sid)),
        ResumeState::ForkFrom(sid, _) => {
            let mut args = bridge_args("linked", prompt, Some(sid));
            args.push("--fork-session".to_string());
            args
        }
        ResumeState::Fresh => bridge_args("linked", prompt, None),
    }
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

/// Convert a per-tab browse chat into a linked discussion. CONVERSION IS A
/// FORK, NOT A MOVE: the tab's browse thread and `claude_session_id` stay
/// untouched (linked consults still delegate to the tab agent); the linked
/// chat's first turn spawns with `--resume <browse sid> --fork-session`, so
/// the full tab context carries forward while the tab agent is unharmed. The
/// visible history is COPIED into the linked thread (fresh ids, original
/// timestamps, tab-tagged) behind a system divider row. Degrades to a plain
/// create when the tab chat has no session yet — the copied history still
/// carries over visually.
#[tauri::command]
pub fn linked_create_from_browse(
    linked: tauri::State<'_, LinkedState>,
    browse_id: String,
    tab_n: Option<i64>,
    tab_title: Option<String>,
    tab_url: Option<String>,
    title: Option<String>,
) -> Result<Linked, String> {
    let now = now_millis();
    let tab = TabContext {
        n: tab_n,
        title: tab_title.clone().unwrap_or_default(),
        url: tab_url.clone().unwrap_or_default(),
    };
    let title = title
        .map(|t| t.trim().chars().take(80).collect::<String>())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| {
            let t = tab.title.trim();
            if t.is_empty() {
                "Linked discussion".to_string()
            } else {
                format!("Linked — {}", t.chars().take(70).collect::<String>())
            }
        });
    let l = Linked {
        linked_id: uuid::Uuid::new_v4().to_string(),
        title,
        status: "active".to_string(),
        created_at: now,
        updated_at: now,
    };

    let fork_from = linked.db.get_browse_session(&browse_id);
    match &fork_from {
        Some(sid) => linked
            .db
            .insert_linked_converted(&l, &browse_id, &tab.describe(), sid)
            .map_err(|e| format!("failed to create linked discussion: {e}"))?,
        // No session to fork (the tab chat errored before its first reply
        // landed, or was reset) — plain create; history still copies below.
        None => linked
            .db
            .insert_linked(&l)
            .map_err(|e| format!("failed to create linked discussion: {e}"))?,
    }

    // Copy the tab chat's visible history so the linked thread reads as one
    // continuous conversation. Fresh ids (the originals stay in the browse
    // thread), original timestamps, every row tagged with the origin tab.
    let history = linked.db.load_browse_thread(&browse_id).unwrap_or_default();
    for msg in &history {
        let copied = LinkedMessage {
            id: uuid::Uuid::new_v4().to_string(),
            linked_id: l.linked_id.clone(),
            role: msg.role.clone(),
            body: msg.body.clone(),
            status: msg.status.clone(),
            tab_browse_id: Some(browse_id.clone()),
            tab_n,
            tab_title: tab_title.clone().filter(|t| !t.trim().is_empty()),
            tab_url: tab_url.clone().filter(|u| !u.trim().is_empty()),
            created_at: msg.created_at,
        };
        if let Err(e) = linked.db.insert_linked_message(&copied) {
            tracing::warn!(error = %e, "failed to copy a browse message into the linked thread");
        }
    }
    let divider = LinkedMessage {
        id: uuid::Uuid::new_v4().to_string(),
        linked_id: l.linked_id.clone(),
        role: "system".to_string(),
        body: format!("Continued from {}", tab.describe()),
        status: "complete".to_string(),
        tab_browse_id: Some(browse_id.clone()),
        tab_n,
        tab_title: tab_title.clone().filter(|t| !t.trim().is_empty()),
        tab_url: tab_url.clone().filter(|u| !u.trim().is_empty()),
        created_at: now,
    };
    if let Err(e) = linked.db.insert_linked_message(&divider) {
        tracing::warn!(error = %e, "failed to insert the conversion divider row");
    }

    // Session tree: the linked chat is the browse thread's child. Recording it
    // here wins over the first turn's resolve_parent (insert_session_link
    // no-ops once a child is linked) — the browse origin is the truer parent.
    let _ = crate::ledger::record_session_link(&linked.db, "linked", &l.linked_id, "browse", &browse_id);

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
/// tabs' own browse threads, which the user may still want). Queued sends are
/// dropped with it.
#[tauri::command]
pub fn linked_delete(
    linked: tauri::State<'_, LinkedState>,
    linked_id: String,
) -> Result<(), String> {
    if let Some(mut child) = linked.turns.discard(&linked_id).and_then(|p| p.child) {
        let _ = child.start_kill();
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
/// events — this returns as soon as the child is spawned, or with
/// `queued: true` when the send opted in (`queue`) and landed behind an
/// in-flight turn.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn linked_send(
    linked: tauri::State<'_, LinkedState>,
    app: AppHandle,
    linked_id: String,
    text: String,
    tab_n: Option<i64>,
    tab_browse_id: Option<String>,
    tab_url: Option<String>,
    tab_title: Option<String>,
    snapshot: Option<String>,
    cwd: Option<String>,
    queue: Option<bool>,
) -> Result<SendOutcome, String> {
    if text.trim().is_empty() {
        return Err("empty message".to_string());
    }
    let message_id = uuid::Uuid::new_v4().to_string();
    let payload = QueuedLinkedSend {
        text: text.clone(),
        tab_n,
        tab_browse_id: tab_browse_id.clone(),
        tab_url: tab_url.clone(),
        tab_title: tab_title.clone(),
        snapshot,
        cwd,
    };

    // The reservation is atomic and spans the whole spawn; early `?` returns
    // release it via the guard's Drop. Only opted-in sends queue behind a
    // busy slot — the busy error stays for the consult paths.
    let (slot, payload) = if queue.unwrap_or(false) {
        let turn = QueuedTurn {
            message_id: message_id.clone(),
            text: text.clone(),
            queued_at: now_millis(),
        };
        match linked.turns.begin_or_enqueue(&linked_id, turn, payload) {
            SendSlot::Began(slot, payload) => (slot, payload),
            SendSlot::Enqueued => {
                // Persist the queued user row (tab-tagged) so a remount
                // restores the bubble; the reader's drain flips it.
                let user_msg = LinkedMessage {
                    id: message_id.clone(),
                    linked_id,
                    role: "user".to_string(),
                    body: text,
                    status: "queued".to_string(),
                    tab_browse_id,
                    tab_n,
                    tab_title,
                    tab_url,
                    created_at: now_millis(),
                };
                linked
                    .db
                    .insert_linked_message(&user_msg)
                    .map_err(|e| format!("failed to persist message: {e}"))?;
                return Ok(SendOutcome {
                    started: false,
                    queued: true,
                    message_id,
                });
            }
            SendSlot::QueueFull => {
                return Err("the queue is full — wait for the current reply".to_string())
            }
        }
    } else {
        let slot = linked
            .turns
            .begin(&linked_id)
            .map_err(|_| "the linked discussion is still replying".to_string())?;
        (slot, payload)
    };

    // Persist the user turn WITH its tab tag, so the UI can show which tab
    // each message was on.
    let user_msg = LinkedMessage {
        id: message_id.clone(),
        linked_id: linked_id.clone(),
        role: "user".to_string(),
        body: text,
        status: "complete".to_string(),
        tab_browse_id,
        tab_n,
        tab_title,
        tab_url,
        created_at: now_millis(),
    };
    linked
        .db
        .insert_linked_message(&user_msg)
        .map_err(|e| format!("failed to persist message: {e}"))?;

    start_linked_turn(app, linked.inner().clone(), linked_id, payload, slot).await?;
    Ok(SendOutcome {
        started: true,
        queued: false,
        message_id,
    })
}

/// Everything a turn needs after its user row is persisted: prompt framing,
/// ledger capture, spawn, attach, reader. Runs on the direct send path AND on
/// the reader's queue drain — which is why the resume state is read here, at
/// start time. Boxed return: see `turn::BoxStartFuture`.
fn start_linked_turn(
    app: AppHandle,
    linked: LinkedState,
    linked_id: String,
    payload: QueuedLinkedSend,
    slot: turn::SlotGuard<QueuedLinkedSend>,
) -> turn::BoxStartFuture {
    Box::pin(async move {
        let QueuedLinkedSend {
            text,
            tab_n,
            tab_browse_id,
            tab_url,
            tab_title,
            snapshot,
            cwd,
        } = payload;
        // The drain path has no command-injected State params — reach the shared
        // singletons through the app handle instead.
        let active_mission = app.state::<crate::ActiveMission>();
        let active_surface = app.state::<crate::ActiveSurface>();

        let resume = resume_state(&linked.db, &linked_id);
        // A converted discussion's first turn is still a FIRST turn for the ledger
        // and prompt framing — it forks the browse session rather than resuming an
        // established linked one.
        let prior_session = match &resume {
            ResumeState::Resume(sid) => Some(sid.clone()),
            _ => None,
        };

        let tab = TabContext {
            n: tab_n,
            title: tab_title.clone().unwrap_or_default(),
            url: tab_url.clone().unwrap_or_default(),
        };

        // First turn embeds the role + snapshot + routes + consult docs; follow-ups
        // re-ground on the current tab (which changed since the last turn). When a
        // mission is active, the first turn also bakes in its goal. A converted
        // first turn additionally opens with the continuation framing — the forked
        // session already holds the tab conversation.
        let mission = active_mission.active_goal();
        let prompt = match &resume {
            ResumeState::Resume(_) => build_followup_prompt(&tab, snapshot.as_deref(), &text),
            ResumeState::ForkFrom(_, origin) => build_first_turn_prompt(
                &tab,
                snapshot.as_deref(),
                &text,
                mission.as_ref().map(|(t, g)| (t.as_str(), g.as_str())),
                Some(origin.as_deref().unwrap_or("a tab's page discussion")),
            ),
            ResumeState::Fresh => build_first_turn_prompt(
                &tab,
                snapshot.as_deref(),
                &text,
                mission.as_ref().map(|(t, g)| (t.as_str(), g.as_str())),
                None,
            ),
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
                crate::seat::model_for("linked"),
            );
        } else {
            crate::ledger::register_agent_prompt(&crate::ledger::body_hash(&prompt));
        }

        let args = args_for(prompt, &resume);

        let cwd = cwd
            .filter(|c| !c.trim().is_empty())
            .or_else(|| std::env::var("HOME").ok())
            .unwrap_or_else(|| "/".to_string());

        let claude_bin = linked.claude_bin().await?;
        let mut cmd = crate::claude_proc::claude_command_for_seat("linked", &claude_bin);
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

        let buf = slot.buf();
        let token = slot.token();
        if let Err(mut child) = slot.attach(child) {
            // Cancelled during the spawn window.
            let _ = child.start_kill();
            let _ = app.emit("linked-cancelled", LinkedCancelled { linked_id });
            return Ok(());
        }
        tauri::async_runtime::spawn(read_linked(
            app,
            linked,
            buf,
            token,
            linked_id,
            tab,
            tab_browse_id,
            stdout,
            stderr,
        ));
        Ok(())
    })
}

/// Snapshot of this discussion's turn for a remounting LinkedChat: whether a
/// reply is streaming, since when, and the partial text streamed so far (with
/// its delta `seq` watermark).
#[tauri::command]
pub fn linked_turn_status(
    linked: tauri::State<'_, LinkedState>,
    linked_id: String,
) -> TurnStatus {
    linked.turns.status(&linked_id)
}

/// Kill the in-flight turn for a linked discussion, if any. Queued sends stay
/// queued — the reader's terminal drain advances them.
#[tauri::command]
pub fn linked_cancel(
    linked: tauri::State<'_, LinkedState>,
    linked_id: String,
) -> Result<(), String> {
    if let Some(mut child) = linked.turns.take(&linked_id).and_then(|p| p.child) {
        let _ = child.start_kill();
    }
    Ok(())
}

/// Remove a queued send (the bubble's ×). Returns its text so the composer
/// can restore it; `None` when the send already advanced. The persisted
/// queued row goes with it.
#[tauri::command]
pub fn linked_unqueue(
    linked: tauri::State<'_, LinkedState>,
    linked_id: String,
    message_id: String,
) -> Result<Option<String>, String> {
    let Some(turn) = linked.turns.unqueue(&linked_id, &message_id) else {
        return Ok(None);
    };
    if let Err(e) = linked.db.delete_thread_message("linked", &message_id) {
        tracing::warn!(error = %e, "failed to delete the unqueued linked row");
    }
    Ok(Some(turn.text))
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
/// `linked-cancelled`, and drain the send queue. Mirrors `mission::read_mission`.
/// The assistant row is tagged with the same tab as the user turn that
/// prompted it.
#[allow(clippy::too_many_arguments)]
async fn read_linked(
    app: AppHandle,
    linked: LinkedState,
    buf: Arc<Mutex<PartialBuf>>,
    token: u64,
    linked_id: String,
    tab: TabContext,
    tab_browse_id: Option<String>,
    stdout: ChildStdout,
    stderr: ChildStderr,
) {
    let db = linked.db.clone();
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
                    // Append-before-emit: see `turn::push_delta`.
                    let seq = turn::push_delta(&buf, &text);
                    let _ = app.emit(
                        "linked-delta",
                        LinkedDelta {
                            linked_id: linked_id.clone(),
                            text,
                            seq,
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

    // Reap the proc + pop the queue in ONE critical section, BEFORE emitting
    // the terminal event. Token-matched: a reader outliving a cancel must
    // neither steal a successor turn's proc nor drain its queue.
    let (proc, next) = linked.turns.finish_and_pop(&linked_id, token);
    let cancelled = proc.is_none() && final_text.is_none();
    let exit_ok = match proc.and_then(|p| p.child) {
        Some(mut child) => child.wait().await.map(|s| s.success()).unwrap_or(false),
        None => false,
    };

    'terminal: {
        if cancelled {
            let _ = app.emit(
                "linked-cancelled",
                LinkedCancelled {
                    linked_id: linked_id.clone(),
                },
            );
            break 'terminal;
        }
        if let Some(err) = errored {
            let why = describe_turn_error(&db, &linked_id, &err);
            finish_error(&app, &db, &linked_id, &tab, &tab_browse_id, &why);
            break 'terminal;
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
                break 'terminal;
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
                    linked_id: linked_id.clone(),
                    message_id: msg.id,
                    body: text,
                },
            );
            break 'terminal;
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

    // Drain: `finish_and_pop` already re-reserved the slot for the queue
    // head, so no concurrent send can slip in between the terminal above and
    // the start below.
    if let Some((queued, payload, slot)) = next {
        if let Err(e) = db.set_thread_message_status("linked", &queued.message_id, "complete") {
            tracing::warn!(error = %e, "failed to flip a drained linked row");
        }
        let _ = app.emit(
            "linked-queue-advanced",
            LinkedQueueAdvanced {
                linked_id: linked_id.clone(),
                message_id: queued.message_id.clone(),
            },
        );
        // The drained turn's tab tag rides in ITS payload — start_linked_turn
        // rebuilds the TabContext from it, not from this turn's.
        if let Err(e) =
            start_linked_turn(app.clone(), linked.clone(), linked_id.clone(), payload, slot).await
        {
            // The slot released via the guard's Drop. Flip the row so the UI
            // offers "wasn't sent — resend"; no chain-drain (predictable
            // failure behavior beats a cascade).
            let _ = db.set_thread_message_status("linked", &queued.message_id, "unsent");
            finish_error(
                &app,
                &db,
                &linked_id,
                &tab,
                &tab_browse_id,
                &format!("your queued message wasn't sent: {e}"),
            );
        }
    }
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

/// Translate a failed turn's raw error into the message to surface, and
/// recover the discussion where that's the right move. Twin of
/// `browse::describe_turn_error` — a spanning conversation accumulates context
/// fast, and an overflowed session that is never cleared makes every later
/// turn `--resume` the same over-limit context and fail forever.
fn describe_turn_error(db: &Database, linked_id: &str, error: &str) -> String {
    if crate::browse::is_context_overflow(error) {
        if let Err(e) = db.clear_linked_session(linked_id) {
            tracing::warn!(error = %e, "failed to clear over-limit linked session");
        }
        let _ = db.record_friction(
            "context_overflow",
            Some("linked"),
            Some(linked_id),
            Some(error),
        );
        return "This discussion outgrew the model's context window, so the \
                turn failed. I've reset its context — send your message again \
                and I'll re-orient from the open tabs (the replies above are \
                kept)."
            .to_string();
    }
    if crate::browse::is_transient(error) {
        let _ = db.record_friction(
            "transient_fail",
            Some("linked"),
            Some(linked_id),
            Some(error),
        );
        return "The model hit a temporary error on this turn (not something \
                you did) — send your message again in a moment. Your \
                conversation is intact."
            .to_string();
    }
    error.to_string()
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

    #[test]
    fn transient_error_keeps_the_session_overflow_resets_it() {
        let db = Database::open_in_memory().unwrap();
        let l = Linked {
            linked_id: "l-keep".to_string(),
            title: "t".to_string(),
            status: "active".to_string(),
            created_at: 1,
            updated_at: 1,
        };
        db.insert_linked(&l).unwrap();
        // Transient: session preserved, retry message.
        db.set_linked_session("l-keep", "keep-sid").unwrap();
        let msg = describe_turn_error(&db, "l-keep", "error_during_execution");
        assert!(msg.to_lowercase().contains("again"));
        assert_eq!(db.get_linked_session("l-keep").as_deref(), Some("keep-sid"));

        // Explicit overflow: session forgotten so the next turn starts fresh.
        let l2 = Linked {
            linked_id: "l-over".to_string(),
            ..l
        };
        db.insert_linked(&l2).unwrap();
        db.set_linked_session("l-over", "over-sid").unwrap();
        let msg = describe_turn_error(&db, "l-over", "maximum context length exceeded");
        assert!(msg.to_lowercase().contains("reset"));
        assert_eq!(db.get_linked_session("l-over"), None);
    }

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
        let p = build_first_turn_prompt(&tab(1, "", ""), None, "hi", None, None);
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
            None,
        );
        // The mission goal is baked into the spanning conversation.
        assert!(p.contains("A research MISSION is currently active"));
        assert!(p.contains("Draft my firm's data-breach practice page"));
        assert!(p.contains("/v1/mission/active"));
        // The spanning-conversation framing is still present.
        assert!(p.contains("follows the user across the tabs"));
    }

    /// Fresh first turns with different VARIABLE inputs (tab, snapshot,
    /// mission, user text) share a byte-identical prefix spanning the whole
    /// invariant block — the cache-stable ordering contract.
    #[test]
    fn first_turn_invariant_prefix_is_byte_stable() {
        fn common_prefix<'a>(a: &'a str, b: &str) -> &'a str {
            let n = a
                .bytes()
                .zip(b.bytes())
                .take_while(|(x, y)| x == y)
                .count();
            &a[..n]
        }
        let a = build_first_turn_prompt(
            &tab(1, "One", "https://one.example"),
            Some(r#"{"title":"One"}"#),
            "first question",
            None,
            None,
        );
        let b = build_first_turn_prompt(
            &tab(4, "Four", "https://four.example"),
            None,
            "another question entirely",
            Some(("Mission", "a goal")),
            None,
        );
        let shared = common_prefix(&a, &b);
        // The shared prefix must reach the END of the invariant block — the
        // skill reference is its last line.
        assert!(shared.contains("Follow the `linked` skill"));
        assert!(shared.contains("/v1/linked/consult"));
        // And every variable section sits after it.
        assert!(!shared.contains("The user is currently on"));
        assert!(!shared.contains("first question"));
        assert!(!shared.contains("MISSION is currently active"));
    }

    #[test]
    fn converted_first_turn_opens_with_continuation_framing() {
        let p = build_first_turn_prompt(
            &tab(2, "Example", "https://example.com"),
            None,
            "keep going",
            None,
            Some("tab 2 — Example (https://example.com)"),
        );
        // Continuation framing FIRST — the forked session already holds the
        // tab conversation and must be told its role widens, not re-introduced.
        assert!(p.starts_with("This session RESUMES your page discussion"));
        assert!(p.contains("tab 2 — Example (https://example.com)"));
        assert!(p.contains("WIDENS"));
        // The standard spanning role + routes + consult contract still follow.
        assert!(p.contains("follows the user across the tabs"));
        assert!(p.contains("/v1/linked/consult"));
        // A plain first turn has none of it.
        let plain = build_first_turn_prompt(&tab(1, "", ""), None, "hi", None, None);
        assert!(!plain.contains("RESUMES your page discussion"));
    }

    #[test]
    fn conversion_forks_only_until_first_turn_lands() {
        let db = Database::open_in_memory().unwrap();
        let l = Linked {
            linked_id: "l-conv".to_string(),
            title: "Linked — Example".to_string(),
            status: "active".to_string(),
            created_at: 1,
            updated_at: 1,
        };
        db.insert_linked_converted(&l, "b-1", "tab 2 — Example", "browse-sid")
            .unwrap();
        // Before the first turn: fork state present (retry-safe).
        let fork = db.get_linked_fork_from("l-conv");
        assert_eq!(
            fork,
            Some(("browse-sid".to_string(), Some("tab 2 — Example".to_string())))
        );
        // First turn landed → its NEW session id is persisted; never fork again.
        db.set_linked_session("l-conv", "forked-sid").unwrap();
        assert_eq!(db.get_linked_fork_from("l-conv"), None);
        assert_eq!(db.get_linked_session("l-conv").as_deref(), Some("forked-sid"));
        // Overflow recovery clears BOTH columns — a reset chat starts fresh,
        // it must not resurrect the stale browse context.
        db.clear_linked_session("l-conv").unwrap();
        assert_eq!(db.get_linked_fork_from("l-conv"), None);
    }

    #[test]
    fn args_for_fork_resumes_browse_session_with_fork_flag() {
        let args = args_for(
            "p".to_string(),
            &ResumeState::ForkFrom("browse-sid".to_string(), None),
        );
        let resume_at = args.iter().position(|a| a == "--resume").unwrap();
        assert_eq!(args[resume_at + 1], "browse-sid");
        assert_eq!(args[resume_at + 2], "--fork-session");
        // Resume and fresh spawn without the fork flag.
        let args = args_for("p".to_string(), &ResumeState::Resume("sid".to_string()));
        assert!(!args.contains(&"--fork-session".to_string()));
        let args = args_for("p".to_string(), &ResumeState::Fresh);
        assert!(!args.contains(&"--resume".to_string()));
        assert!(!args.contains(&"--fork-session".to_string()));
    }
}
