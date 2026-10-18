// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Reduce Transparency / Increase Contrast, read from NSWorkspace. The glass
//! material is drawn in-app (the window itself stays opaque); either setting
//! turns every glass tier solid via `html[data-rl-transparency="reduced"]`.

#[tauri::command]
pub fn reduced_transparency() -> bool {
    #[cfg(target_os = "macos")]
    {
        let workspace = objc2_app_kit::NSWorkspace::sharedWorkspace();
        workspace.accessibilityDisplayShouldReduceTransparency()
            || workspace.accessibilityDisplayShouldIncreaseContrast()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Re-reads the two display options whenever System Settings changes either,
/// and tells the webview. The observer lives as long as the app, so its token
/// is parked on the main thread and never removed.
#[cfg(target_os = "macos")]
pub fn observe(app: tauri::AppHandle) {
    use objc2::{rc::Retained, runtime::ProtocolObject};
    use objc2_foundation::{NSNotification, NSObjectProtocol};
    use std::{cell::RefCell, ptr::NonNull};
    use tauri::Emitter;
    thread_local! {
        static TOKEN: RefCell<Option<Retained<ProtocolObject<dyn NSObjectProtocol>>>> =
            const { RefCell::new(None) };
    }
    let center = objc2_app_kit::NSWorkspace::sharedWorkspace().notificationCenter();
    let handler = block2::RcBlock::new(move |_: NonNull<NSNotification>| {
        let _ = app.emit("reduced-transparency-changed", reduced_transparency());
    });
    // The notification has no object filter; the block captures only a
    // thread-safe AppHandle and asks NSWorkspace for its current settings.
    let token = unsafe {
        center.addObserverForName_object_queue_usingBlock(
            Some(objc2_app_kit::NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification),
            None,
            None,
            &handler,
        )
    };
    TOKEN.with(|slot| *slot.borrow_mut() = Some(token));
}

#[cfg(not(target_os = "macos"))]
pub fn observe(_: tauri::AppHandle) {}
