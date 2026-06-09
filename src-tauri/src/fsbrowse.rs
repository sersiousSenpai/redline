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
