// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! What the helper keeps of a terminal that exited on its own: its id, its
//! status and time, and its last screen (the ring), so a relaunched app can
//! say "exited while Redline was closed" and show what it last printed.
//!
//! Bounded three ways: at most [`MAX_TOMBS`], at most [`MAX_TOMB_BYTES`] of
//! rings between them, and none older than [`TOMB_TTL`]. The oldest goes
//! first. An app that sees an exit live forgets the tombstone at once
//! (`Reap`), so these accumulate only while nobody is watching.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

pub const MAX_TOMBS: usize = 16;
pub const MAX_TOMB_BYTES: usize = 4 * 1024 * 1024;
pub const TOMB_TTL: Duration = Duration::from_secs(24 * 3600);

/// Anything kept as a tombstone reports how much of the byte budget it uses.
pub trait Weighed {
    fn weight(&self) -> usize;
}

pub struct Tombs<T> {
    entries: VecDeque<(Instant, T)>,
    bytes: usize,
}

impl<T> Default for Tombs<T> {
    fn default() -> Self {
        Self { entries: VecDeque::new(), bytes: 0 }
    }
}

impl<T: Weighed> Tombs<T> {
    pub fn insert(&mut self, now: Instant, item: T) {
        self.bytes += item.weight();
        self.entries.push_back((now, item));
        while self.entries.len() > MAX_TOMBS || (self.bytes > MAX_TOMB_BYTES && self.entries.len() > 1) {
            self.pop_oldest();
        }
    }

    fn pop_oldest(&mut self) {
        if let Some((_, item)) = self.entries.pop_front() {
            self.bytes -= item.weight();
        }
    }

    /// Drop what is past its time; returns how many went.
    pub fn expire(&mut self, now: Instant) -> usize {
        let mut gone = 0;
        while self.entries.front().is_some_and(|(at, _)| now.duration_since(*at) >= TOMB_TTL) {
            self.pop_oldest();
            gone += 1;
        }
        gone
    }

    /// When the oldest one expires.
    pub fn next_expiry(&self) -> Option<Instant> {
        self.entries.front().map(|(at, _)| *at + TOMB_TTL)
    }

    pub fn remove_where(&mut self, mut pred: impl FnMut(&T) -> bool) -> Option<T> {
        let i = self.entries.iter().position(|(_, t)| pred(t))?;
        let (_, item) = self.entries.remove(i)?;
        self.bytes -= item.weight();
        Some(item)
    }

    pub fn iter(&self) -> impl Iterator<Item = &T> {
        self.entries.iter().map(|(_, t)| t)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }
}

/// When an empty helper may exit: no terminal, no tombstone and no client
/// since `idle_since`, for `sweep`. `None` while anything is there.
pub fn sweep_deadline(live: usize, clients: usize, tombs: usize, idle_since: Instant, sweep: Duration) -> Option<Instant> {
    (live == 0 && clients == 0 && tombs == 0).then(|| idle_since + sweep)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct T(u32, usize);
    impl Weighed for T {
        fn weight(&self) -> usize {
            self.1
        }
    }

    #[test]
    fn tombstones_are_bounded_by_count_bytes_and_age() {
        let t = Instant::now();
        let mut tombs = Tombs::default();
        for i in 0..20 {
            tombs.insert(t, T(i, 1000));
        }
        assert_eq!(tombs.len(), MAX_TOMBS);
        assert_eq!(tombs.iter().next().unwrap().0, 4, "the oldest went first");
        assert_eq!(tombs.bytes(), MAX_TOMBS * 1000);

        let mut tombs = Tombs::default();
        for i in 0..5 {
            tombs.insert(t, T(i, 1024 * 1024));
        }
        assert_eq!(tombs.len(), 4, "4 MB of rings at most");
        tombs.insert(t, T(9, MAX_TOMB_BYTES * 2));
        assert_eq!(tombs.len(), 1, "one oversized ring still keeps its own tombstone");

        let mut tombs = Tombs::default();
        tombs.insert(t, T(1, 10));
        tombs.insert(t + Duration::from_secs(3600), T(2, 10));
        assert_eq!(tombs.next_expiry(), Some(t + TOMB_TTL));
        assert_eq!(tombs.expire(t + TOMB_TTL - Duration::from_secs(1)), 0);
        assert_eq!(tombs.expire(t + TOMB_TTL), 1);
        assert_eq!(tombs.iter().next().unwrap().0, 2);
        assert!(tombs.remove_where(|x| x.0 == 2).is_some());
        assert!(tombs.is_empty() && tombs.bytes() == 0);
        assert!(tombs.remove_where(|x| x.0 == 2).is_none());
    }

    #[test]
    fn the_sweep_is_armed_only_when_the_helper_is_empty() {
        let t = Instant::now();
        let s = Duration::from_secs(600);
        assert_eq!(sweep_deadline(0, 0, 0, t, s), Some(t + s));
        assert_eq!(sweep_deadline(1, 0, 0, t, s), None, "a live terminal keeps it");
        assert_eq!(sweep_deadline(0, 1, 0, t, s), None, "a connected app keeps it");
        assert_eq!(sweep_deadline(0, 0, 1, t, s), None, "a tombstone keeps it, up to its 24 h");
    }
}
