// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! One terminal's output: the bounded replay ring, the coalescer, and the
//! ACK credit of its one attachment.
//!
//! This is `pty.rs`'s `Pump` with the threads taken out: the helper is one
//! `poll(2)` loop, so where the in-process pump parks a reader thread on a
//! condvar, an [`Outlet`] answers "may the master be read now?" ([`gate`])
//! and "when do I next need to wake?" ([`Outlet::deadline`]). Every byte
//! enters the ring exactly once, at read time; an attach discards pending
//! bytes the replay already covers and the replay goes out before any later
//! live byte, because both are produced by the same single thread.
//!
//! [`gate`]: Outlet::gate

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// Output waits at most this long to be coalesced into one frame (~one frame
/// at 120 Hz), so a `yes` firehose is ~120 frames a second, not thousands.
pub const COALESCE_WINDOW: Duration = Duration::from_millis(8);
/// The master is not read while an attachment holds more than this many
/// unacknowledged bytes: the kernel buffer fills and the child blocks.
pub const FLOW_HIGH_WATER: usize = 256 * 1024;
/// An attachment that stops acknowledging for this long is suspended: the
/// master is drained into the ring, and a late ACK resumes with only what it
/// missed.
pub const FLOW_STALL_TIMEOUT: Duration = Duration::from_secs(5);
/// The newest output a fresh view replays.
pub const REPLAY_CAPACITY: usize = 256 * 1024;

/// Who is watching: a client connection and the view's own id within it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attachment {
    pub client: u64,
    pub id: String,
}

/// Whether the master may be read now.
#[derive(Debug, PartialEq, Eq)]
pub enum Gate {
    /// Read. When a stall suspended the attachment just now, its pending
    /// output is handed back to be sent first.
    Open(Option<(Attachment, Vec<u8>)>),
    /// Don't read before this instant (the stall deadline) or an ACK.
    Parked(Instant),
}

pub struct Outlet {
    replay: VecDeque<u8>,
    pending: Vec<u8>,
    attached: Option<Attachment>,
    /// Includes pending as well as sent bytes, and the replay is charged
    /// when it is sent, as in-process.
    unacked: usize,
    last_ack: Instant,
    suspended: bool,
    /// Absolute stream offsets, so a late ACK resumes only output the view
    /// did not get during a suspension.
    total_read: u64,
    last_sent: u64,
    flush_at: Option<Instant>,
}

impl Outlet {
    pub fn new(now: Instant) -> Self {
        Self {
            replay: VecDeque::with_capacity(4096),
            pending: Vec::new(),
            attached: None,
            unacked: 0,
            last_ack: now,
            suspended: false,
            total_read: 0,
            last_sent: 0,
            flush_at: None,
        }
    }

    pub fn attachment(&self) -> Option<&Attachment> {
        self.attached.as_ref()
    }

    pub fn unacked(&self) -> usize {
        self.unacked
    }

    pub fn suspended(&self) -> bool {
        self.suspended
    }

    pub fn ring_len(&self) -> usize {
        self.replay.len()
    }

    pub fn total_read(&self) -> u64 {
        self.total_read
    }

    /// Bytes just read from the master.
    pub fn push(&mut self, bytes: &[u8], now: Instant) {
        self.total_read = self.total_read.saturating_add(bytes.len() as u64);
        if bytes.len() >= REPLAY_CAPACITY {
            self.replay.clear();
            self.replay.extend(&bytes[bytes.len() - REPLAY_CAPACITY..]);
        } else {
            let excess = (self.replay.len() + bytes.len()).saturating_sub(REPLAY_CAPACITY);
            self.replay.drain(..excess);
            self.replay.extend(bytes);
        }
        if self.attached.is_some() && !self.suspended {
            if self.unacked == 0 {
                // The first burst after an idle prompt gets a fresh grace
                // period: the last ACK may be minutes old.
                self.last_ack = now;
            }
            self.pending.extend_from_slice(bytes);
            self.unacked += bytes.len();
            if self.flush_at.is_none() {
                self.flush_at = Some(now + COALESCE_WINDOW);
            }
        }
    }

    /// A new view: it replaces any other, and its first frame is the whole
    /// ring (possibly empty), which the caller sends before anything else.
    pub fn attach(&mut self, attachment: Attachment, now: Instant) -> Vec<u8> {
        self.attached = Some(attachment);
        self.pending.clear();
        self.flush_at = None;
        let replay: Vec<u8> = self.replay.iter().copied().collect();
        self.unacked = replay.len();
        self.suspended = false;
        self.last_sent = self.total_read;
        self.last_ack = now;
        replay
    }

    fn clear(&mut self) {
        self.attached = None;
        self.pending.clear();
        self.flush_at = None;
        self.unacked = 0;
        self.suspended = false;
    }

    /// Only the current attachment can detach itself.
    pub fn detach(&mut self, attachment: &Attachment) -> bool {
        if self.attached.as_ref() == Some(attachment) {
            self.clear();
            true
        } else {
            false
        }
    }

    /// The client went away: whatever it was watching is unwatched.
    pub fn detach_client(&mut self, client: u64) -> bool {
        if self.attached.as_ref().is_some_and(|a| a.client == client) {
            self.clear();
            true
        } else {
            false
        }
    }

    /// Release credit. A late ACK on a suspended view returns what it missed.
    pub fn ack(&mut self, attachment: &Attachment, n: usize, now: Instant) -> Option<Vec<u8>> {
        if self.attached.as_ref() != Some(attachment) {
            return None;
        }
        if n > 0 && self.unacked > 0 {
            self.last_ack = now;
        }
        self.unacked = self.unacked.saturating_sub(n);
        if n > 0 && self.suspended && self.unacked <= FLOW_HIGH_WATER {
            return self.resume();
        }
        None
    }

    fn resume(&mut self) -> Option<Vec<u8>> {
        self.suspended = false;
        let missing = self.total_read.saturating_sub(self.last_sent);
        let retained = self.replay.len() as u64;
        let mut bytes = Vec::new();
        if missing > retained {
            // Stalled longer than the ring holds: a fresh terminal state plus
            // the retained tail, never an arbitrary suffix glued onto a
            // half-written escape sequence.
            bytes.extend_from_slice(b"\x1bc");
        }
        bytes.extend(self.replay.iter().skip(retained.saturating_sub(missing) as usize));
        if bytes.is_empty() {
            return None;
        }
        self.unacked += bytes.len();
        self.last_sent = self.total_read;
        Some(bytes)
    }

    /// The coalesced output, to be sent now.
    pub fn take_flush(&mut self) -> Option<Vec<u8>> {
        self.flush_at = None;
        if self.pending.is_empty() {
            return None;
        }
        self.last_sent = self.total_read;
        Some(std::mem::take(&mut self.pending))
    }

    pub fn flush_due(&self, now: Instant) -> bool {
        self.flush_at.is_some_and(|at| now >= at)
    }

    /// Whether the master may be read. Over the high-water mark it may not,
    /// until an ACK or the stall deadline, which suspends the view.
    pub fn gate(&mut self, now: Instant) -> Gate {
        if self.attached.is_some() && !self.suspended && self.unacked > FLOW_HIGH_WATER {
            let deadline = self.last_ack + FLOW_STALL_TIMEOUT;
            if now < deadline {
                return Gate::Parked(deadline);
            }
            let flushed = self.take_flush();
            self.suspended = true;
            let attached = self.attached.clone().expect("checked above");
            return Gate::Open(flushed.map(|bytes| (attached, bytes)));
        }
        Gate::Open(None)
    }

    /// The next instant this outlet needs the loop awake for, if any: the
    /// coalescing window closing, or a parked reader's stall deadline. With
    /// nothing pending and nobody over the mark there is none, so an idle
    /// terminal costs the loop no wakeups.
    pub fn deadline(&self) -> Option<Instant> {
        let parked = (self.attached.is_some() && !self.suspended && self.unacked > FLOW_HIGH_WATER)
            .then(|| self.last_ack + FLOW_STALL_TIMEOUT);
        match (self.flush_at, parked) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    /// The newest `max` bytes of the ring.
    pub fn tail(&self, max: usize) -> Vec<u8> {
        let skip = self.replay.len().saturating_sub(max);
        self.replay.iter().skip(skip).copied().collect()
    }

    /// The whole ring, for a tombstone.
    pub fn ring(&self) -> Vec<u8> {
        self.replay.iter().copied().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn att(id: &str) -> Attachment {
        Attachment { client: 1, id: id.into() }
    }

    #[test]
    fn every_attachment_starts_with_one_replay_frame_even_when_empty() {
        let t = Instant::now();
        let mut o = Outlet::new(t);
        assert_eq!(o.attach(att("first"), t), b"");
        o.push(b"live", t);
        assert_eq!(o.take_flush().unwrap(), b"live");
        assert_eq!(o.attach(att("second"), t), b"live");
        o.push(b"next", t);
        assert_eq!(o.take_flush().unwrap(), b"next");
    }

    #[test]
    fn the_ring_evicts_oldest_and_a_detached_terminal_keeps_only_the_tail() {
        let t = Instant::now();
        let mut o = Outlet::new(t);
        let bytes: Vec<u8> = (0..REPLAY_CAPACITY * 3).map(|i| (i % 251) as u8).collect();
        for chunk in bytes.chunks(8192) {
            assert_eq!(o.gate(t), Gate::Open(None), "detached: drains freely");
            o.push(chunk, t);
        }
        assert_eq!(o.ring_len(), REPLAY_CAPACITY);
        assert!(o.take_flush().is_none(), "no pending bytes without a view");
        assert_eq!(o.unacked(), 0);
        assert_eq!(o.attach(att("page"), t), bytes[bytes.len() - REPLAY_CAPACITY..]);
        assert_eq!(o.unacked(), REPLAY_CAPACITY, "the replay is charged");
        // One read larger than the ring keeps only its tail.
        let mut o = Outlet::new(t);
        o.push(&vec![b'x'; REPLAY_CAPACITY + 10], t);
        assert_eq!(o.ring_len(), REPLAY_CAPACITY);
        assert_eq!(o.total_read(), (REPLAY_CAPACITY + 10) as u64);
    }

    #[test]
    fn reattach_replays_unflushed_output_once_before_live_bytes() {
        let t = Instant::now();
        let mut o = Outlet::new(t);
        o.attach(att("old"), t);
        o.push(b"before-", t);
        let replay = o.attach(att("new"), t);
        assert_eq!(replay, b"before-");
        assert!(o.take_flush().is_none(), "pending bytes the replay covered are dropped");
        o.push(b"after", t);
        assert_eq!(o.take_flush().unwrap(), b"after");
    }

    #[test]
    fn stale_ack_and_detach_cannot_affect_the_new_attachment() {
        let t = Instant::now();
        let mut o = Outlet::new(t);
        o.attach(att("old"), t);
        o.push(b"history", t);
        o.attach(att("new"), t);
        assert!(o.ack(&att("old"), 1000, t).is_none());
        assert!(!o.detach(&att("old")));
        assert_eq!(o.unacked(), 7);
        assert!(o.attachment().is_some());
        o.ack(&att("new"), 7, t);
        assert_eq!(o.unacked(), 0);
        // Another client's attachment with the same id is not this one.
        assert!(!o.detach(&Attachment { client: 2, id: "new".into() }));
        assert!(o.detach(&att("new")));
        assert!(o.attachment().is_none());
    }

    #[test]
    fn credit_gates_at_the_high_water_mark_and_saturates_at_zero() {
        let t = Instant::now();
        let mut o = Outlet::new(t);
        o.attach(att("a"), t);
        o.push(&[0; 1000], t);
        o.ack(&att("a"), 400, t);
        assert_eq!(o.unacked(), 600);
        o.ack(&att("a"), 10_000, t);
        assert_eq!(o.unacked(), 0, "an over-ACK can't wrap");
        o.push(&vec![0; FLOW_HIGH_WATER / 2], t);
        assert_eq!(o.gate(t), Gate::Open(None), "below the mark the reader never parks");
        o.push(&vec![0; FLOW_HIGH_WATER], t);
        assert_eq!(o.gate(t), Gate::Parked(t + FLOW_STALL_TIMEOUT));
        assert_eq!(o.deadline(), Some(t + COALESCE_WINDOW), "the flush comes first");
        o.take_flush();
        assert_eq!(o.deadline(), Some(t + FLOW_STALL_TIMEOUT));
        o.ack(&att("a"), FLOW_HIGH_WATER, t);
        assert_eq!(o.gate(t), Gate::Open(None), "an ACK reopens the gate");
        assert_eq!(o.deadline(), None, "nothing pending, nobody parked: no wakeup");
    }

    #[test]
    fn a_missing_ack_suspends_after_the_stall_and_a_late_ack_resumes_only_missing_bytes() {
        let t = Instant::now();
        let mut o = Outlet::new(t);
        o.attach(att("lost-page"), t);
        for _ in 0..=FLOW_HIGH_WATER / 8192 {
            o.push(&[0; 8192], t);
        }
        let late = t + FLOW_STALL_TIMEOUT;
        let Gate::Open(Some((who, flushed))) = o.gate(late) else { panic!("the stall suspends and flushes") };
        assert_eq!(who, att("lost-page"));
        assert_eq!(flushed.len(), FLOW_HIGH_WATER + 8192);
        assert!(o.suspended());
        assert_eq!(o.gate(late), Gate::Open(None), "suspended: drains into the ring");
        o.push(b"late bytes", late);
        assert!(o.take_flush().is_none(), "nothing is sent while suspended");
        let resumed = o.ack(&att("lost-page"), FLOW_HIGH_WATER + 8192, late).unwrap();
        assert_eq!(resumed, b"late bytes");
        assert!(!o.suspended());
        o.push(b" live", late);
        assert_eq!(o.take_flush().unwrap(), b" live");
    }

    #[test]
    fn resume_after_ring_overflow_resets_and_replays_only_the_retained_tail() {
        let t = Instant::now();
        let mut o = Outlet::new(t);
        o.attach(att("slow"), t);
        o.push(b"old screen", t);
        assert_eq!(o.take_flush().unwrap(), b"old screen");
        o.push(&vec![0; FLOW_HIGH_WATER], t);
        let Gate::Open(Some(_)) = o.gate(t + FLOW_STALL_TIMEOUT) else { panic!() };
        o.push(&vec![b'x'; REPLAY_CAPACITY * 3], t);
        let resumed = o.ack(&att("slow"), FLOW_HIGH_WATER, t).unwrap();
        assert_eq!(&resumed[..2], b"\x1bc");
        assert_eq!(resumed.len(), 2 + REPLAY_CAPACITY);
        assert!(resumed[2..].iter().all(|b| *b == b'x'));
    }

    #[test]
    fn the_first_output_after_idle_gets_a_fresh_grace_period() {
        let t = Instant::now();
        let mut o = Outlet::new(t);
        o.attach(att("a"), t);
        let later = t + Duration::from_secs(60);
        o.push(&vec![0; FLOW_HIGH_WATER + 1], later);
        o.take_flush();
        assert_eq!(o.gate(later), Gate::Parked(later + FLOW_STALL_TIMEOUT));
    }

    #[test]
    fn a_client_going_away_unwatches_only_its_own_view() {
        let t = Instant::now();
        let mut o = Outlet::new(t);
        o.attach(Attachment { client: 7, id: "a".into() }, t);
        assert!(!o.detach_client(8));
        o.push(b"x", t);
        assert!(o.detach_client(7));
        assert!(o.take_flush().is_none());
        assert_eq!(o.unacked(), 0);
        assert_eq!(o.tail(10), b"x");
    }
}
