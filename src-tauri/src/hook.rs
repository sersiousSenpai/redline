// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
use std::fs;
use std::path::PathBuf;

use polis_server::hook::CaptureHookSpec;
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

/// The full set of bridge-curl allow rules backfilled into settings.json. The
/// permission matcher is a literal command-prefix glob, so a quoted URL
/// (`curl -s 'http://…`) does NOT match the unquoted prefix — agents that add a
/// `?tab=` query single-quote the URL to protect the shell `?`/`&`, and without
/// the quoted variants those calls bounce for approval. All three stay scoped to
/// the same localhost daemon; only the quoting tolerance differs.
const RESTORE_CURL_ALLOWS: &[&str] = &[
    RESTORE_CURL_ALLOW,
    "Bash(curl -s 'http://127.0.0.1:7676/*)",
    "Bash(curl -s \"http://127.0.0.1:7676/*)",
];

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
        .is_some_and(|a| {
            let present: std::collections::HashSet<&str> =
                a.iter().filter_map(|v| v.as_str()).collect();
            RESTORE_CURL_ALLOWS.iter().all(|r| present.contains(r))
        })
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
    for rule in RESTORE_CURL_ALLOWS {
        if ensure_allow(obj, rule).is_err() {
            return;
        }
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

/// The locally visible ways Claude Code's native multi-agent workflows can be
/// silently disabled. Workflows degrade to sequential execution with **no
/// error** when disabled, so the Orchestrate launch modal warns up front on
/// the two signals Redline can actually see: `"disableWorkflows": true` in
/// `~/.claude/settings.json`, and `CLAUDE_CODE_DISABLE_WORKFLOWS` in the
/// environment Redline's PTYs inherit. (The plan-tier toggle is not locally
/// detectable — the launch toast covers that gap by telling the user to
/// expect a workflow approval card.)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowAvailability {
    pub disabled_in_settings: bool,
    pub disabled_in_env: bool,
    /// Which settings file turned it off, so the modal can name the file
    /// instead of saying "somewhere". `None` when nothing did.
    pub settings_source: Option<String>,
    /// Always true, and stated rather than implied: the run executes inside
    /// `$SHELL -l`, which sources the user's rc files AFTER Redline's own
    /// environment is inherited. An `export CLAUDE_CODE_DISABLE_WORKFLOWS=1`
    /// in `~/.zshrc` is therefore fully active in the run and completely
    /// invisible here. `disabled_in_env: false` means "not in OUR env",
    /// never "not set" — the durable answer is the run's own mode chip.
    pub env_unreadable: bool,
}

/// Every settings file that can carry `disableWorkflows`, in ASCENDING
/// precedence — later entries override earlier ones.
///
/// `settings_path()` alone resolved only `~/.claude/settings.json`, so a flag
/// in `settings.local.json`, in the project's `.claude/`, or in managed
/// settings was simply unread and the probe reported "available" with
/// confidence it had not earned.
pub fn workflow_settings_files(project_dir: Option<&std::path::Path>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    if let Some(home) = &home {
        out.push(home.join(".claude").join("settings.json"));
        out.push(home.join(".claude").join("settings.local.json"));
    }
    if let Some(dir) = project_dir {
        out.push(dir.join(".claude").join("settings.json"));
        out.push(dir.join(".claude").join("settings.local.json"));
    }
    // Managed (enterprise) settings outrank everything a user can write.
    #[cfg(target_os = "macos")]
    out.push(PathBuf::from(
        "/Library/Application Support/ClaudeCode/managed-settings.json",
    ));
    #[cfg(target_os = "windows")]
    out.push(PathBuf::from(
        "C:\\ProgramData\\ClaudeCode\\managed-settings.json",
    ));
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    out.push(PathBuf::from("/etc/claude-code/managed-settings.json"));
    out
}

fn read_json(path: &std::path::Path) -> Option<Value> {
    serde_json::from_str::<Value>(&fs::read_to_string(path).ok()?).ok()
}

/// The highest-precedence file that states `disableWorkflows`, and what it
/// said. A file that doesn't mention the key does not override one that does.
fn disable_workflows_from(files: &[PathBuf]) -> (bool, Option<String>) {
    let mut disabled = false;
    let mut source = None;
    for f in files {
        let Some(stated) = read_json(f)
            .as_ref()
            .and_then(|j| j.get("disableWorkflows"))
            .and_then(|v| v.as_bool())
        else {
            continue;
        };
        disabled = stated;
        source = stated.then(|| f.display().to_string());
    }
    (disabled, source)
}

pub fn workflow_availability(project_dir: Option<&std::path::Path>) -> WorkflowAvailability {
    workflow_availability_for(&workflow_settings_files(project_dir))
}

pub fn workflow_availability_for(files: &[PathBuf]) -> WorkflowAvailability {
    let (disabled_in_settings, settings_source) = disable_workflows_from(files);
    let disabled_in_env = std::env::var("CLAUDE_CODE_DISABLE_WORKFLOWS")
        .map(|v| {
            let v = v.trim();
            !v.is_empty() && v != "0" && !v.eq_ignore_ascii_case("false")
        })
        .unwrap_or(false);
    WorkflowAvailability {
        disabled_in_settings,
        disabled_in_env,
        settings_source,
        env_unreadable: true,
    }
}

/// Every `permissions.allow` rule in effect, unioned across the same files.
/// "Already allowed" in the launch modal means EFFECTIVE, so a rule the user
/// put in `settings.local.json` counts even though Redline writes new ones to
/// `settings.json`.
pub fn effective_allow_rules(files: &[PathBuf]) -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    for f in files {
        let Some(json) = read_json(f) else { continue };
        let Some(arr) = json
            .pointer("/permissions/allow")
            .and_then(|v| v.as_array())
        else {
            continue;
        };
        for v in arr {
            if let Some(rule) = v.as_str() {
                out.insert(rule.to_string());
            }
        }
    }
    out
}

/// Write the Orchestrate launch modal's checked Bash allow rules into
/// `permissions.allow` (the `ensure_allow` seam the hook install already
/// uses). Workflow subagents inherit the user's allowlist but run in
/// acceptEdits — an unallowlisted `cargo test` would queue a permission
/// prompt per agent while the reviewer is on another surface. Only plain
/// `Bash(...)` rules are accepted; anything else is rejected rather than
/// written into the user's settings.
pub fn apply_orchestrate_allows(rules: &[String]) -> Result<(), String> {
    apply_orchestrate_allows_at(&settings_path(), rules)
}

pub fn apply_orchestrate_allows_at(
    path: &std::path::Path,
    rules: &[String],
) -> Result<(), String> {
    for rule in rules {
        let ok = rule.starts_with("Bash(")
            && rule.ends_with(")")
            && !rule.contains('\n')
            && rule.len() < 200;
        if !ok {
            return Err(format!("refusing to write allow rule `{rule}`"));
        }
    }
    if rules.is_empty() {
        return Ok(());
    }
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
    let obj = root
        .as_object_mut()
        .ok_or_else(|| "settings.json root is not a JSON object".to_string())?;
    for rule in rules {
        ensure_allow(obj, rule)?;
    }
    let serialized = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    fs::write(path, format!("{}\n", serialized)).map_err(|e| e.to_string())
}

/// One offered rule, and whether offering it changes anything.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AllowCandidate {
    pub rule: String,
    /// Already effective in some `permissions.allow` — the modal marks it and
    /// stops asking. Pre-checking rules the user already has is what made the
    /// step read as ceremony: every box ticked, no signal about which ones
    /// actually do something.
    pub present: bool,
}

/// Infer the build/test Bash allow rules the Orchestrate launch modal offers,
/// from repo markers — pure filesystem sniffing, nothing executes. The rule
/// strings live here (next to `apply_orchestrate_allows`' validation) so the
/// frontend never invents permission syntax.
///
/// Cargo and npm were the only two inferences, so a Go, Make or pytest repo
/// opened an empty modal — a preflight step that asked nothing and told
/// nothing.
pub fn orchestrate_allow_rules(project_dir: &std::path::Path) -> Vec<String> {
    let mut out = Vec::new();
    let has = |rel: &str| project_dir.join(rel).exists();
    if has("Cargo.toml") || has("src-tauri/Cargo.toml") {
        out.push("Bash(cargo build:*)".to_string());
        out.push("Bash(cargo test:*)".to_string());
    }
    if has("package.json") {
        out.push("Bash(npm test:*)".to_string());
        out.push("Bash(npm run build:*)".to_string());
    }
    if has("go.mod") {
        out.push("Bash(go build:*)".to_string());
        out.push("Bash(go test:*)".to_string());
    }
    // pytest is the runner; a bare `pyproject.toml` is the weakest of these
    // markers but by far the most common way a Python repo declares itself.
    if has("pytest.ini") || has("tox.ini") || has("conftest.py") || has("setup.cfg")
        || has("pyproject.toml")
    {
        out.push("Bash(pytest:*)".to_string());
    }
    // Last: `make` usually wraps the tools above, so it reads as the
    // catch-all rather than the headline.
    if has("Makefile") || has("makefile") || has("GNUmakefile") {
        out.push("Bash(make:*)".to_string());
    }
    out
}

pub fn orchestrate_allow_candidates(project_dir: &std::path::Path) -> Vec<AllowCandidate> {
    let effective = effective_allow_rules(&workflow_settings_files(Some(project_dir)));
    orchestrate_allow_rules(project_dir)
        .into_iter()
        .map(|rule| AllowCandidate {
            present: effective.contains(&rule),
            rule,
        })
        .collect()
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
    for rule in RESTORE_CURL_ALLOWS {
        ensure_allow(obj, rule)?;
    }

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
        allow_arr.retain(|v| !v.as_str().is_some_and(|s| RESTORE_CURL_ALLOWS.contains(&s)));
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

// ===========================================================================
// UserPromptSubmit capture hook (Polis prompt store, Phase 1)
// ===========================================================================
//
// A separate, command-type hook installed beside the ExitPlanMode HTTP hook.
// It captures every interactive prompt — PTY plan sessions AND external claude
// sessions (the global settings.json is read by every session) — by POSTing the
// hook's stdin payload to the daemon's ingest route. Command type (not http) is
// deliberate: `--max-time 1` + `exit 0` guarantees prompt submission is never
// delayed or blocked by Redline being closed or slow (fail-open).

/// The daemon route the capture hook POSTs to. Also the substring by which we
/// recognize *our* UserPromptSubmit entry when reading settings.json.
const CAPTURE_INGEST_URL: &str = "http://127.0.0.1:7676/v1/prompts/ingest";

/// The header the capture POST carries its spawning Agent Seat in, empty for a
/// human's own session. Command-type hooks run inside the spawned `claude`'s
/// environment, so the shell expands `REDLINE_AGENT_SEAT`
/// (`claude_proc::ENV_AGENT_SEAT`) at fire time — which is how the ingest route
/// tells Redline's own constructed prompts from the user's typing without having
/// to predict a byte-exact body.
pub const CAPTURE_AGENT_HEADER: &str = "X-Redline-Agent";

/// Redline's capture-hook spec — the installer itself is
/// `polis_server::hook::CaptureHookSpec` (Session A6 of the Polis extraction);
/// this names what Redline's rendering of it carries, and the command it
/// renders is pinned byte-for-byte by `capture_command_is_pinned` below.
///
/// The headers use `"…"` (not `'…'`) deliberately: the shell must expand the
/// variables. `${VAR:-}` keeps each header present-but-empty for a session
/// Redline did not spawn, so the route reads one shape either way. Note the
/// agent value is a *label*, not an authorization — the route treats a non-empty
/// value as "skip this, it's machine text", which is fail-safe: forging it can
/// only cause a prompt to be dropped from your own lake, never to be read. The
/// three restore variables (`restore_context::ENV_*`) ride the resumed
/// `claude`'s environment on a "Restore plan session", and are how the route
/// recognises the compact restore trigger.
///
/// Stdout is the reason the command is no longer a fire-and-forget `>/dev/null`.
/// UserPromptSubmit reads a command hook's stdout as context for the model, so
/// the route can answer the restore trigger with the full protocol as
/// `hookSpecificOutput.additionalContext` — the model gets it, the conversation
/// never shows it. Everything else the route returns is a receipt (`{"seq":…}`)
/// and must stay invisible, hence the spec's `case` guard rather than an
/// unconditional echo. A timeout, a closed Redline or a partial read all fall
/// through it silently, so prompt submission is still never blocked or altered
/// by Redline.
fn capture_spec() -> CaptureHookSpec {
    use crate::restore_context as rc;
    CaptureHookSpec::new(CAPTURE_INGEST_URL)
        .with_header(CAPTURE_AGENT_HEADER, crate::claude_proc::ENV_AGENT_SEAT)
        .with_header("X-Redline-Plan-Launch-Id", "REDLINE_PLAN_LAUNCH_ID")
        .with_header(rc::HEADER_TARGET, rc::ENV_TARGET)
        .with_header(rc::HEADER_PRIMED, rc::ENV_PRIMED)
        .with_header(rc::HEADER_RESCINDED, rc::ENV_RESCINDED)
}

/// The command-type hook body Redline writes (see `capture_spec`) — read by
/// the tests only; production renders it through the spec's own methods.
#[cfg(test)]
fn capture_command() -> String {
    capture_spec().command()
}

/// Is the installed capture hook the command we would write *today*?
///
/// `capture_installed_at` only answers "is some hook of ours there", which was
/// enough while the command was a fire-and-forget POST — an old one still
/// captured. It is not enough now: an install predating the restore headers
/// captures prompts perfectly and silently never delivers the restore protocol,
/// which is exactly the kind of failure that looks like the feature was never
/// built. Compared byte-for-byte on purpose; `install_capture_at` already
/// rewrites in place, so a mismatch just means "run it".
pub fn capture_current() -> bool {
    capture_current_at(&settings_path())
}

pub fn capture_current_at(path: &std::path::Path) -> bool {
    capture_spec().current_at(path)
}

pub fn capture_installed() -> bool {
    capture_installed_at(&settings_path())
}

pub fn capture_installed_at(path: &std::path::Path) -> bool {
    capture_spec().installed_at(path)
}

pub fn install_capture() -> Result<bool, String> {
    install_capture_at(&settings_path())
}

/// Install (or refresh) the UserPromptSubmit capture hook. Idempotent: if ours
/// is already present, its command is rewritten to the current form (so a stale
/// command from an older build self-heals); otherwise a new entry is appended.
/// Preserves any other UserPromptSubmit hooks the user configured.
pub fn install_capture_at(path: &std::path::Path) -> Result<bool, String> {
    capture_spec().install_at(path)
}

pub fn uninstall_capture() -> Result<bool, String> {
    uninstall_capture_at(&settings_path())
}

/// Remove only Redline's UserPromptSubmit capture entry, dropping empty
/// containers so the file doesn't accumulate stubs (mirrors the ExitPlanMode
/// uninstall cleanup). Returns whether the hook is still installed afterward.
pub fn uninstall_capture_at(path: &std::path::Path) -> Result<bool, String> {
    capture_spec().uninstall_at(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmppath() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("redline-hook-{}.json", uuid::Uuid::new_v4()))
    }

    /// The command Redline writes into `~/.claude/settings.json`, byte for
    /// byte. Pinned BEFORE the capture half moved onto
    /// `polis_server::hook::CaptureHookSpec` (Session A6), so the move is
    /// provably a no-op for every settings file already on disk: a changed
    /// byte here would make `capture_current` report every install stale and
    /// rewrite it on the next boot.
    #[test]
    fn capture_command_is_pinned() {
        assert_eq!(
            capture_command(),
            "resp=$(curl -s --max-time 1 -X POST -H 'Content-Type: application/json' \
             -H \"X-Redline-Agent: ${REDLINE_AGENT_SEAT:-}\" \
             -H \"X-Redline-Plan-Launch-Id: ${REDLINE_PLAN_LAUNCH_ID:-}\" \
             -H \"X-Redline-Restore: ${REDLINE_RESTORE_TARGET:-}\" \
             -H \"X-Redline-Restore-Primed: ${REDLINE_RESTORE_PRIMED:-}\" \
             -H \"X-Redline-Restore-Rescinded: ${REDLINE_RESTORE_RESCINDED:-}\" \
             --data-binary @- http://127.0.0.1:7676/v1/prompts/ingest 2>/dev/null); \
             case \"$resp\" in *hookSpecificOutput*) printf '%s' \"$resp\";; esac; exit 0"
        );
    }

    #[test]
    fn capture_install_uninstall_round_trip() {
        let path = tmppath();
        assert!(!capture_installed_at(&path));
        assert!(install_capture_at(&path).unwrap());
        assert!(capture_installed_at(&path));

        // The command targets the ingest route and fails open.
        let json: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let cmd = json["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();
        assert!(cmd.contains(CAPTURE_INGEST_URL));
        assert!(cmd.contains("--max-time 1"));
        assert!(cmd.contains("exit 0"));
        assert_eq!(
            json["hooks"]["UserPromptSubmit"][0]["hooks"][0]["type"],
            "command"
        );

        assert!(!uninstall_capture_at(&path).unwrap());
        let json: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(json.get("hooks").is_none(), "empty containers dropped");
        let _ = std::fs::remove_file(&path);
    }

    /// The capture POST must label itself with the spawning Agent Seat, and it
    /// must do so through a SHELL expansion — the hook runs inside the spawned
    /// `claude`'s own environment, which is the whole reason this mechanism
    /// reaches prompts the hash guard cannot predict. Single quotes would ship
    /// the literal `${REDLINE_AGENT_SEAT:-}` to the daemon and mark every
    /// human's prompt as machine text, so the quoting is the test.
    #[test]
    fn capture_hook_command_forwards_the_agent_header() {
        let cmd = capture_command();
        assert!(
            cmd.contains(&format!("-H \"{CAPTURE_AGENT_HEADER}: $")),
            "the header must be double-quoted so the shell expands it: {cmd}"
        );
        assert!(
            cmd.contains("${REDLINE_AGENT_SEAT:-}"),
            "and default to empty for a session Redline did not spawn: {cmd}"
        );
        assert!(
            !cmd.contains(&format!("'{CAPTURE_AGENT_HEADER}")),
            "single quotes would send the literal variable name: {cmd}"
        );
        // Still fail-open, still the same route.
        assert!(cmd.contains(CAPTURE_INGEST_URL) && cmd.contains("exit 0"));
    }

    /// The restore metadata rides the same shell-expansion mechanism as the
    /// seat, for the same reason: the hook runs inside the resumed `claude`'s
    /// environment, and single quotes would ship the literal variable names.
    #[test]
    fn capture_hook_command_forwards_the_restore_metadata() {
        use crate::restore_context as rc;
        let cmd = capture_command();
        for (header, env) in [
            (rc::HEADER_TARGET, rc::ENV_TARGET),
            (rc::HEADER_PRIMED, rc::ENV_PRIMED),
            (rc::HEADER_RESCINDED, rc::ENV_RESCINDED),
        ] {
            assert!(
                cmd.contains(&format!("-H \"{header}: ${{{env}:-}}\"")),
                "{header} must be double-quoted and default to empty: {cmd}"
            );
        }
    }

    /// UserPromptSubmit reads a command hook's stdout as context for the model.
    /// That is how the restore protocol reaches the model without becoming a
    /// message — and exactly why the ordinary receipt must NOT be echoed: an
    /// unconditional print would inject `{"seq":1234}` into every prompt the
    /// user ever submits.
    #[test]
    fn capture_hook_command_echoes_only_a_hook_output_response() {
        let cmd = capture_command();
        assert!(
            cmd.contains("case \"$resp\" in *hookSpecificOutput*)"),
            "only a response carrying hook output may be printed: {cmd}"
        );
        assert!(
            cmd.contains("printf '%s' \"$resp\""),
            "and printed verbatim when it is there: {cmd}"
        );
        assert!(
            !cmd.contains(">/dev/null 2>&1"),
            "the response has to be readable to be conditional on: {cmd}"
        );
        // Still fail-open: a dead daemon leaves $resp empty and prints nothing.
        assert!(cmd.contains("--max-time 1") && cmd.trim_end().ends_with("exit 0"));
    }

    /// "Some capture hook is installed" is not the same question as "the one we
    /// would write today", and only the second one can notice an install that
    /// predates the restore headers.
    #[test]
    fn capture_current_distinguishes_a_stale_install_from_a_fresh_one() {
        let path = tmppath();
        assert!(!capture_current_at(&path), "nothing installed");

        let stale = format!(
            "curl -s --max-time 1 -X POST --data-binary @- {CAPTURE_INGEST_URL} >/dev/null 2>&1; exit 0"
        );
        std::fs::write(
            &path,
            serde_json::to_string_pretty(&json!({
                "hooks": { "UserPromptSubmit": [
                    { "hooks": [{ "type": "command", "command": stale, "timeout": 5 }] }
                ]}
            }))
            .unwrap(),
        )
        .unwrap();
        assert!(
            capture_installed_at(&path),
            "the old check is satisfied by a stale command"
        );
        assert!(!capture_current_at(&path), "the new one is not");

        install_capture_at(&path).unwrap();
        assert!(capture_current_at(&path), "refreshed → current");
        let _ = std::fs::remove_file(&path);
    }

    /// The refresh rewrites OUR entry and nothing else — a user's own
    /// UserPromptSubmit hook survives it untouched.
    #[test]
    fn capture_refresh_preserves_unrelated_user_hooks() {
        let path = tmppath();
        let stale = format!(
            "curl -s --max-time 1 -X POST --data-binary @- {CAPTURE_INGEST_URL} >/dev/null 2>&1; exit 0"
        );
        std::fs::write(
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

        install_capture_at(&path).unwrap();
        let json: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let arr = json["hooks"]["UserPromptSubmit"].as_array().unwrap();
        assert_eq!(arr.len(), 2, "refreshed in place, nothing appended");
        assert_eq!(arr[0]["hooks"][0]["command"], "my-own-logger");
        assert_eq!(arr[0]["matcher"], "*", "the user's matcher is theirs");
        assert_eq!(arr[1]["hooks"][0]["command"].as_str().unwrap(), capture_command());
        let _ = std::fs::remove_file(&path);
    }

    /// A stale command from an older build must self-heal on the next boot —
    /// which is how the header reaches settings.json files installed before it
    /// existed, with no migration and no user action.
    #[test]
    fn capture_install_rewrites_a_stale_command_in_place() {
        let path = tmppath();
        let stale = format!(
            "curl -s --max-time 1 -X POST --data-binary @- {CAPTURE_INGEST_URL} >/dev/null 2>&1; exit 0"
        );
        std::fs::write(
            &path,
            serde_json::to_string_pretty(&json!({
                "hooks": { "UserPromptSubmit": [
                    { "hooks": [{ "type": "command", "command": stale, "timeout": 5 }] }
                ]}
            }))
            .unwrap(),
        )
        .unwrap();

        assert!(install_capture_at(&path).unwrap());
        let json: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let ups = json["hooks"]["UserPromptSubmit"].as_array().unwrap();
        assert_eq!(ups.len(), 1, "rewritten in place, not appended beside");
        let cmd = ups[0]["hooks"][0]["command"].as_str().unwrap();
        assert!(cmd.contains(CAPTURE_AGENT_HEADER), "stale command self-healed");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn capture_install_is_idempotent_and_coexists_with_planmode_hook() {
        let path = tmppath();
        // Install the ExitPlanMode HTTP hook first, then the capture hook.
        install_at(&path).unwrap();
        install_capture_at(&path).unwrap();
        install_capture_at(&path).unwrap(); // twice → no duplicate

        let json: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        // Both hooks present and independent.
        assert_eq!(json["hooks"]["PreToolUse"][0]["matcher"], "ExitPlanMode");
        let ups = json["hooks"]["UserPromptSubmit"].as_array().unwrap();
        assert_eq!(ups.len(), 1, "capture entry present exactly once");

        // Uninstalling capture leaves the ExitPlanMode hook untouched.
        uninstall_capture_at(&path).unwrap();
        assert!(get_status_at(&path).installed);
        assert!(!capture_installed_at(&path));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn capture_uninstall_preserves_foreign_userpromptsubmit_hook() {
        let path = tmppath();
        let existing = json!({
            "hooks": { "UserPromptSubmit": [
                { "hooks": [ { "type": "command", "command": "echo other" } ] }
            ] }
        });
        std::fs::write(&path, serde_json::to_string_pretty(&existing).unwrap()).unwrap();
        install_capture_at(&path).unwrap();
        uninstall_capture_at(&path).unwrap();

        let json: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let arr = json["hooks"]["UserPromptSubmit"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["hooks"][0]["command"], "echo other");
        let _ = std::fs::remove_file(&path);
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

    #[test]
    fn orchestrate_allows_write_and_dedupe() {
        let path = tmppath();
        let rules = vec![
            "Bash(cargo build:*)".to_string(),
            "Bash(cargo test:*)".to_string(),
        ];
        apply_orchestrate_allows_at(&path, &rules).unwrap();
        // Idempotent: a second apply doesn't duplicate.
        apply_orchestrate_allows_at(&path, &rules).unwrap();
        let json: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let allows = allow_entries(&json);
        assert_eq!(
            allows.iter().filter(|r| *r == "Bash(cargo test:*)").count(),
            1
        );
        assert!(allows.contains(&"Bash(cargo build:*)".to_string()));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn orchestrate_allows_reject_non_bash_rules() {
        let path = tmppath();
        for bad in [
            "WebFetch(*)",
            "Bash(cargo test:*) extra",
            "Bash(a\nb)",
        ] {
            assert!(
                apply_orchestrate_allows_at(&path, &[bad.to_string()]).is_err(),
                "rule `{bad}` should be refused"
            );
        }
        assert!(!path.exists(), "a refused batch must write nothing");
    }

    #[test]
    fn workflow_availability_reads_disable_flag() {
        let path = tmppath();
        // Absent file → not disabled.
        assert!(!workflow_availability_for(&[path.clone()]).disabled_in_settings);
        std::fs::write(
            &path,
            serde_json::to_string_pretty(&json!({"disableWorkflows": true})).unwrap(),
        )
        .unwrap();
        assert!(workflow_availability_for(&[path.clone()]).disabled_in_settings);
        std::fs::write(
            &path,
            serde_json::to_string_pretty(&json!({"disableWorkflows": false})).unwrap(),
        )
        .unwrap();
        assert!(!workflow_availability_for(&[path.clone()]).disabled_in_settings);
        let _ = std::fs::remove_file(&path);
    }

    /// The probe read exactly one file — `~/.claude/settings.json` — so a
    /// flag in `settings.local.json` or the project's own `.claude/` was
    /// invisible and the modal reported "available" with confidence it had
    /// not earned. Precedence is ascending: the later file wins, and a file
    /// that doesn't mention the key overrides nothing.
    #[test]
    fn workflow_availability_walks_settings_files_in_precedence_order() {
        let dir = std::env::temp_dir().join(format!("redline-wf-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let user = dir.join("settings.json");
        let local = dir.join("settings.local.json");
        let project = dir.join("project.json");
        let files = vec![user.clone(), local.clone(), project.clone()];

        // Nothing on disk at all → not disabled, and no source to blame.
        let a = workflow_availability_for(&files);
        assert!(!a.disabled_in_settings);
        assert!(a.settings_source.is_none());
        // The env is ALWAYS unreadable — the run happens in `$SHELL -l`.
        assert!(a.env_unreadable);

        // The local file alone disables it, and names itself.
        std::fs::write(&local, r#"{"disableWorkflows": true}"#).unwrap();
        let a = workflow_availability_for(&files);
        assert!(a.disabled_in_settings);
        assert_eq!(a.settings_source.as_deref(), Some(local.to_string_lossy().as_ref()));

        // A silent higher-precedence file does not override a stated one.
        std::fs::write(&project, r#"{"model": "opus"}"#).unwrap();
        assert!(workflow_availability_for(&files).disabled_in_settings);

        // A stated higher-precedence file does.
        std::fs::write(&project, r#"{"disableWorkflows": false}"#).unwrap();
        let a = workflow_availability_for(&files);
        assert!(!a.disabled_in_settings);
        assert!(a.settings_source.is_none());

        // A lower-precedence file cannot re-enable it.
        std::fs::write(&user, r#"{"disableWorkflows": true}"#).unwrap();
        assert!(!workflow_availability_for(&files).disabled_in_settings);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn workflow_settings_files_are_ordered_user_then_project_then_managed() {
        let files = workflow_settings_files(Some(std::path::Path::new("/tmp/repo")));
        let names: Vec<String> = files.iter().map(|f| f.display().to_string()).collect();
        let project_idx = names
            .iter()
            .position(|n| n.starts_with("/tmp/repo/.claude/settings.json"))
            .expect("project settings.json is read");
        let local_idx = names
            .iter()
            .position(|n| n.ends_with("/tmp/repo/.claude/settings.local.json"))
            .expect("project settings.local.json is read");
        assert!(project_idx < local_idx, "local overrides shared");
        // Managed settings outrank everything a user can write.
        assert_eq!(local_idx, names.len() - 2);
    }

    /// Cargo and npm were the only inferences, so a Go, Make or pytest repo
    /// opened a modal with an empty list — a step that asked nothing.
    #[test]
    fn orchestrate_allow_rules_cover_more_than_cargo_and_npm() {
        let dir = std::env::temp_dir().join(format!("redline-cand-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(orchestrate_allow_rules(&dir).is_empty());

        std::fs::write(dir.join("go.mod"), "module x
").unwrap();
        std::fs::write(dir.join("Makefile"), "all:
").unwrap();
        std::fs::write(dir.join("pyproject.toml"), "[project]
").unwrap();
        let rules = orchestrate_allow_rules(&dir);
        for want in ["Bash(go test:*)", "Bash(go build:*)", "Bash(make:*)", "Bash(pytest:*)"] {
            assert!(rules.iter().any(|r| r == want), "missing {want} in {rules:?}");
        }
        // Every rule it offers must survive the writer's own validation.
        assert!(apply_orchestrate_allows_at(&dir.join("settings.json"), &rules).is_ok());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn effective_allow_rules_union_across_files_marks_candidates_present() {
        let dir = std::env::temp_dir().join(format!("redline-eff-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.json");
        let b = dir.join("b.json");
        std::fs::write(&a, r#"{"permissions": {"allow": ["Bash(cargo test:*)"]}}"#).unwrap();
        std::fs::write(&b, r#"{"permissions": {"allow": ["Bash(make:*)"]}}"#).unwrap();
        let eff = effective_allow_rules(&[a, b, dir.join("missing.json")]);
        assert!(eff.contains("Bash(cargo test:*)"));
        assert!(eff.contains("Bash(make:*)"));
        assert_eq!(eff.len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }
}


/// Per-child settings ensure the claim veto exists even when the global plan
/// hook was installed by an older build. A dead bridge fails closed for writes.
pub fn runner_settings() -> Value {
    json!({"hooks":{"PreToolUse":[{"matcher":"Edit|Write|NotebookEdit","hooks":[{
        "type":"command", "timeout":20,
        "command":r#"if [ -n "$REDLINE_RUN_ID" ] && [ -n "$REDLINE_RUN_NODE" ] && [ -n "$REDLINE_RUN_ATTEMPT" ]; then curl --fail --silent --show-error --max-time 15 -X POST -H 'Content-Type: application/json' -H "x-redline-run-id: $REDLINE_RUN_ID" -H "x-redline-run-node: $REDLINE_RUN_NODE" -H "x-redline-run-attempt: $REDLINE_RUN_ATTEMPT" --data-binary @- "${REDLINE_RUN_CLAIM_URL:-http://127.0.0.1:7676/v1/runs/claim}" || { printf '%s\n' 'Redline write ownership service is unavailable; retry after it returns.' >&2; exit 2; }; else printf '%s\n' 'Redline write ownership requires an active run attempt.' >&2; exit 2; fi"#
    }]}]}})
}
