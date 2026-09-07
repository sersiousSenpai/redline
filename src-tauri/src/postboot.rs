// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Maintenance that happens *after* the first actionable frame.
//!
//! Tauri's `setup` closure runs before the window exists, and everything in it
//! is time the user spends looking at nothing. It had accumulated a set of
//! duties that all share one property: **nobody is waiting for them.**
//!
//! * a `VACUUM INTO` snapshot of the whole database, synchronously;
//! * bringing an old install's hook timeout up to date;
//! * backfilling the restore-curl permission;
//! * installing the prompt-capture hook beside the plan hook;
//! * building syntect's grammar set, on the chance a file gets opened.
//!
//! None of that decides what renders. All of it is now here, triggered once
//! per process by the frontend's `show_main_window` call — the reveal.
//!
//! **The launch boundary is what keeps this honest.** "Later" is only safe if
//! something that *does* depend on the maintenance waits for it, so
//! `preflight_status` awaits [`ready`] before it probes. A launch goes through
//! preflight, so a launch transitively waits — and a launch is the one thing
//! that would actually be broken by a hook file that has not been repaired
//! yet. Everything else genuinely does not care.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::boot_trace;
use crate::state::SessionStore;

/// The coordinator has been triggered. Read by [`ready`] so a caller in a
/// context where it never runs (tests, the MCP proxy) returns immediately
/// instead of waiting for something that will never happen.
static STARTED: AtomicBool = AtomicBool::new(false);
/// Every duty below has finished (or failed and logged).
static DONE: AtomicBool = AtomicBool::new(false);

fn gate() -> &'static tokio::sync::Notify {
    static GATE: OnceLock<tokio::sync::Notify> = OnceLock::new();
    GATE.get_or_init(tokio::sync::Notify::new)
}

/// How long a launch will wait for post-boot maintenance before proceeding
/// anyway. A wedged repair must not strand a launch — the failure it would
/// cause is worse than the one it is guarding against.
const READY_TIMEOUT: Duration = Duration::from_secs(10);

/// Wait until post-boot maintenance has finished. Returns immediately if it
/// already has, or if it was never started.
///
/// Called by `preflight_status`, which is what makes deferring the repairs
/// safe: a launch cannot outrun the hook file being fixed, because a launch
/// runs a preflight and a preflight waits here.
pub async fn ready() {
    if DONE.load(Ordering::SeqCst) || !STARTED.load(Ordering::SeqCst) {
        return;
    }
    // The future is created BEFORE the second check, so a `notify_waiters`
    // landing between them is not a lost wakeup.
    let waiting = gate().notified();
    if DONE.load(Ordering::SeqCst) {
        return;
    }
    if tokio::time::timeout(READY_TIMEOUT, waiting).await.is_err() {
        tracing::warn!(
            "post-boot maintenance still running after {}s; proceeding without it",
            READY_TIMEOUT.as_secs()
        );
    }
}

/// Run the post-reveal duties, once per process.
///
/// Called from `show_main_window`. Idempotent and cheap to call again: the
/// frontend reveals once, but a resurrected window calls it a second time and
/// must not re-snapshot the database.
pub fn run(app: AppHandle) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    // The async runtime, not a std thread: `keeper` and the daemon already own
    // it, and the blocking parts below say so explicitly.
    tauri::async_runtime::spawn(async move {
        // Syntax grammars. First because it is pure CPU with no ordering
        // relationship to anything else, so it can start while the file I/O
        // below goes on. A file opened before this finishes initializes the
        // same `OnceLock` and blocks on it — never a second set.
        let highlighter = app
            .try_state::<std::sync::Arc<crate::highlight::Highlighter>>()
            .map(|s| s.inner().clone());
        let warm = tokio::task::spawn_blocking(move || {
            crate::highlight::Highlighter::warm_syntaxes();
            // Pre-compile the hot grammars' regexes too. syntect compiles each
            // pattern the first time it meets the construct, so building the
            // set is only half the cost the first real file open would pay.
            if let Some(hl) = highlighter {
                hl.warm_common();
            }
            boot_trace::mark(boot_trace::HIGHLIGHTER_INIT);
        });

        // Hook + skill repairs. All three read and rewrite JSON under
        // `~/.claude`, and all three used to run synchronously in `setup`.
        let repairs = tokio::task::spawn_blocking(|| {
            // Silently bring an existing install's hook timeout up to date, so
            // a user who installed under the old 10-minute timeout gets the
            // long hold without re-running setup. No-op if not installed /
            // current.
            crate::hook::ensure_timeout_current();

            // Backfill the restore-curl permission for installs that predate
            // it, so "Restore plan session" runs its daemon fetch hands-free
            // instead of stalling on an approval prompt. No-op if not
            // installed / present.
            crate::hook::ensure_restore_permission();

            // Install the Polis prompt-capture hook beside the ExitPlanMode
            // hook for anyone who has already set Redline up. It travels with
            // the main hook: capturing your prompts is core to the ledger.
            // External-session storage is separately gated by
            // `redline.capture.externalSessions`.
            //
            // Refreshed, not just installed: the command itself carries
            // contract (the agent seat, and now the restore metadata the
            // hidden restore protocol travels on). An install from an older
            // build looks perfectly healthy to `capture_installed` while
            // silently delivering none of it, so the check is "is it the
            // command we'd write today", and `install_capture` rewrites in
            // place when it isn't.
            if crate::hook::get_status().installed
                && !(crate::hook::capture_installed() && crate::hook::capture_current())
            {
                match crate::hook::install_capture() {
                    Ok(_) => tracing::info!("installed/refreshed Polis prompt-capture hook"),
                    Err(e) => {
                        tracing::warn!(error = %e, "failed to install prompt-capture hook")
                    }
                }
            }
            boot_trace::mark(boot_trace::HOOK_MAINTENANCE);
        });

        // The once-per-boot crown-jewels snapshot. Last, and deliberately not
        // raced with the repairs: `VACUUM INTO` walks the entire database, and
        // doing it concurrently with the hook I/O just makes both slower on a
        // machine with one disk.
        let _ = repairs.await;
        if let (Some(store), Ok(dir)) = (
            app.try_state::<SessionStore>().map(|s| s.database()),
            app.path().app_data_dir(),
        ) {
            tokio::task::spawn_blocking(move || {
                snapshot_once_per_boot(&store, dir);
            })
            .await
            .ok();
        }
        let _ = warm.await;

        DONE.store(true, Ordering::SeqCst);
        gate().notify_waiters();
        boot_trace::mark(boot_trace::POST_BOOT_DONE);
        boot_trace::report();
    });
}

/// The startup snapshot, and only the startup one — the six-hour cadence and
/// the quit snapshot keep their own call sites.
fn snapshot_once_per_boot(db: &std::sync::Arc<crate::db::Database>, dir: PathBuf) {
    crate::snapshot_database(db, &dir, crate::LEDGER_BACKUP_KEEP);
}

/// Serializes every `VACUUM INTO`.
///
/// There are three snapshot triggers — once per boot (here), every six hours
/// (the keeper's `ledger-backup` watch), and on quit — and moving the startup
/// one off the setup thread is exactly what makes them able to collide: a
/// launch-time snapshot now runs concurrently with whatever else the app is
/// doing, and a user who quits during one would have two full-database vacuums
/// writing at once. They each still happen; they just take turns.
pub fn snapshot_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_returns_immediately_when_the_coordinator_never_ran() {
        // Tests and the MCP proxy never reveal a window. Waiting for a
        // coordinator that will never run would hang every one of them.
        assert!(!STARTED.load(Ordering::SeqCst));
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        rt.block_on(async {
            tokio::time::timeout(Duration::from_millis(50), ready())
                .await
                .expect("ready() must not wait when nothing was started");
        });
    }

    #[test]
    fn the_snapshot_lock_is_one_shared_lock() {
        // Two calls must hand back the same mutex, or "serialized" means
        // nothing.
        let a = snapshot_lock() as *const _;
        let b = snapshot_lock() as *const _;
        assert_eq!(a, b);
    }

    #[test]
    fn snapshots_never_overlap() {
        // Three triggers — once per boot, every six hours, on quit — and since
        // the startup one moved behind the reveal they can genuinely collide.
        // Two `VACUUM INTO` runs writing at once is the failure; taking turns
        // is the contract. Simulated with the same lock the real
        // `snapshot_database` takes, and a counter that would exceed 1 the
        // instant two got inside together.
        use std::sync::atomic::AtomicUsize;
        let inside = std::sync::Arc::new(AtomicUsize::new(0));
        let peak = std::sync::Arc::new(AtomicUsize::new(0));
        std::thread::scope(|scope| {
            for _ in 0..6 {
                let inside = inside.clone();
                let peak = peak.clone();
                scope.spawn(move || {
                    let _serialized = snapshot_lock()
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    let now = inside.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    // Long enough that the other five certainly try while this
                    // one holds the lock.
                    std::thread::sleep(Duration::from_millis(20));
                    inside.fetch_sub(1, Ordering::SeqCst);
                });
            }
        });
        assert_eq!(
            peak.load(Ordering::SeqCst),
            1,
            "two VACUUM INTO runs were in flight at once"
        );
        assert_eq!(inside.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn snapshot_database_actually_takes_the_lock() {
        // The test above proves the lock works; this proves the production
        // path uses it. A source invariant, because the alternative is
        // constructing two real databases and racing their vacuums.
        let src = include_str!("lib.rs");
        let at = src
            .find("fn snapshot_database(")
            .expect("snapshot_database moved");
        let body = &src[at..at + 900];
        assert!(
            body.contains("postboot::snapshot_lock()"),
            "snapshot_database no longer serializes"
        );
    }

    #[test]
    fn the_ready_timeout_is_bounded_and_generous() {
        // Bounded: a wedged repair must not strand a launch. Generous: a slow
        // disk mid-repair must not make the guard useless.
        assert!(READY_TIMEOUT >= Duration::from_secs(5));
        assert!(READY_TIMEOUT <= Duration::from_secs(30));
    }
}
