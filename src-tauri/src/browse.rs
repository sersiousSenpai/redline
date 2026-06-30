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

use crate::claude_proc::{classify_line, claude_command, resolve_claude_bin, StreamLine};
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
fn build_first_turn_prompt(snapshot: Option<&str>, user_text: &str) -> String {
    let mut p = String::from(
        "You are helping the user with the web page open in Redline's embedded \
         browser. You can both discuss the page and drive the browser tab.\n\n",
    );
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
         Follow the `browse` skill for which tool to use for which job, how to \
         drive the tab, and how to format your reply. Respond directly and \
         concisely in markdown; keep browser actions purposeful.\n\n\
         The user says:\n",
    );
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
    app: AppHandle,
    browse_id: String,
    text: String,
    snapshot: Option<String>,
    cwd: Option<String>,
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
    // are verbatim (the resumed session already carries that context).
    let prompt = match &prior_session {
        None => build_first_turn_prompt(snapshot.as_deref(), &text),
        Some(_) => text.clone(),
    };

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
    if let Some(sid) = &prior_session {
        args.push("--resume".to_string());
        args.push(sid.clone());
    }

    // The agent's cwd scopes Read/Grep/Glob; default to $HOME when the tab has
    // no associated project folder.
    let cwd = cwd
        .filter(|c| !c.trim().is_empty())
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| "/".to_string());

    let claude_bin = browse.claude_bin().await?;
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
                            browse_id: browse_id.clone(),
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
        finish_error(&app, &db, &browse_id, &err);
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
        );
        assert!(p.contains("https://example.com"));
        assert!(p.contains("What is this page about?"));
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
    }

    #[test]
    fn first_turn_prompt_without_snapshot_still_documents_tools() {
        let p = build_first_turn_prompt(None, "open hacker news");
        assert!(p.contains("open hacker news"));
        assert!(p.contains("/v1/browser/navigate"));
        // No empty snapshot section header.
        assert!(!p.contains("snapshot of the page the user is currently viewing"));
    }
}
