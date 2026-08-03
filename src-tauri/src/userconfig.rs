// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The `~/.redline/` user-config directory — home of the workspace manifest
//! (`workspace.json`) and per-boot extension tokens (`extensions/`, see
//! `extension.rs`). The backend only reads and writes raw text; the manifest
//! schema lives with the frontend (`src/config/workspace.ts`), so a malformed
//! file degrades to "defaults", never to an error dialog.

use std::path::PathBuf;

/// HOME-env resolution for `~/.redline`.
pub fn config_root() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".redline")
}

/// The workspace manifest is a hand-editable file; this cap only guards
/// against reading something that clearly isn't one.
const MAX_WORKSPACE_BYTES: u64 = 256 * 1024;

/// Read `<root>/workspace.json` as raw text. Missing file = no manifest
/// (the frontend's defaults reproduce the stock UI); unreadable or oversized
/// degrades the same way, never to an error dialog.
pub fn read_workspace_under(root: &std::path::Path) -> Option<String> {
    let path = root.join("workspace.json");
    let meta = std::fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > MAX_WORKSPACE_BYTES {
        return None;
    }
    std::fs::read_to_string(&path).ok()
}

/// Write `<root>/workspace.json`. The text must at least be a JSON object —
/// the frontend owns the schema, but a non-object write would wedge every
/// launch into the defaults while looking customized on disk.
pub fn write_workspace_under(root: &std::path::Path, json: &str) -> Result<(), String> {
    if json.len() as u64 > MAX_WORKSPACE_BYTES {
        return Err("workspace manifest is too large".to_string());
    }
    match serde_json::from_str::<serde_json::Value>(json) {
        Ok(serde_json::Value::Object(_)) => {}
        _ => return Err("workspace manifest must be a JSON object".to_string()),
    }
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    std::fs::write(root.join("workspace.json"), json).map_err(|e| e.to_string())
}

/// Tauri command: the raw `~/.redline/workspace.json` text, if present.
#[tauri::command]
pub fn get_workspace() -> Option<String> {
    read_workspace_under(&config_root())
}

/// Tauri command: persist the workspace manifest. Every GUI customization
/// gesture funnels here — the file is the store, the GUI is a lens on it.
#[tauri::command]
pub fn save_workspace(json: String) -> Result<(), String> {
    write_workspace_under(&config_root(), &json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmpdir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("redline-userconfig-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn workspace_missing_reads_none() {
        let dir = tmpdir().join("no-such-root");
        assert_eq!(read_workspace_under(&dir), None);
    }

    #[test]
    fn workspace_round_trips_and_creates_the_root() {
        let dir = tmpdir().join("fresh-root");
        let json = r#"{"version":1,"landing":"drafter"}"#;
        write_workspace_under(&dir, json).unwrap();
        assert_eq!(read_workspace_under(&dir).as_deref(), Some(json));
        // Overwrite wins — the file is the single store.
        write_workspace_under(&dir, r#"{"version":1}"#).unwrap();
        assert_eq!(
            read_workspace_under(&dir).as_deref(),
            Some(r#"{"version":1}"#)
        );
        let _ = fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn workspace_rejects_non_object_and_oversized_writes() {
        let dir = tmpdir();
        assert!(write_workspace_under(&dir, "[1,2,3]").is_err());
        assert!(write_workspace_under(&dir, "not json").is_err());
        assert!(
            write_workspace_under(&dir, &format!("{{\"pad\":\"{}\"}}", "x".repeat(300 * 1024)))
                .is_err()
        );
        assert_eq!(read_workspace_under(&dir), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn workspace_oversized_file_on_disk_reads_none() {
        let dir = tmpdir();
        fs::write(
            dir.join("workspace.json"),
            "x".repeat(MAX_WORKSPACE_BYTES as usize + 1),
        )
        .unwrap();
        assert_eq!(read_workspace_under(&dir), None);
        let _ = fs::remove_dir_all(&dir);
    }
}
