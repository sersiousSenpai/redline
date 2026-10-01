// SPDX-License-Identifier: Apache-2.0
//! Floating DOM surfaces over native browser pages. A shared AppKit plane masks
//! only their silhouettes and passes those hit tests to the main webview below.
//! Page bounds, scroll position and the footer never change for a chat morph.
use serde::Deserialize;
use std::sync::Mutex;
use tauri::Manager;

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct OverlayRect { pub x: f64, pub y: f64, pub width: f64, pub height: f64, pub radius: f64 }
impl OverlayRect {
    fn valid(&self) -> bool {
        [self.x, self.y, self.width, self.height, self.radius].iter().all(|v| v.is_finite() && v.abs() <= 32_768.)
            && self.width > 0. && self.height > 0. && self.radius >= 0.
    }
    /// Same rounded silhouette for paint and hit testing (including corners).
    pub fn contains(&self, x: f64, y: f64) -> bool {
        if x < self.x || y < self.y || x > self.x + self.width || y > self.y + self.height { return false; }
        let r = self.radius.min(self.width / 2.).min(self.height / 2.);
        let cx = x.clamp(self.x + r, self.x + self.width - r);
        let cy = y.clamp(self.y + r, self.y + self.height - r);
        (x - cx).powi(2) + (y - cy).powi(2) <= r * r
    }
}
static REGIONS: Mutex<Vec<OverlayRect>> = Mutex::new(Vec::new());

#[cfg(target_os = "macos")]
pub mod native {
    use super::*;
    use std::cell::{Cell, RefCell};
    use objc2::{define_class, msg_send, DefinedClass, MainThreadOnly};
    use objc2::rc::Retained;
    use objc2_app_kit::{NSAutoresizingMaskOptions, NSView};
    use objc2_foundation::{MainThreadMarker, NSObjectProtocol, NSPoint, NSRect, NSSize};
    use objc2_core_graphics::{CGMutablePath};
    use objc2_quartz_core::{CAShapeLayer, CATransaction, kCAFillRuleEvenOdd};

    pub struct Ivars { rects: RefCell<Vec<OverlayRect>>, flipped: Cell<bool> }
    define_class!(
        #[unsafe(super(NSView))]
        #[thread_kind = MainThreadOnly]
        #[ivars = Ivars]
        pub struct RedlineBrowserPlane;
        unsafe impl NSObjectProtocol for RedlineBrowserPlane {}
        impl RedlineBrowserPlane {
            #[unsafe(method(isFlipped))]
            fn flipped(&self) -> bool { self.ivars().flipped.get() }
            #[unsafe(method_id(hitTest:))]
            fn hit_test(&self, point: NSPoint) -> Option<Retained<NSView>> {
                let parent = unsafe { self.superview() };
                let local = self.convertPoint_fromView(point, parent.as_deref());
                let y = if self.isFlipped() { local.y } else { self.bounds().size.height - local.y };
                if self.ivars().rects.borrow().iter().any(|r| r.contains(local.x, y)) { None } else {
                let hit: Option<Retained<NSView>> = unsafe { msg_send![super(self), hitTest: point] };
                // Empty space and closed/suspended pages must not intercept input.
                hit.filter(|view| !std::ptr::eq(&**view, &**self))
                }
            }
            #[unsafe(method(setFrameSize:))]
            fn resize(&self, size: NSSize) {
                let _: () = unsafe { msg_send![super(self), setFrameSize: size] };
                self.update_mask();
            }
        }
    );
    impl RedlineBrowserPlane {
        fn update_mask(&self) {
            let Some(layer) = self.layer() else { return; };
            let bounds = self.bounds();
            unsafe {
                CATransaction::begin(); CATransaction::setDisableActions(true);
                // Intersect alpha masks instead of XORing multiple holes. Menus
                // can overlap the island; an overlap must stay transparent.
                let mut mask: Option<Retained<CAShapeLayer>> = None;
                for rect in self.ivars().rects.borrow().iter() {
                    let path = CGMutablePath::new();
                    CGMutablePath::add_rect(Some(&path), std::ptr::null(), bounds);
                    let y = if self.isFlipped() { rect.y } else { bounds.size.height - rect.y - rect.height };
                    let hole = NSRect::new(NSPoint::new(rect.x, y), NSSize::new(rect.width, rect.height));
                    let radius = rect.radius.min(rect.width / 2.).min(rect.height / 2.);
                    CGMutablePath::add_rounded_rect(Some(&path), std::ptr::null(), hole, radius, radius);
                    let shape = CAShapeLayer::new();
                    shape.setFrame(bounds); shape.setPath(Some(&path)); shape.setFillRule(kCAFillRuleEvenOdd);
                    shape.setMask(mask.as_deref().map(|previous| &**previous));
                    mask = Some(shape);
                }
                layer.setMask(mask.as_deref().map(|shape| &**shape));
                CATransaction::commit();
            }
        }
    }

    /// All browser siblings use one plane. Wry still sets each WKWebView's
    /// normal frame against a parent with identical bounds and coordinates.
    pub fn attach(view: &NSView, rects: Vec<OverlayRect>, mtm: MainThreadMarker) {
        let Some(parent) = (unsafe { view.superview() }) else { return; };
        if let Some(plane) = parent.downcast_ref::<RedlineBrowserPlane>() {
            if *plane.ivars().rects.borrow() != rects { *plane.ivars().rects.borrow_mut() = rects; plane.update_mask(); }
            return;
        }
        let existing = parent.subviews().iter().find_map(|sibling| sibling.downcast::<RedlineBrowserPlane>().ok());
        let plane = existing.unwrap_or_else(|| {
            let allocated = mtm.alloc::<RedlineBrowserPlane>().set_ivars(Ivars { rects: RefCell::new(Vec::new()), flipped: Cell::new(parent.isFlipped()) });
            let plane: Retained<RedlineBrowserPlane> = unsafe { msg_send![super(allocated), initWithFrame: parent.bounds()] };
            plane.setAutoresizingMask(NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable);
            plane.setAutoresizesSubviews(false);
            plane.setWantsLayer(true);
            parent.addSubview(&plane);
            plane
        });
        let frame = view.frame();
        view.removeFromSuperview();
        plane.addSubview(view); view.setFrame(frame);
        if *plane.ivars().rects.borrow() != rects { *plane.ivars().rects.borrow_mut() = rects; plane.update_mask(); }
    }
}

fn attach(app: &tauri::AppHandle, label: &str, rects: Vec<OverlayRect>) -> Result<(), String> {
    let Some(view) = app.get_webview(label) else { return Ok(()); };
    #[cfg(target_os = "macos")]
    view.with_webview(move |handle| {
        let Some(mtm) = objc2_foundation::MainThreadMarker::new() else { return; };
        // SAFETY: with_webview is on AppKit's main thread; WKWebView is an NSView.
        if let Some(view) = unsafe { (handle.inner() as *mut objc2_app_kit::NSView).as_ref() } {
            native::attach(view, rects, mtm);
        }
    }).map_err(|error| error.to_string())?;
    #[cfg(not(target_os = "macos"))] let _ = (view, rects);
    Ok(())
}

#[tauri::command]
pub fn browser_overlay_attach(app: tauri::AppHandle, webview: tauri::Webview, label: String) -> Result<(), String> {
    if webview.label() != "main" || !label.starts_with("browser-") { return Err("Only the app can compose browser overlays".into()); }
    attach(&app, &label, REGIONS.lock().map_err(|_| "Overlay state unavailable")?.clone())
}

#[tauri::command]
pub fn browser_overlay_regions(app: tauri::AppHandle, webview: tauri::Webview, rects: Vec<OverlayRect>) -> Result<(), String> {
    if webview.label() != "main" || rects.len() > 16 || rects.iter().any(|rect| !rect.valid()) { return Err("Invalid floating overlay regions".into()); }
    *REGIONS.lock().map_err(|_| "Overlay state unavailable")? = rects.clone();
    for label in app.webviews().keys().filter(|label| label.starts_with("browser-")) { attach(&app, label, rects.clone())?; }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn rounded_corners_pass_input_to_the_page() {
        let rect = OverlayRect { x: 100., y: 200., width: 600., height: 180., radius: 26. };
        assert!(rect.valid()); assert!(rect.contains(400., 220.)); assert!(rect.contains(126., 200.));
        assert!(!rect.contains(100., 200.)); assert!(!rect.contains(400., 381.));
    }
    #[test] fn rejects_non_finite_and_unbounded_regions() {
        let mut rect = OverlayRect { x: 0., y: 0., width: 600., height: 180., radius: 26. };
        rect.x = f64::NAN; assert!(!rect.valid()); rect.x = 0.;
        rect.width = -1.; assert!(!rect.valid()); rect.width = 600.;
        rect.radius = f64::INFINITY; assert!(!rect.valid());
    }
}
