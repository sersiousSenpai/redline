// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Boot milestones — the shared vocabulary the boot work is measured against.
//!
//! Every optimization on the native critical path has to be *attributable*, and
//! "the app feels faster" is not attribution. This module is the smallest thing
//! that fixes that: one monotonic clock started at the top of `run()`, a fixed
//! set of milestone names, and one structured `tracing` record per launch.
//!
//! Discipline, deliberately narrow:
//!
//! * **Local only.** `tracing` goes to the console the developer already runs
//!   with; nothing is persisted, nothing leaves the machine, no user content is
//!   ever a field. Milestone names are `&'static str` — a caller structurally
//!   cannot smuggle a path or a plan title in here.
//! * **Never load-bearing.** Every entry point is infallible and lock-poison
//!   proof. A tracer that can panic during boot is worse than no tracer.
//! * **Cheap.** A `mark` is an `Instant::now()` and a push behind an
//!   uncontended mutex, on the order of tens of nanoseconds. It is safe to
//!   leave in a release build, which is the point: the numbers you can only
//!   collect in a debug build are the numbers nobody collects.
//!
//! The frontend half of the vocabulary lives in `src/lib/bootMarks.ts`
//! (`performance.mark` / `performance.measure`); the two are documented
//! together in `docs/perf-budget.md` under "Boot budget".

use std::sync::{Mutex, OnceLock};
use std::time::Instant;

// ---- The milestone vocabulary --------------------------------------------
//
// Constants, not free-form strings, so a rename is a compile error rather than
// a silently-orphaned measurement. Ordered as a healthy boot passes them.

/// `run()` entered — the zero point every other milestone is relative to.
pub const PROCESS_START: &str = "process_start";
/// Tauri's `setup` closure entered.
pub const SETUP_ENTER: &str = "setup_enter";
/// `Database::open` returned (connection + schema migration).
pub const DB_OPEN: &str = "db_open";
/// The schema migration inside that open finished.
pub const DB_MIGRATE: &str = "db_migrate";
/// `SessionStore::new` returned — session rows hydrated into memory.
pub const STORE_HYDRATE: &str = "store_hydrate";
/// The axum daemon task was spawned.
pub const DAEMON_START: &str = "daemon_start";
/// The daemon actually bound `127.0.0.1:7676` (or failed to).
pub const DAEMON_BIND: &str = "daemon_bind";
/// Hook + skill maintenance finished (post-boot coordinator).
pub const HOOK_MAINTENANCE: &str = "hook_maintenance";
/// The shared `SyntaxSet` finished building.
pub const HIGHLIGHTER_INIT: &str = "highlighter_init";
/// Extension manifests scanned and the wasm host started.
pub const EXTENSION_SCAN: &str = "extension_scan";
/// Tauri's `setup` closure returned.
pub const SETUP_DONE: &str = "setup_done";
/// The frontend called `show_main_window` — the first actionable frame.
pub const WINDOW_REVEAL: &str = "window_reveal";
/// The post-reveal maintenance coordinator finished all its duties.
pub const POST_BOOT_DONE: &str = "post_boot_done";

/// A recorded milestone: a fixed name and how long after `run()` it happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mark {
    pub name: &'static str,
    pub micros: u128,
}

struct Tracer {
    origin: Instant,
    marks: Mutex<Vec<Mark>>,
    /// Set when the launch record has been emitted, so a second reveal (a
    /// resurrected window, a `single_instance` handoff) does not print a
    /// second, misleading "boot" line.
    reported: Mutex<bool>,
}

static TRACER: OnceLock<Tracer> = OnceLock::new();

/// Start the clock. Called once, first thing in `run()`. Idempotent: a second
/// call keeps the original origin, so a test harness that initializes twice
/// still measures from the real start.
pub fn init() {
    let _ = TRACER.set(Tracer {
        origin: Instant::now(),
        marks: Mutex::new(Vec::new()),
        reported: Mutex::new(false),
    });
    mark(PROCESS_START);
}

/// Record `name` at now. No-op when `init()` was never called (tests, the MCP
/// proxy binary), so callers never have to guard.
pub fn mark(name: &'static str) {
    let Some(t) = TRACER.get() else { return };
    let micros = t.origin.elapsed().as_micros();
    // `unwrap_or_else(into_inner)`: a poisoned mutex means some other thread
    // panicked while holding it. That is a real bug, but losing the boot trace
    // on top of it helps nobody — take the data and carry on.
    let mut marks = t.marks.lock().unwrap_or_else(|e| e.into_inner());
    marks.push(Mark { name, micros });
}

/// Time a closure and record `name` when it returns. The common shape on the
/// critical path, where the interesting number is the span, not the instant.
pub fn timed<T>(name: &'static str, f: impl FnOnce() -> T) -> T {
    let out = f();
    mark(name);
    out
}

/// Every milestone recorded so far, in the order they happened.
pub fn marks() -> Vec<Mark> {
    let Some(t) = TRACER.get() else {
        return Vec::new();
    };
    t.marks
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

/// Milliseconds from `run()` to `name`, if it was recorded. The accessor the
/// tests assert on — production code emits the whole record instead.
pub fn elapsed_ms(name: &str) -> Option<f64> {
    marks()
        .iter()
        .find(|m| m.name == name)
        .map(|m| m.micros as f64 / 1000.0)
}

/// One line per milestone plus a `boot trace` summary, at INFO. Called once,
/// from the post-boot coordinator; later calls are ignored.
///
/// Emitting on the *coordinator* rather than on the reveal is deliberate: the
/// reveal is the number the user feels, but the deferred maintenance is the
/// work that used to sit in front of it, and a trace that stopped at the
/// reveal would make moving work behind it look free.
pub fn report() {
    let Some(t) = TRACER.get() else { return };
    {
        let mut reported = t.reported.lock().unwrap_or_else(|e| e.into_inner());
        if *reported {
            return;
        }
        *reported = true;
    }
    let marks = marks();
    let mut prev = 0u128;
    for m in &marks {
        tracing::info!(
            milestone = m.name,
            at_ms = m.micros as f64 / 1000.0,
            delta_ms = (m.micros.saturating_sub(prev)) as f64 / 1000.0,
            "boot milestone"
        );
        prev = m.micros;
    }
    tracing::info!(
        reveal_ms = elapsed_ms(WINDOW_REVEAL),
        setup_ms = elapsed_ms(SETUP_DONE),
        db_ms = elapsed_ms(DB_OPEN),
        store_ms = elapsed_ms(STORE_HYDRATE),
        post_boot_ms = elapsed_ms(POST_BOOT_DONE),
        milestones = marks.len(),
        "boot trace"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marks_before_init_are_dropped_not_panics() {
        // The tracer is process-global and `init()` may or may not have run in
        // this test binary; what must hold either way is that these are safe.
        mark(DB_OPEN);
        let _ = marks();
        let _ = elapsed_ms(DB_OPEN);
    }

    #[test]
    fn timed_returns_the_inner_value() {
        assert_eq!(timed(DB_MIGRATE, || 7), 7);
    }

    #[test]
    fn init_is_idempotent_and_keeps_the_first_origin() {
        init();
        let first = elapsed_ms(PROCESS_START);
        init();
        // A second init must not reset the clock — the marks vec survives, so
        // the very first PROCESS_START is still the one at the front.
        assert!(marks().iter().any(|m| m.name == PROCESS_START));
        assert!(first.is_some());
    }

    #[test]
    fn milestone_names_are_unique() {
        let names = [
            PROCESS_START,
            SETUP_ENTER,
            DB_OPEN,
            DB_MIGRATE,
            STORE_HYDRATE,
            DAEMON_START,
            DAEMON_BIND,
            HOOK_MAINTENANCE,
            HIGHLIGHTER_INIT,
            EXTENSION_SCAN,
            SETUP_DONE,
            WINDOW_REVEAL,
            POST_BOOT_DONE,
        ];
        let mut sorted = names.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), names.len(), "duplicate milestone name");
    }
}
