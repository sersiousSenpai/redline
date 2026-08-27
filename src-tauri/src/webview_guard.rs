// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Revive webviews whose WebKit content process dies underneath them.
//!
//! On macOS every webview's page lives in a separate `WebContent` process
//! that the OS kills freely — memory pressure is the classic trigger (it
//! took Redline's UI down on 2026-08-20 while several tab pools were live).
//! WKWebView does NOT recover on its own: the window stays up but renders a
//! dead blank view, which reads as "the app crashed" even though the Rust
//! side (daemon, PTYs, held reviews) is fine. The fix is the documented
//! one — reload the webview from `webViewWebContentProcessDidTerminate:`,
//! which respawns the content process — surfaced through Tauri's
//! `Builder::on_web_content_process_terminate` hook (macOS/iOS only).
//!
//! One guard: under *sustained* pressure a reload can die again instantly,
//! and reload-on-terminate alone would spin a crash loop that worsens the
//! very pressure that started it. Each webview label gets a small budget
//! (3 reloads per rolling minute); past it we leave the view down, log
//! loudly, and let the user relaunch — the single-instance handoff can
//! resurrect the window even if the process outlives it.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Reloads allowed per webview label within [`WINDOW`].
const MAX_RELOADS: usize = 3;
/// The rolling window the budget applies to.
const WINDOW: Duration = Duration::from_secs(60);

/// `Builder::on_web_content_process_terminate` callback: record the crash,
/// then reload the webview unless this label is crash-looping.
pub fn on_terminate(webview: &tauri::Webview) {
    let label = webview.label().to_string();
    crate::db::note_friction(
        "webview_crash",
        Some(&label),
        None,
        Some("WebContent process terminated (memory pressure or WebKit fault)"),
    );
    if !allow_reload(&label, Instant::now()) {
        tracing::error!(
            %label,
            "webview content process crash-looping (> {MAX_RELOADS} deaths/min); leaving it down"
        );
        return;
    }
    tracing::warn!(%label, "webview content process terminated — reloading");
    if let Err(e) = webview.reload() {
        tracing::error!(%label, error = %e, "reload after content process death failed");
    }
}

/// Spend one reload from `label`'s budget at `now`; `false` means the budget
/// for the rolling window is exhausted. Process-global so every webview —
/// main window and browser tabs alike — shares the same policy.
fn allow_reload(label: &str, now: Instant) -> bool {
    static RELOADS: Mutex<Option<HashMap<String, Vec<Instant>>>> = Mutex::new(None);
    let mut guard = RELOADS.lock().expect("webview reload budget lock");
    let map = guard.get_or_insert_with(HashMap::new);
    let times = map.entry(label.to_string()).or_default();
    times.retain(|t| now.duration_since(*t) < WINDOW);
    if times.len() >= MAX_RELOADS {
        return false;
    }
    times.push(now);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budget_allows_then_blocks_then_recovers() {
        let t0 = Instant::now();
        // Labels are independent; use a unique one — the budget map is
        // process-global and other tests may share the process.
        let label = format!("test-{}", uuid::Uuid::new_v4());
        for _ in 0..MAX_RELOADS {
            assert!(allow_reload(&label, t0), "within budget must pass");
        }
        assert!(!allow_reload(&label, t0), "budget exhausted must block");
        assert!(
            !allow_reload(&label, t0 + WINDOW - Duration::from_secs(1)),
            "still inside the rolling window"
        );
        assert!(
            allow_reload(&label, t0 + WINDOW + Duration::from_secs(1)),
            "window rolled over — budget recovers"
        );
    }

    #[test]
    fn budget_is_per_label() {
        let t0 = Instant::now();
        let a = format!("test-{}", uuid::Uuid::new_v4());
        let b = format!("test-{}", uuid::Uuid::new_v4());
        for _ in 0..MAX_RELOADS {
            assert!(allow_reload(&a, t0));
        }
        assert!(!allow_reload(&a, t0));
        assert!(allow_reload(&b, t0), "label b has its own budget");
    }
}
