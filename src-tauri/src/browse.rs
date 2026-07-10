// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The browser's "browse agent": a headless `claude` session, one per browser
//! tab, that discusses the page the user is looking at AND can drive the tab
//! (navigate / query the DOM / click) by calling the local daemon's
//! `/v1/browser/*` routes over the already-permitted `curl` allow.
//!
//! Mirrors `fork.rs` (keyed registry of `tokio::process::Child`, stream-json
//! reader, `*-delta`/`*-done`/`*-error`/`*-cancelled` events, DB-persisted
//! terminal turns), but differs in two ways: the agent is a *standalone*
//! `claude` session (no plan to `--fork-session`), and it is granted `Bash` so
//! it can `curl` the browser endpoints — scoped by the settings.json allow
//! `Bash(curl -s http://127.0.0.1:7676/*)`, with everything else auto-denied
//! in headless mode. The first turn embeds a DOM snapshot for instant
//! grounding; later turns rely on the live `/v1/browser/snapshot` tool.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdout};

use crate::claude_proc::{
    bridge_args, classify_line, mission_context_block, resolve_claude_bin,
    StreamLine,
};
use crate::db::Database;
use crate::state::{now_millis, BrowseMessage};

/// One in-flight browse turn. Like `fork::ForkProc`, the registry owns the
/// whole `Child`; `start_kill()` is a synchronous non-blocking SIGKILL.
struct BrowseProc {
    child: Child,
}

type BrowseRegistry = Arc<Mutex<HashMap<String, BrowseProc>>>;

/// Registry of running browse turns, keyed by `browse_id` (the per-tab UUID).
/// Cloned into managed Tauri state. The `std::sync::Mutex` is only ever held
/// for a tiny `lock → mutate → drop` critical section, never across `.await`.
#[derive(Clone)]
pub struct BrowseState {
    procs: BrowseRegistry,
    db: Arc<Database>,
    /// Absolute path to the `claude` binary, resolved lazily on first use —
    /// same TCC reasoning as `fork::ForkState`.
    claude_bin: Arc<OnceLock<String>>,
}

impl BrowseState {
    pub fn new(db: Arc<Database>) -> Self {
        Self {
            procs: Arc::new(Mutex::new(HashMap::new())),
            db,
            claude_bin: Arc::new(OnceLock::new()),
        }
    }

    /// The resolved `claude` path, computing it on first call on the blocking
    /// pool (a cache miss can spawn an interactive shell probe).
    async fn claude_bin(&self) -> Result<String, String> {
        let cell = self.claude_bin.clone();
        tokio::task::spawn_blocking(move || cell.get_or_init(resolve_claude_bin).clone())
            .await
            .map_err(|e| format!("failed to resolve the `claude` CLI: {e}"))
    }

    /// Load a tab's persisted discussion history (oldest first). Lets the daemon
    /// serve `/v1/browser/thread` so one tab's browse agent can read what was
    /// discussed on another, without exposing the private `db` handle.
    pub fn load_thread(&self, browse_id: &str) -> rusqlite::Result<Vec<BrowseMessage>> {
        self.db.load_browse_thread(browse_id)
    }

    /// Whether a browse turn is currently streaming for this tab's discussion
    /// thread. Used to pin a tab live (don't suspend it mid-turn). Same tiny
    /// lock-and-read critical section as the in-flight guard in `send`.
    pub fn is_running(&self, browse_id: &str) -> bool {
        self.procs.lock().unwrap().contains_key(browse_id)
    }

    /// Kill every running browse turn. Backs `browse_kill_all` and app teardown.
    pub fn kill_all(&self) {
        let drained: Vec<BrowseProc> = {
            let mut guard = self.procs.lock().unwrap();
            guard.drain().map(|(_, p)| p).collect()
        };
        for mut proc in drained {
            let _ = proc.child.start_kill();
        }
    }

    /// "Check in with a colleague": run THIS tab's browse agent to completion
    /// with a synthesis-framed question and return only its digest. Backs the
    /// `/v1/linked/consult` route — a linked discussion delegates a heavy tab to
    /// its own page-discussion agent (which already holds that tab's full thread)
    /// so only the boiled-down answer, not the raw thread, enters the linked
    /// conversation's context.
    ///
    /// Unlike `browse_send` (fire-and-forget, streamed via events), this awaits
    /// the whole turn inline behind a timeout so the calling curl blocks for the
    /// digest. It reuses the same per-`browse_id` in-flight guard, so a user's
    /// own turn on that tab and a consult can never run at once — the second sees
    /// a "busy" error and can retry or fall back to reading `/thread?tab=`.
    pub async fn consult(
        &self,
        app: AppHandle,
        browse_id: String,
        question: String,
        snapshot: Option<String>,
    ) -> Result<String, String> {
        if question.trim().is_empty() {
            return Err("nothing to ask the colleague".to_string());
        }

        // Same per-tab in-flight invariant as `browse_send`.
        {
            let guard = self.procs.lock().unwrap();
            if guard.contains_key(&browse_id) {
                return Err(
                    "that tab is busy with its own reply — try again in a moment".to_string(),
                );
            }
        }

        let prior_session = self.db.get_browse_session(&browse_id);

        // Persist the check-in into the tab's OWN thread, framed so it reads as a
        // colleague's visit rather than something the user typed.
        let user_msg = BrowseMessage {
            id: uuid::Uuid::new_v4().to_string(),
            browse_id: browse_id.clone(),
            role: "user".to_string(),
            body: format!("🔗 Linked discussion checking in — {}", question.trim()),
            status: "complete".to_string(),
            created_at: now_millis(),
        };
        if let Err(e) = self.db.insert_browse_message(&user_msg) {
            tracing::warn!(error = %e, "failed to persist consult check-in");
        }

        // Synthesis framing: a digest for a colleague, not a fresh answer to the
        // user. First turn embeds the snapshot + tool docs (the colleague may
        // have no prior context); a resumed colleague gets the compact ask.
        let framed = format!(
            "A colleague running the user's LINKED DISCUSSION — one conversation \
             spanning several browser tabs — is checking in with you about THIS \
             tab. Synthesize what matters here for their question as a tight \
             DIGEST (not a transcript, and not a fresh reply to the user). Be \
             concise. Their question:\n\n{}",
            question.trim()
        );
        // The consult already runs under the linked agent's mission-framed
        // question, so it needs no separate mission block of its own.
        let prompt = match &prior_session {
            None => build_first_turn_prompt(snapshot.as_deref(), &framed, false, None, None),
            Some(_) => framed.clone(),
        };

        // A consult is an internal map-reduce delegation, not a user prompt, so
        // it earns no ledger event — but it still spawns an agent that would trip
        // the global hook, so suppress that duplicate.
        crate::ledger::register_agent_prompt(&crate::ledger::body_hash(&prompt));

        let args = bridge_args("browse", prompt, prior_session.as_deref());
        let cwd = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());

        let claude_bin = self.claude_bin().await?;
        let mut cmd = crate::claude_proc::claude_command_for_seat("browse", &claude_bin);
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
            self.procs
                .lock()
                .unwrap()
                .insert(browse_id.clone(), BrowseProc { child });
        }

        // Drive inline behind a ceiling so a stuck colleague can't block the
        // linked agent's curl forever.
        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(180),
            drive_browse_stream(&app, &browse_id, stdout, stderr),
        )
        .await;

        let (session, final_text, errored, saw_json, stderr_text) = match outcome {
            Ok(v) => v,
            Err(_) => {
                if let Some(mut p) = self.procs.lock().unwrap().remove(&browse_id) {
                    let _ = p.child.start_kill();
                }
                let why = "the colleague took too long to respond".to_string();
                finish_error(&app, &self.db, &browse_id, &why);
                return Err(why);
            }
        };

        let proc = { self.procs.lock().unwrap().remove(&browse_id) };
        let cancelled = proc.is_none() && final_text.is_none();
        let exit_ok = match proc {
            Some(mut p) => p.child.wait().await.map(|s| s.success()).unwrap_or(false),
            None => false,
        };

        if cancelled {
            let _ = app.emit(
                "browse-cancelled",
                BrowseCancelled {
                    browse_id: browse_id.clone(),
                },
            );
            return Err("the consult was cancelled".to_string());
        }
        if let Some(err) = errored {
            let why = describe_turn_error(&self.db, &browse_id, &err);
            finish_error(&app, &self.db, &browse_id, &why);
            return Err(why);
        }
        if let Some(text) = final_text {
            if text.trim().is_empty() {
                let why = "the colleague produced an empty reply".to_string();
                finish_error(&app, &self.db, &browse_id, &why);
                return Err(why);
            }
            if let Some(sid) = &session {
                if let Err(e) = self.db.set_browse_session(&browse_id, sid) {
                    tracing::warn!(error = %e, "failed to persist consult session id");
                }
            }
            let msg = BrowseMessage {
                id: uuid::Uuid::new_v4().to_string(),
                browse_id: browse_id.clone(),
                role: "assistant".to_string(),
                body: text.clone(),
                status: "complete".to_string(),
                created_at: now_millis(),
            };
            if let Err(e) = self.db.insert_browse_message(&msg) {
                tracing::warn!(error = %e, "failed to persist consult reply");
            }
            let _ = app.emit(
                "browse-done",
                BrowseDone {
                    browse_id,
                    message_id: msg.id,
                    body: text.clone(),
                },
            );
            return Ok(text);
        }

        let why = if !exit_ok && !stderr_text.trim().is_empty() {
            let detail: String = stderr_text.trim().chars().take(500).collect();
            format!("the colleague exited abnormally: {detail}")
        } else if !saw_json {
            "the colleague produced no parseable output".to_string()
        } else {
            "the colleague ended without producing a reply".to_string()
        };
        finish_error(&app, &self.db, &browse_id, &why);
        Err(why)
    }
}

// --- Event payloads --------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowseDelta {
    browse_id: String,
    text: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowseDone {
    browse_id: String,
    message_id: String,
    body: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowseError {
    browse_id: String,
    error: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowseCancelled {
    browse_id: String,
}

/// The first turn's prompt: the agent's role, the live DOM snapshot for instant
/// grounding, how to drive the browser via the local curl endpoints, and the
/// user's message. Follow-up turns send the user's text verbatim (the session
/// already carries this context and can re-`curl /snapshot` for a fresh view).
/// Turn the user's accumulated source thumbs into a one-line preference hint for
/// the tandem agent prompt: the domains they most consistently thumbed up vs
/// down. Returns None when there's nothing learned yet (no non-zero domains).
fn build_pref_line(db: &Database) -> Option<String> {
    let summary = db.domain_feedback_summary().ok()?;
    // domain_feedback_summary is sorted score DESC; take the strongest of each.
    let prefer: Vec<String> = summary
        .iter()
        .filter(|(_, score)| *score > 0)
        .take(5)
        .map(|(d, _)| d.clone())
        .collect();
    let avoid: Vec<String> = summary
        .iter()
        .rev()
        .filter(|(_, score)| *score < 0)
        .take(5)
        .map(|(d, _)| d.clone())
        .collect();
    if prefer.is_empty() && avoid.is_empty() {
        return None;
    }
    let mut line = String::from(
        "Learned from the user's past thumbs on sources — weight your page choice accordingly:",
    );
    if !prefer.is_empty() {
        line.push_str(" tends to PREFER ");
        line.push_str(&prefer.join(", "));
        line.push('.');
    }
    if !avoid.is_empty() {
        line.push_str(" tends to AVOID ");
        line.push_str(&avoid.join(", "));
        line.push('.');
    }
    Some(line)
}

fn build_first_turn_prompt(
    snapshot: Option<&str>,
    user_text: &str,
    tandem: bool,
    prefs: Option<&str>,
    mission: Option<(&str, &str)>,
) -> String {
    let mut p = String::from(
        "You are helping the user with the web page open in Redline's embedded \
         browser. You can both discuss the page and drive the browser tab.\n\n",
    );
    p.push_str(&mission_context_block(mission));
    if let Some(snap) = snapshot {
        if !snap.trim().is_empty() {
            p.push_str("Here is a snapshot of the page the user is currently viewing:\n\n");
            p.push_str(snap.trim());
            p.push_str("\n\n");
        }
    }
    p.push_str(
        "You can act on the live browser tab by calling these local endpoints \
         with curl (already permitted — no approval needed). Put the URL \
         immediately after `-s`:\n\n\
         - See the page as it is right now (url, title, selection, text, \
         headings, links):\n  \
         curl -s http://127.0.0.1:7676/v1/browser/snapshot\n\
         - Just the active tab's url and title:\n  \
         curl -s http://127.0.0.1:7676/v1/browser/active\n\
         - List every open tab — your map of the user's tabs. Each has a number \
         `n` (its position in the tab strip, what the USER sees), plus url, \
         title, and which is active:\n  \
         curl -s http://127.0.0.1:7676/v1/browser/tabs\n\
         - Open a URL in a NEW tab and show it (leaves the user's other tabs \
         open; the new tab becomes the active one you then act on):\n  \
         curl -s http://127.0.0.1:7676/v1/browser/open -X POST \
         -H 'Content-Type: application/json' -d '{\"url\":\"https://example.com\"}'\n\
         - Switch the user INTO an existing tab (bring it to the foreground and \
         move them into its conversation) — use when they want to BE in that \
         tab, after you've checked it with ?tab=/thread:\n  \
         curl -s 'http://127.0.0.1:7676/v1/browser/focus?tab=<n>' -X POST\n\
         - Read another tab's discussion history (what was already discussed \
         there — a cheap way to \"check in\" with that tab without re-deriving \
         it):\n  \
         curl -s 'http://127.0.0.1:7676/v1/browser/thread?tab=<n>'\n\
         - Navigate the tab to a URL:\n  \
         curl -s http://127.0.0.1:7676/v1/browser/navigate -X POST \
         -H 'Content-Type: application/json' -d '{\"url\":\"https://example.com\"}'\n\
         - Click the first element matching a CSS selector:\n  \
         curl -s http://127.0.0.1:7676/v1/browser/click -X POST \
         -H 'Content-Type: application/json' -d '{\"selector\":\"a.next\"}'\n\
         - Extract structured data with a scrape schema (fields of type text / \
         html / attr / list with itemSelector+itemFields):\n  \
         curl -s http://127.0.0.1:7676/v1/browser/query -X POST \
         -H 'Content-Type: application/json' \
         -d '{\"version\":1,\"name\":\"links\",\"fields\":[{\"name\":\"links\",\
         \"type\":\"list\",\"itemSelector\":\"a[href]\",\"itemFields\":[{\"name\":\
         \"text\",\"type\":\"text\"},{\"name\":\"href\",\"type\":\"attr\",\
         \"attribute\":\"href\"}]}]}'\n\
         - Save a file to disk (defaults to the user's ~/Downloads), then tell \
         them the saved path the route returns. Omit `url` to save the page \
         they're viewing; pass `url` to save a specific linked file; pass \
         `dialog:true` to let them choose the location:\n  \
         curl -s http://127.0.0.1:7676/v1/browser/download -X POST \
         -H 'Content-Type: application/json' -d '{}'\n\n\
         IMPORTANT: this `/download` route is the ONLY way you can save a file. \
         `curl -o`, `wget`, redirecting to a file, and any other Bash command are \
         auto-denied — never try them. Match the user's words: a named place like \
         \"Downloads\" → `-d '{}'`; \"let me pick\" or no place named → \
         `-d '{\"dialog\":true}'`; a specific link → `-d '{\"url\":\"https://…\"}'`.\n\n\
         After navigating or clicking, wait a moment and re-fetch /snapshot to \
         see the new page.\n\n\
         Every route above acts on the ACTIVE tab by default, but snapshot, \
         query, navigate, click, focus, and thread also accept a `?tab=<n>` \
         selector — the tab NUMBER from /tabs (e.g. ?tab=2) — so you can look at \
         or drive ANY open tab. To *check* another tab, like a colleague glancing \
         at a neighbor's screen, read it by number (e.g. snapshot?tab=2, or its \
         /thread) WITHOUT navigating the user's current tab away from what \
         they're viewing. To open something new, use /open (a fresh tab); use \
         /navigate only when the user wants THIS tab to go somewhere else.\n\n\
         When you mention a tab to the user, name it by its NUMBER and title \
         (e.g. \"tab 2 — google.com\"), never an internal id. Tab numbers are \
         positional and shift as tabs open or close, so re-read /tabs for the \
         current mapping each task rather than remembering a number across \
         turns.\n\n\
         You also have WebSearch and WebFetch (already permitted — no approval \
         needed): use WebSearch to search the web or look something up, and \
         WebFetch to pull a specific URL — rather than driving the user's tab to \
         a search engine. They also verify or fact-check a claim on the page \
         without navigating the tab away from what the user is viewing.\n\n\
         You can also look at the USER'S OWN CODE while they research — so they \
         can brainstorm development against a page. Read/Grep/Glob work across all \
         of their projects (already permitted — no approval needed); use absolute \
         paths. Two read-only curl routes help:\n  \
         - List the user's projects (path, name, current git branch) — your map \
         of where their code lives:\n    \
         curl -s http://127.0.0.1:7676/v1/code/projects\n  \
         - Inspect a project's git state — READ-ONLY (status/branch/log/diff/show); \
         `repo` must be one of the projects above. Single-quote the URL to protect \
         the shell `?`/`&`:\n    \
         curl -s 'http://127.0.0.1:7676/v1/code/git?repo=<path>&op=log&n=20'\n    \
         curl -s 'http://127.0.0.1:7676/v1/code/git?repo=<path>&op=diff&base=main'\n\
         So \"review our X in <project>, check the local branch\" = list projects, \
         Read/Grep the code, and pull branch/diff via `/v1/code/git`. You can NOT \
         commit, edit, or run any other git — those are auto-denied.\n\n\
         Follow the `browse` skill for which tool to use for which job, how to \
         drive the tab, and how to format your reply. Respond directly and \
         concisely in markdown; keep browser actions purposeful.\n\n",
    );
    if tandem {
        p.push_str(
            "TANDEM AGENT MODE is ON. When the user asks about a definition, \
             concept, library, tool, API, or anything that is better understood \
             by looking at a web page, do this:\n\
             1. Use WebSearch to find the strongest explainer, then `/navigate` \
             the ACTIVE tab to that single best page (use /navigate, NOT /open — \
             the page must fill the browser half the user is looking at).\n\
             2. Answer the question concisely in markdown.\n\
             3. Offer ~2 ALTERNATIVE sources for the user to choose from. Do NOT \
             auto-open the alternates — the user opens them if they want.\n\
             4. End your reply with a machine-readable sources block listing the \
             page you opened (primary) and the alternates, in this exact fenced \
             form (the app parses it and hides it from view — never describe it):\n\
             ```rl-sources\n\
             [{\"url\":\"https://…\",\"title\":\"…\",\"primary\":true},{\"url\":\"https://…\",\"title\":\"…\"},{\"url\":\"https://…\",\"title\":\"…\"}]\n\
             ```\n\
             Every source you cite (primary and alternates) MUST appear in that \
             block. If the question is conversational and no page helps, skip the \
             navigation and omit the block.\n\n",
        );
        if let Some(prefs) = prefs {
            if !prefs.trim().is_empty() {
                p.push_str(prefs.trim());
                p.push_str("\n\n");
            }
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

// --- Commands --------------------------------------------------------------

/// Send a turn to a tab's browse agent. The first turn starts a fresh `claude`
/// session (capturing its id); later turns resume it. Streaming happens via
/// `browse-*` events — this returns as soon as the child is spawned.
#[tauri::command]
pub async fn browse_send(
    browse: tauri::State<'_, BrowseState>,
    active_mission: tauri::State<'_, crate::ActiveMission>,
    active_surface: tauri::State<'_, crate::ActiveSurface>,
    app: AppHandle,
    browse_id: String,
    text: String,
    snapshot: Option<String>,
    cwd: Option<String>,
    tandem: Option<bool>,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("empty message".to_string());
    }

    // Reject a second concurrent turn for the same tab.
    {
        let guard = browse.procs.lock().unwrap();
        if guard.contains_key(&browse_id) {
            return Err("a reply is still streaming for this tab".to_string());
        }
    }

    let prior_session = browse.db.get_browse_session(&browse_id);

    // Persist the user turn (a terminal row).
    let user_msg = BrowseMessage {
        id: uuid::Uuid::new_v4().to_string(),
        browse_id: browse_id.clone(),
        role: "user".to_string(),
        body: text.clone(),
        status: "complete".to_string(),
        created_at: now_millis(),
    };
    browse
        .db
        .insert_browse_message(&user_msg)
        .map_err(|e| format!("failed to persist message: {e}"))?;

    // First turn wraps the message with the snapshot + tool docs; follow-ups
    // are verbatim (the resumed session already carries that context). In tandem
    // mode the first turn also carries the learned source-preference line so the
    // agent biases its page picks toward domains the user has thumbed up.
    let tandem = tandem.unwrap_or(false);
    // When this tab lives inside an active mission, bake the goal in so the
    // per-tab agent orients its help to what the user is researching.
    let mission = active_mission.active_goal();
    let prompt = match &prior_session {
        None => {
            let prefs = if tandem {
                build_pref_line(&browse.db)
            } else {
                None
            };
            build_first_turn_prompt(
                snapshot.as_deref(),
                &text,
                tandem,
                prefs.as_deref(),
                mission.as_ref().map(|(t, g)| (t.as_str(), g.as_str())),
            )
        }
        Some(_) => text.clone(),
    };

    // Polis ledger: record the first-turn page-discussion prompt WITH its
    // thread provenance (this tab's browse_id + resolved parent), and link the
    // new thread into the session tree; keep every agent turn out of the
    // global-hook capture stream.
    if prior_session.is_none() {
        let surface = active_surface.kind_and_id();
        let parent = crate::ledger::resolve_parent(
            None,
            active_mission.active_id().as_deref(),
            surface.as_ref().map(|(k, i)| (k.as_str(), i.as_str())),
            "browse",
        );
        if let Some((pk, pid)) = &parent {
            let _ = crate::ledger::record_session_link(&browse.db, "browse", &browse_id, pk, pid);
        }
        crate::ledger::record_agent_prompt(
            &browse.db,
            crate::ledger::PromptSource::RustFirstTurn,
            "browse",
            &prompt,
            cwd.clone(),
            None,
            None,
            Some(crate::ledger::ThreadRef {
                thread_kind: "browse",
                thread_id: browse_id.clone(),
                parent_session_id: parent
                    .filter(|(pk, _)| pk == "session")
                    .map(|(_, pid)| pid),
            }),
        );
    } else {
        crate::ledger::register_agent_prompt(&crate::ledger::body_hash(&prompt));
    }

    // The agent gets Bash so it can curl the browser endpoints. `--tools` only
    // makes a tool *available*; headless `-p` then auto-denies anything not in
    // `--allowedTools` (there's no one to approve a prompt). So the allow-list
    // below is what actually lets WebSearch/WebFetch run and scopes Bash to the
    // daemon's `curl -s http://127.0.0.1:7676/*` — pinned here so the bridge no
    // longer depends on the global `~/.claude/settings.json` rule (that rule
    // stays a redundant backstop). Read/Grep/Glob are auto-approved, so they
    // need no allow entry. MCP is stripped. Never plan mode.
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
        // Three prefix rules for the same localhost bridge. The matcher is a
        // literal command-prefix glob, so a quoted URL (`curl -s 'http://…`) does
        // NOT match the unquoted rule. Cross-tab routes carry a `?tab=` query the
        // agent single-quotes to protect the shell `?`/`&` — without the quoted
        // variants those reads fall through to headless auto-deny ("bounced for
        // approval"). All three stay scoped to 127.0.0.1:7676; only quoting widens.
        "Bash(curl -s http://127.0.0.1:7676/*)".to_string(),
        "Bash(curl -s 'http://127.0.0.1:7676/*)".to_string(),
        "Bash(curl -s \"http://127.0.0.1:7676/*)".to_string(),
        "--strict-mcp-config".to_string(),
    ];
    args.extend(crate::seat::flag_args("browse"));
    if let Some(sid) = &prior_session {
        args.push("--resume".to_string());
        args.push(sid.clone());
    }

    // Widen the read boundary to span ALL the user's known projects, not just
    // the single active-folder `cwd`. Each `--add-dir` puts a project inside the
    // workspace so Read/Grep/Glob "just work" there — this is what lets the agent
    // readily look at code in any project while the user researches in the
    // browser. Re-supplied every turn (alongside `--resume`) so the set stays
    // current. Bounded by `code::MAX_PROJECTS`.
    for dir in crate::code::project_dirs(&browse.db) {
        args.push("--add-dir".to_string());
        args.push(dir);
    }

    // The agent's cwd scopes Read/Grep/Glob; default to $HOME when the tab has
    // no associated project folder.
    let cwd = cwd
        .filter(|c| !c.trim().is_empty())
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| "/".to_string());

    let claude_bin = browse.claude_bin().await?;
    let mut cmd = crate::claude_proc::claude_command_for_seat("browse", &claude_bin);
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
        browse
            .procs
            .lock()
            .unwrap()
            .insert(browse_id.clone(), BrowseProc { child });
    }
    tauri::async_runtime::spawn(read_browse(
        app,
        browse.db.clone(),
        browse.procs.clone(),
        browse_id,
        stdout,
        stderr,
    ));
    Ok(())
}

/// Load a tab's persisted browse turns, oldest first.
#[tauri::command]
pub fn get_browse_thread(
    browse: tauri::State<'_, BrowseState>,
    browse_id: String,
) -> Result<Vec<BrowseMessage>, String> {
    browse
        .db
        .load_browse_thread(&browse_id)
        .map_err(|e| format!("failed to load thread: {e}"))
}

/// Kill the in-flight turn for a tab, if any. `read_browse` then sees the key
/// already gone and emits `browse-cancelled`.
#[tauri::command]
pub fn browse_cancel(
    browse: tauri::State<'_, BrowseState>,
    browse_id: String,
) -> Result<(), String> {
    let proc = { browse.procs.lock().unwrap().remove(&browse_id) };
    if let Some(mut proc) = proc {
        let _ = proc.child.start_kill();
    }
    Ok(())
}

/// Discard a tab's whole thread: kill any in-flight turn, delete its persisted
/// messages, and forget its agent session.
#[tauri::command]
pub fn browse_discard(
    browse: tauri::State<'_, BrowseState>,
    browse_id: String,
) -> Result<(), String> {
    let proc = { browse.procs.lock().unwrap().remove(&browse_id) };
    if let Some(mut proc) = proc {
        let _ = proc.child.start_kill();
    }
    browse
        .db
        .delete_browse_thread(&browse_id)
        .map_err(|e| format!("failed to delete thread: {e}"))?;
    Ok(())
}

/// Kill every running browse agent — also invoked on app teardown.
#[tauri::command]
pub fn browse_kill_all(browse: tauri::State<'_, BrowseState>) -> Result<(), String> {
    browse.kill_all();
    Ok(())
}

// --- Streaming reader ------------------------------------------------------

/// Stream one browse child's stdout/stderr to completion, emitting
/// `browse-delta` events as assistant text arrives. Returns
/// `(session, final_text, errored, saw_json, stderr_text)`. Shared by
/// `read_browse` (spawned, fire-and-forget) and `BrowseState::consult` (awaited
/// inline so the caller gets the digest back synchronously).
async fn drive_browse_stream(
    app: &AppHandle,
    browse_id: &str,
    stdout: ChildStdout,
    stderr: ChildStderr,
) -> (Option<String>, Option<String>, Option<String>, bool, String) {
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
                        "browse-delta",
                        BrowseDelta {
                            browse_id: browse_id.to_string(),
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
    (session, final_text, errored, saw_json, stderr_text)
}

/// Drive one browse turn: stream stdout JSONL → `browse-delta` events, then
/// reap the child and emit a terminal `browse-done` / `browse-error` /
/// `browse-cancelled`. Mirrors `fork::read_fork`.
async fn read_browse(
    app: AppHandle,
    db: Arc<Database>,
    procs: BrowseRegistry,
    browse_id: String,
    stdout: ChildStdout,
    stderr: ChildStderr,
) {
    let (session, final_text, errored, saw_json, stderr_text) =
        drive_browse_stream(&app, &browse_id, stdout, stderr).await;

    let proc = { procs.lock().unwrap().remove(&browse_id) };
    let cancelled = proc.is_none() && final_text.is_none();
    let exit_ok = match proc {
        Some(mut p) => p.child.wait().await.map(|s| s.success()).unwrap_or(false),
        None => false,
    };

    if cancelled {
        let _ = app.emit("browse-cancelled", BrowseCancelled { browse_id });
        return;
    }
    if let Some(err) = errored {
        // Transient API errors keep the session and ask for a retry; only an
        // explicit context overflow resets the session to start fresh.
        let why = describe_turn_error(&db, &browse_id, &err);
        finish_error(&app, &db, &browse_id, &why);
        return;
    }
    if let Some(text) = final_text {
        if text.trim().is_empty() {
            finish_error(&app, &db, &browse_id, "claude produced an empty reply");
            return;
        }
        // Persist the session id so the next turn resumes (not re-spawns).
        if let Some(sid) = &session {
            if let Err(e) = db.set_browse_session(&browse_id, sid) {
                tracing::warn!(error = %e, "failed to persist browse session id");
            }
        }
        let msg = BrowseMessage {
            id: uuid::Uuid::new_v4().to_string(),
            browse_id: browse_id.clone(),
            role: "assistant".to_string(),
            body: text.clone(),
            status: "complete".to_string(),
            created_at: now_millis(),
        };
        if let Err(e) = db.insert_browse_message(&msg) {
            tracing::warn!(error = %e, "failed to persist assistant message");
        }
        // Companion journal: this tab's agent completed a turn.
        let _ = db.append_journal("agent_turn", Some("browse"), Some(&browse_id), None, None);
        let _ = app.emit(
            "browse-done",
            BrowseDone {
                browse_id,
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
    finish_error(&app, &db, &browse_id, &why);
}

/// Whether a failed turn's error is an EXPLICIT context-length signature — the
/// resumable session genuinely outgrew the model's window, so every `--resume`
/// of it will keep throwing until we start fresh. This is deliberately narrow:
/// only claude's own "prompt is too long" / context-length phrasings, NOT the
/// generic `error_during_execution` bucket. That bucket is dominated by
/// *transient* API errors (overload / capacity) whose session is perfectly fine
/// on the next attempt — clearing it there would throw away a healthy
/// conversation over a momentary blip. (Empirically: the sessions that produced
/// `error_during_execution` here were only ~60–70K tokens and resume cleanly.)
pub(crate) fn is_context_overflow(error: &str) -> bool {
    let e = error.to_lowercase();
    e.contains("prompt is too long")
        || e.contains("context length")
        || e.contains("context window")
        || e.contains("too many tokens")
        || e.contains("maximum context")
}

/// Whether an error looks TRANSIENT — a momentary model/API failure (the generic
/// `error_during_execution` subtype claude emits for an empty-message errored
/// `result`, plus overload/capacity/timeout wording). The session is healthy;
/// retrying in a moment usually works. Account-level limits are transient-ish
/// too (they reset), so they also land here rather than triggering a reset.
pub(crate) fn is_transient(error: &str) -> bool {
    let e = error.to_lowercase();
    e.contains("error_during_execution")
        || e.contains("overloaded")
        || e.contains("capacity")
        || e.contains("timeout")
        || e.contains("timed out")
        || e.contains("temporarily")
        || e.contains("rate limit")
        || e.contains("usage limit")
        || e.contains("session limit")
}

/// Translate a failed turn's raw error into the message to surface, and recover
/// the tab where that's the right move:
///
/// - EXPLICIT context overflow → forget the stored session id so the next turn
///   starts fresh (re-embedding a snapshot) instead of re-`--resume`-ing an
///   over-limit context forever, and say so.
/// - TRANSIENT model/API error → keep the session (it's fine) and tell the user
///   plainly to retry. This is the common "kept failing" case: a momentary API
///   blip the user hit by retrying inside the incident window.
/// - Anything else → surface unchanged.
fn describe_turn_error(db: &Database, browse_id: &str, error: &str) -> String {
    if is_context_overflow(error) {
        if let Err(e) = db.clear_browse_session(browse_id) {
            tracing::warn!(error = %e, "failed to clear over-limit browse session");
        }
        return "This discussion outgrew the model's context window, so the turn \
                failed. I've reset its context — send your message again and I'll \
                start fresh on this page (the replies above are kept)."
            .to_string();
    }
    if is_transient(error) {
        return "The model hit a temporary error on this turn (not something you \
                did) — send your message again in a moment. Your conversation is \
                intact."
            .to_string();
    }
    error.to_string()
}

/// Persist a failed turn as a terminal `error` row and emit `browse-error`.
fn finish_error(app: &AppHandle, db: &Database, browse_id: &str, error: &str) {
    let msg = BrowseMessage {
        id: uuid::Uuid::new_v4().to_string(),
        browse_id: browse_id.to_string(),
        role: "assistant".to_string(),
        body: error.to_string(),
        status: "error".to_string(),
        created_at: now_millis(),
    };
    if let Err(e) = db.insert_browse_message(&msg) {
        tracing::warn!(error = %e, "failed to persist error browse message");
    }
    let _ = app.emit(
        "browse-error",
        BrowseError {
            browse_id: browse_id.to_string(),
            error: error.to_string(),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_turn_prompt_embeds_snapshot_and_tools() {
        let p = build_first_turn_prompt(
            Some(r#"{"url":"https://example.com","title":"Example"}"#),
            "What is this page about?",
            false,
            None,
            None,
        );
        assert!(p.contains("https://example.com"));
        assert!(p.contains("What is this page about?"));
        // With no active mission, no mission block is injected.
        assert!(!p.contains("A research MISSION is currently active"));
        // Tool docs must always be present.
        assert!(p.contains("/v1/browser/snapshot"));
        assert!(p.contains("/v1/browser/navigate"));
        assert!(p.contains("/v1/browser/query"));
        // The download route is the agent's only file-save path.
        assert!(p.contains("/v1/browser/download"));
        // Cross-tab capabilities (list / open / read another tab's history /
        // target a specific tab) must be documented too.
        assert!(p.contains("/v1/browser/tabs"));
        assert!(p.contains("/v1/browser/open"));
        assert!(p.contains("/v1/browser/focus?tab="));
        assert!(p.contains("/v1/browser/thread?tab="));
        // Tabs are addressed (and named to the user) by their 1-based number.
        assert!(p.contains("?tab=<n>"));
        assert!(p.contains("?tab=2"));
        // Code access: the projects map + read-only git bridge must be documented.
        assert!(p.contains("/v1/code/projects"));
        assert!(p.contains("/v1/code/git"));
        // And it must be framed as read-only.
        assert!(p.to_lowercase().contains("read-only"));
    }

    #[test]
    fn first_turn_prompt_without_snapshot_still_documents_tools() {
        let p = build_first_turn_prompt(None, "open hacker news", false, None, None);
        assert!(p.contains("open hacker news"));
        assert!(p.contains("/v1/browser/navigate"));
        // No empty snapshot section header.
        assert!(!p.contains("snapshot of the page the user is currently viewing"));
        // Non-tandem prompts carry no tandem instructions or sources contract.
        assert!(!p.contains("TANDEM AGENT MODE"));
        assert!(!p.contains("rl-sources"));
    }

    #[test]
    fn first_turn_prompt_embeds_active_mission_goal() {
        let p = build_first_turn_prompt(
            None,
            "How does this page help?",
            false,
            None,
            Some(("Data-breach page", "Draft my firm's data-breach practice page")),
        );
        // The goal + mission title are baked in so the per-tab agent orients to it.
        assert!(p.contains("A research MISSION is currently active"));
        assert!(p.contains("Data-breach page"));
        assert!(p.contains("Draft my firm's data-breach practice page"));
        // And the re-read routes are documented for a mid-conversation change.
        assert!(p.contains("/v1/mission/active"));
        assert!(p.contains("/v1/mission/findings"));
    }

    #[test]
    fn only_explicit_overflow_counts_as_context_overflow() {
        // Explicit context-length phrasings, however claude words them.
        assert!(is_context_overflow("prompt is too long: 250000 tokens"));
        assert!(is_context_overflow("maximum context length exceeded"));
        assert!(is_context_overflow("input exceeds the context window"));
        // The generic subtype is NOT overflow — it's transient (empirically the
        // sessions that produced it were ~60–70K tokens and resume fine).
        assert!(!is_context_overflow("error_during_execution"));
        assert!(is_transient("error_during_execution"));
        assert!(is_transient("model overloaded, please retry"));
        assert!(is_transient("You've hit your session limit · resets 12:30pm"));
    }

    #[test]
    fn transient_error_keeps_the_session_overflow_resets_it() {
        let db = Database::open_in_memory().unwrap();
        // Transient: session preserved, retry message.
        db.set_browse_session("tab-1", "keep-sid").unwrap();
        let msg = describe_turn_error(&db, "tab-1", "error_during_execution");
        assert!(msg.to_lowercase().contains("try") || msg.to_lowercase().contains("again"));
        assert_eq!(db.get_browse_session("tab-1").as_deref(), Some("keep-sid"));

        // Explicit overflow: session forgotten so the next turn starts fresh.
        db.set_browse_session("tab-2", "over-sid").unwrap();
        let msg = describe_turn_error(&db, "tab-2", "prompt is too long: 1200000 tokens");
        assert!(msg.to_lowercase().contains("reset"));
        assert_eq!(db.get_browse_session("tab-2"), None);
    }

    #[test]
    fn tandem_prompt_carries_sources_contract_and_prefs() {
        let p = build_first_turn_prompt(
            None,
            "what is a DAG?",
            true,
            Some("Learned: tends to PREFER wikipedia.org."),
            None,
        );
        assert!(p.contains("TANDEM AGENT MODE is ON"));
        assert!(p.contains("rl-sources"));
        assert!(p.contains("/navigate"));
        assert!(p.contains("wikipedia.org"));
    }
}
