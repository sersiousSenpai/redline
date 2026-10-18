// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Codex's conversation, read from its own app-server as a second client.
//!
//! A Codex plan session runs the way Redline's launcher starts it
//! (`codex_plan_launch.sh`): a private `codex app-server --listen unix://…`
//! with the TUI attached to it through `--remote`. The mirror connects to the
//! same socket, joins the TUI's thread (`thread/resume` on a running thread
//! rejoins it), and turns the thread's items into the events Claude's
//! transcript gives (`src/lib/convo/types.ts`). Rollout files are never read:
//! the app-server is the interface Codex keeps for its history.
//!
//! Measured in experiment (m), S10 and S11 (codex-cli 0.162.1,
//! `scripts/verify-codex-mirror.py`):
//! - A second client initializes beside the TUI. One that only initialized
//!   hears status changes and no items, so the mirror joins. Joining changes
//!   nothing for the TUI, and leaving (unsubscribe, close) doesn't either.
//! - Live: `turn/started`, `item/started`, `item/completed`, `turn/completed`
//!   (status `completed`, `interrupted` or `failed`). The reads
//!   (`thread/items/list`, newest first with an opaque cursor) return the
//!   same item ids, in the same order, across a `codex resume` too.
//! - An approval (`item/commandExecution/requestApproval`,
//!   `item/fileChange/requestApproval`) reaches every joined client and the
//!   TUI at once. The first answer wins, and `serverRequest/resolved` tells
//!   everyone else. So a card answers it from the stage while the TUI's own
//!   prompt stays live, as Claude's PermissionRequest does (S4).
//! - Hooks run in the app-server process, which the launcher starts with the
//!   terminal's environment, so each one carries `REDLINE_TERMINAL_ID` and
//!   `REDLINE_CODEX_SOCKET`. Redline's own Codex hooks are Stop, which sends
//!   the socket, and UserPromptSubmit, which doesn't: a prompt's thread is
//!   looked for on the launcher's sockets ([`find`]).
//!
//! What an item becomes:
//!
//! | Item | Events |
//! |---|---|
//! | `userMessage` | `user_text`; Redline's approval hand-off is `plan_outcome` approved instead |
//! | `agentMessage` | `assistant_text`; a `<proposed_plan>` envelope is a `plan_proposed`, and the prose around it stays |
//! | `reasoning` | `thinking` (never the text) |
//! | `hookPrompt` in the turn of a proposal | `plan_outcome` feedback: Redline's review blocked Stop with the reviewer's marks |
//! | `commandExecution`, `fileChange`, MCP and dynamic tools, web search, image view, agents | `tool_use` at its start, `tool_result` at its completion |
//! | `contextCompaction` | `compact` |
//! | `plan` (Codex's own Plan mode) | `plan_proposed` |
//! | a turn `completed` / `failed` / `interrupted` | `turn_end` / its error, then `turn_end` / `interrupted` |
//!
//! Identity and order. An event's id is its item's id, suffixed `:0` / `:1`
//! when an item makes two events; a turn's end is `<turn>:end`. Its offset
//! is the item's ordinal within its turn, inside the turn's own range: the
//! turn id's millisecond (Codex turn ids are UUIDv7) × [`SLOTS`], plus two
//! slots per item, in the order the items first appear. That order is the
//! same live (`item/started`) and in a read (`thread/items/list`, which lists
//! a turn's items in the order they were recorded), so a page read cold
//! places every item exactly where the live tail did. Neither a global
//! ordinal nor a time stamp would: the list is in completion order (a
//! command cut short by Esc is recorded after the next turn's items), and
//! a read stamps an approved command with the time it ran, not the time it
//! was proposed (measured: S10k). A turn's end takes the odd slot after its
//! last item.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::claude::plan_title;
use super::tail::Polled;
use super::wire::{AskAnswer, Body, ConvoAsk, ConvoEvent};
use crate::codex_app_server::SocketClient;

/// Where the launcher makes each terminal's socket: `mktemp -d
/// /tmp/rlcx.XXXXXXXX`, then `server.sock` inside (`codex_plan_launch.sh`).
pub(crate) const SOCKET_ROOT: &str = "/tmp";
pub(crate) const SOCKET_DIR_PREFIX: &str = "rlcx.";
pub(crate) const SOCKET_NAME: &str = "server.sock";
/// Items a first read takes; older ones come back through pages.
const HISTORY_ITEMS: u32 = 200;
/// Turns a first read learns the ends of.
const HISTORY_TURNS: u32 = 100;
const PAGE_ITEMS: u32 = 200;
/// A turn read by itself, a page at a time, up to a cap.
const TURN_PAGE_ITEMS: u32 = 500;
const TURN_ITEMS_CAP: usize = 5000;
/// A call's deadline. Local calls take a few milliseconds; a wedged server
/// must not hold the tail thread longer than this.
const CALL_TIMEOUT: Duration = Duration::from_secs(2);
/// After a failed connect or a lost connection, wait this long.
const RETRY: Duration = Duration::from_secs(3);
/// Offsets per millisecond of a turn's start: a turn's range. Its items take
/// the even ones, its end the odd one after its last item. Turns start
/// seconds apart, so a long turn's items run on past the next millisecond's
/// slots without reaching the next turn's; and at 1024 the offsets stay
/// inside a JavaScript number until the year 2248.
pub const SLOTS: u64 = 1024;
const PREVIEW_CHARS: usize = 300;
/// What the per-thread bookkeeping may hold before it starts over.
const MEMORY_CAP: usize = 4096;

/// How to answer one Codex request: its JSON-RPC id, on this connection.
#[derive(Debug, Clone, PartialEq)]
pub struct AskReply {
    pub request_id: Value,
}

/// A turn's offsets: its range starts at `base`, and `items` have been
/// placed in it.
struct TurnSlots {
    base: u64,
    items: u64,
}

/// What one poll found.
#[derive(Default)]
pub struct CodexPolled {
    pub polled: Polled,
    /// A turn started (`true`) or ended (`false`).
    pub working: Option<bool>,
    /// The thread is waiting on an answer (an approval) in the TUI.
    pub waiting: Option<bool>,
    /// Approvals the server asked of this client, as cards.
    pub asks: Vec<(ConvoAsk, AskReply)>,
    /// Requests answered by somebody, by request id.
    pub resolved: Vec<String>,
}

/// The step of an item's life a message reports.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    Started,
    Completed,
    /// From a read: completed, with nothing seen of it before.
    Listed,
}

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// The millisecond a UUIDv7 carries: where a Codex turn's range starts.
fn uuid7_ms(id: &str) -> Option<i64> {
    let hex: String = id.chars().filter(|c| *c != '-').collect();
    if hex.len() != 32 || hex.as_bytes()[12] != b'7' {
        return None;
    }
    i64::from_str_radix(&hex[..12], 16).ok()
}

/// A JSON-RPC id as a key: requests and `serverRequest/resolved` spell it
/// alike.
pub fn request_key(id: &Value) -> String {
    id.to_string()
}

/// One Codex thread's items as conversation events: pure, but for the
/// bookkeeping a later item needs from an earlier one (where an item went,
/// which proposal an outcome answers).
pub struct Mapper {
    epoch: u32,
    thread_id: String,
    /// Each item's offset, once placed.
    placed: HashMap<String, u64>,
    /// Tool items whose `tool_use` went out at their start.
    open: HashMap<String, (String, String)>,
    /// Items fully mapped: a re-read after a reconnect repeats nothing.
    done: HashSet<String>,
    /// Each turn's range and how many of its items have been placed.
    turns: HashMap<String, TurnSlots>,
    ended: HashSet<String>,
    /// The latest proposal: its turn and its item.
    plan: Option<(String, String)>,
    model: Option<String>,
    effort: Option<String>,
    /// The highest offset placed so far.
    last: u64,
}

impl Mapper {
    pub fn new(thread_id: &str, epoch: u32) -> Self {
        Self {
            epoch,
            thread_id: thread_id.to_string(),
            placed: HashMap::new(),
            open: HashMap::new(),
            done: HashSet::new(),
            turns: HashMap::new(),
            ended: HashSet::new(),
            plan: None,
            model: None,
            effort: None,
            last: 0,
        }
    }

    /// Where a host event goes: after everything placed.
    pub fn offset(&self) -> u64 {
        if self.last == 0 { 0 } else { self.last + 1 }
    }

    fn forget_if_full(&mut self) {
        if self.placed.len() >= MEMORY_CAP {
            self.placed.clear();
            self.done.clear();
            self.turns.clear();
            self.ended.clear();
        }
    }

    fn place(&mut self, item_id: &str, at_ms: Option<i64>, turn_id: &str) -> u64 {
        if let Some(offset) = self.placed.get(item_id) {
            return *offset;
        }
        self.forget_if_full();
        let fallback = at_ms.filter(|ms| *ms > 0).unwrap_or(0);
        let turn = self
            .turns
            .entry(turn_id.to_string())
            .or_insert_with(|| TurnSlots { base: uuid7_ms(turn_id).unwrap_or(fallback).max(0) as u64 * SLOTS, items: 0 });
        let offset = turn.base + 2 * turn.items;
        turn.items += 1;
        self.placed.insert(item_id.to_string(), offset);
        self.last = self.last.max(offset);
        offset
    }

    fn event(&self, id: String, offset: u64, ts: i64, body: Body) -> ConvoEvent {
        ConvoEvent { id, epoch: self.epoch, offset, ts, body }
    }

    /// One app-server message: a notification, or a request of this client.
    pub fn message(&mut self, msg: &Value, fallback_ts: i64, out: &mut CodexPolled) {
        let Some(method) = str_of(msg, "method") else { return };
        let params = msg.get("params").unwrap_or(&Value::Null);
        if params.get("threadId").and_then(Value::as_str) != Some(self.thread_id.as_str()) {
            return;
        }
        let turn = str_of(params, "turnId").unwrap_or_default();
        let at = |key: &str| params.get(key).and_then(Value::as_i64);
        match method {
            "item/started" | "item/completed" => {
                let (stage, key) = if method == "item/started" { (Stage::Started, "startedAtMs") } else { (Stage::Completed, "completedAtMs") };
                let ts = at(key).unwrap_or(fallback_ts);
                let events = self.item(params.get("item").unwrap_or(&Value::Null), turn, at(key), stage, ts);
                out.polled.events.extend(events);
            }
            "turn/started" => out.working = Some(true),
            "turn/completed" => {
                let ts = msg.get("emittedAtMs").and_then(Value::as_i64).unwrap_or(fallback_ts);
                let turn = params.get("turn").unwrap_or(&Value::Null);
                out.polled.events.extend(self.end(turn, ts));
                out.working = Some(false);
            }
            "thread/status/changed" => out.waiting = Some(waiting(params.get("status"))),
            "thread/settings/updated" => {
                let settings = params.get("threadSettings").unwrap_or(&Value::Null);
                let ts = msg.get("emittedAtMs").and_then(Value::as_i64).unwrap_or(fallback_ts);
                out.polled.events.extend(self.settings(str_of(settings, "model"), str_of(settings, "effort"), ts));
            }
            "thread/name/updated" => out.polled.title = str_of(params, "threadName").map(str::to_string),
            "serverRequest/resolved" => {
                if let Some(id) = params.get("requestId") {
                    out.resolved.push(request_key(id));
                }
            }
            "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
                if let Some(id) = msg.get("id") {
                    out.asks.extend(self.ask(method, id, params, fallback_ts));
                }
            }
            _ => {}
        }
    }

    /// A read's entries (`thread/items/list`), oldest first.
    pub fn listed(&mut self, entries: &[Value], fallback_ts: i64) -> Vec<ConvoEvent> {
        let mut out = Vec::new();
        for entry in entries {
            let turn = str_of(entry, "turnId").unwrap_or_default();
            let started = entry.get("startedAtMs").and_then(Value::as_i64);
            let completed = entry.get("completedAtMs").and_then(Value::as_i64);
            let ts = completed.or(started).unwrap_or(fallback_ts);
            out.extend(self.item(entry.get("item").unwrap_or(&Value::Null), turn, started.or(completed), Stage::Listed, ts));
        }
        out
    }

    /// The ends of finished turns a read found (`Turn`s), for the turns whose
    /// items this mapper has placed.
    pub fn ends(&mut self, turns: &[Value], fallback_ts: i64) -> Vec<ConvoEvent> {
        let mut out = Vec::new();
        for turn in turns {
            let Some(id) = str_of(turn, "id") else { continue };
            if !self.turns.contains_key(id) {
                continue;
            }
            let ts = turn.get("completedAt").and_then(Value::as_i64).map_or(fallback_ts, |s| s * 1000);
            out.extend(self.end(turn, ts));
        }
        out
    }

    /// `model_seen` when the thread's model or effort changed.
    pub fn settings(&mut self, model: Option<&str>, effort: Option<&str>, ts: i64) -> Option<ConvoEvent> {
        let (model, effort) = (model.map(str::to_string), effort.map(str::to_string));
        if model.is_none() || (model == self.model && effort == self.effort) {
            return None;
        }
        self.model = model.clone();
        self.effort = effort.clone();
        let model = model.unwrap_or_default();
        let id = format!("{}:model:{model}:{}", self.thread_id, effort.as_deref().unwrap_or(""));
        Some(self.event(id, self.offset(), ts, Body::ModelSeen { model, effort }))
    }

    fn end(&mut self, turn: &Value, ts: i64) -> Vec<ConvoEvent> {
        let Some(id) = str_of(turn, "id") else { return Vec::new() };
        if self.ended.contains(id) {
            return Vec::new();
        }
        let mut bodies = Vec::new();
        match str_of(turn, "status") {
            Some("completed") => bodies.push(("end", Body::TurnEnd { duration_ms: turn.get("durationMs").and_then(Value::as_u64) })),
            Some("failed") => {
                if let Some(message) = turn.pointer("/error/message").and_then(Value::as_str).filter(|m| !m.trim().is_empty()) {
                    bodies.push(("error", Body::AssistantText { text: message.to_string(), model: None }));
                }
                bodies.push(("end", Body::TurnEnd { duration_ms: turn.get("durationMs").and_then(Value::as_u64) }));
            }
            Some("interrupted") => bodies.push(("end", Body::Interrupted)),
            _ => return Vec::new(),
        }
        self.ended.insert(id.to_string());
        let offset = self.turns.get(id).filter(|t| t.items > 0).map_or(self.offset(), |t| t.base + 2 * t.items - 1);
        self.last = self.last.max(offset);
        bodies.into_iter().map(|(suffix, body)| self.event(format!("{id}:{suffix}"), offset, ts, body)).collect()
    }

    fn item(&mut self, item: &Value, turn: &str, at_ms: Option<i64>, stage: Stage, ts: i64) -> Vec<ConvoEvent> {
        let Some(id) = str_of(item, "id") else { return Vec::new() };
        if self.done.contains(id) {
            return Vec::new();
        }
        // Placed by its start, whatever it turns out to say: a read reports
        // the start, so the live tail must place it there too.
        if stage == Stage::Started {
            self.place(id, at_ms, turn);
        }
        if let Some((name, summary)) = tool(item) {
            let offset = self.place(id, at_ms, turn);
            let mut out = Vec::new();
            let opened = self.open.remove(id);
            if opened.is_none() {
                out.push(self.event(format!("{id}:0"), offset, ts, Body::ToolUse { tool_use_id: id.to_string(), name: name.clone(), summary: summary.clone() }));
            }
            if stage == Stage::Started {
                self.open.insert(id.to_string(), (name, summary));
            } else {
                let (is_error, preview) = outcome(item);
                out.push(self.event(format!("{id}:1"), offset, ts, Body::ToolResult { tool_use_id: id.to_string(), is_error, preview }));
                self.done.insert(id.to_string());
            }
            return out;
        }
        if stage == Stage::Started {
            return Vec::new();
        }
        let bodies = self.bodies(item, id, turn);
        self.done.insert(id.to_string());
        if bodies.is_empty() {
            return Vec::new();
        }
        let offset = self.place(id, at_ms, turn);
        let several = bodies.len() > 1;
        bodies
            .into_iter()
            .enumerate()
            .map(|(i, body)| self.event(if several { format!("{id}:{i}") } else { id.to_string() }, offset, ts, body))
            .collect()
    }

    /// What a finished, non-tool item says.
    fn bodies(&mut self, item: &Value, id: &str, turn: &str) -> Vec<Body> {
        match str_of(item, "type") {
            Some("userMessage") => {
                let text = user_text(item);
                if is_approval(&text) {
                    // Redline's own words, queued by Approve (the plan follows
                    // them): the outcome of the proposal, not something said.
                    return self
                        .plan
                        .as_ref()
                        .map(|(_, plan)| vec![Body::PlanOutcome { tool_use_id: plan.clone(), outcome: "approved".into(), feedback: None }])
                        .unwrap_or_default();
                }
                if text.trim().is_empty() {
                    return Vec::new();
                }
                vec![Body::UserText { text, prompt_id: None }]
            }
            Some("agentMessage") => {
                let text = str_of(item, "text").unwrap_or_default();
                let model = self.model.clone();
                let Some(plan) = crate::extract_codex_proposed_plan(text) else {
                    return if text.trim().is_empty() { Vec::new() } else { vec![Body::AssistantText { text: text.to_string(), model }] };
                };
                let mut out = Vec::new();
                let prose = outside_plan(text);
                if !prose.is_empty() {
                    out.push(Body::AssistantText { text: prose, model });
                }
                out.push(Body::PlanProposed { tool_use_id: id.to_string(), session_id: self.thread_id.clone(), title: plan_title(&plan) });
                self.plan = Some((turn.to_string(), id.to_string()));
                out
            }
            Some("plan") => {
                let text = str_of(item, "text").unwrap_or_default();
                self.plan = Some((turn.to_string(), id.to_string()));
                vec![Body::PlanProposed { tool_use_id: id.to_string(), session_id: self.thread_id.clone(), title: plan_title(text) }]
            }
            // A Stop hook's `block` reason, fed back into the same turn: after a
            // proposal, that is Redline's review sending the marks back.
            Some("hookPrompt") => match &self.plan {
                Some((plan_turn, plan)) if plan_turn == turn => {
                    let feedback: Vec<&str> = item
                        .get("fragments")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(|f| f.get("text").and_then(Value::as_str))
                        .collect();
                    let feedback = feedback.join("\n");
                    vec![Body::PlanOutcome {
                        tool_use_id: plan.clone(),
                        outcome: "feedback".into(),
                        feedback: Some(feedback).filter(|f| !f.trim().is_empty()),
                    }]
                }
                _ => Vec::new(),
            },
            Some("reasoning") => vec![Body::Thinking],
            Some("contextCompaction") => vec![Body::Compact { trigger: None }],
            _ => Vec::new(),
        }
    }

    /// An approval the server asked of this client, as a card. Others (a
    /// question, a permission profile, an MCP elicitation) stay the TUI's.
    fn ask(&self, method: &str, id: &Value, params: &Value, fallback_ts: i64) -> Option<(ConvoAsk, AskReply)> {
        let item_id = str_of(params, "itemId")?;
        let ask_id = match str_of(params, "approvalId") {
            Some(callback) => format!("{item_id}:{callback}"),
            None => item_id.to_string(),
        };
        let reason = str_of(params, "reason");
        let (tool_name, summary, input, always, rule) = if method == "item/commandExecution/requestApproval" {
            let command = params
                .get("commandActions")
                .and_then(Value::as_array)
                .filter(|actions| actions.len() == 1)
                .and_then(|actions| str_of(&actions[0], "command"))
                .map(str::to_string)
                .or_else(|| str_of(params, "command").map(unwrap_shell))
                .unwrap_or_default();
            let offered = params.get("availableDecisions").and_then(Value::as_array);
            let amendment = offered
                .into_iter()
                .flatten()
                .find(|d| d.get("acceptWithExecpolicyAmendment").is_some())
                .cloned();
            let session = offered.into_iter().flatten().any(|d| d.as_str() == Some("acceptForSession"));
            let (always, rule) = match amendment {
                Some(amendment) => {
                    let prefix: Vec<&str> = amendment
                        .pointer("/acceptWithExecpolicyAmendment/execpolicy_amendment")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .collect();
                    (Some(amendment.clone()), Some(format!("Don't ask again for commands that start with `{}`", prefix.join(" "))))
                }
                None if session => (Some(json!("acceptForSession")), Some("Allow this command for the rest of the session".to_string())),
                None => (None, None),
            };
            let input = json!({"command": command, "cwd": params.get("cwd"), "reason": reason});
            ("Bash".to_string(), command, input, always, rule)
        } else {
            let summary = self.open.get(item_id).map(|(_, summary)| summary.clone()).unwrap_or_else(|| "files".to_string());
            let input = json!({"reason": reason, "grantRoot": params.get("grantRoot")});
            ("Edit".to_string(), summary, input, Some(json!("acceptForSession")), Some("Allow edits for the rest of the session".to_string()))
        };
        let ask = ConvoAsk {
            ask_id,
            kind: "permission".into(),
            tool_name,
            summary,
            input: Some(input),
            suggestions: always.map(|decision| vec![decision]),
            rule,
            questions: None,
            opened_at: params.get("startedAtMs").and_then(Value::as_i64).unwrap_or(fallback_ts),
        };
        Some((ask, AskReply { request_id: id.clone() }))
    }
}

/// The thread waits on somebody: an approval or a question is up.
fn waiting(status: Option<&Value>) -> bool {
    status
        .and_then(|s| s.get("activeFlags"))
        .and_then(Value::as_array)
        .is_some_and(|flags| !flags.is_empty())
}

/// A user message's words. Other inputs (images, mentions) have no text to
/// show here; the terminal has them.
fn user_text(item: &Value) -> String {
    item.get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|c| c.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|c| c.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Redline's approval hand-off (`codex_app_server::implementation_prompt`),
/// queued into the thread when the reviewer approves.
fn is_approval(text: &str) -> bool {
    let lead = crate::codex_app_server::implementation_prompt("");
    text.starts_with(lead.trim_end())
}

/// A message's prose with its one `<proposed_plan>` envelope cut out.
fn outside_plan(text: &str) -> String {
    const OPEN: &str = "<proposed_plan>";
    const CLOSE: &str = "</proposed_plan>";
    let (Some(start), Some(end)) = (text.find(OPEN), text.rfind(CLOSE)) else { return text.trim().to_string() };
    if end < start {
        return text.trim().to_string();
    }
    let before = text[..start].trim();
    let after = text[end + CLOSE.len()..].trim();
    [before, after].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join("\n\n")
}

/// `/bin/zsh -lc 'npm test'` → `npm test`: Codex runs each command through
/// the user's shell, and only what is inside is worth a row.
fn unwrap_shell(command: &str) -> String {
    let command = command.trim();
    let inner = ["-lc ", "-c "].iter().find_map(|flag| {
        let at = command.find(flag)?;
        let shell = command[..at].trim_end();
        (shell.ends_with("sh") && !shell.contains(' ')).then(|| &command[at + flag.len()..])
    });
    let Some(inner) = inner.map(str::trim) else { return command.to_string() };
    match inner.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')) {
        Some(quoted) => quoted.replace("'\\''", "'"),
        None => inner.to_string(),
    }
}

/// A tool item as a row: its name in the stage's tool vocabulary
/// (`status.ts`), and the one thing it acted on.
fn tool(item: &Value) -> Option<(String, String)> {
    let text = |key: &str| str_of(item, key).unwrap_or_default().to_string();
    let named = |name: &str, summary: String| Some((name.to_string(), summary));
    match str_of(item, "type")? {
        "commandExecution" => {
            let actions: Vec<&Value> = item.get("commandActions").and_then(Value::as_array).into_iter().flatten().collect();
            if let [action] = actions.as_slice() {
                let command = str_of(action, "command").unwrap_or_default().to_string();
                return match str_of(action, "type") {
                    Some("read") => named("Read", str_of(action, "path").or(str_of(action, "name")).map(str::to_string).unwrap_or(command)),
                    Some("listFiles") => named("LS", str_of(action, "path").unwrap_or(".").to_string()),
                    Some("search") => named("Grep", str_of(action, "query").map(str::to_string).unwrap_or(command)),
                    _ => named("exec_command", command),
                };
            }
            named("exec_command", unwrap_shell(&text("command")))
        }
        "fileChange" => {
            let changes: Vec<&Value> = item.get("changes").and_then(Value::as_array).into_iter().flatten().collect();
            let first = changes.first().and_then(|c| str_of(c, "path")).unwrap_or("files").to_string();
            let added = changes.len() == 1 && changes[0].pointer("/kind/type").and_then(Value::as_str) == Some("add");
            let summary = if changes.len() > 1 { format!("{first} (+{} more)", changes.len() - 1) } else { first };
            named(if added { "Write" } else { "apply_patch" }, summary)
        }
        "mcpToolCall" => {
            let input = item.get("arguments").cloned().unwrap_or(Value::Null);
            named(&format!("mcp__{}__{}", text("server"), text("tool")), crate::runwatch::summarize_tool_input(&input))
        }
        "dynamicToolCall" => {
            let input = item.get("arguments").cloned().unwrap_or(Value::Null);
            named(str_of(item, "tool").unwrap_or("tool"), crate::runwatch::summarize_tool_input(&input))
        }
        "webSearch" => named("WebSearch", text("query")),
        "imageView" => named("Read", text("path")),
        "collabAgentToolCall" => named("Agent", str_of(item, "prompt").unwrap_or(str_of(item, "tool").unwrap_or_default()).to_string()),
        _ => None,
    }
}

/// A finished tool item's result: whether it failed, and a glance at what
/// it printed.
fn outcome(item: &Value) -> (bool, String) {
    let failed = matches!(str_of(item, "status"), Some("failed" | "declined"))
        || item.get("exitCode").and_then(Value::as_i64).is_some_and(|code| code != 0)
        || item.get("success").and_then(Value::as_bool) == Some(false)
        || item.get("error").is_some_and(|e| !e.is_null());
    let text = match str_of(item, "type") {
        Some("commandExecution") => str_of(item, "aggregatedOutput").unwrap_or_default().to_string(),
        Some("mcpToolCall") => item
            .pointer("/error/message")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                let parts: Vec<&str> = item
                    .pointer("/result/content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|c| c.get("text").and_then(Value::as_str))
                    .collect();
                (!parts.is_empty()).then(|| parts.join(" "))
            })
            .unwrap_or_default(),
        Some("dynamicToolCall") => item
            .get("contentItems")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|c| c.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    };
    (failed, crate::runwatch::preview(&text, PREVIEW_CHARS))
}

/// A stage answer, as the reply its request takes (`Replier::Codex`): the
/// shapes are the app-server's (`CommandExecutionApprovalDecision`,
/// `FileChangeApprovalDecision`). Always sends the request's own offer back,
/// as Claude's Always sends the payload's suggestions. Deny is `cancel`, the
/// TUI's own "No, and tell Codex what to do differently": the turn stops
/// and the next prompt says what to do. `terminal` sends nothing: the TUI's
/// prompt is up and takes the answer.
pub(crate) fn reply(ask: &ConvoAsk, answer: &AskAnswer) -> Result<(Value, &'static str), String> {
    Ok(match answer {
        AskAnswer::Allow => (json!({"decision": "accept"}), "allow"),
        AskAnswer::Always => {
            let decision = ask.suggestions.as_ref().and_then(|s| s.first()).cloned().ok_or("Codex offers no Always for this one")?;
            (json!({"decision": decision}), "always")
        }
        AskAnswer::Deny { .. } => (json!({"decision": "cancel"}), "deny"),
        AskAnswer::Terminal => (Value::Null, "terminal"),
        AskAnswer::Answers { .. } => return Err("a Codex approval takes allow, always, deny, or the terminal".into()),
    })
}

// --- finding a thread's socket ----------------------------------------------------

/// The `initialize` every connection opens with.
fn initialize_params() -> Value {
    json!({"clientInfo": {"name": "redline", "version": env!("CARGO_PKG_VERSION")}, "capabilities": {"experimentalApi": true}})
}

/// A directory, or a socket in it, that this user made and nobody else can
/// write: the launcher's `mktemp -d` gives exactly that. The daemon's routes
/// take a socket path from any local process, so nothing else is opened.
#[cfg(unix)]
fn ours(path: &Path, dir: bool) -> bool {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    let Ok(meta) = std::fs::symlink_metadata(path) else { return false };
    // SAFETY: getuid has no preconditions and cannot fail.
    let me = unsafe { libc::getuid() };
    let kind = if dir { meta.is_dir() } else { meta.file_type().is_socket() };
    kind && meta.uid() == me && (!dir || meta.mode() & 0o077 == 0)
}

#[cfg(not(unix))]
fn ours(_path: &Path, _dir: bool) -> bool {
    false
}

#[cfg(not(test))]
fn scan_root() -> PathBuf {
    PathBuf::from(SOCKET_ROOT)
}

#[cfg(test)]
thread_local! {
    /// Tests never look at this machine's real launcher sockets.
    pub(super) static SCAN_ROOT: std::cell::RefCell<PathBuf> = std::cell::RefCell::new(PathBuf::from("/nonexistent/rl-codex-scan"));
}

#[cfg(test)]
fn scan_root() -> PathBuf {
    SCAN_ROOT.with(|root| root.borrow().clone())
}

/// A socket the launcher could have made: this user's, in a private
/// directory of this user's.
fn launcher_owned(socket: &Path) -> bool {
    socket.parent().is_some_and(|dir| ours(dir, true)) && ours(socket, false)
}

/// Every launcher socket on this machine, newest directory first.
fn launcher_sockets() -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(scan_root()) else { return Vec::new() };
    let mut found: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(SOCKET_DIR_PREFIX))
        .map(|e| e.path())
        .map(|dir| dir.join(SOCKET_NAME))
        .filter(|socket| launcher_owned(socket))
        .map(|socket| (std::fs::symlink_metadata(&socket).and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH), socket))
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, socket)| socket).collect()
}

/// A connection to `socket`, if its server has `thread_id` loaded: a
/// launcher's server holds its own TUI's threads and nothing else.
fn open(socket: &str, thread_id: &str) -> Result<SocketClient, String> {
    let mut client = SocketClient::connect(socket, CALL_TIMEOUT)?;
    let deadline = Instant::now() + CALL_TIMEOUT;
    client.call("initialize", initialize_params(), deadline).map_err(|e| e.to_string())?;
    let loaded = client.call("thread/loaded/list", json!({}), deadline).map_err(|e| e.to_string())?;
    let here = loaded.get("data").and_then(Value::as_array).is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(thread_id)));
    if here { Ok(client) } else { Err("the thread isn't loaded on this socket".into()) }
}

/// The socket serving `thread_id`, and a connection to it: the one a hook
/// named first, else whichever launcher socket has it. `None` is a Codex the
/// launcher didn't start (a direct run, a build, a `codex` typed by hand),
/// whose in-process server no other client can reach.
pub fn find(thread_id: &str, hint: Option<&str>) -> Option<(String, SocketClient)> {
    // The hook's header is checked like a scanned socket: the daemon takes it
    // from whoever posts, so it gets no more trust than the directory scan.
    let named = hint.filter(|s| Path::new(s).is_absolute() && launcher_owned(Path::new(s))).map(str::to_string);
    let scanned = launcher_sockets().into_iter().map(|p| p.to_string_lossy().into_owned());
    named.into_iter().chain(scanned).find_map(|socket| open(&socket, thread_id).ok().map(|client| (socket, client)))
}

// --- the source -----------------------------------------------------------------------

/// The live read of one terminal's Codex thread.
pub struct CodexSource {
    pub epoch: u32,
    pub thread_id: String,
    /// The launcher's socket. `None`: no server can be reached, so the
    /// conversation is the terminal's alone.
    pub socket: Option<String>,
    client: Option<SocketClient>,
    map: Mapper,
    /// Where older history continues (`thread/items/list`, newest first).
    cursor: Option<String>,
    /// Turns read whole already: a page leaves them out.
    whole: HashSet<String>,
    primed: bool,
    retry_at: Option<Instant>,
    /// Threads this server started since (a `/new` in the TUI).
    started: Vec<String>,
}

impl CodexSource {
    pub fn new(thread_id: &str, socket: Option<String>, client: Option<SocketClient>, epoch: u32) -> Self {
        Self {
            epoch,
            thread_id: thread_id.to_string(),
            socket,
            client,
            map: Mapper::new(thread_id, epoch),
            cursor: None,
            whole: HashSet::new(),
            primed: false,
            retry_at: None,
            started: Vec::new(),
        }
    }

    pub fn offset(&self) -> u64 {
        self.map.offset()
    }

    /// Joined to the thread on a live connection: the server is streaming.
    pub fn joined(&self) -> bool {
        self.primed && self.client.as_ref().is_some_and(|c| !c.closed())
    }

    /// The server started `thread_id` since this source joined: the TUI's
    /// `/new` (S11: SessionStart `startup` with a new id, same server).
    pub fn started_here(&self, thread_id: &str) -> bool {
        self.started.iter().any(|t| t == thread_id)
    }

    /// What is new. The first poll (and the first after a lost connection)
    /// joins the thread and reads its recent history; later ones take what
    /// has arrived, without waiting.
    pub fn poll(&mut self, now_ms: i64) -> CodexPolled {
        let mut out = CodexPolled::default();
        let Some(socket) = self.socket.clone() else { return out };
        if self.client.as_ref().is_none_or(SocketClient::closed) {
            self.client = None;
            if self.retry_at.is_some_and(|at| Instant::now() < at) {
                return out;
            }
            match open(&socket, &self.thread_id) {
                Ok(client) => self.client = Some(client),
                Err(error) => {
                    tracing::debug!(%error, "codex mirror: no connection");
                    self.retry_at = Some(Instant::now() + RETRY);
                    return out;
                }
            }
            if let Err(error) = self.join(now_ms, &mut out) {
                tracing::debug!(%error, "codex mirror: couldn't join the thread");
                self.client = None;
                self.retry_at = Some(Instant::now() + RETRY);
                return out;
            }
        } else if !self.primed {
            if let Err(error) = self.join(now_ms, &mut out) {
                tracing::debug!(%error, "codex mirror: couldn't join the thread");
                self.client = None;
                self.retry_at = Some(Instant::now() + RETRY);
                return out;
            }
        }
        let Some(client) = self.client.as_mut() else { return out };
        for message in client.drain() {
            self.note_started(&message);
            self.map.message(&message, now_ms, &mut out);
        }
        out
    }

    fn note_started(&mut self, message: &Value) {
        if message.get("method").and_then(Value::as_str) != Some("thread/started") {
            return;
        }
        let Some(thread) = message.pointer("/params/thread") else { return };
        if thread.get("ephemeral").and_then(Value::as_bool) == Some(true) {
            return;
        }
        if let Some(id) = str_of(thread, "id") {
            self.started.push(id.to_string());
            if self.started.len() > 64 {
                self.started.remove(0);
            }
        }
    }

    /// Rejoin the thread and read its recent history: the newest items, the
    /// ends of the turns they belong to, the model and the title. A rejoin
    /// after a lost connection reads the same way, and the mapper drops
    /// what it already gave.
    fn join(&mut self, now_ms: i64, out: &mut CodexPolled) -> Result<(), String> {
        let client = self.client.as_mut().ok_or("not connected")?;
        let deadline = Instant::now() + CALL_TIMEOUT;
        let resumed = client
            .call(
                "thread/resume",
                json!({"threadId": self.thread_id, "excludeTurns": true,
                       "initialTurnsPage": {"limit": HISTORY_TURNS, "sortDirection": "desc", "itemsView": "notLoaded"}}),
                deadline,
            )
            .map_err(|e| e.to_string())?;
        // A rejoin reads every turn again; the mapper drops what it gave.
        let mut whole = if self.primed { HashSet::new() } else { std::mem::take(&mut self.whole) };
        let (entries, next) = read_back(client, &self.thread_id, None, HISTORY_ITEMS, &mut whole, deadline)?;
        if !self.primed {
            self.whole = whole;
        }
        let thread = resumed.get("thread").unwrap_or(&Value::Null);
        out.polled.events.extend(self.map.settings(str_of(&resumed, "model"), str_of(&resumed, "reasoningEffort"), now_ms));
        out.polled.events.extend(self.map.listed(&entries, now_ms));
        let turns = resumed.pointer("/initialTurnsPage/data").and_then(Value::as_array).cloned().unwrap_or_default();
        out.polled.events.extend(self.map.ends(&turns, now_ms));
        let active = thread.pointer("/status/type").and_then(Value::as_str) == Some("active");
        out.working = Some(active);
        out.waiting = Some(waiting(thread.get("status")));
        out.polled.title = str_of(thread, "name").map(str::to_string);
        if !self.primed {
            self.cursor = next;
            out.polled.skipped = self.cursor.is_some();
            self.primed = true;
        }
        self.retry_at = None;
        Ok(())
    }

    /// One page of older history, before what the first read (or the last
    /// page) took, and whether there is more.
    pub fn page(&mut self, now_ms: i64) -> Result<(Vec<ConvoEvent>, bool), String> {
        let Some(cursor) = self.cursor.clone() else { return Ok((Vec::new(), false)) };
        let client = self.client.as_mut().filter(|c| !c.closed()).ok_or("the Codex session isn't connected")?;
        let deadline = Instant::now() + CALL_TIMEOUT;
        let (entries, next) = read_back(client, &self.thread_id, Some(&cursor), PAGE_ITEMS, &mut self.whole, deadline)?;
        // Read cold, as a forward read of the same items would be: every
        // turn here starts at its first item.
        let mut cold = Mapper::new(&self.thread_id, self.epoch);
        cold.model = self.map.model.clone();
        let events = cold.listed(&entries, now_ms);
        self.cursor = next;
        Ok((events, self.cursor.is_some()))
    }

    /// Answer a request the server made of this client.
    pub fn respond(&mut self, request_id: &Value, result: Value) -> Result<(), String> {
        let client = self.client.as_mut().filter(|c| !c.closed()).ok_or("the Codex session isn't connected")?;
        client.respond(request_id, result)
    }
}

fn turn_of(entry: &Value) -> Option<&str> {
    str_of(entry, "turnId")
}

/// One read of history, newest first from `cursor` (none: from the newest
/// item), returned oldest first and made whole at its oldest turn. A read
/// that cut a turn reads that turn by itself (`turnId`), so every turn a
/// read holds starts at its first item, and the mapper's ordinals for it
/// are the same in every read, and the same as the live tail's. Turns in
/// `whole` (a newer read's oldest) are left out, and the turns this one
/// holds join them.
fn read_back(
    client: &mut SocketClient,
    thread_id: &str,
    cursor: Option<&str>,
    limit: u32,
    whole: &mut HashSet<String>,
    deadline: Instant,
) -> Result<(Vec<Value>, Option<String>), String> {
    let mut params = json!({"threadId": thread_id, "sortDirection": "desc", "limit": limit});
    if let Some(cursor) = cursor {
        params["cursor"] = json!(cursor);
    }
    let page = client.call("thread/items/list", params, deadline).map_err(|e| e.to_string())?;
    let next = str_of(&page, "nextCursor").map(str::to_string);
    let mut entries: Vec<Value> = page
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|e| turn_of(e).is_none_or(|t| !whole.contains(t)))
        .cloned()
        .collect();
    entries.reverse();
    if next.is_some() {
        if let Some(oldest) = entries.first().and_then(turn_of).map(str::to_string) {
            let mut turn = turn_items(client, thread_id, &oldest, deadline)?;
            turn.extend(entries.into_iter().filter(|e| turn_of(e) != Some(oldest.as_str())));
            entries = turn;
        }
    }
    whole.extend(entries.iter().filter_map(turn_of).map(str::to_string));
    Ok((entries, next))
}

/// Every item of one turn, oldest first.
fn turn_items(client: &mut SocketClient, thread_id: &str, turn_id: &str, deadline: Instant) -> Result<Vec<Value>, String> {
    let mut items = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut params = json!({"threadId": thread_id, "turnId": turn_id, "sortDirection": "asc", "limit": TURN_PAGE_ITEMS});
        if let Some(cursor) = &cursor {
            params["cursor"] = json!(cursor);
        }
        let page = client.call("thread/items/list", params, deadline).map_err(|e| e.to_string())?;
        items.extend(page.get("data").and_then(Value::as_array).into_iter().flatten().cloned());
        cursor = str_of(&page, "nextCursor").map(str::to_string);
        if cursor.is_none() || items.len() >= TURN_ITEMS_CAP {
            return Ok(items);
        }
    }
}

/// A Codex hook named a thread this terminal isn't bound to. Binding waits
/// for the tail thread to find its socket: a hook's thread may be a nested
/// `codex exec` an agent ran (it inherits the terminal's id), which no
/// launcher socket serves, and must not take the terminal over.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub thread_id: String,
    pub socket: Option<String>,
    /// `prompt` or `stop`: the hook that named it.
    pub source: String,
    pub tries: u8,
    pub due: Instant,
}

/// How many looks a candidate gets before it is let go (or, for a terminal
/// with no Codex bound, bound as one only its terminal shows).
pub const CANDIDATE_TRIES: u8 = 3;
pub const CANDIDATE_RETRY: Duration = Duration::from_millis(700);

#[cfg(test)]
pub(super) fn replay(lines: &[Value], thread_id: &str) -> Vec<ConvoEvent> {
    let mut map = Mapper::new(thread_id, 0);
    let mut events = Vec::new();
    for line in lines {
        // A recorded read: `thread/items/list`'s answer, newest first.
        if let Some(data) = line.pointer("/result/data").and_then(Value::as_array) {
            let mut entries = data.clone();
            entries.reverse();
            events.extend(map.listed(&entries, 0));
            continue;
        }
        let mut out = CodexPolled::default();
        map.message(line, 0, &mut out);
        events.extend(out.polled.events);
    }
    events
}

#[cfg(test)]
pub(super) fn asks_of(lines: &[Value], thread_id: &str) -> Vec<(ConvoAsk, AskReply)> {
    let mut map = Mapper::new(thread_id, 0);
    let mut asks = Vec::new();
    for line in lines {
        let mut out = CodexPolled::default();
        map.message(line, 0, &mut out);
        asks.extend(out.asks);
    }
    asks
}

#[cfg(test)]
pub(super) fn unwrap_shell_for_test(command: &str) -> String {
    unwrap_shell(command)
}

#[cfg(test)]
pub(super) fn launcher_sockets_for_test() -> Vec<PathBuf> {
    launcher_sockets()
}

#[cfg(test)]
pub(super) fn launcher_owned_for_test(socket: &Path) -> bool {
    launcher_owned(socket)
}
