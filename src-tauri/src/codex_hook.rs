// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Global Codex lifecycle hooks used by Redline.
//!
//! Codex exposes command hooks rather than Claude Code's native HTTP hook, so
//! curl is the deliberately tiny adapter. The Stop hook is held while the plan
//! is reviewed; prompt capture is asynchronous and always fail-open. Both
//! forward the dock terminal they run in (`X-Redline-Terminal`), which is how
//! a Codex agent's turns reach the terminal wall (`term_attention`).

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
    /// Both hooks are there in a shape that does the job (current, or one in
    /// `PREVIOUS_*_COMMANDS`).
    pub installed: bool,
    /// At least one is an earlier, still-working shape: an update is
    /// available, and nothing waits on it.
    pub outdated: bool,
    pub hooks_path: String,
    pub stop_found: bool,
    pub prompt_capture_found: bool,
    pub trust: String,
    pub trust_detail: Option<String>,
}

pub fn hooks_path() -> PathBuf {
    crate::codex_profile::codex_home().join("hooks.json")
}

/// `-H "X-Redline-Terminal: ${REDLINE_TERMINAL_ID:-}"`: double-quoted so the
/// shell expands it at fire time, empty for a session outside the dock.
fn terminal_header() -> String {
    format!(
        "-H \"{}: ${{{}:-}}\"",
        crate::term_attention::HEADER,
        crate::term_attention::ENV_TERMINAL_ID
    )
}

fn stop_command() -> String {
    format!(
        "/usr/bin/curl -sS --max-time {HOOK_TIMEOUT_SECS} -X POST -H 'Content-Type: application/json' -H \"X-Redline-Plan-Launch-Id: ${{REDLINE_PLAN_LAUNCH_ID:-}}\" -H \"X-Redline-Agent: ${{REDLINE_AGENT_SEAT:-}}\" -H \"X-Redline-Codex-Socket: ${{REDLINE_CODEX_SOCKET:-}}\" {terminal} --data-binary @- {STOP_URL}",
        terminal = terminal_header(),
    )
}

fn capture_command() -> String {
    format!(
        "/usr/bin/curl -sS --max-time 1 -X POST -H 'Content-Type: application/json' -H \"X-Redline-Plan-Launch-Id: ${{REDLINE_PLAN_LAUNCH_ID:-}}\" -H \"X-Redline-Agent: ${{REDLINE_AGENT_SEAT:-}}\" {terminal} --data-binary @- {INGEST_URL} >/dev/null 2>&1; exit 0",
        terminal = terminal_header(),
    )
}

/// Commands an earlier Redline wrote that still do the whole job, frozen
/// byte for byte as that build installed them. These predate the terminal
/// header: they hold, return and approve plans and capture prompts, and only
/// the terminal wall misses a Codex agent's turns. Such an install counts as
/// installed, so it never blocks a launch or a restore, but reads `outdated`,
/// and Install rewrites it (Codex then asks for trust once, as for any
/// changed hook).
///
/// A shape is listed only while it works. The Stop commands from before
/// `X-Redline-Codex-Socket` do not: Approve hands the plan to Codex through
/// that socket (`codex_app_server::queue_plan_implementation`), so an install
/// that old still reads as missing.
const PREVIOUS_STOP_COMMANDS: &[&str] = &[
    "/usr/bin/curl -sS --max-time 43200 -X POST -H 'Content-Type: application/json' -H \"X-Redline-Plan-Launch-Id: ${REDLINE_PLAN_LAUNCH_ID:-}\" -H \"X-Redline-Agent: ${REDLINE_AGENT_SEAT:-}\" -H \"X-Redline-Codex-Socket: ${REDLINE_CODEX_SOCKET:-}\" --data-binary @- http://127.0.0.1:7676/v1/codex/stop",
];
const PREVIOUS_CAPTURE_COMMANDS: &[&str] = &[
    "/usr/bin/curl -sS --max-time 1 -X POST -H 'Content-Type: application/json' -H \"X-Redline-Plan-Launch-Id: ${REDLINE_PLAN_LAUNCH_ID:-}\" -H \"X-Redline-Agent: ${REDLINE_AGENT_SEAT:-}\" --data-binary @- http://127.0.0.1:7676/v1/prompts/ingest >/dev/null 2>&1; exit 0",
];

/// How current one of our hooks is, ordered so the best of several wins.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Shape {
    Missing,
    Previous,
    Current,
}

fn shape_of(command: &str, current: &str, previous: &[&str]) -> Shape {
    if command == current {
        Shape::Current
    } else if previous.contains(&command) {
        Shape::Previous
    } else {
        Shape::Missing
    }
}

/// The Stop hook, then the capture hook: the command this build writes and
/// the earlier ones that still count.
fn hook_shapes() -> [(String, &'static [&'static str]); 2] {
    [(stop_command(), PREVIOUS_STOP_COMMANDS), (capture_command(), PREVIOUS_CAPTURE_COMMANDS)]
}

#[cfg(test)]
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
    let shape = |event: &str, (current, previous): &(String, &[&str]), asynchronous: bool| {
        root.as_ref()
            .and_then(|v| v.pointer(&format!("/hooks/{event}")))
            .and_then(Value::as_array)
            .and_then(|entries| entries.iter().map(|entry| entry_shape(entry, current, previous, asynchronous)).max())
            .unwrap_or(Shape::Missing)
    };
    let [stop_shapes, capture_shapes] = hook_shapes();
    let stop = shape("Stop", &stop_shapes, false);
    let capture = shape("UserPromptSubmit", &capture_shapes, true);
    CodexHookStatus {
        available: crate::codex_app_server::codex_available(),
        installed: stop != Shape::Missing && capture != Shape::Missing,
        outdated: stop == Shape::Previous || capture == Shape::Previous,
        hooks_path: path.to_string_lossy().into_owned(),
        stop_found: stop != Shape::Missing,
        prompt_capture_found: capture != Shape::Missing,
        trust: "unknown".into(),
        trust_detail: None,
    }
}

pub async fn probe_trust(status: &mut CodexHookStatus, bin: &str, project: Option<&str>) {
    if !status.installed { return; }
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    let cwd = project.filter(|path| Path::new(path).is_dir()).unwrap_or(&home);
    match crate::codex_app_server::inspect_request(bin, "hooks/list", json!({"cwds":[cwd]})).await {
        Ok(value) => {
            let enabled = hooks_trusted(&value, &status.hooks_path);
            status.trust = if enabled { "trusted" } else { "needs-review" }.into();
            if !enabled { status.trust_detail = Some("Review and enable Redline's Stop and UserPromptSubmit hooks in Codex /hooks.".into()); }
        }
        Err(error) => { status.trust = "unknown".into(); status.trust_detail = Some(error); }
    }
}

/// Codex's `hooks/list` answer shows both of our hooks, in whichever shape
/// `hooks.json` holds them, enabled and trusted. Trust is per definition, so
/// an outdated install that was trusted stays trusted until Install rewrites
/// it.
fn hooks_trusted(listed: &Value, hooks_path: &str) -> bool {
    let hooks: Vec<&Value> = listed["data"].as_array().into_iter().flatten()
        .flat_map(|entry| entry["hooks"].as_array().into_iter().flatten())
        .filter(|hook| hook["sourcePath"].as_str() == Some(hooks_path))
        .collect();
    hook_shapes().iter().all(|(current, previous)| hooks.iter().any(|hook|
        hook["command"].as_str().is_some_and(|command| shape_of(command, current, previous) != Shape::Missing)
            && hook["enabled"] == true
            && matches!(hook["trustStatus"].as_str(), Some("trusted" | "managed"))
    ))
}

/// The best shape of our hook among one matcher entry's handlers.
fn entry_shape(entry: &Value, current: &str, previous: &[&str], asynchronous: bool) -> Shape {
    entry.get("hooks").and_then(Value::as_array).into_iter().flatten()
        .filter(|hook| hook.get("type").and_then(Value::as_str) == Some("command")
            && hook.get("async").and_then(Value::as_bool).unwrap_or(false) == asynchronous)
        .filter_map(|hook| hook.get("command").and_then(Value::as_str))
        .map(|command| shape_of(command, current, previous))
        .max()
        .unwrap_or(Shape::Missing)
}

pub fn install() -> Result<CodexHookStatus, String> {
    install_at(&hooks_path())
}

fn upsert_command(entries: &mut Vec<Value>, url: &str, hook: Value) {
    let mut found = false;
    for entry in entries.iter_mut() {
        if let Some(handlers) = entry.get_mut("hooks").and_then(Value::as_array_mut) {
            handlers.retain_mut(|handler| {
                if !handler.get("command").and_then(Value::as_str).is_some_and(|cmd| crate::hook_conflicts::targets_url(cmd, url)) {
                    return true;
                }
                if found { return false; }
                *handler = hook.clone();
                found = true;
                true
            });
        }
    }
    if !found {
        entries.push(json!({ "hooks": [hook] }));
    }
}

fn install_at(path: &Path) -> Result<CodexHookStatus, String> {
    crate::hook_config::stage(path, install_unlocked_at)?;
    Ok(get_status_at(path))
}

fn install_unlocked_at(path: &Path) -> Result<CodexHookStatus, String> {
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
    let serialized = format!("{serialized}\n");
    if fs::read_to_string(path).ok().as_deref() != Some(&serialized) {
        fs::write(path, serialized).map_err(|e| e.to_string())?;
    }
    Ok(get_status_at(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn updating_a_shared_matcher_preserves_other_handlers_and_removes_only_our_duplicates() {
        let foreign = json!({"type":"command","command":"plannotator","timeout":345600});
        let mut entries = vec![
            json!({"matcher":"*","hooks":[foreign.clone(),{"type":"command","command":format!("curl --max-time 600 {STOP_URL}")}]}),
            json!({"hooks":[{"type":"command","command":format!("/usr/bin/curl {STOP_URL}")}, {"type":"command","command":"another hook"}]}),
        ];
        assert_eq!(entry_shape(&entries[0], &stop_command(), PREVIOUS_STOP_COMMANDS, false), Shape::Missing);
        let current = json!({"type":"command","command":stop_command(),"timeout":HOOK_TIMEOUT_SECS});
        upsert_command(&mut entries, STOP_URL, current.clone());
        assert_eq!(entries[0]["hooks"][0], foreign);
        assert_eq!(entries[0]["hooks"][1], current);
        assert_eq!(entries[0]["matcher"], "*");
        assert_eq!(entries[1]["hooks"].as_array().unwrap().len(), 1);
        assert_eq!(entries[1]["hooks"][0]["command"], "another hook");
        assert_eq!(entry_shape(&entries[0], &stop_command(), PREVIOUS_STOP_COMMANDS, false), Shape::Current);
        assert_eq!(entry_shape(&entries[0], &stop_command(), PREVIOUS_STOP_COMMANDS, true), Shape::Missing);
        let unchanged = entries.clone();
        upsert_command(&mut entries, STOP_URL, current);
        assert_eq!(entries, unchanged);
    }

    /// Both Codex hooks name their dock terminal, through a shell expansion
    /// (single quotes would ship the literal variable name), and the install
    /// from before the header is exactly today's command without it.
    #[test]
    fn both_hooks_forward_the_dock_terminal() {
        for command in [stop_command(), capture_command()] {
            assert!(command.contains("-H \"X-Redline-Terminal: ${REDLINE_TERMINAL_ID:-}\""), "{command}");
        }
        let without_header = |command: String| command.replace(&format!("{} ", terminal_header()), "");
        assert_eq!(PREVIOUS_STOP_COMMANDS, [without_header(stop_command())]);
        assert_eq!(PREVIOUS_CAPTURE_COMMANDS, [without_header(capture_command())]);
    }

    /// Both commands, byte for byte. Status and trust compare these bytes, so
    /// a change strands every existing install as "not installed" unless the
    /// command it replaces joins `PREVIOUS_*_COMMANDS` (when it still works).
    #[test]
    fn commands_are_pinned() {
        assert_eq!(
            stop_command(),
            "/usr/bin/curl -sS --max-time 43200 -X POST -H 'Content-Type: application/json' \
             -H \"X-Redline-Plan-Launch-Id: ${REDLINE_PLAN_LAUNCH_ID:-}\" -H \"X-Redline-Agent: ${REDLINE_AGENT_SEAT:-}\" \
             -H \"X-Redline-Codex-Socket: ${REDLINE_CODEX_SOCKET:-}\" -H \"X-Redline-Terminal: ${REDLINE_TERMINAL_ID:-}\" \
             --data-binary @- http://127.0.0.1:7676/v1/codex/stop"
        );
        assert_eq!(
            capture_command(),
            "/usr/bin/curl -sS --max-time 1 -X POST -H 'Content-Type: application/json' \
             -H \"X-Redline-Plan-Launch-Id: ${REDLINE_PLAN_LAUNCH_ID:-}\" -H \"X-Redline-Agent: ${REDLINE_AGENT_SEAT:-}\" \
             -H \"X-Redline-Terminal: ${REDLINE_TERMINAL_ID:-}\" \
             --data-binary @- http://127.0.0.1:7676/v1/prompts/ingest >/dev/null 2>&1; exit 0"
        );
    }

    fn hooks_file(stop: &str, capture: &str) -> String {
        json!({"hooks":{
            "Stop":[{"hooks":[{"type":"command","command":stop,"timeout":HOOK_TIMEOUT_SECS}]}],
            "UserPromptSubmit":[{"hooks":[{"type":"command","command":capture,"timeout":5,"async":true}]}],
        }}).to_string()
    }

    /// A fresh `hooks.json` path per call. The clock alone is not unique:
    /// tests start in parallel, and macOS reads it to the microsecond.
    fn temp_hooks() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "redline-codex-hook-{}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir.join("hooks.json")
    }

    /// An install from before the terminal header still holds and approves
    /// plans, so it is installed (a restore is not refused over it) and
    /// merely outdated; Install brings it current. One from before the
    /// approval socket, or a command that only resembles ours, is not ours.
    #[test]
    fn an_earlier_working_install_is_installed_but_outdated() {
        let path = temp_hooks();
        let status = |stop: &str, capture: &str| {
            fs::write(&path, hooks_file(stop, capture)).unwrap();
            let status = get_status_at(&path);
            (status.installed, status.outdated)
        };
        let (stop, capture) = (stop_command(), capture_command());
        let (old_stop, old_capture) = (PREVIOUS_STOP_COMMANDS[0], PREVIOUS_CAPTURE_COMMANDS[0]);
        assert_eq!(status(&stop, &capture), (true, false));
        assert_eq!(status(old_stop, old_capture), (true, true));
        assert_eq!(status(&stop, old_capture), (true, true));
        assert_eq!(status(old_stop, &capture), (true, true));

        let before_socket = old_stop.replace("-H \"X-Redline-Codex-Socket: ${REDLINE_CODEX_SOCKET:-}\" ", "");
        assert_ne!(before_socket, old_stop);
        assert_eq!(status(&before_socket, &capture), (false, false));
        assert_eq!(status(&format!("/usr/bin/curl {STOP_URL}"), &capture), (false, false));
        assert_eq!(status(&stop, &format!("{capture} ")), (false, false));
        fs::write(&path, "not json").unwrap();
        assert!(!get_status_at(&path).installed);

        fs::write(&path, hooks_file(old_stop, old_capture)).unwrap();
        let installed = install_at(&path).unwrap();
        assert!(installed.installed && !installed.outdated);
        let root: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(root.pointer("/hooks/Stop/0/hooks/0/command").unwrap(), &json!(stop));
        assert_eq!(root.pointer("/hooks/UserPromptSubmit/0/hooks/0/command").unwrap(), &json!(capture));
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    /// Codex trusts a definition, so an outdated install it trusted stays
    /// verified; an untrusted, disabled or foreign one does not.
    #[test]
    fn trust_follows_whichever_shape_is_installed() {
        let listed = |stop: &str, capture: &str, trust: &str, enabled: bool| json!({"data":[{"hooks":[
            {"sourcePath":"/h.json","command":stop,"enabled":enabled,"trustStatus":trust},
            {"sourcePath":"/h.json","command":capture,"enabled":true,"trustStatus":"trusted"},
        ]}]});
        let (stop, capture) = (stop_command(), capture_command());
        let (old_stop, old_capture) = (PREVIOUS_STOP_COMMANDS[0], PREVIOUS_CAPTURE_COMMANDS[0]);
        assert!(hooks_trusted(&listed(&stop, &capture, "trusted", true), "/h.json"));
        assert!(hooks_trusted(&listed(old_stop, old_capture, "managed", true), "/h.json"));
        assert!(!hooks_trusted(&listed(old_stop, old_capture, "untrusted", true), "/h.json"));
        assert!(!hooks_trusted(&listed(&stop, &capture, "trusted", false), "/h.json"));
        assert!(!hooks_trusted(&listed(&stop, &capture, "trusted", true), "/elsewhere.json"));
        assert!(!hooks_trusted(&listed("echo stop", &capture, "trusted", true), "/h.json"));
    }

    #[test]
    fn install_preserves_foreign_hooks_and_is_idempotent() {
        let path = temp_hooks();
        fs::write(&path, r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo foreign"}]}]}}"#).unwrap();
        assert!(install_at(&path).unwrap().installed);
        assert!(install_at(&path).unwrap().installed);
        let root: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let stops = root.pointer("/hooks/Stop").unwrap().as_array().unwrap();
        assert_eq!(stops.len(), 2);
        assert_eq!(stops.iter().filter(|v| entry_targets(v, STOP_URL)).count(), 1);
        assert!(stops.iter().any(|v| entry_targets(v, "echo foreign")));
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
