// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Page thumbnails for the Localhost dashboard.
//!
//! A card wants a picture of what its dev server is actually serving. WebKit
//! can produce one — `takeSnapshotWithConfiguration:completionHandler:` renders
//! the live webview into an `NSImage` — but only for a webview that is really on
//! screen: a hidden `NSView` snapshots blank. That constraint shapes the whole
//! feature, and it is the frontend that carries it (one webview is parked
//! exactly over each card's thumb rect in turn, so the user watches the page
//! load in-card and freeze). This module is the narrow native half: given a
//! label and a key, snapshot that webview and leave a PNG on disk.
//!
//! Files live in `app_data_dir()/thumbs`, beside `redline.db` — the durable
//! per-user store, so thumbnails survive a restart and a card for a server that
//! is currently down still shows what it looked like. They are delivered to the
//! UI through the existing `read_file_base64` command; Tauri's asset protocol is
//! not enabled and turning it on for this would widen the app's surface for one
//! picture.
//!
//! The typed-objc2 patterns here mirror `browser_popup.rs` (the other module
//! that reaches the real WKWebView) and the block2 → tokio-oneshot bridge in
//! `lib.rs::eval_with_result`. macOS-only; every command's non-mac arm returns
//! the standard "only supported on macOS" error and the frontend falls back to
//! placeholders.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Bounds on the requested snapshot width. The low end keeps a degenerate rect
/// from asking WebKit for a 1px render; the high end caps what a very wide
/// window could otherwise turn into multi-megabyte PNGs, one per card.
const MIN_WIDTH: f64 = 64.0;
const MAX_WIDTH: f64 = 1200.0;

/// How long a capture may take before we give up on it. WKWebView's completion
/// handler is normally near-instant, but a page that never finishes compositing
/// could otherwise strand the queue forever.
const CAPTURE_TIMEOUT_SECS: u64 = 10;

/// `.tmp` files younger than this are assumed to belong to a capture in flight.
/// Older ones are leftovers from a crash and get swept.
const TMP_GRACE_SECS: u64 = 60;

/// How long to wait before re-taking a snapshot that came back blank.
const BLANK_RETRY_MS: u64 = 150;

/// The result of one capture.
///
/// `pixel_width`/`pixel_height` are the PNG's REAL dimensions, and they are
/// returned rather than assumed for a specific reason: WebKit documents
/// `snapshotWidth` as points and backs the image at the display's scale, so
/// whether a request for 280 yields a 280px or a 560px image is a property of
/// the running system, not something to hardcode. The frontend divides these by
/// what it asked for and calibrates itself — no guessing, and no way to end up
/// silently writing 4×-oversized files.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThumbShot {
    pub path: String,
    pub pixel_width: u32,
    pub pixel_height: u32,
}

/// One thumbnail on disk.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThumbEntry {
    pub key: String,
    pub path: String,
    /// Modification time in epoch millis. This — not a database column — is the
    /// source of truth for staleness: it is written by the act of capturing, so
    /// it cannot drift from the file, and it survives restarts for free.
    pub modified_ms: i64,
}

/// Whether a frontend-supplied key is safe to use as a filename.
///
/// The keys are computed in `src/lib/thumbs.ts`, but "the caller is ours" is not
/// a security property — this is a path built from an argument, so it is
/// validated here as if it were hostile. Restricting to `[A-Za-z0-9._-]` with no
/// leading dot and no `..` leaves no way to escape the thumbs directory: no
/// separators, no parent refs, no hidden files.
pub fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 128
        && !key.starts_with('.')
        && !key.contains("..")
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

/// `app_data_dir()/thumbs`, created on demand.
fn thumbs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve the app data dir: {e}"))?
        .join("thumbs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(dir)
}

fn modified_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Snapshot a browser webview and write it to `<key>.png`, returning the path.
///
/// `width` is the requested snapshot width. WebKit does the downscaling itself,
/// so we never hand a full-resolution image to Rust only to shrink it.
///
/// The write is atomic — `<key>.png.tmp` then `rename` — because the frontend
/// reads these files through `read_file_base64` on its own schedule, and a
/// half-written PNG decoded into an `<img>` is a visible broken card.
#[tauri::command(async)]
pub async fn browser_take_thumbnail(
    app: AppHandle,
    label: String,
    key: String,
    width: f64,
) -> Result<ThumbShot, String> {
    if !valid_key(&key) {
        return Err(format!("invalid thumbnail key: {key}"));
    }
    let dir = thumbs_dir(&app)?;
    let final_path = dir.join(format!("{key}.png"));
    let tmp_path = dir.join(format!("{key}.png.tmp"));
    let width = width.clamp(MIN_WIDTH, MAX_WIDTH);

    let mut shot = capture_png(&app, &label, width).await?;
    // A snapshot taken a beat too early is a blank frame — the page has
    // committed but not yet painted. Rather than pay a fixed delay on EVERY
    // capture for something that may never happen, notice the blank and take
    // one more. Keeping whichever is larger means the retry can only improve
    // things: if the second is also blank (a genuinely empty page), the first
    // still stands.
    if looks_blank(&shot.0, width) {
        tokio::time::sleep(std::time::Duration::from_millis(BLANK_RETRY_MS)).await;
        if let Ok(second) = capture_png(&app, &label, width).await {
            if second.0.len() > shot.0.len() {
                shot = second;
            }
        }
    }
    let (bytes, pixel_width, pixel_height) = shot;
    if bytes.is_empty() {
        return Err("the page produced an empty snapshot".into());
    }
    std::fs::write(&tmp_path, &bytes).map_err(|e| format!("{}: {e}", tmp_path.display()))?;
    std::fs::rename(&tmp_path, &final_path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        format!("{}: {e}", final_path.display())
    })?;
    Ok(ThumbShot {
        path: final_path.to_string_lossy().into_owned(),
        pixel_width,
        pixel_height,
    })
}

/// Is this PNG almost certainly a blank frame?
///
/// A uniform image is exactly what PNG compresses best, so a real screenshot and
/// an empty one differ by an order of magnitude in size — no pixel inspection
/// needed. The floor scales with the requested width so a small thumbnail isn't
/// judged by a large one's yardstick. A false positive costs one extra capture
/// and nothing else, so the threshold is deliberately generous.
pub fn looks_blank(png: &[u8], width: f64) -> bool {
    let floor = (width.max(MIN_WIDTH) * 6.0) as usize;
    png.len() < floor
}

/// PNG bytes plus the image's real pixel dimensions.
type Shot = (Vec<u8>, u32, u32);

#[cfg(target_os = "macos")]
async fn capture_png(app: &AppHandle, label: &str, width: f64) -> Result<Shot, String> {
    use std::sync::{Arc, Mutex};

    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{MainThreadMarker, NSDictionary, NSError, NSNumber};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

    let wv = app
        .get_webview(label)
        .ok_or_else(|| format!("browser webview '{label}' not found"))?;
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Shot, String>>();
    let tx = Arc::new(Mutex::new(Some(tx)));
    let tx_cb = tx.clone();

    wv.with_webview(move |pw| {
        // SAFETY: `with_webview` runs this closure on the UI thread, which IS
        // the main thread — the invariant `MainThreadMarker` stands for.
        let mtm = unsafe { MainThreadMarker::new_unchecked() };
        let ptr = pw.inner() as *mut WKWebView;
        // SAFETY: `inner()` hands back the live WKWebView for this label.
        let Some(webview) = (unsafe { ptr.as_ref() }) else {
            if let Some(s) = tx.lock().unwrap().take() {
                let _ = s.send(Err("browser webview gone".into()));
            }
            return;
        };
        // SAFETY: plain property setters on a freshly-allocated configuration.
        // `afterScreenUpdates` makes WebKit flush pending layout/paint before
        // the read, which is the difference between a real page and a blank or
        // half-laid-out one.
        let config = unsafe { WKSnapshotConfiguration::new(mtm) };
        unsafe {
            config.setSnapshotWidth(Some(&NSNumber::numberWithDouble(width)));
            config.setAfterScreenUpdates(true);
        }
        let handler = block2::RcBlock::new(
            move |image: *mut NSImage, _err: *mut NSError| {
                // SAFETY: WebKit invokes this on the main thread with either an
                // NSImage or null. Encoding round-trips through TIFF because
                // that keeps us on AppKit types we already depend on — a
                // CGImage path would mean a new core-graphics dependency to
                // save microseconds on a ~560px image.
                let out = unsafe {
                    image
                        .as_ref()
                        .and_then(|img| img.TIFFRepresentation())
                        .and_then(|tiff| NSBitmapImageRep::imageRepWithData(&tiff))
                        .and_then(|rep| {
                            // Read the dimensions off the REP, not the NSImage:
                            // the image's `size` is in points, the rep's is the
                            // actual pixel grid — which is exactly the number
                            // the frontend calibrates against.
                            let w = rep.pixelsWide().max(0) as u32;
                            let h = rep.pixelsHigh().max(0) as u32;
                            rep.representationUsingType_properties(
                                NSBitmapImageFileType::PNG,
                                &NSDictionary::new(),
                            )
                            .map(|png| (png.to_vec(), w, h))
                        })
                };
                if let Some(s) = tx_cb.lock().unwrap().take() {
                    let _ = s.send(
                        out.ok_or_else(|| "the page could not be rendered to an image".to_string()),
                    );
                }
            },
        );
        // SAFETY: runs on the UI thread; WKWebView copies the completion block,
        // so it outlives this `RcBlock` going out of scope at the end of the
        // closure (the same contract `eval_with_result` relies on).
        unsafe {
            webview.takeSnapshotWithConfiguration_completionHandler(Some(&config), &handler);
        }
    })
    .map_err(|e| e.to_string())?;

    match tokio::time::timeout(
        std::time::Duration::from_secs(CAPTURE_TIMEOUT_SECS),
        rx,
    )
    .await
    {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("the snapshot was cancelled".into()),
        Err(_) => Err("the page did not finish rendering in time".into()),
    }
}

#[cfg(not(target_os = "macos"))]
async fn capture_png(app: &AppHandle, label: &str, width: f64) -> Result<Shot, String> {
    let _ = (app, label, width);
    Err("page thumbnails are only supported on macOS".into())
}

/// Every thumbnail on disk, so the frontend can seed its cache at mount: a
/// still-fresh capture is not re-taken across restarts, and a card for a server
/// that is currently down shows its last picture immediately.
#[tauri::command(async)]
pub fn thumbs_list(app: AppHandle) -> Result<Vec<ThumbEntry>, String> {
    let dir = thumbs_dir(&app)?;
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(out);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(key) = name.strip_suffix(".png") else {
            continue;
        };
        if !valid_key(key) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        out.push(ThumbEntry {
            key: key.to_string(),
            path: path.to_string_lossy().into_owned(),
            modified_ms: modified_ms(&meta),
        });
    }
    Ok(out)
}

/// Delete thumbnails whose key is no longer on any card, plus `.tmp` leftovers
/// from a capture that crashed mid-write. Called at mount with the live key set,
/// so the directory tracks the dashboard instead of growing forever.
#[tauri::command(async)]
pub fn thumbs_prune(app: AppHandle, keep_keys: Vec<String>) -> Result<usize, String> {
    let dir = thumbs_dir(&app)?;
    let keep: std::collections::HashSet<&str> =
        keep_keys.iter().map(|k| k.as_str()).collect();
    let now = std::time::SystemTime::now();
    let mut removed = 0usize;
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(0);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let doomed = if let Some(key) = name.strip_suffix(".png") {
            !keep.contains(key)
        } else if name.ends_with(".png.tmp") {
            // Only sweep tmp files old enough to be certainly abandoned — a
            // capture in flight owns its tmp file.
            entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|m| now.duration_since(m).ok())
                .is_some_and(|age| age.as_secs() > TMP_GRACE_SECS)
        } else {
            false
        };
        if doomed && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blank_frame_is_told_apart_from_a_real_screenshot_by_size() {
        // A uniform image is what PNG compresses best — the orders of magnitude
        // here are what makes a byte-size check sufficient.
        assert!(looks_blank(&vec![0u8; 900], 560.0), "a ~1KB 560px PNG is blank");
        assert!(!looks_blank(&vec![0u8; 40_000], 560.0), "a real page is not");
        // The floor scales with the request, so a small thumb isn't judged by a
        // large one's yardstick.
        assert!(!looks_blank(&vec![0u8; 900], 64.0));
        assert!(looks_blank(&[], 560.0), "nothing at all is certainly blank");
    }

    #[test]
    fn valid_key_accepts_the_keys_the_frontend_mints() {
        // `thumbKey(projectPath, port)` in src/lib/thumbs.ts.
        assert!(valid_key("p5173-1a2b3c4d"));
        assert!(valid_key("p80-00000000"));
        assert!(valid_key("a.b_c-1"));
    }

    #[test]
    fn valid_key_refuses_every_way_out_of_the_directory() {
        for bad in [
            "",
            "..",
            "../etc/passwd",
            "a/../b",
            "a/b",
            "a\\b",
            "/abs",
            ".hidden",
            "with space",
            "semi;colon",
            "null\0byte",
            "uni¢ode",
        ] {
            assert!(!valid_key(bad), "{bad:?} must be rejected");
        }
        assert!(!valid_key(&"a".repeat(129)), "an unbounded key is rejected");
    }
}
