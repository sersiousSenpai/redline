// SPDX-License-Identifier: Apache-2.0
//! Main-thread AppKit regression probe; creates no visible window, opens no URL,
//! and never touches Redline's database. Run with cargo run --example browser_overlay_probe.
#[path = "../src/browser_overlay.rs"]
mod browser_overlay;

#[cfg(target_os = "macos")]
fn main() {
    use browser_overlay::{native, OverlayRect};
    use objc2::{msg_send, MainThreadOnly};
    use objc2::rc::Retained;
    use objc2_app_kit::{NSApplication, NSView};
    use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize};
    use objc2_web_kit::{WKWebView, WKWebViewConfiguration};
    let mtm = MainThreadMarker::new().expect("probe must run on main thread");
    let _app = NSApplication::sharedApplication(mtm);
    let frame = NSRect::new(NSPoint::new(0., 0.), NSSize::new(900., 640.));
    let root = NSView::initWithFrame(NSView::alloc(mtm), frame);
    let main = NSView::initWithFrame(NSView::alloc(mtm), frame);
    root.addSubview(&main);
    // Real WKWebViews exercise the superclass chain and reparenting used by Wry.
    let config = unsafe { WKWebViewConfiguration::new(mtm) };
    let page = unsafe { WKWebView::initWithFrame_configuration(WKWebView::alloc(mtm), frame, &config) };
    root.addSubview(&page);
    let rect = OverlayRect { x: 110., y: 360., width: 680., height: 208., radius: 26. };
    native::attach(&page, vec![rect.clone()], mtm);
    assert_eq!(page.frame(), frame, "overlay must not resize the page");
    let plane = unsafe { page.superview() }.unwrap();
    assert_eq!(plane.bounds(), frame);
    let hit: Option<Retained<NSView>> = unsafe { msg_send![&*plane, hitTest: NSPoint::new(450., 180.)] };
    assert!(hit.is_none(), "island clicks must pass through the native plane");
    let hit = root.hitTest(NSPoint::new(450., 180.)).unwrap();
    assert!(std::ptr::eq(&*hit, &*main), "island clicks must reach the app webview below");
    let outside = plane.hitTest(NSPoint::new(450., 600.));
    assert!(outside.is_some(), "page must remain interactive outside the island");
    let corner = plane.hitTest(NSPoint::new(110., 280.));
    assert!(corner.is_some(), "rounded corners must leave the page interactive");
    // Overlapping picker and island need two intersected masks, never an XOR gap.
    let menu = OverlayRect { x: 128., y: 100., width: 328., height: 420., radius: 18. };
    native::attach(&page, vec![rect, menu], mtm);
    let first_mask = plane.layer().unwrap().mask().expect("paint mask");
    assert!(first_mask.mask().is_some(), "overlapping overlays compose as alpha intersections");
    assert!(plane.hitTest(NSPoint::new(200., 200.)).is_none());
    assert_eq!(page.frame(), frame, "opening a picker must preserve page geometry");
    let other = NSView::initWithFrame(NSView::alloc(mtm), frame);
    root.addSubview(&other);
    native::attach(&other, vec![], mtm);
    assert!(std::ptr::eq(&*plane, &*unsafe { other.superview() }.unwrap()), "all tiles share one plane");
    page.setHidden(true); other.setHidden(true);
    assert!(plane.hitTest(NSPoint::new(450., 600.)).is_none(), "inactive pages cannot block app input");
    page.setHidden(false);
    native::attach(&page, vec![], mtm);
    assert!(plane.layer().unwrap().mask().is_none(), "unmounting overlays restores the whole page");
    let resized = NSRect::new(NSPoint::new(0., 0.), NSSize::new(1200., 900.));
    root.setFrame(resized);
    assert_eq!(plane.bounds().size, resized.size, "plane tracks window resizing");
    assert_eq!(page.frame().size, frame.size, "only Wry owns the page size");
    println!("PASS: native overlay paint masks, overlapping menus, WKWebView reparenting, rounded hit testing, inactive pages and window resizing");
}
#[cfg(not(target_os = "macos"))]
fn main() { println!("This AppKit probe runs on macOS."); }
