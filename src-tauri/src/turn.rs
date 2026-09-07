// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The shared turn registry: one lifecycle contract for every streaming chat
//! surface (browse, linked, mission, draft_chat, memchat, companion, fork).
//!
//! Each of those modules used to hold its own `Mutex<HashMap<key, Proc>>`
//! where presence-of-key doubled as the busy guard. Three gaps drove this
//! module:
//!
//! 1. The guard was check-then-insert with an `.await` (the spawn) in
//!    between — two sends racing the spawn window could both pass. `begin`
//!    reserves the slot atomically BEFORE any async work.
//! 2. Streamed reply text lived only in frontend component state, so a
//!    surface switch (full unmount) lost it. `PartialBuf` accumulates the
//!    reply server-side; `status` hands it to a remounting panel.
//! 3. Nothing could tell a freshly mounted panel whether a turn was in
//!    flight. `status` is that probe, uniform across surfaces.
//!
//! `Q` is the queued-send payload type — everything a surface needs to start
//! the send later (text, snapshot, flags). Sends opt into queueing explicitly
//! (`queue: true`); consult/daemon paths keep the busy error, which is
//! load-bearing flow control for a colleague's blocking curl.
//!
//! Voice deliberately does NOT use this registry — its persistent stdin child
//! plus `in_flight: AtomicBool` is a different machine that already meets the
//! status contract via `voice_session_status`.
//!
//! Lock discipline matches the registries this replaces: one `std::sync`
//! mutex over the whole inner state, held only for tiny `lock → mutate →
//! drop` critical sections, never across an `.await`. Lock order where both
//! are taken (only `status`): registry lock first, then the buffer lock.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tokio::process::Child;

use crate::state::now_millis;

/// Soft cap on buffered partial-reply text. Once the text reaches this, a
/// runaway turn stops growing the buffer (one append may overshoot slightly),
/// but `seq` keeps counting so the frontend's delta-dedupe guard stays sound
/// past the cap.
pub const PARTIAL_CAP_BYTES: usize = 4 * 1024 * 1024;

/// Most sends that can wait behind one key's in-flight turn. Type-ahead is a
/// convenience, not a work scheduler — past this the sender gets a hard error.
pub const QUEUE_CAP: usize = 5;

/// Activity entries kept per turn. Bounded because `docs/perf-budget.md`
/// Rule 2 forbids unbounded buffered content; a turn that made 500 tool calls
/// is interesting in its tail, not its head.
pub const ACTIVITY_CAP: usize = 200;

/// Floor between coalesced `{surface}-meter` events (perf-budget Rule 3).
/// Text deltas already fire per token; the meter must never ride them.
/// A DISCRETE change (first model, new tool, rate-limit onset, the terminal)
/// jumps this queue — see [`MeterPacer`].
pub const METER_COALESCE_MS: i64 = 250;

/// What a remounting panel learns about a key's turn: whether one is
/// streaming, since when, the reply text streamed so far, and how many deltas
/// that text folds in (`seq`). The frontend drops any delta event carrying
/// `seq <= this.seq` — see [`push_delta`] for why that is sound.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnStatus {
    pub streaming: bool,
    pub started_at: Option<i64>,
    /// Reply text streamed so far; `None` when idle.
    pub partial: Option<String>,
    /// Deltas folded into `partial` (0 when idle).
    pub seq: u64,
    /// Sends waiting behind the in-flight turn (Phase 3; empty until then).
    pub queued: Vec<QueuedTurn>,
    /// What the turn has spent and which model is spending it; `None` when
    /// idle or when nothing has been observed yet. A remounting panel adopts
    /// this the same way it adopts `partial`/`seq` — otherwise the badge and
    /// the footer blank out on every surface switch.
    pub meter: Option<crate::meter::TurnMeter>,
    /// What the turn was doing while you waited (bounded ring).
    pub activity: Vec<crate::meter::Activity>,
}

/// One queued send, as surfaced to the frontend.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedTurn {
    pub message_id: String,
    pub text: String,
    pub queued_at: i64,
}

/// What a send command resolves to: the turn started now, or it queued behind
/// the in-flight one. `message_id` is the persisted user row either way — the
/// frontend reconciles its optimistic bubble onto it.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendOutcome {
    pub started: bool,
    pub queued: bool,
    pub message_id: String,
}

/// `begin_or_enqueue`'s verdict. `Began` hands the payload back — the caller
/// starts the turn with it now; a queued payload is stored until the drain.
pub enum SendSlot<Q> {
    Began(SlotGuard<Q>, Q),
    Enqueued,
    QueueFull,
}

/// What every `start_{surface}_turn` returns. Boxed and type-erased because
/// the starter and its reader are mutually recursive futures (the reader's
/// queue drain calls the starter) — an opaque `async fn` type can't close
/// that cycle.
pub type BoxStartFuture = std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<(), String>> + Send>,
>;

/// The in-flight turn's accumulated reply. Shared between the spawning
/// command (which registers it), the stream reader (which appends via
/// [`push_delta`]), and `status` (which clones it out for a probe).
pub struct PartialBuf {
    pub text: String,
    pub seq: u64,
    /// The turn's meter — one per turn, because the dedupe state
    /// (`message.id` -> usage) has to persist across the turn's lines.
    pub meter: crate::meter::TurnMeter,
    /// Bounded ring of activity entries, oldest dropped first.
    pub activity: VecDeque<crate::meter::Activity>,
}

impl PartialBuf {
    pub fn new() -> Self {
        PartialBuf {
            text: String::new(),
            seq: 0,
            meter: crate::meter::TurnMeter::new(),
            activity: VecDeque::new(),
        }
    }
}

impl Default for PartialBuf {
    fn default() -> Self {
        Self::new()
    }
}

/// One in-flight turn. `child` is `None` during the spawn window — the slot
/// is *reserved* (busy to every other sender) before the async spawn begins.
pub struct TurnProc {
    pub child: Option<Child>,
    pub started_at: i64,
    pub partial: Arc<Mutex<PartialBuf>>,
    /// Reservation generation, matched by `SlotGuard` so a stale guard from
    /// an aborted send can never release a successor turn's slot.
    token: u64,
}

/// `begin` found the slot occupied: a turn is already streaming (or reserved
/// mid-spawn) for this key. Rejection is side-effect-free by construction —
/// callers map this to their surface's busy message.
#[derive(Debug)]
pub struct Busy;

struct TurnsInner<Q> {
    procs: HashMap<String, TurnProc>,
    queues: HashMap<String, VecDeque<(QueuedTurn, Q)>>,
}

/// The registry: procs + (Phase 3) queues behind ONE lock, so busy checks,
/// reservations, and queue transitions can never interleave.
pub struct Turns<Q> {
    inner: Mutex<TurnsInner<Q>>,
    next_token: AtomicU64,
}

impl<Q> Default for Turns<Q> {
    fn default() -> Self {
        Self::new()
    }
}

impl<Q> Turns<Q> {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(TurnsInner {
                procs: HashMap::new(),
                queues: HashMap::new(),
            }),
            next_token: AtomicU64::new(1),
        }
    }

    /// Insert a fresh reservation for `key` and build its guard. The caller
    /// holds the lock and has already checked the slot is free.
    fn reserve_locked(self: &Arc<Self>, inner: &mut TurnsInner<Q>, key: &str) -> SlotGuard<Q> {
        let token = self.next_token.fetch_add(1, Ordering::Relaxed);
        let partial = Arc::new(Mutex::new(PartialBuf::new()));
        inner.procs.insert(
            key.to_string(),
            TurnProc {
                child: None,
                started_at: now_millis(),
                partial: partial.clone(),
                token,
            },
        );
        SlotGuard {
            turns: self.clone(),
            key: key.to_string(),
            token,
            partial,
            armed: true,
        }
    }

    /// Atomically reserve the key's slot for a new turn. From this moment
    /// every other `begin` sees Busy — including across the caller's spawn
    /// `.await`s, which is exactly the window the old check-then-insert
    /// guards left open. The returned guard releases the reservation if
    /// dropped before [`SlotGuard::attach`], so an early `?` return in the
    /// send path cannot strand a phantom "streaming" slot.
    ///
    /// A WAITING QUEUE also reads Busy: `begin` is the non-queueing path
    /// (consults), and its terminal reap never drains — letting it slip into
    /// the cancel→drain window would strand the queued sends behind a turn
    /// that won't advance them.
    pub fn begin(self: &Arc<Self>, key: &str) -> Result<SlotGuard<Q>, Busy> {
        let mut inner = self.inner.lock().unwrap();
        if inner.procs.contains_key(key)
            || inner.queues.get(key).is_some_and(|q| !q.is_empty())
        {
            return Err(Busy);
        }
        Ok(self.reserve_locked(&mut inner, key))
    }

    /// `begin`, except a busy slot ENQUEUES the send (up to [`QUEUE_CAP`])
    /// instead of rejecting it. One critical section: the busy check and the
    /// enqueue can't interleave with a concurrent `finish_and_pop`, so a send
    /// either starts, or lands behind a turn whose terminal drain will see it.
    pub fn begin_or_enqueue(self: &Arc<Self>, key: &str, turn: QueuedTurn, payload: Q) -> SendSlot<Q> {
        let mut inner = self.inner.lock().unwrap();
        if inner.procs.contains_key(key) {
            let q = inner.queues.entry(key.to_string()).or_default();
            if q.len() >= QUEUE_CAP {
                return SendSlot::QueueFull;
            }
            q.push_back((turn, payload));
            return SendSlot::Enqueued;
        }
        let guard = self.reserve_locked(&mut inner, key);
        SendSlot::Began(guard, payload)
    }

    /// Terminal reap + queue drain, in ONE critical section: remove the
    /// finished turn's proc, pop the queue head, and immediately re-reserve
    /// the slot for it. A concurrent `begin_or_enqueue` serializes before
    /// (sees the proc → enqueues) or after (sees the re-reservation →
    /// enqueues behind); no interleaving yields two live turns.
    ///
    /// TOKEN-MATCHED: only the reader that owns `token` reaps the proc. A
    /// reader outliving a cancel (still draining EOF while a successor turn
    /// begins on the same key) gets `(None, None)` — it must not steal the
    /// successor's proc, and the successor's own reader drains the queue.
    /// When the slot is simply free (cancelled, no successor yet), the
    /// cancelled reader still drains — Stop cancels the CURRENT turn only,
    /// the queue advances regardless.
    pub fn finish_and_pop(
        self: &Arc<Self>,
        key: &str,
        token: u64,
    ) -> (Option<TurnProc>, Option<(QueuedTurn, Q, SlotGuard<Q>)>) {
        let mut inner = self.inner.lock().unwrap();
        let owned = inner.procs.get(key).is_some_and(|p| p.token == token);
        let proc = if owned { inner.procs.remove(key) } else { None };
        if !owned && inner.procs.contains_key(key) {
            // A successor turn is live; its reader owns the drain.
            return (None, None);
        }
        let next = inner.queues.get_mut(key).and_then(|q| q.pop_front());
        match next {
            Some((turn, payload)) => {
                let guard = self.reserve_locked(&mut inner, key);
                (proc, Some((turn, payload, guard)))
            }
            None => (proc, None),
        }
    }

    /// Remove one queued send by its message id (the composer's ×). `None`
    /// when it already advanced (or never existed) — the caller treats that
    /// as "too late", not an error.
    pub fn unqueue(&self, key: &str, message_id: &str) -> Option<QueuedTurn> {
        let mut inner = self.inner.lock().unwrap();
        let q = inner.queues.get_mut(key)?;
        let pos = q.iter().position(|(t, _)| t.message_id == message_id)?;
        q.remove(pos).map(|(t, _)| t)
    }

    /// Remove the key's turn (cancel / discard / terminal reap). The caller
    /// owns any returned child — `start_kill` stays at call sites. A turn
    /// cancelled during its spawn window returns `child: None`; the eventual
    /// `attach` then fails and the spawner kills the fresh child itself.
    /// The queue is deliberately untouched: Stop cancels the CURRENT turn
    /// only, and the cancelled reader's `finish_and_pop` still drains.
    pub fn take(&self, key: &str) -> Option<TurnProc> {
        self.inner.lock().unwrap().procs.remove(key)
    }

    /// `take`, token-matched: only removes the turn the caller owns. For the
    /// inline consult paths' terminal reap — a consult draining its stream
    /// must not steal a successor turn started after a cancel.
    pub fn take_owned(&self, key: &str, token: u64) -> Option<TurnProc> {
        let mut inner = self.inner.lock().unwrap();
        if inner.procs.get(key).is_some_and(|p| p.token == token) {
            inner.procs.remove(key)
        } else {
            None
        }
    }

    /// Remove the key's turn AND drop its queue — for thread discard/clear/
    /// delete, where queued sends target a conversation that no longer
    /// exists. The cancelled reader's drain then finds nothing to pop.
    pub fn discard(&self, key: &str) -> Option<TurnProc> {
        let mut inner = self.inner.lock().unwrap();
        inner.queues.remove(key);
        inner.procs.remove(key)
    }

    /// Whether a turn is streaming (or reserved mid-spawn) for this key.
    pub fn is_running(&self, key: &str) -> bool {
        self.inner.lock().unwrap().procs.contains_key(key)
    }

    /// Snapshot a key's turn for a remounting panel.
    pub fn status(&self, key: &str) -> TurnStatus {
        let inner = self.inner.lock().unwrap();
        let queued: Vec<QueuedTurn> = inner
            .queues
            .get(key)
            .map(|q| q.iter().map(|(t, _)| t.clone()).collect())
            .unwrap_or_default();
        match inner.procs.get(key) {
            Some(p) => {
                let buf = p.partial.lock().unwrap();
                TurnStatus {
                    streaming: true,
                    started_at: Some(p.started_at),
                    partial: Some(buf.text.clone()),
                    seq: buf.seq,
                    queued,
                    meter: (!buf.meter.is_empty()).then(|| buf.meter.clone()),
                    activity: buf.activity.iter().cloned().collect(),
                }
            }
            None => TurnStatus {
                streaming: false,
                started_at: None,
                partial: None,
                seq: 0,
                queued,
                meter: None,
                activity: Vec::new(),
            },
        }
    }

    /// Kill every running turn and drop every queue. Backs the per-surface
    /// `*_kill_all` commands and app teardown.
    pub fn kill_all(&self) {
        let drained: Vec<TurnProc> = {
            let mut inner = self.inner.lock().unwrap();
            inner.queues.clear();
            inner.procs.drain().map(|(_, p)| p).collect()
        };
        for proc in drained {
            if let Some(mut child) = proc.child {
                let _ = child.start_kill();
            }
        }
    }

    /// Attach the spawned child to its reservation. Fails (returning the
    /// child to be killed) when the reservation is gone — cancelled during
    /// the spawn window — or was superseded (token mismatch).
    fn attach_inner(&self, key: &str, token: u64, child: Child) -> Result<(), Child> {
        let mut inner = self.inner.lock().unwrap();
        match inner.procs.get_mut(key) {
            Some(p) if p.token == token && p.child.is_none() => {
                p.child = Some(child);
                Ok(())
            }
            _ => Err(child),
        }
    }

    /// Swap a still-reserved turn's child for a freshly spawned one, keeping
    /// the SAME reservation. Backs `fork.rs`'s one-shot auto-retry of a
    /// transient failure: the slot has to stay held across the respawn, or
    /// **Stop** would kill the exhausted child and leave the live one running,
    /// and a queued send would start on top of a turn the user still sees
    /// streaming.
    ///
    /// Token-matched. `Err(fresh)` means the reservation is gone (cancelled
    /// mid-retry) or was superseded — the caller kills the child it just
    /// spawned and settles the turn as cancelled. `Ok(previous)` hands back
    /// the exhausted child so the caller can reap it.
    ///
    /// `started_at` deliberately survives: the elapsed counter measures how
    /// long the reviewer has been waiting, which the retry does not reset.
    pub fn reattach(&self, key: &str, token: u64, child: Child) -> Result<Option<Child>, Child> {
        let mut inner = self.inner.lock().unwrap();
        match inner.procs.get_mut(key) {
            Some(p) if p.token == token => Ok(p.child.replace(child)),
            _ => Err(child),
        }
    }

    /// Release a reservation whose spawn never completed. Token-matched: if
    /// the slot was already taken and re-reserved by a newer turn, a stale
    /// abort must not touch it.
    fn abort_inner(&self, key: &str, token: u64) {
        let mut inner = self.inner.lock().unwrap();
        if inner
            .procs
            .get(key)
            .is_some_and(|p| p.token == token && p.child.is_none())
        {
            inner.procs.remove(key);
        }
    }
}

/// The reservation handle `begin` returns. Holds the slot across the send
/// path's async work; on Drop before `attach`, the reservation is released
/// (so error `?` returns can't strand a phantom busy slot).
pub struct SlotGuard<Q> {
    turns: Arc<Turns<Q>>,
    key: String,
    token: u64,
    partial: Arc<Mutex<PartialBuf>>,
    armed: bool,
}

impl<Q> SlotGuard<Q> {
    /// The turn's partial-reply buffer, for the stream reader to append into.
    pub fn buf(&self) -> Arc<Mutex<PartialBuf>> {
        self.partial.clone()
    }

    /// The reservation's token. The reader carries it into the terminal
    /// `finish_and_pop`/`take_owned` so only the turn's own reader reaps it.
    pub fn token(&self) -> u64 {
        self.token
    }

    /// Hand the spawned child to the reservation, defusing the guard.
    /// `Err(child)` means the slot vanished during the spawn window (the user
    /// cancelled) — the caller must kill the returned child and settle the
    /// turn as cancelled.
    pub fn attach(mut self, child: Child) -> Result<(), Child> {
        self.armed = false;
        self.turns.attach_inner(&self.key, self.token, child)
    }
}

impl<Q> Drop for SlotGuard<Q> {
    fn drop(&mut self) {
        if self.armed {
            self.turns.abort_inner(&self.key, self.token);
        }
    }
}

/// Fold a streamed delta into the turn's buffer and return the new `seq`.
///
/// INVARIANT (load-bearing — never reorder): append here FIRST, under the
/// buffer lock, THEN emit the delta event carrying the returned `seq`. A
/// concurrent `status` probe then observes either the text without this
/// delta (and a smaller seq) or the text with it (and `seq >=` the event's).
/// That is what makes the frontend rule "drop deltas with `seq <=` the
/// probed seq" lossless: no delta can be both missing from the probe text
/// and dropped by the guard. Emitting before appending would break this.
pub fn push_delta(buf: &Mutex<PartialBuf>, text: &str) -> u64 {
    let mut b = buf.lock().unwrap();
    b.seq += 1;
    if b.text.len() < PARTIAL_CAP_BYTES {
        b.text.push_str(text);
    }
    b.seq
}

/// What one folded line changed about the turn's meter — the payload of a
/// `{surface}-meter` event, once the pacer says it's due.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeterPayload {
    pub rev: u64,
    pub meter: crate::meter::TurnMeter,
    /// The entry this line earned, if any. Surfaces render the newest one as
    /// the activity line; the full ring comes back from `status`.
    pub activity: Option<crate::meter::Activity>,
    /// Worth interrupting the coalescing tick for. Reader-side only — the
    /// frontend has no use for it.
    #[serde(skip)]
    pub discrete: bool,
}

/// Fold one parsed line into the turn's meter and activity ring.
///
/// INVARIANT (identical to [`push_delta`], and for the same reason): mutate
/// under the buffer lock FIRST, emit the event second. A concurrent `status`
/// probe then observes either the meter without this line (and a smaller
/// `rev`) or the meter with it (and `rev >=` the event's), which is what makes
/// the frontend rule "drop meter events with `rev <=` the probed rev"
/// lossless. Monotone rather than additive, so a dropped event costs nothing.
///
/// Returns `None` when the line said nothing new — which is the common case,
/// including every text delta.
pub fn push_meta(buf: &Mutex<PartialBuf>, v: &serde_json::Value) -> Option<MeterPayload> {
    let at = now_millis();
    let mut b = buf.lock().unwrap();
    let before = b.meter.clone();
    let changed = b.meter.observe(v);
    let activity = crate::meter::activity_from(v, &before, &b.meter, at).filter(|a| {
        // A turn thinks in a hundred deltas and requests three times; one row
        // per repeat would bury the ring's tail in noise.
        b.activity
            .back()
            .map(|last| last.kind != a.kind || last.label != a.label)
            .unwrap_or(true)
    });
    if let Some(a) = &activity {
        if b.activity.len() >= ACTIVITY_CAP {
            b.activity.pop_front();
        }
        b.activity.push_back(a.clone());
        // `system`/`status` carries no usage fact, so `observe` left `rev`
        // alone — bump it here or the frontend's guard drops the event.
        if !changed {
            b.meter.bump_rev();
        }
    } else if !changed {
        return None;
    }
    Some(MeterPayload {
        rev: b.meter.rev,
        discrete: b.meter.is_discrete_change(&before) || activity.is_some(),
        meter: b.meter.clone(),
        activity,
    })
}

/// The coalescer that keeps the meter off the per-token path (perf-budget
/// Rule 3). One per reader loop.
#[derive(Default)]
pub struct MeterPacer {
    last_ms: i64,
}

impl MeterPacer {
    /// Whether this update is due to be emitted now. Discrete changes — the
    /// first model observation, a new tool call, a rate-limit onset, the
    /// terminal adoption — jump the queue, because they are exactly the ones
    /// a waiting user is looking at the pane for.
    pub fn due(&mut self, payload: &MeterPayload) -> bool {
        let now = now_millis();
        if payload.discrete || now - self.last_ms >= METER_COALESCE_MS {
            self.last_ms = now;
            return true;
        }
        false
    }

    /// Force the next `due` to pass — the terminal emission, which must land
    /// whatever the clock says.
    pub fn force(&mut self) {
        self.last_ms = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turns() -> Arc<Turns<()>> {
        Arc::new(Turns::new())
    }

    #[test]
    fn begin_twice_is_busy_until_taken() {
        let t = turns();
        let guard = t.begin("k").expect("first begin");
        assert!(t.begin("k").is_err(), "reserved slot must read busy");
        assert!(t.is_running("k"), "a reservation counts as running");
        // Another key is unaffected.
        drop(t.begin("other").expect("independent key"));
        drop(guard); // abort — releases the reservation
        assert!(!t.is_running("k"));
        drop(t.begin("k").expect("begin after abort"));
    }

    #[test]
    fn status_reflects_partial_and_seq() {
        let t = turns();
        let idle = t.status("k");
        assert!(!idle.streaming);
        assert_eq!(idle.started_at, None);
        assert_eq!(idle.partial, None);
        assert_eq!(idle.seq, 0);
        assert!(idle.queued.is_empty());

        let guard = t.begin("k").unwrap();
        let buf = guard.buf();
        assert_eq!(push_delta(&buf, "Hello "), 1);
        assert_eq!(push_delta(&buf, "world"), 2);
        let live = t.status("k");
        assert!(live.streaming);
        assert!(live.started_at.is_some());
        assert_eq!(live.partial.as_deref(), Some("Hello world"));
        assert_eq!(live.seq, 2);

        drop(guard);
        let after = t.status("k");
        assert!(!after.streaming);
        assert_eq!(after.partial, None);
        assert_eq!(after.seq, 0);
    }

    #[test]
    fn push_delta_caps_text_but_seq_keeps_counting() {
        let buf = Mutex::new(PartialBuf::new());
        // One oversized append reaches the cap (soft: a single append may
        // overshoot; growth stops from then on).
        let big = "x".repeat(PARTIAL_CAP_BYTES);
        assert_eq!(push_delta(&buf, &big), 1);
        let len_at_cap = buf.lock().unwrap().text.len();
        assert!(len_at_cap >= PARTIAL_CAP_BYTES);
        assert_eq!(push_delta(&buf, "more"), 2);
        assert_eq!(push_delta(&buf, "and more"), 3);
        let b = buf.lock().unwrap();
        assert_eq!(b.text.len(), len_at_cap, "text must stop growing at the cap");
        assert_eq!(b.seq, 3, "seq must keep counting past the cap");
    }

    #[test]
    fn stale_guard_drop_must_not_release_a_successor_reservation() {
        // ABA: begin → cancel (take) → a NEW turn begins on the same key →
        // the ORIGINAL send path errors and drops its guard. The stale abort
        // must leave the successor's reservation untouched.
        let t = turns();
        let stale = t.begin("k").unwrap();
        assert!(t.take("k").is_some(), "cancel takes the reservation");
        let fresh = t.begin("k").expect("successor begins");
        drop(stale);
        assert!(
            t.is_running("k"),
            "stale guard drop released the successor's reservation"
        );
        drop(fresh);
        assert!(!t.is_running("k"));
    }

    fn qt(id: &str) -> QueuedTurn {
        QueuedTurn {
            message_id: id.to_string(),
            text: format!("text of {id}"),
            queued_at: 0,
        }
    }

    #[test]
    fn begin_or_enqueue_starts_when_free_and_queues_in_order_up_to_cap() {
        let t = turns();
        // Free slot: begins, handing the payload back.
        let SendSlot::Began(guard, ()) = t.begin_or_enqueue("k", qt("m0"), ()) else {
            panic!("free slot must begin");
        };
        // Busy slot: enqueues, preserving order, until the cap.
        for i in 1..=QUEUE_CAP {
            match t.begin_or_enqueue("k", qt(&format!("m{i}")), ()) {
                SendSlot::Enqueued => {}
                _ => panic!("send {i} must enqueue behind the live turn"),
            }
        }
        assert!(matches!(
            t.begin_or_enqueue("k", qt("overflow"), ()),
            SendSlot::QueueFull
        ));
        let status = t.status("k");
        assert_eq!(status.queued.len(), QUEUE_CAP);
        assert_eq!(status.queued[0].message_id, "m1");
        assert_eq!(status.queued[QUEUE_CAP - 1].message_id, format!("m{QUEUE_CAP}"));
        // Another key's queue is independent.
        assert!(t.status("other").queued.is_empty());
        drop(guard);
    }

    #[test]
    fn finish_and_pop_reaps_owner_pops_head_and_rereserves() {
        let t = turns();
        let SendSlot::Began(guard, ()) = t.begin_or_enqueue("k", qt("m0"), ()) else {
            panic!("must begin");
        };
        let token = guard.token();
        assert!(matches!(t.begin_or_enqueue("k", qt("m1"), ()), SendSlot::Enqueued));
        assert!(matches!(t.begin_or_enqueue("k", qt("m2"), ()), SendSlot::Enqueued));
        // Defuse the guard the way a real send does (no child needed here:
        // finish_and_pop reaps by token, not by child).
        std::mem::forget(guard);

        let (proc, next) = t.finish_and_pop("k", token);
        assert!(proc.is_some(), "the owner reaps its proc");
        let (turn, (), slot) = next.expect("the queue head pops");
        assert_eq!(turn.message_id, "m1");
        // The slot was re-reserved INSIDE the same critical section: busy to
        // every sender, and the remaining queue is intact behind it.
        assert!(t.is_running("k"));
        assert!(matches!(t.begin_or_enqueue("k", qt("m3"), ()), SendSlot::Enqueued));
        let status = t.status("k");
        assert_eq!(status.queued.len(), 2);
        assert_eq!(status.queued[0].message_id, "m2");
        drop(slot);
    }

    #[test]
    fn finish_and_pop_token_mismatch_must_not_steal_a_successor_turn() {
        // The steal race this closes: cancel → instant resend → the OLD
        // turn's reader (still draining EOF) reaches its terminal reap. It
        // must neither take the successor's proc nor drain the queue out
        // from under it.
        let t = turns();
        let old = t.begin("k").unwrap();
        let old_token = old.token();
        std::mem::forget(old);
        assert!(t.take("k").is_some(), "cancel takes the old turn");
        let successor = t.begin("k").expect("instant resend begins");
        assert!(matches!(t.begin_or_enqueue("k", qt("q1"), ()), SendSlot::Enqueued));

        let (proc, next) = t.finish_and_pop("k", old_token);
        assert!(proc.is_none(), "stale reader must not steal the successor");
        assert!(next.is_none(), "the successor's reader owns the drain");
        assert!(t.is_running("k"));
        assert_eq!(t.status("k").queued.len(), 1);

        // The successor's own terminal drain still works.
        let (proc, next) = t.finish_and_pop("k", successor.token());
        std::mem::forget(successor);
        assert!(proc.is_some());
        assert_eq!(next.expect("drains q1").0.message_id, "q1");
    }

    #[test]
    fn cancelled_reader_still_drains_when_no_successor_took_the_slot() {
        // Stop cancels the CURRENT turn only — the queue advances.
        let t = turns();
        let guard = t.begin("k").unwrap();
        let token = guard.token();
        std::mem::forget(guard);
        assert!(matches!(t.begin_or_enqueue("k", qt("q1"), ()), SendSlot::Enqueued));
        assert!(t.take("k").is_some(), "cancel");

        let (proc, next) = t.finish_and_pop("k", token);
        assert!(proc.is_none(), "the cancel already took the proc");
        let (turn, (), slot) = next.expect("the cancelled reader drains");
        assert_eq!(turn.message_id, "q1");
        assert!(t.is_running("k"), "the drained turn holds the slot");
        drop(slot);
    }

    #[test]
    fn finish_and_pop_is_atomic_against_a_racing_send() {
        // Whatever the interleaving, the racing send can never see a free
        // slot between "finish" and "re-reserve": it either queues behind the
        // finishing turn or behind the drained one.
        for _ in 0..64 {
            let t = turns();
            let guard = t.begin("k").unwrap();
            let token = guard.token();
            std::mem::forget(guard);
            assert!(matches!(t.begin_or_enqueue("k", qt("a"), ()), SendSlot::Enqueued));

            let barrier = Arc::new(std::sync::Barrier::new(2));
            let finisher = {
                let t = t.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    let (_, next) = t.finish_and_pop("k", token);
                    next.map(|(turn, (), slot)| {
                        std::mem::forget(slot);
                        turn.message_id
                    })
                })
            };
            let sender = {
                let t = t.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    matches!(t.begin_or_enqueue("k", qt("b"), ()), SendSlot::Enqueued)
                })
            };
            let drained = finisher.join().unwrap();
            let enqueued = sender.join().unwrap();
            assert_eq!(drained.as_deref(), Some("a"), "the head must drain");
            assert!(enqueued, "the racing send must enqueue, never double-start");
            assert!(t.is_running("k"), "exactly one live turn");
            let queued = t.status("k").queued;
            assert_eq!(queued.len(), 1);
            assert_eq!(queued[0].message_id, "b");
        }
    }

    #[test]
    fn unqueue_removes_head_or_middle_and_misses_return_none() {
        let t = turns();
        let guard = t.begin("k").unwrap();
        for id in ["a", "b", "c"] {
            assert!(matches!(t.begin_or_enqueue("k", qt(id), ()), SendSlot::Enqueued));
        }
        // Middle.
        assert_eq!(t.unqueue("k", "b").expect("middle").text, "text of b");
        // Head.
        assert_eq!(t.unqueue("k", "a").expect("head").message_id, "a");
        // Already gone / never existed.
        assert!(t.unqueue("k", "a").is_none());
        assert!(t.unqueue("k", "nope").is_none());
        assert!(t.unqueue("other", "c").is_none());
        let queued = t.status("k").queued;
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].message_id, "c");
        drop(guard);
    }

    #[test]
    fn discard_drops_the_queue_and_take_keeps_it() {
        let t = turns();
        let guard = t.begin("k").unwrap();
        let token = guard.token();
        std::mem::forget(guard);
        assert!(matches!(t.begin_or_enqueue("k", qt("a"), ()), SendSlot::Enqueued));

        // A plain cancel keeps the queue (the reader's drain advances it)…
        assert!(t.take("k").is_some());
        assert_eq!(t.status("k").queued.len(), 1);
        // …and `begin` (the non-queueing consult path) can't jump into the
        // cancel→drain window ahead of it — its reap would never drain.
        assert!(t.begin("k").is_err(), "begin must not overtake a waiting queue");

        // A discard drops the queue too: the conversation is gone, and the
        // cancelled reader's drain must find nothing.
        t.discard("k");
        assert!(t.status("k").queued.is_empty());
        let (proc, next) = t.finish_and_pop("k", token);
        assert!(proc.is_none());
        assert!(next.is_none());
    }

    #[test]
    fn kill_all_drops_queues_too() {
        let t = turns();
        let guard = t.begin("k").unwrap();
        assert!(matches!(t.begin_or_enqueue("k", qt("a"), ()), SendSlot::Enqueued));
        std::mem::forget(guard);
        t.kill_all();
        assert!(!t.is_running("k"));
        assert!(t.status("k").queued.is_empty());
    }

    #[test]
    fn begin_race_has_exactly_one_winner() {
        let t = turns();
        let mut handles = Vec::new();
        let barrier = Arc::new(std::sync::Barrier::new(8));
        for _ in 0..8 {
            let t = t.clone();
            let barrier = barrier.clone();
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                // Keep winners' guards alive until every thread has raced.
                t.begin("k").ok()
            }));
        }
        let guards: Vec<_> = handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .collect();
        assert_eq!(
            guards.iter().flatten().count(),
            1,
            "exactly one begin must win the race"
        );
    }

    #[test]
    fn spawn_window_cancel_bounces_the_attach_and_kill_all_reaps() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let t = turns();

            // Cancel during the spawn window: the reservation is taken with
            // no child; the late attach gets its child back to kill.
            let guard = t.begin("k").unwrap();
            let reserved = t.take("k").expect("reservation is take-able");
            assert!(reserved.child.is_none(), "no child during the spawn window");
            let child = tokio::process::Command::new("sleep")
                .arg("30")
                .kill_on_drop(true)
                .spawn()
                .expect("spawn sleep");
            let mut bounced = guard
                .attach(child)
                .expect_err("attach after cancel must return the child");
            let _ = bounced.start_kill();
            assert!(!t.is_running("k"));

            // Normal attach path + kill_all.
            let guard = t.begin("k").unwrap();
            let child = tokio::process::Command::new("sleep")
                .arg("30")
                .kill_on_drop(true)
                .spawn()
                .expect("spawn sleep");
            guard.attach(child).expect("attach onto live reservation");
            assert!(t.is_running("k"));
            let live = t.status("k");
            assert!(live.streaming);
            t.kill_all();
            assert!(!t.is_running("k"));
            assert!(!t.status("k").streaming);
        });
    }
}
