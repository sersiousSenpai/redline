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
//! handle and the gardener in A5; the ingest observer added with the capture
//! route in A6. Pure trait definitions, no I/O.

use crate::api::ThreadMessage;
use crate::ledger::Origin;

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
    /// Pictures the host took of its OWN surfaces, keyed by the ledger seq
    /// they record — the Timeline joins them onto its rows. A host with no
    /// pictures answers nothing.
    fn surface_shot_keys(&self, seqs: &[i64]) -> Vec<(i64, String)> {
        let _ = seqs;
        Vec::new()
    }
    /// The tail `limit` turns of a conversation thread the host owns
    /// (`/v1/context/threads/:kind/:id`), oldest first — the message tables
    /// are the host's. `None` for a kind the host has no table for; a host
    /// with no threads answers `None` for every kind.
    fn thread_messages(&self, kind: &str, id: &str, limit: i64) -> Option<Vec<ThreadMessage>> {
        let _ = (kind, id, limit);
        None
    }
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

// ---------------------------------------------------------------------------
// The capture route's observer
// ---------------------------------------------------------------------------

/// The capture POST's headers, as the observer reads them — a name lookup, so
/// this crate names no HTTP type. `polis-server` wraps its header map in one
/// of these; a host reading its own headers (a restore trigger, an agent-seat
/// label) never sees the transport.
pub trait IngestHeaders {
    /// The header's value, trimmed; `None` when absent.
    fn get(&self, name: &str) -> Option<&str>;
}

/// Everything the capture route knows about one hook fire, handed to every
/// observer method so the host can act on the same facts the route did.
pub struct IngestContext<'a> {
    /// The hook's whole JSON payload (`{session_id, cwd, prompt, transcript_path, …}`).
    pub payload: &'a serde_json::Value,
    /// The submitted text, trimmed.
    pub prompt: &'a str,
    pub headers: &'a dyn IngestHeaders,
    /// The harness session id the payload carried, when non-empty.
    pub session_id: Option<&'a str>,
    /// The session's working directory, when present.
    pub cwd: Option<&'a str>,
    /// The spawning agent seat the host's [`IngestObserver::agent_seat`]
    /// read off the headers, when any.
    pub agent_seat: Option<&'a str>,
}

/// What a host does around a capture: everything in the route that is not
/// "record this prompt". Every method has a do-nothing default so a
/// standalone install implements none of them; Redline implements them all
/// (its restore-trigger answer, its launch and orchestration handoffs, its
/// agent-seat header, its project registry, its capture setting, its
/// transcript backfill).
///
/// The route calls them in this order, and the order is part of the contract:
/// `intercept` → `agent_seat` → the consume-once agent-prompt guard and
/// `seat_suppresses` → (`on_agent_prompt_skipped` and return) →
/// `classify_origin` → `capture_external` → record → `on_recorded`.
pub trait IngestObserver: Send + Sync {
    /// Answer this fire INSTEAD of recording it (Redline: the restore trigger,
    /// answered with the hidden protocol). The value is the route's whole
    /// response body; `None` means "an ordinary capture, carry on".
    fn intercept(&self, cx: &IngestContext<'_>) -> Option<serde_json::Value> {
        let _ = cx;
        None
    }
    /// The spawning agent seat, if the host labels its own spawns' hook fires
    /// (Redline: the `X-Redline-Agent` header). A non-empty seat is machine
    /// text unless [`Self::seat_suppresses`] says otherwise.
    fn agent_seat(&self, headers: &dyn IngestHeaders) -> Option<String> {
        let _ = headers;
        None
    }
    /// Whether a fire labelled with this seat is machine text to skip. The
    /// default says every seat is; a host can exempt one (Redline exempts its
    /// restore seat, whose variable outlives its one prompt).
    fn seat_suppresses(&self, seat: &str) -> bool {
        let _ = seat;
        true
    }
    /// The fire was one of the host's own constructed prompts (claimed by the
    /// guard or labelled by a seat) and was NOT recorded. The host's handoffs
    /// hang off this — the first moment a spawned session's id is known.
    fn on_agent_prompt_skipped(&self, cx: &IngestContext<'_>, body_hash: &str) {
        let _ = (cx, body_hash);
    }
    /// Which origin a session in `cwd` has. The default is everything is
    /// external; Redline answers `Redline` for a directory it tracks.
    fn classify_origin(&self, cwd: Option<&str>) -> Origin {
        let _ = cwd;
        Origin::External
    }
    /// Whether external sessions are captured at all (a host setting).
    fn capture_external(&self) -> bool {
        true
    }
    /// The capture path finished: `seq` is the recorded row, or `None` for a
    /// dedup or a store error (the route already answered fail-open). Redline
    /// stamps the session's model from its transcript here.
    fn on_recorded(&self, cx: &IngestContext<'_>, seq: Option<i64>) {
        let _ = (cx, seq);
    }
}

/// The observer that observes nothing — a standalone install's, and every
/// test's that needs one.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoIngestObserver;

impl IngestObserver for NoIngestObserver {}

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
        assert_eq!(host.thread_messages("browse", "t1", 10), None, "no threads to read");
        let clock: &dyn Clock = &SystemClock;
        assert!(clock.now_ms() > 1_700_000_000_000);
    }

    struct NoHeaders;
    impl IngestHeaders for NoHeaders {
        fn get(&self, _name: &str) -> Option<&str> {
            None
        }
    }

    /// The default observer records everything and answers nothing: every
    /// fire is an ordinary external capture, captured, with no seat.
    #[test]
    fn the_null_observer_lets_every_capture_through() {
        let obs: &dyn IngestObserver = &NoIngestObserver;
        let payload = serde_json::json!({ "prompt": "hi" });
        let cx = IngestContext {
            payload: &payload,
            prompt: "hi",
            headers: &NoHeaders,
            session_id: None,
            cwd: Some("/anywhere"),
            agent_seat: None,
        };
        assert_eq!(obs.intercept(&cx), None);
        assert_eq!(obs.agent_seat(&NoHeaders), None);
        assert!(obs.seat_suppresses("classifier"), "a seat is machine text by default");
        assert_eq!(obs.classify_origin(Some("/anywhere")), Origin::External);
        assert!(obs.capture_external());
        obs.on_agent_prompt_skipped(&cx, "deadbeef");
        obs.on_recorded(&cx, Some(1));
    }
}
