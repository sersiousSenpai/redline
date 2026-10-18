// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The conversation mirror (Flow program, Wave B): the session stage's
//! desktop-app conversation over a real `claude` TUI running in a dock PTY.
//!
//! The CLI keeps running in its terminal exactly as before, with the user's
//! hooks, skills, settings and slash commands. This module reads the
//! conversation back out of the CLI's own transcript and streams it to the
//! stage as `src/lib/convo/types.ts` events; the composer types into the same
//! PTY (`pty::pty_submit`); permission and question asks become cards
//! answered through hooks (`asks.rs`). Every fact it relies on was measured
//! against the installed CLI in experiment (m) of
//! `docs/protocol-verification.md`.
//!
//! The pieces:
//! - [`bind`]: which transcript a terminal is, from the hooks its CLI fires
//!   (`term_attention::handle_event` forwards them here).
//! - [`claude`]: one transcript line → events, a pure function.
//! - [`tail`]: the reads (live, first, backward pages) and the ring.
//! - this file: per-terminal state ([`Term`], all of its logic, testable
//!   without an app), the one tail thread, and the commands.
//!
//! One thread tails every terminal somebody is watching (the `plan_meter`
//! model): every 150 ms while a turn runs or a card is open, every second
//! otherwise, and at once when a hook POST kicks it. Deliveries to a
//! subscription are coalesced to at most one batch per 50 ms.
//!
//! The harness is a field rather than an assumption: a Codex source (its
//! app-server thread instead of a transcript file) plugs in beside
//! [`tail::ClaudeSource`] behind the same events.

pub mod bind;
pub mod claude;
pub mod tail;
pub mod wire;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

use crate::pty::InputState;
pub use wire::*;

/// The stage holds about 400 rows; a subscription starts with this many.
const SNAPSHOT_EVENTS: usize = 200;
const FAST_TICK: Duration = Duration::from_millis(150);
const IDLE_TICK: Duration = Duration::from_secs(1);
/// At most one batch per subscription per this long.
const BATCH_GAP: Duration = Duration::from_millis(50);
/// A composer send that no prompt matched by now is undelivered, unless the
/// CLI queued it: a type-ahead waits for its turn however long that takes.
const EXPECT_WINDOW: Duration = Duration::from_secs(45);
/// How long a terminal nobody watches keeps its ring and tail, so switching
/// between Conversation and Terminal doesn't re-read the transcript.
const UNWATCHED_GRACE: Duration = Duration::from_secs(60);
/// How far back an opening permission ask looks for its `tool_use` row.
const ASK_MATCH_WINDOW: usize = 40;

/// App-wide: a terminal was bound to a session (`BoundNotice`).
pub const BOUND_EVENT: &str = "convo-bound";
/// App-wide: the CLI named its session (`TitleNotice`).
pub const TITLE_EVENT: &str = "convo-title";
const HARNESS_CLAUDE: &str = "claude";

static NEXT_HOST: AtomicU64 = AtomicU64::new(1);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> i64 {
    crate::state::now_millis()
}

fn host_id() -> String {
    format!("host:{}", NEXT_HOST.fetch_add(1, Ordering::Relaxed))
}

/// Every terminal's mirror state, keyed by PTY id.
#[derive(Clone, Default)]
pub struct ConvoState(Arc<Shared>);

#[derive(Default)]
struct Shared {
    terms: Mutex<HashMap<String, Arc<Mutex<Term>>>>,
    kicked: Mutex<bool>,
    wake: Condvar,
    started: AtomicBool,
}

/// One open ask, held by its hook until answered.
pub(crate) struct PendingAsk {
    pub ask: ConvoAsk,
    /// The tool call it is about. A question's PreToolUse payload names it;
    /// a permission's doesn't (S4), so the tail finds its `tool_use` row.
    pub tool_use_id: Option<String>,
    /// The tool input as the hook received it: a question's answers go back
    /// as this plus `answers`.
    pub input: Value,
    pub tx: oneshot::Sender<Value>,
}

struct Sub {
    id: String,
    channel: Channel<ConvoBatch>,
    pending: Vec<ConvoEvent>,
    reset: bool,
    sent: Option<Instant>,
}

struct Expect {
    nonce: String,
    key: String,
    at: Instant,
    /// The CLI took it into its type-ahead queue: it isn't late, it's next.
    queued: bool,
}

/// What a bind did, for the app to persist and announce.
struct Bound {
    session_id: String,
    path: String,
}

/// One terminal's conversation.
#[derive(Default)]
struct Term {
    binding: Option<bind::Binding>,
    /// The CLI is running: bound, with no SessionEnd since.
    live: bool,
    /// Each epoch's transcript, for paging back into it.
    epochs: Vec<(u32, PathBuf)>,
    /// `bound` and `epoch` events, kept out of the ring so a snapshot always
    /// names the session however long the conversation is.
    marks: Vec<ConvoEvent>,
    source: Option<tail::ClaudeSource>,
    ring: tail::Ring,
    subs: Vec<Sub>,
    unwatched_since: Option<Instant>,
    expects: Vec<Expect>,
    asks: Vec<PendingAsk>,
    /// The TUI is showing a dialog of its own: an ask released to it, one
    /// that was never armed, or one its Notification reported.
    dialog: bool,
    working: bool,
    next_read: Option<Instant>,
    readiness: Option<(bool, Option<Blocker>)>,
    mode: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    title: Option<String>,
}

impl Term {
    fn epoch(&self) -> u32 {
        self.binding.as_ref().map_or(0, |b| b.epoch)
    }

    /// Where the tail is: a host event's offset.
    fn offset(&self) -> u64 {
        self.source.as_ref().filter(|s| s.epoch == self.epoch()).map_or(0, |s| s.offset())
    }

    fn tailing(&self) -> bool {
        self.source.is_some() && (!self.subs.is_empty() || !self.expects.is_empty() || !self.asks.is_empty())
    }

    fn fast(&self) -> bool {
        self.working || !self.asks.is_empty() || !self.expects.is_empty()
    }

    fn host(&self, id: String, body: Body) -> ConvoEvent {
        ConvoEvent { id, epoch: self.epoch(), offset: self.offset(), ts: now_ms(), body }
    }

    /// Hand events to every subscription, and keep the ones a later snapshot
    /// needs. Readiness and open asks are rebuilt for each snapshot instead.
    fn emit(&mut self, events: Vec<ConvoEvent>) {
        for event in &events {
            if !matches!(event.body, Body::Readiness { .. } | Body::AskOpened { .. } | Body::AskClosed { .. }) {
                self.ring.push(event.clone());
            }
        }
        for sub in &mut self.subs {
            sub.pending.extend(events.iter().cloned());
        }
    }

    /// Structural events (`bound`, `epoch`): to subscribers, and kept whole.
    fn mark(&mut self, event: ConvoEvent) {
        for sub in &mut self.subs {
            sub.pending.push(event.clone());
        }
        self.marks.push(event);
    }

    // --- readiness ------------------------------------------------------------

    fn blocker(&self, input: Option<InputState>) -> Option<Blocker> {
        if self.binding.is_none() || !self.live {
            return Some(Blocker::Unbound);
        }
        let Some(input) = input else { return Some(Blocker::Unbound) };
        // The shell is in the foreground again: the CLI exited without a
        // SessionEnd (experiment (m): a killed CLI sends none).
        if !input.cli_foreground {
            return Some(Blocker::Unbound);
        }
        if !input.paste_mode {
            return Some(Blocker::NoPasteMode);
        }
        if !self.asks.is_empty() || self.dialog {
            return Some(Blocker::NativeDialog);
        }
        if input.dirty {
            return Some(Blocker::DirtyInput);
        }
        None
    }

    fn refresh(&mut self, input: Option<InputState>) {
        let blocker = self.blocker(input);
        let now = (blocker.is_none(), blocker);
        if self.readiness != Some(now) {
            self.readiness = Some(now);
            let event = self.host(host_id(), Body::Readiness { ready: now.0, blocker });
            self.emit(vec![event]);
        }
    }

    // --- binding ----------------------------------------------------------------

    fn apply_fire(&mut self, fire: bind::Fire) -> Option<Bound> {
        let step = bind::step(self.binding.as_ref(), &fire);
        self.live = true;
        let binding = bind::apply(&fire, &step)?;
        let fresh_epoch = !matches!(step, bind::Step::Bind { .. }) || self.binding.is_none();
        match step {
            bind::Step::Reset { .. } => {
                self.ring.clear();
                self.marks.clear();
                self.epochs.clear();
                self.working = false;
                self.title = None;
                for sub in &mut self.subs {
                    sub.pending.clear();
                    sub.reset = true;
                }
            }
            bind::Step::NewEpoch { epoch, reason } => {
                self.title = None;
                self.mark(ConvoEvent { id: host_id(), epoch, offset: 0, ts: now_ms(), body: Body::Epoch { reason: reason.to_string() } });
            }
            _ => {}
        }
        if self.binding.as_ref().is_none_or(|b| b.epoch != binding.epoch || b.transcript != binding.transcript) {
            self.epochs.retain(|(e, _)| *e != binding.epoch);
            self.epochs.push((binding.epoch, binding.transcript.clone()));
            self.source = Some(tail::ClaudeSource::new(binding.transcript.clone(), binding.epoch));
            self.next_read = None;
        }
        let path = binding.transcript.to_string_lossy().into_owned();
        let session_id = binding.session_id.clone();
        let offset = if fresh_epoch { 0 } else { self.offset() };
        self.binding = Some(binding);
        self.mark(ConvoEvent {
            id: host_id(),
            epoch: self.epoch(),
            offset,
            ts: now_ms(),
            body: Body::Bound {
                harness: HARNESS_CLAUDE.to_string(),
                session_id: session_id.clone(),
                transcript_path: Some(path.clone()),
                source: fire.source,
            },
        });
        Some(Bound { session_id, path })
    }

    /// The turn-level side of a hook fire (binding is [`Term::apply_fire`]).
    /// Returns whether the PTY's typed text should be forgotten.
    fn hook(&mut self, payload: &Value) -> bool {
        let field = |key: &str| payload.get(key).and_then(Value::as_str).unwrap_or_default();
        let same_session = self.binding.as_ref().is_some_and(|b| b.session_id == field("session_id"));
        let mut submitted = false;
        match field("hook_event_name") {
            "UserPromptSubmit" if same_session => {
                self.working = true;
                self.dialog = false;
                let prompt_id = Some(field("prompt_id").to_string()).filter(|p| !p.is_empty());
                let delivered = self.deliver(field("prompt"), prompt_id);
                self.emit(delivered);
                submitted = true;
            }
            "Stop" if same_session => {
                self.working = false;
                self.dialog = false;
                self.close_asks("expired", |_| true);
                // The turn's effort, which no transcript line carries until a
                // `/effort` changes it.
                let effort = payload.pointer("/effort/level").and_then(Value::as_str).map(str::to_string);
                if effort.is_some() && effort != self.effort {
                    self.effort = effort.clone();
                    let event = self.host(host_id(), Body::ModelSeen { model: self.model.clone().unwrap_or_default(), effort });
                    self.emit(vec![event]);
                }
            }
            // `clear` is followed by its SessionStart; any other end is the CLI exiting.
            "SessionEnd" if same_session && field("reason") != "clear" => {
                self.live = false;
                self.working = false;
                self.close_asks("expired", |_| true);
            }
            "Notification" if self.asks.is_empty() => {
                if matches!(field("notification_type"), "permission_prompt" | "elicitation_dialog") {
                    self.dialog = true;
                }
            }
            _ => {}
        }
        self.next_read = None;
        submitted
    }

    // --- the tail -------------------------------------------------------------

    /// Read the tail and fold what it says into the terminal's state.
    /// Returns a new session title, if a line carried one.
    fn read(&mut self) -> Option<String> {
        let first = self.ring.len() == 0;
        let earliest = self.epochs.first().map(|(e, _)| *e);
        let source = self.source.as_mut()?;
        let epoch = source.epoch;
        let polled = source.poll(now_ms());
        if first {
            self.ring.complete = !polled.skipped && earliest == Some(epoch);
        }
        let mut extra = Vec::new();
        for event in &polled.events {
            match &event.body {
                Body::UserText { text, prompt_id } => {
                    self.working = true;
                    self.dialog = false;
                    extra.extend(self.deliver(text, prompt_id.clone()));
                }
                // A send that lands while a turn runs is queued (S9): pending,
                // not late. It is delivered when its prompt line (or the
                // UserPromptSubmit that fires at its turn) arrives, or when the
                // CLI folds it into the running turn; recalled to the input
                // box, it was never sent.
                Body::Queued { op, text, reason } => match (op.as_str(), text) {
                    ("enqueue", Some(text)) => {
                        let key = match_key(text);
                        if let Some(e) = self.expects.iter_mut().find(|e| !e.queued && e.key == key) {
                            e.queued = true;
                        }
                    }
                    ("remove", Some(text)) if reason.as_deref() == Some("absorbed_mid_turn") => {
                        extra.extend(self.deliver(text, None));
                    }
                    ("remove", Some(text)) => {
                        let key = match_key(text);
                        extra.extend(self.recall(|e| e.queued && e.key == key));
                    }
                    ("popAll", _) => extra.extend(self.recall(|e| e.queued)),
                    _ => {}
                },
                Body::ToolUse { tool_use_id, name, summary } => {
                    let ask = self.asks.iter_mut().find(|a| a.tool_use_id.is_none() && a.ask.tool_name == *name && a.ask.summary == *summary);
                    if let Some(ask) = ask {
                        ask.tool_use_id = Some(tool_use_id.clone());
                    }
                }
                // The TUI took the answer (S4: its dialog races the hook).
                Body::ToolResult { tool_use_id, .. } => {
                    self.dialog = false;
                    self.close_asks("terminal", |a| a.tool_use_id.as_deref() == Some(tool_use_id.as_str()));
                }
                Body::Interrupted | Body::TurnEnd { .. } => {
                    self.working = false;
                    self.dialog = false;
                    self.close_asks("expired", |_| true);
                }
                Body::AssistantText { model: Some(model), .. } => self.model = Some(model.clone()),
                Body::ModelSeen { model, effort } => {
                    if !model.is_empty() {
                        self.model = Some(model.clone());
                    }
                    if effort.is_some() {
                        self.effort = effort.clone();
                    }
                }
                Body::ModeChange { mode } => self.mode = Some(mode.clone()),
                _ => {}
            }
        }
        self.emit(polled.events);
        self.emit(extra);
        let title = polled.title.filter(|t| self.title.as_ref() != Some(t))?;
        self.title = Some(title.clone());
        Some(title)
    }

    /// One pass of the tail thread: read if due, expire composer sends,
    /// deliver batches. Returns when this terminal next needs a pass, and a
    /// new title if the read found one.
    fn tick(&mut self, now: Instant) -> (Instant, Option<String>) {
        let mut next = now + IDLE_TICK;
        if self.subs.is_empty() {
            let since = *self.unwatched_since.get_or_insert(now);
            if now.duration_since(since) > UNWATCHED_GRACE && self.expects.is_empty() && self.asks.is_empty() {
                self.source = None;
                self.ring.clear();
            }
        } else {
            self.unwatched_since = None;
        }
        let mut title = None;
        if self.tailing() {
            if self.next_read.is_none_or(|due| now >= due) {
                title = self.read();
                self.next_read = Some(now + if self.fast() { FAST_TICK } else { IDLE_TICK });
            }
            next = next.min(self.next_read.unwrap_or(next));
        }
        let late = self.recall(|e| !e.queued && now.duration_since(e.at) >= EXPECT_WINDOW);
        self.emit(late);
        if let Some(due) = self.expects.iter().filter(|e| !e.queued).map(|e| e.at + EXPECT_WINDOW).min() {
            next = next.min(due);
        }
        next = next.min(self.flush(now));
        (next, title)
    }

    /// Deliver what each subscription is owed, at most one batch per
    /// [`BATCH_GAP`]. Returns when a held-back batch is due.
    fn flush(&mut self, now: Instant) -> Instant {
        let mut next = now + IDLE_TICK;
        self.subs.retain_mut(|sub| {
            if sub.pending.is_empty() && !sub.reset {
                return true;
            }
            let due = sub.sent.map_or(now, |sent| sent + BATCH_GAP);
            if now < due {
                next = next.min(due);
                return true;
            }
            sub.sent = Some(now);
            let batch = ConvoBatch { events: std::mem::take(&mut sub.pending), reset: std::mem::take(&mut sub.reset) };
            sub.channel.send(batch).is_ok()
        });
        next
    }

    /// Give up on the sends `which` picks: late ones, or queued ones the CLI
    /// handed back to its input box. Each becomes `undelivered`.
    fn recall(&mut self, which: impl Fn(&Expect) -> bool) -> Vec<ConvoEvent> {
        let (gone, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut self.expects).into_iter().partition(|e| which(e));
        self.expects = kept;
        gone.into_iter().map(|e| self.host(format!("undelivered:{}", e.nonce), Body::Undelivered { nonce: e.nonce })).collect()
    }

    fn deliver(&mut self, text: &str, prompt_id: Option<String>) -> Vec<ConvoEvent> {
        let key = match_key(text);
        let Some(i) = self.expects.iter().position(|e| e.key == key) else { return Vec::new() };
        let nonce = self.expects.remove(i).nonce;
        vec![self.host(format!("delivered:{nonce}"), Body::Delivered { nonce, prompt_id })]
    }

    // --- asks -------------------------------------------------------------------

    /// Arm a card when the conversation is on screen to answer it: bound to
    /// the asking session, and subscribed. Otherwise `None`: the hook answers
    /// `{}` and the TUI shows its own dialog.
    fn open_ask(&mut self, session_id: &str, ask: ConvoAsk, tool_use_id: Option<String>, input: Value) -> Option<oneshot::Receiver<Value>> {
        let armed = self.live && !self.subs.is_empty() && self.binding.as_ref().is_some_and(|b| b.session_id == session_id);
        if !armed {
            self.dialog = true;
            return None;
        }
        // A permission's payload names no tool call; its `tool_use` row
        // lands about 100 ms after the hook (S3), or is already here.
        let tool_use_id = tool_use_id.or_else(|| {
            let mut answered = HashSet::new();
            self.ring.iter().rev().take(ASK_MATCH_WINDOW).find_map(|e| match &e.body {
                Body::ToolResult { tool_use_id, .. } => {
                    answered.insert(tool_use_id.clone());
                    None
                }
                Body::ToolUse { tool_use_id, name, summary }
                    if *name == ask.tool_name && *summary == ask.summary && !answered.contains(tool_use_id) =>
                {
                    Some(tool_use_id.clone())
                }
                _ => None,
            })
        });
        let (tx, rx) = oneshot::channel();
        let opened = self.host(format!("ask:{}", ask.ask_id), Body::AskOpened { ask: ask.clone() });
        self.asks.push(PendingAsk { ask, tool_use_id, input, tx });
        self.emit(vec![opened]);
        self.next_read = None;
        Some(rx)
    }

    /// Answer an open ask; `None` when it isn't this terminal's.
    fn answer(
        &mut self,
        ask_id: &str,
        respond: impl FnOnce(&PendingAsk) -> Result<(Value, &'static str), String>,
    ) -> Option<Result<(), String>> {
        let i = self.asks.iter().position(|a| a.ask.ask_id == ask_id)?;
        let (reply, outcome) = match respond(&self.asks[i]) {
            Ok(reply) => reply,
            Err(e) => return Some(Err(e)),
        };
        let pending = self.asks.remove(i);
        // `{}` hands the ask to the TUI, which shows its own dialog.
        self.dialog |= reply.as_object().is_some_and(|o| o.is_empty());
        // A failed send is a hook that gave up first (Esc, its timeout).
        let (outcome, result) = match pending.tx.send(reply) {
            Ok(()) => (outcome, Ok(())),
            Err(_) => ("expired", Err("the ask already ended".to_string())),
        };
        let closed = self.host(format!("ask:{ask_id}:closed"), Body::AskClosed { ask_id: ask_id.to_string(), outcome: outcome.into() });
        self.emit(vec![closed]);
        Some(result)
    }

    /// An ask's hook request ended without a stage answer (the drop guard):
    /// close its card. A timed-out hook leaves the TUI's dialog up (S4).
    fn drop_ask(&mut self, ask_id: &str) -> bool {
        if !self.asks.iter().any(|a| a.ask.ask_id == ask_id) {
            return false;
        }
        self.close_asks("expired", |a| a.ask.ask_id == ask_id);
        self.dialog = true;
        true
    }

    fn close_asks(&mut self, outcome: &str, which: impl Fn(&PendingAsk) -> bool) {
        let (closed, open): (Vec<_>, Vec<_>) = std::mem::take(&mut self.asks).into_iter().partition(|a| which(a));
        self.asks = open;
        let events = closed
            .into_iter()
            .map(|pending| {
                // Moot by now: the TUI took its answer, or the turn is over.
                let _ = pending.tx.send(Value::Object(Default::default()));
                let id = format!("ask:{}:closed", pending.ask.ask_id);
                self.host(id, Body::AskClosed { ask_id: pending.ask.ask_id, outcome: outcome.to_string() })
            })
            .collect();
        self.emit(events);
    }

    // --- subscriptions -------------------------------------------------------------

    /// The recent tail, the marks that head it, open asks and readiness.
    fn snapshot(&mut self, input: Option<InputState>) -> (Vec<ConvoEvent>, bool) {
        let (events, has_older) = self.ring.tail(SNAPSHOT_EVENTS);
        let first = events.first().map(|e| (e.epoch, e.offset));
        let latest_bound = self.marks.iter().rposition(|m| matches!(m.body, Body::Bound { .. }));
        // Marks first, so a stable sort keeps them ahead of the lines they head.
        let mut all: Vec<_> = self
            .marks
            .iter()
            .enumerate()
            .filter(|(i, m)| Some(*i) == latest_bound || first.is_none_or(|f| (m.epoch, m.offset) >= f))
            .map(|(_, m)| m.clone())
            .chain(events)
            .collect();
        all.sort_by_key(|e| (e.epoch, e.offset));
        all.extend(self.asks.iter().map(|a| self.host(format!("ask:{}", a.ask.ask_id), Body::AskOpened { ask: a.ask.clone() })));
        let blocker = self.blocker(input);
        self.readiness = Some((blocker.is_none(), blocker));
        all.push(self.host(host_id(), Body::Readiness { ready: blocker.is_none(), blocker }));
        (all, has_older)
    }

    fn subscribe(&mut self, channel: Channel<ConvoBatch>, input: Option<InputState>) -> ConvoSnapshot {
        if self.source.is_none() {
            if let Some(b) = self.binding.clone() {
                self.source = Some(tail::ClaudeSource::new(b.transcript, b.epoch));
            }
        }
        if self.ring.len() == 0 {
            self.read();
        }
        let (events, has_older) = self.snapshot(input);
        let subscription_id = uuid::Uuid::new_v4().to_string();
        self.subs.push(Sub { id: subscription_id.clone(), channel, pending: Vec::new(), reset: false, sent: None });
        self.unwatched_since = None;
        ConvoSnapshot { subscription_id, events, has_older }
    }

    /// One page of older events (see [`convo_page`]).
    fn page(&self, epoch: u32, before_offset: u64) -> std::io::Result<ConvoPage> {
        let target = if before_offset == 0 {
            self.epochs.iter().filter(|(e, _)| *e < epoch).max_by_key(|(e, _)| *e).map(|(e, p)| (*e, p, u64::MAX))
        } else {
            self.epochs.iter().find(|(e, _)| *e == epoch).map(|(e, p)| (*e, p, before_offset))
        };
        let Some((epoch, path, before)) = target else { return Ok(ConvoPage { events: Vec::new(), has_older: false }) };
        let (events, start) = tail::page(path, epoch, before, now_ms())?;
        let mut page: Vec<_> = self
            .marks
            .iter()
            .filter(|m| m.epoch == epoch && m.offset >= start && m.offset < before && matches!(m.body, Body::Epoch { .. }))
            .cloned()
            .chain(events)
            .collect();
        page.sort_by_key(|e| (e.epoch, e.offset));
        Ok(ConvoPage { events: page, has_older: start > 0 || self.epochs.iter().any(|(e, _)| *e < epoch) })
    }

    /// Why a mid-session switch can't be typed now, if it can't.
    fn switch_blocker(&self, input: Option<InputState>) -> Option<String> {
        if self.working {
            return Some("Claude is working; switch when the turn ends, or in the terminal.".into());
        }
        let reason = match self.blocker(input)? {
            Blocker::Unbound | Blocker::NoPasteMode => "The session isn't ready yet.",
            Blocker::NativeDialog => "A dialog is open in the terminal.",
            Blocker::DirtyInput => "There is unsent text in the terminal.",
        };
        Some(reason.to_string())
    }
}

/// The text a composer send and the transcript's prompt are compared by: the
/// CLI wraps a long paste and expands its tabs (S6), so compare words.
pub(crate) fn match_key(text: &str) -> String {
    claude::unwrap_pastes(text).split_whitespace().collect::<Vec<_>>().join(" ")
}

// --- the app side ----------------------------------------------------------------

impl ConvoState {
    fn term(&self, id: &str) -> Option<Arc<Mutex<Term>>> {
        lock(&self.0.terms).get(id).cloned()
    }

    fn term_or_new(&self, id: &str) -> Arc<Mutex<Term>> {
        lock(&self.0.terms).entry(id.to_string()).or_default().clone()
    }

    fn terms(&self) -> Vec<(String, Arc<Mutex<Term>>)> {
        lock(&self.0.terms).iter().map(|(id, t)| (id.clone(), t.clone())).collect()
    }

    fn kick(&self) {
        *lock(&self.0.kicked) = true;
        self.0.wake.notify_one();
    }

    /// The tail thread starts with the first terminal that needs it, so a
    /// classic-shell session never runs it.
    fn ensure_started(&self, app: &AppHandle) {
        if self.0.started.swap(true, Ordering::SeqCst) {
            return;
        }
        let (app, state) = (app.clone(), self.clone());
        let spawned = std::thread::Builder::new().name("convo-tail".into()).spawn(move || tail_loop(app, state));
        if let Err(e) = spawned {
            tracing::warn!(error = %e, "failed to spawn the conversation tail");
            self.0.started.store(false, Ordering::SeqCst);
        }
    }

    fn wake(&self, app: &AppHandle) {
        self.ensure_started(app);
        self.kick();
    }
}

fn input(app: &AppHandle, id: &str) -> Option<InputState> {
    app.try_state::<crate::pty::PtyState>().and_then(|ptys| crate::pty::input_state(&ptys, id))
}

fn tail_loop(app: AppHandle, state: ConvoState) {
    loop {
        let now = Instant::now();
        let mut next = now + IDLE_TICK;
        for (id, term) in state.terms() {
            let mut t = lock(&term);
            let (due, title) = t.tick(now);
            next = next.min(due);
            if !t.subs.is_empty() {
                // Nothing reports a CLI that crashed; the foreground check does.
                t.refresh(input(&app, &id));
            }
            if let (Some(title), Some(b)) = (title, &t.binding) {
                let _ = app.emit(TITLE_EVENT, TitleNotice { terminal_id: id.clone(), session_id: b.session_id.clone(), title });
            }
        }
        // A closed terminal nobody watches has nothing left to say.
        if let Some(ptys) = app.try_state::<crate::pty::PtyState>() {
            lock(&state.0.terms).retain(|id, term| ptys.is_live(id) || !lock(term).subs.is_empty());
        }
        let mut kicked = lock(&state.0.kicked);
        if !*kicked {
            let wait = next.saturating_duration_since(Instant::now());
            kicked = match state.0.wake.wait_timeout(kicked, wait) {
                Ok((guard, _)) => guard,
                Err(poisoned) => poisoned.into_inner().0,
            };
        }
        *kicked = false;
    }
}

/// What stops the composer typing into `terminal_id` right now.
pub fn composer_blocker(app: &AppHandle, terminal_id: &str) -> Option<Blocker> {
    let Some(term) = app.try_state::<ConvoState>().and_then(|s| s.term(terminal_id)) else {
        return Some(Blocker::Unbound);
    };
    let input = input(app, terminal_id);
    let blocker = lock(&term).blocker(input);
    blocker
}

/// The PTY's input side changed (paste mode, typed text): re-derive
/// readiness. Called by `pty.rs` holding none of its locks.
pub fn input_changed(app: &AppHandle, terminal_id: &str) {
    let Some(state) = app.try_state::<ConvoState>() else { return };
    let Some(term) = state.term(terminal_id) else { return };
    let input = input(app, terminal_id);
    lock(&term).refresh(input);
    state.kick();
}

/// The main webview reloaded: every subscription went with it. Left in
/// place they would keep cards arming for a stage that no longer exists.
pub fn drop_subscriptions(app: &AppHandle) {
    let Some(state) = app.try_state::<ConvoState>() else { return };
    for (_, term) in state.terms() {
        lock(&term).subs.clear();
    }
}

/// A Claude Code hook fired in a dock terminal (`/v1/term/event`): bind,
/// confirm, or follow the turn.
pub fn observe_hook(app: &AppHandle, terminal_id: &str, entrypoint: Option<&str>, payload: &Value) {
    // A nested `claude -p` (S2) says nothing about this terminal's conversation.
    if entrypoint == Some("sdk-cli") {
        return;
    }
    let Some(state) = app.try_state::<ConvoState>() else { return };
    let Some(projects) = crate::claude_proc::claude_config_dir().map(|c| c.join("projects")) else { return };
    let fire = bind::fire_from_hook(payload, entrypoint, &projects);
    let term = match (&fire, state.term(terminal_id)) {
        (_, Some(term)) => term,
        (Some(_), None) => state.term_or_new(terminal_id),
        (None, None) => return,
    };
    let mut t = lock(&term);
    let bound = fire.and_then(|fire| t.apply_fire(fire));
    let submitted = t.hook(payload);
    if submitted {
        crate::pty::clear_typed(app, terminal_id);
    }
    t.refresh(input(app, terminal_id));
    drop(t);
    if let Some(bound) = bound {
        announce(app, terminal_id, bound);
    }
    state.wake(app);
}

/// Persist and broadcast a bind. The plan meter and Restore read the path
/// from the session row; a launch has no row yet, and the plan's own hook
/// stamps it when it arrives.
fn announce(app: &AppHandle, terminal_id: &str, bound: Bound) {
    if let Some(store) = app.try_state::<crate::state::SessionStore>() {
        let _ = store.database().set_session_transcript_path(&bound.session_id, &bound.path);
    }
    let _ = app.emit(BOUND_EVENT, BoundNotice {
        terminal_id: terminal_id.to_string(),
        session_id: bound.session_id,
        harness: HARNESS_CLAUDE.to_string(),
        transcript_path: Some(bound.path),
    });
}

pub(crate) fn open_ask(
    app: &AppHandle,
    terminal_id: &str,
    session_id: &str,
    ask: ConvoAsk,
    tool_use_id: Option<String>,
    ask_input: Value,
) -> Option<oneshot::Receiver<Value>> {
    let state = app.try_state::<ConvoState>()?;
    let term = state.term(terminal_id)?;
    let mut t = lock(&term);
    let rx = t.open_ask(session_id, ask, tool_use_id, ask_input);
    t.refresh(input(app, terminal_id));
    drop(t);
    state.wake(app);
    rx
}

pub(crate) fn answer_ask(
    app: &AppHandle,
    ask_id: &str,
    respond: impl FnOnce(&PendingAsk) -> Result<(Value, &'static str), String>,
) -> Result<(), String> {
    let state = app.try_state::<ConvoState>().ok_or("the conversation mirror isn't running")?;
    let mut respond = Some(respond);
    for (id, term) in state.terms() {
        let mut t = lock(&term);
        if !t.asks.iter().any(|a| a.ask.ask_id == ask_id) {
            continue;
        }
        let result = t.answer(ask_id, respond.take().expect("answered once"));
        t.refresh(input(app, &id));
        drop(t);
        state.kick();
        return result.unwrap_or_else(|| Err("no such ask".into()));
    }
    Err("no such ask".into())
}

pub(crate) fn drop_ask(app: &AppHandle, terminal_id: &str, ask_id: &str) {
    let Some(state) = app.try_state::<ConvoState>() else { return };
    let Some(term) = state.term(terminal_id) else { return };
    let mut t = lock(&term);
    if t.drop_ask(ask_id) {
        t.refresh(input(app, terminal_id));
        drop(t);
        state.kick();
    }
}

// --- commands ----------------------------------------------------------------------

/// Start mirroring a terminal: its recent tail now, then batches on
/// `on_batch`. Off the main thread (`OFF_MAIN_COMMANDS`): the first read of a
/// long session takes the last 4 MB of its transcript.
#[tauri::command]
pub fn convo_subscribe(
    app: AppHandle,
    state: tauri::State<'_, ConvoState>,
    terminal_id: String,
    on_batch: Channel<ConvoBatch>,
) -> Result<ConvoSnapshot, String> {
    if !crate::claude_proc::is_plain_session_id(&terminal_id) {
        return Err("not a terminal id".into());
    }
    let term = state.term_or_new(&terminal_id);
    let snapshot = lock(&term).subscribe(on_batch, input(&app, &terminal_id));
    state.wake(&app);
    Ok(snapshot)
}

#[tauri::command]
pub fn convo_unsubscribe(state: tauri::State<'_, ConvoState>, terminal_id: String, subscription_id: String) {
    if let Some(term) = state.term(&terminal_id) {
        lock(&term).subs.retain(|s| s.id != subscription_id);
    }
}

/// Older events, before `(epoch, before_offset)`: one 1 MB window of that
/// epoch's transcript (widened to whole lines), or the end of the previous
/// epoch's when `before_offset` is its start. Off the main thread
/// (`OFF_MAIN_COMMANDS`).
#[tauri::command]
pub fn convo_page(
    state: tauri::State<'_, ConvoState>,
    terminal_id: String,
    epoch: u32,
    before_offset: u64,
) -> Result<ConvoPage, String> {
    let Some(term) = state.term(&terminal_id) else { return Ok(ConvoPage { events: Vec::new(), has_older: false }) };
    let page = lock(&term).page(epoch, before_offset);
    page.map_err(|e| e.to_string())
}

/// Announce a composer send before it is typed: the stage shows the bubble
/// at once, and this reconciles it with the CLI's prompt (`delivered`) or
/// gives up after 45 s (`undelivered`).
#[tauri::command]
pub fn convo_expect(app: AppHandle, state: tauri::State<'_, ConvoState>, terminal_id: String, nonce: String, text: String) {
    let term = state.term_or_new(&terminal_id);
    let key = match_key(&crate::pty::sanitize(&text));
    lock(&term).expects.push(Expect { nonce, key, at: Instant::now(), queued: false });
    state.wake(&app);
}

/// Bind a terminal to a session before its CLI says so: Restore resumes a
/// known conversation, and the stage can show its history while `claude`
/// starts. The SessionStart that follows confirms it. Off the main thread
/// (`OFF_MAIN_COMMANDS`): it looks for the transcript on disk.
#[tauri::command]
pub fn convo_prebind(app: AppHandle, state: tauri::State<'_, ConvoState>, terminal_id: String, session_id: String) -> bool {
    let Some(transcript) = crate::claude_proc::find_transcript(&session_id) else { return false };
    // The same spelling SessionStart's path gets (`transcript_target`), so
    // the CLI's own fire confirms this binding instead of moving it.
    let transcript = transcript.canonicalize().unwrap_or(transcript);
    let term = state.term_or_new(&terminal_id);
    let mut t = lock(&term);
    let bound = t.apply_fire(bind::Fire { source: "restore".into(), session_id, transcript, starts: true });
    // Not running yet: the composer waits for the CLI's own SessionStart.
    t.live = false;
    t.refresh(input(&app, &terminal_id));
    drop(t);
    if let Some(bound) = bound {
        announce(&app, &terminal_id, bound);
    }
    state.wake(&app);
    true
}

fn switch_blocker(app: &AppHandle, terminal_id: &str) -> Option<String> {
    let Some(term) = app.try_state::<ConvoState>().and_then(|s| s.term(terminal_id)) else {
        return Some("The session isn't running.".into());
    };
    let input = input(app, terminal_id);
    let reason = lock(&term).switch_blocker(input);
    reason
}

/// Mid-session mode switch while idle. Only plan mode has a command
/// (`/plan`, S7); leaving it, or any other mode, is Shift+Tab's cycle, whose
/// order depends on the account, so that stays in the terminal. Off the
/// main thread (`OFF_MAIN_COMMANDS`): the command is typed, paced.
#[tauri::command]
pub fn convo_set_mode(app: AppHandle, terminal_id: String, mode: String) -> Result<SwitchResult, String> {
    if mode != "plan" {
        return Ok(SwitchResult::Terminal { reason: "Switch this mode with Shift+Tab in the terminal.".into() });
    }
    let current = app.try_state::<ConvoState>().and_then(|s| s.term(&terminal_id)).and_then(|t| lock(&t).mode.clone());
    if current.as_deref() == Some("plan") {
        return Ok(SwitchResult::Sent);
    }
    if let Some(reason) = switch_blocker(&app, &terminal_id) {
        return Ok(SwitchResult::Terminal { reason });
    }
    crate::pty::submit_text(&app.state::<crate::pty::PtyState>(), &terminal_id, "/plan")?;
    Ok(SwitchResult::Sent)
}

/// `/effort` asks for confirmation before it switches (S8 and its
/// follow-up); this long for the dialog to draw before Return confirms it.
const EFFORT_CONFIRM_DELAY: Duration = Duration::from_millis(700);

/// Mid-session `/model <id>` and/or `/effort <level>` while idle. The CLI
/// also makes each the user's default for new sessions. Off the main thread
/// (`OFF_MAIN_COMMANDS`).
#[tauri::command]
pub fn convo_set_model(
    app: AppHandle,
    terminal_id: String,
    model: Option<String>,
    effort: Option<String>,
) -> Result<SwitchResult, String> {
    let model = slash_arg(model, "-._:[]")?;
    let effort = slash_arg(effort, "")?;
    if model.is_none() && effort.is_none() {
        return Ok(SwitchResult::Sent);
    }
    if let Some(reason) = switch_blocker(&app, &terminal_id) {
        return Ok(SwitchResult::Terminal { reason });
    }
    let ptys = app.state::<crate::pty::PtyState>();
    if let Some(model) = model {
        crate::pty::submit_text(&ptys, &terminal_id, &format!("/model {model}"))?;
    }
    if let Some(effort) = effort {
        crate::pty::submit_text(&ptys, &terminal_id, &format!("/effort {effort}"))?;
        std::thread::sleep(EFFORT_CONFIRM_DELAY);
        crate::pty::press_return(&ptys, &terminal_id)?;
    }
    Ok(SwitchResult::Sent)
}

/// A slash-command argument: one short token, nothing a shell or the TUI
/// could read as more than a name.
fn slash_arg(value: Option<String>, extra: &str) -> Result<Option<String>, String> {
    let Some(value) = value.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) else { return Ok(None) };
    if value.len() <= 64 && value.chars().all(|c| c.is_ascii_alphanumeric() || extra.contains(c)) {
        Ok(Some(value))
    } else {
        Err(format!("not a model or effort level: {value}"))
    }
}

#[cfg(test)]
mod tests;
