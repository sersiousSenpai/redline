// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::{json, Value};

const HOOK_URL: &str = "http://127.0.0.1:7676/v1/plan";
// A held plan costs nothing while it waits (zero tokens, an idle local socket),
// so we hold it like a plan-mode terminal that waits for you — not for 10
// minutes. Claude Code honors a large `timeout` (verified: 600 is honored well
// past 120s; the documented 30s is a default, not a cap). 12h covers any real
// desk session; if a hold genuinely ends, the UI offers "Restore plan session".
const HOOK_TIMEOUT_SECS: u32 = 43_200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookStatus {
    pub installed: bool,
    pub settings_path: String,
    pub matcher_found: bool,
    pub conflicting_url: Option<String>,
}

pub fn settings_path() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".claude").join("settings.json")
}

pub fn get_status() -> HookStatus {
    get_status_at(&settings_path())
}

pub fn get_status_at(path: &std::path::Path) -> HookStatus {
    let path_str = path.to_string_lossy().to_string();

    let Ok(content) = fs::read_to_string(path) else {
        return HookStatus {
            installed: false,
            settings_path: path_str,
            matcher_found: false,
            conflicting_url: None,
        };
    };

    let Ok(json) = serde_json::from_str::<Value>(&content) else {
        return HookStatus {
            installed: false,
            settings_path: path_str,
            matcher_found: false,
            conflicting_url: None,
        };
    };

    let Some(entries) = json.pointer("/hooks/PreToolUse").and_then(|v| v.as_array()) else {
        return HookStatus {
            installed: false,
            settings_path: path_str,
            matcher_found: false,
            conflicting_url: None,
        };
    };

    for entry in entries {
        if entry.get("matcher").and_then(|v| v.as_str()) != Some("ExitPlanMode") {
            continue;
        }
        let Some(hooks) = entry.get("hooks").and_then(|v| v.as_array()) else {
            continue;
        };
        for h in hooks {
            let url = h.get("url").and_then(|v| v.as_str()).unwrap_or("");
            if url == HOOK_URL {
                return HookStatus {
                    installed: true,
                    settings_path: path_str,
                    matcher_found: true,
                    conflicting_url: None,
                };
            }
            return HookStatus {
                installed: false,
                settings_path: path_str,
                matcher_found: true,
                conflicting_url: Some(url.to_string()),
            };
        }
    }

    HookStatus {
        installed: false,
        settings_path: path_str,
        matcher_found: false,
        conflicting_url: None,
    }
}

pub fn install() -> Result<HookStatus, String> {
    install_at(&settings_path())
}

/// Read the `timeout` configured on the installed Redline ExitPlanMode hook,
/// if any. Used to detect an out-of-date timeout left behind by an older
/// install so we can silently refresh it.
fn installed_timeout_at(path: &std::path::Path) -> Option<u32> {
    let content = fs::read_to_string(path).ok()?;
    let json: Value = serde_json::from_str(&content).ok()?;
    let entries = json.pointer("/hooks/PreToolUse")?.as_array()?;
    for entry in entries {
        if entry.get("matcher").and_then(|v| v.as_str()) != Some("ExitPlanMode") {
            continue;
        }
        let hooks = entry.get("hooks").and_then(|v| v.as_array())?;
        for h in hooks {
            if h.get("url").and_then(|v| v.as_str()) == Some(HOOK_URL) {
                return h.get("timeout").and_then(|v| v.as_u64()).map(|n| n as u32);
            }
        }
    }
    None
}

/// If the Redline hook is already installed but with a stale `timeout` (e.g. an
/// older build wrote 600), rewrite it so the current `HOOK_TIMEOUT_SECS` takes
/// effect. No-op when the hook isn't installed (the setup modal handles a fresh
/// install) or the timeout is already current. Called once at startup.
pub fn ensure_timeout_current() {
    ensure_timeout_current_at(&settings_path());
}

fn ensure_timeout_current_at(path: &std::path::Path) {
    if !get_status_at(path).installed {
        return;
    }
    if installed_timeout_at(path) == Some(HOOK_TIMEOUT_SECS) {
        return;
    }
    match install_at(path) {
        Ok(_) => tracing::info!(
            timeout = HOOK_TIMEOUT_SECS,
            "refreshed redline hook timeout"
        ),
        Err(e) => tracing::warn!(error = %e, "failed to refresh hook timeout"),
    }
}

pub fn install_at(path: &std::path::Path) -> Result<HookStatus, String> {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let mut root: Value = if path.exists() {
        let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
        if content.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str(&content)
                .map_err(|e| format!("existing settings.json is not valid JSON: {e}"))?
        }
    } else {
        json!({})
    };

    if !root.is_object() {
        return Err("settings.json root is not a JSON object".to_string());
    }

    let obj = root.as_object_mut().expect("checked above");
    let hooks_value = obj
        .entry("hooks".to_string())
        .or_insert_with(|| json!({}));
    let hooks_obj = hooks_value
        .as_object_mut()
        .ok_or_else(|| "hooks field is not a JSON object".to_string())?;
    let pre = hooks_obj
        .entry("PreToolUse".to_string())
        .or_insert_with(|| json!([]));
    let pre_arr = pre
        .as_array_mut()
        .ok_or_else(|| "hooks.PreToolUse is not a JSON array".to_string())?;

    let mut replaced = false;
    for entry in pre_arr.iter_mut() {
        if entry.get("matcher").and_then(|v| v.as_str()) == Some("ExitPlanMode") {
            entry["hooks"] = json!([
                { "type": "http", "url": HOOK_URL, "timeout": HOOK_TIMEOUT_SECS }
            ]);
            replaced = true;
            break;
        }
    }
    if !replaced {
        pre_arr.push(json!({
            "matcher": "ExitPlanMode",
            "hooks": [
                { "type": "http", "url": HOOK_URL, "timeout": HOOK_TIMEOUT_SECS }
            ]
        }));
    }

    let serialized = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    fs::write(path, format!("{}\n", serialized)).map_err(|e| e.to_string())?;

    Ok(get_status_at(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmppath() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("redline-hook-{}.json", uuid::Uuid::new_v4()))
    }

    #[test]
    fn install_merges_into_existing_settings() {
        let path = tmppath();
        let existing = json!({
            "effortLevel": "high",
            "skipAutoPermissionPrompt": true,
            "enabledPlugins": { "rust-analyzer-lsp@claude-plugins-official": true }
        });
        std::fs::write(&path, serde_json::to_string_pretty(&existing).unwrap()).unwrap();

        let status = install_at(&path).unwrap();
        assert!(status.installed);
        assert!(status.matcher_found);
        assert!(status.conflicting_url.is_none());

        let new_content = std::fs::read_to_string(&path).unwrap();
        let new_json: Value = serde_json::from_str(&new_content).unwrap();
        assert_eq!(new_json["effortLevel"], "high");
        assert_eq!(new_json["skipAutoPermissionPrompt"], true);
        assert_eq!(
            new_json["enabledPlugins"]["rust-analyzer-lsp@claude-plugins-official"],
            true
        );
        let entry = &new_json["hooks"]["PreToolUse"][0];
        assert_eq!(entry["matcher"], "ExitPlanMode");
        assert_eq!(entry["hooks"][0]["url"], HOOK_URL);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn install_replaces_conflicting_url() {
        let path = tmppath();
        let existing = json!({
            "hooks": {
                "PreToolUse": [
                    {
                        "matcher": "ExitPlanMode",
                        "hooks": [
                            { "type": "http", "url": "http://elsewhere", "timeout": 30 }
                        ]
                    }
                ]
            }
        });
        std::fs::write(&path, serde_json::to_string_pretty(&existing).unwrap()).unwrap();

        let pre_status = get_status_at(&path);
        assert!(!pre_status.installed);
        assert!(pre_status.matcher_found);
        assert_eq!(
            pre_status.conflicting_url.as_deref(),
            Some("http://elsewhere")
        );

        let post = install_at(&path).unwrap();
        assert!(post.installed);
        let content = std::fs::read_to_string(&path).unwrap();
        let json: Value = serde_json::from_str(&content).unwrap();
        let arr = json["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["hooks"][0]["url"], HOOK_URL);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn ensure_timeout_current_rewrites_stale_timeout() {
        let path = tmppath();
        // Simulate an older install that wrote the previous 10-minute timeout.
        let existing = json!({
            "hooks": { "PreToolUse": [ {
                "matcher": "ExitPlanMode",
                "hooks": [ { "type": "http", "url": HOOK_URL, "timeout": 600 } ]
            } ] }
        });
        std::fs::write(&path, serde_json::to_string_pretty(&existing).unwrap()).unwrap();
        assert_eq!(installed_timeout_at(&path), Some(600));

        ensure_timeout_current_at(&path);
        assert_eq!(installed_timeout_at(&path), Some(HOOK_TIMEOUT_SECS));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn install_creates_settings_when_absent() {
        let path = tmppath();
        let status = install_at(&path).unwrap();
        assert!(status.installed);
        assert!(path.exists());
        let _ = std::fs::remove_file(&path);
    }
}
