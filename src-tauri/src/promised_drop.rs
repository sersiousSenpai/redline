// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Turns file-promise drags onto the main webview into real files.
//!
//! A screenshot's floating thumbnail doesn't exist on disk yet. Its drag
//! carries an `NSFilePromise` ("I will write it wherever you tell me") rather
//! than a file URL, and an image dragged out of Preview or a browser often
//! carries only the image bytes. wry reads nothing but
//! `NSFilenamesPboardType`, so such a drop reached the frontend as a `drop`
//! with no paths, every target ignored it, and a screenshot had to settle on
//! the desktop before it could be dragged in.
//!
//! This module wraps `performDragOperation:` on wry's webview class. For the
//! main webview only, a drag from another app that carries no file paths is
//! still handed to wry first (its empty `drop` ends every hover), and then:
//!
//! - its promises are received into `<cache>/drops/<millis>/`, and once every
//!   promised file has landed (or `PROMISE_TIMEOUT` passes with at least one
//!   in) the paths go to the frontend as `PROMISED_DROP_EVENT`, positioned
//!   where the drop happened, so the drop router (src/lib/nativeFileDrop.ts)
//!   treats them like any other drop. A drop with nothing in by then delivers
//!   its first file when it lands, up to `LATE_LIMIT` later, and never after;
//! - with no promise, PNG or TIFF image data is written there as a PNG.
//!
//! Everything else (browser tabs, ordinary file drops, drags that start
//! inside Redline) runs wry's method untouched, and any failure to install
//! logs and leaves drops exactly as they were.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::Manager;

/// The frontend's `PROMISED_DROP_EVENT`.
pub const PROMISED_DROP_EVENT: &str = "redline://promised-drop";
/// How long a drop waits for its promised files before delivering what it has.
const PROMISE_TIMEOUT: Duration = Duration::from_secs(5);
/// How long past that a drop that had landed nothing still delivers its first
/// file. Later, the layout and the user have moved on: the path would be typed
/// into whatever sits under the old drop point now, a half-typed command line
/// included.
const LATE_LIMIT: Duration = Duration::from_secs(15);
/// Drop copies older than this are swept at startup. They only have to live
/// as long as whatever they were dropped on takes to read them.
const DROP_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
/// What a drop that carried only image data is saved as.
const IMAGE_NAME: &str = "image.png";

/// `PROMISED_DROP_EVENT`'s payload. `position` is in the logical,
/// top-left-origin points wry gives Tauri's own drop event.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PromisedDrop {
    pub paths: Vec<String>,
    pub position: DropPosition,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct DropPosition {
    pub x: i32,
    pub y: i32,
}

impl PromisedDrop {
    fn new(paths: Vec<PathBuf>, position: DropPosition) -> Self {
        let paths = paths
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        Self { paths, position }
    }
}

/// One drop's promised files, settling one at a time on the receiver's queue.
/// The count is only known once the promises have been called in, and a fast
/// writer can land a file before that, so both orders have to complete.
#[derive(Debug, Default)]
struct Arrivals {
    expected: Option<usize>,
    settled: usize,
    paths: Vec<PathBuf>,
    /// The deadline passed before anything landed: the first file that does
    /// is delivered on its own rather than waiting for the rest.
    overdue: bool,
    delivered: bool,
}

impl Arrivals {
    /// How many files the promises cover. Returns the paths to deliver if they
    /// have all settled already.
    fn expect(&mut self, count: usize) -> Option<Vec<PathBuf>> {
        self.expected = Some(count.max(1));
        self.complete()
    }

    /// A promised file was written (`Some`) or failed (`None`; a failed write
    /// still settles it). Returns the paths to deliver once the last has.
    fn settle(&mut self, path: Option<PathBuf>) -> Option<Vec<PathBuf>> {
        if self.delivered {
            return None;
        }
        self.settled += 1;
        self.paths.extend(path);
        if self.overdue && !self.paths.is_empty() {
            return self.deliver();
        }
        self.complete()
    }

    /// The deadline passed: deliver whatever arrived, unless that happened.
    /// A slow source that has landed nothing yet (a photo still coming down
    /// from iCloud) is not given up on: its first file goes out when it lands.
    fn expire(&mut self) -> Option<Vec<PathBuf>> {
        if self.delivered {
            return None;
        }
        if self.paths.is_empty() {
            self.overdue = true;
            return None;
        }
        self.deliver()
    }

    /// The late limit passed: nothing that lands from now on is delivered.
    /// True when the drop was still waiting for its first file.
    fn abandon(&mut self) -> bool {
        !std::mem::replace(&mut self.delivered, true)
    }

    fn complete(&mut self) -> Option<Vec<PathBuf>> {
        match self.expected {
            Some(expected) if !self.delivered && self.settled >= expected => self.deliver(),
            _ => None,
        }
    }

    fn deliver(&mut self) -> Option<Vec<PathBuf>> {
        self.delivered = true;
        (!self.paths.is_empty()).then(|| std::mem::take(&mut self.paths))
    }
}

/// A new, empty `<root>/<millis>` for one drop. Two drops in the same
/// millisecond take the next free number instead of sharing a folder.
fn fresh_drop_dir(root: &Path, now_ms: u64) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(root)?;
    for stamp in now_ms..now_ms + 1_000 {
        let dir = root.join(stamp.to_string());
        match std::fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(ErrorKind::AlreadyExists.into())
}

/// Remove the drop folders older than `DROP_MAX_AGE`, judged by the stamp
/// each was named with. Anything not named that way isn't ours to delete.
fn prune_drops(root: &Path, now_ms: u64) -> usize {
    let Ok(entries) = std::fs::read_dir(root) else {
        return 0;
    };
    let max_age = DROP_MAX_AGE.as_millis() as u64;
    entries
        .flatten()
        .filter(|entry| {
            let stamp = entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<u64>().ok());
            matches!(stamp, Some(ms) if now_ms.saturating_sub(ms) > max_age)
                && std::fs::remove_dir_all(entry.path()).is_ok()
        })
        .count()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `<cache>/drops`. A probe keeps it under its disposable data directory, so
/// it never writes into the user's cache.
fn drops_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    match crate::runtime_profile::current().data_dir_override() {
        Some(dir) => Some(dir.join("cache").join("drops")),
        None => app.path().app_cache_dir().ok().map(|dir| dir.join("drops")),
    }
}

/// Hook the main webview's drops and sweep old drop copies. Call once from
/// setup, after the main window exists.
pub fn install(app: &tauri::AppHandle) {
    let Some(root) = drops_root(app) else {
        tracing::warn!("promised_drop: no cache directory; screenshot drags stay unresolved");
        return;
    };
    let sweep = root.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let removed = prune_drops(&sweep, now_ms());
        if removed > 0 {
            tracing::debug!(removed, "promised_drop: swept old drop copies");
        }
    });
    let Some(webview) = app.get_webview("main") else {
        tracing::warn!("promised_drop: no main webview; screenshot drags stay unresolved");
        return;
    };
    let app = app.clone();
    if let Err(error) =
        webview.with_webview(move |platform| native::install(platform.inner(), app, root))
    {
        tracing::warn!(%error, "promised_drop: could not reach the main webview");
    }
}

mod native {
    use super::*;
    use std::ffi::c_void;
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::ptr::NonNull;
    use std::sync::{Arc, Mutex, OnceLock};

    use block2::RcBlock;
    use objc2::rc::{autoreleasepool, Retained};
    use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, ProtocolObject, Sel};
    use objc2::{sel, ClassType};
    #[allow(deprecated)]
    use objc2_app_kit::NSFilenamesPboardType;
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSDraggingInfo, NSFilePromiseReceiver,
        NSPasteboard, NSPasteboardTypePNG, NSPasteboardTypeTIFF, NSView,
    };
    use objc2_foundation::{
        MainThreadMarker, NSArray, NSData, NSDictionary, NSError, NSOperationQueue,
        NSQualityOfService, NSString, NSURL,
    };
    use tauri::Emitter;

    /// `-(BOOL)performDragOperation:(id<NSDraggingInfo>)sender`, as an IMP.
    type PerformDrag = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> Bool;

    struct Hook {
        /// The main webview's address: every other WryWebView passes through.
        main: usize,
        /// wry's own implementation, called for every drop.
        original: PerformDrag,
        app: tauri::AppHandle,
        root: PathBuf,
        /// One queue for every drop's promise reads, alive for the app's life,
        /// so nothing has to keep a per-drop queue alive until its reads end.
        queue: Retained<NSOperationQueue>,
    }

    /// Set once, before the swap, and read by the replacement method.
    static HOOK: OnceLock<Hook> = OnceLock::new();

    pub(super) fn install(view: *mut c_void, app: tauri::AppHandle, root: PathBuf) {
        if MainThreadMarker::new().is_none() {
            return;
        }
        // SAFETY: with_webview runs on AppKit's main thread, and the handle is
        // the main webview, a WKWebView subclass and so an NSView.
        let Some(view) = (unsafe { (view as *const NSView).as_ref() }) else {
            return;
        };
        let perform = sel!(performDragOperation:);
        // Found through the instance, not by name: objc2 names a class
        // `<module path>::WryWebView<crate version>` unless told otherwise.
        let Some(class) = defining_class(view.as_ref(), perform) else {
            tracing::warn!(
                "promised_drop: nothing on the webview class implements performDragOperation:"
            );
            return;
        };
        let name = class.name().to_string_lossy().into_owned();
        // Never swap WebKit's own method: that would reach every WKWebView.
        if !name.contains("WryWebView") {
            tracing::warn!(class = %name, "promised_drop: performDragOperation: is not wry's; leaving drops alone");
            return;
        }
        let Some(method) = class.instance_method(perform) else {
            return;
        };
        // SAFETY: wry declares this method with exactly `PerformDrag`'s
        // signature, and `Imp` is only its type-erased form.
        let original = unsafe { std::mem::transmute::<Imp, PerformDrag>(method.implementation()) };
        let queue = NSOperationQueue::new();
        queue.setName(Some(&NSString::from_str("Redline promised drops")));
        // Someone is waiting to see the path appear at their prompt.
        queue.setQualityOfService(NSQualityOfService::UserInitiated);
        let hook = Hook {
            main: view as *const NSView as usize,
            original,
            app,
            root,
            queue,
        };
        if HOOK.set(hook).is_err() {
            return;
        }
        // SAFETY: the replacement has the same signature, and it calls the
        // original for every drop, so nothing wry did before is lost.
        unsafe {
            method.set_implementation(std::mem::transmute::<PerformDrag, Imp>(
                perform_drag_operation,
            ))
        };

        // Accept promise-only drags explicitly. WebKit registers most of these
        // types already; this is a union, never a replacement.
        let mut types = view.registeredDraggedTypes().to_vec();
        for promised in NSFilePromiseReceiver::readableDraggedTypes().to_vec() {
            if !types.contains(&promised) {
                types.push(promised);
            }
        }
        view.registerForDraggedTypes(&NSArray::from_retained_slice(&types));
        tracing::info!(class = %name, "promised_drop: resolving file promises dropped on the main webview");
    }

    /// The class on `object`'s chain that itself implements `sel`: wry's
    /// webview class, even with a KVO subclass slipped in front of it.
    fn defining_class(object: &AnyObject, sel: Sel) -> Option<&'static AnyClass> {
        let mut class = Some(object.class());
        while let Some(current) = class {
            if current
                .instance_methods()
                .iter()
                .any(|method| method.name() == sel)
            {
                return Some(current);
            }
            class = current.superclass();
        }
        None
    }

    /// The replacement `performDragOperation:`.
    unsafe extern "C-unwind" fn perform_drag_operation(
        this: *mut AnyObject,
        cmd: Sel,
        sender: *mut AnyObject,
    ) -> Bool {
        let Some(hook) = HOOK.get() else {
            return Bool::NO;
        };
        if this as usize != hook.main || sender.is_null() {
            return unsafe { (hook.original)(this, cmd, sender) };
        }
        // SAFETY: AppKit calls this on the main thread with the view itself
        // and its dragging info, both live for the duration of the call.
        let (view, info) = unsafe {
            (
                &*(this as *const NSView),
                &*(sender as *const ProtocolObject<dyn NSDraggingInfo>),
            )
        };
        let pending = catch_unwind(AssertUnwindSafe(|| without_files(view, info)))
            .ok()
            .flatten();
        // wry first, always: for a promise its `drop` has no paths, which is
        // what ends every target's hover state.
        let handled = unsafe { (hook.original)(this, cmd, sender) };
        let Some((pasteboard, position)) = pending else {
            return handled;
        };
        match catch_unwind(AssertUnwindSafe(|| resolve(hook, &pasteboard, position))) {
            Ok(true) => Bool::YES,
            _ => handled,
        }
    }

    /// A drag wry would hand over without paths: from another app, carrying
    /// no file names. Returns its pasteboard and the drop point, computed
    /// exactly as wry computes the position of its own drop event.
    fn without_files(
        view: &NSView,
        info: &ProtocolObject<dyn NSDraggingInfo>,
    ) -> Option<(Retained<NSPasteboard>, DropPosition)> {
        // In-app drags (a selection, an image inside Redline) stay as they were.
        if info.draggingSource().is_some() {
            return None;
        }
        let pasteboard = info.draggingPasteboard();
        #[allow(deprecated)]
        let files = NSArray::from_slice(&[unsafe { NSFilenamesPboardType }]);
        if pasteboard.availableTypeFromArray(&files).is_some() {
            return None;
        }
        let at = info.draggingLocation();
        let position = DropPosition {
            x: at.x as i32,
            y: (view.frame().size.height - at.y) as i32,
        };
        Some((pasteboard, position))
    }

    /// Start turning what the drag carried into files. False when it carried
    /// nothing that could become one.
    fn resolve(hook: &'static Hook, pasteboard: &NSPasteboard, position: DropPosition) -> bool {
        let classes = NSArray::<AnyClass>::from_slice(&[NSFilePromiseReceiver::class()]);
        // SAFETY: `NSFilePromiseReceiver` implements `NSPasteboardReading`,
        // and no options is the documented default.
        let receivers: Vec<Retained<NSFilePromiseReceiver>> =
            unsafe { pasteboard.readObjectsForClasses_options(&classes, None) }
                .map(|found| {
                    found
                        .iter()
                        .filter_map(|item| item.downcast::<NSFilePromiseReceiver>().ok())
                        .collect()
                })
                .unwrap_or_default();
        if !receivers.is_empty() {
            receive(hook, &receivers, position);
            return true;
        }
        let png = unsafe { NSPasteboardTypePNG };
        let image_types = NSArray::from_slice(&[png, unsafe { NSPasteboardTypeTIFF }]);
        let Some(kind) = pasteboard.availableTypeFromArray(&image_types) else {
            return false;
        };
        let Some(data) = pasteboard.dataForType(&kind) else {
            return false;
        };
        // Copy the bytes while the pasteboard is ours; no Objective-C object
        // crosses to the worker.
        let (bytes, is_png) = (data.to_vec(), kind.isEqualToString(png));
        tauri::async_runtime::spawn_blocking(move || write_image(hook, bytes, is_png, position));
        true
    }

    /// Call in every promise to one fresh folder and deliver the files once
    /// they have all landed, or whatever landed when the deadline passes.
    fn receive(
        hook: &'static Hook,
        receivers: &[Retained<NSFilePromiseReceiver>],
        position: DropPosition,
    ) {
        let dir = match fresh_drop_dir(&hook.root, now_ms()) {
            Ok(dir) => dir,
            Err(error) => {
                tracing::warn!(%error, "promised_drop: could not make a folder for the drop");
                return;
            }
        };
        let arrivals = Arc::new(Mutex::new(Arrivals::default()));
        let reading = Arc::clone(&arrivals);
        let reader = RcBlock::new(move |url: NonNull<NSURL>, error: *mut NSError| {
            let _ = catch_unwind(AssertUnwindSafe(|| {
                // SAFETY: the receiver passes a live URL, to be ignored when
                // it also passes an error.
                let path = if error.is_null() {
                    unsafe { url.as_ref() }
                        .path()
                        .map(|path| PathBuf::from(path.to_string()))
                } else {
                    let reason = unsafe { &*error }.localizedDescription().to_string();
                    tracing::warn!(%reason, "promised_drop: a promised file was not written");
                    None
                };
                let ready = reading
                    .lock()
                    .ok()
                    .and_then(|mut arrivals| arrivals.settle(path));
                if let Some(paths) = ready {
                    deliver(hook, paths, position);
                }
            }));
        });
        let destination = NSURL::fileURLWithPath(&NSString::from_str(&dir.to_string_lossy()));
        let options = NSDictionary::new();
        for receiver in receivers {
            // SAFETY: called in performDragOperation:, the one place promises
            // may be called in. The receiver copies the reader block.
            unsafe {
                receiver.receivePromisedFilesAtDestination_options_operationQueue_reader(
                    &destination,
                    &options,
                    &hook.queue,
                    &reader,
                )
            };
        }
        // `fileNames` is only filled in once the promise has been called in,
        // and `fileTypes` may list a type once for several files: take the
        // larger of the two.
        let count = receivers
            .iter()
            .map(|r| r.fileNames().count().max(r.fileTypes().count()).max(1))
            .sum();
        let ready = arrivals
            .lock()
            .ok()
            .and_then(|mut arrivals| arrivals.expect(count));
        if let Some(paths) = ready {
            deliver(hook, paths, position);
        }
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(PROMISE_TIMEOUT).await;
            let late = arrivals
                .lock()
                .ok()
                .and_then(|mut arrivals| arrivals.expire());
            if let Some(paths) = late {
                tracing::warn!(
                    files = paths.len(),
                    "promised_drop: delivered what arrived before the deadline"
                );
                deliver(hook, paths, position);
            }
            tokio::time::sleep(LATE_LIMIT).await;
            if arrivals.lock().is_ok_and(|mut arrivals| arrivals.abandon()) {
                tracing::warn!("promised_drop: gave up on a drop whose files never landed");
            }
        });
    }

    /// Save image bytes dragged without a file as a PNG, then deliver it.
    fn write_image(hook: &Hook, bytes: Vec<u8>, is_png: bool, position: DropPosition) {
        let png = if is_png {
            Some(bytes)
        } else {
            autoreleasepool(|_| tiff_to_png(&bytes))
        };
        let Some(png) = png else {
            tracing::warn!("promised_drop: the dropped image could not be read");
            return;
        };
        let file = match fresh_drop_dir(&hook.root, now_ms()) {
            Ok(dir) => dir.join(IMAGE_NAME),
            Err(error) => {
                tracing::warn!(%error, "promised_drop: could not make a folder for the drop");
                return;
            }
        };
        if let Err(error) = std::fs::write(&file, png) {
            tracing::warn!(%error, "promised_drop: could not save the dropped image");
            return;
        }
        deliver(hook, vec![file], position);
    }

    fn tiff_to_png(tiff: &[u8]) -> Option<Vec<u8>> {
        let rep = NSBitmapImageRep::imageRepWithData(&NSData::with_bytes(tiff))?;
        // SAFETY: an empty properties dictionary asks for the defaults.
        unsafe {
            rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
        }
        .map(|png| png.to_vec())
    }

    fn deliver(hook: &Hook, paths: Vec<PathBuf>, position: DropPosition) {
        let drop = PromisedDrop::new(paths, position);
        if let Err(error) = hook.app.emit_to("main", PROMISED_DROP_EVENT, &drop) {
            tracing::warn!(%error, "promised_drop: could not deliver the drop");
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use objc2::runtime::NSObject;
        use objc2::{define_class, msg_send};

        define_class!(
            #[unsafe(super(NSObject))]
            #[name = "RedlinePromisedDropTestView"]
            struct TestView;
            impl TestView {
                #[unsafe(method(performDragOperation:))]
                fn perform_drag_operation(&self, _sender: *mut AnyObject) -> Bool {
                    Bool::YES
                }
            }
        );

        // Stands in for the subclass KVO slips in front of an observed view:
        // it inherits the method without implementing it.
        define_class!(
            #[unsafe(super(TestView))]
            #[name = "RedlinePromisedDropTestObserved"]
            struct ObservedTestView;
        );

        #[test]
        fn finds_the_class_that_implements_the_method_behind_a_subclass() {
            let observed: Retained<ObservedTestView> =
                unsafe { msg_send![ObservedTestView::class(), new] };
            let found = defining_class(&observed, sel!(performDragOperation:)).unwrap();
            assert_eq!(found.name(), c"RedlinePromisedDropTestView");
            assert!(defining_class(&NSObject::new(), sel!(performDragOperation:)).is_none());
        }

        /// A 1×1 RGBA PNG.
        const ONE_PIXEL_PNG: &[u8] = &[
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0xf0, 0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99,
            0x3d, 0x1d, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
        ];

        #[test]
        fn tiff_image_data_is_saved_as_png() {
            autoreleasepool(|_| {
                let rep =
                    NSBitmapImageRep::imageRepWithData(&NSData::with_bytes(ONE_PIXEL_PNG)).unwrap();
                let tiff = rep.TIFFRepresentation().unwrap().to_vec();
                assert!(
                    tiff.starts_with(b"MM\0*") || tiff.starts_with(b"II*\0"),
                    "fixture is not a TIFF"
                );
                let png = tiff_to_png(&tiff).unwrap();
                assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
                assert!(tiff_to_png(b"not an image").is_none());
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("rl-drops-{tag}-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn delivers_once_every_promised_file_has_landed() {
        let mut arrivals = Arrivals::default();
        assert_eq!(arrivals.expect(2), None);
        assert_eq!(arrivals.settle(Some("/d/a.png".into())), None);
        assert_eq!(
            arrivals.settle(Some("/d/b.png".into())),
            Some(vec!["/d/a.png".into(), "/d/b.png".into()])
        );
        // Nothing is delivered twice: not by a straggler, not by the deadline.
        assert_eq!(arrivals.settle(Some("/d/c.png".into())), None);
        assert_eq!(arrivals.expire(), None);
    }

    #[test]
    fn files_that_land_before_the_count_is_known_still_complete_the_drop() {
        let mut arrivals = Arrivals::default();
        assert_eq!(arrivals.settle(Some("/d/a.png".into())), None);
        assert_eq!(arrivals.expect(1), Some(vec!["/d/a.png".into()]));
        assert_eq!(arrivals.expire(), None);
    }

    #[test]
    fn a_failed_write_settles_its_file_without_a_path() {
        let mut arrivals = Arrivals::default();
        arrivals.expect(2);
        assert_eq!(arrivals.settle(None), None);
        assert_eq!(
            arrivals.settle(Some("/d/b.png".into())),
            Some(vec!["/d/b.png".into()])
        );
    }

    #[test]
    fn a_drop_whose_every_file_failed_delivers_nothing() {
        let mut arrivals = Arrivals::default();
        arrivals.expect(1);
        assert_eq!(arrivals.settle(None), None);
        assert_eq!(arrivals.expire(), None);
    }

    #[test]
    fn the_deadline_delivers_what_arrived_and_nothing_after_it() {
        let mut arrivals = Arrivals::default();
        arrivals.expect(3);
        arrivals.settle(Some("/d/a.png".into()));
        assert_eq!(arrivals.expire(), Some(vec!["/d/a.png".into()]));
        assert_eq!(arrivals.settle(Some("/d/b.png".into())), None);
        assert_eq!(arrivals.settle(Some("/d/c.png".into())), None);
        assert_eq!(arrivals.expire(), None);
    }

    #[test]
    fn a_drop_with_nothing_landed_by_the_deadline_delivers_its_first_file_when_it_lands() {
        let mut arrivals = Arrivals::default();
        arrivals.expect(3);
        assert_eq!(arrivals.expire(), None);
        // A failure is still nothing to deliver.
        assert_eq!(arrivals.settle(None), None);
        assert_eq!(
            arrivals.settle(Some("/d/a.png".into())),
            Some(vec!["/d/a.png".into()])
        );
        assert_eq!(arrivals.settle(Some("/d/b.png".into())), None);
        assert_eq!(arrivals.expire(), None);
    }

    #[test]
    fn a_file_landing_past_the_late_limit_is_never_delivered() {
        let mut arrivals = Arrivals::default();
        arrivals.expect(1);
        assert_eq!(arrivals.expire(), None);
        assert!(arrivals.abandon(), "the drop was still waiting");
        assert_eq!(arrivals.settle(Some("/d/a.png".into())), None);
        // A drop that already delivered has nothing left to give up on.
        let mut done = Arrivals::default();
        done.expect(1);
        assert_eq!(done.settle(Some("/d/a.png".into())), Some(vec!["/d/a.png".into()]));
        assert!(!done.abandon());
    }

    #[test]
    fn a_drop_that_fails_after_the_deadline_delivers_nothing() {
        let mut arrivals = Arrivals::default();
        arrivals.expect(1);
        assert_eq!(arrivals.expire(), None);
        assert_eq!(arrivals.settle(None), None);
        assert_eq!(arrivals.expire(), None);
    }

    #[test]
    fn a_count_of_zero_still_waits_for_one_file() {
        let mut arrivals = Arrivals::default();
        assert_eq!(arrivals.expect(0), None);
        assert_eq!(
            arrivals.settle(Some("/d/a.png".into())),
            Some(vec!["/d/a.png".into()])
        );
    }

    #[test]
    fn the_event_payload_is_what_the_frontend_router_reads() {
        let drop = PromisedDrop::new(
            vec!["/cache/drops/1/Screenshot 1.png".into()],
            DropPosition { x: 120, y: 48 },
        );
        assert_eq!(
            serde_json::to_value(&drop).unwrap(),
            serde_json::json!({ "paths": ["/cache/drops/1/Screenshot 1.png"], "position": { "x": 120, "y": 48 } })
        );
        let ts = include_str!("../../src/lib/nativeFileDrop.ts");
        assert!(
            ts.contains(&format!("PROMISED_DROP_EVENT = \"{PROMISED_DROP_EVENT}\"")),
            "the frontend listens for a different event name"
        );
    }

    #[test]
    fn each_drop_gets_its_own_folder_even_within_one_millisecond() {
        let root = temp_root("fresh");
        let first = fresh_drop_dir(&root, 1_000).unwrap();
        let second = fresh_drop_dir(&root, 1_000).unwrap();
        assert_eq!(first, root.join("1000"));
        assert_eq!(second, root.join("1001"));
        assert!(first.is_dir() && second.is_dir());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn startup_sweep_removes_only_stale_drop_folders() {
        let root = temp_root("prune");
        let now = 10 * DROP_MAX_AGE.as_millis() as u64;
        let day = DROP_MAX_AGE.as_millis() as u64;
        for stamp in [now - day - 1, now - day + 1, now] {
            let dir = root.join(stamp.to_string());
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("Screenshot.png"), b"png").unwrap();
        }
        std::fs::create_dir_all(root.join("not-a-drop")).unwrap();
        assert_eq!(prune_drops(&root, now), 1);
        assert!(!root.join((now - day - 1).to_string()).exists());
        assert!(root.join((now - day + 1).to_string()).exists());
        assert!(root.join(now.to_string()).exists());
        assert!(root.join("not-a-drop").exists());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn startup_sweep_of_a_missing_folder_is_a_no_op() {
        assert_eq!(prune_drops(&temp_root("missing"), now_ms()), 0);
    }
}
