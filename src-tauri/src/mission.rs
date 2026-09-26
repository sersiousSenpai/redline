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
//! snapshot) plus mission-addressed read routes (`/v1/missions/:id`,
//! `/v1/missions/:id/findings`). The orchestrator's resumable session id lives on the
//! `missions` row, so re-opening a mission resumes its conversation.

use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{ChildStderr, ChildStdout};

use crate::claude_proc::{classify_line, resolve_claude_bin, StreamLine};
use crate::db::Database;
use crate::state::{now_millis, Mission, MissionFinding, MissionMessage};
use crate::turn::{self, PartialBuf, QueuedTurn, SendOutcome, SendSlot, TurnStatus, Turns};

/// Everything a queued orchestrator send needs to start later. The session
/// resume, pin count, and prompt framing are resolved at START time
/// (`start_mission_turn`) — a drained turn must resume the session the turn
/// ahead of it just established, and see the pins as they are THEN.
pub struct QueuedMissionSend {
    text: String,
    cwd: Option<String>,
    synthesize: Option<bool>,
}

/// Registry of running orchestrator turns, keyed by `mission_id`, on the
/// shared `turn::Turns` contract (atomic slot reservation + probeable partial
/// buffer). Cloned into managed Tauri state.
#[derive(Clone)]
pub struct MissionState {
    turns: Arc<Turns<QueuedMissionSend>>,
    pub(crate) db: Arc<Database>,
    /// Absolute path to the `claude` binary, resolved lazily on first use —
    /// same TCC reasoning as `browse::BrowseState`.
    claude_bin: Arc<OnceLock<String>>,
}

impl MissionState {
    pub fn new(db: Arc<Database>) -> Self {
        if let Err(error) = crate::mission_context::recover_interrupted(&db) {
            tracing::error!(%error, "mission recovery failed; subsequent mission operations will report persistence errors");
        }
        Self {
            turns: Arc::new(Turns::new()),
            db,
            claude_bin: Arc::new(OnceLock::new()),
        }
    }

    /// Whether an orchestrator turn is in flight for this mission — lets a
    /// remounted MissionChat restore its streaming indicator instead of
    /// looking idle while a turn quietly runs.
    pub fn turn_active(&self, mission_id: &str) -> bool {
        self.turns.is_running(mission_id)
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
        self.turns.kill_all();
    }

    /// "Check in with a colleague" for the Companion's `/v1/global/consult`:
    /// run THIS mission's orchestrator to completion with a synthesis-framed
    /// question and return only its digest. Mirrors `BrowseState::consult`
    /// (in-flight guard, check-in rows persisted in the mission's own thread,
    /// inline drive behind a 180s ceiling). Whether a turn is running is
    /// checked with the same guard `mission_send` uses, so a user turn and a
    /// consult can never collide.
    pub async fn consult(&self, mission_id: String, question: String) -> Result<String, String> {
        if question.trim().is_empty() {
            return Err("nothing to ask the colleague".to_string());
        }
        // Atomic reservation; early `?` returns release it via the guard's Drop.
        let slot = self
            .turns
            .begin(&mission_id)
            .map_err(|_| "the mission orchestrator is busy — try again in a moment".to_string())?;
        let prior_session = self.db.get_mission_session(&mission_id);

        let check_in = MissionMessage {
            id: uuid::Uuid::new_v4().to_string(),
            mission_id: mission_id.clone(),
            role: "user".to_string(),
            body: format!("🧭 Companion checking in — {}", question.trim()),
            status: "complete".to_string(),
            created_at: now_millis(),
        };
        self.db
            .insert_mission_message(&check_in)
            .map_err(|e| format!("failed to save mission check-in: {e}"))?;

        let framed = format!(
            "The user's COMPANION — their global cross-surface discussion — is \
             checking in with you about THIS mission. Synthesize what matters \
             here for their question as a tight DIGEST (not a transcript, not a \
             fresh reply to the user). Be concise. Their question:\n\n{}",
            question.trim()
        );
        let prompt = match &prior_session {
            None => {
                let m = self
                    .db
                    .get_mission(&mission_id)
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| "mission not found".to_string())?;
                let findings = self
                    .db
                    .list_findings(&mission_id)
                    .map_err(|e| e.to_string())?;
                build_first_turn_prompt(&m.title, &m.goal, &findings, &framed)
            }
            Some(_) => framed.clone(),
        };
        let prompt = scope_prompt(
            &prompt,
            &mission_id,
            &crate::mission_context::resume_context(&self.db, &mission_id)?,
        );
        crate::ledger::register_agent_prompt(&prompt);

        let args = crate::claude_proc::bridge_args("mission", prompt, prior_session.as_deref());
        let cwd = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
        let claude_bin = self.claude_bin().await?;
        let mut cmd = crate::claude_proc::claude_command_for_seat("mission", &claude_bin);
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
            crate::claude_proc::collect_turn_seated(&self.db, "mission", stdout, stderr),
        )
        .await;
        // Token-matched: a consult draining its stream after a cancel must
        // not reap a successor turn started in the meantime.
        let proc = self
            .turns
            .take_owned(&mission_id, token)
            .and_then(|p| p.child);
        let outcome = match outcome {
            Ok(o) => o,
            Err(_) => {
                if let Some(mut child) = proc {
                    let _ = child.start_kill();
                }
                let _ = self.db.record_friction(
                    "turn_timeout",
                    Some("mission"),
                    Some(&mission_id),
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
            self.db
                .set_mission_session(&mission_id, sid)
                .map_err(|e| format!("failed to save resumed mission session: {e}"))?;
        }
        let reply = MissionMessage {
            id: uuid::Uuid::new_v4().to_string(),
            mission_id: mission_id.clone(),
            role: "assistant".to_string(),
            body: text.clone(),
            status: "complete".to_string(),
            created_at: now_millis(),
        };
        self.db
            .insert_mission_message(&reply)
            .map_err(|e| format!("failed to save mission digest: {e}"))?;
        Ok(text)
    }
}

// --- Event payloads --------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MissionDelta {
    mission_id: String,
    text: String,
    /// This delta's position in the turn's stream — `mission_turn_status`
    /// reports the seq already folded into `partial`, and the frontend drops
    /// any delta at or below that watermark.
    seq: u64,
}

/// What the turn is spending and what it is doing. Flattened so the id field
/// the frontend hook matches on stays at the top level, like every other
/// mission event.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MissionMeter {
    mission_id: String,
    #[serde(flatten)]
    meter: turn::MeterPayload,
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

/// A queued send left the queue and became the streaming turn — the frontend
/// flips its bubble's "Queued" chip off.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MissionQueueAdvanced {
    mission_id: String,
    message_id: String,
}

/// The completed reply WAS the synthesis — the brief the Prompt Drafter should
/// open with. Emitted alongside `mission-done`, and listened for at App level
/// (not in MissionChat): the user may have switched surfaces while the
/// orchestrator synthesized, and the handoff must survive that unmount.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MissionSynthesizeDone {
    mission_id: String,
    body: String,
    draft_id: String,
    handoff_id: String,
}

/// Render the current pins as a markdown list for the first-turn prompt. Each
/// pin shows the user's note (their taste signal), where it came from, and the
/// pinned text. Empty when nothing is pinned yet.
fn render_findings(findings: &[MissionFinding]) -> String {
    if findings.is_empty() {
        return String::new();
    }
    let mut s = String::from("The user has pinned these findings so far:\n\n");
    for (i, f) in findings.iter().take(40).enumerate() {
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
    if findings.len() > 40 {
        s.push_str(&format!("{} additional findings remain in the mission's scoped findings endpoint. Retrieve relevant evidence as needed.\n",findings.len()-40));
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
    // CACHE-STABLE ORDERING — ALL invariant text (role intro, tool docs, the
    // skill reference) forms one stable prefix; every variable section (title,
    // goal, pins, user text) comes after it. Same information, pinned order —
    // two missions' first turns share a byte-identical cacheable prefix.
    // Guarded by `first_turn_invariant_prefix_is_byte_stable`.
    let mut p = String::from(
        "You are the ORCHESTRATOR of a research mission in Redline's embedded \
         browser. The user is researching across many browser tabs, each with \
         its own page discussion. Your job is to hold the mission's goal, pull \
         context from every relevant tab and from the user's pinned findings, \
         and weave it toward that goal — comparisons, what works and what to \
         avoid, gaps, and finally a synthesis the user can act on.\n\n",
    );
    p.push_str(
        "You can see and read across the user's tabs by calling these local \
         endpoints with curl (already permitted — no approval needed). Put the \
         URL immediately after `-s`. Write routes need the bearer token: add \
         `--variable %REDLINE_DAEMON_TOKEN= --expand-header \"Authorization: \
         Bearer {{REDLINE_DAEMON_TOKEN}}\"` after the URL, which imports it \
         straight from the environment — never write `$REDLINE_DAEMON_TOKEN` \
         into the command yourself (requires curl >= 8.3):\n\n\
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
         curl -s http://127.0.0.1:7676/v1/browser/open \
         --variable %REDLINE_DAEMON_TOKEN= \
         --expand-header \"Authorization: Bearer {{REDLINE_DAEMON_TOKEN}}\" -X POST \
         -H 'Content-Type: application/json' -d '{\"url\":\"https://example.com\"}'\n\
         - Switch the user INTO a tab (use only when they want to BE there):\n  \
         curl -s 'http://127.0.0.1:7676/v1/browser/focus?tab=<n>' \
         --variable %REDLINE_DAEMON_TOKEN= \
         --expand-header \"Authorization: Bearer {{REDLINE_DAEMON_TOKEN}}\" -X POST\n\n\
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
         - Save a file to disk (defaults to the user's ~/Downloads), then tell \
         them the saved path the route returns. Omit `url` to save the active \
         tab's page; pass `url` for a specific linked file; `dialog:true` lets \
         them choose the location:\n  \
         curl -s http://127.0.0.1:7676/v1/browser/download \
         --variable %REDLINE_DAEMON_TOKEN= \
         --expand-header \"Authorization: Bearer {{REDLINE_DAEMON_TOKEN}}\" -X POST \
         -H 'Content-Type: application/json' -d '{}'\n\
         This `/download` route is the ONLY way you can save a file — `curl -o`, \
         `wget`, and redirecting to a file are auto-denied.\n\n\
         You can also look at the USER'S OWN CODE while they research — \
         Read/Grep/Glob work across all of their projects (already permitted); \
         use absolute paths. Two read-only curl routes help:\n  \
         - List the user's projects (path, name, current git branch):\n    \
         curl -s http://127.0.0.1:7676/v1/code/projects\n  \
         - Inspect a project's git state — READ-ONLY (status/branch/log/diff/show); \
         `repo` must be one of the projects above. Single-quote the URL to protect \
         the shell `?`/`&`:\n    \
         curl -s 'http://127.0.0.1:7676/v1/code/git?repo=<path>&op=log&n=20'\n\
         You can NOT commit, edit, or run any other git — those are auto-denied.\n\n\
         Follow the `mission` skill for how to gather across tabs, weave the \
         pins, and format your reply (comparison tables, what-I-liked / \
         what-I-didn't, a recommended outline; strict-mode mermaid only; never \
         raw HTML). Keep every reply oriented to the goal. Respond directly and \
         concisely in markdown.\n\n",
    );
    // --- variable content below; nothing invariant may follow ---
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

    p.push_str("The user says:\n");
    for line in user_text.lines() {
        p.push_str("> ");
        p.push_str(line);
        p.push('\n');
    }
    p
}

/// The two-line re-grounding header for a resumed orchestrator turn: the pin
/// count changes as the user browses, and a resumed session left to its own
/// devices tends to answer from stale context instead of re-reading the board.
fn build_followup_prompt(pin_count: usize, text: &str) -> String {
    format!(
        "(Mission continues — {pin_count} pin(s) on the board right now. \
         Re-read /v1/mission/findings and /v1/browser/tabs before answering.)\n\n{text}"
    )
}

fn scope_prompt(prompt: &str, mission_id: &str, durable: &str) -> String {
    // Rewrite only tool documentation, never quoted user goals or messages.
    let boundary = prompt
        .find("Mission: ")
        .or_else(|| prompt.find("The mission's goal, in the user's words:"))
        .or_else(|| {
            prompt
                .starts_with("(Mission continues")
                .then(|| prompt.find("\n\n"))
                .flatten()
        })
        .unwrap_or(0);
    let (instructions, user_context) = prompt.split_at(boundary);
    let scoped = instructions
        .replace("/v1/mission/active", &format!("/v1/missions/{mission_id}"))
        .replace(
            "/v1/mission/findings",
            &format!("/v1/missions/{mission_id}/findings"),
        )
        .replace(
            "/v1/browser/tabs",
            &format!("/v1/missions/{mission_id}/tabs"),
        )
        .replace(
            "/v1/browser/open",
            &format!("/v1/missions/{mission_id}/tabs"),
        )
        .replace("?tab=<n>", "?tab=<stable_id>");
    format!("{scoped}{user_context}\n\nMission identity: {mission_id}. Workspace identity: {mission_id}. These identities remain fixed even when the user switches workspaces. Read the mission at GET /v1/missions/{mission_id}, its findings at GET /v1/missions/{mission_id}/findings, and its saved/live tabs at GET /v1/missions/{mission_id}/tabs. Open a source using POST /v1/missions/{mission_id}/tabs with JSON {{\"url\":\"https://example.com\"}}. Never resolve through the globally active mission. Browser operations must carry missionId and workspaceId and a stable tab ID. Re-read the current target before acting; if its workspace is unavailable, use saved evidence or report the recoverable limitation instead of controlling another workspace.\n\nDurable mission checkpoint and confirmed judgments (agent hypotheses are not user decisions):\n{durable}")
}

// --- Mission CRUD commands -------------------------------------------------

/// Create a new mission and return it. The frontend then sets it active
/// (mirroring it to the daemon) and opens the orchestrator chat.
#[tauri::command]
pub async fn mission_create(
    mission: tauri::State<'_, MissionState>,
    app: AppHandle,
    title: String,
    goal: String,
    tabs: Option<Vec<MissionTab>>,
    cwd: Option<String>,
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
        status: "preparing".to_string(),
        created_at: now,
        updated_at: now,
    };
    let text=format!("Begin this research mission now. Establish the relevant sources and a concrete next step, then start investigating the goal: {}",m.goal);
    let encoded = serde_json::to_string(&tabs.unwrap_or_default()).map_err(|e| e.to_string())?;
    crate::mission_context::prepare_mission(&mission.db, &m, &encoded, &text)?;
    let slot = mission
        .turns
        .begin(&m.mission_id)
        .map_err(|_| "mission is already starting")?;
    if let Err(error) = start_mission_turn(
        app.clone(),
        mission.inner().clone(),
        m.mission_id.clone(),
        QueuedMissionSend {
            text,
            cwd,
            synthesize: Some(false),
        },
        slot,
    )
    .await
    {
        // The created workspace stays discoverable and explicitly retryable.
        finish_error(&app, &mission.db, &m.mission_id, &error);
    }
    mission
        .db
        .get_mission(&m.mission_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "mission disappeared after creation".into())
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
    active: tauri::State<'_, crate::ActiveMission>,
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
        .map_err(|e| format!("failed to update mission: {e}"))?;
    // The daemon mirror is id-driven and only re-pushed on identity change —
    // fold the edited goal in here so the orchestrator sees it next turn.
    active.update_goal_if_active(&mission_id, title.trim(), goal.trim());
    Ok(())
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
    let c = mission.db.lock_conn();
    let saved: Option<String> = c
        .query_row(
            "SELECT tabs_json FROM missions WHERE mission_id=?1",
            rusqlite::params![mission_id],
            |r| r.get(0),
        )
        .map_err(|e| format!("failed to load mission workspace: {e}"))?;
    match saved {
        Some(json) => {
            serde_json::from_str(&json).map_err(|e| format!("failed to decode mission tabs: {e}"))
        }
        None => Ok(Vec::new()),
    }
}

/// Hard-delete a mission: kill any in-flight orchestrator turn (and drop its
/// queued sends), purge the saved tabs' discussion threads (keyed by
/// `browse_id`), then the mission row + its pins + orchestrator chat.
#[tauri::command]
pub fn mission_delete(
    mission: tauri::State<'_, MissionState>,
    mission_id: String,
) -> Result<(), String> {
    if let Some(mut child) = mission.turns.discard(&mission_id).and_then(|p| p.child) {
        let _ = child.start_kill();
    }
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
#[tauri::command(async)]
pub fn mission_add_finding(
    app: AppHandle,
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
    crate::mission_context::validate_scope(&mission.db, &mission_id, &mission_id)?;
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
    // Polis ledger: a pinned finding is a curation signal (what you valued).
    let ph = crate::ledger::decision_payload_hash(&[
        ("finding", &f.id),
        ("url", f.source_url.as_deref().unwrap_or("")),
        ("body", &f.body),
    ]);
    {
        let mut c = mission.db.lock_conn();
        let tx = c.transaction().map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO mission_findings(id,mission_id,browse_id,source_url,source_title,body,note,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",rusqlite::params![f.id,f.mission_id,f.browse_id,f.source_url,f.source_title,f.body,f.note,f.created_at]).map_err(|e|format!("failed to pin finding: {e}"))?;
        let author = crate::ledger::local_author();
        polis_store::PolisStore::append_ledger_event_locked(
            &tx,
            &crate::ledger::LedgerAppend {
                kind: "pin",
                author: &author,
                ts: f.created_at,
                prompt_id: None,
                session_id: Some(&f.mission_id),
                version_number: None,
                ref_kind: Some("mission_finding"),
                ref_id: Some(&f.id),
                payload_hash: &ph,
            },
        )
        .map_err(|e| format!("failed to preserve finding provenance: {e}"))?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    // Companion journal: the user pinned a finding.
    let _ = mission.db.append_journal(
        "mission_pin",
        Some("browser"),
        Some(&f.mission_id),
        f.source_title.as_deref(),
        f.source_url.as_deref(),
    );
    if let (Some(browse_id), Some(url)) = (&f.browse_id, &f.source_url) {
        crate::mission_capture::capture_event(
            app, mission.db.clone(), f.mission_id.clone(), format!("t-{browse_id}"), url.clone(),
        );
    }
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
/// via `mission-*` events — this returns as soon as the child is spawned, or
/// with `queued: true` when the send opted in (`queue`) and landed behind an
/// in-flight turn.
#[tauri::command]
pub async fn mission_send(
    mission: tauri::State<'_, MissionState>,
    app: AppHandle,
    mission_id: String,
    text: String,
    cwd: Option<String>,
    synthesize: Option<bool>,
    queue: Option<bool>,
) -> Result<SendOutcome, String> {
    if text.trim().is_empty() {
        return Err("empty message".to_string());
    }
    crate::mission_context::validate_scope(&mission.db, &mission_id, &mission_id)?;
    let message_id = uuid::Uuid::new_v4().to_string();
    let payload = QueuedMissionSend {
        text: text.clone(),
        cwd,
        synthesize,
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
        match mission.turns.begin_or_enqueue(&mission_id, turn, payload) {
            SendSlot::Began(slot, payload) => (slot, payload),
            SendSlot::Enqueued => {
                // Persist the queued user row so a remount restores the
                // bubble; the reader's drain flips it to `complete`.
                let user_msg = MissionMessage {
                    id: message_id.clone(),
                    mission_id,
                    role: "user".to_string(),
                    body: text,
                    status: "queued".to_string(),
                    created_at: now_millis(),
                };
                mission
                    .db
                    .insert_mission_message(&user_msg)
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
        let slot = mission
            .turns
            .begin(&mission_id)
            .map_err(|_| "the orchestrator is still replying".to_string())?;
        (slot, payload)
    };

    // Persist the user turn (a terminal row).
    let user_msg = MissionMessage {
        id: message_id.clone(),
        mission_id: mission_id.clone(),
        role: "user".to_string(),
        body: text,
        status: "complete".to_string(),
        created_at: now_millis(),
    };
    mission
        .db
        .insert_mission_message(&user_msg)
        .map_err(|e| format!("failed to persist message: {e}"))?;

    if let Err(error) = start_mission_turn(
        app.clone(),
        mission.inner().clone(),
        mission_id.clone(),
        payload,
        slot,
    )
    .await
    {
        finish_error(&app, &mission.db, &mission_id, &error);
        return Err(error);
    }
    Ok(SendOutcome {
        started: true,
        queued: false,
        message_id,
    })
}

/// Everything a turn needs after its user row is persisted: prompt framing,
/// ledger capture, spawn, attach, synthesize flag, reader. Runs on the direct
/// send path AND on the reader's queue drain — which is why the session
/// resume and pin count are read here, at start time. Boxed return: see
/// `turn::BoxStartFuture`.
fn start_mission_turn(
    app: AppHandle,
    mission: MissionState,
    mission_id: String,
    payload: QueuedMissionSend,
    slot: turn::SlotGuard<QueuedMissionSend>,
) -> turn::BoxStartFuture {
    Box::pin(async move {
        let QueuedMissionSend {
            text,
            cwd,
            synthesize,
        } = payload;
        let prior_session = mission.db.get_mission_session(&mission_id);

        // First turn wraps the message with the goal + pins + tool docs; follow-ups
        // get a two-line re-grounding header — the pin count changes as the user
        // browses, and a resumed session left to its own devices tends to answer
        // from stale context instead of re-reading /findings and /tabs.
        let prompt = match &prior_session {
            None => {
                let m = mission
                    .db
                    .get_mission(&mission_id)
                    .map_err(|e| format!("failed to load mission: {e}"))?
                    .ok_or_else(|| "mission not found".to_string())?;
                let findings = mission
                    .db
                    .list_findings(&mission_id)
                    .map_err(|e| format!("failed to load mission evidence: {e}"))?;
                build_first_turn_prompt(&m.title, &m.goal, &findings, &text)
            }
            Some(_) => {
                let pin_count = mission
                    .db
                    .list_findings(&mission_id)
                    .map(|f| f.len())
                    .map_err(|e| format!("failed to load mission evidence: {e}"))?;
                build_followup_prompt(pin_count, &text)
            }
        };
        let prompt = scope_prompt(
            &prompt,
            &mission_id,
            &crate::mission_context::resume_context(&mission.db, &mission_id)?,
        );
        crate::mission_context::checkpoint(
            &mission.db,
            &mission_id,
            "researching",
            if synthesize.unwrap_or(false) {
                "Prepare a source-linked research brief."
            } else {
                "Research the current goal and preserve evidence and unresolved questions."
            },
            None,
            synthesize.unwrap_or(false),
        )?;

        // Polis ledger: record the first-turn mission prompt with its thread
        // provenance (missions are usually roots — the browser pane is the active
        // surface at creation, so `resolve_parent` naturally yields none); keep
        // every agent turn out of the global-hook capture stream.
        if prior_session.is_none() {
            crate::ledger::record_agent_prompt(
                &mission.db,
                crate::ledger::PromptSource::RustFirstTurn,
                "mission",
                &prompt,
                Some(&text),
                cwd.clone(),
                None,
                Some(mission_id.clone()),
                Some(crate::ledger::ThreadRef {
                    thread_kind: "mission",
                    thread_id: mission_id.clone(),
                    parent_session_id: None,
                }),
                crate::seat::model_for("mission"),
            );
        } else {
            crate::ledger::register_agent_prompt(&prompt);
        }

        // Same tool surface as the browse agent: Bash scoped to the localhost
        // bridge (three quoting variants), plus WebSearch/WebFetch. See browse.rs
        // for why all three prefix rules are required.
        let mut args: Vec<String> = vec!["-p".to_string(), prompt];
        args.extend(
            crate::claude_proc::BRIDGE_INVARIANT_ARGS
                .iter()
                .map(|s| s.to_string()),
        );
        args.extend(crate::seat::flag_args("mission"));
        if let Some(sid) = &prior_session {
            args.push("--resume".to_string());
            args.push(sid.clone());
        }

        // Widen the read boundary to span ALL the user's known projects, exactly
        // like browse.rs — the orchestrator can ground research against the
        // user's own code. Re-supplied every turn so the set stays current.
        for dir in crate::code::project_dirs(&mission.db) {
            args.push("--add-dir".to_string());
            args.push(dir);
        }

        let cwd = cwd
            .filter(|c| !c.trim().is_empty())
            .or_else(|| std::env::var("HOME").ok())
            .unwrap_or_else(|| "/".to_string());

        let claude_bin = mission.claude_bin().await?;
        let mut cmd = crate::claude_proc::claude_command_for_seat("mission", &claude_bin);
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
            let _ = app.emit("mission-cancelled", MissionCancelled { mission_id });
            return Ok(());
        }
        tauri::async_runtime::spawn(read_mission(
            app,
            mission,
            buf,
            token,
            mission_id,
            stdout,
            stderr,
            synthesize.unwrap_or(false),
        ));
        Ok(())
    })
}

/// Snapshot of this mission's orchestrator turn for a remounting MissionChat:
/// whether a reply is streaming, since when, and the partial text streamed so
/// far (with its delta `seq` watermark).
#[tauri::command]
pub fn mission_turn_status(
    mission: tauri::State<'_, MissionState>,
    mission_id: String,
) -> TurnStatus {
    mission.turns.status(&mission_id)
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

/// Kill the in-flight orchestrator turn for a mission, if any. Queued sends
/// stay queued — the reader's terminal drain advances them.
#[tauri::command]
pub fn mission_cancel(
    mission: tauri::State<'_, MissionState>,
    mission_id: String,
) -> Result<(), String> {
    if let Some(mut child) = mission.turns.take(&mission_id).and_then(|p| p.child) {
        let _ = child.start_kill();
    }
    crate::mission_context::checkpoint(
        &mission.db,
        &mission_id,
        "paused",
        "Resume research when ready.",
        None,
        false,
    )?;
    Ok(())
}

/// Remove a queued send (the bubble's ×). Returns its text so the composer
/// can restore it; `None` when the send already advanced. The persisted
/// queued row goes with it.
#[tauri::command]
pub fn mission_unqueue(
    mission: tauri::State<'_, MissionState>,
    mission_id: String,
    message_id: String,
) -> Result<Option<String>, String> {
    let Some(turn) = mission.turns.unqueue(&mission_id, &message_id) else {
        return Ok(None);
    };
    if let Err(e) = mission.db.delete_thread_message("mission", &message_id) {
        tracing::warn!(error = %e, "failed to delete the unqueued mission row");
    }
    Ok(Some(turn.text))
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
/// `mission-cancelled`, and drain the send queue. Mirrors `browse::read_browse`.
async fn read_mission(
    app: AppHandle,
    mission: MissionState,
    buf: Arc<Mutex<PartialBuf>>,
    token: u64,
    mission_id: String,
    stdout: ChildStdout,
    stderr: ChildStderr,
    synthesize: bool,
) {
    let db = mission.db.clone();
    let stdout_fut = async {
        let mut reader = BufReader::new(stdout).lines();
        let mut session: Option<String> = None;
        let mut final_text: Option<String> = None;
        let mut errored: Option<String> = None;
        let mut saw_json = false;
        let mut pacer = turn::MeterPacer::default();
        while let Ok(Some(line)) = reader.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };
            saw_json = true;
            // The raw wire, for the inspector. A no-op when it's off —
            // one relaxed atomic load, nothing buffered.
            crate::inspect::capture("mission", &mission_id, trimmed);
            // Second pass over the same value — the meter reads what
            // `classify_line` throws away. Mutate-then-emit, coalesced.
            if let Some(payload) = turn::push_meta(&buf, &v) {
                if pacer.due(&payload) {
                    let _ = app.emit(
                        "mission-meter",
                        MissionMeter {
                            mission_id: mission_id.clone(),
                            meter: payload,
                        },
                    );
                }
            }
            match classify_line(&v) {
                StreamLine::Init(sid) => session = Some(sid),
                StreamLine::Delta(text) => {
                    // Append-before-emit: see `turn::push_delta`.
                    let seq = turn::push_delta(&buf, &text);
                    let _ = app.emit(
                        "mission-delta",
                        MissionDelta {
                            mission_id: mission_id.clone(),
                            text,
                            seq,
                        },
                    );
                }
                StreamLine::Final {
                    text,
                    session_id: sid,
                } => {
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
    let (proc, next) = mission.turns.finish_and_pop(&mission_id, token);
    let cancelled = proc.is_none();
    let exit_ok = match proc.and_then(|p| p.child) {
        Some(mut child) => child.wait().await.map(|s| s.success()).unwrap_or(false),
        None => false,
    };

    // ABOVE the terminal branch, so success, error and cancelled all
    // book. A cancelled turn spent its input tokens too.
    let settled = crate::meter::settle(&db, "mission", &buf);
    if !settled.is_empty() {
        let _ = app.emit(
            "mission-meter",
            MissionMeter {
                mission_id: mission_id.clone(),
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
                "mission-cancelled",
                MissionCancelled {
                    mission_id: mission_id.clone(),
                },
            );
            break 'terminal;
        }
        if let Some(err) = errored {
            let why = describe_turn_error(&db, &mission_id, &err);
            let row = finish_error(&app, &db, &mission_id, &why);
            crate::meter::attach(&db, "mission", &row, &settled);
            break 'terminal;
        }
        if let Some(text) = final_text {
            if text.trim().is_empty() {
                let row = finish_error(&app, &db, &mission_id, "claude produced an empty reply");
                crate::meter::attach(&db, "mission", &row, &settled);
                break 'terminal;
            }
            if let Some(sid) = &session {
                if let Err(e) = db.set_mission_session(&mission_id, sid) {
                    finish_error(&app,&db,&mission_id,&format!("Research finished, but its session could not be saved: {e}. Retry from the saved evidence."));
                    break 'terminal;
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
                finish_error(&app,&db,&mission_id,&format!("Research finished, but its reply could not be saved: {e}. Retry to preserve the result."));
                break 'terminal;
            }
            let handoff = if synthesize {
                match crate::mission_context::prepare_handoff(
                    &db,
                    &mission_id,
                    "drafter",
                    &text,
                    &[msg.id.clone()],
                    &format!("synthesis-{}", msg.id),
                ) {
                    Ok(handoff) => Some(handoff),
                    Err(error) => {
                        finish_error(&app,&db,&mission_id,&format!("Your synthesis is saved in the conversation, but its source-linked brief could not be prepared: {error}. Retry Continue as… from this reply."));
                        break 'terminal;
                    }
                }
            } else {
                None
            };
            if let Err(error) = crate::mission_context::checkpoint(
                &db,
                &mission_id,
                if synthesize {
                    "completed"
                } else {
                    "waiting_for_input"
                },
                if synthesize {
                    "Open or continue from the saved research brief."
                } else {
                    "Review the findings, refine the goal, or continue research."
                },
                None,
                false,
            ) {
                finish_error(
                    &app,
                    &db,
                    &mission_id,
                    &format!("Reply saved, but the mission checkpoint failed: {error}"),
                );
                break 'terminal;
            }
            // The badge and the footer outlive the turn.
            crate::meter::attach(&db, "mission", &msg.id, &settled);
            // Companion journal: the mission orchestrator completed a turn.
            let _ = db.append_journal("agent_turn", Some("mission"), Some(&mission_id), None, None);
            let _ = app.emit(
                "mission-done",
                MissionDone {
                    mission_id: mission_id.clone(),
                    message_id: msg.id,
                    body: text.clone(),
                },
            );
            if let Some(handoff) = handoff {
                let _ = app.emit(
                    "mission-synthesize-done",
                    MissionSynthesizeDone {
                        mission_id: mission_id.clone(),
                        body: text,
                        draft_id: handoff["draftId"].as_str().unwrap_or_default().to_string(),
                        handoff_id: handoff["id"].as_str().unwrap_or_default().to_string(),
                    },
                );
            }
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
        finish_error(&app, &db, &mission_id, &why);
    }

    // Drain: `finish_and_pop` already re-reserved the slot for the queue
    // head, so no concurrent send can slip in between the terminal above and
    // the start below.
    if let Some((queued, payload, slot)) = next {
        if let Err(e) = db.set_thread_message_status("mission", &queued.message_id, "complete") {
            tracing::warn!(error = %e, "failed to flip a drained mission row");
        }
        let _ = app.emit(
            "mission-queue-advanced",
            MissionQueueAdvanced {
                mission_id: mission_id.clone(),
                message_id: queued.message_id.clone(),
            },
        );
        if let Err(e) = start_mission_turn(
            app.clone(),
            mission.clone(),
            mission_id.clone(),
            payload,
            slot,
        )
        .await
        {
            // The slot released via the guard's Drop. Flip the row so the UI
            // offers "wasn't sent — resend"; no chain-drain (predictable
            // failure behavior beats a cascade).
            let _ = db.set_thread_message_status("mission", &queued.message_id, "unsent");
            finish_error(
                &app,
                &db,
                &mission_id,
                &format!("your queued message wasn't sent: {e}"),
            );
        }
    }
}

/// Translate a failed mission turn — branches and wording live once, in
/// `claude_proc::describe_turn_error`. The orchestrator is the heaviest
/// context in the app, so the overflow reset matters most here.
fn describe_turn_error(db: &Database, mission_id: &str, error: &str) -> String {
    crate::claude_proc::describe_turn_error(
        db,
        crate::claude_proc::TurnErrorCopy {
            surface: "mission",
            subject: Some(mission_id),
            noun: "mission",
            next: "I'll re-orient from the goal, pins, and tabs",
        },
        error,
        || {
            if let Err(e) = db.clear_mission_session(mission_id) {
                tracing::warn!(error = %e, "failed to clear over-limit mission session");
            }
        },
    )
}

/// Persist a failed turn as a terminal `error` row and emit `mission-error`.
fn finish_error(app: &AppHandle, db: &Database, mission_id: &str, error: &str) -> String {
    if let Err(save_error) = crate::mission_context::checkpoint(
        db,
        mission_id,
        "failed",
        "Retry this turn; the goal, sources, and previous checkpoints are preserved.",
        Some(error),
        false,
    ) {
        tracing::error!(%save_error,"could not persist the mission failure checkpoint");
    }
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
    // The id the caller attaches this turn's meter to.
    msg.id
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scoped_tools_keep_user_literals_and_never_open_the_active_workspace() {
        let base = build_first_turn_prompt(
            "Browser code",
            "Inspect /v1/browser/open",
            &[],
            "Document /v1/browser/tabs",
        );
        let scoped = scope_prompt(&base, "mission-one", "{}");
        assert!(scoped.contains("curl -s http://127.0.0.1:7676/v1/missions/mission-one/tabs"));
        assert!(!scoped.contains("curl -s http://127.0.0.1:7676/v1/browser/open"));
        assert!(scoped.contains("Inspect /v1/browser/open"));
        assert!(scoped.contains("Document /v1/browser/tabs"));
    }

    #[test]
    fn transient_error_keeps_the_session_overflow_resets_it() {
        let db = Database::open_in_memory().unwrap();
        let m = Mission {
            mission_id: "m-keep".to_string(),
            title: "t".to_string(),
            goal: "g".to_string(),
            status: "active".to_string(),
            created_at: 1,
            updated_at: 1,
        };
        db.insert_mission(&m).unwrap();
        // Transient: session preserved, retry message.
        db.set_mission_session("m-keep", "keep-sid").unwrap();
        let msg = describe_turn_error(&db, "m-keep", "error_during_execution");
        assert!(msg.to_lowercase().contains("again"));
        assert_eq!(
            db.get_mission_session("m-keep").as_deref(),
            Some("keep-sid")
        );

        // Explicit overflow: session forgotten so the next turn starts fresh.
        let m2 = Mission {
            mission_id: "m-over".to_string(),
            ..m
        };
        db.insert_mission(&m2).unwrap();
        db.set_mission_session("m-over", "over-sid").unwrap();
        let msg = describe_turn_error(&db, "m-over", "prompt is too long: 1200000 tokens");
        assert!(msg.to_lowercase().contains("reset"));
        assert_eq!(db.get_mission_session("m-over"), None);
    }

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
        // Download + read-only code routes — SKILL.md references them, so the
        // prompt must grant them too (they drifted apart once).
        assert!(p.contains("/v1/browser/download"));
        assert!(p.contains("/v1/code/projects"));
        assert!(p.contains("/v1/code/git"));
    }

    /// Two missions' first turns with different VARIABLE inputs (title, goal,
    /// pins, user text) share a byte-identical prefix spanning the whole
    /// invariant block — the cache-stable ordering contract.
    #[test]
    fn first_turn_invariant_prefix_is_byte_stable() {
        fn common_prefix<'a>(a: &'a str, b: &str) -> &'a str {
            let n = a.bytes().zip(b.bytes()).take_while(|(x, y)| x == y).count();
            &a[..n]
        }
        let pins = vec![finding("note", "Src", "https://s.example", "body")];
        let a = build_first_turn_prompt("Mission A", "goal one", &[], "question one");
        let b = build_first_turn_prompt("Mission B", "another goal", &pins, "question two");
        let shared = common_prefix(&a, &b);
        // The shared prefix must reach the END of the invariant block — the
        // skill reference is its last line.
        assert!(shared.contains("Follow the `mission` skill"));
        assert!(shared.contains("/v1/mission/findings"));
        // And every variable section sits after it.
        assert!(!shared.contains("Mission A"));
        assert!(!shared.contains("goal one"));
        assert!(!shared.contains("question one"));
    }

    #[test]
    fn first_turn_prompt_without_pins_omits_pin_section() {
        let p = build_first_turn_prompt("Untitled", "find good examples", &[], "hi");
        assert!(p.contains("find good examples"));
        assert!(!p.contains("pinned these findings"));
        // Routes are always documented even with no pins.
        assert!(p.contains("/v1/browser/tabs"));
    }

    #[test]
    fn followup_prompt_regrounds_with_pin_count() {
        let p = build_followup_prompt(3, "what about pricing?");
        assert!(p.contains("3 pin(s)"));
        assert!(p.contains("/v1/mission/findings"));
        assert!(p.contains("/v1/browser/tabs"));
        assert!(p.ends_with("what about pricing?"));
    }
}
