// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Provider-owned hook entries merged into user-owned JSON, atomically.
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub const TIMEOUT: u64 = 43_200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookStatus {
    pub installed: bool,
    pub state: String,
    pub hooks_path: String,
    pub error: Option<String>,
}

pub fn hooks_path(backend: &str) -> PathBuf {
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    home.join(if backend == "cursor" {
        ".cursor/hooks.json"
    } else {
        ".gemini/config/hooks.json"
    })
}

fn command(route: &str, timeout: u64) -> String {
    format!("/usr/bin/curl -sS --max-time {timeout} -X POST -H 'Content-Type: application/json' -H \"X-Redline-Agent: ${{REDLINE_AGENT_SEAT:-}}\" -H \"X-Redline-Project: ${{REDLINE_PROJECT_PATH:-}}\" -H \"X-Redline-Plan-Launch-Id: ${{REDLINE_PLAN_LAUNCH_ID:-}}\" --data-binary @- http://127.0.0.1:7676{route}")
}

fn definitions(backend: &str) -> Vec<(&'static str, &'static str, Value)> {
    if backend == "cursor" {
        vec![
            (
                "beforeSubmitPrompt",
                "/v1/cursor/prompt",
                json!({"command":command("/v1/cursor/prompt", 2),"timeout":5}),
            ),
            (
                "afterAgentResponse",
                "/v1/cursor/response",
                json!({"command":command("/v1/cursor/response", 5),"timeout":10}),
            ),
            (
                "stop",
                "/v1/cursor/stop",
                json!({"command":command("/v1/cursor/stop", TIMEOUT),"timeout":TIMEOUT,"loop_limit":null}),
            ),
        ]
    } else {
        vec![(
            "Stop",
            "/v1/antigravity/stop",
            json!({"type":"command","command":command("/v1/antigravity/stop", TIMEOUT),"timeout":TIMEOUT}),
        )]
    }
}

fn owned(entry: &Value, route: &str) -> bool {
    entry
        .get("command")
        .and_then(Value::as_str)
        .is_some_and(|c| {
            c.split_whitespace()
                .any(|w| w == format!("http://127.0.0.1:7676{route}"))
        })
}

fn read(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let root: Value = serde_json::from_slice(&bytes)
        .map_err(|e| format!("{} is malformed JSON: {e}", path.display()))?;
    if !root.is_object() {
        return Err("hooks.json must contain an object".into());
    }
    Ok(root)
}

fn events<'a>(
    root: &'a mut Value,
    backend: &str,
) -> Result<&'a mut serde_json::Map<String, Value>, String> {
    if backend == "cursor" {
        let obj = root
            .as_object_mut()
            .ok_or("hooks.json must contain an object")?;
        if obj.get("version").is_some_and(|v| v != &json!(1)) {
            return Err("Cursor hook schema version conflicts with version 1".into());
        }
        obj.entry("version").or_insert(json!(1));
        obj.entry("hooks")
            .or_insert(json!({}))
            .as_object_mut()
            .ok_or_else(|| "hooks must be an object".into())
    } else {
        let obj = root
            .as_object_mut()
            .ok_or("hooks.json must contain an object")?;
        if let Some(bundle) = obj.get("redline-plan-review") {
            let entries = bundle.get("Stop").and_then(Value::as_array);
            if !entries.is_some_and(|xs| xs.iter().all(|e| owned(e, "/v1/antigravity/stop"))) {
                return Err(
                    "The redline-plan-review hook name belongs to another integration".into(),
                );
            }
        }
        let bundle = obj
            .entry("redline-plan-review")
            .or_insert(json!({"Stop":[]}));
        let bundle = bundle
            .as_object_mut()
            .ok_or("Redline hook bundle must be an object")?;
        bundle.insert("enabled".into(), json!(true));
        Ok(bundle)
    }
}

pub fn status(backend: &str) -> HookStatus {
    status_at(backend, &hooks_path(backend))
}

pub fn status_at(backend: &str, path: &Path) -> HookStatus {
    let mut answer = HookStatus {
        installed: false,
        state: "missing".into(),
        hooks_path: path.to_string_lossy().into_owned(),
        error: None,
    };
    if !path.exists() {
        return answer;
    }
    let result = (|| {
        let mut root = read(path)?;
        let disabled = backend == "antigravity"
            && root.pointer("/redline-plan-review/enabled") == Some(&json!(false));
        let ev = events(&mut root, backend)?;
        let mut found = 0;
        let mut current = !disabled;
        let defs = definitions(backend);
        for (event, route, expected) in &defs {
            let entries = match ev.get(*event) {
                None => {
                    current = false;
                    continue;
                }
                Some(v) => v
                    .as_array()
                    .ok_or_else(|| format!("{event} must be an array"))?,
            };
            let ours: Vec<_> = entries.iter().filter(|e| owned(e, route)).collect();
            if !ours.is_empty() {
                found += 1;
            }
            current &= ours.len() == 1
                && expected
                    .as_object()
                    .unwrap()
                    .iter()
                    .all(|(k, v)| ours[0].get(k) == Some(v))
                && ours[0].get("matcher").is_none()
                && ours[0].get("enabled") != Some(&json!(false));
        }
        answer.installed = current;
        answer.state = if current {
            "current"
        } else if found == 0 {
            "missing"
        } else if found < defs.len() {
            "partial"
        } else {
            "stale"
        }
        .into();
        Ok::<(), String>(())
    })();
    if let Err(e) = result {
        answer.state = "conflicting".into();
        answer.error = Some(e);
    }
    answer
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Path has no parent")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = parent.join(format!(".redline-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| e.to_string())?;
        if let Ok(meta) = fs::metadata(path) {
            file.set_permissions(meta.permissions())
                .map_err(|e| e.to_string())?;
        }
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&tmp, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result
}

pub fn install(backend: &str) -> Result<HookStatus, String> {
    install_at(backend, &hooks_path(backend))
}
pub fn install_at(backend: &str, path: &Path) -> Result<HookStatus, String> {
    // Parse and validate every event before touching disk.
    let mut root = read(path)?;
    let ev = events(&mut root, backend)?;
    for (event, route, expected) in definitions(backend) {
        let list = ev
            .entry(event)
            .or_insert(json!([]))
            .as_array_mut()
            .ok_or_else(|| format!("{event} must be an array"))?;
        let mut updated = false;
        list.retain_mut(|entry| {
            if !owned(entry, route) {
                return true;
            }
            if updated {
                return false;
            }
            updated = true;
            let obj = entry.as_object_mut().unwrap();
            obj.remove("matcher");
            obj.remove("enabled");
            for (k, v) in expected.as_object().unwrap() {
                obj.insert(k.clone(), v.clone());
            }
            true
        });
        if !updated {
            list.push(expected);
        }
    }
    let mut data = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    // Cursor 2026.09.08 strips // comments before JSON parsing, including
    // inside quoted URLs. JSON slash escapes retain the exact command value.
    if backend == "cursor" {
        data = data.replace("//", r"\/\/");
    }
    data.push('\n');
    atomic_write(path, data.as_bytes())?;
    Ok(status_at(backend, path))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_foreign_fields_and_is_idempotent() {
        for backend in ["cursor", "antigravity"] {
            let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
            fs::create_dir_all(&dir).unwrap();
            let path = dir.join("hooks.json");
            let foreign = if backend == "cursor" {
                json!({"version":1,"custom":{"keep":true},"hooks":{"stop":[{"command":"echo foreign","timeout":7}]}})
            } else {
                json!({"other":{"enabled":false,"Stop":[{"command":"echo foreign"}]}})
            };
            fs::write(&path, foreign.to_string()).unwrap();
            assert!(install_at(backend, &path).unwrap().installed);
            let first = fs::read(&path).unwrap();
            install_at(backend, &path).unwrap();
            assert_eq!(first, fs::read(&path).unwrap());
            let v: Value = serde_json::from_slice(&first).unwrap();
            if backend == "cursor" {
                // The real CLI's JSONC parser removes raw // before parsing.
                let text = String::from_utf8(first.clone()).unwrap();
                assert!(!text.contains("http://"));
                assert!(text.contains(r"http:\/\/127.0.0.1"));
                assert_eq!(status_at(backend, &path).state, "current");
            }
            if backend == "cursor" {
                assert_eq!(v["custom"], foreign["custom"]);
                assert_eq!(v["hooks"]["stop"][0], foreign["hooks"]["stop"][0]);
            } else {
                assert_eq!(v["other"], foreign["other"]);
            }
            fs::remove_dir_all(dir).unwrap();
        }
    }
    #[test]
    fn malformed_and_conflicting_files_are_untouched() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("hooks.json");
        for text in ["{broken", "", "[]", "{\"hooks\":{\"stop\":{}}}"] {
            fs::write(&path, text).unwrap();
            assert!(install_at("cursor", &path).is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), text);
        }
        let text = r#"{"redline-plan-review":{"Stop":[{"command":"foreign"}]}}"#;
        fs::write(&path, text).unwrap();
        assert!(install_at("antigravity", &path).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), text);
        fs::remove_dir_all(dir).unwrap();
    }
}
