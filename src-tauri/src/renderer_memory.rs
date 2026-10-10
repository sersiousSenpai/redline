// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The main webview's renderer footprint, read from outside the page
//! (docs/perf-budget.md rule 7, "Memory is bounded").
//!
//! WebKit runs the page in its own WebContent process, so this process's
//! memory says nothing about it, and WebKit has no `performance.memory`. A
//! watch thread asks the main WKWebView for its WebContent pid (the private
//! `_webProcessIdentifier`, probed with `respondsToSelector:` first, so a
//! WebKit without it reads as "unknown" rather than raising), and reading that
//! process's physical footprint is then one `proc_pid_rusage` call: the number
//! `footprint` and Activity Monitor's Memory column report.
//!
//! Two readers: `GET /v1/perf`, which `scripts/perf-idle.sh` prints, and the
//! watch itself, which logs one warning when the footprint crosses
//! [`WARN_BYTES`]. On 2026-10-09 the renderer had reached 4 GB after two days.
//!
//! Kept small on purpose (the release binary's size budget): a plain thread
//! rather than an async task, and a pid that lands in an atomic rather than an
//! answer anyone waits for. Waiting on a channel for it measured about 10 KB of
//! code on its own.

use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
#[cfg(target_os = "macos")]
use std::time::Duration;

use serde::Serialize;
use tauri::AppHandle;

/// Past this the renderer's footprint is logged as a warning, once per crossing.
pub const WARN_BYTES: u64 = 1536 * 1024 * 1024;
/// How often the watch re-finds the renderer (WebKit relaunches a crashed one
/// under a new pid) and checks its footprint.
#[cfg(target_os = "macos")]
const WATCH_EVERY: Duration = Duration::from_secs(60);

/// The main webview's WebContent pid as the watch last found it; 0 = unknown.
static PID: AtomicI32 = AtomicI32::new(0);
static OVER: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Footprint {
    pub pid: i32,
    pub footprint_bytes: u64,
}

/// The renderer's footprint now. `None` until the watch has found the
/// renderer, or when it can't be read (not macOS, the process gone). Only a
/// syscall, so an async handler can call it.
pub fn current() -> Option<Footprint> {
    let pid = PID.load(Ordering::Relaxed);
    if pid <= 0 {
        return None;
    }
    Some(Footprint { pid, footprint_bytes: phys_footprint(pid)? })
}

/// Whether a reading warrants the warning: the first one past [`WARN_BYTES`]
/// does; later ones above it don't, until a reading back under it (a reload,
/// or whatever held the memory letting go) re-arms the warning.
fn crossing(was_over: bool, bytes: u64) -> (bool, bool) {
    let over = bytes >= WARN_BYTES;
    (over, over && !was_over)
}

/// Log the warning if this reading crosses the ceiling.
pub fn note(reading: Footprint) {
    let (over, warn) = crossing(OVER.load(Ordering::Relaxed), reading.footprint_bytes);
    OVER.store(over, Ordering::Relaxed);
    if warn {
        tracing::warn!(
            pid = reading.pid,
            footprint_mb = reading.footprint_bytes / (1024 * 1024),
            "the main webview's renderer is past 1.5 GB; something in the page is holding memory (docs/perf-budget.md rule 7)"
        );
    }
}

/// Find the renderer now, then every minute for the life of the app re-find it
/// and check its footprint.
#[cfg(target_os = "macos")]
pub fn watch(app: AppHandle) {
    let _ = std::thread::Builder::new()
        .name("renderer-memory".into())
        .spawn(move || loop {
            find_renderer(&app);
            std::thread::sleep(WATCH_EVERY);
            if let Some(reading) = current() {
                note(reading);
            }
        });
}

#[cfg(not(target_os = "macos"))]
pub fn watch(_app: AppHandle) {}

/// Ask the main WKWebView for its WebContent pid. The answer lands in [`PID`]
/// from the main thread a moment later; nothing waits for it.
#[cfg(target_os = "macos")]
fn find_renderer(app: &AppHandle) {
    use objc2::runtime::AnyObject;
    use objc2::{msg_send, sel};
    use tauri::Manager;

    let Some(webview) = app.get_webview("main") else {
        // The window is gone and its renderer with it. Forget the pid: over
        // hours the system hands it to some other process, whose footprint
        // would read as the renderer's.
        PID.store(0, Ordering::Relaxed);
        return;
    };
    let _ = webview.with_webview(|pw| {
        // SAFETY: `with_webview` runs on the main thread; `inner()` is the live
        // WKWebView. The private selector is only sent once probed.
        let pid: i32 = unsafe {
            match (pw.inner() as *const AnyObject).as_ref() {
                Some(view) => {
                    let known: bool =
                        msg_send![view, respondsToSelector: sel!(_webProcessIdentifier)];
                    if known {
                        msg_send![view, _webProcessIdentifier]
                    } else {
                        0
                    }
                }
                None => 0,
            }
        };
        PID.store(pid, Ordering::Relaxed);
    });
}

/// A process's physical footprint. Reading another process's needs only the
/// same user, which WebContent is.
#[cfg(target_os = "macos")]
fn phys_footprint(pid: i32) -> Option<u64> {
    let mut info = std::mem::MaybeUninit::<libc::rusage_info_v2>::zeroed();
    // SAFETY: RUSAGE_INFO_V2 fills exactly one `rusage_info_v2`.
    let rc = unsafe { libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V2, info.as_mut_ptr().cast()) };
    // SAFETY: a zero return means the kernel filled the struct.
    (rc == 0).then(|| unsafe { info.assume_init() }.ri_phys_footprint)
}

#[cfg(not(target_os = "macos"))]
fn phys_footprint(_pid: i32) -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warns_once_per_crossing_and_rearms_below_the_ceiling() {
        let mut over = false;
        let mut warnings = 0;
        for bytes in [
            WARN_BYTES / 2,
            WARN_BYTES,     // crosses: warn
            WARN_BYTES * 2, // still over: quiet
            WARN_BYTES - 1, // back under: re-arm
            WARN_BYTES + 1, // crosses again: warn
        ] {
            let (now_over, warn) = crossing(over, bytes);
            over = now_over;
            warnings += warn as u32;
        }
        assert_eq!(warnings, 2);
        assert!(over);
    }

    /// The same syscall and struct the renderer readout uses, on this test's
    /// own pid, so a signature or layout slip fails here instead of reading
    /// as a silent `None` in the app.
    #[cfg(target_os = "macos")]
    #[test]
    fn reads_a_live_process_footprint_and_none_for_a_gone_one() {
        let own = phys_footprint(std::process::id() as i32).expect("own footprint");
        assert!(own > 1024 * 1024, "footprint {own}");
        assert_eq!(phys_footprint(i32::MAX), None);
    }
}
