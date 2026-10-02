// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
//! Everything that leaves the embedded browser as a file or on paper: Safari-
//! style downloads, "Save page/PDF", and printing.
//!
//! * **Downloads.** Every browser tab is built with `on_download` (see
//!   `browser_tab_builder` in lib.rs). A request lands in `~/Downloads` under a
//!   sanitized, de-duplicated name; when it finishes we emit
//!   `browser-download {label, url, path, name, success}` and the app shows a
//!   toast with Open / Show in Finder. On macOS Tauri's `Finished` event never
//!   carries the path, so the destination chosen at `Requested` is remembered
//!   per (tab, url) and paired back up here.
//! * **Save page/PDF.** `startDownloadUsingRequest:` on the tab's own WKWebView,
//!   so the request carries the tab's cookies and a login-gated PDF saves its
//!   real bytes, not the HTML shell a cookie-less fetch would get.
//! * **Print.** `printOperationWithPrintInfo:` on the WKWebView, its view sized
//!   to the webview, run as a sheet on the main window. wry's own
//!   `print_with_options` is avoided: it unwraps the window and prints blank
//!   pages from child webviews.
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::json;
use tauri::{Emitter, Manager, Runtime};

/// Destinations chosen at `Requested`, waiting for their `Finished`.
static PENDING: Mutex<Vec<(String, String, PathBuf)>> = Mutex::new(Vec::new());

/// `~/Downloads`, created if missing.
pub fn downloads_dir() -> Option<PathBuf> {
    let dir = Path::new(&crate::fsbrowse::home_dir()?).join("Downloads");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// Where a download named `suggested` (WebKit's pick, already derived from
/// Content-Disposition) lands in `dir`: sanitized to a bare filename, falling
/// back to one derived from the URL, and never clobbering an existing file.
pub fn destination_for(dir: &Path, suggested: &str, url: &str) -> PathBuf {
    let mut name = crate::sanitize_basename(suggested);
    if name.is_empty() {
        name = crate::download_filename(url, false);
    }
    crate::dedup_path(dir, &name)
}

fn remember(label: &str, url: &str, path: PathBuf) {
    let mut pending = PENDING.lock().unwrap();
    // A burst of abandoned downloads must not grow this without bound.
    if pending.len() >= 64 {
        pending.remove(0);
    }
    pending.push((label.to_owned(), url.to_owned(), path));
}

fn take(label: &str, url: &str) -> Option<PathBuf> {
    let mut pending = PENDING.lock().unwrap();
    let at = pending.iter().position(|(l, u, _)| l == label && u == url)?;
    Some(pending.remove(at).2)
}

/// Tell the app a file landed (or didn't). The toast is the frontend's.
pub fn emit_download<R: Runtime>(app: &tauri::AppHandle<R>, label: &str, url: &str, path: Option<&Path>, success: bool) {
    let name = path.and_then(Path::file_name).map(|n| n.to_string_lossy().into_owned());
    let _ = app.emit(
        "browser-download",
        json!({ "label": label, "url": url, "path": path.map(|p| p.display().to_string()), "name": name, "success": success }),
    );
}

/// The `on_download` handler every browser tab is built with.
pub fn on_download<R: Runtime>(webview: tauri::Webview<R>, event: tauri::webview::DownloadEvent<'_>) -> bool {
    use tauri::webview::DownloadEvent;
    match event {
        DownloadEvent::Requested { url, destination } => {
            let Some(dir) = downloads_dir() else { return false };
            let suggested = destination.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let path = destination_for(&dir, &suggested, url.as_str());
            *destination = path.clone();
            remember(webview.label(), url.as_str(), path);
            true
        }
        DownloadEvent::Finished { url, path, success } => {
            let path = take(webview.label(), url.as_str()).or(path);
            emit_download(webview.app_handle(), webview.label(), url.as_str(), path.as_deref(), success);
            true
        }
        _ => true,
    }
}

/// Write bytes a page handed us (the PDF viewer's Save button) to `~/Downloads`
/// and announce it like any other download.
pub fn save_bytes<R: Runtime>(app: &tauri::AppHandle<R>, label: &str, url: &str, suggested: &str, bytes: &[u8]) {
    let written = downloads_dir().map(|dir| destination_for(&dir, suggested, url)).and_then(|path| {
        std::fs::write(&path, bytes).ok()?;
        Some(path)
    });
    emit_download(app, label, url, written.as_deref(), written.is_some());
}

#[cfg(target_os = "macos")]
pub use native::{run_print, save_data_to_file};

#[cfg(target_os = "macos")]
mod native {
    use std::cell::RefCell;
    use std::path::PathBuf;
    use std::ptr::NonNull;

    use block2::{Block, RcBlock};
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool, NSObject, ProtocolObject};
    use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadOnly};
    use objc2_app_kit::{NSPrintInfo, NSPrintOperation};
    use objc2_foundation::{
        MainThreadMarker, NSData, NSError, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString, NSURLRequest,
        NSURLResponse, NSURL,
    };
    use objc2_web_kit::{WKDownload, WKDownloadDelegate, WKWebView};

    // `WKDownload.delegate` is weak and NSPrintOperation does not retain its
    // modal delegate, so each helper object rides on the object it serves as a
    // retained associated object and goes away with it.
    const OBJC_ASSOCIATION_RETAIN_NONATOMIC: usize = 1;
    extern "C" {
        fn objc_setAssociatedObject(object: *mut AnyObject, key: *const std::ffi::c_void, value: *mut AnyObject, policy: usize);
    }
    static SAVE_KEY: u8 = 0;
    static PRINT_KEY: u8 = 0;

    unsafe fn attach(owner: *mut AnyObject, key: &'static u8, value: *mut AnyObject) {
        objc_setAssociatedObject(owner, key as *const u8 as *const std::ffi::c_void, value, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }

    // --- Print ---------------------------------------------------------------
    struct PrintDoneIvars {
        done: RefCell<Option<RcBlock<dyn Fn()>>>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = PrintDoneIvars]
        struct PrintDone;

        unsafe impl NSObjectProtocol for PrintDone {}

        impl PrintDone {
            #[unsafe(method(printOperationDidRun:success:contextInfo:))]
            fn did_run(&self, _operation: &NSPrintOperation, _success: Bool, _context: *mut std::ffi::c_void) {
                if let Some(done) = self.ivars().done.borrow_mut().take() {
                    done.call(());
                }
            }
        }
    );

    /// Run the print sheet for one WKWebView. `done` is a page-initiated print's
    /// completion handler: WebKit holds `window.print()` until it is called, so
    /// it runs when the sheet closes, never earlier.
    ///
    /// SAFETY: main thread only; `webview` is a live WKWebView.
    pub unsafe fn run_print(webview: &WKWebView, done: Option<RcBlock<dyn Fn()>>) {
        let Some(mtm) = MainThreadMarker::new() else {
            if let Some(done) = done { done.call(()) }
            return;
        };
        let info = NSPrintInfo::sharedPrintInfo();
        let operation = webview.printOperationWithPrintInfo(&info);
        // The printing view starts at a zero frame on a child webview, which is
        // what produces blank pages. Give it the page's own size.
        if let Some(view) = operation.view() {
            let bounds = webview.bounds();
            let frame = if bounds.size.width >= 200.0 && bounds.size.height >= 200.0 {
                bounds
            } else {
                NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(1024.0, 768.0))
            };
            view.setFrame(frame);
        }
        operation.setShowsPrintPanel(true);
        operation.setShowsProgressPanel(true);
        let Some(window) = webview.window() else {
            operation.runOperation();
            if let Some(done) = done { done.call(()) }
            return;
        };
        let delegate = mtm.alloc::<PrintDone>().set_ivars(PrintDoneIvars { done: RefCell::new(done) });
        let delegate: Retained<PrintDone> = msg_send![super(delegate), init];
        attach(Retained::as_ptr(&operation) as *mut AnyObject, &PRINT_KEY, Retained::as_ptr(&delegate) as *mut AnyObject);
        operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
            &window,
            Some(&delegate),
            Some(sel!(printOperationDidRun:success:contextInfo:)),
            std::ptr::null_mut(),
        );
    }

    // --- Save page/PDF ---------------------------------------------------------
    struct SaveIvars {
        app: tauri::AppHandle,
        label: String,
        url: String,
        path: RefCell<Option<PathBuf>>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = SaveIvars]
        struct SaveDelegate;

        unsafe impl NSObjectProtocol for SaveDelegate {}

        unsafe impl WKDownloadDelegate for SaveDelegate {
            #[unsafe(method(download:decideDestinationUsingResponse:suggestedFilename:completionHandler:))]
            fn decide(
                &self,
                _download: &WKDownload,
                _response: &NSURLResponse,
                suggested: &NSString,
                handler: &Block<dyn Fn(*mut NSURL)>,
            ) {
                let ivars = self.ivars();
                let Some(dir) = super::downloads_dir() else {
                    handler.call((std::ptr::null_mut(),));
                    return;
                };
                let path = super::destination_for(&dir, &suggested.to_string(), &ivars.url);
                let url = NSURL::fileURLWithPath_isDirectory(&NSString::from_str(&path.display().to_string()), false);
                *ivars.path.borrow_mut() = Some(path);
                handler.call((Retained::as_ptr(&url) as *mut NSURL,));
            }

            #[unsafe(method(downloadDidFinish:))]
            fn finished(&self, _download: &WKDownload) {
                let ivars = self.ivars();
                super::emit_download(&ivars.app, &ivars.label, &ivars.url, ivars.path.borrow().as_deref(), true);
            }

            #[unsafe(method(download:didFailWithError:resumeData:))]
            fn failed(&self, _download: &WKDownload, _error: &NSError, _resume: *mut NSData) {
                let ivars = self.ivars();
                super::emit_download(&ivars.app, &ivars.label, &ivars.url, None, false);
            }
        }
    );

    /// Save whatever the tab is showing through the tab's own session.
    ///
    /// SAFETY: main thread only; `webview` is a live WKWebView.
    pub unsafe fn start_save(webview: &WKWebView, app: tauri::AppHandle, label: String, url: String) -> Result<(), String> {
        let ns_url = NSURL::URLWithString(&NSString::from_str(&url)).ok_or("This page has no address to save from")?;
        let request = NSURLRequest::requestWithURL(&ns_url);
        let handler = RcBlock::new(move |download: NonNull<WKDownload>| {
            let Some(mtm) = MainThreadMarker::new() else { return };
            let delegate = mtm.alloc::<SaveDelegate>().set_ivars(SaveIvars {
                app: app.clone(),
                label: label.clone(),
                url: url.clone(),
                path: RefCell::new(None),
            });
            let delegate: Retained<SaveDelegate> = msg_send![super(delegate), init];
            let download = download.as_ref();
            download.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
            attach(download as *const WKDownload as *mut AnyObject, &SAVE_KEY, Retained::as_ptr(&delegate) as *mut AnyObject);
        });
        webview.startDownloadUsingRequest_completionHandler(&request, &handler);
        Ok(())
    }

    /// The PDF viewer's Save button (`_webView:saveDataToFile:…`) hands us the
    /// document's bytes directly.
    pub fn save_data_to_file(app: &tauri::AppHandle, label: &str, data: &NSData, suggested: &NSString, url: Option<&NSURL>) {
        let url = url.and_then(|u| u.absoluteString()).map(|s| s.to_string()).unwrap_or_default();
        super::save_bytes(app, label, &url, &suggested.to_string(), &data.to_vec());
    }
}

/// Print the tab's page (⌘P, the page menu). Page-initiated prints arrive
/// through the tab's UI delegate instead and reuse the same sheet.
#[tauri::command]
pub fn browser_print(app: tauri::AppHandle, label: String) -> Result<(), String> {
    let wv = app.get_webview(&label).ok_or_else(|| format!("browser webview '{label}' not found"))?;
    #[cfg(target_os = "macos")]
    {
        wv.with_webview(|pw| {
            // SAFETY: `with_webview` runs on the main thread; `inner()` is the live WKWebView.
            unsafe {
                if let Some(webview) = (pw.inner() as *mut objc2_web_kit::WKWebView).as_ref() {
                    native::run_print(webview, None);
                }
            }
        })
        .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = wv;
        Err("Printing is only supported on macOS".into())
    }
}

/// Save the tab's current document to `~/Downloads` with the tab's cookies.
#[tauri::command]
pub fn browser_save_page(app: tauri::AppHandle, label: String) -> Result<(), String> {
    let wv = app.get_webview(&label).ok_or_else(|| format!("browser webview '{label}' not found"))?;
    let url = crate::webview_current_url(&wv).unwrap_or_default();
    if !saveable_url(&url) {
        return Err("This page can't be saved from here".into());
    }
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        let app_for_save = app.clone();
        wv.with_webview(move |pw| {
            // SAFETY: `with_webview` runs on the main thread; `inner()` is the live WKWebView.
            let result = unsafe {
                match (pw.inner() as *mut objc2_web_kit::WKWebView).as_ref() {
                    Some(webview) => native::start_save(webview, app_for_save, label, url),
                    None => Err("The tab closed".to_string()),
                }
            };
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;
        rx.recv_timeout(std::time::Duration::from_secs(2)).map_err(|_| "The save did not start".to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, label);
        Err("Saving pages is only supported on macOS".into())
    }
}

/// Only a document with a real, re-requestable address can be saved this way.
fn saveable_url(url: &str) -> bool {
    tauri::Url::parse(url).is_ok_and(|u| matches!(u.scheme(), "http" | "https" | "file"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destination_is_sanitized_and_never_clobbers() {
        let dir = std::env::temp_dir().join(format!("rl-dl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // Traversal in a server-suggested name stays inside the directory.
        assert_eq!(destination_for(&dir, "../../etc/passwd", "https://x.test/a"), dir.join("passwd"));
        // An unusable suggestion falls back to the URL's last segment.
        assert_eq!(destination_for(&dir, "..", "https://x.test/files/paper.pdf?dl=1"), dir.join("paper.pdf"));
        // A repeat download gets a numbered sibling instead of overwriting.
        std::fs::write(dir.join("paper.pdf"), b"x").unwrap();
        assert_eq!(destination_for(&dir, "paper.pdf", "https://x.test/paper.pdf"), dir.join("paper (1).pdf"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn finished_pairs_with_the_requested_destination() {
        remember("browser-a", "https://x.test/f.zip", PathBuf::from("/tmp/f.zip"));
        remember("browser-b", "https://x.test/f.zip", PathBuf::from("/tmp/f (1).zip"));
        assert_eq!(take("browser-b", "https://x.test/f.zip"), Some(PathBuf::from("/tmp/f (1).zip")));
        assert_eq!(take("browser-a", "https://x.test/f.zip"), Some(PathBuf::from("/tmp/f.zip")));
        assert_eq!(take("browser-a", "https://x.test/f.zip"), None);
    }

    #[test]
    fn only_addressable_documents_save() {
        assert!(saveable_url("https://arxiv.org/pdf/2401.00001"));
        assert!(saveable_url("file:///Users/me/x.pdf"));
        assert!(!saveable_url("blob:https://x.test/3f2a"));
        assert!(!saveable_url("about:blank"));
        assert!(!saveable_url(""));
    }
}
