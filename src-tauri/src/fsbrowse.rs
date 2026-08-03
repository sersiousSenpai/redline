// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Read-only filesystem browsing for the project-folder explorer. The frontend
//! surfaces a terminal's live working directory (see `pty::pty_cwd`) as a
//! sidebar tab and lazily walks it one level at a time via `list_dir`, opening
//! individual files read-only through `read_text_file`.
//!
//! These commands read arbitrary paths the user points the explorer at. That is
//! acceptable: the app already spawns the user's login shell with full
//! privileges, so file browsing grants nothing the terminal didn't already.

use std::fs;
use std::path::Path;

use base64::Engine;
use serde::Serialize;

/// One entry in a directory listing. `path` is absolute so the frontend can
/// recurse without reconstructing it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// A file's contents, or a flag explaining why they were withheld. Exactly one
/// of `content` / `is_binary` / `too_large` is meaningful: text files return
/// `content`; binaries and oversized files return their flag with no content.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub content: Option<String>,
    pub is_binary: bool,
    pub too_large: bool,
    pub size: u64,
}

/// Files larger than this are not loaded into the viewer — the UI shows a
/// "too large" notice instead of locking up rendering a multi-megabyte string.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// List one directory level. Directories sort first, then case-insensitive by
/// name — the conventional file-explorer order. Entries whose metadata can't be
/// read (broken symlinks, races) are skipped rather than failing the whole list.
/// `(async)` keeps a slow directory read off the UI thread.
#[tauri::command(async)]
pub fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let read = fs::read_dir(&path).map_err(|e| format!("{path}: {e}"))?;
    let mut entries: Vec<DirEntry> = read
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let is_dir = entry.file_type().ok()?.is_dir();
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path().to_string_lossy().into_owned();
            Some(DirEntry { name, path, is_dir })
        })
        .collect();
    sort_entries(&mut entries);
    Ok(entries)
}

/// Directories first, then case-insensitive name — pulled out so it can be
/// unit-tested without touching the filesystem.
fn sort_entries(entries: &mut [DirEntry]) {
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

/// Read a file for the read-only viewer. Oversized files and binaries are
/// reported via flags instead of content so the UI can explain the omission.
/// `(async)` so reading + UTF-8 validating a couple of megabytes never blocks
/// the UI thread.
#[tauri::command(async)]
pub fn read_text_file(path: String) -> Result<FileContent, String> {
    let meta = fs::metadata(&path).map_err(|e| format!("{path}: {e}"))?;
    let size = meta.len();
    if size > MAX_FILE_BYTES {
        return Ok(FileContent {
            content: None,
            is_binary: false,
            too_large: true,
            size,
        });
    }
    let bytes = fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    // A NUL byte is the cheap, reliable "this isn't text" signal that editors
    // use; UTF-8 text never contains one.
    if bytes.contains(&0) {
        return Ok(FileContent {
            content: None,
            is_binary: true,
            too_large: false,
            size,
        });
    }
    match String::from_utf8(bytes) {
        Ok(content) => Ok(FileContent {
            content: Some(content),
            is_binary: false,
            too_large: false,
            size,
        }),
        // Non-UTF-8 (e.g. Latin-1, or truly binary without a NUL): treat as
        // binary rather than lossily mangling it in the viewer.
        Err(_) => Ok(FileContent {
            content: None,
            is_binary: true,
            too_large: false,
            size,
        }),
    }
}

/// Images can reasonably be larger than text files; cap higher so typical
/// screenshots and assets load, but still guard against multi-hundred-MB files.
const MAX_IMAGE_BYTES: u64 = 16 * 1024 * 1024;

/// A file's raw bytes, base64-encoded for the frontend to drop into a data URL
/// (e.g. image previews). `data` is withheld when the file exceeds the cap.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryFile {
    pub data: Option<String>,
    pub too_large: bool,
    pub size: u64,
}

/// Read a file as base64 — used by the viewer to show images (and any other
/// binary the UI knows how to render) inline without the asset protocol.
/// `(async)` so reading + base64-encoding up to 16 MB stays off the UI thread.
#[tauri::command(async)]
pub fn read_file_base64(path: String) -> Result<BinaryFile, String> {
    let meta = fs::metadata(&path).map_err(|e| format!("{path}: {e}"))?;
    let size = meta.len();
    if size > MAX_IMAGE_BYTES {
        return Ok(BinaryFile {
            data: None,
            too_large: true,
            size,
        });
    }
    let bytes = fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(BinaryFile {
        data: Some(data),
        too_large: false,
        size,
    })
}

/// Write UTF-8 text to a file, creating parent directories as needed. Used by
/// the in-app markdown note editor. Returns the absolute path written so the UI
/// can show it in a toast.
///
/// Like the read commands above, this trusts the path the user pointed the app
/// at — the app already runs the user's shell with full privileges, so writing
/// where they can already write grants nothing new. `(async)` keeps disk I/O off
/// the UI thread.
#[tauri::command(async)]
pub fn save_text_file(path: String, content: String) -> Result<String, String> {
    let p = Path::new(&path);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    fs::write(p, content).map_err(|e| format!("{path}: {e}"))?;
    Ok(p.to_string_lossy().into_owned())
}

// --- Comment attachments ----------------------------------------------------
// Files a reviewer attaches to feedback ("make it look like this" + a
// screenshot). They are COPIED into app data at capture time rather than
// referenced where they landed: submit can happen minutes or hours later, and a
// source the user has since moved, renamed, or emptied from the trash would
// break the payload silently — at exactly the moment Claude tries to read it.
// A paste has no source path at all (it is bytes on the clipboard), so it must
// be written somewhere regardless.

/// Attachments live at `<app_data_dir>/attachments/<session_id>/<name>`,
/// mirroring the existing `briefs/<session-id>/` layout.
const ATTACHMENTS_DIR: &str = "attachments";

/// Cap on a single attachment. Matches the image-read cap: big enough for any
/// screenshot or mock, small enough that a stray multi-hundred-MB file can't
/// quietly fill the app-data directory.
const MAX_ATTACHMENT_BYTES: u64 = 16 * 1024 * 1024;

/// A stored attachment, in exactly the shape the comment record keeps.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedAttachment {
    pub path: String,
    pub name: String,
    pub mime: String,
    pub bytes: u64,
}

/// Best-effort content type from the extension. Only used for the UI chip and
/// as a hint in the payload, so an unknown type degrades to the generic
/// `application/octet-stream` rather than failing the capture.
fn mime_for(name: &str) -> &'static str {
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "heic" => "image/heic",
        "pdf" => "application/pdf",
        "txt" | "log" => "text/plain",
        "md" => "text/markdown",
        "json" => "application/json",
        "csv" => "text/csv",
        _ => "application/octet-stream",
    }
}

/// Resolve (and create) this session's attachment directory.
///
/// `session_id` is sanitized to a bare basename before it becomes a path
/// component: it reaches here from the frontend, and a `../` in it would
/// otherwise escape the app-data root.
fn attachment_dir(
    app: &tauri::AppHandle,
    session_id: &str,
) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let sid = crate::sanitize_basename(session_id);
    if sid.is_empty() {
        return Err("invalid session id".to_string());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve the app data directory: {e}"))?
        .join(ATTACHMENTS_DIR)
        .join(sid);
    fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(dir)
}

/// Turn a proposed filename into a safe, non-colliding one inside `dir`.
/// `sanitize_basename` is the security boundary (it strips every path
/// separator, so nothing can land outside `dir`); `dedup_path` keeps a second
/// "Screenshot.png" from clobbering the first.
fn attachment_path(dir: &std::path::Path, filename: &str) -> std::path::PathBuf {
    let name = crate::sanitize_basename(filename);
    let name = if name.is_empty() {
        "attachment".to_string()
    } else {
        name
    };
    crate::dedup_path(dir, &name)
}

fn describe(path: &std::path::Path, bytes: u64) -> SavedAttachment {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "attachment".to_string());
    SavedAttachment {
        mime: mime_for(&name).to_string(),
        path: path.to_string_lossy().into_owned(),
        name,
        bytes,
    }
}

/// Store pasted bytes as an attachment. The clipboard path: there is no source
/// file to copy, only base64 from a `File` the composer read.
#[tauri::command(async)]
pub fn save_attachment(
    app: tauri::AppHandle,
    session_id: String,
    filename: String,
    base64_data: String,
) -> Result<SavedAttachment, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data.as_bytes())
        .map_err(|e| format!("could not decode the pasted file: {e}"))?;
    if bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "that file is larger than the {} MB attachment limit",
            MAX_ATTACHMENT_BYTES / (1024 * 1024)
        ));
    }
    let dir = attachment_dir(&app, &session_id)?;
    let path = attachment_path(&dir, &filename);
    fs::write(&path, &bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(describe(&path, bytes.len() as u64))
}

/// Copy a dropped file into this session's attachment directory. The drag path:
/// the OS hands us a real absolute source path (see `TerminalView`'s
/// `onDragDropEvent` precedent).
#[tauri::command(async)]
pub fn import_attachment(
    app: tauri::AppHandle,
    session_id: String,
    src_path: String,
) -> Result<SavedAttachment, String> {
    let src = Path::new(&src_path);
    let meta = fs::metadata(src).map_err(|e| format!("{src_path}: {e}"))?;
    if meta.is_dir() {
        return Err("folders can't be attached — pick a file".to_string());
    }
    let size = meta.len();
    if size > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "that file is larger than the {} MB attachment limit",
            MAX_ATTACHMENT_BYTES / (1024 * 1024)
        ));
    }
    let dir = attachment_dir(&app, &session_id)?;
    // The source basename is untrusted: it can carry separators or `..` on a
    // hostile/odd filesystem, so it goes through the same sanitizer as a pasted
    // name rather than being joined as-is.
    let path = attachment_path(&dir, &src_path);
    fs::copy(src, &path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(describe(&path, size))
}

/// Remove a session's whole attachment directory. Called when the session is
/// deleted, so its files don't outlive the comments that referenced them.
/// Best-effort: a missing directory is success.
pub fn delete_session_attachments(app: &tauri::AppHandle, session_id: &str) {
    let Ok(dir) = attachment_dir(app, session_id) else {
        return;
    };
    if let Err(e) = fs::remove_dir_all(&dir) {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(error = %e, dir = %dir.display(), "failed to delete session attachments");
        }
    }
}

/// Move a session's attachment directory when its id changes (`rekey_session`).
/// Without this, comments carried onto the live id would point at a directory
/// named after the dead one. The stored `path` strings are rewritten in step by
/// `Database::rekey_attachment_paths` — the two must always be called together.
pub fn rekey_session_attachments(app: &tauri::AppHandle, old_id: &str, new_id: &str) {
    let (Ok(old_dir), Ok(new_dir)) = (attachment_dir(app, old_id), attachment_dir(app, new_id))
    else {
        return;
    };
    if old_dir == new_dir {
        return;
    }
    // `attachment_dir` just created `new_dir`; a rename onto an existing empty
    // directory is fine on macOS/Linux, and any failure is non-fatal (the old
    // paths keep working — they simply live under the previous id).
    if let Err(e) = fs::rename(&old_dir, &new_dir) {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(error = %e, "failed to move session attachments on rekey");
        }
    }
}

/// Create a directory (and any missing parents), returning its absolute path.
/// Lets the clipping flow ensure `<vault>/<clippings-subdir>` exists before
/// listing it for filename de-duplication.
#[tauri::command(async)]
pub fn ensure_dir(path: String) -> Result<String, String> {
    fs::create_dir_all(&path).map_err(|e| format!("{path}: {e}"))?;
    Ok(Path::new(&path).to_string_lossy().into_owned())
}

/// The user's home directory — where new shells spawn (see `pty_spawn`). The
/// explorer uses it to avoid surfacing a terminal sitting in $HOME as a
/// "project" folder. Returns `None` if $HOME is unset.
#[tauri::command]
pub fn home_dir() -> Option<String> {
    std::env::var("HOME").ok().filter(|d| !d.is_empty())
}

/// Basename of a path, used by the frontend's folder-tab labels. Kept here so
/// the trimming rules live next to the listing logic.
#[allow(dead_code)]
fn basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, is_dir: bool) -> DirEntry {
        DirEntry {
            name: name.to_string(),
            path: format!("/root/{name}"),
            is_dir,
        }
    }

    #[test]
    fn attachment_path_is_confined_to_its_directory() {
        // `attachment_path` is the security boundary for both capture routes:
        // the filename comes from a dropped file or a paste, and a name
        // carrying separators must never place the copy outside `dir`.
        let dir = std::path::Path::new("/data/attachments/s1");
        for hostile in [
            "../../etc/passwd",
            "/etc/passwd",
            r"..\..\windows\system32\evil.exe",
            "/abs/path/ui-mock.png",
        ] {
            let p = attachment_path(dir, hostile);
            assert_eq!(
                p.parent(),
                Some(dir),
                "{hostile} escaped the attachment directory"
            );
            assert!(!p.to_string_lossy().contains(".."));
        }
        // A lone `..` has no usable basename at all — it must not become a
        // directory component either.
        assert_eq!(
            attachment_path(dir, "..").file_name().unwrap(),
            "attachment"
        );
        // An ordinary name passes through untouched.
        assert_eq!(
            attachment_path(dir, "ui-mock.png").file_name().unwrap(),
            "ui-mock.png"
        );
    }

    #[test]
    fn mime_is_derived_from_the_extension() {
        assert_eq!(mime_for("shot.PNG"), "image/png");
        assert_eq!(mime_for("photo.jpeg"), "image/jpeg");
        assert_eq!(mime_for("notes.md"), "text/markdown");
        // Unknown / extension-less degrades rather than failing the capture.
        assert_eq!(mime_for("archive.xyz"), "application/octet-stream");
        assert_eq!(mime_for("Makefile"), "application/octet-stream");
    }

    #[test]
    fn describe_reports_the_stored_name_not_the_requested_one() {
        // De-duplication renames the file on disk; the chip must show what was
        // actually written, or "remove" and the payload would disagree.
        let d = describe(
            std::path::Path::new("/data/attachments/s1/ui-mock (1).png"),
            2048,
        );
        assert_eq!(d.name, "ui-mock (1).png");
        assert_eq!(d.mime, "image/png");
        assert_eq!(d.bytes, 2048);
        assert_eq!(d.path, "/data/attachments/s1/ui-mock (1).png");
    }

    #[test]
    fn sorts_dirs_first_then_case_insensitive_name() {
        let mut entries = vec![
            entry("README.md", false),
            entry("src", true),
            entry("Cargo.toml", false),
            entry("assets", true),
            entry(".git", true),
        ];
        sort_entries(&mut entries);
        let order: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(
            order,
            vec![".git", "assets", "src", "Cargo.toml", "README.md"]
        );
    }
}
