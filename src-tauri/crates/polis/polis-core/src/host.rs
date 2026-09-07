// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The host traits — what Polis asks of whatever embeds it.
//!
//! Polis never depends on its host. Where the memory system needs something
//! only the host knows (a plan revision's markdown, whether the user is idle,
//! how to tell the UI the catalog changed), it asks through one of these
//! traits, and the host implements them (Redline: `polis_host.rs`). A
//! standalone `polis` binary implements them trivially — no threads to label,
//! never idle-gated, events to nobody.
//!
//! Defined in Session A4 of the Polis extraction; consumed by the `Polis`
//! handle and the gardener in A5. Pure trait definitions, no I/O.

/// Cross-table reads the memory core cannot do itself because the tables are
/// the host's. Every method is `Option`: a host that has no such thing answers
/// `None`, and the core renders "unknown" rather than guessing.
pub trait HostResolver: Send + Sync {
    /// A human label for a thread the lake references by `(kind, id)` — the
    /// tab's title for a browse thread, the mission's goal, the draft's name.
    fn label(&self, kind: &str, id: &str) -> Option<String>;
    /// `(message count, last activity ms)` for a thread, for the map's mass
    /// and the timeline's recency.
    fn thread_stats(&self, kind: &str, id: &str) -> Option<(i64, Option<i64>)>;
    /// The project roots the host knows — the catalog seeds one class root
    /// per repo, and the ingest classifies a prompt's origin by its cwd.
    fn project_roots(&self) -> Vec<String>;
    /// A plan revision's markdown, for a bundle/mirror that snapshots bodies.
    fn revision_markdown(&self, session: &str, version: i64) -> Option<String>;
    /// The revision's title, as the host derives it.
    fn revision_title(&self, session: &str, version: i64) -> Option<String>;
    /// `in_review | approved | aborted` for a plan session, or `None` when the
    /// host has no such session.
    fn session_status(&self, session: &str) -> Option<String>;
    /// The evidence behind a decision event — the comment text, the
    /// annotation, the revision digest — rendered for a prompt or a pack.
    fn decision_evidence(&self, seq: i64) -> Option<String>;
}

/// When the user was last active, so the gardener runs in the gaps. A host
/// with no notion of activity returns 0 and the gardener treats the machine
/// as always idle.
pub trait IdleSignal: Send + Sync {
    fn last_activity_ms(&self) -> i64;
}

/// Wall-clock milliseconds. A trait so the gardener's cadence is testable
/// with a fake clock.
pub trait Clock: Send + Sync {
    fn now_ms(&self) -> i64;
}

/// What a gardener pass changed — the host turns these into UI events.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Change {
    /// Anything a memory surface renders (stats, timeline).
    Memory,
    /// The class catalog (nodes, links, observations).
    Catalog,
    /// The hash chain grew.
    Ledger,
    /// The semantic index moved.
    Embeddings,
}

/// The host's event bus, from the gardener's side.
pub trait GardenerEvents: Send + Sync {
    fn changed(&self, what: &[Change]);
}

/// The trivial host: no threads, no revisions, never busy, events to nobody.
/// What the standalone `polis` binary and every test that needs a host use.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoHost;

impl HostResolver for NoHost {
    fn label(&self, _kind: &str, _id: &str) -> Option<String> {
        None
    }
    fn thread_stats(&self, _kind: &str, _id: &str) -> Option<(i64, Option<i64>)> {
        None
    }
    fn project_roots(&self) -> Vec<String> {
        Vec::new()
    }
    fn revision_markdown(&self, _session: &str, _version: i64) -> Option<String> {
        None
    }
    fn revision_title(&self, _session: &str, _version: i64) -> Option<String> {
        None
    }
    fn session_status(&self, _session: &str) -> Option<String> {
        None
    }
    fn decision_evidence(&self, _seq: i64) -> Option<String> {
        None
    }
}

impl IdleSignal for NoHost {
    fn last_activity_ms(&self) -> i64 {
        0
    }
}

impl GardenerEvents for NoHost {
    fn changed(&self, _what: &[Change]) {}
}

/// The system clock.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        crate::ledger::now_millis()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_traits_are_object_safe_and_the_null_host_answers_nothing() {
        let host: Box<dyn HostResolver> = Box::new(NoHost);
        assert_eq!(host.label("browser", "t1"), None);
        assert!(host.project_roots().is_empty());
        let idle: &dyn IdleSignal = &NoHost;
        assert_eq!(idle.last_activity_ms(), 0, "never busy");
        let events: &dyn GardenerEvents = &NoHost;
        events.changed(&[Change::Catalog, Change::Ledger]);
        let clock: &dyn Clock = &SystemClock;
        assert!(clock.now_ms() > 1_700_000_000_000);
    }
}
