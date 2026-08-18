// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Global Codex lifecycle hooks used by Redline.
//!
//! Codex exposes command hooks rather than Claude Code's native HTTP hook, so
//! curl is the deliberately tiny adapter. The Stop hook is held while the plan
//! is reviewed; prompt capture is asynchronous and always fail-open.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};

const STOP_URL: &str = "http://127.0.0.1:7676/v1/codex/stop";
const INGEST_URL: &str = "http://127.0.0.1:7676/v1/prompts/ingest";
const HOOK_TIMEOUT_SECS: u32 = 43_200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexHookStatus {
    pub available: bool,
    pub installed: bool,
    pub hooks_path: String,
    pub stop_found: bool,
    pub prompt_capture_found: bool,
}

pub fn hooks_path() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".codex").join("hooks.json")
}

fn stop_command() -> String {
    format!(
        "/usr/bin/curl -sS --max-time {HOOK_TIMEOUT_SECS} -X POST -H 'Content-Type: application/json' --data-binary @- {STOP_URL}"
    )
}

fn capture_command() -> String {
    format!(
        "/usr/bin/curl -sS --max-time 1 -X POST -H 'Content-Type: application/json' --data-binary @- {INGEST_URL} >/dev/null 2>&1; exit 0"
    )
}

fn entry_targets(entry: &Value, url: &str) -> bool {
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hooks| hooks.iter().any(|hook| {
            hook.get("command")
                .and_then(Value::as_str)
                .is_some_and(|command| command.contains(url))
        }))
}

pub fn get_status() -> CodexHookStatus {
    get_status_at(&hooks_path())
}

fn get_status_at(path: &Path) -> CodexHookStatus {
    let root = fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let stop_found = root
        .as_ref()
        .and_then(|v| v.pointer("/hooks/Stop"))
        .and_then(Value::as_array)
        .is_some_and(|entries| entries.iter().any(|entry| entry_targets(entry, STOP_URL)));
    let prompt_capture_found = root
        .as_ref()
        .and_then(|v| v.pointer("/hooks/UserPromptSubmit"))
        .and_then(Value::as_array)
        .is_some_and(|entries| entries.iter().any(|entry| entry_targets(entry, INGEST_URL)));
    CodexHookStatus {
        available: crate::codex_app_server::codex_available(),
        installed: stop_found && prompt_capture_found,
        hooks_path: path.to_string_lossy().into_owned(),
        stop_found,
        prompt_capture_found,
    }
}

pub fn install() -> Result<CodexHookStatus, String> {
    install_at(&hooks_path())
}

fn upsert_command(entries: &mut Vec<Value>, url: &str, hook: Value) {
    if let Some(entry) = entries.iter_mut().find(|entry| entry_targets(entry, url)) {
        entry["hooks"] = json!([hook]);
    } else {
        entries.push(json!({ "hooks": [hook] }));
    }
}

fn install_at(path: &Path) -> Result<CodexHookStatus, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut root = if path.exists() {
        let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
        if text.trim().is_empty() { json!({}) } else {
            serde_json::from_str(&text)
                .map_err(|e| format!("existing hooks.json is not valid JSON: {e}"))?
        }
    } else {
        json!({})
    };
    let object = root
        .as_object_mut()
        .ok_or_else(|| "hooks.json root is not a JSON object".to_string())?;
    let hooks = object.entry("hooks").or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| "hooks field is not a JSON object".to_string())?;
    let stop = hooks.entry("Stop").or_insert_with(|| json!([]))
        .as_array_mut()
        .ok_or_else(|| "hooks.Stop is not a JSON array".to_string())?;
    upsert_command(stop, STOP_URL, json!({
        "type": "command", "command": stop_command(), "timeout": HOOK_TIMEOUT_SECS
    }));
    let prompts = hooks.entry("UserPromptSubmit").or_insert_with(|| json!([]))
        .as_array_mut()
        .ok_or_else(|| "hooks.UserPromptSubmit is not a JSON array".to_string())?;
    upsert_command(prompts, INGEST_URL, json!({
        "type": "command", "command": capture_command(), "timeout": 5, "async": true
    }));

    let serialized = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    fs::write(path, format!("{serialized}\n")).map_err(|e| e.to_string())?;
    Ok(get_status_at(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_preserves_foreign_hooks_and_is_idempotent() {
        let dir = std::env::temp_dir().join(format!(
            "redline-codex-hook-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("hooks.json");
        fs::write(&path, r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo foreign"}]}]}}"#).unwrap();
        assert!(install_at(&path).unwrap().installed);
        assert!(install_at(&path).unwrap().installed);
        let root: Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        let stops = root.pointer("/hooks/Stop").unwrap().as_array().unwrap();
        assert_eq!(stops.len(), 2);
        assert_eq!(stops.iter().filter(|v| entry_targets(v, STOP_URL)).count(), 1);
        assert!(stops.iter().any(|v| entry_targets(v, "echo foreign")));
        fs::remove_dir_all(dir).unwrap();
    }
}
