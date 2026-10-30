// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Where a browser tab's native webview sits inside the main window, and when
//! that place has to be re-checked.
//!
//! The pane hands us a rect in CSS pixels measured from the top-left of the
//! window's content, which are logical points (the same at 1x and 2x). AppKit
//! frames are bottom-up: a child of the window's (non-flipped) content view
//! stores its distance from the BOTTOM edge. Left to itself, AppKit keeps
//! that distance when the content view's height changes, so every taller or
//! shorter window (entering or leaving full screen above all) slides the page
//! down or up under a DOM that never moved. Pinning the top edge
//! (`NSViewMinYMargin`: the bottom margin absorbs the change) keeps the page
//! where the pane put it until the pane measures again.

/// `NSViewMinYMargin`: the bottom margin is flexible, so the top edge holds.
pub(crate) const PIN_TOP: usize = 8;
const HEIGHT_SIZABLE: usize = 16;
#[cfg(test)]
const MAX_Y_MARGIN: usize = 32;
/// `NSViewWidthSizable | NSViewMaxXMargin | NSViewHeightSizable`: grow with
/// the window and split the width change with the space to the right.
pub(crate) const FOLLOW_WINDOW: usize = 2 | 4 | HEIGHT_SIZABLE;

/// The autoresizing mask a tab's webview gets: either way its top edge stays
/// a fixed distance below the top of the window.
pub(crate) fn autoresize_mask(follow_window: bool) -> usize {
    if follow_window { FOLLOW_WINDOW } else { PIN_TOP }
}

// The conversion below is wry's (`set_bounds` / `bounds`) and AppKit's
// (autoresizing), modelled so the tests can hold the mask to its promise.

/// A rect in logical points, measured top-down from the content view's origin.
#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct TopDownRect { pub x: f64, pub y: f64, pub w: f64, pub h: f64 }

/// The AppKit frame origin's y for a top-down rect inside a superview of
/// `parent_height` points (what wry's `set_bounds` computes).
#[cfg(test)]
pub(crate) fn appkit_origin_y(parent_height: f64, flipped: bool, rect: TopDownRect) -> f64 {
    if flipped { rect.y } else { parent_height - rect.y - rect.h }
}

/// The top-down y of an AppKit frame (what wry's `bounds` reports, and what a
/// size-only update writes back as the position).
#[cfg(test)]
pub(crate) fn top_down_y(parent_height: f64, flipped: bool, origin_y: f64, height: f64) -> f64 {
    if flipped { origin_y } else { parent_height - origin_y - height }
}

/// AppKit's vertical autoresizing of a child of a non-flipped superview whose
/// height goes from `old_parent` to `new_parent`: the change is shared by the
/// flexible parts (bottom margin, height, top margin) in proportion to their
/// sizes. Returns the new `(origin_y, height)`.
#[cfg(test)]
pub(crate) fn autoresize_vertical(mask: usize, origin_y: f64, height: f64, old_parent: f64, new_parent: f64) -> (f64, f64) {
    let delta = new_parent - old_parent;
    let top_margin = old_parent - origin_y - height;
    let parts = [(mask & PIN_TOP != 0, origin_y), (mask & HEIGHT_SIZABLE != 0, height), (mask & MAX_Y_MARGIN != 0, top_margin)];
    let flexible: Vec<f64> = parts.iter().filter(|(flex, _)| *flex).map(|(_, size)| *size).collect();
    if flexible.is_empty() || delta == 0.0 { return (origin_y, height); }
    let total: f64 = flexible.iter().sum();
    let share = |flex: bool, size: f64| match (flex, total > 0.0) {
        (false, _) => 0.0,
        (true, true) => delta * size / total,
        (true, false) => delta / flexible.len() as f64,
    };
    (origin_y + share(parts[0].0, parts[0].1), height + share(parts[1].0, parts[1].1))
}

/// The native moments after which a tab's frame must be re-applied from a
/// fresh measurement, though the pane's DOM may not have changed: full screen
/// entered or left, a backing-scale or screen change, a restore from the Dock,
/// the app becoming active, a wake from sleep, a display reconfiguration.
/// Each emits `browser-geometry-stale`; the pane coalesces them per frame.
/// The observers live as long as the app, so their tokens are parked on the
/// main thread and never removed. Must be called on the main thread.
#[cfg(target_os = "macos")]
pub fn observe(app: tauri::AppHandle) {
    use objc2::{rc::Retained, runtime::ProtocolObject};
    use objc2_foundation::{NSNotification, NSNotificationCenter, NSNotificationName, NSObjectProtocol};
    use std::{cell::RefCell, ptr::NonNull};
    use tauri::Emitter;
    thread_local! {
        static TOKENS: RefCell<Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>> =
            const { RefCell::new(Vec::new()) };
    }
    let add = |center: &NSNotificationCenter, name: &NSNotificationName, reason: &'static str| {
        let app = app.clone();
        let handler = block2::RcBlock::new(move |_: NonNull<NSNotification>| {
            let _ = app.emit("browser-geometry-stale", reason);
        });
        // No object filter: these are rare, and a resync with nothing stale
        // costs one measurement.
        let token = unsafe { center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &handler) };
        TOKENS.with(|tokens| tokens.borrow_mut().push(token));
    };
    let center = NSNotificationCenter::defaultCenter();
    unsafe {
        use objc2_app_kit::*;
        add(&center, NSWindowDidEnterFullScreenNotification, "enter-full-screen");
        add(&center, NSWindowDidExitFullScreenNotification, "exit-full-screen");
        add(&center, NSWindowDidChangeBackingPropertiesNotification, "backing");
        add(&center, NSWindowDidChangeScreenNotification, "screen");
        add(&center, NSWindowDidDeminiaturizeNotification, "deminiaturize");
        add(&center, NSApplicationDidBecomeActiveNotification, "active");
        add(&center, NSApplicationDidChangeScreenParametersNotification, "screen-parameters");
        let workspace = NSWorkspace::sharedWorkspace().notificationCenter();
        add(&workspace, NSWorkspaceDidWakeNotification, "wake");
    }
}

#[cfg(not(target_os = "macos"))]
pub fn observe(_: tauri::AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::{LogicalPosition, LogicalSize, PhysicalPosition, PhysicalSize};

    // The pane below Redline's top bar, as the DOM measures it.
    const PANE: TopDownRect = TopDownRect { x: 470.0, y: 79.0, w: 960.0, h: 900.0 };
    // Overlay title bar: the content view is the whole window in both.
    const WINDOWED: f64 = 1009.0;
    const FULL_SCREEN: f64 = 1117.0;

    fn applied_then_resized(mask: usize, from: f64, to: f64) -> f64 {
        let origin = appkit_origin_y(from, false, PANE);
        let (origin, height) = autoresize_vertical(mask, origin, PANE.h, from, to);
        top_down_y(to, false, origin, height)
    }

    #[test]
    fn conversion_round_trips_windowed_and_full_screen() {
        for parent in [WINDOWED, FULL_SCREEN] {
            let origin = appkit_origin_y(parent, false, PANE);
            assert_eq!(origin, parent - 79.0 - 900.0);
            assert_eq!(top_down_y(parent, false, origin, PANE.h), PANE.y);
            assert_eq!(appkit_origin_y(parent, true, PANE), PANE.y);
            assert_eq!(top_down_y(parent, true, PANE.y, PANE.h), PANE.y);
        }
    }

    #[test]
    fn scale_factor_does_not_move_the_frame() {
        // The pane sends logical points; a 2x screen's physical pixels
        // convert back to the same points, so the frame is the same.
        for scale in [1.0, 2.0] {
            let position: LogicalPosition<f64> = PhysicalPosition::new(PANE.x * scale, PANE.y * scale).to_logical(scale);
            let size: LogicalSize<f64> = PhysicalSize::new(PANE.w * scale, PANE.h * scale).to_logical(scale);
            let rect = TopDownRect { x: position.x, y: position.y, w: size.width, h: size.height };
            assert_eq!(rect, PANE);
            assert_eq!(appkit_origin_y(WINDOWED, false, rect), WINDOWED - 979.0);
        }
    }

    #[test]
    fn a_pinned_top_holds_through_full_screen_and_back() {
        assert_eq!(applied_then_resized(PIN_TOP, WINDOWED, FULL_SCREEN), PANE.y);
        assert_eq!(applied_then_resized(PIN_TOP, FULL_SCREEN, WINDOWED), PANE.y);
        assert_eq!(applied_then_resized(FOLLOW_WINDOW, WINDOWED, FULL_SCREEN), PANE.y);
        assert_eq!(applied_then_resized(FOLLOW_WINDOW, FULL_SCREEN, WINDOWED), PANE.y);
    }

    #[test]
    fn with_no_mask_the_page_slides_by_the_height_change() {
        // The bug: a fixed bottom margin moves the top by the full change,
        // up when the window gets shorter (leaving full screen), down when taller.
        assert_eq!(applied_then_resized(0, FULL_SCREEN, WINDOWED), PANE.y - (FULL_SCREEN - WINDOWED));
        assert_eq!(applied_then_resized(0, WINDOWED, FULL_SCREEN), PANE.y + (FULL_SCREEN - WINDOWED));
    }

    #[test]
    fn masks() {
        assert_eq!(autoresize_mask(false), 8);
        assert_eq!(autoresize_mask(true), 22);
    }
}
