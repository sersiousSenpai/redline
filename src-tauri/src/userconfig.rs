// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The `~/.redline/` user-config directory — home of the workspace manifest
//! (`workspace.json`) and per-boot extension tokens (`extensions/`, see
//! `extension.rs`). The backend only reads and writes raw text; the manifest
//! schema lives with the frontend (`src/config/workspace.ts`), so a malformed
//! file degrades to "defaults", never to an error dialog.

use std::path::PathBuf;

/// The build flavor, baked at compile time (`REDLINE_HARNESS=legal cargo
/// build`). This is the ONLY boot-direction signal: `~/.redline` is resolved
/// from HOME and therefore shared across flavors on one machine, so user
/// state must never say which harness a build boots into — the build says
/// which harness, the manifest says how the user arranged it. None in every
/// normal build, including this one.
pub fn build_flavor() -> Option<&'static str> {
    option_env!("REDLINE_HARNESS")
}

/// HOME-env resolution for this build's config root. The default flavor
/// keeps `~/.redline` byte-for-byte (existing installs migrate by doing
/// nothing); a flavored build roots at `~/.redline/flavors/<flavor>/`, so
/// two flavors on one machine never share a workspace manifest, a harness
/// directory, or an extensions directory (open decision 5: identifier-keyed
/// subdirectory, chosen over per-flavor roots so the parent dir stays one
/// discoverable place). The flavor id is a compile-time constant authored by
/// the build, never user input — it is trusted as a path segment.
pub fn config_root() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let base = home.join(".redline");
    match build_flavor() {
        Some(flavor) => base.join("flavors").join(flavor),
        None => base,
    }
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

// ---- Harness definitions (program A5) --------------------------------------
// A harness is data the frontend interprets — the backend only lists raw
// manifest text, exactly the workspace.json contract one directory deeper.
// Layout: `<config_root>/harnesses/<id>/harness.json`. Hand-authorable today;
// A5a's local-folder install writes into the same directory.

/// A manifest file's raw text, keyed by its directory name. The directory
/// name is the harness's identity — the frontend rejects a manifest whose
/// `id` disagrees with its folder. `link_target` is provenance: where a
/// link-installed harness (A5a) actually lives; None for a real directory.
#[derive(serde::Serialize, Debug, PartialEq)]
pub struct HarnessFileEntry {
    pub id: String,
    pub json: String,
    pub link_target: Option<String>,
}

pub(crate) const MAX_HARNESS_BYTES: u64 = 256 * 1024;

/// Scan `<root>/harnesses/*/harness.json`. Missing dir = no harnesses;
/// unreadable or oversized entries are skipped, never an error — the lenient
/// read discipline every user-authored file here follows. Sorted by id so
/// the offered list is stable across launches.
pub fn list_harnesses_under(root: &std::path::Path) -> Vec<HarnessFileEntry> {
    let dir = root.join("harnesses");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(id) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let manifest = path.join("harness.json");
        let Ok(meta) = std::fs::metadata(&manifest) else {
            continue;
        };
        if !meta.is_file() || meta.len() > MAX_HARNESS_BYTES {
            continue;
        }
        let Ok(json) = std::fs::read_to_string(&manifest) else {
            continue;
        };
        out.push(HarnessFileEntry {
            id: id.to_string(),
            json,
            link_target: crate::local_install::link_target(&path),
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// Tauri command: the installed harness manifests, raw.
#[tauri::command]
pub fn list_harnesses() -> Vec<HarnessFileEntry> {
    list_harnesses_under(&config_root())
}

/// Tauri command (A5a): link-install a harness pack from a local folder.
/// The returned identity feeds the confirmation toast; the folder the user
/// picked is the consent — a harness composes UI, it holds no scopes and
/// can call nothing.
#[tauri::command(async)]
pub fn harness_install_from_folder(
    path: String,
) -> Result<crate::local_install::HarnessInstall, String> {
    crate::local_install::install_harness_folder(&config_root(), std::path::Path::new(&path))
}

/// Tauri command (A5a): remove a link-installed harness. Guarded to links —
/// a hand-authored directory is named, never deleted.
#[tauri::command(async)]
pub fn harness_uninstall(id: String) -> Result<(), String> {
    crate::local_install::uninstall_harness_link(&config_root(), &id)
}

/// Tauri command: which harness this BUILD is, if any — the boot entry's
/// direction signal (A7 boots into it with the exit hidden; a user-entered
/// harness never consults this). None in every normal build.
#[tauri::command]
pub fn harness_flavor() -> Option<String> {
    build_flavor().map(str::to_string)
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
    fn harnesses_missing_dir_lists_empty() {
        let dir = tmpdir().join("no-such-root");
        assert!(list_harnesses_under(&dir).is_empty());
    }

    #[test]
    fn harnesses_list_sorted_and_lenient() {
        let root = tmpdir();
        let mk = |id: &str, json: &str| {
            let d = root.join("harnesses").join(id);
            fs::create_dir_all(&d).unwrap();
            fs::write(d.join("harness.json"), json).unwrap();
        };
        mk("zeta", r#"{"id":"zeta","name":"Z"}"#);
        mk("alpha", r#"{"id":"alpha","name":"A"}"#);
        // A directory with no manifest is skipped, not an error.
        fs::create_dir_all(root.join("harnesses").join("empty")).unwrap();
        // An oversized manifest is skipped — the frontend never sees it.
        mk("huge", &format!("{{\"pad\":\"{}\"}}", "x".repeat(300 * 1024)));
        // A stray FILE at the harnesses level is not a harness.
        fs::write(root.join("harnesses").join("README.md"), "hi").unwrap();
        let listed = list_harnesses_under(&root);
        assert_eq!(
            listed.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            vec!["alpha", "zeta"],
        );
        assert_eq!(listed[0].json, r#"{"id":"alpha","name":"A"}"#);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn default_build_has_no_flavor() {
        // This binary is plain Redline: the flavor probe must answer None,
        // and the config root must be exactly `~/.redline` (a flavored root
        // appearing here would mean boot direction leaked into user state).
        assert_eq!(build_flavor(), None);
        assert!(config_root().ends_with(".redline"));
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
