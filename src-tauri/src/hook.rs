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

/// Pre-authorizes the one loopback GET the redline skill's agent-in-doc flow
/// runs to read a plan's block structure before posting a suggestion (SKILL.md
/// §6: `curl -s http://127.0.0.1:7676/v1/sessions/<id>/plan`). Pre-authorizing
/// the exact command keeps that hands-free instead of stalling on an
/// interactive approval prompt. Scoped to the daemon's localhost URL only — the
/// trailing `/*` glob matches that GET. Installed globally because Claude runs
/// in the user's own project cwd, not Redline's repo. (Restore no longer curls
/// — it re-presents the plan Redline already holds; see resumeCommand.ts.)
const RESTORE_CURL_ALLOW: &str = "Bash(curl -s http://127.0.0.1:7676/*)";

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

/// Backfill the restore-curl allow for installs that predate it. `install_at`
/// adds it for fresh installs, but `ensure_timeout_current` only rewrites when
/// the timeout is stale, so an up-to-date existing install would never gain the
/// allow without this. No-op when the hook isn't installed (a fresh install
/// handles it) or the allow is already present. Called once at startup.
pub fn ensure_restore_permission() {
    ensure_restore_permission_at(&settings_path());
}

fn allow_present_at(path: &std::path::Path) -> bool {
    let Ok(content) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(json) = serde_json::from_str::<Value>(&content) else {
        return false;
    };
    json.pointer("/permissions/allow")
        .and_then(|v| v.as_array())
        .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(RESTORE_CURL_ALLOW)))
}

fn ensure_restore_permission_at(path: &std::path::Path) {
    if !get_status_at(path).installed || allow_present_at(path) {
        return;
    }
    let Ok(content) = fs::read_to_string(path) else {
        return;
    };
    let Ok(mut root) = serde_json::from_str::<Value>(&content) else {
        return;
    };
    let Some(obj) = root.as_object_mut() else {
        return;
    };
    if ensure_allow(obj, RESTORE_CURL_ALLOW).is_err() {
        return;
    }
    match serde_json::to_string_pretty(&root) {
        Ok(serialized) => {
            if fs::write(path, format!("{}\n", serialized)).is_ok() {
                tracing::info!("backfilled redline restore-curl permission");
            }
        }
        Err(e) => tracing::warn!(error = %e, "failed to backfill restore permission"),
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

    let obj = root.as_object_mut().expect("checked above");
    ensure_allow(obj, RESTORE_CURL_ALLOW)?;

    let serialized = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    fs::write(path, format!("{}\n", serialized)).map_err(|e| e.to_string())?;

    Ok(get_status_at(path))
}

/// Idempotently ensure `permissions.allow` (a JSON array under `permissions`)
/// contains `rule`, creating the containers if absent and preserving any allows
/// the user already configured. Mirrors the JSON-shape error handling the hook
/// merge uses.
fn ensure_allow(obj: &mut serde_json::Map<String, Value>, rule: &str) -> Result<(), String> {
    let permissions = obj
        .entry("permissions".to_string())
        .or_insert_with(|| json!({}));
    let permissions_obj = permissions
        .as_object_mut()
        .ok_or_else(|| "permissions field is not a JSON object".to_string())?;
    let allow = permissions_obj
        .entry("allow".to_string())
        .or_insert_with(|| json!([]));
    let allow_arr = allow
        .as_array_mut()
        .ok_or_else(|| "permissions.allow is not a JSON array".to_string())?;
    if !allow_arr.iter().any(|v| v.as_str() == Some(rule)) {
        allow_arr.push(Value::String(rule.to_string()));
    }
    Ok(())
}

pub fn uninstall() -> Result<HookStatus, String> {
    uninstall_at(&settings_path())
}

/// Remove Redline's ExitPlanMode entry from settings.json, touching nothing
/// else the user has configured there. An entry whose hook points at a
/// different URL is not ours — leave it alone. Empty `PreToolUse`/`hooks`
/// containers left behind by the removal are dropped so the file doesn't
/// accumulate stubs across install/remove cycles.
pub fn uninstall_at(path: &std::path::Path) -> Result<HookStatus, String> {
    let Ok(content) = fs::read_to_string(path) else {
        return Ok(get_status_at(path)); // nothing to remove
    };
    if content.trim().is_empty() {
        return Ok(get_status_at(path));
    }
    let mut root: Value = serde_json::from_str(&content)
        .map_err(|e| format!("existing settings.json is not valid JSON: {e}"))?;

    if let Some(pre_arr) = root
        .pointer_mut("/hooks/PreToolUse")
        .and_then(|v| v.as_array_mut())
    {
        pre_arr.retain(|entry| {
            let ours = entry.get("matcher").and_then(|v| v.as_str()) == Some("ExitPlanMode")
                && entry
                    .get("hooks")
                    .and_then(|v| v.as_array())
                    .is_some_and(|hooks| {
                        hooks
                            .iter()
                            .any(|h| h.get("url").and_then(|v| v.as_str()) == Some(HOOK_URL))
                    });
            !ours
        });
    }
    if root
        .pointer("/hooks/PreToolUse")
        .and_then(|v| v.as_array())
        .is_some_and(|a| a.is_empty())
    {
        if let Some(hooks) = root.pointer_mut("/hooks").and_then(|v| v.as_object_mut()) {
            hooks.remove("PreToolUse");
        }
    }
    if root
        .pointer("/hooks")
        .and_then(|v| v.as_object())
        .is_some_and(|o| o.is_empty())
    {
        if let Some(obj) = root.as_object_mut() {
            obj.remove("hooks");
        }
    }

    // Remove our restore-curl allow, leaving any other user allows untouched,
    // then drop empty `allow`/`permissions` containers so the file doesn't
    // accumulate stubs across install/remove cycles (mirrors the hooks cleanup).
    if let Some(allow_arr) = root
        .pointer_mut("/permissions/allow")
        .and_then(|v| v.as_array_mut())
    {
        allow_arr.retain(|v| v.as_str() != Some(RESTORE_CURL_ALLOW));
    }
    if root
        .pointer("/permissions/allow")
        .and_then(|v| v.as_array())
        .is_some_and(|a| a.is_empty())
    {
        if let Some(permissions) = root.pointer_mut("/permissions").and_then(|v| v.as_object_mut()) {
            permissions.remove("allow");
        }
    }
    if root
        .pointer("/permissions")
        .and_then(|v| v.as_object())
        .is_some_and(|o| o.is_empty())
    {
        if let Some(obj) = root.as_object_mut() {
            obj.remove("permissions");
        }
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

    #[test]
    fn uninstall_removes_only_our_entry() {
        let path = tmppath();
        let existing = json!({
            "effortLevel": "high",
            "hooks": {
                "PreToolUse": [
                    {
                        "matcher": "ExitPlanMode",
                        "hooks": [ { "type": "http", "url": HOOK_URL, "timeout": HOOK_TIMEOUT_SECS } ]
                    },
                    {
                        "matcher": "Bash",
                        "hooks": [ { "type": "command", "command": "echo hi" } ]
                    }
                ],
                "PostToolUse": [ { "matcher": "Edit", "hooks": [] } ]
            }
        });
        std::fs::write(&path, serde_json::to_string_pretty(&existing).unwrap()).unwrap();

        let status = uninstall_at(&path).unwrap();
        assert!(!status.installed);

        let json: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["effortLevel"], "high");
        // The unrelated Bash hook and PostToolUse section survive.
        let pre = json["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(pre.len(), 1);
        assert_eq!(pre[0]["matcher"], "Bash");
        assert!(json["hooks"]["PostToolUse"].is_array());

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn uninstall_leaves_foreign_exitplanmode_hook() {
        let path = tmppath();
        let existing = json!({
            "hooks": { "PreToolUse": [ {
                "matcher": "ExitPlanMode",
                "hooks": [ { "type": "http", "url": "http://elsewhere", "timeout": 30 } ]
            } ] }
        });
        std::fs::write(&path, serde_json::to_string_pretty(&existing).unwrap()).unwrap();

        uninstall_at(&path).unwrap();
        let json: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            json["hooks"]["PreToolUse"][0]["hooks"][0]["url"],
            "http://elsewhere"
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn uninstall_drops_empty_containers_and_roundtrips() {
        let path = tmppath();
        install_at(&path).unwrap();
        assert!(get_status_at(&path).installed);

        let status = uninstall_at(&path).unwrap();
        assert!(!status.installed);
        let json: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        // No empty hooks stubs left behind after a full install/remove cycle.
        assert!(json.get("hooks").is_none());

        // And a re-install works on the cleaned file.
        assert!(install_at(&path).unwrap().installed);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn uninstall_is_noop_without_settings_file() {
        let path = tmppath();
        let status = uninstall_at(&path).unwrap();
        assert!(!status.installed);
        assert!(!path.exists());
    }

    fn allow_entries(json: &Value) -> Vec<String> {
        json.pointer("/permissions/allow")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default()
    }

    #[test]
    fn install_adds_restore_curl_allow() {
        let path = tmppath();
        install_at(&path).unwrap();
        let json: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(allow_entries(&json).contains(&RESTORE_CURL_ALLOW.to_string()));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn install_does_not_duplicate_allow_or_clobber_existing() {
        let path = tmppath();
        let existing = json!({
            "permissions": { "allow": ["Bash(git push *)"] }
        });
        std::fs::write(&path, serde_json::to_string_pretty(&existing).unwrap()).unwrap();

        // Two installs must not produce two copies of our entry.
        install_at(&path).unwrap();
        install_at(&path).unwrap();

        let json: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let allows = allow_entries(&json);
        // Pre-existing user allow survives.
        assert!(allows.contains(&"Bash(git push *)".to_string()));
        // Ours is present exactly once.
        assert_eq!(
            allows.iter().filter(|a| *a == RESTORE_CURL_ALLOW).count(),
            1
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn uninstall_removes_only_our_allow() {
        let path = tmppath();
        let existing = json!({
            "permissions": { "allow": ["Bash(git push *)", RESTORE_CURL_ALLOW] }
        });
        std::fs::write(&path, serde_json::to_string_pretty(&existing).unwrap()).unwrap();
        install_at(&path).unwrap(); // also adds the hook

        uninstall_at(&path).unwrap();
        let json: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let allows = allow_entries(&json);
        assert!(allows.contains(&"Bash(git push *)".to_string()));
        assert!(!allows.contains(&RESTORE_CURL_ALLOW.to_string()));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn uninstall_drops_empty_permissions_container() {
        let path = tmppath();
        // Fresh install creates permissions.allow with only our entry.
        install_at(&path).unwrap();
        uninstall_at(&path).unwrap();
        let json: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        // No empty permissions stub left behind.
        assert!(json.get("permissions").is_none());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn startup_backfills_missing_allow_on_existing_install() {
        let path = tmppath();
        // An install that predates the allow: hook present, no permissions.
        let existing = json!({
            "hooks": { "PreToolUse": [ {
                "matcher": "ExitPlanMode",
                "hooks": [ { "type": "http", "url": HOOK_URL, "timeout": HOOK_TIMEOUT_SECS } ]
            } ] }
        });
        std::fs::write(&path, serde_json::to_string_pretty(&existing).unwrap()).unwrap();
        assert!(!allow_present_at(&path));

        ensure_restore_permission_at(&path);
        assert!(allow_present_at(&path));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn startup_backfill_is_noop_when_hook_absent() {
        let path = tmppath();
        // No hook installed → don't materialize a permissions block.
        std::fs::write(&path, serde_json::to_string_pretty(&json!({})).unwrap()).unwrap();
        ensure_restore_permission_at(&path);
        let json: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(json.get("permissions").is_none());
        let _ = std::fs::remove_file(&path);
    }
}
