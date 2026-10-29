// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Quitting, now that terminals can outlive the app (PTY helper plan §5).
//!
//! Two ways out, both native menu items (and both in the tray):
//!
//! * **Quit** (⌘Q): kept terminals keep running in the helper; terminals
//!   whose wall was closed with "Also after Redline quits" unchecked end.
//! * **Quit and Stop Terminals** (⌥⌘Q): every terminal ends.
//!
//! ⌘Q is our own item rather than the predefined one: AppKit's `terminate:`
//! can't be held while a dialog asks, and the first ⌘Q with terminals
//! running asks once ("3 terminals keep running after Redline quits"), and
//! always says when a plan is waiting for review. The page decides whether
//! there is anything to ask (it knows the terminals' names and the held
//! plans); it acknowledges at once, and a page that never answers (a crashed
//! webview) doesn't hold the quit hostage: without an acknowledgement in
//! [`ACK_WAIT`], Redline quits.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

/// The page's acknowledgement window.
const ACK_WAIT: Duration = Duration::from_millis(1500);

static STOP_ALL: AtomicBool = AtomicBool::new(false);
static ASKING: AtomicBool = AtomicBool::new(false);
static ACKED: AtomicU64 = AtomicU64::new(0);
static ASK_SEQ: AtomicU64 = AtomicU64::new(0);

/// Whether this exit ends every terminal (⌥⌘Q, or the page chose it).
pub fn stop_all() -> bool {
    STOP_ALL.load(Ordering::Acquire)
}

/// A quit from the menu, the tray or a window close.
pub fn request(app: &AppHandle, stop_terminals: bool) {
    if stop_terminals {
        STOP_ALL.store(true, Ordering::Release);
        app.exit(0);
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        app.exit(0);
        return;
    };
    if ASKING.swap(true, Ordering::AcqRel) {
        // Already asking: bring the dialog forward.
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let seq = ASK_SEQ.fetch_add(1, Ordering::AcqRel) + 1;
    let _ = window.show();
    let _ = window.set_focus();
    if window.emit("quit-requested", seq).is_err() {
        app.exit(0);
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(ACK_WAIT);
        if ACKED.load(Ordering::Acquire) < seq {
            tracing::warn!("the page did not answer a quit; quitting");
            app.exit(0);
        }
    });
}

/// The page heard the quit and is deciding (or asking).
#[tauri::command]
pub fn quit_ack(seq: u64) {
    ACKED.fetch_max(seq, Ordering::AcqRel);
}

/// The page's answer: quit, keeping or stopping the terminals.
#[tauri::command]
pub fn app_quit(app: AppHandle, stop_terminals: bool) {
    if stop_terminals {
        STOP_ALL.store(true, Ordering::Release);
    }
    app.exit(0);
}

/// The page's dialog was cancelled: the next ⌘Q asks again.
#[tauri::command]
pub fn quit_cancel() {
    ASKING.store(false, Ordering::Release);
}

/// A window close from the page (the red button): the same quit.
#[tauri::command]
pub fn request_quit(app: AppHandle, stop_terminals: Option<bool>) {
    // The page asks only for a close it intercepted; it is not asking yet.
    ASKING.store(false, Ordering::Release);
    request(&app, stop_terminals.unwrap_or(false));
}
