// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The browser's "browse agent": a headless `claude` session per page chat (a
//! tab's own chat, or a workspace's shared chat in linked mode) that discusses
//! the page the user is looking at AND can drive it (typed page actions through
//! `/v1/browser/action` on the page each turn captured) by calling the local
//! daemon's `/v1/browser/*` routes over the already-permitted `curl` allow.
//!
//! Mirrors `fork.rs` (keyed registry of `tokio::process::Child`, stream-json
//! reader, `*-delta`/`*-done`/`*-error`/`*-cancelled` events, DB-persisted
//! terminal turns), but differs in two ways: the agent is a *standalone*
//! `claude` session (no plan to `--fork-session`), and it is granted `Bash` so
//! it can `curl` the browser endpoints — scoped by the settings.json allow
//! `Bash(curl -s http://127.0.0.1:7676/*)`, with everything else auto-denied
//! in headless mode. The first turn embeds a DOM snapshot for instant
//! grounding; later turns rely on the live `/v1/browser/snapshot` tool.
//!
//! A chat whose pick is Codex runs the same turn on a `codex app-server`
//! thread (`codex_conversation::NativeTurn`): a read-only sandbox with network
//! access, whose shell reaches the same curl bridge with the same token. Each
//! provider keeps its own resumable id, so switching back resumes the old
//! session, and the side that missed turns is handed them as context.

use std::process::Stdio;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout};

use crate::claude_proc::{
    bridge_args_with_flags, captured_mission_context_block, classify_line, resolve_claude_bin,
    StreamLine,
};
use crate::codex_conversation::NativeTurn;
use crate::db::Database;
use crate::state::{now_millis, BrowseHarness, BrowseMessage, Mission};
use crate::turn::{self, PartialBuf, QueuedTurn, SendOutcome, SendSlot, TurnStatus, Turns};

/// The CLI a chat's turn runs on: its stored pick's provider. Anything but
/// `codex`, "never picked" included, is Claude.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Provider {
    Claude,
    Codex,
}

impl Provider {
    fn of(harness: &BrowseHarness) -> Self {
        match harness.backend.as_deref() {
            Some("codex") => Self::Codex,
            _ => Self::Claude,
        }
    }

    /// The stored `backend` value (`browse_messages.backend`, the pick).
    fn backend(self) -> &'static str {
        match self {
            Self::Claude => "claude-code",
            Self::Codex => "codex",
        }
    }

    /// The CLI's name, for error text.
    fn cli(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    /// The key a session-scoped cache is kept under. Claude keeps the bare
    /// `browse_id` it always had.
    fn session_key(self, browse_id: &str) -> String {
        match self {
            Self::Claude => browse_id.to_string(),
            Self::Codex => format!("{browse_id}#codex"),
        }
    }
}

/// Everything a queued browse send needs to start later. The session resume
/// and prompt framing are resolved at START time (`start_browse_turn`), not
/// enqueue time — a drained turn must resume the session the turn ahead of it
/// just established. The snapshot IS captured at enqueue time: it describes
/// the page the user was looking at when they typed.
pub struct QueuedBrowseSend {
    /// The user row this turn answers, which carried history must not repeat.
    message_id: String,
    text: String,
    snapshot: Option<String>,
    cwd: Option<String>,
    target_label: Option<String>,
    /// The targeted tab's own `browse_id`, written onto both of the turn's
    /// rows: the page a shared chat's message was about.
    target_browse_id: Option<String>,
    following_tabs: bool,
    /// The mission the user sent from, captured at send time (BC-13).
    mission: Option<Mission>,
}

/// Registry of running browse turns, keyed by `browse_id` (the per-tab UUID),
/// on the shared `turn::Turns` contract (atomic slot reservation + probeable
/// partial buffer). Cloned into managed Tauri state.
#[derive(Clone)]
pub struct BrowseState {
    turns: Arc<Turns<QueuedBrowseSend>>,
    db: Arc<Database>,
    /// Absolute path to the `claude` binary, resolved lazily on first use —
    /// same TCC reasoning as `fork::ForkState`.
    claude_bin: Arc<OnceLock<String>>,
    /// Project cards already sent, per agent session
    /// (`Provider::session_key`): a provider that never saw a card gets it.
    sent_projects: Arc<Mutex<HashMap<String, HashSet<String>>>>,
    /// The page each started turn was sent against (`browse_id` → its
    /// captured target label). A shared chat's turn runs on a thread no tab
    /// owns, so `is_running` alone can't say which tab it is driving.
    targets: Arc<Mutex<HashMap<String, String>>>,
}

impl BrowseState {
    pub fn new(db: Arc<Database>) -> Self {
        Self {
            turns: Arc::new(Turns::new()),
            db,
            claude_bin: Arc::new(OnceLock::new()),
            sent_projects: Arc::new(Mutex::new(HashMap::new())),
            targets: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn project_context(&self, key: &str, first: bool, user_text: &str, mission_goal: Option<&str>) -> (String, Vec<String>) {
        let briefs = crate::code::project_briefs(&self.db);
        let intent = format!("{}\n{}", mission_goal.unwrap_or(""), user_text);
        let mut sent = self.sent_projects.lock().unwrap();
        if first { sent.remove(key); }
        let prior = sent.get(key);
        let hits: Vec<_> = crate::code::resolve_project_mentions(&intent,&briefs).into_iter().filter(|brief| prior.is_none_or(|paths| !paths.contains(&brief.path))).collect();
        let mut context = if first { format!("{}{}", crate::claude_proc::host_context_block(), crate::claude_proc::project_index_block(&briefs)) } else { String::new() };
        context.push_str(&crate::claude_proc::project_cards_block(&hits));
        (context,hits.iter().map(|brief|brief.path.clone()).collect())
    }
    fn mark_projects_sent(&self, key: &str, paths: Vec<String>) {
        let mut sent = self.sent_projects.lock().unwrap();
        // Bounded per-process cache. Eviction merely re-sends a small card.
        if sent.len() >= 512 && !sent.contains_key(key) { sent.clear(); }
        sent.entry(key.into()).or_default().extend(paths);
    }

    /// The resolved `claude` path, computing it on first call on the blocking
    /// pool (a cache miss can spawn an interactive shell probe).
    async fn claude_bin(&self) -> Result<String, String> {
        let cell = self.claude_bin.clone();
        tokio::task::spawn_blocking(move || cell.get_or_init(resolve_claude_bin).clone())
            .await
            .map_err(|e| format!("failed to resolve the `claude` CLI: {e}"))
    }

    /// What was discussed about a tab (oldest first): its own thread and the
    /// shared-chat turns sent against it. Lets the daemon serve
    /// `/v1/browser/thread` so one tab's browse agent can read what was
    /// discussed on another, without exposing the private `db` handle.
    pub fn load_thread(&self, browse_id: &str) -> rusqlite::Result<Vec<BrowseMessage>> {
        self.db.load_browse_thread_about(browse_id)
    }

    /// Whether a browse turn is currently streaming for this tab's discussion
    /// thread. Used to pin a tab live (don't suspend it mid-turn).
    pub fn is_running(&self, browse_id: &str) -> bool {
        self.turns.is_running(browse_id)
    }

    /// Remember the page a starting turn targets, forgetting the targets of
    /// turns that have since ended so the map holds only running ones.
    fn record_target(&self, browse_id: &str, label: Option<&str>) {
        let mut targets = self.targets.lock().unwrap();
        targets.retain(|id, _| id != browse_id && self.turns.is_running(id));
        if let Some(label) = label {
            targets.insert(browse_id.to_string(), label.to_string());
        }
    }

    /// Whether a running turn was sent against this tab, whichever thread it
    /// runs on. Suspending it would pull the page from under the agent
    /// mid-turn (BC-31).
    pub fn is_targeted(&self, label: &str) -> bool {
        self.targets
            .lock()
            .unwrap()
            .iter()
            .any(|(id, target)| target == label && self.turns.is_running(id))
    }

    /// A page action on `label` has an outcome: write what it did onto each
    /// running turn that targets that page, as a step of its own. The reply's
    /// row then names the action live and after a relaunch, and a page the
    /// user took over says so (BC-34, BC-41).
    pub fn note_action(&self, app: &AppHandle, label: &str, step: &str) {
        for (browse_id, meter) in self.record_action(label, step) {
            let _ = app.emit("browse-meter", BrowseMeter { browse_id, meter });
        }
    }

    /// `note_action` short of the emit: each turn written to, and its event.
    fn record_action(&self, label: &str, step: &str) -> Vec<(String, turn::MeterPayload)> {
        let ids: Vec<String> = self.targets.lock().unwrap().iter().filter(|(_, target)| *target == label).map(|(id, _)| id.clone()).collect();
        ids.into_iter()
            .filter_map(|id| {
                let buf = self.turns.partial(&id)?;
                let activity = crate::meter::Activity { at: now_millis(), kind: "tool".into(), label: step.into() };
                Some((id, turn::push_activity(&buf, activity)))
            })
            .collect()
    }

    /// Kill every running browse turn. Backs `browse_kill_all` and app teardown.
    pub fn kill_all(&self) {
        self.turns.kill_all();
    }

    /// "Check in with a colleague": run THIS tab's browse agent to completion
    /// with a synthesis-framed question and return only its digest. Backs the
    /// Companion global consult route; the caller receives a digest of the page thread.
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

        // Same per-tab in-flight invariant as `browse_send` — the reservation
        // holds the slot across the whole spawn, and an early `?` return
        // releases it via the guard's Drop.
        let slot = self.turns.begin(&browse_id).map_err(|_| {
            "that tab is busy with its own reply — try again in a moment".to_string()
        })?;

        // The chat's pick decides who answers: the colleague is this tab's
        // agent on whichever provider the chat is set to.
        let harness = self.db.get_browse_harness(&browse_id);
        let provider = Provider::of(&harness);
        let prior_session = resume_id(&self.db, &browse_id, provider);

        // Persist the check-in into the tab's OWN thread, framed so it reads as a
        // colleague's visit rather than something the user typed.
        let user_msg = BrowseMessage {
            id: uuid::Uuid::new_v4().to_string(),
            browse_id: browse_id.clone(),
            role: "user".to_string(),
            body: format!("Companion checking in — {}", question.trim()),
            status: "complete".to_string(),
            created_at: now_millis(),
            backend: None,
            target_browse_id: None,
        };
        if let Err(e) = self.db.insert_browse_message(&user_msg) {
            tracing::warn!(error = %e, "failed to persist consult check-in");
        }

        // Synthesis framing: a digest for a colleague, not a fresh answer to the
        // user. First turn embeds the snapshot + tool docs (the colleague may
        // have no prior context); a resumed colleague gets the compact ask.
        // A consult has no captured tail, so its framing names the page: a
        // re-read without one would land on whichever tab is on screen.
        let label = app
            .try_state::<crate::BrowserTabs>()
            .and_then(|tabs| tabs.get().into_iter().find(|t| t.browse_id == browse_id))
            .map(|t| t.label);
        let framed = consult_framing(&question, label.as_deref());
        // The consult already runs under the calling agent's mission-framed
        // question, so it needs no separate mission block of its own.
        let session_key = provider.session_key(&browse_id);
        let (context, project_paths) = self.project_context(&session_key, prior_session.is_none(), &question, None);
        let thread = self.db.load_browse_thread(&browse_id).unwrap_or_default();
        let context = format!("{context}{}", carried_history(&thread, &user_msg.id, provider, prior_session.is_some()));
        let prompt = match &prior_session {
            None => first_turn_body(provider, snapshot.as_deref(), &framed, None, &context),
            Some(_) => format!("{context}{framed}"),
        };

        // A consult is an internal map-reduce delegation, not a user prompt, so
        // it earns no ledger event — but it still spawns an agent that would trip
        // the global hook, so suppress that duplicate.
        crate::ledger::register_agent_prompt(&prompt);

        let cwd = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
        let resumed = prior_session.is_some();
        let launch = self.launch(&browse_id, prompt, &harness, prior_session, &cwd, false);
        let (child, io) = self.spawn_agent(launch, &cwd).await?;
        self.mark_projects_sent(&session_key, project_paths);

        let buf = slot.buf();
        let token = slot.token();
        if let Err(mut child) = slot.attach(child) {
            // Cancelled during the spawn window — the reservation is gone.
            let _ = child.start_kill();
            let _ = app.emit(
                "browse-cancelled",
                BrowseCancelled {
                    browse_id: browse_id.clone(),
                },
            );
            return Err("the consult was cancelled".to_string());
        }

        // Drive inline behind a ceiling so a stuck colleague can't block the
        // calling agent's curl forever.
        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(180),
            drive_agent(&app, &browse_id, &buf, io),
        )
        .await;

        // Above every exit below — including the timeout, whose colleague
        // spent real tokens before it stalled.
        let _ = crate::meter::settle(&self.db, "browse", &buf);

        let outcome = match outcome {
            Ok(v) => v,
            Err(_) => {
                if let Some(mut child) = self
                    .turns
                    .take_owned(&browse_id, token)
                    .and_then(|p| p.child)
                {
                    let _ = child.start_kill();
                }
                let _ = self.db.record_friction(
                    "turn_timeout",
                    Some("browse"),
                    Some(&browse_id),
                    Some("180s consult ceiling"),
                );
                let why = "the colleague took too long to respond".to_string();
                finish_error(&app, &self.db, &browse_id, None, &why);
                return Err(why);
            }
        };

        // Token-matched: a consult draining its stream after a cancel must
        // not reap a successor turn started in the meantime.
        let proc = self.turns.take_owned(&browse_id, token);
        let cancelled = proc.is_none() && outcome.final_text.is_none();
        let exit_ok = reap(proc.and_then(|p| p.child), provider).await;
        keep_session(&self.db, &browse_id, provider, &outcome, resumed);

        if cancelled {
            let _ = app.emit(
                "browse-cancelled",
                BrowseCancelled {
                    browse_id: browse_id.clone(),
                },
            );
            return Err("the consult was cancelled".to_string());
        }
        if let Some(err) = outcome.errored {
            let why = describe_turn_error(&self.db, &browse_id, provider, &err);
            finish_error(&app, &self.db, &browse_id, None, &why);
            return Err(why);
        }
        if let Some(text) = outcome.final_text {
            if text.trim().is_empty() {
                let why = "the colleague produced an empty reply".to_string();
                finish_error(&app, &self.db, &browse_id, None, &why);
                return Err(why);
            }
            let msg = BrowseMessage {
                id: uuid::Uuid::new_v4().to_string(),
                browse_id: browse_id.clone(),
                role: "assistant".to_string(),
                body: text.clone(),
                status: "complete".to_string(),
                created_at: now_millis(),
                backend: Some(provider.backend().to_string()),
                target_browse_id: None,
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
                    backend: provider.backend(),
                },
            );
            return Ok(text);
        }

        let why = if !exit_ok && !outcome.stderr_text.trim().is_empty() {
            let detail: String = outcome.stderr_text.trim().chars().take(500).collect();
            format!("the colleague exited abnormally: {detail}")
        } else if !outcome.saw_json {
            "the colleague produced no parseable output".to_string()
        } else {
            "the colleague ended without producing a reply".to_string()
        };
        finish_error(&app, &self.db, &browse_id, None, &why);
        Err(why)
    }

    /// One turn's launch on its pick's provider. Claude's argv carries the pick
    /// and `--resume`; `add_dirs` widens its read boundary to every known
    /// project (the user's turn does, the consult never has). Codex resumes its
    /// thread with the pick and the thread's usage baseline; its read-only
    /// sandbox already reads anywhere.
    fn launch(
        &self,
        browse_id: &str,
        prompt: String,
        harness: &BrowseHarness,
        prior_session: Option<String>,
        cwd: &str,
        add_dirs: bool,
    ) -> Launch {
        match Provider::of(harness) {
            Provider::Claude => {
                // The agent gets Bash so it can curl the browser endpoints. `--tools` only
                // makes a tool *available*; headless `-p` then auto-denies anything not in
                // `--allowedTools` (there's no one to approve a prompt). So the allow-list
                // below is what actually lets WebSearch/WebFetch run and scopes Bash to the
                // daemon's `curl -s http://127.0.0.1:7676/*` — pinned here so the bridge no
                // longer depends on the global `~/.claude/settings.json` rule (that rule
                // stays a redundant backstop). Read/Grep/Glob are auto-approved, so they
                // need no allow entry. MCP is stripped. Never plan mode.
                // Three prefix rules for the same localhost bridge. The matcher is a
                // literal command-prefix glob, so a quoted URL (`curl -s 'http://…`) does
                // NOT match the unquoted rule. Cross-tab routes carry a `?tab=` query the
                // agent single-quotes to protect the shell `?`/`&` — without the quoted
                // variants those reads fall through to headless auto-deny ("bounced for
                // approval"). All three stay scoped to 127.0.0.1:7676; only quoting
                // widens. The whole block rides the canonical `BRIDGE_INVARIANT_ARGS`
                // ordering so the argv prefix stays byte-stable across surfaces.
                let mut args = claude_turn_args(prompt, harness, prior_session.as_deref());
                // Widen the read boundary to span ALL the user's known projects, not just
                // the single active-folder `cwd`. Each `--add-dir` puts a project inside the
                // workspace so Read/Grep/Glob "just work" there — this is what lets the agent
                // readily look at code in any project while the user researches in the
                // browser. Re-supplied every turn (alongside `--resume`) so the set stays
                // current. Bounded by `code::MAX_PROJECTS`.
                if add_dirs {
                    for dir in crate::code::project_dirs(&self.db) {
                        args.push("--add-dir".to_string());
                        args.push(dir);
                    }
                }
                Launch::Claude(args)
            }
            Provider::Codex => {
                // The app-server reports thread totals, so a resumed thread's
                // meter counts from where its last turn left off.
                let baseline = prior_session
                    .as_ref()
                    .and_then(|_| self.db.get_browse_codex_usage(browse_id))
                    .and_then(|usage| serde_json::from_str(&usage).ok())
                    .unwrap_or(Value::Null);
                Launch::Codex(Box::new(NativeTurn::new(
                    cwd.to_string(),
                    prompt,
                    prior_session,
                    harness.model.clone(),
                    harness.effort.clone(),
                    baseline,
                )))
            }
        }
    }

    /// Spawn one turn's agent in `cwd` and take its pipes.
    async fn spawn_agent(&self, launch: Launch, cwd: &str) -> Result<(Child, AgentIo), String> {
        let (mut child, provider, codex) = match launch {
            Launch::Claude(args) => {
                let claude_bin = self.claude_bin().await?;
                let child = crate::claude_proc::claude_command_for_seat("browse", &claude_bin)
                    .current_dir(cwd)
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
                (child, Provider::Claude, None)
            }
            Launch::Codex(turn) => {
                let codex_bin = tokio::task::spawn_blocking(crate::codex_app_server::resolve_codex_bin)
                    .await
                    .map_err(|e| format!("failed to resolve the `codex` CLI: {e}"))?;
                let child = crate::codex_conversation::bridge_command(&codex_bin, "browse")
                    .current_dir(cwd)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .kill_on_drop(true)
                    .spawn()
                    .map_err(|e| {
                        if e.kind() == std::io::ErrorKind::NotFound {
                            format!(
                                "could not find the `codex` CLI (looked for `{codex_bin}`). \
                                 This chat is set to Codex — install it, point Redline at \
                                 it in Settings, or switch the chat back to Claude."
                            )
                        } else {
                            format!("failed to spawn codex: {e}")
                        }
                    })?;
                (child, Provider::Codex, Some(turn))
            }
        };
        let cli = provider.cli();
        let stdout = child.stdout.take().ok_or_else(|| format!("{cli} stdout unavailable"))?;
        let stderr = child.stderr.take().ok_or_else(|| format!("{cli} stderr unavailable"))?;
        let io = match codex {
            None => AgentIo::Claude { stdout, stderr },
            Some(turn) => {
                let stdin = child.stdin.take().ok_or("codex input unavailable")?;
                AgentIo::Codex { turn, stdin, stdout, stderr }
            }
        };
        Ok((child, io))
    }
}

/// How a consult's question reaches the page agent: as a digest for the
/// Companion, the one caller of the consult route (BC-22), about the tab
/// whose label it names when the tab is open.
fn consult_framing(question: &str, label: Option<&str>) -> String {
    let page = label
        .map(|l| format!(" (target label {}: read it with ?tab={l}, never the tab on screen)", serde_json::to_string(l).unwrap_or_default()))
        .unwrap_or_default();
    format!(
        "The user's Companion — the one conversation that follows them \
         across Redline's surfaces — is checking in with you about THIS \
         tab{page}. Synthesize what matters here for its question as a tight \
         DIGEST (not a transcript, and not a fresh reply to the user). Be \
         concise. Its question:\n\n{}",
        question.trim()
    )
}

/// Link this answer to any research comment waiting on the tab, and tell the
/// plans that hold them.
fn link_research(app: &AppHandle, browse_id: &str, answer: &str) {
    let Some(store) = app.try_state::<crate::state::SessionStore>() else { return };
    for session_id in store.link_research_answer(browse_id, answer) {
        let _ = app.emit("comments-changed", crate::SessionEvent { session_id });
    }
}

// --- Event payloads --------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowseDelta {
    browse_id: String,
    text: String,
    /// This delta's position in the turn's stream — `browse_turn_status`
    /// reports the seq already folded into `partial`, and the frontend drops
    /// any delta at or below that watermark.
    seq: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowseDone {
    browse_id: String,
    message_id: String,
    body: String,
    /// Which provider wrote the reply, for its byline.
    backend: &'static str,
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

/// What the turn is spending and what it is doing. Flattened so the payload
/// reads `{browseId, rev, meter, activity}` — the id field the frontend hook
/// matches on sits at the top level, exactly like every other browse event.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowseMeter {
    browse_id: String,
    #[serde(flatten)]
    meter: turn::MeterPayload,
}

/// A queued send left the queue and became the streaming turn — the frontend
/// flips its bubble's "Queued" chip off.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowseQueueAdvanced {
    browse_id: String,
    message_id: String,
}

/// The first turn's prompt: the agent's role, the live DOM snapshot for instant
/// grounding, how to drive the browser via the local curl endpoints, and the
/// user's message. Follow-up turns send the user's text verbatim (the session
/// already carries this context and can re-`curl /snapshot` for a fresh view).
/// CACHE-STABLE ORDERING — all INVARIANT text (role intro, tool docs, the
/// skill reference) forms one stable prefix, and
/// every VARIABLE section (mission block, page snapshot, the
/// user's message) comes after it. Two first turns differing only in variable
/// inputs share a byte-identical prefix, which is what lets the model-side
/// prompt cache hit across sessions. Same information as before — only the
/// order is pinned. Guarded by `first_turn_invariant_prefix_is_byte_stable`.
fn build_first_turn_prompt(
    snapshot: Option<&str>,
    user_text: &str,
    mission: Option<&Mission>,
    context: &str,
) -> String {
    let mut p = String::from(
        "You are helping the user with the web page open in Redline's embedded \
         browser. You can both discuss the page and drive the browser tab.\n\n",
    );
    p.push_str(
        "You read and act on the user's browser tabs by calling these local \
         endpoints with curl (already permitted — no approval needed). Put the \
         URL immediately after `-s`. Write routes need the bearer token: add \
         `--variable %REDLINE_DAEMON_TOKEN= --expand-header \"Authorization: \
         Bearer {{REDLINE_DAEMON_TOKEN}}\"` after the URL, which imports it \
         straight from the environment — never write `$REDLINE_DAEMON_TOKEN` \
         into the command yourself (requires curl >= 8.3).\n\n\
         Each message ends with the page it was sent against: its captured \
         target label (like `browser-t3`) and scope. That page is the one you \
         act on for the whole turn, even if the user switches tabs meanwhile — \
         never fall back to whichever tab is on screen.\n\n\
         - See a page as it is right now (url, title, selection, text, \
         headings, links, and its `revision`). Pass the target label, or a tab \
         number to look at another tab:\n  \
         curl -s 'http://127.0.0.1:7676/v1/browser/snapshot?tab=<label or n>'\n\
         - List every open tab — your map of the user's tabs. Each has a number \
         `n` (its position in the tab strip, what the USER sees), its `label`, \
         url, title, and which is active:\n  \
         curl -s http://127.0.0.1:7676/v1/browser/tabs\n\
         - Act on a page: navigate, click, fill a field, press a key, scroll, \
         choose an option, or wait for something to appear. Every change goes \
         through this one route, on the captured target label (or the label of \
         a tab you opened this turn). Give each action a fresh `operationId`, \
         and pass `expectedRevision` (the `revision` from your last look) so an \
         action on a page that changed underneath is refused:\n  \
         curl -s http://127.0.0.1:7676/v1/browser/action \
         --variable %REDLINE_DAEMON_TOKEN= \
         --expand-header \"Authorization: Bearer {{REDLINE_DAEMON_TOKEN}}\" -X POST \
         -H 'Content-Type: application/json' -d '{\"operationId\":\"op-1\",\
         \"label\":\"browser-t3\",\"operation\":{\"kind\":\"click\",\"selector\":\"a.next\"}}'\n  \
         Kinds: navigate {url}; click {selector}; fill {selector, value}; \
         key {key, selector?}; scroll {x, y, selector?}; select {selector, \
         value}; wait {selector, text?, visible?}. The reply's `status` is \
         completed, failed or interrupted, with the `observed` page: check it \
         before your next step. Interrupted means the user touched the page or \
         the outcome is unknown, so look again and never repeat a side effect \
         you are unsure landed.\n\
         - Open a URL in a NEW tab and show it (leaves the user's other tabs \
         open; the reply carries the new tab's `label`):\n  \
         curl -s http://127.0.0.1:7676/v1/browser/open \
         --variable %REDLINE_DAEMON_TOKEN= \
         --expand-header \"Authorization: Bearer {{REDLINE_DAEMON_TOKEN}}\" -X POST \
         -H 'Content-Type: application/json' -d '{\"url\":\"https://example.com\"}'\n\
         - Switch the user INTO an existing tab (bring it to the foreground and \
         move them into its conversation) — use when they want to BE in that \
         tab, after you've checked it with ?tab=/thread:\n  \
         curl -s 'http://127.0.0.1:7676/v1/browser/focus?tab=<n>' \
         --variable %REDLINE_DAEMON_TOKEN= \
         --expand-header \"Authorization: Bearer {{REDLINE_DAEMON_TOKEN}}\" -X POST\n\
         - Read another tab's discussion history (what was already discussed \
         there — a cheap way to \"check in\" with that tab without re-deriving \
         it):\n  \
         curl -s 'http://127.0.0.1:7676/v1/browser/thread?tab=<n>'\n\
         - Save a file to disk (defaults to the user's ~/Downloads), then tell \
         them the saved path the route returns. Omit `url` to save the target \
         page; pass `url` to save a specific linked file; pass `dialog:true` to \
         let them choose the location:\n  \
         curl -s 'http://127.0.0.1:7676/v1/browser/download?tab=<label>' \
         --variable %REDLINE_DAEMON_TOKEN= \
         --expand-header \"Authorization: Bearer {{REDLINE_DAEMON_TOKEN}}\" -X POST \
         -H 'Content-Type: application/json' -d '{}'\n\n\
         IMPORTANT: this `/download` route is the ONLY way you can save a file. \
         `curl -o`, `wget`, redirecting to a file, and any other Bash command are \
         auto-denied — never try them. Match the user's words: a named place like \
         \"Downloads\" → `-d '{}'`; \"let me pick\" or no place named → \
         `-d '{\"dialog\":true}'`; a specific link → `-d '{\"url\":\"https://…\"}'`.\n\n\
         Reads take `?tab=`: the target label, or a tab NUMBER from /tabs (e.g. \
         ?tab=2), so you can look at ANY open tab; without it they read \
         whichever tab is on screen. To *check* another tab, like a colleague \
         glancing at a neighbor's screen, read it by number (e.g. \
         snapshot?tab=2, or its /thread) without acting on the user's page. To \
         open something new, use /open (a fresh tab); navigate the target only \
         when the user wants THIS page to go somewhere else.\n\n\
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
    // --- variable content below; nothing invariant may follow ---
    p.push_str(&captured_mission_context_block(mission));
    p.push_str(context);
    if let Some(snap) = snapshot {
        if !snap.trim().is_empty() {
            p.push_str("Here is a snapshot of the page the user is currently viewing:\n\n");
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

/// Read ahead of the browse contract on a Codex first turn. The contract is
/// written for Claude's tool set; Codex reaches the same curl bridge from its
/// own shell (with the same token), and has its own equivalents for the rest.
const CODEX_PREAMBLE: &str = "You are running on Codex, in a read-only sandbox with network \
     access. Run the curl commands below in your shell as written; none of them \
     needs approval. Where these instructions name Claude's tools, use your \
     own: read files and code with shell commands (`rg`, `sed -n`, `ls`, and \
     read-only `git log` / `git diff` / `git show`), look things up with your \
     web search tool, and fetch a URL with `curl -sL`. The sandbox refuses \
     every write, so never try to save a file or change git state yourself — \
     the /download route below is how a file gets saved.\n\n";

/// A first turn's body on `provider`. Claude's is `build_first_turn_prompt`
/// unchanged. Codex has no system-prompt flag, so the same contract rides at
/// the head of its first message, behind the note mapping its tools.
fn first_turn_body(
    provider: Provider,
    snapshot: Option<&str>,
    user_text: &str,
    mission: Option<&Mission>,
    context: &str,
) -> String {
    let body = build_first_turn_prompt(snapshot, user_text, mission, context);
    match provider {
        Provider::Claude => body,
        Provider::Codex => format!("{CODEX_PREAMBLE}{body}"),
    }
}

/// Which provider wrote a reply. Rows from before Codex could run here have
/// none, and were Claude's.
fn reply_backend(message: &BrowseMessage) -> &str {
    message.backend.as_deref().unwrap_or("claude-code")
}

/// The turns `provider`'s session has not seen, as a continuity block for the
/// variable part of the prompt. A fresh session has seen none of the thread
/// but `current` (the user row being answered); a resumed one has seen
/// everything up to its own last reply. They are carried only when another
/// provider wrote some of them, so a chat that never switched — a fresh Claude
/// session after a context reset included — reads exactly as before.
///
/// Every row but `current`, not just the ones stored before it: a message
/// typed while a reply streams is stored when it is queued, so the reply it
/// follows sits after it. Rows still queued behind it are not `complete`, and
/// `continuity_block` skips them.
fn carried_history(thread: &[BrowseMessage], current: &str, provider: Provider, resumed: bool) -> String {
    let others: Vec<&BrowseMessage> = thread.iter().filter(|m| m.id != current).collect();
    let replied = |m: &BrowseMessage| m.role == "assistant" && m.status == "complete";
    let seen = if resumed {
        others
            .iter()
            .rposition(|m| replied(m) && reply_backend(m) == provider.backend())
            .map_or(0, |last| last + 1)
    } else {
        0
    };
    let unseen = &others[seen..];
    if !unseen.iter().any(|m| replied(m) && reply_backend(m) != provider.backend()) {
        return String::new();
    }
    crate::fork::continuity_block(unseen)
        .map(|block| format!("{block}\n"))
        .unwrap_or_default()
}

// --- Commands --------------------------------------------------------------

/// A first-turn snapshot can finish after the same conversation moves to a
/// different workspace. Resolve the captured owner, never a newer active goal.
/// Missing workspace IDs retain the legacy active-mission fallback. Regular
/// browsing and a Mosaic (`mosaic:<id>`) are workspaces with no mission.
fn captured_browse_mission(
    db: &Database,
    workspace_id: Option<&str>,
    legacy_active_id: Option<&str>,
) -> Result<Option<Mission>, String> {
    let id = match workspace_id {
        Some("regular") => return Ok(None),
        Some(id) if id.starts_with("mosaic:") => return Ok(None),
        Some(id) if id.trim().is_empty() => return Err("Workspace ID cannot be empty".into()),
        Some(id) => Some(id),
        None => legacy_active_id,
    };
    let Some(id) = id else { return Ok(None) };
    db.get_mission(id)
        .map_err(|e| format!("Failed to read captured mission: {e}"))?
        .map(Some)
        .ok_or_else(|| "The captured mission no longer exists; send again from the intended workspace".into())
}

/// Send a turn to a tab's browse agent. The first turn starts a fresh `claude`
/// session (capturing its id); later turns resume it. Streaming happens via
/// `browse-*` events — this returns as soon as the child is spawned, or with
/// `queued: true` when the send opted in (`queue`) and landed behind an
/// in-flight turn.
#[tauri::command]
pub async fn browse_send(
    browse: tauri::State<'_, BrowseState>,
    app: AppHandle,
    browse_id: String,
    text: String,
    snapshot: Option<String>,
    cwd: Option<String>,
    queue: Option<bool>,
    target_label: Option<String>,
    following_tabs: Option<bool>,
    workspace_id: Option<String>,
) -> Result<SendOutcome, String> {
    if text.trim().is_empty() {
        return Err("empty message".to_string());
    }
    let message_id = uuid::Uuid::new_v4().to_string();
    let active_id = app.state::<crate::ActiveMission>().active_id();
    let mission = captured_browse_mission(&browse.db, workspace_id.as_deref(), active_id.as_deref())?;
    let target_browse_id = target_label.as_deref().and_then(|label| tab_browse_id(&app, label));
    let payload = QueuedBrowseSend {
        message_id: message_id.clone(),
        text: text.clone(),
        snapshot,
        cwd,
        target_label,
        target_browse_id: target_browse_id.clone(),
        following_tabs: following_tabs.unwrap_or(false),
        mission,
    };

    // The reservation is atomic and spans the whole spawn; early `?` returns
    // release it via the guard's Drop, so a failed send can't strand a
    // phantom "streaming" tab. Only opted-in sends queue behind a busy slot —
    // the busy error stays for everything else (it is load-bearing flow
    // control for the consult paths).
    let (slot, payload) = if queue.unwrap_or(false) {
        let turn = QueuedTurn {
            message_id: message_id.clone(),
            text: text.clone(),
            queued_at: now_millis(),
        };
        match browse.turns.begin_or_enqueue(&browse_id, turn, payload) {
            SendSlot::Began(slot, payload) => (slot, payload),
            SendSlot::Enqueued => {
                // Persist the queued user row so a remount restores the
                // bubble; the reader's drain flips it to `complete`.
                let user_msg = BrowseMessage {
                    id: message_id.clone(),
                    browse_id,
                    role: "user".to_string(),
                    body: text,
                    status: "queued".to_string(),
                    created_at: now_millis(),
                    backend: None,
                    target_browse_id,
                };
                browse
                    .db
                    .insert_browse_message(&user_msg)
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
        let slot = browse
            .turns
            .begin(&browse_id)
            .map_err(|_| "a reply is still streaming for this tab".to_string())?;
        (slot, payload)
    };

    // Persist the user turn (a terminal row).
    let user_msg = BrowseMessage {
        id: message_id.clone(),
        browse_id: browse_id.clone(),
        role: "user".to_string(),
        body: text,
        status: "complete".to_string(),
        created_at: now_millis(),
        backend: None,
        target_browse_id,
    };
    browse
        .db
        .insert_browse_message(&user_msg)
        .map_err(|e| format!("failed to persist message: {e}"))?;

    start_browse_turn(app, browse.inner().clone(), browse_id, payload, slot).await?;
    Ok(SendOutcome {
        started: true,
        queued: false,
        message_id,
    })
}

/// The argv for one of this chat's Claude turns: the shared bridge block, the
/// `browse` seat's flag tail with the chat's own model/effort pick laid on top,
/// then `--resume`. A different `--model` on `--resume` is fine on Claude, so a
/// pick never costs the session. The turn and the consult both build here, so
/// a pick applies to both.
fn claude_turn_args(
    prompt: String,
    harness: &BrowseHarness,
    prior_session: Option<&str>,
) -> Vec<String> {
    bridge_args_with_flags(
        prompt,
        prior_session,
        crate::seat::flag_args_override(
            "browse",
            harness.model.as_deref(),
            harness.effort.as_deref(),
        ),
    )
}

/// The session this chat resumes on `provider`: its own, never the other
/// provider's. Neither CLI rejects a foreign id, so a Claude `--resume` of a
/// Codex thread (or the reverse) would fail or open something unrelated.
/// Switching back to a provider resumes the session it left.
fn resume_id(db: &Database, browse_id: &str, provider: Provider) -> Option<String> {
    match provider {
        Provider::Claude => db.get_browse_session(browse_id),
        Provider::Codex => db.get_browse_codex_thread(browse_id),
    }
}

/// The model the ledger files a turn under: the one that will answer it. A
/// Codex chat on its default has no name to file — the `browse` seat's model
/// is a Claude one.
fn ledger_model(provider: Provider, harness: &BrowseHarness) -> Option<String> {
    match provider {
        Provider::Claude => crate::seat::model_for_override(
            "browse",
            harness.model.as_deref(),
            harness.effort.as_deref(),
        ),
        Provider::Codex => harness.model.clone(),
    }
}

/// Keep what a finished turn established on its provider. A session is kept
/// once it has answered: a first turn that failed leaves nothing worth
/// resuming, and the next one re-sends its snapshot (the frontend's
/// first-turn rule relies on exactly this). A resumed Codex thread also takes
/// its new usage total on any ending, so the next meter counts only its own
/// tokens — but only while that thread is still the stored one: a turn
/// killed by "Clear history" ends after its row is gone, and must not bring
/// the thread back for the cleared chat to resume.
fn keep_session(db: &Database, browse_id: &str, provider: Provider, outcome: &StreamOutcome, resumed: bool) {
    let Some(session) = &outcome.session else { return };
    let answered = outcome.errored.is_none()
        && outcome.final_text.as_ref().is_some_and(|text| !text.trim().is_empty());
    let usage = || outcome.usage.clone().unwrap_or_default().to_string();
    let kept = match provider {
        Provider::Claude if answered => db.set_browse_session(browse_id, session),
        Provider::Codex if answered => db.set_browse_codex_thread(browse_id, session, &usage()),
        Provider::Codex if resumed => db.set_browse_codex_usage(browse_id, session, &usage()),
        _ => Ok(()),
    };
    if let Err(e) = kept {
        tracing::warn!(error = %e, "failed to persist the browse session");
    }
}

/// Clean and check a chat's pick before it is stored. A save is always a
/// pick, so a missing provider stores as `claude-code`: that is what keeps an
/// explicit "Default" from reading as "never picked".
///
/// A Claude model is checked strictly and the effort permissively, as
/// `fork_thread_set_model` does: a bad `--model` fails the spawn outright, a
/// bad `--effort` only warns. Codex's models come from its live catalog,
/// which the picker offers, so only the slug's shape is checked here — and a
/// Claude alias, the mark of a pick carried across providers, is refused. Its
/// efforts are per model, and pass through.
fn validate_harness(
    backend: Option<String>,
    model: Option<String>,
    effort: Option<String>,
) -> Result<BrowseHarness, String> {
    let clean = |value: Option<String>| {
        value
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    let (model, effort) = (clean(model), clean(effort));
    let provider = match clean(backend).as_deref() {
        None | Some("claude-code") => Provider::Claude,
        Some("codex") => Provider::Codex,
        Some(other) => return Err(format!("unknown provider `{other}`")),
    };
    match provider {
        Provider::Claude => {
            if let Some(model) = model.as_deref() {
                if !crate::seat::MODEL_OPTIONS.contains(&model) {
                    return Err(format!("unknown Claude model `{model}`"));
                }
            }
            if let Some(effort) = effort.as_deref() {
                if !crate::seat::EFFORT_OPTIONS.contains(&effort) {
                    tracing::warn!(effort, "browse chat: passing through an unrecognized effort");
                }
            }
        }
        Provider::Codex => {
            if let Some(model) = model.as_deref() {
                let slug = model.len() <= 128
                    && model.chars().all(|c| c.is_ascii_alphanumeric() || "-._:/".contains(c));
                if !slug || crate::seat::MODEL_OPTIONS.contains(&model) {
                    return Err(format!("unknown Codex model `{model}`"));
                }
            }
        }
    }
    Ok(BrowseHarness {
        backend: Some(provider.backend().to_string()),
        model,
        effort,
    })
}

/// The `browse_id` of the tab whose webview is `label`, from the frontend's
/// mirrored tab list (suspended tabs included). `None` for a label no open
/// tab has.
fn tab_browse_id(app: &AppHandle, label: &str) -> Option<String> {
    app.try_state::<crate::BrowserTabs>()?
        .get()
        .into_iter()
        .find(|tab| tab.label == label)
        .map(|tab| tab.browse_id)
}

/// How a turn's tail names its scope: a tab's own chat is pinned to its page,
/// a shared chat follows the tab on screen (`contract.json` `scopePhrases`).
fn scope_phrase(following_tabs: bool) -> &'static str {
    if following_tabs { "following tabs (same conversation)" } else { "pinned page" }
}

/// Every turn's tail: the page, scope and workspace captured when the user
/// sent it, which the turn acts on however the screen changes meanwhile
/// (BC-12, BC-13, BC-19).
fn turn_target_block(label: &str, following_tabs: bool, mission_id: Option<&str>) -> String {
    let target = serde_json::to_string(label).unwrap_or_default();
    let mut tail = format!("\n\nBrowser context captured when this message was sent: target label {target}; conversation scope: {}. This remains the action target if the user changes tabs during this turn. Resolve this stable label against /v1/browser/tabs before acting; do not fall back to the globally active tab. Use explicit ?tab= selectors for reads and POST /v1/browser/action for mutations with operationId, label, expectedRevision, operation. Supported kinds: navigate, click, fill, key, scroll, select, wait. Check the returned status and observed state. Never replay an uncertain side effect automatically.\n", scope_phrase(following_tabs));
    if let Some(id) = mission_id {
        tail.push_str(&format!("Captured mission/workspace ID: {id}. Read its goal and findings through GET /v1/missions/{id} and /v1/missions/{id}/findings. Do not substitute the globally active mission during this turn.\n"));
    } else {
        tail.push_str("Captured workspace: no mission (regular browsing or a Mosaic). Do not inherit a mission activated after this message was sent.\n");
    }
    tail
}

/// Everything a turn needs after its user row is persisted: prompt framing,
/// ledger capture, args, spawn, attach, reader. Runs on the direct send path
/// AND on the reader's queue drain — which is why the session resume is read
/// here, at start time: a drained turn must resume the session the turn
/// ahead of it just established. Boxed return: see `turn::BoxStartFuture`.
fn start_browse_turn(
    app: AppHandle,
    browse: BrowseState,
    browse_id: String,
    payload: QueuedBrowseSend,
    slot: turn::SlotGuard<QueuedBrowseSend>,
) -> turn::BoxStartFuture {
    Box::pin(async move {
        let QueuedBrowseSend {
            message_id,
            text,
            snapshot,
            cwd,
            target_label,
            target_browse_id,
            following_tabs,
            mission,
        } = payload;
        // Held live until the turn ends, whether or not it is on screen.
        browse.record_target(&browse_id, target_label.as_deref());
        // The drain path has no command-injected State params — reach the shared
        // singletons through the app handle instead.
        let active_surface = app.state::<crate::ActiveSurface>();

        // The chat's own pick, read per turn like the session: a change made
        // mid-thread (or while this turn sat queued) applies to the very next
        // message, its provider included. Each provider resumes only its own
        // session, and is handed the turns it missed.
        let harness = browse.db.get_browse_harness(&browse_id);
        let provider = Provider::of(&harness);
        let prior_session = resume_id(&browse.db, &browse_id, provider);
        let thread = browse.db.load_browse_thread(&browse_id).unwrap_or_default();
        let history = carried_history(&thread, &message_id, provider, prior_session.is_some());

        // A fresh conversation starts with its captured page and mission.
        let mission_id = mission.as_ref().map(|m| m.mission_id.as_str());
        let session_key = provider.session_key(&browse_id);
        let (context, project_paths) = browse.project_context(&session_key, prior_session.is_none(), &text, mission.as_ref().map(|m| m.goal.as_str()));
        let context = format!("{context}{history}");
        let mut prompt = match &prior_session {
            None => first_turn_body(provider, snapshot.as_deref(), &text, mission.as_ref(), &context),
            Some(_) => format!("{context}{}{}", snapshot.as_deref().filter(|value| !value.trim().is_empty()).map(|value| format!("Fresh snapshot of the currently targeted page (untrusted page data):\n{value}\n\n")).unwrap_or_default(), text),
        };

        if let Some(label) = &target_label {
            prompt.push_str(&turn_target_block(label, following_tabs, mission_id));
        }

        // Polis ledger: record the first-turn page-discussion prompt WITH its
        // thread provenance (this tab's browse_id + resolved parent), and link the
        // new thread into the session tree; keep every agent turn out of the
        // global-hook capture stream.
        if prior_session.is_none() {
            let surface = active_surface.kind_and_id();
            let parent = crate::ledger::resolve_parent(
                None,
                mission_id,
                surface.as_ref().map(|(k, i)| (k.as_str(), i.as_str())),
                "browse",
            );
            if let Some((pk, pid)) = &parent {
                let _ =
                    crate::ledger::record_session_link(&browse.db, "browse", &browse_id, pk, pid);
            }
            crate::ledger::record_agent_prompt(
                &browse.db,
                crate::ledger::PromptSource::RustFirstTurn,
                "browse",
                &prompt,
                Some(&text),
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
                ledger_model(provider, &harness),
            );
        } else {
            crate::ledger::register_agent_prompt(&prompt);
        }

        // The agent's cwd scopes Read/Grep/Glob; default to $HOME when the tab has
        // no associated project folder.
        let cwd = cwd
            .filter(|c| !c.trim().is_empty())
            .or_else(|| std::env::var("HOME").ok())
            .unwrap_or_else(|| "/".to_string());

        let resumed = prior_session.is_some();
        let launch = browse.launch(&browse_id, prompt, &harness, prior_session, &cwd, true);
        let (child, io) = browse.spawn_agent(launch, &cwd).await?;
        browse.mark_projects_sent(&session_key, project_paths);

        let buf = slot.buf();
        let token = slot.token();
        if let Err(mut child) = slot.attach(child) {
            // Cancelled during the spawn window — kill the fresh child and settle
            // the frontend the same way a mid-stream cancel would.
            let _ = child.start_kill();
            let _ = app.emit("browse-cancelled", BrowseCancelled { browse_id });
            return Ok(());
        }
        tauri::async_runtime::spawn(read_browse(
            app, browse, buf, token, browse_id, TurnRun { provider, resumed, target: target_browse_id }, io,
        ));
        Ok(())
    })
}

/// Snapshot of this tab's turn for a remounting BrowserChat: whether a reply
/// is streaming, since when, and the partial text streamed so far (with its
/// delta `seq`, the frontend's dedupe watermark).
#[tauri::command]
pub fn browse_turn_status(browse: tauri::State<'_, BrowseState>, browse_id: String) -> TurnStatus {
    browse.turns.status(&browse_id)
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

/// This chat's own provider/model/effort pick (all `None`: never picked, the
/// `browse` seat applies).
#[tauri::command]
pub fn browse_thread_harness(
    browse: tauri::State<'_, BrowseState>,
    browse_id: String,
) -> BrowseHarness {
    browse.db.get_browse_harness(&browse_id)
}

/// Set this chat's pick. It takes effect on the next turn, which reads it at
/// start, so a change mid-reply never touches the reply in flight.
#[tauri::command]
pub fn browse_thread_set_harness(
    browse: tauri::State<'_, BrowseState>,
    browse_id: String,
    backend: Option<String>,
    model: Option<String>,
    effort: Option<String>,
) -> Result<(), String> {
    if browse_id.trim().is_empty() {
        return Err("no chat to set the model on".to_string());
    }
    let harness = validate_harness(backend, model, effort)?;
    browse
        .db
        .set_browse_harness(&browse_id, &harness)
        .map_err(|e| format!("failed to set the model: {e}"))
}

/// Kill the in-flight turn for a tab, if any. `read_browse` then sees the key
/// already gone and emits `browse-cancelled`. Queued sends stay queued — the
/// reader's terminal drain advances them.
#[tauri::command]
pub fn browse_cancel(
    browse: tauri::State<'_, BrowseState>,
    browse_id: String,
) -> Result<(), String> {
    if let Some(mut child) = browse.turns.take(&browse_id).and_then(|p| p.child) {
        let _ = child.start_kill();
    }
    Ok(())
}

/// Remove a queued send (the bubble's ×). Returns its text so the composer
/// can restore it; `None` when the send already advanced. The persisted
/// queued row goes with it.
#[tauri::command]
pub fn browse_unqueue(
    browse: tauri::State<'_, BrowseState>,
    browse_id: String,
    message_id: String,
) -> Result<Option<String>, String> {
    let Some(turn) = browse.turns.unqueue(&browse_id, &message_id) else {
        return Ok(None);
    };
    if let Err(e) = browse.db.delete_thread_message("browse", &message_id) {
        tracing::warn!(error = %e, "failed to delete the unqueued browse row");
    }
    Ok(Some(turn.text))
}

/// Discard a tab's whole thread: kill any in-flight turn, drop any queued
/// sends, delete its persisted messages, and forget its agent session.
#[tauri::command]
pub fn browse_discard(
    browse: tauri::State<'_, BrowseState>,
    browse_id: String,
) -> Result<(), String> {
    if let Some(mut child) = browse.turns.discard(&browse_id).and_then(|p| p.child) {
        let _ = child.start_kill();
    }
    {
        let mut sent = browse.sent_projects.lock().unwrap();
        for provider in [Provider::Claude, Provider::Codex] {
            sent.remove(&provider.session_key(&browse_id));
        }
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

/// How a browse turn's agent starts.
enum Launch {
    /// `claude -p …`, the whole argv.
    Claude(Vec<String>),
    /// `codex app-server`, driven over stdin by this turn's protocol state.
    Codex(Box<NativeTurn>),
}

/// A spawned agent's pipes, and for Codex the protocol state that reads them.
enum AgentIo {
    Claude {
        stdout: ChildStdout,
        stderr: ChildStderr,
    },
    Codex {
        turn: Box<NativeTurn>,
        stdin: ChildStdin,
        stdout: ChildStdout,
        stderr: ChildStderr,
    },
}

/// Which provider a turn ran on, whether it resumed a session, and the tab it
/// was sent against.
struct TurnRun {
    provider: Provider,
    resumed: bool,
    /// Kept on the turn's reply (or error) row.
    target: Option<String>,
}

/// What one agent stream produced. Shared by the turn and the consult.
#[derive(Default)]
struct StreamOutcome {
    /// The Claude session or Codex thread the turn ran on.
    session: Option<String>,
    final_text: Option<String>,
    errored: Option<String>,
    saw_json: bool,
    stderr_text: String,
    /// Codex: the thread's usage total after the turn — the app-server
    /// reports thread totals, so this is the next turn's meter baseline.
    usage: Option<Value>,
}

/// Stream one turn's agent to completion on its provider. Shared by
/// `read_browse` (spawned, fire-and-forget) and `BrowseState::consult`
/// (awaited inline so the caller gets the digest back synchronously).
async fn drive_agent(
    app: &AppHandle,
    browse_id: &str,
    buf: &Mutex<PartialBuf>,
    io: AgentIo,
) -> StreamOutcome {
    match io {
        AgentIo::Claude { stdout, stderr } => {
            drive_browse_stream(app, browse_id, buf, stdout, stderr).await
        }
        AgentIo::Codex { turn, stdin, stdout, stderr } => {
            drive_codex_process(app, browse_id, buf, *turn, stdin, stdout, stderr).await
        }
    }
}

/// Stream one browse child's stdout/stderr to completion, emitting
/// `browse-delta` events as assistant text arrives.
async fn drive_browse_stream(
    app: &AppHandle,
    browse_id: &str,
    buf: &Mutex<PartialBuf>,
    stdout: ChildStdout,
    stderr: ChildStderr,
) -> StreamOutcome {
    let stdout_fut = async {
        let mut reader = BufReader::new(stdout).lines();
        let mut session: Option<String> = None;
        let mut final_text: Option<String> = None;
        let mut errored: Option<String> = None;
        let mut saw_json = false;
        let mut pacer = turn::MeterPacer::default();
        let mut deltas = turn::DeltaPacer::default();
        // Append-before-emit (see `turn::push_delta`), one coalesced chunk at
        // a time.
        let emit_delta = |text: String| {
            let seq = turn::push_delta(buf, &text);
            let _ = app.emit(
                "browse-delta",
                BrowseDelta {
                    browse_id: browse_id.to_string(),
                    text,
                    seq,
                },
            );
        };
        while let Ok(Some(line)) = turn::next_line(&mut reader, &mut deltas, &emit_delta).await {
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
            crate::inspect::capture("browse", browse_id, trimmed);
            // Second pass over the same value — the meter reads what
            // `classify_line` throws away. Mutate-then-emit, coalesced.
            if let Some(payload) = turn::push_meta(buf, &v) {
                if pacer.due(&payload) {
                    let _ = app.emit(
                        "browse-meter",
                        BrowseMeter {
                            browse_id: browse_id.to_string(),
                            meter: payload,
                        },
                    );
                }
            }
            match classify_line(&v) {
                StreamLine::Init(sid) => session = Some(sid),
                StreamLine::Delta(text) => deltas.push(&text, &emit_delta),
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
        // The terminal events follow this drive; the reply is whole first.
        deltas.flush(&emit_delta);
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
    StreamOutcome { session, final_text, errored, saw_json, stderr_text, usage: None }
}

/// One live update from a Codex turn, for whoever is watching: the app's
/// `browse-*` events in production, a recorder in tests.
enum Live {
    Delta { text: String, seq: u64 },
    Meter(turn::MeterPayload),
}

/// How long a Codex app-server may stay silent: briefly while its turn
/// starts, a long tool call's worth once it runs. The app-server never exits
/// on its own, so without a ceiling a wedged one would hold the tab forever.
const CODEX_START_SILENCE: std::time::Duration = std::time::Duration::from_secs(45);
const CODEX_TURN_SILENCE: std::time::Duration = std::time::Duration::from_secs(600);

/// The Codex half of `drive_agent`: one app-server turn, from `initialize` to
/// `turn/completed` (or the first failure). `NativeTurn` answers the protocol
/// and scopes events to this thread and turn; its deltas are real streaming
/// text. Returning drops `stdin`, which lets the app-server exit.
async fn drive_codex<R, W>(
    browse_id: &str,
    buf: &Mutex<PartialBuf>,
    mut turn: NativeTurn,
    mut stdin: W,
    stdout: R,
    live: impl Fn(Live) + Sync,
) -> StreamOutcome
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut out = StreamOutcome::default();
    // Whether the app-server was asked to reopen this chat's stored thread.
    let mut resume_sent = false;
    if let Err(error) = write_native(&mut stdin, &NativeTurn::initialize()).await {
        out.errored = Some(error);
        return out;
    }
    let mut lines = BufReader::new(stdout).lines();
    let mut deltas = turn::DeltaPacer::default();
    // Append-before-emit (see `turn::push_delta`), one coalesced chunk at a
    // time.
    let emit_delta = |text: String| {
        let seq = turn::push_delta(buf, &text);
        live(Live::Delta { text, seq });
    };
    loop {
        let silence = if turn.turn_id.is_none() { CODEX_START_SILENCE } else { CODEX_TURN_SILENCE };
        let next = turn::next_line(&mut lines, &mut deltas, &emit_delta);
        let line = match tokio::time::timeout(silence, next).await {
            Ok(Ok(Some(line))) => line,
            // A Stop kills the app-server, and the reader's cancel check runs
            // before this error is ever shown.
            Ok(Ok(None)) => {
                out.errored = Some("Codex ended before completing the response".into());
                break;
            }
            Ok(Err(e)) => {
                out.errored = Some(format!("Codex connection failed: {e}"));
                break;
            }
            Err(_) => {
                out.errored = Some(
                    "Codex stopped responding. Your conversation is saved; send your message again in a moment."
                        .into(),
                );
                break;
            }
        };
        let trimmed = line.trim();
        let Ok(v) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        out.saw_json = true;
        crate::inspect::capture("browse", browse_id, trimmed);
        let step = turn.observe(&v);
        for request in &step.writes {
            resume_sent |= request["method"] == "thread/resume";
            if let Err(error) = write_native(&mut stdin, request).await {
                out.errored = Some(error);
                break;
            }
        }
        if out.errored.is_some() {
            break;
        }
        if let Some(thread) = step.thread {
            out.session = Some(thread);
        }
        if let Some(text) = step.delta {
            deltas.push(&text, &emit_delta);
        }
        if let Some(payload) = push_codex_meta(buf, step.meter, step.activity) {
            live(Live::Meter(payload));
        }
        if let Some(error) = step.error {
            // A resume the app-server refused can't be retried into. Saying
            // so in the shared vocabulary's words lets `describe_turn_error`
            // forget the thread and tell the user.
            out.errored = Some(if resume_sent && out.session.is_none() {
                format!("No conversation found: {error}")
            } else {
                error
            });
            break;
        }
        if step.final_text.is_some() {
            out.final_text = step.final_text;
        }
        if turn.completed {
            break;
        }
    }
    // Every exit above — completed, failed, hung up, silent — ends here, and
    // the terminal events follow: the reply is whole first.
    deltas.flush(&emit_delta);
    out.usage = Some(turn.total_usage);
    out
}

/// `drive_codex` on a spawned app-server: its live updates become `browse-*`
/// events, and stderr is drained alongside (a full pipe must never stall the
/// turn), keeping a short tail for a failure's error text.
async fn drive_codex_process(
    app: &AppHandle,
    browse_id: &str,
    buf: &Mutex<PartialBuf>,
    turn: NativeTurn,
    stdin: ChildStdin,
    stdout: ChildStdout,
    stderr: ChildStderr,
) -> StreamOutcome {
    let mut tail = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut tail = std::collections::VecDeque::new();
        while let Ok(Some(line)) = lines.next_line().await {
            tail.push_back(line.chars().take(1_000).collect::<String>());
            if tail.len() > 16 {
                tail.pop_front();
            }
        }
        tail.into_iter().collect::<Vec<_>>().join("\n")
    });
    let mut out = drive_codex(browse_id, buf, turn, stdin, stdout, |live| match live {
        Live::Delta { text, seq } => {
            let _ = app.emit(
                "browse-delta",
                BrowseDelta { browse_id: browse_id.to_string(), text, seq },
            );
        }
        Live::Meter(meter) => {
            let _ = app.emit(
                "browse-meter",
                BrowseMeter { browse_id: browse_id.to_string(), meter },
            );
        }
    })
    .await;
    // With stdin closed the app-server exits, and stderr closes with it. A
    // finished reply never waits on the tail; the drain runs on regardless.
    if out.errored.is_some() || out.final_text.is_none() {
        out.stderr_text = match tokio::time::timeout(std::time::Duration::from_secs(2), &mut tail).await {
            Ok(Ok(text)) => text,
            _ => {
                tail.abort();
                String::new()
            }
        };
    }
    out
}

/// Write one JSON-RPC line to a Codex app-server.
async fn write_native<W: AsyncWrite + Unpin>(stdin: &mut W, value: &Value) -> Result<(), String> {
    let wire = format!("{value}\n");
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        stdin.write_all(wire.as_bytes()).await?;
        stdin.flush().await
    })
    .await
    .map_err(|_| "Codex protocol write timed out".to_string())?
    .map_err(|e| format!("Codex protocol connection closed: {e}"))
}

/// `turn::push_meta` for a Codex step. `NativeTurn` computes the meter itself
/// (usage, tool calls, rate limits), so the buffer takes it whole, and the
/// step's activity label joins the ring under the kind it describes. Same
/// mutate-then-emit order, and `rev` stays monotone across both sources.
fn push_codex_meta(
    buf: &Mutex<PartialBuf>,
    meter: Option<crate::meter::TurnMeter>,
    label: Option<String>,
) -> Option<turn::MeterPayload> {
    if meter.is_none() && label.is_none() {
        return None;
    }
    let mut b = buf.lock().unwrap();
    let before = b.meter.clone();
    if let Some(mut meter) = meter {
        meter.rev = meter.rev.max(before.rev + 1);
        b.meter = meter;
    }
    let kind = if b.meter.rate_limited.is_some() && b.meter.rate_limited != before.rate_limited {
        "rateLimit"
    } else if b.meter.tool_calls > before.tool_calls {
        "tool"
    } else {
        "requesting"
    };
    let activity = label
        .map(|label| crate::meter::Activity { at: now_millis(), kind: kind.to_string(), label })
        .filter(|a| {
            b.activity
                .back()
                .is_none_or(|last| last.kind != a.kind || last.label != a.label)
        });
    if let Some(a) = &activity {
        if b.activity.len() >= turn::ACTIVITY_CAP {
            b.activity.pop_front();
        }
        b.activity.push_back(a.clone());
        if b.meter.rev == before.rev {
            b.meter.bump_rev();
        }
    } else if b.meter.rev == before.rev {
        return None;
    }
    Some(turn::MeterPayload {
        rev: b.meter.rev,
        meter: b.meter.clone(),
        activity,
        discrete: true,
    })
}

/// Reap a finished turn's process. A Claude child has already exited (its
/// stdout closed). A Codex app-server outlives its turn and exits once its
/// stdin closes, so that wait is bounded and a straggler is killed.
async fn reap(child: Option<Child>, provider: Provider) -> bool {
    let Some(mut child) = child else { return false };
    match provider {
        Provider::Claude => child.wait().await.map(|s| s.success()).unwrap_or(false),
        Provider::Codex => match tokio::time::timeout(std::time::Duration::from_secs(2), child.wait()).await {
            Ok(status) => status.map(|s| s.success()).unwrap_or(false),
            Err(_) => {
                let _ = child.kill().await;
                false
            }
        },
    }
}

/// Drive one browse turn: stream stdout JSONL → `browse-delta` events, then
/// reap the child and emit a terminal `browse-done` / `browse-error` /
/// `browse-cancelled`, and drain the send queue. Mirrors `fork::read_fork`.
async fn read_browse(
    app: AppHandle,
    browse: BrowseState,
    buf: Arc<Mutex<PartialBuf>>,
    token: u64,
    browse_id: String,
    run: TurnRun,
    io: AgentIo,
) {
    let db = browse.db.clone();
    let outcome = drive_agent(&app, &browse_id, &buf, io).await;
    let TurnRun { provider, resumed, target } = run;
    let target = target.as_deref();
    let cli = provider.cli();

    // ABOVE the terminal branch, so success, error and cancelled all book.
    // A cancelled turn spent its input tokens too.
    let settled = crate::meter::settle(&db, "browse", &buf);
    if !settled.is_empty() {
        let _ = app.emit(
            "browse-meter",
            BrowseMeter {
                browse_id: browse_id.clone(),
                meter: turn::MeterPayload {
                    rev: settled.rev,
                    meter: settled.clone(),
                    activity: None,
                    discrete: true,
                },
            },
        );
    }

    // Reap the proc + pop the queue in ONE critical section, BEFORE emitting
    // the terminal event. Token-matched: a reader outliving a cancel must
    // neither steal a successor turn's proc nor drain its queue.
    let (proc, next) = browse.turns.finish_and_pop(&browse_id, token);
    let cancelled = proc.is_none() && outcome.final_text.is_none();
    let exit_ok = reap(proc.and_then(|p| p.child), provider).await;
    // Before the terminal branch, so an error that resets the session
    // (`describe_turn_error`) has the last word.
    keep_session(&db, &browse_id, provider, &outcome, resumed);

    'terminal: {
        if cancelled {
            let _ = app.emit(
                "browse-cancelled",
                BrowseCancelled {
                    browse_id: browse_id.clone(),
                },
            );
            break 'terminal;
        }
        if let Some(err) = outcome.errored {
            // Transient API errors keep the session and ask for a retry; only an
            // explicit context overflow resets the session to start fresh.
            let why = describe_turn_error(&db, &browse_id, provider, &err);
            let row = finish_error(&app, &db, &browse_id, target, &why);
            crate::meter::attach(&db, "browse", &row, &settled);
            break 'terminal;
        }
        if let Some(text) = outcome.final_text {
            if text.trim().is_empty() {
                let row =
                    finish_error(&app, &db, &browse_id, target, &format!("{cli} produced an empty reply"));
                crate::meter::attach(&db, "browse", &row, &settled);
                break 'terminal;
            }
            let msg = BrowseMessage {
                id: uuid::Uuid::new_v4().to_string(),
                browse_id: browse_id.clone(),
                role: "assistant".to_string(),
                body: text.clone(),
                status: "complete".to_string(),
                created_at: now_millis(),
                backend: Some(provider.backend().to_string()),
                target_browse_id: target.map(str::to_string),
            };
            if let Err(e) = db.insert_browse_message(&msg) {
                tracing::warn!(error = %e, "failed to persist assistant message");
            }
            // The badge and the footer outlive the turn.
            crate::meter::attach(&db, "browse", &msg.id, &settled);
            // Companion journal: this tab's agent completed a turn.
            let _ = db.append_journal("agent_turn", Some("browse"), Some(&browse_id), None, None);
            // A research comment (Search from the plan) waiting on this tab's
            // first answer now links to it — before the event, so a plan
            // reloading on `comments-changed` sees the hash.
            link_research(&app, &browse_id, &text);
            let _ = app.emit(
                "browse-done",
                BrowseDone {
                    browse_id: browse_id.clone(),
                    message_id: msg.id,
                    body: text,
                    backend: provider.backend(),
                },
            );
            break 'terminal;
        }

        let why = if !exit_ok && !outcome.stderr_text.trim().is_empty() {
            let detail: String = outcome.stderr_text.trim().chars().take(500).collect();
            format!("{cli} exited abnormally: {detail}")
        } else if !outcome.saw_json {
            format!("{cli} produced no parseable output")
        } else {
            format!("{cli} ended without producing a reply")
        };
        let row = finish_error(&app, &db, &browse_id, target, &why);
        crate::meter::attach(&db, "browse", &row, &settled);
    }

    // Drain: `finish_and_pop` already re-reserved the slot for the queue
    // head, so no concurrent send can slip in between the terminal above and
    // the start below.
    if let Some((queued, payload, slot)) = next {
        let queued_target = payload.target_browse_id.clone();
        if let Err(e) = db.set_thread_message_status("browse", &queued.message_id, "complete") {
            tracing::warn!(error = %e, "failed to flip a drained browse row");
        }
        let _ = app.emit(
            "browse-queue-advanced",
            BrowseQueueAdvanced {
                browse_id: browse_id.clone(),
                message_id: queued.message_id.clone(),
            },
        );
        if let Err(e) = start_browse_turn(
            app.clone(),
            browse.clone(),
            browse_id.clone(),
            payload,
            slot,
        )
        .await
        {
            // The slot released via the guard's Drop. Flip the row so the UI
            // offers "wasn't sent — resend"; no chain-drain (predictable
            // failure behavior beats a cascade).
            let _ = db.set_thread_message_status("browse", &queued.message_id, "unsent");
            finish_error(
                &app,
                &db,
                &browse_id,
                queued_target.as_deref(),
                &format!("your queued message wasn't sent: {e}"),
            );
        }
    }
}

/// Translate a failed browse turn into the sentence to show, and reset the
/// tab's stored session on the provider that failed when the error says the
/// context overflowed (or the conversation is gone). The branches (and the
/// wording) live once, in `claude_proc::describe_turn_error`; this binds the
/// things that are browse's own.
fn describe_turn_error(db: &Database, browse_id: &str, provider: Provider, error: &str) -> String {
    crate::claude_proc::describe_turn_error(
        db,
        crate::claude_proc::TurnErrorCopy {
            surface: "browse",
            subject: Some(browse_id),
            noun: "discussion",
            next: "I'll start fresh on this page",
        },
        error,
        || {
            let cleared = match provider {
                Provider::Claude => db.clear_browse_session(browse_id),
                Provider::Codex => db.clear_browse_codex_thread(browse_id),
            };
            if let Err(e) = cleared {
                tracing::warn!(error = %e, "failed to clear over-limit browse session");
            }
        },
    )
}

/// Persist a failed turn as a terminal `error` row, against the tab its turn
/// targeted, and emit `browse-error`.
fn finish_error(app: &AppHandle, db: &Database, browse_id: &str, target: Option<&str>, error: &str) -> String {
    let msg = BrowseMessage {
        id: uuid::Uuid::new_v4().to_string(),
        browse_id: browse_id.to_string(),
        role: "assistant".to_string(),
        body: error.to_string(),
        status: "error".to_string(),
        created_at: now_millis(),
        backend: None,
        target_browse_id: target.map(str::to_string),
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
    // The id the caller attaches this turn's meter to.
    msg.id
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captured_browse_workspace_wins_over_a_later_active_mission() {
        let db = Database::open_in_memory().unwrap();
        for id in ["old-mission", "new-mission"] {
            db.insert_mission(&crate::state::Mission {
                mission_id: id.into(), title: format!("Title for {id}"),
                goal: format!("Goal for {id}"), status: "active".into(),
                created_at: 1, updated_at: 1,
            }).unwrap();
        }
        assert!(captured_browse_mission(&db, Some("regular"), Some("new-mission")).unwrap().is_none());
        // A Mosaic is a workspace of its own with no mission: its page chat
        // sends `mosaic:<id>`, which must neither fail nor fall back to the
        // active mission.
        assert!(captured_browse_mission(&db, Some("mosaic:grid-1"), Some("new-mission")).unwrap().is_none());
        let original = captured_browse_mission(&db, Some("old-mission"), Some("new-mission")).unwrap().unwrap();
        assert_eq!(original.mission_id, "old-mission");
        assert_eq!(original.goal, "Goal for old-mission");
        assert_eq!(captured_browse_mission(&db, None, Some("new-mission")).unwrap().unwrap().mission_id, "new-mission");
        assert!(captured_browse_mission(&db, Some("deleted-mission"), Some("new-mission")).is_err());
        assert!(captured_browse_mission(&db, Some(""), Some("new-mission")).is_err());
    }

    #[test]
    fn first_turn_prompt_embeds_snapshot_and_tools() {
        let p = build_first_turn_prompt(
            Some(r#"{"url":"https://example.com","title":"Example"}"#),
            "What is this page about?",
            None,
         "");
        assert!(p.contains("https://example.com"));
        assert!(p.contains("What is this page about?"));
        // With no active mission, no mission block is injected.
        assert!(!p.contains("A research MISSION is currently active"));
        // Tool docs must always be present. Every change to a page goes
        // through the action route; the older page routes still answer an
        // agent that calls them, but are never taught (BC-19).
        assert!(p.contains("/v1/browser/snapshot"));
        assert!(p.contains("/v1/browser/action"));
        for kind in ["navigate", "click", "fill", "key", "scroll", "select", "wait"] {
            assert!(p.contains(&format!("{kind} {{")), "the {kind} operation is documented");
        }
        for legacy in ["/navigate", "/click", "/query"] {
            assert!(!p.contains(legacy), "the first turn still teaches {legacy}");
        }
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
        let p = build_first_turn_prompt(None, "open hacker news", None, "");
        assert!(p.contains("open hacker news"));
        assert!(p.contains("/v1/browser/action"));
        // No empty snapshot section header.
        assert!(!p.contains("snapshot of the page the user is currently viewing"));
        // Non-tandem prompts carry no tandem instructions or sources contract.
        assert!(!p.contains("TANDEM AGENT MODE"));
        assert!(!p.contains("rl-sources"));
    }

    fn mission(id: &str, title: &str, goal: &str) -> Mission {
        Mission {
            mission_id: id.into(),
            title: title.into(),
            goal: goal.into(),
            status: "active".into(),
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn first_turn_prompt_embeds_active_mission_goal() {
        let breach = mission("m-breach", "Data-breach page", "Draft my firm's data-breach practice page");
        let p = build_first_turn_prompt(None, "How does this page help?", Some(&breach), "");
        // The goal + mission title are baked in so the page agent orients to it.
        assert!(p.contains("A research MISSION is currently active"));
        assert!(p.contains("Data-breach page"));
        assert!(p.contains("Draft my firm's data-breach practice page"));
        // The re-read routes name the mission the message was sent from, so a
        // mission started later never answers for this one (BC-13).
        assert!(p.contains("/v1/missions/m-breach\n"));
        assert!(p.contains("/v1/missions/m-breach/findings"));
        assert!(!p.contains("/v1/mission/active"));
        assert!(!p.contains("/v1/mission/findings"));
    }

    #[test]
    fn transient_error_keeps_the_session_overflow_resets_it() {
        let db = Database::open_in_memory().unwrap();
        // Transient: session preserved, retry message.
        db.set_browse_session("tab-1", "keep-sid").unwrap();
        let msg = describe_turn_error(&db, "tab-1", Provider::Claude, "error_during_execution");
        assert!(msg.to_lowercase().contains("try") || msg.to_lowercase().contains("again"));
        assert_eq!(db.get_browse_session("tab-1").as_deref(), Some("keep-sid"));

        // Explicit overflow: session forgotten so the next turn starts fresh.
        db.set_browse_session("tab-2", "over-sid").unwrap();
        let msg = describe_turn_error(&db, "tab-2", Provider::Claude, "prompt is too long: 1200000 tokens");
        assert!(msg.to_lowercase().contains("reset"));
        assert_eq!(db.get_browse_session("tab-2"), None);

        // A reset forgets only the failing provider's id.
        db.set_browse_session("tab-3", "claude-sid").unwrap();
        db.set_browse_codex_thread("tab-3", "codex-thread", "{}").unwrap();
        describe_turn_error(&db, "tab-3", Provider::Codex, "exceeded the model's context window");
        assert_eq!(db.get_browse_codex_thread("tab-3"), None);
        assert_eq!(db.get_browse_session("tab-3").as_deref(), Some("claude-sid"));
        describe_turn_error(&db, "tab-3", Provider::Claude, "prompt is too long");
        assert_eq!(db.get_browse_session("tab-3"), None);
    }

    /// The status probe is what lets a remounted BrowserChat rediscover an
    /// in-flight turn (and its partial reply text) after a surface switch —
    /// it must mirror the registry exactly: streaming with the buffered
    /// partial while the entry exists, idle the moment it's taken.
    #[test]
    fn turn_status_streams_with_partial_while_registered_and_idles_after_take() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let state = BrowseState::new(Arc::new(Database::open_in_memory().unwrap()));
            assert!(!state.turns.status("tab-1").streaming);

            let slot = state.turns.begin("tab-1").unwrap();
            let buf = slot.buf();
            let child = tokio::process::Command::new("sleep")
                .arg("30")
                .kill_on_drop(true)
                .spawn()
                .expect("spawn sleep");
            slot.attach(child).expect("attach onto live reservation");
            turn::push_delta(&buf, "partial reply ");
            turn::push_delta(&buf, "text");

            let live = state.turns.status("tab-1");
            assert!(live.streaming);
            assert!(live.started_at.is_some());
            assert_eq!(live.partial.as_deref(), Some("partial reply text"));
            assert_eq!(live.seq, 2);
            assert!(state.is_running("tab-1"));
            // Scoping holds: another tab reads idle.
            assert!(!state.turns.status("tab-2").streaming);

            if let Some(mut child) = state.turns.take("tab-1").and_then(|p| p.child) {
                let _ = child.start_kill();
            }
            let done = state.turns.status("tab-1");
            assert!(!done.streaming);
            assert_eq!(done.partial, None);
            assert_eq!(done.seq, 0);
        });
    }

    /// A shared chat's turn runs on a thread no tab owns: the tab it was sent
    /// against stays live while it runs, and only while it runs (BC-31).
    #[test]
    fn a_tab_a_running_turn_targets_stays_live() {
        let state = BrowseState::new(Arc::new(Database::open_in_memory().unwrap()));
        let shared = state.turns.begin("shared-chat").unwrap();
        state.record_target("shared-chat", Some("browser-t2"));
        assert!(state.is_targeted("browser-t2"));
        assert!(!state.is_targeted("browser-t1"));
        // The next turn on the same thread retargets it.
        state.record_target("shared-chat", Some("browser-t1"));
        assert!(state.is_targeted("browser-t1"));
        assert!(!state.is_targeted("browser-t2"));
        // Ended: the page may suspend again, and a later turn elsewhere
        // forgets the stale entry.
        drop(shared);
        assert!(!state.is_targeted("browser-t1"));
        let _other = state.turns.begin("tab-chat").unwrap();
        state.record_target("tab-chat", None);
        assert!(state.targets.lock().unwrap().is_empty());
    }

    /// A page action's outcome lands on the running turn that targets its
    /// page, whichever thread that turn runs on, and settles with the row's
    /// steps, so the reply reads the same after a relaunch (BC-34, BC-41).
    #[test]
    fn a_page_actions_outcome_is_a_step_of_the_turn_that_targets_it() {
        let db = Database::open_in_memory().unwrap();
        let state = BrowseState::new(Arc::new(Database::open_in_memory().unwrap()));
        let shared = state.turns.begin("shared-chat").unwrap();
        state.record_target("shared-chat", Some("browser-t2"));
        shared.buf().lock().unwrap().meter.tool_calls = 1;
        assert!(state.record_action("browser-t1", "Clicked “Buy” · tab 1").is_empty(), "another page's action");
        let written = state.record_action("browser-t2", "Clicked “Buy” · tab 2");
        assert_eq!(written.len(), 1);
        let (id, event) = &written[0];
        assert_eq!(id, "shared-chat");
        assert_eq!(event.activity.as_ref().map(|a| a.label.as_str()), Some("Clicked “Buy” · tab 2"));
        assert!(event.rev > 0, "the frontend's guard keeps it");
        let settled = crate::meter::settle(&db, "browse", &shared.buf());
        assert_eq!(settled.steps.iter().map(|s| s.label.as_str()).collect::<Vec<_>>(), ["Clicked “Buy” · tab 2"]);
        // An ended turn takes nothing.
        drop(shared);
        assert!(state.record_action("browser-t2", "Scrolled the page · tab 2").is_empty());
    }

    /// Two first turns with different VARIABLE inputs (snapshot, mission,
    /// user text) must share a byte-identical prefix spanning the whole
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
            Some(r#"{"url":"https://one.example","title":"One"}"#),
            "first question",
            None,
         "");
        let goal = mission("m-two", "Mission", "a goal");
        let b = build_first_turn_prompt(
            Some(r#"{"url":"https://two.example","title":"Two"}"#),
            "second question, entirely different",
            Some(&goal),
         "");
        let shared = common_prefix(&a, &b);
        // The shared prefix must reach the END of the invariant block — the
        // skill reference is its last line — and carries the whole tool doc,
        // the action route included.
        assert!(shared.contains("/v1/browser/action"));
        assert!(shared.contains("Follow the `browse` skill"));
        assert!(shared.contains("keep browser actions purposeful."));
        // And every variable section sits after it: the mission block and the
        // captured mission's own routes most of all.
        assert!(!shared.contains("first question"));
        assert!(!shared.contains("MISSION is currently active"));
        assert!(!shared.contains("/v1/missions/"));
    }

    /// A chat's pick rides both spawns (turn and consult share the builder):
    /// its own `--model`/`--effort` when it has one, the `browse` seat's flags
    /// otherwise, always ahead of `--resume` and after the invariant block.
    #[test]
    fn turn_args_carry_the_chats_pick_or_else_the_seats_flags() {
        let _guard = crate::seat::store_guard();
        crate::seat::set_seat_for_test(
            "browse",
            Some(crate::seat::SeatConfig {
                model: Some("sonnet".to_string()),
                effort: Some("medium".to_string()),
                fallback: Some("haiku".to_string()),
                ..Default::default()
            }),
        );
        let invariant: Vec<String> = crate::claude_proc::BRIDGE_INVARIANT_ARGS
            .iter()
            .map(|s| s.to_string())
            .collect();
        let tail = |args: &[String]| args[2 + invariant.len()..].to_vec();

        let picked = BrowseHarness {
            backend: Some("claude-code".into()),
            model: Some("opus".into()),
            effort: Some("high".into()),
        };
        let args = claude_turn_args("hi".into(), &picked, Some("sid-1"));
        assert_eq!(&args[..2], ["-p", "hi"]);
        assert_eq!(&args[2..2 + invariant.len()], &invariant[..]);
        assert_eq!(
            tail(&args),
            ["--model", "opus", "--effort", "high", "--fallback-model", "haiku", "--resume", "sid-1"],
            "the pick replaces model and effort; the seat's fallback still rides along"
        );
        assert_eq!(
            crate::seat::model_for_override("browse", picked.model.as_deref(), picked.effort.as_deref()).as_deref(),
            Some("opus"),
            "the ledger files the turn under the model that ran it"
        );

        // A model-only pick keeps the seat's effort.
        let model_only = BrowseHarness { effort: None, ..picked.clone() };
        assert_eq!(
            tail(&claude_turn_args("hi".into(), &model_only, None)),
            ["--model", "opus", "--effort", "medium", "--fallback-model", "haiku"]
        );

        // No pick (or an explicit Default): exactly the seat's flags.
        for harness in [
            BrowseHarness::default(),
            BrowseHarness { backend: Some("claude-code".into()), ..Default::default() },
        ] {
            let args = claude_turn_args("hi".into(), &harness, Some("sid-2"));
            let mut expected = crate::seat::flag_args("browse");
            expected.extend(["--resume".to_string(), "sid-2".to_string()]);
            assert_eq!(tail(&args), expected);
        }
        crate::seat::set_seat_for_test("browse", None);
    }

    #[test]
    fn a_pick_is_validated_before_it_is_stored() {
        let pick = validate_harness(Some(" claude-code ".into()), Some(" opus ".into()), Some("xhigh".into())).unwrap();
        assert_eq!(pick, BrowseHarness { backend: Some("claude-code".into()), model: Some("opus".into()), effort: Some("xhigh".into()) });
        // Default is still a pick: the provider is stored, model and effort are not.
        assert_eq!(
            validate_harness(None, Some("  ".into()), None).unwrap(),
            BrowseHarness { backend: Some("claude-code".into()), model: None, effort: None }
        );
        // A bad model fails the spawn, so it is refused here.
        assert!(validate_harness(None, Some("gpt-5".into()), None).unwrap_err().contains("gpt-5"));
        // A bad effort only warns at the CLI, so it passes through.
        assert_eq!(validate_harness(None, None, Some("ultra".into())).unwrap().effort.as_deref(), Some("ultra"));
        // Codex stores as itself, with its live-catalog slug and per-model effort.
        assert_eq!(
            validate_harness(Some("codex".into()), Some(" gpt-5.5 ".into()), Some("xhigh".into())).unwrap(),
            BrowseHarness { backend: Some("codex".into()), model: Some("gpt-5.5".into()), effort: Some("xhigh".into()) }
        );
        assert_eq!(
            validate_harness(Some("codex".into()), None, None).unwrap(),
            BrowseHarness { backend: Some("codex".into()), model: None, effort: None }
        );
        // A Claude alias on Codex is a pick carried across providers; junk is junk.
        assert!(validate_harness(Some("codex".into()), Some("opus".into()), None).unwrap_err().contains("Codex"));
        assert!(validate_harness(Some("codex".into()), Some("gpt 5; rm".into()), None).is_err());
        // Unknown providers never land.
        assert!(validate_harness(Some("cursor".into()), None, None).is_err());
    }

    #[test]
    fn project_cards_are_once_per_session_and_never_match_snapshot_text() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let browse = BrowseState::new(db);
        browse.mark_projects_sent("thread", vec!["/repo".into()]);
        assert!(browse.sent_projects.lock().unwrap()["thread"].contains("/repo"));
        browse.mark_projects_sent("thread", vec!["/repo".into()]);
        assert_eq!(browse.sent_projects.lock().unwrap()["thread"].len(), 1);
        // Context receives only user text and captured goal; snapshots never
        // enter its signature. First-turn variable context follows the prefix.
        let prompt = build_first_turn_prompt(Some("machine OS and redline"), "who are the founders?", None, "HOST-CONTEXT\n");
        assert!(prompt.find("HOST-CONTEXT").unwrap() > prompt.find("keep browser actions purposeful").unwrap());
        assert!(!prompt.contains("Resolved user projects"));
    }

    /// Neither CLI rejects the other's id, so the one each provider is asked to
    /// resume is checked where it is actually used: Claude's `--resume`, and
    /// the `thread/resume` Codex's handshake sends.
    #[test]
    fn a_provider_switch_never_resumes_the_other_providers_id() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let browse = BrowseState::new(db.clone());
        let claude = BrowseHarness { backend: Some("claude-code".into()), ..Default::default() };
        let codex = BrowseHarness { backend: Some("codex".into()), ..Default::default() };
        let resumes = |harness: &BrowseHarness| {
            let provider = Provider::of(harness);
            let prior = resume_id(&db, "tab", provider);
            match browse.launch("tab", "hi".into(), harness, prior, "/tmp", false) {
                Launch::Claude(args) => args
                    .iter()
                    .position(|arg| arg == "--resume")
                    .map(|at| args[at + 1].clone()),
                Launch::Codex(mut turn) => {
                    let step = turn.observe(&serde_json::json!({"id": 1, "result": {}}));
                    let open = step.writes.iter().find(|write| write["id"] == 2).unwrap();
                    (open["method"] == "thread/resume")
                        .then(|| open["params"]["threadId"].as_str().unwrap().to_string())
                }
            }
        };

        // A Claude chat switches to Codex: Codex starts a thread of its own.
        db.set_browse_session("tab", "claude-sid").unwrap();
        assert_eq!(resumes(&claude).as_deref(), Some("claude-sid"));
        assert_eq!(resumes(&codex), None, "Codex never resumes the Claude session");

        // Both ids now coexist; switching back resumes the session Claude left.
        db.set_browse_codex_thread("tab", "codex-thread", "{}").unwrap();
        assert_eq!(resumes(&codex).as_deref(), Some("codex-thread"));
        assert_eq!(resumes(&claude).as_deref(), Some("claude-sid"));

        // A chat whose Claude session is gone starts Claude fresh.
        db.clear_browse_session("tab").unwrap();
        assert_eq!(resumes(&claude), None, "Claude never resumes the Codex thread");
        assert_eq!(resumes(&codex).as_deref(), Some("codex-thread"));
    }

    fn row(id: &str, role: &str, body: &str, status: &str, backend: Option<&str>) -> BrowseMessage {
        BrowseMessage {
            id: id.into(),
            browse_id: "tab".into(),
            role: role.into(),
            body: body.into(),
            status: status.into(),
            created_at: 0,
            backend: backend.map(Into::into),
            target_browse_id: None,
        }
    }

    #[test]
    fn a_switched_provider_is_handed_the_turns_it_missed() {
        let mut thread = vec![
            row("u1", "user", "What is this page?", "complete", None),
            row("a1", "assistant", "A pricing page.", "complete", None),
            row("u2", "user", "Compare the tiers", "complete", None),
            row("a2", "assistant", "claude exited abnormally", "error", None),
            row("u3", "user", "Try again on Codex", "complete", None),
            row("q1", "user", "queued behind it", "queued", None),
        ];
        // A chat that never switched carries nothing, fresh after a reset too.
        assert_eq!(carried_history(&thread, "u3", Provider::Claude, true), "");
        assert_eq!(carried_history(&thread, "u3", Provider::Claude, false), "");

        // Codex starts fresh with everything before the message it answers.
        let codex = carried_history(&thread, "u3", Provider::Codex, false);
        assert!(codex.contains("CONTEXT ONLY"));
        assert!(codex.contains("User: What is this page?"));
        assert!(codex.contains("Assistant: A pricing page."));
        assert!(codex.contains("User: Compare the tiers"));
        assert!(!codex.contains("exited abnormally"), "an error row is Redline's text");
        assert!(!codex.contains("Try again on Codex"), "the message being answered is not history");
        assert!(!codex.contains("queued behind it"));

        // Back on Claude, resumed: only what happened since its own last reply.
        thread.truncate(5);
        thread.push(row("a3", "assistant", "Pro costs twice Basic.", "complete", Some("codex")));
        thread.push(row("u4", "user", "Back to Claude", "complete", None));
        let back = carried_history(&thread, "u4", Provider::Claude, true);
        assert!(back.contains("User: Try again on Codex"));
        assert!(back.contains("Assistant: Pro costs twice Basic."));
        assert!(!back.contains("A pricing page."), "the resumed session has its own turns");
        // Codex, resumed with nothing new from Claude, is handed nothing.
        assert_eq!(carried_history(&thread, "u4", Provider::Codex, true), "");
    }

    /// A message typed while a reply streams is stored when it is queued, so
    /// the reply it follows lands AFTER it in the thread. Switching provider
    /// in that gap must still hand the new side that reply.
    #[test]
    fn a_message_queued_behind_a_reply_is_handed_that_reply() {
        let thread = vec![
            row("u1", "user", "What is this page?", "complete", None),
            row("a1", "assistant", "A pricing page.", "complete", Some("claude-code")),
            row("u2", "user", "Compare the tiers", "complete", None),
            // Queued (and since flipped to complete by the drain) while u2's
            // reply was still streaming on Codex.
            row("q3", "user", "Now on Claude: which tier fits me?", "complete", None),
            row("a2", "assistant", "Pro costs twice Basic.", "complete", Some("codex")),
        ];
        let back = carried_history(&thread, "q3", Provider::Claude, true);
        assert!(back.contains("User: Compare the tiers"), "{back}");
        assert!(back.contains("Assistant: Pro costs twice Basic."), "{back}");
        assert!(!back.contains("which tier fits me"), "the message being answered is not history");
        assert!(!back.contains("A pricing page."), "the resumed session has its own turns");

        // Fresh on Codex behind a Claude reply: the whole conversation.
        let thread = vec![
            row("u1", "user", "What is this page?", "complete", None),
            row("q2", "user", "Now on Codex: summarize it", "complete", None),
            row("a1", "assistant", "A pricing page.", "complete", Some("claude-code")),
        ];
        let codex = carried_history(&thread, "q2", Provider::Codex, false);
        assert!(codex.contains("Assistant: A pricing page."), "{codex}");
        // Without a switch the reply ahead is the session's own: nothing.
        assert_eq!(carried_history(&thread, "q2", Provider::Claude, true), "");
    }

    #[test]
    fn a_codex_first_turn_carries_the_whole_contract_at_its_head() {
        let snapshot = Some(r#"{"url":"https://example.com","title":"Example"}"#);
        let claude = first_turn_body(Provider::Claude, snapshot, "Summarize", None, "CONTEXT\n");
        assert_eq!(
            claude,
            build_first_turn_prompt(snapshot, "Summarize", None, "CONTEXT\n"),
            "Claude's first turn is unchanged"
        );
        let codex = first_turn_body(Provider::Codex, snapshot, "Summarize", None, "CONTEXT\n");
        assert!(codex.starts_with(CODEX_PREAMBLE));
        assert_eq!(&codex[CODEX_PREAMBLE.len()..], claude, "the same contract, page and message follow");
        assert!(codex.contains("--variable %REDLINE_DAEMON_TOKEN="), "writes keep their token import");
    }

    #[test]
    fn a_session_is_kept_once_it_answers_and_a_resumed_codex_baseline_follows_every_turn() {
        let db = Database::open_in_memory().unwrap();
        let ended = |session: &str, text: Option<&str>, error: Option<&str>, total: u64| StreamOutcome {
            session: Some(session.into()),
            final_text: text.map(Into::into),
            errored: error.map(Into::into),
            usage: Some(serde_json::json!({"inputTokens": total})),
            ..Default::default()
        };
        // A fresh thread whose first turn failed is not kept: the next turn
        // starts over and re-sends its snapshot.
        keep_session(&db, "tab", Provider::Codex, &ended("t1", None, Some("rate limit"), 10), false);
        assert_eq!(db.get_browse_codex_thread("tab"), None);
        keep_session(&db, "tab", Provider::Codex, &ended("t1", Some("hi"), None, 10), false);
        assert_eq!(db.get_browse_codex_thread("tab").as_deref(), Some("t1"));
        assert_eq!(db.get_browse_codex_usage("tab").as_deref(), Some(r#"{"inputTokens":10}"#));
        // A resumed thread keeps its new total even when the turn failed.
        keep_session(&db, "tab", Provider::Codex, &ended("t1", None, Some("rate limit"), 25), true);
        assert_eq!(db.get_browse_codex_usage("tab").as_deref(), Some(r#"{"inputTokens":25}"#));
        // Claude keeps only an answered session, and never touches Codex's.
        keep_session(&db, "tab", Provider::Claude, &ended("s1", None, Some("boom"), 0), true);
        assert_eq!(db.get_browse_session("tab"), None);
        keep_session(&db, "tab", Provider::Claude, &ended("s1", Some("ok"), None, 0), false);
        assert_eq!(db.get_browse_session("tab").as_deref(), Some("s1"));
        assert_eq!(db.get_browse_codex_thread("tab").as_deref(), Some("t1"));
        // A resumed turn killed by "Clear history" ends after the row is
        // gone: it moves no baseline, and never brings its thread back for
        // the cleared chat to resume.
        db.delete_browse_thread("tab").unwrap();
        keep_session(&db, "tab", Provider::Codex, &ended("t1", None, Some("Codex ended before completing the response"), 40), true);
        assert_eq!(db.get_browse_codex_thread("tab"), None);
        assert_eq!(db.get_browse_codex_usage("tab"), None);
        // Nor does one that outlived its thread's reset.
        db.set_browse_codex_thread("tab", "t2", r#"{"inputTokens":5}"#).unwrap();
        keep_session(&db, "tab", Provider::Codex, &ended("t1", None, Some("rate limit"), 50), true);
        assert_eq!(db.get_browse_codex_thread("tab").as_deref(), Some("t2"));
        assert_eq!(db.get_browse_codex_usage("tab").as_deref(), Some(r#"{"inputTokens":5}"#));
    }

    #[test]
    fn codex_activity_joins_the_ring_and_rev_never_goes_backwards() {
        let buf = Mutex::new(PartialBuf::new());
        let working = push_codex_meta(&buf, None, Some("Codex is working".into())).unwrap();
        assert_eq!(working.activity.unwrap().kind, "requesting");
        // NativeTurn's own rev restarts low; the buffer's must not follow it down.
        let mut tool = crate::meter::TurnMeter::new();
        tool.tool_calls = 1;
        tool.rev = 1;
        let ran = push_codex_meta(&buf, Some(tool.clone()), Some("Reading or inspecting the workspace".into())).unwrap();
        assert_eq!(ran.activity.unwrap().kind, "tool");
        assert!(ran.rev > working.rev);
        // A usage-only step still reports, with no ring entry.
        tool.input_tokens = 50;
        tool.rev = 2;
        let usage = push_codex_meta(&buf, Some(tool), None).unwrap();
        assert!(usage.activity.is_none());
        assert!(usage.rev > ran.rev);
        assert_eq!(buf.lock().unwrap().activity.len(), 2);
        assert!(push_codex_meta(&buf, None, None).is_none());
    }

    /// A scripted `codex app-server` on in-memory pipes. `reply` answers each
    /// line the client writes; `None` hangs up. Resolves to the lines it read.
    fn fake_app_server(
        reply: impl Fn(&Value) -> Option<Vec<Value>> + Send + 'static,
    ) -> (tokio::io::DuplexStream, tokio::io::DuplexStream, tokio::task::JoinHandle<Vec<Value>>) {
        let (stdin, server_in) = tokio::io::duplex(1 << 16);
        let (mut server_out, stdout) = tokio::io::duplex(1 << 16);
        let server = tokio::spawn(async move {
            let mut seen = Vec::new();
            let mut lines = BufReader::new(server_in).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let request: Value = serde_json::from_str(&line).unwrap();
                let replies = reply(&request);
                seen.push(request);
                let Some(replies) = replies else { break };
                for reply in replies {
                    server_out.write_all(format!("{reply}\n").as_bytes()).await.unwrap();
                }
            }
            seen
        });
        (stdin, stdout, server)
    }

    /// The protocol a Codex turn runs on, through to its streamed text.
    fn scripted_turn(request: &Value, finish: bool) -> Option<Vec<Value>> {
        use serde_json::json;
        let event = |method: &str, params: Value| json!({"method": method, "params": params});
        let scope = |extra: Value| {
            let mut params = json!({"threadId": "thread-9", "turnId": "turn-1"});
            params.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            params
        };
        Some(match request["method"].as_str() {
            Some("initialize") => vec![json!({"id": 1, "result": {}})],
            Some("thread/start" | "thread/resume") => {
                vec![json!({"id": 2, "result": {"thread": {"id": "thread-9"}, "model": "gpt-5.5"}})]
            }
            Some("turn/start") if !finish => {
                vec![json!({"id": 3, "result": {"turn": {"id": "turn-1"}}})]
            }
            Some("turn/start") => vec![
                json!({"id": 3, "result": {"turn": {"id": "turn-1"}}}),
                event("turn/started", json!({"threadId": "thread-9", "turn": {"id": "turn-1"}})),
                event("item/started", scope(json!({"item": {"id": "cmd", "type": "commandExecution"}}))),
                event("item/agentMessage/delta", scope(json!({"itemId": "msg", "delta": "The page "}))),
                event("item/agentMessage/delta", scope(json!({"itemId": "msg", "delta": "sells plans."}))),
                event("item/completed", scope(json!({"item": {"type": "agentMessage", "id": "msg", "text": "The page sells plans."}}))),
                event("thread/tokenUsage/updated", scope(json!({"tokenUsage": {"total": {"inputTokens": 120, "outputTokens": 30}, "last": {"inputTokens": 120}}}))),
                event("turn/completed", json!({"threadId": "thread-9", "turn": {"id": "turn-1", "status": "completed"}})),
            ],
            _ => vec![],
        })
    }

    #[test]
    fn a_codex_turn_streams_its_reply_on_a_read_only_networked_thread() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let (stdin, stdout, server) = fake_app_server(|request| scripted_turn(request, true));
            let buf = Mutex::new(PartialBuf::new());
            let deltas = Mutex::new(Vec::new());
            let revs = Mutex::new(Vec::new());
            let turn = NativeTurn::new("/tmp".into(), "PROMPT".into(), None, Some("gpt-5.5".into()), Some("low".into()), Value::Null);
            let out = drive_codex("tab", &buf, turn, stdin, stdout, |live| match live {
                Live::Delta { text, seq } => deltas.lock().unwrap().push((text, seq)),
                Live::Meter(meter) => revs.lock().unwrap().push((meter.rev, meter.activity.map(|a| a.kind))),
            })
            .await;
            let seen = server.await.unwrap();

            assert_eq!(out.errored, None);
            assert_eq!(out.final_text.as_deref(), Some("The page sells plans."));
            assert_eq!(out.session.as_deref(), Some("thread-9"));
            assert_eq!(out.usage.unwrap()["inputTokens"], 120, "the thread total, next turn's baseline");
            // Real streaming deltas, in order, folded into the partial buffer.
            // The second lands inside the first's coalescing window, so it is
            // the end-of-turn flush that delivers it, ahead of the terminal.
            assert_eq!(
                *deltas.lock().unwrap(),
                [("The page ".to_string(), 1), ("sells plans.".to_string(), 2)]
            );
            assert_eq!(buf.lock().unwrap().text, "The page sells plans.");
            assert_eq!(buf.lock().unwrap().meter.input_tokens, 120);
            let revs = revs.lock().unwrap();
            assert!(revs.windows(2).all(|pair| pair[0].0 < pair[1].0), "{revs:?}");
            assert!(revs.iter().any(|(_, kind)| kind.as_deref() == Some("tool")));

            // A fresh thread, then a turn in the read-only sandbox with the
            // network on — the curl bridge needs it — and the chat's pick.
            let method = |name: &str| seen.iter().find(|line| line["method"] == name).cloned();
            assert!(method("thread/resume").is_none());
            assert_eq!(method("thread/start").unwrap()["params"]["sandbox"], "read-only");
            let start = method("turn/start").unwrap();
            assert_eq!(start["params"]["sandboxPolicy"], serde_json::json!({"type": "readOnly", "networkAccess": true}));
            assert_eq!(start["params"]["model"], "gpt-5.5");
            assert_eq!(start["params"]["effort"], "low");
            assert_eq!(start["params"]["input"][0]["text"], "PROMPT");
        });
    }

    #[test]
    fn a_codex_thread_that_cannot_be_reopened_is_reset_and_a_hang_up_is_an_error() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            // The stored thread is gone: the resume itself fails.
            let (stdin, stdout, server) = fake_app_server(|request| {
                Some(match request["method"].as_str() {
                    Some("initialize") => vec![serde_json::json!({"id": 1, "result": {}})],
                    Some("thread/resume") => vec![serde_json::json!({"id": 2, "error": {"message": "no rollout found for thread t-old"}})],
                    _ => vec![],
                })
            });
            let buf = Mutex::new(PartialBuf::new());
            let turn = NativeTurn::new("/tmp".into(), "hi".into(), Some("t-old".into()), None, None, Value::Null);
            let out = drive_codex("tab", &buf, turn, stdin, stdout, |_| {}).await;
            server.await.unwrap();
            let error = out.errored.expect("a failed resume is an error");
            let db = Database::open_in_memory().unwrap();
            db.set_browse_session("tab", "claude-sid").unwrap();
            db.set_browse_codex_thread("tab", "t-old", "{}").unwrap();
            let shown = describe_turn_error(&db, "tab", Provider::Codex, &error);
            assert!(shown.contains("couldn't be found"), "{shown}");
            assert_eq!(db.get_browse_codex_thread("tab"), None, "the next turn starts a new thread");
            assert_eq!(db.get_browse_session("tab").as_deref(), Some("claude-sid"));

            // An app-server that fails before it is asked for the thread says
            // nothing about the thread, which is kept.
            let (stdin, stdout, server) = fake_app_server(|request| {
                Some(if request["method"] == "initialize" {
                    vec![serde_json::json!({"id": 1, "error": {"message": "unsupported client"}})]
                } else {
                    vec![]
                })
            });
            let turn = NativeTurn::new("/tmp".into(), "hi".into(), Some("thread-9".into()), None, None, Value::Null);
            let out = drive_codex("tab", &buf, turn, stdin, stdout, |_| {}).await;
            server.await.unwrap();
            db.set_browse_codex_thread("tab", "thread-9", "{}").unwrap();
            describe_turn_error(&db, "tab", Provider::Codex, &out.errored.unwrap());
            assert_eq!(db.get_browse_codex_thread("tab").as_deref(), Some("thread-9"));

            // The app-server dies mid-turn: an error, never a silent success.
            let (stdin, stdout, server) = fake_app_server(|request| {
                if request["method"] == "turn/start" {
                    return None;
                }
                scripted_turn(request, false)
            });
            let turn = NativeTurn::new("/tmp".into(), "hi".into(), Some("thread-9".into()), None, None, Value::Null);
            let out = drive_codex("tab", &buf, turn, stdin, stdout, |_| {}).await;
            server.await.unwrap();
            assert_eq!(out.final_text, None);
            assert_eq!(out.session.as_deref(), Some("thread-9"));
            assert_eq!(out.errored.as_deref(), Some("Codex ended before completing the response"));
        });
    }
}

/// The Rust half of the browser chat's structure layer
/// (`src/lib/browserChat`): the values both languages, the prompt and the
/// skill must agree on, read from the same `contract.json`. Test-only, so the
/// contract and the skill text it checks never reach the release binary.
#[cfg(test)]
mod contract {
    use serde_json::{json, Value};

    const CONTRACT: &str = include_str!("../../src/lib/browserChat/contract.json");
    const SKILL: &str = include_str!("../../skills/browse/SKILL.md");

    fn contract() -> Value {
        serde_json::from_str(CONTRACT).expect("contract.json parses")
    }

    fn strings(v: &Value) -> Vec<String> {
        v.as_array()
            .expect("a list")
            .iter()
            .map(|s| s.as_str().expect("a string").to_string())
            .collect()
    }

    #[test]
    fn scope_phrases_are_the_contracts() {
        let c = contract();
        assert_eq!(c["scopePhrases"]["pinned-page"], super::scope_phrase(false));
        assert_eq!(c["scopePhrases"]["following-tabs"], super::scope_phrase(true));
    }

    /// Each turn's tail names the captured page and mission, teaches the
    /// action route, and never points at the globally active mission; the
    /// first turn's mission block reads the same captured routes.
    #[test]
    fn a_turn_teaches_the_action_route_and_its_captured_mission() {
        let c = contract();
        let captured = |id: &str| -> Vec<String> {
            strings(&c["capturedMissionRoutes"]).iter().map(|r| r.replace("{id}", id)).collect()
        };
        let tail = super::turn_target_block("browser-t-1", true, Some("m-1"));
        assert!(tail.contains(c["actionRoute"].as_str().unwrap()));
        assert!(tail.contains(c["scopePhrases"]["following-tabs"].as_str().unwrap()));
        let goal = crate::state::Mission {
            mission_id: "m-1".into(),
            title: "Rate limits".into(),
            goal: "Compare token buckets".into(),
            status: "active".into(),
            created_at: 1,
            updated_at: 1,
        };
        let first = super::build_first_turn_prompt(None, "hi", Some(&goal), "");
        for text in [&tail, &first] {
            for route in captured("m-1") {
                assert!(text.contains(&route), "a captured turn reads {route}");
            }
            for global in strings(&c["globalMissionRoutes"]) {
                assert!(!text.contains(&global), "a captured turn must not point at {global}");
            }
        }
        for legacy in strings(&c["legacyRoutes"]) {
            let leaf = &legacy[legacy.rfind('/').unwrap()..];
            assert!(!first.contains(leaf), "the first turn still teaches {legacy}");
        }
        let regular = super::turn_target_block("browser-t-1", false, None);
        assert!(regular.contains(c["scopePhrases"]["pinned-page"].as_str().unwrap()));
        assert!(!regular.contains("/v1/missions/"));
        // A Mosaic's turn is captured the same way, and told so.
        assert!(regular.contains("no mission (regular browsing or a Mosaic)"));
    }

    /// The skill teaches what the backend does: shared chats, the captured
    /// target and mission, the action route; and nothing retired, nor the
    /// old page routes it no longer teaches.
    #[test]
    fn the_skill_teaches_the_contract_and_nothing_retired() {
        let c = contract();
        let lower = SKILL.to_lowercase();
        for phrase in strings(&c["skill"]["mustMention"]) {
            assert!(lower.contains(&phrase.to_lowercase()), "SKILL.md must mention {phrase}");
        }
        for phrase in strings(&c["skill"]["mustNotMention"]) {
            assert!(!SKILL.contains(&phrase), "SKILL.md still teaches {phrase}");
        }
        for legacy in strings(&c["legacyRoutes"]) {
            let leaf = &legacy[legacy.rfind('/').unwrap()..];
            assert!(!SKILL.contains(leaf), "SKILL.md still teaches {legacy}");
        }
    }

    /// Every route the page agent can call names what it does in the
    /// activity line, a numbered tab by its number and an action by its kind,
    /// and a retired route has no phrase at all.
    #[test]
    fn every_bridge_route_has_an_activity_phrase() {
        use crate::claude_proc::retrieval_status_label;
        let c = contract();
        let label = |cmd: String| retrieval_status_label("Bash", &json!({ "command": cmd }));
        let phrases = c["activityLabels"].as_object().unwrap();
        let mut routes = vec![c["actionRoute"].clone(), c["writeRoute"].clone()];
        for list in ["readRoutes", "tabRoutes", "legacyRoutes", "capturedMissionRoutes", "globalMissionRoutes", "codeRoutes"] {
            routes.extend(c[list].as_array().unwrap().iter().cloned());
        }
        for route in &routes {
            assert!(phrases.contains_key(route.as_str().unwrap()), "{route} has no activity phrase");
        }
        for (route, phrase) in phrases {
            let url = route.replace("{id}", "m-1");
            assert_eq!(label(format!("curl -s 'http://127.0.0.1:7676{url}'")), phrase.as_str().unwrap(), "{route}");
        }
        for (route, phrase) in c["tabActivityLabels"].as_object().unwrap() {
            let want = phrase.as_str().unwrap().replace("{n}", "2");
            assert_eq!(label(format!("curl -s 'http://127.0.0.1:7676{route}?tab=2'")), want, "{route}?tab=2");
        }
        let action = c["actionRoute"].as_str().unwrap();
        for kind in strings(&c["actionKinds"]) {
            let body = format!(r#"{{"operationId":"op-1","label":"browser-t1","operation":{{"kind":"{kind}"}}}}"#);
            let want = c["actionLabels"][&kind].as_str().unwrap();
            assert_eq!(label(format!("curl -s http://127.0.0.1:7676{action} -X POST -d '{body}'")), want, "{kind}");
        }
        for route in strings(&c["retiredRoutes"]) {
            assert_eq!(label(format!("curl -s -X POST http://127.0.0.1:7676{route}")), "Bash…", "{route}");
        }
    }

    /// A consult carries no captured tail, so its framing names the page it
    /// is about; a re-read without a label would read the tab on screen.
    #[test]
    fn a_consult_is_framed_for_its_real_caller() {
        let framed = super::consult_framing("  what's the pricing?  ", Some("browser-t-2"));
        assert!(framed.contains("Companion"));
        assert!(framed.contains(r#"about THIS tab (target label "browser-t-2": read it with ?tab=browser-t-2, never the tab on screen)."#));
        assert!(framed.ends_with("Its question:\n\nwhat's the pricing?"));
        for phrase in strings(&contract()["consultMustNotMention"]) {
            assert!(!framed.contains(&phrase), "the consult still says {phrase}");
        }
        // A tab that closed meanwhile is still asked about, unlabelled.
        assert!(super::consult_framing("q", None).contains("about THIS tab. Synthesize"));
    }

    /// Every kind the contract names parses as an `Operation` and serializes
    /// back under the same tag, and the enum has no kind the contract lacks.
    #[test]
    fn action_kinds_are_the_operation_enum() {
        use crate::browser_actions::Operation;
        let kinds = strings(&contract()["actionKinds"]);
        let samples = [
            json!({"kind": "navigate", "url": "https://a.test"}),
            json!({"kind": "click", "selector": "a"}),
            json!({"kind": "fill", "selector": "input", "value": "x"}),
            json!({"kind": "key", "key": "Enter"}),
            json!({"kind": "scroll", "x": 0.0, "y": 10.0}),
            json!({"kind": "select", "selector": "select", "value": "x"}),
            json!({"kind": "wait", "selector": "main"}),
        ];
        let tags: Vec<String> = samples
            .iter()
            .map(|sample| {
                let op: Operation = serde_json::from_value(sample.clone()).expect("a known kind");
                // The acknowledgement's kind is the wire tag. `kind()` is an
                // exhaustive match, so a new variant cannot compile without
                // naming one.
                let tag = serde_json::to_value(&op).unwrap()["kind"].as_str().unwrap().to_string();
                assert_eq!(op.kind(), tag);
                tag
            })
            .collect();
        assert_eq!(tags, kinds);
    }

    #[test]
    fn queue_and_project_caps_are_the_contracts() {
        let c = contract();
        assert_eq!(c["queueCap"].as_u64().unwrap() as usize, crate::turn::QUEUE_CAP);
        assert_eq!(c["maxProjects"].as_u64().unwrap() as usize, crate::code::MAX_PROJECTS);
    }

    /// Regular browsing and every Mosaic are workspaces with no mission, so a
    /// send from one neither fails nor inherits the active mission.
    #[test]
    fn a_no_mission_workspace_is_captured_as_no_mission() {
        let c = contract();
        let db = crate::db::Database::open_in_memory().unwrap();
        db.insert_mission(&crate::state::Mission {
            mission_id: "active".into(),
            title: "Active".into(),
            goal: "A goal".into(),
            status: "active".into(),
            created_at: 1,
            updated_at: 1,
        })
        .unwrap();
        let exact = strings(&c["noMissionWorkspaces"]["exact"]);
        let mosaics = strings(&c["noMissionWorkspaces"]["prefixes"]).into_iter().map(|p| format!("{p}grid"));
        for id in exact.into_iter().chain(mosaics) {
            let captured = super::captured_browse_mission(&db, Some(&id), Some("active"));
            assert!(captured.unwrap().is_none(), "{id} must be captured as no mission");
        }
    }
}
