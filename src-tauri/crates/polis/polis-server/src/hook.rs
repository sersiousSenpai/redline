// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The capture hook's installer.
//!
//! A `UserPromptSubmit` command hook in the harness's global `settings.json`
//! that POSTs its stdin payload to the ingest route. Command type (not http)
//! is deliberate: `--max-time 1` + `exit 0` guarantees prompt submission is
//! never delayed or blocked by the memory being closed or slow (fail-open).
//!
//! Redline's `hook.rs` capture half, generalized (Session A6): the route URL
//! and the shell-expanded headers are the spec's, so Redline's spec renders
//! its command byte-for-byte (its own test pins the bytes) and a standalone
//! install renders one with no headers at all.

use std::fs;
use std::path::Path;

use serde_json::{json, Value};

/// What the installed command says: where to POST, which environment
/// variables to forward as headers, and the hook's own timeout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureHookSpec {
    /// The ingest route. Also the substring by which the installer
    /// recognizes ITS entry when reading `settings.json`.
    pub ingest_url: String,
    /// `(header name, environment variable)` pairs. Each renders as
    /// `-H "Name: ${VAR:-}"` — double-quoted so the shell expands it at fire
    /// time (the hook runs inside the spawned harness's own environment,
    /// which is what lets a host label its own spawns), `:-` so the header is
    /// present-but-empty for a session nobody spawned.
    pub headers: Vec<(String, String)>,
    /// The hook entry's `timeout` (seconds), as the harness reads it.
    pub timeout_secs: u64,
}

impl CaptureHookSpec {
    /// A spec with no forwarded headers — the standalone daemon's.
    pub fn new(ingest_url: impl Into<String>) -> Self {
        Self { ingest_url: ingest_url.into(), headers: Vec::new(), timeout_secs: 5 }
    }

    pub fn with_header(mut self, name: impl Into<String>, env: impl Into<String>) -> Self {
        self.headers.push((name.into(), env.into()));
        self
    }

    /// The command-type hook body. The harness pipes the UserPromptSubmit JSON
    /// (`{session_id, cwd, prompt, prompt_id, …}`) to this command's stdin;
    /// `--data-binary @-` forwards it verbatim to the ingest route. Always
    /// exits 0.
    ///
    /// Stdout is why this is not a fire-and-forget `>/dev/null`.
    /// UserPromptSubmit reads a command hook's stdout as context for the model,
    /// so a host can answer one fire with hidden context as
    /// `hookSpecificOutput.additionalContext` — the model gets it, the
    /// conversation never shows it. Everything else the route returns is a
    /// receipt (`{"seq":…}`) and must stay invisible, hence the `case` guard
    /// rather than an unconditional echo: only a body actually carrying
    /// `hookSpecificOutput` is printed. A timeout, a closed daemon or a partial
    /// read all fall through it silently.
    pub fn command(&self) -> String {
        let mut headers = String::new();
        for (name, env) in &self.headers {
            headers.push_str(&format!("-H \"{name}: ${{{env}:-}}\" "));
        }
        format!(
            "resp=$(curl -s --max-time 1 -X POST -H 'Content-Type: application/json' \
             {headers}--data-binary @- {url} 2>/dev/null); \
             case \"$resp\" in *hookSpecificOutput*) printf '%s' \"$resp\";; esac; exit 0",
            url = self.ingest_url,
        )
    }

    /// Is the entry's `hooks` array one of ours (a command hook whose command
    /// targets the ingest route)?
    pub fn entry_is_capture(&self, entry: &Value) -> bool {
        entry
            .get("hooks")
            .and_then(|v| v.as_array())
            .is_some_and(|hooks| {
                hooks.iter().any(|h| {
                    h.get("command")
                        .and_then(|v| v.as_str())
                        .is_some_and(|c| c.contains(self.ingest_url.as_str()))
                })
            })
    }

    /// Is SOME capture hook of ours installed (any vintage)?
    pub fn installed_at(&self, path: &Path) -> bool {
        let Ok(content) = fs::read_to_string(path) else {
            return false;
        };
        let Ok(json) = serde_json::from_str::<Value>(&content) else {
            return false;
        };
        json.pointer("/hooks/UserPromptSubmit")
            .and_then(|v| v.as_array())
            .is_some_and(|entries| entries.iter().any(|e| self.entry_is_capture(e)))
    }

    /// Is the installed capture hook the command we would write *today*?
    ///
    /// `installed_at` only answers "is some hook of ours there", which is not
    /// enough: an install predating a forwarded header captures prompts
    /// perfectly and silently never delivers what that header carries.
    /// Compared byte-for-byte on purpose; `install_at` rewrites in place, so a
    /// mismatch just means "run it".
    pub fn current_at(&self, path: &Path) -> bool {
        let Ok(content) = fs::read_to_string(path) else {
            return false;
        };
        let Ok(json) = serde_json::from_str::<Value>(&content) else {
            return false;
        };
        let want = self.command();
        json.pointer("/hooks/UserPromptSubmit")
            .and_then(|v| v.as_array())
            .is_some_and(|entries| {
                entries.iter().filter(|e| self.entry_is_capture(e)).any(|e| {
                    e.get("hooks")
                        .and_then(|v| v.as_array())
                        .is_some_and(|hooks| {
                            hooks.iter().any(|h| {
                                h.get("command").and_then(|v| v.as_str()) == Some(want.as_str())
                            })
                        })
                })
            })
    }

    /// Install (or refresh) the capture hook. Idempotent: if ours is already
    /// present, its command is rewritten to the current form (so a stale
    /// command from an older build self-heals); otherwise a new entry is
    /// appended. Preserves any other UserPromptSubmit hooks the user configured.
    pub fn install_at(&self, path: &Path) -> Result<bool, String> {
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

        let cmd = self.command();
        let obj = root.as_object_mut().expect("checked above");
        let hooks_value = obj.entry("hooks".to_string()).or_insert_with(|| json!({}));
        let hooks_obj = hooks_value
            .as_object_mut()
            .ok_or_else(|| "hooks field is not a JSON object".to_string())?;
        let ups = hooks_obj
            .entry("UserPromptSubmit".to_string())
            .or_insert_with(|| json!([]));
        let ups_arr = ups
            .as_array_mut()
            .ok_or_else(|| "hooks.UserPromptSubmit is not a JSON array".to_string())?;

        let mut replaced = false;
        for entry in ups_arr.iter_mut() {
            if self.entry_is_capture(entry) {
                entry["hooks"] = json!([{ "type": "command", "command": cmd, "timeout": self.timeout_secs }]);
                replaced = true;
                break;
            }
        }
        if !replaced {
            ups_arr.push(json!({
                "hooks": [ { "type": "command", "command": cmd, "timeout": self.timeout_secs } ]
            }));
        }

        let serialized = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
        fs::write(path, format!("{}\n", serialized)).map_err(|e| e.to_string())?;
        Ok(self.installed_at(path))
    }

    /// Remove only our UserPromptSubmit capture entry, dropping empty
    /// containers so the file doesn't accumulate stubs. Returns whether the
    /// hook is still installed afterward.
    pub fn uninstall_at(&self, path: &Path) -> Result<bool, String> {
        let Ok(content) = fs::read_to_string(path) else {
            return Ok(false);
        };
        if content.trim().is_empty() {
            return Ok(false);
        }
        let mut root: Value = serde_json::from_str(&content)
            .map_err(|e| format!("existing settings.json is not valid JSON: {e}"))?;

        if let Some(arr) = root
            .pointer_mut("/hooks/UserPromptSubmit")
            .and_then(|v| v.as_array_mut())
        {
            arr.retain(|entry| !self.entry_is_capture(entry));
        }
        if root
            .pointer("/hooks/UserPromptSubmit")
            .and_then(|v| v.as_array())
            .is_some_and(|a| a.is_empty())
        {
            if let Some(hooks) = root.pointer_mut("/hooks").and_then(|v| v.as_object_mut()) {
                hooks.remove("UserPromptSubmit");
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

        let serialized = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
        fs::write(path, format!("{}\n", serialized)).map_err(|e| e.to_string())?;
        Ok(self.installed_at(path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmppath() -> std::path::PathBuf {
        // pid + a per-process counter: two tests on parallel threads can share
        // a same-microsecond timestamp, and then share (and clobber) a file.
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        std::env::temp_dir().join(format!("polis-hook-{}-{n}.json", std::process::id()))
    }

    fn spec() -> CaptureHookSpec {
        CaptureHookSpec::new("http://127.0.0.1:7777/v1/prompts/ingest")
    }

    /// No headers → the bare command; headers render double-quoted with the
    /// empty default, in order, one space apart, exactly where the host's
    /// pinned command has them.
    #[test]
    fn command_renders_headers_shell_expanded_in_order() {
        let bare = spec().command();
        assert!(bare.starts_with("resp=$(curl -s --max-time 1 -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:7777/v1/prompts/ingest 2>/dev/null); "), "{bare}");
        assert!(bare.ends_with("case \"$resp\" in *hookSpecificOutput*) printf '%s' \"$resp\";; esac; exit 0"));
        let with = spec().with_header("X-A", "ENV_A").with_header("X-B", "ENV_B").command();
        assert!(with.contains("application/json' -H \"X-A: ${ENV_A:-}\" -H \"X-B: ${ENV_B:-}\" --data-binary @-"), "{with}");
        assert!(!with.contains("'X-A"), "single quotes would send the literal variable name");
    }

    #[test]
    fn install_refresh_uninstall_round_trip_preserves_foreign_hooks() {
        let path = tmppath();
        let s = spec();
        assert!(!s.installed_at(&path));
        let stale = format!("curl -s --max-time 1 -X POST --data-binary @- {} >/dev/null 2>&1; exit 0", s.ingest_url);
        fs::write(
            &path,
            serde_json::to_string_pretty(&json!({
                "hooks": { "UserPromptSubmit": [
                    { "matcher": "*", "hooks": [{ "type": "command", "command": "my-own-logger" }] },
                    { "hooks": [{ "type": "command", "command": stale, "timeout": 5 }] }
                ]}
            }))
            .unwrap(),
        )
        .unwrap();
        assert!(s.installed_at(&path), "a stale command still counts as installed");
        assert!(!s.current_at(&path), "but not as current");

        assert!(s.install_at(&path).unwrap());
        assert!(s.current_at(&path));
        let json: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let arr = json["hooks"]["UserPromptSubmit"].as_array().unwrap();
        assert_eq!(arr.len(), 2, "refreshed in place, nothing appended");
        assert_eq!(arr[0]["hooks"][0]["command"], "my-own-logger");
        assert_eq!(arr[1]["hooks"][0]["command"].as_str().unwrap(), s.command());
        assert_eq!(arr[1]["hooks"][0]["timeout"], 5);

        assert!(s.install_at(&path).unwrap());
        let json: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["hooks"]["UserPromptSubmit"].as_array().unwrap().len(), 2, "idempotent");

        assert!(!s.uninstall_at(&path).unwrap());
        let json: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let arr = json["hooks"]["UserPromptSubmit"].as_array().unwrap();
        assert_eq!(arr.len(), 1, "only ours removed");
        assert_eq!(arr[0]["hooks"][0]["command"], "my-own-logger");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn uninstalling_the_only_hook_drops_the_empty_containers() {
        let path = tmppath();
        let s = spec();
        assert!(s.install_at(&path).unwrap());
        assert!(!s.uninstall_at(&path).unwrap());
        let json: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert!(json.get("hooks").is_none(), "empty containers dropped");
        let _ = fs::remove_file(&path);
    }
}
