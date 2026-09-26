// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Read-only conflict inspection is deliberately independent of CLI preflight.
use crate::hook_config;
use notify_debouncer_mini::{
    new_debouncer,
    notify::{RecommendedWatcher, RecursiveMode},
    DebounceEventResult, Debouncer,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::Duration,
};
use tauri::Emitter;

const PLUGIN: &str = "plannotator@plannotator";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictIdentity {
    pub id: String,
    pub source_path: String,
    pub snapshot: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookConflict {
    pub identity: ConflictIdentity,
    pub backend: String,
    pub event: String,
    pub installation_kind: String,
    pub action: String,
    pub detail: String,
    pub command: Option<String>,
    pub plugin_id: Option<String>,
    #[serde(skip)]
    pointer: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectionError {
    pub source_path: String,
    pub message: String,
}
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictScan {
    pub conflicts: Vec<HookConflict>,
    pub errors: Vec<InspectionError>,
    pub inactive_plugins: Vec<String>,
}
#[derive(Clone, Debug)]
struct Source {
    path: PathBuf,
    backend: String,
    managed: bool,
}

fn sources(backend: Option<&str>, project: Option<&Path>) -> Vec<Source> {
    let mut out = Vec::new();
    if backend.is_none() || backend == Some("claude-code") {
        let user_local = crate::hook::settings_path().with_file_name("settings.local.json");
        for path in crate::hook::workflow_settings_files(project) {
            // Claude's local override is project-scoped, not a user file.
            if path == user_local {
                continue;
            }
            let managed = path
                .file_name()
                .is_some_and(|n| n == "managed-settings.json");
            out.push(Source {
                path,
                backend: "claude-code".into(),
                managed,
            });
        }
    }
    if backend.is_none() || backend == Some("codex") {
        out.push(Source {
            path: crate::codex_hook::hooks_path(),
            backend: "codex".into(),
            managed: false,
        });
        if let Some(project) = project {
            let path = project.join(".codex/hooks.json");
            if !out.iter().any(|s| s.path == path) {
                out.push(Source {
                    path,
                    backend: "codex".into(),
                    managed: false,
                });
            }
        }
    }
    out
}

#[derive(Debug, PartialEq)]
enum Recognition {
    Direct,
    Manual,
    None,
}
fn executable(word: &str, expected: &str) -> bool {
    word.rsplit(['/', '\\'])
        .next()
        .is_some_and(|s| s == expected || s == format!("{expected}.exe"))
}

/// A small non-executing shell lexer. It handles quoted executable paths and
/// prefixes but marks expansion, redirection and compound commands ambiguous.
fn words(command: &str) -> (Vec<String>, bool) {
    let mut out = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut escaped = false;
    let mut safe = true;
    let mut started = false;
    for c in command.chars() {
        if escaped {
            word.push(c);
            escaped = false;
            started = true;
            continue;
        }
        if c == '\\' && quote != Some('\'') {
            escaped = true;
            continue;
        }
        if let Some(q) = quote {
            if c == q {
                quote = None;
            } else {
                if q == '"' && matches!(c, '$' | '`') {
                    safe = false;
                }
                word.push(c);
            }
            continue;
        }
        if c == '\'' || c == '"' {
            quote = Some(c);
            started = true;
        } else if c.is_whitespace() || matches!(c, ';' | '|' | '&' | '<' | '>' | '(' | ')') {
            if !c.is_whitespace() || c == '\n' {
                safe = false;
            }
            if started {
                out.push(std::mem::take(&mut word));
                started = false;
            }
        } else {
            if matches!(c, '$' | '`' | '*' | '?' | '{' | '}') {
                safe = false;
            }
            word.push(c);
            started = true;
        }
    }
    if started {
        out.push(word);
    }
    (out, safe && quote.is_none() && !escaped)
}
/// Shared token parsing for Redline's known curl adapters. A hostname or URL
/// merely containing the bridge URL does not establish handler ownership.
pub(crate) fn targets_url(command: &str, url: &str) -> bool {
    // Claude's capture adapter needs this exact response-forwarding wrapper;
    // Codex and older capture adapters invoke curl directly. Strip only our
    // known wrapper, never an arbitrary shell expression containing curl.
    const CAPTURE_TAIL: &str = "); case \"$resp\" in *hookSpecificOutput*) printf '%s' \"$resp\";; esac; exit 0";
    let invocation = command.strip_prefix("resp=$(")
        .and_then(|body| body.strip_suffix(CAPTURE_TAIL))
        .unwrap_or(command);
    let (tokens, _) = words(invocation);
    // Redline writes a direct curl invocation. Merely mentioning that command
    // in an echo, logger, or wrapper does not grant ownership of the handler.
    tokens.first().is_some_and(|t| executable(t, "curl"))
        && tokens.iter().any(|t| t == url)
}
fn assignment(word: &str) -> bool {
    let Some((name, _)) = word.split_once('=') else {
        return false;
    };
    !name.is_empty()
        && name
            .chars()
            .enumerate()
            .all(|(i, c)| c == '_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit()))
}
fn recognize(command: &str) -> Recognition {
    recognize_inner(command, 0)
}
fn recognize_inner(command: &str, depth: usize) -> Recognition {
    let (tokens, safe) = words(command);
    let candidate = tokens.iter().any(|s| executable(s, "plannotator"));
    if depth > 3 {
        return if candidate {
            Recognition::Manual
        } else {
            Recognition::None
        };
    }
    let mut i = 0;
    while i < tokens.len() && assignment(&tokens[i]) {
        i += 1;
    }
    loop {
        let Some(token) = tokens.get(i) else {
            return Recognition::None;
        };
        if executable(token, "env") {
            i += 1;
            while i < tokens.len()
                && (assignment(&tokens[i])
                    || matches!(tokens[i].as_str(), "--" | "-i" | "--ignore-environment"))
            {
                i += 1;
            }
        } else if matches!(token.as_str(), "command" | "exec") {
            i += 1;
            if tokens.get(i).is_some_and(|s| s == "--") {
                i += 1;
            }
        } else {
            break;
        }
    }
    if let Some(token) = tokens.get(i) {
        if ["sh", "bash", "zsh"]
            .iter()
            .any(|name| executable(token, name))
            && tokens.get(i + 1).is_some_and(|s| s == "-c" || s == "-lc")
            && tokens.len() == i + 3
        {
            let nested = recognize_inner(&tokens[i + 2], depth + 1);
            return if safe {
                nested
            } else if nested != Recognition::None {
                Recognition::Manual
            } else {
                Recognition::None
            };
        }
        // Only the documented no-argument plan handler is automatically owned.
        if executable(token, "plannotator") {
            return if safe && tokens.len() == i + 1 && !token.contains(['$', '`']) {
                Recognition::Direct
            } else {
                Recognition::Manual
            };
        }
    }
    if candidate {
        Recognition::Manual
    } else {
        Recognition::None
    }
}

pub(crate) fn matcher_covers_plan(entry: &Value) -> bool {
    match entry.get("matcher").and_then(Value::as_str) {
        None | Some("") | Some("*") => true,
        Some(pattern) => regex_lite::Regex::new(pattern).is_ok_and(|r| r.is_match("ExitPlanMode")),
    }
}

fn validate(root: &Value) -> Result<(), String> {
    if !root.is_object() {
        return Err("configuration root is not a JSON object".into());
    }
    if let Some(hooks) = root.get("hooks") {
        let hooks = hooks.as_object().ok_or("hooks is not a JSON object")?;
        for (event, entries) in hooks {
            for entry in entries
                .as_array()
                .ok_or_else(|| format!("hooks.{event} is not an array"))?
            {
                if !entry.is_object() {
                    return Err(format!("hooks.{event} contains a non-object matcher"));
                }
                if let Some(matcher) = entry.get("matcher") {
                    let pattern = matcher.as_str().ok_or("hook matcher is not a string")?;
                    if pattern != "*" {
                        regex_lite::Regex::new(pattern)
                            .map_err(|e| format!("invalid hook matcher: {e}"))?;
                    }
                }
                let handlers = entry
                    .get("hooks")
                    .and_then(Value::as_array)
                    .ok_or_else(|| format!("hooks.{event} matcher has no handler array"))?;
                if handlers.iter().any(|h| {
                    !h.is_object()
                        || h.get("type").and_then(Value::as_str).is_none()
                        || (h.get("type").and_then(Value::as_str) == Some("command")
                            && h.get("command").and_then(Value::as_str).is_none())
                }) {
                    return Err(format!("hooks.{event} contains an invalid handler"));
                }
            }
        }
    }
    if let Some(plugins) = root.get("enabledPlugins") {
        if !plugins
            .as_object()
            .is_some_and(|p| p.values().all(Value::is_boolean))
        {
            return Err("enabledPlugins must map plugin registrations to booleans".into());
        }
    }
    Ok(())
}

fn make_conflict(
    (source, snapshot): (&Source, &str),
    pointer: String,
    event: &str,
    kind: &str,
    action: &str,
    detail: &str,
    command: Option<String>,
) -> HookConflict {
    let source_path = source.path.to_string_lossy().into_owned();
    let id = hook_config::fingerprint(
        format!(
            "{source_path}\n{pointer}\n{}",
            command.as_deref().unwrap_or(PLUGIN)
        )
        .as_bytes(),
    );
    HookConflict {
        identity: ConflictIdentity {
            id,
            source_path,
            snapshot: snapshot.into(),
        },
        backend: source.backend.clone(),
        event: event.into(),
        installation_kind: kind.into(),
        action: action.into(),
        detail: detail.into(),
        command,
        plugin_id: (kind == "plugin").then(|| PLUGIN.into()),
        pointer,
    }
}

fn scan_sources(sources: &[Source]) -> ConflictScan {
    let mut scan = ConflictScan::default();
    let mut plugin: Option<(Source, String, bool)> = None;
    let mut claude_error = false;
    for source in sources {
        let inspected = (|| -> Result<Option<(Value, String)>, String> {
            let Some(bytes) = hook_config::read(&source.path)? else {
                return Ok(None);
            };
            let root = serde_json::from_slice(&bytes).map_err(|e| format!("invalid JSON: {e}"))?;
            validate(&root)?;
            Ok(Some((root, hook_config::fingerprint(&bytes))))
        })();
        let (root, snapshot) = match inspected {
            Ok(Some(pair)) => pair,
            Ok(None) => continue,
            Err(message) => {
                if source.backend == "claude-code" {
                    claude_error = true;
                }
                scan.errors.push(InspectionError {
                    source_path: source.path.to_string_lossy().into_owned(),
                    message,
                });
                continue;
            }
        };
        if source.backend == "claude-code" {
            if let Some(enabled) = root
                .get("enabledPlugins")
                .and_then(|p| p.get(PLUGIN))
                .and_then(Value::as_bool)
            {
                plugin = Some((source.clone(), snapshot.clone(), enabled));
            }
        }
        let events: &[&str] = if source.backend == "codex" {
            &["Stop"]
        } else {
            &["PreToolUse", "PermissionRequest"]
        };
        for event in events {
            let Some(entries) = root
                .get("hooks")
                .and_then(|h| h.get(event))
                .and_then(Value::as_array)
            else {
                continue;
            };
            for (ei, entry) in entries.iter().enumerate() {
                if source.backend == "claude-code" && !matcher_covers_plan(entry) {
                    continue;
                }
                for (hi, handler) in entry["hooks"].as_array().unwrap().iter().enumerate() {
                    if handler.get("type").and_then(Value::as_str) != Some("command") {
                        continue;
                    }
                    let command = handler["command"].as_str().unwrap();
                    let recognized = recognize(command);
                    if recognized == Recognition::None {
                        continue;
                    }
                    let writable = !source.managed
                        && !std::fs::symlink_metadata(&source.path).is_ok_and(|m| {
                            m.file_type().is_symlink() || m.permissions().readonly()
                        });
                    let (kind, action, detail) = if !writable {
                        ("managed", "view", "This configuration is managed, read-only, or a symlink. Edit it at its source; automatic removal is unavailable.")
                    } else if recognized == Recognition::Manual {
                        ("wrapper", "view", "This command may invoke Plannotator through an unrecognized wrapper or additional shell actions. Inspect it manually to preserve those actions.")
                    } else {
                        ("direct", "removeHooks", "Remove only the identified Plannotator plan handlers in this file. Keep other hooks, the Plannotator executable, and saved reviews.")
                    };
                    scan.conflicts.push(make_conflict(
                        (source, &snapshot),
                        format!("/hooks/{event}/{ei}/hooks/{hi}"),
                        event,
                        kind,
                        action,
                        detail,
                        Some(command.into()),
                    ));
                }
            }
        }
    }
    if let Some((source, snapshot, enabled)) = plugin {
        if enabled {
            let writable = !source.managed
                && !claude_error
                && !std::fs::symlink_metadata(&source.path)
                    .is_ok_and(|m| m.file_type().is_symlink() || m.permissions().readonly());
            scan.conflicts.push(make_conflict((&source, &snapshot), format!("/enabledPlugins/{PLUGIN}"), "PermissionRequest / ExitPlanMode", "plugin", if writable { "disablePlugin" } else { "view" },
                if writable { "Disable the exact Plannotator plugin registration in this scope. This also disables its other bundled features; the executable and saved reviews remain." } else { "Plugin precedence cannot be safely edited in this scope. Inspect the configuration and any reported inspection errors." }, None));
        } else {
            scan.inactive_plugins
                .push(source.path.to_string_lossy().into_owned());
        }
    }
    scan
}

#[tauri::command(async)]
pub fn scan_hook_conflicts(backend: Option<String>, project_path: Option<String>) -> ConflictScan {
    scan_sources(&sources(
        backend.as_deref(),
        project_path.as_deref().map(Path::new),
    ))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovalResult {
    pub source_path: String,
    pub changed: bool,
    pub backup_path: Option<String>,
    pub error: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovalReport {
    pub results: Vec<RemovalResult>,
    pub scan: ConflictScan,
}

fn remove_at(sources: &[Source], identities: &[ConflictIdentity]) -> RemovalReport {
    let _guard = hook_config::lock();
    let mut groups: BTreeMap<String, Vec<&ConflictIdentity>> = BTreeMap::new();
    for identity in identities {
        groups
            .entry(identity.source_path.clone())
            .or_default()
            .push(identity);
    }
    let mut results = Vec::new();
    for (source_path, requested) in groups {
        let result = (|| -> Result<Option<PathBuf>, String> {
            let source = sources
                .iter()
                .find(|s| s.path.to_string_lossy() == source_path)
                .ok_or("configuration is outside the selected backend and project")?;
            let scan = scan_sources(sources);
            if let Some(error) = scan.errors.iter().find(|e| e.source_path == source_path) {
                return Err(error.message.clone());
            }
            let selected: Vec<_> = scan
                .conflicts
                .iter()
                .filter(|c| {
                    c.identity.source_path == source_path
                        && requested.iter().any(|r| r.id == c.identity.id)
                })
                .collect();
            if selected.is_empty() {
                return Ok(None);
            }
            if selected.iter().any(|c| c.action == "view") {
                return Err("automatic removal is unavailable for this configuration".into());
            }
            let original = hook_config::read(&source.path)?
                .ok_or("configuration disappeared; refresh and retry")?;
            let snapshot = hook_config::fingerprint(&original);
            if requested.iter().any(|r| r.snapshot != snapshot) {
                return Err("configuration changed since inspection; refresh and retry".into());
            }
            let mut root: Value = serde_json::from_slice(&original).map_err(|e| e.to_string())?;
            validate(&root)?;
            let mut pointers: Vec<_> = selected
                .iter()
                .filter(|c| c.action == "removeHooks")
                .map(|c| c.pointer.clone())
                .collect();
            // Remove descending array indexes, so one edit cannot shift another.
            pointers.sort_by_key(|p| {
                p.rsplit('/')
                    .next()
                    .and_then(|s| s.parse::<usize>().ok())
                    .unwrap_or(0)
            });
            for pointer in pointers.into_iter().rev() {
                let (parent, index) = pointer.rsplit_once('/').unwrap();
                let handlers = root
                    .pointer_mut(parent)
                    .and_then(Value::as_array_mut)
                    .ok_or("handler changed during removal")?;
                let index = index.parse::<usize>().map_err(|e| e.to_string())?;
                if handlers
                    .get(index)
                    .and_then(|h| h.get("command"))
                    .and_then(Value::as_str)
                    .map(recognize)
                    != Some(Recognition::Direct)
                {
                    return Err("handler ownership changed; refresh and retry".into());
                }
                handlers.remove(index);
            }
            // Only containers touched by this action are candidates for pruning.
            let touched: HashSet<_> = selected
                .iter()
                .filter(|c| c.action == "removeHooks")
                .map(|c| c.event.clone())
                .collect();
            let changed_hooks = !touched.is_empty();
            for event in touched {
                let affected: HashSet<usize> = selected
                    .iter()
                    .filter(|c| c.event == event)
                    .filter_map(|c| c.pointer.split('/').nth(3)?.parse().ok())
                    .collect();
                if let Some(entries) = root
                    .get_mut("hooks")
                    .and_then(|h| h.get_mut(&event))
                    .and_then(Value::as_array_mut)
                {
                    let mut index = 0;
                    entries.retain(|entry| {
                        let remove = affected.contains(&index)
                            && entry["hooks"].as_array().is_some_and(Vec::is_empty)
                            && !entry.as_object().is_some_and(|obj|
                                obj.keys().any(|key| key != "matcher" && key != "hooks"));
                        index += 1;
                        !remove
                    });
                    if entries.is_empty() {
                        root["hooks"].as_object_mut().unwrap().remove(&event);
                    }
                }
            }
            if changed_hooks && root
                .get("hooks")
                .and_then(Value::as_object)
                .is_some_and(|h| h.is_empty())
            {
                root.as_object_mut().unwrap().remove("hooks");
            }
            if selected.iter().any(|c| c.action == "disablePlugin") {
                root["enabledPlugins"][PLUGIN] = Value::Bool(false);
            }
            hook_config::replace(&source.path, Some(&original), &root)
        })();
        match result {
            Ok(backup) => results.push(RemovalResult {
                source_path,
                changed: backup.is_some(),
                backup_path: backup.map(|p| p.to_string_lossy().into_owned()),
                error: None,
            }),
            Err(error) => results.push(RemovalResult {
                source_path,
                changed: false,
                backup_path: None,
                error: Some(error),
            }),
        }
    }
    RemovalReport {
        results,
        scan: scan_sources(sources),
    }
}
#[tauri::command(async)]
pub fn remove_hook_conflicts(
    backend: Option<String>,
    project_path: Option<String>,
    identities: Vec<ConflictIdentity>,
) -> RemovalReport {
    remove_at(
        &sources(backend.as_deref(), project_path.as_deref().map(Path::new)),
        &identities,
    )
}

static WATCHES: LazyLock<Mutex<HashMap<String, Debouncer<RecommendedWatcher>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Changed {
    watch_id: String,
}
#[tauri::command(async)]
pub fn watch_hook_conflicts(
    app: tauri::AppHandle,
    backend: Option<String>,
    project_path: Option<String>,
) -> Result<String, String> {
    let paths: Vec<_> = sources(backend.as_deref(), project_path.as_deref().map(Path::new))
        .into_iter()
        .map(|s| s.path)
        .collect();
    let watch_id = uuid::Uuid::new_v4().to_string();
    let event_id = watch_id.clone();
    let targets = paths.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(200),
        move |result: DebounceEventResult| {
            let relevant = match result {
                Ok(events) => events.iter().any(|e| {
                    targets
                        .iter()
                        .any(|p| p == &e.path || p.starts_with(&e.path))
                }),
                Err(_) => true, // Focus refresh remains available if the watcher fails.
            };
            if relevant {
                let _ = app.emit(
                    "hook-config-changed",
                    Changed {
                        watch_id: event_id.clone(),
                    },
                );
            }
        },
    )
    .map_err(|e| e.to_string())?;
    let mut dirs = HashSet::new();
    for path in paths {
        let mut parent = path.parent();
        while let Some(dir) = parent {
            if dir.is_dir() {
                dirs.insert(dir.to_path_buf());
                break;
            }
            parent = dir.parent();
        }
    }
    for dir in dirs {
        debouncer
            .watcher()
            .watch(&dir, RecursiveMode::NonRecursive)
            .map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    WATCHES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(watch_id.clone(), debouncer);
    Ok(watch_id)
}
#[tauri::command(async)]
pub fn unwatch_hook_conflicts(watch_id: String) {
    WATCHES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&watch_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    struct Fixture {
        dir: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("redline-conflicts-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&dir).unwrap();
            Self { dir }
        }
        fn source(&self, name: &str, backend: &str, value: Value) -> Source {
            let path = self.dir.join(name);
            fs::write(&path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
            Source {
                path,
                backend: backend.into(),
                managed: false,
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }
    fn direct(command: &str) -> Value {
        json!({"type":"command","command":command,"timeout":345600})
    }
    fn identities(scan: &ConflictScan) -> Vec<ConflictIdentity> {
        scan.conflicts.iter().map(|c| c.identity.clone()).collect()
    }

    #[test]
    fn executable_paths_quotes_and_safe_prefixes_are_owned_conservatively() {
        for command in [
            "plannotator",
            "/Users/yusufalbazian/.local/bin/plannotator",
            "'/a path/plannotator'",
            "PLANNOTATOR_REMOTE=1 plannotator",
            "env PLANNOTATOR_PORT=9999 /bin/plannotator",
            "env -i command -- plannotator",
            "exec plannotator",
            "bash -lc 'env PLANNOTATOR_REMOTE=1 plannotator'",
        ] {
            assert_eq!(recognize(command), Recognition::Direct, "{command}");
        }
        for command in [
            "plannotator && notify",
            "wrapper plannotator",
            "plannotator --unknown",
            "plannotator > /tmp/log",
            "'$HOME/bin/plannotator'",
            "sh -c 'plannotator; echo done'",
            "plannotator | tee out",
        ] {
            assert_ne!(recognize(command), Recognition::Direct, "{command}");
        }
        for command in [
            "my-plannotator",
            "/bin/plannotator-helper",
            "echo https://plannotator.ai",
            "printf plannotator-is-installed",
            "curl http://127.0.0.1:7676/v1/plan",
        ] {
            assert_eq!(recognize(command), Recognition::None, "{command}");
        }
    }

    #[test]
    fn redline_curl_ownership_does_not_claim_mentions_or_lookalike_urls() {
        let url = "http://127.0.0.1:7676/v1/prompts/ingest";
        assert!(targets_url(&format!("/usr/bin/curl -s {url}"), url));
        assert!(targets_url(&format!("resp=$(curl -s {url} 2>/dev/null); case \"$resp\" in *hookSpecificOutput*) printf '%s' \"$resp\";; esac; exit 0"), url));
        for command in [
            format!("echo curl {url}"),
            format!("logger curl {url}"),
            format!("curl https://example.com/?next={url}"),
            format!("curl {url}/other"),
        ] {
            assert!(!targets_url(&command, url), "{command}");
        }
    }

    #[test]
    fn installed_codex_two_handler_fixture_removes_only_plannotator_and_backs_up() {
        let fixture = Fixture::new();
        let redline =
            direct("/usr/bin/curl -sS --data-binary @- http://127.0.0.1:7676/v1/codex/stop");
        let original = json!({"permissions":{"allow":["untouched"]},"hooks":{"Stop":[{"matcher":"*","custom":"keep","hooks":[direct("/Users/yusufalbazian/.local/bin/plannotator"),redline.clone()]}],"UserPromptSubmit":[{"hooks":[direct("capture")]}]}});
        let source = fixture.source("hooks.json", "codex", original.clone());
        let before = fs::read(&source.path).unwrap();
        let scan = scan_sources(&[source.clone()]);
        assert_eq!(scan.conflicts.len(), 1);
        assert!(scan.errors.is_empty());
        let ids = identities(&scan);
        let report = remove_at(&[source.clone()], &ids);
        assert!(report.results[0].changed);
        assert!(report.scan.conflicts.is_empty());
        assert_eq!(
            fs::read(report.results[0].backup_path.as_ref().unwrap()).unwrap(),
            before
        );
        let after: Value = serde_json::from_slice(&fs::read(&source.path).unwrap()).unwrap();
        assert_eq!(after["hooks"]["Stop"][0]["hooks"], json!([redline]));
        assert_eq!(after["hooks"]["Stop"][0]["custom"], "keep");
        assert_eq!(after["permissions"], original["permissions"]);
        assert_eq!(
            after["hooks"]["UserPromptSubmit"],
            original["hooks"]["UserPromptSubmit"]
        );
        let again = remove_at(&[source], &ids);
        assert!(!again.results[0].changed);
        assert!(again.results[0].error.is_none());
    }

    #[test]
    fn claude_inspects_every_handler_both_plan_events_and_regex_matchers() {
        let fixture = Fixture::new();
        let source = fixture.source("settings.json", "claude-code", json!({"hooks":{
            "PreToolUse":[{"matcher":"Edit|ExitPlanMode","hooks":[direct("other"),direct("plannotator"),direct("plannotator")]}],
            "PermissionRequest":[{"matcher":"^ExitPlanMode$","hooks":[direct("env PLANNOTATOR_REMOTE=1 plannotator")]}],
            "PostToolUse":[{"matcher":"ExitPlanMode","hooks":[direct("plannotator")]}]
        }}));
        let scan = scan_sources(&[source.clone()]);
        assert_eq!(scan.conflicts.len(), 3);
        let report = remove_at(&[source.clone()], &identities(&scan));
        assert!(report.scan.conflicts.is_empty());
        let after: Value = serde_json::from_slice(&fs::read(&source.path).unwrap()).unwrap();
        assert_eq!(
            after["hooks"]["PreToolUse"][0]["hooks"],
            json!([direct("other")])
        );
        assert!(after["hooks"].get("PermissionRequest").is_none());
        assert!(after["hooks"].get("PostToolUse").is_some());
    }

    #[test]
    fn enabled_plugin_precedence_and_exact_registration_are_preserved() {
        let fixture = Fixture::new();
        let user = fixture.source(
            "user.json",
            "claude-code",
            json!({"enabledPlugins":{PLUGIN:true,"other@market":true}}),
        );
        let project = fixture.source(
            "project.json",
            "claude-code",
            json!({"enabledPlugins":{PLUGIN:false}}),
        );
        let scan = scan_sources(&[user.clone(), project.clone()]);
        assert!(scan.conflicts.is_empty());
        assert_eq!(scan.inactive_plugins.len(), 1);
        fs::write(
            &project.path,
            serde_json::to_vec(&json!({"enabledPlugins":{PLUGIN:true,"unrelated@market":true}}))
                .unwrap(),
        )
        .unwrap();
        let scan = scan_sources(&[user.clone(), project.clone()]);
        assert_eq!(scan.conflicts.len(), 1);
        assert_eq!(
            scan.conflicts[0].identity.source_path,
            project.path.to_string_lossy()
        );
        let report = remove_at(&[user.clone(), project.clone()], &identities(&scan));
        assert!(report.scan.conflicts.is_empty());
        let root: Value = serde_json::from_slice(&fs::read(&project.path).unwrap()).unwrap();
        assert_eq!(root["enabledPlugins"][PLUGIN], false);
        assert_eq!(root["enabledPlugins"]["unrelated@market"], true);
        assert!(fs::read_to_string(user.path).unwrap().contains("true"));
    }

    #[test]
    fn removing_last_handler_preserves_matcher_metadata_and_untouched_containers() {
        let fixture = Fixture::new();
        let source = fixture.source("hooks.json", "codex", json!({"hooks":{"Stop":[
            {"matcher":"*","label":"keep me","hooks":[direct("plannotator")]},
            {"matcher":"*","hooks":[]}
        ]}}));
        let scan = scan_sources(&[source.clone()]);
        let report = remove_at(&[source.clone()], &identities(&scan));
        assert!(report.results[0].changed);
        let root: Value = serde_json::from_slice(&fs::read(source.path).unwrap()).unwrap();
        assert_eq!(root["hooks"]["Stop"][0]["label"], "keep me");
        assert_eq!(root["hooks"]["Stop"][0]["hooks"], json!([]));
        assert_eq!(root["hooks"]["Stop"].as_array().unwrap().len(), 2);

        let plugin = fixture.source("settings.json", "claude-code", json!({"hooks":{},"enabledPlugins":{PLUGIN:true}}));
        let scan = scan_sources(&[plugin.clone()]);
        let report = remove_at(&[plugin.clone()], &identities(&scan));
        assert!(report.results[0].changed);
        let root: Value = serde_json::from_slice(&fs::read(plugin.path).unwrap()).unwrap();
        assert_eq!(root.get("hooks"), Some(&json!({})));
    }

    #[test]
    fn managed_plugin_precedence_and_disabled_installations_are_not_removable() {
        let fixture = Fixture::new();
        let user = fixture.source("user.json", "claude-code", json!({"enabledPlugins":{PLUGIN:true}}));
        let mut managed = fixture.source("managed.json", "claude-code", json!({"enabledPlugins":{PLUGIN:false}}));
        managed.managed = true;
        let scan = scan_sources(&[user.clone(), managed.clone()]);
        assert!(scan.conflicts.is_empty());
        assert_eq!(scan.inactive_plugins, vec![managed.path.to_string_lossy().into_owned()]);
        fs::write(&managed.path, serde_json::to_vec(&json!({"enabledPlugins":{PLUGIN:true}})).unwrap()).unwrap();
        let scan = scan_sources(&[user, managed]);
        assert_eq!(scan.conflicts.len(), 1);
        assert_eq!(scan.conflicts[0].action, "view");
    }

    #[test]
    fn managed_and_wrapped_hooks_have_only_manual_actions() {
        let fixture = Fixture::new();
        let mut managed = fixture.source(
            "managed.json",
            "claude-code",
            json!({"enabledPlugins":{PLUGIN:true}}),
        );
        managed.managed = true;
        let wrapper = fixture.source(
            "hooks.json",
            "codex",
            json!({"hooks":{"Stop":[{"hooks":[direct("wrapper plannotator")]}]}}),
        );
        let inputs = [managed, wrapper];
        let scan = scan_sources(&inputs);
        assert_eq!(scan.conflicts.len(), 2);
        assert!(scan.conflicts.iter().all(|c| c.action == "view"));
        assert!(remove_at(&inputs, &identities(&scan))
            .results
            .iter()
            .all(|r| r.error.is_some()));
    }

    #[test]
    fn malformed_unreadable_and_invalid_shapes_report_inspection_errors() {
        let fixture = Fixture::new();
        for invalid in [
            "{",
            "[]",
            "{\"hooks\": []}",
            "{\"hooks\":{\"Stop\":[{\"hooks\":{}}]}}",
            "{\"enabledPlugins\":{\"plannotator@plannotator\":\"yes\"}}",
        ] {
            let source = fixture.source("bad.json", "codex", json!({}));
            fs::write(&source.path, invalid).unwrap();
            let scan = scan_sources(&[source]);
            assert_eq!(scan.errors.len(), 1, "{invalid}");
        }
        let source = Source {
            path: fixture.dir.clone(),
            backend: "codex".into(),
            managed: false,
        };
        assert_eq!(scan_sources(&[source]).errors.len(), 1);
    }

    #[test]
    fn stale_snapshot_refuses_external_edits_and_partial_failure_keeps_conflict() {
        let fixture = Fixture::new();
        let config = json!({"hooks":{"Stop":[{"hooks":[direct("plannotator")]}]}});
        let a = fixture.source("a.json", "codex", config.clone());
        let b = fixture.source("b.json", "codex", config.clone());
        let sources = [a.clone(), b.clone()];
        let scan = scan_sources(&sources);
        let mut external = config;
        external["external"] = json!(true);
        fs::write(&b.path, serde_json::to_vec(&external).unwrap()).unwrap();
        let report = remove_at(&sources, &identities(&scan));
        assert_eq!(report.results.iter().filter(|r| r.changed).count(), 1);
        assert_eq!(
            report.results.iter().filter(|r| r.error.is_some()).count(),
            1
        );
        assert_eq!(report.scan.conflicts.len(), 1);
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(b.path).unwrap()).unwrap(),
            external
        );
    }

    #[test]
    fn removal_rejects_paths_outside_selected_project() {
        let fixture = Fixture::new();
        let source = fixture.source(
            "outside.json",
            "codex",
            json!({"hooks":{"Stop":[{"hooks":[direct("plannotator")]}]}}),
        );
        let scan = scan_sources(&[source]);
        assert!(remove_at(&[], &identities(&scan)).results[0]
            .error
            .is_some());
        let selected = Path::new("/tmp/selected-project");
        let sources = sources(Some("codex"), Some(selected));
        assert!(sources
            .iter()
            .any(|s| s.path == selected.join(".codex/hooks.json")));
        assert!(!sources
            .iter()
            .any(|s| s.path.starts_with("/tmp/unselected-project")));
    }

    #[cfg(unix)]
    #[test]
    fn atomic_replace_preserves_permissions_and_rejects_read_only_files() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new();
        let source = fixture.source(
            "mode.json",
            "codex",
            json!({"hooks":{"Stop":[{"hooks":[direct("plannotator")]}]}}),
        );
        fs::set_permissions(&source.path, fs::Permissions::from_mode(0o640)).unwrap();
        let scan = scan_sources(&[source.clone()]);
        let report = remove_at(&[source.clone()], &identities(&scan));
        assert!(report.results[0].changed);
        assert_eq!(
            fs::metadata(&source.path).unwrap().permissions().mode() & 0o777,
            0o640
        );
        let original = fs::read(&source.path).unwrap();
        fs::set_permissions(&source.path, fs::Permissions::from_mode(0o400)).unwrap();
        assert!(
            hook_config::replace(&source.path, Some(&original), &json!({"changed":true})).is_err()
        );
        assert_eq!(fs::read(&source.path).unwrap(), original);
    }
}
