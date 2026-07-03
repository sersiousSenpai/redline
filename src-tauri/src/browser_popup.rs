// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
//! New-window (OAuth / SSO popup) support for the embedded browser's child
//! webviews.
//!
//! When a page calls `window.open(url, name, "width=…")` — the shape a real
//! popup uses — WebKit routes it to the webview's `WKUIDelegate`
//! `createWebViewWithConfiguration:` method. wry's own UI delegate only acts on
//! that when a `new_window_req_handler` is set (it isn't, for the webviews we
//! create through Tauri's JS API), so the request is silently dropped and the
//! sign-in popup never appears. Crucially, this is also the ONLY path that gives
//! the opened webview a live `window.opener` back to the page and a working
//! `window.close()` / `.closed` — a separate Redline tab can't, because it's an
//! independent webview with no opener relationship. So OAuth popups specifically
//! must go through here (plain "open in a new tab" links are handled in JS by
//! the pane and never reach this delegate).
//!
//! We install our OWN `WKUIDelegate` on each child webview. It:
//!   * hosts the WebKit-created child in a floating `NSWindow` (exactly what a
//!     browser popup is — real opener, shared cookies via the inherited
//!     `configuration`, auto-closing on `window.close()`), and
//!   * re-implements wry's other two delegate methods verbatim (file-`<input>`
//!     upload panel + camera/mic permission grant) so replacing wry's delegate
//!     doesn't regress those on every site.
//!
//! The delegate class mirrors wry 0.55's `WryWebViewUIDelegate` (same objc2 /
//! objc2-web-kit versions), so the unsafe memory/threading patterns are the
//! proven ones. macOS-only.
#![cfg(target_os = "macos")]

use std::cell::RefCell;
use std::ptr::null_mut;
use std::rc::Rc;

use block2::Block;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject, ProtocolObject};
use objc2::{define_class, msg_send, DefinedClass, MainThreadOnly};
use objc2_app_kit::{
    NSBackingStoreType, NSModalResponseOK, NSOpenPanel, NSWindow, NSWindowDelegate,
    NSWindowStyleMask,
};
use objc2_foundation::{
    MainThreadMarker, NSArray, NSNotification, NSObjectProtocol, NSPoint, NSRect, NSSize, NSURL,
};
use objc2_web_kit::{
    WKFrameInfo, WKMediaCaptureType, WKNavigationAction, WKOpenPanelParameters, WKPermissionDecision,
    WKSecurityOrigin, WKUIDelegate, WKWebView, WKWebViewConfiguration, WKWindowFeatures,
};

// libobjc associated-object retention. `WKWebView.UIDelegate` is a WEAK
// reference, so our delegate would deallocate the instant this call returns
// unless something else retains it. We tie its lifetime to the webview by
// attaching it as a retained associated object — freed automatically when the
// webview itself is destroyed (tab close / suspend), with no global registry.
#[allow(non_upper_case_globals)]
const OBJC_ASSOCIATION_RETAIN_NONATOMIC: usize = 1;
extern "C" {
    fn objc_setAssociatedObject(
        object: *mut AnyObject,
        key: *const std::ffi::c_void,
        value: *mut AnyObject,
        policy: usize,
    );
}
// Unique per-webview key: only its address is used.
static ASSOC_KEY: u8 = 0;

// A hosted popup window we keep alive. Dropping it removes the child webview
// from its superview (mirrors wry's `NewWindow`) before the window deallocs.
struct PopupHost {
    ns_window: Retained<NSWindow>,
    webview: Retained<WKWebView>,
    #[allow(dead_code)]
    delegate: Retained<PopupWindowDelegate>,
}

impl Drop for PopupHost {
    fn drop(&mut self) {
        self.webview.removeFromSuperview();
    }
}

// --- NSWindow delegate: prune the popup from the live set when it closes ------
struct PopupWindowDelegateIvars {
    on_close: Box<dyn Fn()>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = PopupWindowDelegateIvars]
    struct PopupWindowDelegate;

    unsafe impl NSObjectProtocol for PopupWindowDelegate {}

    unsafe impl NSWindowDelegate for PopupWindowDelegate {
        #[unsafe(method(windowWillClose:))]
        unsafe fn will_close(&self, _notification: &NSNotification) {
            (self.ivars().on_close)();
        }
    }
);

impl PopupWindowDelegate {
    fn new(mtm: MainThreadMarker, on_close: Box<dyn Fn()>) -> Retained<Self> {
        let delegate = mtm
            .alloc::<PopupWindowDelegate>()
            .set_ivars(PopupWindowDelegateIvars { on_close });
        unsafe { msg_send![super(delegate), init] }
    }
}

// --- Our WKUIDelegate ---------------------------------------------------------
struct BrowserUIDelegateIvars {
    windows: Rc<RefCell<Vec<PopupHost>>>,
}

/// Build + show a floating popup window hosting a WebKit-created child webview,
/// tracking it in `windows` so it's pruned when the window closes. Returns the
/// child webview for WebKit to drive — returning it is what wires the popup's
/// `window.opener`. Mirrors wry's `NewWindowResponse::Allow` branch. Lives
/// outside the `method_id` body so it can use `?` (the macro re-types that body).
///
/// SAFETY: called only from the UI-delegate method, which WebKit invokes on the
/// main thread; every AppKit/WebKit call below runs there.
unsafe fn build_popup(
    windows: &Rc<RefCell<Vec<PopupHost>>>,
    webview: &WKWebView,
    configuration: &WKWebViewConfiguration,
    window_features: &WKWindowFeatures,
) -> Option<Retained<WKWebView>> {
    let mtm = MainThreadMarker::new()?;
    let current_window = webview.window()?;
    let screen = current_window.screen()?;
    let screen_frame = screen.frame();
    let defaults = current_window.frame();

    let size = NSSize::new(
        window_features
            .width()
            .map_or(defaults.size.width, |w| w.doubleValue()),
        window_features
            .height()
            .map_or(defaults.size.height, |h| h.doubleValue()),
    );
    // AppKit's origin is bottom-left; window features give a top-left Y, so flip
    // it against the screen height (same conversion wry uses).
    let position = NSPoint::new(
        window_features
            .x()
            .map_or(defaults.origin.x, |x| x.doubleValue()),
        window_features.y().map_or(defaults.origin.y, |y| {
            screen_frame.size.height - y.doubleValue() - size.height
        }),
    );
    let rect = NSRect::new(position, size);

    let mut flags =
        NSWindowStyleMask::Titled | NSWindowStyleMask::Closable | NSWindowStyleMask::Miniaturizable;
    let resizable = window_features
        .allowsResizing()
        .map_or(true, |r| r.boolValue());
    if resizable {
        flags |= NSWindowStyleMask::Resizable;
    }

    let window = NSWindow::initWithContentRect_styleMask_backing_defer(
        mtm.alloc::<NSWindow>(),
        rect,
        flags,
        NSBackingStoreType::Buffered,
        false,
    );
    // We own the window via `Retained` in `windows`; don't let a close release it
    // out from under us (mirrors wry).
    window.setReleasedWhenClosed(false);

    let popup = WKWebView::initWithFrame_configuration(
        mtm.alloc::<WKWebView>(),
        window.frame(),
        configuration,
    );

    let windows_for_close = windows.clone();
    let window_id = Retained::as_ptr(&window) as usize;
    let delegate = PopupWindowDelegate::new(
        mtm,
        Box::new(move || {
            windows_for_close
                .borrow_mut()
                .retain(|h| Retained::as_ptr(&h.ns_window) as usize != window_id);
        }),
    );
    window.setDelegate(Some(&ProtocolObject::from_ref(&*delegate)));
    window.setContentView(Some(&popup));
    window.makeKeyAndOrderFront(None);

    windows.borrow_mut().push(PopupHost {
        ns_window: window,
        webview: popup.clone(),
        delegate,
    });

    Some(popup)
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = BrowserUIDelegateIvars]
    struct BrowserUIDelegate;

    unsafe impl NSObjectProtocol for BrowserUIDelegate {}

    unsafe impl WKUIDelegate for BrowserUIDelegate {
        // A `window.open`-with-features (or a `target=_blank` form) landing here
        // is a genuine popup: host the WebKit-created child in a floating window.
        // Returning the webview is what wires `window.opener` / `.closed` /
        // `window.close()`. Body mirrors wry's `NewWindowResponse::Allow` branch.
        #[unsafe(method_id(webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:))]
        unsafe fn create_web_view(
            &self,
            webview: &WKWebView,
            configuration: &WKWebViewConfiguration,
            _action: &WKNavigationAction,
            window_features: &WKWindowFeatures,
        ) -> Option<Retained<WKWebView>> {
            // The real work lives in `build_popup` (a plain fn) so it can use `?`
            // — a `method_id` body can't, since the macro re-types its return.
            build_popup(
                &self.ivars().windows,
                webview,
                configuration,
                window_features,
            )
        }

        // JS `window.close()` on the popup → close its hosting window, which
        // fires `windowWillClose:` and prunes it from the live set.
        #[unsafe(method(webViewDidClose:))]
        unsafe fn web_view_did_close(&self, webview: &WKWebView) {
            if let Some(window) = webview.window() {
                window.close();
            }
        }

        // --- Copied verbatim from wry's UI delegate so replacing it doesn't ---
        // --- drop file uploads or camera/mic on these child webviews. ---------
        #[unsafe(method(webView:runOpenPanelWithParameters:initiatedByFrame:completionHandler:))]
        fn run_file_upload_panel(
            &self,
            _webview: &WKWebView,
            open_panel_params: &WKOpenPanelParameters,
            _frame: &WKFrameInfo,
            handler: &Block<dyn Fn(*const NSArray<NSURL>)>,
        ) {
            unsafe {
                if let Some(mtm) = MainThreadMarker::new() {
                    let open_panel = NSOpenPanel::openPanel(mtm);
                    open_panel.setCanChooseFiles(true);
                    let allow_multi = open_panel_params.allowsMultipleSelection();
                    open_panel.setAllowsMultipleSelection(allow_multi);
                    let allow_dir = open_panel_params.allowsDirectories();
                    open_panel.setCanChooseDirectories(allow_dir);
                    let ok = open_panel.runModal();
                    if ok == NSModalResponseOK {
                        let url = open_panel.URLs();
                        (*handler).call((Retained::as_ptr(&url),));
                    } else {
                        (*handler).call((null_mut(),));
                    }
                }
            }
        }

        #[unsafe(method(webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:))]
        fn request_media_capture_permission(
            &self,
            _webview: &WKWebView,
            _origin: &WKSecurityOrigin,
            _frame: &WKFrameInfo,
            _capture_type: WKMediaCaptureType,
            decision_handler: &Block<dyn Fn(WKPermissionDecision)>,
        ) {
            (*decision_handler).call((WKPermissionDecision::Grant,));
        }
    }
);

impl BrowserUIDelegate {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let delegate = mtm
            .alloc::<BrowserUIDelegate>()
            .set_ivars(BrowserUIDelegateIvars {
                windows: Rc::new(RefCell::new(Vec::new())),
            });
        unsafe { msg_send![super(delegate), init] }
    }
}

/// Install our new-window UI delegate on one browser child webview. Called once
/// per webview at creation (`browser_install_shims`). The delegate is retained
/// as an associated object, so it lives exactly as long as the webview. Safe to
/// be a no-op if the webview handle is gone.
pub fn install_new_window_delegate(wv: &tauri::Webview) -> Result<(), String> {
    wv.with_webview(|pw| {
        // SAFETY: `with_webview` runs on the UI (main) thread; `inner()` is the
        // live WKWebView (wry's subclass), so treating it as `WKWebView` and
        // sending UI-delegate/associated-object messages is sound.
        unsafe {
            let ptr = pw.inner() as *mut WKWebView;
            let Some(webview) = ptr.as_ref() else { return };
            let Some(mtm) = MainThreadMarker::new() else { return };
            let delegate = BrowserUIDelegate::new(mtm);
            webview.setUIDelegate(Some(&ProtocolObject::from_ref(&*delegate)));
            // Retain the delegate for the webview's lifetime (UIDelegate is weak).
            objc_setAssociatedObject(
                ptr as *mut AnyObject,
                &ASSOC_KEY as *const u8 as *const std::ffi::c_void,
                Retained::as_ptr(&delegate) as *mut AnyObject,
                OBJC_ASSOCIATION_RETAIN_NONATOMIC,
            );
        }
    })
    .map_err(|e| e.to_string())
}
