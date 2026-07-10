// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The `~/.redline/` user-config directory — the on-disk home of everything a
//! user can customize without touching source: JSON themes (`themes/*.json`),
//! user skills (`skills/*/SKILL.md`, read by `skill.rs`), and later the
//! workspace manifest. The backend only *reads and lists* these files; parsing
//! and validation live with the consumer (the frontend validates theme JSON)
//! so a malformed file degrades to "skipped", never to an error dialog.

use std::path::PathBuf;

use serde::Serialize;

/// HOME-env resolution for `~/.redline`, mirroring `skill::user_skills_root()`.
pub fn config_root() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".redline")
}

/// One user theme file: `name` is the filename stem (the theme's identity —
/// stable across edits to the JSON), `json` is the raw file text.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UserThemeFile {
    pub name: String,
    pub json: String,
}

/// Individual theme files are tiny; anything bigger than this is not a theme.
const MAX_THEME_BYTES: u64 = 64 * 1024;

/// List `<dir>/*.json` as theme files, sorted by name for a stable picker
/// order. A missing directory is "no user themes"; unreadable or oversized
/// files are skipped. No validation here — the frontend owns the theme shape.
pub fn list_user_theme_files_under(dir: &std::path::Path) -> Vec<UserThemeFile> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") || !path.is_file() {
            continue;
        }
        if entry.metadata().map(|m| m.len() > MAX_THEME_BYTES).unwrap_or(true) {
            continue;
        }
        let Some(name) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if let Ok(json) = std::fs::read_to_string(&path) {
            out.push(UserThemeFile {
                name: name.to_string(),
                json,
            });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Tauri command: the user's theme files from `~/.redline/themes/`.
#[tauri::command]
pub fn list_user_themes() -> Vec<UserThemeFile> {
    list_user_theme_files_under(&config_root().join("themes"))
}

/// Tauri command: write (or overwrite) one user theme file and return its
/// stored name. Backs the Phase 3 "Save as my theme" flow, and gives Phase 1's
/// loader a programmatic write path; the JSON is whatever the frontend built —
/// it re-validates on the next load. The name is restricted to a filename-safe
/// slug so a crafted name can't traverse out of the themes dir.
#[tauri::command]
pub fn save_user_theme(name: String, json: String) -> Result<String, String> {
    let slug: String = name
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if slug.is_empty() {
        return Err("theme name is empty".to_string());
    }
    if json.len() as u64 > MAX_THEME_BYTES {
        return Err("theme JSON is too large".to_string());
    }
    let dir = config_root().join("themes");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{slug}.json")), json).map_err(|e| e.to_string())?;
    Ok(slug)
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
    fn missing_dir_lists_nothing() {
        let dir = tmpdir().join("does-not-exist");
        assert!(list_user_theme_files_under(&dir).is_empty());
    }

    #[test]
    fn lists_only_json_files_sorted_with_stem_names() {
        let dir = tmpdir();
        fs::write(dir.join("zeta.json"), r#"{"base":{}}"#).unwrap();
        fs::write(dir.join("alpha.json"), "not even json — still listed").unwrap();
        fs::write(dir.join("notes.txt"), "ignored").unwrap();
        fs::create_dir_all(dir.join("nested.json")).unwrap(); // dir with .json name

        let files = list_user_theme_files_under(&dir);
        assert_eq!(
            files.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(),
            vec!["alpha", "zeta"],
        );
        assert_eq!(files[1].json, r#"{"base":{}}"#);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn oversized_files_are_skipped() {
        let dir = tmpdir();
        fs::write(dir.join("huge.json"), "x".repeat(MAX_THEME_BYTES as usize + 1)).unwrap();
        fs::write(dir.join("ok.json"), "{}").unwrap();
        let files = list_user_theme_files_under(&dir);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].name, "ok");
        let _ = fs::remove_dir_all(&dir);
    }
}
