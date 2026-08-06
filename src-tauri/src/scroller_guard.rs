// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Pins this app's macOS scroller style so AppKit never live-swaps its
//! `NSScrollerImp` objects mid-run.
//!
//! When "Show scroll bars" is set to "Automatically" (the macOS default),
//! the recommended scroller style flips between overlay and legacy whenever
//! a pointing device connects or disconnects — e.g. a Bluetooth mouse
//! sleeping. AppKit then replaces every `NSScrollerImp` on the main thread
//! while WebKit's "WebCore: Scrolling" thread may still be driving the old
//! ones from a display-link tick. On the WebKit shipped with macOS 14.3
//! that's a use-after-free (`ScrollerMac::updateValues` →
//! `-[NSScrollerImp setEnabled:]` on a freed imp) that segfaults the whole
//! process — it killed Redline on 2026-08-05, and with several live
//! WKWebViews we are unusually exposed. Fixed in newer WebKit, but we can't
//! pick our users' OS point release, so remove the trigger instead:
//!
//! - Global setting is "Automatic" (or unset, which means Automatic): write
//!   `AppleShowScrollBars = WhenScrolling` into our own defaults domain.
//!   The per-app value outranks the global one, `NSScroller`'s preferred
//!   style becomes a constant, and the swap notification never fires in
//!   this process. "WhenScrolling" (overlay) is what Automatic resolves to
//!   on a trackpad anyway, so on a laptop nothing visibly changes.
//! - Global setting is a fixed style ("Always"/"WhenScrolling"): the style
//!   already can't change, so clear any override we wrote on an earlier run
//!   and let the user's explicit choice through.

use objc2::runtime::AnyObject;
use objc2_foundation::{ns_string, NSString, NSUserDefaults};

#[derive(Debug, PartialEq, Eq)]
enum Action {
    Pin,
    Clear,
}

fn action_for(global: Option<&str>) -> Action {
    match global {
        Some(v) if v.eq_ignore_ascii_case("Always") || v.eq_ignore_ascii_case("WhenScrolling") => {
            Action::Clear
        }
        // Unset, "Automatic", or anything AppKit would treat as Automatic.
        _ => Action::Pin,
    }
}

/// Call before any window (and therefore any scroller) exists.
pub fn pin_scroller_style() {
    let key = ns_string!("AppleShowScrollBars");
    unsafe {
        let defaults = NSUserDefaults::standardUserDefaults();
        // Read the global domain directly rather than through the search
        // list — our own earlier override must not mask what the user set
        // in System Settings since then.
        let global = defaults
            .persistentDomainForName(ns_string!("NSGlobalDomain"))
            .and_then(|d| d.objectForKey(key))
            .and_then(|v| v.downcast::<NSString>().ok())
            .map(|s| s.to_string());
        match action_for(global.as_deref()) {
            Action::Pin => {
                let style: &AnyObject = ns_string!("WhenScrolling").as_ref();
                defaults.setObject_forKey(Some(style), key);
                tracing::info!(
                    "scroller_guard: global scroller style is Automatic; \
                     pinned AppleShowScrollBars=WhenScrolling for this app"
                );
            }
            Action::Clear => {
                defaults.removeObjectForKey(key);
                tracing::debug!(
                    "scroller_guard: global scroller style is fixed ({:?}); no override",
                    global
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pins_when_unset_or_automatic() {
        assert_eq!(action_for(None), Action::Pin);
        assert_eq!(action_for(Some("Automatic")), Action::Pin);
        assert_eq!(action_for(Some("automatic")), Action::Pin);
        // Unknown values fall back to AppKit's Automatic behavior — pin.
        assert_eq!(action_for(Some("Sometimes")), Action::Pin);
    }

    #[test]
    fn clears_for_fixed_styles() {
        assert_eq!(action_for(Some("Always")), Action::Clear);
        assert_eq!(action_for(Some("WhenScrolling")), Action::Clear);
        assert_eq!(action_for(Some("whenscrolling")), Action::Clear);
    }
}
